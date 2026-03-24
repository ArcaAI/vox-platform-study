"""Integration tests for new STT-V2 services.

Tests cross-module interactions between:
- VAD service (Silero ONNX) + AudioPreprocessor
- Diarization service (Qdrant + Pyannote) + BatchTranscriptionService
- Worker initialization (VAD, Qdrant, Diarization)

All tests use mocks to avoid requiring real ML dependencies or external services.
Tests are designed to work with TEST_PLATFORM=cpu (no ML libraries imported).
"""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt_v2.diarization.dto import DiarizationResult, DiarizedSegment
from stt_v2.models.base_loader import LoadedModel
from stt_v2.pipeline.dto import (
    AiModelFormat,
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
from stt_v2.transcription.batch_service import BatchTranscriptionService
from stt_v2.transcription.dto import (
    AudioSegment,
    ProcessedAudio,
    RawTranscription,
    TranscriptionResult,
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
            with patch.object(preprocessor, "_apply_vad", return_value=pipeline_segments) as mock_pipeline:
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
        pipeline_segments = [
            AudioSegment(start_time=0.0, end_time=1.0, is_speech=True)
        ]

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

class TestBatchServiceDiarizationIntegration:
    """Test BatchTranscriptionService._run_diarization() integration."""

    @pytest.mark.asyncio
    async def test_run_diarization_success_with_speakers(self):
        """Test _run_diarization() with successful diarization result."""
        service = BatchTranscriptionService()
        samples = np.random.randn(16000).astype(np.float32)
        sample_rate = 16000

        # Create raw transcription with segments
        raw_result = RawTranscription(
            text="Hello world. How are you?",
            language="en",
            segments=[
                {"text": "Hello world", "start": 0.0, "end": 1.0},
                {"text": "How are you", "start": 2.0, "end": 3.5},
            ],
        )

        tenant_id = "t-test"
        consultation_id = "c-test"
        config = DiarizationConfig(enabled=True, similarity_threshold=0.7)

        # Mock diarization result
        diarization_result = create_mock_diarization_result(
            applied=True,
            segments=[
                ("Hello world", 0.0, 1.0, "speaker-1", 0.95),
                ("How are you", 2.0, 3.5, "speaker-2", 0.88),
            ],
            speakers_detected=2,
            new_speakers_created=1,
        )

        # Mock speaker identifier
        mock_identifier = AsyncMock()
        mock_identifier.diarize_segments.return_value = diarization_result

        with patch("stt_v2.diarization.speaker_identifier.get_speaker_identifier", return_value=mock_identifier):
            metadata = await service._run_diarization(
                samples, sample_rate, raw_result, tenant_id, consultation_id, config
            )

        # Verify diarization was called correctly
        mock_identifier.diarize_segments.assert_called_once()
        call_kwargs = mock_identifier.diarize_segments.call_args.kwargs
        assert call_kwargs["samples"] is samples
        assert call_kwargs["sample_rate"] == sample_rate
        assert call_kwargs["segments"] == raw_result.segments
        assert call_kwargs["tenant_id"] == tenant_id
        assert call_kwargs["consultation_id"] == consultation_id
        assert call_kwargs["config"] == config

        # Verify raw_result segments were annotated
        assert raw_result.segments[0]["speaker_id"] == "speaker-1"
        assert raw_result.segments[0]["speaker_confidence"] == 0.95
        assert raw_result.segments[1]["speaker_id"] == "speaker-2"
        assert raw_result.segments[1]["speaker_confidence"] == 0.88

        # Verify metadata
        assert metadata["speakers_detected"] == 2
        assert metadata["new_speakers_created"] == 1
        assert set(metadata["speaker_ids"]) == {"speaker-1", "speaker-2"}

    @pytest.mark.asyncio
    async def test_run_diarization_not_applied(self):
        """Test _run_diarization() when diarization result has applied=False."""
        service = BatchTranscriptionService()
        samples = np.random.randn(16000).astype(np.float32)
        sample_rate = 16000

        raw_result = RawTranscription(
            text="Hello world",
            segments=[{"text": "Hello world", "start": 0.0, "end": 1.0}],
        )

        # Mock diarization result with applied=False
        diarization_result = create_mock_diarization_result(
            applied=False,
            segments=[],
            speakers_detected=0,
            new_speakers_created=0,
        )

        mock_identifier = AsyncMock()
        mock_identifier.diarize_segments.return_value = diarization_result

        with patch("stt_v2.diarization.speaker_identifier.get_speaker_identifier", return_value=mock_identifier):
            metadata = await service._run_diarization(
                samples, sample_rate, raw_result, "t-test", None, DiarizationConfig(enabled=True)
            )

        # Should return empty dict
        assert metadata == {}
        # Segments should not be annotated
        assert "speaker_id" not in raw_result.segments[0]

    @pytest.mark.asyncio
    async def test_run_diarization_exception_propagates(self):
        """Test _run_diarization() propagates exceptions to the caller.

        The caller (transcribe()) catches these exceptions to make diarization
        non-fatal. The _run_diarization method itself SHOULD raise so the caller
        can log and continue.
        """
        service = BatchTranscriptionService()
        samples = np.random.randn(16000).astype(np.float32)
        sample_rate = 16000

        raw_result = RawTranscription(
            text="Hello world",
            segments=[{"text": "Hello world", "start": 0.0, "end": 1.0}],
        )

        # Mock identifier to raise exception
        mock_identifier = AsyncMock()
        mock_identifier.diarize_segments.side_effect = RuntimeError("Diarization error")

        with patch("stt_v2.diarization.speaker_identifier.get_speaker_identifier", return_value=mock_identifier):
            # _run_diarization should let the exception propagate
            with pytest.raises(RuntimeError, match="Diarization error"):
                await service._run_diarization(
                    samples, sample_rate, raw_result, "t-test", None, DiarizationConfig(enabled=True)
                )

        mock_identifier.diarize_segments.assert_called_once()
        # Segments should NOT have been annotated because the exception happened
        assert "speaker_id" not in raw_result.segments[0]

    @pytest.mark.asyncio
    async def test_run_diarization_partial_segments(self):
        """Test _run_diarization() when diarization segments don't match raw segments exactly."""
        service = BatchTranscriptionService()
        samples = np.random.randn(16000).astype(np.float32)
        sample_rate = 16000

        raw_result = RawTranscription(
            text="Hello world. How are you?",
            segments=[
                {"text": "Hello world", "start": 0.0, "end": 1.0},
                {"text": "How are you", "start": 2.0, "end": 3.5},
                {"text": "Goodbye", "start": 4.0, "end": 5.0},
            ],
        )

        # Mock diarization result with fewer segments
        diarization_result = create_mock_diarization_result(
            applied=True,
            segments=[
                ("Hello world", 0.0, 1.0, "speaker-1", 0.95),
                ("How are you", 2.0, 3.5, "speaker-2", 0.88),
                # Missing third segment
            ],
            speakers_detected=2,
        )

        mock_identifier = AsyncMock()
        mock_identifier.diarize_segments.return_value = diarization_result

        with patch("stt_v2.diarization.speaker_identifier.get_speaker_identifier", return_value=mock_identifier):
            _metadata = await service._run_diarization(
                samples, sample_rate, raw_result, "t-test", None, DiarizationConfig(enabled=True)
            )

        # First two segments should be annotated
        assert raw_result.segments[0]["speaker_id"] == "speaker-1"
        assert raw_result.segments[1]["speaker_id"] == "speaker-2"
        # Third segment should not have speaker_id (index out of range check)
        assert "speaker_id" not in raw_result.segments[2]


# =============================================================================
# TestBatchServiceTranscribeWithDiarization
# =============================================================================

class TestBatchServiceTranscribeWithDiarization:
    """Test full transcribe() method with diarization enabled."""

    @pytest.mark.asyncio
    async def test_transcribe_with_diarization_success(self):
        """Test transcribe() with diarization enabled and successful result."""
        service = BatchTranscriptionService()
        audio_bytes = b"fake_audio_bytes"
        pipeline_config = create_pipeline_config_with_diarization(enabled=True)

        # Mock all dependencies
        mock_asr_model = MagicMock(spec=LoadedModel)
        mock_asr_model.format = AiModelFormat.SAFETENSOR

        processed_audio = ProcessedAudio(
            samples=np.random.randn(16000).astype(np.float32),
            sample_rate=16000,
            duration_seconds=1.0,
            vad_applied=True,
        )

        raw_transcription = RawTranscription(
            text="Hello world. How are you?",
            language="en",
            segments=[
                {"text": "Hello world", "start": 0.0, "end": 1.0},
                {"text": "How are you", "start": 2.0, "end": 3.5},
            ],
        )

        _diarization_result = create_mock_diarization_result(
            applied=True,
            segments=[
                ("Hello world", 0.0, 1.0, "speaker-1", 0.95),
                ("How are you", 2.0, 3.5, "speaker-2", 0.88),
            ],
            speakers_detected=2,
            new_speakers_created=1,
        )

        with patch.object(service, "_load_models", return_value={"asr": mock_asr_model, "vad": None, "denoise": None}):
            with patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_get_preprocessor:
                mock_preprocessor = AsyncMock()
                mock_preprocessor.process.return_value = processed_audio
                mock_get_preprocessor.return_value = mock_preprocessor

                with patch.object(service, "_run_inference", return_value=raw_transcription):
                    with patch.object(service, "_run_diarization", return_value={
                        "speakers_detected": 2,
                        "new_speakers_created": 1,
                        "speaker_ids": ["speaker-1", "speaker-2"],
                    }):
                        with patch.object(service, "_postprocess") as mock_postprocess:
                            mock_postprocess.return_value = TranscriptionResult(
                                text="Hello world. How are you?",
                                language="en",
                                duration_seconds=1.0,
                                metadata={},
                            )

                            result = await service.transcribe(
                                job_id="job-123",
                                audio_bytes=audio_bytes,
                                pipeline_config=pipeline_config,
                                tenant_id="t-test",
                                consultation_id="c-test",
                            )

        # Verify diarization metadata is present
        assert "diarization" in result.metadata
        assert result.metadata["diarization"]["speakers_detected"] == 2
        assert result.metadata["diarization"]["new_speakers_created"] == 1
        assert set(result.metadata["diarization"]["speaker_ids"]) == {"speaker-1", "speaker-2"}

    @pytest.mark.asyncio
    async def test_transcribe_without_tenant_id(self):
        """Test transcribe() with diarization enabled but no tenant_id."""
        service = BatchTranscriptionService()
        audio_bytes = b"fake_audio_bytes"
        pipeline_config = create_pipeline_config_with_diarization(enabled=True)

        mock_asr_model = MagicMock(spec=LoadedModel)
        mock_asr_model.format = AiModelFormat.SAFETENSOR

        processed_audio = ProcessedAudio(
            samples=np.random.randn(16000).astype(np.float32),
            sample_rate=16000,
            duration_seconds=1.0,
        )

        raw_transcription = RawTranscription(text="Hello world", language="en")

        with patch.object(service, "_load_models", return_value={"asr": mock_asr_model, "vad": None, "denoise": None}):
            with patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_get_preprocessor:
                mock_preprocessor = AsyncMock()
                mock_preprocessor.process.return_value = processed_audio
                mock_get_preprocessor.return_value = mock_preprocessor

                with patch.object(service, "_run_inference", return_value=raw_transcription):
                    with patch.object(service, "_postprocess", return_value=TranscriptionResult(
                        text="Hello world",
                        language="en",
                        duration_seconds=1.0,
                        metadata={},
                    )):
                        result = await service.transcribe(
                            job_id="job-123",
                            audio_bytes=audio_bytes,
                            pipeline_config=pipeline_config,
                            tenant_id=None,  # No tenant_id
                            consultation_id=None,
                        )

        # Diarization should not run, so no diarization metadata
        assert "diarization" not in result.metadata

    @pytest.mark.asyncio
    async def test_transcribe_with_diarization_disabled(self):
        """Test transcribe() with diarization disabled in config."""
        service = BatchTranscriptionService()
        audio_bytes = b"fake_audio_bytes"
        pipeline_config = create_pipeline_config_with_diarization(enabled=False)

        mock_asr_model = MagicMock(spec=LoadedModel)
        mock_asr_model.format = AiModelFormat.SAFETENSOR

        processed_audio = ProcessedAudio(
            samples=np.random.randn(16000).astype(np.float32),
            sample_rate=16000,
            duration_seconds=1.0,
        )

        raw_transcription = RawTranscription(text="Hello world", language="en")

        with patch.object(service, "_load_models", return_value={"asr": mock_asr_model, "vad": None, "denoise": None}):
            with patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_get_preprocessor:
                mock_preprocessor = AsyncMock()
                mock_preprocessor.process.return_value = processed_audio
                mock_get_preprocessor.return_value = mock_preprocessor

                with patch.object(service, "_run_inference", return_value=raw_transcription):
                    with patch.object(service, "_postprocess", return_value=TranscriptionResult(
                        text="Hello world",
                        language="en",
                        duration_seconds=1.0,
                        metadata={},
                    )):
                        result = await service.transcribe(
                            job_id="job-123",
                            audio_bytes=audio_bytes,
                            pipeline_config=pipeline_config,
                            tenant_id="t-test",
                            consultation_id="c-test",
                        )

        # Diarization disabled, so no diarization metadata
        assert "diarization" not in result.metadata

    @pytest.mark.asyncio
    async def test_transcribe_with_diarization_failure_non_fatal(self):
        """Test transcribe() continues when diarization fails (non-fatal)."""
        service = BatchTranscriptionService()
        audio_bytes = b"fake_audio_bytes"
        pipeline_config = create_pipeline_config_with_diarization(enabled=True)

        mock_asr_model = MagicMock(spec=LoadedModel)
        mock_asr_model.format = AiModelFormat.SAFETENSOR

        processed_audio = ProcessedAudio(
            samples=np.random.randn(16000).astype(np.float32),
            sample_rate=16000,
            duration_seconds=1.0,
        )

        raw_transcription = RawTranscription(text="Hello world", language="en")

        with patch.object(service, "_load_models", return_value={"asr": mock_asr_model, "vad": None, "denoise": None}):
            with patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_get_preprocessor:
                mock_preprocessor = AsyncMock()
                mock_preprocessor.process.return_value = processed_audio
                mock_get_preprocessor.return_value = mock_preprocessor

                with patch.object(service, "_run_inference", return_value=raw_transcription):
                    with patch.object(service, "_run_diarization", side_effect=RuntimeError("Diarization failed")):
                        with patch.object(service, "_postprocess", return_value=TranscriptionResult(
                            text="Hello world",
                            language="en",
                            duration_seconds=1.0,
                            metadata={},
                        )):
                            # Should not raise, diarization failure is non-fatal
                            result = await service.transcribe(
                                job_id="job-123",
                                audio_bytes=audio_bytes,
                                pipeline_config=pipeline_config,
                                tenant_id="t-test",
                                consultation_id="c-test",
                            )

        # Result should still be returned, no diarization metadata
        assert result.text == "Hello world"
        assert "diarization" not in result.metadata


# =============================================================================
# TestWorkerInitializationIntegration
# =============================================================================

class TestWorkerInitializationIntegration:
    """Test worker initialization and cleanup of new services."""

    @pytest.mark.asyncio
    async def test_initialize_services_calls_all_services(self):
        """Test that initialize_services() calls all service initializations."""
        from stt_v2.worker import initialize_services

        # Mock all service initializations
        mock_vad_service = AsyncMock()
        mock_vad_service.initialize = AsyncMock()

        mock_speaker_store = AsyncMock()
        mock_speaker_store.ensure_collection = AsyncMock()

        mock_embedding_service = AsyncMock()
        mock_embedding_service.initialize = AsyncMock()

        with patch("stt_v2.core.database.connection.initialize_database", new_callable=AsyncMock):
            with patch("stt_v2.core.storage.minio_client.initialize_minio", new_callable=AsyncMock):
                with patch("stt_v2.vad.silero_service.get_vad_service", return_value=mock_vad_service):
                    with patch("stt_v2.core.vectorstore.speaker_store.get_speaker_store", return_value=mock_speaker_store):
                        with patch("stt_v2.diarization.embedding_service.get_embedding_service", return_value=mock_embedding_service):
                            await initialize_services()

        # Verify all services were initialized
        mock_vad_service.initialize.assert_called_once()
        mock_speaker_store.ensure_collection.assert_called_once()
        mock_embedding_service.initialize.assert_called_once()

    @pytest.mark.asyncio
    async def test_initialize_services_handles_vad_failure(self):
        """Test that VAD initialization failure is non-fatal."""
        from stt_v2.worker import initialize_services

        mock_vad_service = AsyncMock()
        mock_vad_service.initialize.side_effect = RuntimeError("VAD init failed")

        with patch("stt_v2.core.database.connection.initialize_database", new_callable=AsyncMock):
            with patch("stt_v2.core.storage.minio_client.initialize_minio", new_callable=AsyncMock):
                with patch("stt_v2.vad.silero_service.get_vad_service", return_value=mock_vad_service):
                    with patch("stt_v2.core.vectorstore.speaker_store.get_speaker_store", return_value=AsyncMock()):
                        with patch("stt_v2.diarization.embedding_service.get_embedding_service", return_value=AsyncMock()):
                            # Should not raise, VAD failure is non-fatal
                            await initialize_services()

        # VAD init should have been attempted
        mock_vad_service.initialize.assert_called_once()

    @pytest.mark.asyncio
    async def test_initialize_services_handles_qdrant_failure(self):
        """Test that Qdrant initialization failure is non-fatal."""
        from stt_v2.worker import initialize_services

        mock_speaker_store = AsyncMock()
        mock_speaker_store.ensure_collection.side_effect = RuntimeError("Qdrant init failed")

        with patch("stt_v2.core.database.connection.initialize_database", new_callable=AsyncMock):
            with patch("stt_v2.core.storage.minio_client.initialize_minio", new_callable=AsyncMock):
                with patch("stt_v2.vad.silero_service.get_vad_service", return_value=AsyncMock()):
                    with patch("stt_v2.core.vectorstore.speaker_store.get_speaker_store", return_value=mock_speaker_store):
                        with patch("stt_v2.diarization.embedding_service.get_embedding_service", return_value=AsyncMock()):
                            # Should not raise, Qdrant failure is non-fatal
                            await initialize_services()

        # Qdrant init should have been attempted
        mock_speaker_store.ensure_collection.assert_called_once()

    @pytest.mark.asyncio
    async def test_initialize_services_handles_diarization_failure(self):
        """Test that diarization initialization failure is non-fatal."""
        from stt_v2.worker import initialize_services

        mock_embedding_service = AsyncMock()
        mock_embedding_service.initialize.side_effect = RuntimeError("Diarization init failed")

        with patch("stt_v2.core.database.connection.initialize_database", new_callable=AsyncMock):
            with patch("stt_v2.core.storage.minio_client.initialize_minio", new_callable=AsyncMock):
                with patch("stt_v2.vad.silero_service.get_vad_service", return_value=AsyncMock()):
                    with patch("stt_v2.core.vectorstore.speaker_store.get_speaker_store", return_value=AsyncMock()):
                        with patch("stt_v2.diarization.embedding_service.get_embedding_service", return_value=mock_embedding_service):
                            # Should not raise, diarization failure is non-fatal
                            await initialize_services()

        # Diarization init should have been attempted
        mock_embedding_service.initialize.assert_called_once()

    @pytest.mark.asyncio
    async def test_cleanup_services_calls_all_cleanups(self):
        """Test that cleanup_services() calls all service cleanups."""
        from stt_v2.worker import cleanup_services

        mock_vad_service = AsyncMock()
        mock_vad_service.shutdown = AsyncMock()

        mock_qdrant_client = AsyncMock()
        mock_qdrant_client.close = AsyncMock()

        mock_embedding_service = AsyncMock()
        mock_embedding_service.shutdown = AsyncMock()

        with patch("stt_v2.core.database.connection.close_database", new_callable=AsyncMock):
            with patch("stt_v2.core.storage.minio_client.close_minio", new_callable=AsyncMock):
                with patch("stt_v2.vad.silero_service.get_vad_service", return_value=mock_vad_service):
                    with patch("stt_v2.core.vectorstore.client.get_qdrant_client", return_value=mock_qdrant_client):
                        with patch("stt_v2.diarization.embedding_service.get_embedding_service", return_value=mock_embedding_service):
                            await cleanup_services()

        # Verify all services were cleaned up
        mock_vad_service.shutdown.assert_called_once()
        mock_qdrant_client.close.assert_called_once()
        mock_embedding_service.shutdown.assert_called_once()

    @pytest.mark.asyncio
    async def test_cleanup_services_handles_failures_gracefully(self):
        """Test that cleanup failures don't crash the cleanup process."""
        from stt_v2.worker import cleanup_services

        mock_vad_service = AsyncMock()
        mock_vad_service.shutdown.side_effect = RuntimeError("VAD shutdown failed")

        mock_qdrant_client = AsyncMock()
        mock_qdrant_client.close.side_effect = RuntimeError("Qdrant close failed")

        mock_embedding_service = AsyncMock()
        mock_embedding_service.shutdown.side_effect = RuntimeError("Diarization shutdown failed")

        with patch("stt_v2.core.database.connection.close_database", new_callable=AsyncMock):
            with patch("stt_v2.core.storage.minio_client.close_minio", new_callable=AsyncMock):
                with patch("stt_v2.vad.silero_service.get_vad_service", return_value=mock_vad_service):
                    with patch("stt_v2.core.vectorstore.client.get_qdrant_client", return_value=mock_qdrant_client):
                        with patch("stt_v2.diarization.embedding_service.get_embedding_service", return_value=mock_embedding_service):
                            # Should not raise, cleanup failures are handled gracefully
                            await cleanup_services()

        # All cleanups should have been attempted
        mock_vad_service.shutdown.assert_called_once()
        mock_qdrant_client.close.assert_called_once()
        mock_embedding_service.shutdown.assert_called_once()
