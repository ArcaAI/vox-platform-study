"""Inter-service authentication middleware.

Validates the ``X-Service-Token`` header on incoming requests. When no token is
configured AND the process is running locally, auth is bypassed entirely (dev
mode). A direct copy of ``apps/text``'s ``ServiceAuthMiddleware`` contract —
constant-time compare, health/docs/metrics exempt, 401 with a generic body —
tailored to stt's route surface, where health lives under ``/api/v1/health`` and
everything sensitive lives under ``/internal/*``.

The accept/bypass decision itself lives in :mod:`stt.core.service_auth`; see that
module for why the bypass is conditioned on the environment.
"""

from __future__ import annotations

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from stt.core.logging import get_logger
from stt.core.service_auth import dev_bypass_active, token_accepted

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
        # verified live: `GET /api/v1/health/startup` answered 401, not 404.
        "/api/v1/health/startup",
        # Backward-compatible probe aliases kept for existing k8s configs
        # (`health/api/routes.py` serves both spellings).
        "/api/v1/live",
        "/api/v1/ready",
    }
)


class ServiceAuthMiddleware(BaseHTTPMiddleware):
    """Require a valid X-Service-Token for non-exempt endpoints."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        # Owner decision D-D (2026-08-17): the CANONICAL — and for stt the only —
        # credential is the single shared `INTERNAL_ACCESS_TOKEN`.
        accepted: tuple[str, ...] = request.app.state.settings.accepted_service_tokens

        # Probes and docs stay reachable even when the service is failing closed
        # — a misconfigured pod must still be able to report that it is unwell.
        if request.url.path in EXEMPT_PATHS:
            return await call_next(request)

        # Nothing configured ⇒ auth bypassed, but ONLY on a developer machine.
        if dev_bypass_active(accepted):
            return await call_next(request)

        provided = request.headers.get("X-Service-Token", "")
        if not token_accepted(provided, accepted):
            logger.warning(
                "stt.auth.rejected",
                path=request.url.path,
                reason="no_token_configured" if not accepted else "invalid_or_missing_token",
            )
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid or missing service token"},
            )

        return await call_next(request)
