"""Shared environment-file loader for the HOPE Python services.

This is the ONE Python implementation of the monorepo's env-file contract. It
replaces the four near-identical ``_load_dotenv_into_environ()`` copies that
used to live in ``apps/{text,harness,guardrail,tts}/…/core/config.py`` and the
bare ``dotenv.load_dotenv()`` calls in ``apps/nlp``.

Those copies read the monorepo-root ``.env`` and NEVER ``.env.dev`` — so
editing ``.env.dev`` reconfigured the TypeScript gateway and had zero effect on
the Python half of the platform. That split brain is what this module ends.

Contract (identical to the TypeScript ``loadEnv()`` in
``packages/applications/src/common/env/index.ts``)::

    host env  >  <monorepo-root>/.env.<environment>  >  schema default

* ``NODE_ENV`` selects the file: ``development`` → ``.env.dev``, ``test`` →
  ``.env.test``, ``staging`` → ``.env.staging``. Unset or unrecognised means
  ``development``. ``NODE_ENV`` — not a Python-specific alias — is deliberate:
  one variable must decide which file BOTH runtimes read, or the split brain
  simply reappears under a new name.
* No file is read when ``CI`` is truthy or ``NODE_ENV=production``: deployed
  and CI processes are configured by host environment only.
* Values already present in ``os.environ`` are never overwritten, including
  when they are the empty string — an explicit empty export is a deliberate
  override, not "unset".
* The monorepo root is found by walking up for the ``package.json`` whose
  ``name`` is ``hope-monorepo`` — the same anchor the TypeScript loader uses.
  Never a fixed number of ``parents[n]`` hops, so the loader keeps working from
  a git worktree, an editable install, or a Docker image (where no root is
  found, nothing is loaded, and host env is the whole story).

Usage — call it once, immediately before building settings::

    from hope_env import load_env

    def get_settings() -> Settings:
        load_env()
        return Settings()
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values

from hope_env._provenance import record_injection
from hope_env.build_info import (
    DEFAULT_BUILD_INFO_PATH,
    BuildInfo,
    BuildInfoReader,
    format_untagged_version,
)
from hope_env.placeholders import (
    PLACEHOLDER_SENTINEL,
    first_real_secret,
    is_placeholder,
    real_secret,
)
from hope_env.service_registration import (
    DEFAULT_HEARTBEAT_INTERVAL_S,
    DEFAULT_REGISTER_TIMEOUT_S,
    build_payload,
    instance_id,
    normalize_environment,
    start_registration,
    stop_registration,
)
from hope_env.settings_sources import (
    DEFAULT_SECRETS_DIR,
    SECRETS_DIR_ENV_VAR,
    build_hope_sources,
    hope_settings_sources,
    register_settings_cache,
    reload_secrets,
    resolve_secrets_dir,
)

__all__ = [
    "DEFAULT_BUILD_INFO_PATH",
    "PLACEHOLDER_SENTINEL",
    "DEFAULT_HEARTBEAT_INTERVAL_S",
    "DEFAULT_REGISTER_TIMEOUT_S",
    "DEFAULT_SECRETS_DIR",
    "ENV_FILE_BY_NODE_ENV",
    "SECRETS_DIR_ENV_VAR",
    "BuildInfo",
    "BuildInfoReader",
    "LoadEnvResult",
    "build_hope_sources",
    "build_payload",
    "find_monorepo_root",
    "format_untagged_version",
    "hope_settings_sources",
    "instance_id",
    "first_real_secret",
    "is_placeholder",
    "real_secret",
    "load_env",
    "normalize_environment",
    "register_settings_cache",
    "reload_secrets",
    "resolve_secrets_dir",
    "start_registration",
    "stop_registration",
]

#: ``NODE_ENV`` → env-file name. Mirrors ``ENV_FILE_MAP`` in the TS loader.
ENV_FILE_BY_NODE_ENV: dict[str, str] = {
    "development": ".env.dev",
    "test": ".env.test",
    "production": ".env.production",
    "staging": ".env.staging",
}

_DEFAULT_NODE_ENV = "development"
_ROOT_PACKAGE_NAME = "hope-monorepo"
_TRUTHY = frozenset({"true", "1"})


@dataclass(frozen=True)
class LoadEnvResult:
    """Outcome of a :func:`load_env` call (informational; callers may ignore)."""

    loaded: bool
    node_env: str
    is_ci: bool
    env_file: Path | None = None
    reason: str | None = None


def _is_ci() -> bool:
    return os.environ.get("CI", "").strip().lower() in _TRUTHY


def _node_env() -> str:
    value = os.environ.get("NODE_ENV", "").strip()
    return value if value in ENV_FILE_BY_NODE_ENV else _DEFAULT_NODE_ENV


def find_monorepo_root(start_dir: Path | None = None) -> Path | None:
    """Walk up from ``start_dir`` to the directory holding the root manifest.

    Returns ``None`` when no ``package.json`` naming ``hope-monorepo`` is found
    on the way to the filesystem root — the normal case inside a container.
    """
    current = (start_dir or Path.cwd()).resolve()
    for directory in (current, *current.parents):
        manifest = directory / "package.json"
        if not manifest.is_file():
            continue
        try:
            name = json.loads(manifest.read_text(encoding="utf-8")).get("name")
        except (OSError, ValueError):
            continue
        if name == _ROOT_PACKAGE_NAME:
            return directory
    return None


def _resolve_root(start_dir: Path | None) -> Path | None:
    """Locate the monorepo root.

    An explicit ``start_dir`` is authoritative — it is the search origin and
    nothing else is tried, so a caller (or a test) can point the loader at a
    directory that has no monorepo above it and get "not found".

    By default the search starts at the cwd and then falls back to this file's
    own location, which covers processes launched from outside the repo (an
    editor's test runner, a cron entry) while the package is installed editable
    from inside it.
    """
    if start_dir is not None:
        return find_monorepo_root(start_dir)
    for candidate in (Path.cwd(), Path(__file__).parent):
        root = find_monorepo_root(candidate)
        if root is not None:
            return root
    return None


def load_env(*, start_dir: Path | None = None) -> LoadEnvResult:
    """Load the environment file for the current ``NODE_ENV`` into ``os.environ``.

    Safe to call repeatedly: because host values are never overwritten, the
    first call wins and later calls are no-ops.

    :param start_dir: where to begin the monorepo-root search (default: cwd).
    """
    node_env = _node_env()
    is_ci = _is_ci()

    if is_ci or node_env == "production":
        return LoadEnvResult(
            loaded=False,
            node_env=node_env,
            is_ci=is_ci,
            reason=f"host env only (CI={is_ci}, NODE_ENV={node_env})",
        )

    root = _resolve_root(start_dir)
    if root is None:
        return LoadEnvResult(
            loaded=False,
            node_env=node_env,
            is_ci=is_ci,
            reason="monorepo root not found",
        )

    env_file = root / ENV_FILE_BY_NODE_ENV[node_env]
    if not env_file.is_file() and node_env == _DEFAULT_NODE_ENV:
        # Parity with the TS loader's development-only fallback. Retired with
        # the `.env` file itself.
        legacy = root / ".env"
        if legacy.is_file():
            env_file = legacy

    if not env_file.is_file():
        return LoadEnvResult(
            loaded=False,
            node_env=node_env,
            is_ci=is_ci,
            reason=f"not found: {env_file}",
        )

    for key, value in dotenv_values(env_file, encoding="utf-8").items():
        if value is not None and key not in os.environ:
            os.environ[key] = value
            # Remember the provenance: pydantic must be able to rank this BELOW a
            # Vault-rendered secret file while a real host export still wins, and
            # once merged into os.environ the two are otherwise indistinguishable.
            record_injection(key, value)

    return LoadEnvResult(loaded=True, node_env=node_env, is_ci=is_ci, env_file=env_file)
