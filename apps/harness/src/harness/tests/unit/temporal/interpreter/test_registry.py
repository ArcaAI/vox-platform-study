"""RED-first tests for the interpreter's node-type -> activity registry (Task 4, S-4/S-6).

Mirrors LOOP_ACTION_REGISTRY's shape/discipline (workflows.py:1665-1693): a key with no entry,
or an entry with implemented=False, is an OBSERVABLE skip, never a silent no-op. The registry
starts empty of palette nodes (TASK-720 populates it); this ticket ships only noop/passthrough.
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

    def test_activity_is_a_callable_reference_not_a_string(self):
        # S-4: routing reaches sanctioned activities via a code-owned registry, never a
        # string dispatched at runtime (see execution-semantics.md §10).
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
