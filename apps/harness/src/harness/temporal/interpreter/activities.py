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


NODE_ACTIVITIES: list[Callable[..., Any]] = [
    interpreter_noop,
    interpreter_passthrough,
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
