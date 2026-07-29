"""TDD tests for custom Prometheus metrics (Phase 2, Task 2.3).

Tests cover:
- Metric definition verification (counters, histograms, gauges)
- Endpoint integration (generation total, latency, tokens, errors)
- Active generation gauge lifecycle

RED: Written before implementation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from prometheus_client import (
    REGISTRY,
    Counter,
    Gauge,
    Histogram,
)

from smr.core.config import Settings
from smr.models.task import TaskState, TaskStatus
from smr.providers.base import ProviderRegistry

# ── Helpers ──


def _get_sample_value(metric_name: str, labels: dict[str, str]) -> float:
    """Read a Prometheus metric's current value from the default registry."""
    for metric_family in REGISTRY.collect():
        for sample in metric_family.samples:
            if sample.name == metric_name and all(
                sample.labels.get(k) == v for k, v in labels.items()
            ):
                return sample.value
    return 0.0


def _make_settings(**overrides) -> Settings:
    defaults = {
        "host": "127.0.0.1",
        "port": 5099,
        "debug": True,
        "log_level": "debug",
        "metrics_enabled": False,
    }
    defaults.update(overrides)
    return Settings(**defaults)


# ── Fixtures ──


@pytest.fixture
def mock_provider_registry():
    registry = ProviderRegistry()
    mock_provider = AsyncMock()
    mock_provider.generate = AsyncMock(
        return_value=(
            "Generated text!",
            "",
            {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
        )
    )
    registry.register("ollama", mock_provider)
    return registry


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    tm.create_task = AsyncMock(
        return_value=TaskState(
            task_id="task-metrics-1",
            status=TaskStatus.PENDING,
            provider="ollama",
            model="default",
        )
    )
    tm.update_task = AsyncMock(
        return_value=TaskState(
            task_id="task-metrics-1",
            status=TaskStatus.RUNNING,
            provider="ollama",
            model="default",
        )
    )
    return tm


@pytest_asyncio.fixture
async def client(mock_provider_registry, mock_task_manager):
    from smr.main import create_app

    settings = _make_settings()
    app = create_app(settings_override=settings)
    app.state.provider_registry = mock_provider_registry
    app.state.task_manager = mock_task_manager
    app.state.settings = settings
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def failing_client(mock_task_manager):
    """Client whose provider raises an exception on generate."""
    from smr.main import create_app

    registry = ProviderRegistry()
    mock_provider = AsyncMock()
    mock_provider.generate = AsyncMock(side_effect=RuntimeError("Provider exploded"))
    registry.register("ollama", mock_provider)

    settings = _make_settings()
    app = create_app(settings_override=settings)
    app.state.provider_registry = registry
    app.state.task_manager = mock_task_manager
    app.state.settings = settings
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ── Metric definition tests ──


class TestMetricDefinitions:
    def test_generation_total_counter_exists(self):
        """GENERATION_TOTAL is a Counter with provider/model/status labels."""
        from smr.core.metrics import GENERATION_TOTAL

        assert isinstance(GENERATION_TOTAL, Counter)
        labeled = GENERATION_TOTAL.labels(provider="test", model="test", status="completed")
        assert labeled is not None

    def test_generation_latency_histogram_exists(self):
        """GENERATION_LATENCY is a Histogram with correct buckets."""
        from smr.core.metrics import GENERATION_LATENCY

        assert isinstance(GENERATION_LATENCY, Histogram)
        labeled = GENERATION_LATENCY.labels(provider="test", model="test")
        assert labeled is not None
        expected_buckets = [0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0]
        assert list(GENERATION_LATENCY._kwargs["buckets"]) == expected_buckets

    def test_tokens_total_counter_exists(self):
        """TOKENS_TOTAL is a Counter with provider/model/direction labels."""
        from smr.core.metrics import TOKENS_TOTAL

        assert isinstance(TOKENS_TOTAL, Counter)
        labeled = TOKENS_TOTAL.labels(provider="test", model="test", direction="input")
        assert labeled is not None

    def test_generation_errors_counter_exists(self):
        """GENERATION_ERRORS is a Counter with provider/model/error_type labels."""
        from smr.core.metrics import GENERATION_ERRORS

        assert isinstance(GENERATION_ERRORS, Counter)
        labeled = GENERATION_ERRORS.labels(provider="test", model="test", error_type="timeout")
        assert labeled is not None

    def test_active_generations_gauge_exists(self):
        """ACTIVE_GENERATIONS is a Gauge with provider label."""
        from smr.core.metrics import ACTIVE_GENERATIONS

        assert isinstance(ACTIVE_GENERATIONS, Gauge)
        labeled = ACTIVE_GENERATIONS.labels(provider="test")
        assert labeled is not None


# ── Endpoint integration tests ──


class TestGenerateMetricsIntegration:
    @pytest.mark.asyncio
    async def test_successful_generation_increments_total(self, client):
        """After successful generate, GENERATION_TOTAL with status=completed is incremented."""
        before = _get_sample_value(
            "smr_generation_total",
            {"provider": "ollama", "model": "test-model", "status": "completed"},
        )
        await client.post(
            "/api/v1/generate",
            json={
                "prompt": "Hello world",
                "provider": "ollama",
                "model": "test-model",
                "stream": False,
            },
        )
        after = _get_sample_value(
            "smr_generation_total",
            {"provider": "ollama", "model": "test-model", "status": "completed"},
        )
        assert after - before >= 1.0

    @pytest.mark.asyncio
    async def test_successful_generation_records_latency(self, client):
        """After successful generate, GENERATION_LATENCY has an observation."""
        before = _get_sample_value(
            "smr_generation_latency_seconds_count",
            {"provider": "ollama", "model": "test-model"},
        )
        await client.post(
            "/api/v1/generate",
            json={
                "prompt": "Hello world",
                "provider": "ollama",
                "model": "test-model",
                "stream": False,
            },
        )
        after = _get_sample_value(
            "smr_generation_latency_seconds_count",
            {"provider": "ollama", "model": "test-model"},
        )
        assert after - before >= 1.0

    @pytest.mark.asyncio
    async def test_successful_generation_records_tokens(self, client):
        """After successful generate, TOKENS_TOTAL is incremented for both input and output."""
        before_input = _get_sample_value(
            "smr_tokens_total",
            {"provider": "ollama", "model": "test-model", "direction": "input"},
        )
        before_output = _get_sample_value(
            "smr_tokens_total",
            {"provider": "ollama", "model": "test-model", "direction": "output"},
        )
        await client.post(
            "/api/v1/generate",
            json={
                "prompt": "Hello world",
                "provider": "ollama",
                "model": "test-model",
                "stream": False,
            },
        )
        after_input = _get_sample_value(
            "smr_tokens_total",
            {"provider": "ollama", "model": "test-model", "direction": "input"},
        )
        after_output = _get_sample_value(
            "smr_tokens_total",
            {"provider": "ollama", "model": "test-model", "direction": "output"},
        )
        assert after_input - before_input == 10.0
        assert after_output - before_output == 20.0

    @pytest.mark.asyncio
    async def test_failed_generation_increments_errors(self, failing_client):
        """After failed generate, GENERATION_ERRORS is incremented."""
        before = _get_sample_value(
            "smr_generation_errors_total",
            {"provider": "ollama", "model": "test-model", "error_type": "provider_error"},
        )
        resp = await failing_client.post(
            "/api/v1/generate",
            json={
                "prompt": "Hello world",
                "provider": "ollama",
                "model": "test-model",
                "stream": False,
            },
        )
        assert resp.status_code == 502
        after = _get_sample_value(
            "smr_generation_errors_total",
            {"provider": "ollama", "model": "test-model", "error_type": "provider_error"},
        )
        assert after - before >= 1.0

    @pytest.mark.asyncio
    async def test_failed_generation_increments_total_with_failed_status(self, failing_client):
        """After failed generate, GENERATION_TOTAL with status=failed is incremented."""
        before = _get_sample_value(
            "smr_generation_total",
            {"provider": "ollama", "model": "test-model", "status": "failed"},
        )
        await failing_client.post(
            "/api/v1/generate",
            json={
                "prompt": "Hello world",
                "provider": "ollama",
                "model": "test-model",
                "stream": False,
            },
        )
        after = _get_sample_value(
            "smr_generation_total",
            {"provider": "ollama", "model": "test-model", "status": "failed"},
        )
        assert after - before >= 1.0

    @pytest.mark.asyncio
    async def test_active_generations_incremented_and_decremented(self, client):
        """During generation, the active gauge goes up then back down to its original value."""
        gauge_before = _get_sample_value(
            "smr_active_generations",
            {"provider": "ollama"},
        )
        await client.post(
            "/api/v1/generate",
            json={
                "prompt": "Hello world",
                "provider": "ollama",
                "model": "test-model",
                "stream": False,
            },
        )
        gauge_after = _get_sample_value(
            "smr_active_generations",
            {"provider": "ollama"},
        )
        assert gauge_after == gauge_before

    @pytest.mark.asyncio
    async def test_active_generations_decremented_on_failure(self, failing_client):
        """After a failed generation, active gauge returns to its original value."""
        gauge_before = _get_sample_value(
            "smr_active_generations",
            {"provider": "ollama"},
        )
        await failing_client.post(
            "/api/v1/generate",
            json={
                "prompt": "Hello world",
                "provider": "ollama",
                "model": "test-model",
                "stream": False,
            },
        )
        gauge_after = _get_sample_value(
            "smr_active_generations",
            {"provider": "ollama"},
        )
        assert gauge_after == gauge_before
