"""Inter-service request preconditions.

Two checks, in order, for every non-exempt endpoint:

1. **Who is calling** — a valid ``X-Service-Token``. When no token is configured
   at all (dev mode) this check is bypassed entirely.
2. **Whose work it is** — an ``X-Tenant-Id``, or a DECLARED ``tenantless:<reason>``
   marker. This is NEVER bypassed; it does not depend on (1).
"""

from __future__ import annotations

import hmac

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

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
        # TASK-990 F7: the fourth route of the gateway's health contract. An
        # unexempted path is answered 401 by this middleware BEFORE FastAPI can
        # route it (and 428 by the tenant precondition below it), so a probe
        # pointed here would fail for the wrong reason.
        "/api/v1/health/startup",
    }
)


# `X-Tenant-Id` is MANDATORY on every internal request carrying tenant-scoped work
# (owner directive 2026-08-16): a guardrail/billing decision must be attributable,
# and a peer client that omits the header is a bug in the CALLER, not a case for
# the callee to paper over with a platform default.
#
# It is enforced HERE, not per route. It used to be a `_require_inbound_tenant(...)`
# call inside individual handlers, which reached 2 of 8 routes — precisely the two
# someone was working on. `/judge` and `/embeddings` declared the header `Optional`
# and never looked at it; `/translate` declared none at all, and `/translate` carries
# a tenant's Sarvam BYO credential. A guard a route has to opt into is a guard the
# next route will not have, so the default is now inherited: a new endpoint is
# covered the moment it is mounted, and OPTING OUT means adding a path to
# `EXEMPT_PATHS` — a visible, reviewable edit.
#
# 428 (not 400) mirrors the gateway's own `RequiresIfMatch`/ETag convention: a
# mandatory request PRECONDITION is missing. It matches the two `apps/nlp` classify
# routes already enforcing this, so one status code means one thing platform-wide.
#
# A DECLARED `tenantless:<reason>` marker is a legitimate value: some internal work
# genuinely has no tenant (a platform-wide job queue, a control-plane pull), and it
# says so rather than arriving indistinguishable from a header dropped in transit.
# That distinction is precisely what makes ABSENT safe to refuse.
TENANTLESS_PREFIX = "tenantless:"

_TENANT_REQUIRED_DETAIL = (
    "X-Tenant-Id is required on internal requests carrying tenant-scoped work. "
    "Declare 'tenantless:<reason>' for genuinely tenant-less internal work."
)


class ServiceAuthMiddleware:
    """Enforce the service token and the tenant precondition for non-exempt routes.

    **Pure ASGI, not `BaseHTTPMiddleware`** — see
    `request_id.py`'s docstring for the measurement. The checks below are
    unchanged, in the same order, with the same statuses and log events; only the
    transport differs. A `Request` is still constructed, because it is a lazy
    view over the scope (headers are parsed on access) and costs nothing like the
    task group and memory-object-stream pair the shim allocated per request.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive)
        if request.url.path in EXEMPT_PATHS:
            await self.app(scope, receive, send)
            return

        # Owner decision D-D (2026-08-17): the CANONICAL credential is the single
        # shared `INTERNAL_ACCESS_TOKEN`. The legacy per-service `TEXT_SERVICE_TOKEN`
        # stays accepted as a zero-cost backward-compatibility fallback — not a
        # second design. Both empty ⇒ auth bypassed (local dev / hermetic CI).
        accepted: tuple[str, ...] = request.app.state.settings.accepted_service_tokens
        if accepted:
            provided = request.headers.get("X-Service-Token", "")
            if not provided or not any(hmac.compare_digest(provided, t) for t in accepted):
                logger.warning(
                    "text.auth.rejected",
                    path=request.url.path,
                    reason="invalid_or_missing_token",
                )
                await JSONResponse(
                    status_code=401,
                    content={"detail": "Invalid or missing service token"},
                )(scope, receive, send)
                return

        # Deliberately OUTSIDE the `if accepted:` block above: the dev-mode token
        # bypass says nothing about tenant attribution, and the two contracts must
        # not be able to disable each other.
        tenant_refusal = _tenant_precondition_refusal(request)
        if tenant_refusal is not None:
            await tenant_refusal(scope, receive, send)
            return

        await self.app(scope, receive, send)


def _tenant_precondition_refusal(request: Request) -> JSONResponse | None:
    """``None`` when the tenant precondition is satisfied, else the 428 to return.

    Fails CLOSED — this runs before any handler, so a tenant-less request never
    reaches provider selection and can never bill a credential resolved from the
    wrong tier.
    """
    raw = (request.headers.get("X-Tenant-Id") or "").strip()
    if not raw:
        logger.error(
            "text.tenant_header.missing",
            path=request.url.path,
            detail=(
                "internal request carried no X-Tenant-Id; refusing rather than "
                "resolving the platform default provider and mis-attributing the "
                "spend. This is a CALLER defect."
            ),
        )
        return JSONResponse(status_code=428, content={"detail": _TENANT_REQUIRED_DETAIL})
    if raw.startswith(TENANTLESS_PREFIX):
        logger.debug("text.tenant_header.declared_tenantless", marker=raw)
    return None
