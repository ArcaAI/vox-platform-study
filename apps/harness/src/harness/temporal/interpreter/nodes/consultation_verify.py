"""N-9 ``consultation.sensors`` and N-10 ``consultation.inferentialSensors`` — the verifier
stage.

Compile targets per ``contracts/palette-contract.md`` §1 rows 8a/8b: ``run_sensors`` (the
computational pass) and ``run_inferential_sensors`` (the LLM-as-judge pass).

Both are non-critical by CR-14 — "a failing sensor ... must not fail the whole run". They
DEGRADE and publish whatever verdicts they did produce, so a downstream ``persistDraft`` still
records an honest, visibly-reduced assurance rather than nothing at all.

**The judge is DB-selected and fails closed.** ``RunInferentialSensorsInput.judge_provider``/
``judge_model`` are ``None``-able precisely so that "no SYSTEM judge selection" degrades instead
of silently falling back to an env-configured judge (env carries connection config only, never
model selection). This node reads them off the effective policy and passes them through
unchanged — it never substitutes a default.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity

from harness.core.config import get_settings
from harness.services.api_client import ApiServiceError
from harness.temporal.activities import (
    _api_client,  # noqa: SLF001 — the sanctioned accessor, same as nodes/text_generate.py
    run_inferential_sensors,
    run_sensors,
)
from harness.temporal.interpreter.models import NodeActivityInput, NodeActivityResult
from harness.temporal.interpreter.nodes._consultation_shared import (
    bound_entities,
    bound_text,
    bound_value,
    run_identity,
)
from harness.temporal.interpreter.nodes._shared import (
    STATUS_DEGRADED,
    STATUS_OK,
    now,
    record_and_flush,
)
from harness.temporal.models import (
    HarnessPolicy,
    RunInferentialSensorsInput,
    RunSensorsInput,
)


def _transcript_text(payload: NodeActivityInput) -> str:
    """The transcript is a property of the RUN, not of the node — same split as every other
    identity field (see ``_consultation_shared``)."""
    value = payload.run_payload.get("transcriptText")
    return value if isinstance(value, str) else ""


@activity.defn(name="interpreter.consultation_sensors")
async def interpreter_consultation_sensors(payload: NodeActivityInput) -> NodeActivityResult:
    """N-9 — the computational verifier pass over the bound draft note."""
    started = now()
    note_text = bound_text(payload.bound_inputs)
    if not note_text:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_bound_note"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="no draft note bound from an upstream node to verify"
        )

    chunk_ids = bound_value(payload.bound_inputs, "chunkIds")
    try:
        result = await run_sensors(
            RunSensorsInput(
                note_text=note_text,
                transcript_text=_transcript_text(payload),
                note_entities=bound_entities(payload.bound_inputs),
                retrieved_chunk_ids=[c for c in (chunk_ids or []) if isinstance(c, str)],
            )
        )
    except Exception as exc:  # noqa: BLE001 — CR-14: a failing sensor degrades, never fails the run
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="sensors_failed"
        )
        return NodeActivityResult(status="DEGRADED", reason=f"sensor pass failed: {exc}")

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(
        status="SUCCEEDED",
        output={
            "text": note_text,
            "scores": result.scores,
            "citationsMap": result.citations_map,
            "verdicts": [r.model_dump(mode="json") for r in result.results],
        },
    )


@activity.defn(name="interpreter.consultation_inferential_sensors")
async def interpreter_consultation_inferential_sensors(
    payload: NodeActivityInput,
) -> NodeActivityResult:
    """N-10 — the LLM-as-judge verifier pass (groundedness + safety screen)."""
    started = now()
    note_text = bound_text(payload.bound_inputs)
    if not note_text:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_bound_note"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="no draft note bound from an upstream node to verify"
        )

    try:
        raw_policy = await _api_client(get_settings()).get_policy(payload.tenant_id)
    except ApiServiceError as exc:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="policy_fetch_unreachable"
        )
        return NodeActivityResult(
            status="DEGRADED", reason=f"effective policy fetch unreachable: {exc}"
        )

    policy = HarnessPolicy.from_api(raw_policy)
    if not policy.judge_provider or not policy.judge_model:
        # Fail closed — never substitute an env-selected judge (see the module docstring).
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="no_judge_selection"
        )
        return NodeActivityResult(
            status="DEGRADED", reason="no judge provider/model resolved for this tenant"
        )

    identity = run_identity(payload.run_payload)
    citations_map = bound_value(payload.bound_inputs, "citationsMap")
    try:
        result = await run_inferential_sensors(
            RunInferentialSensorsInput(
                note_text=note_text,
                transcript_text=_transcript_text(payload),
                citations_map=citations_map if isinstance(citations_map, dict) else {},
                groundedness_threshold=policy.groundedness_threshold,
                safety_enabled=policy.safety_enabled,
                judge_provider=policy.judge_provider,
                judge_model=policy.judge_model,
                phi_enabled=policy.phi_enabled,
                phi_fail_closed=policy.phi_fail_closed,
                consultation_id=identity.consultation_id,
                tenant_id=payload.tenant_id,
            )
        )
    except Exception as exc:  # noqa: BLE001 — CR-14, same posture as the computational pass
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="inferential_failed"
        )
        return NodeActivityResult(status="DEGRADED", reason=f"inferential pass failed: {exc}")

    output: dict[str, Any] = {
        "text": note_text,
        "guardrailDecisions": result.guardrail_decisions,
        "ragTriadScore": result.rag_triad_score,
        "verdicts": [r.model_dump(mode="json") for r in result.results],
    }
    if result.degraded:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="inferential_degraded"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason="the inferential pass completed with reduced assurance",
            output={**output, "reducedAssurance": True},
        )

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED", output={**output, "reducedAssurance": False})
