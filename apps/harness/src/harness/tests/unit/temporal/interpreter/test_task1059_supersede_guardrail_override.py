"""TASK-1059 lane O (TASK-1058 RC-8 / E1-6) — a SUPERSEDING run carries the guardrail override.

A clinician resumed a guardrail hold ``acknowledged``, but the run was no longer paused (the signal
answered 409), so the gateway superseded the governing run instead. The fresh run must send
``X-Hope-Guardrail-Override`` for that notice, exactly as the paused node's re-run would have —
otherwise text blocks the same finding again. The gateway passes it on the run input
(``guardrail_override_notice_ids``); the walk stamps it on the node activity input
(``guardrail_override``), which ``nodes/core.py`` already sends as the header. Guardrail verifies
the notice and downgrades only THAT notice's finding.

Hermetic, like ``test_task1050_guardrail_hold_workflow``: the REAL ``WorkflowInterpreter`` methods
run against its fake ``workflow`` namespace.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from temporalio.common import RetryPolicy

from harness.temporal.interpreter import guardrail_hold
from harness.temporal.interpreter import workflow as wf
from harness.temporal.interpreter.models import InterpreterInput, NodeActivityResult
from harness.tests.unit.temporal.interpreter.test_task1050_guardrail_hold_workflow import (
    _NOTICE_ID,
    _OK,
    FakeWorkflow,
    _activity_input,
    _held,
    _inp,
    _node,
    _resolve,
)

_ACKED = "01927f6e-1111-7000-8000-0000000000cd"


def _inp_with(ids: list[str] | None) -> InterpreterInput:
    base = _inp().model_dump()
    return InterpreterInput.model_validate({**base, "guardrail_override_notice_ids": ids})


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch):
    def _make(fake: FakeWorkflow) -> wf.WorkflowInterpreter:
        monkeypatch.setattr(wf, "workflow", fake)
        interpreter = wf.WorkflowInterpreter()
        interpreter._run_id = "run-1"
        interpreter._v2 = True
        interpreter._seq = 32
        return interpreter

    return _make


class TestTheRunInput:
    def test_an_input_recorded_before_the_field_still_validates_with_none(self) -> None:
        assert _inp().guardrail_override_notice_ids is None

    def test_the_field_round_trips(self) -> None:
        assert _inp_with([_ACKED]).guardrail_override_notice_ids == [_ACKED]


class TestThePureRule:
    def test_no_ids_no_override(self) -> None:
        assert guardrail_hold.supersede_override(None) is None
        assert guardrail_hold.supersede_override([]) is None
        assert guardrail_hold.supersede_override([""]) is None

    def test_the_acknowledged_notice_is_the_override(self) -> None:
        assert guardrail_hold.supersede_override([_ACKED]) == _ACKED


class TestTheNodeCall:
    @pytest.mark.asyncio
    async def test_the_node_call_carries_the_override_when_the_run_input_names_one(
        self, harness
    ) -> None:
        fake = FakeWorkflow(results=[_OK])
        interpreter = harness(fake)
        result = await interpreter._dispatch_node_inner(_node(), _inp_with([_ACKED]), 0)
        assert result.status == "SUCCEEDED"
        (call,) = fake.node_inputs
        assert call.guardrail_override == _ACKED

    @pytest.mark.asyncio
    async def test_without_override_ids_the_node_call_sends_none(self, harness) -> None:
        fake = FakeWorkflow(results=[_OK])
        interpreter = harness(fake)
        await interpreter._dispatch_node_inner(_node(), _inp(), 0)
        (call,) = fake.node_inputs
        assert call.guardrail_override is None


class TestAHoldOnTheSupersedingRun:
    @pytest.mark.asyncio
    async def test_an_item_resolution_re_run_keeps_the_superseding_override(self, harness) -> None:
        # A DIFFERENT finding held the superseding run and was resolved `item_excluded`: the
        # re-run sends no override of its own, so it keeps the acknowledged one it started with —
        # otherwise the already-acknowledged finding would block (and hold) again.
        fake = FakeWorkflow(results=[_OK])
        interpreter = harness(fake)
        fake.on_wait = _resolve(interpreter, "item_excluded")
        started = _activity_input().model_copy(update={"guardrail_override": _ACKED})
        settled = await interpreter._settle_guardrail_hold(
            _node(),
            _inp_with([_ACKED]),
            wf.NODE_REGISTRY["core.agent"],
            started,
            _held(),
            timedelta(seconds=60),
            RetryPolicy(maximum_attempts=1),
        )
        assert settled == _OK
        assert fake.node_inputs[0].guardrail_override == _ACKED

    @pytest.mark.asyncio
    async def test_an_acknowledged_re_run_sends_the_held_notice(self, harness) -> None:
        fake = FakeWorkflow(results=[_OK])
        interpreter = harness(fake)
        fake.on_wait = _resolve(interpreter, "acknowledged")
        started = _activity_input().model_copy(update={"guardrail_override": _ACKED})
        settled: Any = await interpreter._settle_guardrail_hold(
            _node(),
            _inp_with([_ACKED]),
            wf.NODE_REGISTRY["core.agent"],
            started,
            _held(),
            timedelta(seconds=60),
            RetryPolicy(maximum_attempts=1),
        )
        assert isinstance(settled, NodeActivityResult)
        assert fake.node_inputs[0].guardrail_override == _NOTICE_ID
