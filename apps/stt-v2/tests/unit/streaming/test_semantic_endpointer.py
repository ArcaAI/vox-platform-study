"""Unit tests for the self-hosted semantic endpointer.

Hermetic + deterministic: the model-free heuristic core needs no runtime, and the
optional neural turn-detector seam is exercised with a tiny deterministic stub
(``load_default_endpoint_model`` raises until a model is staged). The safety-
critical property under test: the endpointer NEVER signals an early cut on an
incomplete / uncertain utterance — it degrades to "no early cut" so the
preprocessor falls back to the fixed silence-offset backstop.
"""

from __future__ import annotations

import pytest

from stt_v2.pipeline.dto import EndpointConfig
from stt_v2.streaming.semantic_endpointer import (
    EndpointDecision,
    EndpointModelUnavailableError,
    SemanticEndpointer,
    load_default_endpoint_model,
)


def _cfg(**overrides: object) -> EndpointConfig:
    base: dict[str, object] = {
        "enabled": True,
        "min_endpoint_silence_ms": 200,
        "max_endpoint_silence_ms": 500,
        "confidence_threshold": 0.85,
        "min_words": 3,
        "model_id": "",
    }
    base.update(overrides)
    return EndpointConfig(**base)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Default-off + no-hypothesis: degrade to "no early cut"
# ---------------------------------------------------------------------------


def test_disabled_config_never_endpoints() -> None:
    ep = SemanticEndpointer(_cfg(enabled=False))
    ep.observe_hypothesis("Stop the metformin.")
    decision = ep.decide(trailing_silence_ms=400.0, min_silence_ms=500.0)
    assert isinstance(decision, EndpointDecision)
    assert decision.should_endpoint is False


def test_no_hypothesis_never_endpoints() -> None:
    ep = SemanticEndpointer(_cfg())
    # No observe_hypothesis() call at all.
    decision = ep.decide(trailing_silence_ms=400.0, min_silence_ms=500.0)
    assert decision.should_endpoint is False


def test_empty_hypothesis_never_endpoints() -> None:
    ep = SemanticEndpointer(_cfg())
    ep.observe_hypothesis("   ")
    decision = ep.decide(trailing_silence_ms=400.0, min_silence_ms=500.0)
    assert decision.should_endpoint is False


# ---------------------------------------------------------------------------
# Complete-turn early cut (the latency win)
# ---------------------------------------------------------------------------


def test_complete_utterance_endpoints_after_floor() -> None:
    ep = SemanticEndpointer(_cfg())
    ep.observe_hypothesis("We should stop the metformin.")
    # Trailing silence past the semantic floor (200 ms) but BEFORE the fixed
    # backstop (500 ms) — this is the "earlier than the fixed timer" cut.
    decision = ep.decide(trailing_silence_ms=220.0, min_silence_ms=500.0)
    assert decision.should_endpoint is True
    assert decision.confidence >= 0.85


def test_complete_utterance_below_silence_floor_waits() -> None:
    ep = SemanticEndpointer(_cfg())
    ep.observe_hypothesis("We should stop the metformin.")
    # Complete thought, but silence has not yet reached the floor: do NOT cut on
    # the instant the last word lands — the speaker may continue.
    decision = ep.decide(trailing_silence_ms=80.0, min_silence_ms=500.0)
    assert decision.should_endpoint is False


# ---------------------------------------------------------------------------
# Never cut early on an incomplete utterance (the safety guardrail)
# ---------------------------------------------------------------------------


def test_incomplete_unpunctuated_hypothesis_never_endpoints() -> None:
    ep = SemanticEndpointer(_cfg())
    # Mid-utterance: no terminal punctuation → heuristic cannot confirm a turn.
    ep.observe_hypothesis("The patient is allergic to")
    decision = ep.decide(trailing_silence_ms=300.0, min_silence_ms=500.0)
    assert decision.should_endpoint is False


def test_trailing_filler_is_vetoed() -> None:
    ep = SemanticEndpointer(_cfg())
    # Mid-utterance disfluency: "the patient is … uh …" — must not cut.
    ep.observe_hypothesis("The patient is uh")
    decision = ep.decide(trailing_silence_ms=400.0, min_silence_ms=500.0)
    assert decision.should_endpoint is False


def test_trailing_filler_vetoed_even_with_punctuation() -> None:
    ep = SemanticEndpointer(_cfg())
    # A stray period after a disfluency must not fool the endpointer.
    ep.observe_hypothesis("The patient is uh.")
    decision = ep.decide(trailing_silence_ms=400.0, min_silence_ms=500.0)
    assert decision.should_endpoint is False


def test_too_short_complete_hypothesis_defers_to_fixed_timer() -> None:
    ep = SemanticEndpointer(_cfg(min_words=3))
    ep.observe_hypothesis("Yes.")
    decision = ep.decide(trailing_silence_ms=400.0, min_silence_ms=500.0)
    assert decision.should_endpoint is False


# ---------------------------------------------------------------------------
# reset() clears the observed hypothesis (per-utterance boundary)
# ---------------------------------------------------------------------------


def test_reset_clears_hypothesis() -> None:
    ep = SemanticEndpointer(_cfg())
    ep.observe_hypothesis("We should stop the metformin.")
    ep.reset()
    decision = ep.decide(trailing_silence_ms=400.0, min_silence_ms=500.0)
    assert decision.should_endpoint is False


# ---------------------------------------------------------------------------
# Optional neural-model seam — degrade safely, never crash
# ---------------------------------------------------------------------------


def test_load_default_endpoint_model_raises_until_staged() -> None:
    with pytest.raises(EndpointModelUnavailableError):
        load_default_endpoint_model(_cfg(model_id="some/turn-detector"))


def test_model_unavailable_degrades_to_heuristic() -> None:
    def _raising_factory(config: EndpointConfig) -> object:
        raise EndpointModelUnavailableError("not staged")

    ep = SemanticEndpointer(_cfg(model_id="some/turn-detector"), model_factory=_raising_factory)
    # Heuristic still works on a punctuated complete turn.
    ep.observe_hypothesis("We should stop the metformin.")
    decision = ep.decide(trailing_silence_ms=220.0, min_silence_ms=500.0)
    assert decision.should_endpoint is True
    # And it still refuses an incomplete turn (no model → heuristic only).
    ep.reset()
    ep.observe_hypothesis("The patient is allergic to")
    assert ep.decide(trailing_silence_ms=300.0, min_silence_ms=500.0).should_endpoint is False


def test_model_inference_error_degrades_to_heuristic() -> None:
    class _BoomModel:
        def predict_eot(self, hypothesis: str) -> float:
            raise RuntimeError("boom")

    ep = SemanticEndpointer(_cfg(model_id="x"), model=_BoomModel())
    ep.observe_hypothesis("We should stop the metformin.")
    # Model raises → fall back to the heuristic confidence (punctuation) → cut.
    decision = ep.decide(trailing_silence_ms=220.0, min_silence_ms=500.0)
    assert decision.should_endpoint is True


def test_model_enables_endpoint_on_unpunctuated_complete_text() -> None:
    class _ConfidentModel:
        def predict_eot(self, hypothesis: str) -> float:
            return 0.97

    ep = SemanticEndpointer(_cfg(model_id="x"), model=_ConfidentModel())
    # Unpunctuated complete turn — the heuristic alone would NOT cut; a staged
    # turn-detector can. This is the seam's whole value.
    ep.observe_hypothesis("we should stop the metformin")
    decision = ep.decide(trailing_silence_ms=220.0, min_silence_ms=500.0)
    assert decision.should_endpoint is True


def test_model_veto_still_applies_with_confident_model() -> None:
    class _ConfidentModel:
        def predict_eot(self, hypothesis: str) -> float:
            return 0.99

    ep = SemanticEndpointer(_cfg(model_id="x"), model=_ConfidentModel())
    # A trailing disfluency is a hard safety veto even if a model is confident.
    ep.observe_hypothesis("the patient is uh")
    decision = ep.decide(trailing_silence_ms=400.0, min_silence_ms=500.0)
    assert decision.should_endpoint is False


def test_decide_never_raises_on_bad_model() -> None:
    class _BoomModel:
        def predict_eot(self, hypothesis: str) -> float:
            raise ValueError("kaboom")

    ep = SemanticEndpointer(_cfg(model_id="x"), model=_BoomModel())
    ep.observe_hypothesis("The patient is allergic to")
    # Must degrade, not propagate.
    decision = ep.decide(trailing_silence_ms=300.0, min_silence_ms=500.0)
    assert decision.should_endpoint is False
