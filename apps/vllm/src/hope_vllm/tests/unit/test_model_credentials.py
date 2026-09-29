"""OD-7: the model-registry credential, resolved for the MODEL OWNER over the generic route."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from hope_vllm.core.model_credentials import (
    SYSTEM_TENANT_ID,
    CredentialOutcome,
    ModelRegistryCredential,
    ModelRegistryCredentialClient,
    owner_tenant_of,
)

GATEWAY = "http://gateway.test/api/v1"
OWNER = "50000000-0000-0000-0000-000000000000"


class Gateway:
    def __init__(self, body: Any = None, status: int = 200) -> None:
        self.body = body if body is not None else {"outcome": "absent"}
        self.status = status
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status, json=self.body)

    def client(self, **kwargs: Any) -> ModelRegistryCredentialClient:
        return ModelRegistryCredentialClient(
            base_url=GATEWAY,
            token="tok-123",
            transport=httpx.MockTransport(self.handler),
            **kwargs,
        )


async def test_calls_the_generic_route_as_hope_vllm_for_the_owner_tenant() -> None:
    gateway = Gateway({"outcome": "resolved", "apiKey": "hf_secret", "funding": "platform"})
    await gateway.client().resolve("huggingface", OWNER)

    (request,) = gateway.requests
    assert request.method == "GET"
    assert request.url.path == "/api/v1/internal/model-registry-credential"
    assert dict(request.url.params) == {
        "service": "vllm",  # the guard's secret selector — required
        "provider": "huggingface",
        "tenantId": OWNER,
    }
    assert request.headers["X-Service-Token"] == "tok-123"
    assert request.headers["X-Tenant-Id"] == OWNER
    # The tts/nlp copies send this header (and no `service=`) and 401 — the known defect.
    assert "X-Internal-Service-Key" not in request.headers


async def test_resolved_carries_the_key_as_a_secret() -> None:
    gateway = Gateway({"outcome": "resolved", "apiKey": "hf_secret", "funding": "tenant"})
    credential = await gateway.client().resolve("huggingface", OWNER)
    assert credential.outcome is CredentialOutcome.RESOLVED
    assert credential.usable is True
    assert credential.secret == "hf_secret"
    assert credential.funding == "tenant"
    assert "hf_secret" not in repr(credential)


async def test_absent_is_usable_without_a_key() -> None:
    credential = await Gateway({"outcome": "absent"}).client().resolve("huggingface", OWNER)
    assert credential.outcome is CredentialOutcome.ABSENT
    assert credential.usable is True and credential.secret is None


async def test_denied_is_not_usable_and_keeps_its_reason() -> None:
    body = {"outcome": "denied", "reason": "tenant disabled model-registry:huggingface"}
    credential = await Gateway(body).client().resolve("huggingface", OWNER)
    assert credential.outcome is CredentialOutcome.DENIED
    assert credential.usable is False
    assert credential.reason == "tenant disabled model-registry:huggingface"


async def test_an_empty_key_is_not_a_credential() -> None:
    credential = await (
        Gateway({"outcome": "resolved", "apiKey": ""}).client().resolve("huggingface", OWNER)
    )
    assert credential.secret is None


@pytest.mark.parametrize("status", [400, 401, 500, 503])
async def test_a_gateway_error_is_unavailable(status: int) -> None:
    credential = await Gateway(status=status).client().resolve("huggingface", OWNER)
    assert credential.outcome is CredentialOutcome.UNAVAILABLE
    assert credential.usable is False


@pytest.mark.parametrize("body", [["not", "a", "dict"], {"outcome": "maybe"}, {"outcome": 3}])
async def test_a_payload_this_client_does_not_understand_is_unavailable(body: Any) -> None:
    credential = await Gateway(body).client().resolve("huggingface", OWNER)
    assert credential.outcome is CredentialOutcome.UNAVAILABLE


async def test_an_unreachable_gateway_is_unavailable() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    client = ModelRegistryCredentialClient(
        base_url=GATEWAY, token="t", transport=httpx.MockTransport(refuse)
    )
    assert (await client.resolve("huggingface", OWNER)).outcome is CredentialOutcome.UNAVAILABLE


async def test_no_gateway_configured_is_unavailable_without_a_request() -> None:
    client = ModelRegistryCredentialClient(base_url="", token="t")
    credential = await client.resolve("huggingface", OWNER)
    assert credential.outcome is CredentialOutcome.UNAVAILABLE
    assert "gateway" in credential.reason


async def test_settled_answers_are_cached_per_provider_and_tenant() -> None:
    gateway = Gateway({"outcome": "absent"})
    client = gateway.client()
    await client.resolve("huggingface", OWNER)
    await client.resolve("huggingface", OWNER)
    await client.resolve("huggingface", SYSTEM_TENANT_ID)  # another tenant: another entry
    assert len(gateway.requests) == 2


async def test_a_fault_is_never_cached() -> None:
    gateway = Gateway(status=503)
    client = gateway.client()
    await client.resolve("huggingface", OWNER)
    await client.resolve("huggingface", OWNER)
    assert len(gateway.requests) == 2


def test_an_unowned_model_resolves_the_system_tenant_explicitly() -> None:
    assert owner_tenant_of(None) == SYSTEM_TENANT_ID
    assert owner_tenant_of("  ") == SYSTEM_TENANT_ID
    assert owner_tenant_of(f" {OWNER} ") == OWNER


def test_unavailable_constructor_is_fail_closed() -> None:
    credential = ModelRegistryCredential.unavailable("because")
    assert credential.usable is False and credential.reason == "because"
