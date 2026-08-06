"""Unit tests for `stt.transcription.batch_service.resolve_usage_attribution`.

TASK-615 WS-C — maps the loaded ASR model's `AiModelFormat` (+ whether a
tenant BYOK provider override was actually resolved, TASK-567) to the
usage-ledger `(engine, deployment)` pair `transcribe_file.py` forwards to
`APIGatewayClient.complete_job()`.

Pure function, no I/O — exercises the exact spelling traps called out in
`docs/implementation/TASK-615-Usage-Metering-And-Billing/ws-b-contract.md`
§3 (provider vocabulary): self-hosted engine ids are snake_case
(`whisper_cpp`, `faster_whisper` — already the lowercased `AiModelFormat`
value, no remapping needed) and `AZURE_SPEECH` is the one format whose
lowercased value (`azure_speech`) does NOT match its seeded connection id
(`azure-speech`, hyphenated) — silently forking a rollup dimension is
exactly the failure mode the contract warns against.
"""

from stt.pipeline.dto import AiModelFormat
from stt.transcription.batch_service import resolve_usage_attribution


class TestResolveUsageAttributionSelfHosted:
    def test_whisper_cpp_is_self_hosted(self):
        engine, deployment = resolve_usage_attribution(AiModelFormat.WHISPER_CPP, None)
        assert engine == "whisper_cpp"
        assert deployment == "SELF_HOSTED"

    def test_faster_whisper_is_self_hosted(self):
        engine, deployment = resolve_usage_attribution(AiModelFormat.FASTER_WHISPER, None)
        assert engine == "faster_whisper"
        assert deployment == "SELF_HOSTED"

    def test_self_hosted_ignores_provider_overrides(self):
        """A tenant BYOK override for an unrelated cloud provider must never
        flip a self-hosted engine's deployment — only formats in
        `_CLOUD_ASR_OVERRIDE_FORMATS` are BYOK-eligible."""
        engine, deployment = resolve_usage_attribution(
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
        engine, deployment = resolve_usage_attribution(AiModelFormat.AZURE_SPEECH, None)
        assert engine == "azure-speech"
        assert deployment == "CLOUD"

    def test_sarvam_cloud_without_override_is_platform_funded(self):
        engine, deployment = resolve_usage_attribution(AiModelFormat.SARVAM, None)
        assert engine == "sarvam"
        assert deployment == "CLOUD"

    def test_openai_cloud_without_override_is_platform_funded(self):
        engine, deployment = resolve_usage_attribution(AiModelFormat.OPENAI, None)
        assert engine == "openai"
        assert deployment == "CLOUD"

    def test_empty_provider_overrides_dict_is_still_platform_funded(self):
        """`bool({})` is False — an empty overrides dict must behave
        identically to None, not accidentally flip to BYOK."""
        engine, deployment = resolve_usage_attribution(AiModelFormat.SARVAM, {})
        assert deployment == "CLOUD"


class TestResolveUsageAttributionByok:
    def test_cloud_format_with_provider_overrides_is_byok(self):
        engine, deployment = resolve_usage_attribution(
            AiModelFormat.SARVAM, {"sarvam": {"apiKey": "tenant-key"}}
        )
        assert engine == "sarvam"
        assert deployment == "BYOK"

    def test_azure_speech_with_overrides_is_byok_and_keeps_hyphenated_id(self):
        engine, deployment = resolve_usage_attribution(
            AiModelFormat.AZURE_SPEECH, {"azure-speech": {"apiKey": "k"}}
        )
        assert engine == "azure-speech"
        assert deployment == "BYOK"


class TestResolveUsageAttributionUnmappedFormat:
    def test_unmapped_self_hosted_format_degrades_to_lowercased_value(self):
        """Formats with no dedicated self-hosted engine mapping (e.g. a bare
        ONNX/SAFETENSOR/PYTORCH/NEMO load) degrade to the lowercased
        `AiModelFormat` value rather than raising — shape-valid per the
        ledger's OPEN provider vocabulary, just not yet a KNOWN_PROVIDERS
        member. Never guessed as a name that collides with a real provider."""
        engine, deployment = resolve_usage_attribution(AiModelFormat.ONNX, None)
        assert engine == "onnx"
        assert deployment == "SELF_HOSTED"
