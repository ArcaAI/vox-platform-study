"""Stream chunk model for SSE / WebSocket events."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel


class StreamChunk(BaseModel):
    # TASK-1050: `guardrail.notice` carries one `GuardrailNotice` v1 in `data`.
    type: Literal["chunk", "reasoning", "meta", "done", "error", "usage", "guardrail.notice"]
    content: str | None = None
    data: dict[str, Any] | None = None
