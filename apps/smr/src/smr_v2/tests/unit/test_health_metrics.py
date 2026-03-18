"""TDD tests for health metrics, liveness/readiness probes, and TTFT tracking.

Phase 2 Task 2.6 + IC-7: Prometheus gauges for provider health,
Kubernetes liveness/readiness endpoints, and time-to-first-token histogram.

RED: Written before implementation.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from smr_v2.core.config import Settings
from smr_v2.models.provider import ModelInfo, ProviderInfo
from smr_v2.models.stream import StreamChunk
from smr_v2.models.task import TaskState, TaskStatus
from smr_v2.providers.base import ProviderRegistry


# ── Fixtures ──


@pytest.fixture
def settings():
    return Settings(host="127.0.0.1", port=5099, debug=True, log_level="debug")


@pytest.fixture
def auth_settings():
    """Settings with auth enabled."""
    return Settings(
        host="127.0.0.1",
        port=5099,
        debug=True,
        log_level="debug",
        service_token="test-secret-token-abc123",
    )


def _make_mock_provider(*, healthy: bool = True):
    provider = AsyncMock()
    provider.health_check = AsyncMock(return_value=healthy)
    provider.generate = AsyncMock(
        return_value=("Generated text!", {"prompt_tokens": 5, "completion_tokens": 10, "total_tokens": 15})
    )
    provider.get_info = AsyncMock(
        return_value=ProviderInfo(
            name="ollama",
            display_name="Ollama",
            status="available",
            default_model="llama3.2:latest",
            models=[ModelInfo(name="llama3.2:latest")],
            supports_streaming=True,
        )
    )
    return provider


@pytest.fixture
def healthy_registry():
    registry = ProviderRegistry()
    registry.register("ollama", _make_mock_provider(healthy=True))
    registry.register("azure", _make_mock_provider(healthy=True))
    return registry


@pytest.fixture
def degraded_registry():
    registry = ProviderRegistry()
    registry.register("ollama", _make_mock_provider(healthy=True))
    unhealthy = _make_mock_provider(healthy=False)
    registry.register("azure", unhealthy)
    return registry


@pytest.fixture
def all_unhealthy_registry():
    registry = ProviderRegistry()
    registry.register("ollama", _make_mock_provider(healthy=False))
    registry.register("azure", _make_mock_provider(healthy=False))
    return registry


@pytest.fixture
def empty_registry():
    return ProviderRegistry()


@pytest.fixture
def error_registry():
    """Registry where health_check raises an exception."""
    registry = ProviderRegistry()
    provider = _make_mock_provider(healthy=True)
    provider.health_check = AsyncMock(side_effect=RuntimeError("connection refused"))
    registry.register("broken", provider)
    return registry


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    tm.create_task = AsyncMock(
        return_value=TaskState(
            task_id="task-ttft-1",
            status=TaskStatus.PENDING,
            provider="ollama",
            model="llama3.2:latest",
        )
    )
    tm.update_task = AsyncMock()
    tm.append_chunk = AsyncMock()
    return tm


def _create_app(settings_obj, *, provider_registry=None, task_manager=None):
    from smr_v2.main import create_app

    app = create_app(settings_override=settings_obj)
    if provider_registry is not None:
        app.state.provider_registry = provider_registry
    if task_manager is not None:
        app.state.task_manager = task_manager
    app.state.settings = settings_obj
    return app


@pytest_asyncio.fixture
async def healthy_client(settings, healthy_registry, mock_task_manager):
    app = _create_app(settings, provider_registry=healthy_registry, task_manager=mock_task_manager)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def degraded_client(settings, degraded_registry, mock_task_manager):
    app = _create_app(settings, provider_registry=degraded_registry, task_manager=mock_task_manager)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def unhealthy_client(settings, all_unhealthy_registry, mock_task_manager):
    app = _create_app(settings, provider_registry=all_unhealthy_registry, task_manager=mock_task_manager)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def empty_client(settings, empty_registry, mock_task_manager):
    app = _create_app(settings, provider_registry=empty_registry, task_manager=mock_task_manager)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def auth_client(auth_settings, healthy_registry, mock_task_manager):
    app = _create_app(auth_settings, provider_registry=healthy_registry, task_manager=mock_task_manager)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ── Health endpoint: status field ──


class TestHealthStatus:
    @pytest.mark.asyncio
    async def test_health_returns_ok_when_all_healthy(self, healthy_client):
        """All providers healthy → status 'healthy'."""
        resp = await healthy_client.get("/api/v1/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "healthy"
        assert data["checks"]["ollama"]["status"] == "healthy"
        assert data["checks"]["azure"]["status"] == "healthy"

    @pytest.mark.asyncio
    async def test_health_returns_degraded_when_unhealthy(self, degraded_client):
        """Some providers unhealthy → status 'degraded'."""
        resp = await degraded_client.get("/api/v1/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "degraded"
        assert data["checks"]["ollama"]["status"] == "healthy"
        assert data["checks"]["azure"]["status"] == "unhealthy"


# ── Health endpoint: Prometheus metrics ──


class TestHealthPrometheusMetrics:
    @pytest.mark.asyncio
    async def test_health_sets_prometheus_gauge(self, healthy_client):
        """After health check, PROVIDER_HEALTH gauge is set for each provider."""
        from smr_v2.core.metrics import PROVIDER_HEALTH

        await healthy_client.get("/api/v1/health")

        ollama_val = PROVIDER_HEALTH.labels(provider="ollama")._value.get()
        assert ollama_val == 1.0

    @pytest.mark.asyncio
    async def test_health_sets_gauge_zero_for_unhealthy(self, degraded_client):
        """Unhealthy provider gets gauge value 0."""
        from smr_v2.core.metrics import PROVIDER_HEALTH

        await degraded_client.get("/api/v1/health")

        azure_val = PROVIDER_HEALTH.labels(provider="azure")._value.get()
        assert azure_val == 0.0

    @pytest.mark.asyncio
    async def test_health_records_check_latency(self, healthy_client):
        """After health check, HEALTH_CHECK_LATENCY has observations."""
        from smr_v2.core.metrics import HEALTH_CHECK_LATENCY

        before = HEALTH_CHECK_LATENCY.labels(provider="ollama")._sum.get()
        await healthy_client.get("/api/v1/health")
        after = HEALTH_CHECK_LATENCY.labels(provider="ollama")._sum.get()

        assert after > before


# ── Liveness endpoint ──


class TestLivenessEndpoint:
    @pytest.mark.asyncio
    async def test_liveness_always_returns_200(self, healthy_client):
        """/health/live returns 200 with {"status": "healthy"}."""
        resp = await healthy_client.get("/api/v1/health/live")
        assert resp.status_code == 200
        assert resp.json() == {"status": "healthy"}

    @pytest.mark.asyncio
    async def test_liveness_returns_200_even_with_unhealthy_providers(self, unhealthy_client):
        """Liveness is independent of provider health."""
        resp = await unhealthy_client.get("/api/v1/health/live")
        assert resp.status_code == 200
        assert resp.json()["status"] == "healthy"


# ── Readiness endpoint ──


class TestReadinessEndpoint:
    @pytest.mark.asyncio
    async def test_readiness_returns_200_when_provider_healthy(self, healthy_client):
        """/health/ready returns 200 with status 'healthy' when at least one provider is healthy."""
        resp = await healthy_client.get("/api/v1/health/ready")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "healthy"
        assert "status" in data

    @pytest.mark.asyncio
    async def test_readiness_returns_503_when_no_providers_healthy(self, unhealthy_client):
        """/health/ready returns 503 with status 'unhealthy' when no providers are healthy."""
        resp = await unhealthy_client.get("/api/v1/health/ready")
        assert resp.status_code == 503
        data = resp.json()
        assert data["status"] == "unhealthy"

    @pytest.mark.asyncio
    async def test_readiness_returns_503_when_no_providers_registered(self, empty_client):
        """/health/ready returns 503 with status 'unhealthy' when registry is empty."""
        resp = await empty_client.get("/api/v1/health/ready")
        assert resp.status_code == 503
        data = resp.json()
        assert data["status"] == "unhealthy"


# ── Auth exemption for new endpoints ──


class TestAuthExemptionForProbes:
    SERVICE_TOKEN = "test-secret-token-abc123"

    @pytest.mark.asyncio
    async def test_liveness_exempt_from_auth(self, auth_client):
        """/health/live works without X-Service-Token when auth is enabled."""
        resp = await auth_client.get("/api/v1/health/live")
        assert resp.status_code == 200
        assert resp.json()["status"] == "healthy"

    @pytest.mark.asyncio
    async def test_readiness_exempt_from_auth(self, auth_client):
        """/health/ready works without X-Service-Token when auth is enabled."""
        resp = await auth_client.get("/api/v1/health/ready")
        assert resp.status_code == 200


# ── TTFT metric ──


class TestTTFTMetric:
    @pytest.mark.asyncio
    async def test_ttft_metric_exists(self):
        """TTFT_SECONDS histogram exists with correct labels."""
        from smr_v2.core.metrics import TTFT_SECONDS

        assert TTFT_SECONDS is not None
        assert TTFT_SECONDS._name == "smr_v2_time_to_first_token_seconds"
        labeled = TTFT_SECONDS.labels(provider="test", model="test-model")
        assert labeled is not None

    @pytest.mark.asyncio
    async def test_streaming_records_ttft(self, healthy_client, mock_task_manager):
        """After streaming generation, TTFT metric has an observation."""
        from smr_v2.core.metrics import TTFT_SECONDS

        before = TTFT_SECONDS.labels(provider="ollama", model="default")._sum.get()

        streaming_provider = _make_mock_provider(healthy=True)

        async def fake_stream(req):
            yield StreamChunk(type="chunk", data={"text": "Hello"})
            yield StreamChunk(type="chunk", data={"text": " world"})

        streaming_provider.generate_stream = fake_stream

        from smr_v2.api.endpoints.generate import _run_streaming_generation
        from smr_v2.models.requests import GenerateRequest

        request_body = GenerateRequest(prompt="test", provider="ollama", stream=True)

        await _run_streaming_generation(
            mock_task_manager,
            streaming_provider,
            "task-ttft-1",
            request_body,
            provider_name="ollama",
            model="default",
        )

        after = TTFT_SECONDS.labels(provider="ollama", model="default")._sum.get()
        assert after > before
