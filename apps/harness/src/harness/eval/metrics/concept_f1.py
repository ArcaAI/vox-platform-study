"""MEDCON/UMLS concept-F1 — the omission catcher.

PDSQI + faithfulness catch what a note says *wrong*; nothing catches what it left
*out*. Concept-F1 scores the generated note's coded entities (candidate concepts,
populated by the clinical encoder) against a golden reference concept set, making
**recall** a first-class metric — "did we drop the drug / dose / finding" at the
concept (not surface-string) level:

    precision = |matched| / |candidate|
    recall    = |matched| / |reference|   ← the omission signal
    f1        = harmonic mean

Matching is keyed on the canonical **UMLS CUI** with a documented code-system
fallback order (snomed → rxnorm → icd → loinc) when a CUI is absent. Keys are
namespaced by system so codes from different ontologies never collide.

Pure, offline, deterministic — no services, no model, unit-testable in isolation.

Skip-clean is load-bearing: when every candidate code is ``None`` (no encoder
codes on this note), :func:`score_concept_f1` returns ``None`` (skip) rather
than a false 0.0 recall.
"""

from __future__ import annotations

from collections.abc import Sequence

from harness.eval.models import ConceptCode, ConceptF1Result

# The canonical-key fallback order: prefer the UMLS CUI, else the next code system.
_FALLBACK_ORDER: tuple[str, ...] = ("cui", "snomed", "rxnorm", "icd", "loinc")


def canonical_key(concept: ConceptCode) -> str | None:
    """The one namespaced key a candidate concept resolves to (or ``None``).

    Follows the fallback order cui → snomed → rxnorm → icd → loinc and returns the
    first present code as ``"system:code"``. A concept carrying no code → ``None``.
    """
    for system in _FALLBACK_ORDER:
        value = getattr(concept, system)
        if value and value.strip():
            return f"{system}:{value.strip()}"
    return None


def normalize_reference_key(reference: str) -> str:
    """Normalise a golden reference code to a namespaced key.

    A bare code (no ``":"``) is treated as a UMLS CUI (``"cui:<code>"``); a
    ``"system:code"`` string keeps its system (lower-cased).
    """
    reference = reference.strip()
    system, sep, code = reference.partition(":")
    if not sep:
        return f"cui:{reference}"
    return f"{system.strip().lower()}:{code.strip()}"


def _candidate_keys(candidate: Sequence[ConceptCode]) -> set[str]:
    return {key for key in (canonical_key(c) for c in candidate) if key}


def _reference_keys(reference: Sequence[str]) -> set[str]:
    return {normalize_reference_key(r) for r in reference if r.strip()}


def compute_concept_f1(
    candidate: Sequence[ConceptCode], reference: Sequence[str]
) -> ConceptF1Result:
    """Compute precision/recall/F1 of ``candidate`` concept codes vs ``reference``.

    Requires a non-empty reference set (the metric is undefined without one).
    Recall = 0 when the candidate dropped every reference concept.
    """
    candidate_keys = _candidate_keys(candidate)
    reference_keys = _reference_keys(reference)
    if not reference_keys:
        raise ValueError("concept-F1 requires a non-empty reference concept set")

    matched = candidate_keys & reference_keys
    precision = len(matched) / len(candidate_keys) if candidate_keys else 0.0
    recall = len(matched) / len(reference_keys)
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0

    return ConceptF1Result(
        precision=precision,
        recall=recall,
        f1=f1,
        matched=len(matched),
        candidate_total=len(candidate_keys),
        reference_total=len(reference_keys),
        missed_cuis=sorted(reference_keys - candidate_keys),
        spurious_cuis=sorted(candidate_keys - reference_keys),
    )


def score_concept_f1(
    candidate: Sequence[ConceptCode], reference: Sequence[str]
) -> ConceptF1Result | None:
    """Skip-clean wrapper: ``None`` when the metric cannot be measured.

    Returns ``None`` when the candidate carries **no** codes (the encoder
    has not run, so recall is unmeasurable, NOT zero) or when the
    reference set is empty. Otherwise delegates to :func:`compute_concept_f1` — a
    partially-coded candidate that dropped some concepts is a REAL measurement
    (recall < 1.0), never a skip.
    """
    if not _candidate_keys(candidate) or not _reference_keys(reference):
        return None
    return compute_concept_f1(candidate, reference)
