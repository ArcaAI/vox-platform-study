"""Text mounts no CORS middleware, and there is no env var that can add one.

The original intent of this file was already "CORS should be disabled by default
for this internal service — the API gateway communicates via server-to-server
HTTP, so CORS is irrelevant". TASK-799 lane B made that structural rather than a
default: ``TEXT_CORS_ENABLED`` / ``TEXT_CORS_ORIGINS`` are gone, so the origin
policy of a PHI service can no longer be widened from an env file. Browser-facing
origin policy belongs to the gateway, which is the only thing a browser talks to
(`.claude/rules/06-python-services.md` §"Gateway Integration & Auth").

The tests below therefore assert ABSENCE — of the middleware, and of any way to
put it back — rather than a default value.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.middleware.cors import CORSMiddleware

from text.core.config import Settings
from text.main import create_app


class TestNoCorsSurface:
    def test_no_cors_settings_exist(self):
        assert "cors_origins" not in Settings.model_fields
        assert "cors_enabled" not in Settings.model_fields

    def test_cors_env_vars_are_inert(self, monkeypatch):
        """Setting the retired names must not resurrect the knob — pydantic-settings
        would silently accept an unknown env var, so the proof is that nothing on
        the constructed settings holds it."""
        monkeypatch.setenv("TEXT_CORS_ENABLED", "true")
        monkeypatch.setenv("TEXT_CORS_ORIGINS", '["https://evil.example"]')
        settings = Settings()
        assert not hasattr(settings, "cors_enabled")
        assert not hasattr(settings, "cors_origins")


class TestCorsMiddlewareIsNeverMounted:
    def test_middleware_stack_has_no_cors(self):
        app = create_app()
        assert not any(m.cls is CORSMiddleware for m in app.user_middleware)

    def test_middleware_stack_has_no_cors_even_with_the_retired_env_vars(self, monkeypatch):
        monkeypatch.setenv("TEXT_CORS_ENABLED", "true")
        monkeypatch.setenv("TEXT_CORS_ORIGINS", '["https://evil.example"]')
        app = create_app()
        assert not any(m.cls is CORSMiddleware for m in app.user_middleware)

    @pytest.mark.asyncio
    async def test_no_access_control_allow_origin_header_is_returned(self):
        """The observable half: a cross-origin request gets no CORS grant back."""
        app = create_app()
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                "/api/v1/health/live", headers={"Origin": "https://evil.example"}
            )
        assert "access-control-allow-origin" not in {k.lower() for k in response.headers}
