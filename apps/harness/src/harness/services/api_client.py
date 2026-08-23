"""apps/api internal-harness tool client (the loop's callback channel).

``apps/api`` stays the sole DB writer / system-of-record; the durable loop calls
back into it to persist entities, assemble the prompt, persist the draft, and
record the gate decision. Every call carries ``tenantId`` in the body (CLS is
re-established on the apps/api side) and the shared ``X-Service-Token`` header.

The mount is ``{base_url}{internal_prefix}`` — ``internal_prefix`` is configurable
because Lane G owns the exact mount (its controller sits under the global
``/api/v1`` prefix, i.e. ``/api/v1/internal/harness``; the plan documents the
shorter ``/internal/harness``).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, cast

import httpx
from pydantic import BaseModel, ConfigDict, Field

from harness.sensors.base import NEREntity, normalize_text
from harness.temporal.claim_check import ClaimCheckRef
from harness.temporal.models import SegmentCitationRef


class ApiServiceError(RuntimeError):
    """apps/api was unreachable or returned a non-2xx response."""


class PersistEntitiesResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    saved_count: int = 0
    entity_ids: list[str] = Field(default_factory=list)


class AssembleResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    user_prompt: str = ""
    system_prompt: str = ""
    # OPTIONAL out-of-band refs for the (large) assembled prompts,
    # carried alongside the inline fields for the ``generate`` activity to resolve. The
    # ``assemble_prompt`` activity may offload above the threshold (inline emptied). The
    # apps/api assemble response never carries these (extra="ignore" drops unknowns); they
    # are populated harness-side. Additive-optional ⇒ replay-safe.
    user_prompt_ref: ClaimCheckRef | None = None
    system_prompt_ref: ClaimCheckRef | None = None
    hyperparameters: dict[str, Any] = Field(default_factory=dict)
    response_format: dict[str, Any] | None = None
    prompt_template_id: str | None = None
    prompt_version: str | None = None
    resolved_from: str = ""
    # PHI-safe segment citation refs from apps/api assemble (id/idx/
    # speaker/t0/t1 only). Empty (default, and every legacy response) ⇒ generate
    # folds no segment StrictCitations block ⇒ byte-identical prompt, replay-safe.
    segment_citations: list[SegmentCitationRef] = Field(default_factory=list)


class ResolvedPromptTemplateResponse(BaseModel):
    """apps/api response for ``GET /prompt-templates/:id/resolved`` (TASK-720 N-2).

    ``found: False`` covers a missing OR cross-tenant id (404-over-403 — the gateway's tenant-
    scope extension already makes a foreign-tenant row read as "not found"). ``found: True,
    approved: False`` covers a template that exists but has never been approved. Both are
    legitimate "no prompt to resolve" outcomes for the ``prompt.template_ref`` node activity to
    fail closed on — never an ``ApiServiceError``.
    """

    model_config = ConfigDict(extra="ignore")

    found: bool = False
    approved: bool = False
    content: str = ""
    version_number: int | None = None


class DraftResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    context_item_id: str = ""


class RecordGateResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    recorded: bool = False


class FinalizeAssuranceResponse(BaseModel):
    """apps/api ack for the ``finalize_assurance`` callback (optimistic-delivery second phase)."""

    model_config = ConfigDict(extra="ignore")

    recorded: bool = False
    context_item_id: str = ""


class EscalationRecordResponse(BaseModel):
    """apps/api ack for the SLA-breach escalation record."""

    model_config = ConfigDict(extra="ignore")

    recorded: bool = False


class RetractDraftResponse(BaseModel):
    """apps/api ack for the optimistic-delivery retraction callback."""

    model_config = ConfigDict(extra="ignore")

    retracted: bool = False
    context_item_id: str = ""


class ReportProgressResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    ok: bool = False


class AssuranceEventResponse(BaseModel):
    """apps/api ack for the per-claim live assurance feed."""

    model_config = ConfigDict(extra="ignore")

    ok: bool = False


class TrajectoryStepInput(BaseModel):
    """One ordered trajectory step — snake_case on the Python
    side, camelCase on the wire (:meth:`to_wire`).

    The harness emits a batch of these per phase boundary via
    :meth:`ApiClient.report_trajectory`; the (later) apps/api wave persists them to
    ``AgentTrajectoryStep``. ``session_id``/``run_id`` are the Temporal
    workflow/run ids; ``seq`` is the workflow-owned monotonic order. Stats-first /
    payload-by-reference (PHI posture): ``stats`` carries the ``GenerationStats``
    on ``LLM_CALL`` steps, ``payload_ref`` stays null unless a capture-payload policy
    flag is on (not yet).
    """

    model_config = ConfigDict(extra="forbid")

    tenant_id: str
    consultation_id: str | None = None
    session_kind: str = "HARNESS_DOC"
    session_id: str
    run_id: str
    seq: int
    step_type: str
    name: str
    status: str
    started_at: str
    ended_at: str | None = None
    # Integer milliseconds — the apps/api ingest DTO validates `durationMs` as an
    # int (column is `Int?`); the emitter rounds before constructing this.
    duration_ms: int | None = None
    stats: dict[str, Any] | None = None
    payload_ref: dict[str, Any] | None = None
    error_code: str | None = None
    correlation_id: str | None = None

    def to_wire(self) -> dict[str, Any]:
        """camelCase wire object with ``None`` optionals pruned (strict apps/api DTO)."""
        return _prune(
            {
                "tenantId": self.tenant_id,
                "consultationId": self.consultation_id,
                "sessionKind": self.session_kind,
                "sessionId": self.session_id,
                "runId": self.run_id,
                "seq": self.seq,
                "stepType": self.step_type,
                "name": self.name,
                "status": self.status,
                "startedAt": self.started_at,
                "endedAt": self.ended_at,
                "durationMs": self.duration_ms,
                "stats": self.stats,
                "payloadRef": self.payload_ref,
                "errorCode": self.error_code,
                "correlationId": self.correlation_id,
            }
        )


class TrajectoryReportResponse(BaseModel):
    """apps/api ack for a batched trajectory report."""

    model_config = ConfigDict(extra="ignore")

    accepted: int = 0


def _entity_payload(entity: NEREntity, context_item_id: str | None) -> dict[str, Any]:
    """Map a Lane H ``NEREntity`` to Lane G's camelCase ``HarnessEntityItem``.

    The NER offsets are transcript offsets (NLP ran on the transcript), so they
    populate both the source offsets and the transcript-span provenance fields.
    """
    payload: dict[str, Any] = {
        "text": entity.text,
        "type": entity.type,
        "normalizedText": normalize_text(entity.text),
    }
    if entity.start >= 0:
        payload["startOffset"] = entity.start
    if entity.end >= 0:
        payload["endOffset"] = entity.end
    if context_item_id:
        payload["transcriptContextItemId"] = context_item_id
        if entity.start >= 0:
            payload["transcriptStartOffset"] = entity.start
        if entity.end >= 0:
            payload["transcriptEndOffset"] = entity.end
    # Forward the ontology codes (omit None, mirroring offsets) so
    # persistEntities writes the NamedEntity code columns.
    for wire_key, value in (
        ("umlsCui", entity.umls_cui),
        ("snomedCode", entity.snomed_code),
        ("rxnormCode", entity.rxnorm_code),
        ("icdCode", entity.icd_code),
        ("loincCode", entity.loinc_code),
        # forward the assertion polarity (omit None ⇒ PRESENT default).
        ("assertion", entity.assertion),
    ):
        if value is not None:
            payload[wire_key] = value
    return payload


def _entity_from_payload(item: dict[str, Any]) -> NEREntity:
    """Map an apps/api camelCase ``HarnessEntityItem`` row back onto a ``NEREntity``.

    The read inverse of :func:`_entity_payload` (NER priors). apps/api already
    collapses the transcript-span offsets onto ``startOffset``/``endOffset`` (mirroring
    its ``loadNerEntities``), so we take those directly; the ontology codes
    carry through so the caller can gate reuse on ``coded``.
    """

    def _offset(value: Any) -> int:
        return int(value) if value is not None else -1

    return NEREntity(
        text=item.get("text", ""),
        type=item.get("type", ""),
        start=_offset(item.get("startOffset")),
        end=_offset(item.get("endOffset")),
        umls_cui=item.get("umlsCui"),
        snomed_code=item.get("snomedCode"),
        rxnorm_code=item.get("rxnormCode"),
        icd_code=item.get("icdCode"),
        loinc_code=item.get("loincCode"),
        assertion=item.get("assertion"),
    )


def _prune(body: dict[str, Any]) -> dict[str, Any]:
    """Drop ``None`` values so apps/api's strict DTO validation does not choke."""
    return {k: v for k, v in body.items() if v is not None}


class SttBatchJobResponse(BaseModel):
    """apps/api ``POST/GET /internal/harness/stt/batch-jobs`` response (TASK-724 Task 5)."""

    model_config = ConfigDict(extra="ignore")

    job_id: str = Field(alias="jobId")
    status: str
    progress: int = 0
    error_message: str | None = Field(default=None, alias="errorMessage")
    error_code: str | None = Field(default=None, alias="errorCode")


class ApiClient:
    """Thin async client for the apps/api ``/internal/harness/*`` endpoints."""

    def __init__(
        self,
        base_url: str,
        *,
        internal_prefix: str = "/internal/harness",
        service_token: str = "",
        timeout: float = 30.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._prefix = "/" + internal_prefix.strip("/")
        self._service_token = service_token
        self._timeout = timeout
        self._transport = transport

    def _url(self, path: str) -> str:
        return f"{self._base_url}{self._prefix}{path}"

    def _headers(self, idempotency_key: str | None = None) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "X-Service-Token": self._service_token}
        # A deterministic idempotency key lets apps/api dedup a
        # retried POST (Temporal ``_API_RETRY`` re-POSTs a lost ack) instead of
        # double-writing the WORM audit / draft. Omitted (None) => header absent.
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return headers

    async def _post(
        self, path: str, body: dict[str, Any], *, idempotency_key: str | None = None
    ) -> dict[str, Any]:
        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
            try:
                resp = await client.post(
                    self._url(path), json=body, headers=self._headers(idempotency_key)
                )
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                raise ApiServiceError(f"apps/api {path} failed: {exc}") from exc
            return cast("dict[str, Any]", resp.json())

    async def _get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
            try:
                resp = await client.get(self._url(path), params=params, headers=self._headers())
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                raise ApiServiceError(f"apps/api {path} failed: {exc}") from exc
            return cast("dict[str, Any]", resp.json())

    async def get_policy(
        self,
        tenant_id: str,
        consultation_id: str | None = None,
        task_key: str | None = None,
    ) -> dict[str, Any]:
        """Read the effective harness policy for ``tenant_id`` (worker fetch).

                Returns the raw camelCase ``HarnessPolicyResponse`` JSON; the ``fetch_policy``
                activity maps it onto :class:`~harness.temporal.models.HarnessPolicy`. Raises
        :class:`ApiServiceError` on any transport/HTTP error so the workflow can fall
                back to the code defaults.

                when ``consultation_id`` is supplied it is threaded onto the query
                so the gateway overlays the consultation's department default
                ``DepartmentAgent`` tenant-tier ``harnessOverrides`` (most specific wins). The
                response SHAPE is unchanged (same keys, different values, plus an additive
                ``overridesSource`` provenance field). Omitted ⇒ byte-identical prior
                request, so other gateway callers are unaffected.

                TASK-740 D-1: when ``task_key`` is supplied the gateway resolves
                ``textProvider``/``textModel`` from the ``AiTaskDefault`` row for THAT key
                (tenant → SYSTEM) instead of serving the ``HarnessPolicy`` columns. This is
                what makes a workflow node's ``config.taskKey`` actually select a model;
                without it every node resolved the same one. Omitted ⇒ unchanged behaviour.
        """
        params: dict[str, Any] = {"tenantId": tenant_id}
        if consultation_id:
            params["consultationId"] = consultation_id
        if task_key:
            params["taskKey"] = task_key
        return await self._get("/policy", params)

    async def get_resolved_prompt_template(
        self, template_id: str, *, tenant_id: str
    ) -> ResolvedPromptTemplateResponse:
        """Resolve a ``PromptTemplate``'s pinned APPROVED version (TASK-720 N-2 worker fetch).

        Raises :class:`ApiServiceError` only on a transport/HTTP failure — a missing template,
        a cross-tenant id, or a never-approved template are all ordinary ``found``/``approved``
        `False` results, never an exception (see :class:`ResolvedPromptTemplateResponse`).
        """
        data = await self._get(f"/prompt-templates/{template_id}/resolved", {"tenantId": tenant_id})
        return ResolvedPromptTemplateResponse(
            found=bool(data.get("found", False)),
            approved=bool(data.get("approved", False)),
            content=data.get("content") or "",
            version_number=data.get("versionNumber"),
        )

    async def resolve_mcp_token(self, auth_ref: str) -> str | None:
        """Resolve an MCP server credential by its registered ``authRef``.

        The harness holds NO Vault client by design — secret material
        stays on the gateway side of the boundary, which already has one. The
        gateway allowlists ``auth_ref`` against registered, ENABLED ``McpServer``
        rows, so this is not an arbitrary secret-path read.

        Returns ``None`` when the gateway declines to resolve the ref (unregistered,
        disabled, or unreadable). Callers treat that as "no credential" and call the
        server unauthenticated, not a hard failure.

        Raises :class:`ApiServiceError` on transport/HTTP failure; the caller in
        ``activities`` degrades that to ``None`` so a bounded tool call can never
        take the loop down.
        """
        response = await self._get("/mcp-token", {"authRef": auth_ref})
        token = response.get("token")
        return token if isinstance(token, str) and token else None

    async def persist_entities(
        self,
        consultation_id: str,
        *,
        tenant_id: str,
        context_item_id: str | None,
        entities: Sequence[NEREntity],
        user_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> PersistEntitiesResponse:
        body = _prune(
            {
                "tenantId": tenant_id,
                "userId": user_id,
                "contextItemId": context_item_id,
                "entities": [_entity_payload(e, context_item_id) for e in entities],
            }
        )
        data = await self._post(
            f"/consultations/{consultation_id}/entities", body, idempotency_key=idempotency_key
        )
        return PersistEntitiesResponse(
            saved_count=int(data.get("savedCount", 0)),
            entity_ids=list(data.get("entityIds", [])),
        )

    async def load_entity_priors(self, consultation_id: str, *, tenant_id: str) -> list[NEREntity]:
        """Read the persisted ``NamedEntity`` rows for a consultation as NER priors.

        The read counterpart of :meth:`persist_entities`: the harness
        reuses these already-persisted (and, once coded, CODED) rows as the
        transcript NER priors instead of re-extracting cold. Maps the apps/api camelCase
        ``HarnessEntityItem`` rows back onto :class:`NEREntity` (incl. the ontology
        codes). Raises :class:`ApiServiceError` on any transport/HTTP error so the caller
        can fall back to the cold extraction (priors are an optimization, never a hard
        dependency).
        """
        data = await self._get(
            f"/consultations/{consultation_id}/entities", {"tenantId": tenant_id}
        )
        return [_entity_from_payload(e) for e in data.get("entities", [])]

    async def create_stt_batch_job(
        self,
        *,
        tenant_id: str,
        pipeline_id: str,
        audio_uri: str,
        consultation_id: str | None = None,
        media_id: str | None = None,
        language: str | None = None,
    ) -> SttBatchJobResponse:
        """N-5 `POST /internal/harness/stt/batch-jobs` (TASK-724 Task 5).

        Dispatches through the EXISTING `TranscriptionJobService` /
        `TranscriptionRealtimeService` write path apps/api's own batch-transcription
        surface already uses — no second job-processing path in harness. Idempotent
        on the apps/api side: a retried call with the same ``consultation_id`` +
        ``pipeline_id`` finds and returns the already-dispatched non-terminal job
        instead of creating a second one, so this method is safe to call from a
        retriable Temporal activity as-is.
        """
        body = _prune(
            {
                "tenantId": tenant_id,
                "pipelineId": pipeline_id,
                "audioUri": audio_uri,
                "consultationId": consultation_id,
                "mediaId": media_id,
                "language": language,
            }
        )
        data = await self._post("/stt/batch-jobs", body)
        return SttBatchJobResponse.model_validate(data)

    async def get_stt_batch_job_status(self, job_id: str, *, tenant_id: str) -> SttBatchJobResponse:
        """N-5 `GET /internal/harness/stt/batch-jobs/{id}` (TASK-724 Task 5) — the
        batch-dispatch activity's poll call. Bounded, terminal-state polling only;
        never a stream (a Temporal activity is not a long-lived connection)."""
        data = await self._get(f"/stt/batch-jobs/{job_id}", {"tenantId": tenant_id})
        return SttBatchJobResponse.model_validate(data)

    async def assemble(
        self,
        consultation_id: str,
        *,
        tenant_id: str,
        user_id: str | None = None,
        template: str | None = None,
        dna_style_id: str | None = None,
        conversation_language: str | None = None,
    ) -> AssembleResponse:
        body = _prune(
            {
                "tenantId": tenant_id,
                "userId": user_id,
                "template": template,
                "dnaStyleId": dna_style_id,
                "conversationLanguage": conversation_language,
            }
        )
        data = await self._post(f"/consultations/{consultation_id}/assemble", body)
        raw_segs = data.get("segmentCitations") or []
        segment_citations: list[SegmentCitationRef] = []
        if isinstance(raw_segs, list):
            for item in raw_segs:
                if not isinstance(item, dict):
                    continue
                seg_id = item.get("id")
                if not isinstance(seg_id, str) or not seg_id:
                    continue
                idx_raw = item.get("idx")
                segment_citations.append(
                    SegmentCitationRef(
                        id=seg_id,
                        speaker=item.get("speaker"),
                        t0_ms=item.get("t0Ms"),
                        t1_ms=item.get("t1Ms"),
                        idx=idx_raw if isinstance(idx_raw, int) else None,
                    )
                )
        return AssembleResponse(
            user_prompt=data.get("userPrompt", ""),
            system_prompt=data.get("systemPrompt", ""),
            hyperparameters=data.get("hyperparameters") or {},
            response_format=data.get("responseFormat"),
            prompt_template_id=data.get("promptTemplateId"),
            prompt_version=data.get("promptVersion"),
            resolved_from=data.get("resolvedFrom", ""),
            segment_citations=segment_citations,
        )

    async def persist_draft(
        self,
        consultation_id: str,
        *,
        tenant_id: str,
        content: str,
        user_id: str | None = None,
        job_id: str | None = None,
        model_name: str | None = None,
        model_version: str | None = None,
        sensor_scores: dict[str, Any] | None = None,
        citations_map: dict[str, Any] | None = None,
        guardrail_decisions: dict[str, Any] | None = None,
        reduced_assurance: bool | None = None,
        entity_faithfulness_score: float | None = None,
        coverage_score: float | None = None,
        rag_triad_score: float | None = None,
        prompt_template_id: str | None = None,
        prompt_version: str | None = None,
        dna_style_id: str | None = None,
        gate_decision: str | None = None,
        is_auto_generated: bool | None = None,
        phase: str | None = None,
        redaction_applied: bool | None = None,
        redaction_manifest: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> DraftResponse:
        body = _prune(
            {
                "tenantId": tenant_id,
                "userId": user_id,
                "jobId": job_id,
                "content": content,
                "modelName": model_name,
                "modelVersion": model_version,
                "sensorScores": sensor_scores,
                "citationsMap": citations_map,
                "guardrailDecisions": guardrail_decisions,
                "reducedAssurance": reduced_assurance,
                "entityFaithfulnessScore": entity_faithfulness_score,
                "coverageScore": coverage_score,
                "ragTriadScore": rag_triad_score,
                "promptTemplateId": prompt_template_id,
                "promptVersion": prompt_version,
                "dnaStyleId": dna_style_id,
                "gateDecision": gate_decision,
                "isAutoGenerated": is_auto_generated,
                # The optimistic early-persist discriminator.
                "phase": phase,
                # DNA redaction/rewrite audit. Pruned when None (every
                # pre-audit-era persist), so the body stays byte-identical there.
                "redactionApplied": redaction_applied,
                "redactionManifest": redaction_manifest,
            }
        )
        data = await self._post(
            f"/consultations/{consultation_id}/draft", body, idempotency_key=idempotency_key
        )
        return DraftResponse(context_item_id=data.get("contextItemId", ""))

    async def finalize_assurance(
        self,
        consultation_id: str,
        *,
        tenant_id: str,
        context_item_id: str,
        context_item_version_id: str | None = None,
        user_id: str | None = None,
        job_id: str | None = None,
        sensor_scores: dict[str, Any] | None = None,
        citations_map: dict[str, Any] | None = None,
        guardrail_decisions: dict[str, Any] | None = None,
        reduced_assurance: bool | None = None,
        rag_triad_score: float | None = None,
        gate_decision: str | None = None,
        model_name: str | None = None,
        model_version: str | None = None,
        prompt_template_id: str | None = None,
        prompt_version: str | None = None,
        idempotency_key: str | None = None,
    ) -> FinalizeAssuranceResponse:
        """Backfill the early-persisted draft with the inferential verdict.

        The optimistic path calls this AFTER the assurance pass to complete the
        two-phase delivery: apps/api stamps the inferential scores + gate verdict +
        ``assuranceCompletedAt`` onto the early ``SummaryMeta``, flips
        ``DRAFT_PENDING_SENSORS → PENDING_REVIEW``, and records the deferred
        ``SENSOR_RUN`` (+ ``REDUCED_ASSURANCE``) WORM audit. Raises
        :class:`ApiServiceError` on transport/HTTP error (the workflow retries).
        """
        body = _prune(
            {
                "tenantId": tenant_id,
                "userId": user_id,
                "jobId": job_id,
                "contextItemId": context_item_id,
                "contextItemVersionId": context_item_version_id,
                "sensorScores": sensor_scores,
                "citationsMap": citations_map,
                "guardrailDecisions": guardrail_decisions,
                "reducedAssurance": reduced_assurance,
                "ragTriadScore": rag_triad_score,
                "gateDecision": gate_decision,
                "modelName": model_name,
                "modelVersion": model_version,
                "promptTemplateId": prompt_template_id,
                "promptVersion": prompt_version,
            }
        )
        data = await self._post(
            f"/consultations/{consultation_id}/assurance", body, idempotency_key=idempotency_key
        )
        return FinalizeAssuranceResponse(
            recorded=bool(data.get("recorded", False)),
            context_item_id=data.get("contextItemId", ""),
        )

    async def record_gate_decision(
        self,
        consultation_id: str,
        *,
        tenant_id: str,
        decision: str | None = None,
        gate_decision: str | None = None,
        user_id: str | None = None,
        context_item_version_id: str | None = None,
        attestation_hash: str | None = None,
        clinician_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> RecordGateResponse:
        body = _prune(
            {
                "tenantId": tenant_id,
                "userId": user_id,
                "decision": decision,
                "gateDecision": gate_decision,
                "contextItemVersionId": context_item_version_id,
                "attestationHash": attestation_hash,
                "clinicianId": clinician_id,
            }
        )
        data = await self._post(
            f"/consultations/{consultation_id}/gate-decision", body, idempotency_key=idempotency_key
        )
        return RecordGateResponse(recorded=bool(data.get("recorded", False)))

    async def retract_draft(
        self,
        consultation_id: str,
        *,
        tenant_id: str,
        context_item_id: str,
        context_item_version_id: str | None = None,
        gate_decision: str | None = None,
        reason: str | None = None,
        claims_flagged: Sequence[str] | None = None,
        sensor_scores: dict[str, Any] | None = None,
        guardrail_decisions: dict[str, Any] | None = None,
        reduced_assurance: bool | None = None,
        rag_triad_score: float | None = None,
        user_id: str | None = None,
        job_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> RetractDraftResponse:
        """Retract an optimistically-delivered draft that later failed assurance.

        The optimistic path calls this INSTEAD of ``finalize_assurance`` when the
        post-delivery assurance pass FLAGs: apps/api marks the delivered
        ``DRAFT_PENDING_SENSORS`` draft ``RETRACTED``, writes the WORM audit (carrying the
        FLAG verdict + the offending atomic/claim refs), and surfaces a clinician-facing
        retraction event — the safety net for the accepted pre-assurance sign-off
        window. Idempotent on the apps/api side (a retried retraction re-marks the same
        terminal state). Raises :class:`ApiServiceError` on transport/HTTP error (the
        workflow retries under a bounded ``RetryPolicy``).

        NOTE: the apps/api endpoint that consumes this
        (``POST /internal/harness/consultations/:id/retraction`` — mark the delivered draft
        ``RETRACTED`` + WORM audit + clinician retraction event, idempotent like
        ``finalizeAssurance``) has not landed on the apps/api side yet. Until it lands, an
        optimistic-FLAG retraction 404s → the activity exhausts its bounded retries → the
        workflow FAILS (fail-safe: the draft stays ``DRAFT_PENDING_SENSORS`` — it is NEVER
        silently affirmed to ``PENDING_REVIEW``). So enable the endpoint BEFORE enabling
        optimistic delivery in production (the optimistic path is itself default-OFF, so
        this ordering is an explicit ops rollout).
        """
        body = _prune(
            {
                "tenantId": tenant_id,
                "userId": user_id,
                "jobId": job_id,
                "contextItemId": context_item_id,
                "contextItemVersionId": context_item_version_id,
                "gateDecision": gate_decision,
                "reason": reason,
                "claimsFlagged": list(claims_flagged) if claims_flagged is not None else None,
                "sensorScores": sensor_scores,
                "guardrailDecisions": guardrail_decisions,
                "reducedAssurance": reduced_assurance,
                "ragTriadScore": rag_triad_score,
            }
        )
        data = await self._post(
            f"/consultations/{consultation_id}/retraction", body, idempotency_key=idempotency_key
        )
        return RetractDraftResponse(
            retracted=bool(data.get("retracted", False)),
            context_item_id=data.get("contextItemId", ""),
        )

    async def record_escalation(
        self,
        consultation_id: str,
        *,
        tenant_id: str,
        reason: str,
        escalation_count: int | None = None,
        terminal: bool | None = None,
        job_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> EscalationRecordResponse:
        """Record a gate SLA-breach escalation to apps/api.

        The ``escalate_gate`` activity calls this so an SLA breach is durably recorded
        / notifiable instead of being a local log line. ``terminal=True`` marks the
        final escalation before the gate abandons. Raises
        :class:`ApiServiceError` on transport/HTTP error; the *activity* is the layer
        that swallows it (an escalation record must never fail the clinical loop).

        NOTE: if the apps/api endpoint that consumes this has not landed yet, the
        POST 404s and the activity's best-effort guard keeps the gate waiting.
        """
        body = _prune(
            {
                "tenantId": tenant_id,
                "jobId": job_id,
                "reason": reason,
                "escalationCount": escalation_count,
                "terminal": terminal,
            }
        )
        data = await self._post(
            f"/consultations/{consultation_id}/escalation", body, idempotency_key=idempotency_key
        )
        return EscalationRecordResponse(recorded=bool(data.get("recorded", False)))

    async def report_progress(
        self,
        consultation_id: str,
        *,
        tenant_id: str,
        stage: str,
        label: str | None = None,
        ordinal: int | None = None,
        total: int | None = None,
        job_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> ReportProgressResponse:
        """Publish one workflow stage event to the live progress feed.

        Raises :class:`ApiServiceError` like every other method; the
        ``report_progress`` *activity* is the layer that swallows errors —
        progress is best-effort and must never fail the workflow.
        """
        body = _prune(
            {
                "tenantId": tenant_id,
                "jobId": job_id,
                "stage": stage,
                "label": label,
                "ordinal": ordinal,
                "total": total,
            }
        )
        data = await self._post(
            f"/consultations/{consultation_id}/progress", body, idempotency_key=idempotency_key
        )
        return ReportProgressResponse(ok=bool(data.get("ok", False)))

    async def get_loop_config(self, consultation_id: str, *, tenant_id: str) -> dict[str, Any]:
        """Read the PINNABLE loop configuration for one consultation.

                Returns the raw camelCase ``LoopConfigResponse`` JSON; the
                ``fetch_loop_config`` activity maps it onto
        :class:`~harness.temporal.models.ConsultationLoopConfig`. The gateway
                answers a DISABLED config (rather than 404) for a consultation with no
                agent/schema configured and for a cross-tenant id — so this method
                raises only on a genuine transport/HTTP failure.
        """
        return await self._get(
            "/loop-config", {"tenantId": tenant_id, "consultationId": consultation_id}
        )

    async def extract_document_text(
        self,
        consultation_id: str,
        *,
        context_item_id: str,
        tenant_id: str,
    ) -> str:
        """Read the extracted text of a DOCUMENT context item.

        The gateway already owns document extraction — `OcrEnrichmentProcessor`
        runs OCR and NLP `/extract` on attachment upload — so the
        `document.extract_text` action ASKS for that result rather than opening a
        second, divergent extraction path with its own storage credentials and
        its own PHI egress surface.

        Returns `""` when nothing has been extracted, which simply ends that
        branch of the cascade. Raises only on a genuine transport/HTTP failure.
        """
        data = await self._get(
            f"/consultations/{consultation_id}/context-items/{context_item_id}/extracted-text",
            {"tenantId": tenant_id},
        )
        text = data.get("text")
        return text if isinstance(text, str) else ""

    async def live_documentation_start(
        self,
        consultation_id: str,
        *,
        tenant_id: str,
        user_id: str | None = None,
        session_id: str | None = None,
    ) -> bool:
        """Dispatch the reflex lane: ``LiveDocumentationService.start``.

        The loop DISPATCHES live documentation; it never absorbs it. Idempotent gateway-side — restarting an existing session re-binds
        the STT stream without losing accumulated state.
        """
        body = _prune({"tenantId": tenant_id, "userId": user_id, "sessionId": session_id})
        data = await self._post(f"/consultations/{consultation_id}/live-documentation/start", body)
        return bool(data.get("ok", False))

    async def live_documentation_stop(
        self,
        consultation_id: str,
        *,
        tenant_id: str,
        persist_snapshot: bool = True,
    ) -> bool:
        """Dispatch ``LiveDocumentationService.stop``."""
        body = _prune({"tenantId": tenant_id, "persistSnapshot": persist_snapshot})
        data = await self._post(f"/consultations/{consultation_id}/live-documentation/stop", body)
        return bool(data.get("ok", False))

    async def publish_live_summary(
        self,
        consultation_id: str,
        *,
        tenant_id: str,
        running_summary: str,
        sections: list[dict[str, str]],
        source: str = "interpreter",
        node_type: str | None = None,
        ordinal: int | None = None,
        total: int | None = None,
        provider: str | None = None,
        model: str | None = None,
        task_key: str | None = None,
        user_id: str | None = None,
        job_id: str | None = None,
        run_id: str | None = None,
    ) -> bool:
        """Publish ONE interim running summary onto the EXISTING live-summary plane.

        ``POST {internal_prefix}/consultations/{id}/live-summary`` — the gateway relays the body
        verbatim onto ``consultation:live-summary:{id}``, the same Redis channel
        ``LiveDocumentationService`` publishes its own flushes on, so the already-shipped SSE
        route, the already-shipped ``useArcaLiveSummary`` hook and the already-shipped console
        panel render an interpreter-produced summary with no new consumer surface.

        **This channel deliberately carries clinical text.** That is what separates it from
        ``consultation:loop:{id}``, which carries ids/keys/labels only
        (:class:`~harness.temporal.models.EmitLoopEventInput`) and must never be widened to
        carry a summary. Both are tenant-guarded per-consultation SSE streams; only this one is
        a PHI transport, and it already was one before this method existed.

        Raises :class:`ApiServiceError` like every other method — the CALLING NODE is the
        swallow layer, exactly as it already is for ``report_loop_event``: a live feed must
        never cost the work that produced it.
        """
        body = _prune(
            {
                "tenantId": tenant_id,
                "runningSummary": running_summary,
                "sections": sections,
                "source": source,
                "nodeType": node_type,
                "ordinal": ordinal,
                "total": total,
                "provider": provider,
                "model": model,
                "taskKey": task_key,
                "userId": user_id,
                "jobId": job_id,
                "runId": run_id,
            }
        )
        data = await self._post(f"/consultations/{consultation_id}/live-summary", body)
        return bool(data.get("ok", False))

    async def publish_live_assist(
        self,
        consultation_id: str,
        *,
        tenant_id: str,
        kind: str,
        node_type: str | None = None,
        suggestions: list[dict[str, Any]] | None = None,
        corrections: dict[str, Any] | None = None,
        provider: str | None = None,
        model: str | None = None,
        user_id: str | None = None,
        job_id: str | None = None,
        run_id: str | None = None,
    ) -> bool:
        """Publish clinician-facing SUGGESTIONS or correction PROPOSALS.

        ``POST {internal_prefix}/consultations/{id}/live-assist`` → the gateway relays onto
        ``consultation:live-assist:{id}``. A separate plane from the running summary because the
        payload is not a summary: each item is an actionable proposal with its own id and a
        ``PROPOSED`` status the clinician resolves. Reusing ``live-summary`` would force the
        summary panel to re-render on every suggestion tick, and reusing the loop plane is
        forbidden outright — a correction proposal necessarily quotes clinical text.

        ``kind`` discriminates the envelope: ``"suggestions"`` carries ``suggestions``,
        ``"corrections"`` carries ``corrections``. Same swallow posture as
        :meth:`publish_live_summary` — the caller absorbs the error, never the loop.
        """
        body = _prune(
            {
                "tenantId": tenant_id,
                "kind": kind,
                "nodeType": node_type,
                "suggestions": suggestions,
                "corrections": corrections,
                "provider": provider,
                "model": model,
                "userId": user_id,
                "jobId": job_id,
                "runId": run_id,
            }
        )
        data = await self._post(f"/consultations/{consultation_id}/live-assist", body)
        return bool(data.get("ok", False))

    async def report_loop_event(
        self,
        consultation_id: str,
        *,
        tenant_id: str,
        event_type: str,
        run_id: str | None = None,
        context_item_id: str | None = None,
        kind_key: str | None = None,
        action: str | None = None,
        reason: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> bool:
        """Publish one loop event on ``consultation:loop:{id}`` (the plane).

                Ids/keys/labels only — NEVER note or transcript text. Raises
        :class:`ApiServiceError` like every other method; the ``emit_loop_event``
                *activity* is the layer that swallows errors, because a live UI feed must
                never fail the loop.

                The wire body is EXACTLY ``HarnessLoopEventRequest``
                (``tenantId``/``runId``/``kind``/``label``/``data``) from The
                gateway's global ``ValidationPipe`` runs ``forbidNonWhitelisted``, so
                every loop-specific field (the context item, the kind key, the action,
                the skip reason) is folded into the declared ``data`` envelope rather
                than added as a top-level key — an undeclared field would 400 the whole
                publish.
        """
        payload: dict[str, Any] = {
            "contextItemId": context_item_id,
            "kindKey": kind_key,
            "action": action,
            "reason": reason,
        }
        if detail:
            payload.update(detail)
        envelope = {key: value for key, value in payload.items() if value is not None}
        body = _prune(
            {
                "tenantId": tenant_id,
                "runId": run_id,
                "kind": event_type,
                "data": envelope or None,
            }
        )
        data = await self._post(f"/consultations/{consultation_id}/loop-event", body)
        return bool(data.get("ok", False))

    async def report_assurance_event(
        self,
        consultation_id: str,
        *,
        tenant_id: str,
        claim_id: str,
        sensor: str,
        verdict: str,
        label: str | None = None,
        ordinal: int | None = None,
        total: int | None = None,
        job_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> AssuranceEventResponse:
        """Publish ONE resolved claim verdict to the live assurance feed.

        True mid-pass streaming: the ``run_inferential_sensors`` activity calls
        this AS EACH claim's verdict resolves. Raises :class:`ApiServiceError` like
        every other method; the *activity*'s per-claim callback is the layer that
        swallows errors — the live feed must never fail the assurance pass.
        """
        body = _prune(
            {
                "tenantId": tenant_id,
                "jobId": job_id,
                "claimId": claim_id,
                "sensor": sensor,
                "verdict": verdict,
                "label": label,
                "ordinal": ordinal,
                "total": total,
            }
        )
        data = await self._post(
            f"/consultations/{consultation_id}/assurance-event",
            body,
            idempotency_key=idempotency_key,
        )
        return AssuranceEventResponse(ok=bool(data.get("ok", False)))

    async def report_trajectory(
        self,
        steps: Sequence[TrajectoryStepInput],
        *,
        idempotency_key: str | None = None,
    ) -> TrajectoryReportResponse:
        """Publish a BATCH of ordered trajectory steps.

        POSTs ``{"steps": [...]}`` to the NEW gateway route
        ``POST {internal_prefix}/trajectory`` (service-token auth, like every other
        method). Raises :class:`ApiServiceError` on transport/HTTP error; the harness
        ACTIVITY is the fire-and-forget swallow layer (a trajectory/gateway outage must
        NEVER fail the clinical loop — same posture as ``report_progress``), and it
        batches at phase boundaries to bound the call count. The optional
        ``Idempotency-Key`` lets apps/api dedup a retried/redelivered batch.
        """
        body = {"steps": [s.to_wire() for s in steps]}
        data = await self._post("/trajectory", body, idempotency_key=idempotency_key)
        return TrajectoryReportResponse(accepted=int(data.get("accepted", 0)))
