"""Fail-closed PHI redaction guard (TASK-330 Phase 2).

Public API:

* :class:`PhiRedactor` — Presidio analyzer+anonymizer wrapper with a clinical-NER
  recognizer; ``redact(text)`` + fail-closed ``ensure_safe_for_cloud(...)``.
* :class:`RedactionResult` / :class:`RedactedEntity` — the redaction outputs.
* :class:`PhiEgressBlocked` — raised when fail-closed refuses a cloud egress.
* :func:`ensure_egress_safe` / :func:`ensure_inferential_egress_safe` (TASK-357) —
  the policy-aware egress chokepoint the activities enforce before cloud LLM calls.
"""

from harness.guards.phi.egress import (
    ensure_egress_safe,
    ensure_inferential_egress_safe,
    ensure_mcp_args_safe,
)
from harness.guards.phi.redactor import (
    DEFAULT_SPACY_MODEL,
    PhiEgressBlocked,
    PhiRedactor,
    RedactedEntity,
    RedactionResult,
)

__all__ = [
    "DEFAULT_SPACY_MODEL",
    "PhiEgressBlocked",
    "PhiRedactor",
    "RedactedEntity",
    "RedactionResult",
    "ensure_egress_safe",
    "ensure_inferential_egress_safe",
    "ensure_mcp_args_safe",
]
