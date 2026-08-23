"""Embedding request/response models (TASK-725 Task 4)."""

from __future__ import annotations

from pydantic import BaseModel, Field

from text.models.requests import ProviderOverride


class EmbeddingRequest(BaseModel):
    """Synchronous, immediate embedding call — mirrors `/generate`'s shape for
    the small-batch, low-latency case."""

    texts: list[str] = Field(..., min_length=1, max_length=32)
    provider: str = "tei-embed"
    # Informational only today (TEI serves one model per container); carried for
    # forward compat with a future multi-model embedding provider.
    model: str | None = None
    # The resolved engine connection, same channel and same shape as
    # `GenerateRequest.provider_overrides`. Text holds no `TEXT_TEI_BASE_URL` of
    # its own, so this is where the endpoint comes from; absent, the call fails
    # closed with a typed 503 (`core/connection.py`).
    provider_overrides: dict[str, ProviderOverride] | None = None

    @property
    def text_count(self) -> int:
        return len(self.texts)


class EmbeddingResponse(BaseModel):
    embeddings: list[list[float]]
    provider: str
    model: str
    dim: int


class EmbeddingBatchRequest(BaseModel):
    """Async embedding submission — enqueued onto `WorkerPoolQueue` and
    processed out-of-process (TASK-725 Task 7's worker entry point), for
    batches too large for the synchronous `/embeddings` round trip."""

    texts: list[str] = Field(..., min_length=1)
    provider: str = "tei-embed"
    # Carried through the queue envelope so the out-of-process worker resolves
    # the SAME connection the submitting request did — the worker has no gateway
    # to ask, and must not invent an endpoint of its own.
    provider_overrides: dict[str, ProviderOverride] | None = None


class EmbeddingBatchAcceptedResponse(BaseModel):
    task_id: str
    status: str = "queued"
