"""Job processor for async guardrail analysis using Redis-backed priority queues."""

from __future__ import annotations

import asyncio
import json
import time
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import redis.asyncio as aioredis

from guardrail.core.logging import get_logger
from guardrail.providers.gliner import GlinerProvider

logger = get_logger(__name__)


class JobProcessor:
    """Processes guardrail analysis jobs using Redis-backed priority queues."""

    def __init__(
        self,
        redis: aioredis.Redis,
        gliner_provider: GlinerProvider,
        max_concurrent: int = 4,
    ) -> None:
        self.redis = redis
        self.gliner_provider = gliner_provider
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
    ) -> str:
        """Submit a new guardrail analysis job."""

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
        )

        return job_id

    async def get_job_status(self, job_id: str) -> dict[str, Any] | None:
        """Get the status of a specific job."""

        status_data = await self.redis.hgetall(f"{self.status_key_prefix}{job_id}")

        if not status_data:
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
    ) -> dict[str, Any]:
        """List jobs with optional status filtering."""

        # Get all job status keys
        keys = await self.redis.keys(f"{self.status_key_prefix}*")
        keys.sort()

        jobs = []
        for key in keys[offset:offset + limit]:
            job_data = await self.redis.hgetall(key)
            if job_data:
                if status is None or job_data.get("status") == status:
                    # Parse result if present
                    if "result" in job_data and job_data["result"]:
                        try:
                            job_data["result"] = json.loads(job_data["result"])
                        except json.JSONDecodeError:
                            pass
                    jobs.append(job_data)

        return {
            "jobs": jobs,
            "total": len(keys),
            "limit": limit,
            "offset": offset,
        }

    async def cancel_job(self, job_id: str) -> bool:
        """Cancel a pending or processing job."""

        status_data = await self.redis.hgetall(f"{self.status_key_prefix}{job_id}")

        if not status_data:
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

    async def get_job_stats(self) -> dict[str, Any]:
        """Get job processing statistics."""

        keys = await self.redis.keys(f"{self.status_key_prefix}*")

        stats = {
            "total_jobs": len(keys),
            "pending": 0,
            "processing": 0,
            "completed": 0,
            "failed": 0,
            "cancelled": 0,
        }

        for key in keys:
            status_data = await self.redis.hgetall(key)
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

                logger.info("job_processor.job_started", job_id=job_id)

                start_time = time.monotonic()
                result = await self.gliner_provider.analyze_content(
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
                    safe=result.get("safe", True),
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
