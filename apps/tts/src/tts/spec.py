"""TASK-879 — ``ResolvedTtsSpec``: the gateway-resolved speech runtime contract.

The pydantic mirror of ``packages/types/src/tts-spec.ts``. The API gateway resolves the tenant's
TEXT_TO_SPEECH Agent (TASK-863) — its registry model, that model's mirror, artifacts and voice
bindings, the ``AiProviderConnection`` row that serves its engine, and its ordered fallback chain
— and hands the WHOLE thing to this service with every synthesis request.

It REPLACES the ``TenantTtsConfig`` fold: ``routing_en`` / ``routing_ml`` / ``allowed_providers``
/ ``voice_bindings`` are gone, and with them the per-provider model ids, mirror paths, artifact
paths, endpoints, regions, timeouts and ``*_ENABLED`` flags that used to arrive as settings. This
service now reads NO selection of its own — it executes what the spec names, and refuses what the
spec does not.

Both halves of the contract validate ONE committed fixture
(``tests/contracts/resolved-tts-spec.fixture.json``) — ``tests/unit/test_resolved_spec_parity.py``
here, the vitest contract on the TypeScript side — so a shape change on either side fails the
other.

Wire shape is camelCase; ``extra='forbid'`` makes an unknown field a contract drift rather than a
silent drop. Selection fails CLOSED: a schema version this runtime does not know raises, and a
candidate whose engine the platform has not enabled (``connection is None``) is skipped rather
than routed into.
"""

from __future__ import annotations

from typing import ClassVar, Literal

from pydantic import BaseModel, ConfigDict, model_serializer
from pydantic.alias_generators import to_camel
from pydantic_core.core_schema import SerializerFunctionWrapHandler

RESOLVED_TTS_SPEC_SCHEMA_VERSION = 1

#: The output sample rate used when neither the agent nor the caller names one. Mirrors
#: ``SynthesisRequest.sample_rate``, which is the single source of that default — this module
#: never restates a runtime default it does not own.
DEFAULT_SAMPLE_RATE = 24000


class UnsupportedTtsSpecError(ValueError):
    """The spec names something this runtime cannot execute (fail closed)."""


class _Wire(BaseModel):
    """Base for every wire model: camelCase aliases, strict field set, immutable.

    ``OPTIONAL_FIELDS`` names the fields that are OMITTED from the wire when they
    are ``None``, rather than serialised as ``null``. That distinction is
    load-bearing, not cosmetic: this model is ``extra='forbid'``, so a key the
    other half has not learned yet is a CONTRACT DRIFT. Omitting an unset optional
    lets a field be added on either side first — the gateway may send it or not,
    and either way the bytes round-trip against the committed fixture — which is
    what makes the two halves independently deployable. A field that is always
    present and merely nullable (``baseUrl``, ``region``, …) does NOT belong in
    this set: for those, ``null`` is the resolver's "no value" and must survive
    the round trip.

    Same mechanism, same wording as ``stt.pipeline.spec._Wire`` (TASK-944); the
    two ASR/TTS mirrors face the identical two-sided-deploy problem.
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


TtsFunding = Literal["tenant", "platform"]
TtsCandidateKind = Literal["primary", "fallback-agent", "fallback-model", "platform-default"]
TtsSpecModelRole = Literal["primary", "fallback"]


class TtsVoiceBinding(_Wire):
    """One selectable voice on a bound model, resolved from ``AiModel._metadata.voices``."""

    id: str
    locale: str | None
    #: The engine-native name when it differs from ``id``. ``None`` ⇒ the id IS the name.
    provider_voice: str | None
    #: Voice-CLONE conditioning (IndicF5). A property of the VOICE, not of the service.
    ref_audio_path: str | None
    ref_text: str | None

    @property
    def engine_voice(self) -> str:
        """What actually goes to the engine."""
        return self.provider_voice or self.id


class TtsSpecModel(_Wire):
    """One resolved registry row — the fields the engines consume."""

    role: TtsSpecModelRole
    slug: str
    task_type: str
    format: str
    source_uri: str
    source_revision: str | None
    local_path: str | None
    checksum: str | None
    compute_type: str | None
    #: The ENGINE id this service registers (``kokoro``, ``indic_parler``, ``azure``, …).
    provider: str | None
    tenant_id: str
    #: Auxiliary loader paths beside the weights (today: ``descEncoderPath``).
    artifacts: dict[str, str]
    voices: list[TtsVoiceBinding]

    def voice(self, voice_id: str | None) -> TtsVoiceBinding | None:
        """The binding for ``voice_id``, or ``None`` when this model cannot speak it."""
        if not voice_id:
            return None
        for binding in self.voices:
            if binding.id == voice_id:
                return binding
        return None


class TtsSpecParameters(_Wire):
    """The agent's parameters. ``None`` = the agent said nothing, so this service's default stands."""

    voice: str | None
    language: str | None
    speed: float | None
    format: str | None
    sample_rate: int | None
    ssml: bool


class TtsSpecConnection(_Wire):
    """The NON-SECRET half of the ``AiProviderConnection`` row that serves this engine.

    Present at all ⇒ an ENABLED row answered at some tier, which is the platform's "this engine
    may serve". The credential itself never rides here — it arrives as ``provider_overrides``.
    """

    OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset({"connection_id", "connection_slug"})

    provider: str
    base_url: str | None
    region: str | None
    timeout_s: int | None
    funding: TtsFunding
    #: TASK-958 — WHICH connection row of this provider answered. A tenant may now hold
    #: several rows for one ``(service, provider)``; ``provider`` alone no longer names
    #: one. ``connection_id`` is what the usage ledger attributes the spend to (D-7) and
    #: ``connection_slug`` is the tenant-chosen name it is recognised by. Both OPTIONAL
    #: (omit-when-absent): a gateway that predates the field sends neither, and the row
    #: it resolved is that provider's DEFAULT connection — exactly today's behaviour.
    connection_id: str | None = None
    connection_slug: str | None = None


class TtsSpecAgent(_Wire):
    """Which agent version produced a candidate, and how it was chosen."""

    slug: str
    version_id: str
    version_number: int
    tenant_id: str
    source: str


class ResolvedTtsCandidate(_Wire):
    """One runnable engine choice."""

    OPTIONAL_FIELDS: ClassVar[frozenset[str]] = frozenset({"connection_key"})

    kind: TtsCandidateKind
    runtime_key: str
    agent: TtsSpecAgent
    model: TtsSpecModel
    parameters: TtsSpecParameters
    #: The binding ``parameters.voice`` selected on the bound model.
    voice: TtsVoiceBinding | None
    connection: TtsSpecConnection | None
    funding_tier: TtsFunding
    #: TASK-958 — the key this candidate's credential arrives under in
    #: ``provider_overrides``: the tenant connection's ``slug`` for a tenant row, the
    #: provider/engine name for a platform row. It exists because two candidates in one
    #: chain may name the SAME engine on DIFFERENT accounts, which a provider-keyed map
    #: cannot express: both would read one entry and the failover would spend the key
    #: that just failed. ``None`` ⇒ a sender that predates the field, and the reader
    #: falls back to the engine name, which is what it has always done.
    connection_key: str | None = None

    @property
    def engine(self) -> str | None:
        return self.model.provider

    @property
    def routable(self) -> bool:
        """Whether this candidate may be routed to at all.

        Two conditions, both fail-closed. The engine must be NAMED (a registry row with no
        resolvable engine id cannot select a loader), and an ENABLED connection row must have
        answered for it — which is exactly what ``tts.<engine>.enabled`` used to say and is now a
        super-admin write on the row instead of a boot flag.
        """
        return bool(self.model.provider) and self.connection is not None

    def sample_rate(self) -> int:
        return self.parameters.sample_rate or DEFAULT_SAMPLE_RATE

    def binding_for(self, voice_id: str | None) -> TtsVoiceBinding | None:
        """The voice this candidate would speak: the caller's if it names one, else the agent's."""
        return self.model.voice(voice_id) if voice_id else self.voice


class ResolvedTtsFallback(_Wire):
    """The EFFECTIVE switch decision (already funding-gated by the gateway) and the ordered chain."""

    auto_switch: bool
    chain: list[ResolvedTtsCandidate]


class ResolvedTtsSpec(_Wire):
    schema_version: int
    agent: TtsSpecAgent
    primary: ResolvedTtsCandidate
    fallback: ResolvedTtsFallback


def candidate_chain(
    spec: ResolvedTtsSpec, *, voice_id: str | None = None
) -> list[ResolvedTtsCandidate]:
    """The ordered candidates this request may actually run, in failover order.

    Three filters, and each one is a decision the GATEWAY already made that this service must not
    second-guess:

    * ``auto_switch`` false ⇒ the primary and nothing else. The gateway emits the EFFECTIVE value
      (a tenant may only switch off HA for a primary it funds), so this is read verbatim.
    * ``routable`` ⇒ an enabled connection row answered for the engine. A candidate the platform
      has not enabled is walked past, not routed into.
    * the VOICE must be speakable by the candidate's own model. Failing over to an engine that
      cannot say the requested voice would substitute a different voice mid-request, which is the
      one thing a speech runtime must never do silently.
    """
    if spec.schema_version != RESOLVED_TTS_SPEC_SCHEMA_VERSION:
        raise UnsupportedTtsSpecError(
            f"resolved TTS spec schemaVersion {spec.schema_version} is not supported by this runtime "
            f"(expected {RESOLVED_TTS_SPEC_SCHEMA_VERSION})"
        )
    ordered = (
        [spec.primary] if not spec.fallback.auto_switch else [spec.primary, *spec.fallback.chain]
    )
    return [
        candidate
        for candidate in ordered
        if candidate.routable and candidate.binding_for(voice_id) is not None
    ]
