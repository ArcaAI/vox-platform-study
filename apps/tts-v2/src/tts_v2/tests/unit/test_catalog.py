"""TDD tests for the voice catalog."""

from __future__ import annotations

import pytest

from tts_v2.catalog.voices import VoiceCatalog, VoiceNotFoundError


class TestCatalog:
    def test_known_voice_resolves_locale_and_bindings(self) -> None:
        v = VoiceCatalog().get("ml-female-1")
        assert v.locale == "ml-IN"
        assert v.bindings["azure"] == "ml-IN-SobhanaNeural"
        assert v.bindings["indic_parler"] == "Anjali"

    def test_english_voice_binds_azure_and_kokoro(self) -> None:
        v = VoiceCatalog().get("en-female-1")
        assert v.locale == "en-IN"
        assert set(v.bindings) == {"azure", "kokoro"}

    def test_unknown_voice_raises(self) -> None:
        with pytest.raises(VoiceNotFoundError):
            VoiceCatalog().get("does-not-exist")

    def test_list_voices_covers_both_languages(self) -> None:
        locales = {v.locale for v in VoiceCatalog().list_voices()}
        assert "en-IN" in locales and "ml-IN" in locales
