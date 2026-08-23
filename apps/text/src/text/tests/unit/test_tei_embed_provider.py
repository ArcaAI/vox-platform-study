"""TeiEmbedProvider — TEI `/embed` client.

Hermetic: httpx.MockTransport stands in for a live tei-embed instance (verified
against TEI's documented `/embed` REST contract).

TASK-799 lane B: the TEI endpoint is no longer `TEXT_TEI_BASE_URL`. Like every
other engine, it arrives with the request as a resolved connection, so the tests
below supply one — and the two that matter most assert what happens when nobody
does.
"""

from __future__ import annotations

import httpx
import pytest
from pydantic import SecretStr

from text.models.embedding import EmbeddingRequest
from text.models.requests import ProviderOverride

_ENGINE_URL = "http://tei.test"


def _provider(handler):
    from text.providers.tei_embed import TeiEmbedProvider

    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(transport=transport)
    return TeiEmbedProvider(http)


def _request(texts: list[str], *, base_url: str | None = _ENGINE_URL) -> EmbeddingRequest:
    """An embedding request carrying a resolved tei-embed connection."""
    return EmbeddingRequest(
        texts=texts,
        provider="tei-embed",
        provider_overrides={
            "tei-embed": ProviderOverride(api_key=SecretStr("not-needed"), base_url=base_url)
        },
    )


class TestEmbed:
    @pytest.mark.asyncio
    async def test_posts_inputs_and_returns_vectors_in_order(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/embed"
            captured["url"] = str(request.url)
            captured["body"] = httpx.Request.read(request)
            return httpx.Response(200, json=[[0.1, 0.2], [0.3, 0.4]])

        provider = _provider(handler)
        req = _request(["hello", "world"])
        vectors = await provider.embed(req.texts, req)

        assert vectors == [[0.1, 0.2], [0.3, 0.4]]
        assert captured["url"] == f"{_ENGINE_URL}/embed"
        import json as _json

        body = _json.loads(captured["body"])
        assert body["inputs"] == ["hello", "world"]

    @pytest.mark.asyncio
    async def test_raises_on_engine_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"error": "model not loaded"})

        provider = _provider(handler)
        req = _request(["hello"])
        with pytest.raises(httpx.HTTPStatusError):
            await provider.embed(req.texts, req)

    @pytest.mark.asyncio
    async def test_no_connection_fails_closed(self):
        """No injected connection ⇒ raise, and never open a socket.

        `TEXT_TEI_BASE_URL` was a process-wide endpoint that no tenant could
        override and no admin could change without a redeploy; with it gone there
        is nothing to guess.
        """
        from text.core.exceptions import ProviderCredentialsError

        called: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            called.append(str(request.url))
            return httpx.Response(200, json=[[0.1]])

        provider = _provider(handler)
        bare = EmbeddingRequest(texts=["hello"], provider="tei-embed")
        with pytest.raises(ProviderCredentialsError):
            await provider.embed(bare.texts, bare)
        assert called == []

    @pytest.mark.asyncio
    async def test_a_connection_without_an_endpoint_fails_closed(self):
        from text.core.exceptions import ProviderCredentialsError

        provider = _provider(lambda r: httpx.Response(200, json=[[0.1]]))
        req = _request(["hello"], base_url=None)
        with pytest.raises(ProviderCredentialsError):
            await provider.embed(req.texts, req)


class TestHealthCheck:
    @pytest.mark.asyncio
    async def test_healthy_on_200(self):
        provider = _provider(lambda r: httpx.Response(200))
        provider._last_base_url = _ENGINE_URL
        assert await provider.health_check() is True

    @pytest.mark.asyncio
    async def test_unhealthy_on_connect_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        provider = _provider(handler)
        provider._last_base_url = _ENGINE_URL
        assert await provider.health_check() is False

    @pytest.mark.asyncio
    async def test_unprobed_provider_is_not_reported_unhealthy(self):
        """Fail-OPEN on "never contacted" — `PoolHealthTracker` acts only on a
        POSITIVELY known-unhealthy result."""
        called: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            called.append(str(request.url))
            return httpx.Response(200)

        provider = _provider(handler)
        assert await provider.health_check() is True
        assert called == []


class TestGetInfo:
    @pytest.mark.asyncio
    async def test_reports_available_when_the_observed_engine_answers(self):
        provider = _provider(lambda r: httpx.Response(200))
        provider._last_base_url = _ENGINE_URL
        info = await provider.get_info()

        assert info.name == "tei-embed"
        assert info.status == "available"

    @pytest.mark.asyncio
    async def test_advertises_no_model_of_its_own(self):
        """TEI serves exactly one model per container (`MODEL_ID`) — a property of
        the deployed container, not of this adapter. `TEXT_TEI_DEFAULT_MODEL` was
        a second, silently drifting copy of it; the catalogue is `AiModel`."""
        provider = _provider(lambda r: httpx.Response(200))
        provider._last_base_url = _ENGINE_URL
        info = await provider.get_info()

        assert info.default_model == ""
        assert info.models == []

    @pytest.mark.asyncio
    async def test_reports_unavailable_when_unreachable(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        provider = _provider(handler)
        provider._last_base_url = _ENGINE_URL
        info = await provider.get_info()

        assert info.status == "unavailable"
