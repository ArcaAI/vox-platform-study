"""Unit tests for the Streaming Sortformer diarizer scaffold (TASK-475 · Theme B2).

Hermetic — the real NeMo Streaming Sortformer model is NOT staged on this host
(only whisper + silero + pyannote-embedding are in ``HF_HOME``), so the default
backend factory MUST raise ``SortformerModelUnavailableError`` and the diarizer
MUST degrade honestly to "no labels" (mirrors TASK-479's ``load_default_scorer``
fail-closed posture). The pure frame->turn thresholding is exercised with a tiny
deterministic injected backend so the reusable math is unit-testable with nothing
staged.

Self-hosted-only track guardrail: no code path here may reach a cloud diarizer.
PHI hygiene: the diarizer never logs audio samples or transcript text.
"""

from __future__ import annotations

import logging

import pytest

from stt_v2.diarization.streaming_sortformer import (
    REASON_APPLIED,
    REASON_MODEL_UNAVAILABLE,
    SortformerBackend,
    SortformerModelUnavailableError,
    StreamingDiarizationResult,
    StreamingSortformerDiarizer,
    load_default_backend,
)
from stt_v2.pipeline.dto import DiarizationConfig


class _FakeBackend:
    """Deterministic stand-in for the un-staged NeMo model: returns canned T×S probs."""

    def __init__(self, activities: list[list[float]]) -> None:
        self._activities = activities
        self.calls = 0

    def infer_activities(self, audio, sample_rate):  # type: ignore[no-untyped-def]
        self.calls += 1
        return self._activities


def _config(**overrides) -> DiarizationConfig:  # type: ignore[no-untyped-def]
    return DiarizationConfig(enabled=True, backend="sortformer", **overrides)


# ---------------------------------------------------------------------------
# Model-staging boundary — the default factory raises until the .nemo is staged
# ---------------------------------------------------------------------------


class TestModelStagingBoundary:
    def test_default_backend_factory_raises_unavailable(self) -> None:
        """The production factory must raise until the Sortformer weights are staged."""
        with pytest.raises(SortformerModelUnavailableError):
            load_default_backend(_config())

    def test_unavailable_error_names_the_model_and_ticket(self) -> None:
        try:
            load_default_backend(
                _config(sortformer_model_id="nvidia/diar_streaming_sortformer_4spk-v2.1")
            )
        except SortformerModelUnavailableError as exc:
            message = str(exc)
            assert "nvidia/diar_streaming_sortformer_4spk-v2.1" in message
            assert "TASK-475" in message
        else:  # pragma: no cover - the call above must raise
            pytest.fail("load_default_backend did not raise")


# ---------------------------------------------------------------------------
# Fail posture — diarizer degrades to "no labels" when the model is unavailable
# ---------------------------------------------------------------------------


class TestUnavailableDegrade:
    def test_diarize_degrades_to_no_labels_when_model_unavailable(self) -> None:
        """No injected backend + default factory raising => empty, not-applied result."""
        diarizer = StreamingSortformerDiarizer(_config())
        result = diarizer.diarize([0.0] * 1600, sample_rate=16000)
        assert result.applied is False
        assert result.reason == REASON_MODEL_UNAVAILABLE
        assert result.activities == []
        assert result.to_turns(threshold=0.5) == []

    def test_diarize_never_raises_on_unavailable(self) -> None:
        """The hot path must not crash when the model is missing — it degrades."""
        diarizer = StreamingSortformerDiarizer(_config())
        # Must not raise:
        diarizer.diarize([0.1, 0.2, 0.3], sample_rate=16000)

    def test_unavailable_log_is_phi_safe(self, caplog: pytest.LogCaptureFixture) -> None:
        """The degrade log carries counts/reasons only — never audio samples."""
        diarizer = StreamingSortformerDiarizer(_config())
        with caplog.at_level(logging.WARNING):
            diarizer.diarize([0.123456, 0.654321], sample_rate=16000)
        joined = " ".join(record.getMessage() for record in caplog.records)
        assert "0.123456" not in joined
        assert "0.654321" not in joined


# ---------------------------------------------------------------------------
# Frame -> 2-speaker turn thresholding (the reusable math, model-independent)
# ---------------------------------------------------------------------------


class TestFrameToTurns:
    def test_injected_backend_applies_and_reports(self) -> None:
        backend: SortformerBackend = _FakeBackend([[0.9, 0.1], [0.8, 0.2]])
        diarizer = StreamingSortformerDiarizer(_config(), backend=backend)
        result = diarizer.diarize([0.0] * 320, sample_rate=16000)
        assert result.applied is True
        assert result.reason == REASON_APPLIED
        assert result.num_speakers == 2

    def test_to_turns_merges_consecutive_same_speaker_frames(self) -> None:
        # 4 frames @ 0.08s: S0, S0, S1, S1  => two contiguous turns.
        activities = [[0.9, 0.1], [0.85, 0.15], [0.2, 0.8], [0.1, 0.9]]
        result = StreamingDiarizationResult(
            activities=activities, frame_shift_s=0.08, applied=True, reason=REASON_APPLIED
        )
        turns = result.to_turns(threshold=0.5)
        assert turns == [(0.0, 0.16, "S0"), (0.16, 0.32, "S1")]

    def test_to_turns_below_threshold_is_silence(self) -> None:
        # Middle frame is sub-threshold on both speakers => a gap, splitting the turn.
        activities = [[0.9, 0.1], [0.3, 0.3], [0.9, 0.1]]
        result = StreamingDiarizationResult(
            activities=activities, frame_shift_s=0.1, applied=True, reason=REASON_APPLIED
        )
        turns = result.to_turns(threshold=0.5)
        assert turns == [(0.0, 0.1, "S0"), (0.2, 0.3, "S0")]

    def test_reset_clears_lazy_loaded_backend(self) -> None:
        backend = _FakeBackend([[0.9, 0.1]])
        diarizer = StreamingSortformerDiarizer(_config(), backend=backend)
        diarizer.diarize([0.0] * 320, sample_rate=16000)
        diarizer.reset()
        # After reset the injected backend is cleared; the default factory raises,
        # so the next call degrades rather than reusing the old backend.
        result = diarizer.diarize([0.0] * 320, sample_rate=16000)
        assert result.applied is False
        assert result.reason == REASON_MODEL_UNAVAILABLE
