"""Temporal workflows.

Workflow code MUST be deterministic: no direct I/O, no wall-clock/random access,
no non-deterministic imports at module top-level. All side effects are delegated
to Activities. This mirrors the TASK-330 design constraint where the harness
loop body is a deterministic workflow and guides/generate/sensors are Activities.
"""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from harness.services.api_client import AssembleResponse, DraftResponse
    from harness.services.sensor_runner import SensorRunOutput
    from harness.services.smr_client import SmrGenerationResult

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
        call_mcp_tool,
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
        retract_draft,
        retrieve_context,
        run_inferential_sensors,
        run_sensors,
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
        ApprovalSignal,
        AssembleInput,
        CallMcpToolInput,
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
        McpServerConfig,
        PersistDraftInput,
        PersistEntitiesInput,
        RecordGateInput,
        RegenFeedback,
        ReportProgressInput,
        RetractDraftInput,
        RetrieveContextInput,
        RetrievedContext,
        RunInferentialSensorsInput,
        RunSensorsInput,
        TrajectoryContext,
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
        # TASK-483: OPTIONAL claim-check ref for an offloaded edited note (apps/api-facing
        # seam; None until a future caller sends the edit by ref). Threaded, with
        # ``_edited_content``, into the assurance pass's note_text/note_text_ref.
        self._edited_content_ref: ClaimCheckRef | None = None
        self._edited_version_id: str | None = None

    def _next_seq(self) -> int:
        """Allocate the next monotonic trajectory-seq BASE (strided; deterministic)."""
        seq = self._seq
        self._seq += _SEQ_STRIDE
        return seq

    def _traj(
        self, inp: HarnessDocWorkflowInput, *, is_regen: bool = False
    ) -> TrajectoryContext:
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
        self._edited_content_ref = payload.content_ref
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
        # A failed fetch degrades to the code defaults — never crash the loop. C1-06
        # (TASK-458): an UNREACHABLE policy endpoint can silently RELAX a stricter tenant
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
                FetchPolicyInput(tenant_id=inp.tenant_id, trajectory=self._traj(inp)),
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
                gate_sla_seconds=policy.gate_sla_seconds,
                gate_escalation_seconds=policy.gate_escalation_seconds,
                # TASK-355 Phase D (R-7): the optimistic kill-switch is snapshotted at
                # workflow start (document:start -> input). (Phase 3A) makes it a
                # policy-overridable knob: the effective policy value wins WHEN NON-NULL,
                # else the input-snapshotted default governs (per-field fallthrough, same
                # rationale as ``smr_provider``). Both are read from deterministic
                # workflow state (never env) ⇒ replay-safe; no new command / patch marker.
                optimistic_delivery_enabled=(
                    policy.optimistic_delivery_enabled
                    if policy.optimistic_delivery_enabled is not None
                    else inp.gate.optimistic_delivery_enabled
                ),
                # C1-02 (TASK-458): the gate/edit safety bounds are loop-safety knobs.
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
            # TASK-357: snapshot the PHI egress policy alongside the other guard
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
            # TASK-357: no policy ⇒ the fail-closed code defaults govern the guard.
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
        # TASK-480 Half-B — NER-priors reuse: seed the transcript pass with
        # ``reuse_priors`` + the ids so the (non-deterministic) activity MAY reuse
        # already-persisted CODED NamedEntity rows (TASK-476) instead of re-extracting
        # cold — killing the redundant second NER pass. This is a DATA-ONLY activity
        # input (the reuse/flag/code logic + apps/api read all live in the activity), so
        # it adds no new workflow command and needs no ``workflow.patched()``: an old
        # replay history schedules ``extract_entities`` exactly as before, and its
        # recorded result deserializes ``reused=False`` (cold-path semantics). The
        # activity falls back to the cold extraction when the flag is off / priors are
        # absent / none carry a code, so this is inert until TASK-476 lands.
        self._phase = "EXTRACT"
        degraded = False
        priors_reused = False
        transcript_entities: list[NEREntity] = []
        try:
            extracted = await workflow.execute_activity(
                extract_entities,
                ExtractEntitiesInput(
                    text=inp.transcript_text,
                    # TASK-483: thread the (future) transcript ref; the activity resolves
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
        # already-persisted coded priors (TASK-480), the rows already exist — skip the
        # redundant re-persist. Data-driven skip (``priors_reused`` reconstructs from the
        # recorded activity result: False for every pre-TASK-480 history) ⇒ replay-safe,
        # no ``workflow.patched()``; mirrors the existing ``if transcript_entities:``
        # data-driven guard right beside it.
        if transcript_entities and not priors_reused:
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
        if (
            mcp_tools_enabled
            and transcript_entities
            and workflow.patched("task-516-mcp-tools")
        ):
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

        # 1b) Institutional RAG (Phase 3, flag-gated). JIT hybrid retrieval is
        # entity-triggered and stable across regens, so it runs ONCE here (before the
        # loop) and the prompt is augmented with the cited chunks each iteration. A
        # degraded retrieval (backend down) yields an empty context and flags reduced
        # assurance; it never raises into the loop.
        self._phase = "RETRIEVE"
        # Progress stage 2 covers institutional retrieval + prompt assembly.
        await self._report_progress(inp, "assembling_context")
        # C1-06: seed reduced assurance from the policy-fetch degrade (a relaxed stricter
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
        # TASK-483: per-chunk claim-check refs for any offloaded chunk texts; the
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
        # the prior iteration's critique, threaded into the next regen's
        # generate call (None on the first iteration ⇒ byte-identical prompt).
        regen_feedback: RegenFeedback | None = None
        guardrail_decisions: dict[str, Any] = {}
        rag_triad_score: float | None = None
        # TASK-359 WS-1 — workflow-threaded, data-only per-claim verdict cache (L2). Carried
        # from one inferential pass's OUTPUT into the next pass's INPUT so a regen re-judges only
        # changed claims (unchanged claims reuse the byte-identical cached verdict, AC-2). DATA
        # flow only — adds no new command, needs no ``workflow.patched()``; reconstructed
        # deterministically from recorded activity outputs on replay (old histories ⇒ {}, T8).
        verdict_cache: dict[str, bool] = {}
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
                    trajectory=self._traj(inp),
                ),
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_API_RETRY,
            )
            # TASK-483: the retrieved Knowledge Context (StrictCitations) block + the
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
                        # TASK-483: thread the offloaded-note ref (None ⇒ inline note).
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
                    # TASK-483: thread the offloaded note + (future) transcript refs.
                    note_text_ref=generated.content_ref,
                    transcript_text=inp.transcript_text,
                    transcript_text_ref=inp.transcript_ref,
                    note_entities=note_entities,
                    transcript_entities=transcript_entities,
                    response_format=assembled.response_format,
                    transcript_context_item_id=inp.context_item_id,
                    retrieved_chunk_ids=retrieved_chunk_ids,
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
            if comp_verdict.decision == GateDecision.REGEN and regens_used < gate.max_regen:
                # capture the failed computational sensors as the next
                # iteration's corrective critique (gated on regenFeedbackEnabled).
                regen_feedback = build_regen_feedback(sensors.results, enabled=regen_feedback_enabled)
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
                        # TASK-483: thread the offloaded note + transcript + chunk refs.
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
                        # TASK-359 WS-1 — carry the prior passes' verdicts so unchanged
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
                # TASK-359 WS-1 — thread this pass's populated verdict cache into the next.
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
            if verdict.decision == GateDecision.REGEN and regens_used < gate.max_regen:
                # critique from the full (computational + inferential)
                # sensor pass for the next regen iteration.
                regen_feedback = build_regen_feedback(
                    list(sensors.results) + inferential_results,
                    enabled=regen_feedback_enabled,
                )
                regens_used += 1
                continue
            break

        # 3) Persist the draft + record the gate verdict. Two shapes, by flag:
        if use_optimistic:
            # TASK-355 Phase D — OPTIMISTIC two-phase delivery. Two nested helpers keep
            # the loop body readable AND keep the replay-critical computational/legacy
            # loop above DELIBERATELY UNTOUCHED (Slice-4b re-delivery + regen mirror it
            # here rather than re-entering it). Both close over the pre-loop locals.
            async def _deliver_early(
                gen_: SmrGenerationResult,
                sens_: SensorRunOutput,
                asm_: AssembleResponse,
                reduced_: bool,
            ) -> DraftResponse:
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
                        # TASK-483: thread the offloaded-note ref (activity resolves before POST).
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
                        trajectory=self._traj(inp),
                    ),
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_API_RETRY,
                )

            async def _regen_compute() -> tuple[
                AssembleResponse, SmrGenerationResult, SensorRunOutput, bool
            ]:
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
                        trajectory=self._traj(inp),
                    ),
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_API_RETRY,
                )
                # TASK-483: thread the (offloaded) prompt refs + RAG block to generate
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
                        # Q1 branch before this helper runs; None ⇒ byte-identical).
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
            # TASK-483: the offloaded-note ref companion to ``assurance_content`` (threaded
            # to the assurance pass's note_text_ref). Re-bound alongside the content below.
            assurance_content_ref = generated.content_ref
            assurance_version_id: str | None = None
            # C1-02 (TASK-458): count edit-driven re-runs so a burst of clinician edits
            # cannot drive an unbounded number of costly inferential passes (patch-gated).
            edit_reruns = 0
            while True:
                # Consume a pending edit (arrived before/between passes): re-bind the
                # assurance target to the edited version, then clear the per-pass latch.
                if signals_enabled and self._edited:
                    # TASK-483: re-bind to the edited note (inline or offloaded ref); an
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
                            # TASK-483: thread the offloaded note + transcript + chunk refs.
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
                            # TASK-355 Phase D Slice 5d (Q5) — the optimistic ASSURANCE
                            # pass streams each claim verdict live to apps/api as it
                            # resolves (data-only activity-input fields; the activity
                            # publishes best-effort, never on replay). The legacy pass
                            # (line ~468) leaves these unset and stays silent.
                            live_assurance=True,
                            consultation_id=inp.consultation_id,
                            tenant_id=inp.tenant_id,
                            job_id=inp.job_id,
                            # TASK-359 WS-1 — carry prior verdicts across assurance regen
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

                # Q3: an edit landed DURING this pass — the verdict is stale. Re-run
                # assurance on the edited version, but CAP the re-runs (C1-02) so N rapid
                # edits can't drive N costly passes. Patch-gated: pre-458 histories (no
                # marker) keep the uncapped command sequence on replay. Beyond the cap,
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
                    # TASK-359 WS-1 — thread this pass's populated verdict cache into the next.
                    verdict_cache = inferential.verdict_cache
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
                    # critique from the settled verdict feeds the Q1 regen.
                    regen_feedback = build_regen_feedback(
                        list(sensors.results) + inferential_results,
                        enabled=regen_feedback_enabled,
                    )
                    regens_used += 1
                    assembled, generated, sensors, regen_degraded = await _regen_compute()
                    if regen_degraded:
                        degraded = True
                    draft = await _deliver_early(
                        generated, sensors, assembled, reduced_assurance
                    )
                    assurance_content = generated.content
                    # TASK-483: keep the ref companion in lockstep with the re-generated note.
                    assurance_content_ref = generated.content_ref
                    continue
                break
            decision = str(verdict.decision)

            # (c) RETRACT-or-FINALIZE (TASK-481 E2 — the optimistic-delivery retraction net).
            #     The optimistic path delivered a READABLE draft BEFORE assurance (the
            #     clinician can already be reading it — and, per the ACCEPTED TASK-453
            #     pre-assurance window, may already have signed). When the post-delivery
            #     assurance settles to a FLAG, the delivered draft is RETRACTED (apps/api
            #     marks it RETRACTED + writes the WORM audit carrying the FLAG verdict + the
            #     offending claim refs + surfaces a clinician-facing retraction event)
            #     INSTEAD of silently backfilling the FLAG verdict via finalize — the
            #     explicit safety net that makes the accepted window safe (E2 does NOT change
            #     the TASK-453 sign-off governance). Patch-gated: a pre-E2 optimistic history
            #     has no marker, so ``workflow.patched`` returns False on replay and the
            #     legacy finalize-only command sequence is preserved (replay-safe). A
            #     non-FLAG verdict finalizes exactly as before.
            if workflow.patched("task-481-optimistic-retraction") and (
                verdict.decision == GateDecision.FLAG
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
                # skipped (patch-gated, so a pre-E2 replay keeps the legacy gate flow).
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
                    # TASK-483: thread the offloaded-note ref (activity resolves before POST).
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
        # C1-02 (TASK-458): bound the escalation loop with a TERMINAL abandon so an
        # un-signed gate cannot escalate forever (was: re-fire ``escalate_gate`` every
        # ``gate_escalation_seconds`` with no max). Patch-gated — a pre-458 history has no
        # marker, so ``workflow.patched`` returns False on replay and the legacy
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
                # apps/api can mark the gate abandoned (via the C1-05 escalation record).
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
                    break  # C1-02: terminal bound hit → abandon (handled just below)

        approval = self._approval
        # C1-02: the loop can now exit WITHOUT approval — only via the terminal-bound
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
