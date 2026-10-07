"""TASK-1050 W2f — the guardrail hold and notices, the parts both sides of the walk share.

Two halves, kept apart on purpose:

* PURE helpers the deterministic workflow body calls (``hold_override``, ``hold_wait_seconds``):
  no clock, no randomness, no I/O — every input is a recorded value or ``workflow.*`` time.
* ACTIVITY helpers (``run_notices``, ``hold_notice``) that fill and, when the text service sent
  none, MINT a ``GuardrailNotice`` v1 — ``uuid7()`` reads the clock and ``os.urandom``, so they are
  never called from workflow code.

A notice carries no content and no judge reasoning (README §9.7.3); every one leaving here passes
``run_protocol.guardrail_notice_problems`` (its ``defaultMessage`` is the fixed label of its key).
"""

from __future__ import annotations

import os
import time
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

import structlog

from harness.temporal.interpreter.run_protocol import (
    RUN_GUARDRAIL_NOTICE_MESSAGES,
    guardrail_notice_problems,
)

_LOGGER = structlog.get_logger(__name__)

#: The two hold kinds (`GuardrailHold.kind`).
HOLD_BLOCKED = "blocked"
HOLD_REDACTION_UNAVAILABLE = "redaction_unavailable"

#: The resolution that asks the text service to proceed once, at warn weight (README §9.7.5).
RESOLUTION_ACKNOWLEDGED = "acknowledged"

#: `policyVersion` of a notice the harness had to mint: the refusal named no policy (a privacy
#: outage is not a policy verdict). A fixed token, so a reader can tell a minted notice apart.
MINTED_POLICY_VERSION = "unavailable"


def uuid7() -> str:
    """A UUIDv7 (RFC 9562: 48-bit ms timestamp, version 7, variant 10). ACTIVITY ONLY."""
    millis = time.time_ns() // 1_000_000
    raw = bytearray(millis.to_bytes(6, "big") + os.urandom(10))
    raw[6] = (raw[6] & 0x0F) | 0x70
    raw[8] = (raw[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(raw)))


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def fill_notice(
    notice: dict[str, Any],
    *,
    run_id: str | None,
    node_id: str | None,
    consultation_id: str | None,
) -> dict[str, Any]:
    """The notice with the run's correlation filled where the text service left it out (pure).

    A value the producer already set is kept: the text service knows the run only through the
    correlation headers it was sent, so the two can only agree.
    """
    filled = dict(notice)
    for key, value in (("runId", run_id), ("nodeId", node_id), ("consultationId", consultation_id)):
        if value and not filled.get(key):
            filled[key] = value
    return filled


def run_notices(
    raw: Iterable[Any],
    *,
    run_id: str | None,
    node_id: str | None,
    consultation_id: str | None,
) -> list[dict[str, Any]]:
    """The conforming warn / unverified notices of one generation, filled and de-duplicated.

    A notice that does not conform is DROPPED and logged by id only — emitting it would put a
    free-text message (possibly PHI) on the public plane, and one bad notice inside
    ``run.completed.guardrailNotices`` would make the whole terminal event non-conforming.
    """
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for notice in raw:
        if not isinstance(notice, dict):
            continue
        filled = fill_notice(
            notice, run_id=run_id, node_id=node_id, consultation_id=consultation_id
        )
        problems = guardrail_notice_problems(filled)
        notice_id = filled.get("noticeId")
        if problems:
            _LOGGER.warning(
                "harness.guardrail.notice_dropped",
                notice_id=notice_id if isinstance(notice_id, str) else None,
                node_id=node_id,
                problems=len(problems),
            )
            continue
        if notice_id in seen:
            continue
        seen.add(notice_id)
        out.append(filled)
    return out


def minted_notice(
    kind: str,
    *,
    run_id: str | None,
    node_id: str | None,
    consultation_id: str | None,
) -> dict[str, Any]:
    """A conforming ``guardrail.blocked`` notice for a refusal that carried none. ACTIVITY ONLY.

    * ``redaction_unavailable`` — the privacy hold (``guardrail.blocked.redaction_unavailable``):
      no check judged anything (``checks`` is empty), and the client's only action is to retry,
      so it needs no acknowledgement.
    * ``blocked`` without a usable notice — the generic inbound block.
    """
    key = (
        "guardrail.blocked.redaction_unavailable"
        if kind == HOLD_REDACTION_UNAVAILABLE
        else "guardrail.blocked.inbound"
    )
    notice: dict[str, Any] = {
        "schemaVersion": 1,
        "noticeId": uuid7(),
        "type": "guardrail.blocked",
        "direction": "inbound",
        "action": "block",
        "checks": [],
        "itemIds": [],
        "messageKey": key,
        "defaultMessage": RUN_GUARDRAIL_NOTICE_MESSAGES[key],
        "requiresAcknowledgement": kind != HOLD_REDACTION_UNAVAILABLE,
        "resumable": True,
        "policyVersion": MINTED_POLICY_VERSION,
        "occurredAt": _now_iso(),
    }
    return fill_notice(notice, run_id=run_id, node_id=node_id, consultation_id=consultation_id)


def hold_notice(
    kind: str,
    notice: dict[str, Any] | None,
    *,
    run_id: str | None,
    node_id: str | None,
    consultation_id: str | None,
) -> dict[str, Any]:
    """The notice a hold publishes: the text service's own, filled — or a minted one when it sent
    none, or one that does not conform. ACTIVITY ONLY (it may mint)."""
    if isinstance(notice, dict):
        filled = fill_notice(
            notice, run_id=run_id, node_id=node_id, consultation_id=consultation_id
        )
        if not guardrail_notice_problems(filled) and filled.get("type") == "guardrail.blocked":
            return filled
        _LOGGER.warning(
            "harness.guardrail.hold_notice_replaced",
            node_id=node_id,
            kind=kind,
        )
    return minted_notice(kind, run_id=run_id, node_id=node_id, consultation_id=consultation_id)


# ---------------------------------------------------------------------------------------------
# Pure — safe in the workflow body.
# ---------------------------------------------------------------------------------------------


def hold_override(kind: str, resolution: str, notice_id: str) -> str | None:
    """The ``X-Hope-Guardrail-Override`` value a node re-run sends, or ``None`` (pure).

    Only an ``acknowledged`` resolution of a ``blocked`` hold overrides — once, for that notice.
    A privacy hold (``redaction_unavailable``) is NEVER overridable: unredacted PHI is never sent
    to a cloud model because someone clicked through (README §9.8.1 "what stays strict"); its
    resume simply re-runs the node. ``item_excluded`` / ``item_edited`` re-run without one: the
    gateway composer has already changed what the node is handed.
    """
    if kind == HOLD_BLOCKED and resolution == RESOLUTION_ACKNOWLEDGED:
        return notice_id
    return None


def hold_wait_seconds(
    requested: int | None,
    *,
    ceiling: int,
    execution_timeout_seconds: float | None,
    elapsed_seconds: float,
    grace_seconds: int,
) -> float:
    """How long ONE hold waits for its resolution (pure; every input is recorded / workflow time).

    The gateway's ``limits.guardrailHoldTimeoutSeconds`` (tighten-only under ``ceiling``), else the
    ceiling — and, whichever it is, never past the run's own ``execution_timeout`` backstop less
    its grace, so the walk itself always ends the hold and emits ``run.failed GUARDRAIL_BLOCKED``
    instead of Temporal killing the execution silently. Never below one second.
    """
    seconds = float(ceiling if requested is None else min(requested, ceiling))
    if execution_timeout_seconds is not None:
        remaining = execution_timeout_seconds - elapsed_seconds - grace_seconds
        seconds = min(seconds, remaining)
    return max(1.0, seconds)
