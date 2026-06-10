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
    gate_sla_seconds: float = 86_400.0
    gate_escalation_seconds: float = 43_200.0


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


# ---------------------------------------------------------------------------
# Harness policy (TASK-330 Phase 6 — Phase C.3): the DB-backed knobs the durable
# loop reads live at workflow start (sensor thresholds, guard toggles, gate
# budgets, model/tool selection). Snake_case on the Temporal side; the apps/api
# worker-facing endpoint speaks camelCase (mapped in :meth:`HarnessPolicy.from_api`).
# ---------------------------------------------------------------------------


class FetchPolicyInput(BaseModel):
    """Input for the ``fetch_policy`` activity (reads the effective tenant policy)."""

    model_config = ConfigDict(extra="forbid")

    tenant_id: str


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
    max_regen: int = 2
    gate_sla_seconds: int = 86_400
    gate_escalation_seconds: int = 43_200
    tool_allowlist: list[str] | None = None
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
            max_regen=_get("maxRegen", defaults.max_regen),
            gate_sla_seconds=_get("gateSlaSeconds", defaults.gate_sla_seconds),
            gate_escalation_seconds=_get(
                "gateEscalationSeconds", defaults.gate_escalation_seconds
            ),
            tool_allowlist=data.get("toolAllowlist"),
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
    language: str = "en"


class EntitiesResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entities: list[NEREntity] = Field(default_factory=list)


class PersistEntitiesInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    consultation_id: str
    tenant_id: str
    context_item_id: str | None = None
    entities: list[NEREntity] = Field(default_factory=list)
    user_id: str | None = None


class AssembleInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    consultation_id: str
    tenant_id: str
    user_id: str | None = None
    template: str | None = None
    dna_style_id: str | None = None
    conversation_language: str | None = None


class GenerateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str
    system_prompt: str | None = None
    response_format: dict[str, Any] | None = None
    hyperparameters: dict[str, Any] = Field(default_factory=dict)
    provider: str | None = None
    model: str | None = None


class RetrieveContextInput(BaseModel):
    """Inputs for the Phase-3 ``retrieve_context`` activity (flag-gated, degrade-safe).

    The activity builds the hybrid query from the extracted ``entities``; the
    ``tenant_id`` is the load-bearing isolation scope (only that tenant's APPROVED
    chunks are retrievable).
    """

    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    entities: list[NEREntity] = Field(default_factory=list)


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


class RunInferentialSensorsInput(BaseModel):
    """Inputs for the Phase-2 ``run_inferential_sensors`` activity.

    The activity builds the judge + Granite client itself (model calls live in the
    activity, never the workflow); it only needs the generated note (safety screen),
    the transcript, and the provenance ``citationsMap`` (per-claim groundedness).
    """

    model_config = ConfigDict(extra="forbid")

    note_text: str
    transcript_text: str = ""
    citations_map: dict[str, Any] = Field(default_factory=dict)
    # Phase-3 RAG: retrieved chunk id -> chunk text, so the citation-verify sensor
    # can entail each cited claim against ONLY its cited chunk(s).
    knowledge_chunks: dict[str, str] = Field(default_factory=dict)
    # Phase-6 policy injection: the groundedness pass threshold + the safety toggle.
    # ``safety_enabled=False`` skips the Granite safety screen entirely.
    groundedness_threshold: float = DEFAULT_GROUNDEDNESS_THRESHOLD
    safety_enabled: bool = True


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


class PersistDraftInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    consultation_id: str
    tenant_id: str
    content: str
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


class EscalateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    consultation_id: str
    tenant_id: str
    reason: str
    job_id: str | None = None


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
