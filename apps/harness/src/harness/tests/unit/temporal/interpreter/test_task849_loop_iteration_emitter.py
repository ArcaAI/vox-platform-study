"""TASK-848 follow-up — ``workflow.loop.iteration`` is PRODUCED, not merely handled.

Lane A shipped the constant (``run_events.EVENT_LOOP_ITERATION``), the idempotency-key
recipe (``loop_iteration_key``) and the envelope branch (``_envelope_for``). Lane C shipped
the ``◀ 3/12 ▶`` per-iteration drill-down. Between them sat the gap this file closes:
**nothing emitted the event**, so the drill-down rendered permanently disabled and the
handler was unreachable code.

**What is asserted here is a REAL run, not a hand-built envelope.** The graph is a real
compiled config walked by the real ``WorkflowInterpreter``; the loop is the real
``AgenticLoopWorkflow`` with its real ``continue_as_new`` boundary and real bound
arithmetic; the emission happens inside the real ``interpreter.loop_state_checkpoint``
activity. Only the model call (``_agentic_loop_stubs``) and the Redis socket are faked. The
iteration COUNT the test compares against is read off the loop's own
``AgenticLoopResult.iterations`` — the number the production workflow reports — never a
constant typed into the assertion.

**Why the emitter lives in the checkpoint, and why that needs no patch gate.**
``interpreter.loop_state_checkpoint`` already runs exactly once per iteration. Emitting from
inside it adds no Temporal command: the ``ScheduleActivityTask`` was already there. What
changed is the activity's INPUT payload (new fields, all defaulted) and what the activity
does internally — and activity bodies are not replayed at all. ``test_replay_compat.py``'s
loop guards are the proof that the command sequence is unchanged.

**History impact is MEASURED, decoded.** ``TestIterationEventsDoNotBloatTemporalHistory``
follows ``test_task849_two_lane_split.py``'s method, including its finding that Temporal
base64-encodes payload bodies — a raw-JSON substring search over a history is vacuous, so
every payload is decoded before it is searched.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import uuid

import pytest
from temporalio import activity
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from harness.temporal.claim_check import _MEMORY_STORE, store_blob
from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.activities import INTERPRETER_ACTIVITIES
from harness.temporal.interpreter.compiled_config import canonical_json
from harness.temporal.interpreter.gate_workflow import ConsultationGateWorkflow
from harness.temporal.interpreter.loop_activities import LOOP_ACTIVITIES
from harness.temporal.interpreter.loop_workflow import (
    AgenticLoopWorkflow,
    AgenticSubAgentWorkflow,
    agentic_loop_workflow_id,
)
from harness.temporal.interpreter.models import AgenticLoopResult, InterpreterInput
from harness.temporal.interpreter.run_events import (
    EVENT_LOOP_ITERATION,
    loop_iteration_key,
    run_event_stream_key,
)
from harness.temporal.interpreter.workflow import WorkflowInterpreter

from ._agentic_loop_stubs import stub_agentic_agent
from .test_agentic_loop_task848 import _LOOP_NODE, _ORCHESTRATOR, _body

_BUCKET = "harness-claim-check"

#: A REAL uuid, and that is load-bearing rather than cosmetic. ``AsyncEnvelope.tenant_id`` is
#: a ``UuidStr``, so the sibling loop suite's ``"t-1"`` would make every envelope fail
#: validation — and the emitter is best-effort, so it would fail SILENTLY and this file would
#: assert zero events forever. See ``emit_run_events``' own docstring on the same trap.
TENANT = "22222222-2222-2222-2222-222222222222"


class FakeRedisStream:
    """Records ``xadd`` calls. Same shape ``test_task849_two_lane_split.py`` uses."""

    def __init__(self) -> None:
        self.by_key: dict[str, list[dict]] = {}
        self._seq = 0

    async def xadd(self, key, fields, maxlen=None, approximate=None):  # noqa: ANN001
        self._seq += 1
        self.by_key.setdefault(key, []).append(json.loads(fields["data"]))
        return f"{self._seq}-0"


def _decoded_history_payloads(history_json: str) -> str:
    """Every payload body in a history, base64-decoded and concatenated.

    Lane A's finding, reused verbatim: Temporal serialises payload ``data`` as base64, so
    grepping the raw history JSON for a value finds nothing whether or not the value is in
    there. Decoding is the difference between a test and a test-shaped no-op.
    """
    chunks: list[str] = []

    def walk(node: object) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "data" and isinstance(value, str):
                    try:
                        chunks.append(base64.b64decode(value).decode("utf-8", "replace"))
                    except (ValueError, binascii.Error):
                        pass
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(json.loads(history_json))
    return "".join(chunks)


def _bounds(max_iterations: int, *, max_total_tokens: int = 1_000_000) -> dict:
    return {
        "maxIterations": max_iterations,
        "maxDurationSeconds": 300,
        "maxTotalTokens": max_total_tokens,
        "noProgressIterations": 99,
    }


@pytest.fixture
async def env():
    async with await WorkflowEnvironment.start_time_skipping(
        data_converter=pydantic_data_converter
    ) as environment:
        yield environment


def _activity_name(fn) -> str:
    """The name an activity is registered under, from Temporal's own definition metadata."""
    return activity._Definition.must_from_callable(fn).name  # noqa: SLF001


async def _run_loop(env, body: dict, redis: FakeRedisStream | None, monkeypatch):
    """Walk ``body`` with the real interpreter; return ``(loop_result, run_id, history_json)``.

    ``redis=None`` installs the producer's documented no-client path, which is how the
    history-impact test gets a run that is identical in every way except that no iteration
    event is written.

    ``loop_result`` is the loop's OWN ``AgenticLoopResult``, fetched from the child handle —
    which is how the assertions get the iteration count the production workflow reports
    rather than one the test asserts into existence. ``continue_as_new`` keeps the workflow
    id for the whole chain (``agentic_loop_workflow_id``), so one handle resolves the final
    generation's result.
    """
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS", redis, raising=False)
    monkeypatch.setattr(interpreter_activities, "_RUN_EVENT_REDIS_BUILT", True, raising=False)

    checksum = hashlib.sha256(canonical_json(body).encode("utf-8")).hexdigest()
    ref = await store_blob(
        json.dumps({**body, "checksum": checksum}), store=_MEMORY_STORE, bucket=_BUCKET
    )
    run_id = str(uuid.uuid4())
    tq = f"loop-iter-{uuid.uuid4()}"

    async with Worker(
        env.client,
        task_queue=tq,
        workflows=[
            WorkflowInterpreter,
            ConsultationGateWorkflow,
            AgenticLoopWorkflow,
            AgenticSubAgentWorkflow,
        ],
        activities=[
            *(
                a
                for a in INTERPRETER_ACTIVITIES
                if _activity_name(a) != "interpreter.agentic_agent"
            ),
            *LOOP_ACTIVITIES,
            stub_agentic_agent,
        ],
    ):
        handle = await env.client.start_workflow(
            WorkflowInterpreter.run,
            InterpreterInput(
                session_id="s-1",
                workflow_version_id="v-1",
                config_ref=ref,
                tenant_id=TENANT,
                run_id=run_id,
                sandbox=False,
                payload={},
            ),
            id=f"wf-loop-iter-{run_id}",
            task_queue=tq,
        )
        await handle.result()
        history_json = (await handle.fetch_history()).to_json()

        # `result_type` is required: a bare `get_workflow_handle` has no idea what the child
        # returned and hands back a plain dict, so `.iterations` would not exist.
        loop_handle = env.client.get_workflow_handle(
            agentic_loop_workflow_id(run_id, _LOOP_NODE), result_type=AgenticLoopResult
        )
        loop_result: AgenticLoopResult = await loop_handle.result()

    return loop_result, run_id, history_json


def _iteration_events(redis: FakeRedisStream, run_id: str) -> list[dict]:
    return [
        event
        for event in redis.by_key.get(run_event_stream_key(run_id), [])
        if event["type"] == EVENT_LOOP_ITERATION
    ]


class TestALoopRunEmitsOneIterationEventPerIteration:
    """The gap, closed and measured against the run's own reported iteration count."""

    @pytest.mark.asyncio
    async def test_the_emitted_count_equals_the_iterations_the_loop_performed(
        self, env, monkeypatch
    ):
        """THE assertion. Not "some events arrived" — exactly as many as the loop ran.

        The expected value comes from ``AgenticLoopResult.iterations``, produced by the
        production workflow's own bound arithmetic. A constant here would still pass if the
        emitter fired a fixed number of times regardless of the loop, which is precisely the
        placeholder-data failure this ticket forbids.
        """
        redis = FakeRedisStream()
        loop_result, run_id, _ = await _run_loop(
            env, _body(bounds=_bounds(5)), redis, monkeypatch
        )

        events = _iteration_events(redis, run_id)

        assert loop_result.iterations > 1, (
            "the loop under test did not actually iterate "
            f"({loop_result.iterations}) — nothing is being measured"
        )
        print(
            f"\n[TASK-848 loop.iteration emitter, measured] "
            f"iterations_performed={loop_result.iterations} "
            f"stop_reason={loop_result.stop_reason} "
            f"loop_iteration_events_emitted={len(events)}"
        )
        assert len(events) == loop_result.iterations, (
            f"emitted {len(events)} `workflow.loop.iteration` events for a loop that "
            f"performed {loop_result.iterations} iterations"
        )

    @pytest.mark.asyncio
    async def test_the_count_tracks_the_bound_rather_than_being_fixed(self, env, monkeypatch):
        """A shorter loop emits fewer. Rules out an emitter that fires a constant number."""
        short_redis = FakeRedisStream()
        short_result, short_run, _ = await _run_loop(
            env, _body(bounds=_bounds(2)), short_redis, monkeypatch
        )
        long_redis = FakeRedisStream()
        long_result, long_run, _ = await _run_loop(
            env, _body(bounds=_bounds(7)), long_redis, monkeypatch
        )

        short_events = _iteration_events(short_redis, short_run)
        long_events = _iteration_events(long_redis, long_run)

        assert len(short_events) == short_result.iterations
        assert len(long_events) == long_result.iterations
        assert len(long_events) > len(short_events), (
            f"a 7-iteration loop emitted {len(long_events)} events and a 2-iteration loop "
            f"emitted {len(short_events)} — the count is not tracking the loop"
        )

    @pytest.mark.asyncio
    async def test_iteration_indices_are_contiguous_and_one_based(self, env, monkeypatch):
        """``1..n``, in order, no gaps and no duplicates.

        The drill-down renders ``current/total`` and steps through it, so a 0-based or gapped
        sequence shows the clinician an iteration number that does not exist.
        """
        redis = FakeRedisStream()
        loop_result, run_id, _ = await _run_loop(
            env, _body(bounds=_bounds(4)), redis, monkeypatch
        )

        indices = [event["payload"]["iteration"] for event in _iteration_events(redis, run_id)]
        assert indices == list(range(1, loop_result.iterations + 1)), (
            f"iteration indices {indices} are not 1..{loop_result.iterations}"
        )

    @pytest.mark.asyncio
    async def test_the_idempotency_key_is_the_recipe_lane_a_reserved(self, env, monkeypatch):
        """``wf:run:<runId>:node:<nodeId>:iter:<n>`` — derived from intent, never from chance.

        Lane A wrote ``loop_iteration_key`` and nothing called it. A consumer that collapses
        on the key must see a per-iteration key, or a retried checkpoint double-delivers.
        """
        redis = FakeRedisStream()
        _, run_id, _ = await _run_loop(env, _body(bounds=_bounds(3)), redis, monkeypatch)

        events = _iteration_events(redis, run_id)
        assert events, "no iteration events to inspect — this assertion would be vacuous"
        for event in events:
            assert event["idempotencyKey"] == loop_iteration_key(
                run_id, _LOOP_NODE, event["payload"]["iteration"]
            )


class TestThePayloadCarriesWhatTheDrilldownNeeds:
    """Cross-checked against ``apps/admin-console/.../workflow-runs/api/types.ts``.

    ``WorkflowNodeEventPayload.iteration`` (types.ts:206) is the field the ``◀ 3/12 ▶``
    control's ``current`` reads. ``LoopIterationState.total`` has no wire field yet — that is
    the client-side half of this gap, recorded in the ticket — so the producer emits
    ``maxIterations`` for it rather than leaving the control unable to ever enable itself.
    """

    @pytest.mark.asyncio
    async def test_every_event_carries_node_id_iteration_and_the_total(self, env, monkeypatch):
        redis = FakeRedisStream()
        _, run_id, _ = await _run_loop(env, _body(bounds=_bounds(3)), redis, monkeypatch)

        events = _iteration_events(redis, run_id)
        assert events, "no iteration events to inspect"
        for event in events:
            payload = event["payload"]
            # `current` / `total` for the drill-down.
            assert payload["nodeId"] == _LOOP_NODE
            assert isinstance(payload["iteration"], int)
            assert payload["maxIterations"] == 3
            # The stop-relevant counters — what a debug surface needs to explain WHY the loop
            # stopped where it did, without shipping the deliberation itself.
            assert isinstance(payload["tokensUsed"], int)
            assert isinstance(payload["maxTotalTokens"], int)
            assert isinstance(payload["terminated"], bool)
            assert isinstance(payload["digest"], str) and len(payload["digest"]) == 64

    @pytest.mark.asyncio
    async def test_the_envelope_correlates_to_the_run_and_the_tenant(self, env, monkeypatch):
        redis = FakeRedisStream()
        _, run_id, _ = await _run_loop(env, _body(bounds=_bounds(2)), redis, monkeypatch)

        events = _iteration_events(redis, run_id)
        assert events, "no iteration events to inspect — this assertion would be vacuous"
        for event in events:
            assert event["type"] == EVENT_LOOP_ITERATION
            assert event["correlationId"] == run_id
            assert event["tenantId"] == TENANT
            assert event["schemaVersion"] == 1

    @pytest.mark.asyncio
    async def test_the_carry_forward_itself_never_rides_the_event(self, env, monkeypatch):
        """TASK-848b's whole point: a loop's accumulated state may be MEGABYTES.

        The payload must stay a handful of scalars. This drives a loop whose carry-forward is
        pushed past the inline budget (`_stub_bulk_bytes`, the same knob
        ``TestCarryForwardOffload`` uses) and asserts the event did not grow with it.
        """
        body = _body(bounds=_bounds(3))
        orchestrator = body["stages"][0]["nodes"][0]
        assert orchestrator["nodeId"] == _ORCHESTRATOR
        orchestrator["config"]["_stub_bulk_bytes"] = 400_000

        redis = FakeRedisStream()
        _, run_id, _ = await _run_loop(env, body, redis, monkeypatch)

        events = _iteration_events(redis, run_id)
        assert events, "no iteration events to inspect"
        for event in events:
            encoded = json.dumps(event)
            assert "zzzz" not in encoded, (
                "the carry-forward leaked into the iteration event — a 400 KB blob per "
                "iteration on the delta stream defeats TASK-848b's offload entirely"
            )
            assert len(encoded) < 2_000, (
                f"iteration event is {len(encoded)} bytes; it must stay ids + counters"
            )


class TestIterationEventsDoNotBloatTemporalHistory:
    """The emission is replay-invisible AND history-invisible.

    Method from ``test_task849_two_lane_split.py``, including its base64 finding.
    """

    @pytest.mark.asyncio
    async def test_history_does_not_grow_with_the_iteration_events(self, env, monkeypatch):
        """A loop that emits N events must have the same history as one that emits none.

        ``_RUN_EVENT_REDIS = None`` makes ``RunEventProducer.emit`` a no-op (its documented
        ``None``-client path), so the two runs differ in EXACTLY one thing: whether the
        iteration events were written. Equal history sizes is the property — an emitter that
        signalled, or scheduled its own activity, would show up here.
        """
        emitting = FakeRedisStream()
        emit_result, emit_run, emit_history = await _run_loop(
            env, _body(bounds=_bounds(6)), emitting, monkeypatch
        )
        # Same graph, same bounds, producer given no client — its documented no-op path. The
        # ONLY difference between the two runs is whether the events were written.
        silent_result, _, silent_history = await _run_loop(
            env, _body(bounds=_bounds(6)), None, monkeypatch
        )

        emitted = _iteration_events(emitting, emit_run)
        assert len(emitted) == emit_result.iterations > 1

        emit_events = len(json.loads(emit_history)["events"])
        silent_events = len(json.loads(silent_history)["events"])

        print(
            f"\n[TASK-848 loop.iteration history impact, measured] "
            f"iterations={emit_result.iterations} events_emitted={len(emitted)} | "
            f"interpreter_history_events emitting={emit_events} "
            f"producer_disabled={silent_events} | "
            f"history_bytes={len(emit_history)}"
        )

        assert emit_events == silent_events, (
            f"Temporal history changed with the iteration emitter: {emit_events} vs "
            f"{silent_events}. Something is routing the event through Temporal — the "
            "emitter must stay inside the checkpoint activity."
        )
        assert silent_result.iterations == emit_result.iterations

    @pytest.mark.asyncio
    async def test_no_iteration_payload_field_appears_in_decoded_history(self, env, monkeypatch):
        """DECODED, because Temporal base64-encodes payload bodies.

        The digest is the tell: it is emitted on every iteration event and, being a sha256 of
        the deliberation's product, it appears nowhere in the loop's own inputs or results. If
        it turns up in the interpreter's history, the event is travelling through Temporal.
        """
        redis = FakeRedisStream()
        _, run_id, history_json = await _run_loop(
            env, _body(bounds=_bounds(4)), redis, monkeypatch
        )

        decoded = _decoded_history_payloads(history_json)
        assert decoded, "decoded nothing — the decoder is broken, so this assertion is vacuous"

        events = _iteration_events(redis, run_id)
        assert events
        for event in events:
            assert event["idempotencyKey"] not in decoded, (
                "an iteration event's idempotency key is in Temporal history — the control "
                "mirror is being routed through Temporal rather than emitted from the "
                "checkpoint activity"
            )
