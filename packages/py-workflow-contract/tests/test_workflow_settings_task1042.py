"""TASK-1042 OD-7 — WF-SET-005: a stream-delivery Input kind must be READ by a speech-to-text step.

Otherwise an integrator streams audio that nothing in the graph reads (G7). A kind is read when a
``core.agent`` whose task is ``SPEECH_TO_TEXT`` binds its ``audio`` input to the kind
(``context.<key>``, a sub-path, a ``firstOf`` entry, or a legacy data edge from the trigger,
which carries the whole input). An agent whose task the caller could not resolve implies nothing
(as in WF-SET-003). A consultation-sourced workflow is exempt: its audio arrives on the
consultation session, where the consultation lane reads it.

The TypeScript half asserts the SAME ``liveAudio`` cases of
``tests/contracts/workflow-settings.fixture.json``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from hope_workflow_contract.workflow_settings import live_audio_unread

CONTRACTS = Path(__file__).resolve().parents[3] / "tests" / "contracts"
FIXTURE = json.loads((CONTRACTS / "workflow-settings.fixture.json").read_text(encoding="utf-8"))


def test_the_fixture_exercises_both_outcomes() -> None:
    expected = [entry["expected"] for entry in FIXTURE["liveAudio"]]
    assert any(found == [] for found in expected)
    assert any(found != [] for found in expected)


@pytest.mark.parametrize(
    "entry", FIXTURE["liveAudio"], ids=[e["name"] for e in FIXTURE["liveAudio"]]
)
def test_live_audio_unread(entry: dict[str, Any]) -> None:
    found = [
        {"ruleId": f["ruleId"], "nodeId": f["nodeId"], "kindKey": f["kindKey"]}
        for f in live_audio_unread(entry["graph"], entry["settings"], entry.get("context") or {})
    ]
    assert found == entry["expected"]


def test_every_finding_carries_a_message_naming_the_kind() -> None:
    entry = next(e for e in FIXTURE["liveAudio"] if e["expected"])
    found = live_audio_unread(entry["graph"], entry["settings"], entry["context"])
    assert found and all(f["kindKey"] in f["message"] for f in found)
