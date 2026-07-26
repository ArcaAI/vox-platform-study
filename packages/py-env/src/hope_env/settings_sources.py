"""The HOPE pydantic-settings source order — Vault files above the dotenv.

This is what lets a HOPE Python service run in the cloud with **no env file at
all**: a Vault Agent sidecar renders one file per secret into a memory-backed
volume, and pydantic reads that directory through its own
``SecretsSettingsSource``. No Vault SDK, no extra dependency, no in-process
authentication — the service stays Vault-unaware.

The order every HOPE settings class uses::

    init  >  host env  >  secrets_dir (Vault Agent)  >  .env.<NODE_ENV>  >  field default

pydantic-settings defaults to ``init > env > dotenv > file_secret`` — the secret
file LAST — which would let a stale dotenv outrank a freshly re-rendered Vault
file. Verified against the installed pydantic-settings 2.14.2.

Why a plain reorder of the four given sources is NOT enough here
---------------------------------------------------------------
:func:`hope_env.load_env` merges the dotenv into ``os.environ``, and five of the
six services pass no ``env_file`` at all — so ``dotenv_settings`` is empty and
the dotenv values arrive inside ``env_settings``. Moving ``file_secret_settings``
above ``dotenv_settings`` therefore moves it above *nothing*: the dotenv value
still wins from inside the env source. Demonstrated on the installed version::

    init > env > file_secret > dotenv   with PROBE_TOKEN in both  ->  'from-dotenv'

So the env source is SPLIT by provenance (see :mod:`hope_env._provenance`) into a
host-env source above the Vault tier and a file-derived source below it. The
split preserves everything about the original source — prefix, nesting delimiter,
case sensitivity, complex-value parsing — because the two halves are clones of
the instance pydantic built, differing only in which variables they can see.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeVar, cast

from pydantic_settings import (
    EnvSettingsSource,
    PydanticBaseSettingsSource,
    SecretsSettingsSource,
)

from hope_env._provenance import FILE_INJECTED, is_file_injected

if TYPE_CHECKING:  # pragma: no cover - typing only
    from pydantic_settings import BaseSettings

__all__ = [
    "DEFAULT_SECRETS_DIR",
    "SECRETS_DIR_ENV_VAR",
    "build_hope_sources",
    "hope_settings_sources",
    "register_settings_cache",
    "reload_secrets",
    "resolve_secrets_dir",
]

#: Where the Vault Agent renders its files. Overridable so a test, a container
#: with a different mount, or a developer experimenting locally can point
#: elsewhere without code changes.
SECRETS_DIR_ENV_VAR = "HOPE_SECRETS_DIR"

#: The Vault Agent injector's conventional mount path. Absent on every developer
#: machine — which must be a silent no-op, not an error.
DEFAULT_SECRETS_DIR = "/vault/secrets"

_SourceT = TypeVar("_SourceT", bound=PydanticBaseSettingsSource)


def resolve_secrets_dir() -> Path | None:
    """Return the secrets directory to read, or ``None`` when there is none.

    ``None`` covers BOTH "the path does not exist" (local dev — the common case)
    and "the path is not a directory". Returning ``None`` rather than handing the
    path to pydantic is deliberate: ``SecretsSettingsSource`` emits
    ``UserWarning: directory "/vault/secrets" does not exist`` for a missing path
    and raises ``SettingsError`` for a non-directory. Neither is acceptable on
    the path every developer takes on every settings construction.
    """
    raw = os.environ.get(SECRETS_DIR_ENV_VAR, "").strip() or DEFAULT_SECRETS_DIR
    path = Path(raw).expanduser()
    return path if path.is_dir() else None


def _clone(
    origin: PydanticBaseSettingsSource, cls: type[_SourceT], **overrides: Any
) -> _SourceT:
    """Copy a source instance under a new class, overriding chosen attributes.

    ``__init__`` is bypassed on purpose. The instance pydantic handed us already
    carries every RESOLVED setting — including per-call overrides such as
    ``Settings(_case_sensitive=...)`` that re-constructing from ``model_config``
    would silently drop.
    """
    clone = object.__new__(cls)
    clone.__dict__.update(origin.__dict__)
    for key, value in overrides.items():
        setattr(clone, key, value)
    return clone


class HostEnvSettingsSource(EnvSettingsSource):
    """``os.environ`` MINUS everything the env file supplied. Outranks Vault."""


class DotenvEnvSettingsSource(EnvSettingsSource):
    """Only the ``os.environ`` entries the env file supplied. Ranks below Vault."""


def _split_env_by_provenance(
    env_settings: PydanticBaseSettingsSource,
) -> tuple[PydanticBaseSettingsSource, PydanticBaseSettingsSource]:
    """Split the env source into (host-supplied, env-file-supplied) halves."""
    origin = cast(EnvSettingsSource, env_settings)
    env_vars: Mapping[str, str | None] = origin.env_vars
    case_sensitive = origin.case_sensitive

    # `env_vars` keys are normalised by pydantic (lower-cased unless the class is
    # case-sensitive), while the provenance record holds the original names.
    file_keys = {
        key if case_sensitive else key.lower()
        for key in tuple(FILE_INJECTED)
        if is_file_injected(key)
    }

    host: dict[str, str | None] = {}
    from_file: dict[str, str | None] = {}
    for key, value in env_vars.items():
        (from_file if key in file_keys else host)[key] = value

    return (
        _clone(origin, HostEnvSettingsSource, env_vars=host),
        _clone(origin, DotenvEnvSettingsSource, env_vars=from_file),
    )


def _secrets_source(
    file_secret_settings: PydanticBaseSettingsSource,
) -> PydanticBaseSettingsSource:
    """Point the secrets source at the Vault Agent mount when one is present.

    When no directory is present the source pydantic already built is returned
    untouched — it honours an explicit ``secrets_dir`` in a class's
    ``model_config`` and is an immediate no-op otherwise.
    """
    secrets_dir = resolve_secrets_dir()
    if secrets_dir is None:
        return file_secret_settings
    return _clone(file_secret_settings, SecretsSettingsSource, secrets_dir=secrets_dir)


def build_hope_sources(
    settings_cls: type[BaseSettings],
    *,
    init_settings: PydanticBaseSettingsSource,
    env_settings: PydanticBaseSettingsSource,
    dotenv_settings: PydanticBaseSettingsSource,
    file_secret_settings: PydanticBaseSettingsSource,
) -> tuple[PydanticBaseSettingsSource, ...]:
    """Build the HOPE source tuple, highest precedence first.

    Exposed as a plain function so a service that already customises its sources
    can COMPOSE with this order rather than replace it (``apps/nlp`` wraps the
    returned sources in its model-identity filter).

    ``settings_cls`` is unused — every source pydantic hands us already carries a
    reference to it. It stays in the signature so this function is a drop-in
    mirror of ``settings_customise_sources``, which is what makes composing at a
    call site mechanical rather than a re-ordering puzzle.
    """
    host_env, dotenv_env = _split_env_by_provenance(env_settings)
    return (
        init_settings,
        host_env,
        _secrets_source(file_secret_settings),
        dotenv_env,
        # A real `env_file=` overlay, if the class declares one (only `apps/stt`
        # does, for `apps/stt/.env`). It stays BELOW the root env file, which is
        # the precedence TASK-558 lane C established.
        dotenv_settings,
    )


def _hope_settings_sources(
    cls: type[BaseSettings],
    settings_cls: type[BaseSettings],
    # Positional-or-keyword to match `BaseSettings.settings_customise_sources`
    # exactly — pydantic passes these by keyword, but narrowing the override to
    # keyword-only breaks Liskov and mypy rejects the assignment.
    init_settings: PydanticBaseSettingsSource,
    env_settings: PydanticBaseSettingsSource,
    dotenv_settings: PydanticBaseSettingsSource,
    file_secret_settings: PydanticBaseSettingsSource,
) -> tuple[PydanticBaseSettingsSource, ...]:
    return build_hope_sources(
        settings_cls,
        init_settings=init_settings,
        env_settings=env_settings,
        dotenv_settings=dotenv_settings,
        file_secret_settings=file_secret_settings,
    )


#: Drop-in for ``settings_customise_sources`` — one line per settings class::
#:
#:     class Settings(BaseSettings):
#:         settings_customise_sources = hope_settings_sources
hope_settings_sources = classmethod(_hope_settings_sources)


# ---------------------------------------------------------------------------
# Rotation (§13.2 P6)
# ---------------------------------------------------------------------------

_CACHE_CLEARERS: list[Callable[[], None]] = []


def register_settings_cache(clear: Callable[[], None]) -> Callable[[], None]:
    """Register a settings cache so :func:`reload_secrets` can drop it.

    Only services that CACHE their settings need this (``apps/stt``'s
    ``@lru_cache`` accessor). The others rebuild on every ``get_settings()`` call
    and pick up a rotated file with no bookkeeping — a property worth keeping.

    :returns: a callable that unregisters again.
    """
    _CACHE_CLEARERS.append(clear)

    def unregister() -> None:
        try:
            _CACHE_CLEARERS.remove(clear)
        except ValueError:  # pragma: no cover - already gone
            pass

    return unregister


def reload_secrets() -> None:
    """Drop cached settings so the next read re-reads ``secrets_dir``.

    The Vault Agent rewrites its files IN PLACE, so a settings object built once
    at startup would serve the pre-rotation value for the life of the process.
    This is the explicit re-read path.

    Deliberately NOT wired to a background poller or a signal handler here —
    exposing the capability is this lane's scope; choosing the trigger (a SIGHUP
    from the agent's ``command``, an admin endpoint, or a bounded TTL) is a
    deployment decision that belongs with the k3s manifests.
    """
    for clear in tuple(_CACHE_CLEARERS):
        clear()
