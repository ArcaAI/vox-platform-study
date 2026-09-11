"""lane B — the harness judge + retrieval credentials on the BYO plane.

Three credentials moved off env and onto `AiProviderConnection`:

| was | is now |
|---|---|
| `HARNESS_JUDGE_OPENAI_COMPAT_API_KEY` | `AiProviderConnection(service='llm', provider='openai-compat')` |
| `HARNESS_JUDGE_AZURE_API_KEY`         | `AiProviderConnection(service='llm', provider='azure')` |
| `HARNESS_RETRIEVAL_QDRANT_API_KEY`    | `AiProviderConnection(service='vector', provider='qdrant')` |

**Why the delivery is a per-activity gateway pull.** The judge and the retriever
run inside a Temporal ACTIVITY. There is no inbound gateway request to fold a
`provider_overrides` envelope into (the `apps/text` channel), the worker holds no
DB handle (so `resolveConnection` is unreachable), and the effective-config pull
is platform-scope with ONE cached snapshot per process — putting a per-tenant
credential on it is the exact cardinality failure D-1 exists to prevent. What is
left is the path this repo already uses for a credential consumed inside an
activity: `GET /internal/harness/mcp-token`. This is that precedent generalised.

The properties under test are the ones that make it safe:

* the env paths are STRUCTURALLY closed (a dead `validation_alias`, not a
  convention), so "fall back to env" is not a reachable behaviour;
* a credential never lands on a workflow input, an activity result, or a
  `repr()` — Temporal history is durable storage;
* `denied` (tenant veto / entitlement) and `unavailable` (gateway fault) FAIL
  CLOSED, while `absent` (genuinely no opinion) calls the endpoint
  unauthenticated, which is the correct state for an in-boundary self-hosted one.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from pydantic import SecretStr, ValidationError

from harness.core.config import RetrievalConfig
from harness.core.provider_credentials import (
    CredentialOutcome,
    CredentialUnavailable,
    ProviderCredential,
    connection_provider_for_judge,
)
from harness.eval.config import AzureJudgeConfig, OpenAICompatJudgeConfig
from harness.services.api_client import ApiClient

TENANT = "11111111-1111-1111-1111-111111111111"


# ─────────────────────────── B.2 — the env paths are CLOSED ───────────────────────────


class TestEnvPathsAreStructurallyClosed:
    """A dead `validation_alias` + `populate_by_name` OFF, the `apps/tts` pattern.

    "Discouraged" is not closed. These assertions are what make "never falls back
    to env" a property of the type rather than a promise in a comment.
    """

    def test_openai_compat_judge_key_cannot_come_from_env(self, monkeypatch):
        monkeypatch.setenv("HARNESS_JUDGE_OPENAI_COMPAT_API_KEY", "env-leaked-key")
        assert OpenAICompatJudgeConfig().api_key.get_secret_value() != "env-leaked-key"

    def test_azure_judge_key_cannot_come_from_env(self, monkeypatch):
        monkeypatch.setenv("HARNESS_JUDGE_AZURE_API_KEY", "env-leaked-key")
        assert AzureJudgeConfig().api_key.get_secret_value() != "env-leaked-key"

    def test_qdrant_key_cannot_come_from_env(self, monkeypatch):
        monkeypatch.setenv("HARNESS_RETRIEVAL_QDRANT_API_KEY", "env-leaked-key")
        cfg = RetrievalConfig()
        assert (
            cfg.qdrant_api_key is None or cfg.qdrant_api_key.get_secret_value() != "env-leaked-key"
        )

    @pytest.mark.parametrize("cls", [OpenAICompatJudgeConfig, AzureJudgeConfig, RetrievalConfig])
    def test_populate_by_name_stays_off(self, cls):
        """One flag would re-open an env path for every field on the class at once."""
        assert not cls.model_config.get("populate_by_name", False)

    def test_the_field_name_itself_does_not_reopen_the_path(self, monkeypatch):
        """Belt-and-braces: neither the prefixed name nor the bare field name binds."""
        monkeypatch.setenv("API_KEY", "env-leaked-key")
        monkeypatch.setenv("HARNESS_JUDGE_AZURE_API_KEY", "env-leaked-key")
        assert AzureJudgeConfig().api_key.get_secret_value() != "env-leaked-key"

    def test_the_constructor_is_closed_too(self):
        """`populate_by_name` OFF means the FIELD NAME is not an input key either.

        With `extra="forbid"` (the pydantic-settings default) a keyword named after
        the field is rejected outright, so there is no second, quieter env-shaped
        way in. This is stronger than the `apps/tts` precedent needs to be and it
        is deliberate: the ONLY way a credential enters is the explicit
        `model_copy` below, which is code someone had to write.
        """
        with pytest.raises(ValidationError):
            OpenAICompatJudgeConfig(api_key=SecretStr("injected"))

    def test_injection_by_model_copy_still_works(self):
        """Closing the ENV path must not close the INJECTION path it exists for.

        `model_copy(update=...)` bypasses validation — the same mechanism the TTS
        router uses to apply a resolved `provider_override`.
        """
        judge = OpenAICompatJudgeConfig().model_copy(update={"api_key": SecretStr("injected")})
        assert judge.api_key.get_secret_value() == "injected"

        retrieval = RetrievalConfig().model_copy(update={"qdrant_api_key": SecretStr("injected")})
        assert retrieval.qdrant_api_key is not None
        assert retrieval.qdrant_api_key.get_secret_value() == "injected"


# ────────────────────── the judge transport → connection provider map ──────────────────────


class TestJudgeConnectionProviderMap:
    """`JudgeConfig` already has ONE openai-compatible connection block that four
    transports share; the connection row mirrors that block, not the transport."""

    @pytest.mark.parametrize("judge_provider", ["openai_compat", "ollama", "vllm", "llama-cpp"])
    def test_every_openai_wire_transport_maps_to_one_connection(self, judge_provider):
        assert connection_provider_for_judge(judge_provider) == "openai-compat"

    def test_azure_and_bedrock_keep_their_own_connection(self):
        assert connection_provider_for_judge("azure") == "azure"
        assert connection_provider_for_judge("bedrock") == "bedrock"

    def test_an_unknown_transport_passes_through_rather_than_guessing(self):
        assert connection_provider_for_judge("some-future-engine") == "some-future-engine"


# ─────────────────────────── the transport (worker → gateway) ───────────────────────────


def _client(handler) -> ApiClient:
    return ApiClient(
        "http://gateway:8868",
        service_token="svc",
        transport=httpx.MockTransport(handler),
    )


class TestResolveProviderCredentialTransport:
    @pytest.mark.asyncio
    async def test_resolved_payload_becomes_a_secret_bearing_credential(self):
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["token"] = request.headers.get("X-Service-Token")
            return httpx.Response(
                200,
                json={
                    "outcome": "resolved",
                    "apiKey": "sk-tenant-key",
                    "baseUrl": "https://judge.example/v1",
                    "apiVersion": "2024-12-01-preview",
                    "deploymentName": "judge",
                    "funding": "tenant",
                },
            )

        cred = await _client(handler).resolve_provider_credential("llm", "azure", tenant_id=TENANT)

        assert cred.outcome is CredentialOutcome.RESOLVED
        assert cred.api_key is not None
        assert cred.api_key.get_secret_value() == "sk-tenant-key"
        assert cred.base_url == "https://judge.example/v1"
        assert cred.funding == "tenant"
        assert "service=llm" in seen["url"]
        assert "provider=azure" in seen["url"]
        assert TENANT in seen["url"]
        assert seen["token"] == "svc"

    @pytest.mark.asyncio
    async def test_a_transport_failure_is_UNAVAILABLE_never_absent(self):
        """The whole point of the split: a gateway outage must not read as
        "no credential configured" and silently downgrade to an unauthenticated call."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={"message": "gateway down"})

        cred = await _client(handler).resolve_provider_credential("llm", "azure", tenant_id=TENANT)

        assert cred.outcome is CredentialOutcome.UNAVAILABLE
        assert cred.api_key is None

    @pytest.mark.asyncio
    async def test_a_denial_is_carried_through_verbatim(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"outcome": "denied", "reason": "tenant veto"})

        cred = await _client(handler).resolve_provider_credential("llm", "azure", tenant_id=TENANT)

        assert cred.outcome is CredentialOutcome.DENIED

    @pytest.mark.asyncio
    async def test_a_missing_tenant_never_reaches_the_wire(self):
        """A tenant-less resolve could only mean "read SYSTEM unconditionally"."""
        called = False

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal called
            called = True
            return httpx.Response(200, json={"outcome": "absent"})

        cred = await _client(handler).resolve_provider_credential("llm", "azure", tenant_id=None)

        assert cred.outcome is CredentialOutcome.UNAVAILABLE
        assert called is False

    @pytest.mark.asyncio
    async def test_an_unparseable_outcome_fails_closed(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"outcome": "something-new", "apiKey": "k"})

        cred = await _client(handler).resolve_provider_credential("llm", "azure", tenant_id=TENANT)

        assert cred.outcome is CredentialOutcome.UNAVAILABLE


class TestCredentialNeverLeaks:
    def test_repr_masks_the_key(self):
        cred = ProviderCredential(
            outcome=CredentialOutcome.RESOLVED, api_key=SecretStr("sk-super-secret")
        )
        assert "sk-super-secret" not in repr(cred)
        assert "sk-super-secret" not in str(cred)

    def test_it_is_not_json_serialisable_by_accident(self):
        """A dataclass carrying SecretStr cannot be `json.dumps`'d, so it cannot
        be dropped onto a Temporal activity input or a log record by accident."""
        cred = ProviderCredential(
            outcome=CredentialOutcome.RESOLVED, api_key=SecretStr("sk-super-secret")
        )
        with pytest.raises(TypeError):
            json.dumps(cred.__dict__)

    def test_raise_if_unusable_names_the_provider_but_not_the_key(self):
        cred = ProviderCredential(outcome=CredentialOutcome.DENIED, reason="tenant veto")
        with pytest.raises(CredentialUnavailable) as exc:
            cred.raise_if_unusable(service="llm", provider="azure")
        assert "azure" in str(exc.value)

    @pytest.mark.parametrize("outcome", [CredentialOutcome.RESOLVED, CredentialOutcome.ABSENT])
    def test_usable_outcomes_do_not_raise(self, outcome):
        ProviderCredential(outcome=outcome).raise_if_unusable(service="llm", provider="azure")


class TestTheCredentialActuallyReachesTheClient:
    """The half that is easy to leave unproven — and was, for `qdrant_api_key`.

    A previous lane found that config COULD hold a Qdrant key and the store COULD
    present one, while both construction sites dropped it on the floor, so a
    secured cluster was unreachable while the config claimed otherwise. These
    tests assert the CONNECTION, not the halves.
    """

    def test_a_resolved_key_reaches_the_openai_compatible_judge(self, monkeypatch):
        from harness.temporal import activities

        seen: dict[str, Any] = {}
        monkeypatch.setattr(
            activities, "build_judge_client", lambda cfg: seen.setdefault("cfg", cfg)
        )

        activities._build_runtime_judge(
            provider="openai_compat",
            model="stub-judge",
            credential=ProviderCredential(
                outcome=CredentialOutcome.RESOLVED,
                api_key=SecretStr("sk-tenant-judge"),
                base_url="https://tenant.example/v1",
                funding="tenant",
            ),
        )

        cfg = seen["cfg"]
        assert cfg.openai_compat.api_key.get_secret_value() == "sk-tenant-judge"
        assert cfg.openai_compat.base_url == "https://tenant.example/v1"

    def test_a_resolved_key_reaches_the_azure_judge_with_its_whole_connection(self, monkeypatch):
        """Azure's endpoint/deployment/api-version live on the SAME row as its key."""
        from harness.temporal import activities

        seen: dict[str, Any] = {}
        monkeypatch.setattr(
            activities, "build_judge_client", lambda cfg: seen.setdefault("cfg", cfg)
        )

        activities._build_runtime_judge(
            provider="azure",
            model="gpt-4o",
            credential=ProviderCredential(
                outcome=CredentialOutcome.RESOLVED,
                api_key=SecretStr("sk-azure"),
                base_url="https://tenant.openai.azure.com",
                api_version="2025-01-01",
                deployment_name="tenant-judge",
                funding="tenant",
            ),
        )

        az = seen["cfg"].azure
        assert az.api_key.get_secret_value() == "sk-azure"
        assert az.endpoint == "https://tenant.openai.azure.com"
        assert az.api_version == "2025-01-01"
        assert az.deployment == "tenant-judge"

    def test_an_absent_credential_leaves_the_judge_unauthenticated(self, monkeypatch):
        """No key configured anywhere ⇒ call the local endpoint as-is, never env."""
        from harness.temporal import activities

        seen: dict[str, Any] = {}
        monkeypatch.setattr(
            activities, "build_judge_client", lambda cfg: seen.setdefault("cfg", cfg)
        )

        activities._build_runtime_judge(
            provider="openai_compat",
            model="stub-judge",
            credential=ProviderCredential(outcome=CredentialOutcome.ABSENT),
        )

        # The placeholder default, NOT a key sourced from the environment.
        assert seen["cfg"].openai_compat.api_key.get_secret_value() == "lm-studio"

    def test_a_resolved_key_reaches_the_qdrant_client(self, monkeypatch):
        from unittest.mock import patch

        from harness.temporal.activities import _hybrid_retriever

        with patch("qdrant_client.QdrantClient") as mock_client:
            _hybrid_retriever(
                _settings_with_embeddings_model(),
                ProviderCredential(
                    outcome=CredentialOutcome.RESOLVED,
                    api_key=SecretStr("qdrant-tenant-key"),
                    base_url="https://tenant.qdrant.cloud",
                    funding="tenant",
                ),
            )

        assert mock_client.call_args.kwargs.get("api_key") == "qdrant-tenant-key"
        assert mock_client.call_args.kwargs.get("url") == "https://tenant.qdrant.cloud"

    def test_an_absent_credential_still_builds_an_unauthenticated_store(self):
        """Local dev Qdrant is unauthenticated — absence must not become ""."""
        from unittest.mock import patch

        from harness.temporal.activities import _hybrid_retriever

        with patch("qdrant_client.QdrantClient") as mock_client:
            _hybrid_retriever(
                _settings_with_embeddings_model(),
                ProviderCredential(outcome=CredentialOutcome.ABSENT),
            )

        assert mock_client.call_args.kwargs.get("api_key") is None


def _settings_with_embeddings_model():
    """Settings whose retrieval carries an embeddings model (TASK-952 D-1c).

    `embeddings_model` lost its hardcoded default: it is a model SELECTION, so it
    resolves from the connection row and `_hybrid_retriever` fails closed without
    one. The tests in this file are about the QDRANT credential, so they inject a
    model exactly as the runtime fold does rather than depending on a default that
    no longer exists.
    """
    from harness.core.config import Settings

    settings = Settings()
    settings.retrieval.embeddings_model = "test-embeddings"
    return settings


class TestUnresolvableCredentialsFailClosed:
    """DENIED / UNAVAILABLE degrade the consumer. They never reach a backend, and
    they never fall through to an environment variable."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("outcome", [CredentialOutcome.DENIED, CredentialOutcome.UNAVAILABLE])
    async def test_the_inferential_pass_degrades_without_building_a_judge(
        self, monkeypatch, outcome
    ):
        from harness.temporal import activities
        from harness.temporal.models import RunInferentialSensorsInput

        async def _unusable(*_a, **_k):
            return ProviderCredential(outcome=outcome, reason="pinned")

        monkeypatch.setattr(activities, "_resolve_provider_credential", _unusable)

        def _must_not_build(*_a, **_k):
            raise AssertionError("the judge must never be built without a usable credential")

        monkeypatch.setattr(activities, "_build_runtime_judge", _must_not_build)
        monkeypatch.setattr(activities, "_safety_screen_client", lambda *_a, **_k: None)

        out = await activities.run_inferential_sensors(
            RunInferentialSensorsInput(
                tenant_id=TENANT,
                note_text="Patient stable.",
                transcript_text="Patient stable.",
                judge_provider="openai_compat",
                judge_model="stub-judge",
                safety_enabled=False,
            )
        )

        assert out.degraded is True

    @pytest.mark.asyncio
    @pytest.mark.parametrize("outcome", [CredentialOutcome.DENIED, CredentialOutcome.UNAVAILABLE])
    async def test_retrieval_degrades_to_an_empty_context(self, monkeypatch, outcome):
        from harness.temporal import activities
        from harness.temporal.models import RetrieveContextInput

        async def _unusable(*_a, **_k):
            return ProviderCredential(outcome=outcome, reason="pinned")

        monkeypatch.setattr(activities, "_resolve_provider_credential", _unusable)

        def _must_not_build(*_a, **_k):
            raise AssertionError("the retriever must never be built without a usable credential")

        monkeypatch.setattr(activities, "_hybrid_retriever", _must_not_build)

        out = await activities.retrieve_context(
            RetrieveContextInput(tenant_id=TENANT, entities=[], retrieval_enabled=True)
        )

        assert out.degraded is True
        assert out.chunks == []


class TestNoCredentialFieldOnAnyWorkflowInput:
    """The structural guard for the Temporal-history property.

    Everything on a Temporal activity input or result is persisted to workflow
    history, which is durable and replayable. This asserts that no harness
    workflow/activity payload model has grown a credential-shaped field — the
    delivery design's central claim, checked mechanically rather than reviewed.
    """

    def test_no_payload_model_declares_a_credential_field(self):
        import inspect

        from pydantic import BaseModel

        from harness.temporal import models as temporal_models

        banned = ("api_key", "apikey", "secret", "credential", "token", "password")
        # `token` also names an LLM-token COUNT, which is not a credential. The
        # exemptions are enumerated rather than pattern-matched so a genuinely new
        # `service_token` / `auth_token` field still trips the guard.
        benign = {"token_budget_per_run"}

        offenders: list[str] = []
        for name, obj in inspect.getmembers(temporal_models, inspect.isclass):
            if not issubclass(obj, BaseModel) or obj is BaseModel:
                continue
            for field in obj.model_fields:
                if field in benign:
                    continue
                if any(b in field.lower() for b in banned):
                    offenders.append(f"{name}.{field}")
        assert offenders == []
