"""Runtime wiring (R-2, R-6, R-8) — app and worker entrypoints.

Hermetic: no collector is contacted. The OTLP gRPC exporter connects lazily, so
constructing one against an unroutable endpoint is a local operation; that is
also why an unreachable collector cannot be detected at configure time and must
never be a boot precondition.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest
from fastapi import FastAPI
from opentelemetry.sdk.trace import TracerProvider

import hope_obs.tracing as tracing_module
from hope_obs import (
    ObservabilityConfig,
    configure_observability,
    configure_worker_observability,
    shutdown_observability,
)
from hope_obs.middleware import AccessLogMiddleware, RequestContextMiddleware

UNROUTABLE = "http://127.0.0.1:1"


def _middleware_classes(app: FastAPI) -> list[type]:
    return [entry.cls for entry in app.user_middleware]


class TestConfigureObservabilityWithoutAnEndpoint:
    def test_tracing_stays_off_and_state_is_none(self) -> None:
        app = FastAPI()
        configure_observability(app, ObservabilityConfig(service_name="stt"))
        assert app.state.tracer_provider is None

    def test_logging_is_configured(self) -> None:
        app = FastAPI()
        configure_observability(app, ObservabilityConfig(service_name="stt"))
        assert len(logging.getLogger().handlers) == 1

    def test_request_middlewares_are_installed(self) -> None:
        app = FastAPI()
        configure_observability(app, ObservabilityConfig(service_name="stt"))
        installed = _middleware_classes(app)
        assert RequestContextMiddleware in installed
        assert AccessLogMiddleware in installed

    def test_request_context_is_the_outermost_middleware(self) -> None:
        """The access log must carry the request id, so context binds first."""
        app = FastAPI()
        configure_observability(app, ObservabilityConfig(service_name="stt"))
        installed = _middleware_classes(app)
        assert installed.index(RequestContextMiddleware) < installed.index(AccessLogMiddleware)


class TestConfigureObservabilityNeverRaises:
    def test_unroutable_endpoint_does_not_raise(self) -> None:
        app = FastAPI()
        config = ObservabilityConfig(service_name="stt", otlp_endpoint=UNROUTABLE)

        configure_observability(app, config)

        # The gRPC exporter connects lazily: an unreachable collector is a
        # runtime export failure, not a configuration failure, so tracing stays
        # ON and spans buffer until the collector returns.
        assert isinstance(app.state.tracer_provider, TracerProvider)
        shutdown_observability(app)

    def test_exporter_construction_failure_degrades_to_no_tracing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def explode(*args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("bad endpoint")

        # Patched at the SOURCE module, not on `hope_obs.tracing`: the exporter is
        # imported lazily inside `build_tracer_provider` (TASK-987 F-16), so it is
        # never an attribute of `hope_obs.tracing`. Patching the origin also keeps
        # this test honest if the import ever moves again.
        monkeypatch.setattr(
            "opentelemetry.exporter.otlp.proto.grpc.trace_exporter.OTLPSpanExporter",
            explode,
        )
        app = FastAPI()

        configure_observability(
            app, ObservabilityConfig(service_name="stt", otlp_endpoint=UNROUTABLE)
        )

        assert app.state.tracer_provider is None

    def test_instrumentation_failure_degrades_to_no_tracing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def explode(app: Any, config: Any) -> None:
            raise RuntimeError("instrumentation exploded")

        monkeypatch.setattr(tracing_module, "instrument_fastapi", explode)
        app = FastAPI()

        configure_observability(
            app, ObservabilityConfig(service_name="stt", otlp_endpoint=UNROUTABLE)
        )

        assert app.state.tracer_provider is None

    def test_shutdown_is_safe_when_tracing_was_never_configured(self) -> None:
        app = FastAPI()
        configure_observability(app, ObservabilityConfig(service_name="stt"))
        shutdown_observability(app)
        shutdown_observability(app)

    def test_shutdown_is_safe_on_a_bare_app(self) -> None:
        shutdown_observability(FastAPI())


class TestResourceAttributes:
    def test_both_environment_spellings_are_emitted(self) -> None:
        provider = tracing_module.build_tracer_provider(
            ObservabilityConfig(
                service_name="stt",
                service_version="2.0.0",
                deployment_environment="dev",
                otlp_endpoint=UNROUTABLE,
            )
        )
        assert provider is not None
        attributes = dict(provider.resource.attributes)
        assert attributes["service.name"] == "stt"
        assert attributes["service.version"] == "2.0.0"
        assert attributes["service.namespace"] == "hope"
        # Legacy spelling: existing Grafana queries read it. `.name` is current semconv.
        assert attributes["deployment.environment"] == "dev"
        assert attributes["deployment.environment.name"] == "dev"
        provider.shutdown()

    def test_no_provider_without_an_endpoint(self) -> None:
        assert tracing_module.build_tracer_provider(ObservabilityConfig(service_name="stt")) is None


class TestSampling:
    def test_parent_based_ratio_sampler(self) -> None:
        provider = tracing_module.build_tracer_provider(
            ObservabilityConfig(
                service_name="stt", otlp_endpoint=UNROUTABLE, traces_sampler_ratio=0.25
            )
        )
        assert provider is not None
        description = provider.sampler.get_description()
        assert description.startswith("ParentBased")
        assert "root:TraceIdRatioBased{0.25}" in description
        provider.shutdown()

    def test_default_ratio_samples_everything(self) -> None:
        provider = tracing_module.build_tracer_provider(
            ObservabilityConfig(service_name="stt", otlp_endpoint=UNROUTABLE)
        )
        assert provider is not None
        assert "root:TraceIdRatioBased{1.0}" in provider.sampler.get_description()
        provider.shutdown()


class TestWorkerObservability:
    def test_installs_a_real_recording_tracer_provider(self) -> None:
        """F-04: the STT worker installed a logger provider only, so its spans
        were non-recording and its log lines carried no trace id."""
        handle = configure_worker_observability(
            ObservabilityConfig(service_name="stt", otlp_endpoint=UNROUTABLE)
        )
        try:
            assert isinstance(handle.tracer_provider, TracerProvider)
            span = handle.tracer_provider.get_tracer("stt.worker").start_span("unit")
            assert span.is_recording()
        finally:
            handle.shutdown()

    def test_configures_logging(self) -> None:
        handle = configure_worker_observability(ObservabilityConfig(service_name="stt"))
        try:
            assert len(logging.getLogger().handlers) == 1
        finally:
            handle.shutdown()

    def test_service_name_gets_the_worker_suffix(self) -> None:
        handle = configure_worker_observability(
            ObservabilityConfig(service_name="stt", otlp_endpoint=UNROUTABLE)
        )
        try:
            assert handle.tracer_provider is not None
            assert handle.tracer_provider.resource.attributes["service.name"] == "stt-worker"
        finally:
            handle.shutdown()

    def test_an_operator_named_worker_is_not_double_suffixed(self) -> None:
        """`hope-stt-v2-worker-worker` was observed live in Loki."""
        handle = configure_worker_observability(
            ObservabilityConfig(service_name="hope-stt-v2-worker", otlp_endpoint=UNROUTABLE)
        )
        try:
            assert handle.tracer_provider is not None
            assert (
                handle.tracer_provider.resource.attributes["service.name"] == "hope-stt-v2-worker"
            )
        finally:
            handle.shutdown()

    def test_no_endpoint_means_logging_only(self) -> None:
        handle = configure_worker_observability(ObservabilityConfig(service_name="stt"))
        try:
            assert handle.tracer_provider is None
        finally:
            handle.shutdown()

    def test_shutdown_is_idempotent(self) -> None:
        handle = configure_worker_observability(
            ObservabilityConfig(service_name="stt", otlp_endpoint=UNROUTABLE)
        )
        handle.shutdown()
        handle.shutdown()

    def test_never_raises_on_exporter_failure(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def explode(*args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("bad endpoint")

        # Patched at the SOURCE module, not on `hope_obs.tracing`: the exporter is
        # imported lazily inside `build_tracer_provider` (TASK-987 F-16), so it is
        # never an attribute of `hope_obs.tracing`. Patching the origin also keeps
        # this test honest if the import ever moves again.
        monkeypatch.setattr(
            "opentelemetry.exporter.otlp.proto.grpc.trace_exporter.OTLPSpanExporter",
            explode,
        )

        handle = configure_worker_observability(
            ObservabilityConfig(service_name="stt", otlp_endpoint=UNROUTABLE)
        )
        try:
            assert handle.tracer_provider is None
        finally:
            handle.shutdown()


class TestWorkerProcessWithoutFastapi:
    def test_package_imports_and_configures_without_fastapi_or_starlette(self) -> None:
        """The STT Dramatiq worker and the harness Temporal worker have no app.

        FastAPI and Starlette are typing-only imports here. A module-level
        `from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor`
        would pull FastAPI in transitively and break a worker image that does
        not ship it, so the instrumentation imports are deferred into the
        functions that need an app.
        """
        import os
        import pathlib
        import subprocess
        import sys
        import textwrap

        import hope_obs

        src_root = str(pathlib.Path(hope_obs.__file__).resolve().parent.parent)
        program = textwrap.dedent("""
            import sys

            class Blocker:
                BLOCKED = {"fastapi", "starlette"}

                def find_spec(self, name, path=None, target=None):
                    if name.split(".")[0] in self.BLOCKED:
                        raise ImportError(name + " is not installed in this process")
                    return None

            sys.meta_path.insert(0, Blocker())

            import hope_obs
            from hope_obs import ObservabilityConfig, configure_worker_observability, get_logger

            handle = configure_worker_observability(ObservabilityConfig(service_name="stt"))
            get_logger("stt.worker").info("stt.worker.started")
            handle.shutdown()

            assert "fastapi" not in sys.modules, "fastapi was imported"
            assert "starlette" not in sys.modules, "starlette was imported"
            print("WORKER-IMPORT-OK")
            """)

        result = subprocess.run(  # noqa: S603 - the program is this test's own literal
            [sys.executable, "-c", program],
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONPATH": src_root},
            check=False,
        )

        assert "WORKER-IMPORT-OK" in result.stdout, result.stderr
