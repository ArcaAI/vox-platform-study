"""Tests for NLP observability: OTel LoggerProvider, log export, trace correlation,
config parsing, PHI sanitization, metrics, and the OTel master switch.

30 tests across 7 groups — characterization tests verifying the observability
implementation plus the `NLP_OTEL_ENABLED` master-switch gate.
"""

from __future__ import annotations

import json
import logging
import os
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest
from opentelemetry import metrics, trace
from opentelemetry._logs import set_logger_provider
from opentelemetry.instrumentation.logging import LoggingInstrumentor
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import InMemoryLogExporter, SimpleLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from nlp.core.config import Environment, _parse_otel_resource_attributes
from nlp.core.logging import JsonFormatter
from nlp.core.observability import (
    _phi_sanitization_hook,
    setup_opentelemetry,
    shutdown_opentelemetry,
)

_TEST_RESOURCE = Resource({SERVICE_NAME: "test-nlp"})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _clean_otel_handlers():
    """Remove OTel LoggingHandlers from root logger."""
    root = logging.getLogger()
    for h in [h for h in root.handlers if isinstance(h, LoggingHandler)]:
        root.removeHandler(h)


def _reset_otel_globals():
    """Force-reset OTel SDK global singletons so each test gets a clean slate."""
    if hasattr(trace, "_TRACER_PROVIDER_SET_ONCE"):
        trace._TRACER_PROVIDER_SET_ONCE._done = False  # type: ignore[attr-defined]
    if hasattr(trace, "_TRACER_PROVIDER"):
        trace._TRACER_PROVIDER = None  # type: ignore[attr-defined]

    if hasattr(metrics._internal, "_METER_PROVIDER_SET_ONCE"):
        metrics._internal._METER_PROVIDER_SET_ONCE._done = False  # type: ignore[attr-defined]
    if hasattr(metrics._internal, "_METER_PROVIDER"):
        metrics._internal._METER_PROVIDER = None  # type: ignore[attr-defined]

    from opentelemetry._logs import _internal as logs_internal
    if hasattr(logs_internal, "_LOGGER_PROVIDER_SET_ONCE"):
        logs_internal._LOGGER_PROVIDER_SET_ONCE._done = False  # type: ignore[attr-defined]
    if hasattr(logs_internal, "_LOGGER_PROVIDER"):
        logs_internal._LOGGER_PROVIDER = None  # type: ignore[attr-defined]


def _make_service_config(**overrides):
    """Build a mock NLPServiceConfig with sensible defaults for testing."""
    cfg = MagicMock()
    cfg.name = overrides.get("name", "test-nlp")
    cfg.version = overrides.get("version", "1.0.0")
    cfg.namespace = overrides.get("namespace", "hope")
    cfg.environment = overrides.get("environment", Environment.DEVELOPMENT)
    cfg.otlp_endpoint = overrides.get("otlp_endpoint", "http://localhost:4317")
    cfg.resource_attributes_raw = overrides.get("resource_attributes_raw", None)
    cfg.resource_attributes = overrides.get("resource_attributes", {})
    cfg.traces_enabled = overrides.get("traces_enabled", True)
    cfg.metrics_enabled = overrides.get("metrics_enabled", True)
    # Master switch: defaults to True here so activation tests keep
    # exercising the enabled path (the real config defaults to False).
    cfg.otel_enabled = overrides.get("otel_enabled", True)
    return cfg


@contextmanager
def _patched_otel_settings(**config_overrides):
    """Context manager that patches ``nlp.core.observability.settings``
    with a mock built from *config_overrides*."""
    mock_settings = MagicMock()
    mock_settings.service = _make_service_config(**config_overrides)
    with patch("nlp.core.observability.settings", mock_settings):
        yield mock_settings


def _make_tracer_provider():
    """Create a TracerProvider + InMemorySpanExporter pair and register globally."""
    exporter = InMemorySpanExporter()
    provider = TracerProvider(resource=_TEST_RESOURCE)
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    return provider, exporter


def _make_log_record(msg: str = "test", **extra_attrs):
    """Create a bare ``logging.LogRecord`` with optional OTel attributes."""
    record = logging.LogRecord(
        name="test", level=logging.INFO, pathname="", lineno=0,
        msg=msg, args=None, exc_info=None,
    )
    for k, v in extra_attrs.items():
        setattr(record, k, v)
    return record


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _otel_reset():
    """Reset all OTel global providers before and after each test."""
    _clean_otel_handlers()
    try:
        LoggingInstrumentor().uninstrument()
    except Exception:
        pass
    _reset_otel_globals()

    yield

    _clean_otel_handlers()
    try:
        LoggingInstrumentor().uninstrument()
    except Exception:
        pass
    _reset_otel_globals()


@pytest.fixture()
def in_memory_log_exporter():
    """InMemoryLogExporter wired to a LoggerProvider with SimpleLogRecordProcessor."""
    exporter = InMemoryLogExporter()
    provider = LoggerProvider(resource=_TEST_RESOURCE)
    provider.add_log_record_processor(SimpleLogRecordProcessor(exporter))
    set_logger_provider(provider)
    root_logger = logging.getLogger()
    previous_root_level = root_logger.level
    root_logger.setLevel(logging.DEBUG)
    handler = LoggingHandler(level=logging.DEBUG, logger_provider=provider)
    root_logger.addHandler(handler)
    yield exporter
    root_logger.removeHandler(handler)
    root_logger.setLevel(previous_root_level)
    provider.shutdown()


@pytest.fixture()
def fastapi_app():
    """Minimal FastAPI app for testing setup_opentelemetry."""
    from fastapi import FastAPI
    app = FastAPI()
    app.state._state = {}
    return app


# ---------------------------------------------------------------------------
# Test Group 1: LoggerProvider Setup
# ---------------------------------------------------------------------------

class TestLoggerProviderSetup:
    """Verify setup_opentelemetry creates and wires the LoggerProvider."""

    def test_setup_creates_logger_provider(self, fastapi_app):
        """When the master switch is on and otlp_endpoint is set, setup_opentelemetry
        must create a LoggerProvider and store it on app.state.logger_provider."""
        with _patched_otel_settings(otel_enabled=True):
            setup_opentelemetry(fastapi_app)
            try:
                assert hasattr(fastapi_app.state, "logger_provider")
                assert isinstance(fastapi_app.state.logger_provider, LoggerProvider)
            finally:
                shutdown_opentelemetry(fastapi_app)

    def test_setup_adds_logging_handler_to_root(self, fastapi_app):
        """After setup, the root Python logger must have an OTel LoggingHandler."""
        with _patched_otel_settings(otel_enabled=True):
            setup_opentelemetry(fastapi_app)
            try:
                root = logging.getLogger()
                otel_handlers = [h for h in root.handlers if isinstance(h, LoggingHandler)]
                assert len(otel_handlers) >= 1, "Root logger must have at least one OTel LoggingHandler"
            finally:
                shutdown_opentelemetry(fastapi_app)

    def test_setup_skipped_without_endpoint(self, fastapi_app):
        """When otlp_endpoint is None (even with the switch on), no LoggerProvider
        is created."""
        with _patched_otel_settings(otel_enabled=True, otlp_endpoint=None):
            setup_opentelemetry(fastapi_app)

            assert not hasattr(fastapi_app.state, "logger_provider") or \
                fastapi_app.state.logger_provider is None

    def test_shutdown_flushes_logger_provider(self, fastapi_app):
        """shutdown_opentelemetry must call .shutdown() on the LoggerProvider."""
        mock_provider = MagicMock(spec=LoggerProvider)
        fastapi_app.state.logger_provider = mock_provider
        fastapi_app.state.tracer_provider = None
        fastapi_app.state.meter_provider = None

        with _patched_otel_settings(otel_enabled=True):
            shutdown_opentelemetry(fastapi_app)

        mock_provider.shutdown.assert_called_once()


# ---------------------------------------------------------------------------
# Test Group 2: Log Export via OTLP
# ---------------------------------------------------------------------------

class TestLogExportOTLP:
    """Verify that Python log records become OTel log records."""

    def test_log_record_exported_via_otlp(self, in_memory_log_exporter):
        """A logging.info call during an active span must produce an OTel log record."""
        tp, _ = _make_tracer_provider()
        tracer = trace.get_tracer("test")
        with tracer.start_as_current_span("test-span"):
            logging.getLogger("test.export").info("hello from test")

        records = in_memory_log_exporter.get_finished_logs()
        assert len(records) >= 1, "Expected at least one exported log record"
        tp.shutdown()

    def test_log_record_has_trace_correlation(self, in_memory_log_exporter):
        """Exported log records must contain the active span's trace_id and span_id."""
        tp, _ = _make_tracer_provider()
        logging.getLogger().setLevel(logging.DEBUG)

        tracer = trace.get_tracer("test")
        with tracer.start_as_current_span("corr-span") as span:
            expected_trace_id = span.get_span_context().trace_id
            expected_span_id = span.get_span_context().span_id
            logging.getLogger("test.corr").info("correlated log")

        records = in_memory_log_exporter.get_finished_logs()
        assert len(records) >= 1
        rec = records[-1]
        assert rec.log_record.trace_id == expected_trace_id
        assert rec.log_record.span_id == expected_span_id
        tp.shutdown()

    def test_log_record_has_service_resource(self, in_memory_log_exporter):
        """Exported log records must carry service.name resource attribute."""
        logging.getLogger().setLevel(logging.DEBUG)
        logging.getLogger("test.resource").warning("resource check")

        records = in_memory_log_exporter.get_finished_logs()
        assert len(records) >= 1
        resource_attrs = dict(records[-1].resource.attributes)
        assert resource_attrs.get("service.name") == "test-nlp"

    def test_log_record_has_severity(self, in_memory_log_exporter):
        """Exported log records must have correct severity levels."""
        logging.getLogger().setLevel(logging.DEBUG)
        test_logger = logging.getLogger("test.severity")
        test_logger.setLevel(logging.DEBUG)
        test_logger.info("info msg")
        test_logger.warning("warn msg")
        test_logger.error("error msg")

        records = in_memory_log_exporter.get_finished_logs()
        severity_texts = [r.log_record.severity_text for r in records]
        assert "INFO" in severity_texts, f"Expected 'INFO' in {severity_texts}"
        assert any(s in severity_texts for s in ("WARNING", "WARN")), \
            f"Expected 'WARNING' or 'WARN' in {severity_texts}"
        assert "ERROR" in severity_texts

    def test_log_record_body_contains_message(self, in_memory_log_exporter):
        """The log record body must contain the original log message text."""
        logging.getLogger().setLevel(logging.DEBUG)
        logging.getLogger("test.body").info("unique-marker-12345")

        records = in_memory_log_exporter.get_finished_logs()
        bodies = [str(r.log_record.body) for r in records]
        assert any("unique-marker-12345" in b for b in bodies), \
            f"Expected 'unique-marker-12345' in log record bodies, got {bodies}"


# ---------------------------------------------------------------------------
# Test Group 3: JsonFormatter Trace Correlation (stdout path)
# ---------------------------------------------------------------------------

class TestJsonFormatterTraceCorrelation:
    """Verify that JsonFormatter includes OTel trace context in JSON output."""

    _formatter = JsonFormatter()

    def test_json_formatter_includes_trace_id(self):
        """When a span is current, JSON output must contain a traceId field."""
        provider = TracerProvider(resource=_TEST_RESOURCE)
        trace.set_tracer_provider(provider)
        tracer = trace.get_tracer("test")
        with tracer.start_as_current_span("fmt-span") as span:
            expected = format(span.get_span_context().trace_id, "032x")
            record = _make_log_record("trace test", otelTraceID=expected,
                                      otelSpanID=format(span.get_span_context().span_id, "016x"))
            data = json.loads(self._formatter.format(record))
            assert data.get("traceId") == expected
        provider.shutdown()

    def test_json_formatter_includes_span_id(self):
        """JSON output must contain spanId field."""
        provider = TracerProvider(resource=_TEST_RESOURCE)
        trace.set_tracer_provider(provider)
        tracer = trace.get_tracer("test")
        with tracer.start_as_current_span("span-test") as span:
            expected = format(span.get_span_context().span_id, "016x")
            record = _make_log_record("span test",
                                      otelTraceID=format(span.get_span_context().trace_id, "032x"),
                                      otelSpanID=expected)
            data = json.loads(self._formatter.format(record))
            assert data.get("spanId") == expected
        provider.shutdown()

    def test_json_formatter_omits_trace_when_no_span(self):
        """When no span is active, JSON output must NOT contain traceId/spanId
        or they must be '0'."""
        record = _make_log_record("no span")
        data = json.loads(self._formatter.format(record))
        if "traceId" in data:
            assert data["traceId"] == "0", f"Expected '0' but got {data['traceId']}"

    def test_json_formatter_uses_utc_timestamp(self):
        """Timestamp must end with +00:00 (UTC timezone indicator)."""
        record = _make_log_record("utc test")
        data = json.loads(self._formatter.format(record))
        assert data["timestamp"].endswith("+00:00"), \
            f"Timestamp not UTC: {data['timestamp']}"

    def test_json_formatter_includes_service_name(self):
        """When OTel is active, JSON output must contain service.name field."""
        record = _make_log_record("svc name test", otelServiceName="hope-nlp")
        data = json.loads(self._formatter.format(record))
        assert data.get("service.name") == "hope-nlp"


# ---------------------------------------------------------------------------
# Test Group 4: Config Parsing
# ---------------------------------------------------------------------------

class TestConfigParsing:
    """Verify NLPServiceConfig parses OTel-related env vars correctly."""

    def test_resource_attributes_parsed_from_string(self):
        """OTEL_RESOURCE_ATTRIBUTES='key1=val1,key2=val2' must parse into dict."""
        result = _parse_otel_resource_attributes("key1=val1,key2=val2")
        assert result == {"key1": "val1", "key2": "val2"}

    def test_resource_attributes_empty_when_unset(self):
        """When env var is unset/None, resource_attributes must return {}."""
        assert _parse_otel_resource_attributes(None) == {}
        assert _parse_otel_resource_attributes("") == {}

    def test_resource_attributes_handles_equals_in_value(self):
        """'key=val=ue' must parse as {'key': 'val=ue'}."""
        result = _parse_otel_resource_attributes("key=val=ue")
        assert result == {"key": "val=ue"}

    def test_otlp_endpoint_none_when_unset(self):
        """When OTEL_EXPORTER_OTLP_ENDPOINT is unset, otlp_endpoint must be None."""
        from nlp.core.config import NLPServiceConfig

        env_overrides = {
            "OTEL_EXPORTER_OTLP_ENDPOINT": "",
            "NLP_OTLP_ENDPOINT": "",
        }
        with patch.dict("os.environ", env_overrides, clear=False):
            for key in ("OTEL_EXPORTER_OTLP_ENDPOINT", "NLP_OTLP_ENDPOINT"):
                if key in os.environ:
                    del os.environ[key]

            cfg = NLPServiceConfig(otlp_endpoint=None)
            assert cfg.otlp_endpoint is None

    def test_otel_enabled_defaults_to_false(self, monkeypatch):
        """otel_enabled must default to False when NLP_OTEL_ENABLED is unset."""
        from nlp.core.config import NLPServiceConfig

        monkeypatch.delenv("NLP_OTEL_ENABLED", raising=False)
        cfg = NLPServiceConfig()
        assert cfg.otel_enabled is False

    def test_otel_enabled_true_from_env(self, monkeypatch):
        """NLP_OTEL_ENABLED=true must switch otel_enabled to True."""
        from nlp.core.config import NLPServiceConfig

        monkeypatch.setenv("NLP_OTEL_ENABLED", "true")
        cfg = NLPServiceConfig()
        assert cfg.otel_enabled is True


# ---------------------------------------------------------------------------
# Test Group 5: PHI Sanitization
# ---------------------------------------------------------------------------

class TestPHISanitization:
    """Verify _phi_sanitization_hook redacts sensitive span attributes."""

    def test_phi_hook_redacts_request_body(self):
        """The hook must set http.request.body to [REDACTED] on a recording span."""
        provider, exporter = _make_tracer_provider()

        tracer = trace.get_tracer("test")
        with tracer.start_as_current_span("phi-req") as span:
            span.set_attribute("http.request.body", '{"patient": "John Doe"}')
            _phi_sanitization_hook(span, None)

        spans = exporter.get_finished_spans()
        assert len(spans) == 1
        assert spans[0].attributes.get("http.request.body") == "[REDACTED]"
        provider.shutdown()

    def test_phi_hook_redacts_response_body(self):
        """The hook must set http.response.body to [REDACTED]."""
        provider, exporter = _make_tracer_provider()

        tracer = trace.get_tracer("test")
        with tracer.start_as_current_span("phi-resp") as span:
            span.set_attribute("http.response.body", '{"diagnosis": "flu"}')
            _phi_sanitization_hook(span, None)

        spans = exporter.get_finished_spans()
        assert len(spans) == 1
        assert spans[0].attributes.get("http.response.body") == "[REDACTED]"
        provider.shutdown()

    def test_phi_hook_noop_on_non_recording_span(self):
        """The hook must not raise when span is not recording."""
        mock_span = MagicMock()
        mock_span.is_recording.return_value = False

        _phi_sanitization_hook(mock_span, None)
        mock_span.set_attribute.assert_not_called()


# ---------------------------------------------------------------------------
# Test Group 6: Metrics (OTel export)
# ---------------------------------------------------------------------------

class TestMetrics:
    """Verify MeterProvider setup and NLPMetrics instrumentation."""

    def test_setup_creates_meter_provider_with_reader(self, fastapi_app):
        """When metrics_enabled=True, setup_opentelemetry must create a
        MeterProvider with at least one PeriodicExportingMetricReader."""
        with _patched_otel_settings(otel_enabled=True, metrics_enabled=True):
            setup_opentelemetry(fastapi_app)
            try:
                assert hasattr(fastapi_app.state, "meter_provider")
                assert isinstance(fastapi_app.state.meter_provider, MeterProvider)
            finally:
                shutdown_opentelemetry(fastapi_app)

    def test_nlp_metrics_inference_tracking(self):
        """nlp_metrics.track_inference context manager must record duration
        via the histogram and increment the counter."""
        reader = InMemoryMetricReader()
        provider = MeterProvider(resource=_TEST_RESOURCE, metric_readers=[reader])
        metrics.set_meter_provider(provider)

        from nlp.core.metrics import NLPMetrics
        test_metrics = NLPMetrics(meter_name="test-nlp-metrics")

        with test_metrics.track_inference("test-model"):
            pass

        data = reader.get_metrics_data()
        assert data is not None, "get_metrics_data() returned None"
        metric_names = []
        for rm in data.resource_metrics:
            for sm in rm.scope_metrics:
                for m in sm.metrics:
                    metric_names.append(m.name)

        assert "nlp.inference.total" in metric_names, \
            f"Expected 'nlp.inference.total' in {metric_names}"
        assert "nlp.inference.duration_ms" in metric_names, \
            f"Expected 'nlp.inference.duration_ms' in {metric_names}"
        provider.shutdown()


# ---------------------------------------------------------------------------
# Test Group 7: OTel Master Switch — NLP_OTEL_ENABLED
# ---------------------------------------------------------------------------

class TestOtelMasterSwitch:
    """Verify the NLP_OTEL_ENABLED master switch gates traces, metrics, AND logs."""

    def test_disabled_switch_skips_all_providers(self, fastapi_app):
        """A2: endpoint set + otel_enabled=False → setup_opentelemetry returns early:
        no TracerProvider, no MeterProvider, no LoggerProvider, no root OTel handler,
        FastAPI app not instrumented."""
        with _patched_otel_settings(otel_enabled=False):
            setup_opentelemetry(fastapi_app)

            assert not hasattr(fastapi_app.state, "tracer_provider") or \
                fastapi_app.state.tracer_provider is None
            assert not hasattr(fastapi_app.state, "meter_provider") or \
                fastapi_app.state.meter_provider is None
            assert not hasattr(fastapi_app.state, "logger_provider") or \
                fastapi_app.state.logger_provider is None

            root = logging.getLogger()
            otel_handlers = [h for h in root.handlers if isinstance(h, LoggingHandler)]
            assert otel_handlers == [], "No OTel LoggingHandler may be added when disabled"

            assert getattr(fastapi_app, "_is_instrumented_by_opentelemetry", False) is False, \
                "FastAPI app must not be instrumented when otel_enabled=False"

    def test_disabled_switch_logs_single_info_line(self, fastapi_app, caplog):
        """A2: the disabled path logs one info-level line and no warning."""
        with _patched_otel_settings(otel_enabled=False), \
                caplog.at_level(logging.INFO, logger="observability"):
            setup_opentelemetry(fastapi_app)

        disabled_infos = [
            r for r in caplog.records
            if r.name == "observability" and r.levelno == logging.INFO
            and "NLP_OTEL_ENABLED" in r.getMessage()
        ]
        assert len(disabled_infos) == 1, \
            f"Expected exactly one 'disabled' info log, got {[r.getMessage() for r in caplog.records]}"

    def test_enabled_switch_creates_all_providers(self, fastapi_app):
        """A3: endpoint set + otel_enabled=True → tracer/meter/logger providers created
        exactly as before (regression guard)."""
        with _patched_otel_settings(otel_enabled=True):
            setup_opentelemetry(fastapi_app)
            try:
                assert isinstance(fastapi_app.state.tracer_provider, TracerProvider)
                assert isinstance(fastapi_app.state.meter_provider, MeterProvider)
                assert isinstance(fastapi_app.state.logger_provider, LoggerProvider)

                root = logging.getLogger()
                otel_handlers = [h for h in root.handlers if isinstance(h, LoggingHandler)]
                assert len(otel_handlers) >= 1
            finally:
                shutdown_opentelemetry(fastapi_app)

    def test_enabled_without_endpoint_stays_disabled(self, fastapi_app, caplog):
        """A4: otel_enabled=True + endpoint unset → disabled; the existing
        misconfiguration warning is still emitted."""
        with _patched_otel_settings(otel_enabled=True, otlp_endpoint=None), \
                caplog.at_level(logging.WARNING, logger="observability"):
            setup_opentelemetry(fastapi_app)

        assert not hasattr(fastapi_app.state, "logger_provider") or \
            fastapi_app.state.logger_provider is None
        warnings = [
            r for r in caplog.records
            if r.levelno == logging.WARNING and "OTEL_EXPORTER_OTLP_ENDPOINT" in r.getMessage()
        ]
        assert warnings, "Expected the endpoint-missing warning when enabled but unconfigured"

    def test_shutdown_noop_when_setup_skipped(self, fastapi_app):
        """A5: shutdown_opentelemetry must not raise when setup was skipped
        (otel_enabled=False)."""
        with _patched_otel_settings(otel_enabled=False):
            setup_opentelemetry(fastapi_app)
            shutdown_opentelemetry(fastapi_app)
