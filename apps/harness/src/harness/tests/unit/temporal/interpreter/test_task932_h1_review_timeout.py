"""`core.humanReview` timeout resolution — the clinician gate's fall-through.

`_run_review` resolves the child's deadline as
``int(config.get("timeoutSeconds") or node.timeout_seconds)``. Only the OVERRIDE lives on the
node config; the fall-through is the compiled node's own timeout, which the gateway compiler
writes from `NODE_REGISTRY["core.humanReview"].default_timeout_seconds`.

This matters because the two operands fail differently: a missing override is normal (most
graphs do not set one), while a `0`/`None` override must NOT become a zero-second deadline that
times the clinician's gate out instantly. The `or` is what makes both fall through, and this
pins that behaviour on the real dispatch path rather than on a copy of the expression.
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


class _Captured(Exception):
    """Raised by the child-workflow stub once the input has been captured."""


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
        }
    )


async def _dispatch(monkeypatch: pytest.MonkeyPatch, config: dict[str, Any]):
    """Run `_run_review` far enough to capture the `ReviewGateInput` it builds."""
    captured: dict[str, Any] = {}

    async def _stub(_run, review_input, **kwargs):
        captured["input"] = review_input
        captured["id"] = kwargs.get("id")
        raise _Captured

    monkeypatch.setattr(temporal_workflow, "execute_child_workflow", _stub)

    interpreter = WorkflowInterpreter()
    node = _review_node(config)
    inp = InterpreterInput(
        run_id="run-1",
        session_id="session-1",
        tenant_id="tenant-1",
        workflow_version_id="wfv-1",
        config_ref=ClaimCheckRef(
            store="memory", bucket="harness-claim-check", key="cfg-1", size=1, sha256="0" * 64
        ),
    )
    # `_run_review` swallows the child failure into a DEGRADED result; the capture is the point.
    result = await interpreter._run_review(node, inp)
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
