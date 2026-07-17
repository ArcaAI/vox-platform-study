"""Unit tests for per-tenant guardrail config resolution (TASK-338, Phase 4;
repointed to the AiTaskDefault ⋈ AiModel registry by TASK-506).

The DB is fully mocked — no live database is required. Two seams are used:
``_load_from_db`` (subclassed to return canned per-tenant rows, for the TTL
cache + tenant-fallback behavior) and a fake SQLAlchemy session (for the
registry-row preference/mapping logic inside ``_load_from_db`` itself).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from guardrail.core.config import Settings
from guardrail.core.tenant_config import (
    KEY_AZURE_DEPLOYMENT,
    KEY_MODEL,
    KEY_PROVIDER,
    SYSTEM_TENANT_ID,
    TASK_KEY_GUARDRAIL_VALIDATE,
    AiModelRead,
    AiTaskDefaultRead,
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
        super().__init__(session_factory=lambda: None, **kwargs)  # type: ignore[arg-type, return-value]
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
# Fail-safe: DB errors resolve to empty (caller falls back to env) and are
# negatively cached for one TTL window (TASK-506 review Minor 1) — an env-only
# deployment without a reachable Postgres pays at most one connection attempt
# per tenant per TTL, not one per request.
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
async def test_db_error_is_negatively_cached_within_ttl() -> None:
    r = _resolver({})
    r.raise_on = {TENANT_A, DEFAULT_TENANT}

    await r.resolve(TENANT_A)
    await r.resolve(TENANT_A)  # second resolve within TTL

    # One load attempt per tenant (request tenant + default fallback), not two.
    assert r.calls == [TENANT_A, DEFAULT_TENANT]


@pytest.mark.asyncio
async def test_db_error_negative_cache_expires_with_ttl() -> None:
    clock = _Clock()
    data = {TENANT_A: {KEY_PROVIDER: "ollama"}}
    r = _resolver(data, clock=clock, ttl=60)
    r.raise_on = {TENANT_A}

    first = await r.resolve(TENANT_A)
    assert first.provider is None  # errored -> empty (fail-open)

    r.raise_on.clear()
    clock.t = 61.0  # negative entry expired
    second = await r.resolve(TENANT_A)
    assert second.provider == "ollama"  # refetched after the TTL window


@pytest.mark.asyncio
async def test_db_error_one_session_attempt_per_tenant_per_ttl() -> None:
    # Real _load_from_db path: a failing session factory is invoked once per
    # tenant per TTL window even across repeated resolves.
    count = 0

    def factory() -> _FakeSession:
        nonlocal count
        count += 1
        return _FakeSession(exc=RuntimeError("connection refused"))

    r = TenantConfigResolver(
        session_factory=factory, default_tenant_id=DEFAULT_TENANT, cache_ttl_s=60
    )

    await r.resolve(TENANT_A)
    await r.resolve(TENANT_A)

    assert count == 2  # TENANT_A + DEFAULT_TENANT fallback, once each — not 4


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
# DB layer (TASK-506): AiTaskDefault ⋈ AiModel row preference + field mapping.
# The SQLAlchemy session is faked; rows mimic the labeled columns the real
# query selects (default_tenant_id, model_tenant_id, provider, source_uri,
# meta_data).
# ---------------------------------------------------------------------------


class _FakeResult:
    def __init__(self, rows: list) -> None:
        self._rows = rows

    def all(self) -> list:
        return list(self._rows)


class _FakeSession:
    def __init__(self, rows: list | None = None, exc: Exception | None = None) -> None:
        self._rows = rows or []
        self._exc = exc

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc_info: object) -> bool:
        return False

    async def execute(self, stmt: object) -> _FakeResult:
        if self._exc is not None:
            raise self._exc
        return _FakeResult(self._rows)


def _row(
    default_tenant: str,
    model_tenant: str,
    provider: str | None,
    source_uri: str | None,
    meta: dict | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        default_tenant_id=default_tenant,
        model_tenant_id=model_tenant,
        provider=provider,
        source_uri=source_uri,
        meta_data=meta,
    )


def _db_resolver(rows: list | None = None, exc: Exception | None = None) -> TenantConfigResolver:
    return TenantConfigResolver(
        session_factory=lambda: _FakeSession(rows, exc),
        default_tenant_id=DEFAULT_TENANT,
        cache_ttl_s=60,
    )


@pytest.mark.asyncio
async def test_db_tenant_task_default_beats_system() -> None:
    rows = [
        _row(SYSTEM_TENANT_ID, SYSTEM_TENANT_ID, "lm-studio", "granite-guardian-4.1-8b"),
        _row(TENANT_A, SYSTEM_TENANT_ID, "ollama", "gemma4:e2b-it-qat"),
    ]
    cfg = await _db_resolver(rows).resolve(TENANT_A)

    assert cfg.provider == "ollama"
    assert cfg.model == "gemma4:e2b-it-qat"


@pytest.mark.asyncio
async def test_db_system_row_used_when_tenant_has_none() -> None:
    rows = [_row(SYSTEM_TENANT_ID, SYSTEM_TENANT_ID, "lm-studio", "granite-guardian-4.1-8b")]
    cfg = await _db_resolver(rows).resolve(TENANT_A)

    assert cfg.provider == "lm-studio"
    assert cfg.model == "granite-guardian-4.1-8b"


@pytest.mark.asyncio
async def test_db_prefers_same_tenant_model_row() -> None:
    # Same (SYSTEM) task default joined against both the tenant's own AiModel
    # copy and the SYSTEM catalog row → the tenant's copy wins.
    rows = [
        _row(SYSTEM_TENANT_ID, SYSTEM_TENANT_ID, "lm-studio", "system-source-uri"),
        _row(SYSTEM_TENANT_ID, TENANT_A, "lm-studio", "tenant-source-uri"),
    ]
    cfg = await _db_resolver(rows).resolve(TENANT_A)

    assert cfg.model == "tenant-source-uri"


@pytest.mark.asyncio
async def test_db_no_rows_resolves_empty_for_env_fallback() -> None:
    cfg = await _db_resolver([]).resolve(TENANT_A)

    assert cfg.provider is None
    assert cfg.model is None
    assert cfg.azure_deployment is None


@pytest.mark.asyncio
async def test_db_session_error_resolves_empty_for_env_fallback() -> None:
    cfg = await _db_resolver(exc=RuntimeError("connection refused")).resolve(TENANT_A)

    assert cfg.provider is None
    assert cfg.model is None


@pytest.mark.asyncio
async def test_db_null_provider_column_keeps_env_provider() -> None:
    rows = [_row(TENANT_A, SYSTEM_TENANT_ID, None, "some-source-uri")]
    cfg = await _db_resolver(rows).resolve(TENANT_A)

    assert cfg.provider is None  # provider column NULL → env provider retained
    assert cfg.model == "some-source-uri"

    s = Settings()
    provider, engine = resolve_guardian_engine(s, cfg)
    assert provider == s.provider  # env default provider
    assert engine.guardian_model == "some-source-uri"  # model still overridden


@pytest.mark.asyncio
async def test_db_azure_deployment_read_from_metadata() -> None:
    rows = [
        _row(
            TENANT_A,
            SYSTEM_TENANT_ID,
            "azure",
            "gpt-5.4-mini",
            meta={"azureDeployment": "prod-guardian-deploy"},
        )
    ]
    cfg = await _db_resolver(rows).resolve(TENANT_A)

    assert cfg.provider == "azure"
    assert cfg.model == "gpt-5.4-mini"
    assert cfg.azure_deployment == "prod-guardian-deploy"


@pytest.mark.asyncio
async def test_db_metadata_without_deployment_leaves_it_unset() -> None:
    rows = [_row(TENANT_A, SYSTEM_TENANT_ID, "azure", "gpt-5.4-mini", meta={"other": "x"})]
    cfg = await _db_resolver(rows).resolve(TENANT_A)

    assert cfg.azure_deployment is None


# ---------------------------------------------------------------------------
# Contract: the read targets the exact AiTaskDefault / AiModel tables+columns
# ---------------------------------------------------------------------------

def test_ai_task_default_read_maps_prisma_columns() -> None:
    table = AiTaskDefaultRead.__table__
    assert table.schema == "core"
    assert table.name == "AiTaskDefault"  # type: ignore[attr-defined]
    colnames = {c.name for c in table.columns}
    assert {"id", "tenantId", "taskKey", "modelSlug", "resourceStatus"} <= colnames


def test_ai_model_read_maps_prisma_columns() -> None:
    table = AiModelRead.__table__
    assert table.schema == "core"
    assert table.name == "AiModel"  # type: ignore[attr-defined]
    colnames = {c.name for c in table.columns}
    assert {"id", "tenantId", "slug", "provider", "sourceUri", "_metadata", "resourceStatus"} <= colnames


def test_guardrail_task_key_contract() -> None:
    # Cross-worker contract with the seed + gateway (TASK-506) — do NOT rename.
    assert TASK_KEY_GUARDRAIL_VALIDATE == "guardrail.validate"
    assert SYSTEM_TENANT_ID == "00000000-0000-0000-0000-000000000000"


def test_resource_status_enum_mirror_matches_postgres() -> None:
    # The SQL mirror must match core."ResourceStatusType" exactly (source of
    # truth: packages/database/src/prisma/db_main/enums.prisma) so enum binds
    # can never drift — Postgres has no PENDING and does have SUSPENDED.
    from guardrail.core.tenant_config import _ResourceStatusType

    assert set(_ResourceStatusType.enums) == {
        "ENABLED",
        "DISABLED",
        "SUSPENDED",
        "ARCHIVED",
        "DELETED",
    }
    assert _ResourceStatusType.name == "ResourceStatusType"
    assert _ResourceStatusType.schema == "core"
