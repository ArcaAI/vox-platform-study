"""TASK-1050 follow-up E (owner, 2026-10-08; round 2) — ONE notice per (decision, notice type).

The local e2e raised one notice per flagged check, then (round 1) one per target: an inbound
screen whose classifiers were undetermined over 12 transcript items raised 12
`guardrail.unverified` notices. The owner's intent is "one block → one resume". A decision now
raises ONE notice per (direction, notice type): ``checks[]`` lists every check that raised that
type and ``itemIds`` the union of their flagged items (empty when only regions flagged).

* dedupe key ``{consultationId or requestId}:{direction}:{type}:{target-set}:{policyVersion}``,
  target-set = the sorted, de-duplicated item ids joined with ``,`` — or, with no item, the
  sorted region keys (``request`` when there are none). So the same items re-screened keep the
  id (no new notice), and a new item set is a new notice — a long live consultation never
  collapses every later violation into one stored (possibly resolved) notice.
* notice id = ``notice_id_for(tenantId, dedupeKey)``;
* `X-Hope-Guardrail-Override` naming the notice downgrades EVERY check it lists (block-floor
  checks excepted), whether the verified row carries the dedupe key or the notice id.
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
    notice_dedupe_key,
    notice_id_for,
    notice_target_set,
)
from guardrail.services.screening import CheckOutcome, GuardrailDecision, Screener

TENANT = "50000000-0000-0000-0000-000000000000"
CONSULTATION = "01927f6e-0000-7000-8000-000000000001"
ITEM = "01927f6e-1111-7000-8000-000000000010"
OTHER = "01927f6e-1111-7000-8000-000000000011"
THIRD = "01927f6e-1111-7000-8000-000000000012"
CORRELATION = GuardrailCorrelation(request_id="req-1", consultation_id=CONSULTATION)


def _check(name: str, taken: str, *items: str, **kw: Any) -> CheckOutcome:
    verdict = "undetermined" if taken == "unverified" else "flag"
    refs = tuple((item, 2) for item in items)
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


def _key(direction: str, notice_type: str, target_set: str) -> str:
    return f"{CONSULTATION}:{direction}:{notice_type}:{target_set}:pv-1"


# ── the key ─────────────────────────────────────────────────────────────────


def test_the_dedupe_key_carries_the_target_set() -> None:
    assert notice_dedupe_key(
        consultation_id=CONSULTATION,
        request_id="req-1",
        direction="inbound",
        notice_type="guardrail.blocked",
        target=notice_target_set([OTHER, ITEM, OTHER], []),
        policy_version="pv-1",
    ) == _key("inbound", "guardrail.blocked", f"{ITEM},{OTHER}")
    assert notice_target_set([], ["user", "system", "user"]) == "system,user"
    assert notice_target_set([], []) == "request"
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


# ── one notice per type ─────────────────────────────────────────────────────


def test_an_outage_over_twelve_items_raises_one_unverified_notice() -> None:
    items = [f"01927f6e-1111-7000-8000-0000000001{n:02d}" for n in range(12)]
    checks = [
        _check(name, "unverified", *items)
        for name in ("jailbreak_detection", "prompt_safety", "prompt_toxicity")
    ]
    (notice,) = _notices(_decision("inbound", *checks, outcome="unverified"))
    assert notice["type"] == "guardrail.unverified"
    assert [c["checkId"] for c in notice["checks"]] == [
        "jailbreak_detection",
        "prompt_safety",
        "prompt_toxicity",
    ]
    assert all("category" not in c for c in notice["checks"])
    assert notice["itemIds"] == items
    assert notice["requiresAcknowledgement"] is False
    assert notice["noticeId"] == notice_id_for(
        TENANT, _key("inbound", "guardrail.unverified", ",".join(sorted(items)))
    )


def test_blocks_on_several_items_raise_one_notice_listing_every_item_and_check() -> None:
    notices = _notices(
        _decision(
            "inbound",
            _check("jailbreak_detection", "block", ITEM, category="jailbreak"),
            _check("prompt_safety", "block", OTHER),
            _check("prompt_toxicity", "block", ITEM, THIRD, category="toxic"),
        )
    )
    (notice,) = notices
    assert notice["checks"] == [
        {"checkId": "jailbreak_detection", "category": "jailbreak", "severity": "high"},
        {"checkId": "prompt_safety", "category": "unsafe", "severity": "high"},
        {"checkId": "prompt_toxicity", "category": "toxic", "severity": "high"},
    ]
    assert notice["itemIds"] == [ITEM, OTHER, THIRD]
    assert notice["type"] == "guardrail.blocked"
    assert notice["messageKey"] == "guardrail.blocked.inbound"
    assert notice["defaultMessage"] == NOTICE_DEFAULT_MESSAGES["guardrail.blocked.inbound"]
    assert notice["resumable"] is True


def test_each_type_is_its_own_notice() -> None:
    notices = _notices(
        _decision(
            "inbound",
            _check("prompt_safety", "block", ITEM),
            _check("unsafe_content_judge", "warn", ITEM),
            _check("prompt_toxicity", "block", OTHER),
            _check("injection_judge", "unverified", THIRD),
        )
    )
    by_type = {n["type"]: ([c["checkId"] for c in n["checks"]], n["itemIds"]) for n in notices}
    assert by_type == {
        "guardrail.blocked": (["prompt_safety", "prompt_toxicity"], [ITEM, OTHER]),
        "guardrail.warning": (["unsafe_content_judge"], [ITEM]),
        "guardrail.unverified": (["injection_judge"], [THIRD]),
    }


def test_instruction_regions_only_carry_no_items() -> None:
    (notice,) = _notices(
        _decision(
            "inbound",
            _check("prompt_safety", "block", region_keys=("user",), flagged_regions=("user",)),
            _check(
                "prompt_toxicity", "block", region_keys=("system",), flagged_regions=("system",)
            ),
        )
    )
    assert notice["itemIds"] == []
    assert notice["noticeId"] == notice_id_for(
        TENANT, _key("inbound", "guardrail.blocked", "system,user")
    )


def test_the_not_medical_label_only_when_medical_is_alone() -> None:
    (shared,) = _notices(
        _decision(
            "inbound",
            _check("medical_validation", "block", ITEM, category="not_medical"),
            _check("prompt_safety", "block", OTHER),
        )
    )
    assert [c["checkId"] for c in shared["checks"]] == ["medical_validation", "prompt_safety"]
    assert shared["messageKey"] == "guardrail.blocked.inbound"

    (alone,) = _notices(
        _decision("inbound", _check("medical_validation", "block", ITEM, category="not_medical"))
    )
    assert alone["messageKey"] == "guardrail.blocked.not_medical"


def test_inbound_and_outbound_never_collide() -> None:
    inbound = _notices(_decision("inbound", _check("jailbreak_detection", "block", ITEM)))
    outbound = _notices(_decision("outbound", _check("jailbreak_detection", "block", ITEM)))
    assert inbound[0]["noticeId"] != outbound[0]["noticeId"]


# ── the three identity properties (orchestrator correction, round 2) ────────


def test_one_notice_per_evaluation_direction_and_type() -> None:
    notices = _notices(
        _decision(
            "inbound",
            *(
                _check(name, "block", item)
                for name, item in (
                    ("prompt_safety", ITEM),
                    ("prompt_toxicity", OTHER),
                    ("jailbreak_detection", THIRD),
                )
            ),
        )
    )
    assert len(notices) == 1
    assert sorted(notices[0]["itemIds"]) == sorted([ITEM, OTHER, THIRD])


def test_the_same_items_re_screened_keep_the_id() -> None:
    first = _notices(_decision("inbound", _check("prompt_safety", "block", ITEM, OTHER)))
    # Same item set, flagged in another order and by another check: the SAME notice.
    again = _notices(
        _decision(
            "inbound",
            _check("prompt_toxicity", "block", OTHER),
            _check("prompt_safety", "block", ITEM),
        )
    )
    assert first[0]["noticeId"] == again[0]["noticeId"]


def test_a_new_item_set_is_a_new_notice() -> None:
    first = _notices(_decision("inbound", _check("prompt_safety", "block", ITEM)))
    grown = _notices(_decision("inbound", _check("prompt_safety", "block", ITEM, OTHER)))
    later = _notices(_decision("inbound", _check("prompt_safety", "block", THIRD)))
    assert len({first[0]["noticeId"], grown[0]["noticeId"], later[0]["noticeId"]}) == 3


# ── the override of a multi-check, multi-item notice ────────────────────────


def _three() -> GuardrailDecision:
    return _decision(
        "inbound",
        _check("jailbreak_detection", "block", ITEM),
        _check("prompt_safety", "block", OTHER),
        _check("medical_validation", "block", ITEM),
        _check("unsafe_content_judge", "warn", ITEM),
    )


@pytest.mark.parametrize("stored", ["dedupe_key", "notice_id"])
def test_an_override_downgrades_every_check_of_its_notice(stored: str) -> None:
    decision = _three()
    blocked = next(n for n in _notices(decision) if n["type"] == "guardrail.blocked")
    dedupe = _key("inbound", "guardrail.blocked", f"{ITEM},{OTHER}")
    assert blocked["noticeId"] == notice_id_for(TENANT, dedupe)
    out = apply_guardrail_override(
        decision,
        correlation=CORRELATION,
        dedupe_key=dedupe if stored == "dedupe_key" else blocked["noticeId"],
        notice_id=blocked["noticeId"],
    )
    taken = {c.name: c.action_taken for c in out.checks}
    assert taken == {
        "jailbreak_detection": "warn",
        "prompt_safety": "warn",
        # The locked medical check keeps its block floor.
        "medical_validation": "block",
        "unsafe_content_judge": "warn",
    }
    assert {c.name for c in out.checks if c.override_notice_id} == {
        "jailbreak_detection",
        "prompt_safety",
    }
    assert out.guardrail_decision == "block"


def test_an_override_of_another_item_set_moves_nothing() -> None:
    decision = _decision("inbound", _check("prompt_safety", "block", ITEM, OTHER))
    out = apply_guardrail_override(
        decision,
        correlation=CORRELATION,
        dedupe_key=_key("inbound", "guardrail.blocked", ITEM),
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
async def test_the_route_raises_one_notice_for_every_flagged_item(monkeypatch: Any) -> None:
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
                "key": f"transcript:{n}",
                "text": "x",
                "trust": "instruction",
                "items": [{"itemId": item, "itemVersion": 2}],
            }
            for n, item in enumerate((ITEM, OTHER, THIRD))
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
    assert sorted(response.notices[0]["itemIds"]) == sorted([ITEM, OTHER, THIRD])
    assert records[0]["noticeIds"] == [response.notices[0]["noticeId"]]
