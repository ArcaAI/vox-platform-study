"""Effective-config pull client (harness).

Structurally identical to `guardrail` / `nlp` / `text` / `stt` against the
same frozen contract, exposing the ONLY subset harness consumes:
`retention.{ttlSeconds,maxModels}` for the MiniCheck entailer cache.

PROCESS PLACEMENT — the entailer is constructed inside a Temporal
ACTIVITY (`temporal/activities.py`), so its GGUF is resident in the WORKER
process, not the FastAPI app. This client is therefore driven from
`temporal/worker.py`, beside the model-cache sweep. A poll installed in the
app's lifespan would reconfigure a cache that holds nothing.

Mechanics: TTL cache jittered ±10 %, negative cache (a down gateway costs at
most one attempt per window, then callers keep their env values), single-flight
refresh. Duplicated per service on purpose — the shared-package question is a
settled, closed decision, not reopened here.
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
SERVICE_NAME = "harness"

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
    """One resolved (or negative-cached) view of harness's config subset."""

    raw: dict[str, Any] = field(default_factory=dict)
    #: False ⇒ the fetch failed and this is the negative-cached empty result.
    ok: bool = False
    fetched_at: datetime | None = None

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

    def setting(self, key: str) -> Any | None:
        """One registry key's resolved value, or `None` when it is UNRESOLVED.

        `None` is the whole contract: an absent `settings` block, an absent key, a stored
        `null`, or a malformed entry all read the same way — *the control plane has no
        opinion, keep the bootstrap value*. It is NEVER a stand-in for the descriptor's
        default, because a client that cannot tell "no opinion" from "the default" cannot
        implement a fail-closed key at all.

        The wire shape is `{value, dataType, source}` per key
        (`EffectiveConfigResponse.settings`). `dataType` is deliberately NOT re-validated
        here: the gateway already refuses a value that does not match its DECLARED type
        (`matchesDataType` in `effective-config.service.ts`), and a second, drifting copy
        of that table is what this contract exists to avoid. Callers apply their own
        RANGE contract instead — see `resolve_sensor_thresholds`.
        """
        group = self.raw.get("settings")
        if not isinstance(group, dict):
            return None
        entry = group.get(key)
        if not isinstance(entry, dict):
            return None
        return entry.get("value")

    def model_weights(self) -> dict[str, dict[str, Any]]:
        """Model slug → where that model's weights come from (F-16).

        The gateway serves `modelWeights[<slug>] = {sourceUri, localPath,
        checksum}` for the models this service's `AiTaskDefault` rows select.
        `models/source_resolver.py` was coded against this block before it
        existed on either side of the wire; this accessor is the Python half.

        An ABSENT or malformed block reads as `{}` — "the control plane has no
        opinion, keep the bootstrap env path" — never as "no weights exist".
        Individual non-object entries are dropped for the same reason; the
        resolver must not be handed something it would treat as a weight.

        The `sourceUri` GRAMMAR (`hf:` / `file://` / `s3://`) is deliberately not
        interpreted here — `resolve_model_dir` owns that dispatch, and a second
        copy would drift.
        """
        group = self.raw.get("modelWeights")
        if not isinstance(group, dict):
            return {}
        return {
            slug: entry
            for slug, entry in group.items()
            if isinstance(slug, str) and isinstance(entry, dict)
        }


def _positive_int(value: Any) -> int | None:
    # `bool` is an `int` subclass — exclude it, or `True` would become 1.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    coerced = int(value)
    return coerced if coerced > 0 else None


class EffectiveConfigClient:
    """Read-triggered, TTL-cached, fail-safe reader of harness's config subset."""

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

        logger.info("harness.effective_config.invalidated", service=self._service, key=key)
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
            logger.warning("harness.effective_config.invalidation_unavailable", error=str(exc))
            return

        try:
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                self.handle_invalidation_message(message.get("data"))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — never take the service down
            logger.warning("harness.effective_config.invalidation_stopped", error=str(exc))
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
                "harness.effective_config.fetch_error",
                service=self._service,
                error=str(exc),
                error_type=type(exc).__name__,
            )
            self._last_refresh_ok = False
            self._last_refresh_at = datetime.now(UTC)
            # Empty result cached for a full window ⇒ callers keep env values.
            return EffectiveConfigSnapshot(raw={}, ok=False, fetched_at=self._last_refresh_at)


#: The ONE client per process. Populated by `get_effective_config_client`.
_CLIENT: EffectiveConfigClient | None = None


def get_effective_config_client() -> EffectiveConfigClient:
    """The process-wide client — one TTL cache, one invalidation target.

    A singleton is load-bearing, not a convenience. Every consumer must share ONE
    instance or the cache and the push-invalidation path come apart: the worker's
    invalidation listener (`temporal/worker.py`) evicts the instance it was handed, so a
    second instance built by an activity would keep serving a stale snapshot for a full
    TTL after a control-plane write — which is exactly the defect A.3 exists to close.

    Not `functools.lru_cache`: the settings this reads are process-lifetime values, but a
    test needs to reset the client, and `reset_effective_config_client` is clearer at the
    call site than reaching into a cache's internals.
    """
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = build_effective_config_client()
    return _CLIENT


def reset_effective_config_client() -> None:
    """Drop the process-wide client (tests only)."""
    global _CLIENT
    _CLIENT = None


def build_effective_config_client() -> EffectiveConfigClient:
    """The worker's client, built from the existing gateway transport settings.

    `api_base_url` is the gateway ORIGIN (`http://host:8868`); the internal
    routes live under the global `/api/v1` prefix, matching the other services'
    `gateway_url` defaults. No new env var — harness already knows where the
    gateway is.
    """
    from harness.core.config import get_settings

    settings = get_settings()
    return EffectiveConfigClient(
        base_url=f"{settings.api_base_url.rstrip('/')}/api/v1",
        token=settings.harness_service_token.get_secret_value(),
    )
