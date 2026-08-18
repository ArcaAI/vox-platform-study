"""Job processor for async guardrail analysis using Redis-backed priority queues."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager, nullcontext
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import uuid4

import redis.asyncio as aioredis

from guardrail.core.logging import get_logger

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from guardrail.providers.gliner import GlinerProvider

logger = get_logger(__name__)


class JobProcessor:
    """Processes guardrail analysis jobs using Redis-backed priority queues.

    the GLiNER provider is loaded lazily and DB-selected. In the
    running service a ``gliner_provider_resolver`` (a pinned-context factory) is
    injected so a booted worker holds no GLiNER weights; it acquires + pins the
    DB-selected provider only while a claimed job runs, and a missing DB
    selection fails the job closed. Tests may still inject a concrete
    ``gliner_provider`` directly.
    """

    def __init__(
        self,
        redis: aioredis.Redis,
        gliner_provider: GlinerProvider | None = None,
        max_concurrent: int = 4,
        gliner_provider_resolver: (
            Callable[[str | None], AbstractAsyncContextManager[GlinerProvider]] | None
        ) = None,
    ) -> None:
        self.redis: Any = redis
        self.gliner_provider = gliner_provider
        self._gliner_provider_resolver = gliner_provider_resolver
        self.max_concurrent = max_concurrent
        self.processing = False
        self.semaphore = asyncio.Semaphore(max_concurrent)
        self._active_tasks: set[asyncio.Task[None]] = set()
        self.worker_id = f"worker-{uuid4()}"
        self.claim_timeout_ms = 300000

        # Redis queue names
        self.job_queue = "guardrail:jobs:pending"
        self.processing_queue = "guardrail:jobs:processing"
        self.result_stream = "guardrail:results"
        self.status_key_prefix = "guardrail:status:"

        # Job priorities
        self.priority_map = {
            "low": 1,
            "normal": 5,
            "high": 10,
        }

    async def submit_job(
        self,
        text: str,
        guardrail_type: str = "comprehensive",
        request_id: str | None = None,
        priority: str = "normal",
        tenant_id: str | None = None,
    ) -> str:
        """Submit a new guardrail analysis job.

        ``tenant_id`` is the SUBMITTING tenant (or a declared ``tenantless:<reason>``
        marker) and is stored with the job so the deferred decision stays attributable.
        Jobs previously ran with no tenant at all, which silently resolved the SYSTEM
        floor for a tenant that may have chosen a stricter posture.
        """

        job_id = request_id or f"job_{int(time.time() * 1000)}"
        created_at_ms = int(time.time() * 1000)
        priority_score = self.priority_map.get(priority, 5)
        created_at = datetime.now(UTC).isoformat()

        job_data = {
            "job_id": job_id,
            "text": text,
            "guardrail_type": guardrail_type,
            "request_id": request_id,
            "priority": priority,
            "priority_score": str(priority_score),
            "created_at": created_at,
            "updated_at": created_at,
            "created_at_ms": str(created_at_ms),
            "status": "pending",
            # Redis hashes cannot hold None — an unattributed job stores the empty
            # string, which `_process_job` reads back as "no tenant recorded".
            "tenant_id": tenant_id or "",
        }

        await self.redis.hset(
            f"{self.status_key_prefix}{job_id}",
            mapping=job_data,
        )

        await self.redis.zadd(
            self.job_queue,
            {job_id: self._queue_score(priority_score, created_at_ms)},
        )

        logger.info(
            "job_processor.job_submitted",
            job_id=job_id,
            guardrail_type=guardrail_type,
            priority=priority,
            tenant_id=tenant_id,
        )

        return job_id

    @staticmethod
    def _owned_by(job_data: dict[str, Any], tenant_id: str | None) -> bool:
        """Does ``tenant_id`` own this job?

        ``tenant_id=None`` means "no scoping" and is for INTERNAL callers only (the
        worker loop); every HTTP route passes a real tenant. Ownership is an exact match
        against the tenant stamped at submit time, so a declared ``tenantless:<reason>``
        marker owns its own jobs and nothing else — it is a declaration, not a master
        key. A job with no recorded tenant (submitted before the stamp existed) matches
        nobody: unattributed work fails CLOSED rather than becoming readable by all.
        """
        if tenant_id is None:
            return True
        return bool(job_data.get("tenant_id")) and job_data.get("tenant_id") == tenant_id

    async def get_job_status(
        self, job_id: str, tenant_id: str | None = None
    ) -> dict[str, Any] | None:
        """Get the status of a specific job, scoped to the submitting tenant.

        A job belonging to another tenant is reported as ABSENT (``None``) rather than
        forbidden — job ids are caller-supplied (``request_id``) and therefore guessable,
        so the 404-over-403 posture is what stops existence itself from leaking.
        """

        status_data: dict[str, Any] = await self.redis.hgetall(f"{self.status_key_prefix}{job_id}")

        if not status_data:
            return None

        if not self._owned_by(status_data, tenant_id):
            logger.warning(
                "job_processor.cross_tenant_job_read_refused",
                job_id=job_id,
                requesting_tenant=tenant_id,
            )
            return None

        # Parse JSON fields if needed
        if "result" in status_data and status_data["result"]:
            try:
                status_data["result"] = json.loads(status_data["result"])
            except json.JSONDecodeError:
                pass

        return status_data

    async def list_jobs(
        self,
        status: str | None = None,
        limit: int = 50,
        offset: int = 0,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        """List the calling tenant's jobs, with optional status filtering.

        Tenant filtering happens BEFORE pagination, so ``total`` and the page window
        both describe the caller's own jobs — paginating a cross-tenant key list would
        leak other tenants' job COUNTS through the offsets even with the rows hidden.

        The unbounded ``KEYS`` scan below is pre-existing and tracked separately as F-23
        in ``docs/architecture/agentic-workflow-platform/conformance/python-services.md``;
        this change deliberately does not widen its scope.
        """

        # Get all job status keys
        keys = await self.redis.keys(f"{self.status_key_prefix}*")
        keys.sort()

        matched = []
        for key in keys:
            job_data = await self.redis.hgetall(key)
            if not job_data or not self._owned_by(job_data, tenant_id):
                continue
            if status is not None and job_data.get("status") != status:
                continue
            # Parse result if present
            if "result" in job_data and job_data["result"]:
                try:
                    job_data["result"] = json.loads(job_data["result"])
                except json.JSONDecodeError:
                    pass
            matched.append(job_data)

        return {
            "jobs": matched[offset : offset + limit],
            "total": len(matched),
            "limit": limit,
            "offset": offset,
        }

    async def cancel_job(self, job_id: str, tenant_id: str | None = None) -> bool:
        """Cancel a pending or processing job owned by ``tenant_id``.

        Cancellation is a WRITE, so it is scoped exactly like the reads: another
        tenant's job is indistinguishable from a job that does not exist.
        """

        status_data = await self.redis.hgetall(f"{self.status_key_prefix}{job_id}")

        if not status_data:
            return False

        if not self._owned_by(status_data, tenant_id):
            logger.warning(
                "job_processor.cross_tenant_job_cancel_refused",
                job_id=job_id,
                requesting_tenant=tenant_id,
            )
            return False

        current_status = status_data.get("status")
        if current_status not in ["pending", "processing"]:
            return False

        # Update status to cancelled
        await self.redis.hset(
            f"{self.status_key_prefix}{job_id}",
            mapping={
                "status": "cancelled",
                "updated_at": datetime.now(UTC).isoformat(),
                "error": "Job cancelled by user",
            },
        )

        await self.redis.zrem(self.job_queue, job_id)
        await self.redis.zrem(self.processing_queue, job_id)
        logger.info("job_processor.job_cancelled", job_id=job_id)
        return True

    async def get_job_stats(self, tenant_id: str | None = None) -> dict[str, Any]:
        """Get job processing statistics for the calling tenant's own jobs.

        Counts are tenant-scoped too: a platform-wide total tells one tenant how much
        work every other tenant is submitting. (Same F-23 ``KEYS`` caveat as
        :meth:`list_jobs`.)
        """

        keys = await self.redis.keys(f"{self.status_key_prefix}*")

        stats = {
            "total_jobs": 0,
            "pending": 0,
            "processing": 0,
            "completed": 0,
            "failed": 0,
            "cancelled": 0,
        }

        for key in keys:
            status_data = await self.redis.hgetall(key)
            if not status_data or not self._owned_by(status_data, tenant_id):
                continue
            stats["total_jobs"] += 1
            status = status_data.get("status", "unknown")
            if status in stats:
                stats[status] += 1

        return stats

    async def start_processing(self) -> None:
        """Start the background job processing loop."""

        self.processing = True
        logger.info("job_processor.started", max_concurrent=self.max_concurrent)

        while self.processing:
            try:
                await self._requeue_stale_jobs()
                job_ids = await self._claim_pending_jobs()
                if not job_ids:
                    await asyncio.sleep(0.25)
                    continue

                tasks = [self._create_processing_task(job_id) for job_id in job_ids]
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)

            except Exception as e:
                logger.error("job_processor.error", error=str(e))
                await asyncio.sleep(1)  # Brief pause on error

    async def stop(self) -> None:
        """Stop the job processing loop."""

        self.processing = False
        if self._active_tasks:
            await asyncio.gather(*self._active_tasks, return_exceptions=True)
        logger.info("job_processor.stopped")

    async def _claim_pending_jobs(self) -> list[str]:
        """Claim a batch of pending jobs atomically from the priority queue."""

        claimed_job_ids: list[str] = []
        claimed_at_ms = int(time.time() * 1000)
        for _ in range(self.max_concurrent):
            popped = await self.redis.zpopmax(self.job_queue, count=1)
            if not popped:
                break

            job_id = popped[0][0]
            status_data = await self.redis.hgetall(f"{self.status_key_prefix}{job_id}")
            if not status_data:
                continue
            if status_data.get("status") != "pending":
                continue

            await self.redis.hset(
                f"{self.status_key_prefix}{job_id}",
                mapping={
                    "status": "processing",
                    "updated_at": datetime.now(UTC).isoformat(),
                    "claimed_at_ms": str(claimed_at_ms),
                    "claimed_by": self.worker_id,
                },
            )
            await self.redis.zadd(self.processing_queue, {job_id: claimed_at_ms})
            claimed_job_ids.append(job_id)

        return claimed_job_ids

    async def _requeue_stale_jobs(self) -> None:
        """Requeue jobs left in processing beyond the claim timeout."""

        cutoff_ms = int(time.time() * 1000) - self.claim_timeout_ms
        stale_jobs = await self.redis.zrangebyscore(self.processing_queue, 0, cutoff_ms)
        for job_id in stale_jobs:
            status_data = await self.redis.hgetall(f"{self.status_key_prefix}{job_id}")
            if not status_data:
                await self.redis.zrem(self.processing_queue, job_id)
                continue
            if status_data.get("status") != "processing":
                await self.redis.zrem(self.processing_queue, job_id)
                continue

            priority_score = int(status_data.get("priority_score", self.priority_map["normal"]))
            created_at_ms = int(status_data.get("created_at_ms", "0") or "0")
            await self.redis.hset(
                f"{self.status_key_prefix}{job_id}",
                mapping={
                    "status": "pending",
                    "updated_at": datetime.now(UTC).isoformat(),
                },
            )
            await self.redis.zadd(
                self.job_queue,
                {job_id: self._queue_score(priority_score, created_at_ms)},
            )
            await self.redis.zrem(self.processing_queue, job_id)

    def _queue_score(self, priority_score: int, created_at_ms: int) -> float:
        """Build a sortable queue score where higher priority and older jobs win."""

        return float(priority_score * 10000000000000 - created_at_ms)

    @asynccontextmanager
    async def _acquire_gliner(self, tenant_id: str | None = None) -> AsyncIterator[GlinerProvider]:
        """Yield the GLiNER provider for a job — DB-resolved + pinned when wired.

        Uses the injected pinned-context resolver in the running service (lazy,
        DB-selected, fail-closed) and falls back to a directly-injected provider
        for tests. ``tenant_id`` is the job's SUBMITTING tenant, so model selection
        resolves tenant-first exactly as the synchronous route does.
        """
        if self._gliner_provider_resolver is not None:
            async with self._gliner_provider_resolver(tenant_id) as provider:
                yield provider
        elif self.gliner_provider is not None:
            async with nullcontext(self.gliner_provider) as provider:
                yield provider
        else:  # pragma: no cover - construction guarantees one is set
            raise RuntimeError("JobProcessor has no GLiNER provider or resolver configured")

    def _create_processing_task(self, job_id: str) -> asyncio.Task[None]:
        """Create a task to process a job."""

        task = asyncio.create_task(self._process_job(job_id))
        self._active_tasks.add(task)
        task.add_done_callback(self._active_tasks.discard)
        return task

    async def _process_job(self, job_id: str) -> None:
        """Process a single guardrail analysis job."""

        try:
            async with self.semaphore:
                status_data = await self.redis.hgetall(f"{self.status_key_prefix}{job_id}")
                if not status_data:
                    await self.redis.zrem(self.processing_queue, job_id)
                    return

                if status_data.get("status") == "cancelled":
                    await self.redis.zrem(self.processing_queue, job_id)
                    logger.info("job_processor.job_skipped_cancelled", job_id=job_id)
                    return

                text = status_data.get("text", "")
                guardrail_type = status_data.get("guardrail_type", "comprehensive")
                tenant_id = status_data.get("tenant_id") or None

                logger.info("job_processor.job_started", job_id=job_id, tenant_id=tenant_id)

                start_time = time.monotonic()
                async with self._acquire_gliner(tenant_id) as gliner_provider:
                    result = await gliner_provider.analyze_content(
                        text=text,
                        guardrail_type=guardrail_type,
                    )
                processing_time = (time.monotonic() - start_time) * 1000

                result["processing_time_ms"] = processing_time
                result["timestamp"] = datetime.now(UTC).isoformat()

                latest_status = await self.redis.hgetall(f"{self.status_key_prefix}{job_id}")
                if latest_status.get("status") == "cancelled":
                    await self.redis.zrem(self.processing_queue, job_id)
                    logger.info("job_processor.job_cancelled_during_processing", job_id=job_id)
                    return

                await self.redis.hset(
                    f"{self.status_key_prefix}{job_id}",
                    mapping={
                        "status": "completed",
                        "result": json.dumps(result),
                        "updated_at": datetime.now(UTC).isoformat(),
                        "processing_time_ms": str(processing_time),
                    },
                )

                await self.redis.xadd(
                    self.result_stream,
                    {
                        "job_id": job_id,
                        "status": "completed",
                        "result": json.dumps(result),
                        "timestamp": datetime.now(UTC).isoformat(),
                    },
                )

                await self.redis.zrem(self.processing_queue, job_id)

                logger.info(
                    "job_processor.job_completed",
                    job_id=job_id,
                    safe=result.get("safe", False),
                    processing_time_ms=processing_time,
                )

        except Exception as e:
            # Update job status with error
            await self.redis.hset(
                f"{self.status_key_prefix}{job_id}",
                mapping={
                    "status": "failed",
                    "error": str(e),
                    "updated_at": datetime.now(UTC).isoformat(),
                },
            )

            # Add failure to result stream
            await self.redis.xadd(
                self.result_stream,
                {
                    "job_id": job_id,
                    "status": "failed",
                    "error": str(e),
                    "timestamp": datetime.now(UTC).isoformat(),
                },
            )

            # Remove from processing queue
            await self.redis.zrem(self.processing_queue, job_id)

            logger.error(
                "job_processor.job_failed",
                job_id=job_id,
                error=str(e),
            )
