"""TDD tests for the expanded exception hierarchy and FastAPI exception handler.

RED: Written before implementation.
Tests cover:
  - Exception model correctness (inheritance, error_codes, attributes)
  - Exception handler HTTP mapping (status codes, headers, body)
  - Endpoint integration (generate raises domain exceptions)
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from text.core.config import Settings
from text.core.exceptions import (
    CircuitOpenError,
    ConcurrencyLimitError,
    ContentBlockedError,
    InputValidationError,
    ModelNotSelectedError,
    PoolUnhealthyError,
    ProviderError,
    ProviderNotFoundError,
    ProviderTimeoutError,
    QueueFullError,
    QueueTimeoutError,
    RateLimitError,
    ShutdownError,
    TextError,
)
from text.models.task import TaskState, TaskStatus
from text.providers.base import ProviderRegistry

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_ALL_EXCEPTIONS: list[tuple[type[TextError], str]] = [
    (TextError, "INTERNAL_ERROR"),
    (ProviderError, "PROVIDER_ERROR"),
    (ProviderTimeoutError, "PROVIDER_TIMEOUT"),
    (RateLimitError, "RATE_LIMITED"),
    (InputValidationError, "VALIDATION_ERROR"),
    (CircuitOpenError, "CIRCUIT_OPEN"),
    (QueueFullError, "QUEUE_FULL"),
    (QueueTimeoutError, "QUEUE_TIMEOUT"),
    (ShutdownError, "SHUTTING_DOWN"),
    (ConcurrencyLimitError, "CONCURRENCY_LIMIT"),
    (ContentBlockedError, "CONTENT_BLOCKED"),
    (ProviderNotFoundError, "PROVIDER_NOT_FOUND"),
    (ModelNotSelectedError, "MODEL_NOT_SELECTED"),
    (PoolUnhealthyError, "POOL_UNHEALTHY"),
]


def _make_provider(*, generate_exc=None):
    p = AsyncMock()
    if generate_exc:
        p.generate = AsyncMock(side_effect=generate_exc)
    else:
        p.generate = AsyncMock(
            return_value=("ok", "", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})
        )
    p.health_check = AsyncMock(return_value=True)
    p.get_info = AsyncMock()
    return p


def _make_task_manager():
    tm = AsyncMock()
    tm.create_task = AsyncMock(
        return_value=TaskState(task_id="t-1", status=TaskStatus.PENDING, provider="test", model="m")
    )
    tm.update_task = AsyncMock(
        return_value=TaskState(task_id="t-1", status=TaskStatus.RUNNING, provider="test", model="m")
    )
    tm.get_task = AsyncMock(
        return_value=TaskState(
            task_id="t-1", status=TaskStatus.COMPLETED, provider="test", model="m"
        )
    )
    tm.cancel_task = AsyncMock(return_value=None)
    tm.get_chunks = AsyncMock(return_value=[])
    tm.append_chunk = AsyncMock()
    return tm


def _build_app(settings, registry, task_manager, *, shutdown_manager=None):
    from text.main import create_app

    app = create_app(settings_override=settings)
    app.state.provider_registry = registry
    app.state.task_manager = task_manager
    app.state.settings = settings
    if shutdown_manager is not None:
        app.state.shutdown_manager = shutdown_manager
    return app


@pytest.fixture
def settings():
    return Settings(
        host="127.0.0.1", port=5099, debug=True, log_level="debug", metrics_enabled=False
    )


# ===========================================================================
# Part 1 — Exception model tests
# ===========================================================================


class TestExceptionInheritance:
    @pytest.mark.parametrize("exc_cls,_code", _ALL_EXCEPTIONS)
    def test_all_exceptions_inherit_from_text_error(self, exc_cls, _code):
        assert issubclass(exc_cls, TextError)


class TestExceptionErrorCodes:
    @pytest.mark.parametrize("exc_cls,expected_code", _ALL_EXCEPTIONS)
    def test_exception_error_codes(self, exc_cls, expected_code):
        if exc_cls in (TextError, InputValidationError, ContentBlockedError, ShutdownError):
            exc = exc_cls("test")
        elif exc_cls in (
            ProviderError,
            ProviderTimeoutError,
            ProviderNotFoundError,
            CircuitOpenError,
            QueueFullError,
            QueueTimeoutError,
            ConcurrencyLimitError,
            PoolUnhealthyError,
        ):
            exc = exc_cls("test", provider="p")
        elif exc_cls is RateLimitError:
            exc = exc_cls("test", retry_after=10.0)
        else:
            exc = exc_cls("test")
        assert exc.error_code == expected_code


class TestExceptionAttributes:
    def test_rate_limit_error_has_retry_after(self):
        exc = RateLimitError(retry_after=42.5)
        assert exc.retry_after == 42.5

    def test_rate_limit_error_retry_after_none_by_default(self):
        exc = RateLimitError()
        assert exc.retry_after is None

    def test_circuit_open_error_has_provider(self):
        exc = CircuitOpenError(provider="azure")
        assert exc.provider == "azure"

    def test_queue_full_error_has_provider(self):
        exc = QueueFullError(provider="ollama")
        assert exc.provider == "ollama"

    def test_concurrency_limit_error_has_provider(self):
        exc = ConcurrencyLimitError(provider="bedrock")
        assert exc.provider == "bedrock"

    def test_exception_message_preserved(self):
        exc = TextError("custom message")
        assert exc.message == "custom message"
        assert str(exc) == "custom message"

    def test_provider_not_found_has_provider(self):
        exc = ProviderNotFoundError("not there", provider="ghost")
        assert exc.provider == "ghost"
        assert exc.message == "not there"

    def test_shutdown_error_default_message(self):
        exc = ShutdownError()
        assert exc.message == "Service is shutting down"

    def test_content_blocked_error_default_message(self):
        exc = ContentBlockedError()
        assert exc.message == "Content blocked by safety filter"


# ===========================================================================
# Part 2 — Exception handler tests
# ===========================================================================


class TestExceptionHandlerStatusCodes:
    @pytest.mark.asyncio
    async def test_handler_returns_correct_status_for_rate_limit(self):
        from text.core.exception_handlers import text_exception_handler

        exc = RateLimitError("too fast", retry_after=10.0)
        resp = await text_exception_handler(MagicMock(), exc)
        assert resp.status_code == 429

    @pytest.mark.asyncio
    async def test_handler_returns_correct_status_for_circuit_open(self):
        from text.core.exception_handlers import text_exception_handler

        exc = CircuitOpenError(provider="azure")
        resp = await text_exception_handler(MagicMock(), exc)
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_handler_returns_correct_status_for_provider_error(self):
        from text.core.exception_handlers import text_exception_handler

        exc = ProviderError("boom", provider="ollama")
        resp = await text_exception_handler(MagicMock(), exc)
        assert resp.status_code == 502

    @pytest.mark.asyncio
    async def test_handler_returns_correct_status_for_shutdown(self):
        from text.core.exception_handlers import text_exception_handler

        exc = ShutdownError()
        resp = await text_exception_handler(MagicMock(), exc)
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_handler_returns_correct_status_for_not_found(self):
        from text.core.exception_handlers import text_exception_handler

        exc = ProviderNotFoundError("nope", provider="ghost")
        resp = await text_exception_handler(MagicMock(), exc)
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_handler_returns_correct_status_for_validation(self):
        from text.core.exception_handlers import text_exception_handler

        exc = InputValidationError("bad input")
        resp = await text_exception_handler(MagicMock(), exc)
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_handler_returns_correct_status_for_content_blocked(self):
        from text.core.exception_handlers import text_exception_handler

        exc = ContentBlockedError()
        resp = await text_exception_handler(MagicMock(), exc)
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_handler_returns_correct_status_for_model_not_selected(self):
        """A cloud provider raising ModelNotSelectedError (no model
        resolved — never a substituted vendor default) maps to 422, same as
        InputValidationError (its parent)."""
        from text.core.exception_handlers import text_exception_handler

        exc = ModelNotSelectedError("no model", provider="azure_openai")
        resp = await text_exception_handler(MagicMock(), exc)
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_handler_returns_correct_status_for_queue_full(self):
        from text.core.exception_handlers import text_exception_handler

        exc = QueueFullError(provider="ollama")
        resp = await text_exception_handler(MagicMock(), exc)
        assert resp.status_code == 429

    @pytest.mark.asyncio
    async def test_handler_returns_correct_status_for_queue_timeout(self):
        from text.core.exception_handlers import text_exception_handler

        exc = QueueTimeoutError(provider="ollama")
        resp = await text_exception_handler(MagicMock(), exc)
        assert resp.status_code == 429

    @pytest.mark.asyncio
    async def test_handler_returns_correct_status_for_concurrency_limit(self):
        from text.core.exception_handlers import text_exception_handler

        exc = ConcurrencyLimitError(provider="bedrock")
        resp = await text_exception_handler(MagicMock(), exc)
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_handler_returns_correct_status_for_provider_timeout(self):
        from text.core.exception_handlers import text_exception_handler

        exc = ProviderTimeoutError(provider="azure")
        resp = await text_exception_handler(MagicMock(), exc)
        assert resp.status_code == 502

    @pytest.mark.asyncio
    async def test_handler_returns_500_for_base_text_error(self):
        from text.core.exception_handlers import text_exception_handler

        exc = TextError("generic")
        resp = await text_exception_handler(MagicMock(), exc)
        assert resp.status_code == 500


class TestExceptionHandlerHeaders:
    @pytest.mark.asyncio
    async def test_handler_returns_retry_after_header_for_rate_limit(self):
        from text.core.exception_handlers import text_exception_handler

        exc = RateLimitError("slow down", retry_after=9.2)
        resp = await text_exception_handler(MagicMock(), exc)
        assert resp.headers.get("retry-after") == "10"

    @pytest.mark.asyncio
    async def test_handler_returns_retry_after_header_for_circuit_open(self):
        from text.core.exception_handlers import text_exception_handler

        exc = CircuitOpenError(provider="azure")
        resp = await text_exception_handler(MagicMock(), exc)
        assert resp.headers.get("retry-after") == "30"

    @pytest.mark.asyncio
    async def test_handler_returns_retry_after_header_for_concurrency_limit(self):
        from text.core.exception_handlers import text_exception_handler

        exc = ConcurrencyLimitError(provider="bedrock")
        resp = await text_exception_handler(MagicMock(), exc)
        assert resp.headers.get("retry-after") == "5"

    @pytest.mark.asyncio
    async def test_handler_no_retry_after_for_provider_error(self):
        from text.core.exception_handlers import text_exception_handler

        exc = ProviderError("boom", provider="ollama")
        resp = await text_exception_handler(MagicMock(), exc)
        assert "retry-after" not in resp.headers


class TestExceptionHandlerBody:
    @pytest.mark.asyncio
    async def test_handler_response_includes_error_code(self):
        import json

        from text.core.exception_handlers import text_exception_handler

        exc = CircuitOpenError(provider="azure")
        resp = await text_exception_handler(MagicMock(), exc)
        body = json.loads(resp.body.decode())
        assert body["error_code"] == "CIRCUIT_OPEN"
        assert body["detail"] == "Service temporarily unavailable"

    @pytest.mark.asyncio
    async def test_handler_response_includes_detail_message(self):
        import json

        from text.core.exception_handlers import text_exception_handler

        exc = ProviderError("GPU OOM", provider="ollama")
        resp = await text_exception_handler(MagicMock(), exc)
        body = json.loads(resp.body.decode())
        assert body["detail"] == "GPU OOM"
        assert body["error_code"] == "PROVIDER_ERROR"


class TestExceptionHandlerRegistration:
    def test_handler_registered_on_app(self, settings):
        from text.main import create_app

        app = create_app(settings_override=settings)
        handlers = app.exception_handlers
        assert TextError in handlers


# ===========================================================================
# Part 3 — Endpoint integration tests
# ===========================================================================


class TestGenerateEndpointDomainExceptions:
    @pytest.mark.asyncio
    async def test_generate_raises_shutdown_error(self, settings):
        """Shutdown state triggers ShutdownError -> 503 with error_code."""
        registry = ProviderRegistry()
        registry.register("ollama", _make_provider())
        sm = MagicMock()
        sm.is_shutting_down = True
        app = _build_app(settings, registry, _make_task_manager(), shutdown_manager=sm)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/api/v1/generate",
                json={"prompt": "hi", "provider": "ollama", "model": "test-model"},
            )
        assert resp.status_code == 503
        body = resp.json()
        assert body["error_code"] == "SHUTTING_DOWN"

    @pytest.mark.asyncio
    async def test_generate_raises_circuit_open_error(self, settings):
        """Open circuit triggers CircuitOpenError -> 503 with Retry-After."""
        from text.services.circuit_breaker import CircuitBreaker

        registry = ProviderRegistry()
        registry.register("ollama", _make_provider())

        cb = MagicMock(spec=CircuitBreaker)
        cb.allow_request.return_value = False
        cb.state = MagicMock()

        app = _build_app(settings, registry, _make_task_manager())
        app.state.circuit_breakers = {"ollama": cb}
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/api/v1/generate",
                json={"prompt": "hi", "provider": "ollama", "model": "test-model"},
            )
        assert resp.status_code == 503
        assert resp.headers.get("retry-after") == "30"
        body = resp.json()
        assert body["error_code"] == "CIRCUIT_OPEN"

    @pytest.mark.asyncio
    async def test_generate_raises_provider_not_found_error(self, settings):
        """Unknown provider triggers ProviderNotFoundError -> 404."""
        registry = ProviderRegistry()
        app = _build_app(settings, registry, _make_task_manager())
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/api/v1/generate",
                json={"prompt": "hi", "provider": "ghost", "model": "test-model"},
            )
        assert resp.status_code == 404
        body = resp.json()
        assert body["error_code"] == "PROVIDER_NOT_FOUND"
