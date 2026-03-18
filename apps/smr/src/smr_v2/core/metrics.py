"""Custom Prometheus metrics for LLM operations."""

from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram

GENERATION_TOTAL = Counter(
    "smr_v2_generation_total",
    "Total generation requests",
    ["provider", "model", "status"],
)

GENERATION_LATENCY = Histogram(
    "smr_v2_generation_latency_seconds",
    "Generation request latency in seconds",
    ["provider", "model"],
    buckets=[0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0],
)

TOKENS_TOTAL = Counter(
    "smr_v2_tokens_total",
    "Total tokens processed",
    ["provider", "model", "direction"],
)

GENERATION_ERRORS = Counter(
    "smr_v2_generation_errors_total",
    "Total generation errors",
    ["provider", "model", "error_type"],
)

ACTIVE_GENERATIONS = Gauge(
    "smr_v2_active_generations",
    "Currently active generation requests",
    ["provider"],
)

GUARDRAIL_SCANS = Counter(
    "smr_v2_guardrail_scans_total",
    "Total guardrail scans",
    ["result", "risk_level"],
)

PROVIDER_HEALTH = Gauge(
    "smr_v2_provider_health",
    "Provider health status (1=healthy, 0=unhealthy)",
    ["provider"],
)

HEALTH_CHECK_LATENCY = Histogram(
    "smr_v2_health_check_latency_seconds",
    "Health check latency per provider",
    ["provider"],
    buckets=[0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0],
)

TTFT_SECONDS = Histogram(
    "smr_v2_time_to_first_token_seconds",
    "Time to first token for streaming responses",
    ["provider", "model"],
    buckets=[0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0],
)

QUEUE_SIZE = Gauge(
    "smr_v2_queue_size",
    "Current queue size per provider",
    ["provider"],
)

QUEUE_WAIT_TIME = Histogram(
    "smr_v2_queue_wait_seconds",
    "Time spent waiting in queue",
    ["provider"],
    buckets=[0.1, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0],
)

RATE_LIMIT_REJECTIONS = Counter(
    "smr_v2_rate_limit_rejections_total",
    "Requests rejected due to rate limiting",
    ["provider"],
)

CIRCUIT_BREAKER_STATE = Gauge(
    "smr_v2_circuit_breaker_state",
    "Circuit breaker state (0=closed, 1=open, 2=half_open)",
    ["provider"],
)

CONCURRENT_REQUESTS = Gauge(
    "smr_v2_concurrent_requests",
    "Current concurrent requests per provider",
    ["provider"],
)
