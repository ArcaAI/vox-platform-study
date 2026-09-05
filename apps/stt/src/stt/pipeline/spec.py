"""TASK-861 — ``ResolvedAsrSpec``: the gateway-resolved ASR runtime contract.

The pydantic mirror of ``packages/types/src/asr-spec.ts``. The API gateway
resolves the ASR Agent (TASK-863) — its registry models, its §3.2 blocks, its
fallback — and hands the WHOLE thing to this service per streaming session and
per batch job. Nothing here reads Postgres: this module replaces the
``PipelineConfigReader`` (``AsrPipeline`` row → YAML → ``PipelineSpec``) and the
``ModelRegistryReader`` (``AiModel`` row → ``AiModelConfig``) with one pure
function, ``pipeline_spec_from_resolved``, that maps the contract onto the SAME
runtime dataclasses the session manager and the batch service already consume.

Both halves of the contract validate ONE committed fixture
(``tests/contracts/resolved-asr-spec.fixture.json``) —
``tests/unit/test_resolved_spec_parity.py`` here, the vitest contract on the
TypeScript side — so a shape change on either side fails the other.

Wire shape is camelCase (the JSON the gateway persists on
``TranscriptionJob.resolvedSpec``); ``extra='forbid'`` makes an unknown field a
contract drift rather than a silent drop.

Selection fails CLOSED: a schema version this runtime does not know, or a model
``format`` it does not execute, raises — a guessed engine is never substituted.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, ClassVar, Literal

import structlog
from pydantic import BaseModel, ConfigDict, Field, SerializerFunctionWrapHandler, model_serializer
from pydantic.alias_generators import to_camel

from .dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    DenoiseConfig,
    DiarizationConfig,
    EndpointConfig,
    InferenceConfig,
    ModelRef,
    ModelRefs,
    ModelTaskType,
    PipelineConfig,
    PipelineSpec,
    PostprocessingConfig,
    PreprocessingConfig,
    PunctuationConfig,
    SegmentMergeConfig,
    StreamingConfig,
    TimestampConfig,
    VadConfig,
)

logger = structlog.get_logger(__name__)

RESOLVED_ASR_SPEC_SCHEMA_VERSION = 1

#: ``version`` stamped on the ``PipelineSpec`` built from a resolved spec — the
#: former YAML ``version`` field, kept so downstream readers see a value.
AGENT_PIPELINE_SPEC_VERSION = "agent/1"


class UnsupportedAsrSpecError(ValueError):
    """The spec names something this runtime cannot execute (fail closed)."""


class _Wire(BaseModel):
    """Base for every wire model: camelCase aliases, strict field set, immutable.

    ``OPTIONAL_FIELDS`` names the fields that are OMITTED from the wire when they
    are ``None``, rather than serialised as ``null``. That distinction is
    load-bearing, not cosmetic: this model is ``extra='forbid'``, so a key the
    other half has not learned yet is a CONTRACT DRIFT. Omitting an unset optional
    lets a field be added on either side first — the gateway may send it or not,
    and either way the bytes round-trip — which is what makes the two halves
    independently deployable. A field that is always present and merely nullable
    (``beamSize``, ``temperature``, …) does NOT belong in this set: for those,
    ``null`` is the agent's "no opinion" and must survive the round trip.
    """

    #: Field names (not aliases) omitted from the dump when their value is ``None``.
    OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset()

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        frozen=True,
    )

    @model_serializer(mode="wrap")
    def _omit_unset_optionals(
        self, handler: SerializerFunctionWrapHandler
    ) -> dict[str, object]:
        dumped: dict[str, object] = handler(self)
        if not self.OPTIONAL_FIELDS:
            return dumped
        # The dump is keyed by alias under `by_alias=True` and by field name
        # otherwise, so drop both spellings.
        omit: set[str] = set()
        for name in self.OPTIONAL_FIELDS:
            omit.add(name)
            alias = type(self).model_fields[name].alias
            if alias:
                omit.add(alias)
        return {key: value for key, value in dumped.items() if not (value is None and key in omit)}


AsrSpecModelRole = Literal["asr", "vad", "denoise", "embedding", "punctuation", "endpointing"]


class AsrSpecModelMetadata(_Wire):
    """TASK-880 — the ``AiModel._metadata.asr`` decode geometry that rides the row.

    ``stt.whisperCpp.maxAudioSeconds`` and ``stt.streaming.partialWindowS`` were
    PLATFORM keys: one number applied to every session whatever engine served it, and
    unchangeable without a control-plane write. They describe a MODEL — the ml-en
    fine-tune is accurate to ~6-7s, the CT2 turbo row is not — so they belong to the row,
    and a fallback chain now decodes on its own window instead of the primary's.

    Both members are optional: absent means the row declared nothing and the runtime's own
    dataclass default stands (``InferenceConfig.max_decode_window_sec``,
    ``StreamingPreprocessor``'s partial window).
    """

    OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset(
        {"max_decode_window_sec", "partial_window_sec"}
    )

    max_decode_window_sec: float | None = None
    partial_window_sec: float | None = None


class AsrSpecModel(_Wire):
    """One resolved registry row — the fields the model loaders consume."""

    OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset({"metadata"})

    role: AsrSpecModelRole
    slug: str
    task_type: str
    format: str
    source_uri: str
    source_revision: str | None
    local_path: str | None
    checksum: str | None
    compute_type: str | None
    provider: str | None
    tenant_id: str
    metadata: AsrSpecModelMetadata | None = None


class AsrSpecModels(_Wire):
    """``asr`` is required; an ABSENT auxiliary role is OMITTED on the wire (the
    TypeScript type declares them ``?:``), never serialised as ``null`` — so the
    two halves round-trip the same bytes.

    ``punctuation`` and ``endpointing`` are referenced by SLUG only: the punctuation
    service and the semantic endpointer load them themselves, so neither enters the
    STT model cache and neither is validated against ``ModelTaskType``.
    """

    OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset(
        {"vad", "denoise", "embedding", "punctuation", "endpointing"}
    )

    asr: AsrSpecModel
    vad: AsrSpecModel | None = None
    denoise: AsrSpecModel | None = None
    embedding: AsrSpecModel | None = None
    punctuation: AsrSpecModel | None = None
    endpointing: AsrSpecModel | None = None


class AsrSpecVad(_Wire):
    """TASK-880 — ``speech_pad_ms`` replaces the platform key ``stt.vad.speechPadMs``.

    OPTIONAL (omit-when-absent, see :class:`_Wire`); the three fields above it predate
    that rule and stay required-but-nullable. Absent means the agent expressed no
    opinion and ``VadConfig.padding_ms`` — the one source of the engine default —
    stands.
    """

    OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset({"speech_pad_ms"})

    enabled: bool
    threshold: float | None
    min_speech_ms: int | None
    min_silence_ms: int | None
    speech_pad_ms: int | None = None


class AsrSpecDenoise(_Wire):
    enabled: bool
    level: Literal["off", "low", "medium", "high"]


class AsrSpecDiarization(_Wire):
    """TASK-887 — ``match_threshold`` replaces the platform key ``stt.voiceProfile.minSimilarity``.

    Diarization is a declared AGENT option: the agent names the speaker-embedding model, and
    the confidence at which a segment may carry an ENROLLED profile's label is part of that
    declaration. OPTIONAL (omit-when-absent, see :class:`_Wire`) — absent means the agent said
    nothing and ``DiarizationConfig.match_threshold`` stands.
    """

    OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset({"match_threshold"})

    enabled: bool
    backend: Literal["embedding", "sortformer"]
    max_speakers: int | None
    match_threshold: float | None = None


class AsrSpecAudioFrontEnd(_Wire):
    vad: AsrSpecVad
    denoise: AsrSpecDenoise
    diarization: AsrSpecDiarization
    resample: bool
    normalize: bool


class AsrSpecDecoding(_Wire):
    """Owner decision #9 widened this block with batch chunking.

    ``chunk_length_sec`` / ``stride_length_sec`` are OPTIONAL (see
    :class:`_Wire`): absent means the agent expressed no opinion and the batch
    path keeps the platform ``stt.transcription.{chunkLengthS,strideLengthS}``
    values, which stay platform-owned precisely because they only bound the batch
    path's memory/latency envelope when no agent has spoken.
    """

    OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset(
        {"chunk_length_sec", "stride_length_sec"}
    )

    language_mode: str | None
    code_switching: bool
    word_timestamps: bool
    beam_size: int | None
    temperature: float | None
    vad_filter: bool
    chunk_length_sec: float | None = None
    stride_length_sec: tuple[int, int] | None = None


class AsrSpecPunctuation(_Wire):
    enabled: bool


class AsrSpecPostProcessing(_Wire):
    punctuation: AsrSpecPunctuation
    disfluency: bool
    stabilizer: bool
    merge: bool


class AsrSpecStreamingSemantic(_Wire):
    """Tuning for ``endpointing == "semantic"``.

    These four fields REPLACE the platform family
    ``stt.semanticEndpoint.{minSilenceMs,maxSilenceMs,confidenceThreshold,minWords}``
    that TASK-877 deleted. A ``None`` member keeps the :class:`EndpointConfig`
    default — the dataclass stays the one source of engine defaults.
    """

    min_silence_ms: int | None = None
    max_silence_ms: int | None = None
    confidence_threshold: float | None = None
    min_words: int | None = None


class AsrSpecStreaming(_Wire):
    OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset({"semantic"})

    partial_interval_ms: int | None
    endpointing: Literal["fixed", "semantic"]
    max_utterance_sec: int | None
    semantic: AsrSpecStreamingSemantic | None = None


class AsrSpecInstruction(_Wire):
    initial_prompt: str | None
    hotwords: list[str]


class AsrSpecAgent(_Wire):
    slug: str
    version_id: str
    version_number: int
    tenant_id: str
    source: Literal["explicit", "department", "tenant", "platform-default"]


class AsrSpecCore(_Wire):
    """One engine chain. ``runtime_key`` replaces ``pipeline_id`` as the runtime identity."""

    runtime_key: str
    agent: AsrSpecAgent
    models: AsrSpecModels
    audio_front_end: AsrSpecAudioFrontEnd
    decoding: AsrSpecDecoding
    post_processing: AsrSpecPostProcessing
    streaming: AsrSpecStreaming
    instruction: AsrSpecInstruction


class AsrSpecFallback(_Wire):
    kind: Literal["none", "agent", "model"]
    auto_switch: bool
    switch_after_consecutive_failures: int = Field(ge=1)
    spec: AsrSpecCore | None


class ResolvedAsrSpec(AsrSpecCore):
    schema_version: Literal[1]
    fallback: AsrSpecFallback


# ---------------------------------------------------------------------------
# Mapping onto the runtime dataclasses
# ---------------------------------------------------------------------------

_DENOISE_STRENGTH: dict[str, float] = {"low": 0.3, "medium": 0.5, "high": 0.8}


def _source_from_uri(uri: str) -> AiModelSource:
    if uri.startswith("s3://"):
        return AiModelSource.S3
    if uri.startswith("file://"):
        return AiModelSource.LOCAL
    return AiModelSource.HUGGINGFACE


def to_ai_model_config(model: AsrSpecModel) -> AiModelConfig:
    """The ``AiModelConfig`` the loaders take — built from the spec, not from a row."""
    try:
        model_format = AiModelFormat(model.format)
    except ValueError:
        raise UnsupportedAsrSpecError(
            f"Model '{model.slug}' has format '{model.format}', which the STT runtime does "
            "not execute (a catalogue-only format). The agent must bind an ASR-capable model."
        ) from None
    try:
        task_type = ModelTaskType(model.task_type)
    except ValueError:
        raise UnsupportedAsrSpecError(
            f"Model '{model.slug}' has task type '{model.task_type}', which the STT runtime "
            "does not load (role '{model.role}')."
        ) from None
    return AiModelConfig(
        id=f"agent-model:{model.slug}",
        tenant_id=model.tenant_id,
        slug=model.slug,
        name=model.slug,
        description=None,
        task_type=task_type,
        source=_source_from_uri(model.source_uri),
        source_uri=model.source_uri,
        source_revision=model.source_revision,
        format=model_format,
        memory_size_mb=None,
        compute_type=model.compute_type,
        download_status=(
            AiModelDownloadStatus.DOWNLOADED
            if model.local_path
            else AiModelDownloadStatus.NOT_DOWNLOADED
        ),
        local_path=model.local_path,
        downloaded_at=None,
        file_size_mb=None,
        checksum=model.checksum,
        tags=[],
    )


def _language_from_mode(decoding: AsrSpecDecoding) -> tuple[str | None, bool]:
    """(inference.language, code_switching) for a batch/default run.

    Streaming resolves the mode per ENGINE at load time (``language_modes``);
    this is the engine-independent reading a batch job — which has no session
    language-mode resolution — needs. Unknown mode ⇒ auto-detect (tuning, not
    selection, so it fails open).
    """
    code_switching = decoding.code_switching
    if not decoding.language_mode:
        return None, code_switching
    from .language_modes import get_language_mode

    try:
        mode = get_language_mode(decoding.language_mode)
    except KeyError:
        logger.warning(
            "Unknown language mode in resolved ASR spec; auto-detecting",
            language_mode=decoding.language_mode,
        )
        return None, code_switching
    return mode.primary_language, code_switching or mode.kind == "code_switch"


def _endpoint_config(core: AsrSpecCore) -> EndpointConfig:
    """``streaming.endpointing`` → the ``EndpointConfig`` the session manager reads.

    This is the wiring that makes the agent's choice mean something. Before
    TASK-877 the mapper never set ``preprocessing.endpoint``, so
    ``SessionManager._resolve_endpoint_config`` fell through to the platform
    ``stt.semanticEndpoint.*`` family every time and an agent asking for
    ``"semantic"`` still got fixed endpointing.

    ``enabled`` follows the agent's choice; the tuning block and the EOU model are
    both optional, and each unset value keeps the dataclass default.
    """
    streaming = core.streaming
    kwargs: dict[str, object] = {"enabled": streaming.endpointing == "semantic"}
    semantic = streaming.semantic
    if semantic is not None:
        if semantic.min_silence_ms is not None:
            kwargs["min_endpoint_silence_ms"] = semantic.min_silence_ms
        if semantic.max_silence_ms is not None:
            kwargs["max_endpoint_silence_ms"] = semantic.max_silence_ms
        if semantic.confidence_threshold is not None:
            kwargs["confidence_threshold"] = semantic.confidence_threshold
        if semantic.min_words is not None:
            kwargs["min_words"] = semantic.min_words
    endpointing_model = core.models.endpointing
    if endpointing_model is not None:
        kwargs["model_id"] = endpointing_model.slug
    return EndpointConfig(**kwargs)  # type: ignore[arg-type]


def pipeline_spec_from_resolved(core: AsrSpecCore) -> tuple[PipelineSpec, dict[str, AiModelConfig]]:
    """Map one engine chain onto ``PipelineSpec`` + the pre-resolved model configs.

    Returns the ``PipelineSpec`` the session manager / batch service already
    consume, and ``{slug: AiModelConfig}`` for every model the model cache must
    load — the map the runtime consults INSTEAD of ``get_model_reader()``.
    Punctuation is referenced by slug only (served by the punctuation service).

    A ``None`` tuning field keeps the dataclass default: the spec carries what
    the agent said, the dataclasses stay the one source of engine defaults.
    """
    models = core.models
    # `punctuation` and `endpointing` are deliberately absent: both are referenced
    # by slug only and loaded by their own service, never by the STT model cache.
    executable = [m for m in (models.asr, models.vad, models.denoise, models.embedding) if m]
    model_configs = {m.slug: to_ai_model_config(m) for m in executable}

    refs = ModelRefs(
        asr=ModelRef(slug=models.asr.slug),
        vad=ModelRef(slug=models.vad.slug) if models.vad else None,
        denoise=ModelRef(slug=models.denoise.slug) if models.denoise else None,
        embedding=ModelRef(slug=models.embedding.slug) if models.embedding else None,
    )

    afe = core.audio_front_end
    vad_kwargs: dict[str, object] = {"enabled": afe.vad.enabled}
    if afe.vad.threshold is not None:
        vad_kwargs["threshold"] = afe.vad.threshold
    if afe.vad.min_speech_ms is not None:
        vad_kwargs["min_speech_duration_ms"] = afe.vad.min_speech_ms
    if afe.vad.min_silence_ms is not None:
        vad_kwargs["min_silence_duration_ms"] = afe.vad.min_silence_ms
    if afe.vad.speech_pad_ms is not None:
        vad_kwargs["padding_ms"] = afe.vad.speech_pad_ms
    denoise_kwargs: dict[str, object] = {"enabled": afe.denoise.enabled}
    if afe.denoise.level in _DENOISE_STRENGTH:
        denoise_kwargs["strength"] = _DENOISE_STRENGTH[afe.denoise.level]
    preprocessing = PreprocessingConfig(
        normalize=afe.normalize,
        resample_enabled=afe.resample,
        vad=VadConfig(**vad_kwargs),  # type: ignore[arg-type]
        denoise=DenoiseConfig(**denoise_kwargs),  # type: ignore[arg-type]
        endpoint=_endpoint_config(core),
    )

    diarization_kwargs: dict[str, object] = {
        "enabled": afe.diarization.enabled,
        "backend": afe.diarization.backend,
    }
    if afe.diarization.max_speakers is not None:
        diarization_kwargs["max_speakers"] = afe.diarization.max_speakers
    if afe.diarization.match_threshold is not None:
        diarization_kwargs["match_threshold"] = afe.diarization.match_threshold
    diarization = DiarizationConfig(**diarization_kwargs)  # type: ignore[arg-type]

    decoding = core.decoding
    language, code_switching = _language_from_mode(decoding)
    inference_kwargs: dict[str, object] = {
        "language": language,
        "code_switching": code_switching,
    }
    if decoding.beam_size is not None:
        inference_kwargs["beam_size"] = decoding.beam_size
    if decoding.temperature is not None:
        inference_kwargs["temperature"] = [decoding.temperature]
    inference_kwargs["vad_filter"] = decoding.vad_filter
    if decoding.chunk_length_sec is not None:
        inference_kwargs["chunk_length_sec"] = float(decoding.chunk_length_sec)
    if decoding.stride_length_sec is not None:
        inference_kwargs["stride_length_sec"] = tuple(decoding.stride_length_sec)
    # TASK-880 — the ASR ROW's own decode window (`AiModel._metadata.asr`), which
    # replaces the platform key `stt.whisperCpp.maxAudioSeconds`. Absent ⇒ the
    # dataclass default (0.0 = no chunking guard); each chain is mapped separately,
    # so a fallback engine is never bound by the primary's window.
    asr_metadata = models.asr.metadata
    if asr_metadata is not None and asr_metadata.max_decode_window_sec is not None:
        inference_kwargs["max_decode_window_sec"] = float(asr_metadata.max_decode_window_sec)
    inference_kwargs["initial_prompt_text"] = core.instruction.initial_prompt
    inference_kwargs["hotwords"] = list(core.instruction.hotwords)
    inference = InferenceConfig(**inference_kwargs)  # type: ignore[arg-type]

    pp = core.post_processing
    postprocessing = PostprocessingConfig(
        timestamps=TimestampConfig(word_timestamps=decoding.word_timestamps),
        punctuation=PunctuationConfig(
            enabled=pp.punctuation.enabled,
            model=models.punctuation.slug if models.punctuation else None,
        ),
        remove_disfluencies=pp.disfluency,
        segment_merge=SegmentMergeConfig(enabled=True) if pp.merge else SegmentMergeConfig(),
    )

    st = core.streaming
    streaming = StreamingConfig(
        commit_policy="local_agreement_2" if pp.stabilizer else "none",
        partial_interval_s=(
            st.partial_interval_ms / 1000.0 if st.partial_interval_ms is not None else None
        ),
        max_utterance_sec=st.max_utterance_sec,
        # TASK-880 — from the ASR ROW, not the agent and no longer from
        # `stt.streaming.partialWindowS`: the partial tail should match the engine's
        # force-emit window, which is a property of the model.
        partial_window_s=(
            float(asr_metadata.partial_window_sec)
            if asr_metadata is not None and asr_metadata.partial_window_sec is not None
            else None
        ),
    )

    spec = PipelineSpec(
        version=AGENT_PIPELINE_SPEC_VERSION,
        models=refs,
        preprocessing=preprocessing,
        inference=inference,
        postprocessing=postprocessing,
        diarization=diarization,
        streaming=streaming,
    )
    return spec, model_configs


# ---------------------------------------------------------------------------
# Per-session / per-job bundle: the spec, pre-mapped, ready for the runtime
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ResolvedSpecBundle:
    """One ``ResolvedAsrSpec`` mapped onto everything the runtime consumes.

    ``pipeline_specs`` is keyed by runtime key (primary + fallback) and holds
    the MASTER copies — hand out ``copy.deepcopy`` (``pipeline_config_from_bundle``
    / the session manager's loader) because callers mutate ``inference.language``.
    ``model_configs`` is the union over both chains, keyed by slug: the map the
    runtime consults INSTEAD of the deprecated ``ModelRegistryReader``.
    """

    spec: ResolvedAsrSpec
    pipeline_specs: dict[str, PipelineSpec] = field(default_factory=dict)
    model_configs: dict[str, AiModelConfig] = field(default_factory=dict)

    @property
    def runtime_key(self) -> str:
        return self.spec.runtime_key

    @property
    def fallback_runtime_key(self) -> str | None:
        return self.spec.fallback.spec.runtime_key if self.spec.fallback.spec else None


def bundle_from_resolved(raw: dict[str, Any] | ResolvedAsrSpec) -> ResolvedSpecBundle:
    """Validate (when raw) and map a resolved spec — the ONE entry point for both runtimes."""
    spec = raw if isinstance(raw, ResolvedAsrSpec) else ResolvedAsrSpec.model_validate(raw)
    pipeline_specs: dict[str, PipelineSpec] = {}
    model_configs: dict[str, AiModelConfig] = {}
    chains: list[AsrSpecCore] = [spec]
    if spec.fallback.spec is not None:
        chains.append(spec.fallback.spec)
    for chain in chains:
        pipeline_spec, configs = pipeline_spec_from_resolved(chain)
        pipeline_specs[chain.runtime_key] = pipeline_spec
        model_configs.update(configs)
    return ResolvedSpecBundle(spec=spec, pipeline_specs=pipeline_specs, model_configs=model_configs)


def pipeline_config_from_bundle(bundle: ResolvedSpecBundle, runtime_key: str) -> PipelineConfig:
    """The ``PipelineConfig`` wrapper the batch service consumes, for one chain.

    A fresh deep copy every call; ``KeyError`` when the key is not part of the
    bundle (never a silently substituted chain).
    """
    pipeline_spec = bundle.pipeline_specs[runtime_key]
    core = bundle.spec if runtime_key == bundle.spec.runtime_key else bundle.spec.fallback.spec
    assert core is not None  # the key came from pipeline_specs, so a chain exists
    now = datetime.now(UTC)
    return PipelineConfig(
        id=runtime_key,
        tenant_id=core.agent.tenant_id,
        slug=core.agent.slug,
        name=core.agent.slug,
        description=None,
        spec=copy.deepcopy(pipeline_spec),
        tags=[],
        created_at=now,
        updated_at=now,
    )


__all__ = [
    "AGENT_PIPELINE_SPEC_VERSION",
    "RESOLVED_ASR_SPEC_SCHEMA_VERSION",
    "AsrSpecAgent",
    "AsrSpecCore",
    "AsrSpecFallback",
    "AsrSpecModel",
    "AsrSpecModelMetadata",
    "AsrSpecModels",
    "AsrSpecStreamingSemantic",
    "ResolvedAsrSpec",
    "ResolvedSpecBundle",
    "UnsupportedAsrSpecError",
    "bundle_from_resolved",
    "pipeline_config_from_bundle",
    "pipeline_spec_from_resolved",
    "to_ai_model_config",
]
