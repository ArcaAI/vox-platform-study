"""Inter-service authentication middleware.

Validates the ``X-Service-Token`` header on incoming requests. When no token is
configured AND the process is running locally, auth is bypassed entirely (dev
mode). Mirrors the text/STT service-auth contract and pairs with the gateway's
token injection.

The accept/bypass decision itself lives in :mod:`tts.core.service_auth` because
the WebSocket endpoint has to make the same one and ``BaseHTTPMiddleware`` never
sees a WebSocket scope.
"""

from __future__ import annotations

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from tts.core.logging import get_logger
from tts.core.service_auth import dev_bypass_active, token_accepted

logger = get_logger(__name__)

EXEMPT_PATHS: frozenset[str] = frozenset(
    {
        "/metrics",
        "/api/v1/docs",
        "/api/v1/redoc",
        "/api/v1/openapi.json",
        "/api/v1/health",
        "/api/v1/health/live",
        "/api/v1/health/ready",
        # TASK-990 F7: the fourth route of the gateway's health contract. An
        # unexempted path is answered 401 by this middleware BEFORE FastAPI can
        # route it, so a probe pointed here would fail for the wrong reason —
        # and would look like an auth problem, not a missing route.
        "/api/v1/health/startup",
    }
)


class ServiceAuthMiddleware(BaseHTTPMiddleware):
    """Require a valid X-Service-Token for non-exempt endpoints."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        # Owner decision D-D (2026-08-17): the CANONICAL credential is the single
        # shared `INTERNAL_ACCESS_TOKEN`; the legacy per-service token stays
        # accepted as a zero-cost backward-compatibility fallback.
        accepted: tuple[str, ...] = request.app.state.settings.accepted_service_tokens

        # Probes and docs stay reachable even when the service is failing closed
        # — a misconfigured pod must still be able to report that it is unwell.
        if request.url.path in EXEMPT_PATHS:
            return await call_next(request)

        # Both empty ⇒ auth bypassed, but ONLY on a developer machine / in CI.
        if dev_bypass_active(accepted):
            return await call_next(request)

        provided = request.headers.get("X-Service-Token", "")
        if not token_accepted(provided, accepted):
            logger.warning(
                "tts.auth.rejected",
                path=request.url.path,
                reason="no_token_configured" if not accepted else "invalid_or_missing_token",
            )
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid or missing service token"},
            )

        return await call_next(request)
