"""TASK-890 §3.14 (OD-R) — the durable lane carries the guardrail decision to TEXT.

The gateway folds `node > workflow > agent > on` and pushes the answer as
`guardrail_policy.enabled`. The harness calls TEXT DIRECTLY (there is no gateway on that hop), so
without this kwarg the durable lane could only ever run on the platform posture while the realtime
lane honoured the tenant's opt-out — the two lanes execute the SAME node, and a divergence there is
a safety difference, not a formatting one.

The client is a pass-through by design: it does not fold the precedence itself (that is
`guardrail_optout.resolve_guardrail_decision`, held to the cross-language fixture) and it never
invents an opinion. Absent kwarg ⇒ absent key ⇒ the platform posture governs.
"""

from __future__ import annotations

import json

import httpx
import pytest

from harness.services.text_client import TextClient

TENANT = "11111111-1111-1111-1111-111111111111"


def _capture():
    seen: dict[str, httpx.Request] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["request"] = request
        return httpx.Response(
            200,
            json={
                "task_id": "t-1",
                "status": "completed",
                "content": "ok",
                "provider": "azure-openai",
                "model": "gpt-4o",
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                "latency_ms": 1,
                "finish_reason": "stop",
            },
        )

    return seen, handler


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled", [False, True])
async def test_the_pushed_decision_lands_in_the_body_verbatim(enabled: bool):
    seen, handler = _capture()
    client = TextClient("http://text:8862", transport=httpx.MockTransport(handler))

    await client.generate(
        tenant_id=TENANT,
        prompt="Summarize the consult.",
        guardrail_policy={"enabled": enabled},
    )

    body = json.loads(seen["request"].content)
    # Explicit BOTH ways: TEXT must be able to tell "screened by decision" from "no opinion".
    assert body["guardrail_policy"] == {"enabled": enabled}


@pytest.mark.asyncio
async def test_no_kwarg_means_no_key_at_all():
    seen, handler = _capture()
    client = TextClient("http://text:8862", transport=httpx.MockTransport(handler))

    await client.generate(tenant_id=TENANT, prompt="Summarize the consult.")

    assert "guardrail_policy" not in json.loads(seen["request"].content)


@pytest.mark.asyncio
async def test_the_client_never_folds_or_invents_a_decision():
    # A caller may push the other posture fields through the same block; the client passes the
    # dict through untouched rather than normalising it into a shape TEXT did not ask for.
    seen, handler = _capture()
    client = TextClient("http://text:8862", transport=httpx.MockTransport(handler))

    await client.generate(
        tenant_id=TENANT,
        prompt="p",
        guardrail_policy={"enabled": False, "require_medical": False},
    )

    assert json.loads(seen["request"].content)["guardrail_policy"] == {
        "enabled": False,
        "require_medical": False,
    }
