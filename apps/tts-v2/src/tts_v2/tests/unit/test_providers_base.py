"""TDD tests for the provider registry + engine contract (TASK-488 Phase 2)."""

from __future__ import annotations

import pytest

from tts_v2.providers.base import (
    AudioFormat,
    ProviderNotFoundError,
    ProviderRegistry,
    TTSEngine,
)
from tts_v2.tests.fakes import FakeEngine


class TestRegistry:
    def test_register_and_get(self) -> None:
        reg = ProviderRegistry()
        engine = FakeEngine("azure")
        reg.register("azure", engine)
        assert reg.get("azure") is engine
        assert "azure" in reg
        assert reg.list_providers() == ["azure"]

    def test_get_missing_raises(self) -> None:
        with pytest.raises(ProviderNotFoundError):
            ProviderRegistry().get("nope")

    def test_unregister_is_idempotent(self) -> None:
        reg = ProviderRegistry()
        reg.register("x", FakeEngine("x"))
        reg.unregister("x")
        assert "x" not in reg
        reg.unregister("x")  # no error second time

    def test_fake_satisfies_protocol(self) -> None:
        assert isinstance(FakeEngine("a"), TTSEngine)


def test_audio_format_values() -> None:
    assert AudioFormat.PCM == "pcm"
    assert AudioFormat.WAV == "wav"
    assert AudioFormat.MP3 == "mp3"
