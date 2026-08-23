"""Effective-config pull client (tts).

Structurally identical to `guardrail` / `harness` / `nlp` / `text` / `stt`
against the same frozen contract, exposing the ONLY subset tts consumes:
`retention.ttlSeconds` for the local engines' weight caches (Kokoro,
IndicParler, IndicF5). The cloud providers (Azure, Sarvam) hold no weights and
expose no retention seam, so they are skipped.

THE NAMESPACE TRAP — the gateway registers this service as `tts` but
resolves its keys under the `tts` prefix (`effective-config.service.ts:116`:
`case 'tts': return { ...base, retention: await this.resolveRetention('tts') }`).
So the client MUST send `service=tts` (sending `tts` is rejected by
`InternalServiceTokenGuard`) and MUST read a flat `retention` group (there are
no `tts.modelCache.*` keys in the body). Getting either side wrong is a
silent no-op — pinned by `test_service_param_and_key_namespace`.

Mechanics: TTL cache jittered ±10 %, negative cache, single-flight refresh,
read-triggered — a service that never synthesizes never polls. Duplicated per
service on purpose.
"""

from __future__ import annotations

import asyncio
import json
import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
import structlog

logger = structlog.get_logger(__name__)

#: The name the gateway's `InternalServiceTokenGuard` registers for this service.
#: NOT the `tts` key prefix its settings resolve under — see the module docstring.
SERVICE_NAME = "tts"

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


@dataclass(frozen=True)
class EffectiveConfigSnapshot:
    """One resolved (or negative-cached) view of tts's config subset."""

    raw: dict[str, Any] = field(default_factory=dict)
    #: False ⇒ the fetch failed and this is the negative-cached empty result.
    ok: bool = False
    fetched_at: datetime | None = None

    def retention(self) -> dict[str, int]:
        """Model-cache retention knobs with an opinion.

        tts's providers bound ONE pipeline each, so `maxModels` is meaningless
        here and only `ttlSeconds` is consumed. An omitted key means "keep the
        env/bootstrap value"; a null or non-positive value is never coerced into
        a real number.
        """
        group = self.raw.get("retention")
        if not isinstance(group, dict):
            return {}

        ttl_seconds = _positive_int(group.get("ttlSeconds"))
        return {} if ttl_seconds is None else {"ttl_seconds": ttl_seconds}


def _positive_int(value: Any) -> int | None:
    # `bool` is an `int` subclass — exclude it, or `True` would become 1.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    coerced = int(value)
    return coerced if coerced > 0 else None


class EffectiveConfigClient:
    """Read-triggered, TTL-cached, fail-safe reader of tts's config subset."""

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

        logger.info("tts.effective_config.invalidated", service=self._service, key=key)
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
            logger.warning("tts.effective_config.invalidation_unavailable", error=str(exc))
            return

        try:
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                self.handle_invalidation_message(message.get("data"))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — never take the service down
            logger.warning("tts.effective_config.invalidation_stopped", error=str(exc))
        finally:
            try:
                await pubsub.aclose()
            except Exception:  # noqa: BLE001
                pass

    def diagnostics(self) -> dict[str, Any]:
        """Source labels and timestamps only — never values."""
        return {
            "last_refresh_at": self._last_refresh_at.isoformat() if self._last_refresh_at else None,
            "last_refresh_ok": self._last_refresh_ok,
            "ttl_seconds": self._ttl_s,
            "sources": self._sources(),
        }

    def _sources(self) -> dict[str, str]:
        sources: dict[str, str] = {}
        value = self._snapshot.raw.get("retention")
        if isinstance(value, dict) and isinstance(value.get("source"), str):
            sources["retention"] = value["source"]
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
                "tts.effective_config.fetch_error",
                service=self._service,
                error=str(exc),
                error_type=type(exc).__name__,
            )
            self._last_refresh_ok = False
            self._last_refresh_at = datetime.now(UTC)
            # Empty result cached for a full window ⇒ callers keep env values.
            return EffectiveConfigSnapshot(raw={}, ok=False, fetched_at=self._last_refresh_at)


def ensure_invalidation_listener(app_state: Any) -> None:
    """Start the ``arca:config:invalidate`` subscriber once, lazily.

    Owner decision D-5 approved giving tts a Redis client so a control-plane
    write reaches it by PUSH rather than only by 60s poll — rule 09: invalidation
    is the propagation path, the TTL is a bounded-staleness backstop.

    Started here rather than in ``lifespan`` for a specific reason:
    ``test_keyless_readiness_task642`` pins that reaching ``/health/ready`` opens
    ZERO network connections, because a keyless deployment must become Ready with
    no I/O at all. Connecting to Redis at boot breaks that outright. Deferring to
    the first config refresh — i.e. the first synthesis — also preserves the
    existing "a service that never synthesizes never polls" property, while any
    process that actually serves traffic gets push invalidation on request one.

    NEVER raises. Every failure leaves the TTL as the only propagation path,
    which is exactly the pre-D-5 behaviour: a process that starts (or first
    synthesizes) while Redis is down must still work, and must still converge.
    """
    if getattr(app_state, "config_invalidation_task", None) is not None:
        return
    client = getattr(app_state, "effective_config_client", None)
    if client is None:
        return
    settings = getattr(app_state, "settings", None)
    if settings is None:
        return

    try:
        import redis.asyncio as redis_asyncio

        # Bounded and non-retrying ON PURPOSE. This connection exists only to
        # receive invalidation messages and the TTL covers everything it does,
        # so a Redis that is slow or absent must surface as a fast, logged
        # degradation — never as a synthesis request waiting on a subscribe.
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
        logger.warning("tts.config_invalidation_unavailable", error=str(exc))


async def refresh_model_cache_retention(app_state: Any) -> None:
    """Pull control-plane retention and apply it to every LIVE local provider.

    `configure_retention` reaches the provider's ALREADY-CONSTRUCTED
    cache, so a resident pipeline adopts the new TTL without being dropped.
    Applying retention only at provider construction would leave the admin knob
    dead for every running process.

    NEVER raises: a synthesis request must not fail because the config plane is
    unavailable. No client, or no opinion from the control plane, ⇒ the env
    value stays in force — exactly the env-only behaviour.
    """
    client = getattr(app_state, "effective_config_client", None)
    if client is None:
        return

    # First refresh also arms push invalidation (see the docstring there for why
    # it cannot happen at boot). Idempotent and non-blocking.
    ensure_invalidation_listener(app_state)

    try:
        snapshot = await client.get()

        # Same snapshot, second consumer (TASK-799 lane C): the ~29 registry
        # keys that ARE settings fields — provider endpoints, timeouts,
        # concurrency, local-engine model ids and the synthesis limits. Applied
        # on this READ-TRIGGERED path rather than at boot because that is what
        # runs after the invalidation listener drops the cache, so a
        # control-plane write converges within one request instead of waiting
        # for a restart — and because this service's boot contract is that
        # construction performs no I/O.
        settings = getattr(app_state, "settings", None)
        if settings is not None:
            from tts.core.control_plane import apply_control_plane

            apply_control_plane(settings, snapshot.raw)

        retention = snapshot.retention()
        if not retention:
            return

        registry = app_state.provider_registry
        for name in registry.list_providers():
            # Cloud providers (Azure, Sarvam) hold no weights and no seam.
            configure = getattr(registry.get(name), "configure_retention", None)
            if configure is not None:
                configure(retention)
    except Exception as exc:  # noqa: BLE001 — a config refresh may never break synthesis
        logger.warning(
            "tts.effective_config.apply_error",
            error=str(exc),
            error_type=type(exc).__name__,
        )
