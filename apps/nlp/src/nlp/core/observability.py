import logging

from fastapi import FastAPI
from prometheus_fastapi_instrumentator import Instrumentator, metrics as prometheus_metrics
from opentelemetry.sdk.resources import Resource, SERVICE_NAME, SERVICE_VERSION, DEPLOYMENT_ENVIRONMENT, TELEMETRY_SDK_LANGUAGE
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.logging import LoggingInstrumentor
from opentelemetry import trace, metrics
from opentelemetry._logs import set_logger_provider
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter

from nlp.core.logging import get_logger
from nlp.core.config import settings

logger = get_logger("observability")


def _phi_sanitization_hook(span, scope):
    """Strip attributes that could contain PHI from OTel spans."""
    if span and span.is_recording():
        for attr in ("http.request.body", "http.response.body"):
            span.set_attribute(attr, "[REDACTED]")


def setup_opentelemetry(app: FastAPI) -> None:
    if not settings.service.otlp_endpoint:
        logger.warning("OTEL_EXPORTER_OTLP_ENDPOINT not set — OpenTelemetry disabled")
        return

    otlp_endpoint = settings.service.otlp_endpoint

    resource = Resource(
        attributes={
            SERVICE_NAME: settings.service.name,
            SERVICE_VERSION: settings.service.version,
            TELEMETRY_SDK_LANGUAGE: "python",
            DEPLOYMENT_ENVIRONMENT: settings.service.environment.value,
            **settings.service.resource_attributes,
        },
    )

    tracer_provider = None

    if settings.service.traces_enabled:
        tracer_provider = TracerProvider(resource=resource)
        trace.set_tracer_provider(tracer_provider)
        app.state.tracer_provider = tracer_provider

        tracer_provider.add_span_processor(
            BatchSpanProcessor(
                OTLPSpanExporter(endpoint=otlp_endpoint, insecure=True),
                max_export_batch_size=512,
                export_timeout_millis=2000,
                schedule_delay_millis=500,
            ),
        )

    if settings.service.metrics_enabled:
        metric_readers = [
            PeriodicExportingMetricReader(
                OTLPMetricExporter(endpoint=otlp_endpoint, insecure=True),
                export_interval_millis=15000,
            )
        ]
        meter_provider = MeterProvider(resource=resource, metric_readers=metric_readers)
        metrics.set_meter_provider(meter_provider)
        app.state.meter_provider = meter_provider

    log_exporter = OTLPLogExporter(endpoint=otlp_endpoint, insecure=True)
    logger_provider = LoggerProvider(resource=resource)
    logger_provider.add_log_record_processor(BatchLogRecordProcessor(log_exporter))
    set_logger_provider(logger_provider)
    app.state.logger_provider = logger_provider

    otel_log_handler = LoggingHandler(level=logging.DEBUG, logger_provider=logger_provider)
    logging.getLogger().addHandler(otel_log_handler)

    excluded_endpoints = [
        "/docs",
        "/redoc",
        "/openapi.json",
        "/metrics",
        "/api/v1/health",
        "/api/v1/health/live",
        "/api/v1/health/ready",
    ]

    instrument_kwargs = dict(
        excluded_urls=",".join(excluded_endpoints),
        server_request_hook=_phi_sanitization_hook,
        client_request_hook=None,
        client_response_hook=None,
    )
    if tracer_provider is not None:
        instrument_kwargs["tracer_provider"] = tracer_provider

    FastAPIInstrumentor().instrument_app(app, **instrument_kwargs)

    logging_kwargs = dict(set_logging_format=False)
    if tracer_provider is not None:
        logging_kwargs["tracer_provider"] = tracer_provider

    LoggingInstrumentor().instrument(**logging_kwargs)

    logger.info(
        "OpenTelemetry initialized",
        extra={"otlp_endpoint": otlp_endpoint, "traces": settings.service.traces_enabled, "metrics": settings.service.metrics_enabled},
    )


def shutdown_opentelemetry(app: FastAPI) -> None:
    if not settings.service.otlp_endpoint:
        return

    if hasattr(app.state, "tracer_provider") and app.state.tracer_provider:
        app.state.tracer_provider.shutdown()
    if hasattr(app.state, "meter_provider") and app.state.meter_provider:
        app.state.meter_provider.shutdown()
    if hasattr(app.state, "logger_provider") and app.state.logger_provider:
        app.state.logger_provider.shutdown()

    try:
        LoggingInstrumentor().uninstrument()
    except Exception:
        pass
    FastAPIInstrumentor().uninstrument_app(app)


def setup_prometheus(app: FastAPI) -> None:
    Instrumentator(
        should_group_status_codes=False,
        should_ignore_untemplated=True,
        should_respect_env_var=True,
        should_instrument_requests_inprogress=True,
        excluded_handlers=["/metrics", "/health"],
        env_var_name="ENABLE_METRICS",
        inprogress_name="fastapi_inprogress",
        inprogress_labels=True,
    ).add(prometheus_metrics.default(), prometheus_metrics.combined_size()).instrument(app=app, metric_namespace="nlp").expose(
        app=app, should_gzip=True
    )
