"""nlp mirror of ``stt.core.model_credentials`` — model-registry credentials,
resolved tenant -> SYSTEM (TASK-855 L6 follow-on).

WHAT THIS CLOSES.

``nlp/models/source_resolver.py`` (TASK-855 L6) shipped with
``config_from_settings`` deliberately CREDENTIAL-FREE: nlp had no gateway route
to a per-model-owner S3 credential, and adding one meant touching ``apps/api``,
outside that lane's ownership. A parallel lane has since added a GENERIC
internal route —

    GET /internal/model-registry-credential?provider=<p>&tenantId=<t>

— one shared route (not one per service), guarded the same way and returning
the same ``ResolvedProviderCredential`` shape as the STT-specific
``GET /internal/stt/model-registry-credential`` this module mirrors
(``apps/api/src/modules/internal/stt-internal.controller.ts:329``). This module
is the nlp-side client for that generic route.

WHOSE CREDENTIAL IS SPENT — the load-bearing rule (unchanged from stt).

**The funding tenant is the MODEL ROW'S OWNER, never the caller.** A
SYSTEM-owned model therefore always fetches with the platform token, even when
a tenant's job triggered the load. See :func:`owner_tenant_of`.

FAIL POSTURE — unchanged from stt, four outcomes:

* ``RESOLVED``    — a row supplied a credential. Use it.
* ``ABSENT``      — no tier has an opinion (no row, or a keyless row). Fetch
                    ANONYMOUSLY (irrelevant for S3 today — the resolver's only
                    consumer of this credential is ``s3://``, which has no
                    anonymous mode; kept for parity with stt's HuggingFace use).
* ``DENIED``      — the tenant VETOED this provider, or the platform-default
                    entitlement is not granted. Fail closed; never fall through.
* ``UNAVAILABLE`` — the gateway could not answer. Fail closed.

WHERE THIS DIFFERS FROM ``stt.core.model_credentials`` (both deliberate).

1. **Route path.** ``/internal/model-registry-credential`` — the GENERIC route,
   not the STT-worker-reserved ``/internal/stt/model-registry-credential``
   (that one stays scoped to the STT worker's own reserved
   ``internal:stt:worker`` API-key scope; this lane cannot reach it).
2. **No ``loop_local`` singleton.** stt runs a Dramatiq WORKER that does one
   ``asyncio.run()`` per message, so a client (and the ``asyncio.Lock`` inside
   it) bound to one event loop would deadlock the next message on a closed
   loop — that is the whole reason ``stt.core.loop_local`` exists. nlp is a
   FastAPI service under uvicorn's single long-lived event loop (the SAME
   assumption ``nlp.core.effective_config.EffectiveConfigClient`` already
   makes, constructed once in ``lifespan()``), so a plain lazily-constructed
   module singleton is correct and simpler — see :func:`get_model_credential_client`.
3. **``X-Tenant-Id`` is sent as a header, in addition to the ``tenantId`` query
   parameter** stt's own client sends. ``00-project-context.md``: *"X-Tenant-Id
   is REQUIRED on every internal service-to-service request that carries
   tenant-scoped work."* This resolution is never tenant-less — an unowned
   model resolves ``SYSTEM_TENANT_ID`` explicitly (:func:`owner_tenant_of`) — so
   the header always carries a real value, never an absent one indistinguishable
   from a dropped header.
4. **Authenticates with ``api_gateway_key`` / ``X-Internal-Service-Key``**, NOT
   the ``internal_access_token`` / ``X-Service-Token`` pair
   ``nlp.core.effective_config.EffectiveConfigClient`` presents for its
   peer-to-peer settings pull. This is the SAME header+field shape stt already
   uses to reach the gateway's ``/internal/*`` surface. ``api_gateway_key``
   reads the bare, platform-wide ``API_GATEWAY_KEY`` (already declared in
   ``turbo.json#globalEnv`` and read the identical way by ``apps/stt``) — not a
   new secret this module invents.

Deliberately DIFFERENT from ``effective_config``'s ``get_provider_overrides``,
which fails OPEN: this fails CLOSED, same as stt, because after this fetch
returns nothing there is nowhere left to fall back TO for a credential.
"""

from __future__ import annotations

import asyncio
import time as _time
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

import httpx
import structlog
from pydantic import SecretStr

logger = structlog.get_logger(__name__)

#: The reserved platform-configuration tenant. A model with no owner is a
#: PLATFORM model, and this is passed EXPLICITLY: the gateway has no tenant-less
#: form, because an absent tenant could only mean "read SYSTEM unconditionally",
#: which is the widen-without-absence bug the two-tier rule exists to prevent.
SYSTEM_TENANT_ID = "00000000-0000-0000-0000-000000000000"

#: The capability discriminator these credentials live under (documentation
#: only — it is baked into the route path, not sent as a parameter).
MODEL_REGISTRY_SERVICE = "model-registry"

DEFAULT_TTL_S = 60
DEFAULT_TIMEOUT_S = 5.0

_CREDENTIAL_PATH = "/internal/model-registry-credential"


class CredentialOutcome(StrEnum):
    """The four wire outcomes (see the module docstring for the contract)."""

    RESOLVED = "resolved"
    ABSENT = "absent"
    DENIED = "denied"
    UNAVAILABLE = "unavailable"


class CredentialUnavailable(RuntimeError):
    """A credential could not be resolved and the caller must fail closed."""


def owner_tenant_of(model_tenant_id: str | None) -> str:
    """The tenant whose credential funds a fetch of this model.

    The MODEL's owner, never the caller. An unowned (platform) model resolves
    SYSTEM explicitly — see ``SYSTEM_TENANT_ID``.
    """
    return (
        model_tenant_id.strip() if model_tenant_id and model_tenant_id.strip() else SYSTEM_TENANT_ID
    )


@dataclass(frozen=True)
class ModelRegistryCredential:
    """One resolved credential, or the reason there is none.

    ``api_key`` is a ``SecretStr`` so the value survives neither ``repr()`` nor a
    structlog field nor an accidental ``json.dumps`` — the three ways a secret
    reaches a durable store without anyone deciding to put it there.
    """

    outcome: CredentialOutcome
    api_key: SecretStr | None = None
    base_url: str | None = None
    #: Non-secret half of the S3 credential pair (``extras.accessKeyId``).
    access_key_id: str | None = None
    #: 'tenant' | 'platform'. DERIVED gateway-side from the row that supplied the
    #: credential; carried for observability only and never re-stamped here.
    funding: str | None = None
    #: Cause for DENIED / UNAVAILABLE. Never key material.
    reason: str = ""
    #: Everything else the row's `extraJson` carried, minus reserved keys.
    extras: dict[str, Any] = field(default_factory=dict)

    @property
    def usable(self) -> bool:
        """True when the caller may proceed — with a credential, or without one."""
        return self.outcome in (CredentialOutcome.RESOLVED, CredentialOutcome.ABSENT)

    @property
    def secret(self) -> str | None:
        """The plaintext key, or None. The ONLY unwrapping point."""
        return self.api_key.get_secret_value() if self.api_key is not None else None

    def raise_if_unusable(self, *, provider: str) -> None:
        """Fail closed on DENIED / UNAVAILABLE.

        The message names the provider, the outcome and the reason and NOTHING
        else — a credential-resolution error string can echo the payload a
        secrets backend choked on.
        """
        if self.usable:
            return
        detail = f": {self.reason}" if self.reason else ""
        raise CredentialUnavailable(
            f"no usable model-registry credential for '{provider}' ({self.outcome.value}{detail})"
        )

    @classmethod
    def unavailable(cls, reason: str) -> ModelRegistryCredential:
        """The fail-closed constructor used for every fault path."""
        return cls(outcome=CredentialOutcome.UNAVAILABLE, reason=reason)

    @classmethod
    def from_payload(cls, payload: Any) -> ModelRegistryCredential:
        """Parse the gateway's response, failing CLOSED on anything unexpected.

        An unrecognised ``outcome`` is UNAVAILABLE, not ``absent``: a contract
        the client does not understand is a fault, and a fault must never present
        as "no opinion". Same reason a non-dict body does.
        """
        if not isinstance(payload, dict):
            return cls.unavailable("malformed credential response")
        raw_outcome = payload.get("outcome")
        if not isinstance(raw_outcome, str):
            return cls.unavailable("unrecognised credential outcome")
        try:
            outcome = CredentialOutcome(raw_outcome)
        except ValueError:
            return cls.unavailable("unrecognised credential outcome")

        if outcome is not CredentialOutcome.RESOLVED:
            reason = payload.get("reason")
            return cls(outcome=outcome, reason=reason if isinstance(reason, str) else "")

        key = payload.get("apiKey")
        extras = payload.get("extras")
        extras = extras if isinstance(extras, dict) else {}
        return cls(
            outcome=outcome,
            # An EMPTY key is not a credential: forwarding "" builds an
            # `Authorization`/access-key with no value, which the downstream
            # SDK rejects outright. Same rule the settings validator applied to
            # a blank env var.
            api_key=SecretStr(key) if isinstance(key, str) and key else None,
            base_url=_str_or_none(payload.get("baseUrl")),
            access_key_id=_str_or_none(extras.get("accessKeyId")),
            funding=_str_or_none(payload.get("funding")),
            extras=extras,
        )


def _str_or_none(value: Any) -> str | None:
    """Non-empty strings only — "" is not a configured value."""
    return value if isinstance(value, str) and value else None


class ModelRegistryCredentialClient:
    """Fetches and caches model-registry credentials, per (provider, tenant).

    The cache key ALWAYS includes the tenant. A cache keyed by provider alone
    would serve one tenant's token to another — rule 09's config-cache rule M4,
    and here the value is key material rather than a tuning knob.

    A FAULT is never cached. Caching ``unavailable`` would extend a momentary
    gateway blip into a full TTL of failed model loads; a negative result is
    retried on the next call.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        ttl_s: int = DEFAULT_TTL_S,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        transport: httpx.AsyncBaseTransport | None = None,
        time_func: Any | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._ttl_s = ttl_s
        self._timeout_s = timeout_s
        self._transport = transport
        self._time = time_func or _time.monotonic
        self._cache: dict[tuple[str, str], tuple[ModelRegistryCredential, float]] = {}
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}

    async def resolve(self, provider: str, tenant_id: str) -> ModelRegistryCredential:
        """Resolve ``provider`` for the tenant that OWNS the model being fetched.

        Never raises: every fault becomes ``UNAVAILABLE`` so the decision to fail
        closed belongs to the CALLER, at the point where it knows whether the
        credential was actually needed.
        """
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
            # Only a SETTLED verdict is cached. `absent` and `denied` are real
            # answers from the control plane and hold for the window; a fault is
            # not an answer.
            if credential.outcome is not CredentialOutcome.UNAVAILABLE:
                self._cache[key] = (credential, self._time() + self._ttl_s)
            return credential

    async def _fetch(self, provider: str, tenant_id: str) -> ModelRegistryCredential:
        """One bounded fetch. NEVER raises — faults become UNAVAILABLE."""
        try:
            async with httpx.AsyncClient(
                base_url=self._base_url,
                timeout=self._timeout_s,
                transport=self._transport,
                headers={
                    "X-Internal-Service-Key": self._api_key,
                    # 00-project-context.md: mandatory on every internal call
                    # carrying tenant-scoped work. This resolution is never
                    # tenant-less (`owner_tenant_of` always returns a real
                    # value), so the header is always present.
                    "X-Tenant-Id": tenant_id,
                },
            ) as client:
                response = await client.get(
                    _CREDENTIAL_PATH,
                    params={"provider": provider, "tenantId": tenant_id},
                )
                response.raise_for_status()
                return ModelRegistryCredential.from_payload(response.json())
        except Exception as exc:  # noqa: BLE001 — every fault is UNAVAILABLE
            # Logs the TYPE and the addressed key, never the response body: a
            # credential endpoint's error text can echo the material it choked on.
            logger.warning(
                "nlp.model_credentials.resolve_failed",
                provider=provider,
                tenant_id=tenant_id,
                error_type=type(exc).__name__,
            )
            return ModelRegistryCredential.unavailable("credential resolution failed")

    def clear_cache(self) -> None:
        """Drop every cached credential (tests, and rotation invalidation)."""
        self._cache.clear()


_client: ModelRegistryCredentialClient | None = None


def get_model_credential_client() -> ModelRegistryCredentialClient:
    """The process-wide client, built from the gateway settings.

    A plain lazy singleton, NOT the ``loop_local`` pattern stt's copy uses —
    see point 2 in the module docstring for why nlp does not need it (single
    long-lived FastAPI event loop, no per-message ``asyncio.run()``).
    """
    global _client
    if _client is None:
        from nlp.core.config import settings

        _client = ModelRegistryCredentialClient(
            base_url=settings.service.gateway_url,
            api_key=settings.service.api_gateway_key.get_secret_value(),
        )
    return _client


def reset_model_credential_client() -> None:
    """Drop the cached client (tests only)."""
    global _client
    _client = None


async def resolve_s3_credentials(model_tenant_id: str | None) -> ModelRegistryCredential:
    """The object-store credential that funds a fetch of a model owned by ``model_tenant_id``.

    Returned whole rather than as a tuple because the caller needs three parts —
    endpoint, access key id, secret key — and ``_make_s3_client`` already raises
    a clear ``ModelSourceError`` when any is missing.
    """
    client = get_model_credential_client()
    credential = await client.resolve("s3", owner_tenant_of(model_tenant_id))
    credential.raise_if_unusable(provider="s3")
    return credential
