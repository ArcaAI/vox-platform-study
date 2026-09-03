"""Provider and model info models."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ModelInfo(BaseModel):
    name: str
    supports_streaming: bool = True
    context_window: int | None = None
    # Additive probe metadata. ``state`` is the engine-reported load
    # state ("loaded" / "not-loaded"); ``None`` = the engine does not report it.
    # ``engine_native`` carries engine-specific extras (quantization, max
    # context length, ...) verbatim — informational, never used for routing.
    state: str | None = None
    engine_native: dict[str, Any] | None = None
    # Per-MODEL vision capability — informational only. No adapter
    # today introspects a vendor listing for this; ``None`` = unknown/not
    # probed. Left unset until a future per-model capability probe exists.
    supports_vision: bool | None = None


class ProviderInfo(BaseModel):
    name: str
    display_name: str
    status: str = "available"
    default_model: str
    models: list[ModelInfo] = Field(default_factory=list)
    supports_streaming: bool = True
    # Provider-level (wire/protocol) vision capability — True when
    # the adapter can carry an ``ImageContentPart`` to the engine at all. This
    # is an ARCHITECTURAL fact about the adapter, set explicitly by each
    # provider's ``get_info()``; it is NOT a guarantee that the currently
    # loaded/selected model is itself a vision-language model.
    supports_vision: bool = False
    # Per-provider probe outcome, populated by the /providers
    # endpoint (not by the providers themselves). Additive/optional so the
    # gateway fallback mapper and the Text contract test stay compatible.
    probe_status: str | None = None
    probe_latency_ms: int | None = None
    probe_error: str | None = None
    # admin introspection additions. All additive/optional:
    # `pool_health`/`pool_health_checked_at` come from the SAME
    # `PoolHealthTracker` `/generate`'s degrade-routing check consults 
    # — `None` means nobody has health-checked this provider yet (distinct
    # from `False`, which means the LAST check failed). `in_flight_requests`
    # mirrors the `text_active_generations` gauge for this provider.
    pool_health: bool | None = None
    pool_health_checked_at: str | None = None
    in_flight_requests: int = 0


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
