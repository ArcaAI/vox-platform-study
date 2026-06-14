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
        finalize_assurance,
        generate,
        persist_draft,
        persist_entities,
        ping_activity,
        record_gate_decision,
        report_progress,
        retrieve_context,
        run_inferential_sensors,
        run_sensors,
    )
    from harness.temporal.models import (
        DEFAULT_GROUNDEDNESS_THRESHOLD,
        HARNESS_DRAFT_PHASE_EARLY,
        HARNESS_PROGRESS_FAILED_LABEL,
        HARNESS_PROGRESS_FAILED_STAGE,
        HARNESS_PROGRESS_STAGES,
        HARNESS_PROGRESS_TERMINAL_LABEL,
        HARNESS_PROGRESS_TERMINAL_STAGE,
        ApprovalSignal,
        AssembleInput,
        EditSignal,
        EscalateInput,
        ExtractEntitiesInput,
        FetchPolicyInput,
        FinalizeAssuranceInput,
        GenerateInput,
        HarnessDocWorkflowInput,
        HarnessDocWorkflowResult,
        HarnessGateConfig,
        HarnessPolicy,
        PersistDraftInput,
        PersistEntitiesInput,
        RecordGateInput,
        ReportProgressInput,
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
# TASK-354 Defect A: the activity now heartbeats (~every 15s) for the whole pass, so a
# dead worker / hung attempt is detected within this window instead of waiting out the
# full 900s start_to_close. start_to_close is KEPT at 900s (a healthy pass is ~344s).
# NOTE (replay safety): adding/changing an activity OPTION does not alter the recorded
# command sequence, so this is replay-safe and needs NO workflow.patched() gate (proven
# by test_replay_compat.py). Do NOT add/remove/reorder any activity call here without a
# patch gate + a captured fixture + a replay test.
_INFERENTIAL_HEARTBEAT_TIMEOUT = timedelta(seconds=60)
_ESCALATE_TIMEOUT = timedelta(seconds=30)
_NLP_RETRY = RetryPolicy(maximum_attempts=2)
_API_RETRY = RetryPolicy(maximum_attempts=3)
_GENERATE_RETRY = RetryPolicy(maximum_attempts=2)
_INFERENTIAL_RETRY = RetryPolicy(maximum_attempts=2)
# Retrieval degrades internally (never raises for backend outages); its retries
# cover only infra blips before the workflow falls back to an empty context.
_RETRIEVAL_RETRY = RetryPolicy(maximum_attempts=2)
# Progress feed (TASK-345): fire-and-forget — one attempt, tiny budget. The
# activity already swallows its own errors; the workflow-side try/except is the
# second belt for timeouts/cancellation.
_PROGRESS_TIMEOUT = timedelta(seconds=10)
_PROGRESS_RETRY = RetryPolicy(maximum_attempts=1)
# (key, label) -> 1-based ordinal lookup for the emission helper.
_PROGRESS_ORDINALS = {key: i + 1 for i, (key, _label) in enumerate(HARNESS_PROGRESS_STAGES)}
_PROGRESS_LABELS = dict(HARNESS_PROGRESS_STAGES)
_PROGRESS_TOTAL = len(HARNESS_PROGRESS_STAGES)


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
        # TASK-355 Phase D (Slice 4b) — clinician-edit signal state for the
        # optimistic assurance loop. ``_edited`` is a per-pass latch (an edit
        # arrived; consumed at the loop top to re-bind + re-run). ``_ever_edited``
        # is sticky: once the clinician touches the delivered draft, the
        # regen-if-untouched path is permanently disabled (a REGEN-fixable verdict
        # surfaces as a FLAG instead of silently swapping the note). These never
        # affect the legacy path (no post-delivery assurance window there).
        self._edited: bool = False
        self._ever_edited: bool = False
        self._edited_content: str | None = None
        self._edited_version_id: str | None = None

    @workflow.signal
    async def approval(self, payload: ApprovalSignal) -> None:
        """Clinician sign-off: resolves the gate wait-condition."""
        self._approval = payload

    @workflow.signal
    async def edit(self, payload: EditSignal) -> None:
        """Clinician edited the optimistically delivered draft (TASK-355 Slice 4b).

        Sets the per-pass latch + the sticky ``_ever_edited`` flag and captures the
        edited content + version. The optimistic assurance loop re-binds to the
        edited version and re-runs the assurance pass (Q3); the sticky flag also
        disables the silent regen-if-untouched path (Q1) from this point on. Only
        meaningful while the assurance loop is running (DRAFT_PENDING_SENSORS); a
        signal after assurance settles is recorded but has no further effect here.
        """
        self._edited = True
        self._ever_edited = True
        self._edited_content = payload.content
        self._edited_version_id = payload.context_item_version_id

    @workflow.query
    def phase(self) -> str:
        """Current loop phase (for ops/tests; does not affect determinism)."""
        return self._phase

    async def _report_progress(self, inp: HarnessDocWorkflowInput, stage: str) -> None:
        """Emit one stage event to the live UI feed (TASK-345). Best-effort only.

        The activity swallows its own errors; this wrapper additionally absorbs
        timeouts/cancellation so a dead progress pipeline can NEVER fail the loop.
        """
        # Replay-compat gate (TASK-348 / CRIT-1): executions whose history was
        # recorded before TASK-345 carry no report_progress events. patched()
        # keeps them deterministic on replay (returns False -> emit nothing for
        # the rest of that run) while new executions record the marker and emit.
        # Collapse to workflow.deprecate_patch() once no pre-TASK-345 runs can
        # still be in flight. Verified by test_replay_compat.py.
        if not workflow.patched("task-345-harness-progress"):
            return
        if stage == HARNESS_PROGRESS_TERMINAL_STAGE:
            label, ordinal = HARNESS_PROGRESS_TERMINAL_LABEL, _PROGRESS_TOTAL
        elif stage == HARNESS_PROGRESS_FAILED_STAGE:
            label, ordinal = HARNESS_PROGRESS_FAILED_LABEL, _PROGRESS_TOTAL
        else:
            label, ordinal = _PROGRESS_LABELS[stage], _PROGRESS_ORDINALS[stage]
        try:
            await workflow.execute_activity(
                report_progress,
                ReportProgressInput(
                    consultation_id=inp.consultation_id,
                    tenant_id=inp.tenant_id,
                    job_id=inp.job_id,
                    stage=stage,
                    label=label,
                    ordinal=ordinal,
                    total=_PROGRESS_TOTAL,
                ),
                start_to_close_timeout=_PROGRESS_TIMEOUT,
                # MAJ-9 (TASK-348): bound queue wait + execution. start_to_close
                # alone leaves a saturated task queue free to stall each stage
                # transition for the workflow-task default; schedule-to-close
                # caps the whole emission (pickup + run) at the same 10s budget.
                schedule_to_close_timeout=_PROGRESS_TIMEOUT,
                retry_policy=_PROGRESS_RETRY,
            )
        except ActivityError:
            pass  # progress is non-clinical — never block or degrade the loop

    @workflow.run
    async def run(self, inp: HarnessDocWorkflowInput) -> HarnessDocWorkflowResult:
        try:
            return await self._run(inp)
        except Exception:
            # MAJ-1 (TASK-348): without a terminal event the feed freezes on the
            # last `active` stage (and the Redis snapshot lies for its full TTL)
            # whenever the loop fails. Emit a best-effort `failed` terminal so
            # the API closes the SSE stream, then ALWAYS re-raise — an SMR
            # failure must still fail the workflow, never be swallowed.
            # `except Exception` deliberately excludes cancellation
            # (asyncio.CancelledError is a BaseException): a cancelled run is
            # not a failed run. The emission goes through _report_progress
            # (patch-gated for pre-TASK-345 histories) AND its own
            # workflow.patched gate so TASK-345-era in-flight executions that
            # fail after this deploys stay deterministic on replay.
            if workflow.patched("task-348-failure-terminal"):
                await self._report_progress(inp, HARNESS_PROGRESS_FAILED_STAGE)
            raise

    async def _run(self, inp: HarnessDocWorkflowInput) -> HarnessDocWorkflowResult:
        # 0) Live policy injection (Phase 6). Read ONCE at the start in an activity
        # (I/O stays out of the deterministic body) and thread the result through.
        # A failed fetch degrades to the code defaults — never crash the loop, and
        # this is NOT a clinical degradation (it does not set reduced_assurance).
        self._phase = "POLICY"
        # Progress stage 1 covers the policy fetch + transcript NER that follow.
        await self._report_progress(inp, "extracting_information")
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
                # TASK-355 Phase D (R-7): the optimistic kill-switch is NOT a policy knob.
                # Carry the value snapshotted at workflow start (document:start -> input)
                # over the policy merge so it actually governs ``use_optimistic`` below.
                # Read from the deterministic workflow input (never env) ⇒ replay-safe, and
                # it adds no new command, so no ``workflow.patched()`` marker is required.
                optimistic_delivery_enabled=inp.gate.optimistic_delivery_enabled,
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
        # Progress stage 2 covers institutional retrieval + prompt assembly.
        await self._report_progress(inp, "assembling_context")
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
        # TASK-355 Phase D (Slice 4a) — optimistic two-phase delivery is gated by BOTH
        # the snapshotted feature flag (behaviour key) AND a durable patch marker
        # (replay key). The flag is the FIRST operand, so when it is OFF (default)
        # ``workflow.patched()`` is NEVER called: no marker is recorded and the run's
        # history is byte-identical to the legacy single-phase path (proven replay-safe
        # by test_replay_compat). Flag value comes from the snapshotted gate config, so
        # the branch is deterministic across replay. When ON, the inferential pass moves
        # AFTER an early draft delivery and runs as assurance-only (a delivered draft is
        # never silently regenerated in 4a — the regen-if-untouched dynamics are 4b).
        use_optimistic = gate.optimistic_delivery_enabled and workflow.patched(
            "task-355-optimistic-delivery"
        )
        regens_used = 0
        verdict = None
        generated = None
        assembled = None
        sensors = None
        comp_verdict = None
        guardrail_decisions: dict[str, Any] = {}
        rag_triad_score: float | None = None
        while True:
            # Progress stage 3 — re-emitted on every regen iteration (the fold on
            # the API side re-activates it and bumps the attempt counter).
            await self._report_progress(inp, "drafting_note")
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

            # Progress stage 4 covers the computational + inferential sensor pass.
            await self._report_progress(inp, "running_safety_sensors")
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

            # TASK-355 Phase D (Slice 4a) — optimistic delivery split. The computational
            # verdict has settled, so the draft is ready to DELIVER. Break out and persist
            # it early (below); the costly inferential pass then runs as ASSURANCE after
            # delivery (it does not feed the regen loop — assurance-only in 4a). The legacy
            # path (flag off) falls through and keeps the inferential pass INSIDE the loop.
            if use_optimistic:
                break

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
                    heartbeat_timeout=_INFERENTIAL_HEARTBEAT_TIMEOUT,
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

        # 3) Persist the draft + record the gate verdict. Two shapes, by flag:
        if use_optimistic:
            # TASK-355 Phase D — OPTIMISTIC two-phase delivery. Two nested helpers keep
            # the loop body readable AND keep the replay-critical computational/legacy
            # loop above DELIBERATELY UNTOUCHED (Slice-4b re-delivery + regen mirror it
            # here rather than re-entering it). Both close over the pre-loop locals.
            async def _deliver_early(gen_, sens_, asm_, reduced_):
                """Early persist (phase=EARLY): readable draft, verdict + RAG-triad withheld.

                Used for the first delivery AND each Slice-4b regen re-delivery. NOTE
                (apps/api Slice 5): a re-delivery must UPSERT the existing
                DRAFT_PENDING_SENSORS draft (update content + computational scores),
                not create a second draft.
                """
                return await workflow.execute_activity(
                    persist_draft,
                    PersistDraftInput(
                        consultation_id=inp.consultation_id,
                        tenant_id=inp.tenant_id,
                        user_id=inp.user_id,
                        job_id=inp.job_id,
                        content=gen_.content,
                        model_name=gen_.model or None,
                        sensor_scores=sens_.scores,
                        citations_map=sens_.citations_map,
                        guardrail_decisions=None,
                        reduced_assurance=reduced_,
                        entity_faithfulness_score=sens_.scores.get("entity_faithfulness"),
                        coverage_score=sens_.scores.get("coverage_omission"),
                        rag_triad_score=None,
                        prompt_template_id=asm_.prompt_template_id,
                        prompt_version=asm_.prompt_version,
                        dna_style_id=inp.dna_style_id,
                        gate_decision=None,
                        is_auto_generated=True,
                        phase=HARNESS_DRAFT_PHASE_EARLY,
                    ),
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_API_RETRY,
                )

            async def _regen_compute():
                """One regen pass (assemble → generate → extract → run_sensors).

                Mirrors the computational loop body so the Slice-4b regen-if-untouched
                path can re-generate WITHOUT re-entering (and risking the replay history
                of) the legacy loop. Returns ``(assembled, generated, sensors, degraded)``.
                """
                asm_ = await workflow.execute_activity(
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
                uprompt = asm_.user_prompt
                if retrieved.prompt_block:
                    uprompt = f"{uprompt}\n\n{retrieved.prompt_block}"
                gen_ = await workflow.execute_activity(
                    generate,
                    GenerateInput(
                        prompt=uprompt,
                        system_prompt=asm_.system_prompt,
                        response_format=asm_.response_format,
                        hyperparameters=asm_.hyperparameters,
                        provider=smr_provider,
                        model=smr_model,
                    ),
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_GENERATE_RETRY,
                )
                note_ents: list[NEREntity] = []
                deg_ = False
                try:
                    ne_ = await workflow.execute_activity(
                        extract_entities,
                        ExtractEntitiesInput(
                            text=gen_.content, language=inp.conversation_language
                        ),
                        start_to_close_timeout=_ACTIVITY_TIMEOUT,
                        retry_policy=_NLP_RETRY,
                    )
                    note_ents = ne_.entities
                except ActivityError:
                    deg_ = True
                sens_ = await workflow.execute_activity(
                    run_sensors,
                    RunSensorsInput(
                        note_text=gen_.content,
                        transcript_text=inp.transcript_text,
                        note_entities=note_ents,
                        transcript_entities=transcript_entities,
                        response_format=asm_.response_format,
                        transcript_context_item_id=inp.context_item_id,
                        retrieved_chunk_ids=retrieved_chunk_ids,
                        thresholds=sensor_thresholds,
                    ),
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_API_RETRY,
                )
                return asm_, gen_, sens_, deg_

            # (a) DELIVER the readable draft NOW: computational scores only, status
            #     DRAFT_PENDING_SENSORS, verdict + RAG-triad withheld, GENERATE-only
            #     audit (the apps/api early path). Perceived latency stops at the
            #     terminal progress just below — the clinician can start reading.
            self._phase = "PERSIST"
            await self._report_progress(inp, "finalizing_draft")
            draft = await _deliver_early(generated, sensors, assembled, reduced_assurance)
            # The draft is readable NOW — fold the feed to completed + close the SSE.
            await self._report_progress(inp, HARNESS_PROGRESS_TERMINAL_STAGE)

            # (b) ASSURANCE loop (Slice 4b, patch-gated). The costly inferential pass
            #     runs AFTER delivery; a degraded/failed backend degrades to reduced
            #     assurance (never auto-PASS). TWO signal-driven dynamics, gated behind
            #     a SECOND patch marker so a 4a-era optimistic history (optimistic marker
            #     only) still replays as the single assurance pass:
            #       Q3 edit  — a clinician `edit` during the pass re-binds assurance to
            #                  the edited version and re-runs it (assurance only; the
            #                  clinician owns the content, so it is NOT re-generated).
            #       Q1 regen — an UNTOUCHED draft with a REGEN-fixable verdict is
            #                  silently regenerated + re-delivered ONCE (budget
            #                  permitting); once edited, regens_remaining=0 escalates the
            #                  REGEN to a surfaced FLAG instead of swapping the note.
            signals_enabled = workflow.patched("task-355-assurance-signals")
            assurance_content = generated.content
            assurance_version_id: str | None = None
            while True:
                # Consume a pending edit (arrived before/between passes): re-bind the
                # assurance target to the edited version, then clear the per-pass latch.
                if signals_enabled and self._edited:
                    assurance_content = self._edited_content or assurance_content
                    assurance_version_id = self._edited_version_id
                    self._edited = False
                self._phase = "INFER"
                inferential = None
                try:
                    inferential = await workflow.execute_activity(
                        run_inferential_sensors,
                        RunInferentialSensorsInput(
                            note_text=assurance_content,
                            transcript_text=inp.transcript_text,
                            citations_map=sensors.citations_map,
                            knowledge_chunks=knowledge_chunks,
                            groundedness_threshold=groundedness_threshold,
                            safety_enabled=safety_enabled,
                            # TASK-355 Phase D Slice 5d (Q5) — the optimistic ASSURANCE
                            # pass streams each claim verdict live to apps/api as it
                            # resolves (data-only activity-input fields; the activity
                            # publishes best-effort, never on replay). The legacy pass
                            # (line ~468) leaves these unset and stays silent.
                            live_assurance=True,
                            consultation_id=inp.consultation_id,
                            tenant_id=inp.tenant_id,
                            job_id=inp.job_id,
                        ),
                        start_to_close_timeout=_INFERENTIAL_TIMEOUT,
                        heartbeat_timeout=_INFERENTIAL_HEARTBEAT_TIMEOUT,
                        retry_policy=_INFERENTIAL_RETRY,
                    )
                except ActivityError:
                    reduced_assurance = True

                # Q3: an edit landed DURING this pass — the verdict is stale. Loop to
                # re-bind (top) and re-run assurance on the edited version.
                if signals_enabled and self._edited:
                    continue

                inferential_results: list[SensorResult] = []
                if inferential is not None:
                    guardrail_decisions = inferential.guardrail_decisions
                    rag_triad_score = inferential.rag_triad_score
                    if inferential.degraded:
                        reduced_assurance = True
                    inferential_results = [r for r in inferential.results if not r.degraded]
                inferential_expected = [r.name for r in inferential_results]

                # Once edited, a REGEN-fixable issue must SURFACE as a FLAG (never swap
                # the clinician's note): regens_remaining=0 makes aggregate escalate it.
                regens_remaining = (
                    0
                    if (signals_enabled and self._ever_edited)
                    else gate.max_regen - regens_used
                )
                verdict = aggregate(
                    list(sensors.results) + inferential_results,
                    regens_remaining=regens_remaining,
                    degraded=degraded,
                    expected=list(COMPUTATIONAL_SENSOR_NAMES) + inferential_expected,
                )

                # Q1 regen-if-untouched: regenerate ONCE + re-deliver, then re-assure.
                # Disabled after any edit (the `not self._ever_edited` guard) — the
                # verdict above will already be a FLAG in that case.
                if (
                    signals_enabled
                    and verdict.decision == GateDecision.REGEN
                    and regens_used < gate.max_regen
                    and not self._ever_edited
                ):
                    regens_used += 1
                    assembled, generated, sensors, regen_degraded = await _regen_compute()
                    if regen_degraded:
                        degraded = True
                    draft = await _deliver_early(
                        generated, sensors, assembled, reduced_assurance
                    )
                    assurance_content = generated.content
                    continue
                break
            decision = str(verdict.decision)

            # (c) FINALIZE: backfill the early SummaryMeta with the verdict, flip
            #     DRAFT_PENDING_SENSORS -> PENDING_REVIEW, and record the deferred
            #     SENSOR_RUN (+ REDUCED_ASSURANCE) WORM. Idempotent on apps/api.
            #     ``context_item_version_id`` binds the verdict to a clinician-edited
            #     version when an edit re-bound assurance (Slice 4b); None otherwise.
            self._phase = "FINALIZE"
            await workflow.execute_activity(
                finalize_assurance,
                FinalizeAssuranceInput(
                    consultation_id=inp.consultation_id,
                    tenant_id=inp.tenant_id,
                    user_id=inp.user_id,
                    job_id=inp.job_id,
                    context_item_id=draft.context_item_id,
                    context_item_version_id=assurance_version_id,
                    sensor_scores=sensors.scores,
                    citations_map=sensors.citations_map,
                    guardrail_decisions=guardrail_decisions or None,
                    reduced_assurance=reduced_assurance,
                    rag_triad_score=rag_triad_score,
                    gate_decision=decision,
                    model_name=generated.model or None,
                    prompt_template_id=assembled.prompt_template_id,
                    prompt_version=assembled.prompt_version,
                ),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_API_RETRY,
            )
        else:
            decision = str(verdict.decision)

            # 3) Persist the draft -> PENDING_REVIEW (clinician confirm-before-commit).
            # guardrail_decisions + ragTriadScore land on SummaryMeta; reduced_assurance
            # drives the REDUCED_ASSURANCE WORM event on apps/api.
            self._phase = "PERSIST"
            # Progress stage 5 — the draft is being persisted (PENDING_REVIEW).
            await self._report_progress(inp, "finalizing_draft")
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

            # Terminal progress event: the draft exists — the feed folds to
            # all-completed and the SSE stream closes. The gate/sign-off wait below
            # is intentionally NOT part of the generation feed.
            await self._report_progress(inp, HARNESS_PROGRESS_TERMINAL_STAGE)

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
