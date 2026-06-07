"""Embeddings tool-client tests (RED-first, TASK-330 Phase 3).

Dense embeddings come from the self-hosted LM Studio OpenAI-compatible endpoint
(``POST {base_url}/embeddings``). The client sends ``{model, input:[...]}`` and
returns the per-input vectors **ordered by the response ``index``** (LM Studio /
OpenAI may return them out of order). A transport / non-2xx failure raises
``EmbeddingsServiceError`` so the retriever degrades (never auto-grounds).
"""

from __future__ import annotations

import json

import httpx
import pytest

from harness.services.embeddings_client import EmbeddingsClient, EmbeddingsServiceError


def _capture(payload: dict):
    seen: dict[str, httpx.Request] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["request"] = request
        return httpx.Response(200, json=payload)

    return seen, handler


class TestEmbeddingsClient:
    @pytest.mark.asyncio
    async def test_posts_documented_body_to_embeddings(self):
        seen, handler = _capture(
            {"data": [{"index": 0, "embedding": [0.1, 0.2, 0.3]}], "model": "bge-m3"}
        )
        client = EmbeddingsClient(
            "http://lmstudio:1234/v1", model="bge-m3", transport=httpx.MockTransport(handler)
        )

        await client.embed(["hello"])

        req = seen["request"]
        assert req.method == "POST"
        assert str(req.url) == "http://lmstudio:1234/v1/embeddings"
        assert json.loads(req.content) == {"model": "bge-m3", "input": ["hello"]}

    @pytest.mark.asyncio
    async def test_returns_vectors_ordered_by_index(self):
        # Response intentionally out of order; the client must sort by ``index``.
        _seen, handler = _capture(
            {
                "data": [
                    {"index": 1, "embedding": [1.0, 1.0]},
                    {"index": 0, "embedding": [0.0, 0.0]},
                ]
            }
        )
        client = EmbeddingsClient(
            "http://lmstudio:1234/v1", model="bge-m3", transport=httpx.MockTransport(handler)
        )

        vectors = await client.embed(["a", "b"])
        assert vectors == [[0.0, 0.0], [1.0, 1.0]]

    @pytest.mark.asyncio
    async def test_embed_one_returns_single_vector(self):
        _seen, handler = _capture({"data": [{"index": 0, "embedding": [0.5, 0.6]}]})
        client = EmbeddingsClient(
            "http://lmstudio:1234/v1", model="bge-m3", transport=httpx.MockTransport(handler)
        )
        assert await client.embed_one("q") == [0.5, 0.6]

    @pytest.mark.asyncio
    async def test_empty_input_short_circuits_without_http(self):
        def handler(_request: httpx.Request) -> httpx.Response:  # pragma: no cover
            raise AssertionError("must not call the backend for empty input")

        client = EmbeddingsClient(
            "http://lmstudio:1234/v1", model="bge-m3", transport=httpx.MockTransport(handler)
        )
        assert await client.embed([]) == []

    @pytest.mark.asyncio
    async def test_non_2xx_raises_service_error(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, json={"error": "no model loaded"})

        client = EmbeddingsClient(
            "http://lmstudio:1234/v1", model="bge-m3", transport=httpx.MockTransport(handler)
        )
        with pytest.raises(EmbeddingsServiceError):
            await client.embed(["x"])

    @pytest.mark.asyncio
    async def test_base_url_trailing_slash_is_normalised(self):
        seen, handler = _capture({"data": [{"index": 0, "embedding": [0.1]}]})
        client = EmbeddingsClient(
            "http://lmstudio:1234/v1/", model="bge-m3", transport=httpx.MockTransport(handler)
        )
        await client.embed(["x"])
        assert str(seen["request"].url) == "http://lmstudio:1234/v1/embeddings"
