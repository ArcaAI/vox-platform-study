"""Guardrail's declared failure vocabulary.

One type, and it exists so that "the safety engine could not answer" can never again
be spelled ``{"safe": True}``.

**Why an exception rather than a sentinel verdict.** `.claude/rules/06-python-services.md`
draws the line: *"a moderation verdict may fail closed; a generated label must raise,
never be fabricated"*. An engine — the LLM judge, the ONNX classifier — produces a
LABEL. When it times out or errors it produced nothing, and a dict is far too easy to
read past: every call site that did ``result.get("safe", True)`` was one keystroke from
re-opening the gate. An exception cannot be read past.

**Where the verdict is re-formed.** The endpoints translate this into a fail-closed
answer, and the translation deliberately differs by endpoint arity:

* **single-item** (``/guardrail/analyze``, ``/medical/validate``) → **HTTP 503**. HTTP 200
  is thereby reserved for a verdict a model actually rendered, so ``safe: true`` on the
  wire always means something computed it. 503 rather than a 200 carrying
  ``safe: false`` because an undetermined verdict is RETRYABLE and a content rejection
  is not: ``apps/text``'s gate maps a not-allowed 200 to a **422 content rejection** and
  a transport failure to a retryable **503**, so answering 200/``safe: false`` for an
  engine timeout would tell a clinician their note was rejected on its content.
* **batch** (``/guardrail/analyze/batch``, ``/medical/validate/batch``) → **200 with the
  individual element marked**: ``safe=False, issues=["undetermined"]``. A batch is a
  multiplex; one unresolved element must neither void the resolved ones nor collapse
  the response to a single status code. The ``undetermined`` tag is what keeps it
  distinguishable from a genuine content violation.

**What this type is NOT for.** A DECLARED ``enabled=False`` bypass is an operator's
configuration decision, not an inability to answer, and it keeps its documented
short-circuit (the same posture ``apps/text``'s ``ExternalGuardrailClient`` preserves for
its own ``enabled=False``). The rule is: *failures raise; declared disables stay
bypasses.*
"""

from __future__ import annotations

# Reasons are a closed vocabulary so logs and metrics can be grouped, and so a caller
# reading `detail` never has to parse prose.
REASON_TIMEOUT = "timeout"
REASON_ENGINE_ERROR = "engine_error"
REASON_INVALID_RESPONSE = "invalid_response"
REASON_UNSUPPORTED = "unsupported_guardrail_type"

# The issue tag batch responses carry for an element whose verdict never resolved.
ISSUE_UNDETERMINED = "undetermined"


class GuardrailUndeterminedError(RuntimeError):
    """A safety verdict could not be computed. It must NEVER degrade to ``safe``.

    ``reason`` is one of the ``REASON_*`` constants above; ``detail`` is a PHI-free
    description (engine error text, never the analysed text itself).
    """

    def __init__(self, reason: str, detail: str = "") -> None:
        self.reason = reason
        self.detail = detail
        super().__init__(
            f"guardrail verdict undetermined ({reason}): {detail}"
            if detail
            else f"guardrail verdict undetermined ({reason})"
        )

    def as_detail(self) -> str:
        """The HTTP ``detail`` string for a fail-closed 503."""
        return f"guardrail verdict undetermined ({self.reason}) — refusing to report 'safe'"
