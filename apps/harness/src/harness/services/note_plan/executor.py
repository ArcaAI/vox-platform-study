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
* ``12..15`` — a call or repair that FAILED (a call cut off by its output budget included).

An answer that stopped because it ran out of output tokens (``stop_reason == "length"``) is never
merged: a cut-off section is a wrong note. The call is retried ONCE with more room — twice its
cap, bounded by what the model's window leaves after the prompt and the plan's safety margin — and
a second cut-off fails the call. A note in which no section was written at all is not a note
either: the executor raises instead of assembling one from the not-discussed marker.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any, Literal

from harness.services.note_plan.coverage import (
    check_coverage,
    gap_section_keys,
    repair_directive,
)
from harness.services.note_plan.merge import (
    NOT_DISCUSSED_MARKER,
    merge_sections,
    merge_sources,
    parse_answer,
)
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

#: The normalised stop reason of an answer the output budget cut off (``apps/text`` stats).
STOP_LENGTH = "length"
#: A cut-off call is retried once with this many times its cap (bounded by the window).
TRUNCATION_RETRY_GROWTH = 2


def section_response_format(section_keys: Sequence[str]) -> dict[str, Any]:
    """The answer shape ONE call is asked for: one string per section it was given, keyed by
    section key, beside the finalizer's ``redactions`` and ``sources``.

    Constraining each call to its own keys is what keeps a model from inventing its own layout
    (a title-keyed object, a list per section) that the merge would otherwise have to guess at.
    A section key that collides with ``redactions`` / ``sources`` replaces that property.
    """
    keys = list(dict.fromkeys(section_keys))
    # The section keys lead: under constrained decoding a small model fills properties in declared
    # order, and one that met `redactions` first wrote the whole note there and ran out of tokens.
    properties: dict[str, Any] = {key: {"type": "string"} for key in keys}
    finalizer_properties: dict[str, Any] = {
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
                    "sectionKey": {"type": "string", "enum": keys},
                    "refs": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
    }
    for name, spec in finalizer_properties.items():
        properties.setdefault(name, spec)
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "note_plan_sections_output",
            "strict": True,
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "required": [*keys, *(k for k in properties if k not in keys)],
                "properties": properties,
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
    #: The structured-output constraint this call is sent with (:func:`section_response_format`).
    response_format: dict[str, Any] | None = None
    #: ``1`` on the one retry of a call its output budget cut off (callers key idempotency on it).
    retry: int = 0


@dataclass(frozen=True)
class NoteCallResult:
    content: str
    stats: dict[str, Any] = field(default_factory=dict)
    provider: str = ""
    model: str = ""
    usage: dict[str, Any] = field(default_factory=dict)
    #: The caller's own result object, carried for the caller (never inspected here).
    raw: Any = None
    #: The candidate that served, when the call walked a fallback chain (``fallback.py``).
    attempt: Any = None
    #: The candidates tried and lost before the one that served (``fallback.FailedLeg``).
    failed_legs: tuple[Any, ...] = ()
    #: The normalised stop reason (``"length"`` = the output budget ran out).
    stop_reason: str = ""


def stop_reason_of(result: Any) -> str:
    """The normalised stop reason of a Text result: ``stats.stop_reason``, else ``finish_reason``."""
    stats = getattr(result, "stats", None)
    if isinstance(stats, dict) and isinstance(stats.get("stop_reason"), str):
        return stats["stop_reason"]
    finish = getattr(result, "finish_reason", "")
    return finish if isinstance(finish, str) else ""


class NoteOutputTruncated(RuntimeError):
    """The call's answer was cut off by its output budget (after the one retry, when allowed)."""


@dataclass(frozen=True)
class TruncatedAttempt:
    """One answer the output budget cut off: recorded on the run record, never merged."""

    request: NoteCallRequest
    started_at: datetime
    ended_at: datetime
    result: NoteCallResult


class NoteCallAttemptsLost(Exception):  # noqa: N818 — a carrier, raised for the executor
    """Every candidate a call was allowed to try lost. Carries the LAST error (what the activity
    judges retry-safety on), the candidate that raised it, and the legs lost before it."""

    def __init__(self, error: BaseException, attempt: Any, failed_legs: tuple[Any, ...]) -> None:
        super().__init__(str(error))
        self.error = error
        self.attempt = attempt
        self.failed_legs = failed_legs


@dataclass
class NoteCallRecord:
    request: NoteCallRequest
    started_at: datetime
    ended_at: datetime | None = None
    result: NoteCallResult | None = None
    error: BaseException | None = None
    #: The candidate that served (or lost last); ``None`` without a fallback walk.
    attempt: Any = None
    #: Candidates tried and lost before ``attempt`` (``fallback.FailedLeg``).
    failed_legs: tuple[Any, ...] = ()
    #: Answers cut off by the output budget (the first try, and the retry when it was cut too).
    truncated: tuple[TruncatedAttempt, ...] = ()

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
    #: Why gaps went unrepaired: ``"budget"`` (no room left in the activity for the call) or
    #: ``"disabled"`` (the plan allows no repair). ``None`` when no repair was needed or it ran.
    #: The coverage stays ``gaps`` either way, so the note goes to review.
    repair_skipped: Literal["budget", "disabled"] | None = None


class NotePlanCallFailed(RuntimeError):
    """A plan call raised. A note missing a section group is never assembled."""

    def __init__(self, records: list[NoteCallRecord]) -> None:
        failed = [r.call_id for r in records if r.error is not None]
        super().__init__(f"note plan call(s) failed: {failed}")
        self.records = records

    @property
    def truncated_only(self) -> bool:
        """Every failed call was cut off by its output budget (no other cause)."""
        errors = [r.error for r in self.records if r.error is not None]
        return bool(errors) and all(isinstance(e, NoteOutputTruncated) for e in errors)


class NotePlanEmptyNote(NotePlanCallFailed):
    """Every call answered, but no section of the note was written: there is no note to store."""

    def __init__(self, records: list[NoteCallRecord]) -> None:
        RuntimeError.__init__(self, "the note plan wrote no section")
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
    generate: GenerateFn,
    request: NoteCallRequest,
    gate: asyncio.Semaphore,
    *,
    retry_max_tokens: int | None = None,
    allow_retry: Callable[[], bool] = lambda: True,
) -> NoteCallRecord:
    async with gate:
        record = NoteCallRecord(request=request, started_at=_now())
        truncated: list[TruncatedAttempt] = []
        current = request
        try:
            while True:
                started = _now()
                result = await generate(current)
                if result.stop_reason != STOP_LENGTH:
                    record.result = result
                    break
                truncated.append(TruncatedAttempt(current, started, _now(), result))
                if current.retry or retry_max_tokens is None or not allow_retry():
                    record.error = NoteOutputTruncated(
                        f"note plan call {request.call_id} was cut off by its output budget "
                        f"({current.max_tokens} tokens)"
                    )
                    break
                current = replace(current, max_tokens=retry_max_tokens, retry=1)
            record.request = current
            if record.result is not None:
                record.attempt = record.result.attempt
                record.failed_legs = record.result.failed_legs
        except NoteCallAttemptsLost as lost:
            record.error = lost.error
            record.attempt = lost.attempt
            record.failed_legs = lost.failed_legs
        except Exception as exc:  # noqa: BLE001 — recorded, then raised as NotePlanCallFailed
            record.error = exc
        record.truncated = tuple(truncated)
        record.ended_at = _now()
        return record


def _retry_max_tokens(plan: NotePlanV1, call: Any) -> int | None:
    """The cap of a cut-off call's one retry, or ``None`` when the window leaves no more room."""
    room = plan.budget.context_window - call.prompt_tokens - plan.budget.safety_tokens
    cap = min(call.max_tokens * TRUNCATION_RETRY_GROWTH, room)
    return cap if cap > call.max_tokens else None


def _written(body: str | None) -> bool:
    text = (body or "").strip()
    return bool(text) and text != NOT_DISCUSSED_MARKER


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
            response_format=section_response_format(call.section_keys),
        )
        for index, call in enumerate(plan.calls)
    ]
    records = list(
        await asyncio.gather(
            *(
                _run(
                    generate,
                    r,
                    gate,
                    retry_max_tokens=_retry_max_tokens(plan, call),
                    allow_retry=allow_repair,
                )
                for r, call in zip(requests, plan.calls, strict=True)
            )
        )
    )
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
    repair_skipped: Literal["budget", "disabled"] | None = None
    if repair_keys and plan.coverage.repair_passes < 1:
        repair_skipped = "disabled"
    elif repair_keys and not allow_repair():
        repair_skipped = "budget"
    if repair_skipped is not None:
        # The coverage sent on carries the reason too, so review sees why the gaps stayed.
        coverage = coverage.model_copy(update={"repair_skipped": repair_skipped})
    if repair_keys and repair_skipped is None:
        repair = NoteCallRequest(
            call_id="repair",
            call_index=None,
            section_keys=tuple(repair_keys),
            system=system,
            user=_user(
                user_prefix,
                repair_directive(
                    plan, coverage, repair_keys, {k: generated.get(k, "") for k in repair_keys}
                ),
            ),
            max_tokens=max(
                call.max_tokens for call in plan.calls if set(call.section_keys) & set(repair_keys)
            ),
            kind="repair",
            response_format=section_response_format(repair_keys),
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

    if not any(_written(generated.get(key)) for key in regenerated):
        raise NotePlanEmptyNote(records)

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
        repair_skipped=repair_skipped,
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
    if execution.repair_skipped is not None:
        stats["repair_skipped"] = execution.repair_skipped
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
