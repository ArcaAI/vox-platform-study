"""Temporal activities.

Activities are where all non-deterministic work lives — network calls, model
inference, tool invocations, clock/random access. They are retryable and must
be idempotent. The workflow body (see ``workflows.py``) stays deterministic and
delegates every side effect here.

``ping_activity`` is a trivial placeholder that proves the substrate. The
document-loop activities below are thin wrappers over the typed httpx tool
clients (NLP/SMR/apps-api) + the pure sensor runner; they read settings at
runtime (allowed in activities) and construct a client per call.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from temporalio import activity

from harness.core.config import Settings, get_runtime_judge_config, get_settings
from harness.eval.judge.base import JudgeClient
from harness.eval.judge.providers import build_judge_client
from harness.sensors.base import SensorContext, SensorResult
from harness.sensors.config import SensorThresholds
from harness.sensors.inferential import (
    GROUNDEDNESS_NAME,
    SAFETY_NAME,
    GraniteGuardianClient,
    GroundednessSensor,
    SafetySensor,
)
from harness.sensors.inferential.base import degraded_result
from harness.services.api_client import (
    ApiClient,
    AssembleResponse,
    DraftResponse,
    PersistEntitiesResponse,
    RecordGateResponse,
)
from harness.services.nlp_client import NlpClient
from harness.services.sensor_runner import SensorRunOutput, run_computational_sensors
from harness.services.smr_client import SmrClient, SmrGenerationResult
from harness.temporal.models import (
    AssembleInput,
    EntitiesResult,
    EscalateInput,
    EscalateResult,
    ExtractEntitiesInput,
    GenerateInput,
    InferentialRunOutput,
    PersistDraftInput,
    PersistEntitiesInput,
    RecordGateInput,
    RunInferentialSensorsInput,
    RunSensorsInput,
)


@dataclass
class PingInput:
    """Input payload for :func:`ping_activity`."""

    message: str


@dataclass
class PingResult:
    """Result returned by :func:`ping_activity`."""

    message: str
    task_queue: str


@activity.defn
async def ping_activity(payload: PingInput) -> PingResult:
    """Return a ``pong`` for the given message.

    Any real I/O (HTTP tool calls, model inference, DB writes) belongs in
    activities like this one — never in the workflow body.
    """
    info = activity.info()
    activity.logger.info("harness.ping_activity.invoked", extra={"message": payload.message})
    return PingResult(message=f"pong: {payload.message}", task_queue=info.task_queue)


# ---------------------------------------------------------------------------
# Tool-client factories (settings read at runtime — non-deterministic, OK here)
# ---------------------------------------------------------------------------


def _nlp_client(settings: Settings) -> NlpClient:
    return NlpClient(settings.nlp_base_url, timeout=settings.nlp_timeout_s)


def _smr_client(settings: Settings) -> SmrClient:
    return SmrClient(settings.smr_base_url, timeout=settings.smr_timeout_s)


def _api_client(settings: Settings) -> ApiClient:
    return ApiClient(
        settings.api_base_url,
        internal_prefix=settings.api_internal_prefix,
        service_token=settings.service_token.get_secret_value(),
        timeout=settings.api_timeout_s,
    )


def _build_runtime_judge() -> JudgeClient:
    """Build the calibrated runtime judge (reuses the eval ``HARNESS_JUDGE_*`` config).

    Factored out (like the other client factories) so the inferential activity can
    build the judge once and the tests can monkeypatch it with a stub.
    """
    return build_judge_client(get_runtime_judge_config())


def _granite_client(settings: Settings) -> GraniteGuardianClient:
    return GraniteGuardianClient(settings.granite)


# ---------------------------------------------------------------------------
# Document-loop activities
# ---------------------------------------------------------------------------


@activity.defn
async def extract_entities(payload: ExtractEntitiesInput) -> EntitiesResult:
    """Run medical NER over ``text`` via the NLP service."""
    settings = get_settings()
    entities = await _nlp_client(settings).classify_tokens(payload.text, language=payload.language)
    return EntitiesResult(entities=entities)


@activity.defn
async def persist_entities(payload: PersistEntitiesInput) -> PersistEntitiesResponse:
    """Persist extracted NamedEntity rows via the apps/api internal endpoint."""
    settings = get_settings()
    return await _api_client(settings).persist_entities(
        payload.consultation_id,
        tenant_id=payload.tenant_id,
        context_item_id=payload.context_item_id,
        entities=payload.entities,
        user_id=payload.user_id,
    )


@activity.defn
async def assemble_prompt(payload: AssembleInput) -> AssembleResponse:
    """Resolve the prompt tier + assemble the SMR payload via apps/api."""
    settings = get_settings()
    return await _api_client(settings).assemble(
        payload.consultation_id,
        tenant_id=payload.tenant_id,
        user_id=payload.user_id,
        template=payload.template,
        dna_style_id=payload.dna_style_id,
        conversation_language=payload.conversation_language,
    )


@activity.defn
async def generate(payload: GenerateInput) -> SmrGenerationResult:
    """Generate the SOAP draft synchronously via the SMR service."""
    settings = get_settings()
    hp = payload.hyperparameters or {}
    return await _smr_client(settings).generate(
        prompt=payload.prompt,
        system_prompt=payload.system_prompt,
        provider=payload.provider,
        model=payload.model,
        temperature=hp.get("temperature"),
        max_tokens=hp.get("max_tokens"),
        top_p=hp.get("top_p"),
        response_format=payload.response_format,
    )


@activity.defn
async def run_sensors(payload: RunSensorsInput) -> SensorRunOutput:
    """Build the SensorContext + provenance and run all computational sensors."""
    return run_computational_sensors(
        note_text=payload.note_text,
        transcript_text=payload.transcript_text,
        note_entities=payload.note_entities,
        transcript_entities=payload.transcript_entities,
        response_format=payload.response_format,
        transcript_context_item_id=payload.transcript_context_item_id,
    )


def _groundedness_decision(result: SensorResult) -> dict[str, Any]:
    """Map the groundedness result to its guardrail-decision entry (regen-fixable)."""
    if result.degraded:
        return {"decision": "DEGRADED", "degraded": True, "reason": result.details.get("reason")}
    details = result.details
    return {
        # Severity class this sensor's failure maps to in the aggregator; the FINAL
        # gate verdict still depends on the regen budget.
        "decision": "PASS" if result.passed else "REGEN",
        "passed": result.passed,
        "score": round(result.score, 6),
        "ragTriadScore": details.get("rag_triad_score"),
        "ragTriad": details.get("rag_triad"),
        "sections": list(details.get("sections", [])),
        "ungrounded": list(details.get("ungrounded", [])),
        "claimsFlagged": list(result.claims_flagged),
    }


def _safety_decision(result: SensorResult) -> dict[str, Any]:
    """Map the safety result to its guardrail-decision entry (highest-harm FLAG)."""
    if result.degraded:
        return {"decision": "DEGRADED", "degraded": True, "reason": result.details.get("reason")}
    details = result.details
    return {
        "decision": "PASS" if result.passed else "FLAG",
        "passed": result.passed,
        "score": round(result.score, 6),
        "unsafe": bool(details.get("unsafe", False)),
        "flaggedDimensions": list(details.get("flagged_dimensions", [])),
        "dimensions": dict(details.get("dimensions", {})),
        "model": details.get("model"),
    }


def _assemble_inferential_output(results: list[SensorResult]) -> InferentialRunOutput:
    """Fold the inferential sensor results into the activity's typed output."""
    by_name = {r.name: r for r in results}
    guardrail_decisions: dict[str, Any] = {}
    rag_triad_score: float | None = None

    grounded = by_name.get(GROUNDEDNESS_NAME)
    if grounded is not None:
        guardrail_decisions[GROUNDEDNESS_NAME] = _groundedness_decision(grounded)
        if not grounded.degraded:
            rag_triad_score = grounded.details.get("rag_triad_score")

    safety = by_name.get(SAFETY_NAME)
    if safety is not None:
        guardrail_decisions[SAFETY_NAME] = _safety_decision(safety)

    return InferentialRunOutput(
        results=results,
        guardrail_decisions=guardrail_decisions,
        rag_triad_score=rag_triad_score,
        degraded=any(r.degraded for r in results),
    )


@activity.defn
async def run_inferential_sensors(payload: RunInferentialSensorsInput) -> InferentialRunOutput:
    """Run the costly inferential sensors (groundedness + safety) once, concurrently.

    Builds the calibrated judge + the Granite Guardian client a single time and fans
    them out via ``asyncio.gather`` (model calls live here, never in the workflow).
    Backend failures degrade rather than raise into the durable loop: each sensor
    self-degrades on a runtime backend outage, and an un-buildable judge degrades the
    whole pass. Returns the raw results + a guardrailDecisions map + ragTriadScore.
    """
    settings = get_settings()
    ctx = SensorContext(
        note_text=payload.note_text,
        transcript_text=payload.transcript_text,
        citations_map=payload.citations_map,
    )

    try:
        judge = _build_runtime_judge()
    except Exception as exc:  # noqa: BLE001 — un-buildable judge degrades, never raises
        reason = f"inferential judge unavailable: {exc}"
        return _assemble_inferential_output(
            [degraded_result(GROUNDEDNESS_NAME, reason), degraded_result(SAFETY_NAME, reason)]
        )

    threshold = SensorThresholds().groundedness_threshold
    groundedness = GroundednessSensor(threshold=threshold)
    safety = SafetySensor(_granite_client(settings))
    results = list(
        await asyncio.gather(
            groundedness.arun(ctx, judge=judge),
            safety.arun(ctx, judge=judge),
        )
    )
    return _assemble_inferential_output(results)


@activity.defn
async def persist_draft(payload: PersistDraftInput) -> DraftResponse:
    """Persist the generated draft (ContextItem + SummaryMeta + PENDING_REVIEW)."""
    settings = get_settings()
    return await _api_client(settings).persist_draft(
        payload.consultation_id,
        tenant_id=payload.tenant_id,
        content=payload.content,
        user_id=payload.user_id,
        job_id=payload.job_id,
        model_name=payload.model_name,
        model_version=payload.model_version,
        sensor_scores=payload.sensor_scores,
        citations_map=payload.citations_map,
        guardrail_decisions=payload.guardrail_decisions,
        reduced_assurance=payload.reduced_assurance,
        entity_faithfulness_score=payload.entity_faithfulness_score,
        coverage_score=payload.coverage_score,
        rag_triad_score=payload.rag_triad_score,
        prompt_template_id=payload.prompt_template_id,
        prompt_version=payload.prompt_version,
        dna_style_id=payload.dna_style_id,
        gate_decision=payload.gate_decision,
        is_auto_generated=payload.is_auto_generated,
    )


@activity.defn
async def record_gate_decision(payload: RecordGateInput) -> RecordGateResponse:
    """Record the clinician GATE_DECISION (WORM audit) via apps/api."""
    settings = get_settings()
    return await _api_client(settings).record_gate_decision(
        payload.consultation_id,
        tenant_id=payload.tenant_id,
        decision=payload.decision,
        gate_decision=payload.gate_decision,
        user_id=payload.user_id,
        context_item_version_id=payload.context_item_version_id,
        attestation_hash=payload.attestation_hash,
        clinician_id=payload.clinician_id,
    )


@activity.defn
async def escalate_gate(payload: EscalateInput) -> EscalateResult:
    """Escalate an un-signed gate past its SLA (fail-safe: log + flag, keep waiting)."""
    activity.logger.warning(
        "harness.gate.sla_breached",
        extra={
            "consultation_id": payload.consultation_id,
            "tenant_id": payload.tenant_id,
            "reason": payload.reason,
            "job_id": payload.job_id,
        },
    )
    return EscalateResult(escalated=True)


# Registered on the worker alongside ``ping_activity``.
DOCUMENT_ACTIVITIES = [
    extract_entities,
    persist_entities,
    assemble_prompt,
    generate,
    run_sensors,
    run_inferential_sensors,
    persist_draft,
    record_gate_decision,
    escalate_gate,
]
