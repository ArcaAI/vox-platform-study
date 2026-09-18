"""TASK-990 — the health-check contract this service must honour.

* **F6** — ``/health`` reports the RUNNING image's version
  (``/app/build-info.json``) instead of ``settings.app_version``, whose own
  comment already said the authoritative version lives in ``build-info.json``;
  this route simply never consulted it.
* **F7** — ``/health/startup`` exists and is exempt from the service-token
  middleware. Verified live before the fix: ``GET /api/v1/health/startup``
  answered **401**, not 404 — the middleware refuses an unknown path before
  FastAPI can route it, so a missing route looked like an auth fault.

Deliberately NOT asserted here: the status-code behaviour of ``/health``. STT's
detailed endpoint is informational by design and its probes are being repointed
at ``/health/ready`` in the deployment repo (TASK-990 F1/F2); changing its code
here would collide with that work.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from hope_env import BuildInfoReader


def _bare_app() -> FastAPI:
    """The health router on an app whose lifespan has NOT run."""
    from stt.health.api.routes import router

    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    return app


@pytest.fixture
def uninitialised_client():
    return TestClient(_bare_app())


@pytest.fixture
def client():
    """An app carrying the marker every stt lifespan assigns unconditionally.

    Its VALUE is meaningless (`None` when gateway registration is disabled);
    only its PRESENCE says the lifespan startup body ran.
    """
    app = _bare_app()
    app.state.service_release_task = None
    return TestClient(app)


class TestStartupProbe:
    """The startup probe must be able to FAIL, or it is not a probe."""

    def test_startup_is_503_on_an_app_whose_lifespan_never_ran(self, uninitialised_client):
        resp = uninitialised_client.get("/api/v1/health/startup")
        assert resp.status_code == 503
        assert resp.json()["status"] == "unhealthy"

    def test_startup_is_200_once_the_lifespan_marker_is_present(self, client):
        resp = client.get("/api/v1/health/startup")
        assert resp.status_code == 200
        assert resp.json() == {"status": "healthy"}

    def test_startup_does_not_touch_any_dependency(self, client, monkeypatch):
        """Startup asks "did initialisation finish", nothing more.

        Not Postgres, not MinIO, not Redis, and above all not model residency:
        ASR weights load lazily by explicit design, so a residency gate would
        hold the pod out of service until the first request arrived — and then
        restart it. Proven by breaking every dependency probe and checking this
        route is unmoved.
        """

        def _must_not_run(probe: str):
            def _boom():
                raise AssertionError(f"{probe} must not run on the startup probe")

            return _boom

        for name in ("_check_database", "_check_minio", "_check_redis"):
            monkeypatch.setattr(f"stt.health.api.routes.{name}", _must_not_run(name))
        assert client.get("/api/v1/health/startup").status_code == 200

    def test_startup_is_exempt_from_service_auth(self):
        from stt.core.middleware.auth import EXEMPT_PATHS

        assert "/api/v1/health/startup" in EXEMPT_PATHS

    def test_all_four_contract_routes_are_exempt(self):
        from stt.core.middleware.auth import EXEMPT_PATHS

        for suffix in ("", "/live", "/ready", "/startup"):
            assert f"/api/v1/health{suffix}" in EXEMPT_PATHS


class TestBuildIdentity:
    def test_service_version_comes_from_the_build_contract(self):
        from stt.health.api.routes import _service_version

        assert _service_version() == BuildInfoReader().get_build_info().version

    def test_service_version_is_not_the_settings_literal(self):
        """Guards the regression, not just the fix.

        Outside a built image `BuildInfoReader` degrades to
        `0.0.0-<branch-slug>.<sha8>`, so this can only pass by actually reading
        the build contract.
        """
        from stt.core.config.settings import get_settings
        from stt.health.api.routes import _service_version

        assert _service_version() != get_settings().app_version
        assert _service_version().startswith("0.0.0-")

    def test_service_version_is_read_once_per_process(self):
        """Build identity is immutable artifact data, not configuration.

        Re-reading it per request would put a file read — and, in a dev process
        with no `build-info.json`, two `git` shell-outs — on the health path.
        """
        from stt.health.api.routes import _service_version

        _service_version()
        hits_before = _service_version.cache_info().hits
        _service_version()
        assert _service_version.cache_info().hits == hits_before + 1
