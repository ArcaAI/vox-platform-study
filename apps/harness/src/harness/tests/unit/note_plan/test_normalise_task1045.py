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
