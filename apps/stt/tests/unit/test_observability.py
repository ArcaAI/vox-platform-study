"""TDD tests for STT's adoption of `hope_obs` (TASK-987 lane A — F-04, F-08, F-13).

STT's own logging/tracing implementation is DELETED (`stt.core.logging`,
`stt.core.telemetry` are now thin adapters over `hope_obs`); these tests pin
the WIRING — that `stt.main` / `stt.worker` actually call into `hope_obs`
correctly — not that `hope_obs` itself behaves correctly (that is
`packages/py-obs/tests/`, already hermetic and green).

Superseded assertions from the pre-adoption version of this file are gone
outright, not merely reshaped: OTLP *log* export (`setup_telemetry_logs`,
`LoggerProvider`, `OTLPLogExporter`, `LoggingInstrumentor`) is deleted from
every service by R-5 (stdout -> Alloy -> Loki is the one log path now), so
there is no implementation left to assert against. The behaviours that
survive from the old suite — idempotent setup, stdlib records joining the
structured JSON chain, otel trace-context injection when a span is active,
resilience to a bad exporter — are ported here against the adopted
implementation instead of the deleted local one.
"""

from __future__ import annotations

import json
import logging
from unittest.mock import patch

import pytest
import structlog
from fastapi.testclient import TestClient
from hope_obs import WorkerObservability, configure_worker_observability
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.trace import TracerProvider

from stt.core.config.settings import Settings
from stt.core.telemetry import build_observability_config
from stt.main import create_app

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _reset_logging() -> None:
    """Undo `configure_logging`'s idempotence guard and root-handler state.

    Every test in this file configures logging itself (directly, via
    `create_app()`, or via `configure_worker_observability`) and must not
    inherit handlers — or the idempotence guard — from a previous test or
    from the module-level `configure_logging` call `stt.main` makes at
    import time.
    """
    root = logging.getLogger()
    for handler in root.handlers[:]:
        root.removeHandler(handler)
    structlog.reset_defaults()

    import hope_obs.logging as _hope_logging

    _hope_logging._SETUP_DONE = False


@pytest.fixture(autouse=True)
def _isolated_logging():
    _reset_logging()
    yield
    _reset_logging()


def _json_lines(text: str) -> list[dict]:
    return [json.loads(line) for line in text.strip().splitlines() if line.strip()]


def _settings(**overrides: object) -> Settings:
    """A real `Settings` instance — never a bare `MagicMock`.

    `build_observability_config` reads `otel_service_name` / `log_level` off
    whatever it is handed; a `MagicMock` without those attributes set would
    silently poison the JSON logging chain (a non-serialisable `service`
    field) rather than fail loudly, which is worse than the extra setup here.
    """
    return Settings(otel_enabled=False, **overrides)


# ---------------------------------------------------------------------------
# R-2 / F-01 — endpoint presence is the ONLY enable signal
# ---------------------------------------------------------------------------


class TestTracingEnableSignal:
    def test_boots_with_no_endpoint_and_exports_nothing(self, monkeypatch):
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)

        app = create_app(_settings())

        assert app.state.tracer_provider is None

    def test_boots_with_an_unroutable_endpoint_and_still_serves_health(self, monkeypatch):
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")

        app = create_app(_settings())

        # OTLP/gRPC connects lazily — an unroutable collector is a RUNTIME
        # export failure, not a configuration failure (hope_obs R-2), so
        # tracing stays ON at configure time.
        assert isinstance(app.state.tracer_provider, TracerProvider)

        client = TestClient(app)
        response = client.get("/api/v1/health")
        assert response.status_code == 200


# ---------------------------------------------------------------------------
# R-4 — request context + access log, pure ASGI
# ---------------------------------------------------------------------------


class TestRequestContextAndAccessLog:
    def test_a_request_emits_one_request_complete_line_with_request_id_and_duration(
        self, monkeypatch, capsys
    ):
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)

        app = create_app(_settings())
        client = TestClient(app)

        capsys.readouterr()  # discard anything logged while building the app
        response = client.get("/api/v1/health")
        assert response.status_code == 200

        lines = _json_lines(capsys.readouterr().out)
        complete = [line for line in lines if line.get("event") == "request.complete"]
        assert len(complete) == 1
        assert complete[0]["request_id"]
        assert isinstance(complete[0]["duration_ms"], (int, float))

    def test_inbound_x_request_id_is_echoed_unchanged_exactly_once(self, monkeypatch):
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)

        app = create_app(_settings())
        client = TestClient(app)

        response = client.get("/api/v1/health", headers={"X-Request-ID": "caller-supplied-id"})

        assert response.status_code == 200
        assert response.headers["x-request-id"] == "caller-supplied-id"
        echoed = [
            value for key, value in response.headers.multi_items() if key.lower() == "x-request-id"
        ]
        assert echoed == ["caller-supplied-id"]

    def test_inbound_x_tenant_id_appears_as_tenant_id_on_the_log_line(self, monkeypatch, capsys):
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)

        app = create_app(_settings())
        client = TestClient(app)

        capsys.readouterr()
        response = client.get("/api/v1/health", headers={"X-Tenant-Id": "tenant-abc"})
        assert response.status_code == 200

        lines = _json_lines(capsys.readouterr().out)
        complete = [line for line in lines if line.get("event") == "request.complete"]
        assert len(complete) == 1
        assert complete[0]["tenant_id"] == "tenant-abc"

    def test_no_tenant_header_means_no_tenant_id_field(self, monkeypatch, capsys):
        """F-07's other half: absent is absent — never a default tenant."""
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)

        app = create_app(_settings())
        client = TestClient(app)

        capsys.readouterr()
        client.get("/api/v1/health")

        lines = _json_lines(capsys.readouterr().out)
        complete = [line for line in lines if line.get("event") == "request.complete"]
        assert len(complete) == 1
        assert "tenant_id" not in complete[0]


# ---------------------------------------------------------------------------
# F-08 — pure ASGI, never BaseHTTPMiddleware
# ---------------------------------------------------------------------------


class TestPureAsgiMiddleware:
    def test_the_old_basehttpmiddleware_request_id_and_logging_modules_are_gone(self):
        with pytest.raises(ModuleNotFoundError):
            import stt.core.middleware.request_id  # noqa: F401

        with pytest.raises(ModuleNotFoundError):
            import stt.core.middleware.logging  # noqa: F401

    def test_create_app_installs_the_shared_asgi_middlewares(self, monkeypatch):
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        from hope_obs.middleware import AccessLogMiddleware, RequestContextMiddleware

        app = create_app(_settings())

        classes = [entry.cls for entry in app.user_middleware]
        assert RequestContextMiddleware in classes
        assert AccessLogMiddleware in classes


# ---------------------------------------------------------------------------
# F-13 — the PHI server_request_hook, on the one service whose payloads
# are clinical audio
# ---------------------------------------------------------------------------


class TestPhiRequestHook:
    def test_fastapi_instrumentation_carries_the_phi_hook(self, monkeypatch):
        """STT never passed `server_request_hook` before adoption. `hope_obs`
        passes it UNCONDITIONALLY, so the fix is inherent to wiring through
        `configure_observability` — this pins that the wiring actually
        happened, rather than STT still calling `FastAPIInstrumentor` bare.
        """
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")

        with patch.object(
            FastAPIInstrumentor, "instrument_app", wraps=FastAPIInstrumentor.instrument_app
        ) as mock_instrument:
            create_app(_settings())

        mock_instrument.assert_called_once()
        _, kwargs = mock_instrument.call_args
        assert kwargs.get("server_request_hook") is not None


# ---------------------------------------------------------------------------
# F-04 — the worker installs a REAL TracerProvider, not just a log exporter
# ---------------------------------------------------------------------------


class TestWorkerTracerProvider:
    def test_configure_worker_observability_installs_a_recording_tracer_provider(self, monkeypatch):
        """Before TASK-987, `stt.worker` called `setup_telemetry_logs` only:
        there was no `TracerProvider` in the worker process, so every span it
        opened was non-recording and its log lines carried no `traceId` — a
        batch transcription could not be joined to the request that enqueued
        it. This is the exact composition `stt.worker` performs at import
        time: `configure_worker_observability(build_observability_config(settings))`.
        """
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")

        handle = configure_worker_observability(build_observability_config(_settings()))
        try:
            assert isinstance(handle, WorkerObservability)
            assert isinstance(handle.tracer_provider, TracerProvider)

            tracer = handle.tracer_provider.get_tracer("test")
            with tracer.start_as_current_span("probe") as span:
                assert span.is_recording()
        finally:
            handle.shutdown()

    def test_worker_service_name_gets_the_no_double_suffix_treatment(self, monkeypatch):
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")

        handle = configure_worker_observability(
            build_observability_config(_settings(otel_service_name="stt"))
        )
        try:
            assert handle.tracer_provider.resource.attributes["service.name"] == "stt-worker"
        finally:
            handle.shutdown()

        # An operator-named worker (in-cluster: OTEL_SERVICE_NAME=hope-stt-v2-worker
        # on the worker Deployment) must not be mangled into "…-worker-worker".
        monkeypatch.setenv("OTEL_SERVICE_NAME", "hope-stt-v2-worker")
        handle2 = configure_worker_observability(build_observability_config(_settings()))
        try:
            assert (
                handle2.tracer_provider.resource.attributes["service.name"] == "hope-stt-v2-worker"
            )
        finally:
            handle2.shutdown()

    def test_no_tracer_provider_when_no_endpoint_configured(self, monkeypatch):
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)

        handle = configure_worker_observability(build_observability_config(_settings()))
        try:
            assert handle.tracer_provider is None
        finally:
            handle.shutdown()  # never raises, even with nothing to flush


class TestWorkerModuleWiring:
    """Structural pins on `stt.worker` itself (imported as-is, no reload —
    reloading would re-run its dramatiq broker/actor registration side
    effects, which is not what these tests are about).
    """

    def test_worker_module_installs_a_worker_observability_handle(self):
        import stt.worker as worker_module

        assert isinstance(worker_module._worker_observability, WorkerObservability)

    def test_worker_shutdown_path_flushes_the_observability_handle(self):
        import inspect

        import stt.worker as worker_module

        source = inspect.getsource(worker_module.main)
        assert "_worker_observability.shutdown()" in source

    def test_the_old_worker_service_name_helper_is_gone(self):
        import stt.worker as worker_module

        assert not hasattr(worker_module, "_worker_service_name")


# ---------------------------------------------------------------------------
# redact_id moved to hope_obs outright (single prior caller)
# ---------------------------------------------------------------------------


class TestRedactIdMovedToHopeObs:
    def test_stt_core_logging_no_longer_defines_redact_id(self):
        import stt.core.logging as stt_logging

        assert not hasattr(stt_logging, "redact_id")

    def test_preseed_imports_redact_id_from_hope_obs(self):
        import stt.diarization.preseed as preseed_module

        assert preseed_module.redact_id.__module__ == "hope_obs.phi"


# ---------------------------------------------------------------------------
# R-3 — behaviours ported from the deleted local implementation
# ---------------------------------------------------------------------------


class TestLoggingChainPortedBehaviour:
    """The parts of the pre-adoption suite that still apply: idempotent
    setup, stdlib records joining the JSON chain, otel context injection,
    and resilience to a bad exporter. Exercised through `create_app()`
    rather than a local `setup_logging`/`_add_otel_context`, both deleted.
    """

    def test_configure_logging_is_idempotent_across_repeated_app_creation(self, monkeypatch):
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)

        create_app(_settings())
        count_after_first = len(logging.getLogger().handlers)

        create_app(_settings())
        count_after_second = len(logging.getLogger().handlers)

        assert count_after_second == count_after_first == 1

    def test_stdlib_logger_produces_json_after_app_creation(self, monkeypatch, capsys):
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)

        create_app(_settings())

        capsys.readouterr()
        logging.getLogger("httpx").warning("third-party record")
        parsed = _json_lines(capsys.readouterr().out)

        assert len(parsed) == 1
        assert parsed[0]["event"] == "third-party record"
        assert "timestamp" in parsed[0]
        assert parsed[0]["level"] == "warning"

    def test_an_unroutable_exporter_does_not_break_logging(self, monkeypatch, capsys):
        monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")

        create_app(_settings())

        capsys.readouterr()
        logging.getLogger("stt.test").info("still works")
        parsed = _json_lines(capsys.readouterr().out)

        assert any(line.get("event") == "still works" for line in parsed)
