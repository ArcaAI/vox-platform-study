"""Async worker-pool consumer entry point (TASK-725 Task 7).

Run via ``pnpm text:worker:dev`` (a native conda process — see
``scripts/dev-service.sh``'s ``text-worker`` case), NOT a Docker Compose
service — no Python service in this monorepo runs as a compose service today
(design-notes.md / TASK-725 §2.2 confirms no per-service compose block
exists; only infra dependencies do). This mirrors ``stt:worker:dev``'s local
story (a Dramatiq consumer launched the same way), just for this ticket's
Redis-Streams-backed worker pool instead.

Claims tasks from ``services/worker_pool_queue.WorkerPoolQueue``, dispatches
by ``task_type``, ACKs on success (or on a task-level failure — see
``WorkerPoolConsumer._process``). Task STATE stays
``services/task_manager.TaskManager``'s job (unchanged, extended not
replaced) — this process updates it, never invents a parallel store.

**Scope note:** both handlers are fully implemented. EMBEDDING was TASK-725's
net-new capability (§2.7): resolve ``tei-embed`` from the embedding registry,
call ``.embed(texts)``. BATCH_GENERATION reuses the SAME ``ProviderRegistry``
+ ``LLMProvider.generate()`` contract the synchronous ``/generate`` endpoint
calls (``api/endpoints/generate.py``) — the provider itself already enforces
the fail-closed model-selection guard (``require_model``, ``providers/base.py``)
for cloud engines, so the worker does not duplicate it. What it deliberately
does NOT re-thread out-of-process is ``/generate``'s per-request
rate-limiter/circuit-breaker/semaphore/idempotency-cache machinery — those are
same-pod backpressure concerns for the SYNCHRONOUS request path, orthogonal to
a worker pool that already serializes work per consumer and lets
``WorkerPoolConsumer``'s ack-on-failure loop (never re-running an
already-terminal task, per idempotency-key convention) absorb a bad task
without wedging the stream.
"""

from __future__ import annotations

import asyncio
import signal
import uuid
from collections.abc import Awaitable, Callable

import httpx
import redis.asyncio as aioredis
import structlog

from text.core.config import get_settings
from text.core.logging import setup_logging
from text.main import _register_provider_factories
from text.models.requests import GenerateRequest
from text.models.task import TaskStatus
from text.models.worker_task import WorkerTaskEnvelope, WorkerTaskType
from text.providers.base import ProviderRegistry
from text.providers.tei_embed import TeiEmbedProvider
from text.services.task_manager import TaskManager
from text.services.worker_pool_queue import WorkerPoolQueue

logger = structlog.get_logger(__name__)

_CONSUMER_NAME = f"worker-{uuid.uuid4().hex[:8]}"

_TERMINAL_STATUSES = (TaskStatus.COMPLETED, TaskStatus.FAILED)

TaskHandler = Callable[[WorkerTaskEnvelope], Awaitable[None]]


class WorkerPoolConsumer:
    """Claims + processes tasks for ONE ``task_type``, honoring a drain flag."""

    def __init__(
        self,
        task_type: WorkerTaskType,
        queue: WorkerPoolQueue,
        task_manager: TaskManager,
        handler: TaskHandler,
    ) -> None:
        self._task_type = task_type
        self._queue = queue
        self._task_manager = task_manager
        self._handler = handler
        self._draining = False

    def request_drain(self) -> None:
        """Stop claiming NEW work. The currently in-flight ``_process`` call
        (if any) still runs to completion — TASK-725 Task 6's worker-side
        drain half (the API pod's own drain, Task 6's other half, is
        unaffected — a worker is a separate process/pod per design.md)."""
        self._draining = True

    async def run(self) -> None:
        while not self._draining:
            claimed = await self._queue.claim(
                self._task_type, consumer=_CONSUMER_NAME, count=1, block_ms=5000
            )
            for msg_id, envelope in claimed:
                await self._process(msg_id, envelope)

    async def _process(self, msg_id: str, envelope: WorkerTaskEnvelope) -> None:
        # Idempotency: a Redis Streams consumer group is at-least-once — a
        # worker crash between finishing work and ACKing re-delivers the SAME
        # message. Skip work already recorded as terminal rather than
        # re-running (and, for a paid engine, re-billing) it.
        existing = await self._task_manager.get_task(envelope.task_id)
        if existing is not None and existing.status in _TERMINAL_STATUSES:
            logger.info(
                "worker_pool.duplicate_delivery_skipped",
                task_id=envelope.task_id,
                task_type=self._task_type.value,
            )
            await self._queue.ack(self._task_type, msg_id)
            return

        await self._task_manager.update_task(envelope.task_id, status=TaskStatus.RUNNING)
        try:
            await self._handler(envelope)
            await self._task_manager.update_task(envelope.task_id, status=TaskStatus.COMPLETED)
        except Exception as exc:  # noqa: BLE001 — one bad task must not kill the consumer loop
            logger.error(
                "worker_pool.task_failed",
                task_id=envelope.task_id,
                task_type=self._task_type.value,
                error=str(exc),
            )
            await self._task_manager.update_task(
                envelope.task_id, status=TaskStatus.FAILED, error=str(exc)
            )
        finally:
            # ACK unconditionally — a task-level failure is recorded on
            # TaskManager (terminal), not left to redeliver forever.
            await self._queue.ack(self._task_type, msg_id)


async def _handle_embedding(envelope: WorkerTaskEnvelope, *, embedding_provider: TeiEmbedProvider) -> None:
    texts = envelope.payload.get("texts") or []
    if not texts:
        raise ValueError("embedding task payload carries no 'texts'")
    await embedding_provider.embed(texts)


async def _handle_batch_generation(
    envelope: WorkerTaskEnvelope, *, provider_registry: ProviderRegistry
) -> None:
    """Execute one queued batch-generation task.

    ``envelope.payload`` is the same shape ``GenerateRequest`` validates on
    the synchronous ``/generate`` path — fails closed (``pydantic.ValidationError``)
    on a malformed payload rather than dispatching a garbage request to a paid
    engine. Provider resolution reuses ``ProviderRegistry.get()`` unchanged, so
    an unregistered provider fails closed with the SAME ``ProviderNotFoundError``
    ``/generate`` raises; a cloud provider missing its model still fails closed
    via that provider's own ``require_model`` guard. Either exception propagates
    to ``WorkerPoolConsumer._process``, which records the task FAILED and ACKs
    it — one bad task never wedges the stream.
    """
    request = GenerateRequest.model_validate(envelope.payload)
    provider = provider_registry.get(request.provider)
    await provider.generate(request)


async def main() -> None:
    """Process entry point — ``python -m text.worker`` /
    ``pnpm text:worker:dev``."""
    settings = get_settings()
    setup_logging(settings.log_level)

    # Shared client for BOTH embedding (tei-embed) and generation (the nine
    # LLM providers `_register_provider_factories` wires below) — mirrors
    # `main.py`'s lifespan client (`httpx.Timeout(300.0)`), not the shorter
    # tei-embed-only timeout this used to carry, since it now also backs
    # batch-generation calls that can run far longer than an embed call.
    http_client = httpx.AsyncClient(timeout=httpx.Timeout(300.0))
    redis_client = aioredis.from_url(settings.redis.redis_url, decode_responses=True)
    task_manager = TaskManager(
        redis=redis_client,
        task_ttl=settings.redis.task_ttl_seconds,
        stream_max_len=settings.redis.stream_max_len,
    )
    queue = WorkerPoolQueue(redis=redis_client)
    embedding_provider = TeiEmbedProvider(settings.tei_embed, http_client)

    # Same lazy, connection-gated factory registration the FastAPI app uses
    # (`main.py::lifespan`) — a provider is available here iff it would be
    # available to the synchronous `/generate` endpoint too, so batch
    # generation never has a wider (or narrower) provider surface than sync.
    provider_registry = ProviderRegistry()
    _register_provider_factories(provider_registry, settings, http_client)

    async def _embedding_handler(envelope: WorkerTaskEnvelope) -> None:
        await _handle_embedding(envelope, embedding_provider=embedding_provider)

    async def _batch_generation_handler(envelope: WorkerTaskEnvelope) -> None:
        await _handle_batch_generation(envelope, provider_registry=provider_registry)

    consumers = [
        WorkerPoolConsumer(WorkerTaskType.EMBEDDING, queue, task_manager, _embedding_handler),
        WorkerPoolConsumer(
            WorkerTaskType.BATCH_GENERATION, queue, task_manager, _batch_generation_handler
        ),
    ]

    loop = asyncio.get_event_loop()

    def _request_drain() -> None:
        logger.info("worker_pool.draining")
        for consumer in consumers:
            consumer.request_drain()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _request_drain)

    logger.info(
        "worker_pool.started",
        consumer=_CONSUMER_NAME,
        task_types=[t.value for t in WorkerTaskType],
    )
    try:
        await asyncio.gather(*(consumer.run() for consumer in consumers))
    finally:
        await http_client.aclose()
        await redis_client.aclose()
        logger.info("worker_pool.shutdown_complete")


if __name__ == "__main__":
    asyncio.run(main())
