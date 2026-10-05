"""The shapes a plan call may answer in, and the response format each call asks for.

A live run (Gemma 4 E2B, temperature 0, single-pass plan) answered with a JSON object keyed by
section TITLE whose values were lists of cited lines. The merge put the whole blob under the
first heading and marked the other three "Not discussed". Every shape below must render to the
same headed note.

Hermetic — the plans come from the pinned fixture, the text call is stubbed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from harness.services.note_plan.executor import (
    NoteCallRequest,
    NoteCallResult,
    execute_plan,
    section_response_format,
)
from harness.services.note_plan.merge import NOT_DISCUSSED_MARKER, merge_sections, parse_answer
from harness.services.note_plan.models import NotePlanV1

FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[7] / "tests" / "contracts" / "note-plan.fixture.json"
    ).read_text(encoding="utf-8")
)


def _plan(name: str) -> NotePlanV1:
    raw = next(case["plan"] for case in FIXTURE["notePlans"] if case["name"] == name)
    return NotePlanV1.model_validate(json.loads(json.dumps(raw)))


SINGLE = "single_pass_two_encounters"
GROUPS = "ledger_prior_section_groups_with_audio_and_draft"
ALL = ["subjective", "objective", "assessment", "plan"]

#: The live answer's shape: title-keyed, list values, citations inline.
LIVE_ANSWER = {
    "Subjective": [
        "Patient reports chest tightness for two days [S2 E1]",
        "Known type 2 diabetes on metformin",
    ],
    "Objective": ["ECG and troponin normal [S4 E2]", "Troponin 12 ng/L [R1]"],
    "Assessment": ["Chest tightness, cardiac cause excluded [S4 E2]"],
    "Plan": ["Increase metformin to 1000 mg twice daily [S5 E2]", "Review in four weeks [S5 E2]"],
}


def _note(plan: NotePlanV1, content: str, keys: list[str]) -> str:
    return merge_sections(plan, parse_answer(content, plan, keys).sections, {})


def test_the_live_title_keyed_json_fills_every_section() -> None:
    plan = _plan(SINGLE)
    note = _note(plan, json.dumps(LIVE_ANSWER), ALL)

    assert NOT_DISCUSSED_MARKER not in note
    assert "{" not in note and '"' not in note
    assert note.startswith(
        "## Subjective\n- Patient reports chest tightness for two days [S2 E1]\n"
        "- Known type 2 diabetes on metformin\n\n## Objective\n"
    )
    assert note.endswith(
        "## Plan\n- Increase metformin to 1000 mg twice daily [S5 E2]\n"
        "- Review in four weeks [S5 E2]"
    )


def test_fenced_json_is_unwrapped() -> None:
    plan = _plan(SINGLE)
    note = _note(plan, f"```json\n{json.dumps(LIVE_ANSWER, indent=2)}\n```", ALL)

    assert NOT_DISCUSSED_MARKER not in note
    assert "```" not in note
    assert "## Assessment\n- Chest tightness, cardiac cause excluded [S4 E2]" in note


def test_section_key_keyed_json_with_string_values_any_case() -> None:
    plan = _plan(SINGLE)
    answer = {
        "subjective": "Chest tightness for two days.",
        "OBJECTIVE": "Troponin 12 ng/L.",
        "Assessment:": "Stable.",
        "plan": "Increase metformin to 1000 mg; review in four weeks.",
    }
    sections = parse_answer(json.dumps(answer), plan, ALL).sections

    assert sections == {
        "subjective": "Chest tightness for two days.",
        "objective": "Troponin 12 ng/L.",
        "assessment": "Stable.",
        "plan": "Increase metformin to 1000 mg; review in four weeks.",
    }


def test_a_list_item_already_bulleted_is_not_double_bulleted() -> None:
    plan = _plan(SINGLE)
    sections = parse_answer(json.dumps({"plan": ["- Review in four weeks", "* ECG"]}), plan, ALL)
    assert sections.sections == {"plan": "- Review in four weeks\n- ECG"}


def test_only_a_genuinely_absent_section_is_not_discussed() -> None:
    plan = _plan(SINGLE)
    answer = {"Subjective": ["Chest tightness"], "Objective": "", "Plan": ["Review"]}
    note = _note(plan, json.dumps(answer), ALL)

    assert note == (
        "## Subjective\n- Chest tightness\n\n"
        f"## Objective\n{NOT_DISCUSSED_MARKER}\n\n"
        f"## Assessment\n{NOT_DISCUSSED_MARKER}\n\n"
        "## Plan\n- Review"
    )


def test_a_json_group_cannot_write_a_section_it_was_not_given() -> None:
    plan = _plan(GROUPS)
    answer = {"Subjective": "A", "Objective": "B", "Plan": "Sneaky"}
    assert parse_answer(json.dumps(answer), plan, ["subjective", "objective"]).sections == {
        "subjective": "A",
        "objective": "B",
    }


def test_flat_json_keeps_its_sources_and_redactions() -> None:
    plan = _plan(GROUPS)
    answer = {
        "subjective": "Allergic to penicillin.",
        "objective": "Home blood pressure 150/95.",
        "redactions": [{"text": "John", "label": "NAME"}],
        "sources": [
            {"sectionKey": "subjective", "refs": ["S7"]},
            {"sectionKey": "plan", "refs": ["S420"]},  # not this call's section
        ],
    }
    parsed = parse_answer(json.dumps(answer), plan, ["subjective", "objective"])

    assert parsed.sections == {
        "subjective": "Allergic to penicillin.",
        "objective": "Home blood pressure 150/95.",
    }
    assert parsed.sources == {"subjective": ["S7"]}
    assert parsed.redactions == [{"text": "John", "label": "NAME"}]


def test_headed_markdown_is_unchanged() -> None:
    plan = _plan(SINGLE)
    content = (
        "## Subjective\nChest tightness.\n\n## Objective\nTroponin 12 ng/L.\n\n"
        "## Assessment\nStable.\n\n## Plan\nReview in four weeks."
    )
    assert _note(plan, content, ALL) == content


def test_the_case_note_envelope_is_unchanged() -> None:
    plan = _plan(SINGLE)
    content = json.dumps(
        {
            "case_note": "## Subjective\nA\n\n## Plan\nB",
            "redactions": [],
            "sources": [{"sectionKey": "plan", "ids": ["S5"]}],
        }
    )
    parsed = parse_answer(content, plan, ALL)
    assert parsed.sections == {"subjective": "A", "plan": "B"}
    assert parsed.sources == {"plan": ["S5"]}


# ---------------------------------------------------------------------------------------------
# The response format each call requests
# ---------------------------------------------------------------------------------------------


def test_the_section_response_format_names_exactly_the_call_sections() -> None:
    fmt = section_response_format(["assessment", "plan"])

    assert fmt["type"] == "json_schema"
    schema = fmt["json_schema"]["schema"]
    assert fmt["json_schema"]["strict"] is True
    assert schema["additionalProperties"] is False
    section_props = {
        k: v for k, v in schema["properties"].items() if k not in ("redactions", "sources")
    }
    assert section_props == {"assessment": {"type": "string"}, "plan": {"type": "string"}}
    assert set(schema["required"]) == set(schema["properties"])
    source = schema["properties"]["sources"]["items"]
    assert source["properties"]["sectionKey"] == {"type": "string", "enum": ["assessment", "plan"]}
    assert source["properties"]["refs"] == {"type": "array", "items": {"type": "string"}}


async def test_every_call_and_the_repair_request_their_own_sections() -> None:
    plan = _plan(GROUPS)
    seen: list[NoteCallRequest] = []

    async def generate(request: NoteCallRequest) -> NoteCallResult:
        seen.append(request)
        # Omits every critical fact, so the repair runs too.
        return NoteCallResult(content=json.dumps(dict.fromkeys(request.section_keys, "Seen.")))

    await execute_plan(plan, system=None, user_prefix="P", generate=generate)

    assert [r.kind for r in seen] == ["call", "call", "repair"]
    for request in seen:
        assert request.response_format == section_response_format(request.section_keys)


async def test_the_live_shape_through_the_executor_renders_and_checks_like_markdown() -> None:
    plan = _plan(SINGLE)

    def run(content: str) -> Any:
        async def generate(request: NoteCallRequest) -> NoteCallResult:
            return NoteCallResult(content=content)

        return execute_plan(plan, system=None, user_prefix="P", generate=generate)

    from_json = await run(json.dumps(LIVE_ANSWER))
    note = from_json.document["case_note"]
    as_markdown = await run(note)

    assert NOT_DISCUSSED_MARKER not in note
    assert "[S2 E1]" in note and "[S5 E2]" in note
    assert from_json.coverage.status == "complete"
    assert from_json.coverage == as_markdown.coverage
    assert as_markdown.document["case_note"] == note
