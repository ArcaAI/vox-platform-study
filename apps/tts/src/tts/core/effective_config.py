"""Effective-config pull client (tts).

Structurally identical to `guardrail` / `harness` / `nlp` / `smr` / `stt`
against the same frozen contract, exposing the ONLY subset tts consumes:
`retention.ttlSeconds` for the local engines' weight caches (Kokoro,
IndicParler, IndicF5). The cloud providers (Azure, Sarvam) hold no weights and
expose no retention seam, so they are skipped.

THE NAMESPACE TRAP (§3.4) — the gateway registers this service as `tts` but
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


async def refresh_model_cache_retention(app_state: Any) -> None:
    """Pull control-plane retention and apply it to every LIVE local provider.

    §3.2 — `configure_retention` reaches the provider's ALREADY-CONSTRUCTED
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

    try:
        snapshot = await client.get()
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
