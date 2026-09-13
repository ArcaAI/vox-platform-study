"""TASK-957 F-5 — the trajectory POST gets a bounded retry and a Redis spool.

`POST {internal_prefix}/trajectory` is the ONLY billing path for a workflow step: the gateway
co-emits one usage-ledger row per persisted `LLM_CALL` step. Until this module,
`_TrajectoryBatch.flush()` caught every exception, logged `harness.report_trajectory.failed`,
and cleared its steps in `finally` — so a gateway restart, a 503 from the internal guard or a
network blip during a run dropped those steps AND every ledger row they would have produced,
permanently, while the run completed and delivered its output. Unbilled revenue that surfaced
only as a `warn` line.

The seq-keyed idempotency (`harness:step:<sessionId>:<runId>:<seq>`, and
`harness:cpu:<sessionId>:<runId>:<activityId>:<attempt>` for compute samples) already made a
redelivery SAFE. The retry simply did not exist. Three decisions shape the one added here:

* **Bounded by attempts AND by wall clock.** Three attempts with jittered backoff, but the
  whole delivery also has a budget: once it is spent no further attempt is STARTED. That is
  what keeps a wedged gateway from costing a phase boundary three full HTTP timeouts — the
  reason `_TRAJECTORY_HTTP_TIMEOUT_S` was deliberately short in the first place. A cheap
  failure (connection refused) still gets all three attempts, because it costs milliseconds.
* **A terminal 4xx is neither retried nor spooled.** `ApiClientError` means apps/api REFUSED
  the body — a contract or state error that the identical body cannot fix. Spooling it would
  poison the spool: every future drain would re-attempt a body that can only be rejected.
  (`408`/`429` are not in that class and stay on the retry path, exactly as the client
  classifies them.)
* **The spool is a shared, bounded, expiring Redis list.** One key for the whole deployment, so
  a batch a since-replaced pod could not deliver is still drained by its successor; worker
  identity and the spool timestamp ride IN each entry, where they diagnose the outage. Entries
  are PHI-free by construction — a trajectory step carries `stats` and a `payloadRef`, never
  content.

Redis absent or unreachable is a SUPPORTED state, like everywhere else in this service: the
spool degrades to a bounded in-process deque, which still absorbs the common case (a gateway
rolling while this worker keeps running) and loses only what a worker restart would lose anyway.
"""

from __future__ import annotations

import json
import os
import random
import socket
import time
from collections import deque
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime
from typing import Any, Protocol

import structlog

from harness.core.config import Settings, get_settings
from harness.core.redis_client import build_trajectory_spool_redis
from harness.services.api_client import ApiClient, ApiClientError, trajectory_body

logger = structlog.get_logger(__name__)

#: Trajectory reporting is fire-and-forget, so it gets a dedicated SHORT HTTP timeout: a wedged
#: gateway must never hold a phase transition hostage for the standard API budget.
TRAJECTORY_HTTP_TIMEOUT_S = 5.0

#: Attempts per delivery, INCLUDING the first. Three absorbs a rolling gateway pod; more would
#: just be the spool's job done badly.
DELIVERY_ATTEMPTS = 3

#: Wall-clock ceiling on one delivery. Checked BEFORE each retry, never mid-flight, so a
#: delivery costs at most this plus the attempt already in progress.
DELIVERY_BUDGET_S = 6.0

BACKOFF_BASE_S = 0.25
BACKOFF_JITTER_S = 0.25

#: ONE key for the deployment. Per-worker keys would strand a batch whenever a pod is replaced,
#: and these bodies are PHI-free and self-describing, so any worker may deliver any of them.
SPOOL_KEY = "hope:harness:trajectory-spool"

#: Newest-wins ceiling. A spool that grows without bound in the process that holds clinical
#: work is a worse failure than losing the oldest metering of a long outage.
SPOOL_MAX_ENTRIES = 500

#: A batch nobody could deliver for a day is not worth keeping: the day's COGS is already
#: reported as null (the drainer's absence is visible), and an unexpiring key is a leak.
SPOOL_TTL_S = 86_400

#: How many spooled batches one drain attempts. Bounded so the drain cannot monopolise the
#: flusher's tick, and re-entered on the next tick until the spool is empty.
SPOOL_DRAIN_PER_TICK = 5


def _now_s() -> float:
    """The delivery budget's clock. A named indirection so a test can script it."""
    return time.monotonic()


def _worker_identity() -> str:
    """Which process spooled a batch — for diagnosis, never for routing."""
    return f"{socket.gethostname()}:{os.getpid()}"


class _TrajectoryPoster(Protocol):
    async def report_trajectory_body(
        self, body: dict[str, Any], *, idempotency_key: str | None = ...
    ) -> Any: ...


BodyDeliverer = Callable[[dict[str, Any]], Awaitable[bool]]


def trajectory_api_client(settings: Settings) -> ApiClient:
    return ApiClient(
        settings.api_base_url,
        internal_prefix=settings.api_internal_prefix,
        service_token=settings.peer_service_token(settings.service_token),
        timeout=min(TRAJECTORY_HTTP_TIMEOUT_S, settings.api_timeout_s),
    )


class TrajectorySpool:
    """Undeliverable trajectory bodies, held until a later flush can post them.

    ``redis_factory`` is resolved ONCE and cached — including a ``None`` answer, which means
    "no Redis on this process, use memory". Construction opens no socket, so a cached client
    does not prove the server is reachable; the first failing command is what degrades.
    """

    def __init__(
        self,
        *,
        redis_factory: Callable[[], Any | None],
        key: str = SPOOL_KEY,
        max_entries: int = SPOOL_MAX_ENTRIES,
        ttl_s: int = SPOOL_TTL_S,
    ) -> None:
        self._redis_factory = redis_factory
        self._key = key
        self._ttl_s = ttl_s
        self._memory: deque[dict[str, Any]] = deque(maxlen=max(1, max_entries))
        self._max_entries = max(1, max_entries)
        self._redis: Any | None = None
        self._resolved = False

    def pending(self) -> int:
        """Batches held IN THIS PROCESS. Diagnostic: the Redis depth is not counted here."""
        return len(self._memory)

    def _client(self) -> Any | None:
        if not self._resolved:
            self._resolved = True
            try:
                self._redis = self._redis_factory()
            except Exception as exc:  # noqa: BLE001 — a spool must never break a flush
                logger.warning("harness.trajectory_spool.redis_unavailable", error=str(exc))
                self._redis = None
        return self._redis

    async def offer(self, body: dict[str, Any]) -> None:
        """Hold one undeliverable body. NEVER raises."""
        entry = {
            "worker": _worker_identity(),
            "spooledAt": datetime.now(UTC).isoformat(),
            "body": body,
        }
        client = self._client()
        if client is not None:
            try:
                await client.rpush(self._key, json.dumps(entry))
                await client.ltrim(self._key, -self._max_entries, -1)
                await client.expire(self._key, self._ttl_s)
                logger.warning(
                    "harness.trajectory_spool.spooled",
                    store="redis",
                    steps=len(body.get("steps") or ()),
                    compute_samples=len(body.get("computeSamples") or ()),
                )
                return
            except Exception as exc:  # noqa: BLE001 — fall through to the memory spool
                logger.warning("harness.trajectory_spool.redis_write_failed", error=str(exc))

        dropped = len(self._memory) == self._memory.maxlen
        self._memory.append(entry)
        logger.warning(
            "harness.trajectory_spool.spooled",
            store="memory",
            depth=len(self._memory),
            dropped_oldest=dropped,
            steps=len(body.get("steps") or ()),
            compute_samples=len(body.get("computeSamples") or ()),
        )

    async def drain(self, deliver: BodyDeliverer, *, max_entries: int) -> int:
        """Post up to ``max_entries`` spooled bodies; returns how many LANDED.

        Stops at the first failure and puts that entry BACK at the FRONT, so the spool keeps
        its order and a still-down gateway is not hammered once per entry. NEVER raises.
        """
        delivered = 0
        for _ in range(max(0, max_entries)):
            entry = await self._pop()
            if entry is None:
                return delivered
            body = entry.get("body")
            if not isinstance(body, dict) or not body:
                # An unreadable entry is dropped rather than retried forever.
                logger.warning("harness.trajectory_spool.entry_unreadable")
                continue
            try:
                landed = await deliver(body)
            except Exception as exc:  # noqa: BLE001 — a drain never breaks its caller
                logger.warning("harness.trajectory_spool.drain_failed", error=str(exc))
                landed = False
            if not landed:
                await self._push_front(entry)
                return delivered
            delivered += 1
        return delivered

    async def _pop(self) -> dict[str, Any] | None:
        """Oldest entry first — memory before Redis, so a degraded write is not stranded."""
        if self._memory:
            return self._memory.popleft()
        client = self._client()
        if client is None:
            return None
        try:
            raw = await client.lpop(self._key)
        except Exception as exc:  # noqa: BLE001
            logger.warning("harness.trajectory_spool.redis_read_failed", error=str(exc))
            return None
        if raw is None:
            return None
        try:
            decoded = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
        except (ValueError, AttributeError, UnicodeDecodeError):
            logger.warning("harness.trajectory_spool.entry_undecodable")
            return None
        return decoded if isinstance(decoded, dict) else None

    async def _push_front(self, entry: dict[str, Any]) -> None:
        client = self._client()
        if client is not None:
            try:
                await client.lpush(self._key, json.dumps(entry))
                return
            except Exception as exc:  # noqa: BLE001
                logger.warning("harness.trajectory_spool.redis_requeue_failed", error=str(exc))
        self._memory.appendleft(entry)


_SPOOL: TrajectorySpool | None = None


def get_trajectory_spool() -> TrajectorySpool:
    """The process-wide spool. One per worker, built lazily off ``settings.redis_url``."""
    global _SPOOL  # noqa: PLW0603 — one spool per process, by design
    if _SPOOL is None:
        _SPOOL = TrajectorySpool(
            redis_factory=lambda: build_trajectory_spool_redis(get_settings().redis_url)
        )
    return _SPOOL


def reset_trajectory_spool() -> None:
    """Drop the process-wide spool. For tests, which must not inherit another's entries."""
    global _SPOOL  # noqa: PLW0603
    _SPOOL = None


def _backoff_seconds(attempt: int) -> float:
    """Exponential with full jitter — so a fleet of workers does not retry in lockstep."""
    return BACKOFF_BASE_S * (2.0 ** (attempt - 1)) + random.uniform(
        0.0, BACKOFF_JITTER_S
    )  # noqa: S311


async def deliver_trajectory(
    client: Any,
    *,
    steps: Sequence[Any] = (),
    compute_samples: Sequence[Any] = (),
    idempotency_key: str | None = None,
    spool: TrajectorySpool | None = None,
) -> bool:
    """Deliver one trajectory batch, retried and spooled. Returns whether it LANDED.

    Posts through ``client.report_trajectory`` — and, when there are no compute samples,
    through its ORIGINAL one-argument signature. That is not incidental: a dozen existing
    suites monkeypatch ``activities._trajectory_api_client`` with a capture object whose
    ``report_trajectory(steps, *, idempotency_key=None)`` is the contract they assert against,
    and this lane is not entitled to break them to save a branch.
    """
    if not steps and not compute_samples:
        return True

    async def _post() -> None:
        if compute_samples:
            await client.report_trajectory(
                steps, compute_samples=compute_samples, idempotency_key=idempotency_key
            )
        else:
            await client.report_trajectory(steps, idempotency_key=idempotency_key)

    return await _deliver(
        _post, trajectory_body(steps, compute_samples), spool=spool, allow_spool=True
    )


async def deliver_trajectory_body(
    client: _TrajectoryPoster,
    body: dict[str, Any],
    *,
    idempotency_key: str | None = None,
    spool: TrajectorySpool | None = None,
    allow_spool: bool = True,
) -> bool:
    """Deliver an ALREADY-BUILT wire body — the spool's re-delivery path.

    ``allow_spool=False`` is for the DRAIN: an entry that fails there is re-queued by the
    spool itself, and spooling it again from here would duplicate it.
    """

    async def _post() -> None:
        await client.report_trajectory_body(body, idempotency_key=idempotency_key)

    return await _deliver(_post, body, spool=spool, allow_spool=allow_spool)


async def _deliver(
    post: Callable[[], Awaitable[None]],
    body: dict[str, Any],
    *,
    spool: TrajectorySpool | None,
    allow_spool: bool,
) -> bool:
    """The retry loop. NEVER raises — every caller is on a path that must not fail."""
    started = _now_s()
    last_error: Exception | None = None
    attempts = 0
    for attempt in range(1, DELIVERY_ATTEMPTS + 1):
        attempts = attempt
        try:
            await post()
            if attempt > 1:
                logger.info("harness.report_trajectory.recovered", attempts=attempt)
            return True
        except ApiClientError as exc:
            # apps/api REFUSED this body. Retrying or spooling it would only repeat the
            # refusal, so it is dropped LOUDLY — the one case where metering is lost on
            # purpose, because the alternative is a permanently poisoned spool.
            logger.warning(
                "harness.report_trajectory.rejected",
                status_code=exc.status_code,
                steps=len(body.get("steps") or ()),
                compute_samples=len(body.get("computeSamples") or ()),
                error=str(exc),
            )
            return False
        except Exception as exc:  # noqa: BLE001 — transport/5xx/anything: retry, then spool
            last_error = exc
            if attempt == DELIVERY_ATTEMPTS:
                break
            if _now_s() - started >= DELIVERY_BUDGET_S:
                break
            await _sleep(_backoff_seconds(attempt))

    logger.warning(
        "harness.report_trajectory.failed",
        attempts=attempts,
        steps=len(body.get("steps") or ()),
        compute_samples=len(body.get("computeSamples") or ()),
        error=str(last_error),
    )
    if allow_spool:
        await (spool or get_trajectory_spool()).offer(body)
    return False


async def _sleep(seconds: float) -> None:
    """Indirection so a suite can make the backoff instant without patching asyncio."""
    import asyncio  # noqa: PLC0415 — keeps this module importable outside a loop

    if seconds > 0:
        await asyncio.sleep(seconds)


async def drain_trajectory_spool(
    settings: Settings | None = None, *, max_entries: int = SPOOL_DRAIN_PER_TICK
) -> int:
    """Re-deliver spooled batches. The WORKER's background job, not the clinical path's.

    Draining inside an activity's flush would make one tenant's phase boundary pay for a past
    outage; the worker's flusher has all the patience in the world and no clinical latency
    budget, so the re-drain lives there.
    """
    spool = get_trajectory_spool()
    if spool.pending() == 0 and spool._client() is None:  # noqa: SLF001 — same module's spool
        return 0
    client = trajectory_api_client(settings or get_settings())

    async def _deliver(body: dict[str, Any]) -> bool:
        return await deliver_trajectory_body(client, body, spool=spool, allow_spool=False)

    return await spool.drain(_deliver, max_entries=max_entries)
