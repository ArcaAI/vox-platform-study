"""Unit tests for the Streaming Sortformer diarizer scaffold.

Hermetic — the real NeMo Streaming Sortformer model is NOT staged on this host
(only whisper + silero + pyannote-embedding are in ``HF_HOME``), so the default
backend factory MUST raise ``SortformerModelUnavailableError`` and the diarizer
MUST degrade honestly to "no labels" (mirrors the groundedness scorer's
fail-closed posture). The pure frame->turn thresholding is exercised with a tiny
deterministic injected backend so the reusable math is unit-testable with nothing
staged.

Self-hosted-only track guardrail: no code path here may reach a cloud diarizer.
PHI hygiene: the diarizer never logs audio samples or transcript text.
"""

from __future__ import annotations

import logging

import pytest

from stt.diarization import streaming_sortformer as sortformer_module
from stt.diarization.streaming_sortformer import (
    REASON_APPLIED,
    REASON_ERROR,
    REASON_MODEL_UNAVAILABLE,
    NemoSortformerBackend,
    SortformerBackend,
    SortformerModelUnavailableError,
    StreamingDiarizationResult,
    StreamingSortformerDiarizer,
    _activities_from_nemo_output,
    load_default_backend,
)
from stt.pipeline.dto import DiarizationConfig


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
    def test_default_backend_factory_raises_unavailable(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _unavailable(config: DiarizationConfig) -> object:
            raise RuntimeError("model not staged")

        monkeypatch.setattr(sortformer_module, "_restore_sortformer_model", _unavailable)
        with pytest.raises(SortformerModelUnavailableError):
            load_default_backend(_config())

    def test_unavailable_error_names_the_model_and_ticket(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _unavailable(config: DiarizationConfig) -> object:
            raise RuntimeError("model not staged")

        monkeypatch.setattr(sortformer_module, "_restore_sortformer_model", _unavailable)
        with pytest.raises(SortformerModelUnavailableError) as excinfo:
            load_default_backend(
                _config(sortformer_model_id="nvidia/diar_streaming_sortformer_4spk-v2.1")
            )
        message = str(excinfo.value)
        assert "nvidia/diar_streaming_sortformer_4spk-v2.1" in message
        assert "TASK-475" in message


# ---------------------------------------------------------------------------
# Fail posture — diarizer degrades to "no labels" when the model is unavailable
# ---------------------------------------------------------------------------


class TestUnavailableDegrade:
    def test_diarize_degrades_to_no_labels_when_model_unavailable(self) -> None:
        """No injected backend + unavailable factory => empty, not-applied result."""

        def _unavailable(config: DiarizationConfig) -> object:
            raise SortformerModelUnavailableError("model not staged")

        diarizer = StreamingSortformerDiarizer(_config(), backend_factory=_unavailable)
        result = diarizer.diarize([0.0] * 1600, sample_rate=16000)
        assert result.applied is False
        assert result.reason == REASON_MODEL_UNAVAILABLE
        assert result.activities == []
        assert result.to_turns(threshold=0.5) == []

    def test_diarize_never_raises_on_unavailable(self) -> None:
        """The hot path must not crash when the model is missing — it degrades."""

        def _unavailable(config: DiarizationConfig) -> object:
            raise SortformerModelUnavailableError("model not staged")

        diarizer = StreamingSortformerDiarizer(_config(), backend_factory=_unavailable)
        diarizer.diarize([0.1, 0.2, 0.3], sample_rate=16000)

    def test_unavailable_log_is_phi_safe(self, caplog: pytest.LogCaptureFixture) -> None:
        """The degrade log carries counts/reasons only — never audio samples."""

        def _unavailable(config: DiarizationConfig) -> object:
            raise SortformerModelUnavailableError("model not staged")

        diarizer = StreamingSortformerDiarizer(_config(), backend_factory=_unavailable)
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

        def _unavailable(config: DiarizationConfig) -> object:
            raise SortformerModelUnavailableError("model not staged")

        diarizer = StreamingSortformerDiarizer(
            _config(), backend=backend, backend_factory=_unavailable
        )
        diarizer.diarize([0.0] * 320, sample_rate=16000)
        diarizer.reset()
        result = diarizer.diarize([0.0] * 320, sample_rate=16000)
        assert result.applied is False
        assert result.reason == REASON_MODEL_UNAVAILABLE


# ---------------------------------------------------------------------------
# NeMo backend adapter — the NEW seam, hermetic via a fake model handle
# (no NeMo, no GPU). Mirrors the verified diarize(include_tensor_outputs=True)
# contract: returns (segments, list[(T×S) tensor]).
# ---------------------------------------------------------------------------


class _FakeTensor:
    """Minimal stand-in for a torch (T×S) tensor: only ``.tolist()`` is exercised."""

    def __init__(self, rows: list[list[float]]) -> None:
        self._rows = rows

    def tolist(self) -> list[list[float]]:
        return self._rows


class _FakeNemoModel:
    """Records ``diarize`` kwargs and returns a canned NeMo-shaped output."""

    def __init__(self, tensor_outputs: object) -> None:
        self._tensor_outputs = tensor_outputs
        self.calls: list[dict[str, object]] = []

    def diarize(self, **kwargs):  # type: ignore[no-untyped-def]
        self.calls.append(kwargs)
        # NeMo diarize(include_tensor_outputs=True) -> (segments, list[Tensor]).
        return [["0.00 1.00 speaker_0"]], self._tensor_outputs


class TestActivitiesFromNemoOutput:
    def test_unwraps_batch_and_coerces_tensor_rows(self) -> None:
        # diarize returns a *list* of (T, S) tensors — take the first, .tolist() it.
        tensor_outputs = [_FakeTensor([[0.9, 0.1], [0.2, 0.8]])]
        assert _activities_from_nemo_output(tensor_outputs) == [[0.9, 0.1], [0.2, 0.8]]

    def test_handles_plain_nested_lists(self) -> None:
        # A batch whose row already is a plain list (no .tolist) still converts.
        assert _activities_from_nemo_output([[[0.7, 0.3]]]) == [[0.7, 0.3]]

    def test_empty_or_none_is_empty(self) -> None:
        assert _activities_from_nemo_output([]) == []
        assert _activities_from_nemo_output(None) == []

    def test_values_are_coerced_to_python_floats(self) -> None:
        result = _activities_from_nemo_output([_FakeTensor([[1, 0]])])
        assert result == [[1.0, 0.0]]
        assert all(isinstance(prob, float) for row in result for prob in row)


class TestNemoSortformerBackend:
    def test_infer_activities_calls_diarize_with_tensor_outputs(self) -> None:
        model = _FakeNemoModel([_FakeTensor([[0.9, 0.1]])])
        backend: SortformerBackend = NemoSortformerBackend(model, _config())
        activities = backend.infer_activities([0.0] * 320, sample_rate=16000)
        assert list(activities) == [[0.9, 0.1]]
        assert len(model.calls) == 1
        call = model.calls[0]
        assert call["include_tensor_outputs"] is True
        assert call["batch_size"] == 1
        assert call["sample_rate"] == 16000

    def test_backend_error_propagates_for_the_diarizer_to_catch(self) -> None:
        class _BoomModel:
            def diarize(self, **kwargs):  # type: ignore[no-untyped-def]
                raise RuntimeError("cuda kernel blew up")

        backend = NemoSortformerBackend(_BoomModel(), _config())
        # The backend does NOT swallow — the diarizer's try/except does (below).
        with pytest.raises(RuntimeError):
            backend.infer_activities([0.0] * 320, sample_rate=16000)


# ---------------------------------------------------------------------------
# Loader fail-safe — ANY restore failure is wrapped as model-unavailable so the
# diarizer degrades (defence in depth beyond the nemo-absent import failure).
# ---------------------------------------------------------------------------


class TestLoaderFailSafe:
    def test_arbitrary_restore_error_becomes_unavailable(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _boom(config):  # type: ignore[no-untyped-def]
            raise RuntimeError("no CUDA device")

        monkeypatch.setattr(sortformer_module, "_restore_sortformer_model", _boom)
        with pytest.raises(SortformerModelUnavailableError) as excinfo:
            load_default_backend(
                _config(sortformer_model_id="nvidia/diar_streaming_sortformer_4spk-v2.1")
            )
        message = str(excinfo.value)
        assert "nvidia/diar_streaming_sortformer_4spk-v2.1" in message
        assert "TASK-475" in message
        assert "RuntimeError" in message  # underlying cause named (PHI-free)

    def test_successful_restore_drives_the_diarizer_end_to_end(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Full factory -> NemoSortformerBackend -> diarizer -> turns, hermetically:
        # inject a fake model at the restore seam (no NeMo, no GPU).
        model = _FakeNemoModel([_FakeTensor([[0.9, 0.1], [0.15, 0.85]])])
        monkeypatch.setattr(sortformer_module, "_restore_sortformer_model", lambda config: model)
        diarizer = StreamingSortformerDiarizer(_config())
        result = diarizer.diarize([0.0] * 320, sample_rate=16000)
        assert result.applied is True
        assert result.reason == REASON_APPLIED
        assert result.num_speakers == 2
        assert result.to_turns(threshold=0.5) == [(0.0, 0.08, "S0"), (0.08, 0.16, "S1")]


# ---------------------------------------------------------------------------
# Diarizer degrades to "no labels" when a loaded backend errors (REASON_ERROR)
# ---------------------------------------------------------------------------


class TestBackendErrorDegrades:
    def test_diarize_degrades_to_no_labels_on_backend_error(self) -> None:
        class _RaisingBackend:
            def infer_activities(self, audio, sample_rate):  # type: ignore[no-untyped-def]
                raise ValueError("shape mismatch")

        diarizer = StreamingSortformerDiarizer(_config(), backend=_RaisingBackend())
        result = diarizer.diarize([0.0] * 320, sample_rate=16000)
        assert result.applied is False
        assert result.reason == REASON_ERROR
        assert result.activities == []
        assert result.to_turns(threshold=0.5) == []

    def test_backend_error_log_is_phi_safe(self, caplog: pytest.LogCaptureFixture) -> None:
        class _RaisingBackend:
            def infer_activities(self, audio, sample_rate):  # type: ignore[no-untyped-def]
                raise ValueError("boom")

        diarizer = StreamingSortformerDiarizer(_config(), backend=_RaisingBackend())
        with caplog.at_level(logging.WARNING):
            diarizer.diarize([0.246810, 0.135790], sample_rate=16000)
        joined = " ".join(record.getMessage() for record in caplog.records)
        assert "0.246810" not in joined
        assert "0.135790" not in joined
