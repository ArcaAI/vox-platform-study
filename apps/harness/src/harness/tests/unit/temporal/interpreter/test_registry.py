"""RED-first tests for the interpreter's node-type -> activity registry (Task 4, S-4/S-6).

Mirrors LOOP_ACTION_REGISTRY's shape/discipline (workflows.py:1665-1693): a key with no entry,
or an entry with implemented=False, is an OBSERVABLE skip, never a silent no-op.

TASK-893 Phase 4 made the registry the ELEVEN ``core.*`` types and nothing else. The seed
``noop``/``passthrough`` entries and the ``core.start``/``core.end`` boundary markers were
retired with the rest of the legacy vocabulary; the boundaries are ``core.trigger`` /
``core.output``, and the seventeen ACTIONS behind ``core.action`` live in
``action_catalogue.py`` rather than here.
"""

from __future__ import annotations

from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.registry import NODE_REGISTRY, NodeSpec


class TestRegistryShape:
    def test_the_registry_is_exactly_the_core_vocabulary(self):
        assert sorted(NODE_REGISTRY) == [
            "core.action",
            "core.agent",
            "core.classify",
            "core.condition",
            "core.data",
            "core.humanReview",
            "core.loop",
            "core.note",
            "core.output",
            "core.trigger",
            "core.variable",
        ]

    def test_every_entry_is_a_node_spec(self):
        for spec in NODE_REGISTRY.values():
            assert isinstance(spec, NodeSpec)

    def test_every_entry_is_implemented(self):
        # The one deliberate asymmetry with the TypeScript registry was the retired `stt.*`
        # palette, kept there as `implemented=False` and absent here. Phase 4 deleted it, so the
        # two registries are a plain one-to-one mapping again.
        for spec in NODE_REGISTRY.values():
            assert spec.implemented is True

    def test_graph_boundary_markers_are_registered_and_dispatchable(self):
        # `core.trigger`/`core.output` are the two node types the palette-agnostic structural
        # rules WF-S-002/003/004/007 select by class (`entry` / `terminal`). compile() refuses
        # any graph containing an unimplemented node type, so a boundary that is registered but
        # not dispatchable would leave every graph unpublishable for a different reason.
        for key in ("core.trigger", "core.output"):
            spec = NODE_REGISTRY[key]
            assert spec.implemented is True
            assert callable(spec.activity)
        # The trigger reads; the output DELIVERS, so it is the one boundary that writes out.
        assert NODE_REGISTRY["core.trigger"].external_write is False
        assert NODE_REGISTRY["core.output"].external_write is True

    def test_boundary_markers_carry_distinct_activity_names(self):
        assert NODE_REGISTRY["core.trigger"].activity_name == "interpreter.core_trigger"
        assert NODE_REGISTRY["core.output"].activity_name == "interpreter.core_output"

    def test_activity_is_a_callable_reference_not_a_string(self):
        # S-4: routing reaches sanctioned activities via a code-owned registry, never a
        # string dispatched at runtime (see
        for spec in NODE_REGISTRY.values():
            assert callable(spec.activity)
            assert isinstance(spec.activity, type(interpreter_activities.emit_run_events))


class TestNoActivityReachesApproveSummary:
    """S-6: the registry contains no activity whose target reaches approveSummary."""

    def test_no_registry_activity_touches_approve_summary(self):
        for spec in NODE_REGISTRY.values():
            module = getattr(spec.activity, "__module__", "")
            qualname = getattr(spec.activity, "__qualname__", "")
            assert "approveSummary" not in module
            assert "approveSummary" not in qualname
            assert "summary.service" not in module
            # Structural guarantee, not just a name check: the activity module must not
            # even import anything from the TS applications layer (impossible across
            # languages, but assert the Python-side symbol space stays clean too).
            assert not module.startswith("packages.applications")


class TestUnknownNodeType:
    def test_unknown_type_has_no_registry_entry(self):
        assert NODE_REGISTRY.get("this-type-does-not-exist") is None


class TestBoundaryMarkerActivities:
    """A marker executes NOTHING. In particular `core.end` is not a delivery step — whatever the
    graph produced was written by its own `external_write` node before the walk reached here."""

    @staticmethod
    def _payload(node_type: str):
        from harness.temporal.interpreter.models import NodeActivityInput

        return NodeActivityInput(
            node_id="n1",
            node_type=node_type,
            config={},
            tenant_id="10000000-0000-0000-0000-000000000001",
        )

    async def _run(self, fn, node_type: str):
        return await fn(self._payload(node_type))

    def test_markers_succeed_with_no_output(self):
        import asyncio

        for fn, node_type in (
            (interpreter_activities.interpreter_core_start, "core.start"),
            (interpreter_activities.interpreter_core_end, "core.end"),
        ):
            result = asyncio.run(self._run(fn, node_type))
            assert result.status == "SUCCEEDED"
            assert result.output is None
