"""``model=<slug>`` → :class:`ResolvedServingSpec`, through the gateway (TASK-1021 C-2).

``GET {gateway}/internal/models/{slug}/serving-spec?service=vllm`` with ``X-Service-Token``
(the shared ``INTERNAL_ACCESS_TOKEN``) and ``X-Tenant-Id`` (mandatory on tenant-scoped
internal work — owner directive). ``service=vllm`` is what the gateway's
``InternalServiceTokenGuard`` picks its secret by. The gateway resolves the slug for THAT
tenant — its own row first, then SYSTEM, never another customer — so this client never
decides which row a slug means.

CACHE — keyed ``(tenant_id, slug)``. The tenant is ALWAYS in the key: the same slug can be
tenant A's BYO row and the SYSTEM row for tenant B, and a slug-only key would serve A's
weights to B (review focus 2). Shape copied from ``core/effective_config.py`` (httpx client,
injectable transport + clock) and ``core/model_credentials.py`` (per-key entries):

* a spec is cached for :data:`POSITIVE_TTL_S` (60 s) — a row edit reaches this replica
  within a minute, and a changed row changes its ``runtimeKey``, so a stale entry can at
  worst keep serving the previous version for that minute;
* a SETTLED refusal — 404 ``MODEL_NOT_FOUND`` / 409 ``MODEL_NOT_SERVABLE`` — is cached for
  :data:`NEGATIVE_TTL_S` (10 s), so a client hammering an unknown slug costs the gateway one
  call per 10 s, while a newly published row still appears quickly;
* a FAULT (5xx, 401, transport error, a body that is not the contract) raises
  :class:`ServingSpecUnavailable` and caches NOTHING — a gateway blip must not become a TTL
  of refused requests;
* single-flight per key: concurrent first calls share ONE request and its outcome.
"""

from __future__ import annotations

import asyncio
import functools
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import quote

import httpx
from hope_obs import get_logger
from pydantic import ValidationError

from hope_vllm.spec import ResolvedServingSpec

logger = get_logger(__name__)

#: The name the gateway's ``InternalServiceTokenGuard`` registers for this service.
SERVICE_NAME = "vllm"
POSITIVE_TTL_S = 60.0
NEGATIVE_TTL_S = 10.0
DEFAULT_TIMEOUT_S = 5.0


class ModelNotFound(Exception):
    """The slug names no row visible to this tenant (or no row served by vLLM) — 404."""

    def __init__(self, slug: str) -> None:
        super().__init__(f"model '{slug}' is not available to this tenant")
        self.slug = slug


class ModelNotServable(Exception):
    """The row exists but cannot be served — 409 with a named ``reason``.

    ``reason`` is the gateway's (``FORMAT_UNSUPPORTED`` · ``SERVING_FACTS_MISSING`` ·
    ``DISABLED``) or this service's own (``KIND_NOT_ACCEPTED`` — the pool does not take
    this kind of model).
    """

    def __init__(self, reason: str, message: str | None = None) -> None:
        super().__init__(message or f"model is not servable: {reason}")
        self.reason = reason


class ServingSpecUnavailable(RuntimeError):
    """The gateway could not answer — a fault, never cached (503)."""


#: A cached outcome: the spec, or the settled refusal to re-raise.
_Outcome = ResolvedServingSpec | ModelNotFound | ModelNotServable


class ServingSpecClient:
    """Resolves and caches serving specs per ``(tenant_id, slug)``."""

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        positive_ttl_s: float = POSITIVE_TTL_S,
        negative_ttl_s: float = NEGATIVE_TTL_S,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        transport: httpx.AsyncBaseTransport | None = None,
        time_func: Callable[[], float] | None = None,
    ) -> None:
        self._base_url = base_url.strip().rstrip("/")
        self._token = token
        self._positive_ttl_s = positive_ttl_s
        self._negative_ttl_s = negative_ttl_s
        self._timeout_s = timeout_s
        self._transport = transport
        self._time = time_func or time.monotonic
        self._cache: dict[tuple[str, str], tuple[_Outcome, float]] = {}
        self._inflight: dict[tuple[str, str], asyncio.Task[_Outcome]] = {}

    async def resolve(self, slug: str, tenant_id: str) -> ResolvedServingSpec:
        """The spec ``slug`` means for ``tenant_id``.

        Raises :class:`ModelNotFound`, :class:`ModelNotServable` or
        :class:`ServingSpecUnavailable`.
        """
        key = (tenant_id, slug)
        cached = self._cache.get(key)
        if cached is not None and self._time() < cached[1]:
            return _unwrap(cached[0])

        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._fetch_and_cache(key))
            self._inflight[key] = task
            task.add_done_callback(functools.partial(self._forget, key))
        # Shielded: one caller going away never cancels a fetch others are waiting on.
        return _unwrap(await asyncio.shield(task))

    def clear_cache(self) -> None:
        self._cache.clear()

    def _forget(self, key: tuple[str, str], _task: object) -> None:
        self._inflight.pop(key, None)

    async def _fetch_and_cache(self, key: tuple[str, str]) -> _Outcome:
        outcome = await self._fetch(*key)
        ttl = (
            self._positive_ttl_s
            if isinstance(outcome, ResolvedServingSpec)
            else self._negative_ttl_s
        )
        self._cache[key] = (outcome, self._time() + ttl)
        return outcome

    async def _fetch(self, tenant_id: str, slug: str) -> _Outcome:
        """One bounded fetch. A settled answer is RETURNED; a fault RAISES (uncached)."""
        if not self._base_url:
            raise ServingSpecUnavailable("no gateway configured (VLLM_API_GATEWAY_URL is blank)")
        path = f"/internal/models/{quote(slug, safe='')}/serving-spec"
        try:
            async with httpx.AsyncClient(
                base_url=self._base_url,
                timeout=self._timeout_s,
                transport=self._transport,
                headers={"X-Service-Token": self._token, "X-Tenant-Id": tenant_id},
            ) as client:
                response = await client.get(path, params={"service": SERVICE_NAME})
        except httpx.HTTPError as exc:
            logger.warning(
                "vllm.serving_spec.fetch_failed",
                slug=slug,
                tenant_id=tenant_id,
                error_type=type(exc).__name__,
            )
            raise ServingSpecUnavailable(
                f"serving-spec lookup failed: {type(exc).__name__}"
            ) from exc

        if response.status_code == 404:
            return ModelNotFound(slug)
        if response.status_code == 409:
            return ModelNotServable(_reason(response))
        if response.status_code != 200:
            logger.warning(
                "vllm.serving_spec.unexpected_status",
                slug=slug,
                tenant_id=tenant_id,
                status=response.status_code,
            )
            raise ServingSpecUnavailable(f"serving-spec lookup answered {response.status_code}")
        try:
            spec = ResolvedServingSpec.model_validate(response.json())
        except (ValueError, ValidationError) as exc:
            # The contract is frozen (C-1): a body that does not parse is a fault, never a
            # "not found" — that would turn a gateway bug into a silent refusal.
            logger.warning(
                "vllm.serving_spec.malformed",
                slug=slug,
                tenant_id=tenant_id,
                error_type=type(exc).__name__,
            )
            raise ServingSpecUnavailable(
                "serving-spec response is not a ResolvedServingSpec"
            ) from exc
        logger.info(
            "vllm.serving_spec.resolved",
            slug=slug,
            tenant_id=tenant_id,
            runtime_key=spec.runtime_key,
            owner_tenant_id=spec.tenant_id,
        )
        return spec


def _reason(response: httpx.Response) -> str:
    try:
        body: Any = response.json()
    except ValueError:
        return "UNKNOWN"
    reason = body.get("reason") if isinstance(body, dict) else None
    return reason if isinstance(reason, str) and reason else "UNKNOWN"


def _unwrap(outcome: _Outcome) -> ResolvedServingSpec:
    if isinstance(outcome, ResolvedServingSpec):
        return outcome
    # A fresh exception per raise: re-raising the cached instance would chain every
    # caller's traceback onto one object.
    if isinstance(outcome, ModelNotFound):
        raise ModelNotFound(outcome.slug)
    raise ModelNotServable(outcome.reason, str(outcome))
