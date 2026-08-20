"""Prometheus metrics for the TTS service.

TTFA (time-to-first-audio) and RTF (real-time factor) are the headline SLO
signals; the rest track routing health and concurrency.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager

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
# Usage-metering counters
# ---------------------------------------------------------------------------
# Accepted input characters (1 Unicode code point = 1 char) and
# synthesized output audio-seconds, both by provider/locale/status. The
# gateway is the ledger emitter (D3); these are the platform-metrics/Grafana
# signal, not the billing source of truth.
# Named without the `_total` suffix, like TTS_REQUESTS above —
# prometheus_client appends it at export time.
TTS_CHARACTERS_TOTAL = Counter(
    "tts_characters",
    "Accepted input characters (Unicode code points), by provider, locale, and status",
    ["provider", "locale", "status"],
)

TTS_SYNTHESIZED_SECONDS_TOTAL = Counter(
    "tts_synthesized_seconds",
    "Synthesized output audio-seconds, by provider, locale, and status",
    ["provider", "locale", "status"],
)


# ---------------------------------------------------------------------------
# Cross-service per-model contract metrics
# ---------------------------------------------------------------------------
# Standardized {service, model} pair emitted IDENTICALLY by every HOPE model
# service (STT, TEXT, NLP, Guardrail) so the platform-metrics backend can read
# per-model "running" + "avg latency" with ONE PromQL pattern. The name and
# label keys must stay byte-identical across services. TTS was the one
# service missing this pair (current-state-review §2.0/§2.5); "model" here is
# the provider/engine name — TTS has no separate per-request model concept.

SERVICE_NAME = "tts"

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
    """Track one model (provider) inference: bump the running gauge for its
    duration and observe its latency.

    Safe for sync or async call-sites (``with track_model_inference(...):``
    around an ``await`` times the whole awaited block). The gauge is always
    decremented, even when the inference raises.
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
