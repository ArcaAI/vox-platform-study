"""TDD tests for ServiceAuthMiddleware.

A non-exempt path is used to exercise auth; that route does not
exist, so a request that PASSES auth reaches routing and 404s. Auth
therefore asserts on ``401`` vs. ``!= 401`` rather than a 200 body.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from tts.core.config import Settings
from tts.main import create_app

NONEXEMPT = "/api/v1/audio/speech"  # future synthesis route; non-exempt


def _make_app(*, service_token: str = ""):
    settings = Settings(
        host="127.0.0.1", port=5099, debug=True, internal_access_token=service_token
    )
    return create_app(settings_override=settings)


class TestAuthDisabled:
    """Empty service_token = auth bypassed."""

    @pytest_asyncio.fixture
    async def client(self):
        transport = ASGITransport(app=_make_app(service_token=""))
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_bypass_when_token_empty(self, client):
        resp = await client.get(NONEXEMPT)
        assert resp.status_code != 401


class TestAuthEnabled:
    """A set service_token is required on non-exempt endpoints."""

    TOKEN = "test-secret-token-abc123"

    @pytest_asyncio.fixture
    async def client(self):
        transport = ASGITransport(app=_make_app(service_token=self.TOKEN))
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_rejects_missing_token(self, client):
        resp = await client.get(NONEXEMPT)
        assert resp.status_code == 401
        assert resp.json() == {"detail": "Invalid or missing service token"}

    @pytest.mark.asyncio
    async def test_rejects_wrong_token(self, client):
        resp = await client.get(NONEXEMPT, headers={"X-Service-Token": "wrong"})
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_accepts_correct_token(self, client):
        resp = await client.get(NONEXEMPT, headers={"X-Service-Token": self.TOKEN})
        assert resp.status_code != 401  # passes auth (route not built yet → 404)


class TestExemptPaths:
    """Exempt paths work without a token even when auth is enabled."""

    TOKEN = "test-secret-token-abc123"

    @pytest_asyncio.fixture
    async def client(self):
        transport = ASGITransport(app=_make_app(service_token=self.TOKEN))
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_health_exempt(self, client):
        assert (await client.get("/api/v1/health")).status_code == 200

    @pytest.mark.asyncio
    async def test_metrics_in_exempt_set(self, client):
        from tts.api.middleware.auth import EXEMPT_PATHS

        assert "/metrics" in EXEMPT_PATHS

    @pytest.mark.asyncio
    async def test_docs_exempt(self, client):
        assert (await client.get("/api/v1/docs")).status_code == 200
