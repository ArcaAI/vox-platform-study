"""YAML parser tests for NeMo (Parakeet) engine handling."""

from __future__ import annotations

from stt_v2.pipeline.dto import (
    AiModelFormat,
    engine_supports_initial_prompt,
    is_valid_language_for_engine,
)
from stt_v2.pipeline.yaml_parser import PipelineYamlParser

PARAKEET_YAML = """
version: "1.1"
models:
  asr:
    hf_model_id: "nvidia/parakeet-tdt-0.6b-v2"
    engine: NEMO
inference:
  language: en
  code_switching: false
"""


PARAKEET_V3_MULTILINGUAL_YAML = """
version: "1.1"
models:
  asr:
    hf_model_id: "nvidia/parakeet-tdt-0.6b-v3"
    engine: NEMO
inference:
  language: it
"""


PARAKEET_WITH_INITIAL_PROMPT_YAML = """
version: "1.1"
models:
  asr:
    hf_model_id: "nvidia/parakeet-tdt-0.6b-v2"
    engine: NEMO
inference:
  initial_prompt: "00000000-0000-0000-0000-000000000001"
"""


class TestEngineHelpers:
    def test_engine_supports_initial_prompt_for_whisper(self):
        assert engine_supports_initial_prompt(AiModelFormat.SAFETENSOR) is True
        assert engine_supports_initial_prompt(AiModelFormat.ONNX_OPTIMUM) is True
        assert engine_supports_initial_prompt(AiModelFormat.CTRANSLATE2) is True

    def test_engine_supports_initial_prompt_false_for_nemo(self):
        assert engine_supports_initial_prompt(AiModelFormat.NEMO) is False

    def test_is_valid_language_for_engine_whisper_only(self):
        assert is_valid_language_for_engine("en", AiModelFormat.SAFETENSOR) is True
        assert is_valid_language_for_engine("zz", AiModelFormat.SAFETENSOR) is False

    def test_is_valid_language_for_engine_accepts_v3_multilingual_codes_for_nemo(self):
        # Sample of Parakeet-v3 supported European languages
        for code in ("en", "it", "de", "es", "fr", "pl"):
            assert is_valid_language_for_engine(code, AiModelFormat.NEMO) is True

    def test_is_valid_language_for_engine_rejects_unknown_for_nemo(self):
        assert is_valid_language_for_engine("zz", AiModelFormat.NEMO) is False

    def test_is_valid_language_for_engine_rejects_non_parakeet_for_nemo(self):
        # NEMO no longer falls back to the Whisper language
        # set: codes outside Parakeet-v3 (e.g. Malayalam, Catalan) are
        # invalid for the Parakeet engine.
        for code in ("ml", "ca", "ml-IN"):
            assert is_valid_language_for_engine(code, AiModelFormat.NEMO) is False


class TestYamlParserNemo:
    def test_parses_nemo_engine_with_parakeet_hf_id(self):
        parser = PipelineYamlParser()
        spec = parser.parse(PARAKEET_YAML)
        assert spec.models.asr.is_inline is True
        assert spec.models.asr.inline.engine == AiModelFormat.NEMO
        assert spec.models.asr.inline.hf_model_id == "nvidia/parakeet-tdt-0.6b-v2"

        result = parser.validate(spec)
        assert result.valid is True, result.get_error_messages()

    def test_validates_parakeet_v3_multilingual_language(self):
        parser = PipelineYamlParser()
        spec = parser.parse(PARAKEET_V3_MULTILINGUAL_YAML)
        result = parser.validate(spec)
        assert result.valid is True, result.get_error_messages()

    def test_validate_does_not_reject_initial_prompt_with_nemo_uuid(self):
        # initial_prompt is ignored at runtime, but must remain a valid UUID
        # to keep the schema consistent. Validation must still pass.
        parser = PipelineYamlParser()
        spec = parser.parse(PARAKEET_WITH_INITIAL_PROMPT_YAML)
        result = parser.validate(spec)
        assert result.valid is True, result.get_error_messages()


class TestNemoUnsupportedLanguageGuard:
    """NEMO + a language outside the Parakeet-v3 set is a
    hard validation error (e.g. Malayalam is Whisper-only)."""

    def _yaml(self, language: str) -> str:
        return f"""
version: "1.1"
models:
  asr:
    hf_model_id: "nvidia/parakeet-tdt-0.6b-v3"
    engine: NEMO
inference:
  language: {language}
"""

    def test_malayalam_with_nemo_engine_is_hard_error(self):
        parser = PipelineYamlParser()
        spec = parser.parse(self._yaml("ml"))
        result = parser.validate(spec)
        assert result.valid is False
        assert any(
            "inference.language" in err.field for err in result.errors
        ), result.get_error_messages()

    def test_bcp47_unsupported_language_with_nemo_is_hard_error(self):
        parser = PipelineYamlParser()
        spec = parser.parse(self._yaml("ml-IN"))
        result = parser.validate(spec)
        assert result.valid is False

    def test_parakeet_v3_language_with_nemo_still_valid(self):
        parser = PipelineYamlParser()
        spec = parser.parse(self._yaml("de"))
        result = parser.validate(spec)
        assert result.valid is True, result.get_error_messages()

    def test_unsupported_language_with_whisper_engine_unaffected(self):
        yaml_content = """
version: "1.1"
models:
  asr:
    hf_model_id: "openai/whisper-large-v3"
    engine: safetensor
inference:
  language: ml
"""
        parser = PipelineYamlParser()
        spec = parser.parse(yaml_content)
        result = parser.validate(spec)
        assert result.valid is True, result.get_error_messages()
