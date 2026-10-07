"""The WorkflowInterpreter workflow (Task 6).

Deterministic, platform-owned. Walks a published WorkflowDefinition version's compiledConfig
(dereferenced via claim-check, S-2) stage by stage, dispatching each node to a code-owned,
registry-sanctioned activity (S-4). See
for the full
contract this file implements.

Determinism checklist (enforced by review, not by a linter): no ``datetime.now``, no ``random``,
no ``uuid4``, no ``os.environ``, no ``httpx``, no DB, no file I/O in this module. Every side
effect goes through ``workflow.execute_activity``.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterable
from datetime import datetime, timedelta
from typing import Any, Literal

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError

from harness.temporal.workflow_ids import (
    INTERPRETER_WORKFLOW_ID_PREFIX as _INTERPRETER_WORKFLOW_ID_PREFIX,
)

with workflow.unsafe.imports_passed_through():
    from harness.temporal.interpreter import caps, guardrail_hold, payload_refs
    from harness.temporal.interpreter.activities import (
        emit_run_events,
        load_config,
        load_live_audio_state,
        load_live_outputs,
        read_consultation,
        resolve_context_path,
    )
    from harness.temporal.interpreter.compiled_config import (
        CompiledGate,
        CompiledNode,
        CompiledStage,
        CompiledWorkflowConfig,
    )
    from harness.temporal.interpreter.core_loop_workflow import (
        LoopWorkflow,
        core_loop_workflow_id,
    )
    from harness.temporal.interpreter.data_contract import (
        CONSULTATION_READ_FAILED,
        ROUTER_NODE_TYPES,
        BindingScope,
        effective_settings,
        end_wired_fields,
        resolve_bindings,
    )
    from harness.temporal.interpreter.data_contract import (
        nest_consultation_paths as _nest_paths,
    )
    from harness.temporal.interpreter.gate_workflow import (
        ConsultationGateWorkflow,
        gate_workflow_id,
    )
    from harness.temporal.interpreter.models import (
        CancelSignal,
        ConsultationGateInput,
        ConsultationGateResult,
        ConsultationReadRequest,
        ConsultationReadResult,
        ContextPathRequest,
        ContextPathResult,
        CoreLoopBounds,
        CoreLoopInput,
        CoreLoopResult,
        GuardrailHold,
        GuardrailHoldState,
        GuardrailResolutionSignal,
        InterpreterInput,
        InterpreterResult,
        InterpreterStateQueryResult,
        LiveAudioStateRequest,
        LiveOutputsRequest,
        LiveOutputsResult,
        NodeActivityInput,
        NodeActivityResult,
        NodeResult,
        NodeStatus,
        ReviewGateInput,
        ReviewGateResult,
        RunEventBatch,
        RunEventSpec,
        RunLimits,
        RunStatus,
        StageResult,
    )
    from harness.temporal.interpreter.nodes._shared import MISSING, resolve_dotted_path
    from harness.temporal.interpreter.registry import (
        CORE_LOOP_NODE_TYPE,
        CORE_REVIEW_NODE_TYPE,
        NODE_REGISTRY,
        effective_spec,
        output_keys_for,
    )
    from harness.temporal.interpreter.review_workflow import (
        ReviewGateWorkflow,
        review_gate_workflow_id,
    )
    from harness.temporal.interpreter.run_events import (
        EVENT_GUARDRAIL_NOTICE,
        EVENT_NODE_COMPLETED,
        EVENT_NODE_FAILED,
        EVENT_NODE_STARTED,
        EVENT_RUN_COMPLETED,
        EVENT_RUN_PAUSED,
        EVENT_RUN_STARTED,
    )
    from harness.temporal.models import TrajectoryContext

_CONFIG_LOAD_TIMEOUT = timedelta(seconds=30)
_CONFIG_LOAD_RETRY = RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=1))

# Stride between per-node trajectory-seq bases — same idiom as `workflows.py`'s
# `_SEQ_STRIDE`: a workflow-owned monotonic counter stands in for a clock/UUID
# (determinism). A `core.agent` node emits TWO steps (the NODE step plus the LLM_CALL step the
# usage ledger bills from — F14, `nodes/_shared.record_generation_and_flush`); the stride is the
# headroom that keeps every node's steps inside its own base without claiming a
# wall-clock-derived value.
#
# TASK-959 §6.2 — widened 4 → 16 (the value `workflows.py` has always used) because a node now
# also records ONE step per fallback candidate that was TRIED and lost. At 4 the headroom was
# two such attempts, and the third would have landed on the NEXT node's base — a colliding
# `harness:step:<sessionId>:<runId>:<seq>` silently replaces a different node's step, which is
# a worse failure than a dropped sample. `nodes/_shared.MAX_FAILED_ATTEMPT_STEPS` mirrors this
# value (it cannot import it: `workflow.py` imports `_shared`), pinned by a parity test.
#
# REPLAY: this is a value inside an ACTIVITY INPUT, not a workflow command, so the recorded
# command sequence is unchanged and no `workflow.patched` era is needed — the same argument
# `TrajectoryContext`'s own docstring makes for being threaded additively. An in-flight run
# resumes with the new stride from whichever node it had not yet reached, and the new bases
# (16·k) are strictly above every seq the old ones (4·j, j < k) already emitted, so ordering
# stays monotonic and no key is reused.
_SEQ_STRIDE = 16

# Deterministic, idempotent-on-start workflow id — mirrors
# `consultation_loop_workflow_id` (workflows.py:1623-1625). DEFINED in the leaf module
# `temporal/workflow_ids.py` and re-exported here, so the compute meter can read the
# prefix off the ACTIVITY path without importing this workflow module (TASK-957);
# every existing importer of this name is unaffected.
INTERPRETER_WORKFLOW_ID_PREFIX = _INTERPRETER_WORKFLOW_ID_PREFIX

# The patch marker for the HITL-gate command. Required by
# contracts/versioning.md rule 3: executing a gate adds a NEW command to the workflow body, which
# would change the command sequence for every replaying history if shipped ungated. The gate is
# guarded cheap-operand-first (`config.gates and workflow.patched(...)`), and the cheap operand is
# PROVABLY False on every pre-existing history: until this change, `parse_and_verify` refused any
# config whose `gates` was not `[]` (`gates_not_supported_v1`), so no admitted run can ever have
# carried one. `workflow.patched` is therefore never even called when replaying an old history —
# exactly what the idiom is for.
_GATE_PATCH = "task-731-hitl-gate"

# The patch marker for the run-event MIRROR. Third gate, same rule as the two
# above: `interpreter.emit_run_events` is a NEW `execute_activity` call in the shared per-stage
# path, so every history recorded before this change must keep replaying without it.
#
# Unlike the gate's, this one's cheap operand cannot be proven False from the config — the emit
# happens on EVERY stage boundary of EVERY graph. `workflow.patched` is therefore the only thing
# standing between this change and a non-determinism error on every in-flight clinical run, which
# is exactly the situation the idiom exists for. Recapture the replay fixture alongside it
# (`_capture_interpreter_replay_fixture.py`), per contracts/versioning.md rule 3.
_STREAM_PATCH = "task-849-run-event-stream"

# The emit is a MIRROR of state Temporal already holds, so it gets the cheapest possible
# envelope: one attempt, a short deadline, and a caller that swallows the failure. Retrying an
# observability write would spend a clinical run's latency budget re-sending a token nobody is
# waiting on any more.
_EMIT_TIMEOUT = timedelta(seconds=10)
_EMIT_RETRY = RetryPolicy(maximum_attempts=1)

# TASK-864 — the `core` vocabulary's patch marker. FOURTH gate, same rule: dispatching a
# `core.humanReview` as a `ReviewGateWorkflow` child and a `core.loop` as a `LoopWorkflow` child
# are NEW commands. The cheap operand (the node's TYPE) is provably False on every pre-existing
# history — no history recorded before this ticket carries a `core.*` node, because the types did
# not exist — so `workflow.patched` is consulted only for a graph that actually uses them. The
# branch gating and the run context add NO command (a skip removes one only on graphs that carry
# `branchGuards`, which likewise predate nothing), so they need no marker.
_CORE_PATCH = "task-864-core-vocabulary"

# TASK-932 R-16a — the LIVE HANDOFF's patch marker. FIFTH gate, and the one whose cheap operand
# is NOT provably False on an existing history: a consultation-bound run whose graph binds a
# `realtime` node's output into a durable one is exactly what every seeded consultation graph is,
# so `workflow.patched` is what stands between this change and a non-determinism error on every
# in-flight clinical run. Recapture the replay fixture alongside it
# (`_capture_interpreter_replay_fixture.py`), per contracts/versioning.md rule 3.
_LIVE_HANDOFF_PATCH = "task-932-live-handoff"

# TASK-946 D3 / OD-4 — the EMPTY-GATE marker. SIXTH gate, and it exists because this change
# REMOVES a command: a `core.humanReview` whose bound payload is empty no longer starts its
# `ReviewGateWorkflow` child. An execution recorded before this ticket DID start one — that is
# precisely the defect — so replaying it through the new code without a marker fails the
# workflow task with a non-determinism error and wedges the run at the gate it is parked on.
# The cheap operand (the payload being empty) is checked FIRST, so a gate that has something to
# review never consults the marker and never records one.
_REVIEW_SKIP_PATCH = "task-946-review-skip-empty-payload"

# TASK-1038 R-5 — the node retry policy honours the COMPILED backoff and names the failures a
# retry cannot fix. A retry policy is an activity OPTION (the recorded command sequence does not
# change), but it changes how often a refused call is re-sent, so it is a behaviour change and
# rides behind its own marker like every other one. A history recorded before it keeps the old
# attempts-only policy on replay.
_RETRY_PATCH = "task-1038-node-retry-policy"

#: Failure TYPES no retry can change, matched by Temporal on the failure's recorded type — the
#: exception's class name, or an ``ApplicationError``'s ``type``. Retrying them re-sends the
#: identical input to get the identical refusal, spending the node's whole timeout budget on it.
#:
#: * ``ApiClientError`` — a gateway 4xx other than 408/429 (``services/api_client.py`` already
#:   classifies those two as retryable ``ApiServiceError``).
#: * ``ValidationError`` — a pydantic schema/validation failure (input or answer shape).
#: * ``ContextSchemaViolation`` / ``OutputSchemaViolation`` — ``core.trigger`` / ``core.output``
#:   refusing a payload against the graph's declared schema.
#: * ``ClaimCheckIntegrityError`` — a stored blob whose hash does not match its reference.
#: * ``PAYLOAD_TOO_LARGE`` — an activity input or result above the safe Temporal payload size.
NON_RETRYABLE_NODE_ERROR_TYPES: tuple[str, ...] = (
    "ApiClientError",
    "ValidationError",
    "ContextSchemaViolation",
    "OutputSchemaViolation",
    "ClaimCheckIntegrityError",
    "PAYLOAD_TOO_LARGE",
)

# TASK-1038 D-H — a DEGRADED node's OUTPUT is kept. Storing it changes what every downstream node
# binds, and through `_is_empty_review_payload` whether a review child is started at all, so it
# is gated. The cheap operand (the degraded result CARRIES an output) is checked first.
_KEEP_DEGRADED_PATCH = "task-1038-keep-degraded-output"

# TASK-1038 R-3 — payloads by REFERENCE. The run payload travels once per activity input (or as
# a claim-check reference once the trigger offloaded it) and the run context names it
# symbolically; an activity input above the run's ceiling fails the run by name before anything
# is scheduled; a `core.loop` whose `over` path crosses a reference resolves it through a NEW
# activity. All three change what is sent or scheduled, so they share one marker.
_PAYLOAD_REFS_PATCH = "task-1038-payload-refs"

#: The run-level failure name for an activity input over the run's ceiling. Also an
#: `ApplicationError` type a node activity raises for an oversized RESULT.
PAYLOAD_TOO_LARGE = "PAYLOAD_TOO_LARGE"

# TASK-1038 R6 / TASK-1036 (lane B1) — RUN PROTOCOL v2 for this run. Decided ONCE, right after
# the config loads, so one run never mixes the two shapes. Under it the walk emits `run.started`
# (a NEW `emit_run_events` command at the run's start — which is why it is gated), stamps the
# v2 facts (durations, tokens, labels, retention, error codes) on the specs it already emits, and
# hands every node activity the v2 fields (`protocol`, `bindings`, `delivery`, `run_fields`, …)
# that turn on its admin debug events, public deltas and the dual `nodes.*` scope.
_PROTOCOL_V2_PATCH = "task-1038-run-protocol-v2"

# TASK-1036 §9.2 — a node's compiled `bindings` decide what it is handed. Cheap operand first: a
# node CARRYING bindings is impossible in any history recorded before this marker existed (the
# interpreter's `extra="forbid"` refused every such artifact at `load_config`), so the marker is
# consulted only for a config that actually uses them. Without `bindings` the edge-port behaviour
# is unchanged, byte for byte.
_BINDINGS_PATCH = "task-1036-bindings"

# TASK-1036 §9.3 (OD-30) — declared `consultation.*` reads: one NEW activity per node with
# node-start reads (just before it is dispatched), and one per node with run-start reads (before
# the walk). Cheap operand first, as for bindings: no prior history carries `consultationReads`.
_CONSULTATION_READS_PATCH = "task-1036-consultation-reads"

_CONSULTATION_READ_TIMEOUT = timedelta(seconds=30)
_CONSULTATION_READ_RETRY = RetryPolicy(
    maximum_attempts=3, non_retryable_error_types=["ApiClientError", "ValidationError"]
)

# TASK-1038 lane E3 — `runStart` reads declared by LOOP-BODY nodes (`config.loops[*].body`). The
# OD-30 walk above read `config.stages` only, so a body node's run-start reads were never taken and
# its `consultation.*` bindings resolved to nothing. They are now read once before the walk, AFTER
# the top-level reads, and threaded into the loop child. New `read_consultation` activities, so
# gated — cheap operand first: consulted only for a graph whose loop bodies declare such reads.
_LOOP_RUN_START_READS_PATCH = "task-1038-loop-run-start-reads"

_CONTEXT_PATH_TIMEOUT = timedelta(seconds=60)
_CONTEXT_PATH_RETRY = RetryPolicy(
    maximum_attempts=3, non_retryable_error_types=["ClaimCheckIntegrityError"]
)

# TASK-1038 R-4 — cancel stops IN-FLIGHT work. The `cancel` signal used to set a flag the walk
# read only BETWEEN stages: a running node (an LLM generation, a review child parked for an hour)
# kept running while the run already read as cancelled. Under this marker a stage is a RACE between
# its nodes settling and the run being cancelled (or timing out, below): the losers' activities
# and children are cancelled. Racing adds a `wait_condition` and, on interruption, cancel
# commands, so it is gated — decided ONCE per run, at its start, so one run never mixes the two
# shapes.
_CANCEL_PATCH = "task-1038-cancel-in-flight"

# TASK-1038 D-B — the run's compute budget (`caps.maxTotalSeconds`, clamped tighten-only) as a
# deadline the walk enforces on itself: a timer the stage race watches. A new command (the timer),
# so gated, and decided once per run like the cancel race.
_DEADLINE_PATCH = "task-1038-run-deadline"

#: How long the walk parks between two handoff reads. A timer plus one short activity per
#: interval: a 30-minute consultation costs ~120 polls, well inside Temporal's 51,200-event
#: ceiling, and the finalize starts within one interval of the clinician pressing stop.
_LIVE_HANDOFF_POLL_INTERVAL = timedelta(seconds=15)

#: The outer bound on the wait. A consultation still recording after this has outlived any
#: session this platform documents; the walk proceeds with whatever the handoff last reported,
#: which for an empty one is the pre-existing `no_bound_text` degrade. NEVER an infinite wait:
#: a workflow that can park forever is one nobody can reason about.
_LIVE_HANDOFF_MAX_WAIT = timedelta(seconds=caps.LIVE_HANDOFF_MAX_WAIT_SECONDS)

_LIVE_OUTPUTS_TIMEOUT = timedelta(seconds=30)
#: One retry. The poll loop IS the retry policy — a read that fails is asked again in 15s — so
#: spending a second attempt inside the activity buys only latency.
_LIVE_OUTPUTS_RETRY = RetryPolicy(maximum_attempts=1)

# TASK-1042 OD-4a — the LIVE AUDIO wait's patch marker. A run bound to a live STT session (C7
# `liveAudio`) parks before its first stage until the session ends: NEW `execute_activity` and
# timer commands, so gated. Cheap operand FIRST (`inp.live_audio is not None`): the field did not
# exist before this marker, so no recorded history can carry one and `workflow.patched` is never
# consulted when replaying an old run.
_LIVE_AUDIO_PATCH = "task-1042-live-audio-wait"

# TASK-1050 W2f (README §9.8.1) — the GUARDRAIL HOLD's patch marker. A node whose generation
# guardrail REFUSED (a block, or the cloud pseudonymiser being down) no longer just degrades: the
# walk publishes `guardrail.notice` + `run.paused` (NEW `emit_run_events` commands), parks on the
# `guardrail_resolution` signal with a timer (NEW), and re-executes ONLY that node (a NEW
# `execute_activity`). Cheap operand FIRST — the recorded activity result CARRIES a
# `guardrail_hold`, a field that did not exist before this marker — so `workflow.patched` is never
# consulted when replaying a history recorded before it. In-flight harness workflows are DRAINED
# before this deploys all the same (rule 06 §Temporal; `docs/operations/deprecation-register.md`).
_GUARDRAIL_HOLD_PATCH = "task-1050-guardrail-hold"

#: The run-level failure name of a hold that ended without a resolution (`run.failed`'s code).
GUARDRAIL_BLOCKED = "GUARDRAIL_BLOCKED"

#: How long the walk parks between two state reads. One short activity plus one timer per
#: interval: the 3600 s ceiling costs ~720 polls (~4,300 history events), well inside Temporal's
#: 51,200-event ceiling, and the graph starts within 5 s of the integrator closing the session.
_LIVE_AUDIO_POLL_INTERVAL = timedelta(seconds=5)
_LIVE_AUDIO_STATE_TIMEOUT = timedelta(seconds=10)
#: One attempt. The poll loop IS the retry policy — a failed read is asked again in 5 s.
_LIVE_AUDIO_STATE_RETRY = RetryPolicy(maximum_attempts=1)

# The parent-owned duration bound's own reason. It is NOT a `LoopStopReason`, because the loop
# child never produces it: the child is cancelled by the parent's timer and never gets to say
# why. Spelled identically to the contract's own field name so an operator reading a trajectory
# sees the same word the graph author wrote.
_LOOP_DURATION_REASON = "max_duration_seconds"


def _delivery_plan(config: CompiledWorkflowConfig) -> dict[str, dict[str, Any]]:
    """OD-24 — per node, what reaches the PUBLIC plane (pure).

    A node wired into End (a `core.output`'s compiled bindings, else its legacy edges resolved to
    the producer's output key) publishes the wired fields; a node flagged `stream` publishes
    everything it declares and streams its text. Nodes absent here reach the admin trace only.
    """
    nodes = {node.node_id: node for stage in config.stages for node in stage.nodes}
    wired: dict[str, set[str]] = {}
    for node in nodes.values():
        if node.type != "core.output":
            continue
        legacy: list[tuple[str, str | None]] = []
        for binding in node.inputs:
            producer = nodes.get(binding.from_node_id)
            keys = output_keys_for(producer.type, producer.config) if producer else None
            if keys is not None and binding.from_port in keys:
                legacy.append((binding.from_node_id, keys[binding.from_port]))
        found = end_wired_fields(list(node.bindings.values()) if node.bindings else None, legacy)
        for node_id, fields in found.items():
            wired.setdefault(node_id, set()).update(fields)
    plan: dict[str, dict[str, Any]] = {}
    for node in nodes.values():
        stream = node.config.get("stream") is True
        if stream or node.node_id in wired:
            plan[node.node_id] = {
                "publicFields": sorted(wired.get(node.node_id, set())),
                "stream": stream,
            }
    return plan


def _run_start_pending(stages: Iterable[CompiledStage]) -> list[tuple[str, list[str]]]:
    """`(nodeId, sorted runStart paths)` for every node in ``stages`` that declares any (pure)."""
    return [
        (node.node_id, sorted({r.path for r in node.consultation_reads if r.at == "runStart"}))
        for stage in stages
        for node in stage.nodes
        if any(r.at == "runStart" for r in node.consultation_reads)
    ]


def _consultation_id_of(inp: InterpreterInput) -> str | None:
    if inp.subject is not None and inp.subject.consultation_id:
        return inp.subject.consultation_id
    return _opt_str(inp.payload.get("consultationId"))


def interpreter_workflow_id(run_id: str) -> str:
    """The deterministic interpreter workflow id for a run (pure)."""
    return f"{INTERPRETER_WORKFLOW_ID_PREFIX}{run_id}"


def _opt_str(value: Any) -> str | None:
    """A non-empty string, or None. Pure."""
    return value if isinstance(value, str) and value else None


def _run_doctor_id(inp: InterpreterInput) -> str | None:
    """TASK-957 F-8 — the clinician this run acts FOR, for the trajectory context.

    Read from ``subject`` and NOWHERE else. ``RunSubject`` exists because ``payload`` cannot be
    trusted to carry identity — the exposure plane forwards a caller's ``input`` into ``payload``
    verbatim — so reaching into ``payload["userId"]`` here would let a caller stamp an arbitrary
    clinician onto a billing record. ``None`` is a real answer (an unbound exposure-plane run has
    no clinical subject, and a bound one need not name a user), and it is the answer: a guessed
    identity on a ledger row is worse than an absent one.

    Pure and deterministic — a read of the workflow's own input, safe in the workflow body.
    """
    return inp.subject.user_id if inp.subject is not None else None


def _configured_realtime(node: CompiledNode) -> bool:
    """TASK-864 — lane is per INSTANCE on `core.agent`/`core.action` (`execution.lane`), no
    longer only per type. Pure read of the compiled config."""
    if node.type not in ("core.agent", "core.action"):
        return False
    execution = node.config.get("execution")
    return isinstance(execution, dict) and execution.get("lane") == "realtime"


def _has_live_owner(inp: InterpreterInput) -> bool:
    """Whether a LIVE executor owns this run's realtime nodes — i.e. the run is consultation-bound.

    TASK-930 D-1. The realtime lane is driven by `LiveDocumentationService.flush` inside a
    consultation's live session; it has no other entry point. So a run with a clinical subject may
    have its `realtime` nodes executed by that lane, and a run without one never will.

    Reads BOTH channels for the same reason `_run_gate` reads `payload`: `subject` is the typed
    field the dispatcher sets, and `sanitize_run_payload` re-stamps the same identity into the
    payload before the workflow starts, so the two cannot disagree — but a history recorded before
    `subject` existed carries only the payload copy, and replaying it must reach the same verdict.

    Pure: a plain read of the workflow's own input, safe inside the workflow body.
    """
    if inp.subject is not None:
        return True
    payload = inp.payload if isinstance(inp.payload, dict) else {}
    return bool(payload.get("consultationId"))


#: Ceiling for a formatted activity-error reason. Long enough for a provider's own message,
#: short enough that a reason line stays a line — a node result is a REPORT, not a log sink.
_ACTIVITY_REASON_MAX_CHARS = 320


def _activity_error_reason(error: BaseException) -> str:
    """``activity_error[: <Type>[: <message>]]`` — the cause of an ``ActivityError``, bounded.

    PURE, and deliberately so: this runs inside the workflow body, where the same failure must
    format to the same string on the original run and on every replay. It reads only what the
    failure converter already put on the exception — no clock, no environment, no payloads (an
    activity's arguments never reach here, so nothing carrying PHI or a credential can).

    A typed ``ApplicationError`` names the activity's own exception class (``TextServiceError``,
    ``ApiServiceError``, …); a ``TimeoutError`` names WHICH timeout fired. Anything else falls
    back to the cause's class name.
    """
    cause = error.__cause__
    if cause is None:
        return "activity_error"

    declared = getattr(cause, "type", None)
    if isinstance(declared, str) and declared:
        kind = declared
    else:
        kind = type(cause).__name__
        variant = getattr(declared, "name", None)
        if isinstance(variant, str) and variant:
            kind = f"{kind}({variant})"

    raw = getattr(cause, "message", None)
    message = " ".join(str(raw if isinstance(raw, str) else cause).split())
    if not message:
        return f"activity_error: {kind}"
    reason = f"activity_error: {kind}: {message}"
    if len(reason) <= _ACTIVITY_REASON_MAX_CHARS:
        return reason
    return reason[: _ACTIVITY_REASON_MAX_CHARS - 3] + "..."


def _oversized_input_reason(activity_input: NodeActivityInput, limits: RunLimits) -> str | None:
    """``PAYLOAD_TOO_LARGE: …`` when the input would exceed the run's ceiling, else ``None``.

    Pure and deterministic: the size of the input's own JSON encoding (what the pydantic data
    converter puts on the wire, to within its envelope), against a ceiling recorded on the run's
    input.
    """
    # The TASK-1036/1038 fields are excluded while they are unset, so an input recorded before
    # they existed measures EXACTLY what it measured then — the size decides whether an activity
    # is scheduled at all, so a few bytes of new nulls must never flip a replayed decision.
    unset = {name for name in _V2_INPUT_FIELDS if getattr(activity_input, name) is None}
    size = len(activity_input.model_dump_json(exclude=unset).encode("utf-8"))
    ceiling = limits.activity_input_max_bytes
    if size <= ceiling:
        return None
    return (
        f"{PAYLOAD_TOO_LARGE}: the activity input for node {activity_input.node_id!r} "
        f"({activity_input.node_type}) is {size} bytes > {ceiling}"
    )


#: `NodeActivityInput` fields added by TASK-1036/1038 (all optional; `None` = unset).
_V2_INPUT_FIELDS = (
    "protocol",
    "bindings",
    "delivery",
    "consultation",
    "run_fields",
    "event_scope",
    "output_offload_min_bytes",
    # TASK-1050 W2f — set only on a node re-run after a guardrail hold.
    "guardrail_override",
)


def _node_retry_policy(node: CompiledNode, max_attempts: int) -> RetryPolicy:
    """TASK-1038 R-5 — the retry policy a node's activity is scheduled with (pure).

    Honours the COMPILED backoff (``retry.initialIntervalSeconds`` / ``retry.backoffCoefficient``,
    already clamped by the TypeScript compiler) and names the deterministic failures that must not
    be retried (:data:`NON_RETRYABLE_NODE_ERROR_TYPES`). A value Temporal would reject (a
    non-positive interval, a coefficient below 1) falls back to Temporal's own default for that
    field rather than failing the workflow task.
    """
    initial = node.retry.initial_interval_seconds
    coefficient = node.retry.backoff_coefficient
    return RetryPolicy(
        maximum_attempts=max_attempts,
        initial_interval=timedelta(seconds=initial) if initial > 0 else timedelta(seconds=1),
        backoff_coefficient=coefficient if coefficient >= 1 else 2.0,
        non_retryable_error_types=list(NON_RETRYABLE_NODE_ERROR_TYPES),
    )


def _is_empty_review_payload(payload: dict[str, Any]) -> bool:
    """Whether a `core.humanReview`'s bound payload gives a clinician NOTHING to decide on.

    PURE, and it runs inside the workflow body, so it reads only the already-deserialised bound
    inputs — the same values on the original run and on every replay.

    True when the payload has no keys at all (nothing upstream bound anything — a DEGRADED
    `core.agent` stores no output, which is the shape the 2026-09-10 trials hit) or when every
    value it does carry is absent or empty. `None`, `""`, `{}`, `[]` and an empty tuple/set are
    nothing; **`0` and `False` are ANSWERS** and keep the gate open, which is why this is a
    length test on the container types rather than a truthiness test — a gate that hides a
    legitimate zero from a clinician is the same class of defect as one that shows them nothing.

    It does not recurse. `{"sections": {}}` is a note the generator SHAPED, and whether its
    contents satisfy the graph is `core.output`'s schema check to make; the interpreter refuses
    the gate only where it can be certain, which is that nothing was bound or what was bound is
    empty.
    """
    for value in payload.values():
        if value is None:
            continue
        if isinstance(value, (str, bytes, list, tuple, set, dict)) and len(value) == 0:
            continue
        return False
    return True


def _settled_node_counts(stages: list[StageResult]) -> tuple[int, int, int, int]:
    """``(nodeCount, failedNodeCount, degradedNodeCount, skippedNodeCount)`` across every
    settled node in `stages` — including the HITL gate, which `run()` appends as one more
    `StageResult` after the walk. PURE: it only re-counts statuses the walk already settled and
    already appended to `self._stages`, so it is safe to call from workflow code."""
    node_count = 0
    failed_node_count = 0
    degraded_node_count = 0
    skipped_node_count = 0
    for stage in stages:
        for node in stage.nodes:
            node_count += 1
            if node.status == "FAILED":
                failed_node_count += 1
            elif node.status == "DEGRADED":
                degraded_node_count += 1
            elif node.status == "SKIPPED":
                skipped_node_count += 1
    return node_count, failed_node_count, degraded_node_count, skipped_node_count


@workflow.defn(name="WorkflowInterpreter")
class WorkflowInterpreter:
    """Linear stage walk + single-level fan-out with an all-settled join. Nothing else (v1)."""

    def __init__(self) -> None:
        self._run_id = ""
        self._status: RunStatus | Literal["RUNNING"] = "RUNNING"
        self._stages: list[StageResult] = []
        self._cancelled = False
        self._cancel_reason: str | None = None
        self._seq = 0
        # Workflow-owned cache of completed nodes' own `NodeActivityResult.output`, keyed by
        # `node_id` — see `NodeActivityInput.bound_inputs`'s docstring for the
        # full rationale). Pure Python dict state built from already-deterministic activity
        # results — no wall-clock/random/I/O — so it is replay-safe exactly like `self._stages`.
        # A node in stage N can only bind from a node in stage < N (the compiler's topological
        # stage partitioning already guarantees this), so same-stage fan-out nodes never race
        # each other reading/writing this cache.
        self._node_outputs: dict[str, dict[str, Any]] = {}
        # `node_id -> CompiledNode`, so a node referenced by id (an edge's producer) is
        # resolvable without a second traversal. Indexed once in `run`, alongside `_node_types`.
        self._nodes_by_id: dict[str, CompiledNode] = {}
        # `node_id -> node type`, built from the compiled config before the walk starts.
        # `_resolve_bound_inputs` needs the PRODUCER's type to look its declared output sockets up
        # in `NODE_REGISTRY`; `_node_outputs` alone is keyed by id and says
        # nothing about which node type produced the dict. Pure derived state, so it is replay-safe
        # for the same reason `_stages` is.
        self._node_types: dict[str, str] = {}
        # TASK-864 — the BRANCH handles each router/review node took, and the nodes skipped
        # because no guard of theirs fired (so their own successors are skipped too). Pure
        # derived state built from activity results, replay-safe like `_node_outputs`.
        self._taken_handles: dict[str, set[str]] = {}
        self._branch_skipped: set[str] = set()
        # TASK-864 — `compiledConfig.loops[]` by loop node id: the compiled BODY each
        # `core.loop` hands to its `LoopWorkflow` child.
        self._loops_by_id: dict[str, dict[str, Any]] = {}
        # TASK-932 R-16a — the nodes this walk handed to the LIVE executor (`realtime_lane`),
        # the one-shot handoff latch, and the context the handoff published. All three are pure
        # derived state built from recorded activity results, replay-safe like `_node_outputs`.
        self._live_skipped: set[str] = set()
        self._live_handoff_done = False
        self._live_context: dict[str, Any] = {}
        # TASK-1038 R-3 — a NAMED run-level failure (today only `PAYLOAD_TOO_LARGE`), carried
        # onto `workflow.run.completed` so a caller learns WHY, not only that it failed.
        self._run_failure_reason: str | None = None
        # TASK-1038 R-3 — whether the trigger published the run payload unchanged (decided once,
        # the first time an input is built after the trigger ran). Pure derived state.
        self._trigger_is_payload: bool | None = None
        # TASK-1038 R-4 / D-B — the bounded walk. `_bounded` is decided once, at the run's start
        # (`_CANCEL_PATCH`); the deadline fields are set only when `_DEADLINE_PATCH` is. The
        # budget clock is paused across DURABLE waits on a clinician (live handoff, review, gate),
        # which are not compute and carry bounds of their own. All workflow time.
        self._bounded = False
        self._timed_out = False
        self._budget_seconds: float | None = None
        self._clock_started: datetime | None = None
        self._paused_seconds = 0.0
        self._pause_depth = 0
        self._pause_started: datetime | None = None
        self._deadline_task: asyncio.Future[None] | None = None
        # TASK-1038 R6 / TASK-1036 (lane B1). All pure state built from the config, from
        # recorded activity results and from `workflow.now()`, replay-safe like `_node_outputs`.
        self._v2 = False
        self._run_started_at: datetime | None = None
        self._config_slug = ""
        self._config_version = 0
        self._delivery: dict[str, dict[str, Any]] = {}
        #: The agent task each `core.agent` reported (`NodeActivityResult.io`), for `outputs`.
        self._node_tasks: dict[str, str] = {}
        #: `(tokens in, tokens out)` per node, from its `io.usage`.
        self._node_usage: dict[str, tuple[int, int]] = {}
        #: Workflow time each node's dispatch took, in ms.
        self._node_duration_ms: dict[str, int] = {}
        #: What each router was handed on `in` (OD-19 — `nodes.<router>.outputs.input`).
        self._router_inputs: dict[str, Any] = {}
        #: Outputs a node the WALK produced itself (a review, a loop) declares, for the admin
        #: trace's per-node `output.data` (the activity envelope emits everyone else's).
        self._walk_outputs: dict[str, dict[str, Any]] = {}
        #: Run-start declared reads, by node id, and the node a failed one fails.
        self._run_start_reads: dict[str, dict[str, Any]] = {}
        self._run_start_read_failures: dict[str, str] = {}
        # TASK-1038 lane E3 — loop-body nodes whose run-start reads were taken (handed to the
        # loop child, never read by the top-level walk).
        self._loop_body_node_ids: set[str] = set()
        self._sources: list[str] = []
        # TASK-1050 W2f — the warn / unverified notices the nodes raised (for
        # `run.completed.guardrailNotices`), the holds the walk is parked on (by notice id, for the
        # `guardrail_holds` query and the signal's admission check) and the resolutions received.
        # Pure state from recorded results and recorded signals, replay-safe like `_node_outputs`.
        self._guardrail_notices: list[dict[str, Any]] = []
        self._pending_holds: dict[str, GuardrailHoldState] = {}
        self._hold_resolutions: dict[str, GuardrailResolutionSignal] = {}

    def _next_seq(self) -> int:
        """Allocate the next monotonic trajectory-seq BASE (strided; deterministic)."""
        seq = self._seq
        self._seq += _SEQ_STRIDE
        return seq

    @workflow.run
    async def run(self, inp: InterpreterInput) -> InterpreterResult:
        self._run_id = inp.run_id

        try:
            config = await workflow.execute_activity(
                load_config,
                inp.config_ref,
                start_to_close_timeout=_CONFIG_LOAD_TIMEOUT,
                retry_policy=_CONFIG_LOAD_RETRY,
            )
        except ActivityError:
            # The walk never starts, so nothing downstream would announce this run's end: say
            # FAILED on the event stream first (the completion watcher and the consultation's
            # governing-run marker read it), then fail exactly as before.
            await self._emit_run_completed(inp, "FAILED")
            raise

        # Index every node's TYPE before the walk. Gates are included: the compiler lifts them out
        # of `stages` into `gates`, so a graph that names one as an edge source would otherwise
        # look like an unregistered producer.
        for indexed_stage in config.stages:
            for indexed_node in indexed_stage.nodes:
                self._node_types[indexed_node.node_id] = indexed_node.type
                # A loop's body nodes are named by id, so the index IS the resolution:
                # no second traversal, and no chance of the two disagreeing.
                self._nodes_by_id[indexed_node.node_id] = indexed_node
        for indexed_gate in config.gates:
            self._node_types.setdefault(indexed_gate.node_id, "consultation.hitlGate")
        for indexed_loop in config.loops:
            self._loops_by_id[indexed_loop.node_id] = indexed_loop.body.model_dump(by_alias=True)

        # TASK-1038 R-4 / D-B — decided once, here, for the whole run.
        self._bounded = workflow.patched(_CANCEL_PATCH)
        if workflow.patched(_DEADLINE_PATCH):
            self._start_deadline(caps.run_budget_seconds(config.caps.max_total_seconds))

        self._config_slug = config.slug
        self._config_version = config.version_number
        # TASK-1036 §3.5 — the run's SOURCES: the compiled settings, else the legacy trigger
        # `kinds` (one release). Read, never gated on: exposure is the gateway's concern.
        self._sources = effective_settings(
            [(node.type, node.config) for stage in config.stages for node in stage.nodes],
            config.settings.model_dump() if config.settings is not None else None,
        )["sources"]
        # TASK-1038 R6 — run protocol v2, decided once for the whole run (see the marker).
        self._v2 = workflow.patched(_PROTOCOL_V2_PATCH)
        if self._v2:
            self._run_started_at = workflow.now()
            self._delivery = _delivery_plan(config)
            await self._emit_run_events(
                inp,
                [
                    RunEventSpec(
                        event_type=EVENT_RUN_STARTED,
                        slug=config.slug,
                        version_number=config.version_number,
                    )
                ],
            )
        await self._read_run_start(inp, config)

        # TASK-1042 OD-4a — a run bound to a LIVE STT session waits for the audio to END before
        # its first stage, so the ASR node reads a whole transcript once (C5) rather than waiting
        # inside an activity the 900 s node cap would kill. Cheap operand first (see the marker).
        if inp.live_audio is not None and workflow.patched(_LIVE_AUDIO_PATCH):
            await self._await_live_audio(inp)

        run_failed = False
        run_degraded = False

        for stage in config.stages:
            if self._cancelled or self._timed_out:
                break
            # TASK-932 R-16a — the LIVE HANDOFF, once, immediately before the first stage that
            # consumes a live-owned node's output. Placed here rather than at the top of `run`
            # so the trigger and the realtime skips still settle the moment the run starts (the
            # run-event mirror keeps showing the graph begin at consultation OPEN), and BEFORE
            # `_emit_stage_started` so a stage is never announced as started and then parked for
            # the length of a consultation.
            if self._needs_live_handoff(stage, inp) and workflow.patched(_LIVE_HANDOFF_PATCH):
                await self._await_live_outputs(inp, config)
            await self._emit_stage_started(stage, inp)
            node_results = await self._run_stage(stage, inp)
            self._stages.append(StageResult(stage_index=stage.stage_index, nodes=node_results))
            await self._emit_stage_settled(stage, node_results, inp)
            for node_result in node_results:
                if node_result.status == "FAILED":
                    run_failed = True
                elif node_result.status in ("DEGRADED", "SKIPPED"):
                    run_degraded = True
            if run_failed:
                # The current stage is already fully settled (all-settled join,; no
                # further stage is started once a critical node has failed.
                break

        # 2) The HITL gate. The compiler LIFTS every `gate`-classed node out
        # of `stages` into `gates` (compiler.ts:204-210), so a gate never reaches `_run_stage` —
        # it runs here, after the walk, which is also what the graph means: `WF-CONS-004` makes
        # the gate terminal for everything except the palette-agnostic `core.end` marker.
        # Skipped when a critical node already failed: there is nothing to sign off.
        interrupted = self._bounded and (self._cancelled or self._timed_out)
        if config.gates and not interrupted and workflow.patched(_GATE_PATCH):
            gate_result = await self._run_gate(config.gates[0], inp, blocked=run_failed)
            self._stages.append(StageResult(stage_index=len(self._stages), nodes=[gate_result]))
            if gate_result.status == "FAILED":
                run_failed = True
            elif gate_result.status in ("DEGRADED", "SKIPPED"):
                run_degraded = True

        if self._deadline_task is not None and not self._deadline_task.done():
            self._deadline_task.cancel()

        status: RunStatus
        if self._cancelled:
            status = "CANCELLED"
        elif self._timed_out:
            status = "TIMED_OUT"
        elif run_failed:
            status = "FAILED"
        elif run_degraded:
            status = "DEGRADED"
        else:
            status = "SUCCEEDED"
        self._status = status

        await self._emit_run_completed(inp, status)

        return InterpreterResult(run_id=inp.run_id, status=status, stages=self._stages)

    # Run-event mirror
    #
    # The CONTROL lane. Node/stage/run outcomes are already durable in Temporal history and
    # readable through the `state` query; these three helpers MIRROR them onto the run's Redis
    # Stream so the gateway can PUSH instead of poll. Token deltas never come through here —
    # they go straight from the producing activity to Redis, which is the whole two-lane split
    # (program rule 17: signals land in history, ceiling 51,200 events / 50 MB per run).

    async def _emit_run_events(self, inp: InterpreterInput, events: list[RunEventSpec]) -> None:
        """Fire one emit activity, or do nothing. Never fails the run.

        `workflow.patched` is consulted only when there is something to emit, so an empty
        stage cannot record a marker a replaying history would not have.
        """
        if not events or not workflow.patched(_STREAM_PATCH):
            return
        try:
            await workflow.execute_activity(
                emit_run_events,
                RunEventBatch(run_id=inp.run_id, tenant_id=inp.tenant_id, events=events),
                start_to_close_timeout=_EMIT_TIMEOUT,
                retry_policy=_EMIT_RETRY,
            )
        except ActivityError:
            # The mirror is unreachable. The run's record is Temporal's and is unaffected; a
            # connected client falls back to its snapshot. Failing a clinical run because an
            # observability write timed out would invert which lane matters.
            return

    async def _emit_stage_started(self, stage: CompiledStage, inp: InterpreterInput) -> None:
        """`workflow.node.started`, for the nodes this walk will ACTUALLY dispatch.

        `_preflight_skip` is the same predicate `_dispatch_node` uses — one spelling, so a node
        can never be announced as started and then reported SKIPPED for a reason the walk
        already knew before it began.
        """
        await self._emit_run_events(
            inp,
            [
                RunEventSpec(
                    event_type=EVENT_NODE_STARTED,
                    node_id=node.node_id,
                    node_type=node.type,
                    stage_index=stage.stage_index,
                    label=self._label_of(node) if self._v2 else None,
                )
                for node in stage.nodes
                if self._preflight_skip(node, inp) is None
            ],
        )

    @staticmethod
    def _label_of(node: CompiledNode) -> str | None:
        label = node.config.get("label")
        return label if isinstance(label, str) and label else None

    async def _emit_stage_settled(
        self, stage: CompiledStage, node_results: list[NodeResult], inp: InterpreterInput
    ) -> None:
        """One settle event per node, carrying the status the all-settled join produced."""
        await self._emit_run_events(
            inp,
            [
                RunEventSpec(
                    event_type=(
                        EVENT_NODE_FAILED if result.status == "FAILED" else EVENT_NODE_COMPLETED
                    ),
                    node_id=result.node_id,
                    node_type=result.node_type,
                    stage_index=stage.stage_index,
                    status=result.status,
                    reason=result.reason,
                    **self._v2_settled_facts(result.node_id),
                )
                for result in node_results
            ],
        )

    def _v2_settled_facts(self, node_id: str) -> dict[str, Any]:
        """The v2 facts of one settled node (pure); empty for a run not on protocol v2."""
        if not self._v2:
            return {}
        facts: dict[str, Any] = {"duration_ms": self._node_duration_ms.get(node_id, 0)}
        usage = self._node_usage.get(node_id)
        if usage is not None:
            facts["tokens_in"], facts["tokens_out"] = usage
        if node_id in self._walk_outputs:
            facts["outputs"] = self._walk_outputs[node_id]
        return facts

    async def _emit_run_completed(self, inp: InterpreterInput, status: str) -> None:
        """The terminal event. This is what lets a connected client close its stream on a
        PUSH rather than by noticing, one poll later, that the status stopped changing."""
        node_count, failed_node_count, degraded_node_count, skipped_node_count = (
            _settled_node_counts(self._stages)
        )
        v2: dict[str, Any] = {}
        reason = self._run_failure_reason
        if self._v2:
            if reason is None and status == "FAILED":
                # The run's cause, for the fixed error code: the first node that failed it.
                reason = next(
                    (n.reason for st in self._stages for n in st.nodes if n.status == "FAILED"),
                    None,
                )
            elapsed = (
                (workflow.now() - self._run_started_at).total_seconds()
                if self._run_started_at is not None
                else 0.0
            )
            v2 = {
                "duration_ms": max(0, int(elapsed * 1000)),
                "tokens_in": sum(u[0] for u in self._node_usage.values()),
                "tokens_out": sum(u[1] for u in self._node_usage.values()),
                "retention_seconds": inp.retention_seconds,
                "result_inline_max_bytes": (
                    inp.limits.result_inline_max_bytes if inp.limits is not None else None
                ),
                # TASK-1050 — every warn / unverified notice the run raised (activity input only).
                "guardrail_notices": list(self._guardrail_notices) or None,
            }
        await self._emit_run_events(
            inp,
            [
                RunEventSpec(
                    event_type=EVENT_RUN_COMPLETED,
                    status=status,
                    reason=reason,
                    result_outputs=self._result_outputs(),
                    node_count=node_count,
                    failed_node_count=failed_node_count,
                    degraded_node_count=degraded_node_count,
                    skipped_node_count=skipped_node_count,
                    **v2,
                )
            ],
        )

    def _result_outputs(self) -> dict[str, dict[str, Any]] | None:
        """TASK-1038 D-I — what every ``core.output`` node published, by node id (pure).

        Read from the walk's own output cache, so a ``core.output`` that FAILED (and stored
        nothing) contributes nothing, and a DEGRADED one that published a mismatching payload
        (``onSchemaViolation: degrade``) does — the run's status says which it was. ``None`` when
        no output node published anything: the completed event then carries no ``result``.
        """
        published = {
            node_id: output
            for node_id, output in self._node_outputs.items()
            if self._node_types.get(node_id) == "core.output"
            and ("payload" in output or "resultRef" in output)
        }
        return published or None

    async def _run_stage(self, stage: CompiledStage, inp: InterpreterInput) -> list[NodeResult]:
        """All-settled join: every node's own coroutine catches its own ACTIVITY exceptions
        (so plain asyncio.gather (no return_exceptions) is sufficient for the
        outcomes defines.

        ONE thing does deliberately escape : _resolve_bound_inputs raises a
        non-retryable ``ApplicationError`` when a graph binds a socket the producing node type does
        not declare. That is a CONTRACT violation rather than a node outcome — there is no honest
        value to thread and no retry that would change it — so it fails the run loudly instead of
        being flattened into a per-node ``DEGRADED``."""
        if not self._bounded:
            return list(
                await asyncio.gather(
                    *(self._dispatch_node(node, inp, stage.stage_index) for node in stage.nodes)
                )
            )
        # TASK-1038 R-4 / D-B — the stage RACES the run being cancelled or timing out. The nodes
        # still run concurrently and the join is still all-settled; what changes is that a cancel
        # or the deadline no longer waits for the slowest node to finish on its own.
        tasks = [
            asyncio.ensure_future(self._dispatch_node(node, inp, stage.stage_index))
            for node in stage.nodes
        ]
        await workflow.wait_condition(
            lambda: all(task.done() for task in tasks) or self._cancelled or self._timed_out
        )
        pending = [not task.done() for task in tasks]
        for task, was_pending in zip(tasks, pending, strict=True):
            if was_pending:
                task.cancel()
        results: list[NodeResult] = []
        for node, task, was_pending in zip(stage.nodes, tasks, pending, strict=True):
            try:
                settled = await task
            except asyncio.CancelledError:
                settled = None
            # A node interrupted mid-flight is reported as INTERRUPTED whatever its coroutine
            # made of the cancellation (a child's cancellation may surface as its own error).
            results.append(self._interrupted(node) if was_pending or settled is None else settled)
        return results

    def _interrupted(self, node: CompiledNode) -> NodeResult:
        """The settled record of a node a cancel or the deadline interrupted (pure)."""
        if self._cancelled:
            return NodeResult(
                node_id=node.node_id, node_type=node.type, status="SKIPPED", reason="cancelled"
            )
        return NodeResult(
            node_id=node.node_id, node_type=node.type, status="FAILED", reason="run_timed_out"
        )

    # TASK-1038 D-B — the run deadline.

    def _start_deadline(self, budget_seconds: int) -> None:
        self._budget_seconds = float(budget_seconds)
        self._clock_started = workflow.now()
        self._deadline_task = asyncio.ensure_future(self._watch_deadline())

    def _remaining_budget(self) -> float:
        """Compute seconds left (pure): budget minus elapsed workflow time minus paused time."""
        if self._budget_seconds is None or self._clock_started is None:
            return float("inf")
        now = workflow.now()
        paused = self._paused_seconds
        if self._pause_depth and self._pause_started is not None:
            paused += (now - self._pause_started).total_seconds()
        elapsed = (now - self._clock_started).total_seconds() - paused
        return self._budget_seconds - elapsed

    async def _watch_deadline(self) -> None:
        """One timer at a time, until the budget is spent.

        While the clock is PAUSED (a durable wait on a clinician) no timer runs at all — the
        watch parks on the pause ending — so a two-hour consultation or an hour-long review costs
        one cancelled timer, not one re-armed timer per remaining-budget interval.
        """
        while True:
            if self._pause_depth:
                await workflow.wait_condition(lambda: self._pause_depth == 0)
                continue
            remaining = self._remaining_budget()
            if remaining <= 0:
                self._timed_out = True
                return
            try:
                await workflow.wait_condition(
                    lambda: self._pause_depth > 0, timeout=timedelta(seconds=remaining)
                )
            except TimeoutError:
                continue

    def _pause_clock(self) -> None:
        """Enter a durable wait on a clinician: the budget stops being charged. A no-op on a run
        without a deadline (every run recorded before `_DEADLINE_PATCH`)."""
        if self._budget_seconds is None:
            return
        if self._pause_depth == 0:
            self._pause_started = workflow.now()
        self._pause_depth += 1

    def _resume_clock(self) -> None:
        if self._budget_seconds is None:
            return
        self._pause_depth -= 1
        if self._pause_depth == 0 and self._pause_started is not None:
            self._paused_seconds += (workflow.now() - self._pause_started).total_seconds()
            self._pause_started = None

    async def _await_cancellable(self, awaitable: Any) -> tuple[bool, Any]:
        """``(interrupted, result)`` — await ``awaitable`` unless the run is cancelled first.

        For the waits OUTSIDE a stage race (the HITL gate). The deadline does not apply: the gate
        is a durable wait on a clinician with its own SLA ladder.
        """
        task = asyncio.ensure_future(awaitable)
        await workflow.wait_condition(lambda: task.done() or self._cancelled)
        if task.done():
            return False, task.result()
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 — however it surfaced
            pass
        return True, None

    def _resolve_bound_inputs(self, node: CompiledNode) -> dict[str, Any]:
        """Thread completed predecessors' outputs into this node's input, via `node.inputs`
        (the compiler-derived edge bindings) — see `NodeActivityInput.bound_inputs`'s docstring
        for the full design rationale. Keyed by `toPort`; a later binding with the same `toPort`
        overwrites an earlier one (last-write-wins — v1 does not detect/reject the collision, the
        same "no dynamic sub-graph, wire it and see" posture as everything else here).

        ## The socket -> output-key resolution (option A)

        An edge's ``fromPort`` is an AUTHORING handle — ``out``, ``entities``, ``contextItemId`` —
        and NOT a key in the producing activity's output dict. No activity in this platform emits
        a key called ``"out"``, so until OD-15 the real code path here was the whole-object
        fallback: hand the downstream node the ENTIRE predecessor output. That is the untyped
        bundle the port vocabulary exists to abolish, and it is why a node had to grope around
        inside its bound inputs looking for the key it wanted.

        Each socket now declares the key it carries (``NodeSpec.output_keys``, mirrored from the
        TypeScript port table through the committed parity fixture), which gives three outcomes,
        deliberately distinct:

        * **``None`` — a `control` socket.** Ordering, no payload. Binds nothing.
        * **a key that is absent from THIS run's output.** A runtime data condition (a DEGRADED
          predecessor stores no output at all; ``consultation.captureBinding`` declares a
          transcript socket its activity does not populate yet). Contributes nothing — never a
          ``KeyError``, and never a fabricated value, exactly as before.
        * **a port the producer does not declare at all.** A CONTRACT violation: the graph names
          a socket that does not exist, and no honest value can be threaded for it. Raises,
          naming the node and the port, instead of quietly substituting something.
        """
        bound: dict[str, Any] = {}
        for binding in node.inputs:
            upstream_type = self._node_types.get(binding.from_node_id)
            upstream_node = self._nodes_by_id.get(binding.from_node_id)
            # TASK-864: a `core.action` publishes its DELEGATE's sockets, so the keys are resolved
            # per instance (`output_keys_for`), not per type. Every other type is unchanged.
            output_keys = (
                output_keys_for(upstream_type, upstream_node.config if upstream_node else None)
                if upstream_type is not None
                else None
            )
            if output_keys is None or binding.from_port not in output_keys:
                raise ApplicationError(
                    f"unresolved input binding: node {node.node_id!r} ({node.type}) binds "
                    f"{binding.to_port!r} from {binding.from_node_id!r} "
                    f"({upstream_type or 'unknown node type'}) port {binding.from_port!r}, "
                    "which is not a declared output socket of that node type",
                    type="unresolved_input_binding",
                    non_retryable=True,
                )
            output_key = output_keys[binding.from_port]
            if output_key is None:
                # An ORDERING edge. The stage partitioning already carries the dependency.
                continue
            upstream_output = self._node_outputs.get(binding.from_node_id)
            if upstream_output is None or output_key not in upstream_output:
                continue
            bound[binding.to_port] = upstream_output[output_key]
        return bound

    # TASK-932 R-16a — the LIVE HANDOFF.
    #
    # `_has_live_owner` closes a DOUBLE-WRITE hazard: exactly one runtime may execute a
    # `realtime` node of a consultation-bound run, and the live executor is that runtime. What it
    # did NOT do is give the durable half the results. `_resolve_bound_inputs` reads
    # `self._node_outputs`, a skipped node stores none, so `n_finalize` — the `onEnd` finalizer
    # every seeded consultation graph carries — resolved `bound_inputs: {}` and degraded
    # `no_bound_text` on every consultation that ever ran. Skipping a node is a statement about
    # WHO runs it, never about whether its output exists.
    #
    # Two things had to be true for the finalize to work, and neither was:
    #
    #  1. the live lane's outputs must be visible here (this handoff), and
    #  2. the walk must not reach the finalizer BEFORE the consultation ends. The run is
    #     dispatched at consultation OPEN (`ConsultationWorkflowDispatchService`, trigger
    #     `consultation open`) and this body has no wait in it, so `n_finalize` was dispatched
    #     within a second of the consultation opening — before a word had been spoken. The poll
    #     loop below is that wait, and `execution.cadence: onEnd` is what the graph author wrote
    #     to ask for it.

    def _needs_live_handoff(self, stage: CompiledStage, inp: InterpreterInput) -> bool:
        """Whether this stage consumes an output the LIVE executor owns (pure).

        True exactly once per run, for the first stage carrying a node that (a) this walk will
        actually dispatch and (b) binds an input from a node already skipped as `realtime_lane`.
        A graph with no such edge — every API-plane run, and any consultation graph whose durable
        half reads nothing from the live half — never waits at all.
        """
        # A SANDBOX run never waits. A Workbench execution is a dry run of the graph, not a
        # consultation: there is no live session to hand off, and parking one for the length of a
        # clinical session would turn "preview this workflow" into a two-hour wait. Its
        # `external_write` nodes are already suppressed, so nothing it produces is persisted
        # either — the handoff would buy it nothing even if one existed.
        if inp.sandbox:
            return False
        if self._live_handoff_done or not _has_live_owner(inp) or not self._live_skipped:
            return False
        return any(
            self._preflight_skip(node, inp) is None
            and any(binding.from_node_id in self._live_skipped for binding in node.inputs)
            for node in stage.nodes
        )

    async def _await_live_outputs(
        self, inp: InterpreterInput, config: CompiledWorkflowConfig
    ) -> None:
        """Park until the live session hands off, then seed its outputs into the walk's cache.

        A poll rather than a signal, deliberately. The interpreter's signal surface is a
        one-name allow-list (`cancel`) and this is not an event the run must not miss: the fact
        being waited on is DURABLE gateway state, so a read converges whether or not any single
        delivery succeeded — a gateway restart at exactly the wrong moment cannot strand a
        clinical run holding an unfinalized note.

        Deterministic: a timer and an activity, nothing else. The loop count is decided by
        recorded activity results, so a replay takes the same path.

        Seeding NEVER overwrites an output this walk produced itself — the durable lane is
        authoritative for the nodes it actually ran.
        """
        self._live_handoff_done = True
        consultation_id = _opt_str(inp.payload.get("consultationId")) or (
            inp.subject.consultation_id if inp.subject is not None else None
        )
        if not consultation_id:
            # `_has_live_owner` was true, so identity exists on one of the two channels; if
            # neither yields a string there is nothing to ask about and nothing to wait for.
            return

        request = LiveOutputsRequest(
            run_id=inp.run_id,
            tenant_id=inp.tenant_id,
            consultation_id=consultation_id,
            # EVERY realtime node in the graph, not only those skipped so far: the handoff
            # fires at the FIRST durable consumer of a live output (on the seeded consultation
            # graphs that is the visit-type condition reading `n_ner.out`), which is stages
            # before the summary nodes are skipped — and the summary node is exactly what
            # `n_finalize.in` binds. The poll waits for the live lane to END, so every realtime
            # output is final by the time it answers (reproduced live 2026-09-09: the handoff
            # asked for `n_asr,n_ner,n_presummary` and the finalizer still had nothing bound).
            node_ids=sorted(
                self._live_skipped
                | {
                    node.node_id
                    for stage in config.stages
                    for node in stage.nodes
                    if _configured_realtime(node)
                }
            ),
        )
        # TASK-1038 D-B — parked on a clinician, not computing: the budget clock stops.
        self._pause_clock()
        try:
            await self._poll_live_outputs(request)
        finally:
            self._resume_clock()

    async def _poll_live_outputs(self, request: LiveOutputsRequest) -> None:
        """The handoff poll loop itself (see `_await_live_outputs`)."""
        deadline = workflow.now() + _LIVE_HANDOFF_MAX_WAIT
        while not self._cancelled:
            try:
                answer: LiveOutputsResult = await workflow.execute_activity(
                    load_live_outputs,
                    request,
                    start_to_close_timeout=_LIVE_OUTPUTS_TIMEOUT,
                    retry_policy=_LIVE_OUTPUTS_RETRY,
                )
            except ActivityError:
                # Unreachable gateway. Indistinguishable, from here, from a session still in
                # progress — so it is treated the same way and asked again, never mistaken for
                # "the live lane produced nothing".
                answer = LiveOutputsResult(ended=False)
            if answer.ended:
                for node_id, output in answer.outputs.items():
                    if node_id not in self._node_outputs and isinstance(output, dict):
                        self._node_outputs[node_id] = output
                self._live_context = dict(answer.context)
                return
            if workflow.now() >= deadline:
                return
            if self._bounded:
                # TASK-1038 R-4 — a cancel ends the wait NOW, not at the next poll.
                try:
                    await workflow.wait_condition(
                        lambda: self._cancelled, timeout=_LIVE_HANDOFF_POLL_INTERVAL
                    )
                except TimeoutError:
                    pass
            else:
                await workflow.sleep(_LIVE_HANDOFF_POLL_INTERVAL)

    async def _await_live_audio(self, inp: InterpreterInput) -> None:
        """Park until the run's bound STT session is no longer live (TASK-1042 OD-4a).

        The consultation live handoff's shape: a poll, not a signal — the fact waited on is
        durable gateway state, so a read converges whatever any single delivery did. A timer and
        an activity, nothing else, and the loop count is decided by recorded activity results, so
        a replay takes the same path. The wait is a durable wait on a person, not compute: the
        budget clock is paused across it, and its clamped ceiling is what the dispatcher added to
        the `execution_timeout` backstop.

        Nothing is threaded to the ASR node: it re-reads C5 once and turns the state it finds
        (`ended` / `truncated` / `timeout` / still `live` past the ceiling / 404) into its own
        outcome, so this wait adds no field to any activity input.
        """
        binding = inp.live_audio
        if binding is None:
            return
        request = LiveAudioStateRequest(
            run_id=inp.run_id, tenant_id=inp.tenant_id, stt_session_id=binding.stt_session_id
        )
        # Re-clamped here: the workflow never trusts its input to have been clamped already.
        ceiling = timedelta(seconds=caps.live_audio_wait_seconds(binding.max_wait_seconds))
        self._pause_clock()
        try:
            await self._poll_live_audio(request, ceiling)
        finally:
            self._resume_clock()

    async def _poll_live_audio(self, request: LiveAudioStateRequest, ceiling: timedelta) -> None:
        """The live-audio poll loop itself (see `_await_live_audio`)."""
        deadline = workflow.now() + ceiling
        while not self._cancelled:
            try:
                answer = await workflow.execute_activity(
                    load_live_audio_state,
                    request,
                    start_to_close_timeout=_LIVE_AUDIO_STATE_TIMEOUT,
                    retry_policy=_LIVE_AUDIO_STATE_RETRY,
                )
                state = answer.state
            except ActivityError:
                # Unreachable from here is indistinguishable from "still recording".
                state = "live"
            if state != "live" or workflow.now() >= deadline:
                return
            # A cancel ends the wait NOW, not at the next poll. Every run carrying `live_audio`
            # postdates `_CANCEL_PATCH`, so there is no unbounded (sleep-only) era to preserve.
            try:
                await workflow.wait_condition(
                    lambda: self._cancelled, timeout=_LIVE_AUDIO_POLL_INTERVAL
                )
            except TimeoutError:
                pass

    def _preflight_skip(self, node: CompiledNode, inp: InterpreterInput) -> NodeResult | None:
        """Every reason this walk declines a node BEFORE dispatching anything (pure).

        Extracted from `_dispatch_node` so the run-event producer can ask "will
        this node actually run?" without a second spelling of the answer — two spellings is
        exactly how the walk and the mirror drift. `None` means "dispatch it"; the returned
        `NodeResult` IS the outcome, so `_dispatch_node` returns it unchanged.

        The ORDER of these is load-bearing and unchanged; each comment explains its own
        position.
        """
        # TASK-864: a `core.action`'s SAFETY properties are its delegate's (`effective_spec`);
        # every other type resolves to its own spec exactly as before.
        spec = effective_spec(node.type, node.config)
        if spec is None or not spec.implemented:
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="SKIPPED",
                reason="unsupported_node_type",
            )

        # lane A — LANE OWNERSHIP. A `realtime` node belongs to
        # live executor, not to this durable interpreter, and exactly one runtime must execute
        # any given node: `consultation.realtimeSummary` is `external_write`, so both running it
        # means two engines writing one consultation's document.
        #
        # TASK-930 D-1 — ownership needs an OWNER, so the skip is conditional on the run being
        # CONSULTATION-BOUND (`_has_live_owner`). The live executor only ever runs a node inside a
        # consultation's live session; an exposure-plane run has no such session, and there the
        # skip did not hand a node to another runtime, it handed it to nobody — which is exactly
        # how a graph declaring `kinds: ['consultation','api']` came to be structurally incapable
        # of producing its own declared output on the `api` half (§6.9 D-1: every producing node
        # SKIPPED, `n_finalize` degraded "nothing bound", `n_output` FAILED on its own schema).
        # The double-write hazard this rule exists for is a hazard ABOUT a consultation, and it is
        # preserved verbatim wherever a consultation exists.
        #
        # This loses nothing that was working. In THIS lane `consultation.captureBinding` emits no
        # transcript, so `consultation.extractEntities` and `consultation.realtimeSummary` already
        # degraded on `no_bound_text` every run. The skip turns a silent degrade into an
        # OBSERVABLE one that names the runtime which owns the work — the same discipline as
        # `unsupported_node_type` above, and never a silent no-op.
        if (spec.lane == "realtime" or _configured_realtime(node)) and _has_live_owner(inp):
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="SKIPPED",
                reason="realtime_lane",
            )

        # TASK-864 — BRANCH GATING. A node behind a router/review handle runs only when one of
        # its guards was TAKEN; a node whose every predecessor was skipped that way is skipped
        # too, so an untaken branch's whole tail is skipped, not just its first node. A join
        # (the Output fed by both branches) runs as long as ONE predecessor ran. Pure: every
        # input is a recorded activity result. Legacy configs carry no guards, so nothing here
        # changes their command sequence.
        if self._branch_skip(node):
            self._branch_skipped.add(node.node_id)
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="SKIPPED",
                reason="branch_not_taken",
            )

        # item 4 — the per-node KILL SWITCH, honoured by BOTH runtimes.
        #
        # realtime executor has read this key since it shipped (`realtime-lane.ts`:
        # `enabled: node.config?.enabled !== false`); this interpreter never did. A toggle one
        # runtime honours and the other ignores is worse than no toggle: an admin switches a node
        # off, watches the live lane stop running it, and the durable lane keeps executing it on
        # every finalize — including the `external_write` nodes.
        #
        # AFTER the lane check on purpose. Lane ownership decides WHICH runtime speaks for a node
        # at all, so a disabled `realtime` node is still reported as `realtime_lane` here and as
        # disabled by the runtime that actually owns it. Reporting it twice, under two different
        # reasons, is the ambiguity `lane` was made load-bearing to remove.
        #
        # The literal `is False`, never a truthiness test: absent must mean ENABLED (every graph
        # published before this ticket carries no `enabled` key), and the schema types it as a
        # boolean, so a non-boolean is MALFORMED rather than "off" — silently disabling a node
        # because its config carried the string "false" is the failure mode this avoids.
        #
        # A pure read of an already-deserialised `CompiledNode`: no I/O, no clock, no env, no
        # `workflow.*` call — replay-safe exactly like the two skips around it.
        if node.config.get("enabled") is False:
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="SKIPPED",
                reason="disabled_by_config",
            )

        # S-4: the callable that gets invoked always comes from the registry; the wire's
        # `activity` string is only a consistency check, never trusted for routing.
        if node.activity != spec.activity_name:
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="SKIPPED",
                reason="activity_mismatch",
            )

        if inp.sandbox and spec.external_write:
            return NodeResult(
                node_id=node.node_id, node_type=node.type, status="SKIPPED", reason="sandbox"
            )

        return None

    async def _dispatch_node(
        self, node: CompiledNode, inp: InterpreterInput, stage_index: int
    ) -> NodeResult:
        """Dispatch one node and record how long it took, in WORKFLOW time (pure clock)."""
        started = workflow.now()
        try:
            return await self._dispatch_node_inner(node, inp, stage_index)
        finally:
            elapsed = (workflow.now() - started).total_seconds()
            self._node_duration_ms[node.node_id] = max(0, int(elapsed * 1000))

    async def _dispatch_node_inner(
        self, node: CompiledNode, inp: InterpreterInput, stage_index: int
    ) -> NodeResult:
        skipped = self._preflight_skip(node, inp)
        if skipped is not None:
            # TASK-932 R-16a — remember WHICH nodes were handed to the live executor, so the
            # handoff predicate below can ask "does this stage consume one of them?" without a
            # second spelling of the lane rule. Recorded HERE and not in `_preflight_skip`,
            # which stays PURE because the run-event mirror calls it too.
            if skipped.reason == "realtime_lane":
                self._live_skipped.add(node.node_id)
            return skipped

        # Present after `_preflight_skip` by construction — an unregistered/unimplemented type
        # is its first refusal, so reaching here means the registry has a real spec.
        spec = effective_spec(node.type, node.config) or NODE_REGISTRY[node.type]

        # TASK-1036 §9.3 (OD-30) — the node's DECLARED consultation reads, snapshotted now (node
        # start) or taken at run start. A failed read fails the step by name; it is never
        # dispatched on a guess.
        consultation, read_failure = await self._consultation_values(node, inp, spec.critical)
        if read_failure is not None:
            return read_failure
        node_now = workflow.now()
        # TASK-1036 §9.2 — a node's compiled `bindings` decide what it is handed (cheap operand
        # first; see `_BINDINGS_PATCH`). `None` = no bindings: today's edge-port threading.
        bound_override: dict[str, Any] | None = None
        if node.bindings is not None and workflow.patched(_BINDINGS_PATCH):
            bound_override = self._resolve_node_bindings(node, inp, consultation, node_now)

        # TASK-864 — the two `core` constructs that run as CHILD WORKFLOWS. Cheap operand (the
        # node type) first, exactly as the loop gate below: `workflow.patched` is consulted only
        # for a graph that actually carries one, and no pre-existing history can.
        if node.type == CORE_REVIEW_NODE_TYPE and workflow.patched(_CORE_PATCH):
            return await self._run_review(node, inp, bound=bound_override)
        if node.type == CORE_LOOP_NODE_TYPE and workflow.patched(_CORE_PATCH):
            return await self._run_core_loop(node, inp, bound=bound_override)

        timeout_seconds = caps.clamp_timeout(node.timeout_seconds)
        max_attempts = caps.clamp_attempts(node.retry.maximum_attempts)
        trajectory = TrajectoryContext(
            tenant_id=inp.tenant_id,
            seq=self._next_seq(),
            workflow_version_id=inp.workflow_version_id,
            stage_id=str(stage_index),
            node_id=node.node_id,
            node_type=node.type,
            doctor_id=_run_doctor_id(inp),
        )
        by_reference = workflow.patched(_PAYLOAD_REFS_PATCH)
        bound_inputs = (
            bound_override if bound_override is not None else self._resolve_bound_inputs(node)
        )
        if self._v2 and node.type in ROUTER_NODE_TYPES and "in" in bound_inputs:
            # OD-19 — `nodes.<router>.outputs.input` is what the router was handed.
            self._router_inputs[node.node_id] = bound_inputs["in"]
        if by_reference:
            run_payload, run_context = self._payload_views(inp, core=node.type.startswith("core."))
            bound_inputs = self._bound_payload_by_reference(bound_inputs, inp)
        else:
            run_payload = inp.payload
            run_context = self._run_context() if node.type.startswith("core.") else {}
        v2_fields = self._v2_activity_fields(node, inp, consultation, node_now, run_context)
        if "run_context" in v2_fields:
            run_context = v2_fields.pop("run_context")
        offload_min = (
            inp.limits.node_output_claim_check_min_bytes if inp.limits is not None else None
        )
        if offload_min is not None:
            v2_fields["output_offload_min_bytes"] = offload_min
        activity_input = NodeActivityInput(
            node_id=node.node_id,
            node_type=node.type,
            config=node.config,
            tenant_id=inp.tenant_id,
            sandbox=inp.sandbox,
            trajectory=trajectory,
            bound_inputs=bound_inputs,
            run_payload=run_payload,
            run_id=inp.run_id,
            # TASK-864 — the run context, for `core.*` nodes only: a legacy node's payload stays
            # byte-identical to every run before this ticket.
            run_context=run_context,
            **v2_fields,
        )
        if by_reference and inp.limits is not None:
            too_large = _oversized_input_reason(activity_input, inp.limits)
            if too_large is not None:
                # TASK-1038 R-3 — refused BEFORE scheduling. Temporal would refuse the payload
                # itself, failing the workflow TASK (not the node) and retrying it forever; a
                # named FAILED node fails the run instead, whatever the node's criticality.
                self._run_failure_reason = PAYLOAD_TOO_LARGE
                return NodeResult(
                    node_id=node.node_id,
                    node_type=node.type,
                    status="FAILED",
                    reason=too_large,
                )

        retry_policy = (
            _node_retry_policy(node, max_attempts)
            if workflow.patched(_RETRY_PATCH)
            else RetryPolicy(maximum_attempts=max_attempts)
        )
        try:
            result: NodeActivityResult = await workflow.execute_activity(
                spec.activity,
                activity_input,
                start_to_close_timeout=timedelta(seconds=timeout_seconds),
                retry_policy=retry_policy,
            )
        except ActivityError as exc:
            # Timeout OR an application-raised exception both surface here identically
            # (contracts/ example) — so the CAUSE is the only thing that says which, and it
            # travels onto the reason rather than being discarded (F13).
            return self._activity_failure(node, spec, exc)

        # TASK-1050 W2f — a generation guardrail refused holds the run HERE (see the marker).
        held = await self._settle_guardrail_hold(
            node,
            inp,
            spec,
            activity_input,
            result,
            timedelta(seconds=timeout_seconds),
            retry_policy,
        )
        if isinstance(held, NodeResult):
            return held
        result = held
        self._collect_guardrail_notices(result)

        self._record_io(node.node_id, result)
        if result.status == "SUCCEEDED":
            if result.output is not None:
                self._node_outputs[node.node_id] = result.output
            if result.taken_handle is not None:
                self._taken_handles[node.node_id] = {result.taken_handle}
            return NodeResult(node_id=node.node_id, node_type=node.type, status="SUCCEEDED")
        if result.status == "DEGRADED":
            promoted_status: NodeStatus = "FAILED" if spec.critical else "DEGRADED"
            reason = result.reason or "activity_error"
            if result.output is not None and workflow.patched(_KEEP_DEGRADED_PATCH):
                # TASK-1038 D-H — the work this node DID produce (a generated, billed note whose
                # persist then failed; a result that missed its schema) is kept, marked, so the
                # review and the output downstream can still use it. `_degraded` is a reserved
                # key: a downstream binding reads one named key and never sees it.
                self._node_outputs[node.node_id] = {
                    **result.output,
                    "_degraded": {"reason": reason},
                }
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status=promoted_status,
                reason=reason,
            )
        # result.status == "SKIPPED" (the activity itself declined, e.g. a future
        # activity-internal sandbox check) — never critical-promoted; a skip is not a failure.
        return NodeResult(
            node_id=node.node_id, node_type=node.type, status="SKIPPED", reason=result.reason
        )

    @staticmethod
    def _activity_failure(node: CompiledNode, spec: Any, exc: ActivityError) -> NodeResult:
        """The settled record of a node activity that raised (pure)."""
        degraded_status: NodeStatus = "FAILED" if spec.critical else "DEGRADED"
        return NodeResult(
            node_id=node.node_id,
            node_type=node.type,
            status=degraded_status,
            reason=_activity_error_reason(exc),
        )

    # TASK-1050 W2f — the node-level guardrail hold (README §9.8.1).

    def _collect_guardrail_notices(self, result: NodeActivityResult) -> None:
        """Keep a node's warn / unverified notices for `run.completed` (pure; once per notice)."""
        known = {notice.get("noticeId") for notice in self._guardrail_notices}
        for notice in result.guardrail_notices or []:
            if isinstance(notice, dict) and notice.get("noticeId") not in known:
                known.add(notice.get("noticeId"))
                self._guardrail_notices.append(notice)

    async def _settle_guardrail_hold(
        self,
        node: CompiledNode,
        inp: InterpreterInput,
        spec: Any,
        activity_input: NodeActivityInput,
        result: NodeActivityResult,
        start_to_close: timedelta,
        retry_policy: RetryPolicy,
    ) -> NodeActivityResult | NodeResult:
        """While the node's result reports a guardrail hold: publish it, wait for its resolution,
        and re-execute ONLY this node. Returns the result to settle, or the node's settled record
        when the hold ended without one (timed out, not resumable, cancelled, round cap).

        Cheap operand first (`result.guardrail_hold`, then the run speaking protocol v2 — the
        notice and the pause are v2 events), so a result without a hold — every result recorded
        before the marker — never consults `workflow.patched`. Off the marker, the refused node
        settles as the DEGRADED result it already is.
        """
        rounds = 0
        base_scope = activity_input.event_scope
        while (
            result.guardrail_hold is not None
            and self._v2
            and workflow.patched(_GUARDRAIL_HOLD_PATCH)
        ):
            hold = result.guardrail_hold
            resolution = await self._await_guardrail_resolution(node, inp, hold, rounds)
            if isinstance(resolution, NodeResult):
                return resolution
            rounds += 1
            notice_id = resolution.notice_id
            scope = f"hold:{rounds}"
            activity_input = activity_input.model_copy(
                update={
                    "guardrail_override": guardrail_hold.hold_override(
                        hold.kind, resolution.resolution, notice_id
                    ),
                    # The re-run's steps take their own seq base, and its events their own dedupe
                    # scope: the refused attempt's must not swallow them.
                    "trajectory": (
                        activity_input.trajectory.model_copy(update={"seq": self._next_seq()})
                        if activity_input.trajectory is not None
                        else None
                    ),
                    "event_scope": f"{base_scope}|{scope}" if base_scope else scope,
                }
            )
            await self._emit_run_events(
                inp,
                [
                    RunEventSpec(
                        event_type=EVENT_NODE_STARTED,
                        node_id=node.node_id,
                        node_type=node.type,
                        label=self._label_of(node),
                        attempt=rounds + 1,
                    )
                ],
            )
            try:
                result = await workflow.execute_activity(
                    spec.activity,
                    activity_input,
                    start_to_close_timeout=start_to_close,
                    retry_policy=retry_policy,
                )
            except ActivityError as exc:
                return self._activity_failure(node, spec, exc)
        return result

    async def _await_guardrail_resolution(
        self,
        node: CompiledNode,
        inp: InterpreterInput,
        hold: GuardrailHold,
        rounds: int,
    ) -> GuardrailResolutionSignal | NodeResult:
        """Publish one hold, then wait (durably, bounded) for its ``guardrail_resolution``."""
        notice = dict(hold.notice)
        notice_id = notice.get("noticeId")
        await self._emit_run_events(
            inp,
            [RunEventSpec(event_type=EVENT_GUARDRAIL_NOTICE, node_id=node.node_id, notice=notice)],
        )
        refusal: str | None = None
        if not isinstance(notice_id, str) or not notice_id:
            refusal = "the refusal named no notice"
        elif notice.get("resumable") is False:
            refusal = "the notice is not resumable"
        elif rounds >= caps.MAX_GUARDRAIL_HOLD_ROUNDS:
            refusal = f"held {rounds} times"
        if refusal is not None:
            return self._guardrail_blocked(node, f"{refusal} (notice {notice_id})")
        assert isinstance(notice_id, str)  # noqa: S101 — narrowed by the refusal checks above
        await self._emit_run_events(
            inp,
            [RunEventSpec(event_type=EVENT_RUN_PAUSED, node_id=node.node_id, notice=notice)],
        )
        self._pending_holds[notice_id] = GuardrailHoldState(
            noticeId=notice_id, nodeId=node.node_id, kind=hold.kind
        )
        wait = self._guardrail_hold_wait_seconds(inp)
        timed_out = False
        # A durable wait on a person, not compute: the budget clock is paused across it.
        self._pause_clock()
        try:
            await workflow.wait_condition(
                lambda: notice_id in self._hold_resolutions or self._cancelled,
                timeout=timedelta(seconds=wait),
            )
        except TimeoutError:
            timed_out = True
        finally:
            self._resume_clock()
            self._pending_holds.pop(notice_id, None)
        if self._cancelled:
            return self._interrupted(node)
        resolution = self._hold_resolutions.pop(notice_id, None)
        if timed_out or resolution is None:
            return self._guardrail_blocked(
                node, f"no resolution within {int(wait)}s (notice {notice_id})"
            )
        return resolution

    def _guardrail_blocked(self, node: CompiledNode, why: str) -> NodeResult:
        """A hold that ended without a resolution fails the node — whatever its criticality — and
        names the run's failure ``GUARDRAIL_BLOCKED`` (pure)."""
        if self._run_failure_reason is None:
            self._run_failure_reason = GUARDRAIL_BLOCKED
        return NodeResult(
            node_id=node.node_id,
            node_type=node.type,
            status="FAILED",
            reason=f"{GUARDRAIL_BLOCKED}: guardrail hold ended: {why}",
        )

    def _guardrail_hold_wait_seconds(self, inp: InterpreterInput) -> float:
        """The hold timeout (pure: recorded input + workflow time; see
        `guardrail_hold.hold_wait_seconds`)."""
        info = workflow.info()
        execution_timeout = info.execution_timeout
        return guardrail_hold.hold_wait_seconds(
            inp.limits.guardrail_hold_timeout_seconds if inp.limits is not None else None,
            ceiling=caps.GUARDRAIL_HOLD_MAX_WAIT_SECONDS,
            execution_timeout_seconds=(
                execution_timeout.total_seconds() if execution_timeout is not None else None
            ),
            elapsed_seconds=(workflow.now() - info.workflow_start_time).total_seconds(),
            grace_seconds=caps.RUN_TIMEOUT_GRACE_SECONDS,
        )

    # TASK-1036 / TASK-1038 (lane B1) — bindings, declared reads and the v2 activity fields.

    def _record_io(self, node_id: str, result: NodeActivityResult) -> None:
        """The NodeIO metadata a node activity reported: its agent task and token usage (pure)."""
        io = result.io if isinstance(result.io, dict) else None
        if io is None:
            return
        task = io.get("task")
        if isinstance(task, str):
            self._node_tasks[node_id] = task
        usage = io.get("usage")
        if isinstance(usage, dict):
            tokens_in, tokens_out = usage.get("in"), usage.get("out")
            if isinstance(tokens_in, int) and isinstance(tokens_out, int):
                self._node_usage[node_id] = (tokens_in, tokens_out)

    def _run_fields(self, inp: InterpreterInput, now: datetime) -> dict[str, Any]:
        """`run.*` (bindings.ts `RUN_SCOPE_FIELDS`). Replay-safe: workflow time only."""
        return {
            "id": inp.run_id,
            "tenantId": inp.tenant_id,
            "workflowSlug": self._config_slug,
            "workflowVersion": self._config_version,
            "startedAt": workflow.info().workflow_start_time.isoformat(),
            "now": now.isoformat(),
        }

    def _variables(self) -> dict[str, Any]:
        merged: dict[str, Any] = {}
        for node_id, output in self._node_outputs.items():
            if self._node_types.get(node_id) == "core.variable" and isinstance(
                output.get("vars"), dict
            ):
                merged.update(output["vars"])
        return merged

    def _resolve_node_bindings(
        self,
        node: CompiledNode,
        inp: InterpreterInput,
        consultation: dict[str, Any],
        now: datetime,
    ) -> dict[str, Any]:
        """The node's inputs, by NodeIO name, from its compiled `bindings` (pure).

        A value the workflow cannot read (behind a claim-check reference) is handed over as a
        DEFERRED binding the activity envelope finishes; an unresolved binding is simply absent
        (the envelope reports it as `binding.warning`).
        """
        trigger = self._trigger_output()
        scope = BindingScope(
            context=trigger[1] if trigger is not None else None,
            nodes=self._node_outputs,
            node_types=self._node_types,
            node_tasks=self._node_tasks,
            router_inputs=self._router_inputs,
            vars=self._variables(),
            run=self._run_fields(inp, now),
            consultation=consultation,
            run_payload=inp.payload,
        )
        return resolve_bindings(node.bindings or {}, scope).values

    def _v2_activity_fields(
        self,
        node: CompiledNode,
        inp: InterpreterInput,
        consultation: dict[str, Any],
        now: datetime,
        run_context: dict[str, Any],
    ) -> dict[str, Any]:
        """The protocol-v2 fields of one node activity input (pure); `{}` off protocol v2."""
        if not self._v2:
            return {}
        fields: dict[str, Any] = {
            "protocol": 2,
            "bindings": node.bindings,
            "delivery": self._delivery.get(node.node_id),
            "run_fields": self._run_fields(inp, now),
        }
        if consultation:
            fields["consultation"] = _nest_paths(consultation)
        if node.type.startswith("core."):
            # Who produced what, so the activity can serve `nodes.<id>.outputs.<field>` in its
            # templates and conditions (the dual scope) without a second copy of any output.
            fields["run_context"] = {**run_context, "nodeMeta": self._node_meta()}
        return fields

    def _node_meta(self) -> dict[str, dict[str, str]]:
        """`{nodeId: {type, task?}}` — who produced what (pure)."""
        return {
            node_id: {
                "type": node_type,
                **({"task": self._node_tasks[node_id]} if node_id in self._node_tasks else {}),
            }
            for node_id, node_type in self._node_types.items()
        }

    async def _read_consultation(
        self, inp: InterpreterInput, node_id: str, paths: list[str], snapshot: str
    ) -> ConsultationReadResult:
        consultation_id = _consultation_id_of(inp)
        if consultation_id is None or not paths or "consultation" not in self._sources:
            # Nothing to read against (no consultation, or a workflow its settings do not source
            # from one — publish refuses that graph, this is the defensive half): the bindings
            # resolve to nothing and are reported.
            return ConsultationReadResult(ok=True)
        try:
            result: ConsultationReadResult = await workflow.execute_activity(
                read_consultation,
                ConsultationReadRequest(
                    run_id=inp.run_id,
                    tenant_id=inp.tenant_id,
                    node_id=node_id,
                    consultation_id=consultation_id,
                    paths=paths,
                    snapshot="run-start" if snapshot == "run-start" else "node-start",
                ),
                start_to_close_timeout=_CONSULTATION_READ_TIMEOUT,
                retry_policy=_CONSULTATION_READ_RETRY,
            )
        except ActivityError as exc:
            return ConsultationReadResult(ok=False, error=_activity_error_reason(exc))
        return result

    async def _read_run_start(self, inp: InterpreterInput, config: CompiledWorkflowConfig) -> None:
        """OD-30 — every `runStart` declared read, once, before the walk."""
        pending = _run_start_pending(config.stages)
        if pending and workflow.patched(_CONSULTATION_READS_PATCH):
            await self._take_run_start_reads(inp, pending)
        # TASK-1038 lane E3 — the loop bodies' own run-start reads (see the marker's comment).
        loop_pending = _run_start_pending(
            stage for indexed_loop in config.loops for stage in indexed_loop.body.stages
        )
        if loop_pending and workflow.patched(_LOOP_RUN_START_READS_PATCH):
            self._loop_body_node_ids.update(node_id for node_id, _paths in loop_pending)
            await self._take_run_start_reads(inp, loop_pending)

    async def _take_run_start_reads(
        self, inp: InterpreterInput, pending: list[tuple[str, list[str]]]
    ) -> None:
        for node_id, paths in pending:
            result = await self._read_consultation(inp, node_id, paths, "run-start")
            if result.ok:
                self._run_start_reads[node_id] = dict(result.values)
            else:
                self._run_start_read_failures[node_id] = result.error or "read_failed"

    async def _consultation_values(
        self, node: CompiledNode, inp: InterpreterInput, critical: bool
    ) -> tuple[dict[str, Any], NodeResult | None]:
        """`(path → value, failure)` for one node's declared reads (node start + run start)."""
        values: dict[str, Any] = dict(self._run_start_reads.get(node.node_id, {}))
        failure_reason = self._run_start_read_failures.get(node.node_id)
        node_start = sorted({r.path for r in node.consultation_reads if r.at == "nodeStart"})
        if failure_reason is None and node_start and workflow.patched(_CONSULTATION_READS_PATCH):
            result = await self._read_consultation(inp, node.node_id, node_start, "node-start")
            if result.ok:
                values.update(result.values)
            else:
                failure_reason = result.error or "read_failed"
        if failure_reason is None:
            return values, None
        return values, NodeResult(
            node_id=node.node_id,
            node_type=node.type,
            status="FAILED" if critical else "DEGRADED",
            reason=f"{CONSULTATION_READ_FAILED}: {failure_reason}",
        )

    # TASK-864 — the `core` vocabulary's helpers. All pure except the two child dispatches.

    def _branch_skip(self, node: CompiledNode) -> bool:
        """Whether branch gating declines this node (pure). See `_preflight_skip`."""
        if node.branch_guards and not any(
            guard.handle in self._taken_handles.get(guard.from_node_id, set())
            for guard in node.branch_guards
        ):
            return True
        predecessors = {binding.from_node_id for binding in node.inputs} | {
            guard.from_node_id for guard in node.branch_guards
        }
        return bool(predecessors) and predecessors <= self._branch_skipped

    def _run_context(self) -> dict[str, Any]:
        """The run context `{trigger, vars, nodes}` (TASK-864 §3.2), from the output cache.

        `trigger` is the `core.trigger` node's published context — flat, PLUS the canonical
        `trigger.context` namespace this ticket adds; `vars` is every `core.variable` node's
        declared map, merged in stage order; `nodes` is the whole cache keyed by node id. Pure
        derived state.

        ## TASK-946 D1 / OD-3 — `trigger.context.*` is canonical on BOTH lanes

        The eleven seeded ArcaAI department graphs route the visit type on

            trigger.context.visit_type == 'new-visit' | 'revisit'

        and that read RAISED here: measured on run `01a08a8d-65fb-742b-824e-1c94af99e898`
        (2026-09-10), `interpreter.core_condition` completed
        `{"errors":[{"branch":"new_visit","error":"no such key: 'context'"}, …],
        "taken_handle":"else"}`, so a follow-up encounter was documented with the new-visit note
        shape on every consultation the platform has ever run. The graphs are not wrong: the
        REALTIME lane publishes `{trigger: {context}, vars, nodes}`
        (`live-documentation.service.ts#realtimeRunContext`) and the seed was authored against
        it. The durable lane published the flattened context AS `trigger`, so the namespace the
        seed names did not exist here. OD-3 moves this side.

        ## Why the flat top level STAYS

        The nesting is ADDITIVE. Everything that reads `trigger.<key>` today keeps reading it: a
        published graph's `core.loop` `over` path, `resolve_dotted_path(run_context, over)`, the
        run subject on `trigger.consultationId`, and — the one that would have failed silently —
        `_prompt_scope`'s `context` ALIAS (`nodes/core.py`), which the seeded
        `casenote-finalization` instruction reads as `{{context.dna_style_text | default("")}}`.
        That alias is `trigger` itself under the sole-kind rule, so moving `dna_style_text` out
        of the top level would have emptied the clinician's writing style out of the prompt
        while every test that renders it by hand stayed green.

        ## What goes IN the namespace

        The authored context overlaid by the live handoff's. `trigger.context` is unwrapped
        first when the published payload is already a single-kind ENVELOPE (`{"context": {…}}`,
        which is what a graph bound to `consultation_legacy_v1` publishes) — otherwise
        `trigger.context.safe_age` would become `trigger.context.context.safe_age` and every
        seeded read would move one level down.

        ## TASK-932 R-16a — the handoff WINS

        The clinician's effective DNA writing style is resolved GATEWAY-side at handoff time and
        arrives here; it is not, and must never be, something a caller can put in the run
        payload, so the handoff's value overrides an identically-named key that arrived with the
        invocation — in both views.
        """
        trigger: Any = {}
        variables: dict[str, Any] = {}
        for node_id, output in self._node_outputs.items():
            node_type = self._node_types.get(node_id)
            if node_type == "core.trigger" and isinstance(output.get("context"), dict):
                trigger = output["context"]
            elif node_type == "core.variable" and isinstance(output.get("vars"), dict):
                variables.update(output["vars"])
        # TASK-1038 R-3 — a trigger context stored out of band (a claim-check MARKER) cannot be
        # unwrapped here, because the workflow cannot read it. It is published as a DEFERRED view
        # instead, which the consuming activity rebuilds with the same `publish_trigger`.
        published = (
            payload_refs.deferred_trigger(trigger, self._live_context)
            if payload_refs.is_marker(trigger)
            else payload_refs.publish_trigger(trigger, self._live_context)
        )
        return {"trigger": published, "vars": variables, "nodes": dict(self._node_outputs)}

    def _trigger_output(self) -> tuple[str, Any] | None:
        """``(nodeId, context)`` of the trigger's published context, or ``None`` (pure)."""
        found: tuple[str, Any] | None = None
        for node_id, output in self._node_outputs.items():
            if self._node_types.get(node_id) == "core.trigger" and isinstance(
                output.get("context"), dict
            ):
                found = (node_id, output["context"])
        return found

    def _payload_views(
        self, inp: InterpreterInput, *, core: bool
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """TASK-1038 R-3 — ``(run_payload, run_context)`` for ONE activity input (pure).

        Before, a ``core.*`` input carried the run payload four times: ``run_payload``,
        ``run_context.trigger`` (flat), ``run_context.trigger.context``, and
        ``run_context.nodes.<trigger>.context`` — because ``core.trigger`` publishes the run
        payload unchanged as its ``context``. Now:

        * once the trigger OFFLOADED its context (a claim-check marker), the run payload itself
          travels as that marker — the trigger published it unchanged, so they are one value;
        * otherwise the payload travels once, in ``run_payload``, and the run context NAMES it
          (``$hopeRunPayload``); the node-activity envelope rebuilds every view before the node
          runs, with the same ``publish_trigger``.
        """
        trigger = self._trigger_output()
        run_payload: dict[str, Any] = inp.payload
        if trigger is not None and payload_refs.is_marker(trigger[1]):
            run_payload = trigger[1]
        if not core:
            return run_payload, {}
        context = self._run_context()
        if trigger is None or payload_refs.is_marker(trigger[1]):
            return run_payload, context
        if self._trigger_is_payload is None:
            self._trigger_is_payload = trigger[1] == inp.payload
        if not self._trigger_is_payload:
            return run_payload, context
        trigger_id = trigger[0]
        sentinel = payload_refs.run_payload_sentinel()
        nodes = dict(context["nodes"])
        nodes[trigger_id] = {**nodes[trigger_id], "context": sentinel}
        return run_payload, {
            **context,
            "trigger": payload_refs.deferred_trigger(sentinel, self._live_context),
            "nodes": nodes,
        }

    def _bound_payload_by_reference(
        self, bound: dict[str, Any], inp: InterpreterInput
    ) -> dict[str, Any]:
        """TASK-1038 R-3 — a bound value that IS the run payload is sent as the sentinel (pure).

        The edge ``trigger.out -> in`` binds the trigger's published context, which is the run
        payload unchanged — so without this the payload would travel twice in one input (once in
        ``run_payload``, once here).
        """
        trigger = self._trigger_output()
        if trigger is None or payload_refs.is_marker(trigger[1]) or not self._trigger_is_payload:
            return bound
        context = trigger[1]
        sentinel = payload_refs.run_payload_sentinel()
        return {port: (sentinel if value is context else value) for port, value in bound.items()}

    async def _resolve_context_path(
        self, inp: InterpreterInput, run_context: dict[str, Any], path: str
    ) -> Any:
        """TASK-1038 R-3 — resolve a dotted path that crosses a reference, in an ACTIVITY.

        The workflow cannot read a claim-checked value, so a ``core.loop``'s ``over`` path that
        walks into one is resolved by ``interpreter.resolve_context_path``. ``MISSING`` when the
        activity finds nothing (or cannot run): the loop then degrades exactly as it always did
        for an unresolvable path, observably.
        """
        try:
            answer: ContextPathResult = await workflow.execute_activity(
                resolve_context_path,
                ContextPathRequest(
                    run_context=run_context,
                    run_payload=self._payload_views(inp, core=False)[0],
                    path=path,
                ),
                start_to_close_timeout=_CONTEXT_PATH_TIMEOUT,
                retry_policy=_CONTEXT_PATH_RETRY,
            )
        except ActivityError:
            return MISSING
        return answer.value if answer.found else MISSING

    async def _run_review(
        self, node: CompiledNode, inp: InterpreterInput, bound: dict[str, Any] | None = None
    ) -> NodeResult:
        """Dispatch a `core.humanReview` as a `ReviewGateWorkflow` child and TAKE its outcome
        as a branch. `approved` and `rejected` are both decisions the graph routes (SUCCEEDED);
        `timedOut` is the absence of one (DEGRADED, reason `review_timed_out`) — never approval.

        TASK-946 D3 / OD-4 — a gate is never opened on an EMPTY payload. Measured on the three
        trials of 2026-09-10: the upstream `n_finalize` degraded ("core.agent: nothing bound on
        `in`/`context` to generate from"), the gate was started on `{}`, a clinician was
        asked to sign nothing for the full 3,600 s deadline, and only then did `n_output` fail
        its schema — so the run closed FAILED an hour after the consultation had stopped. The
        hour is pure loss: there is no payload a clinician could approve, and no decision they
        could make that would produce one. The node degrades instead, exactly as a
        `review_timed_out` does, and the walk reaches its real terminal state in seconds.

        The degrade is deliberate — not a FAILED. This is the same outcome shape the timeout
        branch returns, so the run's cause of death stays whatever the graph was actually unable
        to produce (`n_output`'s schema check) rather than moving onto the gate.
        """
        payload = bound if bound is not None else self._resolve_bound_inputs(node)
        if _is_empty_review_payload(payload) and workflow.patched(_REVIEW_SKIP_PATCH):
            # No decision was made, so NO handle is taken and NO `decision` output is published:
            # every branch guarded on `approved`/`rejected`/`timedOut` skips as
            # `branch_not_taken`, and nothing downstream can read a decision that never happened.
            # Recording `timedOut` here would be the one lie available — the gate did not time
            # out, it was never opened.
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="DEGRADED",
                reason="review_skipped_empty_payload",
            )
        config = node.config
        raw_escalation = config.get("escalation")
        escalation: dict[str, Any] = raw_escalation if isinstance(raw_escalation, dict) else {}
        review_input = ReviewGateInput(
            run_id=inp.run_id,
            node_id=node.node_id,
            tenant_id=inp.tenant_id,
            workflow_version_id=inp.workflow_version_id,
            review_type=str(config.get("reviewType") or "approval"),
            instructions=(
                config.get("instructions") if isinstance(config.get("instructions"), str) else None
            ),
            assign_role=(
                config.get("assignRole") if isinstance(config.get("assignRole"), str) else None
            ),
            timeout_seconds=int(config.get("timeoutSeconds") or node.timeout_seconds),
            escalation_after_seconds=(
                int(escalation["afterSeconds"])
                if isinstance(escalation.get("afterSeconds"), int)
                else None
            ),
            max_escalations=(
                int(escalation["maxEscalations"])
                if isinstance(escalation.get("maxEscalations"), int)
                else 0
            ),
            allow_edit=config.get("allowEdit") is True,
            payload=payload,
            trajectory=TrajectoryContext(
                tenant_id=inp.tenant_id,
                seq=self._next_seq(),
                workflow_version_id=inp.workflow_version_id,
                stage_id="review",
                node_id=node.node_id,
                node_type=node.type,
                doctor_id=_run_doctor_id(inp),
            ),
        )
        # TASK-1038 D-B — a review is a durable wait on a clinician: not charged to the budget.
        self._pause_clock()
        try:
            result: ReviewGateResult = await workflow.execute_child_workflow(
                ReviewGateWorkflow.run,
                review_input,
                id=review_gate_workflow_id(inp.run_id, node.node_id),
            )
        except Exception:  # noqa: BLE001 — ChildWorkflowError and cancellation both land here
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="DEGRADED",
                reason="review_unavailable",
            )
        finally:
            self._resume_clock()

        self._node_outputs[node.node_id] = {"decision": result.model_dump()}
        if self._v2:
            self._walk_outputs[node.node_id] = {"decision": result.model_dump(mode="json")}
        self._taken_handles[node.node_id] = {result.outcome}
        if result.outcome == "timedOut":
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="DEGRADED",
                reason="review_timed_out",
            )
        return NodeResult(node_id=node.node_id, node_type=node.type, status="SUCCEEDED")

    async def _run_core_loop(
        self, node: CompiledNode, inp: InterpreterInput, bound: dict[str, Any] | None = None
    ) -> NodeResult:
        """Dispatch a `core.loop` as a `LoopWorkflow` child over its compiled body, racing it
        against the parent-owned `maxDurationSeconds` timer (the one bound a continue-as-new
        chain cannot carry itself — see `loop_workflow.py`)."""
        body = self._loops_by_id.get(node.node_id)
        if body is None:
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="DEGRADED",
                reason="loop_body_missing",
            )
        config = node.config
        mode = config.get("mode")
        run_context = self._run_context()
        items: list[Any] = []
        if mode == "foreach":
            over = config.get("over")
            resolved = resolve_dotted_path(run_context, over) if isinstance(over, str) else MISSING
            if (
                not isinstance(resolved, list)
                and isinstance(over, str)
                and payload_refs.reference_on_path(run_context, over)
                and workflow.patched(_PAYLOAD_REFS_PATCH)
            ):
                resolved = await self._resolve_context_path(inp, run_context, over)
            if not isinstance(resolved, list):
                return NodeResult(
                    node_id=node.node_id,
                    node_type=node.type,
                    status="DEGRADED",
                    reason="loop_over_unresolvable",
                )
            items = resolved

        if self._v2:
            run_context = {**run_context, "nodeMeta": self._node_meta()}
        loop_input = CoreLoopInput(
            run_id=inp.run_id,
            node_id=node.node_id,
            tenant_id=inp.tenant_id,
            workflow_version_id=inp.workflow_version_id,
            sandbox=inp.sandbox,
            mode="foreach" if mode == "foreach" else "while",
            items=items,
            until=config.get("until") if isinstance(config.get("until"), str) else None,
            collect=config.get("collect") if isinstance(config.get("collect"), str) else None,
            bounds=CoreLoopBounds.model_validate(config.get("bounds") or {}),
            body=body,
            nested=dict(self._loops_by_id),
            seed_inputs=bound if bound is not None else self._resolve_bound_inputs(node),
            run_payload=(
                self._payload_views(inp, core=False)[0]
                if workflow.patched(_PAYLOAD_REFS_PATCH)
                else inp.payload
            ),
            run_context=run_context,
            protocol=2 if self._v2 else None,
            # TASK-1038 lane E3 — empty unless `_LOOP_RUN_START_READS_PATCH` took body reads.
            run_start_reads={
                node_id: values
                for node_id, values in self._run_start_reads.items()
                if node_id in self._loop_body_node_ids
            },
            run_start_read_failures={
                node_id: reason
                for node_id, reason in self._run_start_read_failures.items()
                if node_id in self._loop_body_node_ids
            },
        )
        max_duration = int(loop_input.bounds.max_duration_seconds)
        try:
            result: CoreLoopResult = await asyncio.wait_for(
                workflow.execute_child_workflow(
                    LoopWorkflow.run,
                    loop_input,
                    id=core_loop_workflow_id(inp.run_id, node.node_id),
                ),
                timeout=max_duration,
            )
        except TimeoutError:
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="DEGRADED",
                reason=_LOOP_DURATION_REASON,
            )
        except Exception:  # noqa: BLE001 — ChildWorkflowError and cancellation both land here
            return NodeResult(
                node_id=node.node_id,
                node_type=node.type,
                status="DEGRADED",
                reason="loop_unavailable",
            )

        self._node_outputs[node.node_id] = {
            "result": result.result,
            "iterations": result.iterations,
            "stopReason": result.stop_reason,
        }
        if self._v2:
            self._walk_outputs[node.node_id] = {"result": result.result}
        if result.stop_reason in ("items_exhausted", "until", "no_progress_iterations"):
            return NodeResult(node_id=node.node_id, node_type=node.type, status="SUCCEEDED")
        return NodeResult(
            node_id=node.node_id,
            node_type=node.type,
            status="DEGRADED",
            reason=result.stop_reason,
        )

    async def _run_gate(
        self, gate: CompiledGate, inp: InterpreterInput, *, blocked: bool
    ) -> NodeResult:
        """Execute the one blocking HITL gate as a CHILD workflow.

        A child rather than an in-line `wait_condition` is what keeps the interpreter's own
        signal surface run-level only (`cancel`; TASK-1050's `guardrail_resolution`) — see
        `gate_workflow.py`'s module docstring for why this is a new workflow type rather than the
        `HarnessDocWorkflow` delegation `palette-contract.md` originally chose.

        Three refusals, all of them loud and none of them a wait:

        * **Sandbox.** A Workbench run must never park on a human. The gate node is
          `external_write: true`, but the stage-level sandbox suppression cannot reach it (the
          gate is not in `stages`), so the check is repeated here — this is the one place it can
          be made.
        * **A failed critical node upstream.** There is no draft to sign off; asking a clinician
          to approve a run that already failed would be asking them to attest to nothing.
        * **A missing consultation id.** The gate's whole side effect (escalations, the WORM
          `GATE_DECISION`) is consultation-scoped; without one there is nothing to record
          against, and inventing a target would put a decision on the wrong record.
        """
        spec = NODE_REGISTRY.get(gate.gate_type)
        node_type = gate.gate_type

        if spec is None or not spec.implemented:
            return NodeResult(
                node_id=gate.node_id,
                node_type=node_type,
                status="SKIPPED",
                reason="unsupported_node_type",
            )

        if inp.sandbox:
            return NodeResult(
                node_id=gate.node_id, node_type=node_type, status="SKIPPED", reason="sandbox"
            )

        if blocked:
            return NodeResult(
                node_id=gate.node_id,
                node_type=node_type,
                status="SKIPPED",
                reason="upstream_failed",
            )

        consultation_id = inp.payload.get("consultationId")
        if not isinstance(consultation_id, str) or not consultation_id:
            # `critical: true` on the gate node makes this a run-level FAILED, which is correct:
            # a consultation graph that reached its gate with no consultation to gate is not a
            # run that succeeded.
            return NodeResult(
                node_id=gate.node_id,
                node_type=node_type,
                status="FAILED",
                reason="no_consultation_id",
            )

        gate_input = ConsultationGateInput(
            run_id=inp.run_id,
            node_id=gate.node_id,
            tenant_id=inp.tenant_id,
            consultation_id=consultation_id,
            user_id=_opt_str(inp.payload.get("userId")),
            job_id=_opt_str(inp.payload.get("jobId")),
            context_item_id=_opt_str(self._gate_context_item_id()),
            gate_type=node_type,
            timeout_seconds=gate.timeout_seconds,
            on_timeout=gate.on_timeout,
            trajectory=TrajectoryContext(
                tenant_id=inp.tenant_id,
                seq=self._next_seq(),
                workflow_version_id=inp.workflow_version_id,
                stage_id="gate",
                node_id=gate.node_id,
                node_type=node_type,
                doctor_id=_run_doctor_id(inp),
            ),
        )

        gate_child = workflow.execute_child_workflow(
            ConsultationGateWorkflow.run,
            gate_input,
            # Deterministic, derived from the parent's run id — never `uuid4()` inside a
            # workflow body. Same task queue by inheritance (worker.py hosts both types).
            id=gate_workflow_id(inp.run_id),
        )
        result: ConsultationGateResult
        self._pause_clock()
        try:
            if self._bounded:
                # TASK-1038 R-4 — a cancel stops the wait on the clinician too.
                interrupted, result = await self._await_cancellable(gate_child)
                if interrupted:
                    return NodeResult(
                        node_id=gate.node_id,
                        node_type=node_type,
                        status="SKIPPED",
                        reason="cancelled",
                    )
            else:
                result = await gate_child
        except Exception:  # noqa: BLE001 — ChildWorkflowError and cancellation both land here
            # A gate that could not run is NOT an approval. `critical: true` promotes this to a
            # run-level FAILED, which is the only safe reading.
            return NodeResult(
                node_id=gate.node_id,
                node_type=node_type,
                status="FAILED",
                reason="gate_unavailable",
            )
        finally:
            self._resume_clock()

        if result.approved:
            self._node_outputs[gate.node_id] = {
                "approved": True,
                "decision": result.decision,
                "clinicianId": result.clinician_id,
                "contextItemVersionId": result.context_item_version_id,
            }
            return NodeResult(node_id=gate.node_id, node_type=node_type, status="SUCCEEDED")

        # ABANDONED — the SLA ladder ran out without a clinician decision. DEGRADED here would be
        # promoted to FAILED anyway (the gate is `critical: true`); naming it FAILED directly
        # keeps the reason honest rather than routing an unsigned gate through a "degraded" word.
        return NodeResult(
            node_id=gate.node_id, node_type=node_type, status="FAILED", reason="gate_abandoned"
        )

    def _gate_context_item_id(self) -> str | None:
        """The `contextItemId` a `consultation.persistDraft` node published upstream, if any —
        read from the workflow-owned node-output cache, never re-derived."""
        for output in self._node_outputs.values():
            candidate = output.get("contextItemId")
            if isinstance(candidate, str) and candidate:
                return candidate
        return None

    @workflow.signal(name="cancel")
    async def cancel(self, signal: CancelSignal | None = None) -> None:
        """The ONLY signal this workflow accepts — a code allow-list, never a name pass-through
        (F-09, orchestration.md, is the anti-pattern this must not repeat)."""
        self._cancelled = True
        self._cancel_reason = signal.reason if signal else None

    @workflow.signal(name="guardrail_resolution")
    def guardrail_resolution(self, signal: GuardrailResolutionSignal) -> None:
        """TASK-1050 W2f — how a guardrail hold was resolved. Admitted ONLY for a hold the walk is
        parked on, once; anything else (an unknown notice, a hold already resolved or timed out) is
        dropped — the resolution route answers 409 for it before it ever signals."""
        if (
            signal.notice_id in self._pending_holds
            and signal.notice_id not in self._hold_resolutions
        ):
            self._hold_resolutions[signal.notice_id] = signal

    @workflow.query(name="guardrail_holds")
    def guardrail_holds(self) -> list[GuardrailHoldState]:
        """TASK-1050 W2f — the guardrail holds the walk is parked on right now."""
        return list(self._pending_holds.values())

    @workflow.query(name="state")
    def state(self) -> InterpreterStateQueryResult:
        return InterpreterStateQueryResult(
            run_id=self._run_id, status=self._status, stages=self._stages
        )
