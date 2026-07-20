"""Typed payloads for the harness document workflow + its activities.

Kept in their own module (not in ``workflows.py``) so the workflow, the
activities, the internal HTTP endpoints, and the tests share one source of
truth. All payloads are Pydantic models serialized by Temporal's
``pydantic_data_converter`` (see :mod:`harness.temporal.client`).

Field names are snake_case on the Python/Temporal side; the HTTP boundary
(apps/api <-> apps/harness) speaks camelCase and is mapped at the edges (the
internal endpoints and the api_client).
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from harness.guides.retrieval.retriever import RetrievedChunk
from harness.sensors.base import NEREntity, SensorResult
from harness.sensors.config import SensorThresholds
from harness.temporal.claim_check import ClaimCheckRef

# Inferential groundedness default — mirrors ``SensorThresholds.groundedness_threshold``
# so the workflow can thread a default when no policy row drives the loop.
DEFAULT_GROUNDEDNESS_THRESHOLD = 0.8

# ---------------------------------------------------------------------------
# Workflow I/O
# ---------------------------------------------------------------------------


class HarnessGateConfig(BaseModel):
    """Deterministic loop knobs, snapshotted from settings at workflow start.

    Carried in the workflow input (not read from env inside the workflow) so the
    bounded-regen budget + gate timers stay deterministic across replay.
    """

    model_config = ConfigDict(extra="forbid")

    max_regen: int = 2
    # TASK-533 B4 — per-run token budget. 0 ⇒ UNBOUNDED, which is the shipped
    # default and makes the budget stop inert (byte-identical to pre-B4 history).
    # Snapshotted at workflow start like every other knob here, so the check stays
    # deterministic across replay; spend is folded from recorded activity outputs.
    token_budget_per_run: int = 0
    gate_sla_seconds: float = 86_400.0
    gate_escalation_seconds: float = 43_200.0
    # TASK-355 Phase D (Slice 4a) — optimistic two-phase delivery. Snapshotted at
    # workflow start (the behaviour key) so it stays deterministic across replay;
    # the durable ``workflow.patched("task-355-optimistic-delivery")`` marker is the
    # separate replay key. BOTH must be set for the optimistic path to run. Default
    # False ⇒ the legacy single-phase path, byte-identical to pre-Phase-D history.
    optimistic_delivery_enabled: bool = False
    # C1-02 (TASK-458) — TERMINAL gate bound. After this many SLA-breach escalations the
    # gate ABANDONS (stops escalating + completes, approved=False) instead of escalating
    # forever. Loop-safety bound, not a policy knob (carried from the input over a policy
    # merge, like ``optimistic_delivery_enabled``). Behaviour is patch-gated by
    # ``workflow.patched("task-458-gate-terminal-abandon")`` ⇒ replay-safe.
    gate_max_escalations: int = 3
    # C1-02 (TASK-458) — cap on clinician-edit-driven optimistic assurance re-runs. After
    # this many edit re-runs the loop binds to the latest edit but STOPS re-running the
    # costly inferential pass, so N rapid edits can't drive N passes. Patch-gated by
    # ``workflow.patched("task-458-edit-rerun-cap")`` ⇒ replay-safe.
    max_edit_reruns: int = 5


class HarnessDocWorkflowInput(BaseModel):
    """Start payload for :class:`~harness.temporal.workflows.HarnessDocWorkflow`."""

    model_config = ConfigDict(extra="forbid")

    consultation_id: str
    tenant_id: str
    user_id: str | None = None
    job_id: str | None = None
    correlation_id: str | None = None
    # The transcript ContextItem (provenance) + its text (NER + sensor inputs).
    context_item_id: str | None = None
    transcript_text: str = ""
    # TASK-483 claim-check: OPTIONAL out-of-band reference to the transcript, carried
    # ALONGSIDE the inline ``transcript_text`` (never replacing it). Additive-optional
    # default ⇒ no new workflow command, replay-safe: an old start payload (inline only)
    # deserializes it to None. The apps/api-facing seam for a future caller to hand the
    # harness a transcript REF instead of the inline blob; until then the harness threads
    # ``transcript_text`` inline (ref None) and every consuming activity resolves inline-or-ref.
    transcript_ref: ClaimCheckRef | None = None
    conversation_language: str = "en"
    dna_style_id: str | None = None
    template: str | None = None
    # SMR generation defaults (None => SMR service default).
    smr_provider: str | None = None
    smr_model: str | None = None
    gate: HarnessGateConfig = Field(default_factory=HarnessGateConfig)


class ApprovalSignal(BaseModel):
    """Clinician sign-off forwarded by apps/api to resolve the gate."""

    model_config = ConfigDict(extra="forbid")

    tenant_id: str | None = None
    context_item_version_id: str | None = None
    attestation_hash: str | None = None
    clinician_id: str | None = None
    decision: str | None = None


class EditSignal(BaseModel):
    """Clinician edited the optimistically delivered draft (TASK-355 Phase D, Slice 4b).

    apps/api sends this when the clinician edits the draft WHILE it is still
    ``DRAFT_PENDING_SENSORS`` (assurance running). The workflow re-binds the
    assurance pass to the edited content and re-runs it (Q3), and — because the
    note is no longer the machine-generated draft — permanently DISABLES the
    silent regen-if-untouched path (Q1): from the first edit on, a REGEN verdict
    surfaces as flags instead of swapping the note under the clinician's eyes.

    ``content`` is the edited note the assurance pass must screen;
    ``context_item_version_id`` is the apps/api MODIFIED_SUMMARY version the
    verdict binds to (threaded into ``finalize_assurance`` so apps/api stamps the
    verdict on the right version). Only meaningful on the optimistic path; ignored
    by the legacy single-phase loop (which has no post-delivery assurance window).
    """

    model_config = ConfigDict(extra="forbid")

    content: str
    # TASK-483 claim-check: OPTIONAL out-of-band ref to the edited note, alongside the
    # inline ``content``. Additive-optional default ⇒ replay-safe (an old signal event
    # deserializes it to None). The apps/api-facing seam for a future caller to send the
    # edited note by REF; the assurance pass resolves inline-or-ref before screening.
    content_ref: ClaimCheckRef | None = None
    context_item_version_id: str | None = None
    edited_by: str | None = None


class HarnessDocWorkflowResult(BaseModel):
    """Terminal result of one document workflow."""

    model_config = ConfigDict(extra="forbid")

    consultation_id: str
    decision: str
    context_item_id: str | None = None
    regens_used: int = 0
    escalations: int = 0
    approved: bool = False
    clinician_id: str | None = None
    # TASK-481 (E2) — the optimistically-delivered draft was RETRACTED because the
    # post-delivery assurance pass FLAGged it (the retraction net for the accepted
    # TASK-453 pre-assurance sign-off window). Additive-optional default ⇒ replay-safe:
    # an old history's recorded result deserializes it to False (the non-retracted path).
    retracted: bool = False


# ---------------------------------------------------------------------------
# Harness policy (TASK-330 Phase 6 — Phase C.3): the DB-backed knobs the durable
# loop reads live at workflow start (sensor thresholds, guard toggles, gate
# budgets, model/tool selection). Snake_case on the Temporal side; the apps/api
# worker-facing endpoint speaks camelCase (mapped in :meth:`HarnessPolicy.from_api`).
# ---------------------------------------------------------------------------


class TrajectoryContext(BaseModel):
    """Workflow-owned, deterministic per-activity trajectory context.

    Threaded as an ADDITIVE-OPTIONAL field on every activity input so the
    (non-deterministic) emission lives entirely in activity code while the
    ordering (``seq``) is allocated deterministically in the workflow body — no
    new workflow command, so the recorded command sequence is unchanged and the
    replay fixtures stay valid (the TASK-483 additive-input precedent).

    ``seq`` is this activity's monotonic base; an activity that emits >1 step
    (e.g. ``generate`` → ``LLM_CALL`` + ``THINKING``) offsets locally from it.
    ``tenant_id``/``consultation_id``/``correlation_id`` carry the routing +
    correlation the trajectory step needs; ``session_id``/``run_id`` are read
    from ``activity.info()`` (the Temporal workflow/run ids) inside the activity.
    ``is_regen`` marks a bounded-regen generation (drives ``harness_regen_total``).
    """

    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    consultation_id: str | None = None
    correlation_id: str | None = None
    seq: int = 0
    is_regen: bool = False


class FetchPolicyInput(BaseModel):
    """Input for the ``fetch_policy`` activity (reads the effective tenant policy)."""

    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    # ADDITIVE-OPTIONAL trajectory context (workflow-owned seq
    # + session meta). Default None ⇒ command-neutral / replay-safe (an old input
    # deserializes it to None ⇒ no emission). Same on every activity input below.
    trajectory: TrajectoryContext | None = None


class McpServerConfig(BaseModel):
    """A registered MCP external-tools server, snapshotted onto the policy.

    The ``fetch_policy`` activity reads the SYSTEM-shared ``McpServer`` registry
    (server METADATA only) alongside the tenant policy and threads the enabled
    servers here, so server resolution + the allowlist intersection happen in the
    deterministic workflow body from replay-carried data (no per-loop registry
    read). ``auth_ref`` is a Vault PATH — NEVER secret bytes; the credential is
    resolved out-of-band at call time in the activity. READ-ONLY tools only.
    """

    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    base_url: str
    transport: str = "streamable-http"
    auth_ref: str | None = None
    tool_allowlist: list[str] | None = None
    # "external" (cloud egress — PHI-screened FAIL-CLOSED) | "in-boundary" (self-hosted).
    phi_boundary: str = "external"
    enabled: bool = False

    @classmethod
    def from_api(cls, data: dict[str, Any]) -> McpServerConfig:
        """Map an apps/api camelCase ``McpServerResponse`` onto this model (tolerant)."""
        return cls(
            id=str(data.get("id", "")),
            name=str(data.get("name", "")),
            base_url=str(data.get("baseUrl", "")),
            transport=data.get("transport") or "streamable-http",
            auth_ref=data.get("authRef"),
            tool_allowlist=data.get("toolAllowlist"),
            phi_boundary=data.get("phiBoundary") or "external",
            enabled=bool(data.get("enabled", False)),
        )


class HarnessPolicy(BaseModel):
    """Effective harness policy snapshot threaded through the deterministic loop.

    Read ONCE in the ``fetch_policy`` activity (I/O stays out of the workflow body)
    and carried through replay. Defaults mirror the harness code defaults so a
    code-default / partial response degrades safely.
    """

    model_config = ConfigDict(extra="ignore")

    entity_faithfulness_threshold: float = 1.0
    coverage_threshold: float = 0.8
    citation_presence_threshold: float = 1.0
    numeric_dose_threshold: float = 1.0
    groundedness_threshold: float = DEFAULT_GROUNDEDNESS_THRESHOLD
    safety_enabled: bool = True
    phi_enabled: bool = True
    phi_fail_closed: bool = True
    safety_provider: str = "lm-studio"
    safety_model: str = "granite-guardian-4.1-8b"
    smr_provider: str | None = None
    smr_model: str | None = None
    # LLM-as-judge selection resolved from the SYSTEM ``AiTaskDefault``
    # key ``harness.judge`` (GLOBAL_ADMIN-owned). NULLABLE by design (like
    # ``smr_provider``): ``None`` ⇒ the SYSTEM default is missing/disabled, and the
    # inferential pass FAILS CLOSED (degrades) rather than falling back to the
    # env ``HARNESS_JUDGE_PROVIDER``/``HARNESS_JUDGE_MODEL`` selection — env carries
    # only the judge CONNECTION config (base_url/api_key), never the selection.
    judge_provider: str | None = None
    judge_model: str | None = None
    max_regen: int = 2
    gate_sla_seconds: int = 86_400
    gate_escalation_seconds: int = 43_200
    tool_allowlist: list[str] | None = None
    # the seven additive agentic loop knobs. NULLABLE by
    # design: ``None`` ⇒ the harness env/code default applies (per-field
    # fallthrough), so the loop overrides a runtime default ONLY when the policy
    # carries an explicit non-null value. Consumed via ``_resolve_flag`` in the
    # activities (ner-priors / atomic-fact / retrieval) and the workflow-body gate
    # merge (optimistic-delivery / max-edit-reruns); warm-start + regen-feedback
    # are carried for Phase 6 consumption.
    optimistic_delivery_enabled: bool | None = None
    atomic_fact_enabled: bool | None = None
    retrieval_enabled: bool | None = None
    warm_start_enabled: bool | None = None
    # TASK-533 B4 — per-run token budget from `agentic.context.tokenBudget.perRun`,
    # served on the effective policy. None ⇒ not configured (the gate keeps its
    # snapshotted default of 0 = unbounded).
    token_budget_per_run: int | None = None
    ner_priors_enabled: bool | None = None
    max_edit_reruns: int | None = None
    regen_feedback_enabled: bool | None = None
    # MCP external-tools master switch. NULLABLE by design:
    # ``None`` ⇒ OFF (the whole MCP tool path stays dormant), so the feature is off
    # by default everywhere until a global admin flips this per-tenant knob AND the
    # referenced ``McpServer.enabled`` is true. ``mcp_servers`` carries the enabled
    # SYSTEM-shared registry rows the workflow resolves against (empty ⇒ nothing to call).
    mcp_tools_enabled: bool | None = None
    mcp_servers: list[McpServerConfig] = Field(default_factory=list)
    version: int = 0

    @classmethod
    def from_api(cls, data: dict[str, Any]) -> HarnessPolicy:
        """Map the apps/api camelCase ``HarnessPolicyResponse`` onto this model.

        Tolerant of missing keys (uses this model's defaults) so a partial / code
        default response never crashes the loop — it degrades to the code defaults.
        """
        defaults = cls()

        def _get(camel: str, fallback: Any) -> Any:
            value = data.get(camel)
            return fallback if value is None else value

        return cls(
            entity_faithfulness_threshold=_get(
                "entityFaithfulnessThreshold", defaults.entity_faithfulness_threshold
            ),
            coverage_threshold=_get("coverageThreshold", defaults.coverage_threshold),
            citation_presence_threshold=_get(
                "citationPresenceThreshold", defaults.citation_presence_threshold
            ),
            numeric_dose_threshold=_get("numericDoseThreshold", defaults.numeric_dose_threshold),
            groundedness_threshold=_get("groundednessThreshold", defaults.groundedness_threshold),
            safety_enabled=_get("safetyEnabled", defaults.safety_enabled),
            phi_enabled=_get("phiEnabled", defaults.phi_enabled),
            phi_fail_closed=_get("phiFailClosed", defaults.phi_fail_closed),
            safety_provider=_get("safetyProvider", defaults.safety_provider),
            safety_model=_get("safetyModel", defaults.safety_model),
            # smr_provider/smr_model are intentionally nullable (None => SMR default).
            smr_provider=data.get("smrProvider"),
            smr_model=data.get("smrModel"),
            # judge selection is nullable pass-through (like smr_*): a
            # null ``judgeProvider``/``judgeModel`` from apps/api means the SYSTEM
            # ``harness.judge`` default is missing → the inferential pass fails closed.
            # NO env fallback here (that would re-introduce env-based selection).
            judge_provider=data.get("judgeProvider"),
            judge_model=data.get("judgeModel"),
            max_regen=_get("maxRegen", defaults.max_regen),
            gate_sla_seconds=_get("gateSlaSeconds", defaults.gate_sla_seconds),
            gate_escalation_seconds=_get("gateEscalationSeconds", defaults.gate_escalation_seconds),
            tool_allowlist=data.get("toolAllowlist"),
            # nullable agentic knobs: pass the value through
            # verbatim (``data.get`` ⇒ None for missing/explicit-null), so ``None``
            # falls through to the harness env/code default at the consumption site.
            optimistic_delivery_enabled=data.get("optimisticDeliveryEnabled"),
            atomic_fact_enabled=data.get("atomicFactEnabled"),
            retrieval_enabled=data.get("retrievalEnabled"),
            warm_start_enabled=data.get("warmStartEnabled"),
            token_budget_per_run=data.get("tokenBudgetPerRun"),
            ner_priors_enabled=data.get("nerPriorsEnabled"),
            max_edit_reruns=data.get("maxEditReruns"),
            regen_feedback_enabled=data.get("regenFeedbackEnabled"),
            # nullable MCP master switch (None ⇒ OFF) + the enabled
            # SYSTEM-shared registry rows. ``mcpServers`` is the registry snapshot the
            # fetch_policy activity attaches; missing/empty ⇒ no servers to resolve.
            mcp_tools_enabled=data.get("mcpToolsEnabled"),
            mcp_servers=[
                McpServerConfig.from_api(s)
                for s in (data.get("mcpServers") or [])
                if isinstance(s, dict)
            ],
            version=_get("version", defaults.version),
        )

    def to_sensor_thresholds(self) -> SensorThresholds:
        """Build the computational-sensor thresholds from the policy.

        Uses ``model_construct`` so it stays deterministic/sandbox-safe (no env or
        ``.env`` reads) when invoked from the workflow body. ``citation_verify`` is
        not policy-driven yet, so it keeps the ``SensorThresholds`` default.
        """
        return SensorThresholds.model_construct(
            entity_faithfulness_threshold=self.entity_faithfulness_threshold,
            coverage_threshold=self.coverage_threshold,
            citation_presence_threshold=self.citation_presence_threshold,
            numeric_dose_threshold=self.numeric_dose_threshold,
            groundedness_threshold=self.groundedness_threshold,
        )


# ---------------------------------------------------------------------------
# Activity inputs (outputs reuse the services'/sensors' typed models)
# ---------------------------------------------------------------------------


class ExtractEntitiesInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    # TASK-483 claim-check: OPTIONAL out-of-band ref to ``text``, alongside the inline
    # field. The activity resolves inline-or-ref at entry (ref set ⇒ dereference; ref
    # absent ⇒ use ``text``). Additive-optional ⇒ replay-safe. Set on the NOTE-NER call
    # when the note was offloaded by ``generate``; the transcript-NER call carries the
    # (future) ``HarnessDocWorkflowInput.transcript_ref``.
    text_ref: ClaimCheckRef | None = None
    language: str = "en"
    # TASK-480 Half-B — NER-priors reuse. The TRANSCRIPT extraction sets
    # ``reuse_priors=True`` (+ the ids) so the activity may reuse already-persisted
    # CODED NamedEntity rows (TASK-476) as the transcript entities instead of re-running
    # the cold NLP pass — the note-NER calls leave these unset. Additive-optional with
    # safe defaults ⇒ no new workflow command, replay-safe (the activity does the
    # non-deterministic load; an old replay history schedules ``extract_entities``
    # exactly as before). The reuse is gated inside the activity by
    # ``HARNESS_NER_PRIORS_ENABLED`` (default OFF) and only fires when a prior carries an
    # ontology code, so it is inert until TASK-476 populates the codes.
    reuse_priors: bool = False
    consultation_id: str | None = None
    tenant_id: str | None = None
    # per-run NER-priors override threaded from the effective
    # policy. None ⇒ the activity falls through to ``HARNESS_NER_PRIORS_ENABLED``
    # (env default). Additive-optional ⇒ replay-safe (an old input ⇒ None ⇒ env path,
    # byte-identical); no new workflow command.
    ner_priors_enabled: bool | None = None
    # ADDITIVE-OPTIONAL trajectory context (see TrajectoryContext).
    trajectory: TrajectoryContext | None = None


class EntitiesResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entities: list[NEREntity] = Field(default_factory=list)
    # TASK-480 Half-B — True when ``entities`` were REUSED from persisted coded priors
    # (the cold NLP pass was skipped). The workflow reads this to skip the redundant
    # re-persist of the already-existing rows. Additive-optional ⇒ an old replay
    # history's recorded result deserializes it to False (the cold-path semantics),
    # replay-safe.
    reused: bool = False


class CallMcpToolInput(BaseModel):
    """Input for the ``call_mcp_tool`` activity.

    The workflow resolves the server from the policy snapshot and threads it here
    with the tenant policy allowlist so the activity enforces the intersection
    (``policy_tool_allowlist`` ∩ ``server.tool_allowlist``) and the fail-closed PHI
    egress screen (when the server is ``phi_boundary="external"``) BEFORE any
    network call. Additive-optional trajectory context (workflow-owned seq).
    """

    model_config = ConfigDict(extra="forbid")

    server: McpServerConfig
    tool: str
    args: dict[str, Any] = Field(default_factory=dict)
    # The tenant's HarnessPolicy.toolAllowlist (None ⇒ no tenant restriction; the
    # server allowlist still applies). Intersected with the server allowlist.
    policy_tool_allowlist: list[str] | None = None
    # PHI egress policy snapshot (mirrors the generate/inferential egress guard).
    phi_enabled: bool = True
    phi_fail_closed: bool = True
    trajectory: TrajectoryContext | None = None


class McpToolCallResult(BaseModel):
    """Result of a ``call_mcp_tool`` activity (degrade-safe, never leaks secrets)."""

    model_config = ConfigDict(extra="forbid")

    ok: bool = False
    server: str = ""
    tool: str = ""
    # Inline tool result text (empty when offloaded to the claim-check store).
    content: str = ""
    # TASK-483 claim-check ref when the result exceeded the size cap and was offloaded.
    content_ref: ClaimCheckRef | None = None
    # True when a server/transport error degraded the call — the workflow OR-s this
    # into ``reduced_assurance`` and NEVER crashes the loop.
    degraded: bool = False
    # True when claim-check was disabled but the result exceeded the cap and was truncated.
    truncated: bool = False
    # Coarse failure code for the trajectory step (never carries secret material).
    error_code: str | None = None


class PersistEntitiesInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    consultation_id: str
    tenant_id: str
    context_item_id: str | None = None
    entities: list[NEREntity] = Field(default_factory=list)
    user_id: str | None = None
    # ADDITIVE-OPTIONAL trajectory context (see TrajectoryContext).
    trajectory: TrajectoryContext | None = None


class AssembleInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    consultation_id: str
    tenant_id: str
    user_id: str | None = None
    template: str | None = None
    dna_style_id: str | None = None
    conversation_language: str | None = None
    # ADDITIVE-OPTIONAL trajectory context (see TrajectoryContext).
    trajectory: TrajectoryContext | None = None


class RegenFinding(BaseModel):
    """one failed sensor's critique for the next regen iteration.

    Carries the sensor ``sensor`` (name), the ``failing_claims`` it flagged, and
    a short, model-readable ``expected_fix`` instruction. Data-only (no PHI note
    text — only the already-surfaced claim refs the sensor produced).
    """

    model_config = ConfigDict(extra="forbid")

    sensor: str
    failing_claims: list[str] = Field(default_factory=list)
    expected_fix: str = ""


class RegenFeedback(BaseModel):
    """the prior iteration's aggregated critique threaded into regen.

    Additive-optional on :class:`GenerateInput`; reconstructed deterministically
    from recorded sensor outputs on replay (absent on legacy histories ⇒ None ⇒
    byte-identical no-feedback prompt), so it adds no new workflow command.
    """

    model_config = ConfigDict(extra="forbid")

    findings: list[RegenFinding] = Field(default_factory=list)


class SegmentCitationRef(BaseModel):
    """one transcript-segment citation ref for finalize StrictCitations.

    PHI-safe: id + short speaker/time/ordinal hints only — never segment plaintext.
    Threaded as an additive-optional list on :class:`GenerateInput`; empty/absent
    ⇒ no segment citation block (byte-identical to before), replay-safe.
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    speaker: str | None = None
    t0_ms: int | None = None
    t1_ms: int | None = None
    idx: int | None = None


class GenerateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str
    system_prompt: str | None = None
    # TASK-483 claim-check: OPTIONAL out-of-band refs for the (large) prompts, carried
    # alongside the inline fields. The ``generate`` activity resolves inline-or-ref at
    # entry before the PHI-egress guard + SMR call. Additive-optional ⇒ replay-safe (an
    # old input deserializes them to None ⇒ the inline prompt path, byte-identical).
    prompt_ref: ClaimCheckRef | None = None
    system_prompt_ref: ClaimCheckRef | None = None
    # TASK-483: the RAG StrictCitations block to append AFTER the (resolved) user prompt.
    # Moved off the workflow body (which previously concatenated it) so the workflow can
    # thread the small prompt REF instead of the concatenated blob; the ``generate``
    # activity folds it in before the PHI-egress guard. Default "" ⇒ no append (the
    # retrieval-off common case, byte-identical to a plain prompt), replay-safe.
    prompt_block: str = ""
    response_format: dict[str, Any] | None = None
    hyperparameters: dict[str, Any] = Field(default_factory=dict)
    provider: str | None = None
    model: str | None = None
    # TASK-357: the run-effective PHI egress policy, snapshotted from the harness
    # policy at workflow start so the guard in the ``generate`` activity is
    # deterministic across replay. Defaults mirror the fail-closed code default, so
    # an unset/legacy input still enforces the guard. Optional with safe defaults ⇒
    # no new workflow command, replay-safe (TASK-355 Slice-5d precedent).
    phi_enabled: bool = True
    phi_fail_closed: bool = True
    # critique-informed regen. ADDITIVE-OPTIONAL: the prior iteration's
    # failed-sensor findings, appended to the prompt as a corrective suffix on a
    # regen iteration. None (the default, and every FIRST iteration) ⇒ the prompt
    # is byte-identical to before ⇒ no new workflow command, replay-safe.
    regen_feedback: RegenFeedback | None = None
    # segment StrictCitations. ADDITIVE-OPTIONAL: when the caller
    # supplies transcript-segment refs, ``generate`` folds a ``[[seg:<id>]]``
    # instruction + allowed-id list into the prompt (PHI-safe hints only).
    # Empty (default, and every legacy history) ⇒ byte-identical to before ⇒
    # no new workflow command, replay-safe.
    segment_citations: list[SegmentCitationRef] = Field(default_factory=list)
    # ADDITIVE-OPTIONAL trajectory context (see TrajectoryContext).
    trajectory: TrajectoryContext | None = None


class RetrieveContextInput(BaseModel):
    """Inputs for the Phase-3 ``retrieve_context`` activity (flag-gated, degrade-safe).

    The activity builds the hybrid query from the extracted ``entities``; the
    ``tenant_id`` is the load-bearing isolation scope (only that tenant's APPROVED
    chunks are retrievable).
    """

    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    entities: list[NEREntity] = Field(default_factory=list)
    # per-run retrieval override threaded from the effective
    # policy. None ⇒ the activity falls through to ``HARNESS_RETRIEVAL_ENABLED``
    # (env default). Additive-optional ⇒ replay-safe; no new workflow command.
    retrieval_enabled: bool | None = None
    # ADDITIVE-OPTIONAL trajectory context (see TrajectoryContext).
    trajectory: TrajectoryContext | None = None


class RetrievedContext(BaseModel):
    """Output of ``retrieve_context``: the reranked chunks + the StrictCitations block.

    ``degraded`` is True when a retrieval backend (embeddings/Qdrant/reranker) was
    down — the workflow turns that into reduced assurance (generation still proceeds
    on whatever context exists, which on degrade is empty). ``prompt_block`` is the
    ready-to-append Knowledge Context (empty when there is nothing to cite).
    """

    model_config = ConfigDict(extra="forbid")

    chunks: list[RetrievedChunk] = Field(default_factory=list)
    degraded: bool = False
    prompt_block: str = ""


class RunSensorsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    note_text: str
    transcript_text: str = ""
    # TASK-483 claim-check: OPTIONAL out-of-band refs for the (large) note + transcript,
    # alongside the inline fields. The activity resolves inline-or-ref at entry. Additive-
    # optional ⇒ replay-safe (an old input ⇒ None ⇒ inline path). ``note_text_ref`` is set
    # when ``generate`` offloaded the note; ``transcript_text_ref`` threads the (future)
    # transcript ref.
    note_text_ref: ClaimCheckRef | None = None
    transcript_text_ref: ClaimCheckRef | None = None
    note_entities: list[NEREntity] = Field(default_factory=list)
    transcript_entities: list[NEREntity] = Field(default_factory=list)
    response_format: dict[str, Any] | None = None
    transcript_context_item_id: str | None = None
    # Phase-3 RAG: the chunk ids the retriever surfaced for this generation, used to
    # map the model's StrictCitations markers onto each claim's knowledgeChunkIds.
    retrieved_chunk_ids: list[str] = Field(default_factory=list)
    # Phase-6: policy-driven computational thresholds (None => the sensors' own
    # env-driven ``SensorThresholds`` defaults).
    thresholds: SensorThresholds | None = None
    # ADDITIVE-OPTIONAL trajectory context (see TrajectoryContext).
    trajectory: TrajectoryContext | None = None


class RunInferentialSensorsInput(BaseModel):
    """Inputs for the Phase-2 ``run_inferential_sensors`` activity.

    The activity builds the judge + Granite client itself (model calls live in the
    activity, never the workflow); it only needs the generated note (safety screen),
    the transcript, and the provenance ``citationsMap`` (per-claim groundedness).
    """

    model_config = ConfigDict(extra="forbid")

    note_text: str
    transcript_text: str = ""
    # TASK-483 claim-check: OPTIONAL out-of-band refs for the (large) note + transcript,
    # alongside the inline fields; the activity resolves inline-or-ref at entry. Additive-
    # optional ⇒ replay-safe. ``note_text_ref`` is set when ``generate`` (or the edited
    # note) was offloaded; ``transcript_text_ref`` threads the (future) transcript ref.
    note_text_ref: ClaimCheckRef | None = None
    transcript_text_ref: ClaimCheckRef | None = None
    citations_map: dict[str, Any] = Field(default_factory=dict)
    # Phase-3 RAG: retrieved chunk id -> chunk text, so the citation-verify sensor
    # can entail each cited claim against ONLY its cited chunk(s).
    knowledge_chunks: dict[str, str] = Field(default_factory=dict)
    # TASK-483 claim-check: OPTIONAL per-chunk out-of-band refs (chunk id -> ref) for the
    # (large) knowledge chunk texts, alongside ``knowledge_chunks``. The activity merges
    # inline + resolved-ref chunks at entry. Additive-optional ⇒ replay-safe (an old input
    # ⇒ {} ⇒ the pure-inline chunk path).
    knowledge_chunks_ref: dict[str, ClaimCheckRef] = Field(default_factory=dict)
    # Phase-6 policy injection: the groundedness pass threshold + the safety toggle.
    # ``safety_enabled=False`` skips the Granite safety screen entirely.
    groundedness_threshold: float = DEFAULT_GROUNDEDNESS_THRESHOLD
    safety_enabled: bool = True
    # run-effective LLM-as-judge selection, snapshotted from the policy
    # (``harness.judge`` SYSTEM default) at workflow start so the activity builds the
    # judge deterministically across replay. NULLABLE: ``None`` ⇒ no SYSTEM judge
    # selection → the pass FAILS CLOSED (degrades) instead of using the env judge
    # selection (env carries only base_url/api_key connection config). Additive-
    # optional defaults ⇒ replay-safe (an old input deserializes them to None).
    judge_provider: str | None = None
    judge_model: str | None = None
    # per-run atomic-fact override threaded from the effective
    # policy. None ⇒ the activity falls through to ``HARNESS_ATOMIC_FACT_ENABLED``
    # (env default). Additive-optional ⇒ replay-safe; no new workflow command.
    atomic_fact_enabled: bool | None = None
    # TASK-357: the run-effective PHI egress policy, snapshotted from the harness
    # policy at workflow start so the guard in ``run_inferential_sensors`` is
    # deterministic across replay (defaults mirror the fail-closed code default).
    # Optional with safe defaults ⇒ no new workflow command, replay-safe.
    phi_enabled: bool = True
    phi_fail_closed: bool = True
    # TASK-355 Phase D Slice 5d (Q5) — live per-claim assurance feed. Populated ONLY
    # at the optimistic ASSURANCE call site; when ``live_assurance`` is True and the
    # ids are present, the activity streams each groundedness claim verdict to apps/api
    # as it resolves. Optional with safe defaults ⇒ the legacy call site (and any
    # pre-5d replay history) schedules the activity exactly as before; the per-claim
    # publish lives entirely in (non-deterministic) activity code, so it is replay-safe.
    live_assurance: bool = False
    consultation_id: str | None = None
    tenant_id: str | None = None
    job_id: str | None = None
    # TASK-359 WS-1 — workflow-threaded, data-only verdict cache (L2). Content-addressed
    # {claim_verdict_key: supported} carried in from earlier inferential passes; the activity
    # seeds its cache from this and re-judges only cache-missing (changed) claims, reusing the
    # rest byte-identically (AC-2). Additive-optional default ⇒ no new workflow command, no
    # ``workflow.patched()``; an old replay history without it defaults to {} (T8). Held only in
    # workflow history (data-only) — never persisted to an external store (L3 is default-OFF, §4.5).
    prior_verdicts: dict[str, bool] = Field(default_factory=dict)
    # ADDITIVE-OPTIONAL trajectory context (see TrajectoryContext).
    trajectory: TrajectoryContext | None = None


class InferentialRunOutput(BaseModel):
    """Result of one inferential pass: the raw sensor results + a guardrail-decision
    map + the extracted ``ragTriadScore`` + a degraded marker.

    ``guardrail_decisions`` is persisted as ``SummaryMeta.guardrailDecisions``
    (and embedded in the ``SENSOR_RUN`` WORM audit). ``degraded`` is True when any
    inferential backend was unavailable — the workflow turns that into
    ``reduced_assurance`` (and excludes the degraded result from the aggregate).
    """

    model_config = ConfigDict(extra="forbid")

    results: list[SensorResult] = Field(default_factory=list)
    guardrail_decisions: dict[str, Any] = Field(default_factory=dict)
    rag_triad_score: float | None = None
    degraded: bool = False
    # TASK-359 WS-1 — the verdict cache populated by this pass (seed ∪ newly-judged), returned so
    # the workflow can thread it into the next regen pass's ``prior_verdicts``. Additive-optional
    # ⇒ replay-safe; an old history without this field deserializes it to {} (T8).
    verdict_cache: dict[str, bool] = Field(default_factory=dict)


# TASK-355 Phase D (Slice 4a) — the early-persist phase discriminator. Mirrors the
# apps/api ``HARNESS_DRAFT_PHASE.EARLY`` (``HarnessDraftRequest.phase``): the harness
# sends this value on the optimistic early persist so apps/api withholds the verdict
# (status ``DRAFT_PENDING_SENSORS``, GENERATE-only audit). Absent ⇒ legacy single-shot.
HARNESS_DRAFT_PHASE_EARLY = "DRAFT_PENDING_SENSORS"


class PersistDraftInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    consultation_id: str
    tenant_id: str
    content: str
    # TASK-483 claim-check: OPTIONAL out-of-band ref to the (large) draft ``content``,
    # alongside the inline field. The activity resolves inline-or-ref at entry, then POSTs
    # the fully-materialized note to apps/api (the persist contract is unchanged — apps/api
    # still receives the real content). Additive-optional ⇒ replay-safe.
    content_ref: ClaimCheckRef | None = None
    user_id: str | None = None
    job_id: str | None = None
    model_name: str | None = None
    model_version: str | None = None
    sensor_scores: dict[str, Any] | None = None
    citations_map: dict[str, Any] | None = None
    # Phase-2 inferential guardrails: persisted as SummaryMeta.guardrailDecisions;
    # reduced_assurance=True appends the REDUCED_ASSURANCE WORM event on apps/api.
    guardrail_decisions: dict[str, Any] | None = None
    reduced_assurance: bool | None = None
    entity_faithfulness_score: float | None = None
    coverage_score: float | None = None
    rag_triad_score: float | None = None
    prompt_template_id: str | None = None
    prompt_version: str | None = None
    dna_style_id: str | None = None
    gate_decision: str | None = None
    is_auto_generated: bool | None = None
    # TASK-355 Phase D (Slice 4a) — optimistic delivery discriminator. None (legacy)
    # ⇒ single-shot persist (full scores, PENDING_REVIEW). ``DRAFT_PENDING_SENSORS``
    # ⇒ early persist: readable draft now, verdict withheld, assurance deferred to
    # ``finalize_assurance``.
    phase: str | None = None
    # ADDITIVE-OPTIONAL trajectory context (see TrajectoryContext).
    trajectory: TrajectoryContext | None = None


class FinalizeAssuranceInput(BaseModel):
    """Inputs for the Phase-D ``finalize_assurance`` activity (Slice 4a, second phase).

    The optimistic path delivers the readable draft early (``persist_draft`` with
    ``phase=DRAFT_PENDING_SENSORS``) and then runs the costly inferential pass as
    assurance. This payload carries the resulting verdict to apps/api, which
    backfills the early ``SummaryMeta`` (inferential scores + ``gateDecision`` +
    ``assuranceCompletedAt``), flips ``DRAFT_PENDING_SENSORS → PENDING_REVIEW``, and
    records the deferred ``SENSOR_RUN`` (+ ``REDUCED_ASSURANCE``) WORM audit.
    ``context_item_id`` is the RAW_SUMMARY persisted in the early phase (the target).

    TASK-355 Slice 4b: ``context_item_version_id`` is set when a clinician EDIT
    re-bound assurance to an edited MODIFIED_SUMMARY version (None ⇒ the verdict
    binds to the originally delivered draft). apps/api stamps the verdict on that
    version so a late edit is assured against the note the clinician actually has.
    """

    model_config = ConfigDict(extra="forbid")

    consultation_id: str
    tenant_id: str
    user_id: str | None = None
    job_id: str | None = None
    context_item_id: str
    context_item_version_id: str | None = None
    sensor_scores: dict[str, Any] | None = None
    citations_map: dict[str, Any] | None = None
    guardrail_decisions: dict[str, Any] | None = None
    reduced_assurance: bool | None = None
    rag_triad_score: float | None = None
    gate_decision: str | None = None
    model_name: str | None = None
    model_version: str | None = None
    prompt_template_id: str | None = None
    prompt_version: str | None = None
    # ADDITIVE-OPTIONAL trajectory context (see TrajectoryContext).
    trajectory: TrajectoryContext | None = None


class RetractDraftInput(BaseModel):
    """Inputs for the TASK-481 (E2) ``retract_draft`` activity (optimistic-delivery net).

    When the optimistic path's post-delivery assurance FLAGs, the delivered
    ``DRAFT_PENDING_SENSORS`` draft is RETRACTED instead of silently backfilling the FLAG
    verdict: apps/api marks the draft ``RETRACTED``, writes the WORM audit (carrying the
    FLAG verdict + the offending atomic/claim refs so the retraction is explainable), and
    surfaces a clinician-facing retraction event. Idempotent on the apps/api side (a
    retried retraction re-marks the same terminal state without double-writing).
    ``context_item_version_id`` binds the retraction to the clinician-edited version when
    an edit re-bound assurance (mirrors ``finalize_assurance``); None ⇒ the delivered draft.
    """

    model_config = ConfigDict(extra="forbid")

    consultation_id: str
    tenant_id: str
    user_id: str | None = None
    job_id: str | None = None
    context_item_id: str
    context_item_version_id: str | None = None
    gate_decision: str | None = None
    reason: str = "assurance_flag"
    claims_flagged: list[str] = Field(default_factory=list)
    sensor_scores: dict[str, Any] | None = None
    guardrail_decisions: dict[str, Any] | None = None
    reduced_assurance: bool | None = None
    rag_triad_score: float | None = None
    # ADDITIVE-OPTIONAL trajectory context (see TrajectoryContext).
    trajectory: TrajectoryContext | None = None


class RecordGateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    consultation_id: str
    tenant_id: str
    user_id: str | None = None
    decision: str | None = None
    gate_decision: str | None = None
    context_item_version_id: str | None = None
    attestation_hash: str | None = None
    clinician_id: str | None = None
    # ADDITIVE-OPTIONAL trajectory context (see TrajectoryContext).
    trajectory: TrajectoryContext | None = None


class EscalateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    consultation_id: str
    tenant_id: str
    reason: str
    job_id: str | None = None
    # ADDITIVE-OPTIONAL trajectory context (see TrajectoryContext).
    trajectory: TrajectoryContext | None = None


class EscalateResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    escalated: bool = False


# ---------------------------------------------------------------------------
# TASK-345 — live progress feed
# ---------------------------------------------------------------------------

# Stage catalog: (key, label) in run order; ordinal = index + 1. The keys/labels
# are the public UI contract relayed verbatim over SSE — no PHI, ever.
HARNESS_PROGRESS_STAGES: tuple[tuple[str, str], ...] = (
    ("extracting_information", "Extracting key information"),
    ("assembling_context", "Assembling context"),
    ("drafting_note", "Drafting the note"),
    ("running_safety_sensors", "Running safety sensors"),
    ("finalizing_draft", "Finalizing the draft"),
)

# Terminal pseudo-stage: tells the API to mark everything completed and close
# the SSE stream (`closed: true`). Emitted after the draft persists.
HARNESS_PROGRESS_TERMINAL_STAGE = "completed"
HARNESS_PROGRESS_TERMINAL_LABEL = "Draft ready for review"

# Failure terminal pseudo-stage (TASK-348 / MAJ-1): emitted best-effort when
# the workflow fails, so the API marks the active stage `failed` and closes
# the SSE stream instead of freezing on a stale `active` snapshot.
HARNESS_PROGRESS_FAILED_STAGE = "failed"
HARNESS_PROGRESS_FAILED_LABEL = "Documentation generation failed"


class ReportProgressInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    consultation_id: str
    tenant_id: str
    stage: str
    label: str
    ordinal: int
    total: int
    job_id: str | None = None


class ReportProgressResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reported: bool = False
