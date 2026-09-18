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
from typing import Annotated, Any, ClassVar, Literal

import structlog
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    StringConstraints,
    model_serializer,
)
from pydantic.alias_generators import to_camel

from ..models.cache import DENOISE_ENGINE_BY_LIBRARY
from .dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    DenoiseConfig,
    DiarizationConfig,
    EndpointConfig,
    InferenceConfig,
    LexiconConfig,
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


class UnsupportedDenoiseEngineError(UnsupportedAsrSpecError):
    """A bound denoise row whose serving library names no denoise engine (fail closed)."""


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
    def _omit_unset_optionals(self, handler: SerializerFunctionWrapHandler) -> dict[str, object]:
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

#: TASK-934 / TASK-985 — the mirror of ``AsrSpecDecodingSource`` in ``@arcaai/types``:
#: which tier supplied a contested knob, or ``unsupported:<library>`` when a tier decided a
#: value the chain's engine cannot honour at all. Constrained rather than free ``str`` so a
#: typo on the gateway side is a validation error here, exactly as the old ``Literal`` was.
AsrSpecDecodingSource = Annotated[
    str, StringConstraints(pattern=r"^(agent|model|unsupported:[A-Za-z0-9._+-]+)$")
]


class AsrSpecDecodingPass(_Wire):
    """TASK-985 (QW-8) — decode overrides for ONE pass (``partial`` or ``final``).

    A strict SUBSET of the flat decode block: only knobs a decoder reads per call may be
    narrowed per pass. ``condition_on_prev_tokens``, ``no_repeat_ngram_size``,
    ``prev_text_context_words`` and ``compression_ratio_threshold`` are session- or
    engine-level policy, so narrowing them per pass would promise what no decoder delivers.

    Precedence, applied by the adapter because it is the only half that knows which pass it
    is decoding: **this block → the flat block → the dataclass default.** Every member is
    optional and omitted when unset, so "narrowed nothing" has one encoding.
    """

    OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset(
        {
            "beam_size",
            "temperature",
            "logprob_threshold",
            "entropy_threshold",
            "no_speech_threshold",
            "single_segment",
            "suppress_blank",
            "suppress_non_speech_tokens",
            "max_tokens",
            "audio_ctx",
        }
    )

    beam_size: int | None = None
    temperature: float | None = None
    logprob_threshold: float | None = None
    entropy_threshold: float | None = None
    no_speech_threshold: float | None = None
    single_segment: bool | None = None
    suppress_blank: bool | None = None
    suppress_non_speech_tokens: bool | None = None
    max_tokens: int | None = None
    audio_ctx: int | None = None


class AsrSpecModelProfileDecoding(_Wire):
    """TASK-934 — the decode knobs an ASR ROW recommends (``AiModel._metadata.asr.decoding``).

    PROVENANCE, not instruction. The EFFECTIVE values are in :class:`AsrSpecDecoding`,
    already folded by the gateway (agent → this profile → absent, OD-3), and
    ``decoding.sources`` names which tier won. This block is carried so one dumped
    session spec explains itself: what the row asked for is visible beside what ran.

    The runtime must never read it as an argument. Every member is optional and omitted
    when unset, so a row that recommends one knob does not imply an opinion on the rest.
    """

    OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset(
        {
            "beam_size",
            "temperature",
            "no_speech_threshold",
            "compression_ratio_threshold",
            "logprob_threshold",
            "condition_on_prev_tokens",
            "no_repeat_ngram_size",
            "prev_text_context_words",
            "hotwords",
            "hotwords_in_prompt",
            "entropy_threshold",
            "single_segment",
            "suppress_blank",
            "suppress_non_speech_tokens",
            "max_tokens",
            "audio_ctx",
            "partial",
            "final",
        }
    )

    beam_size: int | None = None
    temperature: float | None = None
    no_speech_threshold: float | None = None
    compression_ratio_threshold: float | None = None
    logprob_threshold: float | None = None
    condition_on_prev_tokens: bool | None = None
    no_repeat_ngram_size: int | None = None
    prev_text_context_words: int | None = None
    hotwords: list[str] | None = None
    #: TASK-985 (QW-9) — whisper.cpp's ``entropy_thold``. NOT an alias of
    #: ``compression_ratio_threshold`` above: same default (2.4), opposite direction,
    #: different scale. Aliasing them would silently mean the opposite thing.
    entropy_threshold: float | None = None
    #: TASK-985 (QW-8) — the whisper.cpp decode extras, flat (both passes) …
    single_segment: bool | None = None
    suppress_blank: bool | None = None
    suppress_non_speech_tokens: bool | None = None
    max_tokens: int | None = None
    audio_ctx: int | None = None
    #: … and narrowed per pass. Carried here as PROVENANCE like everything else in this
    #: class: the effective values are in ``decoding.partial`` / ``decoding.final``.
    partial: AsrSpecDecodingPass | None = None
    final: AsrSpecDecodingPass | None = None
    #: TASK-946 (OD-1) — the row's own recommendation for the hotword-prompt switch.
    #: Provenance only, like every other member here; the EFFECTIVE value is
    #: ``decoding.hotwords_in_prompt``, already folded by the gateway.
    hotwords_in_prompt: bool | None = None


class AsrSpecModelMetadata(_Wire):
    """TASK-880 / TASK-934 — the ``AiModel._metadata.asr`` decode profile that rides the row.

    ``stt.whisperCpp.maxAudioSeconds`` and ``stt.streaming.partialWindowS`` were
    PLATFORM keys: one number applied to every session whatever engine served it, and
    unchangeable without a control-plane write. They describe a MODEL — the ml-en
    fine-tune is accurate to ~6-7s, the CT2 turbo row is not — so they belong to the row,
    and a fallback chain now decodes on its own window instead of the primary's.

    TASK-934 widened the same slot into the profile a registered FINE-TUNE carries: the
    parameters it was measured with travel with its weights, so a quantisation swap can
    never silently change decode geometry again. Two members changed meaning:

    * ``partial_window_sec`` is the EFFECTIVE tail, not merely the row's — an agent that
      sets ``parameters.streaming.partialWindowSec`` (OD-4) overrides the row and the
      gateway resolves it HERE, so this runtime reads it exactly where it always did;
    * ``decoding`` / ``initial_prompt`` are the row's RAW recommendation, provenance only.

    ``max_decode_window_sec`` is still the row's alone (OD-3: decode geometry is a
    property of the weights). Every member is optional: absent means nothing was declared
    and the runtime's own dataclass default stands
    (``InferenceConfig.max_decode_window_sec``, ``StreamingPreprocessor``'s partial window).
    """

    OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset(
        {"max_decode_window_sec", "partial_window_sec", "decoding", "initial_prompt"}
    )

    max_decode_window_sec: float | None = None
    partial_window_sec: float | None = None
    decoding: AsrSpecModelProfileDecoding | None = None
    initial_prompt: str | None = None


class AsrSpecModel(_Wire):
    """One resolved registry row — the fields the model loaders consume."""

    OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset({"metadata", "library_name"})

    role: AsrSpecModelRole
    slug: str
    task_type: str
    format: str
    #: TASK-944 (B2) — ``AiModel.libraryName``, the loader-SELECTION field since
    #: TASK-860; ``format`` beside it has been descriptive ever since. OPTIONAL
    #: (omit-when-absent) so the gateway and this service stay independently
    #: deployable against ``extra='forbid'``: absent means the sender predates the
    #: field and ``ModelCache`` falls back to the ``format`` key, exactly as before.
    library_name: str | None = None
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
    # The only backend. The key stays so a future one needs no shape change; the NeMo
    # sortformer backend was retired by TASK-980, so a spec still naming it fails here.
    backend: Literal["embedding"]
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
        {
            "chunk_length_sec",
            "stride_length_sec",
            "no_speech_threshold",
            "compression_ratio_threshold",
            "logprob_threshold",
            "condition_on_prev_tokens",
            "no_repeat_ngram_size",
            "prev_text_context_words",
            "hotwords_in_prompt",
            "entropy_threshold",
            "single_segment",
            "suppress_blank",
            "suppress_non_speech_tokens",
            "max_tokens",
            "audio_ctx",
            "partial",
            "final",
            "sources",
        }
    )

    language_mode: str | None
    code_switching: bool
    word_timestamps: bool
    beam_size: int | None
    temperature: float | None
    vad_filter: bool
    chunk_length_sec: float | None = None
    stride_length_sec: tuple[int, int] | None = None
    #: TASK-934 (G-2) — the six knobs that were LITERALS on :class:`InferenceConfig`
    #: with no wire field, no agent-schema key and no settings descriptor: one number
    #: for every agent and every tenant on the box. The gateway resolves them agent →
    #: model profile → absent (OD-3) and sends only what it decided; ABSENT still means
    #: "nobody spoke", so the dataclass default stands and this runtime keeps being the
    #: one source of engine defaults.
    no_speech_threshold: float | None = None
    compression_ratio_threshold: float | None = None
    logprob_threshold: float | None = None
    condition_on_prev_tokens: bool | None = None
    no_repeat_ngram_size: int | None = None
    prev_text_context_words: int | None = None
    #: TASK-946 (OD-1), the TASK-937 R-4 switch — may the engine append
    #: ``instruction.hotwords`` to its decoder prompt? Resolved by the gateway on the
    #: same two tiers as the knobs above; ABSENT means neither spoke, so
    #: :class:`InferenceConfig`'s default stands, and for whisper.cpp that default is
    #: OFF. It gates the PROMPT only — the terms still reach the lexicon stage.
    hotwords_in_prompt: bool | None = None
    #: TASK-985 (QW-9) — whisper.cpp's ``entropy_thold``. A DISTINCT gate from
    #: ``compression_ratio_threshold`` above, never an alias of it.
    entropy_threshold: float | None = None
    #: TASK-985 (QW-8) — the whisper.cpp decode extras, applied to BOTH passes …
    single_segment: bool | None = None
    suppress_blank: bool | None = None
    suppress_non_speech_tokens: bool | None = None
    max_tokens: int | None = None
    audio_ctx: int | None = None
    #: … and the two per-pass narrowings, already folded agent → row by the gateway.
    #: Precedence at DECODE time is pass → flat → dataclass default, and the adapter
    #: applies it because it is the only half that knows which pass it is running.
    partial: AsrSpecDecodingPass | None = None
    final: AsrSpecDecodingPass | None = None
    #: TASK-934 — which TIER supplied each contested knob (``"agent"`` = the agent's
    #: parameters, ``"model"`` = the ASR row's profile), keyed by the WIRE name. Also
    #: covers ``hotwords``, ``initialPrompt`` and ``partialWindowSec``, which travel in
    #: ``instruction`` / ``models.asr.metadata`` but are decided by the same precedence.
    #:
    #: TASK-985 (M-14) adds a THIRD answer that is not a tier: ``unsupported:<library>``
    #: means a tier DID decide the value and the engine this chain runs cannot honour it,
    #: so naming a tier would be a lie (``sources.beamSize: "agent"`` described a beam
    #: width inert under the greedy whisper.cpp context every loader builds). The VALUE
    #: still arrives verbatim — this map is provenance, not a filter. Per-pass knobs are
    #: keyed by their dotted path (``final.maxTokens``).
    #:
    #: OBSERVABILITY ONLY — never branch on it; the values themselves are already folded.
    sources: dict[str, AsrSpecDecodingSource] | None = None


class AsrSpecPunctuation(_Wire):
    enabled: bool


class AsrSpecLexicon(_Wire):
    """TASK-935 (OD-2 a) — the clinical-vocabulary correction stage.

    Note what is ABSENT: the terms. They are ``instruction.hotwords``, resolved once
    by the gateway (agent → the ASR row's ``decoding.hotwords``) and consumed twice —
    as decoder prompt bias, and by this stage (OD-5 a). A ``terms`` member here would
    be a second list on one wire, free to disagree with the first.

    ``max_distance`` is omitted when the agent did not tune it, leaving
    :data:`stt.postprocessing.lexicon.DEFAULT_MAX_DISTANCE` as the one source of that
    default — the same rule every other tuning field on this wire follows.
    """

    OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset({"max_distance"})

    enabled: bool
    max_distance: float | None = None


class AsrSpecPostProcessing(_Wire):
    #: TASK-935 — ``lexicon`` is OMITTED when the agent expressed no opinion. Absence is
    #: load-bearing twice over: this model is ``extra='forbid'`` (so the two halves must
    #: be able to omit a field the other has not learned), and the runtime's default for
    #: an absent block is CONDITIONAL — the stage runs exactly when the resolved hotword
    #: list is non-empty, which no single value in this position could express.
    OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset({"lexicon"})

    punctuation: AsrSpecPunctuation
    disfluency: bool
    stabilizer: bool
    merge: bool
    lexicon: AsrSpecLexicon | None = None


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

    OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset(
        {"connection_id", "connection_slug", "connection_key"}
    )

    runtime_key: str
    #: TASK-958 — WHICH ``AiProviderConnection`` row serves this chain's engine, and the
    #: key its credential arrives under in ``provider_overrides``.
    #:
    #: A tenant may now hold several connections for one ``(service, provider)``, so the
    #: provider id no longer names a row: two chains can name the SAME cloud engine on
    #: DIFFERENT accounts, and a provider-keyed credential map would hand both the same
    #: entry — a failover that spends the key that just failed. ``connection_key`` (the
    #: tenant connection's ``slug``; the provider id for a platform row) is what the
    #: loaders read their entry under, and ``connection_id`` is what the usage ledger
    #: attributes the spend to.
    #:
    #: All three are OPTIONAL (omit-when-absent): a gateway that predates them sends
    #: none, the loaders fall back to the provider id, and the row that answered is that
    #: provider's DEFAULT connection — byte-for-byte today's behaviour.
    connection_id: str | None = None
    connection_slug: str | None = None
    connection_key: str | None = None
    agent: AsrSpecAgent
    models: AsrSpecModels
    audio_front_end: AsrSpecAudioFrontEnd
    decoding: AsrSpecDecoding
    post_processing: AsrSpecPostProcessing
    streaming: AsrSpecStreaming
    instruction: AsrSpecInstruction


class AsrSpecFallback(_Wire):
    """TASK-985 (M-49) — the ORDERED fallback chain, whole.

    It used to lose every entry after the first: the gateway resolved the agent's
    ``AgentModelFallback`` rows, took ``chain[0]`` and dropped the rest with no diagnostic.
    The survivor was the q8_0 quantisation of the f16 primary — same weights, same failure
    modes — so a failure that took the primary out ended the chain, and the genuinely
    different engine declared behind it was unreachable configuration.

    ``spec`` is kept for ONE release as ``chain[0]`` so the gateway, this service and the
    committed contract fixture can ship in either order; read :func:`fallback_chain`, which
    accepts both encodings, rather than either field directly.
    """

    kind: Literal["none", "agent", "model"]
    auto_switch: bool
    switch_after_consecutive_failures: int = Field(ge=1)
    #: Every fallback engine, in switch order. Empty for ``kind == "none"``; exactly one
    #: entry for ``kind == "agent"`` (naming a fallback agent is the explicit choice and
    #: SUPERSEDES the model chain rather than extending it). Defaulted rather than required
    #: so a gateway that predates the field still validates.
    chain: list[AsrSpecCore] = Field(default_factory=list)
    #: .. deprecated:: TASK-985
    #:     ``chain[0]``. Removed with the R4 sweep; registered in the deprecation register.
    spec: AsrSpecCore | None = None


class ResolvedAsrSpec(AsrSpecCore):
    schema_version: Literal[1]
    fallback: AsrSpecFallback


# ---------------------------------------------------------------------------
# Mapping onto the runtime dataclasses
# ---------------------------------------------------------------------------

_DENOISE_STRENGTH: dict[str, float] = {"low": 0.3, "medium": 0.5, "high": 0.8}

#: TASK-934 — ``AsrSpecDecoding`` field → the ``InferenceConfig`` field it feeds. Both
#: spellings are snake_case and identical today; the pairs are written out anyway so a
#: rename on either side is a visible edit rather than a silently dropped knob.
_TASK934_DECODING_FIELDS: tuple[tuple[str, str], ...] = (
    ("no_speech_threshold", "no_speech_threshold"),
    ("compression_ratio_threshold", "compression_ratio_threshold"),
    ("logprob_threshold", "logprob_threshold"),
    ("condition_on_prev_tokens", "condition_on_prev_tokens"),
    ("no_repeat_ngram_size", "no_repeat_ngram_size"),
    ("prev_text_context_words", "prev_text_context_words"),
    # TASK-985 (QW-9) — whisper.cpp's own degenerate-decode gate, a peer of the two
    # thresholds above and deliberately NOT an alias of `compression_ratio_threshold`.
    ("entropy_threshold", "entropy_threshold"),
)

#: TASK-985 (QW-8) — ``AsrSpecDecoding`` field → the whisper.cpp **kwarg** it becomes.
#:
#: These land in ``InferenceConfig.decode_base`` rather than as named dataclass fields,
#: because they are engine-specific decoder kwargs rather than cross-engine concepts: the
#: adapter merges them straight into its call and never maps a name. Naming them here — at
#: the wire → runtime boundary that already owns ``_TASK934_DECODING_FIELDS`` — is what keeps
#: the spelling change in ONE place.
_TASK985_DECODE_EXTRA_FIELDS: tuple[tuple[str, str], ...] = (
    ("single_segment", "single_segment"),
    ("suppress_blank", "suppress_blank"),
    ("suppress_non_speech_tokens", "suppress_nst"),
    ("max_tokens", "max_tokens"),
    ("audio_ctx", "audio_ctx"),
)

#: TASK-985 (QW-8) — ``AsrSpecDecodingPass`` field → whisper.cpp kwarg, for the two per-pass
#: dicts. A superset of the table above: a pass may also narrow the thresholds and the beam.
_TASK985_PASS_FIELDS: tuple[tuple[str, str], ...] = (
    ("beam_size", "beam_size"),
    ("temperature", "temperature"),
    ("logprob_threshold", "logprob_thold"),
    ("entropy_threshold", "entropy_thold"),
    ("no_speech_threshold", "no_speech_thold"),
    *_TASK985_DECODE_EXTRA_FIELDS,
)


def _decode_pass_kwargs(block: AsrSpecDecodingPass | None) -> dict[str, float | int | bool]:
    """One per-pass block, in the engine's own kwarg spelling. Absent members stay absent."""
    if block is None:
        return {}
    out: dict[str, float | int | bool] = {}
    for wire_field, engine_kwarg in _TASK985_PASS_FIELDS:
        value = getattr(block, wire_field)
        if value is not None:
            out[engine_kwarg] = value
    return out


def fallback_chain(spec: ResolvedAsrSpec) -> list[AsrSpecCore]:
    """TASK-985 (M-49) — the fallback chain, however the sender encoded it.

    ``fallback.chain`` is the contract; ``fallback.spec`` is its one-release alias for
    ``chain[0]``, so a gateway that predates the chain still yields a one-entry list here and
    the two halves stay independently deployable. Read this, never either field.
    """
    if spec.fallback.chain:
        return list(spec.fallback.chain)
    return [spec.fallback.spec] if spec.fallback.spec is not None else []


def _source_from_uri(uri: str) -> AiModelSource:
    if uri.startswith("s3://"):
        return AiModelSource.S3
    if uri.startswith("file://"):
        return AiModelSource.LOCAL
    return AiModelSource.HUGGINGFACE


def to_ai_model_config(
    model: AsrSpecModel,
    *,
    connection_key: str | None = None,
    connection_id: str | None = None,
) -> AiModelConfig:
    """The ``AiModelConfig`` the loaders take — built from the spec, not from a row.

    ``connection_key`` / ``connection_id`` belong to the CHAIN (``AsrSpecCore``), not to
    the model row, and are stamped onto every config the chain produces: the loader is
    handed a model config and nothing else, so this is how it learns which of a tenant's
    connections it must authenticate as (TASK-958).
    """
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
        # TASK-944 (B2) — the DECLARED loader-selection key. Unvalidated here on
        # purpose: `ModelCache.loader_for` owns the vocabulary and fails closed on
        # a library it has no loader for, so a catalogue that grows a library this
        # runtime cannot serve is reported by name rather than mapped to a guess.
        library_name=model.library_name,
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
        connection_key=connection_key,
        connection_id=connection_id,
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


def _denoise_engine(model: AsrSpecModel | None) -> str | None:
    """The denoise engine the agent's bound row selects; ``None`` when no row is bound.

    TASK-977 — both engines are runtime-owned and chosen by NAME, so the row's declared
    ``library_name`` is the only thing that can carry the agent's choice. No row is a
    legitimate state (an engine that ships in its wheel needs none) and keeps the
    ``DenoiseConfig`` default. A row whose library names no denoise engine — including a
    row that declares none, since ``format`` cannot tell the two engines apart — FAILS
    CLOSED: running RNNoise in place of the engine the admin bound is a wrong answer.
    """
    if model is None:
        return None
    library = (model.library_name or "").strip()
    engine = DENOISE_ENGINE_BY_LIBRARY.get(library)
    if engine is None:
        declared = f"serving library '{library}'" if library else "no serving library"
        raise UnsupportedDenoiseEngineError(
            f"Denoise model '{model.slug}' declares {declared}, which names no denoise "
            "engine this runtime runs. Known denoise libraries: "
            f"{sorted(DENOISE_ENGINE_BY_LIBRARY)}. The engine is never guessed."
        )
    return engine


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
    model_configs = {
        m.slug: to_ai_model_config(
            m, connection_key=core.connection_key, connection_id=core.connection_id
        )
        for m in executable
    }

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
    denoise_engine = _denoise_engine(models.denoise)
    if denoise_engine is not None:
        denoise_kwargs["engine"] = denoise_engine
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
    # TASK-934 (G-2) — the six knobs that used to be literals on `InferenceConfig`. The
    # gateway already applied the precedence (agent → the ASR row's profile → absent), so
    # there is nothing to resolve here: forward what arrived, and forward NOTHING when a
    # key is absent, which is what leaves the dataclass default standing as the one source
    # of engine defaults. `decoding.sources` rides alongside as provenance and is
    # deliberately not read — the values it explains are already folded.
    for _wire_field, _inference_field in _TASK934_DECODING_FIELDS:
        _value = getattr(decoding, _wire_field)
        if _value is not None:
            inference_kwargs[_inference_field] = _value
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
    # TASK-946 (OD-1) — the hotword-prompt switch, forwarded only when a tier decided
    # it. Absence leaves `InferenceConfig.hotwords_in_prompt` (False) standing, which
    # is what keeps whisper.cpp's decoder prompt free of the vocabulary that collapsed
    # the ml-en fine-tune's script. The TERMS above are forwarded either way: the
    # lexicon stage below binds the same list.
    if decoding.hotwords_in_prompt is not None:
        inference_kwargs["hotwords_in_prompt"] = decoding.hotwords_in_prompt
    # TASK-985 (QW-8) — the whisper.cpp decode extras, in the engine's own kwarg spelling so
    # the adapter merges rather than maps. `decode_base` applies to both passes; the two pass
    # dicts NARROW it, and the adapter applies that precedence because it is the only half
    # that knows which pass it is decoding. An absent member stays absent all the way down,
    # which is what leaves the library's own default standing.
    decode_base: dict[str, float | int | bool] = {}
    for _wire_field, _engine_kwarg in _TASK985_DECODE_EXTRA_FIELDS:
        _value = getattr(decoding, _wire_field)
        if _value is not None:
            decode_base[_engine_kwarg] = _value
    if decode_base:
        inference_kwargs["decode_base"] = decode_base
    _partial = _decode_pass_kwargs(decoding.partial)
    if _partial:
        inference_kwargs["decode_partial"] = _partial
    _final = _decode_pass_kwargs(decoding.final)
    if _final:
        inference_kwargs["decode_final"] = _final
    inference = InferenceConfig(**inference_kwargs)  # type: ignore[arg-type]

    pp = core.post_processing
    # TASK-935 (OD-2 a / OD-5 a) — the correction stage's vocabulary is the hotword list
    # that already primed the decoder, bound here rather than sent twice. The agent's
    # SILENCE is resolved here too, and it is conditional on that vocabulary: a term named
    # for the decoder is one the clinician expects to read back, so an agent that says
    # nothing gets the stage exactly when it configured terms. An explicit `enabled: false`
    # is a veto and survives a non-empty list.
    lexicon_terms = list(core.instruction.hotwords)
    lexicon = LexiconConfig(
        enabled=pp.lexicon.enabled if pp.lexicon is not None else bool(lexicon_terms),
        max_distance=pp.lexicon.max_distance if pp.lexicon is not None else None,
        terms=lexicon_terms,
    )
    postprocessing = PostprocessingConfig(
        timestamps=TimestampConfig(word_timestamps=decoding.word_timestamps),
        punctuation=PunctuationConfig(
            enabled=pp.punctuation.enabled,
            model=models.punctuation.slug if models.punctuation else None,
        ),
        remove_disfluencies=pp.disfluency,
        segment_merge=SegmentMergeConfig(enabled=True) if pp.merge else SegmentMergeConfig(),
        lexicon=lexicon,
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
    def fallback_runtime_keys(self) -> list[str]:
        """TASK-985 (M-49) — every fallback engine's runtime key, in switch order."""
        return [core.runtime_key for core in fallback_chain(self.spec)]

    @property
    def fallback_runtime_key(self) -> str | None:
        """.. deprecated:: TASK-985 — the FIRST fallback only; read :attr:`fallback_runtime_keys`."""
        keys = self.fallback_runtime_keys
        return keys[0] if keys else None


def bundle_from_resolved(raw: dict[str, Any] | ResolvedAsrSpec) -> ResolvedSpecBundle:
    """Validate (when raw) and map a resolved spec — the ONE entry point for both runtimes."""
    spec = raw if isinstance(raw, ResolvedAsrSpec) else ResolvedAsrSpec.model_validate(raw)
    pipeline_specs: dict[str, PipelineSpec] = {}
    model_configs: dict[str, AiModelConfig] = {}
    # TASK-985 (M-49) — the WHOLE ordered chain, not just its head. The loop below was
    # already generic; what was missing was everything after `fallback.spec`.
    chains: list[AsrSpecCore] = [spec, *fallback_chain(spec)]
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
    core = next(
        (c for c in (bundle.spec, *fallback_chain(bundle.spec)) if c.runtime_key == runtime_key),
        None,
    )
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
    "AsrSpecDecodingPass",
    "AsrSpecDecodingSource",
    "AsrSpecFallback",
    "AsrSpecModel",
    "AsrSpecModelMetadata",
    "AsrSpecModels",
    "AsrSpecStreamingSemantic",
    "ResolvedAsrSpec",
    "ResolvedSpecBundle",
    "UnsupportedAsrSpecError",
    "UnsupportedDenoiseEngineError",
    "bundle_from_resolved",
    "fallback_chain",
    "pipeline_config_from_bundle",
    "pipeline_spec_from_resolved",
    "to_ai_model_config",
]
