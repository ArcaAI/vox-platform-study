"""TDD tests for ServiceAuthMiddleware.

Tests verify inter-service authentication via X-Service-Token header.
RED: Written before implementation.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.core.config import Settings
from text.main import create_app
from text.models.provider import ModelInfo, ProviderInfo


@pytest.fixture
def _mock_provider_registry():
    from text.providers.base import ProviderRegistry

    registry = ProviderRegistry()
    mock_provider = AsyncMock()
    mock_provider.health_check = AsyncMock(return_value=True)
    mock_provider.get_info = AsyncMock(
        return_value=ProviderInfo(
            name="ollama",
            display_name="Ollama",
            status="available",
            default_model="llama3.2:latest",
            models=[ModelInfo(name="llama3.2:latest")],
            supports_streaming=True,
        )
    )
    registry.register("ollama", mock_provider)
    return registry


@pytest.fixture
def _mock_task_manager():
    return AsyncMock()


def _make_app(
    *,
    service_token: str = "",
    provider_registry=None,
    task_manager=None,
):
    """Helper to build a test app with a given service_token."""
    settings = Settings(
        host="127.0.0.1",
        port=5099,
        debug=True,
        log_level="debug",
        service_token=service_token,
    )
    application = create_app(settings_override=settings)
    if provider_registry is not None:
        application.state.provider_registry = provider_registry
    if task_manager is not None:
        application.state.task_manager = task_manager
    return application


# ── Auth disabled (dev mode) ──


class TestAuthDisabled:
    """When service_token is empty, auth is completely bypassed."""

    @pytest_asyncio.fixture
    async def client(self, _mock_provider_registry, _mock_task_manager):
        app = _make_app(
            service_token="",
            provider_registry=_mock_provider_registry,
            task_manager=_mock_task_manager,
        )
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_auth_disabled_when_token_empty(self, client):
        """Requests without header succeed when service_token is empty."""
        resp = await client.get("/api/v1/health")
        assert resp.status_code == 200


# ── Auth enabled ──


class TestAuthEnabled:
    """When service_token is set, all non-exempt endpoints require it."""

    SERVICE_TOKEN = "test-secret-token-abc123"

    @pytest_asyncio.fixture
    async def app(self, _mock_provider_registry, _mock_task_manager):
        return _make_app(
            service_token=self.SERVICE_TOKEN,
            provider_registry=_mock_provider_registry,
            task_manager=_mock_task_manager,
        )

    @pytest_asyncio.fixture
    async def client(self, app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_auth_rejects_missing_token(self, client):
        """Request without X-Service-Token header gets 401."""
        resp = await client.get("/api/v1/providers")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_auth_rejects_wrong_token(self, client):
        """Request with incorrect token gets 401."""
        resp = await client.get(
            "/api/v1/providers",
            headers={"X-Service-Token": "wrong-token"},
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_auth_accepts_correct_token(self, client):
        """Request with correct token succeeds."""
        resp = await client.get(
            "/api/v1/providers",
            headers={"X-Service-Token": self.SERVICE_TOKEN},
        )
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_auth_response_body(self, client):
        """401 response contains the expected JSON detail."""
        resp = await client.get("/api/v1/providers")
        assert resp.status_code == 401
        body = resp.json()
        assert body == {"detail": "Invalid or missing service token"}


# ── Exempt paths ──


class TestAuthExemptPaths:
    """Certain paths must be accessible without a token even when auth is on."""

    SERVICE_TOKEN = "test-secret-token-abc123"

    @pytest_asyncio.fixture
    async def app(self, _mock_provider_registry, _mock_task_manager):
        return _make_app(
            service_token=self.SERVICE_TOKEN,
            provider_registry=_mock_provider_registry,
            task_manager=_mock_task_manager,
        )

    @pytest_asyncio.fixture
    async def client(self, app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_auth_exempts_health_endpoint(self, client):
        """Health endpoint works without token (k8s probes)."""
        resp = await client.get("/api/v1/health")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_auth_exempts_metrics_endpoint(self, client):
        """Metrics endpoint is in the EXEMPT_PATHS set."""
        from text.api.middleware.auth import EXEMPT_PATHS

        assert "/metrics" in EXEMPT_PATHS

    @pytest.mark.asyncio
    async def test_auth_exempts_docs_endpoint(self, client):
        """OpenAPI docs endpoint works without token."""
        resp = await client.get("/api/v1/docs")
        # FastAPI docs returns 200 HTML
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_auth_exempts_redoc_endpoint(self, client):
        """ReDoc endpoint works without token."""
        resp = await client.get("/api/v1/redoc")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_auth_exempts_openapi_json_endpoint(self, client):
        """OpenAPI JSON schema endpoint works without token."""
        resp = await client.get("/api/v1/openapi.json")
        assert resp.status_code == 200
