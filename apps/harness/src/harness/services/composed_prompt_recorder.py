"""OD-9 — record every composed LLM request at the gateway, fire-and-forget.

The gateway stores the composed ``system`` / ``user`` messages Transit-encrypted for incident
reconstruction (``ComposedPromptRecord``, 30-day retention). The harness posts what it SENT to
``apps/text`` after each successful text call, through ``POST /api/v1/internal/composed-prompts``.

Three properties are the whole point of this module:

* **Never fails the step.** Every exception is swallowed here; the call site cannot see one.
* **Never delays the step.** :func:`record_composed_prompt` only SCHEDULES the post on the running
  loop and returns. The post itself has ONE attempt at a timeout of :data:`RECORD_TIMEOUT_S`.
* **No retry storm.** No retry at all, and at most :data:`MAX_PENDING` posts in flight per
  process: a hung gateway costs a bounded number of dropped records, never an unbounded backlog.

A failure is logged with COUNTS only — the composed messages are PHI and never reach a log line.

Activity / node code only. It is I/O and uses the running event loop, so it must never be
called from ``@workflow.defn`` code.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any, Literal

import structlog

from harness.core.config import get_settings
from harness.services.api_client import ApiClient

__all__ = [
    "MAX_PENDING",
    "RECORD_TIMEOUT_S",
    "composed_prompt_body",
    "drain_pending",
    "locality_of",
    "record_composed_prompt",
]

_LOGGER = structlog.get_logger(__name__)

#: Upper bound of one record post, connect included.
RECORD_TIMEOUT_S = 2.0

#: Posts allowed in flight per process; beyond it a record is dropped and logged.
MAX_PENDING = 32

Locality = Literal["local", "cloud"]

#: Strong references, so a scheduled post is not garbage-collected mid-flight.
_PENDING: set[asyncio.Task[None]] = set()


def locality_of(egress: Any) -> Locality:
    """``egress.locality`` off text's response, or ``cloud`` — text's own fail-closed reading."""
    if isinstance(egress, Mapping) and egress.get("locality") == "local":
        return "local"
    return "cloud"


def composed_prompt_body(
    *,
    phase: str,
    provider: str,
    egress: Any,
    system: str,
    user: str,
    consultation_id: str | None = None,
    agent_slug: str | None = None,
) -> dict[str, Any]:
    """The wire body. Absent optionals are omitted, never sent as ``null``."""
    body: dict[str, Any] = {}
    if consultation_id:
        body["consultationId"] = consultation_id
    if agent_slug:
        body["agentSlug"] = agent_slug
    body.update(
        {
            "phase": phase,
            "provider": provider,
            "locality": locality_of(egress),
            "system": system,
            "user": user,
        }
    )
    return body


async def _post_record(body: dict[str, Any], tenant_id: str) -> None:
    settings = get_settings()
    client = ApiClient(
        settings.api_base_url,
        service_token=settings.peer_service_token(settings.service_token),
        timeout=RECORD_TIMEOUT_S,
    )
    await client.record_composed_prompt(body, tenant_id=tenant_id)


#: The sender — a seam: the hermetic suite replaces it (``tests/conftest.py``).
_send = _post_record


async def _record(body: dict[str, Any], tenant_id: str) -> None:
    try:
        # The client timeout bounds each phase; this bounds the whole post.
        await asyncio.wait_for(_send(body, tenant_id), timeout=RECORD_TIMEOUT_S)
    except BaseException as exc:  # noqa: BLE001 — recording must never surface anything
        if isinstance(exc, asyncio.CancelledError):
            return
        _LOGGER.warning(
            "harness.composed_prompt.record_failed",
            error_type=type(exc).__name__,
            phase=body.get("phase"),
            system_chars=len(body.get("system") or ""),
            user_chars=len(body.get("user") or ""),
        )


def record_composed_prompt(
    *,
    tenant_id: str,
    phase: str,
    provider: str,
    egress: Any,
    system: str | None,
    user: str | None,
    consultation_id: str | None = None,
    agent_slug: str | None = None,
) -> None:
    """Schedule one record post and return immediately. Never raises."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    try:
        if len(_PENDING) >= MAX_PENDING:
            _LOGGER.warning("harness.composed_prompt.dropped", pending=len(_PENDING), phase=phase)
            return
        body = composed_prompt_body(
            phase=phase,
            provider=provider,
            egress=egress,
            system=system or "",
            user=user or "",
            consultation_id=consultation_id,
            agent_slug=agent_slug,
        )
        task = loop.create_task(_record(body, tenant_id))
        _PENDING.add(task)
        task.add_done_callback(_PENDING.discard)
    except Exception as exc:  # noqa: BLE001 — recording must never surface anything
        _LOGGER.warning("harness.composed_prompt.schedule_failed", error_type=type(exc).__name__)


async def drain_pending() -> None:
    """Await every scheduled post — for tests and orderly shutdown."""
    while _PENDING:
        await asyncio.gather(*list(_PENDING), return_exceptions=True)
