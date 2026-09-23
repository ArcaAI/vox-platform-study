"""TASK-1002 — the gateway's governing-workflow ASR tier reaches ``apps/stt``.

The gateway will start stamping ``ResolvedAsrSpec.agent.source = "workflow"`` when a
consultation's governing workflow (not the ``explicit``/``department``/``tenant``/
``platform-default`` assignment cascade) chose the speech-to-text agent. This locks the
pydantic mirror (``stt.pipeline.spec.AsrSpecAgent``) accepting that value alongside the
four it already knows, and still rejecting anything outside the declared set.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from stt.pipeline.spec import ResolvedAsrSpec


def _load_fixture() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


FIXTURE = _load_fixture()
BASE_SPEC: dict[str, Any] = FIXTURE["platformDefault"]["expected"]


def _spec_with_agent_source(source: str) -> dict[str, Any]:
    spec = copy.deepcopy(BASE_SPEC)
    spec["agent"]["source"] = source
    return spec


def test_agent_source_workflow_validates() -> None:
    spec = ResolvedAsrSpec.model_validate(_spec_with_agent_source("workflow"))
    assert spec.agent.source == "workflow"
    # Round-trips byte-for-byte, same as every other declared source value.
    assert spec.model_dump(by_alias=True, mode="json") == _spec_with_agent_source("workflow")


def test_agent_source_unknown_value_still_fails_closed() -> None:
    with pytest.raises(ValidationError):
        ResolvedAsrSpec.model_validate(_spec_with_agent_source("caller-selected"))
