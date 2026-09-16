"""TASK-982 §3.4.5 — the ``workflow.run.completed`` envelope's cross-language contract fixture
(Python half).

`_envelope_for` (``activities.py``) PRODUCES the envelope payload; `WorkflowRunCompletionService`
(``apps/api/src/modules/workflows/workflow-run-completion.service.ts``) CONSUMES it. Both halves
read the SAME committed fixture — ``tests/contracts/workflow-run-completed.fixture.json`` — so a
shape change on either side fails the other. The TypeScript half is
``tests/contracts/workflow-run-completed-parity.contract.test.ts``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from harness.temporal.interpreter.activities import _envelope_for
from harness.temporal.interpreter.models import RunEventBatch, RunEventSpec
from harness.temporal.interpreter.run_events import EVENT_RUN_COMPLETED

TENANT = "22222222-2222-2222-2222-222222222222"


def _load_fixture() -> dict[str, Any]:
    """Locate the shared contract fixture by walking up to the repo root."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "workflow-run-completed.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared workflow.run.completed contract fixture not found")


FIXTURE = _load_fixture()
CASES = {name: case for name, case in FIXTURE.items() if isinstance(case, dict)}

#: `input`'s camelCase wire keys -> the RunEventSpec's snake_case field names.
_FIELD_NAMES = {
    "nodeCount": "node_count",
    "failedNodeCount": "failed_node_count",
    "degradedNodeCount": "degraded_node_count",
    "skippedNodeCount": "skipped_node_count",
}


@pytest.mark.parametrize("name", sorted(CASES))
def test_envelope_for_produces_exactly_the_fixtures_expected_payload(name: str) -> None:
    case = CASES[name]
    fixture_input = case["input"]
    spec_kwargs = {"status": fixture_input["status"]}
    for wire_key, field_name in _FIELD_NAMES.items():
        if wire_key in fixture_input:
            spec_kwargs[field_name] = fixture_input[wire_key]

    spec = RunEventSpec(event_type=EVENT_RUN_COMPLETED, **spec_kwargs)
    batch = RunEventBatch(run_id="run-1", tenant_id=TENANT, events=[spec])

    envelope = _envelope_for(batch, spec)

    assert envelope.payload == case["expected"]
