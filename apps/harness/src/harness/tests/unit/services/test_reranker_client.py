"""Reranker (HF TEI ``/rerank``) client tests (RED-first, TASK-330 Phase 3).

The cross-encoder reranker is the last hybrid-retrieval stage: given the query and
the fused candidate passages it returns a relevance-ordered ``(index, score)`` list
the retriever uses to pick top-k. Mirrors the ``NlpClient`` httpx idiom — a
transport / non-2xx failure raises :class:`RerankerServiceError` so the retriever
degrades (never raises into the loop). The TEI server is faked with
``httpx.MockTransport`` so these tests are hermetic.
"""

from __future__ import annotations

import json

import httpx
import pytest

from harness.services.reranker_client import RerankerClient, RerankerServiceError


@pytest.mark.asyncio
async def test_posts_query_and_texts_and_orders_by_score():
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        # TEI returns descending by score; return it shuffled to prove we sort.
        return httpx.Response(
            200,
            json=[
                {"index": 0, "score": 0.10},
                {"index": 2, "score": 0.95},
                {"index": 1, "score": 0.55},
            ],
        )

    client = RerankerClient(
        "http://reranker:80", timeout=5.0, transport=httpx.MockTransport(handler)
    )
    results = await client.rerank("chest pain", ["a", "b", "c"])

    assert captured["url"].endswith("/rerank")
    assert captured["body"]["query"] == "chest pain"
    assert captured["body"]["texts"] == ["a", "b", "c"]
    # Highest score first.
    assert [r.index for r in results] == [2, 1, 0]
    assert results[0].score == 0.95


@pytest.mark.asyncio
async def test_empty_texts_short_circuits_without_a_call():
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
        raise AssertionError("reranker must not be called with no candidates")

    client = RerankerClient("http://reranker:80", transport=httpx.MockTransport(handler))
    assert await client.rerank("q", []) == []


@pytest.mark.asyncio
async def test_non_2xx_raises_service_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "model loading"})

    client = RerankerClient("http://reranker:80", transport=httpx.MockTransport(handler))
    with pytest.raises(RerankerServiceError):
        await client.rerank("q", ["a", "b"])


@pytest.mark.asyncio
async def test_transport_error_raises_service_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    client = RerankerClient("http://reranker:80", transport=httpx.MockTransport(handler))
    with pytest.raises(RerankerServiceError):
        await client.rerank("q", ["a"])
