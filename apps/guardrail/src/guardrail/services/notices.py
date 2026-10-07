"""`GuardrailNotice` v1 — the ONE standard message a client gets for a guardrail outcome.

Python twin of `packages/types/src/guardrail-notice.ts` (TASK-1050 W1; README §9.7.3,
§9.8.1). Guardrail is the policy DECISION point: it builds the notice; the gateway
persists it (riding on the evaluation record) and the flow enforcers (TEXT, harness)
relay it.

PHI rules, load-bearing:

* a notice carries NO content and NO judge reasoning — only check ids, the lane's
  verdict category, item ids and fixed strings;
* ``defaultMessage`` is EXACTLY the fixed label of ``messageKey``.

**Deterministic ids.** ``dedupeKey = "{consultationId or requestId}:{checkId}:{itemId or
regionKey}:{policyVersion}"`` and ``noticeId`` is a UUID derived from
``sha256(tenantId + "|" + dedupeKey)`` (RFC 9562 version 8, the "custom" layout), so a
live summary that re-screens the same window every few seconds raises the SAME id and the
gateway's idempotent write keeps one notice (README §9.7.3: one notice per
`(consultation, checkId, itemId, policyVersion)`).
"""

from __future__ import annotations

import dataclasses
import hashlib
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Final

NOTICE_SCHEMA_VERSION: Final = 1

TYPE_WARNING: Final = "guardrail.warning"
TYPE_BLOCKED: Final = "guardrail.blocked"
TYPE_UNVERIFIED: Final = "guardrail.unverified"

#: The fixed English label of each key (frozen; pinned against the vocabulary fixture).
NOTICE_DEFAULT_MESSAGES: Final[dict[str, str]] = {
    "guardrail.warning.generic": "A safety check flagged this content. Review it before you rely on it.",
    "guardrail.blocked.inbound": "A safety check stopped this request. Review the flagged input to continue.",
    "guardrail.blocked.outbound": "A safety check withheld the generated content. Review it to continue.",
    "guardrail.blocked.not_medical": (
        "This content is outside clinical documentation, so it was not processed. "
        "Review the flagged input to continue."
    ),
    "guardrail.blocked.redaction_unavailable": (
        "Patient details could not be protected before sending to an external model, "
        "so processing is paused. Retry to continue."
    ),
    "guardrail.unverified.generic": (
        "A safety check could not run, so this content was not verified. "
        "Review it before you rely on it."
    ),
}

#: action taken → (notice type, notice action, severity).
_SHAPE: Final[dict[str, tuple[str, str, str]]] = {
    "block": (TYPE_BLOCKED, "block", "high"),
    "warn": (TYPE_WARNING, "warn", "medium"),
    "unverified": (TYPE_UNVERIFIED, "warn", "low"),
}


@dataclass(frozen=True)
class GuardrailCorrelation:
    """Where an evaluation happened — forwarded by the caller (README §9.6 "Correlation")."""

    request_id: str
    consultation_id: str | None = None
    run_id: str | None = None
    run_key: str | None = None
    node_id: str | None = None
    item_id: str | None = None


def notice_dedupe_key(
    *,
    consultation_id: str | None,
    request_id: str,
    check_id: str,
    target: str,
    policy_version: str,
) -> str:
    return f"{consultation_id or request_id}:{check_id}:{target}:{policy_version}"


def notice_id_for(tenant_id: str, dedupe_key: str) -> str:
    """A deterministic, UUID-formatted id — same tenant + key ⇒ same id, always."""
    digest = bytearray(hashlib.sha256(f"{tenant_id}|{dedupe_key}".encode()).digest()[:16])
    digest[6] = (digest[6] & 0x0F) | 0x80  # version 8 (custom)
    digest[8] = (digest[8] & 0x3F) | 0x80  # RFC 9562 variant
    return str(uuid.UUID(bytes=bytes(digest)))


def _message_key(direction: str, taken: str, check_id: str) -> str:
    if taken == "unverified":
        return "guardrail.unverified.generic"
    if taken == "warn":
        return "guardrail.warning.generic"
    if check_id == "medical_validation":
        return "guardrail.blocked.not_medical"
    return "guardrail.blocked.outbound" if direction == "outbound" else "guardrail.blocked.inbound"


def _targets(check: Any) -> list[tuple[str, str | None]]:
    """`(dedupe target, itemId or None)` for each notice one check raises."""
    taken = check.effective_action_taken
    if taken == "unverified":
        item_refs = list(check.items) or list(check.flagged_items)
        regions = list(check.region_keys) or list(check.flagged_regions)
    else:
        item_refs = list(check.flagged_items)
        regions = list(check.flagged_regions) or list(check.region_keys)
    item_ids = list(dict.fromkeys(str(ref[0]) for ref in item_refs))
    if item_ids:
        return [(item_id, item_id) for item_id in item_ids]
    region_keys = list(dict.fromkeys(str(key) for key in regions))
    return [(key, None) for key in region_keys] or [("request", None)]


def build_notice(
    *,
    tenant_id: str,
    direction: str,
    check: Any,
    target: str,
    item_id: str | None,
    correlation: GuardrailCorrelation,
    policy_version: str,
    occurred_at: str,
) -> dict[str, Any]:
    taken = check.effective_action_taken
    notice_type, action, severity = _SHAPE[taken]
    key = _message_key(direction, taken, check.name)
    entry: dict[str, Any] = {"checkId": check.name}
    if taken != "unverified" and check.category:
        entry["category"] = str(check.category)
    entry["severity"] = severity
    dedupe = notice_dedupe_key(
        consultation_id=correlation.consultation_id,
        request_id=correlation.request_id,
        check_id=check.name,
        target=target,
        policy_version=policy_version,
    )
    notice: dict[str, Any] = {
        "schemaVersion": NOTICE_SCHEMA_VERSION,
        "noticeId": notice_id_for(tenant_id, dedupe),
        "type": notice_type,
        "direction": direction,
        "action": action,
        "checks": [entry],
    }
    for field_name, value in (
        ("consultationId", correlation.consultation_id),
        ("runId", correlation.run_id),
        ("nodeId", correlation.node_id),
    ):
        if value:
            notice[field_name] = value
    notice.update(
        {
            "itemIds": [item_id] if item_id else [],
            "messageKey": key,
            "defaultMessage": NOTICE_DEFAULT_MESSAGES[key],
            # A warning and a block need an attestation; an outage notice does not.
            "requiresAcknowledgement": taken != "unverified",
            # A block inside a consultation is a resumable hold (README §9.8.1); a
            # standalone run is re-run instead.
            "resumable": taken == "block" and bool(correlation.consultation_id),
            "policyVersion": policy_version,
            "occurredAt": occurred_at,
        }
    )
    return notice


def build_notices(
    decision: Any,
    *,
    tenant_id: str,
    correlation: GuardrailCorrelation,
    policy_version: str,
    occurred_at: str,
) -> list[dict[str, Any]]:
    """Every notice one decision raises — `warn`, `block` and `unverified` checks only."""
    notices: dict[str, dict[str, Any]] = {}
    checks: Sequence[Any] = getattr(decision, "checks", ()) or ()
    for check in checks:
        if check.effective_action_taken not in _SHAPE:
            continue
        for target, item_id in _targets(check):
            notice = build_notice(
                tenant_id=tenant_id,
                direction=decision.direction,
                check=check,
                target=target,
                item_id=item_id,
                correlation=correlation,
                policy_version=policy_version,
                occurred_at=occurred_at,
            )
            notices.setdefault(notice["noticeId"], notice)
    return list(notices.values())


# ── `X-Hope-Guardrail-Override` (contract amendment 5d0760a60) ───────────────────


def check_dedupe_keys(
    check: Any, *, correlation: GuardrailCorrelation, policy_version: str
) -> list[str]:
    """The dedupe keys of the notices this check raises — the keys an override matches."""
    return [
        notice_dedupe_key(
            consultation_id=correlation.consultation_id,
            request_id=correlation.request_id,
            check_id=check.name,
            target=target,
            policy_version=policy_version,
        )
        for target, _item in _targets(check)
    ]


def _has_block_floor(check_id: str) -> bool:
    """A catalogue-locked check, or one whose platform floor is `block`, is never downgraded."""
    from guardrail.core.availability import CATALOGUE_DEFAULTS

    default = CATALOGUE_DEFAULTS.get(check_id)
    return default is None or default.locked or "warn" not in default.allowed_actions


def apply_guardrail_override(
    decision: Any,
    *,
    correlation: GuardrailCorrelation,
    dedupe_key: str,
    notice_id: str,
) -> Any:
    """Downgrade block → warn for the checks whose dedupe key is the VERIFIED notice's.

    The caller has already verified the notice (``TenantConfigResolver.
    verify_guardrail_override``). Nothing else moves: a check with a block floor (the
    locked medical check) keeps its block, as does every check of another dedupe key.
    """
    from guardrail.services.screening import (
        DECISION_ALLOW,
        DECISION_BLOCK,
        TAKEN_BLOCK,
        TAKEN_WARN,
        compose_decision,
    )

    policy_version = getattr(decision, "policy_version", "") or "unavailable"
    changed = False
    checks: list[Any] = []
    for check in decision.checks:
        if (
            check.effective_action_taken == TAKEN_BLOCK
            and not _has_block_floor(check.name)
            and dedupe_key
            in check_dedupe_keys(check, correlation=correlation, policy_version=policy_version)
        ):
            checks.append(
                dataclasses.replace(check, action_taken=TAKEN_WARN, override_notice_id=notice_id)
            )
            changed = True
        else:
            checks.append(check)
    if not changed:
        return decision
    outcome = compose_decision([check.effective_action_taken for check in checks])
    return dataclasses.replace(
        decision,
        checks=checks,
        guardrail_decision=outcome,
        decision=DECISION_BLOCK if outcome == DECISION_BLOCK else DECISION_ALLOW,
    )
