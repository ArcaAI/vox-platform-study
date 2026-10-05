"""Execute a NotePlan: its calls in parallel over ONE block prefix, merge, check, repair once.

The executor never picks a model and never composes inputs. apps/api composed the plan (blocks,
headings, calls, budget) and the CALLER supplies the system prompt, the rendered block prefix and
the text-call function — the ``harness-doc`` activity and the governed finalizer each use their
own existing Text call path. Everything here is Temporal-free; the activities record the steps.

Every call is ``prefix + "\\n\\n" + directive``: the prefix is byte-identical across calls so the
engine reuses its KV prefix, and the directive (which sections to write) is always last.

Trajectory seq offsets inside one activity's 16-wide seq base (pinned by the tests):

* ``0``      — the governed finalizer's NODE step;
* ``1..10``  — one LLM_CALL per plan call (``calls[i]`` at ``1 + i``);
* ``11``     — the repair LLM_CALL;
* ``12..15`` — a call or repair that FAILED.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from harness.services.note_plan.coverage import (
    check_coverage,
    gap_section_keys,
    repair_directive,
)
from harness.services.note_plan.merge import merge_sections, merge_sources, parse_answer
from harness.services.note_plan.models import (
    MAX_NOTE_PLAN_CALLS,
    CoverageResultV1,
    NotePlanV1,
)
from harness.temporal.interpreter.compose_messages import compose_messages

#: At most this many calls in flight at once — the plan's own cap.
MAX_PARALLEL_CALLS = MAX_NOTE_PLAN_CALLS

#: The seq stride both workflows allocate per activity.
SEQ_STRIDE = 16
NODE_STEP_OFFSET = 0
CALL_STEP_OFFSET_BASE = 1
REPAIR_STEP_OFFSET = CALL_STEP_OFFSET_BASE + MAX_NOTE_PLAN_CALLS
FAILED_STEP_OFFSET_BASE = REPAIR_STEP_OFFSET + 1
MAX_FAILED_STEPS = SEQ_STRIDE - FAILED_STEP_OFFSET_BASE

#: `AiActivityKind` members the run-record mapper reads off `stats.activity_kind`.
ACTIVITY_NOTE_GENERATE = "NOTE_GENERATE"
ACTIVITY_NOTE_SECTION_REGEN = "NOTE_SECTION_REGEN"
ACTIVITY_NOTE_SECTION_GROUP = "NOTE_SECTION_GROUP"
ACTIVITY_NOTE_REPAIR = "NOTE_REPAIR"

#: The answer shape every plan call is asked for — the finalizer's own output contract.
NOTE_PLAN_RESPONSE_FORMAT: dict[str, Any] = {
    "type": "json_schema",
    "json_schema": {
        "name": "note_plan_call_output",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["case_note", "redactions", "sources"],
            "properties": {
                "case_note": {"type": "string"},
                "redactions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["text", "label"],
                        "properties": {"text": {"type": "string"}, "label": {"type": "string"}},
                    },
                },
                "sources": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["sectionKey", "refs"],
                        "properties": {
                            "sectionKey": {"type": "string"},
                            "refs": {"type": "array", "items": {"type": "string"}},
                        },
                    },
                },
            },
        },
    },
}


def call_step_offset(index: int) -> int:
    """The seq offset of ``calls[index]`` (0-based)."""
    if not 0 <= index < MAX_NOTE_PLAN_CALLS:
        raise ValueError(f"note plan call index {index} is outside the plan cap")
    return CALL_STEP_OFFSET_BASE + index


def failed_step_offset(index: int) -> int | None:
    """The seq offset of the ``index``-th FAILED call, or ``None`` past the stride (dropped)."""
    return FAILED_STEP_OFFSET_BASE + index if 0 <= index < MAX_FAILED_STEPS else None


@dataclass(frozen=True)
class NoteCallRequest:
    call_id: str
    #: 1-based position in the plan's calls; ``None`` for the repair.
    call_index: int | None
    section_keys: tuple[str, ...]
    system: str | None
    user: str
    max_tokens: int
    kind: Literal["call", "repair"] = "call"


@dataclass(frozen=True)
class NoteCallResult:
    content: str
    stats: dict[str, Any] = field(default_factory=dict)
    provider: str = ""
    model: str = ""
    usage: dict[str, Any] = field(default_factory=dict)
    #: The caller's own result object, carried for the caller (never inspected here).
    raw: Any = None


@dataclass
class NoteCallRecord:
    request: NoteCallRequest
    started_at: datetime
    ended_at: datetime | None = None
    result: NoteCallResult | None = None
    error: BaseException | None = None

    @property
    def call_id(self) -> str:
        return self.request.call_id


@dataclass
class NotePlanExecution:
    #: ``{case_note, redactions, sources: [{sectionKey, refs}]}`` — the finalizer output shape.
    document: dict[str, Any]
    coverage: CoverageResultV1
    #: Every call made, in plan order, then the repair when one ran.
    records: list[NoteCallRecord]
    #: The sections this run wrote (``section_regen``: only the regenerated ones).
    regenerated_keys: tuple[str, ...]


class NotePlanCallFailed(RuntimeError):
    """A plan call raised. A note missing a section group is never assembled."""

    def __init__(self, records: list[NoteCallRecord]) -> None:
        failed = [r.call_id for r in records if r.error is not None]
        super().__init__(f"note plan call(s) failed: {failed}")
        self.records = records


GenerateFn = Callable[[NoteCallRequest], Awaitable[NoteCallResult]]


def render_user_prefix(plan: NotePlanV1) -> str:
    """The plan's blocks, in plan order, wrapped as external data — the shared call prefix."""
    return compose_messages(
        platform_rules="",
        resolved_prompt=None,
        scope={},
        data_blocks=[
            {"key": block.key, "label": block.label, "content": block.content}
            for block in plan.blocks
        ],
    ).user


def _now() -> datetime:
    return datetime.now(UTC)


async def _run(
    generate: GenerateFn, request: NoteCallRequest, gate: asyncio.Semaphore
) -> NoteCallRecord:
    async with gate:
        record = NoteCallRecord(request=request, started_at=_now())
        try:
            record.result = await generate(request)
        except Exception as exc:  # noqa: BLE001 — recorded, then raised as NotePlanCallFailed
            record.error = exc
        record.ended_at = _now()
        return record


def _user(prefix: str, directive: str) -> str:
    return f"{prefix}\n\n{directive}" if prefix else directive


async def execute_plan(
    plan: NotePlanV1,
    *,
    system: str | None,
    user_prefix: str,
    generate: GenerateFn,
    preserved_sections: Mapping[str, str] | None = None,
    max_parallel: int = MAX_PARALLEL_CALLS,
    allow_repair: Callable[[], bool] = lambda: True,
) -> NotePlanExecution:
    """Run ``plan.calls`` (bounded parallel), merge, check coverage, repair the gaps ONCE.

    Raises :class:`NotePlanCallFailed` when any call raised (the note is never assembled from
    a subset), and ``ValueError`` before any call when a ``section_regen`` plan's preserved
    sections were not supplied.
    """
    preserved = dict(preserved_sections or {})
    if plan.preserve is not None:
        missing = sorted(set(plan.preserve.section_keys) - set(preserved))
        if missing:
            raise ValueError(f"preserved section text missing for: {missing}")

    gate = asyncio.Semaphore(max(1, min(max_parallel, MAX_PARALLEL_CALLS)))
    requests = [
        NoteCallRequest(
            call_id=call.call_id,
            call_index=index + 1,
            section_keys=tuple(call.section_keys),
            system=system,
            user=_user(user_prefix, call.directive),
            max_tokens=call.max_tokens,
        )
        for index, call in enumerate(plan.calls)
    ]
    records = list(await asyncio.gather(*(_run(generate, r, gate) for r in requests)))
    if any(record.error is not None for record in records):
        raise NotePlanCallFailed(records)

    generated: dict[str, str] = {}
    sources: dict[str, list[str]] = {}
    redactions: list[dict[str, Any]] = []
    for record in records:
        assert record.result is not None  # noqa: S101 — every errorless record has a result
        answer = parse_answer(record.result.content, plan, record.request.section_keys)
        generated.update(answer.sections)
        sources.update(answer.sources)
        redactions.extend(answer.redactions)

    regenerated = tuple(key for call in plan.calls for key in call.section_keys)

    def _check(repair_passes: int) -> CoverageResultV1:
        whole = {**preserved, **generated}
        return check_coverage(
            plan, whole, sources, repair_passes=repair_passes, checked_keys=regenerated
        )

    coverage = _check(0)
    repair_keys = gap_section_keys(plan, coverage)
    if repair_keys and plan.coverage.repair_passes >= 1 and allow_repair():
        repair = NoteCallRequest(
            call_id="repair",
            call_index=None,
            section_keys=tuple(repair_keys),
            system=system,
            user=_user(user_prefix, repair_directive(plan, coverage, repair_keys)),
            max_tokens=max(
                call.max_tokens for call in plan.calls if set(call.section_keys) & set(repair_keys)
            ),
            kind="repair",
        )
        [repaired] = await asyncio.gather(_run(generate, repair, gate))
        records.append(repaired)
        if repaired.result is not None:
            answer = parse_answer(repaired.result.content, plan, repair.section_keys)
            for key in repair_keys:
                if key in answer.sections:
                    generated[key] = answer.sections[key]
                    sources[key] = answer.sources.get(key, [])
            redactions.extend(answer.redactions)
            coverage = _check(1)
        else:
            # The repair itself failed: the note keeps the gaps it had, and says one was tried.
            coverage = coverage.model_copy(update={"repair_passes": 1})

    document = {
        "case_note": merge_sections(plan, generated, preserved),
        "redactions": redactions,
        "sources": merge_sources(plan, {k: v for k, v in sources.items() if k in regenerated}),
    }
    return NotePlanExecution(
        document=document,
        coverage=coverage,
        records=records,
        regenerated_keys=regenerated,
    )


def last_encounter_seq(plan: NotePlanV1) -> int | None:
    seqs = [encounter.seq for encounter in plan.sources.encounters]
    return max(seqs) if seqs else None


def call_run_stats(plan: NotePlanV1, request: NoteCallRequest) -> dict[str, Any]:
    """The run-record keys a plan call's LLM_CALL step carries (ids and numbers only)."""
    stats: dict[str, Any] = {
        "activity_kind": (
            ACTIVITY_NOTE_REPAIR if request.kind == "repair" else ACTIVITY_NOTE_SECTION_GROUP
        ),
        "plan_id": plan.plan_id,
        "budget_strategy": plan.budget.strategy,
        "call_count": len(plan.calls),
        "context_window": plan.budget.context_window,
        "max_tokens": request.max_tokens,
    }
    if request.call_index is not None:
        stats["call_index"] = request.call_index
    seq = last_encounter_seq(plan)
    if seq is not None:
        stats["encounter_seq"] = seq
    return stats


def note_run_stats(plan: NotePlanV1, execution: NotePlanExecution) -> dict[str, Any]:
    """The note-level run record (NOTE_GENERATE / NOTE_SECTION_REGEN) — ids and numbers only.

    The caller adds ``context_item_id`` / ``output_version`` once the note is persisted."""
    stats: dict[str, Any] = {
        "activity_kind": (
            ACTIVITY_NOTE_SECTION_REGEN if plan.mode == "section_regen" else ACTIVITY_NOTE_GENERATE
        ),
        "plan_id": plan.plan_id,
        "budget_strategy": plan.budget.strategy,
        "call_count": len(plan.calls),
        "context_window": plan.budget.context_window,
        "coverage_status": execution.coverage.status,
        "coverage_gap_count": len(execution.coverage.gaps),
        "repair_passes": execution.coverage.repair_passes,
    }
    seq = last_encounter_seq(plan)
    if seq is not None:
        stats["encounter_seq"] = seq
    return stats


def summed_usage(records: Sequence[NoteCallRecord]) -> dict[str, Any]:
    """Token usage summed over every call that answered (the per-run budget reads it)."""
    totals: dict[str, int] = {}
    for record in records:
        if record.result is None:
            continue
        for key, value in (record.result.usage or {}).items():
            if isinstance(value, int) and not isinstance(value, bool):
                totals[key] = totals.get(key, 0) + value
    return dict(totals)
