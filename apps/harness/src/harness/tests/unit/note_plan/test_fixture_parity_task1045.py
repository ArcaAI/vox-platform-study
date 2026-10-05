"""The Python mirror of the pinned NotePlan v1 / CoverageResult v1 wire contract.

``tests/contracts/note-plan.fixture.json`` is parsed here AND by the TS composer's parity test.
Every case must parse; the mirror must round-trip it back to the same camelCase wire shape, so a
rename on either side fails here rather than as a silent ``None`` at runtime.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from harness.services.note_plan.models import (
    MAX_NOTE_PLAN_CALLS,
    CoverageResultV1,
    NotePlanRef,
    NotePlanV1,
)

FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[7] / "tests" / "contracts" / "note-plan.fixture.json"
    ).read_text(encoding="utf-8")
)
PLAN_CASES = {case["name"]: case["plan"] for case in FIXTURE["notePlans"]}
COVERAGE_CASES = {case["name"]: case["result"] for case in FIXTURE["coverageResults"]}


def _strip_nulls(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _strip_nulls(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_strip_nulls(v) for v in value]
    return value


@pytest.mark.parametrize("name", sorted(PLAN_CASES))
def test_every_note_plan_case_parses_and_round_trips(name: str) -> None:
    raw = PLAN_CASES[name]
    plan = NotePlanV1.model_validate(raw)

    assert plan.schema_id == "hope.note_plan.v1"
    assert plan.plan_id == raw["planId"]
    assert [h.key for h in plan.headings] == [h["key"] for h in raw["headings"]]
    assert [b.key for b in plan.blocks] == [b["key"] for b in raw["blocks"]]
    assert len(plan.calls) <= MAX_NOTE_PLAN_CALLS
    # The wire shape survives a round trip (nulls are optional on the wire).
    assert plan.to_wire() == _strip_nulls(raw)


def test_section_regen_case_carries_the_preserved_sections() -> None:
    plan = NotePlanV1.model_validate(PLAN_CASES["section_regen_plan_only"])
    assert plan.mode == "section_regen"
    assert plan.preserve is not None
    assert plan.preserve.section_keys == ["subjective", "objective", "assessment"]
    assert [c.section_keys for c in plan.calls] == [["plan"]]


def test_ledger_case_reads_budget_reductions_and_estimate_tokenizer() -> None:
    plan = NotePlanV1.model_validate(PLAN_CASES["ledger_prior_section_groups_with_audio_and_draft"])
    assert plan.budget.strategy == "ledger_prior+section_groups"
    assert plan.budget.tokenizer.mode == "estimate"
    assert plan.budget.reductions[0].encounter_seq == 1
    assert plan.sources.encounters[0].rendered == "ledger_cited"
    assert plan.coverage.critical_facts is not None
    assert plan.coverage.source_ids["A1"].kind == "attachment_transcript"


@pytest.mark.parametrize("name", sorted(COVERAGE_CASES))
def test_every_coverage_case_parses_and_round_trips(name: str) -> None:
    raw = COVERAGE_CASES[name]
    result = CoverageResultV1.model_validate(raw)
    assert result.status == raw["status"]
    assert result.to_wire() == _strip_nulls(raw)


def test_handoff_ref_parses_in_both_spellings() -> None:
    wire = FIXTURE["harnessDelivery"]["handoffRef"]
    camel = NotePlanRef.model_validate(wire)
    snake = NotePlanRef.model_validate(
        {"consultation_id": wire["consultationId"], "plan_id": wire["planId"], "mode": "final"}
    )
    assert camel == snake
    assert camel.plan_id == wire["planId"]


def test_more_than_ten_calls_is_refused() -> None:
    raw = json.loads(json.dumps(PLAN_CASES["single_pass_two_encounters"]))
    call = raw["calls"][0]
    raw["calls"] = [
        {**call, "callId": f"c{i}", "sectionKeys": [f"s{i}"]}
        for i in range(MAX_NOTE_PLAN_CALLS + 1)
    ]
    raw["headings"] = [{"key": f"s{i}", "title": f"S{i}"} for i in range(MAX_NOTE_PLAN_CALLS + 1)]
    with pytest.raises(ValidationError):
        NotePlanV1.model_validate(raw)


def test_a_call_naming_an_unknown_heading_is_refused() -> None:
    raw = json.loads(json.dumps(PLAN_CASES["single_pass_two_encounters"]))
    raw["calls"][0]["sectionKeys"] = ["subjective", "nope"]
    with pytest.raises(ValidationError):
        NotePlanV1.model_validate(raw)


def test_a_final_plan_must_cover_every_heading() -> None:
    raw = json.loads(json.dumps(PLAN_CASES["single_pass_two_encounters"]))
    raw["calls"][0]["sectionKeys"] = ["subjective", "objective"]
    with pytest.raises(ValidationError):
        NotePlanV1.model_validate(raw)


def test_unknown_schema_is_refused() -> None:
    raw = json.loads(json.dumps(PLAN_CASES["single_pass_two_encounters"]))
    raw["schema"] = "hope.note_plan.v2"
    with pytest.raises(ValidationError):
        NotePlanV1.model_validate(raw)
