"""TASK-1050 W2c — TEXT's GuardrailNotice v1 helpers, pinned to the FROZEN contract.

The vocabulary (types, type → action, message keys, their fixed labels, the blocked
problem type, the correlation headers, the redaction-hold processing reason) is read
from `tests/contracts/guardrail-vocabulary.fixture.json`, the W1 freeze, so a drift
between TEXT and the contract fails here rather than in a client popup.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from text.services import guardrail_notices as gn

_FIXTURE = Path(__file__).resolve().parents[6] / "tests/contracts/guardrail-vocabulary.fixture.json"
_VOCAB = json.loads(_FIXTURE.read_text())


@pytest.fixture(autouse=True)
def _no_correlation():
    token = gn.bind_guardrail_correlation({})
    yield
    gn.reset_guardrail_correlation(token)


# ── parity with the freeze ───────────────────────────────────────────────────


def test_notice_vocabulary_matches_the_frozen_fixture() -> None:
    notice = _VOCAB["notice"]
    assert gn.NOTICE_SCHEMA_VERSION == notice["schemaVersion"]
    assert dict(gn.NOTICE_TYPE_ACTION) == notice["typeAction"]
    assert dict(gn.DEFAULT_MESSAGES) == notice["defaultMessages"]
    assert gn.NOTICE_SEVERITIES == frozenset(notice["severities"])
    assert gn.GUARDRAIL_BLOCKED_PROBLEM_TYPE == notice["blockedProblemType"]


def test_correlation_headers_check_ids_and_processing_reason_match_the_freeze() -> None:
    assert dict(gn.GUARDRAIL_CORRELATION_HEADERS) == _VOCAB["correlationHeaders"]
    assert gn.CHECK_IDS == frozenset(_VOCAB["checkIds"])
    assert (
        gn.EGRESS_REDACTION_UNAVAILABLE == _VOCAB["processingReasons"]["egressRedactionUnavailable"]
    )


# ── synthesised notices ──────────────────────────────────────────────────────


def _assert_well_formed(notice: dict) -> None:
    assert gn.valid_notices([notice]) == [notice]


def test_an_unverified_notice_is_warn_weight_and_never_quotes_content() -> None:
    notice = gn.unverified_notice("outbound", ["response_safety"])

    _assert_well_formed(notice)
    assert notice["type"] == "guardrail.unverified"
    assert notice["action"] == "warn"
    assert notice["messageKey"] == "guardrail.unverified.generic"
    assert (
        notice["defaultMessage"]
        == _VOCAB["notice"]["defaultMessages"]["guardrail.unverified.generic"]
    )
    assert notice["checks"] == [{"checkId": "response_safety", "severity": "low"}]
    assert notice["requiresAcknowledgement"] is False and notice["resumable"] is False
    assert notice["occurredAt"].endswith("Z")


def test_a_redaction_unavailable_notice_is_a_resumable_block_with_no_checks() -> None:
    notice = gn.redaction_unavailable_notice(item_ids=["item-1"])

    _assert_well_formed(notice)
    assert notice["type"] == "guardrail.blocked"
    assert notice["direction"] == "inbound"
    assert notice["checks"] == []
    assert notice["messageKey"] == "guardrail.blocked.redaction_unavailable"
    assert notice["resumable"] is True
    assert notice["itemIds"] == ["item-1"]


def test_a_blocked_notice_carries_the_bound_correlation() -> None:
    gn.bind_guardrail_correlation(
        {"X-Hope-Consultation-Id": "c-1", "x-hope-run-id": "r-1", "X-Hope-Node-Id": "n-1"}
    )

    notice = gn.blocked_notice(
        "inbound", "guardrail.blocked.inbound", [{"checkId": "prompt_safety", "severity": "high"}]
    )

    _assert_well_formed(notice)
    assert (notice["consultationId"], notice["runId"], notice["nodeId"]) == ("c-1", "r-1", "n-1")
    assert notice["requiresAcknowledgement"] is True and notice["resumable"] is True


# ── ingestion from guardrail ─────────────────────────────────────────────────


def test_valid_notices_drops_malformed_or_free_text_notices_and_strips_unknown_keys() -> None:
    good = gn.unverified_notice("inbound", ["prompt_safety"])
    free_text = {**good, "noticeId": "n-2", "defaultMessage": "the patient said X"}
    wrong_action = {**good, "noticeId": "n-3", "action": "block"}
    bad_check = {**good, "noticeId": "n-4", "checks": [{"checkId": "nope", "severity": "low"}]}
    extra = {**good, "noticeId": "n-5", "reasoning": "quoted PHI"}

    kept = gn.valid_notices([good, free_text, wrong_action, bad_check, extra, "x", None])

    assert [n["noticeId"] for n in kept] == [good["noticeId"], "n-5"]
    assert "reasoning" not in kept[1]


def test_outcome_collects_notices_once_and_evaluation_ids_in_order() -> None:
    outcome = gn.GuardrailOutcome()
    notice = gn.unverified_notice("inbound", ["prompt_safety"])

    outcome.add_verdict({"notices": [notice], "evaluation_id": "ev-1"})
    outcome.add_verdict({"notices": [notice], "evaluation_id": "ev-2"})
    outcome.add_verdict({"evaluation_id": "ev-1"})

    assert outcome.notices == [notice]
    assert outcome.evaluation_ids == ["ev-1", "ev-2"]


def test_correlation_headers_are_only_the_frozen_names_received() -> None:
    gn.bind_guardrail_correlation(
        {
            "x-hope-consultation-id": "c-1",
            "X-Hope-Item-Id": "i-1",
            "X-Other": "no",
            "X-Hope-Run-Key": "",
        }
    )

    assert gn.correlation_headers() == {"X-Hope-Consultation-Id": "c-1", "X-Hope-Item-Id": "i-1"}
