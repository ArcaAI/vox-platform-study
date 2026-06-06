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

from harness.sensors.base import NEREntity, normalize_text

# SOAP property name -> single-letter section code (matches the sensors).
_SECTION_CODES = (
    ("subjective", "S"),
    ("objective", "O"),
    ("assessment", "A"),
    ("plan", "P"),
)
_DEFAULT_SECTION = "A"


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
            "quote": match.text,
        }

    if norm in transcript_norm:
        idx = transcript_text.lower().find(entity.text.lower())
        return {
            "transcriptContextItemId": transcript_context_item_id,
            "startOffset": idx,
            "endOffset": idx + len(entity.text) if idx >= 0 else -1,
            "quote": entity.text,
        }
    return None


def build_citations_map(
    *,
    soap_sections: dict[str, Any],
    note_entities: Sequence[NEREntity],
    transcript_entities: Sequence[NEREntity],
    transcript_text: str = "",
    transcript_context_item_id: str | None = None,
) -> dict[str, Any]:
    """Derive a deterministic ``{"claims": [...]}`` provenance map."""
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
        claims.append(
            {
                "id": f"claim-{len(claims) + 1}",
                "text": entity.text,
                "section": _derive_section(norm, soap_sections),
                "confidence": 1.0 if evidence else 0.0,
                "status": "verified" if evidence else "unverified",
                "evidence": [evidence] if evidence else [],
                "entityRefs": [],
                "knowledgeChunkIds": [],
            }
        )

    return {"claims": claims}
