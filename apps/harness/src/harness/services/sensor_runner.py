"""Deterministic sensor runner — wires the loop's generated draft to Lane H.

Parses the generated SOAP JSON, builds the provenance ``citationsMap``, assembles
a :class:`SensorContext`, runs the five computational sensors (in canonical
order), and returns the results + citationsMap + per-sensor scores + parsed
sections. The workflow folds the results with
:func:`harness.sensors.aggregator.aggregate` (which owns the regen budget).

Pure + deterministic: no model calls, no network. (Note-entity NER and the
draft generation happen upstream in activities; this only consumes their output.)
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from harness.core.logging import get_logger
from harness.sensors.base import NEREntity, SensorContext, SensorResult
from harness.sensors.config import SensorThresholds
from harness.sensors.registry import computational_sensors
from harness.services.provenance import build_citations_map, clean_entities_for_sensors

logger = get_logger(__name__)

# SOAP section header on its own line in a markdown/prose note. Matches the colon
# form ("**Plan:**", "Plan:", "### Plan:") AND the parenthetical-letter form some
# generation models emit ("**PLAN (P)**", "**Subjective (S)**") — bold, the SOAP
# letter in parens, and NO trailing colon. Line-anchored so a prose line that merely
# starts with "Plan to ..." is NOT mistaken for a header: after the word we require a
# colon, a "(S)" annotation, closing emphasis, or end-of-line.
# The trailing ``[*_]{0,2}`` consumes a closing bold/italic marker that directly
# follows the colon ("**Plan:**") so it does NOT leak into the section body — which
# would otherwise mask a genuinely EMPTY section ("**Plan:**\n\n" -> body "**", read
# as present) and let an empty note falsely pass the structural contract. It is
# anchored to the colon (no intervening space) so spaced inline bold content
# ("**Plan:** **Important** ...") is preserved.
_SOAP_HEADER_RE = re.compile(
    r"^[ \t>#*_-]*(subjective|objective|assessment|plan)\b"
    r"[ \t]*(?:\([soap]\))?[ \t]*[*_]{0,2}[ \t]*(?::|$)[*_]{0,2}",
    re.IGNORECASE | re.MULTILINE,
)


class SensorRunOutput(BaseModel):
    """Everything the workflow needs from one sensor pass over a draft."""

    model_config = ConfigDict(extra="forbid")

    results: list[SensorResult]
    citations_map: dict[str, Any] = Field(default_factory=dict)
    scores: dict[str, float] = Field(default_factory=dict)
    soap_sections: dict[str, Any] = Field(default_factory=dict)


def _parse_soap(note_text: str) -> dict[str, Any]:
    """Parse the generated SOAP JSON; ``{}`` if it is not a JSON object."""
    try:
        parsed = json.loads(note_text)
    except (json.JSONDecodeError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _parse_soap_markdown(note_text: str) -> dict[str, Any]:
    """Best-effort SOAP-section parse for a NON-JSON (markdown/prose) note.

    The activated ``response_format`` requests JSON SOAP, but a generation model may
    instead emit a markdown note with ``**Subjective:**`` / ``**Plan:**`` headers.
    Splitting on those headers lets provenance still attribute each claim to its SOAP
    section — and, critically, find the StrictCitations ``[[kb:<id>]]`` markers in the
    section the model wrote them in. Returns ``{}`` when no SOAP header is present (so
    a truly malformed note still yields no sections). Repeated headers are merged.
    """
    matches = list(_SOAP_HEADER_RE.finditer(note_text))
    if not matches:
        return {}
    sections: dict[str, Any] = {}
    for i, match in enumerate(matches):
        key = match.group(1).lower()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(note_text)
        text = note_text[match.end() : end].strip()
        sections[key] = f"{sections[key]} {text}".strip() if key in sections else text
    return sections


def run_computational_sensors(
    *,
    note_text: str,
    transcript_text: str,
    note_entities: Sequence[NEREntity],
    transcript_entities: Sequence[NEREntity],
    response_format: dict[str, Any] | None = None,
    transcript_context_item_id: str | None = None,
    retrieved_chunk_ids: Sequence[str] = (),
    thresholds: SensorThresholds | None = None,
) -> SensorRunOutput:
    """Run all computational sensors over one generated draft."""
    # Parse the structured note. The activated response_format requests JSON SOAP,
    # but the common department/CATCHALL path emits a MARKDOWN note (no schema), so
    # fall back to the header-parsed sections. schema_validity then validates the
    # ACTUAL structure (TASK-358 D-A) — a complete S/O/A/P note scores 1.0 in both the
    # responseFormat=null and json_schema paths; a truly unparseable note yields ``{}``
    # (schema_validity degrades -> FLAG). Provenance attribution reuses the same parse.
    json_sections = _parse_soap(note_text)
    soap_sections = json_sections or _parse_soap_markdown(note_text)
    parse_mode = "json" if json_sections else ("markdown" if soap_sections else "none")

    # One shared cleanup (TASK-358 D-B): merge ▁/BIO subword NER tokens and drop
    # non-clinical noise (mic-check counting words, bare stopwords) so the
    # entity-level sensors and the citationsMap consume the SAME clean entities —
    # single source of truth (``provenance.clean_entities_for_sensors``).
    note_entities_in, transcript_entities_in = len(note_entities), len(transcript_entities)
    note_entities = clean_entities_for_sensors(note_entities)
    transcript_entities = clean_entities_for_sensors(transcript_entities)

    # Observability (no PHI — counts/keys only): explains how the note parsed and how
    # many NER artifacts were merged/dropped, so a degraded -> FLAG outcome or a low
    # entity-faithfulness score is diagnosable in production without the note text.
    logger.debug(
        "harness.sensors.inputs_prepared",
        parse_mode=parse_mode,
        sections=sorted(soap_sections),
        note_entities_in=note_entities_in,
        note_entities_kept=len(note_entities),
        transcript_entities_in=transcript_entities_in,
        transcript_entities_kept=len(transcript_entities),
    )
    if not soap_sections:
        # No JSON object and no SOAP headers -> schema_validity degrades -> FLAG.
        logger.info("harness.sensors.note_unparseable", note_chars=len(note_text))

    citations_map = build_citations_map(
        soap_sections=soap_sections,
        note_entities=note_entities,
        transcript_entities=transcript_entities,
        transcript_text=transcript_text,
        transcript_context_item_id=transcript_context_item_id,
        retrieved_chunk_ids=retrieved_chunk_ids,
    )

    context = SensorContext(
        note_text=note_text,
        soap_sections=soap_sections,
        transcript_text=transcript_text,
        note_entities=list(note_entities),
        transcript_entities=list(transcript_entities),
        soap_schema=response_format or {},
        citations_map=citations_map,
    )

    results = [sensor.run(context) for sensor in computational_sensors(thresholds)]
    scores = {r.name: r.score for r in results}

    return SensorRunOutput(
        results=results,
        citations_map=citations_map,
        scores=scores,
        soap_sections=soap_sections,
    )
