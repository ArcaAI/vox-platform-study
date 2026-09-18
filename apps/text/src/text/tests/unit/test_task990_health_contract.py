"""TASK-990 — the health-check contract this service must honour.

* **F6** — ``/health`` reports the RUNNING image's version (``/app/build-info.json``)
  instead of the source literal ``"2.0.0"``. Verified live before the fix:
  ``hope-text``'s image carried ``0.0.0-dev-2-2.96bf9a52`` while its ``/health``
  answered ``2.0.0``, so during a rollout you could not tell which build replied.
* **F7** — ``/health/startup`` exists and is exempt from the service-token
  middleware. Before this it was answered 401, not 404: the middleware refuses an
  unknown path before FastAPI can route it, so the missing route looked like an
  auth fault.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from hope_env import BuildInfoReader
from httpx import ASGITransport, AsyncClient

from text.providers.base import ProviderRegistry

_RETIRED_LITERAL = "2.0.0"


@pytest_asyncio.fixture
async def health_client(app):
    """A client whose app can actually serve `/health`.

    The shared `app` fixture never runs the lifespan, so `provider_registry` is
    `None` and the detailed handler raises before it can report anything. These
    tests are about the VERSION field, so the registry only has to exist.
    """
    provider = AsyncMock()
    provider.health_check = AsyncMock(return_value=True)
    registry = ProviderRegistry()
    registry.register("ollama", provider)
    app.state.provider_registry = registry
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client


class TestBuildIdentity:
    @pytest.mark.asyncio
    async def test_health_reports_the_build_info_version(self, health_client):
        body = (await health_client.get("/api/v1/health")).json()
        assert body["version"] == BuildInfoReader().get_build_info().version

    @pytest.mark.asyncio
    async def test_health_no_longer_reports_the_source_literal(self, health_client):
        body = (await health_client.get("/api/v1/health")).json()
        assert body["version"] != _RETIRED_LITERAL
        assert body["version"].startswith("0.0.0-")

    @pytest.mark.asyncio
    async def test_health_does_not_leak_build_provenance(self, health_client):
        """`/health` is auth-exempt and public.

        Branch, SHA and pipeline id are operator data and belong behind an
        admin-gated surface — the gateway surfaces `version` and nothing else,
        and this route must not quietly grow the rest of the contract.
        """
        body = (await health_client.get("/api/v1/health")).json()
        for leaked in (
            "gitCommitSha",
            "git_commit_sha",
            "gitBranch",
            "git_branch",
            "ciPipelineId",
            "ci_pipeline_id",
            "releaseTag",
            "release_tag",
        ):
            assert leaked not in body


class TestStartupProbe:
    """The startup probe must be able to FAIL, or it is not a probe."""

    @pytest.mark.asyncio
    async def test_startup_is_503_on_an_app_whose_lifespan_never_ran(self, async_client):
        resp = await async_client.get("/api/v1/health/startup")
        assert resp.status_code == 503
        assert resp.json()["status"] == "unhealthy"

    @pytest.mark.asyncio
    async def test_startup_is_200_once_the_lifespan_marker_is_present(self, app, async_client):
        app.state.service_release_task = object()
        resp = await async_client.get("/api/v1/health/startup")
        assert resp.status_code == 200
        assert resp.json() == {"status": "healthy"}

    @pytest.mark.asyncio
    async def test_a_none_marker_still_counts_as_started(self, app, async_client):
        """Registration disabled leaves the marker `None`, and that app IS started."""
        app.state.service_release_task = None
        assert (await async_client.get("/api/v1/health/startup")).status_code == 200

    def test_startup_is_exempt_from_service_auth(self):
        from text.api.middleware.auth import EXEMPT_PATHS

        assert "/api/v1/health/startup" in EXEMPT_PATHS

    def test_all_four_contract_routes_are_exempt(self):
        from text.api.middleware.auth import EXEMPT_PATHS

        for suffix in ("", "/live", "/ready", "/startup"):
            assert f"/api/v1/health{suffix}" in EXEMPT_PATHS

    @pytest.mark.no_default_tenant_header
    @pytest.mark.asyncio
    async def test_startup_needs_neither_a_token_nor_a_tenant_header(self, app):
        """The exemption has to clear BOTH gates this middleware enforces.

        `ServiceAuthMiddleware` checks the service token and then, separately and
        un-bypassably, the `X-Tenant-Id` precondition (428). A probe carries
        neither header, so an exemption that only cleared the first would still
        answer 428.
        """
        from httpx import ASGITransport, AsyncClient

        app.state.service_release_task = None
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/v1/health/startup")
        assert resp.status_code == 200
