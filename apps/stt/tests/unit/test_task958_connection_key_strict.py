"""TASK-958 (wire review #4) — a DECLARED connection key fails CLOSED.

``resolve_override_key`` reads the credential map under the candidate's
``connection_key`` first and the provider id second. The second read exists for
COMPATIBILITY — a tenant's DEFAULT connection has ``slug == provider``, and a
gateway that stamps no key at all must keep resolving exactly as before.

But it was a fallback for BOTH misses, and that is the money bug: when the
gateway DID stamp a key and the map has no entry under it, falling back to the
provider id hands the call the tenant's DEFAULT account. That is precisely the
case the gateway creates deliberately — a sibling connection that is disabled,
keyless, or vetoed is folded out of ``provider_overrides``, so its absence IS
the decision. Reading the provider entry instead spends the wrong vendor
account, on the wrong invoice, under a key the tenant deliberately took out of
play.

The rule, therefore:

* ``connection_key`` DECLARED (non-empty) → the entry under it, or ``None``.
  Nothing else is consulted. The caller fails closed on its own terms — for
  these loaders, the named ``CloudASRAuthError`` each already raises.
* ``connection_key`` ABSENT → today's provider-keyed read, unchanged.

The two reads still coincide for every default connection (``slug == provider``),
which is why this is a tightening and not a behaviour change for anything that
works today.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from stt.core.exceptions import CloudASRAuthError
from stt.models.azure_foundry_loader import AzureFoundryLoader
from stt.models.azure_speech_loader import AzureSpeechLoader
from stt.models.cloud_asr import resolve_override_key
from stt.models.openai_loader import OpenAILoader
from stt.models.sarvam_loader import SarvamLoader
from stt.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
)


def _config(
    *,
    fmt: AiModelFormat = AiModelFormat.OPENAI,
    source_uri: str = "gpt-4o-transcribe",
    connection_key: str | None = None,
) -> AiModelConfig:
    return AiModelConfig(
        id="m-1",
        tenant_id="t-1",
        slug="cloud-asr",
        name="Cloud ASR",
        description=None,
        task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        source=AiModelSource.LOCAL,
        source_uri=source_uri,
        source_revision=None,
        format=fmt,
        memory_size_mb=0,
        compute_type=None,
        download_status=AiModelDownloadStatus.DOWNLOADED,
        local_path=None,
        downloaded_at=datetime.utcnow(),
        file_size_mb=0,
        checksum=None,
        tags=[],
        connection_key=connection_key,
    )


class TestADeclaredKeyIsTheOnlyKeyRead:
    def test_a_declared_key_that_missed_does_NOT_fall_back_to_the_provider_entry(self) -> None:
        """The sibling the gateway left credential-less must not spend the default's key."""
        overrides = {"openai": {"api_key": "default-key", "base_url": "https://default.invalid/v1"}}

        assert resolve_override_key(overrides, "openai", connection_key="openai-research") is None

    def test_a_declared_key_that_hit_still_returns_its_own_entry(self) -> None:
        overrides = {
            "openai": {"api_key": "default-key"},
            "openai-research": {"api_key": "research-key"},
        }
        entry = resolve_override_key(overrides, "openai", connection_key="openai-research")

        assert entry is not None and entry["api_key"] == "research-key"

    def test_the_default_connection_still_resolves_because_its_slug_IS_the_provider(self) -> None:
        """`slug == provider` on every default row, so the strict read is the same read."""
        overrides = {"openai": {"api_key": "default-key"}}
        entry = resolve_override_key(overrides, "openai", connection_key="openai")

        assert entry is not None and entry["api_key"] == "default-key"

    def test_no_declared_key_reads_the_provider_entry_exactly_as_before(self) -> None:
        overrides = {"openai": {"api_key": "default-key"}}

        assert resolve_override_key(overrides, "openai")["api_key"] == "default-key"
        assert (
            resolve_override_key(overrides, "openai", connection_key=None)["api_key"]
            == "default-key"
        )

    def test_an_empty_declared_key_is_not_a_declaration(self) -> None:
        """`""` is what a mis-serialised field looks like; it must not fail a legacy payload closed."""
        overrides = {"openai": {"api_key": "default-key"}}
        entry = resolve_override_key(overrides, "openai", connection_key="")

        assert entry is not None and entry["api_key"] == "default-key"

    def test_an_empty_map_is_None_under_either_rule(self) -> None:
        assert resolve_override_key(None, "openai", connection_key="openai-research") is None
        assert resolve_override_key({}, "openai") is None

    def test_an_empty_entry_under_the_declared_key_is_a_miss_not_a_credential(self) -> None:
        overrides = {"openai": {"api_key": "default-key"}, "openai-research": {}}

        assert resolve_override_key(overrides, "openai", connection_key="openai-research") is None


class TestEveryCloudLoaderFailsClosedOnADeclaredMiss:
    """The miss surfaces as the loader's OWN named refusal — never a silent success."""

    @pytest.mark.asyncio
    async def test_openai_refuses_rather_than_loading_the_default_account(self) -> None:
        with pytest.raises(CloudASRAuthError):
            await OpenAILoader().load(
                _config(connection_key="openai-research"),
                {"openai": {"api_key": "default-key", "base_url": "https://default.invalid/v1"}},
            )

    @pytest.mark.asyncio
    async def test_sarvam_refuses_rather_than_loading_the_default_account(self) -> None:
        with pytest.raises(CloudASRAuthError):
            await SarvamLoader().load(
                _config(
                    fmt=AiModelFormat.SARVAM,
                    source_uri="saarika:v2",
                    connection_key="sarvam-clinic",
                ),
                {"sarvam": {"api_key": "default-key", "base_url": "https://default.invalid"}},
            )

    @pytest.mark.asyncio
    async def test_azure_speech_refuses_rather_than_loading_the_default_resource(self) -> None:
        with pytest.raises(CloudASRAuthError):
            await AzureSpeechLoader().load(
                _config(fmt=AiModelFormat.AZURE_SPEECH, connection_key="azure-speech-eu"),
                {"azure-speech": {"api_key": "default-key", "region": "eastus"}},
            )

    @pytest.mark.asyncio
    async def test_azure_foundry_refuses_rather_than_loading_the_default_resource(self) -> None:
        with pytest.raises(CloudASRAuthError):
            await AzureFoundryLoader().load(
                _config(fmt=AiModelFormat.AZURE_FOUNDRY, connection_key="azure-foundry-eu"),
                {
                    "azure-foundry": {
                        "api_key": "default-key",
                        "base_url": "https://default.invalid",
                    }
                },
            )
