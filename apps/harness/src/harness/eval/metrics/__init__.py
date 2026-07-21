"""Eval metrics: faithfulness + concept-F1 + harm-weighted rate + DeepEval wrappers."""

from __future__ import annotations

# DeepEval wrappers import safely without deepeval installed (the heavy import is
# deferred to the builder functions), so re-exporting them here is side-effect free.
from harness.eval.metrics.concept_f1 import (
    canonical_key,
    compute_concept_f1,
    normalize_reference_key,
    score_concept_f1,
)
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
from harness.eval.metrics.harm_weighted import (
    MAJOR_CATEGORIES,
    MAJOR_WEIGHT,
    MINOR_CATEGORIES,
    MINOR_WEIGHT,
    SEVERITY_WEIGHTS_V1,
    is_minor,
    score_harm_weighted,
    severity_weight,
)

__all__ = [
    "ClaimExtractor",
    "ClaimVerifier",
    "FaithfulnessEvaluator",
    "LLMClaimExtractor",
    "LLMClaimVerifier",
    "build_faithfulness_evaluator",
    # Concept-F1 (omission catcher)
    "canonical_key",
    "compute_concept_f1",
    "normalize_reference_key",
    "score_concept_f1",
    # Harm-weighted error rate (clinical significance)
    "MAJOR_CATEGORIES",
    "MAJOR_WEIGHT",
    "MINOR_CATEGORIES",
    "MINOR_WEIGHT",
    "SEVERITY_WEIGHTS_V1",
    "is_minor",
    "score_harm_weighted",
    "severity_weight",
    # DeepEval wrappers
    "build_deepeval_model",
    "build_faithfulness_metric",
    "build_geval_metric",
    "build_hallucination_metric",
    "build_summarization_metric",
    "to_llm_test_case",
]
