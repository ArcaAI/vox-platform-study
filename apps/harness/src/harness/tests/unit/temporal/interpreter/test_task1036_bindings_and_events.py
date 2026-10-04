"""TASK-1036 §9 / TASK-1038 R6 (lane B1) — data moves by BINDINGS, and the run speaks protocol v2.

Real time-skipping Temporal, the real ``WorkflowInterpreter`` and the real interpreter activities;
only ``interpreter.core_agent`` is the programmable stub of ``_task1038_harness`` (still wrapped in
the production node-activity envelope) and only the Redis SOCKET is faked — the sequencer itself
runs (``_run_stream_fake``). Asserted:

* a node's compiled ``bindings`` decide what it is handed — the NodeIO and the legacy ``nodes.*``
  spellings, ``context.*``, ``firstOf`` (first non-null), ``template``, ``run.now``; a config with
  NO ``bindings`` keeps the edge-port behaviour (``test_core_interpreter.py`` and the replay
  fixtures prove that one);
* declared ``consultation.*`` reads are fetched by an activity (node start by default, run start
  when declared), recorded, and a failed read fails the step by name without dispatching it;
* every stored event is a valid v2 event, in one contiguous sequence: ``run.started``,
  ``node.started`` (with its label), the admin ``data.bound`` / ``consultation.read`` /
  per-field ``output.data``, the public ``output.text.delta`` of a node wired into End, and a
  terminal event carrying the gateway-injected retention.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

import pytest

from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.models import RunSubject
from harness.temporal.interpreter.run_protocol import run_event_problems
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


def _with(node: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {**node, **extra}


def _graph(*stages: list[dict[str, Any]]) -> dict[str, Any]:
    return h.body([{"stageIndex": i, "nodes": nodes} for i, nodes in enumerate(stages)])


class TestBindingsDecideWhatANodeIsHanded:
    @pytest.mark.asyncio
    async def test_every_binding_shape_and_both_node_spellings(self, stream) -> None:
        graph = _graph(
            [h.trigger()],
            [h.agent("n_a", inputs=[h.edge("n_trigger", "out", "context")])],
            [
                _with(
                    h.agent("n_b", _stub="echo"),
                    bindings={
                        "message": {"from": "nodes.n_a.outputs.text"},
                        "context": {"from": "context.patient"},
                        "legacy": {"from": "nodes.n_a.text"},
                        "picked": {"firstOf": ["nodes.n_a.outputs.data", "nodes.n_a.outputs.text"]},
                        "intro": {
                            "template": "Age {{context.patient.age}}: {{nodes.n_a.outputs.text}}"
                        },
                        "lang": {"value": "en"},
                        "now": {"from": "run.now"},
                    },
                )
            ],
        )
        result, nodes, _ = await h.run_graph(graph, payload={"patient": {"age": 67}})
        assert result.status == "SUCCEEDED", nodes
        seen = h.SEEN["n_b"].bound_inputs
        # `message` is what the agent works on; the agent activity reads it as `in`.
        assert seen["message"] == "agent-n_a"
        assert seen["context"] == {"age": 67}
        assert seen["legacy"] == "agent-n_a"
        assert seen["picked"] == "agent-n_a"  # `data` is absent, so the first non-null wins
        assert seen["intro"] == "Age 67: agent-n_a"
        assert seen["lang"] == "en"
        assert dt.datetime.fromisoformat(seen["now"]).tzinfo is not None

    @pytest.mark.asyncio
    async def test_an_unresolved_binding_is_absent_and_warned(self, stream) -> None:
        graph = _graph(
            [h.trigger()],
            [
                _with(
                    h.agent("n_b", _stub="echo"),
                    bindings={"message": {"from": "context.nothing.here"}},
                )
            ],
        )
        _result, _nodes, _ = await h.run_graph(graph, payload={"q": 1}, retention_seconds=60)
        assert "message" not in h.SEEN["n_b"].bound_inputs
        warnings = [e for e in stream.events(_run_id(stream)) if e["type"] == "binding.warning"]
        assert [(w["nodeId"], w["data"]["input"], w["data"]["code"]) for w in warnings] == [
            ("n_b", "message", "BINDING_UNRESOLVED")
        ]


class TestConsultationDeclaredReads:
    @pytest.mark.asyncio
    async def test_a_node_start_read_feeds_the_binding_and_is_traced(self, stream, api) -> None:
        fake = api({"consultation.patient.age": 41})
        graph = _graph(
            [h.trigger()],
            [
                _with(
                    h.agent("n_b", _stub="echo"),
                    bindings={"age": {"from": "consultation.patient.age"}},
                    consultationReads=[{"path": "consultation.patient.age", "at": "nodeStart"}],
                )
            ],
        )
        result, _nodes, _ = await h.run_graph(
            graph, subject=RunSubject(consultationId=_CONSULTATION), retention_seconds=60
        )
        assert result.status == "SUCCEEDED"
        assert h.SEEN["n_b"].bound_inputs["age"] == 41
        assert fake.calls[0]["paths"] == ["consultation.patient.age"]
        assert fake.calls[0]["node_id"] == "n_b"
        (read,) = [e for e in stream.events(_run_id(stream)) if e["type"] == "consultation.read"]
        assert read["nodeId"] == "n_b"
        assert read["data"]["snapshot"] == "node-start"
        assert read["data"]["fields"] == [
            {"path": "consultation.patient.age", "phiClass": "PHI", "value": 41}
        ]

    @pytest.mark.asyncio
    async def test_a_run_start_read_is_taken_once_before_the_walk(self, stream, api) -> None:
        fake = api({"consultation.visitType": "revisit"})
        graph = _graph(
            [h.trigger()],
            [
                _with(
                    h.agent("n_b", _stub="echo"),
                    bindings={"visit": {"from": "consultation.visitType", "at": "runStart"}},
                    consultationReads=[{"path": "consultation.visitType", "at": "runStart"}],
                )
            ],
        )
        await h.run_graph(graph, subject=RunSubject(consultationId=_CONSULTATION))
        assert h.SEEN["n_b"].bound_inputs["visit"] == "revisit"
        assert len(fake.calls) == 1
        types = [e["type"] for e in stream.events(_run_id(stream))]
        assert types.index("consultation.read") < types.index("node.started")

    @pytest.mark.asyncio
    async def test_a_failed_read_fails_the_step_by_name_and_never_dispatches_it(
        self, stream, api
    ) -> None:
        from harness.services.api_client import ApiClientError

        api(ApiClientError("apps/api read failed: 400", status_code=400))
        graph = _graph(
            [h.trigger()],
            [
                _with(
                    h.agent("n_b", _stub="echo"),
                    bindings={"age": {"from": "consultation.patient.age"}},
                    consultationReads=[{"path": "consultation.patient.age", "at": "nodeStart"}],
                )
            ],
        )
        _result, nodes, _ = await h.run_graph(
            graph, subject=RunSubject(consultationId=_CONSULTATION), retention_seconds=60
        )
        assert nodes["n_b"].status == "DEGRADED"
        assert nodes["n_b"].reason.startswith("CONSULTATION_READ_FAILED")
        assert "n_b" not in h.SEEN


def _run_id(stream: FakeRunStreamRedis) -> str:
    (key,) = stream.streams
    return key.split(":")[2]


class TestProtocolV2Emission:
    @pytest.mark.asyncio
    async def test_a_walk_is_one_contiguous_valid_v2_sequence(self, stream) -> None:
        graph = _graph(
            [h.trigger()],
            [
                _with(
                    h.agent("n_note", label="Write the note"),
                    bindings={"context": {"from": "nodes.n_trigger.outputs.context"}},
                )
            ],
            [h.output([h.edge("n_note", "out", "in")])],
        )
        result, _nodes, _ = await h.run_graph(graph, payload={"q": 1}, retention_seconds=86_400)
        assert result.status == "SUCCEEDED"
        run_id = _run_id(stream)
        events = stream.events(run_id)
        assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
        for event in events:
            assert run_event_problems(event) == [], event
        types = [e["type"] for e in events]
        assert types[0] == "run.started"
        assert events[0]["data"] == {"kind": "workflow", "slug": "core-test", "versionNumber": 1}
        assert types[-1] == "run.completed"
        started = next(e for e in events if e["type"] == "node.started" and e["nodeId"] == "n_note")
        assert started["data"] == {"kind": "core.agent", "label": "Write the note", "attempt": 1}
        assert any(e["type"] == "data.bound" and e["nodeId"] == "n_note" for e in events)
        (validated_in,) = [e for e in events if e["type"] == "input.validated"]
        assert "nodeId" not in validated_in and validated_in["data"]["valid"] is True
        (validated_out,) = [e for e in events if e["type"] == "output.validated"]
        assert validated_out["nodeId"] == "n_output" and validated_out["data"]["valid"] is True
        # n_note is wired into End: its text reaches the PUBLIC plane as a delta …
        deltas = [e for e in events if e["type"] == "output.text.delta"]
        assert [(d["nodeId"], d["data"]) for d in deltas] == [
            ("n_note", {"field": "text", "text": "agent-n_note"})
        ]
        # … and the admin trace still gets every declared output of every node as a final value.
        admin = {
            (e["nodeId"], e["data"]["field"])
            for e in events
            if e["type"] == "output.data" and e["data"].get("visibility") == "admin"
        }
        assert {("n_trigger", "context"), ("n_note", "text")} <= admin
        completed = next(e for e in events if e["type"] == "node.completed")
        assert completed["data"]["status"] == "COMPLETED"
        assert isinstance(completed["data"]["durationMs"], int)
        # The terminal append carried the injected retention and closed all three keys.
        assert set(stream.expiry.values()) == {86_400}
        assert events[-1]["data"]["result"] == {"kind": "inline", "value": "agent-n_note"}

    @pytest.mark.asyncio
    async def test_a_run_started_without_injected_retention_leaves_the_clock_to_the_gateway(
        self, stream
    ) -> None:
        graph = _graph([h.trigger()], [h.agent("n_a", inputs=[h.edge("n_trigger", "out", "in")])])
        await h.run_graph(graph, payload={"q": 1})
        assert stream.expiry == {}
        assert stream.events(_run_id(stream))[-1]["type"] == "run.completed"

    @pytest.mark.asyncio
    async def test_a_failed_run_carries_a_fixed_label_and_the_detail_for_admins(
        self, stream
    ) -> None:
        graph = _graph(
            [h.trigger()],
            [h.agent("n_a", _stub="client_error", inputs=[h.edge("n_trigger", "out", "in")])],
        )
        await h.run_graph(graph, payload={"q": 1}, retention_seconds=60)
        events = stream.events(_run_id(stream))
        for event in events:
            assert run_event_problems(event) == [], event
        settled = next(
            e
            for e in events
            if e.get("nodeId") == "n_a" and e["type"] in ("node.completed", "node.failed")
        )
        assert settled["type"] == "node.completed"  # a non-critical agent degrades
        assert settled["data"]["status"] == "DEGRADED"
