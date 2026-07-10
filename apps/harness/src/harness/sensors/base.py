"""Sensor framework contracts for the clinical-documentation harness gate.

Phase-1 sensors are **pure and deterministic** — they make **no model calls**
and operate only on the :class:`SensorContext` the durable loop hands them. Each
sensor implements the :class:`Sensor` protocol (a ``name`` + a sync ``run``) and
returns a :class:`SensorResult`. The verdict aggregator
(:mod:`harness.sensors.aggregator`) folds those results into a fail-safe gate
decision. (Inferential sensors — MiniCheck groundedness, Llama-Guard safety, a
reasoning judge — are a Phase-2 extension under :mod:`harness.sensors.inferential`
and implement this same protocol.)

**Why two entity lists.** The NLP contract NER shape is ``{text, type, start,
end}``. Faithfulness needs the entities asserted in the *note*; coverage/omission
needs the entities present in the *transcript*. The persisted data model already
distinguishes these — a ``NamedEntity`` row carries both the note
``contextItemId`` and a ``transcriptContextItemId`` span — so the context
exposes them as two same-shape lists (``note_entities`` / ``transcript_entities``).
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field

# SentencePiece "▁" (U+2581) word-boundary marker. The live NER returns
# ▁-bearing subword surfaces ("▁amlodipine"); it must be stripped so the
# entity-level matching path compares like-with-like against the plain SOAP
# section / transcript text (the claims path strips it too — single behaviour).
SUBWORD_MARKER = "\u2581"


def normalize_text(text: str) -> str:
    """Case-fold, strip ``▁`` markers, and collapse whitespace, for matching.

    ``▁`` (U+2581) is replaced with a space before collapsing so a SentencePiece
    subword surface ("▁amlodipine") normalizes to the same key as its plain form
    ("amlodipine"). Idempotent with the claims-path ``_clean_claim_text`` cleanup.
    """
    return " ".join(text.replace(SUBWORD_MARKER, " ").lower().split())


def dedupe(items: Iterable[str]) -> list[str]:
    """Order-preserving de-duplication (stable flagged-claim lists)."""
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


class NEREntity(BaseModel):
    """A named-entity span — the NLP ``/classify/tokens`` shape (text/type/offsets)."""

    model_config = ConfigDict(extra="ignore")

    text: str
    type: str = ""
    start: int = -1
    end: int = -1
    # TASK-476 C1 — clinical ontology codes (nullable) carried end to end so the
    # persisted NamedEntity rows are coded. Mirror the NLP `/classify/tokens`
    # `Entity` code fields; the api_client forwards them to persistEntities.
    umls_cui: str | None = None
    snomed_code: str | None = None
    rxnorm_code: str | None = None
    icd_code: str | None = None
    loinc_code: str | None = None

    @property
    def normalized(self) -> str:
        """Normalized surface form used for matching across note/transcript."""
        return normalize_text(self.text)


class SensorContext(BaseModel):
    """All inputs a Phase-1 sensor needs — plain data, no service/model handles.

    ``soap_sections`` is the parsed structured note (``subjective`` / ``objective``
    / ``assessment`` / ``plan``); ``soap_schema`` is the activated SOAP JSON Schema
    (a raw schema, or a ``responseFormat`` wrapper ``{type, json_schema, strict}``);
    ``citations_map`` is the ``SummaryMeta.citationsMap`` provenance object
    (``{"claims": [{id, text, section, status, evidence:[...]}, ...]}``).
    """

    model_config = ConfigDict(extra="ignore")

    note_text: str = ""
    # ``Any`` values (not ``str``): a malformed SOAP draft may emit non-string
    # sections — catching that is exactly the schema-validity sensor's job, so the
    # context must not pre-reject it.
    soap_sections: dict[str, Any] = Field(default_factory=dict)
    transcript_text: str = ""
    note_entities: list[NEREntity] = Field(default_factory=list)
    transcript_entities: list[NEREntity] = Field(default_factory=list)
    soap_schema: dict[str, Any] = Field(default_factory=dict)
    citations_map: dict[str, Any] = Field(default_factory=dict)
    # Phase-3 institutional RAG: retrieved chunk id -> chunk text. The
    # citation-verify sensor entails each claim against ONLY its cited chunks'
    # text (looked up here); empty in the flag-off Phase-1/2 path.
    knowledge_chunks: dict[str, str] = Field(default_factory=dict)

    def note_blob(self) -> str:
        """Best-available note text: ``note_text`` if present, else joined sections."""
        if self.note_text.strip():
            return self.note_text
        return " ".join(str(v) for v in self.soap_sections.values())

    def claims(self) -> list[dict[str, Any]]:
        """The provenance claims (only well-formed dict entries)."""
        raw = self.citations_map.get("claims", [])
        if not isinstance(raw, list):
            return []
        return [c for c in raw if isinstance(c, dict)]


class SensorResult(BaseModel):
    """The outcome of a single sensor run.

    ``score`` is a fraction in ``[0, 1]``; ``passed`` is the sensor's own
    threshold verdict; ``claims_flagged`` lists the offending claim/entity refs;
    ``details`` carries sensor-specific diagnostics (including ``degraded=True``
    when the sensor structurally could not verify, and ``sections`` listing the
    SOAP sections a REGEN should target).
    """

    model_config = ConfigDict(extra="forbid")

    name: str
    score: float
    passed: bool
    claims_flagged: list[str] = Field(default_factory=list)
    details: dict[str, Any] = Field(default_factory=dict)

    @property
    def degraded(self) -> bool:
        """True when the sensor could not verify its inputs (never auto-PASS)."""
        return bool(self.details.get("degraded"))


@runtime_checkable
class Sensor(Protocol):
    """A computational gate sensor: pure, deterministic, no model calls."""

    name: str

    def run(self, ctx: SensorContext) -> SensorResult:
        """Score ``ctx`` and return a :class:`SensorResult`."""
        ...
