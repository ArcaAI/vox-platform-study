"""Prometheus metrics for the TTS service.

TTFA (time-to-first-audio) and RTF (real-time factor) are the headline SLO
signals; the rest track routing health and concurrency.
"""

from __future__ import annotations

from hope_runtime_models import PrometheusMetricsSink
from prometheus_client import Counter, Gauge, Histogram

_TTFA_BUCKETS = (0.05, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1.0, 1.5, 2.0, 3.0, 5.0)
_RTF_BUCKETS = (0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1.0, 1.5, 2.0, 3.0, 5.0)

TTS_TTFA = Histogram(
    "tts_ttfa_seconds",
    "Time to first audio byte, per provider and locale",
    ["provider", "locale"],
    buckets=_TTFA_BUCKETS,
)

TTS_RTF = Histogram(
    "tts_rtf",
    "Real-time factor (synthesis_time / audio_duration), per provider",
    ["provider"],
    buckets=_RTF_BUCKETS,
)

TTS_ACTIVE_STREAMS = Gauge(
    "tts_active_streams",
    "In-flight synthesis streams, per provider",
    ["provider"],
)

TTS_MODEL_LOADED = Gauge(
    "tts_model_loaded",
    "Whether a local engine's model is resident (1) or not (0)",
    ["model"],
)

# Counters are named without the `_total` suffix — prometheus_client appends it.
TTS_REQUESTS = Counter(
    "tts_requests",
    "Synthesis requests, by provider, locale, and status",
    ["provider", "locale", "status"],
)

TTS_FAILOVER = Counter(
    "tts_failover",
    "Provider failovers (before first audio byte)",
    ["from_provider", "to_provider"],
)

TTS_PROVIDER_ERRORS = Counter(
    "tts_provider_errors",
    "Provider errors, by provider and exception type",
    ["provider", "type"],
)


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
