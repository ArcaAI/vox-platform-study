"""TASK-616 G0.0 — `/health/ready` must fail closed on a Redis outage.

Verified defect (TASK-627 finding, re-confirmed while implementing TASK-616
Wave-0 task 0.0): `readiness_check` in `guardrail/api/endpoints/health.py`
always returns HTTP 200 — including when Redis is unreachable — because it
catches the exception and reports `{"ready": False}` in the body instead of
raising. The k8s readiness probe only looks at the status code, so the pod is
never pulled from Service endpoints even when its one hard dependency is down.

RED: written before the fix. Mirrors the SMR/NLP/TTS health contract, whose
`/health/ready` already returns 503 on the equivalent failure
(`apps/smr/src/smr/api/endpoints/health.py`, `test_health_metrics.py`).
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from guardrail.api.endpoints.health import router as health_router


def _make_app(*, redis_ok: bool) -> FastAPI:
    app = FastAPI()
    redis_client = AsyncMock()
    if redis_ok:
        redis_client.ping = AsyncMock(return_value=True)
    else:
        redis_client.ping = AsyncMock(side_effect=ConnectionError("redis unreachable"))
    app.state.redis = redis_client
    app.include_router(health_router, prefix="/api")
    return app


@pytest_asyncio.fixture
async def healthy_client():
    app = _make_app(redis_ok=True)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


@pytest_asyncio.fixture
async def redis_down_client():
    app = _make_app(redis_ok=False)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


class TestGuardrailReadiness:
    @pytest.mark.asyncio
    async def test_ready_returns_200_when_redis_healthy(self, healthy_client: AsyncClient) -> None:
        resp = await healthy_client.get("/api/health/ready")
        assert resp.status_code == 200
        assert resp.json()["ready"] is True

    @pytest.mark.asyncio
    async def test_ready_returns_503_when_redis_down(self, redis_down_client: AsyncClient) -> None:
        """The k8s probe only reads the status code — a 200 body with
        `ready: false` never removes the pod from Service endpoints."""
        resp = await redis_down_client.get("/api/health/ready")
        assert resp.status_code == 503
        assert resp.json()["ready"] is False

    @pytest.mark.asyncio
    async def test_live_always_returns_200(self, redis_down_client: AsyncClient) -> None:
        """Liveness is a pure process check — must stay 200 even when Redis is down."""
        resp = await redis_down_client.get("/api/health/live")
        assert resp.status_code == 200
