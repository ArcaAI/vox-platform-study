"""LM Studio is a FIRST-CLASS engine, not the generic OpenAI-compatible adapter.

RED-first (TASK-818 D-5, "LM Studio needs its own identity").

Before this file, `main.py` registered ONE `OpenAICompatProvider` instance under
BOTH `lm-studio` and `openai_compat`, built with the DEFAULT
``provider_name="openai_compat"``. Three consequences, all live in production:

1.  Every AD-1 stat, span and `ProviderInfo` produced for a request that said
    ``provider: "lm-studio"`` reported the engine as ``openai_compat``.
2.  `_apply_retention_hint` was gated on ``self._provider_name == "lm-studio"``,
    which the registered instance never was — so the idle-retention ``ttl`` that
    `core/retention.py` exists to propagate was DEAD CODE on the only instance
    that ever served a request. The retention tests passed because they
    constructed ``OpenAICompatProvider(provider_name="lm-studio")`` by hand,
    which production does not.
3.  The LM Studio native `/api/v0/models` enrichment had to be gated on a
    two-name frozenset (``{"lm-studio", "openai_compat"}``) to survive (1), which
    made a GENERIC OpenAI-compatible endpoint get probed on a route only LM
    Studio serves.

The fix is the shape `vllm.py` already uses: an engine subclass carrying its own
identity, owning its own engine-specific wire behaviour.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from text.models.requests import GenerateRequest
from text.tests.conftest import connected, stub_client


def _completion() -> MagicMock:
    usage = MagicMock(prompt_tokens=3, completion_tokens=4, total_tokens=7)
    choice = MagicMock()
    choice.message.content = "ok"
    choice.message.reasoning_content = None
    choice.message.reasoning = None
    choice.finish_reason = "stop"
    resp = MagicMock()
    resp.choices = [choice]
    resp.usage = usage
    return resp


def _registry():
    from text.main import _register_provider_factories
    from text.providers.base import ProviderRegistry

    registry = ProviderRegistry()
    _register_provider_factories(registry, MagicMock())
    return registry


class _Model:
    def __init__(self, mid: str) -> None:
        self.id = mid


class _List:
    data = [_Model("qwen3-8b")]


# ── 1. Identity ─────────────────────────────────────────────────────────────


class TestLmStudioIsItsOwnProvider:
    def test_the_lm_studio_key_builds_the_lm_studio_adapter(self):
        from text.providers.lmstudio import LMStudioProvider

        provider = _registry().get("lm-studio")

        assert isinstance(provider, LMStudioProvider)
        assert provider._provider_name == "lm-studio"
        assert provider._display_name == "LM Studio"

    def test_the_openai_compat_key_stays_the_generic_adapter(self):
        """`openai_compat` is the PORTABILITY adapter (any OpenAI-wire server).

        It must remain registered — a caller naming it must not 404 — but it is
        no longer the same object as LM Studio, so it can never be handed LM
        Studio's non-standard body fields or probed on LM Studio's native route.
        """
        registry = _registry()

        generic = registry.get("openai_compat")

        assert generic is not registry.get("lm-studio")
        assert generic._provider_name == "openai_compat"

    @pytest.mark.asyncio
    async def test_registered_instance_reports_lm_studio_in_its_stats(self):
        provider = _registry().get("lm-studio")
        stub_client(provider, AsyncMock()).chat.completions.create = AsyncMock(
            return_value=_completion()
        )

        _content, _reasoning, stats = await provider.generate(
            GenerateRequest(prompt="hi", model="m", provider="lm-studio")
        )

        assert stats.provider == "lm-studio"

    @pytest.mark.asyncio
    async def test_registered_instance_reports_lm_studio_in_its_listing(self):
        provider = _registry().get("lm-studio")
        client = stub_client(provider, AsyncMock())
        client.models.list = AsyncMock(return_value=_List())

        info = await provider.get_info()

        assert info.name == "lm-studio"
        assert info.display_name == "LM Studio"


# ── 2. The retention hint the registered instance never sent ────────────────


class TestRegisteredInstanceActuallySendsTheRetentionHint:
    """The regression this split exists to close.

    `core/retention.py`: "Text holds no model weights: LM Studio does. So
    retention here is a per-request HINT forwarded to the engine." The hint was
    never forwarded, because the instance that served every request was named
    `openai_compat`.
    """

    @pytest.mark.asyncio
    async def test_lm_studio_from_the_registry_sends_extra_body_ttl(self):
        provider = _registry().get("lm-studio")
        provider.apply_retention({"ttl_seconds": 900})
        create = AsyncMock(return_value=_completion())
        stub_client(provider, AsyncMock()).chat.completions.create = create

        await provider.generate(GenerateRequest(prompt="hi", model="m", provider="lm-studio"))

        assert create.await_args.kwargs["extra_body"] == {"ttl": 900}

    @pytest.mark.asyncio
    async def test_generic_openai_compat_from_the_registry_sends_nothing(self):
        """A generic OpenAI-wire server 400s on an unknown body field."""
        provider = _registry().get("openai_compat")
        provider.apply_retention({"ttl_seconds": 900})
        create = AsyncMock(return_value=_completion())
        stub_client(provider, AsyncMock()).chat.completions.create = create

        await provider.generate(GenerateRequest(prompt="hi", model="m", provider="openai_compat"))

        assert "extra_body" not in create.await_args.kwargs


# ── 3. Native `/api/v0/models` enrichment belongs to LM Studio alone ─────────


class TestNativeEnrichmentIsLmStudioOnly:
    def _provider(self):
        from text.providers.lmstudio import LMStudioProvider

        provider = LMStudioProvider()
        client = stub_client(provider, AsyncMock())
        client.models.list = AsyncMock(return_value=_List())
        provider._last_base_url = "http://lmstudio.test/v1"
        return provider

    @pytest.mark.asyncio
    async def test_lm_studio_enriches_from_api_v0_models(self, monkeypatch):
        from text.providers import lmstudio as mod

        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.url.path)
            return httpx.Response(
                200,
                json={"data": [{"id": "qwen3-8b", "state": "loaded", "quantization": "Q4_K_M"}]},
            )

        monkeypatch.setattr(
            mod,
            "_native_probe_client",
            lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )

        info = await self._provider().get_info()

        assert seen == ["/api/v0/models"]
        assert info.models[0].state == "loaded"

    @pytest.mark.asyncio
    async def test_generic_openai_compat_never_probes_the_native_route(self, monkeypatch):
        from text.providers import lmstudio as mod
        from text.providers.openai_compat import OpenAICompatProvider

        called: list[str] = []

        def _boom() -> httpx.AsyncClient:
            called.append("probed")
            raise AssertionError("the generic adapter must not probe /api/v0/models")

        monkeypatch.setattr(mod, "_native_probe_client", _boom)

        provider = OpenAICompatProvider()
        client = stub_client(provider, AsyncMock())
        client.models.list = AsyncMock(return_value=_List())
        provider._last_base_url = "http://generic.test/v1"

        info = await provider.get_info()

        assert called == []
        assert info.models[0].state is None
        assert info.models[0].engine_native is None


# ── 4. Outbound: what actually reaches LM Studio ────────────────────────────


class TestOutboundWireToLmStudio:
    """LM Studio is a THIRD-PARTY OpenAI-compatible server, not a HOPE peer.

    `06-python-services.md` requires `X-Service-Token` + a mandatory
    `X-Tenant-Id` on internal PEER calls (text→guardrail, nlp→text). LM Studio
    is on the other side of the trust boundary: it has no HOPE service identity,
    no headless authentication of any kind, and no notion of a tenant. Sending
    either header there would export the one shared internal token — and the
    caller's tenant id — to a process that cannot use them, so neither is sent.
    The only credential on the wire is the connection row's own `api_key`, which
    for a keyless local engine is the `not-needed` placeholder.
    """

    @pytest.mark.asyncio
    async def test_only_the_connection_credential_goes_on_the_wire(self, monkeypatch):
        import httpx2

        from text.providers import openai_compat as compat
        from text.providers.lmstudio import LMStudioProvider

        seen: dict[str, Any] = {}

        def handler(request: httpx2.Request) -> httpx2.Response:
            seen["headers"] = {k.lower(): v for k, v in request.headers.items()}
            seen["path"] = request.url.path
            return httpx2.Response(
                200,
                json={
                    "id": "c1",
                    "object": "chat.completion",
                    "created": 0,
                    "model": "m",
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": "ok"},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                },
            )

        monkeypatch.setattr(
            compat,
            "pooled_http_client",
            lambda *_a, **_kw: httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
        )

        provider = LMStudioProvider()
        request = connected(
            GenerateRequest(prompt="hi", model="m", provider="lm-studio"),
            key="not-needed",
            base_url="http://hope-lmstudio:1234/v1",
        )

        await provider.generate(request)

        assert seen["path"] == "/v1/chat/completions"
        assert seen["headers"]["authorization"] == "Bearer not-needed"
        assert "x-service-token" not in seen["headers"]
        assert "x-tenant-id" not in seen["headers"]


# ── 5. Inbound: an internal caller reaches LM Studio through /generate ──────


@pytest.fixture
def app():
    from text.main import create_app

    registry = _registry()
    tm = AsyncMock()
    task_state = MagicMock()
    task_state.task_id = "task-lms"
    tm.create_task = AsyncMock(return_value=task_state)
    tm.update_task = AsyncMock()
    tm.append_chunk = AsyncMock()

    application = create_app()
    application.state.provider_registry = registry
    application.state.task_manager = tm
    return application


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class TestInboundInternalCallReachesLmStudio:
    @pytest.mark.asyncio
    async def test_generate_routes_a_lm_studio_request_to_the_lm_studio_adapter(self, app, client):
        provider = app.state.provider_registry.get("lm-studio")
        create = AsyncMock(return_value=_completion())
        stub_client(provider, AsyncMock()).chat.completions.create = create

        resp = await client.post(
            "/api/v1/generate",
            json={
                "prompt": "summarize this",
                "model": "gemma-4-e2b-it-qat",
                "provider": "lm-studio",
                "provider_overrides": {
                    "lm-studio": {
                        "api_key": "not-needed",
                        "base_url": "http://hope-lmstudio:1234/v1",
                    }
                },
            },
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["provider"] == "lm-studio"
        assert body["stats"]["provider"] == "lm-studio"
        assert create.await_count == 1
