"""TDD tests for retry + per-request timeout in the generate endpoint.

Tasks 3.3 (wire RetryHandler) and 3.6 (per-request timeout via asyncio.wait_for).
RED: Written before implementation — all tests should FAIL initially.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from smr_v2.core.config import Settings
from smr_v2.models.task import TaskState, TaskStatus

_BACKOFF_PATCH = "smr_v2.api.endpoints.generate.asyncio.sleep"


# ── Fixtures ──────────────────────────────────────────────────────────


@pytest.fixture
def settings():
    return Settings(
        host="127.0.0.1",
        port=5099,
        debug=True,
        log_level="debug",
    )


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    tm.create_task = AsyncMock(
        return_value=TaskState(
            task_id="task-retry-1",
            status=TaskStatus.PENDING,
            provider="ollama",
            model="llama3.2:latest",
        )
    )
    tm.update_task = AsyncMock(
        return_value=TaskState(
            task_id="task-retry-1",
            status=TaskStatus.RUNNING,
            provider="ollama",
            model="llama3.2:latest",
        )
    )
    return tm


def _make_registry(mock_provider):
    """Build a ProviderRegistry with a single mock provider."""
    from smr_v2.providers.base import ProviderRegistry

    registry = ProviderRegistry()
    registry.register("ollama", mock_provider)
    return registry


@pytest_asyncio.fixture
async def _app_factory(settings, mock_task_manager):
    """Return a factory that creates an app with a given mock provider."""
    from smr_v2.main import create_app

    def factory(mock_provider):
        application = create_app(settings_override=settings)
        application.state.provider_registry = _make_registry(mock_provider)
        application.state.task_manager = mock_task_manager
        application.state.settings = settings
        application.state.circuit_breakers = {}
        application.state.rate_limiters = {}
        application.state.provider_queues = {}
        application.state.shutdown_manager = None
        return application

    return factory


async def _post_generate(app, payload: dict, *, patch_sleep: bool = False):
    """Helper: POST /api/v1/generate through the ASGI test client."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        if patch_sleep:
            with patch(_BACKOFF_PATCH, new_callable=AsyncMock):
                return await client.post("/api/v1/generate", json=payload)
        return await client.post("/api/v1/generate", json=payload)


# ── Retry Tests ───────────────────────────────────────────────────────


class TestRetryHandler:
    """Tests for Task 3.3 — wiring RetryHandler into the generate endpoint."""

    @pytest.mark.asyncio
    async def test_generate_succeeds_on_first_attempt(self, _app_factory):
        """No retry needed when first attempt succeeds."""
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            return_value=("Success!", {"prompt_tokens": 5, "completion_tokens": 10, "total_tokens": 15})
        )
        app = _app_factory(mock_provider)
        resp = await _post_generate(app, {
            "prompt": "Hello",
            "provider": "ollama",
        })
        assert resp.status_code == 200
        assert resp.json()["content"] == "Success!"
        assert mock_provider.generate.call_count == 1

    @pytest.mark.asyncio
    async def test_generate_retries_on_provider_error(self, _app_factory):
        """Retries when provider raises an exception, then succeeds."""
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            side_effect=[
                RuntimeError("provider down"),
                ("Recovered!", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}),
            ]
        )
        app = _app_factory(mock_provider)
        resp = await _post_generate(app, {
            "prompt": "Hello",
            "provider": "ollama",
            "retry_config": {"max_retries": 3, "retry_on": ["provider_error"]},
        }, patch_sleep=True)
        assert resp.status_code == 200
        assert resp.json()["content"] == "Recovered!"
        assert mock_provider.generate.call_count == 2

    @pytest.mark.asyncio
    async def test_generate_retries_up_to_max(self, _app_factory):
        """Retries exactly max_retries times then fails."""
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=RuntimeError("always fails"))
        app = _app_factory(mock_provider)
        resp = await _post_generate(app, {
            "prompt": "Hello",
            "provider": "ollama",
            "retry_config": {"max_retries": 2, "retry_on": ["provider_error"]},
        }, patch_sleep=True)
        assert resp.status_code == 502
        # 1 initial + 2 retries = 3 total calls
        assert mock_provider.generate.call_count == 3

    @pytest.mark.asyncio
    async def test_generate_no_retry_when_max_retries_zero(self, _app_factory):
        """With max_retries=0, no retry on failure."""
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=RuntimeError("fail once"))
        app = _app_factory(mock_provider)
        resp = await _post_generate(app, {
            "prompt": "Hello",
            "provider": "ollama",
            "retry_config": {"max_retries": 0, "retry_on": ["provider_error"]},
        })
        assert resp.status_code == 502
        assert mock_provider.generate.call_count == 1

    @pytest.mark.asyncio
    async def test_generate_succeeds_on_second_attempt(self, _app_factory):
        """Fails first, succeeds second — verifies retry recovery."""
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            side_effect=[
                RuntimeError("transient"),
                ("Second try!", {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}),
            ]
        )
        app = _app_factory(mock_provider)
        resp = await _post_generate(app, {
            "prompt": "Hello",
            "provider": "ollama",
            "retry_config": {"max_retries": 3, "retry_on": ["provider_error"]},
        }, patch_sleep=True)
        assert resp.status_code == 200
        assert resp.json()["content"] == "Second try!"
        assert mock_provider.generate.call_count == 2

    @pytest.mark.asyncio
    async def test_retry_respects_retry_on_list(self, _app_factory):
        """Only retries for error types in retry_on — provider_error not in list means no retry."""
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=RuntimeError("provider down"))
        app = _app_factory(mock_provider)
        resp = await _post_generate(app, {
            "prompt": "Hello",
            "provider": "ollama",
            "retry_config": {"max_retries": 3, "retry_on": ["timeout"]},
        })
        assert resp.status_code == 502
        # "provider_error" not in retry_on=["timeout"], so no retry — only 1 call
        assert mock_provider.generate.call_count == 1


# ── Timeout Tests ─────────────────────────────────────────────────────


class TestPerRequestTimeout:
    """Tests for Task 3.6 — per-request timeout via asyncio.wait_for."""

    @pytest.mark.asyncio
    async def test_generate_times_out(self, _app_factory, settings):
        """Provider that takes too long gets TimeoutError → 502."""
        settings.ollama.timeout_s = 1

        async def slow_generate(*args, **kwargs):
            await asyncio.sleep(10)
            return "late", {}

        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=slow_generate)
        app = _app_factory(mock_provider)
        app.state.settings = settings
        resp = await _post_generate(app, {
            "prompt": "Hello",
            "provider": "ollama",
            "retry_config": {"max_retries": 0, "retry_on": []},
        })
        assert resp.status_code == 502
        assert "timed out" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_timeout_uses_provider_config(self, _app_factory, settings):
        """Timeout value comes from provider config (ollama.timeout_s)."""
        settings.ollama.timeout_s = 1

        call_count = 0

        async def barely_slow(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            await asyncio.sleep(2)
            return "too slow", {}

        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=barely_slow)
        app = _app_factory(mock_provider)
        app.state.settings = settings
        resp = await _post_generate(app, {
            "prompt": "Hello",
            "provider": "ollama",
            "retry_config": {"max_retries": 0, "retry_on": []},
        })
        assert resp.status_code == 502
        assert call_count == 1

    @pytest.mark.asyncio
    async def test_timeout_triggers_retry(self, _app_factory, settings):
        """Timeout triggers retry when 'timeout' is in retry_on."""
        settings.ollama.timeout_s = 1

        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            side_effect=[
                TimeoutError(),
                ("Fast!", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}),
            ]
        )

        app = _app_factory(mock_provider)
        app.state.settings = settings
        resp = await _post_generate(app, {
            "prompt": "Hello",
            "provider": "ollama",
            "retry_config": {"max_retries": 2, "retry_on": ["timeout"]},
        }, patch_sleep=True)
        assert resp.status_code == 200
        assert resp.json()["content"] == "Fast!"
        assert mock_provider.generate.call_count == 2

    @pytest.mark.asyncio
    async def test_timeout_returns_502_with_timeout_detail(self, _app_factory, settings):
        """Timed-out request returns 502 with 'timed out' in detail."""
        settings.ollama.timeout_s = 1

        async def always_slow(*args, **kwargs):
            await asyncio.sleep(10)
            return "never", {}

        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=always_slow)
        app = _app_factory(mock_provider)
        app.state.settings = settings
        resp = await _post_generate(app, {
            "prompt": "Hello",
            "provider": "ollama",
            "retry_config": {"max_retries": 0, "retry_on": []},
        })
        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert "timed out" in detail.lower()


# ── Combined Retry + Timeout Tests ────────────────────────────────────


class TestRetryWithTimeout:
    """Tests for combined retry + timeout behavior."""

    @pytest.mark.asyncio
    async def test_retry_with_timeout_eventually_succeeds(self, _app_factory, settings):
        """Times out twice, succeeds on third attempt."""
        settings.ollama.timeout_s = 1

        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            side_effect=[
                TimeoutError(),
                TimeoutError(),
                ("Finally!", {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}),
            ]
        )
        app = _app_factory(mock_provider)
        app.state.settings = settings
        resp = await _post_generate(app, {
            "prompt": "Hello",
            "provider": "ollama",
            "retry_config": {"max_retries": 3, "retry_on": ["timeout"]},
        }, patch_sleep=True)
        assert resp.status_code == 200
        assert resp.json()["content"] == "Finally!"
        assert mock_provider.generate.call_count == 3

    @pytest.mark.asyncio
    async def test_all_retries_timeout(self, _app_factory, settings):
        """All attempts timeout — returns error after exhausting retries."""
        settings.ollama.timeout_s = 1

        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            side_effect=TimeoutError("always times out")
        )
        app = _app_factory(mock_provider)
        app.state.settings = settings
        resp = await _post_generate(app, {
            "prompt": "Hello",
            "provider": "ollama",
            "retry_config": {"max_retries": 2, "retry_on": ["timeout"]},
        }, patch_sleep=True)
        assert resp.status_code == 502
        assert "timed out" in resp.json()["detail"].lower()
        # 1 initial + 2 retries = 3 total calls
        assert mock_provider.generate.call_count == 3
