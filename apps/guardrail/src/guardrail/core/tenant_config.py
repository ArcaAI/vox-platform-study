"""Per-tenant Guardrail config resolution from the database (TASK-338, Q3c).

The Guardrail service resolves the admin-chosen provider/model **per tenant** at
request time by reading ``core.GlobalSetting`` directly (SQLAlchemy + asyncpg,
mirroring STT-v2's read-only DB access), with a short TTL cache (OQ2, ~60s).

Resolution order (tenant-level fallback):
    1. rows for the request tenant (``X-Tenant-Id`` header)
    2. rows for the system/default tenant (the seeded GLOBAL tenant)
    3. env default (handled by the caller via ``settings.engine``)

Cross-worker contract (a parallel TS worker seeds these EXACT rows):
    namespace ``guardrail`` / key ``default-guardrail-provider``   (e.g. ``lm-studio``)
    namespace ``guardrail`` / key ``default-guardrail-model``      (e.g. ``granite-guardian-4.1-8b``)
    namespace ``guardrail`` / key ``guardrail-azure-deployment``   (non-secret; may be empty)

DB access is best-effort: any error resolves to an empty config so the endpoint
transparently falls back to the env-selected engine (fail-safe, never fail-hard).
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy import String, select
from sqlalchemy.dialects.postgresql import ENUM
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
GUARDRAIL_NAMESPACE = "guardrail"
KEY_PROVIDER = "default-guardrail-provider"
KEY_MODEL = "default-guardrail-model"
KEY_AZURE_DEPLOYMENT = "guardrail-azure-deployment"

# Provider switch value (lm-studio|ollama|azure|bedrock) -> Settings sub-config attr.
_PROVIDER_TO_ATTR = {
    "lm-studio": "openai_compat",
    "ollama": "ollama",
    "azure": "azure",
    "bedrock": "bedrock",
}


class _Base(DeclarativeBase):
    """Declarative base local to the guardrail tenant-config reader."""


# Mirror Prisma's `core."ResourceStatusType"` enum so the resourceStatus filter
# binds correctly against the Postgres enum column (create_type=False — it already
# exists from Prisma).
_ResourceStatusType = ENUM(
    "ENABLED",
    "DISABLED",
    "DELETED",
    "PENDING",
    "ARCHIVED",
    name="ResourceStatusType",
    schema="core",
    create_type=False,
)


class GlobalSettingRead(_Base):
    """Read-only mapping of ``core."GlobalSetting"`` (column names from Prisma)."""

    __tablename__ = "GlobalSetting"
    __table_args__ = {"schema": "core"}

    id: Mapped[str] = mapped_column(String, primary_key=True)
    tenant_id: Mapped[str | None] = mapped_column("tenantId", String)
    name: Mapped[str] = mapped_column(String)
    key: Mapped[str] = mapped_column(String)
    namespace: Mapped[str | None] = mapped_column(String)
    value: Mapped[str] = mapped_column(String)
    default_value: Mapped[str | None] = mapped_column("defaultValue", String)
    data_type: Mapped[str] = mapped_column("dataType", String)
    resource_status: Mapped[str] = mapped_column("resourceStatus", _ResourceStatusType)


@dataclass(frozen=True)
class GuardrailTenantConfig:
    """A resolved per-tenant guardrail config (any field may be ``None``)."""

    provider: str | None = None
    model: str | None = None
    azure_deployment: str | None = None
    # The tenant the primary lookup targeted (request tenant or default tenant).
    source_tenant_id: str | None = None


@dataclass
class _CacheEntry:
    keys: dict[str, str]
    expires_at: float


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

    async def resolve(self, tenant_id: str | None) -> GuardrailTenantConfig:
        """Resolve config for ``tenant_id`` (header value) with default fallback.

        Resolution order: request-tenant rows → system/default-tenant rows → env
        (the caller applies env defaults for any field still ``None``). Fallback
        is tenant-level: a request tenant with no guardrail rows defers entirely
        to the default tenant, so an azure-deployment from the default tenant
        never bleeds into a tenant that picked a different provider.
        """
        requested = (tenant_id or "").strip() or None
        primary_tenant = requested or self._default_tenant_id

        keys = await self._get_for_tenant(primary_tenant)
        source = primary_tenant
        if not keys and primary_tenant != self._default_tenant_id:
            keys = await self._get_for_tenant(self._default_tenant_id)
            source = self._default_tenant_id

        return GuardrailTenantConfig(
            provider=_clean(keys.get(KEY_PROVIDER)),
            model=_clean(keys.get(KEY_MODEL)),
            azure_deployment=_clean(keys.get(KEY_AZURE_DEPLOYMENT)),
            source_tenant_id=source,
        )

    async def _get_for_tenant(self, tenant_id: str) -> dict[str, str]:
        """Return ``{key: value}`` for a tenant, using/refreshing the TTL cache."""
        now = self._time()
        entry = self._cache.get(tenant_id)
        if entry is not None and entry.expires_at > now:
            return entry.keys

        try:
            keys = await self._load_from_db(tenant_id)
        except Exception as exc:  # fail-safe: fall back to env defaults
            logger.warning(
                "guardrail.tenant_config.db_error",
                tenant_id=tenant_id,
                error=str(exc),
            )
            return {}

        self._cache[tenant_id] = _CacheEntry(keys=keys, expires_at=now + self._cache_ttl_s)
        return keys

    async def _load_from_db(self, tenant_id: str) -> dict[str, str]:
        """Query ``core.GlobalSetting`` for this tenant's guardrail rows."""
        async with self._session_factory() as session:
            result = await session.execute(
                select(GlobalSettingRead.key, GlobalSettingRead.value).where(
                    GlobalSettingRead.tenant_id == tenant_id,
                    GlobalSettingRead.namespace == GUARDRAIL_NAMESPACE,
                    GlobalSettingRead.key.in_(
                        [KEY_PROVIDER, KEY_MODEL, KEY_AZURE_DEPLOYMENT]
                    ),
                    GlobalSettingRead.resource_status == "ENABLED",
                )
            )
            return {row.key: row.value for row in result.all()}

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

    if not model:
        return provider, base

    engine = base.model_copy(
        update={
            "guardrail_model": model,
            "content_safety_model": model,
            "pii_detection_model": model,
            "prompt_injection_model": model,
            "comprehensive_model": model,
            "guardian_model": model,
        }
    )
    return provider, engine


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
