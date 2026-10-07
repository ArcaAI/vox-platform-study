"""TASK-1050 W2a2 — tenant guardrail policy v2 on the Python plane.

Pins:

* the Python catalogue defaults against BOTH frozen artifacts
  (`availability-catalogue.json` and `tests/contracts/guardrail-policy.fixture.json`);
* :func:`normalize_tenant_guardrail_policy` against every `normalize` case of the frozen
  fixture (the TypeScript `normalizeTenantGuardrailPolicy` is pinned to the same cases);
* the effective cascade platform default → SYSTEM row → tenant row, per FIELD;
* the catalogue lock (medical validation), direction-off = monitor only (OD-7) and the
  data-region action (OD-12).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from guardrail.core.availability import (
    CATALOGUE_DEFAULTS,
    DECLARED_POLICY_IDS,
    PLATFORM_DEFAULT_AVAILABILITY,
    GuardrailAvailability,
    normalize_tenant_guardrail_policy,
)
from guardrail.core.tenant_config import SYSTEM_TENANT_ID

_HERE = Path(__file__).parent
_REPO = _HERE.parents[4]
CATALOGUE = json.loads((_HERE / "contracts" / "availability-catalogue.json").read_text())
POLICY_FIXTURE = json.loads(
    (_REPO / "tests" / "contracts" / "guardrail-policy.fixture.json").read_text()
)


def test_catalogue_defaults_match_the_availability_catalogue() -> None:
    assert list(DECLARED_POLICY_IDS) == [p["id"] for p in CATALOGUE["policies"]]
    for entry in CATALOGUE["policies"]:
        spec = CATALOGUE_DEFAULTS[entry["id"]]
        assert spec.directions == tuple(entry["directions"])
        assert spec.allowed_actions == tuple(entry["allowedActions"])
        assert spec.action == entry["platformDefaultAction"]
        assert spec.locked is entry["locked"]
        assert spec.enabled is entry["defaultEnabled"]
        assert spec.inbound_regions == tuple(entry.get("inboundRegions", ()))
        assert spec.data_region_action == entry.get("platformDefaultDataRegionAction")


def test_catalogue_defaults_match_the_policy_fixture_defaults() -> None:
    for check_id, default in POLICY_FIXTURE["defaults"].items():
        spec = CATALOGUE_DEFAULTS[check_id]
        assert spec.enabled is default["enabled"]
        assert spec.action == default["action"]
        assert spec.locked is default["locked"]
        assert list(spec.allowed_actions) == default["allowedActions"]


@pytest.mark.parametrize("case", POLICY_FIXTURE["normalize"], ids=lambda c: c["name"])
def test_normalizer_mirrors_the_typescript_contract(case: dict[str, Any]) -> None:
    assert normalize_tenant_guardrail_policy(case["input"]) == case["expected"]


def test_normalizer_is_idempotent() -> None:
    for case in POLICY_FIXTURE["normalize"]:
        once = normalize_tenant_guardrail_policy(case["input"])
        assert normalize_tenant_guardrail_policy(once) == once


# ── the effective cascade ─────────────────────────────────────────────────────


def test_platform_default_is_the_catalogue_default() -> None:
    for check_id, spec in CATALOGUE_DEFAULTS.items():
        assert PLATFORM_DEFAULT_AVAILABILITY.is_enabled(check_id) is spec.enabled
        assert PLATFORM_DEFAULT_AVAILABILITY.action_for(check_id, spec.directions[0]) == spec.action


def test_a_legacy_flat_row_becomes_v2_and_absent_checks_take_the_default() -> None:
    resolved = GuardrailAvailability.from_tiers(
        system_blob={
            "prompt_safety": {"enabled": False},
            "pii_leak": {"enabled": True, "minScore": 0.2},
        },
        tenant_blob=None,
    )
    assert not resolved.is_enabled("prompt_safety")
    assert resolved.is_enabled("prompt_toxicity")  # absent = no opinion = platform default
    assert not resolved.is_enabled("injection_judge")  # judges ship OFF
    assert resolved.tighten("pii_leak", 0.5) == 0.2


def test_tenant_field_wins_over_system_field_which_wins_over_default() -> None:
    resolved = GuardrailAvailability.from_tiers(
        system_blob={
            "checks": {
                "prompt_safety": {"enabled": True, "action": "warn"},
                "unsafe_content_judge": {"enabled": True, "action": "block"},
            }
        },
        # The tenant only toggles `enabled`; it must NOT reset the platform action.
        tenant_blob={"checks": {"prompt_safety": {"enabled": False}}},
        source_tenant_id="tenant-a",
    )
    assert not resolved.is_enabled("prompt_safety")
    assert resolved.action_for("prompt_safety", "inbound") == "warn"
    assert resolved.is_enabled("unsafe_content_judge")
    assert resolved.action_for("unsafe_content_judge", "inbound") == "block"
    assert resolved.source_tenant_id == "tenant-a"


def test_a_tenant_legacy_entry_never_overrides_a_platform_action() -> None:
    resolved = GuardrailAvailability.from_tiers(
        system_blob={"checks": {"prompt_toxicity": {"enabled": True, "action": "ignore"}}},
        tenant_blob={"prompt_toxicity": {"enabled": True}},
    )
    assert resolved.action_for("prompt_toxicity", "inbound") == "ignore"


def test_an_action_outside_allowed_actions_falls_back_to_the_default() -> None:
    resolved = GuardrailAvailability.from_tiers(
        system_blob={"checks": {"prompt_safety": {"enabled": True, "action": "explode"}}},
        tenant_blob=None,
    )
    assert resolved.action_for("prompt_safety", "inbound") == "block"


# ── the lock, direction off, data regions ─────────────────────────────────────


def test_the_locked_medical_check_is_always_on_and_always_blocks() -> None:
    resolved = GuardrailAvailability.from_tiers(
        system_blob={"checks": {"medical_validation": {"enabled": False, "action": "warn"}}},
        tenant_blob={
            "directions": {"inbound": {"enabled": False}},
            "checks": {"medical_validation": {"enabled": False, "action": "ignore"}},
        },
    )
    assert resolved.is_enabled("medical_validation")
    assert resolved.is_locked("medical_validation")
    # Even with the inbound direction switched to monitor-only.
    assert resolved.action_for("medical_validation", "inbound") == "block"
    assert resolved.action_for("medical_validation", "inbound", trust="data") == "block"


def test_direction_off_runs_every_check_of_that_direction_at_ignore() -> None:
    resolved = GuardrailAvailability.from_tiers(
        system_blob=None,
        tenant_blob={"directions": {"outbound": {"enabled": False}}},
    )
    assert not resolved.direction_enabled("outbound")
    assert resolved.direction_enabled("inbound")
    # Still enabled — monitor only, never skipped (OD-7 (a)).
    assert resolved.is_enabled("response_safety")
    assert resolved.action_for("response_safety", "outbound") == "ignore"
    # jailbreak_detection is on both directions: only its outbound action moves.
    assert resolved.action_for("jailbreak_detection", "outbound") == "ignore"
    assert resolved.action_for("jailbreak_detection", "inbound") == "block"


def test_a_tenant_direction_wins_over_the_system_direction() -> None:
    resolved = GuardrailAvailability.from_tiers(
        system_blob={"directions": {"inbound": {"enabled": False}}},
        tenant_blob={"directions": {"inbound": {"enabled": True}}},
    )
    assert resolved.direction_enabled("inbound")


def test_data_region_action_defaults_to_ignore_and_a_platform_admin_may_raise_it() -> None:
    default = PLATFORM_DEFAULT_AVAILABILITY
    assert default.action_for("prompt_safety", "inbound", trust="data") == "ignore"
    assert default.action_for("prompt_safety", "inbound", trust="instruction") == "block"
    raised = GuardrailAvailability.from_tiers(
        system_blob={
            "checks": {
                "prompt_safety": {"enabled": True, "action": "block", "dataRegionAction": "warn"}
            }
        },
        tenant_blob=None,
    )
    assert raised.action_for("prompt_safety", "inbound", trust="data") == "warn"


def test_a_data_only_judge_uses_its_own_action_on_data() -> None:
    resolved = GuardrailAvailability.from_tiers(
        system_blob={"checks": {"unsafe_content_judge": {"enabled": True}}}, tenant_blob=None
    )
    assert resolved.action_for("unsafe_content_judge", "inbound", trust="data") == "warn"


def test_a_direction_with_no_enabled_check_falls_back_to_the_catalogue_defaults() -> None:
    every_outbound_off = {
        "checks": {
            check_id: {"enabled": False}
            for check_id, spec in CATALOGUE_DEFAULTS.items()
            if "outbound" in spec.directions
        }
    }
    resolved = GuardrailAvailability.from_tiers(system_blob=None, tenant_blob=every_outbound_off)
    # There is still no "off": an empty direction is screened with the platform set.
    assert resolved.is_enabled("response_safety")
    assert resolved.is_enabled("pii_leak")


@pytest.mark.asyncio
async def test_the_resolver_merges_the_system_and_tenant_rows() -> None:
    from guardrail.core.tenant_config import TenantConfigResolver

    rows = {
        SYSTEM_TENANT_ID: {"checks": {"prompt_safety": {"enabled": True, "action": "warn"}}},
        "tenant-a": {"checks": {"prompt_toxicity": {"enabled": False}}},
    }

    class _Session:
        def __init__(self, row: Any) -> None:
            self._row = row

        async def __aenter__(self) -> Any:
            return self

        async def __aexit__(self, *_: Any) -> None:
            return None

        async def execute(self, _statement: Any) -> Any:
            row = self._row

            class _Result:
                def first(self) -> Any:
                    return (row,) if row is not None else None

            return _Result()

    current: dict[str, Any] = {}

    resolver = TenantConfigResolver(
        session_factory=lambda: _Session(current.get("row")), cache_ttl_s=60
    )
    original = resolver._load_from_db

    async def _load(tenant_id: str, task_key: str) -> dict[str, str]:
        current["row"] = rows.get(tenant_id)
        return await original(tenant_id, task_key)

    resolver._load_from_db = _load  # type: ignore[method-assign]

    resolved = await resolver.resolve_availability("tenant-a")
    assert resolved.action_for("prompt_safety", "inbound") == "warn"
    assert not resolved.is_enabled("prompt_toxicity")
    assert resolved.source_tenant_id == "tenant-a"
