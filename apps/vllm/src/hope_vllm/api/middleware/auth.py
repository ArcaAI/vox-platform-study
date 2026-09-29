"""``X-Service-Token`` middleware (pattern: ``apps/tts/src/tts/api/middleware/auth.py``)."""

from __future__ import annotations

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from hope_obs import get_logger
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from hope_vllm.core.service_auth import dev_bypass_active, token_accepted

logger = get_logger(__name__)

#: Probes, metrics and docs stay reachable even when auth fails closed — a
#: misconfigured pod must still be able to report that it is unwell.
EXEMPT_PATHS: frozenset[str] = frozenset(
    {
        "/metrics",
        "/api/v1/docs",
        "/api/v1/openapi.json",
        "/api/v1/health",
        "/api/v1/health/live",
        "/api/v1/health/ready",
        "/api/v1/health/startup",
    }
)


class ServiceAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        if request.url.path in EXEMPT_PATHS:
            return await call_next(request)
        accepted: tuple[str, ...] = request.app.state.settings.accepted_service_tokens
        if dev_bypass_active(accepted):
            return await call_next(request)
        if not token_accepted(request.headers.get("X-Service-Token", ""), accepted):
            logger.warning(
                "vllm.auth.rejected",
                path=request.url.path,
                reason="no_token_configured" if not accepted else "invalid_or_missing_token",
            )
            return JSONResponse(
                status_code=401, content={"detail": "Invalid or missing service token"}
            )
        return await call_next(request)
