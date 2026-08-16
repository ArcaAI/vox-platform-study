"""TDD tests for the admin provider-introspection endpoint (TASK-726 Task 4/5).

Mirrors TASK-725's `GET /providers` for `text`, adapted for tts's 5-provider
registry — see design-notes.md §(c): tts's per-provider CircuitBreaker
degrade-routing already existed (routing/router.py); this endpoint is the
NEW read-only admin surface over it, plus the GPU/device classification
(§b — Task 5).
"""

from __future__ import annotations

import pytest

from tts.tests.fakes import FakeEngine


class TestProvidersEndpoint:
    @pytest.mark.asyncio
    async def test_empty_registry_returns_empty_list(self, async_client):
        resp = await async_client.get("/api/v1/providers")
        assert resp.status_code == 200
        assert resp.json() == {"providers": []}

    @pytest.mark.asyncio
    async def test_healthy_local_provider_reports_gpu_bound(self, app, async_client):
        app.state.provider_registry.register("kokoro", FakeEngine("kokoro"))

        resp = await async_client.get("/api/v1/providers")

        assert resp.status_code == 200
        entries = {p["name"]: p for p in resp.json()["providers"]}
        assert entries["kokoro"]["healthy"] is True
        assert entries["kokoro"]["gpu_bound"] is True
        assert entries["kokoro"]["is_configured"] is True
        assert entries["kokoro"]["breaker_open"] is False

    @pytest.mark.asyncio
    async def test_cloud_provider_reports_not_gpu_bound(self, app, async_client):
        app.state.provider_registry.register(
            "azure", FakeEngine("azure", healthy=False, configured=False)
        )

        resp = await async_client.get("/api/v1/providers")

        entries = {p["name"]: p for p in resp.json()["providers"]}
        assert entries["azure"]["gpu_bound"] is False
        assert entries["azure"]["healthy"] is False
        assert entries["azure"]["is_configured"] is False

    @pytest.mark.asyncio
    async def test_all_five_known_providers_classified(self, app, async_client):
        for name in ("azure", "sarvam", "kokoro", "indic_parler", "indic_f5"):
            app.state.provider_registry.register(name, FakeEngine(name))

        resp = await async_client.get("/api/v1/providers")

        entries = {p["name"]: p for p in resp.json()["providers"]}
        assert entries["azure"]["gpu_bound"] is False
        assert entries["sarvam"]["gpu_bound"] is False
        assert entries["kokoro"]["gpu_bound"] is True
        assert entries["indic_parler"]["gpu_bound"] is True
        assert entries["indic_f5"]["gpu_bound"] is True

    @pytest.mark.asyncio
    async def test_provider_health_exception_reports_unhealthy_not_500(self, app, async_client):
        class ExplodingEngine(FakeEngine):
            async def health(self) -> bool:
                raise RuntimeError("boom")

        app.state.provider_registry.register("kokoro", ExplodingEngine("kokoro"))

        resp = await async_client.get("/api/v1/providers")

        assert resp.status_code == 200
        entries = {p["name"]: p for p in resp.json()["providers"]}
        assert entries["kokoro"]["healthy"] is False

    @pytest.mark.asyncio
    async def test_open_circuit_breaker_surfaced(self, app, async_client):
        app.state.provider_registry.register("kokoro", FakeEngine("kokoro"))
        breaker = app.state.router.breaker("kokoro")
        for _ in range(breaker.failure_threshold):
            breaker.record_failure()
        assert breaker.is_open() is True

        resp = await async_client.get("/api/v1/providers")

        entries = {p["name"]: p for p in resp.json()["providers"]}
        assert entries["kokoro"]["breaker_open"] is True

    @pytest.mark.asyncio
    async def test_local_provider_resolved_device_surfaced_when_present(self, app, async_client):
        class _Cfg:
            device = "cuda"

        engine = FakeEngine("kokoro")
        engine._config = _Cfg()
        app.state.provider_registry.register("kokoro", engine)

        resp = await async_client.get("/api/v1/providers")

        entries = {p["name"]: p for p in resp.json()["providers"]}
        assert entries["kokoro"]["resolved_device"] == "cuda"

    @pytest.mark.asyncio
    async def test_cloud_provider_resolved_device_is_none(self, app, async_client):
        app.state.provider_registry.register("azure", FakeEngine("azure"))

        resp = await async_client.get("/api/v1/providers")

        entries = {p["name"]: p for p in resp.json()["providers"]}
        assert entries["azure"]["resolved_device"] is None
