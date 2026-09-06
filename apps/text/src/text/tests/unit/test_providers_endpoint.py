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

from text.core.config import Settings
from text.models.provider import ModelInfo, ProviderInfo
from text.tests.conftest import stub_client


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
    return Settings(port=5099, log_level="debug")


@pytest_asyncio.fixture
async def client(settings: Settings):
    from text.main import create_app
    from text.providers.base import ProviderRegistry

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
    async def test_hung_provider_times_out_without_blocking(self, client, monkeypatch):
        # The probe cap is a resource-safety FLOOR now (`core/runtime_defaults.py`),
        # not `TEXT_PROVIDER_PROBE_TIMEOUT_S` — one hung engine must never stall an
        # admin listing, and that is not a per-deployment choice. Pinned to 1 s here
        # so the timing assertion below stays about CONCURRENCY, not about the cap.
        monkeypatch.setattr("text.api.endpoints.providers.PROVIDER_PROBE_TIMEOUT_S", 1)
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

        `ProviderInfo.name` is the ADAPTER's own engine name and a registration
        may legitimately disagree with it (an alias, or a test double), so the
        endpoint must stamp the key it iterated rather than the name the probe
        reported.
        """
        shared = AsyncMock()
        shared.get_info = AsyncMock(return_value=_info("openai_compat"))
        client.registry.register("lm-studio", shared)

        resp = await client.get("/api/v1/providers")

        assert resp.json()[0]["name"] == "lm-studio"


class TestLmStudioNativeEnrichment:
    def _provider(self, native_handler):
        # The native `/api/v0/models` listing is LM Studio's, so it lives on LM
        # Studio's adapter — not on the generic OpenAI-wire class, which used to
        # carry it behind a two-name frozenset and therefore probed generic
        # endpoints on a route only LM Studio serves.
        from text.providers import lmstudio as mod
        from text.providers.lmstudio import LMStudioProvider

        provider = LMStudioProvider()

        class _Model:
            def __init__(self, mid: str) -> None:
                self.id = mid

        class _List:
            data = [_Model("qwen3-8b")]

        provider._client = stub_client(provider, AsyncMock())  # type: ignore[assignment]
        provider._client.models.list = AsyncMock(return_value=_List())
        # The LM Studio native probe (`/api/v0/models`) reaches the server ROOT
        # rather than its `/v1` surface, so it derives its URL from the observed
        # endpoint rather than from the OpenAI client.
        provider._last_base_url = "http://lmstudio.test/v1"
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
        monkeypatch.setattr(
            mod,
            "_native_probe_client",
            lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )

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
        monkeypatch.setattr(
            mod,
            "_native_probe_client",
            lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )

        info = await provider.get_info()

        assert [m.name for m in info.models] == ["qwen3-8b"]
        assert info.models[0].state is None
        assert info.status == "available"

    @pytest.mark.asyncio
    async def test_listing_failure_is_logged_not_silently_swallowed(self, monkeypatch):
        """`except Exception: pass` swallowed every diagnostic — it must log."""
        provider, mod, _ = self._provider(lambda r: httpx.Response(404))
        provider._client.models.list = AsyncMock(side_effect=RuntimeError("engine down"))  # type: ignore[union-attr]

        from text.providers import openai_compat as compat

        events: list[tuple[str, dict]] = []
        monkeypatch.setattr(
            compat,
            "logger",
            type(
                "L",
                (),
                {
                    "warning": lambda _self, ev, **kw: events.append((ev, kw)),
                    "error": lambda _self, ev, **kw: events.append((ev, kw)),
                    "info": lambda _self, ev, **kw: None,
                },
            )(),
        )

        info = await provider.get_info()

        assert info.status == "unavailable"
        assert info.models == []
        assert any("get_info" in ev for ev, _ in events)


class TestSwallowedUnavailability:
    """TASK-890 J1 MAJOR-C — a swallowed connection error must not read as `ok`.

    Every adapter catches its own transport failure and returns a well-formed
    ``ProviderInfo(status="unavailable")`` rather than raising, so ``_probe``'s
    ``try`` block completes and stamps ``probe_status: "ok"``. The gateway's
    readiness sweep learned to read BOTH fields, but every OTHER consumer —
    ``/ai-services``, the discovery merge, an operator reading the JSON — sees a
    dead engine reported as a successful probe.

    ``probe_status`` answers "how did the probe go", and a probe that came back
    holding `unavailable` did not go fine. Two outcomes, distinguished by
    whether there was anything to probe AT ALL:

      * a connection WAS configured -> ``error``: something was addressed and
        did not answer.
      * no connection -> ``skipped``: nothing was addressed, so "error" would
        blame an engine nobody asked for.
    """

    @pytest.mark.asyncio
    async def test_unavailable_with_no_connection_is_skipped(self, client):
        dead = AsyncMock()
        dead.get_info = AsyncMock(
            return_value=ProviderInfo(
                name="dead", display_name="dead", status="unavailable", default_model=""
            )
        )
        client.registry.register("dead", dead)

        resp = await client.get("/api/v1/providers")

        entry = resp.json()[0]
        assert entry["status"] == "unavailable"
        assert entry["probe_status"] == "skipped"
        assert entry["probe_error"]

    @pytest.mark.asyncio
    async def test_unavailable_with_a_configured_connection_is_error(self, client):
        # A PLAIN stub, not an AsyncMock: `_describe` dispatches on
        # `isinstance(provider, ConnectionAwareProbe)`, and an AsyncMock answers
        # every attribute, so it would satisfy that runtime-checkable protocol
        # and take the `discover_models` branch this test is not about.
        class _Dead:
            async def get_info(self):
                return ProviderInfo(
                    name="dead", display_name="dead", status="unavailable", default_model=""
                )

        client.registry.register("dead", _Dead())

        resp = await client.post(
            "/api/v1/providers/probe",
            json={"connections": {"dead": {"base_url": "http://127.0.0.1:9/v1"}}},
        )

        entry = resp.json()[0]
        assert entry["status"] == "unavailable"
        assert entry["probe_status"] == "error"
        assert entry["probe_error"]

    @pytest.mark.asyncio
    async def test_an_available_provider_still_reports_ok(self, client):
        healthy = AsyncMock()
        healthy.get_info = AsyncMock(return_value=_info("healthy"))
        client.registry.register("healthy", healthy)

        resp = await client.get("/api/v1/providers")

        entry = resp.json()[0]
        assert entry["probe_status"] == "ok"
        assert entry["probe_error"] is None

    @pytest.mark.asyncio
    async def test_a_raised_error_keeps_its_own_message(self, client):
        """The downgrade must never overwrite a real exception's reason."""
        boom = AsyncMock()
        boom.get_info = AsyncMock(side_effect=RuntimeError("connection refused"))
        client.registry.register("boom", boom)

        resp = await client.get("/api/v1/providers")

        entry = resp.json()[0]
        assert entry["probe_status"] == "error"
        assert "connection refused" in entry["probe_error"]
