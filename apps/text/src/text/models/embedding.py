"""Embedding request/response models (TASK-725 Task 4)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class EmbeddingRequest(BaseModel):
    """Synchronous, immediate embedding call — mirrors `/generate`'s shape for
    the small-batch, low-latency case."""

    texts: list[str] = Field(..., min_length=1, max_length=32)
    provider: str = "tei-embed"
    # Informational only today (TEI serves one model per container — see
    # `core/config.py::TeiEmbedConfig`); carried for forward compat with a
    # future multi-model embedding provider.
    model: str | None = None

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


class EmbeddingBatchAcceptedResponse(BaseModel):
    task_id: str
    status: str = "queued"
