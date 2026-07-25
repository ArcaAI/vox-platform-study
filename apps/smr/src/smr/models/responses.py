"""Response models for the SMR API."""

from __future__ import annotations

from datetime import UTC, datetime

from pydantic import BaseModel, Field

from smr.models.stats import GenerationStats


class ComponentCheckResponse(BaseModel):
    status: str
    duration_ms: float
    message: str | None = None


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
    uptime_seconds: float
    timestamp: str
    checks: dict[str, ComponentCheckResponse]


class LivenessResponse(BaseModel):
    status: str


class ReadinessResponse(BaseModel):
    status: str
    message: str | None = None


class ErrorResponse(BaseModel):
    detail: str


class TokenUsage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class GenerateResponse(BaseModel):
    task_id: str
    status: str
    content: str
    reasoning: str = ""
    provider: str
    model: str
    usage: TokenUsage = Field(default_factory=TokenUsage)
    latency_ms: int = 0
    finish_reason: str = "stop"
    # normalized per-call generation statistics. ``usage`` /
    # ``finish_reason`` / ``latency_ms`` above are retained for wire-compat but
    # DEPRECATED in favor of ``stats`` (superset: normalized stop reason, TTFT,
    # tokens/second, engine-native blob). Consumers should read ``stats``.
    stats: GenerationStats | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class StreamingGenerateResponse(BaseModel):
    task_id: str
    status: str
    stream_url: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class TaskResponse(BaseModel):
    task_id: str
    status: str
    provider: str
    model: str
    retry_count: int = 0
    max_retries: int = 3
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    started_at: datetime | None = None
    completed_at: datetime | None = None
    error: str | None = None
    content: str | None = None
    usage: TokenUsage | None = None
    total_chunks: int = 0
    total_tokens: int = 0
