"""TASK-893 Phase 2 — cross-language parity for the ACTION catalogue.

`ACTION_CATALOGUE` in `action_catalogue.py` and `ACTION_CATALOGUE` in
`packages/workflow-contract/src/action-catalogue.ts` both project onto the committed fixture
`action-catalogue.snapshot.json`, the way the node registry does — see
`test_node_registry_parity.py` for why the two sides check a file rather than each other.
"""

from __future__ import annotations

import json
from pathlib import Path

from temporalio import activity as temporal_activity

from harness.temporal.interpreter.action_catalogue import ACTION_CATALOGUE, ACTION_KEYS

_FIXTURE_PATH = (
    Path(__file__).resolve().parents[8]
    / "packages"
    / "workflow-contract"
    / "src"
    / "__tests__"
    / "fixtures"
    / "action-catalogue.snapshot.json"
)

KEPT = (
    "consultation.consentGate",
    "consultation.bindTerminology",
    "consultation.phiHop",
    "consultation.retrieveEvidence",
    "consultation.sensors",
    "consultation.inferentialSensors",
    "consultation.persistDraft",
    "consultation.finalizeAssurance",
    "guard.phi",
    "guard.moderation",
    "guard.groundedness",
    "session.timeout",
    "feedback.capture",
    "livedoc.stop",
    "harness.finalize",
    "summary.finalize",
    "prompt.template_ref",
)


def _load_fixture_entries() -> list[dict]:
    with _FIXTURE_PATH.open(encoding="utf-8") as f:
        return json.load(f)["entries"]


def _project_catalogue() -> list[dict]:
    entries = [
        {
            "key": spec.key,
            "activityName": spec.activity_name,
            "critical": spec.critical,
            "externalWrite": spec.external_write,
            "defaultTimeoutSeconds": spec.default_timeout_seconds,
            "defaultMaxAttempts": spec.default_max_attempts,
            "entitlementKey": spec.entitlement_key,
            "outputKeys": dict(spec.output_keys),
            "lane": spec.lane,
        }
        for spec in ACTION_CATALOGUE.values()
    ]
    return sorted(entries, key=lambda e: e["key"])


class TestActionCatalogueParity:
    def test_fixture_file_exists(self):
        assert _FIXTURE_PATH.is_file(), f"expected fixture at {_FIXTURE_PATH}"

    def test_matches_the_committed_fixture_exactly(self):
        assert _project_catalogue() == _load_fixture_entries()

    def test_carries_exactly_the_seventeen_kept_keys_in_contract_order(self):
        assert ACTION_KEYS == KEPT
        assert tuple(ACTION_CATALOGUE.keys()) == KEPT

    def test_every_action_is_served_by_the_worker_under_its_own_activity_name(self):
        from harness.temporal.interpreter.activities import NODE_ACTIVITIES

        served = {
            temporal_activity._Definition.from_callable(fn).name  # noqa: SLF001
            for fn in NODE_ACTIVITIES
        }
        for spec in ACTION_CATALOGUE.values():
            assert spec.activity_name in served, spec.key
            assert callable(spec.activity)


class TestNoHandCopiedKeyList:
    def test_nodes_core_no_longer_carries_action_keys(self):
        """The hand-copied `ACTION_KEYS` tuple in `nodes/core.py` is gone — the catalogue is the
        ONE table, and `interpreter_core_action` reads it."""
        import harness.temporal.interpreter.nodes.core as core

        assert not hasattr(core, "ACTION_KEYS")
