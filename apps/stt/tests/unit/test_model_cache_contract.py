"""The shared cache contract, instantiated against stt's wiring.

`tests/unit/test_model_cache.py` + `test_model_cache_ttl.py` are the PARITY gate
(they passed unmodified across the refactor, which is what proves no behaviour
moved). This file is the conformance lock on the other side: it asserts that the
things stt injects into the shared contract — the format→loader map and the
`loader.unload()` release hook — are actually wired to it, on every eviction path.

Without this, a future edit could quietly drop the unload hook and the parity
suite would still pass: it never asserts that an EVICTED model gets released.
That is exactly the defect class TDD caught inside the shared cache,
one layer up.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest

from stt.models.base_loader import LoadedModel
from stt.models.cache import CacheEntry, ModelCache
from stt.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
)

FORMAT = AiModelFormat.SAFETENSOR


def _loaded(slug: str, memory_mb: int = 100) -> LoadedModel:
    return LoadedModel(
        model_id=f"m-{slug}",
        model_slug=slug,
        model=MagicMock(),
        format=FORMAT,
        memory_mb=memory_mb,
        device="cpu",
    )


def _config(slug: str, memory_mb: int = 100) -> AiModelConfig:
    return AiModelConfig(
        id=f"m-{slug}",
        tenant_id="t-1",
        slug=slug,
        name=slug,
        description="",
        task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        source=AiModelSource.HUGGINGFACE,
        source_uri="openai/whisper-tiny",
        source_revision=None,
        format=FORMAT,
        memory_size_mb=memory_mb,
        compute_type="float32",
        download_status=AiModelDownloadStatus.DOWNLOADED,
        local_path=None,
        downloaded_at=datetime.utcnow(),
        file_size_mb=memory_mb,
        checksum=None,
        tags=[],
    )


def _cache_with_stub_loader(**kwargs) -> tuple[ModelCache, AsyncMock]:
    """A cache whose SAFETENSOR loader is a stub, so unload calls are observable."""
    cache = ModelCache(**{"max_memory_mb": 5000, "max_models": 3, "ttl_seconds": 3600, **kwargs})
    loader = AsyncMock()
    loader.load = AsyncMock(side_effect=lambda cfg: _loaded(cfg.slug, cfg.memory_size_mb))
    loader.unload = AsyncMock()
    cache._loaders[FORMAT] = loader  # type: ignore[assignment]
    return cache, loader


# ── the injected loader map ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_or_load_routes_through_the_format_loader() -> None:
    cache, loader = _cache_with_stub_loader()

    model = await cache.get_or_load(_config("asr-a"))

    loader.load.assert_awaited_once()
    assert loader.load.await_args[0][0].format is FORMAT
    assert model.model_slug == "asr-a"


@pytest.mark.asyncio
async def test_unknown_format_raises_rather_than_caching_a_none() -> None:
    from stt.core.exceptions import ModelLoadError

    cache, _ = _cache_with_stub_loader()
    cache._loaders.pop(FORMAT)

    with pytest.raises(ModelLoadError, match="No loader available"):
        await cache.get_or_load(_config("asr-a"))
    assert await cache.get("asr-a") is None


# ── the injected release hook, on every eviction path ───────────────────────


@pytest.mark.asyncio
async def test_explicit_evict_unloads_through_the_loader() -> None:
    cache, loader = _cache_with_stub_loader()
    await cache.get_or_load(_config("asr-a"))

    assert await cache.evict("asr-a") is True

    loader.unload.assert_awaited_once()
    assert loader.unload.await_args[0][0].model_slug == "asr-a"


@pytest.mark.asyncio
async def test_lru_overflow_unloads_through_the_loader() -> None:
    cache, loader = _cache_with_stub_loader(max_models=1)

    await cache.get_or_load(_config("asr-a"))
    await cache.get_or_load(_config("asr-b"))

    loader.unload.assert_awaited_once()
    assert loader.unload.await_args[0][0].model_slug == "asr-a"


@pytest.mark.asyncio
async def test_memory_budget_overflow_unloads_through_the_loader() -> None:
    cache, loader = _cache_with_stub_loader(max_memory_mb=250, max_models=10)

    await cache.get_or_load(_config("asr-a", memory_mb=200))
    await cache.get_or_load(_config("asr-b", memory_mb=200))

    loader.unload.assert_awaited_once()
    assert loader.unload.await_args[0][0].model_slug == "asr-a"


@pytest.mark.asyncio
async def test_idle_ttl_eviction_unloads_through_the_loader() -> None:
    cache, loader = _cache_with_stub_loader(ttl_seconds=60)
    await cache.get_or_load(_config("asr-a"))

    cache._cache["asr-a"].last_accessed = datetime.utcnow() - timedelta(seconds=120)
    assert await cache.get("asr-a") is None  # lazy TTL eviction on peek

    loader.unload.assert_awaited_once()


@pytest.mark.asyncio
async def test_sweep_releases_idle_models_through_the_loader() -> None:
    cache, loader = _cache_with_stub_loader(ttl_seconds=60)
    await cache.get_or_load(_config("asr-a"))

    cache._cache["asr-a"].last_accessed = datetime.utcnow() - timedelta(seconds=120)

    assert await cache.sweep() == 1
    loader.unload.assert_awaited_once()


@pytest.mark.asyncio
async def test_clear_unloads_every_resident_model() -> None:
    cache, loader = _cache_with_stub_loader()
    await cache.get_or_load(_config("asr-a"))
    await cache.get_or_load(_config("asr-b"))

    assert await cache.clear() == 2
    assert loader.unload.await_count == 2


@pytest.mark.asyncio
async def test_pinned_model_is_never_released() -> None:
    cache, loader = _cache_with_stub_loader(max_models=1, ttl_seconds=60)
    await cache.get_or_load(_config("asr-a"))
    await cache.pin("asr-a")

    cache._cache["asr-a"].last_accessed = datetime.utcnow() - timedelta(seconds=120)
    assert await cache.sweep() == 0
    await cache.get_or_load(_config("asr-b"))  # LRU pressure at max_models=1

    assert "asr-a" in cache._cache
    loader.unload.assert_not_awaited()


# ── the `_cache` view really steers the policy ──────────────────────────────


@pytest.mark.asyncio
async def test_cache_view_round_trips_datetimes() -> None:
    """The legacy `_cache` mapping is a live view, not a snapshot."""
    cache, _ = _cache_with_stub_loader()
    await cache.get_or_load(_config("asr-a"))

    entry = cache._cache["asr-a"]
    assert isinstance(entry, CacheEntry)
    assert entry.idle_seconds < 1

    aged = datetime.utcnow() - timedelta(seconds=300)
    entry.last_accessed = aged
    assert cache._cache["asr-a"].idle_seconds == pytest.approx(300, abs=2)


@pytest.mark.asyncio
async def test_stats_reflect_the_shared_core_state() -> None:
    cache, _ = _cache_with_stub_loader()
    await cache.get_or_load(_config("asr-a", memory_mb=100))
    await cache.get("asr-a")
    await cache.get("missing")

    stats = cache.stats()
    assert stats.total_models == 1
    assert stats.total_memory_mb == 100
    assert (stats.hits, stats.misses) == (1, 2)  # the load path counts one miss
    assert stats.models[0]["slug"] == "asr-a"
    assert stats.models[0]["access_count"] >= 1


# ── control-plane retention ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_apply_retention_takes_effect_without_dropping_residents() -> None:
    cache, _ = _cache_with_stub_loader(ttl_seconds=3600)
    await cache.get_or_load(_config("asr-a"))

    cache.apply_retention({"ttl_seconds": 60})

    assert cache._ttl_seconds == 60
    assert "asr-a" in cache._cache, "reconfiguration never drops residents"

    cache._cache["asr-a"].last_accessed = datetime.utcnow() - timedelta(seconds=120)
    assert await cache.sweep() == 1
