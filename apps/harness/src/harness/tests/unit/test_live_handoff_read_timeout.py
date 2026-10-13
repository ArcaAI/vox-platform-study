"""The live-handoff read's timeout matches the gateway's bounded-answer contract.

The gateway answers ``GET …/live-handoff`` within a bound well below 30 s (``ended: false`` with
``pendingReason: NOTE_PLAN_COMPOSING`` while the note plan composes). The read used the client's
shared 30 s timeout, equal to the ``interpreter.load_live_outputs`` activity's 30 s
start-to-close, so a slow answer raced Temporal's own timeout instead of surfacing as the
activity's logged ``ended=False``. The read now carries its own timeout, between the two.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from harness.services.api_client import LIVE_HANDOFF_READ_TIMEOUT_S, ApiClient
from harness.temporal.interpreter import workflow as interpreter_workflow
from harness.temporal.interpreter.models import LiveOutputsResult

#: The gateway's bound (``LIVE_HANDOFF_NOTE_PLAN_WAIT_MS`` in live-documentation.service.ts).
_GATEWAY_BOUND_S = 10.0


def test_read_timeout_sits_between_the_gateway_bound_and_the_activity_timeout() -> None:
    activity_s = interpreter_workflow._LIVE_OUTPUTS_TIMEOUT.total_seconds()
    assert _GATEWAY_BOUND_S < LIVE_HANDOFF_READ_TIMEOUT_S < activity_s


async def test_live_handoff_request_carries_its_own_timeout() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["timeout"] = request.extensions.get("timeout")
        seen["params"] = dict(request.url.params)
        return httpx.Response(
            200,
            json={
                "ended": False,
                "outputs": {},
                "context": {},
                "pendingReason": "NOTE_PLAN_COMPOSING",
            },
        )

    client = ApiClient(
        "http://api.test/api/v1",
        service_token="t",
        timeout=30.0,
        transport=httpx.MockTransport(handler),
    )
    raw = await client.live_handoff(
        "c-1", tenant_id="tenant-1", run_id="run-1", node_ids=["n_summary"]
    )

    assert seen["timeout"]["read"] == pytest.approx(LIVE_HANDOFF_READ_TIMEOUT_S)
    assert seen["params"] == {"tenantId": "tenant-1", "runId": "run-1", "nodeIds": "n_summary"}
    # The declared pending answer parses as "not ended yet" — the poll asks again.
    assert LiveOutputsResult.model_validate(raw).ended is False


async def test_a_shorter_client_timeout_is_never_lengthened() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["timeout"] = request.extensions.get("timeout")
        return httpx.Response(200, json={"ended": True, "outputs": {}, "context": {}})

    client = ApiClient(
        "http://api.test/api/v1",
        service_token="t",
        timeout=5.0,
        transport=httpx.MockTransport(handler),
    )
    await client.live_handoff("c-1", tenant_id="tenant-1", run_id="run-1", node_ids=[])

    assert seen["timeout"]["read"] == pytest.approx(5.0)
