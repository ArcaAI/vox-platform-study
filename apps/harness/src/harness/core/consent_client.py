"""Consent-assert client (consent-abac Phase 4).

The harness's non-HTTP front door onto `IConsultationConsentService.checkConsent`
(`apps/api`'s `ConsentInternalController`, `POST /internal/consent/assert`).
Structurally mirrors `harness.core.effective_config.EffectiveConfigClient` —
TTL cache jittered +/-10%, negative cache, best-effort HTTP — but keyed
per-(tenant, patient, purpose) rather than a single global snapshot, since
consent decisions vary per patient.

FAIL-CLOSED (mirrors `assertConsent`/`checkConsent` on the TS side): any
transport/HTTP failure returns a decision with `allowed=False,
unavailable=True` — NEVER `allowed=True`. `unavailable` is distinct from a
genuine `allowed=False` with a `reason` — R4 (): a gateway
hiccup must never read as a compliance event. Callers (the Temporal
activities in `temporal/activities.py`) use this distinction to choose a
different `error_code` ("consent_unavailable" vs "consent_denied") and,
therefore, different alerting.

CACHE SCOPE (a disclosed, bounded choice — consent-design.md): this cache is
per-process, TTL-only. There is no cross-process invalidation channel for the
harness worker in this phase (the TS side's `arca:consent:invalidate` Redis
channel is not wired here) — a revoke can take up to `ttl_s` to be observed by
an in-flight harness run. The short default TTL (30s, matching the TS-side
in-process cache) is the accepted bounded-staleness backstop, not the
propagation mechanism, per `.claude/rules/09-infrastructure-devops.md`
caches rule 2. Widening to a real invalidation channel is a follow-up.
"""

from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx
import structlog
from pydantic import BaseModel, ConfigDict

logger = structlog.get_logger(__name__)

#: The name the gateway's `InternalServiceTokenGuard`-style guard
#: (`HarnessServiceTokenGuard`) expects — same shared secret as every other
#: harness -> apps/api internal callback.
SERVICE_NAME = "harness"

DEFAULT_TTL_S = 30
DEFAULT_TIMEOUT_S = 5.0
_JITTER_FRACTION = 0.10


class ConsentDecision(BaseModel):
    """One consent verdict — mirrors the wire shape of `ConsentAssertResponseBody`."""

    model_config = ConfigDict(extra="ignore")

    allowed: bool = False
    reason: str | None = None
    #: True ⇒ the grant-store lookup itself failed (a degraded dependency),
    #: distinct from a genuine denial (`reason` set, `unavailable` unset).
    #: Both deny (`allowed=False`), but never conflated (R4).
    unavailable: bool = False
    grant_id: str | None = None
    expires_at: str | None = None


@dataclass(frozen=True)
class _CacheEntry:
    decision: ConsentDecision
    expires_at_monotonic: float


def _cache_key(tenant_id: str, external_patient_id: str, purpose: str) -> str:
    # tenant-leading and mandatory — .claude/rules/09-infrastructure-devops.md
    # caches rule 1 (mirrors ConsultationConsentService.cacheKey on
    # the TS side).
    return f"{tenant_id}::{external_patient_id}::{purpose}"


class ConsentClient:
    """Read-triggered, TTL-cached, fail-closed reader of consent decisions."""

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        ttl_s: int = DEFAULT_TTL_S,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        transport: httpx.AsyncBaseTransport | None = None,
        time_func: Callable[[], float] | None = None,
        header_name: str = "X-Service-Token",
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._ttl_s = ttl_s
        self._timeout_s = timeout_s
        self._transport = transport
        self._time = time_func or time.monotonic
        self._header_name = header_name

        self._cache: dict[str, _CacheEntry] = {}
        # Single-flight over ALL keys (not per-key): simple, and the tool/RAG
        # call sites are not so hot that a shared lock becomes a bottleneck —
        # same trade-off `EffectiveConfigClient` makes for its single snapshot.
        self._lock = asyncio.Lock()

    async def check(
        self,
        *,
        tenant_id: str,
        external_patient_id: str,
        purpose: str,
        scope: dict[str, Any] | None = None,
        consultation_id: str | None = None,
        tool_name: str | None = None,
    ) -> ConsentDecision:
        """Return the cached decision, refreshing it if the window has elapsed.

        NEVER raises — a transport/HTTP failure returns
        ``ConsentDecision(allowed=False, unavailable=True)`` (fail-closed).
        """
        key = _cache_key(tenant_id, external_patient_id, purpose)
        cached = self._cache.get(key)
        if cached is not None and cached.expires_at_monotonic > self._time():
            return cached.decision

        async with self._lock:
            cached = self._cache.get(key)
            if cached is not None and cached.expires_at_monotonic > self._time():
                return cached.decision

            decision = await self._fetch(
                tenant_id=tenant_id,
                external_patient_id=external_patient_id,
                purpose=purpose,
                scope=scope,
                consultation_id=consultation_id,
                tool_name=tool_name,
            )
            self._cache[key] = _CacheEntry(
                decision=decision, expires_at_monotonic=self._time() + self._next_window()
            )
            return decision

    def clear_cache(self) -> None:
        """Drop every cached entry (tests / a future invalidation hook)."""
        self._cache.clear()

    def _next_window(self) -> float:
        jitter = self._ttl_s * _JITTER_FRACTION
        return self._ttl_s + random.uniform(-jitter, jitter)  # noqa: S311 — not cryptographic

    async def _fetch(
        self,
        *,
        tenant_id: str,
        external_patient_id: str,
        purpose: str,
        scope: dict[str, Any] | None,
        consultation_id: str | None,
        tool_name: str | None,
    ) -> ConsentDecision:
        """One bounded fetch. NEVER raises — a failure negative-caches as `unavailable`."""
        body: dict[str, Any] = {
            "tenantId": tenant_id,
            "externalPatientId": external_patient_id,
            "purpose": purpose,
        }
        if scope is not None:
            body["scope"] = scope
        if consultation_id is not None:
            body["consultationId"] = consultation_id
        if tool_name is not None:
            body["toolName"] = tool_name

        try:
            async with httpx.AsyncClient(
                base_url=self._base_url,
                timeout=self._timeout_s,
                transport=self._transport,
                headers={self._header_name: self._token},
            ) as client:
                response = await client.post("/assert", json=body)
                response.raise_for_status()
                payload = response.json()

            if not isinstance(payload, dict):
                raise ValueError(f"expected a JSON object, got {type(payload).__name__}")

            return ConsentDecision(
                allowed=bool(payload.get("allowed", False)),
                reason=payload.get("reason"),
                unavailable=bool(payload.get("unavailable", False)),
                grant_id=payload.get("grantId"),
                expires_at=payload.get("expiresAt"),
            )

        except Exception as exc:  # noqa: BLE001 — fail-closed, never propagate
            logger.warning(
                "harness.consent.fetch_error",
                tenant_id=tenant_id,
                purpose=purpose,
                error=str(exc),
                error_type=type(exc).__name__,
            )
            # FAIL-CLOSED, negative-cached: `unavailable=True`, never
            # `allowed=True`. A down gateway costs at most one attempt per
            # cache window per key, mirroring EffectiveConfigClient.
            return ConsentDecision(allowed=False, unavailable=True)


def build_consent_client() -> ConsentClient:
    """The worker's client, built from the existing gateway transport settings.

    No new secret: reuses the shared `HARNESS_SERVICE_TOKEN` that already
    authenticates every other harness -> apps/api internal callback.
    """
    from harness.core.config import get_settings

    settings = get_settings()
    return ConsentClient(
        base_url=f"{settings.api_base_url.rstrip('/')}{settings.consent_internal_prefix}",
        token=settings.harness_service_token.get_secret_value(),
        ttl_s=settings.consent_cache_ttl_seconds,
    )
