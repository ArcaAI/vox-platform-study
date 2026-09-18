"""TASK-990 — the health-check contract this service must honour.

* **F6** — ``/health`` reports the RUNNING image's version
  (``/app/build-info.json``) instead of ``settings.service.version``, a
  pydantic-settings field with a literal default: a build-time fact wearing a
  config costume, which answered the same string for every image ever built.
* **F7** — ``/health/startup`` exists and is exempt from the service-token
  middleware. Before this it was answered 401, not 404: the middleware refuses
  an unknown path before FastAPI can route it, so the missing route looked like
  an auth fault.
"""

from hope_env import BuildInfoReader

API_PREFIX = "/api/v1"


class TestBuildIdentity:
    def test_health_reports_the_build_info_version(self, client):
        body = client.get(f"{API_PREFIX}/health").json()
        assert body["version"] == BuildInfoReader().get_build_info().version

    def test_health_version_is_not_the_settings_literal(self, client):
        """Guards the regression, not just the fix.

        Outside a built image `BuildInfoReader` degrades to
        `0.0.0-<branch-slug>.<sha8>`, so this can only pass by actually reading
        the build contract.
        """
        from nlp.core.config import settings

        body = client.get(f"{API_PREFIX}/health").json()
        assert body["version"] != settings.service.version
        assert body["version"].startswith("0.0.0-")


class TestStartupProbe:
    def test_startup_is_503_on_an_app_whose_lifespan_never_ran(self):
        """The probe must be able to FAIL, or it is not a probe.

        Built here rather than off the shared `client` fixture, which DOES run
        the lifespan — that is the 200 case below.
        """
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from nlp.api.v1.rest.monitoring import router

        app = FastAPI()
        app.include_router(router, prefix=API_PREFIX)
        resp = TestClient(app).get(f"{API_PREFIX}/health/startup")
        assert resp.status_code == 503
        assert resp.json()["status"] == "unhealthy"

    def test_startup_is_200_on_a_really_initialised_app(self, client):
        """The `client` fixture runs the real lifespan, so this is end to end.

        Nothing is stubbed: the lifespan itself assigns the marker
        (`app.state.service_release_task`, unconditionally — `None` when gateway
        registration is disabled, which it is here).
        """
        resp = client.get(f"{API_PREFIX}/health/startup")
        assert resp.status_code == 200
        assert resp.json() == {"status": "healthy"}

    def test_startup_does_not_gate_on_lazy_models(self, client):
        """BUG-010's rule applied to the startup probe.

        NLP loads every model lazily on first request, so a residency gate here
        would leave a fully functional worker permanently un-started — and then
        restarted — whenever no request had yet arrived. This initialised process
        has zero warmed models and still reports started.
        """
        assert client.get(f"{API_PREFIX}/health").json()["checks"]
        assert client.get(f"{API_PREFIX}/health/startup").status_code == 200

    def test_startup_is_exempt_from_service_auth(self):
        from nlp.api.middleware.auth import EXEMPT_PATHS

        assert f"{API_PREFIX}/health/startup" in EXEMPT_PATHS

    def test_all_four_contract_routes_are_exempt(self):
        from nlp.api.middleware.auth import EXEMPT_PATHS

        for suffix in ("", "/live", "/ready", "/startup"):
            assert f"{API_PREFIX}/health{suffix}" in EXEMPT_PATHS
