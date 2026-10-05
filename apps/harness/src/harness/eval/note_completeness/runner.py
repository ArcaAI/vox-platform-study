"""Run the multi-encounter golden set: execute (or take) each case's note, score it, gate it.

A case arrives as its golden reference plus the NotePlan apps/api composed from the case's
envelope (the harness never composes). Its note is either SUPPLIED (``output``: a note an earlier
run produced, with the latency its run record measured) or GENERATED here by executing the plan
through :func:`harness.services.note_plan.executor.execute_plan` with an injected text call — a
stub in tests, the Text service on a live run.

The thresholds always come from the caller (the gateway reads them from the settings registry);
nothing here defaults one.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from harness.eval.note_completeness.metrics import (
    CaseScore,
    GoldenReference,
    aggregate,
    failed_case,
    score_case,
)
from harness.services.note_plan.executor import (
    GenerateFn,
    NoteCallRecord,
    NoteCallRequest,
    NoteCallResult,
    NotePlanCallFailed,
    execute_plan,
    render_user_prefix,
)
from harness.services.note_plan.models import NotePlanV1

GOLDEN_FIXTURE = (
    Path(__file__).resolve().parent.parent / "golden" / "fixtures" / "multi_encounter_v1.json"
)

#: The ``judgeModel`` stamped on every score row: these metrics are computed, never judged.
NOTE_COMPLETENESS_SCORER = "note-completeness"


class _Wire(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")


class NoteCompletenessThresholds(_Wire):
    """The gate. Every field is required: a threshold is configuration, never a code default."""

    critical_fact_recall_min: float = Field(ge=0, le=1)
    dose_accuracy_min: float = Field(ge=0, le=1)
    unsupported_rate_max: float = Field(ge=0, le=1)
    #: ``0`` records the p95 without gating it.
    latency_p95_max_ms: float = Field(ge=0)

    def as_aggregate_limits(self) -> dict[str, float]:
        return {
            "critical_fact_recall": self.critical_fact_recall_min,
            "dose_accuracy": self.dose_accuracy_min,
            "unsupported_rate": self.unsupported_rate_max,
            "stop_to_note_p95_ms": self.latency_p95_max_ms,
        }


class CaseOutput(_Wire):
    case_note: str
    sources: list[dict[str, Any]] = Field(default_factory=list)
    latency_ms: float | None = Field(default=None, ge=0)


class NoteCompletenessCaseInput(_Wire):
    case_id: str
    reference: GoldenReference
    plan: NotePlanV1
    output: CaseOutput | None = None


class NoteCompletenessRun(BaseModel):
    golden_set_version: str
    name: str | None = None
    case_scores: list[CaseScore]
    aggregates: dict[str, float]
    thresholds: dict[str, float]
    passed: bool
    failures: list[str]


def load_golden_fixture(path: Path | None = None) -> dict[str, Any]:
    """The committed synthetic golden set (``{schema, version, name, cases[]}``)."""
    with (path or GOLDEN_FIXTURE).open(encoding="utf-8") as fh:
        data: dict[str, Any] = json.load(fh)
    return data


def apply_thresholds(
    aggregates: dict[str, float], thresholds: NoteCompletenessThresholds
) -> tuple[bool, list[str]]:
    """``(passed, failures)`` — one failure line per breached threshold, in a fixed order."""
    failures: list[str] = []
    recall = aggregates.get("critical_fact_recall", 0.0)
    if recall < thresholds.critical_fact_recall_min:
        failures.append(
            f"critical_fact_recall {recall:.4f} < {thresholds.critical_fact_recall_min:.4f}"
        )
    dose = aggregates.get("dose_accuracy", 0.0)
    if dose < thresholds.dose_accuracy_min:
        failures.append(f"dose_accuracy {dose:.4f} < {thresholds.dose_accuracy_min:.4f}")
    unsupported = aggregates.get("unsupported_rate", 1.0)
    if unsupported > thresholds.unsupported_rate_max:
        failures.append(
            f"unsupported_rate {unsupported:.4f} > {thresholds.unsupported_rate_max:.4f}"
        )
    latency = aggregates.get("stop_to_note_p95_ms")
    if thresholds.latency_p95_max_ms > 0 and (
        latency is None or latency > thresholds.latency_p95_max_ms
    ):
        shown = "missing" if latency is None else f"{latency:.0f}"
        failures.append(f"stop_to_note_p95_ms {shown} > {thresholds.latency_p95_max_ms:.0f}")
    return not failures, failures


def _records_latency_ms(records: Sequence[NoteCallRecord]) -> float | None:
    """First call start → last call end, from the run's own call records."""
    starts = [r.started_at for r in records]
    ends = [r.ended_at for r in records if r.ended_at is not None]
    if not starts or not ends:
        return None
    return max(0.0, (max(ends) - min(starts)).total_seconds() * 1000.0)


#: Builds the text call for one plan (the live path: provider + model come from the plan).
GenerateFactory = Callable[[NotePlanV1], GenerateFn]


async def _score_one(case: NoteCompletenessCaseInput, generate: GenerateFn | None) -> CaseScore:
    if case.output is not None:
        return score_case(
            case_id=case.case_id,
            reference=case.reference,
            plan=case.plan,
            case_note=case.output.case_note,
            sources=case.output.sources,
            latency_ms=case.output.latency_ms,
        )
    if generate is None:
        raise ValueError(f"case {case.case_id} has no output and no text call was supplied")
    plan = case.plan
    try:
        execution = await execute_plan(
            plan, system=plan.system, user_prefix=render_user_prefix(plan), generate=generate
        )
    except (NotePlanCallFailed, ValueError) as exc:
        return failed_case(case_id=case.case_id, reference=case.reference, plan=plan, error=exc)
    return score_case(
        case_id=case.case_id,
        reference=case.reference,
        plan=plan,
        case_note=execution.document["case_note"],
        sources=execution.document["sources"],
        latency_ms=_records_latency_ms(execution.records),
    )


async def run_note_completeness(
    cases: Sequence[NoteCompletenessCaseInput],
    *,
    thresholds: NoteCompletenessThresholds,
    generate: GenerateFn | None = None,
    generate_for: GenerateFactory | None = None,
    version: str = "v1",
    name: str | None = None,
) -> NoteCompletenessRun:
    """Score every case (sequentially — the cases share one engine), aggregate, gate.

    A case without a supplied ``output`` is generated with ``generate`` or, when given,
    ``generate_for(case.plan)``."""
    scores = [
        await _score_one(case, generate_for(case.plan) if generate_for else generate)
        for case in cases
    ]
    aggregates = aggregate(scores)
    passed, failures = apply_thresholds(aggregates, thresholds)
    errored = [s.case_id for s in scores if s.status == "error"]
    if errored:
        passed = False
        failures.append(f"case_errors {len(errored)}: {', '.join(errored)}")
    return NoteCompletenessRun(
        golden_set_version=version,
        name=name,
        case_scores=scores,
        aggregates=aggregates,
        thresholds=thresholds.as_aggregate_limits(),
        passed=passed,
        failures=failures,
    )


def text_generate_fn(
    text_client: Any,
    *,
    tenant_id: str,
    provider: str,
    model: str,
    temperature: float | None,
    response_format: dict[str, Any] | None = None,
) -> GenerateFn:
    """A :data:`GenerateFn` over the harness Text client — the live (A/B) path."""

    async def _generate(request: NoteCallRequest) -> NoteCallResult:
        result = await text_client.generate(
            tenant_id=tenant_id,
            prompt=request.user,
            system_prompt=request.system,
            provider=provider,
            model=model,
            temperature=temperature,
            max_tokens=request.max_tokens,
            response_format=response_format,
        )
        return NoteCallResult(
            content=result.content,
            provider=result.provider,
            model=result.model,
            usage=result.usage,
        )

    return _generate


def case_score_rows(run: NoteCompletenessRun) -> list[dict[str, Any]]:
    """One ``EvalScore`` row per (case, metric) — the shape apps/api persists."""
    rows: list[dict[str, Any]] = []
    for score in run.case_scores:
        metrics: list[tuple[str, float | None, float | None]] = [
            ("critical_fact_recall", score.critical_fact_recall, 1.0),
            ("dose_accuracy", score.dose_accuracy, 1.0),
            ("unsupported_rate", score.unsupported_rate, 1.0),
            ("stop_to_note_ms", score.latency_ms, None),
        ]
        for metric, value, max_score in metrics:
            if value is None:
                continue
            rows.append(
                {
                    "caseId": score.case_id,
                    "metric": metric,
                    "score": value,
                    "maxScore": max_score,
                    "judgeModel": NOTE_COMPLETENESS_SCORER,
                }
            )
    return rows


__all__ = [
    "GOLDEN_FIXTURE",
    "NOTE_COMPLETENESS_SCORER",
    "CaseOutput",
    "GenerateFactory",
    "NoteCompletenessCaseInput",
    "NoteCompletenessRun",
    "NoteCompletenessThresholds",
    "apply_thresholds",
    "case_score_rows",
    "load_golden_fixture",
    "run_note_completeness",
    "text_generate_fn",
]
