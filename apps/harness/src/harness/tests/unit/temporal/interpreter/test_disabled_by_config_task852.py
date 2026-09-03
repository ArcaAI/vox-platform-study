"""item 4 — the durable interpreter honours the same per-node enabled toggle the
realtime lane already does.

realtime executor has read config.enabled since it shipped
(``realtime-lane.ts``: ``enabled: node.config?.enabled !== false``). ``_dispatch_node`` never
did. A toggle honoured by one runtime and ignored by the other is worse than no toggle: an
admin switches a node off, watches the live lane stop running it, and the durable lane keeps
executing it on every finalize — including the ``external_write`` nodes.

The skip is a PURE read of an already-deserialised ``CompiledNode``: no I/O, no clock, no env,
no ``workflow.*`` call. It is therefore replay-safe for the same reason the ``realtime_lane``
and ``activity_mismatch`` skips above it are, and these tests exercise ``_dispatch_node``
directly with no Temporal server (the same hermetic approach as
``test_bound_input_resolution.py`` — ``WorkflowInterpreter.__init__`` sets plain fields).

Ordering matters and is asserted: lane ownership is decided FIRST. A ``realtime`` node is not
this runtime's to report on at all, so a disabled realtime node must still come back as
``realtime_lane`` — exactly one runtime ever speaks for a given node.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.claim_check import ClaimCheckRef
from harness.temporal.interpreter.compiled_config import CompiledNode
from harness.temporal.interpreter.models import InterpreterInput
from harness.temporal.interpreter.registry import NODE_REGISTRY
from harness.temporal.interpreter.workflow import WorkflowInterpreter

#: A durable, implemented node type whose registry activity name we can deliberately MISMATCH.
#: Reaching ``activity_mismatch`` proves dispatch got PAST the enabled check — a positive
#: control that needs no Temporal server and no activity execution.
_DURABLE_TYPE = "consultation.sensors"
# A lane: "realtime" node type — owned by live executor.
_REALTIME_TYPE = "consultation.extractEntities"


def _node(node_type: str, config: dict[str, Any], *, activity: str | None = None) -> CompiledNode:
    spec = NODE_REGISTRY[node_type]
    return CompiledNode.model_validate(
        {
            "nodeId": "n1",
            "type": node_type,
            "activity": activity if activity is not None else spec.activity_name,
            "config": config,
            "timeoutSeconds": 30,
            "retry": {"maximumAttempts": 1, "initialIntervalSeconds": 1, "backoffCoefficient": 2},
            "inputs": [],
            "onError": "degrade",
            "emitsTrajectory": True,
        }
    )


def _input(*, sandbox: bool = False) -> InterpreterInput:
    # `_dispatch_node` never dereferences the claim check (the caller already parsed the config),
    # so a well-formed ref with no blob behind it is enough to exercise the skip branches.
    return InterpreterInput(
        session_id="s-1",
        workflow_version_id="v-1",
        config_ref=ClaimCheckRef(store="memory", bucket="b", key="k", size=1, sha256="0" * 64),
        tenant_id="10000000-0000-0000-0000-000000000001",
        run_id="r-1",
        sandbox=sandbox,
    )


class TestADisabledNodeIsSkippedObservably:
    @pytest.mark.asyncio
    async def test_enabled_false_skips_with_disabled_by_config(self):
        result = await WorkflowInterpreter()._dispatch_node(
            _node(_DURABLE_TYPE, {"enabled": False, "onError": "degrade"}), _input(), 0
        )

        assert result.status == "SKIPPED"
        # Named, never a silent no-op — the same discipline as `unsupported_node_type`,
        # `realtime_lane` and `sandbox`.
        assert result.reason == "disabled_by_config"
        assert result.node_id == "n1"
        assert result.node_type == _DURABLE_TYPE

    @pytest.mark.asyncio
    async def test_the_skip_beats_the_activity_cross_check(self):
        # A node an admin switched OFF must not be reported as a wiring defect; the author's
        # intent is the more specific answer, and the activity is never going to be dispatched.
        result = await WorkflowInterpreter()._dispatch_node(
            _node(
                _DURABLE_TYPE,
                {"enabled": False, "onError": "degrade"},
                activity="interpreter.wrong",
            ),
            _input(),
            0,
        )

        assert result.reason == "disabled_by_config"


class TestAbsentOrTrueMeansEnabled:
    """Absent must mean ON. Every graph published before carries no enabled key,
    and a default of OFF would silently stop every one of them."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "config",
        [
            {"onError": "degrade"},
            {"enabled": True, "onError": "degrade"},
            # Only the literal `false` disables. A truthy-ish non-boolean is not a kill switch —
            # the schema types it as a boolean, so anything else is malformed, not "off".
            {"enabled": "false", "onError": "degrade"},
            {"enabled": 0, "onError": "degrade"},
        ],
    )
    async def test_dispatch_proceeds_past_the_toggle(self, config):
        # Reaching `activity_mismatch` is the observable proof that the enabled check did not
        # short-circuit: that branch sits AFTER it.
        result = await WorkflowInterpreter()._dispatch_node(
            _node(_DURABLE_TYPE, config, activity="interpreter.wrong"), _input(), 0
        )

        assert result.reason == "activity_mismatch"


class TestLaneOwnershipIsDecidedFirst:
    @pytest.mark.asyncio
    async def test_a_disabled_realtime_node_is_still_reported_as_realtime_lane(self):
        # The realtime executor owns this node AND already honours the toggle itself. If the
        # durable interpreter claimed it as `disabled_by_config`, two runtimes would be
        # reporting on one node — the exact ambiguity `lane` was made load-bearing to remove.
        assert NODE_REGISTRY[_REALTIME_TYPE].lane == "realtime"

        result = await WorkflowInterpreter()._dispatch_node(
            _node(
                _REALTIME_TYPE, {"enabled": False, "requiresFinalized": False, "onError": "degrade"}
            ),
            _input(),
            0,
        )

        assert result.status == "SKIPPED"
        assert result.reason == "realtime_lane"


class TestTheSkipIsAPureRead:
    @pytest.mark.asyncio
    async def test_no_workflow_api_is_touched_on_the_disabled_path(self, monkeypatch):
        """Determinism guard: the branch must not reach for the clock, an activity, or a
        random — anything that would make replay diverge. Poisoning the three
        ``temporalio.workflow`` entry points ``_dispatch_node`` could otherwise reach proves
        the skip returns before any of them."""
        from harness.temporal.interpreter import workflow as wf_module

        def _boom(*_args, **_kwargs):
            raise AssertionError("the disabled-node skip must not call into temporalio.workflow")

        monkeypatch.setattr(wf_module.workflow, "execute_activity", _boom)
        monkeypatch.setattr(wf_module.workflow, "now", _boom)
        monkeypatch.setattr(wf_module.workflow, "random", _boom)

        result = await WorkflowInterpreter()._dispatch_node(
            _node(_DURABLE_TYPE, {"enabled": False, "onError": "degrade"}), _input(), 0
        )

        assert result.reason == "disabled_by_config"
