"""Guardrail audit logging for HIPAA compliance.

Emits structured audit events for every guardrail scan result — clean,
suspicious, or blocked — so that a complete audit trail exists for
compliance review.
"""

from __future__ import annotations

import dataclasses

import structlog

logger = structlog.get_logger("smr_v2.services.audit")


@dataclasses.dataclass
class GuardrailAuditEvent:
    request_id: str
    timestamp: str
    guardrail_type: str
    action: str
    is_suspicious: bool
    risk_level: str
    matched_patterns: list[str]
    provider: str
    model: str
    scan_duration_ms: float


class GuardrailAuditLogger:
    """Emits structured ``guardrail.audit`` events via structlog."""

    def log_scan(self, event: GuardrailAuditEvent) -> None:
        payload = dataclasses.asdict(event)

        if event.action == "blocked":
            logger.error("guardrail.audit", **payload)
        elif event.is_suspicious:
            logger.warning("guardrail.audit", **payload)
        else:
            logger.info("guardrail.audit", **payload)
