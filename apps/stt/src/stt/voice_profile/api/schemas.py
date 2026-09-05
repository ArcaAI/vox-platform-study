"""Request/response schemas for the voice profile extraction API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ExtractionResponse(BaseModel):
    """Response for POST /internal/voice-profile/extract."""

    embedding: list[float] = Field(
        ...,
        description=(
            "Speaker embedding. Its width is whatever the model the caller named emits — "
            "TASK-887 made `UserVoiceProfile.embedding` a dimension-agnostic pgvector "
            "`vector`, because a profile is only ever compared against profiles from the "
            "same model."
        ),
    )
    model_id: str = Field(
        ...,
        description="The loader id of the model that produced the embedding (its `sourceUri`).",
    )
    model_slug: str = Field(
        ...,
        description=(
            "The `AiModel` SLUG the caller named — echoed verbatim so the gateway stores the "
            "same identity it resolved from the agent (`UserVoiceProfile.modelId`)."
        ),
    )
