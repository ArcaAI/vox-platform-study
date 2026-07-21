"""Deterministic clinical ontology linker.

Resolves a recognized clinical span to standardized ontology codes — a UMLS CUI
plus cross-walks to SNOMED CT / RxNorm / ICD-10 / LOINC — against a **bundled,
self-hosted** vocabulary subset (a MedCAT-class lookup). This is the authoritative
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
/ symptoms / labs / procedures with real codes), not a full UMLS install. It is
straightforward to extend — add an entry to ``_VOCABULARY_ENTRIES`` — or to swap
for a heavier self-hosted linker (MedCAT / Spark NLP) behind the same ``link``
contract without touching the callers.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

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
        return any((self.umls_cui, self.snomed_code, self.rxnorm_code, self.icd_code, self.loinc_code))


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


# Curated self-hosted vocabulary subset. Each entry maps one or more surface
# aliases to its codes. Codes are real (RxNorm ingredient RxCUIs, ICD-10-CM,
# SNOMED CT concept ids, UMLS CUIs, LOINC) — an illustrative-but-accurate subset,
# not a full ontology. Extend here to widen coverage.
_VOCABULARY_ENTRIES: tuple[tuple[tuple[str, ...], OntologyCodes], ...] = (
    # ── Medications (RxNorm + UMLS) ──
    (("metformin",), OntologyCodes(rxnorm_code="6809", umls_cui="C0025598")),
    (("aspirin", "acetylsalicylic acid"), OntologyCodes(rxnorm_code="1191", umls_cui="C0004057")),
    (("amoxicillin",), OntologyCodes(rxnorm_code="723", umls_cui="C0002645")),
    (("amlodipine",), OntologyCodes(rxnorm_code="17767", umls_cui="C0051696")),
    (("lisinopril",), OntologyCodes(rxnorm_code="29046", umls_cui="C0065374")),
    (("metoprolol",), OntologyCodes(rxnorm_code="6918", umls_cui="C0025859")),
    (("atorvastatin",), OntologyCodes(rxnorm_code="83367", umls_cui="C0286651")),
    (("ibuprofen",), OntologyCodes(rxnorm_code="5640", umls_cui="C0020740")),
    (("insulin",), OntologyCodes(rxnorm_code="5856", umls_cui="C0021641")),
    (("warfarin",), OntologyCodes(rxnorm_code="11289", umls_cui="C0043031")),
    (("omeprazole",), OntologyCodes(rxnorm_code="7646", umls_cui="C0028978")),
    (("albuterol", "salbutamol"), OntologyCodes(rxnorm_code="435", umls_cui="C0001927")),
    (("prednisone",), OntologyCodes(rxnorm_code="8640", umls_cui="C0032952")),
    (("furosemide",), OntologyCodes(rxnorm_code="4603", umls_cui="C0016860")),
    # ── Conditions (ICD-10 + SNOMED + UMLS) ──
    (("pneumonia",), OntologyCodes(icd_code="J18.9", snomed_code="233604007", umls_cui="C0032285")),
    (("hypertension", "high blood pressure"), OntologyCodes(icd_code="I10", snomed_code="38341003", umls_cui="C0020538")),
    (
        # Type-2-specific aliases ONLY. Bare "diabetes" / "diabetes mellitus" are
        # deliberately NOT mapped here — an unqualified mention may be Type 1,
        # gestational, or unspecified, so mapping it to the Type-2 codes (E11.9)
        # would systematically mislabel non-T2 patients. Unqualified "diabetes"
        # resolves all-None → stays un-coded → the groundedness guard covers it.
        ("type 2 diabetes", "type ii diabetes", "t2dm"),
        OntologyCodes(icd_code="E11.9", snomed_code="44054006", umls_cui="C0011860"),
    ),
    (("asthma",), OntologyCodes(icd_code="J45.909", snomed_code="195967001", umls_cui="C0004096")),
    (("copd", "chronic obstructive pulmonary disease"), OntologyCodes(icd_code="J44.9", snomed_code="13645005", umls_cui="C0024117")),
    (("covid-19", "covid", "covid 19"), OntologyCodes(icd_code="U07.1", snomed_code="840539006", umls_cui="C5203670")),
    (("myocardial infarction", "heart attack"), OntologyCodes(icd_code="I21.9", snomed_code="22298006", umls_cui="C0027051")),
    (("sepsis",), OntologyCodes(icd_code="A41.9", snomed_code="91302008", umls_cui="C0243026")),
    (("anemia", "anaemia"), OntologyCodes(icd_code="D64.9", snomed_code="271737000", umls_cui="C0002871")),
    # ── Symptoms (SNOMED + UMLS + ICD-10) ──
    (("headache", "cephalalgia"), OntologyCodes(icd_code="R51.9", snomed_code="25064002", umls_cui="C0018681")),
    (("fever", "pyrexia"), OntologyCodes(icd_code="R50.9", snomed_code="386661006", umls_cui="C0015967")),
    (("chest pain",), OntologyCodes(icd_code="R07.9", snomed_code="29857009", umls_cui="C0008031")),
    (("cough",), OntologyCodes(icd_code="R05.9", snomed_code="49727002", umls_cui="C0010200")),
    (("nausea",), OntologyCodes(icd_code="R11.0", snomed_code="422587007", umls_cui="C0027497")),
    (
        ("shortness of breath", "dyspnea", "dyspnoea", "sob"),
        OntologyCodes(icd_code="R06.02", snomed_code="267036007", umls_cui="C0013404"),
    ),
    (("fatigue",), OntologyCodes(icd_code="R53.83", snomed_code="84229001", umls_cui="C0015672")),
    (("dizziness",), OntologyCodes(icd_code="R42", snomed_code="404640003", umls_cui="C0012833")),
    # ── Labs / analytes (LOINC + UMLS) ──
    (("hemoglobin a1c", "hba1c", "a1c", "glycated hemoglobin"), OntologyCodes(loinc_code="4548-4", umls_cui="C0202054")),
    (("glucose", "blood glucose"), OntologyCodes(loinc_code="2345-7", umls_cui="C0202041")),
    (("creatinine",), OntologyCodes(loinc_code="2160-0", umls_cui="C0201975")),
    (("hemoglobin", "haemoglobin", "hgb"), OntologyCodes(loinc_code="718-7", umls_cui="C0518015")),
    (("potassium",), OntologyCodes(loinc_code="2823-3", umls_cui="C0202194")),
    (("white blood cell count", "wbc"), OntologyCodes(loinc_code="6690-2", umls_cui="C0023508")),
    # ── Procedures (SNOMED + UMLS) ──
    (("chest x-ray", "chest xray", "cxr"), OntologyCodes(snomed_code="399208008", umls_cui="C0039985")),
    (("electrocardiogram", "ecg", "ekg"), OntologyCodes(snomed_code="29303009", umls_cui="C0013798")),
    (("mri", "magnetic resonance imaging"), OntologyCodes(snomed_code="113091000", umls_cui="C0024485")),
)


def _build_vocabulary() -> dict[str, OntologyCodes]:
    """Expand the curated entries into a normalized-alias → codes lookup table."""
    table: dict[str, OntologyCodes] = {}
    for aliases, codes in _VOCABULARY_ENTRIES:
        for alias in aliases:
            table[_normalize(alias)] = codes
    return table


class OntologyLinker:
    """Deterministic, offline clinical entity linker over a bundled vocab subset."""

    def __init__(self, vocabulary: dict[str, OntologyCodes] | None = None) -> None:
        # Injectable for tests / future MedCAT-vocab loading; defaults to the
        # bundled curated subset. Constructed once — the table is immutable.
        self._vocabulary = vocabulary if vocabulary is not None else _build_vocabulary()

    def link(self, text: str) -> OntologyCodes:
        """Resolve ``text`` to :class:`OntologyCodes`; all-None when unrecognized."""
        if not text or not text.strip():
            return OntologyCodes()
        return self._vocabulary.get(_normalize(text), OntologyCodes())
