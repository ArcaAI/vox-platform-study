"""SessionManager — streaming session lifecycle orchestration.

Responsibilities:
* **Create** sessions — validate capacity, persist metadata, start consumers
* **Get / list** sessions — for health endpoints and diagnostics
* **Remove** sessions — clean up resources (consumers, capacity slot, memory)
* **Recovery on startup** — scan ``stt:session:*`` for ``status: active``,
  replay last ~2 s of audio to warm RNNoise / VAD state, resume consuming
* **Background reaper** — every N minutes, finalize sessions with no
  activity for the configured timeout
* **Worker heartbeat** — register ``stt:worker:{worker_id}`` with TTL,
  extend periodically so other workers can detect crashes
"""

from __future__ import annotations

import asyncio
import copy
import inspect
import json
import os
import time
import uuid
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import numpy as np
import structlog

from stt.core.api_client.gateway import APIGatewayClient
from stt.core.config.settings import get_settings
from stt.core.exceptions import ModelNotCacheServedError, SessionManagerDrainingError
from stt.core.metering import normalize_device
from stt.core.metrics import (
    streaming_inference_queue_dropped,
    streaming_session_ended,
    streaming_session_started,
)
from stt.models.whisper_kwargs import build_whisper_generate_kwargs
from stt.pipeline.dto import AiModelConfig, AiModelFormat, DualCaptureConfig, EndpointConfig
from stt.pipeline.spec import ResolvedSpecBundle, bundle_from_resolved
from stt.storage.blob_service import BlobService
from stt.streaming.capacity_guard import CapacityGuard
from stt.streaming.commit_policy import LocalAgreementPolicy, normalize_for_comparison
from stt.streaming.deepfilternet_denoiser import DeepFilterNet3StreamingDenoiser
from stt.streaming.denoiser import StreamingDenoiser
from stt.streaming.engine_switch import EngineSwitchController
from stt.streaming.execution_profile import ExecutionProfile
from stt.streaming.inference import StreamingInferenceWorker
from stt.streaming.preprocessor import AudioUtterance, StreamingPreprocessor
from stt.streaming.redis_streams import (
    ControlListener,
    IngestionConsumer,
    ResultPublisher,
    audio_stream_key,
    control_stream_key,
    session_meta_key,
    worker_key,
)
from stt.streaming.schemas import (
    AudioFrame,
    ControlAction,
    SessionControl,
    SessionMetadata,
    SessionStatus,
)
from stt.streaming.semantic_endpointer import SemanticEndpointer
from stt.streaming.session import StreamSession
from stt.streaming.usage_segments import (
    EngineUsageAccumulator,
    EngineUsageCounters,
    UsageSegment,
    segment_device,
)

logger = structlog.get_logger(__name__)

# F-08 — steady-state per-frame enqueue bound (``_make_frame_handler``'s
# ``_on_frame``). Deliberately small: this runs on the single ingestion
# consumer's dispatch path, so a long wait here backs up XACK'ing of the
# Redis ``stt:audio`` stream, which is the actual failure this bound exists to
# prevent. Mirrors the existing ``timeout=1.0`` used for the stop-path sentinel
# enqueue (``_stop_inference_loop``) — short enough that a full queue degrades
# captions (drop + log + metric) rather than stalling raw-audio ingestion.
_STEADY_STATE_ENQUEUE_TIMEOUT_S = 1.0

# Truncation for the partial/final handover mismatch log. A clinical
# transcript is PHI, so the record says enough to locate the divergence and
# no more; the final itself is persisted through the normal result path.
_HANDOVER_LOG_CHARS = 200

# TASK-985 M-23 — how long an UNCLAIMED teardown summary is kept for the
# gateway's DELETE, and how many may be held at once. Both are bootstrap
# defaults of an in-memory map on a PHI service, so the cap is not optional:
# the TTL bounds how stale a claim may be, the entry cap bounds the damage if
# no DELETE ever comes. An expired entry is not dropped — it is pushed back to
# the gateway (see `_sweep_teardown_summaries`), because a summary nobody came
# for is a ledger row nobody wrote.
_TEARDOWN_STASH_TTL_S = 120.0
_TEARDOWN_STASH_MAX_ENTRIES = 256

# TASK-985 M-04 — headroom added to the inference-drain bound to get the
# tail-wait bound (``_tail_wait_timeout_s``). The tail owner's own work is
# flush + drain, and the drain is the bounded half; a waiter must therefore
# outlast it by a margin or it times out on every session that merely used its
# full drain budget. Five seconds is that margin, not a guess at how long a
# decode takes.
_TAIL_WAIT_GRACE_S = 5.0

StreamingAsrCallable = Callable[[np.ndarray, int], Awaitable[dict[str, Any]]]

# Cloud ASR engines whose loaders accept a per-tenant ``provider_overrides``
# dict (BYOK). For these formats the model load BYPASSES the shared
# by-slug model cache when a per-session override is present — a decrypted
# tenant key must never be cached under a slug and served to another tenant.
_CLOUD_ASR_OVERRIDE_FORMATS = frozenset(
    {
        AiModelFormat.AZURE_SPEECH,
        AiModelFormat.AZURE_FOUNDRY,
        AiModelFormat.SARVAM,
        AiModelFormat.OPENAI,
    }
)


# Shared Redis Hash holding transcripts whose durable persist
# exhausted its inline retries on a transient error. The reaper loop (any
# worker) re-drives entries with an idempotency key; because it lives on shared
# Redis, a worker restart does not lose the transcript.
TRANSCRIPT_OUTBOX_KEY = "stt:transcript_outbox"

# Retryable 4xx back-off signals — treated as TRANSIENT, not permanent.
_RETRYABLE_4XX = frozenset({408, 425, 429})

# Soft lease (seconds) a worker stamps on an outbox entry while it re-drives it,
# so concurrent workers skip a fresh entry (fewer duplicate POSTs) yet a crashed
# worker's entry becomes re-claimable once the lease expires. Longer than the
# gateway POST timeout, shorter than the reaper scan interval.
OUTBOX_LEASE_TTL_S = 90.0


@dataclass
class _SessionRuntime:
    """Per-session runtime components built by ``_assemble_session_runtime``.

    One assembly shared by session creation and crash recovery
    (the duplicated recovery wiring had already drifted from creation).
    """

    publisher: ResultPublisher
    preprocessor: StreamingPreprocessor
    inference_worker: StreamingInferenceWorker
    vad_service: Any
    asr_pipeline: Any
    denoiser: Any
    vad_enabled: bool
    target_sr: int
    effective_diarization: bool


@dataclass
class _StashedTeardown:
    """A teardown summary waiting for the gateway's DELETE (TASK-985 M-23).

    ``pushed_back`` records that this summary has ALREADY been POSTed to the
    gateway by its finalizer (the idle reaper does that, because the reaper
    fires precisely when the gateway is gone and a pod roll inside the stash TTL
    would otherwise lose the row). The entry is still kept so a late DELETE can
    claim it and let the gateway make its own ``interrupted`` call — but the
    expiry sweep must not POST it a second time.
    """

    summary: dict[str, Any]
    expires_at: float
    pushed_back: bool = False


def _spec_bundles_of(manager: Any) -> dict[str, ResolvedSpecBundle]:
    """The per-session spec bundles of ``manager`` (TASK-861), read defensively.

    getattr guard, same posture as ``_draining``: pre-existing unit tests build
    ``MagicMock(spec=SessionManager)`` fixtures that predate ``_session_specs``
    and bind real methods onto them — a method helper would itself be mocked, so
    this is a module function. Real instances always have the dict via
    ``__init__``; anything else reads as "no spec-driven sessions".
    """
    bundles = getattr(manager, "_session_specs", None)
    return bundles if isinstance(bundles, dict) else {}


def _spec_asr_slug(pipeline_config: Any) -> str | None:
    """The registry SLUG of the session's ASR row, or ``None``.

    TASK-934 — the identity to log the decode geometry AGAINST: the windows are
    properties of that row, so a log line naming only the session cannot be
    checked against the row an admin edited. A module function for the same
    reason as ``_spec_bundles_of``: ``MagicMock(spec=SessionManager)`` fixtures
    would mock a method away.
    """
    ref = getattr(getattr(pipeline_config, "models", None), "asr", None)
    slug = getattr(ref, "slug", None) if ref is not None else None
    return str(slug) if slug else None


def _spec_model_config_of(
    manager: Any, session_id: str | None, slug: str | None
) -> AiModelConfig | None:
    """The pre-resolved ``AiModelConfig`` for ``slug`` on a spec-driven session, else ``None``."""
    if not session_id or not slug:
        return None
    bundle = _spec_bundles_of(manager).get(session_id)
    return bundle.model_configs.get(slug) if bundle is not None else None


def _declared_compute_type(loaded_model: Any) -> str | None:
    """The assigned model row's own compute type, as recorded by its loader
    (``LoadedModel.extra["compute_type"]``, TASK-934) — fed to the engine binding
    resolver ahead of the execution profile's precision vocabulary so the
    ``ASR engine binding resolved`` log names the quantisation that actually
    loaded (a q8_0 GGUF row used to log ``q4_k``)."""
    extra = getattr(loaded_model, "extra", None)
    value = extra.get("compute_type") if isinstance(extra, dict) else None
    return value if isinstance(value, str) and value else None


def _language_mode_for_declared_language(language: str | None) -> str | None:
    """The catalog mode a bare ``language`` declaration names, if any.

    TASK-938 — ``language`` and ``language_mode`` are two ways of saying the same
    thing and only one of them used to survive. ``create_session`` backfilled
    ``language_mode`` from the AGENT's own spec whenever the caller omitted it, so
    ``_session_language_modes`` was never empty and ``_load_asr_pipeline``'s mode
    resolution overwrote the declared language on every agent-path session — an
    English declaration decoded unpinned, because the agent's mode is the
    ``ml-en`` pair and a pair deliberately pins nothing. The documented
    precedence ("``languageMode`` takes precedence over ``language``") is about
    what the CALLER declared; a mode the spec supplied is not a declaration.

    Every id in :data:`LANGUAGE_MODE_CATALOG` is an ISO 639-1 code or ``auto`` —
    exactly the vocabulary ``language`` is documented with — so a declaration that
    names one is PROMOTED to it rather than carried as a second, weaker channel.
    Promoting keeps one concept downstream: it persists on ``SessionMetadata`` and
    survives recovery (TASK-891), it is checked against the engine's capability
    matrix (422 when no configured engine serves it), and it picks up the mode's
    own priming prompt. A language OUTSIDE the catalog cannot become a mode; it
    keeps the raw ``inference.language`` override instead, which now survives
    because the spec backfill no longer runs over a declaration.
    """
    if not language:
        return None
    from stt.pipeline.language_modes import LANGUAGE_MODES_BY_ID

    normalized = language.strip().lower()
    return normalized if normalized in LANGUAGE_MODES_BY_ID else None


class SessionManager:
    """Manages the full lifecycle of streaming sessions.

    Parameters
    ----------
    redis:
        ``redis.asyncio.Redis`` client instance.
    profile:
        The detected ``ExecutionProfile`` (provides ``max_concurrent_streams``).
    worker_id:
        Unique identifier for this worker process (auto-generated if not
        provided).
    """

    def __init__(
        self,
        redis: Any,
        profile: ExecutionProfile,
        worker_id: str | None = None,
    ) -> None:
        self._redis = redis
        self._profile = profile
        self._worker_id = worker_id or f"worker-{uuid.uuid4().hex[:8]}-{os.getpid()}"
        self._capacity_guard = CapacityGuard(profile.max_concurrent_streams)
        self._sessions: dict[str, StreamSession] = {}
        # session_id → model slugs pinned for the active pipeline.
        self._session_pinned_models: dict[str, list[str]] = {}
        self._consumers: dict[str, IngestionConsumer] = {}
        self._control_listeners: dict[str, ControlListener] = {}
        # Per-session engine-switch state. The overrides dict and
        # fallback pointer are held IN MEMORY ONLY (never persisted to Redis /
        # session metadata, never logged); they are needed to lazily build the
        # fallback ASR callable on switch.
        self._switch_controllers: dict[str, EngineSwitchController] = {}
        self._provider_overrides: dict[str, dict[str, Any]] = {}
        self._fallback_pipeline_ids: dict[str, str] = {}
        # TASK-887 — the end-user's ENROLLED voice profiles, resolved by the gateway for
        # the agent's embedding model and pushed on the create body. Biometric PHI: held
        # IN MEMORY ONLY, exactly like `_provider_overrides` — never persisted to Redis
        # session metadata, never logged. A recovered session therefore loses its labels
        # and diarizes generically rather than re-reading a vector from anywhere.
        self._session_voice_profiles: dict[str, list[dict[str, Any]]] = {}
        # TASK-861 — per-session gateway-resolved spec bundle (the engine chains
        # + every model config, pre-mapped). When present for a session, NO
        # pipeline/model row is read from Postgres for it.
        self._session_specs: dict[str, ResolvedSpecBundle] = {}
        # Per-session end-user language mode id, resolved against the
        # session's ASR engine at load time.
        self._session_language_modes: dict[str, str] = {}
        # Per-session dual-/multi-mic source count (absent ⇒ 1).
        self._session_channel_counts: dict[str, int] = {}
        # The ASR AiModelFormat actually loaded for this session,
        # stamped in `_load_asr_pipeline` (the single choke point for BOTH
        # session-create and every engine switch, so this can never go stale).
        # Read at teardown to resolve the usage-ledger (engine, deployment) pair
        # via `resolve_usage_attribution` — the same function batch completion
        # uses, so the two paths can never drift.
        self._session_asr_formats: dict[str, AiModelFormat] = {}
        # TASK-958 — the connection the ACTIVE ASR model authenticates as, stamped
        # beside the format at the same choke point. `engine` names a vendor and a
        # tenant may hold several accounts of one, so the format alone can no longer
        # say which credential a session spent; `(connection_key, connection_id)` can.
        # Like `_session_asr_formats`, this is a SINGLE slot holding whichever engine
        # loaded last, so it answers only "what was live at teardown" — the teardown
        # summary's own scalar. Per-SPAN billing takes its own copy at each span
        # boundary (TASK-958 G3, `_start_usage_segments`/`_advance_usage_segments`);
        # reading this slot for every span billed a platform-funded primary leg to
        # whichever sibling a failover ended on, funding included.
        self._session_connections: dict[str, tuple[str | None, str | None]] = {}
        # TASK-874 — per-session ENGINE-TIME accounting. `_session_asr_formats`
        # above is a single slot holding whichever engine loaded LAST, so on its
        # own it bills a switched session entirely to the engine that finished.
        # This records a span per live engine instead, and the teardown summary
        # carries them as `segments` — one ledger row each, funding derived from
        # the credential row that actually served that span.
        self._session_usage_segments: dict[str, EngineUsageAccumulator] = {}
        self._publishers: dict[str, ResultPublisher] = {}
        self._preprocessors: dict[str, StreamingPreprocessor] = {}
        self._inference_workers: dict[str, StreamingInferenceWorker] = {}
        self._inference_queues: dict[str, asyncio.Queue[AudioUtterance | None]] = {}
        self._inference_tasks: dict[str, asyncio.Task[None]] = {}
        self._partial_tasks: dict[str, asyncio.Task[None]] = {}
        self._final_published_gates: dict[str, asyncio.Event] = {}
        # Per-session LocalAgreement-2 commit policies
        # (only sessions whose pipeline enables streaming.commit_policy).
        self._commit_policies: dict[str, LocalAgreementPolicy] = {}
        # Per-pipeline embedding services, cached per model id
        # (the seeded default pipeline declares one, so every session would
        # otherwise reload the model).
        self._pipeline_embedding_services: dict[str, Any] = {}
        self._pipeline_embedding_lock = asyncio.Lock()
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._reaper_task: asyncio.Task[None] | None = None
        self._snapshot_task: asyncio.Task[None] | None = None
        self._blob_service: BlobService | None = None
        self._last_snapshot_at: dict[str, float] = {}
        self._chunk_indices: dict[str, int] = {}
        self._processed_chunk_indices: dict[str, int] = {}
        self._chunk_offsets: dict[str, int] = {}
        self._processed_chunk_offsets: dict[str, int] = {}
        # Per-session resolved dual-capture flags (raw/processed registration).
        self._dual_capture: dict[str, DualCaptureConfig] = {}
        # Monotonic timestamp of the last XTRIM per session.
        self._last_audio_trim_at: dict[str, float] = {}
        # Per-session lock serializing the four finalize
        # entrypoints so a second entrant is a no-op (no duplicate Media rows).
        self._finalize_locks: dict[str, asyncio.Lock] = {}
        # F-32 / TASK-985 M-04 — the closing tail's COMPLETION latch, one
        # `asyncio.Event` per session.
        #
        # The flush/drain pair runs BEFORE (and outside) the finalize lock at
        # every trigger site, so without a latch two near-simultaneous triggers
        # both flush the preprocessor tail and both drain the queue — publishing
        # the closing utterance twice (F-32). A `set[str]` closed that, but it
        # answers only "is someone else doing the tail?" while all four call
        # sites read the answer as "is the tail DONE?" — which is how the
        # closing utterance came to be CANCELLED mid-decode by a later
        # finalizer's `remove_session` (TASK-985 M-04). Mutual exclusion without
        # a happens-before edge is exactly half of what those call sites need.
        #
        # An Event supplies both: membership is still the test-and-set (see
        # ``_begin_tail_flush``), and the later trigger now has something to
        # AWAIT. Dropped in ``remove_session`` alongside the finalize lock.
        self._tail_flush_done: dict[str, asyncio.Event] = {}
        # TASK-985 M-23 — teardown summaries built by a NON-HTTP finalizer,
        # held for the gateway's DELETE to claim. Deliberately NOT dropped by
        # ``remove_session``: the session is gone precisely when this matters.
        self._pending_teardown_summaries: dict[str, _StashedTeardown] = {}
        # Strong references to the fire-and-forget push-backs fired by stash
        # eviction — without them the event loop may GC a task mid-flight.
        self._stash_pushback_tasks: set[asyncio.Task[None]] = set()
        self._running = False
        # PLANNED scale-down flag — distinct from the startup
        # crash-recovery replay path above. Set by begin_drain(); rejects new
        # sessions in create_session() while leaving self._sessions
        # completely untouched. See
        self._draining = False

        # Cache settings values at init time to avoid calling get_settings()
        # in methods that may run during unit tests with incomplete env.
        try:
            _settings = get_settings()
            self._reaper_interval_s = _settings.streaming_reaper_interval_s
            self._session_timeout_s = _settings.streaming_session_timeout_s
            # The reaper reaps on audio-idle (default 300s), not the 60s
            # session timeout, so a normal clinical speech pause never finalizes
            # a live session. Wires the previously-dead knob.
            self._audio_idle_timeout_s = _settings.streaming_audio_idle_timeout_s
            self._heartbeat_interval_s = _settings.streaming_worker_heartbeat_s
            self._heartbeat_ttl_s = _settings.streaming_worker_heartbeat_ttl_s
            self._inference_queue_maxsize = int(_settings.streaming_inference_queue_maxsize)
            self._inference_drain_timeout_s = float(_settings.streaming_inference_drain_timeout_s)
            self._inference_stop_timeout_s = float(_settings.streaming_inference_stop_timeout_s)
            # TASK-985 M-04 — how long a LATER finalizer waits for the tail
            # flush + drain claimed by an earlier one. DERIVED from the drain
            # bound rather than declared beside it: the thing being waited for
            # IS that drain, so a control-plane write that raises the drain
            # ceiling must raise this with it or the wait starts timing out on
            # exactly the slow sessions it exists for. An explicit
            # `streaming_tail_wait_timeout_s` (not yet a settings field — see
            # the L-CONFIG request in the ticket) overrides the derivation.
            self._tail_wait_timeout_s = float(
                getattr(_settings, "streaming_tail_wait_timeout_s", None)
                or (self._inference_drain_timeout_s + _TAIL_WAIT_GRACE_S)
            )
            self._transcript_persist_max_attempts = max(
                1, int(_settings.streaming_transcript_persist_max_attempts)
            )
            self._transcript_persist_backoff_s = float(
                _settings.streaming_transcript_persist_backoff_s
            )
            self._transcript_outbox_max_attempts = max(
                1, int(_settings.streaming_transcript_outbox_max_attempts)
            )
            self._snapshot_interval_s = _settings.streaming_snapshot_interval_s
            # TASK-880 — the partial decode WINDOW was cached here from
            # `stt.streaming.partialWindowS`, one number per process for every engine.
            # It is the ASR row's force-emit window, so it now arrives per session on
            # `ResolvedAsrSpec.models.asr.metadata.partialWindowSec`.
            # TASK-877 — the partial-emit cadence and the whole semantic-endpoint
            # family used to be cached here from `stt.streaming.partialIntervalS`
            # and `stt.semanticEndpoint.*`. Both are per-session AGENT concepts, so
            # all seven platform keys are deleted and the values now arrive on the
            # session's `ResolvedAsrSpec`.
            self._audio_trim_interval_s = float(
                getattr(_settings, "streaming_audio_trim_interval_s", 30.0)
            )
        except Exception:
            self._reaper_interval_s = 300
            self._session_timeout_s = 60
            self._audio_idle_timeout_s = 300
            self._heartbeat_interval_s = 10
            self._heartbeat_ttl_s = 30
            self._inference_queue_maxsize = 64
            self._inference_drain_timeout_s = 60.0
            self._inference_stop_timeout_s = 30.0
            self._tail_wait_timeout_s = 60.0 + _TAIL_WAIT_GRACE_S
            self._transcript_persist_max_attempts = 3
            self._transcript_persist_backoff_s = 0.5
            self._transcript_outbox_max_attempts = 10
            self._snapshot_interval_s = 30.0
            self._audio_trim_interval_s = 30.0
            # Semantic endpointing defaults (OFF).

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def worker_id(self) -> str:
        return self._worker_id

    @property
    def is_draining(self) -> bool:
        """True once begin_drain() has been called on this process.

        Checked by /health/ready (the actual "stop routing new sessions
        here" mechanism, via k8s Service Endpoints removal) and by
        create_session() itself as a defense-in-depth guard for the race
        window between a failed readiness probe and the pod's removal.
        """
        return self._draining

    def begin_drain(self) -> None:
        """Mark this worker draining: reject NEW sessions, let in-flight ones
        finish naturally. Idempotent. Distinct from the startup crash-recovery
        replay path — see for why the two never conflate.
        """
        if not self._draining:
            logger.info(
                "SessionManager draining started",
                worker_id=self._worker_id,
                active_sessions=len(self._sessions),
            )
        self._draining = True

    async def wait_for_drain(self, timeout_s: float, poll_interval_s: float = 1.0) -> bool:
        """Block until every in-flight session ends or timeout_s elapses.

        Called by a preStop hook (deployment repo) AFTER begin_drain(), so a
        planned pod removal waits for sessions to finish naturally instead of
        severing them — bounded so a stuck session can never block a rollout
        forever. Returns True once drained, False if timeout_s elapsed with
        sessions still active (never evicts them either way).
        """
        deadline = time.monotonic() + timeout_s
        while self._sessions:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                logger.warning(
                    "Drain timeout with sessions still active",
                    worker_id=self._worker_id,
                    remaining_sessions=len(self._sessions),
                )
                return False
            await asyncio.sleep(min(poll_interval_s, remaining))
        return True

    @property
    def capacity_guard(self) -> CapacityGuard:
        return self._capacity_guard

    @property
    def active_session_count(self) -> int:
        return len(self._sessions)

    @property
    def profile(self) -> ExecutionProfile:
        return self._profile

    # ------------------------------------------------------------------
    # Preprocessor wiring
    # ------------------------------------------------------------------

    def _build_preprocessor_vad_kwargs(self, pipeline_config: Any) -> dict[str, Any]:
        """Build StreamingPreprocessor kwargs from pipeline + profile + settings.

        Shared by session creation and crash recovery:

        - Pipeline YAML wins when its VAD config is present (per-pipeline
          override, unchanged behavior).
        - Without a pipeline VAD config, ``min_silence_duration_ms`` follows
          the hardware profile (500 ms on every profile) instead of the
          preprocessor's legacy hardcoded 700 ms (shaves ~200 ms off
          every final's latency floor).
        - TASK-877 — the partial-emit cadence and the utterance cap come from the
          SESSION's ``ResolvedAsrSpec`` (``streaming.{partialIntervalMs,maxUtteranceSec}``).
          The platform key ``stt.streaming.partialIntervalS`` is deleted: it
          duplicated an agent concept, and a per-session cadence cannot be a
          per-process setting. When the agent says nothing the kwarg is OMITTED so
          the preprocessor's own default stands — never restated here.
        - TASK-880 — the partial decode WINDOW follows the same rule, sourced from the
          ASR MODEL row (``models.asr.metadata.partialWindowSec`` →
          ``StreamingConfig.partial_window_s``) rather than the deleted platform key
          ``stt.streaming.partialWindowS``. It is a property of the model, not of
          the box.
        - TASK-934 — and it is INDEPENDENT of the model's ``maxDecodeWindowSec``.
          This paragraph used to say the two "MUST match so the last partial and the
          final decode the SAME audio"; measured on the served ml-en fine-tune they
          want opposite things. A partial wants a LONG window — the garbage rate of a
          partial decode is 31 % at 6 s, 10 % at 10 s and 0 % at 15 s, because a short
          window gives the language model too little to settle on. A final wants SHORT
          spans — Malayalam CER 0.381 at a 7 s decode window against 0.645 at 30 s.
          So the last partial and the final deliberately decode different audio, and
          the runtime asks for each window per call (``StreamingInferenceWorker.
          _decode_window_kwargs``) instead of forcing one number on both.
        """
        kwargs: dict[str, Any] = {}
        spec_streaming = getattr(pipeline_config, "streaming", None) if pipeline_config else None
        partial_window_s = getattr(spec_streaming, "partial_window_s", None)
        if isinstance(partial_window_s, (int, float)) and not isinstance(partial_window_s, bool):
            kwargs["partial_window_s"] = float(partial_window_s)
        partial_interval_s = getattr(spec_streaming, "partial_interval_s", None)
        if isinstance(partial_interval_s, (int, float)) and not isinstance(
            partial_interval_s, bool
        ):
            kwargs["partial_interval_s"] = float(partial_interval_s)
        if pipeline_config and pipeline_config.preprocessing.vad.enabled:
            vad_cfg = pipeline_config.preprocessing.vad
            kwargs["threshold"] = vad_cfg.threshold
            kwargs["min_speech_duration_ms"] = vad_cfg.min_speech_duration_ms
            kwargs["min_silence_duration_ms"] = vad_cfg.min_silence_duration_ms
            if hasattr(vad_cfg, "pre_speech_context_ms"):
                kwargs["pre_speech_context_ms"] = vad_cfg.pre_speech_context_ms
            if hasattr(vad_cfg, "force_emit_after_ms"):
                kwargs["max_utterance_duration_ms"] = vad_cfg.force_emit_after_ms
            if hasattr(vad_cfg, "force_emit_lookback_ms"):
                kwargs["force_emit_lookback_ms"] = vad_cfg.force_emit_lookback_ms
            if hasattr(vad_cfg, "force_emit_overlap_ms"):
                kwargs["force_emit_overlap_ms"] = vad_cfg.force_emit_overlap_ms
        else:
            kwargs["min_silence_duration_ms"] = self._profile.vad_silence_threshold_ms
        # The agent's utterance cap outranks the front-end's force-emit window: it
        # is the session-level bound the agent asked for, applied last so it wins.
        max_utterance_sec = getattr(spec_streaming, "max_utterance_sec", None)
        if isinstance(max_utterance_sec, (int, float)) and not isinstance(max_utterance_sec, bool):
            kwargs["max_utterance_duration_ms"] = int(max_utterance_sec * 1000)
        # Build + attach the semantic endpointer (None when
        # disabled, so the preprocessor keeps the exact fixed silence offset).
        # Shared with crash recovery, so recovered sessions get one too.
        kwargs["endpointer"] = self._make_endpointer(pipeline_config)
        return kwargs

    async def _assemble_session_runtime(
        self,
        *,
        session_id: str,
        tenant_id: str | None,
        consultation_id: str | None,
        user_id: str | None,
        sample_rate: int,
        pipeline_config: Any,
        build_speaker_identifier: bool,
        provider_overrides: dict[str, Any] | None = None,
        active_pipeline_id: str | None = None,
    ) -> _SessionRuntime:
        """Build the per-session runtime components.

        ONE assembly shared by ``create_session`` and ``_recover_sessions`` —
        the recovery path previously kept a hand-copied second wiring that
        drifted (it dropped ``max_segment_text_chars``, both hallucination
        knobs, and the ``enable_prev_text_context`` zeroing, so recovered
        sessions silently ran with code defaults).

        ``build_speaker_identifier=False`` (recovery) skips the embedding
        SpeakerIdentifier: its in-memory tracker state is lost on crash, so a
        recovered session restarts without it.

        ``active_pipeline_id`` is the pipeline this runtime is being
        assembled FOR — i.e. the EFFECTIVE engine, which is the fallback on the
        user-selected start-on-fallback and create-time-load-failure paths, not
        the requested primary. The inference worker stamps it onto every result
        it produces.
        """
        publisher = ResultPublisher(redis=self._redis, session_id=session_id)

        # VAD + preprocessor (YAML wins, profile silence default)
        vad_service = await self._load_vad_service(pipeline_config, session_id)
        vad_enabled = bool(pipeline_config and pipeline_config.preprocessing.vad.enabled)
        vad_kwargs = self._build_preprocessor_vad_kwargs(pipeline_config)

        target_sr = (
            pipeline_config.preprocessing.target_sample_rate
            if pipeline_config and pipeline_config.preprocessing.target_sample_rate
            else sample_rate
        )

        denoiser = None
        # TASK-977 — denoise is the AGENT's to enable, never the machine's. No pipeline
        # config is no agent opinion, which resolves OFF: the hardware profile used to
        # switch it on here (`ExecutionProfile.denoise_enabled_default`), and is gone.
        denoise_enabled = bool(pipeline_config and pipeline_config.preprocessing.denoise.enabled)
        if denoise_enabled:
            strength = pipeline_config.preprocessing.denoise.strength
            denoise_engine_name = getattr(
                pipeline_config.preprocessing.denoise, "engine", "rnnoise"
            )
            # Engine selector (rnnoise = legacy default). RNNoise degrades to
            # no denoise when its package is absent (returns False);
            # DeepFilterNet3 FAILS CLOSED — `initialize()` raises
            # `ModelLoadError` (TASK-860 R-5), which propagates and fails the
            # session: a selected denoiser that silently passes audio through
            # is a wrong answer, not a degraded one.
            denoiser = (
                DeepFilterNet3StreamingDenoiser(input_sr=target_sr, strength=strength)
                if denoise_engine_name == "deepfilternet3"
                else StreamingDenoiser(input_sr=target_sr, strength=strength)
            )
            if not denoiser.initialize():
                denoiser = None  # rnnoise unavailable, degrade gracefully

        normalize = pipeline_config.preprocessing.normalize if pipeline_config else False

        # TASK-977 (D-5) — resampling stays ON by default; the flag is forwarded so
        # a declared `resample: false` is answered instead of silently dropped. The
        # preprocessor refuses it on a genuine rate mismatch (VAD/ASR need the
        # target rate) and honours it only where it is a no-op.
        resample_enabled = (
            getattr(pipeline_config.preprocessing, "resample_enabled", True)
            if pipeline_config
            else True
        )

        denoise_scope = (
            getattr(pipeline_config.preprocessing.denoise, "scope", "vad_only")
            if pipeline_config
            else "vad_only"
        )

        preprocessor = StreamingPreprocessor(
            session_id=session_id,
            sample_rate=sample_rate,
            vad_service=vad_service,
            target_sample_rate=target_sr,
            normalize=normalize,
            resample_enabled=resample_enabled,
            denoiser=denoiser,
            denoise_scope=denoise_scope,
            **vad_kwargs,
        )

        # ASR + diarization
        asr_pipeline, initial_prompt = await self._load_asr_pipeline(
            pipeline_config,
            session_id,
            tenant_id=tenant_id,
            provider_overrides=provider_overrides,
        )

        diarization_config = pipeline_config.diarization if pipeline_config else None
        effective_diarization = (
            bool(getattr(diarization_config, "enabled", False)) if diarization_config else False
        )

        # Resolve the per-pipeline embedding service
        # ONCE for the whole session (worker utterance-extraction AND the
        # speaker-identifier below); cached per model id on the manager so the
        # seeded default (ECAPA on every session) doesn't reload the model.
        pipeline_embedding_service = None
        if effective_diarization:
            emb_model_id = self._spec_embedding_model_id(session_id, pipeline_config)
            if emb_model_id:
                try:
                    pipeline_embedding_service = await self._get_pipeline_embedding_service(
                        emb_model_id
                    )
                except Exception:
                    logger.warning(
                        "Failed to load pipeline embedding model %s for session %s",
                        emb_model_id,
                        session_id,
                        exc_info=True,
                    )

        speaker_identifier = None
        if (
            build_speaker_identifier
            and effective_diarization
            and diarization_config
            # TASK-887 — no embedding service, no embedding diarization. The platform
            # singleton that used to stand in here is gone: it embedded into a space no
            # agent had chosen, so its matches were meaningless and its enrolments landed
            # in a space nothing would ever compare against.
            and pipeline_embedding_service is not None
        ):
            from stt.diarization.speaker_identifier import SpeakerIdentifier
            from stt.diarization.speaker_tracker import SpeakerTracker

            speaker_tracker = SpeakerTracker(
                max_speakers=diarization_config.max_speakers,
                max_embeddings_per_speaker=diarization_config.max_embeddings_per_speaker,
            )

            seg_service = None
            if diarization_config.enable_segmentation_refinement:
                try:
                    # pipeline_config here is a
                    # PipelineSpec (already `.spec`); the previous
                    # `pipeline_config.spec.models.…` raised AttributeError —
                    # swallowed here, so per-pipeline segmentation models
                    # never loaded in streaming.
                    seg_model_id = None
                    if pipeline_config and pipeline_config.models.segmentation:
                        seg_ref = pipeline_config.models.segmentation
                        if seg_ref.is_inline and seg_ref.inline:
                            seg_model_id = seg_ref.inline.hf_model_id
                    if seg_model_id:
                        from stt.diarization.segmentation_service import SegmentationService

                        seg_service = SegmentationService(hf_model_id=seg_model_id)
                        await seg_service.initialize()
                except Exception:
                    logger.warning(
                        "Failed to load segmentation model for session %s",
                        session_id,
                        exc_info=True,
                    )

            speaker_identifier = SpeakerIdentifier(
                tracker=speaker_tracker,
                embedding_service=pipeline_embedding_service,
                segmentation_service=seg_service,
                config=diarization_config,
            )

            # TASK-887 — seed the end-user's ENROLLED profiles for THIS agent's embedding
            # model. Pure and local: the gateway resolved and pushed them, so no row is
            # read here and a profile from another model is ignored rather than compared.
            self._seed_voice_profiles(
                speaker_tracker,
                session_id,
                self._spec_embedding_slug(pipeline_config),
            )

        # Inference worker (per-utterance ASR)
        postprocessing_config = pipeline_config.postprocessing if pipeline_config else None

        inference_cfg = pipeline_config.inference if pipeline_config else None
        prev_text_context_words = getattr(inference_cfg, "prev_text_context_words", None)
        if inference_cfg and not getattr(inference_cfg, "enable_prev_text_context", True):
            prev_text_context_words = 0
        max_words_per_second = getattr(inference_cfg, "max_words_per_second", None)
        max_segment_text_chars = getattr(inference_cfg, "max_segment_text_chars", None)
        hallucination_rms_threshold = getattr(inference_cfg, "hallucination_rms_threshold", None)
        hallucination_short_word_count = getattr(
            inference_cfg, "hallucination_short_word_count", None
        )
        # TASK-934 — the model row's own decode window, handed to the worker so
        # it can ask for it per CALL (finals split at it, partials decode in one
        # span). Previously it only reached the engine adapter's constructor,
        # which is what tied a window change to the adapter's lifetime (G-6).
        max_decode_window_sec = getattr(inference_cfg, "max_decode_window_sec", None)

        # Opt-in English gloss (None unless enabled)
        gloss_pipeline = await self._load_gloss_pipeline(pipeline_config, session_id)

        inference_worker = StreamingInferenceWorker(
            result_publisher=publisher,
            asr_pipeline=asr_pipeline,
            tenant_id=tenant_id,
            consultation_id=consultation_id,
            diarization_config=diarization_config,
            postprocessing_config=postprocessing_config,
            initial_prompt=initial_prompt,
            speaker_identifier=speaker_identifier,
            prev_text_context_words=prev_text_context_words,
            max_words_per_second=max_words_per_second,
            max_segment_text_chars=max_segment_text_chars,
            hallucination_rms_threshold=hallucination_rms_threshold,
            hallucination_short_word_count=hallucination_short_word_count,
            gloss_callable=gloss_pipeline,
            embedding_service=pipeline_embedding_service,
            active_pipeline_id=active_pipeline_id,
            max_decode_window_sec=max_decode_window_sec,
            # TASK-946 — the session's PINNED language, so the worker can tell a decode
            # that contradicts its own pin (a `language=en` session answering in
            # Malayalam script) from one that is simply in another language. `None` for
            # auto-detect and for an unpinned code-switch pair, which is what makes the
            # guard inert on exactly the sessions that declared no expectation.
            language=getattr(inference_cfg, "language", None),
        )

        # TASK-934 — the two windows, once per session, at INFO. The 2026-09-09
        # experiment could not tell whether a model-row edit had reached the
        # runtime at all; this is that answer, in the log, beside the row that
        # was supposed to supply it.
        logger.info(
            "stt.streaming.windows",
            session_id=session_id,
            model_slug=_spec_asr_slug(pipeline_config),
            partial_window_s=preprocessor.partial_window_s,
            max_decode_window_sec=max_decode_window_sec,
        )

        return _SessionRuntime(
            publisher=publisher,
            preprocessor=preprocessor,
            inference_worker=inference_worker,
            vad_service=vad_service,
            asr_pipeline=asr_pipeline,
            denoiser=denoiser,
            vad_enabled=vad_enabled,
            target_sr=target_sr,
            effective_diarization=effective_diarization,
        )

    async def _get_pipeline_embedding_service(self, hf_model_id: str) -> Any:
        """Resolve (and cache) a per-pipeline speaker-embedding service.

        One initialized service per model id for the
        manager's lifetime; single-flight via lock so concurrent session
        creation doesn't double-load the model.
        """
        cached = self._pipeline_embedding_services.get(hf_model_id)
        if cached is not None:
            return cached
        async with self._pipeline_embedding_lock:
            cached = self._pipeline_embedding_services.get(hf_model_id)
            if cached is not None:
                return cached
            from stt.diarization.embedding_service import create_embedding_service

            logger.info("Loading pipeline diarization embedding model: %s", hf_model_id)
            service = create_embedding_service(hf_model_id=hf_model_id)
            await service.initialize()
            self._pipeline_embedding_services[hf_model_id] = service
            return service

    def _make_commit_policy(self, pipeline_config: Any) -> LocalAgreementPolicy | None:
        """Build a LocalAgreement-2 policy when the pipeline enables it.

        Gated by ``streaming.commit_policy``; strict
        equality so MagicMock pipeline configs (unit tests) and unknown
        values keep the policy off (wire format unchanged).
        """
        if pipeline_config is None:
            return None
        streaming_cfg = getattr(pipeline_config, "streaming", None)
        policy_name = getattr(streaming_cfg, "commit_policy", None)
        if policy_name == "local_agreement_2":
            return LocalAgreementPolicy()
        return None

    def _reset_commit_policy(self, session_id: str) -> None:
        """Reset the commit policy when an utterance finalizes (if enabled)."""
        policy = self._commit_policies.get(session_id)
        if policy is not None:
            policy.reset()

    def _check_final_handover(self, session_id: str, text: str) -> None:
        """Reconcile the whole-buffer final with the frozen partial prefix.

        OD-1 (a): text that has slid out of the partial window is settled for
        good and is never revised mid-utterance, so the final — which decodes
        the WHOLE buffer, not a 15 s tail — can legitimately disagree with it.
        The final is the persisted record and wins; the discrepancy is logged so
        the divergence is measurable rather than silent.

        The frozen text is handed over by ``policy.reset()``, which runs when
        the preprocessor closes the utterance — before the final is decoded.
        """
        policy = self._commit_policies.get(session_id)
        if policy is None:
            return
        frozen = policy.take_handover_text()
        if not frozen:
            return
        frozen_norm = normalize_for_comparison(frozen)
        final_norm = normalize_for_comparison(text)
        if frozen_norm and f" {frozen_norm} " in f" {final_norm} ":
            return
        logger.warning(
            "stt.streaming.commit.final_mismatch",
            session_id=session_id,
            frozen_text=frozen[:_HANDOVER_LOG_CHARS],
            final_text=text[:_HANDOVER_LOG_CHARS],
        )

    def _resolve_endpoint_config(self, pipeline_config: Any) -> EndpointConfig | None:
        """The session's own endpoint config, or None when the agent chose ``fixed``.

        TASK-877 — the SPEC is the only source. ``pipeline_spec_from_resolved``
        builds ``preprocessing.endpoint`` from ``streaming.endpointing`` plus the
        optional ``streaming.semantic`` block and the ``endpointing`` model role,
        so an agent that asks for semantic endpointing now gets it. The former
        second branch — the ``stt.semanticEndpoint.*`` platform family — is gone:
        it duplicated an agent concept, and its kill-switch role is served instead
        by the agent's own ``endpointing`` choice plus an unpublished EOU model row.

        Strict ``isinstance`` so MagicMock/duck-typed test configs never enable it
        (mirrors ``_make_commit_policy``).
        """
        preprocessing = getattr(pipeline_config, "preprocessing", None)
        endpoint = getattr(preprocessing, "endpoint", None)
        if isinstance(endpoint, EndpointConfig) and endpoint.enabled:
            return endpoint
        return None

    def _make_endpointer(self, pipeline_config: Any) -> SemanticEndpointer | None:
        """Build a per-session semantic endpointer when enabled.

        Mirrors ``_make_commit_policy``: returns None unless endpointing is
        enabled (globally or per-pipeline), so a session with it off keeps the
        fixed silence-offset behavior. The optional turn/EOU model is lazily
        loaded by the endpointer itself and degrades to the heuristic when
        un-staged — no cloud dependency.
        """
        config = self._resolve_endpoint_config(pipeline_config)
        if config is None or not config.enabled:
            return None
        return SemanticEndpointer(config)

    # ------------------------------------------------------------------
    # Startup / Shutdown
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Start the session manager: recover sessions, start heartbeat and reaper."""
        self._running = True

        # Register worker heartbeat
        await self._register_worker()
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop(), name="worker-heartbeat")

        # Recover active sessions from Redis
        await self._recover_sessions()

        # Start background reaper
        self._reaper_task = asyncio.create_task(self._reaper_loop(), name="session-reaper")

        # Start audio snapshot loop
        self._snapshot_task = asyncio.create_task(self._snapshot_loop(), name="audio-snapshot")

        logger.info(
            "SessionManager started",
            worker_id=self._worker_id,
            recovered_sessions=len(self._sessions),
            max_streams=self._profile.max_concurrent_streams,
        )

    async def stop(self) -> None:
        """Gracefully shut down: stop consumers, persist state, unregister worker."""
        self._running = False

        # Cancel background tasks
        for task in (self._heartbeat_task, self._reaper_task, self._snapshot_task):
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        # Stop all consumers and listeners
        for consumer in self._consumers.values():
            await consumer.stop()
        for listener in self._control_listeners.values():
            await listener.stop()

        for sid in list(self._inference_queues):
            await self._drain_inference_queue(sid)
            await self._stop_inference_loop(sid, force_cancel=True)

        # Cancel all in-flight partial tasks
        for task in self._partial_tasks.values():
            if not task.done():
                task.cancel()
        self._partial_tasks.clear()

        # Persist all sessions one final time
        for session in self._sessions.values():
            try:
                await session.force_persist()
            except Exception as exc:
                logger.error(
                    "Failed to persist session on shutdown",
                    session_id=session.session_id,
                    error=str(exc),
                )

        # Unregister worker
        await self._unregister_worker()

        self._sessions.clear()
        self._consumers.clear()
        self._control_listeners.clear()
        self._publishers.clear()
        self._preprocessors.clear()
        self._inference_workers.clear()
        self._inference_queues.clear()
        self._inference_tasks.clear()
        self._commit_policies.clear()

        logger.info("SessionManager stopped", worker_id=self._worker_id)

    # ------------------------------------------------------------------
    # Session CRUD
    # ------------------------------------------------------------------

    async def create_session(
        self,
        session_id: str,
        tenant_id: str,
        pipeline_id: str,
        consultation_id: str | None = None,
        sample_rate: int = 16000,
        audio_bucket_name: str | None = None,
        user_id: str | None = None,
        language: str | None = None,
        storage: dict[str, Any] | None = None,
        provider_overrides: dict[str, Any] | None = None,
        fallback_pipeline_id: str | None = None,
        language_mode: str | None = None,
        start_on: str = "primary",
        auto_switch_enabled: bool | None = None,
        consecutive_failure_threshold: int | None = None,
        channel_count: int = 1,
        resolved_spec: dict[str, Any] | None = None,
        voice_profiles: list[dict[str, Any]] | None = None,
    ) -> StreamSession | None:
        """Create a new streaming session.

        Returns the ``StreamSession`` if admitted, or ``None`` if at
        capacity.

        Args:
            session_id: Unique session identifier.
            tenant_id: Tenant identifier.
            pipeline_id: Pipeline UUID or slug.
            consultation_id: Optional consultation context.
            sample_rate: Audio sample rate in Hz.
            audio_bucket_name: Optional tenant-scoped audio bucket override.
            user_id: Optional authenticated user ID.
            language: Optional pipeline language override.
            storage: Optional per-tenant storage provider descriptor. When
                present, selects the provider (MinIO/S3/Azure) and bucket for
                this tenant; when absent, ``audio_bucket_name`` is used.
            provider_overrides: Optional per-tenant BYO cloud-provider
                credential map (gateway-injected wire shape
                ``{provider: {api_key, region?, base_url?, model?}}``). Held in
                memory only; NEVER persisted or logged. Preferred over env creds
                by the cloud ASR loaders (fail-open per credential).
            fallback_pipeline_id: Optional tenant fallback pipeline. When set, a
                per-session ``EngineSwitchController`` can swap the live ASR
                engine to it (create-time / auto-outage / manual triggers).
            language_mode: Optional end-user language mode id. Resolved
                against the session's ASR engine at load time into the inference
                config's language/code_switching/streaming_english_gloss. A mode
                the CALLER declared takes precedence over ``language``; a bare
                ``language`` that names a catalog mode is promoted to one, and
                only a caller who declared neither falls back to the agent's own
                mode (TASK-938 — see
                :func:`_language_mode_for_declared_language`). If the primary engine cannot serve
                the mode a configured fallback is tried; if none qualifies the
                create raises ``LanguageModeUnsupportedError`` (mapped to 422).
            start_on: ``'primary'`` (default) or ``'fallback'``.
                When ``'fallback'`` AND a ``fallback_pipeline_id`` is configured,
                the runtime is assembled on the fallback pipeline_config from the
                start while ``primary_pipeline_id`` stays wired, so a later
                switch-back to the primary builds it lazily. This is a deliberate
                user choice (the primary is NOT attempted at create) and is
                distinct from the load-failure ``created_on_fallback`` path. If
                no fallback is configured, the create fails open on the primary.
            auto_switch_enabled: Tenant governance for the FAILURE-DRIVEN auto
                switch. ``None`` = the controller's own default
                (enabled), so an older gateway that sends nothing keeps the
                previous behaviour. Never affects a user-initiated switch — that
                is an explicit choice, not a policy.
            consecutive_failure_threshold: Tenant governance for how many
                consecutive threshold-class utterance failures arm the auto
                switch. ``None`` = the controller's default (2).
            resolved_spec: TASK-861 — the gateway-resolved ``ResolvedAsrSpec``
                (wire JSON). When present the engine chain, its models, the
                fallback and the decoder prompt come from it and this method
                reads NOTHING from Postgres; ``pipeline_id`` /
                ``fallback_pipeline_id`` become the spec's runtime keys and the
                request's ``auto_switch_enabled`` / ``consecutive_failure_threshold``
                / ``language_mode`` fill in from the spec when omitted.
        """
        # PLANNED scale-down: reject before touching capacity at all. Distinct
        # signal (SessionManagerDrainingError) from the ordinary at-capacity
        # `None` return below, so callers — and streaming/api/routes.py's HTTP
        # layer — can tell a draining worker apart from a transient ceiling.
        # getattr(..., False): pre-existing unit tests build
        # MagicMock(spec=SessionManager) fixtures that predate this flag and
        # never set it — real instances always have it via __init__.
        if getattr(self, "_draining", False):
            raise SessionManagerDrainingError(
                f"worker {self._worker_id} is draining; rejecting new session {session_id}"
            )

        # Check capacity
        if not await self._capacity_guard.try_acquire(session_id):
            return None
        try:
            # TASK-861 — the agent path: register the spec bundle FIRST so every
            # loader below resolves from it, and let the spec govern the keys.
            if resolved_spec is not None:
                bundle = self._register_resolved_spec(session_id, resolved_spec)
                if pipeline_id != bundle.runtime_key:
                    logger.warning(
                        "Session runtime key disagrees with its resolved spec; the spec wins",
                        session_id=session_id,
                        requested=pipeline_id,
                        runtime_key=bundle.runtime_key,
                    )
                pipeline_id = bundle.runtime_key
                fallback_pipeline_id = bundle.fallback_runtime_key
                if auto_switch_enabled is None:
                    auto_switch_enabled = bundle.spec.fallback.auto_switch
                if consecutive_failure_threshold is None:
                    consecutive_failure_threshold = (
                        bundle.spec.fallback.switch_after_consecutive_failures
                    )
                if not language_mode:
                    # TASK-938 — the spec backfill must not run over an explicit
                    # `language`. Promote a declaration that names a catalog mode;
                    # keep a non-catalog one on `inference.language` below by
                    # leaving the mode UNSET, which is what stops the resolution in
                    # `_load_asr_pipeline` from overwriting it. Only a caller who
                    # declared neither gets the agent's own mode.
                    language_mode = _language_mode_for_declared_language(language)
                    if not language_mode and not language:
                        language_mode = bundle.spec.decoding.language_mode

            # Register per-tenant storage routing before any audio I/O. A
            # `storage` descriptor (multi-provider) wins and also pins the audio
            # bucket; otherwise fall back to the legacy bucket override.
            if storage and tenant_id:
                blob = self._get_blob_service()
                blob._resolver.set_tenant_storage(tenant_id, storage)
            elif audio_bucket_name and tenant_id:
                blob = self._get_blob_service()
                blob._resolver.set_tenant_bucket(tenant_id, "audio", audio_bucket_name)

            # Build metadata
            metadata = SessionMetadata(
                session_id=session_id,
                tenant_id=tenant_id,
                pipeline_id=pipeline_id,
                consultation_id=consultation_id,
                status=SessionStatus.ACTIVE,
                sample_rate=sample_rate,
                worker_id=self._worker_id,
                user_id=user_id,
                # Persisted so crash recovery rebuilds the chain from the spec,
                # not from a database read (TASK-861).
                resolved_spec_json=json.dumps(resolved_spec) if resolved_spec is not None else "",
                # TASK-891 — persist the effective language mode (the end user's
                # declaration, or the agent's own when nothing was declared) so a
                # worker restart resolves the SAME mode. `_session_language_modes`
                # alone is process-local, and recovery without it fell through to
                # the spec's mapped primary subtag — pinning `ml` on an `ml-en`
                # session that was deliberately left unpinned.
                language_mode=language_mode or "",
            )

            # Create session object
            session = StreamSession(metadata=metadata, redis=self._redis)
            await session.force_persist()

            # Stash the in-memory-only BYO overrides + fallback
            # pointer before any load, so they are available to the primary ASR
            # load, the create-time fallback path, and later engine swaps.
            self._provider_overrides[session_id] = dict(provider_overrides or {})
            # TASK-887 — the gateway already filtered these to the agent's embedding model
            # and to this user + tenant; `seed_voice_profiles` re-checks the model before
            # registering anything.
            if voice_profiles:
                self._session_voice_profiles[session_id] = list(voice_profiles)
            if fallback_pipeline_id:
                self._fallback_pipeline_ids[session_id] = fallback_pipeline_id
            # Stash the end-user language mode so both the primary and
            # any create-time fallback assembly resolve it against their engine.
            if language_mode:
                self._session_language_modes[session_id] = language_mode
            # Stash the dual-/multi-mic source count so the teardown
            # summary (from EVERY finalize path, including the idle reaper) can
            # echo it for usage repricing.
            if channel_count and channel_count > 1:
                self._session_channel_counts[session_id] = channel_count

            # A user-selected start-on-fallback assembles the
            # fallback pipeline_config directly (the primary is NOT attempted at
            # create), while the primary stays wired for a later switch-back.
            # Fail-open: if no fallback is configured, proceed on the primary.
            started_on_fallback = start_on == "fallback" and bool(fallback_pipeline_id)
            created_on_fallback = False

            # Load pipeline config for VAD and ASR model wiring.
            # Pass tenant_id so STT refuses to load
            # a pipeline owned by a different tenant (defense in depth).
            initial_pipeline_id = fallback_pipeline_id if started_on_fallback else pipeline_id
            # started_on_fallback is True only when bool(fallback_pipeline_id) is
            # True (see its definition above), so the ternary's "then" branch is
            # never None; the "else" branch is the required str `pipeline_id`.
            assert initial_pipeline_id is not None  # narrowed by started_on_fallback
            pipeline_config = await self._load_pipeline_config(
                initial_pipeline_id, tenant_id=tenant_id, session_id=session_id
            )

            if language is not None and pipeline_config:
                pipeline_config.inference.language = language

            if started_on_fallback:
                # User chose the fallback engine up front — assemble it directly.
                logger.info(
                    "Opening session on tenant fallback by request (start_on=fallback)",
                    session_id=session_id,
                    pipeline_id=pipeline_id,
                    fallback_pipeline_id=fallback_pipeline_id,
                )
                runtime = await self._assemble_session_runtime(
                    session_id=session_id,
                    tenant_id=tenant_id,
                    consultation_id=consultation_id,
                    user_id=user_id,
                    sample_rate=sample_rate,
                    pipeline_config=pipeline_config,
                    build_speaker_identifier=True,
                    provider_overrides=provider_overrides,
                    # Effective pipeline: the fallback IS the engine
                    # this session opens on.
                    active_pipeline_id=fallback_pipeline_id,
                )
            else:
                # One shared assembly for creation AND recovery.
                # create-time trigger: if the PRIMARY assembly fails (e.g. the
                # primary ASR engine's credentials/load) and a fallback is
                # configured, open the session directly on the fallback instead
                # of rolling back + raising.
                try:
                    runtime = await self._assemble_session_runtime(
                        session_id=session_id,
                        tenant_id=tenant_id,
                        consultation_id=consultation_id,
                        user_id=user_id,
                        sample_rate=sample_rate,
                        pipeline_config=pipeline_config,
                        build_speaker_identifier=True,
                        provider_overrides=provider_overrides,
                        active_pipeline_id=pipeline_id,
                    )
                except Exception as primary_exc:
                    if not fallback_pipeline_id:
                        raise
                    logger.warning(
                        "Primary ASR pipeline failed at create; opening session on fallback",
                        session_id=session_id,
                        pipeline_id=pipeline_id,
                        fallback_pipeline_id=fallback_pipeline_id,
                        error=str(primary_exc),
                    )
                    pipeline_config = await self._load_pipeline_config(
                        fallback_pipeline_id, tenant_id=tenant_id, session_id=session_id
                    )
                    if language is not None and pipeline_config:
                        pipeline_config.inference.language = language
                    runtime = await self._assemble_session_runtime(
                        session_id=session_id,
                        tenant_id=tenant_id,
                        consultation_id=consultation_id,
                        user_id=user_id,
                        sample_rate=sample_rate,
                        pipeline_config=pipeline_config,
                        build_speaker_identifier=True,
                        provider_overrides=provider_overrides,
                        # The sharpest divergence: the client is
                        # told 'active' and never learns it is on an engine it
                        # did not select. Stamp the effective one.
                        active_pipeline_id=fallback_pipeline_id,
                    )
                    created_on_fallback = True
            publisher = runtime.publisher
            preprocessor = runtime.preprocessor
            inference_worker = runtime.inference_worker

            session.processed_sample_rate = runtime.target_sr
            session._vad_active = runtime.vad_enabled

            metadata.diarization = runtime.effective_diarization
            await session.force_persist()

            self._register_inference_runtime(session, inference_worker)

            self._sessions[session_id] = session
            # Sync the active-streaming-sessions gauge + total counter.
            streaming_session_started(self.active_session_count)
            self._dual_capture[session_id] = self._resolve_dual_capture(pipeline_config)
            self._publishers[session_id] = publisher
            self._preprocessors[session_id] = preprocessor
            self._inference_workers[session_id] = inference_worker
            # TASK-874 — open the first engine-time span on whatever
            # `_assemble_session_runtime` actually loaded. That is the primary
            # normally, and the FALLBACK on both create-time-fallback paths
            # (user-selected `start_on`, or a primary that failed to load), so a
            # session that opened on the fallback bills its whole first span to
            # the fallback rather than to an engine that never ran.
            self._start_usage_segments(session_id)

            # Per-session commit policy (off by default)
            commit_policy = self._make_commit_policy(pipeline_config)
            if commit_policy is not None:
                self._commit_policies[session_id] = commit_policy

            # Wire up Redis consumers and listeners. The audio
            # consumer joins a per-session consumer group under this worker's id
            # so a crash hands its in-flight (unacked) audio off to the
            # recovering worker via XAUTOCLAIM instead of stranding it.
            consumer = IngestionConsumer(
                redis=self._redis,
                session_id=session_id,
                on_frame=self._make_frame_handler(session, preprocessor),
                on_batch=self._make_batch_handler(session),
                consumer_name=self._worker_id,
            )
            control_listener = ControlListener(
                redis=self._redis,
                session_id=session_id,
                on_control=self._make_control_handler(session, preprocessor),
            )

            self._consumers[session_id] = consumer
            self._control_listeners[session_id] = control_listener

            # Per-session engine-switch controller. Created for every
            # session (so the manual-switch / auto-outage paths have a target);
            # switches are no-ops when no fallback is configured.
            switch_controller = self._make_switch_controller(
                session_id=session_id,
                tenant_id=tenant_id,
                primary_pipeline_id=pipeline_id,
                fallback_pipeline_id=fallback_pipeline_id,
                auto_switch_enabled=auto_switch_enabled,
                consecutive_failure_threshold=consecutive_failure_threshold,
            )
            self._switch_controllers[session_id] = switch_controller
            # If the primary ASR failed and we opened on the fallback, record the
            # create-time switch so it is observable (status result + metric).
            # These two flags are mutually exclusive: created_on_fallback is the
            # load-failure path, started_on_fallback is the user-selected one.
            if created_on_fallback:
                await switch_controller.note_switched_at_create()
            elif started_on_fallback:
                # Deliberate user choice: primary stays switchable
                # and no provider_switched event is emitted.
                await switch_controller.note_started_on_fallback()

            # Start consuming
            await consumer.start()
            await control_listener.start()

            logger.info(
                "Session created",
                session_id=session_id,
                tenant_id=tenant_id,
                pipeline_id=pipeline_id,
                has_vad=runtime.vad_service is not None,
                has_asr=runtime.asr_pipeline is not None,
                has_denoiser=runtime.denoiser is not None,
                on_fallback=created_on_fallback,
                start_on=start_on,
                started_on_fallback=started_on_fallback,
                active_sessions=self.active_session_count,
            )
            return session
        except Exception as exc:
            _spec_bundles_of(self).pop(session_id, None)
            logger.error(
                "Failed to create session, rolling back",
                session_id=session_id,
                tenant_id=tenant_id,
                pipeline_id=pipeline_id,
                error=str(exc),
            )
            await self.remove_session(session_id)
            raise

    def get_session(self, session_id: str) -> StreamSession | None:
        """Retrieve an active session by ID, or ``None``."""
        return self._sessions.get(session_id)

    def get_publisher(self, session_id: str) -> ResultPublisher | None:
        """Retrieve the result publisher for a session."""
        return self._publishers.get(session_id)

    def get_switch_controller(self, session_id: str) -> EngineSwitchController | None:
        """Retrieve the engine-switch controller for a session."""
        return self._switch_controllers.get(session_id)

    async def request_switch(self, session_id: str, target: str = "fallback") -> None:
        """Request a manual mid-session engine switch.

        Called by the internal ``POST /internal/streaming/sessions/{id}/switch``
        route with ``target`` ∈ {``'primary'``, ``'fallback'``}. XADDs a
        ``SWITCH_TO_FALLBACK`` control message (carrying ``target``) onto the
        session's control stream — the same cross-process channel finalize/cancel
        use — so the ``ControlListener`` routes it to the
        ``EngineSwitchController`` and the swap lands at an utterance boundary,
        in order with the audio.

        The pre-checks below reject illegal transitions (→ 409) synchronously so
        the route can acknowledge the accepted switch; the authoritative signal
        that the swap landed is the ``provider_switched`` result frame.

        Raises
        ------
        KeyError
            The session is unknown on this worker (→ 404).
        ValueError
            The target is unavailable — no fallback configured, primary never
            loaded, an unknown target, or already on the requested engine (→ 409).
        """
        if session_id not in self._sessions:
            raise KeyError(session_id)
        controller = self._switch_controllers.get(session_id)
        if controller is None:
            raise ValueError("no_fallback_configured")
        if target == "fallback":
            if not controller.has_fallback:
                raise ValueError("no_fallback_configured")
            if controller.active_engine == "fallback":
                raise ValueError("already_on_fallback")
        elif target == "primary":
            if not controller.can_switch_to_primary:
                raise ValueError("primary_unavailable")
            if controller.active_engine == "primary":
                raise ValueError("already_on_primary")
        else:
            raise ValueError("invalid_target")
        await self._redis.xadd(
            control_stream_key(session_id),
            SessionControl(action=ControlAction.SWITCH_TO_FALLBACK, target=target).to_redis_dict(),
        )

    async def request_switch_to_fallback(self, session_id: str) -> None:
        """Back-compat alias for ``request_switch(session_id, 'fallback')``."""
        await self.request_switch(session_id, "fallback")

    def _make_switch_controller(
        self,
        *,
        session_id: str,
        tenant_id: str | None,
        primary_pipeline_id: str,
        fallback_pipeline_id: str | None,
        auto_switch_enabled: bool | None = None,
        consecutive_failure_threshold: int | None = None,
    ) -> EngineSwitchController:
        """Build the per-session ``EngineSwitchController``.

        Wires the three injected primitives against this manager: lazily build
        the fallback ASR callable, swap the reference the inference worker reads,
        and publish the ``provider_switched`` status result.
        """

        async def _build_fallback() -> StreamingAsrCallable:
            return await self._build_fallback_asr_callable(
                session_id, fallback_pipeline_id, tenant_id
            )

        async def _build_primary() -> StreamingAsrCallable:
            # Rebuild the PRIMARY ASR callable so a user-initiated
            # switch BACK to the primary engine is possible. Symmetric to the
            # fallback builder; reuses the session's in-memory BYO overrides.
            return await self._build_primary_asr_callable(
                session_id, primary_pipeline_id, tenant_id
            )

        def _apply(new_callable: StreamingAsrCallable, pipeline_id: str | None) -> None:
            worker = self._inference_workers.get(session_id)
            if worker is not None:
                # The inference worker reads this reference each utterance; a
                # plain reassignment is the whole "seamless swap".
                worker._asr_pipeline = new_callable
                # The per-utterance provenance stamp moves with the
                # callable, in this same synchronous body. Do NOT split these
                # two assignments, add an await between them, or introduce a
                # second update path: any divergence attributes utterances to
                # the wrong engine, which is worse than no attribution.
                worker._active_pipeline_id = pipeline_id
            # TASK-874 — the engine-TIME span boundary belongs in this same
            # synchronous body, and for the same reason: this is the instant the
            # live engine changes. Placing it at the earlier `_load_asr_pipeline`
            # stamp would close the outgoing engine's span for a fallback build
            # that then raises and never takes over (selection is fail-closed).
            self._advance_usage_segments(session_id)

        async def _publish(
            from_pipeline: str,
            to_pipeline: str,
            reason: str,
            active: str,
            utterance_index: int | None,
        ) -> None:
            publisher = self._publishers.get(session_id)
            if publisher is not None:
                await publisher.publish_provider_switched(
                    from_pipeline=from_pipeline,
                    to_pipeline=to_pipeline,
                    reason=reason,
                    active=active,
                    utterance_index=utterance_index,
                )

        # The tenant's auto-switch governance. Both values are real
        # `TenantSttConfig` settings resolved by the gateway, but nothing ever
        # sent them, so this controller always used its own defaults: a tenant
        # that turned auto-fallback OFF still got it. `None` (an older gateway
        # that sends neither) keeps the controller's defaults, so the previous
        # behaviour is byte-identical.
        governance: dict[str, Any] = {}
        if auto_switch_enabled is not None:
            governance["auto_switch_enabled"] = auto_switch_enabled
        if consecutive_failure_threshold is not None:
            governance["consecutive_failure_threshold"] = consecutive_failure_threshold

        return EngineSwitchController(
            session_id=session_id,
            tenant_id=tenant_id,
            primary_pipeline_id=primary_pipeline_id,
            fallback_pipeline_id=fallback_pipeline_id,
            build_fallback=_build_fallback,
            build_primary=_build_primary,
            apply_callable=_apply,
            publish_switch=_publish,
            **governance,
        )

    def _session_audio_seconds(self, session_id: str) -> float:
        """Decoded audio seconds ingested so far — the span boundary marker."""
        session = self._sessions.get(session_id)
        return session.total_duration_seconds if session is not None else 0.0

    def _session_usage_counters(self, session_id: str) -> EngineUsageCounters:
        """The inference worker's cumulative compute/network counters right now.

        TASK-959 — the OTHER span boundary marker. Snapshotted at every engine
        swap and at teardown so the accumulator bills each engine the difference,
        which is what makes a fallback leg carry its own GPU seconds and its own
        bytes instead of the whole session's landing on whichever engine finished.
        A session with no worker yet (nothing ever transcribed) reports zeros —
        a real measurement, not a gap.
        """
        worker = self._inference_workers.get(session_id)
        if worker is None:
            return EngineUsageCounters()
        return EngineUsageCounters(
            processing_seconds=worker.cumulative_processing_seconds,
            request_bytes=worker.cumulative_request_bytes,
            response_bytes=worker.cumulative_response_bytes,
            byte_source=worker.last_byte_source,
        )

    def _start_usage_segments(
        self, session_id: str, asr_format: Any | None = None, **kwargs: Any
    ) -> None:
        """Open the first engine-time span for a session (TASK-874).

        Defaults to whatever `_load_asr_pipeline` stamped — the single source of
        truth for the live engine — so the caller never has to re-derive it.

        A session with no resolved ASR format gets no accumulator: the teardown
        summary then reports no engine and the gateway emits nothing, exactly as
        it does today for a session that failed before load.
        """
        if asr_format is None:
            asr_format = self._session_asr_formats.get(session_id)
        if asr_format is None:
            return
        # TASK-958 G3 — the span records the connection the engine that serves it
        # authenticates as, taken from the same `_load_asr_pipeline` stamp that put
        # the format there. The session-level slot keeps moving as engines switch;
        # this copy does not, which is what lets each span bill its own account.
        kwargs.setdefault("connection", self._session_connections.get(session_id))
        self._session_usage_segments[session_id] = EngineUsageAccumulator(
            asr_format,
            audio_seconds=self._session_audio_seconds(session_id),
            counters=self._session_usage_counters(session_id),
            **kwargs,
        )

    def _advance_usage_segments(self, session_id: str) -> None:
        """Close the live engine's span and open one on the engine now serving."""
        accumulator = self._session_usage_segments.get(session_id)
        asr_format = self._session_asr_formats.get(session_id)
        if accumulator is None or asr_format is None:
            return
        accumulator.switch_to(
            asr_format,
            audio_seconds=self._session_audio_seconds(session_id),
            counters=self._session_usage_counters(session_id),
            connection=self._session_connections.get(session_id),
        )

    async def _build_fallback_asr_callable(
        self,
        session_id: str,
        fallback_pipeline_id: str | None,
        tenant_id: str | None,
    ) -> StreamingAsrCallable:
        """Load the fallback pipeline and build a warm ASR callable.

        Resolved LAZILY (only when a switch actually fires) so a configured-but-
        never-used fallback costs nothing. Reuses the session's in-memory BYO
        ``provider_overrides`` so the fallback engine honours the tenant's key.
        """
        if not fallback_pipeline_id:
            raise RuntimeError("No fallback pipeline configured for this session")
        fb_config = await self._load_pipeline_config(fallback_pipeline_id, tenant_id=tenant_id)
        overrides = self._provider_overrides.get(session_id)
        asr_callable, _ = await self._load_asr_pipeline(
            fb_config, session_id, tenant_id=tenant_id, provider_overrides=overrides
        )
        if asr_callable is None:
            raise RuntimeError(
                f"Fallback pipeline '{fallback_pipeline_id}' produced no ASR callable"
            )
        return asr_callable

    async def _build_primary_asr_callable(
        self,
        session_id: str,
        primary_pipeline_id: str,
        tenant_id: str | None,
    ) -> StreamingAsrCallable:
        """Load the primary pipeline and build a warm ASR callable.

        Symmetric to ``_build_fallback_asr_callable`` — used when a user switches
        BACK to the primary engine. Resolved LAZILY (only when a switch-back
        actually fires). Reuses the session's in-memory BYO ``provider_overrides``
        so the primary engine honours the tenant's key.
        """
        p_config = await self._load_pipeline_config(primary_pipeline_id, tenant_id=tenant_id)
        overrides = self._provider_overrides.get(session_id)
        asr_callable, _ = await self._load_asr_pipeline(
            p_config, session_id, tenant_id=tenant_id, provider_overrides=overrides
        )
        if asr_callable is None:
            raise RuntimeError(f"Primary pipeline '{primary_pipeline_id}' produced no ASR callable")
        return asr_callable

    def _seed_voice_profiles(
        self, tracker: Any, session_id: str, model_slug: str | None
    ) -> dict[str, object]:
        """Register the session's gateway-pushed voice profiles on ``tracker``.

        TASK-887 — this replaced ``_preseed_speaker``, which reached into Postgres for the
        consultation's doctor and their embedding. The gateway knows the session's user and
        the agent's embedding model, so it resolves the profiles and pushes them; this side
        only registers what it was handed.
        """
        from stt.diarization.preseed import seed_voice_profiles

        return seed_voice_profiles(
            tracker,
            self._session_voice_profiles.get(session_id),
            model_slug=model_slug,
            log_context=session_id,
        )

    async def end_session(self, session_id: str) -> dict[str, Any] | None:
        """Gracefully end a session — finalize (upload artifacts) then remove.

        This is the public entry-point for API routes (DELETE, POST end).
        It flushes any pending utterance, drains the inference queue, and
        calls ``_finalize_session`` which uploads remaining PCM chunks,
        ``complete.wav``, ``transcript.json``, and ``metadata.json``
        before cleaning up.

        Returns the usage-attribution teardown summary (see
        ``_build_teardown_summary``) so the API Gateway can emit the
        ``transcribe.stream`` ledger row — ``None`` when the session was
        already gone, or when the forced-removal error path below was taken
        (best-effort: a summary is never worth blocking cleanup for).
        """
        session = self._sessions.get(session_id)
        if session is None:
            return None

        try:
            # F-32 / TASK-985 M-04 — flush the tail at most once per session,
            # and WAIT for it when another trigger claimed it first.
            await self._run_tail_flush(session, self._preprocessors.get(session_id))
            # TASK-985 M-23 — this caller RETURNS the summary to the gateway,
            # so it is the one that emits the ledger row; nothing to stash.
            return await self._finalize_session(session, stash_summary=False)
        except Exception as exc:
            logger.error(
                "Failed to end session gracefully; forcing removal",
                session_id=session_id,
                error=str(exc),
            )
            await self.remove_session(session_id)
            return None

    async def remove_session(self, session_id: str) -> None:
        """Remove a session, stopping its consumers and releasing capacity."""
        # Stop consumer and listener
        consumer = self._consumers.pop(session_id, None)
        if consumer:
            try:
                await consumer.stop()
            except Exception as exc:
                logger.error(
                    "Failed to stop ingestion consumer during session removal",
                    session_id=session_id,
                    error=str(exc),
                )
        listener = self._control_listeners.pop(session_id, None)
        if listener:
            try:
                await listener.stop()
            except Exception as exc:
                logger.error(
                    "Failed to stop control listener during session removal",
                    session_id=session_id,
                    error=str(exc),
                )

        try:
            await self._stop_inference_loop(session_id, force_cancel=True)
        except Exception as exc:
            logger.error(
                "Failed to stop inference loop during session removal",
                session_id=session_id,
                error=str(exc),
            )

        self._publishers.pop(session_id, None)
        self._preprocessors.pop(session_id, None)
        self._inference_workers.pop(session_id, None)
        self._inference_queues.pop(session_id, None)
        self._inference_tasks.pop(session_id, None)
        self._cancel_partial(session_id)
        self._partial_tasks.pop(session_id, None)
        self._final_published_gates.pop(session_id, None)
        self._commit_policies.pop(session_id, None)
        # Drop the in-memory engine-switch state (controller + BYO
        # overrides + fallback pointer); the overrides are never persisted.
        self._switch_controllers.pop(session_id, None)
        self._provider_overrides.pop(session_id, None)
        self._session_voice_profiles.pop(session_id, None)
        self._fallback_pipeline_ids.pop(session_id, None)
        self._session_language_modes.pop(session_id, None)
        self._session_channel_counts.pop(session_id, None)
        _spec_bundles_of(self).pop(session_id, None)
        # The teardown summary (if any) is built BEFORE this
        # runs (see `_finalize_session_locked`), so dropping the tracking dict
        # here is safe cleanup, not a lost read.
        self._session_asr_formats.pop(session_id, None)
        self._session_connections.pop(session_id, None)
        self._session_usage_segments.pop(session_id, None)
        # Drop the per-session finalize lock (a queued waiter
        # already holds its own reference and will no-op on the CLOSED guard).
        self._finalize_locks.pop(session_id, None)
        # F-32 — drop the tail-flush latch with the session so a later session
        # reusing the id gets its own tail flushed. TASK-985 M-04: SET it on the
        # way out. Removal is the end of this session's tail by definition, and
        # a waiter that already holds a reference to the Event would otherwise
        # sit out its full bound waiting for an owner that no longer exists.
        # (Nothing here cancels the owner — `remove_session` is reached only
        # from a finalizer that has passed the latch, or from a rollback where
        # there is no tail.)
        tail_done = self._tail_flush_done.pop(session_id, None)
        if tail_done is not None:
            tail_done.set()
        self._sessions.pop(session_id, None)
        # Release pipeline model pins so idle TTL can apply.
        pinned = self._session_pinned_models.pop(session_id, None)
        if pinned:
            try:
                from stt.models import get_model_cache

                await get_model_cache().unpin_many(pinned)
            except Exception as exc:
                logger.warning(
                    "Failed to unpin pipeline models on session removal",
                    session_id=session_id,
                    error=str(exc),
                )
        # Keep the active-streaming-sessions gauge in sync on removal.
        streaming_session_ended(self.active_session_count)
        self._last_snapshot_at.pop(session_id, None)
        self._last_audio_trim_at.pop(session_id, None)
        self._chunk_indices.pop(session_id, None)
        self._processed_chunk_indices.pop(session_id, None)
        self._chunk_offsets.pop(session_id, None)
        self._processed_chunk_offsets.pop(session_id, None)
        self._dual_capture.pop(session_id, None)

        # Release capacity (must happen even if other cleanup fails)
        try:
            await self._capacity_guard.release(session_id)
        except Exception as exc:
            logger.error(
                "Failed to release capacity during session removal",
                session_id=session_id,
                error=str(exc),
            )

        logger.info(
            "Session removed",
            session_id=session_id,
            active_sessions=self.active_session_count,
        )

    async def force_end_all_sessions(self) -> list[str]:
        """Force-end all active sessions and return removed session IDs."""
        session_ids = list(self._sessions.keys())
        for session_id in session_ids:
            await self.remove_session(session_id)
        return session_ids

    def list_sessions(self) -> list[dict[str, Any]]:
        """Return diagnostic snapshots for all active sessions."""
        return [s.to_dict() for s in self._sessions.values()]

    # ------------------------------------------------------------------
    # Model loading helpers (VAD + ASR pipeline wiring)
    # ------------------------------------------------------------------

    def _register_resolved_spec(
        self, session_id: str, resolved_spec: dict[str, Any]
    ) -> ResolvedSpecBundle:
        """TASK-861 — validate + map the gateway-resolved spec for ``session_id``.

        Fails CLOSED on an invalid spec or a format this runtime does not execute
        (``pydantic.ValidationError`` / ``UnsupportedAsrSpecError``) — never a
        guessed engine.
        """
        bundle = bundle_from_resolved(resolved_spec)
        bundles = getattr(self, "_session_specs", None)
        if not isinstance(bundles, dict):
            bundles = {}
            self._session_specs = bundles
        bundles[session_id] = bundle
        return bundle

    async def _load_pipeline_config(
        self, pipeline_id: str, tenant_id: str | None = None, *, session_id: str | None = None
    ) -> Any:
        """Load the ``PipelineSpec`` for a runtime key.

        TASK-861: a key registered by any spec-driven session (runtime keys are
        agent VERSION ids, so two sessions on the same key share the same spec)
        resolves from that bundle — a fresh deep copy per call, because callers
        mutate ``inference.language`` — and NEVER touches Postgres. Anything
        else goes to the deprecated pipeline reader (removed in R4; warns on
        use; fails closed while the DB is disabled).

        Forwards ``tenant_id`` to the deprecated reader so its SQL query rejects
        pipelines belonging to other tenants (defense in depth).

        Raises
        ------
        RuntimeError
            If the pipeline cannot be loaded (missing config, DB error, etc.).
        """
        bundles = _spec_bundles_of(self)
        # TASK-935 — the requesting session's OWN bundle wins. Runtime keys are agent
        # VERSION ids, so every session on one agent shares a key, and the specs
        # behind that key are only identical while the model row stands still: a
        # bundle registered earlier (a sibling session, or a session recovered from
        # Redis at startup) carries whatever the row said THEN. The scan below is
        # reached only when the session has no bundle of its own.
        own = bundles.get(session_id) if session_id else None
        if own is not None:
            spec = own.pipeline_specs.get(pipeline_id)
            if spec is not None:
                return copy.deepcopy(spec)
        for bundle in bundles.values():
            spec = bundle.pipeline_specs.get(pipeline_id)
            if spec is not None:
                return copy.deepcopy(spec)

        from stt.pipeline.config_reader import get_pipeline_reader

        reader = get_pipeline_reader()
        pipeline = await reader.get_pipeline(pipeline_id, tenant_id=tenant_id)
        if pipeline is None:
            raise RuntimeError(
                f"Pipeline '{pipeline_id}' not found — cannot create streaming session"
            )
        return pipeline.spec

    async def _load_vad_service(
        self,
        pipeline_config: Any,
        session_id: str,
    ) -> Any:
        """Load Silero VAD service for the streaming preprocessor.

        Uses the singleton ``get_vad_service()`` which shares a single
        ONNX session across all streaming sessions (the model is
        stateless — per-session LSTM state lives in ``VADSessionState``).

        TASK-880 — the WEIGHTS come from the session's own ``AiModel`` row
        (``ResolvedAsrSpec.models.vad.localPath``), not from the deleted platform key
        ``stt.vad.modelPath``. A spec whose VAD row stages no local copy passes ``None``
        and the service resolves from the HuggingFace cache, which is exactly what that
        key's own default (empty = auto-download) did.

        Returns ``None`` if VAD is disabled, not configured, or fails to
        load. The preprocessor degrades gracefully by using an
        energy-based fallback VAD.
        """
        if pipeline_config is None:
            return None

        if not pipeline_config.preprocessing.vad.enabled:
            logger.debug(
                "VAD disabled in pipeline config",
                session_id=session_id,
            )
            return None

        try:
            from stt.vad.silero_service import get_vad_service

            vad_service = get_vad_service(
                model_path=self._spec_vad_local_path(session_id, pipeline_config)
            )
            if not vad_service.is_loaded:
                await vad_service.initialize()

            logger.info(
                "VAD service loaded for streaming session",
                session_id=session_id,
            )
            return vad_service
        except Exception as exc:
            logger.warning(
                "Failed to load VAD for streaming, proceeding without VAD",
                session_id=session_id,
                error=str(exc),
            )
            return None

    def _spec_embedding_model_id(self, session_id: str | None, pipeline_config: Any) -> str | None:
        """The per-session speaker-embedding model id, from an INLINE or a SLUG ref.

        TASK-880 closes the defect TASK-877 recorded and deferred: only the INLINE branch
        existed, while ``pipeline_spec_from_resolved`` emits ``ModelRef(slug=...)`` for
        every agent — so an agent's ``models.embedding`` never reached the embedding
        service and every agent session silently diarized on the platform singleton
        (``stt.diarization.hfModelId``). The spec bundle already carries the resolved row,
        so resolving the slug adds no database read to the agent path.

        Returns ``None`` when there is no embedding ref, or when a slug is not in this
        session's bundle. TASK-887 removed the platform singleton that used to serve in
        that case: ``None`` now means embedding diarization does not run for this session.
        """
        ref = getattr(getattr(pipeline_config, "models", None), "embedding", None)
        if ref is None:
            return None
        if getattr(ref, "is_inline", False) and ref.inline:
            return str(ref.inline.hf_model_id)
        slug = getattr(ref, "slug", None)
        model_config = _spec_model_config_of(self, session_id, slug)
        return getattr(model_config, "source_uri", None) if model_config is not None else None

    @staticmethod
    def _spec_embedding_slug(pipeline_config: Any) -> str | None:
        """The registry SLUG of the session's speaker-embedding model, or ``None``.

        TASK-887 — the slug is the IDENTITY a ``UserVoiceProfile.modelId`` is compared
        against, while :meth:`_spec_embedding_model_id` returns the loader id
        (``source_uri``). Two registry rows can wrap the same HuggingFace repo with
        different revisions or compute types, so the slug is what decides whether a
        profile's vectors belong to this session's space.
        """
        ref = getattr(getattr(pipeline_config, "models", None), "embedding", None)
        slug = getattr(ref, "slug", None) if ref is not None else None
        return str(slug) if slug else None

    def _spec_vad_local_path(self, session_id: str | None, pipeline_config: Any) -> str | None:
        """``ResolvedAsrSpec.models.vad.localPath`` for a spec-driven session, else ``None``."""
        ref = getattr(getattr(pipeline_config, "models", None), "vad", None)
        slug = getattr(ref, "slug", None) if ref is not None else None
        model_config = _spec_model_config_of(self, session_id, slug)
        return getattr(model_config, "local_path", None) if model_config is not None else None

    async def _warm_and_pin_pipeline_models(
        self,
        model_cache: Any,
        pipeline_config: Any,
        *,
        tenant_id: str | None,
        session_id: str,
    ) -> list[str]:
        """Load every model referenced by the pipeline and pin them.

        Failures for optional models (VAD/denoise/embedding) are logged and
        skipped; ASR is already loaded by the caller.

        TASK-977 (D-4) — a DISABLED stage warms nothing. The warm used to key on ref
        presence alone, so a session that would never run VAD still fetched and
        pinned Silero's weights (not a runtime-owned library, so the download is
        real). The gateway lane stops shipping a ref for a disabled stage; this is
        the other half, so neither side has to be trusted alone.
        """
        from stt.pipeline.config_reader import get_model_reader
        from stt.pipeline.dto import ModelTaskType

        model_refs = pipeline_config.models
        pinned: list[str] = []

        # Read defensively: the fallback is each stage's OWN dataclass default, so a
        # config carrying no `preprocessing` block behaves exactly like a default
        # `PipelineSpec` rather than turning the warm silently off.
        preprocessing = getattr(pipeline_config, "preprocessing", None)
        vad_enabled = bool(getattr(getattr(preprocessing, "vad", None), "enabled", False))
        denoise_enabled = bool(getattr(getattr(preprocessing, "denoise", None), "enabled", False))
        # The embedding model is DIARIZATION's, and that flag is a sibling of
        # `preprocessing`, not a member of it.
        diarization_enabled = bool(
            getattr(getattr(pipeline_config, "diarization", None), "enabled", False)
        )

        async def _load_optional(
            ref: Any, task_type: ModelTaskType, label: str, *, enabled: bool
        ) -> None:
            if ref is None:
                return
            if not enabled:
                # Debug, not info: after TASK-977 a disabled stage is the NORMAL
                # case, so this fires on most sessions. Deliberately worded apart
                # from the "Skipped warming" refusal below — that one means the
                # cache cannot serve the weights, this one means nobody asked.
                logger.debug(
                    f"Skipping the {label} warm: the stage is disabled",
                    session_id=session_id,
                )
                return
            try:
                db_cfg = None
                if not (ref.is_inline and ref.inline) and ref.slug:
                    # TASK-861 — spec-driven sessions carry every model config;
                    # only the deprecated pipeline path still reads the registry.
                    db_cfg = _spec_model_config_of(self, session_id, ref.slug)
                    if db_cfg is None and session_id not in _spec_bundles_of(self):
                        db_cfg = await get_model_reader().get_model_by_slug(ref.slug, tenant_id)
                loaded = await model_cache.get_or_load_from_ref(
                    model_ref=ref, task_type=task_type, db_model_config=db_cfg
                )
                slug = loaded.model_slug or (ref.slug if hasattr(ref, "slug") else None)
                if slug:
                    pinned.append(slug)
            except ModelNotCacheServedError as exc:
                # TASK-944 (B2) — NOT a failure. The row declares a serving library
                # this cache does not hold (pyannote-audio / speechbrain /
                # pyrnnoise / deepfilternet); the session manager builds those
                # runtimes itself, from the same spec, further down. Warming one
                # here used to mean a doomed `transformers` resolution — ~9.3 s on
                # every cold session — reported as a WARNING that read like a
                # broken model. Logged at INFO, and only once the cache has SAID so.
                logger.info(
                    f"Skipped warming the {label} model: its runtime owns the weights",
                    session_id=session_id,
                    reason=str(exc),
                )
            except Exception as exc:
                logger.warning(
                    f"Failed to warm {label} model for streaming pipeline",
                    session_id=session_id,
                    error=str(exc),
                )

        # ASR is already loaded; still pin its slug.
        asr_ref = model_refs.asr
        asr_slug = asr_ref.slug if asr_ref and not (asr_ref.is_inline and asr_ref.inline) else None
        if asr_slug:
            pinned.append(asr_slug)
        elif asr_ref and asr_ref.is_inline and asr_ref.inline:
            # Inline ASR uses a synthetic slug from the loaded model; pin after load in caller.
            pass

        await _load_optional(
            model_refs.vad,
            ModelTaskType.VOICE_ACTIVITY_DETECTION,
            "VAD",
            enabled=vad_enabled,
        )
        await _load_optional(
            model_refs.denoise,
            ModelTaskType.AUDIO_TO_AUDIO,
            "denoise",
            enabled=denoise_enabled,
        )
        await _load_optional(
            getattr(model_refs, "embedding", None),
            ModelTaskType.SPEAKER_EMBEDDING,
            "embedding",
            enabled=diarization_enabled,
        )

        # Prefer the cache's view of the ASR slug if inline.
        if not asr_slug:
            try:
                # Already in cache from caller load — find by scanning not needed;
                # pin inline ASR via its loaded slug if present on cache keys later.
                pass
            except Exception:
                pass

        if pinned:
            await model_cache.pin_many(pinned)
            logger.info(
                "Pinned pipeline models for streaming session",
                session_id=session_id,
                slugs=pinned,
            )
        return pinned

    async def _load_cloud_asr_uncached(
        self,
        *,
        model_cache: Any,
        asr_ref: Any,
        db_model_config: Any,
        provider_overrides: dict[str, Any],
    ) -> Any:
        """Load a cloud ASR model directly through its loader (BYOK).

        Bypasses the shared by-slug cache so the injected ``provider_overrides``
        reach the loader and the decrypted key is never cached under a slug.
        Cloud loaders are cheap (no weights): they only validate the key and
        return a lightweight ``LoadedModel``. Falls back to the cache path if no
        loader is registered for the format (defensive; unreachable in practice).
        """
        from stt.pipeline.dto import ModelTaskType

        if asr_ref.is_inline and asr_ref.inline:
            model_config = asr_ref.inline.to_ai_model_config(
                ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION
            )
        elif db_model_config is not None:
            model_config = db_model_config
        else:
            raise RuntimeError("Cloud ASR ref has neither an inline definition nor a DB config")

        loader = model_cache._get_loader(model_config.format)
        if loader is None:
            return await model_cache.get_or_load_from_ref(
                model_ref=asr_ref,
                task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
                db_model_config=db_model_config,
            )
        return await loader.load(model_config, provider_overrides=provider_overrides)

    async def _load_asr_pipeline(
        self,
        pipeline_config: Any,
        session_id: str,
        tenant_id: str | None = None,
        provider_overrides: dict[str, Any] | None = None,
    ) -> tuple[StreamingAsrCallable | None, str | None]:
        """Load ASR model and create a callable pipeline for streaming inference.

        Returns a tuple of (callable, resolved_initial_prompt).
        The callable is ``(samples: np.ndarray, sample_rate: int) -> dict[str, Any]``
        that runs inference on a single utterance.

        ``provider_overrides`` carries per-tenant BYO cloud creds. For
        a cloud ASR engine WITH overrides the model load BYPASSES the shared
        by-slug cache and calls the loader directly, so a decrypted tenant key is
        never cached under a slug and served to another tenant.

        Raises
        ------
        RuntimeError
            If the ASR model cannot be loaded (missing DB config, bad credentials, etc.).
        """
        if pipeline_config is None:
            raise RuntimeError("Cannot load ASR pipeline: pipeline config is None")

        from stt.models import get_model_cache
        from stt.pipeline.dto import ModelTaskType

        model_cache = get_model_cache()
        asr_ref = pipeline_config.models.asr

        # The seeded matrix pipelines reference ASR
        # models by CATALOG SLUG; only batch resolved slugs
        # before, so streaming raised ModelLoadError on every slug-based
        # pipeline. Resolve the DB row here (tenant-scoped, mirroring
        # batch_service._load_models).
        db_model_config = None
        if not (asr_ref.is_inline and asr_ref.inline) and asr_ref.slug:
            # TASK-861 — a spec-driven session resolves the ASR row from its
            # bundle; a slug the spec does not carry is a hard error (never a
            # database fallback on the agent path).
            db_model_config = _spec_model_config_of(self, session_id, asr_ref.slug)
            if db_model_config is None and session_id in _spec_bundles_of(self):
                raise RuntimeError(
                    f"ASR model '{asr_ref.slug}' is not part of session {session_id}'s resolved spec"
                )
            if db_model_config is None:
                from stt.pipeline.config_reader import get_model_reader

                db_model_config = await get_model_reader().get_model_by_slug(
                    asr_ref.slug, tenant_id
                )

        # Cloud BYOK: bypass the shared by-slug cache when a per-tenant
        # override is present for a cloud ASR engine (a tenant key must not be
        # cached and reused across tenants). Env-only (no override) keeps the
        # existing cache path byte-identical.
        asr_format = None
        if asr_ref.is_inline and asr_ref.inline:
            asr_format = asr_ref.inline.engine
        elif db_model_config is not None:
            asr_format = getattr(db_model_config, "format", None)

        if provider_overrides and asr_format in _CLOUD_ASR_OVERRIDE_FORMATS:
            asr_model = await self._load_cloud_asr_uncached(
                model_cache=model_cache,
                asr_ref=asr_ref,
                db_model_config=db_model_config,
                provider_overrides=provider_overrides,
            )
        else:
            # Load ASR model via the model cache
            asr_model = await model_cache.get_or_load_from_ref(
                model_ref=asr_ref,
                task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
                db_model_config=db_model_config,
            )

        # Stamp the format of whichever ASR model just loaded.
        # This runs on session-create AND every engine switch (this method is
        # the sole loader for both), so the LATEST call always reflects the
        # currently active engine for usage-ledger attribution at teardown.
        self._session_asr_formats[session_id] = asr_model.format
        # TASK-958 — same choke point, same staleness guarantee: whichever model just
        # loaded is the one being billed, so its connection is the one to attribute to.
        self._session_connections[session_id] = (
            getattr(db_model_config, "connection_key", None),
            getattr(db_model_config, "connection_id", None),
        )

        # On pipeline use, load ALL referenced models (vad/denoise/
        # embedding) into the cache and pin them for the active session.
        pinned_slugs = await self._warm_and_pin_pipeline_models(
            model_cache, pipeline_config, tenant_id=tenant_id, session_id=session_id
        )
        # Always pin the ASR slug that actually loaded (covers inline defs).
        asr_pin = asr_model.model_slug
        if asr_pin and asr_pin not in pinned_slugs:
            await model_cache.pin(asr_pin)
            pinned_slugs.append(asr_pin)
        if pinned_slugs:
            self._session_pinned_models[session_id] = pinned_slugs

        # Use pipeline inference config directly
        inference_config = pipeline_config.inference

        # Resolve the end-user language mode against the engine that
        # actually loaded. "Selection constrains providers": if this engine
        # cannot serve the mode, raise so create_session falls through to a
        # compatible fallback (or surfaces a 422 when none qualifies).
        mode_id = self._session_language_modes.get(session_id)
        code_switch_prompt: str | None = None
        if mode_id:
            from stt.pipeline.language_modes import resolve_mode_for_engine

            resolved = resolve_mode_for_engine(mode_id, asr_model.format)
            inference_config.language = resolved.language
            inference_config.code_switching = resolved.code_switching
            inference_config.streaming_english_gloss = resolved.streaming_english_gloss
            # whisper.cpp code-switch: a bilingual priming prompt (the engine has
            # no translate gloss); applied to the session's initial_prompt below.
            code_switch_prompt = resolved.initial_prompt

        # TASK-861 — the agent's LITERAL prompt wins; the template-id lookup
        # (a database read) survives only for the deprecated pipeline path.
        prompt_text = getattr(inference_config, "initial_prompt_text", None)
        initial_prompt: str | None = (
            prompt_text if isinstance(prompt_text, str) and prompt_text else None
        )
        initial_prompt_id = getattr(inference_config, "initial_prompt", None)
        if initial_prompt is None and initial_prompt_id:
            from stt.core.initial_prompt import get_initial_prompt

            initial_prompt = await get_initial_prompt(initial_prompt_id)
        # Prepend the code-switch priming prompt ahead of any
        # template-configured initial prompt; the inference worker further
        # composes this with per-utterance carry-forward text each utterance.
        if code_switch_prompt:
            from stt.core.initial_prompt import compose_prompt

            initial_prompt = compose_prompt(code_switch_prompt, initial_prompt)

        # Whether this pipeline consumes per-word timestamps — only then does the
        # whisper.cpp adapter incur the lossy ``max_len=1`` word-splitting decode;
        # otherwise it runs a clean sentence-level decode (see
        # ``WhisperCppAsrAdapter``). Stashed for ``_make_whisper_cpp_callable`` to
        # read (threading it through the shared engine interface would touch every
        # engine adapter).
        timestamps_cfg = getattr(
            getattr(pipeline_config, "postprocessing", None), "timestamps", None
        )
        self._pending_want_word_timestamps = bool(getattr(timestamps_cfg, "word_timestamps", False))

        # Create the callable ASR pipeline
        asr_pipeline = self._make_asr_callable(
            asr_model,
            inference_config,
            initial_prompt=initial_prompt,
        )

        logger.info(
            "ASR pipeline loaded for streaming session",
            session_id=session_id,
            model_slug=asr_model.model_slug,
            model_format=asr_model.format.value,
            language=inference_config.language,
        )
        return asr_pipeline, initial_prompt

    async def _load_gloss_pipeline(
        self,
        pipeline_config: Any,
        session_id: str,
    ) -> StreamingAsrCallable | None:
        """Build the opt-in English-gloss callable.

        Reuses the cached ASR model (single-flight ``get_or_load``, so this
        never loads twice). Returns ``None`` unless
        ``inference.streaming_english_gloss`` is enabled and the engine
        supports ``task=translate``. Failures disable the gloss with a
        warning — they never block session creation.
        """
        if pipeline_config is None:
            return None
        inference_config = getattr(pipeline_config, "inference", None)
        # Strict identity check: only an explicit boolean True enables the
        # gloss (guards against mock/duck-typed configs in tests).
        if getattr(inference_config, "streaming_english_gloss", False) is not True:
            return None
        try:
            from stt.models import get_model_cache
            from stt.pipeline.dto import ModelTaskType

            model_cache = get_model_cache()
            asr_model = await model_cache.get_or_load_from_ref(
                model_ref=pipeline_config.models.asr,
                task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            )
            return self._make_gloss_callable(asr_model, inference_config)
        except Exception as exc:
            logger.warning(
                "Failed to build streaming gloss pipeline — gloss disabled",
                session_id=session_id,
                error=str(exc),
            )
            return None

    def _make_gloss_callable(
        self,
        asr_model: Any,
        inference_config: Any,
    ) -> StreamingAsrCallable | None:
        """``task=translate`` callable on the same cached model.

        Returns ``None`` when the gloss flag is off or the engine cannot
        translate (NeMo, Azure, multimodal LM).
        """
        from stt.pipeline.dto import AiModelFormat

        if getattr(inference_config, "streaming_english_gloss", False) is not True:
            return None

        fmt = getattr(asr_model, "format", None)
        if fmt in (
            AiModelFormat.NEMO,
            AiModelFormat.AZURE_SPEECH,
            # No translate task on the new engines either.
            AiModelFormat.AZURE_FOUNDRY,
            AiModelFormat.PARAKEET_CPP,
        ):
            logger.warning(
                "streaming_english_gloss is not supported for engine %s — gloss disabled",
                fmt,
            )
            return None
        extra = getattr(asr_model, "extra", None)
        if isinstance(extra, dict) and extra.get("multimodal_lm") is True:
            logger.warning(
                "streaming_english_gloss is not supported for multimodal LM "
                "pipelines — gloss disabled",
            )
            return None

        return self._make_asr_callable(asr_model, inference_config, task="translate")

    def _make_asr_callable(
        self,
        asr_model: Any,
        inference_config: Any,
        initial_prompt: str | None = None,
        task: str = "transcribe",
    ) -> StreamingAsrCallable:
        """Create a standalone callable ASR pipeline for streaming inference.

        Dispatch is registry-driven: the engine adapter is
        resolved from the processor registry by ``AiModelFormat``, so adding
        an engine registers one spec + one adapter instead of editing an
        if/elif chain here AND in batch. ``task="translate"``
        builds the English-gloss variant on the same loaded model
        (Whisper-family engines only — the gloss caller filters out
        NeMo/Azure/multimodal before requesting it).
        """
        from stt.models.base_loader import LoadedModel
        from stt.processors.asr_engines import ASR_FORMAT_TO_NAME, resolve_asr_engine
        from stt.processors.binding import resolve_engine_binding

        loaded_model: LoadedModel = asr_model
        engine = resolve_asr_engine(loaded_model.format)

        # Resolve + log the (device, compute) binding once per
        # session so silent downgrades (e.g. faster-whisper MPS→CPU) are
        # visible; a mismatch warns (observability-first, never blocks).
        engine_name = ASR_FORMAT_TO_NAME.get(loaded_model.format)
        if engine_name is not None and task == "transcribe":
            profile = getattr(self, "_profile", None)
            binding = resolve_engine_binding(
                "asr",
                engine_name,
                mode="streaming",
                compute_pref=[getattr(profile, "asr_compute_type", None)],
                declared_compute_type=_declared_compute_type(loaded_model),
            )
            if binding is not None:
                logger.info(
                    "ASR engine binding resolved",
                    engine=engine_name,
                    device=binding.device,
                    compute=binding.compute,
                )

        callable_: StreamingAsrCallable = engine.make_streaming_callable(
            self,
            loaded_model,
            inference_config,
            initial_prompt=initial_prompt,
            task=task,
        )
        return callable_

    def _make_nemo_callable(
        self,
        loaded_model: Any,
        inference_config: Any,
        initial_prompt: str | None = None,
    ) -> StreamingAsrCallable:
        """NeMo (Parakeet) per-utterance streaming callable (moved verbatim
        from the former _make_asr_callable branch)."""
        from stt.models.nemo_adapter import NemoAsrAdapter

        if initial_prompt:
            logger.warning(
                "initial_prompt was supplied for a NeMo (Parakeet) "
                "streaming pipeline; Parakeet does not support text "
                "conditioning. Ignoring.",
            )
        if getattr(inference_config, "code_switching", False):
            logger.warning(
                "code_switching was requested for a NeMo (Parakeet) "
                "streaming pipeline; ignoring (multilingual variants "
                "must be selected at the model level).",
            )

        nemo_adapter = NemoAsrAdapter(loaded_model, inference_config)

        async def run_nemo_inference(
            samples: np.ndarray,
            sample_rate: int,
            *,
            prompt: str | None = None,  # noqa: ARG001 — ignored
        ) -> dict[str, Any]:
            return await asyncio.to_thread(nemo_adapter, samples, sample_rate)

        return run_nemo_inference

    def _make_faster_whisper_callable(
        self,
        loaded_model: Any,
        inference_config: Any,
        task: str = "transcribe",
    ) -> StreamingAsrCallable:
        """faster-whisper/CTranslate2 per-utterance streaming callable (moved
        verbatim from the former _make_asr_callable branch)."""
        from stt.streaming.faster_whisper_asr import FasterWhisperAsrAdapter

        fw_adapter = FasterWhisperAsrAdapter(
            loaded_model,
            inference_config,
            batch_size=getattr(self._profile, "asr_max_batch_size", None),
            task=task,
        )

        async def run_faster_whisper_inference(
            samples: np.ndarray,
            sample_rate: int,
            *,
            prompt: str | None = None,
        ) -> dict[str, Any]:
            return await asyncio.to_thread(fw_adapter, samples, sample_rate, prompt=prompt)

        return run_faster_whisper_inference

    def _make_parakeet_cpp_callable(
        self,
        loaded_model: Any,
        inference_config: Any,
    ) -> StreamingAsrCallable:
        """parakeet.cpp per-utterance streaming callable.

        Minimal integration: per-utterance decode via the duck-typed binding.
        The model family's native cache-aware stateful streaming does not fit
        the per-utterance callable contract — separate ticket.
        """
        from stt.streaming.parakeet_cpp_asr import ParakeetCppAsrAdapter

        adapter = ParakeetCppAsrAdapter(loaded_model, inference_config)

        async def run_parakeet_inference(
            samples: np.ndarray,
            sample_rate: int,
            *,
            prompt: str | None = None,  # noqa: ARG001 — RNNT has no text conditioning
        ) -> dict[str, Any]:
            return await asyncio.to_thread(adapter, samples, sample_rate)

        return run_parakeet_inference

    def _make_whisper_cpp_callable(
        self,
        loaded_model: Any,
        inference_config: Any,
    ) -> StreamingAsrCallable:
        """whisper.cpp per-utterance streaming callable.

        Per-utterance decode via the pywhispercpp binding — whisper.cpp has no
        native incremental-streaming API either, so this mirrors
        ``_make_parakeet_cpp_callable``'s per-utterance re-run style.
        """
        from stt.streaming.whisper_cpp_asr import WhisperCppAsrAdapter

        adapter = WhisperCppAsrAdapter(
            loaded_model,
            inference_config,
            want_word_timestamps=getattr(self, "_pending_want_word_timestamps", False),
        )

        async def run_whisper_cpp_inference(
            samples: np.ndarray,
            sample_rate: int,
            *,
            prompt: str | None = None,
            max_decode_window_sec: float | None = None,
        ) -> dict[str, Any]:
            # TASK-934 — the decode window is per CALL: the inference worker asks
            # for the model's window on a final and for a single span on a
            # partial (already bounded by `partialWindowSec`). `None` keeps the
            # window this adapter was constructed with.
            return await asyncio.to_thread(
                adapter,
                samples,
                sample_rate,
                prompt=prompt,
                max_decode_window_sec=max_decode_window_sec,
            )

        return run_whisper_cpp_inference

    def _make_azure_callable(
        self,
        loaded_model: Any,
        inference_config: Any,
    ) -> StreamingAsrCallable:
        """Azure Speech per-utterance streaming callable (moved verbatim from
        the former _make_asr_callable branch)."""
        from stt.models.azure_speech_loader import normalize_language_for_azure
        from stt.streaming.azure_asr import azure_recognize_utterance

        speech_config = loaded_model.model  # SpeechConfig instance
        language = normalize_language_for_azure(
            getattr(inference_config, "language", None),
        )
        code_switching = getattr(inference_config, "code_switching", False)

        # Warn about Whisper-specific params that don't apply
        for param in (
            "beam_size",
            "temperature",
            "compression_ratio_threshold",
            "logprob_threshold",
            "no_speech_threshold",
            "condition_on_prev_tokens",
        ):
            if getattr(inference_config, param, None) is not None:
                logger.warning(
                    "Azure Speech streaming: ignoring Whisper-specific param %s",
                    param,
                )

        async def run_azure_inference(
            samples: np.ndarray,
            sample_rate: int,
            *,
            prompt: str | None = None,  # noqa: ARG001 — not used by Azure
        ) -> dict[str, Any]:
            return await asyncio.to_thread(
                azure_recognize_utterance,
                speech_config,
                samples,
                sample_rate,
                language,
                code_switching,
            )

        return run_azure_inference

    def _make_sarvam_callable(
        self,
        loaded_model: Any,
        inference_config: Any,
    ) -> StreamingAsrCallable:
        """Sarvam per-utterance streaming callable (cloud REST).

        Uses per-utterance REST — HOPE already VAD-segments the
        stream, so each utterance is one bounded request. ``loaded_model.model``
        is a ``CloudRestConfig`` from ``SarvamLoader``.
        """
        from stt.streaming.sarvam_asr import sarvam_recognize_utterance

        config = loaded_model.model
        language = getattr(inference_config, "language", None)
        code_switching = getattr(inference_config, "code_switching", False)

        async def run_sarvam_inference(
            samples: np.ndarray,
            sample_rate: int,
            *,
            prompt: str | None = None,  # noqa: ARG001 — not used by Sarvam REST
        ) -> dict[str, Any]:
            return await sarvam_recognize_utterance(
                config, samples, sample_rate, language, code_switching=code_switching
            )

        return run_sarvam_inference

    def _make_openai_callable(
        self,
        loaded_model: Any,
        inference_config: Any,
    ) -> StreamingAsrCallable:
        """OpenAI per-utterance streaming callable (cloud REST).

        Uses per-utterance REST
        (``POST {base_url}/audio/transcriptions``); realtime WS is a fast-follow.
        ``loaded_model.model`` is a ``CloudRestConfig`` from ``OpenAILoader``.
        """
        from stt.streaming.openai_asr import openai_recognize_utterance

        config = loaded_model.model
        language = getattr(inference_config, "language", None)

        async def run_openai_inference(
            samples: np.ndarray,
            sample_rate: int,
            *,
            prompt: str | None = None,  # noqa: ARG001 — not used by OpenAI REST
        ) -> dict[str, Any]:
            return await openai_recognize_utterance(config, samples, sample_rate, language)

        return run_openai_inference

    def _make_transformers_callable(
        self,
        loaded_model: Any,
        inference_config: Any,
        initial_prompt: str | None = None,
        task: str = "transcribe",
    ) -> StreamingAsrCallable:
        """Default transformers (Whisper/CTC) streaming callable, including
        the multimodal-LM routing (moved verbatim from the former
        _make_asr_callable default path)."""
        import torch

        model = loaded_model.model
        processor = loaded_model.processor or loaded_model.feature_extractor
        device = loaded_model.device

        if processor is None:
            raise RuntimeError("ASR model has no processor/feature_extractor")

        extra = getattr(loaded_model, "extra", None)
        if isinstance(extra, dict) and extra.get("multimodal_lm") is True:
            return self._make_multimodal_lm_callable(
                loaded_model,
                inference_config,
                initial_prompt=initial_prompt,
            )

        # One-time dtype safety: fp16/bf16 on CPU/MPS causes Whisper hallucinations
        # Cast to float32 once at pipeline creation time.
        model_dtype = getattr(model, "dtype", torch.float32)
        device_str = str(device)
        if device_str in ("cpu", "mps") and model_dtype in (torch.float16, torch.bfloat16):
            logger.warning(
                "Casting ASR model from %s to float32 for safe %s inference",
                model_dtype,
                device_str,
            )
            model = model.float()
            loaded_model.model = model
            model_dtype = torch.float32

        # Pre-build static generate kwargs from pipeline config
        lang = getattr(inference_config, "language", None)
        processor_signature: inspect.Signature | None
        try:
            processor_signature = inspect.signature(processor.__call__)
        except (TypeError, ValueError):
            processor_signature = None
        processor_language_param = (
            processor_signature.parameters.get("language")
            if processor_signature is not None
            else None
        )
        processor_supports_language = processor_language_param is not None
        processor_requires_language = (
            processor_language_param is not None
            and processor_language_param.default is inspect.Signature.empty
        )
        if processor_signature is None:
            processor_supports_attention_mask = True
        else:
            params = processor_signature.parameters
            processor_supports_attention_mask = "return_attention_mask" in params or any(
                p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()
            )

        # Shared decode-kwargs builder (was one of three
        # hand-kept copies; semantics locked by
        # tests/unit/test_batch_inference_kwargs.py).
        static_kwargs = build_whisper_generate_kwargs(
            inference_config,
            task=task,
            return_timestamps=True,
            language=lang,
        )

        if task == "translate":
            # Mirror the batch English-translation pass:
            # force the English output token for the gloss decode.
            static_kwargs["language"] = "en"

        async def run_inference(
            samples: np.ndarray,
            sample_rate: int,
            *,
            prompt: str | None = None,
        ) -> dict[str, Any]:
            def _sync_inference() -> dict[str, Any]:
                return _run_model(samples, sample_rate, prompt=prompt)

            return await asyncio.to_thread(_sync_inference)

        def _run_model(
            samples: np.ndarray,
            sample_rate: int,
            *,
            prompt: str | None = None,
        ) -> dict[str, Any]:
            processor_language: str | None = None
            if processor_supports_language:
                if processor_requires_language and lang is None:
                    raise RuntimeError(
                        "ASR processor requires inference language, but "
                        "inference_config.language is not set."
                    )
                # Pinned language also flows to processors
                # that accept it, regardless of code_switching.
                processor_language = lang

            processor_kwargs: dict[str, Any] = {
                "sampling_rate": sample_rate,
                "return_tensors": "pt",
            }
            if processor_supports_attention_mask:
                processor_kwargs["return_attention_mask"] = True
            if processor_language is not None:
                processor_kwargs["language"] = processor_language

            inputs = processor(samples, **processor_kwargs)

            moved_inputs: dict[str, Any] = {}
            for k, v in inputs.items():
                if not isinstance(v, torch.Tensor):
                    continue
                if v.is_floating_point():
                    moved_inputs[k] = v.to(device=device, dtype=model_dtype)
                else:
                    moved_inputs[k] = v.to(device=device)
            inputs = moved_inputs

            generate_kwargs = dict(static_kwargs)

            if prompt and hasattr(processor, "get_prompt_ids"):
                try:
                    prompt_ids = processor.get_prompt_ids(prompt, return_tensors="pt")
                    generate_kwargs["prompt_ids"] = prompt_ids.to(device)
                except Exception:
                    logger.debug(
                        "Failed to encode prompt_ids for context carry-forward",
                        exc_info=True,
                    )

            with torch.no_grad():
                if hasattr(model, "generate"):
                    outputs = model.generate(
                        **inputs,
                        **generate_kwargs,
                    )
                    text = processor.batch_decode(
                        outputs,
                        skip_special_tokens=True,
                    )[0].strip()

                    word_timestamps: list[dict[str, Any]] = []
                    try:
                        decoded = processor.decode(
                            outputs[0],
                            skip_special_tokens=False,
                            output_offsets=True,
                        )
                        for entry in decoded.get("offsets", []):
                            ts = entry.get("timestamp", (0.0, 0.0))
                            if isinstance(ts, (list, tuple)) and len(ts) == 2:
                                s, e = ts
                            else:
                                s, e = 0.0, 0.0
                            s = s if s is not None else 0.0
                            e = e if e is not None else s
                            w = (entry.get("text", "") or "").strip()
                            if w:
                                word_timestamps.append(
                                    {
                                        "word": w,
                                        "start": s,
                                        "end": e,
                                        "confidence": 1.0,
                                    }
                                )
                    except Exception:
                        pass

                else:
                    # CTC model fallback (Wav2Vec2)
                    logits = model(**inputs).logits
                    predicted_ids = torch.argmax(logits, dim=-1)
                    text = processor.batch_decode(predicted_ids)[0].strip()
                    word_timestamps = []

            return {"text": text, "word_timestamps": word_timestamps}

        return run_inference

    def _make_multimodal_lm_callable(
        self,
        loaded_model: Any,
        inference_config: Any,
        initial_prompt: str | None = None,
    ) -> StreamingAsrCallable:
        """Create streaming callable for multimodal LLM models (Gemma 4)."""
        import torch

        from ..models.multimodal import (
            compute_max_new_tokens,
            prepare_chat_inputs,
        )

        model = loaded_model.model
        processor = loaded_model.processor
        if processor is None:
            raise RuntimeError(
                f"Multimodal LM {loaded_model.model_slug} requires a processor "
                "with apply_chat_template support, but processor is None."
            )
        device = loaded_model.device
        dtype = getattr(model, "dtype", None)
        captured_initial_prompt = initial_prompt

        async def run_inference(
            samples: np.ndarray,
            sample_rate: int,
            *,
            prompt: str | None = None,
        ) -> dict[str, Any]:
            def _sync() -> dict[str, Any]:
                content: list[dict[str, Any]] = []
                if captured_initial_prompt:
                    content.append({"type": "text", "text": captured_initial_prompt})
                content.append({"type": "audio", "audio": samples, "sample_rate": sample_rate})

                messages = [
                    {
                        "role": "user",
                        "content": content,
                    }
                ]

                inputs = prepare_chat_inputs(processor, messages, device, dtype=dtype)
                input_len = inputs["input_ids"].shape[-1]

                duration_s = len(samples) / sample_rate
                max_new = compute_max_new_tokens(duration_s)

                with torch.no_grad():
                    output = model.generate(**inputs, max_new_tokens=max_new)

                text = processor.decode(output[0][input_len:], skip_special_tokens=True)

                return {"text": text, "word_timestamps": []}

            return await asyncio.to_thread(_sync)

        return run_inference

    # ------------------------------------------------------------------
    # Frame and control handlers (wired to consumers)
    # ------------------------------------------------------------------

    def _register_inference_runtime(
        self,
        session: StreamSession,
        inference_worker: StreamingInferenceWorker,
    ) -> None:
        """Create and register queue/task for per-session ASR inference."""
        inference_queue: asyncio.Queue[AudioUtterance | None] = asyncio.Queue(
            maxsize=self._inference_queue_maxsize
        )
        self._inference_queues[session.session_id] = inference_queue
        gate = asyncio.Event()
        gate.set()  # no final in-flight initially
        self._final_published_gates[session.session_id] = gate
        inference_task = self._start_inference_loop(session, inference_worker, inference_queue)
        self._inference_tasks[session.session_id] = inference_task

    def _start_inference_loop(
        self,
        session: StreamSession,
        inference_worker: StreamingInferenceWorker,
        queue: asyncio.Queue[AudioUtterance | None],
    ) -> asyncio.Task[None]:
        """Spawn a background task that drains *queue* and runs ASR inference.

        The loop terminates when it receives ``None`` (a sentinel) from the
        queue.  Results are recorded on the session as they complete.
        """

        async def _loop() -> None:
            while True:
                utt = await queue.get()
                if utt is None:
                    queue.task_done()
                    break
                try:
                    result = await inference_worker.process_utterance(session.session_id, utt)
                    if result.is_final:
                        session.add_result(result)
                        session.utterance_count = utt.utterance_index + 1
                        self._check_final_handover(session.session_id, result.text)
                    # A clean utterance resets the consecutive-failure
                    # run that arms the threshold auto-switch.
                    controller = self._switch_controllers.get(session.session_id)
                    if controller is not None:
                        controller.record_success()
                except Exception as exc:
                    # Classify the failure through the engine-switch
                    # controller; it may swap the ASR engine to the fallback.
                    switched = False
                    controller = self._switch_controllers.get(session.session_id)
                    if controller is not None:
                        try:
                            switched = await controller.record_failure(
                                exc, utterance_index=utt.utterance_index
                            )
                        except Exception as switch_exc:
                            logger.error(
                                "Engine switch attempt failed; staying on primary",
                                session_id=session.session_id,
                                error=str(switch_exc),
                            )
                    if switched:
                        # Buffer handoff: re-run the un-finalized utterance on the
                        # freshly-swapped engine (best case re-transcribed; floor:
                        # this one utterance is lost — the session survives).
                        try:
                            result = await inference_worker.process_utterance(
                                session.session_id, utt
                            )
                            if result.is_final:
                                session.add_result(result)
                                session.utterance_count = utt.utterance_index + 1
                                self._check_final_handover(session.session_id, result.text)
                        except Exception as retry_exc:
                            logger.warning(
                                "Utterance re-run on fallback engine failed; dropping it",
                                session_id=session.session_id,
                                utterance_index=utt.utterance_index,
                                error=str(retry_exc),
                            )
                    else:
                        logger.error(
                            "Background inference failed",
                            session_id=session.session_id,
                            utterance_index=utt.utterance_index,
                            error=str(exc),
                        )
                finally:
                    # Unblock partials for the next utterance
                    gate = self._final_published_gates.get(session.session_id)
                    if gate is not None:
                        gate.set()
                    queue.task_done()

        return asyncio.create_task(_loop(), name=f"inference-{session.session_id}")

    async def _drain_inference_queue(self, session_id: str) -> None:
        """Wait for all pending utterances in the inference queue to finish.

        On a drain timeout (e.g. GPU backlog) the utterances still
        queued are transcribed inline before returning, rather than dropped, so
        the closing tail utterance always makes it into the final transcript.

        The background inference loop is a concurrent consumer of the same
        queue, so it is settled (cancelled + awaited) FIRST; the inline drain is
        then the sole consumer and cannot race the loop over the same item.
        """
        queue = self._inference_queues.get(session_id)
        if queue is None:
            return
        try:
            await asyncio.wait_for(queue.join(), timeout=self._inference_drain_timeout_s)
        except TimeoutError:
            logger.warning(
                "Inference queue drain timed out; transcribing remaining utterances inline",
                session_id=session_id,
                remaining=queue.qsize(),
                timeout_s=self._inference_drain_timeout_s,
            )
            await self._settle_inference_loop(session_id)
            await self._drain_remaining_inline(session_id, queue)

    async def _settle_inference_loop(self, session_id: str) -> None:
        """Cancel + await the background inference consumer.

        Stops the loop racing the inline drain over the queue. The tail
        utterance is the LAST item enqueued, so at a drain timeout it is still in
        the queue (the loop is busy on an earlier backlog item); cancelling the
        loop therefore preserves the tail for the inline drain and only forfeits
        the single mid-backlog item the loop was blocked on — an acceptable,
        bounded loss under sustained backlog.
        """
        task = self._inference_tasks.pop(session_id, None)
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.warning(
                "Background inference loop raised while settling for inline drain",
                session_id=session_id,
                error=str(exc),
            )

    async def _drain_remaining_inline(
        self,
        session_id: str,
        queue: asyncio.Queue[AudioUtterance | None],
    ) -> None:
        """Transcribe utterances still queued at drain-timeout inline.

        Only the finite snapshot currently in the queue is processed — finalize
        enqueues nothing further and the background loop only removes items — so
        this is bounded by the queue depth and never blocks unboundedly.
        """
        session = self._sessions.get(session_id)
        if session is None:
            return
        while True:
            try:
                utt = queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            try:
                if utt is not None:
                    await self._run_inline_inference(session, utt)
            finally:
                queue.task_done()

    async def _stop_inference_loop(self, session_id: str, force_cancel: bool = False) -> None:
        """Send sentinel and cancel the background inference task."""
        queue = self._inference_queues.pop(session_id, None)
        if queue is not None:
            try:
                queue.put_nowait(None)  # sentinel
            except asyncio.QueueFull:
                if not force_cancel:
                    try:
                        await asyncio.wait_for(queue.put(None), timeout=1.0)
                    except TimeoutError:
                        logger.warning(
                            "Timed out enqueueing inference sentinel",
                            session_id=session_id,
                            timeout_s=1.0,
                        )
                else:
                    logger.warning(
                        "Inference queue full during forced stop; proceeding to cancellation",
                        session_id=session_id,
                        remaining=queue.qsize(),
                    )

        task = self._inference_tasks.pop(session_id, None)
        if task is not None and not task.done():
            try:
                await asyncio.wait_for(task, timeout=self._inference_stop_timeout_s)
            except TimeoutError:
                if force_cancel:
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass
                else:
                    logger.warning(
                        "Inference task stop timed out",
                        session_id=session_id,
                        timeout_s=self._inference_stop_timeout_s,
                    )

    def _cancel_partial(self, session_id: str) -> None:
        """Cancel any in-flight partial task for this session."""
        task = self._partial_tasks.pop(session_id, None)
        if task is not None and not task.done():
            task.cancel()

    def _fire_partial(
        self,
        session_id: str,
        utterance: AudioUtterance,
        worker: StreamingInferenceWorker | None,
        publisher: ResultPublisher | None,
    ) -> None:
        """Fire a partial inference task if none is already in-flight.

        Uses skip-if-busy instead of cancel-and-replace so that at least
        one partial per inference cycle survives to be published.
        """
        if worker is None or publisher is None:
            return

        existing = self._partial_tasks.get(session_id)
        if existing is not None and not existing.done():
            return

        async def _run_partial() -> None:
            try:
                # Wait for any in-flight final to be published before emitting
                # partials for the next utterance. Timeout ensures we don't
                # block forever if the final pipeline is extremely slow.
                gate = self._final_published_gates.get(session_id)
                if gate is not None:
                    try:
                        await asyncio.wait_for(gate.wait(), timeout=2.0)
                    except TimeoutError:
                        pass  # publish anyway after timeout

                result = await worker.process_partial(session_id, utterance)
                if result.text.strip() and publisher is not None:
                    window_text = result.text
                    # LocalAgreement-2: annotate the partial
                    # with the committed (stable) prefix length.
                    policy = self._commit_policies.get(session_id)
                    if policy is not None:
                        # The utterance's own span anchors the hypothesis: past
                        # ``partial_window_s`` the preprocessor feeds a rolling
                        # TAIL, and text whose audio has left that window is
                        # frozen rather than re-decoded (OD-1 (a)). The caption
                        # is therefore the settled prefix plus this window's
                        # text, and ``stable_chars`` indexes all of it.
                        committed, _tentative = policy.update(
                            window_text,
                            window_start_time=result.start_time,
                            window_end_time=result.end_time,
                        )
                        result.text = policy.published_text
                        result.stable_chars = len(committed)
                        slide = policy.last_slide
                        if slide is not None:
                            logger.debug(
                                "stt.streaming.commit.slide",
                                session_id=session_id,
                                frozen_chars=slide[0],
                                in_window_chars=slide[1],
                            )
                    # Feed the running hypothesis to the semantic
                    # endpointer (mirrors the LocalAgreement-2 policy.update feed
                    # above). The preprocessor reads it at the silence→final cut
                    # to make a content-driven early-endpoint decision. Inert
                    # unless endpointing is enabled (endpointer is None). It sees
                    # the WINDOW's own hypothesis, not the accumulated caption:
                    # end-of-utterance is a judgement about what was just said,
                    # and the frozen prefix is by definition older audio.
                    preprocessor = self._preprocessors.get(session_id)
                    endpointer = getattr(preprocessor, "endpointer", None)
                    if endpointer is not None:
                        endpointer.observe_hypothesis(window_text)
                    await publisher.publish(result)
            except asyncio.CancelledError:
                pass  # Expected when cancelled by a final utterance
            except Exception as exc:
                logger.debug(
                    "Partial inference failed (non-fatal)",
                    session_id=session_id,
                    utterance_index=utterance.utterance_index,
                    error=str(exc),
                )

        self._partial_tasks[session_id] = asyncio.create_task(
            _run_partial(), name=f"partial-{session_id}"
        )

    def _make_batch_handler(self, session: StreamSession) -> Any:
        """Create the per-batch callback for the ingestion consumer.

        After each processed ``XREAD`` batch:
        1. Persist the last processed entry ID into the session hash so
           crash recovery resumes from it instead of replaying from 0-0.
        2. Periodically ``XTRIM MINID`` the consumed portion of the audio
           stream (the result stream is never trimmed here).

        All Redis errors are swallowed (logged) — hygiene must never
        disrupt audio processing.
        """
        session_id = session.session_id

        async def _on_batch(last_id: str) -> None:
            session.metadata.last_stream_id = last_id
            try:
                await self._redis.hset(session_meta_key(session_id), "last_stream_id", last_id)
            except Exception as exc:
                logger.debug(
                    "Failed to persist last_stream_id (non-fatal)",
                    session_id=session_id,
                    error=str(exc),
                )

            if self._audio_trim_interval_s <= 0:
                return
            now = time.monotonic()
            last_trim = self._last_audio_trim_at.get(session_id)
            if last_trim is not None and now - last_trim < self._audio_trim_interval_s:
                return
            self._last_audio_trim_at[session_id] = now
            try:
                await self._redis.xtrim(
                    audio_stream_key(session_id), minid=last_id, approximate=True
                )
            except Exception as exc:
                logger.debug(
                    "Audio stream trim failed (non-fatal)",
                    session_id=session_id,
                    minid=last_id,
                    error=str(exc),
                )

        return _on_batch

    def _make_frame_handler(
        self,
        session: StreamSession,
        preprocessor: StreamingPreprocessor | None = None,
    ) -> Any:
        """Create an async callback for incoming audio frames.

        When a preprocessor is provided, the handler feeds PCM data
        through VAD → utterance extraction and enqueues detected
        utterances for background ASR inference.  Without one, it
        only records the frame for bookkeeping.
        """
        inference_queue = self._inference_queues.get(session.session_id)
        inference_worker = self._inference_workers.get(session.session_id)
        publisher = self._publishers.get(session.session_id)

        async def _on_frame(frame: AudioFrame) -> None:
            if session.status != SessionStatus.ACTIVE:
                # TASK-985 M-29 — this is a LOSS, not a no-op, and it used to be
                # silent. `stt:control` and `stt:audio` are two Redis streams
                # with no mutual ordering, so a control FINALIZE flips the
                # status to FINALIZING while unread audio entries are still
                # queued behind it — 80-160 ms of the closing utterance at
                # steady state, more under back-pressure. Count it and say so
                # once, so the residual is measurable after the gateway moves
                # `stop` in-band (a zero-length `final=1` frame on `stt:audio`,
                # which is ordered against the audio by construction).
                session.frames_dropped_after_finalize += 1
                if not session._dropped_after_finalize_warned:
                    session._dropped_after_finalize_warned = True
                    logger.warning(
                        "stt.stream.frame_dropped_after_finalize",
                        session_id=session.session_id,
                        seq=frame.seq,
                        status=session.status.value,
                    )
                return

            session.record_frame(seq=frame.seq, data=frame.data, sample_rate=frame.sr)

            # Feed audio through preprocessor for real-time VAD + utterance extraction
            if preprocessor is not None:
                utterances = await preprocessor.feed(frame.data)

                processed_pcm = preprocessor.drain_processed_samples()
                if processed_pcm:
                    session.processed_audio_buffer.extend(processed_pcm)
                    if session.processed_sample_rate is None:
                        session.processed_sample_rate = preprocessor.target_sample_rate

                # Route utterances: finals to queue, partials to fire-and-forget
                for utt in utterances:
                    if utt.is_final:
                        self._cancel_partial(session.session_id)
                        # Next utterance starts a fresh policy
                        self._reset_commit_policy(session.session_id)
                        # Block partials for next utterance until this final publishes
                        gate = self._final_published_gates.get(session.session_id)
                        if gate is not None:
                            gate.clear()
                        if inference_queue is not None:
                            # F-08: bounded wait, not a blocking put. This runs on the
                            # single ingestion dispatch loop — a full queue must never
                            # block it (that would stop XACK'ing stt:audio and let its
                            # MAXLEN trim unread raw audio). On timeout the utterance is
                            # DROPPED (captions degrade); the durable audio pipeline is
                            # untouched and keeps draining independently.
                            try:
                                await asyncio.wait_for(
                                    inference_queue.put(utt),
                                    timeout=_STEADY_STATE_ENQUEUE_TIMEOUT_S,
                                )
                            except TimeoutError:
                                streaming_inference_queue_dropped()
                                logger.warning(
                                    "Dropping utterance: inference queue full past "
                                    "steady-state enqueue timeout",
                                    session_id=session.session_id,
                                    timeout_s=_STEADY_STATE_ENQUEUE_TIMEOUT_S,
                                    queue_maxsize=self._inference_queue_maxsize,
                                )
                    else:
                        self._fire_partial(
                            session.session_id,
                            utt,
                            inference_worker,
                            publisher,
                        )

            # Periodic Tier-1 persistence
            await session.persist_if_needed()

            # If final frame, trigger finalization
            if frame.final:
                # TASK-985 M-29 — the terminal frame is the ORDERED stop signal:
                # appended to `stt:audio` itself, it is reached strictly after
                # every earlier entry, so the "unread audio at FINALIZE" window
                # above is removed rather than narrowed. A zero-length body is
                # deliberate — `record_frame` adds `len(data)//2 == 0` samples,
                # so the marker cannot inflate `total_duration_seconds`, which
                # is the BILLED quantity.
                #
                # Note the consequence for ordering, which is why the tail latch
                # had to land first: once the gateway sends this instead of a
                # control FINALIZE, `_on_frame` becomes the FIRST finalizer and
                # the tail flush starts only after the whole audio backlog has
                # drained — i.e. LATER, which WIDENS the window in which the
                # SDK's DELETE overtakes it. Without `_run_tail_flush`'s
                # completion latch this change makes M-04 more likely, not less.
                logger.info(
                    "Final frame received",
                    session_id=session.session_id,
                    seq=frame.seq,
                    bytes=len(frame.data),
                )
                try:
                    # F-32 / TASK-985 M-04 — one tail flush per session across
                    # all triggers, and a bounded WAIT when another claimed it.
                    await self._run_tail_flush(session, preprocessor)
                    await self._finalize_session(session)
                except Exception as exc:
                    logger.error(
                        "Final frame finalization failed; forcing session removal",
                        session_id=session.session_id,
                        seq=frame.seq,
                        error=str(exc),
                    )
                    await self.remove_session(session.session_id)

        return _on_frame

    def _make_control_handler(
        self,
        session: StreamSession,
        preprocessor: StreamingPreprocessor | None = None,
    ) -> Callable[[SessionControl], Coroutine[Any, Any, None]]:
        """Create an async callback for session control commands.

        On FINALIZE: flush the preprocessor, drain the inference queue,
        then finalize the session.
        """

        async def _on_control(control: SessionControl) -> None:
            if control.action == ControlAction.FINALIZE:
                if session.status == SessionStatus.CLOSED:
                    return

                if session.status == SessionStatus.ACTIVE:
                    await session.finalize()
                    publisher = self._publishers.get(session.session_id)
                    if publisher:
                        await publisher.publish_status("finalizing")

                try:
                    # F-32 / TASK-985 M-04 — one tail flush per session across
                    # all triggers, and a bounded WAIT when another claimed it.
                    await self._run_tail_flush(session, preprocessor)
                    await self._finalize_session(session)
                except Exception as exc:
                    logger.error(
                        "Control finalize failed; forcing session removal",
                        session_id=session.session_id,
                        error=str(exc),
                    )
                    await self.remove_session(session.session_id)
            elif control.action == ControlAction.CANCEL:
                await self._cancel_session(session)
            elif control.action == ControlAction.SWITCH_TO_FALLBACK:
                # User-initiated mid-session switch. The
                # control frame's ``target`` names the engine to switch to
                # (``'fallback'`` by default; ``'primary'`` switches back). Same
                # seamless swap as the auto-outage path.
                controller = self._switch_controllers.get(session.session_id)
                if controller is None or not controller.has_fallback:
                    logger.info(
                        "Manual switch requested but no fallback configured; ignoring",
                        session_id=session.session_id,
                    )
                    return
                try:
                    await controller.switch_manual(
                        control.target, utterance_index=session.utterance_count
                    )
                except Exception as exc:
                    logger.error(
                        "Manual engine switch failed; staying on current engine",
                        session_id=session.session_id,
                        target=control.target,
                        error=str(exc),
                    )
            elif control.action in (ControlAction.PAUSE, ControlAction.RESUME):
                # PAUSE/RESUME have no backend implementation
                # (the SDK halts audio at the source; only finalize/cancel reach
                # here). Reject the frame LOUDLY rather than silently swallowing it
                # as a no-op log: publish a client-visible error to the result
                # stream so a future client that sends a backend PAUSE/RESUME fails
                # visibly instead of assuming the session paused. Real pause/resume
                # semantics are deferred to a follow-up control-frame effort;
                # this only makes the current unsupported case honest.
                logger.warning(
                    "Unsupported control action rejected",
                    session_id=session.session_id,
                    action=control.action.value,
                )
                publisher = self._publishers.get(session.session_id)
                if publisher:
                    await publisher.publish_error(
                        f"Control action '{control.action.value}' is not supported by the streaming backend"
                    )
            else:
                logger.warning(
                    "Unknown control action",
                    session_id=session.session_id,
                    action=control.action.value,
                )

        return _on_control

    async def _run_inline_inference(
        self,
        session: StreamSession,
        utterance: AudioUtterance,
    ) -> None:
        """Run ASR inference inline (fallback when queue is unavailable)."""
        worker = self._inference_workers.get(session.session_id)
        if worker is None:
            logger.warning(
                "No inference worker for inline fallback",
                session_id=session.session_id,
            )
            return
        try:
            result = await worker.process_utterance(session.session_id, utterance)
            session.add_result(result)
            session.utterance_count = utterance.utterance_index + 1
            if result.is_final:
                self._check_final_handover(session.session_id, result.text)
        except Exception as exc:
            logger.warning(
                "Inline inference failed",
                session_id=session.session_id,
                error=str(exc),
            )

    def _begin_tail_flush(self, session_id: str) -> tuple[bool, asyncio.Event]:
        """Claim the one-and-only tail flush/drain for ``session_id``.

        F-32. ``_flush_final_utterance`` + ``_drain_inference_queue`` run before
        (and therefore outside) the per-session finalize lock at all four
        trigger sites — ``end_session``, the final audio frame, the control
        ``FINALIZE`` command and the idle reaper. Two of them racing both
        flushed the preprocessor tail and both drained the queue, so the closing
        utterance could be transcribed and published twice.

        This is a test-and-set with NO ``await`` between the membership check and
        the insert: the asyncio event loop is single-threaded, so the pair is
        atomic with respect to every other coroutine.

        TASK-985 M-04 — it returns ``(owned, done_event)``, not a bare bool.
        ``owned`` is the unchanged F-32 mutual exclusion: exactly one caller
        flushes and drains, and it MUST ``done_event.set()`` in a ``finally``.
        ``done_event`` is the part F-32 lacked — a HAPPENS-BEFORE edge. Every
        later trigger awaits it (bounded, via :meth:`_await_tail_flush`) before
        finalizing, because ``False`` used to be read as "the tail is done" when
        it only ever meant "someone else started it". Under that reading the
        later trigger published the terminal ``closed`` status, built
        ``transcript.json`` and called ``remove_session`` — which cancels the
        inference loop and with it the tail decode still running inside the
        first trigger. The closing utterance was lost from the captions, the
        transcript and the durable record, while the billed audio seconds were
        unaffected.

        Both entries are dropped in ``remove_session`` alongside the finalize
        lock.
        """
        existing = self._tail_flush_done.get(session_id)
        if existing is not None:
            logger.info(
                "Tail flush already claimed for this session; waiting for it to "
                "complete before finalizing",
                session_id=session_id,
                already_done=existing.is_set(),
            )
            return (False, existing)
        event = asyncio.Event()
        self._tail_flush_done[session_id] = event
        return (True, event)

    async def _await_tail_flush(self, session_id: str, tail_done: asyncio.Event) -> bool:
        """Wait (bounded, non-fatal) for another trigger's tail flush + drain.

        Returns ``True`` when the tail completed, ``False`` on timeout.

        BOUNDED and NON-FATAL by design. A wedged teardown holds a GPU slot,
        a model pin and a capacity slot for the life of the process, which is a
        strictly worse outcome than one lost tail utterance — so a timeout logs
        at ERROR and lets the caller finalize anyway.

        Note for the ``_on_frame`` caller: this runs on the single ingestion
        dispatch loop, so while it waits the consumer stops XACK'ing
        ``stt:audio``. Under the in-band terminal-frame design (M-29) the frame
        that brought us here is the LAST entry on that stream, so there is
        nothing left to starve; the bound caps the pathological case regardless.
        """
        if tail_done.is_set():
            return True
        try:
            await asyncio.wait_for(tail_done.wait(), timeout=self._tail_wait_timeout_s)
            return True
        except TimeoutError:
            # L-OBS request: `stt_stream_tail_wait_timeout_total`. Until that
            # counter exists this ERROR is the only signal, so it carries the
            # bound it exceeded rather than just naming the session.
            logger.error(
                "stt.stream.tail_wait_timeout",
                session_id=session_id,
                timeout_s=self._tail_wait_timeout_s,
            )
            return False

    async def _run_tail_flush(
        self,
        session: StreamSession,
        preprocessor: StreamingPreprocessor | None,
    ) -> None:
        """The tail flush + drain, claimed once and awaited by every other trigger.

        TASK-985 M-04 — the ONE body all four finalize triggers share, so the
        latch protocol cannot be half-implemented at one of them. A fifth
        trigger added later gets the invariant by calling this instead of
        re-deriving it.

        ``finally: set()`` is the deadlock guard, not tidiness:
        ``_flush_final_utterance`` swallows its own exceptions but
        ``_drain_inference_queue`` does not, and the reaper must always be able
        to finish.
        """
        session_id = session.session_id
        owned, tail_done = self._begin_tail_flush(session_id)
        if owned:
            try:
                await self._flush_final_utterance(session=session, preprocessor=preprocessor)
                await self._drain_inference_queue(session_id)
            finally:
                tail_done.set()
        else:
            await self._await_tail_flush(session_id, tail_done)

    async def _flush_final_utterance(
        self,
        session: StreamSession,
        preprocessor: StreamingPreprocessor | None,
    ) -> None:
        """Flush preprocessor and enqueue any remaining audio for inference."""
        if preprocessor is None:
            return

        try:
            final_utt = await preprocessor.flush()

            remaining_pcm = preprocessor.drain_processed_samples()
            if remaining_pcm:
                session.processed_audio_buffer.extend(remaining_pcm)
                if session.processed_sample_rate is None:
                    session.processed_sample_rate = preprocessor.target_sample_rate

            if final_utt is None:
                return

            # Flushed final closes the current utterance
            self._reset_commit_policy(session.session_id)

            queue = self._inference_queues.get(session.session_id)
            if queue is not None:
                try:
                    await asyncio.wait_for(
                        queue.put(final_utt), timeout=self._inference_stop_timeout_s
                    )
                except TimeoutError:
                    logger.warning(
                        "Timed out enqueueing final utterance; falling back to inline",
                        session_id=session.session_id,
                        timeout_s=self._inference_stop_timeout_s,
                    )
                    await self._run_inline_inference(session, final_utt)
            else:
                logger.warning(
                    "Inference queue gone; falling back to inline",
                    session_id=session.session_id,
                )
                await self._run_inline_inference(session, final_utt)
        except Exception as exc:
            logger.warning(
                "Failed to flush final utterance during finalization",
                session_id=session.session_id,
                error=str(exc),
            )

    def _get_blob_service(self) -> BlobService:
        """Lazy-init BlobService singleton."""
        if self._blob_service is None:
            self._blob_service = BlobService()
        return self._blob_service

    def _get_api_client(self) -> Any:
        """Lazy accessor for the API Gateway client (overridable in tests)."""
        from stt.core.api_client.gateway import get_api_client

        return get_api_client()

    def _resolve_dual_capture(self, pipeline_config: Any) -> DualCaptureConfig:
        """Resolve effective dual-capture flags from a pipeline config.

        ``capture_raw`` requires ``preprocessing.dual_capture`` to be enabled;
        ``capture_processed`` requires ``postprocessing.dual_capture``. Strict
        ``is True`` checks avoid a MagicMock pipeline config (unit tests)
        accidentally enabling capture. ``enabled`` is the OR of the two.
        """
        if pipeline_config is None:
            return DualCaptureConfig()
        try:
            pre = pipeline_config.preprocessing.dual_capture
            post = pipeline_config.postprocessing.dual_capture
            capture_raw = (
                getattr(pre, "enabled", False) is True
                and getattr(pre, "capture_raw", False) is True
            )
            capture_processed = (
                getattr(post, "enabled", False) is True
                and getattr(post, "capture_processed", False) is True
            )
        except Exception:
            return DualCaptureConfig()
        return DualCaptureConfig(
            enabled=capture_raw or capture_processed,
            capture_raw=capture_raw,
            capture_processed=capture_processed,
        )

    async def _register_dual_capture(
        self,
        session: StreamSession,
        raw_audio_uri: str | None,
        processed_audio_uri: str | None,
    ) -> None:
        """Register dual-capture Media + AudioRecording for a finalized session.

        The raw/processed WAVs are already uploaded to object storage; this
        creates the corresponding ``Media`` rows and an ``AudioRecording``
        carrying ``rawMediaId``/``processedMediaId`` against the consultation.

        No-op unless the pipeline opted in *and* the relevant WAV(s) were
        produced. Requires a ``consultation_id`` on the session (resolved from
        the streaming-start handshake) to attach the recording. All failures
        are logged and swallowed so finalization is never blocked.
        """
        settings = self._dual_capture.get(session.session_id)
        if settings is None or not settings.enabled:
            return

        capture_raw = bool(settings.capture_raw and raw_audio_uri)
        capture_processed = bool(settings.capture_processed and processed_audio_uri)
        if not capture_raw and not capture_processed:
            return

        consultation_id = session.consultation_id
        if not consultation_id:
            logger.warning(
                "dual_capture enabled but session has no consultation_id; "
                "skipping media registration",
                session_id=session.session_id,
            )
            return

        try:
            gateway = self._get_api_client()
            created_by = getattr(session.metadata, "user_id", None)

            raw_media_id: str | None = None
            processed_media_id: str | None = None

            if capture_raw:
                raw_media = await gateway.create_media(
                    tenant_id=session.tenant_id,
                    name=f"{session.session_id}-raw.wav",
                    uri=raw_audio_uri,
                    extension="wav",
                    mime_type="audio/wav",
                    size=len(session.audio_buffer),
                    hash="",
                    created_by=created_by,
                )
                raw_media_id = (raw_media or {}).get("id") or (raw_media or {}).get("mediaId")

            if capture_processed:
                processed_media = await gateway.create_media(
                    tenant_id=session.tenant_id,
                    name=f"{session.session_id}-processed.wav",
                    uri=processed_audio_uri,
                    extension="wav",
                    mime_type="audio/wav",
                    size=len(session.processed_audio_buffer),
                    hash="",
                    created_by=created_by,
                )
                processed_media_id = (processed_media or {}).get("id") or (
                    processed_media or {}
                ).get("mediaId")

            primary_media_id = processed_media_id or raw_media_id
            await gateway.create_audio_recording(
                media_id=primary_media_id,
                tenant_id=session.tenant_id,
                consultation_id=consultation_id,
                raw_media_id=raw_media_id,
                processed_media_id=processed_media_id,
                sample_rate=session.sample_rate,
                duration_ms=int(round(session.total_duration_seconds * 1000)),
            )

            logger.info(
                "Dual-capture media registered",
                session_id=session.session_id,
                consultation_id=consultation_id,
                raw_media_id=raw_media_id,
                processed_media_id=processed_media_id,
            )
        except Exception as exc:
            logger.error(
                "Failed to register dual-capture media (non-fatal)",
                session_id=session.session_id,
                error=str(exc),
            )

    async def _persist_streaming_transcript(self, session: StreamSession) -> None:
        """Persist a streaming-session transcript as a TRANSCRIPT context item.

        Streaming sessions have no TranscriptionJob, so the
        transcript is keyed directly to the consultation (+ tenant). Persisting
        it fires ``TranscriptionCreated`` on the API side, which triggers the
        harness auto-draft pipeline. The streaming path is deduped server-side by
        ``consultationId`` (an existing transcript is returned without
        re-creating the row or re-emitting the event), so retrying a failed POST
        is safe; a forward-compatible ``Idempotency-Key`` is also sent.

        Unlike the best-effort audio/metadata uploads, this
        transcript is the durable clinical system of record AND the sole harness
        trigger, so a transient gateway blip must NOT lose it:

        * retried up to ``_transcript_persist_max_attempts`` inline with a
          scaling backoff;
        * a PERMANENT (4xx) failure is dropped immediately with a loud alert —
          retrying a client error is futile;
        * a TRANSIENT failure that exhausts the inline retries is enqueued to the
          shared Redis outbox for the reaper (any worker) to re-drive.

        Finalize always proceeds to close + release capacity regardless — the
        durable outbox, not a retained session, carries the durability, so a
        worker never leaks its capacity slot on a gateway outage.
        """
        consultation_id = session.consultation_id
        if not consultation_id:
            logger.warning(
                "streaming finalize has no consultation_id; skipping transcript persistence",
                session_id=session.session_id,
            )
            return

        transcript_text = session.build_transcript_text()
        if not transcript_text:
            logger.info(
                "streaming finalize produced no final transcript text; skipping persistence",
                session_id=session.session_id,
                consultation_id=consultation_id,
            )
            return

        # Build the segments alongside the text, from the SAME
        # results, so the harness evidence chain has per-utterance provenance
        # (timing, speaker, char spans). Before this the streaming path sent text
        # only and TranscriptSegment was empty in production.
        segments = session.build_transcript_segments()

        idempotency_key = self._transcript_idempotency_key(session)
        attempts = self._transcript_persist_max_attempts
        last_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                gateway = self._get_api_client()
                result = await gateway.create_transcript(
                    transcript_text=transcript_text,
                    consultation_id=consultation_id,
                    tenant_id=session.tenant_id,
                    transcription_source="streaming",
                    idempotency_key=idempotency_key,
                    segments=segments,
                )
                logger.info(
                    "Streaming transcript persisted",
                    session_id=session.session_id,
                    consultation_id=consultation_id,
                    context_item_id=(result or {}).get("contextItemId"),
                    attempt=attempt,
                )
                return
            except Exception as exc:
                last_error = exc
                if self._is_permanent_persist_error(exc):
                    logger.error(
                        "stt.transcript.persist_permanent_drop — permanent (4xx) "
                        "error persisting streaming transcript; dropping "
                        "(retry is futile)",
                        session_id=session.session_id,
                        consultation_id=consultation_id,
                        error=str(exc),
                    )
                    return
                logger.warning(
                    "Failed to persist streaming transcript; will retry",
                    session_id=session.session_id,
                    consultation_id=consultation_id,
                    attempt=attempt,
                    max_attempts=attempts,
                    error=str(exc),
                )
                if attempt < attempts and self._transcript_persist_backoff_s > 0:
                    await asyncio.sleep(self._transcript_persist_backoff_s * attempt)

        # Transient failure exhausted the inline retries → durable Redis outbox.
        await self._enqueue_transcript_outbox(
            session, transcript_text, segments, idempotency_key, last_error
        )

    @staticmethod
    def _transcript_idempotency_key(session: StreamSession) -> str:
        """Stable per-session-transcript idempotency key (consultation + session).

        Shared by the inline persist and the outbox re-drive so the gateway can
        dedup them once it honors the ``Idempotency-Key`` header.
        """
        return f"{session.consultation_id}:{session.session_id}"

    @staticmethod
    def _is_permanent_persist_error(exc: Exception) -> bool:
        """True for a non-retryable 4xx client error.

        The retryable 4xx back-off signals — 408 (Request Timeout), 425 (Too
        Early) and 429 (Too Many Requests) — are TRANSIENT: the internal
        transcript route is throttled, so an end-of-clinic burst / pod drain that
        finalizes many sessions at once can legitimately return 429, and dropping
        it there would silently lose the clinical system-of-record. 5xx, timeouts
        and connection errors carry no 4xx status and are transient too.
        """
        details = getattr(exc, "details", None)
        status = details.get("status_code") if isinstance(details, dict) else None
        return isinstance(status, int) and 400 <= status < 500 and status not in _RETRYABLE_4XX

    async def _enqueue_transcript_outbox(
        self,
        session: StreamSession,
        transcript_text: str,
        segments: list[dict[str, Any]],
        idempotency_key: str,
        last_error: Exception | None,
    ) -> None:
        """Durably enqueue a transient-failed transcript to the shared outbox."""
        payload = {
            "transcript_text": transcript_text,
            "consultation_id": session.consultation_id,
            "tenant_id": session.tenant_id,
            "transcription_source": "streaming",
            "idempotency_key": idempotency_key,
            "attempts": 0,
            # Segments ride along so the reaper's re-drive persists
            # the SAME provenance the inline attempt would have. The session object
            # is long gone by then; if they were not stored here, every outboxed
            # transcript would land segment-less and starve evidence grounding.
            "segments": segments,
        }
        try:
            await self._redis.hset(TRANSCRIPT_OUTBOX_KEY, idempotency_key, json.dumps(payload))
            logger.error(
                "stt.transcript.outbox_enqueued — transcript persistence failed "
                "after inline retries; enqueued to the durable outbox for reaper "
                "re-drive",
                session_id=session.session_id,
                consultation_id=session.consultation_id,
                idempotency_key=idempotency_key,
                error=str(last_error),
            )
        except Exception as exc:
            logger.error(
                "stt.transcript.outbox_enqueue_failed — could not enqueue "
                "transcript to the durable outbox (DURABLE LOSS RISK)",
                session_id=session.session_id,
                consultation_id=session.consultation_id,
                idempotency_key=idempotency_key,
                enqueue_error=str(exc),
                persist_error=str(last_error),
            )

    async def _drain_transcript_outbox(self) -> None:
        """Re-drive durable-outbox transcripts.

        Called from the reaper loop. The outbox is at-LEAST-once: an entry
        is NEVER deleted before a confirmed 2xx, so a worker crash mid-POST
        leaves it re-drivable by any worker's later scan. A short soft lease
        (``OUTBOX_LEASE_TTL_S``) is stamped while a worker re-drives an entry so
        concurrent workers skip it (fewer duplicate POSTs); a crashed worker's
        lease simply expires and the entry is re-claimed. Duplicate deliveries
        are harmless — the idempotency key + server-side ``consultationId`` dedup
        never double-write or re-fire the harness. Fully self-guarded.
        """
        try:
            entries = await self._redis.hgetall(TRANSCRIPT_OUTBOX_KEY)
            if not isinstance(entries, dict) or not entries:
                return
            now = time.time()
            for field, raw in list(entries.items()):
                field_key = field.decode() if isinstance(field, bytes) else field
                raw_value = raw.decode() if isinstance(raw, bytes) else raw
                try:
                    payload = json.loads(raw_value)
                except (ValueError, TypeError):
                    await self._redis.hdel(TRANSCRIPT_OUTBOX_KEY, field_key)
                    logger.error(
                        "stt.transcript.outbox_corrupt_drop — dropping unparseable outbox entry",
                        idempotency_key=field_key,
                    )
                    continue
                lease_expiry = payload.get("lease_expiry", 0)
                if isinstance(lease_expiry, int | float) and lease_expiry > now:
                    continue  # another worker holds a fresh lease → skip
                await self._redrive_outbox_entry(field_key, payload, now)
        except Exception as exc:
            logger.warning(
                "stt.transcript.outbox_drain_error — outbox drain scan failed",
                error=str(exc),
            )

    async def _redrive_outbox_entry(
        self, field_key: str, payload: dict[str, Any], now: float
    ) -> None:
        """Re-drive one outbox transcript, at-least-once.

        Stamps a soft lease and persists it BEFORE the POST (so the entry
        survives a crash and concurrent workers skip it), then removes the entry
        ONLY after a confirmed 2xx. A transient failure keeps the entry (lease
        released, ``attempts`` bumped) for the next scan; a permanent (4xx) error
        or exhausted attempts drop it with a loud alert.
        """
        idempotency_key = payload.get("idempotency_key") or field_key
        consultation_id = payload.get("consultation_id")

        # Claim: stamp + persist a lease BEFORE the POST. Never a delete here.
        payload["processing_by"] = self._worker_id
        payload["lease_expiry"] = now + OUTBOX_LEASE_TTL_S
        try:
            await self._redis.hset(TRANSCRIPT_OUTBOX_KEY, field_key, json.dumps(payload))
        except Exception as exc:
            logger.warning(
                "stt.transcript.outbox_claim_failed — could not stamp outbox lease; "
                "leaving entry for the next scan",
                idempotency_key=idempotency_key,
                error=str(exc),
            )
            return

        try:
            gateway = self._get_api_client()
            await gateway.create_transcript(
                transcript_text=payload.get("transcript_text", ""),
                consultation_id=consultation_id,
                tenant_id=payload.get("tenant_id"),
                transcription_source=payload.get("transcription_source", "streaming"),
                idempotency_key=idempotency_key,
                # Replay the stored segments. Entries enqueued
                # before this key existed simply have none (`.get` → None), which
                # degrades to text-only behaviour rather than raising.
                segments=payload.get("segments"),
            )
        except Exception as exc:
            await self._defer_or_drop_outbox_entry(
                field_key, payload, idempotency_key, consultation_id, exc
            )
            return

        # Confirmed 2xx → NOW it is safe to remove the entry (delete-after-ack).
        try:
            await self._redis.hdel(TRANSCRIPT_OUTBOX_KEY, field_key)
        except Exception as exc:
            logger.warning(
                "stt.transcript.outbox_ack_delete_failed — transcript persisted but "
                "outbox entry not removed; a later redrive will dedup server-side",
                idempotency_key=idempotency_key,
                error=str(exc),
            )
        logger.info(
            "stt.transcript.outbox_drained — durable transcript persisted from outbox",
            consultation_id=consultation_id,
            idempotency_key=idempotency_key,
            attempts=int(payload.get("attempts", 0)),
        )

    async def _defer_or_drop_outbox_entry(
        self,
        field_key: str,
        payload: dict[str, Any],
        idempotency_key: str,
        consultation_id: Any,
        exc: Exception,
    ) -> None:
        """Handle a failed outbox redrive: drop (permanent / exhausted) or keep.

        Keeps the invariant "delete only after a confirmed 2xx": a transient
        failure retains the entry (never deletes it), so a crash cannot lose it.
        """
        if self._is_permanent_persist_error(exc):
            try:
                await self._redis.hdel(TRANSCRIPT_OUTBOX_KEY, field_key)
            except Exception:
                pass
            logger.error(
                "stt.transcript.outbox_permanent_drop — permanent (4xx) error; "
                "dropping transcript from the outbox",
                consultation_id=consultation_id,
                idempotency_key=idempotency_key,
                error=str(exc),
            )
            return

        attempts = int(payload.get("attempts", 0)) + 1
        if attempts >= self._transcript_outbox_max_attempts:
            try:
                await self._redis.hdel(TRANSCRIPT_OUTBOX_KEY, field_key)
            except Exception:
                pass
            logger.error(
                "stt.transcript.outbox_exhausted_drop — transcript dropped after max "
                "outbox attempts (ALERT: durable transcript lost)",
                consultation_id=consultation_id,
                idempotency_key=idempotency_key,
                attempts=attempts,
                error=str(exc),
            )
            return

        # Transient → keep the entry (delete only after 2xx). Release the lease
        # and bump attempts so the next scan re-drives it.
        payload["attempts"] = attempts
        payload["lease_expiry"] = 0
        payload["processing_by"] = None
        try:
            await self._redis.hset(TRANSCRIPT_OUTBOX_KEY, field_key, json.dumps(payload))
            logger.warning(
                "stt.transcript.outbox_retry_deferred — transient error; entry "
                "retained for re-drive on the next reaper scan",
                consultation_id=consultation_id,
                idempotency_key=idempotency_key,
                attempts=attempts,
                error=str(exc),
            )
        except Exception as re_exc:
            logger.error(
                "stt.transcript.outbox_reenqueue_failed — could not update outbox "
                "entry; it remains re-drivable at its prior attempt count",
                consultation_id=consultation_id,
                idempotency_key=idempotency_key,
                error=str(re_exc),
            )

    async def _finalize_session(
        self, session: StreamSession, *, stash_summary: bool = True
    ) -> dict[str, Any] | None:
        """Finalize a session under a per-session lock.

        ``stash_summary`` — TASK-985 M-23. ``False`` for the HTTP ``end_session``
        caller, which RETURNS the summary to the gateway and is therefore the
        one that emits the ledger row. Every other finalizer (the final audio
        frame, the control ``FINALIZE``, the idle reaper) has nobody to return
        it to, so it stashes it for the DELETE that is still coming.

        The four finalize entrypoints (``end_session``, the final audio frame,
        the control-FINALIZE command, and the reaper) can race; without
        serialization two of them both reach the upload + ``create_media`` block
        and duplicate the ``Media`` rows / re-upload the blob. The lock makes
        them run one at a time, and the ``CLOSED`` short-circuit inside makes the
        second entrant an idempotent no-op — including for the
        teardown summary: only the entrant that actually closed the session
        returns one, so at most one HTTP caller ever attempts ledger emission
        for a given teardown (the unique idempotency key would dedup a second
        attempt anyway, but this avoids even trying).
        """
        # Get-or-create without allocating a throwaway Lock on every call (the
        # get/create is atomic — no await between the get and the assignment).
        lock = self._finalize_locks.get(session.session_id)
        if lock is None:
            lock = asyncio.Lock()
            self._finalize_locks[session.session_id] = lock
        async with lock:
            return await self._finalize_session_locked(session, stash_summary=stash_summary)

    def _compute_session_seconds(self, session: StreamSession) -> float:
        """Wall-clock socket open->close seconds (``created_at`` -> ``closed_at``).

        Both are ``datetime.utcnow().isoformat()`` stamps (see ``session.py``),
        so a bare ``fromisoformat`` diff is exact. Never raises: an unparsable
        or missing ``closed_at`` (should not happen — ``close()`` always sets
        it before this is called) degrades to ``0.0`` rather than blocking
        teardown over a metering computation.
        """
        closed_at = session.metadata.closed_at
        if not closed_at:
            return 0.0
        try:
            delta = datetime.fromisoformat(closed_at) - datetime.fromisoformat(session.created_at)
            return max(0.0, delta.total_seconds())
        except (ValueError, TypeError):
            logger.warning(
                "streaming.teardown_summary.session_seconds_unparsable",
                session_id=session.session_id,
                created_at=session.created_at,
                closed_at=closed_at,
            )
            return 0.0

    def _build_teardown_summary(self, session: StreamSession) -> dict[str, Any]:
        """The usage-attribution summary returned on teardown.

        STT has no notion of "interrupted" — that is entirely a GATEWAY-side
        concept (which code path called ``removeSession``: an explicit close
        vs. the resume-grace window expiring). This summary is IDENTICAL
        either way; the caller decides ``attributesJson.interrupted``.

        ``engine``/``deployment``/``connection_id`` are ``None`` when no ASR model was
        ever resolved for this session (e.g. it failed before load) — never
        guessed, exactly like the batch path's ``resolve_usage_attribution``
        (which this reuses, so the two can never drift on the AZURE_SPEECH
        spelling trap or any other provider mapping).

        TASK-958 — ``connection_id`` names WHICH of the tenant's connections for that
        engine served. This SCALAR is the connection the ACTIVE ASR model authenticates
        as, so a session that switched engines reports the last one — the same reading
        as ``engine``/``deployment`` beside it. The per-span rows below do NOT inherit
        it: each span carries the pair recorded when its own engine was loaded or
        switched in (TASK-958 G3), so a session that failed over from a platform-funded
        primary to a tenant sibling bills one ``CLOUD`` row and one ``BYOK`` row on
        their own accounts, and two connections of ONE vendor are two rows even though
        they share an ASR format.

        ``segments`` is the TASK-874 per-engine breakdown: one entry per
        ``(engine, deployment, connection_id)`` triple that actually served, each with its own
        audio and wall-clock seconds, so a session that failed over to the
        platform fallback bills BOTH engines for the time each ran instead of
        billing all of it to whichever finished. It is ADDITIVE — the scalars
        above are unchanged, so an un-upgraded gateway meters exactly as before
        — and its entries sum to ``audio_seconds``/``session_seconds`` exactly.
        """
        from stt.core.metrics import record_streaming_teardown
        from stt.transcription.batch_service import resolve_usage_attribution

        overrides = self._provider_overrides.get(session.session_id)
        asr_format = self._session_asr_formats.get(session.session_id)
        connection_key, connection_id_hint = self._session_connections.get(
            session.session_id, (None, None)
        )

        def _attribute(
            fmt: Any, connection: tuple[str | None, str | None] | None = None
        ) -> tuple[str, str, str | None]:
            """Attribute ONE span (or the summary's own scalars, with no span).

            TASK-958 G3 — ``connection`` is the span's OWN recorded pair. The
            session-level stamp applies only when a span recorded none: it names
            whichever engine loaded LAST, so using it for every span billed a
            platform-funded primary leg to the tenant sibling a failover ended on,
            funding included (the entry is read under the DECLARED key).
            """
            pair = connection if connection is not None else (connection_key, connection_id_hint)
            span_key, span_id = pair
            return resolve_usage_attribution(
                fmt,
                overrides,
                connection_key=span_key,
                connection_id=span_id,
            )

        engine: str | None = None
        deployment: str | None = None
        connection_id: str | None = None
        if asr_format is not None:
            engine, deployment, connection_id = _attribute(asr_format)

        audio_seconds = session.total_duration_seconds
        session_seconds = self._compute_session_seconds(session)

        # `cumulative_processing_seconds` is the per-utterance ASR-only time this
        # session's inference worker accumulated (see `StreamingInferenceWorker`);
        # 0.0 (never having had a worker) is a safe default. It feeds the RTF
        # metric below AND — TASK-959 — the per-engine compute rows: the segments
        # are anchored to it, so they can never sum to something other than the
        # figure reported here.
        worker = self._inference_workers.get(session.session_id)
        processing_seconds = worker.cumulative_processing_seconds if worker is not None else 0.0
        # TASK-959 — the device is a per-PROCESS property (this profile's ASR
        # device), normalised once; `segment_device` then gives a cloud segment
        # `cpu` regardless, since what it occupied here is this service waiting.
        local_device = normalize_device(self._profile.asr_device)

        accumulator = self._session_usage_segments.get(session.session_id)
        if accumulator is not None:
            segments = [
                segment.to_dict()
                for segment in accumulator.close(
                    audio_seconds=audio_seconds,
                    total_audio_seconds=audio_seconds,
                    total_session_seconds=session_seconds,
                    total_processing_seconds=processing_seconds,
                    counters=self._session_usage_counters(session.session_id),
                    device=local_device,
                    resolve=_attribute,
                )
            ]
        elif engine is not None and deployment is not None:
            # No accumulator: a RECOVERED session (crash restart), which builds
            # no switch controller and so cannot change engines. One segment
            # equal to the whole session is exact, not a degradation. Built
            # through `UsageSegment` rather than by hand so this branch cannot
            # drift from the accumulator's shape as fields are added to it.
            counters = self._session_usage_counters(session.session_id)
            has_bytes = counters.byte_source is not None
            segments = [
                UsageSegment(
                    engine=engine,
                    deployment=deployment,
                    audio_seconds=audio_seconds,
                    session_seconds=session_seconds,
                    connection_id=connection_id,
                    processing_seconds=processing_seconds,
                    device=segment_device(deployment, local_device),
                    request_bytes=counters.request_bytes if has_bytes else None,
                    response_bytes=counters.response_bytes if has_bytes else None,
                    byte_source=counters.byte_source,
                ).to_dict()
            ]
        else:
            segments = []

        # The streaming audio-duration histogram + real-time
        # factor the current-state review flagged as missing (batch has
        # stt_audio_duration_seconds; streaming had neither a duration signal
        # in Prometheus nor an RTF at all). Labels bounded to
        # {pipeline, engine, status} — no tenant label.
        record_streaming_teardown(
            pipeline=session.pipeline_id,
            engine=engine or "unknown",
            status="closed",
            audio_seconds=audio_seconds,
            processing_seconds=processing_seconds,
        )

        return {
            "session_id": session.session_id,
            # TASK-935 — corrections the lexicon stage applied this session (partials + finals).
            "lexicon_correction_count": (
                worker.lexicon_correction_count if worker is not None else 0
            ),
            "tenant_id": session.tenant_id,
            "consultation_id": session.consultation_id,
            "user_id": session.metadata.user_id,
            "pipeline_id": session.pipeline_id,
            # `closed_at` is the ledger event's `occurredAt` — falls back to
            # "now" only in the defensive case `close()` somehow left it unset
            # (should not happen; never worth blocking teardown over).
            "closed_at": session.metadata.closed_at or datetime.utcnow().isoformat(),
            "audio_seconds": audio_seconds,
            "session_seconds": session_seconds,
            "engine": engine,
            "deployment": deployment,
            # TASK-958 — WHICH connection of that engine was spent. `None` when the
            # gateway stamped none; never guessed from `engine`, which a tenant's two
            # accounts of one vendor share.
            "connection_id": connection_id,
            "segments": segments,
            "language_mode": self._session_language_modes.get(session.session_id),
            "channel_count": self._session_channel_counts.get(session.session_id, 1),
        }

    async def _finalize_session_locked(
        self, session: StreamSession, *, stash_summary: bool = True
    ) -> dict[str, Any] | None:
        """Finalize a session — mark finalizing, close out the live stream, upload, clean up.

        Callers must drain the inference queue *before* calling this
        method so that all utterances have been transcribed. Always invoked
        under the per-session finalize lock (see ``_finalize_session``).

        Ordering contract::

            drain (caller) -> last transcript published -> status 'closed'
                           -> MinIO uploads -> dual capture -> durable transcript
                           -> session.close -> remove_session

        ``closed`` is the TERMINAL status: the gateway's result subscription
        COMPLETES on it and drops anything published afterwards. It is therefore
        published as soon as the live caption stream is genuinely finished —
        every final is already on the stream (all four finalize entrypoints
        drain first) and any in-flight partial is cancelled immediately before
        the publish. Everything after it is server-side durability work the
        client never needed to wait for; blocking the terminal status on a slow
        MinIO round-trip is what made the SDK's stop-drain burn its full timeout.
        """
        # Once a session is closed, re-finalizing is a no-op.
        if session.status == SessionStatus.CLOSED:
            return None

        # TASK-985 M-04 — the invariant this method's own docstring asserts
        # ("callers must drain the inference queue BEFORE calling this
        # method"), enforced HERE as well as at the four callers.
        #
        # The callers all go through `_run_tail_flush`, so in practice this is
        # already satisfied on entry. It is repeated at the sink because this is
        # the method that states the contract and the one whose violation is
        # expensive: everything below — the terminal `closed` status the
        # gateway's caption subscription COMPLETES on, `build_transcript_json`,
        # the durable persist, `remove_session` — is unrecoverable once run. A
        # fifth finalize trigger added later inherits the guarantee instead of
        # having to remember it.
        #
        # An absent latch entry means NOBODY claimed a tail for this session
        # (e.g. a recovered session finalized before any trigger ran), so there
        # is nothing to wait for and no reason to block.
        tail_done = self._tail_flush_done.get(session.session_id)
        if tail_done is not None and not tail_done.is_set():
            await self._await_tail_flush(session.session_id, tail_done)

        publisher = self._publishers.get(session.session_id)
        raw_audio_uri: str | None = None
        processed_audio_uri: str | None = None
        transcript_uri: str | None = None
        closed_published = False
        teardown_summary: dict[str, Any] | None = None

        try:
            if session.status == SessionStatus.ACTIVE:
                await session.finalize()

                # Publish status update
                if publisher:
                    await publisher.publish_status("finalizing")

            # ---- Terminal status, published BEFORE the durability work ----
            # A partial is an interim caption for an utterance whose final is
            # already published; cancelling it here is what makes "no transcript
            # after `closed`" an ordering GUARANTEE rather than a race.
            # ``remove_session`` cancels again (idempotent).
            self._cancel_partial(session.session_id)
            if publisher:
                try:
                    await publisher.publish_status("closed")
                    closed_published = True
                except Exception as exc:
                    # Non-fatal: the ``finally`` block re-publishes after
                    # ``session.close()``, so the client still gets a terminal
                    # status (just on the old, late timeline).
                    logger.error(
                        "Failed to publish early 'closed' status; will retry after close",
                        session_id=session.session_id,
                        error=str(exc),
                    )

            # Upload audio + transcript + metadata
            has_processed = len(session.processed_audio_buffer) > 0
            has_raw = len(session.audio_buffer) > 0

            if has_raw or has_processed:
                blob = self._get_blob_service()

                # Upload any remaining raw PCM chunk
                if has_raw:
                    raw_offset = self._chunk_offsets.get(session.session_id, 0)
                    if raw_offset < len(session.audio_buffer):
                        try:
                            remaining = bytes(session.audio_buffer[raw_offset:])
                            chunk_idx = self._chunk_indices.get(session.session_id, 0)
                            await blob.upload_streaming_raw_chunk(
                                chunk_bytes=remaining,
                                tenant_id=session.tenant_id,
                                session_id=session.session_id,
                                chunk_index=chunk_idx,
                            )
                            self._chunk_indices[session.session_id] = chunk_idx + 1
                        except Exception as exc:
                            logger.error(
                                "Failed to upload remaining raw PCM chunk (non-fatal)",
                                session_id=session.session_id,
                                error=str(exc),
                            )

                # Upload raw complete WAV (always — browser PCM, no server processing)
                if has_raw:
                    try:
                        raw_wav_bytes = session.encode_wav()
                        raw_audio_uri = await blob.upload_streaming_raw_complete(
                            wav_bytes=raw_wav_bytes,
                            tenant_id=session.tenant_id,
                            session_id=session.session_id,
                        )
                    except Exception as exc:
                        logger.error(
                            "Failed to upload raw complete WAV (non-fatal)",
                            session_id=session.session_id,
                            error=str(exc),
                        )

                # Upload processed complete WAV (post-preprocess) when available
                if has_processed:
                    try:
                        processed_wav_bytes = session.encode_wav(
                            audio_data=bytes(session.processed_audio_buffer),
                            sample_rate=session.processed_sample_rate,
                        )
                        processed_audio_uri = await blob.upload_streaming_processed_complete(
                            wav_bytes=processed_wav_bytes,
                            tenant_id=session.tenant_id,
                            session_id=session.session_id,
                        )
                    except Exception as exc:
                        logger.error(
                            "Failed to upload processed complete WAV (non-fatal)",
                            session_id=session.session_id,
                            error=str(exc),
                        )

                # Upload transcript
                try:
                    transcript_bytes = session.build_transcript_json()
                    transcript_uri = await blob.upload_streaming_transcript(
                        transcript_bytes=transcript_bytes,
                        tenant_id=session.tenant_id,
                        session_id=session.session_id,
                    )
                except Exception as exc:
                    logger.error(
                        "Failed to upload transcript (non-fatal)",
                        session_id=session.session_id,
                        error=str(exc),
                    )

                # Upload metadata
                try:
                    metadata_bytes = session.build_metadata_json()
                    await blob.upload_streaming_metadata(
                        metadata_bytes=metadata_bytes,
                        tenant_id=session.tenant_id,
                        session_id=session.session_id,
                    )
                except Exception as exc:
                    logger.error(
                        "Failed to upload metadata (non-fatal)",
                        session_id=session.session_id,
                        error=str(exc),
                    )

                if raw_audio_uri or processed_audio_uri or transcript_uri:
                    logger.info(
                        "Session recordings uploaded",
                        session_id=session.session_id,
                        raw_audio_uri=raw_audio_uri,
                        processed_audio_uri=processed_audio_uri,
                        transcript_uri=transcript_uri,
                    )

                # Register dual-capture Media + AudioRecording when the
                # pipeline opted in (self-guarded; never blocks finalization).
                await self._register_dual_capture(session, raw_audio_uri, processed_audio_uri)

                # Persist the streaming
                # transcript (no jobId) so the harness auto-drafts the SOAP.
                # Unlike the uploads above this is the durable system of record:
                # it is retried inline and, on a transient failure, handed to the
                # durable Redis outbox — but finalize still closes normally so the
                # session's capacity slot is always released.
                await self._persist_streaming_transcript(session)
        except Exception as exc:
            logger.error(
                "Session finalization failed; will still attempt close",
                session_id=session.session_id,
                status=session.status.value,
                error=str(exc),
            )
        finally:
            # session.close() must always execute, regardless of errors above.
            try:
                await session.close(
                    raw_audio_uri=raw_audio_uri,
                    processed_audio_uri=processed_audio_uri,
                    transcript_uri=transcript_uri,
                )
                # Normally already published above (before the uploads); this is
                # the fallback for the case where the early publish itself failed.
                if publisher and not closed_published:
                    await publisher.publish_status("closed")
            except Exception as close_exc:
                logger.error(
                    "session.close() itself failed",
                    session_id=session.session_id,
                    error=str(close_exc),
                )

            # Build the teardown summary AFTER session.close
            # (so `closed_at` is stamped) but BEFORE `remove_session()` pops
            # the per-session attribution tracking dicts. Best-effort: a
            # summary-build failure must never block teardown/cleanup, so it
            # degrades to no summary (the gateway simply skips emission)
            # rather than propagating.
            try:
                teardown_summary = self._build_teardown_summary(session)
            except Exception as summary_exc:
                logger.error(
                    "streaming.teardown_summary.build_failed",
                    session_id=session.session_id,
                    error=str(summary_exc),
                )

            # TASK-985 M-23 — a summary nobody can return is a ledger row
            # nobody writes. THIS IS BILLING CORRECTNESS, not tidiness: on the
            # ordinary clean stop the control `FINALIZE` arrives first and
            # finalizes here, the return value is discarded by `_on_control`,
            # and the DELETE that follows finds no session and answers 204 —
            # so `transcribe.stream` gets NO row at all for a consultation that
            # was fully served. Stashing it lets the DELETE answer 200 with the
            # same summary.
            #
            # The gateway, not STT, stays the owner of `interrupted`: this
            # summary is IDENTICAL either way (see `_build_teardown_summary` —
            # "STT has no notion of interrupted"), and which code path called
            # `removeSession` is knowledge only the gateway has.
            if stash_summary and teardown_summary is not None:
                self._stash_teardown_summary(session.session_id, teardown_summary)

            # Always clean up in-memory and capacity state, even if graceful
            # close failed.
            await self.remove_session(session.session_id)

        return teardown_summary

    async def _cancel_session(self, session: StreamSession) -> None:
        """Cancel a session — immediate cleanup, no finalization."""
        session.status = SessionStatus.CLOSED
        session._metadata.closed_at = datetime.utcnow().isoformat()
        await session.force_persist()

        publisher = self._publishers.get(session.session_id)
        if publisher:
            await publisher.publish_status("cancelled")

        await self.remove_session(session.session_id)
        logger.info("Session cancelled", session_id=session.session_id)

    # ------------------------------------------------------------------
    # Recovery on startup
    # ------------------------------------------------------------------

    async def _recover_sessions(self) -> None:
        """Scan Redis for active sessions and rebuild them.

        For each session with ``status: active``:
        1. Restore Tier-1 metadata from Redis Hash
        2. Load VAD + ASR models from the session's pipeline config
        3. Rebuild preprocessor and inference worker with live models
        4. Resume consuming from ``last_seq + 1``

        Note: VAD will start cold after recovery — it stabilizes within
        1-2 s.  Full audio replay for state warming is deferred.
        """
        cursor: int | bytes = 0
        recovered = 0

        while True:
            cursor, keys = await self._redis.scan(
                cursor=cursor,
                match="stt:session:*",
                count=100,
            )
            for key in keys:
                key_str = key.decode() if isinstance(key, bytes) else key
                session_id_for_cleanup: str | None = None
                acquired_capacity_slot = False
                try:
                    data = await self._redis.hgetall(key_str)
                    if not data:
                        continue
                    meta = SessionMetadata.from_redis_dict(data)
                    session_id_for_cleanup = meta.session_id
                    # TASK-861 — a spec-driven session rebuilds from its persisted
                    # spec; a corrupt one is skipped rather than guessed.
                    recovered_bundle = None
                    if isinstance(meta.resolved_spec_json, str) and meta.resolved_spec_json:
                        try:
                            recovered_bundle = self._register_resolved_spec(
                                meta.session_id, json.loads(meta.resolved_spec_json)
                            )
                        except (
                            Exception
                        ) as spec_exc:  # noqa: BLE001 — recovery must not crash the sweep
                            logger.warning(
                                "Cannot recover session — persisted resolved spec is invalid",
                                session_id=meta.session_id,
                                error=str(spec_exc),
                            )
                            continue

                    # Only recover active sessions assigned to this worker (or unassigned).
                    # TASK-935 — a session this sweep does NOT recover must not leave its
                    # bundle behind: runtime keys are shared per agent version, and a
                    # stale bundle under a live key is what other sessions' key lookups
                    # would find (see `_load_pipeline_config`).
                    if meta.status != SessionStatus.ACTIVE:
                        _spec_bundles_of(self).pop(meta.session_id, None)
                        continue
                    if meta.worker_id and meta.worker_id != self._worker_id:
                        # Check if the other worker is still alive
                        other_alive = await self._redis.exists(worker_key(meta.worker_id))
                        if other_alive:
                            _spec_bundles_of(self).pop(meta.session_id, None)
                            continue  # another worker owns this session

                    # Claim the session
                    meta.worker_id = self._worker_id

                    # Acquire capacity slot
                    if not await self._capacity_guard.try_acquire(meta.session_id):
                        logger.warning(
                            "Cannot recover session — at capacity",
                            session_id=meta.session_id,
                        )
                        _spec_bundles_of(self).pop(meta.session_id, None)
                        continue
                    acquired_capacity_slot = True

                    # TASK-891 — restore the session's language mode BEFORE the
                    # ASR pipeline is rebuilt: `_load_asr_pipeline` resolves it
                    # against the loaded engine, and an absent entry silently
                    # falls through to the spec's mapped primary subtag (`ml` for
                    # an `ml-en` pair) instead of the mode the session opened on.
                    # After the ownership/status gates above, so a session this
                    # worker does not claim never leaves an entry behind.
                    recovered_mode = meta.language_mode or (
                        recovered_bundle.spec.decoding.language_mode
                        if recovered_bundle is not None
                        else None
                    )
                    if recovered_mode:
                        self._session_language_modes[meta.session_id] = recovered_mode

                    session = StreamSession(metadata=meta, redis=self._redis)

                    # Load pipeline config and models for recovered session.
                    # Propagate the session's tenant so a
                    # crash-restart still applies the tenant filter.
                    pipeline_config = await self._load_pipeline_config(
                        meta.pipeline_id, tenant_id=meta.tenant_id, session_id=meta.session_id
                    )

                    # One shared assembly for creation AND
                    # recovery (recovery previously kept a drifted hand copy).
                    # build_speaker_identifier=False: the embedding tracker
                    # state is lost on crash.
                    runtime = await self._assemble_session_runtime(
                        session_id=meta.session_id,
                        tenant_id=meta.tenant_id,
                        consultation_id=meta.consultation_id,
                        user_id=meta.user_id,
                        sample_rate=meta.sample_rate,
                        pipeline_config=pipeline_config,
                        build_speaker_identifier=False,
                        # A recovered session emits stamped frames
                        # too; `meta.pipeline_id` is the pipeline whose config
                        # was just loaded above.
                        active_pipeline_id=meta.pipeline_id,
                    )
                    publisher = runtime.publisher
                    preprocessor = runtime.preprocessor
                    inference_worker = runtime.inference_worker
                    vad_service = runtime.vad_service
                    asr_pipeline = runtime.asr_pipeline

                    session.processed_sample_rate = runtime.target_sr
                    session._vad_active = runtime.vad_enabled

                    # TODO: Replay last ~2 s of audio from Redis Stream to
                    # warm VAD state. Deferred — VAD starts cold but
                    # stabilizes within 1-2 s of new audio.

                    self._register_inference_runtime(session, inference_worker)

                    # Wire up consumers — the audio consumer
                    # group persists its own cursor in Redis, so on recovery the
                    # new consumer resumes via XREADGROUP ">" and reclaims the
                    # dead consumer's unacked in-flight via XAUTOCLAIM. The
                    # persisted last_stream_id is now only the
                    # group-create seed used if the group itself was trimmed
                    # away; an existing group keeps its Redis-owned cursor.
                    last_id = meta.last_stream_id or "0-0"

                    consumer = IngestionConsumer(
                        redis=self._redis,
                        session_id=meta.session_id,
                        on_frame=self._make_frame_handler(session, preprocessor),
                        on_batch=self._make_batch_handler(session),
                        last_id=last_id,
                        consumer_name=self._worker_id,
                    )
                    control_listener = ControlListener(
                        redis=self._redis,
                        session_id=meta.session_id,
                        on_control=self._make_control_handler(session, preprocessor),
                    )

                    self._sessions[meta.session_id] = session
                    self._dual_capture[meta.session_id] = self._resolve_dual_capture(
                        pipeline_config
                    )
                    self._consumers[meta.session_id] = consumer
                    self._control_listeners[meta.session_id] = control_listener
                    self._publishers[meta.session_id] = publisher
                    self._preprocessors[meta.session_id] = preprocessor
                    self._inference_workers[meta.session_id] = inference_worker

                    # Re-arm commit policy on recovery
                    recovered_policy = self._make_commit_policy(pipeline_config)
                    if recovered_policy is not None:
                        self._commit_policies[meta.session_id] = recovered_policy

                    await consumer.start()
                    await control_listener.start()
                    await session.force_persist()

                    recovered += 1
                    logger.info(
                        "Session recovered",
                        session_id=meta.session_id,
                        tenant_id=meta.tenant_id,
                        last_seq=meta.last_seq,
                        has_vad=vad_service is not None,
                        has_asr=asr_pipeline is not None,
                    )
                except Exception as exc:
                    logger.error(
                        "Failed to recover session",
                        key=key_str,
                        error=str(exc),
                    )
                    if acquired_capacity_slot:
                        sid = session_id_for_cleanup or key_str.rsplit(":", 1)[-1]
                        await self.remove_session(sid)
                    elif session_id_for_cleanup:
                        # Registered a bundle, then failed before claiming a slot.
                        _spec_bundles_of(self).pop(session_id_for_cleanup, None)

            if cursor == 0:
                break

        if recovered:
            logger.info("Session recovery complete", recovered_sessions=recovered)

    # ------------------------------------------------------------------
    # Background reaper
    # ------------------------------------------------------------------

    async def _reaper_loop(self) -> None:
        """Periodically finalize sessions that have been idle too long.

        Reaps on ``_audio_idle_timeout_s`` (streaming_audio_idle_timeout_s,
        default 300s), not the 60s ``_session_timeout_s``, so a live consultation
        with a normal speech pause is never finalized out from under the
        clinician. A genuinely dead session (client gone) still crosses the
        audio-idle threshold and is reclaimed on a later scan.

        The same periodic loop re-drives the durable transcript outbox
        (no separate process), so transient-failed transcripts are eventually
        persisted even across worker restarts.
        """
        try:
            while self._running:
                await asyncio.sleep(self._reaper_interval_s)
                await self._reap_expired_sessions(self._audio_idle_timeout_s)
                await self._drain_transcript_outbox()
        except asyncio.CancelledError:
            pass

    async def reap_expired_sessions(self, timeout_s: int) -> int:
        """Public helper to reap sessions on-demand."""
        return await self._reap_expired_sessions(timeout_s)

    async def _reap_expired_sessions(self, timeout_s: int) -> int:
        """Finalize sessions with no activity for ``timeout_s`` seconds.

        Returns the number of reaped sessions.
        """
        now = datetime.utcnow()
        to_reap: list[str] = []

        for session_id, active_session in list(self._sessions.items()):
            if active_session.status != SessionStatus.ACTIVE:
                continue
            try:
                last = datetime.fromisoformat(active_session.last_activity)
                idle_seconds = (now - last).total_seconds()
                if idle_seconds > timeout_s:
                    to_reap.append(session_id)
            except (ValueError, TypeError):
                continue

        for session_id in to_reap:
            session = self._sessions.get(session_id)
            if session:
                logger.info(
                    "Reaping idle session",
                    session_id=session_id,
                    timeout_s=timeout_s,
                )
                try:
                    # F-32 / TASK-985 M-04 — one tail flush per session across
                    # all triggers, and a bounded WAIT when another claimed it.
                    await self._run_tail_flush(session, self._preprocessors.get(session_id))
                    # TASK-985 M-23 — the reaper is the one finalizer that both
                    # emits AND stashes, in that order. It pushes back
                    # IMMEDIATELY (below) because it fires precisely when the
                    # gateway is gone: deferring to the stash TTL would lose the
                    # row outright to a pod roll inside that window. The entry
                    # is then kept, marked `pushed_back`, only so a late DELETE
                    # is answered honestly rather than re-emitting.
                    teardown_summary = await self._finalize_session(
                        session, stash_summary=False
                    )
                    # The reaper is the FINALIZER here, which means
                    # the gateway crashed and its removal retries were exhausted:
                    # no removeSession() caller received the DELETE-teardown
                    # response, so the transcribe.stream usage would be lost.
                    # Push the built summary back to the gateway (idempotent on the
                    # session id → a late DELETE never double-bills).
                    if teardown_summary:
                        await self._push_streaming_usage_back(
                            teardown_summary, interrupted=True
                        )
                        self._stash_teardown_summary(
                            session_id, teardown_summary, pushed_back=True
                        )
                except Exception as exc:
                    logger.error(
                        "Failed to reap session gracefully; forcing removal",
                        session_id=session_id,
                        error=str(exc),
                    )
                    await self.remove_session(session_id)

        return len(to_reap)

    def _stash_teardown_summary(
        self, session_id: str, summary: dict[str, Any], *, pushed_back: bool = False
    ) -> None:
        """Hold a non-HTTP finalizer's summary for the DELETE that follows.

        TASK-985 M-23. Bounded twice — by TTL (checked on the way out of
        :meth:`claim_teardown_summary`, swept by the heartbeat) and by entry
        count, evicting oldest-first. Eviction PUSHES BACK rather than dropping:
        the entry exists because a real consultation was served, so discarding
        it silently is the same ledger hole this method exists to close.

        ``pushed_back`` marks a summary whose finalizer already POSTed it (the
        idle reaper), so neither eviction nor the sweep POSTs it twice.
        """
        ttl_s = float(getattr(self, "_teardown_stash_ttl_s", _TEARDOWN_STASH_TTL_S))
        self._pending_teardown_summaries[session_id] = _StashedTeardown(
            summary=summary,
            expires_at=time.monotonic() + ttl_s,
            pushed_back=pushed_back,
        )
        while len(self._pending_teardown_summaries) > _TEARDOWN_STASH_MAX_ENTRIES:
            # dicts preserve insertion order, so the first key is the oldest.
            evicted_id = next(iter(self._pending_teardown_summaries))
            evicted = self._pending_teardown_summaries.pop(evicted_id)
            logger.warning(
                "stt.stream.teardown_stash_evicted",
                session_id=evicted_id,
                held=len(self._pending_teardown_summaries),
                cap=_TEARDOWN_STASH_MAX_ENTRIES,
            )
            if not evicted.pushed_back:
                # The gateway never came for it, so it never told us whether the
                # session was interrupted — and an abandoned teardown is exactly
                # what `interrupted` means.
                task = asyncio.create_task(
                    self._push_streaming_usage_back(evicted.summary, interrupted=True)
                )
                self._stash_pushback_tasks.add(task)
                task.add_done_callback(self._stash_pushback_tasks.discard)

    def claim_teardown_summary(self, session_id: str) -> dict[str, Any] | None:
        """Pop the stashed teardown summary for ``session_id``, if any.

        Read by ``DELETE /internal/streaming/sessions/{id}`` when the session is
        already gone: instead of answering 204 ("nothing to summarize") it
        answers 200 with the summary the finalizer that ran had no way to
        return. Claiming is destructive so two DELETEs cannot both emit; the
        ledger's idempotency key would dedup anyway, but not trying is better
        than relying on it.
        """
        entry = self._pending_teardown_summaries.pop(session_id, None)
        if entry is None:
            return None
        if time.monotonic() > entry.expires_at:
            logger.warning(
                "stt.stream.teardown_stash_expired_on_claim",
                session_id=session_id,
            )
            return None
        if entry.pushed_back:
            # Already POSTed by its finalizer. Returning it here would be a
            # second emission attempt for the same teardown; the ledger's
            # idempotency key would dedup it, but not trying is better than
            # relying on that.
            logger.info(
                "stt.stream.teardown_stash_already_pushed",
                session_id=session_id,
            )
            return None
        return entry.summary

    async def _sweep_teardown_summaries(self) -> None:
        """Push back teardown summaries no DELETE ever claimed.

        Runs on the worker heartbeat. An expired entry means the gateway never
        came for it — it crashed, or its removal retries were exhausted — which
        is the same situation the reaper's push-back already handles, so it gets
        the same treatment and the same ``interrupted=True`` verdict. The
        ledger's idempotency key is shared across both paths, so a late claim
        after a push-back is a no-op at the ledger, never a double charge.
        """
        now = time.monotonic()
        expired = [
            sid for sid, entry in self._pending_teardown_summaries.items() if now > entry.expires_at
        ]
        for session_id in expired:
            entry = self._pending_teardown_summaries.pop(session_id, None)
            if entry is None or entry.pushed_back:
                continue
            logger.warning(
                "stt.stream.teardown_stash_unclaimed",
                session_id=session_id,
            )
            await self._push_streaming_usage_back(entry.summary, interrupted=True)

    async def _push_streaming_usage_back(
        self, summary: dict[str, Any], *, interrupted: bool = True
    ) -> None:
        """POST a finalizer-built teardown summary to the gateway.

        Best-effort by design: the gateway may still be down (it just crashed),
        so a failure here is logged and dropped — a metering side effect must
        never fail the reaper, and the raw ledger back-rate remains the backstop.
        ``interrupted`` defaults to ``True`` because every caller of this method
        is a path where the gateway did NOT come to collect: a reaped session
        was abandoned, and an unclaimed stash was abandoned by the gateway. A
        short-lived client is fine: these run on a multi-second-or-worse cadence,
        so per-call construction cost is irrelevant.
        """
        settings = get_settings()
        base_url = getattr(settings, "api_gateway_url", "")
        secret = getattr(settings, "api_gateway_key", None)
        api_key = secret.get_secret_value() if secret is not None else ""
        if not base_url or not api_key:
            return
        client = APIGatewayClient(
            base_url, api_key, timeout=getattr(settings, "api_gateway_timeout", 30)
        )
        try:
            await client.record_streaming_usage(summary, interrupted=interrupted)
        except Exception as exc:  # noqa: BLE001 — best-effort metering side effect
            logger.warning(
                "stt.stream.usage_pushback_failed",
                session_id=summary.get("session_id"),
                error=str(exc),
            )
        finally:
            await client.close()

    # ------------------------------------------------------------------
    # Audio snapshot loop
    # ------------------------------------------------------------------

    async def _snapshot_loop(self) -> None:
        """Periodically upload raw PCM chunks for active sessions."""
        try:
            while self._running:
                await asyncio.sleep(self._snapshot_interval_s)
                for session_id, session in list(self._sessions.items()):
                    if session.status != SessionStatus.ACTIVE:
                        continue
                    if len(session.processed_audio_buffer) > 0:
                        p_offset = self._processed_chunk_offsets.get(session_id, 0)
                        if p_offset >= len(session.processed_audio_buffer):
                            continue
                    else:
                        offset = self._chunk_offsets.get(session_id, 0)
                        if offset >= len(session.audio_buffer):
                            continue
                    last = self._last_snapshot_at.get(session_id, 0.0)
                    if (time.monotonic() - last) < self._snapshot_interval_s:
                        continue
                    await self._upload_snapshot(session)
        except asyncio.CancelledError:
            pass

    async def _upload_snapshot(self, session: StreamSession) -> None:
        """Upload the next raw PCM chunk of new audio since last snapshot.

        When processed audio is available, prefer the processed buffer
        so that uploaded audio matches what was actually transcribed.
        """
        try:
            if len(session.processed_audio_buffer) > 0:
                p_offset = self._processed_chunk_offsets.get(session.session_id, 0)
                chunk_data = bytes(session.processed_audio_buffer[p_offset:])
                if not chunk_data:
                    return
                chunk_idx = self._processed_chunk_indices.get(session.session_id, 0)
                blob = self._get_blob_service()
                await blob.upload_streaming_processed_chunk(
                    chunk_bytes=chunk_data,
                    tenant_id=session.tenant_id,
                    session_id=session.session_id,
                    chunk_index=chunk_idx,
                )
                self._processed_chunk_offsets[session.session_id] = len(
                    session.processed_audio_buffer
                )
                self._processed_chunk_indices[session.session_id] = chunk_idx + 1
            else:
                offset = self._chunk_offsets.get(session.session_id, 0)
                chunk_data = bytes(session.audio_buffer[offset:])
                if not chunk_data:
                    return
                chunk_idx = self._chunk_indices.get(session.session_id, 0)
                blob = self._get_blob_service()
                await blob.upload_streaming_raw_chunk(
                    chunk_bytes=chunk_data,
                    tenant_id=session.tenant_id,
                    session_id=session.session_id,
                    chunk_index=chunk_idx,
                )
                self._chunk_offsets[session.session_id] = len(session.audio_buffer)
                self._chunk_indices[session.session_id] = chunk_idx + 1
            self._last_snapshot_at[session.session_id] = time.monotonic()
            logger.info(
                "Audio chunk uploaded",
                session_id=session.session_id,
                chunk_index=chunk_idx,
                chunk_bytes=len(chunk_data),
            )
        except Exception as exc:
            logger.warning(
                "Audio chunk upload failed (non-fatal)",
                session_id=session.session_id,
                error=str(exc),
            )

    # ------------------------------------------------------------------
    # Worker heartbeat
    # ------------------------------------------------------------------

    async def _register_worker(self) -> None:
        """Register this worker in Redis with a TTL."""
        key = worker_key(self._worker_id)
        value = {
            "pid": str(os.getpid()),
            "started_at": datetime.utcnow().isoformat(),
            "max_streams": str(self._profile.max_concurrent_streams),
        }
        await self._redis.hset(key, mapping=value)
        await self._redis.expire(key, self._heartbeat_ttl_s)
        logger.info("Worker registered", worker_id=self._worker_id, key=key)

    async def _unregister_worker(self) -> None:
        """Remove this worker's heartbeat key from Redis."""
        key = worker_key(self._worker_id)
        await self._redis.delete(key)
        logger.info("Worker unregistered", worker_id=self._worker_id)

    async def _heartbeat_loop(self) -> None:
        """Periodically extend the worker heartbeat TTL."""
        try:
            while self._running:
                await asyncio.sleep(self._heartbeat_interval_s)
                await self._reconcile_capacity_guard()
                # TASK-985 M-23 — teardown summaries the gateway never claimed.
                await self._sweep_teardown_summaries()
                key = worker_key(self._worker_id)
                # Update session list and extend TTL
                session_ids = list(self._sessions.keys())
                await self._redis.hset(
                    key,
                    mapping={
                        "sessions": ",".join(session_ids),
                        "active_sessions": str(len(session_ids)),
                        "last_heartbeat": datetime.utcnow().isoformat(),
                    },
                )
                await self._redis.expire(key, self._heartbeat_ttl_s)
        except asyncio.CancelledError:
            pass

    async def _reconcile_capacity_guard(self) -> None:
        """Self-heal leaked capacity slots that are not present in session maps."""
        guard_ids = set(self._capacity_guard.active_session_ids)
        tracked_ids = set(self._sessions.keys())
        leaked_ids = guard_ids - tracked_ids
        if not leaked_ids:
            return

        for leaked_session_id in leaked_ids:
            await self._capacity_guard.release(leaked_session_id)

        logger.warning(
            "Reconciled leaked capacity slots",
            leaked_count=len(leaked_ids),
            leaked_session_ids=sorted(leaked_ids),
        )

    # ------------------------------------------------------------------
    # Diagnostics
    # ------------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        """Snapshot for health/status endpoints."""
        return {
            "worker_id": self._worker_id,
            "draining": self._draining,
            "active_sessions": self.active_session_count,
            "capacity": self._capacity_guard.to_dict(),
            "profile": {
                "platform": self._profile.platform.value,
                "device_name": self._profile.device_name,
                "max_concurrent_streams": self._profile.max_concurrent_streams,
                "asr_device": self._profile.asr_device,
                "asr_max_batch_size": self._profile.asr_max_batch_size,
                "embedding_device": self._profile.embedding_device,
            },
            "sessions": self.list_sessions(),
        }
