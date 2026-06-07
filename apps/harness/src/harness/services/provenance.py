"""Deterministic Phase-1 provenance (citationsMap) builder.

Phase-1 has no LLM claim-extractor, so the loop derives a deterministic
``citationsMap`` from the note entities: each distinct note entity becomes a
claim, attributed to the SOAP section that contains it. A note entity grounded
in the transcript (a same-text transcript NER span, or a verbatim transcript
mention) carries that transcript evidence span and is ``verified``; an
ungrounded one is ``unverified`` with no evidence — never silently asserted, so
citation-presence / entity-faithfulness can act on it (per the degradation
policy in TASK-330 README §4.6).

Shape matches the ``SummaryMeta.citationsMap`` contract:
``{"claims": [{id, text, section(S|O|A|P), confidence, status, evidence:[...],
entityRefs:[], knowledgeChunkIds:[]}]}``.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from harness.guides.retrieval.prompt import extract_cited_ids
from harness.sensors.base import NEREntity, normalize_text

# SOAP property name -> single-letter section code (matches the sensors).
_SECTION_CODES = (
    ("subjective", "S"),
    ("objective", "O"),
    ("assessment", "A"),
    ("plan", "P"),
)
_DEFAULT_SECTION = "A"

# SentencePiece "▁" (U+2581) word-boundary marker. NER spans tokenized by a
# SentencePiece model can carry it (e.g. "▁October"); it must never leak into the
# human-readable citation claim text / evidence quote.
_SUBWORD_MARKER = "\u2581"


def _clean_claim_text(text: str) -> str:
    """Strip SentencePiece ``▁`` markers and collapse to clean human-readable text.

    Replaces every ``▁`` (U+2581) with a regular space and collapses runs of
    whitespace (so ``"▁October ▁2025"`` -> ``"October 2025"``). Legitimate content
    (letters, digits, punctuation) is untouched, so ``"120/80 mmHg"`` is preserved.
    """
    if not text:
        return text
    return " ".join(text.replace(_SUBWORD_MARKER, " ").split())


def _derive_section(entity_norm: str, soap_sections: dict[str, Any]) -> str:
    """Return the S/O/A/P code of the first section whose text contains the entity."""
    for key, code in _SECTION_CODES:
        value = soap_sections.get(key)
        if value is None:
            continue
        if entity_norm and entity_norm in normalize_text(str(value)):
            return code
    return _DEFAULT_SECTION


def _evidence_for(
    entity: NEREntity,
    *,
    transcript_by_norm: dict[str, NEREntity],
    transcript_norm: str,
    transcript_text: str,
    transcript_context_item_id: str | None,
) -> dict[str, Any] | None:
    """Build a transcript evidence span for a grounded entity, else ``None``."""
    norm = entity.normalized
    if not norm:
        return None

    match = transcript_by_norm.get(norm)
    if match is not None:
        return {
            "transcriptContextItemId": transcript_context_item_id,
            "startOffset": match.start,
            "endOffset": match.end,
            "quote": _clean_claim_text(match.text),
        }

    if norm in transcript_norm:
        idx = transcript_text.lower().find(entity.text.lower())
        return {
            "transcriptContextItemId": transcript_context_item_id,
            "startOffset": idx,
            "endOffset": idx + len(entity.text) if idx >= 0 else -1,
            "quote": _clean_claim_text(entity.text),
        }
    return None


def _section_cited_ids(
    soap_sections: dict[str, Any], retrieved_chunk_ids: Sequence[str]
) -> dict[str, list[str]]:
    """Map each S/O/A/P code to the retrieved chunk ids the model cited in it.

    StrictCitations: the model cites supporting chunks inline with ``[[kb:<id>]]``.
    Parsing is **strict** — only ids that were actually retrieved survive — so a
    hallucinated citation never reaches ``knowledgeChunkIds``. Empty universe ->
    every section maps to ``[]`` (markers ignored).
    """
    allowed = {cid for cid in retrieved_chunk_ids if cid}
    if not allowed:
        return {}
    cited: dict[str, list[str]] = {}
    for key, code in _SECTION_CODES:
        value = soap_sections.get(key)
        if value is None:
            continue
        ids = extract_cited_ids(str(value), allowed)
        if ids:
            cited[code] = ids
    return cited


def build_citations_map(
    *,
    soap_sections: dict[str, Any],
    note_entities: Sequence[NEREntity],
    transcript_entities: Sequence[NEREntity],
    transcript_text: str = "",
    transcript_context_item_id: str | None = None,
    retrieved_chunk_ids: Sequence[str] = (),
) -> dict[str, Any]:
    """Derive a deterministic ``{"claims": [...]}`` provenance map.

    ``retrieved_chunk_ids`` (Phase 3) is the set of chunk ids the JIT retriever
    surfaced for this generation; when present, each claim's ``knowledgeChunkIds``
    is filled from the StrictCitations ``[[kb:<id>]]`` markers the model wrote in
    that claim's SOAP section (section-level attribution). Absent retrieval (the
    flag-off Phase-1/2 path) the field stays ``[]``.
    """
    section_cited = _section_cited_ids(soap_sections, retrieved_chunk_ids)

    transcript_by_norm: dict[str, NEREntity] = {}
    for entity in transcript_entities:
        if entity.normalized and entity.normalized not in transcript_by_norm:
            transcript_by_norm[entity.normalized] = entity
    transcript_norm = normalize_text(transcript_text)

    claims: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entity in note_entities:
        norm = entity.normalized
        if not norm or norm in seen:
            continue
        seen.add(norm)

        evidence = _evidence_for(
            entity,
            transcript_by_norm=transcript_by_norm,
            transcript_norm=transcript_norm,
            transcript_text=transcript_text,
            transcript_context_item_id=transcript_context_item_id,
        )
        section = _derive_section(norm, soap_sections)
        claims.append(
            {
                "id": f"claim-{len(claims) + 1}",
                "text": _clean_claim_text(entity.text),
                "section": section,
                "confidence": 1.0 if evidence else 0.0,
                "status": "verified" if evidence else "unverified",
                "evidence": [evidence] if evidence else [],
                "entityRefs": [],
                "knowledgeChunkIds": list(section_cited.get(section, [])),
            }
        )

    return {"claims": claims}
