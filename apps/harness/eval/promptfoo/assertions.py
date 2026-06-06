"""promptfoo Python assertion: judge output must satisfy the PDSQI-9 contract.

A schema/range check (valid JSON; all 11 dimensions present; Likert 1-5; binary
0/1; ``synthesized`` 1-5 or "NA"). This is a prompt/output-contract regression
gate that is meaningful both offline (mock provider) and against a real model.
Stdlib only.
"""

from __future__ import annotations

import json
from typing import Any

_LIKERT_1_5 = (
    "citation",
    "accurate",
    "thorough",
    "useful",
    "organized",
    "comprehensible",
    "succinct",
)
_BINARY = ("abstraction", "voice_summ", "voice_note")
_REQUIRED = (*_LIKERT_1_5, "synthesized", *_BINARY)


def _extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if "<think>" in text and "</think>" in text:
        text = text.split("</think>", 1)[1].strip()
    try:
        return json.loads(text)
    except ValueError:
        pass
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return json.loads(text[start : end + 1])
    raise ValueError("no JSON object found in output")


def _is_int(value: Any) -> bool:
    # Exclude bool (a subclass of int) so true/false aren't accepted as scores.
    return isinstance(value, int) and not isinstance(value, bool)


def check_pdsqi(output: str, context: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return a promptfoo GradingResult dict for the judge output."""
    raw = output if isinstance(output, str) else json.dumps(output)
    try:
        obj = _extract_json(raw)
    except ValueError as exc:
        return {"pass": False, "score": 0.0, "reason": f"not valid PDSQI JSON: {exc}"}

    if not isinstance(obj, dict):
        return {"pass": False, "score": 0.0, "reason": "PDSQI output is not a JSON object"}

    missing = [k for k in _REQUIRED if k not in obj]
    if missing:
        return {"pass": False, "score": 0.0, "reason": f"missing PDSQI keys: {missing}"}

    problems: list[str] = []
    for key in _LIKERT_1_5:
        value = obj[key]
        if not (_is_int(value) and 1 <= value <= 5):
            problems.append(f"{key}={value!r} not an integer in 1-5")

    synthesized = obj["synthesized"]
    if not (synthesized == "NA" or (_is_int(synthesized) and 1 <= synthesized <= 5)):
        problems.append(f"synthesized={synthesized!r} not 1-5 or 'NA'")

    for key in _BINARY:
        value = obj[key]
        if not (_is_int(value) and value in (0, 1)):
            problems.append(f"{key}={value!r} not 0 or 1")

    if problems:
        return {"pass": False, "score": 0.0, "reason": "; ".join(problems)}
    return {"pass": True, "score": 1.0, "reason": "valid PDSQI-9 output contract"}
