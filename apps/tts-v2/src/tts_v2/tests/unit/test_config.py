"""TDD tests for tts_v2 Settings (TASK-488 Phase 1)."""

from __future__ import annotations

from tts_v2.core.config import AzureSpeechConfig, Settings


class TestDefaults:
    def test_port_default_is_8865(self) -> None:
        assert Settings().port == 8865

    def test_service_token_empty_by_default(self) -> None:
        assert Settings().service_token.get_secret_value() == ""

    def test_synthesis_defaults(self) -> None:
        s = Settings()
        assert s.max_input_chars == 4096
        assert s.default_format == "pcm"
        assert s.sample_rate == 24000

    def test_default_routing_chains(self) -> None:
        s = Settings()
        assert s.routing_en == ["azure", "kokoro"]
        assert s.routing_ml == ["azure", "indic_parler"]


class TestEnvPrefix:
    def test_port_from_env(self, monkeypatch) -> None:
        monkeypatch.setenv("TTS_PORT", "9999")
        assert Settings().port == 9999

    def test_service_token_from_env(self, monkeypatch) -> None:
        monkeypatch.setenv("TTS_SERVICE_TOKEN", "secret-tok")
        assert Settings().service_token.get_secret_value() == "secret-tok"

    def test_routing_csv_parsed(self, monkeypatch) -> None:
        monkeypatch.setenv("TTS_ROUTING_EN", "kokoro, azure")
        assert Settings().routing_en == ["kokoro", "azure"]


class TestAzureAliasFallback:
    """Azure credential falls back to the shared stt-v2 Azure Speech secret."""

    def test_reads_shared_azure_speech_key(self, monkeypatch) -> None:
        monkeypatch.delenv("TTS_AZURE_API_KEY", raising=False)
        monkeypatch.setenv("AZURE_SPEECH_KEY", "shared-key-123")
        assert AzureSpeechConfig().api_key.get_secret_value() == "shared-key-123"

    def test_prefixed_key_takes_precedence(self, monkeypatch) -> None:
        monkeypatch.setenv("AZURE_SPEECH_KEY", "shared")
        monkeypatch.setenv("TTS_AZURE_API_KEY", "prefixed")
        assert AzureSpeechConfig().api_key.get_secret_value() == "prefixed"

    def test_region_fallback(self, monkeypatch) -> None:
        monkeypatch.delenv("TTS_AZURE_REGION", raising=False)
        monkeypatch.setenv("AZURE_SPEECH_REGION", "centralindia")
        assert AzureSpeechConfig().region == "centralindia"
