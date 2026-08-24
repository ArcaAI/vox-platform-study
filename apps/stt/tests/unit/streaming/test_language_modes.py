"""Unit tests for the STT language-mode capability matrix."""

from __future__ import annotations

import pytest

from stt.pipeline.dto import AiModelFormat
from stt.pipeline.language_modes import (
    LANGUAGE_MODES_BY_ID,
    LanguageModeUnsupportedError,
    engine_supports_mode,
    engines_supporting_mode,
    get_language_mode,
    language_mode_catalog_payload,
    modes_supported_by_engine,
    resolve_mode_for_engine,
)


def test_catalog_contains_expected_modes() -> None:
    assert set(LANGUAGE_MODES_BY_ID) == {"en", "ml", "ml-en", "vi", "vi-en", "auto"}


def test_english_supported_by_every_engine() -> None:
    # "en" is in both the Whisper and Parakeet-v3 sets, so all engines serve it.
    assert engines_supporting_mode("en") == [e.value for e in AiModelFormat]


def test_malayalam_unsupported_by_parakeet_nemo() -> None:
    # NEMO/Parakeet-v3 is European-only: no Malayalam.
    ml = get_language_mode("ml")
    assert engine_supports_mode(ml, AiModelFormat.NEMO) is False
    assert AiModelFormat.NEMO.value not in engines_supporting_mode("ml")
    # But Whisper family / Sarvam / Azure can.
    assert engine_supports_mode(ml, AiModelFormat.FASTER_WHISPER) is True
    assert engine_supports_mode(ml, AiModelFormat.SARVAM) is True
    assert engine_supports_mode(ml, AiModelFormat.AZURE_SPEECH) is True


def test_code_switch_only_on_capable_engines() -> None:
    supported = set(engines_supporting_mode("ml-en"))
    # Sarvam (native), Azure (flag), Whisper-family (gloss) can serve ml-en.
    assert AiModelFormat.SARVAM.value in supported
    assert AiModelFormat.AZURE_SPEECH.value in supported
    assert AiModelFormat.FASTER_WHISPER.value in supported
    # OpenAI (single-language) and NEMO/Parakeet cannot.
    assert AiModelFormat.OPENAI.value not in supported
    assert AiModelFormat.NEMO.value not in supported
    assert AiModelFormat.PARAKEET_CPP.value not in supported


def test_resolve_code_switch_per_engine() -> None:
    # Sarvam native: signal code_switching so the integration requests
    # auto-detect (language_code="unknown") for the code-mixed audio.
    sarvam = resolve_mode_for_engine("ml-en", AiModelFormat.SARVAM)
    assert (sarvam.language, sarvam.code_switching, sarvam.streaming_english_gloss) == (
        "ml",
        True,
        False,
    )
    # Azure flag: pin primary + code_switching.
    azure = resolve_mode_for_engine("ml-en", AiModelFormat.AZURE_SPEECH)
    assert (azure.language, azure.code_switching, azure.streaming_english_gloss) == (
        "ml",
        True,
        False,
    )
    # Whisper gloss: pin primary + English gloss track.
    whisper = resolve_mode_for_engine("ml-en", AiModelFormat.FASTER_WHISPER)
    assert (whisper.language, whisper.code_switching, whisper.streaming_english_gloss) == (
        "ml",
        False,
        True,
    )


def test_vietnamese_excludes_sarvam_but_not_whisper_azure() -> None:
    # Sarvam is Indic + English only — it must NOT claim Vietnamese, even though
    # 'vi' is in the Whisper set (the generic proxy would have said yes).
    vi = get_language_mode("vi")
    assert engine_supports_mode(vi, AiModelFormat.SARVAM) is False
    assert engine_supports_mode(vi, AiModelFormat.FASTER_WHISPER) is True
    assert engine_supports_mode(vi, AiModelFormat.AZURE_SPEECH) is True
    assert engine_supports_mode(vi, AiModelFormat.OPENAI) is True  # single language

    # 'vi-en' code-switch: Azure (flag) + Whisper family (gloss) can; Sarvam
    # cannot (no Vietnamese) and OpenAI cannot (no code-switch).
    vi_en_engines = set(engines_supporting_mode("vi-en"))
    assert AiModelFormat.AZURE_SPEECH.value in vi_en_engines
    assert AiModelFormat.FASTER_WHISPER.value in vi_en_engines
    assert AiModelFormat.SARVAM.value not in vi_en_engines
    assert AiModelFormat.OPENAI.value not in vi_en_engines


def test_sarvam_still_serves_malayalam_code_switch() -> None:
    # Precision must not regress Sarvam's real strengths.
    assert engine_supports_mode(get_language_mode("ml"), AiModelFormat.SARVAM) is True
    assert engine_supports_mode(get_language_mode("ml-en"), AiModelFormat.SARVAM) is True


def test_resolve_single_and_auto() -> None:
    single = resolve_mode_for_engine("en", AiModelFormat.OPENAI)
    assert (single.language, single.code_switching, single.streaming_english_gloss) == (
        "en",
        False,
        False,
    )
    auto = resolve_mode_for_engine("auto", AiModelFormat.NEMO)
    assert (auto.language, auto.code_switching, auto.streaming_english_gloss) == (
        None,
        False,
        False,
    )


def test_resolve_raises_on_unsupported() -> None:
    with pytest.raises(LanguageModeUnsupportedError) as exc:
        resolve_mode_for_engine("ml", AiModelFormat.NEMO)
    # The error advertises what NEMO CAN serve, so the client can recover.
    assert exc.value.mode_id == "ml"
    assert exc.value.engine == AiModelFormat.NEMO
    assert "en" in exc.value.supported_mode_ids
    assert "ml" not in exc.value.supported_mode_ids


def test_modes_supported_by_engine_openai_excludes_code_switch() -> None:
    openai_modes = set(modes_supported_by_engine(AiModelFormat.OPENAI))
    assert "en" in openai_modes
    assert "auto" in openai_modes
    assert "ml-en" not in openai_modes
    assert "vi-en" not in openai_modes
    # OpenAI is single-language but Whisper-family: it DOES serve 'vi'.
    assert "vi" in openai_modes


def test_whisper_cpp_code_switch_via_prompt() -> None:
    # whisper.cpp has no task=translate gloss, but primes code-switch via a
    # bilingual initial_prompt — so it DOES serve ml-en / vi-en (the platform's
    # default ml-en GGUF model is a code-switch model).
    assert engine_supports_mode(get_language_mode("ml-en"), AiModelFormat.WHISPER_CPP) is True
    assert engine_supports_mode(get_language_mode("vi-en"), AiModelFormat.WHISPER_CPP) is True
    supported = set(modes_supported_by_engine(AiModelFormat.WHISPER_CPP))
    assert {"en", "ml", "ml-en", "vi", "vi-en", "auto"} <= supported
    assert AiModelFormat.WHISPER_CPP.value in engines_supporting_mode("ml-en")
    assert AiModelFormat.WHISPER_CPP.value in engines_supporting_mode("vi-en")


def test_resolve_whisper_cpp_pair_unpinned_prompt_disabled() -> None:
    # Priming prompt is TEMPORARILY disabled (WHISPER_CPP_PRIMING_PROMPT_ENABLED
    # is False): the pair still resolves (no cloud fallback) but emits NO prompt —
    # the native code-switch GGUF handles the mix. Pair: do NOT pin a language.
    resolved = resolve_mode_for_engine("ml-en", AiModelFormat.WHISPER_CPP)
    assert resolved.language is None
    assert resolved.code_switching is False
    assert resolved.streaming_english_gloss is False
    assert resolved.initial_prompt is None

    vi = resolve_mode_for_engine("vi-en", AiModelFormat.WHISPER_CPP)
    assert vi.language is None
    assert vi.initial_prompt is None


def test_resolve_whisper_cpp_single_pins_prompt_disabled() -> None:
    # Single: pin the chosen language; no priming prompt while disabled.
    en = resolve_mode_for_engine("en", AiModelFormat.WHISPER_CPP)
    assert en.language == "en"
    assert en.initial_prompt is None

    ml = resolve_mode_for_engine("ml", AiModelFormat.WHISPER_CPP)
    assert ml.language == "ml"
    assert ml.initial_prompt is None

    auto = resolve_mode_for_engine("auto", AiModelFormat.WHISPER_CPP)
    assert auto.language is None
    assert auto.initial_prompt is None


def test_whisper_cpp_priming_prompt_when_reenabled(monkeypatch: pytest.MonkeyPatch) -> None:
    # Guard the prompt-building path so flipping the kill-switch back on is a
    # one-line, still-tested change.
    import stt.pipeline.language_modes as lm

    monkeypatch.setattr(lm, "WHISPER_CPP_PRIMING_PROMPT_ENABLED", True)

    pair = lm.resolve_mode_for_engine("ml-en", AiModelFormat.WHISPER_CPP)
    assert pair.language is None
    assert pair.initial_prompt is not None
    assert "Malayalam" in pair.initial_prompt
    assert "English" in pair.initial_prompt

    single = lm.resolve_mode_for_engine("en", AiModelFormat.WHISPER_CPP)
    assert single.language == "en"
    assert single.initial_prompt is not None
    assert "English" in single.initial_prompt
    assert "Malayalam" not in single.initial_prompt


def test_single_language_never_prompts_non_prompt_engines() -> None:
    # Non-prompt engines keep the plain single-language behavior: pin, no prompt.
    fw = resolve_mode_for_engine("en", AiModelFormat.FASTER_WHISPER)
    assert fw.language == "en"
    assert fw.initial_prompt is None
    openai = resolve_mode_for_engine("en", AiModelFormat.OPENAI)
    assert openai.language == "en"
    assert openai.initial_prompt is None


def test_catalog_payload_shape() -> None:
    payload = language_mode_catalog_payload()
    assert [m["id"] for m in payload] == ["en", "ml", "ml-en", "vi", "vi-en", "auto"]
    ml_en = next(m for m in payload if m["id"] == "ml-en")
    assert ml_en["kind"] == "code_switch"
    assert ml_en["primaryLanguage"] == "ml"
    assert ml_en["secondaryLanguage"] == "en"
    assert AiModelFormat.SARVAM.value in ml_en["supportedEngines"]
