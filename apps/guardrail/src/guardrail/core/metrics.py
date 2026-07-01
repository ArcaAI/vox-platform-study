"""Custom Prometheus metrics for the Guardrail service.

Exposes the standardized cross-service per-model metrics on the existing
``/metrics`` endpoint (served from the default Prometheus registry by
``guardrail.main``). These are scraped by Prometheus for the platform-metrics
backend (TASK-386).
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager

from prometheus_client import Gauge, Histogram

# ---------------------------------------------------------------------------
# Cross-service per-model contract metrics (TASK-386)
# ---------------------------------------------------------------------------
# Standardized {service, model} pair emitted IDENTICALLY by every HOPE model
# service (STT, SMR, NLP, Guardrail) so the platform-metrics backend can read
# per-model "running" + "avg latency" with ONE PromQL pattern. The name and
# label keys must stay byte-identical across services — see
# docs/implementation/TASK-386-Platform-Metrics-Backend/METRIC-CONTRACT.md.

SERVICE_NAME = "guardrail"

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
        0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0,
        2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0,
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
