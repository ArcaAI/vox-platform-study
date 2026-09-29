"""Effective-config pull client (asr-vllm) — TASK-1010 OD-6.

Copied from ``apps/tts/src/tts/core/effective_config.py`` against the same frozen
contract (``GET /internal/effective-config?service=<name>``, ``X-Service-Token``): TTL
cache jittered ±10 %, negative cache, single-flight refresh, and the shared
``arca:config:invalidate`` push channel. Duplicated per service on purpose.

This service consumes only the generic ``settings`` map — the six ``asrVllm.*`` keys —
overlaid onto ``Settings`` by :func:`asr_vllm.core.control_plane.apply_control_plane`.
The gateway registers the service as ``asr-vllm`` (``CONSUMING_DEPLOYABLES``) and its
``InternalServiceTokenGuard`` maps that name to the shared ``INTERNAL_ACCESS_TOKEN``.

ONE DELIBERATE DIFFERENCE FROM TTS — the request path never WAITS for a pull. tts
awaits the refresh inline before each synthesis. Here that would put the pull's timeout
(5 s) on every decode window that lands while a refresh is in flight — up to ~20 windows
a minute at 25 streams, straight onto commit p99. So:

* a BUILD awaits :func:`refresh_control_plane` (``EnginePool(before_build=…)``) — a build
  takes seconds anyway, and the engine knobs are read right after;
* a REQUEST calls :func:`schedule_control_plane_refresh`, which starts a background
  refresh when the snapshot is stale and returns at once; the window runs on the values
  already in force (bounded staleness: one TTL, or one invalidation message).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
from hope_obs import get_logger

from asr_vllm.core.control_plane import apply_control_plane

logger = get_logger(__name__)

#: The name the gateway's ``InternalServiceTokenGuard`` and ``CONSUMING_DEPLOYABLES``
#: register for this service.
SERVICE_NAME = "asr-vllm"

DEFAULT_TTL_S = 60

#: The ONE pub/sub channel every Python pull client listens on. Mirrors
#: ``PYTHON_CONFIG_INVALIDATION_CHANNEL`` in the gateway's settings-registry write service.
CONFIG_INVALIDATION_CHANNEL = "arca:config:invalidate"
DEFAULT_TIMEOUT_S = 5.0
_JITTER_FRACTION = 0.10


@dataclass(frozen=True)
class EffectiveConfigSnapshot:
    """One resolved (or negative-cached) view of this service's config subset."""

    raw: dict[str, Any] = field(default_factory=dict)
    #: False ⇒ the fetch failed and this is the negative-cached empty result.
    ok: bool = False
    fetched_at: datetime | None = None


class EffectiveConfigClient:
    """Read-triggered, TTL-cached, fail-safe reader of this service's config subset."""

    def __init__(
        self,
        base_url: str,
        token: str,
        service: str = SERVICE_NAME,
        *,
        ttl_s: int = DEFAULT_TTL_S,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        transport: httpx.AsyncBaseTransport | None = None,
        time_func: Callable[[], float] | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
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

    async def get(self) -> EffectiveConfigSnapshot:
        """Return the cached snapshot, refreshing it if the window has elapsed."""
        if not self.is_stale():
            return self._snapshot

        async with self._lock:
            if not self.is_stale():
                return self._snapshot
            self._snapshot = await self._refresh()
            self._expires_at = self._time() + self._next_window()
            return self._snapshot

    def is_stale(self) -> bool:
        """True when the next :meth:`get` would fetch (never fetched, expired, or evicted)."""
        return self._expires_at is None or self._time() >= self._expires_at

    def clear_cache(self) -> None:
        """Drop the cached snapshot so the next read refetches."""
        self._snapshot = EffectiveConfigSnapshot()
        self._expires_at = None

    def handle_invalidation_message(self, payload: Any) -> bool:
        """Drop the cached snapshot in response to ONE pub/sub message.

        Deliberately UNFILTERED (the tts reasoning): one snapshot covers every key this
        service consumes, and which keys those are is declared once, on the gateway's
        ``SettingDescriptor.consumedBy``. An UNPARSEABLE payload still evicts. Never
        raises: a malformed message must not kill the listener task.
        """
        self.clear_cache()

        key: str | None = None
        try:
            text = (
                payload.decode("utf-8", errors="replace")
                if isinstance(payload, bytes | bytearray)
                else payload
            )
            if isinstance(text, str):
                parsed = json.loads(text)
                if isinstance(parsed, dict) and isinstance(parsed.get("key"), str):
                    key = parsed["key"]
        except Exception:  # noqa: BLE001 — the eviction already happened
            key = None

        logger.info("asr_vllm.effective_config.invalidated", service=self._service, key=key)
        return True

    async def run_invalidation_listener(self, redis: Any) -> None:
        """Subscribe to the invalidation channel and evict on every message.

        Runs until cancelled. Every failure mode EXCEPT cancellation degrades to the TTL
        backstop instead of taking the service down.
        """
        try:
            pubsub = redis.pubsub()
            await pubsub.subscribe(CONFIG_INVALIDATION_CHANNEL)
        except Exception as exc:  # noqa: BLE001 — propagation degrades to the TTL
            logger.warning("asr_vllm.effective_config.invalidation_unavailable", error=str(exc))
            return

        try:
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                self.handle_invalidation_message(message.get("data"))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — never take the service down
            logger.warning("asr_vllm.effective_config.invalidation_stopped", error=str(exc))
        finally:
            try:
                await pubsub.aclose()
            except Exception:  # noqa: BLE001
                pass

    def diagnostics(self) -> dict[str, Any]:
        """Timestamps and outcome only — never values."""
        return {
            "last_refresh_at": self._last_refresh_at.isoformat() if self._last_refresh_at else None,
            "last_refresh_ok": self._last_refresh_ok,
            "ttl_seconds": self._ttl_s,
        }

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
                headers={"X-Service-Token": self._token},
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
            # Open-to-default (every asrVllm.* descriptor is `failMode: 'open-to-default'`):
            # the values already in force keep serving for a full window.
            logger.warning(
                "asr_vllm.effective_config.fetch_error",
                service=self._service,
                error=str(exc),
                error_type=type(exc).__name__,
            )
            self._last_refresh_ok = False
            self._last_refresh_at = datetime.now(UTC)
            return EffectiveConfigSnapshot(raw={}, ok=False, fetched_at=self._last_refresh_at)


def ensure_invalidation_listener(app_state: Any) -> None:
    """Start the ``arca:config:invalidate`` subscriber once, lazily (the tts shape).

    Started on the first refresh rather than at boot, so building the app opens no
    connection and a replica that never serves never subscribes. NEVER raises: no
    ``REDIS_URL``, no ``redis`` package, or an unreachable Redis all leave the TTL as the
    only propagation path.
    """
    if getattr(app_state, "config_invalidation_task", None) is not None:
        return
    client = getattr(app_state, "effective_config_client", None)
    settings = getattr(app_state, "settings", None)
    if client is None or settings is None or not str(settings.redis_url).strip():
        return

    try:
        import redis.asyncio as redis_asyncio

        # Bounded and non-retrying ON PURPOSE: this connection only receives
        # invalidations and the TTL covers everything it does.
        invalidation_redis = redis_asyncio.from_url(
            settings.redis_url,
            socket_connect_timeout=2.0,
            socket_timeout=5.0,
            retry_on_timeout=False,
        )
        app_state.config_invalidation_redis = invalidation_redis
        app_state.config_invalidation_task = asyncio.create_task(
            client.run_invalidation_listener(invalidation_redis)
        )
    except Exception as exc:  # noqa: BLE001 — the TTL remains the backstop
        logger.warning("asr_vllm.config_invalidation_unavailable", error=str(exc))


async def refresh_control_plane(app_state: Any) -> None:
    """Pull the control plane (TTL-cached) and overlay it onto ``app_state.settings``.

    Awaited before every engine BUILD. NEVER raises: no client (no gateway configured),
    an unreachable gateway, or a malformed payload all leave the values in force.
    """
    client = getattr(app_state, "effective_config_client", None)
    settings = getattr(app_state, "settings", None)
    if client is None or settings is None:
        return
    ensure_invalidation_listener(app_state)
    try:
        snapshot = await client.get()
        apply_control_plane(settings, snapshot.raw)
    except Exception as exc:  # noqa: BLE001 — a config refresh may never break a decode
        logger.warning(
            "asr_vllm.effective_config.apply_error",
            error=str(exc),
            error_type=type(exc).__name__,
        )


def schedule_control_plane_refresh(app_state: Any) -> None:
    """The REQUEST path: start a background refresh if stale; never wait for it."""
    client = getattr(app_state, "effective_config_client", None)
    if client is None or not client.is_stale():
        return
    running = getattr(app_state, "control_plane_refresh", None)
    if running is not None and not running.done():
        return
    app_state.control_plane_refresh = asyncio.create_task(refresh_control_plane(app_state))


async def close_control_plane(app_state: Any) -> None:
    """Lifespan teardown: stop the listener and any in-flight refresh; close Redis."""
    for name in ("config_invalidation_task", "control_plane_refresh"):
        task = getattr(app_state, name, None)
        if task is not None and not task.done():
            task.cancel()
            # Both awaited tasks log their own failures; only their cancellation is expected.
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        setattr(app_state, name, None)
    redis = getattr(app_state, "config_invalidation_redis", None)
    if redis is not None:
        try:
            await redis.aclose()
        except Exception:  # noqa: BLE001
            pass
        app_state.config_invalidation_redis = None
