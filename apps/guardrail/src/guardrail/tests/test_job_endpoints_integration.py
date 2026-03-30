from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator

import fakeredis.aioredis
import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from guardrail.api.endpoints.guardrails import router as guardrails_router
from guardrail.api.endpoints.jobs import router as jobs_router
from guardrail.core.config import Settings
from guardrail.providers.ollama import OllamaProvider
from guardrail.services.job_processor import JobProcessor


class RecordingProvider(OllamaProvider):
    def __init__(self) -> None:
        super().__init__(settings=Settings().ollama, http_client=httpx.AsyncClient())
        self.calls: list[tuple[str, str]] = []
        self.delay_s = 0.0

    async def analyze_content(self, text: str, guardrail_type: str = "comprehensive") -> dict[str, object]:
        self.calls.append((text, guardrail_type))
        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        return {
            "safe": True,
            "issues": [],
            "confidence": 0.99,
            "guardrail_type": guardrail_type,
        }

    async def aclose(self) -> None:
        await self.http_client.aclose()


@pytest_asyncio.fixture
async def integration_client() -> AsyncGenerator[tuple[AsyncClient, FastAPI, RecordingProvider], None]:
    settings = Settings(metrics_enabled=False)
    redis_client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    provider = RecordingProvider()
    processor = JobProcessor(redis=redis_client, ollama_provider=provider, max_concurrent=2)

    app = FastAPI()
    app.state.settings = settings
    app.state.redis = redis_client
    app.state.ollama_provider = provider
    app.state.job_processor = processor
    app.include_router(guardrails_router, prefix="/api", tags=["guardrails"])
    app.include_router(jobs_router, prefix="/api", tags=["jobs"])

    worker_task = asyncio.create_task(processor.start_processing())

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        try:
            yield client, app, provider
        finally:
            await processor.stop()
            await worker_task
            await provider.aclose()
            await redis_client.aclose()


@pytest.mark.asyncio
async def test_async_job_lifecycle_end_to_end(integration_client) -> None:
    client, app, provider = integration_client

    submit_response = await client.post(
        "/api/guardrail/analyze/async",
        json={
            "text": "integration text",
            "guardrail_type": "prompt_injection",
            "request_id": "integration-job-1",
            "priority": "high",
        },
    )

    assert submit_response.status_code == 200
    submit_payload = submit_response.json()
    assert submit_payload["job_id"] == "integration-job-1"
    assert submit_payload["status"] == "submitted"

    status_payload = None
    for _ in range(20):
        status_response = await client.get("/api/jobs/status/integration-job-1")
        assert status_response.status_code == 200
        status_payload = status_response.json()
        if status_payload["status"] == "completed":
            break
        await asyncio.sleep(0.05)

    assert status_payload is not None
    assert status_payload["status"] == "completed"
    assert provider.calls == [("integration text", "prompt_injection")]

    result_response = await client.get("/api/jobs/result/integration-job-1")
    assert result_response.status_code == 200
    result_payload = result_response.json()
    assert result_payload["safe"] is True
    assert result_payload["guardrail_type"] == "prompt_injection"

    list_response = await client.get("/api/jobs/list", params={"status": "completed"})
    assert list_response.status_code == 200
    jobs_payload = list_response.json()
    assert jobs_payload["total"] >= 1
    assert any(job["job_id"] == "integration-job-1" for job in jobs_payload["jobs"])

    stats_response = await client.get("/api/jobs/stats")
    assert stats_response.status_code == 200
    stats_payload = stats_response.json()
    assert stats_payload["completed"] >= 1


@pytest.mark.asyncio
async def test_async_job_cancel_endpoint_prevents_completion(integration_client) -> None:
    client, app, provider = integration_client
    provider.delay_s = 0.2

    submit_response = await client.post(
        "/api/guardrail/analyze/async",
        json={
            "text": "cancel integration text",
            "guardrail_type": "comprehensive",
            "request_id": "integration-job-2",
            "priority": "normal",
        },
    )
    assert submit_response.status_code == 200

    for _ in range(20):
        status_response = await client.get("/api/jobs/status/integration-job-2")
        assert status_response.status_code == 200
        if status_response.json()["status"] in {"processing", "pending"}:
            break
        await asyncio.sleep(0.02)

    cancel_response = await client.delete("/api/jobs/cancel/integration-job-2")
    assert cancel_response.status_code == 200
    assert cancel_response.json()["status"] == "cancelled"

    final_status = None
    for _ in range(20):
        status_response = await client.get("/api/jobs/status/integration-job-2")
        assert status_response.status_code == 200
        final_status = status_response.json()
        if final_status["status"] == "cancelled":
            break
        await asyncio.sleep(0.02)

    assert final_status is not None
    assert final_status["status"] == "cancelled"

    result_response = await client.get("/api/jobs/result/integration-job-2")
    assert result_response.status_code == 400
