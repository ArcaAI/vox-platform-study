"""Deterministic note coverage (P-E §1d): facts, numbers, citations — and ONE repair, no more.

Hermetic: plans come from the pinned fixture, the text calls are stubbed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from harness.services.note_plan.coverage import (
    check_coverage,
    gap_section_keys,
    repair_directive,
)
from harness.services.note_plan.executor import NoteCallRequest, NoteCallResult, execute_plan
from harness.services.note_plan.models import NotePlanV1

FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[7] / "tests" / "contracts" / "note-plan.fixture.json"
    ).read_text(encoding="utf-8")
)


def _plan(name: str, **overrides: Any) -> NotePlanV1:
    raw = next(case["plan"] for case in FIXTURE["notePlans"] if case["name"] == name)
    raw = json.loads(json.dumps(raw))
    raw.update(overrides)
    return NotePlanV1.model_validate(raw)


SINGLE = "single_pass_two_encounters"
LEDGER = "ledger_prior_section_groups_with_audio_and_draft"
REGEN = "section_regen_plan_only"

COMPLETE_SECTIONS = {
    "subjective": "Chest tightness for two days.",
    "objective": "Troponin 12 ng/L, normal.",
    "assessment": "Chest tightness, cardiac causes excluded.",
    "plan": "Increase metformin to 1000 mg twice daily and review in four weeks.",
}
COMPLETE_SOURCES = {
    "subjective": ["S2"],
    "objective": ["R1"],
    "assessment": ["S4"],
    "plan": ["S5"],
}


def test_a_note_stating_every_fact_with_cited_numbers_is_complete() -> None:
    result = check_coverage(_plan(SINGLE), COMPLETE_SECTIONS, COMPLETE_SOURCES)

    assert result.status == "complete"
    assert result.repair_passes == 0
    assert result.critical_facts.total == 2
    assert result.critical_facts.present == 2
    assert result.critical_facts.missing == []
    assert (result.numbers.total, result.numbers.matched, result.numbers.unsupported) == (2, 2, 0)
    assert (result.citations.total, result.citations.resolved) == (4, 4)
    assert result.gaps == []


def test_a_missing_critical_fact_is_a_gap_on_the_section_that_cites_its_source() -> None:
    sections = {**COMPLETE_SECTIONS, "plan": "Increase metformin to 1000 mg twice daily."}
    result = check_coverage(_plan(SINGLE), sections, COMPLETE_SOURCES)

    assert result.status == "gaps"
    assert result.critical_facts.missing == ["E2-F3"]
    [gap] = result.gaps
    assert gap.kind == "missing_fact"
    assert gap.fact_id == "E2-F3"
    assert gap.section_key == "plan"
    # Labels are mapped to the segment ITEM ids the citation resolves to.
    assert gap.segment_ids == ["0199a000-0000-7000-8000-000000000055"]
    assert gap_section_keys(_plan(SINGLE), result) == ["plan"]


def test_a_number_the_cited_source_does_not_support_is_a_mismatch() -> None:
    sections = {
        **COMPLETE_SECTIONS,
        "plan": "Increase metformin to 2000 mg twice daily and review in four weeks.",
    }
    result = check_coverage(_plan(SINGLE), sections, COMPLETE_SOURCES)

    assert result.status == "gaps"
    assert (result.numbers.total, result.numbers.matched, result.numbers.unsupported) == (2, 1, 1)
    kinds = sorted((g.kind, g.section_key, g.fact_id) for g in result.gaps)
    # The wrong dose is unsupported AND the critical dose fact is no longer present.
    assert kinds == [("missing_fact", "plan", "E2-F2"), ("number_mismatch", "plan", None)]


def test_a_unit_change_is_a_mismatch_too() -> None:
    sections = {**COMPLETE_SECTIONS, "objective": "Troponin 12 mg/L, normal."}
    result = check_coverage(_plan(SINGLE), sections, COMPLETE_SOURCES)
    assert [g.kind for g in result.gaps] == ["number_mismatch"]
    assert result.gaps[0].section_key == "objective"


def test_a_citation_label_that_resolves_nowhere_is_unresolved() -> None:
    sources = {**COMPLETE_SOURCES, "plan": ["S5", "S99"]}
    result = check_coverage(_plan(SINGLE), COMPLETE_SECTIONS, sources)

    assert result.status == "gaps"
    assert (result.citations.total, result.citations.resolved) == (5, 4)
    assert result.citations.unresolved == ["S99"]
    [gap] = result.gaps
    assert (gap.kind, gap.section_key) == ("unresolved_citation", "plan")


def test_a_ledger_fact_id_present_in_a_ledger_block_resolves() -> None:
    plan = _plan(LEDGER)
    sections = {
        "subjective": "Allergic to penicillin.",
        "objective": "Home blood pressure raised.",
        "assessment": "Hypertension.",
        "plan": "Start amlodipine 5 mg once daily.",
    }
    sources = {
        "subjective": ["E1-F4"],
        "objective": ["A1"],
        "assessment": ["S420"],
        "plan": ["S420"],
    }
    result = check_coverage(plan, sections, sources)

    assert result.status == "complete", result.gaps
    assert result.citations.unresolved == []
    assert (result.numbers.total, result.numbers.matched) == (1, 1)


def test_no_ledger_means_unchecked_and_no_repair_target() -> None:
    plan = _plan(SINGLE)
    raw = plan.to_wire()
    raw["coverage"].pop("criticalFacts")
    plan = NotePlanV1.model_validate(raw)

    result = check_coverage(plan, COMPLETE_SECTIONS, COMPLETE_SOURCES)

    assert result.status == "unchecked"
    assert [g.kind for g in result.gaps] == ["ledger_unavailable"]
    assert result.critical_facts.total == 0
    assert gap_section_keys(plan, result) == []


def test_section_regen_checks_only_the_regenerated_sections() -> None:
    plan = _plan(REGEN)
    sections = {
        "subjective": "Preserved: weight 80 kg, uncited.",
        "objective": "Preserved.",
        "assessment": "Preserved.",
        "plan": "Increase metformin to 1000 mg twice daily.",
    }
    sources = {"plan": ["S5"]}
    result = check_coverage(plan, sections, sources, checked_keys={"plan"})

    assert result.status == "complete", result.gaps
    assert (result.numbers.total, result.numbers.matched) == (1, 1)
    assert result.citations.total == 1


def test_section_hint_wins_the_gap_section() -> None:
    raw = _plan(SINGLE).to_wire()
    raw["coverage"]["criticalFacts"][1]["sectionHint"] = "assessment"
    plan = NotePlanV1.model_validate(raw)
    sections = {**COMPLETE_SECTIONS, "plan": "Increase metformin to 1000 mg twice daily."}
    result = check_coverage(plan, sections, COMPLETE_SOURCES)
    assert [g.section_key for g in result.gaps] == ["assessment"]


def test_the_repair_directive_names_only_the_gap_sections_and_what_is_missing() -> None:
    plan = _plan(SINGLE)
    sections = {**COMPLETE_SECTIONS, "plan": "Increase metformin to 1000 mg twice daily."}
    result = check_coverage(plan, sections, COMPLETE_SOURCES)
    directive = repair_directive(plan, result, ["plan"])
    assert "Plan" in directive
    assert "Subjective" not in directive
    assert "four weeks" in directive
    assert "[S5]" in directive


# ---------------------------------------------------------------------------------------------
# One repair, never two
# ---------------------------------------------------------------------------------------------


def _answer(sections: dict[str, str], refs: dict[str, list[str]]) -> str:
    note = "\n\n".join(f"## {k.title()}\n{v}" for k, v in sections.items())
    return json.dumps(
        {
            "case_note": note,
            "redactions": [],
            "sources": [{"sectionKey": k, "refs": v} for k, v in refs.items()],
        }
    )


class _Scripted:
    def __init__(self, *answers: str) -> None:
        self.answers = list(answers)
        self.requests: list[NoteCallRequest] = []

    async def __call__(self, request: NoteCallRequest) -> NoteCallResult:
        self.requests.append(request)
        return NoteCallResult(content=self.answers.pop(0), stats={"prompt_tokens": 10})


async def test_gaps_trigger_exactly_one_repair_of_only_the_gap_sections() -> None:
    first = _answer(
        {**COMPLETE_SECTIONS, "plan": "Increase metformin to 1000 mg twice daily."},
        COMPLETE_SOURCES,
    )
    repaired = _answer(
        {"plan": "Increase metformin to 1000 mg twice daily and review in four weeks."},
        {"plan": ["S5"]},
    )
    stub = _Scripted(first, repaired)

    execution = await execute_plan(_plan(SINGLE), system="sys", user_prefix="PREFIX", generate=stub)

    assert len(stub.requests) == 2
    repair = stub.requests[1]
    assert repair.kind == "repair"
    assert repair.section_keys == ("plan",)
    assert repair.user.startswith("PREFIX")
    assert execution.coverage.status == "complete"
    assert execution.coverage.repair_passes == 1
    assert "review in four weeks" in execution.document["case_note"]


async def test_gaps_that_survive_the_repair_are_reported_not_repaired_again() -> None:
    gappy = _answer(
        {**COMPLETE_SECTIONS, "plan": "Increase metformin to 1000 mg twice daily."},
        COMPLETE_SOURCES,
    )
    still_gappy = _answer({"plan": "Increase metformin to 1000 mg."}, {"plan": ["S5"]})
    stub = _Scripted(gappy, still_gappy)

    execution = await execute_plan(_plan(SINGLE), system="sys", user_prefix="P", generate=stub)

    assert len(stub.requests) == 2
    assert execution.coverage.status == "gaps"
    assert execution.coverage.repair_passes == 1
    assert execution.coverage.critical_facts.missing == ["E2-F3"]


async def test_a_plan_that_allows_no_repair_reports_its_gaps_directly() -> None:
    raw = _plan(SINGLE).to_wire()
    raw["coverage"]["repairPasses"] = 0
    plan = NotePlanV1.model_validate(raw)
    stub = _Scripted(_answer({**COMPLETE_SECTIONS, "plan": "Metformin 1000 mg."}, COMPLETE_SOURCES))

    execution = await execute_plan(plan, system=None, user_prefix="P", generate=stub)

    assert len(stub.requests) == 1
    assert execution.coverage.status == "gaps"
    assert execution.coverage.repair_passes == 0


async def test_unchecked_coverage_never_repairs() -> None:
    raw = _plan(SINGLE).to_wire()
    raw["coverage"].pop("criticalFacts")
    plan = NotePlanV1.model_validate(raw)
    stub = _Scripted(_answer(COMPLETE_SECTIONS, COMPLETE_SOURCES))

    execution = await execute_plan(plan, system=None, user_prefix="P", generate=stub)

    assert len(stub.requests) == 1
    assert execution.coverage.status == "unchecked"


@pytest.mark.parametrize("allowed", [False])
async def test_no_repair_when_the_budget_cannot_fit_another_call(allowed: bool) -> None:
    stub = _Scripted(_answer({**COMPLETE_SECTIONS, "plan": "Metformin 1000 mg."}, COMPLETE_SOURCES))
    execution = await execute_plan(
        _plan(SINGLE), system=None, user_prefix="P", generate=stub, allow_repair=lambda: allowed
    )
    assert len(stub.requests) == 1
    assert execution.coverage.status == "gaps"
    assert execution.coverage.repair_passes == 0
