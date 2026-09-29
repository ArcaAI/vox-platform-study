"""DTO engine helpers: engine-name mapping, initial-prompt support, engine-valid languages."""

from __future__ import annotations

from stt.pipeline.dto import (
    AiModelFormat,
    ModelRef,
    engine_supports_initial_prompt,
    is_valid_language_for_engine,
)


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


class TestFasterWhisperEngineMapping:
    def test_engine_faster_whisper_underscore(self):
        ref = ModelRef.from_value({"hf_model_id": "x/y-ct2", "engine": "faster_whisper"})
        assert ref.inline.engine == AiModelFormat.FASTER_WHISPER

    def test_engine_faster_whisper_hyphen(self):
        ref = ModelRef.from_value({"hf_model_id": "x/y-ct2", "engine": "faster-whisper"})
        assert ref.inline.engine == AiModelFormat.FASTER_WHISPER

    def test_supports_initial_prompt(self):
        assert engine_supports_initial_prompt(AiModelFormat.FASTER_WHISPER) is True

    def test_whisper_languages_valid_for_engine(self):
        assert is_valid_language_for_engine("ml", AiModelFormat.FASTER_WHISPER) is True
        assert is_valid_language_for_engine("zz", AiModelFormat.FASTER_WHISPER) is False
