"""Custom Prometheus metrics for STT-v2 operations.

Covers transcription jobs, streaming sessions, model loading, VAD
processing, and inference latency — the key signals needed for the
AI Pipeline Performance dashboard in Grafana.
"""

from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram

# ---------------------------------------------------------------------------
# Transcription job metrics
# ---------------------------------------------------------------------------

TRANSCRIPTION_TOTAL = Counter(
    "stt_v2_transcription_total",
    "Total transcription requests",
    ["pipeline", "engine", "status"],
)

TRANSCRIPTION_LATENCY = Histogram(
    "stt_v2_transcription_latency_seconds",
    "End-to-end transcription latency in seconds",
    ["pipeline", "engine"],
    buckets=[0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0, 600.0],
)

TRANSCRIPTION_ERRORS = Counter(
    "stt_v2_transcription_errors_total",
    "Total transcription errors",
    ["pipeline", "error_type"],
)

TRANSCRIPTION_AUDIO_DURATION = Histogram(
    "stt_v2_audio_duration_seconds",
    "Duration of audio files submitted for transcription",
    buckets=[5, 15, 30, 60, 120, 300, 600, 1800, 3600],
)

# ---------------------------------------------------------------------------
# Streaming session metrics
# ---------------------------------------------------------------------------

STREAMING_SESSIONS_ACTIVE = Gauge(
    "stt_v2_streaming_sessions_active",
    "Currently active streaming sessions",
)

STREAMING_SESSIONS_TOTAL = Counter(
    "stt_v2_streaming_sessions_total",
    "Total streaming sessions started",
    ["status"],
)

STREAMING_INFERENCE_LATENCY = Histogram(
    "stt_v2_streaming_inference_latency_seconds",
    "Per-utterance ASR inference latency in streaming mode",
    buckets=[0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0],
)

# ---------------------------------------------------------------------------
# Model loading metrics
# ---------------------------------------------------------------------------

MODEL_LOAD_LATENCY = Histogram(
    "stt_v2_model_load_latency_seconds",
    "Model loading latency in seconds",
    ["model", "engine"],
    buckets=[0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0],
)

MODEL_CACHE_HITS = Counter(
    "stt_v2_model_cache_hits_total",
    "Model cache hit count",
)

MODEL_CACHE_MISSES = Counter(
    "stt_v2_model_cache_misses_total",
    "Model cache miss count (cold load required)",
)

# ---------------------------------------------------------------------------
# VAD (Voice Activity Detection) metrics
# ---------------------------------------------------------------------------

VAD_SEGMENTS_DETECTED = Counter(
    "stt_v2_vad_segments_total",
    "Total speech segments detected by VAD",
)

VAD_PROCESSING_LATENCY = Histogram(
    "stt_v2_vad_processing_latency_seconds",
    "VAD processing latency per audio chunk",
    buckets=[0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
)

# ---------------------------------------------------------------------------
# Worker / queue metrics
# ---------------------------------------------------------------------------

WORKER_JOBS_IN_PROGRESS = Gauge(
    "stt_v2_worker_jobs_in_progress",
    "Dramatiq jobs currently being processed",
)

WORKER_JOBS_TOTAL = Counter(
    "stt_v2_worker_jobs_total",
    "Total Dramatiq jobs processed",
    ["queue", "status"],
)
