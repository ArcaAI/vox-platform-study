"""Inter-service authentication middleware for the Guardrail service (TASK-465).

Validates the ``X-Service-Token`` header on incoming requests. When
``service_token`` is empty (dev mode / hermetic CI) auth is bypassed entirely,
so local development and tests stay green. Mirrors ``apps/smr``'s
``ServiceAuthMiddleware``, tailored to the Guardrail route surface (health lives
under ``/api/health``).

The token is read from ``app.state.settings`` at dispatch time.
"""

from __future__ import annotations

import hmac

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from guardrail.core.logging import get_logger

logger = get_logger(__name__)

EXEMPT_PATHS: frozenset[str] = frozenset(
    {
        "/api/health",
        "/api/health/ready",
        "/api/health/live",
        "/metrics",
        "/docs",
        "/redoc",
        "/openapi.json",
    }
)


class ServiceAuthMiddleware(BaseHTTPMiddleware):
    """Require a valid X-Service-Token for non-exempt endpoints."""

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        service_token: str = request.app.state.settings.service_token.get_secret_value()

        if not service_token:
            return await call_next(request)

        if request.url.path in EXEMPT_PATHS:
            return await call_next(request)

        provided = request.headers.get("X-Service-Token", "")
        if not provided or not hmac.compare_digest(provided, service_token):
            logger.warning(
                "guardrail.auth.rejected",
                path=request.url.path,
                reason="invalid_or_missing_token",
            )
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid or missing service token"},
            )

        return await call_next(request)
