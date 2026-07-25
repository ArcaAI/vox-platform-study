"""Unit tests for VAD parameter forwarding in preprocessing."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt.transcription.preprocessing import AudioPreprocessor


def _make_vad_config(**overrides) -> SimpleNamespace:
    defaults = {
        "enabled": True,
        "threshold": 0.5,
        "min_speech_duration_ms": 400,
        "min_silence_duration_ms": 200,
        "padding_ms": 50,
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


class TestOnnxVadParamForwarding:

    def test_onnx_vad_uses_config_params(self):
        """probs_to_segments receives min_speech_ms, min_silence_ms, pad_ms from config."""
        preprocessor = AudioPreprocessor()

        samples = np.random.randn(16000).astype(np.float32)
        mock_session = MagicMock()
        mock_session.get_inputs.return_value = [
            MagicMock(name="input"),
            MagicMock(name="state"),
            MagicMock(name="sr"),
        ]
        # Return dummy ONNX output: prob, state
        mock_session.run.return_value = [
            np.array([[0.9]], dtype=np.float32),
            np.zeros((2, 1, 128), dtype=np.float32),
        ]

        mock_segment = MagicMock()
        mock_segment.start_time = 0.0
        mock_segment.end_time = 1.0
        mock_segment.probability = 0.9

        with patch(
            "stt.vad.silero_service.SileroVADService.probs_to_segments",
            return_value=[mock_segment],
        ) as mock_probs:
            result = preprocessor._apply_onnx_session_vad(
                samples=samples,
                sample_rate=16000,
                session=mock_session,
                threshold=0.5,
                min_speech_ms=400,
                min_silence_ms=200,
                pad_ms=50,
            )

        call_kwargs = mock_probs.call_args
        assert call_kwargs.kwargs["min_speech_ms"] == 400
        assert call_kwargs.kwargs["min_silence_ms"] == 200
        assert call_kwargs.kwargs["pad_ms"] == 50
        assert len(result) == 1

    def test_default_params_backward_compat(self):
        """Calling without explicit params uses defaults."""
        preprocessor = AudioPreprocessor()

        samples = np.random.randn(16000).astype(np.float32)
        mock_session = MagicMock()
        mock_session.get_inputs.return_value = [
            MagicMock(name="input"),
            MagicMock(name="state"),
            MagicMock(name="sr"),
        ]
        mock_session.run.return_value = [
            np.array([[0.1]], dtype=np.float32),
            np.zeros((2, 1, 128), dtype=np.float32),
        ]

        with patch(
            "stt.vad.silero_service.SileroVADService.probs_to_segments",
            return_value=[],
        ) as mock_probs:
            preprocessor._apply_onnx_session_vad(
                samples=samples,
                sample_rate=16000,
                session=mock_session,
                threshold=0.5,
            )

        call_kwargs = mock_probs.call_args
        # Clinical defaults aligned with VadConfig (100/100/200).
        assert call_kwargs.kwargs["min_speech_ms"] == 100
        assert call_kwargs.kwargs["min_silence_ms"] == 100
        assert call_kwargs.kwargs["pad_ms"] == 200


class TestApplyVadSmartForwarding:

    @pytest.mark.asyncio
    async def test_forwards_all_params_to_apply_vad(self):
        """_apply_vad_smart passes VadConfig params to _apply_vad."""
        preprocessor = AudioPreprocessor()
        vad_config = _make_vad_config(
            min_speech_duration_ms=500,
            min_silence_duration_ms=300,
            padding_ms=60,
        )

        samples = np.random.randn(16000).astype(np.float32)
        mock_model = MagicMock()
        mock_model.model = MagicMock()

        with patch.object(
            preprocessor, "_apply_vad", new_callable=AsyncMock, return_value=[]
        ) as mock_apply:
            await preprocessor._apply_vad_smart(
                samples=samples,
                sample_rate=16000,
                vad_config=vad_config,
                pipeline_model=mock_model,
            )

        mock_apply.assert_awaited_once()
        call_kwargs = mock_apply.call_args
        assert call_kwargs.kwargs["min_speech_duration_ms"] == 500
        assert call_kwargs.kwargs["min_silence_duration_ms"] == 300
        assert call_kwargs.kwargs["padding_ms"] == 60
