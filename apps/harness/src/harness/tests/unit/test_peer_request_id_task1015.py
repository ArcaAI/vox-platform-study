"""E5 (harness) — peer clients forward the bound X-Request-Id."""

from __future__ import annotations

import asyncio

import httpx
from hope_obs import bind_request_context, clear_request_context

from harness.services.api_client import ApiClient
from harness.services.nlp_client import NlpClient


def test_api_client_headers_carry_request_id() -> None:
    bind_request_context(requestId="rid-h-1")
    try:
        headers = ApiClient("http://api", service_token="tok")._headers()
    finally:
        clear_request_context()
    assert headers["X-Request-Id"] == "rid-h-1"
    assert headers["X-Service-Token"] == "tok"


def test_nlp_client_request_carries_request_id() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        return httpx.Response(200, json={"predicted_label": "x", "confidence": 1.0})

    bind_request_context(requestId="rid-h-2")
    try:
        client = NlpClient("http://nlp", transport=httpx.MockTransport(handler))
        try:
            asyncio.run(client.classify_text("t", tenant_id="t-1", model_name="m"))
        except Exception:  # noqa: BLE001 - only the outbound headers matter here
            pass
    finally:
        clear_request_context()
    assert seen.get("x-request-id") == "rid-h-2"
