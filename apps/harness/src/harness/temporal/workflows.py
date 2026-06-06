"""Temporal workflows.

Workflow code MUST be deterministic: no direct I/O, no wall-clock/random access,
no non-deterministic imports at module top-level. All side effects are delegated
to Activities. This mirrors the TASK-330 design constraint where the harness
loop body is a deterministic workflow and guides/generate/sensors are Activities.
"""

from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

# Pass the activity module + the (pure) sensor aggregator through the workflow
# sandbox unchanged — importing them at the top level keeps the workflow
# definition deterministic while still giving us the typed activity stubs +
# payload types and the pure verdict aggregator.
with workflow.unsafe.imports_passed_through():
    from harness.sensors.aggregator import GateDecision, aggregate
    from harness.sensors.base import NEREntity
    from harness.sensors.registry import COMPUTATIONAL_SENSOR_NAMES
    from harness.temporal.activities import (
        PingInput,
        PingResult,
        assemble_prompt,
        escalate_gate,
        extract_entities,
        generate,
        persist_draft,
        persist_entities,
        ping_activity,
        record_gate_decision,
        run_sensors,
    )
    from harness.temporal.models import (
        ApprovalSignal,
        AssembleInput,
        EscalateInput,
        ExtractEntitiesInput,
        GenerateInput,
        HarnessDocWorkflowInput,
        HarnessDocWorkflowResult,
        PersistDraftInput,
        PersistEntitiesInput,
        RecordGateInput,
        RunSensorsInput,
    )

# Retry / timeout budgets. NLP failures are tolerated (degrade -> human review),
# so its retries are bounded short; everything else gets the standard budget.
_ACTIVITY_TIMEOUT = timedelta(seconds=150)
_ESCALATE_TIMEOUT = timedelta(seconds=30)
_NLP_RETRY = RetryPolicy(maximum_attempts=2)
_API_RETRY = RetryPolicy(maximum_attempts=3)
_GENERATE_RETRY = RetryPolicy(maximum_attempts=2)


@workflow.defn
class HarnessPingWorkflow:
    """Trivial durable workflow that delegates to ``ping_activity``.

    Proves the durable substrate the real ``guides → generate → sensors → gate``
    loop will use: a deterministic body that executes a retryable activity.
    """

    @workflow.run
    async def run(self, message: str) -> PingResult:
        return await workflow.execute_activity(
            ping_activity,
            PingInput(message=message),
            start_to_close_timeout=timedelta(seconds=10),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )


@workflow.defn
class HarnessDocWorkflow:
    """The bounded ``guides → generate → sensors → gate`` clinical-doc loop.

    Deterministic body; every side effect is an activity. Flow:
    extract transcript entities -> persist -> bounded regen loop
    (assemble -> generate -> extract note entities -> run sensors -> aggregate)
    -> persist the draft (PENDING_REVIEW) -> clinician gate (``approval`` signal
    raced against a durable SLA timer that escalates on breach and keeps waiting)
    -> record the GATE_DECISION audit.

    Fail-safe: NLP unavailable degrades to a forced human review (never auto-PASS);
    SMR failure propagates (never silently downgrade — no draft is persisted).
    """

    def __init__(self) -> None:
        self._approval: ApprovalSignal | None = None
        self._phase: str = "INIT"

    @workflow.signal
    async def approval(self, payload: ApprovalSignal) -> None:
        """Clinician sign-off: resolves the gate wait-condition."""
        self._approval = payload

    @workflow.query
    def phase(self) -> str:
        """Current loop phase (for ops/tests; does not affect determinism)."""
        return self._phase

    @workflow.run
    async def run(self, inp: HarnessDocWorkflowInput) -> HarnessDocWorkflowResult:
        # 1) Transcript NER. NLP down -> degrade (force human review), don't crash.
        self._phase = "EXTRACT"
        degraded = False
        transcript_entities: list[NEREntity] = []
        try:
            extracted = await workflow.execute_activity(
                extract_entities,
                ExtractEntitiesInput(text=inp.transcript_text, language=inp.conversation_language),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_NLP_RETRY,
            )
            transcript_entities = extracted.entities
        except ActivityError:
            degraded = True

        if transcript_entities:
            await workflow.execute_activity(
                persist_entities,
                PersistEntitiesInput(
                    consultation_id=inp.consultation_id,
                    tenant_id=inp.tenant_id,
                    context_item_id=inp.context_item_id,
                    entities=transcript_entities,
                    user_id=inp.user_id,
                ),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_API_RETRY,
            )

        # 2) Bounded regen loop: assemble -> generate -> sensors -> aggregate.
        self._phase = "GENERATE"
        regens_used = 0
        verdict = None
        generated = None
        assembled = None
        sensors = None
        while True:
            assembled = await workflow.execute_activity(
                assemble_prompt,
                AssembleInput(
                    consultation_id=inp.consultation_id,
                    tenant_id=inp.tenant_id,
                    user_id=inp.user_id,
                    template=inp.template,
                    dna_style_id=inp.dna_style_id,
                    conversation_language=inp.conversation_language,
                ),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_API_RETRY,
            )
            generated = await workflow.execute_activity(
                generate,
                GenerateInput(
                    prompt=assembled.user_prompt,
                    system_prompt=assembled.system_prompt,
                    response_format=assembled.response_format,
                    hyperparameters=assembled.hyperparameters,
                    provider=inp.smr_provider,
                    model=inp.smr_model,
                ),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_GENERATE_RETRY,
            )

            note_entities: list[NEREntity] = []
            try:
                note_extracted = await workflow.execute_activity(
                    extract_entities,
                    ExtractEntitiesInput(
                        text=generated.content, language=inp.conversation_language
                    ),
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_NLP_RETRY,
                )
                note_entities = note_extracted.entities
            except ActivityError:
                degraded = True

            sensors = await workflow.execute_activity(
                run_sensors,
                RunSensorsInput(
                    note_text=generated.content,
                    transcript_text=inp.transcript_text,
                    note_entities=note_entities,
                    transcript_entities=transcript_entities,
                    response_format=assembled.response_format,
                    transcript_context_item_id=inp.context_item_id,
                ),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_API_RETRY,
            )

            verdict = aggregate(
                sensors.results,
                regens_remaining=inp.gate.max_regen - regens_used,
                degraded=degraded,
                expected=list(COMPUTATIONAL_SENSOR_NAMES),
            )
            if verdict.decision != GateDecision.REGEN or regens_used >= inp.gate.max_regen:
                break
            regens_used += 1

        decision = str(verdict.decision)

        # 3) Persist the draft -> PENDING_REVIEW (clinician confirm-before-commit).
        self._phase = "PERSIST"
        draft = await workflow.execute_activity(
            persist_draft,
            PersistDraftInput(
                consultation_id=inp.consultation_id,
                tenant_id=inp.tenant_id,
                user_id=inp.user_id,
                job_id=inp.job_id,
                content=generated.content,
                model_name=generated.model or None,
                sensor_scores=sensors.scores,
                citations_map=sensors.citations_map,
                entity_faithfulness_score=sensors.scores.get("entity_faithfulness"),
                coverage_score=sensors.scores.get("coverage_omission"),
                prompt_template_id=assembled.prompt_template_id,
                prompt_version=assembled.prompt_version,
                dna_style_id=inp.dna_style_id,
                gate_decision=decision,
                is_auto_generated=True,
            ),
            start_to_close_timeout=_ACTIVITY_TIMEOUT,
            retry_policy=_API_RETRY,
        )

        # 4) Clinician gate: approval signal raced against a durable SLA timer.
        self._phase = "GATE"
        escalations = 0
        deadline = inp.gate.gate_sla_seconds
        while self._approval is None:
            try:
                await workflow.wait_condition(
                    lambda: self._approval is not None,
                    timeout=timedelta(seconds=deadline),
                )
            except TimeoutError:
                await workflow.execute_activity(
                    escalate_gate,
                    EscalateInput(
                        consultation_id=inp.consultation_id,
                        tenant_id=inp.tenant_id,
                        reason="gate_sla_breached",
                        job_id=inp.job_id,
                    ),
                    start_to_close_timeout=_ESCALATE_TIMEOUT,
                    retry_policy=_API_RETRY,
                )
                escalations += 1
                deadline = inp.gate.gate_escalation_seconds

        approval = self._approval

        # 5) Record the GATE_DECISION (WORM audit) and finish.
        self._phase = "RECORD"
        await workflow.execute_activity(
            record_gate_decision,
            RecordGateInput(
                consultation_id=inp.consultation_id,
                tenant_id=inp.tenant_id,
                user_id=inp.user_id,
                decision=approval.decision or "SIGNED",
                gate_decision=decision,
                context_item_version_id=approval.context_item_version_id,
                attestation_hash=approval.attestation_hash,
                clinician_id=approval.clinician_id,
            ),
            start_to_close_timeout=_ACTIVITY_TIMEOUT,
            retry_policy=_API_RETRY,
        )

        self._phase = "DONE"
        return HarnessDocWorkflowResult(
            consultation_id=inp.consultation_id,
            decision=decision,
            context_item_id=draft.context_item_id,
            regens_used=regens_used,
            escalations=escalations,
            approved=True,
            clinician_id=approval.clinician_id,
        )
