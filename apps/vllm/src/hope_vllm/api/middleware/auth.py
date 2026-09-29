"""Service-token middleware (pattern: ``apps/tts/src/tts/api/middleware/auth.py``).

The credential is the ONE shared internal token (D-10), presented as ``X-Service-Token``
(the house peer header) or as ``Authorization: Bearer <token>`` — what a stock OpenAI
client sends for its ``api_key``. Both go through the same constant-time check.

On the OpenAI surface (``/v1/*``) the middleware also requires ``X-Tenant-Id`` (400
``tenant_id_required``) and puts it on ``request.state.tenant_id``; both refusals there are
OpenAI-shaped. ``/api/v1/*`` keeps the house ``{"detail": …}`` shape.

A PURE ASGI middleware, not ``BaseHTTPMiddleware``: the latter re-plumbs ``receive`` through
a task group, and a handler behind it can no longer see ``http.disconnect`` with
``Request.is_disconnected()`` — which is how a transcription notices a client that left and
aborts its decode inside vLLM (review focus 4).
"""

from __future__ import annotations

from fastapi.responses import JSONResponse
from hope_obs import get_logger
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

from hope_vllm.api.openai_errors import is_openai_path, openai_error_response
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

_BEARER = "bearer "


def presented_token(headers: Headers) -> str:
    """``X-Service-Token``, else the credential of ``Authorization: Bearer …``, else ""."""
    token = headers.get("X-Service-Token", "")
    if token:
        return token
    authorization = headers.get("Authorization", "")
    if authorization[: len(_BEARER)].lower() == _BEARER:
        return authorization[len(_BEARER) :].strip()
    return ""


class ServiceAuthMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] in EXEMPT_PATHS:
            await self.app(scope, receive, send)
            return
        path: str = scope["path"]
        openai = is_openai_path(path)
        headers = Headers(scope=scope)
        accepted: tuple[str, ...] = scope["app"].state.settings.accepted_service_tokens
        if not dev_bypass_active(accepted) and not token_accepted(
            presented_token(headers), accepted
        ):
            logger.warning(
                "vllm.auth.rejected",
                path=path,
                reason="no_token_configured" if not accepted else "invalid_or_missing_token",
            )
            if openai:
                response = openai_error_response(
                    401, "invalid_service_token", "Invalid or missing service token"
                )
            else:
                response = JSONResponse(
                    status_code=401, content={"detail": "Invalid or missing service token"}
                )
            await response(scope, receive, send)
            return
        if openai:
            tenant = (headers.get("X-Tenant-Id") or "").strip()
            if not tenant:
                await openai_error_response(
                    400, "tenant_id_required", "X-Tenant-Id header is required"
                )(scope, receive, send)
                return
            scope.setdefault("state", {})["tenant_id"] = tenant
        await self.app(scope, receive, send)
