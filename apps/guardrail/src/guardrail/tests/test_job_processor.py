from __future__ import annotations

import asyncio
import time

import fakeredis.aioredis
import pytest

from guardrail.services.job_processor import JobProcessor


class RecordingProvider:
    """Stands in for the GLiNER provider the job processor analyses with.

    A plain stub since TASK-735 Phase 2b: it used to subclass the (now deleted)
    OpenAI-compat provider, which only ever supplied a constructor — the job
    processor has always talked to GLiNER, never to an LLM engine.
    """

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.delay_s = 0.0

    async def analyze_content(
        self, text: str, guardrail_type: str = "comprehensive"
    ) -> dict[str, object]:
        self.calls.append(text)
        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        return {
            "safe": True,
            "issues": [],
            "confidence": 1.0,
            "guardrail_type": guardrail_type,
        }

    async def aclose(self) -> None:
        return None


@pytest.fixture
async def redis_client():
    client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    try:
        yield client
    finally:
        await client.aclose()


@pytest.fixture
async def provider():
    stub = RecordingProvider()
    try:
        yield stub
    finally:
        await stub.aclose()


@pytest.fixture
async def processor(redis_client, provider):
    return JobProcessor(redis=redis_client, gliner_provider=provider, max_concurrent=2)


@pytest.mark.asyncio
async def test_claim_pending_jobs_prioritizes_high_priority(processor: JobProcessor) -> None:
    low_job_id = await processor.submit_job("low-text", priority="low", request_id="job-low")
    await asyncio.sleep(0.001)
    high_job_id = await processor.submit_job("high-text", priority="high", request_id="job-high")

    claimed = await processor._claim_pending_jobs()

    assert claimed == [high_job_id, low_job_id]


@pytest.mark.asyncio
async def test_cancel_job_removes_pending_job_from_queues(
    processor: JobProcessor, redis_client
) -> None:
    job_id = await processor.submit_job("cancel-me", request_id="job-cancel")

    cancelled = await processor.cancel_job(job_id)
    status = await processor.get_job_status(job_id)
    pending_members = await redis_client.zrange(processor.job_queue, 0, -1)
    processing_members = await redis_client.zrange(processor.processing_queue, 0, -1)

    assert cancelled is True
    assert status is not None
    assert status["status"] == "cancelled"
    assert job_id not in pending_members
    assert job_id not in processing_members


@pytest.mark.asyncio
async def test_requeue_stale_jobs_returns_processing_job_to_pending(
    processor: JobProcessor, redis_client
) -> None:
    job_id = await processor.submit_job("stale-job", request_id="job-stale")
    claimed = await processor._claim_pending_jobs()
    assert claimed == [job_id]

    stale_score = int(time.time() * 1000) - processor.claim_timeout_ms - 1
    await redis_client.zadd(processor.processing_queue, {job_id: stale_score})
    await redis_client.hset(
        f"{processor.status_key_prefix}{job_id}",
        mapping={"status": "processing", "claimed_at_ms": str(stale_score)},
    )

    await processor._requeue_stale_jobs()

    status = await processor.get_job_status(job_id)
    pending_members = await redis_client.zrange(processor.job_queue, 0, -1)
    processing_members = await redis_client.zrange(processor.processing_queue, 0, -1)

    assert status is not None
    assert status["status"] == "pending"
    assert job_id in pending_members
    assert job_id not in processing_members


@pytest.mark.asyncio
async def test_process_job_completes_and_persists_result(
    processor: JobProcessor, redis_client, provider: RecordingProvider
) -> None:
    job_id = await processor.submit_job("process-me", request_id="job-process", priority="high")
    claimed = await processor._claim_pending_jobs()

    assert claimed == [job_id]

    await processor._process_job(job_id)

    status = await processor.get_job_status(job_id)
    result_events = await redis_client.xrange(processor.result_stream)
    processing_members = await redis_client.zrange(processor.processing_queue, 0, -1)

    assert provider.calls == ["process-me"]
    assert status is not None
    assert status["status"] == "completed"
    assert status["result"]["safe"] is True
    assert processing_members == []
    assert len(result_events) == 1
    assert result_events[0][1]["job_id"] == job_id


@pytest.mark.asyncio
async def test_cancelled_job_is_not_processed(
    processor: JobProcessor, provider: RecordingProvider, redis_client
) -> None:
    job_id = await processor.submit_job("do-not-run", request_id="job-skip")
    claimed = await processor._claim_pending_jobs()
    assert claimed == [job_id]

    await processor.cancel_job(job_id)
    await processor._process_job(job_id)

    status = await processor.get_job_status(job_id)
    processing_members = await redis_client.zrange(processor.processing_queue, 0, -1)

    assert provider.calls == []
    assert status is not None
    assert status["status"] == "cancelled"
    assert processing_members == []
