"""Deterministic clinical ontology linker.

Resolves a recognized clinical span to standardized ontology codes — a UMLS CUI
plus cross-walks to SNOMED CT / RxNorm / ICD-10 / LOINC — against the
**caller-supplied, self-hosted** vocabulary the gateway resolves from
`AiModel._metadata.clinicalTaxonomy` (a MedCAT-class lookup). This is the authoritative
producer of the ``NamedEntity`` ontology codes the durable summarizer reads
(prompt-assembly / harness / summary processor), closing a read-everywhere /
written-nowhere gap that was previously only annotated.

Design — fully deterministic and offline:
  * NO network, NO cloud vendor, NO model download (track guardrail: self-hosted
    only, no cloud PHI). The vocabulary is an in-process table, so a lookup is a
    pure function of its input.
  * A span is normalized (case-fold; strip ``▁`` SentencePiece / ``##`` subword
    markers, surrounding punctuation, and a leading article) then matched against
    the normalized vocabulary keys. Unknown spans return an **all-None**
    :class:`OntologyCodes` so every downstream ``NamedEntity`` write stays
    null-safe — the prompt-assembly groundedness guard then keeps its "no
    standardized codes" note for genuinely un-codable spans.

The vocabulary is deliberately a curated subset (common medications / conditions
/ symptoms / labs / procedures with real codes), not a full UMLS install — but it
is now DATA, held on the selected model row and widened by a platform admin
without a deploy. Swapping in a heavier self-hosted linker (MedCAT / Spark NLP)
behind the same ``link`` contract still requires no caller change.
"""

from __future__ import annotations

from collections.abc import Iterable

from pydantic import BaseModel, ConfigDict, Field

from nlp.schemas.clinical_taxonomy import LinkerTaxonomy
from nlp.schemas.clinical_taxonomy import OntologyVocabularyEntry as LinkerVocabularyEntry

# SentencePiece "▁" (U+2581) word-boundary marker + WordPiece "##" subword marker.
# NER surfaces from the token classifier may carry either; both normalize away so
# "▁metformin" / "met ##formin" match the plain vocabulary key "metformin".
_SUBWORD_MARKER = "▁"
_WORDPIECE_MARKER = "##"

# Leading articles/determiners stripped so "the pneumonia" keys as "pneumonia".
_LEADING_ARTICLES = ("the ", "a ", "an ")

# Surrounding punctuation trimmed from a raw span before matching.
_STRIP_CHARS = " \t\n\r.,;:!?\"'`()[]{}"


class OntologyCodes(BaseModel):
    """Standardized ontology codes for one clinical span (all nullable).

    Frozen so a linker result is an immutable value object (safe to share /
    compare). Field names mirror the on-the-wire ``Entity`` snake_case contract
    (``umls_cui`` / ``snomed_code`` / ``rxnorm_code`` / ``icd_code`` /
    ``loinc_code``) so the token classifier can splat them straight onto the
    response entity.
    """

    model_config = ConfigDict(frozen=True)

    umls_cui: str | None = Field(default=None, description="UMLS Concept Unique Identifier")
    snomed_code: str | None = Field(default=None, description="SNOMED CT concept id")
    rxnorm_code: str | None = Field(default=None, description="RxNorm RxCUI")
    icd_code: str | None = Field(default=None, description="ICD-10-CM code")
    loinc_code: str | None = Field(default=None, description="LOINC code")

    @property
    def has_any(self) -> bool:
        """True when at least one ontology code is populated."""
        return any(
            (self.umls_cui, self.snomed_code, self.rxnorm_code, self.icd_code, self.loinc_code)
        )


def _normalize(text: str) -> str:
    """Normalize a raw span to a vocabulary lookup key.

    Case-folds, strips subword markers, trims surrounding punctuation, collapses
    whitespace, and drops a leading article. Deterministic and idempotent; kept
    consistent with the harness sensor ``normalize_text`` so note/transcript
    entities and their codes key alike.
    """
    cleaned = text.replace(_SUBWORD_MARKER, " ").replace(_WORDPIECE_MARKER, " ")
    cleaned = " ".join(cleaned.lower().split())
    cleaned = cleaned.strip(_STRIP_CHARS)
    cleaned = " ".join(cleaned.split())
    for article in _LEADING_ARTICLES:
        if cleaned.startswith(article):
            cleaned = cleaned[len(article) :]
            break
    return cleaned


# The VOCABULARY IS CONFIGURATION, NOT CODE (TASK-799 lane G).
#
# It used to be `_VOCABULARY_ENTRIES`, ~40 UMLS/SNOMED/RxNorm/ICD-10/LOINC rows
# as a Python tuple literal, with this module's own docstring instructing the
# reader to "add an entry" to widen clinical coverage — i.e. a redeploy to teach
# the platform a new drug. Rule 00 §Configuration Principles names a taxonomy as
# something that is never a literal in code, so the table now lives on
# `AiModel._metadata.clinicalTaxonomy.linker.vocabulary` of the row `nlp.ner`
# selects, arrives per request, and can be retuned by a platform admin without a
# deploy. Nothing is bundled here: an unconfigured linker returns all-None codes,
# which is the SAME null-safe result an unknown span already produced, so no
# caller sees a fabricated code and no literal is silently substituted.


def build_vocabulary(entries: Iterable[LinkerVocabularyEntry]) -> dict[str, OntologyCodes]:
    """Expand caller-supplied entries into a normalized-alias → codes table."""
    table: dict[str, OntologyCodes] = {}
    for entry in entries:
        codes = OntologyCodes(
            umls_cui=entry.umls_cui,
            snomed_code=entry.snomed_code,
            rxnorm_code=entry.rxnorm_code,
            icd_code=entry.icd_code,
            loinc_code=entry.loinc_code,
        )
        for alias in entry.aliases:
            table[_normalize(alias)] = codes
    return table


class OntologyLinker:
    """Deterministic, offline clinical entity linker over a bundled vocab subset."""

    def __init__(self, vocabulary: dict[str, OntologyCodes] | None = None) -> None:
        # NO bundled default. An absent vocabulary is an EMPTY table, so every
        # span resolves all-None — the linker's existing contract for an unknown
        # span, and the only honest answer when nothing has been configured.
        self._vocabulary = vocabulary or {}

    @classmethod
    def from_taxonomy(cls, taxonomy: LinkerTaxonomy) -> OntologyLinker:
        """Build a linker from the gateway-injected `linker` taxonomy section."""
        return cls(build_vocabulary(taxonomy.vocabulary))

    def link(self, text: str) -> OntologyCodes:
        """Resolve ``text`` to :class:`OntologyCodes`; all-None when unrecognized."""
        if not text or not text.strip():
            return OntologyCodes()
        return self._vocabulary.get(_normalize(text), OntologyCodes())
