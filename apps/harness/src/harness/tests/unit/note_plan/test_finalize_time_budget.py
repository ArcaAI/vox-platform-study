"""The finalizer's note plan stays inside its activity's time budget.

Measured at three concurrent sessions: ``n_finalize`` (``start_to_close`` 300 s) answered its plan
call in 157 s after waiting for the endpoint's concurrency slot, the budget guard (which assumed a
120 s call and started its clock after that wait) let the coverage repair start anyway, and
Temporal cancelled the activity mid-repair at exactly 300 s. The note was lost, not degraded.

Three rules are pinned here:

* a call is costed at the governor's per-call timeout (``HARNESS_LLM_REQUEST_TIMEOUT_S``), the
  longest one call may legitimately take, not at a guess;
* the budget's clock starts when the activity attempt started, so time spent waiting for a
  concurrency slot (or anything else before the budget was built) is charged;
* a truncated call's retry grows only as far as the remaining budget can pay for, and is not
  started at all when it cannot finish.

Hermetic: a fake clock, a fake activity info, and a scripted ``generate``.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from harness.services.note_plan import executor
from harness.services.note_plan.executor import (
    NoteCallRequest,
    NoteCallResult,
    NoteOutputTruncated,
    NotePlanCallFailed,
    execute_plan,
)
from harness.temporal.interpreter.nodes import _text_fallback
from harness.temporal.interpreter.nodes._text_fallback import ActivityBudget
from harness.tests.unit.note_plan.test_executor_followups_task1045 import GAPPY, _plan
from harness.tests.unit.note_plan.test_note_truncation_and_reasoning_task1045 import (
    _CUT,
    _FULL,
    SINGLE,
)


class _Clock:
    """A monotonic clock that only moves when the test says so."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    fake = _Clock()
    monkeypatch.setattr(_text_fallback, "_monotonic", fake, raising=False)
    monkeypatch.setattr(executor, "_monotonic", fake, raising=False)
    monkeypatch.setenv("HARNESS_LLM_REQUEST_TIMEOUT_S", "300")
    return fake


def _in_activity(
    monkeypatch: pytest.MonkeyPatch, *, timeout_s: float, started_ago_s: float = 0.0
) -> None:
    info = SimpleNamespace(
        start_to_close_timeout=timedelta(seconds=timeout_s),
        started_time=datetime.now(UTC) - timedelta(seconds=started_ago_s),
    )
    monkeypatch.setattr(_text_fallback.activity, "info", lambda: info)


# ---------------------------------------------------------------------------------------------
# ActivityBudget
# ---------------------------------------------------------------------------------------------


async def test_the_repair_is_skipped_not_cancelled_when_a_full_call_no_longer_fits(
    monkeypatch: pytest.MonkeyPatch, clock: _Clock
) -> None:
    _in_activity(monkeypatch, timeout_s=300)
    # What the finalizer passes today: `settings.text_timeout_s`.
    budget = ActivityBudget.for_activity(120.0)

    # The endpoint slot is held by another session for 20 s; the call itself then takes 157 s.
    slot = asyncio.Semaphore(1)
    await slot.acquire()

    async def _release_after_20s() -> None:
        await asyncio.sleep(0)
        clock.advance(20)
        slot.release()

    requests: list[NoteCallRequest] = []

    async def generate(request: NoteCallRequest) -> NoteCallResult:
        requests.append(request)
        async with slot:
            clock.advance(157)
        return NoteCallResult(content=GAPPY)

    holder = asyncio.create_task(_release_after_20s())
    execution = await execute_plan(
        _plan(), system=None, user_prefix="P", generate=generate, allow_repair=budget.allows_another
    )
    await holder

    # 177 s spent, 123 s left: a repair may legitimately run 300 s, so it is never started.
    assert [r.kind for r in requests] == ["call"]
    assert execution.repair_skipped == "budget"
    assert execution.coverage.status == "gaps"


def test_the_clock_starts_when_the_activity_attempt_started(
    monkeypatch: pytest.MonkeyPatch, clock: _Clock
) -> None:
    # The budget is built 200 s into a 300 s attempt (slot waits, resolves, governance probes).
    _in_activity(monkeypatch, timeout_s=300, started_ago_s=200)
    budget = ActivityBudget.for_activity(120.0)

    remaining = budget.remaining_seconds
    assert remaining is not None and remaining == pytest.approx(100, abs=2)
    assert budget.allows_another() is False


def test_a_call_is_costed_at_the_governor_per_call_timeout(
    monkeypatch: pytest.MonkeyPatch, clock: _Clock
) -> None:
    _in_activity(monkeypatch, timeout_s=600)
    budget = ActivityBudget.for_activity(120.0)

    clock.advance(250)  # 350 s left: a 300 s call still fits
    assert budget.allows_another() is True
    clock.advance(70)  # 280 s left: it does not, although a 120 s guess would
    assert budget.allows_another() is False


def test_outside_an_activity_the_budget_is_inert(clock: _Clock) -> None:
    budget = ActivityBudget.for_activity(120.0)
    clock.advance(10_000)
    assert budget.remaining_seconds is None
    assert budget.allows_another() is True


# ---------------------------------------------------------------------------------------------
# The truncation retry
# ---------------------------------------------------------------------------------------------


def _length(content: str = _CUT) -> NoteCallResult:
    return NoteCallResult(content=content, stats={"stop_reason": "length"}, stop_reason="length")


def _stop(content: str = _FULL) -> NoteCallResult:
    return NoteCallResult(content=content, stats={"stop_reason": "stop"}, stop_reason="stop")


class _Timed:
    """Answers from a queue, each answer costing ``seconds`` on the fake clock."""

    def __init__(self, clock: _Clock, *answers: tuple[float, NoteCallResult]) -> None:
        self.clock = clock
        self.answers = list(answers)
        self.requests: list[NoteCallRequest] = []

    async def __call__(self, request: NoteCallRequest) -> NoteCallResult:
        self.requests.append(request)
        seconds, result = self.answers.pop(0)
        self.clock.advance(seconds)
        return result


async def test_no_truncation_retry_when_it_cannot_finish_in_the_remaining_budget(
    clock: _Clock,
) -> None:
    plan = _plan(SINGLE)
    deadline = clock.now + 300
    # The cut-off answer took 157 s; 143 s are left, so even an equal-sized retry cannot finish.
    generate = _Timed(clock, (157, _length()))

    with pytest.raises(NotePlanCallFailed) as raised:
        await execute_plan(
            plan,
            system=None,
            user_prefix="data",
            generate=generate,
            remaining_seconds=lambda: deadline - clock.now,
        )

    assert len(generate.requests) == 1
    [record] = raised.value.records
    assert isinstance(record.error, NoteOutputTruncated)
    assert raised.value.truncated_only


async def test_the_retry_grows_only_as_far_as_the_remaining_budget_pays_for(
    clock: _Clock,
) -> None:
    plan = _plan(SINGLE)
    cap = plan.calls[0].max_tokens
    deadline = clock.now + 250
    generate = _Timed(clock, (100, _length()), (100, _stop()), (10, _stop()))

    await execute_plan(
        plan,
        system=None,
        user_prefix="data",
        generate=generate,
        remaining_seconds=lambda: deadline - clock.now,
    )

    first, retry = generate.requests[0], generate.requests[1]
    assert first.max_tokens == cap
    # 150 s left after a 100 s answer: the retry may take at most 1.5x the first call's time.
    assert retry.retry == 1
    assert retry.max_tokens == int(cap * 1.5)


async def test_without_a_remaining_budget_the_retry_still_doubles(clock: _Clock) -> None:
    plan = _plan(SINGLE)
    generate = _Timed(clock, (100, _length()), (100, _stop()), (10, _stop()))

    await execute_plan(plan, system=None, user_prefix="data", generate=generate)

    assert generate.requests[1].max_tokens == 2 * plan.calls[0].max_tokens
