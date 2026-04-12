"""Integration tests for new STT-V2 services.

Tests cross-module interactions between:
- VAD service (Silero ONNX) + AudioPreprocessor
- Diarization service (Qdrant + Pyannote) + BatchTranscriptionService
- Worker initialization (VAD, Qdrant, Diarization)

All tests use mocks to avoid requiring real ML dependencies or external services.
Tests are designed to work with TEST_PLATFORM=cpu (no ML libraries imported).
"""

from datetime import datetime
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from stt_v2.diarization.dto import DiarizationResult, DiarizedSegment
from stt_v2.models.base_loader import LoadedModel
from stt_v2.pipeline.dto import (
    DiarizationConfig,
    InferenceConfig,
    ModelRef,
    ModelRefs,
    PipelineConfig,
    PipelineSpec,
    PostprocessingConfig,
    PreprocessingConfig,
    PunctuationConfig,
    TimestampConfig,
    VadConfig,
)
from stt_v2.transcription.dto import (
    AudioSegment,
)
from stt_v2.transcription.preprocessing import AudioPreprocessor
from stt_v2.vad.dto import SpeechSegment, VADResult

# =============================================================================
# Test Fixtures
# =============================================================================


def create_pipeline_config_with_diarization(enabled: bool = True) -> PipelineConfig:
    """Create a PipelineConfig with diarization enabled/disabled."""
    spec = PipelineSpec(
        version="1.1",
        models=ModelRefs(asr=ModelRef(slug="whisper-test")),
        preprocessing=PreprocessingConfig(
            target_sample_rate=16000,
            normalize=True,
            vad=VadConfig(enabled=True, threshold=0.5),
        ),
        inference=InferenceConfig(language="en"),
        postprocessing=PostprocessingConfig(
            lowercase=False,
            timestamps=TimestampConfig(word_timestamps=True, sentence_timestamps=True),
            punctuation=PunctuationConfig(enabled=False),
        ),
        diarization=DiarizationConfig(
            enabled=enabled,
            similarity_threshold=0.7,
            max_speakers=0,
            auto_register_speakers=True,
            min_segment_duration_s=1.0,
        ),
    )
    return PipelineConfig(
        id="p-test",
        tenant_id="t-test",
        slug="test-pipeline",
        name="Test",
        description="Test",
        spec=spec,
        tags=["test"],
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )


def create_mock_vad_result(
    segments: list[tuple[float, float, float]] | None = None,
    speech_duration: float = 0.0,
    audio_duration: float = 0.0,
) -> VADResult:
    """Create a mock VADResult with speech segments."""
    if segments is None:
        segments = [(0.0, 1.0, 0.9), (2.0, 3.5, 0.85)]

    speech_segments = [
        SpeechSegment(start_time=start, end_time=end, probability=prob)
        for start, end, prob in segments
    ]

    if audio_duration == 0.0 and segments:
        audio_duration = max(end for _, end, _ in segments)

    if speech_duration == 0.0 and segments:
        speech_duration = sum(end - start for start, end, _ in segments)

    return VADResult(
        segments=speech_segments,
        speech_duration=speech_duration,
        audio_duration=audio_duration,
        applied=True,
    )


def create_mock_diarization_result(
    applied: bool = True,
    segments: list[tuple[str, float, float, str | None, float | None]] | None = None,
    speakers_detected: int = 0,
    new_speakers_created: int = 0,
) -> DiarizationResult:
    """Create a mock DiarizationResult."""
    if segments is None:
        segments = [
            ("Hello world", 0.0, 1.0, "speaker-1", 0.95),
            ("How are you", 2.0, 3.5, "speaker-2", 0.88),
        ]

    diarized_segments = [
        DiarizedSegment(
            text=text,
            start_time=start,
            end_time=end,
            speaker_id=speaker_id,
            speaker_confidence=confidence,
        )
        for text, start, end, speaker_id, confidence in segments
    ]

    if speakers_detected == 0 and segments:
        unique_speakers = {s[3] for s in segments if s[3]}
        speakers_detected = len(unique_speakers)

    return DiarizationResult(
        segments=diarized_segments,
        speakers_detected=speakers_detected,
        new_speakers_created=new_speakers_created,
        applied=applied,
    )


# =============================================================================
# TestVADPreprocessingIntegration
# =============================================================================


class TestVADPreprocessingIntegration:
    """Test AudioPreprocessor._apply_vad_smart() integration with Silero VAD service."""

    @pytest.mark.asyncio
    async def test_vad_smart_uses_silero_service_when_available(self):
        """Test that _apply_vad_smart() delegates to Silero VAD service when available."""
        preprocessor = AudioPreprocessor()
        samples = np.random.randn(16000).astype(np.float32)  # 1 second at 16kHz
        sample_rate = 16000
        vad_config = VadConfig(
            enabled=True,
            threshold=0.5,
            min_speech_duration_ms=250,
            min_silence_duration_ms=100,
            padding_ms=30,
        )

        # Mock VAD result
        vad_result = create_mock_vad_result(
            segments=[(0.0, 0.5, 0.9), (0.7, 1.0, 0.85)],
            speech_duration=0.8,
            audio_duration=1.0,
        )

        # Mock VAD service
        mock_vad_service = MagicMock()
        mock_vad_service.is_loaded = True
        mock_vad_service.detect_speech.return_value = vad_result

        with patch("stt_v2.vad.silero_service.get_vad_service", return_value=mock_vad_service):
            segments, vad_applied = await preprocessor._apply_vad_smart(
                samples, sample_rate, vad_config, pipeline_model=None
            )

        # Verify VAD service was called correctly
        mock_vad_service.detect_speech.assert_called_once()
        call_kwargs = mock_vad_service.detect_speech.call_args.kwargs
        assert call_kwargs["samples"] is samples
        assert call_kwargs["sample_rate"] == sample_rate
        assert call_kwargs["threshold"] == vad_config.threshold
        assert call_kwargs["min_speech_duration_ms"] == vad_config.min_speech_duration_ms
        assert call_kwargs["min_silence_duration_ms"] == vad_config.min_silence_duration_ms
        assert call_kwargs["speech_pad_ms"] == vad_config.padding_ms

        # Verify AudioSegment objects were created correctly
        assert vad_applied is True
        assert len(segments) == 2
        assert segments[0].start_time == 0.0
        assert segments[0].end_time == 0.5
        assert segments[0].is_speech is True
        assert segments[0].confidence == 0.9
        assert segments[1].start_time == 0.7
        assert segments[1].end_time == 1.0
        assert segments[1].confidence == 0.85

    @pytest.mark.asyncio
    async def test_vad_smart_falls_back_to_legacy_when_silero_unavailable(self):
        """Test that _apply_vad_smart() falls back to pipeline model when Silero VAD fails."""
        preprocessor = AudioPreprocessor()
        samples = np.random.randn(16000).astype(np.float32)
        sample_rate = 16000
        vad_config = VadConfig(enabled=True, threshold=0.5)

        # Mock pipeline VAD model
        _mock_pipeline_model = MagicMock(spec=LoadedModel)

        # Mock VAD service to raise exception
        mock_vad_service = MagicMock()
        mock_vad_service.is_loaded = False

        # Mock pipeline _apply_vad to return segments
        pipeline_segments = [
            AudioSegment(start_time=0.0, end_time=1.0, is_speech=True, confidence=0.8)
        ]

        with patch("stt_v2.vad.silero_service.get_vad_service", return_value=mock_vad_service):
            with patch.object(
                preprocessor, "_apply_vad", return_value=pipeline_segments
            ) as mock_pipeline:
                segments, vad_applied = await preprocessor._apply_vad_smart(
                    samples, sample_rate, vad_config, pipeline_model=_mock_pipeline_model
                )

        # Verify pipeline VAD was called
        mock_pipeline.assert_called_once()
        assert vad_applied is True
        assert len(segments) == 1
        assert segments[0].start_time == 0.0
        assert segments[0].end_time == 1.0

    @pytest.mark.asyncio
    async def test_vad_smart_falls_back_when_silero_raises_exception(self):
        """Test that _apply_vad_smart() falls back when Silero VAD raises exception."""
        preprocessor = AudioPreprocessor()
        samples = np.random.randn(16000).astype(np.float32)
        sample_rate = 16000
        vad_config = VadConfig(enabled=True, threshold=0.5)

        # Mock VAD service to raise exception
        mock_vad_service = MagicMock()
        mock_vad_service.is_loaded = True
        mock_vad_service.detect_speech.side_effect = RuntimeError("VAD service error")

        # Mock pipeline model
        _mock_pipeline_model = MagicMock(spec=LoadedModel)
        pipeline_segments = [AudioSegment(start_time=0.0, end_time=1.0, is_speech=True)]

        with patch("stt_v2.vad.silero_service.get_vad_service", return_value=mock_vad_service):
            with patch.object(preprocessor, "_apply_vad", return_value=pipeline_segments):
                segments, vad_applied = await preprocessor._apply_vad_smart(
                    samples, sample_rate, vad_config, pipeline_model=_mock_pipeline_model
                )

        # Should fall back to pipeline
        assert vad_applied is True
        assert len(segments) == 1

    @pytest.mark.asyncio
    async def test_vad_smart_returns_empty_when_both_unavailable(self):
        """Test that _apply_vad_smart() returns empty list when both VAD services unavailable."""
        preprocessor = AudioPreprocessor()
        samples = np.random.randn(16000).astype(np.float32)
        sample_rate = 16000
        vad_config = VadConfig(enabled=True, threshold=0.5)

        # Mock VAD service as not loaded
        mock_vad_service = MagicMock()
        mock_vad_service.is_loaded = False

        with patch("stt_v2.vad.silero_service.get_vad_service", return_value=mock_vad_service):
            segments, vad_applied = await preprocessor._apply_vad_smart(
                samples, sample_rate, vad_config, pipeline_model=None
            )

        # Should return empty with vad_applied=False
        assert vad_applied is False
        assert segments == []


# =============================================================================
# TestBatchServiceDiarizationIntegration
# =============================================================================

