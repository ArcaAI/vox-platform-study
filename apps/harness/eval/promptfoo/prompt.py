"""Compact PDSQI-9 judge prompt for the promptfoo output-contract gate.

The AUTHORITATIVE instrument (Epic's open-source PDSQI-9 prompts) is vendored in
``harness.eval.judge.prompts`` and drives the Python judge. This compact variant
keeps the promptfoo lane self-contained while pinning the JSON output contract the
judge must satisfy. To gate against the full instrument, point the provider at a
real endpoint and reuse the Python judge prompt.
"""

from __future__ import annotations

from typing import Any

_LIKERT = (
    "citation",
    "accurate",
    "thorough",
    "useful",
    "organized",
    "comprehensible",
    "succinct",
    "synthesized",
)
_BINARY = ("abstraction", "voice_summ", "voice_note")
_ALL_KEYS = _LIKERT + _BINARY


def build_prompt(context: dict[str, Any]) -> str:
    """promptfoo prompt-function entrypoint (receives the test ``context``)."""
    ctx = context or {}
    vars_ = ctx.get("vars", ctx) if isinstance(ctx, dict) else {}
    source = vars_.get("source", "")
    note = vars_.get("note", "")
    specialty = vars_.get("specialty", "General Medicine")
    keys = ", ".join(_ALL_KEYS)

    return (
        "You are a clinical documentation reviewer applying the PDSQI-9 instrument.\n"
        f"Specialty context: {specialty}.\n"
        "Rate the SUMMARY against the SOURCE. Likert dimensions (citation, accurate, "
        "thorough, useful, organized, comprehensible, succinct, synthesized) use "
        "integers 1-5; binary dimensions (abstraction, voice_summ, voice_note) use 0 "
        'or 1; "synthesized" may be "NA" when no abstraction is required.\n'
        f"Return ONLY a JSON object with exactly these keys: {keys}.\n\n"
        f"SOURCE:\n{source}\n\nSUMMARY:\n{note}\n"
    )
