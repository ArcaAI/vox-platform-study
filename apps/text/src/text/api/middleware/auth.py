"""Inter-service authentication middleware.

Validates X-Service-Token header on incoming requests.
When service_token is empty (dev mode), auth is bypassed entirely.
"""

from __future__ import annotations

import hmac

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from text.core.logging import get_logger

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
    }
)


class ServiceAuthMiddleware(BaseHTTPMiddleware):
    """Require a valid X-Service-Token for non-exempt endpoints."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        # Owner decision D-D (2026-08-17): the CANONICAL credential is the single
        # shared `INTERNAL_ACCESS_TOKEN`. The legacy per-service `TEXT_SERVICE_TOKEN`
        # stays accepted as a zero-cost backward-compatibility fallback — not a
        # second design. Both empty ⇒ auth bypassed (local dev / hermetic CI).
        accepted: tuple[str, ...] = request.app.state.settings.accepted_service_tokens

        if not accepted:
            return await call_next(request)

        if request.url.path in EXEMPT_PATHS:
            return await call_next(request)

        provided = request.headers.get("X-Service-Token", "")
        if not provided or not any(hmac.compare_digest(provided, t) for t in accepted):
            logger.warning(
                "text.auth.rejected",
                path=request.url.path,
                reason="invalid_or_missing_token",
            )
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid or missing service token"},
            )

        return await call_next(request)
