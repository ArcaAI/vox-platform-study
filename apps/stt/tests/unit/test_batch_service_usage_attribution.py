"""Unit tests for `stt.transcription.batch_service.resolve_usage_attribution`.

Maps the loaded ASR model's `AiModelFormat` (+ whether a
tenant BYOK provider override was actually resolved) to the
usage-ledger `(engine, deployment)` pair `transcribe_file.py` forwards to
`APIGatewayClient.complete_job`.

Pure function, no I/O — exercises the exact spelling traps called out in
(provider vocabulary): self-hosted engine ids are snake_case
(`whisper_cpp`, `faster_whisper` — already the lowercased `AiModelFormat`
value, no remapping needed) and `AZURE_SPEECH` is the one format whose
lowercased value (`azure_speech`) does NOT match its seeded connection id
(`azure-speech`, hyphenated) — silently forking a rollup dimension is
exactly the failure mode the contract warns against.
"""

from stt.models.openai_loader import OPENAI_OVERRIDE_KEY
from stt.models.sarvam_loader import SARVAM_OVERRIDE_KEY
from stt.pipeline.dto import AiModelFormat
from stt.transcription.batch_service import (
    _CLOUD_ASR_OVERRIDE_FORMATS,
    _OVERRIDE_KEY_BY_FORMAT,
    resolve_usage_attribution,
)


class TestOverrideKeyMapAgreesWithTheLoaders:
    """`_OVERRIDE_KEY_BY_FORMAT` must name the key each LOADER actually reads.

    Attribution now looks up the entry under that key, so a drift here would
    silently re-open the misattribution this ticket closes — the call would
    resolve a credential the ledger cannot see.
    """

    def test_every_cloud_format_has_an_override_key(self):
        assert set(_OVERRIDE_KEY_BY_FORMAT) == set(_CLOUD_ASR_OVERRIDE_FORMATS)

    def test_sarvam_key_matches_the_loader_constant(self):
        assert _OVERRIDE_KEY_BY_FORMAT[AiModelFormat.SARVAM] == SARVAM_OVERRIDE_KEY

    def test_openai_key_matches_the_loader_constant(self):
        assert _OVERRIDE_KEY_BY_FORMAT[AiModelFormat.OPENAI] == OPENAI_OVERRIDE_KEY

    def test_each_azure_format_reads_its_own_connection_row(self):
        """TASK-880 — the two Azure formats no longer share a credential.

        The alias made one row the gate for two engines with different
        data-residency postures. Both keys are asserted against the LOADERS' own
        `override_key` so this map cannot drift from what the code reads.
        """
        from stt.models.azure_foundry_loader import AzureFoundryLoader
        from stt.models.azure_speech_loader import AzureSpeechLoader

        assert _OVERRIDE_KEY_BY_FORMAT[AiModelFormat.AZURE_SPEECH] == AzureSpeechLoader.override_key
        assert (
            _OVERRIDE_KEY_BY_FORMAT[AiModelFormat.AZURE_FOUNDRY] == AzureFoundryLoader.override_key
        )
        assert AzureFoundryLoader.override_key == "azure-foundry"


class TestResolveUsageAttributionSelfHosted:
    def test_whisper_cpp_is_self_hosted(self):
        engine, deployment, _connection = resolve_usage_attribution(AiModelFormat.WHISPER_CPP, None)
        assert engine == "whisper_cpp"
        assert deployment == "SELF_HOSTED"

    def test_faster_whisper_is_self_hosted(self):
        engine, deployment, _connection = resolve_usage_attribution(
            AiModelFormat.FASTER_WHISPER, None
        )
        assert engine == "faster_whisper"
        assert deployment == "SELF_HOSTED"

    def test_self_hosted_ignores_provider_overrides(self):
        """A tenant BYOK override for an unrelated cloud provider must never
        flip a self-hosted engine's deployment — only formats in
        `_CLOUD_ASR_OVERRIDE_FORMATS` are BYOK-eligible."""
        engine, deployment, _connection = resolve_usage_attribution(
            AiModelFormat.WHISPER_CPP, {"sarvam": {"apiKey": "x"}}
        )
        assert engine == "whisper_cpp"
        assert deployment == "SELF_HOSTED"


class TestResolveUsageAttributionCloud:
    def test_azure_speech_uses_the_hyphenated_connection_id(self):
        """The one documented spelling trap: AiModelFormat.AZURE_SPEECH.value
        lowercases to `azure_speech` (underscore), but the seeded
        AiProviderConnection id — and KNOWN_PROVIDERS — spell it
        `azure-speech` (hyphen)."""
        engine, deployment, _connection = resolve_usage_attribution(
            AiModelFormat.AZURE_SPEECH, None
        )
        assert engine == "azure-speech"
        assert deployment == "CLOUD"

    def test_sarvam_cloud_without_override_is_platform_funded(self):
        engine, deployment, _connection = resolve_usage_attribution(AiModelFormat.SARVAM, None)
        assert engine == "sarvam"
        assert deployment == "CLOUD"

    def test_openai_cloud_without_override_is_platform_funded(self):
        engine, deployment, _connection = resolve_usage_attribution(AiModelFormat.OPENAI, None)
        assert engine == "openai"
        assert deployment == "CLOUD"

    def test_empty_provider_overrides_dict_is_still_platform_funded(self):
        """`bool({})` is False — an empty overrides dict must behave
        identically to None, not accidentally flip to BYOK."""
        engine, deployment, _connection = resolve_usage_attribution(AiModelFormat.SARVAM, {})
        assert deployment == "CLOUD"


class TestResolveUsageAttributionByok:
    def test_cloud_format_with_provider_overrides_is_byok(self):
        engine, deployment, _connection = resolve_usage_attribution(
            AiModelFormat.SARVAM, {"sarvam": {"apiKey": "tenant-key"}}
        )
        assert engine == "sarvam"
        assert deployment == "BYOK"

    def test_azure_speech_with_overrides_is_byok_and_keeps_hyphenated_id(self):
        engine, deployment, _connection = resolve_usage_attribution(
            AiModelFormat.AZURE_SPEECH, {"azure-speech": {"apiKey": "k"}}
        )
        assert engine == "azure-speech"
        assert deployment == "BYOK"


class TestResolveUsageAttributionIsKeySpecific:
    """The override map must be inspected BY KEY.

    The older rule was ``bool(provider_overrides)`` on the whole dict, so an
    override for one provider marked a call served by a *different* provider
    as BYOK. That already misattributes today (a tenant holding a Sarvam key
    while the pipeline runs Azure Speech), and the platform-default cascade
    makes mixed maps the normal case rather than the exception.
    """

    def test_override_for_a_different_provider_is_not_byok(self):
        engine, deployment, _connection = resolve_usage_attribution(
            AiModelFormat.SARVAM, {"azure-speech": {"api_key": "k"}}
        )
        assert engine == "sarvam"
        assert deployment == "CLOUD"

    def test_azure_foundry_reads_its_own_override_key(self):
        """TASK-880 — Foundry has its OWN `azure-foundry` connection row; it used to
        alias `azure-speech`. Attribution must look under the key the loader reads, or
        a call served on the tenant's own Foundry key meters as platform CLOUD."""
        engine, deployment, _connection = resolve_usage_attribution(
            AiModelFormat.AZURE_FOUNDRY, {"azure-foundry": {"api_key": "k"}}
        )
        assert engine == "azure-foundry"
        assert deployment == "BYOK"

    def test_azure_foundry_no_longer_reads_the_azure_speech_key(self):
        """The alias is gone in both directions: an Azure SPEECH credential does not
        make a Foundry call BYOK, because it is not the credential that served it."""
        _, deployment, _connection = resolve_usage_attribution(
            AiModelFormat.AZURE_FOUNDRY, {"azure-speech": {"api_key": "k"}}
        )
        assert deployment == "CLOUD"

    def test_azure_foundry_with_only_an_unrelated_override_is_cloud(self):
        _, deployment, _connection = resolve_usage_attribution(
            AiModelFormat.AZURE_FOUNDRY, {"sarvam": {"api_key": "k"}}
        )
        assert deployment == "CLOUD"

    def test_empty_entry_for_the_serving_provider_is_not_byok(self):
        _, deployment, _connection = resolve_usage_attribution(AiModelFormat.SARVAM, {"sarvam": {}})
        assert deployment == "CLOUD"


class TestResolveUsageAttributionFunding:
    """Explicit funding origin beats inference.

    A platform-funded (SYSTEM-tenant) credential is economically a
    platform-funded vendor call, so it meters as ``CLOUD`` (OD-2) even though
    an override entry IS present on the request.
    """

    def test_platform_funded_entry_meters_as_cloud(self):
        engine, deployment, _connection = resolve_usage_attribution(
            AiModelFormat.SARVAM, {"sarvam": {"api_key": "k", "funding": "platform"}}
        )
        assert engine == "sarvam"
        assert deployment == "CLOUD"

    def test_tenant_funded_entry_meters_as_byok(self):
        _, deployment, _connection = resolve_usage_attribution(
            AiModelFormat.SARVAM, {"sarvam": {"api_key": "k", "funding": "tenant"}}
        )
        assert deployment == "BYOK"

    def test_absent_funding_preserves_todays_rule(self):
        """An older gateway sends no ``funding``. Every sender that predates R3
        can only ever inject the caller tenant's OWN credential, so ``tenant``
        is exactly correct for them — not merely a conservative guess."""
        _, deployment, _connection = resolve_usage_attribution(
            AiModelFormat.SARVAM, {"sarvam": {"api_key": "k"}}
        )
        assert deployment == "BYOK"

    def test_unrecognized_funding_value_falls_back_to_tenant(self):
        _, deployment, _connection = resolve_usage_attribution(
            AiModelFormat.SARVAM, {"sarvam": {"api_key": "k", "funding": "wat"}}
        )
        assert deployment == "BYOK"

    def test_mixed_map_is_attributed_per_provider(self):
        """The cascade merges tenant-over-platform PER PROVIDER, so one request
        can legitimately carry one tenant-funded and one platform-funded entry."""
        overrides = {
            "sarvam": {"api_key": "platform", "funding": "platform"},
            "azure-speech": {"api_key": "tenant", "funding": "tenant"},
        }
        assert resolve_usage_attribution(AiModelFormat.SARVAM, overrides)[1] == "CLOUD"
        assert resolve_usage_attribution(AiModelFormat.AZURE_SPEECH, overrides)[1] == "BYOK"

    def test_funding_never_promotes_a_self_hosted_engine(self):
        _, deployment, _connection = resolve_usage_attribution(
            AiModelFormat.WHISPER_CPP, {"whisper_cpp": {"funding": "tenant"}}
        )
        assert deployment == "SELF_HOSTED"


class TestResolveUsageAttributionUnmappedFormat:
    def test_unmapped_self_hosted_format_degrades_to_lowercased_value(self):
        """Formats with no dedicated self-hosted engine mapping (e.g. a bare
        ONNX/SAFETENSOR/PYTORCH/NEMO load) degrade to the lowercased
        `AiModelFormat` value rather than raising — shape-valid per the
        ledger's OPEN provider vocabulary, just not yet a KNOWN_PROVIDERS
        member. Never guessed as a name that collides with a real provider."""
        engine, deployment, _connection = resolve_usage_attribution(AiModelFormat.ONNX, None)
        assert engine == "onnx"
        assert deployment == "SELF_HOSTED"
