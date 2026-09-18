"""Request context and access logging, in pure ASGI (TASK-987 R-4).

**Never ``BaseHTTPMiddleware``.** The Starlette shim runs every request inside
its own anyio task group with two memory object streams; three stacked layers of
it were measured at ~2.2 ms of CPU per request — about 30% of the whole
per-request budget on a service running at 96-98% of one core
(``apps/text/src/text/api/middleware/request_id.py``). Neither middleware here
needs a task group, a ``Request`` or a ``Response``: one reads a header and sets
a header, the other reads the response status.

Starlette is a typing-only import. Header parsing is done against the raw ASGI
scope so this module imports in a worker process with no web framework
installed.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Iterable
from typing import TYPE_CHECKING

from hope_obs.logging import bind_request_context, clear_request_context, get_logger

if TYPE_CHECKING:  # pragma: no cover - typing only; never imported at runtime
    from starlette.types import ASGIApp, Message, Receive, Scope, Send

REQUEST_ID_HEADER = b"x-request-id"
TENANT_ID_HEADER = b"x-tenant-id"


def _header(scope: Scope, name: bytes) -> str | None:
    headers: Iterable[tuple[bytes, bytes]] = scope.get("headers") or []
    for key, value in headers:
        if key.lower() == name:
            return value.decode("latin-1")
    return None


class RequestContextMiddleware:
    """Bind ``request_id`` (and ``tenant_id``, when sent) for one request.

    ``request_id`` is the inbound ``X-Request-ID`` or a fresh uuid4, and is
    echoed on the response so a caller can quote it in a bug report.

    ``tenant_id`` is bound ONLY when ``X-Tenant-Id`` is present. Absent is
    absent: this middleware never invents a tenant and never defaults to one
    (``.claude/rules/00-project-context.md`` — a "default tenant" knob is the
    exact failure mode that rule exists to catch). Finding F-07 is that no
    service bound a tenant at all, so guardrail decisions the platform requires
    to be attributable were not attributable in the logs.

    The binding is cleared in ``finally``, on both the success and the exception
    path: a leaked contextvar would stamp the NEXT request handled by the same
    task with the previous request's identity.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = _header(scope, REQUEST_ID_HEADER) or str(uuid.uuid4())
        tenant_id = _header(scope, TENANT_ID_HEADER)
        raw_request_id = request_id.encode("latin-1")

        async def send_with_header(message: Message) -> None:
            if message["type"] == "http.response.start":
                # A NEW list, never an in-place append: the same `headers` list
                # can be reused by a response object across sends, and mutating
                # it would accumulate one duplicate header per send.
                message = {
                    **message,
                    "headers": [
                        *(
                            (key, value)
                            for key, value in message.get("headers", [])
                            if key.lower() != REQUEST_ID_HEADER
                        ),
                        (REQUEST_ID_HEADER, raw_request_id),
                    ],
                }
            await send(message)

        context: dict[str, str] = {"request_id": request_id}
        if tenant_id:
            context["tenant_id"] = tenant_id

        bind_request_context(**context)
        try:
            await self.app(scope, receive, send_with_header)
        finally:
            clear_request_context()


class AccessLogMiddleware:
    """Emit ``request.start`` / ``request.complete`` / ``request.failed``.

    ``request.complete`` is emitted when the response STARTS, not when its body
    finishes, so ``duration_ms`` means "time to first response byte". Moving it
    to the end of the body would silently redefine the field — and for an SSE
    generation it would turn a request-latency metric into a generation-duration
    one (``apps/text/src/text/api/middleware/logging.py``).

    Install it INSIDE ``RequestContextMiddleware`` so every line it writes
    already carries ``request_id`` and ``tenant_id``.
    """

    def __init__(self, app: ASGIApp, logger_name: str = "access") -> None:
        self.app = app
        self.logger_name = logger_name

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        logger = get_logger(self.logger_name)
        started = time.monotonic()
        method: str = scope["method"]
        path: str = scope["path"]

        def elapsed_ms() -> float:
            return round((time.monotonic() - started) * 1000, 2)

        logger.info("request.start", method=method, path=path)

        async def send_and_log(message: Message) -> None:
            if message["type"] == "http.response.start":
                logger.info(
                    "request.complete",
                    method=method,
                    path=path,
                    status_code=message["status"],
                    duration_ms=elapsed_ms(),
                )
            await send(message)

        try:
            await self.app(scope, receive, send_and_log)
        except Exception as exc:
            # `error` carries the exception's STRING form, which for a handler
            # that formatted clinical content into its message would be PHI.
            # Services raise exceptions with PHI-free messages; the type is the
            # part that is always safe, and the only part the collector's
            # allow-list would let through on a span anyway.
            logger.error(
                "request.failed",
                method=method,
                path=path,
                duration_ms=elapsed_ms(),
                error_type=type(exc).__name__,
                error=str(exc),
            )
            raise
