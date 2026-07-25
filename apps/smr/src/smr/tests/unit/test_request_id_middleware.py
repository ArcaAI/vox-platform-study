"""TDD tests for RequestIDMiddleware.

Tests verify that the middleware:
- Propagates X-Request-ID from incoming headers
- Generates a UUID4 when header is missing
- Binds request_id to structlog contextvars during request
- Clears structlog contextvars after request completes

RED: Written before implementation.
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
import structlog.contextvars
from httpx import ASGITransport, AsyncClient

from smr.core.config import Settings
from smr.main import create_app


@pytest.fixture
def settings():
    return Settings(host="127.0.0.1", port=5099, debug=True, log_level="debug")


@pytest.fixture
def mock_provider_registry():
    from smr.providers.base import ProviderRegistry

    registry = ProviderRegistry()
    mock_provider = AsyncMock()
    mock_provider.health_check = AsyncMock(return_value=True)
    mock_provider.get_info = AsyncMock()
    registry.register("ollama", mock_provider)
    return registry


@pytest.fixture
def mock_task_manager():
    return AsyncMock()


@pytest_asyncio.fixture
async def app(settings, mock_provider_registry, mock_task_manager):
    application = create_app(settings_override=settings)
    application.state.provider_registry = mock_provider_registry
    application.state.task_manager = mock_task_manager
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class TestRequestIDMiddleware:
    """Request-ID middleware must propagate, generate, bind, and clear."""

    @pytest.mark.asyncio
    async def test_request_id_propagated_from_header(self, client):
        """When X-Request-ID is sent, the same value appears in the response."""
        resp = await client.get(
            "/api/v1/health", headers={"X-Request-ID": "abc-123"}
        )
        assert resp.status_code == 200
        assert resp.headers["x-request-id"] == "abc-123"

    @pytest.mark.asyncio
    async def test_request_id_generated_when_missing(self, client):
        """When no X-Request-ID header is sent, the response contains one."""
        resp = await client.get("/api/v1/health")
        assert resp.status_code == 200
        assert "x-request-id" in resp.headers
        assert len(resp.headers["x-request-id"]) > 0

    @pytest.mark.asyncio
    async def test_request_id_is_valid_uuid_when_generated(self, client):
        """The auto-generated request ID must be a valid UUID4."""
        resp = await client.get("/api/v1/health")
        generated_id = resp.headers["x-request-id"]
        parsed = uuid.UUID(generated_id, version=4)
        assert str(parsed) == generated_id

    @pytest.mark.asyncio
    async def test_request_id_bound_to_structlog(self, app):
        """During request processing, structlog contextvars contains request_id."""
        captured_ctx: dict = {}

        @app.get("/api/v1/_test_ctx")
        async def _test_ctx_endpoint():
            captured_ctx.update(structlog.contextvars.get_contextvars())
            return {"ok": True}

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get(
                "/api/v1/_test_ctx", headers={"X-Request-ID": "ctx-test-id"}
            )

        assert resp.status_code == 200
        assert captured_ctx.get("request_id") == "ctx-test-id"

    @pytest.mark.asyncio
    async def test_request_id_cleared_after_request(self, app):
        """After the request completes, structlog contextvars must be empty."""
        structlog.contextvars.clear_contextvars()

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await c.get(
                "/api/v1/health", headers={"X-Request-ID": "should-be-cleared"}
            )

        ctx_after = structlog.contextvars.get_contextvars()
        assert "request_id" not in ctx_after
