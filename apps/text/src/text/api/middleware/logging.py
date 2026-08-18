"""Request lifecycle logging middleware."""

from __future__ import annotations

import time

import structlog
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    """Log request start, completion, and failure with latency."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        logger = structlog.get_logger("text.access")
        start = time.monotonic()
        method = request.method
        path = request.url.path

        logger.info("request.start", method=method, path=path)

        try:
            response = await call_next(request)
            duration_ms = round((time.monotonic() - start) * 1000, 2)

            logger.info(
                "request.complete",
                method=method,
                path=path,
                status_code=response.status_code,
                duration_ms=duration_ms,
            )
            return response
        except Exception as exc:
            duration_ms = round((time.monotonic() - start) * 1000, 2)
            logger.error(
                "request.failed",
                method=method,
                path=path,
                duration_ms=duration_ms,
                error=str(exc),
                error_type=type(exc).__name__,
            )
            raise
