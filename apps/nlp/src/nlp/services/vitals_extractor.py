"""Deterministic vital-sign extraction.

A conservative, rules-based parser that pulls structured vital signs
(BP / HR / SpO2 / temperature / weight) out of clinical narration — spoken
("blood pressure one thirty-eight over eighty-eight" is NOT handled; digits
only) or written. It is deliberately NOT an ML model: every value must match an
explicit cue + a plausible physiologic range, so a mis-parse fails SAFE to
``None`` (no vital shown) rather than emitting a wrong number into a note.

Contract mirrors the ontology linker: absent/un-parseable fields stay ``None``;
a value outside its physiologic range is treated as no-match, never clamped or
fabricated. ``extract_vitals`` returns ``None`` when nothing matched at all.
"""

from __future__ import annotations

import re

from nlp.schemas.classification import Vitals

# Physiologic sanity bounds — a match outside the range is discarded (fail-safe).
_SYSTOLIC_RANGE = (60, 260)
_DIASTOLIC_RANGE = (30, 160)
_HR_RANGE = (25, 220)
_SPO2_RANGE = (50, 100)
_TEMP_C_RANGE = (30.0, 44.0)
_WEIGHT_KG_RANGE = (1.0, 400.0)

# Blood pressure: "138/88" or "138 over 88", optionally with a BP cue. Requiring
# the slash/"over" form keeps it BP-specific (a bare "138 88" is ignored).
_BP_RE = re.compile(r"\b(\d{2,3})\s*(?:/|\bover\b)\s*(\d{2,3})\b", re.IGNORECASE)
# Each remaining vital requires an explicit cue word so random numbers are ignored.
_HR_RE = re.compile(r"\b(?:heart\s*rate|pulse|hr)\b[^\d]{0,8}(\d{2,3})\b", re.IGNORECASE)
_SPO2_RE = re.compile(
    r"\b(?:spo2|sao2|o2\s*sat(?:uration)?|oxygen\s*saturation|sat)\b[^\d]{0,8}(\d{2,3})\s*%?",
    re.IGNORECASE,
)
_TEMP_RE = re.compile(
    r"\b(?:temp(?:erature)?)\b[^\d]{0,8}(\d{2,3}(?:\.\d)?)\s*(?:°\s*)?([cf])?\b",
    re.IGNORECASE,
)
_WEIGHT_RE = re.compile(
    r"\b(?:weight|wt)\b[^\d]{0,8}(\d{2,3}(?:\.\d)?)\s*(kg|kilograms?|kilos?|lbs?|pounds?)?\b",
    re.IGNORECASE,
)


def _in(value: float, bounds: tuple[float, float]) -> bool:
    return bounds[0] <= value <= bounds[1]


def _bp(text: str) -> tuple[int | None, int | None]:
    for match in _BP_RE.finditer(text):
        systolic, diastolic = int(match.group(1)), int(match.group(2))
        # Systolic must exceed diastolic and both must be plausible.
        if (
            systolic > diastolic
            and _in(systolic, _SYSTOLIC_RANGE)
            and _in(diastolic, _DIASTOLIC_RANGE)
        ):
            return systolic, diastolic
    return None, None


def _heart_rate(text: str) -> int | None:
    match = _HR_RE.search(text)
    if not match:
        return None
    value = int(match.group(1))
    return value if _in(value, _HR_RANGE) else None


def _spo2(text: str) -> int | None:
    match = _SPO2_RE.search(text)
    if not match:
        return None
    value = int(match.group(1))
    return value if _in(value, _SPO2_RANGE) else None


def _temperature_c(text: str) -> float | None:
    match = _TEMP_RE.search(text)
    if not match:
        return None
    value = float(match.group(1))
    unit = (match.group(2) or "").lower()
    # Explicit F, or an unlabeled value that can only be Fahrenheit, converts to C.
    if unit == "f" or (unit == "" and value >= 45.0):
        value = round((value - 32.0) * 5.0 / 9.0, 1)
    return value if _in(value, _TEMP_C_RANGE) else None


def _weight_kg(text: str) -> float | None:
    match = _WEIGHT_RE.search(text)
    if not match:
        return None
    value = float(match.group(1))
    unit = (match.group(2) or "").lower()
    if unit.startswith("lb") or unit.startswith("pound"):
        value = round(value * 0.45359237, 1)
    return value if _in(value, _WEIGHT_KG_RANGE) else None


def extract_vitals(text: str) -> Vitals | None:
    """Extract structured vitals from ``text``; ``None`` when nothing matched.

    Every field is independently cue-gated and range-checked — a field with no
    confident match stays ``None`` (never fabricated).
    """
    if not text or not text.strip():
        return None

    systolic, diastolic = _bp(text)
    vitals = Vitals(
        systolic=systolic,
        diastolic=diastolic,
        heart_rate=_heart_rate(text),
        spo2=_spo2(text),
        temperature_c=_temperature_c(text),
        weight_kg=_weight_kg(text),
    )
    return vitals if vitals.has_any() else None
