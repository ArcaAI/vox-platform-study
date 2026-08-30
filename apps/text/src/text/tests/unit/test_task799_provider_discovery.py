"""TASK-799 A.2 — the probe listens to the connection it is GIVEN.

Before this lane every adapter's ``get_info()`` probed ``self._last_base_url``:
the endpoint THIS PROCESS happened to serve a generation from last. That memo is
a process-wide singleton, so ``GET /providers`` could only ever describe one
engine per provider name — which is exactly why the gateway's model discovery
could not show a tenant its OWN LM Studio / Ollama instance.

The fix is a second, connection-aware probe surface
(``POST /providers/probe``): the gateway resolves the caller's connection
through the ONE tenant → SYSTEM cascade and hands the resolved endpoint down,
exactly as ``/generate`` already hands down ``provider_overrides``. Text still
holds the only engine connection — the gateway never opens one.

Hermetic: no live engines; transports are in-test doubles.
RED: written before implementation.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.core.config import Settings
from text.models.provider import ModelInfo, ProviderInfo


def _info(name: str, models: list[str] | None = None) -> ProviderInfo:
    return ProviderInfo(
        name=name,
        display_name=name,
        status="available",
        default_model="",
        models=[ModelInfo(name=m) for m in (models or ["memo-model"])],
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


class _RecordingProvider:
    """A connection-aware adapter that records what it was handed."""

    def __init__(self) -> None:
        self.seen: list[tuple[str, str | None]] = []

    async def get_info(self) -> ProviderInfo:
        self.seen.append(("<memo>", None))
        return _info("recording", ["memo-model"])

    async def discover_models(self, connection: Any) -> ProviderInfo:
        key = connection.api_key.get_secret_value() if connection.api_key else None
        self.seen.append((connection.base_url, key))
        return _info("recording", [f"model-from-{connection.base_url}"])


class TestConnectionAwareProbe:
    @pytest.mark.asyncio
    async def test_probe_uses_the_injected_endpoint_not_the_process_memo(self, client):
        """The tenant's own LM Studio, not whatever this process last served."""
        provider = _RecordingProvider()
        client.registry.register("lm-studio", provider)

        resp = await client.post(
            "/api/v1/providers/probe",
            json={
                "connections": {
                    "lm-studio": {"base_url": "http://tenant-lmstudio.test/v1", "api_key": "k"}
                }
            },
        )

        assert resp.status_code == 200
        entry = resp.json()[0]
        assert entry["name"] == "lm-studio"
        assert entry["probe_status"] == "ok"
        assert [m["name"] for m in entry["models"]] == ["model-from-http://tenant-lmstudio.test/v1"]
        assert provider.seen == [("http://tenant-lmstudio.test/v1", "k")]

    @pytest.mark.asyncio
    async def test_keyless_connection_probes_unauthenticated(self, client):
        """A self-hosted engine normally has no credential — that is not an error."""
        provider = _RecordingProvider()
        client.registry.register("ollama", provider)

        resp = await client.post(
            "/api/v1/providers/probe",
            json={"connections": {"ollama": {"base_url": "http://sys-ollama.test"}}},
        )

        assert resp.status_code == 200
        assert resp.json()[0]["probe_status"] == "ok"
        assert provider.seen == [("http://sys-ollama.test", None)]

    @pytest.mark.asyncio
    async def test_no_connection_falls_back_to_get_info(self, client):
        """No resolved row ⇒ the pre-existing memo probe, unchanged."""
        provider = _RecordingProvider()
        client.registry.register("lm-studio", provider)

        resp = await client.post("/api/v1/providers/probe", json={"connections": {}})

        assert resp.status_code == 200
        assert provider.seen == [("<memo>", None)]

    @pytest.mark.asyncio
    async def test_one_bad_provider_does_not_fail_the_listing(self, client):
        boom = AsyncMock()
        boom.get_info = AsyncMock(side_effect=RuntimeError("connection refused"))
        boom.discover_models = AsyncMock(side_effect=RuntimeError("connection refused"))
        healthy = _RecordingProvider()
        client.registry.register("boom", boom)
        client.registry.register("ollama", healthy)

        resp = await client.post(
            "/api/v1/providers/probe",
            json={
                "connections": {
                    "boom": {"base_url": "http://down.test"},
                    "ollama": {"base_url": "http://up.test"},
                }
            },
        )

        assert resp.status_code == 200
        by_name = {p["name"]: p for p in resp.json()}
        assert by_name["boom"]["probe_status"] == "error"
        assert by_name["boom"]["status"] == "unavailable"
        assert by_name["ollama"]["probe_status"] == "ok"

    @pytest.mark.asyncio
    async def test_credential_never_appears_in_the_response(self, client):
        client.registry.register("lm-studio", _RecordingProvider())

        resp = await client.post(
            "/api/v1/providers/probe",
            json={
                "connections": {
                    "lm-studio": {"base_url": "http://x.test/v1", "api_key": "super-secret-key"}
                }
            },
        )

        assert "super-secret-key" not in resp.text


class TestOpenAiWireDiscovery:
    """LM Studio / vLLM speak the OpenAI wire: `GET {base_url}/models`."""

    @pytest.mark.asyncio
    async def test_lists_models_from_the_injected_base_url(self, monkeypatch):
        from text.models.probe import ProbeConnection
        from text.providers import openai_compat as mod
        from text.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(provider_name="lm-studio", display_name="LM Studio")
        # The process memo points at the PLATFORM engine; the injected
        # connection must win.
        provider._last_base_url = "http://platform-lmstudio.test/v1"

        built: list[tuple[str, str]] = []

        class _Model:
            def __init__(self, mid: str) -> None:
                self.id = mid

        class _List:
            data = [_Model("tenant-qwen3-8b")]

        class _Client:
            def __init__(self) -> None:
                self.models = AsyncMock()
                self.models.list = AsyncMock(return_value=_List())

        # `**_` absorbs `http_client`: TASK-818 Lane A hands every OpenAI-wire
        # client this upstream's pooled transport (B-2/B-8). This test is about
        # WHICH ENDPOINT the probe reaches, which is unchanged.
        def _fake_openai(*, api_key: str, base_url: str, timeout: float, **_: Any) -> Any:
            built.append((base_url, api_key))
            return _Client()

        monkeypatch.setattr(mod, "AsyncOpenAI", _fake_openai)
        monkeypatch.setattr(
            mod,
            "_native_probe_client",
            lambda: httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(404))),
        )

        info = await provider.discover_models(
            ProbeConnection(base_url="http://tenant-lmstudio.test/v1", api_key="tk")
        )

        assert [m.name for m in info.models] == ["tenant-qwen3-8b"]
        assert built == [("http://tenant-lmstudio.test/v1", "tk")]
        # The connection-scoped probe must NOT overwrite the generation memo.
        assert provider._last_base_url == "http://platform-lmstudio.test/v1"

    @pytest.mark.asyncio
    async def test_keyless_row_still_builds_a_client(self, monkeypatch):
        from text.models.probe import ProbeConnection
        from text.providers import openai_compat as mod
        from text.providers.openai_compat import OpenAICompatProvider

        provider = OpenAICompatProvider(provider_name="vllm", display_name="vLLM")
        built: list[tuple[str, str]] = []

        class _List:
            data: list[Any] = []

        class _Client:
            def __init__(self) -> None:
                self.models = AsyncMock()
                self.models.list = AsyncMock(return_value=_List())

        # `**_` absorbs `http_client` — see the note in the sibling test above.
        monkeypatch.setattr(
            mod,
            "AsyncOpenAI",
            lambda *, api_key, base_url, timeout, **_: (
                built.append((base_url, api_key)),
                _Client(),
            )[1],
        )

        info = await provider.discover_models(ProbeConnection(base_url="http://keyless.test/v1"))

        assert info.status == "available"
        # A keyless self-hosted engine is probed with the placeholder the
        # OpenAI SDK requires — never with a credential we do not have.
        assert built == [("http://keyless.test/v1", "not-needed")]


class TestOllamaNativeDiscovery:
    """Ollama already speaks `/api/tags`; the injected endpoint must be used."""

    @pytest.mark.asyncio
    async def test_lists_tags_from_the_injected_base_url(self):
        from text.models.probe import ProbeConnection
        from text.providers.ollama import OllamaProvider

        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "llama3.1:8b"}]})
            if request.url.path == "/api/ps":
                return httpx.Response(200, json={"models": [{"name": "llama3.1:8b"}]})
            return httpx.Response(404)

        provider = OllamaProvider(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        provider._last_base_url = "http://platform-ollama.test"

        info = await provider.discover_models(ProbeConnection(base_url="http://tenant-ollama.test"))

        assert [m.name for m in info.models] == ["llama3.1:8b"]
        assert info.models[0].state == "loaded"
        assert all(u.startswith("http://tenant-ollama.test") for u in seen), seen
        assert provider._last_base_url == "http://platform-ollama.test"
