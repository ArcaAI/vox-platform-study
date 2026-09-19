"""OpenTelemetry tracing setup for harness (TASK-636, ported for TASK-987).

Before TASK-636, harness had NO ``TracerProvider`` anywhere. TASK-987 moved
the actual tracer/exporter/instrumentation implementation into the shared
``hope_obs`` package (R-1..R-8) — harness's own job is now only to (a) map
its ``Settings`` onto an ``hope_obs.ObservabilityConfig``
(``core/observability.py::build_observability_config``) and (b) wire that
config into ``create_app()`` / ``run_worker()`` at the right point.

This suite therefore covers HARNESS'S OWN wiring — the config mapping, the
deprecated-flag veto, and that ``create_app()``/the worker actually install
what ``build_observability_config`` says to — not ``hope_obs`` internals
(sampler construction, exporter degrade-to-off, the PHI hook itself), which
are ``packages/py-obs/tests``' job. It also still covers the Temporal side
(``temporal/client.py``'s ``TracingInterceptor`` wiring), including its
coexistence with the OBS-06 Temporal metrics ``Runtime``
(``temporal/metrics.py``), neither of which this ticket touched.
"""

from __future__ import annotations

from typing import Any

import pytest
from opentelemetry.sdk.trace import TracerProvider
from temporalio.contrib.opentelemetry import TracingInterceptor

from harness.core.config import Settings
from harness.core.observability import (
    OTEL_ENABLED_ENV_VAR,
    build_observability_config,
    otel_enabled_flag_is_set,
)
from harness.main import create_app
from harness.temporal.client import _tracing_interceptors
from harness.temporal.metrics import build_runtime, reset_runtime_for_tests


def _enabled_settings(**overrides: Any) -> Settings:
    return Settings(
        otel_enabled=True,
        otel_exporter_endpoint="http://localhost:4317",
        **overrides,
    )


# -- (a)/(b) the OLD gate — Settings.otel_tracing_enabled, unchanged, still read
# -- by temporal/client.py's TracingInterceptor wiring (deliberately untouched) ---


class TestOtelTracingEnabledGate:
    def test_off_by_default(self) -> None:
        assert Settings().otel_enabled is False
        assert Settings().otel_tracing_enabled is False

    def test_flag_alone_without_endpoint_stays_off(self) -> None:
        """Flipping the switch with no collector configured is a no-op."""
        settings = Settings(otel_enabled=True, otel_exporter_endpoint="")
        assert settings.otel_tracing_enabled is False

    def test_endpoint_alone_without_flag_stays_off(self) -> None:
        settings = Settings(otel_enabled=False, otel_exporter_endpoint="http://localhost:4317")
        assert settings.otel_tracing_enabled is False

    def test_flag_and_endpoint_together_enable_tracing(self) -> None:
        assert _enabled_settings().otel_tracing_enabled is True


# -- build_observability_config — the new R-2 mapping ----------------------------------


class TestBuildObservabilityConfig:
    def test_disabled_by_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(OTEL_ENABLED_ENV_VAR, raising=False)

        config = build_observability_config(Settings())

        assert config.tracing_enabled is False
        assert config.otlp_endpoint is None

    def test_endpoint_alone_enables_tracing_r2(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """R-2: endpoint presence alone is the enable signal — no flag required.

        This is the F-01/F-02 fix generalised: a manifest that sets only
        ``HARNESS_OTEL_EXPORTER_ENDPOINT`` (never ``HARNESS_OTEL_ENABLED``) now
        gets tracing, where the pre-TASK-987 code stayed dark.
        """
        monkeypatch.delenv(OTEL_ENABLED_ENV_VAR, raising=False)
        settings = Settings(otel_enabled=False, otel_exporter_endpoint="http://localhost:4317")

        config = build_observability_config(settings)

        assert config.tracing_enabled is True
        assert config.otlp_endpoint == "http://localhost:4317"

    def test_otel_service_name_env_renames_the_resource(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """``OTEL_SERVICE_NAME`` is the name the DEPLOYMENT chooses (py-obs contract).

        Harness passed ``settings.otel_service_name`` unconditionally, so the
        generic variable every other service honours was never read. In the
        dev cluster harness reported ``service.name=harness`` in both logs and
        traces while the fleet reported ``hope-*`` — which breaks Grafana's
        trace->logs link, keyed on Loki's ``service_name`` label
        (``hope-harness``).
        """
        monkeypatch.setenv("OTEL_SERVICE_NAME", "hope-harness")

        config = build_observability_config(Settings())

        assert config.service_name == "hope-harness"

    def test_explicit_harness_setting_still_wins_over_the_generic_env(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An operator who names harness explicitly keeps that name."""
        monkeypatch.setenv("OTEL_SERVICE_NAME", "hope-harness")

        config = build_observability_config(Settings(otel_service_name="harness-canary"))

        assert config.service_name == "harness-canary"

    def test_deprecated_flag_false_vetoes_endpoint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A live manifest that sets HARNESS_OTEL_ENABLED=false to keep tracing off
        despite an endpoint on a shared config map must keep working for one release.
        """
        monkeypatch.setenv(OTEL_ENABLED_ENV_VAR, "false")
        settings = Settings(otel_enabled=False, otel_exporter_endpoint="http://localhost:4317")

        config = build_observability_config(settings)

        assert config.tracing_enabled is False
        assert config.otlp_endpoint is None

    def test_deprecated_flag_true_is_a_noop(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Setting the flag to true changes nothing under R-2 — the endpoint alone
        already enables tracing; the flag is not required and does not add a veto.
        """
        monkeypatch.setenv(OTEL_ENABLED_ENV_VAR, "true")

        config = build_observability_config(_enabled_settings())

        assert config.tracing_enabled is True

    def test_carries_over_settings_fields(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Settings resolve through hope_settings_sources (.env.<NODE_ENV> included);
        ObservabilityConfig.from_env reads bare os.getenv and would miss a
        file-only value, so every OTel-shaped field must come from `settings`.
        """
        monkeypatch.delenv(OTEL_ENABLED_ENV_VAR, raising=False)
        settings = _enabled_settings(
            otel_service_name="custom-harness",
            otel_service_namespace="custom-ns",
            otel_deployment_environment="staging",
            log_level="debug",
        )

        config = build_observability_config(settings)

        assert config.service_name == "custom-harness"
        assert config.service_namespace == "custom-ns"
        assert config.deployment_environment == "staging"
        assert config.log_level == "debug"

    def test_otel_enabled_flag_is_set_detects_presence(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv(OTEL_ENABLED_ENV_VAR, raising=False)
        assert otel_enabled_flag_is_set() is False

        monkeypatch.setenv(OTEL_ENABLED_ENV_VAR, "false")
        assert otel_enabled_flag_is_set() is True


# -- create_app() wiring: tracing installs (or doesn't) exactly as configured ----------


class TestCreateAppObservabilityWiring:
    def test_tracer_provider_absent_when_tracing_disabled(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv(OTEL_ENABLED_ENV_VAR, raising=False)

        app = create_app(settings_override=Settings())

        assert app.state.tracer_provider is None

    def test_tracer_provider_present_when_endpoint_configured(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """(c) The R-2 wiring: an endpoint alone, no flag, still installs a real
        TracerProvider — this is the F-01 fix at the integration layer.
        """
        monkeypatch.delenv(OTEL_ENABLED_ENV_VAR, raising=False)
        settings = Settings(otel_enabled=False, otel_exporter_endpoint="http://localhost:4317")

        app = create_app(settings_override=settings)

        assert isinstance(app.state.tracer_provider, TracerProvider)

    def test_never_raises_when_exporter_construction_fails(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """(d) an unreachable/misconfigured collector must degrade, not crash boot."""

        def _boom(*_args: Any, **_kwargs: Any) -> Any:
            raise RuntimeError("collector unreachable")

        monkeypatch.setattr("opentelemetry.exporter.otlp.proto.grpc.trace_exporter.OTLPSpanExporter", _boom)
        monkeypatch.delenv(OTEL_ENABLED_ENV_VAR, raising=False)

        app = create_app(settings_override=_enabled_settings())  # must not raise

        assert app.state.tracer_provider is None

    def test_deprecated_flag_veto_reaches_create_app(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(OTEL_ENABLED_ENV_VAR, "false")
        settings = Settings(otel_enabled=False, otel_exporter_endpoint="http://localhost:4317")

        app = create_app(settings_override=settings)

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
    """Regression guard.

    The first implementation of this config defaulted
    `otel_deployment_environment` to "production", which is the exact defect
    fixed in `apps/stt/core/telemetry.py` earlier in this ticket. An unset
    environment on a developer laptop would tag local spans as production
    data. A mislabelled dev span is noise; a mislabelled prod span corrupts an
    audit trail.
    """

    def test_defaults_to_development_never_production(self, monkeypatch) -> None:
        monkeypatch.delenv("DEPLOYMENT_ENVIRONMENT", raising=False)
        monkeypatch.delenv("NODE_ENV", raising=False)

        assert Settings().otel_deployment_environment == "development"

    def test_reads_deployment_environment(self, monkeypatch) -> None:
        monkeypatch.setenv("DEPLOYMENT_ENVIRONMENT", "staging")

        assert Settings().otel_deployment_environment == "staging"

    def test_falls_back_to_node_env(self, monkeypatch) -> None:
        monkeypatch.delenv("DEPLOYMENT_ENVIRONMENT", raising=False)
        monkeypatch.setenv("NODE_ENV", "test")

        assert Settings().otel_deployment_environment == "test"
