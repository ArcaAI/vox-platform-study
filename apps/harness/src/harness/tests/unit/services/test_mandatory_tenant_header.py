"""TASK-737 — `X-Tenant-Id` is MANDATORY on every harness peer call.

The audit's single highest-leverage finding was that `TextClient.generate()` had no
`tenant_id` parameter AT ALL, so all five `activities.py` call sites reached
`apps/text` with `x_tenant_id=None` — which `apps/text` then forwarded to guardrail
as `tenant_id=None` as well. Three of those five call sites had `tenant_id` sitting
on the workflow input, already required, and simply dropped it at the client
boundary.

These tests pin the contract at that boundary, where it can no longer be dropped:

* the header is sent UNCONDITIONALLY (no `if tenant_id:` guard to fall through);
* a blank tenant RAISES at the caller rather than resolving a platform default
  one or two hops downstream, where nothing would throw or log;
* a DECLARED `tenantless:<reason>` marker is a legitimate value and passes through
  verbatim — that is the whole point of having a marker.
"""

from __future__ import annotations

import httpx
import pytest

from harness.services.nlp_client import NlpClient
from harness.services.text_client import TextClient

TENANT = "11111111-1111-1111-1111-111111111111"


def _recorder(payload: dict) -> tuple[httpx.MockTransport, dict[str, str]]:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        return httpx.Response(200, json=payload)

    return httpx.MockTransport(handler), seen


# ── TextClient ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_text_generate_always_sends_the_tenant_header():
    transport, seen = _recorder({"content": "note"})
    client = TextClient("http://text.test", transport=transport)

    await client.generate(tenant_id=TENANT, prompt="hi")

    assert seen["x-tenant-id"] == TENANT


@pytest.mark.asyncio
async def test_text_generate_rejects_a_blank_tenant_at_the_caller():
    transport, seen = _recorder({"content": "note"})
    client = TextClient("http://text.test", transport=transport)

    with pytest.raises(ValueError, match="tenant_id"):
        await client.generate(tenant_id="   ", prompt="hi")

    assert seen == {}, "the request must never leave the harness without a tenant"


@pytest.mark.asyncio
async def test_text_generate_accepts_a_declared_tenantless_marker():
    transport, seen = _recorder({"content": "note"})
    client = TextClient("http://text.test", transport=transport)

    await client.generate(tenant_id="tenantless:worker-weights", prompt="hi")

    assert seen["x-tenant-id"] == "tenantless:worker-weights"


# ── NlpClient ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_nlp_classify_tokens_always_sends_the_tenant_header():
    transport, seen = _recorder({"entities": []})
    client = NlpClient("http://nlp.test", transport=transport)

    await client.classify_tokens("chest pain", tenant_id=TENANT)

    assert seen["x-tenant-id"] == TENANT


@pytest.mark.asyncio
async def test_nlp_classify_tokens_rejects_a_blank_tenant_at_the_caller():
    transport, seen = _recorder({"entities": []})
    client = NlpClient("http://nlp.test", transport=transport)

    with pytest.raises(ValueError, match="tenant_id"):
        await client.classify_tokens("chest pain", tenant_id="")

    assert seen == {}


@pytest.mark.asyncio
async def test_nlp_tenant_header_is_sent_even_without_a_service_token():
    """The two headers are independent: dev-bypass auth must not drop the tenant."""
    transport, seen = _recorder({"entities": []})
    client = NlpClient("http://nlp.test", transport=transport, service_token="")

    await client.classify_tokens("chest pain", tenant_id=TENANT)

    assert seen["x-tenant-id"] == TENANT
    assert "x-service-token" not in seen
