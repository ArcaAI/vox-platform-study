"""E2E tests for full transcription flow."""

import io
from unittest.mock import MagicMock

import pytest


@pytest.mark.e2e
class TestStorageFlow:
    """E2E tests for storage operations."""

    @pytest.mark.asyncio
    async def test_audio_upload_and_download(self, minio_container, sample_wav_audio):
        """Test uploading and downloading audio through storage service."""
        from minio import Minio

        # Create client
        client = Minio(
            minio_container["endpoint"],
            access_key=minio_container["access_key"],
            secret_key=minio_container["secret_key"],
            secure=minio_container["secure"],
        )

        bucket = "test-audio"
        object_name = "test/audio.wav"

        # Create bucket if not exists
        if not client.bucket_exists(bucket):
            client.make_bucket(bucket)

        # Upload
        client.put_object(
            bucket,
            object_name,
            io.BytesIO(sample_wav_audio),
            len(sample_wav_audio),
            content_type="audio/wav",
        )

        # Download
        response = client.get_object(bucket, object_name)
        downloaded = response.read()
        response.close()
        response.release_conn()

        assert downloaded == sample_wav_audio

        # Cleanup
        client.remove_object(bucket, object_name)
        client.remove_bucket(bucket)


@pytest.mark.e2e
class TestPipelineConfigFlow:
    """E2E tests for pipeline configuration flow."""

    @pytest.mark.asyncio
    async def test_yaml_parsing_flow(self):
        """Test parsing pipeline YAML configuration."""
        from stt_v2.pipeline.yaml_parser import get_yaml_parser

        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
  vad: silero-vad-v4

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.5

inference:
  batch_size: 16
  compute_type: float16
  device: auto
  language: en

postprocessing:
  timestamps:
    word_timestamps: true
  punctuation:
    enabled: true
"""
        parser = get_yaml_parser()

        # Parse
        spec = parser.parse(yaml_content)

        assert spec.version == "1.0"
        # ModelRefs now use ModelRef objects with .slug property
        assert spec.models.asr.slug == "whisper-large-v3"
        assert spec.models.vad.slug == "silero-vad-v4"
        assert spec.preprocessing.target_sample_rate == 16000
        assert spec.inference.language == "en"

        # Validate
        result = parser.validate(spec)
        assert result.valid is True

        # Extract model slugs
        slugs = parser.extract_model_slugs(spec)
        assert "whisper-large-v3" in slugs
        assert "silero-vad-v4" in slugs


@pytest.mark.e2e
@pytest.mark.ml
class TestPreprocessingFlow:
    """E2E tests for audio preprocessing flow."""

    @pytest.mark.asyncio
    async def test_audio_preprocessing(self, sample_wav_audio):
        """Test audio preprocessing pipeline."""
        pytest.importorskip("soundfile", reason="soundfile not installed (requires [ml] extra)")
        from stt_v2.pipeline.dto import DenoiseConfig, PreprocessingConfig, VadConfig
        from stt_v2.transcription.preprocessing import get_preprocessor

        preprocessor = get_preprocessor()

        config = PreprocessingConfig(
            target_sample_rate=16000,
            normalize=True,
            vad=VadConfig(enabled=False),
            denoise=DenoiseConfig(enabled=False),
        )

        result = await preprocessor.process(
            audio_bytes=sample_wav_audio,
            config=config,
        )

        assert result.sample_rate == 16000
        assert result.duration_seconds > 0
        assert result.was_normalized is True
        assert len(result.samples) > 0


@pytest.mark.e2e
class TestModelCacheFlow:
    """E2E tests for model cache operations."""

    @pytest.mark.asyncio
    async def test_cache_operations(self):
        """Test model cache put, get, and evict."""
        from stt_v2.models.base_loader import LoadedModel
        from stt_v2.models.cache import ModelCache
        from stt_v2.pipeline.dto import AiModelFormat

        cache = ModelCache(max_models=3, max_memory_mb=5000, ttl_seconds=3600)

        # Create mock model
        model = LoadedModel(
            model_id="m-test",
            model_slug="test-model",
            model=MagicMock(),
            format=AiModelFormat.SAFETENSOR,
            memory_mb=100,
            device="cpu",
        )

        # Put
        await cache.put("test-model", model)

        # Get
        retrieved = await cache.get("test-model")
        assert retrieved is not None
        assert retrieved.model_slug == "test-model"

        # Stats
        stats = cache.stats()
        assert stats.total_models == 1
        assert stats.hits == 1

        # Evict
        await cache.evict("test-model")

        # Verify evicted
        retrieved = await cache.get("test-model")
        assert retrieved is None


@pytest.mark.e2e
class TestTranscriptionResultFlow:
    """E2E tests for transcription result handling."""

    def test_result_serialization(self):
        """Test transcription result to dict conversion."""
        from stt_v2.transcription.dto import (
            SentenceTimestamp,
            TranscriptionResult,
            WordTimestamp,
        )

        result = TranscriptionResult(
            text="Hello world, this is a test transcription.",
            language="en",
            language_probability=0.98,
            duration_seconds=5.5,
            processing_time_seconds=1.2,
            word_timestamps=[
                WordTimestamp("Hello", 0.0, 0.5, 0.95),
                WordTimestamp("world", 0.6, 1.0, 0.92),
            ],
            sentence_timestamps=[
                SentenceTimestamp("Hello world, this is a test transcription.", 0.0, 5.5),
            ],
            metadata={"pipeline": "test-pipeline", "model": "whisper-test"},
        )

        # Convert to dict
        result_dict = result.to_dict()

        assert result_dict["text"] == "Hello world, this is a test transcription."
        assert result_dict["language"] == "en"
        assert result_dict["duration_seconds"] == 5.5
        assert len(result_dict["word_timestamps"]) == 2
        assert result_dict["word_timestamps"][0]["word"] == "Hello"
        assert len(result_dict["sentence_timestamps"]) == 1
        assert result_dict["metadata"]["pipeline"] == "test-pipeline"

        # Should be JSON serializable
        import json

        json_str = json.dumps(result_dict)
        assert json_str is not None


@pytest.mark.e2e
class TestStreamingSessionFlow:
    """E2E tests for streaming session management."""

    def test_session_lifecycle(self):
        """Test streaming session lifecycle."""
        from stt_v2.transcription.dto import StreamingChunkResult, StreamingSession

        # Create session
        session = StreamingSession(
            session_id="test-session",
            pipeline_id="p-123",
            tenant_id="t-456",
            consultation_id="c-789",
        )

        assert session.is_active is True
        assert session.chunk_count == 0
        assert session.total_duration_seconds == 0.0

        # Add chunks
        session.add_chunk(b"chunk1", 1.0)
        session.add_chunk(b"chunk2", 1.5)

        assert session.chunk_count == 2
        assert session.total_duration_seconds == 2.5

        # Add results
        session.add_result(StreamingChunkResult("Hello", is_final=True, segment_id=0))
        session.add_result(StreamingChunkResult("world", is_final=True, segment_id=1))

        assert session.final_text == "Hello world"

        # Finalize
        result = session.finalize()

        assert session.is_active is False
        assert result.text == "Hello world"
        assert result.duration_seconds == 2.5
        assert result.metadata["session_id"] == "test-session"


@pytest.mark.e2e
class TestInlineModelConfigFlow:
    """E2E tests for inline model configuration flow (v1.1 schema)."""

    @pytest.mark.asyncio
    async def test_inline_yaml_parsing_and_validation(self):
        """Test parsing and validating inline model YAML configuration."""
        from stt_v2.pipeline.dto import AiModelFormat
        from stt_v2.pipeline.yaml_parser import get_yaml_parser

        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo"
    engine: "onnx"
    revision: "main"
  vad:
    hf_model_id: "snakers4/silero-vad"
    engine: "onnx"
    version: "v6.0"
  denoise:
    hf_model_id: "nickolay/rnnoise"
    engine: "onnx"

preprocessing:
  vad:
    enabled: true
    threshold: 0.45
  denoise:
    enabled: true
    strength: 0.7
  target_sample_rate: 16000

inference:
  batch_size: 8
  compute_type: float16
  device: auto
"""
        parser = get_yaml_parser()

        # Parse
        spec = parser.parse(yaml_content)

        # Verify version 1.1
        assert spec.version == "1.1"

        # Verify all models are inline
        assert spec.models.asr.is_inline is True
        assert spec.models.vad.is_inline is True
        assert spec.models.denoise.is_inline is True

        # Verify ASR model details
        assert spec.models.asr.inline.hf_model_id == "onnx-community/whisper-large-v3-turbo"
        assert spec.models.asr.inline.engine == AiModelFormat.ONNX
        assert spec.models.asr.inline.revision == "main"

        # Verify VAD model details
        assert spec.models.vad.inline.hf_model_id == "snakers4/silero-vad"
        assert spec.models.vad.inline.version == "v6.0"

        # Validate
        result = parser.validate(spec)
        assert result.valid is True, f"Validation failed: {result.get_error_messages()}"

        # Verify no slugs (all inline)
        slugs = parser.extract_model_slugs(spec)
        assert len(slugs) == 0, "Inline models should not have slugs"

        # Verify inline models can be retrieved
        inline_models = spec.models.get_inline_models()
        assert len(inline_models) == 3
        roles = [role for role, _ in inline_models]
        assert "asr" in roles
        assert "vad" in roles
        assert "denoise" in roles

    @pytest.mark.asyncio
    async def test_mixed_slug_and_inline_configuration(self):
        """Test parsing YAML with mixed slug and inline model definitions."""
        from stt_v2.pipeline.yaml_parser import get_yaml_parser

        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo"
    engine: "onnx"
  vad: "silero-vad-v6"
  denoise: "deepfilternet-v3"
"""
        parser = get_yaml_parser()
        spec = parser.parse(yaml_content)

        # ASR is inline
        assert spec.models.asr.is_inline is True
        assert spec.models.asr.inline.hf_model_id == "onnx-community/whisper-large-v3-turbo"

        # VAD is slug
        assert spec.models.vad.is_inline is False
        assert spec.models.vad.slug == "silero-vad-v6"

        # Denoise is slug
        assert spec.models.denoise.is_inline is False
        assert spec.models.denoise.slug == "deepfilternet-v3"

        # Slugs should only include the slug-based models
        slugs = parser.extract_model_slugs(spec)
        assert len(slugs) == 2
        assert "silero-vad-v6" in slugs
        assert "deepfilternet-v3" in slugs

    @pytest.mark.asyncio
    async def test_inline_model_config_conversion(self):
        """Test converting inline model to AiModelConfig."""
        from stt_v2.pipeline.dto import (
            AiModelFormat,
            AiModelSource,
            InlineModelDef,
            ModelTaskType,
        )

        inline = InlineModelDef(
            hf_model_id="onnx-community/whisper-large-v3-turbo",
            engine=AiModelFormat.ONNX,
            revision="main",
            compute_type="float16",
        )

        config = inline.to_ai_model_config(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION)

        # Verify conversion
        assert config.source == AiModelSource.HUGGINGFACE
        assert config.source_uri == "onnx-community/whisper-large-v3-turbo"
        assert config.source_revision == "main"
        assert config.format == AiModelFormat.ONNX
        assert config.task_type == ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION
        assert config.compute_type == "float16"
        # Should generate a slug from the model ID
        assert "onnx-community" in config.slug or "whisper" in config.slug
