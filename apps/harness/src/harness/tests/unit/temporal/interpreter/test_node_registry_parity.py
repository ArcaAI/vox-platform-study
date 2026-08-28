"""Cross-language parity guard (TASK-734 Task 3).

`NODE_REGISTRY` (this package) and `WORKFLOW_NODE_REGISTRY`
(`packages/workflow-contract/src/node-registry.ts`) must agree on every key, or a definition
that validates in the gateway fails admission in the interpreter. Neither runtime can import
the other's module, so both sides assert against the SAME committed fixture instead of against
each other — `node-registry-parity.test.ts` is the TypeScript half of this guard.
"""

from __future__ import annotations

import json
from pathlib import Path

from harness.temporal.interpreter.registry import NODE_REGISTRY

_FIXTURE_PATH = (
    Path(__file__).resolve().parents[8]
    / "docs"
    / "implementation"
    / "TASK-734-Workflow-Substrate-Second-Pass"
    / "contracts"
    / "node-registry.snapshot.json"
)


def _load_fixture_entries() -> list[dict]:
    with _FIXTURE_PATH.open(encoding="utf-8") as f:
        return json.load(f)["entries"]


def _project_registry() -> list[dict]:
    """Mirrors what the TS test's `projectRegistry()` does to `WORKFLOW_NODE_REGISTRY`.

    `outputKeys` (TASK-809 OD-15) is the ONE port field that is shared rather than TS-only —
    see `NodeSpec.output_keys`' docstring for why the interpreter cannot do its job without it,
    and `node-registry-parity.test.ts` for the other half of this guard. A `None` value marks a
    `control` port: ordering only, no payload.
    """
    entries = [
        {
            "key": spec.key,
            "implemented": spec.implemented,
            "activityName": spec.activity_name,
            "critical": spec.critical,
            "externalWrite": spec.external_write,
            "defaultTimeoutSeconds": spec.default_timeout_seconds,
            "defaultMaxAttempts": spec.default_max_attempts,
            "entitlementKey": spec.entitlement_key,
            "outputKeys": dict(spec.output_keys),
        }
        for spec in NODE_REGISTRY.values()
    ]
    return sorted(entries, key=lambda e: e["key"])


class TestFixturePathResolves:
    def test_fixture_file_exists(self):
        assert _FIXTURE_PATH.is_file(), f"expected fixture at {_FIXTURE_PATH}"


class TestNodeRegistryParity:
    def test_matches_the_committed_cross_language_fixture_exactly(self):
        assert _project_registry() == _load_fixture_entries()

    def test_carries_exactly_the_seed_and_stt_palette_keys(self):
        assert sorted(NODE_REGISTRY.keys()) == [
            "consultation.assemblePrompt",
            "consultation.bindTerminology",
            "consultation.captureBinding",
            "consultation.consentGate",
            "consultation.extractEntities",
            "consultation.finalizeAssurance",
            "consultation.hitlGate",
            "consultation.inferentialSensors",
            "consultation.persistDraft",
            "consultation.phiHop",
            "consultation.proposeCorrections",
            "consultation.realtimeSummary",
            "consultation.retrieveEvidence",
            "consultation.sensors",
            "consultation.suggestions",
            "consultation.synthesize",
            "core.end",
            "core.start",
            # TASK-812 — the endpoint stage.
            "feedback.capture",
            "generate.text",
            "guardrail.check",
            "input.context_binding",
            "noop",
            "output.deliver",
            "passthrough",
            "prompt.template_ref",
            "session.timeout",
            "stt.asrEngine",
            "stt.audioInput",
            "stt.diarization",
            "stt.languageDetection",
            "stt.noiseFilter",
            "stt.phiHop",
            "stt.transcriptOutput",
            "stt.vad",
            "summary.finalize",
        ]
