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

    # TASK-816 Phase 2 — the tenant's clinical gates, which this lane used to DROP.
    #
    # `HarnessPolicy`'s five threshold columns are the tenant tier of a gate whose platform tier
    # is the settings registry (`harness.sensor.*`, resolved by `resolve_sensor_thresholds`).
    # The legacy durable loop threads them onto every `RunSensorsInput` (`workflows.py:512`);
    # this node did not, so `_platform_thresholds(None)` fell through to the PLATFORM value and a
    # tenant that TIGHTENED a fabrication or numeric-dose gate had it silently loosened on the
    # substrate every graph-mode consultation runs on. Only `groundednessThreshold` survived,
    # because the INFERENTIAL node below reads it — which is what made the loss easy to miss.
    #
    # `None` is not a fallback here, it is the "no tenant opinion" signal `_platform_thresholds`
    # already understands: an unreachable policy leaves the clinical gate exactly where it was
    # rather than degrading this non-critical verifier (CR-14).
    thresholds = None
    try:
        raw_policy = await _api_client(get_settings()).get_policy(payload.tenant_id)
    except ApiServiceError as exc:
        activity.logger.warning(
            "consultation_sensors: effective policy unreachable, gating on the platform "
            "thresholds for this run: %s",
            exc,
        )
    else:
        thresholds = HarnessPolicy.from_api(raw_policy).to_sensor_thresholds()

    chunk_ids = bound_value(payload.bound_inputs, "chunkIds")
    try:
        result = await run_sensors(
            RunSensorsInput(
                note_text=note_text,
                transcript_text=_transcript_text(payload),
                note_entities=bound_entities(payload.bound_inputs),
                retrieved_chunk_ids=[c for c in (chunk_ids or []) if isinstance(c, str)],
                thresholds=thresholds,
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
        # TASK-809 OD-15 — the assurance record travels as ONE object on the `verdict` socket.
        #
        # Not cosmetic. Under strict per-key binding a socket carries exactly one output key, so a
        # flat `{scores, citationsMap, verdicts}` would have handed `persistDraft` whichever single
        # key the socket named and dropped the rest — SILENTLY, because `bound_value` returns
        # `None` for a missing key and `PersistDraftInput` treats `None` as "no verifier ran".
        # That is clinical assurance data disappearing from a persisted draft with no error
        # anywhere. `text` stays at the top level: it is the `document` PASSTHROUGH socket, which
        # is how the note itself reaches persistence without routing around this verifier (which
        # WF-CONS-011 forbids).
        output={
            "text": note_text,
            "verdict": {
                "scores": result.scores,
                "citationsMap": result.citations_map,
                "verdicts": [r.model_dump(mode="json") for r in result.results],
            },
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

    # TASK-809 OD-15 — one `verdict` object on the socket, `text` passing through at the top
    # level. See `interpreter_consultation_sensors` above for why a flat shape loses data.
    output: dict[str, Any] = {
        "text": note_text,
        "verdict": {
            "guardrailDecisions": result.guardrail_decisions,
            "ragTriadScore": result.rag_triad_score,
            "verdicts": [r.model_dump(mode="json") for r in result.results],
        },
    }
    if result.degraded:
        await record_and_flush(
            payload, status=STATUS_DEGRADED, started=started, error_code="inferential_degraded"
        )
        return NodeActivityResult(
            status="DEGRADED",
            reason="the inferential pass completed with reduced assurance",
            output=_with_reduced_assurance(output, True),
        )

    await record_and_flush(payload, status=STATUS_OK, started=started)
    return NodeActivityResult(status="SUCCEEDED", output=_with_reduced_assurance(output, False))


def _with_reduced_assurance(output: dict[str, Any], reduced: bool) -> dict[str, Any]:
    """`reducedAssurance` belongs INSIDE the verdict object, alongside the rest of the assurance
    record — it is read by `persistDraft`/`finalizeAssurance` through the same bound socket, so a
    top-level copy would be the one field that survives when the others do not."""
    return {**output, "verdict": {**output["verdict"], "reducedAssurance": reduced}}
