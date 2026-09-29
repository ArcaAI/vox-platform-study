"""Model-registry credentials for a weight pull, resolved tenant → SYSTEM (TASK-1010 OD-7).

Copied from the contract ``apps/stt/src/stt/core/model_credentials.py`` documents, against
the GENERIC gateway route ``GET /internal/model-registry-credential`` (the one every
backend service shares; STT keeps its own ``/internal/stt/…`` twin).

HOW THIS SERVICE CALLS IT — and why it differs from the tts / nlp copies. The route sits
behind ``InternalServiceTokenGuard``, which needs ``?service=<name>`` to pick the secret
and reads ``X-Service-Token`` for every caller except stt. The tts and nlp copies send
``X-Internal-Service-Key`` and no ``service=`` — so their fetches 401 → UNAVAILABLE (known
defect, split out of TASK-1010). This client sends ``service=vllm`` +
``X-Service-Token: <INTERNAL_ACCESS_TOKEN>`` and names the tenant twice, as the owner
directive asks of every tenant-scoped internal call: ``tenantId=`` (what the route
resolves for) and ``X-Tenant-Id``.

WHOSE CREDENTIAL IS SPENT: the MODEL ROW'S OWNER (``spec.models.asr.tenantId``), never the
tenant whose window triggered the load. A SYSTEM-owned model always pulls with the
platform token, so one tenant can never spend another's token or quota, and the weights
cached in this process were pulled with the same credential for every caller that can
reach that model.

FOUR OUTCOMES — the split between the middle two is the security property:

* ``RESOLVED``    — a row supplied a credential. Use it.
* ``ABSENT``      — no tier has an opinion. Pull ANONYMOUSLY (public repos only). Never a
                    licence to read an environment variable — there is none to read.
* ``DENIED``      — the owner vetoed the provider, or the platform-default entitlement is
                    not granted. Fail closed.
* ``UNAVAILABLE`` — the gateway could not answer (or none is configured). Fail closed:
                    reading a fault as "no credential" would downgrade an entitled pull
                    to an anonymous one.

A FAULT is never cached (a gateway blip must not become a TTL of failed loads); a settled
answer is cached per (provider, tenant) — the tenant is ALWAYS in the key.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

import httpx
from hope_obs import get_logger
from pydantic import SecretStr

logger = get_logger(__name__)

#: The reserved platform-configuration tenant — what an unowned model resolves to,
#: EXPLICITLY (the route has no tenant-less form).
SYSTEM_TENANT_ID = "00000000-0000-0000-0000-000000000000"

#: The name ``InternalServiceTokenGuard`` knows this service by (its secret selector).
SERVICE_NAME = "vllm"
ROUTE = "/internal/model-registry-credential"

DEFAULT_TTL_S = 60
DEFAULT_TIMEOUT_S = 5.0


class CredentialOutcome(StrEnum):
    RESOLVED = "resolved"
    ABSENT = "absent"
    DENIED = "denied"
    UNAVAILABLE = "unavailable"


def owner_tenant_of(model_tenant_id: str | None) -> str:
    """The tenant whose credential funds a pull of this model — its OWNER, or SYSTEM."""
    owner = (model_tenant_id or "").strip()
    return owner or SYSTEM_TENANT_ID


@dataclass(frozen=True)
class ModelRegistryCredential:
    """One resolved credential, or the reason there is none.

    ``api_key`` is a ``SecretStr`` so the value survives neither ``repr()`` nor a log
    field nor an accidental ``json.dumps``.
    """

    outcome: CredentialOutcome
    api_key: SecretStr | None = None
    #: 'tenant' | 'platform' — DERIVED gateway-side; observability only.
    funding: str | None = None
    #: Cause for DENIED / UNAVAILABLE. Never key material.
    reason: str = ""

    @property
    def usable(self) -> bool:
        """True when a pull may proceed — with a credential (RESOLVED) or without (ABSENT)."""
        return self.outcome in (CredentialOutcome.RESOLVED, CredentialOutcome.ABSENT)

    @property
    def secret(self) -> str | None:
        """The plaintext key, or None. The ONLY unwrapping point."""
        return self.api_key.get_secret_value() if self.api_key is not None else None

    @classmethod
    def unavailable(cls, reason: str) -> ModelRegistryCredential:
        """The fail-closed constructor used for every fault path."""
        return cls(outcome=CredentialOutcome.UNAVAILABLE, reason=reason)

    @classmethod
    def from_payload(cls, payload: Any) -> ModelRegistryCredential:
        """Parse the gateway's answer, failing CLOSED on anything unexpected.

        An unrecognised ``outcome`` is UNAVAILABLE, not ABSENT: a contract this client
        does not understand is a fault, and a fault must never present as "no opinion".
        """
        if not isinstance(payload, dict):
            return cls.unavailable("malformed credential response")
        raw = payload.get("outcome")
        try:
            outcome = CredentialOutcome(raw) if isinstance(raw, str) else None
        except ValueError:
            outcome = None
        if outcome is None:
            return cls.unavailable("unrecognised credential outcome")
        if outcome is not CredentialOutcome.RESOLVED:
            reason = payload.get("reason")
            return cls(outcome=outcome, reason=reason if isinstance(reason, str) else "")
        key = payload.get("apiKey")
        funding = payload.get("funding")
        return cls(
            outcome=outcome,
            # An EMPTY key is not a credential: it would send `Authorization: Bearer `.
            api_key=SecretStr(key) if isinstance(key, str) and key else None,
            funding=funding if isinstance(funding, str) and funding else None,
        )


class ModelRegistryCredentialClient:
    """Fetches and caches model-registry credentials, per (provider, owner tenant)."""

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        ttl_s: int = DEFAULT_TTL_S,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        transport: httpx.AsyncBaseTransport | None = None,
        time_func: Callable[[], float] | None = None,
    ) -> None:
        self._base_url = base_url.strip().rstrip("/")
        self._token = token
        self._ttl_s = ttl_s
        self._timeout_s = timeout_s
        self._transport = transport
        self._time = time_func or time.monotonic
        self._cache: dict[tuple[str, str], tuple[ModelRegistryCredential, float]] = {}
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}

    async def resolve(self, provider: str, tenant_id: str) -> ModelRegistryCredential:
        """Resolve ``provider`` for the tenant that OWNS the model. Never raises."""
        key = (provider, tenant_id)
        cached = self._cache.get(key)
        if cached is not None and self._time() < cached[1]:
            return cached[0]

        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            cached = self._cache.get(key)
            if cached is not None and self._time() < cached[1]:
                return cached[0]
            credential = await self._fetch(provider, tenant_id)
            if credential.outcome is not CredentialOutcome.UNAVAILABLE:
                self._cache[key] = (credential, self._time() + self._ttl_s)
            return credential

    def clear_cache(self) -> None:
        self._cache.clear()

    async def _fetch(self, provider: str, tenant_id: str) -> ModelRegistryCredential:
        """One bounded fetch. NEVER raises — every fault becomes UNAVAILABLE."""
        if not self._base_url:
            return ModelRegistryCredential.unavailable("no gateway configured")
        try:
            async with httpx.AsyncClient(
                base_url=self._base_url,
                timeout=self._timeout_s,
                transport=self._transport,
                headers={"X-Service-Token": self._token, "X-Tenant-Id": tenant_id},
            ) as client:
                response = await client.get(
                    ROUTE,
                    params={"service": SERVICE_NAME, "provider": provider, "tenantId": tenant_id},
                )
                response.raise_for_status()
                return ModelRegistryCredential.from_payload(response.json())
        except Exception as exc:  # noqa: BLE001 — every fault is UNAVAILABLE
            # The TYPE and the addressed key only — a credential endpoint's error text can
            # echo the material it choked on.
            logger.warning(
                "vllm.model_credentials.resolve_failed",
                provider=provider,
                tenant_id=tenant_id,
                error_type=type(exc).__name__,
            )
            return ModelRegistryCredential.unavailable("credential resolution failed")
