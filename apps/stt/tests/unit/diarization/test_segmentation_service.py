"""Unit tests for SegmentationService.

Tests use mocked pyannote model to avoid loading actual models.
"""

from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from stt.diarization.segmentation_service import SegmentationService


class TestSegmentationServiceInit:

    def test_default_model_id(self):
        service = SegmentationService()
        assert service._hf_model_id == "pyannote/segmentation-3.0"

    def test_custom_model_id(self):
        service = SegmentationService(hf_model_id="custom/model")
        assert service._hf_model_id == "custom/model"


class TestInitialize:

    @pytest.mark.asyncio
    async def test_initialize_is_idempotent(self):
        service = SegmentationService()
        service._loaded = True
        service._model = MagicMock()
        # Should not reload
        await service.initialize()
        assert service._loaded is True


class TestDetectSpeakerTurns:

    @pytest.mark.asyncio
    async def test_single_speaker_returns_single_segment(self):
        """Single-speaker audio should return one segment."""
        service = SegmentationService()
        service._loaded = True

        # Mock segmentation output: 100 frames, 2 speakers
        # Speaker 0 dominant throughout
        num_frames = 100
        activations = np.zeros((num_frames, 2), dtype=np.float32)
        activations[:, 0] = 0.9  # Speaker 0 active throughout

        mock_model = MagicMock()
        mock_model.return_value = MagicMock()
        service._model = mock_model
        service._sample_rate = 16000

        with patch.object(service, "_run_segmentation", return_value=(activations, 0.016)):
            segments = await service.detect_speaker_turns(
                samples=np.random.randn(16000).astype(np.float32),
                sample_rate=16000,
                min_segment_s=0.1,
            )

        # Single speaker = single segment
        assert len(segments) == 1

    @pytest.mark.asyncio
    async def test_two_speakers_returns_multiple_segments(self):
        """Two-speaker audio should return multiple segments at turn boundaries."""
        service = SegmentationService()
        service._loaded = True

        # Mock: 200 frames, speaker 0 first half, speaker 1 second half
        num_frames = 200
        activations = np.zeros((num_frames, 2), dtype=np.float32)
        activations[:100, 0] = 0.9  # Speaker 0 first half
        activations[100:, 1] = 0.9  # Speaker 1 second half

        # 16ms per frame = 3.2s total
        with patch.object(service, "_run_segmentation", return_value=(activations, 0.016)):
            segments = await service.detect_speaker_turns(
                samples=np.random.randn(int(3.2 * 16000)).astype(np.float32),
                sample_rate=16000,
                min_segment_s=0.1,
            )

        assert len(segments) == 2
        # First segment ends before second begins
        assert segments[0][1] <= segments[1][0] + 0.05  # small tolerance

    @pytest.mark.asyncio
    async def test_short_subsegments_discarded(self):
        """Sub-segments shorter than min_segment_s should be discarded."""
        service = SegmentationService()
        service._loaded = True

        # 200 frames: speaker 0 for 195, brief speaker 1 for 5 frames (0.08s)
        num_frames = 200
        activations = np.zeros((num_frames, 2), dtype=np.float32)
        activations[:195, 0] = 0.9
        activations[195:, 1] = 0.9  # only 5 frames = 0.08s

        with patch.object(service, "_run_segmentation", return_value=(activations, 0.016)):
            segments = await service.detect_speaker_turns(
                samples=np.random.randn(int(3.2 * 16000)).astype(np.float32),
                sample_rate=16000,
                min_segment_s=0.5,  # 0.08s < 0.5s, so discarded
            )

        # The short 0.08s segment should be filtered out
        assert len(segments) == 1
