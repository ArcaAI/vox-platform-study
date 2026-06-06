"""PDSQI-9 LLM-as-judge driver.

Builds the Epic instrument prompt, calls a model-agnostic
:class:`~harness.eval.judge.base.JudgeClient`, and parses the JSON response into
a validated :class:`~harness.eval.models.PDSQIScore`. Robust to reasoning models
that prefix a ``<think>…</think>`` block and to both score-only and
score+explanation output modes.
"""

from __future__ import annotations

import json
import re

from harness.eval.judge.base import JudgeClient, JudgeParseError
from harness.eval.judge.prompts import OutputMode, resolve_prompt
from harness.eval.models import PDSQI_DIMENSIONS, GoldenCase, PDSQIResult, PDSQIScore

_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_LIKERT = {"citation", "accurate", "thorough", "useful", "organized", "comprehensible", "succinct"}


def _strip_reasoning(text: str) -> str:
    """Remove ``<think>…</think>`` blocks (and any dangling open tag)."""
    text = _THINK_BLOCK.sub("", text)
    # An unclosed <think> (truncated reasoning) — drop everything up to the JSON.
    lowered = text.lower()
    if "<think>" in lowered:
        brace = text.find("{")
        if brace != -1:
            text = text[brace:]
    return text.strip()


def _extract_json_object(text: str) -> str:
    """Return the first balanced ``{...}`` object, ignoring braces in strings."""
    start = text.find("{")
    if start == -1:
        raise JudgeParseError("no JSON object found in judge response")
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    raise JudgeParseError("unbalanced JSON object in judge response")


def _coerce_score(value: object, *, allow_na: bool) -> int | None:
    if isinstance(value, str):
        v = value.strip()
        if allow_na and v.upper() == "NA":
            return None
        try:
            return int(float(v))
        except ValueError as exc:
            raise JudgeParseError(f"non-numeric score {value!r}") from exc
    if isinstance(value, bool):  # guard: bool is an int subclass
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    raise JudgeParseError(f"unsupported score type for {value!r}")


class PDSQI9Judge:
    """Scores a summary against the PDSQI-9 instrument via a judge client."""

    def __init__(
        self, client: JudgeClient, output_mode: OutputMode = OutputMode.WITH_EXPLANATION
    ) -> None:
        self._client = client
        self._output_mode = output_mode

    @property
    def model(self) -> str:
        return self._client.model

    def build_messages(self, case: GoldenCase) -> list[dict[str, str]]:
        return resolve_prompt(
            notes=case.source_documents,
            summary=case.generated_note,
            target_specialty=case.target_specialty,
            output_mode=self._output_mode,
        )

    def parse(self, raw: str) -> PDSQIScore:
        """Parse a raw judge response into a validated :class:`PDSQIScore`."""
        cleaned = _strip_reasoning(raw)
        obj_text = _extract_json_object(cleaned)
        try:
            obj = json.loads(obj_text)
        except json.JSONDecodeError as exc:
            raise JudgeParseError(f"invalid JSON in judge response: {exc}") from exc
        if not isinstance(obj, dict):
            raise JudgeParseError("judge response JSON is not an object")

        normalized = {str(k).strip().lower(): v for k, v in obj.items()}

        fields: dict[str, int | None] = {}
        justifications: dict[str, str] = {}
        for dim in PDSQI_DIMENSIONS:
            if dim not in normalized:
                raise JudgeParseError(f"missing PDSQI dimension: {dim}")
            value = normalized[dim]
            if isinstance(value, dict):
                justification = value.get("explanation")
                if justification:
                    justifications[dim] = str(justification)
                value = value.get("score")
            fields[dim] = _coerce_score(value, allow_na=(dim == "synthesized"))

        try:
            return PDSQIScore(**fields, justifications=justifications)
        except Exception as exc:  # pydantic ValidationError → typed parse error
            raise JudgeParseError(f"PDSQI score validation failed: {exc}") from exc

    async def score(self, case: GoldenCase) -> PDSQIResult:
        """Run the judge on a single case and return a typed result."""
        messages = self.build_messages(case)
        raw = await self._client.complete(messages, json_mode=False)
        score = self.parse(raw)
        return PDSQIResult(case_id=case.case_id, score=score, model=self.model, raw_response=raw)
