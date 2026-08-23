"""Unit tests for the Azure AI Foundry (MAI-Transcribe) loader.

Covers the BYOK-only credential contract (there is no env fallback for the
key — the sibling ``azure_speech_loader`` has never had one), and the
fail-closed model SELECTION: the pipeline's resolved model wins and an
unresolved selection raises rather than substituting a literal.
"""

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest
from pydantic import SecretStr

from stt.core.exceptions import CloudASRAuthError, ConfigurationError
from stt.models.azure_foundry_loader import AzureFoundryLoader
from stt.models.base_loader import LoadedModel
from stt.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
)


def _config(source_uri: str | None = "mai-transcribe-1.5") -> AiModelConfig:
    return AiModelConfig(
        id="m-foundry-1",
        tenant_id="t-1",
        slug="azure-foundry-stt",
        name="Azure Foundry STT",
        description="Azure AI Foundry MAI-Transcribe",
        task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        source=AiModelSource.LOCAL,
        source_uri=source_uri,
        source_revision=None,
        format=AiModelFormat.AZURE_FOUNDRY,
        memory_size_mb=0,
        compute_type=None,
        download_status=AiModelDownloadStatus.DOWNLOADED,
        local_path=None,
        downloaded_at=datetime.utcnow(),
        file_size_mb=0,
        checksum=None,
        tags=[],
    )


def _settings(**overrides: object) -> MagicMock:
    """Settings double. Anything an env-reading regression might reach for is
    deliberately POPULATED here, so a loader that falls back to env passes a
    value through and the assertion below catches it."""
    base: dict[str, object] = {
        "azure_foundry_enabled": True,
        "azure_foundry_endpoint": "https://env-res.cognitiveservices.azure.com",
    }
    base.update(overrides)
    return MagicMock(**base)


class TestAzureFoundryCredentialsAreByokOnly:
    """`azure.foundryApiKey` is a registered vault-kv platform-secret descriptor
    (`platform-secrets.descriptors.ts:251`) — the governance already existed and
    the reader simply never asked for it. There is no env path to the key."""

    @pytest.mark.asyncio
    async def test_no_override_fails_closed_and_never_reads_env(self):
        # An env-shaped key is planted on the settings double. If the loader
        # still has an env fallback it will succeed; BYOK-only means it must not.
        settings = _settings(azure_foundry_api_key=SecretStr("env-foundry-key"))
        with patch("stt.models.azure_foundry_loader.get_settings", return_value=settings):
            with pytest.raises(CloudASRAuthError) as exc:
                await AzureFoundryLoader().load(_config())

        assert exc.value.details["has_key"] is False

    @pytest.mark.asyncio
    async def test_settings_expose_no_foundry_api_key_field(self):
        """Structural half of the guarantee: the field is gone from Settings, so
        no env var can reach the key even if a future reader asks for it."""
        from stt.core.config.settings import Settings

        assert "azure_foundry_api_key" not in Settings.model_fields

    @pytest.mark.asyncio
    async def test_override_key_is_used(self):
        settings = _settings()
        with patch("stt.models.azure_foundry_loader.get_settings", return_value=settings):
            result = await AzureFoundryLoader().load(
                _config(),
                provider_overrides={"azure-speech": {"api_key": "byok-foundry-key"}},
            )

        assert isinstance(result, LoadedModel)
        assert result.model["api_key"] == "byok-foundry-key"
        assert result.format == AiModelFormat.AZURE_FOUNDRY

    @pytest.mark.asyncio
    async def test_override_endpoint_wins_over_the_non_secret_env_endpoint(self):
        """The ENDPOINT is non-secret, so its env fallback legitimately stays."""
        settings = _settings()
        with patch("stt.models.azure_foundry_loader.get_settings", return_value=settings):
            byok = await AzureFoundryLoader().load(
                _config(),
                provider_overrides={
                    "azure-speech": {
                        "api_key": "byok-foundry-key",
                        "endpoint": "https://tenant-res.cognitiveservices.azure.com/",
                    }
                },
            )
            env = await AzureFoundryLoader().load(
                _config(),
                provider_overrides={"azure-speech": {"api_key": "byok-foundry-key"}},
            )

        assert byok.model["endpoint"] == "https://tenant-res.cognitiveservices.azure.com"
        assert env.model["endpoint"] == "https://env-res.cognitiveservices.azure.com"

    @pytest.mark.asyncio
    async def test_missing_endpoint_still_fails_closed(self):
        settings = _settings(azure_foundry_endpoint=None)
        with patch("stt.models.azure_foundry_loader.get_settings", return_value=settings):
            with pytest.raises(CloudASRAuthError) as exc:
                await AzureFoundryLoader().load(
                    _config(),
                    provider_overrides={"azure-speech": {"api_key": "byok-foundry-key"}},
                )

        assert exc.value.details["has_endpoint"] is False


class TestAzureFoundryModelSelectionFailsClosed:
    """Model SELECTION is `failMode: closed` — the pipeline's resolved model wins
    and an unresolved one raises instead of falling back to a code literal."""

    @pytest.mark.asyncio
    async def test_pipeline_model_wins(self):
        settings = _settings()
        with patch("stt.models.azure_foundry_loader.get_settings", return_value=settings):
            result = await AzureFoundryLoader().load(
                _config(source_uri="mai-transcribe-2.0"),
                provider_overrides={"azure-speech": {"api_key": "byok-foundry-key"}},
            )

        assert result.model["model"] == "mai-transcribe-2.0"

    @pytest.mark.asyncio
    async def test_unresolved_model_raises_instead_of_a_literal_default(self):
        # A literal default planted on the settings double: a loader that still
        # falls back to it returns a model name instead of raising.
        settings = _settings(azure_foundry_model="mai-transcribe-1.5")
        with patch("stt.models.azure_foundry_loader.get_settings", return_value=settings):
            with pytest.raises(ConfigurationError) as exc:
                await AzureFoundryLoader().load(
                    _config(source_uri=None),
                    provider_overrides={"azure-speech": {"api_key": "byok-foundry-key"}},
                )

        assert "mai-transcribe-1.5" not in str(exc.value)

    @pytest.mark.asyncio
    async def test_settings_expose_no_foundry_model_default(self):
        from stt.core.config.settings import Settings

        assert "azure_foundry_model" not in Settings.model_fields


class TestAzureFoundryEngineGate:
    @pytest.mark.asyncio
    async def test_disabled_engine_refuses_before_any_credential_work(self):
        settings = _settings(azure_foundry_enabled=False)
        with patch("stt.models.azure_foundry_loader.get_settings", return_value=settings):
            with pytest.raises(CloudASRAuthError) as exc:
                await AzureFoundryLoader().load(
                    _config(),
                    provider_overrides={"azure-speech": {"api_key": "byok-foundry-key"}},
                )

        assert "disabled" in str(exc.value)
