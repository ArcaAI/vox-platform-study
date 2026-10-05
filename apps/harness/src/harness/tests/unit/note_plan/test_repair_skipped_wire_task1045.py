"""A skipped repair rides on the CoverageResult the harness sends (``repairSkipped``).

The executor already knows why gaps went unrepaired (``budget`` / ``disabled``); the coverage it
hands on — persisted with the draft and read by review — now says so too, camelCase and only when
set, matching the pinned wire contract (``tests/contracts/note-plan.fixture.json``).
"""

from __future__ import annotations

from harness.services.note_plan.executor import execute_plan
from harness.services.note_plan.models import CoverageResultV1, NotePlanV1
from harness.tests.unit.note_plan.test_executor_followups_task1045 import (
    COMPLETE,
    GAPPY,
    _plan,
    _raw,
    _Scripted,
)


async def test_a_budget_skip_is_on_the_wire_coverage() -> None:
    execution = await execute_plan(
        _plan(), system=None, user_prefix="P", generate=_Scripted(GAPPY), allow_repair=lambda: False
    )

    wire = execution.coverage.to_wire()
    assert wire["repairSkipped"] == "budget"
    assert wire["status"] == "gaps"
    assert wire["repairPasses"] == 0


async def test_a_disabled_repair_is_on_the_wire_coverage() -> None:
    raw = _raw()
    raw["coverage"]["repairPasses"] = 0
    execution = await execute_plan(
        NotePlanV1.model_validate(raw), system=None, user_prefix="P", generate=_Scripted(GAPPY)
    )

    assert execution.coverage.to_wire()["repairSkipped"] == "disabled"


async def test_nothing_is_sent_when_no_repair_was_skipped() -> None:
    execution = await execute_plan(
        _plan(),
        system=None,
        user_prefix="P",
        generate=_Scripted(COMPLETE),
        allow_repair=lambda: False,
    )

    assert "repairSkipped" not in execution.coverage.to_wire()


def test_the_wire_value_parses_back() -> None:
    parsed = CoverageResultV1.model_validate(
        {
            "schema": "hope.note_coverage.v1",
            "status": "gaps",
            "repairPasses": 0,
            "repairSkipped": "budget",
        }
    )
    assert parsed.to_wire()["repairSkipped"] == "budget"
