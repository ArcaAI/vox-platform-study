"""Input-moderation posture — resolved, never read from the environment.

`TEXT_EXTERNAL_GUARDRAIL_{ENABLED,TIMEOUT_S,MAX_RETRIES,RETRY_BACKOFF_MS,
REQUIRE_MEDICAL,INCLUDE_REASONING}` were six env vars expressing three different
KINDS of decision, which is why collapsing them needed more than a rename:

| Field | Kind | Channel (owner decision D-1) |
|---|---|---|
| `enabled` | platform switch | PULL — one value per service |
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


def resolve_posture(platform: GuardrailPosture, tenant: Any | None) -> GuardrailPosture:
    """Fold this request's PUSHED tenant policy over the platform default.

    ``tenant`` is the request's ``guardrail_policy`` block (or ``None``). Only a
    field the tenant actually SET is applied — ``None`` means "no opinion", which
    is not the same as ``False`` and must not be flattened into it.
    """
    if tenant is None:
        return platform

    require_medical = getattr(tenant, "require_medical", None)
    include_reasoning = getattr(tenant, "include_reasoning", None)

    return GuardrailPosture(
        enabled=platform.enabled,
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
