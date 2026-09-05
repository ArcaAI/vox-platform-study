"""Per-tenant guardrail AVAILABILITY — WHICH declared screening policies apply.

Owner decision #3 (TASK-870 target model item 5): *"Guardrail is built-in and
platform-only. It gates every text-generation request before send and every
response after receive … No tenant admin manages any guardrail setting."*

**Availability is POLICY SELECTION, never gate removal.** Three properties, each
enforced here rather than remembered:

1. **There is no "off".** An absent row, an empty selection and an all-disabled
   selection are the SAME thing — "no opinion" — and all three resolve to the
   platform default set. :meth:`GuardrailAvailability.from_blob` collapses them,
   so no caller has to decide.
2. **The strictest set always exists in code.** :data:`PLATFORM_DEFAULT_AVAILABILITY`
   turns every declared check on, so a cold database — or a DB the resolver
   could not reach — still screens with the full set. This is why an
   availability read failure does NOT 503 the way a SELECTION failure does:
   an unresolved model means there is nothing to run at all, whereas an
   unresolved availability has a strictest answer available without the DB.
3. **A threshold can only ever be tightened.** :meth:`GuardrailAvailability.tighten`
   composes the platform value with the tenant's in the strict direction, so a
   row written by any means other than the gateway's write lane (raw SQL, an
   older seed) still cannot loosen the gate. The write lane's 403 is the
   admin-facing half of the same rule.

**Membership rule.** Every id below is a check name in
``services/screening.py::_DECLARED_FAIL_MODES``. A policy is selectable if, and
only if, a screening check READS the selection — declaring one with no reader is
the defect TASK-886 removed with ``injectionScreeningCriteria``.

The ids and threshold directions are pinned against
``tests/contracts/availability-catalogue.json``, which
``packages/applications/.../guardrail-availability/policy-catalogue.ts`` and the
SYSTEM seed are pinned against too — one artifact, three readers, the
``ResolvedAsrSpec`` precedent.

The id tuple is declared HERE and not imported from ``screening.py`` because
``screening.py`` imports this module; ``test_task886_availability.py`` asserts
the two sets are equal, so the duplication cannot drift.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final

#: Lower value ⇒ stricter (a lower score floor inspects MORE spans).
LOWER_IS_STRICTER: Final = "lower-is-stricter"
#: Higher value ⇒ stricter (a claim must clear a higher bar).
HIGHER_IS_STRICTER: Final = "higher-is-stricter"


@dataclass(frozen=True)
class ThresholdSpec:
    """The one strictness field a policy accepts, and which way it tightens."""

    field: str
    floor_direction: str


#: The selectable policies, in contract order. Membership rule above.
DECLARED_POLICY_IDS: Final[tuple[str, ...]] = (
    "jailbreak_detection",
    "prompt_safety",
    "prompt_toxicity",
    "response_safety",
    "response_toxicity",
    "response_refusal",
    "pii_leak",
    "containment_echo",
)

#: Only `pii_leak` carries a strictness today, and it has a READER
#: (`Screener._pii_leak_min_score`). The others are on/off: the classification
#: threshold they would share is a property of the safety TAXONOMY, resolved per
#: model row, not a per-check knob — so declaring one here would be a knob that
#: cannot move anything.
_THRESHOLDS: Final[dict[str, ThresholdSpec]] = {
    "pii_leak": ThresholdSpec("minScore", LOWER_IS_STRICTER),
}


@dataclass(frozen=True)
class GuardrailAvailability:
    """One tenant's resolved policy selection, plus the tier that supplied it."""

    #: `{ "<checkName>": { "enabled": bool, "<threshold>": number } }`.
    policies: dict[str, Any]
    #: WHICH tier answered — the request tenant, or SYSTEM. `None` when nothing
    #: was resolved at all (an un-wired screener falling back to the default
    #: set), which is deliberately distinguishable from "SYSTEM answered".
    source_tenant_id: str | None = None

    # -- construction -------------------------------------------------------

    @classmethod
    def from_blob(
        cls, blob: dict[str, Any] | None, *, source_tenant_id: str | None = None
    ) -> GuardrailAvailability:
        """Resolve a stored selection, collapsing every form of "no opinion".

        An absent blob, an empty one and one with nothing enabled all yield the
        platform default set — there is no configuration state in which the gate
        is empty.
        """
        selection = blob if isinstance(blob, dict) else {}
        normalized = {
            policy_id: dict(value)
            for policy_id, value in selection.items()
            if policy_id in DECLARED_POLICY_IDS and isinstance(value, dict)
        }
        if not any(entry.get("enabled") is True for entry in normalized.values()):
            return cls(policies=dict(_PLATFORM_DEFAULT_POLICIES), source_tenant_id=source_tenant_id)
        return cls(policies=normalized, source_tenant_id=source_tenant_id)

    # -- declaration --------------------------------------------------------

    @staticmethod
    def threshold_spec(policy_id: str) -> ThresholdSpec | None:
        """The strictness field this policy accepts, or ``None`` if it has none."""
        return _THRESHOLDS.get(policy_id)

    # -- reads --------------------------------------------------------------

    def is_enabled(self, policy_id: str) -> bool:
        """True when this tenant's resolved set turns ``policy_id`` on.

        An UNDECLARED id is never enabled: a check whose name is not in the
        catalogue cannot be selected, so it can never be silently switched on by
        a stray row.
        """
        if policy_id not in DECLARED_POLICY_IDS:
            return False
        entry = self.policies.get(policy_id)
        return isinstance(entry, dict) and entry.get("enabled") is True

    def selected(self, policy_ids: tuple[str, ...]) -> tuple[str, ...]:
        """The subset of ``policy_ids`` this tenant's set turns on, in order."""
        return tuple(policy_id for policy_id in policy_ids if self.is_enabled(policy_id))

    def tighten(self, policy_id: str, platform_value: float) -> float:
        """Compose the platform threshold with this tenant's, strictly.

        The tenant value applies only when it is STRICTER. Never the other way
        round — availability may narrow WHICH checks run, never how leniently
        one of them runs.
        """
        spec = _THRESHOLDS.get(policy_id)
        if spec is None:
            return platform_value
        entry = self.policies.get(policy_id)
        if not isinstance(entry, dict):
            return platform_value
        candidate = entry.get(spec.field)
        if isinstance(candidate, bool) or not isinstance(candidate, (int, float)):
            return platform_value
        as_float = float(candidate)
        if spec.floor_direction == LOWER_IS_STRICTER:
            return min(as_float, platform_value)
        return max(as_float, platform_value)


#: Every declared check ON. Mirrors `PLATFORM_DEFAULT_GUARDRAIL_POLICIES` in the
#: applications layer and the SYSTEM seed row; the thresholds are deliberately
#: ABSENT here so `tighten()` returns the model row's own value unchanged — this
#: fallback must never itself introduce a number.
_PLATFORM_DEFAULT_POLICIES: Final[dict[str, Any]] = {
    policy_id: {"enabled": True} for policy_id in DECLARED_POLICY_IDS
}

PLATFORM_DEFAULT_AVAILABILITY: Final = GuardrailAvailability(policies=dict(_PLATFORM_DEFAULT_POLICIES))
