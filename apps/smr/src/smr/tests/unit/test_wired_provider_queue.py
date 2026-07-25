"""TDD tests for wired provider queue integration (Task 3.5).

Tests verify that rate-limited requests are queued instead of immediately
rejected, and that queue metrics are tracked.

RED: Written before implementation.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from smr.core.config import QueueConfig, Settings
from smr.models.task import TaskState, TaskStatus
from smr.services.provider_queue import ProviderQueue
from smr.services.rate_limiter import RateLimitTracker

GENERATE_URL = "/api/v1/generate"
GENERATE_PAYLOAD = {
    "provider": "ollama",
    "prompt": "Hello world",
    "model": "llama3.2:latest",
}


@pytest.fixture
def settings():
    return Settings(
        host="127.0.0.1",
        port=5099,
        debug=True,
        log_level="debug",
        queue=QueueConfig(max_size=2, max_wait_s=0.5),
    )


@pytest.fixture
def mock_provider():
    provider = AsyncMock()
    provider.generate = AsyncMock(
        return_value=(
            "Generated text!",
            "",
            {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
        )
    )
    return provider


@pytest.fixture
def mock_provider_registry(mock_provider):
    from smr.providers.base import ProviderRegistry

    registry = ProviderRegistry()
    registry.register("ollama", mock_provider)
    return registry


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    tm.create_task = AsyncMock(
        return_value=TaskState(
            task_id="task-queue-1",
            status=TaskStatus.PENDING,
            provider="ollama",
            model="llama3.2:latest",
        )
    )
    tm.update_task = AsyncMock()
    return tm


@pytest_asyncio.fixture
async def app(settings, mock_provider_registry, mock_task_manager):
    from smr.main import create_app

    application = create_app(settings_override=settings)
    application.state.provider_registry = mock_provider_registry
    application.state.task_manager = mock_task_manager
    application.state.settings = settings
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class TestQueueWhenRateLimited:
    """When rate-limited, request is queued instead of rejected."""

    @pytest.mark.asyncio
    async def test_request_queued_when_rate_limited(self, app, client, mock_provider):
        """A rate-limited request should be enqueued and eventually proceed
        once the rate limiter signals capacity."""
        queue = ProviderQueue(max_size=2)
        rate_limiter = RateLimitTracker(rpm_limit=1, tpm_limit=0)
        rate_limiter.record_request(0)

        app.state.provider_queues = {"ollama": queue}
        app.state.rate_limiters = {"ollama": rate_limiter}

        async def unblock_after_delay():
            await asyncio.sleep(0.05)
            if queue.size > 0:
                item = await queue.dequeue()
                if not item.future.done():
                    item.future.set_result(True)

        task = asyncio.create_task(unblock_after_delay())
        resp = await client.post(GENERATE_URL, json=GENERATE_PAYLOAD)
        await task

        assert resp.status_code == 200
        mock_provider.generate.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_queued_request_proceeds_when_capacity_frees(
        self, app, client, mock_provider
    ):
        """Queued request eventually proceeds when the queue processor
        signals the future."""
        queue = ProviderQueue(max_size=5)
        rate_limiter = RateLimitTracker(rpm_limit=1, tpm_limit=0)
        rate_limiter.record_request(0)

        app.state.provider_queues = {"ollama": queue}
        app.state.rate_limiters = {"ollama": rate_limiter}

        async def process_queue():
            await asyncio.sleep(0.05)
            while queue.size > 0:
                item = await queue.dequeue()
                if not item.future.done():
                    item.future.set_result(True)

        processor = asyncio.create_task(process_queue())
        resp = await client.post(GENERATE_URL, json=GENERATE_PAYLOAD)
        await processor

        assert resp.status_code == 200
        data = resp.json()
        assert data["content"] == "Generated text!"


class TestQueueFullReturns429:
    """When queue is full, returns 429."""

    @pytest.mark.asyncio
    async def test_queue_full_returns_429(self, app, client):
        """If the queue is already at max capacity, return 429 immediately."""
        queue = ProviderQueue(max_size=1)
        rate_limiter = RateLimitTracker(rpm_limit=1, tpm_limit=0)
        rate_limiter.record_request(0)

        placeholder_future = asyncio.get_event_loop().create_future()
        await queue.enqueue(priority=0, future=placeholder_future, request_id="existing")

        app.state.provider_queues = {"ollama": queue}
        app.state.rate_limiters = {"ollama": rate_limiter}

        resp = await client.post(GENERATE_URL, json=GENERATE_PAYLOAD)
        assert resp.status_code == 429
        assert "queue is full" in resp.json()["detail"].lower()

        placeholder_future.cancel()


class TestQueueTimeoutReturns429:
    """When queue wait exceeds max_wait_s, returns 429."""

    @pytest.mark.asyncio
    async def test_queue_timeout_returns_429(self, app, client, settings):
        """If the queued request waits longer than max_wait_s, return 429."""
        assert settings.queue.max_wait_s == 0.5

        queue = ProviderQueue(max_size=2)
        rate_limiter = RateLimitTracker(rpm_limit=1, tpm_limit=0)
        rate_limiter.record_request(0)

        app.state.provider_queues = {"ollama": queue}
        app.state.rate_limiters = {"ollama": rate_limiter}

        resp = await client.post(GENERATE_URL, json=GENERATE_PAYLOAD)
        assert resp.status_code == 429
        assert "timed out" in resp.json()["detail"].lower()


class TestNoQueueReturns429Immediately:
    """When no queue configured, rate-limited requests get 429 immediately."""

    @pytest.mark.asyncio
    async def test_no_queue_returns_429_immediately(self, app, client):
        """Without a provider queue, a rate-limited request should get 429."""
        rate_limiter = RateLimitTracker(rpm_limit=1, tpm_limit=0)
        rate_limiter.record_request(0)

        app.state.provider_queues = {}
        app.state.rate_limiters = {"ollama": rate_limiter}

        resp = await client.post(GENERATE_URL, json=GENERATE_PAYLOAD)
        assert resp.status_code == 429
        assert "rate limit" in resp.json()["detail"].lower()


class TestQueueMetrics:
    """Queue size gauge reflects current queue depth."""

    @pytest.mark.asyncio
    async def test_queue_size_metric_updated(self, app, client, mock_provider):
        """QUEUE_SIZE gauge should be set when a request is enqueued."""
        queue = ProviderQueue(max_size=5)
        rate_limiter = RateLimitTracker(rpm_limit=1, tpm_limit=0)
        rate_limiter.record_request(0)

        app.state.provider_queues = {"ollama": queue}
        app.state.rate_limiters = {"ollama": rate_limiter}

        with patch("smr.api.endpoints.generate.QUEUE_SIZE") as mock_gauge, \
             patch("smr.api.endpoints.generate.QUEUE_WAIT_TIME") as mock_hist:
            mock_labels = MagicMock()
            mock_gauge.labels.return_value = mock_labels

            mock_hist_labels = MagicMock()
            mock_hist.labels.return_value = mock_hist_labels

            async def unblock():
                await asyncio.sleep(0.05)
                if queue.size > 0:
                    item = await queue.dequeue()
                    if not item.future.done():
                        item.future.set_result(True)

            task = asyncio.create_task(unblock())
            resp = await client.post(GENERATE_URL, json=GENERATE_PAYLOAD)
            await task

            assert resp.status_code == 200
            mock_gauge.labels.assert_called_with(provider="ollama")
            mock_labels.set.assert_called()
            mock_hist.labels.assert_called_with(provider="ollama")
            mock_hist_labels.observe.assert_called_once()


class TestNormalRequestBypassesQueue:
    """When within rate limits, request goes directly (no queuing)."""

    @pytest.mark.asyncio
    async def test_normal_request_bypasses_queue(self, app, client, mock_provider):
        """A request within rate limits should never touch the queue."""
        queue = ProviderQueue(max_size=5)
        rate_limiter = RateLimitTracker(rpm_limit=100, tpm_limit=100_000)

        app.state.provider_queues = {"ollama": queue}
        app.state.rate_limiters = {"ollama": rate_limiter}

        resp = await client.post(GENERATE_URL, json=GENERATE_PAYLOAD)
        assert resp.status_code == 200
        assert queue.size == 0
        mock_provider.generate.assert_awaited_once()
