"""Fail-closed PHI redaction guard for the harness's DIRECT (non-``/generate``) egress.

LLM egress through ``apps/text`` ``/generate`` is redacted by text itself (TASK-1035). This
package covers only what does not go through it: the inferential judge's direct provider hop
and outbound MCP tool args.

Public API:

* :class:`PhiRedactor` — Presidio analyzer+anonymizer wrapper with a clinical-NER
  recognizer; ``redact(text)`` + fail-closed ``ensure_safe_for_cloud(...)``.
* :class:`RedactionResult` / :class:`RedactedEntity` — the redaction outputs.
* :class:`PhiEgressBlocked` — raised when fail-closed refuses a cloud egress.
* :class:`PhiModelUnavailable` — raised when the spaCy NER model is not installed
  (the redactor refuses rather than downloading it mid-request).
* :func:`ensure_inferential_egress_safe` / :func:`ensure_mcp_args_safe` — the policy-aware
  screens the activities enforce before the direct judge call and an external MCP call.
"""

from harness.guards.phi.egress import (
    ensure_inferential_egress_safe,
    ensure_mcp_args_safe,
)
from harness.guards.phi.redactor import (
    DEFAULT_SPACY_MODEL,
    PhiEgressBlocked,
    PhiModelUnavailable,
    PhiRedactor,
    RedactedEntity,
    RedactionResult,
)

__all__ = [
    "DEFAULT_SPACY_MODEL",
    "PhiEgressBlocked",
    "PhiModelUnavailable",
    "PhiRedactor",
    "RedactedEntity",
    "RedactionResult",
    "ensure_inferential_egress_safe",
    "ensure_mcp_args_safe",
]
