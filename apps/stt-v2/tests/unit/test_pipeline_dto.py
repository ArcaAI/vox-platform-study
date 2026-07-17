"""Unit tests for Pipeline DTOs."""

import os

import pytest

_MODEL_BASE = (
    os.environ.get("HUGGINGFACE_CACHE_DIR")
    or os.environ.get("HF_HOME")
    or os.path.join(os.sep, "models", "hf-cache")
)

from stt_v2.pipeline.dto import (
    VALID_WHISPER_LANGUAGES,
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    DenoiseConfig,
    InferenceConfig,
    InlineModelDef,
    ModelRef,
    ModelRefs,
    ModelTaskType,
    PipelineConfig,
    PipelineSpec,
    PostprocessingConfig,
    PreprocessingConfig,
    VadConfig,
    ValidationResult,
    is_valid_language_code,
)

# =============================================================================
# INLINE MODEL DEFINITION TESTS
# =============================================================================


class TestInlineModelDef:
    """Tests for InlineModelDef dataclass."""

    def test_basic_creation(self):
        """Test basic inline model definition creation."""
        inline = InlineModelDef(
            hf_model_id="onnx-community/whisper-large-v3-turbo",
            engine=AiModelFormat.ONNX,
        )
        assert inline.hf_model_id == "onnx-community/whisper-large-v3-turbo"
        assert inline.engine == AiModelFormat.ONNX
        assert inline.revision is None
        assert inline.version is None

    def test_creation_with_all_fields(self):
        """Test inline model definition with all fields."""
        inline = InlineModelDef(
            hf_model_id="snakers4/silero-vad",
            engine=AiModelFormat.ONNX,
            revision="main",
            version="main",
            compute_type="float32",
            device="cuda",
        )
        assert inline.hf_model_id == "snakers4/silero-vad"
        assert inline.engine == AiModelFormat.ONNX
        assert inline.revision == "main"
        assert inline.version == "main"
        assert inline.compute_type == "float32"
        assert inline.device == "cuda"

    def test_to_ai_model_config_basic(self):
        """Test conversion to AiModelConfig."""
        inline = InlineModelDef(
            hf_model_id="onnx-community/whisper-large-v3-turbo",
            engine=AiModelFormat.ONNX,
        )
        config = inline.to_ai_model_config(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION)

        assert config.source_uri == "onnx-community/whisper-large-v3-turbo"
        assert config.format == AiModelFormat.ONNX
        assert config.task_type == ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION
        assert config.source == AiModelSource.HUGGINGFACE
        assert "onnx-community--whisper-large-v3-turbo" in config.slug

    def test_to_ai_model_config_with_version(self):
        """Test conversion with version in slug."""
        inline = InlineModelDef(
            hf_model_id="snakers4/silero-vad",
            engine=AiModelFormat.ONNX,
            version="main",
        )
        config = inline.to_ai_model_config(ModelTaskType.VOICE_ACTIVITY_DETECTION)

        assert "main" in config.slug  # Version included in slug
        assert config.source_revision == "main"

    def test_to_ai_model_config_uses_revision_over_version(self):
        """Test that revision is preferred over version."""
        inline = InlineModelDef(
            hf_model_id="test/model",
            engine=AiModelFormat.SAFETENSOR,
            revision="specific-commit",
            version="v1.0",
        )
        config = inline.to_ai_model_config(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION)

        assert config.source_revision == "specific-commit"


class TestModelRef:
    """Tests for ModelRef class."""

    def test_create_from_slug_string(self):
        """Test creating ModelRef from a slug string."""
        ref = ModelRef.from_value("whisper-large-v3")

        assert ref.slug == "whisper-large-v3"
        assert ref.inline is None
        assert ref.is_inline is False
        assert ref.identifier == "whisper-large-v3"

    def test_create_from_inline_dict(self):
        """Test creating ModelRef from an inline dictionary."""
        ref = ModelRef.from_value(
            {
                "hf_model_id": "onnx-community/whisper-large-v3-turbo",
                "engine": "onnx",
            }
        )

        assert ref.slug is None
        assert ref.inline is not None
        assert ref.is_inline is True
        assert ref.identifier == "onnx-community/whisper-large-v3-turbo"
        assert ref.inline.engine == AiModelFormat.ONNX

    def test_create_from_inline_with_all_fields(self):
        """Test creating ModelRef from inline dict with all fields."""
        ref = ModelRef.from_value(
            {
                "hf_model_id": "snakers4/silero-vad",
                "engine": "onnx",
                "version": "v6.0",
                "compute_type": "float32",
                "device": "cuda",
            }
        )

        assert ref.inline.version == "v6.0"
        assert ref.inline.compute_type == "float32"
        assert ref.inline.device == "cuda"

    def test_engine_normalization_onnx(self):
        """Test engine name normalization for ONNX."""
        ref = ModelRef.from_value({"hf_model_id": "test", "engine": "onnx"})
        assert ref.inline.engine == AiModelFormat.ONNX

    def test_engine_normalization_safetensor(self):
        """Test engine name normalization for SafeTensor."""
        ref = ModelRef.from_value({"hf_model_id": "test", "engine": "safetensor"})
        assert ref.inline.engine == AiModelFormat.SAFETENSOR

    def test_engine_normalization_transformers(self):
        """Test that 'transformers' maps to SAFETENSOR."""
        ref = ModelRef.from_value({"hf_model_id": "test", "engine": "transformers"})
        assert ref.inline.engine == AiModelFormat.SAFETENSOR

    def test_engine_normalization_huggingface(self):
        """Test that 'huggingface' maps to SAFETENSOR."""
        ref = ModelRef.from_value({"hf_model_id": "test", "engine": "huggingface"})
        assert ref.inline.engine == AiModelFormat.SAFETENSOR

    def test_engine_normalization_ctranslate2(self):
        """Test engine normalization for CTranslate2."""
        ref = ModelRef.from_value({"hf_model_id": "test", "engine": "ctranslate2"})
        assert ref.inline.engine == AiModelFormat.CTRANSLATE2

        ref2 = ModelRef.from_value({"hf_model_id": "test", "engine": "ct2"})
        assert ref2.inline.engine == AiModelFormat.CTRANSLATE2

    def test_engine_normalization_nemo(self):
        """Test engine normalization for NeMo."""
        ref = ModelRef.from_value({"hf_model_id": "test", "engine": "nemo"})
        assert ref.inline.engine == AiModelFormat.NEMO

    def test_engine_normalization_azure_speech(self):
        """Test engine normalization for Azure Speech."""
        ref = ModelRef.from_value({"hf_model_id": "test", "engine": "azure_speech"})
        assert ref.inline.engine == AiModelFormat.AZURE_SPEECH

    def test_engine_normalization_azure_alias(self):
        """Test that 'azure' alias maps to AZURE_SPEECH."""
        ref = ModelRef.from_value({"hf_model_id": "test", "engine": "azure"})
        assert ref.inline.engine == AiModelFormat.AZURE_SPEECH

    def test_engine_default_to_safetensor(self):
        """Test default engine is SAFETENSOR."""
        ref = ModelRef.from_value({"hf_model_id": "test"})
        assert ref.inline.engine == AiModelFormat.SAFETENSOR

    def test_model_id_alias(self):
        """Test that 'model_id' is also accepted as alias."""
        ref = ModelRef.from_value({"model_id": "test/model", "engine": "onnx"})
        assert ref.inline.hf_model_id == "test/model"

    def test_invalid_value_raises_error(self):
        """Test that invalid value raises ValueError."""
        with pytest.raises(ValueError, match="Invalid model reference"):
            ModelRef.from_value(123)


class TestModelRefs:
    """Tests for ModelRefs dataclass."""

    def test_get_all_slugs_asr_only_slug(self):
        """Test with only ASR model as slug."""
        refs = ModelRefs(asr=ModelRef(slug="whisper-large-v3"))
        assert refs.get_all_slugs() == ["whisper-large-v3"]

    def test_get_all_slugs_with_vad_slug(self):
        """Test with ASR and VAD models as slugs."""
        refs = ModelRefs(
            asr=ModelRef(slug="whisper-large-v3"),
            vad=ModelRef(slug="silero-vad"),
        )
        slugs = refs.get_all_slugs()
        assert "whisper-large-v3" in slugs
        assert "silero-vad" in slugs
        assert len(slugs) == 2

    def test_get_all_slugs_all_models_slug(self):
        """Test with all models as slugs."""
        refs = ModelRefs(
            asr=ModelRef(slug="whisper"),
            vad=ModelRef(slug="silero"),
            denoise=ModelRef(slug="denoiser"),
        )
        slugs = refs.get_all_slugs()
        assert len(slugs) == 3

    def test_get_all_slugs_ignores_inline_models(self):
        """Test that get_all_slugs ignores inline models."""
        inline_def = InlineModelDef(
            hf_model_id="onnx-community/whisper-turbo",
            engine=AiModelFormat.ONNX,
        )
        refs = ModelRefs(
            asr=ModelRef(inline=inline_def),
            vad=ModelRef(slug="silero-vad"),
        )
        slugs = refs.get_all_slugs()
        assert slugs == ["silero-vad"]

    def test_get_all_refs(self):
        """Test getting all model references."""
        refs = ModelRefs(
            asr=ModelRef(slug="whisper"),
            vad=ModelRef(slug="silero"),
            denoise=ModelRef(slug="denoiser"),
        )
        all_refs = refs.get_all_refs()

        assert len(all_refs) == 3
        assert ("asr", refs.asr) in all_refs
        assert ("vad", refs.vad) in all_refs
        assert ("denoise", refs.denoise) in all_refs

    def test_get_all_refs_excludes_none(self):
        """Test that None refs are excluded."""
        refs = ModelRefs(
            asr=ModelRef(slug="whisper"),
            vad=None,
            denoise=None,
        )
        all_refs = refs.get_all_refs()

        assert len(all_refs) == 1
        assert all_refs[0][0] == "asr"

    def test_get_inline_models(self):
        """Test getting inline model definitions."""
        inline_asr = InlineModelDef(
            hf_model_id="onnx-community/whisper-turbo",
            engine=AiModelFormat.ONNX,
        )
        inline_vad = InlineModelDef(
            hf_model_id="snakers4/silero-vad",
            engine=AiModelFormat.ONNX,
            version="main",
        )
        refs = ModelRefs(
            asr=ModelRef(inline=inline_asr),
            vad=ModelRef(inline=inline_vad),
            denoise=ModelRef(slug="deepfilternet-v3"),  # Slug, not inline
        )

        inline_models = refs.get_inline_models()

        assert len(inline_models) == 2
        assert ("asr", inline_asr) in inline_models
        assert ("vad", inline_vad) in inline_models

    def test_get_inline_models_empty_when_all_slugs(self):
        """Test that get_inline_models returns empty for all slug refs."""
        refs = ModelRefs(
            asr=ModelRef(slug="whisper"),
            vad=ModelRef(slug="silero"),
        )

        inline_models = refs.get_inline_models()

        assert len(inline_models) == 0


class TestVadConfig:
    """Tests for VadConfig dataclass."""

    def test_default_values(self):
        """Test default configuration values."""
        config = VadConfig()
        assert config.enabled is True
        assert config.threshold == 0.6
        # TASK-505: clinical defaults — 100 ms keeps short confirmations
        # ("yes"/"no"); 200 ms padding protects onsets/tails.
        assert config.min_speech_duration_ms == 100
        assert config.min_silence_duration_ms == 100
        assert config.padding_ms == 200

    def test_custom_values(self):
        """Test custom configuration values."""
        config = VadConfig(
            enabled=False,
            threshold=0.7,
            min_speech_duration_ms=500,
        )
        assert config.enabled is False
        assert config.threshold == 0.7
        assert config.min_speech_duration_ms == 500


class TestPreprocessingConfig:
    """Tests for PreprocessingConfig dataclass."""

    def test_default_values(self):
        """Test default preprocessing config."""
        config = PreprocessingConfig()
        assert config.target_sample_rate == 16000
        assert config.normalize is True
        assert isinstance(config.vad, VadConfig)
        assert isinstance(config.denoise, DenoiseConfig)

    def test_nested_defaults(self):
        """Test nested config defaults."""
        config = PreprocessingConfig()
        assert config.vad.enabled is True
        assert config.denoise.enabled is False


class TestInferenceConfig:
    """Tests for InferenceConfig dataclass."""

    def test_default_values(self):
        """Test default inference config."""
        config = InferenceConfig()
        assert config.batch_size == 16
        assert config.compute_type == "auto"
        assert config.device == "auto"
        assert config.beam_size == 5
        assert config.temperature == [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
        assert config.language is None
        assert config.compression_ratio_threshold == 2.4
        assert config.logprob_threshold == -1.0
        assert config.no_speech_threshold == 0.6
        assert config.no_repeat_ngram_size == 3

    def test_language_override(self):
        """Test language specification."""
        config = InferenceConfig(language="en")
        assert config.language == "en"

    def test_initial_prompt_default_none(self):
        """Test initial_prompt defaults to None."""
        config = InferenceConfig()
        assert config.initial_prompt is None

    def test_initial_prompt_set(self):
        """Test initial_prompt can be set to a UUID string."""
        config = InferenceConfig(initial_prompt="71000000-0000-0000-0000-000000000041")
        assert config.initial_prompt == "71000000-0000-0000-0000-000000000041"


class TestPostprocessingConfig:
    """Tests for PostprocessingConfig dataclass."""

    def test_default_values(self):
        """Test default postprocessing config."""
        config = PostprocessingConfig()
        assert config.remove_disfluencies is False
        assert config.lowercase is False
        assert config.timestamps.word_timestamps is True
        assert config.punctuation.enabled is True


class TestValidationResult:
    """Tests for ValidationResult dataclass."""

    def test_initially_valid(self):
        """Test initial valid state."""
        result = ValidationResult(valid=True)
        assert result.valid is True
        assert len(result.errors) == 0

    def test_add_error(self):
        """Test adding validation errors."""
        result = ValidationResult(valid=True)
        result.add_error("field1", "Error message 1")

        assert result.valid is False
        assert len(result.errors) == 1
        assert result.errors[0].field == "field1"
        assert result.errors[0].message == "Error message 1"

    def test_add_multiple_errors(self):
        """Test adding multiple errors."""
        result = ValidationResult(valid=True)
        result.add_error("field1", "Error 1")
        result.add_error("field2", "Error 2")

        assert len(result.errors) == 2
        assert result.valid is False

    def test_get_error_messages(self):
        """Test error message formatting."""
        result = ValidationResult(valid=True)
        result.add_error("models.asr", "ASR model required")
        result.add_error("inference.batch_size", "Invalid batch size")

        messages = result.get_error_messages()
        assert "models.asr: ASR model required" in messages
        assert "inference.batch_size: Invalid batch size" in messages


class TestAiModelConfig:
    """Tests for AiModelConfig dataclass."""

    def test_is_downloaded_property(self):
        """Test is_downloaded property."""
        config = AiModelConfig(
            id="m-1",
            tenant_id="t-1",
            slug="whisper",
            name="Whisper",
            description=None,
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.HUGGINGFACE,
            source_uri="openai/whisper-large-v3",
            source_revision=None,
            format=AiModelFormat.SAFETENSOR,
            memory_size_mb=3000,
            compute_type="float16",
            download_status=AiModelDownloadStatus.DOWNLOADED,
            local_path=os.path.join(_MODEL_BASE, "whisper"),
            downloaded_at=None,
            file_size_mb=3000,
            checksum=None,
            tags=[],
        )
        assert config.is_downloaded is True

    def test_is_not_downloaded(self):
        """Test is_downloaded when not downloaded."""
        config = AiModelConfig(
            id="m-1",
            tenant_id="t-1",
            slug="whisper",
            name="Whisper",
            description=None,
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.HUGGINGFACE,
            source_uri="openai/whisper-large-v3",
            source_revision=None,
            format=AiModelFormat.SAFETENSOR,
            memory_size_mb=None,
            compute_type=None,
            download_status=AiModelDownloadStatus.NOT_DOWNLOADED,
            local_path=None,
            downloaded_at=None,
            file_size_mb=None,
            checksum=None,
            tags=[],
        )
        assert config.is_downloaded is False

    def test_is_asr_property(self):
        """Test is_asr property."""
        asr_config = AiModelConfig(
            id="m-1",
            tenant_id="t-1",
            slug="whisper",
            name="Whisper",
            description=None,
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.HUGGINGFACE,
            source_uri="openai/whisper",
            source_revision=None,
            format=AiModelFormat.SAFETENSOR,
            memory_size_mb=None,
            compute_type=None,
            download_status=AiModelDownloadStatus.NOT_DOWNLOADED,
            local_path=None,
            downloaded_at=None,
            file_size_mb=None,
            checksum=None,
            tags=[],
        )
        assert asr_config.is_asr is True
        assert asr_config.is_vad is False

    def test_is_vad_property(self):
        """Test is_vad property."""
        vad_config = AiModelConfig(
            id="m-2",
            tenant_id="t-1",
            slug="silero-vad",
            name="Silero VAD",
            description=None,
            task_type=ModelTaskType.VOICE_ACTIVITY_DETECTION,
            source=AiModelSource.HUGGINGFACE,
            source_uri="silero/vad",
            source_revision=None,
            format=AiModelFormat.PYTORCH,
            memory_size_mb=None,
            compute_type=None,
            download_status=AiModelDownloadStatus.NOT_DOWNLOADED,
            local_path=None,
            downloaded_at=None,
            file_size_mb=None,
            checksum=None,
            tags=[],
        )
        assert vad_config.is_vad is True
        assert vad_config.is_asr is False


class TestPipelineConfig:
    """Tests for PipelineConfig dataclass."""

    @pytest.fixture
    def sample_pipeline_config(self):
        """Create a sample pipeline config with slug references."""
        spec = PipelineSpec(
            version="1.0",
            models=ModelRefs(
                asr=ModelRef(slug="whisper"),
                vad=ModelRef(slug="silero"),
            ),
            preprocessing=PreprocessingConfig(),
            inference=InferenceConfig(),
            postprocessing=PostprocessingConfig(),
        )
        from datetime import datetime

        return PipelineConfig(
            id="p-1",
            tenant_id="t-1",
            slug="default-pipeline",
            name="Default Pipeline",
            description="Test pipeline",
            spec=spec,
            tags=["test"],
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )

    @pytest.fixture
    def sample_inline_pipeline_config(self):
        """Create a sample pipeline config with inline model definitions."""
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
            ),
            preprocessing=PreprocessingConfig(),
            inference=InferenceConfig(),
            postprocessing=PostprocessingConfig(),
        )
        from datetime import datetime

        return PipelineConfig(
            id="p-2",
            tenant_id="t-1",
            slug="inline-pipeline",
            name="Inline Pipeline",
            description="Test pipeline with inline models",
            spec=spec,
            tags=["test", "inline"],
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )

    def test_get_required_model_slugs(self, sample_pipeline_config):
        """Test getting required model slugs."""
        slugs = sample_pipeline_config.get_required_model_slugs()
        assert "whisper" in slugs
        assert "silero" in slugs

    def test_get_required_model_slugs_inline_returns_empty(self, sample_inline_pipeline_config):
        """Test that inline models don't appear in get_required_model_slugs."""
        slugs = sample_inline_pipeline_config.get_required_model_slugs()
        # Inline models don't have slugs, so this should be empty
        assert len(slugs) == 0

    def test_inline_pipeline_has_inline_models(self, sample_inline_pipeline_config):
        """Test that inline pipeline correctly identifies inline models."""
        inline_models = sample_inline_pipeline_config.spec.models.get_inline_models()
        assert len(inline_models) == 2

        roles = [role for role, _ in inline_models]
        assert "asr" in roles
        assert "vad" in roles


class TestAiModelFormat:
    """Tests for AiModelFormat enum."""

    def test_all_format_values_exist(self):
        """Test all format values are accessible."""
        assert AiModelFormat.SAFETENSOR.value == "SAFETENSOR"
        assert AiModelFormat.ONNX.value == "ONNX"
        assert AiModelFormat.NEMO.value == "NEMO"
        assert AiModelFormat.PYTORCH.value == "PYTORCH"
        assert AiModelFormat.ONNX_OPTIMUM.value == "ONNX_OPTIMUM"
        assert AiModelFormat.CTRANSLATE2.value == "CTRANSLATE2"
        assert AiModelFormat.AZURE_SPEECH.value == "AZURE_SPEECH"

    def test_format_is_string_enum(self):
        """Test that format values can be used as strings."""
        assert str(AiModelFormat.ONNX) == "ONNX"
        assert AiModelFormat.ONNX == "ONNX"

    def test_azure_speech_format_is_string_enum(self):
        """Test that AZURE_SPEECH can be compared as string."""
        assert AiModelFormat.AZURE_SPEECH == "AZURE_SPEECH"


class TestModelTaskType:
    """Tests for ModelTaskType enum."""

    def test_all_task_types_exist(self):
        """Test all task types are accessible."""
        assert ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION.value == "AUTOMATIC_SPEECH_RECOGNITION"
        assert ModelTaskType.VOICE_ACTIVITY_DETECTION.value == "VOICE_ACTIVITY_DETECTION"
        assert ModelTaskType.AUDIO_DENOISING.value == "AUDIO_DENOISING"
        assert ModelTaskType.AUDIO_TO_AUDIO.value == "AUDIO_TO_AUDIO"
        assert ModelTaskType.SPEAKER_DIARIZATION.value == "SPEAKER_DIARIZATION"


# =============================================================================
# EDGE CASE TESTS
# =============================================================================


class TestInlineModelDefEdgeCases:
    """Edge case tests for InlineModelDef - testing boundary conditions."""

    def test_unicode_in_model_id(self):
        """Test handling of unicode characters in model ID."""
        inline = InlineModelDef(
            hf_model_id="test/模型-名称",  # Chinese characters
            engine=AiModelFormat.ONNX,
        )
        config = inline.to_ai_model_config(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION)
        # Should handle unicode gracefully in slug
        assert config.source_uri == "test/模型-名称"

    def test_very_long_model_id(self):
        """Test handling of very long model ID."""
        long_id = "org/" + "a" * 500  # Very long model ID
        inline = InlineModelDef(
            hf_model_id=long_id,
            engine=AiModelFormat.ONNX,
        )
        config = inline.to_ai_model_config(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION)
        assert config.source_uri == long_id
        # Slug is derived from model ID - verify it's generated (actual length depends on implementation)
        assert config.slug is not None
        assert len(config.slug) > 0

    def test_special_characters_in_version(self):
        """Test handling of special characters in version."""
        inline = InlineModelDef(
            hf_model_id="test/model",
            engine=AiModelFormat.ONNX,
            version="v1.0-beta+build.123",
        )
        config = inline.to_ai_model_config(ModelTaskType.VOICE_ACTIVITY_DETECTION)
        # Version should be preserved
        assert config.source_revision == "v1.0-beta+build.123"

    def test_empty_revision_vs_none(self):
        """Test empty string revision treated same as None."""
        inline_empty = InlineModelDef(
            hf_model_id="test/model",
            engine=AiModelFormat.ONNX,
            revision="",
        )
        inline_none = InlineModelDef(
            hf_model_id="test/model",
            engine=AiModelFormat.ONNX,
            revision=None,
        )
        config_empty = inline_empty.to_ai_model_config(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION)
        config_none = inline_none.to_ai_model_config(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION)
        # Both should result in None or empty revision
        assert (config_empty.source_revision or "") == (config_none.source_revision or "")

    def test_all_task_types_produce_valid_config(self):
        """Test conversion works for all task types."""
        inline = InlineModelDef(
            hf_model_id="test/model",
            engine=AiModelFormat.ONNX,
        )
        for task_type in ModelTaskType:
            config = inline.to_ai_model_config(task_type)
            assert config.task_type == task_type
            assert config.source_uri == "test/model"


class TestModelRefEdgeCases:
    """Edge case tests for ModelRef."""

    def test_empty_slug_string(self):
        """Test ModelRef with empty slug string."""
        ref = ModelRef(slug="")
        assert ref.is_inline is False
        assert ref.identifier == ""

    def test_whitespace_only_slug(self):
        """Test ModelRef with whitespace-only slug."""
        ref = ModelRef.from_value("   ")
        assert ref.slug == "   "
        assert ref.is_inline is False

    def test_inline_with_empty_hf_model_id(self):
        """Test inline definition with empty hf_model_id."""
        ref = ModelRef.from_value(
            {
                "hf_model_id": "",
                "engine": "onnx",
            }
        )
        assert ref.is_inline is True
        assert ref.inline.hf_model_id == ""
        assert ref.identifier == ""

    def test_engine_case_insensitivity(self):
        """Test that engine names are case-insensitive."""
        test_cases = [
            ("ONNX", AiModelFormat.ONNX),
            ("onnx", AiModelFormat.ONNX),
            ("Onnx", AiModelFormat.ONNX),
            ("SAFETENSOR", AiModelFormat.SAFETENSOR),
            ("safetensor", AiModelFormat.SAFETENSOR),
        ]
        for engine_str, expected_format in test_cases:
            ref = ModelRef.from_value({"hf_model_id": "test", "engine": engine_str})
            assert ref.inline.engine == expected_format, f"Failed for {engine_str}"

    def test_unknown_engine_raises(self):
        """TASK-505 P1 — unknown engine strings are a hard error.

        The old silent SAFETENSOR default meant a typo ('faster_wisper')
        loaded a completely different engine and failed obscurely at model
        load; misconfiguration must surface at parse/validate time.
        """
        with pytest.raises(ValueError, match="Unknown ASR engine 'unknown_engine'"):
            ModelRef.from_value(
                {
                    "hf_model_id": "test/model",
                    "engine": "unknown_engine",
                }
            )

    def test_missing_engine_key_still_defaults_to_safetensor(self):
        """Omitting the engine key keeps the documented SAFETENSOR default."""
        ref = ModelRef.from_value({"hf_model_id": "test/model"})
        assert ref.inline.engine == AiModelFormat.SAFETENSOR

    def test_dict_with_extra_fields_ignored(self):
        """Test that extra fields in dict are ignored."""
        ref = ModelRef.from_value(
            {
                "hf_model_id": "test/model",
                "engine": "onnx",
                "extra_field": "should_be_ignored",
                "another_field": 123,
            }
        )
        assert ref.inline.hf_model_id == "test/model"
        # Should not raise, extra fields ignored

    def test_numeric_value_raises_error(self):
        """Test that numeric value raises ValueError."""
        with pytest.raises(ValueError, match="Invalid model reference"):
            ModelRef.from_value(12345)

    def test_list_value_raises_error(self):
        """Test that list value raises ValueError."""
        with pytest.raises(ValueError, match="Invalid model reference"):
            ModelRef.from_value(["test", "model"])


class TestValidWhisperLanguages:
    """Tests for VALID_WHISPER_LANGUAGES set."""

    def test_contains_common_languages(self):
        """Test that common languages are in the set."""
        common = ["en", "es", "fr", "de", "zh", "ja", "ko", "ar", "hi", "ml"]
        for lang in common:
            assert lang in VALID_WHISPER_LANGUAGES, f"{lang} should be in VALID_WHISPER_LANGUAGES"

    def test_contains_three_letter_codes(self):
        """Test that 3-letter ISO 639-3 codes are in the set."""
        assert "yue" in VALID_WHISPER_LANGUAGES
        assert "haw" in VALID_WHISPER_LANGUAGES

    def test_does_not_contain_invalid_codes(self):
        """Test that invalid codes are not in the set."""
        invalid = ["xx", "zz", "abc", ""]
        for code in invalid:
            assert (
                code not in VALID_WHISPER_LANGUAGES
            ), f"{code!r} should not be in VALID_WHISPER_LANGUAGES"

    def test_total_count(self):
        """Test total number of supported languages."""
        assert len(VALID_WHISPER_LANGUAGES) == 100


class TestIsValidLanguageCode:
    """Tests for is_valid_language_code function."""

    def test_valid_bare_iso_code(self):
        """Test valid bare ISO code."""
        assert is_valid_language_code("en") is True

    def test_valid_bcp47_tag(self):
        """Test valid BCP-47 tags."""
        assert is_valid_language_code("en-US") is True
        assert is_valid_language_code("ml-IN") is True

    def test_valid_case_insensitive(self):
        """Test case insensitivity."""
        assert is_valid_language_code("EN") is True
        assert is_valid_language_code("En-us") is True

    def test_valid_three_letter_code(self):
        """Test valid 3-letter code."""
        assert is_valid_language_code("yue") is True

    def test_invalid_code(self):
        """Test invalid code."""
        assert is_valid_language_code("xx") is False

    def test_empty_string(self):
        """Test empty string."""
        assert is_valid_language_code("") is False

    def test_bcp47_with_invalid_primary(self):
        """Test BCP-47 tag with invalid primary subtag."""
        assert is_valid_language_code("xx-US") is False


class TestInferenceConfigCodeSwitching:
    """Tests for InferenceConfig code_switching field."""

    def test_code_switching_default_false(self):
        """Test code_switching defaults to False."""
        config = InferenceConfig()
        assert config.code_switching is False

    def test_code_switching_enabled(self):
        """Test code_switching can be enabled."""
        config = InferenceConfig(code_switching=True)
        assert config.code_switching is True

    def test_code_switching_with_language(self):
        """Test code_switching with language set."""
        config = InferenceConfig(language="en", code_switching=True)
        assert config.language == "en"
        assert config.code_switching is True

    def test_code_switching_without_language(self):
        """Test code_switching with language None."""
        config = InferenceConfig(code_switching=True, language=None)
        assert config.language is None
        assert config.code_switching is True


class TestModelRefsEdgeCases:
    """Edge case tests for ModelRefs collection."""

    def test_all_none_models(self):
        """Test ModelRefs with only ASR (required), others None."""
        refs = ModelRefs(
            asr=ModelRef(slug="whisper"),
            vad=None,
            denoise=None,
        )
        assert refs.get_all_slugs() == ["whisper"]
        assert len(refs.get_all_refs()) == 1
        assert len(refs.get_inline_models()) == 0

    def test_mixed_inline_and_slug_with_none(self):
        """Test mixed configuration with one None."""
        refs = ModelRefs(
            asr=ModelRef(
                inline=InlineModelDef(
                    hf_model_id="onnx-community/whisper",
                    engine=AiModelFormat.ONNX,
                )
            ),
            vad=None,
            denoise=ModelRef(slug="deepfilternet"),
        )
        slugs = refs.get_all_slugs()
        assert slugs == ["deepfilternet"]

        inline_models = refs.get_inline_models()
        assert len(inline_models) == 1
        assert inline_models[0][0] == "asr"


class TestPreprocessingConfigEdgeCases:
    """Edge case tests for PreprocessingConfig."""

    def test_boundary_sample_rates(self):
        """Test boundary sample rate values."""
        # Minimum supported
        config_min = PreprocessingConfig(target_sample_rate=8000)
        assert config_min.target_sample_rate == 8000

        # Maximum commonly supported
        config_max = PreprocessingConfig(target_sample_rate=48000)
        assert config_max.target_sample_rate == 48000

    def test_vad_threshold_boundaries(self):
        """Test VAD threshold boundary values."""
        # Minimum
        config_min = VadConfig(threshold=0.0)
        assert config_min.threshold == 0.0

        # Maximum
        config_max = VadConfig(threshold=1.0)
        assert config_max.threshold == 1.0


class TestInferenceConfigEdgeCases:
    """Edge case tests for InferenceConfig."""

    def test_minimum_batch_size(self):
        """Test minimum batch size."""
        config = InferenceConfig(batch_size=1)
        assert config.batch_size == 1

    def test_large_batch_size(self):
        """Test large batch size."""
        config = InferenceConfig(batch_size=64)
        assert config.batch_size == 64

    def test_temperature_zero(self):
        """Test zero temperature list (deterministic greedy decoding)."""
        config = InferenceConfig(temperature=[0.0])
        assert config.temperature == [0.0]

    def test_high_temperature(self):
        """Test high temperature list."""
        config = InferenceConfig(temperature=[2.0])
        assert config.temperature == [2.0]

    def test_temperature_fallback_list(self):
        """Temperature can be a list to drive Whisper's fallback loop."""
        config = InferenceConfig(temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0])
        assert config.temperature == [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]

    def test_threshold_triad_can_be_set(self):
        """compression_ratio/logprob/no_speech thresholds are configurable."""
        config = InferenceConfig(
            compression_ratio_threshold=2.4,
            logprob_threshold=-1.0,
            no_speech_threshold=0.6,
        )
        assert config.compression_ratio_threshold == 2.4
        assert config.logprob_threshold == -1.0
        assert config.no_speech_threshold == 0.6

    def test_no_repeat_ngram_size_configurable(self):
        """no_repeat_ngram_size is an exposed knob for Whisper decoding."""
        config = InferenceConfig(no_repeat_ngram_size=5)
        assert config.no_repeat_ngram_size == 5

    def test_beam_size_one(self):
        """Test beam size of 1 (greedy decoding)."""
        config = InferenceConfig(beam_size=1)
        assert config.beam_size == 1


class TestValidationResultEdgeCases:
    """Edge case tests for ValidationResult."""

    def test_many_errors(self):
        """Test adding many validation errors."""
        result = ValidationResult(valid=True)
        for i in range(100):
            result.add_error(f"field_{i}", f"Error message {i}")

        assert result.valid is False
        assert len(result.errors) == 100

    def test_same_field_multiple_errors(self):
        """Test multiple errors for the same field."""
        result = ValidationResult(valid=True)
        result.add_error("models.asr", "Error 1")
        result.add_error("models.asr", "Error 2")
        result.add_error("models.asr", "Error 3")

        assert len(result.errors) == 3
        assert all(e.field == "models.asr" for e in result.errors)

    def test_error_messages_contain_field_names(self):
        """Test that formatted error messages include field names."""
        result = ValidationResult(valid=True)
        result.add_error("preprocessing.vad.threshold", "Must be between 0 and 1")

        messages = result.get_error_messages()
        assert len(messages) == 1
        assert "preprocessing.vad.threshold" in messages[0]
        assert "Must be between 0 and 1" in messages[0]
