"""TDD tests for TTS OpenTelemetry tracing.

TTS had ZERO OTel code before this — no traces, no PHI-redaction hook on the
HTTP surface that receives clinical text to synthesise. This file locks down
the invariant (default OFF, never require a reachable collector to
boot/serve) plus the OBS-19 lesson from NLP: a PHI-sanitisation hook that
exists but is never passed to ``FastAPIInstrumentor`` is the same as no hook
at all.

Covers:
  (a) tracing is off by default
  (b) tracing turns on only when BOTH the master switch AND an endpoint are set
  (c) the PHI hook is actually wired into FastAPIInstrumentor.instrument_app
  (d) setup_opentelemetry never raises, even if the exporter can't be built
"""

from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider

from tts.core.config import Settings


def _force_reset_otel() -> None:
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


def _cleanup_root_logging_handlers() -> None:
    from opentelemetry.sdk._logs import LoggingHandler

    root = logging.getLogger()
    root.handlers = [h for h in root.handlers if not isinstance(h, LoggingHandler)]


@pytest.fixture(autouse=True)
def reset_otel():
    # ``HTTPXClientInstrumentor().instrument()`` patches ``httpx`` at the
    # PROCESS level (not per-app). Every test in this module that exercises
    # the real (unmocked) ``setup_opentelemetry`` would otherwise leave that
    # global monkeypatch in place for the rest of the pytest session, which
    # breaks every other TTS test that drives the app via
    # ``httpx.AsyncClient(transport=ASGITransport(...))``. No test here
    # asserts on HTTPX instrumentation itself, so it is neutralised for the
    # whole module.
    with patch("tts.core.observability.HTTPXClientInstrumentor"):
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
# (a) Settings — off by default
# ---------------------------------------------------------------------------


class TestOtelSettingsDefaults:
    def test_otel_disabled_by_default(self) -> None:
        assert Settings().otel_enabled is False

    def test_otel_exporter_endpoint_empty_by_default(self) -> None:
        # No hardcoded localhost default — an unset endpoint must never be
        # mistaken for "configured".
        assert Settings().otel_exporter_endpoint == ""

    def test_otel_enabled_from_env(self, monkeypatch) -> None:
        monkeypatch.setenv("TTS_OTEL_ENABLED", "true")
        assert Settings().otel_enabled is True

    def test_otel_exporter_endpoint_from_env(self, monkeypatch) -> None:
        monkeypatch.setenv("TTS_OTEL_EXPORTER_ENDPOINT", "http://collector:4317")
        assert Settings().otel_exporter_endpoint == "http://collector:4317"

    def test_otel_service_name_default(self) -> None:
        assert Settings().otel_service_name == "tts"


# ---------------------------------------------------------------------------
# (b) create_app wiring — on only when flag AND endpoint are both set
# ---------------------------------------------------------------------------


class TestCreateAppOtelWiring:
    def test_setup_not_called_when_disabled(self) -> None:
        settings = Settings(
            host="127.0.0.1",
            port=5099,
            otel_enabled=False,
            otel_exporter_endpoint="http://collector:4317",
            metrics_enabled=False,
        )
        with patch("tts.core.observability.setup_opentelemetry") as mock_setup:
            from tts.main import create_app

            create_app(settings_override=settings)
            mock_setup.assert_not_called()

    def test_setup_not_called_when_endpoint_missing(self) -> None:
        settings = Settings(
            host="127.0.0.1",
            port=5099,
            otel_enabled=True,
            otel_exporter_endpoint="",
            metrics_enabled=False,
        )
        with patch("tts.core.observability.setup_opentelemetry") as mock_setup:
            from tts.main import create_app

            create_app(settings_override=settings)
            mock_setup.assert_not_called()

    def test_setup_called_when_flag_and_endpoint_set(self) -> None:
        settings = Settings(
            host="127.0.0.1",
            port=5099,
            otel_enabled=True,
            otel_exporter_endpoint="http://collector:4317",
            metrics_enabled=False,
        )
        with patch("tts.core.observability.setup_opentelemetry") as mock_setup:
            from tts.main import create_app

            create_app(settings_override=settings)
            mock_setup.assert_called_once()

    def test_app_boots_with_otel_enabled_and_unreachable_endpoint(self) -> None:
        """Startup must not fail even with a real (unreachable) collector
        endpoint configured — invariant.

        ``FastAPIInstrumentor``/``HTTPXClientInstrumentor`` are mocked here
        (matching the SMR reference test suite, which never runs real
        instrumentation): ``HTTPXClientInstrumentor.instrument`` patches
        ``httpx`` at the PROCESS level, which would otherwise break every
        other test's ``httpx.AsyncClient(transport=ASGITransport(...))``
        client for the rest of the session. Resource/TracerProvider/exporter
        construction against the bogus endpoint still runs for real.
        """
        settings = Settings(
            host="127.0.0.1",
            port=5099,
            otel_enabled=True,
            otel_exporter_endpoint="http://localhost:1",
            metrics_enabled=False,
        )
        with (
            patch("tts.core.observability.FastAPIInstrumentor") as MockFastAPI,
            patch("tts.core.observability.HTTPXClientInstrumentor"),
        ):
            from tts.main import create_app

            app = create_app(settings_override=settings)
            assert app is not None
            assert MockFastAPI.instrument_app.called


# ---------------------------------------------------------------------------
# (c) PHI sanitisation hook is actually wired into the instrumentor
# ---------------------------------------------------------------------------


class TestPhiHookWiring:
    def test_phi_hook_passed_to_fastapi_instrumentor(self) -> None:
        with patch("tts.core.observability.FastAPIInstrumentor") as MockFastAPI:
            from tts.core.observability import _phi_sanitization_hook, setup_opentelemetry

            app = MagicMock()
            setup_opentelemetry(app, endpoint="http://localhost:4317")

            call_kwargs = MockFastAPI.instrument_app.call_args
            assert call_kwargs is not None, "FastAPIInstrumentor.instrument_app was never called"
            assert call_kwargs.kwargs.get("server_request_hook") is _phi_sanitization_hook

    def test_phi_hook_redacts_body_attributes(self) -> None:
        from tts.core.observability import _phi_sanitization_hook

        span = MagicMock()
        span.is_recording.return_value = True
        span.attributes = {
            "http.request.body.content": "clinical text to synthesise",
            "http.response.body.content": "diagnosis audio",
        }

        _phi_sanitization_hook(span, {})

        span.set_attribute.assert_any_call("http.request.body.content", "[REDACTED]")
        span.set_attribute.assert_any_call("http.response.body.content", "[REDACTED]")

    def test_phi_hook_noop_when_not_recording(self) -> None:
        from tts.core.observability import _phi_sanitization_hook

        span = MagicMock()
        span.is_recording.return_value = False

        _phi_sanitization_hook(span, {})

        span.set_attribute.assert_not_called()

    def test_excludes_health_and_metrics_urls(self) -> None:
        with patch("tts.core.observability.FastAPIInstrumentor") as MockFastAPI:
            from tts.core.observability import setup_opentelemetry

            app = MagicMock()
            setup_opentelemetry(app, endpoint="http://localhost:4317")

            call_kwargs = MockFastAPI.instrument_app.call_args
            excluded = call_kwargs.kwargs["excluded_urls"]
            assert "/api/v1/health" in excluded
            assert "/metrics" in excluded


# ---------------------------------------------------------------------------
# (d) setup_opentelemetry never raises — collector-unreachable degradation
# ---------------------------------------------------------------------------


class TestSetupDoesNotRaise:
    def test_does_not_raise_when_span_exporter_construction_fails(self) -> None:
        with patch(
            "tts.core.observability.OTLPSpanExporter",
            side_effect=RuntimeError("collector unreachable"),
        ):
            from tts.core.observability import setup_opentelemetry

            app = MagicMock()
            # Must not raise.
            setup_opentelemetry(app, endpoint="http://localhost:4317")

    def test_does_not_raise_when_log_exporter_construction_fails(self) -> None:
        with patch(
            "tts.core.observability.OTLPLogExporter",
            side_effect=RuntimeError("collector unreachable"),
        ):
            from tts.core.observability import setup_opentelemetry

            app = MagicMock()
            setup_opentelemetry(app, endpoint="http://localhost:4317", logs_enabled=True)

    def test_does_not_raise_on_resource_create_failure(self) -> None:
        with patch(
            "tts.core.observability.Resource.create",
            side_effect=RuntimeError("boom"),
        ):
            from tts.core.observability import setup_opentelemetry

            app = MagicMock()
            setup_opentelemetry(app, endpoint="http://localhost:4317")


# ---------------------------------------------------------------------------
# Basic setup/shutdown behavior (parity with the SMR reference implementation)
# ---------------------------------------------------------------------------


class TestSetupOpentelemetry:
    def test_creates_tracer_provider(self) -> None:
        from tts.core.observability import setup_opentelemetry

        app = MagicMock()
        setup_opentelemetry(app, endpoint="http://localhost:4317")

        provider = trace.get_tracer_provider()
        assert isinstance(provider, TracerProvider)
        assert app.state.tracer_provider is not None

    def test_resource_has_service_name(self) -> None:
        from tts.core.observability import setup_opentelemetry

        app = MagicMock()
        setup_opentelemetry(app, endpoint="http://localhost:4317", service_name="tts")

        provider = trace.get_tracer_provider()
        attrs = dict(provider.resource.attributes)
        assert attrs["service.name"] == "tts"
        assert attrs["telemetry.sdk.language"] == "python"


class TestShutdownOpentelemetry:
    def test_shutdown_stops_tracer_provider(self) -> None:
        from tts.core.observability import shutdown_opentelemetry

        mock_tracer = MagicMock()
        app = MagicMock()
        app.state.tracer_provider = mock_tracer
        app.state.logger_provider = None

        shutdown_opentelemetry(app)

        mock_tracer.force_flush.assert_called_once()
        mock_tracer.shutdown.assert_called_once()

    def test_shutdown_does_not_raise_with_no_providers(self) -> None:
        from tts.core.observability import shutdown_opentelemetry

        app = MagicMock()
        app.state.tracer_provider = None
        app.state.logger_provider = None

        shutdown_opentelemetry(app)  # must not raise


class TestDeploymentEnvironmentIsNotHardcoded:
    """Fleet-wide regression guard.

    `apps/text/core/config.py` is the reference every service's OTel setup was
    copied from, and it defaulted to "production". TTS, harness and STT all
    inherited that literal. A hardcoded "production" tags a developer laptop's
    spans as production data: a mislabelled dev span is noise, a mislabelled
    prod span corrupts an audit trail.
    """

    def test_defaults_to_development_never_production(self, monkeypatch) -> None:
        from tts.core.config import Settings

        monkeypatch.delenv("DEPLOYMENT_ENVIRONMENT", raising=False)
        monkeypatch.delenv("NODE_ENV", raising=False)

        assert Settings().otel_deployment_environment == "development"

    def test_reads_deployment_environment(self, monkeypatch) -> None:
        from tts.core.config import Settings

        monkeypatch.setenv("DEPLOYMENT_ENVIRONMENT", "staging")

        assert Settings().otel_deployment_environment == "staging"
