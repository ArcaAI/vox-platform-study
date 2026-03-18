"""TDD tests for guardrail audit logging (Task 1.13).

Tests cover:
- GuardrailAuditEvent dataclass field completeness
- Structured audit log emission at correct levels (INFO/WARNING/ERROR)
- Request ID propagation from structlog contextvars
- Scan duration tracking
- Provider/model inclusion
- End-to-end endpoint integration

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

from smr_v2.core.config import Settings
from smr_v2.models.task import TaskState, TaskStatus
from smr_v2.providers.base import ProviderRegistry


# ── Fixtures ──


@pytest.fixture
def _clean_contextvars():
    """Ensure structlog contextvars are cleared before and after each test."""
    structlog.contextvars.clear_contextvars()
    yield
    structlog.contextvars.clear_contextvars()


@pytest.fixture
def audit_logger():
    from smr_v2.services.audit import GuardrailAuditLogger

    return GuardrailAuditLogger()


@pytest.fixture
def clean_audit_event():
    from smr_v2.services.audit import GuardrailAuditEvent

    return GuardrailAuditEvent(
        request_id="req-abc-123",
        timestamp="2026-02-28T10:00:00Z",
        guardrail_type="prompt_injection_scan",
        action="allowed",
        is_suspicious=False,
        risk_level="none",
        matched_patterns=[],
        provider="ollama",
        model="llama3.2:latest",
        scan_duration_ms=1.5,
    )


@pytest.fixture
def suspicious_audit_event():
    from smr_v2.services.audit import GuardrailAuditEvent

    return GuardrailAuditEvent(
        request_id="req-def-456",
        timestamp="2026-02-28T10:01:00Z",
        guardrail_type="prompt_injection_scan",
        action="logged",
        is_suspicious=True,
        risk_level="medium",
        matched_patterns=["system_prompt_override"],
        provider="azure",
        model="gpt-4o",
        scan_duration_ms=2.3,
    )


@pytest.fixture
def blocked_audit_event():
    from smr_v2.services.audit import GuardrailAuditEvent

    return GuardrailAuditEvent(
        request_id="req-ghi-789",
        timestamp="2026-02-28T10:02:00Z",
        guardrail_type="prompt_injection_scan",
        action="blocked",
        is_suspicious=True,
        risk_level="high",
        matched_patterns=["instruction_injection", "data_exfiltration"],
        provider="ollama",
        model="llama3.2:latest",
        scan_duration_ms=0.8,
    )


@pytest.fixture
def mock_provider_registry():
    registry = ProviderRegistry()
    mock_provider = AsyncMock()
    mock_provider.generate = AsyncMock(
        return_value=(
            "Generated text!",
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
            task_id="task-audit-1",
            status=TaskStatus.PENDING,
            provider="ollama",
            model="llama3.2:latest",
        )
    )
    tm.update_task = AsyncMock(
        return_value=TaskState(
            task_id="task-audit-1",
            status=TaskStatus.RUNNING,
            provider="ollama",
            model="llama3.2:latest",
        )
    )
    return tm


def _make_settings(**overrides) -> Settings:
    defaults = dict(
        host="127.0.0.1",
        port=5099,
        debug=True,
        log_level="debug",
        guardrail_enabled=True,
        guardrail_mode="log",
    )
    defaults.update(overrides)
    return Settings(**defaults)


@pytest_asyncio.fixture
async def audit_client(mock_provider_registry, mock_task_manager):
    from smr_v2.main import create_app

    settings = _make_settings(guardrail_mode="log", guardrail_enabled=True)
    app = create_app(settings_override=settings)
    app.state.provider_registry = mock_provider_registry
    app.state.task_manager = mock_task_manager
    app.state.settings = settings
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ── Test: GuardrailAuditEvent field completeness ──


class TestGuardrailAuditEvent:
    def test_audit_event_has_all_required_fields(self):
        """GuardrailAuditEvent dataclass has every specified field."""
        from smr_v2.services.audit import GuardrailAuditEvent

        field_names = {f.name for f in dataclasses.fields(GuardrailAuditEvent)}
        required = {
            "request_id",
            "timestamp",
            "guardrail_type",
            "action",
            "is_suspicious",
            "risk_level",
            "matched_patterns",
            "provider",
            "model",
            "scan_duration_ms",
        }
        assert required.issubset(field_names), f"Missing fields: {required - field_names}"


# ── Test: Log levels ──


class TestAuditLogLevels:
    def test_audit_logs_clean_scan_at_info(self, audit_logger, clean_audit_event):
        """Clean scan (not suspicious) emits INFO level log."""
        with structlog.testing.capture_logs() as cap_logs:
            audit_logger.log_scan(clean_audit_event)

        assert len(cap_logs) == 1
        assert cap_logs[0]["event"] == "guardrail.audit"
        assert cap_logs[0]["log_level"] == "info"

    def test_audit_logs_suspicious_scan_at_warning(self, audit_logger, suspicious_audit_event):
        """Suspicious scan with action='logged' emits WARNING level log."""
        with structlog.testing.capture_logs() as cap_logs:
            audit_logger.log_scan(suspicious_audit_event)

        assert len(cap_logs) == 1
        assert cap_logs[0]["event"] == "guardrail.audit"
        assert cap_logs[0]["log_level"] == "warning"

    def test_audit_logs_blocked_scan_at_error(self, audit_logger, blocked_audit_event):
        """Blocked scan emits ERROR level log."""
        with structlog.testing.capture_logs() as cap_logs:
            audit_logger.log_scan(blocked_audit_event)

        assert len(cap_logs) == 1
        assert cap_logs[0]["event"] == "guardrail.audit"
        assert cap_logs[0]["log_level"] == "error"


# ── Test: Request ID propagation ──


class TestAuditRequestID:
    def test_audit_includes_request_id(
        self, _clean_contextvars, audit_logger, clean_audit_event
    ):
        """Audit event includes request_id field in the emitted log."""
        structlog.contextvars.bind_contextvars(request_id="ctx-req-999")

        with structlog.testing.capture_logs() as cap_logs:
            audit_logger.log_scan(clean_audit_event)

        assert cap_logs[0]["request_id"] == "req-abc-123"


# ── Test: Scan duration ──


class TestAuditScanDuration:
    def test_audit_includes_scan_duration(self, audit_logger, clean_audit_event):
        """Audit event includes scan_duration_ms > 0."""
        with structlog.testing.capture_logs() as cap_logs:
            audit_logger.log_scan(clean_audit_event)

        assert "scan_duration_ms" in cap_logs[0]
        assert cap_logs[0]["scan_duration_ms"] > 0


# ── Test: Provider and model ──


class TestAuditProviderModel:
    def test_audit_includes_provider_and_model(self, audit_logger, clean_audit_event):
        """Audit event includes provider and model fields."""
        with structlog.testing.capture_logs() as cap_logs:
            audit_logger.log_scan(clean_audit_event)

        assert cap_logs[0]["provider"] == "ollama"
        assert cap_logs[0]["model"] == "llama3.2:latest"


# ── Test: Endpoint integration ──


class TestGenerateEndpointAudit:
    @pytest.mark.asyncio
    async def test_generate_endpoint_emits_audit(self, audit_client: AsyncClient):
        """POST /generate emits a guardrail.audit event via structured logging."""
        with structlog.testing.capture_logs() as cap_logs:
            resp = await audit_client.post(
                "/api/v1/generate",
                json={
                    "prompt": "Summarize the clinical transcript.",
                    "provider": "ollama",
                    "stream": False,
                },
            )

        assert resp.status_code == 200

        audit_events = [e for e in cap_logs if e.get("event") == "guardrail.audit"]
        assert len(audit_events) >= 1, f"Expected guardrail.audit event, got: {cap_logs}"

        evt = audit_events[0]
        assert evt["guardrail_type"] == "prompt_injection_scan"
        assert evt["action"] == "allowed"
        assert evt["is_suspicious"] is False
        assert evt["provider"] == "ollama"
        assert "scan_duration_ms" in evt
        assert evt["scan_duration_ms"] >= 0
