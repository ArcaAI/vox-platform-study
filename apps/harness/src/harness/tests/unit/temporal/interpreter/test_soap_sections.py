"""the harness-side SOAP mirror must match the default engine's parser.

``_soap.py`` is a deliberate mirror of
``packages/applications/.../live-documentation/soap-parser.ts`` so an interpreter-produced
running note renders in the SAME console panel, with the same section titles and the same
degrade, as one produced by the default engine. These cases are the TS parser's own documented
behaviours, restated as executable expectations — if the two ever diverge, this is where it
shows.
"""

from __future__ import annotations

from harness.temporal.interpreter.nodes import _soap


class TestProseParsing:
    def test_parses_the_four_canonical_sections_in_order(self):
        sections = _soap.parse_soap_sections(
            "Subjective: Cough.\nObjective: Temp 37.8.\nAssessment: URTI.\nPlan: Fluids."
        )
        assert [s["title"] for s in sections] == list(_soap.SOAP_SECTION_TITLES)
        assert sections[0]["content"] == "Cough."
        assert sections[3]["content"] == "Fluids."

    def test_tolerates_markdown_headers_and_emphasis(self):
        sections = _soap.parse_soap_sections(
            "## Subjective\nCough for 3 days.\n**Objective:** Temp 37.8C\n"
            "### Assessment\nURTI\n- Plan: Fluids"
        )
        assert [s["title"] for s in sections] == list(_soap.SOAP_SECTION_TITLES)
        assert sections[0]["content"] == "Cough for 3 days."
        assert sections[1]["content"] == "Temp 37.8C"
        assert sections[3]["content"] == "Fluids"

    def test_a_single_header_is_not_enough_to_claim_structure(self):
        """The TS parser requires >= 2 recognised headers; one stray word must not shred
        ordinary prose into an empty SOAP form."""
        sections = _soap.parse_soap_sections("The plan: discussed at length with the patient.")
        assert sections == [
            {
                "title": "Running Summary",
                "content": "The plan: discussed at length with the patient.",
            }
        ]

    def test_unstructured_prose_degrades_to_one_running_summary_section(self):
        assert _soap.parse_soap_sections("just prose") == [
            {"title": "Running Summary", "content": "just prose"}
        ]

    def test_empty_input_yields_no_sections(self):
        assert _soap.parse_soap_sections("   ") == []


class TestJsonParsing:
    def test_parses_a_soap_json_object(self):
        sections = _soap.parse_soap_json(
            '{"subjective": "Cough", "objective": "Temp", "assessment": "URTI", "plan": "Fluids"}'
        )
        assert sections is not None
        assert [s["content"] for s in sections] == ["Cough", "Temp", "URTI", "Fluids"]

    def test_strips_a_markdown_code_fence(self):
        sections = _soap.parse_soap_json('```json\n{"subjective": "Cough"}\n```')
        assert sections is not None
        assert sections[0]["content"] == "Cough"
        # Lenient on missing keys — an absent section is EMPTY, never fabricated.
        assert sections[3]["content"] == ""

    def test_returns_none_for_non_soap_json_so_the_caller_can_fall_back(self):
        assert _soap.parse_soap_json('{"something": "else"}') is None
        assert _soap.parse_soap_json("not json") is None
        assert _soap.parse_soap_json("[1, 2, 3]") is None


class TestRunningSummary:
    def test_joins_only_populated_sections(self):
        flat = _soap.build_running_summary(
            [
                {"title": "Subjective", "content": "Cough"},
                {"title": "Objective", "content": ""},
                {"title": "Assessment", "content": "URTI"},
            ]
        )
        assert flat == "Cough\n\nURTI"

    def test_sections_for_prefers_json_then_falls_back_to_prose(self):
        json_sections, json_flat = _soap.sections_for('{"subjective": "Cough", "plan": "Fluids"}')
        assert [s["title"] for s in json_sections] == list(_soap.SOAP_SECTION_TITLES)
        assert json_flat == "Cough\n\nFluids"

        prose_sections, prose_flat = _soap.sections_for("Subjective: Cough\nPlan: Fluids")
        assert [s["title"] for s in prose_sections] == list(_soap.SOAP_SECTION_TITLES)
        assert prose_flat == "Cough\n\nFluids"
