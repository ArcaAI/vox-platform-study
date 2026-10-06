"""TASK-1047 L10 — the gateway note plan's per-call ``systemGovernance`` reaches apps/text.

Hermetic: the plan is the pinned fixture with one governed call, Text and the gateway are stubs.
"""

from __future__ import annotations

from typing import Any

from harness.services.note_plan.executor import (
    NoteCallRequest,
    NoteCallResult,
    execute_plan,
    render_user_prefix,
)
from harness.services.note_plan.models import NotePlanV1
from harness.temporal import activities
from harness.tests.unit.note_plan.test_executor_task1045 import (
    GROUPS,
    _answer,
    _Api,
    _call_keys,
    _CapTraj,
    _env,
    _input,
    _raw,
    _Text,
    _wire,
)

_GOV = {
    "composed_digest": "dc",
    "pieces": [{"kind": "PLATFORM", "key": "platform-rules@1", "digest": "d1"}],
    "policy_version": "pv1",
}


def _plan_with_governance(*, first: Any) -> tuple[dict[str, Any], NotePlanV1]:
    raw = _raw(GROUPS)
    if first is not ...:
        raw["calls"][0]["systemGovernance"] = first
    return raw, NotePlanV1.model_validate(raw)


async def test_the_executor_carries_each_calls_governance_and_none_when_absent() -> None:
    _, plan = _plan_with_governance(first=_GOV)
    seen: dict[str, NoteCallRequest] = {}

    async def generate(request: NoteCallRequest) -> NoteCallResult:
        seen[request.call_id] = request
        return NoteCallResult(content=_answer(_call_keys(request)), stats={})

    await execute_plan(plan, system="SYS", user_prefix=render_user_prefix(plan), generate=generate)

    assert seen[plan.calls[0].call_id].system_governance == _GOV
    assert seen[plan.calls[1].call_id].system_governance is None


async def test_an_explicit_null_is_omitted() -> None:
    _, plan = _plan_with_governance(first=None)
    assert plan.calls[0].system_governance is None


async def test_the_activity_forwards_it_verbatim_as_system_governance(monkeypatch) -> None:
    raw, plan = _plan_with_governance(first=_GOV)
    text = _Text(
        script={
            plan.calls[0].directive: [_answer(["subjective", "objective"])],
            plan.calls[1].directive: [_answer(["assessment", "plan"])],
        }
    )
    _wire(monkeypatch, api=_Api(raw), text=text, cap=_CapTraj())

    await _env().run(activities.execute_note_plan, _input(raw))

    by_directive = {c["prompt"].rsplit("\n\n", 1)[-1]: c for c in text.calls}
    assert by_directive[plan.calls[0].directive]["system_governance"] == _GOV
    assert by_directive[plan.calls[1].directive].get("system_governance") is None
