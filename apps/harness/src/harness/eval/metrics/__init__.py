"""Eval metrics: RAGAS-style faithfulness + DeepEval metric wrappers."""

from __future__ import annotations

# DeepEval wrappers import safely without deepeval installed (the heavy import is
# deferred to the builder functions), so re-exporting them here is side-effect free.
from harness.eval.metrics.deepeval_metrics import (
    build_deepeval_model,
    build_faithfulness_metric,
    build_geval_metric,
    build_hallucination_metric,
    build_summarization_metric,
    to_llm_test_case,
)
from harness.eval.metrics.faithfulness import (
    ClaimExtractor,
    ClaimVerifier,
    FaithfulnessEvaluator,
    LLMClaimExtractor,
    LLMClaimVerifier,
    build_faithfulness_evaluator,
)

__all__ = [
    "ClaimExtractor",
    "ClaimVerifier",
    "FaithfulnessEvaluator",
    "LLMClaimExtractor",
    "LLMClaimVerifier",
    "build_faithfulness_evaluator",
    # DeepEval wrappers
    "build_deepeval_model",
    "build_faithfulness_metric",
    "build_geval_metric",
    "build_hallucination_metric",
    "build_summarization_metric",
    "to_llm_test_case",
]
