"""Provider and model info models."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ModelInfo(BaseModel):
    name: str
    supports_streaming: bool = True
    context_window: int | None = None
    # TASK-528 — additive probe metadata. ``state`` is the engine-reported load
    # state ("loaded" / "not-loaded"); ``None`` = the engine does not report it.
    # ``engine_native`` carries engine-specific extras (quantization, max
    # context length, ...) verbatim — informational, never used for routing.
    state: str | None = None
    engine_native: dict[str, Any] | None = None


class ProviderInfo(BaseModel):
    name: str
    display_name: str
    status: str = "available"
    default_model: str
    models: list[ModelInfo] = Field(default_factory=list)
    supports_streaming: bool = True
    # TASK-528 §3.3 — per-provider probe outcome, populated by the /providers
    # endpoint (not by the providers themselves). Additive/optional so the
    # gateway fallback mapper and the SMR contract test stay compatible.
    probe_status: str | None = None
    probe_latency_ms: int | None = None
    probe_error: str | None = None


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
