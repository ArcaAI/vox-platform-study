"""Prometheus metrics for the TTS service.

TTFA (time-to-first-audio) and RTF (real-time factor) are the headline SLO
signals; the rest track routing health and concurrency.
"""

from __future__ import annotations

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
