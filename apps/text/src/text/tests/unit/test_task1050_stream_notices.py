"""TASK-1050 W2c — a streamed generation emits ``guardrail.notice`` events as notices are known.

* the inbound gate's notices before the first delta;
* each outbound window's notice right after that window was screened;
* a block's notice BEFORE its terminal ``error`` frame;
* the terminal frame (``done`` or ``error``) carries ``guardrail_notices`` and
  ``guardrail_evaluation_ids``, whatever the outcome;
* an outbound outage releases the window (``guardrail.unverified``), never an error.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock

import pytest

from text.models.requests import GenerateRequest
from text.models.stream import StreamChunk
from text.services import guardrail_notices as gn
from text.services.egress import prepare_egress
from text.services.external_guardrail import GUARDRAIL_UNAVAILABLE_REASON

_PROVIDER = "lm-studio"


@pytest.fixture(autouse=True)
def _no_correlation():
    token = gn.bind_guardrail_correlation({})
    yield
    gn.reset_guardrail_correlation(token)


def _task_manager() -> AsyncMock:
    tm = AsyncMock()
    tm.update_task = AsyncMock()
    tm.append_chunk = AsyncMock()
    tm.append_batch = AsyncMock()
    tm.is_cancel_requested = AsyncMock(return_value=False)
    return tm


def _provider(*pieces: str) -> Any:
    async def stream(_request):
        for piece in pieces:
            yield StreamChunk(type="chunk", content=piece)
        yield StreamChunk(type="done", data={"finish_reason": "stop"})

    provider = AsyncMock()
    provider.generate_stream = stream
    return provider


class _Guardrail:
    def __init__(self, verdicts: list[dict[str, Any]]) -> None:
        self.verdicts = verdicts

    async def screen_output(self, response: str, **_: Any) -> dict[str, Any]:
        return self.verdicts.pop(0) if self.verdicts else {"allowed": True, "decision": "allow"}


def _events(tm: AsyncMock) -> list[tuple[str, Any]]:
    """Every event in durable order: deltas/notices from batches, then the terminal."""
    out: list[tuple[str, Any]] = []
    for call in tm.append_batch.await_args_list:
        for event in call.args[1]:
            payload = json.loads(event.payload)
            out.append((payload["type"], payload.get("data") or payload.get("content")))
    for call in tm.append_chunk.await_args_list:
        chunk = call.args[1]
        out.append((chunk.type, chunk.data))
    return out


def _warning(direction: str) -> dict[str, Any]:
    return {
        **gn.unverified_notice(direction, ["response_toxicity"]),
        "type": "guardrail.warning",
        "messageKey": "guardrail.warning.generic",
        "defaultMessage": gn.DEFAULT_MESSAGES["guardrail.warning.generic"],
    }


async def _run(tm: AsyncMock, provider: Any, guardrail: Any, outcome: gn.GuardrailOutcome) -> None:
    from text.api.endpoints.generate import _run_streaming_generation

    request = GenerateRequest(prompt="Write a note.", provider=_PROVIDER, model="m", stream=True)
    egress = prepare_egress(request, spans_by_segment=None, outcome=outcome)
    await _run_streaming_generation(
        tm,
        provider,
        "g-1",
        egress.provider_request,
        provider_name=_PROVIDER,
        model="m",
        tenant_id="t",
        guardrail_client=guardrail,
        egress=egress,
    )


async def test_inbound_then_outbound_notices_are_events_and_ride_on_the_done_frame() -> None:
    tm = _task_manager()
    inbound = gn.GuardrailOutcome()
    inbound_warning = _warning("inbound")
    inbound.add_notice(inbound_warning)
    inbound.add_evaluation_id("ev-in")
    outbound_warning = _warning("outbound")
    guardrail = _Guardrail(
        [
            {
                "allowed": True,
                "decision": "warn",
                "notices": [outbound_warning],
                "evaluation_id": "ev-w1",
            },
            {"allowed": True, "decision": "allow", "evaluation_id": "ev-w2"},
        ]
    )

    await _run(tm, _provider("First sentence. ", "Second sentence."), guardrail, inbound)

    events = _events(tm)
    kinds = [kind for kind, _ in events]
    assert kinds[0] == "guardrail.notice" and events[0][1] == inbound_warning
    second_notice = kinds.index("guardrail.notice", 1)
    assert events[second_notice][1] == outbound_warning
    assert second_notice < kinds.index("chunk")  # known before the window was released
    assert kinds[-1] == "done"
    done = events[-1][1]
    assert done["guardrail_notices"] == [inbound_warning, outbound_warning]
    assert done["guardrail_evaluation_ids"] == ["ev-in", "ev-w1", "ev-w2"]
    assert kinds.count("guardrail.notice") == 2


async def test_a_blocked_window_emits_its_notice_before_the_error_frame() -> None:
    tm = _task_manager()
    blocked = gn.blocked_notice(
        "outbound",
        "guardrail.blocked.outbound",
        [{"checkId": "response_safety", "severity": "high"}],
    )
    guardrail = _Guardrail(
        [
            {
                "allowed": False,
                "decision": "block",
                "reason": "response_safety",
                "notices": [blocked],
                "evaluation_id": "ev-b",
                "raw": {"decision": "block", "reasons": ["response_safety"]},
            }
        ]
    )

    await _run(tm, _provider("Bad sentence. ", "More."), guardrail, gn.GuardrailOutcome())

    events = _events(tm)
    kinds = [kind for kind, _ in events]
    assert "chunk" not in kinds
    assert kinds[-2:] == ["guardrail.notice", "error"]
    assert events[-2][1] == blocked
    error = events[-1][1]
    assert error["code"] == "GUARDRAIL_REJECTED"
    assert error["guardrail_notice"] == blocked
    assert error["guardrail_notices"] == [blocked]
    assert error["guardrail_evaluation_ids"] == ["ev-b"]


async def test_an_outbound_outage_releases_the_window_with_an_unverified_notice() -> None:
    tm = _task_manager()
    guardrail = _Guardrail([{"allowed": False, "reason": GUARDRAIL_UNAVAILABLE_REASON}])

    await _run(tm, _provider("Only sentence."), guardrail, gn.GuardrailOutcome())

    events = _events(tm)
    kinds = [kind for kind, _ in events]
    assert kinds == ["guardrail.notice", "chunk", "done"]
    assert events[0][1]["type"] == "guardrail.unverified"
    assert events[1][1] == "Only sentence."
