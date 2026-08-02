"""TDD tests for tts Settings."""

from __future__ import annotations

from tts.core.config import AzureSpeechConfig, Settings


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

    def test_no_routing_vendor_default_in_config(self) -> None:
        # TASK-577 / F1: provider SELECTION is DB-sourced (SYSTEM TenantTtsConfig),
        # so Settings carries NO routing chain — env can no longer bake a vendor
        # order and the router fails closed when nothing is injected.
        s = Settings()
        assert not hasattr(s, "routing_en")
        assert not hasattr(s, "routing_ml")


class TestEnvPrefix:
    def test_port_from_env(self, monkeypatch) -> None:
        monkeypatch.setenv("TTS_PORT", "9999")
        assert Settings().port == 9999

    def test_service_token_from_env(self, monkeypatch) -> None:
        monkeypatch.setenv("TTS_SERVICE_TOKEN", "secret-tok")
        assert Settings().service_token.get_secret_value() == "secret-tok"

    def test_routing_env_var_is_not_a_selectable_default(self, monkeypatch) -> None:
        # Setting the old env var must NOT reintroduce a routing default: there is
        # no field to populate, so it is inert (selection lives in the DB now).
        monkeypatch.setenv("TTS_ROUTING_EN", "kokoro, azure")
        assert not hasattr(Settings(), "routing_en")


class TestAzureCredentialByok:
    """TASK-602: the Azure Speech KEY is BYOK-only — never sourced from env. The
    non-secret REGION still resolves from its env aliases."""

    def test_api_key_not_read_from_prefixed_env(self, monkeypatch) -> None:
        monkeypatch.setenv("TTS_AZURE_API_KEY", "prefixed")
        assert AzureSpeechConfig().api_key.get_secret_value() == ""

    def test_api_key_not_read_from_shared_env(self, monkeypatch) -> None:
        monkeypatch.delenv("TTS_AZURE_API_KEY", raising=False)
        monkeypatch.setenv("AZURE_SPEECH_KEY", "shared-key-123")
        assert AzureSpeechConfig().api_key.get_secret_value() == ""

    def test_region_fallback_still_env_sourced(self, monkeypatch) -> None:
        monkeypatch.delenv("TTS_AZURE_REGION", raising=False)
        monkeypatch.setenv("AZURE_SPEECH_REGION", "centralindia")
        assert AzureSpeechConfig().region == "centralindia"


class TestSarvamCredentialByok:
    """TASK-602: the Sarvam KEY is BYOK-only — never sourced from env."""

    def test_api_key_not_read_from_env(self, monkeypatch) -> None:
        from tts.core.config import SarvamConfig

        monkeypatch.setenv("TTS_SARVAM_API_KEY", "leaked")
        assert SarvamConfig().api_key.get_secret_value() == ""
