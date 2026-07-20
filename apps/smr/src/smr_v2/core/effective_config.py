"""TASK-525 §3.3 — effective-config pull client (smr).

Pulls this service's SERVICE-LEVEL knobs from the gateway
(`GET /api/v1/internal/effective-config?service=smr`) instead of taking them from
env. Model/provider SELECTION is unaffected — SMR remains a stateless gateway and
still receives `{provider, model}` per request (see `core/config.py`).

Mechanics are the guardrail `TenantConfigResolver`'s, over HTTP instead of SQL:

  * TTL cache (60 s default), **jittered ±10 %** per process so a gateway restart
    does not synchronise every service's refresh into a thundering herd.
  * **Negative cache** — the load-bearing fail-safe. A fetch error caches the
    EMPTY result for a full window, so an unreachable gateway costs at most one
    attempt per window, not one per request. Callers then fall back to env, which
    means "gateway down" behaves exactly like today's env-driven service.
  * **Single-flight** refresh: concurrent expirers collapse into one HTTP call.
  * Refresh is **read-triggered**, not a background task — no extra lifecycle to
    manage, and a service that never reads never polls.

This module is deliberately duplicated per service rather than shared; factoring
it into a common package is TASK-529's OD-3 and must not be preempted here.
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

#: Provider-default rows carry service-level capacity; model-specific rows do not.
_PROVIDER_DEFAULT_SLUG = ""


@dataclass(frozen=True)
class EffectiveConfigSnapshot:
    """One resolved (or negative-cached) view of this service's config subset."""

    raw: dict[str, Any] = field(default_factory=dict)
    #: False ⇒ the fetch failed and this is the negative-cached empty result.
    ok: bool = False
    fetched_at: datetime | None = None

    @property
    def runtime_profiles(self) -> list[dict[str, Any]]:
        profiles = self.raw.get("runtimeProfiles") or []
        return profiles if isinstance(profiles, list) else []

    def provider_limits(self) -> dict[str, dict[str, int]]:
        """Per-provider service-level limits, omitting anything without an opinion.

        A provider absent from this mapping (or missing a key within it) keeps its
        env/pydantic value — never coerce a `None` into a real limit.
        """
        limits: dict[str, dict[str, int]] = {}
        for profile in self.runtime_profiles:
            if not isinstance(profile, dict):
                continue
            if profile.get("modelSlug") != _PROVIDER_DEFAULT_SLUG:
                continue

            provider = profile.get("provider")
            if not isinstance(provider, str) or not provider:
                continue

            entry: dict[str, int] = {}
            max_concurrent = _positive_int(profile.get("maxConcurrent"))
            if max_concurrent is not None:
                entry["max_concurrent"] = max_concurrent
            timeout_s = _positive_int(profile.get("timeoutS"))
            if timeout_s is not None:
                entry["timeout_s"] = timeout_s

            if entry:
                limits[provider] = entry
        return limits


def _positive_int(value: Any) -> int | None:
    """Coerce a served number to a positive int, or None to keep the env value."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    coerced = int(value)
    return coerced if coerced > 0 else None


class EffectiveConfigClient:
    """Read-triggered, TTL-cached, fail-safe reader of this service's config."""

    def __init__(
        self,
        base_url: str,
        token: str,
        service: str = "smr",
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
        # Injected for hermetic tests; monotonic in production so a wall-clock
        # step can never expire (or freeze) the cache.
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
            # Re-check: a concurrent caller may have refreshed while we queued.
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
        """The `/health` block (§3.7).

        Health is auth-exempt, so this reports SOURCE LABELS and timestamps only
        — never a resolved value.
        """
        return {
            "last_refresh_at": self._last_refresh_at.isoformat() if self._last_refresh_at else None,
            "last_refresh_ok": self._last_refresh_ok,
            "ttl_seconds": self._ttl_s,
            "sources": self._sources(),
        }

    def _sources(self) -> dict[str, str]:
        raw = self._snapshot.raw
        sources: dict[str, str] = {}
        for group in ("runtimeProfiles", "retention", "concurrency"):
            value = raw.get(group)
            if isinstance(value, dict) and isinstance(value.get("source"), str):
                sources[group] = value["source"]
            elif isinstance(value, list) and value:
                first = value[0]
                if isinstance(first, dict) and isinstance(first.get("source"), str):
                    sources[group] = first["source"]
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
                response = await client.get("/internal/effective-config", params={"service": self._service})
                response.raise_for_status()
                payload = response.json()

            if not isinstance(payload, dict):
                raise ValueError(f"expected a JSON object, got {type(payload).__name__}")

            self._last_refresh_ok = True
            self._last_refresh_at = datetime.now(UTC)
            return EffectiveConfigSnapshot(raw=payload, ok=True, fetched_at=self._last_refresh_at)

        except Exception as exc:  # noqa: BLE001 — degradation must be total
            # Logged ONCE per TTL window (the caller only reaches here on expiry),
            # so a persistently-down gateway cannot flood the logs either.
            logger.warning(
                "smr_v2.effective_config.fetch_error",
                service=self._service,
                error=str(exc),
                error_type=type(exc).__name__,
            )
            self._last_refresh_ok = False
            self._last_refresh_at = datetime.now(UTC)
            # The EMPTY result is cached for a full window — callers fall back to
            # env, so the service behaves exactly as it does without a gateway.
            return EffectiveConfigSnapshot(raw={}, ok=False, fetched_at=self._last_refresh_at)
