"""DNA redaction/rewrite — a separate, auditable post-generation transform (TASK-551).

Style never alters fact selection; redaction is its OWN stage with its own audit
trail. This package holds the PURE deterministic transform engine
(:mod:`harness.redaction.engine`); the Temporal ``apply_redaction`` activity
(:mod:`harness.temporal.activities`) wraps it, adds the optional constrained SMR
rewrite pass, and fails CLOSED (forces a FLAG) when the transform cannot be
confirmed — a note the doctor expected redacted must never slip through silently.
"""

from harness.redaction.engine import (
    CATEGORY_PATTERNS,
    RedactionEngineError,
    RedactionHit,
    RedactionManifest,
    RedactionOutcome,
    RedactionRule,
    apply_deterministic_redaction,
)

__all__ = [
    "CATEGORY_PATTERNS",
    "RedactionEngineError",
    "RedactionHit",
    "RedactionManifest",
    "RedactionOutcome",
    "RedactionRule",
    "apply_deterministic_redaction",
]
