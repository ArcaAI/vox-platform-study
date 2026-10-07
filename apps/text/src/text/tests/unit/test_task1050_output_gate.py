"""TASK-1050 W2c — the outbound gate enforces guardrail's decision, and degrades on an outage.

* ``warn`` / ``unverified``: the completion is released; notices + evaluation id collected;
* ``block``: :class:`OutputRejectedError` as before, now carrying the notice, so the 422
  body (``as_text_error``) and the stream's terminal frame both have it;
* an OUTAGE: a ``guardrail.unverified`` notice, and the completion is released.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from text.core.exceptions import ContentBlockedError
from text.services import guardrail_notices as gn
from text.services.external_guardrail import GUARDRAIL_UNAVAILABLE_REASON
from text.services.output_gate import OutputRejectedError, gate_completion


@pytest.fixture(autouse=True)
def _no_correlation():
    token = gn.bind_guardrail_correlation({})
    yield
    gn.reset_guardrail_correlation(token)


def _client(verdict: dict[str, Any]) -> MagicMock:
    client = MagicMock()
    client.screen_output = AsyncMock(return_value=verdict)
    return client


async def _gate(client: Any, outcome: gn.GuardrailOutcome | None, *, locality: str = "cloud"):
    return await gate_completion(
        client,
        completion="The note.",
        source_regions=[{"key": "transcript", "text": "x"}],
        tenant_id="t",
        tenant_policy=None,
        app_state=None,
        where="test",
        locality=locality,
        outcome=outcome,
    )


async def test_an_outbound_outage_degrades_to_unverified_and_releases() -> None:
    outcome = gn.GuardrailOutcome()
    client = _client({"allowed": False, "reason": GUARDRAIL_UNAVAILABLE_REASON, "error": "x"})

    await _gate(client, outcome)

    (notice,) = outcome.notices
    assert notice["type"] == "guardrail.unverified"
    assert notice["direction"] == "outbound"
    assert [c["checkId"] for c in notice["checks"]] == list(gn.OUTBOUND_SCREEN_CHECKS)


async def test_an_outage_with_no_outcome_to_collect_into_still_releases() -> None:
    client = _client({"allowed": False, "reason": GUARDRAIL_UNAVAILABLE_REASON})

    assert await _gate(client, None) is None


async def test_warn_releases_and_collects_the_notice_and_the_evaluation_id() -> None:
    outcome = gn.GuardrailOutcome()
    warning = {
        **gn.unverified_notice("outbound", ["response_toxicity"]),
        "type": "guardrail.warning",
        "messageKey": "guardrail.warning.generic",
        "defaultMessage": gn.DEFAULT_MESSAGES["guardrail.warning.generic"],
    }
    client = _client(
        {"allowed": True, "decision": "warn", "notices": [warning], "evaluation_id": "ev-out"}
    )

    await _gate(client, outcome)

    assert outcome.notices == [warning]
    assert outcome.evaluation_ids == ["ev-out"]
    assert client.screen_output.await_args.kwargs["locality"] == "cloud"


async def test_a_block_carries_guardrails_notice_to_the_422_body_and_the_frame() -> None:
    outcome = gn.GuardrailOutcome()
    outcome.add_evaluation_id("ev-in")
    blocked = gn.blocked_notice(
        "outbound",
        "guardrail.blocked.outbound",
        [{"checkId": "response_safety", "severity": "high"}],
    )
    client = _client(
        {
            "allowed": False,
            "decision": "block",
            "reason": "response_safety",
            "notices": [blocked],
            "evaluation_id": "ev-out",
            "raw": {"decision": "block", "reasons": ["response_safety"]},
        }
    )

    with pytest.raises(OutputRejectedError) as raised:
        await _gate(client, outcome)

    rejected = raised.value
    assert rejected.guardrail_notice == blocked
    error = rejected.as_text_error()
    assert isinstance(error, ContentBlockedError)
    assert error.error_code == "CONTENT_BLOCKED"
    assert error.extra_body["guardrailNotice"] == blocked
    assert error.extra_body["guardrailEvaluationIds"] == ["ev-in", "ev-out"]
    frame = rejected.terminal_data(usage={})
    assert frame["guardrail_notice"] == blocked
    assert frame["code"] == "GUARDRAIL_REJECTED"


async def test_a_block_without_a_notice_gets_one_naming_the_blocking_checks() -> None:
    client = _client(
        {
            "allowed": False,
            "decision": "block",
            "reason": "response_refusal",
            "raw": {"decision": "block", "reasons": ["response_refusal"]},
        }
    )

    with pytest.raises(OutputRejectedError) as raised:
        await _gate(client, gn.GuardrailOutcome())

    notice = raised.value.guardrail_notice
    assert gn.valid_notices([notice]) == [notice]
    assert notice["messageKey"] == "guardrail.blocked.outbound"
    assert notice["checks"] == [{"checkId": "response_refusal", "severity": "high"}]


async def test_a_cloud_pii_leak_block_keeps_its_code_and_names_the_check() -> None:
    client = _client(
        {
            "allowed": False,
            "decision": "block",
            "reason": "pii_leak",
            "raw": {"decision": "block", "reasons": ["pii_leak"]},
        }
    )

    with pytest.raises(OutputRejectedError) as raised:
        await _gate(client, gn.GuardrailOutcome())

    error = raised.value.as_text_error()
    assert error.error_code == "PII_LEAK_BLOCKED"
    assert error.extra_body["guardrailNotice"]["checks"] == [
        {"checkId": "pii_leak", "severity": "high"}
    ]


# ── Q3 (orchestrator): a malformed verdict degrades like an outage ───────────


async def test_a_malformed_outbound_verdict_degrades_to_unverified_and_releases() -> None:
    outcome = gn.GuardrailOutcome()
    client = _client({"allowed": False, "reason": "malformed_verdict", "raw": {"decision": "?"}})

    assert await _gate(client, outcome) is None

    (notice,) = outcome.notices
    assert notice["type"] == "guardrail.unverified"
    assert notice["direction"] == "outbound"
