"""TASK-886 — per-tenant guardrail AVAILABILITY.

Availability is POLICY SELECTION, never gate removal. These tests pin the three
properties that make that true at runtime:

  1. absence — and an empty or all-disabled selection — resolves the SYSTEM set;
  2. a de-selected check is recorded as ``skipped``, and the gate still composes
     a verdict; there is no path that stops screening;
  3. the decision NAMES the tier that supplied the selection, so a verdict stays
     attributable.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from guardrail.core.availability import (
    DECLARED_POLICY_IDS,
    PLATFORM_DEFAULT_AVAILABILITY,
    GuardrailAvailability,
)
from guardrail.core.tenant_config import (
    SYSTEM_TENANT_ID,
    TASK_KEY_GUARDRAIL_AVAILABILITY,
)
from guardrail.services.screening import (
    _DECLARED_FAIL_MODES,
    DECISION_ALLOW,
    OUTCOME_SKIPPED,
    Screener,
)

CONTRACT = json.loads(
    (Path(__file__).parent / "contracts" / "availability-catalogue.json").read_text()
)


# ── the cross-language contract ───────────────────────────────────────────────


def test_declared_ids_match_the_contract_fixture() -> None:
    assert list(DECLARED_POLICY_IDS) == [p["id"] for p in CONTRACT["policies"]]


def test_declared_ids_are_exactly_the_screener_check_names() -> None:
    # The membership rule: a policy is selectable if and only if a screening
    # check reads the selection. Anything else would be a declared knob with no
    # reader — the `injectionScreeningCriteria` defect this ticket removed.
    assert set(DECLARED_POLICY_IDS) == set(_DECLARED_FAIL_MODES)


def test_platform_default_switches_every_declared_check_on() -> None:
    for policy_id in DECLARED_POLICY_IDS:
        assert PLATFORM_DEFAULT_AVAILABILITY.is_enabled(policy_id)


def test_threshold_specs_match_the_contract() -> None:
    for entry in CONTRACT["policies"]:
        spec = GuardrailAvailability.threshold_spec(entry["id"])
        if "threshold" not in entry:
            assert spec is None
            continue
        assert spec is not None
        assert spec.field == entry["threshold"]["field"]
        assert spec.floor_direction == entry["threshold"]["floorDirection"]


# ── resolution ────────────────────────────────────────────────────────────────


def test_absent_blob_resolves_the_platform_default() -> None:
    resolved = GuardrailAvailability.from_blob(None)
    assert resolved.policies == PLATFORM_DEFAULT_AVAILABILITY.policies


def test_empty_selection_is_not_an_off_switch() -> None:
    resolved = GuardrailAvailability.from_blob({})
    assert resolved.policies == PLATFORM_DEFAULT_AVAILABILITY.policies


def test_all_disabled_selection_is_not_an_off_switch() -> None:
    resolved = GuardrailAvailability.from_blob({"pii_leak": {"enabled": False}})
    assert resolved.policies == PLATFORM_DEFAULT_AVAILABILITY.policies


def test_a_real_selection_is_honoured_verbatim() -> None:
    resolved = GuardrailAvailability.from_blob(
        {"prompt_safety": {"enabled": True}}, source_tenant_id="tenant-a"
    )
    assert resolved.is_enabled("prompt_safety")
    assert not resolved.is_enabled("prompt_toxicity")
    assert resolved.source_tenant_id == "tenant-a"


# ── tighten-only composition ──────────────────────────────────────────────────


def test_tighten_takes_the_stricter_of_platform_and_tenant() -> None:
    # `pii_leak.minScore` is lower-is-stricter: a lower floor inspects more spans.
    strict = GuardrailAvailability.from_blob({"pii_leak": {"enabled": True, "minScore": 0.1}})
    assert strict.tighten("pii_leak", 0.5) == 0.1


def test_tighten_never_loosens_even_if_the_row_says_so() -> None:
    # The write lane refuses a loosening value with 403, but a row written by
    # any other means (SQL, an older seed) must not be able to loosen the gate.
    loose = GuardrailAvailability.from_blob({"pii_leak": {"enabled": True, "minScore": 0.9}})
    assert loose.tighten("pii_leak", 0.5) == 0.5


def test_tighten_returns_the_platform_value_when_the_row_has_none() -> None:
    assert (
        GuardrailAvailability.from_blob({"pii_leak": {"enabled": True}}).tighten("pii_leak", 0.5)
        == 0.5
    )


# ── the screener honours the selection, and always gates ──────────────────────


class _StubAnalyzer:
    def __init__(self) -> None:
        self.classified: list[tuple[str, ...]] = []

    async def classify_tasks(self, task_names: tuple[str, ...], text: str) -> dict[str, Any]:
        self.classified.append(tuple(task_names))
        return dict.fromkeys(task_names, "benign")

    async def extract_pii_entities(self, text: str) -> list[Any]:
        return []

    def model_for(self, check: str) -> str:
        return "stub-model"


def _screener(analyzer: Any, availability: GuardrailAvailability) -> Screener:
    return Screener(
        analyzer=analyzer,
        tenant_id="tenant-a",
        policy_source_tenant_id=SYSTEM_TENANT_ID,
        availability=availability,
    )


@pytest.mark.asyncio
async def test_inbound_runs_only_the_selected_checks() -> None:
    analyzer = _StubAnalyzer()
    availability = GuardrailAvailability.from_blob(
        {"prompt_safety": {"enabled": True}, "response_safety": {"enabled": True}},
        source_tenant_id="tenant-a",
    )
    decision = await _screener(analyzer, availability).screen_inbound("hello")

    # Only the selected task reached the delegated classifier...
    assert analyzer.classified == [("prompt_safety",)]
    # ...but every declared inbound check is still ON THE RECORD.
    by_name = {check.name: check for check in decision.checks}
    assert set(by_name) == {"jailbreak_detection", "prompt_safety", "prompt_toxicity"}
    assert by_name["jailbreak_detection"].outcome == OUTCOME_SKIPPED
    assert by_name["jailbreak_detection"].reason == "not_selected_for_tenant"
    assert by_name["prompt_safety"].outcome == "pass"


@pytest.mark.asyncio
async def test_the_gate_still_runs_when_nothing_is_selected_for_a_direction() -> None:
    analyzer = _StubAnalyzer()
    availability = GuardrailAvailability.from_blob({"response_safety": {"enabled": True}})
    decision = await _screener(analyzer, availability).screen_inbound("hello")

    # No delegated call was made, but a DECISION still exists and every check is
    # accounted for. There is no path that simply stops screening.
    assert analyzer.classified == []
    assert decision.decision == DECISION_ALLOW
    assert all(check.outcome == OUTCOME_SKIPPED for check in decision.checks)


@pytest.mark.asyncio
async def test_outbound_honours_the_selection_for_pii_and_containment() -> None:
    analyzer = _StubAnalyzer()
    availability = GuardrailAvailability.from_blob({"response_safety": {"enabled": True}})
    decision = await _screener(analyzer, availability).screen_outbound(
        "a response", source_context="a response", nonce="abc"
    )
    by_name = {check.name: check for check in decision.checks}
    assert by_name["pii_leak"].outcome == OUTCOME_SKIPPED
    assert by_name["pii_leak"].reason == "not_selected_for_tenant"
    assert by_name["containment_echo"].outcome == OUTCOME_SKIPPED
    assert by_name["containment_echo"].reason == "not_selected_for_tenant"


@pytest.mark.asyncio
async def test_the_decision_names_the_tier_that_supplied_the_selection() -> None:
    analyzer = _StubAnalyzer()
    availability = GuardrailAvailability.from_blob(
        {"prompt_safety": {"enabled": True}}, source_tenant_id="tenant-a"
    )
    decision = await _screener(analyzer, availability).screen_inbound("hello")
    assert decision.availability_source_tenant_id == "tenant-a"
    assert decision.to_dict()["availabilitySourceTenantId"] == "tenant-a"


@pytest.mark.asyncio
async def test_a_screener_with_no_availability_screens_everything() -> None:
    # Backward compatibility AND the safe default: an un-wired screener applies
    # the full declared set rather than nothing.
    analyzer = _StubAnalyzer()
    decision = await Screener(analyzer=analyzer, tenant_id="tenant-a").screen_inbound("hello")
    assert analyzer.classified == [("jailbreak_detection", "prompt_safety", "prompt_toxicity")]
    assert decision.availability_source_tenant_id is None


# ── the resolver's pseudo task key ────────────────────────────────────────────


def test_availability_task_key_is_tenant_keyed_like_every_other() -> None:
    # The cache key format is `f"{task_key}::{tenant_id}"` (rule 06 — it is
    # MANDATORY that it stay tenant-keyed), and availability rides the same
    # machinery rather than inventing a second cache.
    assert TASK_KEY_GUARDRAIL_AVAILABILITY == "guardrail.availability"


# ── the resolver's own read ───────────────────────────────────────────────────


class _FakeResult:
    def __init__(self, row: Any) -> None:
        self._row = row

    def first(self) -> Any:
        return self._row


class _FakeSession:
    def __init__(self, row: Any) -> None:
        self._row = row

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *_: Any) -> None:
        return None

    async def execute(self, _statement: Any) -> _FakeResult:
        return _FakeResult(self._row)


def _resolver(rows: dict[str, Any]) -> Any:
    from guardrail.core.tenant_config import TenantConfigResolver

    def factory() -> _FakeSession:
        return _FakeSession(factory.next_row)  # type: ignore[attr-defined]

    resolver = TenantConfigResolver(session_factory=factory, cache_ttl_s=60)

    async def _load(tenant_id: str, task_key: str) -> dict[str, str]:
        factory.next_row = rows.get(tenant_id)  # type: ignore[attr-defined]
        return await original(tenant_id, task_key)

    original = resolver._load_from_db
    resolver._load_from_db = _load  # type: ignore[method-assign]
    return resolver


@pytest.mark.asyncio
async def test_resolver_widens_to_system_when_the_tenant_has_no_row() -> None:
    resolver = _resolver({SYSTEM_TENANT_ID: ({"prompt_safety": {"enabled": True}},)})
    resolved = await resolver.resolve_availability("tenant-a")
    assert resolved.is_enabled("prompt_safety")
    assert not resolved.is_enabled("prompt_toxicity")
    assert resolved.source_tenant_id == SYSTEM_TENANT_ID


@pytest.mark.asyncio
async def test_resolver_prefers_the_tenants_own_row() -> None:
    resolver = _resolver(
        {
            "tenant-a": ({"response_safety": {"enabled": True}},),
            SYSTEM_TENANT_ID: ({"prompt_safety": {"enabled": True}},),
        }
    )
    resolved = await resolver.resolve_availability("tenant-a")
    assert resolved.is_enabled("response_safety")
    assert resolved.source_tenant_id == "tenant-a"


@pytest.mark.asyncio
async def test_resolver_treats_an_all_disabled_row_as_absence() -> None:
    # The mechanism behind "there is no off": an all-disabled row is
    # indistinguishable from an absent one, so it widens to SYSTEM.
    resolver = _resolver(
        {
            "tenant-a": ({"response_safety": {"enabled": False}},),
            SYSTEM_TENANT_ID: ({"prompt_safety": {"enabled": True}},),
        }
    )
    resolved = await resolver.resolve_availability("tenant-a")
    assert resolved.is_enabled("prompt_safety")
    assert resolved.source_tenant_id == SYSTEM_TENANT_ID


@pytest.mark.asyncio
async def test_the_availability_cache_key_is_tenant_keyed() -> None:
    resolver = _resolver({SYSTEM_TENANT_ID: ({"prompt_safety": {"enabled": True}},)})
    await resolver.resolve_availability("tenant-a")
    # `f"{task_key}::{tenant_id}"` — mandatory per rule 06. Serving one tenant's
    # selection to another is exactly what a key without the tenant does.
    assert f"{TASK_KEY_GUARDRAIL_AVAILABILITY}::{SYSTEM_TENANT_ID}" in resolver._cache
    assert f"{TASK_KEY_GUARDRAIL_AVAILABILITY}::tenant-a" in resolver._cache


# ── the dependency layer ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unresolvable_availability_screens_EVERYTHING_rather_than_503() -> None:
    from types import SimpleNamespace

    from guardrail.core.dependencies import _resolve_availability

    class _Broken:
        async def resolve_availability(self, tenant_id: str) -> Any:
            raise RuntimeError("db down")

    resolved = await _resolve_availability(
        SimpleNamespace(tenant_config_resolver=_Broken()), "tenant-a"
    )
    # Unlike an unresolved model SELECTION (503, nothing to run), an unresolved
    # AVAILABILITY has a strictest answer in code. More screening is the safe
    # direction; less is not.
    for policy_id in DECLARED_POLICY_IDS:
        assert resolved.is_enabled(policy_id)


@pytest.mark.asyncio
async def test_an_unwired_resolver_also_screens_everything() -> None:
    from types import SimpleNamespace

    from guardrail.core.dependencies import _resolve_availability

    resolved = await _resolve_availability(SimpleNamespace(), "tenant-a")
    assert resolved.policies == PLATFORM_DEFAULT_AVAILABILITY.policies


# ── the screening routes carry the attribution ───────────────────────────────


@pytest.mark.asyncio
async def test_both_screen_routes_report_the_availability_tier(monkeypatch: Any) -> None:
    from types import SimpleNamespace

    import guardrail.api.endpoints.screen as screen_mod
    from guardrail.api.endpoints.screen import (
        InboundScreenRequest,
        OutboundScreenRequest,
        screen_inbound,
        screen_outbound,
    )

    async def _build(app_state: Any, tenant_id: str) -> Screener:
        return Screener(
            analyzer=_StubAnalyzer(),
            tenant_id=tenant_id,
            policy_source_tenant_id=SYSTEM_TENANT_ID,
            availability=GuardrailAvailability.from_blob(
                {"prompt_safety": {"enabled": True}, "response_safety": {"enabled": True}},
                source_tenant_id="tenant-a",
            ),
        )

    monkeypatch.setattr(screen_mod, "build_screener", _build)

    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(admission_gates={})),
        headers={"X-Tenant-Id": "tenant-a"},
    )

    inbound = await screen_inbound(InboundScreenRequest(text="hello"), request)  # type: ignore[arg-type]
    outbound = await screen_outbound(OutboundScreenRequest(response="hi"), request)  # type: ignore[arg-type]

    # BOTH the pre-send and the post-receive screen honour the selection and name
    # the tier that supplied it.
    assert inbound.availability_source_tenant_id == "tenant-a"
    assert outbound.availability_source_tenant_id == "tenant-a"
    assert {c["name"] for c in inbound.checks if c["reason"] == "not_selected_for_tenant"} == {
        "jailbreak_detection",
        "prompt_toxicity",
    }
    assert {c["name"] for c in outbound.checks if c["reason"] == "not_selected_for_tenant"} == {
        "response_toxicity",
        "response_refusal",
        "jailbreak_detection",
        "pii_leak",
        "containment_echo",
    }


# ── the removed key ───────────────────────────────────────────────────────────


def test_injection_screening_criteria_is_gone() -> None:
    # It was declared fail-CLOSED with no reader anywhere. A governed knob that
    # cannot move anything is worse than an absent one, because an admin who sets
    # it sees neither an effect nor an error.
    from guardrail.core.policy import GuardrailPolicy

    assert "injectionScreeningCriteria" not in GuardrailPolicy.DECLARED_KEYS
