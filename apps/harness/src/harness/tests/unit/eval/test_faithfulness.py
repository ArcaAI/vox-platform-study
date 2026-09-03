"""RAGAS-style faithfulness tests.

Faithfulness = (# claims supported by context) / (# total claims)
via claim decomposition + per-claim support (entailment) checking. The
decomposition/verification are model-agnostic (driven by a JudgeClient) and
fully stubbed here — no live LLM.
"""

from __future__ import annotations

import pytest

from harness.eval.metrics.faithfulness import (
    FaithfulnessEvaluator,
    LLMClaimExtractor,
    LLMClaimVerifier,
    build_faithfulness_evaluator,
)
from harness.eval.models import FaithfulnessResult, GoldenCase

from ._stubs import (
    ScriptedJudgeClient,
    StubClaimExtractor,
    StubClaimVerifier,
)


def _case() -> GoldenCase:
    return GoldenCase(
        case_id="f-1",
        source_documents=["BP 120/80. Started lisinopril 10 mg daily for hypertension."],
        generated_note="Patient has hypertension. Started on lisinopril 10 mg daily. Has diabetes.",
    )


class TestFaithfulnessScore:
    @pytest.mark.asyncio
    async def test_all_claims_supported_scores_one(self):
        claims = ["has hypertension", "started lisinopril 10 mg daily"]
        evaluator = FaithfulnessEvaluator(
            StubClaimExtractor(claims), StubClaimVerifier(set(claims))
        )
        result = await evaluator.evaluate(_case())
        assert isinstance(result, FaithfulnessResult)
        assert result.score == pytest.approx(1.0)
        assert result.supported_claims == 2
        assert result.total_claims == 2
        assert result.unsupported == []

    @pytest.mark.asyncio
    async def test_no_claims_supported_scores_zero(self):
        claims = ["has hypertension", "has diabetes"]
        evaluator = FaithfulnessEvaluator(StubClaimExtractor(claims), StubClaimVerifier(set()))
        result = await evaluator.evaluate(_case())
        assert result.score == pytest.approx(0.0)
        assert result.supported_claims == 0
        assert set(result.unsupported) == set(claims)

    @pytest.mark.asyncio
    async def test_partial_support_is_ratio(self):
        claims = ["has hypertension", "started lisinopril 10 mg daily", "has diabetes"]
        evaluator = FaithfulnessEvaluator(
            StubClaimExtractor(claims),
            StubClaimVerifier({"has hypertension", "started lisinopril 10 mg daily"}),
        )
        result = await evaluator.evaluate(_case())
        assert result.score == pytest.approx(2 / 3)
        assert result.supported_claims == 2
        assert result.total_claims == 3
        assert result.unsupported == ["has diabetes"]

    @pytest.mark.asyncio
    async def test_no_claims_returns_one_with_zero_total(self):
        evaluator = FaithfulnessEvaluator(StubClaimExtractor([]), StubClaimVerifier(set()))
        result = await evaluator.evaluate(_case())
        assert result.total_claims == 0
        assert result.score == pytest.approx(1.0)


class TestLLMComponents:
    @pytest.mark.asyncio
    async def test_llm_extractor_parses_claims(self):
        client = ScriptedJudgeClient(['{"claims": ["claim a", "claim b"]}'])
        extractor = LLMClaimExtractor(client)
        claims = await extractor.extract("answer", "context")
        assert claims == ["claim a", "claim b"]

    @pytest.mark.asyncio
    async def test_llm_verifier_parses_supported_verdict(self):
        client = ScriptedJudgeClient(['{"supported": true, "reason": "stated in note"}'])
        verifier = LLMClaimVerifier(client)
        assert await verifier.verify("has hypertension", "context") is True

    @pytest.mark.asyncio
    async def test_llm_verifier_parses_unsupported_verdict(self):
        client = ScriptedJudgeClient(['{"supported": false, "reason": "not in note"}'])
        verifier = LLMClaimVerifier(client)
        assert await verifier.verify("has diabetes", "context") is False

    @pytest.mark.asyncio
    async def test_llm_verifier_treats_malformed_json_as_unsupported(self):
        # reproduces a real failure hit measuring against a live
        # small local judge (Qwen2.5-1.5B-Instruct) — an occasional malformed
        # verify response (missing delimiter) previously propagated a raw
        # json.JSONDecodeError out of `evaluate` and crashed the ENTIRE
        # eval-gate run, unlike the PDSQI path (JudgeParseError is caught and
        # the case is dropped). A claim that can't be parsed has no evidence
        # of support, so it must fail closed to `False` — never raise, and
        # never silently count as supported.
        client = ScriptedJudgeClient(
            ['{"supported": true, "reason": "stated in note"']
        )  # truncated
        verifier = LLMClaimVerifier(client)
        assert await verifier.verify("has hypertension", "context") is False

    @pytest.mark.asyncio
    async def test_llm_extractor_treats_malformed_json_as_no_claims(self):
        # Same tolerance on the decomposition step — vacuous-truth precedent
        # already exists in FaithfulnessEvaluator.evaluate for an empty claim
        # list (nothing to verify → nothing can be unfaithful).
        client = ScriptedJudgeClient(['{"claims": ["a", "b"'])  # truncated
        extractor = LLMClaimExtractor(client)
        assert await extractor.extract("answer", "context") == []


class TestEndToEnd:
    @pytest.mark.asyncio
    async def test_build_evaluator_over_single_judge_client(self):
        # First completion = claim decomposition; subsequent = per-claim verdicts.
        client = ScriptedJudgeClient(
            [
                '{"claims": ["has hypertension", "has diabetes"]}',
                '{"supported": true}',
                '{"supported": false}',
            ]
        )
        evaluator = build_faithfulness_evaluator(client)
        result = await evaluator.evaluate(_case())
        assert result.score == pytest.approx(0.5)
        assert result.supported_claims == 1
        assert result.unsupported == ["has diabetes"]
