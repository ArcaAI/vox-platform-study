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
from collections.abc import Generator
from contextlib import contextmanager

from opentelemetry import metrics


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

    def record_entities(self, entity_count: int, entity_type: str, model: str = "token_classifier") -> None:
        self.entity_count.add(entity_count, {"entity_type": entity_type, "model": model})

    def record_confidence(self, score: float, model: str, label: str = "") -> None:
        self.classification_confidence.record(score, {"model": model, "label": label})

    def record_model_load(self, model_name: str, duration_ms: float) -> None:
        self.model_load_duration.record(duration_ms, {"model": model_name})


nlp_metrics = NLPMetrics()
