"""Note safety: an allergen, a dosed drug or a vital reading the note states must be grounded.

Live failure (cluster, encounter 1): the final note's Medications & Allergies said "Allergic to
allopurinol, causing swelling of lips and skin peeling [S7 E1 S32, PREVIOUS VISITS]" — S7 is the
transcript line where the patient says "I am allergic to penicillin", and allopurinol came from the
earlier case notes. Its Physical Examination copied the clinic's open-time vitals ("BP 110/60 mmHg,
HR 74 bpm … [R1]", recorded a year earlier) although the encounter transcript says "Your blood
pressure today is 152/94 and your pulse is 88". Both notes passed the citation and number checks,
because every value they stated IS in the source they cite.

The plan is the TASK-1045 live two-encounter plan with the two inputs that run had added: the
earlier-case-note pre-summary (allopurinol) and the clinic's vitals result (R1), plus the readings
spoken in the LATEST encounter.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from harness.services.note_plan.coverage import check_coverage, repair_directive
from harness.services.note_plan.models import NotePlanV1


def _plan() -> NotePlanV1:
    raw: dict[str, Any] = json.loads(
        Path(__file__).with_name("live_two_encounter_plan_task1045.json").read_text("utf-8")
    )
    pre_summary = {
        "key": "pre_summary",
        "role": "pre_summary",
        "label": "Pre-summary",
        "content": (
            "Allergies & Contraindications: Allergic to allopurinol, causing swelling of lips and "
            "skin peeling. Medications: T. NEBICARD 5MG 1-0-1."
        ),
        "tokens": 40,
    }
    results = {
        "key": "results",
        "role": "results",
        "label": "Results",
        "content": "[R1] Measured vitals: BP 110/60 mmHg · HR 74 bpm · SpO2 98 % · recorded 2025-06-20",
        "tokens": 30,
    }
    blocks = raw["blocks"]
    latest = blocks[-1]
    latest[
        "content"
    ] += "\n[S12 E2 Doctor 00:20] Your blood pressure today is 152/94 and your pulse is 88."
    raw["blocks"] = [pre_summary, blocks[0], results, latest]
    raw["coverage"]["sourceIds"]["S12"] = {"id": "seg-12", "v": 1, "kind": "segment"}
    raw["coverage"]["sourceIds"]["R1"] = {"id": "vitals-item", "v": 1, "kind": "result"}
    return NotePlanV1.model_validate(raw)


PLAN = _plan()

SUBJECTIVE = (
    "Chest tightness for two days, mostly on climbing stairs [S2 E1]. The tightness is a bit "
    "better [S9 E2]. Allergic to penicillin, which causes a rash [S4 E1]. Takes metformin 500 mg "
    "twice daily for diabetes [S6 E1]."
)
OBJECTIVE = (
    "ECG was normal [S8 E2], and the troponin level was 12, which is normal [S8 E2]. Blood "
    "pressure 152/94 and pulse 88 [S12 E2]."
)
ASSESSMENT = "Hyperglycemia noted as sugars are high [S10 E2]."
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


def _ungrounded(sections: dict[str, str]) -> list[tuple[str | None, str]]:
    result = check_coverage(PLAN, sections, {})
    return [(g.section_key, g.detail) for g in result.gaps if g.kind == "ungrounded"]


def test_a_grounded_note_has_no_ungrounded_gap() -> None:
    result = check_coverage(PLAN, SECTIONS, {})

    assert [g for g in result.gaps if g.kind == "ungrounded"] == []
    assert result.status == "complete"


# --- allergies ---------------------------------------------------------------------------------


def test_an_allergen_its_cited_transcript_line_does_not_state_is_ungrounded() -> None:
    # The live failure: the earlier allergy, attributed to today's "allergic to penicillin" line.
    subjective = SUBJECTIVE.replace(
        "Allergic to penicillin, which causes a rash [S4 E1].",
        "Allergic to allopurinol, causing swelling of lips and skin peeling [S4 E1 S32, "
        "PREVIOUS VISITS].",
    )
    gaps = _ungrounded({**SECTIONS, "subjective": subjective})

    assert len(gaps) == 1
    section, detail = gaps[0]
    assert section == "subjective"
    assert "allopurinol" in detail
    assert "S4" in detail


def test_the_same_allergy_left_uncited_is_grounded_by_the_earlier_case_notes() -> None:
    subjective = SUBJECTIVE.replace(
        "Allergic to penicillin, which causes a rash [S4 E1].",
        "Allergic to penicillin, which causes a rash [S4 E1]. Allergic to allopurinol, causing "
        "swelling of lips [PREVIOUS VISITS].",
    )
    assert _ungrounded({**SECTIONS, "subjective": subjective}) == []


def test_an_allergen_no_source_states_is_ungrounded() -> None:
    subjective = SUBJECTIVE.replace("Allergic to penicillin", "Allergic to sulfonamides")
    gaps = _ungrounded({**SECTIONS, "subjective": subjective})

    assert [section for section, _ in gaps] == ["subjective"]
    assert "sulfonamides" in gaps[0][1]


def test_an_allergy_named_after_its_agent_is_checked_too() -> None:
    subjective = SUBJECTIVE.replace(
        "Allergic to penicillin, which causes a rash [S4 E1].", "Codeine allergy noted [S4 E1]."
    )
    gaps = _ungrounded({**SECTIONS, "subjective": subjective})

    assert len(gaps) == 1 and "codeine" in gaps[0][1]


def test_no_known_drug_allergies_names_no_agent() -> None:
    subjective = SUBJECTIVE.replace(
        "Allergic to penicillin, which causes a rash [S4 E1].", "No known drug allergies."
    )
    assert _ungrounded({**SECTIONS, "subjective": subjective}) == []


# --- dosed drugs -------------------------------------------------------------------------------


def test_a_dosed_drug_its_cited_line_does_not_state_is_ungrounded() -> None:
    plan_text = PLAN_TEXT.replace("Started amlodipine 5 mg", "Started atorvastatin 40 mg")
    gaps = _ungrounded({**SECTIONS, "plan": plan_text})

    assert len(gaps) == 1
    assert gaps[0][0] == "plan" and "atorvastatin" in gaps[0][1]


def test_a_dosed_drug_from_the_earlier_case_notes_is_grounded_when_uncited() -> None:
    plan_text = PLAN_TEXT + " Continue T. Nebicard 5 mg 1-0-1 [PREVIOUS VISITS]."
    assert _ungrounded({**SECTIONS, "plan": plan_text}) == []


# --- vitals ------------------------------------------------------------------------------------


def test_an_earlier_clinic_reading_stated_as_todays_is_ungrounded() -> None:
    objective = "BP 110/60 mmHg, HR 74 bpm, SpO2 98 % [R1]."
    gaps = _ungrounded({**SECTIONS, "objective": objective})

    details = " ".join(detail for _, detail in gaps)
    assert {section for section, _ in gaps} == {"objective"}
    assert "110/60" in details and "152/94" in details
    assert "74" in details and "88" in details


def test_an_earlier_reading_stated_as_earlier_is_not_a_gap() -> None:
    objective = (
        OBJECTIVE + " Recent vital signs (recorded 2025-06-20): BP 110/60 mmHg, HR 74 bpm [R1]."
    )
    assert _ungrounded({**SECTIONS, "objective": objective}) == []


def _without_spoken_readings(*replacements: str) -> NotePlanV1:
    raw = json.loads(PLAN.model_dump_json(by_alias=True))
    for block in raw["blocks"]:
        for spoken in replacements:
            block["content"] = block["content"].replace(spoken, "Thank you.")
    return NotePlanV1.model_validate(raw)


def test_an_earlier_encounters_reading_is_the_visits_when_the_latest_states_none() -> None:
    # Encounter 2 states no reading; encounter 1's "150 over 95" is still this visit's BP.
    plan = _without_spoken_readings("Your blood pressure today is 152/94 and your pulse is 88.")
    result = check_coverage(plan, {**SECTIONS, "objective": "BP 110/60 mmHg, HR 74 bpm [R1]."}, {})
    gaps = [(g.section_key, g.detail) for g in result.gaps if g.kind == "ungrounded"]

    assert len(gaps) == 1
    section, detail = gaps[0]
    assert section == "objective"
    assert "110/60" in detail and "150/95" in detail and "encounter 1" in detail


def test_no_reading_check_when_no_encounter_states_one() -> None:
    plan = _without_spoken_readings(
        "Your blood pressure today is 152/94 and your pulse is 88.",
        "Your blood pressure today is 150 over 95.",
    )
    result = check_coverage(plan, {**SECTIONS, "objective": "BP 110/60 mmHg, HR 74 bpm [R1]."}, {})

    assert [g for g in result.gaps if g.kind == "ungrounded"] == []


# --- repair ------------------------------------------------------------------------------------


def test_the_repair_directive_names_the_ungrounded_statement() -> None:
    sections = {**SECTIONS, "objective": "BP 110/60 mmHg, HR 74 bpm [R1]."}
    result = check_coverage(PLAN, sections, {})
    directive = repair_directive(PLAN, result, ["objective"], sections)

    assert "Fix:" in directive and "152/94" in directive
