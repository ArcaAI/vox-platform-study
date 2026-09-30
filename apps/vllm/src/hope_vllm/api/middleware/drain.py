"""Refuse new ``/v1/*`` work while the replica drains (SIGTERM → shutdown).

Pure ASGI (see ``auth.py`` for why not ``BaseHTTPMiddleware``). A draining replica answers
503 ``server_error`` / ``draining`` with ``Retry-After``, so an OpenAI client — or ``stt`` —
retries against another replica; requests already past this point finish normally.

It also COUNTS the ``/v1/*`` requests it admitted (``app.state.active_requests``), so the
shutdown waits for a request that is still resolving its model or reading its audio — not
only for one already holding an engine lease.
"""

from __future__ import annotations

from starlette.types import ASGIApp, Receive, Scope, Send

from hope_vllm.api.openai_errors import is_openai_path, openai_error_response
from hope_vllm.core import metrics


class DrainMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] == "http"
            and is_openai_path(scope["path"])
            and getattr(scope["app"].state, "draining", False)
        ):
            metrics.REJECTIONS_TOTAL.labels(reason="draining").inc()
            response = openai_error_response(
                503,
                "draining",
                "this replica is shutting down; retry against another",
                headers={"Retry-After": "1"},
            )
            await response(scope, receive, send)
            return
        if scope["type"] != "http" or not is_openai_path(scope["path"]):
            await self.app(scope, receive, send)
            return
        state = scope["app"].state
        state.active_requests = getattr(state, "active_requests", 0) + 1
        try:
            await self.app(scope, receive, send)
        finally:
            state.active_requests -= 1
