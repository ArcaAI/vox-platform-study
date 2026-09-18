"""TASK-990 — the health-check contract this service must honour.

Three findings are pinned here:

* **F6** — ``/health`` reports the RUNNING image's version (``/app/build-info.json``)
  instead of the source literal ``"0.1.0"`` it answered for every build ever made.
* **F7** — ``/health/startup`` exists and is exempt from the service-token
  middleware. Before this it was answered 401, not 404: the middleware refuses an
  unknown path before FastAPI can route it, so the missing route looked like an
  auth fault.
* **F5** — ``KokoroProvider.health()`` reports actual pipeline residency instead
  of ``True`` unconditionally, and ``/health/ready`` reports a not-yet-loaded
  local engine as degraded-but-READY rather than pulling the pod out of service.
"""

from __future__ import annotations

import pytest
from hope_env import BuildInfoReader

from tts.tests.fakes import FakeEngine

_RETIRED_LITERAL = "0.1.0"


class TestBuildIdentity:
    @pytest.mark.asyncio
    async def test_health_reports_the_build_info_version(self, async_client):
        body = (await async_client.get("/api/v1/health")).json()
        assert body["version"] == BuildInfoReader().get_build_info().version

    @pytest.mark.asyncio
    async def test_health_no_longer_reports_the_source_literal(self, async_client):
        """Guards the regression, not just the fix.

        Outside a built image `BuildInfoReader` degrades to
        `0.0.0-<branch-slug>.<sha8>`, so this can only pass by actually reading
        the build contract — and it would fail the moment someone restored the
        literal.
        """
        body = (await async_client.get("/api/v1/health")).json()
        assert body["version"] != _RETIRED_LITERAL
        assert body["version"].startswith("0.0.0-")


class TestStartupProbe:
    """The startup probe must be able to FAIL, or it is not a probe.

    `/health` is the informational route and is always 200; `/health/live`,
    `/health/ready` and `/health/startup` are the three that may refuse.
    """

    @pytest.mark.asyncio
    async def test_startup_is_503_on_an_app_whose_lifespan_never_ran(self, async_client):
        """These fixtures mount the ASGI app without a LifespanManager, so this
        is the real "assembled but not initialised" case, not a contrivance."""
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
        """Registration disabled leaves the marker `None`, and that app IS started.

        `getattr(..., None)` would read it as still initialising and hold a
        healthy pod out of service forever — which is why the handler uses an
        `_UNSET` sentinel.
        """
        app.state.service_release_task = None
        assert (await async_client.get("/api/v1/health/startup")).status_code == 200

    def test_startup_is_exempt_from_service_auth(self):
        from tts.api.middleware.auth import EXEMPT_PATHS

        assert "/api/v1/health/startup" in EXEMPT_PATHS

    def test_all_four_contract_routes_are_exempt(self):
        """The whole contract, not just the route this ticket added."""
        from tts.api.middleware.auth import EXEMPT_PATHS

        for suffix in ("", "/live", "/ready", "/startup"):
            assert f"/api/v1/health{suffix}" in EXEMPT_PATHS


class TestKokoroResidency:
    """F5 — `health()` must measure residency, and must not load to find out."""

    @staticmethod
    def _provider(**kwargs):
        from tts.core.config import KokoroConfig
        from tts.providers.kokoro import KokoroProvider

        return KokoroProvider(KokoroConfig(), **kwargs)

    @pytest.mark.asyncio
    async def test_unloaded_provider_is_not_healthy(self):
        provider = self._provider(pipeline_factory=lambda: object())
        assert await provider.health() is False

    @pytest.mark.asyncio
    async def test_provider_is_healthy_once_the_pipeline_is_resident(self):
        provider = self._provider(pipeline_factory=lambda: object())
        await provider._get_pipeline_async()  # noqa: SLF001 - the load under test
        assert await provider.health() is True

    @pytest.mark.asyncio
    async def test_health_does_not_load_the_pipeline(self):
        """A probe that loads ~1.2 GB as a side effect IS the cold start."""
        loads = []

        def _factory():
            loads.append(1)
            return object()

        provider = self._provider(pipeline_factory=_factory)
        await provider.health()
        await provider.health()
        assert loads == []

    @pytest.mark.asyncio
    async def test_injected_pipeline_is_always_resident(self):
        """The hermetic-test seam bypasses the cache; it is resident by construction."""
        provider = self._provider(pipeline=object())
        assert await provider.health() is True

    def test_provider_declares_that_it_loads_on_demand(self):
        """The discriminator `/health/ready` reads to tell lazy from broken."""
        provider = self._provider(pipeline_factory=lambda: object())
        assert provider.loads_on_demand is True


class TestReadinessWithLazyLocalProvider:
    @pytest.mark.asyncio
    async def test_unloaded_local_provider_is_degraded_but_ready(self, app, async_client):
        """ "Not yet loaded" must never take the pod out of Service endpoints.

        Local engines are lazy by design (`TTS_WARMUP_ENABLED` defaults false),
        so a residency gate on readiness would leave a perfectly serviceable pod
        NotReady forever.
        """

        class LazyEngine(FakeEngine):
            loads_on_demand = True

        app.state.provider_registry.register(
            "kokoro", LazyEngine("kokoro", healthy=False, configured=True)
        )
        resp = await async_client.get("/api/v1/health/ready")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "degraded"
        assert body["awaiting_warm_load"] == ["kokoro"]
        assert body["awaiting_credentials"] == []
        assert "weights not yet resident" in body["message"]

    @pytest.mark.asyncio
    async def test_configured_non_lazy_provider_still_503s(self, app, async_client):
        """`loads_on_demand` is the ONLY thing that excuses a False health().

        Pinned beside the case above so the new branch cannot quietly widen into
        "any unhealthy provider is fine".
        """
        app.state.provider_registry.register(
            "azure", FakeEngine("azure", healthy=False, configured=True)
        )
        resp = await async_client.get("/api/v1/health/ready")
        assert resp.status_code == 503

    @pytest.mark.asyncio
    async def test_byok_and_lazy_are_reported_separately(self, app, async_client):
        """Two different degradations with two different remedies."""

        class LazyEngine(FakeEngine):
            loads_on_demand = True

        app.state.provider_registry.register(
            "azure", FakeEngine("azure", healthy=False, configured=False)
        )
        app.state.provider_registry.register(
            "kokoro", LazyEngine("kokoro", healthy=False, configured=True)
        )
        body = (await async_client.get("/api/v1/health/ready")).json()
        assert body["status"] == "degraded"
        assert body["awaiting_credentials"] == ["azure"]
        assert body["awaiting_warm_load"] == ["kokoro"]
