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


def test_resolve_whisper_cpp_pair_unpinned_but_primed() -> None:
    """A pair NEVER pins a language; with the switch on it is primed instead.

    TASK-938 turned the pair switch ON, which matters precisely because of the
    first assertion: pinning the primary of a pair would bias the secondary's
    script, so the bilingual prompt is the ONLY bias correction a code-switch
    session gets. With it off (the state through 2026-09-09) the decoder had no
    language signal at all and re-ran its own LID per decode window."""
    resolved = resolve_mode_for_engine("ml-en", AiModelFormat.WHISPER_CPP)
    assert resolved.language is None
    assert resolved.code_switching is False
    assert resolved.streaming_english_gloss is False
    assert resolved.initial_prompt is not None
    assert "Malayalam" in resolved.initial_prompt
    assert "English" in resolved.initial_prompt

    vi = resolve_mode_for_engine("vi-en", AiModelFormat.WHISPER_CPP)
    assert vi.language is None
    assert vi.initial_prompt is not None
    assert "Vietnamese" in vi.initial_prompt


def test_resolve_whisper_cpp_single_pins_and_does_not_prime() -> None:
    """TASK-946 (OD-2) — a single mode PINS its language and carries no prompt.

    The pin is what the mode is for. The prompt on top of it was TASK-938's; measured
    in isolation on the owner's recording it kept the script Latin but lost 43 % of the
    content and echoed its own instruction text ("...and English") into the transcript,
    which is exactly the failure mode TASK-891 A3 predicted for an instruction-shaped
    ``initial_prompt``. ``auto`` is neither pinned nor primed — it is the deliberate
    "let the model decide"."""
    en = resolve_mode_for_engine("en", AiModelFormat.WHISPER_CPP)
    assert en.language == "en"
    assert en.initial_prompt is None

    ml = resolve_mode_for_engine("ml", AiModelFormat.WHISPER_CPP)
    assert ml.language == "ml"
    assert ml.initial_prompt is None

    auto = resolve_mode_for_engine("auto", AiModelFormat.WHISPER_CPP)
    assert auto.language is None
    assert auto.initial_prompt is None


def test_task946_only_the_pair_priming_prompt_ships_on() -> None:
    """TASK-891 A3 made the ONE kill-switch TWO; TASK-938 turned both ON; OD-2 turns
    the SINGLE-language one back OFF and leaves the PAIR one ON.

    They stay two switches for the reason A3 gave — they are different experiments and
    must be flippable apart (the two tests below prove they still are). The pair prompt
    is a code-switch pair's ONLY bias correction and has not been measured on this
    fine-tune, so it is untouched pending its own A/B. This assertion is the SHIPPED
    state, deliberately pinned so a change of decode behaviour is a visible test edit
    and not a silent one."""
    import stt.pipeline.language_modes as lm

    assert lm.WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED is True
    assert lm.WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED is False


def test_task891_pair_priming_prompt_is_independently_switchable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Turning the PAIR prompt on must not turn the single-language one on."""
    import stt.pipeline.language_modes as lm

    monkeypatch.setattr(lm, "WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED", True)
    monkeypatch.setattr(lm, "WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED", False)

    pair = lm.resolve_mode_for_engine("ml-en", AiModelFormat.WHISPER_CPP)
    assert pair.language is None
    assert pair.initial_prompt is not None
    assert "Malayalam" in pair.initial_prompt
    assert "English" in pair.initial_prompt

    # The single-language switch was set OFF above, so a declared language still
    # reaches the decoder as a pin and nothing else.
    single = lm.resolve_mode_for_engine("en", AiModelFormat.WHISPER_CPP)
    assert single.language == "en"
    assert single.initial_prompt is None


def test_task891_single_priming_prompt_is_independently_switchable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Turning the SINGLE-language prompt on must not turn the pair one on."""
    import stt.pipeline.language_modes as lm

    monkeypatch.setattr(lm, "WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED", True)
    monkeypatch.setattr(lm, "WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED", False)

    single = lm.resolve_mode_for_engine("en", AiModelFormat.WHISPER_CPP)
    assert single.language == "en"
    assert single.initial_prompt is not None
    assert "English" in single.initial_prompt
    assert "Malayalam" not in single.initial_prompt

    pair = lm.resolve_mode_for_engine("ml-en", AiModelFormat.WHISPER_CPP)
    assert pair.language is None
    assert pair.initial_prompt is None


def test_task891_neither_prompt_reaches_a_non_prompt_engine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Both switches are whisper.cpp-only: an engine that is not primed by an
    ``initial_prompt`` never receives one, whatever the flags say."""
    import stt.pipeline.language_modes as lm

    monkeypatch.setattr(lm, "WHISPER_CPP_PAIR_PRIMING_PROMPT_ENABLED", True)
    monkeypatch.setattr(lm, "WHISPER_CPP_SINGLE_PRIMING_PROMPT_ENABLED", True)

    assert lm.resolve_mode_for_engine("en", AiModelFormat.FASTER_WHISPER).initial_prompt is None
    assert lm.resolve_mode_for_engine("ml-en", AiModelFormat.SARVAM).initial_prompt is None


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


def test_task946_latin_script_membership_comes_from_the_catalog() -> None:
    """OD-2's sibling: which catalog languages are written in the Latin alphabet.

    ``None`` is not Latin-script on purpose — auto-detect and an unpinned code-switch
    pair declare no language, so there is no pin for a decode to contradict."""
    import stt.pipeline.language_modes as lm

    assert lm.is_latin_script_language("en") is True
    assert lm.is_latin_script_language("vi") is True
    assert lm.is_latin_script_language("EN") is True
    assert lm.is_latin_script_language("en-US") is True
    assert lm.is_latin_script_language("ml") is False
    assert lm.is_latin_script_language(None) is False
    assert lm.is_latin_script_language("") is False
    # Every single-language catalog entry is classified one way or the other.
    for mode in lm.LANGUAGE_MODE_CATALOG:
        if mode.kind == "single":
            assert isinstance(lm.is_latin_script_language(mode.primary_language), bool)


def test_task946_latin_letter_ratio_counts_letters_only() -> None:
    """Diacritics are Latin; digits and punctuation do not vote; empty is not a miss."""
    from stt.pipeline.language_modes import latin_letter_ratio

    assert latin_letter_ratio("The patient reports severe chest pain.") == 1.0
    # Vietnamese is Latin-script and mostly non-ASCII — an `isascii()` test would call
    # a correct `vi` transcript foreign and fire the tripwire this feeds.
    assert latin_letter_ratio("Bệnh nhân bị đau ngực dữ dội") == 1.0
    assert latin_letter_ratio("രോഗിക്ക് നെഞ്ചുവേദന ഉണ്ട്") == 0.0
    assert 0.7 < latin_letter_ratio("patient രോഗി") < 0.8
    # No letters at all ⇒ no evidence of a foreign script.
    assert latin_letter_ratio("12:30 ... ") == 1.0
    assert latin_letter_ratio("") == 1.0
