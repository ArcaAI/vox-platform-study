"""Unit tests for per-tenant guardrail config resolution, resolved against
the AiTaskDefault ⋈ AiModel registry.

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
    TenantSelectionVetoedError,
    build_guardian_provider,
    resolve_guardian_engine,
)

# Ordinary customer tenants. Deliberately NOT in the reserved `50000000-…`
# range: that id is the "Global" customer tenant, and the whole point of the
# TASK-735/736 fix is that it is not a tier the resolver may reach for.
TENANT_A = "11111111-1111-1111-1111-111111111111"
TENANT_B = "22222222-2222-2222-2222-222222222222"


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
        self.veto_on: set[str] = set()

    async def _load_from_db(
        self, tenant_id: str, task_key: str = TASK_KEY_GUARDRAIL_VALIDATE
    ) -> dict[str, str]:
        self.calls.append(tenant_id)
        if tenant_id in self.veto_on:
            raise TenantSelectionVetoedError(tenant_id=tenant_id, task_key=task_key)
        if tenant_id in self.raise_on:
            raise RuntimeError("simulated db failure")
        return dict(self._data.get(tenant_id, {}))


def _resolver(data, clock=None, ttl=60) -> _StubResolver:
    clock = clock or _Clock()
    return _StubResolver(data, cache_ttl_s=ttl, time_func=clock)


# ---------------------------------------------------------------------------
# Resolution: header present, fallback, no header
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_uses_request_tenant_rows() -> None:
    data = {
        TENANT_A: {KEY_PROVIDER: "vllm", KEY_MODEL: "granite-guardian-4.1-8b"},
        SYSTEM_TENANT_ID: {KEY_PROVIDER: "lm-studio", KEY_MODEL: "system-guardian"},
    }
    r = _resolver(data)

    cfg = await r.resolve(TENANT_A)

    assert cfg.provider == "vllm"
    assert cfg.model == "granite-guardian-4.1-8b"
    assert cfg.source_tenant_id == TENANT_A
    # request tenant had rows -> no SYSTEM widening
    assert r.calls == [TENANT_A]


@pytest.mark.asyncio
async def test_resolve_unknown_tenant_and_no_system_rows_returns_empty() -> None:
    r = _resolver({})

    cfg = await r.resolve(TENANT_A)

    assert cfg == GuardrailTenantConfig(
        provider=None, model=None, azure_deployment=None, source_tenant_id=SYSTEM_TENANT_ID
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
    data = {TENANT_A: {KEY_PROVIDER: "vllm", KEY_MODEL: "granite-guardian-4.1-8b"}}
    r = _resolver(data, ttl=60)

    await r.resolve(TENANT_A)
    await r.resolve(TENANT_A)

    assert r.calls == [TENANT_A]  # second resolve served from cache


@pytest.mark.asyncio
async def test_cache_expiry_triggers_refetch() -> None:
    clock = _Clock()
    data = {TENANT_A: {KEY_PROVIDER: "vllm", KEY_MODEL: "granite-guardian-4.1-8b"}}
    r = _resolver(data, clock=clock, ttl=60)

    await r.resolve(TENANT_A)
    clock.t = 61.0  # advance beyond the TTL
    await r.resolve(TENANT_A)

    assert r.calls == [TENANT_A, TENANT_A]


@pytest.mark.asyncio
async def test_cache_valid_within_ttl() -> None:
    clock = _Clock()
    data = {TENANT_A: {KEY_PROVIDER: "vllm"}}
    r = _resolver(data, clock=clock, ttl=60)

    await r.resolve(TENANT_A)
    clock.t = 59.0  # still within TTL
    await r.resolve(TENANT_A)

    assert r.calls == [TENANT_A]


# ---------------------------------------------------------------------------
# Veto: a tenant-owned DISABLED row must fail closed and never fall through
# to the SYSTEM row, and must not bleed across tenants via the cache.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_vetoed_tenant_never_falls_through_to_system() -> None:
    data = {SYSTEM_TENANT_ID: {KEY_PROVIDER: "lm-studio", KEY_MODEL: "granite-guardian-4.1-8b"}}
    r = _resolver(data)
    r.veto_on = {TENANT_A}

    with pytest.raises(TenantSelectionVetoedError):
        await r.resolve(TENANT_A)

    # Never attempted the SYSTEM widening lookup.
    assert r.calls == [TENANT_A]


@pytest.mark.asyncio
async def test_veto_is_cached_within_ttl_without_a_second_db_call() -> None:
    r = _resolver({})
    r.veto_on = {TENANT_A}

    with pytest.raises(TenantSelectionVetoedError):
        await r.resolve(TENANT_A)
    with pytest.raises(TenantSelectionVetoedError):
        await r.resolve(TENANT_A)

    assert r.calls == [TENANT_A]  # second resolve served from the cached veto


@pytest.mark.asyncio
async def test_veto_expires_with_the_ttl() -> None:
    clock = _Clock()
    data = {TENANT_A: {KEY_PROVIDER: "vllm", KEY_MODEL: "granite-guardian-4.1-8b"}}
    r = _resolver(data, clock=clock, ttl=60)
    r.veto_on = {TENANT_A}

    with pytest.raises(TenantSelectionVetoedError):
        await r.resolve(TENANT_A)

    r.veto_on.clear()
    clock.t = 61.0  # cached veto expired
    cfg = await r.resolve(TENANT_A)

    assert cfg.provider == "vllm"  # re-resolved, no longer vetoed


@pytest.mark.asyncio
async def test_cache_does_not_bleed_between_tenants() -> None:
    data = {
        TENANT_A: {KEY_PROVIDER: "vllm", KEY_MODEL: "granite-guardian-4.1-8b"},
        TENANT_B: {KEY_PROVIDER: "azure", KEY_MODEL: "gpt-4o"},
    }
    r = _resolver(data)

    cfg_a = await r.resolve(TENANT_A)
    cfg_b = await r.resolve(TENANT_B)

    assert cfg_a.provider == "vllm"
    assert cfg_b.provider == "azure"
    assert r.calls == [TENANT_A, TENANT_B]


@pytest.mark.asyncio
async def test_vetoed_tenant_does_not_affect_a_different_tenants_resolution() -> None:
    data = {TENANT_B: {KEY_PROVIDER: "azure", KEY_MODEL: "gpt-4o"}}
    r = _resolver(data)
    r.veto_on = {TENANT_A}

    with pytest.raises(TenantSelectionVetoedError):
        await r.resolve(TENANT_A)

    cfg_b = await r.resolve(TENANT_B)
    assert cfg_b.provider == "azure"


# ---------------------------------------------------------------------------
# Fail-safe: DB errors resolve to empty (caller falls back to env) and are
# negatively cached for one TTL window — an env-only
# deployment without a reachable Postgres pays at most one connection attempt
# per tenant per TTL, not one per request.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_db_error_resolves_to_empty_config() -> None:
    r = _resolver({})
    r.raise_on = {TENANT_A, SYSTEM_TENANT_ID}

    cfg = await r.resolve(TENANT_A)

    assert cfg.provider is None
    assert cfg.model is None
    assert cfg.azure_deployment is None


@pytest.mark.asyncio
async def test_db_error_is_negatively_cached_within_ttl() -> None:
    r = _resolver({})
    r.raise_on = {TENANT_A, SYSTEM_TENANT_ID}

    await r.resolve(TENANT_A)
    await r.resolve(TENANT_A)  # second resolve within TTL

    # One load attempt per tenant (request tenant + SYSTEM widening), not two.
    assert r.calls == [TENANT_A, SYSTEM_TENANT_ID]


@pytest.mark.asyncio
async def test_db_error_negative_cache_expires_with_ttl() -> None:
    clock = _Clock()
    data = {TENANT_A: {KEY_PROVIDER: "vllm"}}
    r = _resolver(data, clock=clock, ttl=60)
    r.raise_on = {TENANT_A}

    first = await r.resolve(TENANT_A)
    assert first.provider is None  # errored -> empty (fail-open)

    r.raise_on.clear()
    clock.t = 61.0  # negative entry expired
    second = await r.resolve(TENANT_A)
    assert second.provider == "vllm"  # refetched after the TTL window


@pytest.mark.asyncio
async def test_db_error_one_session_attempt_per_tenant_per_ttl() -> None:
    # Real _load_from_db path: a failing session factory is invoked once per
    # tenant per TTL window even across repeated resolves.
    count = 0

    def factory() -> _FakeSession:
        nonlocal count
        count += 1
        return _FakeSession(exc=RuntimeError("connection refused"))

    r = TenantConfigResolver(session_factory=factory, cache_ttl_s=60)

    await r.resolve(TENANT_A)
    await r.resolve(TENANT_A)

    assert count == 2  # TENANT_A + SYSTEM widening, once each — not 4


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


def test_resolve_engine_switches_provider_to_vllm() -> None:
    s = _settings()
    cfg = GuardrailTenantConfig(provider="vllm", model="self-hosted-guardian")

    provider, engine = resolve_guardian_engine(s, cfg)

    assert provider == "vllm"
    assert engine.base_url == s.vllm.base_url
    assert engine.guardian_model == "self-hosted-guardian"


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


def test_build_guardian_provider_is_openai_compat_for_every_engine() -> None:
    from guardrail.providers.openai_compat import OpenAICompatGuardianProvider

    s = _settings()
    for name in ("lm-studio", "vllm", "llama-cpp", "azure", "bedrock"):
        built = build_guardian_provider(name, s.engine_for(name), http_client=object())
        assert isinstance(built, OpenAICompatGuardianProvider)


# ---------------------------------------------------------------------------
# DB layer: AiTaskDefault ⋈ AiModel row preference + field mapping.
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
    model_tenant: str | None,
    provider: str | None,
    source_uri: str | None,
    meta: dict | None = None,
    resource_status: str = "ENABLED",
) -> SimpleNamespace:
    return SimpleNamespace(
        default_tenant_id=default_tenant,
        default_resource_status=resource_status,
        model_tenant_id=model_tenant,
        provider=provider,
        source_uri=source_uri,
        meta_data=meta,
    )


def _db_resolver(rows: list | None = None, exc: Exception | None = None) -> TenantConfigResolver:
    return TenantConfigResolver(
        session_factory=lambda: _FakeSession(rows, exc),
        cache_ttl_s=60,
    )


@pytest.mark.asyncio
async def test_db_tenant_task_default_wins_over_system_row() -> None:
    # Tenant-first resolution (TASK-735 Phase 1 fix): TENANT_A's own ENABLED
    # AiTaskDefault row wins over the SYSTEM row for the same task key — the
    # defect this ticket fixes (previously the query pinned to SYSTEM only).
    rows = [
        _row(SYSTEM_TENANT_ID, SYSTEM_TENANT_ID, "lm-studio", "granite-guardian-4.1-8b"),
        _row(TENANT_A, SYSTEM_TENANT_ID, "vllm", "tenant-chosen-guardian"),
    ]
    cfg = await _db_resolver(rows).resolve(TENANT_A)

    assert cfg.provider == "vllm"
    assert cfg.model == "tenant-chosen-guardian"


@pytest.mark.asyncio
async def test_db_system_row_used_when_tenant_has_none() -> None:
    # Absence (no tenant-owned row) defers entirely to SYSTEM — "no opinion".
    rows = [_row(SYSTEM_TENANT_ID, SYSTEM_TENANT_ID, "lm-studio", "granite-guardian-4.1-8b")]
    cfg = await _db_resolver(rows).resolve(TENANT_A)

    assert cfg.provider == "lm-studio"
    assert cfg.model == "granite-guardian-4.1-8b"


@pytest.mark.asyncio
async def test_db_tenant_disabled_row_vetoes_selection() -> None:
    # DISABLED tenant row ⇒ veto, never a fold-through to the SYSTEM row —
    # even though a perfectly usable SYSTEM row exists.
    rows = [
        _row(SYSTEM_TENANT_ID, SYSTEM_TENANT_ID, "lm-studio", "granite-guardian-4.1-8b"),
        _row(
            TENANT_A,
            SYSTEM_TENANT_ID,
            "vllm",
            "tenant-chosen-guardian",
            resource_status="DISABLED",
        ),
    ]
    with pytest.raises(TenantSelectionVetoedError) as exc_info:
        await _db_resolver(rows).resolve(TENANT_A)

    assert exc_info.value.tenant_id == TENANT_A
    assert exc_info.value.task_key == TASK_KEY_GUARDRAIL_VALIDATE


@pytest.mark.asyncio
async def test_db_disabled_system_row_is_absent_not_a_veto() -> None:
    # A DISABLED SYSTEM row is SYSTEM's own "no opinion" (mirrors the old
    # ENABLED-only filter) — it must never veto a request for a tenant that
    # has no row of its own.
    rows = [
        _row(
            SYSTEM_TENANT_ID,
            SYSTEM_TENANT_ID,
            "lm-studio",
            "granite-guardian-4.1-8b",
            resource_status="DISABLED",
        )
    ]
    cfg = await _db_resolver(rows).resolve(TENANT_A)

    assert cfg.provider is None
    assert cfg.model is None


@pytest.mark.asyncio
async def test_db_prefers_system_model_row_over_tenant_copy() -> None:
    # SYSTEM task default joined against both the SYSTEM catalog row and a
    # tenant-owned copy of the slug → the SYSTEM catalog row wins (shared-read).
    rows = [
        _row(SYSTEM_TENANT_ID, TENANT_A, "lm-studio", "tenant-source-uri"),
        _row(SYSTEM_TENANT_ID, SYSTEM_TENANT_ID, "lm-studio", "system-source-uri"),
    ]
    cfg = await _db_resolver(rows).resolve(TENANT_A)

    assert cfg.model == "system-source-uri"


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
    assert {
        "id",
        "tenantId",
        "slug",
        "provider",
        "sourceUri",
        "_metadata",
        "resourceStatus",
    } <= colnames


def test_guardrail_task_key_contract() -> None:
    # Cross-worker contract with the seed + gateway — do NOT rename.
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


# ---------------------------------------------------------------------------
# TASK-735 / TASK-736 — the runtime cascade is exactly TWO tiers:
# request tenant → SYSTEM. `50000000-…` ("Global") is a CUSTOMER tenant used as
# a platform-admin playground; it is NOT a config tier and must never appear in
# a resolution step (`.claude/rules/00-project-context.md` §Configuration
# Principles, owner clarification 2026-08-16).
# ---------------------------------------------------------------------------

# The "Global" CUSTOMER tenant (seed `SEED_TENANT_ID`). Present in these tests
# only to prove the resolver never reads it.
GLOBAL_CUSTOMER_TENANT = "50000000-0000-0000-0000-000000000000"


@pytest.mark.asyncio
async def test_resolve_no_header_resolves_system_only() -> None:
    # A request with no X-Tenant-Id has no tenant context, so it resolves the
    # SYSTEM tier — it must never silently act as the Global customer tenant.
    data = {
        SYSTEM_TENANT_ID: {KEY_PROVIDER: "azure", KEY_MODEL: "system-model"},
        GLOBAL_CUSTOMER_TENANT: {KEY_PROVIDER: "lm-studio", KEY_MODEL: "playground-model"},
    }
    r = _resolver(data)

    cfg = await r.resolve(None)

    assert cfg.provider == "azure"
    assert cfg.model == "system-model"
    assert cfg.source_tenant_id == SYSTEM_TENANT_ID
    assert r.calls == [SYSTEM_TENANT_ID]
    assert GLOBAL_CUSTOMER_TENANT not in r.calls


@pytest.mark.asyncio
async def test_resolve_blank_header_resolves_system_only() -> None:
    data = {
        SYSTEM_TENANT_ID: {KEY_PROVIDER: "lm-studio"},
        GLOBAL_CUSTOMER_TENANT: {KEY_PROVIDER: "azure"},
    }
    r = _resolver(data)

    cfg = await r.resolve("   ")

    assert cfg.provider == "lm-studio"
    assert r.calls == [SYSTEM_TENANT_ID]


@pytest.mark.asyncio
async def test_tenant_without_rows_widens_to_system_not_the_global_customer() -> None:
    data = {
        SYSTEM_TENANT_ID: {KEY_PROVIDER: "lm-studio", KEY_MODEL: "system-model"},
        GLOBAL_CUSTOMER_TENANT: {KEY_PROVIDER: "azure", KEY_MODEL: "playground-model"},
    }
    r = _resolver(data)

    cfg = await r.resolve(TENANT_A)

    assert cfg.model == "system-model"
    assert cfg.source_tenant_id == SYSTEM_TENANT_ID
    assert r.calls == [TENANT_A, SYSTEM_TENANT_ID]


@pytest.mark.asyncio
async def test_global_customer_tenant_config_never_serves_another_tenant() -> None:
    # The Global playground holds a selection; SYSTEM holds none. A different
    # tenant must resolve EMPTY, not inherit one customer's trial config.
    data = {GLOBAL_CUSTOMER_TENANT: {KEY_PROVIDER: "azure", KEY_MODEL: "playground-model"}}
    r = _resolver(data)

    cfg = await r.resolve(TENANT_A)

    assert cfg.provider is None
    assert cfg.model is None
    assert r.calls == [TENANT_A, SYSTEM_TENANT_ID]


def test_resolver_exposes_no_default_tenant_knob() -> None:
    # SYSTEM is the DECLARED widening target, not a configurable default. A
    # second knob for it is exactly the ungoverned surface the rules ban.
    import inspect

    assert "default_tenant_id" not in inspect.signature(TenantConfigResolver.__init__).parameters


def test_database_config_has_no_default_tenant_id_field(monkeypatch) -> None:
    from guardrail.core.config import DatabaseConfig

    assert "default_tenant_id" not in DatabaseConfig.model_fields

    # The retired env var must populate nothing at all.
    monkeypatch.setenv("GUARDRAIL_DEFAULT_TENANT_ID", GLOBAL_CUSTOMER_TENANT)
    dumped = str(DatabaseConfig().model_dump())
    assert GLOBAL_CUSTOMER_TENANT not in dumped


# ---------------------------------------------------------------------------
# TASK-736 Phase C — there is no Ollama in this deployment.
# ---------------------------------------------------------------------------


def test_provider_switch_map_has_no_ollama() -> None:
    from guardrail.core.tenant_config import _PROVIDER_TO_ATTR

    assert "ollama" not in _PROVIDER_TO_ATTR


def test_settings_reject_the_ollama_provider() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        Settings(provider="ollama")


def test_settings_has_no_ollama_engine_subconfig() -> None:
    assert "ollama" not in Settings.model_fields


def test_ollama_provider_modules_are_gone() -> None:
    import importlib

    for module in ("guardrail.providers.ollama", "guardrail.providers.guardian"):
        with pytest.raises(ModuleNotFoundError):
            importlib.import_module(module)
