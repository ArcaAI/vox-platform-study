"""TASK-958 G3 — a `core.agent` generation spends the connection the AGENT is bound to.

TASK-958 made the model row name its connection (`AiModel.sourceConnectionId`), and the
gateway resolves it: `ResolvedAgent.providerOverride` is the credential of THAT row, with
`connection_id` / `connection_slug` on it. The realtime lane already forwards it verbatim
(`live-documentation.service.ts`: `provider_overrides: { [candidate.provider]: overrideEntry }`).

The harness did not. `TextClient.generate` folded
`to_provider_overrides(ApiClient.resolve_provider_credential(service, provider, tenant_id))`
— a lookup by provider NAME, which resolves the tenant's DEFAULT connection for that vendor.
So a tenant holding two OpenAI accounts, with an agent deliberately bound to the second, had
every WORKFLOW generation billed to — and authenticated as — the first. Nothing failed; the
wrong invoice is the only symptom.

The resolved override therefore wins when it is there, and the by-name fetch is not consulted
at all in that case. The fail-closed posture is the point of the `elif`: an override carrying
no credential material must NOT be "rescued" by the name lookup, because the rescue spends an
account the binding did not name.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from pydantic import SecretStr

from harness.core.provider_credentials import CredentialOutcome, ProviderCredential
from harness.services.text_client import TextClient, TextServiceError
from harness.temporal.interpreter.models import NodeActivityInput
from harness.temporal.interpreter.nodes import core

_TENANT = "10000000-0000-0000-0000-000000000001"
_RUN = "018f3a7c-5b84-7d19-9e63-0a2c8d5f7b43"

#: What the gateway ships for an agent whose primary model names the tenant's SECOND OpenAI
#: account. `provider` rides INSIDE the entry (`{ provider, ...binding.override }`) and is
#: stripped before it becomes the map's value, exactly as the realtime lane strips it.
SIBLING_OVERRIDE = {
    "provider": "openai",
    "api_key": "research-key",
    "base_url": "https://api.openai.com/v1",
    "funding": "tenant",
    "connection_id": "conn-openai-research",
    "connection_slug": "openai-research",
}

#: The tenant's DEFAULT OpenAI account — what a by-NAME lookup returns, and what a
#: sibling-bound agent must never spend.
DEFAULT_ACCOUNT = ProviderCredential(
    outcome=CredentialOutcome.RESOLVED,
    api_key=SecretStr("default-key"),
    funding="tenant",
)


def _capture():
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["request"] = request
        return httpx.Response(
            200,
            json={
                "task_id": "t-1",
                "status": "completed",
                "content": "ok",
                "provider": "openai",
                "model": "gpt-x",
            },
        )

    return seen, handler


class TestTextClientPrefersTheResolvedOverride:
    @pytest.mark.asyncio
    async def test_a_resolved_override_is_sent_verbatim_and_skips_the_by_name_fetch(self):
        seen, handler = _capture()
        resolver_calls: list[tuple[str, str]] = []

        async def resolver(provider: str, tenant_id: str) -> ProviderCredential:
            resolver_calls.append((provider, tenant_id))
            return DEFAULT_ACCOUNT

        client = TextClient(
            "http://text:8862",
            transport=httpx.MockTransport(handler),
            credential_resolver=resolver,
        )
        await client.generate(
            tenant_id=_TENANT,
            prompt="p",
            provider="openai",
            model="gpt-x",
            provider_override=SIBLING_OVERRIDE,
        )

        assert resolver_calls == []
        body = json.loads(seen["request"].content)
        assert body["provider_overrides"] == {
            "openai": {
                "api_key": "research-key",
                "base_url": "https://api.openai.com/v1",
                "funding": "tenant",
                "connection_id": "conn-openai-research",
                "connection_slug": "openai-research",
            }
        }

    @pytest.mark.asyncio
    async def test_no_override_keeps_the_by_name_fetch(self):
        seen, handler = _capture()
        resolver_calls: list[tuple[str, str]] = []

        async def resolver(provider: str, tenant_id: str) -> ProviderCredential:
            resolver_calls.append((provider, tenant_id))
            return DEFAULT_ACCOUNT

        client = TextClient(
            "http://text:8862",
            transport=httpx.MockTransport(handler),
            credential_resolver=resolver,
        )
        await client.generate(tenant_id=_TENANT, prompt="p", provider="openai", model="gpt-x")

        assert resolver_calls == [("openai", _TENANT)]
        body = json.loads(seen["request"].content)
        assert body["provider_overrides"] == {
            "openai": {"api_key": "default-key", "funding": "tenant"}
        }

    @pytest.mark.asyncio
    async def test_an_override_with_no_credential_material_fails_closed_unrescued(self):
        """The whole reason this is an `elif` and not a merge: falling through here would
        spend the tenant's DEFAULT account on a call its binding pointed elsewhere."""
        seen, handler = _capture()
        resolver_calls: list[str] = []

        async def resolver(provider: str, tenant_id: str) -> ProviderCredential:
            resolver_calls.append(provider)
            return DEFAULT_ACCOUNT

        client = TextClient(
            "http://text:8862",
            transport=httpx.MockTransport(handler),
            credential_resolver=resolver,
        )
        with pytest.raises(TextServiceError) as excinfo:
            await client.generate(
                tenant_id=_TENANT,
                prompt="p",
                provider="azure-openai",
                model="gpt-x",
                provider_override={"provider": "azure-openai", "api_key": ""},
            )

        assert "azure-openai" in str(excinfo.value)
        assert excinfo.value.after_send is False
        assert resolver_calls == []
        assert "request" not in seen


def _wire(provider_override: dict[str, Any] | None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "agentId": "agent-1",
        "agentVersionId": "agent-1",
        "slug": "tenant-soap",
        "versionNumber": 1,
        "task": "TEXT_GENERATION",
        "tenantId": _TENANT,
        "source": "tenant",
        "compiledConfig": {
            "task": "TEXT_GENERATION",
            "service": "llm",
            "model": {
                "id": "m-1",
                "slug": "byo-gpt-x",
                "provider": "openai",
                "taskType": "TEXT_GENERATION",
            },
            "fallbacks": [],
            "instruction": {"systemPrompt": "Summarise."},
            "resolvedPrompt": {"source": "inline", "content": "Summarise."},
            "parameters": {},
            "inputSchema": {"type": "object"},
            "outputSchema": None,
            "tools": [],
            "protocols": ["http"],
        },
        "models": [
            {
                "role": "primary",
                "priority": 0,
                "slug": "byo-gpt-x",
                "sourceUri": "gpt-x",
                "provider": "openai",
                "format": "CLOUD",
                "tenantId": _TENANT,
                "sourceConnectionId": "conn-openai-research",
            }
        ],
        "textPrimary": {
            "kind": "primary",
            "agent": {
                "slug": "tenant-soap",
                "versionId": "agent-1",
                "versionNumber": 1,
                "tenantId": _TENANT,
                "source": "tenant",
            },
            "modelSlug": "byo-gpt-x",
            "provider": "openai",
            "model": "gpt-x",
            "resolvedPrompt": {"source": "inline", "content": "Summarise."},
            "instruction": {"systemPrompt": "Summarise."},
            "parameters": {},
            "tools": [],
            "fundingTier": "tenant",
        },
        "textFallback": {"autoSwitch": False, "chain": []},
    }
    if provider_override is not None:
        payload["providerOverride"] = provider_override
        payload["fundingTier"] = "tenant"
    return payload


class _StubApi:
    def __init__(self, answer: dict[str, Any]) -> None:
        self.answer = answer

    async def resolve_agent(self, **_kwargs: Any) -> dict[str, Any]:
        return self.answer

    async def get_policy(self, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"phiEnabled": False, "phiFailClosed": True}


class _Result:
    content = "ok"
    provider = "openai"
    model = "gpt-x"
    usage: dict[str, Any] = {}
    stats = None


class _StubText:
    def __init__(self, fail_first: bool = False) -> None:
        self.calls: list[dict[str, Any]] = []
        self.fail_first = fail_first

    async def generate(self, **kwargs: Any) -> _Result:
        self.calls.append(kwargs)
        if self.fail_first and len(self.calls) == 1:
            raise TextServiceError("primary provider outage")
        return _Result()


#: The tenant's SECOND Azure account, on the chain's fallback candidate. The gateway ships one
#: `providerOverride` PER candidate (`ResolvedTextCandidate.providerOverride`), because a chain
#: can name two accounts — or two vendors — and the primary's credential is not the fallback's.
FALLBACK_OVERRIDE = {
    "provider": "azure-openai",
    "api_key": "backup-key",
    "funding": "tenant",
    "connection_id": "conn-azure-backup",
    "connection_slug": "azure-backup",
}


def _wire_with_chain() -> dict[str, Any]:
    payload = _wire(SIBLING_OVERRIDE)
    payload["textFallback"] = {
        "autoSwitch": True,
        "chain": [
            {
                "kind": "agent-model",
                "agent": {
                    "slug": "tenant-soap",
                    "versionId": "agent-1",
                    "versionNumber": 1,
                    "tenantId": _TENANT,
                    "source": "tenant",
                },
                "modelSlug": "byo-azure",
                "provider": "azure-openai",
                "model": "gpt-4o",
                "resolvedPrompt": {"source": "inline", "content": "Summarise."},
                "instruction": {"systemPrompt": "Summarise."},
                "parameters": {},
                "fundingTier": "tenant",
                "providerOverride": FALLBACK_OVERRIDE,
            }
        ],
    }
    return payload


class TestCoreAgentForwardsTheBoundConnection:
    @pytest.fixture
    def run(self, monkeypatch: pytest.MonkeyPatch):
        async def _noop(*_args: Any, **_kwargs: Any) -> None:
            return None

        monkeypatch.setattr(core, "record_and_flush", _noop)
        monkeypatch.setattr(core, "_phi_redactor", lambda: None)

        async def _go(provider_override: dict[str, Any] | None) -> tuple[_StubText, Any]:
            text = _StubText()
            monkeypatch.setattr(
                core, "_api_client", lambda _settings: _StubApi(_wire(provider_override))
            )
            monkeypatch.setattr(core, "_text_client", lambda _settings: text)
            result = await core.interpreter_core_agent(
                NodeActivityInput(
                    node_id="agent1",
                    node_type="core.agent",
                    config={"agentRef": {"slug": "tenant-soap"}},
                    tenant_id=_TENANT,
                    sandbox=False,
                    bound_inputs={"in": "Summarise this."},
                    run_payload={},
                    run_id=_RUN,
                )
            )
            return text, result

        return _go

    @pytest.mark.asyncio
    async def test_the_candidates_own_override_reaches_the_text_client(self, run) -> None:
        text, result = await run(SIBLING_OVERRIDE)

        assert result.status == "SUCCEEDED"
        assert text.calls[0]["provider_override"] == SIBLING_OVERRIDE

    @pytest.mark.asyncio
    async def test_an_agent_with_no_override_forwards_none(self, run) -> None:
        text, result = await run(None)

        assert result.status == "SUCCEEDED"
        assert text.calls[0]["provider_override"] is None

    @pytest.mark.asyncio
    async def test_a_fallback_candidate_spends_its_OWN_connection(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The same defect one level down. `candidate_as_resolved_agent` projects a chain
        candidate onto the `ResolvedAgent` shape; it dropped `providerOverride`, so after a
        failover the fallback fell back to the by-NAME lookup and spent the tenant's default
        account for that vendor — the account its own binding did not name."""

        async def _noop(*_args: Any, **_kwargs: Any) -> None:
            return None

        monkeypatch.setattr(core, "record_and_flush", _noop)
        monkeypatch.setattr(core, "_phi_redactor", lambda: None)
        text = _StubText(fail_first=True)
        monkeypatch.setattr(core, "_api_client", lambda _settings: _StubApi(_wire_with_chain()))
        monkeypatch.setattr(core, "_text_client", lambda _settings: text)

        result = await core.interpreter_core_agent(
            NodeActivityInput(
                node_id="agent1",
                node_type="core.agent",
                config={"agentRef": {"slug": "tenant-soap"}},
                tenant_id=_TENANT,
                sandbox=False,
                bound_inputs={"in": "Summarise this."},
                run_payload={},
                run_id=_RUN,
            )
        )

        assert result.status == "SUCCEEDED"
        assert [call["provider_override"] for call in text.calls] == [
            SIBLING_OVERRIDE,
            FALLBACK_OVERRIDE,
        ]
