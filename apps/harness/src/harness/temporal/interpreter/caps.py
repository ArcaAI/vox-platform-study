"""Platform caps for the interpreter — a defense-in-depth re-clamp, not the primary enforcement.

Per-node ``timeoutSeconds``/``retry`` on ``compiledConfig`` are ALREADY clamped to platform
ceilings at compile time by the TypeScript compiler (``packages/workflow-contract/src/compiler.ts``
see, normative
rule "Platform ceilings materialized at compile time ... applied HERE, not read again at
runtime"). This module is a SECOND, independent, tighten-only clamp the interpreter applies to
whatever the compiled config claims — the same "independent defence" posture as
``worker.py``'s ``_assert_claim_check_store_is_deployable``. No ``GlobalSetting`` (or any other
I/O) is read here: every value is a module constant, so this module is safe to import and call
from the deterministic workflow body.

rationale behind each concrete value.
"""

from __future__ import annotations

from typing import Any

# Per-node ceilings.
MAX_NODE_TIMEOUT_SECONDS = 900
MAX_NODE_ATTEMPTS = 5

# Whole-run / whole-config ceilings.
MAX_TOTAL_SECONDS = 3600
MAX_STAGES = 50
MAX_NODES_PER_STAGE = 32
# Deliberately tighter than MAX_STAGES * MAX_NODES_PER_STAGE (1,600) so this is an
# independent bound, not a restatement of the other two.
MAX_TOTAL_NODES = 500
# HITL gates per run. One durable human wait, matching the validator's own
# SINGLE_ENTRY rule on the gate node type; a second gate would need a second child workflow id
# and a second approve route, neither of which exists.
MAX_GATES = 1


def clamp_timeout(requested_seconds: int) -> int:
    """Tighten-only: a tenant may request less than the platform ceiling, never more."""
    return min(requested_seconds, MAX_NODE_TIMEOUT_SECONDS)


def clamp_attempts(requested_attempts: int) -> int:
    """Tighten-only: a tenant may request fewer attempts than the platform ceiling, never more."""
    return min(requested_attempts, MAX_NODE_ATTEMPTS)


# ---------------------------------------------------------------------------
# TASK-1038 D-B — the whole-run bound.
# ---------------------------------------------------------------------------

#: The longest a consultation-bound run parks waiting for its live session to hand off (the
#: workflow's own `_LIVE_HANDOFF_MAX_WAIT`, defined here so the dispatcher's backstop and the
#: walk's wait cannot disagree). A durable wait on a clinician, not compute: it is NOT charged to
#: `maxTotalSeconds`.
LIVE_HANDOFF_MAX_WAIT_SECONDS = 7200

#: Headroom the Temporal `execution_timeout` backstop adds on top of everything the walk may
#: legitimately spend, so the in-workflow deadline always fires first and has time to cancel
#: in-flight work, settle the stage and emit `workflow.run.completed` with `TIMED_OUT`.
RUN_TIMEOUT_GRACE_SECONDS = 300


#: TASK-1042 OD-4a — the longest a run bound to a LIVE STT session (C7 ``liveAudio``) parks
#: before its stage walk, waiting for the integrator's audio to end. Like the live handoff it is a
#: durable wait on a person, not compute: it is NOT charged to ``maxTotalSeconds``. The gateway's
#: ``workflowRuns.liveAudioMaxSeconds`` may only TIGHTEN it (``live_audio_wait_seconds``).
LIVE_AUDIO_MAX_WAIT_SECONDS = 3600


def live_audio_wait_seconds(requested_seconds: int | None) -> int:
    """Tighten-only: the gateway-resolved ceiling, never above the platform constant (which also
    applies when the gateway sent none)."""
    if requested_seconds is None:
        return LIVE_AUDIO_MAX_WAIT_SECONDS
    return max(1, min(requested_seconds, LIVE_AUDIO_MAX_WAIT_SECONDS))


def run_budget_seconds(max_total_seconds: int) -> int:
    """The compute budget a run may spend (tighten-only, like every other cap; never < 1)."""
    return max(1, min(max_total_seconds, MAX_TOTAL_SECONDS))


def execution_timeout_seconds(
    config: Any, *, consultation_bound: bool, live_audio_seconds: int | None = None
) -> int | None:
    """The Temporal ``execution_timeout`` BACKSTOP for a run of ``config``, or ``None``.

    The primary bound is the in-workflow deadline (``workflow.py``), which charges compute only:
    the live-handoff wait, the live-audio wait (TASK-1042, ``live_audio_seconds`` = the run's
    already-clamped ceiling, ``None`` for a run with no live audio) and every human review are
    excluded from ``maxTotalSeconds``. The
    backstop therefore adds the longest each of those may legitimately last, plus a grace — and
    is ``None`` when one of them has no ceiling the compiled config states:

    * a blocking HITL gate (its SLA ladder comes from the tenant's harness policy at run time);
    * a ``core.humanReview`` inside a loop body (it may run once per iteration).
    """
    if config.gates:
        return None
    for loop in getattr(config, "loops", []) or []:
        for stage in loop.body.stages:
            if any(node.type == "core.humanReview" for node in stage.nodes):
                return None
    seconds = run_budget_seconds(config.caps.max_total_seconds)
    for stage in config.stages:
        for node in stage.nodes:
            if node.type == "core.humanReview":
                seconds += review_wait_seconds(node)
    if consultation_bound:
        seconds += LIVE_HANDOFF_MAX_WAIT_SECONDS
    if live_audio_seconds is not None:
        seconds += live_audio_wait_seconds(live_audio_seconds)
    return seconds + RUN_TIMEOUT_GRACE_SECONDS


def review_wait_seconds(node: Any) -> int:
    """How long one ``core.humanReview`` may wait — the same expression the walk hands its
    ``ReviewGateWorkflow`` child (``workflow._run_review``)."""
    return int(node.config.get("timeoutSeconds") or node.timeout_seconds)
