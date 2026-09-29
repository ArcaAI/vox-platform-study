"""Prometheus series for the decode path — the autoscaling signals the ticket asks for.

``hope_vllm_inflight_windows`` (queue depth at this replica) and
``hope_vllm_engine_queue_seconds`` (vLLM scheduler wait) are the two candidate HPA
signals; ``hope_vllm_engine_load_seconds`` is the cold-start cost a scale-out pays.
Labels carry the runtime key only — never a tenant id or any request content.
"""

from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram

_LATENCY_BUCKETS = (0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 7.5, 10.0, 15.0, 30.0, 60.0)

INFLIGHT_WINDOWS = Gauge(
    "hope_vllm_inflight_windows", "Decode windows accepted and not yet answered"
)
WINDOWS_TOTAL = Counter("hope_vllm_windows_total", "Decode windows by outcome", ["outcome"])
SERVICE_QUEUE_SECONDS = Histogram(
    "hope_vllm_service_queue_seconds",
    "Wait for a ready engine before submit (engine load / single-flight)",
    buckets=_LATENCY_BUCKETS,
)
DECODE_SECONDS = Histogram(
    "hope_vllm_decode_seconds",
    "Engine submit to final output (includes vLLM's own scheduling)",
    buckets=_LATENCY_BUCKETS,
)
ENGINE_QUEUE_SECONDS = Histogram(
    "hope_vllm_engine_queue_seconds",
    "vLLM scheduler wait per window, when reported by the engine",
    buckets=_LATENCY_BUCKETS,
)
TRUNCATION_SUSPECTED_TOTAL = Counter(
    "hope_vllm_truncation_suspected_total", "Windows flagged as possibly truncated", ["reason"]
)
ENGINE_LOAD_SECONDS = Histogram(
    "hope_vllm_engine_load_seconds",
    "Cold start of one engine (weights + CUDA graphs)",
    buckets=(1, 5, 10, 20, 30, 60, 120, 300),
)
