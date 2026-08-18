"""Consultation-palette node activities (TASK-731 Task 4/9 — a partial pass, see README §7).

Only THREE of the palette's thirteen node types are wired to real code this pass:
``consultation.consentGate``, ``consultation.phiHop`` (both genuinely new — README §2.3's two
"missing compile target" gaps, resolved per `contracts/palette-contract.md` §4a/§4b), and
``consultation.hitlGate`` (a documented `implemented: false` PLACEHOLDER — the same mechanism
`stt_placeholder.py`'s `interpreter_stt_phi_hop` uses — because the durable-wait interpreter
extension (Phase B) has not been implemented yet; see the ticket README §7 for why).

The remaining ten node types (`captureBinding`, `extractEntities`, `bindTerminology`,
`retrieveEvidence`, `assemblePrompt`, `synthesize`, `sensors`, `inferentialSensors`,
`persistDraft`, `finalizeAssurance`) each have a REAL, already-shipped, already-tested compile
target in `harness.temporal.activities` (see `contracts/node-types.md`'s node table for the exact
activity + `models.py` input-model file:line for each) — building their own thin
`NodeActivityInput -> NodeActivityResult` interpreter wrappers (mirroring this file's two real
examples, or `nodes/text_generate.py`'s reimplementation-over-lower-level-clients pattern) is
real, disclosed, NOT-YET-DONE follow-up work, not a design gap. Registering them here without a
carefully-verified field-by-field mapping to each activity's own bespoke Pydantic input model
under this pass's time budget was judged a worse outcome than leaving them fully specified in
`contracts/node-types.md` and not yet wired.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity

from harness.core.config import get_settings
from harness.services.guardrail_client import GuardrailClient, GuardrailServiceError
from harness.temporal.activities import _check_consent
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._shared import (
    STATUS_ERROR,
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
    (`harness.temporal.activities`, TASK-712 consent-abac Phase 4) — see
    `contracts/palette-contract.md` §4a. Reads `externalPatientId`/`consultationId` from
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
        await record_and_flush(payload, status=STATUS_ERROR, started=started, error_code=error_code)
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

    Thin wrapper over `GuardrailClient.redact()` (TASK-731, calling TASK-710's
    `POST /guardrail/redact` peer-to-peer) — see `contracts/palette-contract.md` §4b. `config.mode`
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
            payload, status=STATUS_ERROR, started=started, error_code="invalid_mode"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"config.mode {mode!r} is not 'pseudonymize' or 'full'"
        )

    text = _extract_text(payload.bound_inputs)
    if not text:
        await record_and_flush(
            payload, status=STATUS_ERROR, started=started, error_code="no_bound_text"
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
            payload, status=STATUS_ERROR, started=started, error_code="guardrail_unreachable"
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


_HITL_GATE_NOT_IMPLEMENTED = (
    "consultation.hitlGate is registered `implemented: false` — the interpreter's durable-wait "
    "extension (Phase B: an approval/edit signal pair or a child-workflow delegation, see "
    "contracts/palette-contract.md §2) has not been implemented yet. compile() therefore refuses "
    "ANY graph containing this node type (identical to unregistered — WF-C-002), so this activity "
    "can only be reached by a bug bypassing that registry gate. If it ever is, it DEGRADES and "
    "names exactly why — it NEVER returns a result that could be read as an approval (the "
    "03-compliance-posture.md §3 forgery shape this must never resemble)."
)


@activity.defn(name="interpreter.consultation_hitl_gate")
async def interpreter_consultation_hitl_gate(payload: NodeActivityInput) -> NodeActivityResult:
    """N-13 ``consultation.hitlGate`` — PLACEHOLDER, `implemented: false`. See module docstring
    and `contracts/node-types.md`'s "implemented: false" section."""
    started = now()
    await record_and_flush(
        payload, status=STATUS_ERROR, started=started, error_code="not_a_real_execution_path"
    )
    return NodeActivityResult(status="DEGRADED", reason=_HITL_GATE_NOT_IMPLEMENTED)
