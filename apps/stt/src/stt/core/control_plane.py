"""The stt tuning knobs the CONTROL PLANE owns, and how a served value lands.

lane C. Before this module, ~75 of stt's settings fields were
environment variables: retuning a VAD threshold, a streaming timeout or a
punctuation device meant a redeploy, and nothing in the platform could show an
admin what the running value was. They are now registry keys
(`packages/applications/src/services/settings-registry/descriptors/stt-runtime.descriptors.ts`,
`tier: 'global-kv'`, `consumedBy: ['stt']`) delivered over the effective-config
pull route that `stt.modelCache.*` / `stt.workers.concurrency` /
`stt.streaming.maxConcurrent` already proved.

THE THREE PROPERTIES THIS MODULE EXISTS TO HOLD
-----------------------------------------------

**1. The env path is closed STRUCTURALLY, not by convention.** Every field named
in :data:`CONTROL_PLANE_KEYS` carries a ``validation_alias`` naming a variable
nobody will ever set, and ``Settings`` deliberately leaves ``populate_by_name``
off so the field name cannot re-open the path either. That is the pattern
``apps/tts/src/tts/core/config.py`` already uses to make its cloud credentials
un-settable from env — generalised here from credentials to tuning knobs.
Deleting a field's env *documentation* is not the same thing: removed
`api_key` fields from three text adapters and the SDKs kept reading ambient
environment anyway (assessment F-01). A structural closure cannot regress
without a test failing.

**2. The bootstrap default is the SAME value, transcribed verbatim.** Each
field keeps its declared default, and the registry descriptor's ``default`` is
that same literal. A service that starts against an empty ``GlobalSetting``
table therefore behaves EXACTLY as it did before: the read service resolves the
descriptor default and labels it ``source: 'env-fallback'``. No seeding is
required for this change to be behaviour-neutral, which is what makes it safe
to land without a migration.

**3. An unresolved or wrongly-typed value NEVER substitutes anything.**
``value: null`` means "the control plane has no opinion" and the bootstrap value
stays. A value whose Python type does not match the field's keeps the bootstrap
value too, and says so in the log. This mirrors ``EffectiveConfigService``'s own
rule ("a TYPE mismatch degrades … but note what it explicitly does NOT do:
substitute ``descriptor.default``") — a plausible-looking wrong value is worse
than a visibly stale right one.

WHY AN OVERLAY RATHER THAN A RESOLVER AT EACH CALL SITE
-------------------------------------------------------
These knobs are read from ~80 call sites across the streaming hot path, the
Dramatiq worker, the VAD/punctuation processors and the loaders. Threading an
async resolver through all of them would be a far larger change than the one
being made, and every un-migrated call site would be a silent divergence. The
overlay writes the resolved value onto the ONE settings instance those call
sites already read, so a knob is either migrated (and therefore live everywhere)
or it is not. ``Settings`` is cached per process (``get_settings`` is
``lru_cache``d), so there is exactly one object to overlay.
"""

from __future__ import annotations

from functools import cache
from typing import TYPE_CHECKING, Any, Literal, get_args, get_origin

import structlog

if TYPE_CHECKING:  # pragma: no cover - typing only
    from stt.core.config.settings import Settings

logger = structlog.get_logger(__name__)

#: The suffix that closes a field's env path. It is deliberately verbose and
#: deliberately names the ticket: an operator who greps for ``VAD_THRESHOLD`` in
#: the code must land on something that explains where the value went, rather
#: than on a field that looks settable and silently is not.
MOVED_SUFFIX = "__MOVED_TO_CONTROL_PLANE"


def moved_alias(field_name: str) -> str:
    """The dead ``validation_alias`` for a migrated field.

    ``Settings`` carries no ``env_prefix``, so the variable that USED to set the
    field is the bare uppercased field name; the alias is that name plus
    :data:`MOVED_SUFFIX`. Deriving it (rather than writing 70 string literals)
    is what lets the test assert closure for every field mechanically.
    """
    return f"{field_name.upper()}{MOVED_SUFFIX}"


#``Settings`` field → settings-registry key.
#:
#: This table IS the migration. Its keys must exist on ``Settings`` and its
#: values must match the descriptors registered on the gateway side; both
#: halves are asserted by ``tests/unit/test_task799_control_plane.py`` and by
#: ``stt-runtime.descriptors.test.ts``.
#:
#: Grouping follows the descriptor grammar ``stt.<group>.<knob>`` in lowerCamel,
#: which is also what the gateway's `toEnvVarName` would render — so a key reads
#: back to the variable it replaced without a lookup table.
CONTROL_PLANE_KEYS: dict[str, str] = {
    # ── model cache / concurrency: the FOUR keys that already existed ────────
    # Registered by `service-runtime.descriptors.ts` since and already
    # applied at runtime (`ModelCache.apply_retention`,
    # `resolve_worker_concurrency`, `resolve_streaming_max_concurrent`). What
    # changes here is only that their env path closes: they were documented as
    # "bootstrap fallback — the runtime value comes from the control plane"
    # while remaining fully settable from `MODEL_CACHE_MAX_MODELS` etc., so an
    # operator could set a value that the next config pull silently overwrote.
    "model_cache_max_models": "stt.modelCache.maxModels",
    "model_cache_ttl_seconds": "stt.modelCache.ttlSeconds",
    "worker_threads": "stt.workers.concurrency",
    "streaming_max_concurrent": "stt.streaming.maxConcurrent",
    # ── cloud engine endpoints / regions ─────────────────────────────────────
    # NOT credentials — every one of these engines is BYOK and its key already
    # arrives per request from the provider-connection plane. These are the
    # non-secret halves that were left behind in env.
    "azure_speech_region": "stt.azureSpeech.region",
    "azure_foundry_enabled": "stt.azureFoundry.enabled",
    "azure_foundry_endpoint": "stt.azureFoundry.endpoint",
    "sarvam_base_url": "stt.sarvam.baseUrl",
    "openai_base_url": "stt.openai.baseUrl",
    # ── local ggml runtimes ──────────────────────────────────────────────────
    "parakeet_cpp_library_path": "stt.parakeetCpp.libraryPath",
    "parakeet_cpp_num_threads": "stt.parakeetCpp.numThreads",
    "whisper_cpp_num_threads": "stt.whisperCpp.numThreads",
    # `whisper_cpp_max_audio_seconds` and `whisper_cpp_consultation_prompt_enabled`
    # were mapped here until TASK-880. The first is the MODEL's decode window
    # (`AiModel._metadata.asr.maxDecodeWindowSec`, carried per chain on the spec), not one
    # number for every whisper.cpp row on the box; the second gated two HARDCODED
    # consultation lines, while WHAT prior context a decode gets is the agent's
    # `instruction.initialPrompt` — which already reached the adapter by another route.
    # ── VAD (Silero v5) ──────────────────────────────────────────────────────
    # NOTHING is mapped here any more. `vad_threshold`, `vad_min_speech_duration_ms`
    # and `vad_min_silence_duration_ms` lost their descriptors in TASK-872 (the live
    # path is fed by `ResolvedAsrSpec`, which carries its own VAD parameters); their
    # FIELDS stay as the bootstrap default. TASK-880 took the last two outright:
    # `vad_model_path` (the weights are the `AiModel` row the spec already carries as
    # `models.vad.localPath`) and `vad_speech_pad_ms` (an agent tuning knob beside the
    # three above it, now `audioFrontEnd.vad.speechPadMs`).
    # ── diarization / voice profiles ─────────────────────────────────────────
    "diarization_hf_model_id": "stt.diarization.hfModelId",
    "diarization_device": "stt.diarization.device",
    "voice_profile_min_similarity": "stt.voiceProfile.minSimilarity",
    # ── worker + runtime threading ───────────────────────────────────────────
    "worker_poll_timeout_ms": "stt.workers.pollTimeoutMs",
    "worker_max_retries": "stt.workers.maxRetries",
    "onnx_num_threads": "stt.runtime.onnxNumThreads",
    "torch_num_threads": "stt.runtime.torchNumThreads",
    "torch_num_interop_threads": "stt.runtime.torchNumInteropThreads",
    # ── batch transcription geometry ─────────────────────────────────────────
    "transcription_timeout_seconds": "stt.transcription.timeoutSeconds",
    "transcription_chunk_length_s": "stt.transcription.chunkLengthS",
    "transcription_stride_length_s": "stt.transcription.strideLengthS",
    "segment_merge_gap_threshold_s": "stt.segmentMerge.gapThresholdS",
    # ── gateway call budget ──────────────────────────────────────────────────
    # The gateway URL and key stay in env (bootstrap transport — they are how
    # the process REACHES the config source). The timeout is tuning.
    "api_gateway_timeout": "stt.gateway.timeoutSeconds",
    # ── streaming ────────────────────────────────────────────────────────────
    "streaming_max_batch_size": "stt.streaming.maxBatchSize",
    # `streaming_batch_wait_ms`, `streaming_embedding_device` and
    # `streaming_multi_gpu_strategy` were mapped here until TASK-872. Batch
    # timing and device placement come from the hardware execution profile (and,
    # for the embedding model, from `ResolvedAsrSpec`), so the three registry
    # keys reached no reader and were removed with this mapping.
    "streaming_session_persist_interval_s": "stt.streaming.sessionPersistIntervalS",
    "streaming_snapshot_interval_s": "stt.streaming.snapshotIntervalS",
    "streaming_max_audio_buffer_bytes": "stt.streaming.maxAudioBufferBytes",
    "streaming_session_timeout_s": "stt.streaming.sessionTimeoutS",
    "streaming_audio_idle_timeout_s": "stt.streaming.audioIdleTimeoutS",
    "streaming_reaper_interval_s": "stt.streaming.reaperIntervalS",
    "streaming_transcript_persist_max_attempts": "stt.streaming.transcriptPersistMaxAttempts",
    "streaming_transcript_persist_backoff_s": "stt.streaming.transcriptPersistBackoffS",
    "streaming_transcript_outbox_max_attempts": "stt.streaming.transcriptOutboxMaxAttempts",
    "streaming_inference_drain_timeout_s": "stt.streaming.inferenceDrainTimeoutS",
    "streaming_inference_queue_maxsize": "stt.streaming.inferenceQueueMaxsize",
    "streaming_inference_stop_timeout_s": "stt.streaming.inferenceStopTimeoutS",
    "streaming_worker_heartbeat_s": "stt.streaming.workerHeartbeatS",
    "streaming_worker_heartbeat_ttl_s": "stt.streaming.workerHeartbeatTtlS",
    "streaming_audio_stream_maxlen": "stt.streaming.audioStreamMaxlen",
    "streaming_result_stream_maxlen": "stt.streaming.resultStreamMaxlen",
    "streaming_audio_trim_interval_s": "stt.streaming.audioTrimIntervalS",
    "streaming_extra_filler_patterns": "stt.streaming.extraFillerPatterns",
    "streaming_punctuation_timeout_s": "stt.streaming.punctuationTimeoutS",
    # `streaming_partial_window_s` was mapped here until TASK-880. Its own description
    # said to set it to "the whisper.cpp force-emit window", which makes it a property of
    # the ASR MODEL: it is now `AiModel._metadata.asr.partialWindowSec`.
    "streaming_result_stream_expire_s": "stt.streaming.resultStreamExpireS",
    "streaming_session_metadata_expire_s": "stt.streaming.sessionMetadataExpireS",
    # `streaming_partial_interval_s` and the six `semantic_endpoint_*` keys were
    # mapped here until TASK-877. Both families duplicated AGENT concepts, so they
    # are deleted rather than dual-homed: the partial cadence, the endpointing mode,
    # its four tuning knobs and the end-of-utterance model all arrive per session on
    # `ResolvedAsrSpec` (`streaming.{partialIntervalMs,endpointing,semantic}` and the
    # `endpointing` model role).
    # ── real-time event publishing ───────────────────────────────────────────
    "pubsub_channel_prefix": "stt.pubsub.channelPrefix",
    "pubsub_enabled": "stt.pubsub.enabled",
    # ── punctuation restoration (Cadence) ────────────────────────────────────
    # `punctuation_enabled` and `punctuation_model_name` were mapped here until
    # TASK-877. Both decided what the AGENT decides: `stt.punctuation.enabled` was a
    # boot gate that vetoed `postProcessing.punctuation.enabled` for every session
    # (and defaulted OFF), and `stt.punctuation.modelName` duplicated
    # `models.punctuation.slug`. The three below survive because placement, cache
    # location and window width are properties of the HOST, not of the agent.
    "punctuation_model_cache_dir": "stt.punctuation.modelCacheDir",
    "punctuation_device": "stt.punctuation.device",
    "punctuation_max_length": "stt.punctuation.maxLength",
}

#``Settings`` field → a PLATFORM-owned registry key that is NOT under `stt.*`.
#:
#: Separate from :data:`CONTROL_PLANE_KEYS` because that table carries an invariant
#: worth keeping: every key in it is `stt.<group>.<knob>` and has a descriptor in
#: `stt-runtime.descriptors.ts` (asserted both ways by
#: `test_task799_descriptor_parity.py`). These keys satisfy neither, and merging them
#: would have forced that invariant to be weakened rather than split.
#:
#: The distinction is real, not bookkeeping. `storage.platformDefault.provider`
#: describes the PLATFORM's object storage — the SYSTEM `TenantStorageConfig` row that
#: apps/api resolves through the same cascade — so stt CONSUMES it rather than owning
#: it. Minting an `stt.storage.provider` twin would be the second-home failure that
#: owner decision D-2 exists to prevent. It is `tier: 'db-config'`, and it is only
# reachable on the pull route because A.1 opened that tier.
PLATFORM_CASCADE_KEYS: dict[str, str] = {
    "storage_provider": "storage.platformDefault.provider",
}

#: Registry key → ``Settings`` field. Built once; the pull payload is keyed by
#: registry key, so this is the direction the overlay actually walks. Both tables
#: land in one map because the OVERLAY mechanism is identical — only the governance
#: of where a key's descriptor lives differs.
_FIELD_BY_KEY: dict[str, str] = {
    key: field for field, key in {**CONTROL_PLANE_KEYS, **PLATFORM_CASCADE_KEYS}.items()
}


def bootstrap_defaults() -> dict[str, Any]:
    """Each migrated field's declared default — the value the descriptor mirrors.

    Exposed so a test can assert the two sides agree without re-transcribing
    seventy literals, which is the step that would drift.
    """
    from stt.core.config.settings import Settings as _Settings

    return {field: _Settings.model_fields[field].default for field in CONTROL_PLANE_KEYS}


def _acceptable(current: Any, served: Any) -> bool:
    """Is ``served`` usable in place of ``current``?

    Type agreement against the value ALREADY in the field, not against an
    annotation: the field's declared default is the authority on what shape it
    holds, and matching against it needs no second copy of the type map. An
    optional field whose current value is ``None`` accepts any non-``None``
    scalar, because ``None`` carries no shape to compare with.

    ``bool`` is excluded from the numeric branch on purpose — it is an ``int``
    subclass, so ``True`` would otherwise silently become the integer 1. The
    same trap ``_positive_int`` in ``core/effective_config.py`` already guards.
    """
    if served is None:
        return False
    if isinstance(current, bool):
        return isinstance(served, bool)
    if isinstance(current, int) or isinstance(current, float):
        return isinstance(served, (int, float)) and not isinstance(served, bool)
    if isinstance(current, str):
        return isinstance(served, str)
    if current is None:
        # `str | None` fields (vad_model_path, azure_speech_region,
        # azure_foundry_endpoint, parakeet_cpp_library_path,
        # punctuation_model_cache_dir).
        #
        # An EMPTY STRING is how these five spell "no opinion" on the wire. The
        # registry has no null literal for a `string` descriptor, so their
        # `default` is `''`; treating that as a real value would replace `None`
        # — which every consumer reads as "unset, use your own resolution" —
        # with an empty path or an empty region, and `os.makedirs("")` /
        # `Region("")` fail in ways that look nothing like a config problem.
        # The service already spells unset this way elsewhere
        # (`_default_minio_endpoint_when_blank`, `_normalize_huggingface_token`).
        #
        # A bool is refused outright: no optional field in the table is boolean.
        if isinstance(served, str):
            return served.strip() != ""
        return isinstance(served, (int, float)) and not isinstance(served, bool)
    return False


@cache
def _declared_choices(field: str) -> frozenset[str] | None:
    """The string members a ``Literal``-typed field accepts; ``None`` if unconstrained.

    Derived from the ANNOTATION rather than a hand-written table, so a field that
    gains or loses a member needs no second edit here.

    Why type agreement is not enough for these. ``_acceptable`` compares the served
    value's SHAPE against the value already in the field, which is the right rule for
    a free-form string (an endpoint, a device name). A ``Literal`` field is different:
    its members are the complete set of values any consumer branches on, so an
    out-of-vocabulary string type-checks and then silently takes the fall-through
    branch — `storage_provider="gcs"` would leave stt on MinIO while an admin believed
    they had switched backends. Refuse it and keep the bootstrap value instead.
    """
    from stt.core.config.settings import Settings as _Settings

    annotation = _Settings.model_fields[field].annotation
    if get_origin(annotation) is not Literal:
        return None
    members = get_args(annotation)
    if not members or not all(isinstance(member, str) for member in members):
        return None
    return frozenset(members)


def apply_control_plane(settings: Settings, payload: Any) -> list[str]:
    """Overlay one effective-config payload onto ``settings``. Returns the fields set.

    ``payload`` is the raw body of ``GET /internal/effective-config?service=stt``.
    Only its generic ``settings`` map is read — the frozen ``retention`` /
    ``concurrency`` groups are VIEWS over the same resolved keys and are still
    consumed by ``core/runtime_limits.py``, which owns applying them to the live
    model cache and the worker gate.

    NEVER raises. A malformed payload, a missing block or an unknown key each
    contribute nothing: this runs on the config-refresh path, and a config
    refresh may not break transcription.
    """
    if not isinstance(payload, dict):
        return []
    block = payload.get("settings")
    if not isinstance(block, dict):
        return []

    applied: list[str] = []
    for key, entry in block.items():
        field = _FIELD_BY_KEY.get(key)
        if field is None or not isinstance(entry, dict):
            continue

        served = entry.get("value")
        current = getattr(settings, field, None)
        if not _acceptable(current, served):
            if served is not None:
                logger.warning(
                    "stt.control_plane.value_refused",
                    key=key,
                    field=field,
                    served_type=type(served).__name__,
                    current_type=type(current).__name__,
                )
            continue

        choices = _declared_choices(field)
        if choices is not None and served not in choices:
            logger.warning(
                "stt.control_plane.value_outside_declared_choices",
                key=key,
                field=field,
                served=served,
                choices=sorted(choices),
            )
            continue

        if served == current:
            continue

        # `object.__setattr__`-equivalent: `Settings` is a mutable pydantic
        # model with no `validate_assignment`, so this is a plain field write.
        # Not `model_copy`: the call sites hold a reference to THIS instance
        # (`get_settings()` is lru_cached), and a copy would be invisible to them.
        setattr(settings, field, served)
        applied.append(field)
        logger.info("stt.control_plane.applied", key=key, field=field, source=entry.get("source"))

    return applied
