"""Response models for the Text API."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field

from text.models.stats import GenerationStats
from text.models.usage import UsageDetail


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


class DataFinding(BaseModel):
    """One FC-5b data finding: a ``trust: "data"`` region guardrail flagged without
    blocking (TASK-1047). Region key and check names only, never text."""

    region: str
    reasons: list[str] = Field(default_factory=list)


class EgressSummary(BaseModel):
    """What the egress pipeline did to this call (TASK-1035 §5.0). Counts only.

    ``detected`` is keyed by taxonomy label and counts identifiers whether or not
    they were replaced (a LOCAL call detects and replaces nothing). ``redacted`` is
    how many occurrences were tokenised on the way out, ``restored`` how many
    tokens were re-identified on the way back. ``images_unredacted`` counts image
    parts sent to a cloud provider as-is (images cannot be pseudonymized; owner
    decision 2026-10-02 lets them through and audits the count).
    ``guardrail_data_findings`` (TASK-1047 FC-5b) lists the data regions the inbound
    screen flagged without blocking — region keys and check names, never text.
    """

    locality: str
    detected: dict[str, int] = Field(default_factory=dict)
    redacted: int = 0
    restored: int = 0
    pii_leak_blocked: bool = False
    images_unredacted: int = 0
    guardrail_data_findings: list[DataFinding] = Field(default_factory=list)


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
    # Billing passthrough: everything the gateway needs to write ledger rows for
    # this call, including the provider's own cache/reasoning breakdown, which
    # the flat ``usage`` above cannot express. PHI-free by construction.
    usage_detail: UsageDetail | None = None
    # The guardrail LLM call this generation triggered, if any. Guardrail is a
    # peer service with no gateway in front of it, so riding back here is the
    # only path its token spend has to the billing plane.
    guardrail_usage: UsageDetail | None = None
    # TASK-1035 — the egress summary; counts only, never values.
    egress: EgressSummary | None = None
    # TASK-1050 — the `GuardrailNotice` v1 objects (`warn` / `unverified`; a block is a
    # 422 instead) raised on this generation, inbound then outbound, and the
    # guardrail evaluation id of every screen call (the reconciler's gap key).
    # PHI-free by construction: fixed labels and check ids, never content.
    guardrail_notices: list[dict[str, Any]] = Field(default_factory=list)
    guardrail_evaluation_ids: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class StreamingGenerateResponse(BaseModel):
    task_id: str
    status: str
    stream_url: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class GenerateBatchAcceptedResponse(BaseModel):
    """``POST /generate/batch``'s 202 envelope — same shape as
    ``EmbeddingBatchAcceptedResponse`` (``models/embedding.py``): a `task_id`
    pollable via the existing `GET /tasks/{task_id}` (no duplicate status
    route)."""

    task_id: str
    status: str = "queued"


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
    # J3-4 — what a gateway bench meters from. See `models/task.TaskState.usage_detail`.
    usage_detail: UsageDetail | None = None
    total_chunks: int = 0
    total_tokens: int = 0
