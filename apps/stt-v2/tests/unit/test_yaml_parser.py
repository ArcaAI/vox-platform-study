"""Unit tests for YAML parser."""

import logging

import pytest

from stt_v2.pipeline.dto import AiModelFormat, InferenceConfig
from stt_v2.pipeline.yaml_parser import PipelineYamlParser, get_yaml_parser


class TestPipelineYamlParser:
    """Tests for PipelineYamlParser."""

    @pytest.fixture
    def parser(self):
        """Get parser instance."""
        return PipelineYamlParser()

    @pytest.fixture
    def minimal_yaml(self):
        """Minimal valid YAML configuration."""
        return """
version: "1.0"
models:
  asr: whisper-large-v3
"""

    @pytest.fixture
    def full_yaml(self):
        """Full YAML configuration with all options."""
        return """
version: "1.0"
models:
  asr: whisper-large-v3
  vad: silero-vad-v4
  denoise: denoiser-v1

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.6
    min_speech_duration_ms: 300
    min_silence_duration_ms: 150
    padding_ms: 50
  denoise:
    enabled: true
    strength: 0.7

inference:
  batch_size: 32
  compute_type: float16
  device: cuda
  num_workers: 8
  beam_size: 3
  temperature: 0.1
  language: en

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
    model: custom-punct
  remove_disfluencies: true
  lowercase: true
"""

    def test_parse_minimal_yaml(self, parser, minimal_yaml):
        """Test parsing minimal configuration."""
        spec = parser.parse(minimal_yaml)

        assert spec.version == "1.0"
        assert spec.models.asr.slug == "whisper-large-v3"
        assert spec.models.asr.is_inline is False
        assert spec.models.vad is None
        assert spec.models.denoise is None

    def test_parse_full_yaml(self, parser, full_yaml):
        """Test parsing full configuration."""
        spec = parser.parse(full_yaml)

        # Check models - slug references
        assert spec.models.asr.slug == "whisper-large-v3"
        assert spec.models.asr.is_inline is False
        assert spec.models.vad.slug == "silero-vad-v4"
        assert spec.models.denoise.slug == "denoiser-v1"

        # Check preprocessing
        assert spec.preprocessing.target_sample_rate == 16000
        assert spec.preprocessing.normalize is True
        assert spec.preprocessing.vad.enabled is True
        assert spec.preprocessing.vad.threshold == 0.6
        assert spec.preprocessing.denoise.enabled is True
        assert spec.preprocessing.denoise.strength == 0.7

        # Check inference
        assert spec.inference.batch_size == 32
        assert spec.inference.compute_type == "float16"
        assert spec.inference.device == "cuda"
        assert spec.inference.language == "en"

        # Check postprocessing
        assert spec.postprocessing.timestamps.word_timestamps is True
        assert spec.postprocessing.punctuation.enabled is True
        assert spec.postprocessing.remove_disfluencies is True
        assert spec.postprocessing.lowercase is True

    def test_parse_uses_defaults(self, parser, minimal_yaml):
        """Test that defaults are applied for missing sections."""
        spec = parser.parse(minimal_yaml)

        # Check preprocessing defaults
        assert spec.preprocessing.target_sample_rate == 16000
        assert spec.preprocessing.vad.enabled is True
        assert spec.preprocessing.vad.threshold == 0.6

        # Check inference defaults
        assert spec.inference.batch_size == 16
        assert spec.inference.device == "auto"

    def test_parse_invalid_yaml_syntax(self, parser):
        """Test parsing invalid YAML syntax."""
        invalid_yaml = """
version: "1.0"
models:
  asr: whisper
  invalid_indent
    nested: value
"""
        with pytest.raises(ValueError, match="Invalid YAML syntax"):
            parser.parse(invalid_yaml)

    def test_parse_missing_models_section(self, parser):
        """Test parsing YAML without models section."""
        yaml_without_models = """
version: "1.0"
inference:
  batch_size: 16
"""
        with pytest.raises(ValueError, match="Missing required 'models' section"):
            parser.parse(yaml_without_models)

    def test_parse_non_dict_yaml(self, parser):
        """Test parsing YAML that is not a dict."""
        list_yaml = "- item1\n- item2"
        with pytest.raises(ValueError, match="YAML must be a dictionary"):
            parser.parse(list_yaml)


class TestVersion11InlineModels:
    """Tests for Version 1.1 YAML parsing with inline model definitions."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    @pytest.fixture
    def inline_yaml(self):
        """YAML with inline model definitions."""
        return """
version: "1.1"
models:
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo"
    engine: "onnx"
    revision: "main"
  vad:
    hf_model_id: "snakers4/silero-vad"
    engine: "onnx"
    version: "main"
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
"""

    @pytest.fixture
    def mixed_yaml(self):
        """YAML with mixed slug and inline model definitions."""
        return """
version: "1.1"
models:
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo"
    engine: "onnx"
  vad: "silero-vad-v6"
  denoise: "deepfilternet-v3"
"""

    def test_parse_inline_asr_model(self, parser, inline_yaml):
        """Test parsing inline ASR model definition."""
        spec = parser.parse(inline_yaml)

        assert spec.version == "1.1"
        assert spec.models.asr.is_inline is True
        assert spec.models.asr.inline is not None
        assert spec.models.asr.inline.hf_model_id == "onnx-community/whisper-large-v3-turbo"
        assert spec.models.asr.inline.engine == AiModelFormat.ONNX
        assert spec.models.asr.inline.revision == "main"

    def test_parse_inline_vad_model(self, parser, inline_yaml):
        """Test parsing inline VAD model definition."""
        spec = parser.parse(inline_yaml)

        assert spec.models.vad.is_inline is True
        assert spec.models.vad.inline.hf_model_id == "snakers4/silero-vad"
        assert spec.models.vad.inline.version == "main"

    def test_parse_inline_denoise_model(self, parser, inline_yaml):
        """Test parsing inline denoise model definition."""
        spec = parser.parse(inline_yaml)

        assert spec.models.denoise.is_inline is True
        assert spec.models.denoise.inline.hf_model_id == "nickolay/rnnoise"

    def test_parse_mixed_slug_and_inline(self, parser, mixed_yaml):
        """Test parsing YAML with mixed slug and inline definitions."""
        spec = parser.parse(mixed_yaml)

        # ASR should be inline
        assert spec.models.asr.is_inline is True
        assert spec.models.asr.inline.hf_model_id == "onnx-community/whisper-large-v3-turbo"

        # VAD should be slug
        assert spec.models.vad.is_inline is False
        assert spec.models.vad.slug == "silero-vad-v6"

        # Denoise should be slug
        assert spec.models.denoise.is_inline is False
        assert spec.models.denoise.slug == "deepfilternet-v3"

    def test_parse_inline_with_compute_type(self, parser):
        """Test parsing inline model with compute_type override."""
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "test/model"
    engine: "onnx"
    compute_type: "float16"
    device: "cuda"
"""
        spec = parser.parse(yaml_content)

        assert spec.models.asr.inline.compute_type == "float16"
        assert spec.models.asr.inline.device == "cuda"

    def test_parse_inline_engine_normalization(self, parser):
        """Test that different engine names are normalized correctly."""
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "test/model"
    engine: "transformers"
"""
        spec = parser.parse(yaml_content)

        # "transformers" should map to SAFETENSOR
        assert spec.models.asr.inline.engine == AiModelFormat.SAFETENSOR

    def test_get_all_slugs_inline_models_excluded(self, parser, inline_yaml):
        """Test that get_all_slugs excludes inline models."""
        spec = parser.parse(inline_yaml)
        slugs = spec.models.get_all_slugs()

        # All models are inline, so slugs should be empty
        assert len(slugs) == 0

    def test_get_inline_models_returns_all_inline(self, parser, inline_yaml):
        """Test that get_inline_models returns all inline definitions."""
        spec = parser.parse(inline_yaml)
        inline_models = spec.models.get_inline_models()

        assert len(inline_models) == 3
        roles = [role for role, _ in inline_models]
        assert "asr" in roles
        assert "vad" in roles
        assert "denoise" in roles

    def test_get_inline_models_mixed(self, parser, mixed_yaml):
        """Test get_inline_models with mixed configuration."""
        spec = parser.parse(mixed_yaml)
        inline_models = spec.models.get_inline_models()

        # Only ASR is inline
        assert len(inline_models) == 1
        assert inline_models[0][0] == "asr"


class TestValidation:
    """Tests for pipeline validation."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    def test_validate_valid_spec(self, parser):
        """Test validation of a valid spec."""
        yaml = """
version: "1.0"
models:
  asr: whisper-large-v3
"""
        spec = parser.parse(yaml)
        result = parser.validate(spec)

        assert result.valid is True
        assert len(result.errors) == 0

    def test_validate_unsupported_version(self, parser):
        """Test validation with unsupported version."""
        yaml = """
version: "2.0"
models:
  asr: whisper
"""
        spec = parser.parse(yaml)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("version" in e.field for e in result.errors)

    def test_validate_empty_asr_model(self, parser):
        """Test validation with empty ASR model."""
        yaml = """
version: "1.0"
models:
  asr: ""
"""
        spec = parser.parse(yaml)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("asr" in e.field for e in result.errors)

    def test_validate_invalid_vad_threshold(self, parser):
        """Test validation with invalid VAD threshold."""
        yaml = """
version: "1.0"
models:
  asr: whisper
preprocessing:
  vad:
    threshold: 1.5
"""
        spec = parser.parse(yaml)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("threshold" in e.field for e in result.errors)

    def test_validate_invalid_sample_rate(self, parser):
        """Test validation with invalid sample rate."""
        yaml = """
version: "1.0"
models:
  asr: whisper
preprocessing:
  target_sample_rate: 12345
"""
        spec = parser.parse(yaml)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("sample_rate" in e.field for e in result.errors)

    def test_validate_invalid_batch_size(self, parser):
        """Test validation with invalid batch size."""
        yaml = """
version: "1.0"
models:
  asr: whisper
inference:
  batch_size: 100
"""
        spec = parser.parse(yaml)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("batch_size" in e.field for e in result.errors)

    def test_validate_invalid_compute_type(self, parser):
        """Test validation with invalid compute type."""
        yaml = """
version: "1.0"
models:
  asr: whisper
inference:
  compute_type: float64
"""
        spec = parser.parse(yaml)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("compute_type" in e.field for e in result.errors)

    def test_validate_invalid_device(self, parser):
        """Test validation with invalid device."""
        yaml = """
version: "1.0"
models:
  asr: whisper
inference:
  device: tpu
"""
        spec = parser.parse(yaml)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("device" in e.field for e in result.errors)


class TestInlineValidation:
    """Tests for validation of inline model definitions."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    def test_validate_valid_inline_spec(self, parser):
        """Test validation of valid inline spec."""
        yaml = """
version: "1.1"
models:
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo"
    engine: "onnx"
"""
        spec = parser.parse(yaml)
        result = parser.validate(spec)

        assert result.valid is True
        assert len(result.errors) == 0

    def test_validate_inline_missing_hf_model_id(self, parser):
        """Test validation fails when inline model has empty hf_model_id."""
        yaml = """
version: "1.1"
models:
  asr:
    hf_model_id: ""
    engine: "onnx"
"""
        spec = parser.parse(yaml)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("hf_model_id" in e.field for e in result.errors)

    def test_validate_inline_vad_missing_hf_model_id(self, parser):
        """Test validation fails when inline VAD model has empty hf_model_id."""
        yaml = """
version: "1.1"
models:
  asr: "whisper-large-v3"
  vad:
    hf_model_id: ""
    engine: "onnx"
"""
        spec = parser.parse(yaml)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("vad" in e.field for e in result.errors)

    def test_validate_inline_denoise_missing_hf_model_id(self, parser):
        """Test validation fails when inline denoise model has empty hf_model_id."""
        yaml = """
version: "1.1"
models:
  asr: "whisper-large-v3"
  denoise:
    hf_model_id: ""
    engine: "onnx"
"""
        spec = parser.parse(yaml)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("denoise" in e.field for e in result.errors)

    def test_validate_version_11_supported(self, parser):
        """Test that version 1.1 is supported."""
        yaml = """
version: "1.1"
models:
  asr:
    hf_model_id: "test/model"
    engine: "onnx"
"""
        spec = parser.parse(yaml)
        result = parser.validate(spec)

        assert result.valid is True


class TestExtractModelSlugs:
    """Tests for model slug extraction."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    def test_extract_single_model(self, parser):
        """Test extracting single model slug."""
        yaml = """
version: "1.0"
models:
  asr: whisper
"""
        spec = parser.parse(yaml)
        slugs = parser.extract_model_slugs(spec)

        assert slugs == ["whisper"]

    def test_extract_all_models(self, parser):
        """Test extracting all model slugs."""
        yaml = """
version: "1.0"
models:
  asr: whisper
  vad: silero
  denoise: denoiser
"""
        spec = parser.parse(yaml)
        slugs = parser.extract_model_slugs(spec)

        assert len(slugs) == 3
        assert "whisper" in slugs
        assert "silero" in slugs
        assert "denoiser" in slugs

    def test_extract_excludes_inline_models(self, parser):
        """Test that inline models are not included in slug extraction."""
        yaml = """
version: "1.1"
models:
  asr:
    hf_model_id: "onnx-community/whisper-turbo"
    engine: "onnx"
  vad: "silero-vad-v6"
"""
        spec = parser.parse(yaml)
        slugs = parser.extract_model_slugs(spec)

        # Only the slug reference should be extracted
        assert slugs == ["silero-vad-v6"]


class TestSingleton:
    """Tests for singleton pattern."""

    def test_get_yaml_parser_singleton(self):
        """Test that get_yaml_parser returns singleton."""
        parser1 = get_yaml_parser()
        parser2 = get_yaml_parser()

        assert parser1 is parser2


class TestBestPracticePipeline:
    """Tests for parsing best practice pipeline configurations."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    @pytest.fixture
    def best_practice_yaml(self):
        """Best practice YAML for real-time transcription."""
        return """
version: "1.1"

models:
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo"
    engine: "onnx"
    revision: "main"
  vad:
    hf_model_id: "snakers4/silero-vad"
    engine: "onnx"
    version: "main"
  denoise:
    hf_model_id: "nickolay/rnnoise"
    engine: "onnx"

preprocessing:
  vad:
    enabled: true
    threshold: 0.45
    min_speech_duration_ms: 200
    min_silence_duration_ms: 150
    padding_ms: 50
  denoise:
    enabled: true
    strength: 0.7
  target_sample_rate: 16000
  normalize: true

inference:
  batch_size: 8
  compute_type: float16
  device: auto
  num_workers: 4
  beam_size: 5
  temperature: 0.0
  language: null

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false
  lowercase: false
"""

    def test_parse_best_practice_pipeline(self, parser, best_practice_yaml):
        """Test parsing a best practice pipeline configuration."""
        spec = parser.parse(best_practice_yaml)

        # Verify version
        assert spec.version == "1.1"

        # Verify all models are inline
        assert spec.models.asr.is_inline is True
        assert spec.models.vad.is_inline is True
        assert spec.models.denoise.is_inline is True

        # Verify ASR model
        assert spec.models.asr.inline.hf_model_id == "onnx-community/whisper-large-v3-turbo"
        assert spec.models.asr.inline.engine == AiModelFormat.ONNX

        # Verify VAD model
        assert spec.models.vad.inline.hf_model_id == "snakers4/silero-vad"
        assert spec.models.vad.inline.version == "main"

        # Verify denoise model
        assert spec.models.denoise.inline.hf_model_id == "nickolay/rnnoise"

        # Verify preprocessing
        assert spec.preprocessing.vad.enabled is True
        assert spec.preprocessing.vad.threshold == 0.45
        assert spec.preprocessing.denoise.enabled is True
        assert spec.preprocessing.denoise.strength == 0.7

        # Verify inference
        assert spec.inference.batch_size == 8
        assert spec.inference.compute_type == "float16"

        # Verify postprocessing
        assert spec.postprocessing.timestamps.word_timestamps is True

    def test_validate_best_practice_pipeline(self, parser, best_practice_yaml):
        """Test that best practice pipeline validates successfully."""
        spec = parser.parse(best_practice_yaml)
        result = parser.validate(spec)

        assert result.valid is True
        assert len(result.errors) == 0


# =============================================================================
# EDGE CASE TESTS
# =============================================================================


class TestYamlParserEdgeCases:
    """Edge case tests for YAML parser robustness."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    def test_empty_yaml_content(self, parser):
        """Test parsing empty YAML content."""
        with pytest.raises(ValueError, match="YAML must be a dictionary"):
            parser.parse("")

    def test_null_yaml_content(self, parser):
        """Test parsing YAML that parses to None."""
        with pytest.raises(ValueError, match="YAML must be a dictionary"):
            parser.parse("null")

    def test_yaml_with_only_whitespace(self, parser):
        """Test parsing YAML with only whitespace (tabs cause YAML error)."""
        # YAML doesn't allow tabs for indentation, so this triggers a syntax error
        with pytest.raises(ValueError):
            parser.parse("   \n\t   ")

    def test_yaml_with_comments_only(self, parser):
        """Test parsing YAML with only comments."""
        with pytest.raises(ValueError, match="YAML must be a dictionary"):
            parser.parse("# This is a comment\n# Another comment")

    def test_deeply_nested_yaml(self, parser):
        """Test parsing deeply nested YAML structure."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-test
preprocessing:
  vad:
    enabled: true
    threshold: 0.5
    nested:
      deeply:
        nested:
          value: 123
"""
        # Should parse without error (extra nested fields ignored)
        spec = parser.parse(yaml_content)
        assert spec.version == "1.0"

    def test_unicode_in_yaml_values(self, parser):
        """Test parsing YAML with unicode characters."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-日本語
inference:
  language: 中文
"""
        spec = parser.parse(yaml_content)
        assert spec.models.asr.slug == "whisper-日本語"
        assert spec.inference.language == "中文"

    def test_very_long_model_slug(self, parser):
        """Test parsing YAML with very long model slug."""
        long_slug = "a" * 500
        yaml_content = f"""
version: "1.0"
models:
  asr: {long_slug}
"""
        spec = parser.parse(yaml_content)
        assert spec.models.asr.slug == long_slug

    def test_special_characters_in_slug(self, parser):
        """Test parsing YAML with special characters in slug."""
        yaml_content = """
version: "1.0"
models:
  asr: "whisper-large-v3.1_beta+test"
"""
        spec = parser.parse(yaml_content)
        assert spec.models.asr.slug == "whisper-large-v3.1_beta+test"

    def test_quoted_vs_unquoted_strings(self, parser):
        """Test that quoted and unquoted strings parse the same."""
        yaml_quoted = """
version: "1.0"
models:
  asr: "whisper-large-v3"
"""
        yaml_unquoted = """
version: '1.0'
models:
  asr: whisper-large-v3
"""
        spec_quoted = parser.parse(yaml_quoted)
        spec_unquoted = parser.parse(yaml_unquoted)

        assert spec_quoted.models.asr.slug == spec_unquoted.models.asr.slug

    def test_numeric_values_as_strings(self, parser):
        """Test that numeric-looking strings are handled correctly."""
        yaml_content = """
version: "1.0"
models:
  asr: "123456"
inference:
  batch_size: 16
"""
        spec = parser.parse(yaml_content)
        assert spec.models.asr.slug == "123456"
        assert spec.inference.batch_size == 16

    def test_boolean_values_in_preprocessing(self, parser):
        """Test various boolean representations."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper
preprocessing:
  normalize: yes
  vad:
    enabled: true
  denoise:
    enabled: false
"""
        spec = parser.parse(yaml_content)
        assert spec.preprocessing.normalize is True
        assert spec.preprocessing.vad.enabled is True
        assert spec.preprocessing.denoise.enabled is False

    def test_null_optional_fields(self, parser):
        """Test explicit null for optional fields."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper
  vad: null
  denoise: ~
inference:
  language: null
"""
        spec = parser.parse(yaml_content)
        assert spec.models.vad is None
        assert spec.models.denoise is None
        assert spec.inference.language is None


class TestValidationEdgeCases:
    """Edge case tests for validation."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    def test_validate_negative_batch_size(self, parser):
        """Test validation rejects negative batch size."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper
inference:
  batch_size: -5
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("batch_size" in e.field for e in result.errors)

    def test_validate_zero_batch_size(self, parser):
        """Test validation rejects zero batch size."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper
inference:
  batch_size: 0
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("batch_size" in e.field for e in result.errors)

    def test_validate_negative_vad_threshold(self, parser):
        """Test validation rejects negative VAD threshold."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper
preprocessing:
  vad:
    threshold: -0.5
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("threshold" in e.field for e in result.errors)

    def test_validate_negative_temperature(self, parser):
        """Test validation rejects negative temperature."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper
inference:
  temperature: -0.1
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("temperature" in e.field for e in result.errors)

    def test_validate_temperature_too_high(self, parser):
        """Test validation rejects temperature above 2."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper
inference:
  temperature: 3.0
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("temperature" in e.field for e in result.errors)

    def test_validate_beam_size_boundaries(self, parser):
        """Test validation of beam size boundaries."""
        # Zero beam size (invalid)
        yaml_zero = """
version: "1.0"
models:
  asr: whisper
inference:
  beam_size: 0
"""
        spec_zero = parser.parse(yaml_zero)
        result_zero = parser.validate(spec_zero)
        assert result_zero.valid is False

        # Beam size 11 (invalid, max is 10)
        yaml_eleven = """
version: "1.0"
models:
  asr: whisper
inference:
  beam_size: 11
"""
        spec_eleven = parser.parse(yaml_eleven)
        result_eleven = parser.validate(spec_eleven)
        assert result_eleven.valid is False

    def test_validate_multiple_errors(self, parser):
        """Test validation collects all errors."""
        yaml_content = """
version: "3.0"
models:
  asr: ""
preprocessing:
  vad:
    threshold: 5.0
inference:
  batch_size: 1000
  compute_type: invalid_type
  device: tpu
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)

        assert result.valid is False
        # Should have multiple errors
        assert len(result.errors) >= 4


class TestInlineModelValidationEdgeCases:
    """Edge cases for inline model validation."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    def test_inline_model_missing_engine(self, parser):
        """Test inline model without engine (should use default)."""
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "test/model"
"""
        spec = parser.parse(yaml_content)
        # Should use default engine (SAFETENSOR)
        assert spec.models.asr.inline.engine == AiModelFormat.SAFETENSOR

        result = parser.validate(spec)
        assert result.valid is True

    def test_inline_model_with_whitespace_hf_model_id(self, parser):
        """Test inline model with whitespace-only hf_model_id."""
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "   "
    engine: onnx
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("hf_model_id" in e.field for e in result.errors)

    def test_mixed_valid_and_invalid_inline_models(self, parser):
        """Test mixed valid and invalid inline models."""
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "valid/model"
    engine: onnx
  vad:
    hf_model_id: ""
    engine: onnx
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)

        assert result.valid is False
        # Should have error for VAD, not for ASR
        assert any("vad" in e.field for e in result.errors)
        assert not any("asr" in e.field and "hf_model_id" in e.field for e in result.errors)


# =============================================================================
# ONNX QUANTIZATION YAML TESTS
# =============================================================================


class TestYamlParserOnnxQuantization:
    """Tests for YAML parser handling of quantization and subfolder fields."""

    @pytest.fixture
    def parser(self):
        """Get parser instance."""
        return PipelineYamlParser()

    def test_parse_inline_model_with_quantization(self, parser):
        """Test parsing inline model with quantization field."""
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo_timestamped"
    engine: onnx
    quantization: q4
    subfolder: onnx
"""
        spec = parser.parse(yaml_content)

        assert spec.models.asr.is_inline
        assert spec.models.asr.inline.quantization == "q4"
        assert spec.models.asr.inline.subfolder == "onnx"

    def test_parse_inline_model_without_quantization(self, parser):
        """Test parsing inline model without quantization (backward compat)."""
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "onnx-community/whisper-small-ONNX"
    engine: onnx
"""
        spec = parser.parse(yaml_content)

        assert spec.models.asr.is_inline
        assert spec.models.asr.inline.quantization is None
        assert spec.models.asr.inline.subfolder is None

    def test_validate_valid_quantization(self, parser):
        """Test validation passes for valid quantization values."""
        for q in ["fp16", "int8", "uint8", "q4", "q4f16", "bnb4", "quantized"]:
            yaml_content = f"""
version: "1.1"
models:
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo_timestamped"
    engine: onnx
    quantization: "{q}"
"""
            spec = parser.parse(yaml_content)
            result = parser.validate(spec)
            assert result.valid is True, f"quantization='{q}' should be valid"

    def test_validate_invalid_quantization(self, parser):
        """Test validation fails for invalid quantization value."""
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo_timestamped"
    engine: onnx
    quantization: "float64_nonsense"
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("quantization" in e.field for e in result.errors)
        assert any("float64_nonsense" in e.message for e in result.errors)

    def test_validate_no_quantization_is_valid(self, parser):
        """Test validation passes when quantization is not set."""
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo_timestamped"
    engine: onnx
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert result.valid is True

    def test_validate_invalid_quantization_on_vad_model(self, parser):
        """Test validation catches invalid quantization on VAD model too."""
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo_timestamped"
    engine: onnx
    quantization: q4
  vad:
    hf_model_id: "snakers4/silero-vad"
    engine: onnx
    quantization: "invalid_quant"
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)

        assert result.valid is False
        assert any("vad" in e.field and "quantization" in e.field for e in result.errors)

    def test_parse_quantization_with_all_other_inline_fields(self, parser):
        """Test parsing inline model with quantization alongside all other fields."""
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo_timestamped"
    engine: onnx
    revision: main
    quantization: fp16
    subfolder: onnx
    compute_type: float32
    device: cpu
"""
        spec = parser.parse(yaml_content)
        inline = spec.models.asr.inline

        assert inline is not None
        assert inline.hf_model_id == "onnx-community/whisper-large-v3-turbo_timestamped"
        assert inline.engine == AiModelFormat.ONNX
        assert inline.revision == "main"
        assert inline.quantization == "fp16"
        assert inline.subfolder == "onnx"
        assert inline.compute_type == "float32"
        assert inline.device == "cpu"


class TestEmbeddingModelParsing:
    """Tests for parsing models.embedding in YAML config."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    def test_parse_embedding_inline_model(self, parser):
        """Embedding model defined as inline HF model ref."""
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo"
    engine: onnx
  embedding:
    hf_model_id: "pyannote/embedding"
    engine: pytorch
"""
        spec = parser.parse(yaml_content)
        assert spec.models.embedding is not None
        assert spec.models.embedding.is_inline
        assert spec.models.embedding.inline.hf_model_id == "pyannote/embedding"

    def test_parse_embedding_slug_ref(self, parser):
        """Embedding model defined as slug reference."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
  embedding: pyannote-embedding-v3
"""
        spec = parser.parse(yaml_content)
        assert spec.models.embedding is not None
        assert spec.models.embedding.slug == "pyannote-embedding-v3"
        assert not spec.models.embedding.is_inline

    def test_parse_no_embedding_model(self, parser):
        """No embedding model key -> embedding ref is None."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
"""
        spec = parser.parse(yaml_content)
        assert spec.models.embedding is None

    def test_validate_embedding_inline_missing_hf_model_id(self, parser):
        """Inline embedding model with empty hf_model_id should fail validation."""
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo"
    engine: onnx
  embedding:
    hf_model_id: ""
    engine: pytorch
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert not result.valid
        error_fields = [e.field for e in result.errors]
        assert "models.embedding.hf_model_id" in error_fields

    def test_validate_diarization_high_threshold_out_of_range(self, parser):
        """high_threshold > 1 should fail validation."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
diarization:
  enabled: true
  high_threshold: 1.5
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert not result.valid
        error_fields = [e.field for e in result.errors]
        assert "diarization.high_threshold" in error_fields

    def test_validate_diarization_min_segment_duration_negative(self, parser):
        """Negative min_segment_duration_s should fail validation."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
diarization:
  enabled: true
  min_segment_duration_s: -0.5
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert not result.valid
        error_fields = [e.field for e in result.errors]
        assert "diarization.min_segment_duration_s" in error_fields

    def test_embedding_model_included_in_get_all_refs(self, parser):
        """Embedding model ref should appear in get_all_refs()."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
  embedding: pyannote-embedding-v3
"""
        spec = parser.parse(yaml_content)
        all_refs = spec.models.get_all_refs()
        roles = [role for role, _ in all_refs]
        assert "embedding" in roles

    def test_embedding_model_included_in_get_all_slugs(self, parser):
        """Embedding slug should appear in get_all_slugs()."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
  embedding: pyannote-embedding-v3
"""
        spec = parser.parse(yaml_content)
        assert "pyannote-embedding-v3" in spec.models.get_all_slugs()

    def test_validate_diarization_boundary_threshold_0(self, parser):
        """high_threshold=0 should pass validation (no out-of-range)."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
diarization:
  enabled: true
  high_threshold: 0.5
  low_threshold: 0.3
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        error_fields = [e.field for e in result.errors]
        assert "diarization.high_threshold" not in error_fields

    def test_validate_diarization_boundary_threshold_1(self, parser):
        """high_threshold=1.0 should pass validation."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
diarization:
  enabled: true
  high_threshold: 1.0
  low_threshold: 0.5
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        error_fields = [e.field for e in result.errors]
        assert "diarization.high_threshold" not in error_fields

    def test_validate_diarization_min_segment_duration_zero(self, parser):
        """min_segment_duration_s=0 should pass validation."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
diarization:
  enabled: true
  min_segment_duration_s: 0.0
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        error_fields = [e.field for e in result.errors]
        assert "diarization.min_segment_duration_s" not in error_fields

    def test_validate_diarization_high_threshold_negative(self, parser):
        """Negative high_threshold should fail validation."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
diarization:
  enabled: true
  high_threshold: -0.1
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert not result.valid
        error_fields = [e.field for e in result.errors]
        assert "diarization.high_threshold" in error_fields

    def test_diarization_disabled_still_validates(self, parser):
        """Even with enabled=false, out-of-range values should still fail validation."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
diarization:
  enabled: false
  high_threshold: 2.0
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert not result.valid
        error_fields = [e.field for e in result.errors]
        assert "diarization.high_threshold" in error_fields

    def test_embedding_model_absent_no_validation_error(self, parser):
        """When no embedding model is set, validation should not error on it."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
diarization:
  enabled: true
  high_threshold: 0.7
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        # Should be valid -- embedding model is optional
        error_fields = [e.field for e in result.errors]
        assert "models.embedding.hf_model_id" not in error_fields

    def test_parse_full_pipeline_with_embedding(self, parser):
        """Full pipeline YAML with all sections including embedding model + config."""
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "onnx-community/whisper-large-v3-turbo"
    engine: onnx
  vad:
    hf_model_id: "snakers4/silero-vad"
    engine: onnx
  embedding:
    hf_model_id: "pyannote/embedding"
    engine: pytorch
preprocessing:
  vad:
    enabled: true
    threshold: 0.6
diarization:
  enabled: true
  high_threshold: 0.75
  low_threshold: 0.4
  max_speakers: 5
  min_segment_duration_s: 1.5
"""
        spec = parser.parse(yaml_content)

        # Models
        assert spec.models.embedding is not None
        assert spec.models.embedding.inline.hf_model_id == "pyannote/embedding"
        assert spec.models.vad is not None

        # Diarization config
        assert spec.diarization.enabled is True
        assert spec.diarization.high_threshold == 0.75
        assert spec.diarization.max_speakers == 5
        assert spec.diarization.min_segment_duration_s == 1.5

        # Should validate cleanly
        result = parser.validate(spec)
        assert result.valid, f"Validation errors: {[str(e) for e in result.errors]}"


class TestLanguageAndCodeSwitchingValidation:
    """Tests for language and code_switching validation in YAML parser."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    def test_parse_code_switching_enabled(self, parser):
        """Parse YAML with code_switching: true in inference section."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  language: en
  code_switching: true
"""
        spec = parser.parse(yaml_content)
        assert spec.inference.code_switching is True

    def test_parse_code_switching_default_false(self, parser):
        """Parse minimal YAML (no code_switching key), assert default False."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
"""
        spec = parser.parse(yaml_content)
        assert spec.inference.code_switching is False

    def test_parse_code_switching_with_language(self, parser):
        """Parse YAML with both language: en and code_switching: true."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  language: en
  code_switching: true
"""
        spec = parser.parse(yaml_content)
        assert spec.inference.language == "en"
        assert spec.inference.code_switching is True

    def test_validate_valid_language_code(self, parser):
        """Parse YAML with language: en, validate -> result.valid is True."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  language: en
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert result.valid is True

    def test_validate_invalid_language_code(self, parser):
        """Parse YAML with language: xx, validate -> result.valid is False, error on inference.language."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  language: xx
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert result.valid is False
        assert any("inference.language" in e.field for e in result.errors)

    def test_validate_bcp47_language_code(self, parser):
        """Parse YAML with language: en-US, validate -> result.valid is True."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  language: en-US
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert result.valid is True

    def test_validate_null_language_is_valid(self, parser):
        """Parse YAML with language: null, validate -> result.valid is True."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  language: null
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert result.valid is True

    def test_validate_code_switching_with_language_warns(self, parser, caplog):
        """Parse YAML with language: en and code_switching: true, validate -> result.valid is True, caplog contains warning."""
        caplog.set_level(logging.WARNING)
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  language: en
  code_switching: true
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert result.valid is True
        assert any("code_switching" in rec.message for rec in caplog.records)
        assert any("language" in rec.message for rec in caplog.records)

    def test_validate_code_switching_without_language_no_warning(self, parser, caplog):
        """Parse YAML with code_switching: true and language: null, validate -> no warning about code_switching."""
        caplog.set_level(logging.WARNING)
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  code_switching: true
  language: null
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert result.valid is True
        # No warning should be logged when language is null (code_switching + language combo warning)
        code_switching_warnings = [
            rec
            for rec in caplog.records
            if "code_switching" in rec.message and "language" in rec.message
        ]
        assert len(code_switching_warnings) == 0


# =============================================================================
# INITIAL PROMPT TESTS
# =============================================================================


class TestInitialPromptParsing:
    """Tests for initial_prompt field in inference section."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    def test_parse_initial_prompt(self, parser):
        """Parse YAML with initial_prompt UUID in inference section."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  initial_prompt: "71000000-0000-0000-0000-000000000041"
"""
        spec = parser.parse(yaml_content)
        assert spec.inference.initial_prompt == "71000000-0000-0000-0000-000000000041"

    def test_parse_no_initial_prompt(self, parser):
        """Parse YAML without initial_prompt, assert default None."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
"""
        spec = parser.parse(yaml_content)
        assert spec.inference.initial_prompt is None

    def test_parse_initial_prompt_with_code_switching(self, parser):
        """Parse YAML with both initial_prompt and code_switching."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  code_switching: true
  initial_prompt: "71000000-0000-0000-0000-000000000041"
"""
        spec = parser.parse(yaml_content)
        assert spec.inference.code_switching is True
        assert spec.inference.initial_prompt == "71000000-0000-0000-0000-000000000041"

    def test_validate_invalid_initial_prompt(self, parser):
        """Validate YAML with non-UUID initial_prompt, assert error."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  initial_prompt: "not-a-uuid"
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert result.valid is False
        assert any(e.field == "inference.initial_prompt" for e in result.errors)

    def test_validate_valid_initial_prompt(self, parser):
        """Validate YAML with valid UUID initial_prompt, assert no error."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  initial_prompt: "71000000-0000-0000-0000-000000000041"
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert result.valid is True


# =========================================================================
# Whisper decoding knobs (num_beams, temperature, threshold triad,
# no_repeat_ngram_size) exposed via YAML — parsing + backward compatibility.
# =========================================================================


class TestYamlParserInferenceKeys:
    """Parsing behaviour for the Whisper decoding knobs."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    def test_scalar_temperature_legacy_coerced_to_list(self, parser):
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  temperature: 0.0
"""
        spec = parser.parse(yaml_content)
        assert spec.inference.temperature == [0.0]

    def test_list_temperature_preserved(self, parser):
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  temperature: [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
"""
        spec = parser.parse(yaml_content)
        assert spec.inference.temperature == [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]

    def test_missing_temperature_uses_dataclass_default(self, parser):
        """Omitting temperature keeps the dataclass default fallback list."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
"""
        spec = parser.parse(yaml_content)
        assert spec.inference.temperature == InferenceConfig().temperature

    def test_missing_threshold_triad_uses_dataclass_defaults(self, parser):
        """Omitting the threshold triad keeps the dataclass defaults."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
"""
        spec = parser.parse(yaml_content)
        defaults = InferenceConfig()
        assert (
            spec.inference.compression_ratio_threshold
            == defaults.compression_ratio_threshold
        )
        assert spec.inference.logprob_threshold == defaults.logprob_threshold
        assert spec.inference.no_speech_threshold == defaults.no_speech_threshold

    def test_explicit_null_threshold_triad_disables_each(self, parser):
        """Explicit ``null`` in YAML overrides dataclass defaults to None."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  compression_ratio_threshold: null
  logprob_threshold: null
  no_speech_threshold: null
"""
        spec = parser.parse(yaml_content)
        assert spec.inference.compression_ratio_threshold is None
        assert spec.inference.logprob_threshold is None
        assert spec.inference.no_speech_threshold is None

    def test_threshold_triad_parsed_when_present(self, parser):
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  compression_ratio_threshold: 2.4
  logprob_threshold: -1.0
  no_speech_threshold: 0.6
  no_repeat_ngram_size: 3
"""
        spec = parser.parse(yaml_content)
        assert spec.inference.compression_ratio_threshold == 2.4
        assert spec.inference.logprob_threshold == -1.0
        assert spec.inference.no_speech_threshold == 0.6
        assert spec.inference.no_repeat_ngram_size == 3

    def test_no_repeat_ngram_size_zero_parsed(self, parser):
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  no_repeat_ngram_size: 0
"""
        spec = parser.parse(yaml_content)
        assert spec.inference.no_repeat_ngram_size == 0

    def test_beam_size_parsed(self, parser):
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  beam_size: 2
"""
        spec = parser.parse(yaml_content)
        assert spec.inference.beam_size == 2


class TestYamlParserInferenceValidation:
    """Validation behaviour for the Whisper decoding knobs."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    def test_valid_anti_hallucination_config(self, parser):
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  beam_size: 2
  temperature: [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
  compression_ratio_threshold: 2.4
  logprob_threshold: -1.0
  no_speech_threshold: 0.6
  no_repeat_ngram_size: 3
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert result.valid, f"Errors: {[str(e) for e in result.errors]}"

    def test_temperature_list_with_value_out_of_range_fails(self, parser):
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  temperature: [0.0, 3.0]
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert not result.valid
        assert any(
            "temperature" in e.field for e in result.errors
        ), f"Errors were: {[str(e) for e in result.errors]}"

    def test_empty_temperature_list_fails(self, parser):
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  temperature: []
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert not result.valid
        assert any("temperature" in e.field for e in result.errors)

    def test_negative_compression_ratio_fails(self, parser):
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  compression_ratio_threshold: -1.0
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert not result.valid
        assert any(
            "compression_ratio_threshold" in e.field for e in result.errors
        )

    def test_positive_logprob_threshold_fails(self, parser):
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  logprob_threshold: 0.5
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert not result.valid
        assert any("logprob_threshold" in e.field for e in result.errors)

    def test_no_speech_threshold_out_of_range_fails(self, parser):
        for bad_value in (-0.1, 1.5):
            yaml_content = f"""
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  no_speech_threshold: {bad_value}
"""
            spec = parser.parse(yaml_content)
            result = parser.validate(spec)
            assert not result.valid, f"{bad_value} should be rejected"
            assert any(
                "no_speech_threshold" in e.field for e in result.errors
            ), f"{bad_value} should raise the right error"

    def test_no_repeat_ngram_size_out_of_range_fails(self, parser):
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  no_repeat_ngram_size: 20
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert not result.valid
        assert any(
            "no_repeat_ngram_size" in e.field for e in result.errors
        )

    def test_negative_no_repeat_ngram_size_fails(self, parser):
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  no_repeat_ngram_size: -1
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert not result.valid
        assert any(
            "no_repeat_ngram_size" in e.field for e in result.errors
        )

    def test_scalar_temperature_out_of_range_still_fails(self, parser):
        """Legacy scalar temperature still respects the [0, 2] range."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  temperature: 3.0
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert not result.valid
        assert any("temperature" in e.field for e in result.errors)


class TestYamlParserMaxWordsPerSecond:
    """Parsing for ``inference.max_words_per_second`` — the WPS hallucination gate."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    def test_default_when_absent(self, parser):
        """Omitting the key leaves the gate effectively off (large default)."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
"""
        spec = parser.parse(yaml_content)
        assert spec.inference.max_words_per_second == 1000.0

    def test_parses_explicit_value(self, parser):
        """Setting the key opts in to the WPS gate."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  max_words_per_second: 15
"""
        spec = parser.parse(yaml_content)
        assert spec.inference.max_words_per_second == 15.0

    def test_null_value_falls_back_to_default(self, parser):
        """Explicit ``null`` is treated the same as the key being absent."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
inference:
  max_words_per_second: null
"""
        spec = parser.parse(yaml_content)
        assert spec.inference.max_words_per_second == 1000.0


class TestYamlParserDualCapture:
    """Parsing for per-pipeline ``dual_capture`` (raw / processed audio registration)."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    def test_dual_capture_defaults_disabled_when_absent(self, parser):
        """Omitting ``dual_capture`` leaves both blocks disabled (opt-in)."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
"""
        spec = parser.parse(yaml_content)
        assert spec.preprocessing.dual_capture.enabled is False
        assert spec.preprocessing.dual_capture.capture_raw is False
        assert spec.postprocessing.dual_capture.enabled is False
        assert spec.postprocessing.dual_capture.capture_processed is False

    def test_preprocessing_dual_capture_raw_parsed(self, parser):
        """``preprocessing.dual_capture`` opts in to raw (pre-filter) capture."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
preprocessing:
  dual_capture:
    enabled: true
    capture_raw: true
"""
        spec = parser.parse(yaml_content)
        assert spec.preprocessing.dual_capture.enabled is True
        assert spec.preprocessing.dual_capture.capture_raw is True

    def test_postprocessing_dual_capture_processed_parsed(self, parser):
        """``postprocessing.dual_capture`` opts in to processed (post-filter) capture."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
postprocessing:
  dual_capture:
    enabled: true
    capture_processed: true
"""
        spec = parser.parse(yaml_content)
        assert spec.postprocessing.dual_capture.enabled is True
        assert spec.postprocessing.dual_capture.capture_processed is True

    def test_dual_capture_enabled_but_capture_flags_off(self, parser):
        """``enabled`` with a capture flag false keeps the block on but capture off."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
preprocessing:
  dual_capture:
    enabled: true
    capture_raw: false
postprocessing:
  dual_capture:
    enabled: true
    capture_processed: false
"""
        spec = parser.parse(yaml_content)
        assert spec.preprocessing.dual_capture.enabled is True
        assert spec.preprocessing.dual_capture.capture_raw is False
        assert spec.postprocessing.dual_capture.enabled is True
        assert spec.postprocessing.dual_capture.capture_processed is False


class TestYamlParserUnknownKeyWarning:
    """Hardening: warn on unknown top-level keys so intent-only keys don't silently no-op."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    def test_unknown_top_level_key_warns(self, parser, caplog):
        """An unrecognised top-level section emits a warning naming the key."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
telephony:
  enabled: true
"""
        with caplog.at_level(logging.WARNING):
            parser.parse(yaml_content)
        assert "telephony" in caplog.text
        assert "Unknown top-level" in caplog.text

    def test_known_top_level_keys_do_not_warn(self, parser, caplog):
        """All recognised sections parse without an unknown-key warning."""
        yaml_content = """
version: "1.0"
models:
  asr: whisper-large-v3
preprocessing:
  normalize: true
inference:
  beam_size: 5
postprocessing:
  lowercase: false
diarization:
  enabled: false
"""
        with caplog.at_level(logging.WARNING):
            parser.parse(yaml_content)
        assert "Unknown top-level" not in caplog.text
