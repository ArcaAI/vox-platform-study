"""Temporal workflows.

Workflow code MUST be deterministic: no direct I/O, no wall-clock/random access,
no non-deterministic imports at module top-level. All side effects are delegated
to Activities. This mirrors the TASK-330 design constraint where the harness
loop body is a deterministic workflow and guides/generate/sensors are Activities.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError

# Pass the activity module + the (pure) sensor aggregator through the workflow
# sandbox unchanged — importing them at the top level keeps the workflow
# definition deterministic while still giving us the typed activity stubs +
# payload types and the pure verdict aggregator.
with workflow.unsafe.imports_passed_through():
    from harness.sensors.aggregator import GateDecision, aggregate
    from harness.sensors.base import NEREntity, SensorResult
    from harness.sensors.registry import COMPUTATIONAL_SENSOR_NAMES
    from harness.temporal.activities import (
        PingInput,
        PingResult,
        assemble_prompt,
        escalate_gate,
        extract_entities,
        fetch_policy,
        generate,
        persist_draft,
        persist_entities,
        ping_activity,
        record_gate_decision,
        retrieve_context,
        run_inferential_sensors,
        run_sensors,
    )
    from harness.temporal.models import (
        DEFAULT_GROUNDEDNESS_THRESHOLD,
        ApprovalSignal,
        AssembleInput,
        EscalateInput,
        ExtractEntitiesInput,
        FetchPolicyInput,
        GenerateInput,
        HarnessDocWorkflowInput,
        HarnessDocWorkflowResult,
        HarnessGateConfig,
        HarnessPolicy,
        PersistDraftInput,
        PersistEntitiesInput,
        RecordGateInput,
        RetrieveContextInput,
        RetrievedContext,
        RunInferentialSensorsInput,
        RunSensorsInput,
    )

# Retry / timeout budgets. NLP failures are tolerated (degrade -> human review),
# so its retries are bounded short; everything else gets the standard budget. The
# inferential pass degrades internally (never raises for backend outages), so its
# retries cover only infra blips before the workflow falls back to reduced assurance.
_ACTIVITY_TIMEOUT = timedelta(seconds=150)
# The inferential pass makes MANY sequential model calls (groundedness + citation_verify
# per claim, plus the per-dimension safety screen). Under the LLM concurrency governor
# (HARNESS_LLM_MAX_CONCURRENCY, default 1) these run effectively serialized so the
# shared LM Studio box is never bursted — correct, but slower wall-clock than the
# generic 150s budget allows once a draft carries dozens of claims (a single cold
# local judge call is ~10-20s). Give this one activity a generous start-to-close so
# the governed (burst-safe) pass completes instead of timing out into reduced assurance.
_INFERENTIAL_TIMEOUT = timedelta(seconds=900)
_ESCALATE_TIMEOUT = timedelta(seconds=30)
_NLP_RETRY = RetryPolicy(maximum_attempts=2)
_API_RETRY = RetryPolicy(maximum_attempts=3)
_GENERATE_RETRY = RetryPolicy(maximum_attempts=2)
_INFERENTIAL_RETRY = RetryPolicy(maximum_attempts=2)
# Retrieval degrades internally (never raises for backend outages); its retries
# cover only infra blips before the workflow falls back to an empty context.
_RETRIEVAL_RETRY = RetryPolicy(maximum_attempts=2)


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
        # 0) Live policy injection (Phase 6). Read ONCE at the start in an activity
        # (I/O stays out of the deterministic body) and thread the result through.
        # A failed fetch degrades to the code defaults — never crash the loop, and
        # this is NOT a clinical degradation (it does not set reduced_assurance).
        self._phase = "POLICY"
        policy: HarnessPolicy | None = None
        try:
            policy = await workflow.execute_activity(
                fetch_policy,
                FetchPolicyInput(tenant_id=inp.tenant_id),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_API_RETRY,
            )
        except ActivityError:
            policy = None

        # Effective loop knobs: the policy overrides the snapshotted gate budget and
        # supplies sensor thresholds, guard toggles, and model defaults; the input
        # (and code defaults) govern when there is no policy.
        if policy is not None:
            gate = HarnessGateConfig(
                max_regen=policy.max_regen,
                gate_sla_seconds=policy.gate_sla_seconds,
                gate_escalation_seconds=policy.gate_escalation_seconds,
            )
            sensor_thresholds = policy.to_sensor_thresholds()
            groundedness_threshold = policy.groundedness_threshold
            safety_enabled = policy.safety_enabled
            # The workflow input wins over the policy default when it specifies a model.
            smr_provider = inp.smr_provider or policy.smr_provider
            smr_model = inp.smr_model or policy.smr_model
        else:
            gate = inp.gate
            sensor_thresholds = None
            groundedness_threshold = DEFAULT_GROUNDEDNESS_THRESHOLD
            safety_enabled = True
            smr_provider = inp.smr_provider
            smr_model = inp.smr_model

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

        # 1b) Institutional RAG (Phase 3, flag-gated). JIT hybrid retrieval is
        # entity-triggered and stable across regens, so it runs ONCE here (before the
        # loop) and the prompt is augmented with the cited chunks each iteration. A
        # degraded retrieval (backend down) yields an empty context and flags reduced
        # assurance; it never raises into the loop.
        self._phase = "RETRIEVE"
        reduced_assurance = False
        try:
            retrieved = await workflow.execute_activity(
                retrieve_context,
                RetrieveContextInput(tenant_id=inp.tenant_id, entities=transcript_entities),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_RETRIEVAL_RETRY,
            )
        except ActivityError:
            retrieved = RetrievedContext(degraded=True)
        if retrieved.degraded:
            reduced_assurance = True
        retrieved_chunk_ids = [c.chunk_id for c in retrieved.chunks]
        knowledge_chunks = {c.chunk_id: c.text for c in retrieved.chunks}

        # 2) Bounded regen loop. The five computational sensors run every iteration
        # (cheap); once they settle, the costly inferential pass (groundedness +
        # safety) runs ONCE and is folded into the verdict — groundedness can consume
        # one remaining regen, safety forces a FLAG (unsafe content is never
        # auto-regenerated). A degraded/failed inferential backend degrades to reduced
        # assurance: the gate proceeds on the computational verdict (never auto-PASS).
        self._phase = "GENERATE"
        regens_used = 0
        verdict = None
        generated = None
        assembled = None
        sensors = None
        guardrail_decisions: dict[str, Any] = {}
        rag_triad_score: float | None = None
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
            # Augment the prompt with the retrieved Knowledge Context (StrictCitations).
            # Empty block (retrieval off / no hits / degraded) leaves the prompt unchanged.
            user_prompt = assembled.user_prompt
            if retrieved.prompt_block:
                user_prompt = f"{user_prompt}\n\n{retrieved.prompt_block}"

            generated = await workflow.execute_activity(
                generate,
                GenerateInput(
                    prompt=user_prompt,
                    system_prompt=assembled.system_prompt,
                    response_format=assembled.response_format,
                    hyperparameters=assembled.hyperparameters,
                    provider=smr_provider,
                    model=smr_model,
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
                    retrieved_chunk_ids=retrieved_chunk_ids,
                    thresholds=sensor_thresholds,
                ),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_API_RETRY,
            )

            # Cheap computational verdict first: regenerate on REGEN while budget
            # remains WITHOUT paying for the inferential pass.
            comp_verdict = aggregate(
                sensors.results,
                regens_remaining=gate.max_regen - regens_used,
                degraded=degraded,
                expected=list(COMPUTATIONAL_SENSOR_NAMES),
            )
            if comp_verdict.decision == GateDecision.REGEN and regens_used < gate.max_regen:
                regens_used += 1
                continue

            # Computational settled -> run the inferential pass once and fold it in.
            # An infra failure of the activity degrades to reduced assurance.
            self._phase = "INFER"
            inferential = None
            try:
                inferential = await workflow.execute_activity(
                    run_inferential_sensors,
                    RunInferentialSensorsInput(
                        note_text=generated.content,
                        transcript_text=inp.transcript_text,
                        citations_map=sensors.citations_map,
                        knowledge_chunks=knowledge_chunks,
                        groundedness_threshold=groundedness_threshold,
                        safety_enabled=safety_enabled,
                    ),
                    start_to_close_timeout=_INFERENTIAL_TIMEOUT,
                    retry_policy=_INFERENTIAL_RETRY,
                )
            except ActivityError:
                reduced_assurance = True

            inferential_results: list[SensorResult] = []
            if inferential is not None:
                guardrail_decisions = inferential.guardrail_decisions
                rag_triad_score = inferential.rag_triad_score
                if inferential.degraded:
                    reduced_assurance = True
                # Reduced assurance: exclude a degraded inferential result (and omit
                # it from `expected`) so the gate proceeds on the computational
                # verdict instead of a blanket FLAG — never a silent auto-PASS.
                inferential_results = [r for r in inferential.results if not r.degraded]
            inferential_expected = [r.name for r in inferential_results]

            verdict = aggregate(
                list(sensors.results) + inferential_results,
                regens_remaining=gate.max_regen - regens_used,
                degraded=degraded,
                expected=list(COMPUTATIONAL_SENSOR_NAMES) + inferential_expected,
            )
            if verdict.decision == GateDecision.REGEN and regens_used < gate.max_regen:
                regens_used += 1
                continue
            break

        decision = str(verdict.decision)

        # 3) Persist the draft -> PENDING_REVIEW (clinician confirm-before-commit).
        # guardrail_decisions + ragTriadScore land on SummaryMeta; reduced_assurance
        # drives the REDUCED_ASSURANCE WORM event on apps/api.
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
                guardrail_decisions=guardrail_decisions or None,
                reduced_assurance=reduced_assurance,
                entity_faithfulness_score=sensors.scores.get("entity_faithfulness"),
                coverage_score=sensors.scores.get("coverage_omission"),
                rag_triad_score=rag_triad_score,
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
        deadline = gate.gate_sla_seconds
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
                deadline = gate.gate_escalation_seconds

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
