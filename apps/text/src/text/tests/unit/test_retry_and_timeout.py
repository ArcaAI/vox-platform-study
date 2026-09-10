"""TDD tests for retry + per-request timeout in the generate endpoint.

Tasks 3.3 (wire RetryHandler) and 3.6 (per-request timeout via asyncio.wait_for).
RED: Written before implementation — all tests should FAIL initially.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from openai import BadRequestError, InternalServerError

from text.core.config import Settings
from text.models.task import TaskState, TaskStatus

_BACKOFF_PATCH = "text.api.endpoints.generate.asyncio.sleep"


# ── Fixtures ──────────────────────────────────────────────────────────


@pytest.fixture
def settings():
    return Settings(port=5099, log_level="debug")


@pytest.fixture
def mock_task_manager():
    tm = AsyncMock()
    tm.create_task = AsyncMock(
        return_value=TaskState(
            task_id="task-retry-1",
            status=TaskStatus.PENDING,
            provider="lm-studio",
            model="llama3.2:latest",
        )
    )
    tm.update_task = AsyncMock(
        return_value=TaskState(
            task_id="task-retry-1",
            status=TaskStatus.RUNNING,
            provider="lm-studio",
            model="llama3.2:latest",
        )
    )
    return tm


def _make_registry(mock_provider):
    """Build a ProviderRegistry with a single mock provider."""
    from text.providers.base import ProviderRegistry

    registry = ProviderRegistry()
    registry.register("lm-studio", mock_provider)
    return registry


@pytest_asyncio.fixture
async def _app_factory(settings, mock_task_manager):
    """Return a factory that creates an app with a given mock provider."""
    from text.main import create_app

    # Per-provider timeouts are a CONTROL-PLANE value now (`AiRuntimeProfile`
    # via effective-config), so a test sets them where the request path reads
    # them: `app.state.provider_timeouts`.
    served_timeouts: dict[str, int] = {}

    def factory(mock_provider):
        application = create_app(settings_override=settings)
        application.state.provider_registry = _make_registry(mock_provider)
        application.state.task_manager = mock_task_manager
        application.state.settings = settings
        application.state.circuit_breakers = {}
        application.state.rate_limiters = {}
        application.state.provider_queues = {}
        application.state.shutdown_manager = None
        application.state.provider_timeouts = served_timeouts
        return application

    factory.served_timeouts = served_timeouts
    return factory


async def _post_generate(app, payload: dict, *, patch_sleep: bool = False):
    """Helper: POST /api/v1/generate through the ASGI test client."""
    payload.setdefault("model", "test-model")  # model is caller-supplied
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
            return_value=(
                "Success!",
                "",
                {"prompt_tokens": 5, "completion_tokens": 10, "total_tokens": 15},
            )
        )
        app = _app_factory(mock_provider)
        resp = await _post_generate(
            app,
            {
                "prompt": "Hello",
                "provider": "lm-studio",
            },
        )
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
                ("Recovered!", "", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}),
            ]
        )
        app = _app_factory(mock_provider)
        resp = await _post_generate(
            app,
            {
                "prompt": "Hello",
                "provider": "lm-studio",
                "retry_config": {"max_retries": 3, "retry_on": ["provider_error"]},
            },
            patch_sleep=True,
        )
        assert resp.status_code == 200
        assert resp.json()["content"] == "Recovered!"
        assert mock_provider.generate.call_count == 2

    @pytest.mark.asyncio
    async def test_generate_retries_up_to_max(self, _app_factory):
        """Retries exactly max_retries times then fails."""
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=RuntimeError("always fails"))
        app = _app_factory(mock_provider)
        resp = await _post_generate(
            app,
            {
                "prompt": "Hello",
                "provider": "lm-studio",
                "retry_config": {"max_retries": 2, "retry_on": ["provider_error"]},
            },
            patch_sleep=True,
        )
        assert resp.status_code == 502
        # 1 initial + 2 retries = 3 total calls
        assert mock_provider.generate.call_count == 3

    @pytest.mark.asyncio
    async def test_generate_no_retry_when_max_retries_zero(self, _app_factory):
        """With max_retries=0, no retry on failure."""
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=RuntimeError("fail once"))
        app = _app_factory(mock_provider)
        resp = await _post_generate(
            app,
            {
                "prompt": "Hello",
                "provider": "lm-studio",
                "retry_config": {"max_retries": 0, "retry_on": ["provider_error"]},
            },
        )
        assert resp.status_code == 502
        assert mock_provider.generate.call_count == 1

    @pytest.mark.asyncio
    async def test_generate_succeeds_on_second_attempt(self, _app_factory):
        """Fails first, succeeds second — verifies retry recovery."""
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            side_effect=[
                RuntimeError("transient"),
                (
                    "Second try!",
                    "",
                    {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3},
                ),
            ]
        )
        app = _app_factory(mock_provider)
        resp = await _post_generate(
            app,
            {
                "prompt": "Hello",
                "provider": "lm-studio",
                "retry_config": {"max_retries": 3, "retry_on": ["provider_error"]},
            },
            patch_sleep=True,
        )
        assert resp.status_code == 200
        assert resp.json()["content"] == "Second try!"
        assert mock_provider.generate.call_count == 2

    @pytest.mark.asyncio
    async def test_retry_respects_retry_on_list(self, _app_factory):
        """Only retries for error types in retry_on — provider_error not in list means no retry."""
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=RuntimeError("provider down"))
        app = _app_factory(mock_provider)
        resp = await _post_generate(
            app,
            {
                "prompt": "Hello",
                "provider": "lm-studio",
                "retry_config": {"max_retries": 3, "retry_on": ["timeout"]},
            },
        )
        assert resp.status_code == 502
        # "provider_error" not in retry_on=["timeout"], so no retry — only 1 call
        assert mock_provider.generate.call_count == 1


# ── Timeout Tests ─────────────────────────────────────────────────────


class TestPerRequestTimeout:
    """Tests for Task 3.6 — per-request timeout via asyncio.wait_for."""

    @pytest.mark.asyncio
    async def test_generate_times_out(self, _app_factory, settings):
        """Provider that takes too long gets TimeoutError → 502."""
        _app_factory.served_timeouts["lm-studio"] = 1

        async def slow_generate(*args, **kwargs):
            await asyncio.sleep(10)
            return "late", "", {}

        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=slow_generate)
        app = _app_factory(mock_provider)
        app.state.settings = settings
        resp = await _post_generate(
            app,
            {
                "prompt": "Hello",
                "provider": "lm-studio",
                "retry_config": {"max_retries": 0, "retry_on": []},
            },
        )
        assert resp.status_code == 502
        assert "timed out" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_timeout_uses_provider_config(self, _app_factory, settings):
        """The timeout comes from the control plane, keyed by provider name."""
        _app_factory.served_timeouts["lm-studio"] = 1

        call_count = 0

        async def barely_slow(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            await asyncio.sleep(2)
            return "too slow", "", {}

        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=barely_slow)
        app = _app_factory(mock_provider)
        app.state.settings = settings
        resp = await _post_generate(
            app,
            {
                "prompt": "Hello",
                "provider": "lm-studio",
                "retry_config": {"max_retries": 0, "retry_on": []},
            },
        )
        assert resp.status_code == 502
        assert call_count == 1

    @pytest.mark.asyncio
    async def test_timeout_triggers_retry(self, _app_factory, settings):
        """Timeout triggers retry when 'timeout' is in retry_on."""
        _app_factory.served_timeouts["lm-studio"] = 1

        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            side_effect=[
                TimeoutError(),
                ("Fast!", "", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}),
            ]
        )

        app = _app_factory(mock_provider)
        app.state.settings = settings
        resp = await _post_generate(
            app,
            {
                "prompt": "Hello",
                "provider": "lm-studio",
                "retry_config": {"max_retries": 2, "retry_on": ["timeout"]},
            },
            patch_sleep=True,
        )
        assert resp.status_code == 200
        assert resp.json()["content"] == "Fast!"
        assert mock_provider.generate.call_count == 2

    @pytest.mark.asyncio
    async def test_timeout_returns_502_with_timeout_detail(self, _app_factory, settings):
        """Timed-out request returns 502 with 'timed out' in detail."""
        _app_factory.served_timeouts["lm-studio"] = 1

        async def always_slow(*args, **kwargs):
            await asyncio.sleep(10)
            return "never", "", {}

        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=always_slow)
        app = _app_factory(mock_provider)
        app.state.settings = settings
        resp = await _post_generate(
            app,
            {
                "prompt": "Hello",
                "provider": "lm-studio",
                "retry_config": {"max_retries": 0, "retry_on": []},
            },
        )
        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert "timed out" in detail.lower()


# ── Combined Retry + Timeout Tests ────────────────────────────────────


class TestRetryWithTimeout:
    """Tests for combined retry + timeout behavior."""

    @pytest.mark.asyncio
    async def test_retry_with_timeout_eventually_succeeds(self, _app_factory, settings):
        """Times out twice, succeeds on third attempt."""
        _app_factory.served_timeouts["lm-studio"] = 1

        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            side_effect=[
                TimeoutError(),
                TimeoutError(),
                ("Finally!", "", {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}),
            ]
        )
        app = _app_factory(mock_provider)
        app.state.settings = settings
        resp = await _post_generate(
            app,
            {
                "prompt": "Hello",
                "provider": "lm-studio",
                "retry_config": {"max_retries": 3, "retry_on": ["timeout"]},
            },
            patch_sleep=True,
        )
        assert resp.status_code == 200
        assert resp.json()["content"] == "Finally!"
        assert mock_provider.generate.call_count == 3

    @pytest.mark.asyncio
    async def test_all_retries_timeout(self, _app_factory, settings):
        """All attempts timeout — returns error after exhausting retries."""
        _app_factory.served_timeouts["lm-studio"] = 1

        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=TimeoutError("always times out"))
        app = _app_factory(mock_provider)
        app.state.settings = settings
        resp = await _post_generate(
            app,
            {
                "prompt": "Hello",
                "provider": "lm-studio",
                "retry_config": {"max_retries": 2, "retry_on": ["timeout"]},
            },
            patch_sleep=True,
        )
        assert resp.status_code == 502
        assert "timed out" in resp.json()["detail"].lower()
        # 1 initial + 2 retries = 3 total calls
        assert mock_provider.generate.call_count == 3


# ── Provider 4xx Tests (TASK-946 D5) ─────────────────────────────────
#
# LM Studio (and every other OpenAI-wire engine) answers a too-long prompt
# with a deterministic HTTP 400 — the request will NEVER succeed no matter
# how many times it is retried. Before this fix the generic `except Exception`
# arm classified it as `"provider_error"`, which is in the DEFAULT `retry_on`
# list, so the retry loop burned 3 attempts against a request that could not
# possibly change outcome, then answered a generic 502 that reads as "the
# service is down" rather than "the request was too big".


def _bad_request_error(message: str) -> BadRequestError:
    """A real `openai.BadRequestError`, shaped the way `openai_compat.py` /
    `lmstudio.py` actually raise it (`AsyncOpenAI.chat.completions.create`).
    Constructed the same way `test_provider_guardrails.py` already does for
    Azure's BadRequestError — the two providers share the `openai` SDK's
    exception hierarchy.
    """
    body = {"error": {"message": message, "type": "server_error"}}
    return BadRequestError(
        message=message,
        response=MagicMock(status_code=400, headers={}, json=lambda: body),
        body=body,
    )


def _internal_server_error(message: str) -> InternalServerError:
    body = {"error": {"message": message, "type": "server_error"}}
    return InternalServerError(
        message=message,
        response=MagicMock(status_code=500, headers={}, json=lambda: body),
        body=body,
    )


class TestProviderInvalidRequest:
    """A deterministic provider 4xx is classified `invalid_request`, is never
    retried (regardless of what the caller's `retry_on` asks for), and answers
    422 with a `code` — never the generic 502."""

    @pytest.mark.asyncio
    async def test_provider_4xx_is_not_retried_and_returns_422(self, _app_factory):
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            side_effect=_bad_request_error("The model does not support this input.")
        )
        app = _app_factory(mock_provider)
        resp = await _post_generate(
            app,
            {
                "prompt": "Hello",
                "provider": "lm-studio",
                # Explicitly asks to retry BOTH shapes — proves the exclusion
                # is structural, not just "absent from the default retry_on".
                "retry_config": {
                    "max_retries": 3,
                    "retry_on": ["provider_error", "invalid_request"],
                },
            },
            patch_sleep=True,
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "PROVIDER_INVALID_REQUEST"
        # Exactly one attempt — no retry on a deterministic 4xx.
        assert mock_provider.generate.call_count == 1

    @pytest.mark.asyncio
    async def test_provider_4xx_context_window_message_maps_to_context_window_code(
        self, _app_factory
    ):
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            side_effect=_bad_request_error(
                "Engine protocol predict stream returned an error: "
                '{"code":500,"message":"Context size has been exceeded.","type":"server_error"}'
            )
        )
        app = _app_factory(mock_provider)
        resp = await _post_generate(
            app,
            {
                "prompt": "Hello",
                "provider": "lm-studio",
                "retry_config": {"max_retries": 3, "retry_on": ["provider_error"]},
            },
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "CONTEXT_WINDOW_EXCEEDED"
        assert mock_provider.generate.call_count == 1

    @pytest.mark.asyncio
    async def test_provider_5xx_still_retries_and_returns_502(self, _app_factory):
        """5xx keeps the `provider_error` classification and the existing
        retry + 502 behavior — only the deterministic 4xx shape changed."""
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=_internal_server_error("model overloaded"))
        app = _app_factory(mock_provider)
        resp = await _post_generate(
            app,
            {
                "prompt": "Hello",
                "provider": "lm-studio",
                "retry_config": {"max_retries": 2, "retry_on": ["provider_error"]},
            },
            patch_sleep=True,
        )
        assert resp.status_code == 502
        # 1 initial + 2 retries = 3 total calls, exactly as an unclassified
        # provider error behaved before this change.
        assert mock_provider.generate.call_count == 3

    @pytest.mark.asyncio
    async def test_timeout_still_retries_unaffected_by_the_4xx_classification(
        self, _app_factory, settings
    ):
        """Timeouts are a distinct branch (`except TimeoutError`) untouched by
        the new provider-status-code classification — still retried when
        `"timeout"` is in `retry_on`."""
        _app_factory.served_timeouts["lm-studio"] = 1
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            side_effect=[
                TimeoutError(),
                ("Recovered!", "", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}),
            ]
        )
        app = _app_factory(mock_provider)
        app.state.settings = settings
        resp = await _post_generate(
            app,
            {
                "prompt": "Hello",
                "provider": "lm-studio",
                "retry_config": {"max_retries": 2, "retry_on": ["timeout"]},
            },
            patch_sleep=True,
        )
        assert resp.status_code == 200
        assert resp.json()["content"] == "Recovered!"
        assert mock_provider.generate.call_count == 2
