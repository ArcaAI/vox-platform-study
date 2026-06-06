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
from collections.abc import Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from harness.sensors.base import NEREntity, SensorContext, SensorResult
from harness.sensors.config import SensorThresholds
from harness.sensors.registry import computational_sensors
from harness.services.provenance import build_citations_map


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


def run_computational_sensors(
    *,
    note_text: str,
    transcript_text: str,
    note_entities: Sequence[NEREntity],
    transcript_entities: Sequence[NEREntity],
    response_format: dict[str, Any] | None = None,
    transcript_context_item_id: str | None = None,
    thresholds: SensorThresholds | None = None,
) -> SensorRunOutput:
    """Run all computational sensors over one generated draft."""
    soap_sections = _parse_soap(note_text)

    citations_map = build_citations_map(
        soap_sections=soap_sections,
        note_entities=note_entities,
        transcript_entities=transcript_entities,
        transcript_text=transcript_text,
        transcript_context_item_id=transcript_context_item_id,
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
