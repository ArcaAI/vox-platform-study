"""Per-tenant Guardrail config resolution from the database.

The Guardrail service resolves the admin-chosen provider/model **per tenant** at
request time by reading ``core."AiTaskDefault"`` joined to ``core."AiModel"``
directly (SQLAlchemy + asyncpg, mirroring STT's read-only DB access), with a
short TTL cache (~60s).

**The runtime cascade is exactly TWO tiers: request tenant → SYSTEM.**

    1. rows for the request tenant (``X-Tenant-Id`` header) — each lookup
       widens to the SYSTEM tenant's rows, preferring the tenant's own
       ``AiTaskDefault`` row over the SYSTEM row for the same task key
    2. the SYSTEM tenant's rows (``00000000-…``) — the platform default tier
    3. the provider-level ``AiRuntimeProfile`` row, for TUNING only — resolved
       by the SAME two tiers, so a tenant that brought its own connection can
       tune it; provider and model SELECTION stays fail-closed (there is no env
       engine left to fall back to — guardrail hosts no LLM, TASK-735 Phase 2b)

A request with **no** ``X-Tenant-Id`` has no tenant context and therefore
resolves SYSTEM only. It must never act as some customer tenant.

There is deliberately NO "default tenant" knob. SYSTEM is the DECLARED widening
target, not a configurable value, and ``50000000-…`` ("Global") is a CUSTOMER
tenant — the playground platform admins use to trial configuration before
promoting it into SYSTEM (``seed/00-constants.ts``). Promotion is an explicit
administrative action, never a resolution step: a runtime that falls back to
``50000000-…`` serves one customer's configuration to every other tenant. This
resolver did exactly that until TASK-735/736 (``GUARDRAIL_DEFAULT_TENANT_ID``,
defaulting to the Global tenant) — see ``.claude/rules/00-project-context.md``
§Configuration Principles, owner clarification 2026-08-16.

Tenant/SYSTEM precedence follows ``AiProviderConnection``'s three-state
semantics (``packages/applications/.../ai-provider-connection/constants.ts``):
absent (no tenant row) = no opinion, so the SYSTEM row applies; ENABLED = the
tenant's row wins outright; DISABLED = a VETO — the tenant has explicitly
refused a selection and the resolver fails closed (503, raised as
:class:`TenantSelectionVetoedError` and mapped in ``core/dependencies.py``)
rather than silently falling through to the SYSTEM row.

Cross-worker contract (the seed provides the SYSTEM rows):
    ``AiTaskDefault`` — taskKey ``guardrail.validate`` → ``modelSlug``
    ``AiModel``       — ``slug`` → provider / sourceUri / metaData.azureDeployment
The model sent to the runtime is the AiModel row's **sourceUri**, not the slug.

Selection is DB-only (fail-closed at the dependency layer when the resolved
config is empty), and an ABSENT row is the only thing that widens to SYSTEM. A
DB read that FAILS raises :class:`TenantConfigUnavailableError` instead — it is
neither cached nor mistaken for "no tenant opinion", because a tenant may only
TIGHTEN relative to SYSTEM and would otherwise be silently downgraded to the
platform floor. The caller must not fall back to env for provider/model
selection either way.

Guardrail deliberately keeps this SQL resolver rather than adopting the HTTP
effective-config client the other services use. The read is merely extended with
``core."AiRuntimeProfile"`` — the provider-level ``temperature`` / ``maxTokens``
/ ``timeoutS`` tuning, folded into the same cache entry so it costs no extra TTL
window. Those tuning fields fail safe to env (absent profile ⇒ env engine config);
the fail-closed posture above still governs provider/model selection.
``local_path`` / model sources stay out of scope for this resolver.

This choice was re-examined against preferring gateway-resolved injection
over per-service DB reads, and CONFIRMED, on two
grounds the paragraph above did not state:

  1. Guardrail's callers are PEER SERVICES, not the gateway. TEXT calls
     ``POST /api/medical/validate`` directly (``text/services/external_guardrail.py``)
     and forwards only ``X-Tenant-Id`` — it has no resolved config to inject.
     The TTS pattern works precisely because the gateway is the caller;
     for guardrail that precondition does not hold, so injection is not
     structurally available.
  2. Pulling effective config over HTTP would put the GATEWAY on guardrail's
     safety-critical validate path and close a call cycle
     (gateway → TEXT → guardrail → gateway). A safety engine must not acquire a
     liveness dependency on the service it is protecting.

Of the three things that must not survive per-service, two are already
sound here: the TTL is DECLARED config (``settings.db.config_cache_ttl_s``,
env ``GUARDRAIL_V2_DB_CONFIG_CACHE_TTL_S``), not an invented constant; and the
fail-open/closed choice is fail-CLOSED on selection (503 in
``core/dependencies.py``), which lane F generalised into
``SettingDescriptor.failMode``. The cache key is ``f"{task_key}::{tenant_id}"`` —
tenant-keyed, so the tenant-keying requirement is satisfied.

The one genuine gap is INVALIDATION: a gateway-side ``AiTaskDefault`` /
``AiModel`` change is not pushed here, so it lands within one TTL window rather
than immediately. Closing it needs a PUBLISHER in the gateway (the TS side
already has its own settings channel, ``app-settings:invalidate``); a subscriber
here without one would be dead code, so it is deliberately not added yet.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Float, Integer, String, select
from sqlalchemy.dialects.postgresql import ENUM, JSONB
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from guardrail.core.config import Settings
from guardrail.core.logging import get_logger
from guardrail.core.metrics import record_config_cache_event

logger = get_logger(__name__)

# Cross-worker contract — do NOT rename (seeded by the TS worker).
TASK_KEY_GUARDRAIL_VALIDATE = "guardrail.validate"

# aux-model selection keys (SYSTEM AiTaskDefault ⋈ AiModel):
#   guardrail.safety       → LLM-safety moderation model (six tasks)
#   guardrail.pii          → PII span model (English only)
#   guardrail.groundedness → NLI entailment scorer
# The runtime model id is the joined AiModel row's sourceUri (never the slug), and
# the model's LABEL TAXONOMY rides along in `AiModel._metadata.labelTaxonomy` — so a
# taxonomy is resolved through the SAME tenant → SYSTEM cascade as the selection it
# belongs to, which is what makes it configuration rather than a Python literal.
# The models themselves run in `apps/nlp` (TASK-735 Phases 3 & 6).
TASK_KEY_GUARDRAIL_SAFETY = "guardrail.safety"
TASK_KEY_GUARDRAIL_PII = "guardrail.pii"
TASK_KEY_GUARDRAIL_GROUNDEDNESS = "guardrail.groundedness"

# Platform-wide rows live on the SYSTEM tenant (house rule: NULL-tenant is banned).
SYSTEM_TENANT_ID = "00000000-0000-0000-0000-000000000000"

# TASK-737 — a DECLARED tenant-less internal call.
#
# Some internal work genuinely has no tenant (the platform-wide async
# `job_processor`, whose Redis job envelope has no tenant column at all; a by-slug
# model-weight lookup; a control-plane pull). Before this marker those calls were
# INDISTINGUISHABLE from an `X-Tenant-Id` dropped in transit, and this resolver had
# to guess. Guessing is what made the failure mode invisible: because a tenant may
# only TIGHTEN relative to SYSTEM, resolving SYSTEM on an absent header silently
# downgrades a tenant that chose a stricter safety posture to the platform floor,
# with no error raised anywhere.
#
# The value is deliberately NOT UUID-shaped, so a future bug that treats it as a
# real tenant id trips an existing UUID check instead of addressing some tenant's
# rows. `tenantless:` alone is not enough — the reason slug is REQUIRED so a log
# line naming the value explains itself.
TENANTLESS_PREFIX = "tenantless:"


def is_tenantless_marker(tenant_id: str | None) -> bool:
    """True when the caller DECLARED it has no tenant (vs. simply omitting one)."""
    return bool(tenant_id) and str(tenant_id).strip().startswith(TENANTLESS_PREFIX)


# Internal keys of the resolved per-tenant field map (cache entries).
KEY_PROVIDER = "provider"
KEY_MODEL = "model"
KEY_AZURE_DEPLOYMENT = "azure-deployment"
# The selected model's declared label taxonomy, JSON-encoded (the cache holds strings).
KEY_LABEL_TAXONOMY = "label-taxonomy"
# The selected model's declared POLICY blob, JSON-encoded (TASK-777 A-3/A-5).
# Thresholds and verdict-deciding criteria are configuration, and they ride the
# registry row for the same reason the taxonomy does: it is the one plane already
# resolved through the two-tier `request tenant → SYSTEM` cascade. See
# `core/policy.py` for the governed key set and the per-key `failMode`.
KEY_POLICY = "policy"
#: The selected NLI checkpoint's ENTAILMENT CALIBRATION
#: (`AiModel._metadata.entailment`). Distinct from `labelTaxonomy`: it declares
#: which adapter the row expects and the score bounds that adapter's specific
#: BUILD — including its quantisation — was calibrated against. `apps/nlp`
#: refuses to score when it is absent or names a different adapter, so failing
#: to forward it degrades the groundedness gate to `unverified` rather than
#: letting it mis-score. That is the safe direction, but it is still a gate
#: that silently stops working, so this key must travel with the selection.
KEY_ENTAILMENT = "entailment"
# Provider-level runtime-profile tuning, cached alongside the
# selection keys so a profile read costs no extra round-trip or TTL window.
KEY_TEMPERATURE = "temperature"
KEY_MAX_TOKENS = "max-tokens"
KEY_TIMEOUT_S = "timeout-s"
# Weight-source keys carried alongside the model identity.
_SLUG_TASK_KEY_PREFIX = "slug::"
KEY_LOCAL_PATH = "local-path"
KEY_CHECKSUM = "checksum"
KEY_SOURCE = "source"
KEY_SOURCE_REVISION = "source-revision"


class TenantSelectionVetoedError(Exception):
    """A tenant explicitly DISABLED its own ``AiTaskDefault`` row for a task key.

    Three-state parity with ``AiProviderConnection``: absent = no opinion (the
    SYSTEM row applies), ENABLED = the tenant's row wins, DISABLED = a VETO.
    The resolver must fail closed here and must never fold through to the
    SYSTEM row — callers map this to HTTP 503 (see ``core/dependencies.py``).
    """

    def __init__(self, *, tenant_id: str, task_key: str) -> None:
        self.tenant_id = tenant_id
        self.task_key = task_key
        super().__init__(
            f"tenant {tenant_id!r} has DISABLED its own AiTaskDefault selection "
            f"for task_key {task_key!r} — veto, not falling through to SYSTEM."
        )


class TenantConfigUnavailableError(Exception):
    """The tenant's rows could not be READ — which is NOT the same as absent.

    Absence means "no opinion" and legitimately widens to SYSTEM. A failed read
    means we do not KNOW the tenant's opinion, and because a tenant may only
    TIGHTEN relative to SYSTEM, answering with the platform row silently
    downgrades a tenant that chose a stricter posture. Same reasoning as
    ``TENANTLESS_PREFIX`` above: an unknown is only safe once it stops being
    indistinguishable from a declared absence. Callers map this to HTTP 503.
    """

    def __init__(self, *, tenant_id: str, task_key: str, cause: str) -> None:
        self.tenant_id = tenant_id
        self.task_key = task_key
        super().__init__(
            f"could not read guardrail config for tenant {tenant_id!r}, task_key "
            f"{task_key!r}: {cause} — not widening to SYSTEM."
        )


class _Base(DeclarativeBase):
    """Declarative base local to the guardrail tenant-config reader."""


# Mirror Prisma's `core."ResourceStatusType"` enum so the resourceStatus filter
# binds correctly against the Postgres enum column (create_type=False — it already
# exists from Prisma). Member set MUST match enums.prisma exactly
# (packages/database/src/prisma/db_main/enums.prisma).
_ResourceStatusType = ENUM(
    "ENABLED",
    "DISABLED",
    "SUSPENDED",
    "ARCHIVED",
    "DELETED",
    name="ResourceStatusType",
    schema="core",
    create_type=False,
)


class AiTaskDefaultRead(_Base):
    """Read-only mapping of ``core."AiTaskDefault"`` (column names from Prisma)."""

    __tablename__ = "AiTaskDefault"
    __table_args__ = {"schema": "core"}

    id: Mapped[str] = mapped_column(String, primary_key=True)
    tenant_id: Mapped[str] = mapped_column("tenantId", String)
    task_key: Mapped[str] = mapped_column("taskKey", String)
    model_slug: Mapped[str] = mapped_column("modelSlug", String)
    resource_status: Mapped[str] = mapped_column("resourceStatus", _ResourceStatusType)


class AiModelRead(_Base):
    """Read-only mapping of ``core."AiModel"`` (registry columns this reader needs)."""

    __tablename__ = "AiModel"
    __table_args__ = {"schema": "core"}

    id: Mapped[str] = mapped_column(String, primary_key=True)
    tenant_id: Mapped[str] = mapped_column("tenantId", String)
    slug: Mapped[str] = mapped_column(String)
    provider: Mapped[str | None] = mapped_column(String)
    source_uri: Mapped[str | None] = mapped_column("sourceUri", String)
    meta_data: Mapped[dict[str, Any] | None] = mapped_column("_metadata", JSONB)
    resource_status: Mapped[str] = mapped_column("resourceStatus", _ResourceStatusType)
    # Weight-source columns. Without these the registry row's
    # `localPath` was dead for guardrail: MiniCheck's path came 100 % from env.
    local_path: Mapped[str | None] = mapped_column("localPath", String)
    checksum: Mapped[str | None] = mapped_column(String)
    source: Mapped[str | None] = mapped_column(String)
    source_revision: Mapped[str | None] = mapped_column("sourceRevision", String)


class AiRuntimeProfileRead(_Base):
    """Read-only mapping of ``core."AiRuntimeProfile"``.

    Only the provider-level tuning columns guardrail can act on are mapped;
    ``local_path`` / model-source concerns stay out of scope.
    """

    __tablename__ = "AiRuntimeProfile"
    __table_args__ = {"schema": "core"}

    id: Mapped[str] = mapped_column(String, primary_key=True)
    tenant_id: Mapped[str] = mapped_column("tenantId", String)
    provider: Mapped[str] = mapped_column(String)
    # '' is the provider-default row; a model-specific row does not set
    # service-level tuning here.
    model_slug: Mapped[str] = mapped_column("modelSlug", String)
    temperature: Mapped[float | None] = mapped_column(Float)
    max_tokens: Mapped[int | None] = mapped_column("maxTokens", Integer)
    timeout_s: Mapped[int | None] = mapped_column("timeoutS", Integer)
    resource_status: Mapped[str] = mapped_column("resourceStatus", _ResourceStatusType)


@dataclass(frozen=True)
class GuardrailTenantConfig:
    """A resolved per-tenant guardrail config (any field may be ``None``)."""

    provider: str | None = None
    model: str | None = None
    azure_deployment: str | None = None
    # The selected model's declared label taxonomy (`AiModel._metadata.labelTaxonomy`).
    # `None` = the row has no opinion, which for a taxonomy is FAIL-CLOSED at the
    # call site: guardrail carries no built-in label list to fall back on.
    label_taxonomy: dict[str, Any] | None = None
    # The selected model's declared POLICY blob (`AiModel._metadata.policy`).
    # `None` = the row has no opinion; what that MEANS is declared per key in
    # `core/policy.py` (fail-closed for criteria, open-to-default for tuning) —
    # never decided at the call site.
    policy: dict[str, Any] | None = None
    #: `AiModel._metadata.entailment` — the selected NLI build's calibration.
    entailment: dict[str, Any] | None = None
    # The tenant the primary lookup targeted (request tenant or default tenant).
    source_tenant_id: str | None = None
    # Provider-level runtime profile (``core."AiRuntimeProfile"``).
    # None on every field means "no opinion": the env engine config wins, so an
    # absent profile row leaves behaviour byte-identical to the env-only path.
    temperature: float | None = None
    max_tokens: int | None = None
    timeout_s: int | None = None
    # Weight source. `local_path` is the operator override
    # with highest precedence; None on every field means "no DB opinion", so the
    # caller's env fallback keeps behaviour byte-identical to the env-only path.
    local_path: str | None = None
    checksum: str | None = None
    source: str | None = None
    source_revision: str | None = None


@dataclass
class _CacheEntry:
    keys: dict[str, str]
    expires_at: float
    # A cached VETO (see `TenantSelectionVetoedError`) must keep raising on
    # every cache hit within the TTL — it must never be read back as `keys`
    # (which would look like silent fall-through to "no opinion").
    vetoed: bool = False


def _decode_taxonomy(value: str | None) -> dict[str, Any] | None:
    """Decode the cached taxonomy blob; unparseable ⇒ None (fail closed upstream)."""
    if not value:
        return None
    try:
        decoded = json.loads(value)
    except (TypeError, ValueError):
        return None
    return decoded if isinstance(decoded, dict) else None


def _as_float(value: str | None) -> float | None:
    """Parse a cached profile number; unparseable ⇒ None (keep the env value)."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_int(value: str | None) -> int | None:
    """Parse a cached profile integer; non-positive/unparseable ⇒ None."""
    if value is None:
        return None
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _clean(value: str | None) -> str | None:
    """Treat empty/whitespace-only strings as unset (so fallback can apply)."""
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def create_session_factory(
    *, database_url: str, pool_size: int = 5, max_overflow: int = 10
) -> async_sessionmaker[AsyncSession]:
    """Create an async session factory bound to a new read-only engine."""
    engine = create_async_engine(
        database_url,
        pool_size=pool_size,
        max_overflow=max_overflow,
        pool_pre_ping=True,
    )
    return async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)


class TenantConfigResolver:
    """Resolves per-tenant guardrail config with a simple per-tenant TTL cache."""

    def __init__(
        self,
        *,
        session_factory: Callable[[], AsyncSession],
        cache_ttl_s: int = 60,
        time_func: Callable[[], float] = time.monotonic,
    ) -> None:
        self._session_factory = session_factory
        self._cache_ttl_s = cache_ttl_s
        self._time = time_func
        self._cache: dict[str, _CacheEntry] = {}
        # Single-flight (TASK-777 A-1). One in-flight load per `task_key::tenant_id`;
        # every other coroutine that misses the same key AWAITS that load instead of
        # issuing its own. Without it, the opening burst of N consultation sessions is
        # N identical `AiTaskDefault ⋈ AiModel` queries against a pool_size=5 engine.
        # Keyed identically to the cache, so coalescing can never merge two tenants.
        self._in_flight: dict[str, asyncio.Future[dict[str, str]]] = {}

    async def resolve(
        self,
        tenant_id: str | None,
        task_key: str = TASK_KEY_GUARDRAIL_VALIDATE,
    ) -> GuardrailTenantConfig:
        """Resolve config for ``tenant_id`` (header value), widening to SYSTEM.

        ``task_key`` selects which ``AiTaskDefault`` row to read —
        ``guardrail.validate`` (default), ``guardrail.safety`` (GLiNER) or
        ``guardrail.groundedness`` (MiniCheck).

        Resolution order: request-tenant rows → SYSTEM rows → env (the caller
        applies env defaults for any field still ``None``). Widening is
        tenant-level: a request tenant with no guardrail rows defers entirely to
        SYSTEM, so an azure-deployment never bleeds across a provider boundary.
        A blank/absent ``tenant_id`` resolves SYSTEM directly — never a customer
        tenant (see the module docstring).
        """
        raw = (tenant_id or "").strip()
        # A DECLARED tenant-less call routes to SYSTEM explicitly, and is NOT an
        # anomaly. Recognising it here — before the `or None` coercion — is what
        # keeps "absent" available as an unambiguous defect signal: after TASK-737
        # every legitimate caller either names a tenant or names its reason.
        if is_tenantless_marker(raw):
            logger.debug(
                "guardrail.tenant.declared_tenantless",
                marker=raw,
                task_key=task_key,
            )
            raw = ""
        requested = raw or None
        primary_tenant = requested or SYSTEM_TENANT_ID

        keys = await self._get_for_tenant(primary_tenant, task_key)
        source = primary_tenant
        if not keys and primary_tenant != SYSTEM_TENANT_ID:
            keys = await self._get_for_tenant(SYSTEM_TENANT_ID, task_key)
            source = SYSTEM_TENANT_ID

        return GuardrailTenantConfig(
            provider=_clean(keys.get(KEY_PROVIDER)),
            model=_clean(keys.get(KEY_MODEL)),
            azure_deployment=_clean(keys.get(KEY_AZURE_DEPLOYMENT)),
            label_taxonomy=_decode_taxonomy(keys.get(KEY_LABEL_TAXONOMY)),
            policy=_decode_taxonomy(keys.get(KEY_POLICY)),
            entailment=_decode_taxonomy(keys.get(KEY_ENTAILMENT)),
            source_tenant_id=source,
            temperature=_as_float(keys.get(KEY_TEMPERATURE)),
            max_tokens=_as_int(keys.get(KEY_MAX_TOKENS)),
            timeout_s=_as_int(keys.get(KEY_TIMEOUT_S)),
            local_path=_clean(keys.get(KEY_LOCAL_PATH)),
            checksum=_clean(keys.get(KEY_CHECKSUM)),
            source=_clean(keys.get(KEY_SOURCE)),
            source_revision=_clean(keys.get(KEY_SOURCE_REVISION)),
        )

    # `resolve_model_source` / `resolve_model_source_by_slug` are GONE (TASK-735
    # Phase 6): weight STAGING moved to `apps/nlp` with the weights. Guardrail
    # forwards the registry's `localPath` verbatim and never materialises a file.

    async def resolve_model_id(
        self,
        tenant_id: str | None,
        task_key: str,
    ) -> str | None:
        """Resolve just the runtime model id (``AiModel.sourceUri``) for a task key.

        the aux models (GLiNER / MiniCheck) only need the model
        identity; provider/azure-deployment don't apply. Returns ``None`` when
        no ENABLED SYSTEM selection exists (the caller fails closed with 503).
        """
        cfg = await self.resolve(tenant_id, task_key)
        return cfg.model

    async def _get_for_tenant(self, tenant_id: str, task_key: str) -> dict[str, str]:
        """Return ``{key: value}`` for a tenant, using/refreshing the TTL cache.

        Only a RESULT is cached — a successful load, or a veto. A load ERROR
        raises (see :class:`TenantConfigUnavailableError`) and is not stored, so
        a recovered DB is served immediately rather than after the TTL window.
        Concurrent misses still cost one connection attempt, via single-flight.
        """
        now = self._time()
        cache_key = f"{task_key}::{tenant_id}"
        entry = self._cache.get(cache_key)
        if entry is not None and entry.expires_at > now:
            record_config_cache_event("hit")
            if entry.vetoed:
                raise TenantSelectionVetoedError(tenant_id=tenant_id, task_key=task_key)
            return entry.keys

        # SINGLE-FLIGHT (TASK-777 A-1). A load is already running for this exact
        # key — await it rather than starting a second one. `shield` is deliberately
        # NOT used: if the leader is cancelled the followers see the cancellation and
        # retry, which is correct for a request-scoped read.
        running = self._in_flight.get(cache_key)
        if running is not None:
            record_config_cache_event("coalesced")
            return await asyncio.shield(running)

        record_config_cache_event("miss")

        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, str]] = loop.create_future()
        self._in_flight[cache_key] = future
        try:
            keys = await self._load_and_cache(tenant_id, task_key, cache_key, now)
        except BaseException as exc:
            if not future.done():
                future.set_exception(exc)
            # Every waiter must observe the SAME outcome the leader did — a
            # coalesced load that resolved some callers and failed others would be
            # worse than no coalescing at all.
            future.exception()  # mark retrieved; waiters still see it via `await`
            raise
        else:
            if not future.done():
                future.set_result(keys)
            return keys
        finally:
            self._in_flight.pop(cache_key, None)

    async def _load_and_cache(
        self, tenant_id: str, task_key: str, cache_key: str, now: float
    ) -> dict[str, str]:
        """The leader's half of :meth:`_get_for_tenant` — load, then cache."""
        try:
            keys = await self._load_from_db(tenant_id, task_key)
        except TenantSelectionVetoedError:
            # Cache the veto itself (same TTL) so a disabled selection doesn't
            # cost a DB round-trip on every request — but never collapse it
            # into the fail-open empty-dict path below; a veto must keep
            # raising, never look like "no opinion".
            self._cache[cache_key] = _CacheEntry(
                keys={}, expires_at=now + self._cache_ttl_s, vetoed=True
            )
            raise
        except Exception as exc:
            # A failed READ is not an absent row. It used to become `{}`, which
            # `resolve()` reads as "no tenant opinion" and widens to SYSTEM —
            # silently serving the platform floor to a tenant that may have
            # chosen something stricter, for a whole TTL window, with nothing
            # raised anywhere. It is also deliberately NOT cached: a veto is a
            # stable declaration and may be, but a transient error must not
            # outlive the condition that caused it. Single-flight above already
            # bounds the concurrent cost of an unreachable DB to one attempt.
            logger.warning(
                "guardrail.tenant_config.db_error",
                tenant_id=tenant_id,
                task_key=task_key,
                error=str(exc),
            )
            raise TenantConfigUnavailableError(
                tenant_id=tenant_id, task_key=task_key, cause=str(exc)
            ) from exc

        self._cache[cache_key] = _CacheEntry(keys=keys, expires_at=now + self._cache_ttl_s)
        return keys

    async def _load_from_db(
        self,
        tenant_id: str,
        task_key: str = TASK_KEY_GUARDRAIL_VALIDATE,
    ) -> dict[str, str]:
        """Resolve this tenant's guardrail model via ``AiTaskDefault ⋈ AiModel``.

        Tenant-first selection (AiProviderConnection three-state parity): reads
        the ``task_key`` row for BOTH ``tenant_id`` and SYSTEM — ENABLED *or*
        DISABLED, so a disabled tenant row is visible rather than
        indistinguishable from an absent one — and prefers a tenant-owned
        ENABLED row over the SYSTEM row (``_row_rank``). Absence (no tenant
        row) defers entirely to SYSTEM. A tenant-owned DISABLED row is a VETO:
        raises :class:`TenantSelectionVetoedError` rather than folding through
        to SYSTEM (mapped to HTTP 503 in ``core/dependencies.py``).
        The ``AiModel`` join stays ENABLED-only and shared-read across
        ``[SYSTEM, request-tenant]``.
        Returns: provider ← ``AiModel.provider``, model ← ``AiModel.sourceUri``,
        azure deployment ← ``AiModel._metadata->>'azureDeployment'``.
        """
        model_scope = [SYSTEM_TENANT_ID, tenant_id]

        # `slug::<slug>` is a by-slug pseudo task key for weight
        # consumers that have no `AiTaskDefault` row (e.g. harness atomic-fact).
        if task_key.startswith(_SLUG_TASK_KEY_PREFIX):
            return await self._load_model_by_slug(
                task_key[len(_SLUG_TASK_KEY_PREFIX) :], model_scope, tenant_id
            )

        task_default_scope = (
            [SYSTEM_TENANT_ID, tenant_id] if tenant_id != SYSTEM_TENANT_ID else [SYSTEM_TENANT_ID]
        )

        async with self._session_factory() as session:
            result = await session.execute(
                select(
                    AiTaskDefaultRead.tenant_id.label("default_tenant_id"),
                    AiTaskDefaultRead.resource_status.label("default_resource_status"),
                    AiModelRead.tenant_id.label("model_tenant_id"),
                    AiModelRead.provider,
                    AiModelRead.source_uri,
                    AiModelRead.meta_data,
                    # Weight source travels with the identity.
                    AiModelRead.local_path,
                    AiModelRead.checksum,
                    AiModelRead.source,
                    AiModelRead.source_revision,
                )
                .select_from(AiTaskDefaultRead)
                .join(
                    AiModelRead,
                    (AiModelRead.slug == AiTaskDefaultRead.model_slug)
                    & AiModelRead.tenant_id.in_(model_scope)
                    & (AiModelRead.resource_status == "ENABLED"),
                    isouter=True,
                )
                .where(
                    AiTaskDefaultRead.task_key == task_key,
                    AiTaskDefaultRead.tenant_id.in_(task_default_scope),
                    AiTaskDefaultRead.resource_status.in_(("ENABLED", "DISABLED")),
                )
            )
            rows = result.all()

        # VETO: the tenant's OWN row is DISABLED — fail closed, never fall
        # through to the SYSTEM row.
        if tenant_id != SYSTEM_TENANT_ID and any(
            r.default_tenant_id == tenant_id and r.default_resource_status == "DISABLED"
            for r in rows
        ):
            raise TenantSelectionVetoedError(tenant_id=tenant_id, task_key=task_key)

        enabled_rows = [r for r in rows if r.default_resource_status == "ENABLED"]
        row = min(enabled_rows, key=lambda r: self._row_rank(r, tenant_id), default=None)
        if row is None:
            return {}

        keys: dict[str, str] = {}
        if row.provider:
            keys[KEY_PROVIDER] = row.provider
        if row.source_uri:
            keys[KEY_MODEL] = row.source_uri
        meta = row.meta_data if isinstance(row.meta_data, dict) else {}
        deployment = meta.get("azureDeployment")
        if isinstance(deployment, str) and deployment.strip():
            keys[KEY_AZURE_DEPLOYMENT] = deployment
        taxonomy = meta.get("labelTaxonomy")
        if isinstance(taxonomy, dict) and taxonomy:
            keys[KEY_LABEL_TAXONOMY] = json.dumps(taxonomy)
        policy = meta.get("policy")
        if isinstance(policy, dict) and policy:
            keys[KEY_POLICY] = json.dumps(policy)
        entailment = meta.get("entailment")
        if isinstance(entailment, dict) and entailment:
            keys[KEY_ENTAILMENT] = json.dumps(entailment)

        # Weight-source columns. Absent values are simply not
        # set, so the caller's env fallback still applies.
        for key, value in (
            (KEY_LOCAL_PATH, getattr(row, "local_path", None)),
            (KEY_CHECKSUM, getattr(row, "checksum", None)),
            (KEY_SOURCE, getattr(row, "source", None)),
            (KEY_SOURCE_REVISION, getattr(row, "source_revision", None)),
        ):
            if isinstance(value, str) and value.strip():
                keys[key] = value

        # Fold in the provider-level runtime profile. Failures here are
        # swallowed: profile tuning is an ENHANCEMENT, and losing it must never
        # cost us the selection keys we already resolved above.
        if row.provider:
            try:
                keys.update(await self._load_runtime_profile(row.provider, tenant_id))
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "guardrail.tenant_config.runtime_profile_error",
                    provider=row.provider,
                    error=str(exc),
                )
        return keys

    async def _load_model_by_slug(
        self, slug: str, model_scope: list[str], tenant_id: str
    ) -> dict[str, str]:
        """Read one ENABLED `AiModel` row by slug (no task-key join)."""
        async with self._session_factory() as session:
            result = await session.execute(
                select(
                    AiModelRead.tenant_id.label("model_tenant_id"),
                    AiModelRead.provider,
                    AiModelRead.source_uri,
                    AiModelRead.local_path,
                    AiModelRead.checksum,
                    AiModelRead.source,
                    AiModelRead.source_revision,
                ).where(
                    AiModelRead.slug == slug,
                    AiModelRead.tenant_id.in_(model_scope),
                    AiModelRead.resource_status == "ENABLED",
                )
            )
            rows = result.all()

        # Tenant-first, SYSTEM on absence — same order as the selection above.
        row = min(
            rows,
            key=lambda r: self._model_rank(r.model_tenant_id, tenant_id),
            default=None,
        )
        if row is None:
            return {}

        keys: dict[str, str] = {}
        for key, value in (
            (KEY_MODEL, row.source_uri),
            (KEY_PROVIDER, row.provider),
            (KEY_LOCAL_PATH, row.local_path),
            (KEY_CHECKSUM, row.checksum),
            (KEY_SOURCE, row.source),
            (KEY_SOURCE_REVISION, row.source_revision),
        ):
            if isinstance(value, str) and value.strip():
                keys[key] = value
        return keys

    async def _load_runtime_profile(self, provider: str, tenant_id: str) -> dict[str, str]:
        """Read the provider-DEFAULT profile row for ``provider``, tenant-first.

        Only the ``modelSlug == ''`` row carries provider-level tuning; a
        model-specific row is per-request territory and is ignored here. An
        absent row returns ``{}``, leaving every engine value on its env default.

        Resolution matches the selection above — the request tenant's own row
        wins, SYSTEM applies only on ABSENCE. This read used to pin SYSTEM
        unconditionally, so a tenant that brought its own connection still ran on
        the platform's temperature/maxTokens/timeoutS and could not express its
        own. Widening is ROW-level, as it is for the selection: a tenant row is
        that tenant's whole opinion and is never blended with SYSTEM's, so a
        profile can't end up half one tier and half the other.

        There is no three-state veto here: ``AiTaskDefault`` declares one for
        SELECTION, whereas a profile is TUNING (an absent one is byte-identical
        to the env path), so a DISABLED row means "no opinion" and stays filtered
        out exactly as before.
        """
        profile_scope = (
            [SYSTEM_TENANT_ID, tenant_id] if tenant_id != SYSTEM_TENANT_ID else [SYSTEM_TENANT_ID]
        )

        async with self._session_factory() as session:
            result = await session.execute(
                select(
                    AiRuntimeProfileRead.tenant_id,
                    AiRuntimeProfileRead.temperature,
                    AiRuntimeProfileRead.max_tokens,
                    AiRuntimeProfileRead.timeout_s,
                ).where(
                    AiRuntimeProfileRead.tenant_id.in_(profile_scope),
                    AiRuntimeProfileRead.provider == provider,
                    AiRuntimeProfileRead.model_slug == "",
                    AiRuntimeProfileRead.resource_status == "ENABLED",
                )
            )
            rows = result.all()

        row = min(rows, key=lambda r: self._model_rank(r.tenant_id, tenant_id), default=None)
        if row is None:
            return {}

        profile: dict[str, str] = {}
        if row.temperature is not None:
            profile[KEY_TEMPERATURE] = str(row.temperature)
        if row.max_tokens is not None:
            profile[KEY_MAX_TOKENS] = str(row.max_tokens)
        if row.timeout_s is not None:
            profile[KEY_TIMEOUT_S] = str(row.timeout_s)
        return profile

    @staticmethod
    def _model_rank(model_tenant_id: str | None, tenant_id: str) -> int:
        """Catalog-row preference: the request tenant's own row, then SYSTEM.

        ``AiModel`` is shared-read across ``[SYSTEM, request tenant]``, and the
        tie-break used to prefer SYSTEM unconditionally — so a tenant that
        registered its own row for a slug lost to the platform's copy of it,
        which is the one thing a tenant's row cannot mean. ``None`` is the outer
        join finding nothing at all and must lose to any real row.
        """
        if model_tenant_id == tenant_id:
            return 0
        if model_tenant_id == SYSTEM_TENANT_ID:
            return 1
        return 2

    @staticmethod
    def _row_rank(row: Any, tenant_id: str) -> tuple[int, int]:
        """Preference rank for a joined row.

        First: the tenant's OWN ``AiTaskDefault`` row over the SYSTEM row
        (tenant-first resolution, TASK-735 Phase 1). Second, as a tie-break
        within the winning owner: the same tenant-first order over the joined
        ``AiModel`` catalog row (``_model_rank``).
        """
        return (
            0 if row.default_tenant_id == tenant_id else 1,
            TenantConfigResolver._model_rank(row.model_tenant_id, tenant_id),
        )

    def clear_cache(self) -> None:
        """Drop all cached entries (test/admin helper)."""
        self._cache.clear()

    def invalidate(self, *, tenant_id: str | None = None, task_key: str | None = None) -> int:
        """Drop cached entries; return how many were dropped.

        **Invalidation is the propagation path; the TTL is a bounded-staleness
        safety net** (rule 09 §Config caches). Before TASK-777 guardrail had no
        invalidation at all, so a platform admin tightening a safety threshold
        waited out the full TTL window on every node — with the loosest admissible
        posture still being served meanwhile.

        Scope narrows as arguments are supplied: no arguments drop everything, a
        `tenant_id` drops that tenant's entries across all task keys, and both drop
        exactly one entry. A VETO entry is dropped like any other — the veto is
        re-established by the next load, from the row that still declares it.
        """
        if tenant_id is None and task_key is None:
            dropped = len(self._cache)
            self._cache.clear()
            return dropped

        doomed = [
            key
            for key in self._cache
            # The cache key is `f"{task_key}::{tenant_id}"`; split from the RIGHT so a
            # task key containing "::" (the `slug::` pseudo-keys do) still parses.
            for cached_task, _, cached_tenant in [key.rpartition("::")]
            if (tenant_id is None or cached_tenant == tenant_id)
            and (task_key is None or cached_task == task_key)
        ]
        for key in doomed:
            self._cache.pop(key, None)
        return len(doomed)


def build_judge_client(
    settings: Settings,
    tenant_cfg: GuardrailTenantConfig,
    http_client: Any,
    tenant_id: str,
    provider_overrides: dict[str, Any] | None = None,
    breaker: Any = None,
) -> Any:
    """Build the delegated guardian for a resolved per-tenant selection.

    Guardrail hosts no engine (TASK-735 Phase 2b): this returns a
    :class:`~guardrail.services.external_text_client.TextJudgeClient` pointed at
    ``apps/text``'s isolated judge lane. The DB supplies the provider/model pair
    — the ONLY selection input — and the provider-level runtime profile supplies
    optional tuning; an absent profile leaves the policy defaults in force.

    ``base_url`` and ``api_key`` are deliberately absent from the argument list.
    The endpoint is `text`'s (bootstrap transport) and the tenant's credential
    travels only as an opaque ``provider_overrides`` blob.
    """
    from guardrail.core.policy import GuardrailPolicy
    from guardrail.services.external_text_client import TextJudgeClient

    # POLICY, resolved through the same two-tier cascade as the selection above
    # (TASK-777 A-3/A-5). `require_criteria` is fail-CLOSED: an unseeded criteria
    # string raises `GuardrailUndeterminedError`, which the route maps to 503.
    policy = GuardrailPolicy.from_blob(
        tenant_cfg.policy, source_tenant_id=tenant_cfg.source_tenant_id
    )

    provider = (tenant_cfg.provider or "").strip()
    model = tenant_cfg.model or ""
    # Azure addresses the model by DEPLOYMENT name on the gateway, so it wins
    # over a generic model name when the row carries one.
    if provider.lower() == "azure" and tenant_cfg.azure_deployment:
        model = tenant_cfg.azure_deployment

    return TextJudgeClient(
        base_url=settings.text_url,
        http_client=http_client,
        service_token=settings.peer_service_token(settings.service_token),
        provider=provider,
        model=model,
        tenant_id=tenant_id,
        criteria=policy.require_criteria("medicalValidationCriteria"),
        policy=settings.judge,
        min_confidence=policy.judge_min_confidence,
        temperature=tenant_cfg.temperature,
        max_tokens=tenant_cfg.max_tokens,
        timeout_s=(float(tenant_cfg.timeout_s) if tenant_cfg.timeout_s is not None else None),
        provider_overrides=provider_overrides,
        breaker=breaker,
    )
