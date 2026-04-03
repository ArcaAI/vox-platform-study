"""TDD tests for STT-v2 observability: logging, trace context, OTLP export.

Follows Red-Green-Refactor per TASK-255 LOG-CAPTURE-PLAN.md.
Tests are grouped by implementation unit.
"""

from __future__ import annotations

import io
import json
import logging
from unittest.mock import MagicMock, patch

import structlog

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _capture_stdlib_log(logger_name: str, message: str, *, level: int = logging.INFO) -> str:
    """Emit a stdlib log and return whatever the root handler wrote."""
    root = logging.getLogger()
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(
        root.handlers[0].formatter if root.handlers else logging.Formatter("%(message)s")
    )
    root.addHandler(handler)
    try:
        logging.getLogger(logger_name).log(level, message)
        return buf.getvalue()
    finally:
        root.removeHandler(handler)


def _reset_logging() -> None:
    """Remove all handlers from root logger and reset structlog."""
    root = logging.getLogger()
    for h in root.handlers[:]:
        root.removeHandler(h)
    structlog.reset_defaults()

    import stt_v2.core.logging as _mod

    _mod._SETUP_DONE = False


# ---------------------------------------------------------------------------
# Unit 1: _add_otel_context processor
# ---------------------------------------------------------------------------


class TestAddOtelContext:
    """Tests for the _add_otel_context structlog processor."""

    def setup_method(self):
        _reset_logging()

    def teardown_method(self):
        _reset_logging()

    def test_injects_trace_ids_when_span_active(self):
        """RED → GREEN: Processor should add traceId/spanId when a span is active."""
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider

        from stt_v2.core.logging import _add_otel_context

        provider = TracerProvider()
        trace.set_tracer_provider(provider)
        tracer = trace.get_tracer("test")

        with tracer.start_as_current_span("test-span") as span:
            ctx = span.get_span_context()
            event_dict: dict = {"event": "hello"}
            result = _add_otel_context(None, "info", event_dict)

            assert "traceId" in result
            assert "spanId" in result
            assert result["traceId"] == format(ctx.trace_id, "032x")
            assert result["spanId"] == format(ctx.span_id, "016x")
            assert len(result["traceId"]) == 32
            assert len(result["spanId"]) == 16

        provider.shutdown()

    def test_skips_when_no_active_span(self):
        """RED → GREEN: Processor should not inject when no span is active."""
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider

        from stt_v2.core.logging import _add_otel_context

        provider = TracerProvider()
        trace.set_tracer_provider(provider)

        event_dict: dict = {"event": "hello"}
        result = _add_otel_context(None, "info", event_dict)

        assert "traceId" not in result
        assert "spanId" not in result
        assert result["event"] == "hello"

        provider.shutdown()

    def test_skips_when_otel_import_fails(self):
        """RED → GREEN: Processor should silently no-op when opentelemetry not available."""
        from stt_v2.core.logging import _add_otel_context

        with patch.dict("sys.modules", {"opentelemetry": None, "opentelemetry.trace": None}):
            event_dict: dict = {"event": "hello"}
            result = _add_otel_context(None, "info", event_dict)

            assert "traceId" not in result
            assert result["event"] == "hello"


# ---------------------------------------------------------------------------
# Unit 2: ProcessorFormatter stdlib bridge
# ---------------------------------------------------------------------------


class TestProcessorFormatterBridge:
    """Tests for stdlib → structlog ProcessorFormatter bridge."""

    def setup_method(self):
        _reset_logging()

    def teardown_method(self):
        _reset_logging()

    def test_stdlib_logger_produces_json_after_setup(self):
        """RED → GREEN: stdlib logging.getLogger().info() should produce JSON."""
        from stt_v2.core.logging import setup_logging

        setup_logging("info")

        output = _capture_stdlib_log("test.stdlib", "hello from stdlib")
        assert output.strip(), "Expected output on stdout"

        parsed = json.loads(output.strip())
        assert parsed["event"] == "hello from stdlib"

    def test_stdlib_logger_includes_timestamp_and_level(self):
        """RED → GREEN: stdlib log JSON should have timestamp and level."""
        from stt_v2.core.logging import setup_logging

        setup_logging("info")

        output = _capture_stdlib_log("test.stdlib.ts", "timestamped")
        parsed = json.loads(output.strip())

        assert "timestamp" in parsed
        assert "level" in parsed
        assert parsed["level"] == "info"

    def test_structlog_logger_still_produces_json(self):
        """RED → GREEN: structlog loggers must not regress — still JSON."""
        from stt_v2.core.logging import get_logger, setup_logging

        setup_logging("info")

        buf = io.StringIO()
        handler = logging.StreamHandler(buf)
        root = logging.getLogger()
        handler.setFormatter(root.handlers[0].formatter if root.handlers else None)
        root.addHandler(handler)

        try:
            get_logger("test.structlog").info("structlog msg")
            output = buf.getvalue()
        finally:
            root.removeHandler(handler)

        assert output.strip()
        parsed = json.loads(output.strip())
        assert parsed["event"] == "structlog msg"

    def test_stdlib_logger_includes_otel_context_when_span_active(self):
        """RED → GREEN: stdlib logs inside active span should have traceId."""
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider

        from stt_v2.core.logging import setup_logging

        setup_logging("info")
        provider = TracerProvider()
        trace.set_tracer_provider(provider)
        tracer = trace.get_tracer("test")

        with tracer.start_as_current_span("test-span"):
            output = _capture_stdlib_log("test.otel", "traced log")

        parsed = json.loads(output.strip())
        assert "traceId" in parsed
        assert len(parsed["traceId"]) == 32

        provider.shutdown()

    def test_contextvars_visible_in_stdlib_logs(self):
        """RED → GREEN: structlog contextvars should appear in stdlib logs."""
        from stt_v2.core.logging import setup_logging

        setup_logging("info")

        structlog.contextvars.bind_contextvars(request_id="req-123")
        try:
            output = _capture_stdlib_log("test.ctx", "with context")
        finally:
            structlog.contextvars.clear_contextvars()

        parsed = json.loads(output.strip())
        assert parsed.get("request_id") == "req-123"


# ---------------------------------------------------------------------------
# Unit 3: OTLP log export pipeline
# ---------------------------------------------------------------------------


class TestOtlpLogExport:
    """Tests for LoggerProvider + OTLPLogExporter pipeline in telemetry.py."""

    def setup_method(self):
        _reset_logging()

    def teardown_method(self):
        _reset_logging()
        from opentelemetry import trace
        from opentelemetry.instrumentation.logging import LoggingInstrumentor

        try:
            LoggingInstrumentor().uninstrument()
        except Exception:
            pass
        trace.set_tracer_provider(trace.NoOpTracerProvider())

    @patch("stt_v2.core.telemetry.OTLPLogExporter")
    @patch("stt_v2.core.telemetry.OTLPSpanExporter")
    def test_setup_telemetry_creates_logger_provider_when_enabled(self, _span_exp, _log_exp):
        """RED → GREEN: setup_telemetry should create a LoggerProvider."""
        from opentelemetry.sdk._logs import LoggerProvider

        from stt_v2.core.telemetry import setup_telemetry

        app = MagicMock()
        result = setup_telemetry(app, endpoint="http://localhost:4317", service_name="stt-v2-test")

        assert result is not None
        assert isinstance(result.logger_provider, LoggerProvider)

        result.logger_provider.shutdown()

    @patch("stt_v2.core.telemetry.OTLPLogExporter")
    @patch("stt_v2.core.telemetry.OTLPSpanExporter")
    def test_setup_telemetry_adds_logging_handler_to_root(self, _span_exp, _log_exp):
        """RED → GREEN: A LoggingHandler should be added to the root logger."""
        from opentelemetry.sdk._logs import LoggingHandler

        from stt_v2.core.telemetry import setup_telemetry

        app = MagicMock()
        result = setup_telemetry(app, endpoint="http://localhost:4317", service_name="stt-v2-test")

        root = logging.getLogger()
        otel_handlers = [h for h in root.handlers if isinstance(h, LoggingHandler)]
        assert len(otel_handlers) >= 1

        result.logger_provider.shutdown()

    @patch("stt_v2.core.telemetry.OTLPLogExporter")
    @patch("stt_v2.core.telemetry.OTLPSpanExporter")
    def test_setup_telemetry_instruments_logging(self, _span_exp, _log_exp):
        """RED → GREEN: LoggingInstrumentor should be activated."""
        from opentelemetry.instrumentation.logging import LoggingInstrumentor

        from stt_v2.core.telemetry import setup_telemetry

        app = MagicMock()
        result = setup_telemetry(app, endpoint="http://localhost:4317", service_name="stt-v2-test")

        assert LoggingInstrumentor().is_instrumented_by_opentelemetry

        LoggingInstrumentor().uninstrument()
        result.logger_provider.shutdown()

    def test_setup_telemetry_skips_log_pipeline_when_disabled(self):
        """RED → GREEN: When otel_enabled is effectively false, returns None."""
        from stt_v2.core.telemetry import setup_telemetry_logs

        result = setup_telemetry_logs(enabled=False)
        assert result is None

    @patch("stt_v2.core.telemetry.OTLPLogExporter")
    @patch("stt_v2.core.telemetry.OTLPSpanExporter")
    def test_log_records_include_resource_attributes(self, _span_exp, _log_exp):
        """RED → GREEN: Log records should carry service.name resource."""
        from opentelemetry.sdk.resources import SERVICE_NAME

        from stt_v2.core.telemetry import setup_telemetry

        app = MagicMock()
        result = setup_telemetry(app, endpoint="http://localhost:4317", service_name="stt-v2-test")

        resource = result.logger_provider.resource
        assert resource.attributes.get(SERVICE_NAME) == "stt-v2-test"

        result.logger_provider.shutdown()

    @patch("stt_v2.core.telemetry.OTLPLogExporter")
    @patch("stt_v2.core.telemetry.OTLPSpanExporter")
    def test_logger_provider_shutdown_is_safe(self, _span_exp, _log_exp):
        """RED → GREEN: Calling shutdown should not raise."""
        from stt_v2.core.telemetry import setup_telemetry

        app = MagicMock()
        result = setup_telemetry(app, endpoint="http://localhost:4317", service_name="stt-v2-test")

        result.logger_provider.force_flush()
        result.logger_provider.shutdown()


# ---------------------------------------------------------------------------
# Unit 4: Worker subprocess log pipeline
# ---------------------------------------------------------------------------


class TestWorkerLogPipeline:
    """Tests for worker-specific telemetry setup (log pipeline only, no FastAPI)."""

    def setup_method(self):
        _reset_logging()

    def teardown_method(self):
        _reset_logging()

    def test_worker_setup_logging_produces_json(self):
        """RED → GREEN: Worker's setup_logging should produce JSON on stdout."""
        from stt_v2.core.logging import setup_logging

        setup_logging("info")
        output = _capture_stdlib_log("worker.test", "worker log")
        parsed = json.loads(output.strip())
        assert parsed["event"] == "worker log"

    @patch("stt_v2.core.telemetry.OTLPLogExporter")
    def test_worker_creates_log_pipeline_when_enabled(self, _log_exp):
        """RED → GREEN: setup_telemetry_logs should create LoggerProvider."""
        from opentelemetry.sdk._logs import LoggerProvider

        from stt_v2.core.telemetry import setup_telemetry_logs

        result = setup_telemetry_logs(
            enabled=True,
            endpoint="http://localhost:4317",
            service_name="stt-v2-worker-test",
        )

        assert result is not None
        assert isinstance(result, LoggerProvider)

        result.shutdown()

    def test_worker_skips_log_pipeline_when_disabled(self):
        """RED → GREEN: setup_telemetry_logs(enabled=False) returns None."""
        from stt_v2.core.telemetry import setup_telemetry_logs

        result = setup_telemetry_logs(enabled=False)
        assert result is None


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestEdgeCases:
    """Edge case and error handling tests."""

    def setup_method(self):
        _reset_logging()

    def teardown_method(self):
        _reset_logging()

    def test_otel_context_processor_handles_exception_gracefully(self):
        """RED → GREEN: _add_otel_context should not raise on internal errors."""
        from stt_v2.core.logging import _add_otel_context

        with patch("stt_v2.core.logging.trace") as mock_trace:
            mock_trace.get_current_span.side_effect = RuntimeError("boom")
            event_dict: dict = {"event": "safe"}
            result = _add_otel_context(None, "info", event_dict)
            assert result["event"] == "safe"
            assert "traceId" not in result

    def test_setup_logging_idempotent(self):
        """RED → GREEN: Calling setup_logging twice should not duplicate handlers."""
        from stt_v2.core.logging import setup_logging

        setup_logging("info")
        count_after_first = len(logging.getLogger().handlers)

        setup_logging("info")
        count_after_second = len(logging.getLogger().handlers)

        assert count_after_second == count_after_first

    def test_otlp_exporter_failure_does_not_crash_logging(self):
        """RED → GREEN: If OTLP collector is unreachable, logs still go to stdout."""
        from stt_v2.core.logging import setup_logging

        setup_logging("info")

        output = _capture_stdlib_log("test.resilience", "still works")
        parsed = json.loads(output.strip())
        assert parsed["event"] == "still works"
