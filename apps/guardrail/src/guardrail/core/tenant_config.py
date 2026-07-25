"""Per-tenant Guardrail config resolution from the database.

The Guardrail service resolves the admin-chosen provider/model **per tenant** at
request time by reading ``core."AiTaskDefault"`` joined to ``core."AiModel"``
directly (SQLAlchemy + asyncpg, mirroring STT's read-only DB access), with a
short TTL cache (~60s).

Resolution order (tenant-level fallback):
    1. rows for the request tenant (``X-Tenant-Id`` header) — each lookup
       widens to the SYSTEM tenant's rows, preferring the tenant's own
    2. rows for the system/default tenant (the seeded GLOBAL tenant)
    3. env default (handled by the caller via ``settings.engine``)

Cross-worker contract (the seed provides the SYSTEM rows):
    ``AiTaskDefault`` — taskKey ``guardrail.validate`` → ``modelSlug``
    ``AiModel``       — ``slug`` → provider / sourceUri / metaData.azureDeployment
The model sent to the runtime is the AiModel row's **sourceUri**, not the slug.

Selection is DB-only (fail-closed at the dependency layer when the
resolved config is empty). DB load errors are still negatively cached for one
TTL window so an unreachable DB costs at most one attempt per tenant per TTL;
the caller must not fall back to env for provider/model selection.

Guardrail deliberately keeps this SQL resolver rather than adopting the HTTP
effective-config client the other services use. The read is merely extended with
``core."AiRuntimeProfile"`` — the provider-level ``temperature`` / ``maxTokens``
/ ``timeoutS`` tuning, folded into the same cache entry so it costs no extra TTL
window. Those tuning fields fail safe to env (absent profile ⇒ env engine config);
the fail-closed posture above still governs provider/model selection.
``local_path`` / model sources stay out of scope for this resolver.
"""

from __future__ import annotations

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

from guardrail.core.config import OllamaConfig, OpenAICompatConfig, Settings
from guardrail.core.logging import get_logger

logger = get_logger(__name__)

# Cross-worker contract — do NOT rename (seeded by the TS worker).
TASK_KEY_GUARDRAIL_VALIDATE = "guardrail.validate"

# aux-model selection keys (SYSTEM AiTaskDefault ⋈ AiModel):
#   guardrail.safety       → GLiNER content-safety detector (TOKEN_CLASSIFICATION)
#   guardrail.groundedness → MiniCheck NLI groundedness scorer (TEXT_CLASSIFICATION)
# The runtime model id is the joined AiModel row's sourceUri (never the slug).
TASK_KEY_GUARDRAIL_SAFETY = "guardrail.safety"
TASK_KEY_GUARDRAIL_GROUNDEDNESS = "guardrail.groundedness"

# Platform-wide rows live on the SYSTEM tenant (house rule: NULL-tenant is banned).
SYSTEM_TENANT_ID = "00000000-0000-0000-0000-000000000000"

# Internal keys of the resolved per-tenant field map (cache entries).
KEY_PROVIDER = "provider"
KEY_MODEL = "model"
KEY_AZURE_DEPLOYMENT = "azure-deployment"
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

# Provider switch value -> Settings sub-config attr. adds the
# production self-host engines vllm / llama-cpp (OpenAI-compatible wire).
_PROVIDER_TO_ATTR = {
    "lm-studio": "openai_compat",
    "ollama": "ollama",
    "vllm": "vllm",
    "llama-cpp": "llama_cpp",
    "azure": "azure",
    "bedrock": "bedrock",
}


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
        default_tenant_id: str,
        cache_ttl_s: int = 60,
        time_func: Callable[[], float] = time.monotonic,
    ) -> None:
        self._session_factory = session_factory
        self._default_tenant_id = default_tenant_id
        self._cache_ttl_s = cache_ttl_s
        self._time = time_func
        self._cache: dict[str, _CacheEntry] = {}

    async def resolve(
        self,
        tenant_id: str | None,
        task_key: str = TASK_KEY_GUARDRAIL_VALIDATE,
    ) -> GuardrailTenantConfig:
        """Resolve config for ``tenant_id`` (header value) with default fallback.

        ``task_key`` selects which SYSTEM ``AiTaskDefault`` row to read —
        ``guardrail.validate`` (default), ``guardrail.safety`` (GLiNER) or
        ``guardrail.groundedness`` (MiniCheck),.

        Resolution order: request-tenant rows → system/default-tenant rows → env
        (the caller applies env defaults for any field still ``None``). Fallback
        is tenant-level: a request tenant with no guardrail rows defers entirely
        to the default tenant, so an azure-deployment from the default tenant
        never bleeds into a tenant that picked a different provider.
        """
        requested = (tenant_id or "").strip() or None
        primary_tenant = requested or self._default_tenant_id

        keys = await self._get_for_tenant(primary_tenant, task_key)
        source = primary_tenant
        if not keys and primary_tenant != self._default_tenant_id:
            keys = await self._get_for_tenant(self._default_tenant_id, task_key)
            source = self._default_tenant_id

        return GuardrailTenantConfig(
            provider=_clean(keys.get(KEY_PROVIDER)),
            model=_clean(keys.get(KEY_MODEL)),
            azure_deployment=_clean(keys.get(KEY_AZURE_DEPLOYMENT)),
            source_tenant_id=source,
            temperature=_as_float(keys.get(KEY_TEMPERATURE)),
            max_tokens=_as_int(keys.get(KEY_MAX_TOKENS)),
            timeout_s=_as_int(keys.get(KEY_TIMEOUT_S)),
            local_path=_clean(keys.get(KEY_LOCAL_PATH)),
            checksum=_clean(keys.get(KEY_CHECKSUM)),
            source=_clean(keys.get(KEY_SOURCE)),
            source_revision=_clean(keys.get(KEY_SOURCE_REVISION)),
        )

    async def resolve_model_source(
        self, tenant_id: str | None, task_key: str
    ) -> Any | None:
        """The weight identity behind a task key (`None` if unselected)."""
        from .model_source import ModelWeightIdentity

        cfg = await self.resolve(tenant_id, task_key)
        if not cfg.model and not cfg.local_path:
            return None

        return ModelWeightIdentity(
            slug=task_key,
            source_uri=cfg.model or "",
            source=cfg.source,
            source_revision=cfg.source_revision,
            local_path=cfg.local_path,
            checksum=cfg.checksum,
        )

    async def resolve_model_source_by_slug(self, slug: str) -> Any | None:
        """Weight identity for a model SLUG (no task key required).

        Not every weight consumer has an `AiTaskDefault` key: harness's
        atomic-fact MiniCheck use, for instance, is keyed only by slug. This
        reuses the same TTL cache so a by-slug read costs no more than a
        task-key read.
        """
        from .model_source import ModelWeightIdentity

        keys = await self._get_for_tenant(SYSTEM_TENANT_ID, f"slug::{slug}")
        if not keys:
            return None

        return ModelWeightIdentity(
            slug=slug,
            source_uri=_clean(keys.get(KEY_MODEL)) or "",
            source=_clean(keys.get(KEY_SOURCE)),
            source_revision=_clean(keys.get(KEY_SOURCE_REVISION)),
            local_path=_clean(keys.get(KEY_LOCAL_PATH)),
            checksum=_clean(keys.get(KEY_CHECKSUM)),
        )

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

        A load error is negatively cached: the empty (fail-open) result is
        stored for the same TTL, so an unreachable DB costs at most one
        connection attempt per tenant per TTL window — not one per request.
        The warning logs on the attempt, not on every cached read.
        """
        now = self._time()
        cache_key = f"{task_key}::{tenant_id}"
        entry = self._cache.get(cache_key)
        if entry is not None and entry.expires_at > now:
            return entry.keys

        try:
            keys = await self._load_from_db(tenant_id, task_key)
        except Exception as exc:  # fail-safe: fall back to env defaults
            logger.warning(
                "guardrail.tenant_config.db_error",
                tenant_id=tenant_id,
                task_key=task_key,
                error=str(exc),
            )
            keys = {}

        self._cache[cache_key] = _CacheEntry(keys=keys, expires_at=now + self._cache_ttl_s)
        return keys

    async def _load_from_db(
        self,
        tenant_id: str,
        task_key: str = TASK_KEY_GUARDRAIL_VALIDATE,
    ) -> dict[str, str]:
        """Resolve this tenant's guardrail model via ``AiTaskDefault ⋈ AiModel``.

        SYSTEM-only selection (tenant override rows are ignored).
        Reads the ENABLED ``task_key`` task default for the SYSTEM tenant joined
        to an ENABLED ``AiModel`` row for its ``modelSlug`` in
        ``[SYSTEM, request-tenant]`` (model weights may still be shared-read).
        Returns: provider ← ``AiModel.provider``, model ← ``AiModel.sourceUri``,
        azure deployment ← ``AiModel._metadata->>'azureDeployment'``.
        """
        model_scope = [SYSTEM_TENANT_ID, tenant_id]

        # `slug::<slug>` is a by-slug pseudo task key for weight
        # consumers that have no `AiTaskDefault` row (e.g. harness atomic-fact).
        if task_key.startswith(_SLUG_TASK_KEY_PREFIX):
            return await self._load_model_by_slug(
                task_key[len(_SLUG_TASK_KEY_PREFIX) :], model_scope
            )

        async with self._session_factory() as session:
            result = await session.execute(
                select(
                    AiTaskDefaultRead.tenant_id.label("default_tenant_id"),
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
                .join(AiModelRead, AiModelRead.slug == AiTaskDefaultRead.model_slug)
                .where(
                    AiTaskDefaultRead.task_key == task_key,
                    AiTaskDefaultRead.tenant_id == SYSTEM_TENANT_ID,
                    AiTaskDefaultRead.resource_status == "ENABLED",
                    AiModelRead.tenant_id.in_(model_scope),
                    AiModelRead.resource_status == "ENABLED",
                )
            )
            rows = result.all()

        # Prefer SYSTEM catalog model row over a tenant-owned copy of the same slug.
        row = min(rows, key=lambda r: (0 if r.model_tenant_id == SYSTEM_TENANT_ID else 1), default=None)
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
                keys.update(await self._load_runtime_profile(row.provider))
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "guardrail.tenant_config.runtime_profile_error",
                    provider=row.provider,
                    error=str(exc),
                )
        return keys

    async def _load_model_by_slug(
        self, slug: str, model_scope: list[str]
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

        # Prefer the SYSTEM catalog row over a tenant-owned copy of the slug.
        row = min(
            rows,
            key=lambda r: (0 if r.model_tenant_id == SYSTEM_TENANT_ID else 1),
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

    async def _load_runtime_profile(self, provider: str) -> dict[str, str]:
        """Read the SYSTEM provider-DEFAULT profile row for ``provider``.

        Only the ``modelSlug == ''`` row carries provider-level tuning; a
        model-specific row is per-request territory and is ignored here. An
        absent row returns ``{}``, leaving every engine value on its env default.
        """
        async with self._session_factory() as session:
            result = await session.execute(
                select(
                    AiRuntimeProfileRead.temperature,
                    AiRuntimeProfileRead.max_tokens,
                    AiRuntimeProfileRead.timeout_s,
                ).where(
                    AiRuntimeProfileRead.tenant_id == SYSTEM_TENANT_ID,
                    AiRuntimeProfileRead.provider == provider,
                    AiRuntimeProfileRead.model_slug == "",
                    AiRuntimeProfileRead.resource_status == "ENABLED",
                )
            )
            row = result.first()

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
    def _row_rank(row: Any, tenant_id: str) -> tuple[int, int]:
        """Preference rank: tenant task-default first, then tenant model copy."""
        return (
            0 if row.default_tenant_id == tenant_id else 1,
            0 if row.model_tenant_id == tenant_id else 1,
        )

    def clear_cache(self) -> None:
        """Drop all cached entries (test/admin helper)."""
        self._cache.clear()


def resolve_guardian_engine(
    settings: Settings, tenant_cfg: GuardrailTenantConfig
) -> tuple[str, OpenAICompatConfig | OllamaConfig]:
    """Map a resolved per-tenant config onto a concrete engine sub-config.

    base_url / api_key still come from env (the DB only carries provider, model
    and the non-secret azure deployment name). Returns the effective provider
    switch value and an engine config with the model overridden.
    """
    provider = (tenant_cfg.provider or settings.provider).strip().lower()
    if provider not in _PROVIDER_TO_ATTR:
        provider = settings.provider

    base = settings.engine_for(provider)

    # For Azure the deployment name addresses the model on the gateway, so it
    # takes precedence over a generic model name.
    model = tenant_cfg.model
    if provider == "azure" and tenant_cfg.azure_deployment:
        model = tenant_cfg.azure_deployment

    # Provider-level runtime-profile tuning. Applied INDEPENDENTLY of
    # the model override: a profile may tune an engine that still uses its env
    # model. Every field is optional, so an absent profile changes nothing.
    update: dict[str, Any] = {}
    if tenant_cfg.temperature is not None:
        update["temperature"] = tenant_cfg.temperature
    if tenant_cfg.max_tokens is not None:
        update["max_tokens"] = tenant_cfg.max_tokens
    if tenant_cfg.timeout_s is not None:
        update["timeout_s"] = tenant_cfg.timeout_s

    if model:
        update.update(
            {
                "guardrail_model": model,
                "content_safety_model": model,
                "pii_detection_model": model,
                "prompt_injection_model": model,
                "comprehensive_model": model,
                "guardian_model": model,
            }
        )

    if not update:
        return provider, base

    return provider, base.model_copy(update=update)


def build_guardian_provider(
    provider: str,
    engine: OpenAICompatConfig | OllamaConfig,
    http_client: object,
) -> object:
    """Instantiate the guardian provider for ``provider`` (mirrors lifespan)."""
    if provider == "ollama":
        from guardrail.providers.guardian import GuardianProvider

        return GuardianProvider(settings=engine, http_client=http_client)  # type: ignore[arg-type]

    from guardrail.providers.openai_compat import OpenAICompatGuardianProvider

    return OpenAICompatGuardianProvider(settings=engine, http_client=http_client)  # type: ignore[arg-type]
