"""Interpreter-owned activities: the seed node activities (Task 4) and the
claim-check config-loader activity (Task 5).

Every activity here follows the same posture as ``harness.temporal.activities``: all I/O
(including the claim-check dereference) lives here, never in the workflow body.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

from temporalio import activity

from harness.core.config import get_settings
from harness.core.redis_client import build_run_event_redis
from harness.temporal.activities import (
    STATUS_ERROR,
    STATUS_OK,
    STEP_NODE,
    _now,
)
from harness.temporal.activities import (
    _TrajectoryBatch as TrajectoryBatch,  # reuse, never a second emitter (Task 7) — noqa: SLF001
)
from harness.temporal.claim_check import ClaimCheckRef, load_blob, open_store
from harness.temporal.interpreter.compiled_config import CompiledWorkflowConfig, parse_and_verify
from harness.temporal.interpreter.models import (
    NodeActivityInput,
    NodeActivityResult,
    RunEventBatch,
    RunEventSpec,
)
from harness.temporal.interpreter.nodes.agent_catalogue import AGENT_CATALOGUE_ACTIVITIES
from harness.temporal.interpreter.nodes.agentic import AGENTIC_ACTIVITIES
from harness.temporal.interpreter.nodes.consultation import (
    interpreter_consultation_consent_gate,
    interpreter_consultation_hitl_gate,
    interpreter_consultation_phi_hop,
)
from harness.temporal.interpreter.nodes.consultation_capture import (
    interpreter_consultation_capture_binding,
)
from harness.temporal.interpreter.nodes.consultation_compose import (
    interpreter_consultation_assemble_prompt,
    interpreter_consultation_retrieve_evidence,
    interpreter_consultation_synthesize,
)
from harness.temporal.interpreter.nodes.consultation_endpoint import (
    interpreter_feedback_capture,
    interpreter_session_timeout,
    interpreter_summary_finalize,
)
from harness.temporal.interpreter.nodes.consultation_nlp import (
    interpreter_consultation_bind_terminology,
    interpreter_consultation_extract_entities,
)
from harness.temporal.interpreter.nodes.consultation_persist import (
    interpreter_consultation_finalize_assurance,
    interpreter_consultation_persist_draft,
)
from harness.temporal.interpreter.nodes.consultation_realtime import (
    interpreter_consultation_propose_corrections,
    interpreter_consultation_realtime_summary,
    interpreter_consultation_suggestions,
)
from harness.temporal.interpreter.nodes.consultation_verify import (
    interpreter_consultation_inferential_sensors,
    interpreter_consultation_sensors,
)
from harness.temporal.interpreter.nodes.context_binding import interpreter_context_binding
from harness.temporal.interpreter.nodes.core import CORE_ACTIVITIES
from harness.temporal.interpreter.nodes.deliver import interpreter_deliver
from harness.temporal.interpreter.nodes.guardrail_check import interpreter_guardrail_check
from harness.temporal.interpreter.nodes.guards import GUARD_ACTIVITIES
from harness.temporal.interpreter.nodes.template_ref import interpreter_template_ref
from harness.temporal.interpreter.nodes.text_generate import interpreter_text_generate
from harness.temporal.interpreter.run_events import (
    EVENT_LOOP_ITERATION,
    EVENT_NODE_COMPLETED,
    EVENT_NODE_FAILED,
    EVENT_NODE_STARTED,
    RunEventProducer,
    build_run_event,
    loop_iteration_key,
    node_settled_key,
    node_started_key,
    run_completed_key,
)

# ---------------------------------------------------------------------------
# Seed node activities (Task 4/6's tests dispatch against these; adds
# the real summarization-palette activities alongside these, never in place of
# them — noop/passthrough stay as harness-owned smoke-test node types).
# ---------------------------------------------------------------------------


async def _record_and_flush(
    payload: NodeActivityInput, *, status: str, started: Any, error_code: str | None = None
) -> None:
    """One NODE trajectory step per node activity — reuses `_TrajectoryBatch` (Task 7).

    Best-effort by construction (`_TrajectoryBatch.flush()` swallows its own exceptions) —
    a trajectory/gateway outage never fails the node, matching the same posture every other
    harness activity already has for `report_progress`/`report_trajectory`.
    """
    batch = TrajectoryBatch(get_settings(), payload.trajectory)
    batch.record(
        step_type=STEP_NODE,
        name=payload.node_type,
        status=status,
        started=started,
        error_code=error_code,
    )
    await batch.flush()


@activity.defn(name="interpreter.noop")
async def interpreter_noop(payload: NodeActivityInput) -> NodeActivityResult:
    """Always succeeds; does nothing. The registry's simplest sanctioned node type.

    Accepts an optional ``config["raise_error"]`` flag so hermetic tests can exercise the
    DEGRADED path without a real multi-second Temporal timeout (an ActivityError from an
    application-raised exception is handled identically to one from a timeout by the
    workflow's per-node wrapper — see contracts/ example). An
    optional ``config["sleep_seconds"]`` (small, real wall-clock — activities are NOT
    time-skipped) lets a test hold this node in flight long enough to land a signal before the
    next stage starts, without inventing a second test-only activity.
    """
    started = _now()
    sleep_seconds = payload.config.get("sleep_seconds")
    if sleep_seconds:
        await asyncio.sleep(float(sleep_seconds))
    if payload.config.get("raise_error"):
        await _record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="simulated_failure"
        )
        raise RuntimeError(f"interpreter.noop: simulated failure for node {payload.node_id}")
    await _record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED")


@activity.defn(name="interpreter.passthrough")
async def interpreter_passthrough(payload: NodeActivityInput) -> NodeActivityResult:
    """Echoes its own config back as output. Used to prove fan-out nodes run independently."""
    started = _now()
    await _record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED", output=dict(payload.config))


# ---------------------------------------------------------------------------
# Graph boundary markers (palette-agnostic). `core.start`/`core.end` are the two
# node types the palette-independent structural rules WF-S-002/003/004/007 are
# written against; before they were registered, NO graph in ANY palette could
# satisfy them. They execute NOTHING — the whole point is that a marker is not
# work — but they must be dispatchable, because compile() refuses any graph
# containing an unimplemented node type, which would leave every graph
# unpublishable for a different reason. Same shape as noop, deliberately.
# ---------------------------------------------------------------------------


@activity.defn(name="interpreter.core_start")
async def interpreter_core_start(payload: NodeActivityInput) -> NodeActivityResult:
    """The graph's entry marker. Executes nothing; records one NODE trajectory step so a run
    trace shows where the walk began."""
    started = _now()
    await _record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED")


@activity.defn(name="interpreter.core_end")
async def interpreter_core_end(payload: NodeActivityInput) -> NodeActivityResult:
    """The graph's terminal marker. Executes nothing — in particular it is NOT a delivery or
    persistence step; whatever the graph produced was already written by its own
    `external_write` node before the walk reached here."""
    started = _now()
    await _record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED")


NODE_ACTIVITIES: list[Callable[..., Any]] = [
    interpreter_noop,
    interpreter_passthrough,
    # Graph boundary markers (palette-agnostic) — see above.
    interpreter_core_start,
    interpreter_core_end,
    # Summarization palette (/5) — see nodes/{context_binding,template_ref,
    # text_generate,guardrail_check,deliver}.py.
    interpreter_context_binding,
    interpreter_template_ref,
    interpreter_text_generate,
    interpreter_guardrail_check,
    interpreter_deliver,
    # STT palette — RETIRED (TASK-861 step 10 / TASK-867): no activity is served; see the
    # matching note in registry.py's NODE_REGISTRY.
    # Consultation palette — all 13 node types. consentGate/phiHop/hitlGate came from
    # (nodes/consultation.py); the other ten are the wrappers that complete the palette, grouped
    # by pipeline stage in nodes/consultation_{capture,nlp,compose,verify,persist}.py.
    interpreter_consultation_consent_gate,
    interpreter_consultation_capture_binding,
    interpreter_consultation_extract_entities,
    interpreter_consultation_bind_terminology,
    interpreter_consultation_phi_hop,
    interpreter_consultation_retrieve_evidence,
    interpreter_consultation_assemble_prompt,
    interpreter_consultation_synthesize,
    interpreter_consultation_sensors,
    interpreter_consultation_inferential_sensors,
    interpreter_consultation_persist_draft,
    interpreter_consultation_finalize_assurance,
    interpreter_consultation_hitl_gate,
    # R3's three missing capabilities (-W3) — nodes/consultation_realtime.py.
    # This list and `registry.py`'s NODE_REGISTRY are two SEPARATE hand-maintained lists: the
    # registry decides what the interpreter DISPATCHES, this decides what the worker SERVES. A
    # node in the first but not the second compiles, validates and passes the cross-language
    # parity guard, then fails at runtime with an unregistered-activity error. Nothing enforced
    # the agreement until `test_realtime_capability_nodes.py`'s
    # `test_every_registered_node_activity_is_served_by_the_worker`.
    interpreter_consultation_realtime_summary,
    interpreter_consultation_suggestions,
    interpreter_consultation_propose_corrections,
    # The endpoint stage — nodes/consultation_endpoint.py. Same two-list discipline
    # as the three above: `registry.py` decides what the interpreter DISPATCHES, this decides
    # what the worker SERVES, and a node in the first but not the second passes every static
    # check and then fails at runtime with an unregistered-activity error.
    interpreter_session_timeout,
    interpreter_summary_finalize,
    interpreter_feedback_capture,
    # The TARGET CATALOGUE (/DD-9) and the guards — lane A.
    # Spread from the module's own list rather than re-typed here, because this list and
    # `registry.py`'s NODE_REGISTRY are two SEPARATE hand-maintained lists (see the note above)
    # and a catalogue this size is exactly where a re-typed name goes missing. Every one of these
    # is a thin delegation to an engine already in this list; they are registered separately
    # because `NodeSpec.activity_name` is what the S-4 cross-check compares against, so a node
    # type needs an activity NAME of its own even when the body is shared.
    *AGENT_CATALOGUE_ACTIVITIES,
    *GUARD_ACTIVITIES,
    # the GENERIC (`agentic`) catalogue. Spread from the module's own list for the
    # same reason the two above are: this list and `registry.py`'s NODE_REGISTRY are two SEPARATE
    # hand-maintained lists, and a node in the registry but not here passes every static check --
    # including the cross-language parity guard -- then fails at runtime with an
    # unregistered-activity error.
    *AGENTIC_ACTIVITIES,
    # TASK-864 — the `core` vocabulary (nodes/core.py), including `interpreter.core_evaluate`,
    # the CEL activity `LoopWorkflow` calls for `until`. Same two-list discipline as above.
    *CORE_ACTIVITIES,
]

# ---------------------------------------------------------------------------
# Claim-check config loader (Task 5, S-2) — the ONLY place compiledConfig is
# dereferenced. The workflow body never calls claim_check directly.
# ---------------------------------------------------------------------------


@activity.defn(name="interpreter.load_config")
async def load_config(ref: ClaimCheckRef) -> CompiledWorkflowConfig:
    """Dereference + admit a compiledConfig blob. Fails LOUD on any admission violation.

    See contracts/ for the six-step admission sequence this performs
    (dereference, parse, formatVersion check, checksum verify, gates-empty check, structural
    bounds). A corrupt/invalid config must fail the run — never execute a partial graph.
    """
    settings = get_settings()
    store, _ = await open_store(settings.claim_check, ref)
    # ClaimCheckNotFound / ClaimCheckIntegrityError propagate unmodified — fail loud
    # (S-2's contract), never substitute an empty config.
    raw = await load_blob(ref, store=store)
    return parse_and_verify(raw)


# ---------------------------------------------------------------------------
# Run-event mirror — the CONTROL lane's one activity.
# ---------------------------------------------------------------------------

#: The attempt generation stamped into a node's idempotency key. The stage walk dispatches a
#: node exactly ONCE per run; Temporal's own activity retries happen inside that single
#: dispatch and are not a new generation, so a per-run constant is the truthful value here
#: rather than a counter nobody increments. (Loop-body nodes DO re-run per iteration, but the
#: stage walk never dispatches them — they carry `SKIPPED loop_body` and the loop owns them.)
NODE_ATTEMPT_GENERATION = 1

_RUN_EVENT_REDIS: Any | None = None
_RUN_EVENT_REDIS_BUILT = False


def run_event_producer() -> RunEventProducer:
    """One producer per worker process. Built lazily; a failure yields a no-op producer.

    Lazy because a worker must boot with Redis down (`redis_client.py`'s whole posture), and
    because `Redis.from_url` binds to the running event loop.

    PUBLIC on purpose: this is the DELTA lane's entry point for any node activity that
    streams — a token stream, and (lane B) STT/TTS audio. Call
    ``run_event_producer().emit_token_delta(...)`` from inside the activity, never from the
    workflow body, and never route a delta through a signal or an activity-per-chunk. Signals
    land in Temporal history, whose ceiling is 51,200 events / 50 MB per run, so a long
    deliberation streamed through Temporal dies mid-flight. ``test_task849_two_lane_split.py``
    MEASURES that this stays true.
    """
    global _RUN_EVENT_REDIS, _RUN_EVENT_REDIS_BUILT  # noqa: PLW0603 — process-wide singleton
    if not _RUN_EVENT_REDIS_BUILT:
        _RUN_EVENT_REDIS = build_run_event_redis(get_settings().redis_url)
        _RUN_EVENT_REDIS_BUILT = True
    return RunEventProducer(_RUN_EVENT_REDIS)


def _envelope_for(batch: RunEventBatch, spec: RunEventSpec) -> Any:
    """Turn one workflow-described fact into a conforming envelope ( recipes)."""
    node_id = spec.node_id or ""
    if spec.event_type == EVENT_NODE_STARTED:
        key = node_started_key(batch.run_id, node_id, NODE_ATTEMPT_GENERATION)
    elif spec.event_type in (EVENT_NODE_COMPLETED, EVENT_NODE_FAILED):
        key = node_settled_key(batch.run_id, node_id, NODE_ATTEMPT_GENERATION)
    elif spec.event_type == EVENT_LOOP_ITERATION:
        key = loop_iteration_key(batch.run_id, node_id, spec.iteration or 0)
    else:
        key = run_completed_key(batch.run_id)

    payload: dict[str, Any] = {}
    if spec.node_id is not None:
        payload["nodeId"] = spec.node_id
    if spec.node_type is not None:
        payload["nodeType"] = spec.node_type
    if spec.stage_index is not None:
        payload["stageIndex"] = spec.stage_index
    if spec.status is not None:
        payload["status"] = spec.status
    if spec.reason is not None:
        payload["reason"] = spec.reason
    if spec.iteration is not None:
        payload["iteration"] = spec.iteration

    return build_run_event(
        tenant_id=batch.tenant_id,
        run_id=batch.run_id,
        event_type=spec.event_type,
        idempotency_key=key,
        payload=payload,
    )


@activity.defn(name="interpreter.emit_run_events")
async def emit_run_events(batch: RunEventBatch) -> int:
    """Mirror one stage boundary's control events onto the run's Redis Stream.

    Returns the number actually written — 0 is a normal outcome, not a failure. This
    activity NEVER raises: the run's durable record is Temporal history, and a mirror that
    could fail a clinical run would have inverted which of the two lanes matters. The
    workflow additionally catches `ActivityError` around every call, so even a scheduling
    or timeout failure cannot reach the walk.

    Envelope construction is inside the guard on purpose. `AsyncEnvelope` validates on
    construction — a run started with a non-UUID `tenantId` (the fixture-capture scripts and
    several older test harnesses do exactly that) raises there, and ONE malformed spec must
    not take the rest of the batch down with it.
    """
    envelopes = []
    for spec in batch.events:
        try:
            envelopes.append(_envelope_for(batch, spec))
        except Exception as exc:  # noqa: BLE001 — see the docstring: this never raises
            activity.logger.warning(
                "harness.run_events.envelope_rejected "
                f"run_id={batch.run_id} event_type={spec.event_type} error={exc}"
            )
    return len(await run_event_producer().emit_many(envelopes))


# Registered on the worker alongside DOCUMENT_ACTIVITIES/LOOP_ACTIVITIES/
# REASONING_ACTIVITIES — the interpreter's own activity list.
INTERPRETER_ACTIVITIES: list[Callable[..., Any]] = [
    *NODE_ACTIVITIES,
    load_config,
    emit_run_events,
]
