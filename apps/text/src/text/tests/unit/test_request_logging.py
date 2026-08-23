"""TDD tests for request lifecycle logging (Task 2.4) and generation audit (Task 2.5).

Tests cover:
- RequestLoggingMiddleware: start, complete, failed events with latency
- GenerationAuditLogger: structured audit events for HIPAA compliance
- End-to-end endpoint integration for generation audit

RED: Written before implementation.
"""

from __future__ import annotations

import dataclasses
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
import structlog.contextvars
import structlog.testing
from httpx import ASGITransport, AsyncClient

from text.core.config import Settings
from text.models.task import TaskState, TaskStatus
from text.providers.base import ProviderRegistry

# ── Shared fixtures ──


@pytest.fixture(autouse=True)
def _reset_structlog():
    """Reset structlog so capture_logs() can intercept cached loggers.

    Other test modules may call setup_logging() which sets
    cache_logger_on_first_use=True, making module-level loggers
    immune to capture_logs(). We force-reset and disable caching.
    """
    structlog.reset_defaults()
    structlog.configure(cache_logger_on_first_use=False)
    structlog.contextvars.clear_contextvars()
    yield
    structlog.contextvars.clear_contextvars()
    structlog.reset_defaults()


def _make_settings(**overrides) -> Settings:
    defaults = {
        "port": 5099,
        "log_level": "debug",
    }
    defaults.update(overrides)
    return Settings(**defaults)


@pytest.fixture
def mock_provider_registry():
    registry = ProviderRegistry()
    mock_provider = AsyncMock()
    mock_provider.generate = AsyncMock(
        return_value=(
            "Generated text!",
            "",
            {"prompt_tokens": 15, "completion_tokens": 25, "total_tokens": 40},
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
            task_id="task-gen-audit-1",
            status=TaskStatus.PENDING,
            provider="ollama",
            model="llama3.2:latest",
        )
    )
    tm.update_task = AsyncMock(
        return_value=TaskState(
            task_id="task-gen-audit-1",
            status=TaskStatus.RUNNING,
            provider="ollama",
            model="llama3.2:latest",
        )
    )
    return tm


@pytest_asyncio.fixture
async def app(mock_provider_registry, mock_task_manager):
    from text.main import create_app

    settings = _make_settings()
    application = create_app(settings_override=settings)
    application.state.provider_registry = mock_provider_registry
    application.state.task_manager = mock_task_manager
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ═══════════════════════════════════════════════════════════════════════════
# Task 2.4 — RequestLoggingMiddleware
# ═══════════════════════════════════════════════════════════════════════════


class TestRequestStartLogged:
    """request.start event is emitted at the beginning of every request."""

    @pytest.mark.asyncio
    async def test_request_start_logged(self, client):
        with structlog.testing.capture_logs() as cap_logs:
            await client.get("/api/v1/health")

        start_logs = [log_line for log_line in cap_logs if log_line.get("event") == "request.start"]
        assert (
            len(start_logs) >= 1
        ), f"Expected request.start, got events: {[log_line.get('event') for log_line in cap_logs]}"
        assert start_logs[0]["method"] == "GET"
        assert start_logs[0]["path"] == "/api/v1/health"


class TestRequestCompleteLogged:
    """request.complete event is emitted when a request finishes successfully."""

    @pytest.mark.asyncio
    async def test_request_complete_logged(self, client):
        with structlog.testing.capture_logs() as cap_logs:
            resp = await client.get("/api/v1/health")

        assert resp.status_code == 200
        complete_logs = [
            log_line for log_line in cap_logs if log_line.get("event") == "request.complete"
        ]
        assert (
            len(complete_logs) >= 1
        ), f"Expected request.complete, got events: {[log_line.get('event') for log_line in cap_logs]}"
        log = complete_logs[0]
        assert log["method"] == "GET"
        assert log["path"] == "/api/v1/health"
        assert log["status_code"] == 200
        assert "duration_ms" in log


class TestRequestFailedLogged:
    """request.failed event is emitted when an unhandled exception occurs."""

    @pytest.mark.asyncio
    async def test_request_failed_logged(self, app):
        @app.get("/api/v1/_test_explode")
        async def _explode():
            raise RuntimeError("boom")

        transport = ASGITransport(app=app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            with structlog.testing.capture_logs() as cap_logs:
                _resp = await c.get("/api/v1/_test_explode")

        failed_logs = [
            log_line for log_line in cap_logs if log_line.get("event") == "request.failed"
        ]
        assert (
            len(failed_logs) >= 1
        ), f"Expected request.failed, got events: {[log_line.get('event') for log_line in cap_logs]}"
        log = failed_logs[0]
        assert log["method"] == "GET"
        assert log["path"] == "/api/v1/_test_explode"
        assert "duration_ms" in log
        assert log["error"] == "boom"
        assert log["error_type"] == "RuntimeError"


class TestDurationMsPositive:
    """duration_ms in request.complete must be a positive number."""

    @pytest.mark.asyncio
    async def test_duration_ms_is_positive(self, client):
        with structlog.testing.capture_logs() as cap_logs:
            await client.get("/api/v1/health")

        complete_logs = [
            log_line for log_line in cap_logs if log_line.get("event") == "request.complete"
        ]
        assert len(complete_logs) >= 1
        assert complete_logs[0]["duration_ms"] > 0


class TestLoggingIncludesRequestId:
    """Logs emitted by RequestLoggingMiddleware include request_id from contextvars.

    structlog.testing.capture_logs() replaces the processor chain, so
    merge_contextvars never runs.  Instead we verify that the contextvars
    contain request_id during middleware execution by capturing them inside
    an endpoint handler that runs within the middleware stack.
    """

    @pytest.mark.asyncio
    async def test_logging_includes_request_id(self, app):
        captured_ctx: dict = {}

        @app.get("/api/v1/_test_logging_ctx")
        async def _capture_ctx():
            captured_ctx.update(structlog.contextvars.get_contextvars())
            return {"ok": True}

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            with structlog.testing.capture_logs() as cap_logs:
                resp = await c.get(
                    "/api/v1/_test_logging_ctx",
                    headers={"X-Request-ID": "trace-abc-789"},
                )

        assert resp.status_code == 200
        assert captured_ctx.get("request_id") == "trace-abc-789"

        start_logs = [log_line for log_line in cap_logs if log_line.get("event") == "request.start"]
        assert len(start_logs) >= 1


# ═══════════════════════════════════════════════════════════════════════════
# Task 2.5 — GenerationAuditLogger
# ═══════════════════════════════════════════════════════════════════════════


class TestGenerationAuditEventFields:
    """GenerationAuditEvent dataclass has every required field."""

    def test_generation_audit_event_has_all_fields(self):
        from text.services.generation_audit import GenerationAuditEvent

        field_names = {f.name for f in dataclasses.fields(GenerationAuditEvent)}
        required = {
            "request_id",
            "timestamp",
            "provider",
            "model",
            "status",
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "latency_ms",
            "finish_reason",
            "error",
        }
        assert required.issubset(field_names), f"Missing: {required - field_names}"


class TestSuccessfulGenerationAudit:
    """Successful generation emits audit at INFO level."""

    def test_successful_generation_emits_audit(self):
        from text.services.generation_audit import GenerationAuditEvent, GenerationAuditLogger

        logger = GenerationAuditLogger()
        event = GenerationAuditEvent(
            request_id="req-001",
            timestamp="2026-02-28T12:00:00Z",
            provider="ollama",
            model="llama3.2:latest",
            status="completed",
            prompt_tokens=15,
            completion_tokens=25,
            total_tokens=40,
            latency_ms=350,
            finish_reason="stop",
        )

        with structlog.testing.capture_logs() as cap_logs:
            logger.log_generation(event)

        audit_logs = [log_line for log_line in cap_logs if log_line["event"] == "generation.audit"]
        assert len(audit_logs) == 1
        assert audit_logs[0]["log_level"] == "info"


class TestFailedGenerationAudit:
    """Failed generation emits audit at ERROR level."""

    def test_failed_generation_emits_audit(self):
        from text.services.generation_audit import GenerationAuditEvent, GenerationAuditLogger

        logger = GenerationAuditLogger()
        event = GenerationAuditEvent(
            request_id="req-002",
            timestamp="2026-02-28T12:01:00Z",
            provider="azure",
            model="gpt-4o",
            status="failed",
            prompt_tokens=10,
            completion_tokens=0,
            total_tokens=10,
            latency_ms=1200,
            finish_reason="error",
            error="Provider timeout",
        )

        with structlog.testing.capture_logs() as cap_logs:
            logger.log_generation(event)

        audit_logs = [log_line for log_line in cap_logs if log_line["event"] == "generation.audit"]
        assert len(audit_logs) == 1
        assert audit_logs[0]["log_level"] == "error"
        assert audit_logs[0]["error"] == "Provider timeout"


class TestAuditIncludesTokenCounts:
    """Audit event includes prompt_tokens, completion_tokens, total_tokens."""

    def test_audit_includes_token_counts(self):
        from text.services.generation_audit import GenerationAuditEvent, GenerationAuditLogger

        logger = GenerationAuditLogger()
        event = GenerationAuditEvent(
            request_id="req-003",
            timestamp="2026-02-28T12:02:00Z",
            provider="ollama",
            model="llama3.2:latest",
            status="completed",
            prompt_tokens=100,
            completion_tokens=200,
            total_tokens=300,
            latency_ms=500,
            finish_reason="stop",
        )

        with structlog.testing.capture_logs() as cap_logs:
            logger.log_generation(event)

        audit_logs = [log_line for log_line in cap_logs if log_line["event"] == "generation.audit"]
        assert len(audit_logs) == 1
        assert audit_logs[0]["prompt_tokens"] == 100
        assert audit_logs[0]["completion_tokens"] == 200
        assert audit_logs[0]["total_tokens"] == 300


class TestAuditIncludesLatency:
    """Audit event includes latency_ms."""

    def test_audit_includes_latency(self):
        from text.services.generation_audit import GenerationAuditEvent, GenerationAuditLogger

        logger = GenerationAuditLogger()
        event = GenerationAuditEvent(
            request_id="req-004",
            timestamp="2026-02-28T12:03:00Z",
            provider="bedrock",
            model="claude-3-sonnet",
            status="completed",
            prompt_tokens=50,
            completion_tokens=75,
            total_tokens=125,
            latency_ms=800,
            finish_reason="stop",
        )

        with structlog.testing.capture_logs() as cap_logs:
            logger.log_generation(event)

        audit_logs = [log_line for log_line in cap_logs if log_line["event"] == "generation.audit"]
        assert len(audit_logs) == 1
        assert audit_logs[0]["latency_ms"] == 800


class TestEndpointEmitsGenerationAudit:
    """POST /generate emits a generation.audit event end-to-end."""

    @pytest_asyncio.fixture
    async def gen_client(self, mock_provider_registry, mock_task_manager):
        from text.main import create_app

        settings = _make_settings()
        application = create_app(settings_override=settings)
        application.state.provider_registry = mock_provider_registry
        application.state.task_manager = mock_task_manager
        transport = ASGITransport(app=application)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_endpoint_emits_generation_audit(self, gen_client):
        with structlog.testing.capture_logs() as cap_logs:
            resp = await gen_client.post(
                "/api/v1/generate",
                json={
                    "prompt": "Summarize the clinical transcript.",
                    "provider": "ollama",
                    "model": "test-model",
                    "stream": False,
                },
            )

        assert resp.status_code == 200

        audit_logs = [
            log_line for log_line in cap_logs if log_line.get("event") == "generation.audit"
        ]
        assert (
            len(audit_logs) >= 1
        ), f"Expected generation.audit, got events: {[log_line.get('event') for log_line in cap_logs]}"

        evt = audit_logs[0]
        assert evt["provider"] == "ollama"
        assert evt["status"] == "completed"
        assert evt["prompt_tokens"] == 15
        assert evt["completion_tokens"] == 25
        assert evt["total_tokens"] == 40
        assert evt["latency_ms"] >= 0
        assert evt["finish_reason"] == "stop"
        assert evt.get("error") is None
