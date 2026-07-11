"""Hermetic tests for the MiniCheck-Flan-T5 GGUF atomic-fact entailer (TASK-481).

No llama.cpp / weights: the model-dependent first-step logit read is injected as a fake
``logit_fn``, so these lock the scoring math, template, async ``entail`` threshold, the
calibration safety gate, and the ``_atomic_fact_entailer`` safe-fallback wiring.
"""

from __future__ import annotations

import pytest

from harness.core.config import Settings
from harness.sensors.inferential.atomic_fact import DeterministicOverlapEntailer
from harness.sensors.inferential.minicheck_entailer import (
    _CAL_SUPPORTED_CLAIM,
    _CAL_UNSUPPORTED_CLAIM,
    LlamaCppMiniCheckEntailer,
    LogitFn,
    MiniCheckCalibrationError,
    _support_prob,
)
from harness.temporal.activities import _atomic_fact_entailer


def _claim_keyed_logits(yes_claims: set[str]) -> LogitFn:
    """Fake logit_fn: (logit_no, logit_yes) driven by which claim the prompt carries."""

    def logit_fn(prompt: str) -> tuple[float, float]:
        return (-5.0, 5.0) if any(c in prompt for c in yes_claims) else (5.0, -5.0)

    return logit_fn


# --- scoring math + template ------------------------------------------------


def test_support_prob_direction_and_clamp() -> None:
    assert _support_prob(0.0, 0.0) == pytest.approx(0.5)
    assert _support_prob(-5.0, 5.0) > 0.99
    assert _support_prob(5.0, -5.0) < 0.01
    assert 0.0 <= _support_prob(-1e9, 1e9) <= 1.0


def test_build_prompt_matches_minicheck_flan_t5_format() -> None:
    assert LlamaCppMiniCheckEntailer.build_prompt("P", "H") == "predict: P</s>H"


# --- async entail + threshold ----------------------------------------------


async def test_entail_true_when_support_meets_threshold() -> None:
    entailer = LlamaCppMiniCheckEntailer(_claim_keyed_logits({"grounded"}), threshold=0.5)
    assert await entailer.entail("premise", "a grounded claim") is True


async def test_entail_false_when_support_below_threshold() -> None:
    entailer = LlamaCppMiniCheckEntailer(_claim_keyed_logits({"grounded"}), threshold=0.5)
    assert await entailer.entail("premise", "a fabricated claim") is False


async def test_entail_respects_threshold_boundary() -> None:
    equal = lambda _prompt: (0.0, 0.0)  # noqa: E731 — P(yes) == 0.5
    assert await LlamaCppMiniCheckEntailer(equal, threshold=0.9).entail("a", "b") is False
    assert await LlamaCppMiniCheckEntailer(equal, threshold=0.4).entail("a", "b") is True


async def test_entail_propagates_backend_outage() -> None:
    # NliEntailer contract: a runtime outage RAISES (the sensor catches it and degrades).
    def boom(_prompt: str) -> tuple[float, float]:
        raise RuntimeError("llama.cpp crashed mid-decode")

    with pytest.raises(RuntimeError):
        await LlamaCppMiniCheckEntailer(boom).entail("a", "b")


def test_threshold_bounds_validated() -> None:
    with pytest.raises(ValueError, match="threshold"):
        LlamaCppMiniCheckEntailer(_claim_keyed_logits(set()), threshold=1.5)


# --- calibration safety gate ------------------------------------------------


def test_verify_calibration_passes_a_correctly_wired_entailer() -> None:
    LlamaCppMiniCheckEntailer(_claim_keyed_logits({_CAL_SUPPORTED_CLAIM})).verify_calibration()


def test_verify_calibration_rejects_a_collapsed_entailer() -> None:
    with pytest.raises(MiniCheckCalibrationError):
        LlamaCppMiniCheckEntailer(lambda _p: (0.0, 0.0)).verify_calibration()


def test_verify_calibration_rejects_an_inverted_entailer() -> None:
    with pytest.raises(MiniCheckCalibrationError):
        LlamaCppMiniCheckEntailer(
            _claim_keyed_logits({_CAL_UNSUPPORTED_CLAIM})
        ).verify_calibration()


# --- _atomic_fact_entailer factory wiring (safe fallback) -------------------


def test_factory_defaults_to_deterministic_when_no_model_path() -> None:
    entailer = _atomic_fact_entailer(Settings(atomic_fact_model_path=None))
    assert isinstance(entailer, DeterministicOverlapEntailer)


def test_factory_falls_back_to_deterministic_on_model_load_failure() -> None:
    # A configured-but-unloadable model (missing llama-cpp-python or a bad path) must fall
    # back to the SAFE model-free entailer — never crash the sensor.
    entailer = _atomic_fact_entailer(
        Settings(atomic_fact_model_path="/nonexistent/minicheck.gguf")
    )
    assert isinstance(entailer, DeterministicOverlapEntailer)
