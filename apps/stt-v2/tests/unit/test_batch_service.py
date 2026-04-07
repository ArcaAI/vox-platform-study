"""Unit tests for Batch Transcription Service.

These tests focus on behavior verification:
- Test actual data transformations
- Verify output structures match expected formats
- Test error handling produces correct error types
- Use complete fixtures matching real data structures
"""

import logging
import os
import sys
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt_v2.core.exceptions import TranscriptionError
from stt_v2.models.base_loader import LoadedModel

_MODEL_BASE = (
    os.environ.get("HUGGINGFACE_CACHE_DIR")
    or os.environ.get("HF_HOME")
    or os.path.join(os.sep, "models", "hf-cache")
)
from stt_v2.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    DiarizationConfig,
    InferenceConfig,
    ModelRef,
    ModelRefs,
    ModelTaskType,
    PipelineConfig,
    PipelineSpec,
    PostprocessingConfig,
    PreprocessingConfig,
    PunctuationConfig,
    TimestampConfig,
)
from stt_v2.transcription.batch_service import (
    BatchTranscriptionService,
    get_batch_service,
)
from stt_v2.transcription.dto import (
    ProcessedAudio,
    RawTranscription,
    TranscriptionResult,
    WordTimestamp,
)

# =============================================================================
# Complete Test Fixtures (Anti-Pattern #4 Prevention)
# =============================================================================


def create_complete_pipeline_config(
    pipeline_id: str = "p-123",
    asr_model: str = "whisper-test",
    vad_model: str | None = "silero-vad",
    language: str = "en",
    batch_size: int = 16,
) -> PipelineConfig:
    """Create a complete PipelineConfig matching real database structure.

    This prevents incomplete mock anti-pattern by including ALL fields
    that production code might access.
    """
    spec = PipelineSpec(
        version="1.0",
        models=ModelRefs(
            asr=ModelRef(slug=asr_model),
            vad=ModelRef(slug=vad_model) if vad_model else None,
            denoise=None,
        ),
        preprocessing=PreprocessingConfig(
            target_sample_rate=16000,
            normalize=True,
        ),
        inference=InferenceConfig(
            batch_size=batch_size,
            language=language,
            compute_type="float32",
            device="auto",
        ),
        postprocessing=PostprocessingConfig(
            lowercase=False,
            timestamps=TimestampConfig(word_timestamps=True, sentence_timestamps=False),
            punctuation=PunctuationConfig(enabled=False, model=None),
        ),
    )
    return PipelineConfig(
        id=pipeline_id,
        tenant_id="t-456",
        slug="test-pipeline",
        name="Test Pipeline",
        description="Complete test pipeline configuration",
        spec=spec,
        tags=["test", "unit"],
        created_at=datetime(2024, 1, 1, 0, 0, 0),
        updated_at=datetime(2024, 1, 2, 0, 0, 0),
    )


def create_complete_model_config(
    model_id: str = "m-123",
    slug: str = "whisper-test",
    task_type: ModelTaskType = ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    is_downloaded: bool = True,
) -> AiModelConfig:
    """Create a complete AiModelConfig matching real database structure."""
    return AiModelConfig(
        id=model_id,
        tenant_id="t-456",
        slug=slug,
        name="Whisper Test Model",
        description="OpenAI Whisper tiny model for testing",
        task_type=task_type,
        source=AiModelSource.HUGGINGFACE,
        source_uri="openai/whisper-tiny",
        source_revision="main",
        format=AiModelFormat.SAFETENSOR,
        memory_size_mb=80,
        compute_type="float32",
        download_status=(
            AiModelDownloadStatus.DOWNLOADED if is_downloaded else AiModelDownloadStatus.PENDING
        ),
        local_path=os.path.join(_MODEL_BASE, "whisper-tiny") if is_downloaded else None,
        downloaded_at=datetime(2024, 1, 1) if is_downloaded else None,
        file_size_mb=80 if is_downloaded else None,
        checksum="sha256:abc123" if is_downloaded else None,
        tags=["asr", "whisper", "english"],
    )


def create_complete_loaded_model(
    slug: str = "whisper-test",
    memory_mb: int = 80,
) -> LoadedModel:
    """Create a complete LoadedModel with realistic mock components."""
    mock_model = MagicMock()
    mock_model.config = MagicMock()
    mock_model.config.vocab_size = 51865

    mock_processor = MagicMock()
    mock_processor.feature_extractor = MagicMock()
    mock_processor.tokenizer = MagicMock()

    return LoadedModel(
        model_id=f"m-{slug}",
        model_slug=slug,
        model=mock_model,
        processor=mock_processor,
        tokenizer=mock_processor.tokenizer,
        format=AiModelFormat.SAFETENSOR,
        memory_mb=memory_mb,
        device="cpu",
        loaded_at=datetime.utcnow(),
    )


def create_valid_wav_audio(
    duration_seconds: float = 1.0,
    sample_rate: int = 16000,
    frequency_hz: int = 440,
) -> bytes:
    """Generate valid WAV audio bytes for testing.

    Creates a sine wave tone, not just silence, to better simulate real audio.
    """
    import io
    import math
    import struct

    num_samples = int(sample_rate * duration_seconds)
    samples = [
        int(math.sin(2 * math.pi * frequency_hz * i / sample_rate) * 16000)
        for i in range(num_samples)
    ]

    wav = io.BytesIO()
    wav.write(b"RIFF")
    wav.write(struct.pack("<I", 36 + len(samples) * 2))
    wav.write(b"WAVE")
    wav.write(b"fmt ")
    wav.write(struct.pack("<I", 16))  # Chunk size
    wav.write(struct.pack("<H", 1))  # Audio format (PCM)
    wav.write(struct.pack("<H", 1))  # Channels (mono)
    wav.write(struct.pack("<I", sample_rate))
    wav.write(struct.pack("<I", sample_rate * 2))  # Byte rate
    wav.write(struct.pack("<H", 2))  # Block align
    wav.write(struct.pack("<H", 16))  # Bits per sample
    wav.write(b"data")
    wav.write(struct.pack("<I", len(samples) * 2))
    wav.write(struct.pack(f"<{len(samples)}h", *samples))

    return wav.getvalue()


class TestBatchTranscriptionService:
    """Tests for BatchTranscriptionService.

    Focus on testing actual behavior outcomes:
    - Result structure and content
    - Error transformation
    - Progress tracking behavior
    """

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    @pytest.fixture
    def pipeline_config(self):
        """Complete pipeline configuration fixture."""
        return create_complete_pipeline_config()

    @pytest.fixture
    def model_config(self):
        """Complete model configuration fixture."""
        return create_complete_model_config()

    @pytest.fixture
    def loaded_model(self):
        """Complete loaded model fixture."""
        return create_complete_loaded_model()

    @pytest.fixture
    def audio_bytes(self):
        """Valid WAV audio fixture."""
        return create_valid_wav_audio(duration_seconds=2.0)

    # =========================================================================
    # Transcription Pipeline Tests - Focus on result behavior
    # =========================================================================

    @pytest.mark.asyncio
    async def test_transcribe_returns_complete_result_structure(
        self, service, pipeline_config, loaded_model, audio_bytes
    ):
        """Verify transcription returns a complete TranscriptionResult with all fields."""
        with (
            patch.object(service, "_load_models") as mock_load,
            patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc,
            patch.object(service, "_run_inference") as mock_inference,
            patch.object(service, "_postprocess") as mock_postproc,
        ):

            mock_load.return_value = {"asr": loaded_model, "vad": None, "denoise": None}

            mock_preprocessor = AsyncMock()
            mock_preprocessor.process = AsyncMock(
                return_value=ProcessedAudio(
                    samples=np.zeros(32000, dtype=np.float32),
                    sample_rate=16000,
                    duration_seconds=2.0,
                    was_resampled=False,
                    was_normalized=True,
                )
            )
            mock_preproc.return_value = mock_preprocessor

            mock_inference.return_value = RawTranscription(
                text="Hello world, this is a test.",
                language="en",
                language_probability=0.98,
            )

            # Return a complete result from postprocess
            mock_postproc.return_value = TranscriptionResult(
                text="Hello world, this is a test.",
                language="en",
                language_probability=0.98,
                duration_seconds=2.0,
                word_timestamps=[
                    WordTimestamp("Hello", 0.0, 0.3, 0.95),
                    WordTimestamp("world", 0.4, 0.7, 0.92),
                ],
            )

            result = await service.transcribe(
                job_id="j-123",
                audio_bytes=audio_bytes,
                pipeline_config=pipeline_config,
            )

            # Test actual result structure (the behavior we care about)
            assert isinstance(result, TranscriptionResult)
            assert result.text == "Hello world, this is a test."
            assert result.language == "en"
            assert result.duration_seconds == 2.0
            assert result.processing_time_seconds > 0  # Should have timing
            assert len(result.word_timestamps) == 2

    @pytest.mark.asyncio
    async def test_transcribe_tracks_progress_correctly(
        self, service, pipeline_config, loaded_model, audio_bytes
    ):
        """Verify progress callback receives monotonically increasing values."""
        progress_values = []

        def track_progress(progress: int):
            progress_values.append(progress)

        with (
            patch.object(service, "_load_models") as mock_load,
            patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc,
            patch.object(service, "_run_inference") as mock_inference,
            patch.object(service, "_postprocess") as mock_postproc,
        ):

            mock_load.return_value = {"asr": loaded_model, "vad": None, "denoise": None}

            mock_preprocessor = AsyncMock()
            mock_preprocessor.process = AsyncMock(
                return_value=ProcessedAudio(
                    samples=np.zeros(16000, dtype=np.float32),
                    sample_rate=16000,
                    duration_seconds=1.0,
                )
            )
            mock_preproc.return_value = mock_preprocessor
            mock_inference.return_value = RawTranscription(text="Test")
            mock_postproc.return_value = TranscriptionResult(text="Test", duration_seconds=1.0)

            await service.transcribe(
                job_id="j-123",
                audio_bytes=audio_bytes,
                pipeline_config=pipeline_config,
                progress_callback=track_progress,
            )

            # Test actual progress behavior
            assert len(progress_values) > 0, "Should report progress"
            assert progress_values[-1] == 100, "Should reach 100%"

            # Progress should be monotonically increasing
            for i in range(1, len(progress_values)):
                assert (
                    progress_values[i] >= progress_values[i - 1]
                ), f"Progress should not decrease: {progress_values}"

    @pytest.mark.asyncio
    async def test_transcribe_propagates_model_error_with_context(
        self, service, pipeline_config, audio_bytes
    ):
        """Verify model loading errors include helpful context."""
        with patch.object(service, "_load_models") as mock_load:
            mock_load.side_effect = TranscriptionError(
                "ASR model 'whisper-test' not found in registry",
                details={"model_slug": "whisper-test", "pipeline_id": "p-123"},
            )

            with pytest.raises(TranscriptionError) as exc_info:
                await service.transcribe(
                    job_id="j-123",
                    audio_bytes=audio_bytes,
                    pipeline_config=pipeline_config,
                )

            # Test error content provides useful information
            error = exc_info.value
            assert "whisper-test" in str(error) or "model" in str(error).lower()

    # =========================================================================
    # Model Loading Tests - Focus on loading behavior
    # =========================================================================

    @pytest.mark.asyncio
    async def test_load_models_returns_dict_with_expected_keys(
        self, service, pipeline_config, model_config, loaded_model
    ):
        """Verify _load_models returns a dict with asr, vad, denoise keys."""
        with (
            patch("stt_v2.transcription.batch_service.get_model_cache") as mock_cache,
            patch("stt_v2.transcription.batch_service.get_model_reader") as mock_reader,
        ):

            mock_model_reader = AsyncMock()
            mock_model_reader.get_models_for_pipeline = AsyncMock(
                return_value={
                    "whisper-test": model_config,
                    "silero-vad": create_complete_model_config(
                        slug="silero-vad",
                        task_type=ModelTaskType.VOICE_ACTIVITY_DETECTION,
                    ),
                }
            )
            mock_reader.return_value = mock_model_reader

            mock_model_cache = AsyncMock()
            mock_model_cache.get_or_load = AsyncMock(return_value=loaded_model)
            mock_cache.return_value = mock_model_cache

            result = await service._load_models(pipeline_config)

            # Test actual return structure
            assert isinstance(result, dict)
            assert "asr" in result
            assert result["asr"] is not None
            # VAD should be present if configured
            assert "vad" in result or pipeline_config.spec.models.vad is None
            assert "denoise" in result or pipeline_config.spec.models.denoise is None

    @pytest.mark.asyncio
    async def test_load_models_raises_when_required_asr_missing(self, service, pipeline_config):
        """Verify error when required ASR model is not in registry."""
        with patch("stt_v2.transcription.batch_service.get_model_reader") as mock_reader:
            mock_model_reader = AsyncMock()
            # Return empty - no models found
            mock_model_reader.get_models_for_pipeline = AsyncMock(return_value={})
            mock_reader.return_value = mock_model_reader

            with pytest.raises(TranscriptionError) as exc_info:
                await service._load_models(pipeline_config)

            # Test error is descriptive
            error_message = str(exc_info.value).lower()
            assert "not found" in error_message or "missing" in error_message

    # =========================================================================
    # Postprocessing Tests - Focus on transformation behavior
    # =========================================================================

    def test_postprocess_trims_whitespace(self, service):
        """Verify postprocessing trims leading/trailing whitespace."""
        raw = RawTranscription(
            text="  hello world  \n\t",
            language="en",
        )

        config = MagicMock()
        config.lowercase = False
        config.timestamps = MagicMock()
        config.timestamps.word_timestamps = False
        config.timestamps.sentence_timestamps = False

        result = service._postprocess(raw, config, 1.0)

        # Test actual transformation
        assert result.text == "hello world"
        assert not result.text.startswith(" ")
        assert not result.text.endswith(" ")

    def test_postprocess_applies_lowercase_transformation(self, service):
        """Verify lowercase option transforms text correctly."""
        raw = RawTranscription(text="Hello WORLD Test")

        config = MagicMock()
        config.lowercase = True
        config.timestamps = MagicMock()
        config.timestamps.word_timestamps = False
        config.timestamps.sentence_timestamps = False

        result = service._postprocess(raw, config, 1.0)

        # Test actual transformation
        assert result.text == "hello world test"
        assert result.text.islower()

    def test_postprocess_preserves_word_timestamps_structure(self, service):
        """Verify word timestamps are correctly extracted and structured."""
        raw = RawTranscription(
            text="Hello world",
            word_timestamps=[
                {"text": "Hello", "start": 0.0, "end": 0.5, "confidence": 0.95},
                {"word": "world", "start_time": 0.6, "end_time": 1.0, "probability": 0.92},
            ],
        )

        config = MagicMock()
        config.lowercase = False
        config.timestamps = MagicMock()
        config.timestamps.word_timestamps = True
        config.timestamps.sentence_timestamps = False

        result = service._postprocess(raw, config, 1.0)

        # Test actual timestamp structure
        assert len(result.word_timestamps) == 2

        # First word
        assert result.word_timestamps[0].word == "Hello"
        assert result.word_timestamps[0].start_time == 0.0
        assert result.word_timestamps[0].end_time == 0.5

        # Second word (tests alternate key names)
        assert result.word_timestamps[1].word == "world"
        assert result.word_timestamps[1].start_time == 0.6
        assert result.word_timestamps[1].end_time == 1.0

    def test_postprocess_copies_language_metadata(self, service):
        """Verify language and probability are preserved in result."""
        raw = RawTranscription(
            text="Test",
            language="de",
            language_probability=0.87,
        )

        config = MagicMock()
        config.lowercase = False
        config.timestamps = MagicMock()
        config.timestamps.word_timestamps = False
        config.timestamps.sentence_timestamps = False

        result = service._postprocess(raw, config, 2.5)

        # Test metadata preservation
        assert result.language == "de"
        assert result.language_probability == 0.87
        assert result.duration_seconds == 2.5


class TestBatchServiceSingleton:
    """Tests for batch service singleton factory."""

    def test_get_batch_service_returns_same_instance(self):
        """Verify singleton pattern returns identical instance."""
        import stt_v2.transcription.batch_service as module

        module._service = None  # Reset for clean test

        service1 = get_batch_service()
        service2 = get_batch_service()

        # Test actual identity
        assert service1 is service2
        assert id(service1) == id(service2)

    def test_get_batch_service_returns_correct_type(self):
        """Verify factory returns BatchTranscriptionService instance."""
        import stt_v2.transcription.batch_service as module

        module._service = None

        service = get_batch_service()

        assert isinstance(service, BatchTranscriptionService)


# =============================================================================
# EDGE CASE TESTS
# =============================================================================


class TestBatchServiceEdgeCases:
    """Edge case tests for batch transcription service."""

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    @pytest.fixture
    def pipeline_config(self):
        return create_complete_pipeline_config()

    # =========================================================================
    # Postprocessing Edge Cases
    # =========================================================================

    def test_postprocess_empty_text(self, service):
        """Test postprocessing empty text."""
        raw = RawTranscription(text="", language="en")

        config = MagicMock()
        config.lowercase = False
        config.timestamps = MagicMock()
        config.timestamps.word_timestamps = False
        config.timestamps.sentence_timestamps = False

        result = service._postprocess(raw, config, 0.0)

        assert result.text == ""
        assert result.duration_seconds == 0.0

    def test_postprocess_whitespace_only_text(self, service):
        """Test postprocessing whitespace-only text."""
        raw = RawTranscription(text="   \n\t   ", language="en")

        config = MagicMock()
        config.lowercase = False
        config.timestamps = MagicMock()
        config.timestamps.word_timestamps = False
        config.timestamps.sentence_timestamps = False

        result = service._postprocess(raw, config, 1.0)

        # Should be empty after trim
        assert result.text == ""

    def test_postprocess_very_long_text(self, service):
        """Test postprocessing very long transcription."""
        # Simulate 1 hour of dense transcription (~10k words)
        long_text = "word " * 10000
        raw = RawTranscription(text=long_text, language="en")

        config = MagicMock()
        config.lowercase = False
        config.timestamps = MagicMock()
        config.timestamps.word_timestamps = False
        config.timestamps.sentence_timestamps = False

        result = service._postprocess(raw, config, 3600.0)

        # Should handle long text without issue
        assert len(result.text) > 40000
        assert result.duration_seconds == 3600.0

    def test_postprocess_unicode_text(self, service):
        """Test postprocessing unicode text."""
        raw = RawTranscription(
            text="日本語テスト 中文测试 한국어테스트",
            language="multi",
        )

        config = MagicMock()
        config.lowercase = False
        config.timestamps = MagicMock()
        config.timestamps.word_timestamps = False
        config.timestamps.sentence_timestamps = False

        result = service._postprocess(raw, config, 5.0)

        assert "日本語" in result.text
        assert "中文" in result.text
        assert "한국어" in result.text

    def test_postprocess_lowercase_with_unicode(self, service):
        """Test lowercase transformation with unicode."""
        raw = RawTranscription(
            text="HELLO WORLD Привет Мир",  # Mixed English and Russian
            language="multi",
        )

        config = MagicMock()
        config.lowercase = True
        config.timestamps = MagicMock()
        config.timestamps.word_timestamps = False
        config.timestamps.sentence_timestamps = False

        result = service._postprocess(raw, config, 2.0)

        assert result.text == "hello world привет мир"

    def test_postprocess_empty_word_timestamps(self, service):
        """Test postprocessing with empty word timestamps list."""
        raw = RawTranscription(
            text="Hello world",
            word_timestamps=[],  # Empty list
        )

        config = MagicMock()
        config.lowercase = False
        config.timestamps = MagicMock()
        config.timestamps.word_timestamps = True
        config.timestamps.sentence_timestamps = False

        result = service._postprocess(raw, config, 1.0)

        assert result.word_timestamps == []

    def test_postprocess_malformed_word_timestamps(self, service):
        """Test postprocessing with malformed word timestamps."""
        raw = RawTranscription(
            text="Hello world",
            word_timestamps=[
                {"text": "Hello", "start": 0.0, "end": 0.5},  # Missing confidence
                {"word": "world"},  # Missing times
                {},  # Completely empty
            ],
        )

        config = MagicMock()
        config.lowercase = False
        config.timestamps = MagicMock()
        config.timestamps.word_timestamps = True
        config.timestamps.sentence_timestamps = False

        # Should handle gracefully without crashing
        result = service._postprocess(raw, config, 1.0)
        # At least partial results should be present
        assert result.text == "Hello world"

    def test_postprocess_none_language(self, service):
        """Test postprocessing with None language."""
        raw = RawTranscription(
            text="Hello",
            language=None,
            language_probability=None,
        )

        config = MagicMock()
        config.lowercase = False
        config.timestamps = MagicMock()
        config.timestamps.word_timestamps = False
        config.timestamps.sentence_timestamps = False

        result = service._postprocess(raw, config, 1.0)

        assert result.language is None
        assert result.language_probability is None

    def test_postprocess_low_probability_language(self, service):
        """Test language with very low probability."""
        raw = RawTranscription(
            text="unclear",
            language="und",  # undetermined
            language_probability=0.01,
        )

        config = MagicMock()
        config.lowercase = False
        config.timestamps = MagicMock()
        config.timestamps.word_timestamps = False
        config.timestamps.sentence_timestamps = False

        result = service._postprocess(raw, config, 1.0)

        # Should preserve even low probability
        assert result.language_probability == 0.01


class TestBatchServiceModelLoadingEdgeCases:
    """Edge case tests for model loading in batch service."""

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    @pytest.mark.asyncio
    async def test_load_models_with_only_asr(self, service):
        """Test loading models when only ASR is specified."""
        pipeline_config = create_complete_pipeline_config(vad_model=None)

        with (
            patch("stt_v2.transcription.batch_service.get_model_cache") as mock_cache,
            patch("stt_v2.transcription.batch_service.get_model_reader") as mock_reader,
        ):

            mock_model_reader = AsyncMock()
            mock_model_reader.get_models_for_pipeline = AsyncMock(
                return_value={
                    "whisper-test": create_complete_model_config(),
                }
            )
            mock_reader.return_value = mock_model_reader

            mock_model_cache = AsyncMock()
            mock_model_cache.get_or_load = AsyncMock(return_value=create_complete_loaded_model())
            mock_cache.return_value = mock_model_cache

            result = await service._load_models(pipeline_config)

            assert "asr" in result
            assert result["asr"] is not None
            assert result.get("vad") is None
            assert result.get("denoise") is None

    @pytest.mark.asyncio
    async def test_load_models_vad_model_not_found(self, service):
        """Test loading when optional VAD model not found."""
        pipeline_config = create_complete_pipeline_config()

        with (
            patch("stt_v2.transcription.batch_service.get_model_cache") as mock_cache,
            patch("stt_v2.transcription.batch_service.get_model_reader") as mock_reader,
        ):

            mock_model_reader = AsyncMock()
            # Only ASR model found, VAD missing
            mock_model_reader.get_models_for_pipeline = AsyncMock(
                return_value={
                    "whisper-test": create_complete_model_config(),
                    # "silero-vad" is missing
                }
            )
            mock_reader.return_value = mock_model_reader

            mock_model_cache = AsyncMock()
            mock_model_cache.get_or_load = AsyncMock(return_value=create_complete_loaded_model())
            mock_cache.return_value = mock_model_cache

            # Should not raise - VAD is optional
            result = await service._load_models(pipeline_config)

            assert result["asr"] is not None


class TestBatchServiceProgressEdgeCases:
    """Edge case tests for progress tracking."""

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    @pytest.fixture
    def pipeline_config(self):
        return create_complete_pipeline_config()

    @pytest.mark.asyncio
    async def test_progress_callback_none(self, service, pipeline_config):
        """Test transcription works with None progress callback."""
        loaded_model = create_complete_loaded_model()
        audio_bytes = create_valid_wav_audio()

        with (
            patch.object(service, "_load_models") as mock_load,
            patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc,
            patch.object(service, "_run_inference") as mock_inference,
            patch.object(service, "_postprocess") as mock_postproc,
        ):

            mock_load.return_value = {"asr": loaded_model, "vad": None, "denoise": None}

            mock_preprocessor = AsyncMock()
            mock_preprocessor.process = AsyncMock(
                return_value=ProcessedAudio(
                    samples=np.zeros(16000, dtype=np.float32),
                    sample_rate=16000,
                    duration_seconds=1.0,
                )
            )
            mock_preproc.return_value = mock_preprocessor
            mock_inference.return_value = RawTranscription(text="Test")
            mock_postproc.return_value = TranscriptionResult(text="Test", duration_seconds=1.0)

            # Should not raise with None callback
            result = await service.transcribe(
                job_id="j-123",
                audio_bytes=audio_bytes,
                pipeline_config=pipeline_config,
                progress_callback=None,
            )

            assert result.text == "Test"

    @pytest.mark.asyncio
    async def test_progress_callback_throws_exception_propagates(self, service, pipeline_config):
        """Test that callback exceptions are propagated to caller.

        Note: This tests the current behavior where callback exceptions
        propagate up. Callers should provide safe callbacks.
        """
        loaded_model = create_complete_loaded_model()
        audio_bytes = create_valid_wav_audio()

        def bad_callback(progress: int):
            raise RuntimeError("Callback error")

        with (
            patch.object(service, "_load_models") as mock_load,
            patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc,
            patch.object(service, "_run_inference") as mock_inference,
            patch.object(service, "_postprocess") as mock_postproc,
        ):

            mock_load.return_value = {"asr": loaded_model, "vad": None, "denoise": None}

            mock_preprocessor = AsyncMock()
            mock_preprocessor.process = AsyncMock(
                return_value=ProcessedAudio(
                    samples=np.zeros(16000, dtype=np.float32),
                    sample_rate=16000,
                    duration_seconds=1.0,
                )
            )
            mock_preproc.return_value = mock_preprocessor
            mock_inference.return_value = RawTranscription(text="Test")
            mock_postproc.return_value = TranscriptionResult(text="Test", duration_seconds=1.0)

            # Current implementation propagates callback errors
            with pytest.raises((RuntimeError, TranscriptionError)):
                await service.transcribe(
                    job_id="j-123",
                    audio_bytes=audio_bytes,
                    pipeline_config=pipeline_config,
                    progress_callback=bad_callback,
                )


# =============================================================================
# INFERENCE METHOD COVERAGE TESTS
# =============================================================================


class TestBatchServiceInferenceMethods:
    """Tests for inference method dispatch and execution."""

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    def create_loaded_model_with_format(
        self, fmt: AiModelFormat, extra: dict = None
    ) -> LoadedModel:
        """Create a loaded model with specific format."""
        mock_model = MagicMock()
        mock_model.config = MagicMock()
        mock_processor = MagicMock()

        return LoadedModel(
            model_id=f"m-{fmt.value}",
            model_slug=f"model-{fmt.value}",
            model=mock_model,
            processor=mock_processor,
            tokenizer=mock_processor,
            format=fmt,
            memory_mb=100,
            device="cpu",
            loaded_at=datetime.utcnow(),
            extra=extra or {},
        )

    @pytest.mark.asyncio
    async def test_run_inference_dispatches_to_transformers(self, service):
        """Test that SAFETENSOR format dispatches to transformers inference."""
        model = self.create_loaded_model_with_format(AiModelFormat.SAFETENSOR)
        samples = np.zeros(16000, dtype=np.float32)
        config = MagicMock()
        config.language = "en"

        with patch.object(
            service, "_run_transformers_inference", new_callable=AsyncMock
        ) as mock_tf:
            mock_tf.return_value = RawTranscription(text="Test")

            result = await service._run_inference(samples, 16000, model, config)

            mock_tf.assert_called_once()
            assert result.text == "Test"

    @pytest.mark.asyncio
    async def test_run_inference_dispatches_to_pytorch(self, service):
        """Test that PYTORCH format dispatches to transformers inference."""
        model = self.create_loaded_model_with_format(AiModelFormat.PYTORCH)
        samples = np.zeros(16000, dtype=np.float32)
        config = MagicMock()

        with patch.object(
            service, "_run_transformers_inference", new_callable=AsyncMock
        ) as mock_tf:
            mock_tf.return_value = RawTranscription(text="Test")

            _result = await service._run_inference(samples, 16000, model, config)

            mock_tf.assert_called_once()

    @pytest.mark.asyncio
    async def test_run_inference_dispatches_to_ctranslate2(self, service):
        """Test that CTRANSLATE2 format dispatches to transformers inference."""
        model = self.create_loaded_model_with_format(AiModelFormat.CTRANSLATE2)
        samples = np.zeros(16000, dtype=np.float32)
        config = MagicMock()

        with patch.object(
            service, "_run_transformers_inference", new_callable=AsyncMock
        ) as mock_tf:
            mock_tf.return_value = RawTranscription(text="Test")

            await service._run_inference(samples, 16000, model, config)

            mock_tf.assert_called_once()

    @pytest.mark.asyncio
    async def test_run_inference_dispatches_to_onnx(self, service):
        """Test that ONNX format dispatches to ONNX inference."""
        model = self.create_loaded_model_with_format(AiModelFormat.ONNX)
        model.processor = None  # No processor means standard ONNX
        model.extra = {}
        samples = np.zeros(16000, dtype=np.float32)
        config = MagicMock()

        with patch.object(service, "_run_onnx_inference", new_callable=AsyncMock) as mock_onnx:
            mock_onnx.return_value = RawTranscription(text="Test")

            await service._run_inference(samples, 16000, model, config)

            mock_onnx.assert_called_once()

    @pytest.mark.asyncio
    async def test_run_inference_dispatches_to_optimum_onnx(self, service):
        """Test that ONNX_OPTIMUM format dispatches to Optimum inference."""
        model = self.create_loaded_model_with_format(AiModelFormat.ONNX_OPTIMUM)
        model.extra = {"optimum": True}
        samples = np.zeros(16000, dtype=np.float32)
        config = MagicMock()

        with patch.object(
            service, "_run_optimum_onnx_inference", new_callable=AsyncMock
        ) as mock_opt:
            mock_opt.return_value = RawTranscription(text="Test")

            await service._run_inference(samples, 16000, model, config)

            mock_opt.assert_called_once()

    @pytest.mark.asyncio
    async def test_run_inference_dispatches_to_nemo(self, service):
        """Test that NEMO format dispatches to NeMo inference."""
        model = self.create_loaded_model_with_format(AiModelFormat.NEMO)
        samples = np.zeros(16000, dtype=np.float32)
        config = MagicMock()

        with patch.object(service, "_run_nemo_inference", new_callable=AsyncMock) as mock_nemo:
            mock_nemo.return_value = RawTranscription(text="Test")

            await service._run_inference(samples, 16000, model, config)

            mock_nemo.assert_called_once()

    @pytest.mark.asyncio
    async def test_run_inference_dispatches_to_azure_speech(self, service):
        """Test that AZURE_SPEECH format dispatches to Azure Speech inference."""
        model = self.create_loaded_model_with_format(
            AiModelFormat.AZURE_SPEECH,
            extra={"is_cloud": True, "provider": "azure_speech"},
        )
        model.device = "cloud"
        samples = np.zeros(16000, dtype=np.float32)
        config = MagicMock()
        config.language = "en"

        with patch.object(
            service, "_run_azure_speech_inference", new_callable=AsyncMock
        ) as mock_azure:
            mock_azure.return_value = RawTranscription(
                text="Azure transcribed text",
                language="en-US",
                language_probability=0.95,
            )

            result = await service._run_inference(samples, 16000, model, config)

            mock_azure.assert_called_once()
            assert result.text == "Azure transcribed text"
            assert result.language == "en-US"

    @pytest.mark.asyncio
    async def test_run_inference_unsupported_format_raises(self, service):
        """Test that unsupported format raises error."""
        # Create model with invalid format by mocking
        model = self.create_loaded_model_with_format(AiModelFormat.SAFETENSOR)
        model.format = "UNKNOWN_FORMAT"  # Force invalid format
        samples = np.zeros(16000, dtype=np.float32)
        config = MagicMock()

        with pytest.raises(TranscriptionError, match="Unsupported model format"):
            await service._run_inference(samples, 16000, model, config)


class TestBatchServiceInlineModelLoading:
    """Tests for inline model loading in batch service."""

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    def create_inline_pipeline_config(self) -> PipelineConfig:
        """Create pipeline config with inline model definitions."""
        from stt_v2.pipeline.dto import InlineModelDef

        spec = PipelineSpec(
            version="1.1",
            models=ModelRefs(
                asr=ModelRef(
                    inline=InlineModelDef(
                        hf_model_id="onnx-community/whisper-large-v3-turbo",
                        engine=AiModelFormat.ONNX,
                    )
                ),
                vad=ModelRef(
                    inline=InlineModelDef(
                        hf_model_id="snakers4/silero-vad",
                        engine=AiModelFormat.ONNX,
                        version="main",
                    )
                ),
                denoise=ModelRef(
                    inline=InlineModelDef(
                        hf_model_id="nickolay/rnnoise",
                        engine=AiModelFormat.ONNX,
                    )
                ),
            ),
            preprocessing=PreprocessingConfig(
                target_sample_rate=16000,
                normalize=True,
            ),
            inference=InferenceConfig(),
            postprocessing=PostprocessingConfig(),
        )
        return PipelineConfig(
            id="p-inline",
            tenant_id="t-456",
            slug="inline-pipeline",
            name="Inline Pipeline",
            description="Pipeline with inline model definitions",
            spec=spec,
            tags=["inline", "test"],
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )

    @pytest.mark.asyncio
    async def test_load_models_with_inline_asr(self, service):
        """Test loading inline ASR model definition."""
        pipeline_config = self.create_inline_pipeline_config()

        with (
            patch("stt_v2.transcription.batch_service.get_model_cache") as mock_cache,
            patch("stt_v2.transcription.batch_service.get_model_reader") as mock_reader,
        ):

            mock_model_reader = AsyncMock()
            mock_model_reader.get_models_for_pipeline = AsyncMock(return_value={})
            mock_reader.return_value = mock_model_reader

            mock_model_cache = AsyncMock()
            mock_model_cache.get_or_load_inline = AsyncMock(
                return_value=create_complete_loaded_model()
            )
            mock_cache.return_value = mock_model_cache

            result = await service._load_models(pipeline_config)

            # Should have called get_or_load_inline for ASR
            assert mock_model_cache.get_or_load_inline.call_count >= 1
            assert result["asr"] is not None

    @pytest.mark.asyncio
    async def test_load_models_with_inline_vad_failure(self, service):
        """Test that VAD loading failure doesn't fail the whole pipeline."""
        from stt_v2.pipeline.dto import InlineModelDef

        spec = PipelineSpec(
            version="1.1",
            models=ModelRefs(
                asr=ModelRef(slug="whisper-test"),
                vad=ModelRef(
                    inline=InlineModelDef(
                        hf_model_id="invalid/model",
                        engine=AiModelFormat.ONNX,
                    )
                ),
            ),
            preprocessing=PreprocessingConfig(),
            inference=InferenceConfig(),
            postprocessing=PostprocessingConfig(),
        )
        pipeline_config = PipelineConfig(
            id="p-test",
            tenant_id="t-456",
            slug="test-pipeline",
            name="Test",
            description="Test pipeline",
            spec=spec,
            tags=["test"],
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )

        with (
            patch("stt_v2.transcription.batch_service.get_model_cache") as mock_cache,
            patch("stt_v2.transcription.batch_service.get_model_reader") as mock_reader,
        ):

            mock_model_reader = AsyncMock()
            mock_model_reader.get_models_for_pipeline = AsyncMock(
                return_value={
                    "whisper-test": create_complete_model_config(),
                }
            )
            mock_reader.return_value = mock_model_reader

            mock_model_cache = AsyncMock()
            mock_model_cache.get_or_load = AsyncMock(return_value=create_complete_loaded_model())
            mock_model_cache.get_or_load_inline = AsyncMock(
                side_effect=Exception("Model not found")
            )
            mock_cache.return_value = mock_model_cache

            # Should not raise - VAD is optional
            result = await service._load_models(pipeline_config)

            assert result["asr"] is not None
            assert result["vad"] is None  # Failed to load, set to None

    @pytest.mark.asyncio
    async def test_load_models_asr_not_specified_raises(self, service):
        """Test that missing ASR specification raises error."""
        spec = PipelineSpec(
            version="1.1",
            models=ModelRefs(
                asr=ModelRef(slug=None, inline=None),  # No ASR specified
            ),
            preprocessing=PreprocessingConfig(),
            inference=InferenceConfig(),
            postprocessing=PostprocessingConfig(),
        )
        pipeline_config = PipelineConfig(
            id="p-test",
            tenant_id="t-456",
            slug="test-pipeline",
            name="Test",
            description="Test pipeline",
            spec=spec,
            tags=["test"],
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )

        with (
            patch("stt_v2.transcription.batch_service.get_model_cache") as mock_cache,
            patch("stt_v2.transcription.batch_service.get_model_reader") as mock_reader,
        ):

            mock_reader.return_value = AsyncMock()
            mock_cache.return_value = AsyncMock()

            with pytest.raises(TranscriptionError, match="ASR model.*required"):
                await service._load_models(pipeline_config)


class TestBatchServicePostprocessingSentenceTimestamps:
    """Tests for sentence timestamp extraction."""

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    def test_postprocess_with_sentence_timestamps(self, service):
        """Test extraction of sentence timestamps from segments."""
        raw = RawTranscription(
            text="Hello world. How are you?",
            segments=[
                {"text": "Hello world.", "start": 0.0, "end": 1.5},
                {"text": "How are you?", "start": 1.6, "end": 3.0},
            ],
        )

        config = MagicMock()
        config.lowercase = False
        config.timestamps = MagicMock()
        config.timestamps.word_timestamps = False
        config.timestamps.sentence_timestamps = True

        result = service._postprocess(raw, config, 3.0)

        assert len(result.sentence_timestamps) == 2
        assert result.sentence_timestamps[0].text == "Hello world."
        assert result.sentence_timestamps[0].start_time == 0.0
        assert result.sentence_timestamps[1].text == "How are you?"

    def test_postprocess_preserves_segment_english_text(self, service):
        """Sentence timestamps should include per-segment english_text when present."""
        raw = RawTranscription(
            text="ഹലോ ലോകം. നിങ്ങൾക്ക് സുഖമാണോ?",
            segments=[
                {
                    "text": "ഹലോ ലോകം.",
                    "start": 0.0,
                    "end": 1.5,
                    "english_text": "Hello world.",
                },
                {
                    "text": "നിങ്ങൾക്ക് സുഖമാണോ?",
                    "start": 1.6,
                    "end": 3.0,
                    "english_text": "How are you?",
                },
            ],
        )

        config = MagicMock()
        config.lowercase = False
        config.timestamps = MagicMock()
        config.timestamps.word_timestamps = False
        config.timestamps.sentence_timestamps = True

        result = service._postprocess(raw, config, 3.0)

        assert result.sentence_timestamps[0].english_text == "Hello world."
        assert result.sentence_timestamps[1].english_text == "How are you?"

    def test_postprocess_with_empty_segments(self, service):
        """Test handling of empty segments list."""
        raw = RawTranscription(
            text="Hello world",
            segments=[],
        )

        config = MagicMock()
        config.lowercase = False
        config.timestamps = MagicMock()
        config.timestamps.word_timestamps = False
        config.timestamps.sentence_timestamps = True

        result = service._postprocess(raw, config, 1.0)

        assert result.sentence_timestamps == []


class TestBatchServiceDiarization:
    """Tests for diarization integration in batch service."""

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    def create_diarization_pipeline(self, enabled: bool = True) -> PipelineConfig:
        """Create pipeline with diarization config."""
        spec = PipelineSpec(
            version="1.1",
            models=ModelRefs(asr=ModelRef(slug="whisper-test")),
            preprocessing=PreprocessingConfig(),
            inference=InferenceConfig(),
            postprocessing=PostprocessingConfig(),
            diarization=DiarizationConfig(
                enabled=enabled,
                similarity_threshold=0.7,
                auto_register_speakers=True,
            ),
        )
        return PipelineConfig(
            id="p-diar",
            tenant_id="t-456",
            slug="test-diar-pipeline",
            name="Test Diarization",
            description="Pipeline with diarization",
            spec=spec,
            tags=["test", "diarization"],
            created_at=datetime(2024, 1, 1),
            updated_at=datetime(2024, 1, 2),
        )

    @pytest.mark.asyncio
    async def test_transcribe_runs_diarization_when_enabled(self, service):
        """Test that diarization step runs when enabled and tenant_id provided."""
        pipeline = self.create_diarization_pipeline(enabled=True)
        loaded_model = create_complete_loaded_model()
        audio_bytes = create_valid_wav_audio(duration_seconds=2.0)

        with (
            patch.object(service, "_load_models") as mock_load,
            patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc,
            patch.object(service, "_run_inference") as mock_inference,
            patch.object(service, "_run_diarization") as mock_diar,
            patch.object(service, "_postprocess") as mock_postproc,
        ):

            mock_load.return_value = {"asr": loaded_model, "vad": None, "denoise": None}

            # Complete ProcessedAudio — include all fields production code reads
            mock_preprocessor = AsyncMock()
            mock_preprocessor.process = AsyncMock(
                return_value=ProcessedAudio(
                    samples=np.zeros(32000, dtype=np.float32),
                    sample_rate=16000,
                    duration_seconds=2.0,
                    was_resampled=False,
                    was_normalized=True,
                    vad_applied=False,
                    denoise_applied=False,
                    segments=[],
                )
            )
            mock_preproc.return_value = mock_preprocessor
            mock_inference.return_value = RawTranscription(text="Hello world")
            mock_diar.return_value = {
                "speakers_detected": 2,
                "new_speakers_created": 1,
                "speaker_ids": ["spk-1", "spk-2"],
            }
            mock_postproc.return_value = TranscriptionResult(
                text="Hello world", duration_seconds=2.0
            )

            result = await service.transcribe(
                job_id="j-diar-1",
                audio_bytes=audio_bytes,
                pipeline_config=pipeline,
                tenant_id="t-456",
                consultation_id="c-001",
            )

            mock_diar.assert_called_once()
            assert "diarization" in result.metadata
            assert result.metadata["diarization"]["speakers_detected"] == 2

    @pytest.mark.asyncio
    async def test_transcribe_skips_diarization_when_disabled(self, service):
        """Test that diarization step is skipped when disabled."""
        pipeline = self.create_diarization_pipeline(enabled=False)
        loaded_model = create_complete_loaded_model()
        audio_bytes = create_valid_wav_audio(duration_seconds=2.0)

        with (
            patch.object(service, "_load_models") as mock_load,
            patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc,
            patch.object(service, "_run_inference") as mock_inference,
            patch.object(service, "_run_diarization") as mock_diar,
            patch.object(service, "_postprocess") as mock_postproc,
        ):

            mock_load.return_value = {"asr": loaded_model, "vad": None, "denoise": None}

            mock_preprocessor = AsyncMock()
            mock_preprocessor.process = AsyncMock(
                return_value=ProcessedAudio(
                    samples=np.zeros(32000, dtype=np.float32),
                    sample_rate=16000,
                    duration_seconds=2.0,
                    was_resampled=False,
                    was_normalized=True,
                    vad_applied=False,
                    denoise_applied=False,
                    segments=[],
                )
            )
            mock_preproc.return_value = mock_preprocessor
            mock_inference.return_value = RawTranscription(text="Hello")
            mock_postproc.return_value = TranscriptionResult(text="Hello", duration_seconds=2.0)

            result = await service.transcribe(
                job_id="j-diar-2",
                audio_bytes=audio_bytes,
                pipeline_config=pipeline,
                tenant_id="t-456",
            )

            mock_diar.assert_not_called()
            assert "diarization" not in result.metadata

    @pytest.mark.asyncio
    async def test_transcribe_skips_diarization_when_no_tenant(self, service):
        """Test that diarization step is skipped when no tenant_id."""
        pipeline = self.create_diarization_pipeline(enabled=True)
        loaded_model = create_complete_loaded_model()
        audio_bytes = create_valid_wav_audio(duration_seconds=2.0)

        with (
            patch.object(service, "_load_models") as mock_load,
            patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc,
            patch.object(service, "_run_inference") as mock_inference,
            patch.object(service, "_run_diarization") as mock_diar,
            patch.object(service, "_postprocess") as mock_postproc,
        ):

            mock_load.return_value = {"asr": loaded_model, "vad": None, "denoise": None}

            mock_preprocessor = AsyncMock()
            mock_preprocessor.process = AsyncMock(
                return_value=ProcessedAudio(
                    samples=np.zeros(32000, dtype=np.float32),
                    sample_rate=16000,
                    duration_seconds=2.0,
                    was_resampled=False,
                    was_normalized=True,
                    vad_applied=False,
                    denoise_applied=False,
                    segments=[],
                )
            )
            mock_preproc.return_value = mock_preprocessor
            mock_inference.return_value = RawTranscription(text="Hello")
            mock_postproc.return_value = TranscriptionResult(text="Hello", duration_seconds=2.0)

            result = await service.transcribe(
                job_id="j-diar-3",
                audio_bytes=audio_bytes,
                pipeline_config=pipeline,
                tenant_id=None,
            )

            mock_diar.assert_not_called()
            assert "diarization" not in result.metadata

    @pytest.mark.asyncio
    async def test_transcribe_diarization_failure_nonfatal(self, service):
        """Test that diarization failure doesn't fail the whole transcription."""
        pipeline = self.create_diarization_pipeline(enabled=True)
        loaded_model = create_complete_loaded_model()
        audio_bytes = create_valid_wav_audio(duration_seconds=2.0)

        with (
            patch.object(service, "_load_models") as mock_load,
            patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc,
            patch.object(service, "_run_inference") as mock_inference,
            patch.object(service, "_run_diarization") as mock_diar,
            patch.object(service, "_postprocess") as mock_postproc,
        ):

            mock_load.return_value = {"asr": loaded_model, "vad": None, "denoise": None}

            mock_preprocessor = AsyncMock()
            mock_preprocessor.process = AsyncMock(
                return_value=ProcessedAudio(
                    samples=np.zeros(32000, dtype=np.float32),
                    sample_rate=16000,
                    duration_seconds=2.0,
                    was_resampled=False,
                    was_normalized=True,
                    vad_applied=False,
                    denoise_applied=False,
                    segments=[],
                )
            )
            mock_preproc.return_value = mock_preprocessor
            mock_inference.return_value = RawTranscription(text="Hello")
            mock_diar.side_effect = RuntimeError("Diarization failed!")
            mock_postproc.return_value = TranscriptionResult(text="Hello", duration_seconds=2.0)

            # Should NOT raise
            result = await service.transcribe(
                job_id="j-diar-4",
                audio_bytes=audio_bytes,
                pipeline_config=pipeline,
                tenant_id="t-456",
            )

            assert result.text == "Hello"
            assert "diarization" not in result.metadata


# =============================================================================
# PER-SEGMENT ASR TESTS (TASK-009)
# =============================================================================


class TestPerSegmentInference:
    """Tests for _run_per_segment_inference method."""

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    @pytest.mark.asyncio
    async def test_per_segment_merges_text(self, service):
        """Per-segment ASR should merge text from all segments."""
        from stt_v2.transcription.dto import AudioSegment

        samples = np.zeros(112000, dtype=np.float32)  # 7 seconds at 16kHz
        segments = [
            AudioSegment(start_time=0.0, end_time=2.0, is_speech=True),
            AudioSegment(start_time=5.0, end_time=7.0, is_speech=True),  # gap 3.0s > 2.0 threshold
        ]
        model = create_complete_loaded_model()
        config = MagicMock()

        call_count = 0

        async def mock_inference(samples, sr, model, config, progress_callback=None, prompt=None):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return RawTranscription(
                    text="Hello world", language="en", language_probability=0.95
                )
            return RawTranscription(text="goodbye moon")

        with patch.object(service, "_run_inference", side_effect=mock_inference):
            result = await service._run_per_segment_inference(
                samples, 16000, segments, model, config, job_id="test"
            )

        assert "Hello world" in result.text
        assert "goodbye moon" in result.text
        assert result.language == "en"

    @pytest.mark.asyncio
    async def test_per_segment_records_latencies(self, service):
        """Per-segment ASR should record per-segment latencies."""
        from stt_v2.transcription.dto import AudioSegment

        samples = np.zeros(112000, dtype=np.float32)
        segments = [
            AudioSegment(start_time=0.0, end_time=2.0, is_speech=True),
            AudioSegment(start_time=5.0, end_time=7.0, is_speech=True),
        ]
        model = create_complete_loaded_model()
        config = MagicMock()

        with patch.object(service, "_run_inference", new_callable=AsyncMock) as mock:
            mock.return_value = RawTranscription(text="hello")

            result = await service._run_per_segment_inference(
                samples, 16000, segments, model, config, job_id="test"
            )

        assert isinstance(result.model_output, dict)
        latencies = result.model_output["segment_latencies"]
        assert len(latencies) == 2
        assert latencies[0]["segment_index"] == 0
        assert latencies[0]["inference_time_s"] >= 0  # mock runs instantly, may round to 0
        assert latencies[1]["segment_index"] == 1

    @pytest.mark.asyncio
    async def test_per_segment_offsets_timestamps(self, service):
        """Per-segment ASR should offset word timestamps to global timeline."""
        from stt_v2.transcription.dto import AudioSegment

        # 10 seconds of audio — segment starts at 5.0s, enough room for the slice
        samples = np.zeros(160000, dtype=np.float32)
        segments = [
            AudioSegment(start_time=5.0, end_time=7.0, is_speech=True),
        ]
        model = create_complete_loaded_model()
        config = MagicMock()

        with patch.object(service, "_run_inference", new_callable=AsyncMock) as mock:
            mock.return_value = RawTranscription(
                text="hello",
                word_timestamps=[
                    {"word": "hello", "start": 0.0, "end": 0.5, "start_time": 0.0, "end_time": 0.5},
                ],
                segments=[
                    {"text": "hello", "start": 0.0, "end": 0.5},
                ],
            )

            result = await service._run_per_segment_inference(
                samples, 16000, segments, model, config, job_id="test"
            )

        # Word timestamps should be offset by segment start_time (5.0)
        assert len(result.word_timestamps) == 1
        assert result.word_timestamps[0]["start"] == 5.0
        assert result.word_timestamps[0]["end"] == 5.5
        assert result.segments[0]["start"] == 5.0

    @pytest.mark.asyncio
    async def test_per_segment_skips_short_segments(self, service):
        """Segments shorter than 0.25s should be skipped."""
        from stt_v2.transcription.dto import AudioSegment

        samples = np.zeros(80000, dtype=np.float32)
        segments = [
            AudioSegment(start_time=0.0, end_time=0.1, is_speech=True),  # Too short
            AudioSegment(start_time=1.0, end_time=3.0, is_speech=True),  # OK
        ]
        model = create_complete_loaded_model()
        config = MagicMock()

        with patch.object(service, "_run_inference", new_callable=AsyncMock) as mock:
            mock.return_value = RawTranscription(text="hello")

            _result = await service._run_per_segment_inference(
                samples, 16000, segments, model, config, job_id="test"
            )

        # Only 1 segment should be processed (the short one skipped)
        assert mock.call_count == 1

    @pytest.mark.asyncio
    async def test_per_segment_handles_inference_failure(self, service):
        """When one segment fails, others should still process."""
        from stt_v2.transcription.dto import AudioSegment

        samples = np.zeros(112000, dtype=np.float32)
        segments = [
            AudioSegment(start_time=0.0, end_time=2.0, is_speech=True),
            AudioSegment(start_time=5.0, end_time=7.0, is_speech=True),
        ]
        model = create_complete_loaded_model()
        config = MagicMock()

        call_count = 0

        async def mock_inference(samples, sr, model, config, progress_callback=None, prompt=None):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("Inference failed")
            return RawTranscription(text="hello")

        with patch.object(service, "_run_inference", side_effect=mock_inference):
            result = await service._run_per_segment_inference(
                samples, 16000, segments, model, config, job_id="test"
            )

        assert result.text == "hello"
        assert len(result.model_output["segment_latencies"]) == 1


# =============================================================================
# TIMING METRICS IN TRANSCRIBE TESTS (TASK-009)
# =============================================================================


class TestTranscribeTimingMetrics:
    """Tests for timing metrics in BatchTranscriptionService.transcribe()."""

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    @pytest.mark.asyncio
    async def test_transcribe_includes_timing_in_metadata(self, service):
        """Transcription result should include timing metrics."""
        from stt_v2.transcription.dto import TimingMetrics

        pipeline = create_complete_pipeline_config()
        loaded_model = create_complete_loaded_model()
        audio_bytes = create_valid_wav_audio(duration_seconds=2.0)

        with (
            patch.object(service, "_load_models") as mock_load,
            patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc,
            patch.object(service, "_run_inference") as mock_inference,
            patch.object(service, "_postprocess") as mock_postproc,
        ):

            mock_load.return_value = {"asr": loaded_model, "vad": None, "denoise": None}

            mock_preprocessor = AsyncMock()
            mock_preprocessor.process = AsyncMock(
                return_value=ProcessedAudio(
                    samples=np.zeros(32000, dtype=np.float32),
                    sample_rate=16000,
                    duration_seconds=2.0,
                )
            )
            mock_preproc.return_value = mock_preprocessor
            mock_inference.return_value = RawTranscription(text="Hello")
            mock_postproc.return_value = TranscriptionResult(
                text="Hello",
                duration_seconds=2.0,
            )

            result = await service.transcribe(
                job_id="j-timing-1",
                audio_bytes=audio_bytes,
                pipeline_config=pipeline,
            )

        assert "timing" in result.metadata
        timing = result.metadata["timing"]
        assert isinstance(timing, TimingMetrics)
        assert timing.model_loading_seconds > 0 or timing.model_loading_seconds == 0
        assert timing.preprocessing_seconds >= 0
        assert timing.inference_seconds >= 0
        assert timing.total_seconds > 0

    @pytest.mark.asyncio
    async def test_transcribe_uses_per_segment_when_vad_applied(self, service):
        """When VAD produces segments, should use per-segment ASR."""
        from stt_v2.transcription.dto import AudioSegment as DtoAudioSegment

        pipeline = create_complete_pipeline_config()
        loaded_model = create_complete_loaded_model()
        audio_bytes = create_valid_wav_audio(duration_seconds=2.0)

        with (
            patch.object(service, "_load_models") as mock_load,
            patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc,
            patch.object(service, "_run_per_segment_inference") as mock_per_seg,
            patch.object(service, "_run_inference") as mock_full,
            patch.object(service, "_postprocess") as mock_postproc,
        ):

            mock_load.return_value = {"asr": loaded_model, "vad": None, "denoise": None}

            mock_preprocessor = AsyncMock()
            mock_preprocessor.process = AsyncMock(
                return_value=ProcessedAudio(
                    samples=np.zeros(32000, dtype=np.float32),
                    sample_rate=16000,
                    duration_seconds=2.0,
                    vad_applied=True,
                    segments=[DtoAudioSegment(0.0, 1.0, is_speech=True)],
                )
            )
            mock_preproc.return_value = mock_preprocessor
            mock_per_seg.return_value = RawTranscription(text="Per-segment")
            mock_postproc.return_value = TranscriptionResult(
                text="Per-segment",
                duration_seconds=2.0,
            )

            _result = await service.transcribe(
                job_id="j-vad-1",
                audio_bytes=audio_bytes,
                pipeline_config=pipeline,
            )

        mock_per_seg.assert_called_once()
        mock_full.assert_not_called()

    @pytest.mark.asyncio
    async def test_transcribe_uses_full_audio_when_no_vad(self, service):
        """When VAD is not applied, should use full-audio ASR."""
        pipeline = create_complete_pipeline_config()
        loaded_model = create_complete_loaded_model()
        audio_bytes = create_valid_wav_audio(duration_seconds=2.0)

        with (
            patch.object(service, "_load_models") as mock_load,
            patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc,
            patch.object(service, "_run_per_segment_inference") as mock_per_seg,
            patch.object(service, "_run_inference") as mock_full,
            patch.object(service, "_postprocess") as mock_postproc,
        ):

            mock_load.return_value = {"asr": loaded_model, "vad": None, "denoise": None}

            mock_preprocessor = AsyncMock()
            mock_preprocessor.process = AsyncMock(
                return_value=ProcessedAudio(
                    samples=np.zeros(32000, dtype=np.float32),
                    sample_rate=16000,
                    duration_seconds=2.0,
                    vad_applied=False,
                )
            )
            mock_preproc.return_value = mock_preprocessor
            mock_full.return_value = RawTranscription(text="Full audio")
            mock_postproc.return_value = TranscriptionResult(
                text="Full audio",
                duration_seconds=2.0,
            )

            _result = await service.transcribe(
                job_id="j-full-1",
                audio_bytes=audio_bytes,
                pipeline_config=pipeline,
            )

        mock_full.assert_called_once()
        mock_per_seg.assert_not_called()


# =============================================================================
# PER-SEGMENT ASR EDGE CASES (TASK-009)
# =============================================================================


class TestPerSegmentInferenceEdgeCases:
    """Edge cases for _run_per_segment_inference behaviour.

    These verify real branching logic in _run_per_segment_inference, NOT mock
    wiring.  _run_inference is the only boundary mock (the actual model).
    """

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    @pytest.mark.asyncio
    async def test_empty_segments_list_returns_empty_transcription(self, service):
        """When no segments are provided, should return empty text."""

        samples = np.zeros(32000, dtype=np.float32)
        model = create_complete_loaded_model()
        config = MagicMock()

        with patch.object(service, "_run_inference", new_callable=AsyncMock) as mock:
            result = await service._run_per_segment_inference(
                samples, 16000, [], model, config, job_id="empty"
            )

        # No segments → inference never called, text is empty
        mock.assert_not_called()
        assert result.text == ""
        assert result.segments == []
        assert result.word_timestamps == []
        assert result.model_output["segment_latencies"] == []

    @pytest.mark.asyncio
    async def test_all_non_speech_segments_skipped(self, service):
        """Segments with is_speech=False should all be skipped."""
        from stt_v2.transcription.dto import AudioSegment

        samples = np.zeros(80000, dtype=np.float32)
        segments = [
            AudioSegment(start_time=0.0, end_time=2.0, is_speech=False),
            AudioSegment(start_time=3.0, end_time=5.0, is_speech=False),
        ]
        model = create_complete_loaded_model()
        config = MagicMock()

        with patch.object(service, "_run_inference", new_callable=AsyncMock) as mock:
            result = await service._run_per_segment_inference(
                samples, 16000, segments, model, config, job_id="silence"
            )

        mock.assert_not_called()
        assert result.text == ""

    @pytest.mark.asyncio
    async def test_all_segments_too_short(self, service):
        """When every segment is below the 0.25s minimum, all are skipped."""
        from stt_v2.transcription.dto import AudioSegment

        samples = np.zeros(51200, dtype=np.float32)  # 3.2s at 16kHz
        segments = [
            AudioSegment(start_time=0.0, end_time=0.1, is_speech=True),
            AudioSegment(start_time=3.0, end_time=3.1, is_speech=True),  # gap 2.9s > 2.0 threshold
        ]
        model = create_complete_loaded_model()
        config = MagicMock()

        with patch.object(service, "_run_inference", new_callable=AsyncMock) as mock:
            result = await service._run_per_segment_inference(
                samples, 16000, segments, model, config, job_id="short"
            )

        mock.assert_not_called()
        assert result.text == ""

    @pytest.mark.asyncio
    async def test_multiple_segments_text_ordering_preserved(self, service):
        """Merged text should preserve the temporal order of segments."""
        from stt_v2.transcription.dto import AudioSegment

        samples = np.zeros(192000, dtype=np.float32)  # 12s
        segments = [
            AudioSegment(start_time=0.0, end_time=2.0, is_speech=True),
            AudioSegment(start_time=5.0, end_time=7.0, is_speech=True),  # gap 3.0s
            AudioSegment(start_time=10.0, end_time=12.0, is_speech=True),  # gap 3.0s
        ]
        model = create_complete_loaded_model()
        config = MagicMock()

        call_idx = 0
        texts = ["Alpha", "Beta", "Gamma"]

        async def ordered_inference(samples, sr, model, config, progress_callback=None, prompt=None):
            nonlocal call_idx
            text = texts[call_idx]
            call_idx += 1
            return RawTranscription(text=text)

        with patch.object(service, "_run_inference", side_effect=ordered_inference):
            result = await service._run_per_segment_inference(
                samples, 16000, segments, model, config, job_id="order"
            )

        # Text must be in segment temporal order
        assert result.text == "Alpha Beta Gamma"

    @pytest.mark.asyncio
    async def test_per_segment_latency_structure_complete(self, service):
        """Each latency entry must have all required fields (Anti-Pattern #4 check)."""
        from stt_v2.transcription.dto import AudioSegment

        samples = np.zeros(48000, dtype=np.float32)  # 3s
        segments = [
            AudioSegment(start_time=0.0, end_time=1.5, is_speech=True),
        ]
        model = create_complete_loaded_model()
        config = MagicMock()

        with patch.object(service, "_run_inference", new_callable=AsyncMock) as mock:
            mock.return_value = RawTranscription(text="hello")

            result = await service._run_per_segment_inference(
                samples, 16000, segments, model, config, job_id="struct"
            )

        latencies = result.model_output["segment_latencies"]
        assert len(latencies) == 1

        # Verify all expected fields exist and have correct types
        entry = latencies[0]
        assert "segment_index" in entry
        assert "start_time" in entry
        assert "end_time" in entry
        assert "duration_s" in entry
        assert "inference_time_s" in entry
        assert isinstance(entry["segment_index"], int)
        assert isinstance(entry["start_time"], float)
        assert isinstance(entry["end_time"], float)
        assert isinstance(entry["duration_s"], float)
        assert isinstance(entry["inference_time_s"], float)
        assert entry["start_time"] == 0.0
        assert entry["end_time"] == 1.5
        assert entry["duration_s"] == pytest.approx(1.5, abs=0.01)


# =============================================================================
# TIMING METRICS EDGE CASES (TASK-009)
# =============================================================================


class TestTranscribeTimingEdgeCases:
    """Edge cases for timing instrumentation in transcribe()."""

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    @pytest.mark.asyncio
    async def test_timing_total_gte_sum_of_parts(self, service):
        """Total time must be >= sum of individual steps (no negative slack)."""

        pipeline = create_complete_pipeline_config()
        loaded_model = create_complete_loaded_model()
        audio_bytes = create_valid_wav_audio(duration_seconds=1.0)

        with (
            patch.object(service, "_load_models") as mock_load,
            patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc,
            patch.object(service, "_run_inference") as mock_inference,
            patch.object(service, "_postprocess") as mock_postproc,
        ):

            mock_load.return_value = {"asr": loaded_model, "vad": None, "denoise": None}

            mock_preprocessor = AsyncMock()
            mock_preprocessor.process = AsyncMock(
                return_value=ProcessedAudio(
                    samples=np.zeros(16000, dtype=np.float32),
                    sample_rate=16000,
                    duration_seconds=1.0,
                    was_resampled=False,
                    was_normalized=True,
                    vad_applied=False,
                    denoise_applied=False,
                    segments=[],
                )
            )
            mock_preproc.return_value = mock_preprocessor
            mock_inference.return_value = RawTranscription(text="Hi")
            mock_postproc.return_value = TranscriptionResult(text="Hi", duration_seconds=1.0)

            result = await service.transcribe(
                job_id="j-timing-edge",
                audio_bytes=audio_bytes,
                pipeline_config=pipeline,
            )

        timing = result.metadata["timing"]
        step_sum = (
            timing.model_loading_seconds
            + timing.preprocessing_seconds
            + timing.inference_seconds
            + timing.diarization_seconds
            + timing.postprocessing_seconds
        )
        assert (
            timing.total_seconds >= step_sum - 0.001
        ), f"Total {timing.total_seconds:.4f}s < step sum {step_sum:.4f}s"

    @pytest.mark.asyncio
    async def test_ttfw_gte_model_loading_plus_preprocessing_plus_inference(self, service):
        """TTFW must be >= model_loading + preprocessing + inference time."""

        pipeline = create_complete_pipeline_config()
        loaded_model = create_complete_loaded_model()
        audio_bytes = create_valid_wav_audio(duration_seconds=1.0)

        with (
            patch.object(service, "_load_models") as mock_load,
            patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc,
            patch.object(service, "_run_inference") as mock_inference,
            patch.object(service, "_postprocess") as mock_postproc,
        ):

            mock_load.return_value = {"asr": loaded_model, "vad": None, "denoise": None}

            mock_preprocessor = AsyncMock()
            mock_preprocessor.process = AsyncMock(
                return_value=ProcessedAudio(
                    samples=np.zeros(16000, dtype=np.float32),
                    sample_rate=16000,
                    duration_seconds=1.0,
                    was_resampled=False,
                    was_normalized=True,
                    vad_applied=False,
                    denoise_applied=False,
                    segments=[],
                )
            )
            mock_preproc.return_value = mock_preprocessor
            mock_inference.return_value = RawTranscription(text="word")
            mock_postproc.return_value = TranscriptionResult(text="word", duration_seconds=1.0)

            result = await service.transcribe(
                job_id="j-ttfw-edge",
                audio_bytes=audio_bytes,
                pipeline_config=pipeline,
            )

        timing = result.metadata["timing"]
        # TTFW is measured from pipeline_start to after inference completes
        min_ttfw = (
            timing.model_loading_seconds + timing.preprocessing_seconds + timing.inference_seconds
        )
        assert timing.ttfw_seconds >= min_ttfw - 0.001, (
            f"TTFW {timing.ttfw_seconds:.4f}s < " f"model+preprocess+inference {min_ttfw:.4f}s"
        )

    @pytest.mark.asyncio
    async def test_vad_applied_with_empty_segments_falls_back_to_full_inference(self, service):
        """When VAD is applied but returns zero segments, should use full-audio ASR."""

        pipeline = create_complete_pipeline_config()
        loaded_model = create_complete_loaded_model()
        audio_bytes = create_valid_wav_audio(duration_seconds=2.0)

        with (
            patch.object(service, "_load_models") as mock_load,
            patch("stt_v2.transcription.batch_service.get_preprocessor") as mock_preproc,
            patch.object(service, "_run_per_segment_inference") as mock_per_seg,
            patch.object(service, "_run_inference") as mock_full,
            patch.object(service, "_postprocess") as mock_postproc,
        ):

            mock_load.return_value = {"asr": loaded_model, "vad": None, "denoise": None}

            # VAD applied but found NO speech segments
            mock_preprocessor = AsyncMock()
            mock_preprocessor.process = AsyncMock(
                return_value=ProcessedAudio(
                    samples=np.zeros(32000, dtype=np.float32),
                    sample_rate=16000,
                    duration_seconds=2.0,
                    was_resampled=False,
                    was_normalized=True,
                    vad_applied=True,
                    denoise_applied=False,
                    segments=[],  # empty — no speech found
                )
            )
            mock_preproc.return_value = mock_preprocessor
            mock_full.return_value = RawTranscription(text="Fallback")
            mock_postproc.return_value = TranscriptionResult(
                text="Fallback",
                duration_seconds=2.0,
            )

            _result = await service.transcribe(
                job_id="j-empty-vad",
                audio_bytes=audio_bytes,
                pipeline_config=pipeline,
            )

        # vad_applied=True but segments=[] → condition is False → full inference
        mock_full.assert_called_once()
        mock_per_seg.assert_not_called()


# =============================================================================
# TASK-011: WHISPER OFFSET NORMALISATION TESTS
# =============================================================================


class TestNormalizeWhisperOffsets:
    """Tests for _normalize_whisper_offsets static method.

    Verifies correct conversion from Whisper's ``{"timestamp": (start, end)}``
    tuple format to the standard ``{"start", "end", "start_time", "end_time"}``
    dict format expected by ``_postprocess()``.
    """

    def test_converts_tuple_format(self):
        """Standard Whisper offset tuples are unpacked correctly."""
        offsets = [
            {"text": " Hello", "timestamp": (0.0, 1.5)},
            {"text": " world", "timestamp": (1.6, 2.8)},
        ]
        result = BatchTranscriptionService._normalize_whisper_offsets(offsets)

        assert len(result) == 2
        assert result[0]["text"] == "Hello"
        assert result[0]["word"] == "Hello"
        assert result[0]["start"] == 0.0
        assert result[0]["end"] == 1.5
        assert result[0]["confidence"] == 1.0

        assert result[1]["start"] == 1.6
        assert result[1]["end"] == 2.8

    def test_handles_none_timestamps(self):
        """Whisper sometimes returns None for the last chunk boundary."""
        offsets = [
            {"text": " Hello", "timestamp": (0.0, None)},
            {"text": " end", "timestamp": (None, None)},
        ]
        result = BatchTranscriptionService._normalize_whisper_offsets(offsets)

        assert result[0]["start"] == 0.0
        # None end defaults to start
        assert result[0]["end"] == 0.0

        # Both None default to 0.0
        assert result[1]["start"] == 0.0
        assert result[1]["end"] == 0.0

    def test_applies_time_offset(self):
        """time_offset is added to all timestamps (for chunk merging)."""
        offsets = [
            {"text": " Hello", "timestamp": (0.0, 1.0)},
            {"text": " world", "timestamp": (1.5, 2.5)},
        ]
        result = BatchTranscriptionService._normalize_whisper_offsets(
            offsets,
            time_offset=12.5,
        )

        assert result[0]["start"] == 12.5
        assert result[0]["end"] == 13.5

        assert result[1]["start"] == 14.0
        assert result[1]["end"] == 15.0

    def test_empty_offsets(self):
        """Empty offset list returns empty list."""
        result = BatchTranscriptionService._normalize_whisper_offsets([])
        assert result == []

    def test_missing_timestamp_key(self):
        """Entry without 'timestamp' key defaults to (0.0, 0.0)."""
        offsets = [{"text": " Hello"}]
        result = BatchTranscriptionService._normalize_whisper_offsets(offsets)

        assert result[0]["start"] == 0.0
        assert result[0]["end"] == 0.0

    def test_list_format_timestamp(self):
        """Timestamps as lists (not tuples) are also handled."""
        offsets = [{"text": " Hello", "timestamp": [1.0, 2.0]}]
        result = BatchTranscriptionService._normalize_whisper_offsets(offsets)

        assert result[0]["start"] == 1.0
        assert result[0]["end"] == 2.0


# =============================================================================
# TASK-011: CHUNKED OPTIMUM INFERENCE TESTS
# =============================================================================


class TestOptimumOnnxInference:
    """Tests for _run_optimum_onnx_inference with manual chunking.

    Verifies:
    - Short audio uses single-pass path
    - Long audio uses chunked path with correct merging
    - Text and timestamps are correctly extracted
    - Progress callback is fired
    - Missing processor raises TranscriptionError
    - Language is passed in generate_kwargs
    """

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    def _create_optimum_model(
        self,
        decode_offsets=None,
        decoded_text="Hello world",
        fmt=AiModelFormat.ONNX_OPTIMUM,
    ) -> LoadedModel:
        """Create a mock loaded model with Optimum markers."""
        mock_model = MagicMock()
        mock_processor = MagicMock()

        mock_generated = MagicMock(name="generated_ids")
        mock_model.generate = MagicMock(return_value=mock_generated)

        mock_processor.return_value = {"input_features": MagicMock(name="input_features")}
        mock_processor.batch_decode = MagicMock(return_value=[decoded_text])
        mock_processor.decode = MagicMock(
            return_value={
                "offsets": decode_offsets or [],
            }
        )

        return LoadedModel(
            model_id="m-optimum-test",
            model_slug="optimum-test",
            model=mock_model,
            processor=mock_processor,
            tokenizer=mock_processor,
            format=fmt,
            memory_mb=760,
            device="cpu",
            loaded_at=datetime.utcnow(),
            extra={"optimum": True},
        )

    @pytest.mark.asyncio
    async def test_short_audio_single_pass(self, service):
        """Audio shorter than chunk_length_s should use single-pass path."""
        model = self._create_optimum_model(decoded_text="This is a test.")
        samples = np.zeros(160000, dtype=np.float32)
        config = MagicMock()
        config.language = "en"
        config.code_switching = False
        config.beam_size = None

        with (
            patch.dict(sys.modules, {"torch": _make_mock_torch()}),
            patch("stt_v2.transcription.batch_service.get_settings") as ms,
        ):
            ms.return_value = MagicMock(
                transcription_chunk_length_s=15,
                transcription_stride_length_s="4,2",
            )
            result = await service._run_optimum_onnx_inference(
                samples,
                16000,
                model,
                config,
            )

        assert result.text == "This is a test."
        model.model.generate.assert_called_once()

    @pytest.mark.asyncio
    async def test_long_audio_uses_chunked_path(self, service):
        """Audio longer than chunk_length_s should use chunked path."""
        model = self._create_optimum_model(decoded_text="chunk text")
        samples = np.zeros(960000, dtype=np.float32)
        config = MagicMock()
        config.language = "en"
        config.code_switching = False
        config.beam_size = None

        with (
            patch.dict(sys.modules, {"torch": _make_mock_torch()}),
            patch("stt_v2.transcription.batch_service.get_settings") as ms,
        ):
            ms.return_value = MagicMock(
                transcription_chunk_length_s=15,
                transcription_stride_length_s="4,2",
            )
            result = await service._run_optimum_onnx_inference(
                samples,
                16000,
                model,
                config,
            )

        assert model.model.generate.call_count >= 2
        assert "chunk text" in result.text

    @pytest.mark.asyncio
    async def test_extracts_word_timestamps(self, service):
        """Word timestamps should be proportionally distributed over audio."""
        model = self._create_optimum_model(decoded_text="Hello world")
        samples = np.zeros(48000, dtype=np.float32)
        config = MagicMock()
        config.language = None
        config.code_switching = False
        config.beam_size = None

        with (
            patch.dict(sys.modules, {"torch": _make_mock_torch()}),
            patch("stt_v2.transcription.batch_service.get_settings") as ms,
        ):
            ms.return_value = MagicMock(
                transcription_chunk_length_s=15,
                transcription_stride_length_s="4,2",
            )
            result = await service._run_optimum_onnx_inference(
                samples,
                16000,
                model,
                config,
            )

        assert len(result.word_timestamps) == 2
        assert result.word_timestamps[0]["word"] == "Hello"
        assert result.word_timestamps[0]["start"] == 0.0
        assert result.word_timestamps[0]["end"] == 1.5
        assert result.word_timestamps[1]["word"] == "world"
        assert result.word_timestamps[1]["start"] == 1.5
        assert result.word_timestamps[1]["end"] == 3.0

    @pytest.mark.asyncio
    async def test_chunked_timestamps_are_global(self, service):
        """Chunked timestamps should reflect global audio position."""
        model = MagicMock(spec=LoadedModel)
        model.format = AiModelFormat.ONNX_OPTIMUM
        model.device = "cpu"
        model.extra = {"optimum": True}

        chunk_counter = [0]

        def mock_batch_decode(ids, **kwargs):
            chunk_counter[0] += 1
            return [f"chunk number {chunk_counter[0]} text"]

        processor = MagicMock()
        processor.return_value = {"input_features": MagicMock(name="input_features")}
        processor.batch_decode.side_effect = mock_batch_decode
        processor.decode.return_value = {"offsets": []}
        model.processor = processor
        model.model = MagicMock()
        model.model.generate.return_value = MagicMock(name="generated_ids")

        samples = np.zeros(1040000, dtype=np.float32)
        config = MagicMock()
        config.language = "en"
        config.code_switching = False
        config.beam_size = None

        with (
            patch.dict(sys.modules, {"torch": _make_mock_torch()}),
            patch("stt_v2.transcription.batch_service.get_settings") as ms,
        ):
            ms.return_value = MagicMock(
                transcription_chunk_length_s=15,
                transcription_stride_length_s="4,2",
            )
            result = await service._run_optimum_onnx_inference(
                samples,
                16000,
                model,
                config,
            )

        assert result.word_timestamps[0]["start"] == 0.0
        assert len(result.segments) >= 2
        for i in range(1, len(result.segments)):
            assert result.segments[i]["start"] > result.segments[i - 1]["start"]

    @pytest.mark.asyncio
    async def test_fires_progress(self, service):
        """Progress callback should be called with 1.0 on completion."""
        model = self._create_optimum_model()
        samples = np.zeros(160000, dtype=np.float32)
        config = MagicMock()
        config.language = "en"
        config.code_switching = False
        config.beam_size = None

        progress_values = []

        with (
            patch.dict(sys.modules, {"torch": _make_mock_torch()}),
            patch("stt_v2.transcription.batch_service.get_settings") as ms,
        ):
            ms.return_value = MagicMock(
                transcription_chunk_length_s=15,
                transcription_stride_length_s="4,2",
            )
            await service._run_optimum_onnx_inference(
                samples,
                16000,
                model,
                config,
                progress_callback=lambda p: progress_values.append(p),
            )

        assert 1.0 in progress_values

    @pytest.mark.asyncio
    async def test_missing_processor_raises_error(self, service):
        """Should raise TranscriptionError when processor is None."""
        from stt_v2.core.exceptions import TranscriptionError as TE

        model = LoadedModel(
            model_id="m-bad",
            model_slug="bad",
            model=MagicMock(),
            processor=None,
            format=AiModelFormat.ONNX_OPTIMUM,
            memory_mb=100,
            device="cpu",
            loaded_at=datetime.utcnow(),
            extra={"optimum": True},
        )
        samples = np.zeros(16000, dtype=np.float32)
        config = MagicMock()

        with (
            patch.dict(sys.modules, {"torch": _make_mock_torch()}),
            pytest.raises(TE, match="requires a processor"),
        ):
            await service._run_optimum_onnx_inference(
                samples,
                16000,
                model,
                config,
            )

    @pytest.mark.asyncio
    async def test_passes_language(self, service):
        """Language should be passed in generate_kwargs."""
        model = self._create_optimum_model()
        samples = np.zeros(16000, dtype=np.float32)
        config = MagicMock()
        config.language = "fr"
        config.code_switching = False
        config.beam_size = None

        with (
            patch.dict(sys.modules, {"torch": _make_mock_torch()}),
            patch("stt_v2.transcription.batch_service.get_settings") as ms,
        ):
            ms.return_value = MagicMock(
                transcription_chunk_length_s=15,
                transcription_stride_length_s="4,2",
            )
            await service._run_optimum_onnx_inference(
                samples,
                16000,
                model,
                config,
            )

        call_kwargs = model.model.generate.call_args[1]
        assert call_kwargs["language"] == "fr"
        assert call_kwargs["task"] == "transcribe"
        assert call_kwargs["return_timestamps"] is False

    @pytest.mark.asyncio
    async def test_chunked_produces_segments(self, service):
        """Each chunk should produce a segment with text, start, end."""
        model = MagicMock(spec=LoadedModel)
        model.format = AiModelFormat.ONNX_OPTIMUM
        model.device = "cpu"
        model.extra = {"optimum": True}

        chunk_counter = [0]

        def mock_batch_decode(ids, **kwargs):
            chunk_counter[0] += 1
            return [f"Some unique text chunk {chunk_counter[0]}"]

        processor = MagicMock()
        processor.return_value = {"input_features": MagicMock(name="input_features")}
        processor.batch_decode.side_effect = mock_batch_decode
        processor.decode.return_value = {"offsets": []}
        model.processor = processor
        model.model = MagicMock()
        model.model.generate.return_value = MagicMock(name="generated_ids")

        samples = np.zeros(1040000, dtype=np.float32)
        config = MagicMock()
        config.language = "en"
        config.code_switching = False
        config.beam_size = None

        with (
            patch.dict(sys.modules, {"torch": _make_mock_torch()}),
            patch("stt_v2.transcription.batch_service.get_settings") as ms,
        ):
            ms.return_value = MagicMock(
                transcription_chunk_length_s=15,
                transcription_stride_length_s="4,2",
            )
            result = await service._run_optimum_onnx_inference(
                samples,
                16000,
                model,
                config,
            )

        assert len(result.segments) >= 2
        for seg in result.segments:
            assert "text" in seg
            assert "start" in seg
            assert "end" in seg
            assert seg["end"] > seg["start"]


# =============================================================================
# CHUNK OVERLAP DE-DUPLICATION TESTS
# =============================================================================


class TestDedupOverlap:
    """Tests for BatchTranscriptionService._dedup_overlap."""

    def test_no_overlap(self):
        """Non-overlapping texts are returned unchanged."""
        result = BatchTranscriptionService._dedup_overlap(
            "The quick brown fox", "jumped over the lazy dog"
        )
        assert result == "jumped over the lazy dog"

    def test_exact_overlap(self):
        """Overlapping suffix/prefix is removed."""
        result = BatchTranscriptionService._dedup_overlap(
            "The quick brown fox", "brown fox jumped over"
        )
        assert result == "jumped over"

    def test_single_word_overlap(self):
        """Single word overlap is detected."""
        result = BatchTranscriptionService._dedup_overlap("Hello world", "world peace")
        assert result == "peace"

    def test_case_insensitive_overlap(self):
        """Overlap matching is case-insensitive."""
        result = BatchTranscriptionService._dedup_overlap(
            "The Quick Brown Fox", "the quick brown fox jumped"
        )
        assert result == "jumped"

    def test_punctuation_insensitive_overlap(self):
        """Trailing punctuation is ignored for matching."""
        result = BatchTranscriptionService._dedup_overlap("Hello, world.", "world peace")
        assert result == "peace"

    def test_empty_previous(self):
        """Empty previous text returns current unchanged."""
        result = BatchTranscriptionService._dedup_overlap("", "Hello world")
        assert result == "Hello world"

    def test_empty_current(self):
        """Empty current text returns empty."""
        result = BatchTranscriptionService._dedup_overlap("Hello world", "")
        assert result == ""

    def test_both_empty(self):
        """Both empty returns empty."""
        result = BatchTranscriptionService._dedup_overlap("", "")
        assert result == ""

    def test_max_overlap_words_respected(self):
        """Only the tail/head within max_overlap_words is checked."""
        # Build texts where overlap is beyond the max window
        long_prev = " ".join([f"word{i}" for i in range(20)])
        # Overlap with the first 3 words of prev, but max_overlap is 2
        current = "word0 word1 word2 new stuff"
        result = BatchTranscriptionService._dedup_overlap(long_prev, current, max_overlap_words=2)
        # word0 word1 are NOT in the last 2 words of prev, so no dedup
        assert result == current

    def test_multi_word_overlap(self):
        """Multi-word overlap at boundary."""
        result = BatchTranscriptionService._dedup_overlap(
            "and so I thought I should get it checked out",
            "I should get it checked out Okay so when did",
        )
        assert result == "Okay so when did"

    def test_no_false_positive(self):
        """Partial word matches should not trigger dedup."""
        result = BatchTranscriptionService._dedup_overlap("I am running", "running late today")
        assert result == "late today"


# =============================================================================
# CHUNK CALLBACK AND TTFW TESTS
# =============================================================================


class TestChunkCallbackAndTTFW:
    """Tests for chunk_callback emission and TTFW measurement."""

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    def _create_optimum_model(self, decoded_text: str = "hello world"):
        """Create a mock Optimum ONNX model."""
        model = MagicMock(spec=LoadedModel)
        model.format = AiModelFormat.ONNX_OPTIMUM
        model.device = "cpu"
        model.extra = {"optimum": True}

        processor = MagicMock()
        processor.return_value = {"input_features": MagicMock(name="input_features")}
        processor.batch_decode.return_value = [decoded_text]
        processor.decode.return_value = {"offsets": []}
        model.processor = processor

        model.model = MagicMock()
        model.model.generate.return_value = MagicMock(name="generated_ids")

        return model

    @pytest.mark.asyncio
    async def test_chunk_callback_is_called(self, service):
        """chunk_callback should be called for each chunk."""
        from stt_v2.transcription.dto import ChunkTranscriptionResult

        model = self._create_optimum_model(decoded_text="hello world")
        samples = np.zeros(720000, dtype=np.float32)
        config = MagicMock()
        config.language = "en"
        config.code_switching = False
        config.beam_size = None
        chunks_received: list[ChunkTranscriptionResult] = []

        with (
            patch.dict(sys.modules, {"torch": _make_mock_torch()}),
            patch("stt_v2.transcription.batch_service.get_settings") as ms,
        ):
            ms.return_value = MagicMock(
                transcription_chunk_length_s=15,
                transcription_stride_length_s="4,2",
            )
            await service._run_optimum_onnx_inference(
                samples,
                16000,
                model,
                config,
                chunk_callback=lambda c: chunks_received.append(c),
            )

        assert len(chunks_received) >= 2
        assert chunks_received[-1].is_final is True
        for i, c in enumerate(chunks_received):
            assert c.chunk_index == i

    @pytest.mark.asyncio
    async def test_first_word_hook_fires_on_first_text(self, service):
        """first_word_hook should fire exactly once on first non-empty text."""
        model = self._create_optimum_model(decoded_text="hello")
        samples = np.zeros(720000, dtype=np.float32)
        config = MagicMock()
        config.language = None
        config.code_switching = False
        config.beam_size = None

        hook_calls: list[bool] = []

        with (
            patch.dict(sys.modules, {"torch": _make_mock_torch()}),
            patch("stt_v2.transcription.batch_service.get_settings") as ms,
        ):
            ms.return_value = MagicMock(
                transcription_chunk_length_s=15,
                transcription_stride_length_s="4,2",
            )
            await service._run_optimum_onnx_inference(
                samples,
                16000,
                model,
                config,
                first_word_hook=lambda: hook_calls.append(True),
            )

        assert len(hook_calls) == 1

    @pytest.mark.asyncio
    async def test_single_pass_fires_chunk_callback(self, service):
        """Short audio (single-pass) should still fire chunk_callback."""
        from stt_v2.transcription.dto import ChunkTranscriptionResult

        model = self._create_optimum_model(decoded_text="short audio")
        samples = np.zeros(160000, dtype=np.float32)
        config = MagicMock()
        config.language = None
        config.code_switching = False
        config.beam_size = None

        chunks_received: list[ChunkTranscriptionResult] = []

        with (
            patch.dict(sys.modules, {"torch": _make_mock_torch()}),
            patch("stt_v2.transcription.batch_service.get_settings") as ms,
        ):
            ms.return_value = MagicMock(
                transcription_chunk_length_s=15,
                transcription_stride_length_s="4,2",
            )
            await service._run_optimum_onnx_inference(
                samples,
                16000,
                model,
                config,
                chunk_callback=lambda c: chunks_received.append(c),
                first_word_hook=lambda: None,
            )

        assert len(chunks_received) == 1
        assert chunks_received[0].is_final is True
        assert chunks_received[0].text == "short audio"


# =============================================================================
# PER-SEGMENT SUB-SPLITTING TESTS
# =============================================================================


class TestPerSegmentSubSplitting:
    """Tests for VAD segment sub-splitting in _run_per_segment_inference."""

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    @pytest.mark.asyncio
    async def test_long_segment_is_sub_split(self, service):
        """A VAD segment > chunk_length_s should be sub-split."""
        from stt_v2.transcription.dto import AudioSegment, ChunkTranscriptionResult

        # 45-second speech segment
        segments = [AudioSegment(start_time=0.0, end_time=45.0, is_speech=True)]
        samples = np.random.randn(720000).astype(np.float32)  # 45s at 16kHz

        config = MagicMock()
        config.language = None

        chunks_received: list[ChunkTranscriptionResult] = []

        # Mock _run_inference to return simple text
        async def mock_inference(audio, sr, model, cfg, **kw):
            return RawTranscription(
                text=f"chunk {len(chunks_received)}",
                segments=[{"text": f"chunk {len(chunks_received)}", "start": 0.0, "end": 1.0}],
                word_timestamps=[],
            )

        model = MagicMock()

        with patch("stt_v2.transcription.batch_service.get_settings") as ms:
            ms.return_value = MagicMock(
                transcription_chunk_length_s=15,
                transcription_stride_length_s="4,2",
                segment_merge_gap_threshold_s=0,  # disable merging for this test
            )
            with patch.object(service, "_run_inference", side_effect=mock_inference):
                result = await service._run_per_segment_inference(
                    samples,
                    16000,
                    segments,
                    model,
                    config,
                    job_id="test",
                    chunk_callback=lambda c: chunks_received.append(c),
                )

        # 45s with 15s chunks and 9s step → should produce multiple chunks
        assert len(chunks_received) >= 3
        assert result.text  # Should have merged text

    @pytest.mark.asyncio
    async def test_short_segment_not_sub_split(self, service):
        """A VAD segment <= chunk_length_s should NOT be sub-split."""
        from stt_v2.transcription.dto import AudioSegment, ChunkTranscriptionResult

        # 10-second speech segment
        segments = [AudioSegment(start_time=0.0, end_time=10.0, is_speech=True)]
        samples = np.random.randn(160000).astype(np.float32)

        config = MagicMock()
        config.language = None

        chunks_received: list[ChunkTranscriptionResult] = []

        async def mock_inference(audio, sr, model, cfg, **kw):
            return RawTranscription(
                text="short segment",
                segments=[{"text": "short segment", "start": 0.0, "end": 10.0}],
                word_timestamps=[],
            )

        model = MagicMock()

        with patch("stt_v2.transcription.batch_service.get_settings") as ms:
            ms.return_value = MagicMock(
                transcription_chunk_length_s=15,
                transcription_stride_length_s="4,2",
                segment_merge_gap_threshold_s=0,  # disable merging for this test
            )
            with patch.object(service, "_run_inference", side_effect=mock_inference):
                _result = await service._run_per_segment_inference(
                    samples,
                    16000,
                    segments,
                    model,
                    config,
                    job_id="test",
                    chunk_callback=lambda c: chunks_received.append(c),
                )

        # Single call — no sub-splitting
        assert len(chunks_received) == 1
        assert chunks_received[0].is_final is True

    @pytest.mark.asyncio
    async def test_per_segment_results_in_model_output(self, service):
        """model_output should include per_segment_results."""
        from stt_v2.transcription.dto import AudioSegment

        segments = [
            AudioSegment(start_time=0.0, end_time=5.0, is_speech=True),
            AudioSegment(start_time=10.0, end_time=15.0, is_speech=True),
        ]
        samples = np.random.randn(240000).astype(np.float32)  # 15s

        config = MagicMock()
        config.language = None

        async def mock_inference(audio, sr, model, cfg, **kw):
            return RawTranscription(
                text="hello",
                segments=[{"text": "hello", "start": 0.0, "end": 5.0}],
                word_timestamps=[],
            )

        model = MagicMock()

        with patch("stt_v2.transcription.batch_service.get_settings") as ms:
            ms.return_value = MagicMock(
                transcription_chunk_length_s=15,
                transcription_stride_length_s="4,2",
                segment_merge_gap_threshold_s=0,  # disable merging for this test
            )
            with patch.object(service, "_run_inference", side_effect=mock_inference):
                result = await service._run_per_segment_inference(
                    samples,
                    16000,
                    segments,
                    model,
                    config,
                    job_id="test",
                )

        assert "per_segment_results" in result.model_output
        assert len(result.model_output["per_segment_results"]) == 2
        for psr in result.model_output["per_segment_results"]:
            assert "text" in psr
            assert "start_time" in psr
            assert "end_time" in psr


# =============================================================================
# CHUNK TRANSCRIPTION RESULT DTO TESTS
# =============================================================================


class TestChunkTranscriptionResult:
    """Tests for ChunkTranscriptionResult dataclass."""

    def test_basic_creation(self):
        from stt_v2.transcription.dto import ChunkTranscriptionResult

        chunk = ChunkTranscriptionResult(
            chunk_index=0,
            text="hello world",
            start_time=0.0,
            end_time=15.0,
        )
        assert chunk.chunk_index == 0
        assert chunk.text == "hello world"
        assert chunk.is_final is False
        assert chunk.vad_segment_index == -1

    def test_to_dict(self):
        from stt_v2.transcription.dto import ChunkTranscriptionResult

        chunk = ChunkTranscriptionResult(
            chunk_index=2,
            text="test",
            start_time=30.0,
            end_time=45.0,
            is_final=True,
            vad_segment_index=1,
        )
        d = chunk.to_dict()
        assert d["chunk_index"] == 2
        assert d["text"] == "test"
        assert d["is_final"] is True
        assert d["vad_segment_index"] == 1
        assert d["start_time"] == 30.0
        assert d["end_time"] == 45.0

    def test_default_word_timestamps_empty(self):
        from stt_v2.transcription.dto import ChunkTranscriptionResult

        chunk = ChunkTranscriptionResult(
            chunk_index=0,
            text="x",
            start_time=0,
            end_time=1,
        )
        assert chunk.word_timestamps == []


# =============================================================================
# CODE-SWITCHING INFERENCE BRANCHING TESTS (TASK-018)
# =============================================================================


def _make_mock_torch():
    """Create a mock torch module for tests that run without ML dependencies."""
    mock = MagicMock()
    mock.no_grad.return_value.__enter__ = MagicMock(return_value=None)
    mock.no_grad.return_value.__exit__ = MagicMock(return_value=False)
    mock.is_tensor.return_value = False
    mock.from_numpy.return_value.float.return_value.unsqueeze.return_value = MagicMock()
    mock.tensor.return_value = MagicMock()
    return mock


class TestCodeSwitchingInference:
    """Tests for code_switching parameter handling across inference engines.

    Verifies that:
    - When code_switching=True, language is NOT passed to generate_kwargs
    - When code_switching=False and language is set, language IS passed
    - When code_switching=False and language is None, language is NOT passed
    - NeMo engine logs a warning when code_switching is requested
    """

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    def _create_optimum_loaded_model(self) -> LoadedModel:
        """Create a mock LoadedModel for Optimum ONNX tests."""
        loaded_model = LoadedModel(
            model_id="m-optimum-test",
            model_slug="optimum-test",
            model=MagicMock(),
            processor=MagicMock(),
            tokenizer=MagicMock(),
            format=AiModelFormat.ONNX,
            memory_mb=760,
            device="cpu",
            loaded_at=datetime.now(UTC),
            extra={"optimum": True},
        )
        loaded_model.processor.return_value = {"input_features": MagicMock()}
        loaded_model.processor.batch_decode = MagicMock(return_value=["transcribed"])
        loaded_model.processor.decode = MagicMock(return_value={"offsets": []})
        loaded_model.model.generate = MagicMock(return_value=MagicMock())
        return loaded_model

    @pytest.mark.asyncio
    async def test_optimum_onnx_code_switching_omits_language(self, service):
        """When code_switching=True, language should NOT be in generate_kwargs."""
        pipeline_config = create_complete_pipeline_config(language="en")
        pipeline_config.spec.inference.code_switching = True

        loaded_model = self._create_optimum_loaded_model()
        samples = np.zeros(16000, dtype=np.float32)
        config = pipeline_config.spec.inference

        with patch.dict(sys.modules, {"torch": _make_mock_torch()}):
            with patch("stt_v2.transcription.batch_service.get_settings") as ms:
                ms.return_value = MagicMock(
                    transcription_chunk_length_s=30,
                    transcription_stride_length_s="4,2",
                )
                await service._run_optimum_onnx_inference(
                    samples, 16000, loaded_model, config, None
                )

        transcribe_call_kwargs = loaded_model.model.generate.call_args_list[0][1]
        assert "language" not in transcribe_call_kwargs

    @pytest.mark.asyncio
    async def test_transformers_code_switching_adds_english_segment(self, service):
        """Transformers code-switching should attach english_text to the output segment."""
        pipeline_config = create_complete_pipeline_config(language="fr")
        pipeline_config.spec.inference.code_switching = True

        loaded_model = self._create_transformers_loaded_model()
        samples = np.zeros(16000, dtype=np.float32)
        config = pipeline_config.spec.inference

        with patch.dict(sys.modules, {"torch": _make_mock_torch()}):
            with patch.object(service, "_generate_english_translation", return_value="Hello world"):
                result = await service._run_transformers_inference(
                    samples, 16000, loaded_model, config, None
                )

        assert len(result.segments) == 1
        assert result.segments[0]["english_text"] == "Hello world"

    @pytest.mark.asyncio
    async def test_optimum_onnx_no_code_switching_includes_language(self, service):
        """When code_switching=False and language is set, language should be in generate_kwargs."""
        pipeline_config = create_complete_pipeline_config(language="en")
        pipeline_config.spec.inference.code_switching = False

        loaded_model = self._create_optimum_loaded_model()
        samples = np.zeros(16000, dtype=np.float32)
        config = pipeline_config.spec.inference

        with patch.dict(sys.modules, {"torch": _make_mock_torch()}):
            with patch("stt_v2.transcription.batch_service.get_settings") as ms:
                ms.return_value = MagicMock(
                    transcription_chunk_length_s=30,
                    transcription_stride_length_s="4,2",
                )
                await service._run_optimum_onnx_inference(
                    samples, 16000, loaded_model, config, None
                )

        call_kwargs = loaded_model.model.generate.call_args[1]
        assert "language" in call_kwargs
        assert call_kwargs["language"] == "en"

    @pytest.mark.asyncio
    async def test_optimum_single_pass_code_switching_adds_english_segment(self, service):
        """Optimum single-pass code-switching should attach english_text to the output segment."""
        pipeline_config = create_complete_pipeline_config(language="en")
        pipeline_config.spec.inference.code_switching = True

        loaded_model = self._create_optimum_loaded_model()
        samples = np.zeros(16000, dtype=np.float32)
        config = pipeline_config.spec.inference

        with patch.dict(sys.modules, {"torch": _make_mock_torch()}):
            with patch("stt_v2.transcription.batch_service.get_settings") as ms:
                ms.return_value = MagicMock(
                    transcription_chunk_length_s=30,
                    transcription_stride_length_s="4,2",
                )
                with patch.object(
                    service, "_generate_english_translation", return_value="Hello world"
                ):
                    result = await service._run_optimum_onnx_inference(
                        samples, 16000, loaded_model, config, None
                    )

        assert len(result.segments) == 1
        assert result.segments[0]["english_text"] == "Hello world"

    def _create_transformers_loaded_model(self) -> LoadedModel:
        """Create a mock LoadedModel for Transformers/SafeTensor tests."""
        mock_model = MagicMock()
        mock_model.generate = MagicMock(return_value=MagicMock())
        loaded_model = LoadedModel(
            model_id="m-transformers-test",
            model_slug="transformers-test",
            model=mock_model,
            processor=MagicMock(),
            tokenizer=MagicMock(),
            format=AiModelFormat.SAFETENSOR,
            memory_mb=100,
            device="cpu",
            loaded_at=datetime.now(UTC),
        )
        loaded_model.processor.return_value = {"input_features": MagicMock()}
        loaded_model.processor.batch_decode = MagicMock(return_value=["transcribed"])
        loaded_model.processor.decode = MagicMock(return_value={"offsets": []})
        return loaded_model

    @pytest.mark.asyncio
    async def test_transformers_code_switching_omits_language(self, service):
        """When code_switching=True, language should NOT be in generate() kwargs."""
        pipeline_config = create_complete_pipeline_config(language="fr")
        pipeline_config.spec.inference.code_switching = True

        loaded_model = self._create_transformers_loaded_model()
        samples = np.zeros(16000, dtype=np.float32)
        config = pipeline_config.spec.inference

        with patch.dict(sys.modules, {"torch": _make_mock_torch()}):
            await service._run_transformers_inference(samples, 16000, loaded_model, config, None)

        transcribe_call_kwargs = loaded_model.model.generate.call_args_list[0][1]
        assert "language" not in transcribe_call_kwargs

    @pytest.mark.asyncio
    async def test_transformers_no_code_switching_includes_language(self, service):
        """When code_switching=False and language is set, language should be in generate() kwargs."""
        pipeline_config = create_complete_pipeline_config(language="fr")
        pipeline_config.spec.inference.code_switching = False

        loaded_model = self._create_transformers_loaded_model()
        samples = np.zeros(16000, dtype=np.float32)
        config = pipeline_config.spec.inference

        with patch.dict(sys.modules, {"torch": _make_mock_torch()}):
            await service._run_transformers_inference(samples, 16000, loaded_model, config, None)

        call_kwargs = loaded_model.model.generate.call_args[1]
        assert "language" in call_kwargs
        assert call_kwargs["language"] == "fr"

    @pytest.mark.asyncio
    async def test_transformers_requests_and_forwards_attention_mask(self, service):
        """Transformers path uses return_tensors='pt' and forwards processor outputs to generate()."""
        pipeline_config = create_complete_pipeline_config(language="en")
        pipeline_config.spec.inference.code_switching = False

        loaded_model = self._create_transformers_loaded_model()
        samples = np.zeros(16000, dtype=np.float32)
        config = pipeline_config.spec.inference

        input_features = MagicMock()
        input_features.is_floating_point.return_value = True
        input_features.to.return_value = input_features

        attention_mask = MagicMock()
        attention_mask.is_floating_point.return_value = False
        attention_mask.to.return_value = attention_mask

        loaded_model.processor.return_value = {
            "input_features": input_features,
            "attention_mask": attention_mask,
        }

        with patch.dict(sys.modules, {"torch": _make_mock_torch()}):
            await service._run_transformers_inference(samples, 16000, loaded_model, config, None)

        processor_kwargs = loaded_model.processor.call_args.kwargs
        assert "return_tensors" in processor_kwargs
        assert processor_kwargs["return_tensors"] == "pt"

        call_kwargs = loaded_model.model.generate.call_args[1]
        assert "attention_mask" in call_kwargs
        assert call_kwargs["attention_mask"] is attention_mask

    @pytest.mark.asyncio
    async def test_nemo_code_switching_logs_warning(self, service, caplog):
        """When code_switching=True with NeMo, a warning should be logged."""
        pipeline_config = create_complete_pipeline_config()
        pipeline_config.spec.inference.code_switching = True

        mock_nemo_model = MagicMock()
        mock_nemo_model.transcribe = MagicMock(return_value=["transcribed text"])
        loaded_model = LoadedModel(
            model_id="m-nemo-test",
            model_slug="nemo-test",
            model=mock_nemo_model,
            processor=None,
            tokenizer=None,
            format=AiModelFormat.NEMO,
            memory_mb=100,
            device="cpu",
            loaded_at=datetime.now(UTC),
        )

        samples = np.zeros(16000, dtype=np.float32)
        config = pipeline_config.spec.inference

        with patch.dict(sys.modules, {"torch": _make_mock_torch()}):
            with caplog.at_level(logging.WARNING):
                await service._run_nemo_inference(samples, 16000, loaded_model, config, None)

        assert any("code-switching" in rec.message for rec in caplog.records)
        assert any("NeMo" in rec.message for rec in caplog.records)

    @pytest.mark.asyncio
    async def test_code_switching_default_false_uses_language(self, service):
        """When code_switching defaults to False and language is set, language should be passed."""
        pipeline_config = create_complete_pipeline_config(language="de")
        assert pipeline_config.spec.inference.code_switching is False

        loaded_model = self._create_optimum_loaded_model()
        samples = np.zeros(16000, dtype=np.float32)
        config = pipeline_config.spec.inference

        with patch.dict(sys.modules, {"torch": _make_mock_torch()}):
            with patch("stt_v2.transcription.batch_service.get_settings") as ms:
                ms.return_value = MagicMock(
                    transcription_chunk_length_s=30,
                    transcription_stride_length_s="4,2",
                )
                await service._run_optimum_onnx_inference(
                    samples, 16000, loaded_model, config, None
                )

        call_kwargs = loaded_model.model.generate.call_args[1]
        assert "language" in call_kwargs
        assert call_kwargs["language"] == "de"

    @pytest.mark.asyncio
    async def test_code_switching_true_language_none_omits_language(self, service):
        """When code_switching=True and language=None, language should NOT be in generate_kwargs."""
        pipeline_config = create_complete_pipeline_config(language=None)
        pipeline_config.spec.inference.code_switching = True

        loaded_model = self._create_optimum_loaded_model()
        samples = np.zeros(16000, dtype=np.float32)
        config = pipeline_config.spec.inference

        with patch.dict(sys.modules, {"torch": _make_mock_torch()}):
            with patch("stt_v2.transcription.batch_service.get_settings") as ms:
                ms.return_value = MagicMock(
                    transcription_chunk_length_s=30,
                    transcription_stride_length_s="4,2",
                )
                await service._run_optimum_onnx_inference(
                    samples, 16000, loaded_model, config, None
                )

        transcribe_call_kwargs = loaded_model.model.generate.call_args_list[0][1]
        assert "language" not in transcribe_call_kwargs

    @pytest.mark.asyncio
    async def test_no_code_switching_language_none_omits_language(self, service):
        """When code_switching=False and language=None, language should NOT be in generate_kwargs."""
        pipeline_config = create_complete_pipeline_config(language=None)
        pipeline_config.spec.inference.code_switching = False

        loaded_model = self._create_optimum_loaded_model()
        samples = np.zeros(16000, dtype=np.float32)
        config = pipeline_config.spec.inference

        with patch.dict(sys.modules, {"torch": _make_mock_torch()}):
            with patch("stt_v2.transcription.batch_service.get_settings") as ms:
                ms.return_value = MagicMock(
                    transcription_chunk_length_s=30,
                    transcription_stride_length_s="4,2",
                )
                await service._run_optimum_onnx_inference(
                    samples, 16000, loaded_model, config, None
                )

        call_kwargs = loaded_model.model.generate.call_args[1]
        assert "language" not in call_kwargs


# =============================================================================
# Batch Postprocess Punctuation Tests
# =============================================================================


class TestBatchPostprocessPunctuation:
    """Tests for punctuation restoration in batch _postprocess()."""

    @pytest.fixture
    def service(self):
        return BatchTranscriptionService()

    def _make_config(self, *, punctuation_enabled=True, lowercase=False, sentence_timestamps=False):
        config = MagicMock()
        config.lowercase = lowercase
        config.timestamps = MagicMock()
        config.timestamps.word_timestamps = False
        config.timestamps.sentence_timestamps = sentence_timestamps
        config.punctuation = MagicMock()
        config.punctuation.enabled = punctuation_enabled
        return config

    @patch("stt_v2.punctuation.service.punctuate_sync")
    def test_postprocess_with_punctuation_enabled(self, mock_sync, service):
        mock_sync.return_value = ["Hello world, how are you?"]
        raw = RawTranscription(text="hello world how are you")
        config = self._make_config(punctuation_enabled=True)

        result = service._postprocess(raw, config, 1.0)

        assert result.text == "Hello world, how are you?"
        mock_sync.assert_called_once_with(
            ["hello world how are you"],
            batch_size=8,
            model_name=config.punctuation.model,
        )

    def test_postprocess_with_punctuation_disabled(self, service):
        raw = RawTranscription(text="hello world")
        config = self._make_config(punctuation_enabled=False)

        result = service._postprocess(raw, config, 1.0)

        assert result.text == "hello world"

    @patch("stt_v2.punctuation.service.punctuate_sync", side_effect=RuntimeError("model error"))
    def test_postprocess_punctuation_failure_graceful(self, mock_sync, service):
        raw = RawTranscription(text="hello world")
        config = self._make_config(punctuation_enabled=True)

        result = service._postprocess(raw, config, 1.0)

        assert result.text == "hello world"

    @patch("stt_v2.punctuation.service.punctuate_sync")
    def test_postprocess_segments_punctuated(self, mock_sync, service):
        mock_sync.return_value = ["Hello world.", "Hello.", "World."]
        raw = RawTranscription(
            text="hello world",
            segments=[
                {"text": "hello", "start": 0.0, "end": 0.5},
                {"text": "world", "start": 0.5, "end": 1.0},
            ],
        )
        # sentence_timestamps=True is needed so punctuate_sync receives segment texts,
        # but sentence timestamp extraction has a pre-existing issue with english_text.
        # We disable sentence_timestamps in config so _postprocess skips extraction,
        # but the punctuation block still reads config.timestamps.sentence_timestamps.
        # Instead, set sentence_timestamps=True only in the punctuation config path
        # by using a MagicMock that returns True for the punctuation check.
        config = self._make_config(punctuation_enabled=True, sentence_timestamps=False)
        # Override so the punctuation block sees sentence_timestamps=True
        # but the timestamp extraction block sees False

        # Simpler approach: set True and mock the SentenceTimestamp constructor
        config.timestamps.sentence_timestamps = True

        with patch("stt_v2.transcription.batch_service.SentenceTimestamp") as MockST:
            MockST.side_effect = lambda **kw: MagicMock(**kw)
            result = service._postprocess(raw, config, 1.0)

        assert result.text == "Hello world."
        # Verify segments were mutated by punctuation
        assert raw.segments[0]["text"] == "Hello."
        assert raw.segments[1]["text"] == "World."
        mock_sync.assert_called_once_with(
            ["hello world", "hello", "world"],
            batch_size=8,
            model_name=config.punctuation.model,
        )

    @patch("stt_v2.punctuation.service.punctuate_sync")
    def test_postprocess_punctuation_then_lowercase(self, mock_sync, service):
        """Lowercase is applied AFTER punctuation."""
        mock_sync.return_value = ["Hello World."]
        raw = RawTranscription(text="hello world")
        config = self._make_config(punctuation_enabled=True, lowercase=True)

        result = service._postprocess(raw, config, 1.0)

        assert result.text == "hello world."
