"""TASK-1050 follow-up E (owner, 2026-10-08) — ONE notice per (decision, notice type, target).

In the local e2e one block raised one notice per flagged check (3 notices → the clinician
resumed 3 times) and an outage raised 3 `guardrail.unverified` notices. Now a decision raises
one notice per (direction, notice type, target) whose `checks[]` lists every check that raised
it — the `GuardrailNotice` v1 shape already carries `checks: []`, so no type changes.

* dedupe key ``{consultationId or requestId}:{direction}:{type}:{target}:{policyVersion}``,
  notice id = ``notice_id_for(tenantId, dedupeKey)`` (deterministic);
* `X-Hope-Guardrail-Override` naming such a notice downgrades EVERY check it lists (a
  block-floor check excepted), whether the verified row carries the dedupe key or — as the
  gateway stores it — the notice id itself.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from guardrail.services.notices import (
    NOTICE_DEFAULT_MESSAGES,
    GuardrailCorrelation,
    apply_guardrail_override,
    build_notices,
    check_dedupe_keys,
    notice_dedupe_key,
    notice_id_for,
)
from guardrail.services.screening import CheckOutcome, GuardrailDecision, Screener

TENANT = "50000000-0000-0000-0000-000000000000"
CONSULTATION = "01927f6e-0000-7000-8000-000000000001"
ITEM = "01927f6e-1111-7000-8000-000000000010"
OTHER = "01927f6e-1111-7000-8000-000000000011"
CORRELATION = GuardrailCorrelation(request_id="req-1", consultation_id=CONSULTATION)


def _check(name: str, taken: str, item: str | None = ITEM, **kw: Any) -> CheckOutcome:
    verdict = "undetermined" if taken == "unverified" else "flag"
    refs = ((item, 2),) if item else ()
    return CheckOutcome(
        name=name,
        outcome=verdict,
        fail_mode="closed",
        model="m",
        verdict=verdict,
        action="block",
        action_taken=taken,
        category=kw.pop("category", "unsafe"),
        region_keys=kw.pop("region_keys", ("transcript",)),
        flagged_regions=kw.pop("flagged_regions", ("transcript",)),
        items=refs,
        flagged_items=refs,
        **kw,
    )


def _decision(direction: str, *checks: CheckOutcome, outcome: str = "block") -> GuardrailDecision:
    return GuardrailDecision(
        tenant_id=TENANT,
        direction=direction,
        decision="block" if outcome == "block" else "allow",
        checks=list(checks),
        guardrail_decision=outcome,
        policy_version="pv-1",
    )


def _notices(decision: GuardrailDecision) -> list[dict[str, Any]]:
    return build_notices(
        decision, tenant_id=TENANT, correlation=CORRELATION, policy_version="pv-1", occurred_at="t"
    )


def test_the_dedupe_key_is_per_direction_type_and_target() -> None:
    assert (
        notice_dedupe_key(
            consultation_id=CONSULTATION,
            request_id="req-1",
            direction="inbound",
            notice_type="guardrail.blocked",
            target=ITEM,
            policy_version="pv-1",
        )
        == f"{CONSULTATION}:inbound:guardrail.blocked:{ITEM}:pv-1"
    )
    assert (
        notice_dedupe_key(
            consultation_id=None,
            request_id="req-1",
            direction="outbound",
            notice_type="guardrail.unverified",
            target="response",
            policy_version="pv-1",
        )
        == "req-1:outbound:guardrail.unverified:response:pv-1"
    )


def test_three_blocking_checks_on_one_item_raise_one_notice() -> None:
    notices = _notices(
        _decision(
            "inbound",
            _check("jailbreak_detection", "block", category="jailbreak"),
            _check("prompt_safety", "block"),
            _check("prompt_toxicity", "block", category="toxic"),
        )
    )
    assert len(notices) == 1
    (notice,) = notices
    assert notice["noticeId"] == notice_id_for(
        TENANT, f"{CONSULTATION}:inbound:guardrail.blocked:{ITEM}:pv-1"
    )
    assert notice["checks"] == [
        {"checkId": "jailbreak_detection", "category": "jailbreak", "severity": "high"},
        {"checkId": "prompt_safety", "category": "unsafe", "severity": "high"},
        {"checkId": "prompt_toxicity", "category": "toxic", "severity": "high"},
    ]
    assert notice["itemIds"] == [ITEM]
    assert notice["type"] == "guardrail.blocked"
    assert notice["messageKey"] == "guardrail.blocked.inbound"
    assert notice["defaultMessage"] == NOTICE_DEFAULT_MESSAGES["guardrail.blocked.inbound"]
    assert notice["resumable"] is True


def test_an_outage_raises_one_unverified_notice() -> None:
    checks = [
        _check(
            name,
            "unverified",
            item=None,
            region_keys=("response",),
            flagged_regions=("response",),
        )
        for name in ("response_safety", "response_toxicity", "jailbreak_detection")
    ]
    (notice,) = _notices(_decision("outbound", *checks, outcome="unverified"))
    assert notice["type"] == "guardrail.unverified"
    assert [c["checkId"] for c in notice["checks"]] == [
        "response_safety",
        "response_toxicity",
        "jailbreak_detection",
    ]
    assert all("category" not in c for c in notice["checks"])
    assert notice["requiresAcknowledgement"] is False


def test_different_types_and_targets_stay_separate() -> None:
    notices = _notices(
        _decision(
            "inbound",
            _check("prompt_safety", "block"),
            _check("unsafe_content_judge", "warn"),
            _check("prompt_toxicity", "block", item=OTHER),
        )
    )
    by_key = {
        (n["type"], tuple(n["itemIds"])): [c["checkId"] for c in n["checks"]] for n in notices
    }
    assert by_key == {
        ("guardrail.blocked", (ITEM,)): ["prompt_safety"],
        ("guardrail.warning", (ITEM,)): ["unsafe_content_judge"],
        ("guardrail.blocked", (OTHER,)): ["prompt_toxicity"],
    }


def test_medical_with_another_block_shares_the_notice_and_alone_keeps_its_key() -> None:
    (shared,) = _notices(
        _decision(
            "inbound",
            _check("medical_validation", "block", category="not_medical"),
            _check("prompt_safety", "block"),
        )
    )
    assert [c["checkId"] for c in shared["checks"]] == ["medical_validation", "prompt_safety"]
    assert shared["messageKey"] == "guardrail.blocked.inbound"

    (alone,) = _notices(
        _decision("inbound", _check("medical_validation", "block", category="not_medical"))
    )
    assert alone["messageKey"] == "guardrail.blocked.not_medical"


def test_inbound_and_outbound_never_collide() -> None:
    inbound = _notices(_decision("inbound", _check("jailbreak_detection", "block")))
    outbound = _notices(_decision("outbound", _check("jailbreak_detection", "block")))
    assert inbound[0]["noticeId"] != outbound[0]["noticeId"]


# ── the override of a multi-check notice ────────────────────────────────────


def _three() -> GuardrailDecision:
    return _decision(
        "inbound",
        _check("jailbreak_detection", "block"),
        _check("prompt_safety", "block"),
        _check("medical_validation", "block"),
    )


def test_the_check_keys_are_the_notice_keys() -> None:
    decision = _three()
    (notice,) = _notices(decision)
    keys = check_dedupe_keys(
        decision.checks[0], correlation=CORRELATION, policy_version="pv-1", direction="inbound"
    )
    assert [notice_id_for(TENANT, key) for key in keys] == [notice["noticeId"]]


@pytest.mark.parametrize("stored", ["dedupe_key", "notice_id"])
def test_an_override_downgrades_every_check_of_its_notice(stored: str) -> None:
    decision = _three()
    (notice,) = _notices(decision)
    dedupe = f"{CONSULTATION}:inbound:guardrail.blocked:{ITEM}:pv-1"
    out = apply_guardrail_override(
        decision,
        correlation=CORRELATION,
        dedupe_key=dedupe if stored == "dedupe_key" else notice["noticeId"],
        notice_id=notice["noticeId"],
    )
    taken = {c.name: c.action_taken for c in out.checks}
    assert taken == {
        "jailbreak_detection": "warn",
        "prompt_safety": "warn",
        # The locked medical check keeps its block floor.
        "medical_validation": "block",
    }
    assert out.guardrail_decision == "block"


def test_an_override_for_another_target_moves_nothing() -> None:
    decision = _decision("inbound", _check("prompt_safety", "block", item=OTHER))
    out = apply_guardrail_override(
        decision,
        correlation=CORRELATION,
        dedupe_key=f"{CONSULTATION}:inbound:guardrail.blocked:{ITEM}:pv-1",
        notice_id="01927f6e-9999-8000-8000-0000000000aa",
    )
    assert out is decision


# ── the route ───────────────────────────────────────────────────────────────


class _Analyzer:
    async def classify_tasks(self, task_names: Any, text: str) -> dict[str, Any]:
        return dict.fromkeys(task_names, "unsafe")

    async def extract_pii_entities(self, text: str) -> list[Any]:
        return []

    def model_for(self, check: str) -> str:
        return "m"


@pytest.mark.asyncio
async def test_the_route_raises_one_notice_for_three_flagged_checks(monkeypatch: Any) -> None:
    import guardrail.api.endpoints.screen as screen_mod
    from guardrail.api.endpoints.screen import InboundScreenRequest, screen_inbound

    async def _build(app_state: Any, tenant_id: str, **_: Any) -> Screener:
        return Screener(analyzer=_Analyzer(), tenant_id=tenant_id, policy_version="pv-1")

    monkeypatch.setattr(screen_mod, "build_screener", _build)
    records: list[dict[str, Any]] = []

    class _Outbox:
        async def append(self, record: dict[str, Any]) -> bool:
            records.append(record)
            return True

    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(admission_gates={}, evaluation_outbox=_Outbox())),
        headers={"X-Tenant-Id": TENANT, "X-Hope-Consultation-Id": CONSULTATION},
    )
    body = InboundScreenRequest(
        regions=[
            {
                "key": "transcript",
                "text": "x",
                "trust": "instruction",
                "items": [{"itemId": ITEM, "itemVersion": 2}],
            }
        ]
    )
    response = await screen_inbound(body, request)  # type: ignore[arg-type]
    assert response.decision == "block"
    assert len(response.notices) == 1
    assert {c["checkId"] for c in response.notices[0]["checks"]} == {
        "jailbreak_detection",
        "prompt_safety",
        "prompt_toxicity",
    }
    assert records[0]["noticeIds"] == [response.notices[0]["noticeId"]]
