"""Coverage reads a multi-word term by its distinctive words and a follow-up by how notes name one
(TASK-1045 e2e finding E2E-28).

On the E2E-QUALITY replay (synthetic two-encounter consultation, 48 recorded gemma notes) coverage
reported ``order:troponin blood test`` missing in 21 notes and ``follow_up:review`` in 11 that
said "Troponin level was 12" and "Follow-up scheduled in four weeks"; those false gaps sent
correct notes to AWAITING_REVIEW. The ledger side (keys, kinds, numbers) is repaired at persist
time in apps/api; this file pins the matcher half and replays three recorded notes against the
plan whose critical facts are what that persist-time repair now writes.

A real omission must stay a gap: a missing allergen or drug name is never satisfied by a generic
word, and a follow-up without its interval is still missing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from harness.services.note_plan.coverage import check_coverage
from harness.services.note_plan.merge import split_sections
from harness.services.note_plan.models import NotePlanV1

REPLAY = json.loads(
    Path(__file__).with_name("quality_replay_plan_task1045.json").read_text(encoding="utf-8")
)
PLAN = NotePlanV1.model_validate(REPLAY["plan"])
KEYS = [h.key for h in PLAN.headings]


def _missing_keys(note: str, plan: NotePlanV1 = PLAN) -> list[str]:
    result = check_coverage(plan, split_sections(note, plan, KEYS), {})
    by_id = {f.fact_id: f.key for f in plan.coverage.critical_facts or ()}
    return [by_id[fact_id] for fact_id in result.critical_facts.missing]


@pytest.mark.parametrize("case", REPLAY["notes"], ids=lambda c: c["tag"])
def test_the_recorded_notes_lose_only_the_fact_they_really_omit(case: dict[str, Any]) -> None:
    # Every recorded first pass leaves out the penicillin allergy (a true gap) and names the
    # troponin as a "level" and the review as a follow-up (false gaps before the fix).
    assert _missing_keys(case["note"]) == ["allergy:penicillin"]


NOTE = (
    "## Subjective\nChest tightness for two days [S2]. Allergic to penicillin, rash [S5].\n"
    "## Objective\nBP 150/95 [S8]. ECG normal; troponin level 12 [S13].\n"
    "## Assessment\nExertional chest tightness.\n"
    "## Plan\nMetformin increased to 1000 mg twice daily [S16]. Amlodipine 5 mg once daily "
    "started [S17]. Follow-up scheduled in four weeks [S20], earlier if the chest pain gets "
    "worse [S21]. ECG and troponin were sent [S10]."
)


def test_a_complete_note_has_no_missing_fact() -> None:
    assert _missing_keys(NOTE) == []


@pytest.mark.parametrize(
    ("before", "after", "missing"),
    [
        # The allergen itself must be named; "allergic" alone is not the allergy.
        ("Allergic to penicillin, rash", "Allergic to an antibiotic, rash", "allergy:penicillin"),
        ("Allergic to penicillin, rash", "Allergic to sulfa, rash", "allergy:penicillin"),
        # A drug name is never stood in for by its dose.
        (
            "Amlodipine 5 mg once daily started",
            "A new tablet 5 mg once daily started",
            "medication:amlodipine",
        ),
        # The changed dose is a number the note must state.
        ("Metformin increased to 1000 mg", "Metformin increased", "medication:metformin"),
        # A follow-up named the note's way still needs its interval.
        (
            "Follow-up scheduled in four weeks [S20], ",
            "Follow-up arranged [S20], ",
            "follow_up:review",
        ),
    ],
)
def test_a_real_omission_stays_a_gap(before: str, after: str, missing: str) -> None:
    assert before in NOTE
    assert missing in _missing_keys(NOTE.replace(before, after))


def test_a_generic_word_never_stands_for_a_multi_word_term() -> None:
    note = NOTE.replace("troponin level 12", "blood level 12").replace(
        "ECG and troponin were sent", "ECG and bloods were sent"
    )
    assert "order:troponin_blood_test" in _missing_keys(note)


@pytest.mark.parametrize(
    "phrase",
    [
        "Follow-up in four weeks",
        "Review in 4 weeks",
        "Return in four weeks",
        "Come back in 4 weeks",
    ],
)
def test_a_follow_up_is_present_under_the_words_a_note_uses_for_one(phrase: str) -> None:
    note = NOTE.replace("Follow-up scheduled in four weeks", phrase)
    assert "follow_up:review" not in _missing_keys(note)
