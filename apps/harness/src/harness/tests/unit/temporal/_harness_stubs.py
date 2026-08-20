"""Programmable stub activities for HarnessDocWorkflow tests.

Replace every real activity (same registered name) with a deterministic stub so
the workflow tests exercise pure orchestration — bounded regen, the gate
wait-condition + SLA escalation, and the degradation paths — without any
network/NLP/Text I/O. Not collected by pytest (does not match ``test_*``).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from datetime import timedelta

from temporalio import activity
from temporalio.exceptions import ApplicationError

from harness.guides.retrieval.prompt import build_strict_citations_block
from harness.guides.retrieval.retriever import RetrievedChunk
from harness.redaction.engine import RedactionManifest
from harness.sensors.base import NEREntity, SensorResult
from harness.sensors.inferential import GROUNDEDNESS_NAME, SAFETY_NAME
from harness.sensors.inferential.base import degraded_result
from harness.sensors.registry import COMPUTATIONAL_SENSOR_NAMES
from harness.services.api_client import (
    AssembleResponse,
    DraftResponse,
    FinalizeAssuranceResponse,
    PersistEntitiesResponse,
    RecordGateResponse,
    RetractDraftResponse,
)
from harness.services.sensor_runner import SensorRunOutput
from harness.services.text_client import TextGenerationResult
from harness.temporal.claim_check import ClaimCheckRef
from harness.temporal.models import (
    ApplyRedactionInput,
    ApplyRedactionResult,
    AssembleInput,
    CallMcpToolInput,
    EditSignal,
    EntitiesResult,
    EscalateInput,
    EscalateResult,
    ExtractEntitiesInput,
    FetchPolicyInput,
    FinalizeAssuranceInput,
    GenerateInput,
    HarnessPolicy,
    InferentialRunOutput,
    McpToolCallResult,
    PersistDraftInput,
    PersistEntitiesInput,
    RecordGateInput,
    ReportProgressInput,
    ReportProgressResult,
    RetractDraftInput,
    RetrieveContextInput,
    RetrievedContext,
    RunInferentialSensorsInput,
    RunSensorsInput,
    SegmentCitationRef,
)

_OK_NOTE = '{"subjective": "s", "objective": "o", "assessment": "a", "plan": "p"}'


def _stub_ref(name: str) -> ClaimCheckRef:
    """A dummy claim-check ref for the offloaded-payload replay fixture.

    Replay never dereferences it (activities are not re-run on replay — the recorded
    result is fed back), so the key/sha need only be well-formed, not resolvable.
    """
    return ClaimCheckRef(
        store="memory", bucket="harness-claim-check", key=f"stub-{name}", size=1, sha256="0" * 64
    )


@dataclass
class StubConfig:
    """Per-scenario behaviour for the stub activity set."""

    verdicts: list[str] = field(default_factory=lambda: ["PASS"])
    nlp_fails: bool = False
    generate_fails: bool = False
    # Makes ``persist_draft`` raise so the workflow reaches the failure-terminal path
    # AFTER the inferential pass has run. Used to capture a replay-fixture history that
    # exercises BOTH patch gates and includes the ``run_inferential_sensors`` command
    # for the replay-compat suite.
    persist_draft_fails: bool = False
    note_content: str = _OK_NOTE
    # Inferential pass (Phase 2): one kind per ``run_inferential_sensors`` invocation
    # (clamped to the last when there are more invocations than entries). Kinds:
    # "SAFE" (groundedness + safety pass), "UNSAFE" (safety FLAG), "REGEN"
    # (groundedness regen-fixable), "DEGRADED" (backend unavailable -> reduced
    # assurance). ``inferential_fails`` makes the activity raise (infra failure).
    inferential_verdicts: list[str] = field(default_factory=lambda: ["SAFE"])
    inferential_fails: bool = False
    # Phase-3 retrieval: chunks the ``retrieve_context`` stub returns as (id, text);
    # ``retrieval_degraded`` simulates a backend outage -> reduced assurance.
    retrieved_chunks: list[tuple[str, str]] = field(default_factory=list)
    retrieval_degraded: bool = False
    # Phase-6 policy injection: the policy the ``fetch_policy`` stub returns. ``None``
    # makes the stub raise (endpoint unavailable) so the workflow degrades to the
    # code defaults — i.e. unchanged Phase 1-3 behaviour for the existing tests.
    policy: HarnessPolicy | None = None
    # Progress feed: make the ``report_progress`` stub raise (progress
    # pipeline down) — the workflow must shrug it off and complete normally.
    progress_fails: bool = False
    # Make the TRANSCRIPT ``extract_entities`` stub return
    # ``reused=True`` (simulating CODED priors available) so tests can assert the
    # workflow SKIPS the redundant ``persist_entities``. The note-NER calls
    # (reuse_priors=False) always return reused=False. Default False ⇒ the cold path.
    reuse_transcript_priors: bool = False
    # F-12 — makes the ``persist_entities`` stub raise (non-retryable) so tests can
    # assert the workflow degrades to safe (logs + continues without persisted NER
    # priors) instead of failing the whole run when this priors-only write is
    # exhausted.
    persist_entities_fails: bool = False
    # Claim-check: make the ``generate`` + ``assemble_prompt`` stubs return
    # OFFLOADED results (inline emptied + a ClaimCheckRef) so the captured history carries
    # the ref-threaded (new-run) command sequence for the replay-compat fixture. The
    # command sequence is identical to the inline happy path — only the payloads differ.
    claim_check: bool = False
    # MCP terminology validation. When the policy arms the
    # (patch-gated) MCP path, the ``call_mcp_tool`` stub returns this outcome —
    # ``mcp_degraded`` drives the workflow to reduced assurance; ``mcp_fails`` makes
    # the activity raise (allowlist/PHI/infra) which the workflow degrades on.
    mcp_degraded: bool = False
    mcp_fails: bool = False
    # PHI-safe segment citation refs returned by ``assemble_prompt``.
    # Empty (default) ⇒ GenerateInput.segment_citations stays empty (byte-identical
    # prompt). Non-empty ⇒ workflow must thread them into both GenerateInput sites.
    segment_citations: list[SegmentCitationRef] = field(default_factory=list)
    # Redaction. The ``apply_redaction`` stub returns
    # ``redaction_text`` (changed=True) when set, else echoes the input note
    # (changed=False). ``redaction_failed_closed`` makes it report a fail-closed
    # transform (the workflow forces a FLAG). Only exercised when the start payload
    # carries ``redaction_rules`` (otherwise the workflow never calls the activity).
    redaction_text: str | None = None
    redaction_failed_closed: bool = False


@dataclass
class StubRecorder:
    """Captures what the workflow drove (call counts + payloads)."""

    calls: Counter = field(default_factory=Counter)
    # Ordered call trace so tests can assert the optimistic REORDER (early persist
    # BEFORE the inferential pass, "completed" progress BEFORE assurance, finalize
    # AFTER). Progress entries are ``progress:<stage>``; activities are recorded by name.
    call_order: list[str] = field(default_factory=list)
    fetch_policy_inputs: list[FetchPolicyInput] = field(default_factory=list)
    # The ExtractEntitiesInput of each extract pass (transcript then
    # note), so tests can assert the transcript pass carried reuse_priors + the ids.
    extract_entities_inputs: list[ExtractEntitiesInput] = field(default_factory=list)
    persist_entities_inputs: list[PersistEntitiesInput] = field(default_factory=list)
    persist_draft_inputs: list[PersistDraftInput] = field(default_factory=list)
    # The finalize_assurance payloads (optimistic path).
    finalize_inputs: list[FinalizeAssuranceInput] = field(default_factory=list)
    # The retract_draft payloads (optimistic FLAG -> retraction net).
    retract_inputs: list[RetractDraftInput] = field(default_factory=list)
    record_inputs: list[RecordGateInput] = field(default_factory=list)
    escalate_inputs: list[EscalateInput] = field(default_factory=list)
    inferential_inputs: list[RunInferentialSensorsInput] = field(default_factory=list)
    # the CallMcpToolInput of each MCP terminology validation call.
    call_mcp_inputs: list[CallMcpToolInput] = field(default_factory=list)
    retrieve_inputs: list[RetrieveContextInput] = field(default_factory=list)
    generate_inputs: list[GenerateInput] = field(default_factory=list)
    run_sensors_inputs: list[RunSensorsInput] = field(default_factory=list)
    # The ApplyRedactionInput of each redaction pass.
    apply_redaction_inputs: list[ApplyRedactionInput] = field(default_factory=list)
    progress_inputs: list[ReportProgressInput] = field(default_factory=list)
    # The schedule_to_close_timeout each report_progress
    # emission was scheduled with (None = unbounded queue wait).
    progress_schedule_to_close: list[timedelta | None] = field(default_factory=list)
    # Edit-injection hook. To test the signal-driven
    # edit-during-assurance path (Q3) deterministically with instant stubs, the
    # run_inferential_sensors stub fires an ``edit`` signal back at the running
    # workflow from INSIDE its Nth invocation — so the signal lands while that
    # assurance pass is in flight, exactly the race the workflow must handle. The
    # test sets the handle (built from the known workflow id, pre-start) + the
    # 0-based invocation index to inject on + the payload.
    edit_signal_handle: object | None = None
    edit_on_inferential_index: int | None = None
    # Inject an edit on EACH of these inferential invocations (a set of
    # 0-based indices) so the edit-rerun CAP can be exercised — N edits across N passes.
    edit_on_inferential_indices: set[int] | None = None
    edit_payload: EditSignal | None = None


def _ok(name: str) -> SensorResult:
    return SensorResult(name=name, score=1.0, passed=True)


def _results_for(kind: str) -> list[SensorResult]:
    """Build a 5-sensor result list that aggregates to ``kind``."""
    if kind == "PASS":
        return [_ok(n) for n in COMPUTATIONAL_SENSOR_NAMES]
    if kind == "REGEN":
        # coverage_omission (regen-fixable) fails, names a target section.
        return [
            _ok("entity_faithfulness"),
            SensorResult(
                name="coverage_omission",
                score=0.5,
                passed=False,
                claims_flagged=["omitted-dx"],
                details={"sections": ["O"]},
            ),
            _ok("schema_validity"),
            _ok("citation_presence"),
            _ok("numeric_dose"),
        ]
    if kind == "FLAG":
        # entity_faithfulness (highest-harm) fails -> escalate to clinician.
        return [
            SensorResult(
                name="entity_faithfulness", score=0.0, passed=False, claims_flagged=["warfarin"]
            ),
            _ok("coverage_omission"),
            _ok("schema_validity"),
            _ok("citation_presence"),
            _ok("numeric_dose"),
        ]
    raise ValueError(f"unknown verdict kind: {kind}")


def _inferential_for(kind: str) -> InferentialRunOutput:
    """Build an inferential pass output that drives the workflow's final aggregate."""
    if kind == "SAFE":
        results = [
            SensorResult(name=GROUNDEDNESS_NAME, score=1.0, passed=True),
            SensorResult(name=SAFETY_NAME, score=1.0, passed=True),
        ]
        return InferentialRunOutput(
            results=results,
            guardrail_decisions={
                GROUNDEDNESS_NAME: {"decision": "PASS", "passed": True},
                SAFETY_NAME: {"decision": "PASS", "passed": True, "dimensions": {"harm": False}},
            },
            rag_triad_score=1.0,
            degraded=False,
        )
    if kind == "UNSAFE":
        # safety (highest-harm) fails -> always FLAG, never auto-regen.
        results = [
            SensorResult(name=GROUNDEDNESS_NAME, score=1.0, passed=True),
            SensorResult(
                name=SAFETY_NAME,
                score=0.0,
                passed=False,
                claims_flagged=["violence"],
                details={"unsafe": True, "flagged_dimensions": ["violence"]},
            ),
        ]
        return InferentialRunOutput(
            results=results,
            guardrail_decisions={
                GROUNDEDNESS_NAME: {"decision": "PASS", "passed": True},
                SAFETY_NAME: {
                    "decision": "FLAG",
                    "passed": False,
                    "unsafe": True,
                    "flaggedDimensions": ["violence"],
                },
            },
            rag_triad_score=1.0,
            degraded=False,
        )
    if kind == "REGEN":
        # groundedness (regen-fixable) fails, names the Plan section.
        results = [
            SensorResult(
                name=GROUNDEDNESS_NAME,
                score=0.5,
                passed=False,
                claims_flagged=["c-ungrounded"],
                details={"sections": ["P"], "ungrounded": ["c-ungrounded"]},
            ),
            SensorResult(name=SAFETY_NAME, score=1.0, passed=True),
        ]
        return InferentialRunOutput(
            results=results,
            guardrail_decisions={
                GROUNDEDNESS_NAME: {"decision": "REGEN", "passed": False, "sections": ["P"]},
                SAFETY_NAME: {"decision": "PASS", "passed": True},
            },
            rag_triad_score=0.5,
            degraded=False,
        )
    if kind == "DEGRADED":
        # Both inferential backends down -> degraded -> reduced assurance.
        results = [
            degraded_result(GROUNDEDNESS_NAME, "judge offline"),
            degraded_result(SAFETY_NAME, "granite offline"),
        ]
        return InferentialRunOutput(
            results=results,
            guardrail_decisions={
                GROUNDEDNESS_NAME: {"decision": "DEGRADED", "degraded": True},
                SAFETY_NAME: {"decision": "DEGRADED", "degraded": True},
            },
            rag_triad_score=None,
            degraded=True,
        )
    raise ValueError(f"unknown inferential kind: {kind}")


def make_stub_activities(config: StubConfig, recorder: StubRecorder) -> list:
    """Build the full set of name-matched stub activities."""

    @activity.defn(name="fetch_policy")
    async def fetch_policy(payload: FetchPolicyInput) -> HarnessPolicy:
        recorder.calls["fetch_policy"] += 1
        recorder.fetch_policy_inputs.append(payload)
        if config.policy is None:
            # No policy configured -> simulate an unreachable endpoint so the
            # workflow degrades to the code defaults (the fail-safe path).
            raise ApplicationError("policy endpoint unavailable", non_retryable=True)
        return config.policy

    @activity.defn(name="extract_entities")
    async def extract_entities(payload: ExtractEntitiesInput) -> EntitiesResult:
        recorder.calls["extract_entities"] += 1
        recorder.extract_entities_inputs.append(payload)
        if config.nlp_fails:
            raise ApplicationError("nlp unavailable", non_retryable=True)
        # Only the transcript pass (reuse_priors=True) can reuse; the
        # note-NER calls stay cold. Models the real activity's contract at the workflow
        # boundary (the apps/api load + code gate is covered in test_activities).
        reused = bool(config.reuse_transcript_priors and payload.reuse_priors)
        return EntitiesResult(
            entities=[NEREntity(text="hypertension", type="DISEASE", start=0, end=12)],
            reused=reused,
        )

    @activity.defn(name="call_mcp_tool")
    async def call_mcp_tool(payload: CallMcpToolInput) -> McpToolCallResult:
        recorder.calls["call_mcp_tool"] += 1
        recorder.call_order.append("call_mcp_tool")
        recorder.call_mcp_inputs.append(payload)
        if config.mcp_fails:
            raise ApplicationError("mcp tool unavailable", non_retryable=True)
        return McpToolCallResult(
            ok=not config.mcp_degraded,
            server=payload.server.name,
            tool=payload.tool,
            content="" if config.mcp_degraded else '{"valid": true}',
            degraded=config.mcp_degraded,
            error_code="server_error" if config.mcp_degraded else None,
        )

    @activity.defn(name="persist_entities")
    async def persist_entities(payload: PersistEntitiesInput) -> PersistEntitiesResponse:
        recorder.calls["persist_entities"] += 1
        recorder.persist_entities_inputs.append(payload)
        if config.persist_entities_fails:
            raise ApplicationError("persist_entities unavailable", non_retryable=True)
        n = len(payload.entities)
        return PersistEntitiesResponse(saved_count=n, entity_ids=[f"e{i}" for i in range(n)])

    @activity.defn(name="assemble_prompt")
    async def assemble_prompt(payload: AssembleInput) -> AssembleResponse:
        recorder.calls["assemble_prompt"] += 1
        # On the claim-check fixture, return the prompts OFFLOADED (inline
        # emptied + refs) so the captured history threads the ref shape.
        user_prompt, user_ref = ("", _stub_ref("uprompt")) if config.claim_check else ("U", None)
        system_prompt, system_ref = (
            ("", _stub_ref("sprompt")) if config.claim_check else ("S", None)
        )
        return AssembleResponse(
            user_prompt=user_prompt,
            user_prompt_ref=user_ref,
            system_prompt=system_prompt,
            system_prompt_ref=system_ref,
            hyperparameters={"temperature": 0.2, "max_tokens": 1024},
            response_format={
                "type": "json_schema",
                "json_schema": {"type": "object"},
                "strict": True,
            },
            prompt_template_id="tmpl-1",
            prompt_version="3",
            resolved_from="department",
            # thread configured refs (default []) so workflow tests
            # can assert GenerateInput.segment_citations is populated from assemble.
            segment_citations=list(config.segment_citations),
        )

    @activity.defn(name="retrieve_context")
    async def retrieve_context(payload: RetrieveContextInput) -> RetrievedContext:
        recorder.calls["retrieve_context"] += 1
        recorder.retrieve_inputs.append(payload)
        chunks = [RetrievedChunk(chunk_id=cid, text=txt) for cid, txt in config.retrieved_chunks]
        return RetrievedContext(
            chunks=chunks,
            degraded=config.retrieval_degraded,
            prompt_block=build_strict_citations_block(chunks),
        )

    @activity.defn(name="generate")
    async def generate(payload: GenerateInput) -> TextGenerationResult:
        recorder.calls["generate"] += 1
        recorder.generate_inputs.append(payload)
        if config.generate_fails:
            raise ApplicationError("text unavailable", non_retryable=True)
        # On the claim-check fixture, return the note OFFLOADED (content emptied
        # + ref) so the captured history threads content_ref to the downstream activities.
        content, content_ref = (
            ("", _stub_ref("note")) if config.claim_check else (config.note_content, None)
        )
        return TextGenerationResult(
            content=content,
            content_ref=content_ref,
            model="gpt-4o",
            provider="azure-openai",
            usage={"total_tokens": 40},
            latency_ms=10,
            finish_reason="stop",
        )

    @activity.defn(name="run_sensors")
    async def run_sensors(payload: RunSensorsInput) -> SensorRunOutput:
        i = recorder.calls["run_sensors"]
        recorder.calls["run_sensors"] += 1
        recorder.run_sensors_inputs.append(payload)
        kind = config.verdicts[min(i, len(config.verdicts) - 1)]
        results = _results_for(kind)
        return SensorRunOutput(
            results=results,
            citations_map={"claims": [{"id": "c1", "evidence": [{"quote": "x"}]}]},
            scores={r.name: r.score for r in results},
            soap_sections={},
        )

    @activity.defn(name="run_inferential_sensors")
    async def run_inferential_sensors(payload: RunInferentialSensorsInput) -> InferentialRunOutput:
        i = recorder.calls["run_inferential_sensors"]
        recorder.calls["run_inferential_sensors"] += 1
        recorder.call_order.append("run_inferential_sensors")
        recorder.inferential_inputs.append(payload)
        # Fire a clinician EDIT back at the workflow DURING this
        # assurance pass (the signal is recorded mid-activity, so it is buffered and
        # delivered when the workflow resumes after this activity completes —
        # deterministic on replay). Drives the Q3 re-bind/re-run path.
        _inject_edit = recorder.edit_on_inferential_index == i or (
            recorder.edit_on_inferential_indices is not None
            and i in recorder.edit_on_inferential_indices
        )
        if (
            recorder.edit_signal_handle is not None
            and recorder.edit_payload is not None
            and _inject_edit
        ):
            await recorder.edit_signal_handle.signal("edit", recorder.edit_payload)
        if config.inferential_fails:
            raise ApplicationError("inferential pass unavailable", non_retryable=True)
        kind = config.inferential_verdicts[min(i, len(config.inferential_verdicts) - 1)]
        return _inferential_for(kind)

    @activity.defn(name="apply_redaction")
    async def apply_redaction(payload: ApplyRedactionInput) -> ApplyRedactionResult:
        # DNA redaction/rewrite. Returns the configured redacted
        # text (changed) or echoes the note (no change); ``redaction_failed_closed``
        # reports a fail-closed transform the workflow must turn into a forced FLAG.
        recorder.calls["apply_redaction"] += 1
        recorder.call_order.append("apply_redaction")
        recorder.apply_redaction_inputs.append(payload)
        if config.redaction_failed_closed:
            return ApplyRedactionResult(text=payload.note_text, changed=False, failed_closed=True)
        if config.redaction_text is not None:
            # A CHANGED transform carries a non-empty audit manifest (rule ids +
            # span counts, never PHI) so the audit-era marker threaded to persist is
            # meaningful in tests / the captured fixture.
            return ApplyRedactionResult(
                text=config.redaction_text,
                changed=True,
                manifest=RedactionManifest(applied=True, total_hits=1, hits_by_rule={"r1": 1}),
            )
        return ApplyRedactionResult(text=payload.note_text, changed=False)

    @activity.defn(name="persist_draft")
    async def persist_draft(payload: PersistDraftInput) -> DraftResponse:
        recorder.calls["persist_draft"] += 1
        recorder.call_order.append("persist_draft")
        recorder.persist_draft_inputs.append(payload)
        if config.persist_draft_fails:
            raise ApplicationError("persist draft unavailable", non_retryable=True)
        return DraftResponse(context_item_id="ctx-draft-1")

    @activity.defn(name="finalize_assurance")
    async def finalize_assurance(payload: FinalizeAssuranceInput) -> FinalizeAssuranceResponse:
        # Second phase of optimistic delivery — apps/api
        # backfills the early SummaryMeta + flips to PENDING_REVIEW. The stub just
        # records the payload so tests can assert the verdict that was finalized.
        recorder.calls["finalize_assurance"] += 1
        recorder.call_order.append("finalize_assurance")
        recorder.finalize_inputs.append(payload)
        return FinalizeAssuranceResponse(recorded=True, context_item_id=payload.context_item_id)

    @activity.defn(name="retract_draft")
    async def retract_draft(payload: RetractDraftInput) -> RetractDraftResponse:
        # The optimistic FLAG retraction net — apps/api marks the delivered
        # draft RETRACTED + WORM + clinician event. The stub records the payload so tests can
        # assert the FLAG verdict + offending claims that drove the retraction.
        recorder.calls["retract_draft"] += 1
        recorder.call_order.append("retract_draft")
        recorder.retract_inputs.append(payload)
        return RetractDraftResponse(retracted=True, context_item_id=payload.context_item_id)

    @activity.defn(name="record_gate_decision")
    async def record_gate_decision(payload: RecordGateInput) -> RecordGateResponse:
        recorder.calls["record_gate_decision"] += 1
        recorder.record_inputs.append(payload)
        return RecordGateResponse(recorded=True)

    @activity.defn(name="escalate_gate")
    async def escalate_gate(payload: EscalateInput) -> EscalateResult:
        recorder.calls["escalate_gate"] += 1
        recorder.escalate_inputs.append(payload)
        return EscalateResult(escalated=True)

    @activity.defn(name="report_progress")
    async def report_progress(payload: ReportProgressInput) -> ReportProgressResult:
        recorder.calls["report_progress"] += 1
        recorder.call_order.append(f"progress:{payload.stage}")
        recorder.progress_inputs.append(payload)
        recorder.progress_schedule_to_close.append(activity.info().schedule_to_close_timeout)
        if config.progress_fails:
            # RETRYABLE on purpose: the workflow's
            # _PROGRESS_RETRY pins maximum_attempts=1, so each emission must be
            # attempted EXACTLY once even though the server would retry this.
            raise ApplicationError("progress pipeline down")
        return ReportProgressResult(reported=True)

    return [
        fetch_policy,
        extract_entities,
        call_mcp_tool,
        persist_entities,
        assemble_prompt,
        retrieve_context,
        generate,
        run_sensors,
        run_inferential_sensors,
        apply_redaction,
        persist_draft,
        finalize_assurance,
        retract_draft,
        record_gate_decision,
        escalate_gate,
        report_progress,
    ]
