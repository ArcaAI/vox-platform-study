"""Input-moderation posture — resolved, never read from the environment.

`TEXT_EXTERNAL_GUARDRAIL_{ENABLED,TIMEOUT_S,MAX_RETRIES,RETRY_BACKOFF_MS,
REQUIRE_MEDICAL,INCLUDE_REASONING}` were six env vars expressing three different
KINDS of decision, which is why collapsing them needed more than a rename:

| Field | Kind | Channel (owner decision D-1) |
|---|---|---|
| `enabled` | platform switch, PLUS a per-call tenant opt-out | PULL for the switch, PUSH for the opt-out |
| `timeout_s`, `max_retries`, `retry_backoff_ms` | platform tuning | PULL |
| `require_medical`, `include_reasoning` | **tenant policy** | PUSH — per request |

The last row is the one that could never be an env var. A non-clinical tenant
needs `require_medical` off while every other tenant keeps it on; a process-wide
boolean can express only one of those, so the choice was really "redeploy, or
force clinical validation on a tenant it does not fit". Cardinality decides the
channel (D-1 rule 3): anything that could differ per tenant is PUSHED.

Resolution order is the platform-wide one — **tenant → platform default** — and
it widens only on ABSENCE: a tenant that expressed no opinion inherits the
platform value, and a tenant that said `false` is not overruled by a platform
`true`.

`enabled` is the one field where that fold is DELIBERATELY ASYMMETRIC (TASK-890
OD-R, 2026-09-06). This module used to state that the switch was platform-only;
the owner decided a tenant may opt OUT of platform guardrail screening per agent,
per workflow and per node, and the gateway pushes that decision here. So the rule
is `enabled = platform.enabled AND (tenant.enabled if it said anything else True)`:
a pushed `False` turns BOTH gates off for this call, and a pushed `True` can never
turn a platform kill switch back on. The platform switch is the FLOOR, not a
default to be overridden — which is why a tenant's only move is to subtract.

The resolved posture also carries `opted_out`, so the two ways a gate can end up
off are never confused downstream: `external_guardrail_disabled` (the platform
switch, which makes every opt-out moot) and `tenant_opted_out` (a tenant decision
the usage ledger attributes to that tenant).

What is NOT resolvable here, deliberately: the FAIL POSTURE. A transient error is
absorbed by the bounded retry and a sustained outage REJECTS. There is no
`fail_open` field to set because an errored guardrail must never return
``allowed: True`` — that is a safety invariant, not a tunable.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from text.core.runtime_defaults import (
    GUARDRAIL_ENABLED_FLOOR,
    GUARDRAIL_INCLUDE_REASONING_FLOOR,
    GUARDRAIL_MAX_RETRIES_FLOOR,
    GUARDRAIL_REQUIRE_MEDICAL_FLOOR,
    GUARDRAIL_RETRY_BACKOFF_FLOOR_MS,
    GUARDRAIL_TIMEOUT_FLOOR_S,
)


@dataclass(frozen=True)
class GuardrailPosture:
    """One request's resolved moderation posture."""

    enabled: bool = GUARDRAIL_ENABLED_FLOOR
    #: TASK-890 OD-R — TRUE only when this call is unscreened BECAUSE THE TENANT
    #: said so (the platform switch was on and the request pushed `enabled:
    #: False`). It is never true when the platform switch is off: that case is
    #: `external_guardrail_disabled`, a platform state in which no opt-out was
    #: even consulted, and the ledger prices the two differently
    #: (`opted_out` vs `platform_off`). Derived in `resolve_posture`; never
    #: served by the control plane, so `platform_posture` never sets it.
    opted_out: bool = False
    timeout_s: int = GUARDRAIL_TIMEOUT_FLOOR_S
    max_retries: int = GUARDRAIL_MAX_RETRIES_FLOOR
    retry_backoff_ms: int = GUARDRAIL_RETRY_BACKOFF_FLOOR_MS
    require_medical: bool = GUARDRAIL_REQUIRE_MEDICAL_FLOOR
    include_reasoning: bool = GUARDRAIL_INCLUDE_REASONING_FLOOR


def platform_posture(served: dict[str, Any] | None) -> GuardrailPosture:
    """The platform default, from the PULL snapshot's ``externalGuardrail`` group.

    An absent group, an absent key, or a null value keeps the floor — a control
    plane with no opinion must never be read as an opinion of "off".
    """
    if not isinstance(served, dict):
        return GuardrailPosture()

    def flag(name: str, floor: bool) -> bool:
        value = served.get(name)
        return value if isinstance(value, bool) else floor

    def count(name: str, floor: int) -> int:
        value = served.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return floor
        coerced = int(value)
        return coerced if coerced >= 0 else floor

    return GuardrailPosture(
        enabled=flag("enabled", GUARDRAIL_ENABLED_FLOOR),
        timeout_s=count("timeoutS", GUARDRAIL_TIMEOUT_FLOOR_S) or GUARDRAIL_TIMEOUT_FLOOR_S,
        max_retries=count("maxRetries", GUARDRAIL_MAX_RETRIES_FLOOR),
        retry_backoff_ms=count("retryBackoffMs", GUARDRAIL_RETRY_BACKOFF_FLOOR_MS),
        require_medical=flag("requireMedical", GUARDRAIL_REQUIRE_MEDICAL_FLOOR),
        include_reasoning=flag("includeReasoning", GUARDRAIL_INCLUDE_REASONING_FLOOR),
    )


def tenant_opted_out(tenant: Any | None) -> bool:
    """Did THIS request explicitly ask for no screening?

    A boolean ``False`` is the only opt-out. ``None``, an absent attribute and any
    non-boolean are silence — defensively, because a malformed value must never
    read as an opt-out on a safety gate. Shared by `resolve_posture` and by the two
    gate halves' unwired-client branch, so "the tenant opted out" is decided in one
    place rather than spelled three ways.
    """
    return getattr(tenant, "enabled", None) is False


def resolve_posture(platform: GuardrailPosture, tenant: Any | None) -> GuardrailPosture:
    """Fold this request's PUSHED tenant policy over the platform default.

    ``tenant`` is the request's ``guardrail_policy`` block (or ``None``). Only a
    field the tenant actually SET is applied — ``None`` means "no opinion", which
    is not the same as ``False`` and must not be flattened into it.

    ``enabled`` folds ASYMMETRICALLY (TASK-890 OD-R): the platform switch is the
    floor, so a tenant may only ever turn screening OFF for its own call.
    """
    if tenant is None:
        return platform

    require_medical = getattr(tenant, "require_medical", None)
    include_reasoning = getattr(tenant, "include_reasoning", None)
    opted_out = platform.enabled and tenant_opted_out(tenant)

    return GuardrailPosture(
        # `and` — never a plain override. A pushed `True` against a platform-off
        # switch resolves to OFF, which is the whole point of calling this a floor.
        enabled=platform.enabled and not opted_out,
        opted_out=opted_out,
        timeout_s=platform.timeout_s,
        max_retries=platform.max_retries,
        retry_backoff_ms=platform.retry_backoff_ms,
        require_medical=(
            require_medical if isinstance(require_medical, bool) else platform.require_medical
        ),
        include_reasoning=(
            include_reasoning if isinstance(include_reasoning, bool) else platform.include_reasoning
        ),
    )


def platform_moderation_enabled(app_state: Any) -> bool:
    """Whether the control plane says moderation is on.

    Read from live state rather than from settings: the switch moved off env
    onto the PULL channel, so a platform admin turning moderation on for a
    clinical deployment takes effect on the next request, not the next restart.

    Shared by BOTH halves of the gate — the input gate in
    `api/endpoints/generate.py` and the output gate in `services/output_gate.py`
    — so the enforce-posture-with-unwired-client case fails closed identically
    on each side.
    """
    posture = getattr(app_state, "guardrail_posture", None)
    return bool(getattr(posture, "enabled", False))
