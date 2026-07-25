"""stt's effective-config pull client + cache adoption.

stt already had the gateway transport (`api_gateway_url`/`api_gateway_key`),
so this client reuses it and authenticates with the existing
`X-Internal-Service-Key` header rather than minting a second credential.

The load-bearing safety property: the ModelCache's product clamp [60, 3600] is
re-applied to whatever the control plane serves, so a bad DB value cannot push
the cache outside its supported window.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from stt.core.effective_config import EffectiveConfigClient
from stt.models.cache import ModelCache

PAYLOAD = {
    "service": "stt",
    "generatedAt": "2026-07-20T00:00:00.000Z",
    "retention": {"ttlSeconds": 1800, "maxModels": 8, "maxMemoryMb": 20000, "source": "db"},
    "concurrency": {"workerConcurrency": 6, "streamingMaxConcurrent": 3, "source": "db"},
}


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def make_client(clock: FakeClock, handler) -> tuple[EffectiveConfigClient, dict[str, int]]:
    calls = {"n": 0}

    def counting(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return handler(request)

    client = EffectiveConfigClient(
        base_url="http://gateway.test/api/v1",
        api_key="stt-key",
        time_func=clock,
        transport=httpx.MockTransport(counting),
    )
    return client, calls


def ok_handler(_request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=PAYLOAD)


def boom_handler(_request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("gateway unreachable")


class TestFetch:
    async def test_reads_retention_and_concurrency(self) -> None:
        client, _ = make_client(FakeClock(), ok_handler)

        snapshot = await client.get()

        assert snapshot.ok is True
        assert snapshot.retention() == {"ttl_seconds": 1800, "max_models": 8, "max_memory_mb": 20000}
        assert snapshot.worker_concurrency() == 6
        assert snapshot.streaming_max_concurrent() == 3

    async def test_authenticates_with_the_existing_internal_service_key(self) -> None:
        """stt reuses its gateway credential — no second token is minted."""
        seen: dict[str, str] = {}

        def capture(request: httpx.Request) -> httpx.Response:
            seen["key"] = request.headers.get("x-internal-service-key", "")
            seen["url"] = str(request.url)
            return httpx.Response(200, json=PAYLOAD)

        client, _ = make_client(FakeClock(), capture)
        await client.get()

        assert seen["key"] == "stt-key"
        assert "service=stt" in seen["url"]

    async def test_caches_within_the_ttl_window(self) -> None:
        clock = FakeClock()
        client, calls = make_client(clock, ok_handler)

        await client.get()
        clock.advance(30)
        await client.get()

        assert calls["n"] == 1


class TestFailSafe:
    async def test_gateway_down_yields_no_opinion(self) -> None:
        client, _ = make_client(FakeClock(), boom_handler)

        snapshot = await client.get()

        assert snapshot.ok is False
        assert snapshot.retention() == {}
        assert snapshot.worker_concurrency() is None
        assert snapshot.streaming_max_concurrent() is None

    async def test_negative_cache_costs_one_attempt_per_window(self) -> None:
        clock = FakeClock()
        client, calls = make_client(clock, boom_handler)

        for _ in range(10):
            await client.get()
        assert calls["n"] == 1

        clock.advance(120)
        await client.get()
        assert calls["n"] == 2

    async def test_null_fields_are_omitted_rather_than_zeroed(self) -> None:
        payload = {
            "service": "stt",
            "retention": {"ttlSeconds": None, "maxModels": 5, "maxMemoryMb": None, "source": "env-fallback"},
        }
        client, _ = make_client(FakeClock(), lambda _r: httpx.Response(200, json=payload))

        assert (await client.get()).retention() == {"max_models": 5}


class TestSingleFlight:
    async def test_concurrent_expiry_triggers_one_call(self) -> None:
        gate = asyncio.Event()
        calls = {"n": 0}

        async def slow(_request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            await gate.wait()
            return httpx.Response(200, json=PAYLOAD)

        client = EffectiveConfigClient(
            base_url="http://gateway.test/api/v1",
            api_key="stt-key",
            transport=httpx.MockTransport(slow),
        )

        readers = [asyncio.create_task(client.get()) for _ in range(8)]
        await asyncio.sleep(0)
        gate.set()
        await asyncio.wait_for(asyncio.gather(*readers), timeout=5)

        assert calls["n"] == 1


class TestModelCacheAdoption:
    def test_applies_served_retention_values(self) -> None:
        cache = ModelCache(max_memory_mb=10000, max_models=5, ttl_seconds=3600)

        cache.apply_retention({"ttl_seconds": 1800, "max_models": 8, "max_memory_mb": 20000})

        assert cache._ttl_seconds == 1800
        assert cache._max_models == 8
        assert cache._max_memory_mb == 20000

    def test_reapplies_the_product_clamp_to_a_served_ttl(self) -> None:
        """A served 30 must still clamp to the 60s floor (ticket test #8)."""
        cache = ModelCache(max_models=5, ttl_seconds=3600)

        cache.apply_retention({"ttl_seconds": 30})

        assert cache._ttl_seconds == 60

    def test_clamps_a_served_ttl_above_the_ceiling(self) -> None:
        cache = ModelCache(max_models=5, ttl_seconds=3600)

        cache.apply_retention({"ttl_seconds": 999_999})

        assert cache._ttl_seconds == 3600

    def test_an_empty_snapshot_leaves_every_value_untouched(self) -> None:
        """Gateway down ⇒ byte-identical to today's env-driven behaviour."""
        cache = ModelCache(max_memory_mb=10000, max_models=5, ttl_seconds=3600)

        cache.apply_retention({})

        assert (cache._ttl_seconds, cache._max_models, cache._max_memory_mb) == (3600, 5, 10000)

    @pytest.mark.parametrize("bad", [0, -1])
    def test_rejects_nonsensical_sizes(self, bad: int) -> None:
        cache = ModelCache(max_memory_mb=10000, max_models=5, ttl_seconds=3600)

        cache.apply_retention({"max_models": bad, "max_memory_mb": bad})

        assert cache._max_models == 5
        assert cache._max_memory_mb == 10000

    def test_partial_values_apply_independently(self) -> None:
        cache = ModelCache(max_memory_mb=10000, max_models=5, ttl_seconds=3600)

        cache.apply_retention({"max_models": 9})

        assert cache._max_models == 9
        assert cache._ttl_seconds == 3600, "an unserved key must keep its env value"


class TestDiagnostics:
    async def test_reports_source_labels_only(self) -> None:
        client, _ = make_client(FakeClock(), ok_handler)
        await client.get()

        diag = client.diagnostics()

        assert diag["last_refresh_ok"] is True
        assert diag["sources"] == {"retention": "db", "concurrency": "db"}
        # Health is auth-exempt — the block exposes only these four keys.
        assert set(diag) == {"last_refresh_at", "last_refresh_ok", "ttl_seconds", "sources"}
