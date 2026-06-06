"""PDSQI-9 LLM-as-judge tests (TASK-330, task 0.5).

RED-first. Pins the contract of the model-agnostic PDSQI-9 judge built on
Epic's open-source instrument (JSON in / JSON out; 1–5 Likert per dimension +
justifications). No live LLM: the judge is driven by a deterministic stub client.
"""

from __future__ import annotations

import pytest

from harness.eval.judge import OutputMode, PDSQI9Judge, resolve_prompt
from harness.eval.judge.base import JudgeParseError
from harness.eval.models import GoldenCase, PDSQIResult, PDSQIScore

from ._stubs import StubJudgeClient, pdsqi_detail_json, pdsqi_score_json


@pytest.fixture
def case() -> GoldenCase:
    return GoldenCase(
        case_id="case-001",
        source_documents=[
            "Patient reports cough x3 days, no fever. Lungs clear. Plan: rest, fluids.",
            "PMH: hypertension on lisinopril 10mg daily.",
        ],
        generated_note="Acute cough, afebrile. HTN stable on lisinopril 10 mg <Note ID:2>. Plan: supportive care <Note ID:1>.",
        target_specialty="Family Medicine",
    )


class TestResolvePrompt:
    def test_prompt_includes_notes_summary_specialty_and_rubric(self, case: GoldenCase):
        messages = resolve_prompt(
            notes=case.source_documents,
            summary=case.generated_note,
            target_specialty=case.target_specialty,
        )
        assert messages[0]["role"] == "system"
        assert messages[1]["role"] == "user"
        user = messages[1]["content"]
        # source notes are embedded with NoteID delimiters (Epic format)
        assert "lisinopril 10mg daily" in user
        assert "<NoteID:1>" in user and "<NoteID:2>" in user
        # the summary under test
        assert "Acute cough, afebrile" in user
        # target specialty
        assert "Family Medicine" in user
        # all 9+ PDSQI dimensions present in the rubric
        for dim in ("citation", "accurate", "thorough", "synthesized", "voice_summ", "voice_note"):
            assert dim in user.lower()

    def test_score_mode_and_explanation_mode_differ(self, case: GoldenCase):
        score_msgs = resolve_prompt(
            case.source_documents, case.generated_note, case.target_specialty, OutputMode.SCORE
        )
        expl_msgs = resolve_prompt(
            case.source_documents,
            case.generated_note,
            case.target_specialty,
            OutputMode.WITH_EXPLANATION,
        )
        assert "explanation" in expl_msgs[1]["content"].lower()
        assert score_msgs[1]["content"] != expl_msgs[1]["content"]


class TestParse:
    def test_parse_score_only_response(self):
        judge = PDSQI9Judge(StubJudgeClient(""), output_mode=OutputMode.SCORE)
        score = judge.parse(pdsqi_score_json(citation=3, accurate=4))
        assert isinstance(score, PDSQIScore)
        assert score.citation == 3
        assert score.accurate == 4
        assert score.voice_note == 0
        assert score.justifications == {}

    def test_parse_strips_think_prefix(self):
        judge = PDSQI9Judge(StubJudgeClient(""), output_mode=OutputMode.SCORE)
        raw = "<think>\nThe summary cites both notes correctly...\n</think>\n" + pdsqi_score_json()
        score = judge.parse(raw)
        assert score.citation == 4

    def test_parse_response_with_explanations(self):
        judge = PDSQI9Judge(StubJudgeClient(""), output_mode=OutputMode.WITH_EXPLANATION)
        score = judge.parse(pdsqi_detail_json(thorough=2))
        assert score.thorough == 2
        assert "thorough" in score.justifications
        assert score.justifications["thorough"]

    def test_parse_handles_synthesized_na(self):
        judge = PDSQI9Judge(StubJudgeClient(""), output_mode=OutputMode.SCORE)
        score = judge.parse(pdsqi_score_json(synthesized="NA"))
        assert score.synthesized is None

    def test_parse_rejects_malformed_json(self):
        judge = PDSQI9Judge(StubJudgeClient(""), output_mode=OutputMode.SCORE)
        with pytest.raises(JudgeParseError):
            judge.parse("not json at all { ]")

    def test_parse_rejects_out_of_range_score(self):
        judge = PDSQI9Judge(StubJudgeClient(""), output_mode=OutputMode.SCORE)
        with pytest.raises(JudgeParseError):
            judge.parse(pdsqi_score_json(citation=7))


class TestScore:
    @pytest.mark.asyncio
    async def test_score_calls_client_and_returns_result(self, case: GoldenCase):
        client = StubJudgeClient(pdsqi_score_json(accurate=5, thorough=4))
        judge = PDSQI9Judge(client, output_mode=OutputMode.SCORE)

        result = await judge.score(case)

        assert isinstance(result, PDSQIResult)
        assert result.case_id == "case-001"
        assert result.score.accurate == 5
        assert result.model == "stub-judge"
        # the client actually received the summary under test
        assert len(client.calls) == 1
        assert "Acute cough, afebrile" in client.calls[0][1]["content"]
