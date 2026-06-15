"""TDD tests for error sanitization (Task 1.5) and protocol contract fix (Task 1.7).

RED: Written before implementation.

Task 1.5 — Error responses must NOT leak internal details (URLs, API keys,
stack traces) to the client.  Server-side logging should still capture the
full exception.

Task 1.7 — LLMProvider.generate() Protocol return type must be
tuple[str, dict] to match all concrete implementations.
"""

from __future__ import annotations

from typing import get_type_hints
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from smr_v2.models.stream import StreamChunk
from smr_v2.models.task import TaskState, TaskStatus
from smr_v2.providers.base import ProviderRegistry

# ── Helpers ──

SENSITIVE_ERROR = (
    "Connection to https://internal-api.example.com:8443 failed, "
    "api_key=sk-secret123, traceback: File '/app/smr_v2/providers/azure.py'"
)

SENSITIVE_FRAGMENTS = [
    "internal-api.example.com",
    "sk-secret123",
    "8443",
    "/app/smr_v2/providers/azure.py",
]


def _make_provider(*, generate_exc=None):
    p = AsyncMock()
    if generate_exc:
        p.generate = AsyncMock(side_effect=generate_exc)
    else:
        p.generate = AsyncMock(
            return_value=("ok", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})
        )
    p.health_check = AsyncMock(return_value=True)
    p.get_info = AsyncMock(
        return_value=MagicMock(name="test", display_name="Test", status="available")
    )
    return p


def _make_task_manager():
    tm = AsyncMock()
    tm.create_task = AsyncMock(
        return_value=TaskState(
            task_id="t-err-1", status=TaskStatus.PENDING, provider="test", model="m"
        )
    )
    tm.update_task = AsyncMock()
    tm.append_chunk = AsyncMock()
    return tm


def _build_app(registry, task_manager):
    from smr_v2.main import create_app

    app = create_app()
    app.state.provider_registry = registry
    app.state.task_manager = task_manager
    return app


# ═══════════════════════════════════════════════════════════════════════════
# Task 1.5 — Error Sanitization
# ═══════════════════════════════════════════════════════════════════════════


class TestSyncGenerateErrorSanitization:
    """Sync /generate must return a generic error, never leak internals."""

    @pytest_asyncio.fixture
    async def setup(self):
        registry = ProviderRegistry()
        provider = _make_provider(generate_exc=RuntimeError(SENSITIVE_ERROR))
        registry.register("leaky", provider)
        tm = _make_task_manager()
        app = _build_app(registry, tm)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/api/v1/generate", json={"prompt": "hello", "provider": "leaky", "model": "test-model"}
            )
            yield resp, tm

    @pytest.mark.asyncio
    async def test_generate_error_does_not_leak_details(self, setup):
        resp, _ = setup
        assert resp.status_code == 502
        detail = resp.json()["detail"]
        for fragment in SENSITIVE_FRAGMENTS:
            assert fragment not in detail, f"Leaked sensitive fragment: {fragment!r}"

    @pytest.mark.asyncio
    async def test_generate_error_returns_generic_message(self, setup):
        resp, _ = setup
        assert resp.status_code == 502
        detail = resp.json()["detail"]
        assert "internal error" in detail.lower()

    @pytest.mark.asyncio
    async def test_task_manager_still_receives_full_error(self, setup):
        """Server-side task record should keep the full error for debugging."""
        _, tm = setup
        update_calls = [
            c for c in tm.update_task.call_args_list if c.kwargs.get("error")
        ]
        assert len(update_calls) >= 1
        stored_error = update_calls[-1].kwargs["error"]
        assert "sk-secret123" in stored_error


class TestStreamingErrorSanitization:
    """Streaming error chunks must NOT leak internal details."""

    @pytest.mark.asyncio
    async def test_streaming_error_chunk_does_not_leak_details(self):
        from smr_v2.api.endpoints.generate import _run_streaming_generation
        from smr_v2.models.requests import GenerateRequest

        tm = AsyncMock()
        tm.update_task = AsyncMock()
        tm.append_chunk = AsyncMock()

        provider = AsyncMock()

        async def _failing_stream(req):
            yield StreamChunk(type="chunk", content="partial")
            raise RuntimeError(SENSITIVE_ERROR)

        provider.generate_stream = _failing_stream

        req = GenerateRequest(prompt="hi", stream=True)
        await _run_streaming_generation(tm, provider, "t-stream-1", req)

        error_calls = [
            c for c in tm.append_chunk.call_args_list if c.args[1].type == "error"
        ]
        assert len(error_calls) == 1
        error_msg = error_calls[0].args[1].data["error"]
        for fragment in SENSITIVE_FRAGMENTS:
            assert fragment not in error_msg, f"Leaked in stream error: {fragment!r}"
        assert "internal error" in error_msg.lower()

    @pytest.mark.asyncio
    async def test_streaming_task_manager_receives_full_error(self):
        """Server-side task record should keep the full error for debugging."""
        from smr_v2.api.endpoints.generate import _run_streaming_generation
        from smr_v2.models.requests import GenerateRequest

        tm = AsyncMock()
        tm.update_task = AsyncMock()
        tm.append_chunk = AsyncMock()

        provider = AsyncMock()

        async def _failing_stream(req):
            raise RuntimeError(SENSITIVE_ERROR)
            yield  # make it an async generator

        provider.generate_stream = _failing_stream

        req = GenerateRequest(prompt="hi", stream=True)
        await _run_streaming_generation(tm, provider, "t-stream-2", req)

        failed_calls = [
            c
            for c in tm.update_task.call_args_list
            if c.kwargs.get("status") == TaskStatus.FAILED
        ]
        assert len(failed_calls) == 1
        assert "sk-secret123" in failed_calls[0].kwargs["error"]


# ═══════════════════════════════════════════════════════════════════════════
# Task 1.5 — Exception Hierarchy
# ═══════════════════════════════════════════════════════════════════════════


class TestExceptionHierarchy:
    """Custom exception classes have correct attributes and inheritance."""

    def test_smr_error_base(self):
        from smr_v2.core.exceptions import SmrError

        err = SmrError("boom")
        assert err.message == "boom"
        assert err.error_code == "INTERNAL_ERROR"
        assert str(err) == "boom"

    def test_provider_error(self):
        from smr_v2.core.exceptions import ProviderError

        err = ProviderError("timeout", provider="azure")
        assert err.error_code == "PROVIDER_ERROR"
        assert err.provider == "azure"
        assert isinstance(err, Exception)

    def test_provider_timeout_error(self):
        from smr_v2.core.exceptions import ProviderTimeoutError

        err = ProviderTimeoutError(provider="bedrock")
        assert err.error_code == "PROVIDER_TIMEOUT"
        assert err.provider == "bedrock"
        assert err.message == "Request timed out"

    def test_rate_limit_error(self):
        from smr_v2.core.exceptions import RateLimitError

        err = RateLimitError(retry_after=30.0)
        assert err.error_code == "RATE_LIMITED"
        assert err.retry_after == 30.0

    def test_input_validation_error(self):
        from smr_v2.core.exceptions import InputValidationError

        err = InputValidationError("bad input")
        assert err.error_code == "VALIDATION_ERROR"
        assert err.message == "bad input"

    def test_inheritance_chain(self):
        from smr_v2.core.exceptions import (
            InputValidationError,
            ProviderError,
            ProviderTimeoutError,
            RateLimitError,
            SmrError,
        )

        assert issubclass(ProviderError, SmrError)
        assert issubclass(ProviderTimeoutError, ProviderError)
        assert issubclass(RateLimitError, SmrError)
        assert issubclass(InputValidationError, SmrError)


# ═══════════════════════════════════════════════════════════════════════════
# Task 1.7 — Protocol Contract Fix
# ═══════════════════════════════════════════════════════════════════════════


class TestProtocolContract:
    """LLMProvider.generate() return type must be tuple[str, dict]."""

    def test_protocol_accepts_tuple_return(self):
        from smr_v2.providers.base import LLMProvider

        class _FakeProvider:
            async def generate(self, request) -> tuple[str, dict]:
                return "text", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

            async def generate_stream(self, request):
                yield  # pragma: no cover

            async def get_info(self):
                return None  # pragma: no cover

            async def health_check(self):
                return True  # pragma: no cover

        assert isinstance(_FakeProvider(), LLMProvider)

    def test_protocol_signature_matches_implementations(self):
        from smr_v2.providers.base import LLMProvider

        hints = get_type_hints(LLMProvider.generate)
        assert hints["return"] == tuple[str, dict], (
            f"Expected tuple[str, dict], got {hints['return']}"
        )
