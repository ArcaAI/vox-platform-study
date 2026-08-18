"""`apps/stt` must authenticate inbound internal calls like every other service.

Before this suite, `stt` was the ONE service of six with no inbound auth at all:
`create_app` installed CORS + request-logging + request-id and nothing else, so
every `/internal/*` route on :8861 — including `POST /internal/streaming/drain`
(scale-down) and `POST /internal/cache/clear` (evict every loaded model) — was
reachable by anything that could open a socket to the port.

The contract copied here is `apps/text`'s `ServiceAuthMiddleware` (owner decision
D-D, 2026-08-17): the canonical credential is the ONE shared
`INTERNAL_ACCESS_TOKEN`, health/docs/metrics are exempt, and "no token
configured" is a deliberate local-development bypass — which therefore only
applies in local development, never in a deployed environment.

One deliberate difference from the other five services: they each accept a legacy
`<SVC>_SERVICE_TOKEN` as a backward-compatibility fallback, and **stt has none to
accept**. That absence is documented, not accidental (`.env.sample:899`,
`platform-secrets.descriptors.ts`: *"There is no `STT_SERVICE_TOKEN`"* — stt
authenticates OUTBOUND to the gateway with `X-Internal-Service-Key` +
`API_GATEWAY_KEY` instead). Inventing one to fill the pattern would be adding an
env var to a bootstrap floor that D-B says must not grow, so the accepted set has
exactly one member.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

SHARED = "shared-internal-access-token-xyz"  # noqa: S105 — test constant

# Real, sensitive, non-exempt routes — the ones the review found wide open.
DRAIN = "/internal/streaming/drain"
CACHE_CLEAR = "/internal/cache/clear"
# A non-exempt path with no handler: a request that PASSES auth reaches routing
# and 404s, so acceptance asserts `!= 401` without touching the database.
UNROUTED = "/internal/does-not-exist"


@pytest.fixture(autouse=True)
def _clean_token_env(monkeypatch):
    """Never inherit a real token (or a deployed env) from the developer's shell."""
    monkeypatch.delenv("INTERNAL_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("DEPLOYMENT_ENVIRONMENT", raising=False)
    monkeypatch.delenv("NODE_ENV", raising=False)


def _settings(**overrides):
    from stt.core.config.settings import Settings

    return Settings(metrics_enabled=False, otel_enabled=False, **overrides)


def _app(*, shared: str = "", monkeypatch=None):
    from stt.main import create_app

    if shared and monkeypatch is not None:
        monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", shared)
    return create_app(settings_override=_settings())


# ── 1. the token is configurable at all ───────────────────────────────────────


def test_shared_token_binds_to_the_unprefixed_env_name(monkeypatch):
    monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", SHARED)
    assert _settings().internal_access_token.get_secret_value() == SHARED


def test_accepted_tokens_is_the_shared_token_only(monkeypatch):
    """stt has no legacy `STT_SERVICE_TOKEN` to fall back to — by design."""
    monkeypatch.setenv("INTERNAL_ACCESS_TOKEN", SHARED)
    assert _settings().accepted_service_tokens == (SHARED,)


def test_accepted_tokens_empty_when_nothing_configured_so_dev_bypass_survives():
    assert _settings().accepted_service_tokens == ()


# ── 2. inbound enforcement ────────────────────────────────────────────────────


class TestAuthEnabled:
    @pytest_asyncio.fixture
    async def client(self, monkeypatch):
        transport = ASGITransport(app=_app(shared=SHARED, monkeypatch=monkeypatch))
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    @pytest.mark.asyncio
    async def test_drain_rejects_an_unauthenticated_call(self, client):
        """`POST /internal/streaming/drain` scales this worker down."""
        assert (await client.post(DRAIN)).status_code == 401

    @pytest.mark.asyncio
    async def test_cache_clear_rejects_an_unauthenticated_call(self, client):
        """`POST /internal/cache/clear` evicts every loaded model."""
        assert (await client.post(CACHE_CLEAR)).status_code == 401

    @pytest.mark.asyncio
    async def test_rejects_a_wrong_token(self, client):
        resp = await client.post(DRAIN, headers={"X-Service-Token": "nope"})
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_accepts_the_shared_token(self, client):
        resp = await client.post(UNROUTED, headers={"X-Service-Token": SHARED})
        assert resp.status_code == 404  # passed auth, then no such route

    @pytest.mark.asyncio
    async def test_liveness_probe_stays_exempt(self, client):
        assert (await client.get("/api/v1/health/live")).status_code == 200

    @pytest.mark.asyncio
    async def test_metrics_path_is_exempt(self, client):
        from stt.core.middleware.auth import EXEMPT_PATHS

        assert "/metrics" in EXEMPT_PATHS


# ── 3. the dev bypass is conditional on actually being in local development ────


@pytest.mark.asyncio
async def test_no_token_configured_is_a_bypass_in_local_development():
    """Unchanged, deliberate affordance: `pnpm stt:dev` with no token works."""
    transport = ASGITransport(app=_app())
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        assert (await c.post(UNROUTED)).status_code == 404


@pytest.mark.asyncio
async def test_no_token_configured_fails_closed_in_a_deployed_environment(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    transport = ASGITransport(app=_app())
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        assert (await c.post(DRAIN)).status_code == 401


@pytest.mark.asyncio
async def test_deployment_environment_also_marks_the_environment_as_deployed(monkeypatch):
    monkeypatch.setenv("DEPLOYMENT_ENVIRONMENT", "staging")
    transport = ASGITransport(app=_app())
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        assert (await c.post(DRAIN)).status_code == 401


@pytest.mark.asyncio
async def test_liveness_probe_survives_failing_closed(monkeypatch):
    """A fail-closed service must still answer its k8s probes."""
    monkeypatch.setenv("NODE_ENV", "production")
    transport = ASGITransport(app=_app())
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        assert (await c.get("/api/v1/health/live")).status_code == 200


# ── 4. PHI posture: CORS is not open to the world by default ──────────────────


def test_cors_origins_default_is_not_a_wildcard():
    """`stt` handles PHI audio; `["*"]` was the shipped default.

    Asserts the DECLARED default rather than a constructed instance: developers
    may still have an untracked `apps/stt/.env` overlay from before this change,
    and what ships is the field default plus `.env.sample`, not that file.
    """
    from stt.core.config.settings import Settings

    factory = Settings.model_fields["cors_origins"].default_factory
    assert factory is not None
    assert factory() == []  # type: ignore[call-arg]
