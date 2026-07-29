"""Hermetic tests for the MiniCheck-Flan-T5 GGUF groundedness scorer.

No llama.cpp / weights needed: the model-dependent first-step logit read is injected
as a fake ``logit_fn``, so these lock the pure scoring math, the MiniCheck template,
the **calibration safety gate**, and the fail-closed loader. The live numeric
calibration against real weights is an on-host staging step (see the module docstring).
"""

from __future__ import annotations

import pytest

from guardrail.core.config import GroundednessConfig
from guardrail.services.groundedness_nli import (
    GROUNDED,
    UNGROUNDED,
    UNVERIFIED,
    GroundednessNliVerifier,
    NliModelUnavailableError,
)
from guardrail.services.groundedness_scorer_minicheck import (
    _CAL_SUPPORTED_CLAIM,
    _CAL_UNSUPPORTED_CLAIM,
    LlamaCppMiniCheckScorer,
    LogitFn,
    _support_prob,
    load_minicheck_scorer,
)

# --- pure scoring math -----------------------------------------------------


def test_support_prob_symmetric_logits_is_half() -> None:
    assert _support_prob(0.0, 0.0) == pytest.approx(0.5)


def test_support_prob_yes_dominant_near_one() -> None:
    assert _support_prob(-5.0, 5.0) > 0.99


def test_support_prob_no_dominant_near_zero() -> None:
    assert _support_prob(5.0, -5.0) < 0.01


def test_support_prob_is_clamped_to_unit_interval() -> None:
    # Extreme logits must never escape [0, 1] (the verifier compares against a threshold).
    assert 0.0 <= _support_prob(-1e9, 1e9) <= 1.0
    assert 0.0 <= _support_prob(1e9, -1e9) <= 1.0


# --- MiniCheck template ----------------------------------------------------


def test_build_prompt_matches_minicheck_flan_t5_format() -> None:
    # 'predict: ' + doc + '</s>' + claim  (Liyan06/MiniCheck flan-t5 input).
    assert LlamaCppMiniCheckScorer.build_prompt("DOC", "CLAIM") == "predict: DOC</s>CLAIM"


# --- score_pairs order + mapping -------------------------------------------


def _claim_keyed_logits(yes_claims: set[str]) -> LogitFn:
    """A fake logit_fn: (logit_no, logit_yes) driven by which claim the prompt carries."""

    def logit_fn(prompt: str) -> tuple[float, float]:
        return (-5.0, 5.0) if any(c in prompt for c in yes_claims) else (5.0, -5.0)

    return logit_fn


def test_score_pairs_preserves_order_and_maps_probability() -> None:
    scorer = LlamaCppMiniCheckScorer(_claim_keyed_logits({"entailed claim"}))
    scores = scorer.score_pairs([("src", "entailed claim"), ("src", "contradicted claim")])
    assert scores[0] > 0.99  # entailed
    assert scores[1] < 0.01  # not entailed


# --- the calibration safety gate -------------------------------------------


def test_verify_calibration_passes_a_correctly_wired_scorer() -> None:
    scorer = LlamaCppMiniCheckScorer(_claim_keyed_logits({_CAL_SUPPORTED_CLAIM}))
    scorer.verify_calibration()  # must not raise


def test_verify_calibration_rejects_a_collapsed_scorer() -> None:
    # A mis-wired read that returns ~0.5 for everything must refuse to enable.
    scorer = LlamaCppMiniCheckScorer(lambda _prompt: (0.0, 0.0))
    with pytest.raises(NliModelUnavailableError, match="calibration self-check failed"):
        scorer.verify_calibration()


def test_verify_calibration_rejects_an_inverted_scorer() -> None:
    # An inverted mapping (supported<->unsupported swapped) must be caught.
    scorer = LlamaCppMiniCheckScorer(_claim_keyed_logits({_CAL_UNSUPPORTED_CLAIM}))
    with pytest.raises(NliModelUnavailableError, match="calibration self-check failed"):
        scorer.verify_calibration()


# --- fail-closed loader (no network, no llama.cpp) -------------------------


def test_loader_without_model_path_is_fail_closed() -> None:
    # A clinical gate never auto-downloads: no local model_path => unavailable.
    with pytest.raises(NliModelUnavailableError, match="not staged"):
        load_minicheck_scorer(GroundednessConfig(enabled=True))


# --- end-to-end through the verifier (fake scorer injected) ----------------


def test_verifier_marks_grounded_and_ungrounded_via_minicheck_scorer() -> None:
    scorer = LlamaCppMiniCheckScorer(_claim_keyed_logits({"grounded sentence"}))
    verifier = GroundednessNliVerifier(
        GroundednessConfig(enabled=True, entailment_threshold=0.5), scorer=scorer
    )
    result = verifier.verify("A grounded sentence. A fabricated sentence.", "src")
    verdicts = {seg.text: seg.verdict for seg in result.segments}
    assert result.checked is True
    assert verdicts["A grounded sentence."] == GROUNDED
    assert verdicts["A fabricated sentence."] == UNGROUNDED


def test_verifier_degrades_to_unverified_when_minicheck_unstaged() -> None:
    # The real loader with no model_path => the verifier never returns `grounded`.
    verifier = GroundednessNliVerifier(GroundednessConfig(enabled=True))
    result = verifier.verify("Any sentence at all.", "src")
    assert result.checked is False
    assert result.reason == "nli_model_unavailable"
    assert all(seg.verdict == UNVERIFIED for seg in result.segments)


def test_verifier_fail_closed_on_unexpected_factory_error() -> None:
    # MINOR-1 (applied): a factory error that is NOT NliModelUnavailableError (e.g. a raw
    # llama.cpp RuntimeError at calibration) must still degrade — never propagate.
    def boom(_config: GroundednessConfig) -> LlamaCppMiniCheckScorer:
        raise RuntimeError("llama.cpp exploded during calibration")

    verifier = GroundednessNliVerifier(GroundednessConfig(enabled=True), scorer_factory=boom)
    result = verifier.verify("A sentence.", "src")
    assert result.checked is False
    assert result.reason == "nli_model_unavailable"
    assert all(seg.verdict == UNVERIFIED for seg in result.segments)
