"""Numeric/dose sensor — numbers & doses in the note must match the transcript.

Highest-harm guard against fabricated or mistyped numeric values (doses, vitals,
labs). Extracts ``number (+ optional unit)`` tokens from the note and the
transcript and flags any note value that has no match in the transcript — e.g.
the note says ``20 mg`` but the transcript says ``10 mg``.

Matching is deterministic and conservative:
* a note token **with a unit** matches only an identical (value, unit) transcript
  token (a wrong unit or wrong value is a mismatch);
* a note token **without a unit** matches any transcript token of the same value;
* bare single-digit integers with no unit are treated as list markers / ordinals
  and ignored.

Degradation: if the note carries numbers but the transcript text is empty, the
sensor cannot verify and returns ``degraded`` (never auto-PASS).
"""

from __future__ import annotations

import re

from harness.sensors.base import SensorContext, SensorResult, dedupe

NAME = "numeric_dose"

# Units recognized after a number. Multi-char / shared-prefix units are ordered
# specific-first (e.g. ``mg/dl`` before ``mg``) so alternation matches greedily.
_UNIT = (
    r"mcg|µg|mg/dl|mg/kg|mg/day|mg|kg|ml|mmol/l|mmol|mmhg|iu|units?|bpm|"
    r"tablets?|tabs?|capsules?|caps?|puffs?|drops?|sprays?|g|l|%|°c|°f|"
    r"/day|/min|/kg|hrs?|hours?|days?|weeks?|months?"
)
_NUM_UNIT = re.compile(rf"(?P<num>\d+(?:\.\d+)?)\s*(?P<unit>{_UNIT})?", re.IGNORECASE)


def _normalize_num(num: str) -> str:
    value = float(num)
    return str(int(value)) if value.is_integer() else str(value)


def _tokens(text: str) -> list[tuple[str, str]]:
    """Extract ``(normalized_value, lowercase_unit)`` tokens from ``text``."""
    out: list[tuple[str, str]] = []
    for match in _NUM_UNIT.finditer(text):
        raw_num = match.group("num")
        unit = (match.group("unit") or "").lower()
        # Drop bare single-digit integers with no unit (list markers / ordinals).
        if not unit and len(raw_num) == 1 and "." not in raw_num:
            continue
        out.append((_normalize_num(raw_num), unit))
    return out


def _display(token: tuple[str, str]) -> str:
    value, unit = token
    return f"{value} {unit}".strip()


class NumericDoseSensor:
    """Score = matched note numbers / total note numbers."""

    name = NAME

    def __init__(self, threshold: float = 1.0) -> None:
        self.threshold = threshold

    def run(self, ctx: SensorContext) -> SensorResult:
        note_tokens = _tokens(ctx.note_blob())
        if not note_tokens:
            return SensorResult(
                name=NAME,
                score=1.0,
                passed=True,
                details={"total": 0, "matched": 0, "unmatched": []},
            )

        if not ctx.transcript_text.strip():
            flagged = dedupe(_display(t) for t in note_tokens)
            return SensorResult(
                name=NAME,
                score=0.0,
                passed=False,
                claims_flagged=flagged,
                details={
                    "degraded": True,
                    "reason": "no transcript to verify note numbers against",
                    "total": len(note_tokens),
                },
            )

        transcript_tokens = _tokens(ctx.transcript_text)
        transcript_pairs = set(transcript_tokens)
        transcript_values = {value for value, _ in transcript_tokens}

        matched = 0
        unmatched: list[str] = []
        for token in note_tokens:
            value, unit = token
            if unit:
                ok = token in transcript_pairs
            else:
                ok = value in transcript_values
            if ok:
                matched += 1
            else:
                unmatched.append(_display(token))

        total = len(note_tokens)
        score = matched / total
        flagged = dedupe(unmatched)
        return SensorResult(
            name=NAME,
            score=score,
            passed=score >= self.threshold,
            claims_flagged=flagged,
            details={"total": total, "matched": matched, "unmatched": flagged},
        )
