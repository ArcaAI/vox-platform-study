"""TASK-1050 W2a2 — `GuardrailNotice` v1 built by guardrail (README §9.7.3, §9.8.1).

A notice carries NO content and NO judge reasoning; its `defaultMessage` is exactly the
fixed label of its `messageKey`; its id is DETERMINISTIC, so a repeat raise (a live
summary re-screening the same window every few seconds) keeps the same id and the
gateway's idempotent write collapses it.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from pathlib import Path

from guardrail.services.notices import (
    NOTICE_DEFAULT_MESSAGES,
    GuardrailCorrelation,
    build_notices,
    notice_dedupe_key,
    notice_id_for,
)
from guardrail.services.screening import CheckOutcome, GuardrailDecision

_REPO = Path(__file__).parents[5]
VOCABULARY = json.loads(
    (_REPO / "tests" / "contracts" / "guardrail-vocabulary.fixture.json").read_text()
)
TENANT = "50000000-0000-0000-0000-000000000000"
CONSULTATION = "01927f6e-0000-7000-8000-000000000001"
ITEM = "01927f6e-1111-7000-8000-000000000010"


def _check(name: str, taken: str, **kw: object) -> CheckOutcome:
    verdict = "undetermined" if taken == "unverified" else "flag"
    return CheckOutcome(
        name=name,
        outcome=verdict,
        fail_mode="closed",
        model="m",
        verdict=verdict,
        action_taken=taken,
        **kw,  # type: ignore[arg-type]
    )


def _decision(direction: str, *checks: CheckOutcome) -> GuardrailDecision:
    return GuardrailDecision(
        tenant_id=TENANT, direction=direction, decision="allow", checks=list(checks)
    )


def _correlation(**kw: str) -> GuardrailCorrelation:
    return GuardrailCorrelation(request_id="req-1", **kw)


def test_default_messages_are_the_frozen_labels() -> None:
    frozen = VOCABULARY["notice"]["defaultMessages"]
    assert frozen == NOTICE_DEFAULT_MESSAGES


def test_dedupe_key_shape() -> None:
    assert (
        notice_dedupe_key(
            consultation_id=CONSULTATION,
            request_id="req-1",
            check_id="unsafe_content_judge",
            target=ITEM,
            policy_version="pv-1",
        )
        == f"{CONSULTATION}:unsafe_content_judge:{ITEM}:pv-1"
    )
    # Without a consultation the request id scopes it.
    assert (
        notice_dedupe_key(
            consultation_id=None,
            request_id="req-1",
            check_id="pii_leak",
            target="response",
            policy_version="pv-1",
        )
        == "req-1:pii_leak:response:pv-1"
    )


def test_notice_id_is_a_deterministic_uuid_of_tenant_and_dedupe_key() -> None:
    key = f"{CONSULTATION}:unsafe_content_judge:{ITEM}:pv-1"
    first = notice_id_for(TENANT, key)
    assert first == notice_id_for(TENANT, key)
    assert str(uuid.UUID(first)) == first
    digest = hashlib.sha256(f"{TENANT}|{key}".encode()).hexdigest()
    assert first.replace("-", "")[:12] == digest[:12]
    # Another tenant, another id — dedupe never crosses a tenant.
    assert notice_id_for("tenant-b", key) != first


def test_warn_notice_shape_and_severity() -> None:
    decision = _decision(
        "inbound",
        _check(
            "unsafe_content_judge",
            "warn",
            category="violence",
            region_keys=("transcript:w1",),
            flagged_regions=("transcript:w1",),
            flagged_items=((ITEM, 2),),
        ),
    )
    (notice,) = build_notices(
        decision,
        tenant_id=TENANT,
        correlation=_correlation(consultation_id=CONSULTATION, run_id="run_1", node_id="n_note"),
        policy_version="pv-1",
        occurred_at="2026-10-07T09:15:00.000Z",
    )
    assert notice == {
        "schemaVersion": 1,
        "noticeId": notice_id_for(TENANT, f"{CONSULTATION}:unsafe_content_judge:{ITEM}:pv-1"),
        "type": "guardrail.warning",
        "direction": "inbound",
        "action": "warn",
        "checks": [
            {"checkId": "unsafe_content_judge", "category": "violence", "severity": "medium"}
        ],
        "consultationId": CONSULTATION,
        "runId": "run_1",
        "nodeId": "n_note",
        "itemIds": [ITEM],
        "messageKey": "guardrail.warning.generic",
        "defaultMessage": NOTICE_DEFAULT_MESSAGES["guardrail.warning.generic"],
        "requiresAcknowledgement": True,
        "resumable": False,
        "policyVersion": "pv-1",
        "occurredAt": "2026-10-07T09:15:00.000Z",
    }


def test_block_notices_name_the_direction_and_medical_has_its_own_key() -> None:
    outbound = build_notices(
        _decision(
            "outbound",
            _check(
                "leakage_judge",
                "block",
                category="credential",
                region_keys=("response",),
                flagged_regions=("response",),
            ),
        ),
        tenant_id=TENANT,
        correlation=_correlation(consultation_id=CONSULTATION),
        policy_version="pv-1",
        occurred_at="t",
    )
    assert outbound[0]["type"] == "guardrail.blocked"
    assert outbound[0]["action"] == "block"
    assert outbound[0]["messageKey"] == "guardrail.blocked.outbound"
    assert outbound[0]["checks"][0]["severity"] == "high"
    assert outbound[0]["resumable"] is True
    assert outbound[0]["itemIds"] == []

    inbound = build_notices(
        _decision(
            "inbound",
            _check(
                "prompt_safety",
                "block",
                category="unsafe",
                region_keys=("user",),
                flagged_regions=("user",),
            ),
            _check(
                "medical_validation",
                "block",
                category="not_medical",
                region_keys=("note:w0",),
                flagged_regions=("note:w0",),
            ),
        ),
        tenant_id=TENANT,
        correlation=_correlation(),
        policy_version="pv-1",
        occurred_at="t",
    )
    keys = {n["checks"][0]["checkId"]: n["messageKey"] for n in inbound}
    assert keys == {
        "prompt_safety": "guardrail.blocked.inbound",
        "medical_validation": "guardrail.blocked.not_medical",
    }
    # Standalone (no consultation): a block is re-run, not resumed.
    assert all(n["resumable"] is False for n in inbound)


def test_unverified_notice_is_low_weight_and_carries_no_category() -> None:
    (notice,) = build_notices(
        _decision("outbound", _check("response_safety", "unverified", region_keys=("response",))),
        tenant_id=TENANT,
        correlation=_correlation(),
        policy_version="pv-1",
        occurred_at="t",
    )
    assert notice["type"] == "guardrail.unverified"
    assert notice["action"] == "warn"
    assert notice["messageKey"] == "guardrail.unverified.generic"
    assert notice["checks"] == [{"checkId": "response_safety", "severity": "low"}]
    assert notice["requiresAcknowledgement"] is False


def test_ignore_none_and_pass_raise_no_notice() -> None:
    decision = _decision(
        "inbound",
        _check("prompt_safety", "ignore", region_keys=("user",)),
        CheckOutcome(
            name="prompt_toxicity", outcome="pass", fail_mode="closed", action_taken="none"
        ),
    )
    assert (
        build_notices(
            decision,
            tenant_id=TENANT,
            correlation=_correlation(),
            policy_version="pv",
            occurred_at="t",
        )
        == []
    )


def test_one_notice_per_item_and_duplicates_collapse() -> None:
    other = "01927f6e-1111-7000-8000-000000000011"
    decision = _decision(
        "inbound",
        _check(
            "unsafe_content_judge",
            "warn",
            category="violence",
            region_keys=("transcript:w0", "transcript:w1"),
            flagged_regions=("transcript:w0", "transcript:w1"),
            # The same item behind both windows (an overlap) is ONE notice.
            flagged_items=((ITEM, 2), (other, 1), (ITEM, 2)),
        ),
    )
    notices = build_notices(
        decision,
        tenant_id=TENANT,
        correlation=_correlation(consultation_id=CONSULTATION),
        policy_version="pv",
        occurred_at="t",
    )
    assert sorted(n["itemIds"][0] for n in notices) == sorted([ITEM, other])
    assert len({n["noticeId"] for n in notices}) == 2


def test_a_repeat_raise_keeps_its_id() -> None:
    def _raise() -> list[dict[str, object]]:
        return build_notices(
            _decision(
                "inbound",
                _check(
                    "unsafe_content_judge", "warn", category="violence", flagged_items=((ITEM, 2),)
                ),
            ),
            tenant_id=TENANT,
            correlation=_correlation(consultation_id=CONSULTATION),
            policy_version="pv-1",
            occurred_at="t",
        )

    assert _raise()[0]["noticeId"] == _raise()[0]["noticeId"]


def test_no_notice_ever_carries_content() -> None:
    notices = build_notices(
        _decision(
            "outbound",
            _check(
                "leakage_judge",
                "block",
                category="credential",
                labels=("api_key=sk-123",),
                flagged_regions=("response",),
            ),
        ),
        tenant_id=TENANT,
        correlation=_correlation(),
        policy_version="pv",
        occurred_at="t",
    )
    assert "sk-123" not in json.dumps(notices)
    assert re.fullmatch(r"[0-9a-f-]{36}", str(notices[0]["noticeId"]))
