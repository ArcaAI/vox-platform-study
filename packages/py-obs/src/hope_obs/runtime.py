"""The two entrypoints a service calls (TASK-987 R-2/R-6).

``configure_observability`` for a FastAPI app, ``configure_worker_observability``
for a process that has none. Both install the SAME logging configuration and,
when an OTLP endpoint is configured, the SAME kind of real ``TracerProvider``.

That parity is finding F-04: the STT Dramatiq worker installed a logger provider
and no tracer, so every span it opened was non-recording and — because trace
correlation reads the CURRENT span — its log lines carried no ``traceId``
either. A batch transcription could not be joined to the request that enqueued
it.

Neither function raises. Tracing degrades to off on any failure and says so on
one warning line.
"""

from __future__ import annotations

import logging as stdlib_logging
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider

from hope_obs import tracing
from hope_obs.config import ObservabilityConfig
from hope_obs.logging import configure_logging
from hope_obs.middleware import AccessLogMiddleware, RequestContextMiddleware

if TYPE_CHECKING:  # pragma: no cover - typing only; never imported at runtime
    from fastapi import FastAPI

_LOGGER = stdlib_logging.getLogger(__name__)


def worker_service_name(configured: str) -> str:
    """``stt`` → ``stt-worker``, but ``hope-stt-v2-worker`` is left alone.

    Deployments set ``OTEL_SERVICE_NAME`` on the worker Deployment directly, and
    appending unconditionally produced the ``hope-stt-v2-worker-worker`` label
    observed live in Loki. Only append when the operator has not already named
    it (``apps/stt/src/stt/worker.py``).
    """
    return configured if configured.endswith("-worker") else f"{configured}-worker"


@dataclass
class WorkerObservability:
    """Handle returned to a worker entrypoint, for its SIGTERM path.

    ``shutdown()`` flushes buffered spans before the process exits — the window
    a crash investigation cares about is exactly the one that is lost without
    it. Idempotent, and never raises.
    """

    tracer_provider: TracerProvider | None = None
    _closed: bool = field(default=False, repr=False)

    def shutdown(self) -> None:
        if self._closed:
            return
        self._closed = True
        tracing.shutdown_tracer_provider(self.tracer_provider)
        if self.tracer_provider is not None:
            tracing.uninstrument_httpx()


def _install_request_middleware(app: FastAPI, config: ObservabilityConfig) -> None:
    """Add the two ASGI middlewares, context OUTERMOST.

    Starlette builds the stack with the LAST-added middleware outermost, so the
    access log is added first and the request context wraps it — otherwise the
    access lines would be written before ``request_id`` was bound and would be
    the only lines in the request that could not be correlated.
    """
    app.add_middleware(AccessLogMiddleware, logger_name=f"{config.service_name}.access")
    app.add_middleware(RequestContextMiddleware)


def configure_observability(app: FastAPI, config: ObservabilityConfig) -> None:
    """Configure logging, request context and tracing for a FastAPI service.

    Call it in ``create_app()``, before the app starts serving. Afterwards:

    * every log line is JSON on stdout, carrying ``service`` and, inside a
      request, ``request_id``/``tenant_id`` and ``traceId``/``spanId``;
    * ``X-Request-ID`` is echoed on every response;
    * if — and only if — ``config.otlp_endpoint`` is set, spans are exported to
      the collector and ``app.state.tracer_provider`` holds the provider for
      ``shutdown_observability`` to flush. Otherwise that attribute is ``None``.

    **Never raises.** Each stage is guarded independently, so a failure to
    instrument cannot cost the service its structured logging, and an
    unreachable observability backend cannot cost it its boot.
    """
    configure_logging(config)

    try:
        _install_request_middleware(app, config)
    except Exception as exc:  # noqa: BLE001 - degrade, never crash boot
        _LOGGER.warning("hope_obs.middleware.install_failed: %s", exc)

    app.state.tracer_provider = None
    if not config.tracing_enabled:
        _LOGGER.info(
            "hope_obs.tracing.disabled: no OTEL_EXPORTER_OTLP_ENDPOINT for %s",
            config.service_name,
        )
        return

    provider: TracerProvider | None = None
    try:
        provider = tracing.build_tracer_provider(config)
        if provider is None:  # pragma: no cover - guarded by tracing_enabled above
            return
        tracing.instrument_fastapi(app, provider)
        trace.set_tracer_provider(provider)
        app.state.tracer_provider = provider
        _LOGGER.info(
            "hope_obs.tracing.enabled: service=%s endpoint=%s sampler_ratio=%s",
            config.service_name,
            config.otlp_endpoint,
            config.traces_sampler_ratio,
        )
    except Exception as exc:  # noqa: BLE001 - degrade to no-tracing, never crash boot
        _LOGGER.warning("hope_obs.tracing.setup_failed: %s", exc)
        tracing.shutdown_tracer_provider(provider)
        app.state.tracer_provider = None


def shutdown_observability(app: FastAPI) -> None:
    """Flush spans and uninstrument, in the lifespan teardown. Never raises.

    Safe on an app that was never configured, and safe to call twice — a
    lifespan that runs teardown after a failed startup must not raise a second
    exception over the first.
    """
    provider = getattr(app.state, "tracer_provider", None)
    tracing.shutdown_tracer_provider(provider)
    tracing.uninstrument_fastapi(app)
    tracing.uninstrument_httpx()
    app.state.tracer_provider = None
    _LOGGER.info("hope_obs.shutdown_complete")


def configure_worker_observability(config: ObservabilityConfig) -> WorkerObservability:
    """Configure logging and tracing for a process with no FastAPI app.

    The consumers are ``stt.worker`` (Dramatiq) and ``harness.temporal.worker``
    (Temporal). The service name gets a ``-worker`` suffix unless the operator
    already supplied one, so the worker's telemetry is separable from the API's
    without being mangled into ``…-worker-worker``.

    Returns a handle whose ``shutdown()`` belongs on the SIGTERM path. Never
    raises.
    """
    worker_config = replace(config, service_name=worker_service_name(config.service_name))

    configure_logging(worker_config)

    if not worker_config.tracing_enabled:
        _LOGGER.info(
            "hope_obs.tracing.disabled: no OTEL_EXPORTER_OTLP_ENDPOINT for %s",
            worker_config.service_name,
        )
        return WorkerObservability(tracer_provider=None)

    provider: TracerProvider | None = None
    try:
        provider = tracing.build_tracer_provider(worker_config)
        if provider is not None:
            trace.set_tracer_provider(provider)
    except Exception as exc:  # noqa: BLE001 - degrade to no-tracing, never crash the worker
        _LOGGER.warning("hope_obs.tracing.setup_failed: %s", exc)
        tracing.shutdown_tracer_provider(provider)
        return WorkerObservability(tracer_provider=None)

    if provider is not None:
        try:
            # Outbound calls only — there is no inbound HTTP surface to
            # instrument here. A failure to instrument httpx must not cost the
            # worker the tracer it just installed, hence the separate guard.
            tracing.instrument_httpx(provider)
        except Exception as exc:  # noqa: BLE001 - tracing still works without it
            _LOGGER.warning("hope_obs.tracing.httpx_instrumentation_failed: %s", exc)

        _LOGGER.info(
            "hope_obs.tracing.enabled: service=%s endpoint=%s sampler_ratio=%s",
            worker_config.service_name,
            worker_config.otlp_endpoint,
            worker_config.traces_sampler_ratio,
        )

    return WorkerObservability(tracer_provider=provider)
