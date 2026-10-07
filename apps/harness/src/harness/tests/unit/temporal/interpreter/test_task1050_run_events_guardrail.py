"""TASK-1050 W2f — the walk's guardrail facts become run-protocol v2 events (``emit_run_events``).

* ``workflow.guardrail.notice`` → public ``guardrail.notice`` (node-scoped when it names a node);
* ``workflow.run.paused`` → public ``run.paused {reason: 'guardrail_hold', noticeId, nodeId}`` with
  NO envelope node (a run-level event);
* a node re-run after a hold announces itself with ``node.started`` ``attempt > 1``;
* ``run.completed`` carries every conforming warn / unverified notice (``guardrailNotices``);
* a hold that timed out fails the node and the run with the fixed code ``GUARDRAIL_BLOCKED``.

Every event is validated by the real sequencer path (``build_run_append``) into a fake Redis.
"""

from __future__ import annotations

from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment

from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.models import RunEventBatch, RunEventSpec
from harness.temporal.interpreter.run_events import (
    EVENT_GUARDRAIL_NOTICE,
    EVENT_NODE_FAILED,
    EVENT_NODE_STARTED,
    EVENT_RUN_COMPLETED,
    EVENT_RUN_PAUSED,
)
from harness.temporal.interpreter.run_protocol import run_event_problems
from harness.tests.unit.temporal.interpreter._run_stream_fake import FakeRunStreamRedis

_RUN = "run-1050-events"
_WARN: dict[str, Any] = {
    "schemaVersion": 1,
    "noticeId": "01927f6e-9999-7000-8000-0000000000aa",
    "type": "guardrail.warning",
    "direction": "inbound",
    "action": "warn",
    "checks": [{"checkId": "unsafe_content_judge", "severity": "medium"}],
    "runId": _RUN,
    "nodeId": "n_note",
    "itemIds": [],
    "messageKey": "guardrail.warning.generic",
    "defaultMessage": "A safety check flagged this content. Review it before you rely on it.",
    "requiresAcknowledgement": True,
    "resumable": False,
    "policyVersion": "pv-1",
    "occurredAt": "2026-10-07T09:15:00.000Z",
}
_BLOCK: dict[str, Any] = {
    **_WARN,
    "noticeId": "01927f6e-9999-7000-8000-0000000000ab",
    "type": "guardrail.blocked",
    "action": "block",
    "messageKey": "guardrail.blocked.inbound",
    "defaultMessage": "A safety check stopped this request. Review the flagged input to continue.",
    "resumable": True,
}


@pytest.fixture
def stream(monkeypatch: pytest.MonkeyPatch) -> FakeRunStreamRedis:
    fake = FakeRunStreamRedis()
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS", fake, raising=False)
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS_BUILT", True, raising=False)
    return fake


async def _emit(*specs: RunEventSpec) -> None:
    await ActivityEnvironment().run(
        interpreter_activities.emit_run_events,
        RunEventBatch(run_id=_RUN, tenant_id="t-1", events=list(specs)),
    )


@pytest.mark.asyncio
async def test_a_hold_publishes_the_notice_then_run_paused(stream) -> None:
    await _emit(
        RunEventSpec(event_type=EVENT_GUARDRAIL_NOTICE, node_id="n_note", notice=_BLOCK),
        RunEventSpec(event_type=EVENT_RUN_PAUSED, node_id="n_note", notice=_BLOCK),
    )
    notice, paused = stream.events(_RUN)
    assert notice["type"] == "guardrail.notice" and notice["nodeId"] == "n_note"
    assert notice["data"] == _BLOCK
    assert paused["type"] == "run.paused" and "nodeId" not in paused
    assert paused["data"] == {
        "reason": "guardrail_hold",
        "noticeId": _BLOCK["noticeId"],
        "nodeId": "n_note",
    }
    for event in (notice, paused):
        assert run_event_problems(event, plane="public") == []


@pytest.mark.asyncio
async def test_a_retried_emit_writes_the_hold_once(stream) -> None:
    specs = (
        RunEventSpec(event_type=EVENT_GUARDRAIL_NOTICE, node_id="n_note", notice=_BLOCK),
        RunEventSpec(event_type=EVENT_RUN_PAUSED, node_id="n_note", notice=_BLOCK),
    )
    await _emit(*specs)
    await _emit(*specs)
    assert len(stream.events(_RUN)) == 2


@pytest.mark.asyncio
async def test_a_node_re_run_after_a_hold_announces_a_later_attempt(stream) -> None:
    await _emit(
        RunEventSpec(event_type=EVENT_NODE_STARTED, node_id="n_note", node_type="core.agent"),
        RunEventSpec(
            event_type=EVENT_NODE_STARTED, node_id="n_note", node_type="core.agent", attempt=2
        ),
    )
    first, rerun = stream.events(_RUN)
    assert first["data"]["attempt"] == 1
    assert rerun["data"] == {"kind": "core.agent", "attempt": 2}


@pytest.mark.asyncio
async def test_run_completed_carries_the_conforming_notices(stream) -> None:
    bad = {**_WARN, "noticeId": "x-bad", "defaultMessage": "free text"}
    await _emit(
        RunEventSpec(
            event_type=EVENT_RUN_COMPLETED,
            status="SUCCEEDED",
            retention_seconds=60,
            guardrail_notices=[_WARN, bad],
        )
    )
    (completed,) = stream.events(_RUN)
    assert completed["type"] == "run.completed"
    assert completed["data"]["guardrailNotices"] == [_WARN]
    assert run_event_problems(completed, plane="public") == []


@pytest.mark.asyncio
async def test_a_completed_run_without_notices_carries_none(stream) -> None:
    await _emit(
        RunEventSpec(event_type=EVENT_RUN_COMPLETED, status="SUCCEEDED", retention_seconds=60)
    )
    (completed,) = stream.events(_RUN)
    assert "guardrailNotices" not in completed["data"]


@pytest.mark.asyncio
async def test_a_timed_out_hold_fails_node_and_run_with_guardrail_blocked(stream) -> None:
    reason = "GUARDRAIL_BLOCKED: hold 01927f6e-… timed out after 60s"
    await _emit(
        RunEventSpec(
            event_type=EVENT_NODE_FAILED,
            node_id="n_note",
            node_type="core.agent",
            status="FAILED",
            reason=reason,
        ),
        RunEventSpec(
            event_type=EVENT_RUN_COMPLETED, status="FAILED", reason=reason, retention_seconds=60
        ),
    )
    node_failed, run_failed = stream.events(_RUN)
    assert node_failed["data"]["error"]["code"] == "GUARDRAIL_BLOCKED"
    assert run_failed["type"] == "run.failed"
    assert run_failed["data"]["error"]["code"] == "GUARDRAIL_BLOCKED"
    assert run_failed["data"]["error"]["message"] == "A guardrail blocked the content."


def test_the_reason_maps_to_the_fixed_code() -> None:
    assert interpreter_activities.run_error_code_of("GUARDRAIL_BLOCKED") == "GUARDRAIL_BLOCKED"
    assert (
        interpreter_activities.run_error_code_of(
            "GUARDRAIL_BLOCKED: core.agent: egress_redaction_unavailable (notice x)"
        )
        == "GUARDRAIL_BLOCKED"
    )
