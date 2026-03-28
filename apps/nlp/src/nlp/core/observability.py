from fastapi import FastAPI
from prometheus_fastapi_instrumentator import Instrumentator, metrics as prometheus_metrics
from opentelemetry.sdk.resources import Resource, SERVICE_NAME, SERVICE_VERSION, DEPLOYMENT_ENVIRONMENT, TELEMETRY_SDK_LANGUAGE
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.logging import LoggingInstrumentor
from opentelemetry import trace, metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

from nlp.core.logging import get_logger
from nlp.core.config import settings

logger = get_logger("observability")


def setup_opentelemetry(app: FastAPI) -> None:
    if not settings.service.opentelemetry_endpoint:
        return

    resource = Resource(
        attributes={
            SERVICE_NAME: settings.service.name,
            SERVICE_VERSION: settings.service.version,
            TELEMETRY_SDK_LANGUAGE: "python",
            DEPLOYMENT_ENVIRONMENT: settings.service.environment,
            **(settings.service.resource_attributes or {}),
        },
    )

    tracer_provider = None

    if settings.service.traces_enabled:
        tracer_provider = TracerProvider(resource=resource)
        trace.set_tracer_provider(tracer_provider)
        app.state.tracer_provider = tracer_provider

        otlp_endpoint = settings.service.otlp_endpoint or settings.service.opentelemetry_endpoint
        if otlp_endpoint:
            tracer_provider.add_span_processor(
                BatchSpanProcessor(
                    OTLPSpanExporter(endpoint=otlp_endpoint),
                    max_export_batch_size=512,
                    export_timeout_millis=2000,
                    schedule_delay_millis=500,
                ),
            )

    if settings.service.metrics_enabled:
        meter_provider = MeterProvider(resource=resource)
        metrics.set_meter_provider(meter_provider)
        app.state.meter_provider = meter_provider

    excluded_endpoints = [
        "/docs",
        "/redoc",
        "/openapi.json",
        "/metrics",
    ]

    instrument_kwargs = dict(
        excluded_urls=",".join(excluded_endpoints),
        server_request_hook=None,
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


def shutdown_opentelemetry(app: FastAPI) -> None:
    if not settings.service.opentelemetry_endpoint:
        return

    if hasattr(app.state, "tracer_provider") and app.state.tracer_provider:
        app.state.tracer_provider.shutdown()
    if hasattr(app.state, "meter_provider") and app.state.meter_provider:
        app.state.meter_provider.shutdown()

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
