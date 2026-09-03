"""A.3 (D-5) — harness gets a Redis client, so invalidation can be DELIVERED.

Round 2 built the subscriber SHAPE in `core/effective_config.py`
(`CONFIG_INVALIDATION_CHANNEL`, `handle_invalidation_message`,
`run_invalidation_listener`) but harness held no Redis client, so nothing could ever
call it: a control-plane write reached this service only by the 60s TTL poll, which
removes the property that justifies moving a value out of env at all
(rule 09 §"Config caches" rule 2 — *invalidation is the propagation path; the TTL is a
bounded-staleness safety net*).

**Process placement is deliberate, and asserted here.** The listener belongs to the
TEMPORAL WORKER, not the FastAPI app: the only thing harness caches from the control
plane is the MiniCheck entailer's retention + weights, and that entailer is constructed
inside a Temporal ACTIVITY, so its GGUF is resident in the worker process. A listener in
the app's lifespan would evict a cache that holds nothing — the same reasoning
`core/effective_config.py`'s own module docstring gives for driving the poll from
`temporal/worker.py`.

**The TTL stays a backstop.** A worker that boots while Redis is unreachable must still
start and must still converge, so every failure here degrades instead of raising.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from harness.core.config import Settings
from harness.core.effective_config import CONFIG_INVALIDATION_CHANNEL
from harness.core.redis_client import build_invalidation_redis
from harness.temporal import worker as worker_mod


class _FakePubSub:
    def __init__(self, messages: list[dict[str, Any]]) -> None:
        self.subscribed: list[str] = []
        self._messages = messages
        self.closed = False

    async def subscribe(self, channel: str) -> None:
        self.subscribed.append(channel)

    async def listen(self):
        for message in self._messages:
            yield message
        # Then block, the way a real pubsub does between messages.
        await asyncio.sleep(3600)

    async def aclose(self) -> None:
        self.closed = True


class _FakeRedis:
    def __init__(self, messages: list[dict[str, Any]] | None = None) -> None:
        self._pubsub = _FakePubSub(messages or [])

    def pubsub(self) -> _FakePubSub:
        return self._pubsub


class TestRedisClientExists:
    def test_bootstrap_url_is_an_env_tier_value(self) -> None:
        """The connection URL is a genuine bootstrap-floor value (rule 09 §Tiers).

        It is how the process REACHES Redis, so it cannot itself be delivered over
        Redis — the one class of setting that legitimately stays in env.
        """
        assert "redis_url" in Settings.model_fields
        assert Settings().redis_url.startswith("redis://")

    def test_build_returns_none_when_the_library_or_url_is_unusable(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A worker that cannot reach Redis still boots — the TTL remains the path."""
        assert build_invalidation_redis("not-a-redis-url") is None

    def test_build_returns_a_client_for_a_valid_url(self) -> None:
        client = build_invalidation_redis("redis://localhost:6379/0")
        assert client is not None


class TestListenerRunsInTheWorker:
    @pytest.mark.asyncio
    async def test_listener_subscribes_to_the_shared_channel(self) -> None:
        from harness.core.effective_config import EffectiveConfigClient

        client = EffectiveConfigClient(base_url="http://gw", token="t")
        redis = _FakeRedis()
        task = asyncio.create_task(client.run_invalidation_listener(redis))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert redis._pubsub.subscribed == [CONFIG_INVALIDATION_CHANNEL]

    @pytest.mark.asyncio
    async def test_worker_starts_the_listener_when_redis_is_reachable(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        evicted: list[bool] = []

        class _Client:
            async def run_invalidation_listener(self, redis: Any) -> None:
                evicted.append(True)
                await asyncio.sleep(3600)

        monkeypatch.setattr(worker_mod, "_effective_config_client", lambda: _Client())
        monkeypatch.setattr(worker_mod, "build_invalidation_redis", lambda url: _FakeRedis())

        task = worker_mod.start_config_invalidation_listener()
        assert task is not None
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert evicted == [True]

    @pytest.mark.asyncio
    async def test_worker_boots_without_redis_and_keeps_the_ttl_backstop(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(worker_mod, "build_invalidation_redis", lambda url: None)
        assert worker_mod.start_config_invalidation_listener() is None

    @pytest.mark.asyncio
    async def test_worker_boots_when_the_config_client_cannot_be_built(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(worker_mod, "_effective_config_client", lambda: None)
        monkeypatch.setattr(worker_mod, "build_invalidation_redis", lambda url: _FakeRedis())
        assert worker_mod.start_config_invalidation_listener() is None
