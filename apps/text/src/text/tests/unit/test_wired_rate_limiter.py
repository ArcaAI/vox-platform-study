"""TDD tests for wired rate limiter integration.

Verifies that per-provider RateLimitTrackers are created at startup,
injected via dependency, and enforced in the generate endpoint.

RED: Written before implementation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.core.config import Settings
from text.models.provider import ModelInfo, ProviderInfo
from text.models.task import TaskState, TaskStatus
from text.services.rate_limiter import RateLimitTracker


@pytest.fixture
def settings():
    return Settings(host="127.0.0.1", port=5099, debug=True, log_level="debug")


@pytest.fixture
def mock_provider_registry():
    from text.providers.base import ProviderRegistry

    registry = ProviderRegistry()
    mock_provider = AsyncMock()
    mock_provider.generate = AsyncMock(
        return_value=(
            "Generated text!",
            "",
            {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        )
    )
    mock_provider.get_info = AsyncMock(
        return_value=ProviderInfo(
            name="ollama",
            display_name="Ollama",
            status="available",
            default_model="llama3.2:latest",
            models=[ModelInfo(name="llama3.2:latest")],
            supports_streaming=True,
        )
    )
    mock_provider.health_check = AsyncMock(return_value=True)
    registry.register("ollama", mock_provider)
    return registry


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    tm.create_task = AsyncMock(
        return_value=TaskState(
            task_id="task-123",
            status=TaskStatus.PENDING,
            provider="ollama",
            model="llama3.2:latest",
        )
    )
    tm.update_task = AsyncMock(
        return_value=TaskState(
            task_id="task-123",
            status=TaskStatus.RUNNING,
            provider="ollama",
            model="llama3.2:latest",
        )
    )
    return tm


def _make_app(settings, mock_provider_registry, mock_task_manager, rate_limiters=None):
    from text.main import create_app

    application = create_app(settings_override=settings)
    application.state.provider_registry = mock_provider_registry
    application.state.task_manager = mock_task_manager
    application.state.settings = settings
    if rate_limiters is not None:
        application.state.rate_limiters = rate_limiters
    return application


@pytest_asyncio.fixture
async def app_with_high_limits(settings, mock_provider_registry, mock_task_manager):
    """App with generous rate limits — requests should succeed."""
    limiters = {"ollama": RateLimitTracker(rpm_limit=1000, tpm_limit=1_000_000)}
    return _make_app(settings, mock_provider_registry, mock_task_manager, limiters)


@pytest_asyncio.fixture
async def app_with_rpm_limit_1(settings, mock_provider_registry, mock_task_manager):
    """App with RPM=1 — second request must be rejected."""
    limiters = {"ollama": RateLimitTracker(rpm_limit=1, tpm_limit=0)}
    return _make_app(settings, mock_provider_registry, mock_task_manager, limiters)


@pytest_asyncio.fixture
async def app_with_low_tpm(settings, mock_provider_registry, mock_task_manager):
    """App with TPM just enough for one request — second request exceeds it."""
    limiters = {"ollama": RateLimitTracker(rpm_limit=0, tpm_limit=7)}
    return _make_app(settings, mock_provider_registry, mock_task_manager, limiters)


@pytest_asyncio.fixture
async def app_without_rate_limiters(settings, mock_provider_registry, mock_task_manager):
    """App with empty rate_limiters dict — all requests pass through."""
    return _make_app(settings, mock_provider_registry, mock_task_manager, rate_limiters={})


GENERATE_PAYLOAD = {
    "prompt": "Hello world test prompt",
    "provider": "ollama",
    "model": "test-model",
    "stream": False,
}


class TestGenerateWithRateLimits:
    """Rate-limiter integration with the /generate endpoint."""

    @pytest.mark.asyncio
    async def test_generate_succeeds_when_within_limits(self, app_with_high_limits):
        transport = ASGITransport(app=app_with_high_limits)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/api/v1/generate", json=GENERATE_PAYLOAD)
        assert resp.status_code == 200
        data = resp.json()
        assert data["content"] == "Generated text!"

    @pytest.mark.asyncio
    async def test_generate_returns_429_when_rpm_exceeded(self, app_with_rpm_limit_1):
        transport = ASGITransport(app=app_with_rpm_limit_1)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            first = await client.post("/api/v1/generate", json=GENERATE_PAYLOAD)
            assert first.status_code == 200

            second = await client.post("/api/v1/generate", json=GENERATE_PAYLOAD)
            assert second.status_code == 429
            assert "Rate limit exceeded" in second.json()["detail"]

    @pytest.mark.asyncio
    async def test_generate_returns_429_when_tpm_exceeded(self, app_with_low_tpm):
        transport = ASGITransport(app=app_with_low_tpm)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            first = await client.post("/api/v1/generate", json=GENERATE_PAYLOAD)
            assert first.status_code == 200

            second = await client.post("/api/v1/generate", json=GENERATE_PAYLOAD)
            assert second.status_code == 429

    @pytest.mark.asyncio
    async def test_rate_limiter_records_request(self, app_with_high_limits):
        limiter = app_with_high_limits.state.rate_limiters["ollama"]
        assert limiter._rpm_counter.current_total() == 0

        transport = ASGITransport(app=app_with_high_limits)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/api/v1/generate", json=GENERATE_PAYLOAD)
        assert resp.status_code == 200
        assert limiter._rpm_counter.current_total() == 1

    @pytest.mark.asyncio
    async def test_no_rate_limiter_allows_all(self, app_without_rate_limiters):
        transport = ASGITransport(app=app_without_rate_limiters)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            for _ in range(3):
                resp = await client.post("/api/v1/generate", json=GENERATE_PAYLOAD)
                assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_retry_after_header_present(self, app_with_rpm_limit_1):
        transport = ASGITransport(app=app_with_rpm_limit_1)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            await client.post("/api/v1/generate", json=GENERATE_PAYLOAD)
            second = await client.post("/api/v1/generate", json=GENERATE_PAYLOAD)
        assert second.status_code == 429
        assert "retry-after" in second.headers

    @pytest.mark.asyncio
    async def test_rate_limiters_per_provider(self, settings, mock_task_manager):
        """Each provider has independent rate limits."""
        from text.providers.base import ProviderRegistry

        registry = ProviderRegistry()
        for name in ("azure", "ollama"):
            mp = AsyncMock()
            mp.generate = AsyncMock(
                return_value=(
                    "ok",
                    "",
                    {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                )
            )
            mp.get_info = AsyncMock(
                return_value=ProviderInfo(
                    name=name,
                    display_name=name,
                    status="available",
                    default_model="m",
                    models=[ModelInfo(name="m")],
                    supports_streaming=True,
                )
            )
            mp.health_check = AsyncMock(return_value=True)
            registry.register(name, mp)

        limiters = {
            "azure": RateLimitTracker(rpm_limit=1, tpm_limit=0),
            "ollama": RateLimitTracker(rpm_limit=1000, tpm_limit=0),
        }
        app = _make_app(settings, registry, mock_task_manager, limiters)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            r1 = await client.post(
                "/api/v1/generate",
                json={"prompt": "hi", "provider": "azure", "model": "test-model", "stream": False},
            )
            assert r1.status_code == 200

            r2 = await client.post(
                "/api/v1/generate",
                json={"prompt": "hi", "provider": "azure", "model": "test-model", "stream": False},
            )
            assert r2.status_code == 429

            r3 = await client.post(
                "/api/v1/generate",
                json={"prompt": "hi", "provider": "ollama", "model": "test-model", "stream": False},
            )
            assert r3.status_code == 200

    @pytest.mark.asyncio
    async def test_rate_limit_rejection_increments_metric(self, app_with_rpm_limit_1):
        from text.core.metrics import RATE_LIMIT_REJECTIONS

        transport = ASGITransport(app=app_with_rpm_limit_1)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            await client.post("/api/v1/generate", json=GENERATE_PAYLOAD)

            before = RATE_LIMIT_REJECTIONS.labels(provider="ollama")._value.get()

            await client.post("/api/v1/generate", json=GENERATE_PAYLOAD)

            after = RATE_LIMIT_REJECTIONS.labels(provider="ollama")._value.get()
            assert after > before
