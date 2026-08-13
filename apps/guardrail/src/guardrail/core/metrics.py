"""Custom Prometheus metrics for the Guardrail service.

Exposes the standardized cross-service per-model metrics on the existing
``/metrics`` endpoint (served from the default Prometheus registry by
``guardrail.main``). These are scraped by Prometheus for the platform-metrics
backend.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager

from hope_runtime_models import PrometheusMetricsSink
from prometheus_client import Counter, Gauge, Histogram

# ---------------------------------------------------------------------------
# Cross-service per-model contract metrics
# ---------------------------------------------------------------------------
# Standardized {service, model} pair emitted IDENTICALLY by every HOPE model
# service (STT, SMR, NLP, Guardrail) so the platform-metrics backend can read
# per-model "running" + "avg latency" with ONE PromQL pattern. The name and
# label keys must stay byte-identical across services.

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
# Guardrail LLM consumption
# ---------------------------------------------------------------------------
# Guardrail runs an LLM on every generation the platform serves and, until now,
# reported no domain counters at all — its cost was structurally invisible.
#
# LABELS ARE BOUNDED AND CONTAIN NO TENANT. Prometheus is the fleet-health
# plane; per-tenant consumption is answered from Postgres (the usage ledger),
# which has access controls a scrape endpoint does not. Adding a tenant label
# here would also make cardinality grow with the customer list.

GUARDRAIL_REQUESTS_TOTAL = Counter(
    "guardrail_requests_total",
    "Guardrail LLM calls, by provider, model and outcome.",
    ["provider", "model", "status"],
)

GUARDRAIL_TOKENS_TOTAL = Counter(
    "guardrail_tokens_total",
    "Tokens consumed by guardrail's own LLM calls, by provider, model and direction.",
    ["provider", "model", "direction"],
)


def record_guardrail_call(
    *,
    provider: str | None,
    model: str | None,
    status: str,
    prompt_tokens: int | None = 0,
    completion_tokens: int | None = 0,
) -> None:
    """Record one guardrail LLM call. Never raises.

    A telemetry edge case (an odd label, a negative count from a degraded
    engine) must not take down a safety check, so everything here is
    swallow-and-continue. Counters only ever move forward: a negative count is
    clamped to zero rather than rejected.
    """
    try:
        labels = {"provider": provider or "unknown", "model": model or "unknown"}
        GUARDRAIL_REQUESTS_TOTAL.labels(**labels, status=status or "unknown").inc()
        for direction, count in (("input", prompt_tokens), ("output", completion_tokens)):
            amount = max(0, int(count or 0))
            if amount:
                GUARDRAIL_TOKENS_TOTAL.labels(**labels, direction=direction).inc(amount)
    except Exception:  # noqa: BLE001 — telemetry never fails a guardrail call
        return


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
