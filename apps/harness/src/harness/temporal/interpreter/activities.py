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
from harness.temporal.activities import (
    STATUS_ERROR,
    STATUS_OK,
    STEP_NODE,
    _now,
)
from harness.temporal.activities import (
    _TrajectoryBatch as TrajectoryBatch,  # reuse, never a second emitter (Task 7) — noqa: SLF001
)
from harness.temporal.claim_check import ClaimCheckRef, build_blob_store, load_blob
from harness.temporal.interpreter.compiled_config import CompiledWorkflowConfig, parse_and_verify
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
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
from harness.temporal.interpreter.nodes.deliver import interpreter_deliver
from harness.temporal.interpreter.nodes.guardrail_check import interpreter_guardrail_check
from harness.temporal.interpreter.nodes.stt_placeholder import (
    interpreter_stt_asr_engine,
    interpreter_stt_audio_input,
    interpreter_stt_diarization,
    interpreter_stt_language_detection,
    interpreter_stt_noise_filter,
    interpreter_stt_phi_hop,
    interpreter_stt_transcript_output,
    interpreter_stt_vad,
)
from harness.temporal.interpreter.nodes.template_ref import interpreter_template_ref
from harness.temporal.interpreter.nodes.text_generate import interpreter_text_generate

# ---------------------------------------------------------------------------
# Seed node activities (Task 4/6's tests dispatch against these; TASK-720 adds
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
    workflow's per-node wrapper — see contracts/execution-semantics.md §Worked example). An
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
    # Summarization palette (TASK-720 Task 4/5) — see nodes/{context_binding,template_ref,
    # text_generate,guardrail_check,deliver}.py.
    interpreter_context_binding,
    interpreter_template_ref,
    interpreter_text_generate,
    interpreter_guardrail_check,
    interpreter_deliver,
    # STT palette (TASK-724 Task 3) — placeholders, see nodes/stt_placeholder.py.
    interpreter_stt_audio_input,
    interpreter_stt_vad,
    interpreter_stt_noise_filter,
    interpreter_stt_diarization,
    interpreter_stt_language_detection,
    interpreter_stt_asr_engine,
    interpreter_stt_transcript_output,
    interpreter_stt_phi_hop,
    # Consultation palette — all 13 node types. consentGate/phiHop/hitlGate came from TASK-731
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
    # R3's three missing capabilities (TASK-791 W1-W3) — nodes/consultation_realtime.py.
    # This list and `registry.py`'s NODE_REGISTRY are two SEPARATE hand-maintained lists: the
    # registry decides what the interpreter DISPATCHES, this decides what the worker SERVES. A
    # node in the first but not the second compiles, validates and passes the cross-language
    # parity guard, then fails at runtime with an unregistered-activity error. Nothing enforced
    # the agreement until `test_realtime_capability_nodes.py`'s
    # `test_every_registered_node_activity_is_served_by_the_worker`.
    interpreter_consultation_realtime_summary,
    interpreter_consultation_suggestions,
    interpreter_consultation_propose_corrections,
]

# ---------------------------------------------------------------------------
# Claim-check config loader (Task 5, S-2) — the ONLY place compiledConfig is
# dereferenced. The workflow body never calls claim_check directly.
# ---------------------------------------------------------------------------


@activity.defn(name="interpreter.load_config")
async def load_config(ref: ClaimCheckRef) -> CompiledWorkflowConfig:
    """Dereference + admit a compiledConfig blob. Fails LOUD on any admission violation.

    See contracts/execution-semantics.md §2 for the six-step admission sequence this performs
    (dereference, parse, formatVersion check, checksum verify, gates-empty check, structural
    bounds). A corrupt/invalid config must fail the run — never execute a partial graph.
    """
    settings = get_settings()
    store = build_blob_store(settings.claim_check)
    # ClaimCheckNotFound / ClaimCheckIntegrityError propagate unmodified — fail loud
    # (S-2's contract), never substitute an empty config.
    raw = await load_blob(ref, store=store)
    return parse_and_verify(raw)


# Registered on the worker (Task 8) alongside DOCUMENT_ACTIVITIES/LOOP_ACTIVITIES/
# REASONING_ACTIVITIES — the interpreter's own activity list.
INTERPRETER_ACTIVITIES: list[Callable[..., Any]] = [
    *NODE_ACTIVITIES,
    load_config,
]
