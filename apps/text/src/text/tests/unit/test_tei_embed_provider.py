"""TeiEmbedProvider — TEI `/embed` client (TASK-725 Task 4).

Hermetic: httpx.MockTransport stands in for a live tei-embed instance (local
infra is down; verified against TEI's documented `/embed` REST contract).
RED: written before `providers/tei_embed.py` existed.
"""

from __future__ import annotations

import httpx
import pytest



def _provider(handler):
    from text.providers.tei_embed import TeiEmbedProvider

    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(transport=transport)
    return TeiEmbedProvider(TeiEmbedConfig(base_url="http://tei.test"), http)


class TestEmbed:
    @pytest.mark.asyncio
    async def test_posts_inputs_and_returns_vectors_in_order(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/embed"
            captured["body"] = httpx.Request.read(request)
            return httpx.Response(200, json=[[0.1, 0.2], [0.3, 0.4]])

        provider = _provider(handler)
        vectors = await provider.embed(["hello", "world"])

        assert vectors == [[0.1, 0.2], [0.3, 0.4]]
        import json as _json

        body = _json.loads(captured["body"])
        assert body["inputs"] == ["hello", "world"]

    @pytest.mark.asyncio
    async def test_raises_on_engine_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"error": "model not loaded"})

        provider = _provider(handler)
        with pytest.raises(httpx.HTTPStatusError):
            await provider.embed(["hello"])


class TestHealthCheck:
    @pytest.mark.asyncio
    async def test_healthy_on_200(self):
        provider = _provider(lambda r: httpx.Response(200))
        assert await provider.health_check() is True

    @pytest.mark.asyncio
    async def test_unhealthy_on_connect_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        provider = _provider(handler)
        assert await provider.health_check() is False


class TestGetInfo:
    @pytest.mark.asyncio
    async def test_reports_configured_model_when_available(self):
        provider = _provider(lambda r: httpx.Response(200))
        info = await provider.get_info()

        assert info.name == "tei-embed"
        assert info.default_model == "BAAI/bge-m3"
        assert info.status == "available"

    @pytest.mark.asyncio
    async def test_reports_unavailable_when_unreachable(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        provider = _provider(handler)
        info = await provider.get_info()

        assert info.status == "unavailable"
