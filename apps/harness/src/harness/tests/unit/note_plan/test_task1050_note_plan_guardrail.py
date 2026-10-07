"""TASK-1050 W2f — the note plan and the guardrail (TASK-1049 §13 F4, F9; README §9.8.1).

* F4 — the REPAIR call carries the plan calls' ``systemGovernance`` like every plan call does: it
  sends the same system prompt, and without the claim apps/text re-screened ~22k chars of governed
  instruction as untrusted on every repair.
* F9 — with ``prime_shared_prefix`` the first call runs ALONE and the rest fan out after it: every
  call shares one byte-identical block prefix, so the lead call's inbound screen fills guardrail's
  window cache and the others hit it instead of screening the same windows N times in flight.
  A lead call guardrail REFUSED is not fanned out at all (the same data would be refused N times).
* A guardrail refusal is never walked past to another candidate of the call.
* The interpreter's note-plan finalizer turns a refused plan call into a ``guardrail_hold``.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from harness.services.note_plan.executor import (
    NoteCallRequest,
    NoteCallResult,
    NotePlanCallFailed,
    execute_plan,
    render_user_prefix,
)
from harness.services.note_plan.fallback import PlanAttempt, walk_attempts
from harness.services.note_plan.models import NotePlanV1
from harness.services.text_client import (
    TextGenerationResult,
    TextGuardrailBlocked,
    TextServiceError,
)
from harness.tests.unit.note_plan.test_executor_task1045 import (
    _GOV_CONSULTATION,
    _GOV_TENANT,
    GROUPS,
    SINGLE,
    _answer,
    _call_keys,
    _CapTraj,
    _env,
    _raw,
    activities,
)
from harness.tests.unit.note_plan.test_finalizer_plan_from_handoff_task1045 import _GovApi, _input

_GOV = {
    "composed_digest": "dc",
    "pieces": [{"kind": "PLATFORM", "key": "platform-rules@1", "digest": "d1"}],
    "policy_version": "pv1",
}
_GAPPY = (
    "## Subjective\nChest tightness.\n\n## Objective\nTroponin 12 ng/L.\n\n"
    "## Assessment\nStable.\n\n## Plan\nIncrease metformin to 1000 mg [S5]."
)
_BLOCK_NOTICE: dict[str, Any] = {
    "schemaVersion": 1,
    "noticeId": "01927f6e-9999-7000-8000-0000000000ab",
    "type": "guardrail.blocked",
    "direction": "inbound",
    "action": "block",
    "checks": [{"checkId": "injection_judge", "severity": "high"}],
    "itemIds": [],
    "messageKey": "guardrail.blocked.inbound",
    "defaultMessage": "A safety check stopped this request. Review the flagged input to continue.",
    "requiresAcknowledgement": True,
    "resumable": True,
    "policyVersion": "pv-1",
    "occurredAt": "2026-10-07T09:15:00.000Z",
}


def _blocked() -> TextGuardrailBlocked:
    return TextGuardrailBlocked(
        kind="blocked",
        status_code=422,
        notice=_BLOCK_NOTICE,
        evaluation_ids=["ev-1"],
        error_code="CONTENT_BLOCKED",
    )


class TestF4RepairGovernance:
    @pytest.mark.asyncio
    async def test_the_repair_call_carries_the_plan_calls_governance(self) -> None:
        raw = _raw(SINGLE)
        raw["calls"][0]["systemGovernance"] = _GOV
        plan = NotePlanV1.model_validate(raw)
        seen: list[NoteCallRequest] = []

        async def generate(request: NoteCallRequest) -> NoteCallResult:
            seen.append(request)
            if request.kind == "repair":
                return NoteCallResult(content="## Plan\nIncrease metformin; review in 4 weeks.")
            return NoteCallResult(content=_GAPPY)

        await execute_plan(
            plan, system="SYS", user_prefix=render_user_prefix(plan), generate=generate
        )
        (repair,) = [r for r in seen if r.kind == "repair"]
        assert repair.system_governance == _GOV

    @pytest.mark.asyncio
    async def test_no_plan_call_governed_means_no_claim_on_the_repair(self) -> None:
        plan = NotePlanV1.model_validate(_raw(SINGLE))
        seen: list[NoteCallRequest] = []

        async def generate(request: NoteCallRequest) -> NoteCallResult:
            seen.append(request)
            if request.kind == "repair":
                return NoteCallResult(content="## Plan\nIncrease metformin; review in 4 weeks.")
            return NoteCallResult(content=_GAPPY)

        await execute_plan(
            plan, system="SYS", user_prefix=render_user_prefix(plan), generate=generate
        )
        (repair,) = [r for r in seen if r.kind == "repair"]
        assert repair.system_governance is None


class TestF9SharedPrefixPriming:
    @pytest.mark.asyncio
    async def test_the_lead_call_finishes_before_the_rest_fan_out(self) -> None:
        plan = NotePlanV1.model_validate(_raw(GROUPS))
        log: list[str] = []

        async def generate(request: NoteCallRequest) -> NoteCallResult:
            log.append(f"start:{request.call_index}")
            await asyncio.sleep(0)
            log.append(f"end:{request.call_index}")
            return NoteCallResult(content=_answer(_call_keys(request)))

        await execute_plan(
            plan,
            system=None,
            user_prefix=render_user_prefix(plan),
            generate=generate,
            prime_shared_prefix=True,
        )
        assert log[:2] == ["start:1", "end:1"]
        assert sorted(log[2:]) == ["end:2", "start:2"]

    @pytest.mark.asyncio
    async def test_a_refused_lead_call_is_not_fanned_out(self) -> None:
        plan = NotePlanV1.model_validate(_raw(GROUPS))
        calls: list[int | None] = []

        async def generate(request: NoteCallRequest) -> NoteCallResult:
            calls.append(request.call_index)
            raise _blocked()

        with pytest.raises(NotePlanCallFailed) as caught:
            await execute_plan(
                plan,
                system=None,
                user_prefix=render_user_prefix(plan),
                generate=generate,
                prime_shared_prefix=True,
            )
        assert calls == [1]
        assert [r.call_id for r in caught.value.records] == [plan.calls[0].call_id]
        assert isinstance(caught.value.records[0].error, TextGuardrailBlocked)

    @pytest.mark.asyncio
    async def test_without_priming_the_calls_still_run_together(self) -> None:
        plan = NotePlanV1.model_validate(_raw(GROUPS))
        both = asyncio.Event()
        started = 0

        async def generate(request: NoteCallRequest) -> NoteCallResult:
            nonlocal started
            started += 1
            if started == 2:
                both.set()
            await asyncio.wait_for(both.wait(), timeout=2)
            return NoteCallResult(content=_answer(_call_keys(request)))

        await execute_plan(
            plan, system=None, user_prefix=render_user_prefix(plan), generate=generate
        )


class TestFallbackWalk:
    @pytest.mark.asyncio
    async def test_a_guardrail_refusal_is_never_walked_past(self) -> None:
        tried: list[int] = []

        async def call(request: Any, attempt: PlanAttempt, index: int) -> NoteCallResult:
            tried.append(index)
            raise _blocked()

        generate = walk_attempts(
            [PlanAttempt(provider="a", model="m"), PlanAttempt(provider="b", model="m")],
            call,
            allows_another=lambda: True,
        )
        with pytest.raises(TextGuardrailBlocked):
            await generate(object())  # type: ignore[arg-type]
        assert tried == [0]

    @pytest.mark.asyncio
    async def test_an_outage_still_walks_to_the_next_candidate(self) -> None:
        tried: list[int] = []

        async def call(request: Any, attempt: PlanAttempt, index: int) -> NoteCallResult:
            tried.append(index)
            if index == 0:
                raise TextServiceError("down")
            return NoteCallResult(content="ok")

        generate = walk_attempts(
            [PlanAttempt(provider="a", model="m"), PlanAttempt(provider="b", model="m")],
            call,
            allows_another=lambda: True,
        )
        await generate(object())  # type: ignore[arg-type]
        assert tried == [0, 1]


class _RefusingText:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def generate(self, **kwargs: Any) -> TextGenerationResult:
        self.calls.append(kwargs)
        raise _blocked()


@pytest.mark.asyncio
async def test_the_note_plan_finalizer_turns_a_refused_call_into_a_hold(monkeypatch) -> None:
    from harness.temporal.interpreter.nodes import core

    raw = _raw(GROUPS)
    raw["tenantId"] = _GOV_TENANT
    raw["consultationId"] = _GOV_CONSULTATION
    api, text = _GovApi(raw), _RefusingText()
    monkeypatch.setattr(core, "_api_client", lambda _s: api)
    monkeypatch.setattr(core, "_text_client", lambda _s: text)
    monkeypatch.setattr(activities, "_trajectory_api_client", lambda _s: _CapTraj())

    ref = {"consultationId": _GOV_CONSULTATION, "mode": "final", "planId": raw["planId"]}
    seeded = {"text": "", "note_plan_ref": ref}
    result = await _env().run(
        core.interpreter_core_agent,
        _input(bound={"in": ""}, nodes={"n_summary_new": seeded, "n_summary_revisit": seeded}),
    )
    assert result.status == "DEGRADED"
    assert result.reason.startswith("GUARDRAIL_BLOCKED")
    assert result.guardrail_hold is not None
    assert result.guardrail_hold.notice["noticeId"] == _BLOCK_NOTICE["noticeId"]
    assert result.guardrail_hold.evaluation_ids == ["ev-1"]
    # Primed: the lead call was refused, so the second group never ran.
    assert len(text.calls) == 1
    # Each plan call is correlated to the run, the node and the consultation.
    assert text.calls[0]["correlation"]["runId"] == "run-1"
    assert text.calls[0]["correlation"]["consultationId"] == _GOV_CONSULTATION
    # A hold is resumable: the consultation is not told its note failed.
    assert not [p for p in api.progress if p.get("stage") == core._PROGRESS_FAILED_STAGE]


@pytest.mark.asyncio
async def test_the_doc_workflow_note_plan_fails_a_refused_call_by_name_and_does_not_retry(
    monkeypatch,
) -> None:
    """The legacy ``HarnessDocWorkflow`` path has no hold: a refused plan call fails the activity
    NON-retryably (a retry would be screened and refused again), after one primed call."""
    from temporalio.exceptions import ApplicationError

    from harness.tests.unit.note_plan.test_executor_task1045 import _Api, _wire
    from harness.tests.unit.note_plan.test_executor_task1045 import _input as _doc_input

    raw = _raw(GROUPS)
    text = _RefusingText()
    _wire(monkeypatch, api=_Api(raw), text=text, cap=_CapTraj())  # type: ignore[arg-type]
    with pytest.raises(ApplicationError) as caught:
        await _env().run(activities.execute_note_plan, _doc_input(raw))
    assert caught.value.type == "GuardrailBlocked"
    assert caught.value.non_retryable is True
    assert len(text.calls) == 1


def test_a_plan_calls_billed_stats_carry_its_evaluation_ids() -> None:
    stats = activities.note_call_llm_stats(
        TextGenerationResult(content="x", guardrail_evaluation_ids=["ev-1"])
    )
    assert stats["guardrail_evaluation_ids"] == ["ev-1"]
    assert "guardrail_evaluation_ids" not in activities.note_call_llm_stats(
        TextGenerationResult(content="x")
    )
