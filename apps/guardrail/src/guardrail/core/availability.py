"""Per-tenant guardrail AVAILABILITY — WHICH checks apply, and what a violation DOES.

Owner decision #3 (TASK-870 target model item 5) made guardrail built-in and
platform-only. TASK-1050 (README §9.3, §11.1) refines it: a tenant admin may turn
checks and directions on/off; a PLATFORM admin sets the action each violation
takes (`ignore` | `warn` | `block`), locks, thresholds and the data-region action.

**Tenant guardrail policy v2.** `TenantGuardrailPolicy.policies` is read through
:func:`normalize_tenant_guardrail_policy`, a line-for-line mirror of the frozen
TypeScript `normalizeTenantGuardrailPolicy` (`packages/types/src/guardrail-policy.ts`),
pinned to the same fixture cases (`tests/contracts/guardrail-policy.fixture.json`).
The legacy flat shape `{check: {enabled, minScore?}}` is read as v2: an entry it does
not name is NO OPINION, so the platform default applies.

**The effective value of every field cascades** platform default (the catalogue,
below) → SYSTEM row → tenant row, FIELD by field (:meth:`GuardrailAvailability.from_tiers`).
Field-level, because a tenant row that only toggles `enabled` must never reset the
action a platform admin set on the SYSTEM row.

Three properties are enforced here rather than remembered:

1. **There is no "off".** A direction in which no unlocked check is enabled is screened
   with the catalogue defaults instead (logged). Switching a DIRECTION off is monitor
   only: every check of that direction runs at `ignore` (OD-7 (a)), never skipped.
2. **The catalogue lock wins.** A `locked` check (medical validation, OD-9) is always
   enabled and always `block`, whatever any row says and even in a monitor-only
   direction.
3. **A threshold can only ever be tightened** (:meth:`GuardrailAvailability.tighten`,
   unchanged from TASK-886).

**Membership rule (TASK-886).** Every id below is a check name in
``services/screening.py::_DECLARED_FAIL_MODES``; ``test_task886_availability.py``
asserts the two sets are equal. The defaults are declared HERE and pinned against
``tests/contracts/availability-catalogue.json`` (which the gateway catalogue and the
SYSTEM seed are pinned against too) — declared in code so the runtime never reads a
test artifact, pinned so it cannot drift.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final

from guardrail.core.logging import get_logger

logger = get_logger(__name__)

#: Lower value ⇒ stricter (a lower score floor inspects MORE spans).
LOWER_IS_STRICTER: Final = "lower-is-stricter"
#: Higher value ⇒ stricter (a claim must clear a higher bar).
HIGHER_IS_STRICTER: Final = "higher-is-stricter"

ACTION_IGNORE: Final = "ignore"
ACTION_WARN: Final = "warn"
ACTION_BLOCK: Final = "block"
ACTIONS: Final[tuple[str, ...]] = (ACTION_IGNORE, ACTION_WARN, ACTION_BLOCK)

DIRECTIONS: Final[tuple[str, ...]] = ("inbound", "outbound")
TRUST_INSTRUCTION: Final = "instruction"
TRUST_DATA: Final = "data"

SET_BY: Final[tuple[str, ...]] = ("platform_admin", "tenant_admin")


@dataclass(frozen=True)
class ThresholdSpec:
    """The one strictness field a policy accepts, and which way it tightens."""

    field: str
    floor_direction: str


@dataclass(frozen=True)
class CheckDefault:
    """One check's platform default, exactly as the catalogue declares it."""

    directions: tuple[str, ...]
    allowed_actions: tuple[str, ...]
    action: str
    locked: bool
    enabled: bool
    inbound_regions: tuple[str, ...] = ()
    data_region_action: str | None = None


_ALL: Final = ACTIONS
_CLASSIFIER_INBOUND: Final = (TRUST_INSTRUCTION, TRUST_DATA)

#: The catalogue, in contract order. Pinned by `test_task1050_screen_policy_v2.py`.
CATALOGUE_DEFAULTS: Final[dict[str, CheckDefault]] = {
    "jailbreak_detection": CheckDefault(
        ("inbound", "outbound"), _ALL, ACTION_BLOCK, False, True, _CLASSIFIER_INBOUND, ACTION_IGNORE
    ),
    "prompt_safety": CheckDefault(
        ("inbound",), _ALL, ACTION_BLOCK, False, True, _CLASSIFIER_INBOUND, ACTION_IGNORE
    ),
    "prompt_toxicity": CheckDefault(
        ("inbound",), _ALL, ACTION_BLOCK, False, True, _CLASSIFIER_INBOUND, ACTION_IGNORE
    ),
    "response_safety": CheckDefault(("outbound",), _ALL, ACTION_BLOCK, False, True),
    "response_toxicity": CheckDefault(("outbound",), _ALL, ACTION_BLOCK, False, True),
    "response_refusal": CheckDefault(("outbound",), _ALL, ACTION_BLOCK, False, False),
    "pii_leak": CheckDefault(("outbound",), _ALL, ACTION_BLOCK, False, True),
    "containment_echo": CheckDefault(("outbound",), _ALL, ACTION_BLOCK, False, True),
    "medical_validation": CheckDefault(
        ("inbound",), (ACTION_BLOCK,), ACTION_BLOCK, True, True, _CLASSIFIER_INBOUND
    ),
    "injection_judge": CheckDefault(("inbound",), _ALL, ACTION_IGNORE, False, False, (TRUST_DATA,)),
    "unsafe_content_judge": CheckDefault(
        ("inbound",), _ALL, ACTION_WARN, False, False, (TRUST_DATA,)
    ),
    "clinical_safety_judge": CheckDefault(("outbound",), _ALL, ACTION_WARN, False, False),
    "leakage_judge": CheckDefault(("outbound",), _ALL, ACTION_BLOCK, False, False),
}

#: The selectable policies, in contract order. Membership rule above.
DECLARED_POLICY_IDS: Final[tuple[str, ...]] = tuple(CATALOGUE_DEFAULTS)

INBOUND_JUDGE_IDS: Final[tuple[str, ...]] = ("injection_judge", "unsafe_content_judge")
OUTBOUND_JUDGE_IDS: Final[tuple[str, ...]] = ("clinical_safety_judge", "leakage_judge")
JUDGE_IDS: Final[tuple[str, ...]] = INBOUND_JUDGE_IDS + OUTBOUND_JUDGE_IDS
MEDICAL_VALIDATION: Final = "medical_validation"

#: Only `pii_leak` carries a strictness today, and it has a READER
#: (`Screener._pii_leak_min_score`).
_THRESHOLDS: Final[dict[str, ThresholdSpec]] = {
    "pii_leak": ThresholdSpec("minScore", LOWER_IS_STRICTER),
}


# ── the normalizer (mirror of packages/types/src/guardrail-policy.ts) ──────────


def _is_action(value: Any) -> bool:
    return isinstance(value, str) and value in ACTIONS


def _is_score(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and value == value  # not NaN
        and value not in (float("inf"), float("-inf"))
        and 0 <= value <= 1
    )


def _checks_source(raw: dict[str, Any], v2: bool) -> dict[str, Any]:
    """Where a blob's per-check entries live: `checks` (v2) or the top level (legacy)."""
    if not v2:
        return raw
    checks = raw.get("checks")
    return checks if isinstance(checks, dict) else {}


def is_tenant_guardrail_policy_v2(raw: Any) -> bool:
    """v2 is told from the legacy flat shape structurally (`checks` / `directions`)."""
    return isinstance(raw, dict) and ("checks" in raw or "directions" in raw)


def _normalize_entry(
    raw: Any, fallback: CheckDefault, legacy: bool, enforce: bool
) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    if legacy and not isinstance(raw.get("enabled"), bool):
        return None
    enabled = raw["enabled"] if isinstance(raw.get("enabled"), bool) else fallback.enabled
    action = raw["action"] if (not legacy and _is_action(raw.get("action"))) else fallback.action
    if enforce:
        if action not in fallback.allowed_actions:
            action = fallback.action
        if fallback.locked:
            return {"enabled": fallback.enabled, "action": fallback.action}
    entry: dict[str, Any] = {"enabled": enabled, "action": action}
    if _is_score(raw.get("minScore")):
        entry["minScore"] = raw["minScore"]
    if not legacy:
        if isinstance(raw.get("locked"), bool):
            entry["locked"] = raw["locked"]
        if isinstance(raw.get("setBy"), str) and raw["setBy"] in SET_BY:
            entry["setBy"] = raw["setBy"]
        if _is_action(raw.get("dataRegionAction")):
            entry["dataRegionAction"] = raw["dataRegionAction"]
    return entry


def normalize_tenant_guardrail_policy(raw: Any) -> dict[str, Any]:
    """Read any stored `policies` blob as v2 — the Python twin of the TS normalizer.

    Legacy flat entries take the check's platform-default `action` and keep
    `minScore`; a legacy entry without a boolean `enabled` is no opinion. Unknown ids,
    invalid optional fields and a disallowed action are dropped / fall back to the
    default — never guessed. A catalogue-locked check always reads as its locked
    value. Missing directions are on. Pure and idempotent.
    """
    directions: dict[str, dict[str, bool]] = {d: {"enabled": True} for d in DIRECTIONS}
    checks: dict[str, dict[str, Any]] = {}
    if not isinstance(raw, dict):
        return {"directions": directions, "checks": checks}
    v2 = is_tenant_guardrail_policy_v2(raw)
    if v2 and isinstance(raw.get("directions"), dict):
        for direction in DIRECTIONS:
            entry = raw["directions"].get(direction)
            if isinstance(entry, dict) and isinstance(entry.get("enabled"), bool):
                directions[direction] = {"enabled": entry["enabled"]}
    source = _checks_source(raw, v2)
    for check_id, default in CATALOGUE_DEFAULTS.items():
        if check_id not in source:
            continue
        normalized = _normalize_entry(source[check_id], default, not v2, True)
        if normalized is not None:
            checks[check_id] = normalized
    return {"directions": directions, "checks": checks}


def _tier_fields(raw: Any) -> tuple[dict[str, bool], dict[str, dict[str, Any]]]:
    """The fields ONE tier explicitly states (validated, unenforced), per check.

    Unlike the normalizer this keeps only what the row SAID — a v2 entry without an
    `action` states no action — so the cascade can fall through field by field.
    """
    directions: dict[str, bool] = {}
    checks: dict[str, dict[str, Any]] = {}
    if not isinstance(raw, dict):
        return directions, checks
    v2 = is_tenant_guardrail_policy_v2(raw)
    if v2 and isinstance(raw.get("directions"), dict):
        for direction in DIRECTIONS:
            entry = raw["directions"].get(direction)
            if isinstance(entry, dict) and isinstance(entry.get("enabled"), bool):
                directions[direction] = entry["enabled"]
    source = _checks_source(raw, v2)
    for check_id in CATALOGUE_DEFAULTS:
        entry = source.get(check_id)
        if not isinstance(entry, dict):
            continue
        if not v2 and not isinstance(entry.get("enabled"), bool):
            continue
        stated: dict[str, Any] = {}
        if isinstance(entry.get("enabled"), bool):
            stated["enabled"] = entry["enabled"]
        if _is_score(entry.get("minScore")):
            stated["minScore"] = float(entry["minScore"])
        if v2:
            if _is_action(entry.get("action")):
                stated["action"] = entry["action"]
            if isinstance(entry.get("locked"), bool):
                stated["locked"] = entry["locked"]
            if _is_action(entry.get("dataRegionAction")):
                stated["dataRegionAction"] = entry["dataRegionAction"]
        if stated:
            checks[check_id] = stated
    return directions, checks


def _effective(
    system_blob: Any, tenant_blob: Any
) -> tuple[dict[str, dict[str, Any]], dict[str, bool]]:
    sys_dirs, sys_checks = _tier_fields(system_blob)
    ten_dirs, ten_checks = _tier_fields(tenant_blob)
    directions = {d: ten_dirs.get(d, sys_dirs.get(d, True)) for d in DIRECTIONS}
    policies: dict[str, dict[str, Any]] = {}
    for check_id, default in CATALOGUE_DEFAULTS.items():
        tiers = (ten_checks.get(check_id, {}), sys_checks.get(check_id, {}))

        def _pick(name: str, fallback: Any, tiers: tuple[dict[str, Any], ...] = tiers) -> Any:
            for tier in tiers:
                if name in tier:
                    return tier[name]
            return fallback

        action = _pick("action", default.action)
        if action not in default.allowed_actions:
            action = default.action
        entry: dict[str, Any] = {
            "enabled": bool(_pick("enabled", default.enabled)),
            "action": action,
            "locked": bool(_pick("locked", False)),
            "dataRegionAction": _pick("dataRegionAction", default.data_region_action),
        }
        min_score = _pick("minScore", None)
        if min_score is not None:
            entry["minScore"] = min_score
        if default.locked:
            entry.update(enabled=True, action=default.action, locked=True)
        policies[check_id] = entry
    for direction in DIRECTIONS:
        unlocked = [
            check_id
            for check_id, default in CATALOGUE_DEFAULTS.items()
            if direction in default.directions and not default.locked
        ]
        if not any(policies[check_id]["enabled"] for check_id in unlocked):
            # There is no "off": an empty direction is screened with the platform set.
            logger.warning("guardrail.availability.empty_direction", direction=direction)
            for check_id in unlocked:
                policies[check_id]["enabled"] = CATALOGUE_DEFAULTS[check_id].enabled
    return policies, directions


@dataclass(frozen=True)
class GuardrailAvailability:
    """One tenant's EFFECTIVE guardrail policy, plus the tier that supplied it."""

    #: Every declared check: `{enabled, action, locked, dataRegionAction, minScore?}`.
    policies: dict[str, Any]
    #: WHICH tier answered — the request tenant, or SYSTEM. `None` when nothing was
    #: resolved at all (an un-wired screener on the platform defaults).
    source_tenant_id: str | None = None
    #: `{inbound: bool, outbound: bool}` — `False` = monitor only (OD-7).
    directions: dict[str, bool] = field(default_factory=lambda: dict.fromkeys(DIRECTIONS, True))

    # -- construction -------------------------------------------------------

    @classmethod
    def from_tiers(
        cls,
        *,
        system_blob: Any,
        tenant_blob: Any,
        source_tenant_id: str | None = None,
    ) -> GuardrailAvailability:
        """Platform default → SYSTEM row → tenant row, field by field."""
        policies, directions = _effective(system_blob, tenant_blob)
        return cls(policies=policies, source_tenant_id=source_tenant_id, directions=directions)

    @classmethod
    def from_blob(
        cls, blob: dict[str, Any] | None, *, source_tenant_id: str | None = None
    ) -> GuardrailAvailability:
        """ONE tier over the platform defaults (v2 or legacy flat)."""
        return cls.from_tiers(system_blob=blob, tenant_blob=None, source_tenant_id=source_tenant_id)

    # -- declaration --------------------------------------------------------

    @staticmethod
    def threshold_spec(policy_id: str) -> ThresholdSpec | None:
        """The strictness field this policy accepts, or ``None`` if it has none."""
        return _THRESHOLDS.get(policy_id)

    # -- reads --------------------------------------------------------------

    def is_enabled(self, policy_id: str) -> bool:
        """True when ``policy_id`` runs for this tenant. Undeclared ids never do."""
        default = CATALOGUE_DEFAULTS.get(policy_id)
        if default is None:
            return False
        if default.locked:
            return True
        entry = self.policies.get(policy_id)
        return isinstance(entry, dict) and entry.get("enabled") is True

    def is_locked(self, policy_id: str) -> bool:
        """The CATALOGUE lock (medical validation) — not a per-tenant platform lock."""
        default = CATALOGUE_DEFAULTS.get(policy_id)
        return bool(default and default.locked)

    def direction_enabled(self, direction: str) -> bool:
        return self.directions.get(direction, True) is not False

    def action_for(self, policy_id: str, direction: str, *, trust: str | None = None) -> str:
        """What a VIOLATION of ``policy_id`` does here.

        Lock first (always `block`); then a monitor-only direction (`ignore`); then,
        for an inbound DATA region of a check that screens both trusts, the
        data-region action (OD-12, default `ignore` = FC-5b record-only); otherwise
        the check's action.
        """
        default = CATALOGUE_DEFAULTS.get(policy_id)
        if default is None:
            return ACTION_BLOCK
        if default.locked:
            return default.action
        if not self.direction_enabled(direction):
            return ACTION_IGNORE
        entry = self.policies.get(policy_id) or {}
        action = entry.get("action") if _is_action(entry.get("action")) else default.action
        if (
            direction == "inbound"
            and trust == TRUST_DATA
            and TRUST_INSTRUCTION in default.inbound_regions
        ):
            data_action = entry.get("dataRegionAction")
            if _is_action(data_action):
                return str(data_action)
            return default.data_region_action or str(action)
        return str(action)

    def selected(self, policy_ids: tuple[str, ...]) -> tuple[str, ...]:
        """The subset of ``policy_ids`` this tenant's set turns on, in order."""
        return tuple(policy_id for policy_id in policy_ids if self.is_enabled(policy_id))

    def tighten(self, policy_id: str, platform_value: float) -> float:
        """Compose the platform threshold with this tenant's, strictly."""
        spec = _THRESHOLDS.get(policy_id)
        if spec is None:
            return platform_value
        entry = self.policies.get(policy_id)
        if not isinstance(entry, Mapping):
            return platform_value
        candidate = entry.get(spec.field)
        if isinstance(candidate, bool) or not isinstance(candidate, (int, float)):
            return platform_value
        as_float = float(candidate)
        if spec.floor_direction == LOWER_IS_STRICTER:
            return min(as_float, platform_value)
        return max(as_float, platform_value)


#: The catalogue defaults — what the SYSTEM seed declares. The fallback for an
#: un-wired screener and for an availability read that failed (logged by the caller).
PLATFORM_DEFAULT_AVAILABILITY: Final = GuardrailAvailability.from_tiers(
    system_blob=None, tenant_blob=None
)
