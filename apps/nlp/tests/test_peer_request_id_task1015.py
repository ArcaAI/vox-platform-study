"""E5 (nlp) — the text peer client forwards the bound X-Request-Id; failures are structured."""

from __future__ import annotations

import asyncio

import httpx
import pytest
from hope_obs import bind_request_context, clear_request_context
from structlog.testing import capture_logs

from nlp.core.config import ExternalTextConfig
from nlp.services.external_text_client import ExternalTextClient, ExternalTextUnavailableError


def _client(handler) -> ExternalTextClient:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return ExternalTextClient(
        settings=ExternalTextConfig(base_url="http://text", max_retries=0), http_client=http
    )


def test_request_id_header_is_forwarded() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        return httpx.Response(200, json={"content": "label"})

    bind_request_context(requestId="rid-nlp-1")
    try:
        asyncio.run(
            _client(handler).generate_label("p", tenant_id="t-1", provider="lm-studio", model="m-1")
        )
    finally:
        clear_request_context()

    assert seen["x-request-id"] == "rid-nlp-1"
    assert seen["x-tenant-id"] == "t-1"


def test_failure_is_structured_chained_and_message_free() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("secret-host-detail")

    with capture_logs() as logs:
        with pytest.raises(ExternalTextUnavailableError) as info:
            asyncio.run(
                _client(handler).generate_label(
                    "p", tenant_id="t-1", provider="lm-studio", model="m-1"
                )
            )

    assert isinstance(info.value.__cause__, httpx.ConnectError)
    events = {entry["event"]: entry for entry in logs}
    assert events["nlp.external_text.attempt_failed"]["error_type"] == "ConnectError"
    assert events["nlp.external_text.exhausted"]["error_type"] == "ConnectError"
    assert "secret-host-detail" not in str(logs)
