"""Request-ID propagation middleware.

Extracts X-Request-ID from the incoming request (or generates a UUID4),
binds it to structlog contextvars for the duration of the request, and
sets the same header on the response.

**Pure ASGI, not `BaseHTTPMiddleware`**. The shim runs every
request inside its own anyio task group with two memory object streams; three
stacked layers of it cost ~2.2 ms of CPU per request here — about 30% of the
whole per-request budget on a service that runs at 96-98% of one core. This
middleware reads one header and sets one header, which needs neither a task
group nor a `Request`/`Response` object.
"""

from __future__ import annotations

import uuid

import structlog.contextvars
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class RequestIDMiddleware:
    """Propagate or generate a request ID and bind it to structured logging."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = Headers(scope=scope).get("x-request-id") or str(uuid.uuid4())
        raw_id = request_id.encode("latin-1")

        async def send_with_header(message: Message) -> None:
            if message["type"] == "http.response.start":
                # A NEW list, never an in-place append: the same `headers` list can
                # be reused by a response object across sends, and mutating it
                # would accumulate a duplicate header per send.
                message = {
                    **message,
                    "headers": [
                        *(
                            (k, v)
                            for k, v in message.get("headers", [])
                            if k.lower() != b"x-request-id"
                        ),
                        (b"x-request-id", raw_id),
                    ],
                }
            await send(message)

        structlog.contextvars.bind_contextvars(request_id=request_id)
        try:
            await self.app(scope, receive, send_with_header)
        finally:
            structlog.contextvars.clear_contextvars()
