"""Custom Prometheus metrics for LLM operations."""

from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager

from prometheus_client import Counter, Gauge, Histogram

GENERATION_TOTAL = Counter(
    "text_generation_total",
    "Total generation requests",
    ["provider", "model", "status"],
)

GENERATION_LATENCY = Histogram(
    "text_generation_latency_seconds",
    "Generation request latency in seconds",
    ["provider", "model"],
    buckets=[0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0],
)

TOKENS_TOTAL = Counter(
    "text_tokens_total",
    "Total tokens processed",
    ["provider", "model", "direction"],
)

GENERATION_ERRORS = Counter(
    "text_generation_errors_total",
    "Total generation errors",
    ["provider", "model", "error_type"],
)

ACTIVE_GENERATIONS = Gauge(
    "text_active_generations",
    "Currently active generation requests",
    ["provider"],
)

PROVIDER_HEALTH = Gauge(
    "text_provider_health",
    "Provider health status (1=healthy, 0=unhealthy)",
    ["provider"],
)

HEALTH_CHECK_LATENCY = Histogram(
    "text_health_check_latency_seconds",
    "Health check latency per provider",
    ["provider"],
    buckets=[0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0],
)

TTFT_SECONDS = Histogram(
    "text_time_to_first_token_seconds",
    "Time to first token for streaming responses",
    ["provider", "model"],
    buckets=[0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0],
)

# decode throughput and normalized stop-reason fleet aggregates.
TOKENS_PER_SECOND = Histogram(
    "text_tokens_per_second",
    "Predicted tokens per second (decode throughput) per generation",
    ["provider", "model"],
    buckets=[1, 2.5, 5, 10, 25, 50, 75, 100, 150, 200, 300, 500],
)

STOP_REASON_TOTAL = Counter(
    "text_stop_reason_total",
    "Generations by normalized AD-1 stop reason",
    ["provider", "model", "stop_reason"],
)

# AD-4 — production-engine prefix/prompt cache visibility. Scraped
# from the engine's own ``/metrics`` (vLLM prefix-cache counters) and re-exported
# here as a single Text-owned gauge so the 4D cache-friendliness dashboard reads
# one metric name regardless of engine.
TEXT_ENGINE_CACHE_HIT_RATE = Gauge(
    "text_engine_cache_hit_rate",
    "Prefix/prompt cache hit rate of the backing inference engine (0.0-1.0).",
    ["engine"],
)

QUEUE_SIZE = Gauge(
    "text_queue_size",
    "Current queue size per provider",
    ["provider"],
)

QUEUE_WAIT_TIME = Histogram(
    "text_queue_wait_seconds",
    "Time spent waiting in queue",
    ["provider"],
    buckets=[0.1, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0],
)

RATE_LIMIT_REJECTIONS = Counter(
    "text_rate_limit_rejections_total",
    "Requests rejected due to rate limiting",
    ["provider"],
)

CIRCUIT_BREAKER_STATE = Gauge(
    "text_circuit_breaker_state",
    "Circuit breaker state (0=closed, 1=open, 2=half_open)",
    ["provider"],
)

CONCURRENT_REQUESTS = Gauge(
    "text_concurrent_requests",
    "Current concurrent requests per provider",
    ["provider"],
)

# ---------------------------------------------------------------------------
# Worker pool — async out-of-process task dispatch, separate from
# the sync-path metrics above. `task_type` ("embedding" | "batch_generation")
# is the label KEDA's Prometheus scaler (arca/hope-v2-deployment, not this
# repo) would key a per-pool `ScaledObject` trigger on. `text_`-prefixed like
# every OTHER metric in this file (post-/740) — a lone differently
# prefixed metric next to them would be its own drift.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Cross-service per-model contract metrics
# ---------------------------------------------------------------------------
# Standardized {service, model} pair emitted IDENTICALLY by every HOPE model
# service (STT, Text, NLP, Guardrail) so the platform-metrics backend can read
# per-model "running" + "avg latency" with ONE PromQL pattern. The name and
# label keys must stay byte-identical across services.

SERVICE_NAME = "text"

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
