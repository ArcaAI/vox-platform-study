"""Tests for CORS configuration and middleware behavior.

Phase 1, Task 1.3: CORS should be disabled by default for this internal service.
The API gateway communicates via server-to-server HTTP — CORS is irrelevant.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.middleware.cors import CORSMiddleware

from smr_v2.core.config import Settings
from smr_v2.main import create_app


class TestCorsDefaults:
    """Settings defaults for CORS fields."""

    def test_default_cors_origins_is_empty(self):
        s = Settings()
        assert s.cors_origins == []

    def test_default_cors_disabled(self):
        s = Settings()
        assert s.cors_enabled is False


class TestCorsMiddlewareStack:
    """CORSMiddleware presence in the app middleware stack."""

    @staticmethod
    def _has_cors_middleware(app) -> bool:
        """Check FastAPI's user_middleware list for CORSMiddleware."""
        return any(m.cls is CORSMiddleware for m in app.user_middleware)

    def test_cors_middleware_not_added_when_disabled(self):
        settings = Settings(cors_enabled=False, cors_origins=["http://localhost:8868/api/v1"])
        app = create_app(settings_override=settings)
        assert not self._has_cors_middleware(app)

    def test_cors_middleware_added_when_enabled(self):
        settings = Settings(cors_enabled=True, cors_origins=["http://localhost:8868/api/v1"])
        app = create_app(settings_override=settings)
        assert self._has_cors_middleware(app)


class TestCorsPreflight:
    """End-to-end CORS preflight (OPTIONS) behavior."""

    @pytest.mark.anyio
    async def test_cors_preflight_rejected_when_disabled(self):
        settings = Settings(cors_enabled=False)
        app = create_app(settings_override=settings)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.options(
                "/api/v1/health",
                headers={
                    "Origin": "http://localhost:8868/api/v1",
                    "Access-Control-Request-Method": "POST",
                },
            )
        assert "access-control-allow-origin" not in response.headers

    @pytest.mark.anyio
    async def test_cors_preflight_works_when_enabled(self):
        settings = Settings(
            cors_enabled=True,
            cors_origins=["http://localhost:8868/api/v1"],
        )
        app = create_app(settings_override=settings)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.options(
                "/api/v1/health",
                headers={
                    "Origin": "http://localhost:8868/api/v1",
                    "Access-Control-Request-Method": "POST",
                },
            )
        assert response.headers.get("access-control-allow-origin") == "http://localhost:8868/api/v1"
