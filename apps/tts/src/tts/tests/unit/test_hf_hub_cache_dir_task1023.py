"""TASK-1023 lane P: a hub-id resolves under ``<HF_HOME>/hub``, not ``<HF_HOME>``.

The model publisher writes the HuggingFace cache layout under
``$HF_HOME/hub/models--<org>--<repo>/snapshots/<sha>/``. ``snapshot_download``'s
``cache_dir`` names the hub cache ITSELF, so handing it ``HF_HOME`` straight
looks in ``$HF_HOME/models--...`` and misses. Precedence mirrors
``huggingface_hub``: ``HF_HUB_CACHE`` > ``<HF_HOME>/hub`` > library default.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tts.models.source_resolver import (
    ModelWeightIdentity,
    config_from_settings,
    resolve_model_dir,
)

pytestmark = pytest.mark.asyncio

SHA = "a" * 40


def _seed_hub(hub: Path) -> Path:
    repo = hub / "models--o--n"
    snap = repo / "snapshots" / SHA
    snap.mkdir(parents=True)
    (snap / "config.json").write_text("{}")
    (repo / "refs").mkdir()
    (repo / "refs" / "main").write_text(SHA)
    return snap


def _identity() -> ModelWeightIdentity:
    return ModelWeightIdentity(
        slug="o-n",
        source_uri="hf:o/n",
        source="HUGGINGFACE",
        source_revision=None,
        local_path=None,
        checksum=None,
    )


@pytest.fixture
def offline(monkeypatch):
    import huggingface_hub.constants as hf_constants

    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    monkeypatch.setattr(hf_constants, "HF_HUB_OFFLINE", True)
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_CACHE", raising=False)


async def test_hf_home_resolves_hub_subdirectory(tmp_path: Path, monkeypatch, offline) -> None:
    hf_home = tmp_path / "hf"
    snap = _seed_hub(hf_home / "hub")
    monkeypatch.setenv("HF_HOME", str(hf_home))

    config = config_from_settings()
    resolved = await resolve_model_dir(_identity(), config=config)

    assert resolved.resolve() == snap.resolve()


async def test_hf_hub_cache_env_wins_over_hf_home(tmp_path: Path, monkeypatch, offline) -> None:
    hf_home = tmp_path / "hf"
    other_hub = tmp_path / "elsewhere" / "hub"
    snap = _seed_hub(other_hub)
    monkeypatch.setenv("HF_HOME", str(hf_home))
    monkeypatch.setenv("HF_HUB_CACHE", str(other_hub))

    config = config_from_settings()
    resolved = await resolve_model_dir(_identity(), config=config)

    assert resolved.resolve() == snap.resolve()


async def test_unset_uses_library_default(monkeypatch, offline) -> None:
    monkeypatch.delenv("HF_HOME", raising=False)

    config = config_from_settings()

    assert config.hf_cache_dir is None
