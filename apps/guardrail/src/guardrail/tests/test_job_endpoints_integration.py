from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator

import fakeredis.aioredis
import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from guardrail.api.endpoints.guardrails import router as guardrails_router
from guardrail.api.endpoints.jobs import router as jobs_router
from guardrail.core.config import Settings
from guardrail.services.job_processor import JobProcessor

# `X-Tenant-Id` is mandatory on `/guardrail/analyze/async` (428 otherwise) and is
# stamped on the job so the deferred decision stays attributable.
TEST_TENANT = "11111111-1111-1111-1111-111111111111"


class RecordingProvider:
    """Stub GLiNER provider — the analyse job's only engine."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.delay_s = 0.0

    async def analyze_content(
        self, text: str, guardrail_type: str = "comprehensive"
    ) -> dict[str, object]:
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
        return None


@pytest_asyncio.fixture
async def integration_client() -> (
    AsyncGenerator[tuple[AsyncClient, FastAPI, RecordingProvider], None]
):
    settings = Settings(metrics_enabled=False)
    redis_client = fakeredis.aioredis.FakeRedis(decode_responses=True)
    provider = RecordingProvider()
    processor = JobProcessor(redis=redis_client, analyzer=provider, max_concurrent=2)  # type: ignore[arg-type]

    app = FastAPI()
    app.state.settings = settings
    app.state.redis = redis_client
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
        headers={"X-Tenant-Id": TEST_TENANT},
    )

    assert submit_response.status_code == 200
    submit_payload = submit_response.json()
    assert submit_payload["job_id"] == "integration-job-1"
    assert submit_payload["status"] == "submitted"

    status_payload = None
    for _ in range(20):
        status_response = await client.get(
            "/api/jobs/status/integration-job-1", headers={"X-Tenant-Id": TEST_TENANT}
        )
        assert status_response.status_code == 200
        status_payload = status_response.json()
        if status_payload["status"] == "completed":
            break
        await asyncio.sleep(0.05)

    assert status_payload is not None
    assert status_payload["status"] == "completed"
    assert provider.calls == [("integration text", "prompt_injection")]

    result_response = await client.get(
        "/api/jobs/result/integration-job-1", headers={"X-Tenant-Id": TEST_TENANT}
    )
    assert result_response.status_code == 200
    result_payload = result_response.json()
    assert result_payload["safe"] is True
    assert result_payload["guardrail_type"] == "prompt_injection"

    list_response = await client.get(
        "/api/jobs/list",
        params={"status": "completed"},
        headers={"X-Tenant-Id": TEST_TENANT},
    )
    assert list_response.status_code == 200
    jobs_payload = list_response.json()
    assert jobs_payload["total"] >= 1
    assert any(job["job_id"] == "integration-job-1" for job in jobs_payload["jobs"])

    stats_response = await client.get("/api/jobs/stats", headers={"X-Tenant-Id": TEST_TENANT})
    assert stats_response.status_code == 200
    stats_payload = stats_response.json()
    assert stats_payload["completed"] >= 1


@pytest.mark.asyncio
async def test_async_job_cancel_endpoint_prevents_completion(
    integration_client,
) -> None:
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
        headers={"X-Tenant-Id": TEST_TENANT},
    )
    assert submit_response.status_code == 200

    for _ in range(20):
        status_response = await client.get(
            "/api/jobs/status/integration-job-2", headers={"X-Tenant-Id": TEST_TENANT}
        )
        assert status_response.status_code == 200
        if status_response.json()["status"] in {"processing", "pending"}:
            break
        await asyncio.sleep(0.02)

    cancel_response = await client.delete(
        "/api/jobs/cancel/integration-job-2", headers={"X-Tenant-Id": TEST_TENANT}
    )
    assert cancel_response.status_code == 200
    assert cancel_response.json()["status"] == "cancelled"

    final_status = None
    for _ in range(20):
        status_response = await client.get(
            "/api/jobs/status/integration-job-2", headers={"X-Tenant-Id": TEST_TENANT}
        )
        assert status_response.status_code == 200
        final_status = status_response.json()
        if final_status["status"] == "cancelled":
            break
        await asyncio.sleep(0.02)

    assert final_status is not None
    assert final_status["status"] == "cancelled"

    result_response = await client.get(
        "/api/jobs/result/integration-job-2", headers={"X-Tenant-Id": TEST_TENANT}
    )
    assert result_response.status_code == 400


# ---------------------------------------------------------------------------
# Cross-tenant isolation on the READ side (404-over-403).
#
# Job ids are CALLER-supplied (`request_id`), so they are guessable — a job id alone
# must never be enough to read another tenant's guardrail verdict. Every jobs route
# requires `X-Tenant-Id` (428 when absent, matching the submit route) and compares it
# to the tenant stamped on the job at submit time. A mismatch is 404, never 403: the
# platform hides cross-tenant EXISTENCE (`00-project-context.md`, 404-over-403).
# ---------------------------------------------------------------------------

OTHER_TENANT = "22222222-2222-2222-2222-222222222222"
TENANTLESS = "tenantless:job-queue"


async def _submit(client: AsyncClient, job_id: str, tenant: str) -> None:
    response = await client.post(
        "/api/guardrail/analyze/async",
        json={
            "text": "scoped text",
            "guardrail_type": "comprehensive",
            "request_id": job_id,
            "priority": "normal",
        },
        headers={"X-Tenant-Id": tenant},
    )
    assert response.status_code == 200


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/jobs/status/scoped-job"),
        ("get", "/api/jobs/result/scoped-job"),
        ("delete", "/api/jobs/cancel/scoped-job"),
        ("get", "/api/jobs/list"),
        ("get", "/api/jobs/stats"),
    ],
)
@pytest.mark.asyncio
async def test_jobs_routes_require_tenant_header(integration_client, method, path) -> None:
    client, _app, _provider = integration_client

    response = await client.request(method, path)

    assert response.status_code == 428


@pytest.mark.asyncio
async def test_other_tenant_cannot_read_status_or_result(integration_client) -> None:
    client, _app, _provider = integration_client
    await _submit(client, "scoped-job", TEST_TENANT)

    for _ in range(20):
        owner_status = await client.get(
            "/api/jobs/status/scoped-job", headers={"X-Tenant-Id": TEST_TENANT}
        )
        assert owner_status.status_code == 200
        if owner_status.json()["status"] == "completed":
            break
        await asyncio.sleep(0.05)

    assert owner_status.json()["status"] == "completed"
    assert (
        await client.get("/api/jobs/result/scoped-job", headers={"X-Tenant-Id": TEST_TENANT})
    ).status_code == 200

    other = {"X-Tenant-Id": OTHER_TENANT}
    assert (await client.get("/api/jobs/status/scoped-job", headers=other)).status_code == 404
    assert (await client.get("/api/jobs/result/scoped-job", headers=other)).status_code == 404


@pytest.mark.asyncio
async def test_other_tenant_cannot_cancel(integration_client) -> None:
    client, _app, provider = integration_client
    provider.delay_s = 0.2
    await _submit(client, "scoped-cancel", TEST_TENANT)

    other = await client.delete(
        "/api/jobs/cancel/scoped-cancel", headers={"X-Tenant-Id": OTHER_TENANT}
    )
    assert other.status_code == 404

    owner_status = await client.get(
        "/api/jobs/status/scoped-cancel", headers={"X-Tenant-Id": TEST_TENANT}
    )
    assert owner_status.json()["status"] in {"pending", "processing", "completed"}

    owner = await client.delete(
        "/api/jobs/cancel/scoped-cancel", headers={"X-Tenant-Id": TEST_TENANT}
    )
    assert owner.status_code == 200


@pytest.mark.asyncio
async def test_list_and_stats_are_tenant_scoped(integration_client) -> None:
    client, _app, _provider = integration_client
    await _submit(client, "mine-1", TEST_TENANT)
    await _submit(client, "theirs-1", OTHER_TENANT)

    mine = await client.get("/api/jobs/list", headers={"X-Tenant-Id": TEST_TENANT})
    assert mine.status_code == 200
    ids = {job["job_id"] for job in mine.json()["jobs"]}
    assert ids == {"mine-1"}
    assert mine.json()["total"] == 1

    theirs = await client.get("/api/jobs/list", headers={"X-Tenant-Id": OTHER_TENANT})
    assert {job["job_id"] for job in theirs.json()["jobs"]} == {"theirs-1"}

    stats = await client.get("/api/jobs/stats", headers={"X-Tenant-Id": TEST_TENANT})
    assert stats.status_code == 200
    assert stats.json()["total_jobs"] == 1


@pytest.mark.asyncio
async def test_declared_tenantless_marker_scopes_like_any_other_owner(
    integration_client,
) -> None:
    """`tenantless:<reason>` is accepted, but it is NOT a skeleton key.

    A declared marker owns its own jobs and sees only them — the marker exists so
    genuinely tenant-less internal work declares itself, not so it can read everyone.
    """
    client, _app, _provider = integration_client
    await _submit(client, "queue-job", TENANTLESS)
    await _submit(client, "tenant-job", TEST_TENANT)

    marker = {"X-Tenant-Id": TENANTLESS}
    assert (await client.get("/api/jobs/status/queue-job", headers=marker)).status_code == 200
    assert (await client.get("/api/jobs/status/tenant-job", headers=marker)).status_code == 404
    assert {
        job["job_id"] for job in (await client.get("/api/jobs/list", headers=marker)).json()["jobs"]
    } == {"queue-job"}
