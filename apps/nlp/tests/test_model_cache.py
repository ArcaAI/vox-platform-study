"""Unit tests for the per-slot model instance cache (TASK-506).

Pure asyncio tests — the factory is a stub; no transformers/model loading.
The default (env-configured) instance never enters this cache (it lives in the
``nlp.dependencies`` singletons), so it can never be evicted.
"""

from __future__ import annotations

import asyncio

import pytest

from nlp.services.model_cache import ModelCache


class _Instance:
    def __init__(self, name: str) -> None:
        self.name = name
        self.shutdowns = 0

    async def shutdown(self) -> None:
        self.shutdowns += 1


class _Factory:
    def __init__(self, delay: float = 0.0, fail_for: set[str] | None = None) -> None:
        self.calls: list[str] = []
        self.delay = delay
        self.fail_for = fail_for or set()

    async def __call__(self, model_name: str) -> _Instance:
        self.calls.append(model_name)
        if self.delay:
            await asyncio.sleep(self.delay)
        if model_name in self.fail_for:
            raise RuntimeError(f"load failed: {model_name}")
        return _Instance(model_name)


async def test_get_creates_and_caches_instance() -> None:
    factory = _Factory()
    cache = ModelCache(factory=factory, max_size=3)

    first = await cache.get("m-a")
    second = await cache.get("m-a")

    assert first is second
    assert factory.calls == ["m-a"]


async def test_lru_bound_of_three_evicts_oldest() -> None:
    factory = _Factory()
    cache = ModelCache(factory=factory, max_size=3)

    for name in ("m-a", "m-b", "m-c", "m-d"):
        await cache.get(name)

    assert cache.cached_models() == ["m-b", "m-c", "m-d"]


async def test_lru_recency_protects_recently_used() -> None:
    factory = _Factory()
    cache = ModelCache(factory=factory, max_size=3)

    for name in ("m-a", "m-b", "m-c"):
        await cache.get(name)
    await cache.get("m-a")  # touch → m-b becomes the oldest
    await cache.get("m-d")

    assert cache.cached_models() == ["m-c", "m-a", "m-d"]


async def test_evicted_instance_is_shut_down() -> None:
    factory = _Factory()
    cache = ModelCache(factory=factory, max_size=1)

    first = await cache.get("m-a")
    await cache.get("m-b")

    assert first.shutdowns == 1


async def test_concurrent_requests_for_same_model_construct_once() -> None:
    factory = _Factory(delay=0.01)
    cache = ModelCache(factory=factory, max_size=3)

    results = await asyncio.gather(*(cache.get("m-a") for _ in range(5)))

    assert factory.calls == ["m-a"]
    assert all(instance is results[0] for instance in results)


async def test_load_failure_propagates_and_is_not_cached() -> None:
    factory = _Factory(fail_for={"m-bad"})
    cache = ModelCache(factory=factory, max_size=3)

    with pytest.raises(RuntimeError):
        await cache.get("m-bad")
    assert cache.cached_models() == []

    factory.fail_for.clear()
    retried = await cache.get("m-bad")  # a later request retries the load
    assert retried.name == "m-bad"
