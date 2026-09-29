"""E5 (guardrail) — the nlp peer client forwards the bound X-Request-Id."""

from __future__ import annotations

import httpx
from hope_obs import bind_request_context, clear_request_context

from guardrail.services.external_nlp_client import NlpGuardClient


def test_headers_carry_request_id() -> None:
    client = NlpGuardClient(
        base_url="http://nlp",
        service_token="tok",
        http_client=httpx.AsyncClient(),
        tenant_id="t-1",
    )
    bind_request_context(requestId="rid-g-1")
    try:
        headers = client._headers()
    finally:
        clear_request_context()

    assert headers["X-Request-Id"] == "rid-g-1"
    assert headers["X-Tenant-Id"] == "t-1"
