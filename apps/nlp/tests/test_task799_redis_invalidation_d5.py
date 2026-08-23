"""D-5 — `apps/nlp` gains the Redis client push invalidation needs to arrive on.

Round 2 built the subscriber SHAPE in `nlp/core/effective_config.py`
(`run_invalidation_listener`) and wired the publisher on the gateway, but this
service held no Redis client at all — so the channel had a handler and no
transport, and every control-plane write still took up to a full TTL window to be
seen here. Rule 09 §"Config caches": *invalidation is the propagation path; the
TTL is a bounded-staleness safety net.* Owner decision D-5 (2026-08-23) approved
the dependency.

What is pinned here:

1. the connection URL is a DECLARED, env-tier bootstrap value (`NLP_REDIS_URL`) —
   it is how the process reaches Redis, which is exactly the bootstrap floor
   `00-project-context.md` §Configuration Principles keeps in env;
2. the lifespan actually constructs a client and starts the listener task, so the
   subscriber is reachable rather than merely defined;
3. **a process that boots while Redis is down still starts** and still converges
   on the TTL backstop — the explicit requirement in D-5.

No live Redis is involved. That redis-py delivers a message is not what this
proves; that *this service subscribes at all* is.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from nlp.core.config import NLPServiceConfig


class TestRedisUrlIsADeclaredBootstrapValue:
    def test_the_url_has_a_declared_default(self) -> None:
        assert NLPServiceConfig().redis_url == "redis://localhost:6379/0"

    def test_host_env_sets_it_through_the_shared_precedence_chain(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("NLP_REDIS_URL", "redis://cache:6380/3")
        assert NLPServiceConfig().redis_url == "redis://cache:6380/3"


class TestLifespanWiresTheSubscriber:
    """The listener must be REACHABLE, not merely defined."""

    @staticmethod
    def _patches(redis_factory: object) -> tuple:
        return (
            patch("nlp.lifespan.get_websocket_manager", return_value=AsyncMock()),
            patch("nlp.lifespan.aioredis.from_url", redis_factory),
            patch("nlp.core.observability.setup_opentelemetry"),
            patch("nlp.core.observability.setup_prometheus"),
            patch("nlp.core.observability.shutdown_opentelemetry"),
        )

    @pytest.mark.asyncio
    async def test_a_client_is_built_and_the_listener_is_started(self) -> None:
        from nlp.app import get_app

        redis_client = AsyncMock()
        factory = lambda *a, **k: redis_client  # noqa: E731

        with (
            patch("nlp.lifespan.get_websocket_manager", return_value=AsyncMock()),
            patch("nlp.lifespan.aioredis.from_url", factory),
            patch("nlp.core.observability.setup_opentelemetry"),
            patch("nlp.core.observability.setup_prometheus"),
            patch("nlp.core.observability.shutdown_opentelemetry"),
        ):
            app = get_app()
            async with app.router.lifespan_context(app):
                assert app.state.redis is redis_client
                task = app.state.config_invalidation_task
                assert task is not None, "the subscriber task was never started"

    @pytest.mark.asyncio
    async def test_boot_survives_an_unreachable_redis(self) -> None:
        """D-5: *a service that starts while Redis is down must still converge.*

        The failure must be absorbed at BOOT — a service that cannot reach its
        cache is degraded, not broken, and taking the NLP plane down because the
        config-propagation optimisation is unavailable inverts the priority.
        """
        from nlp.app import get_app

        def explode(*_args: object, **_kwargs: object) -> object:
            raise ConnectionError("redis is not listening")

        with (
            patch("nlp.lifespan.get_websocket_manager", return_value=AsyncMock()),
            patch("nlp.lifespan.aioredis.from_url", explode),
            patch("nlp.core.observability.setup_opentelemetry"),
            patch("nlp.core.observability.setup_prometheus"),
            patch("nlp.core.observability.shutdown_opentelemetry"),
        ):
            app = get_app()
            async with app.router.lifespan_context(app):
                # Booted. No Redis, no listener — the TTL backstop carries it.
                assert app.state.redis is None
                assert app.state.config_invalidation_task is None
