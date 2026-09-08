"""``core.data`` — the tier-2 escape hatch, the one core node with logic of its own.

TASK-893: these four cases are the surviving half of ``test_agentic_nodes_task847.py``. That
file's other three classes asserted the DISPATCHABILITY of the eight ``agentic.*`` types and the
observable non-execution of the two that were declared but not built; all eight left
``NODE_REGISTRY`` in Phase 4 and the module behind them is deleted, so those assertions no longer
describe anything the platform can reach. The reshape itself is very much alive — it is what
``interpreter.core_data`` runs — and it is the part worth keeping strict: a mapping language that
INVENTS a value is worse than one that reports a gap, because a downstream schema check passes on
a fabricated field and the run looks healthy.
"""

from __future__ import annotations

from typing import Any

import pytest

from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core

_TENANT = "10000000-0000-0000-0000-000000000001"


def _payload(**overrides: Any) -> NodeActivityInput:
    base: dict[str, Any] = {
        "node_id": "n1",
        "node_type": "core.data",
        "config": {},
        "tenant_id": _TENANT,
        "sandbox": False,
        "bound_inputs": {},
        "run_payload": {},
    }
    base.update(overrides)
    return NodeActivityInput(**base)


@pytest.fixture(autouse=True)
def _no_trajectory(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(core, "record_and_flush", _noop)


class TestDataNode:
    async def test_maps_dotted_reads_onto_renamed_keys(self) -> None:
        result = await core.interpreter_core_data(
            _payload(
                config={"mappings": [{"from": "in.patient.name", "to": "patient_name"}]},
                bound_inputs={"in": {"patient": {"name": "A. Patient"}}},
            )
        )
        assert result.status == "SUCCEEDED"
        assert result.output == {"data": {"patient_name": "A. Patient"}}

    async def test_merges_literal_constants(self) -> None:
        result = await core.interpreter_core_data(
            _payload(config={"mappings": [], "constants": {"source": "workflow"}}, bound_inputs={})
        )
        assert result.output == {"data": {"source": "workflow"}}

    async def test_an_optional_mapping_that_does_not_resolve_is_simply_ABSENT(self) -> None:
        # Never invented. A fabricated field is worse than a missing one, because a downstream
        # schema check passes on it and the run looks healthy.
        result = await core.interpreter_core_data(
            _payload(
                config={"mappings": [{"from": "in.ghost", "to": "ghost"}]},
                bound_inputs={"in": {}},
            )
        )
        assert result.status == "SUCCEEDED"
        assert result.output == {"data": {}}

    async def test_a_REQUIRED_mapping_that_does_not_resolve_DEGRADES_observably(self) -> None:
        result = await core.interpreter_core_data(
            _payload(
                config={"mappings": [{"from": "in.ghost", "to": "ghost", "required": True}]},
                bound_inputs={"in": {}},
            )
        )
        assert result.status == "DEGRADED"
        assert "in.ghost" in (result.reason or "")
