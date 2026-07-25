"""ModelCache idle TTL clamp + pin-while-active."""

from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest

from stt.models.cache import ModelCache, clamp_cache_ttl_seconds
from stt.pipeline.dto import AiModelFormat


def test_clamp_cache_ttl_seconds_bounds() -> None:
    assert clamp_cache_ttl_seconds(1) == 60
    assert clamp_cache_ttl_seconds(59) == 60
    assert clamp_cache_ttl_seconds(60) == 60
    assert clamp_cache_ttl_seconds(1800) == 1800
    assert clamp_cache_ttl_seconds(3600) == 3600
    assert clamp_cache_ttl_seconds(99999) == 3600


def test_model_cache_clamps_ttl_in_init() -> None:
    cache = ModelCache(max_models=10, ttl_seconds=5)
    assert cache._ttl_seconds == 60
    cache2 = ModelCache(max_models=10, ttl_seconds=7200)
    assert cache2._ttl_seconds == 3600


@pytest.mark.asyncio
async def test_pinned_model_skips_idle_ttl_and_lru() -> None:
    cache = ModelCache(max_models=1, ttl_seconds=60)
    model = MagicMock()
    model.memory_mb = 1
    model.device = "cpu"
    model.format = AiModelFormat.SAFETENSOR
    model.model_slug = "asr-a"

    await cache.put("asr-a", model)
    await cache.pin("asr-a")

    # Age the entry past TTL — pin must keep it.
    entry = cache._cache["asr-a"]
    entry.last_accessed = datetime.utcnow() - timedelta(seconds=120)
    entry.loaded_at = entry.last_accessed

    hit = await cache.get("asr-a")
    assert hit is model

    # LRU pressure must not evict the pinned model.
    model_b = MagicMock()
    model_b.memory_mb = 1
    model_b.device = "cpu"
    model_b.format = AiModelFormat.SAFETENSOR
    model_b.model_slug = "asr-b"
    loader = AsyncMock()
    loader.unload = AsyncMock()
    cache._loaders[AiModelFormat.SAFETENSOR] = loader  # type: ignore[assignment]

    await cache.put("asr-b", model_b)
    assert "asr-a" in cache._cache
    assert await cache.evict("asr-a") is False

    await cache.unpin("asr-a")
    # After unpin, idle clock resets; force idle expiry.
    entry = cache._cache["asr-a"]
    entry.last_accessed = datetime.utcnow() - timedelta(seconds=120)
    miss = await cache.get("asr-a")
    assert miss is None
