"""Worker recycling (TASK-1047 C8/D6): bound allocator retention.

After a response is fully sent, the process exits GRACEFULLY (SIGTERM to
itself: uvicorn drains in-flight requests first) when its RSS is above
``nlp.worker.recycleRssMib`` or it has served ``nlp.worker.recycleAfterRequests``
requests. The supervisor / uvicorn multiprocess manager restarts it.

The request-count recycle applies ONLY when the process is one of several
uvicorn workers: a lone process (the cluster pod) exiting takes the whole
service down while every model reloads, so there it is left to the RSS
ceiling. ``0`` disables either recycle.

The RSS ceiling is clamped to 90 % of the container's cgroup memory limit when
one is readable: a ceiling above the limit never fires, the kernel OOM-kills first.

RSS source: ``psutil`` if importable, else ``/proc/self/statm`` (Linux), else
``resource.getrusage`` peak RSS (a conservative over-estimate).
"""

from __future__ import annotations

import os
import signal
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from nlp.core import bounds
from nlp.core.logging import get_logger

logger = get_logger(__name__)

_EXEMPT_FRAGMENTS = ("/health", "/metrics")

#: Share of the cgroup memory limit the RSS ceiling may reach.
CGROUP_LIMIT_FRACTION = 0.9
#: cgroup v1 reports "unlimited" as a huge page-aligned value; anything at or above this is none.
_CGROUP_V1_UNLIMITED_BYTES = 1 << 62
_CGROUP_ROOT = Path("/sys/fs/cgroup")


def cgroup_memory_limit_mib(root: Path = _CGROUP_ROOT) -> int | None:
    """The container memory limit in MiB (cgroup v2, then v1), or ``None`` if unreadable/unset."""
    for path in (root / "memory.max", root / "memory" / "memory.limit_in_bytes"):
        try:
            raw = path.read_text().strip()
        except OSError:
            continue
        if raw == "max":
            return None
        try:
            limit = int(raw)
        except ValueError:
            continue
        if limit <= 0 or limit >= _CGROUP_V1_UNLIMITED_BYTES:
            return None
        return limit // (1024 * 1024)
    return None


def effective_rss_ceiling_mib(configured_mib: int, limit_mib: int | None) -> int:
    """``configured_mib``, lowered to ``CGROUP_LIMIT_FRACTION`` of a known limit. 0 stays 0."""
    if configured_mib <= 0 or limit_mib is None:
        return configured_mib
    return min(configured_mib, int(limit_mib * CGROUP_LIMIT_FRACTION))


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
        worker_count: int | None = None,
        memory_limit_mib: int | None | Callable[[], int | None] = cgroup_memory_limit_mib,
    ) -> None:
        self._rss_reader = rss_reader
        self._shutdown = shutdown
        if worker_count is None:
            from nlp.core.config import settings

            worker_count = settings.service.workers
        self._worker_count = worker_count
        self._memory_limit_mib = (
            memory_limit_mib() if callable(memory_limit_mib) else memory_limit_mib
        )
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
        rss_ceiling = effective_rss_ceiling_mib(limits.recycle_rss_mib, self._memory_limit_mib)
        if rss_ceiling > 0 and rss_mib > rss_ceiling:
            reason = "rss"
        elif (
            self._worker_count > 1
            and limits.recycle_after_requests > 0
            and self._served >= limits.recycle_after_requests
        ):
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
