"""TASK-1042 OD-4a — a run bound to a LIVE STT session waits, durably, for the audio to end.

The ASR node cannot wait inside its own activity: ``caps.py`` caps a node at 900 s and a run's
compute at 3600 s, and a dictation may outlast both. So, exactly like the consultation live
handoff, the WALK parks before its first stage and polls a short activity
(``interpreter.load_live_audio_state``, C5 state only) every 5 s until the session is ``ended`` /
``truncated`` / ``timeout`` (or unbound), or the clamped ceiling passes. The wait is not charged to
``maxTotalSeconds``, a cancel ends it at once, and a run without ``live_audio`` never consults the
``task-1042-live-audio-wait`` marker at all.

Also pinned here: the gateway client method for C5 and the activity's failure posture.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import httpx
import pytest
from temporalio import activity
from temporalio.api.enums.v1 import EventType
from temporalio.client import WorkflowHandle
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.services.api_client import ApiClient, ApiClientError, ApiServiceError
from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.models import (
    CancelSignal,
    InterpreterInput,
    LiveAudioBinding,
    LiveAudioStateRequest,
    LiveAudioStateResult,
)
from harness.temporal.interpreter.workflow import WorkflowInterpreter
from harness.tests.unit.temporal.interpreter import _task1038_harness as h
from harness.tests.unit.temporal.interpreter._run_stream_fake import FakeRunStreamRedis

pytestmark = pytest.mark.usefixtures("interpreter_scaffolding")

_ACTIVITY = "interpreter.load_live_audio_state"
_PATCH = "task-1042-live-audio-wait"


@pytest.fixture(autouse=True)
def stream(monkeypatch):
    fake = FakeRunStreamRedis()
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS", fake, raising=False)
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS_BUILT", True, raising=False)
    h.reset()
    yield fake
    h.reset()


# ---------------------------------------------------------------------------------------------
# The run harness — `_task1038_harness.run_graph` plus the `live_audio` channel.
# ---------------------------------------------------------------------------------------------


def _graph(*, max_total: int = 3600) -> dict:
    graph = h.body(
        [
            {"stageIndex": 0, "nodes": [h.trigger()]},
            {
                "stageIndex": 1,
                "nodes": [h.agent("n_asr", inputs=[h.edge("n_trigger", "out", "audio")])],
            },
        ]
    )
    graph["caps"]["maxTotalSeconds"] = max_total
    return graph


class _Script:
    """A scripted ``load_live_audio_state``: answers in order, the last answer repeats."""

    def __init__(self, *states: str) -> None:
        self.states = list(states)
        self.requests: list[LiveAudioStateRequest] = []

    def activity(self) -> Any:
        @activity.defn(name=_ACTIVITY)
        async def load_live_audio_state(request: LiveAudioStateRequest) -> LiveAudioStateResult:
            self.requests.append(request)
            state = self.states.pop(0) if len(self.states) > 1 else self.states[0]
            return LiveAudioStateResult(state=state)

        return load_live_audio_state


def _activities(script: _Script) -> list[Any]:
    return [
        a for a in h.ACTIVITIES if getattr(a, "__temporal_activity_definition").name != _ACTIVITY
    ] + [script.activity()]


async def _run(
    graph: dict,
    *,
    script: _Script,
    live_audio: LiveAudioBinding | None,
    during: Any = None,
) -> tuple[Any, dict[str, Any], Any]:
    ref = await h._store(graph)  # noqa: SLF001 — the shared harness's own claim-check writer
    run_id = str(uuid.uuid4())
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as env:
        tq = f"task1042-{uuid.uuid4()}"
        async with Worker(
            env.client, task_queue=tq, workflows=h.WORKFLOWS, activities=_activities(script)
        ):
            handle: WorkflowHandle = await env.client.start_workflow(
                WorkflowInterpreter.run,
                InterpreterInput(
                    session_id="s-1",
                    workflow_version_id="v-1",
                    config_ref=ref,
                    tenant_id=h.TENANT,
                    run_id=run_id,
                    payload={"audio": {"sttSessionId": "stt-1"}},
                    live_audio=live_audio,
                ),
                id=f"wf-task1042-{run_id}",
                task_queue=tq,
            )
            if during is not None:
                await during(env, handle)
            result = await handle.result()
            history = await handle.fetch_history()
    return result, {n.node_id: n for s in result.stages for n in s.nodes}, history


def _scheduled(history: Any) -> list[str]:
    return [
        e.activity_task_scheduled_event_attributes.activity_type.name
        for e in history.events
        if e.event_type == EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED
    ]


def _patches(history: Any) -> set[str]:
    """Every patch id a ``workflow.patched`` call recorded (decoded from the marker payloads)."""
    found: set[str] = set()
    for event in history.events:
        if event.event_type != EventType.EVENT_TYPE_MARKER_RECORDED:
            continue
        attrs = event.marker_recorded_event_attributes
        for payload in attrs.details["patch-data"].payloads:
            found.add(json.loads(payload.data)["id"])
    return found


_BOUND = LiveAudioBinding(sttSessionId="stt-1", maxWaitSeconds=3600)


# ---------------------------------------------------------------------------------------------
# The wait
# ---------------------------------------------------------------------------------------------


class TestTheWait:
    @pytest.mark.asyncio
    async def test_the_walk_waits_until_the_session_ends_then_runs_the_graph(self):
        script = _Script("live", "live", "ended")

        result, nodes, history = await _run(_graph(), script=script, live_audio=_BOUND)

        assert result.status == "SUCCEEDED"
        assert nodes["n_asr"].status == "SUCCEEDED"
        assert len(script.requests) == 3
        assert {(r.stt_session_id, r.tenant_id) for r in script.requests} == {("stt-1", h.TENANT)}
        assert {r.run_id for r in script.requests} == {result.run_id}

    @pytest.mark.asyncio
    async def test_the_wait_comes_before_the_first_stage(self):
        script = _Script("live", "ended")

        _, _, history = await _run(_graph(), script=script, live_audio=_BOUND)

        scheduled = _scheduled(history)
        assert scheduled.index(_ACTIVITY) < scheduled.index("interpreter.core_trigger")
        # Every poll happened before the trigger: nothing in the graph ran while audio was live.
        last_poll = max(i for i, name in enumerate(scheduled) if name == _ACTIVITY)
        assert last_poll < scheduled.index("interpreter.core_trigger")

    @pytest.mark.asyncio
    @pytest.mark.parametrize("terminal", ["truncated", "timeout", "unbound"])
    async def test_every_terminal_state_ends_the_wait_and_the_node_decides(self, terminal):
        script = _Script("live", terminal)

        _, nodes, _ = await _run(_graph(), script=script, live_audio=_BOUND)

        assert len(script.requests) == 2
        assert nodes["n_asr"].status == "SUCCEEDED"  # the stub node; the real one re-reads C5

    @pytest.mark.asyncio
    async def test_the_wait_stops_at_its_clamped_ceiling(self):
        script = _Script("live")

        result, nodes, _ = await _run(
            _graph(),
            script=script,
            live_audio=LiveAudioBinding(sttSessionId="stt-1", maxWaitSeconds=12),
        )

        # Polls at 0, 5, 10 and 15 s: the ceiling (12 s) is checked after each live answer.
        assert len(script.requests) == 4
        assert nodes["n_asr"].status == "SUCCEEDED"
        assert result.status == "SUCCEEDED"

    @pytest.mark.asyncio
    async def test_an_unclamped_ceiling_is_clamped_by_the_workflow_too(self):
        """The workflow never trusts its input to have been clamped by the dispatcher."""
        from harness.temporal.interpreter import caps

        script = _Script("live")

        _, nodes, _ = await _run(
            _graph(),
            script=script,
            live_audio=LiveAudioBinding(sttSessionId="stt-1", maxWaitSeconds=10 * 3600),
        )

        polls = len(script.requests)
        assert polls <= caps.LIVE_AUDIO_MAX_WAIT_SECONDS // 5 + 2
        assert nodes["n_asr"].status == "SUCCEEDED"

    @pytest.mark.asyncio
    async def test_the_wait_is_not_charged_to_the_compute_budget(self):
        """Twenty seconds parked on a 5 s compute budget: the run still succeeds."""
        script = _Script("live", "live", "live", "live", "ended")

        result, nodes, _ = await _run(_graph(max_total=5), script=script, live_audio=_BOUND)

        assert result.status == "SUCCEEDED"
        assert nodes["n_asr"].status == "SUCCEEDED"

    @pytest.mark.asyncio
    async def test_a_cancel_ends_the_wait_at_once_and_nothing_runs(self):
        script = _Script("live")

        async def cancel_while_waiting(env, handle):  # noqa: ANN001
            from harness.tests.unit.temporal._temporal_sync import await_history_event

            def polled(event) -> bool:  # noqa: ANN001
                return event.event_type == EventType.EVENT_TYPE_ACTIVITY_TASK_COMPLETED

            await await_history_event(handle, polled, description="first activity done")
            await handle.signal(WorkflowInterpreter.cancel, CancelSignal(reason="test"))

        result, nodes, _ = await _run(
            _graph(), script=script, live_audio=_BOUND, during=cancel_while_waiting
        )

        assert result.status == "CANCELLED"
        assert "n_trigger" not in nodes
        assert "n_asr" not in nodes
        assert h.ATTEMPTS == {}

    @pytest.mark.asyncio
    async def test_a_run_without_live_audio_never_waits_and_never_consults_the_marker(self):
        script = _Script("live")

        result, nodes, history = await _run(_graph(), script=script, live_audio=None)

        assert result.status == "SUCCEEDED"
        assert script.requests == []
        assert _ACTIVITY not in _scheduled(history)
        assert _PATCH not in _patches(history)
        assert _patches(history)  # the decoder sees the run's other markers

    @pytest.mark.asyncio
    async def test_a_bound_run_records_the_marker(self):
        script = _Script("ended")

        _, _, history = await _run(_graph(), script=script, live_audio=_BOUND)

        assert _PATCH in _patches(history)


# ---------------------------------------------------------------------------------------------
# The activity
# ---------------------------------------------------------------------------------------------


class _StubApi:
    def __init__(self, answer: Any) -> None:
        self.answer = answer
        self.calls: list[dict[str, Any]] = []

    async def get_stt_session_transcript(
        self, session_id: str, *, tenant_id: str, run_id: str
    ) -> dict[str, Any]:
        self.calls.append({"session_id": session_id, "tenant_id": tenant_id, "run_id": run_id})
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


_REQUEST = LiveAudioStateRequest(run_id="run-1", tenant_id="t-1", stt_session_id="stt-1")


class TestTheStateActivity:
    @pytest.fixture
    def api(self, monkeypatch):
        holder: dict[str, _StubApi] = {}

        def install(answer: Any) -> _StubApi:
            stub = _StubApi(answer)
            holder["stub"] = stub
            monkeypatch.setattr(interpreter_activities, "_api_client", lambda _settings: stub)
            return stub

        return install

    @pytest.mark.asyncio
    @pytest.mark.parametrize("state", ["live", "ended", "truncated", "timeout"])
    async def test_it_reports_the_gateways_state(self, api, state):
        stub = api({"state": state, "transcript": "PHI", "finals": [{"text": "PHI"}]})

        result = await interpreter_activities.load_live_audio_state(_REQUEST)

        assert result == LiveAudioStateResult(state=state)
        assert stub.calls == [{"session_id": "stt-1", "tenant_id": "t-1", "run_id": "run-1"}]

    @pytest.mark.asyncio
    async def test_the_result_never_carries_the_transcript(self, api):
        api({"state": "ended", "transcript": "the patient said", "finals": [{"text": "x"}]})

        result = await interpreter_activities.load_live_audio_state(_REQUEST)

        assert "the patient said" not in result.model_dump_json()

    @pytest.mark.asyncio
    async def test_a_404_is_unbound_and_ends_the_wait(self, api):
        api(ApiClientError("apps/api /x failed: 404", status_code=404))

        result = await interpreter_activities.load_live_audio_state(_REQUEST)

        assert result.state == "unbound"

    @pytest.mark.asyncio
    async def test_an_unreachable_gateway_is_still_live(self, api):
        """Indistinguishable from a session still recording: asked again, never mistaken for
        an ended one."""
        api(ApiServiceError("apps/api /x failed: connection refused"))

        result = await interpreter_activities.load_live_audio_state(_REQUEST)

        assert result.state == "live"

    @pytest.mark.asyncio
    async def test_an_unknown_state_is_still_live(self, api):
        api({"state": "paused"})

        result = await interpreter_activities.load_live_audio_state(_REQUEST)

        assert result.state == "live"

    def test_it_is_registered_on_the_worker(self):
        names = {
            getattr(a, "__temporal_activity_definition").name
            for a in interpreter_activities.INTERPRETER_ACTIVITIES
        }
        assert _ACTIVITY in names


# ---------------------------------------------------------------------------------------------
# The gateway client (C5)
# ---------------------------------------------------------------------------------------------


class TestTheC5ClientMethod:
    @pytest.mark.asyncio
    async def test_it_calls_the_internal_transcript_route_with_both_mandatory_headers(self):
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = request.url
            seen["headers"] = request.headers
            return httpx.Response(200, json={"state": "ended", "transcript": "", "finals": []})

        client = ApiClient(
            "http://api:8868",
            internal_prefix="/api/v1/internal/harness",
            service_token="svc-token",
            transport=httpx.MockTransport(handler),
        )

        body = await client.get_stt_session_transcript("stt/1", tenant_id="t-1", run_id="run-1")

        assert body["state"] == "ended"
        assert seen["url"].raw_path.split(b"?")[0] == (
            b"/api/v1/internal/stt/sessions/stt%2F1/transcript"
        )
        assert dict(seen["url"].params) == {"runId": "run-1"}
        assert seen["headers"]["X-Service-Token"] == "svc-token"
        assert seen["headers"]["X-Tenant-Id"] == "t-1"

    @pytest.mark.asyncio
    async def test_a_404_is_a_terminal_client_error(self):
        client = ApiClient(
            "http://api:8868",
            service_token="svc-token",
            transport=httpx.MockTransport(lambda _request: httpx.Response(404, json={})),
        )

        with pytest.raises(ApiClientError) as caught:
            await client.get_stt_session_transcript("stt-1", tenant_id="t-1", run_id="run-1")

        assert caught.value.status_code == 404
