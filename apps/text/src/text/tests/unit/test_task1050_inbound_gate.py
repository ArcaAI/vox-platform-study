"""TASK-1050 W2c — the inbound gate enforces guardrail's decision, and degrades on an outage.

README §9.7.1 / §9.8.1:

* ``warn`` / ``unverified`` CONTINUE; their notices and the evaluation ids are collected;
* ``block`` keeps today's 422 ``ContentBlockedError`` (same ``error_code``), and the body
  now carries the ``GuardrailNotice`` and ``type: urn:hope:problem:guardrail-blocked``;
* a guardrail OUTAGE is no longer fail-closed for the moderation verdict: it becomes a
  ``guardrail.unverified`` notice and the generation continues;
* EXCEPT cloud pseudonymisation: without the screen's PII spans a CLOUD call is refused
  with ``EGRESS_REDACTION_UNAVAILABLE`` (a resumable hold) — unredacted text never
  reaches a cloud model;
* F8: a LOCAL call does not ask for PII spans; F3: text TEXT composes into regions
  (``/translate``) is DATA, not instruction.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from text.core.exception_handlers import _get_status_code
from text.core.exceptions import ContentBlockedError, EgressRedactionUnavailableError
from text.services import guardrail_notices as gn
from text.services.egress import TRUST_DATA, run_inbound_gate
from text.services.external_guardrail import GUARDRAIL_UNAVAILABLE_REASON

_TRANSCRIPT = (
    '<<<EXTERNAL_DATA section="transcript">>>\n'
    "--- Consultation transcript ---\n"
    "Patient reports a cough.\n"
    "<<<END_EXTERNAL_DATA>>>"
)
_SEGMENTS = ["", f"Summarise.\n\n{_TRANSCRIPT}"]
_OUTAGE = {"allowed": False, "reason": GUARDRAIL_UNAVAILABLE_REASON, "pii_spans": []}
_ALLOW = {"allowed": True, "decision": "allow", "reason": "input_screened", "pii_spans": []}
_MEDICAL_OK = {"allowed": True, "decision": "allow", "is_medical": True}


@pytest.fixture(autouse=True)
def _no_correlation():
    token = gn.bind_guardrail_correlation({})
    yield
    gn.reset_guardrail_correlation(token)


def _client(screen: dict[str, Any], medical: dict[str, Any] | None = None) -> MagicMock:
    client = MagicMock()
    client.screen_inbound = AsyncMock(return_value=screen)
    client.validate = AsyncMock(return_value=medical or _MEDICAL_OK)
    return client


async def _gate(client: Any, *, locality: str | None, **kwargs: Any):
    return await run_inbound_gate(
        client,
        segments=kwargs.pop("segments", _SEGMENTS),
        prompt="Summarise.",
        system=kwargs.pop("system", "untrusted"),
        tenant_id="t",
        locality=locality,
        **kwargs,
    )


# ── warn / unverified continue ───────────────────────────────────────────────


async def test_warn_continues_and_collects_the_notices_and_evaluation_ids() -> None:
    warning = {
        **gn.unverified_notice("inbound", ["prompt_safety"]),
        "type": "guardrail.warning",
        "messageKey": "guardrail.warning.generic",
        "defaultMessage": gn.DEFAULT_MESSAGES["guardrail.warning.generic"],
    }
    screen = {**_ALLOW, "decision": "warn", "notices": [warning], "evaluation_id": "ev-in"}
    medical = {**_MEDICAL_OK, "evaluation_id": "ev-med"}

    result = await _gate(_client(screen, medical), locality="local")

    assert result.outcome.notices == [warning]
    assert result.outcome.evaluation_ids == ["ev-in", "ev-med"]


async def test_a_guardrail_unverified_decision_continues_with_its_notice() -> None:
    notice = gn.unverified_notice("inbound", ["injection_judge"])
    screen = {**_ALLOW, "decision": "unverified", "notices": [notice], "evaluation_id": "ev-1"}

    result = await _gate(_client(screen), locality="cloud")

    assert result.outcome.notices == [notice]


# ── outage degrades ──────────────────────────────────────────────────────────


async def test_a_screen_outage_on_a_local_provider_degrades_to_unverified() -> None:
    client = _client(_OUTAGE)

    result = await _gate(client, locality="local")

    (notice,) = result.outcome.notices
    assert notice["type"] == "guardrail.unverified"
    assert notice["direction"] == "inbound"
    assert [c["checkId"] for c in notice["checks"]] == list(gn.INBOUND_SCREEN_CHECKS)
    assert result.spans_by_segment == [[], []]


async def test_a_medical_judge_outage_degrades_to_unverified_even_on_cloud() -> None:
    medical = {"allowed": False, "is_medical": False, "reason": GUARDRAIL_UNAVAILABLE_REASON}

    result = await _gate(_client(_ALLOW, medical), locality="cloud")

    (notice,) = result.outcome.notices
    assert notice["type"] == "guardrail.unverified"
    assert notice["checks"] == [{"checkId": "medical_validation", "severity": "low"}]


async def test_a_non_dict_screen_verdict_is_an_outage_not_a_crash() -> None:
    result = await _gate(_client(None), locality="local")  # type: ignore[arg-type]

    assert [n["type"] for n in result.outcome.notices] == ["guardrail.unverified"]


# ── cloud redaction stays fail-closed ────────────────────────────────────────


async def test_a_screen_outage_on_a_cloud_provider_refuses_with_the_redaction_hold() -> None:
    with pytest.raises(EgressRedactionUnavailableError) as raised:
        await _gate(_client(_OUTAGE), locality="cloud")

    error = raised.value
    assert error.error_code == gn.EGRESS_REDACTION_UNAVAILABLE
    assert _get_status_code(error) == 503
    body = error.extra_body
    assert body["processing_reason"] == gn.EGRESS_REDACTION_UNAVAILABLE
    assert body["retryable"] is True
    assert body["guardrailNotice"]["messageKey"] == "guardrail.blocked.redaction_unavailable"
    assert body["guardrailNotice"]["resumable"] is True


async def test_an_unknown_locality_is_read_as_cloud_for_the_redaction_hold() -> None:
    with pytest.raises(EgressRedactionUnavailableError):
        await _gate(_client(_OUTAGE), locality=None)


async def test_a_judged_block_wins_over_the_redaction_hold() -> None:
    medical = {"allowed": False, "decision": "block", "is_medical": False, "reason": "no"}

    with pytest.raises(ContentBlockedError) as raised:
        await _gate(_client(_OUTAGE, medical), locality="cloud")

    assert raised.value.error_code == "CONTENT_BLOCKED_NOT_MEDICAL"


# ── block ────────────────────────────────────────────────────────────────────


async def test_a_screen_block_keeps_the_422_code_and_carries_guardrails_notice() -> None:
    blocked = gn.blocked_notice(
        "inbound", "guardrail.blocked.inbound", [{"checkId": "prompt_safety", "severity": "high"}]
    )
    screen = {
        "allowed": False,
        "decision": "block",
        "reason": "prompt_safety",
        "pii_spans": [],
        "notices": [blocked],
        "evaluation_id": "ev-in",
    }

    with pytest.raises(ContentBlockedError) as raised:
        await _gate(_client(screen, {**_MEDICAL_OK, "evaluation_id": "ev-med"}), locality="local")

    error = raised.value
    assert error.error_code == "CONTENT_BLOCKED"
    assert _get_status_code(error) == 422
    body = error.extra_body
    assert body["type"] == gn.GUARDRAIL_BLOCKED_PROBLEM_TYPE
    assert body["status"] == 422
    assert body["guardrailNotice"] == blocked
    assert body["guardrailEvaluationIds"] == ["ev-in", "ev-med"]


async def test_a_block_without_a_notice_gets_one_naming_the_blocking_checks() -> None:
    screen = {
        "allowed": False,
        "decision": "block",
        "reason": "jailbreak_detection",
        "pii_spans": [],
        "raw": {"reasons": ["jailbreak_detection", "free text"]},
    }

    with pytest.raises(ContentBlockedError) as raised:
        await _gate(_client(screen), locality="local")

    notice = raised.value.extra_body["guardrailNotice"]
    assert gn.valid_notices([notice]) == [notice]
    assert notice["messageKey"] == "guardrail.blocked.inbound"
    assert notice["checks"] == [{"checkId": "jailbreak_detection", "severity": "high"}]


async def test_a_not_medical_block_uses_the_locked_medical_message() -> None:
    medical = {"allowed": False, "is_medical": False, "reason": "not clinical"}

    with pytest.raises(ContentBlockedError) as raised:
        await _gate(_client(_ALLOW, medical), locality="local")

    notice = raised.value.extra_body["guardrailNotice"]
    assert raised.value.error_code == "CONTENT_BLOCKED_NOT_MEDICAL"
    assert notice["messageKey"] == "guardrail.blocked.not_medical"
    assert notice["checks"] == [{"checkId": "medical_validation", "severity": "high"}]


# ── wire: spans flag, locality, items, data trust ────────────────────────────


async def test_a_local_call_does_not_ask_for_pii_spans_and_sends_its_locality() -> None:
    client = _client(_ALLOW)

    await _gate(client, locality="local")

    kwargs = client.screen_inbound.await_args.kwargs
    assert kwargs["include_pii_spans"] is False
    assert kwargs["locality"] == "local"
    assert client.validate.await_args.kwargs["locality"] == "local"


async def test_a_cloud_call_asks_for_pii_spans() -> None:
    client = _client(_ALLOW)

    await _gate(client, locality="cloud")

    assert client.screen_inbound.await_args.kwargs["include_pii_spans"] is True


async def test_region_items_ride_on_the_regions_and_on_synthesised_notices() -> None:
    client = _client(_OUTAGE)
    items = {
        "transcript": [{"itemId": "seg-1", "itemVersion": 2}, {"itemId": "seg-2", "itemVersion": 1}]
    }

    result = await _gate(client, locality="local", region_items=items)

    regions = {r["key"]: r for r in client.screen_inbound.await_args.kwargs["regions"]}
    assert regions["transcript"]["items"] == items["transcript"]
    assert "items" not in regions["user"]
    judged = {r["key"]: r for r in client.validate.await_args.kwargs["regions"]}
    assert judged["transcript"]["items"] == items["transcript"]
    assert result.outcome.notices[0]["itemIds"] == ["seg-1", "seg-2"]


async def test_text_the_service_composes_itself_can_be_screened_as_data() -> None:
    client = _client(_ALLOW)

    await _gate(
        client,
        locality="local",
        segments=["Patient has fever.", "Take paracetamol."],
        system="absent",
        outside_trust=TRUST_DATA,
    )

    (region,) = client.screen_inbound.await_args.kwargs["regions"]
    assert region["trust"] == TRUST_DATA


# ── Q3 (orchestrator): a malformed verdict degrades like an outage ───────────

_MALFORMED = {"allowed": False, "reason": "malformed_verdict", "pii_spans": []}


async def test_a_malformed_screen_verdict_on_a_local_provider_degrades_to_unverified() -> None:
    result = await _gate(_client(_MALFORMED), locality="local")

    (notice,) = result.outcome.notices
    assert notice["type"] == "guardrail.unverified"
    assert [c["checkId"] for c in notice["checks"]] == list(gn.INBOUND_SCREEN_CHECKS)


async def test_a_malformed_screen_verdict_on_a_cloud_provider_is_the_redaction_hold() -> None:
    with pytest.raises(EgressRedactionUnavailableError) as raised:
        await _gate(_client(_MALFORMED), locality="cloud")

    assert raised.value.error_code == gn.EGRESS_REDACTION_UNAVAILABLE


async def test_an_unreadable_payload_from_the_real_client_degrades_end_to_end() -> None:
    from types import SimpleNamespace

    from text.core.guardrail_posture import GuardrailPosture
    from text.services.external_guardrail import ExternalGuardrailClient

    class _Resp:
        def __init__(self, payload: dict[str, Any]) -> None:
            self._payload = payload

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            return self._payload

    class _Http:
        async def post(self, url, json=None, headers=None, timeout=None):  # noqa: ANN001
            keys = [r["key"] for r in (json.get("regions") or [])]
            if url.endswith("/screen/inbound"):
                return _Resp({"decision": "maybe?", "screened_regions": keys})
            return _Resp({"is_medical": True, "screened_regions": keys})

    state = SimpleNamespace(guardrail_posture=GuardrailPosture(retry_backoff_ms=0), redis=None)
    client = ExternalGuardrailClient(
        base_url="http://g", http_client=_Http(), service_token="s", app_state=state
    )

    result = await _gate(client, locality="local")

    assert [n["type"] for n in result.outcome.notices] == ["guardrail.unverified"]


# ── round 2: medical blocks from the screen; caller / agent / exemption ──────


async def test_a_screen_block_on_medical_validation_is_content_blocked_not_medical() -> None:
    screen = {
        "allowed": False,
        "decision": "block",
        "reason": "medical_validation",
        "pii_spans": [],
        "raw": {
            "reasons": ["medical_validation"],
            "checks": [{"name": "medical_validation", "actionTaken": "block"}],
        },
    }

    with pytest.raises(ContentBlockedError) as raised:
        await _gate(_client(screen), locality="local")

    assert raised.value.error_code == "CONTENT_BLOCKED_NOT_MEDICAL"
    notice = raised.value.extra_body["guardrailNotice"]
    assert notice["messageKey"] == "guardrail.blocked.not_medical"
    assert notice["checks"] == [{"checkId": "medical_validation", "severity": "high"}]


async def test_guardrails_own_medical_block_notice_keeps_the_not_medical_code() -> None:
    blocked = gn.blocked_notice(
        "inbound",
        "guardrail.blocked.not_medical",
        [{"checkId": "medical_validation", "severity": "high"}],
    )
    screen = {
        "allowed": False,
        "decision": "block",
        "reason": "medical_validation",
        "pii_spans": [],
        "notices": [blocked],
    }

    with pytest.raises(ContentBlockedError) as raised:
        await _gate(_client(screen), locality="local")

    assert raised.value.error_code == "CONTENT_BLOCKED_NOT_MEDICAL"
    assert raised.value.extra_body["guardrailNotice"] == blocked


async def test_caller_agent_exemption_and_connection_reach_the_screen() -> None:
    from text.models.requests import ProviderOverride

    client = _client(_ALLOW)

    await _gate(
        client,
        locality="cloud",
        caller="text.generate",
        agent_slug="soap-writer",
        medical_exempt="internal",
        provider_overrides={"openai": ProviderOverride(api_key="k")},
    )

    kwargs = client.screen_inbound.await_args.kwargs
    assert kwargs["caller"] == "text.generate"
    assert kwargs["agent_slug"] == "soap-writer"
    assert kwargs["exempt"] == "medical_internal"
    assert kwargs["provider_overrides"]["openai"]["api_key"] == "k"


async def test_no_exemption_is_sent_when_the_judge_runs() -> None:
    client = _client(_ALLOW)

    await _gate(client, locality="local", caller="text.translate")

    kwargs = client.screen_inbound.await_args.kwargs
    assert kwargs["exempt"] is None
    assert kwargs["caller"] == "text.translate"
