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

THE PLAUSIBILITY BANDS ARE CONFIGURATION (TASK-799 lane G). They used to be
module constants (``_SYSTOLIC_RANGE = (60, 260)`` &c.), so a paediatric or
neonatal service could not adjust a band without a code change — rule 00 names a
threshold as something that is never a literal in code. They now arrive per
request on ``AiModel._metadata.clinicalTaxonomy.vitals``, resolved by the gateway
from the row ``nlp.ner`` selects.

An UNCONFIGURED band disables that vital entirely: a number this service cannot
range-check is never emitted. That is the same fail-SAFE direction the docstring
above already commits to (a mis-parse yields "no vital", never a wrong number) —
extended to "un-checkable" as well as "implausible".
"""

from __future__ import annotations

import re

from nlp.schemas.classification import Vitals
from nlp.schemas.clinical_taxonomy import VitalsRange, VitalsTaxonomy

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


def _in(value: float, bounds: VitalsRange | None) -> bool:
    """True only when a band was CONFIGURED and the value falls inside it.

    An absent band is not "no constraint" — it is "no way to check", which is
    fail-safe `False`. That is what stops an unconfigured deployment from
    emitting unvalidated clinical numbers.
    """
    return bounds is not None and bounds.contains(value)


def _bp(text: str, taxonomy: VitalsTaxonomy) -> tuple[int | None, int | None]:
    for match in _BP_RE.finditer(text):
        systolic, diastolic = int(match.group(1)), int(match.group(2))
        # Systolic must exceed diastolic and both must be plausible.
        if (
            systolic > diastolic
            and _in(systolic, taxonomy.systolic)
            and _in(diastolic, taxonomy.diastolic)
        ):
            return systolic, diastolic
    return None, None


def _heart_rate(text: str, taxonomy: VitalsTaxonomy) -> int | None:
    match = _HR_RE.search(text)
    if not match:
        return None
    value = int(match.group(1))
    return value if _in(value, taxonomy.heart_rate) else None


def _spo2(text: str, taxonomy: VitalsTaxonomy) -> int | None:
    match = _SPO2_RE.search(text)
    if not match:
        return None
    value = int(match.group(1))
    return value if _in(value, taxonomy.spo2) else None


def _temperature_c(text: str, taxonomy: VitalsTaxonomy) -> float | None:
    match = _TEMP_RE.search(text)
    if not match:
        return None
    value = float(match.group(1))
    unit = (match.group(2) or "").lower()
    # Explicit F, or an unlabeled value that can only be Fahrenheit, converts to C.
    if unit == "f" or (unit == "" and value >= 45.0):
        value = round((value - 32.0) * 5.0 / 9.0, 1)
    return value if _in(value, taxonomy.temperature_c) else None


def _weight_kg(text: str, taxonomy: VitalsTaxonomy) -> float | None:
    match = _WEIGHT_RE.search(text)
    if not match:
        return None
    value = float(match.group(1))
    unit = (match.group(2) or "").lower()
    if unit.startswith("lb") or unit.startswith("pound"):
        value = round(value * 0.45359237, 1)
    return value if _in(value, taxonomy.weight_kg) else None


def extract_vitals(text: str, taxonomy: VitalsTaxonomy | None = None) -> Vitals | None:
    """Extract structured vitals from ``text``; ``None`` when nothing matched.

    Every field is independently cue-gated and range-checked against the
    CONFIGURED band — a field with no confident match, or no configured band to
    check it against, stays ``None`` (never fabricated, never unvalidated).
    """
    if not text or not text.strip():
        return None
    if taxonomy is None:
        # Nothing configured ⇒ nothing checkable ⇒ nothing emitted.
        return None

    systolic, diastolic = _bp(text, taxonomy)
    vitals = Vitals(
        systolic=systolic,
        diastolic=diastolic,
        heart_rate=_heart_rate(text, taxonomy),
        spo2=_spo2(text, taxonomy),
        temperature_c=_temperature_c(text, taxonomy),
        weight_kg=_weight_kg(text, taxonomy),
    )
    return vitals if vitals.has_any() else None
