"""/ owner decision D-D — ONE shared internal access token.

`INTERNAL_ACCESS_TOKEN` is THE canonical internal service credential: identical
across every HOPE service, set by the DevOps engineer, internal use only. This
suite pins the three properties that make it usable as such:

1. it is read from the UNPREFIXED env name (apps/text's `env_prefix="TEXT_"` with
   `env_prefix_target="all"` would otherwise turn it into `TEXT_INTERNAL_ACCESS_TOKEN`);
2. inbound `X-Service-Token` accepts it — and ONLY it;
3. outbound peer calls PRESENT it.

lane B closed the legacy `TEXT_SERVICE_TOKEN` window. It was described
as zero-cost backward compatibility, but nothing on the other side ever used it,
and a second ACCEPTED credential is a second thing to rotate and a second thing
to forget when revoking. "One shared token" is only true if there is one.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.core.config import Settings
from text.core.guardrail_posture import GuardrailPosture
from text.main import create_app
from text.models.provider import ModelInfo, ProviderInfo
from text.services.external_guardrail import ExternalGuardrailClient

SHARED = "shared-internal-access-token-xyz"  # noqa: S105 — test constant
LEGACY = "legacy-text-service-token-abc"  # noqa: S105 — test constant


@pytest.fixture
def _mock_provider_registry():
    from text.providers.base import ProviderRegistry

    registry = ProviderRegistry()
    mock_provider = AsyncMock()
    mock_provider.health_check = AsyncMock(return_value=True)
    mock_provider.get_info = AsyncMock(
        return_value=ProviderInfo(
            name="ollama",
            display_name="Ollama",
            status="available",
            default_model="llama3.2:latest",
            models=[ModelInfo(name="llama3.2:latest")],
            supports_streaming=True,
        )
    )
    registry.register("ollama", mock_provider)
    return registry


def _make_app(settings: Settings, provider_registry):
    application = create_app(settings_override=settings)
    application.state.provider_registry = provider_registry
    application.state.task_manager = AsyncMock()
    return application


# ── 1. env binding ────────────────────────────────────────────────────────────


def test_shared_token_binds_to_the_unprefixed_env_name(monkeypatch):
    """`INTERNAL_ACCESS_TOKEN`, NOT `TEXT_INTERNAL_ACCESS_TOKEN`."""
    monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", SHARED)
    monkeypatch.setenv("TEXT_INTERNAL_ACCESS_TOKEN", "wrong-prefixed-name")
    assert Settings().internal_access_token.get_secret_value() == SHARED


def test_the_shared_token_is_the_only_accepted_one(monkeypatch):
    monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", SHARED)
    monkeypatch.setenv("TEXT_SERVICE_TOKEN", LEGACY)
    assert Settings().accepted_service_tokens == (SHARED,)


def test_accepted_tokens_empty_when_nothing_configured_so_dev_bypass_survives():
    assert Settings().accepted_service_tokens == ()


# ── 2. inbound acceptance ─────────────────────────────────────────────────────


class TestInboundAcceptsSharedToken:
    @pytest_asyncio.fixture
    async def client(self, _mock_provider_registry, monkeypatch):
        monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", SHARED)
        monkeypatch.setenv("TEXT_SERVICE_TOKEN", LEGACY)
        settings = Settings(port=5099)
        app = _make_app(settings, _mock_provider_registry)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_shared_token_is_accepted(self, client):
        resp = await client.get("/api/v1/providers", headers={"X-Service-Token": SHARED})
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_the_legacy_token_is_no_longer_accepted(self, client):
        """The transition window is closed: a second accepted credential is a
        second thing to rotate."""
        resp = await client.get("/api/v1/providers", headers={"X-Service-Token": LEGACY})
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_unknown_token_is_still_rejected(self, client):
        resp = await client.get("/api/v1/providers", headers={"X-Service-Token": "nope"})
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_missing_token_is_still_rejected(self, client):
        resp = await client.get("/api/v1/providers")
        assert resp.status_code == 401


# ── 3. outbound preference ────────────────────────────────────────────────────


def test_peer_service_token_presents_the_shared_token(monkeypatch):
    monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", SHARED)
    monkeypatch.setenv("TEXT_SERVICE_TOKEN", LEGACY)
    assert Settings().peer_service_token() == SHARED


def test_peer_service_token_is_empty_when_the_shared_token_is_unset(monkeypatch):
    """No silent fallback onto a legacy secret: an unconfigured deployment
    presents nothing, which is the visible failure, not a quiet one."""
    monkeypatch.delenv("INTERNAL_ACCESS_TOKEN", raising=False)
    monkeypatch.setenv("TEXT_SERVICE_TOKEN", LEGACY)
    assert Settings().peer_service_token() == ""


@pytest.mark.asyncio
async def test_outbound_guardrail_call_presents_the_injected_shared_token():
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        return httpx.Response(200, json={"is_medical": True, "confidence": 1.0})

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = ExternalGuardrailClient(
        base_url="http://guardrail.test",
        http_client=http_client,
        service_token=SHARED,
        app_state=SimpleNamespace(guardrail_posture=GuardrailPosture(enabled=True)),
    )
    await client.validate("chest pain", tenant_id="11111111-1111-1111-1111-111111111111")
    await http_client.aclose()

    assert seen["x-service-token"] == SHARED
