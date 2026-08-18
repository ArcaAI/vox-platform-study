"""Inter-service authentication middleware for the Guardrail service.

Validates the ``X-Service-Token`` header on incoming requests. When
``service_token`` is empty (dev mode / hermetic CI) auth is bypassed entirely,
so local development and tests stay green. Mirrors ``apps/text``'s
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
        # /api/v1/health alias — every other python service exposes health at
        # the v1 path; kept exempt like its /api/health counterpart above.
        "/api/v1/health",
        "/api/v1/health/ready",
        "/api/v1/health/live",
        "/metrics",
        "/docs",
        "/redoc",
        "/openapi.json",
    }
)


class ServiceAuthMiddleware(BaseHTTPMiddleware):
    """Require a valid X-Service-Token for non-exempt endpoints."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        # Owner decision D-D (2026-08-17): the CANONICAL credential is the single
        # shared `INTERNAL_ACCESS_TOKEN`; the legacy per-service token stays
        # accepted as a zero-cost backward-compatibility fallback. Both empty ⇒
        # auth bypassed (local dev / hermetic CI), unchanged.
        accepted: tuple[str, ...] = request.app.state.settings.accepted_service_tokens

        if not accepted:
            return await call_next(request)

        if request.url.path in EXEMPT_PATHS:
            return await call_next(request)

        provided = request.headers.get("X-Service-Token", "")
        if not provided or not any(hmac.compare_digest(provided, t) for t in accepted):
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
