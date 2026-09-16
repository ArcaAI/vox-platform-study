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
from harness.services.api_client import ApiServiceError
from harness.temporal.activities import (
    STATUS_ERROR,
    STATUS_OK,
    STEP_NODE,
    _api_client,
    _now,
)
from harness.temporal.activities import (
    _TrajectoryBatch as TrajectoryBatch,  # reuse, never a second emitter (Task 7) — noqa: SLF001
)
from harness.temporal.claim_check import ClaimCheckRef, load_blob, open_store
from harness.temporal.interpreter.action_catalogue import ACTION_CATALOGUE
from harness.temporal.interpreter.compiled_config import CompiledWorkflowConfig, parse_and_verify
from harness.temporal.interpreter.models import (
    LiveOutputsRequest,
    LiveOutputsResult,
    NodeActivityInput,
    NodeActivityResult,
    RunEventBatch,
    RunEventSpec,
)
from harness.temporal.interpreter.nodes.core import CORE_ACTIVITIES
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


#: The activity callables the seventeen catalogue actions run, derived FROM the catalogue rather
#: than listed by hand — the list and the catalogue cannot disagree if one is computed from the
#: other. Order is the catalogue's, de-duplicated (`guard.phi` and `consultation.phiHop` share an
#: activity), so the served set stays stable across runs.
ACTION_ACTIVITIES: list[Callable[..., Any]] = list(
    dict.fromkeys(spec.activity for spec in ACTION_CATALOGUE.values())
)

NODE_ACTIVITIES: list[Callable[..., Any]] = [
    # TASK-893 Phase 4 — the served set is now exactly what the interpreter DISPATCHES:
    #   * the eleven `core.*` node types (`registry.py`'s NODE_REGISTRY), plus
    #   * the seventeen ACTIONS behind `core.action` (`action_catalogue.py`), which
    #     `interpreter_core_action` calls through `spec.activity`.
    # `CORE_ACTIVITIES` also carries `interpreter.core_evaluate`, the CEL activity `LoopWorkflow`
    # schedules for `until` — dispatched by a WORKFLOW rather than by a node spec, which is why
    # it is served even though no NodeSpec names it.
    #
    # The two-list discipline this comment used to spell out is unchanged and is now MACHINE
    # CHECKED in both directions by `test_realtime_capability_nodes.py`'s
    # `test_every_registered_node_activity_is_served_by_the_worker`: `NODE_REGISTRY` +
    # `ACTION_CATALOGUE` decide what is dispatched, this list decides what the worker serves, and
    # an entry in the first but not the second passes every static check and then fails at
    # runtime with an unregistered-activity error.
    #
    # Everything else that used to be served here went with its node type. The activities the
    # SEVENTEEN actions run are spread from `ACTION_ACTIVITIES` below rather than re-typed, for
    # the reason a hand-typed catalogue of that size always gives: a re-typed name goes missing.
    *ACTION_ACTIVITIES,
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
# TASK-932 R-16a — the LIVE HANDOFF loader.
# ---------------------------------------------------------------------------


@activity.defn(name="interpreter.load_live_outputs")
async def load_live_outputs(request: LiveOutputsRequest) -> LiveOutputsResult:
    """Read the LIVE lane's final per-node outputs for a consultation-bound run.

    The counterpart of ``load_config``: the ONLY place the live handoff is dereferenced, and
    like it, all I/O lives here rather than in the workflow body.

    Failure posture is deliberately the opposite of ``load_config``'s. A config that will not
    load must fail the run — executing a partial graph is worse than not executing it. A live
    handoff that will not load is a TRANSIENT condition of a session that is still in progress
    or of a gateway that is briefly unreachable, and the workflow polls: so a gateway error is
    reported as ``ended=False`` (ask again later) rather than raised, and only the workflow's own
    bound ends the wait. Nothing is ever fabricated — an empty ``outputs`` with ``ended=True`` is
    the gateway saying "the live lane produced nothing", which keeps the pre-existing
    ``no_bound_text`` degrade for a consultation that never recorded.
    """
    settings = get_settings()
    try:
        raw = await _api_client(settings).live_handoff(
            request.consultation_id,
            tenant_id=request.tenant_id,
            run_id=request.run_id,
            node_ids=list(request.node_ids),
        )
    except ApiServiceError as exc:
        # PHI-safe: the run/consultation ids and the status only — never the note.
        activity.logger.warning(
            "harness.interpreter.live_handoff_unavailable "
            f"run_id={request.run_id} consultation_id={request.consultation_id} error={exc}"
        )
        return LiveOutputsResult(ended=False)
    try:
        return LiveOutputsResult.model_validate(raw)
    except ValueError as exc:
        activity.logger.warning(
            "harness.interpreter.live_handoff_malformed "
            f"run_id={request.run_id} consultation_id={request.consultation_id} error={exc}"
        )
        return LiveOutputsResult(ended=False)


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
    if spec.node_count is not None:
        payload["nodeCount"] = spec.node_count
    if spec.failed_node_count is not None:
        payload["failedNodeCount"] = spec.failed_node_count
    if spec.degraded_node_count is not None:
        payload["degradedNodeCount"] = spec.degraded_node_count
    if spec.skipped_node_count is not None:
        payload["skippedNodeCount"] = spec.skipped_node_count

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
    load_live_outputs,
    emit_run_events,
]
