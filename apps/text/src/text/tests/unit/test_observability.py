"""Tests for the consolidated observability module.

Covers: setup_opentelemetry, shutdown_opentelemetry, LoggerProvider,
LoggingHandler, LoggingInstrumentor, PHI hook, uvicorn logging taming.
"""

from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider

from text.core.config import Settings


def _force_reset_otel():
    """Force-reset OTel global state so each test gets a clean provider."""
    import opentelemetry.trace as _trace_mod

    _trace_mod._TRACER_PROVIDER = None
    _trace_mod._TRACER_PROVIDER_SET_ONCE._done = False
    _trace_mod._PROXY_TRACER_PROVIDER._real_tracer_provider = None

    try:
        import opentelemetry._logs as _logs_mod

        _logs_mod._LOGGER_PROVIDER = None
        _logs_mod._LOGGER_PROVIDER_SET_ONCE._done = False
    except (AttributeError, ImportError):
        pass


def _cleanup_root_logging_handlers():
    """Remove any OTel LoggingHandler from root logger."""
    from opentelemetry.sdk._logs import LoggingHandler

    root = logging.getLogger()
    root.handlers = [h for h in root.handlers if not isinstance(h, LoggingHandler)]


@pytest.fixture(autouse=True)
def reset_otel():
    _force_reset_otel()
    _cleanup_root_logging_handlers()
    yield
    _force_reset_otel()
    _cleanup_root_logging_handlers()
    try:
        from opentelemetry.instrumentation.logging import LoggingInstrumentor

        LoggingInstrumentor().uninstrument()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# setup_opentelemetry
# ---------------------------------------------------------------------------


class TestSetupOpentelemetry:
    def test_creates_tracer_provider(self):
        from text.core.observability import setup_opentelemetry

        app = MagicMock()
        setup_opentelemetry(app, endpoint="http://localhost:4317")

        provider = trace.get_tracer_provider()
        assert isinstance(provider, TracerProvider)
        assert app.state.tracer_provider is not None

    def test_creates_logger_provider_when_logs_enabled(self):
        from opentelemetry.sdk._logs import LoggerProvider

        from text.core.observability import setup_opentelemetry

        app = MagicMock()
        setup_opentelemetry(app, endpoint="http://localhost:4317", logs_enabled=True)

        assert isinstance(app.state.logger_provider, LoggerProvider)

    def test_no_logger_provider_when_logs_disabled(self):
        from text.core.observability import setup_opentelemetry

        app = MagicMock()
        setup_opentelemetry(app, endpoint="http://localhost:4317", logs_enabled=False)

        assert app.state.logger_provider is None

    def test_adds_logging_handler_to_root(self):
        from opentelemetry.sdk._logs import LoggingHandler

        from text.core.observability import setup_opentelemetry

        app = MagicMock()
        setup_opentelemetry(app, endpoint="http://localhost:4317", logs_enabled=True)

        root = logging.getLogger()
        otel_handlers = [h for h in root.handlers if isinstance(h, LoggingHandler)]
        assert len(otel_handlers) >= 1

    def test_calls_logging_instrumentor(self):
        with patch("text.core.observability.LoggingInstrumentor") as MockInstrumentor:
            mock_instance = MagicMock()
            MockInstrumentor.return_value = mock_instance

            from text.core.observability import setup_opentelemetry

            app = MagicMock()
            setup_opentelemetry(app, endpoint="http://localhost:4317", logs_enabled=True)

            mock_instance.instrument.assert_called_once_with(set_logging_format=False)

    def test_excludes_health_urls_from_fastapi(self):
        with patch("text.core.observability.FastAPIInstrumentor") as MockFastAPI:
            from text.core.observability import setup_opentelemetry

            app = MagicMock()
            setup_opentelemetry(app, endpoint="http://localhost:4317")

            call_kwargs = MockFastAPI.instrument_app.call_args
            assert "excluded_urls" in call_kwargs.kwargs
            assert "/health" in call_kwargs.kwargs["excluded_urls"]

    def test_adds_phi_hook_to_fastapi(self):
        with patch("text.core.observability.FastAPIInstrumentor") as MockFastAPI:
            from text.core.observability import _phi_sanitization_hook, setup_opentelemetry

            app = MagicMock()
            setup_opentelemetry(app, endpoint="http://localhost:4317")

            call_kwargs = MockFastAPI.instrument_app.call_args
            assert call_kwargs.kwargs.get("server_request_hook") is _phi_sanitization_hook

    def test_resource_has_sdk_constants(self):
        from text.core.observability import setup_opentelemetry

        app = MagicMock()
        setup_opentelemetry(app, endpoint="http://localhost:4317")

        provider = trace.get_tracer_provider()
        attrs = dict(provider.resource.attributes)
        assert attrs["telemetry.sdk.language"] == "python"
        assert "service.namespace" in attrs

    def test_preserves_tracer_provider_on_app_state(self):
        from text.core.observability import setup_opentelemetry

        app = MagicMock()
        setup_opentelemetry(app, endpoint="http://localhost:4317")

        assert isinstance(app.state.tracer_provider, TracerProvider)


# ---------------------------------------------------------------------------
# get_tracer (backward compat via new module)
# ---------------------------------------------------------------------------


class TestGetTracer:
    def test_get_tracer_from_observability(self):
        from text.core.observability import get_tracer

        tracer = get_tracer()
        assert tracer is not None
        assert hasattr(tracer, "start_as_current_span")

    def test_get_tracer_from_telemetry_shim(self):
        from text.core.telemetry import get_tracer

        tracer = get_tracer()
        assert tracer is not None
        assert hasattr(tracer, "start_as_current_span")


# ---------------------------------------------------------------------------
# shutdown_opentelemetry
# ---------------------------------------------------------------------------


class TestShutdownOpentelemetry:
    def test_shutdown_stops_tracer_provider(self):
        from text.core.observability import shutdown_opentelemetry

        mock_tracer = MagicMock()
        app = MagicMock()
        app.state.tracer_provider = mock_tracer
        app.state.logger_provider = None

        shutdown_opentelemetry(app)

        mock_tracer.force_flush.assert_called_once()
        mock_tracer.shutdown.assert_called_once()

    def test_shutdown_stops_logger_provider(self):
        from text.core.observability import shutdown_opentelemetry

        mock_logger_prov = MagicMock()
        app = MagicMock()
        app.state.tracer_provider = None
        app.state.logger_provider = mock_logger_prov

        shutdown_opentelemetry(app)

        mock_logger_prov.force_flush.assert_called_once()
        mock_logger_prov.shutdown.assert_called_once()

    def test_shutdown_uninstruments_logging(self):
        with patch("text.core.observability.LoggingInstrumentor") as MockInstrumentor:
            mock_instance = MagicMock()
            MockInstrumentor.return_value = mock_instance

            from text.core.observability import shutdown_opentelemetry

            app = MagicMock()
            app.state.tracer_provider = None
            app.state.logger_provider = None

            shutdown_opentelemetry(app)
            mock_instance.uninstrument.assert_called_once()


# ---------------------------------------------------------------------------
# PHI sanitization hook
# ---------------------------------------------------------------------------


class TestPhiSanitizationHook:
    def test_redacts_body_attributes(self):
        from text.core.observability import _phi_sanitization_hook

        span = MagicMock()
        span.is_recording.return_value = True
        span.attributes = {
            "http.request.body.content": "patient data",
            "http.response.body.content": "diagnosis",
        }

        _phi_sanitization_hook(span, {})

        span.set_attribute.assert_any_call("http.request.body.content", "[REDACTED]")
        span.set_attribute.assert_any_call("http.response.body.content", "[REDACTED]")

    def test_noop_when_not_recording(self):
        from text.core.observability import _phi_sanitization_hook

        span = MagicMock()
        span.is_recording.return_value = False

        _phi_sanitization_hook(span, {})

        span.set_attribute.assert_not_called()


# ---------------------------------------------------------------------------
# Uvicorn logging
# ---------------------------------------------------------------------------


class TestUvicornLogging:
    def test_uvicorn_access_disabled(self):
        from text.core.logging import setup_logging

        setup_logging("info")

        assert logging.getLogger("uvicorn.access").disabled is True

    def test_uvicorn_error_propagates(self):
        from text.core.logging import setup_logging

        setup_logging("info")

        assert logging.getLogger("uvicorn.error").propagate is True

    def test_uvicorn_error_no_own_handlers(self):
        from text.core.logging import setup_logging

        setup_logging("info")

        assert len(logging.getLogger("uvicorn.error").handlers) == 0


# ---------------------------------------------------------------------------
# Settings — otel_logs_enabled
# ---------------------------------------------------------------------------


class TestOtelExportIsDerivedNotDeclared:
    """One address decides everything about export.

    `TEXT_OTEL_ENABLED`, `TEXT_OTEL_LOGS_ENABLED` and `TEXT_OTEL_INSECURE` were
    three booleans that could each disagree with the endpoint they described —
    "enabled but no collector", "insecure=false over an http:// URL". They are
    derived now, so they cannot contradict their own source.
    """

    def test_no_boolean_otel_settings_survive(self):
        for retired in ("otel_enabled", "otel_logs_enabled", "otel_insecure"):
            assert retired not in Settings.model_fields

    def test_export_follows_the_presence_of_an_endpoint(self, monkeypatch):
        monkeypatch.delenv("TEXT_OTEL_EXPORTER_ENDPOINT", raising=False)
        assert Settings(port=5099, otel_exporter_endpoint="").otel_enabled is False
        assert (
            Settings(port=5099, otel_exporter_endpoint="http://collector:4317").otel_enabled
            is True
        )

    def test_the_retired_flags_are_inert(self, monkeypatch):
        """Setting the old names must not turn export off on a configured
        collector — a stale env var that silently blinds telemetry is exactly the
        failure mode deriving removes."""
        monkeypatch.setenv("TEXT_OTEL_ENABLED", "false")
        monkeypatch.setenv("TEXT_OTEL_LOGS_ENABLED", "false")
        settings = Settings(port=5099, otel_exporter_endpoint="http://collector:4317")
        assert settings.otel_enabled is True


# ---------------------------------------------------------------------------
# create_app integration
# ---------------------------------------------------------------------------


class TestCreateAppObservability:
    def test_initializes_logger_provider_state(self):
        settings = Settings(port=5099)
        from text.main import create_app

        app = create_app(settings_override=settings)
        assert hasattr(app.state, "logger_provider")
        assert app.state.logger_provider is None

    def test_calls_setup_opentelemetry_when_a_collector_is_configured(self):
        settings = Settings(port=5099, otel_exporter_endpoint="http://collector:4317")
        with patch("text.core.observability.setup_opentelemetry") as mock_setup:
            from text.main import create_app

            create_app(settings_override=settings)
            mock_setup.assert_called_once()

    def test_skips_setup_when_no_collector_is_configured(self):
        settings = Settings(port=5099, otel_exporter_endpoint="")
        with patch("text.core.observability.setup_opentelemetry") as mock_setup:
            from text.main import create_app

            create_app(settings_override=settings)
            mock_setup.assert_not_called()
