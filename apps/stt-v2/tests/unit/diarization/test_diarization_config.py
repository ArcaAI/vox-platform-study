"""Unit tests for session-based diarization config and YAML parsing."""

import pytest

from stt_v2.pipeline.dto import DiarizationConfig, ModelRef, ModelRefs
from stt_v2.pipeline.yaml_parser import PipelineYamlParser


class TestDiarizationConfigDefaults:
    """Test new DiarizationConfig fields have correct defaults."""

    def test_default_values(self):
        config = DiarizationConfig()
        assert config.enabled is False
        assert config.high_threshold == 0.7
        assert config.low_threshold == 0.4
        assert config.max_speakers == 2
        assert config.min_segment_duration_s == 1.0
        assert config.segment_silence_padding_ms == 100
        assert config.ema_alpha == 0.1
        assert config.ema_min_confidence == 0.8
        assert config.enable_segmentation_refinement is True

    def test_removed_fields_do_not_exist(self):
        config = DiarizationConfig()
        assert not hasattr(config, "similarity_threshold")
        assert not hasattr(config, "auto_register_speakers")


class TestModelRefsSegmentation:
    """Test segmentation model ref added to ModelRefs."""

    def test_segmentation_none_by_default(self):
        refs = ModelRefs(asr=ModelRef(slug="whisper"))
        assert refs.segmentation is None

    def test_segmentation_in_get_all_refs(self):
        seg_ref = ModelRef(slug="segmentation-3.0")
        refs = ModelRefs(asr=ModelRef(slug="whisper"), segmentation=seg_ref)
        role_names = [r[0] for r in refs.get_all_refs()]
        assert "segmentation" in role_names

    def test_segmentation_in_get_all_slugs(self):
        seg_ref = ModelRef(slug="segmentation-3.0")
        refs = ModelRefs(asr=ModelRef(slug="whisper"), segmentation=seg_ref)
        assert "segmentation-3.0" in refs.get_all_slugs()

    def test_segmentation_in_get_inline_models(self):
        from stt_v2.pipeline.dto import AiModelFormat, InlineModelDef

        inline = InlineModelDef(
            hf_model_id="pyannote/segmentation-3.0",
            engine=AiModelFormat.PYTORCH,
        )
        seg_ref = ModelRef(inline=inline)
        refs = ModelRefs(asr=ModelRef(slug="whisper"), segmentation=seg_ref)
        inlines = refs.get_inline_models()
        role_names = [r[0] for r in inlines]
        assert "segmentation" in role_names


class TestYamlParserNewDiarization:
    """Test YAML parser handles new diarization fields + segmentation model."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    def test_parse_new_diarization_fields(self, parser):
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "ctranslate2"
diarization:
  enabled: true
  high_threshold: 0.75
  low_threshold: 0.35
  max_speakers: 3
  min_segment_duration_s: 0.8
  ema_alpha: 0.15
  ema_min_confidence: 0.85
  enable_segmentation_refinement: false
"""
        spec = parser.parse(yaml_content)
        assert spec.diarization.enabled is True
        assert spec.diarization.high_threshold == 0.75
        assert spec.diarization.low_threshold == 0.35
        assert spec.diarization.max_speakers == 3
        assert spec.diarization.min_segment_duration_s == 0.8
        assert spec.diarization.ema_alpha == 0.15
        assert spec.diarization.ema_min_confidence == 0.85
        assert spec.diarization.enable_segmentation_refinement is False

    def test_parse_diarization_defaults(self, parser):
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "ctranslate2"
"""
        spec = parser.parse(yaml_content)
        assert spec.diarization.high_threshold == 0.7
        assert spec.diarization.low_threshold == 0.4
        assert spec.diarization.ema_alpha == 0.1

    def test_parse_segmentation_model(self, parser):
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "ctranslate2"
  segmentation:
    hf_model_id: "pyannote/segmentation-3.0"
    engine: "pytorch"
    device: "cpu"
"""
        spec = parser.parse(yaml_content)
        assert spec.models.segmentation is not None
        assert spec.models.segmentation.is_inline is True
        assert spec.models.segmentation.inline.hf_model_id == "pyannote/segmentation-3.0"

    def test_validate_low_threshold_lt_high_threshold(self, parser):
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "ctranslate2"
diarization:
  enabled: true
  high_threshold: 0.3
  low_threshold: 0.5
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert not result.valid
        errors = result.get_error_messages()
        assert any("low_threshold" in e for e in errors)

    def test_validate_ema_alpha_range(self, parser):
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "ctranslate2"
diarization:
  enabled: true
  ema_alpha: 1.5
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert not result.valid
        errors = result.get_error_messages()
        assert any("ema_alpha" in e for e in errors)
