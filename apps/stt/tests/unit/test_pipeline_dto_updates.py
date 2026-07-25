"""Unit tests for updated Pipeline DTOs (diarization, KSERVE, and ONNX quantization)."""

from stt.pipeline.dto import (
    VALID_ONNX_QUANTIZATIONS,
    AiModelFormat,
    AiModelSource,
    DiarizationConfig,
    InferenceConfig,
    InlineModelDef,
    ModelRef,
    ModelRefs,
    ModelTaskType,
    PipelineSpec,
    PostprocessingConfig,
    PreprocessingConfig,
)

# =============================================================================
# DIARIZATION CONFIG TESTS
# =============================================================================


class TestDiarizationConfig:
    """Tests for DiarizationConfig dataclass."""

    def test_default_values(self):
        """Test default diarization configuration values."""
        config = DiarizationConfig()
        assert config.enabled is False
        assert config.high_threshold == 0.7
        assert config.low_threshold == 0.4
        assert config.max_speakers == 2
        assert config.min_segment_duration_s == 1.0

    def test_custom_values(self):
        """Test custom diarization configuration values."""
        config = DiarizationConfig(
            enabled=True,
            high_threshold=0.85,
            low_threshold=0.5,
            max_speakers=5,
            min_segment_duration_s=2.5,
        )
        assert config.enabled is True
        assert config.high_threshold == 0.85
        assert config.max_speakers == 5
        assert config.min_segment_duration_s == 2.5

    def test_partial_custom_values(self):
        """Test diarization config with partial custom values."""
        config = DiarizationConfig(
            enabled=True,
            max_speakers=3,
        )
        assert config.enabled is True
        assert config.max_speakers == 3
        # Other values should remain at defaults
        assert config.high_threshold == 0.7
        assert config.low_threshold == 0.4
        assert config.min_segment_duration_s == 1.0


# =============================================================================
# MODEL REFS WITH DIARIZATION TESTS
# =============================================================================


class TestModelRefsWithDiarization:
    """Tests for ModelRefs with embedding field (legacy: diarization)."""

    def test_get_all_refs_with_all_models_including_diarization(self):
        """Test get_all_refs() returns 4 refs when all models set (asr, vad, denoise, embedding)."""
        refs = ModelRefs(
            asr=ModelRef(slug="whisper-large-v3"),
            vad=ModelRef(slug="silero-vad"),
            denoise=ModelRef(slug="deepfilternet-v3"),
            embedding=ModelRef(slug="pyannote-embedding"),
        )
        all_refs = refs.get_all_refs()

        assert len(all_refs) == 4
        assert ("asr", refs.asr) in all_refs
        assert ("vad", refs.vad) in all_refs
        assert ("denoise", refs.denoise) in all_refs
        assert ("embedding", refs.embedding) in all_refs

    def test_get_all_refs_with_only_asr(self):
        """Test get_all_refs() returns 1 ref when only asr set."""
        refs = ModelRefs(
            asr=ModelRef(slug="whisper-large-v3"),
            vad=None,
            denoise=None,
            embedding=None,
        )
        all_refs = refs.get_all_refs()

        assert len(all_refs) == 1
        assert all_refs[0][0] == "asr"
        assert all_refs[0][1] == refs.asr

    def test_get_all_refs_with_asr_and_embedding(self):
        """Test get_all_refs() includes embedding when set."""
        refs = ModelRefs(
            asr=ModelRef(slug="whisper-large-v3"),
            vad=None,
            denoise=None,
            embedding=ModelRef(slug="pyannote-embedding"),
        )
        all_refs = refs.get_all_refs()

        assert len(all_refs) == 2
        roles = [role for role, _ in all_refs]
        assert "asr" in roles
        assert "embedding" in roles

    def test_get_all_slugs_includes_embedding_slug(self):
        """Test get_all_slugs() includes embedding slug."""
        refs = ModelRefs(
            asr=ModelRef(slug="whisper-large-v3"),
            vad=ModelRef(slug="silero-vad"),
            denoise=ModelRef(slug="deepfilternet-v3"),
            embedding=ModelRef(slug="pyannote-embedding"),
        )
        slugs = refs.get_all_slugs()

        assert len(slugs) == 4
        assert "whisper-large-v3" in slugs
        assert "silero-vad" in slugs
        assert "deepfilternet-v3" in slugs
        assert "pyannote-embedding" in slugs

    def test_get_all_slugs_excludes_embedding_when_none(self):
        """Test get_all_slugs() excludes embedding when None."""
        refs = ModelRefs(
            asr=ModelRef(slug="whisper-large-v3"),
            vad=ModelRef(slug="silero-vad"),
            denoise=ModelRef(slug="deepfilternet-v3"),
            embedding=None,
        )
        slugs = refs.get_all_slugs()

        assert len(slugs) == 3
        assert "whisper-large-v3" in slugs
        assert "silero-vad" in slugs
        assert "deepfilternet-v3" in slugs

    def test_get_all_slugs_excludes_embedding_inline(self):
        """Test get_all_slugs() excludes embedding when it's inline (not slug)."""
        inline_embedding = InlineModelDef(
            hf_model_id="pyannote/wespeaker-voxceleb-resnet34-LM",
            engine=AiModelFormat.SAFETENSOR,
        )
        refs = ModelRefs(
            asr=ModelRef(slug="whisper-large-v3"),
            vad=ModelRef(slug="silero-vad"),
            denoise=None,
            embedding=ModelRef(inline=inline_embedding),
        )
        slugs = refs.get_all_slugs()

        # Should only include slug-based models, not inline
        assert len(slugs) == 2
        assert "whisper-large-v3" in slugs
        assert "silero-vad" in slugs

    def test_get_inline_models_includes_embedding_inline(self):
        """Test get_inline_models() includes embedding inline definition."""
        inline_embedding = InlineModelDef(
            hf_model_id="pyannote/wespeaker-voxceleb-resnet34-LM",
            engine=AiModelFormat.SAFETENSOR,
        )
        inline_asr = InlineModelDef(
            hf_model_id="onnx-community/whisper-large-v3-turbo",
            engine=AiModelFormat.ONNX,
        )
        refs = ModelRefs(
            asr=ModelRef(inline=inline_asr),
            vad=ModelRef(slug="silero-vad"),  # Slug, not inline
            denoise=None,
            embedding=ModelRef(inline=inline_embedding),
        )
        inline_models = refs.get_inline_models()

        assert len(inline_models) == 2
        roles = [role for role, _ in inline_models]
        assert "asr" in roles
        assert "embedding" in roles

        # Verify the embedding inline model
        embedding_entry = next(
            (role, model) for role, model in inline_models if role == "embedding"
        )
        assert embedding_entry[1].hf_model_id == "pyannote/wespeaker-voxceleb-resnet34-LM"
        assert embedding_entry[1].engine == AiModelFormat.SAFETENSOR

    def test_get_inline_models_excludes_embedding_when_slug(self):
        """Test get_inline_models() excludes embedding when it's a slug reference."""
        refs = ModelRefs(
            asr=ModelRef(slug="whisper-large-v3"),
            vad=None,
            denoise=None,
            embedding=ModelRef(slug="pyannote-embedding"),
        )
        inline_models = refs.get_inline_models()

        assert len(inline_models) == 0

    def test_get_inline_models_excludes_embedding_when_none(self):
        """Test get_inline_models() excludes embedding when None."""
        inline_asr = InlineModelDef(
            hf_model_id="onnx-community/whisper-large-v3-turbo",
            engine=AiModelFormat.ONNX,
        )
        refs = ModelRefs(
            asr=ModelRef(inline=inline_asr),
            vad=None,
            denoise=None,
            embedding=None,
        )
        inline_models = refs.get_inline_models()

        assert len(inline_models) == 1
        assert inline_models[0][0] == "asr"

    def test_embedding_field_exists(self):
        """Test that embedding field exists on ModelRefs."""
        refs = ModelRefs(
            asr=ModelRef(slug="whisper-large-v3"),
            embedding=ModelRef(slug="pyannote-embedding"),
        )
        assert hasattr(refs, "embedding")
        assert refs.embedding is not None
        assert refs.embedding.slug == "pyannote-embedding"

    def test_embedding_field_is_optional(self):
        """Test that embedding field is optional (can be None)."""
        refs = ModelRefs(
            asr=ModelRef(slug="whisper-large-v3"),
            embedding=None,
        )
        assert refs.embedding is None


# =============================================================================
# PIPELINE SPEC WITH DIARIZATION TESTS
# =============================================================================


class TestPipelineSpecWithDiarization:
    """Tests for PipelineSpec with diarization field."""

    def test_default_diarization_config_disabled(self):
        """Test default diarization config (disabled)."""
        spec = PipelineSpec(
            version="1.0",
            models=ModelRefs(asr=ModelRef(slug="whisper-large-v3")),
            preprocessing=PreprocessingConfig(),
            inference=InferenceConfig(),
            postprocessing=PostprocessingConfig(),
        )
        assert hasattr(spec, "diarization")
        assert isinstance(spec.diarization, DiarizationConfig)
        assert spec.diarization.enabled is False
        assert spec.diarization.high_threshold == 0.7
        assert spec.diarization.max_speakers == 2
        assert spec.diarization.low_threshold == 0.4
        assert spec.diarization.min_segment_duration_s == 1.0

    def test_custom_diarization_config(self):
        """Test custom diarization config."""
        custom_diarization = DiarizationConfig(
            enabled=True,
            high_threshold=0.85,
            max_speakers=5,
            low_threshold=0.5,
            min_segment_duration_s=2.5,
        )
        spec = PipelineSpec(
            version="1.0",
            models=ModelRefs(asr=ModelRef(slug="whisper-large-v3")),
            preprocessing=PreprocessingConfig(),
            inference=InferenceConfig(),
            postprocessing=PostprocessingConfig(),
            diarization=custom_diarization,
        )
        assert spec.diarization.enabled is True
        assert spec.diarization.high_threshold == 0.85
        assert spec.diarization.max_speakers == 5
        assert spec.diarization.low_threshold == 0.5
        assert spec.diarization.min_segment_duration_s == 2.5

    def test_pipeline_spec_with_diarization_model_and_config(self):
        """Test PipelineSpec with both embedding model and diarization config."""
        spec = PipelineSpec(
            version="1.0",
            models=ModelRefs(
                asr=ModelRef(slug="whisper-large-v3"),
                embedding=ModelRef(slug="pyannote-embedding"),
            ),
            preprocessing=PreprocessingConfig(),
            inference=InferenceConfig(),
            postprocessing=PostprocessingConfig(),
            diarization=DiarizationConfig(
                enabled=True,
                high_threshold=0.8,
                max_speakers=3,
            ),
        )
        # Both model and config should be set
        assert spec.models.embedding is not None
        assert spec.models.embedding.slug == "pyannote-embedding"
        assert spec.diarization.enabled is True
        assert spec.diarization.high_threshold == 0.8
        assert spec.diarization.max_speakers == 3


# =============================================================================
# AI MODEL SOURCE TESTS
# =============================================================================


class TestAiModelSource:
    """Tests for AiModelSource enum."""

    def test_kserve_enum_value_exists(self):
        """Test KSERVE enum value exists."""
        assert hasattr(AiModelSource, "KSERVE")
        assert AiModelSource.KSERVE.value == "KSERVE"
        assert AiModelSource.KSERVE == "KSERVE"

    def test_mlflow_enum_value_exists(self):
        """Test MLFLOW enum value exists."""
        assert hasattr(AiModelSource, "MLFLOW")
        assert AiModelSource.MLFLOW.value == "MLFLOW"
        assert AiModelSource.MLFLOW == "MLFLOW"

    def test_all_source_values_exist(self):
        """Test all source enum values are accessible."""
        assert AiModelSource.HUGGINGFACE.value == "HUGGINGFACE"
        assert AiModelSource.GITHUB.value == "GITHUB"
        assert AiModelSource.MLFLOW.value == "MLFLOW"
        assert AiModelSource.KSERVE.value == "KSERVE"
        assert AiModelSource.LOCAL.value == "LOCAL"

    def test_s3_enum_value_exists(self):
        """S3/MinIO-compatible object storage source."""
        assert hasattr(AiModelSource, "S3")
        assert AiModelSource.S3.value == "S3"
        assert AiModelSource.S3 == "S3"

    def test_kserve_is_string_enum(self):
        """Test that KSERVE can be compared as string."""
        assert AiModelSource.KSERVE == "KSERVE"
        assert str(AiModelSource.KSERVE) == "KSERVE"

    def test_mlflow_is_string_enum(self):
        """Test that MLFLOW can be compared as string."""
        assert AiModelSource.MLFLOW == "MLFLOW"
        assert str(AiModelSource.MLFLOW) == "MLFLOW"


# =============================================================================
# ONNX QUANTIZATION AND SUBFOLDER TESTS
# =============================================================================


class TestInlineModelDefQuantization:
    """Tests for InlineModelDef quantization and subfolder fields."""

    def test_default_quantization_is_none(self):
        """Test that quantization defaults to None (fp32)."""
        model = InlineModelDef(
            hf_model_id="onnx-community/whisper-large-v3-turbo_timestamped",
            engine=AiModelFormat.ONNX,
        )
        assert model.quantization is None
        assert model.subfolder is None

    def test_set_quantization_q4(self):
        """Test setting quantization to q4."""
        model = InlineModelDef(
            hf_model_id="onnx-community/whisper-large-v3-turbo_timestamped",
            engine=AiModelFormat.ONNX,
            quantization="q4",
        )
        assert model.quantization == "q4"

    def test_set_subfolder_onnx(self):
        """Test setting subfolder to 'onnx'."""
        model = InlineModelDef(
            hf_model_id="onnx-community/whisper-large-v3-turbo_timestamped",
            engine=AiModelFormat.ONNX,
            subfolder="onnx",
        )
        assert model.subfolder == "onnx"

    def test_quantization_and_subfolder_together(self):
        """Test setting both quantization and subfolder."""
        model = InlineModelDef(
            hf_model_id="onnx-community/whisper-large-v3-turbo_timestamped",
            engine=AiModelFormat.ONNX,
            quantization="q4f16",
            subfolder="onnx",
        )
        assert model.quantization == "q4f16"
        assert model.subfolder == "onnx"

    def test_to_ai_model_config_passes_quantization(self):
        """Test that to_ai_model_config propagates quantization field."""
        model = InlineModelDef(
            hf_model_id="onnx-community/whisper-large-v3-turbo_timestamped",
            engine=AiModelFormat.ONNX,
            quantization="fp16",
            subfolder="onnx",
        )
        config = model.to_ai_model_config(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION)

        assert config.quantization == "fp16"
        assert config.subfolder == "onnx"
        assert config.source_uri == "onnx-community/whisper-large-v3-turbo_timestamped"
        assert config.format == AiModelFormat.ONNX

    def test_to_ai_model_config_slug_includes_quantization(self):
        """Test that the generated slug includes the quantization variant."""
        model = InlineModelDef(
            hf_model_id="onnx-community/whisper-large-v3-turbo_timestamped",
            engine=AiModelFormat.ONNX,
            quantization="q4",
        )
        config = model.to_ai_model_config(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION)

        assert "q4" in config.slug
        assert config.slug == "onnx-community--whisper-large-v3-turbo_timestamped-q4"

    def test_to_ai_model_config_slug_without_quantization(self):
        """Test slug generation without quantization (no suffix)."""
        model = InlineModelDef(
            hf_model_id="onnx-community/whisper-large-v3-turbo_timestamped",
            engine=AiModelFormat.ONNX,
        )
        config = model.to_ai_model_config(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION)

        assert config.slug == "onnx-community--whisper-large-v3-turbo_timestamped"
        assert config.quantization is None

    def test_to_ai_model_config_defaults_for_quantization_and_subfolder(self):
        """Test that quantization and subfolder default to None in AiModelConfig."""
        model = InlineModelDef(
            hf_model_id="openai/whisper-small",
            engine=AiModelFormat.SAFETENSOR,
        )
        config = model.to_ai_model_config(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION)

        assert config.quantization is None
        assert config.subfolder is None


class TestModelRefFromValueQuantization:
    """Tests for ModelRef.from_value() parsing quantization/subfolder fields."""

    def test_parse_inline_with_quantization(self):
        """Test parsing inline definition with quantization from dict."""
        ref = ModelRef.from_value(
            {
                "hf_model_id": "onnx-community/whisper-large-v3-turbo_timestamped",
                "engine": "onnx",
                "quantization": "q4",
                "subfolder": "onnx",
            }
        )

        assert ref.is_inline
        assert ref.inline is not None
        assert ref.inline.quantization == "q4"
        assert ref.inline.subfolder == "onnx"
        assert ref.inline.hf_model_id == "onnx-community/whisper-large-v3-turbo_timestamped"
        assert ref.inline.engine == AiModelFormat.ONNX

    def test_parse_inline_without_quantization(self):
        """Test parsing inline definition without quantization (backward compat)."""
        ref = ModelRef.from_value(
            {
                "hf_model_id": "onnx-community/whisper-small-ONNX",
                "engine": "onnx",
            }
        )

        assert ref.is_inline
        assert ref.inline is not None
        assert ref.inline.quantization is None
        assert ref.inline.subfolder is None

    def test_parse_inline_with_all_fields(self):
        """Test parsing inline definition with all optional fields."""
        ref = ModelRef.from_value(
            {
                "hf_model_id": "onnx-community/whisper-large-v3-turbo_timestamped",
                "engine": "onnx",
                "revision": "main",
                "quantization": "int8",
                "subfolder": "onnx",
                "compute_type": "float32",
                "device": "cpu",
            }
        )

        assert ref.inline is not None
        assert ref.inline.quantization == "int8"
        assert ref.inline.subfolder == "onnx"
        assert ref.inline.revision == "main"
        assert ref.inline.compute_type == "float32"
        assert ref.inline.device == "cpu"

    def test_string_slug_unaffected_by_quantization_feature(self):
        """Test that string slug references still work unchanged."""
        ref = ModelRef.from_value("whisper-large-v3")

        assert not ref.is_inline
        assert ref.slug == "whisper-large-v3"
        assert ref.inline is None


class TestValidOnnxQuantizations:
    """Tests for VALID_ONNX_QUANTIZATIONS constant."""

    def test_valid_quantizations_are_all_present(self):
        """Test that all expected quantization variants are defined."""
        expected = ["fp16", "int8", "uint8", "q4", "q4f16", "bnb4", "quantized"]
        for q in expected:
            assert q in VALID_ONNX_QUANTIZATIONS, f"Missing quantization: {q}"

    def test_quantization_list_is_not_empty(self):
        """Test that the quantization list has entries."""
        assert len(VALID_ONNX_QUANTIZATIONS) >= 7


class TestONNXLoaderQuantizedFileNames:
    """Tests for ONNXLoader._resolve_quantized_file_names static method."""

    def test_resolve_q4_file_names(self):
        """Test q4 quantization resolves correct file names."""
        from stt.models.onnx_loader import ONNXLoader

        result = ONNXLoader._resolve_quantized_file_names("q4")
        assert result == {
            "encoder_file_name": "encoder_model_q4.onnx",
            "decoder_file_name": "decoder_model_merged_q4.onnx",
            "decoder_with_past_file_name": "decoder_model_merged_q4.onnx",
        }

    def test_resolve_fp16_file_names(self):
        """Test fp16 quantization resolves correct file names."""
        from stt.models.onnx_loader import ONNXLoader

        result = ONNXLoader._resolve_quantized_file_names("fp16")
        assert result == {
            "encoder_file_name": "encoder_model_fp16.onnx",
            "decoder_file_name": "decoder_model_merged_fp16.onnx",
            "decoder_with_past_file_name": "decoder_model_merged_fp16.onnx",
        }

    def test_resolve_q4f16_file_names(self):
        """Test q4f16 quantization resolves correct file names."""
        from stt.models.onnx_loader import ONNXLoader

        result = ONNXLoader._resolve_quantized_file_names("q4f16")
        assert result == {
            "encoder_file_name": "encoder_model_q4f16.onnx",
            "decoder_file_name": "decoder_model_merged_q4f16.onnx",
            "decoder_with_past_file_name": "decoder_model_merged_q4f16.onnx",
        }

    def test_resolve_int8_file_names(self):
        """Test int8 quantization resolves correct file names."""
        from stt.models.onnx_loader import ONNXLoader

        result = ONNXLoader._resolve_quantized_file_names("int8")
        assert result == {
            "encoder_file_name": "encoder_model_int8.onnx",
            "decoder_file_name": "decoder_model_merged_int8.onnx",
            "decoder_with_past_file_name": "decoder_model_merged_int8.onnx",
        }

    def test_resolve_bnb4_file_names(self):
        """Test bnb4 quantization resolves correct file names."""
        from stt.models.onnx_loader import ONNXLoader

        result = ONNXLoader._resolve_quantized_file_names("bnb4")
        assert result == {
            "encoder_file_name": "encoder_model_bnb4.onnx",
            "decoder_file_name": "decoder_model_merged_bnb4.onnx",
            "decoder_with_past_file_name": "decoder_model_merged_bnb4.onnx",
        }

    def test_decoder_with_past_matches_decoder(self):
        """Test that decoder_with_past_file_name always matches decoder_file_name for merged models."""
        from stt.models.onnx_loader import ONNXLoader

        for quant in ["fp16", "int8", "q4", "q4f16", "bnb4", "uint8", "quantized"]:
            result = ONNXLoader._resolve_quantized_file_names(quant)
            assert result["decoder_with_past_file_name"] == result["decoder_file_name"], (
                f"For {quant}: decoder_with_past_file_name should equal decoder_file_name "
                f"(both point to the merged decoder)"
            )

    def test_resolve_none_returns_empty_dict(self):
        """Test None quantization returns empty dict (use defaults)."""
        from stt.models.onnx_loader import ONNXLoader

        result = ONNXLoader._resolve_quantized_file_names(None)
        assert result == {}

    def test_resolve_empty_string_returns_empty_dict(self):
        """Test empty string quantization returns empty dict."""
        from stt.models.onnx_loader import ONNXLoader

        result = ONNXLoader._resolve_quantized_file_names("")
        assert result == {}


class TestONNXLoaderSubfolderResolution:
    """Tests for ONNXLoader._resolve_subfolder method."""

    def _make_config(self, source_uri: str, subfolder: str | None = None):
        """Helper to create a minimal AiModelConfig for subfolder tests."""
        from stt.pipeline.dto import (
            AiModelConfig,
            AiModelDownloadStatus,
        )

        return AiModelConfig(
            id="test",
            tenant_id=None,
            slug="test-model",
            name="Test Model",
            description=None,
            task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
            source=AiModelSource.HUGGINGFACE,
            source_uri=source_uri,
            source_revision="main",
            format=AiModelFormat.ONNX,
            memory_size_mb=None,
            compute_type=None,
            download_status=AiModelDownloadStatus.NOT_DOWNLOADED,
            local_path=None,
            downloaded_at=None,
            file_size_mb=None,
            checksum=None,
            tags=[],
            subfolder=subfolder,
        )

    def test_auto_detect_onnx_subfolder_for_onnx_community(self):
        """Test auto-detection of 'onnx' subfolder for onnx-community repos."""
        from stt.models.onnx_loader import ONNXLoader

        loader = ONNXLoader()
        config = self._make_config("onnx-community/whisper-large-v3-turbo_timestamped")
        assert loader._resolve_subfolder(config) == "onnx"

    def test_explicit_subfolder_overrides_auto_detect(self):
        """Test that explicit subfolder takes precedence over auto-detection."""
        from stt.models.onnx_loader import ONNXLoader

        loader = ONNXLoader()
        config = self._make_config(
            "onnx-community/whisper-large-v3-turbo_timestamped",
            subfolder="custom",
        )
        assert loader._resolve_subfolder(config) == "custom"

    def test_no_subfolder_for_non_onnx_community(self):
        """Test that non onnx-community repos get empty subfolder."""
        from stt.models.onnx_loader import ONNXLoader

        loader = ONNXLoader()
        config = self._make_config("openai/whisper-large-v3")
        assert loader._resolve_subfolder(config) == ""

    def test_explicit_subfolder_for_non_onnx_community(self):
        """Test explicit subfolder for non onnx-community repos."""
        from stt.models.onnx_loader import ONNXLoader

        loader = ONNXLoader()
        config = self._make_config("some-org/some-model", subfolder="onnx")
        assert loader._resolve_subfolder(config) == "onnx"


# =============================================================================
# DIARIZATION CONFIG — SILENCE PADDING
# =============================================================================


class TestDiarizationConfigSilencePadding:
    """Tests for DiarizationConfig.segment_silence_padding_ms."""

    def test_default_silence_padding_is_100(self):
        """Default segment_silence_padding_ms should be 100."""
        from stt.pipeline.dto import DiarizationConfig

        config = DiarizationConfig()
        assert config.segment_silence_padding_ms == 100

    def test_custom_silence_padding(self):
        """Custom silence padding value is stored correctly."""
        from stt.pipeline.dto import DiarizationConfig

        config = DiarizationConfig(segment_silence_padding_ms=250)
        assert config.segment_silence_padding_ms == 250

    def test_zero_silence_padding(self):
        """Zero padding effectively disables the feature."""
        from stt.pipeline.dto import DiarizationConfig

        config = DiarizationConfig(segment_silence_padding_ms=0)
        assert config.segment_silence_padding_ms == 0

    def test_existing_fields_unchanged(self):
        """Adding the new field does not alter existing defaults."""
        from stt.pipeline.dto import DiarizationConfig

        config = DiarizationConfig()
        assert config.enabled is False
        assert config.high_threshold == 0.7
        assert config.max_speakers == 2
        assert config.low_threshold == 0.4
        assert config.min_segment_duration_s == 1.0


# =============================================================================
# PIPELINE SPEC __post_init__ COMPUTE TYPE INHERITANCE (Step 8)
# =============================================================================


class TestPipelineSpecComputeTypeInheritance:
    """Tests for PipelineSpec.__post_init__ compute_type propagation."""

    def test_inherits_compute_type_to_inline_models(self):
        spec = PipelineSpec(
            version="1.0",
            models=ModelRefs(
                asr=ModelRef(
                    inline=InlineModelDef(
                        hf_model_id="openai/whisper-large-v3",
                        engine=AiModelFormat.SAFETENSOR,
                        compute_type=None,
                    )
                ),
            ),
            preprocessing=PreprocessingConfig(),
            inference=InferenceConfig(compute_type="float16"),
            postprocessing=PostprocessingConfig(),
        )
        inline_models = spec.models.get_inline_models()
        assert len(inline_models) == 1
        assert inline_models[0][1].compute_type == "float16"

    def test_does_not_override_explicit_compute_type(self):
        spec = PipelineSpec(
            version="1.0",
            models=ModelRefs(
                asr=ModelRef(
                    inline=InlineModelDef(
                        hf_model_id="openai/whisper-large-v3",
                        engine=AiModelFormat.SAFETENSOR,
                        compute_type="float32",
                    )
                ),
            ),
            preprocessing=PreprocessingConfig(),
            inference=InferenceConfig(compute_type="float16"),
            postprocessing=PostprocessingConfig(),
        )
        inline_models = spec.models.get_inline_models()
        assert inline_models[0][1].compute_type == "float32"

    def test_auto_does_not_propagate(self):
        spec = PipelineSpec(
            version="1.0",
            models=ModelRefs(
                asr=ModelRef(
                    inline=InlineModelDef(
                        hf_model_id="openai/whisper-large-v3",
                        engine=AiModelFormat.SAFETENSOR,
                        compute_type=None,
                    )
                ),
            ),
            preprocessing=PreprocessingConfig(),
            inference=InferenceConfig(compute_type="auto"),
            postprocessing=PostprocessingConfig(),
        )
        inline_models = spec.models.get_inline_models()
        assert inline_models[0][1].compute_type is None

    def test_slug_models_not_affected(self):
        spec = PipelineSpec(
            version="1.0",
            models=ModelRefs(
                asr=ModelRef(slug="whisper-large"),
            ),
            preprocessing=PreprocessingConfig(),
            inference=InferenceConfig(compute_type="float16"),
            postprocessing=PostprocessingConfig(),
        )
        inline_models = spec.models.get_inline_models()
        assert len(inline_models) == 0
