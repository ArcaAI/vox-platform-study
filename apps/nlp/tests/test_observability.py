"""NLP observability: logging via ``hope_obs``, OTel tracing/metrics.

TASK-987 lane E moved NLP's logging and tracing onto the shared `hope_obs`
package. The pre-adoption implementation this file used to characterise is
gone:

* **F-03** — `JsonFormatter` (defined, never installed) and the whole
  `LoggingConfig` class. NLP now emits the same JSON-on-stdout chain as every
  other service, via `hope_obs`.
* **F-02** — the `NLP_OTEL_ENABLED` master switch that gated tracing, metrics
  AND log export on a variable nothing in `hope-v2-dev` set, even though the
  three OTel variables the platform config supplies were all correct. Under
  R-2 there is no master switch: `OTEL_EXPORTER_OTLP_ENDPOINT` presence is the
  only tracing enable signal. `NLP_OTEL_ENABLED` is honoured for one more
  release ONLY as a deprecation warning — see `TestLegacyOtelEnabledFlag`.
* **R-5** — the OTLP log-export path (`LoggerProvider`, `OTLPLogExporter`,
  `LoggingInstrumentor`). Alloy tails stdout to Loki; that was a second,
  differently-shaped copy of the same lines.

NLP's own OTel `MeterProvider` (`nlp.core.metrics`) is a deliberate, named
exception (orchestrator decision, TASK-987 README §6.3 lane E): `hope_obs` has
no metrics path, and NLP is its only consumer. `TestMeterProviderRetained`
proves it survived the move.
"""

from __future__ import annotations

import io
import json
import logging
from collections.abc import Callable

import pytest
import structlog
from fastapi import FastAPI
from fastapi.testclient import TestClient
from opentelemetry import metrics as otel_metrics
from opentelemetry import trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.resources import SERVICE_NAME, Resource

from nlp.core.config import settings as nlp_settings
from nlp.core.logging import build_observability_config, setup_logging
from nlp.core.observability import setup_opentelemetry, shutdown_opentelemetry

Capture = Callable[[], io.StringIO]

# Every variable `ObservabilityConfig.from_env`/hope_obs's tracing reads.
# `.env.test` sets some of these fleet-wide (e.g. `OTEL_SERVICE_NAME=api-gateway`
# for the NestJS gateway) — inherited values would make this file's assertions
# depend on a DIFFERENT service's env block rather than on what the test itself
# sets up.
_OBSERVABILITY_ENV = (
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "NLP_OTLP_ENDPOINT",
    "OTEL_SERVICE_NAME",
    "OTEL_TRACES_SAMPLER_ARG",
    "DEPLOYMENT_ENVIRONMENT",
    "NODE_ENV",
    "LOG_LEVEL",
    "NLP_LOG_LEVEL",
    "NLP_OTEL_ENABLED",
)


@pytest.fixture(autouse=True)
def _reset_observability_globals(monkeypatch: pytest.MonkeyPatch):
    """Module-local (NOT session-wide) reset — safe here because nothing in
    this file uses `caplog`.

    Three process-global pieces of state would otherwise leak between tests:

    1. `hope_obs.logging._SETUP_DONE` — `configure_logging` is idempotent
       (R-3), so without resetting this every test after the first would keep
       whatever handler/level the FIRST one installed.
    2. The OTel SDK's `TracerProvider`/`MeterProvider` "set once" globals —
       `trace.set_tracer_provider`/`metrics.set_meter_provider` silently no-op
       on a second call, which would make `NLPMetrics()` (in
       `TestMeterProviderRetained`) resolve against a STALE provider from an
       earlier test.
    3. Inherited env (see `_OBSERVABILITY_ENV` above).
    """
    for name in _OBSERVABILITY_ENV:
        monkeypatch.delenv(name, raising=False)

    from hope_obs import logging as obs_logging

    root = logging.getLogger()
    preexisting = root.handlers[:]
    for handler in preexisting:
        root.removeHandler(handler)
    obs_logging._SETUP_DONE = False

    if hasattr(trace, "_TRACER_PROVIDER_SET_ONCE"):
        trace._TRACER_PROVIDER_SET_ONCE._done = False  # type: ignore[attr-defined]
    trace._TRACER_PROVIDER = None  # type: ignore[attr-defined]
    if hasattr(otel_metrics._internal, "_METER_PROVIDER_SET_ONCE"):
        otel_metrics._internal._METER_PROVIDER_SET_ONCE._done = False  # type: ignore[attr-defined]
    otel_metrics._internal._METER_PROVIDER = None  # type: ignore[attr-defined]

    yield

    from hope_obs import ObservabilityConfig, configure_logging

    for handler in root.handlers[:]:
        root.removeHandler(handler)
    for handler in preexisting:
        root.addHandler(handler)
    structlog.reset_defaults()
    structlog.contextvars.clear_contextvars()
    logging.getLogger("uvicorn.access").disabled = False

    if hasattr(trace, "_TRACER_PROVIDER_SET_ONCE"):
        trace._TRACER_PROVIDER_SET_ONCE._done = False  # type: ignore[attr-defined]
    trace._TRACER_PROVIDER = None  # type: ignore[attr-defined]
    if hasattr(otel_metrics._internal, "_METER_PROVIDER_SET_ONCE"):
        otel_metrics._internal._METER_PROVIDER_SET_ONCE._done = False  # type: ignore[attr-defined]
    otel_metrics._internal._METER_PROVIDER = None  # type: ignore[attr-defined]

    # Re-establish the "already configured" session baseline `conftest.py`
    # set up once at collection time (`structlog.reset_defaults()` just wiped
    # it): a LATER test file must not find structlog unconfigured, or its own
    # `caplog`-based tests break the way F-03's adoption first broke this one.
    obs_logging._SETUP_DONE = False
    configure_logging(ObservabilityConfig(service_name="nlp"))


def _lines(stream: io.StringIO) -> list[dict[str, object]]:
    return [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]


@pytest.fixture()
def fastapi_app() -> FastAPI:
    """A bare FastAPI app, instrumented directly (no `nlp.lifespan` involved)."""
    app = FastAPI()

    @app.get("/probe")
    def probe() -> dict[str, bool]:
        return {"ok": True}

    return app


# ---------------------------------------------------------------------------
# Logging shape — F-03
# ---------------------------------------------------------------------------


class TestLogLevelPrecedence:
    """`NLP_LOG_LEVEL` beats the bare `LOG_LEVEL`; both name and number work
    (the two behaviours the retired `core/logging.py` documented at its old
    lines 50-63, now provided by `hope_obs.config`/`hope_obs.logging`)."""

    def test_prefixed_name_wins_over_bare_name(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("NLP_LOG_LEVEL", "WARNING")
        monkeypatch.setenv("LOG_LEVEL", "DEBUG")
        config = build_observability_config()
        assert config.log_level == "WARNING"

    def test_bare_log_level_used_when_prefixed_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("NLP_LOG_LEVEL", raising=False)
        monkeypatch.setenv("LOG_LEVEL", "ERROR")
        config = build_observability_config()
        assert config.log_level == "ERROR"

    def test_numeric_level_is_accepted(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("NLP_LOG_LEVEL", "30")
        monkeypatch.delenv("LOG_LEVEL", raising=False)
        setup_logging()
        assert logging.getLogger().level == logging.WARNING

    def test_named_level_is_accepted(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("NLP_LOG_LEVEL", "WARNING")
        monkeypatch.delenv("LOG_LEVEL", raising=False)
        setup_logging()
        assert logging.getLogger().level == logging.WARNING


class TestLogOutputIsJson:
    """The money test for F-03: JSON on stdout, not `SIMPLE_FORMAT` text."""

    def test_emits_valid_json_with_no_simple_format_prefix(
        self, capture_log_output: Capture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("NLP_LOG_LEVEL", "INFO")
        setup_logging()
        stream = capture_log_output()

        logging.getLogger("nlp.test").info("nlp.test.marker")

        raw = stream.getvalue().strip()
        assert raw, "expected at least one log line"
        # The retired SIMPLE_FORMAT was "[%(asctime)s] %(levelname)s - ...".
        assert not raw.startswith("["), f"still emitting SIMPLE_FORMAT text: {raw!r}"
        (line,) = _lines(stream)
        assert line["event"] == "nlp.test.marker"
        assert line["service"] == "nlp"
        assert line["logger"] == "nlp.test"
        assert "timestamp" in line
        assert "traceId" not in line, "no active span — traceId must be absent, not '0'"


# ---------------------------------------------------------------------------
# Tracing enable signal — F-02
# ---------------------------------------------------------------------------


class TestTracingEnableSignal:
    def test_no_endpoint_leaves_tracer_provider_none(
        self, fastapi_app: FastAPI, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        monkeypatch.delenv("NLP_OTLP_ENDPOINT", raising=False)
        monkeypatch.setattr(nlp_settings.service, "otlp_endpoint", None, raising=False)

        setup_opentelemetry(fastapi_app)
        try:
            assert fastapi_app.state.tracer_provider is None
            assert fastapi_app.state.meter_provider is None

            with TestClient(fastapi_app) as client:
                response = client.get("/probe")
            assert response.status_code == 200
        finally:
            shutdown_opentelemetry(fastapi_app)

    def test_unroutable_endpoint_never_raises_and_still_enables_tracing(
        self, fastapi_app: FastAPI, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An unroutable endpoint is a RUNTIME export failure (OTLP/gRPC
        connects lazily), never a configuration one — R-2. Tracing stays ON."""
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")
        monkeypatch.setattr(nlp_settings.service, "otlp_endpoint", None, raising=False)

        setup_opentelemetry(fastapi_app)  # must not raise
        try:
            assert fastapi_app.state.tracer_provider is not None

            with TestClient(fastapi_app) as client:
                response = client.get("/probe")
            assert response.status_code == 200, "an unreachable collector must never fail a boot"
        finally:
            shutdown_opentelemetry(fastapi_app)  # must not raise either


class TestLegacyOtelEnabledFlag:
    """F-02's fix: `NLP_OTEL_ENABLED` no longer decides anything, but is
    honoured with a deprecation warning for one release (R-2)."""

    def test_false_no_longer_disables_tracing(
        self, fastapi_app: FastAPI, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The exact shape of F-02: endpoint present, legacy flag explicitly
        false — tracing must still turn on."""
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")
        monkeypatch.setenv("NLP_OTEL_ENABLED", "false")
        monkeypatch.setattr(nlp_settings.service, "otlp_endpoint", None, raising=False)

        setup_opentelemetry(fastapi_app)
        try:
            assert fastapi_app.state.tracer_provider is not None
        finally:
            shutdown_opentelemetry(fastapi_app)

    def test_flag_unset_emits_no_warning(
        self,
        fastapi_app: FastAPI,
        monkeypatch: pytest.MonkeyPatch,
        recwarn: pytest.WarningsRecorder,
    ) -> None:
        monkeypatch.delenv("NLP_OTEL_ENABLED", raising=False)
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        monkeypatch.setattr(nlp_settings.service, "otlp_endpoint", None, raising=False)

        setup_opentelemetry(fastapi_app)
        shutdown_opentelemetry(fastapi_app)

        assert not any(
            issubclass(w.category, DeprecationWarning) and "NLP_OTEL_ENABLED" in str(w.message)
            for w in recwarn.list
        )

    @pytest.mark.parametrize("value", ["true", "false"])
    def test_flag_set_emits_deprecation_warning(
        self, fastapi_app: FastAPI, monkeypatch: pytest.MonkeyPatch, value: str
    ) -> None:
        monkeypatch.setenv("NLP_OTEL_ENABLED", value)
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        monkeypatch.setattr(nlp_settings.service, "otlp_endpoint", None, raising=False)

        with pytest.warns(DeprecationWarning, match="NLP_OTEL_ENABLED"):
            setup_opentelemetry(fastapi_app)
        shutdown_opentelemetry(fastapi_app)


# ---------------------------------------------------------------------------
# Request context + access log
# ---------------------------------------------------------------------------


class TestRequestContextAndAccessLog:
    @pytest.fixture(autouse=True)
    def _no_tracing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """These tests are about the middlewares, not tracing — keep tracing
        off so they don't pay for (or depend on) an OTLP exporter."""
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        monkeypatch.delenv("NLP_OTLP_ENDPOINT", raising=False)
        monkeypatch.setattr(nlp_settings.service, "otlp_endpoint", None, raising=False)

    def test_request_emits_one_complete_line_with_request_id_and_duration(
        self, fastapi_app: FastAPI, capture_log_output: Capture
    ) -> None:
        setup_opentelemetry(fastapi_app)
        try:
            with TestClient(fastapi_app) as client:
                stream = capture_log_output()
                response = client.get("/probe")
            assert response.status_code == 200

            complete_lines = [
                line for line in _lines(stream) if line["event"] == "request.complete"
            ]
            assert len(complete_lines) == 1
            (line,) = complete_lines
            assert line["request_id"]
            assert isinstance(line["duration_ms"], (int, float))
            assert line["status_code"] == 200
        finally:
            shutdown_opentelemetry(fastapi_app)

    def test_inbound_request_id_is_echoed_exactly_once(self, fastapi_app: FastAPI) -> None:
        setup_opentelemetry(fastapi_app)
        try:
            with TestClient(fastapi_app) as client:
                response = client.get("/probe", headers={"X-Request-ID": "caller-supplied-id"})
            assert response.headers.get_list("x-request-id") == ["caller-supplied-id"]
        finally:
            shutdown_opentelemetry(fastapi_app)

    def test_tenant_id_header_appears_on_the_log_line(
        self, fastapi_app: FastAPI, capture_log_output: Capture
    ) -> None:
        setup_opentelemetry(fastapi_app)
        try:
            with TestClient(fastapi_app) as client:
                stream = capture_log_output()
                client.get(
                    "/probe", headers={"X-Tenant-Id": "11111111-1111-1111-1111-111111111111"}
                )

            complete_lines = [
                line for line in _lines(stream) if line["event"] == "request.complete"
            ]
            (line,) = complete_lines
            assert line["tenant_id"] == "11111111-1111-1111-1111-111111111111"
        finally:
            shutdown_opentelemetry(fastapi_app)

    def test_no_tenant_header_means_no_tenant_id_field(
        self, fastapi_app: FastAPI, capture_log_output: Capture
    ) -> None:
        """Absent is absent — the middleware never invents a tenant
        (`.claude/rules/00-project-context.md`)."""
        setup_opentelemetry(fastapi_app)
        try:
            with TestClient(fastapi_app) as client:
                stream = capture_log_output()
                client.get("/probe")

            complete_lines = [
                line for line in _lines(stream) if line["event"] == "request.complete"
            ]
            (line,) = complete_lines
            assert "tenant_id" not in line
        finally:
            shutdown_opentelemetry(fastapi_app)


# ---------------------------------------------------------------------------
# NLP's own MeterProvider — retained, not moved into hope_obs
# ---------------------------------------------------------------------------


class TestMeterProviderRetained:
    def test_installed_when_tracing_and_metrics_enabled(
        self, fastapi_app: FastAPI, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")
        monkeypatch.setattr(nlp_settings.service, "otlp_endpoint", None, raising=False)
        monkeypatch.setattr(nlp_settings.service, "metrics_enabled", True, raising=False)

        setup_opentelemetry(fastapi_app)
        try:
            assert isinstance(fastapi_app.state.meter_provider, MeterProvider)
        finally:
            shutdown_opentelemetry(fastapi_app)

    def test_absent_when_metrics_disabled(
        self, fastapi_app: FastAPI, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")
        monkeypatch.setattr(nlp_settings.service, "otlp_endpoint", None, raising=False)
        monkeypatch.setattr(nlp_settings.service, "metrics_enabled", False, raising=False)

        setup_opentelemetry(fastapi_app)
        try:
            assert fastapi_app.state.meter_provider is None
        finally:
            shutdown_opentelemetry(fastapi_app)

    def test_absent_when_no_endpoint_even_if_metrics_enabled(
        self, fastapi_app: FastAPI, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        monkeypatch.setattr(nlp_settings.service, "otlp_endpoint", None, raising=False)
        monkeypatch.setattr(nlp_settings.service, "metrics_enabled", True, raising=False)

        setup_opentelemetry(fastapi_app)
        try:
            assert fastapi_app.state.meter_provider is None
        finally:
            shutdown_opentelemetry(fastapi_app)

    def test_nlp_metrics_are_still_exported(self) -> None:
        """`nlp_metrics.track_inference` must still record through the
        histogram/counter this module builds — the regression guard for the
        orchestrator decision to keep `nlp.core.metrics` local."""
        reader = InMemoryMetricReader()
        resource = Resource({SERVICE_NAME: "test-nlp"})
        provider = MeterProvider(resource=resource, metric_readers=[reader])
        otel_metrics.set_meter_provider(provider)

        from nlp.core.metrics import NLPMetrics

        test_metrics = NLPMetrics(meter_name="test-nlp-metrics")
        with test_metrics.track_inference("test-model"):
            pass

        data = reader.get_metrics_data()
        assert data is not None
        metric_names = {
            m.name for rm in data.resource_metrics for sm in rm.scope_metrics for m in sm.metrics
        }
        assert "nlp.inference.total" in metric_names
        assert "nlp.inference.duration_ms" in metric_names
        provider.shutdown()


# ---------------------------------------------------------------------------
# Shutdown
# ---------------------------------------------------------------------------


class TestShutdown:
    def test_never_raises_when_setup_was_skipped(
        self, fastapi_app: FastAPI, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        monkeypatch.setattr(nlp_settings.service, "otlp_endpoint", None, raising=False)

        setup_opentelemetry(fastapi_app)
        shutdown_opentelemetry(fastapi_app)  # must not raise

    def test_idempotent(self, fastapi_app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")
        monkeypatch.setattr(nlp_settings.service, "otlp_endpoint", None, raising=False)

        setup_opentelemetry(fastapi_app)
        shutdown_opentelemetry(fastapi_app)
        shutdown_opentelemetry(fastapi_app)  # must not raise the second time
