"""The repair EDITS the draft it was given: the gap sections' own text, plus each missing fact quoted
from its source line.

Measured on Gemma 4 E2B (T0) against the live two-encounter replay: a repair that rewrote a gap
section from a bare list of fact terms ("allergy: allergy [S5]") dropped facts the section already
had (the amlodipine start, the metformin change) in 4 of 5 runs and restored the omitted allergy in
1 of 5. Handing the section back with the source line quoted is what the directive pins.

Hermetic: plans come from the pinned fixture, the text calls are stubbed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from harness.services.note_plan.coverage import check_coverage, gap_section_keys, repair_directive
from harness.services.note_plan.executor import NoteCallRequest, NoteCallResult, execute_plan
from harness.services.note_plan.models import NotePlanV1

FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[7] / "tests" / "contracts" / "note-plan.fixture.json"
    ).read_text(encoding="utf-8")
)


def _plan() -> NotePlanV1:
    raw = next(
        case["plan"]
        for case in FIXTURE["notePlans"]
        if case["name"] == "single_pass_two_encounters"
    )
    return NotePlanV1.model_validate(json.loads(json.dumps(raw)))


SECTIONS = {
    "subjective": "Chest tightness for two days [S2].",
    "objective": "Troponin 12 ng/L, normal [R1].",
    "assessment": "Chest tightness, cardiac causes excluded [S4].",
    # The follow-up (E2-F3, cited S5) is missing; the metformin change is present.
    "plan": "Increase metformin to 1000 mg twice daily [S5].",
}
SOURCES = {"subjective": ["S2"], "objective": ["R1"], "assessment": ["S4"], "plan": ["S5"]}
S5_LINE = "Increase metformin to 1000 mg twice daily and review in four weeks."


def _directive(drafts: dict[str, str] | None = None) -> list[str]:
    plan = _plan()
    result = check_coverage(plan, SECTIONS, SOURCES)
    return repair_directive(plan, result, ["plan"], drafts).splitlines()


def test_the_repair_hands_back_the_gap_section_and_asks_to_keep_every_sentence() -> None:
    lines = _directive({"plan": SECTIONS["plan"], "subjective": SECTIONS["subjective"]})

    assert lines[0] == "Rewrite only these sections: Plan."
    assert lines[1] == (
        "Your previous draft of these sections is below. Keep every sentence of it, except what a "
        "Fix line asks you to correct, and add each fact listed after it that the draft left out: "
        "one sentence per fact, written in English from its quoted source line and ending with "
        "that label."
    )
    assert lines[2] == "Previous draft:"
    assert lines[3] == "## Plan"
    assert lines[4] == SECTIONS["plan"]
    assert lines[5] == "Add these facts:"
    # Only the gap section comes back; a section the repair does not rewrite stays out.
    assert SECTIONS["subjective"] not in "\n".join(lines)


def test_a_missing_fact_is_quoted_from_its_source_line_with_its_label() -> None:
    lines = _directive({"plan": SECTIONS["plan"]})

    assert lines[-1] == f'- follow up [S5]: "{S5_LINE}"'


def test_without_a_draft_the_repair_still_quotes_the_source_line() -> None:
    lines = _directive()

    assert lines[0] == "Rewrite only these sections: Plan."
    assert "Previous draft:" not in lines
    assert lines[-1] == f'- follow up [S5]: "{S5_LINE}"'


def test_a_fact_whose_citation_names_no_rendered_line_falls_back_to_its_terms() -> None:
    raw: dict[str, Any] = _plan().to_wire()
    raw["coverage"]["criticalFacts"][1]["citations"] = ["S99"]
    raw["coverage"]["sourceIds"]["S99"] = {
        "id": "0199a000-0000-7000-8000-000000000099",
        "v": 1,
        "kind": "segment",
    }
    plan = NotePlanV1.model_validate(raw)
    result = check_coverage(plan, SECTIONS, SOURCES)

    keys = gap_section_keys(plan, result)

    lines = repair_directive(plan, result, keys, {k: SECTIONS[k] for k in keys}).splitlines()

    assert lines[-1] == "- follow up: review; four weeks [S99]"


def _answer(sections: dict[str, str], refs: dict[str, list[str]]) -> str:
    note = "\n\n".join(f"## {k.title()}\n{v}" for k, v in sections.items())
    return json.dumps(
        {
            "case_note": note,
            "redactions": [],
            "sources": [{"sectionKey": k, "refs": v} for k, v in refs.items()],
        }
    )


async def test_the_executor_hands_the_first_pass_text_of_the_gap_section_to_the_repair() -> None:
    answers = [
        _answer(SECTIONS, SOURCES),
        _answer({"plan": f"{SECTIONS['plan']} Review in four weeks [S5]."}, {"plan": ["S5"]}),
    ]
    requests: list[NoteCallRequest] = []

    async def generate(request: NoteCallRequest) -> NoteCallResult:
        requests.append(request)
        return NoteCallResult(content=answers.pop(0))

    execution = await execute_plan(_plan(), system="sys", user_prefix="PREFIX", generate=generate)

    repair = requests[1]
    assert repair.kind == "repair"
    assert f"Previous draft:\n## Plan\n{SECTIONS['plan']}\nAdd these facts:" in repair.user
    assert execution.coverage.status == "complete"
