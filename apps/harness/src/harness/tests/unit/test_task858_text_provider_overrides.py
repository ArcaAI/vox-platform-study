"""TASK-858 — the harness's direct ``apps/text`` calls must carry the resolved
``AiProviderConnection`` as a ``provider_overrides`` envelope.

``apps/text`` holds no endpoint or credential of its own (TASK-735/736): every
adapter — the self-hosted LM Studio one included — calls ``require_connection``
and answers a typed 503 ``PROVIDER_CREDENTIALS_MISSING`` when the request carries
no ``provider_overrides[provider]``. The gateway injects that envelope for its own
proxied calls; the harness worker, which calls Text DIRECTLY, never did, so every
durable-lane generation (``consultation.synthesize``, ``generate.text``, the
judgement nodes, the realtime nodes' durable twins) degraded on the real cluster
the moment the run got past prompt assembly. Measured 2026-09-03 on
``hope-v2-dev``: ``n_synth DEGRADED — text generate failed: 503``.

The delivery path is the one this repo already sanctions for a credential used
inside an activity — ``GET /internal/harness/provider-credential`` (tenant →
SYSTEM, ``funding`` derived gateway-side) — folded into the request body at the
single point every harness generate goes through: ``TextClient.generate``.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from pydantic import SecretStr

from harness.core.provider_credentials import (
    CredentialOutcome,
    ProviderCredential,
    to_provider_overrides,
)
from harness.services.text_client import TextClient, TextServiceError


class TestToProviderOverrides:
    def test_resolved_credential_becomes_the_text_envelope_keyed_by_provider(self):
        credential = ProviderCredential(
            outcome=CredentialOutcome.RESOLVED,
            api_key=SecretStr("k-1"),
            base_url="http://hope-lmstudio:1234/v1",
            funding="platform",
        )
        assert to_provider_overrides(credential, "lm-studio") == {
            "lm-studio": {
                "api_key": "k-1",
                "base_url": "http://hope-lmstudio:1234/v1",
                "funding": "platform",
            }
        }

    def test_optional_connection_fields_travel_only_when_set(self):
        credential = ProviderCredential(
            outcome=CredentialOutcome.RESOLVED,
            api_key=SecretStr("k-2"),
            region="eastus",
            api_version="2024-06-01",
            deployment_name="gpt-4o",
            model="gpt-4o",
            funding="tenant",
        )
        envelope = to_provider_overrides(credential, "azure")["azure"]
        assert envelope == {
            "api_key": "k-2",
            "region": "eastus",
            "api_version": "2024-06-01",
            "deployment_name": "gpt-4o",
            "model": "gpt-4o",
            "funding": "tenant",
        }
        assert "base_url" not in envelope

    def test_keyless_self_host_connection_sends_an_empty_key_not_none(self):
        # Text's ``ProviderOverride.api_key`` is a required ``SecretStr``; a
        # self-host row legitimately has no key but MUST still deliver its
        # ``base_url`` — an absent key must not drop the whole envelope.
        credential = ProviderCredential(
            outcome=CredentialOutcome.RESOLVED, base_url="http://hope-vllm:8000/v1"
        )
        assert to_provider_overrides(credential, "vllm") == {
            "vllm": {"api_key": "", "base_url": "http://hope-vllm:8000/v1"}
        }

    @pytest.mark.parametrize(
        "outcome",
        [CredentialOutcome.ABSENT, CredentialOutcome.DENIED, CredentialOutcome.UNAVAILABLE],
    )
    def test_anything_but_resolved_yields_no_envelope(self, outcome):
        assert to_provider_overrides(ProviderCredential(outcome=outcome), "lm-studio") is None


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
                "provider": "lm-studio",
                "model": "m",
            },
        )

    return seen, handler


class TestTextClientFoldsTheResolvedConnection:
    @pytest.mark.asyncio
    async def test_generate_folds_the_resolved_connection_into_provider_overrides(self):
        seen, handler = _capture()
        resolver_calls: list[tuple[str, str]] = []

        async def resolver(provider: str, tenant_id: str) -> ProviderCredential:
            resolver_calls.append((provider, tenant_id))
            return ProviderCredential(
                outcome=CredentialOutcome.RESOLVED,
                api_key=SecretStr("k"),
                base_url="http://hope-lmstudio:1234/v1",
                funding="platform",
            )

        client = TextClient(
            "http://text:8862",
            transport=httpx.MockTransport(handler),
            credential_resolver=resolver,
        )
        await client.generate(tenant_id="tenant-1", prompt="p", provider="lm-studio", model="m")

        assert resolver_calls == [("lm-studio", "tenant-1")]
        body = json.loads(seen["request"].content)
        assert body["provider_overrides"] == {
            "lm-studio": {
                "api_key": "k",
                "base_url": "http://hope-lmstudio:1234/v1",
                "funding": "platform",
            }
        }

    @pytest.mark.asyncio
    async def test_an_absent_connection_sends_no_envelope(self):
        seen, handler = _capture()

        async def resolver(provider: str, tenant_id: str) -> ProviderCredential:
            return ProviderCredential(outcome=CredentialOutcome.ABSENT)

        client = TextClient(
            "http://text:8862",
            transport=httpx.MockTransport(handler),
            credential_resolver=resolver,
        )
        await client.generate(tenant_id="tenant-1", prompt="p", provider="lm-studio", model="m")
        assert "provider_overrides" not in json.loads(seen["request"].content)

    @pytest.mark.parametrize("outcome", [CredentialOutcome.DENIED, CredentialOutcome.UNAVAILABLE])
    @pytest.mark.asyncio
    async def test_an_unusable_connection_fails_closed_before_any_send(self, outcome):
        seen, handler = _capture()

        async def resolver(provider: str, tenant_id: str) -> ProviderCredential:
            return ProviderCredential(outcome=outcome, reason="pinned")

        client = TextClient(
            "http://text:8862",
            transport=httpx.MockTransport(handler),
            credential_resolver=resolver,
        )
        with pytest.raises(TextServiceError) as excinfo:
            await client.generate(tenant_id="tenant-1", prompt="p", provider="azure", model="m")
        # Surfaces as the SAME error type every call site already degrades on,
        # names the (service, provider) and the outcome — and nothing was sent.
        assert "llm/azure" in str(excinfo.value)
        assert outcome.value in str(excinfo.value)
        assert excinfo.value.after_send is False
        assert "request" not in seen

    @pytest.mark.asyncio
    async def test_no_provider_means_no_lookup(self):
        seen, handler = _capture()
        calls: list[Any] = []

        async def resolver(provider: str, tenant_id: str) -> ProviderCredential:
            calls.append(provider)
            return ProviderCredential(outcome=CredentialOutcome.ABSENT)

        client = TextClient(
            "http://text:8862",
            transport=httpx.MockTransport(handler),
            credential_resolver=resolver,
        )
        await client.generate(tenant_id="tenant-1", prompt="p")
        assert calls == []
        assert "provider_overrides" not in json.loads(seen["request"].content)

    @pytest.mark.asyncio
    async def test_without_a_resolver_the_wire_shape_is_unchanged(self):
        seen, handler = _capture()
        client = TextClient("http://text:8862", transport=httpx.MockTransport(handler))
        await client.generate(tenant_id="tenant-1", prompt="p", provider="lm-studio", model="m")
        assert "provider_overrides" not in json.loads(seen["request"].content)


class TestActivityTextClientIsWiredToTheGateway:
    @pytest.mark.asyncio
    async def test_text_client_factory_resolves_llm_connections_through_the_api_client(
        self, monkeypatch
    ):
        from harness.core.config import get_settings
        from harness.temporal import activities

        calls: list[tuple[str, str, str | None]] = []

        class _FakeApi:
            async def resolve_provider_credential(self, service, provider, *, tenant_id):
                calls.append((service, provider, tenant_id))
                return ProviderCredential(outcome=CredentialOutcome.ABSENT)

        monkeypatch.setattr(activities, "_api_client", lambda s: _FakeApi())
        client = activities._text_client(get_settings())
        resolver = client._credential_resolver
        assert resolver is not None
        credential = await resolver("lm-studio", "tenant-1")
        assert credential.outcome is CredentialOutcome.ABSENT
        # Text connections live under the ``llm`` capability, tenant → SYSTEM.
        assert calls == [("llm", "lm-studio", "tenant-1")]
