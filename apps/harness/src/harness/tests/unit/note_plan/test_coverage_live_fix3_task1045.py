"""Coverage matcher false positives found on the live two-encounter run (TASK-1045 live-fix3).

Consultation ``01a10c38-…`` went to AWAITING_REVIEW with ``NOTE_COVERAGE_GAPS:8`` although the note
stated every critical fact of both encounters. The plan is the run's own (synthetic patient), pinned
in ``live_two_encounter_plan_task1045.json``. The 8 gaps were:

* 3 ``unresolved_citation`` — ``sources[].refs`` carried the rendered form ``[S8 E2]`` while the plan
  keys its sources ``S8``;
* 2 ``number_mismatch`` — the same: ``[S10 E2]`` / ``[S11 E2]`` resolved to no source text, so
  ``1000 mg`` / ``5 mg`` had nothing to be supported by;
* 3 ``missing_fact`` — the E2 ledger keys drifted from ``kind:term`` (``metformin_dosage_change``), so
  the anchors were descriptions ("metformin dosage change", "amlodipine initiation", "follow up")
  that no note states literally and no transcript line contains.

A real omission must stay a gap: the tests at the end drop each E2 fact from the note in turn.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from harness.services.note_plan.coverage import check_coverage
from harness.services.note_plan.models import NotePlanV1
from harness.services.note_plan.normalise import contains_value, normalise_text

PLAN = NotePlanV1.model_validate(
    json.loads(
        (Path(__file__).with_name("live_two_encounter_plan_task1045.json")).read_text(
            encoding="utf-8"
        )
    )
)

SUBJECTIVE = (
    "Chest tightness for two days, mostly on climbing stairs [S2 E1]. The tightness is a bit "
    "better [S9 E2]. Allergic to penicillin, which causes a rash [S4 E1]. Takes metformin 500 mg "
    "twice daily for diabetes [S6 E1]."
)
OBJECTIVE = "ECG was normal [S8 E2], and the troponin level was 12, which is normal [S8 E2]."
ASSESSMENT = (
    "Chest tightness noted in initial visit. Blood pressure of 150/95 was documented during the "
    "first encounter [S7 E1]. Hyperglycemia noted as sugars are high [S10 E2]."
)
PLAN_TEXT = (
    "Metformin increased to 1000 mg twice daily for blood sugar control [S10 E2]. Started "
    "amlodipine 5 mg once daily for blood pressure management [S11 E2]. Review in four weeks "
    "[S11 E2]."
)
SECTIONS = {
    "subjective": SUBJECTIVE,
    "objective": OBJECTIVE,
    "assessment": ASSESSMENT,
    "plan": PLAN_TEXT,
}
#: The repair call's own ``sources`` (the three sections it rewrote), as the model wrote them.
SOURCES = {"objective": ["[S8 E2]"], "plan": ["[S10 E2]", "[S11 E2]"]}
CHECKED = ["objective", "assessment", "plan"]


def test_the_live_note_has_no_gaps() -> None:
    result = check_coverage(PLAN, SECTIONS, SOURCES, repair_passes=1, checked_keys=CHECKED)

    assert result.gaps == []
    assert result.status == "complete"
    assert result.critical_facts.missing == []
    assert (result.citations.total, result.citations.resolved) == (3, 3)
    assert (result.numbers.total, result.numbers.matched) == (2, 2)


@pytest.mark.parametrize("ref", ["S8", "[S8]", "[S8 E2]", "[S8 E2 Doctor 00:00]", " [S8 E2] "])
def test_every_spelling_of_a_source_label_resolves(ref: str) -> None:
    result = check_coverage(PLAN, SECTIONS, {"objective": [ref]}, checked_keys=["objective"])

    assert result.citations.unresolved == []
    assert result.citations.resolved == 1


def test_a_label_that_names_no_source_is_still_unresolved_whatever_its_spelling() -> None:
    result = check_coverage(
        PLAN, SECTIONS, {"plan": ["[S10 E2]", "[S99 E2]"]}, checked_keys=["plan"]
    )

    assert result.citations.unresolved == ["[S99 E2]"]
    assert [g.kind for g in result.gaps] == ["unresolved_citation"]


def test_an_inline_bracketed_citation_supports_the_numbers_of_its_section() -> None:
    # No `sources` at all: the inline `[S10 E2]` / `[S11 E2]` are the section's citations.
    result = check_coverage(PLAN, SECTIONS, {}, checked_keys=["plan"])

    assert [g for g in result.gaps if g.kind == "number_mismatch"] == []
    assert (result.numbers.total, result.numbers.matched) == (2, 2)


def test_a_number_its_cited_source_does_not_state_is_still_a_mismatch() -> None:
    sections = {**SECTIONS, "plan": PLAN_TEXT.replace("1000 mg", "2000 mg")}
    result = check_coverage(PLAN, sections, SOURCES, checked_keys=CHECKED)

    assert ("number_mismatch", "plan") in [(g.kind, g.section_key) for g in result.gaps]


@pytest.mark.parametrize(
    ("dropped", "missing"),
    [
        # The dose change: metformin is still named (encounter 1), the new dose is not.
        ("Metformin increased to 1000 mg twice daily for blood sugar control [S10 E2]. ", "E2-F4"),
        # The new drug.
        ("Started amlodipine 5 mg once daily for blood pressure management [S11 E2]. ", "E2-F5"),
        # The follow-up interval.
        ("Review in four weeks [S11 E2].", "E2-F6"),
    ],
)
def test_dropping_an_encounter_2_fact_is_still_a_gap(dropped: str, missing: str) -> None:
    assert dropped in PLAN_TEXT
    sections = {**SECTIONS, "plan": PLAN_TEXT.replace(dropped, "")}
    result = check_coverage(PLAN, sections, SOURCES, checked_keys=CHECKED)

    assert missing in result.critical_facts.missing


def test_a_literal_anchor_is_still_required() -> None:
    sections = {**SECTIONS, "subjective": SUBJECTIVE.replace("penicillin", "an antibiotic")}
    result = check_coverage(PLAN, sections, SOURCES, checked_keys=CHECKED)

    assert result.critical_facts.missing == ["E1-F2"]


def test_aliases_are_alternatives_not_all_required() -> None:
    raw = PLAN.to_wire()
    penicillin = next(f for f in raw["coverage"]["criticalFacts"] if f["factId"] == "E1-F2")
    penicillin["anchors"] = ["penicillin", "pcn"]
    plan = NotePlanV1.model_validate(raw)

    result = check_coverage(plan, SECTIONS, SOURCES, checked_keys=CHECKED)

    assert result.critical_facts.missing == []


@pytest.mark.parametrize("spoken", ["150 over 95", "150/95", "150 / 95"])
def test_a_blood_pressure_reading_has_one_spelling(spoken: str) -> None:
    assert normalise_text(f"BP {spoken} today") == "bp 150/95 today"
    assert contains_value(normalise_text(f"Blood pressure {spoken}."), "150 over 95")


def test_over_between_other_numbers_is_left_alone() -> None:
    # "over" stays a word here (only a blood-pressure reading becomes a fraction); the duration
    # unit is singular after normalisation, like "4 weeks" / "4-week".
    assert normalise_text("lost 5 kg over 3 months") == "lost 5 kg over 3 month"
