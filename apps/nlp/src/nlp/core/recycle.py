"""Worker recycling (TASK-1047 C8/D6): bound allocator retention.

After a response is fully sent, the process exits GRACEFULLY (SIGTERM to
itself: uvicorn drains in-flight requests first) when its RSS is above
``nlp.worker.recycleRssMib`` or it has served ``nlp.worker.recycleAfterRequests``
requests. The supervisor / uvicorn multiprocess manager restarts it.

RSS source: ``psutil`` if importable, else ``/proc/self/statm`` (Linux), else
``resource.getrusage`` peak RSS (a conservative over-estimate).
"""

from __future__ import annotations

import os
import signal
import sys
from collections.abc import Callable
from typing import Any

from nlp.core import bounds
from nlp.core.logging import get_logger

logger = get_logger(__name__)

_EXEMPT_FRAGMENTS = ("/health", "/metrics")


def _current_rss_mib() -> float:
    try:
        import psutil

        return float(psutil.Process().memory_info().rss) / (1024 * 1024)
    except ImportError:
        pass
    try:
        with open("/proc/self/statm") as handle:
            pages = int(handle.read().split()[1])
        return pages * os.sysconf("SC_PAGE_SIZE") / (1024 * 1024)
    except (OSError, ValueError, IndexError):
        pass
    import resource

    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # macOS reports bytes, Linux KiB.
    return peak / (1024 * 1024) if sys.platform == "darwin" else peak / 1024


def _request_shutdown(reason: str) -> None:
    logger.warning("nlp.worker.recycle", reason=reason)
    os.kill(os.getpid(), signal.SIGTERM)


class RecycleGuard:
    def __init__(
        self,
        rss_reader: Callable[[], float] | None = None,
        shutdown: Callable[[str], None] | None = None,
    ) -> None:
        self._rss_reader = rss_reader
        self._shutdown = shutdown
        self._served = 0
        self._triggered = False

    def after_response(self) -> None:
        from nlp.core.metrics import NLP_PROCESS_RSS_BYTES

        self._served += 1
        rss_mib = (self._rss_reader or _current_rss_mib)()
        NLP_PROCESS_RSS_BYTES.set(rss_mib * 1024 * 1024)
        if self._triggered:
            return
        limits = bounds.get_bounds()
        reason = None
        if rss_mib > limits.recycle_rss_mib:
            reason = "rss"
        elif self._served >= limits.recycle_after_requests:
            reason = "requests"
        if reason:
            self._triggered = True
            (self._shutdown or _request_shutdown)(reason)


_guard: RecycleGuard | None = None


def get_recycle_guard() -> RecycleGuard:
    global _guard
    if _guard is None:
        _guard = RecycleGuard()
    return _guard


def reset_recycle_guard() -> None:
    global _guard
    _guard = None


class RecycleMiddleware:
    """Pure ASGI: runs the check once the final body chunk has been sent."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http" or any(f in scope.get("path", "") for f in _EXEMPT_FRAGMENTS):
            await self.app(scope, receive, send)
            return

        async def tracking_send(message: Any) -> None:
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                try:
                    get_recycle_guard().after_response()
                except Exception as exc:  # noqa: BLE001 — never fail a served request
                    logger.warning("nlp.worker.recycle_check_failed", error=str(exc))

        await self.app(scope, receive, tracking_send)
