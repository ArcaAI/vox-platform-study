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

from harness.sensors.base import NEREntity, SensorContext, SensorResult
from harness.sensors.config import SensorThresholds
from harness.sensors.registry import computational_sensors
from harness.services.provenance import build_citations_map

# SOAP section header on its own line in a markdown/prose note. Matches the colon
# form ("**Plan:**", "Plan:", "### Plan:") AND the parenthetical-letter form some
# generation models emit ("**PLAN (P)**", "**Subjective (S)**") — bold, the SOAP
# letter in parens, and NO trailing colon. Line-anchored so a prose line that merely
# starts with "Plan to ..." is NOT mistaken for a header: after the word we require a
# colon, a "(S)" annotation, closing emphasis, or end-of-line.
_SOAP_HEADER_RE = re.compile(
    r"^[ \t>#*_-]*(subjective|objective|assessment|plan)\b"
    r"[ \t]*(?:\([soap]\))?[ \t]*[*_]{0,2}[ \t]*(?::|$)",
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
    soap_sections = _parse_soap(note_text)

    # Provenance/citation attribution must survive a model that emits a markdown SOAP
    # note instead of the requested JSON: fall back to header-parsed sections ONLY for
    # the citationsMap, so the StrictCitations [[kb:]] markers resolve to a section and
    # claims attribute per-section. The SensorContext keeps the strict JSON parse, so
    # schema_validity (and the other sensors) are unchanged — a markdown note still
    # fails the schema gate, it just no longer silently drops every knowledgeChunkId.
    provenance_sections = soap_sections or _parse_soap_markdown(note_text)

    citations_map = build_citations_map(
        soap_sections=provenance_sections,
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
