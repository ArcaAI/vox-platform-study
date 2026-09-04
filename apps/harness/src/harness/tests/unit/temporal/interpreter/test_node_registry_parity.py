"""Cross-language parity guard.

`NODE_REGISTRY` (this package) and `WORKFLOW_NODE_REGISTRY`
(`packages/workflow-contract/src/node-registry.ts`) must agree on every key, or a definition
that validates in the gateway fails admission in the interpreter. Neither runtime can import
the other's module, so both sides assert against the SAME committed fixture instead of against
each other — `node-registry-parity.test.ts` is the TypeScript half of this guard.

The one deliberate asymmetry (TASK-867, closing TASK-861 step 10): a fixture entry with
`implemented: false` exists on the TypeScript side ONLY. A `NodeSpec` cannot exist without a
registered `@activity.defn` callable, and the interpreter already treats "no spec" and
"unimplemented spec" identically (SKIPPED, `unsupported_node_type`), so an entry the gateway
keeps for its deprecation window has no twin here — and no worker activity under its name.
Today that is exactly the retired `stt` palette.
"""

from __future__ import annotations

import json
from pathlib import Path

from temporalio import activity as temporal_activity

from harness.temporal.interpreter.registry import NODE_REGISTRY

# The eight `stt.*` node types: `implemented: false` in `node-registry.ts` (TASK-861 step 10 /
# TASK-867), absent from `NODE_REGISTRY` and from the worker's activity list on purpose.
RETIRED_STT_KEYS = [
    "stt.asrEngine",
    "stt.audioInput",
    "stt.diarization",
    "stt.languageDetection",
    "stt.noiseFilter",
    "stt.phiHop",
    "stt.transcriptOutput",
    "stt.vad",
]

_FIXTURE_PATH = (
    Path(__file__).resolve().parents[8]
    / "packages"
    / "workflow-contract"
    / "src"
    / "__tests__"
    / "fixtures"
    / "node-registry.snapshot.json"
)


def _load_fixture_entries() -> list[dict]:
    with _FIXTURE_PATH.open(encoding="utf-8") as f:
        return json.load(f)["entries"]


def _served_activity_names() -> set[str]:
    """Every activity name the worker actually registers (`worker.py` passes
    `INTERPRETER_ACTIVITIES`, which spreads `NODE_ACTIVITIES`)."""
    from harness.temporal.interpreter.activities import NODE_ACTIVITIES

    return {
        temporal_activity._Definition.from_callable(fn).name  # noqa: SLF001
        for fn in NODE_ACTIVITIES
    }


def _project_registry() -> list[dict]:
    """Mirrors what the TS test's `projectRegistry()` does to `WORKFLOW_NODE_REGISTRY`.

    `outputKeys` is the ONE port field that is shared rather than TS-only
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
            "lane": spec.lane,
        }
        for spec in NODE_REGISTRY.values()
    ]
    return sorted(entries, key=lambda e: e["key"])


class TestFixturePathResolves:
    def test_fixture_file_exists(self):
        assert _FIXTURE_PATH.is_file(), f"expected fixture at {_FIXTURE_PATH}"


class TestNodeRegistryParity:
    def test_matches_every_implemented_fixture_entry_exactly(self):
        implemented = [entry for entry in _load_fixture_entries() if entry["implemented"]]
        assert _project_registry() == implemented

    def test_unimplemented_fixture_entries_have_no_spec_and_no_served_activity(self):
        """TASK-867 — the asymmetry documented in the module docstring, pinned from this side:
        an `implemented: false` entry is the retired `stt` palette and nothing else, it has no
        `NodeSpec` here, and the worker serves no activity under its (historical) name — so the
        deleted `nodes/stt_placeholder.py` cannot quietly come back under either registration.
        """
        unimplemented = [entry for entry in _load_fixture_entries() if not entry["implemented"]]
        assert [entry["key"] for entry in unimplemented] == RETIRED_STT_KEYS
        served = _served_activity_names()
        for entry in unimplemented:
            assert entry["key"] not in NODE_REGISTRY, entry["key"]
            assert entry["activityName"] not in served, entry["activityName"]

    def test_carries_exactly_the_seed_consultation_agentic_and_core_keys(self):
        assert sorted(NODE_REGISTRY.keys()) == [
            # lane A — the target catalogue and the guards.
            "agent.discharge_summary",
            "agent.dna_redaction",
            "agent.feedback",
            # Lane R (R1) — the realtime grammar/spelling pass.
            "agent.grammar",
            # Lane N — the one catalogue entry that is not a delegation:
            # important findings had no engine anywhere to delegate to.
            "agent.important_findings",
            "agent.ner",
            "agent.normalization",
            "agent.presummarization",
            "agent.retrieval",
            "agent.summarization",
            "agent.transcription",
            # the GENERIC (`agentic`) catalogue: the eight node types of the
            # owner's specification, closing program finding F-12's have/missing table.
            # Sorted position, not catalogue position -- Python's `sorted` puts `agentic.*`
            # after every `agent.*` because "." sorts before "i".
            "agentic.agent",
            "agentic.data",
            "agentic.guardrail",
            "agentic.input",
            "agentic.loop",
            "agentic.output",
            "agentic.stt",
            "agentic.tts",
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
            # TASK-864 -- the `core` vocabulary, in sorted position.
            "core.action",
            "core.agent",
            "core.classify",
            "core.condition",
            "core.data",
            "core.end",
            "core.humanReview",
            "core.loop",
            "core.note",
            "core.output",
            "core.start",
            "core.trigger",
            "core.variable",
            # the endpoint stage.
            "feedback.capture",
            "generate.text",
            "guard.groundedness",
            "guard.moderation",
            "guard.phi",
            "guardrail.check",
            "input.context_binding",
            "noop",
            "output.deliver",
            "passthrough",
            "prompt.template_ref",
            "session.timeout",
            # `stt.*` — RETIRED (TASK-861 step 10 / TASK-867): TypeScript-side only, as
            # `implemented: false`; see `test_unimplemented_fixture_entries_have_no_spec_...`.
            "summary.finalize",
        ]
