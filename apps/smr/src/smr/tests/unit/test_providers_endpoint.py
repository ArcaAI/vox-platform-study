"""Provider probe hardening (timeouts, partial failure, load state).

Hermetic: no live engines. The registry is stubbed and the httpx/OpenAI
transports are replaced with in-test doubles.
RED: written before implementation.
"""

from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from smr.core.config import OllamaConfig, OpenAICompatConfig, Settings
from smr.models.provider import ModelInfo, ProviderInfo


def _info(name: str) -> ProviderInfo:
    return ProviderInfo(
        name=name,
        display_name=name,
        status="available",
        default_model="m",
        models=[ModelInfo(name="m")],
    )


@pytest.fixture
def settings() -> Settings:
    return Settings(host="127.0.0.1", port=5099, debug=True, log_level="debug", provider_probe_timeout_s=1)


@pytest_asyncio.fixture
async def client(settings: Settings):
    from smr.main import create_app
    from smr.providers.base import ProviderRegistry

    app = create_app()
    app.state.settings = settings
    app.state.redis = AsyncMock()
    app.state.provider_registry = ProviderRegistry()
    app.state.task_manager = AsyncMock()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        c.registry = app.state.provider_registry  # type: ignore[attr-defined]
        yield c


class TestProbeContract:
    @pytest.mark.asyncio
    async def test_hung_provider_times_out_without_blocking(self, client):
        hung = AsyncMock()

        async def _sleep() -> ProviderInfo:
            await asyncio.sleep(30)
            return _info("hung")

        hung.get_info = _sleep
        healthy = AsyncMock()
        healthy.get_info = AsyncMock(return_value=_info("healthy"))

        client.registry.register("hung", hung)
        client.registry.register("healthy", healthy)

        start = time.monotonic()
        resp = await client.get("/api/v1/providers")
        elapsed = time.monotonic() - start

        assert resp.status_code == 200
        # 1 s configured cap + slack; must NOT serialize behind the 30 s sleeper.
        assert elapsed < 5.0
        by_name = {p["name"]: p for p in resp.json()}
        assert by_name["hung"]["probe_status"] == "timeout"
        assert by_name["healthy"]["probe_status"] == "ok"
        assert by_name["healthy"]["probe_latency_ms"] is not None

    @pytest.mark.asyncio
    async def test_raising_provider_yields_error_not_500(self, client):
        boom = AsyncMock()
        boom.get_info = AsyncMock(side_effect=RuntimeError("connection refused"))
        client.registry.register("boom", boom)

        resp = await client.get("/api/v1/providers")

        assert resp.status_code == 200
        entry = resp.json()[0]
        assert entry["name"] == "boom"
        assert entry["probe_status"] == "error"
        assert "connection refused" in entry["probe_error"]
        assert entry["status"] == "unavailable"

    @pytest.mark.asyncio
    async def test_entry_name_is_the_registry_key(self, client):
        """The registry key is the provider identity the gateway merges on.

        `main.py` registers the LM Studio instance under BOTH `lm-studio` and
        `openai_compat`, and the shared instance reports `openai_compat` for
        both — so the endpoint must stamp the key it iterated.
        """
        shared = AsyncMock()
        shared.get_info = AsyncMock(return_value=_info("openai_compat"))
        client.registry.register("lm-studio", shared)

        resp = await client.get("/api/v1/providers")

        assert resp.json()[0]["name"] == "lm-studio"


class TestOllamaLoadState:
    def _provider(self, handler):
        from smr.providers.ollama import OllamaProvider

        transport = httpx.MockTransport(handler)
        http = httpx.AsyncClient(transport=transport)
        return OllamaProvider(OllamaConfig(base_url="http://ollama.test"), http)

    @pytest.mark.asyncio
    async def test_ollama_load_state_from_api_ps(self):
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "a:latest"}, {"name": "b:latest"}]})
            if request.url.path == "/api/ps":
                return httpx.Response(200, json={"models": [{"name": "a:latest"}]})
            return httpx.Response(404)

        info = await self._provider(handler).get_info()
        states = {m.name: m.state for m in info.models}
        assert states == {"a:latest": "loaded", "b:latest": "not-loaded"}

    @pytest.mark.asyncio
    async def test_ollama_ps_failure_leaves_listing_intact(self):
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "a:latest"}]})
            raise httpx.ConnectError("ps down", request=request)

        info = await self._provider(handler).get_info()
        assert [m.name for m in info.models] == ["a:latest"]
        assert info.models[0].state is None
        assert info.status == "available"


class TestLmStudioNativeEnrichment:
    def _provider(self, native_handler):
        from smr.providers import openai_compat as mod
        from smr.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(OpenAICompatConfig(base_url="http://lms.test/v1"))

        class _Model:
            def __init__(self, mid: str) -> None:
                self.id = mid

        class _List:
            data = [_Model("qwen3-8b")]

        provider._client = AsyncMock()  # type: ignore[assignment]
        provider._client.models.list = AsyncMock(return_value=_List())
        return provider, mod, native_handler

    @pytest.mark.asyncio
    async def test_native_enrichment_surfaces_state_and_metadata(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/api/v0/models"
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "qwen3-8b",
                            "state": "loaded",
                            "quantization": "Q4_K_M",
                            "max_context_length": 32768,
                        }
                    ]
                },
            )

        provider, mod, _ = self._provider(handler)
        monkeypatch.setattr(mod, "_native_probe_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))

        info = await provider.get_info()

        model = info.models[0]
        assert model.state == "loaded"
        assert model.engine_native is not None
        assert model.engine_native["quantization"] == "Q4_K_M"
        assert model.engine_native["max_context_length"] == 32768

    @pytest.mark.asyncio
    async def test_native_404_degrades_to_v1_listing(self, monkeypatch):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404)

        provider, mod, _ = self._provider(handler)
        monkeypatch.setattr(mod, "_native_probe_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))

        info = await provider.get_info()

        assert [m.name for m in info.models] == ["qwen3-8b"]
        assert info.models[0].state is None
        assert info.status == "available"

    @pytest.mark.asyncio
    async def test_listing_failure_is_logged_not_silently_swallowed(self, monkeypatch):
        """`except Exception: pass` swallowed every diagnostic — it must log."""
        provider, mod, _ = self._provider(lambda r: httpx.Response(404))
        provider._client.models.list = AsyncMock(side_effect=RuntimeError("engine down"))  # type: ignore[union-attr]

        events: list[tuple[str, dict]] = []
        monkeypatch.setattr(
            mod,
            "logger",
            type(
                "L",
                (),
                {
                    "warning": lambda _self, ev, **kw: events.append((ev, kw)),
                    "error": lambda _self, ev, **kw: events.append((ev, kw)),
                    "info": lambda _self, ev, **kw: None,
                    "debug": lambda _self, ev, **kw: None,
                },
            )(),
        )

        info = await provider.get_info()

        assert info.status == "unavailable"
        assert info.models == []
        assert any("get_info" in ev for ev, _ in events)
