"""Entity-faithfulness sensor — note entities must be grounded in the transcript.

Highest-harm guard against **fabrication**: every clinical entity asserted in the
generated note must be supported by the transcript — either by a transcript NER
span of the same (normalized) text, or by a verbatim mention in the transcript
text. Note entities with no transcript support are flagged as likely fabricated.

Degradation: if the note asserts entities but there is no grounding source at all
(empty transcript text *and* no transcript entities), the sensor cannot verify and
returns ``degraded`` (never auto-PASS).
"""

from __future__ import annotations

from harness.sensors.base import SensorContext, SensorResult, dedupe, normalize_text

NAME = "entity_faithfulness"


class EntityFaithfulnessSensor:
    """Score = supported note entities / total note entities."""

    name = NAME

    def __init__(self, threshold: float = 1.0) -> None:
        self.threshold = threshold

    def run(self, ctx: SensorContext) -> SensorResult:
        checked = [e for e in ctx.note_entities if e.normalized]
        if not checked:
            return SensorResult(
                name=NAME,
                score=1.0,
                passed=True,
                details={"supported": 0, "total": 0, "unsupported": []},
            )

        transcript_norm = normalize_text(ctx.transcript_text)
        transcript_entity_texts = {e.normalized for e in ctx.transcript_entities if e.normalized}

        if not transcript_norm and not transcript_entity_texts:
            flagged = dedupe(e.text for e in checked)
            return SensorResult(
                name=NAME,
                score=0.0,
                passed=False,
                claims_flagged=flagged,
                details={
                    "degraded": True,
                    "reason": "no transcript to verify note entities against",
                    "total": len(checked),
                },
            )

        supported: list[str] = []
        unsupported: list[str] = []
        for entity in checked:
            grounded = entity.normalized in transcript_entity_texts or (
                entity.normalized in transcript_norm
            )
            (supported if grounded else unsupported).append(entity.text)

        total = len(checked)
        score = len(supported) / total
        flagged = dedupe(unsupported)
        return SensorResult(
            name=NAME,
            score=score,
            passed=score >= self.threshold,
            claims_flagged=flagged,
            details={"supported": len(supported), "total": total, "unsupported": flagged},
        )
