"""Coverage matcher normalisation: equivalent spellings match, different values never do.

Both sides of every comparison (note, anchors, fact numbers, cited sources) are normalised the
same way. Units are canonicalised by SYNONYM only — never converted — so a dose stated in another
unit stays a mismatch.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from harness.services.note_plan.coverage import check_coverage, extract_numbers
from harness.services.note_plan.models import NotePlanV1

FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[7] / "tests" / "contracts" / "note-plan.fixture.json"
    ).read_text(encoding="utf-8")
)
SINGLE = "single_pass_two_encounters"


def _n() -> ModuleType:
    from harness.services.note_plan import normalise

    return normalise


# ---------------------------------------------------------------------------------------------
# The pure function
# ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("left", "right"),
    [
        ("review in four weeks", "review in 4 weeks"),
        ("zero", "0"),
        ("Twelve", "12"),
        ("twenty", "20"),
        ("twenty-one days", "21 days"),
        ("ninety nine", "99"),
        ("a hundred", "100"),
        ("one hundred and fifty", "150"),
        ("two hundred", "200"),
        ("take half a tablet", "take 0.5 a tablet"),
        ("take a half tablet", "take 0.5 tablet"),
        ("1,000 mg", "1000 mg"),
        ("1,000,000 units", "1000000 iu"),
        (".5 mg", "0.5 mg"),
        ("5mg", "5 mg"),
        ("5 milligrams", "5 mg"),
        ("1 milligram", "1 mg"),
        ("2 grams", "2 g"),
        ("400 micrograms", "400 mcg"),
        ("400 µg", "400 mcg"),
        ("400 μg", "400 mcg"),
        ("10 mL", "10 ml"),
        ("10 millilitres", "10 ml"),
        ("10 milliliters", "10 ml"),
        ("8 units", "8 iu"),
        ("8 IU", "8 iu"),
        ("140 mm Hg", "140 mmhg"),
        ("140mmHg", "140 mmhg"),
        ("72 beats per minute", "72 bpm"),
        ("40 per cent", "40 %"),
        ("40%", "40 %"),
        ("80 kilograms", "80 kg"),
        ("170 centimetres", "170 cm"),
        ("5.5 mmol/L", "5.5 mmol/l"),
        ("5.5 millimoles per litre", "5.5 mmol/l"),
    ],
)
def test_equivalent_spellings_normalise_to_the_same_text(left: str, right: str) -> None:
    n = _n()
    assert n.normalise_text(left) == n.normalise_text(right)


@pytest.mark.parametrize(
    ("left", "right"),
    [
        ("1 g", "1000 mg"),
        ("5 mg", "50 mg"),
        ("0.5", "5"),
        ("four", "fourteen"),
        ("2 g", "2 mg"),
        ("400 mcg", "400 mg"),
    ],
)
def test_different_values_or_units_never_normalise_together(left: str, right: str) -> None:
    n = _n()
    assert n.normalise_text(left) != n.normalise_text(right)


def test_words_that_merely_contain_a_number_word_are_untouched() -> None:
    n = _n()
    assert n.normalise_text("often someone on behalf of the programme") == (
        "often someone on behalf of the programme"
    )
    assert n.normalise_text("fourteen") == "14"
    assert n.normalise_text("fourth") == "fourth"


def test_unit_words_are_canonicalised_only_after_a_number() -> None:
    n = _n()
    assert n.normalise_text("Gram stain negative") == "gram stain negative"
    assert n.normalise_text("units of measure") == "units of measure"


def test_decimals_are_kept_exactly() -> None:
    n = _n()
    assert n.canonical_number("0.5") == n.canonical_number(".5") == "0.5"
    assert n.canonical_number("0.50") == "0.5"
    assert n.canonical_number("2.25") == "2.25"
    assert n.canonical_number("1,000") == "1000"
    assert n.canonical_number("four") == "4"
    assert n.canonical_number("2.5") != n.canonical_number("2")


def test_units_map_by_synonym_and_never_convert() -> None:
    n = _n()
    assert n.canonical_unit("milligrams") == "mg"
    assert n.canonical_unit("µg") == n.canonical_unit("micrograms") == "mcg"
    assert n.canonical_unit("Units") == n.canonical_unit("IU") == "iu"
    assert n.canonical_unit("mL") == "ml"
    assert n.canonical_unit("g") != n.canonical_unit("mg")
    assert n.canonical_unit(None) == ""


def test_contains_respects_number_boundaries() -> None:
    n = _n()
    note = n.normalise_text("Review in fourteen weeks; call 1999 if worse.")
    assert not n.contains(note, "four weeks")
    assert not n.contains(note, "999")
    assert n.contains(n.normalise_text("Review in 4 weeks."), "four weeks")
    # Word anchors keep prefix matching ("allerg" → "allergic").
    assert n.contains(n.normalise_text("Allergic to penicillin."), "allerg")


def test_contains_finds_a_bare_value_but_not_inside_another_number() -> None:
    n = _n()
    assert n.contains_value(n.normalise_text("review in four weeks"), "4")
    assert not n.contains_value(n.normalise_text("review in fourteen weeks"), "4")
    assert not n.contains_value(n.normalise_text("dose 4.5"), "4")
    assert not n.contains_value(n.normalise_text("dose 0.5"), "5")
    assert n.contains_value(n.normalise_text("take half a tablet"), "0.5")


# ---------------------------------------------------------------------------------------------
# Through the matcher
# ---------------------------------------------------------------------------------------------


def test_extract_numbers_normalises_values_and_units() -> None:
    assert extract_numbers("Metformin 1,000 milligrams twice daily") == [("1000", "mg")]
    assert extract_numbers("five mg") == [("5", "mg")]
    assert extract_numbers("5mg") == [("5", "mg")]
    assert extract_numbers("1 g") == [("1", "g")]
    assert extract_numbers(".5 mg") == [("0.5", "mg")]


def _plan(facts: list[dict[str, Any]], source_line: str) -> NotePlanV1:
    raw = json.loads(
        json.dumps(next(c["plan"] for c in FIXTURE["notePlans"] if c["name"] == SINGLE))
    )
    raw["blocks"] = [
        {**raw["blocks"][0], "role": "encounter_transcript", "content": f"[S1] {source_line}"},
    ]
    raw["coverage"]["sourceIds"] = {"S1": {"id": "seg-1", "v": 1, "kind": "segment"}}
    raw["coverage"]["criticalFacts"] = facts
    return NotePlanV1.model_validate(raw)


DOSE = {
    "factId": "E1-F1",
    "encounterSeq": 1,
    "key": "med:metformin",
    "kind": "dose_change",
    "anchors": ["metformin"],
    "numbers": [{"value": "1000", "unit": "mg"}],
    "citations": ["S1"],
}
REVIEW = {
    "factId": "E1-F2",
    "encounterSeq": 1,
    "key": "follow_up:review",
    "kind": "follow_up",
    "anchors": ["review", "four weeks"],
    "numbers": [{"value": "4"}],
    "citations": ["S1"],
}


def _check(plan: NotePlanV1, text: str) -> Any:
    sections = {h.key: "" for h in plan.headings} | {"plan": text}
    return check_coverage(plan, sections, {"plan": ["S1"]}, checked_keys={"plan"})


def test_equivalent_spellings_in_the_note_are_complete() -> None:
    plan = _plan([DOSE, REVIEW], "metformin 1000 mg, review in four weeks")
    result = _check(plan, "Increase metformin to 1,000 milligrams; review in 4 weeks.")
    assert result.status == "complete", result.gaps
    assert (result.numbers.total, result.numbers.matched) == (1, 1)


def test_spacing_between_number_and_unit_is_ignored() -> None:
    plan = _plan([DOSE], "metformin 1000 mg")
    assert _check(plan, "Metformin 1000mg.").status == "complete"


def test_a_dose_in_another_unit_stays_a_mismatch() -> None:
    plan = _plan([DOSE], "metformin 1000 mg")
    result = _check(plan, "Increase metformin to 1 g.")
    assert result.status == "gaps"
    assert sorted(g.kind for g in result.gaps) == ["missing_fact", "number_mismatch"]


def test_a_different_dose_stays_a_mismatch() -> None:
    plan = _plan([DOSE], "metformin 1000 mg")
    result = _check(plan, "Increase metformin to 100 mg.")
    assert sorted(g.kind for g in result.gaps) == ["missing_fact", "number_mismatch"]


def test_fourteen_weeks_does_not_satisfy_four_weeks() -> None:
    plan = _plan([REVIEW], "review in four weeks")
    result = _check(plan, "Review in fourteen weeks.")
    assert result.critical_facts.missing == ["E1-F2"]


def test_a_cited_source_spelled_differently_supports_the_note() -> None:
    plan = _plan([], "metformin 1,000 milligrams")
    result = _check(plan, "Metformin 1000 mg.")
    assert result.status == "complete", result.gaps


# ---------------------------------------------------------------------------------------------
# Normaliser limits found on the live run: thousands, hyphenated durations, "and a half",
# "units", dosing frequencies — and the omissions they must not hide
# ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("left", "right"),
    [
        ("one thousand mg", "1000 mg"),
        ("a thousand mg", "1000 mg"),
        ("two thousand five hundred units", "2500 iu"),
        ("one thousand and fifty", "1050"),
        ("ten thousand", "10000"),
        ("twenty five thousand", "25000"),
        ("a hundred thousand", "100000"),
        ("1 thousand", "1000"),
        ("two and a half thousand", "2500"),
        ("a 4-week course", "a 4 weeks course"),
        ("review in four weeks", "review in 4-week"),
        ("for 5 days", "for 5-day"),
        ("10-day course", "10 days course"),
        ("every 2 months", "every 2-month"),
        ("1 year", "1 years"),
        ("24-hour urine", "24 hours urine"),
        ("one and a half tablets", "1.5 tablets"),
        ("two and a half mg", "2.5 mg"),
        ("one-and-a-half tablets", "1.5 tablets"),
        ("10 units of insulin", "10 IU of insulin"),
        ("10 international units", "10 iu"),
        ("metformin 500 mg BD", "metformin 500 mg twice daily"),
        ("metformin 500 mg BID", "metformin 500 mg twice a day"),
        ("metformin 500 mg b.i.d.", "metformin 500 mg twice daily"),
        ("metformin 500 mg b.d.", "metformin 500 mg 2 times daily"),
        ("metformin 500 mg two times a day", "metformin 500 mg twice daily"),
        ("amoxicillin TDS", "amoxicillin three times daily"),
        ("amoxicillin TID", "amoxicillin three times a day"),
        ("amoxicillin t.d.s.", "amoxicillin 3 times per day"),
        ("amoxicillin thrice daily", "amoxicillin tds"),
        ("amlodipine OD", "amlodipine once daily"),
        ("amlodipine o.d.", "amlodipine once a day"),
        ("amlodipine one time daily", "amlodipine once daily"),
        ("paracetamol QDS", "paracetamol four times daily"),
        ("paracetamol QID", "paracetamol 4 times a day"),
        ("paracetamol q.i.d.", "paracetamol four times per day"),
        ("salbutamol PRN", "salbutamol as needed"),
        ("salbutamol p.r.n.", "salbutamol as required"),
        ("salbutamol when required", "salbutamol prn"),
    ],
)
def test_live_run_spellings_normalise_together(left: str, right: str) -> None:
    n = _n()
    assert n.normalise_text(left) == n.normalise_text(right)


@pytest.mark.parametrize(
    ("left", "right"),
    [
        ("1 thousand", "1000000"),
        ("two thousand", "200"),
        ("one and a half", "1"),
        ("4-week", "14 weeks"),
        ("4 weeks", "4 months"),
        ("4 days", "4 weeks"),
        ("twice daily", "three times daily"),
        ("once daily", "four times daily"),
        ("prn", "once daily"),
        ("bd", "tds"),
        ("10 iu", "10 mg"),
    ],
)
def test_live_run_spellings_never_merge_different_facts(left: str, right: str) -> None:
    n = _n()
    assert n.normalise_text(left) != n.normalise_text(right)


def test_frequency_abbreviations_are_whole_words_only() -> None:
    n = _n()
    # "od" inside "food", "bd" inside "abdomen", "tid" inside "tidal" are not frequencies.
    assert n.normalise_text("food diary; abdomen soft; tidal volume") == (
        "food diary; abdomen soft; tidal volume"
    )


def test_the_normaliser_is_idempotent_on_the_new_spellings() -> None:
    n = _n()
    for text in (
        "two thousand five hundred units BD for a 4-week course",
        "one and a half tablets t.d.s. prn",
        "amlodipine 5 mg OD, review in 4 weeks",
    ):
        once = n.normalise_text(text)
        assert n.normalise_text(once) == once


def test_canonical_number_reads_thousands_and_halves() -> None:
    n = _n()
    assert n.canonical_number("two thousand") == "2000"
    assert n.canonical_number("one and a half") == "1.5"
    assert n.canonical_number("2.5 thousand") == "2500"


FREQ = {
    "factId": "E1-F3",
    "encounterSeq": 1,
    "key": "frequency:metformin",
    "kind": "medication",
    "anchors": ["twice daily"],
    "numbers": [{"value": "500", "unit": "mg"}],
    "citations": ["S1"],
}
ALLERGY = {
    "factId": "E1-F4",
    "encounterSeq": 1,
    "key": "allergy:penicillin",
    "kind": "allergy",
    "anchors": ["penicillin"],
    "numbers": [],
    "citations": ["S1"],
}
COURSE = {
    "factId": "E1-F5",
    "encounterSeq": 1,
    "key": "plan:amoxicillin",
    "kind": "plan",
    "anchors": ["5 days"],
    "numbers": [{"value": "1.5", "unit": "g"}],
    "citations": ["S1"],
}


def test_a_frequency_written_as_an_abbreviation_is_not_a_gap() -> None:
    plan = _plan([FREQ], "metformin 500 mg twice daily")
    result = _check(plan, "Metformin 500 mg BD.")
    assert result.status == "complete", result.gaps


def test_a_different_frequency_is_still_a_gap() -> None:
    plan = _plan([FREQ], "metformin 500 mg twice daily")
    result = _check(plan, "Metformin 500 mg TDS.")
    assert result.critical_facts.missing == ["E1-F3"]


def test_hyphenated_durations_and_spoken_halves_are_not_gaps() -> None:
    plan = _plan([COURSE], "amoxicillin one and a half grams for five days")
    result = _check(plan, "Amoxicillin 1.5 g for a 5-day course.")
    assert result.status == "complete", result.gaps


def test_a_thousand_spoken_matches_the_written_dose() -> None:
    plan = _plan([DOSE], "metformin 1000 mg")
    result = _check(plan, "Increase metformin to one thousand milligrams.")
    assert result.status == "complete", result.gaps


def test_units_spoken_match_iu_written() -> None:
    insulin = {**DOSE, "key": "med:insulin", "anchors": ["insulin"],
               "numbers": [{"value": "10", "unit": "units"}]}  # fmt: skip
    plan = _plan([insulin], "insulin glargine ten units at night")
    result = _check(plan, "Insulin glargine 10 IU at night.")
    assert result.status == "complete", result.gaps


def test_a_missing_allergy_is_still_a_gap_however_the_rest_is_spelled() -> None:
    plan = _plan([FREQ, ALLERGY], "metformin 500 mg twice daily; allergic to penicillin")
    result = _check(plan, "Metformin 500 mg BD.")
    assert result.critical_facts.missing == ["E1-F4"]
    assert [g.kind for g in result.gaps] == ["missing_fact"]
