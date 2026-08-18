"""Inter-service authentication middleware for the NLP service.

Validates the ``X-Service-Token`` header on incoming requests. When
``service_token`` is empty (dev mode / hermetic CI) auth is bypassed entirely,
so local development and tests stay green. Mirrors ``apps/text``'s
``ServiceAuthMiddleware``, tailored to the NLP route surface (health lives under
``/api/v1/health``).

The token is read from the ``nlp.core.config`` module singleton at dispatch time
so it can be reconfigured (e.g. in tests) without rebuilding the application.
"""

from __future__ import annotations

import hmac

from fastapi import Request, Response, WebSocket
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from nlp.core.config import settings
from nlp.core.logging import get_logger

logger = get_logger(__name__)

EXEMPT_PATHS: frozenset[str] = frozenset(
    {
        "/",
        "/api/v1/health",
        "/api/v1/health/live",
        "/api/v1/health/ready",
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
        accepted: tuple[str, ...] = settings.service.accepted_service_tokens

        if not accepted:
            return await call_next(request)

        if request.url.path in EXEMPT_PATHS:
            return await call_next(request)

        provided = request.headers.get("X-Service-Token", "")
        if not provided or not any(hmac.compare_digest(provided, t) for t in accepted):
            logger.warning(
                "nlp.auth.rejected path=%s reason=invalid_or_missing_token",
                request.url.path,
            )
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid or missing service token"},
            )

        return await call_next(request)


async def enforce_service_token_ws(websocket: WebSocket) -> bool:
    """WebSocket counterpart to ``ServiceAuthMiddleware``.

    ``BaseHTTPMiddleware`` never sees WebSocket scopes (Starlette short-circuits
    ``dispatch`` for ``scope["type"] == "websocket"``), so WS handlers must call
    this BEFORE ``websocket.accept()``. Mirrors the HTTP check exactly: an empty
    configured token is a dev bypass; otherwise a matching ``X-Service-Token``
    header is required, else the handshake is refused with policy-violation 1008.

    Returns ``True`` when the handler may accept the connection; ``False`` when the
    socket has been closed and the handler must return without accepting.
    """
    # Same shared-then-legacy acceptance as the HTTP middleware (owner decision D-D).
    accepted: tuple[str, ...] = settings.service.accepted_service_tokens

    if not accepted:
        return True

    provided = websocket.headers.get("x-service-token", "")
    if not provided or not any(hmac.compare_digest(provided, t) for t in accepted):
        logger.warning(
            "nlp.auth.ws_rejected path=%s reason=invalid_or_missing_token",
            websocket.url.path,
        )
        await websocket.close(code=1008)
        return False

    return True
