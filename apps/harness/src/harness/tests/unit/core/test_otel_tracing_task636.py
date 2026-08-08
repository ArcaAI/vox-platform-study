"""OpenTelemetry tracing setup for harness (TASK-636 OBS-14).

Before this, harness had NO ``TracerProvider`` anywhere — the only
``opentelemetry`` reference in the service was a comment in ``core/config.py``
explaining that none was ever constructed, which meant ``core/logging.py``'s
``_add_otel_context`` structlog processor was always reading ``INVALID_SPAN``.
This suite covers the FastAPI side (``core/observability.py``) and the
Temporal side (``temporal/client.py``'s ``TracingInterceptor`` wiring),
including their coexistence with the OBS-06 Temporal metrics ``Runtime``
(``temporal/metrics.py``), which must still be built exactly once per process.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from temporalio.contrib.opentelemetry import TracingInterceptor

from harness.core.config import Settings
from harness.core.observability import build_tracer_provider, setup_opentelemetry
from harness.temporal.client import _tracing_interceptors
from harness.temporal.metrics import build_runtime, reset_runtime_for_tests


def _enabled_settings(**overrides: Any) -> Settings:
    return Settings(
        otel_enabled=True,
        otel_exporter_endpoint="http://localhost:4317",
        **overrides,
    )


# -- (a)/(b) the gate: off by default, on only when BOTH flag and endpoint are set ---


class TestOtelTracingEnabledGate:
    def test_off_by_default(self) -> None:
        assert Settings().otel_enabled is False
        assert Settings().otel_tracing_enabled is False

    def test_flag_alone_without_endpoint_stays_off(self) -> None:
        """TASK-411: flipping the switch with no collector configured is a no-op."""
        settings = Settings(otel_enabled=True, otel_exporter_endpoint="")
        assert settings.otel_tracing_enabled is False

    def test_endpoint_alone_without_flag_stays_off(self) -> None:
        settings = Settings(otel_enabled=False, otel_exporter_endpoint="http://localhost:4317")
        assert settings.otel_tracing_enabled is False

    def test_flag_and_endpoint_together_enable_tracing(self) -> None:
        assert _enabled_settings().otel_tracing_enabled is True


# -- build_tracer_provider ------------------------------------------------------------


class TestBuildTracerProvider:
    def test_returns_none_when_disabled(self) -> None:
        assert build_tracer_provider(Settings()) is None

    def test_returns_provider_when_enabled(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # A unit test must not mutate the real process-global tracer provider.
        monkeypatch.setattr("harness.core.observability.trace.set_tracer_provider", lambda *_: None)

        provider = build_tracer_provider(_enabled_settings())

        assert provider is not None

    def test_never_raises_when_exporter_construction_fails(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """(d) TASK-411: an unreachable/misconfigured collector must degrade, not crash."""

        def _boom(*_args: Any, **_kwargs: Any) -> Any:
            raise RuntimeError("collector unreachable")

        monkeypatch.setattr("harness.core.observability.OTLPSpanExporter", _boom)

        result = build_tracer_provider(_enabled_settings())

        assert result is None


# -- FastAPI wiring: the PHI hook must reach the instrumentor -------------------------


class TestSetupOpentelemetryFastapi:
    def test_no_instrumentation_when_disabled(self, monkeypatch: pytest.MonkeyPatch) -> None:
        called = False

        def _fake_instrument_app(*_args: Any, **_kwargs: Any) -> None:
            nonlocal called
            called = True

        monkeypatch.setattr(
            "harness.core.observability.FastAPIInstrumentor.instrument_app",
            _fake_instrument_app,
        )

        app = FastAPI()
        setup_opentelemetry(app, Settings())

        assert called is False
        assert app.state.tracer_provider is None

    def test_phi_hook_passed_to_instrumentor(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """(c) the PHI sanitisation hook must be wired into FastAPI instrumentation."""
        monkeypatch.setattr("harness.core.observability.trace.set_tracer_provider", lambda *_: None)

        captured: dict[str, Any] = {}

        def _fake_instrument_app(_app: FastAPI, **kwargs: Any) -> None:
            captured.update(kwargs)

        monkeypatch.setattr(
            "harness.core.observability.FastAPIInstrumentor.instrument_app",
            _fake_instrument_app,
        )

        app = FastAPI()
        setup_opentelemetry(app, _enabled_settings())

        from harness.core.observability import _phi_sanitization_hook

        assert captured.get("server_request_hook") is _phi_sanitization_hook
        assert app.state.tracer_provider is not None

    def test_setup_does_not_raise_when_tracer_provider_build_fails(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """(d) mirrors the same guarantee at the FastAPI wiring layer."""

        def _boom(*_args: Any, **_kwargs: Any) -> Any:
            raise RuntimeError("collector unreachable")

        monkeypatch.setattr("harness.core.observability.OTLPSpanExporter", _boom)

        app = FastAPI()
        setup_opentelemetry(app, _enabled_settings())  # must not raise

        assert app.state.tracer_provider is None


# -- Temporal wiring: TracingInterceptor -----------------------------------------------


class TestTemporalTracingInterceptors:
    def test_empty_when_tracing_disabled(self) -> None:
        assert _tracing_interceptors(Settings()) == []

    def test_tracing_interceptor_present_when_enabled(self) -> None:
        interceptors = _tracing_interceptors(_enabled_settings())

        assert len(interceptors) == 1
        assert isinstance(interceptors[0], TracingInterceptor)

    def test_never_raises_when_interceptor_construction_fails(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _boom(*_args: Any, **_kwargs: Any) -> Any:
            raise RuntimeError("opentelemetry misconfigured")

        monkeypatch.setattr("temporalio.contrib.opentelemetry.TracingInterceptor", _boom)

        assert _tracing_interceptors(_enabled_settings()) == []


# -- Coexistence with OBS-06: the Temporal Runtime is still built exactly once --------


class TestCoexistenceWithTemporalMetricsRuntime:
    @pytest.fixture(autouse=True)
    def _reset_memo(self):
        reset_runtime_for_tests()
        yield
        reset_runtime_for_tests()

    def test_runtime_still_built_exactly_once_with_tracing_enabled(self) -> None:
        """(e) a Temporal ``Runtime`` must be constructed ONCE per process.

        OTel tracing is wired entirely through client-level ``interceptors``
        (``temporal/client.py``) — it must not add a second call path that
        constructs another ``Runtime`` alongside the OBS-06 metrics one.
        """
        settings = _enabled_settings(metrics_enabled=True, temporal_metrics_port=0)

        first = build_runtime(settings)
        second = build_runtime(settings)

        assert first is second


class TestDeploymentEnvironmentIsNotHardcoded:
    """TASK-636 OBS-18 — regression guard.

    The first implementation of this config defaulted
    `otel_deployment_environment` to "production", which is the exact defect
    fixed in `apps/stt/core/telemetry.py` earlier in this ticket. An unset
    environment on a developer laptop would tag local spans as production
    data. A mislabelled dev span is noise; a mislabelled prod span corrupts an
    audit trail.
    """

    def test_defaults_to_development_never_production(self, monkeypatch) -> None:
        from harness.core.config import Settings

        monkeypatch.delenv("DEPLOYMENT_ENVIRONMENT", raising=False)
        monkeypatch.delenv("NODE_ENV", raising=False)

        assert Settings().otel_deployment_environment == "development"

    def test_reads_deployment_environment(self, monkeypatch) -> None:
        from harness.core.config import Settings

        monkeypatch.setenv("DEPLOYMENT_ENVIRONMENT", "staging")

        assert Settings().otel_deployment_environment == "staging"

    def test_falls_back_to_node_env(self, monkeypatch) -> None:
        from harness.core.config import Settings

        monkeypatch.delenv("DEPLOYMENT_ENVIRONMENT", raising=False)
        monkeypatch.setenv("NODE_ENV", "test")

        assert Settings().otel_deployment_environment == "test"
