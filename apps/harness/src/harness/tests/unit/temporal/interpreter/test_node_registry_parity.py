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

    def test_the_cross_language_asymmetry_is_closed(self):
        """TASK-893 Phase 4 — the asymmetry this guard was written for is GONE.

        It used to be that an `implemented: false` fixture entry existed on the TypeScript side
        only: `registry.py` cannot hold a spec without a registered activity callable, so the
        eight retired `stt.*` keys were kept there for the deprecation window and asserted absent
        here. The deprecated vocabulary is now DELETED on both sides, so every fixture entry is
        implemented and the two registries are a plain one-to-one mapping.

        What still has to hold is the half that was never about the asymmetry: the retired keys
        must not come back under EITHER registration — not as a spec, and not as an activity the
        worker serves under a historical name.
        """
        assert [entry for entry in _load_fixture_entries() if not entry["implemented"]] == []
        served = _served_activity_names()
        for key in RETIRED_STT_KEYS:
            assert key not in NODE_REGISTRY, key
        for name in (
            "interpreter.stt_asr_engine",
            "interpreter.stt_audio_input",
            "interpreter.stt_vad",
        ):
            assert name not in served, name

    def test_carries_exactly_the_eleven_core_keys(self):
        # TASK-893 Phase 4: the seed / consultation / endpoint / agent-catalogue / agentic keys
        # were deleted with their node types. The seventeen ACTIONS behind `core.action` are NOT
        # node types — they live in `action_catalogue.py` and have their own parity guard
        # (`test_action_catalogue_parity.py`).
        assert sorted(NODE_REGISTRY.keys()) == [
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
