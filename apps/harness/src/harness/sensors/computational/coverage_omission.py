"""Coverage / omission sensor — transcript entities must appear in the note.

**Omission** is the single most frequent (and hardest-to-catch) clinical
documentation error — it requires *recall*, not recognition. For every clinical
entity the NLP service extracted from the transcript, this sensor checks the
entity is reflected in the generated note (by a note NER span or a verbatim
mention in the note text / structured sections). Transcript entities missing
from the note are flagged as omissions.
"""

from __future__ import annotations

from harness.sensors.base import SensorContext, SensorResult, dedupe, normalize_text

NAME = "coverage_omission"


class CoverageOmissionSensor:
    """Score = covered transcript entities / total transcript entities."""

    name = NAME

    def __init__(self, threshold: float = 0.8) -> None:
        self.threshold = threshold

    def run(self, ctx: SensorContext) -> SensorResult:
        checked = [e for e in ctx.transcript_entities if e.normalized]
        if not checked:
            return SensorResult(
                name=NAME,
                score=1.0,
                passed=True,
                details={"covered": 0, "total": 0, "omitted": []},
            )

        haystack = normalize_text(ctx.note_blob())
        note_entity_texts = {e.normalized for e in ctx.note_entities if e.normalized}

        covered: list[str] = []
        omitted: list[str] = []
        for entity in checked:
            present = entity.normalized in note_entity_texts or entity.normalized in haystack
            (covered if present else omitted).append(entity.text)

        total = len(checked)
        score = len(covered) / total
        flagged = dedupe(omitted)
        return SensorResult(
            name=NAME,
            score=score,
            passed=score >= self.threshold,
            claims_flagged=flagged,
            details={"covered": len(covered), "total": total, "omitted": flagged},
        )
