"""Task state and status models."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field

from text.models.responses import TokenUsage


class TaskStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    RETRYING = "retrying"


class TaskState(BaseModel):
    task_id: str
    status: TaskStatus
    provider: str
    model: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    started_at: datetime | None = None
    completed_at: datetime | None = None
    retry_count: int = 0
    max_retries: int = 3
    error: str | None = None
    total_chunks: int = 0
    total_tokens: int = 0
    # TASK-890 — what a FINALIZE reads back.
    #
    # ``TaskResponse`` has declared ``content`` and ``usage`` since it was written, but the state
    # this service persists carried neither, so ``GET /tasks/{id}`` answered ``content: null`` and
    # ``usage: null`` for every completed generation and the two gateway benches
    # (``finalizePromptTemplateTest``, the draft-agent test finalize) scored an empty string and
    # metered nothing. The response model promised a contract the state could not keep.
    #
    # No new exposure: the deltas are already in the task's Redis stream under the same TTL, so
    # this stores the assembled form of bytes that are already there, and expires with them.
    content: str | None = None
    usage: TokenUsage | None = None
