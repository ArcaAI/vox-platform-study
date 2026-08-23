"""TASK-799 Phase 0 (lane A, apps/text) — the three fixes that are not F-01.

* **F-07** — Vertex's tenant-credential path used to fail OPEN: any exception while
  building a tenant's client returned ``self._client``, the PLATFORM client, while
  ``funding`` stayed ``tenant``. A tenant with a revoked key silently ran on the
  platform's Google account, billed as BYOK. It must raise.
* **F-06** — ``main.py`` presented ``settings.service_token`` directly at two
  gateway-facing call sites instead of ``settings.peer_service_token(...)``.
  Configured the way owner decision D-D specifies (shared ``INTERNAL_ACCESS_TOKEN``
  set, legacy per-service token empty) both sites sent an EMPTY token and 401 —
  and the failure was negative-cached, so each pod silently degraded to its env
  values with one warning per minute.
* **F-10** — ``X-Tenant-Id`` was enforced per-route, at 2 of 8 handlers. It is now a
  middleware precondition, so a NEW route inherits the guard instead of opting in.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from text.core.config import Settings, VertexConfig
from text.core.exceptions import ProviderCredentialsError
from text.models.requests import GenerateRequest, ProviderOverride
from text.providers.vertex import VertexProvider

# ---------------------------------------------------------------------------
# F-07 — Vertex fails CLOSED on a broken tenant credential
# ---------------------------------------------------------------------------


class TestVertexFailsClosedOnBrokenOverride:
    def test_unparseable_service_account_raises(self):
        """A tenant override that is not valid service-account JSON must raise, not
        silently fall through to the platform client."""
        provider = VertexProvider(VertexConfig(project="platform-project"))
        request = GenerateRequest(
            prompt="hi",
            provider="vertex",
            model="m",
            provider_overrides={"vertex": ProviderOverride(api_key=SecretStr("not-json"))},
        )
        with pytest.raises(ProviderCredentialsError) as exc:
            provider._client_for(request)
        assert exc.value.error_code == "PROVIDER_CREDENTIALS_MISSING"

    def test_error_message_never_carries_the_key(self):
        secret = "super-secret-service-account-material"
        provider = VertexProvider(VertexConfig(project="platform-project"))
        request = GenerateRequest(
            prompt="hi",
            provider="vertex",
            model="m",
            provider_overrides={"vertex": ProviderOverride(api_key=SecretStr(secret))},
        )
        with pytest.raises(ProviderCredentialsError) as exc:
            provider._client_for(request)
        assert secret not in str(exc.value)

    def test_structurally_valid_but_unusable_key_also_raises(self):
        """Well-formed JSON that is not a usable service account still raises — the
        fall-through caught EVERY exception, so this shape reached the platform
        client too."""
        provider = VertexProvider(VertexConfig(project="platform-project"))
        request = GenerateRequest(
            prompt="hi",
            provider="vertex",
            model="m",
            provider_overrides={
                "vertex": ProviderOverride(api_key=SecretStr(json.dumps({"type": "nonsense"})))
            },
        )
        with pytest.raises(ProviderCredentialsError):
            provider._client_for(request)


# ---------------------------------------------------------------------------
# F-06 — the shared internal token is PRESENTED on outbound gateway calls
# ---------------------------------------------------------------------------


class TestSharedInternalTokenIsPresented:
    """D-D posture: shared ``INTERNAL_ACCESS_TOKEN`` set, legacy ``TEXT_SERVICE_TOKEN``
    empty. Both gateway-facing constructions must carry the shared token."""

    @pytest.fixture
    def settings(self, monkeypatch) -> Settings:
        monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", "shared-internal-token")
        monkeypatch.delenv("TEXT_SERVICE_TOKEN", raising=False)
        return Settings(_env_file=None, host="127.0.0.1", port=5099, metrics_enabled=False)

    def test_settings_expose_the_shared_token_only_via_the_helper(self, settings):
        assert settings.service_token.get_secret_value() == ""
        assert settings.peer_service_token(settings.service_token) == "shared-internal-token"

    @pytest.mark.asyncio
    async def test_effective_config_client_and_registration_carry_the_shared_token(
        self, settings, monkeypatch
    ):
        """Both call sites are exercised through the REAL ``lifespan`` so the test
        cannot drift from the wiring it locks."""
        from text.main import create_app

        captured: dict[str, object] = {}

        class _StubEffectiveConfigClient:
            def __init__(self, *, base_url, token, service):
                captured["effective_config_token"] = token

            async def close(self) -> None:
                return None

        def _stub_start_registration(*, service_token, **_kwargs):
            captured["registration_token"] = service_token
            return None

        monkeypatch.setattr(
            "text.core.effective_config.EffectiveConfigClient", _StubEffectiveConfigClient
        )
        monkeypatch.setattr("text.main.start_registration", _stub_start_registration)

        mock_redis = AsyncMock()
        mock_redis.aclose = AsyncMock()
        with patch("text.main.aioredis") as mock_aioredis:
            mock_aioredis.from_url.return_value = mock_redis
            app = create_app(settings_override=settings)
            async with app.router.lifespan_context(app):
                pass

        assert captured["effective_config_token"] == "shared-internal-token"
        assert captured["registration_token"] == "shared-internal-token"


# ---------------------------------------------------------------------------
# F-10 — X-Tenant-Id is a MIDDLEWARE precondition, inherited by every route
# ---------------------------------------------------------------------------

# The routes F-10 found unguarded. `/translate` is the sharp one: it carries a
# tenant's Sarvam BYO credential and declared no tenant header at all.
_TENANT_SCOPED_REQUESTS: list[tuple[str, str, dict | None]] = [
    ("POST", "/api/v1/generate", {"prompt": "hi", "provider": "openai", "model": "m"}),
    ("POST", "/api/v1/generate/batch", {"prompt": "hi", "provider": "openai", "model": "m"}),
    (
        "POST",
        "/api/v1/generate/internal/judge",
        {"prompt": "hi", "provider": "openai", "model": "m"},
    ),
    (
        "POST",
        "/api/v1/translate",
        {
            "texts": ["hello"],
            "source_language": "auto",
            "target_language": "en-IN",
            "provider": "sarvam",
        },
    ),
    ("POST", "/api/v1/embeddings", {"texts": ["hello"]}),
    ("POST", "/api/v1/embeddings/batch", {"texts": ["hello"]}),
    ("GET", "/api/v1/providers", None),
    ("GET", "/api/v1/tasks/some-task-id", None),
]

_EXEMPT_REQUESTS = [
    ("GET", "/api/v1/health/live"),
    ("GET", "/api/v1/health/ready"),
    ("GET", "/metrics"),
]


@pytest.mark.no_default_tenant_header
class TestTenantHeaderIsEnforcedInMiddleware:
    @pytest.fixture
    async def client(self):
        from text.main import create_app

        settings = Settings(
            _env_file=None, host="127.0.0.1", port=5099, debug=True, metrics_enabled=False
        )
        app = create_app(settings_override=settings)
        app.state.settings = settings
        # The app is deliberately UNWIRED (no lifespan): these cases are about the
        # precondition, which runs before any handler, so a route that then fails on
        # its missing dependencies is the expected outcome for an ACCEPTED request.
        # `raise_app_exceptions=False` turns that into a 500 response rather than a
        # raise, so "not 428" stays assertable.
        transport = ASGITransport(app=app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("method", "path", "body"),
        _TENANT_SCOPED_REQUESTS,
        ids=[f"{m}{p}" for m, p, _ in _TENANT_SCOPED_REQUESTS],
    )
    async def test_absent_header_is_428(self, client, method, path, body):
        resp = await client.request(method, path, json=body)
        assert resp.status_code == 428, (
            f"{method} {path} answered {resp.status_code} with no X-Tenant-Id. "
            "Enforcement is a middleware precondition — a route must not be able to "
            "opt out by simply not declaring the header."
        )

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("method", "path", "body"),
        _TENANT_SCOPED_REQUESTS,
        ids=[f"{m}{p}" for m, p, _ in _TENANT_SCOPED_REQUESTS],
    )
    async def test_blank_header_is_428(self, client, method, path, body):
        resp = await client.request(method, path, json=body, headers={"X-Tenant-Id": "   "})
        assert resp.status_code == 428

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("method", "path", "body"),
        _TENANT_SCOPED_REQUESTS,
        ids=[f"{m}{p}" for m, p, _ in _TENANT_SCOPED_REQUESTS],
    )
    async def test_declared_tenantless_marker_is_not_refused(self, client, method, path, body):
        """A DECLARED ``tenantless:<reason>`` is a legitimate value — genuinely
        tenant-less internal work says so rather than arriving indistinguishable
        from a header dropped in transit. The route may still fail for its own
        reasons; it must not fail the PRECONDITION."""
        resp = await client.request(
            method, path, json=body, headers={"X-Tenant-Id": "tenantless:control-plane"}
        )
        assert resp.status_code != 428

    @pytest.mark.asyncio
    async def test_428_detail_names_the_contract(self, client):
        resp = await client.post(
            "/api/v1/generate", json={"prompt": "hi", "provider": "openai", "model": "m"}
        )
        detail = resp.json()["detail"]
        assert "X-Tenant-Id" in detail
        assert "tenantless:" in detail

    @pytest.mark.asyncio
    @pytest.mark.parametrize(("method", "path"), _EXEMPT_REQUESTS, ids=[p for _, p in _EXEMPT_REQUESTS])
    async def test_exempt_paths_need_no_tenant(self, client, method, path):
        resp = await client.request(method, path)
        assert resp.status_code != 428

    @pytest.mark.asyncio
    async def test_enforcement_is_independent_of_the_service_token_bypass(self, monkeypatch):
        """The dev bypass for an unconfigured ``X-Service-Token`` must not also
        disable the tenant precondition — they are separate contracts."""
        from text.main import create_app

        monkeypatch.delenv("INTERNAL_ACCESS_TOKEN", raising=False)
        monkeypatch.delenv("TEXT_SERVICE_TOKEN", raising=False)
        settings = Settings(
            _env_file=None, host="127.0.0.1", port=5099, debug=True, metrics_enabled=False
        )
        assert settings.accepted_service_tokens == ()

        app = create_app(settings_override=settings)
        app.state.settings = settings
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            resp = await ac.post(
                "/api/v1/generate", json={"prompt": "hi", "provider": "openai", "model": "m"}
            )
        assert resp.status_code == 428
