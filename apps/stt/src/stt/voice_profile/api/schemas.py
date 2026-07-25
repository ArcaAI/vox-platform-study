"""Request/response schemas for the voice profile extraction API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ExtractionResponse(BaseModel):
    """Response for POST /internal/voice-profile/extract."""

    embedding: list[float] = Field(..., description="256-dimensional speaker embedding")
    model_id: str = Field(..., description="Embedding model identifier")
