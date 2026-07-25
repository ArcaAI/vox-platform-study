"""Generation audit logging for HIPAA compliance.

Emits structured audit events for every generation request — success or failure.
"""

from __future__ import annotations

import dataclasses

import structlog


@dataclasses.dataclass
class GenerationAuditEvent:
    request_id: str
    timestamp: str  # ISO 8601
    provider: str
    model: str
    status: str  # "completed", "failed", "streaming"
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    latency_ms: int
    finish_reason: str
    error: str | None = None


class GenerationAuditLogger:
    """Emits structured generation.audit events via structlog."""

    def log_generation(self, event: GenerationAuditEvent) -> None:
        logger = structlog.get_logger("smr.audit.generation")
        payload = dataclasses.asdict(event)

        if event.status == "failed":
            logger.error("generation.audit", **payload)
        else:
            logger.info("generation.audit", **payload)
