"""TDD tests for the Guardrail ServiceAuthMiddleware.

Verifies inter-service authentication via the ``X-Service-Token`` header and,
critically, that the token is sourced from the canonical ``GUARDRAIL_SERVICE_TOKEN``
env var (the key the gateway provisions) rather than the legacy
``GUARDRAIL_V2_SERVICE_TOKEN``. Reading the wrong key means enforcement silently
never fires in production.

The app is built with ``create_app()`` and driven over an ASGI transport WITHOUT
entering the lifespan, so Redis / GLiNER / provider init never run.

RED: written before the middleware exists and before the alias fix.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from guardrail.core.config import Settings
from guardrail.main import create_app

# A route that does not exist under the /api prefix. Passing auth => 404 (route
# miss); failing auth => 401 (middleware) — isolating the middleware from the
# lifespan-managed handler dependencies.
PROBE_PATH = "/api/__auth_probe__"
PROTECTED_TOKEN = "test-service-token-guardrail-xyz789"  # noqa: S105 — test constant


def _app_with_token(token: str) -> FastAPI:
    """Build the app (no lifespan) and force a specific service_token on app.state."""
    app = create_app()
    app.state.settings.service_token = SecretStr(token)
    return app


async def _status(app: FastAPI, path: str, headers: dict[str, str] | None = None) -> int:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get(path, headers=headers)
        return resp.status_code


# ── Auth disabled (dev mode) ──


async def test_empty_token_bypasses_auth() -> None:
    """Empty service_token => auth fully bypassed (protected path is not 401)."""
    app = _app_with_token("")
    status = await _status(app, PROBE_PATH)
    assert status != 401
    assert status == 404


# ── Auth enabled ──


async def test_missing_token_rejected() -> None:
    """A configured token with no header on a protected path => 401."""
    app = _app_with_token(PROTECTED_TOKEN)
    status = await _status(app, PROBE_PATH)
    assert status == 401


async def test_wrong_token_rejected() -> None:
    """A configured token with the wrong header value => 401."""
    app = _app_with_token(PROTECTED_TOKEN)
    status = await _status(app, PROBE_PATH, headers={"X-Service-Token": "wrong-token"})
    assert status == 401


async def test_correct_token_passes() -> None:
    """The correct token passes the middleware; the probe route still 404s."""
    app = _app_with_token(PROTECTED_TOKEN)
    status = await _status(app, PROBE_PATH, headers={"X-Service-Token": PROTECTED_TOKEN})
    assert status != 401
    assert status == 404


async def test_rejection_body() -> None:
    """The 401 body matches the contract the gateway expects."""
    app = _app_with_token(PROTECTED_TOKEN)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get(PROBE_PATH)
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Invalid or missing service token"}


# ── Exempt paths ──


async def test_exempt_openapi_reachable_without_token() -> None:
    """/openapi.json is reachable without a token even when auth is on."""
    app = _app_with_token(PROTECTED_TOKEN)
    status = await _status(app, "/openapi.json")
    assert status != 401
    assert status == 200


def test_exempt_paths_membership() -> None:
    """EXEMPT_PATHS covers the Guardrail health surface (/api/health*), metrics, docs."""
    from guardrail.api.middleware.auth import EXEMPT_PATHS

    for path in (
        "/api/health",
        "/api/health/ready",
        "/api/health/live",
        "/metrics",
        "/docs",
        "/redoc",
        "/openapi.json",
    ):
        assert path in EXEMPT_PATHS


# ── Alias fix: token read from the canonical GUARDRAIL_SERVICE_TOKEN key ──


def test_service_token_reads_canonical_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Setting GUARDRAIL_SERVICE_TOKEN (the gateway key) populates service_token."""
    monkeypatch.delenv("GUARDRAIL_V2_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("GUARDRAIL_SERVICE_TOKEN", "canonical-token-123")
    settings = Settings()
    assert settings.service_token.get_secret_value() == "canonical-token-123"


def test_legacy_v2_env_no_longer_read(monkeypatch: pytest.MonkeyPatch) -> None:
    """The legacy GUARDRAIL_V2_SERVICE_TOKEN key must NOT populate service_token."""
    monkeypatch.delenv("GUARDRAIL_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("GUARDRAIL_V2_SERVICE_TOKEN", "legacy-token-should-be-ignored")
    settings = Settings()
    assert settings.service_token.get_secret_value() == ""


async def test_enforcement_fires_from_canonical_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """End-to-end: GUARDRAIL_SERVICE_TOKEN in the env => middleware enforces (401 w/o header)."""
    monkeypatch.delenv("GUARDRAIL_V2_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("GUARDRAIL_SERVICE_TOKEN", "env-driven-token-456")
    app = create_app()  # reads the env via get_settings(); no app.state override
    status = await _status(app, PROBE_PATH)
    assert status == 401
