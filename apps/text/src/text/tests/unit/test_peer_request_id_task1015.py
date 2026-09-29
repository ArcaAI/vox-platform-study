"""E5 (text) — the guardrail peer client forwards the bound X-Request-Id."""

from __future__ import annotations

import httpx
from hope_obs import bind_request_context, clear_request_context

from text.services.external_guardrail import ExternalGuardrailClient


def test_headers_carry_request_id() -> None:
    client = ExternalGuardrailClient(
        base_url="http://guardrail", http_client=httpx.AsyncClient(), service_token="tok"
    )
    bind_request_context(requestId="rid-t-1")
    try:
        headers = client._headers("t-1")
    finally:
        clear_request_context()

    assert headers["X-Request-Id"] == "rid-t-1"
    assert headers["X-Tenant-Id"] == "t-1"
