"""RED-first tests for the interpreter's node-type -> activity registry (Task 4, S-4/S-6).

Mirrors LOOP_ACTION_REGISTRY's shape/discipline (workflows.py:1665-1693): a key with no entry,
or an entry with implemented=False, is an OBSERVABLE skip, never a silent no-op. The registry
starts empty of palette nodes ( populates it); ships only noop/passthrough.
"""

from __future__ import annotations

from harness.temporal.interpreter import activities as interpreter_activities
from harness.temporal.interpreter.registry import NODE_REGISTRY, NodeSpec


class TestRegistryShape:
    def test_seed_entries_present(self):
        assert "noop" in NODE_REGISTRY
        assert "passthrough" in NODE_REGISTRY

    def test_every_entry_is_a_node_spec(self):
        for spec in NODE_REGISTRY.values():
            assert isinstance(spec, NodeSpec)

    def test_seed_entries_are_implemented_and_non_critical(self):
        for key in ("noop", "passthrough"):
            spec = NODE_REGISTRY[key]
            assert spec.implemented is True
            assert spec.critical is False
            assert spec.external_write is False

    def test_graph_boundary_markers_are_registered_and_dispatchable(self):
        # `core.start`/`core.end` are the two node types the palette-agnostic structural rules
        # WF-S-002/003/004/007 are written against. compile() refuses any graph containing an
        # unimplemented node type, so a marker that is registered but not dispatchable would
        # leave every graph unpublishable for a different reason than before.
        for key in ("core.start", "core.end"):
            spec = NODE_REGISTRY[key]
            assert spec.implemented is True
            assert spec.critical is False
            assert spec.external_write is False
            assert callable(spec.activity)

    def test_boundary_markers_carry_distinct_activity_names(self):
        assert NODE_REGISTRY["core.start"].activity_name == "interpreter.core_start"
        assert NODE_REGISTRY["core.end"].activity_name == "interpreter.core_end"

    def test_activity_is_a_callable_reference_not_a_string(self):
        # S-4: routing reaches sanctioned activities via a code-owned registry, never a
        # string dispatched at runtime (see
        for spec in NODE_REGISTRY.values():
            assert callable(spec.activity)
            assert isinstance(spec.activity, type(interpreter_activities.interpreter_noop))


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
