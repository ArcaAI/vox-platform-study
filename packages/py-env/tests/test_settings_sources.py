"""Contract tests for the HOPE pydantic-settings source ordering.

The five-tier precedence every HOPE Python service must implement::

    init > host env > secrets_dir (Vault Agent) >.env.<NODE_ENV> > field default

pydantic-settings' DEFAULT order is ``init > env > dotenv > file_secret`` — the
secret file LAST. That is the bug these tests pin: a Vault Agent re-renders
``/vault/secrets/JWT_SECRET_KEY`` in place, and a stale dotenv must not outrank
it.

The subtlety that makes a naive reorder useless here::func:`hope_env.load_env`
merges the dotenv INTO ``os.environ``, so by the time pydantic runs there is a
single ``EnvSettingsSource`` holding host env *and* dotenv values with nothing
to tell them apart. Splitting that source by provenance is the whole job.
"""

from __future__ import annotations

import json
import os
import warnings
from collections.abc import Iterator
from pathlib import Path

import pytest
from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from hope_env import (
    DEFAULT_SECRETS_DIR,
    SECRETS_DIR_ENV_VAR,
    _provenance,
    hope_settings_sources,
    load_env,
    register_settings_cache,
    reload_secrets,
    resolve_secrets_dir,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_MANAGED_KEYS = (
    "NODE_ENV",
    "CI",
    SECRETS_DIR_ENV_VAR,
    "PROBE_TOKEN",
    "PROBE_PLAIN",
    "SVC_PROBE_TOKEN",
)


@pytest.fixture(autouse=True)
def _clean_environ() -> Iterator[None]:
    """Snapshot/restore env + the loader's provenance record."""
    saved = {k: os.environ.get(k) for k in _MANAGED_KEYS}
    for key in _MANAGED_KEYS:
        os.environ.pop(key, None)
    _provenance.FILE_INJECTED.clear()
    yield
    _provenance.FILE_INJECTED.clear()
    for key, value in saved.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


@pytest.fixture
def fake_repo(tmp_path: Path) -> Path:
    (tmp_path / "package.json").write_text(json.dumps({"name": "hope-monorepo"}))
    return tmp_path


@pytest.fixture
def secrets_dir(tmp_path: Path) -> Path:
    path = tmp_path / "vault-secrets"
    path.mkdir()
    os.environ[SECRETS_DIR_ENV_VAR] = str(path)
    return path


class Probe(BaseSettings):
    """Unprefixed settings class using the shared source order."""

    settings_customise_sources = hope_settings_sources

    probe_token: SecretStr = SecretStr("field-default")
    probe_plain: str = "plain-default"


class PrefixedProbe(BaseSettings):
    """Prefixed class — proves the secret FILENAME is the full env var name."""

    model_config = SettingsConfigDict(env_prefix="SVC_")
    settings_customise_sources = hope_settings_sources

    probe_token: SecretStr = SecretStr("field-default")


def _dotenv(repo: Path, body: str) -> None:
    (repo / ".env.dev").write_text(body)


# ---------------------------------------------------------------------------
# The five tiers, one test per boundary
# ---------------------------------------------------------------------------


def test_field_default_when_nothing_supplies_a_value() -> None:
    assert Probe().probe_token.get_secret_value() == "field-default"


def test_dotenv_beats_field_default(fake_repo: Path) -> None:
    _dotenv(fake_repo, "PROBE_TOKEN=from-dotenv\n")
    load_env(start_dir=fake_repo)

    assert Probe().probe_token.get_secret_value() == "from-dotenv"


def test_secrets_dir_beats_dotenv(fake_repo: Path, secrets_dir: Path) -> None:
    """THE regression this lane exists for — a re-rendered Vault file must win."""
    _dotenv(fake_repo, "PROBE_TOKEN=from-dotenv\n")
    load_env(start_dir=fake_repo)
    (secrets_dir / "PROBE_TOKEN").write_text("from-vault")

    assert Probe().probe_token.get_secret_value() == "from-vault"


def test_default_pydantic_order_loses_to_the_dotenv(fake_repo: Path, secrets_dir: Path) -> None:
    """Control: pin the BUG, so reverting the fix fails here and not only above.

    Two classes, one fixture. ``Unordered`` takes pydantic's stock order and is
    beaten by the dotenv even though a Vault file exists; ``Probe`` (previous
    test) reads the Vault file. Documents WHY the customisation is load-bearing.
    """

    class Unordered(BaseSettings):
        probe_token: SecretStr = SecretStr("field-default")

    _dotenv(fake_repo, "PROBE_TOKEN=from-dotenv\n")
    load_env(start_dir=fake_repo)
    (secrets_dir / "PROBE_TOKEN").write_text("from-vault")

    # Stock order is `init > env > dotenv > file_secret`, and load_env() put the
    # dotenv value into os.environ, so the env source answers first.
    assert Unordered().probe_token.get_secret_value() == "from-dotenv"
    assert Probe().probe_token.get_secret_value() == "from-vault"


def test_host_env_beats_secrets_dir(secrets_dir: Path) -> None:
    os.environ["PROBE_TOKEN"] = "from-host"
    (secrets_dir / "PROBE_TOKEN").write_text("from-vault")

    assert Probe().probe_token.get_secret_value() == "from-host"


def test_init_beats_host_env(secrets_dir: Path) -> None:
    os.environ["PROBE_TOKEN"] = "from-host"
    (secrets_dir / "PROBE_TOKEN").write_text("from-vault")

    assert Probe(probe_token=SecretStr("from-init")).probe_token.get_secret_value() == "from-init"


def test_full_precedence_chain_in_one_object(fake_repo: Path, secrets_dir: Path) -> None:
    """All five tiers live at once, each on a different field."""
    _dotenv(fake_repo, "PROBE_PLAIN=from-dotenv\n")
    load_env(start_dir=fake_repo)
    (secrets_dir / "PROBE_TOKEN").write_text("from-vault")

    probe = Probe()
    assert probe.probe_token.get_secret_value() == "from-vault"
    assert probe.probe_plain == "from-dotenv"


# ---------------------------------------------------------------------------
# Local dev — an absent secrets_dir must be invisible
# ---------------------------------------------------------------------------


def test_absent_secrets_dir_is_a_silent_noop(fake_repo: Path, tmp_path: Path) -> None:
    """No warning, no exception — this is the every-developer path."""
    os.environ[SECRETS_DIR_ENV_VAR] = str(tmp_path / "does-not-exist")
    _dotenv(fake_repo, "PROBE_TOKEN=from-dotenv\n")
    load_env(start_dir=fake_repo)

    with warnings.catch_warnings():
        warnings.simplefilter("error")  # any warning becomes a test failure
        assert Probe().probe_token.get_secret_value() == "from-dotenv"


def test_default_secrets_dir_is_the_vault_agent_mount() -> None:
    assert DEFAULT_SECRETS_DIR == "/vault/secrets"


def test_resolve_secrets_dir_returns_none_when_missing(tmp_path: Path) -> None:
    os.environ[SECRETS_DIR_ENV_VAR] = str(tmp_path / "nope")
    assert resolve_secrets_dir() is None


def test_resolve_secrets_dir_returns_none_for_a_file(tmp_path: Path) -> None:
    """A path that is not a directory must not raise SettingsError at build time."""
    bogus = tmp_path / "a-file"
    bogus.write_text("x")
    os.environ[SECRETS_DIR_ENV_VAR] = str(bogus)
    assert resolve_secrets_dir() is None


def test_hope_secrets_dir_env_var_overrides_the_default(secrets_dir: Path) -> None:
    assert resolve_secrets_dir() == secrets_dir


# ---------------------------------------------------------------------------
# The cloud path — no dotenv, but secrets_dir still applies
# ---------------------------------------------------------------------------


def test_ci_reads_no_dotenv_but_still_reads_secrets_dir(fake_repo: Path, secrets_dir: Path) -> None:
    os.environ["CI"] = "true"
    _dotenv(fake_repo, "PROBE_TOKEN=from-dotenv\n")
    load_env(start_dir=fake_repo)
    (secrets_dir / "PROBE_TOKEN").write_text("from-vault")

    assert Probe().probe_token.get_secret_value() == "from-vault"


def test_production_reads_no_dotenv_but_still_reads_secrets_dir(
    fake_repo: Path, secrets_dir: Path
) -> None:
    """The deployed shape: no env file exists at all, Vault Agent supplies everything."""
    os.environ["NODE_ENV"] = "production"
    _dotenv(fake_repo, "PROBE_TOKEN=from-dotenv\n")
    load_env(start_dir=fake_repo)
    (secrets_dir / "PROBE_TOKEN").write_text("from-vault")

    assert Probe().probe_token.get_secret_value() == "from-vault"


def test_production_without_any_env_file_still_resolves_secrets(
    secrets_dir: Path,
) -> None:
    os.environ["NODE_ENV"] = "production"
    (secrets_dir / "PROBE_TOKEN").write_text("from-vault")

    assert Probe().probe_token.get_secret_value() == "from-vault"


# ---------------------------------------------------------------------------
# File contract (what lane K's k3s manifests must render)
# ---------------------------------------------------------------------------


def test_secret_filename_is_the_full_env_var_name_including_prefix(
    secrets_dir: Path,
) -> None:
    (secrets_dir / "SVC_PROBE_TOKEN").write_text("prefixed-vault")

    assert PrefixedProbe().probe_token.get_secret_value() == "prefixed-vault"


def test_unprefixed_filename_is_ignored_for_a_prefixed_class(secrets_dir: Path) -> None:
    (secrets_dir / "PROBE_TOKEN").write_text("wrong-name")

    assert PrefixedProbe().probe_token.get_secret_value() == "field-default"


def test_trailing_newline_from_the_agent_template_is_stripped(
    secrets_dir: Path,
) -> None:
    (secrets_dir / "PROBE_TOKEN").write_text("from-vault\n")

    assert Probe().probe_token.get_secret_value() == "from-vault"


# ---------------------------------------------------------------------------
# H3 — secrets never leak through repr()/dump
# ---------------------------------------------------------------------------


def test_secret_absent_from_repr_and_model_dump(secrets_dir: Path) -> None:
    (secrets_dir / "PROBE_TOKEN").write_text("super-sensitive")
    probe = Probe()

    assert "super-sensitive" not in repr(probe)
    assert "super-sensitive" not in str(probe.model_dump())
    assert "super-sensitive" not in probe.model_dump_json()
    assert probe.probe_token.get_secret_value() == "super-sensitive"


# ---------------------------------------------------------------------------
# H4 — rotation re-read
# ---------------------------------------------------------------------------


def test_rebuilding_settings_picks_up_a_rotated_secret(secrets_dir: Path) -> None:
    """The agent rewrites the file in place; an uncached get_settings() must see it."""
    (secrets_dir / "PROBE_TOKEN").write_text("v1")
    assert Probe().probe_token.get_secret_value() == "v1"

    (secrets_dir / "PROBE_TOKEN").write_text("v2")
    assert Probe().probe_token.get_secret_value() == "v2"


def test_reload_secrets_clears_registered_caches() -> None:
    calls: list[str] = []
    unregister = register_settings_cache(lambda: calls.append("cleared"))
    try:
        reload_secrets()
        assert calls == ["cleared"]
    finally:
        unregister()

    reload_secrets()
    assert calls == ["cleared"], "an unregistered cache must not be cleared again"


def test_reload_secrets_is_safe_with_no_registered_caches() -> None:
    reload_secrets()


# ---------------------------------------------------------------------------
# Provenance bookkeeping (the mechanism the split depends on)
# ---------------------------------------------------------------------------


def test_a_runtime_overwrite_of_a_dotenv_key_is_treated_as_host_env(
    fake_repo: Path, secrets_dir: Path
) -> None:
    """Someone assigning os.environ at runtime outranks the Vault file, like a host export."""
    _dotenv(fake_repo, "PROBE_TOKEN=from-dotenv\n")
    load_env(start_dir=fake_repo)
    os.environ["PROBE_TOKEN"] = "overwritten-at-runtime"
    (secrets_dir / "PROBE_TOKEN").write_text("from-vault")

    assert Probe().probe_token.get_secret_value() == "overwritten-at-runtime"


def test_host_env_key_never_recorded_as_file_injected(fake_repo: Path) -> None:
    os.environ["PROBE_TOKEN"] = "from-host"
    _dotenv(fake_repo, "PROBE_TOKEN=from-dotenv\n")
    load_env(start_dir=fake_repo)

    assert "PROBE_TOKEN" not in _provenance.FILE_INJECTED
