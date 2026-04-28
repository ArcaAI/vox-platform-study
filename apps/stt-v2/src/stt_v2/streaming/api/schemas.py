"""Request/response schemas for the internal streaming session API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class CreateStreamingSessionRequest(BaseModel):
    """Request body for ``POST /internal/streaming/sessions``."""

    session_id: str = Field(..., description="Unique session identifier (UUID)")
    tenant_id: str = Field(..., description="Tenant identifier")
    pipeline_id: str = Field(..., description="ASR pipeline identifier (UUID or slug)")
    consultation_id: str | None = Field(default=None, description="Optional consultation context")
    sample_rate: int = Field(default=16000, description="Audio sample rate in Hz")
    microphone_id: str | None = Field(
        default=None, description="Identifier for the microphone device"
    )
    user_id: str | None = Field(default=None, description="Authenticated user ID for speaker pre-seeding")
    language: str | None = Field(default=None, description="Override pipeline language (ISO 639-1/639-3 code)")
    audio_bucket_name: str | None = Field(
        default=None,
        description="Tenant-scoped audio bucket name. Defaults to 'hope-audio' if not provided.",
    )


class StreamingSessionResponse(BaseModel):
    """Response for session creation and status queries."""

    session_id: str
    status: str = Field(..., description="Session status: active, finalizing, closed, rejected")
    reason: str | None = Field(default=None, description="Rejection reason (e.g. 'at_capacity')")
    max_concurrent: int = Field(..., description="Maximum concurrent sessions for this worker")
    current_active: int = Field(..., description="Number of currently active sessions")


class StreamingAvailabilityResponse(BaseModel):
    """Response for ``GET /internal/streaming/availability``."""

    available: bool = Field(
        ..., description="Whether the streaming module is initialized and has capacity"
    )
    status: str = Field(..., description="Module status: ready, not_initialized, at_capacity")
    max_concurrent: int = Field(default=0, description="Maximum concurrent sessions")
    current_active: int = Field(default=0, description="Currently active sessions")
    available_slots: int = Field(default=0, description="Remaining available slots")
