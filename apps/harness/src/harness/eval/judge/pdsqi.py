"""PDSQI-9 LLM-as-judge driver.

Builds the Epic instrument prompt, calls a model-agnostic
:class:`~harness.eval.judge.base.JudgeClient`, and parses the JSON response into
a validated :class:`~harness.eval.models.PDSQIScore`. Robust to reasoning models
that prefix a ``<think>…</think>`` block and to both score-only and
score+explanation output modes.
"""

from __future__ import annotations

import json
import math
import statistics

from harness.eval.jsonio import extract_last_object, strip_reasoning
from harness.eval.judge.base import JudgeClient, JudgeParseError
from harness.eval.judge.prompts import OutputMode, resolve_prompt
from harness.eval.models import (
    PDSQI_BINARY_DIMENSIONS,
    PDSQI_DIMENSIONS,
    GoldenCase,
    PDSQIResult,
    PDSQIScore,
)

_LIKERT = {"citation", "accurate", "thorough", "useful", "organized", "comprehensible", "succinct"}
# The seven always-present 1–5 Likert dimensions (``synthesized`` is handled
# separately because it may be NA/None).
_REQUIRED_LIKERT: tuple[str, ...] = (
    "citation",
    "accurate",
    "thorough",
    "useful",
    "organized",
    "comprehensible",
    "succinct",
)


def _round_half_up(value: float) -> int:
    """Deterministic round-half-up (statistics.median can yield ``x.5``)."""
    return int(math.floor(value + 0.5))


def _clamp_likert(value: int) -> int:
    return max(1, min(5, value))


def aggregate_scores(scores: list[PDSQIScore]) -> PDSQIScore:
    """Aggregate K self-consistency samples into one robust :class:`PDSQIScore`.

    Per-dimension **median** (round-half-up) for the 1–5 Likert dimensions —
    robust to a single outlier sample — and **majority vote** for the 0/1
    categorical flags. ``synthesized`` collapses to NA/None when most samples
    marked it NA. With a single sample this is the identity (no behaviour change).
    The justifications of the sample closest to the aggregate are kept so the
    rationale stays consistent with the reported scores.
    """
    if len(scores) == 1:
        return scores[0]

    fields: dict[str, int | None] = {}
    for dim in _REQUIRED_LIKERT:
        values = [getattr(s, dim) for s in scores]
        fields[dim] = _clamp_likert(_round_half_up(statistics.median(values)))

    syn_values = [s.synthesized for s in scores]
    present = [v for v in syn_values if v is not None]
    if not present or (len(syn_values) - len(present)) >= len(present):
        fields["synthesized"] = None
    else:
        fields["synthesized"] = _clamp_likert(_round_half_up(statistics.median(present)))

    for dim in PDSQI_BINARY_DIMENSIONS:
        values = [getattr(s, dim) for s in scores]
        fields[dim] = 1 if (sum(values) / len(values)) >= 0.5 else 0

    representative = _closest_sample(scores, fields)
    return PDSQIScore(**fields, justifications=dict(representative.justifications))


def _closest_sample(scores: list[PDSQIScore], aggregate: dict[str, int | None]) -> PDSQIScore:
    """The sample with the smallest L1 distance to the aggregate Likert vector."""

    def distance(score: PDSQIScore) -> int:
        return sum(abs(getattr(score, dim) - int(aggregate[dim])) for dim in _REQUIRED_LIKERT)

    return min(scores, key=distance)


def _strip_reasoning(text: str) -> str:
    """Strip reasoning scaffolding (think/harmony/Gemma leaks).

    Thin wrapper over :func:`harness.eval.jsonio.strip_reasoning` so the judge and
    the tolerant JSON loader share ONE implementation (no divergence).
    """
    return strip_reasoning(text)


def _extract_json_object(text: str) -> str:
    """Return the model's FINAL balanced ``{...}`` object (the answer).

    Prefers the LAST top-level object so a ``{`` left inside leaked
    chain-of-thought (a harmony analysis channel, a Gemma thought block) is never
    mistaken for the score JSON; with a single object present this is identity.
    """
    obj = extract_last_object(text)
    if obj is None:
        raise JudgeParseError("no JSON object found in judge response")
    return obj


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
    """Scores a summary against the PDSQI-9 instrument via a judge client.

    Calibration knobs (all default to the prior single-pass behaviour):

    * ``anchored`` — append rubric-faithful guidance + exemplars to the prompt.
    * ``self_consistency`` — sample the judge K times and take the per-dimension
      median (variance reduction); ``1`` is a single deterministic pass.
    * ``sc_temperature`` — decoding temperature for the K>1 diversity samples.
    * ``seed`` — base decoding seed. For K>1 each sample i uses ``seed + i`` so the
      samples are *distinct but reproducible* (a single fixed seed would make every
      sample identical and defeat self-consistency); ``None`` lets each sample draw
      a fresh random seed.
    * ``reasoning_mode`` — system-prompt reasoning lever forwarded to
      :func:`resolve_prompt`: ``"auto"`` (neutral default; safe across reasoning
      and non-reasoning families), ``"think"`` (elicit a ``<think>`` pass), or
      ``"none"`` (JSON-only). Regardless of the lever, leaked reasoning is stripped
      and the FINAL JSON answer extracted (server thinking switches are unreliable).
    * ``suppress_reasoning`` — back-compat alias for ``reasoning_mode="none"``.
    """

    def __init__(
        self,
        client: JudgeClient,
        output_mode: OutputMode = OutputMode.WITH_EXPLANATION,
        *,
        anchored: bool = False,
        self_consistency: int = 1,
        sc_temperature: float = 0.2,
        seed: int | None = None,
        reasoning_mode: str = "auto",
        suppress_reasoning: bool = False,
    ) -> None:
        self._client = client
        self._output_mode = output_mode
        self._anchored = anchored
        self._self_consistency = max(1, int(self_consistency))
        self._sc_temperature = sc_temperature
        self._seed = seed
        self._reasoning_mode = reasoning_mode
        self._suppress_reasoning = suppress_reasoning

    @property
    def model(self) -> str:
        return self._client.model

    def build_messages(self, case: GoldenCase) -> list[dict[str, str]]:
        return resolve_prompt(
            notes=case.source_documents,
            summary=case.generated_note,
            target_specialty=case.target_specialty,
            output_mode=self._output_mode,
            anchored=self._anchored,
            reasoning_mode=self._reasoning_mode,
            suppress_reasoning=self._suppress_reasoning,
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
        """Run the judge on a single case and return a typed result.

        With ``self_consistency > 1`` the judge is sampled K times and the
        per-dimension median is taken. Parse failures on individual samples are
        tolerated (skipped) as long as at least one sample parses; a single-pass
        judge still raises on a malformed response (unchanged contract).
        """
        messages = self.build_messages(case)
        k = self._self_consistency
        raws: list[str] = []
        parsed: list[PDSQIScore] = []
        last_error: JudgeParseError | None = None
        for i in range(k):
            if k == 1:
                raw = await self._client.complete(messages, json_mode=False, seed=self._seed)
            else:
                # Distinct-but-reproducible seed per sample so the K samples are
                # actually diverse (a single fixed seed would collapse them).
                sample_seed = None if self._seed is None else self._seed + i
                raw = await self._client.complete(
                    messages,
                    json_mode=False,
                    temperature=self._sc_temperature,
                    seed=sample_seed,
                )
            raws.append(raw)
            try:
                parsed.append(self.parse(raw))
            except JudgeParseError as exc:
                if k == 1:
                    raise
                last_error = exc

        if not parsed:
            raise JudgeParseError(
                f"all {k} self-consistency samples failed to parse; last error: {last_error}"
            )

        score = aggregate_scores(parsed)
        return PDSQIResult(
            case_id=case.case_id, score=score, model=self.model, raw_response=raws[0]
        )
