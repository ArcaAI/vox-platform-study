"""nlp's effective-config pull client (mirror of smr's).

Same frozen contract: TTL + jitter, negative cache, single-flight, fail-safe to
env. Hermetic via `httpx.MockTransport` + an injected clock.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from nlp.core.effective_config import EffectiveConfigClient

PAYLOAD = {
    "service": "nlp",
    "generatedAt": "2026-07-20T00:00:00.000Z",
    "concurrency": {"maxConcurrent": 9, "source": "db"},
    "runtimeProfiles": [],
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
        token="nlp-token",
        time_func=clock,
        transport=httpx.MockTransport(counting),
    )
    return client, calls


def ok_handler(_request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=PAYLOAD)


def boom_handler(_request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("gateway unreachable")


class TestFetch:
    async def test_reads_the_served_concurrency_bound(self) -> None:
        client, _ = make_client(FakeClock(), ok_handler)

        snapshot = await client.get()

        assert snapshot.ok is True
        assert snapshot.max_concurrent() == 9

    async def test_reads_the_served_peer_call_bound(self) -> None:
        """TASK-729 §6 — a SEPARATE field in the SAME `concurrency` group."""
        payload = {
            "service": "nlp",
            "concurrency": {"maxConcurrent": 9, "peerCallMaxConcurrent": 25, "source": "db"},
        }
        client, _ = make_client(FakeClock(), lambda _r: httpx.Response(200, json=payload))

        snapshot = await client.get()

        assert snapshot.max_concurrent() == 9
        assert snapshot.peer_call_max_concurrent() == 25

    async def test_requests_its_own_service_subset(self) -> None:
        seen: dict[str, str] = {}

        def capture(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["token"] = request.headers.get("x-service-token", "")
            return httpx.Response(200, json=PAYLOAD)

        client, _ = make_client(FakeClock(), capture)
        await client.get()

        assert "service=nlp" in seen["url"]
        assert seen["token"] == "nlp-token"

    async def test_caches_within_the_ttl_window(self) -> None:
        clock = FakeClock()
        client, calls = make_client(clock, ok_handler)

        await client.get()
        clock.advance(30)
        await client.get()

        assert calls["n"] == 1


class TestFailSafe:
    async def test_gateway_down_yields_no_opinion(self) -> None:
        """No opinion ⇒ the caller keeps its env bound — today's behaviour."""
        client, _ = make_client(FakeClock(), boom_handler)

        snapshot = await client.get()

        assert snapshot.ok is False
        assert snapshot.max_concurrent() is None

    async def test_negative_cache_costs_one_attempt_per_window(self) -> None:
        clock = FakeClock()
        client, calls = make_client(clock, boom_handler)

        for _ in range(10):
            await client.get()
        assert calls["n"] == 1

        clock.advance(120)
        await client.get()
        assert calls["n"] == 2

    async def test_a_null_bound_is_not_coerced_to_a_number(self) -> None:
        payload = {
            "service": "nlp",
            "concurrency": {"maxConcurrent": None, "source": "env-fallback"},
        }
        client, _ = make_client(FakeClock(), lambda _r: httpx.Response(200, json=payload))

        assert (await client.get()).max_concurrent() is None

    async def test_a_null_peer_call_bound_is_not_coerced_to_a_number(self) -> None:
        payload = {
            "service": "nlp",
            "concurrency": {"peerCallMaxConcurrent": None, "source": "env-fallback"},
        }
        client, _ = make_client(FakeClock(), lambda _r: httpx.Response(200, json=payload))

        assert (await client.get()).peer_call_max_concurrent() is None

    async def test_a_missing_concurrency_group_yields_no_peer_call_opinion(self) -> None:
        client, _ = make_client(FakeClock(), boom_handler)

        assert (await client.get()).peer_call_max_concurrent() is None

    @pytest.mark.parametrize("bad", [0, -4, "eight", True])
    async def test_rejects_a_nonsensical_bound(self, bad: object) -> None:
        payload = {"service": "nlp", "concurrency": {"maxConcurrent": bad, "source": "db"}}
        client, _ = make_client(FakeClock(), lambda _r: httpx.Response(200, json=payload))

        assert (await client.get()).max_concurrent() is None

    @pytest.mark.parametrize("bad", [0, -4, "eight", True])
    async def test_rejects_a_nonsensical_peer_call_bound(self, bad: object) -> None:
        payload = {"service": "nlp", "concurrency": {"peerCallMaxConcurrent": bad, "source": "db"}}
        client, _ = make_client(FakeClock(), lambda _r: httpx.Response(200, json=payload))

        assert (await client.get()).peer_call_max_concurrent() is None

    async def test_a_non_2xx_response_is_a_failure(self) -> None:
        client, _ = make_client(FakeClock(), lambda _r: httpx.Response(500))

        assert (await client.get()).ok is False


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
            token="nlp-token",
            transport=httpx.MockTransport(slow),
        )

        readers = [asyncio.create_task(client.get()) for _ in range(8)]
        await asyncio.sleep(0)
        gate.set()
        await asyncio.wait_for(asyncio.gather(*readers), timeout=5)

        assert calls["n"] == 1


class TestDiagnostics:
    async def test_reports_source_labels_only(self) -> None:
        client, _ = make_client(FakeClock(), ok_handler)
        await client.get()

        diag = client.diagnostics()

        assert diag["last_refresh_ok"] is True
        assert diag["sources"] == {"concurrency": "db"}
        # Health is auth-exempt, so the block must expose ONLY these four keys —
        # labels and timestamps, never a resolved value. Asserting the exact key
        # set (rather than substring-searching the payload, which would also match
        # digits inside the ISO timestamp) is what actually pins the contract.
        assert set(diag) == {"last_refresh_at", "last_refresh_ok", "ttl_seconds", "sources"}
        assert diag["ttl_seconds"] == 60, "the TTL is the client's own setting, not served config"
        assert 9 not in diag["sources"].values(), "the served bound must not leak"
