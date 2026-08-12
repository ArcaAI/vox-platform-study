"""Temporal workflows.

Workflow code MUST be deterministic: no direct I/O, no wall-clock/random access,
no non-deterministic imports at module top-level. All side effects are delegated
to Activities. This mirrors the design constraint where the harness
loop body is a deterministic workflow and guides/generate/sensors are Activities.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from harness.services.api_client import AssembleResponse, DraftResponse
    from harness.services.sensor_runner import SensorRunOutput
    from harness.services.smr_client import SmrGenerationResult

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import (
    ActivityError,
    ChildWorkflowError,
    WorkflowAlreadyStartedError,
    is_cancelled_exception,
)

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
        apply_redaction,
        assemble_prompt,
        call_mcp_tool,
        document_extract_text,
        emit_loop_event,
        escalate_gate,
        extract_entities,
        fetch_loop_config,
        fetch_policy,
        finalize_assurance,
        generate,
        livedoc_start,
        livedoc_stop,
        nlp_extract_entities,
        persist_draft,
        persist_entities,
        ping_activity,
        plan_reasoning,
        record_adjudication,
        record_gate_decision,
        report_progress,
        retract_draft,
        retrieve_context,
        run_inferential_sensors,
        run_sensors,
        run_specialist,
        vision_extract_text,
    )
    from harness.temporal.claim_check import ClaimCheckRef
    from harness.temporal.models import (
        DEFAULT_GROUNDEDNESS_THRESHOLD,
        HARNESS_DRAFT_PHASE_EARLY,
        HARNESS_PROGRESS_FAILED_LABEL,
        HARNESS_PROGRESS_FAILED_STAGE,
        HARNESS_PROGRESS_STAGES,
        HARNESS_PROGRESS_TERMINAL_LABEL,
        HARNESS_PROGRESS_TERMINAL_STAGE,
        LOOP_ACTION_CLIENT_EMIT,
        LOOP_ACTION_DOCUMENT_EXTRACT_TEXT,
        LOOP_ACTION_HARNESS_FINALIZE,
        LOOP_ACTION_LIVEDOC_START,
        LOOP_ACTION_LIVEDOC_STOP,
        LOOP_ACTION_NLP_EXTRACT_ENTITIES,
        LOOP_ACTION_VISION_EXTRACT_TEXT,
        LOOP_EVENT_ACTION_DISPATCHED,
        LOOP_EVENT_ACTION_SKIPPED,
        LOOP_EVENT_CONTEXT_DERIVED,
        LOOP_EVENT_PLAN_DECIDED,
        LOOP_EVENT_SPECIALIST_FAILED,
        LOOP_SKIP_BUDGET_EXHAUSTED,
        LOOP_SKIP_CYCLE_DETECTED,
        LOOP_SKIP_DEPTH_CAP,
        LOOP_SKIP_SPECIALIST_BUDGET,
        LOOP_SKIP_UNSUPPORTED_ACTION,
        PRIMARY_ONLY_OUTPUT_KINDS,
        ApplyRedactionInput,
        ApprovalSignal,
        AssembleInput,
        CallMcpToolInput,
        CancelLoopSignal,
        ConsultationEndingSignal,
        ConsultationLoopConfig,
        ConsultationLoopState,
        ConsultationLoopWorkflowInput,
        ConsultationLoopWorkflowResult,
        ContextAddedSignal,
        DeriveContextInput,
        DeriveContextResult,
        EditSignal,
        EmitLoopEventInput,
        EscalateInput,
        ExtractEntitiesInput,
        FetchLoopConfigInput,
        FetchPolicyInput,
        FinalizeAssuranceInput,
        GenerateInput,
        HarnessDocWorkflowInput,
        HarnessDocWorkflowResult,
        HarnessGateConfig,
        HarnessPolicy,
        LiveDocControlInput,
        LoopFinalizeRequest,
        McpServerConfig,
        PersistDraftInput,
        PersistEntitiesInput,
        PlanDecision,
        PlanLoopInput,
        RecordAdjudicationInput,
        RecordGateInput,
        RegenFeedback,
        ReportProgressInput,
        RetractDraftInput,
        RetrieveContextInput,
        RetrievedContext,
        RunInferentialSensorsInput,
        RunSensorsInput,
        ScopedContextItem,
        SpecialistAnalysisInput,
        SpecialistResult,
        SpecialistWorkflowInput,
        TrajectoryContext,
        adjudicate,
    )
    from harness.temporal.prompt_cache import build_regen_feedback

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
# The activity heartbeats (~every 15s) for the whole pass, so a
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
# Progress feed: fire-and-forget — one attempt, tiny budget. The
# activity already swallows its own errors; the workflow-side try/except is the
# second belt for timeouts/cancellation.
_PROGRESS_TIMEOUT = timedelta(seconds=10)
_PROGRESS_RETRY = RetryPolicy(maximum_attempts=1)
# (key, label) -> 1-based ordinal lookup for the emission helper.
_PROGRESS_ORDINALS = {key: i + 1 for i, (key, _label) in enumerate(HARNESS_PROGRESS_STAGES)}
_PROGRESS_LABELS = dict(HARNESS_PROGRESS_STAGES)
_PROGRESS_TOTAL = len(HARNESS_PROGRESS_STAGES)
# stride between per-activity trajectory-seq bases. > the max steps
# any single activity emits (``generate`` emits 2: LLM_CALL + THINKING), so bases never
# collide while the global sequence stays monotonic.
_SEQ_STRIDE = 16

# MCP external-tools. Bounded budget for the READ-ONLY tool call;
# the activity does its own client-side retry + degrades (never raises) on a server
# error, so the Temporal retry only covers infra blips before the workflow degrades.
_MCP_TIMEOUT = timedelta(seconds=30)
_MCP_RETRY = RetryPolicy(maximum_attempts=1)
# The first MCP integration: FHIR terminology validation of the extracted entity codes.
MCP_TERMINOLOGY_TOOL = "validate_codes"


def _select_mcp_server(servers: list[McpServerConfig], tool: str) -> McpServerConfig | None:
    """First ENABLED server whose allowlist carries ``tool`` (deterministic, replay-safe).

    Pure selection over the policy-carried registry snapshot — no I/O, so it runs in
    the deterministic workflow body. Returns ``None`` when no server offers the tool
    (⇒ the MCP step is skipped entirely).
    """
    for server in servers:
        if server.enabled and tool in (server.tool_allowlist or []):
            return server
    return None


def _terminology_args(entities: list[NEREntity]) -> dict[str, list[str]]:
    """Build the READ-ONLY terminology-validation args from the extracted entities.

    Sends the resolved ontology codes + the surface terms so a self-hosted FHIR
    terminology server can validate them. Deterministic (stable order from the
    entity list) — replay-safe.
    """
    codes: list[str] = []
    for e in entities:
        for code in (e.snomed_code, e.icd_code, e.rxnorm_code, e.loinc_code, e.umls_cui):
            if code:
                codes.append(code)
    return {"codes": codes, "terms": [e.text for e in entities]}


def _tokens_from_stats(stats: dict[str, Any] | None) -> int:
    """Total tokens reported by one generate call.

    PURE and deterministic — it only reads a value already recorded in the
    activity result, so folding it inside the workflow is replay-safe. An old
    history (or an engine that reports no usage) yields 0, which makes the budget
    check inert and preserves the pre-B4 command sequence exactly.
    """
    if not stats:
        return 0
    usage = stats.get("usage") if isinstance(stats.get("usage"), dict) else {}
    total = 0
    for key in ("prompt_tokens", "promptTokens", "input_tokens", "inputTokens"):
        value = stats.get(key, usage.get(key) if usage else None)
        if isinstance(value, (int, float)):
            total += int(value)
            break
    for key in ("completion_tokens", "completionTokens", "output_tokens", "outputTokens"):
        value = stats.get(key, usage.get(key) if usage else None)
        if isinstance(value, (int, float)):
            total += int(value)
            break
    return total


def _budget_exhausted(per_run_budget: int, tokens_used: int) -> bool:
    """True when a per-run token budget is set AND spent.

    ``per_run_budget <= 0`` means UNBOUNDED — the shipped default, so this returns
    False and the regen loop behaves exactly as it did before B4.
    """
    return per_run_budget > 0 and tokens_used >= per_run_budget


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
        # workflow-owned, DETERMINISTIC trajectory sequence counter.
        # ``_next_seq`` allocates a monotonic base per activity (strided so an activity that
        # emits >1 step — ``generate`` → LLM_CALL + THINKING — offsets locally without
        # colliding with the next activity's base). Pure local-state mutation in the
        # deterministic body ⇒ adds NO workflow command (replay-safe, no ``patched()``
        # marker); the (non-deterministic) emission lives entirely in the activities.
        self._seq: int = 0
        # Clinician-edit signal state for the post-delivery assurance path of the
        # optimistic assurance loop. ``_edited`` is a per-pass latch (an edit
        # arrived; consumed at the loop top to re-bind + re-run). ``_ever_edited``
        # is sticky: once the clinician touches the delivered draft, the
        # regen-if-untouched path is permanently disabled (a REGEN-fixable verdict
        # surfaces as a FLAG instead of silently swapping the note). These never
        # affect the legacy path (no post-delivery assurance window there).
        self._edited: bool = False
        self._ever_edited: bool = False
        self._edited_content: str | None = None
        # OPTIONAL claim-check ref for an offloaded edited note (apps/api-facing
        # seam; None until a future caller sends the edit by ref). Threaded, with
        # ``_edited_content``, into the assurance pass's note_text/note_text_ref.
        self._edited_content_ref: ClaimCheckRef | None = None
        self._edited_version_id: str | None = None

    def _next_seq(self) -> int:
        """Allocate the next monotonic trajectory-seq BASE (strided; deterministic)."""
        seq = self._seq
        self._seq += _SEQ_STRIDE
        return seq

    def _traj(self, inp: HarnessDocWorkflowInput, *, is_regen: bool = False) -> TrajectoryContext:
        """Build the ADDITIVE trajectory context for one activity call (workflow-owned seq)."""
        return TrajectoryContext(
            tenant_id=inp.tenant_id,
            consultation_id=inp.consultation_id,
            correlation_id=inp.correlation_id,
            seq=self._next_seq(),
            is_regen=is_regen,
        )

    @workflow.signal
    async def approval(self, payload: ApprovalSignal) -> None:
        """Clinician sign-off: resolves the gate wait-condition."""
        self._approval = payload

    @workflow.signal
    async def edit(self, payload: EditSignal) -> None:
        """Clinician edited the optimistically delivered draft.

        Sets the per-pass latch + the sticky ``_ever_edited`` flag and captures the
        edited content + version. The optimistic assurance loop re-binds to the
        edited version and re-runs the assurance pass; the sticky flag also
        disables the silent regen-if-untouched path from this point on. Only
        meaningful while the assurance loop is running (DRAFT_PENDING_SENSORS); a
        signal after assurance settles is recorded but has no further effect here.
        """
        self._edited = True
        self._ever_edited = True
        self._edited_content = payload.content
        self._edited_content_ref = payload.content_ref
        self._edited_version_id = payload.context_item_version_id

    @workflow.query
    def phase(self) -> str:
        """Current loop phase (for ops/tests; does not affect determinism)."""
        return self._phase

    async def _report_progress(self, inp: HarnessDocWorkflowInput, stage: str) -> None:
        """Emit one stage event to the live UI feed. Best-effort only.

        The activity swallows its own errors; this wrapper additionally absorbs
        timeouts/cancellation so a dead progress pipeline can NEVER fail the loop.
        """
        # Replay-compat gate: executions whose history was recorded before the
        # progress-feed feature shipped carry no report_progress events. patched()
        # keeps them deterministic on replay (returns False -> emit nothing for
        # the rest of that run) while new executions record the marker and emit.
        # Collapse to workflow.deprecate_patch() once no pre-feature runs can
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
                # Bound queue wait + execution. start_to_close
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
            # Without a terminal event the feed freezes on the
            # last `active` stage (and the Redis snapshot lies for its full TTL)
            # whenever the loop fails. Emit a best-effort `failed` terminal so
            # the API closes the SSE stream, then ALWAYS re-raise — an SMR
            # failure must still fail the workflow, never be swallowed.
            # `except Exception` deliberately excludes cancellation
            # (asyncio.CancelledError is a BaseException): a cancelled run is
            # not a failed run. The emission goes through _report_progress
            # (patch-gated for histories recorded before the progress-feed
            # feature shipped) AND its own workflow.patched gate so in-flight
            # executions from that era that fail after this deploys stay
            # deterministic on replay.
            if workflow.patched("task-348-failure-terminal"):
                await self._report_progress(inp, HARNESS_PROGRESS_FAILED_STAGE)
            raise

    async def _run(self, inp: HarnessDocWorkflowInput) -> HarnessDocWorkflowResult:
        # 0) Live policy injection. Read ONCE at the start in an activity
        # (I/O stays out of the deterministic body) and thread the result through.
        # A failed fetch degrades to the code defaults — never crash the loop. An
        # UNREACHABLE policy endpoint can silently RELAX a stricter tenant
        # policy, so a fetch FAILURE now flags reduced assurance (folded into
        # ``reduced_assurance`` at its init below). A successful "no custom policy" read
        # is NOT a degrade — only the ``except`` path is. Pure local state (no workflow
        # command) ⇒ replay-safe, no ``workflow.patched()`` marker.
        self._phase = "POLICY"
        # Progress stage 1 covers the policy fetch + transcript NER that follow.
        await self._report_progress(inp, "extracting_information")
        policy: HarnessPolicy | None = None
        policy_degraded = False
        try:
            policy = await workflow.execute_activity(
                fetch_policy,
                # TASK-550 — carry consultation_id so the activity can request the
                # policy WITH the department default agent's tenant-tier
                # harnessOverrides overlaid. Additive input field only (no new
                # command / branch), so this is replay-safe — the replay suite is
                # the gate. Default None on old inputs ⇒ tenant-only fetch.
                FetchPolicyInput(
                    tenant_id=inp.tenant_id,
                    consultation_id=inp.consultation_id,
                    trajectory=self._traj(inp),
                ),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_API_RETRY,
            )
        except ActivityError:
            policy = None
            policy_degraded = True

        # Effective loop knobs: the policy overrides the snapshotted gate budget and
        # supplies sensor thresholds, guard toggles, and model defaults; the input
        # (and code defaults) govern when there is no policy.
        if policy is not None:
            gate = HarnessGateConfig(
                max_regen=policy.max_regen,
                # Per-run token budget, governed by
                # `agentic.context.tokenBudget.perRun` and served on the effective
                # policy. Per-field fallthrough like the knobs below: None ⇒ keep the
                # input-snapshotted default (0 = unbounded), so an unset budget leaves
                # the loop byte-identical to before this budget feature.
                token_budget_per_run=(
                    policy.token_budget_per_run
                    if policy.token_budget_per_run is not None
                    else inp.gate.token_budget_per_run
                ),
                gate_sla_seconds=policy.gate_sla_seconds,
                gate_escalation_seconds=policy.gate_escalation_seconds,
                # The optimistic kill-switch is snapshotted at
                # workflow start (document:start -> input), and the effective-policy read
                # here makes it a policy-overridable knob: the effective policy value wins WHEN NON-NULL,
                # else the input-snapshotted default governs (per-field fallthrough, same
                # rationale as ``smr_provider``). Both are read from deterministic
                # workflow state (never env) ⇒ replay-safe; no new command / patch marker.
                optimistic_delivery_enabled=(
                    policy.optimistic_delivery_enabled
                    if policy.optimistic_delivery_enabled is not None
                    else inp.gate.optimistic_delivery_enabled
                ),
                # The gate/edit safety bounds are loop-safety knobs.
                # ``gate_max_escalations`` stays input-only; lets the policy
                # override ``max_edit_reruns`` when non-null (else the input default).
                gate_max_escalations=inp.gate.gate_max_escalations,
                max_edit_reruns=(
                    policy.max_edit_reruns
                    if policy.max_edit_reruns is not None
                    else inp.gate.max_edit_reruns
                ),
            )
            sensor_thresholds = policy.to_sensor_thresholds()
            groundedness_threshold = policy.groundedness_threshold
            safety_enabled = policy.safety_enabled
            # Snapshot the PHI egress policy alongside the other guard
            # toggles so the activity-side guard is deterministic across replay.
            phi_enabled = policy.phi_enabled
            phi_fail_closed = policy.phi_fail_closed
            # The workflow input wins over the policy default when it specifies a model.
            smr_provider = inp.smr_provider or policy.smr_provider
            smr_model = inp.smr_model or policy.smr_model
            # LLM-as-judge selection from the SYSTEM harness.judge policy,
            # snapshotted here so the inferential activity builds the judge
            # deterministically across replay. None ⇒ the activity fails closed (no
            # env-selection fallback).
            judge_provider = policy.judge_provider
            judge_model = policy.judge_model
            # activity-consumed agentic knobs threaded onto the
            # activity inputs below. None ⇒ the activity falls through to its env default
            # (per-field fallthrough); a non-null policy value is the override.
            ner_priors_enabled = policy.ner_priors_enabled
            retrieval_enabled = policy.retrieval_enabled
            atomic_fact_enabled = policy.atomic_fact_enabled
            # critique-informed regen. Default ON: only an explicit
            # policy `regenFeedbackEnabled=false` disables it (None ⇒ enabled).
            regen_feedback_enabled = policy.regen_feedback_enabled is not False
            # MCP external tools. NULL ⇒ OFF; only an explicit
            # `mcpToolsEnabled=true` arms the (patch-gated) tool path. The enabled
            # SYSTEM-shared registry rows come from the policy snapshot.
            mcp_tools_enabled = policy.mcp_tools_enabled is True
            mcp_servers = policy.mcp_servers
            mcp_tool_allowlist = policy.tool_allowlist
        else:
            gate = inp.gate
            sensor_thresholds = None
            groundedness_threshold = DEFAULT_GROUNDEDNESS_THRESHOLD
            safety_enabled = True
            # No policy ⇒ the fail-closed code defaults govern the guard.
            phi_enabled = True
            phi_fail_closed = True
            smr_provider = inp.smr_provider
            smr_model = inp.smr_model
            # no policy ⇒ no SYSTEM judge selection ⇒ the inferential pass
            # fails closed (never falls back to an env-selected judge).
            judge_provider = None
            judge_model = None
            # no policy ⇒ no override; activities use their env defaults.
            ner_priors_enabled = None
            retrieval_enabled = None
            atomic_fact_enabled = None
            # no policy ⇒ critique-informed regen defaults ON.
            regen_feedback_enabled = True
            # no policy ⇒ MCP tools OFF (fail-safe default).
            mcp_tools_enabled = False
            mcp_servers = []
            mcp_tool_allowlist = None

        # 1) Transcript NER. NLP down -> degrade (force human review), don't crash.
        # NER-priors reuse: seed the transcript pass with
        # ``reuse_priors`` + the ids so the (non-deterministic) activity MAY reuse
        # already-persisted CODED NamedEntity rows instead of re-extracting
        # cold — killing the redundant second NER pass. This is a DATA-ONLY activity
        # input (the reuse/flag/code logic + apps/api read all live in the activity), so
        # it adds no new workflow command and needs no ``workflow.patched()``: an old
        # replay history schedules ``extract_entities`` exactly as before, and its
        # recorded result deserializes ``reused=False`` (cold-path semantics). The
        # activity falls back to the cold extraction when the flag is off / priors are
        # absent / none carry a code, so this is inert until coded entities are actually
        # persisted elsewhere.
        self._phase = "EXTRACT"
        degraded = False
        priors_reused = False
        transcript_entities: list[NEREntity] = []
        try:
            extracted = await workflow.execute_activity(
                extract_entities,
                ExtractEntitiesInput(
                    text=inp.transcript_text,
                    # thread the (future) transcript ref; the activity resolves
                    # inline-or-ref. None today ⇒ inline path, byte-identical.
                    text_ref=inp.transcript_ref,
                    language=inp.conversation_language,
                    reuse_priors=True,
                    # policy NER-priors override (None ⇒ env default).
                    ner_priors_enabled=ner_priors_enabled,
                    consultation_id=inp.consultation_id,
                    tenant_id=inp.tenant_id,
                    trajectory=self._traj(inp),
                ),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_NLP_RETRY,
            )
            transcript_entities = extracted.entities
            priors_reused = extracted.reused
        except ActivityError:
            degraded = True

        # Persist the freshly-extracted transcript entities. When they were REUSED from
        # already-persisted coded priors, the rows already exist — skip the
        # redundant re-persist. Data-driven skip (``priors_reused`` reconstructs from the
        # recorded activity result: False for every history predating priors-reuse) ⇒ replay-safe,
        # no ``workflow.patched()``; mirrors the existing ``if transcript_entities:``
        # data-driven guard right beside it.
        #
        # The activity call itself (and its retry policy) is unchanged on the success
        # path, so the scheduled-command sequence is byte-identical to before this
        # try/except was added — no ``workflow.patched()`` era needed here. On retry
        # exhaustion this is a *priors* write, not the note itself: degrade-to-safe
        # (log + continue without persisted NER priors) rather than failing the whole
        # workflow, consistent with every other best-effort activity in this loop.
        if transcript_entities and not priors_reused:
            try:
                await workflow.execute_activity(
                    persist_entities,
                    PersistEntitiesInput(
                        consultation_id=inp.consultation_id,
                        tenant_id=inp.tenant_id,
                        context_item_id=inp.context_item_id,
                        entities=transcript_entities,
                        user_id=inp.user_id,
                        trajectory=self._traj(inp),
                    ),
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_API_RETRY,
                )
            except ActivityError:
                workflow.logger.warning(
                    "harness.persist_entities_exhausted",
                    extra={
                        "consultation_id": inp.consultation_id,
                        "tenant_id": inp.tenant_id,
                    },
                )

        # 1a) MCP terminology validation.
        # OPT-IN per loop: gated on the effective ``mcpToolsEnabled`` policy knob AND a
        # ``workflow.patched()`` marker, because adding the ``call_mcp_tool`` command is a
        # command-sequence change. The ``and`` short-circuit means a default-OFF run NEVER
        # calls ``workflow.patched()`` — so no marker is recorded and the recorded command
        # sequence is byte-identical to pre-516 history (every existing replay fixture stays
        # green). READ-ONLY: the FHIR terminology server validates the extracted entity
        # codes; the call is best-effort — a server error / allowlist-or-PHI block degrades
        # the run to reduced assurance (never crashes the loop).
        mcp_degraded = False
        if mcp_tools_enabled and transcript_entities and workflow.patched("task-516-mcp-tools"):
            mcp_server = _select_mcp_server(mcp_servers, MCP_TERMINOLOGY_TOOL)
            if mcp_server is not None:
                try:
                    mcp_result = await workflow.execute_activity(
                        call_mcp_tool,
                        CallMcpToolInput(
                            server=mcp_server,
                            tool=MCP_TERMINOLOGY_TOOL,
                            args=_terminology_args(transcript_entities),
                            policy_tool_allowlist=mcp_tool_allowlist,
                            # Snapshotted PHI egress policy — the args are screened
                            # fail-closed inside the activity when the server is external.
                            phi_enabled=phi_enabled,
                            phi_fail_closed=phi_fail_closed,
                            trajectory=self._traj(inp),
                        ),
                        start_to_close_timeout=_MCP_TIMEOUT,
                        retry_policy=_MCP_RETRY,
                    )
                    mcp_degraded = mcp_result.degraded
                except ActivityError:
                    # Allowlist / PHI block (non-retryable raise) or infra failure — the
                    # tool call is best-effort, so degrade rather than crash the loop.
                    mcp_degraded = True

        # 1b) Institutional RAG (flag-gated). JIT hybrid retrieval is
        # entity-triggered and stable across regens, so it runs ONCE here (before the
        # loop) and the prompt is augmented with the cited chunks each iteration. A
        # degraded retrieval (backend down) yields an empty context and flags reduced
        # assurance; it never raises into the loop.
        self._phase = "RETRIEVE"
        # Progress stage 2 covers institutional retrieval + prompt assembly.
        await self._report_progress(inp, "assembling_context")
        # Seed reduced assurance from the policy-fetch degrade (a relaxed stricter
        # policy is an assurance degrade); retrieval/inferential degrades OR it in below.
        # a degraded MCP terminology validation also reduces assurance.
        reduced_assurance = policy_degraded or mcp_degraded
        try:
            retrieved = await workflow.execute_activity(
                retrieve_context,
                RetrieveContextInput(
                    tenant_id=inp.tenant_id,
                    entities=transcript_entities,
                    # policy retrieval override (None ⇒ env default).
                    retrieval_enabled=retrieval_enabled,
                    trajectory=self._traj(inp),
                ),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_RETRIEVAL_RETRY,
            )
        except ActivityError:
            retrieved = RetrievedContext(degraded=True)
        if retrieved.degraded:
            reduced_assurance = True
        retrieved_chunk_ids = [c.chunk_id for c in retrieved.chunks]
        knowledge_chunks = {c.chunk_id: c.text for c in retrieved.chunks}
        # per-chunk claim-check refs for any offloaded chunk texts; the
        # inferential activity merges these with ``knowledge_chunks`` (inline "" for the
        # offloaded ones). Empty ⇒ the pure-inline path (retrieval off / below threshold).
        knowledge_chunks_ref = {
            c.chunk_id: c.text_ref for c in retrieved.chunks if c.text_ref is not None
        }

        # 2) Bounded regen loop. The five computational sensors run every iteration
        # (cheap); once they settle, the costly inferential pass (groundedness +
        # safety) runs ONCE and is folded into the verdict — groundedness can consume
        # one remaining regen, safety forces a FLAG (unsafe content is never
        # auto-regenerated). A degraded/failed inferential backend degrades to reduced
        # assurance: the gate proceeds on the computational verdict (never auto-PASS).
        self._phase = "GENERATE"
        # Optimistic two-phase delivery is gated by BOTH
        # the snapshotted feature flag (behaviour key) AND a durable patch marker
        # (replay key). The flag is the FIRST operand, so when it is OFF (default)
        # ``workflow.patched()`` is NEVER called: no marker is recorded and the run's
        # history is byte-identical to the legacy single-phase path (proven replay-safe
        # by test_replay_compat). Flag value comes from the snapshotted gate config, so
        # the branch is deterministic across replay. When ON, the inferential pass moves
        # AFTER an early draft delivery and runs as assurance-only (a delivered draft is
        # never silently regenerated in the early-delivery path — the regen-if-untouched
        # dynamics live in the post-delivery assurance path below).
        use_optimistic = gate.optimistic_delivery_enabled and workflow.patched(
            "task-355-optimistic-delivery"
        )
        regens_used = 0
        # Running token spend for this run, folded from RECORDED
        # ACTIVITY OUTPUTS (`generated.stats`). Deriving it this way is what keeps
        # the budget stop replay-safe: it adds no command, reads no clock/env, and
        # an old history simply yields no stats -> zero spend -> byte-identical
        # behaviour. Deriving it from a new activity or workflow.now() would require
        # a new patch marker and a fresh replay fixture.
        tokens_used = 0
        budget_stopped = False
        verdict = None
        generated = None
        assembled = None
        sensors = None
        comp_verdict = None
        # the prior iteration's critique, threaded into the next regen's
        # generate call (None on the first iteration ⇒ byte-identical prompt).
        regen_feedback: RegenFeedback | None = None
        guardrail_decisions: dict[str, Any] = {}
        rag_triad_score: float | None = None
        # Workflow-threaded, data-only per-claim verdict cache (L2). Carried
        # from one inferential pass's OUTPUT into the next pass's INPUT so a regen re-judges only
        # changed claims (unchanged claims reuse the byte-identical cached verdict). DATA
        # flow only — adds no new command, needs no ``workflow.patched()``; reconstructed
        # deterministically from recorded activity outputs on replay (old histories ⇒ {}).
        verdict_cache: dict[str, bool] = {}
        while True:
            # Progress stage 3 — re-emitted on every regen iteration (the fold on
            # the API side re-activates it and bumps the attempt counter).
            await self._report_progress(inp, "drafting_note")
            # F-13 — assemble ONCE per pre-delivery loop. Every field of
            # ``AssembleInput`` is run-constant, and the activity is a pure read of
            # state this loop does not touch: the transcript is written before the
            # run, ``persist_entities`` ran ONCE above the loop, the clinician
            # notes/attachments/highlights and the live-SOAP warm-start snapshot are
            # written elsewhere, and the regen critique is appended LATER — inside
            # ``generate`` (``prompt_cache.assemble_generation_prompt``), never here.
            # So a repeat call re-fetched byte-identical bytes; same reasoning as the
            # retrieval pass above, which already runs once.
            #
            # Skipping a scheduled activity REMOVES a command, so the skip is gated on
            # ``workflow.patched()``. The ``assembled is None`` operand comes FIRST, so
            # the FIRST iteration never calls ``workflow.patched`` — a single-iteration
            # run (the overwhelming majority) records NO marker and its history stays
            # byte-identical to the legacy one, and an old multi-iteration history
            # replays with ``patched`` False ⇒ the legacy per-iteration call. The
            # ``task-516-mcp-tools`` / ``task-551-redaction`` conditional-patch
            # precedent.
            #
            # The reuse stops at the delivery boundary on purpose: the post-delivery
            # regen path (``_regen_compute``) runs after ``persist_draft``, whose
            # apps/api-side handling can persist further ``NamedEntity`` rows for the
            # delivered note — a genuinely different assemble output — so it keeps its
            # own call.
            if assembled is None or not workflow.patched("task-553-assemble-reuse"):
                assembled = await workflow.execute_activity(
                    assemble_prompt,
                    AssembleInput(
                        consultation_id=inp.consultation_id,
                        tenant_id=inp.tenant_id,
                        user_id=inp.user_id,
                        template=inp.template,
                        dna_style_id=inp.dna_style_id,
                        conversation_language=inp.conversation_language,
                        trajectory=self._traj(inp),
                    ),
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_API_RETRY,
                )
            # the retrieved Knowledge Context (StrictCitations) block + the
            # (possibly offloaded) prompt refs are threaded to ``generate``, which resolves
            # the prompt inline-or-ref and folds in the block. The workflow no longer
            # concatenates the blob, so history holds only the small refs.
            generated = await workflow.execute_activity(
                generate,
                GenerateInput(
                    prompt=assembled.user_prompt,
                    prompt_ref=assembled.user_prompt_ref,
                    system_prompt=assembled.system_prompt,
                    system_prompt_ref=assembled.system_prompt_ref,
                    prompt_block=retrieved.prompt_block,
                    response_format=assembled.response_format,
                    hyperparameters=assembled.hyperparameters,
                    provider=smr_provider,
                    model=smr_model,
                    phi_enabled=phi_enabled,
                    phi_fail_closed=phi_fail_closed,
                    # critique from the prior iteration (None on the
                    # first pass ⇒ byte-identical prompt, replay-safe).
                    regen_feedback=regen_feedback,
                    # PHI-safe segment refs from assemble (empty ⇒
                    # no StrictCitations block, byte-identical prompt).
                    segment_citations=list(assembled.segment_citations),
                    trajectory=self._traj(inp, is_regen=regens_used > 0),
                ),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_GENERATE_RETRY,
            )

            note_entities: list[NEREntity] = []
            try:
                note_extracted = await workflow.execute_activity(
                    extract_entities,
                    ExtractEntitiesInput(
                        text=generated.content,
                        # thread the offloaded-note ref (None ⇒ inline note).
                        text_ref=generated.content_ref,
                        language=inp.conversation_language,
                        trajectory=self._traj(inp),
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
                    # thread the offloaded note + (future) transcript refs.
                    note_text_ref=generated.content_ref,
                    transcript_text=inp.transcript_text,
                    transcript_text_ref=inp.transcript_ref,
                    note_entities=note_entities,
                    transcript_entities=transcript_entities,
                    response_format=assembled.response_format,
                    transcript_context_item_id=inp.context_item_id,
                    retrieved_chunk_ids=retrieved_chunk_ids,
                    # PHI-safe segment ids from assemble (empty ⇒ no
                    # marker-credit path — byte-identical to the pre-existing degrade).
                    allowed_segment_ids=[s.id for s in assembled.segment_citations],
                    thresholds=sensor_thresholds,
                    trajectory=self._traj(inp),
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
            # Fold this iteration's spend before deciding whether to regen again.
            tokens_used += _tokens_from_stats(generated.stats)
            budget_stopped = _budget_exhausted(gate.token_budget_per_run, tokens_used)

            if (
                comp_verdict.decision == GateDecision.REGEN
                and regens_used < gate.max_regen
                and not budget_stopped
            ):
                # capture the failed computational sensors as the next
                # iteration's corrective critique (gated on regenFeedbackEnabled).
                regen_feedback = build_regen_feedback(
                    sensors.results, enabled=regen_feedback_enabled
                )
                regens_used += 1
                continue

            # Optimistic delivery split. The computational
            # verdict has settled, so the draft is ready to DELIVER. Break out and persist
            # it early (below); the costly inferential pass then runs as ASSURANCE after
            # delivery (it does not feed the regen loop — assurance-only in this early-delivery
            # path). The legacy path (flag off) falls through and keeps the inferential pass
            # INSIDE the loop.
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
                        # thread the offloaded note + transcript + chunk refs.
                        note_text_ref=generated.content_ref,
                        transcript_text=inp.transcript_text,
                        transcript_text_ref=inp.transcript_ref,
                        citations_map=sensors.citations_map,
                        knowledge_chunks=knowledge_chunks,
                        knowledge_chunks_ref=knowledge_chunks_ref,
                        groundedness_threshold=groundedness_threshold,
                        safety_enabled=safety_enabled,
                        # DB-driven judge selection (harness.judge); None ⇒ the
                        # activity fails closed (no env-selection fallback).
                        judge_provider=judge_provider,
                        judge_model=judge_model,
                        # policy atomic-fact override (None ⇒ env default).
                        atomic_fact_enabled=atomic_fact_enabled,
                        phi_enabled=phi_enabled,
                        phi_fail_closed=phi_fail_closed,
                        # Carry the prior passes' verdicts so unchanged
                        # claims reuse the cache (data-only; no new command / patch marker).
                        prior_verdicts=verdict_cache,
                        trajectory=self._traj(inp),
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
                # Thread this pass's populated verdict cache into the next.
                verdict_cache = inferential.verdict_cache
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
            if (
                verdict.decision == GateDecision.REGEN
                and regens_used < gate.max_regen
                and not budget_stopped
            ):
                # critique from the full (computational + inferential)
                # sensor pass for the next regen iteration.
                regen_feedback = build_regen_feedback(
                    list(sensors.results) + inferential_results,
                    enabled=regen_feedback_enabled,
                )
                regens_used += 1
                continue
            break

        # 2b) DNA redaction/rewrite (TASK-551) — a SEPARATE, auditable transform that
        #     runs AFTER the computational loop settles and BEFORE persist/delivery, so
        #     the persisted/delivered note is the REDACTED one and the (re-run) cheap
        #     sensors validate the FINAL text. Conditional-patch: an EMPTY ``redaction_rules``
        #     list (the default, and every legacy start payload) short-circuits BEFORE
        #     ``workflow.patched()`` — no marker, no command — so old histories replay
        #     byte-identically (the ``task-516-mcp-tools`` short-circuit precedent). When
        #     armed, the note is transformed, the cheap computational sensors re-run on the
        #     transformed text, and a fail-closed transform forces a FLAG (a note the doctor
        #     expected redacted must never slip through silently).
        redaction_failed_closed = False
        # DNA redaction AUDIT marker (TASK-551) threaded to persist so apps/api records
        # it on SummaryMeta. None on every pre-audit-era history (the marker is computed
        # only inside the audit patch gate), so ``_prune`` drops it ⇒ byte-identical
        # persist body ⇒ replay-safe when the audit era is off.
        redaction_marker_applied: bool | None = None
        redaction_marker_manifest: dict[str, Any] | None = None
        if inp.redaction_rules and workflow.patched("task-551-redaction"):
            self._phase = "REDACT"
            redaction = await workflow.execute_activity(
                apply_redaction,
                ApplyRedactionInput(
                    note_text=generated.content,
                    note_text_ref=generated.content_ref,
                    rules=list(inp.redaction_rules),
                    response_format=assembled.response_format,
                    provider=smr_provider,
                    model=smr_model,
                    phi_enabled=phi_enabled,
                    phi_fail_closed=phi_fail_closed,
                    trajectory=self._traj(inp),
                ),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_API_RETRY,
            )
            redaction_failed_closed = redaction.failed_closed
            # NEW audit era: persist the manifest marker (rule ids / action + span
            # counts — NEVER removed PHI plaintext) on SummaryMeta. Gated behind its
            # OWN patch marker so the recorded ``task-551-redaction`` histories (which
            # do NOT carry this marker) still replay byte-identically — the two proof
            # workflows that already ran the redaction era predate this audit trail.
            if workflow.patched("task-551-redaction-audit"):
                _m = redaction.manifest
                redaction_marker_applied = _m.applied
                redaction_marker_manifest = {
                    "applied": _m.applied,
                    "totalHits": _m.total_hits,
                    "hitsByRule": dict(_m.hits_by_rule),
                    "ruleIds": sorted(_m.hits_by_rule.keys()),
                    "failedClosed": redaction.failed_closed,
                }
            if redaction.changed:
                # Thread the redacted note downstream (both persist sites read
                # ``generated``); model_copy keeps model/stats/finish_reason intact.
                generated = generated.model_copy(
                    update={"content": redaction.text, "content_ref": redaction.text_ref}
                )
                # Re-run the cheap computational sensors on the TRANSFORMED text so the
                # persisted verdict matches what is delivered. Re-extract note entities
                # first (entity_faithfulness reads them). Branching on the RECORDED
                # ``redaction.changed`` result is replay-safe (the ``if transcript_entities``
                # precedent).
                red_note_entities: list[NEREntity] = []
                try:
                    red_extracted = await workflow.execute_activity(
                        extract_entities,
                        ExtractEntitiesInput(
                            text=generated.content,
                            text_ref=generated.content_ref,
                            language=inp.conversation_language,
                            trajectory=self._traj(inp),
                        ),
                        start_to_close_timeout=_ACTIVITY_TIMEOUT,
                        retry_policy=_NLP_RETRY,
                    )
                    red_note_entities = red_extracted.entities
                except ActivityError:
                    degraded = True
                sensors = await workflow.execute_activity(
                    run_sensors,
                    RunSensorsInput(
                        note_text=generated.content,
                        note_text_ref=generated.content_ref,
                        transcript_text=inp.transcript_text,
                        transcript_text_ref=inp.transcript_ref,
                        note_entities=red_note_entities,
                        transcript_entities=transcript_entities,
                        response_format=assembled.response_format,
                        transcript_context_item_id=inp.context_item_id,
                        retrieved_chunk_ids=retrieved_chunk_ids,
                        allowed_segment_ids=[s.id for s in assembled.segment_citations],
                        thresholds=sensor_thresholds,
                        trajectory=self._traj(inp),
                    ),
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_API_RETRY,
                )

        # 3) Persist the draft + record the gate verdict. Two shapes, by flag:
        if use_optimistic:
            # OPTIMISTIC two-phase delivery. Two nested helpers keep
            # the loop body readable AND keep the replay-critical computational/legacy
            # loop above DELIBERATELY UNTOUCHED (the post-delivery re-delivery + regen
            # mirror it here rather than re-entering it). Both close over the pre-loop locals.
            async def _deliver_early(
                gen_: SmrGenerationResult,
                sens_: SensorRunOutput,
                asm_: AssembleResponse,
                reduced_: bool,
            ) -> DraftResponse:
                """Early persist (phase=EARLY): readable draft, verdict + RAG-triad withheld.

                Used for the first delivery AND each post-delivery regen re-delivery. NOTE
                (apps/api): a re-delivery must UPSERT the existing
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
                        # thread the offloaded-note ref (activity resolves before POST).
                        content_ref=gen_.content_ref,
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
                        # DNA redaction audit marker (TASK-551, audit era). None when
                        # the era is off ⇒ pruned ⇒ byte-identical early-persist body.
                        redaction_applied=redaction_marker_applied,
                        redaction_manifest=redaction_marker_manifest,
                        trajectory=self._traj(inp),
                    ),
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_API_RETRY,
                )

            async def _regen_compute() -> (
                tuple[AssembleResponse, SmrGenerationResult, SensorRunOutput, bool]
            ):
                """One regen pass (assemble → generate → extract → run_sensors).

                Mirrors the computational loop body so the post-delivery regen-if-untouched
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
                        trajectory=self._traj(inp),
                    ),
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_API_RETRY,
                )
                # thread the (offloaded) prompt refs + RAG block to generate
                # (which resolves + folds the block); mirrors the legacy loop.
                gen_ = await workflow.execute_activity(
                    generate,
                    GenerateInput(
                        prompt=asm_.user_prompt,
                        prompt_ref=asm_.user_prompt_ref,
                        system_prompt=asm_.system_prompt,
                        system_prompt_ref=asm_.system_prompt_ref,
                        prompt_block=retrieved.prompt_block,
                        response_format=asm_.response_format,
                        hyperparameters=asm_.hyperparameters,
                        provider=smr_provider,
                        model=smr_model,
                        phi_enabled=phi_enabled,
                        phi_fail_closed=phi_fail_closed,
                        # critique from the pre-regen verdict (set by the
                        # regen-if-untouched branch before this helper runs; None ⇒ byte-identical).
                        regen_feedback=regen_feedback,
                        # PHI-safe segment refs from assemble (empty ⇒
                        # no StrictCitations block, byte-identical prompt).
                        segment_citations=list(asm_.segment_citations),
                        trajectory=self._traj(inp, is_regen=True),
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
                            text=gen_.content,
                            text_ref=gen_.content_ref,
                            language=inp.conversation_language,
                            trajectory=self._traj(inp),
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
                        note_text_ref=gen_.content_ref,
                        transcript_text=inp.transcript_text,
                        transcript_text_ref=inp.transcript_ref,
                        note_entities=note_ents,
                        transcript_entities=transcript_entities,
                        response_format=asm_.response_format,
                        transcript_context_item_id=inp.context_item_id,
                        retrieved_chunk_ids=retrieved_chunk_ids,
                        # PHI-safe segment ids from assemble (empty ⇒ no
                        # marker-credit path — byte-identical to the pre-existing degrade).
                        allowed_segment_ids=[s.id for s in asm_.segment_citations],
                        thresholds=sensor_thresholds,
                        trajectory=self._traj(inp),
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

            # (b) ASSURANCE loop (patch-gated). The costly inferential pass
            #     runs AFTER delivery; a degraded/failed backend degrades to reduced
            #     assurance (never auto-PASS). TWO signal-driven dynamics, gated behind
            #     a SECOND patch marker so an early-delivery-only history (optimistic
            #     marker only) still replays as the single assurance pass:
            #       edit re-bind — a clinician `edit` during the pass re-binds assurance to
            #                  the edited version and re-runs it (assurance only; the
            #                  clinician owns the content, so it is NOT re-generated).
            #       regen-if-untouched — an UNTOUCHED draft with a REGEN-fixable verdict is
            #                  silently regenerated + re-delivered ONCE (budget
            #                  permitting); once edited, regens_remaining=0 escalates the
            #                  REGEN to a surfaced FLAG instead of swapping the note.
            signals_enabled = workflow.patched("task-355-assurance-signals")
            assurance_content = generated.content
            # the offloaded-note ref companion to ``assurance_content`` (threaded
            # to the assurance pass's note_text_ref). Re-bound alongside the content below.
            assurance_content_ref = generated.content_ref
            assurance_version_id: str | None = None
            # Count edit-driven re-runs so a burst of clinician edits
            # cannot drive an unbounded number of costly inferential passes (patch-gated).
            edit_reruns = 0
            while True:
                # Consume a pending edit (arrived before/between passes): re-bind the
                # assurance target to the edited version, then clear the per-pass latch.
                if signals_enabled and self._edited:
                    # re-bind to the edited note (inline or offloaded ref); an
                    # empty edit keeps the current content+ref (mirrors the original `or`).
                    if self._edited_content or self._edited_content_ref is not None:
                        assurance_content = self._edited_content or ""
                        assurance_content_ref = self._edited_content_ref
                    assurance_version_id = self._edited_version_id
                    self._edited = False
                self._phase = "INFER"
                inferential = None
                try:
                    inferential = await workflow.execute_activity(
                        run_inferential_sensors,
                        RunInferentialSensorsInput(
                            note_text=assurance_content,
                            # thread the offloaded note + transcript + chunk refs.
                            note_text_ref=assurance_content_ref,
                            transcript_text=inp.transcript_text,
                            transcript_text_ref=inp.transcript_ref,
                            citations_map=sensors.citations_map,
                            knowledge_chunks=knowledge_chunks,
                            knowledge_chunks_ref=knowledge_chunks_ref,
                            groundedness_threshold=groundedness_threshold,
                            safety_enabled=safety_enabled,
                            # DB-driven judge selection (harness.judge); None ⇒
                            # the activity fails closed (no env-selection fallback).
                            judge_provider=judge_provider,
                            judge_model=judge_model,
                            # policy atomic-fact override (None ⇒ env default).
                            atomic_fact_enabled=atomic_fact_enabled,
                            phi_enabled=phi_enabled,
                            phi_fail_closed=phi_fail_closed,
                            # The optimistic ASSURANCE
                            # pass streams each claim verdict live to apps/api as it
                            # resolves (data-only activity-input fields; the activity
                            # publishes best-effort, never on replay). The legacy
                            # (non-optimistic) pass leaves these unset and stays silent.
                            live_assurance=True,
                            consultation_id=inp.consultation_id,
                            tenant_id=inp.tenant_id,
                            job_id=inp.job_id,
                            # Carry prior verdicts across assurance regen
                            # passes (data-only; no new command / patch marker).
                            prior_verdicts=verdict_cache,
                            trajectory=self._traj(inp),
                        ),
                        start_to_close_timeout=_INFERENTIAL_TIMEOUT,
                        heartbeat_timeout=_INFERENTIAL_HEARTBEAT_TIMEOUT,
                        retry_policy=_INFERENTIAL_RETRY,
                    )
                except ActivityError:
                    reduced_assurance = True

                # An edit landed DURING this pass — the verdict is stale. Re-run
                # assurance on the edited version, but CAP the re-runs so N rapid
                # edits can't drive N costly passes. Patch-gated: histories predating the
                # cap (no marker) keep the uncapped command sequence on replay. Beyond the cap,
                # bind to the latest edit for the record but STOP re-running (the verdict
                # binds to the last assured content — bounded staleness under a burst).
                if signals_enabled and self._edited:
                    edit_cap_enabled = workflow.patched("task-458-edit-rerun-cap")
                    if not edit_cap_enabled or edit_reruns < gate.max_edit_reruns:
                        edit_reruns += 1
                        continue
                    assurance_content = self._edited_content or assurance_content
                    assurance_version_id = self._edited_version_id
                    self._edited = False

                inferential_results = []
                if inferential is not None:
                    guardrail_decisions = inferential.guardrail_decisions
                    rag_triad_score = inferential.rag_triad_score
                    # Thread this pass's populated verdict cache into the next.
                    verdict_cache = inferential.verdict_cache
                    if inferential.degraded:
                        reduced_assurance = True
                    inferential_results = [r for r in inferential.results if not r.degraded]
                inferential_expected = [r.name for r in inferential_results]

                # Once edited, a REGEN-fixable issue must SURFACE as a FLAG (never swap
                # the clinician's note): regens_remaining=0 makes aggregate escalate it.
                regens_remaining = (
                    0 if (signals_enabled and self._ever_edited) else gate.max_regen - regens_used
                )
                verdict = aggregate(
                    list(sensors.results) + inferential_results,
                    regens_remaining=regens_remaining,
                    degraded=degraded,
                    expected=list(COMPUTATIONAL_SENSOR_NAMES) + inferential_expected,
                )

                # Regen-if-untouched: regenerate ONCE + re-deliver, then re-assure.
                # Disabled after any edit (the `not self._ever_edited` guard) — the
                # verdict above will already be a FLAG in that case.
                if (
                    signals_enabled
                    and verdict.decision == GateDecision.REGEN
                    and regens_used < gate.max_regen
                    and not self._ever_edited
                    # The per-run token budget binds here too. This
                    # is the THIRD regen site (this post-delivery rerun); the two
                    # pre-delivery branches already carried the conjunct, so a
                    # budget-exhausted run could still buy one more generate here.
                    and not budget_stopped
                ):
                    # critique from the settled verdict feeds this regen.
                    regen_feedback = build_regen_feedback(
                        list(sensors.results) + inferential_results,
                        enabled=regen_feedback_enabled,
                    )
                    regens_used += 1
                    assembled, generated, sensors, regen_degraded = await _regen_compute()
                    # Count what this regen actually spent. Without
                    # this the rerun is invisible to the budget, so a run could
                    # report less spend than it incurred.
                    tokens_used += _tokens_from_stats(generated.stats)
                    budget_stopped = _budget_exhausted(gate.token_budget_per_run, tokens_used)
                    if regen_degraded:
                        degraded = True
                    draft = await _deliver_early(generated, sensors, assembled, reduced_assurance)
                    assurance_content = generated.content
                    # keep the ref companion in lockstep with the re-generated note.
                    assurance_content_ref = generated.content_ref
                    continue
                break
            decision = str(verdict.decision)
            # A fail-closed redaction (TASK-551) forces a FLAG regardless of the
            # assurance verdict — the delivered draft is then RETRACTED below.
            if redaction_failed_closed:
                decision = str(GateDecision.FLAG)

            # (c) RETRACT-or-FINALIZE — the optimistic-delivery retraction net.
            #     The optimistic path delivered a READABLE draft BEFORE assurance (the
            #     clinician can already be reading it — and, per the accepted
            #     pre-assurance-window design, may already have signed). When the post-delivery
            #     assurance settles to a FLAG, the delivered draft is RETRACTED (apps/api
            #     marks it RETRACTED + writes the WORM audit carrying the FLAG verdict + the
            #     offending claim refs + surfaces a clinician-facing retraction event)
            #     INSTEAD of silently backfilling the FLAG verdict via finalize — the
            #     explicit safety net that makes the accepted window safe (this retraction
            #     net does NOT change the sign-off governance). Patch-gated: a history
            #     predating this retraction net has no marker, so ``workflow.patched``
            #     returns False on replay and the legacy finalize-only command sequence is
            #     preserved (replay-safe). A non-FLAG verdict finalizes exactly as before.
            if workflow.patched("task-481-optimistic-retraction") and (
                verdict.decision == GateDecision.FLAG or redaction_failed_closed
            ):
                self._phase = "RETRACT"
                await workflow.execute_activity(
                    retract_draft,
                    RetractDraftInput(
                        consultation_id=inp.consultation_id,
                        tenant_id=inp.tenant_id,
                        user_id=inp.user_id,
                        job_id=inp.job_id,
                        context_item_id=draft.context_item_id,
                        context_item_version_id=assurance_version_id,
                        gate_decision=decision,
                        reason="assurance_flag",
                        claims_flagged=list(verdict.claims_flagged),
                        sensor_scores=sensors.scores,
                        guardrail_decisions=guardrail_decisions or None,
                        reduced_assurance=reduced_assurance,
                        rag_triad_score=rag_triad_score,
                        trajectory=self._traj(inp),
                    ),
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_API_RETRY,
                )
                # A retracted draft is WITHDRAWN — it does NOT wait for clinician sign-off.
                # Complete terminally (retracted=True); the retraction event has already
                # informed the clinician. The gate-wait + record path below is intentionally
                # skipped (patch-gated, so a replay predating this retraction net keeps the
                # legacy gate flow).
                self._phase = "RETRACTED"
                return HarnessDocWorkflowResult(
                    consultation_id=inp.consultation_id,
                    decision=decision,
                    context_item_id=draft.context_item_id,
                    regens_used=regens_used,
                    escalations=0,
                    approved=False,
                    clinician_id=None,
                    retracted=True,
                )

            # (c') FINALIZE: backfill the early SummaryMeta with the verdict, flip
            #     DRAFT_PENDING_SENSORS -> PENDING_REVIEW, and record the deferred
            #     SENSOR_RUN (+ REDUCED_ASSURANCE) WORM. Idempotent on apps/api.
            #     ``context_item_version_id`` binds the verdict to a clinician-edited
            #     version when an edit re-bound assurance; None otherwise.
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
                    trajectory=self._traj(inp),
                ),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_API_RETRY,
            )
        else:
            # The legacy loop always folds the inferential pass into `verdict`
            # before breaking; only the optimistic path can exit the loop before
            # the first aggregate, and it never reaches this branch.
            assert verdict is not None
            decision = str(verdict.decision)
            # A fail-closed redaction (TASK-551) forces a FLAG — the note the doctor
            # expected redacted must not persist to PENDING_REVIEW as a clean draft.
            if redaction_failed_closed:
                decision = str(GateDecision.FLAG)

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
                    # thread the offloaded-note ref (activity resolves before POST).
                    content_ref=generated.content_ref,
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
                    # DNA redaction audit marker (TASK-551, audit era). None when the
                    # era is off ⇒ pruned ⇒ byte-identical legacy persist body.
                    redaction_applied=redaction_marker_applied,
                    redaction_manifest=redaction_marker_manifest,
                    trajectory=self._traj(inp),
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
        # Bound the escalation loop with a TERMINAL abandon so an
        # un-signed gate cannot escalate forever (was: re-fire ``escalate_gate`` every
        # ``gate_escalation_seconds`` with no max). Patch-gated — a history predating this
        # bound has no marker, so ``workflow.patched`` returns False on replay and the legacy
        # infinite-wait command sequence is preserved. The ``gate_max_escalations`` value
        # comes from the deterministic input, so the bound is replay-stable.
        gate_terminal = workflow.patched("task-458-gate-terminal-abandon")
        while self._approval is None:
            try:
                await workflow.wait_condition(
                    lambda: self._approval is not None,
                    timeout=timedelta(seconds=deadline),
                )
            except TimeoutError:
                # The final escalation before the bound carries a terminal reason so
                # apps/api can mark the gate abandoned (via the escalation record).
                terminal = gate_terminal and escalations + 1 >= gate.gate_max_escalations
                await workflow.execute_activity(
                    escalate_gate,
                    EscalateInput(
                        consultation_id=inp.consultation_id,
                        tenant_id=inp.tenant_id,
                        reason="gate_sla_abandoned" if terminal else "gate_sla_breached",
                        job_id=inp.job_id,
                    ),
                    start_to_close_timeout=_ESCALATE_TIMEOUT,
                    retry_policy=_API_RETRY,
                )
                escalations += 1
                deadline = gate.gate_escalation_seconds
                if gate_terminal and escalations >= gate.gate_max_escalations:
                    break  # terminal bound hit → abandon (handled just below)

        approval = self._approval
        # The loop can now exit WITHOUT approval — only via the terminal-bound
        # ``break`` above (``self._approval`` is None). A late approval racing the final
        # escalation still wins (``approval`` is non-None ⇒ we fall through and record it).
        # Abandon: the draft stays PENDING_REVIEW for manual handling and the escalations
        # already recorded the breaches, so complete terminally WITHOUT a clinician
        # GATE_DECISION (there is none). ``escalations`` is still surfaced.
        if approval is None:
            self._phase = "ABANDONED"
            return HarnessDocWorkflowResult(
                consultation_id=inp.consultation_id,
                decision=decision,
                context_item_id=draft.context_item_id,
                regens_used=regens_used,
                escalations=escalations,
                approved=False,
                clinician_id=None,
            )

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
                trajectory=self._traj(inp),
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


# ===========================================================================
# TASK-662 — ConsultationLoopWorkflow
#
# Everything below is ADDITIVE. `HarnessDocWorkflow` above is frozen (TASK-654
# C2: ~11 live `workflow.patched` eras and 12 replay fixtures depend on its
# exact command sequence), so the loop COMPOSES it as an unmodified child.
#
# Being a NEW workflow type is what makes this safe: a type with no recorded
# histories has no era to be compatible with, so nothing here needs — or may
# have — a `workflow.patched` gate. That is the whole reason TASK-654 D1 chose
# a new workflow over an edit.
# ===========================================================================

# Deterministic workflow id. Idempotent-on-start: a second start for the same
# consultation collides on this id instead of creating a parallel loop, exactly
# as `_workflow_id` does for the document workflow.
CONSULTATION_LOOP_ID_PREFIX = "consultation-loop-"


def consultation_loop_workflow_id(consultation_id: str) -> str:
    """The deterministic loop workflow id for a consultation (pure)."""
    return f"{CONSULTATION_LOOP_ID_PREFIX}{consultation_id}"


@dataclass(frozen=True)
class LoopActionSpec:
    """One entry in the action registry.

    ``implemented`` is deliberately part of the registry rather than expressed
    by omission: an agent's ``alwaysActions`` may name any of TASK-659's seven
    canonical keys, so the loop needs an entry for every one of them. A key that
    this ticket does not yet back is dispatched as an OBSERVABLE skip
    (``action.skipped`` / ``unsupported_action``) — never a silent no-op, which
    would look identical to success on the client's feed.

    ``lifecycle`` marks an action driven by the consultation's start/end rather
    than by a context subscription. Lifecycle actions are counted against the
    action budget but never BLOCKED by it: stopping live documentation and
    finalizing the note must happen even on a run that overspent.
    """

    key: str
    implemented: bool
    lifecycle: bool = False
    # "activity" | "child_workflow"
    kind: str = "activity"
    # TASK-664. True for an action whose OUTPUT re-enters the context bus as a
    # new item one depth deeper. That re-entry is the cascade (TASK-654 §4.2) —
    # it is what makes image -> text and audio -> transcript the same mechanism —
    # and it is why the depth cap and the action budget are load-bearing rather
    # than theoretical.
    derives_context: bool = False
    # Both set ONLY for child_workflow actions, and never left to the SDK
    # default — see the note on `_start_finalize_child` for why each default is
    # the wrong choice here.
    parent_close_policy: workflow.ParentClosePolicy | None = None
    child_cancellation_type: workflow.ChildWorkflowCancellationType | None = None


LOOP_ACTION_REGISTRY: dict[str, LoopActionSpec] = {
    LOOP_ACTION_LIVEDOC_START: LoopActionSpec(
        key=LOOP_ACTION_LIVEDOC_START, implemented=True, lifecycle=True
    ),
    LOOP_ACTION_LIVEDOC_STOP: LoopActionSpec(
        key=LOOP_ACTION_LIVEDOC_STOP, implemented=True, lifecycle=True
    ),
    LOOP_ACTION_CLIENT_EMIT: LoopActionSpec(key=LOOP_ACTION_CLIENT_EMIT, implemented=True),
    LOOP_ACTION_HARNESS_FINALIZE: LoopActionSpec(
        key=LOOP_ACTION_HARNESS_FINALIZE,
        implemented=True,
        lifecycle=True,
        kind="child_workflow",
        parent_close_policy=workflow.ParentClosePolicy.REQUEST_CANCEL,
        child_cancellation_type=workflow.ChildWorkflowCancellationType.TRY_CANCEL,
    ),
    # TASK-664 backs all three. TASK-662 declared them with `implemented=False`
    # so an agent naming one in `alwaysActions` got an OBSERVABLE
    # `unsupported_action` skip rather than a silent no-op; the registry entry
    # stays, the flag flips, and the cascade they feed is now real.
    LOOP_ACTION_VISION_EXTRACT_TEXT: LoopActionSpec(
        key=LOOP_ACTION_VISION_EXTRACT_TEXT, implemented=True, derives_context=True
    ),
    LOOP_ACTION_DOCUMENT_EXTRACT_TEXT: LoopActionSpec(
        key=LOOP_ACTION_DOCUMENT_EXTRACT_TEXT, implemented=True, derives_context=True
    ),
    LOOP_ACTION_NLP_EXTRACT_ENTITIES: LoopActionSpec(
        key=LOOP_ACTION_NLP_EXTRACT_ENTITIES, implemented=True, derives_context=True
    ),
}

# Activity budgets for the loop. All three side effects are best-effort by
# contract (the activities swallow their own errors), so retries only cover
# infra blips.
_LOOP_CONFIG_TIMEOUT = timedelta(seconds=30)
_LOOP_CONFIG_RETRY = RetryPolicy(maximum_attempts=3, initial_interval=timedelta(seconds=1))
_LOOP_ACTION_TIMEOUT = timedelta(seconds=30)
_LOOP_ACTION_RETRY = RetryPolicy(maximum_attempts=2)
_LOOP_EVENT_TIMEOUT = timedelta(seconds=10)
_LOOP_EVENT_RETRY = RetryPolicy(maximum_attempts=1)

# Bound on the de-duplication memory. Temporal history is the constraint, not
# RAM: this set is carried across every `continue_as_new`, so it must not grow
# without limit. Oldest keys are evicted first — a duplicate arriving more than
# this many DISTINCT events after the original is re-processed, which is the
# safe direction to fail (a re-run action, not a lost one).
_LOOP_MAX_SEEN_KEYS = 2_000

# ---------------------------------------------------------------------------
# TASK-664 — the reasoning lane
#
# ⚠ THE PATCH ERA BELOW IS MANDATORY, AND FOR A REASON THAT DID NOT APPLY TO
# TASK-662.
#
# TASK-662 could add `ConsultationLoopWorkflow` with no `workflow.patched` gate
# because a brand-new workflow type has no recorded history to stay compatible
# with. That is no longer true: TASK-662 also FROZE a fixture of this type
# (`fixtures/consultation_loop_task662_history.json`, asserted in
# `test_replay_compat.py`). Every new command this ticket makes the loop issue —
# the planner activity, the specialist children, the adjudication publish, the
# derived-context activities — would therefore break that replay if issued
# unconditionally.
#
# Two things keep the frozen fixture green, and BOTH are needed:
#
#   1. `reasoning_enabled` defaults to False on `ConsultationLoopConfig`, so the
#      old recorded config deserialises with the lane OFF.
#   2. Every gate is written `config.reasoning_enabled and workflow.patched(...)`
#      — the flag operand FIRST. On the old history the flag is False, so
#      `workflow.patched` is never even CALLED, no marker is looked for, and the
#      recorded command sequence is reproduced exactly.
#
# Reversing those two operands would still be correct for a fresh run and would
# still fail the frozen replay. Order matters.
# ---------------------------------------------------------------------------
_PATCH_REASONING = "task-664-reasoning"

# Which activity backs each derived-context action. A MAP rather than a chain of
# `elif`s, so adding a fourth deriver is a registry entry plus a line here and
# cannot forget the dispatch branch.
_DERIVE_ACTIVITIES: dict[str, Any] = {
    LOOP_ACTION_VISION_EXTRACT_TEXT: vision_extract_text,
    LOOP_ACTION_DOCUMENT_EXTRACT_TEXT: document_extract_text,
    LOOP_ACTION_NLP_EXTRACT_ENTITIES: nlp_extract_entities,
}

# Bound on the rolling context window each specialist's scoped slice is cut
# from. It lives in workflow state and is carried nowhere, so it must not grow
# with the length of the consultation.
_LOOP_MAX_CONTEXT_WINDOW = 200

_PLAN_TIMEOUT = timedelta(seconds=90)
_PLAN_RETRY = RetryPolicy(maximum_attempts=2)
# One specialist child is allowed a generous wall-clock budget (a model call
# plus its own orchestration) but only ONE attempt: a specialist that failed is
# information, and silently retrying it would hide a persistently broken agent
# behind a longer consultation.
_SPECIALIST_TIMEOUT = timedelta(minutes=5)
_DERIVE_TIMEOUT = timedelta(seconds=120)
_DERIVE_RETRY = RetryPolicy(maximum_attempts=2)


def specialist_workflow_id(consultation_id: str, agent_id: str, plan_id: str) -> str:
    """Deterministic child id for one specialist run (pure).

    Keyed by PLAN as well as agent: the same specialist legitimately runs again
    under a later plan, but must never collide with its own earlier run.
    """
    return f"specialist-{consultation_id}-{agent_id}-{plan_id}"


@workflow.defn
class SpecialistWorkflow:
    """One specialist's review, isolated as a CHILD workflow.

    Isolation is the whole point and it buys two distinct things:

    * **Its own history budget.** A specialist that makes several model calls
      accumulates its events in its own history rather than in the parent's,
      so a consultation with many specialists does not march the orchestrator
      toward Temporal's 51,200-event ceiling.
    * **Its own failure domain.** A specialist that fails, fails alone. The
      parent records the failure, degrades, and carries on with the rest —
      which is exactly what a clinical consultation needs, because losing one
      reviewer's opinion is not a reason to lose the consultation.

    **This workflow cannot write the note or the gate.** It dispatches no loop
    actions, starts no children, and its result type has no field capable of
    carrying note text or a gate decision. The primary's exclusivity (TASK-654
    D7) is therefore structural here, not a convention someone must remember.
    """

    @workflow.run
    async def run(self, inp: SpecialistWorkflowInput) -> SpecialistResult:
        try:
            result: SpecialistResult = await workflow.execute_activity(
                run_specialist,
                SpecialistAnalysisInput(
                    consultation_id=inp.consultation_id,
                    tenant_id=inp.tenant_id,
                    plan_id=inp.plan_id,
                    agent_id=inp.agent_id,
                    agent_slug=inp.agent_slug,
                    goal=inp.goal,
                    kind_key=inp.kind_key,
                    write_scope=list(inp.write_scope),
                    context=list(inp.context),
                ),
                start_to_close_timeout=_SPECIALIST_TIMEOUT,
                retry_policy=RetryPolicy(maximum_attempts=1),
            )
        except ActivityError:
            # Surfaced to the parent as a child-workflow failure, which the
            # parent turns into `degraded` — never into an aborted consultation.
            raise

        # Second enforcement pass, in the child. The parent's is authoritative
        # (enforcement outside agent code, TASK-654 §4.6); this one means a
        # mis-scoped finding is refused at the earliest point it exists, and the
        # refusal travels back with the result instead of being invisible.
        allowed = set(inp.write_scope) - PRIMARY_ONLY_OUTPUT_KINDS
        kept = [f for f in result.findings if f.output_kind in allowed]
        refused = [f.output_kind for f in result.findings if f.output_kind not in allowed]
        return SpecialistResult(
            agent_id=inp.agent_id,
            plan_id=inp.plan_id,
            kind_key=inp.kind_key,
            findings=kept,
            out_of_scope_findings=dedupe_preserving_order(
                [*result.out_of_scope_findings, *refused]
            ),
            degraded=result.degraded,
        )


def dedupe_preserving_order(items: list[str]) -> list[str]:
    """Order-preserving de-duplication (pure; safe inside a workflow body)."""
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


@workflow.defn
class ConsultationLoopWorkflow:
    """The durable, per-consultation orchestrator — deterministic subscriptions only.

    One instance per consultation, long-lived, signal-driven. It pins its
    configuration once, then maps each arriving context item onto the actions
    its pinned subscriptions declare, dispatching them as activities (or, for
    `harness.finalize`, as an unmodified child workflow).

    There is deliberately NO reasoning here — no planner, no specialists, no
    adjudication. That is TASK-664. What this workflow guarantees is the
    mechanical substrate underneath it: a pinned config, idempotent event
    intake, bounded cascades, planned checkpoints, and a child finalize whose
    close policy is explicit.

    ### Signal safety

    Three rules, all of which this class follows and none of which is optional:

    1. **`@workflow.init`** — signal handlers can run BEFORE `run()` when a
       signal is delivered with the start. Initialising in `__init__` (which
       `@workflow.init` feeds the run arguments) means the handler always
       mutates a fully-constructed instance.
    2. **A handler never calls an activity.** It takes the lock, mutates state,
       and returns; the main coroutine observes the state and acts. A handler
       that awaited an activity would interleave with the main loop at an
       arbitrary point and reorder the recorded command sequence.
    3. **One `asyncio.Lock` serialises every handler and the drain**, so the
       de-duplication set and the pending queue are never read while a handler
       is halfway through updating them.
    """

    @workflow.init
    def __init__(self, inp: ConsultationLoopWorkflowInput) -> None:
        self._input = inp
        self._lock = asyncio.Lock()

        # Pinned ONCE (C1). Carried across continue_as_new via the input, so a
        # continued execution never re-fetches — a mid-run tenant edit stays
        # invisible for the whole consultation, not merely until the first
        # checkpoint.
        self._config: ConsultationLoopConfig | None = inp.pinned_config

        self._pending: list[ContextAddedSignal] = list(inp.carried_pending)
        self._seen_keys: list[str] = list(inp.carried_seen_keys)
        self._seen: set[str] = set(inp.carried_seen_keys)

        self._events_processed = inp.carried_events_processed
        self._duplicates_ignored = inp.carried_duplicates_ignored
        self._depth_capped = inp.carried_depth_capped
        self._actions_dispatched = inp.carried_actions_dispatched
        self._degraded = inp.carried_degraded
        self._livedoc_started = inp.carried_livedoc_started
        self._start_actions_done = inp.carried_start_actions_done
        self._continuations = inp.carried_continuations

        # Accepted THIS execution — the checkpoint trigger. Reset by design on
        # every continuation; the cumulative figure is `_events_processed`.
        self._accepted_this_run = 0

        self._ending = False
        self._ending_signal: ConsultationEndingSignal | None = None
        self._cancelled = False
        self._cancel_reason: str | None = None
        self._finalized = False
        self._finalize_workflow_id: str | None = None
        self._phase = "INIT"

        # -- TASK-664 reasoning lane ---------------------------------------
        # `(agent_id, kind_key)` pairs already reviewed. CARRIED across
        # checkpoints: dropping it at a continuation would let every pair run
        # again, which is precisely the cycle the detector exists to stop.
        self._agent_kind_seen: list[str] = list(inp.carried_agent_kind_seen)
        self._agent_kind_set: set[str] = set(inp.carried_agent_kind_seen)
        self._plans_made = inp.carried_plans_made
        self._specialists_run = inp.carried_specialists_run
        self._specialist_failures = inp.carried_specialist_failures
        self._cycles_suppressed = inp.carried_cycles_suppressed
        self._derived_context = inp.carried_derived_context
        # Planning-checkpoint accounting. Deliberately NOT carried: a
        # continuation starts a fresh interval, and the ending replan covers the
        # tail either way.
        self._events_since_plan = 0
        self._kinds_since_plan: list[str] = []
        # Bounded rolling window of context, used to build each specialist's
        # SCOPED slice. Bounded because it lives in workflow state.
        self._context_log: list[ScopedContextItem] = []

    # -- signals / query ---------------------------------------------------

    @workflow.signal(name="contextAdded")
    async def context_added(self, payload: ContextAddedSignal) -> None:
        """A context item reached the consultation.

        Records it and returns immediately. De-duplication happens HERE, under
        the lock, so two concurrent deliveries of the same item can never both
        be queued; dispatch happens in the main coroutine.
        """
        async with self._lock:
            key = payload.dedupe_key()
            if key in self._seen:
                self._duplicates_ignored += 1
                return
            self._seen.add(key)
            self._seen_keys.append(key)
            if len(self._seen_keys) > _LOOP_MAX_SEEN_KEYS:
                evicted = self._seen_keys.pop(0)
                self._seen.discard(evicted)
            self._pending.append(payload)
            self._events_processed += 1
            self._accepted_this_run += 1

    @workflow.signal(name="consultationEnding")
    async def consultation_ending(self, payload: ConsultationEndingSignal) -> None:
        """The consultation is over: drain, run the ending actions, complete."""
        async with self._lock:
            self._ending = True
            self._ending_signal = payload

    @workflow.signal(name="cancel")
    async def cancel(self, payload: CancelLoopSignal) -> None:
        """Stop WITHOUT running the ending actions (the consultation was abandoned)."""
        async with self._lock:
            self._cancelled = True
            self._cancel_reason = payload.reason

    @workflow.query(name="state")
    def state(self) -> ConsultationLoopState:
        """Current loop state (for ops/tests; does not affect determinism)."""
        config = self._config
        return ConsultationLoopState(
            consultation_id=self._input.consultation_id,
            phase=self._phase,
            config_pinned=config is not None,
            enabled=bool(config and config.enabled),
            agent_config_version_id=config.agent_config_version_id if config else None,
            context_schema_version_id=config.context_schema_version_id if config else None,
            events_processed=self._events_processed,
            duplicates_ignored=self._duplicates_ignored,
            depth_capped=self._depth_capped,
            actions_dispatched=self._actions_dispatched,
            pending=len(self._pending),
            degraded=self._degraded,
            ending=self._ending,
            cancelled=self._cancelled,
            livedoc_started=self._livedoc_started,
            finalize_workflow_id=self._finalize_workflow_id,
            continuations=self._continuations,
            reasoning_enabled=bool(config and config.reasoning_enabled),
            plans_made=self._plans_made,
            specialists_run=self._specialists_run,
            specialist_failures=self._specialist_failures,
            cycles_suppressed=self._cycles_suppressed,
            derived_context=self._derived_context,
        )

    # -- run ---------------------------------------------------------------

    @workflow.run
    async def run(self, inp: ConsultationLoopWorkflowInput) -> ConsultationLoopWorkflowResult:
        await self._pin_config()

        config = self._config
        if config is None or not config.enabled:
            # TASK-654 K7: a consultation with no loop configured (or whose
            # config could not be resolved) behaves EXACTLY as it does today.
            # Completing immediately is the correct expression of that: an idle
            # workflow parked forever would be a resource leak that changes
            # nothing about the consultation.
            self._phase = "DISABLED"
            return self._result()

        self._phase = "RUNNING"
        if not self._start_actions_done:
            await self._run_lifecycle_actions(config.start_actions)
            self._start_actions_done = True

        while True:
            await workflow.wait_condition(
                lambda: bool(self._pending) or self._ending or self._cancelled
            )
            await self._drain()

            if self._cancelled:
                self._phase = "CANCELLED"
                break

            if self._ending:
                self._phase = "ENDING"
                # Anything that landed while the last batch was dispatching.
                await self._drain()
                # The FINAL planning checkpoint. Whatever arrived after the last
                # interval boundary would otherwise never be reviewed, so the
                # end of the consultation is always a checkpoint — regardless of
                # how few events it has been since the previous one.
                await self._maybe_replan(force=True)
                await self._run_lifecycle_actions(config.ending_actions)
                self._phase = "DONE"
                break

            if self._should_checkpoint():
                self._phase = "CHECKPOINT"
                workflow.continue_as_new(self._checkpoint_input())

        return self._result()

    # -- config pinning ----------------------------------------------------

    async def _pin_config(self) -> None:
        """Resolve the configuration ONCE, on the first execution only.

        A continued execution already carries `pinned_config` and short-circuits
        here — which is what makes the pin hold for the whole consultation
        rather than only until the first checkpoint.
        """
        if self._config is not None:
            return
        self._phase = "PINNING"
        try:
            self._config = await workflow.execute_activity(
                fetch_loop_config,
                FetchLoopConfigInput(
                    consultation_id=self._input.consultation_id,
                    tenant_id=self._input.tenant_id,
                ),
                start_to_close_timeout=_LOOP_CONFIG_TIMEOUT,
                retry_policy=_LOOP_CONFIG_RETRY,
            )
        except ActivityError:
            # Retries are exhausted. Fail SAFE, not closed: an unresolvable loop
            # config must not fail a clinical consultation, it must leave it
            # behaving as it did before the loop existed. Recorded as degraded so
            # the outcome is never mistaken for "no loop was configured".
            self._degraded = True
            self._config = None

    # -- event handling ----------------------------------------------------

    async def _drain(self) -> None:
        """Dispatch every queued event, including any that arrive mid-dispatch."""
        while True:
            async with self._lock:
                if not self._pending:
                    return
                batch = list(self._pending)
                self._pending.clear()
            for signal in batch:
                await self._handle_context(signal)
                # The PLANNING checkpoint. Evaluated per item but FIRING only
                # every `replan_interval_events` — the intermediate frequency
                # *Learning When to Plan* finds beats replanning per step.
                await self._maybe_replan()

    async def _handle_context(self, signal: ContextAddedSignal) -> None:
        config = self._config
        if config is None:
            return

        self._observe_context(signal)

        actions = config.actions_for_kind(signal.kind_key)
        if not actions:
            # Not subscribed. Silence is correct here — an unsubscribed kind is
            # not an anomaly, it is the common case.
            return

        if signal.depth >= config.budget.max_depth:
            # Cascade termination (RK-4). Reported once per capped ITEM, not
            # once per action it would have triggered.
            self._depth_capped += 1
            await self._emit_event(
                LOOP_EVENT_ACTION_SKIPPED, signal=signal, reason=LOOP_SKIP_DEPTH_CAP
            )
            return

        for action in actions:
            await self._dispatch(action, signal)

    async def _dispatch(self, action: str, signal: ContextAddedSignal) -> None:
        spec = LOOP_ACTION_REGISTRY.get(action)
        if spec is None or not spec.implemented:
            await self._emit_event(
                LOOP_EVENT_ACTION_SKIPPED,
                signal=signal,
                action=action,
                reason=LOOP_SKIP_UNSUPPORTED_ACTION,
            )
            return

        config = self._config
        assert config is not None  # noqa: S101 - unreachable; _handle_context guards it
        if not spec.lifecycle and self._actions_dispatched >= config.budget.max_actions:
            # DEGRADE, never abort (TDD-4). The consultation keeps running and
            # keeps accepting events; only further subscription-driven work is
            # withheld, and every withholding is visible on the client feed.
            self._degraded = True
            await self._emit_event(
                LOOP_EVENT_ACTION_SKIPPED,
                signal=signal,
                action=action,
                reason=LOOP_SKIP_BUDGET_EXHAUSTED,
            )
            return

        await self._run_action(spec, signal=signal)

    async def _run_lifecycle_actions(self, actions: list[str]) -> None:
        """Run the consultation's start / ending actions in declared order."""
        for action in actions:
            spec = LOOP_ACTION_REGISTRY.get(action)
            if spec is None or not spec.implemented:
                await self._emit_event(
                    LOOP_EVENT_ACTION_SKIPPED,
                    action=action,
                    reason=LOOP_SKIP_UNSUPPORTED_ACTION,
                )
                continue
            await self._run_action(spec, signal=None)

    async def _run_action(
        self, spec: LoopActionSpec, *, signal: ContextAddedSignal | None
    ) -> None:
        """Execute one registry entry. Every branch is an activity or a child."""
        if spec.key == LOOP_ACTION_LIVEDOC_START:
            await workflow.execute_activity(
                livedoc_start,
                self._livedoc_input(),
                start_to_close_timeout=_LOOP_ACTION_TIMEOUT,
                retry_policy=_LOOP_ACTION_RETRY,
            )
            self._livedoc_started = True
        elif spec.key == LOOP_ACTION_LIVEDOC_STOP:
            await workflow.execute_activity(
                livedoc_stop,
                self._livedoc_input(),
                start_to_close_timeout=_LOOP_ACTION_TIMEOUT,
                retry_policy=_LOOP_ACTION_RETRY,
            )
            self._livedoc_started = False
        elif spec.key == LOOP_ACTION_CLIENT_EMIT:
            # `client.emit` IS the loop event — it does not additionally
            # announce itself, or every emission would be recorded twice.
            await self._emit_event(
                LOOP_EVENT_ACTION_DISPATCHED, signal=signal, action=spec.key
            )
        elif spec.key == LOOP_ACTION_HARNESS_FINALIZE:
            await self._start_finalize_child(spec)
        elif spec.derives_context:
            # TASK-664 — the three keys TASK-662 declared but left unbacked.
            # Gated on the patch era: an old history recorded them as
            # `unsupported_action` SKIPS, and replaying it must reproduce that,
            # not suddenly issue an activity command that was never recorded.
            if not workflow.patched(_PATCH_REASONING):  # pragma: no cover - replay-only path
                await self._emit_event(
                    LOOP_EVENT_ACTION_SKIPPED,
                    signal=signal,
                    action=spec.key,
                    reason=LOOP_SKIP_UNSUPPORTED_ACTION,
                )
                return
            await self._run_derive_action(spec, signal)
        else:  # pragma: no cover - registry guarantees the branches above
            return
        self._actions_dispatched += 1

    # -- derived-context cascade (TASK-664) --------------------------------

    async def _run_derive_action(
        self, spec: LoopActionSpec, signal: ContextAddedSignal | None
    ) -> None:
        """Run one derive action and RE-ENTER its output as context, depth + 1.

        This closes the cascade TASK-654 §4.2 describes: an action's output is
        just more context, so image -> text and audio -> transcript are the same
        mechanism rather than two special cases. The derived item goes through
        the identical intake path as a gateway-delivered one — same
        de-duplication, same depth cap, same budget — which is what stops the
        cascade being unbounded.
        """
        if signal is None:  # pragma: no cover - derive actions are never lifecycle
            return

        activity_fn = _DERIVE_ACTIVITIES.get(spec.key)
        if activity_fn is None:  # pragma: no cover - registry and map are built together
            return

        result: DeriveContextResult = await workflow.execute_activity(
            activity_fn,
            DeriveContextInput(
                consultation_id=self._input.consultation_id,
                tenant_id=self._input.tenant_id,
                action=spec.key,
                context_item_id=signal.context_item_id,
                kind_key=signal.kind_key,
                text=signal.text,
                text_ref=signal.text_ref,
            ),
            start_to_close_timeout=_DERIVE_TIMEOUT,
            retry_policy=_DERIVE_RETRY,
        )
        if not result.derived or not result.context_item_id:
            # Nothing extractable, or the downstream service was unavailable.
            # That simply ends this branch of the cascade — it is not an error,
            # and it must not degrade a consultation.
            return

        derived = ContextAddedSignal(
            context_item_id=result.context_item_id,
            kind_key=result.kind_key,
            source="AI",
            # Deterministic, and derived from the parent's own identity, so a
            # re-delivery of the parent produces the SAME de-duplication key and
            # cannot double-derive.
            occurred_at=f"{signal.occurred_at or ''}:{spec.key}",
            depth=signal.depth + 1,
            text=result.text,
        )
        async with self._lock:
            key = derived.dedupe_key()
            if key in self._seen:
                self._duplicates_ignored += 1
                return
            self._seen.add(key)
            self._seen_keys.append(key)
            if len(self._seen_keys) > _LOOP_MAX_SEEN_KEYS:
                evicted = self._seen_keys.pop(0)
                self._seen.discard(evicted)
            self._pending.append(derived)
            self._derived_context += 1

        await self._emit_event(
            LOOP_EVENT_CONTEXT_DERIVED, signal=derived, action=spec.key
        )

    def _livedoc_input(self) -> LiveDocControlInput:
        ending = self._ending_signal
        return LiveDocControlInput(
            consultation_id=self._input.consultation_id,
            tenant_id=self._input.tenant_id,
            user_id=self._input.user_id,
            session_id=self._input.session_id,
            persist_snapshot=ending.persist_snapshot if ending else True,
        )

    async def _emit_event(
        self,
        event_type: str,
        *,
        signal: ContextAddedSignal | None = None,
        action: str | None = None,
        reason: str | None = None,
    ) -> None:
        """Publish one event on the live client feed. Never fails the loop."""
        try:
            await workflow.execute_activity(
                emit_loop_event,
                EmitLoopEventInput(
                    consultation_id=self._input.consultation_id,
                    tenant_id=self._input.tenant_id,
                    event_type=event_type,
                    context_item_id=signal.context_item_id if signal else None,
                    kind_key=signal.kind_key if signal else None,
                    action=action,
                    reason=reason,
                ),
                start_to_close_timeout=_LOOP_EVENT_TIMEOUT,
                schedule_to_close_timeout=_LOOP_EVENT_TIMEOUT,
                retry_policy=_LOOP_EVENT_RETRY,
            )
        except ActivityError:
            pass  # the client feed is non-clinical — never block the loop

    # -- child finalize ----------------------------------------------------

    async def _start_finalize_child(self, spec: LoopActionSpec) -> None:
        """Start `HarnessDocWorkflow` as an UNMODIFIED child, then await it.

        Two things matter here and both are easy to get wrong.

        **The close policy is explicit.** The SDK default (verified against
        temporalio 1.30.0) is `ParentClosePolicy.TERMINATE`, which would HARD-KILL
        an in-flight document workflow — possibly mid-`persist_draft` — the
        moment this loop completes or is cancelled. `REQUEST_CANCEL` instead
        propagates a cancellation the child can wind down from. (The execution
        plan says the default is ABANDON; it is not, in this SDK. Either way the
        remedy is the same: never inherit it.)

        **The cancellation type is explicit too, and for a subtler reason.** The
        SDK default is `WAIT_CANCELLATION_COMPLETED`: on cancel, the parent
        blocks until the child has FINISHED cancelling. The document workflow can
        sit at a clinician gate with a 24-hour SLA and can be mid-activity when
        the request lands, so that default makes the loop's own cancellation
        hostage to how quickly the child happens to wind down. Measured on
        temporalio 1.30.0: with the default (and also with
        `WAIT_CANCELLATION_REQUESTED`) the parent stayed RUNNING indefinitely
        after `cancel()`, even though its history showed the child's cancel had
        been both initiated and delivered
        (`REQUEST_CANCEL_EXTERNAL_WORKFLOW_EXECUTION_INITIATED` →
        `EXTERNAL_WORKFLOW_EXECUTION_CANCEL_REQUESTED`). `TRY_CANCEL` issues that
        same request and then resolves the await immediately, which is the
        behaviour this loop wants: the child's cancellation is guaranteed by the
        recorded request, and the orchestrator does not hang waiting to watch it
        happen.

        **The child id is the one the gateway already uses.** Starting a second
        document workflow for a consultation that already has one would double
        every WORM write, so a collision is treated as success — the finalize
        the loop wanted is already running.

        The loop AWAITS the child. That is deliberate: it couples the two
        lifetimes so a completed loop implies a completed finalize, which is what
        lets `REQUEST_CANCEL` be safe. Starting the child and returning would
        instead make the close policy actively harmful — the loop's own normal
        completion would cancel the note it had just asked for.
        """
        request = (
            self._ending_signal.finalize
            if self._ending_signal and self._ending_signal.finalize
            else LoopFinalizeRequest()
        )
        child_id = f"harness-doc-{self._input.consultation_id}"
        self._finalize_workflow_id = child_id

        child_input = HarnessDocWorkflowInput(
            consultation_id=self._input.consultation_id,
            tenant_id=self._input.tenant_id,
            user_id=self._input.user_id,
            job_id=request.job_id,
            correlation_id=self._input.correlation_id,
            context_item_id=request.context_item_id,
            transcript_text=request.transcript_text,
            transcript_ref=request.transcript_ref,
            conversation_language=request.conversation_language,
            dna_style_id=request.dna_style_id,
            template=request.template,
            smr_provider=request.smr_provider,
            smr_model=request.smr_model,
        )

        try:
            handle = await workflow.start_child_workflow(
                HarnessDocWorkflow.run,
                child_input,
                id=child_id,
                parent_close_policy=spec.parent_close_policy
                or workflow.ParentClosePolicy.REQUEST_CANCEL,
                cancellation_type=spec.child_cancellation_type
                or workflow.ChildWorkflowCancellationType.WAIT_CANCELLATION_REQUESTED,
            )
        except WorkflowAlreadyStartedError:
            self._finalized = True
            return

        self._finalized = True
        try:
            await handle
        except ChildWorkflowError as exc:
            if is_cancelled_exception(exc):
                # The child was cancelled because WE were. Swallowing this would
                # end the loop as COMPLETED and hide the abort from every
                # dashboard; re-raising as cancellation ends it as CANCELED,
                # which is what actually happened.
                raise asyncio.CancelledError from exc
            # A child that genuinely FAILED (SMR down, sensors unavailable) is a
            # different matter: that is its own recorded outcome with its own
            # remediation, and it must not also fail the orchestrator that asked
            # for it.
            self._degraded = True

    # -- reasoning lane (TASK-664) -----------------------------------------

    def _observe_context(self, signal: ContextAddedSignal) -> None:
        """Record one item for the planning checkpoint and the scoped-read window. PURE."""
        self._events_since_plan += 1
        if signal.kind_key and signal.kind_key not in self._kinds_since_plan:
            self._kinds_since_plan.append(signal.kind_key)
        self._context_log.append(
            ScopedContextItem(
                context_item_id=signal.context_item_id,
                kind_key=signal.kind_key,
                text=signal.text,
            )
        )
        if len(self._context_log) > _LOOP_MAX_CONTEXT_WINDOW:
            self._context_log.pop(0)

    async def _maybe_replan(self, *, force: bool = False) -> None:
        """Run a planning checkpoint when one is due.

        **Not per event.** *Learning When to Plan* finds that an intermediate
        replanning frequency beats replanning at every step, which is an
        overthinking failure mode; the cadence is
        ``input.replan_interval_events`` and is a configurable knob rather than
        a constant, because how densely a department produces context is a
        property of the department, not of this code.

        ``force`` is the end-of-consultation checkpoint: whatever arrived after
        the last interval boundary must still be reviewed.
        """
        config = self._config
        # The flag operand comes FIRST so `workflow.patched` is never called on a
        # pre-TASK-664 history — see the note on `_PATCH_REASONING`.
        if config is None or not config.reasoning_enabled:
            return
        if not workflow.patched(_PATCH_REASONING):  # pragma: no cover - replay-only path
            return
        if not force and self._events_since_plan < self._input.replan_interval_events:
            return
        if not self._kinds_since_plan:
            return

        trigger_kinds = list(self._kinds_since_plan)
        self._events_since_plan = 0
        self._kinds_since_plan = []

        primary = config.primary()
        candidates = [
            agent
            for agent in config.agents
            if not agent.is_primary
            and any(agent.reads(kind) for kind in trigger_kinds)
        ]
        if not candidates:
            return

        decision: PlanDecision = await workflow.execute_activity(
            plan_reasoning,
            PlanLoopInput(
                consultation_id=self._input.consultation_id,
                tenant_id=self._input.tenant_id,
                plan_seq=self._plans_made,
                goal=primary.goal if primary else None,
                trigger_kinds=trigger_kinds,
                candidates=candidates,
            ),
            start_to_close_timeout=_PLAN_TIMEOUT,
            retry_policy=_PLAN_RETRY,
        )
        self._plans_made += 1
        if decision.degraded:
            # A planner that could not decide dispatches nothing and degrades the
            # run — it never guesses a roster of clinical reviewers.
            self._degraded = True
        await self._emit_event(LOOP_EVENT_PLAN_DECIDED, action=decision.plan_id)

        results = await self._run_specialists(config, decision)
        if results:
            await self._adjudicate(config, decision, results)

    async def _run_specialists(
        self, config: ConsultationLoopConfig, decision: PlanDecision
    ) -> list[SpecialistResult]:
        """Run the planned specialists as isolated children; collect their findings."""
        by_id = {agent.agent_id: agent for agent in config.agents}
        results: list[SpecialistResult] = []

        for planned in decision.dispatch:
            agent = by_id.get(planned.agent_id)
            # A planner naming an unknown agent, the primary, or a kind outside
            # the agent's read scope is refused HERE. The activity already
            # filters the same three cases; this is the orchestrator's own
            # check, and the orchestrator's is the one that counts.
            if agent is None or agent.is_primary or not agent.reads(planned.kind_key):
                continue

            pair = f"{planned.agent_id}:{planned.kind_key}"
            if pair in self._agent_kind_set:
                # Cycle detection on `(agent, kind)` (TASK-654 §4.2). The same
                # reviewer re-reviewing the same kind is the shape a cascade
                # loops in, and suppressing it is what terminates the cascade.
                self._cycles_suppressed += 1
                await self._emit_event(
                    LOOP_EVENT_ACTION_SKIPPED,
                    action=planned.agent_id,
                    reason=LOOP_SKIP_CYCLE_DETECTED,
                )
                continue

            if self._specialists_run >= config.budget.max_specialist_runs:
                # DEGRADE, never abort — same rule as the action budget. The
                # consultation keeps running and keeps accepting context; only
                # further specialist review is withheld, visibly.
                self._degraded = True
                await self._emit_event(
                    LOOP_EVENT_ACTION_SKIPPED,
                    action=planned.agent_id,
                    reason=LOOP_SKIP_SPECIALIST_BUDGET,
                )
                continue

            self._agent_kind_set.add(pair)
            self._agent_kind_seen.append(pair)
            self._specialists_run += 1

            # SCOPED READ: the child is handed only the kinds it subscribes to.
            # Filtering at the boundary is what makes the read scope enforceable
            # — a specialist cannot read what it was never given.
            scoped = [item for item in self._context_log if agent.reads(item.kind_key)]

            try:
                result: SpecialistResult = await workflow.execute_child_workflow(
                    SpecialistWorkflow.run,
                    SpecialistWorkflowInput(
                        consultation_id=self._input.consultation_id,
                        tenant_id=self._input.tenant_id,
                        plan_id=decision.plan_id,
                        agent_id=agent.agent_id,
                        agent_slug=agent.slug,
                        goal=agent.goal,
                        kind_key=planned.kind_key,
                        subscribed_kinds=list(agent.subscribed_kinds),
                        write_scope=list(agent.write_scope),
                        context=scoped,
                    ),
                    id=specialist_workflow_id(
                        self._input.consultation_id, agent.agent_id, decision.plan_id
                    ),
                    # Both policies explicit, for the reasons TASK-662 §4.3
                    # measured: the SDK default close policy would HARD-KILL a
                    # child mid-run, and the default cancellation type left the
                    # parent RUNNING forever after a cancel.
                    parent_close_policy=workflow.ParentClosePolicy.REQUEST_CANCEL,
                    cancellation_type=workflow.ChildWorkflowCancellationType.TRY_CANCEL,
                )
            except ChildWorkflowError as exc:
                if is_cancelled_exception(exc):
                    raise asyncio.CancelledError from exc
                # One specialist failing is ISOLATED — that is the whole reason
                # specialists are children. The run degrades and continues; the
                # other reviewers still contribute.
                self._specialist_failures += 1
                self._degraded = True
                await self._emit_event(
                    LOOP_EVENT_SPECIALIST_FAILED, action=agent.agent_id
                )
                continue

            results.append(result)

        return results

    async def _adjudicate(
        self,
        config: ConsultationLoopConfig,
        decision: PlanDecision,
        results: list[SpecialistResult],
    ) -> None:
        """The PRIMARY reconciles the specialists' findings into one record.

        Two enforcement steps happen before reconciliation, in this order:

        1. **Write-scope enforcement, in the orchestrator.** Every finding is
           re-checked against its own agent's ``writeScope``. The specialist
           checked too, but that check is inside the agent's own execution and
           therefore not a boundary — this one is (TASK-654 §4.6).
        2. **The primary-only floor.** ``note`` and ``gate`` are refused for any
           specialist whatever its configured scope says, so a tenant cannot
           misconfigure away the primary's exclusive ownership (D7).

        Both are folded into ``LoopAgentSpec.may_write``. A refusal is RECORDED,
        never silent.
        """
        by_id = {agent.agent_id: agent for agent in config.agents}
        filtered: list[SpecialistResult] = []
        dropped: list[str] = []

        for result in results:
            agent = by_id.get(result.agent_id)
            if agent is None:  # pragma: no cover - dispatch already resolved it
                continue
            kept = [f for f in result.findings if agent.may_write(f.output_kind)]
            for finding in result.findings:
                if not agent.may_write(finding.output_kind):
                    dropped.append(f"{result.agent_id}:{finding.output_kind}")
            for refused in result.out_of_scope_findings:
                entry = f"{result.agent_id}:{refused}"
                if entry not in dropped:
                    dropped.append(entry)
            filtered.append(
                SpecialistResult(
                    agent_id=result.agent_id,
                    plan_id=result.plan_id,
                    kind_key=result.kind_key,
                    findings=kept,
                    out_of_scope_findings=result.out_of_scope_findings,
                    degraded=result.degraded,
                )
            )

        # PURE, and deliberately so: adjudication runs in the workflow body, so
        # anything non-deterministic here would break replay (C1).
        record = adjudicate(
            self._input.consultation_id,
            decision.plan_id,
            filtered,
            dropped_out_of_scope=dropped,
        )

        await workflow.execute_activity(
            record_adjudication,
            RecordAdjudicationInput(
                consultation_id=self._input.consultation_id,
                tenant_id=self._input.tenant_id,
                record=record,
            ),
            start_to_close_timeout=_LOOP_EVENT_TIMEOUT,
            schedule_to_close_timeout=_LOOP_EVENT_TIMEOUT,
            retry_policy=_LOOP_EVENT_RETRY,
        )

    # -- checkpointing -----------------------------------------------------

    def _should_checkpoint(self) -> bool:
        """True when this execution should hand over to a fresh one.

        Temporal's hard ceilings are 51,200 events and 50 MB of history; a
        long consultation with hundreds of context items would march toward
        both. Checkpointing is therefore PLANNED — it happens at a quiet moment
        (nothing pending, not ending, not cancelled, no child in flight) and
        well below the ceilings, rather than being forced at whatever point the
        limit happens to be hit.
        """
        if self._pending or self._ending or self._cancelled or self._finalized:
            return False
        if self._accepted_this_run >= self._input.checkpoint_signal_threshold:
            return True
        info = workflow.info()
        return (
            info.is_continue_as_new_suggested()
            or info.get_current_history_length() >= self._input.checkpoint_history_events
        )

    def _checkpoint_input(self) -> ConsultationLoopWorkflowInput:
        """The next execution's input: everything that must survive the handover."""
        return ConsultationLoopWorkflowInput(
            consultation_id=self._input.consultation_id,
            tenant_id=self._input.tenant_id,
            user_id=self._input.user_id,
            correlation_id=self._input.correlation_id,
            session_id=self._input.session_id,
            # The pin travels with the run. This single line is what stops a
            # checkpoint from silently re-resolving a tenant's config mid-consultation.
            pinned_config=self._config,
            checkpoint_signal_threshold=self._input.checkpoint_signal_threshold,
            checkpoint_history_events=self._input.checkpoint_history_events,
            carried_seen_keys=list(self._seen_keys),
            carried_pending=list(self._pending),
            carried_events_processed=self._events_processed,
            carried_duplicates_ignored=self._duplicates_ignored,
            carried_depth_capped=self._depth_capped,
            carried_actions_dispatched=self._actions_dispatched,
            carried_degraded=self._degraded,
            carried_livedoc_started=self._livedoc_started,
            carried_start_actions_done=self._start_actions_done,
            carried_continuations=self._continuations + 1,
            replan_interval_events=self._input.replan_interval_events,
            carried_agent_kind_seen=list(self._agent_kind_seen),
            carried_plans_made=self._plans_made,
            carried_specialists_run=self._specialists_run,
            carried_specialist_failures=self._specialist_failures,
            carried_cycles_suppressed=self._cycles_suppressed,
            carried_derived_context=self._derived_context,
        )

    def _result(self) -> ConsultationLoopWorkflowResult:
        config = self._config
        return ConsultationLoopWorkflowResult(
            consultation_id=self._input.consultation_id,
            config_pinned=config is not None,
            enabled=bool(config and config.enabled),
            events_processed=self._events_processed,
            duplicates_ignored=self._duplicates_ignored,
            depth_capped=self._depth_capped,
            actions_dispatched=self._actions_dispatched,
            degraded=self._degraded,
            cancelled=self._cancelled,
            finalized=self._finalized,
            finalize_workflow_id=self._finalize_workflow_id,
            continuations=self._continuations,
            plans_made=self._plans_made,
            specialists_run=self._specialists_run,
            specialist_failures=self._specialist_failures,
            cycles_suppressed=self._cycles_suppressed,
            derived_context=self._derived_context,
        )
