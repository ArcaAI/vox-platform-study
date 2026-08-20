"""Custom Prometheus metrics for STT operations.

Covers transcription jobs, streaming sessions, model loading, VAD
processing, and inference latency — the key signals needed for the
AI Pipeline Performance dashboard in Grafana.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager

from hope_runtime_models import PrometheusMetricsSink
from prometheus_client import Counter, Gauge, Histogram

# ---------------------------------------------------------------------------
# Transcription job metrics
# ---------------------------------------------------------------------------

TRANSCRIPTION_TOTAL = Counter(
    "stt_transcription_total",
    "Total transcription requests",
    ["pipeline", "engine", "status"],
)

TRANSCRIPTION_LATENCY = Histogram(
    "stt_transcription_latency_seconds",
    "End-to-end transcription latency in seconds",
    ["pipeline", "engine"],
    buckets=[0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0, 600.0],
)

TRANSCRIPTION_ERRORS = Counter(
    "stt_transcription_errors_total",
    "Total transcription errors",
    ["pipeline", "error_type"],
)

TRANSCRIPTION_AUDIO_DURATION = Histogram(
    "stt_audio_duration_seconds",
    "Duration of audio files submitted for transcription",
    buckets=[5, 15, 30, 60, 120, 300, 600, 1800, 3600],
)

# ---------------------------------------------------------------------------
# Cloud ASR / provider-fallback metrics
# ---------------------------------------------------------------------------

# Classified cloud-ASR failures, emitted at the REST error-mapping boundary of
# the Sarvam/OpenAI engines. ``class`` is the CloudASR* taxonomy bucket
# (auth | quota | transcription).
STT_CLOUD_ASR_ERRORS_TOTAL = Counter(
    "stt_cloud_asr_errors_total",
    "Cloud ASR provider errors by classified taxonomy bucket",
    ["provider", "class"],
)

# In-session provider switches (primary -> fallback). Emission site lives in the
# streaming EngineSwitchController (deferred with the switch runtime); defined
# here so the dashboard/query contract is stable ahead of that wiring.
STT_PROVIDER_SWITCH_TOTAL = Counter(
    "stt_provider_switch_total",
    "STT in-session provider switches from primary to fallback",
    ["tenant", "from", "to", "reason"],
)

# ---------------------------------------------------------------------------
# Streaming session metrics
# ---------------------------------------------------------------------------

STREAMING_SESSIONS_ACTIVE = Gauge(
    "stt_streaming_sessions_active",
    "Currently active streaming sessions",
)

STREAMING_SESSIONS_TOTAL = Counter(
    "stt_streaming_sessions_total",
    "Total streaming sessions started",
    ["status"],
)

STREAMING_INFERENCE_LATENCY = Histogram(
    "stt_streaming_inference_latency_seconds",
    "Per-utterance ASR inference latency in streaming mode",
    buckets=[0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0],
)

# The streaming counterpart to the batch-only
# stt_audio_duration_seconds (that one intentionally stays unlabeled; batch
# gets pipeline/engine/status on the separate stt_transcription_* series
# instead). Recorded ONCE per session at teardown (`record_streaming_teardown`,
# called from SessionManager._finalize_session_locked). Labels bounded to
# {pipeline, engine, status} — no tenant label; this plane stays PHI-free.
STREAMING_AUDIO_DURATION = Histogram(
    "stt_streaming_audio_duration_seconds",
    "Decoded audio seconds ingested per streaming session (total_duration_seconds at teardown)",
    ["pipeline", "engine", "status"],
    buckets=[5, 15, 30, 60, 120, 300, 600, 1800, 3600],
)

# Real-time factor: cumulative per-utterance ASR processing time / decoded
# audio seconds for the session. A live streaming system must sustain
# RTF < 1 (the engine transcribes faster than audio arrives) — this is the
# gap the current-state review flagged ("processing time and audio duration
# are never divided" for streaming, unlike TTS). NOT the same denominator as
# stt_transcription_latency_seconds (batch's end-to-end wall clock): this is
# accumulated ASR-only time across every utterance in the session.
STREAMING_RTF = Histogram(
    "stt_streaming_rtf",
    "Streaming real-time factor (cumulative per-utterance ASR processing seconds / audio seconds)",
    ["pipeline", "engine", "status"],
    buckets=[0.05, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 5.0],
)

# F-08 — steady-state utterances dropped when the per-session inference queue
# stays full past the bounded enqueue wait. Captions degrade (a dropped
# utterance is missing from the live transcript); the durable Redis audio
# pipeline is unaffected (it keeps draining/XACK'ing independently of this
# in-process queue).
STREAMING_INFERENCE_QUEUE_DROPPED_TOTAL = Counter(
    "stt_streaming_inference_queue_dropped_total",
    "Utterances dropped because the streaming inference queue stayed full "
    "past the bounded enqueue wait",
)

# ---------------------------------------------------------------------------
# Model loading metrics
# ---------------------------------------------------------------------------

MODEL_LOAD_LATENCY = Histogram(
    "stt_model_load_latency_seconds",
    "Model loading latency in seconds",
    ["model", "engine"],
    buckets=[0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0],
)

MODEL_CACHE_HITS = Counter(
    "stt_model_cache_hits_total",
    "Model cache hit count",
)

MODEL_CACHE_MISSES = Counter(
    "stt_model_cache_misses_total",
    "Model cache miss count (cold load required)",
)

# ---------------------------------------------------------------------------
# VAD (Voice Activity Detection) metrics
# ---------------------------------------------------------------------------

VAD_SEGMENTS_DETECTED = Counter(
    "stt_vad_segments_total",
    "Total speech segments detected by VAD",
)

VAD_PROCESSING_LATENCY = Histogram(
    "stt_vad_processing_latency_seconds",
    "VAD processing latency per audio chunk",
    buckets=[0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
)

# ---------------------------------------------------------------------------
# Worker / queue metrics
# ---------------------------------------------------------------------------

WORKER_JOBS_IN_PROGRESS = Gauge(
    "stt_worker_jobs_in_progress",
    "Dramatiq jobs currently being processed",
)

WORKER_JOBS_TOTAL = Counter(
    "stt_worker_jobs_total",
    "Total Dramatiq jobs processed",
    ["queue", "status"],
)

# Pending (undelivered) messages waiting to be claimed by a worker, per
# queue. Computed lazily at scrape time (Gauge.set_function, wired in
# core/messaging/broker.py::_wire_queue_depth_gauge) from the broker's own
# do_qsize() — not a hand-rolled Redis LLEN against internal key structure.
# This is the metric a KEDA ScaledObject (deployment repo) reads for the
# stt_batch worker pool.
WORKER_QUEUE_DEPTH = Gauge(
    "stt_worker_queue_depth",
    "Pending (undelivered) Dramatiq messages waiting to be claimed by a worker, by queue",
    ["queue"],
)

# ---------------------------------------------------------------------------
# Cross-service per-model contract metrics
# ---------------------------------------------------------------------------
# Standardized {service, model} pair emitted IDENTICALLY by every HOPE model
# service (STT, TEXT, NLP, Guardrail) so the platform-metrics backend can read
# per-model "running" + "avg latency" with ONE PromQL pattern. The name and
# label keys must stay byte-identical across services.

SERVICE_NAME = "stt"

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
    observe its latency.

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
# Domain helpers — wired into the real STT code paths
# ---------------------------------------------------------------------------
# These wrap the (previously dead) domain metrics above so the call-sites in
# batch_service / session_manager stay one-liners.


def record_transcription(
    *,
    pipeline: str,
    engine: str,
    status: str,
    latency_seconds: float,
    audio_seconds: float,
) -> None:
    """Record one completed/failed batch transcription job.

    ``audio_seconds`` feeds ``stt_audio_duration_seconds`` whose ``_sum``
    is the platform "transcription minutes" signal (``_sum / 60``).
    """
    TRANSCRIPTION_TOTAL.labels(pipeline=pipeline, engine=engine, status=status).inc()
    TRANSCRIPTION_LATENCY.labels(pipeline=pipeline, engine=engine).observe(
        max(0.0, latency_seconds)
    )
    if audio_seconds > 0:
        TRANSCRIPTION_AUDIO_DURATION.observe(audio_seconds)


def record_transcription_error(*, pipeline: str, error_type: str) -> None:
    TRANSCRIPTION_ERRORS.labels(pipeline=pipeline, error_type=error_type).inc()


def observe_streaming_inference(seconds: float) -> None:
    """Observe one per-utterance streaming ASR inference latency."""
    STREAMING_INFERENCE_LATENCY.observe(max(0.0, seconds))


def record_streaming_teardown(
    *,
    pipeline: str,
    engine: str,
    status: str,
    audio_seconds: float,
    processing_seconds: float,
) -> None:
    """Record one streaming session's audio duration + real-time factor.

    Called once per session at teardown. ``audio_seconds`` <= 0 means no
    audio was ever ingested (e.g. the session failed before any chunk
    arrived) — skipped entirely rather than dividing by zero or recording a
    degenerate empty-session observation. ``processing_seconds`` is clamped
    to >= 0 (a clock/accounting glitch must never yield a negative RTF).
    """
    if audio_seconds <= 0:
        return
    labels = {"pipeline": pipeline, "engine": engine, "status": status}
    STREAMING_AUDIO_DURATION.labels(**labels).observe(audio_seconds)
    STREAMING_RTF.labels(**labels).observe(max(0.0, processing_seconds) / audio_seconds)


def streaming_session_started(active_count: int) -> None:
    """A streaming session was created: count it and sync the active gauge."""
    STREAMING_SESSIONS_TOTAL.labels(status="started").inc()
    STREAMING_SESSIONS_ACTIVE.set(active_count)


def streaming_session_ended(active_count: int) -> None:
    """A streaming session was removed: sync the active gauge to the live count."""
    STREAMING_SESSIONS_ACTIVE.set(max(0, active_count))


def streaming_inference_queue_dropped() -> None:
    """F-08: one utterance was dropped because the inference queue stayed full."""
    STREAMING_INFERENCE_QUEUE_DROPPED_TOTAL.inc()


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
