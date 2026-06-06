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

from harness.sensors.base import NEREntity

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


class RunSensorsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    note_text: str
    transcript_text: str = ""
    note_entities: list[NEREntity] = Field(default_factory=list)
    transcript_entities: list[NEREntity] = Field(default_factory=list)
    response_format: dict[str, Any] | None = None
    transcript_context_item_id: str | None = None


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
