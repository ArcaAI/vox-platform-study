"""`GuardrailNotice` v1 — the ONE standard message a client gets for a guardrail outcome.

Python twin of `packages/types/src/guardrail-notice.ts` (TASK-1050 W1; README §9.7.3,
§9.8.1). Guardrail is the policy DECISION point: it builds the notice; the gateway
persists it (riding on the evaluation record) and the flow enforcers (TEXT, harness)
relay it.

PHI rules, load-bearing:

* a notice carries NO content and NO judge reasoning — only check ids, the lane's
  verdict category, item ids and fixed strings;
* ``defaultMessage`` is EXACTLY the fixed label of ``messageKey``.

**One notice per type (TASK-1050 follow-up E, owner 2026-10-08; round 2).** A decision raises
ONE notice per ``(direction, notice type)``: ``checks[]`` lists every check that raised that
type and ``itemIds`` the union of their flagged items (empty when only regions flagged), so
"one block → one resume" and an outage over twelve items is one `unverified` notice. (Before:
one notice per flagged check, then one per item target — twelve resumes for one block.)

**Deterministic ids.** ``dedupeKey = "{consultationId or requestId}:{direction}:{type}:
{targetSet}:{policyVersion}"`` (:func:`notice_target_set`: the sorted item ids, else the sorted
region keys, else ``request``) and ``noticeId`` is a UUID derived from
``sha256(tenantId + "|" + dedupeKey)`` (RFC 9562 version 8, the "custom" layout). The same items
re-screened (a live summary every few seconds) raise the SAME id, so the gateway's idempotent
write keeps one notice; a NEW item set is a new notice, so a long consultation never folds every
later violation into one stored — possibly already resolved — notice.
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
    direction: str,
    notice_type: str,
    target: str,
    policy_version: str,
) -> str:
    return f"{consultation_id or request_id}:{direction}:{notice_type}:{target}:{policy_version}"


def notice_target_set(item_ids: Sequence[str], region_keys: Sequence[str]) -> str:
    """The TARGET component of a notice's dedupe key: what the notice is about, as a set.

    The sorted, de-duplicated item ids joined with ``,``; with no item, the sorted region keys
    (``response``, ``system,user`` …); with neither, ``request``. Order-free, so the same items
    re-screened in any order keep the notice id, and a new item set is a new notice.
    """
    items = sorted({str(item) for item in item_ids if item})
    if items:
        return ",".join(items)
    regions = sorted({str(key) for key in region_keys if key})
    return ",".join(regions) if regions else "request"


def notice_id_for(tenant_id: str, dedupe_key: str) -> str:
    """A deterministic, UUID-formatted id — same tenant + key ⇒ same id, always."""
    digest = bytearray(hashlib.sha256(f"{tenant_id}|{dedupe_key}".encode()).digest()[:16])
    digest[6] = (digest[6] & 0x0F) | 0x80  # version 8 (custom)
    digest[8] = (digest[8] & 0x3F) | 0x80  # RFC 9562 variant
    return str(uuid.UUID(bytes=bytes(digest)))


def _message_key(direction: str, taken: str, check_ids: Sequence[str]) -> str:
    if taken == "unverified":
        return "guardrail.unverified.generic"
    if taken == "warn":
        return "guardrail.warning.generic"
    # The not-medical label only when it is the WHOLE story: a notice that also lists another
    # check gets the generic block label, which is true of every check it lists.
    if check_ids and all(check_id == "medical_validation" for check_id in check_ids):
        return "guardrail.blocked.not_medical"
    return "guardrail.blocked.outbound" if direction == "outbound" else "guardrail.blocked.inbound"


def _targets(check: Any) -> tuple[list[str], list[str]]:
    """``(item ids, region keys)`` one check contributes to its notice."""
    taken = check.effective_action_taken
    if taken == "unverified":
        item_refs = list(check.items) or list(check.flagged_items)
        regions = list(check.region_keys) or list(check.flagged_regions)
    else:
        item_refs = list(check.flagged_items)
        regions = list(check.flagged_regions) or list(check.region_keys)
    return (
        list(dict.fromkeys(str(ref[0]) for ref in item_refs)),
        list(dict.fromkeys(str(key) for key in regions)),
    )


def _check_entry(check: Any) -> dict[str, Any]:
    taken = check.effective_action_taken
    entry: dict[str, Any] = {"checkId": check.name}
    if taken != "unverified" and check.category:
        entry["category"] = str(check.category)
    entry["severity"] = _SHAPE[taken][2]
    return entry


@dataclass(frozen=True)
class _NoticeGroup:
    """The checks of one decision that raise one notice type, and what they are about."""

    notice_type: str
    checks: tuple[Any, ...]
    item_ids: tuple[str, ...]
    target: str


def _notice_groups(decision: Any) -> list[_NoticeGroup]:
    """One group per notice type the decision raises, in first-appearance order."""
    by_type: dict[str, tuple[list[Any], list[str], list[str]]] = {}
    for check in getattr(decision, "checks", ()) or ():
        taken = check.effective_action_taken
        if taken not in _SHAPE:
            continue
        members, items, regions = by_type.setdefault(_SHAPE[taken][0], ([], [], []))
        check_items, check_regions = _targets(check)
        members.append(check)
        items.extend(item for item in check_items if item not in items)
        regions.extend(key for key in check_regions if key not in regions)
    return [
        _NoticeGroup(
            notice_type=notice_type,
            checks=tuple(members),
            item_ids=tuple(items),
            target=notice_target_set(items, regions),
        )
        for notice_type, (members, items, regions) in by_type.items()
    ]


def _group_dedupe_key(
    group: _NoticeGroup, *, direction: str, correlation: GuardrailCorrelation, policy_version: str
) -> str:
    return notice_dedupe_key(
        consultation_id=correlation.consultation_id,
        request_id=correlation.request_id,
        direction=direction,
        notice_type=group.notice_type,
        target=group.target,
        policy_version=policy_version,
    )


def build_notice(
    *,
    tenant_id: str,
    direction: str,
    checks: Sequence[Any],
    target: str,
    item_ids: Sequence[str],
    correlation: GuardrailCorrelation,
    policy_version: str,
    occurred_at: str,
) -> dict[str, Any]:
    """ONE notice for every check in ``checks`` — all of one notice type."""
    taken = checks[0].effective_action_taken
    notice_type, action, _severity = _SHAPE[taken]
    entries = list({entry["checkId"]: entry for entry in map(_check_entry, checks)}.values())
    key = _message_key(direction, taken, [entry["checkId"] for entry in entries])
    dedupe = notice_dedupe_key(
        consultation_id=correlation.consultation_id,
        request_id=correlation.request_id,
        direction=direction,
        notice_type=notice_type,
        target=target,
        policy_version=policy_version,
    )
    notice: dict[str, Any] = {
        "schemaVersion": NOTICE_SCHEMA_VERSION,
        "noticeId": notice_id_for(tenant_id, dedupe),
        "type": notice_type,
        "direction": direction,
        "action": action,
        "checks": entries,
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
            "itemIds": list(item_ids),
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
    """Every notice one decision raises — ONE per notice type, listing its checks and items.

    Only `warn`, `block` and `unverified` checks raise one. Order: first appearance.
    """
    return [
        build_notice(
            tenant_id=tenant_id,
            direction=decision.direction,
            checks=group.checks,
            target=group.target,
            item_ids=group.item_ids,
            correlation=correlation,
            policy_version=policy_version,
            occurred_at=occurred_at,
        )
        for group in _notice_groups(decision)
    ]


# ── `X-Hope-Guardrail-Override` (contract amendment 5d0760a60) ───────────────────


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
    """Downgrade block → warn for EVERY check listed on the VERIFIED notice.

    The caller has already verified the notice (``TenantConfigResolver.
    verify_guardrail_override``). A check is on it when the notice this decision raises for the
    check's type has the verified row's dedupe key — or, since the gateway stores a guardrail
    notice's ``dedupeKey`` as the notice id itself, that notice id (or ``notice_id``). A
    re-screen that flags a DIFFERENT item set raises a different notice and is not overridden. Nothing else
    moves: a check with a block floor (the locked medical check) keeps its block, as does every
    check of another notice.
    """
    from guardrail.services.screening import (
        DECISION_ALLOW,
        DECISION_BLOCK,
        TAKEN_BLOCK,
        TAKEN_WARN,
        compose_decision,
    )

    policy_version = getattr(decision, "policy_version", "") or "unavailable"
    tenant_id = str(getattr(decision, "tenant_id", "") or "")
    wanted = {value for value in (dedupe_key, notice_id) if value}
    # The checks of the ONE notice (of this decision) the verified row names.
    on_the_notice: set[int] = set()
    for group in _notice_groups(decision):
        key = _group_dedupe_key(
            group,
            direction=decision.direction,
            correlation=correlation,
            policy_version=policy_version,
        )
        if key in wanted or notice_id_for(tenant_id, key) in wanted:
            on_the_notice.update(id(check) for check in group.checks)

    changed = False
    checks: list[Any] = []
    for check in decision.checks:
        if (
            check.effective_action_taken == TAKEN_BLOCK
            and not _has_block_floor(check.name)
            and id(check) in on_the_notice
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
