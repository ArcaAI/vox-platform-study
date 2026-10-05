"""Moderation transport posture — resolved, never read from the environment.

What is left here after TASK-1035 is TUNING only:

| Field | Kind | Channel |
|---|---|---|
| `timeout_s`, `max_retries`, `retry_backoff_ms` | platform tuning | PULL |
| `include_reasoning` | tenant policy | PUSH — per request, folded over the platform value |

What is deliberately GONE, by owner decision (TASK-1035, 2026-10-02):

* the platform kill switch `text.externalGuardrail.enabled` (OD-4) — break-glass is
  a redeploy, so "always check" holds by construction;
* the per-call tenant opt-out `guardrail_policy.enabled = false` (OD-1, reversing
  TASK-890 OD-R) — a pushed value is ignored;
* `require_medical` (OD-5) — the medical judge always runs; the ONE exemption is a
  request that declares `medical_exempt: "internal"`, which is a name on the wire,
  never a tenant-pushable boolean.

What is NOT resolvable here either: the FAIL POSTURE. A transient error is absorbed
by the bounded retry and a sustained outage REJECTS. An errored guardrail never
returns ``allowed: True``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from text.core.runtime_defaults import (
    GUARDRAIL_INCLUDE_REASONING_FLOOR,
    GUARDRAIL_MAX_RETRIES_FLOOR,
    GUARDRAIL_RETRY_BACKOFF_FLOOR_MS,
    GUARDRAIL_TIMEOUT_FLOOR_S,
)


@dataclass(frozen=True)
class GuardrailPosture:
    """One request's resolved moderation tuning."""

    timeout_s: int = GUARDRAIL_TIMEOUT_FLOOR_S
    max_retries: int = GUARDRAIL_MAX_RETRIES_FLOOR
    retry_backoff_ms: int = GUARDRAIL_RETRY_BACKOFF_FLOOR_MS
    include_reasoning: bool = GUARDRAIL_INCLUDE_REASONING_FLOOR


def platform_posture(served: dict[str, Any] | None) -> GuardrailPosture:
    """The platform default, from the PULL snapshot's ``externalGuardrail`` group.

    An absent group, an absent key, or a null value keeps the floor. Served
    ``enabled`` / ``requireMedical`` keys from an older control plane are IGNORED:
    neither is a switch this service honours any more.
    """
    if not isinstance(served, dict):
        return GuardrailPosture()

    def count(name: str, floor: int) -> int:
        value = served.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return floor
        coerced = int(value)
        return coerced if coerced >= 0 else floor

    reasoning = served.get("includeReasoning")
    return GuardrailPosture(
        timeout_s=count("timeoutS", GUARDRAIL_TIMEOUT_FLOOR_S) or GUARDRAIL_TIMEOUT_FLOOR_S,
        max_retries=count("maxRetries", GUARDRAIL_MAX_RETRIES_FLOOR),
        retry_backoff_ms=count("retryBackoffMs", GUARDRAIL_RETRY_BACKOFF_FLOOR_MS),
        include_reasoning=(
            reasoning if isinstance(reasoning, bool) else GUARDRAIL_INCLUDE_REASONING_FLOOR
        ),
    )


def resolve_posture(platform: GuardrailPosture, tenant: Any | None) -> GuardrailPosture:
    """Fold this request's PUSHED ``include_reasoning`` over the platform default.

    ``None`` means "no opinion" — the platform value stands. Nothing else a tenant
    pushes changes the posture.
    """
    include_reasoning = getattr(tenant, "include_reasoning", None)
    if not isinstance(include_reasoning, bool):
        return platform
    return GuardrailPosture(
        timeout_s=platform.timeout_s,
        max_retries=platform.max_retries,
        retry_backoff_ms=platform.retry_backoff_ms,
        include_reasoning=include_reasoning,
    )
