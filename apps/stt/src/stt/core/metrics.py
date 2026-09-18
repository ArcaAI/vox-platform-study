"""Custom Prometheus metrics for STT operations.

Covers transcription jobs, streaming sessions (incl. utterance boundaries,
decode-lock contention and ingest lag), model loading, and inference latency —
the key signals needed for the AI Pipeline Performance dashboard in Grafana.

TASK-985 D7 — this module is the METRIC CONTRACT other STT-side call sites
code against; see
``docs/implementation/TASK-985-Realtime-Transcription-Review-And-Best-Practices/README.md``
(findings M-03, M-18, M-19, M-20, M-21, M-44, M-45). VAD-specific metrics
(``VAD_SEGMENTS_DETECTED``/``VAD_PROCESSING_LATENCY``) and the model-cache
hit/miss counters were deleted here (M-19) — see the comments at their former
location, kept so nobody re-adds them under a different name.
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

# TASK-946 — FINAL transcripts whose script contradicted the session's PINNED
# language (e.g. a `language=en` session answering in Malayalam). Not a decode
# error: the engine returns confidently, the text publishes, and the only signal
# before this counter existed was a clinician reading the note. Unlabelled on
# purpose — this is the fleet-wide "is the ml-en fine-tune collapsing again?"
# question; the per-session detail is the `stt.streaming.script_mismatch` log line
# and the `status: degraded` / `reason: script_mismatch` frame the caller receives.
STREAMING_SCRIPT_MISMATCH_TOTAL = Counter(
    "stt_streaming_script_mismatch_total",
    "Final transcripts whose script contradicted the session's pinned language",
)

# TASK-985 M-45 — the denominator `stt_streaming_script_mismatch_total` and
# `stt_streaming_inference_queue_dropped_total` never had: neither ratio-shaped
# alert (`SttTranscriptUtterancesDropped`/`SttScriptMismatch` in the deployment
# repo's `alert-rules.yaml`) could be expressed as a percentage without this,
# so both fire on a bare `increase(...) > 0` today.
#
# ONE call site, enforced structurally by this being the only place that
# increments it: `preprocessor.py`'s `_emit_utterance()` (the single function
# every emit path — force-emit, semantic/silence-timeout endpoint, tail
# `flush()` — already funnels through) via `record_utterance()` below, plus
# ONE additional site in `session_manager.py`'s crash-recovery branch for
# `reason="recovery"` (a recovered session reconstructs one utterance-shaped
# span without ever calling `_emit_utterance()` live). Do NOT add a second
# increment site anywhere else — e.g. a future decode-time/post-ASR
# repeat-guard in `inference.py` — that would double-count the same
# utterance; key a new decode-time signal off a DIFFERENT metric name.
STREAMING_UTTERANCES_TOTAL = Counter(
    "stt_streaming_utterances_total",
    "Utterances closed in streaming mode",
    ["is_final", "engine", "reason"],
)

# Closed 5-value enum for `stt_streaming_utterances_total{reason}` AND the
# `stt.streaming.utterance.closed` log line — ONE source of truth (import
# these rather than re-declaring the strings). Deliberately NARROWER than
# `EndpointDecision.reason`'s 7 values (`semantic_endpointer.py:58-65`): the
# other six (`disabled`, `no_hypothesis`, `too_short`, `below_silence_floor`,
# `incomplete_trailing_filler`, `low_confidence`) are per-FRAME "why not yet"
# decisions inside the 300ms partial cadence — effectively unbounded in
# volume — and belong on a separate Counter keyed on that 7-value set if ever
# wanted (M-39), never as a label on this series. The only
# `EndpointDecision.reason` that can pair with `should_endpoint=True` is
# `REASON_ENDPOINT`, so `REASON_SEMANTIC` below never needs the sub-reason to
# stay bounded.
# TASK-985 (orchestrator integration, 2026-09-19) — these MIRROR
# `stt.streaming.preprocessor.REASON_*`, which is the source of truth because it
# is the code that emits them. The first draft of this enum was written from a
# read of the pre-TASK-985 preprocessor and guessed five names; the segmentation
# lane then implemented seven, overlapping on exactly one (`semantic`). Wiring
# the counter turned that mismatch into 53 hard `ValueError`s — the guard did its
# job, and the fix is for the label set to follow the implementation rather than
# the other way round. `test_metrics_task985.py` pins the parity, so a new emit
# path that forgets this list fails in CI instead of at runtime.
#
# Still deliberately NARROWER than `EndpointDecision.reason` (7 per-FRAME "why not
# yet" values inside the 300 ms partial cadence — effectively unbounded in volume):
# those live on `stt_streaming_endpoint_decisions_total`, never here.
REASON_SEMANTIC = "semantic"  # the semantic endpointer cut it
REASON_SILENCE_TIMER = "silence_timer"  # fixed-timer backstop
REASON_MAX_UTTERANCE_SMART = "max_utterance_smart"  # cap hit, split at the quietest frame
REASON_MAX_UTTERANCE_OVERLAP = "max_utterance_overlap"  # cap hit, split with carry-over
REASON_FLUSH = "flush"  # tail flush at session stop
REASON_FLUSH_PENDING_ONSET = "flush_pending_onset"  # tail flush of unconfirmed onset audio
REASON_PARTIAL = "partial"  # a partial window, not an utterance close
REASON_RECOVERY = "recovery"  # crash-recovery single-segment reconstruction

UTTERANCE_REASONS = frozenset(
    {
        REASON_SEMANTIC,
        REASON_SILENCE_TIMER,
        REASON_MAX_UTTERANCE_SMART,
        REASON_MAX_UTTERANCE_OVERLAP,
        REASON_FLUSH,
        REASON_FLUSH_PENDING_ONSET,
        REASON_PARTIAL,
        REASON_RECOVERY,
    }
)


def record_utterance(*, is_final: bool, engine: str, reason: str) -> None:
    """Record one utterance boundary crossing (M-45's ratio denominator).

    ONE call site — see the design note on `STREAMING_UTTERANCES_TOTAL` above.

    ``engine`` should be the SAME string `record_streaming_teardown` already
    receives for this session (i.e. `resolve_usage_attribution`'s output, or
    ``"unknown"`` — see `batch_service.py:resolve_usage_attribution`), so this
    series stays filterable by the same `engine` value as `stt_streaming_rtf`
    / `stt_streaming_audio_duration_seconds`. NOT validated here: unlike
    `reason`, `engine` is a format-derived enum owned by another module (still
    bounded to low tens — see `ASR_FORMAT_TO_NAME` — just not this function's
    to police).

    Raises ``ValueError`` for a `reason` outside `UTTERANCE_REASONS` — this
    label has no external dependency (it is declared once, right here), so
    catching a typo or an undeclared value here is strictly better than
    letting it silently become a new Prometheus series.
    """
    if reason not in UTTERANCE_REASONS:
        raise ValueError(
            f"Unknown utterance reason {reason!r}; must be one of {sorted(UTTERANCE_REASONS)}"
        )
    STREAMING_UTTERANCES_TOTAL.labels(
        is_final="true" if is_final else "false", engine=engine, reason=reason
    ).inc()


# TASK-985 (orchestrator integration, 2026-09-19) — the segmentation lane's
# call sites import these three names; they are added here, in the module that
# OWNS the metric surface, rather than by widening that lane's reach.
#
# `streaming_utterance_emitted` is a thin adapter over `record_utterance`, NOT a
# second counter: `preprocessor._emit_utterance()` is the single funnel every
# emit path crosses, which is exactly the ONE call site the design note above
# demands. It passes `engine="unknown"` because the preprocessor genuinely does
# not hold the engine (its `__init__` takes no such parameter) — a value
# `record_utterance`'s own contract sanctions. Threading the real engine in at
# construction is a follow-up for whoever owns the preprocessor's construction
# site; until then the series is correct in volume and unsplit by engine.
def streaming_utterance_emitted(*, reason: str, is_final: bool) -> None:
    """Preprocessor-facing alias for :func:`record_utterance` (no engine at hand)."""
    record_utterance(is_final=is_final, engine="unknown", reason=reason)


# M-39 — the per-FRAME endpoint decision, on its OWN series keyed to the 7-value
# `EndpointDecision.reason` set, exactly as the note on
# `STREAMING_UTTERANCES_TOTAL` requires: these are "why not yet" decisions taken
# inside the 300 ms partial cadence, so they must never become a label on the
# utterance counter.
ENDPOINT_DECISION_REASONS = frozenset(
    {
        "disabled",
        "no_hypothesis",
        "too_short",
        "below_silence_floor",
        "incomplete_trailing_filler",
        "low_confidence",
        "endpoint",
        # `preprocessor.py:1008` — the endpointer raised and segmentation degraded
        # to the fixed timer. A real production reason, and one worth seeing.
        "error",
    }
)

#: Bucket for a reason this module has not been taught yet. See the note on
#: :func:`streaming_endpoint_decision` for why these two counters clamp instead
#: of raising.
REASON_OTHER = "other"

STREAMING_ENDPOINT_DECISIONS_TOTAL = Counter(
    "stt_streaming_endpoint_decisions_total",
    "Semantic-endpointer decisions in streaming mode, by reason",
    ["reason"],
)


def streaming_endpoint_decision(*, reason: str) -> None:
    """Record one semantic-endpointer decision (M-39's cut-reason telemetry).

    CLAMPS an undeclared reason to ``"other"`` rather than raising, unlike
    :func:`record_utterance`. This is called from inside the per-FRAME audio loop
    (every 32 ms, per session), and the segmentation lane deliberately bound its
    metric calls behind an ImportError so that "neither half can break the audio
    loop on its own". A label guard that raises there would undo exactly that: a
    reason nobody taught this module would stop transcription rather than produce
    a slightly wrong chart. Cardinality is still bounded — unknowns collapse into
    one series — and the bucket being non-zero is itself the signal to come and
    add the name.
    """
    if reason not in ENDPOINT_DECISION_REASONS:
        reason = REASON_OTHER
    STREAMING_ENDPOINT_DECISIONS_TOTAL.labels(reason=reason).inc()


# D2-N2 — a failing Silero previously logged a WARNING every 32 ms with no
# counter. `stage` is closed and small: the model never loaded, or an inference
# raised.
VAD_DEGRADED_STAGES = frozenset({"not_loaded", "inference"})

STREAMING_VAD_DEGRADED_TOTAL = Counter(
    "stt_streaming_vad_degraded_total",
    "Frames on which VAD was unavailable and segmentation fell back to energy",
    ["stage"],
)


def streaming_vad_degraded(*, stage: str) -> None:
    """Record one VAD-degraded frame (fell back to the energy gate)."""
    if stage not in VAD_DEGRADED_STAGES:
        stage = REASON_OTHER  # per-frame hot path — clamp, never raise (see above)
    STREAMING_VAD_DEGRADED_TOTAL.labels(stage=stage).inc()


# TASK-985 M-26 — lock-ACQUISITION wait, not hold time. Time the interval at
# the call site (`start = time.monotonic()` before `with self._lock:`, then
# call this immediately after acquiring — `whisper_cpp_asr.py:465`, right
# before `_decode_spans_locked`); a context manager here would necessarily
# time the whole locked block, not just the wait to get into it.
STREAMING_LOCK_WAIT_SECONDS = Histogram(
    "stt_streaming_lock_wait_seconds",
    "Time spent waiting to acquire the streaming decode lock, by model/engine",
    ["model", "engine"],
    buckets=[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
)


def record_lock_wait(*, model: str, engine: str, seconds: float) -> None:
    """Record one streaming decode-lock acquisition wait (M-26 concurrency signal).

    ``engine`` is a per-adapter constant (e.g. ``"whisper_cpp"`` for
    `WhisperCppEngine` — a faster-whisper/CT2 adapter would pass its own
    constant), not a per-request lookup.
    """
    STREAMING_LOCK_WAIT_SECONDS.labels(model=model, engine=engine).observe(max(0.0, seconds))


# TASK-985 M-03 — deliberately UNLABELLED, matching the
# `STREAMING_INFERENCE_QUEUE_DROPPED_TOTAL` precedent above ("unlabeled on
# purpose"): a per-session or per-tenant label on a transport-timing
# histogram is both a cardinality risk and adds nothing a log line + trace
# span doesn't already give at session grain.
STREAMING_INGEST_LAG_SECONDS = Histogram(
    "stt_ingest_lag_seconds",
    "Delay between the gateway forwarding an audio frame and STT reading it",
    buckets=[0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
)


def observe_ingest_lag(seconds: float) -> None:
    """M-03: one frame's ingest lag.

    Call site: `session_manager.py:_on_frame`, first line —
    ``observe_ingest_lag(max(0.0, time.time() - frame.ts))``. `AudioFrame.ts`
    already carries the gateway-forward epoch time (`schemas.py:70`); that
    field's docstring currently says "client-side timestamp", which is wrong
    (new defect, not this lane's file to fix — see the TASK-985 D7 dossier's
    new-defects table).
    """
    STREAMING_INGEST_LAG_SECONDS.observe(max(0.0, seconds))


# ---------------------------------------------------------------------------
# Model loading metrics
# ---------------------------------------------------------------------------

MODEL_LOAD_LATENCY = Histogram(
    "stt_model_load_latency_seconds",
    "Model loading latency in seconds",
    ["model", "engine"],
    buckets=[0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0],
)


@contextmanager
def track_model_load_latency(*, model: str, engine: str) -> Iterator[None]:
    """Time one model load onto `stt_model_load_latency_seconds` (M-19: wired, not dead).

    Wrap the `await loader.load(model_config)` call in `ModelCache._load_by_slug`
    (`apps/stt/src/stt/models/cache.py:467`) — this was the ONLY declared-but-dead
    metric M-19 found worth wiring rather than deleting: it is the ONLY latency
    signal for the M-17 cold-start story (session-create p95 vs warm p95 had no
    server-side latency breakdown before this, only the gateway's end-to-end
    `durationMs`).

    ``model``/``engine`` are bounded to resident `AiModel` slugs (low tens
    platform-wide) — the same bound `model_running_instances` already accepts,
    no new cardinality risk.
    """
    start = time.perf_counter()
    try:
        yield
    finally:
        MODEL_LOAD_LATENCY.labels(model=model, engine=engine).observe(time.perf_counter() - start)


# TASK-985 M-19 — MODEL_CACHE_HITS/MODEL_CACHE_MISSES were deleted here.
# Confirmed dead by grep: defined, never `.inc()`'d anywhere under
# `apps/stt/src`. They are also fully SUPERSEDED by the SHARED
# `model_cache_loads_total{cache}` / `model_cache_evictions_total{cache,reason}`
# / `model_cache_resident_models{cache}` contract below
# (`build_model_cache_metrics_sink()`, wired into every `ModelCache` at
# `models/cache.py:302`) — that sink is the FIXED cross-service contract the
# `infrastructure/grafana/dashboards/model-retention.json` dashboard reads.
# Do NOT re-add a hit/miss counter under a different name: it would be a
# second, disagreeing source of truth for the same fact. See
# docs/implementation/TASK-985-Realtime-Transcription-Review-And-Best-Practices/README.md
# M-19.

# TASK-985 M-19 — VAD_SEGMENTS_DETECTED/VAD_PROCESSING_LATENCY were deleted
# here. Confirmed dead by grep: defined, never `.inc()`/`.observe()`'d
# anywhere under `apps/stt/src`. VAD latency is ALREADY covered by the
# generic `model_inference_latency_seconds{service="stt",model="silero-vad-v5"}`
# via `track_model_inference("silero-vad-v5")` (`vad/silero_service.py:158`) —
# a second, VAD-specific histogram would duplicate that signal under a
# different name. `VAD_SEGMENTS_DETECTED` had no natural call site: the
# preprocessor's own onset/offset logic decides speech segments (the `reason`
# enum on `STREAMING_UTTERANCES_TOTAL` above), so a redundant "VAD segment"
# counter would double-count against it. Do NOT re-add either.

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


# TASK-985 M-19 — `stt_streaming_sessions_total{status}` FIX, not a new metric.
# `streaming_session_started` above is the ONLY call that has ever incremented
# `STREAMING_SESSIONS_TOTAL` — always with `status="started"` —
# `streaming_session_ended` only syncs the active gauge. So the SLO doc's
# `sum(rate(...{status=~"closed|recovered|reaped"}[5m])) /
#  sum(rate(...{status="started"}[5m]))`-shaped query divided a numerator
# series that was either absent or permanently zero. This is the missing
# `finished` half.
SESSION_FINISHED_STATUSES = frozenset({"closed", "recovered", "reaped", "failed"})


def streaming_session_finished(status: str) -> None:
    """Record one terminal streaming-session outcome.

    Call ONCE per terminal outcome, from `session_manager.py` (line numbers
    as of TASK-985 D7; re-check before wiring, this file moves fast):

    - ``"closed"`` — the normal path, beside the existing
      `record_streaming_teardown(..., status="closed", ...)` call in
      `_build_teardown_summary` (~:4220, called from `_finalize_session_locked`).
    - ``"recovered"`` — a session that was reconstructed after a crash
      restart, on ITS OWN eventual close. `_build_teardown_summary`'s
      "RECOVERED session" branch (~:4189) builds that session's usage
      SEGMENT, not a session-finish event — confirm with the session-lifecycle
      lane whether the recovered flag is available where `streaming_session_finished`
      is actually called (likely still `_build_teardown_summary`/
      `_finalize_session_locked`, with `status="recovered"` instead of
      `"closed"` when the session was never a live creation) before wiring.
    - ``"reaped"`` — `_reap_expired_sessions`' success branch (~:4746,
      `await self._finalize_session(session)` succeeds).
    - ``"failed"`` — that same function's `except Exception` branch (~:4768,
      "Failed to reap session gracefully; forcing removal"), and any
      `remove_session` call that runs without a prior `_finalize_session`.

    Raises ``ValueError`` outside this closed 4-value set — ``"started"`` is
    handled separately by `streaming_session_started` and is not a valid
    argument here.
    """
    if status not in SESSION_FINISHED_STATUSES:
        raise ValueError(
            f"Unknown terminal session status {status!r}; must be one of "
            f"{sorted(SESSION_FINISHED_STATUSES)}"
        )
    STREAMING_SESSIONS_TOTAL.labels(status=status).inc()


def streaming_inference_queue_dropped() -> None:
    """F-08: one utterance was dropped because the inference queue stayed full."""
    STREAMING_INFERENCE_QUEUE_DROPPED_TOTAL.inc()


def streaming_script_mismatch() -> None:
    """TASK-946: one final came back in a script its pinned language rules out."""
    STREAMING_SCRIPT_MISMATCH_TOTAL.inc()


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
