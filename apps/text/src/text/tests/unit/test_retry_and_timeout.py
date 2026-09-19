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
    422 with a `code` — never the generic 502.

    "Deterministic" excludes 429 and 408 since TASK-993 D-5: those are 4xx by
    status only and are retried. See `TestVendorRateLimitClassification` below.
    """

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


# ── Vendor 429 / 408 (TASK-993 D-5) ──────────────────────────────────
#
# The 4xx→`invalid_request` sweep above was written for a MALFORMED body: a
# rejection the provider has already decided, which no retry can change. It
# swept in 429 and 408 with it, and those are the opposite kind of 4xx — the
# provider answered promptly, correctly, and (for a 429) with a deadline it is
# asking us to honour. The observable damage was fourfold:
#
#   * the retry loop refused them, so `retry_after_from` — a parser written for
#     exactly this case — was unreachable dead code;
#   * the caller got 422, which `@arcaai/vox-node` treats as non-retryable, so
#     the whole chain gave up on a transient condition;
#   * no `Retry-After` reached the caller, so nothing could pace against it; and
#   * `cb.record_failure()` ran, so five throttles in a row converted a
#     seconds-long vendor pause into a 30-second platform outage.


def _status_error(status_code: int, *, message: str = "boom", headers: dict | None = None):
    """A provider SDK error carrying ``status_code`` the way the adapters raise it.

    Shaped like the `openai`/`anthropic` `APIStatusError` family (`.status_code`
    direct), which is what `provider_status_code_from` duck-types on.
    """
    from openai import APIStatusError

    body = {"error": {"message": message, "type": "rate_limit_error"}}
    return APIStatusError(
        message,
        response=MagicMock(status_code=status_code, headers=headers or {}, json=lambda: body),
        body=body,
    )


class TestVendorRateLimitClassification:
    """`retry_handler`'s verdicts, at the unit level."""

    def test_a_vendor_429_is_not_a_deterministic_invalid_request(self):
        from text.services.retry_handler import (
            is_provider_invalid_request,
            is_provider_rate_limited,
        )

        exc = _status_error(429)
        assert is_provider_invalid_request(exc) is False
        assert is_provider_rate_limited(exc) is True

    def test_a_vendor_408_is_not_a_deterministic_invalid_request(self):
        """A request timeout is the provider saying "that attempt took too
        long", not "this request is wrong" — transient, but NOT a rate limit,
        so it does not get the 429 response mapping."""
        from text.services.retry_handler import (
            is_provider_invalid_request,
            is_provider_rate_limited,
        )

        exc = _status_error(408)
        assert is_provider_invalid_request(exc) is False
        assert is_provider_rate_limited(exc) is False

    def test_a_vendor_400_is_still_a_deterministic_invalid_request(self):
        """The TASK-946 D5 behaviour the carve-out must not regress."""
        from text.services.retry_handler import (
            is_provider_invalid_request,
            is_provider_rate_limited,
        )

        exc = _status_error(400)
        assert is_provider_invalid_request(exc) is True
        assert is_provider_rate_limited(exc) is False

    def test_a_vendor_500_is_neither(self):
        from text.services.retry_handler import (
            is_provider_invalid_request,
            is_provider_rate_limited,
        )

        exc = _status_error(500)
        assert is_provider_invalid_request(exc) is False
        assert is_provider_rate_limited(exc) is False

    def test_should_retry_admits_a_rate_limit_whatever_retry_on_says(self):
        """The exact mirror of the `invalid_request` refusal, and for the mirror
        reason: a 429 is the one error the provider has explicitly asked us to
        retry, and not backing off is what amplifies the incident. `max_retries`
        remains the caller's real knob."""
        from text.services.retry_handler import RATE_LIMITED_ERROR_TYPE, should_retry

        assert should_retry(RATE_LIMITED_ERROR_TYPE, [], attempt=0, max_retries=3) is True

    def test_should_retry_still_caps_a_rate_limit_at_the_attempt_ceiling(self):
        from text.services.retry_handler import RATE_LIMITED_ERROR_TYPE, should_retry

        assert should_retry(RATE_LIMITED_ERROR_TYPE, [], attempt=3, max_retries=3) is False
        assert should_retry(RATE_LIMITED_ERROR_TYPE, [], attempt=0, max_retries=0) is False

    def test_the_rate_limited_code_is_the_one_the_429_body_already_carries(self):
        """One vocabulary for the two surfaces: the blocking 429's `error_code`
        and the streaming terminal frame's `code` must be the same token, or a
        client has to learn two names for one condition."""
        from text.core.exceptions import RateLimitError
        from text.services.retry_handler import RATE_LIMITED_CODE

        assert RateLimitError().error_code == RATE_LIMITED_CODE


class TestVendorRateLimitThroughTheEndpoint:
    @pytest.mark.asyncio
    async def test_a_vendor_429_is_retried_and_then_surfaces_429_not_422(self, _app_factory):
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            side_effect=_status_error(429, message="slow down", headers={"retry-after": "2"})
        )
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
        assert resp.status_code == 429
        assert resp.json()["error_code"] == "RATE_LIMITED"
        assert resp.headers["retry-after"] == "3"  # int(2.0) + 1, per `_get_headers`
        # 1 initial + 2 retries: the budget was spent on a condition that CAN change.
        assert mock_provider.generate.call_count == 3

    @pytest.mark.asyncio
    async def test_a_vendor_429_backs_off_for_the_wait_the_vendor_asked_for(self, _app_factory):
        """`retry_after_from` was written for this case and was unreachable."""
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            side_effect=_status_error(429, headers={"retry-after": "2"})
        )
        app = _app_factory(mock_provider)
        transport = ASGITransport(app=app)
        with patch(_BACKOFF_PATCH, new_callable=AsyncMock) as slept:
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                await client.post(
                    "/api/v1/generate",
                    json={
                        "prompt": "Hello",
                        "provider": "lm-studio",
                        "model": "test-model",
                        "retry_config": {"max_retries": 1, "retry_on": ["provider_error"]},
                    },
                )
        waits = [call.args[0] for call in slept.await_args_list]
        assert len(waits) == 1
        # The vendor's 2s, jittered by at most 10% — never the computed 1s the
        # exponential would have produced for attempt 0.
        assert 2.0 <= waits[0] <= 2.2

    @pytest.mark.asyncio
    async def test_a_vendor_429_that_clears_returns_200(self, _app_factory):
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            side_effect=[
                _status_error(429, headers={"retry-after": "1"}),
                ("Recovered!", "", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}),
            ]
        )
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
        assert resp.status_code == 200
        assert resp.json()["content"] == "Recovered!"
        assert mock_provider.generate.call_count == 2

    @pytest.mark.asyncio
    async def test_a_vendor_429_without_a_retry_after_header_still_carries_one(self, _app_factory):
        """A 429 a client cannot pace against is a 429 that invites the same
        storm back. When the vendor names no deadline this error type supplies
        its own, exactly as `CircuitOpenError` and `ConcurrencyLimitError` do."""
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=_status_error(429))
        app = _app_factory(mock_provider)
        resp = await _post_generate(
            app,
            {
                "prompt": "Hello",
                "provider": "lm-studio",
                "retry_config": {"max_retries": 0, "retry_on": []},
            },
        )
        assert resp.status_code == 429
        assert int(resp.headers["retry-after"]) > 0

    @pytest.mark.asyncio
    async def test_a_vendor_400_still_surfaces_422_with_its_code(self, _app_factory):
        """The carve-out is for 429/408 ONLY — a malformed body keeps its
        unconditional refusal and its 422."""
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=_bad_request_error("bad body"))
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
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "PROVIDER_INVALID_REQUEST"
        assert mock_provider.generate.call_count == 1

    @pytest.mark.asyncio
    async def test_a_vendor_408_is_retried_and_surfaces_502(self, _app_factory):
        """408 is transient, so it is retried — but it is NOT a rate limit, so
        it answers the generic provider-failure 502 rather than a 429 nobody
        rate-limited."""
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=_status_error(408, message="too slow"))
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
        assert mock_provider.generate.call_count == 3


class TestVendorRateLimitAndTheCircuitBreaker:
    """A throttle is not evidence of ill health.

    `CircuitBreaker.record_failure(is_rate_limit=...)` and
    `LaneBudget.count_rate_limits` already existed; no call site ever set the
    flag, so the knob was unreachable and every vendor 429 counted.
    """

    @staticmethod
    def _wire(app, **breaker_kwargs):
        from text.core.runtime_defaults import USER_LANE_FLOOR
        from text.services.circuit_breaker import CircuitBreaker

        kwargs = {
            "failure_threshold": USER_LANE_FLOOR.failure_threshold,
            "count_rate_limits": USER_LANE_FLOOR.count_rate_limits,
            **breaker_kwargs,
        }
        cb = CircuitBreaker(**kwargs)
        app.state.circuit_breakers = {"lm-studio": cb}
        return cb

    @pytest.mark.asyncio
    async def test_a_vendor_429_does_not_trip_the_breaker(self, _app_factory):
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=_status_error(429))
        app = _app_factory(mock_provider)
        cb = self._wire(app)
        for _ in range(6):  # well past the default failure_threshold of 5
            resp = await _post_generate(
                app,
                {
                    "prompt": "Hello",
                    "provider": "lm-studio",
                    "retry_config": {"max_retries": 0, "retry_on": []},
                },
            )
            assert resp.status_code == 429
        assert cb.failure_count == 0
        assert cb.allow_request() is True

    @pytest.mark.asyncio
    async def test_a_vendor_500_still_trips_the_breaker(self, _app_factory):
        """The contrast that keeps the carve-out honest: a real provider failure
        is still counted."""
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=_internal_server_error("down"))
        app = _app_factory(mock_provider)
        cb = self._wire(app, failure_threshold=2)
        for _ in range(2):
            await _post_generate(
                app,
                {
                    "prompt": "Hello",
                    "provider": "lm-studio",
                    "retry_config": {"max_retries": 0, "retry_on": []},
                },
            )
        assert cb.failure_count == 2
        assert cb.allow_request() is False

    @pytest.mark.asyncio
    async def test_an_operator_can_opt_back_in_through_the_control_plane(self, _app_factory):
        """Sustained 429s DO mean the lane is unusable, and an operator who wants
        the breaker to say so sets `countRateLimits` on the runtime profile. The
        policy stays in the control plane; only the default moved."""
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(side_effect=_status_error(429))
        app = _app_factory(mock_provider)
        cb = self._wire(app, failure_threshold=2, count_rate_limits=True)
        for _ in range(2):
            await _post_generate(
                app,
                {
                    "prompt": "Hello",
                    "provider": "lm-studio",
                    "retry_config": {"max_retries": 0, "retry_on": []},
                },
            )
        assert cb.failure_count == 2
        assert cb.allow_request() is False


class TestVendorRateLimitOnTheStreamingPath:
    """The streaming producer shares the breaker dict with `/generate`, so a
    carve-out applied to only one of them is a carve-out that does not hold.
    """

    @staticmethod
    def _streaming_task_manager():
        tm = AsyncMock()
        tm.append_chunk = AsyncMock()
        tm.append_batch = AsyncMock()
        tm.update_task = AsyncMock()
        return tm

    @staticmethod
    def _rate_limited_provider():
        async def stream(_request):
            raise _status_error(429, message="slow down", headers={"retry-after": "2"})
            yield  # pragma: no cover — makes this an async generator

        provider = AsyncMock()
        provider.generate_stream = stream
        return provider

    @pytest.mark.asyncio
    async def test_the_terminal_frame_carries_the_rate_limited_code(self):
        from text.core.runtime_defaults import USER_LANE_FLOOR
        from text.models.requests import GenerateRequest
        from text.routing.streaming import _run_streaming_generation
        from text.services.circuit_breaker import CircuitBreaker

        tm = self._streaming_task_manager()
        cb = CircuitBreaker(
            failure_threshold=USER_LANE_FLOOR.failure_threshold,
            count_rate_limits=USER_LANE_FLOOR.count_rate_limits,
        )
        await _run_streaming_generation(
            tm,
            self._rate_limited_provider(),
            "task-429",
            GenerateRequest(prompt="p", provider="lm-studio", model="m", stream=True),
            provider_name="lm-studio",
            model="m",
            tenant_id="t",
            circuit_breakers={"lm-studio": cb},
        )
        chunks = [call.args[1] for call in tm.append_chunk.await_args_list]
        assert [c.type for c in chunks] == ["error"]
        assert (chunks[0].data or {})["code"] == "RATE_LIMITED"

    @pytest.mark.asyncio
    async def test_a_vendor_429_does_not_trip_the_breaker_on_the_streaming_path(self):
        from text.core.runtime_defaults import USER_LANE_FLOOR
        from text.models.requests import GenerateRequest
        from text.routing.streaming import _run_streaming_generation
        from text.services.circuit_breaker import CircuitBreaker

        cb = CircuitBreaker(
            failure_threshold=USER_LANE_FLOOR.failure_threshold,
            count_rate_limits=USER_LANE_FLOOR.count_rate_limits,
        )
        for index in range(6):
            await _run_streaming_generation(
                self._streaming_task_manager(),
                self._rate_limited_provider(),
                f"task-429-{index}",
                GenerateRequest(prompt="p", provider="lm-studio", model="m", stream=True),
                provider_name="lm-studio",
                model="m",
                tenant_id="t",
                circuit_breakers={"lm-studio": cb},
            )
        assert cb.failure_count == 0
        assert cb.allow_request() is True
