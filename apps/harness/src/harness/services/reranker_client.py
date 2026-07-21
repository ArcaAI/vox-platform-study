"""Cross-encoder reranker tool client — HF TEI ``/rerank``.

The hybrid retriever's last stage: the fused dense+sparse candidates are reranked
by a self-hosted Text-Embeddings-Inference cross-encoder (``hope-reranker`` serving
``BAAI/bge-reranker-v2-m3``). The client posts the TEI shape
``{query, texts:[...], return_text:false}`` to ``{base_url}/rerank`` and returns the
``(index, score)`` pairs ordered by descending score so the retriever can take
top-k. Mirrors the :class:`~harness.services.nlp_client.NlpClient` httpx idiom: a
transport / non-2xx failure raises :class:`RerankerServiceError` so the retriever
degrades to empty context rather than raising into the durable loop.
"""

from __future__ import annotations

from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict

from harness.core.llm_concurrency import governed_request


class RerankerServiceError(RuntimeError):
    """The reranker backend was unreachable or returned a non-2xx response."""


class RerankResult(BaseModel):
    """One reranked candidate: its position in the input list + relevance score."""

    model_config = ConfigDict(extra="forbid")

    index: int
    score: float


class RerankerClient:
    """Thin async client for the TEI cross-encoder ``/rerank`` endpoint."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 30.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._transport = transport

    async def rerank(self, query: str, texts: list[str]) -> list[RerankResult]:
        """Rerank ``texts`` against ``query``; returns results ordered best-first."""
        if not texts:
            return []
        url = f"{self._base_url}/rerank"
        body = {"query": query, "texts": list(texts), "return_text": False}
        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:

            async def _send() -> httpx.Response:
                resp = await client.post(url, json=body)
                resp.raise_for_status()
                return resp

            # Per-endpoint governor (its own TEI box): bounded retry on a transient
            # 5xx/connection blip before the retriever degrades to empty context.
            try:
                resp = await governed_request(self._base_url, _send)
            except httpx.HTTPError as exc:
                raise RerankerServiceError(f"rerank request failed: {exc}") from exc
            data = resp.json()
        return self._parse(data)

    @staticmethod
    def _parse(data: Any) -> list[RerankResult]:
        if not isinstance(data, list):
            raise RerankerServiceError("rerank response shape invalid: expected a list")
        results: list[RerankResult] = []
        for row in data:
            if not isinstance(row, dict) or "index" not in row or "score" not in row:
                raise RerankerServiceError("rerank response missing 'index'/'score'")
            results.append(RerankResult(index=int(row["index"]), score=float(row["score"])))
        # TEI returns descending; sort defensively so callers can rely on the order.
        results.sort(key=lambda r: r.score, reverse=True)
        return results
