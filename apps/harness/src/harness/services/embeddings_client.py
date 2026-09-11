"""Dense-embeddings tool client — LM Studio OpenAI-compatible ``/v1/embeddings``.

Phase-3 retrieval embeds both the institutional corpus (at ingest) and the
entity-derived query (at retrieval) through the **self-hosted** LM Studio
endpoint by default: the query can contain PHI, so the PLATFORM never egresses it
to a cloud provider.

D-1c changes WHO may point this elsewhere, not that rule. A tenant
that enables its own `AiProviderConnection(service='embeddings')` row redirects
its OWN embeddings to its OWN account — a BYO decision the connection plane
exists to express (`CLOUD_BYO_PROVIDERS.embeddings` has listed `azure`/`openai`
since the plane was widened, and the console has offered the card all along; the
only thing that was missing was anything reading it). With no row, nothing moves:
the platform floor stays self-hosted. The client posts the OpenAI shape
``{model, input:[...]}`` to ``{base_url}/embeddings`` and returns the per-input
vectors ordered by the response ``index`` (the server may return them out of
order). It mirrors the :class:`~harness.services.nlp_client.NlpClient` httpx
idiom — a transport / non-2xx failure raises :class:`EmbeddingsServiceError` so
the caller (ingest endpoint / retriever) can degrade rather than fabricate.
"""

from __future__ import annotations

from typing import Any

import httpx

from harness.core.llm_concurrency import governed_request


class EmbeddingsServiceError(RuntimeError):
    """The embeddings backend was unreachable or returned a non-2xx response."""


class EmbeddingsClient:
    """Thin async client for the OpenAI-compatible embeddings endpoint."""

    def __init__(
        self,
        base_url: str,
        *,
        model: str,
        timeout: float = 30.0,
        api_key: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._timeout = timeout
        # D-1c — a bearer only when a connection row supplied one. The
        # platform's own embeddings server authenticates nobody, so `None` (the
        # unauthenticated call) is a CORRECT resolved state, not a missing value,
        # and `""` is never sent as a credential.
        self._api_key = api_key or None
        self._transport = transport

    @property
    def model(self) -> str:
        """The model id this client posts — the tenant's when a row pinned one.

        Read by the ingest endpoint for the ``embeddingModel`` chunk descriptor,
        so a persisted chunk records what actually embedded it rather than what
        the platform floor would have used.
        """
        return self._model

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed ``texts`` and return one dense vector per input (index-ordered)."""
        if not texts:
            return []
        url = f"{self._base_url}/embeddings"
        body = {"model": self._model, "input": list(texts)}
        headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else None
        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:

            async def _send() -> httpx.Response:
                resp = await client.post(url, json=body, headers=headers)
                resp.raise_for_status()
                return resp

            # Shares the per-endpoint governor with the judge + safety guardian (the
            # self-hosted LM Studio box), so retrieval embedding never bursts it.
            try:
                resp = await governed_request(self._base_url, _send)
            except httpx.HTTPError as exc:
                raise EmbeddingsServiceError(f"embeddings request failed: {exc}") from exc
            data = resp.json()
        return self._parse_vectors(data, expected=len(texts))

    async def embed_one(self, text: str) -> list[float]:
        """Embed a single string and return its dense vector."""
        vectors = await self.embed([text])
        if not vectors:
            raise EmbeddingsServiceError("embeddings backend returned no vector")
        return vectors[0]

    @staticmethod
    def _parse_vectors(data: dict[str, Any], *, expected: int) -> list[list[float]]:
        rows = data.get("data")
        if not isinstance(rows, list) or len(rows) != expected:
            raise EmbeddingsServiceError(
                f"embeddings response shape invalid: expected {expected} vectors"
            )
        # Sort by the OpenAI ``index`` (defaulting to insertion order) so vectors
        # line up with the input list regardless of server ordering.
        ordered = sorted(rows, key=lambda r: r.get("index", 0))
        vectors: list[list[float]] = []
        for row in ordered:
            embedding = row.get("embedding")
            if not isinstance(embedding, list):
                raise EmbeddingsServiceError("embeddings response missing 'embedding'")
            vectors.append([float(x) for x in embedding])
        return vectors
