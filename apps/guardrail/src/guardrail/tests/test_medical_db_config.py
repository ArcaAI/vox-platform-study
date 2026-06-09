"""Tests for per-tenant guardian-provider resolution at the endpoint dependency
layer (TASK-338, Phase 4). DB access is mocked via a stub resolver.

These exercise ``get_resolved_guardian_provider`` directly with a lightweight
fake request so no live DB or running server is needed.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from guardrail.core.config import Settings
from guardrail.core.dependencies import get_resolved_guardian_provider
from guardrail.core.tenant_config import GuardrailTenantConfig
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


def _env_provider(settings: Settings) -> OpenAICompatGuardianProvider:
    return OpenAICompatGuardianProvider(settings=settings.engine, http_client=object())  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_db_config_disabled_returns_env_provider() -> None:
    settings = Settings()
    assert settings.db.db_config_enabled is False
    env_provider = _env_provider(settings)

    state = SimpleNamespace(
        settings=settings,
        guardian_provider=env_provider,
        http_client=object(),
        tenant_config_resolver=_StubResolver(
            GuardrailTenantConfig(provider="ollama", model="should-not-be-used")
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
    resolver = _StubResolver(
        GuardrailTenantConfig(provider="lm-studio", model="tenant-guardian-x")
    )

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
async def test_db_config_enabled_empty_config_returns_env_provider() -> None:
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
    resolved = await get_resolved_guardian_provider(_FakeRequest(state))  # type: ignore[arg-type]

    assert resolved is env_provider


@pytest.mark.asyncio
async def test_db_config_enabled_but_no_resolver_returns_env_provider() -> None:
    settings = Settings()
    settings.db.db_config_enabled = True
    env_provider = _env_provider(settings)

    state = SimpleNamespace(
        settings=settings,
        guardian_provider=env_provider,
        http_client=object(),
        tenant_config_resolver=None,
    )
    resolved = await get_resolved_guardian_provider(_FakeRequest(state))  # type: ignore[arg-type]

    assert resolved is env_provider
