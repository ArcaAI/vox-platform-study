"""`core.humanReview` — the clinician gate's deadline, and what it refuses to open on.

Two things this file pins, both on the real `_run_review` dispatch path rather than on a copy of
the expression:

**The deadline (TASK-932 H1).** `_run_review` resolves the child's deadline as
``int(config.get("timeoutSeconds") or node.timeout_seconds)``. Only the OVERRIDE lives on the
node config; the fall-through is the compiled node's own timeout, which the gateway compiler
writes from `NODE_REGISTRY["core.humanReview"].default_timeout_seconds`. The two operands fail
differently: a missing override is normal (most graphs do not set one), while a `0`/`None`
override must NOT become a zero-second deadline that times the clinician's gate out instantly.

**The empty payload (TASK-946 D3 / OD-4).** Measured on the three trials of 2026-09-10: the
upstream `n_finalize` degraded (``core.agent: nothing bound on `in`/`context` to generate
from``), so the gate was started with ``payload={}``, a clinician waited on an empty note for the
full 3,600 s deadline, `n_output` then failed its schema, and the run closed FAILED one hour
after the consultation had stopped. A clinician cannot sign an empty note — so the gate is not
opened at all, the node degrades `review_skipped_empty_payload`, and the run reaches its real
failure in seconds instead of an hour.
"""

from __future__ import annotations

from typing import Any

import pytest
from temporalio import workflow as temporal_workflow

from harness.temporal.claim_check import ClaimCheckRef
from harness.temporal.interpreter.compiled_config import CompiledNode
from harness.temporal.interpreter.models import InterpreterInput
from harness.temporal.interpreter.registry import NODE_REGISTRY
from harness.temporal.interpreter.review_workflow import review_gate_workflow_id
from harness.temporal.interpreter.workflow import WorkflowInterpreter

_DEFAULT = NODE_REGISTRY["core.humanReview"].default_timeout_seconds

#: A finalized note worth a clinician's signature — what the gate exists to show.
_DRAFT = "S: chest pain, 3 days.\nO: BP 130/85.\nA: stable angina.\nP: ECG, troponin."

#: The upstream produced NO output at all — the shape a DEGRADED `core.agent` leaves behind, and
#: the one the three trials of 2026-09-10 actually hit.
_UNBOUND = object()


class _Captured(Exception):
    """Raised by the child-workflow stub once the input has been captured."""


def _input() -> InterpreterInput:
    return InterpreterInput(
        run_id="run-1",
        session_id="session-1",
        tenant_id="tenant-1",
        workflow_version_id="wfv-1",
        config_ref=ClaimCheckRef(
            store="memory", bucket="harness-claim-check", key="cfg-1", size=1, sha256="0" * 64
        ),
    )


def _interpreter(finalized: Any) -> WorkflowInterpreter:
    """An interpreter mid-walk, with `n_finalize` settled the way `finalized` says.

    The binding is resolved by the REAL `_resolve_bound_inputs`, so what reaches `payload` is
    what a run would produce: `_UNBOUND` stores no output at all (the degraded-agent case) and
    every other value is published on the `text` key `core.agent`'s `out` socket carries.
    """
    interpreter = WorkflowInterpreter()
    interpreter._node_types["n_finalize"] = "core.agent"
    if finalized is not _UNBOUND:
        interpreter._node_outputs["n_finalize"] = {"text": finalized}
    return interpreter


def _review_node(config: dict[str, Any]) -> CompiledNode:
    return CompiledNode.model_validate(
        {
            "nodeId": "n_review",
            "type": "core.humanReview",
            "activity": "interpreter.core_human_review",
            "config": config,
            # what the gateway compiler writes for a node with no authored override
            "timeoutSeconds": _DEFAULT,
            "retry": {"maximumAttempts": 1, "initialIntervalSeconds": 1, "backoffCoefficient": 2.0},
            "onError": "degrade",
            "emitsTrajectory": True,
            # The finalizer -> gate edge every seeded consultation graph carries. Present on the
            # deadline cases too: since OD-4 an UNBOUND gate is never opened, so a node with no
            # inputs would exercise the skip rather than the deadline.
            "inputs": [{"fromNodeId": "n_finalize", "fromPort": "out", "toPort": "in"}],
        }
    )


async def _dispatch(
    monkeypatch: pytest.MonkeyPatch, config: dict[str, Any], finalized: Any = _DRAFT
):
    """Run `_run_review` far enough to capture the `ReviewGateInput` it builds."""
    captured: dict[str, Any] = {}

    async def _stub(_run, review_input, **kwargs):
        captured["input"] = review_input
        captured["id"] = kwargs.get("id")
        raise _Captured

    monkeypatch.setattr(temporal_workflow, "execute_child_workflow", _stub)

    interpreter = _interpreter(finalized)
    node = _review_node(config)
    # `_run_review` swallows the child failure into a DEGRADED result; the capture is the point.
    result = await interpreter._run_review(node, _input())
    assert result.status == "DEGRADED" and result.reason == "review_unavailable"
    return captured


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "config",
    [
        pytest.param({}, id="no-override"),
        pytest.param({"timeoutSeconds": None}, id="null-override"),
        pytest.param({"timeoutSeconds": 0}, id="zero-override"),
    ],
)
async def test_review_without_a_usable_override_falls_back_to_the_registry_default(
    monkeypatch: pytest.MonkeyPatch, config: dict[str, Any]
):
    captured = await _dispatch(monkeypatch, config)
    assert captured["input"].timeout_seconds == _DEFAULT == 3600
    assert captured["id"] == review_gate_workflow_id("run-1", "n_review")


@pytest.mark.asyncio
async def test_an_authored_override_still_wins(monkeypatch: pytest.MonkeyPatch):
    captured = await _dispatch(monkeypatch, {"timeoutSeconds": 120})
    assert captured["input"].timeout_seconds == 120


@pytest.mark.asyncio
async def test_the_bound_draft_is_what_the_gate_is_opened_on(monkeypatch: pytest.MonkeyPatch):
    """The deadline cases above are only about the deadline BECAUSE a draft was bound."""
    captured = await _dispatch(monkeypatch, {})
    assert captured["input"].payload == {"in": _DRAFT}


# -------------------------------------------------------------------------------------------
# TASK-946 D3 / OD-4 — a gate is never opened on an empty payload
# -------------------------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "finalized",
    [
        pytest.param(_UNBOUND, id="nothing-bound"),
        pytest.param(None, id="null"),
        pytest.param("", id="empty-string"),
        pytest.param({}, id="empty-dict"),
        pytest.param([], id="empty-list"),
    ],
)
async def test_an_empty_payload_degrades_instead_of_opening_the_gate(
    monkeypatch: pytest.MonkeyPatch, finalized: Any
):
    """No child is STARTED — which is the whole fix: the hour on the gate is pure loss.

    The node still DEGRADES rather than failing, so the run walks on exactly as it did after a
    `review_timed_out` and reaches its real terminal state (`n_output`'s schema failure) in
    seconds. Promoting it to FAILED here would move the run's cause of death onto the gate.
    """
    started: list[Any] = []

    async def _stub(_run, review_input, **kwargs):
        started.append(review_input)
        raise _Captured

    monkeypatch.setattr(temporal_workflow, "execute_child_workflow", _stub)
    monkeypatch.setattr(temporal_workflow, "patched", lambda _id: True)

    interpreter = _interpreter(finalized)
    result = await interpreter._run_review(_review_node({}), _input())

    assert started == []
    assert result.status == "DEGRADED"
    assert result.reason == "review_skipped_empty_payload"
    # No decision was made, so no decision handle is taken: every branch guarded on
    # `approved`/`rejected`/`timedOut` skips as `branch_not_taken`, and nothing downstream can
    # read a `decision` this gate never produced.
    assert interpreter._taken_handles.get("n_review") in (None, set())
    assert "n_review" not in interpreter._node_outputs


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "finalized",
    [
        pytest.param(_DRAFT, id="text"),
        pytest.param(0, id="zero"),
        pytest.param(False, id="false"),
        pytest.param({"sections": {"S": "chest pain"}}, id="sections"),
        pytest.param({"sections": {}}, id="shaped-but-hollow"),
    ],
)
async def test_a_payload_with_any_real_value_still_opens_the_gate(
    monkeypatch: pytest.MonkeyPatch, finalized: Any
):
    """`0` and `False` are ANSWERS. Only absent/empty is nothing to review — a truthiness test
    here would refuse to show a clinician a legitimate zero.

    The rule reads the payload's own values and does not recurse: `{"sections": {}}` is a note
    the generator SHAPED, and whether its contents satisfy the graph is `n_output`'s schema
    check to make, not this gate's. The line is drawn where the interpreter can be certain —
    nothing was bound, or what was bound is empty — because a gate that decides a clinician has
    nothing to read is refusing them a decision.
    """
    captured = await _dispatch(monkeypatch, {}, finalized)
    assert captured["input"].payload == {"in": finalized}


@pytest.mark.asyncio
async def test_an_old_history_replaying_still_opens_the_gate(monkeypatch: pytest.MonkeyPatch):
    """Replay safety: skipping the child REMOVES a command, so an execution recorded before this
    change must keep starting it. `workflow.patched` is consulted only on the empty branch, so a
    bound gate never records a marker either."""
    captured: dict[str, Any] = {}

    async def _stub(_run, review_input, **kwargs):
        captured["input"] = review_input
        raise _Captured

    monkeypatch.setattr(temporal_workflow, "execute_child_workflow", _stub)
    monkeypatch.setattr(temporal_workflow, "patched", lambda _id: False)

    interpreter = _interpreter(_UNBOUND)
    result = await interpreter._run_review(_review_node({}), _input())

    assert captured["input"].payload == {}
    assert result.status == "DEGRADED" and result.reason == "review_unavailable"
