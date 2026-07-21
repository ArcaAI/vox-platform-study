"""The effective-config pull client.

Mechanics are the guardrail `tenant_config.py` resolver's, with HTTP instead of
SQL: a TTL cache, a NEGATIVE cache so an unreachable gateway costs at most one
attempt per TTL window, and single-flight refresh. The contract that matters
operationally: with the gateway down, the service behaves EXACTLY as it does
today on env values.

Hermetic — `httpx.MockTransport` + an injected clock, no network, no real time.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from smr_v2.core.effective_config import EffectiveConfigClient

PAYLOAD = {
    "service": "smr",
    "generatedAt": "2026-07-20T00:00:00.000Z",
    "runtimeProfiles": [
        {
            "provider": "ollama",
            "modelSlug": "",
            "maxConcurrent": 12,
            "timeoutS": 45,
            "temperature": 0.3,
            "source": "db",
        }
    ],
}


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def make_client(
    clock: FakeClock,
    handler,
    *,
    ttl_s: int = 60,
) -> tuple[EffectiveConfigClient, dict[str, int]]:
    """Client wired to a counting MockTransport."""
    calls = {"n": 0}

    def counting(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return handler(request)

    client = EffectiveConfigClient(
        base_url="http://gateway.test/api/v1",
        token="smr-token",
        service="smr",
        ttl_s=ttl_s,
        time_func=clock,
        transport=httpx.MockTransport(counting),
    )
    return client, calls


def ok_handler(_request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=PAYLOAD)


def boom_handler(_request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("gateway unreachable")


class TestFetch:
    async def test_fetches_and_exposes_the_served_profile(self) -> None:
        clock = FakeClock()
        client, calls = make_client(clock, ok_handler)

        snapshot = await client.get()

        assert calls["n"] == 1
        assert snapshot.ok is True
        assert snapshot.runtime_profiles[0]["maxConcurrent"] == 12
        assert snapshot.runtime_profiles[0]["timeoutS"] == 45

    async def test_sends_the_service_token_and_service_query(self) -> None:
        clock = FakeClock()
        seen: dict[str, object] = {}

        def capture(request: httpx.Request) -> httpx.Response:
            seen["token"] = request.headers.get("x-service-token")
            seen["url"] = str(request.url)
            return httpx.Response(200, json=PAYLOAD)

        client, _ = make_client(clock, capture)
        await client.get()

        assert seen["token"] == "smr-token"
        assert "service=smr" in str(seen["url"])

    async def test_serves_from_cache_within_the_ttl_window(self) -> None:
        clock = FakeClock()
        client, calls = make_client(clock, ok_handler)

        await client.get()
        clock.advance(30)
        await client.get()

        assert calls["n"] == 1, "a read inside the TTL window must not re-fetch"

    async def test_refreshes_after_the_ttl_window(self) -> None:
        clock = FakeClock()
        client, calls = make_client(clock, ok_handler)

        await client.get()
        clock.advance(120)  # beyond any jittered 60s window
        await client.get()

        assert calls["n"] == 2


class TestNegativeCache:
    async def test_unreachable_gateway_yields_an_empty_snapshot(self) -> None:
        clock = FakeClock()
        client, _ = make_client(clock, boom_handler)

        snapshot = await client.get()

        assert snapshot.ok is False
        assert snapshot.runtime_profiles == []
        assert snapshot.raw == {}

    async def test_costs_exactly_one_attempt_per_ttl_window(self) -> None:
        """The load-bearing fail-safe: a down gateway must not be hammered."""
        clock = FakeClock()
        client, calls = make_client(clock, boom_handler)

        for _ in range(10):
            await client.get()

        assert calls["n"] == 1, "the empty result must be cached for a full TTL window"

        clock.advance(120)
        await client.get()
        assert calls["n"] == 2, "after the window, exactly one more attempt"

    async def test_a_non_2xx_response_is_treated_as_a_failure(self) -> None:
        clock = FakeClock()
        client, calls = make_client(clock, lambda _r: httpx.Response(503, text="unavailable"))

        snapshot = await client.get()

        assert snapshot.ok is False
        for _ in range(5):
            await client.get()
        assert calls["n"] == 1

    async def test_malformed_json_is_treated_as_a_failure(self) -> None:
        clock = FakeClock()
        client, _ = make_client(clock, lambda _r: httpx.Response(200, text="not json{{{"))

        snapshot = await client.get()

        assert snapshot.ok is False

    async def test_recovers_once_the_gateway_returns(self) -> None:
        clock = FakeClock()
        state = {"down": True}

        def flaky(request: httpx.Request) -> httpx.Response:
            if state["down"]:
                raise httpx.ConnectError("down")
            return httpx.Response(200, json=PAYLOAD)

        client, _ = make_client(clock, flaky)

        assert (await client.get()).ok is False
        state["down"] = False
        clock.advance(120)

        snapshot = await client.get()
        assert snapshot.ok is True
        assert snapshot.runtime_profiles[0]["maxConcurrent"] == 12


class TestSingleFlight:
    async def test_concurrent_expiry_triggers_exactly_one_http_call(self) -> None:
        clock = FakeClock()
        gate = asyncio.Event()

        async def slow_handler(_request: httpx.Request) -> httpx.Response:
            await gate.wait()
            return httpx.Response(200, json=PAYLOAD)

        calls = {"n": 0}

        async def counting(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return await slow_handler(request)

        client = EffectiveConfigClient(
            base_url="http://gateway.test/api/v1",
            token="smr-token",
            service="smr",
            time_func=clock,
            transport=httpx.MockTransport(counting),
        )

        readers = [asyncio.create_task(client.get()) for _ in range(8)]
        await asyncio.sleep(0)
        gate.set()
        results = await asyncio.wait_for(asyncio.gather(*readers), timeout=5)

        assert calls["n"] == 1, "concurrent expirers must collapse to one refresh"
        assert all(r.ok for r in results)


class TestJitter:
    def test_ttl_windows_stay_within_ten_percent(self) -> None:
        clock = FakeClock()
        client, _ = make_client(clock, ok_handler)

        windows = {client._next_window() for _ in range(200)}

        assert all(54.0 <= w <= 66.0 for w in windows), f"jitter out of ±10% bounds: {windows}"
        assert len(windows) > 1, "windows must actually vary (thundering-herd mitigation)"


class TestDiagnostics:
    async def test_reports_health_diagnostics_without_leaking_values(self) -> None:
        clock = FakeClock()
        client, _ = make_client(clock, ok_handler)
        await client.get()

        diag = client.diagnostics()

        assert diag["last_refresh_ok"] is True
        assert diag["ttl_seconds"] == 60
        assert diag["last_refresh_at"] is not None
        # Health is auth-exempt, so the block must expose ONLY these four keys —
        # labels and timestamps, never a resolved value. Asserting the exact key
        # set (rather than substring-searching the payload, which would also match
        # digits inside the ISO timestamp) is what actually pins the contract.
        assert set(diag) == {"last_refresh_at", "last_refresh_ok", "ttl_seconds", "sources"}
        assert diag["sources"] == {"runtimeProfiles": "db"}, "source labels only"
        assert 12 not in diag["sources"].values(), "the served limit must not leak"

    async def test_reports_failure_state(self) -> None:
        clock = FakeClock()
        client, _ = make_client(clock, boom_handler)
        await client.get()

        assert client.diagnostics()["last_refresh_ok"] is False

    def test_reports_never_refreshed_state_before_first_read(self) -> None:
        clock = FakeClock()
        client, _ = make_client(clock, ok_handler)

        diag = client.diagnostics()
        assert diag["last_refresh_at"] is None
        assert diag["last_refresh_ok"] is None


class TestCacheControl:
    async def test_clear_cache_forces_a_refetch(self) -> None:
        clock = FakeClock()
        client, calls = make_client(clock, ok_handler)

        await client.get()
        client.clear_cache()
        await client.get()

        assert calls["n"] == 2


class TestProviderLimits:
    async def test_exposes_per_provider_limits_for_wiring(self) -> None:
        clock = FakeClock()
        client, _ = make_client(clock, ok_handler)

        snapshot = await client.get()

        assert snapshot.provider_limits() == {"ollama": {"max_concurrent": 12, "timeout_s": 45}}

    async def test_omits_providers_that_carry_no_opinion(self) -> None:
        clock = FakeClock()
        payload = {
            "service": "smr",
            "runtimeProfiles": [
                {"provider": "ollama", "modelSlug": "", "maxConcurrent": None, "timeoutS": None},
                {"provider": "vllm", "modelSlug": "", "maxConcurrent": 3, "timeoutS": None},
            ],
        }
        client, _ = make_client(clock, lambda _r: httpx.Response(200, json=payload))

        limits = (await client.get()).provider_limits()

        assert "ollama" not in limits, "a null-only profile must leave env values alone"
        assert limits["vllm"] == {"max_concurrent": 3}

    async def test_ignores_model_specific_rows_for_service_level_limits(self) -> None:
        """Only provider-default rows (modelSlug == '') set service-level capacity."""
        clock = FakeClock()
        payload = {
            "service": "smr",
            "runtimeProfiles": [
                {"provider": "ollama", "modelSlug": "llama3:8b", "maxConcurrent": 99, "timeoutS": None},
            ],
        }
        client, _ = make_client(clock, lambda _r: httpx.Response(200, json=payload))

        assert (await client.get()).provider_limits() == {}

    async def test_a_failed_fetch_yields_no_limits(self) -> None:
        clock = FakeClock()
        client, _ = make_client(clock, boom_handler)

        assert (await client.get()).provider_limits() == {}


class TestLogging:
    async def test_logs_the_fetch_error_once_per_window(self, caplog: pytest.LogCaptureFixture) -> None:
        clock = FakeClock()
        client, _ = make_client(clock, boom_handler)

        with caplog.at_level("WARNING"):
            for _ in range(5):
                await client.get()

        assert sum("effective_config" in r.getMessage() for r in caplog.records) <= 1
