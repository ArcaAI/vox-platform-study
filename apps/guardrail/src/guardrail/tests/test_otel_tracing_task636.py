"""Guardrail OpenTelemetry tracing — now wired through `hope_obs` (TASK-987).

Ported from the original TASK-636 suite, which locked
`guardrail.core.observability`'s own hand-rolled OTel setup (mirroring
`apps/text/src/text/core/observability.py`) before that module was replaced by
calls into the shared `hope_obs` package
(``docs/implementation/TASK-987-Python-Logging-And-Tracing-Standard/README.md``
§3, R-1..R-8). The four guarantees this suite existed to prove are unchanged —
only how each is wired changed, so the assertions below target the new
call sites (`build_observability_config`, `setup_observability`,
`shutdown_opentelemetry`) instead of the retired `setup_opentelemetry` /
`_phi_sanitization_hook` / module-level `FastAPIInstrumentor` /
`OTLPSpanExporter` names this file used to patch:

  (a) tracing is off by default
  (b) it turns on when — and only when — an OTLP endpoint resolves. R-2
      replaces the old "master switch AND endpoint" AND-gate with endpoint
      presence ALONE; the retired `GUARDRAIL_V2_OTEL_ENABLED` flag survives as
      an explicit OFF-switch for one more release and is never silently
      ignored (it can no longer turn tracing ON by itself)
  (c) the PHI-sanitization hook is wired UNCONDITIONALLY — now `hope_obs`'s
      own guarantee (`hope_obs.tracing.instrument_fastapi` always passes
      `phi_sanitization_hook`); asserted here by confirming guardrail's own
      call path reaches the real FastAPI instrumentor with it attached
  (d) setup never raises — `hope_obs.configure_observability`'s guarantee,
      asserted here through guardrail's own `setup_observability` call site,
      including the corrected R-2 split between a CONFIGURATION failure
      (provider stays unset) and a RUNTIME export failure such as an
      unroutable-but-well-formed endpoint (provider stays set — the gRPC
      exporter connects lazily)

Also locks F-09: guardrail's OLD resource (`core/observability.py` before this
ticket) carried `service.name`/`.version`/`.namespace`/
`telemetry.sdk.language` and NO `deployment.environment` at all, rescued
in-cluster only by the collector's `resource` processor
(`action: insert`). `hope_obs.tracing.build_resource` fixes that at the
SOURCE — see `TestResourceAttributes` below.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from hope_obs.phi import phi_sanitization_hook
from hope_obs.tracing import build_resource
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider

from guardrail.core.config import Settings
from guardrail.core.observability import (
    build_observability_config,
    get_tracer,
    setup_observability,
    shutdown_opentelemetry,
)


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


@pytest.fixture(autouse=True)
def _clean_otel_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """No test here should be affected by the developer's shell or `.env.test`."""
    for var in (
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT",
        "GUARDRAIL_V2_OTEL_ENABLED",
        "GUARDRAIL_V2_LOG_LEVEL",
        "DEPLOYMENT_ENVIRONMENT",
        "NODE_ENV",
    ):
        monkeypatch.delenv(var, raising=False)


# ---------------------------------------------------------------------------
# (a) tracing is off by default
# ---------------------------------------------------------------------------


class TestOtelDisabledByDefault:
    def test_settings_default_otel_enabled_false(self) -> None:
        settings = Settings()
        assert settings.otel_enabled is False

    def test_build_config_has_no_endpoint_when_env_untouched(self) -> None:
        config = build_observability_config(Settings())
        assert config.tracing_enabled is False
        assert config.otlp_endpoint is None

    def test_setup_observability_leaves_tracer_provider_none(self) -> None:
        app = FastAPI()
        setup_observability(app, Settings())
        assert app.state.tracer_provider is None


# ---------------------------------------------------------------------------
# (b) endpoint presence is the ONLY enable signal (R-2); the legacy flag
#     survives as an explicit off-switch, never silently ignored
# ---------------------------------------------------------------------------


class TestOtelEnabledGating:
    def test_generic_endpoint_var_enables_tracing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4317")

        config = build_observability_config(Settings())

        assert config.tracing_enabled is True
        assert config.otlp_endpoint == "http://collector:4317"

    def test_legacy_guardrail_endpoint_var_enables_tracing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The exact shape lane D1 deployed: `GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT`
        set, the fleet-wide `OTEL_EXPORTER_OTLP_ENDPOINT` name left unset.
        `ObservabilityConfig.from_env` alone would miss this (it only reads the
        generic name) — the exact F-02 shape one layer down from the log-level
        trap. Guardrail's own `_resolve_otlp_endpoint` is what closes it."""
        monkeypatch.setenv("GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT", "http://collector:4317")

        config = build_observability_config(Settings())

        assert config.tracing_enabled is True
        assert config.otlp_endpoint == "http://collector:4317"

    def test_generic_var_wins_over_legacy_when_both_set(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://generic:4317")
        monkeypatch.setenv("GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT", "http://legacy:4317")

        config = build_observability_config(Settings())

        assert config.otlp_endpoint == "http://generic:4317"

    def test_legacy_flag_false_forces_tracing_off_even_with_endpoint(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An operator who set the flag to disable tracing must not have it
        silently overridden the moment guardrail adopts endpoint-presence
        gating — the flag is honoured, not read."""
        monkeypatch.setenv("GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT", "http://collector:4317")
        monkeypatch.setenv("GUARDRAIL_V2_OTEL_ENABLED", "false")

        config = build_observability_config(Settings())

        assert config.tracing_enabled is False
        assert config.otlp_endpoint is None

    def test_legacy_flag_true_does_not_disable_when_endpoint_present(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT", "http://collector:4317")
        monkeypatch.setenv("GUARDRAIL_V2_OTEL_ENABLED", "true")

        config = build_observability_config(Settings())

        assert config.tracing_enabled is True

    def test_legacy_flag_absent_endpoint_alone_decides(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("GUARDRAIL_V2_OTEL_ENABLED", raising=False)
        monkeypatch.setenv("GUARDRAIL_V2_OTEL_EXPORTER_ENDPOINT", "http://collector:4317")

        config = build_observability_config(Settings())

        assert config.tracing_enabled is True

    def test_legacy_flag_present_logs_deprecation_warning(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("GUARDRAIL_V2_OTEL_ENABLED", "true")

        with patch("guardrail.core.observability.logger") as mock_logger:
            build_observability_config(Settings())

        mock_logger.warning.assert_called_once()
        assert mock_logger.warning.call_args.args[0] == "guardrail.otel_enabled_flag.deprecated"

    def test_no_flag_no_warning(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("GUARDRAIL_V2_OTEL_ENABLED", raising=False)

        with patch("guardrail.core.observability.logger") as mock_logger:
            build_observability_config(Settings())

        mock_logger.warning.assert_not_called()


# ---------------------------------------------------------------------------
# GUARDRAIL_V2_LOG_LEVEL — the trap named in the TASK-987 lane C brief
# ---------------------------------------------------------------------------


class TestLogLevelPrefix:
    def test_reads_guardrail_v2_prefixed_log_level(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """`ObservabilityConfig.from_env("guardrail")` alone would look for
        `GUARDRAIL_LOG_LEVEL` (derived from the service_name ARGUMENT) and miss
        this fleet's actual `GUARDRAIL_V2_LOG_LEVEL` (guardrail's root Settings
        carries `env_prefix="GUARDRAIL_V2_"`). `build_observability_config`
        closes the gap by reading it through `settings.log_level`, which
        pydantic already resolved correctly."""
        monkeypatch.setenv("GUARDRAIL_V2_LOG_LEVEL", "debug")

        config = build_observability_config(Settings())

        assert config.log_level == "debug"

    def test_default_log_level_is_info(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("GUARDRAIL_V2_LOG_LEVEL", raising=False)
        monkeypatch.delenv("LOG_LEVEL", raising=False)

        config = build_observability_config(Settings())

        assert config.log_level == "info"


# ---------------------------------------------------------------------------
# F-09 — deployment.environment, absent before this ticket, now on every span
# ---------------------------------------------------------------------------


class TestResourceAttributes:
    def test_deployment_environment_present_both_spellings(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DEPLOYMENT_ENVIRONMENT", "hope-v2-dev")

        config = build_observability_config(Settings())
        attrs = dict(build_resource(config).attributes)

        assert attrs["deployment.environment"] == "hope-v2-dev"
        assert attrs["deployment.environment.name"] == "hope-v2-dev"

    def test_defaults_to_development_never_production(self) -> None:
        config = build_observability_config(Settings())
        attrs = dict(build_resource(config).attributes)

        assert attrs["deployment.environment"] == "development"
        assert attrs["deployment.environment.name"] == "development"


# ---------------------------------------------------------------------------
# setup_observability — direct module tests
# ---------------------------------------------------------------------------


class TestSetupObservability:
    def test_creates_tracer_provider(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")

        app = FastAPI()
        setup_observability(app, Settings())

        provider = trace.get_tracer_provider()
        assert isinstance(provider, TracerProvider)
        assert app.state.tracer_provider is not None

    def test_resource_has_sdk_constants(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
        monkeypatch.setenv("OTEL_SERVICE_NAME", "guardrail-v2")

        app = FastAPI()
        setup_observability(app, Settings())

        provider = trace.get_tracer_provider()
        attrs = dict(provider.resource.attributes)
        assert attrs["telemetry.sdk.language"] == "python"
        assert attrs["service.name"] == "guardrail-v2"

    def test_excludes_health_and_metrics_urls(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")

        with patch(
            "opentelemetry.instrumentation.fastapi.FastAPIInstrumentor.instrument_app"
        ) as mock_instrument:
            app = FastAPI()
            setup_observability(app, Settings())

        call_kwargs = mock_instrument.call_args.kwargs
        assert "excluded_urls" in call_kwargs
        assert "/api/v1/health" in call_kwargs["excluded_urls"]
        assert "/metrics" in call_kwargs["excluded_urls"]


# ---------------------------------------------------------------------------
# (c) the PHI hook is actually passed to the instrumentor — not just defined
# ---------------------------------------------------------------------------


class TestPhiSanitizationHookIsWired:
    def test_hook_is_passed_as_server_request_hook(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")

        with patch(
            "opentelemetry.instrumentation.fastapi.FastAPIInstrumentor.instrument_app"
        ) as mock_instrument:
            app = FastAPI()
            setup_observability(app, Settings())

        call_kwargs = mock_instrument.call_args.kwargs
        assert call_kwargs.get("server_request_hook") is phi_sanitization_hook

    def test_hook_redacts_body_attributes(self) -> None:
        span = MagicMock()
        span.is_recording.return_value = True
        span.attributes = {
            "http.request.body.content": "chest pain, prescribed X",
            "http.response.body.content": "UNSAFE: medical advice",
        }

        phi_sanitization_hook(span, {})

        span.set_attribute.assert_any_call("http.request.body.content", "[REDACTED]")
        span.set_attribute.assert_any_call("http.response.body.content", "[REDACTED]")

    def test_hook_is_noop_when_span_not_recording(self) -> None:
        span = MagicMock()
        span.is_recording.return_value = False

        phi_sanitization_hook(span, {})

        span.set_attribute.assert_not_called()


# ---------------------------------------------------------------------------
# (d) setup never raises — an unreachable/misconfigured collector degrades
#     to no-tracing (configuration failure) or stays enabled and buffers
#     (runtime export failure), but never crashes the boot
# ---------------------------------------------------------------------------


class TestSetupDegradesGracefully:
    def test_unroutable_endpoint_does_not_raise_and_stays_enabled(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A syntactically valid but unroutable endpoint is a RUNTIME export
        failure — the gRPC exporter connects lazily, so this is invisible at
        configure time. `tracer_provider` stays SET (TASK-987's corrected R-2
        split); only a genuine construction/instrumentation failure clears it."""
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://unreachable-collector:4317")

        app = FastAPI()
        setup_observability(app, Settings())  # must not raise

        assert app.state.tracer_provider is not None

    def test_does_not_raise_when_exporter_construction_fails(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")

        with patch(
            "opentelemetry.exporter.otlp.proto.grpc.trace_exporter.OTLPSpanExporter",
            side_effect=RuntimeError("collector unreachable"),
        ):
            app = FastAPI()
            setup_observability(app, Settings())  # must not raise

    def test_tracer_provider_stays_none_on_configuration_failure(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")

        with patch(
            "opentelemetry.exporter.otlp.proto.grpc.trace_exporter.OTLPSpanExporter",
            side_effect=RuntimeError("collector unreachable"),
        ):
            app = FastAPI()
            setup_observability(app, Settings())

        assert app.state.tracer_provider is None

    def test_does_not_raise_when_fastapi_instrumentation_fails(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")

        with patch(
            "opentelemetry.instrumentation.fastapi.FastAPIInstrumentor.instrument_app",
            side_effect=RuntimeError("instrumentation failed"),
        ):
            app = FastAPI()
            setup_observability(app, Settings())  # must not raise


# ---------------------------------------------------------------------------
# shutdown_opentelemetry
# ---------------------------------------------------------------------------


class TestShutdownOpentelemetry:
    def test_shutdown_stops_tracer_provider(self) -> None:
        mock_tracer_provider = MagicMock()
        app = MagicMock()
        app.state.tracer_provider = mock_tracer_provider

        shutdown_opentelemetry(app)

        mock_tracer_provider.force_flush.assert_called_once()
        mock_tracer_provider.shutdown.assert_called_once()

    def test_shutdown_does_not_raise_when_no_provider(self) -> None:
        app = MagicMock()
        app.state.tracer_provider = None

        shutdown_opentelemetry(app)

    def test_shutdown_does_not_raise_when_provider_flush_fails(self) -> None:
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
        # `hope_obs.get_tracer` takes `name` with no default (unlike the
        # retired local `get_tracer(name: str = "guardrail")`) — ported call.
        tracer = get_tracer("guardrail")
        assert tracer is not None
        assert hasattr(tracer, "start_as_current_span")
