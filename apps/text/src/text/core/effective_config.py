"""Effective-config pull client (text service).

Pulls this service's SERVICE-LEVEL knobs from the gateway
(`GET /api/v1/internal/effective-config?service=text`) instead of taking them from
env. Model/provider SELECTION is unaffected — Text remains a stateless gateway and
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
it into a common package is a settled decision and must not be preempted here.
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

#: Provider-default rows carry service-level capacity; model-specific rows do not.
_PROVIDER_DEFAULT_SLUG = ""

#: Other process-wide caches that must be dropped on the SAME signal.
#:
#: The snapshot is not the only thing a control-plane write can invalidate: the
#: egress client cache (`providers/clients.py`) holds SDK clients built from
#: resolved connections, so a rotated credential must not leave one authenticated
#: with the revoked key holding warm sockets. Rule 09 "Config caches" is explicit
#: that invalidation is the propagation path and the TTL only a bounded-staleness
#: net, so every such cache belongs on this signal rather than on its own timer.
#:
#: A REGISTRY rather than a direct call so this module keeps its one job and
#: acquires no dependency on the provider layer; registration happens where the
#: cache lives.
_INVALIDATION_HOOKS: list[Callable[[], object]] = []


def register_invalidation_hook(hook: Callable[[], object]) -> None:
    """Register a cache to drop whenever config invalidation arrives.

    Idempotent, so a module re-imported under a different name cannot register
    the same hook twice.
    """
    if hook not in _INVALIDATION_HOOKS:
        _INVALIDATION_HOOKS.append(hook)


def _run_invalidation_hooks() -> None:
    """Drop every registered cache. Never raises: one misbehaving hook must not
    stop the others, and must not kill the pub/sub listener task."""
    for hook in _INVALIDATION_HOOKS:
        try:
            hook()
        except Exception as exc:  # noqa: BLE001 — the snapshot eviction already happened
            logger.warning(
                "text.effective_config.invalidation_hook_failed",
                hook=getattr(hook, "__qualname__", repr(hook)),
                error=type(exc).__name__,
            )


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
            # Vendor account quotas. `_non_negative_int`, not `_positive_int`:
            # ZERO is a meaningful served value here — it means "no client-side
            # rate limiting" — whereas for a timeout or a concurrency ceiling
            # zero would take the provider offline.
            tpm_limit = _non_negative_int(profile.get("tpmLimit"))
            if tpm_limit is not None:
                entry["tpm_limit"] = tpm_limit
            rpm_limit = _non_negative_int(profile.get("rpmLimit"))
            if rpm_limit is not None:
                entry["rpm_limit"] = rpm_limit

            if entry:
                limits[provider] = entry
        return limits

    def lane_budgets(self) -> dict[tuple[str, str], dict[str, Any]]:
        """Per-``(provider, lane)`` resource budgets.

        One shape for what `TEXT_CB_*`, `TEXT_QUEUE_*` and `TEXT_JUDGE_*` each
        expressed separately (see `core/runtime_defaults.LaneBudget`). A profile
        row declares its lane; a row with no `lane` describes the user-facing
        path, which is what every pre-existing provider-default row means.

        Values are returned RAW (already snake_cased) and merged over the floor
        by the caller, so an absent key keeps the floor rather than becoming a
        zero.
        """
        budgets: dict[tuple[str, str], dict[str, Any]] = {}
        for profile in self.runtime_profiles:
            if not isinstance(profile, dict):
                continue
            provider = profile.get("provider")
            if not isinstance(provider, str) or not provider:
                continue
            if profile.get("modelSlug") != _PROVIDER_DEFAULT_SLUG:
                continue

            lane = profile.get("lane")
            lane = lane if lane in ("user", "judge") else "user"

            entry: dict[str, Any] = {}
            for served_name, field_name, coerce in (
                ("maxConcurrent", "max_concurrent", _positive_int),
                ("acquireTimeoutS", "acquire_timeout_s", _positive_float),
                ("timeoutS", "timeout_s", _positive_int),
                ("failureThreshold", "failure_threshold", _positive_int),
                ("recoveryTimeoutS", "recovery_timeout_s", _positive_float),
                ("queueMaxSize", "queue_max_size", _non_negative_int),
                ("queueMaxWaitS", "queue_max_wait_s", _positive_float),
                ("halfOpenMaxCalls", "half_open_max_calls", _positive_int),
                ("resetTimeoutS", "reset_timeout_s", _positive_float),
            ):
                value = coerce(profile.get(served_name))
                if value is not None:
                    entry[field_name] = value

            count_rate_limits = profile.get("countRateLimits")
            if isinstance(count_rate_limits, bool):
                entry["count_rate_limits"] = count_rate_limits

            if entry:
                budgets[(provider, lane)] = entry
        return budgets

    def generation_defaults(self) -> dict[str, float | int]:
        """The platform generation profile (`core/defaults.py`).

        Only keys the control plane actually served are returned, so an omitted
        one keeps its in-code floor rather than being zeroed.
        """
        group = self.raw.get("generation")
        if not isinstance(group, dict):
            return {}

        resolved: dict[str, float | int] = {}
        temperature = _non_negative_float(group.get("temperature"))
        if temperature is not None:
            resolved["temperature"] = temperature
        top_p = _positive_float(group.get("topP"))
        if top_p is not None:
            resolved["top_p"] = top_p
        max_tokens = _positive_int(group.get("maxTokens"))
        if max_tokens is not None:
            resolved["max_tokens"] = max_tokens
        return resolved

    def external_guardrail(self) -> dict[str, Any]:
        """The platform input-moderation posture (`core/guardrail_posture.py`)."""
        group = self.raw.get("externalGuardrail")
        return group if isinstance(group, dict) else {}

    def retention(self) -> dict[str, int]:
        """The idle-retention TTL forwarded to engines.

        Text owns no cache; this value becomes LM Studio's `ttl`. An
        omitted/null/non-positive value means "keep the env/bootstrap value"
        — never coerced into a real number.
        """
        group = self.raw.get("retention")
        if not isinstance(group, dict):
            return {}
        ttl_seconds = _positive_int(group.get("ttlSeconds"))
        return {} if ttl_seconds is None else {"ttl_seconds": ttl_seconds}


def _positive_int(value: Any) -> int | None:
    """Coerce a served number to a positive int, or None to keep the floor."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    coerced = int(value)
    return coerced if coerced > 0 else None


def _non_negative_int(value: Any) -> int | None:
    """As `_positive_int`, but ZERO is a meaningful served value.

    Used where zero means "unlimited" (`tpmLimit`/`rpmLimit`) or "no queue"
    (`queueMaxSize`) rather than "misconfigured".
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    coerced = int(value)
    return coerced if coerced >= 0 else None


def _positive_float(value: Any) -> float | None:
    """Coerce a served number to a positive float, or None to keep the floor."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value > 0 else None


def _non_negative_float(value: Any) -> float | None:
    """As `_positive_float`, but ZERO is meaningful (`temperature: 0`)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value >= 0 else None


class EffectiveConfigClient:
    """Read-triggered, TTL-cached, fail-safe reader of this service's config."""

    def __init__(
        self,
        base_url: str,
        token: str,
        service: str = "text",
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
        _run_invalidation_hooks()

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

        logger.info("text.effective_config.invalidated", service=self._service, key=key)
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
            logger.warning("text.effective_config.invalidation_unavailable", error=str(exc))
            return

        try:
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                self.handle_invalidation_message(message.get("data"))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — never take the service down
            logger.warning("text.effective_config.invalidation_stopped", error=str(exc))
        finally:
            try:
                await pubsub.aclose()
            except Exception:  # noqa: BLE001
                pass

    def diagnostics(self) -> dict[str, Any]:
        """The `/health` block.

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
        for group in (
            "runtimeProfiles",
            "retention",
            "concurrency",
            "generation",
            "externalGuardrail",
        ):
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
            # Logged ONCE per TTL window (the caller only reaches here on expiry),
            # so a persistently-down gateway cannot flood the logs either.
            logger.warning(
                "text.effective_config.fetch_error",
                service=self._service,
                error=str(exc),
                error_type=type(exc).__name__,
            )
            self._last_refresh_ok = False
            self._last_refresh_at = datetime.now(UTC)
            # The EMPTY result is cached for a full window — callers fall back to
            # env, so the service behaves exactly as it does without a gateway.
            return EffectiveConfigSnapshot(raw={}, ok=False, fetched_at=self._last_refresh_at)
