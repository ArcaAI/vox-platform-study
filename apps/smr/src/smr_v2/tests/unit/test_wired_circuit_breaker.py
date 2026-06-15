"""TDD tests for CircuitBreaker and ShutdownManager wiring into the generate endpoint.

RED: Written before implementation.
Tests verify that:
  - CircuitBreaker per-provider is checked before generation
  - Open circuit returns 503 with Retry-After
  - Failures trip the circuit
  - Successes reset the circuit
  - ShutdownManager rejects requests during shutdown
  - ShutdownManager tracks active tasks
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from smr_v2.core.config import Settings
from smr_v2.models.provider import ModelInfo, ProviderInfo
from smr_v2.models.task import TaskState, TaskStatus
from smr_v2.providers.base import ProviderRegistry
from smr_v2.services.circuit_breaker import CircuitBreaker, CircuitState
from smr_v2.services.shutdown_manager import ShutdownManager

# ── Helpers ──


def _make_settings(**overrides) -> Settings:
    defaults = {"host": "127.0.0.1", "port": 5099, "debug": True, "log_level": "debug", "metrics_enabled": False}
    defaults.update(overrides)
    return Settings(**defaults)


def _make_provider(*, generate_result=None, generate_exc=None):
    p = AsyncMock()
    if generate_exc:
        p.generate = AsyncMock(side_effect=generate_exc)
    else:
        result = generate_result or ("Generated!", {"prompt_tokens": 5, "completion_tokens": 10, "total_tokens": 15})
        p.generate = AsyncMock(return_value=result)
    p.health_check = AsyncMock(return_value=True)
    p.get_info = AsyncMock(return_value=ProviderInfo(
        name="test", display_name="Test", status="available",
        default_model="m", models=[ModelInfo(name="m")], supports_streaming=True,
    ))
    return p


def _make_task_manager():
    tm = AsyncMock()
    tm.create_task = AsyncMock(return_value=TaskState(
        task_id="t-1", status=TaskStatus.PENDING, provider="test", model="m",
    ))
    tm.get_task = AsyncMock(return_value=TaskState(
        task_id="t-1", status=TaskStatus.COMPLETED, provider="test", model="m",
    ))
    tm.update_task = AsyncMock(return_value=TaskState(
        task_id="t-1", status=TaskStatus.RUNNING, provider="test", model="m",
    ))
    tm.cancel_task = AsyncMock(return_value=TaskState(
        task_id="t-1", status=TaskStatus.CANCELLED, provider="test", model="m",
    ))
    tm.get_chunks = AsyncMock(return_value=[])
    tm.append_chunk = AsyncMock()
    return tm


def _build_app(settings, registry, task_manager, *, circuit_breakers=None, shutdown_manager=None):
    from smr_v2.main import create_app

    app = create_app(settings_override=settings)
    app.state.provider_registry = registry
    app.state.task_manager = task_manager
    app.state.settings = settings
    if circuit_breakers is not None:
        app.state.circuit_breakers = circuit_breakers
    if shutdown_manager is not None:
        app.state.shutdown_manager = shutdown_manager
    return app


# ── Circuit Breaker Wiring Tests ──


class TestCircuitBreakerWiring:
    """Verify that the generate endpoint checks and updates circuit breakers."""

    @pytest.mark.asyncio
    async def test_generate_succeeds_when_circuit_closed(self):
        """Normal generation works when the circuit breaker is CLOSED."""
        settings = _make_settings()
        registry = ProviderRegistry()
        registry.register("test", _make_provider())
        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=30.0)
        assert cb.state == CircuitState.CLOSED

        app = _build_app(settings, registry, _make_task_manager(), circuit_breakers={"test": cb})
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/api/v1/generate", json={"prompt": "hello", "provider": "test", "model": "test-model"})

        assert resp.status_code == 200
        data = resp.json()
        assert data["content"] == "Generated!"

    @pytest.mark.asyncio
    async def test_generate_returns_503_when_circuit_open(self):
        """Returns 503 with detail when the circuit is OPEN."""
        settings = _make_settings()
        registry = ProviderRegistry()
        registry.register("test", _make_provider())
        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=300.0)
        cb.record_failure()
        cb.record_failure()
        assert cb.state == CircuitState.OPEN

        app = _build_app(settings, registry, _make_task_manager(), circuit_breakers={"test": cb})
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/api/v1/generate", json={"prompt": "hello", "provider": "test", "model": "test-model"})

        assert resp.status_code == 503
        assert "circuit" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_circuit_opens_after_threshold_failures(self):
        """After N failures, the circuit opens and subsequent requests get 503."""
        settings = _make_settings()
        failing_provider = _make_provider(generate_exc=RuntimeError("LLM down"))
        registry = ProviderRegistry()
        registry.register("test", failing_provider)
        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=300.0)

        app = _build_app(settings, registry, _make_task_manager(), circuit_breakers={"test": cb})
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp1 = await client.post("/api/v1/generate", json={"prompt": "a", "provider": "test", "model": "test-model"})
            assert resp1.status_code == 502

            resp2 = await client.post("/api/v1/generate", json={"prompt": "b", "provider": "test", "model": "test-model"})
            assert resp2.status_code == 502

            assert cb.state == CircuitState.OPEN

            resp3 = await client.post("/api/v1/generate", json={"prompt": "c", "provider": "test", "model": "test-model"})
            assert resp3.status_code == 503

    @pytest.mark.asyncio
    async def test_circuit_records_success(self):
        """Successful generation calls record_success, resetting failure count."""
        settings = _make_settings()
        registry = ProviderRegistry()
        registry.register("test", _make_provider())
        cb = CircuitBreaker(failure_threshold=5, recovery_timeout=30.0)
        cb._failure_count = 3

        app = _build_app(settings, registry, _make_task_manager(), circuit_breakers={"test": cb})
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/api/v1/generate", json={"prompt": "hello", "provider": "test", "model": "test-model"})

        assert resp.status_code == 200
        assert cb.failure_count == 0
        assert cb.state == CircuitState.CLOSED

    @pytest.mark.asyncio
    async def test_circuit_half_open_allows_probe(self):
        """After recovery timeout, circuit moves to HALF_OPEN and allows one request."""
        settings = _make_settings()
        registry = ProviderRegistry()
        registry.register("test", _make_provider())
        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=0.0)
        cb.record_failure()
        cb.record_failure()
        assert cb.state == CircuitState.HALF_OPEN

        app = _build_app(settings, registry, _make_task_manager(), circuit_breakers={"test": cb})
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/api/v1/generate", json={"prompt": "probe", "provider": "test", "model": "test-model"})

        assert resp.status_code == 200
        assert cb.state == CircuitState.CLOSED

    @pytest.mark.asyncio
    async def test_circuit_breakers_per_provider(self):
        """Each provider has its own independent circuit breaker."""
        settings = _make_settings()
        registry = ProviderRegistry()
        registry.register("good", _make_provider())
        registry.register("bad", _make_provider())

        cb_good = CircuitBreaker(failure_threshold=2, recovery_timeout=300.0)
        cb_bad = CircuitBreaker(failure_threshold=2, recovery_timeout=300.0)
        cb_bad.record_failure()
        cb_bad.record_failure()
        assert cb_bad.state == CircuitState.OPEN
        assert cb_good.state == CircuitState.CLOSED

        app = _build_app(
            settings, registry, _make_task_manager(),
            circuit_breakers={"good": cb_good, "bad": cb_bad},
        )
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp_good = await client.post("/api/v1/generate", json={"prompt": "hi", "provider": "good", "model": "test-model"})
            resp_bad = await client.post("/api/v1/generate", json={"prompt": "hi", "provider": "bad", "model": "test-model"})

        assert resp_good.status_code == 200
        assert resp_bad.status_code == 503


# ── Shutdown Manager Wiring Tests ──


class TestShutdownManagerWiring:
    """Verify that the generate endpoint integrates with ShutdownManager."""

    @pytest.mark.asyncio
    async def test_shutdown_rejects_new_requests(self):
        """When shutting down, new requests get 503."""
        settings = _make_settings()
        registry = ProviderRegistry()
        registry.register("test", _make_provider())
        sm = ShutdownManager()
        sm.initiate_shutdown()
        assert sm.is_shutting_down

        app = _build_app(settings, registry, _make_task_manager(), shutdown_manager=sm)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/api/v1/generate", json={"prompt": "hello", "provider": "test", "model": "test-model"})

        assert resp.status_code == 503
        assert "shutting down" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_shutdown_tracks_active_tasks(self):
        """Active tasks are registered and completed via ShutdownManager."""
        settings = _make_settings()
        registry = ProviderRegistry()
        registry.register("test", _make_provider())
        sm = ShutdownManager()

        app = _build_app(settings, registry, _make_task_manager(), shutdown_manager=sm)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/api/v1/generate", json={"prompt": "hello", "provider": "test", "model": "test-model"})

        assert resp.status_code == 200
        assert sm.active_count == 0

    @pytest.mark.asyncio
    async def test_shutdown_waits_for_active_tasks(self):
        """Shutdown waits for active tasks to drain before completing."""
        sm = ShutdownManager()
        sm.register_task("task-a")
        sm.register_task("task-b")
        assert sm.active_count == 2

        async def complete_later():
            await asyncio.sleep(0.05)
            sm.complete_task("task-a")
            sm.complete_task("task-b")

        asyncio.get_event_loop().create_task(complete_later())
        timed_out = await sm.wait_for_shutdown(timeout=2.0)
        assert not timed_out
        assert sm.active_count == 0

    @pytest.mark.asyncio
    async def test_generate_registers_and_completes_task(self):
        """Generate endpoint registers task on start and completes on finish."""
        settings = _make_settings()
        registry = ProviderRegistry()
        registry.register("test", _make_provider())
        sm = ShutdownManager()

        app = _build_app(settings, registry, _make_task_manager(), shutdown_manager=sm)

        registered_ids: list[str] = []
        completed_ids: list[str] = []
        orig_register = sm.register_task
        orig_complete = sm.complete_task

        def spy_register(task_id):
            registered_ids.append(task_id)
            return orig_register(task_id)

        def spy_complete(task_id):
            completed_ids.append(task_id)
            return orig_complete(task_id)

        sm.register_task = spy_register
        sm.complete_task = spy_complete

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/api/v1/generate", json={"prompt": "hello", "provider": "test", "model": "test-model"})

        assert resp.status_code == 200
        assert len(registered_ids) == 1
        assert len(completed_ids) == 1
        assert registered_ids[0] == completed_ids[0]
