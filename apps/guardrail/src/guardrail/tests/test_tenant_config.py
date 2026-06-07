"""Unit tests for per-tenant guardrail config resolution (TASK-338, Phase 4).

The DB is fully mocked — no live database is required. ``_load_from_db`` is the
seam: tests subclass the resolver to return canned per-tenant rows and count
lookups so the TTL cache + fallback behavior can be asserted deterministically.
"""

from __future__ import annotations

import pytest

from guardrail.core.config import Settings
from guardrail.core.tenant_config import (
    KEY_AZURE_DEPLOYMENT,
    KEY_MODEL,
    KEY_PROVIDER,
    GlobalSettingRead,
    GuardrailTenantConfig,
    TenantConfigResolver,
    build_guardian_provider,
    resolve_guardian_engine,
)

DEFAULT_TENANT = "50000000-0000-0000-0000-000000000000"
TENANT_A = "50000000-0000-0000-0000-000000000001"


class _Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


class _StubResolver(TenantConfigResolver):
    """Resolver whose DB layer is replaced by an in-memory map + call counter."""

    def __init__(self, data: dict[str, dict[str, str]], **kwargs) -> None:
        super().__init__(session_factory=lambda: None, **kwargs)  # type: ignore[arg-type]
        self._data = data
        self.calls: list[str] = []
        self.raise_on: set[str] = set()

    async def _load_from_db(self, tenant_id: str) -> dict[str, str]:
        self.calls.append(tenant_id)
        if tenant_id in self.raise_on:
            raise RuntimeError("simulated db failure")
        return dict(self._data.get(tenant_id, {}))


def _resolver(data, clock=None, ttl=60) -> _StubResolver:
    clock = clock or _Clock()
    return _StubResolver(
        data,
        default_tenant_id=DEFAULT_TENANT,
        cache_ttl_s=ttl,
        time_func=clock,
    )


# ---------------------------------------------------------------------------
# Resolution: header present, fallback, no header
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_resolve_uses_request_tenant_rows() -> None:
    data = {
        TENANT_A: {KEY_PROVIDER: "ollama", KEY_MODEL: "gemma3:latest"},
        DEFAULT_TENANT: {KEY_PROVIDER: "lm-studio", KEY_MODEL: "granite-guardian-4.1-8b"},
    }
    r = _resolver(data)

    cfg = await r.resolve(TENANT_A)

    assert cfg.provider == "ollama"
    assert cfg.model == "gemma3:latest"
    assert cfg.source_tenant_id == TENANT_A
    # request tenant had rows -> no default-tenant lookup
    assert r.calls == [TENANT_A]


@pytest.mark.asyncio
async def test_resolve_falls_back_to_default_tenant_when_request_tenant_empty() -> None:
    data = {
        DEFAULT_TENANT: {KEY_PROVIDER: "lm-studio", KEY_MODEL: "granite-guardian-4.1-8b"},
    }
    r = _resolver(data)

    cfg = await r.resolve(TENANT_A)

    assert cfg.provider == "lm-studio"
    assert cfg.model == "granite-guardian-4.1-8b"
    assert cfg.source_tenant_id == DEFAULT_TENANT
    assert r.calls == [TENANT_A, DEFAULT_TENANT]


@pytest.mark.asyncio
async def test_resolve_no_header_uses_default_tenant() -> None:
    data = {DEFAULT_TENANT: {KEY_PROVIDER: "azure", KEY_MODEL: "gpt-4o"}}
    r = _resolver(data)

    cfg = await r.resolve(None)

    assert cfg.provider == "azure"
    assert cfg.source_tenant_id == DEFAULT_TENANT
    assert r.calls == [DEFAULT_TENANT]


@pytest.mark.asyncio
async def test_resolve_blank_header_uses_default_tenant() -> None:
    data = {DEFAULT_TENANT: {KEY_PROVIDER: "lm-studio"}}
    r = _resolver(data)

    cfg = await r.resolve("   ")

    assert cfg.provider == "lm-studio"
    assert r.calls == [DEFAULT_TENANT]


@pytest.mark.asyncio
async def test_resolve_unknown_tenant_and_no_default_rows_returns_empty() -> None:
    r = _resolver({})

    cfg = await r.resolve(TENANT_A)

    assert cfg == GuardrailTenantConfig(
        provider=None, model=None, azure_deployment=None, source_tenant_id=DEFAULT_TENANT
    )


@pytest.mark.asyncio
async def test_empty_azure_deployment_is_treated_as_unset() -> None:
    data = {
        TENANT_A: {
            KEY_PROVIDER: "azure",
            KEY_MODEL: "gpt-4o",
            KEY_AZURE_DEPLOYMENT: "   ",
        }
    }
    r = _resolver(data)

    cfg = await r.resolve(TENANT_A)

    assert cfg.azure_deployment is None


# ---------------------------------------------------------------------------
# TTL cache: hit / miss / expiry
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_cache_hit_avoids_second_db_call() -> None:
    data = {TENANT_A: {KEY_PROVIDER: "ollama", KEY_MODEL: "gemma3:latest"}}
    r = _resolver(data, ttl=60)

    await r.resolve(TENANT_A)
    await r.resolve(TENANT_A)

    assert r.calls == [TENANT_A]  # second resolve served from cache


@pytest.mark.asyncio
async def test_cache_expiry_triggers_refetch() -> None:
    clock = _Clock()
    data = {TENANT_A: {KEY_PROVIDER: "ollama", KEY_MODEL: "gemma3:latest"}}
    r = _resolver(data, clock=clock, ttl=60)

    await r.resolve(TENANT_A)
    clock.t = 61.0  # advance beyond the TTL
    await r.resolve(TENANT_A)

    assert r.calls == [TENANT_A, TENANT_A]


@pytest.mark.asyncio
async def test_cache_valid_within_ttl() -> None:
    clock = _Clock()
    data = {TENANT_A: {KEY_PROVIDER: "ollama"}}
    r = _resolver(data, clock=clock, ttl=60)

    await r.resolve(TENANT_A)
    clock.t = 59.0  # still within TTL
    await r.resolve(TENANT_A)

    assert r.calls == [TENANT_A]


# ---------------------------------------------------------------------------
# Fail-safe: DB errors resolve to empty (caller falls back to env)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_db_error_resolves_to_empty_config() -> None:
    r = _resolver({})
    r.raise_on = {TENANT_A, DEFAULT_TENANT}

    cfg = await r.resolve(TENANT_A)

    assert cfg.provider is None
    assert cfg.model is None
    assert cfg.azure_deployment is None


@pytest.mark.asyncio
async def test_db_error_is_not_cached() -> None:
    data = {TENANT_A: {KEY_PROVIDER: "ollama"}}
    r = _resolver(data)
    r.raise_on = {TENANT_A}

    first = await r.resolve(TENANT_A)
    assert first.provider is None  # errored -> empty

    r.raise_on.clear()
    second = await r.resolve(TENANT_A)
    assert second.provider == "ollama"  # refetched, not served from error cache


# ---------------------------------------------------------------------------
# Engine resolution: map a resolved config onto an env sub-config
# ---------------------------------------------------------------------------

def _settings() -> Settings:
    return Settings()


def test_resolve_engine_overrides_model_for_lm_studio() -> None:
    s = _settings()
    cfg = GuardrailTenantConfig(provider="lm-studio", model="my-custom-guardian")

    provider, engine = resolve_guardian_engine(s, cfg)

    assert provider == "lm-studio"
    assert engine.guardian_model == "my-custom-guardian"
    assert engine.guardrail_model == "my-custom-guardian"
    # base_url/api_key still come from env (unchanged).
    assert engine.base_url == s.openai_compat.base_url


def test_resolve_engine_switches_provider_to_ollama() -> None:
    s = _settings()
    cfg = GuardrailTenantConfig(provider="ollama", model="gemma3:latest")

    provider, engine = resolve_guardian_engine(s, cfg)

    assert provider == "ollama"
    assert engine.base_url == s.ollama.base_url
    assert engine.guardian_model == "gemma3:latest"


def test_resolve_engine_azure_deployment_takes_precedence() -> None:
    s = _settings()
    cfg = GuardrailTenantConfig(
        provider="azure", model="ignored-model", azure_deployment="prod-guardian-deploy"
    )

    provider, engine = resolve_guardian_engine(s, cfg)

    assert provider == "azure"
    assert engine.guardian_model == "prod-guardian-deploy"


def test_resolve_engine_unknown_provider_falls_back_to_env_default() -> None:
    s = _settings()
    cfg = GuardrailTenantConfig(provider="not-a-provider", model=None)

    provider, engine = resolve_guardian_engine(s, cfg)

    assert provider == s.provider  # env default
    assert engine.guardian_model == s.engine.guardian_model


def test_resolve_engine_no_model_returns_base_unmodified() -> None:
    s = _settings()
    cfg = GuardrailTenantConfig(provider="lm-studio", model=None)

    provider, engine = resolve_guardian_engine(s, cfg)

    assert provider == "lm-studio"
    assert engine.guardian_model == s.openai_compat.guardian_model


# ---------------------------------------------------------------------------
# Provider construction
# ---------------------------------------------------------------------------

def test_build_guardian_provider_openai_compat() -> None:
    from guardrail.providers.openai_compat import OpenAICompatGuardianProvider

    s = _settings()
    provider = build_guardian_provider("lm-studio", s.openai_compat, http_client=object())

    assert isinstance(provider, OpenAICompatGuardianProvider)


def test_build_guardian_provider_ollama() -> None:
    from guardrail.providers.guardian import GuardianProvider

    s = _settings()
    provider = build_guardian_provider("ollama", s.ollama, http_client=object())

    assert isinstance(provider, GuardianProvider)


# ---------------------------------------------------------------------------
# Contract: the read targets the exact GlobalSetting table/columns
# ---------------------------------------------------------------------------

def test_global_setting_read_maps_prisma_columns() -> None:
    table = GlobalSettingRead.__table__
    assert table.schema == "core"
    assert table.name == "GlobalSetting"
    # Prisma column names (camelCase) the SQLAlchemy model maps onto.
    colnames = {c.name for c in table.columns}
    assert {"id", "tenantId", "key", "namespace", "value", "dataType", "resourceStatus"} <= colnames
