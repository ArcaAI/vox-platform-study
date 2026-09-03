"""Consultation-palette node activities — the consent gate, the PHI hop, and the HITL-gate
placeholder (/9).

``consultation.consentGate`` and ``consultation.phiHop`` are real: they wrap the existing
``_check_consent`` helper and ``GuardrailClient.redact()`` respectively, per
`contracts/palette-contract.md`consultation.hitlGate's activity here is deliberately NOT its
execution path: Phase B landed the durable wait as a child workflow
(`interpreter/gate_workflow.py`), and the compiler lifts every `gate`-classed node out of
`stages` into `gates`, so the interpreter starts `ConsultationGateWorkflow` for it instead of
dispatching an activity. The callable below stays because `NodeSpec.activity` requires one and
because `activity_name` is the S-4 cross-check anchor — reaching it means a routing bug.

The palette's other ten node types were left unwired by and are now implemented in
`consultation_{capture,nlp,compose,verify,persist}.py`, grouped by pipeline stage — each a thin
`NodeActivityInput -> NodeActivityResult` wrapper over the already-shipped activity
`contracts/node-types.md`'s node table names as its compile target, following the two real
examples in this file. Shared identity/binding helpers live in `_consultation_shared.py`.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity

from harness.core.config import get_settings
from harness.services.guardrail_client import GuardrailClient, GuardrailServiceError
from harness.temporal.activities import _check_consent
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._shared import (
    STATUS_DEGRADED,
    STATUS_OK,
    now,
    record_and_flush,
)

#: CR-01's own register ids (`ConsentPurpose.AI_DOCUMENTATION`, `enums.prisma:669` —
#: "Consultation capture + AI-assisted note generation (INV-201, INV-004)") are an exact match to
#: this node's role as the mandatory-subgraph entry point.
_CONSENT_PURPOSE_AI_DOCUMENTATION = "AI_DOCUMENTATION"


@activity.defn(name="interpreter.consultation_consent_gate")
async def interpreter_consultation_consent_gate(payload: NodeActivityInput) -> NodeActivityResult:
    """N-1 ``consultation.consentGate`` (mandatory, critical — CR-01/CR-04).

    Thin wrapper over the EXISTING, already-tested `_check_consent()` helper
    (`harness.temporal.activities`, consent-abac Phase 4) — see
    `contracts/palette-contract.md` Reads `externalPatientId`/`consultationId` from
    `payload.run_payload` (the generic, palette-agnostic invocation payload — NOT palette-specific
    config, since consent identity is a property of the RUN, not something a tenant authors on
    the node). Fail-closed: any non-allowed decision (denial OR lookup-unavailable) DEGRADES this
    node — never `SUCCEEDED` — with the two cases kept distinguishable via `error_code`
    (`consent_denied` vs `consent_unavailable`), mirroring every other `_check_consent` call site.
    """
    started = now()
    settings = get_settings()

    external_patient_id = payload.run_payload.get("externalPatientId")
    consultation_id = payload.run_payload.get("consultationId")

    decision = await _check_consent(
        settings,
        tenant_id=payload.tenant_id,
        external_patient_id=external_patient_id,
        purpose=_CONSENT_PURPOSE_AI_DOCUMENTATION,
        consultation_id=consultation_id,
    )
    if not decision.allowed:
        error_code = "consent_unavailable" if decision.unavailable else "consent_denied"
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code=error_code
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason=f"consent gate did not pass (purpose={_CONSENT_PURPOSE_AI_DOCUMENTATION}): {error_code}",
        )

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={"allowed": True, "grantId": decision.grant_id},
    )


@activity.defn(name="interpreter.consultation_phi_hop")
async def interpreter_consultation_phi_hop(payload: NodeActivityInput) -> NodeActivityResult:
    """N-5 ``consultation.phiHop`` (mandatory — CR-15's structural half, WF-CONS-009).

    Thin wrapper over `GuardrailClient.redact` (calling
    `POST /guardrail/redact` peer-to-peer) — see `contracts/palette-contract.mdconfig.mode`
    is `'pseudonymize' | 'full'` (the same two-mode vocabulary `IPhiRedactor.redact()` uses on the
    gateway side). The text to redact is read generically from `bound_inputs` (same pattern
    `nodes/guardrail_check.py`'s `_extract_text` uses) — never re-derives it from a fixed port
    name. A transport/HTTP failure DEGRADES (never a silent unredacted pass-through — the
    `stt.phiHop` precedent's own rule, restated: "fail loudly, never pass through while claiming
    the hop ran").
    """
    started = now()
    config = payload.config
    mode = config.get("mode")
    if mode not in ("pseudonymize", "full"):
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="invalid_mode"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"config.mode {mode!r} is not 'pseudonymize' or 'full'"
        )

    text = _extract_text(payload.bound_inputs)
    if not text:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_bound_text"
        )
        return NodeActivityResult(status="DEGRADED", reason="no text bound to redact")

    settings = get_settings()
    client = GuardrailClient(
        settings.guardrail_base_url,
        # D-D: the shared `INTERNAL_ACCESS_TOKEN` (see `guardrail_check.py`).
        service_token=settings.peer_service_token(settings.guardrail_service_token),
        timeout=settings.guardrail_timeout_s,
    )
    try:
        result = await client.redact(text=text, mode=mode, tenant_id=payload.tenant_id)
    except GuardrailServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="guardrail_unreachable"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"guardrail redact unreachable — no sanitized text: {exc}"
        )

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={"text": result.sanitized_text, "mode": mode, "entityCount": len(result.entities)},
    )


def _extract_text(bound_inputs: dict[str, Any]) -> str | None:
    """Mirrors `nodes/guardrail_check.py`'s `_extract_text` — generic over upstream port names."""
    for value in bound_inputs.values():
        text = value.get("text") if isinstance(value, dict) else None
        if isinstance(text, str) and text:
            return text
    for value in bound_inputs.values():
        if isinstance(value, str) and value:
            return value
    return None


_HITL_GATE_NOT_AN_ACTIVITY = (
    'consultation.hitlGate is a `kind="child_workflow"` node: the compiler lifts every '
    "`gate`-classed node out of `stages` into `gates`, and `WorkflowInterpreter._run_gate` starts "
    "`ConsultationGateWorkflow` for it (see interpreter/gate_workflow.py). This activity is never "
    "the execution path — it exists because `NodeSpec.activity` requires a callable and because "
    "`activity_name` is the S-4 cross-check anchor. Reaching it means a routing bug; it DEGRADES "
    "and names why, and it NEVER returns a result that could be read as an approval (the "
    "03-compliance-posture.md §3 forgery shape this must never resemble)."
)


@activity.defn(name="interpreter.consultation_hitl_gate")
async def interpreter_consultation_hitl_gate(payload: NodeActivityInput) -> NodeActivityResult:
    """N-13 ``consultation.hitlGate`` — NOT the gate's execution path. See the module docstring
    and `_HITL_GATE_NOT_AN_ACTIVITY`."""
    started = now()
    await record_and_flush(
        payload, status=STATUS_DEGRADED, started=started, error_code="not_a_real_execution_path"
    )
    return NodeActivityResult(status="DEGRADED", reason=_HITL_GATE_NOT_AN_ACTIVITY)
