"""Inter-service authentication middleware for the NLP service (TASK-465).

Validates the ``X-Service-Token`` header on incoming requests. When
``service_token`` is empty (dev mode / hermetic CI) auth is bypassed entirely,
so local development and tests stay green. Mirrors ``apps/smr``'s
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

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        service_token: str = settings.service.service_token.get_secret_value()

        if not service_token:
            return await call_next(request)

        if request.url.path in EXEMPT_PATHS:
            return await call_next(request)

        provided = request.headers.get("X-Service-Token", "")
        if not provided or not hmac.compare_digest(provided, service_token):
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
    service_token: str = settings.service.service_token.get_secret_value()

    if not service_token:
        return True

    provided = websocket.headers.get("x-service-token", "")
    if not provided or not hmac.compare_digest(provided, service_token):
        logger.warning(
            "nlp.auth.ws_rejected path=%s reason=invalid_or_missing_token",
            websocket.url.path,
        )
        await websocket.close(code=1008)
        return False

    return True
