"""TEXT's half of the guardrail notice contract (TASK-1050 W2c; README §9.7.3, §9.8.1).

TEXT is a flow-enforcement point: guardrail DECIDES, TEXT continues or stops the
generation and tells the caller why, in the ONE standard message, a
``GuardrailNotice`` v1 (`packages/types/src/guardrail-notice.ts`, frozen by
`tests/contracts/guardrail-vocabulary.fixture.json`; parity is pinned by
`tests/unit/test_task1050_guardrail_notices.py`).

* Notices guardrail returns are relayed after :func:`valid_notices` checks them
  against the freeze and strips every non-contract key, so nothing but the fixed
  label of a ``messageKey`` ever reaches a client: no content, no judge reasoning.
* TEXT SYNTHESISES a notice only for what guardrail could not say itself: an
  outage (``guardrail.unverified``), a block whose verdict carried no notice, and
  the cloud redaction hold (``guardrail.blocked.redaction_unavailable``).
* The correlation headers the caller sent (``X-Hope-*``) are bound once per request
  (:func:`bind_guardrail_correlation`) and forwarded on every guardrail call, like
  ``X-Request-Id`` already is; synthesised notices carry them too.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from datetime import UTC, datetime
from types import MappingProxyType
from typing import Any

from uuid_extensions import uuid7

__all__ = [
    "CHECK_IDS",
    "DEFAULT_MESSAGES",
    "EGRESS_REDACTION_UNAVAILABLE",
    "GUARDRAIL_BLOCKED_PROBLEM_TYPE",
    "GUARDRAIL_BLOCKED_TITLE",
    "GUARDRAIL_CORRELATION_HEADERS",
    "GUARDRAIL_OVERRIDE_HEADER",
    "INBOUND_SCREEN_CHECKS",
    "MEDICAL_CHECKS",
    "NOTICE_SCHEMA_VERSION",
    "NOTICE_SEVERITIES",
    "NOTICE_TYPE_ACTION",
    "OUTBOUND_SCREEN_CHECKS",
    "UNKNOWN_POLICY_VERSION",
    "GuardrailOutcome",
    "bind_guardrail_correlation",
    "blocked_checks",
    "blocked_notice",
    "correlation_headers",
    "guardrail_correlation",
    "redaction_unavailable_notice",
    "reset_guardrail_correlation",
    "unverified_notice",
    "valid_notices",
]

NOTICE_SCHEMA_VERSION = 1

NOTICE_TYPE_ACTION: Mapping[str, str] = MappingProxyType(
    {
        "guardrail.warning": "warn",
        "guardrail.blocked": "block",
        "guardrail.unverified": "warn",
    }
)

DEFAULT_MESSAGES: Mapping[str, str] = MappingProxyType(
    {
        "guardrail.warning.generic": (
            "A safety check flagged this content. Review it before you rely on it."
        ),
        "guardrail.blocked.inbound": (
            "A safety check stopped this request. Review the flagged input to continue."
        ),
        "guardrail.blocked.outbound": (
            "A safety check withheld the generated content. Review it to continue."
        ),
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
)

NOTICE_SEVERITIES = frozenset({"low", "medium", "high"})

#: The `type` of a block body (W1: a URN inside the house error envelope, NOT RFC 9457).
GUARDRAIL_BLOCKED_PROBLEM_TYPE = "urn:hope:problem:guardrail-blocked"
GUARDRAIL_BLOCKED_TITLE = "Blocked by a safety guardrail"

#: The processing reason (and TEXT error code) of the cloud redaction hold (§9.8.1).
EGRESS_REDACTION_UNAVAILABLE = "EGRESS_REDACTION_UNAVAILABLE"

#: `policyVersion` of a notice TEXT synthesised without a guardrail verdict (an outage).
UNKNOWN_POLICY_VERSION = "unknown"

CHECK_IDS = frozenset(
    {
        "jailbreak_detection",
        "prompt_safety",
        "prompt_toxicity",
        "response_safety",
        "response_toxicity",
        "response_refusal",
        "pii_leak",
        "containment_echo",
        "medical_validation",
        "injection_judge",
        "unsafe_content_judge",
        "clinical_safety_judge",
        "leakage_judge",
    }
)

#: What each guardrail call covers — named on an `unverified` notice when it could not run.
INBOUND_SCREEN_CHECKS = ("jailbreak_detection", "prompt_safety", "prompt_toxicity")
MEDICAL_CHECKS = ("medical_validation",)
OUTBOUND_SCREEN_CHECKS = (
    "response_safety",
    "response_toxicity",
    "response_refusal",
    "pii_leak",
    "containment_echo",
)

GUARDRAIL_CORRELATION_HEADERS: Mapping[str, str] = MappingProxyType(
    {
        "consultationId": "X-Hope-Consultation-Id",
        "runId": "X-Hope-Run-Id",
        "itemId": "X-Hope-Item-Id",
        "runKey": "X-Hope-Run-Key",
        "nodeId": "X-Hope-Node-Id",
    }
)

#: Re-run of a node after an `acknowledged` hold resolution; the value is the noticeId.
#: Internal only (the gateway strips every `X-Hope-*` header on the business plane) and
#: guardrail VERIFIES it before honouring it — TEXT only forwards what it received.
GUARDRAIL_OVERRIDE_HEADER = "X-Hope-Guardrail-Override"

#: Everything TEXT forwards to guardrail from the incoming request, by field name.
_FORWARDED_HEADERS: Mapping[str, str] = MappingProxyType(
    {**GUARDRAIL_CORRELATION_HEADERS, "guardrailOverride": GUARDRAIL_OVERRIDE_HEADER}
)

# ── correlation ──────────────────────────────────────────────────────────────

_CORRELATION: ContextVar[Mapping[str, str]] = ContextVar(
    "text_guardrail_correlation", default=MappingProxyType({})
)


def bind_guardrail_correlation(headers: Mapping[str, str]) -> Token[Mapping[str, str]]:
    """Bind the ``X-Hope-*`` correlation values (and the override claim) of the incoming
    request, case-insensitively."""
    lowered = {str(name).lower(): value for name, value in headers.items()}
    fields = {
        name: str(lowered[header.lower()]).strip()
        for name, header in _FORWARDED_HEADERS.items()
        if str(lowered.get(header.lower()) or "").strip()
    }
    return _CORRELATION.set(MappingProxyType(fields))


def reset_guardrail_correlation(token: Token[Mapping[str, str]]) -> None:
    _CORRELATION.reset(token)


def guardrail_correlation() -> Mapping[str, str]:
    """The bound correlation, by contract field (``consultationId``, ``runId``, …;
    ``guardrailOverride`` for the override claim)."""
    return _CORRELATION.get()


def correlation_headers() -> dict[str, str]:
    """The bound correlation (+ override) as the canonical header names, to forward."""
    return {_FORWARDED_HEADERS[name]: value for name, value in guardrail_correlation().items()}


# ── notices ──────────────────────────────────────────────────────────────────


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _notice(
    *,
    notice_type: str,
    direction: str,
    message_key: str,
    checks: Iterable[Mapping[str, str]],
    item_ids: Iterable[str],
    requires_acknowledgement: bool,
    resumable: bool,
    policy_version: str,
) -> dict[str, Any]:
    notice: dict[str, Any] = {
        "schemaVersion": NOTICE_SCHEMA_VERSION,
        "noticeId": str(uuid7()),
        "type": notice_type,
        "direction": direction,
        "action": NOTICE_TYPE_ACTION[notice_type],
        "checks": [dict(check) for check in checks],
    }
    correlation = guardrail_correlation()
    for name in ("consultationId", "runId", "nodeId"):
        if correlation.get(name):
            notice[name] = correlation[name]
    notice.update(
        {
            "itemIds": list(dict.fromkeys(item_ids)),
            "messageKey": message_key,
            "defaultMessage": DEFAULT_MESSAGES[message_key],
            "requiresAcknowledgement": requires_acknowledgement,
            "resumable": resumable,
            "policyVersion": policy_version or UNKNOWN_POLICY_VERSION,
            "occurredAt": _now(),
        }
    )
    return notice


def unverified_notice(
    direction: str, check_ids: Iterable[str], item_ids: Iterable[str] = ()
) -> dict[str, Any]:
    """A check could not run (outage) and the operation continued — warn weight."""
    return _notice(
        notice_type="guardrail.unverified",
        direction=direction,
        message_key="guardrail.unverified.generic",
        checks=[{"checkId": check, "severity": "low"} for check in check_ids],
        item_ids=item_ids,
        requires_acknowledgement=False,
        resumable=False,
        policy_version=UNKNOWN_POLICY_VERSION,
    )


def blocked_notice(
    direction: str,
    message_key: str,
    checks: Iterable[Mapping[str, str]],
    item_ids: Iterable[str] = (),
    policy_version: str = "",
) -> dict[str, Any]:
    """A block guardrail decided, for a verdict that carried no notice of its own."""
    return _notice(
        notice_type="guardrail.blocked",
        direction=direction,
        message_key=message_key,
        checks=checks,
        item_ids=item_ids,
        requires_acknowledgement=True,
        resumable=True,
        policy_version=policy_version,
    )


def redaction_unavailable_notice(item_ids: Iterable[str] = ()) -> dict[str, Any]:
    """The cloud pseudonymiser could not get its PII spans: a privacy hold (§9.8.1)."""
    return _notice(
        notice_type="guardrail.blocked",
        direction="inbound",
        message_key="guardrail.blocked.redaction_unavailable",
        checks=[],
        item_ids=item_ids,
        requires_acknowledgement=False,
        resumable=True,
        policy_version=UNKNOWN_POLICY_VERSION,
    )


def blocked_checks(payload: Any) -> list[dict[str, str]]:
    """The checks a block verdict names, as notice checks (``severity: high``).

    Read from guardrail's per-check ``actionTaken`` / ``action`` when present, else
    from ``reasons`` (check names). Only frozen check ids, never anything else.
    """
    if not isinstance(payload, Mapping):
        return []
    checks: dict[str, dict[str, str]] = {}
    raw_checks = payload.get("checks")
    for check in raw_checks if isinstance(raw_checks, list) else []:
        if not isinstance(check, Mapping):
            continue
        check_id = check.get("checkId", check.get("check_id", check.get("name")))
        taken = check.get("actionTaken", check.get("action_taken", check.get("action")))
        if check_id in CHECK_IDS and taken == "block":
            entry = {"checkId": str(check_id), "severity": "high"}
            category = check.get("category")
            if isinstance(category, str) and category:
                entry = {"checkId": str(check_id), "category": category, "severity": "high"}
            checks.setdefault(str(check_id), entry)
    if not checks:
        reasons = payload.get("reasons")
        for reason in reasons if isinstance(reasons, list) else []:
            if reason in CHECK_IDS:
                checks.setdefault(str(reason), {"checkId": str(reason), "severity": "high"})
    return list(checks.values())


_NOTICE_KEYS = (
    "schemaVersion",
    "noticeId",
    "type",
    "direction",
    "action",
    "checks",
    "consultationId",
    "runId",
    "nodeId",
    "itemIds",
    "messageKey",
    "defaultMessage",
    "requiresAcknowledgement",
    "resumable",
    "policyVersion",
    "occurredAt",
)
_OPTIONAL_STR_KEYS = ("consultationId", "runId", "nodeId")


def _valid_check(check: Any) -> dict[str, str] | None:
    if not isinstance(check, Mapping):
        return None
    if check.get("checkId") not in CHECK_IDS or check.get("severity") not in NOTICE_SEVERITIES:
        return None
    out = {"checkId": str(check["checkId"]), "severity": str(check["severity"])}
    category = check.get("category")
    if category is not None:
        if not isinstance(category, str):
            return None
        out = {"checkId": out["checkId"], "category": category, "severity": out["severity"]}
    return out


def _valid_notice(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, Mapping):
        return None
    notice_type, key = str(raw.get("type")), str(raw.get("messageKey"))
    if (
        raw.get("schemaVersion") != NOTICE_SCHEMA_VERSION
        or not isinstance(raw.get("type"), str)
        or not isinstance(raw.get("messageKey"), str)
        or notice_type not in NOTICE_TYPE_ACTION
        or raw.get("action") != NOTICE_TYPE_ACTION[notice_type]
        or raw.get("direction") not in ("inbound", "outbound")
        or key not in DEFAULT_MESSAGES
        or not key.startswith(f"{notice_type}.")
        or raw.get("defaultMessage") != DEFAULT_MESSAGES[key]
        or not isinstance(raw.get("noticeId"), str)
        or not raw["noticeId"]
        or not isinstance(raw.get("policyVersion"), str)
        or not isinstance(raw.get("occurredAt"), str)
        or not isinstance(raw.get("requiresAcknowledgement"), bool)
        or not isinstance(raw.get("resumable"), bool)
        or not isinstance(raw.get("itemIds"), list)
        or not all(isinstance(item, str) for item in raw["itemIds"])
        or not isinstance(raw.get("checks"), list)
    ):
        return None
    if any(name in raw and not isinstance(raw[name], str) for name in _OPTIONAL_STR_KEYS):
        return None
    checks = [_valid_check(check) for check in raw["checks"]]
    if any(check is None for check in checks):
        return None
    if not checks and key != "guardrail.blocked.redaction_unavailable":
        return None
    notice = {name: raw[name] for name in _NOTICE_KEYS if name in raw}
    notice["checks"] = checks
    notice["itemIds"] = list(raw["itemIds"])
    return notice


def valid_notices(raw: Any) -> list[dict[str, Any]]:
    """The well-formed notices in ``raw``, contract keys only; anything else dropped."""
    if not isinstance(raw, list):
        return []
    return [notice for notice in (_valid_notice(item) for item in raw) if notice is not None]


# ── the per-request accumulator ──────────────────────────────────────────────


@dataclass
class GuardrailOutcome:
    """The notices and evaluation ids one request collected, in the order known."""

    notices: list[dict[str, Any]] = field(default_factory=list)
    evaluation_ids: list[str] = field(default_factory=list)

    def add_notice(self, notice: dict[str, Any]) -> None:
        if all(seen["noticeId"] != notice["noticeId"] for seen in self.notices):
            self.notices.append(notice)

    def add_evaluation_id(self, evaluation_id: Any) -> None:
        if (
            isinstance(evaluation_id, str)
            and evaluation_id
            and evaluation_id not in self.evaluation_ids
        ):
            self.evaluation_ids.append(evaluation_id)

    def add_verdict(self, verdict: Any) -> None:
        """Fold one client verdict's ``notices`` and ``evaluation_id`` in."""
        if not isinstance(verdict, Mapping):
            return
        for notice in valid_notices(verdict.get("notices")):
            self.add_notice(notice)
        self.add_evaluation_id(verdict.get("evaluation_id"))
