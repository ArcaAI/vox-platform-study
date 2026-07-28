"""Cross-family reasoning/channel parsing tests (judge hardening).

These use the REAL captured payload shapes seen on local LM Studio
runs across reasoning and non-reasoning model families. The judge must extract
the model's FINAL JSON answer and never mistake a ``{`` that appears inside
leaked chain-of-thought (an analysis channel, a Gemma ``thought`` block, …) for
the score object. Deterministic + offline (stub client); no live LLM.
"""

from __future__ import annotations

from harness.eval.judge import OutputMode, PDSQI9Judge

from ._stubs import StubJudgeClient, pdsqi_score_json


def _judge() -> PDSQI9Judge:
    return PDSQI9Judge(StubJudgeClient(""), output_mode=OutputMode.SCORE)


class TestReasoningLeakParsing:
    def test_medgemma_thought_leak_in_content(self):
        # medgemma-1.5-4b-it (MLX): reasoning LEAKS into ``content`` as a
        # ``<unused94>thought`` block (reasoning_content EMPTY), then the JSON.
        # The legacy ``<think>`` regex does NOT catch this marker.
        raw = (
            "<unused94>thought\n"
            "The user wants me to grade the CLINICAL_SUMMARY against the rubric. "
            "I will assess each dimension and assign an integer per the grades.\n"
            + pdsqi_score_json(citation=3, accurate=4)
        )
        score = _judge().parse(raw)
        assert score.citation == 3
        assert score.accurate == 4

    def test_gpt_oss_raw_harmony_keeps_final_channel(self):
        # gpt-oss-20b when the server does NOT parse harmony: the analysis channel
        # contains a stray ``{`` that must NOT be taken as the answer; only the
        # final-channel body is the JSON.
        raw = (
            "<|channel|>analysis<|message|>"
            "Plan: weigh each dimension. {not: valid json}"
            "<|end|>"
            "<|start|>assistant<|channel|>final<|message|>"
            + pdsqi_score_json(citation=5, accurate=5)
        )
        score = _judge().parse(raw)
        assert score.citation == 5  # the FINAL-channel JSON, not the analysis brace
        assert score.accurate == 5

    def test_gemma_fenced_json(self):
        # gemma-4-e4b / gemma-3-4b: content is a markdown-fenced ```json {…} ``` block.
        raw = "```json\n" + pdsqi_score_json(thorough=3) + "\n```"
        score = _judge().parse(raw)
        assert score.thorough == 3

    def test_qwen_think_block_then_json(self):
        # qwen/qwen3.5-9b native <think>…</think> before the JSON answer.
        raw = (
            "<think>\nBoth notes are cited correctly; one minor omission.\n</think>\n"
            + pdsqi_score_json()
        )
        score = _judge().parse(raw)
        assert score.citation == 4

    def test_dangling_unclosed_think_truncated_reasoning(self):
        # truncated reasoning: an open <think> with no close, then the JSON.
        raw = "<think>\nReasoning was cut off mid-sentence and never closed\n" + pdsqi_score_json(
            useful=3
        )
        score = _judge().parse(raw)
        assert score.useful == 3

    def test_gpt_oss_parsed_harmony_clean_json(self):
        # When the server PARSES harmony, content arrives already-clean JSON.
        score = _judge().parse(pdsqi_score_json(organized=3))
        assert score.organized == 3

    def test_thought_leak_with_braces_in_prose_still_finds_final_json(self):
        # medgemma prose "possibly with braces": the brace inside the thought must
        # not win over the real final JSON object.
        raw = (
            "<unused94>thought\n"
            "I considered the JSON shape {citation: high} but will compute scores.\n"
            + pdsqi_score_json(citation=2)
        )
        score = _judge().parse(raw)
        assert score.citation == 2
