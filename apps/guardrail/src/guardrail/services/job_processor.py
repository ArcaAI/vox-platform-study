"""Job processor for async guardrail analysis using Redis streams."""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from typing import Any

import redis.asyncio as aioredis

from guardrail.core.logging import get_logger
from guardrail.providers.ollama import OllamaProvider

logger = get_logger(__name__)


class JobProcessor:
    """Processes guardrail analysis jobs using Redis streams."""
    
    def __init__(
        self,
        redis: aioredis.Redis,
        ollama_provider: OllamaProvider,
        max_concurrent: int = 4,
    ) -> None:
        self.redis = redis
        self.ollama_provider = ollama_provider
        self.max_concurrent = max_concurrent
        self.processing = False
        self.semaphore = asyncio.Semaphore(max_concurrent)
        
        # Redis stream names
        self.job_stream = "guardrail:jobs"
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
        
        job_data = {
            "job_id": job_id,
            "text": text,
            "guardrail_type": guardrail_type,
            "request_id": request_id,
            "priority": priority,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "status": "pending",
        }
        
        # Store job status
        await self.redis.hset(
            f"{self.status_key_prefix}{job_id}",
            mapping=job_data,
        )
        
        # Add to job stream with priority
        priority_score = self.priority_map.get(priority, 5)
        await self.redis.xadd(
            self.job_stream,
            job_data,
            maxlen=10000,
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
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "error": "Job cancelled by user",
            },
        )
        
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
                # Read jobs from stream
                messages = await self.redis.xread(
                    {self.job_stream: "$"},
                    block=1000,  # 1 second timeout
                    count=1,
                )
                
                if not messages:
                    continue
                
                for stream, msgs in messages:
                    for msg_id, fields in msgs:
                        async with self.semaphore:
                            await self._process_job(msg_id, fields)
                            
            except Exception as e:
                logger.error("job_processor.error", error=str(e))
                await asyncio.sleep(1)  # Brief pause on error
    
    async def stop(self) -> None:
        """Stop the job processing loop."""
        
        self.processing = False
        logger.info("job_processor.stopped")
    
    async def _process_job(self, msg_id: str, job_data: dict[str, str]) -> None:
        """Process a single guardrail analysis job."""
        
        job_id = job_data.get("job_id")
        text = job_data.get("text", "")
        guardrail_type = job_data.get("guardrail_type", "comprehensive")
        
        try:
            # Update status to processing
            await self.redis.hset(
                f"{self.status_key_prefix}{job_id}",
                mapping={
                    "status": "processing",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                },
            )
            
            logger.info("job_processor.job_started", job_id=job_id)
            
            # Perform guardrail analysis
            start_time = time.monotonic()
            result = await self.ollama_provider.analyze_content(
                text=text,
                guardrail_type=guardrail_type,
            )
            processing_time = (time.monotonic() - start_time) * 1000
            
            # Add processing time to result
            result["processing_time_ms"] = processing_time
            result["timestamp"] = datetime.now(timezone.utc).isoformat()
            
            # Update job status with result
            await self.redis.hset(
                f"{self.status_key_prefix}{job_id}",
                mapping={
                    "status": "completed",
                    "result": json.dumps(result),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                    "processing_time_ms": str(processing_time),
                },
            )
            
            # Add to result stream
            await self.redis.xadd(
                self.result_stream,
                {
                    "job_id": job_id,
                    "status": "completed",
                    "result": json.dumps(result),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
            )
            
            # Remove from job stream
            await self.redis.xdel(self.job_stream, msg_id)
            
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
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                },
            )
            
            # Add failure to result stream
            await self.redis.xadd(
                self.result_stream,
                {
                    "job_id": job_id,
                    "status": "failed",
                    "error": str(e),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
            )
            
            # Remove from job stream
            await self.redis.xdel(self.job_stream, msg_id)
            
            logger.error(
                "job_processor.job_failed",
                job_id=job_id,
                error=str(e),
            )
