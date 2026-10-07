"""TASK-1050 W2f — the node-level guardrail HOLD in the interpreter walk (README §9.8.1).

When a node's generation is refused by guardrail (the activity reports a ``guardrail_hold``), the
walk — behind ``workflow.patched("task-1050-guardrail-hold")`` — publishes ``guardrail.notice`` and
``run.paused``, waits durably on the ``guardrail_resolution`` signal (bounded by the hold timeout),
and re-executes ONLY that node: with ``X-Hope-Guardrail-Override`` for an ``acknowledged`` block,
without it for ``item_excluded`` / ``item_edited`` and for every privacy hold. On timeout the node
and the run fail ``GUARDRAIL_BLOCKED``.

HOW THIS IS TESTED (stated, per the lane brief): the time-skipping Temporal environment starts a
separate test-server process, so it is NOT used here. The REAL ``WorkflowInterpreter`` methods run
against a fake ``workflow`` namespace (``patched`` / ``now`` / ``info`` / ``wait_condition`` /
``execute_activity``), which drives exactly the calls the walk makes — the decision logic and the
command shape. The same path inside real Temporal is exercised by the replay-fixture capture
(``_capture_task1050_guardrail_hold_fixtures.py``) and its replay (``test_task1050_guardrail_hold_replay``).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from temporalio.common import RetryPolicy

from harness.temporal.interpreter import workflow as wf
from harness.temporal.interpreter.compiled_config import CompiledNode
from harness.temporal.interpreter.models import (
    GuardrailHold,
    GuardrailResolutionSignal,
    InterpreterInput,
    NodeActivityInput,
    NodeActivityResult,
    NodeResult,
    RunLimits,
)
from harness.temporal.interpreter.run_events import (
    EVENT_GUARDRAIL_NOTICE,
    EVENT_NODE_STARTED,
    EVENT_RUN_PAUSED,
)
from harness.temporal.models import TrajectoryContext
from harness.tests.unit.temporal.interpreter.test_core_interpreter import _node as _compiled_node

_TENANT = "10000000-0000-0000-0000-000000000001"
_NOTICE_ID = "01927f6e-9999-7000-8000-0000000000ab"
_BLOCK: dict[str, Any] = {
    "schemaVersion": 1,
    "noticeId": _NOTICE_ID,
    "type": "guardrail.blocked",
    "direction": "inbound",
    "action": "block",
    "checks": [{"checkId": "injection_judge", "severity": "high"}],
    "runId": "run-1",
    "nodeId": "n_note",
    "itemIds": [],
    "messageKey": "guardrail.blocked.inbound",
    "defaultMessage": "A safety check stopped this request. Review the flagged input to continue.",
    "requiresAcknowledgement": True,
    "resumable": True,
    "policyVersion": "pv-1",
    "occurredAt": "2026-10-07T09:15:00.000Z",
}


class FakeWorkflow:
    """The `temporalio.workflow` calls the hold makes, recorded; time only moves on a timeout."""

    def __init__(
        self,
        *,
        results: list[NodeActivityResult] | None = None,
        execution_timeout: timedelta | None = None,
    ) -> None:
        self.start = datetime(2026, 10, 7, 9, 0, tzinfo=UTC)
        self.clock = self.start
        self.execution_timeout = execution_timeout
        self.results = list(results or [])
        self.patched_calls: list[str] = []
        self.node_inputs: list[NodeActivityInput] = []
        self.emitted: list[Any] = []
        self.waits: list[timedelta | None] = []
        #: Called when a `wait_condition` would block: the "signal arrives" hook.
        self.on_wait: Callable[[], None] | None = None

    def patched(self, name: str) -> bool:
        self.patched_calls.append(name)
        return True

    def now(self) -> datetime:
        return self.clock

    def info(self) -> Any:
        return SimpleNamespace(
            execution_timeout=self.execution_timeout, workflow_start_time=self.start
        )

    async def wait_condition(self, fn: Callable[[], bool], *, timeout: Any = None) -> None:
        if fn():
            return
        self.waits.append(timeout)
        if self.on_wait is not None:
            self.on_wait()
        if fn():
            return
        if timeout is None:
            raise AssertionError("an unbounded wait would park forever")
        self.clock += timeout if isinstance(timeout, timedelta) else timedelta(seconds=timeout)
        raise TimeoutError

    async def execute_activity(self, fn: Any, arg: Any, **_kwargs: Any) -> Any:
        if fn is wf.emit_run_events:
            self.emitted.extend(arg.events)
            return len(arg.events)
        self.node_inputs.append(arg)
        return self.results.pop(0)


def _node() -> CompiledNode:
    return CompiledNode.model_validate(
        _compiled_node(
            "n_note", "core.agent", "interpreter.core_agent", config={"agentRef": {"slug": "a"}}
        )
    )


def _inp(limits: RunLimits | None = None) -> InterpreterInput:
    return InterpreterInput.model_validate(
        {
            "session_id": "s-1",
            "workflow_version_id": "v-1",
            "config_ref": {
                "store": "memory",
                "bucket": "b",
                "key": "k",
                "size": 1,
                "sha256": "0" * 64,
                "content_type": "application/json",
            },
            "tenant_id": _TENANT,
            "run_id": "run-1",
            "limits": limits.model_dump(by_alias=True) if limits is not None else None,
        }
    )


def _activity_input() -> NodeActivityInput:
    return NodeActivityInput(
        node_id="n_note",
        node_type="core.agent",
        config={"agentRef": {"slug": "a"}},
        tenant_id=_TENANT,
        run_id="run-1",
        protocol=2,
        trajectory=TrajectoryContext(tenant_id=_TENANT, seq=16),
    )


def _held(kind: str = "blocked", notice: dict[str, Any] | None = None) -> NodeActivityResult:
    return NodeActivityResult(
        status="DEGRADED",
        reason="GUARDRAIL_BLOCKED: core.agent: guardrail_blocked",
        guardrail_hold=GuardrailHold(kind=kind, notice=notice or _BLOCK, evaluation_ids=["ev-1"]),
    )


_OK = NodeActivityResult(status="SUCCEEDED", output={"text": "the note"})


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


async def _hold(
    interpreter: wf.WorkflowInterpreter,
    result: NodeActivityResult,
    *,
    inp: InterpreterInput | None = None,
) -> NodeActivityResult | NodeResult:
    return await interpreter._settle_guardrail_hold(
        _node(),
        inp or _inp(),
        wf.NODE_REGISTRY["core.agent"],
        _activity_input(),
        result,
        timedelta(seconds=60),
        RetryPolicy(maximum_attempts=1),
    )


def _resolve(interpreter: wf.WorkflowInterpreter, resolution: str) -> Callable[[], None]:
    seen: dict[str, Any] = {}

    def _deliver() -> None:
        seen["holds"] = [h.model_dump(by_alias=True) for h in interpreter.guardrail_holds()]
        interpreter.guardrail_resolution(
            GuardrailResolutionSignal(noticeId=_NOTICE_ID, resolution=resolution, by="doctor-1")
        )

    _deliver.seen = seen  # type: ignore[attr-defined]
    return _deliver


class TestResume:
    @pytest.mark.asyncio
    async def test_acknowledged_re_runs_only_the_node_with_the_override(self, harness) -> None:
        fake = FakeWorkflow(results=[_OK])
        interpreter = harness(fake)
        fake.on_wait = deliver = _resolve(interpreter, "acknowledged")

        settled = await _hold(interpreter, _held())

        assert settled == _OK
        assert wf._GUARDRAIL_HOLD_PATCH in fake.patched_calls
        kinds = [(e.event_type, e.node_id) for e in fake.emitted]
        assert kinds == [
            (EVENT_GUARDRAIL_NOTICE, "n_note"),
            (EVENT_RUN_PAUSED, "n_note"),
            (EVENT_NODE_STARTED, "n_note"),
        ]
        assert fake.emitted[0].notice == _BLOCK
        assert fake.emitted[2].attempt == 2
        # While parked, the query names the hold (the resolution route's 409 check reads it).
        assert deliver.seen["holds"] == [  # type: ignore[attr-defined]
            {"noticeId": _NOTICE_ID, "nodeId": "n_note", "kind": "blocked"}
        ]
        (rerun,) = fake.node_inputs
        assert rerun.guardrail_override == _NOTICE_ID
        assert rerun.event_scope == "hold:1"
        assert rerun.trajectory is not None and rerun.trajectory.seq == 32
        assert interpreter.guardrail_holds() == []

    @pytest.mark.asyncio
    @pytest.mark.parametrize("resolution", ["item_excluded", "item_edited"])
    async def test_an_item_resolution_re_runs_without_an_override(
        self, harness, resolution: str
    ) -> None:
        fake = FakeWorkflow(results=[_OK])
        interpreter = harness(fake)
        fake.on_wait = _resolve(interpreter, resolution)
        assert await _hold(interpreter, _held()) == _OK
        assert fake.node_inputs[0].guardrail_override is None

    @pytest.mark.asyncio
    async def test_a_privacy_hold_is_never_overridden(self, harness) -> None:
        notice = {
            **_BLOCK,
            "checks": [],
            "messageKey": "guardrail.blocked.redaction_unavailable",
            "defaultMessage": (
                "Patient details could not be protected before sending to an external model, "
                "so processing is paused. Retry to continue."
            ),
        }
        fake = FakeWorkflow(results=[_OK])
        interpreter = harness(fake)
        fake.on_wait = _resolve(interpreter, "acknowledged")
        assert await _hold(interpreter, _held("redaction_unavailable", notice)) == _OK
        assert fake.node_inputs[0].guardrail_override is None

    @pytest.mark.asyncio
    async def test_a_re_run_refused_again_holds_again_then_settles(self, harness) -> None:
        fake = FakeWorkflow(results=[_held(), _OK])
        interpreter = harness(fake)
        fake.on_wait = _resolve(interpreter, "item_edited")
        assert await _hold(interpreter, _held()) == _OK
        assert [i.event_scope for i in fake.node_inputs] == ["hold:1", "hold:2"]
        started = [e.attempt for e in fake.emitted if e.event_type == EVENT_NODE_STARTED]
        assert started == [2, 3]


class TestNoDeadEndsButBounded:
    @pytest.mark.asyncio
    async def test_a_hold_nobody_resolves_fails_guardrail_blocked(self, harness) -> None:
        fake = FakeWorkflow()
        interpreter = harness(fake)
        settled = await _hold(
            interpreter,
            _held(),
            inp=_inp(RunLimits(activityInputMaxBytes=1, guardrailHoldTimeoutSeconds=90)),
        )
        assert isinstance(settled, NodeResult)
        assert settled.status == "FAILED"
        assert settled.reason is not None and settled.reason.startswith("GUARDRAIL_BLOCKED")
        assert interpreter._run_failure_reason == "GUARDRAIL_BLOCKED"
        assert fake.waits == [timedelta(seconds=90)]
        assert fake.node_inputs == []
        assert interpreter.guardrail_holds() == []

    @pytest.mark.asyncio
    async def test_the_hold_never_outlives_the_execution_backstop(self, harness) -> None:
        fake = FakeWorkflow(execution_timeout=timedelta(seconds=1000))
        fake.clock = fake.start + timedelta(seconds=100)
        interpreter = harness(fake)
        await _hold(interpreter, _held())
        grace = wf.caps.RUN_TIMEOUT_GRACE_SECONDS
        assert fake.waits == [timedelta(seconds=1000 - 100 - grace)]

    @pytest.mark.asyncio
    async def test_without_any_bound_the_platform_ceiling_applies(self, harness) -> None:
        fake = FakeWorkflow()
        interpreter = harness(fake)
        await _hold(interpreter, _held())
        assert fake.waits == [timedelta(seconds=wf.caps.GUARDRAIL_HOLD_MAX_WAIT_SECONDS)]

    @pytest.mark.asyncio
    async def test_a_non_resumable_notice_fails_at_once_without_pausing(self, harness) -> None:
        fake = FakeWorkflow()
        interpreter = harness(fake)
        settled = await _hold(interpreter, _held(notice={**_BLOCK, "resumable": False}))
        assert isinstance(settled, NodeResult) and settled.status == "FAILED"
        assert [e.event_type for e in fake.emitted] == [EVENT_GUARDRAIL_NOTICE]
        assert fake.waits == []

    @pytest.mark.asyncio
    async def test_the_rounds_are_capped(self, harness) -> None:
        rounds = wf.caps.MAX_GUARDRAIL_HOLD_ROUNDS
        fake = FakeWorkflow(results=[_held() for _ in range(rounds)])
        interpreter = harness(fake)
        fake.on_wait = _resolve(interpreter, "acknowledged")
        settled = await _hold(interpreter, _held())
        assert isinstance(settled, NodeResult) and settled.status == "FAILED"
        assert len(fake.node_inputs) == rounds

    @pytest.mark.asyncio
    async def test_a_cancel_during_the_hold_interrupts_the_node(self, harness) -> None:
        fake = FakeWorkflow()
        interpreter = harness(fake)

        def _cancel() -> None:
            interpreter._cancelled = True

        fake.on_wait = _cancel
        settled = await _hold(interpreter, _held())
        assert isinstance(settled, NodeResult)
        assert (settled.status, settled.reason) == ("SKIPPED", "cancelled")

    @pytest.mark.asyncio
    async def test_the_budget_clock_is_paused_across_the_hold(self, harness) -> None:
        fake = FakeWorkflow()
        interpreter = harness(fake)
        interpreter._budget_seconds = 300.0
        interpreter._clock_started = fake.start
        await _hold(
            interpreter,
            _held(),
            inp=_inp(RunLimits(activityInputMaxBytes=1, guardrailHoldTimeoutSeconds=600)),
        )
        assert interpreter._pause_depth == 0
        assert interpreter._paused_seconds == 600.0
        assert interpreter._remaining_budget() == 300.0


class TestSignal:
    def test_a_resolution_for_a_hold_that_is_not_pending_is_ignored(self, harness) -> None:
        interpreter = harness(FakeWorkflow())
        interpreter.guardrail_resolution(
            GuardrailResolutionSignal(noticeId=_NOTICE_ID, resolution="acknowledged", by="d")
        )
        assert interpreter._hold_resolutions == {}


class TestReplayGate:
    @pytest.mark.asyncio
    async def test_a_result_without_a_hold_never_consults_the_marker(self, harness) -> None:
        fake = FakeWorkflow()
        interpreter = harness(fake)
        assert await _hold(interpreter, _OK) == _OK
        assert fake.patched_calls == []

    @pytest.mark.asyncio
    async def test_a_run_not_on_protocol_v2_keeps_the_degrade(self, harness) -> None:
        fake = FakeWorkflow()
        interpreter = harness(fake)
        interpreter._v2 = False
        held = _held()
        assert await _hold(interpreter, held) == held
        assert fake.patched_calls == []


def test_warn_notices_are_collected_once_for_run_completed(harness) -> None:
    interpreter = harness(FakeWorkflow())
    warn = {**_BLOCK, "noticeId": "n-warn", "type": "guardrail.warning", "action": "warn"}
    result = NodeActivityResult(status="SUCCEEDED", guardrail_notices=[warn])
    interpreter._collect_guardrail_notices(result)
    interpreter._collect_guardrail_notices(result)
    assert interpreter._guardrail_notices == [warn]


def test_the_override_input_is_excluded_from_the_size_measure_while_unset() -> None:
    assert "guardrail_override" in wf._V2_INPUT_FIELDS
