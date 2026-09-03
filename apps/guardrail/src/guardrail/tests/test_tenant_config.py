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
    TENANTLESS_PREFIX,
    AiModelRead,
    AiTaskDefaultRead,
    GuardrailTenantConfig,
    TenantConfigResolver,
    TenantConfigUnavailableError,
    TenantSelectionVetoedError,
    build_judge_client,
    is_tenantless_marker,
)

# Ordinary customer tenants. Deliberately NOT in the reserved `50000000-…`
# range: that id is the "Global" customer tenant, and the whole point of the
# /736 fix is that it is not a tier the resolver may reach for.
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
        provider=None,
        model=None,
        azure_deployment=None,
        source_tenant_id=SYSTEM_TENANT_ID,
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
    data = {
        SYSTEM_TENANT_ID: {
            KEY_PROVIDER: "lm-studio",
            KEY_MODEL: "granite-guardian-4.1-8b",
        }
    }
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
# A failed READ is not an absent row. It used to resolve to
# empty and be negatively cached, which `resolve()` reads as "no tenant opinion"
# and widens to SYSTEM — silently serving the platform safety FLOOR to a tenant
# that may have chosen something stricter, for a whole TTL window. It now raises,
# and is deliberately NOT cached: a veto is a stable declaration and may be
# cached, a transient error must not outlive the condition that caused it.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_db_error_raises_rather_than_resolving_to_empty() -> None:
    r = _resolver({})
    r.raise_on = {TENANT_A, SYSTEM_TENANT_ID}

    with pytest.raises(TenantConfigUnavailableError):
        await r.resolve(TENANT_A)


@pytest.mark.asyncio
async def test_db_error_does_not_widen_to_system() -> None:
    # SYSTEM has a perfectly usable row; the tenant's read failed, so we do not
    # KNOW the tenant has no opinion and must not answer with the platform's.
    r = _resolver({SYSTEM_TENANT_ID: {KEY_PROVIDER: "lm-studio"}})
    r.raise_on = {TENANT_A}

    with pytest.raises(TenantConfigUnavailableError):
        await r.resolve(TENANT_A)

    assert r.calls == [TENANT_A]  # the SYSTEM widening never ran


@pytest.mark.asyncio
async def test_db_error_is_not_cached_so_recovery_is_immediate() -> None:
    clock = _Clock()
    data = {TENANT_A: {KEY_PROVIDER: "vllm"}}
    r = _resolver(data, clock=clock, ttl=60)
    r.raise_on = {TENANT_A}

    with pytest.raises(TenantConfigUnavailableError):
        await r.resolve(TENANT_A)

    r.raise_on.clear()
    # No clock advance: a recovered DB is served at once, not after the TTL.
    assert (await r.resolve(TENANT_A)).provider == "vllm"


@pytest.mark.asyncio
async def test_db_error_costs_one_session_attempt_per_resolve() -> None:
    # Real _load_from_db path. Load-shedding for an unreachable DB comes from
    # single-flight coalescing (concurrent callers share one attempt), not from
    # caching the failure — see test_task777_policy_plane.py.
    count = 0

    def factory() -> _FakeSession:
        nonlocal count
        count += 1
        return _FakeSession(exc=RuntimeError("connection refused"))

    r = TenantConfigResolver(session_factory=factory, cache_ttl_s=60)

    for _ in range(2):
        with pytest.raises(TenantConfigUnavailableError):
            await r.resolve(TENANT_A)

    assert count == 2  # one attempt per resolve; no SYSTEM widening after a failure


# ---------------------------------------------------------------------------
# Delegation: map a resolved per-tenant selection onto the judge client
#
# There is no engine sub-config to map onto any more :
# guardrail hosts no LLM, so a resolved selection produces a CLIENT pointed at
# `apps/text`'s judge lane, carrying the provider/model the DB chose.
# ---------------------------------------------------------------------------


def _settings() -> Settings:
    return Settings()


# criteria is CONFIG (failMode=closed) with no code default.
_POLICY = {"medicalValidationCriteria": "you are a medical context validator"}


def _client(cfg: GuardrailTenantConfig, settings: Settings | None = None):
    from dataclasses import replace

    if cfg.policy is None:
        cfg = replace(cfg, policy=_POLICY)
    return build_judge_client(
        settings or _settings(), cfg, http_client=object(), tenant_id=TENANT_A
    )


def test_selection_is_sent_to_text_verbatim() -> None:
    client = _client(GuardrailTenantConfig(provider="lm-studio", model="my-custom-guardian"))

    assert client.provider == "lm-studio"
    assert client.model == "my-custom-guardian"


def test_provider_switch_is_passed_through_not_mapped_to_a_local_engine() -> None:
    """`text` owns the adapter registry; guardrail must not second-guess the name."""
    client = _client(GuardrailTenantConfig(provider="vllm", model="self-hosted-guardian"))

    assert client.provider == "vllm"
    assert client.model == "self-hosted-guardian"


def test_azure_deployment_takes_precedence_over_the_model_name() -> None:
    client = _client(
        GuardrailTenantConfig(
            provider="azure",
            model="ignored-model",
            azure_deployment="prod-guardian-deploy",
        )
    )

    assert client.provider == "azure"
    assert client.model == "prod-guardian-deploy"


def test_the_client_carries_no_credential_of_its_own() -> None:
    """BYOK end-to-end: the key travels as an opaque pass-through or not at all."""
    client = _client(GuardrailTenantConfig(provider="lm-studio", model="m"))

    assert not hasattr(client, "api_key")
    assert client.provider_overrides is None


def test_the_client_targets_the_isolated_judge_lane() -> None:
    from guardrail.services.external_text_client import JUDGE_PATH

    settings = _settings()
    client = _client(GuardrailTenantConfig(provider="lm-studio", model="m"), settings)

    assert client.base_url == settings.text_url.rstrip("/")
    assert JUDGE_PATH == "/api/v1/generate/internal/judge"


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
    # Tenant-first resolution ( fix): TENANT_A's own ENABLED
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
async def test_db_prefers_the_tenants_own_model_row_over_the_system_copy() -> None:
    # SYSTEM task default joined against both catalog rows → the TENANT's own
    # row wins. The tie-break used to prefer SYSTEM, which is the
    # one thing a tenant-owned registry row cannot mean.
    rows = [
        _row(SYSTEM_TENANT_ID, TENANT_A, "lm-studio", "tenant-source-uri"),
        _row(SYSTEM_TENANT_ID, SYSTEM_TENANT_ID, "lm-studio", "system-source-uri"),
    ]
    cfg = await _db_resolver(rows).resolve(TENANT_A)

    assert cfg.model == "tenant-source-uri"


@pytest.mark.asyncio
async def test_db_no_rows_resolves_empty_and_the_caller_fails_closed() -> None:
    cfg = await _db_resolver([]).resolve(TENANT_A)

    assert cfg.provider is None
    assert cfg.model is None
    assert cfg.azure_deployment is None


@pytest.mark.asyncio
async def test_db_session_error_raises_and_the_caller_fails_closed() -> None:
    with pytest.raises(TenantConfigUnavailableError):
        await _db_resolver(exc=RuntimeError("connection refused")).resolve(TENANT_A)


@pytest.mark.asyncio
async def test_db_null_provider_column_yields_no_provider_opinion() -> None:
    """A NULL provider column used to fall back to the env engine. There is no env
    engine any more, so it resolves to "no opinion" and the dependency layer fails
    closed with 503 — a half-resolved selection is not a selection."""
    rows = [_row(TENANT_A, SYSTEM_TENANT_ID, None, "some-source-uri")]
    cfg = await _db_resolver(rows).resolve(TENANT_A)

    assert cfg.provider is None
    assert cfg.model == "some-source-uri"


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
# / — the runtime cascade is exactly TWO tiers:
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
        GLOBAL_CUSTOMER_TENANT: {
            KEY_PROVIDER: "lm-studio",
            KEY_MODEL: "playground-model",
        },
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
# there is no Ollama in this deployment.
# ---------------------------------------------------------------------------


def test_no_engine_switch_map_survives() -> None:
    """removed Ollama; removed the whole map with the
    engines it addressed. A provider name is now a pass-through token for `text`,
    not a key into guardrail's own adapter table."""
    import guardrail.core.tenant_config as tc

    assert not hasattr(tc, "_PROVIDER_TO_ATTR")


def test_settings_has_no_engine_subconfig_at_all() -> None:
    for engine in (
        "ollama",
        "openai_compat",
        "vllm",
        "llama_cpp",
        "azure",
        "bedrock",
        "provider",
    ):
        assert engine not in Settings.model_fields


def test_engine_provider_modules_are_gone() -> None:
    import importlib

    for module in (
        "guardrail.providers.ollama",
        "guardrail.providers.guardian",
        "guardrail.providers.openai_compat",
        "guardrail.providers._granite",
    ):
        with pytest.raises(ModuleNotFoundError):
            importlib.import_module(module)


# ---------------------------------------------------------------------------
# a DECLARED tenant-less call is not the same thing as a missing one
# ---------------------------------------------------------------------------


def test_tenantless_marker_is_recognized_and_is_never_uuid_shaped() -> None:
    """The marker must fail any `looksLikeUuid()` check by construction.

    That is the whole reason it is `tenantless:<reason>` and not a reserved UUID:
    a future bug that treats it as a real tenant id trips existing validation
    instead of silently addressing some tenant's rows. It must also never be the
    `50000000-…` "Global" CUSTOMER tenant.
    """
    assert is_tenantless_marker("tenantless:job-queue")
    assert is_tenantless_marker("tenantless:control-plane")
    assert not is_tenantless_marker(TENANT_A)
    assert not is_tenantless_marker(SYSTEM_TENANT_ID)
    assert not is_tenantless_marker("")
    assert not is_tenantless_marker(None)
    assert not is_tenantless_marker("50000000-0000-0000-0000-000000000000")

    import uuid

    for reason in ("job-queue", "worker-weights", "control-plane", "platform-operator"):
        with pytest.raises(ValueError):
            uuid.UUID(f"{TENANTLESS_PREFIX}{reason}")


@pytest.mark.asyncio
async def test_declared_tenantless_call_resolves_system_not_a_customer_tenant() -> None:
    """A `tenantless:*` marker routes to SYSTEM — explicitly, not by None-coercion.

    The distinction matters for what it leaves behind: once declared tenant-less
    work carries a marker, an ABSENT header is unambiguously a caller defect, which
    is what makes 's later tightening possible at all.
    """
    rows = [
        _row(SYSTEM_TENANT_ID, SYSTEM_TENANT_ID, "lm-studio", "granite-guardian-4.1-8b"),
        _row(TENANT_A, SYSTEM_TENANT_ID, "vllm", "tenant-chosen-guardian"),
    ]
    cfg = await _db_resolver(rows).resolve("tenantless:job-queue")

    assert cfg.provider == "lm-studio", "must not pick up a customer tenant's row"
    assert cfg.model == "granite-guardian-4.1-8b"


@pytest.mark.asyncio
async def test_tenantless_marker_resolves_identically_to_an_absent_tenant() -> None:
    rows = [_row(SYSTEM_TENANT_ID, SYSTEM_TENANT_ID, "lm-studio", "granite-guardian-4.1-8b")]

    declared = await _db_resolver(rows).resolve("tenantless:control-plane")
    absent = await _db_resolver(rows).resolve(None)

    assert (declared.provider, declared.model) == (absent.provider, absent.model)
