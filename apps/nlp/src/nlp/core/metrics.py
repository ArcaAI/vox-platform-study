"""Custom NLP business metrics using OpenTelemetry SDK.

These metrics are exported via OTLP gRPC to the OTel Collector alongside
the generic HTTP metrics from prometheus_fastapi_instrumentator.

Usage in service layer:
    from nlp.core.metrics import nlp_metrics
    with nlp_metrics.track_inference("text_classifier"):
        result = model.predict(text)
    nlp_metrics.record_entities(entity_count=5, entity_type="medication")
"""

from __future__ import annotations

import time
from collections.abc import Generator, Iterator
from contextlib import contextmanager

from hope_runtime_models import PrometheusMetricsSink
from opentelemetry import metrics
from prometheus_client import Counter, Gauge, Histogram


class NLPMetrics:
    """Application-level metrics for NLP model inference and entity extraction."""

    def __init__(self, meter_name: str = "nlp", meter_version: str = "1.0.0"):
        meter = metrics.get_meter(meter_name, meter_version)

        self.inference_duration = meter.create_histogram(
            name="nlp.inference.duration_ms",
            description="Model inference duration in milliseconds",
            unit="ms",
        )

        self.inference_count = meter.create_counter(
            name="nlp.inference.total",
            description="Total model inference requests",
        )

        self.inference_errors = meter.create_counter(
            name="nlp.inference.errors",
            description="Total model inference errors",
        )

        self.entity_count = meter.create_counter(
            name="nlp.entities.total",
            description="Total entities extracted",
        )

        self.classification_confidence = meter.create_histogram(
            name="nlp.classification.confidence",
            description="Classification confidence score distribution",
            unit="1",
        )

        self.active_inferences = meter.create_up_down_counter(
            name="nlp.inference.active",
            description="Currently active inference requests",
        )

        self.model_load_duration = meter.create_histogram(
            name="nlp.model.load_duration_ms",
            description="Model loading duration in milliseconds",
            unit="ms",
        )

    @contextmanager
    def track_inference(self, model_name: str) -> Generator[None, None, None]:
        """Context manager that records inference duration and counts."""
        attrs = {"model": model_name}
        self.inference_count.add(1, attrs)
        self.active_inferences.add(1, attrs)
        start = time.perf_counter()
        try:
            yield
        except Exception:
            self.inference_errors.add(1, attrs)
            raise
        finally:
            duration_ms = (time.perf_counter() - start) * 1000
            self.inference_duration.record(duration_ms, attrs)
            self.active_inferences.add(-1, attrs)

    def record_entities(
        self, entity_count: int, entity_type: str, model: str = "token_classifier"
    ) -> None:
        self.entity_count.add(entity_count, {"entity_type": entity_type, "model": model})
        # The OTel counter above is exported via OTLP gRPC only
        # (not Prometheus-scrapable — see the module docstring). The
        # platform-metrics backend reads Prometheus, so this call ALSO feeds
        # the Prometheus-native counter below. Same call site, two sinks.
        NLP_ENTITIES_TOTAL.labels(model=model, entity_type=entity_type).inc(entity_count)

    def record_confidence(self, score: float, model: str, label: str = "") -> None:
        self.classification_confidence.record(score, {"model": model, "label": label})

    def record_model_load(self, model_name: str, duration_ms: float) -> None:
        self.model_load_duration.record(duration_ms, {"model": model_name})


nlp_metrics = NLPMetrics()


# ---------------------------------------------------------------------------
# Usage-metering counters
# ---------------------------------------------------------------------------
# Prometheus-scrapable counterparts of NLPMetrics.entity_count/inference_count
# (current-state-review §2.4: those are OTel-only). record_entities() (above)
# writes both; TokenClassifier.process() increments the documents counter once
# per call — see services/token_classifier.py, the shared call site behind
# both the REST and WebSocket token-classification routes.
NLP_ENTITIES_TOTAL = Counter(
    "nlp_entities",
    "Entities extracted, by model and entity type",
    ["model", "entity_type"],
)

NLP_DOCUMENTS_PROCESSED_TOTAL = Counter(
    "nlp_documents_processed",
    "Documents (entity-extraction calls) processed, by model",
    ["model"],
)


# ---------------------------------------------------------------------------
# Cross-service per-model contract metrics
# ---------------------------------------------------------------------------
# NLP's domain metrics above use the OpenTelemetry SDK and are exported via
# OTLP gRPC (NOT Prometheus-scrapable). The platform-metrics backend reads
# Prometheus, so the standardized {service, model} pair below is defined with
# prometheus_client so it is exposed on the existing /metrics endpoint
# (served from the default Prometheus registry by the FastAPI instrumentator).
# Name + label keys must stay byte-identical to STT/SMR/Guardrail.

SERVICE_NAME = "nlp"

# Canonical platform model ids (apps/admin/src/features/platform-dashboard/models.ts).
# The HuggingFace source paths (blaze999/Medical-NER,
# shanover/symps_disease_bert_v3_c41) are mapped to these stable ids so the
# per-model dashboards line up across services.
MODEL_MEDICAL_NER = "Medical-NER"
MODEL_SYMPTOMS_DISEASE = "symps-disease-bert"

MODEL_RUNNING_INSTANCES = Gauge(
    "model_running_instances",
    "In-flight inference operations currently running, by service and model.",
    ["service", "model"],
)

MODEL_INFERENCE_LATENCY = Histogram(
    "model_inference_latency_seconds",
    "Per-inference wall-clock latency in seconds, by service and model.",
    ["service", "model"],
    buckets=[
        0.005,
        0.01,
        0.025,
        0.05,
        0.1,
        0.25,
        0.5,
        1.0,
        2.5,
        5.0,
        10.0,
        30.0,
        60.0,
        120.0,
        300.0,
    ],
)


@contextmanager
def track_model_inference(model: str, service: str = SERVICE_NAME) -> Iterator[None]:
    """Track one model inference: bump the running gauge for its duration and
    observe its latency. The gauge is always decremented, even on error.
    """
    MODEL_RUNNING_INSTANCES.labels(service=service, model=model).inc()
    start = time.perf_counter()
    try:
        yield
    finally:
        MODEL_INFERENCE_LATENCY.labels(service=service, model=model).observe(
            time.perf_counter() - start
        )
        MODEL_RUNNING_INSTANCES.labels(service=service, model=model).dec()


# ---------------------------------------------------------------------------
# Model-cache retention metrics
# ---------------------------------------------------------------------------
# FIXED CONTRACT: names and label sets are identical across all five HOPE
# services so one Grafana dashboard
# (`infrastructure/grafana/dashboards/model-retention.json`) reads them all.
# Do not rename these or add labels without updating that dashboard.
MODEL_CACHE_LOADS_TOTAL = Counter(
    "model_cache_loads_total",
    "Model loads performed by an in-process model cache",
    ["cache"],
)

MODEL_CACHE_EVICTIONS_TOTAL = Counter(
    "model_cache_evictions_total",
    "Model evictions by reason (ttl = idle expiry, lru = capacity, vram = GPU pressure)",
    ["cache", "reason"],
)

MODEL_CACHE_RESIDENT_MODELS = Gauge(
    "model_cache_resident_models",
    "Models currently resident in an in-process model cache",
    ["cache"],
)

MODEL_CACHE_RESIDENT_BYTES_ESTIMATE = Gauge(
    "model_cache_resident_bytes_estimate",
    "Estimated resident bytes of models held by an in-process model cache",
    ["cache"],
)


def build_model_cache_metrics_sink() -> PrometheusMetricsSink:
    """The metrics sink to hand to `hope_runtime_models.ModelCache(metrics=...)`."""
    return PrometheusMetricsSink(
        loads_total=MODEL_CACHE_LOADS_TOTAL,
        evictions_total=MODEL_CACHE_EVICTIONS_TOTAL,
        resident_models=MODEL_CACHE_RESIDENT_MODELS,
        resident_bytes_estimate=MODEL_CACHE_RESIDENT_BYTES_ESTIMATE,
    )


# ---------------------------------------------------------------------------
# Inference queue / backpressure metrics (TASK-776)
# ---------------------------------------------------------------------------
# The platform target is >= 100 concurrent consultation sessions. Batching and
# bounded queues only hold that target if the bounds can be TUNED FROM EVIDENCE,
# so the three numbers an operator needs are Prometheus-scrapable here:
#   * how deep the queue is right now  (are we saturated?)
#   * how long items wait in it        (is the ceiling right?)
#   * what we shed and why             (is shedding load, or is a bound wrong?)
# Batch size is included because a batcher that never coalesces is a batcher
# whose linger window is too short — invisible without this histogram.

NLP_INFERENCE_QUEUE_DEPTH = Gauge(
    "nlp_inference_queue_depth",
    "Items waiting for a forward pass, by batcher (excludes in-flight batches).",
    ["batcher"],
)

NLP_INFERENCE_QUEUE_WAIT_SECONDS = Histogram(
    "nlp_inference_queue_wait_seconds",
    "Time an inference request spent queued before its forward pass began.",
    ["batcher"],
    buckets=[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0],
)

NLP_INFERENCE_BATCH_SIZE = Histogram(
    "nlp_inference_batch_size",
    "Items coalesced into one forward pass, by batcher.",
    ["batcher"],
    buckets=[1, 2, 4, 8, 16, 32, 64],
)

NLP_INFERENCE_REJECTIONS_TOTAL = Counter(
    "nlp_inference_rejections",
    "Inference requests SHED rather than served, by route and declared reason.",
    ["route", "reason"],
)


def observe_batch_size(batcher: str, size: int) -> None:
    """Record one coalesced forward pass."""
    NLP_INFERENCE_BATCH_SIZE.labels(batcher=batcher).observe(size)


def observe_queue_wait(batcher: str, seconds: float) -> None:
    """Record how long one request waited before its pass began."""
    NLP_INFERENCE_QUEUE_WAIT_SECONDS.labels(batcher=batcher).observe(max(seconds, 0.0))


def record_rejection(route: str, reason: str) -> None:
    """Count one SHED request. `reason` is declared, never 'unknown'."""
    NLP_INFERENCE_REJECTIONS_TOTAL.labels(route=route, reason=reason).inc()


def publish_queue_depths(depths: dict[str, int]) -> None:
    """Publish current queue depth per batcher onto the gauge."""
    for batcher, depth in depths.items():
        NLP_INFERENCE_QUEUE_DEPTH.labels(batcher=batcher).set(depth)
