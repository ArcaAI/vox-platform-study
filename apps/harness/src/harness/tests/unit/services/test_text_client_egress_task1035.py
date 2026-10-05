"""TASK-1035 §5.0 — every harness `/generate` call carries the frozen egress fields.

`apps/text` owns redaction now and fails closed; the harness tells it what it KNOWS (the
deployment-kind locality of the provider it calls, and the identity values it holds) and nothing
it does not. The retired guardrail opt-out (`guardrail_policy`) and `require_medical=false` never
travel (OD-1, OD-5).
"""

from __future__ import annotations

import json
import logging

import httpx
import pytest

from harness.services.text_client import TextClient

TENANT = "11111111-1111-1111-1111-111111111111"


def _capture(extra: dict | None = None):
    seen: dict[str, httpx.Request] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["request"] = request
        body = {
            "task_id": "t-1",
            "status": "completed",
            "content": "ok",
            "provider": "lm-studio",
            "model": "gemma",
            "usage": {},
            "latency_ms": 1,
            "finish_reason": "stop",
        }
        body.update(extra or {})
        return httpx.Response(200, json=body)

    return seen, handler


@pytest.mark.asyncio
async def test_locality_and_known_phi_land_in_the_body() -> None:
    seen, handler = _capture()
    client = TextClient("http://text:8862", transport=httpx.MockTransport(handler))

    await client.generate(
        tenant_id=TENANT,
        prompt="Summarize.",
        provider="lm-studio",
        model="gemma",
        provider_locality={"lm-studio": "local"},
        known_phi=[{"label": "person", "value": "Ada Lovelace"}],
    )

    body = json.loads(seen["request"].content)
    assert body["provider_locality"] == {"lm-studio": "local"}
    assert body["known_phi"] == [{"label": "person", "value": "Ada Lovelace"}]


@pytest.mark.asyncio
async def test_unknown_fields_are_omitted_so_text_decides() -> None:
    seen, handler = _capture()
    client = TextClient("http://text:8862", transport=httpx.MockTransport(handler))

    await client.generate(tenant_id=TENANT, prompt="Summarize.")

    body = json.loads(seen["request"].content)
    assert "provider_locality" not in body
    assert "known_phi" not in body


@pytest.mark.asyncio
async def test_no_opt_out_and_no_medical_exemption_ever_travel() -> None:
    seen, handler = _capture()
    client = TextClient("http://text:8862", transport=httpx.MockTransport(handler))

    await client.generate(tenant_id=TENANT, prompt="Summarize.")

    body = json.loads(seen["request"].content)
    assert "guardrail_policy" not in body
    assert "require_medical" not in json.dumps(body)
    assert "medical_exempt" not in body


def test_the_retired_opt_out_kwarg_is_gone() -> None:
    import inspect

    assert "guardrail_policy" not in inspect.signature(TextClient.generate).parameters


@pytest.mark.asyncio
async def test_the_egress_object_is_parsed_from_the_response() -> None:
    egress = {
        "locality": "cloud",
        "detected": {"person": 1},
        "redacted": 1,
        "restored": 1,
        "images_unredacted": 0,
        "pii_leak_blocked": False,
    }
    _seen, handler = _capture({"egress": egress})
    client = TextClient("http://text:8862", transport=httpx.MockTransport(handler))

    result = await client.generate(tenant_id=TENANT, prompt="Summarize.")

    assert result.egress == egress


@pytest.mark.asyncio
async def test_known_phi_values_are_never_logged(caplog: pytest.LogCaptureFixture) -> None:
    _seen, handler = _capture()
    client = TextClient("http://text:8862", transport=httpx.MockTransport(handler))

    with caplog.at_level(logging.DEBUG):
        await client.generate(
            tenant_id=TENANT,
            prompt="Summarize.",
            known_phi=[{"label": "person", "value": "Zebedee Quintrell"}],
        )

    assert "Zebedee Quintrell" not in caplog.text
