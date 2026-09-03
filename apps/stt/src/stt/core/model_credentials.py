"""model-registry credentials, resolved tenant -> SYSTEM.

WHAT MOVED, AND WHY IT HAD NOWHERE ELSE TO GO.

``HUGGINGFACE_TOKEN`` and the ``STT_MODEL_S3_ACCESS_KEY`` / ``_SECRET_KEY`` pair
were the last two credentials this service read from the environment. Both are
now rows on ``AiProviderConnection`` under ``service = 'model-registry'``:

* ``model-registry:huggingface`` — HuggingFace is a model HUB authenticating
  with a bearer token, not object storage. Putting it in ``TenantStorageConfig``
  was rejected: that table carries a ``TenantBucket`` FK, so the token would
  surface model weights in the tenant's own bucket listing — a browsing surface
  for something that is not the tenant's data.
* ``model-registry:s3`` — ``baseUrl`` is the endpoint, the encrypted field is
  the SECRET key, and ``extras.accessKeyId`` is the non-secret principal id.
  Splitting a two-part credential that way has precedent:
  ``ServiceAccount.clientId`` sits in plaintext beside a Vault-referenced secret.

WHOSE CREDENTIAL IS SPENT — the load-bearing rule.

**The funding tenant is the MODEL ROW'S OWNER, never the caller.**
``AiModelConfig.tenant_id`` already carries it. A SYSTEM-owned model therefore
always fetches with the platform token, even when a tenant's job triggered the
load. Two things follow, and neither is incidental:

1. One tenant can never cause another tenant's token — or quota — to be spent.
2. The in-process weight cache is shared across tenants, and it stays safe:
   bytes in it were pulled with the credential of the model's OWNER, which is
   the same for every caller that can reach that model.

DELIVERY. The worker holds no DB handle, and a model load is not an inbound
gateway request, so there is nothing to fold a ``provider_overrides`` envelope
into. The only channel is
``GET /internal/stt/model-registry-credential?provider=&tenantId=``, which
projects the SHARED ``resolveTenantCloudOverrides`` cascade — one veto rule, one
entitlement gate, funding derived from the row — onto four outcomes.

FAIL POSTURE. Four outcomes, and the split between two of them is the whole
security property:

* ``RESOLVED``    — a row supplied a credential. Use it.
* ``ABSENT``      — no tier has an opinion (no row, or a keyless row). Fetch
                    ANONYMOUSLY. For a PUBLIC model repo that is the CORRECT
                    resolved state, and it is never a licence to read an
                    environment variable — there is no longer one to read (see
                    the dead ``validation_alias`` guards in ``config/settings``).
* ``DENIED``      — the tenant VETOED this provider by disabling its row, or the
                    platform-default entitlement is not granted. Fail closed;
                    never fall through to another tier.
* ``UNAVAILABLE`` — the gateway could not answer. Fail closed. Reading a fault as
                    "no credential configured" would downgrade an entitled pull
                    to an anonymous one — which on a GATED repo fails, and on a
                    public one quietly fetches something nobody authorised.

Deliberately DIFFERENT from ``effective_config.get_provider_overrides``, which
fails OPEN: a broken BYO *ASR* key drops out and transcription proceeds on the
platform's. There is no equivalent fallback here once the env paths are closed.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, cast

import httpx
import structlog
from pydantic import SecretStr

from stt.core.loop_local import get_loop_local, reset_loop_locals

logger = structlog.get_logger(__name__)

#: The reserved platform-configuration tenant. A model with no owner is a
#: PLATFORM model, and this is passed EXPLICITLY: the gateway has no tenant-less
#: form, because an absent tenant could only mean "read SYSTEM unconditionally",
#: which is the widen-without-absence bug the two-tier rule exists to prevent.
SYSTEM_TENANT_ID = "00000000-0000-0000-0000-000000000000"

#: The capability discriminator these credentials live under.
MODEL_REGISTRY_SERVICE = "model-registry"

DEFAULT_TTL_S = 60
DEFAULT_TIMEOUT_S = 5.0


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
            # An EMPTY key is not a credential: forwarding "" builds
            # `Authorization: Bearer ` with no value, which HuggingFace rejects
            # outright. Same rule the settings validator applied to a blank env var.
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
        import time as _time

        self._time = time_func or _time.monotonic
        self._cache: dict[tuple[str, str], tuple[ModelRegistryCredential, float]] = {}
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}

    async def resolve(self, provider: str, tenant_id: str) -> ModelRegistryCredential:
        """Resolve ``provider`` for the tenant that OWNS the model being fetched.

        Never raises: every fault becomes ``UNAVAILABLE`` so the decision to fail
        closed belongs to the CALLER, at the point where it knows whether the
        credential was actually needed. Cached models never reach this method at
        all, so a gateway outage cannot break a load that needed no network.
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
                headers={"X-Internal-Service-Key": self._api_key},
            ) as client:
                response = await client.get(
                    "/internal/stt/model-registry-credential",
                    params={"provider": provider, "tenantId": tenant_id},
                )
                response.raise_for_status()
                return ModelRegistryCredential.from_payload(response.json())
        except Exception as exc:  # noqa: BLE001 — every fault is UNAVAILABLE
            # Logs the TYPE and the addressed key, never the response body: a
            # credential endpoint's error text can echo the material it choked on.
            logger.warning(
                "stt.model_credentials.resolve_failed",
                provider=provider,
                tenant_id=tenant_id,
                error_type=type(exc).__name__,
            )
            return ModelRegistryCredential.unavailable("credential resolution failed")

    def clear_cache(self) -> None:
        """Drop every cached credential (tests, and rotation invalidation)."""
        self._cache.clear()


_LOOP_LOCAL_NAMESPACE = "model_credentials.client"


def get_model_credential_client() -> ModelRegistryCredentialClient:
    """The client for the CURRENT event loop, built from the gateway settings.

    Per-loop, for the same reason `get_effective_config_client` is (BUG-015): the
    Dramatiq worker creates a loop per message, and an `asyncio.Lock` bound to a
    closed loop deadlocks every later job.
    """
    from stt.core.config.settings import get_settings

    settings = get_settings()
    return cast(
        "ModelRegistryCredentialClient",
        get_loop_local(
            _LOOP_LOCAL_NAMESPACE,
            lambda: ModelRegistryCredentialClient(
                base_url=settings.api_gateway_url,
                api_key=settings.api_gateway_key.get_secret_value(),
            ),
        ),
    )


def reset_model_credential_client() -> None:
    """Drop the cached clients (tests only)."""
    reset_loop_locals(_LOOP_LOCAL_NAMESPACE)


async def resolve_hf_token(model_tenant_id: str | None) -> str | None:
    """The HuggingFace token that funds a fetch of a model owned by ``model_tenant_id``.

    ``None`` means "pull anonymously", which is correct for a public repo and is
    what ABSENT resolves to. Fails CLOSED on DENIED/UNAVAILABLE by raising
    ``CredentialUnavailable`` — after the env path is closed there is nothing to
    fall back to, and an anonymous pull of a gated repo is not a degraded
    success, it is a different (or failed) fetch.
    """
    client = get_model_credential_client()
    credential = await client.resolve("huggingface", owner_tenant_of(model_tenant_id))
    credential.raise_if_unusable(provider="huggingface")
    return credential.secret


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
