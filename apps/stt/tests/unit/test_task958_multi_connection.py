"""TASK-958 (tests 30 + 31) — two connections of one vendor on the ASR plane.

A tenant may now hold more than one ``AiProviderConnection`` for a given
``(service, provider)``. ``provider_overrides`` is a FLAT map, so the key it is
keyed by has to be able to tell two accounts of one vendor apart; the provider id
(``openai``, ``azure-speech``, …) cannot. ``connection_key`` — the tenant
connection's ``slug``, or the provider id for a platform row — is that key, and it
rides on the spec beside the runtime the candidate names.

Three properties, each of which is money if it is wrong:

* a loader reads its credential under ``connection_key`` FIRST and the provider id
  second, so account #2's call is served on account #2's key;
* a payload with no ``connection_key`` anywhere (a gateway that predates the field,
  and every platform-tier candidate) resolves exactly as it does today;
* usage attribution names the CONNECTION, not just the provider — otherwise a tenant
  that brought two keys cannot see which one a transcription spent (D-7).

Test 31 is the contract half: the committed fixture — which Lane B2 owns and which
this lane does NOT touch — must still validate and round-trip byte-for-byte, and a
spec that DOES carry the new fields must validate too.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from stt.core.exceptions import CloudASRAuthError
from stt.models.azure_speech_loader import AzureSpeechLoader
from stt.models.cloud_asr import resolve_override_key
from stt.models.openai_loader import OpenAILoader
from stt.pipeline.dto import (
    AiModelConfig,
    AiModelDownloadStatus,
    AiModelFormat,
    AiModelSource,
    ModelTaskType,
)
from stt.pipeline.spec import ResolvedAsrSpec, bundle_from_resolved
from stt.transcription.batch_service import resolve_usage_attribution


def _load_fixture() -> dict[str, Any]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "contracts" / "resolved-asr-spec.fixture.json"
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    raise AssertionError("shared ResolvedAsrSpec contract fixture not found")


FIXTURE = _load_fixture()
CASES = {name: case for name, case in FIXTURE.items() if isinstance(case, dict)}


def _config(
    *,
    fmt: AiModelFormat = AiModelFormat.OPENAI,
    connection_key: str | None = None,
    connection_id: str | None = None,
) -> AiModelConfig:
    return AiModelConfig(
        id="m-1",
        tenant_id="t-1",
        slug="cloud-asr",
        name="Cloud ASR",
        description=None,
        task_type=ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        source=AiModelSource.LOCAL,
        source_uri="gpt-4o-transcribe",
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
        connection_id=connection_id,
    )


class TestTheOverrideLookupIsConnectionKeyedFirst:
    def test_the_connection_key_entry_wins_over_the_provider_id_entry(self) -> None:
        overrides = {
            "openai": {"api_key": "default-key"},
            "openai-research": {"api_key": "research-key"},
        }
        entry = resolve_override_key(overrides, "openai", connection_key="openai-research")
        assert entry is not None and entry["api_key"] == "research-key"

    def test_no_connection_key_falls_back_to_the_provider_id(self) -> None:
        overrides = {"openai": {"api_key": "default-key"}}
        assert resolve_override_key(overrides, "openai")["api_key"] == "default-key"
        assert (
            resolve_override_key(overrides, "openai", connection_key=None)["api_key"]
            == "default-key"
        )

    def test_a_connection_key_with_no_entry_falls_back_rather_than_failing(self) -> None:
        """The DEFAULT connection's slug IS the provider id, so the two reads coincide."""
        overrides = {"openai": {"api_key": "default-key"}}
        entry = resolve_override_key(overrides, "openai", connection_key="openai")
        assert entry is not None and entry["api_key"] == "default-key"


class TestLoadersReadTheirOwnConnection:
    @pytest.mark.asyncio
    async def test_openai_loads_the_key_of_the_connection_the_model_names(self) -> None:
        loaded = await OpenAILoader().load(
            _config(connection_key="openai-research"),
            {
                "openai": {"api_key": "default-key", "base_url": "https://default.invalid/v1"},
                "openai-research": {
                    "api_key": "research-key",
                    "base_url": "https://research.invalid/v1",
                },
            },
        )
        config = loaded.model
        assert config.api_key.get_secret_value() == "research-key"
        assert config.base_url == "https://research.invalid/v1"

    @pytest.mark.asyncio
    async def test_openai_legacy_payload_still_resolves_under_the_provider_id(self) -> None:
        loaded = await OpenAILoader().load(
            _config(),
            {"openai": {"api_key": "default-key", "base_url": "https://default.invalid/v1"}},
        )
        assert loaded.model.api_key.get_secret_value() == "default-key"

    @pytest.mark.asyncio
    async def test_azure_speech_loads_the_key_of_the_connection_the_model_names(self) -> None:
        loaded = await AzureSpeechLoader().load(
            _config(fmt=AiModelFormat.AZURE_SPEECH, connection_key="azure-speech-eu"),
            {
                "azure-speech": {"api_key": "default-key", "region": "eastus"},
                "azure-speech-eu": {"api_key": "eu-key", "region": "westeurope"},
            },
        )
        speech_config = loaded.model
        assert loaded.extra["region"] == "westeurope"
        assert speech_config is not None

    @pytest.mark.asyncio
    async def test_a_sibling_connection_never_borrows_the_default_s_absence(self) -> None:
        """No entry under either key ⇒ fail closed, never a silent platform credential."""
        with pytest.raises(CloudASRAuthError):
            await OpenAILoader().load(
                _config(connection_key="openai-research"),
                {"sarvam": {"api_key": "unrelated"}},
            )


class TestUsageAttributionNamesTheConnection:
    def test_a_tenant_entry_yields_its_connection_id(self) -> None:
        engine, deployment, connection_id = resolve_usage_attribution(
            AiModelFormat.OPENAI,
            {"openai-research": {"api_key": "k", "funding": "tenant", "connection_id": "conn-2"}},
            connection_key="openai-research",
        )
        assert (engine, deployment, connection_id) == ("openai", "BYOK", "conn-2")

    def test_a_platform_entry_still_meters_CLOUD_and_carries_its_connection(self) -> None:
        _, deployment, connection_id = resolve_usage_attribution(
            AiModelFormat.OPENAI,
            {"openai": {"api_key": "k", "funding": "platform", "connection_id": "conn-sys"}},
        )
        assert (deployment, connection_id) == ("CLOUD", "conn-sys")

    def test_no_override_at_all_yields_no_connection(self) -> None:
        engine, deployment, connection_id = resolve_usage_attribution(AiModelFormat.OPENAI, None)
        assert (engine, deployment, connection_id) == ("openai", "CLOUD", None)

    def test_a_self_hosted_engine_reports_the_spec_s_connection(self) -> None:
        """A local engine has no credential entry, but it still has a connection row."""
        engine, deployment, connection_id = resolve_usage_attribution(
            AiModelFormat.WHISPER_CPP, None, connection_id="conn-local"
        )
        assert (engine, deployment, connection_id) == ("whisper_cpp", "SELF_HOSTED", "conn-local")

    def test_the_entry_is_the_authority_when_both_are_stamped(self) -> None:
        _, _, connection_id = resolve_usage_attribution(
            AiModelFormat.OPENAI,
            {"openai-research": {"api_key": "k", "connection_id": "conn-entry"}},
            connection_key="openai-research",
            connection_id="conn-spec",
        )
        assert connection_id == "conn-entry"


class TestTheSpecMirrorAcceptsTheNewFields:
    """Test 31 — the committed fixture is Lane B2's; this half must accept both shapes."""

    @pytest.mark.parametrize("name", sorted(CASES))
    def test_the_unchanged_fixture_still_round_trips(self, name: str) -> None:
        expected = CASES[name]["expected"]
        spec = ResolvedAsrSpec.model_validate(expected)
        assert spec.model_dump(by_alias=True, mode="json") == expected

    def test_a_spec_carrying_the_new_fields_validates_and_round_trips(self) -> None:
        expected = json.loads(json.dumps(CASES["cloudWithAgentFallback"]["expected"]))
        expected["connectionId"] = "conn-1"
        expected["connectionSlug"] = "openai-clinic"
        expected["connectionKey"] = "openai-clinic"
        expected["fallback"]["spec"]["connectionId"] = "conn-2"
        expected["fallback"]["spec"]["connectionSlug"] = "openai-research"
        expected["fallback"]["spec"]["connectionKey"] = "openai-research"

        spec = ResolvedAsrSpec.model_validate(expected)
        assert spec.connection_key == "openai-clinic"
        assert spec.connection_id == "conn-1"
        assert spec.fallback.spec is not None
        assert spec.fallback.spec.connection_key == "openai-research"
        assert spec.model_dump(by_alias=True, mode="json") == expected

    def test_an_absent_field_is_OMITTED_from_the_dump_not_serialised_as_null(self) -> None:
        expected = CASES["platformDefault"]["expected"]
        dumped = ResolvedAsrSpec.model_validate(expected).model_dump(by_alias=True)
        assert "connectionKey" not in dumped
        assert "connectionId" not in dumped
        assert "connectionSlug" not in dumped

    def test_the_bundle_stamps_the_connection_onto_every_model_of_its_chain(self) -> None:
        expected = json.loads(json.dumps(CASES["cloudWithAgentFallback"]["expected"]))
        expected["connectionKey"] = "openai-clinic"
        expected["connectionId"] = "conn-1"
        bundle = bundle_from_resolved(expected)
        asr_slug = bundle.spec.models.asr.slug
        assert bundle.model_configs[asr_slug].connection_key == "openai-clinic"
        assert bundle.model_configs[asr_slug].connection_id == "conn-1"

    def test_a_chain_without_the_fields_leaves_the_model_configs_unstamped(self) -> None:
        bundle = bundle_from_resolved(json.loads(json.dumps(CASES["platformDefault"]["expected"])))
        asr_slug = bundle.spec.models.asr.slug
        assert bundle.model_configs[asr_slug].connection_key is None
        assert bundle.model_configs[asr_slug].connection_id is None
