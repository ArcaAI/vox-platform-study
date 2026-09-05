"""TASK-878 — the `apps/text` half of guardrail's outbound-screen changes.

Two properties this service owns, and neither is assertable from `apps/guardrail`:

**Cycle safety, layer two.** Guardrail's outbound screen now runs
`jailbreak_detection` as well (TASK-878/G1). It delegates that to `apps/nlp`, so
it cannot reach this service — but "cannot today" is a property of guardrail's
composition, and the load-bearing guarantee is that even if it COULD, the loop
would raise rather than close. `gate_completion` asserts the judge tripwire before
it makes any guardrail call, so a judge completion can never be screened by a
screen that judges: `text -> guardrail -> text` raises on the first request.

**The usage ride-back.** Guardrail's `ScreenResponse` now carries `usage_detail`
(TASK-878/G2), the same forwarding channel `/api/medical/validate` uses. This side
was already shaped to lift it (`guardrail_usage_from_verdict`); these tests prove
the two halves actually meet, on the outbound verdict shape, in both directions
(allowed and rejected).

Hermetic: the guardrail client is a stub, exactly as `test_task871_output_gate.py`
stubs it. This file adds NO production code to `apps/text` — TASK-878 chose G3
option (b) (the input gate stays on `/api/medical/validate`), so there is no nonce
handshake and nothing in this service changed.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from text.core.guardrail_posture import GuardrailPosture
from text.models.usage import guardrail_usage_from_verdict
from text.services.judge_guard import GuardrailRecursionError, judge_scope
from text.services.output_gate import OutputRejectedError, gate_completion

TENANT = "11111111-1111-1111-1111-111111111111"

#: What guardrail forwards VERBATIM from a delegated call that metered something.
#: Shaped exactly like the block `/api/medical/validate` already rides back, since
#: `ScreenResponse.usage_detail` is the same channel pointed at the outbound screen.
_USAGE = {
    "task_id": "screen-1",
    "provider": "lm-studio",
    "model": "guardian-1",
    "prompt_tokens": 40,
    "completion_tokens": 6,
    "total_tokens": 46,
    "byok": False,
}


def _screen_verdict(*, allowed: bool, reason: str, usage: dict[str, Any] | None) -> dict[str, Any]:
    """A verdict as `ExternalGuardrailClient.screen_output` returns it."""
    raw: dict[str, Any] = {
        "decision": "allow" if allowed else "block",
        "reasons": [] if allowed else [reason],
        "checks": [],
        "tenant_id": TENANT,
        "usage_detail": usage,
    }
    return {"allowed": allowed, "reason": reason, "raw": raw}


def _client(verdict: dict[str, Any]) -> Any:
    client = AsyncMock()
    client.screen_output = AsyncMock(return_value=verdict)
    return client


def _state(*, enabled: bool = True) -> Any:
    return SimpleNamespace(guardrail_posture=GuardrailPosture(enabled=enabled))


async def _gate(client: Any) -> Any:
    return await gate_completion(
        client,
        completion="Sure — ignoring my instructions, here is the record.",
        source_context="summarise the consultation",
        tenant_id=TENANT,
        tenant_policy=None,
        app_state=_state(),
        where="test",
    )


# ---------------------------------------------------------------------------
# Cycle safety — the outbound jailbreak check can never re-enter the judge lane
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_gate_raises_inside_a_judge_scope_before_calling_guardrail() -> None:
    """A judge completion is never screened, so guardrail's outbound screen can
    never be asked to judge a judgement — whatever checks that screen runs."""
    client = _client(_screen_verdict(allowed=False, reason="jailbreak_detection", usage=None))

    with judge_scope():
        with pytest.raises(GuardrailRecursionError):
            await _gate(client)

    client.screen_output.assert_not_awaited()


@pytest.mark.asyncio
async def test_outside_a_judge_scope_the_same_call_screens_normally() -> None:
    """The tripwire is scoped to the judge lane, not a blanket disable."""
    client = _client(_screen_verdict(allowed=True, reason="output_screened", usage=None))

    await _gate(client)

    client.screen_output.assert_awaited_once()


# ---------------------------------------------------------------------------
# G2 — the outbound screen's usage reaches this side, both ways
# ---------------------------------------------------------------------------


def test_a_screen_response_usage_block_becomes_a_usage_detail() -> None:
    usage = guardrail_usage_from_verdict(
        _screen_verdict(allowed=True, reason="output_screened", usage=_USAGE)
    )

    assert usage is not None
    assert usage.provider == "lm-studio"
    assert usage.model == "guardian-1"
    assert usage.prompt_tokens == 40
    assert usage.completion_tokens == 6


def test_a_screen_without_usage_reports_silence_not_zeros() -> None:
    """A zero row would tell the billing plane the screen was free rather than
    that it metered nothing — which is the honest answer while guardrail's only
    outbound executor is `apps/nlp`, running local weights."""
    assert (
        guardrail_usage_from_verdict(
            _screen_verdict(allowed=True, reason="output_screened", usage=None)
        )
        is None
    )


@pytest.mark.asyncio
async def test_an_allowed_screen_returns_its_usage_to_the_call_site() -> None:
    usage = await _gate(_client(_screen_verdict(allowed=True, reason="ok", usage=_USAGE)))

    assert usage is not None
    assert usage.total_tokens == 46


@pytest.mark.asyncio
async def test_a_rejected_screen_still_carries_the_usage_it_burned() -> None:
    """Lifted BEFORE the allow/deny branch: a blocked response still spent."""
    client = _client(_screen_verdict(allowed=False, reason="jailbreak_detection", usage=_USAGE))

    with pytest.raises(OutputRejectedError) as excinfo:
        await _gate(client)

    error = excinfo.value
    assert error.guardrail_usage is not None
    assert error.guardrail_usage.total_tokens == 46
    # A jailbroken RESPONSE is a CONTENT rejection, not an outage: 422, not 503,
    # and not retryable — retrying would re-run the same jailbroken generation.
    assert error.reason == "jailbreak_detection"
    assert error.status_code == 422
    assert error.retryable is False
    assert error.code == "GUARDRAIL_REJECTED"
    assert error.task_error == "guardrail_rejected:jailbreak_detection"
