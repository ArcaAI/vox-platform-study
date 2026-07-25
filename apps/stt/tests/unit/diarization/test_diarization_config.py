"""Unit tests for session-based diarization config and YAML parsing."""

import pytest

from stt.pipeline.dto import DiarizationConfig, ModelRef, ModelRefs
from stt.pipeline.yaml_parser import PipelineYamlParser


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
        assert config.min_update_confidence == 0.8
        assert config.enable_segmentation_refinement is True
        assert config.max_embeddings_per_speaker == 8
        # The backend selector defaults to the existing embedding path
        # so current behavior is preserved until Streaming Sortformer is staged.
        assert config.backend == "embedding"

    def test_removed_fields_do_not_exist(self):
        config = DiarizationConfig()
        assert not hasattr(config, "similarity_threshold")
        assert not hasattr(config, "auto_register_speakers")
        assert not hasattr(config, "ema_alpha")
        assert not hasattr(config, "ema_min_confidence")


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
        from stt.pipeline.dto import AiModelFormat, InlineModelDef

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
  min_update_confidence: 0.85
  enable_segmentation_refinement: false
"""
        spec = parser.parse(yaml_content)
        assert spec.diarization.enabled is True
        assert spec.diarization.high_threshold == 0.75
        assert spec.diarization.low_threshold == 0.35
        assert spec.diarization.max_speakers == 3
        assert spec.diarization.min_segment_duration_s == 0.8
        assert spec.diarization.min_update_confidence == 0.85
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
        assert result.valid


class TestDiarizationBackendSelector:
    """DiarizationConfig gains a backend selector (embedding|sortformer)."""

    @pytest.fixture
    def parser(self):
        return PipelineYamlParser()

    def test_backend_defaults_to_embedding(self):
        assert DiarizationConfig().backend == "embedding"

    def test_sortformer_knobs_have_defaults(self):
        config = DiarizationConfig()
        # Pinned v2.1 checkpoint (NVIDIA Open Model License, owner-accepted 2026-07-11);
        # NOT the plain cc-by-4.0 v2, and NOT the cc-by-nc offline v1.
        assert config.sortformer_model_id == "nvidia/diar_streaming_sortformer_4spk-v2.1"
        assert config.sortformer_revision is None  # pinned when the model is staged
        assert config.sortformer_threshold == 0.5
        assert config.sortformer_frame_shift_s == 0.08

    def test_parse_backend_sortformer(self, parser):
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "ctranslate2"
diarization:
  enabled: true
  backend: "sortformer"
  sortformer_revision: "abc123"
  sortformer_threshold: 0.6
"""
        spec = parser.parse(yaml_content)
        assert spec.diarization.backend == "sortformer"
        assert spec.diarization.sortformer_revision == "abc123"
        assert spec.diarization.sortformer_threshold == 0.6

    def test_parse_backend_defaults_to_embedding(self, parser):
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "ctranslate2"
diarization:
  enabled: true
"""
        spec = parser.parse(yaml_content)
        assert spec.diarization.backend == "embedding"

    def test_validate_rejects_unknown_backend(self, parser):
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "ctranslate2"
diarization:
  enabled: true
  backend: "cloud_magic"
"""
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert not result.valid
        assert any("backend" in e for e in result.get_error_messages())

    def test_validate_accepts_known_backends(self, parser):
        for backend in ("embedding", "sortformer"):
            yaml_content = f"""
version: "1.1"
models:
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "ctranslate2"
diarization:
  enabled: true
  backend: "{backend}"
"""
            spec = parser.parse(yaml_content)
            result = parser.validate(spec)
            assert result.valid, f"backend {backend} should validate"
