"""OpenTelemetry tracing + NLP's own OTel metrics (TASK-987 R-2/R-5/R-6/R-7).

Logging, request context and tracing route entirely through `hope_obs` — see
`nlp.core.logging.build_observability_config`. NLP's OTel `MeterProvider`
stays HERE and is NOT moved into `hope_obs`: `hope_obs` deliberately has no
metrics path (NLP is its only consumer, and an abstraction for a single caller
is exactly what this repo's rules say not to build — orchestrator decision,
TASK-987 README §6.3 lane E, 2026-09-18). `nlp.core.metrics` creates seven
live OTel instruments that this module's `MeterProvider` exports; dropping it
here would silently take away NLP's only metrics-export path.

Finding F-02: `hope-platform-config` already sets `OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_TRACES_ENABLED=true` and `OTEL_METRICS_ENABLED=true` on this service, and
none of it mattered — `setup_opentelemetry` returned at its first line on a
SIXTH variable, `NLP_OTEL_ENABLED`, that nothing in `hope-v2-dev` ever set.
Under R-2 there is no such master switch: `OTEL_EXPORTER_OTLP_ENDPOINT`
presence is the only tracing enable signal, so the three variables the
operator already set are now sufficient by themselves.
`NLP_OTEL_ENABLED` is honoured for one more release
(`docs/operations/deprecation-register.md`, registered by the orchestrator) —
a live manifest may still set it — but only to emit a deprecation warning; it
no longer decides anything.

Finding F-03: `nlp.core.logging` no longer defines `JsonFormatter`; NLP logs
JSON via `hope_obs` like every other service.

R-5: the OTLP log export path this module used to build (`LoggerProvider`,
`OTLPLogExporter`, `BatchLogRecordProcessor`, `LoggingInstrumentor`) is
deleted. Alloy already tails stdout to Loki; the OTLP log path was a second,
differently-shaped copy of the same lines. Correlation survives because
`traceId`/`spanId` are fields on the JSON line `hope_obs` emits.
"""

from __future__ import annotations

import os
import warnings

from fastapi import FastAPI
from hope_obs import ObservabilityConfig, configure_observability, shutdown_observability
from hope_obs.tracing import build_resource
from opentelemetry import metrics
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from prometheus_fastapi_instrumentator import Instrumentator
from prometheus_fastapi_instrumentator import metrics as prometheus_metrics

from nlp.core.config import settings
from nlp.core.logging import build_observability_config, get_logger

logger = get_logger("observability")

#: The retired master switch (F-02/F-11). No longer read for its value —
#: `os.getenv` presence alone triggers the deprecation warning, so an
#: operator who explicitly sets it to "false" is warned too: the point is
#: "this variable does nothing now", not "tracing is on".
_LEGACY_OTEL_ENABLED_VAR = "NLP_OTEL_ENABLED"


def _warn_if_legacy_otel_flag_set() -> None:
    """F-02's fix, made loud rather than silent for one release (R-2)."""
    if os.getenv(_LEGACY_OTEL_ENABLED_VAR) is None:
        return
    message = (
        f"{_LEGACY_OTEL_ENABLED_VAR} is deprecated (TASK-987 R-2) and no longer "
        "gates tracing, metrics or logging — OTEL_EXPORTER_OTLP_ENDPOINT "
        f"presence is the only enable signal now. {_LEGACY_OTEL_ENABLED_VAR} "
        "will be removed in a future release; unset it."
    )
    warnings.warn(message, DeprecationWarning, stacklevel=2)
    logger.warning("nlp.otel.legacy_enabled_flag_deprecated", variable=_LEGACY_OTEL_ENABLED_VAR)


def _build_metrics_resource(config: ObservabilityConfig) -> Resource:
    """The SAME resource `hope_obs` builds for traces, plus NLP's own extra
    `NLP_OTEL_RESOURCE_ATTRIBUTES`/`OTEL_RESOURCE_ATTRIBUTES`.

    `hope_obs.ObservabilityConfig` carries no field for arbitrary extra
    resource attributes, so `NLPServiceConfig.resource_attributes` would
    otherwise be silently dropped the moment tracing moved to `hope_obs`.
    Merging it onto the shared base keeps it alive for the one signal this
    module still owns, and keeps traces and metrics agreeing about which
    process emitted them (R-7).
    """
    resource = build_resource(config)
    extra = settings.service.resource_attributes
    if extra:
        resource = resource.merge(Resource.create(extra))
    return resource


def _setup_metrics(app: FastAPI, config: ObservabilityConfig) -> None:
    """NLP's own OTel `MeterProvider`. See the module docstring for why this
    stays local rather than moving into `hope_obs`.

    Gated on `config.tracing_enabled` (endpoint presence, R-2) AND
    `settings.service.metrics_enabled` (NLP's own, pre-existing switch —
    unaffected by this ticket, still gates the Prometheus `/metrics` mount in
    `setup_prometheus` below via the same field).
    """
    app.state.meter_provider = None
    endpoint = config.otlp_endpoint
    if not config.tracing_enabled or endpoint is None or not settings.service.metrics_enabled:
        return

    metric_readers = [
        PeriodicExportingMetricReader(
            OTLPMetricExporter(endpoint=endpoint, insecure=config.insecure),
            export_interval_millis=15000,
        )
    ]
    meter_provider = MeterProvider(
        resource=_build_metrics_resource(config), metric_readers=metric_readers
    )
    metrics.set_meter_provider(meter_provider)
    app.state.meter_provider = meter_provider
    logger.info("nlp.otel.metrics_enabled", endpoint=endpoint, service=config.service_name)


def setup_opentelemetry(app: FastAPI) -> None:
    """Configure logging, request context, tracing and NLP's own metrics.

    Called once from the lifespan, exactly where this has always been called
    from. `configure_observability` never raises (hope_obs R-2): a
    misconfigured or unreachable collector degrades to no-tracing, never to a
    failed boot — the posture this service already had.
    """
    _warn_if_legacy_otel_flag_set()
    config = build_observability_config()
    configure_observability(app, config)
    _setup_metrics(app, config)


def shutdown_opentelemetry(app: FastAPI) -> None:
    """Flush and uninstrument tracing, then shut down NLP's own MeterProvider.

    Safe to call after a skipped setup, and safe to call twice — mirrors
    `hope_obs.shutdown_observability`'s own contract.
    """
    shutdown_observability(app)
    meter_provider = getattr(app.state, "meter_provider", None)
    if meter_provider is not None:
        meter_provider.shutdown()
    app.state.meter_provider = None


def setup_prometheus(app: FastAPI) -> None:
    """Mount ``/metrics`` and instrument HTTP requests.

    Gated on ``settings.service.metrics_enabled`` — the same switch every other
    Python service uses. It previously used the instrumentator's own
    ``should_respect_env_var``/``ENABLE_METRICS`` gate, which no environment
    ever set, so ``/metrics`` 404'd everywhere.

    HTTP series are deliberately NOT namespaced: the
    fleet-wide contract is ``http_*``, which the Prometheus relabel rule
    (``__name__ =~ "http_.*"``) and ``PlatformMetricsService``'s
    ``sum by (service) (rate(http_requests_total[5m]))`` both depend on.
    """
    if not settings.service.metrics_enabled:
        logger.info("nlp.prometheus.disabled", reason="metrics_enabled=false")
        return

    Instrumentator(
        should_group_status_codes=False,
        should_ignore_untemplated=True,
        should_instrument_requests_inprogress=True,
        excluded_handlers=["/metrics", "/health"],
        inprogress_name="fastapi_inprogress",
        inprogress_labels=True,
    ).add(prometheus_metrics.default(), prometheus_metrics.combined_size()).instrument(
        app=app
    ).expose(
        app=app, should_gzip=True
    )
