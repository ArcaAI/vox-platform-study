"""Request-ID propagation middleware.

Extracts X-Request-ID from the incoming request (or generates a UUID4),
binds it to structlog contextvars for the duration of the request, and
sets the same header on the response.
"""

from __future__ import annotations

import uuid

import structlog.contextvars
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response


class RequestIDMiddleware(BaseHTTPMiddleware):
    """Propagate or generate a request ID and bind it to structured logging."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = request.headers.get("x-request-id") or str(uuid.uuid4())

        structlog.contextvars.bind_contextvars(request_id=request_id)
        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.clear_contextvars()

        response.headers["X-Request-ID"] = request_id
        return response
