"""TASK-990 — the health-check contract this service must honour.

* **F9** — ``/health`` stays HTTP **200** whatever the body says, and this file
  pins that so the next reader does not "fix" it. The finding named the risk of
  a probe pointed at an endpoint that cannot fail; the resolution is that no
  probe may point here at all. A misconfigured pod has to stay able to REPORT
  that it is unwell — the same rationale that keeps these paths auth-exempt —
  and the gateway answers identically (200 with ``status: "degraded"`` in the
  body). Failure is expressed on the three probe routes instead.
* **F6** — ``/health`` reports the RUNNING image's version
  (``/app/build-info.json``) instead of the inline literal ``"1.0.0"``.
* **F7** — ``/health/startup`` exists at BOTH mounted prefixes (this router is
  included at ``/api`` and ``/api/v1``) and both are exempt from the
  service-token middleware. Before this it was answered 401, not 404.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from fastapi import FastAPI
from hope_env import BuildInfoReader
from httpx import ASGITransport, AsyncClient

from guardrail.api.endpoints.health import router as health_router
from guardrail.core.config import Settings

_RETIRED_LITERAL = "1.0.0"
#: Both spellings this router is mounted under (`guardrail.main`).
_PREFIXES = ("/api", "/api/v1")


def _make_app(*, redis_ok: bool, lifespan_ran: bool = True) -> FastAPI:
    app = FastAPI()
    redis_client = AsyncMock()
    redis_client.ping = (
        AsyncMock(return_value=True)
        if redis_ok
        else AsyncMock(side_effect=ConnectionError("redis unreachable"))
    )
    app.state.redis = redis_client
    # `/health` resolves `get_settings` off app.state to echo its delegation
    # targets; the pre-existing readiness/liveness tests never needed it.
    app.state.settings = Settings()
    if lifespan_ran:

        # The marker every one of the six services' lifespans assigns
        # unconditionally, and no `create_app` does. Its VALUE is meaningless
        # (`None` when gateway registration is disabled); only its presence is
        # the signal.
        app.state.service_release_task = None
    for prefix in _PREFIXES:
        app.include_router(health_router, prefix=prefix)
    return app


@pytest_asyncio.fixture
async def healthy_client():
    async with AsyncClient(
        transport=ASGITransport(app=_make_app(redis_ok=True)), base_url="http://test"
    ) as client:
        yield client


@pytest_asyncio.fixture
async def uninitialised_client():
    """The health router on an app assembled WITHOUT its lifespan."""
    async with AsyncClient(
        transport=ASGITransport(app=_make_app(redis_ok=True, lifespan_ran=False)),
        base_url="http://test",
    ) as client:
        yield client


@pytest_asyncio.fixture
async def redis_down_client():
    async with AsyncClient(
        transport=ASGITransport(app=_make_app(redis_ok=False)), base_url="http://test"
    ) as client:
        yield client


class TestHealthIsInformationalOnly:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("prefix", _PREFIXES)
    async def test_health_is_200_and_healthy_when_redis_is_up(self, healthy_client, prefix):
        resp = await healthy_client.get(f"{prefix}/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "healthy"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("prefix", _PREFIXES)
    async def test_health_stays_200_with_redis_down_and_says_so_in_the_body(
        self, redis_down_client, prefix
    ):
        """Pins the DECIDED contract, not an accident.

        A 503 here would be a regression, not a fix: this route is never probed,
        and a pod that cannot report its own illness is worse than one reporting
        it over a 200. The verdict belongs in `status`, which is asserted here so
        the endpoint still carries the information a 503 would have carried.
        """
        resp = await redis_down_client.get(f"{prefix}/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "degraded"
        assert body["checks"]["redis"]["status"] == "unhealthy"
        assert "redis unreachable" in body["checks"]["redis"]["error"]

    @pytest.mark.asyncio
    async def test_the_probe_routes_are_where_failure_is_expressed(self, redis_down_client):
        """The division of labour the decided contract rests on.

        `/health` informational (always 200) · `/health/live` process ·
        `/health/ready` dependencies · `/health/startup` initialisation.
        """
        assert (await redis_down_client.get("/api/health")).status_code == 200
        assert (await redis_down_client.get("/api/health/live")).status_code == 200
        assert (await redis_down_client.get("/api/health/ready")).status_code == 503

    @pytest.mark.asyncio
    async def test_delegated_peers_are_reported_but_never_probed(self, healthy_client):
        """Delegation is configuration, not a health verdict.

        Probing `text`/`nlp` on every poll would make a peer's slowness look like
        guardrail being unhealthy — and would put the gateway on guardrail's
        safety-critical path.
        """
        checks = (await healthy_client.get("/api/health")).json()["checks"]
        assert checks["llm_judge"]["status"] == "delegated"
        assert checks["classification"]["status"] == "delegated"


class TestBuildIdentity:
    @pytest.mark.asyncio
    async def test_health_reports_the_build_info_version(self, healthy_client):
        body = (await healthy_client.get("/api/health")).json()
        assert body["version"] == BuildInfoReader().get_build_info().version

    @pytest.mark.asyncio
    async def test_health_no_longer_reports_the_source_literal(self, healthy_client):
        body = (await healthy_client.get("/api/health")).json()
        assert body["version"] != _RETIRED_LITERAL
        assert body["version"].startswith("0.0.0-")

    @pytest.mark.asyncio
    async def test_version_is_still_reported_when_degraded(self, redis_down_client):
        """The degraded body must stay as diagnostic as the healthy one.

        Knowing WHICH build is answering matters most when something is wrong.
        """
        body = (await redis_down_client.get("/api/health")).json()
        assert body["version"] == BuildInfoReader().get_build_info().version
        assert body["service"] == "guardrail"


class TestStartupProbe:
    """The startup probe must be able to FAIL, or it is not a probe."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("prefix", _PREFIXES)
    async def test_startup_is_503_on_an_app_whose_lifespan_never_ran(
        self, uninitialised_client, prefix
    ):
        resp = await uninitialised_client.get(f"{prefix}/health/startup")
        assert resp.status_code == 503
        assert resp.json()["status"] == "unhealthy"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("prefix", _PREFIXES)
    async def test_startup_is_200_once_the_lifespan_marker_is_present(self, healthy_client, prefix):
        resp = await healthy_client.get(f"{prefix}/health/startup")
        assert resp.status_code == 200
        assert resp.json()["status"] == "healthy"

    @pytest.mark.asyncio
    async def test_startup_does_not_ping_redis(self, redis_down_client):
        """Startup asks "did initialisation finish", not "is Redis up".

        Re-checking the dependency here would make an outage look like a failed
        start and restart a healthy pod.
        """
        assert (await redis_down_client.get("/api/health/startup")).status_code == 200
        # ...while the route that DOES own that question still refuses.
        assert (await redis_down_client.get("/api/health/ready")).status_code == 503

    def test_startup_is_exempt_at_both_prefixes(self):
        from guardrail.api.middleware.auth import EXEMPT_PATHS

        for prefix in _PREFIXES:
            assert f"{prefix}/health/startup" in EXEMPT_PATHS

    def test_all_four_contract_routes_are_exempt_at_both_prefixes(self):
        from guardrail.api.middleware.auth import EXEMPT_PATHS

        for prefix in _PREFIXES:
            for suffix in ("", "/live", "/ready", "/startup"):
                assert f"{prefix}/health{suffix}" in EXEMPT_PATHS
