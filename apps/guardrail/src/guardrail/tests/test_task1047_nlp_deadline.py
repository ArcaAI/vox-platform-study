"""TASK-1047 L5 — D7: a deadline on every guardrail → apps/nlp call, and no amplification.

C6 was a 60 s timeout × 2 attempts while the abandoned inference kept running in
`apps/nlp`: every timeout DOUBLED the load on the peer that was already too slow.

* The call carries a DEADLINE (`nlpDeadlineSeconds`, default 30 s) covering every
  attempt, not a per-attempt timeout that a retry can extend.
* It is retried ONLY when the request provably never left — a connect-phase error.
  Once an attempt may still be running in the peer (read timeout, deadline, any
  answered status), it is never retried. The breaker is unchanged.
"""

from __future__ import annotations

import asyncio
import time

import httpx
import pytest

from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.services.external_nlp_client import NlpGuardClient


def _client(http_client: httpx.AsyncClient, *, deadline_s: float = 30.0) -> NlpGuardClient:
    return NlpGuardClient(
        base_url="http://nlp",
        service_token="svc",
        http_client=http_client,
        tenant_id="tenant-a",
        model_id="m",
        labels=["person"],
        timeout_s=deadline_s,
        max_attempts=2,
        retry_backoff_s=0.0,
    )


async def test_a_slow_attempt_is_cut_at_the_deadline_and_never_retried() -> None:
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        await asyncio.sleep(5)
        return httpx.Response(200, json={"entities": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        started = time.monotonic()
        with pytest.raises(GuardrailUndeterminedError):
            await _client(http_client, deadline_s=0.2).extract_pii_entities("John Doe")
        elapsed = time.monotonic() - started

    assert calls == 1, "an attempt that may still be running must never be retried"
    assert elapsed < 1.0, "the deadline bounds the whole call"


async def test_a_read_timeout_is_not_retried() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("peer still computing", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        with pytest.raises(GuardrailUndeterminedError):
            await _client(http_client).extract_pii_entities("John Doe")
    assert calls == 1


async def test_an_answered_server_error_is_not_retried() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        with pytest.raises(GuardrailUndeterminedError):
            await _client(http_client).classify({"prompt_safety": {"labels": ["a"]}}, "hi")
    assert calls == 1


async def test_a_connect_error_before_the_request_left_is_retried() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ConnectError("connection refused", request=request)
        return httpx.Response(200, json={"entities": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        assert await _client(http_client).extract_pii_entities("hello") == []
    assert calls == 2


def test_the_nlp_client_is_built_with_the_policy_deadline() -> None:
    from types import SimpleNamespace

    from guardrail.core.config import Settings
    from guardrail.core.dependencies import _nlp_client

    app_state = SimpleNamespace(settings=Settings(), http_client=object(), circuit_breakers={})
    cfg = SimpleNamespace(model="m", timeout_s=None, entailment=None)

    client = _nlp_client(app_state, "tenant-a", cfg, deadline_s=12.0)
    assert client._timeout_s == 12.0

    # A row's own (longer) timeout can never extend the deadline past the policy.
    cfg_long = SimpleNamespace(model="m", timeout_s=60, entailment=None)
    assert _nlp_client(app_state, "tenant-a", cfg_long, deadline_s=12.0)._timeout_s == 12.0
    cfg_short = SimpleNamespace(model="m", timeout_s=5, entailment=None)
    assert _nlp_client(app_state, "tenant-a", cfg_short, deadline_s=12.0)._timeout_s == 5.0
