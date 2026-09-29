"""The four-route HOPE health contract; liveness never touches the decode path (TASK-1007 D-2)."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from hope_vllm.core.config import Settings
from hope_vllm.main import create_app
from hope_vllm.tests.conftest import TENANT_ID, spec_payload
from hope_vllm.tests.fakes import FakeEngineFactory


class ExplodingPool:
    """Any touch of the pool from a liveness probe is a test failure."""

    def __getattr__(self, name: str) -> object:
        raise AssertionError(f"liveness touched the engine pool ({name})")


async def test_liveness_is_independent_of_the_engine_pool(client, app) -> None:  # type: ignore[no-untyped-def]
    real_pool, app.state.engine_pool = app.state.engine_pool, ExplodingPool()
    try:
        response = await client.get("/api/v1/health/live")
    finally:
        app.state.engine_pool = real_pool  # the lifespan teardown closes it
    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}


async def test_liveness_answers_while_an_engine_is_loading(settings: Settings) -> None:
    factory = FakeEngineFactory(build_delay_s=0.3)
    app = create_app(settings, engine_factory=factory)
    import asyncio

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            warm = asyncio.create_task(
                client.post(
                    "/api/v1/engines/warm",
                    json={"spec": spec_payload()},
                    headers={"X-Tenant-Id": TENANT_ID},
                )
            )
            await asyncio.sleep(0.05)
            live = await asyncio.wait_for(client.get("/api/v1/health/live"), timeout=0.1)
            assert live.status_code == 200
            assert (await warm).status_code == 200


async def test_detailed_health_is_always_200_and_names_the_service(client) -> None:  # type: ignore[no-untyped-def]
    body = (await client.get("/api/v1/health")).json()
    assert body["service"] == "vllm"
    assert body["status"] in {"healthy", "degraded"}
    assert isinstance(body["version"], str) and body["version"]


async def test_startup_is_healthy_once_the_lifespan_ran(client) -> None:  # type: ignore[no-untyped-def]
    assert (await client.get("/api/v1/health/startup")).status_code == 200


async def test_startup_refuses_on_an_app_built_without_its_lifespan(app) -> None:  # type: ignore[no-untyped-def]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.get("/api/v1/health/startup")).status_code == 503


async def test_ready_is_503_when_the_engine_backend_is_not_installed(
    settings: Settings,
) -> None:
    app = create_app(
        settings, engine_factory=FakeEngineFactory(unavailable_reason="vllm is not installed")
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/v1/health/ready")
    assert response.status_code == 503
    assert "vllm is not installed" in response.json()["message"]


async def test_ready_reports_no_engine_yet_as_degraded_but_ready(client) -> None:  # type: ignore[no-untyped-def]
    response = await client.get("/api/v1/health/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["engines"]["loaded"] == [] and body["engines"]["loading"] == []


async def test_ready_lists_loaded_engines(client) -> None:  # type: ignore[no-untyped-def]
    await client.post(
        "/api/v1/engines/warm", json={"spec": spec_payload()}, headers={"X-Tenant-Id": TENANT_ID}
    )
    body = (await client.get("/api/v1/health/ready")).json()
    assert body["status"] == "healthy"
    assert [e["runtime_key"] for e in body["engines"]["loaded"]] == ["agent-version-0001"]


def test_create_app_configures_observability_through_hope_obs(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    import hope_vllm.main as main

    seen: list[str] = []
    monkeypatch.setattr(
        main, "configure_observability", lambda app, config: seen.append(config.service_name)
    )
    monkeypatch.delenv("OTEL_SERVICE_NAME", raising=False)
    create_app(settings, engine_factory=FakeEngineFactory())
    assert seen == ["vllm"]


def test_building_the_app_does_not_import_vllm(settings: Settings) -> None:
    import sys

    sys.modules.pop("vllm", None)
    create_app(settings)  # the REAL factory, not a fake
    assert "vllm" not in sys.modules


def test_building_the_app_disables_implicit_huggingface_tokens(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """OD-7: no ambient token (`HF_TOKEN`, a cached login) may ever fund a pull."""
    monkeypatch.delenv("HF_HUB_DISABLE_IMPLICIT_TOKEN", raising=False)
    create_app(settings, engine_factory=FakeEngineFactory())
    import os

    assert os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] == "1"
