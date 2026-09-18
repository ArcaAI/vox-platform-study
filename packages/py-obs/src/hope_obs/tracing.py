"""OpenTelemetry tracing for the HOPE Python services (TASK-987 R-2/R-7/R-8).

Traces (and, where a service exports them, metrics) go over OTLP to the
collector. **Logs do not** — see ``hope_obs.logging`` for why.

Two import rules this module exists to enforce:

* ``opentelemetry.instrumentation.fastapi`` imports FastAPI, and
  ``...instrumentation.httpx`` imports httpx. Both are imported LAZILY, inside
  the functions that need them, so ``import hope_obs`` works in a worker
  process that ships no web framework (the STT Dramatiq worker and the harness
  Temporal worker both call into this package).
* Nothing here raises for an environmental reason. A reachable observability
  backend is never a boot or request-path dependency. The caller
  (``hope_obs.runtime``) owns the degrade-to-no-tracing posture; these functions
  stay honest so it can distinguish a real failure from "not configured".
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, cast

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased

from hope_obs.config import ObservabilityConfig
from hope_obs.phi import phi_sanitization_hook

if TYPE_CHECKING:  # pragma: no cover - typing only; never imported at runtime
    from fastapi import FastAPI

_LOGGER = logging.getLogger(__name__)

#: Endpoints that would otherwise produce one span per scrape or probe — the
#: liveness/readiness probes (kubelet, several times a minute, per pod), the
#: Prometheus scrape, and the docs routes. Both the bare and the `/api/v1`
#: prefixed spellings, because the fleet serves both.
EXCLUDED_URLS = ",".join(
    (
        "/health",
        "/health/live",
        "/health/ready",
        "/api/v1/health",
        "/api/v1/health/live",
        "/api/v1/health/ready",
        "/docs",
        "/redoc",
        "/openapi.json",
        "/api/v1/docs",
        "/api/v1/redoc",
        "/api/v1/openapi.json",
        "/metrics",
    )
)

#: A flush that hangs is worse than a lost batch: it holds a SIGTERM'd pod open
#: until the kubelet escalates to SIGKILL, which loses the batch anyway.
FLUSH_TIMEOUT_MS = 5000


def build_resource(config: ObservabilityConfig) -> Resource:
    """The resource attributes every span from this process carries.

    ``deployment.environment`` is emitted in BOTH spellings: ``.name`` is the
    current semantic convention, the bare key is what existing Grafana queries
    read. Dropping either one breaks a dashboard silently.
    """
    return Resource.create(
        {
            "service.name": config.service_name,
            "service.version": config.service_version,
            "service.namespace": config.service_namespace,
            "deployment.environment": config.deployment_environment,
            "deployment.environment.name": config.deployment_environment,
            "telemetry.sdk.language": "python",
        }
    )


def build_sampler(ratio: float) -> ParentBased:
    """``ParentBased(TraceIdRatioBased(ratio))`` — declared once, here (R-8).

    Parent-based so a sampling decision taken at the edge is honoured all the
    way down: a service that re-decides for itself produces traces with holes in
    them. A service never picks its own sampler.
    """
    return ParentBased(root=TraceIdRatioBased(ratio))


def build_tracer_provider(config: ObservabilityConfig) -> TracerProvider | None:
    """Build a batching, OTLP-exporting ``TracerProvider``, or ``None``.

    ``None`` means "no endpoint configured", which is the documented off state —
    not a failure. The global provider is deliberately NOT set here; the caller
    sets it once instrumentation has succeeded, so a half-configured process
    never advertises a provider nothing will flush.

    The gRPC exporter connects lazily, so an unreachable collector is a runtime
    export failure (retried, then dropped), never a configuration failure. That
    is the point: telemetry must not be able to stop a service from starting.
    """
    if not config.tracing_enabled or config.otlp_endpoint is None:
        return None

    provider = TracerProvider(
        resource=build_resource(config),
        sampler=build_sampler(config.traces_sampler_ratio),
    )
    exporter = OTLPSpanExporter(endpoint=config.otlp_endpoint, insecure=config.insecure)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    return provider


def instrument_fastapi(app: FastAPI, tracer_provider: TracerProvider | None = None) -> None:
    """Instrument inbound HTTP and outbound httpx for a FastAPI app.

    ``server_request_hook`` is passed UNCONDITIONALLY (R-7/F-13) — there is no
    argument for switching PHI redaction off, so there is no argument for it.
    """
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    FastAPIInstrumentor.instrument_app(
        app,
        excluded_urls=EXCLUDED_URLS,
        # `phi_sanitization_hook` is typed against the `SpanLike` protocol it
        # actually uses; the instrumentation declares the narrower
        # `opentelemetry.trace.Span`, which the SDK span satisfies
        # structurally but not nominally.
        server_request_hook=cast(
            "Callable[[trace.Span, dict[str, Any]], None]", phi_sanitization_hook
        ),
        tracer_provider=tracer_provider,
    )
    instrument_httpx(tracer_provider)


def instrument_httpx(tracer_provider: TracerProvider | None = None) -> None:
    """Instrument outbound httpx calls, so peer-service calls join the trace."""
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

    HTTPXClientInstrumentor().instrument(tracer_provider=tracer_provider)


def uninstrument_fastapi(app: FastAPI) -> None:
    """Best-effort teardown; shutdown is never allowed to raise."""
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor().uninstrument_app(app)
    except Exception as exc:  # noqa: BLE001 - teardown is best-effort
        _LOGGER.debug("hope_obs.tracing.uninstrument_fastapi_failed: %s", exc)


def uninstrument_httpx() -> None:
    """Best-effort teardown; shutdown is never allowed to raise."""
    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

        HTTPXClientInstrumentor().uninstrument()
    except Exception as exc:  # noqa: BLE001 - teardown is best-effort
        _LOGGER.debug("hope_obs.tracing.uninstrument_httpx_failed: %s", exc)


def shutdown_tracer_provider(provider: TracerProvider | None) -> None:
    """Flush buffered spans, then stop the provider. Never raises.

    Without the flush, every span still in the batch processor when a pod is
    rolled is lost — which is exactly the window a crash-loop investigation
    needs.
    """
    if provider is None:
        return
    try:
        provider.force_flush(timeout_millis=FLUSH_TIMEOUT_MS)
    except Exception as exc:  # noqa: BLE001 - shutdown is best-effort
        _LOGGER.warning("hope_obs.tracing.flush_failed: %s", exc)
    try:
        provider.shutdown()
    except Exception as exc:  # noqa: BLE001 - shutdown is best-effort
        _LOGGER.warning("hope_obs.tracing.shutdown_failed: %s", exc)


def get_tracer(name: str) -> trace.Tracer:
    """Return a tracer resolved against the CURRENT global provider.

    A proxy, not a bound instance: a module-level ``tracer = get_tracer(...)``
    keeps working after the provider is installed, and tests can swap providers
    without stale references.
    """
    return trace.get_tracer(name)
