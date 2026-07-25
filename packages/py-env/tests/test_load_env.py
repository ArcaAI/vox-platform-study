"""Contract tests for the shared HOPE Python env loader.

These assert the SAME contract the TypeScript `loadEnv()`
(`packages/applications/src/common/env/index.ts`) implements, so a key resolves
identically in both runtimes:

  host env  >  <root>/.env.<environment>  >  schema default

plus: no file loading in CI or production, and a deterministically located
monorepo root.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from pathlib import Path

import pytest

from hope_env import ENV_FILE_BY_NODE_ENV, find_monorepo_root, load_env

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_MANAGED_KEYS = (
    "NODE_ENV",
    "CI",
    "HOPE_PROBE_KEY",
    "HOPE_PROBE_OTHER",
)


@pytest.fixture(autouse=True)
def _clean_environ() -> Iterator[None]:
    """Snapshot/restore the keys these tests touch."""
    saved = {k: os.environ.get(k) for k in _MANAGED_KEYS}
    for key in _MANAGED_KEYS:
        os.environ.pop(key, None)
    yield
    for key, value in saved.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


@pytest.fixture
def fake_repo(tmp_path: Path) -> Path:
    """A throwaway monorepo root with the same marker the TS loader uses."""
    (tmp_path / "package.json").write_text(json.dumps({"name": "hope-monorepo"}))
    nested = tmp_path / "apps" / "svc" / "src" / "svc" / "core"
    nested.mkdir(parents=True)
    return tmp_path


def _write_env(root: Path, name: str, body: str) -> None:
    (root / name).write_text(body)


# ---------------------------------------------------------------------------
# Root discovery
# ---------------------------------------------------------------------------


def test_finds_monorepo_root_from_any_depth(fake_repo: Path) -> None:
    deep = fake_repo / "apps" / "svc" / "src" / "svc" / "core"
    assert find_monorepo_root(deep) == fake_repo


def test_returns_none_when_no_marker_above(tmp_path: Path) -> None:
    assert find_monorepo_root(tmp_path) is None


def test_ignores_unrelated_package_json(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(json.dumps({"name": "some-other-project"}))
    assert find_monorepo_root(tmp_path) is None


# ---------------------------------------------------------------------------
# NODE_ENV → file mapping (identical to the TS ENV_FILE_MAP)
# ---------------------------------------------------------------------------


def test_env_file_map_matches_typescript_contract() -> None:
    assert ENV_FILE_BY_NODE_ENV == {
        "development": ".env.dev",
        "test": ".env.test",
        "production": ".env.production",
        "staging": ".env.staging",
    }


def test_development_reads_env_dev(fake_repo: Path) -> None:
    _write_env(fake_repo, ".env.dev", "HOPE_PROBE_KEY=from-env-dev\n")
    os.environ["NODE_ENV"] = "development"

    result = load_env(start_dir=fake_repo)

    assert result.loaded is True
    assert result.env_file == fake_repo / ".env.dev"
    assert os.environ["HOPE_PROBE_KEY"] == "from-env-dev"


def test_unset_node_env_defaults_to_development(fake_repo: Path) -> None:
    _write_env(fake_repo, ".env.dev", "HOPE_PROBE_KEY=from-env-dev\n")

    result = load_env(start_dir=fake_repo)

    assert result.node_env == "development"
    assert os.environ["HOPE_PROBE_KEY"] == "from-env-dev"


def test_test_env_reads_env_test(fake_repo: Path) -> None:
    _write_env(fake_repo, ".env.dev", "HOPE_PROBE_KEY=from-env-dev\n")
    _write_env(fake_repo, ".env.test", "HOPE_PROBE_KEY=from-env-test\n")
    os.environ["NODE_ENV"] = "test"

    load_env(start_dir=fake_repo)

    assert os.environ["HOPE_PROBE_KEY"] == "from-env-test"


def test_development_falls_back_to_dotenv_when_env_dev_absent(fake_repo: Path) -> None:
    """Parity with the TS loader's development-only `.env` fallback."""
    _write_env(fake_repo, ".env", "HOPE_PROBE_KEY=from-legacy-dotenv\n")

    result = load_env(start_dir=fake_repo)

    assert result.env_file == fake_repo / ".env"
    assert os.environ["HOPE_PROBE_KEY"] == "from-legacy-dotenv"


def test_test_env_does_not_fall_back_to_dotenv(fake_repo: Path) -> None:
    _write_env(fake_repo, ".env", "HOPE_PROBE_KEY=from-legacy-dotenv\n")
    os.environ["NODE_ENV"] = "test"

    result = load_env(start_dir=fake_repo)

    assert result.loaded is False
    assert "HOPE_PROBE_KEY" not in os.environ


# ---------------------------------------------------------------------------
# Precedence
# ---------------------------------------------------------------------------


def test_host_env_always_wins_over_file(fake_repo: Path) -> None:
    _write_env(fake_repo, ".env.dev", "HOPE_PROBE_KEY=from-file\n")
    os.environ["HOPE_PROBE_KEY"] = "from-host"

    load_env(start_dir=fake_repo)

    assert os.environ["HOPE_PROBE_KEY"] == "from-host"


def test_empty_host_value_is_still_a_host_value(fake_repo: Path) -> None:
    """An explicitly-empty export is a deliberate override, not "unset"."""
    _write_env(fake_repo, ".env.dev", "HOPE_PROBE_KEY=from-file\n")
    os.environ["HOPE_PROBE_KEY"] = ""

    load_env(start_dir=fake_repo)

    assert os.environ["HOPE_PROBE_KEY"] == ""


def test_load_is_idempotent(fake_repo: Path) -> None:
    _write_env(fake_repo, ".env.dev", "HOPE_PROBE_KEY=one\n")
    load_env(start_dir=fake_repo)
    _write_env(fake_repo, ".env.dev", "HOPE_PROBE_KEY=two\n")

    load_env(start_dir=fake_repo)

    # First load put the key in os.environ; it is now a host value.
    assert os.environ["HOPE_PROBE_KEY"] == "one"


# ---------------------------------------------------------------------------
# CI / production — host env only (D7)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("ci_value", ["true", "1", "TRUE"])
def test_no_file_loading_in_ci(fake_repo: Path, ci_value: str) -> None:
    _write_env(fake_repo, ".env.dev", "HOPE_PROBE_KEY=from-file\n")
    os.environ["CI"] = ci_value

    result = load_env(start_dir=fake_repo)

    assert result.loaded is False
    assert result.is_ci is True
    assert "HOPE_PROBE_KEY" not in os.environ


def test_ci_false_still_loads(fake_repo: Path) -> None:
    _write_env(fake_repo, ".env.dev", "HOPE_PROBE_KEY=from-file\n")
    os.environ["CI"] = "false"

    result = load_env(start_dir=fake_repo)

    assert result.loaded is True


def test_no_file_loading_in_production(fake_repo: Path) -> None:
    _write_env(fake_repo, ".env.production", "HOPE_PROBE_KEY=from-file\n")
    os.environ["NODE_ENV"] = "production"

    result = load_env(start_dir=fake_repo)

    assert result.loaded is False
    assert "HOPE_PROBE_KEY" not in os.environ


# ---------------------------------------------------------------------------
# Parsing / degenerate inputs
# ---------------------------------------------------------------------------


def test_missing_file_is_not_an_error(fake_repo: Path) -> None:
    result = load_env(start_dir=fake_repo)

    assert result.loaded is False
    assert result.reason is not None


def test_missing_monorepo_root_is_not_an_error(tmp_path: Path) -> None:
    result = load_env(start_dir=tmp_path)

    assert result.loaded is False
    assert result.reason is not None


def test_strips_quotes_comments_and_export_prefix(fake_repo: Path) -> None:
    _write_env(
        fake_repo,
        ".env.dev",
        "\n".join(
            [
                "# a comment line",
                'HOPE_PROBE_KEY="quoted value"   # trailing comment',
                "export HOPE_PROBE_OTHER=exported",
                "",
            ]
        ),
    )

    load_env(start_dir=fake_repo)

    assert os.environ["HOPE_PROBE_KEY"] == "quoted value"
    assert os.environ["HOPE_PROBE_OTHER"] == "exported"
