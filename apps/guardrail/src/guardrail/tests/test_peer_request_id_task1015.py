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


def test_text_judge_headers_carry_request_id() -> None:
    from guardrail.services.external_text_client import TextJudgeClient

    client = TextJudgeClient(
        base_url="http://text",
        http_client=httpx.AsyncClient(),
        service_token="tok",
        provider="lm-studio",
        model="m-1",
        tenant_id="t-1",
        criteria="c",
        temperature=0.0,
        max_tokens=8,
        timeout_s=1.0,
    )
    bind_request_context(requestId="rid-g-2")
    try:
        headers = client._headers()
    finally:
        clear_request_context()

    assert headers["X-Request-Id"] == "rid-g-2"
    assert headers["X-Tenant-Id"] == "t-1"
