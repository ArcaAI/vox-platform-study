"""YAML parser tests for the FASTER_WHISPER engine (TASK-351 P1-2)."""

from __future__ import annotations

from stt_v2.pipeline.dto import (
    AiModelFormat,
    ModelRef,
    engine_supports_initial_prompt,
    is_valid_language_for_engine,
)
from stt_v2.pipeline.yaml_parser import PipelineYamlParser

FASTER_WHISPER_YAML = """
version: "1.1"
models:
  asr:
    hf_model_id: "arcaai/whisper-large-v3-ct2"
    engine: faster_whisper
inference:
  language: ml
  code_switching: false
"""


FASTER_WHISPER_COMPUTE_TYPE_YAML = """
version: "1.1"
models:
  asr:
    hf_model_id: "arcaai/whisper-large-v3-ct2"
    engine: faster_whisper
    compute_type: "{compute_type}"
inference:
  language: en
"""


class TestFasterWhisperEngineMapping:
    def test_engine_faster_whisper_underscore(self):
        ref = ModelRef.from_value(
            {"hf_model_id": "x/y-ct2", "engine": "faster_whisper"}
        )
        assert ref.inline.engine == AiModelFormat.FASTER_WHISPER

    def test_engine_faster_whisper_hyphen(self):
        ref = ModelRef.from_value(
            {"hf_model_id": "x/y-ct2", "engine": "faster-whisper"}
        )
        assert ref.inline.engine == AiModelFormat.FASTER_WHISPER

    def test_supports_initial_prompt(self):
        assert engine_supports_initial_prompt(AiModelFormat.FASTER_WHISPER) is True

    def test_whisper_languages_valid_for_engine(self):
        assert is_valid_language_for_engine("ml", AiModelFormat.FASTER_WHISPER) is True
        assert is_valid_language_for_engine("zz", AiModelFormat.FASTER_WHISPER) is False


class TestYamlParserFasterWhisper:
    def test_parses_faster_whisper_engine(self):
        parser = PipelineYamlParser()
        spec = parser.parse(FASTER_WHISPER_YAML)
        assert spec.models.asr.is_inline is True
        assert spec.models.asr.inline.engine == AiModelFormat.FASTER_WHISPER
        assert spec.models.asr.inline.hf_model_id == "arcaai/whisper-large-v3-ct2"

        result = parser.validate(spec)
        assert result.valid is True, result.get_error_messages()

    def test_valid_ct2_compute_type_passes(self):
        parser = PipelineYamlParser()
        spec = parser.parse(
            FASTER_WHISPER_COMPUTE_TYPE_YAML.format(compute_type="int8_float16")
        )
        result = parser.validate(spec)
        assert result.valid is True, result.get_error_messages()

    def test_invalid_ct2_compute_type_rejected(self):
        parser = PipelineYamlParser()
        spec = parser.parse(
            FASTER_WHISPER_COMPUTE_TYPE_YAML.format(compute_type="fp99")
        )
        result = parser.validate(spec)
        assert result.valid is False
        assert any(
            "compute_type" in err.field for err in result.errors
        ), result.get_error_messages()

    def test_invalid_compute_type_other_engine_not_ct2_checked(self):
        # The CT2 compute-type rule must not apply to non-FW engines:
        # safetensor engines validate compute types elsewhere.
        yaml_text = """
version: "1.1"
models:
  asr:
    hf_model_id: "openai/whisper-large-v3"
    engine: safetensor
    compute_type: "int8_float16"
inference:
  language: en
"""
        parser = PipelineYamlParser()
        spec = parser.parse(yaml_text)
        result = parser.validate(spec)
        assert result.valid is True, result.get_error_messages()
