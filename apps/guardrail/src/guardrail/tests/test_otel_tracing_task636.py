"""Guardrail OpenTelemetry tracing.

Guardrail — the platform's content-safety / PII / prompt-injection engine —
shipped with ZERO OTel code (``grep -rl opentelemetry apps/guardrail/src``
returned nothing). It is also the most compliance-sensitive service in the
fleet: every request carries raw clinical text into `/api/guardrail/analyze`
and `/api/medical/*`. This suite locks down the new
``guardrail.core.observability`` module (mirrors
`apps/text/src/text/core/observability.py`, the fleet's reference
implementation) plus its wiring into `guardrail.main.create_app`.

Four minimum guarantees:
  (a) tracing is off by default
  (b) it turns on only when the master switch AND an endpoint are both set
  (c) the PHI-sanitization hook is actually passed to the FastAPI instrumentor
      — a hook that is *defined* but never *wired* is exactly the OBS-19 defect
      already fixed once in NLP; this must not recur in guardrail
  (d) setup never raises when the exporter cannot be constructed — a
      reachable collector must never be a boot- or request-path dependency
      (default-OFF invariant)

RED: written before ``guardrail/core/observability.py`` exists.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider

from guardrail.core.config import Settings


def _force_reset_otel() -> None:
    """Force-reset OTel global tracer-provider state between tests."""
    import opentelemetry.trace as _trace_mod

    _trace_mod._TRACER_PROVIDER = None
    _trace_mod._TRACER_PROVIDER_SET_ONCE._done = False
    _trace_mod._PROXY_TRACER_PROVIDER._real_tracer_provider = None


@pytest.fixture(autouse=True)
def reset_otel():
    _force_reset_otel()
    yield
    _force_reset_otel()
    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

        HTTPXClientInstrumentor().uninstrument()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# (a) tracing is off by default
# ---------------------------------------------------------------------------


class TestOtelDisabledByDefault:
    def test_settings_default_otel_enabled_false(self) -> None:
        settings = Settings()
        assert settings.otel_enabled is False

    def test_create_app_does_not_call_setup_when_env_untouched(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("GUARDRAIL_V2_OTEL_ENABLED", raising=False)

        with patch("guardrail.core.observability.setup_opentelemetry") as mock_setup:
            from guardrail.main import create_app

            create_app()
            mock_setup.assert_not_called()


# ---------------------------------------------------------------------------
# (b) turns on only when BOTH the flag and an endpoint are set
# ---------------------------------------------------------------------------


class TestOtelEnabledGating:
    def test_calls_setup_when_flag_and_endpoint_set(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("GUARDRAIL_V2_OTEL_ENABLED", "true")
        monkeypatch.setenv("GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT", "http://collector:4317")

        with patch("guardrail.core.observability.setup_opentelemetry") as mock_setup:
            from guardrail.main import create_app

            create_app()
            mock_setup.assert_called_once()

    def test_skips_setup_when_flag_true_but_endpoint_empty(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The master switch alone is not enough — an empty endpoint must
        still keep tracing off (never crash on an unset collector address)."""
        monkeypatch.setenv("GUARDRAIL_V2_OTEL_ENABLED", "true")
        monkeypatch.setenv("GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT", "")

        with patch("guardrail.core.observability.setup_opentelemetry") as mock_setup:
            from guardrail.main import create_app

            create_app()
            mock_setup.assert_not_called()

    def test_skips_setup_when_endpoint_set_but_flag_false(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("GUARDRAIL_V2_OTEL_ENABLED", "false")
        monkeypatch.setenv("GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT", "http://collector:4317")

        with patch("guardrail.core.observability.setup_opentelemetry") as mock_setup:
            from guardrail.main import create_app

            create_app()
            mock_setup.assert_not_called()


# ---------------------------------------------------------------------------
# setup_opentelemetry — direct module tests
# ---------------------------------------------------------------------------


class TestSetupOpentelemetry:
    def test_creates_tracer_provider(self) -> None:
        from guardrail.core.observability import setup_opentelemetry

        app = MagicMock()
        setup_opentelemetry(app, endpoint="http://localhost:4317")

        provider = trace.get_tracer_provider()
        assert isinstance(provider, TracerProvider)
        assert app.state.tracer_provider is not None

    def test_resource_has_sdk_constants(self) -> None:
        from guardrail.core.observability import setup_opentelemetry

        app = MagicMock()
        setup_opentelemetry(app, endpoint="http://localhost:4317", service_name="guardrail-v2")

        provider = trace.get_tracer_provider()
        attrs = dict(provider.resource.attributes)
        assert attrs["telemetry.sdk.language"] == "python"
        assert attrs["service.name"] == "guardrail-v2"

    def test_excludes_health_and_metrics_urls(self) -> None:
        with patch("guardrail.core.observability.FastAPIInstrumentor") as MockFastAPI:
            from guardrail.core.observability import setup_opentelemetry

            app = MagicMock()
            setup_opentelemetry(app, endpoint="http://localhost:4317")

            call_kwargs = MockFastAPI.instrument_app.call_args.kwargs
            assert "excluded_urls" in call_kwargs
            assert "/api/v1/health" in call_kwargs["excluded_urls"]
            assert "/metrics" in call_kwargs["excluded_urls"]


# ---------------------------------------------------------------------------
# (c) the PHI hook is actually passed to the instrumentor — not just defined
# ---------------------------------------------------------------------------


class TestPhiSanitizationHookIsWired:
    def test_hook_is_passed_as_server_request_hook(self) -> None:
        with patch("guardrail.core.observability.FastAPIInstrumentor") as MockFastAPI:
            from guardrail.core.observability import (
                _phi_sanitization_hook,
                setup_opentelemetry,
            )

            app = MagicMock()
            setup_opentelemetry(app, endpoint="http://localhost:4317")

            call_kwargs = MockFastAPI.instrument_app.call_args.kwargs
            assert call_kwargs.get("server_request_hook") is _phi_sanitization_hook

    def test_hook_redacts_body_attributes(self) -> None:
        from guardrail.core.observability import _phi_sanitization_hook

        span = MagicMock()
        span.is_recording.return_value = True
        span.attributes = {
            "http.request.body.content": "chest pain, prescribed X",
            "http.response.body.content": "UNSAFE: medical advice",
        }

        _phi_sanitization_hook(span, {})

        span.set_attribute.assert_any_call("http.request.body.content", "[REDACTED]")
        span.set_attribute.assert_any_call("http.response.body.content", "[REDACTED]")

    def test_hook_is_noop_when_span_not_recording(self) -> None:
        from guardrail.core.observability import _phi_sanitization_hook

        span = MagicMock()
        span.is_recording.return_value = False

        _phi_sanitization_hook(span, {})

        span.set_attribute.assert_not_called()


# ---------------------------------------------------------------------------
# (d) setup never raises — an unreachable/misconfigured collector degrades
#     to no-tracing, not a crash
# ---------------------------------------------------------------------------


class TestSetupDegradesGracefully:
    def test_does_not_raise_when_span_exporter_construction_fails(self) -> None:
        with patch(
            "guardrail.core.observability.OTLPSpanExporter",
            side_effect=RuntimeError("collector unreachable"),
        ):
            from guardrail.core.observability import setup_opentelemetry

            app = MagicMock()
            # Must not raise.
            setup_opentelemetry(app, endpoint="http://unreachable-collector:4317")

    def test_tracer_provider_stays_none_on_failure(self) -> None:
        app = MagicMock()
        app.state.tracer_provider = None
        with patch(
            "guardrail.core.observability.OTLPSpanExporter",
            side_effect=RuntimeError("collector unreachable"),
        ):
            from guardrail.core.observability import setup_opentelemetry

            setup_opentelemetry(app, endpoint="http://unreachable-collector:4317")

        assert app.state.tracer_provider is None

    def test_does_not_raise_when_fastapi_instrumentation_fails(self) -> None:
        with patch("guardrail.core.observability.FastAPIInstrumentor") as MockFastAPI:
            MockFastAPI.instrument_app.side_effect = RuntimeError("instrumentation failed")

            from guardrail.core.observability import setup_opentelemetry

            app = MagicMock()
            # Must not raise even though instrumentation blew up mid-setup.
            setup_opentelemetry(app, endpoint="http://localhost:4317")


# ---------------------------------------------------------------------------
# shutdown_opentelemetry
# ---------------------------------------------------------------------------


class TestShutdownOpentelemetry:
    def test_shutdown_stops_tracer_provider(self) -> None:
        from guardrail.core.observability import shutdown_opentelemetry

        mock_tracer_provider = MagicMock()
        app = MagicMock()
        app.state.tracer_provider = mock_tracer_provider

        shutdown_opentelemetry(app)

        mock_tracer_provider.force_flush.assert_called_once()
        mock_tracer_provider.shutdown.assert_called_once()

    def test_shutdown_does_not_raise_when_no_provider(self) -> None:
        from guardrail.core.observability import shutdown_opentelemetry

        app = MagicMock()
        app.state.tracer_provider = None

        shutdown_opentelemetry(app)

    def test_shutdown_does_not_raise_when_provider_flush_fails(self) -> None:
        from guardrail.core.observability import shutdown_opentelemetry

        mock_tracer_provider = MagicMock()
        mock_tracer_provider.force_flush.side_effect = RuntimeError("flush failed")
        app = MagicMock()
        app.state.tracer_provider = mock_tracer_provider

        shutdown_opentelemetry(app)


# ---------------------------------------------------------------------------
# get_tracer
# ---------------------------------------------------------------------------


class TestGetTracer:
    def test_returns_a_usable_tracer(self) -> None:
        from guardrail.core.observability import get_tracer

        tracer = get_tracer()
        assert tracer is not None
        assert hasattr(tracer, "start_as_current_span")
