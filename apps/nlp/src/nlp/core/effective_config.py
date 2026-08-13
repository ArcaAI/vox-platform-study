"""Effective-config pull client (nlp).

Mirrors `smr.core.effective_config` against the same frozen contract, exposing
the subset nlp consumes: `concurrency.maxConcurrent` for the inference bound.
Model IDENTITY is untouched — it remains gateway-injected per request and
structurally env-unreachable (`core/config.py` `_MODEL_IDENTITY_FIELDS`).

Mechanics: TTL cache jittered ±10 %, negative cache (a down gateway costs at most
one attempt per window, then callers keep their env values), single-flight
refresh, read-triggered. Duplicated per service on purpose — the shared-package
question is settled and not reopened here.
"""

from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
import structlog

logger = structlog.get_logger(__name__)

DEFAULT_TTL_S = 60
DEFAULT_TIMEOUT_S = 5.0
_JITTER_FRACTION = 0.10


@dataclass(frozen=True)
class EffectiveConfigSnapshot:
    """One resolved (or negative-cached) view of nlp's config subset."""

    raw: dict[str, Any] = field(default_factory=dict)
    #: False ⇒ the fetch failed and this is the negative-cached empty result.
    ok: bool = False
    fetched_at: datetime | None = None

    def max_concurrent(self) -> int | None:
        """The served inference bound, or None to keep the env/bootstrap value.

        None covers every "no opinion" case: fetch failed, group absent, field
        null, or a nonsensical value — a bad control-plane value must never be
        coerced into a real bound.
        """
        concurrency = self.raw.get("concurrency")
        if not isinstance(concurrency, dict):
            return None
        return _positive_int(concurrency.get("maxConcurrent"))

    def retention(self) -> dict[str, int]:
        """Model-cache retention knobs with an opinion.

        An omitted key means "keep the env/bootstrap value"; a null or
        non-positive value is never coerced into a real number.
        """
        group = self.raw.get("retention")
        if not isinstance(group, dict):
            return {}

        mapping = {
            "ttl_seconds": group.get("ttlSeconds"),
            "max_models": group.get("maxModels"),
        }
        return {
            key: value for key, raw in mapping.items() if (value := _positive_int(raw)) is not None
        }


def _positive_int(value: Any) -> int | None:
    # `bool` is an `int` subclass — exclude it, or `True` would become 1.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    coerced = int(value)
    return coerced if coerced > 0 else None


class EffectiveConfigClient:
    """Read-triggered, TTL-cached, fail-safe reader of nlp's config subset."""

    def __init__(
        self,
        base_url: str,
        token: str,
        service: str = "nlp",
        *,
        ttl_s: int = DEFAULT_TTL_S,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        transport: httpx.AsyncBaseTransport | None = None,
        time_func: Callable[[], float] | None = None,
        header_name: str = "X-Service-Token",
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._service = service
        self._ttl_s = ttl_s
        self._timeout_s = timeout_s
        self._transport = transport
        self._time = time_func or time.monotonic
        self._header_name = header_name

        self._snapshot = EffectiveConfigSnapshot()
        self._expires_at: float | None = None
        self._lock = asyncio.Lock()
        self._last_refresh_ok: bool | None = None
        self._last_refresh_at: datetime | None = None

    async def get(self) -> EffectiveConfigSnapshot:
        """Return the cached snapshot, refreshing it if the window has elapsed."""
        if not self._expired():
            return self._snapshot

        async with self._lock:
            if not self._expired():
                return self._snapshot
            self._snapshot = await self._refresh()
            self._expires_at = self._time() + self._next_window()
            return self._snapshot

    def clear_cache(self) -> None:
        """Drop the cached snapshot so the next read refetches (tests/admin)."""
        self._snapshot = EffectiveConfigSnapshot()
        self._expires_at = None

    def diagnostics(self) -> dict[str, Any]:
        """The `/health` block — source labels and timestamps only."""
        return {
            "last_refresh_at": self._last_refresh_at.isoformat() if self._last_refresh_at else None,
            "last_refresh_ok": self._last_refresh_ok,
            "ttl_seconds": self._ttl_s,
            "sources": self._sources(),
        }

    def _sources(self) -> dict[str, str]:
        sources: dict[str, str] = {}
        for group in ("concurrency", "retention"):
            value = self._snapshot.raw.get(group)
            if isinstance(value, dict) and isinstance(value.get("source"), str):
                sources[group] = value["source"]
        return sources

    def _expired(self) -> bool:
        return self._expires_at is None or self._time() >= self._expires_at

    def _next_window(self) -> float:
        """The TTL with ±10 % jitter applied (thundering-herd mitigation)."""
        jitter = self._ttl_s * _JITTER_FRACTION
        return self._ttl_s + random.uniform(-jitter, jitter)  # noqa: S311 — not cryptographic

    async def _refresh(self) -> EffectiveConfigSnapshot:
        """One bounded fetch. NEVER raises — a failure negative-caches instead."""
        try:
            async with httpx.AsyncClient(
                base_url=self._base_url,
                timeout=self._timeout_s,
                transport=self._transport,
                headers={self._header_name: self._token},
            ) as client:
                response = await client.get(
                    "/internal/effective-config", params={"service": self._service}
                )
                response.raise_for_status()
                payload = response.json()

            if not isinstance(payload, dict):
                raise ValueError(f"expected a JSON object, got {type(payload).__name__}")

            self._last_refresh_ok = True
            self._last_refresh_at = datetime.now(UTC)
            return EffectiveConfigSnapshot(raw=payload, ok=True, fetched_at=self._last_refresh_at)

        except Exception as exc:  # noqa: BLE001 — degradation must be total
            logger.warning(
                "nlp.effective_config.fetch_error",
                service=self._service,
                error=str(exc),
                error_type=type(exc).__name__,
            )
            self._last_refresh_ok = False
            self._last_refresh_at = datetime.now(UTC)
            # Empty result cached for a full window ⇒ callers keep env values.
            return EffectiveConfigSnapshot(raw={}, ok=False, fetched_at=self._last_refresh_at)
