"""NotePlan executor follow-ups: a skipped repair says why, and a plan call walks the fallback
chain — narrowed to candidates that serve the PLAN's model.

Hermetic: plans come from the pinned fixture, Text and the gateway are stubbed, the activity runs
under ``ActivityEnvironment``.
"""

from __future__ import annotations

import dataclasses
import json
from datetime import timedelta
from typing import Any

import pytest
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from harness.core.config import Settings
from harness.services.note_plan.executor import (
    FAILED_STEP_OFFSET_BASE,
    NoteCallRequest,
    NoteCallResult,
    NotePlanCallFailed,
    execute_plan,
    note_run_stats,
)
from harness.services.note_plan.fallback import PlanAttempt, plan_attempts, walk_attempts
from harness.services.note_plan.models import NotePlanRef, NotePlanV1
from harness.services.text_client import TextGenerationResult, TextServiceError
from harness.temporal import activities
from harness.temporal.interpreter.nodes._text_fallback import TextFallbackCandidate
from harness.temporal.models import ExecuteNotePlanInput, TrajectoryContext
from harness.tests.unit.note_plan.test_coverage_task1045 import (
    COMPLETE_SECTIONS,
    COMPLETE_SOURCES,
    FIXTURE,
    SINGLE,
    _answer,
)


def _raw(name: str = SINGLE) -> dict[str, Any]:
    raw = next(case["plan"] for case in FIXTURE["notePlans"] if case["name"] == name)
    return json.loads(json.dumps(raw))


def _plan(name: str = SINGLE) -> NotePlanV1:
    return NotePlanV1.model_validate(_raw(name))


GAPPY = _answer({**COMPLETE_SECTIONS, "plan": "Metformin 1000 mg."}, COMPLETE_SOURCES)
COMPLETE = _answer(COMPLETE_SECTIONS, COMPLETE_SOURCES)


class _Scripted:
    def __init__(self, *answers: str) -> None:
        self.answers = list(answers)
        self.requests: list[NoteCallRequest] = []

    async def __call__(self, request: NoteCallRequest) -> NoteCallResult:
        self.requests.append(request)
        return NoteCallResult(content=self.answers.pop(0))


# ---------------------------------------------------------------------------------------------
# A skipped repair is never silent
# ---------------------------------------------------------------------------------------------


async def test_a_repair_the_budget_cannot_fit_is_recorded_as_skipped() -> None:
    plan = _plan()
    execution = await execute_plan(
        plan, system=None, user_prefix="P", generate=_Scripted(GAPPY), allow_repair=lambda: False
    )

    assert execution.repair_skipped == "budget"
    # The gaps stay gaps — the note goes to review, never "complete".
    assert execution.coverage.status == "gaps"
    assert execution.coverage.repair_passes == 0
    stats = note_run_stats(plan, execution)
    assert stats["repair_skipped"] == "budget"
    assert stats["coverage_status"] == "gaps"


async def test_a_plan_that_allows_no_repair_records_it_as_disabled() -> None:
    raw = _raw()
    raw["coverage"]["repairPasses"] = 0
    plan = NotePlanV1.model_validate(raw)

    execution = await execute_plan(plan, system=None, user_prefix="P", generate=_Scripted(GAPPY))

    assert execution.repair_skipped == "disabled"
    assert note_run_stats(plan, execution)["repair_skipped"] == "disabled"


async def test_no_skip_is_recorded_when_nothing_needed_repair() -> None:
    plan = _plan()
    execution = await execute_plan(
        plan, system=None, user_prefix="P", generate=_Scripted(COMPLETE), allow_repair=lambda: False
    )

    assert execution.repair_skipped is None
    assert "repair_skipped" not in note_run_stats(plan, execution)


# ---------------------------------------------------------------------------------------------
# Which candidates a plan call may switch to
# ---------------------------------------------------------------------------------------------


def _candidate(model_slug: str, provider: str, model: str, **extra: Any) -> TextFallbackCandidate:
    return TextFallbackCandidate.model_validate(
        {
            "kind": "model-fallback",
            "agent": {"slug": "finalizer"},
            "modelSlug": model_slug,
            "provider": provider,
            "model": model,
            **extra,
        }
    )


PRIMARY = PlanAttempt(provider="lmstudio", model="gemma-4-e2b-it-qat")


def test_only_candidates_serving_the_plans_model_are_eligible() -> None:
    chain = [
        _candidate("gpt-4o", "azure", "gpt-4o"),  # another model: the plan was not budgeted for it
        _candidate("gemma-4-e2b", "vllm", "google/gemma-4-e2b", fundingTier="platform"),
        _candidate("gemma-4-e2b", "", "x"),  # no wire provider: could only fail
        _candidate("gemma-4-e2b", "lmstudio", "gemma-4-e2b-it-qat"),  # the primary again
    ]

    attempts = plan_attempts(_plan(), PRIMARY, chain)

    assert attempts == [
        PRIMARY,
        PlanAttempt(provider="vllm", model="google/gemma-4-e2b", funding_tier="platform"),
    ]


def test_azure_candidates_go_on_the_wire_under_the_text_service_name() -> None:
    attempts = plan_attempts(
        _plan(), PRIMARY, [_candidate("gemma-4-e2b", "azure", "gemma-deployment")]
    )
    assert attempts[1].provider == "azure-openai"


# ---------------------------------------------------------------------------------------------
# The walk
# ---------------------------------------------------------------------------------------------


def _request() -> NoteCallRequest:
    return NoteCallRequest(
        call_id="c1", call_index=1, section_keys=("plan",), system=None, user="U", max_tokens=64
    )


FALLBACK = PlanAttempt(provider="vllm", model="google/gemma-4-e2b", funding_tier="platform")


async def test_a_failed_primary_switches_to_the_next_candidate_and_reports_the_lost_leg() -> None:
    tried: list[tuple[str, int]] = []

    async def call(request: NoteCallRequest, attempt: PlanAttempt, index: int) -> NoteCallResult:
        tried.append((attempt.provider, index))
        if index == 0:
            raise TextServiceError("primary down")
        return NoteCallResult(content="ok", provider=attempt.provider)

    announced: list[int] = []

    async def on_attempt(attempt: PlanAttempt, index: int) -> None:
        announced.append(index)

    generate = walk_attempts(
        [PRIMARY, FALLBACK], call, allows_another=lambda: True, on_attempt=on_attempt
    )
    result = await generate(_request())

    assert tried == [("lmstudio", 0), ("vllm", 1)]
    assert announced == [0, 1]
    assert result.content == "ok"
    [leg] = result.failed_legs
    assert (leg.attempt, leg.index) == (PRIMARY, 0)
    assert isinstance(leg.error, TextServiceError)


async def test_no_switch_is_started_when_the_budget_cannot_fit_it() -> None:
    async def call(request: NoteCallRequest, attempt: PlanAttempt, index: int) -> NoteCallResult:
        raise TextServiceError("down")

    generate = walk_attempts([PRIMARY, FALLBACK], call, allows_another=lambda: False)
    plan = _plan()

    with pytest.raises(NotePlanCallFailed) as excinfo:
        await execute_plan(plan, system=None, user_prefix="P", generate=generate)

    [record] = excinfo.value.records
    assert isinstance(record.error, TextServiceError)
    assert record.attempt == PRIMARY
    assert record.failed_legs == ()


async def test_a_call_every_candidate_lost_carries_the_last_error_and_the_earlier_legs() -> None:
    async def call(request: NoteCallRequest, attempt: PlanAttempt, index: int) -> NoteCallResult:
        raise TextServiceError(f"{attempt.provider} down")

    generate = walk_attempts([PRIMARY, FALLBACK], call, allows_another=lambda: True)

    with pytest.raises(NotePlanCallFailed) as excinfo:
        await execute_plan(_plan(), system=None, user_prefix="P", generate=generate)

    [record] = excinfo.value.records
    assert str(record.error) == "vllm down"
    assert record.attempt == FALLBACK
    assert [(leg.attempt, leg.index) for leg in record.failed_legs] == [(PRIMARY, 0)]


async def test_a_non_text_error_is_not_switched_on() -> None:
    calls = 0

    async def call(request: NoteCallRequest, attempt: PlanAttempt, index: int) -> NoteCallResult:
        nonlocal calls
        calls += 1
        raise RuntimeError("bug")

    generate = walk_attempts([PRIMARY, FALLBACK], call, allows_another=lambda: True)
    with pytest.raises(NotePlanCallFailed):
        await execute_plan(_plan(), system=None, user_prefix="P", generate=generate)
    assert calls == 1


# ---------------------------------------------------------------------------------------------
# The harness-doc activity walks the same-model chain
# ---------------------------------------------------------------------------------------------


class _CapTraj:
    def __init__(self) -> None:
        self.steps: list[Any] = []

    async def report_trajectory(self, steps, *, idempotency_key: str | None = None):
        self.steps.extend(steps)

        class _R:
            accepted = len(steps)

        return _R()


class _Api:
    def __init__(self, plan: dict[str, Any]) -> None:
        self.plan = plan

    async def get_note_plan(self, consultation_id: str, plan_id: str, *, tenant_id: str):
        from harness.services.api_client import NotePlanEnvelope

        return NotePlanEnvelope.from_wire(self.plan)


class _Text:
    def __init__(self, *, down: set[str]) -> None:
        self.down = down
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> TextGenerationResult:
        self.calls.append(kwargs)
        if kwargs["provider"] in self.down:
            raise TextServiceError(f"{kwargs['provider']} down")
        return TextGenerationResult(
            content=COMPLETE,
            model=kwargs["model"],
            provider=kwargs["provider"],
            usage={"prompt_tokens": 100, "completion_tokens": 20},
            stats={"provider": kwargs["provider"], "model": kwargs["model"]},
        )


def _wire(monkeypatch, *, raw: dict[str, Any], text: _Text, cap: _CapTraj) -> None:
    monkeypatch.setattr(activities, "get_settings", lambda: Settings())
    monkeypatch.setattr(activities, "_api_client", lambda s: _Api(raw))
    monkeypatch.setattr(activities, "_text_client", lambda s: text)
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda s: cap)


def _env() -> ActivityEnvironment:
    env = ActivityEnvironment()
    env.info = dataclasses.replace(env.info, start_to_close_timeout=timedelta(seconds=900))
    return env


def _input(raw: dict[str, Any], text_fallback: dict[str, Any] | None) -> ExecuteNotePlanInput:
    return ExecuteNotePlanInput(
        tenant_id=raw["tenantId"],
        note_plan_ref=NotePlanRef(
            consultation_id=raw["consultationId"], plan_id=raw["planId"], mode=raw["mode"]
        ),
        text_fallback=text_fallback,
        trajectory=TrajectoryContext(
            tenant_id=raw["tenantId"], consultation_id=raw["consultationId"], seq=16
        ),
    )


CHAIN = {
    "autoSwitch": True,
    "chain": [
        {
            "kind": "model-fallback",
            "agent": {"slug": "finalizer"},
            "modelSlug": "gpt-4o",
            "provider": "openai",
            "model": "gpt-4o",
        },
        {
            "kind": "platform-default",
            "agent": {"slug": "finalizer"},
            "modelSlug": "gemma-4-e2b",
            "provider": "vllm",
            "model": "google/gemma-4-e2b",
            "fundingTier": "platform",
        },
    ],
}


async def test_the_activity_switches_a_lost_call_to_the_same_model_on_another_provider(
    monkeypatch,
) -> None:
    raw = _raw()
    text, cap = _Text(down={"lmstudio"}), _CapTraj()
    _wire(monkeypatch, raw=raw, text=text, cap=cap)

    result = await _env().run(activities.execute_note_plan, _input(raw, CHAIN))

    # The other-model candidate is never tried.
    assert [(c["provider"], c["model"]) for c in text.calls] == [
        ("lmstudio", "gemma-4-e2b-it-qat"),
        ("vllm", "google/gemma-4-e2b"),
    ]
    keys = [c["idempotency_key"] for c in text.calls]
    assert len(set(keys)) == 2 and keys[1].endswith("note-plan:c1:fallback:1")
    assert result.generation.provider == "vllm"
    steps = sorted(cap.steps, key=lambda s: s.seq)
    assert [(s.seq, s.status, s.stats["activity_kind"]) for s in steps] == [
        (17, "OK", "NOTE_SECTION_GROUP"),
        (16 + FAILED_STEP_OFFSET_BASE, "ERROR", "NOTE_SECTION_GROUP"),
    ]
    assert steps[0].stats["provider"] == "vllm"
    assert steps[1].stats["provider"] == "lmstudio"


async def test_without_a_chain_a_lost_call_still_fails_the_activity(monkeypatch) -> None:
    raw = _raw()
    text, cap = _Text(down={"lmstudio"}), _CapTraj()
    _wire(monkeypatch, raw=raw, text=text, cap=cap)

    with pytest.raises(ApplicationError):
        await _env().run(activities.execute_note_plan, _input(raw, None))
    assert len(text.calls) == 1
