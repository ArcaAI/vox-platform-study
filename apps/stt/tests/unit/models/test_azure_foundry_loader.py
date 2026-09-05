"""Unit tests for the Azure AI Foundry (MAI-Transcribe) loader.

Covers the BYOK-only credential contract, the fail-closed model SELECTION (the
pipeline's resolved model wins; an unresolved selection raises rather than
substituting a literal), and — since TASK-880 — the fact that the engine's GATE is its
own connection row.

TASK-880 replaced ``stt.azureFoundry.enabled`` and ``stt.azureFoundry.endpoint`` with
``AiProviderConnection(stt, azure-foundry)``, and gave Foundry its OWN row instead of
aliasing ``azure-speech``. The three-state row semantics ARE the gate the flag was
imitating, and better: a tenant can now enable Speech without also enabling a PREVIEW
service for its PHI, and can point Foundry at a different resource. The loader reads no
``Settings`` at all.
"""

from datetime import datetime

import pytest

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


_ENDPOINT = "https://res.cognitiveservices.azure.com"


def _entry(**extra: object) -> dict[str, dict[str, object]]:
    """A complete `azure-foundry` connection row on the wire — an entry exists only
    when an ENABLED, KEYED row resolved for the tenant (tenant row, else SYSTEM)."""
    return {"azure-foundry": {"api_key": "byok-foundry-key", "base_url": _ENDPOINT, **extra}}


class TestAzureFoundryCredentialsAreByokOnly:
    """`azure.foundryApiKey` is a registered vault-kv platform-secret descriptor —
    the governance already existed and the reader simply never asked for it. There is
    no env path to the key, and since TASK-880 no env path to the endpoint either."""

    @pytest.mark.asyncio
    async def test_no_connection_row_fails_closed(self):
        """No `azure-foundry` entry = no enabled, keyed row on either tier = the
        engine is not available to this tenant. This one check replaces BOTH the
        deleted `stt.azureFoundry.enabled` flag and the old credential check."""
        with pytest.raises(CloudASRAuthError) as exc:
            await AzureFoundryLoader().load(_config())

        assert exc.value.details["has_key"] is False
        assert exc.value.details["provider"] == "azure-foundry"

    @pytest.mark.asyncio
    async def test_the_azure_speech_row_no_longer_serves_foundry(self):
        """TASK-880 — the alias is gone. A tenant that enabled Azure SPEECH has not
        thereby enabled a PREVIEW service for its PHI."""
        with pytest.raises(CloudASRAuthError) as exc:
            await AzureFoundryLoader().load(
                _config(),
                provider_overrides={
                    "azure-speech": {"api_key": "byok-speech-key", "base_url": _ENDPOINT}
                },
            )

        assert exc.value.details["has_key"] is False

    @pytest.mark.asyncio
    async def test_settings_expose_no_foundry_fields_at_all(self):
        """Structural half of the guarantee: neither the key, nor the enable flag,
        nor the endpoint can be reached from env, because none is a field."""
        from stt.core.config.settings import Settings

        for field in ("azure_foundry_api_key", "azure_foundry_enabled", "azure_foundry_endpoint"):
            assert field not in Settings.model_fields

    @pytest.mark.asyncio
    async def test_the_rows_key_and_endpoint_are_used(self):
        result = await AzureFoundryLoader().load(_config(), provider_overrides=_entry())

        assert isinstance(result, LoadedModel)
        assert result.model["api_key"] == "byok-foundry-key"
        assert result.model["endpoint"] == _ENDPOINT
        assert result.format == AiModelFormat.AZURE_FOUNDRY

    @pytest.mark.asyncio
    async def test_the_pre_unification_endpoint_spelling_still_loads(self):
        """A row written before `baseUrl` existed carries the endpoint in `extraJson`
        as `endpoint`; it must not become unloadable."""
        result = await AzureFoundryLoader().load(
            _config(),
            provider_overrides={
                "azure-foundry": {
                    "api_key": "byok-foundry-key",
                    "endpoint": "https://tenant-res.cognitiveservices.azure.com/",
                }
            },
        )

        assert result.model["endpoint"] == "https://tenant-res.cognitiveservices.azure.com"

    @pytest.mark.asyncio
    async def test_missing_endpoint_still_fails_closed(self):
        with pytest.raises(CloudASRAuthError) as exc:
            await AzureFoundryLoader().load(
                _config(), provider_overrides={"azure-foundry": {"api_key": "byok-foundry-key"}}
            )

        assert exc.value.details["has_endpoint"] is False


class TestAzureFoundryModelSelectionFailsClosed:
    """Model SELECTION is `failMode: closed` — the pipeline's resolved model wins
    and an unresolved one raises instead of falling back to a code literal."""

    @pytest.mark.asyncio
    async def test_pipeline_model_wins(self):
        result = await AzureFoundryLoader().load(
            _config(source_uri="mai-transcribe-2.0"), provider_overrides=_entry()
        )

        assert result.model["model"] == "mai-transcribe-2.0"

    @pytest.mark.asyncio
    async def test_unresolved_model_raises_instead_of_a_literal_default(self):
        with pytest.raises(ConfigurationError) as exc:
            await AzureFoundryLoader().load(_config(source_uri=None), provider_overrides=_entry())

        assert "mai-transcribe-1.5" not in str(exc.value)

    @pytest.mark.asyncio
    async def test_settings_expose_no_foundry_model_default(self):
        from stt.core.config.settings import Settings

        assert "azure_foundry_model" not in Settings.model_fields


class TestAzureFoundryEngineGate:
    @pytest.mark.asyncio
    async def test_the_row_is_the_gate_and_it_names_the_preview_posture(self):
        """The deleted kill-switch's job — "PREVIEW, off until sign-off" — is now the
        SYSTEM row seeding `enabled: false`, which yields no override entry. The
        refusal must still say so, per tenant rather than per platform."""
        with pytest.raises(CloudASRAuthError) as exc:
            await AzureFoundryLoader().load(_config())

        message = str(exc.value)
        assert "azure-foundry" in message
        assert "PREVIEW" in message
        assert "data-residency" in message

    @pytest.mark.asyncio
    async def test_the_loader_reads_no_settings(self):
        """The structural closure: `get_settings` is not even imported, so no future
        edit can re-open an env path to the gate."""
        import stt.models.azure_foundry_loader as module

        assert not hasattr(module, "get_settings")
