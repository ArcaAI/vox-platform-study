"""OD-6: the effective-config pull client and how the served knobs reach a request."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from asr_vllm.core.config import Settings
from asr_vllm.core.effective_config import (
    CONFIG_INVALIDATION_CHANNEL,
    SERVICE_NAME,
    EffectiveConfigClient,
)
from asr_vllm.main import create_app
from asr_vllm.tests.conftest import TENANT_ID, transcription_body
from asr_vllm.tests.fakes import FakeEngineFactory

GATEWAY = "http://gateway.test/api/v1"


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class Gateway:
    """A stand-in `GET /internal/effective-config` recording every call."""

    def __init__(self, settings: dict[str, Any] | None = None, status: int = 200) -> None:
        self.settings = settings or {}
        self.status = status
        self.requests: list[httpx.Request] = []
        self.delay_s = 0.0

    async def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        body = {
            "service": "asr-vllm",
            "generatedAt": "2026-09-29T00:00:00Z",
            "settings": {
                key: {"value": value, "dataType": "number", "source": "db"}
                for key, value in self.settings.items()
            },
        }
        return httpx.Response(self.status, json=body)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)


def client_for(gateway: Gateway, clock: Clock | None = None) -> EffectiveConfigClient:
    return EffectiveConfigClient(
        base_url=GATEWAY,
        token="tok-123",
        transport=gateway.transport(),
        time_func=clock or Clock(),
    )


# ── the client ──────────────────────────────────────────────────────────────


async def test_pulls_its_own_subset_with_the_shared_service_token() -> None:
    gateway = Gateway({"asrVllm.engine.maxNumSeqs": 32})
    snapshot = await client_for(gateway).get()

    (request,) = gateway.requests
    assert request.url.path == "/api/v1/internal/effective-config"
    assert request.url.params["service"] == SERVICE_NAME == "asr-vllm"
    assert request.headers["X-Service-Token"] == "tok-123"
    assert "X-Internal-Service-Key" not in request.headers
    assert snapshot.ok is True
    assert snapshot.raw["settings"]["asrVllm.engine.maxNumSeqs"]["value"] == 32


async def test_the_snapshot_is_cached_for_the_ttl_then_refetched() -> None:
    gateway, clock = Gateway(), Clock()
    client = client_for(gateway, clock)
    await client.get()
    await client.get()
    assert len(gateway.requests) == 1

    clock.now += 61 * 1.1  # past the ttl even with +10 % jitter
    assert client.is_stale() is True
    await client.get()
    assert len(gateway.requests) == 2


async def test_concurrent_reads_share_one_fetch() -> None:
    gateway = Gateway()
    gateway.delay_s = 0.05
    client = client_for(gateway)
    await asyncio.gather(*(client.get() for _ in range(20)))
    assert len(gateway.requests) == 1


@pytest.mark.parametrize("status", [401, 500, 503])
async def test_a_failed_pull_is_negative_cached_and_never_raises(status: int) -> None:
    gateway = Gateway(status=status)
    client = client_for(gateway)
    first = await client.get()
    second = await client.get()
    assert first.ok is False and first.raw == {}
    assert second is first
    assert len(gateway.requests) == 1


async def test_an_unreachable_gateway_is_open_to_default() -> None:
    async def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    client = EffectiveConfigClient(
        base_url=GATEWAY, token="t", transport=httpx.MockTransport(refuse)
    )
    snapshot = await client.get()
    assert snapshot.ok is False and snapshot.raw == {}
    assert client.diagnostics()["last_refresh_ok"] is False


async def test_an_invalidation_message_drops_the_cache() -> None:
    gateway = Gateway()
    client = client_for(gateway)
    await client.get()
    assert client.handle_invalidation_message(b'{"key":"asrVllm.engine.maxNumSeqs"}') is True
    assert client.handle_invalidation_message(b"not json") is True  # still evicts
    await client.get()
    assert len(gateway.requests) == 2


class FakePubSub:
    def __init__(self, messages: list[dict[str, Any]]) -> None:
        self.messages = messages
        self.subscribed: list[str] = []
        self.closed = False

    async def subscribe(self, channel: str) -> None:
        self.subscribed.append(channel)

    async def listen(self) -> AsyncIterator[dict[str, Any]]:
        for message in self.messages:
            yield message

    async def aclose(self) -> None:
        self.closed = True


class FakeRedis:
    def __init__(self, pubsub: FakePubSub) -> None:
        self._pubsub = pubsub

    def pubsub(self) -> FakePubSub:
        return self._pubsub


async def test_the_listener_subscribes_to_the_shared_channel_and_evicts() -> None:
    gateway = Gateway()
    client = client_for(gateway)
    await client.get()
    pubsub = FakePubSub(
        [{"type": "subscribe", "data": 1}, {"type": "message", "data": b'{"key":"x"}'}]
    )
    await client.run_invalidation_listener(FakeRedis(pubsub))
    assert pubsub.subscribed == [CONFIG_INVALIDATION_CHANNEL] == ["arca:config:invalidate"]
    assert pubsub.closed is True
    assert client.is_stale() is True


# ── wiring: truncation knobs per request ────────────────────────────────────


async def _post(client: AsyncClient) -> dict[str, Any]:
    response = await client.post(
        "/api/v1/transcriptions",
        json=transcription_body(),
        headers={"X-Tenant-Id": TENANT_ID},
    )
    assert response.status_code == 200
    body: dict[str, Any] = response.json()
    return body


async def test_truncation_knobs_follow_the_control_plane_per_request(settings: Settings) -> None:
    # "ok" on 7 s of voiced audio is flagged at the code default (3 chars / voiced s).
    gateway, clock = Gateway({"asrVllm.truncation.minCharsPerVoicedSecond": 0}), Clock()
    app = create_app(
        settings,
        engine_factory=FakeEngineFactory(engine_text="ok"),
        effective_config_client=client_for(gateway, clock),
    )
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            # The first window builds the engine, and a build pulls the control plane first.
            assert (await _post(client))["truncation"]["suspected"] is False

            # A platform admin raises the threshold; the TTL lapses. The next window must
            # not WAIT for the pull (it refreshes in the background) — a later one sees it.
            gateway.settings = {"asrVllm.truncation.minCharsPerVoicedSecond": 3}
            clock.now += 120
            await _post(client)
            await app.state.control_plane_refresh
            assert (await _post(client))["truncation"]["suspected"] is True
    assert len(gateway.requests) == 2


async def test_no_gateway_configured_serves_on_the_bootstrap_values(settings: Settings) -> None:
    app = create_app(settings, engine_factory=FakeEngineFactory(engine_text="ok"))
    assert app.state.effective_config_client is None
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            assert (await _post(client))["truncation"]["suspected"] is True


async def test_a_down_gateway_never_fails_a_window(settings: Settings) -> None:
    gateway = Gateway(status=503)
    app = create_app(
        settings,
        engine_factory=FakeEngineFactory(),
        effective_config_client=client_for(gateway),
    )
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            await _post(client)
    assert len(gateway.requests) == 1


async def test_the_first_refresh_arms_push_invalidation_when_redis_is_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import redis.asyncio as redis_asyncio

    from asr_vllm.core.effective_config import close_control_plane, refresh_control_plane

    pubsub = FakePubSub([])
    seen: list[str] = []

    def from_url(url: str, **_: Any) -> FakeRedis:
        seen.append(url)
        return FakeRedis(pubsub)

    monkeypatch.setattr(redis_asyncio, "from_url", from_url)
    monkeypatch.setenv("REDIS_URL", "redis://redis.test:6379/0")

    class State:
        pass

    state = State()
    state.settings = Settings()  # type: ignore[attr-defined]
    state.effective_config_client = client_for(Gateway())  # type: ignore[attr-defined]

    await refresh_control_plane(state)
    await refresh_control_plane(state)  # idempotent: one listener
    await asyncio.sleep(0)
    assert seen == ["redis://redis.test:6379/0"]
    assert pubsub.subscribed == [CONFIG_INVALIDATION_CHANNEL]
    await close_control_plane(state)
    assert state.config_invalidation_task is None  # type: ignore[attr-defined]
