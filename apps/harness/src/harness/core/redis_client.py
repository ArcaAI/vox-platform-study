"""Harness's ONE Redis client — the config-invalidation delivery path (TASK-799 A.3, D-5).

Round 2 wired push invalidation for guardrail, text and stt only. harness, nlp and tts
held no Redis client at all, so the subscriber `core/effective_config.py` already
implements had nothing to deliver to it: a control-plane write reached this process only
by the 60s TTL poll. Rule 09 §"Config caches" rule 2 is explicit that this is backwards —
*invalidation is the propagation path; the TTL is a bounded-staleness safety net* — and a
service that converges only on a TTL has given up the property that justifies moving a
value out of env in the first place. The owner approved adding the client (D-5).

**Scope is deliberately one named job per builder.** This module had exactly one when it
was written — the invalidation subscriber — with the instruction *"do not grow it into a
cache or a queue"*. TASK-849 adds a SECOND, and adds it as its own named builder rather
than by widening the first, so the instruction still holds as written: harness caches
nothing in Redis and queues nothing through it. The new job is a WRITE-ONLY append onto a
per-run event stream (``interpreter/run_events.py``) — the TASK-717 Phase C producer, and
the reason the gateway can stop polling. Harness's durable state is still Temporal's; that
stream is a mirror of it, never the record.

**The URL is env-tier and stays that way.** It is how the process REACHES Redis, so it
is exactly the bootstrap floor rule 09 reserves for env; a value delivered over the
channel it configures could never bootstrap itself.

**Every failure degrades to the TTL.** A missing `redis` package, a malformed URL, an
unreachable server — each returns `None`, and the caller simply runs without push
invalidation. A worker that boots while Redis is down must still start, and must still
converge.
"""

from __future__ import annotations

from typing import Any

import structlog

logger = structlog.get_logger(__name__)


def build_invalidation_redis(url: str) -> Any | None:
    """An async Redis client for the invalidation subscriber, or `None`.

    `None` is a supported outcome, not an error: it means "no push path, keep the TTL
    backstop". Construction opens no socket — `redis.asyncio.from_url` is lazy — so a
    client returned here does not prove the server is reachable; the listener's own
    `subscribe` failure is what degrades in that case.
    """
    try:
        from redis.asyncio import Redis
    except ImportError as exc:  # pragma: no cover — the dep is a base dependency
        logger.warning("harness.redis.unavailable", error=str(exc))
        return None

    try:
        return Redis.from_url(url)
    except Exception as exc:  # noqa: BLE001 — a bad URL must not stop the process
        logger.warning(
            "harness.redis.invalid_url",
            error=str(exc),
            error_type=type(exc).__name__,
        )
        return None


def build_run_event_redis(url: str) -> Any | None:
    """An async Redis client for the run-event stream producer, or ``None`` (TASK-849).

    Same construction, same `None`-is-supported posture, DIFFERENT job — and a separate
    connection on purpose: the invalidation client spends its life parked in `subscribe`,
    and a connection in subscriber mode cannot serve `XADD`. Sharing one would either
    break invalidation or block every emit behind it.

    ``None`` means "no push mirror": the run still executes, still records everything in
    Temporal history, and a connected client still gets its snapshot from the ``state``
    query. It loses live deltas, nothing else.
    """
    return build_invalidation_redis(url)
