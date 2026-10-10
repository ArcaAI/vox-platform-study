"""TASK-1059 (owner OD-2 / OD-5 / OD-10) — text no longer runs a RUNTIME medical judge.

Prompts are judged for medical scope at build time, and the runtime CONTEXT is judged by the
gateway before it is composed with the prompt. So the inbound gate never calls guardrail's
``/api/medical/validate`` any more — whatever that call would have answered — while the inbound
SCREEN (injection / toxicity / PII spans) runs exactly as before.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from text.core.exceptions import ContentBlockedError
from text.services import guardrail_notices as gn
from text.services.egress import run_inbound_gate

_TRANSCRIPT = (
    '<<<EXTERNAL_DATA section="transcript">>>\n'
    "--- Consultation transcript ---\n"
    "Patient reports a cough.\n"
    "<<<END_EXTERNAL_DATA>>>"
)
_SEGMENTS = ["", f"Summarise.\n\n{_TRANSCRIPT}"]
_ALLOW = {"allowed": True, "decision": "allow", "reason": "input_screened", "pii_spans": []}
_NOT_MEDICAL = {"allowed": False, "decision": "block", "is_medical": False, "reason": "no"}


@pytest.fixture(autouse=True)
def _no_correlation():
    token = gn.bind_guardrail_correlation({})
    yield
    gn.reset_guardrail_correlation(token)


def _client(screen: dict[str, Any]) -> MagicMock:
    client = MagicMock()
    client.screen_inbound = AsyncMock(return_value=screen)
    # Would block as "not medical" if it were ever asked.
    client.validate = AsyncMock(return_value=_NOT_MEDICAL)
    return client


async def _gate(client: Any, **kwargs: Any):
    return await run_inbound_gate(
        client,
        segments=_SEGMENTS,
        prompt="Summarise.",
        system="untrusted",
        tenant_id="t",
        locality=kwargs.pop("locality", "local"),
        **kwargs,
    )


async def test_the_inbound_gate_never_asks_the_medical_judge() -> None:
    client = _client(_ALLOW)

    result = await _gate(client)

    client.validate.assert_not_awaited()
    client.screen_inbound.assert_awaited_once()
    assert result.outcome.notices == []


async def test_the_screen_still_gets_every_untrusted_region_with_its_trust() -> None:
    client = _client(_ALLOW)

    await _gate(client, locality="cloud")

    kwargs = client.screen_inbound.await_args.kwargs
    assert {r["key"]: r["trust"] for r in kwargs["regions"]} == {
        "user": "instruction",
        "transcript": "data",
    }
    assert kwargs["include_pii_spans"] is True
    assert kwargs["exempt"] is None


async def test_a_screen_block_still_blocks() -> None:
    client = _client({"allowed": False, "decision": "block", "reasons": ["jailbreak_detection"]})

    with pytest.raises(ContentBlockedError) as raised:
        await _gate(client)

    assert raised.value.error_code != "CONTENT_BLOCKED_NOT_MEDICAL"
    client.validate.assert_not_awaited()
