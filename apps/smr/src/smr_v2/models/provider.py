"""Provider and model info models."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ModelInfo(BaseModel):
    name: str
    supports_streaming: bool = True
    context_window: int | None = None


class ProviderInfo(BaseModel):
    name: str
    display_name: str
    status: str = "available"
    default_model: str
    models: list[ModelInfo] = Field(default_factory=list)
    supports_streaming: bool = True


class RateLimitState(BaseModel):
    provider: str
    rpm_limit: int = 0
    rpm_remaining: int = 0
    rpm_reset_seconds: float = 0.0
    tpm_limit: int = 0
    tpm_remaining: int = 0
    tpm_reset_seconds: float = 0.0
    is_rate_limited: bool = False
    retry_after_seconds: float | None = None
