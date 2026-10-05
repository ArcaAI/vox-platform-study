"""TASK-1038 lane E3 — a LOOP-BODY node's ``runStart`` consultation reads are taken and delivered.

Before: ``WorkflowInterpreter._read_run_start`` walked ``config.stages`` only, so a node inside a
``core.loop`` body (``config.loops[*].body.stages``) that declared ``at: runStart`` reads was never
read for — and ``LoopWorkflow`` had no way to hand a body node consultation values at all. The
binding resolved to nothing, silently.

After (behind ``workflow.patched("task-1038-loop-run-start-reads")``, consulted only for a graph
whose loop bodies declare run-start reads): the parent takes those reads once, before the walk and
after the top-level ones, and threads values and failures into the loop child. A body node then
binds the value; a failed read settles the body node by name without dispatching it.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.services.api_client import ApiClientError
from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.models import RunSubject
from harness.tests.unit.temporal.interpreter import _task1038_harness as h
from harness.tests.unit.temporal.interpreter._run_stream_fake import FakeRunStreamRedis

_CONSULTATION = "01a0816f-0000-7000-8000-0000000009e4"


@pytest.fixture(autouse=True)
def _reset() -> None:
    h.reset()


@pytest.fixture
def stream(monkeypatch: pytest.MonkeyPatch) -> FakeRunStreamRedis:
    redis = FakeRunStreamRedis()
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS", redis, raising=False)
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS_BUILT", True, raising=False)
    return redis


class _FakeApi:
    def __init__(self, answers: dict[str, Any] | Exception) -> None:
        self.answers = answers
        self.calls: list[dict[str, Any]] = []

    async def read_consultation(self, consultation_id: str, **kwargs: Any) -> dict[str, Any]:
        self.calls.append({"consultationId": consultation_id, **kwargs})
        if isinstance(self.answers, Exception):
            raise self.answers
        return {
            "values": {p: self.answers.get(p) for p in kwargs["paths"]},
            "readAt": "2026-10-04T10:00:00.000Z",
            "schemaVersion": 1,
        }


@pytest.fixture
def api(monkeypatch: pytest.MonkeyPatch) -> Any:
    def install(answers: dict[str, Any] | Exception) -> _FakeApi:
        fake = _FakeApi(answers)
        monkeypatch.setattr(interpreter_activities, "_api_client", lambda _settings: fake)
        return fake

    return install


def _graph() -> dict[str, Any]:
    trigger = h.trigger()
    trigger["config"] = {"kinds": ["consultation", "api"]}
    loop = {
        "nodeId": "n_loop",
        "type": "core.loop",
        "activity": "interpreter.core_loop",
        "config": {
            "mode": "foreach",
            "over": "trigger.items",
            "collect": "text",
            "bounds": {"maxIterations": 5, "maxDurationSeconds": 600, "maxTotalTokens": 100000},
        },
        "timeoutSeconds": 3600,
        "retry": {"maximumAttempts": 1, "initialIntervalSeconds": 1, "backoffCoefficient": 2},
        "inputs": [h.edge("n_trigger", "out", "in")],
        "onError": "degrade",
        "emitsTrajectory": True,
    }
    body_node = {
        **h.agent("n_body", _stub="echo"),
        "bindings": {"visit": {"from": "consultation.visitType", "at": "runStart"}},
        "consultationReads": [{"path": "consultation.visitType", "at": "runStart"}],
    }
    return h.body(
        [
            {"stageIndex": 0, "nodes": [trigger]},
            {"stageIndex": 1, "nodes": [loop]},
        ],
        loops=[{"nodeId": "n_loop", "body": {"stages": [{"stageIndex": 0, "nodes": [body_node]}]}}],
    )


class TestLoopBodyRunStartReads:
    @pytest.mark.asyncio
    async def test_a_body_node_run_start_read_is_taken_once_and_bound(self, stream, api) -> None:
        fake = api({"consultation.visitType": "revisit"})
        result, nodes, _ = await h.run_graph(
            _graph(),
            payload={"items": ["a", "b"]},
            subject=RunSubject(consultationId=_CONSULTATION),
            retention_seconds=60,
        )

        assert nodes["n_loop"].status == "SUCCEEDED", nodes
        assert [c["node_id"] for c in fake.calls] == ["n_body"]
        assert fake.calls[0]["paths"] == ["consultation.visitType"]
        assert h.SEEN["n_body"].bound_inputs["visit"] == "revisit"
        assert h.ATTEMPTS["n_body"] == 2

    @pytest.mark.asyncio
    async def test_a_failed_body_read_settles_the_body_node_by_name(self, stream, api) -> None:
        api(ApiClientError("apps/api read failed: 400", status_code=400))
        _result, nodes, _ = await h.run_graph(
            _graph(),
            payload={"items": ["a"]},
            subject=RunSubject(consultationId=_CONSULTATION),
            retention_seconds=60,
        )

        # Never dispatched on a guess; the agent is not critical, so the body continues DEGRADED.
        assert "n_body" not in h.SEEN
        assert nodes["n_loop"].status in ("SUCCEEDED", "DEGRADED")
