"""Request lifecycle logging middleware.

**Pure ASGI, not `BaseHTTPMiddleware`** — see `request_id.py`'s docstring for the
measurement that motivated the change (~2.2 ms CPU/request across the three
layers, ~30% of the per-request budget).

`request.complete` is emitted when the response STARTS, not when its body
finishes. That is deliberate: it is exactly where `BaseHTTPMiddleware` used to
emit it (its `call_next` returned as soon as the response began), so
`duration_ms` keeps meaning "time to first response byte". Moving it to the end
of the body would silently redefine the field — and for an SSE generation it
would turn a request-latency metric into a generation-duration one.
"""

from __future__ import annotations

import time

import structlog
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class RequestLoggingMiddleware:
    """Log request start, completion, and failure with latency."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        logger = structlog.get_logger("text.access")
        start = time.monotonic()
        method = scope["method"]
        path = scope["path"]

        logger.info("request.start", method=method, path=path)

        async def send_and_log(message: Message) -> None:
            if message["type"] == "http.response.start":
                logger.info(
                    "request.complete",
                    method=method,
                    path=path,
                    status_code=message["status"],
                    duration_ms=round((time.monotonic() - start) * 1000, 2),
                )
            await send(message)

        try:
            await self.app(scope, receive, send_and_log)
        except Exception as exc:
            logger.error(
                "request.failed",
                method=method,
                path=path,
                duration_ms=round((time.monotonic() - start) * 1000, 2),
                error=str(exc),
                error_type=type(exc).__name__,
            )
            raise
