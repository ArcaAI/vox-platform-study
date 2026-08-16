"""N-4 — ``guardrail.check`` (TASK-720 Task 5, safety class: mandatory, non-removable).

Calls ``apps/guardrail`` directly via :class:`~harness.services.guardrail_client.GuardrailClient`
(``POST /guardrail/analyze``). Fail-CLOSED per README §2/§4 Task 5: a ``GuardrailResponse``
carrying a non-null ``error`` (guardrail's OWN fail-open branch,
``apps/guardrail/.../guardrails.py:96-105``), a transport failure, or a timeout is treated as
**NO VERDICT** — this activity NEVER returns ``SUCCEEDED``/"safe" for any of those three cases,
regardless of ``analysis.safe``. ``config.failOn`` is restricted by its own JSON Schema to the
single v1-permitted value ``'unsafe_or_unknown'`` (an "unsafe-only" gate is exactly the
posture that would let a guardrail outage launder into a silent pass — see the schema's own
description).

**Known, disclosed v1 gap on ``config.onFail: 'abort'``**: palette.md's own rationale reads
"`onFail: 'abort'` in the node's own config is how a tenant makes a specific run's guardrail
failure fatal". `critical` is a CODE-OWNED registry property (`NODE_REGISTRY['guardrail.check']`
is `critical=False`, never tenant-configurable — execution-semantics.md §5/§9), and
`NodeActivityResult.status` has no `FAILED` member (only the workflow body can promote a
`DEGRADED` critical node to run-level `FAILED`) — there is therefore NO mechanism in the shipped
v1 interpreter for a per-node CONFIG value to override a CODE-OWNED registry property. This
activity accepts and records `onFail` (so the value survives to the trajectory / node output for
a future ticket to act on) but does NOT fake a promotion to `FAILED` — recorded here, and in this
ticket's README §7, as a real gap rather than silently implemented as a no-op.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity

from harness.core.config import get_settings
from harness.services.guardrail_client import (
    GuardrailAnalysis,
    GuardrailClient,
    GuardrailServiceError,
)
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._shared import (
    STATUS_ERROR,
    STATUS_OK,
    now,
    record_and_flush,
)


def _extract_text(bound_inputs: dict[str, Any]) -> str | None:
    """The generated text to check — from `generate.text`'s own output shape
    (`{"text": ..., "provider": ..., "model": ...}`) or, defensively, any bound string value."""
    for value in bound_inputs.values():
        text = value.get("text") if isinstance(value, dict) else None
        if isinstance(text, str) and text:
            return text
    for value in bound_inputs.values():
        if isinstance(value, str) and value:
            return value
    return None


@activity.defn(name="interpreter.guardrail_check")
async def interpreter_guardrail_check(payload: NodeActivityInput) -> NodeActivityResult:
    started = now()
    config = payload.config
    guardrail_type = config.get("guardrailType") or "comprehensive"
    on_fail = config.get("onFail", "mark")

    text = _extract_text(payload.bound_inputs)
    if not text:
        await record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="no_bound_text"
        )
        return NodeActivityResult(status="DEGRADED", reason="no generated text bound to check")

    settings = get_settings()
    client = GuardrailClient(
        settings.guardrail_base_url,
        service_token=settings.service_token.get_secret_value(),
        timeout=settings.guardrail_timeout_s,
    )
    try:
        analysis: GuardrailAnalysis = await client.analyze(
            text=text, tenant_id=payload.tenant_id, guardrail_type=guardrail_type
        )
    except GuardrailServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="guardrail_unreachable"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"guardrail unreachable — no verdict: {exc}"
        )

    if analysis.error is not None:
        # Guardrail's own fail-open branch fired. Its `safe` field is UNTRUSTED here — this is
        # exactly the "no verdict" case the module docstring names.
        await record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="guardrail_no_verdict"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"guardrail returned no verdict: {analysis.error}"
        )

    if not analysis.safe:
        await record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="guardrail_unsafe"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"guardrail verdict unsafe (onFail={on_fail}); issues={analysis.issues}",
        )

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={"text": text, "verdict": "safe", "confidence": analysis.confidence},
    )
