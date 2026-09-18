"""TASK-990 — the health-check contract this service must honour.

* **F6** — ``/health`` reports the RUNNING image's version
  (``/app/build-info.json``) instead of ``harness.__version__``, a source
  literal that answered the same string for every image ever built.
* **F7** — ``/health/startup`` exists. This service carries no service-token
  middleware, so unlike its five siblings the path 404'd rather than 401'd —
  the route was simply absent.
"""

from __future__ import annotations

import pytest
from hope_env import BuildInfoReader


class TestBuildIdentity:
    @pytest.mark.asyncio
    async def test_health_reports_the_build_info_version(self, async_client):
        body = (await async_client.get("/api/v1/health")).json()
        assert body["version"] == BuildInfoReader().get_build_info().version

    @pytest.mark.asyncio
    async def test_health_version_is_not_the_package_literal(self, async_client):
        from harness import __version__

        body = (await async_client.get("/api/v1/health")).json()
        assert body["version"] != __version__
        assert body["version"].startswith("0.0.0-")


class TestStartupProbe:
    """The startup probe must be able to FAIL, or it is not a probe."""

    @pytest.mark.asyncio
    async def test_startup_is_503_on_an_app_whose_lifespan_never_ran(self, async_client):
        """This fixture mounts the ASGI app without a LifespanManager, so this is
        the real "assembled but not initialised" case, not a contrivance."""
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

    @pytest.mark.asyncio
    async def test_startup_does_not_dial_temporal(self, app, async_client, monkeypatch):
        """This app comes up best-effort when Temporal is down, by design.

        Gating startup on Temporal would restart a healthy API pod for a
        dependency outage. Temporal reachability is `/health/ready`'s job — and
        that is asserted by breaking the client factory and checking only this
        route stays 200.
        """

        async def _explode(*_args, **_kwargs):
            raise RuntimeError("temporal unreachable")

        monkeypatch.setattr("harness.temporal.client.get_temporal_client", _explode)
        app.state.service_release_task = None

        assert (await async_client.get("/api/v1/health/startup")).status_code == 200
        assert (await async_client.get("/api/v1/health/ready")).status_code == 503
