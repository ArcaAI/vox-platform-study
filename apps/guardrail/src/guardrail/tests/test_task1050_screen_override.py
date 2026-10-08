"""TASK-1050 W2a2 — `X-Hope-Guardrail-Override` (contract amendment 5d0760a60).

The harness re-runs a blocked node after an `acknowledged` hold resolution and sends the
resolved notice id. Guardrail honours it ONLY after a read-only check of the
`core."GuardrailNotice"` row (same tenant, RESOLVED, resolution `acknowledged`, younger
than the 24 h hold cap), downgrades block → warn only for the checks whose dedupe key is
that notice's, NEVER for a catalogue-locked / block-floor check, and otherwise ignores the
header (logged), never failing the request.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest

from guardrail.core.tenant_config import TenantConfigResolver
from guardrail.services.notices import (
    GuardrailCorrelation,
    apply_guardrail_override,
    build_notices,
    notice_id_for,
)
from guardrail.services.screening import CheckOutcome, GuardrailDecision, Screener

TENANT = "50000000-0000-0000-0000-000000000000"
NOTICE = "01927f6e-9999-8000-8000-0000000000aa"
NOW = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)


def _row(**kw: Any) -> Any:
    base = {
        "id": NOTICE,
        "tenant_id": TENANT,
        "status": "RESOLVED",
        "resolution": "acknowledged",
        "dedupe_key": "c-1:inbound:guardrail.blocked:item-1:pv-1",
        "created_at": NOW - timedelta(hours=1),
        "resolved_at": NOW - timedelta(minutes=5),
    }
    base.update(kw)
    return SimpleNamespace(**base)


def _resolver(row: Any = None, *, fail: bool = False) -> TenantConfigResolver:
    class _Session:
        async def __aenter__(self) -> Any:
            return self

        async def __aexit__(self, *_: Any) -> None:
            return None

        async def execute(self, _statement: Any) -> Any:
            if fail:
                raise ConnectionError("db down")
            return SimpleNamespace(first=lambda: row)

    return TenantConfigResolver(session_factory=_Session, cache_ttl_s=60)


# ── verification ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_resolved_acknowledged_notice_of_the_same_tenant_verifies() -> None:
    verdict = await _resolver(_row()).verify_guardrail_override(TENANT, NOTICE, now=NOW)
    assert verdict.ok
    assert verdict.dedupe_key == "c-1:inbound:guardrail.blocked:item-1:pv-1"


@pytest.mark.parametrize(
    ("row", "reason"),
    [
        (None, "unknown_notice"),
        (_row(tenant_id="other-tenant"), "tenant_mismatch"),
        (_row(status="ACKNOWLEDGED"), "not_resolved"),
        (_row(resolution="item_excluded"), "not_acknowledged"),
        (_row(created_at=NOW - timedelta(hours=25)), "expired"),
    ],
)
@pytest.mark.asyncio
async def test_every_other_notice_is_rejected(row: Any, reason: str) -> None:
    verdict = await _resolver(row).verify_guardrail_override(TENANT, NOTICE, now=NOW)
    assert not verdict.ok
    assert verdict.reason == reason


@pytest.mark.asyncio
async def test_a_db_outage_rejects_and_never_raises() -> None:
    verdict = await _resolver(fail=True).verify_guardrail_override(TENANT, NOTICE, now=NOW)
    assert (verdict.ok, verdict.reason) == (False, "db_unavailable")


@pytest.mark.asyncio
async def test_a_malformed_id_is_rejected_without_a_query() -> None:
    verdict = await _resolver(fail=True).verify_guardrail_override(TENANT, "x' OR 1=1", now=NOW)
    assert (verdict.ok, verdict.reason) == (False, "malformed_notice_id")


# ── the downgrade ─────────────────────────────────────────────────────────────


def _blocked(name: str, item: str = "item-1") -> CheckOutcome:
    return CheckOutcome(
        name=name,
        outcome="flag",
        fail_mode="closed",
        model="m",
        verdict="flag",
        action="block",
        action_taken="block",
        category="unsafe",
        region_keys=("transcript",),
        flagged_regions=("transcript",),
        items=((item, 2),),
        flagged_items=((item, 2),),
    )


def _decision(*checks: CheckOutcome) -> GuardrailDecision:
    return GuardrailDecision(
        tenant_id=TENANT,
        direction="inbound",
        decision="block",
        checks=list(checks),
        guardrail_decision="block",
        policy_version="pv-1",
    )


CORRELATION = GuardrailCorrelation(request_id="req-1", consultation_id="c-1")


def test_the_notice_key_is_the_one_its_id_is_derived_from() -> None:
    (notice,) = build_notices(
        _decision(_blocked("prompt_safety")),
        tenant_id=TENANT,
        correlation=CORRELATION,
        policy_version="pv-1",
        occurred_at="t",
    )
    assert notice["noticeId"] == notice_id_for(TENANT, "c-1:inbound:guardrail.blocked:item-1:pv-1")


def test_a_verified_override_downgrades_the_checks_of_its_own_notice_only() -> None:
    # TASK-1050 follow-up E (round 2): one notice per type lists every item and check, so an
    # override of THAT notice downgrades both blocks — while the notice of an earlier, smaller
    # item set (item-1 alone) is another notice and moves nothing.
    decision = _decision(_blocked("prompt_safety"), _blocked("prompt_toxicity", item="item-2"))
    stale = apply_guardrail_override(
        decision,
        correlation=CORRELATION,
        dedupe_key="c-1:inbound:guardrail.blocked:item-1:pv-1",
        notice_id=NOTICE,
    )
    assert stale is decision
    out = apply_guardrail_override(
        decision,
        correlation=CORRELATION,
        dedupe_key="c-1:inbound:guardrail.blocked:item-1,item-2:pv-1",
        notice_id=NOTICE,
    )
    by_name = {c.name: c for c in out.checks}
    assert by_name["prompt_safety"].action_taken == "warn"
    assert by_name["prompt_safety"].override_notice_id == NOTICE
    assert by_name["prompt_toxicity"].action_taken == "warn"
    assert out.guardrail_decision == "warn"

    alone = apply_guardrail_override(
        _decision(_blocked("prompt_safety")),
        correlation=CORRELATION,
        dedupe_key="c-1:inbound:guardrail.blocked:item-1:pv-1",
        notice_id=NOTICE,
    )
    assert alone.guardrail_decision == "warn"
    assert alone.decision == "allow"
    assert alone.reasons == []


def test_the_locked_medical_check_is_never_downgraded() -> None:
    medical = _blocked("medical_validation")
    out = apply_guardrail_override(
        _decision(medical),
        correlation=CORRELATION,
        dedupe_key="c-1:inbound:guardrail.blocked:item-1:pv-1",
        notice_id=NOTICE,
    )
    assert out.checks[0].action_taken == "block"
    assert out.checks[0].override_notice_id is None
    assert out.guardrail_decision == "block"


def test_the_record_marks_the_overridden_check() -> None:
    from guardrail.services.evaluation_outbox import build_evaluation_record

    out = apply_guardrail_override(
        _decision(_blocked("prompt_safety")),
        correlation=CORRELATION,
        dedupe_key="c-1:inbound:guardrail.blocked:item-1:pv-1",
        notice_id=NOTICE,
    )
    notices = build_notices(
        out, tenant_id=TENANT, correlation=CORRELATION, policy_version="pv-1", occurred_at="t"
    )
    record = build_evaluation_record(
        out,
        tenant_id=TENANT,
        correlation=CORRELATION,
        caller="harness.guardrail_check",
        notices=notices,
        occurred_at="t",
    )
    check = next(c for c in record["checks"] if c["checkId"] == "prompt_safety")
    assert check["actionTaken"] == "warn"
    assert check["override"] is True
    assert check["noticeId"] == NOTICE
    assert record["decision"] == "warn"


# ── the route ─────────────────────────────────────────────────────────────────


class _Analyzer:
    async def classify_tasks(self, task_names: Any, text: str) -> dict[str, Any]:
        return {t: ["unsafe" if t == "prompt_safety" else "benign"] for t in task_names}

    async def extract_pii_entities(self, text: str) -> list[Any]:
        return []

    def model_for(self, check: str) -> str:
        return "m"


async def _route(monkeypatch: Any, resolver: Any, headers: dict[str, str]) -> Any:
    import guardrail.api.endpoints.screen as screen_mod
    from guardrail.api.endpoints.screen import InboundScreenRequest, screen_inbound

    async def _build(app_state: Any, tenant_id: str, **_: Any) -> Screener:
        return Screener(analyzer=_Analyzer(), tenant_id=tenant_id, policy_version="pv-1")

    monkeypatch.setattr(screen_mod, "build_screener", _build)

    class _Outbox:
        records: list[dict[str, Any]] = []

        async def append(self, record: dict[str, Any]) -> bool:
            self.records.append(record)
            return True

    request = SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                admission_gates={}, evaluation_outbox=_Outbox(), tenant_config_resolver=resolver
            )
        ),
        headers={"X-Tenant-Id": TENANT, "X-Hope-Consultation-Id": "c-1", **headers},
    )
    body = InboundScreenRequest(
        regions=[
            {
                "key": "transcript",
                "text": "x",
                "trust": "instruction",
                "items": [{"itemId": "item-1", "itemVersion": 2}],
            }
        ]
    )
    return await screen_inbound(body, request)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_the_route_honours_a_verified_override(monkeypatch: Any) -> None:
    class _Resolver:
        async def verify_guardrail_override(self, tenant_id: str, notice_id: str, **_: Any) -> Any:
            assert (tenant_id, notice_id) == (TENANT, NOTICE)
            return SimpleNamespace(
                ok=True, reason="", dedupe_key="c-1:inbound:guardrail.blocked:item-1:pv-1"
            )

    response = await _route(monkeypatch, _Resolver(), {"X-Hope-Guardrail-Override": NOTICE})
    assert response.decision == "allow"
    assert response.guardrail_decision == "warn"
    check = next(c for c in response.checks if c["name"] == "prompt_safety")
    assert check["actionTaken"] == "warn"


@pytest.mark.asyncio
async def test_the_route_ignores_a_rejected_or_failing_override(monkeypatch: Any) -> None:
    class _Rejecting:
        async def verify_guardrail_override(self, tenant_id: str, notice_id: str, **_: Any) -> Any:
            return SimpleNamespace(ok=False, reason="tenant_mismatch", dedupe_key=None)

    class _Raising:
        async def verify_guardrail_override(self, tenant_id: str, notice_id: str, **_: Any) -> Any:
            raise RuntimeError("boom")

    for resolver in (_Rejecting(), _Raising(), None):
        response = await _route(monkeypatch, resolver, {"X-Hope-Guardrail-Override": NOTICE})
        assert response.decision == "block"
        assert response.guardrail_decision == "block"


@pytest.mark.asyncio
async def test_no_header_no_lookup(monkeypatch: Any) -> None:
    class _Exploding:
        async def verify_guardrail_override(self, *a: Any, **k: Any) -> Any:
            raise AssertionError("must not be called")

    response = await _route(monkeypatch, _Exploding(), {})
    assert response.guardrail_decision == "block"
