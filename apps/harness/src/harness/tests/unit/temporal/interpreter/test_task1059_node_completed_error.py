"""TASK-1059 lane O — a DEGRADED ``node.completed`` names why (``errorCode`` + ``errorMessage``).

A node that degrades (an agent that did not resolve, a model error) used to settle as a bare
``status: DEGRADED``: the console showed a degraded step with no reason. The emit now carries the
fixed run-error code and its fixed label — PHI-free by construction (the free-text reason never
travels on this event). A healthy completion carries neither. Both fields are optional in the
schema, so every event stored before them stays valid.

Replay: this is the ``emit_run_events`` ACTIVITY's payload mapping, not workflow code — the
workflow's commands and the recorded ``RunEventSpec`` inputs are unchanged, so no
``workflow.patched`` is involved.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.interpreter import activities as act
from harness.temporal.interpreter.models import RunEventBatch, RunEventSpec
from harness.temporal.interpreter.run_events import EVENT_NODE_COMPLETED
from harness.temporal.interpreter.run_protocol import run_error_message, run_event_problems


class _Producer:
    def __init__(self) -> None:
        self.appended: list[dict[str, Any]] = []

    async def append(self, **kwargs: Any) -> None:
        self.appended.append(kwargs)


async def _settle(**spec: Any) -> dict[str, Any]:
    producer = _Producer()
    batch = RunEventBatch(run_id="run-1", tenant_id="t-1")
    await act._append_spec(
        producer,  # type: ignore[arg-type]
        batch,
        RunEventSpec(event_type=EVENT_NODE_COMPLETED, node_id="n_note", duration_ms=12, **spec),
    )
    (completed,) = [a for a in producer.appended if a["type"] == "node.completed"]
    return completed["data"]


def _event(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "seq": 1,
        "runId": "run-1",
        "type": "node.completed",
        "ts": "2026-10-10T09:00:00.000Z",
        "nodeId": "n_note",
        "data": data,
    }


@pytest.mark.asyncio
async def test_a_degraded_completion_carries_the_code_and_its_fixed_label() -> None:
    data = await _settle(status="DEGRADED", reason="core.agent: TextServiceError: 500 boom")
    assert data["status"] == "DEGRADED"
    assert data["errorCode"] == "MODEL_ERROR"
    assert data["errorMessage"] == run_error_message("MODEL_ERROR")
    # The free-text reason never rides on this event.
    assert "boom" not in str(data)
    assert run_event_problems(_event(data)) == []


@pytest.mark.asyncio
async def test_an_explicit_error_code_wins_over_the_reason_mapping() -> None:
    data = await _settle(status="DEGRADED", reason="whatever", error_code="NODE_TIMED_OUT")
    assert data["errorCode"] == "NODE_TIMED_OUT"
    assert data["errorMessage"] == run_error_message("NODE_TIMED_OUT")


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["SUCCEEDED", "SKIPPED"])
async def test_a_healthy_or_skipped_completion_carries_neither(status: str) -> None:
    data = await _settle(status=status, reason="sandbox")
    assert "errorCode" not in data
    assert "errorMessage" not in data


def test_the_schema_accepts_both_fields() -> None:
    data = {
        "status": "DEGRADED",
        "durationMs": 1,
        "errorCode": "AGENT_VERSION_UNAVAILABLE",
        "errorMessage": "The pinned agent version is not available.",
    }
    assert run_event_problems(_event(data)) == []


def test_the_schema_refuses_a_free_text_code() -> None:
    data = {"status": "DEGRADED", "durationMs": 1, "errorCode": "agent did not resolve: x"}
    assert run_event_problems(_event(data)) != []
