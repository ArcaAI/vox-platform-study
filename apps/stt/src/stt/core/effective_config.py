"""Effective-config pull client (stt).

Replaces the dead `GlobalSettingRead` SQLAlchemy path: the seed wrote
`stt.config.model_cache.*` / `stt.config.workers.*` rows that nothing ever read.
Those knobs now arrive over HTTP from the gateway's effective-config route.

stt already had the gateway transport (`api_gateway_url` / `api_gateway_key`,
`core/api_client/gateway.py`), so this client REUSES it and authenticates with
the existing `X-Internal-Service-Key` header — the gateway guard accepts that
header for `service=stt` specifically, so no second credential is minted and
no new env var is introduced for this service.

Mechanics match the text/nlp mirrors: TTL cache jittered ±10 %, negative cache,
single-flight refresh, read-triggered. Duplicated per service on purpose — a
shared package for this logic remains an open question.
"""

from __future__ import annotations

import asyncio
import json
import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, cast

import httpx
import structlog

from stt.core.loop_local import get_loop_local, reset_loop_locals

logger = structlog.get_logger(__name__)

DEFAULT_TTL_S = 60

#: The generalised Redis pub/sub channel the gateway publishes config
#: invalidation on. Mirrors ``PYTHON_CONFIG_INVALIDATION_CHANNEL`` in
#: ``packages/applications/src/services/settings-registry/settings-registry-write.service.ts``.
#:
#: ONE channel for every Python pull client, not one per service: the publisher
#: would otherwise need a second copy of ``SettingDescriptor.consumedBy`` to
#: decide who to tell, and a drifting literal is exactly what left
#: ``arca:guardrail-config:invalidate`` subscribed-but-never-published (RC-6).
CONFIG_INVALIDATION_CHANNEL = "arca:config:invalidate"
DEFAULT_TIMEOUT_S = 5.0
_JITTER_FRACTION = 0.10


def _positive_int(value: Any) -> int | None:
    """Coerce a served number to a positive int, or None to keep the env value."""
    # `bool` is an `int` subclass — exclude it, or `True` would become 1.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    coerced = int(value)
    return coerced if coerced > 0 else None


@dataclass(frozen=True)
class EffectiveConfigSnapshot:
    """One resolved (or negative-cached) view of stt's config subset."""

    raw: dict[str, Any] = field(default_factory=dict)
    #: False ⇒ the fetch failed and this is the negative-cached empty result.
    ok: bool = False
    fetched_at: datetime | None = None

    def retention(self) -> dict[str, int]:
        """Model-cache retention knobs, omitting anything without an opinion.

        An omitted key means "keep the env/bootstrap value" — a null is never
        coerced into a real number.
        """
        group = self.raw.get("retention")
        if not isinstance(group, dict):
            return {}

        mapping = {
            "ttl_seconds": group.get("ttlSeconds"),
            "max_models": group.get("maxModels"),
            "max_memory_mb": group.get("maxMemoryMb"),
        }
        return {
            key: value for key, raw in mapping.items() if (value := _positive_int(raw)) is not None
        }

    def worker_concurrency(self) -> int | None:
        """Dramatiq worker-thread ceiling, or None to keep the env value."""
        return self._concurrency("workerConcurrency")

    def streaming_max_concurrent(self) -> int | None:
        """Concurrent-streaming-session ceiling, or None to keep the env value."""
        return self._concurrency("streamingMaxConcurrent")

    def _concurrency(self, key: str) -> int | None:
        group = self.raw.get("concurrency")
        if not isinstance(group, dict):
            return None
        return _positive_int(group.get(key))


class EffectiveConfigClient:
    """Read-triggered, TTL-cached, fail-safe reader of stt's config subset."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        service: str = "stt",
        *,
        ttl_s: int = DEFAULT_TTL_S,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        transport: httpx.AsyncBaseTransport | None = None,
        time_func: Callable[[], float] | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._service = service
        self._ttl_s = ttl_s
        self._timeout_s = timeout_s
        self._transport = transport
        self._time = time_func or time.monotonic

        self._snapshot = EffectiveConfigSnapshot()
        self._expires_at: float | None = None
        self._lock = asyncio.Lock()
        self._last_refresh_ok: bool | None = None
        self._last_refresh_at: datetime | None = None

        # Per-tenant BYO STT provider overrides (batch-worker pull
        # path). Cached per tenant with the same TTL/jitter window;
        # single-flight per tenant; fail-open (a failed pull yields {} so the
        # worker falls back to env creds). Keyed by tenant so one tenant's key is
        # never served to another.
        self._overrides_cache: dict[str, tuple[dict[str, Any], float]] = {}
        self._overrides_locks: dict[str, asyncio.Lock] = {}

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

    async def get_provider_overrides(self, tenant_id: str) -> dict[str, Any]:
        """Pull a tenant's decrypted BYO STT provider overrides (batch pull).

        Hits ``GET /internal/stt/provider-overrides?tenantId=`` on the gateway
        (service-token auth, same transport as :meth:`get`). Cached per tenant
        for the TTL window, single-flight per tenant. FAIL-OPEN: any error yields
        ``{}`` so the worker degrades to env credentials — a broken BYO key never
        blocks transcription. The decrypted map is held in memory only.
        """
        if not tenant_id:
            return {}
        cached = self._overrides_cache.get(tenant_id)
        if cached is not None and self._time() < cached[1]:
            return cached[0]

        lock = self._overrides_locks.setdefault(tenant_id, asyncio.Lock())
        async with lock:
            cached = self._overrides_cache.get(tenant_id)
            if cached is not None and self._time() < cached[1]:
                return cached[0]
            overrides = await self._fetch_provider_overrides(tenant_id)
            self._overrides_cache[tenant_id] = (overrides, self._time() + self._next_window())
            return overrides

    async def _fetch_provider_overrides(self, tenant_id: str) -> dict[str, Any]:
        """One bounded fetch of a tenant's overrides. NEVER raises (fail-open)."""
        try:
            async with httpx.AsyncClient(
                base_url=self._base_url,
                timeout=self._timeout_s,
                transport=self._transport,
                headers={"X-Internal-Service-Key": self._api_key},
            ) as client:
                response = await client.get(
                    "/internal/stt/provider-overrides", params={"tenantId": tenant_id}
                )
                response.raise_for_status()
                payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError(f"expected a JSON object, got {type(payload).__name__}")
            return payload
        except Exception as exc:  # noqa: BLE001 — fail-open, worker uses env creds
            logger.warning(
                "stt.effective_config.provider_overrides_error",
                error=str(exc),
                error_type=type(exc).__name__,
            )
            return {}

    def clear_cache(self) -> None:
        """Drop the cached snapshot so the next read refetches (tests/admin)."""
        self._snapshot = EffectiveConfigSnapshot()
        self._expires_at = None
        self._overrides_cache.clear()

    def handle_invalidation_message(self, payload: Any) -> bool:
        """Drop the cached snapshot in response to ONE pub/sub message.

        Rule 09 §"Config caches": *invalidation is the propagation path; the TTL
        is a bounded-staleness safety net*. This method is that path — before it,
        this service converged on a control-plane write only by 60s poll, which
        removes the property that justifies moving a value out of env at all.

        Deliberately UNFILTERED. One snapshot covers every key this service
        consumes, and which keys those are is declared once, on the gateway's
        ``SettingDescriptor.consumedBy``; filtering here would need a second,
        drifting copy of that mapping. A registry write is rare and a refetch is
        one bounded HTTP call, so over-invalidation is the cheap side of the
        trade and a stale value held for a full TTL is the expensive one — which
        is also why an UNPARSEABLE payload still evicts.

        Never raises: a malformed message must not kill the listener task.
        Returns True when the cache was dropped.
        """
        self.clear_cache()

        key: str | None = None
        try:
            text = (
                payload.decode("utf-8", errors="replace")
                if isinstance(payload, (bytes, bytearray))
                else payload
            )
            if isinstance(text, str):
                parsed = json.loads(text)
                if isinstance(parsed, dict) and isinstance(parsed.get("key"), str):
                    key = parsed["key"]
        except Exception:  # noqa: BLE001 — the eviction already happened
            key = None

        logger.info("stt.effective_config.invalidated", service=self._service, key=key)
        return True

    async def run_invalidation_listener(self, redis: Any) -> None:
        """Subscribe to the invalidation channel and evict on every message.

        Runs until cancelled. Every failure mode EXCEPT cancellation degrades to
        the TTL backstop instead of taking the service down: a process that boots
        while Redis is unreachable must still start, and must still converge.
        """
        try:
            pubsub = redis.pubsub()
            await pubsub.subscribe(CONFIG_INVALIDATION_CHANNEL)
        except Exception as exc:  # noqa: BLE001 — propagation degrades to the TTL
            logger.warning("stt.effective_config.invalidation_unavailable", error=str(exc))
            return

        try:
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                self.handle_invalidation_message(message.get("data"))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — never take the service down
            logger.warning("stt.effective_config.invalidation_stopped", error=str(exc))
        finally:
            try:
                await pubsub.aclose()
            except Exception:  # noqa: BLE001
                pass

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
        for group in ("retention", "concurrency"):
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
                headers={"X-Internal-Service-Key": self._api_key},
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
                "stt.effective_config.fetch_error",
                service=self._service,
                error=str(exc),
                error_type=type(exc).__name__,
            )
            self._last_refresh_ok = False
            self._last_refresh_at = datetime.now(UTC)
            # Empty result cached for a full window ⇒ callers keep env values.
            return EffectiveConfigSnapshot(raw={}, ok=False, fetched_at=self._last_refresh_at)


_LOOP_LOCAL_NAMESPACE = "effective_config.client"


def get_effective_config_client() -> EffectiveConfigClient:
    """The client for the CURRENT event loop, built from the gateway settings.

    BUG-015: this was a process-wide module global, so its ``asyncio.Lock`` (and
    the per-tenant override locks) belonged to whichever loop first awaited them.
    The Dramatiq worker creates a loop per message, so later jobs awaited a lock
    owned by a closed loop — the worker log recorded it stuck as
    ``[unlocked, waiters:1] is bound to a different event loop``. Per-loop
    binding keeps the single-flight guarantee within a job, which is the scope it
    was ever meant to have.
    """
    from stt.core.config.settings import get_settings

    settings = get_settings()
    return cast(
        "EffectiveConfigClient",
        get_loop_local(
            _LOOP_LOCAL_NAMESPACE,
            lambda: EffectiveConfigClient(
                base_url=settings.api_gateway_url,
                api_key=settings.api_gateway_key.get_secret_value(),
            ),
        ),
    )


def reset_effective_config_client() -> None:
    """Drop the cached clients (tests only)."""
    reset_loop_locals(_LOOP_LOCAL_NAMESPACE)
