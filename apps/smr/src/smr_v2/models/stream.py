"""Stream chunk model for SSE / WebSocket events."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel


class StreamChunk(BaseModel):
    type: Literal["chunk", "reasoning", "meta", "done", "error", "usage"]
    content: str | None = None
    data: dict[str, Any] | None = None
