"""TASK-1036 OD-1 — the egress guardrails scope to the CONTEXT and the response.

The inbound PII/safety screen and the medical-relevance judge inspect only the
``EXTERNAL_DATA`` block bodies of a composed request (or the user message of a request
without blocks) — never the platform rules, the agent instruction, the language step or
the output contract. The output screen still inspects the whole response, with the data
blocks as the ``pii_leak`` source.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from text.models.requests import GenerateRequest
from text.services.data_blocks import context_text, external_data_blocks
from text.services.egress import prepare_egress, run_inbound_gate

_SYSTEM = "Rules. Contact the clinic at jane.rules@example.org. Write the note in English."
_BLOCK = (
    '<<<EXTERNAL_DATA section="transcript">>>\n'
    "--- Consultation transcript ---\n"
    "Patient John Doe reports a cough.\n"
    "<<<END_EXTERNAL_DATA>>>"
)
_BLOCK2 = (
    '<<<EXTERNAL_DATA section="history">>>\n'
    "--- History ---\n"
    "MRN-0042, asthma.\n"
    "<<<END_EXTERNAL_DATA>>>"
)
_USER = f"{_BLOCK}\n\n{_BLOCK2}"


def _client(spans: list[dict[str, Any]] | None = None) -> AsyncMock:
    client = AsyncMock()
    client.validate = AsyncMock(return_value={"allowed": True, "is_medical": True})
    client.screen_inbound = AsyncMock(return_value={"allowed": True, "pii_spans": spans or []})
    return client


def test_block_bodies_are_located() -> None:
    bodies = [_USER[b.start : b.end] for b in external_data_blocks(_USER)]
    assert bodies == [
        "--- Consultation transcript ---\nPatient John Doe reports a cough.",
        "--- History ---\nMRN-0042, asthma.",
    ]
    assert context_text("no blocks here") == "no blocks here"


@pytest.mark.asyncio
async def test_system_prompt_with_pii_like_text_is_not_screened() -> None:
    client = _client()

    await run_inbound_gate(
        client, segments=[_SYSTEM, _USER], prompt=_USER, system_prompt=_SYSTEM, tenant_id="t"
    )

    screened = client.screen_inbound.await_args.args[0]
    assert "jane.rules@example.org" not in screened
    assert "Rules." not in screened
    assert "John Doe" in screened and "MRN-0042" in screened
    judged = client.validate.await_args.kwargs
    assert judged["system_prompt"] is None
    assert "jane.rules@example.org" not in judged["prompt"]
    assert "John Doe" in judged["prompt"]
    assert "<<<EXTERNAL_DATA" not in judged["prompt"]


@pytest.mark.asyncio
async def test_the_same_text_inside_a_data_block_is_screened() -> None:
    client = _client()
    block = (
        '<<<EXTERNAL_DATA section="transcript">>>\n--- T ---\n'
        "Email jane.rules@example.org\n<<<END_EXTERNAL_DATA>>>"
    )

    await run_inbound_gate(
        client, segments=["Rules."], prompt=block, system_prompt="Rules.", tenant_id="t"
    )
    client.screen_inbound.reset_mock()
    await run_inbound_gate(
        client, segments=["Rules.", block], prompt=block, system_prompt="Rules.", tenant_id="t"
    )

    assert "jane.rules@example.org" in client.screen_inbound.await_args.args[0]


@pytest.mark.asyncio
async def test_a_request_without_blocks_screens_the_user_message_only() -> None:
    client = _client()

    await run_inbound_gate(
        client,
        segments=["Mail jane.rules@example.org", "Hello Dr Smith"],
        prompt="Hello Dr Smith",
        system_prompt="Mail jane.rules@example.org",
        tenant_id="t",
    )

    assert client.screen_inbound.await_args.args[0] == "Hello Dr Smith"
    assert client.validate.await_args.kwargs["prompt"] == "Hello Dr Smith"
    assert client.validate.await_args.kwargs["system_prompt"] is None


@pytest.mark.asyncio
async def test_spans_are_rebased_to_the_segment_they_fell_in() -> None:
    # The screened text is the two block bodies joined by a blank line.
    first = "--- Consultation transcript ---\nPatient John Doe reports a cough."
    second = "--- History ---\nMRN-0042, asthma."
    screened = f"{first}\n\n{second}"
    start = screened.index("MRN-0042")
    client = _client([{"label": "mrn", "start": start, "end": start + 8}])

    result = await run_inbound_gate(
        client, segments=[_SYSTEM, _USER], prompt=_USER, system_prompt=_SYSTEM, tenant_id="t"
    )

    assert result.spans_by_segment[0] == []
    (span,) = result.spans_by_segment[1]
    assert _USER[span.start : span.end] == "MRN-0042"


def test_cloud_redaction_inside_data_blocks_is_unchanged_and_restores() -> None:
    from text.services.egress import PLATFORM_TOKEN_SENTENCE
    from text.services.pseudonymizer import Span

    request = GenerateRequest(
        prompt=_USER,
        system_prompt=_SYSTEM,
        provider="azure",
        model="m",
        provider_locality={"azure": "cloud"},
        known_phi=[{"label": "patient_name", "value": "John Doe"}],  # type: ignore[list-item]
    )
    start = _USER.index("MRN-0042")
    spans = [[], [Span("mrn", start, start + 8)]]

    egress = prepare_egress(request, spans_by_segment=spans)

    sent = egress.provider_request
    assert "John Doe" not in sent.prompt and "MRN-0042" not in sent.prompt
    assert "[PATIENT_NAME_1]" in sent.prompt and "[MRN_1]" in sent.prompt
    assert sent.prompt.count("<<<EXTERNAL_DATA") == 2  # the wrapper survives intact
    assert PLATFORM_TOKEN_SENTENCE in sent.system_prompt
    # pii_leak is judged against the data blocks the provider was given, not the rules.
    assert "[MRN_1]" in egress.source_context
    assert "jane.rules@example.org" not in egress.source_context
    assert "<<<EXTERNAL_DATA" not in egress.source_context
    assert egress.restore("[PATIENT_NAME_1] has [MRN_1]") == "John Doe has MRN-0042"
