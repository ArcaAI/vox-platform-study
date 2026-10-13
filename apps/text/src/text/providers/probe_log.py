"""Edge-triggered logging for engine listing probes.

The gateway's readiness sweep probes every configured self-hosted engine on a
fixed interval. An engine that is configured but down (scaled to zero, not
deployed) would otherwise log a warning per provider per sweep, forever. Here a
failure warns once per outage — keyed by provider, address and error text — and
repeats at debug; the first success after it logs the recovery at info.
"""

from __future__ import annotations

import threading
from typing import Any

_lock = threading.Lock()
_failing: dict[tuple[str, str], str] = {}


def probe_failed(logger: Any, provider: str, base_url: str | None, error: str) -> None:
    key = (provider, base_url or "")
    with _lock:
        repeat = _failing.get(key) == error
        _failing[key] = error
    emit = logger.debug if repeat else logger.warning
    emit("get_info.failed", provider=provider, base_url=base_url, error=error, repeat=repeat)


def probe_succeeded(logger: Any, provider: str, base_url: str | None) -> None:
    key = (provider, base_url or "")
    with _lock:
        was_failing = _failing.pop(key, None) is not None
    if was_failing:
        logger.info("get_info.recovered", provider=provider, base_url=base_url)


def reset() -> None:
    with _lock:
        _failing.clear()
