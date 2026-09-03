"""RC-6 — a control-plane write reaches this service WITHOUT waiting for the TTL.

Before this, ``arca:guardrail-config:invalidate`` appeared exactly once repo-wide
(the subscriber in ``guardrail/main.py``) and had **zero publishers**. Guardrail
believed it had push invalidation and actually had a 60s TTL poll, and the other
five Python services had no listener at all.

Rule 09 : *"Invalidation is the propagation path; TTL is a
bounded-staleness safety net."* These tests pin the SUBSCRIBE half of that
ordering:

* the channel literal agrees with the gateway's publisher;
* one published message drops the cached snapshot, so the very next read
  refetches — **with no clock advanced anywhere in this file**, which is what
  makes it a proof of PUSH rather than of TTL expiry;
* the TTL is still there as a backstop (a client that never receives a message
  still converges);
* nothing about the listener can take the service down.

FAKE REDIS, STATED PLAINLY: `_FakePubSub` below is an in-process stand-in, not a
live Redis round trip. What it does NOT prove is that redis-py delivers the
message. What it DOES prove is the whole of this service's half of the contract —
the channel it subscribes to, the payload it accepts, and the eviction it
performs — driven by the byte string the gateway actually publishes
(`test_channel_literal_matches_the_gateway_publisher` reads that literal from the
TypeScript source, so the two cannot drift apart silently).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from guardrail.core.effective_config import (
    CONFIG_INVALIDATION_CHANNEL,
    EffectiveConfigClient,
)

# --------------------------------------------------------------------------
# Doubles
# --------------------------------------------------------------------------


class _CountingTransport(httpx.AsyncBaseTransport):
    """Counts fetches so a refetch is observable without a clock."""

    def __init__(self) -> None:
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        payload = {"service": "guardrail", "generatedAt": "2026-08-23T00:00:00Z"}
        return httpx.Response(200, json=payload)


class _FakePubSub:
    """The minimum of the redis-py asyncio PubSub surface the listener uses."""

    def __init__(self, messages: list[dict]) -> None:
        self._messages = messages
        self.subscribed: list[str] = []
        self.closed = False

    async def subscribe(self, channel: str) -> None:
        self.subscribed.append(channel)

    async def listen(self):
        for message in self._messages:
            yield message

    async def aclose(self) -> None:
        self.closed = True


class _FakeRedis:
    def __init__(self, messages: list[dict]) -> None:
        self.pubsub_obj = _FakePubSub(messages)

    def pubsub(self) -> _FakePubSub:
        return self.pubsub_obj


class _ExplodingRedis:
    def pubsub(self):
        raise RuntimeError("redis unavailable")


def _client(transport: httpx.AsyncBaseTransport) -> EffectiveConfigClient:
    # A deliberately ENORMOUS TTL: nothing in this file may converge by expiry.
    return EffectiveConfigClient(
        base_url="http://gateway/api/v1",
        token="t",
        ttl_s=86_400,
        transport=transport,
    )


# --------------------------------------------------------------------------
# The channel literal
# --------------------------------------------------------------------------


def test_channel_literal_matches_the_gateway_publisher() -> None:
    """The subscriber and the publisher must name the SAME channel.

    A dead listener is exactly what a silently drifting literal produces, so the
    agreement is asserted against the TypeScript source rather than restated as a
    second copy of the string.
    """
    repo_root = Path(__file__).resolve().parents[5]
    source = (
        repo_root
        / "packages/applications/src/services/settings-registry/settings-registry-write.service.ts"
    ).read_text()

    assert f"PYTHON_CONFIG_INVALIDATION_CHANNEL = '{CONFIG_INVALIDATION_CHANNEL}'" in source


# --------------------------------------------------------------------------
# The eviction itself
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_published_write_evicts_the_snapshot_without_waiting_for_the_ttl() -> None:
    transport = _CountingTransport()
    client = _client(transport)

    await client.get()
    assert transport.calls == 1

    # Same window, no invalidation: the TTL alone would serve the stale snapshot.
    await client.get()
    assert transport.calls == 1

    # The exact bytes the gateway publishes.
    message = json.dumps(
        {
            "key": "guardrail.policy.piiRedactionEnabled",
            "scope": "system",
            "tenantId": "00000000-0000-0000-0000-000000000000",
        }
    )
    assert client.handle_invalidation_message(message) is True

    await client.get()
    assert transport.calls == 2, "the write must be observed without a TTL wait"


@pytest.mark.asyncio
async def test_listener_evicts_end_to_end_over_the_pubsub_surface() -> None:
    transport = _CountingTransport()
    client = _client(transport)
    await client.get()
    assert transport.calls == 1

    redis = _FakeRedis(
        [
            {"type": "subscribe", "data": 1},  # ignored — not a message
            {"type": "message", "data": json.dumps({"key": "retention.ttlSeconds"})},
        ]
    )

    await client.run_invalidation_listener(redis)

    assert redis.pubsub_obj.subscribed == [CONFIG_INVALIDATION_CHANNEL]
    assert redis.pubsub_obj.closed is True

    await client.get()
    assert transport.calls == 2


@pytest.mark.asyncio
async def test_bytes_payloads_and_malformed_payloads_both_evict() -> None:
    """Over-invalidation is safe; under-invalidation is the bug.

    ``decode_responses`` is not set uniformly across the services' Redis clients,
    so the listener must accept ``bytes``. And a payload it cannot parse still
    means *something changed* — dropping a cache is cheap, serving a stale
    safety policy is not.
    """
    transport = _CountingTransport()
    client = _client(transport)

    await client.get()
    assert client.handle_invalidation_message(b'{"key":"a.b"}') is True
    await client.get()
    assert transport.calls == 2

    assert client.handle_invalidation_message("{not json") is True
    await client.get()
    assert transport.calls == 3


@pytest.mark.asyncio
async def test_ttl_remains_the_backstop() -> None:
    """A service that starts while Redis is down must still converge."""
    transport = _CountingTransport()
    clock = {"t": 0.0}
    client = EffectiveConfigClient(
        base_url="http://gateway/api/v1",
        token="t",
        ttl_s=60,
        transport=transport,
        time_func=lambda: clock["t"],
    )

    await client.get()
    assert transport.calls == 1

    clock["t"] = 1_000.0  # far past the jittered window
    await client.get()
    assert transport.calls == 2


@pytest.mark.asyncio
async def test_listener_never_raises_when_redis_is_unavailable() -> None:
    client = _client(_CountingTransport())
    await client.run_invalidation_listener(_ExplodingRedis())  # must not raise


# --------------------------------------------------------------------------
# The SERVICE listener — the one that was dead
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_service_listener_evicts_both_caches_guardrail_holds() -> None:
    """`guardrail/main.py`'s listener is what RC-6 found subscribed-but-never-fed.

    It now watches the channel the gateway actually publishes on, and a write
    must reach BOTH caches this process holds: the per-tenant SQL resolver and
    the platform-scope effective-config snapshot.
    """
    from guardrail.main import CONFIG_INVALIDATION_CHANNEL as SERVICE_CHANNEL
    from guardrail.main import _config_invalidation_listener

    assert SERVICE_CHANNEL == CONFIG_INVALIDATION_CHANNEL

    transport = _CountingTransport()
    client = _client(transport)
    await client.get()
    assert transport.calls == 1

    class _Resolver:
        def __init__(self) -> None:
            self.calls: list[tuple] = []

        def invalidate(self, tenant_id=None, task_key=None):
            self.calls.append((tenant_id, task_key))
            return 1

    class _State:
        pass

    class _App:
        pass

    app = _App()
    app.state = _State()
    app.state.tenant_config_resolver = _Resolver()
    app.state.effective_config_client = client
    app.state.redis = _FakeRedis(
        [
            {
                "type": "message",
                "data": json.dumps(
                    {"key": "guardrail.policy.piiRedactionEnabled", "scope": "system"}
                ),
            },
            {"type": "message", "data": "tenant-a|summarization"},
        ]
    )

    await _config_invalidation_listener(app)

    assert app.state.redis.pubsub_obj.subscribed == [CONFIG_INVALIDATION_CHANNEL]
    # A platform-scope JSON write narrows to nothing; the legacy form still narrows.
    assert app.state.tenant_config_resolver.calls == [
        (None, None),
        ("tenant-a", "summarization"),
    ]

    await client.get()
    assert transport.calls == 2, "no TTL was advanced — this is push propagation"


@pytest.mark.asyncio
async def test_listener_propagates_cancellation() -> None:
    """Cancellation is shutdown, not a Redis error — it must not be swallowed."""

    class _HangingPubSub(_FakePubSub):
        async def listen(self):
            await asyncio.sleep(3600)
            yield {}  # pragma: no cover

    class _HangingRedis:
        def __init__(self) -> None:
            self.pubsub_obj = _HangingPubSub([])

        def pubsub(self):
            return self.pubsub_obj

    client = _client(_CountingTransport())
    redis = _HangingRedis()
    task = asyncio.create_task(client.run_invalidation_listener(redis))
    await asyncio.sleep(0)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
