"""The generation hub — producers that outlive the HTTP responses reading them.

specified by The property this module exists to
provide, and the one every test here defends:

    **Killing the HTTP response never kills the producer.**

A streaming generation is an ``asyncio`` task owned by :class:`GenerationHub`,
not by a request. Every SSE response — the one that started it and every later
reconnect — is a *subscriber*. Subscribers come and go; the producer runs to its
own terminal frame, or until an **explicit** cancel.

Three consequences, each of which is a rule rather than an implementation detail:

* **A dropped socket is never a cancel** ( Disconnect detection is
  unreliable — ``request.is_disconnected()`` does not fire under
  ``BaseHTTPMiddleware`` and raises noisily on uvicorn 0.28 — so generation
  lifetime is derived from an explicit persisted flag, never from socket state.
  Nothing in this module calls it.
* **The client's latency never waits on Redis** ( The producer fans a
  delta out to attached subscribers *first*, then appends it to a pending batch
  that a separate flush task writes. The durable write is off the hot path in
  both directions: one ``XADD`` per :data:`FLUSH_MAX_DELTAS` deltas or
  :data:`FLUSH_INTERVAL_S`, whichever comes first. That ratio is AC-5.
* **The ring buffer covers the dual-write race.** A reconnect served from Redis
  alone would miss deltas that were delivered to a live subscriber but not yet
  flushed. :attr:`_Producer.recent` keeps the last :data:`RING_CAPACITY` events
  in process so a same-pod resume is gapless; a cross-pod resume falls back to
  the flushed prefix, which is the ≤ one-batch loss documents as never
  user-visible (those deltas were never delivered to anyone either).
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

import structlog
from prometheus_client import Counter, Histogram

logger = structlog.get_logger(__name__)


# ── Coalescing window ( ────────────────────────────────────────────────
#
# The spec fixes these: "Flush on N = 16-32 deltas OR T = 25 ms, whichever
# first." They are the coalescer's own algorithmic constants, not a tenant-facing
# selection — no engine, model, endpoint or credential is expressed here — so
# they live as named constants rather than as `db-config`. AC-5 asserts the
# ratio they produce. Shipped precedents for the window: LibreChat 25 ms,
# S2 10 chunks / 50 ms.
FLUSH_MAX_DELTAS = 32
FLUSH_INTERVAL_S = 0.025

#: In-process replay depth. Sized well above :data:`FLUSH_MAX_DELTAS` so the
#: whole unflushed window is always recoverable locally, and well below the
#: Redis ``MAXLEN`` so per-stream RSS (AC-2) stays in the single-digit KB.
RING_CAPACITY = 128

#: How long a finished producer stays resolvable so a late reconnect still gets
#: its terminal frame from memory rather than falling back to Redis.
TERMINAL_RETENTION_S = 300.0


# ── AC-5 instrumentation ─────────────────────────────────────────────────────
#
# Labelled by provider only. Tenant is deliberately absent (AC-11: tenant never
# appears in a metric label), and provider is bounded by the registry, so the
# potential series count stays far under 100.
REPLAY_BATCH_WRITES = Counter(
    "text_replay_batch_writes_total",
    "Durable replay-buffer writes. One XADD per batch, never per token (AC-5).",
    ["provider"],
)
REPLAY_DELTAS_TOTAL = Counter(
    "text_replay_deltas_total",
    "Deltas written into the replay buffer. deltas/batch_writes IS the AC-5 ratio.",
    ["provider"],
)
REPLAY_BATCH_DELTAS = Histogram(
    "text_replay_batch_deltas",
    "Deltas coalesced into one durable write.",
    ["provider"],
    buckets=(1, 2, 4, 8, 16, 24, 32, 48, 64),
)
GENERATION_SUBSCRIBERS = Histogram(
    "text_generation_subscribers",
    "Subscribers attached over a generation's life. >1 means a client reconnected.",
    buckets=(0, 1, 2, 3, 5, 10),
)


@dataclass(frozen=True, slots=True)
class GenerationEvent:
    """One SSE event: a monotonic sequence number and its already-encoded body.

    ``payload`` is the wire JSON, built exactly **once** by the producer and
    reused by every subscriber and by the durable write. That single encode
    replaces the two JSON passes and two pydantic validations the per-chunk
    path used to spend on every token  — "the Python tax").
    """

    seq: int
    event: str
    payload: str

    @property
    def is_terminal(self) -> bool:
        return self.event in ("done", "error")


@dataclass(frozen=True, slots=True)
class GenerationPolicy:
    """Abandonment policy for one generation.

    Resolved **tenant → SYSTEM** by :func:`resolve_generation_policy`; these
    field defaults are the in-code FLOOR that applies when the control plane has
    no opinion, in the same sense as ``services/runtime_limits.py``'s floors — a
    gateway that is down leaves the service byte-identical to a gateway with
    nothing to say.

    ``abandon_on_disconnect`` defaults **False** because the owner ruling is that
    nothing may be lost: a clinical summarization whose reader closed the tab
    still runs to completion and is waiting when they come back.
    """

    abandon_on_disconnect: bool = False
    disconnect_grace_seconds: float = 300.0
    max_generation_seconds: float = 1800.0


def resolve_generation_policy(
    app_state: Any, tenant_id: str | None, task_key: str | None = None
) -> GenerationPolicy:
    """Resolve the abandonment policy, **tenant first, then SYSTEM**.

    ``apps/text`` is a stateless router with no database, so the values arrive
    pushed on ``app.state`` by the effective-config pull client, exactly as lane
    budgets and provider limits do. This function only implements the cascade:

    1. the requesting tenant's row for ``task_key``, then its provider-default row;
    2. the SYSTEM row (key ``""``) for the same;
    3. the :class:`GenerationPolicy` floor.

    The "Global" tenant (``50000000-…``) is a CUSTOMER tenant and is never a
    fallback tier — a missing tenant context resolves SYSTEM, never a customer.
    Because widening happens only on ABSENCE, a tenant that expressed an opinion
    is never overridden by the platform default.
    """
    policies = getattr(app_state, "generation_policies", None)
    if not isinstance(policies, dict):
        return GenerationPolicy()

    for scope in (tenant_id, ""):
        if scope is None:
            continue
        scoped = policies.get(scope)
        if not isinstance(scoped, dict):
            continue
        for key in (task_key, ""):
            if key is None:
                continue
            row = scoped.get(key)
            if isinstance(row, dict):
                return _policy_from_row(row)
    return GenerationPolicy()


def _policy_from_row(row: dict[str, Any]) -> GenerationPolicy:
    """Build a policy from a control-plane row, floor-filling anything absent.

    A null or non-numeric value keeps the floor rather than being coerced — the
    same invariant ``apply_provider_limits`` holds for capacity.
    """
    floor = GenerationPolicy()

    def _number(key: str, fallback: float) -> float:
        value = row.get(key)
        if isinstance(value, bool) or not isinstance(value, int | float):
            return fallback
        return float(value) if value > 0 else fallback

    abandon = row.get("abandonOnDisconnect")
    return GenerationPolicy(
        abandon_on_disconnect=(
            abandon if isinstance(abandon, bool) else floor.abandon_on_disconnect
        ),
        disconnect_grace_seconds=_number("disconnectGraceSeconds", floor.disconnect_grace_seconds),
        max_generation_seconds=_number("maxGenerationSeconds", floor.max_generation_seconds),
    )


class _Subscriber:
    """One attached reader. Unbounded queue: a slow reader must never stall the
    producer, and the producer is the thing that must not be interfered with."""

    __slots__ = ("queue",)

    def __init__(self) -> None:
        self.queue: asyncio.Queue[GenerationEvent | None] = asyncio.Queue()


class Producer:
    """A running generation. Owns the provider socket; outlives its readers."""

    def __init__(self, generation_id: str, *, provider: str = "unknown") -> None:
        self.generation_id = generation_id
        self.provider = provider
        self.task: asyncio.Task[None] | None = None
        self.started_at = time.monotonic()

        self._seq = 0
        self._subscribers: set[_Subscriber] = set()
        self._subscriber_count_total = 0
        self._recent: deque[GenerationEvent] = deque(maxlen=RING_CAPACITY)
        self._terminal: GenerationEvent | None = None
        self._finished = asyncio.Event()
        self._cancelled = asyncio.Event()
        self._last_detached_at: float | None = None
        self._finished_at: float | None = None

    # ── producer side ────────────────────────────────────────────────────
    def next_seq(self) -> int:
        self._seq += 1
        return self._seq

    @property
    def seq(self) -> int:
        return self._seq

    def publish(self, event: GenerationEvent) -> None:
        """Deliver to every attached subscriber, then remember it.

        Synchronous and non-blocking by construction — ``put_nowait`` on an
        unbounded queue cannot await — so a subscriber can never add latency to
        the provider read loop, and neither can Redis.
        """
        self._recent.append(event)
        if event.is_terminal:
            self._terminal = event
        for subscriber in self._subscribers:
            subscriber.queue.put_nowait(event)

    def finish(self) -> None:
        """Mark the generation over and release every attached reader."""
        self._finished.set()
        self._finished_at = time.monotonic()
        for subscriber in self._subscribers:
            subscriber.queue.put_nowait(None)
        GENERATION_SUBSCRIBERS.observe(self._subscriber_count_total)

    # ── lifecycle predicates ─────────────────────────────────────────────
    @property
    def finished(self) -> bool:
        return self._finished.is_set()

    @property
    def terminal(self) -> GenerationEvent | None:
        return self._terminal

    @property
    def cancelled(self) -> bool:
        return self._cancelled.is_set()

    def request_cancel(self) -> None:
        """Explicit cancellation — the ONLY thing that stops a producer early.

        Checked between batches by the producer loop. Never reachable from a
        socket event.
        """
        self._cancelled.set()

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def expired(self, now: float | None = None) -> bool:
        """True once a finished producer may be evicted from the hub."""
        if self._finished_at is None:
            return False
        return (now or time.monotonic()) - self._finished_at > TERMINAL_RETENTION_S

    def should_abandon(self, policy: GenerationPolicy, now: float | None = None) -> str | None:
        """Whether this generation must stop, and why. ``None`` means carry on.

        The grace timer starts when the **last subscriber detached**, which for a
        vanished peer is when its heartbeat write failed and sse-starlette tore
        the response down — not when a socket-state probe guessed. That is the
        distinction draws, and it is why this takes no Request.
        """
        clock = now or time.monotonic()
        if clock - self.started_at > policy.max_generation_seconds:
            return "max_generation_seconds"
        if not policy.abandon_on_disconnect:
            return None
        if self._subscribers or self._last_detached_at is None:
            return None
        if clock - self._last_detached_at > policy.disconnect_grace_seconds:
            return "disconnect_grace_expired"
        return None

    # ── subscriber side ──────────────────────────────────────────────────
    def attach(self, after_seq: int) -> tuple[_Subscriber, list[GenerationEvent]]:
        """Attach a reader and hand back whatever the ring can already replay.

        Registering **before** reading the ring is what makes the handover
        gapless: an event published between the two lands in the queue, and the
        caller drops it as a duplicate by sequence number. The reverse order
        would lose it.

        A producer that has **already finished** seeds the end-of-stream sentinel
        immediately. :meth:`finish` can only notify the subscribers attached at
        the moment it ran, so without this a reader arriving one tick late would
        wait on a queue nothing will ever write to — the generation is over.
        """
        subscriber = _Subscriber()
        self._subscribers.add(subscriber)
        self._subscriber_count_total += 1
        if self._finished.is_set():
            subscriber.queue.put_nowait(None)
        self._last_detached_at = None
        replay = [event for event in self._recent if event.seq > after_seq]
        return subscriber, replay

    def detach(self, subscriber: _Subscriber) -> None:
        self._subscribers.discard(subscriber)
        if not self._subscribers:
            self._last_detached_at = time.monotonic()

    async def wait_finished(self) -> None:
        await self._finished.wait()


class GenerationHub:
    """Process-local registry of live producers.

    Deliberately *not* a distributed structure: durability across pods is the
    replay buffer's job. This only has to make a producer outlive the response
    that created it, and make a reconnect on the same pod gapless.
    """

    def __init__(self) -> None:
        self._producers: dict[str, Producer] = {}

    def __contains__(self, generation_id: object) -> bool:
        return generation_id in self._producers

    def get(self, generation_id: str) -> Producer | None:
        return self._producers.get(generation_id)

    def start(
        self,
        generation_id: str,
        body: Callable[[Producer], Awaitable[None]],
        *,
        provider: str = "unknown",
    ) -> Producer:
        """Launch ``body`` as a detached task and return its producer handle.

        ``asyncio.create_task`` with the reference held **here** is the whole
        mechanism: the task's lifetime is the hub's, not the request scope's, so
        Starlette cancelling the request on disconnect cannot reach it. This is
        the reason the old ``BackgroundTasks`` hand-off had to go — that runs
        *after* the response completes and is owned by it.
        """
        self._evict_expired()
        producer = Producer(generation_id, provider=provider)
        self._producers[generation_id] = producer

        async def _run() -> None:
            try:
                await body(producer)
            except asyncio.CancelledError:
                producer.finish()
                raise
            except Exception:
                logger.error(
                    "generation.producer_crashed",
                    generation_id=generation_id,
                    exc_info=True,
                )
                producer.finish()
            finally:
                if not producer.finished:
                    producer.finish()

        producer.task = asyncio.create_task(_run(), name=f"text-generation-{generation_id}")
        return producer

    def forget(self, generation_id: str) -> None:
        self._producers.pop(generation_id, None)

    def _evict_expired(self) -> None:
        now = time.monotonic()
        for generation_id in [
            gid for gid, producer in self._producers.items() if producer.expired(now)
        ]:
            self._producers.pop(generation_id, None)

    async def drain(self, timeout: float = 30.0) -> None:
        """Await every live producer — for lifespan shutdown."""
        tasks = [p.task for p in self._producers.values() if p.task and not p.task.done()]
        if not tasks:
            return
        await asyncio.wait(tasks, timeout=timeout)


def get_generation_hub(app: Any) -> GenerationHub:
    """The hub on ``app.state``, created on first use.

    Lazy rather than constructed in ``create_app()`` because ``main.py`` is an
    orchestrator-owned surface on (EXECUTION-PLAN Eager
    construction plus a ``hub.drain()`` call in ``lifespan``'s shutdown is the
    better home and is listed in this lane's REGISTRATIONS.
    """
    hub = getattr(app.state, "generation_hub", None)
    if hub is None:
        hub = GenerationHub()
        app.state.generation_hub = hub
    return hub


def dedupe_by_seq(
    events: Iterable[GenerationEvent], after_seq: int
) -> tuple[list[GenerationEvent], int]:
    """Drop anything at or before ``after_seq``; report the new high-water mark.

    The single mechanism behind AC-15's "no gap, no duplicate": backlog from
    Redis and replay from the ring overlap by construction, and sequence numbers
    are what make the overlap harmless.
    """
    kept: list[GenerationEvent] = []
    cursor = after_seq
    for event in events:
        if event.seq <= cursor:
            continue
        kept.append(event)
        cursor = event.seq
    return kept, cursor


@dataclass(slots=True)
class BatchFlusher:
    """Coalesces deltas and writes one durable batch per window (AC-5).

    Runs as its own task. The producer only ever calls :meth:`offer`, which
    appends to a list and possibly sets an event — no await, no Redis, no
    encode. Everything expensive happens here, behind the client.
    """

    generation_id: str
    provider: str
    #: Returns whatever the buffer's writer returns (a message id, typically);
    #: the flusher only cares that it completed.
    write: Callable[[list[GenerationEvent]], Awaitable[Any]]
    _pending: list[GenerationEvent] = field(default_factory=list)
    _signal: asyncio.Event = field(default_factory=asyncio.Event)
    _closed: bool = False

    def offer(self, event: GenerationEvent) -> None:
        self._pending.append(event)
        if len(self._pending) >= FLUSH_MAX_DELTAS or event.is_terminal:
            self._signal.set()

    def close(self) -> None:
        self._closed = True
        self._signal.set()

    async def run(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self._signal.wait(), timeout=FLUSH_INTERVAL_S)
            except TimeoutError:
                pass
            self._signal.clear()
            await self._drain()
            if self._closed and not self._pending:
                return

    async def _drain(self) -> None:
        if not self._pending:
            return
        batch, self._pending = self._pending, []
        try:
            await self.write(batch)
        except Exception as exc:  # noqa: BLE001 — durability is best-effort
            # A replay-buffer write failure must never break the live stream:
            # the client already has these bytes. It degrades resumability for
            # this window, which is strictly better than failing a generation
            # that is succeeding.
            logger.warning(
                "generation.replay_write_failed",
                generation_id=self.generation_id,
                deltas=len(batch),
                error=str(exc),
            )
            return
        REPLAY_BATCH_WRITES.labels(provider=self.provider).inc()
        REPLAY_DELTAS_TOTAL.labels(provider=self.provider).inc(len(batch))
        REPLAY_BATCH_DELTAS.labels(provider=self.provider).observe(len(batch))
