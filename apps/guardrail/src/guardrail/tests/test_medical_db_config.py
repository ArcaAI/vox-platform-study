"""Tests for per-tenant guardian-provider resolution at the endpoint dependency
layer. DB access is mocked via a stub resolver.

These exercise ``get_resolved_guardian_provider`` directly with a lightweight
fake request so no live DB or running server is needed.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from guardrail.core.config import Settings
from guardrail.core.dependencies import get_resolved_guardian_provider
from guardrail.core.tenant_config import GuardrailTenantConfig, TenantSelectionVetoedError
from guardrail.providers.openai_compat import OpenAICompatGuardianProvider


class _FakeRequest:
    def __init__(self, state: SimpleNamespace, headers: dict[str, str] | None = None) -> None:
        self.app = SimpleNamespace(state=state)
        self.headers = headers or {}


class _StubResolver:
    def __init__(self, cfg: GuardrailTenantConfig) -> None:
        self.cfg = cfg
        self.seen_tenant: str | None = "<unset>"

    async def resolve(self, tenant_id):  # noqa: ANN001
        self.seen_tenant = tenant_id
        return self.cfg


class _VetoStubResolver:
    """Stands in for a resolver whose tenant row is DISABLED (a veto)."""

    def __init__(self) -> None:
        self.seen_tenant: str | None = "<unset>"

    async def resolve(self, tenant_id):  # noqa: ANN001
        self.seen_tenant = tenant_id
        raise TenantSelectionVetoedError(tenant_id=tenant_id, task_key="guardrail.validate")


def _env_provider(settings: Settings) -> OpenAICompatGuardianProvider:
    return OpenAICompatGuardianProvider(settings=settings.engine, http_client=object())  # type: ignore[arg-type]


def test_db_config_enabled_defaults_true(monkeypatch) -> None:
    # DB-backed model resolution is the default. Safe even without a
    # reachable Postgres — the resolver fails open to the env-selected engine.
    monkeypatch.delenv("GUARDRAIL_DB_CONFIG_ENABLED", raising=False)
    from guardrail.core.config import DatabaseConfig

    assert DatabaseConfig().db_config_enabled is True


@pytest.mark.asyncio
async def test_db_config_disabled_returns_env_provider() -> None:
    settings = Settings()
    settings.db.db_config_enabled = False  # explicit opt-out (default is True)
    env_provider = _env_provider(settings)

    state = SimpleNamespace(
        settings=settings,
        guardian_provider=env_provider,
        http_client=object(),
        tenant_config_resolver=_StubResolver(
            GuardrailTenantConfig(provider="azure", model="should-not-be-used")
        ),
    )
    resolved = await get_resolved_guardian_provider(_FakeRequest(state))  # type: ignore[arg-type]

    # Disabled -> env provider returned unchanged, resolver never consulted.
    assert resolved is env_provider


@pytest.mark.asyncio
async def test_db_config_enabled_overrides_model_from_tenant() -> None:
    settings = Settings()
    settings.db.db_config_enabled = True
    env_provider = _env_provider(settings)
    resolver = _StubResolver(GuardrailTenantConfig(provider="lm-studio", model="tenant-guardian-x"))

    state = SimpleNamespace(
        settings=settings,
        guardian_provider=env_provider,
        http_client=object(),
        tenant_config_resolver=resolver,
    )
    request = _FakeRequest(state, headers={"X-Tenant-Id": "tenant-123"})
    resolved = await get_resolved_guardian_provider(request)  # type: ignore[arg-type]

    assert resolved is not env_provider
    assert resolved.model == "tenant-guardian-x"
    assert resolver.seen_tenant == "tenant-123"


@pytest.mark.asyncio
async def test_db_config_enabled_empty_config_fails_closed_503() -> None:
    # Fail-closed selection: DB enabled but no SYSTEM guardrail.validate row →
    # HTTP 503, never a silent env fallback (no model identity from env).
    settings = Settings()
    settings.db.db_config_enabled = True
    env_provider = _env_provider(settings)
    resolver = _StubResolver(GuardrailTenantConfig())  # nothing resolved

    state = SimpleNamespace(
        settings=settings,
        guardian_provider=env_provider,
        http_client=object(),
        tenant_config_resolver=resolver,
    )
    with pytest.raises(HTTPException) as exc_info:
        await get_resolved_guardian_provider(_FakeRequest(state))  # type: ignore[arg-type]

    assert exc_info.value.status_code == 503


@pytest.mark.asyncio
async def test_db_config_enabled_vetoed_tenant_fails_closed_503() -> None:
    # Tenant-first resolution (TASK-735 Phase 1): a DISABLED tenant row is a
    # VETO — 503, never a silent fold-through to the SYSTEM/env engine.
    settings = Settings()
    settings.db.db_config_enabled = True
    env_provider = _env_provider(settings)
    resolver = _VetoStubResolver()

    state = SimpleNamespace(
        settings=settings,
        guardian_provider=env_provider,
        http_client=object(),
        tenant_config_resolver=resolver,
    )
    request = _FakeRequest(state, headers={"X-Tenant-Id": "tenant-123"})
    with pytest.raises(HTTPException) as exc_info:
        await get_resolved_guardian_provider(request)  # type: ignore[arg-type]

    assert exc_info.value.status_code == 503
    assert resolver.seen_tenant == "tenant-123"


@pytest.mark.asyncio
async def test_db_config_enabled_but_no_resolver_fails_closed_503() -> None:
    # DB enabled but the resolver was never wired (e.g. DB unreachable at boot)
    # → fail closed with 503 rather than falling back to the env engine.
    settings = Settings()
    settings.db.db_config_enabled = True
    env_provider = _env_provider(settings)

    state = SimpleNamespace(
        settings=settings,
        guardian_provider=env_provider,
        http_client=object(),
        tenant_config_resolver=None,
    )
    with pytest.raises(HTTPException) as exc_info:
        await get_resolved_guardian_provider(_FakeRequest(state))  # type: ignore[arg-type]

    assert exc_info.value.status_code == 503
