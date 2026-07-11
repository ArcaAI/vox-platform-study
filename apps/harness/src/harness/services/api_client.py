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
    # TASK-483 claim-check: OPTIONAL out-of-band refs for the (large) assembled prompts,
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


class DraftResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    context_item_id: str = ""


class RecordGateResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    recorded: bool = False


class FinalizeAssuranceResponse(BaseModel):
    """apps/api ack for the Phase-D ``finalize_assurance`` callback (TASK-355 Slice 4a)."""

    model_config = ConfigDict(extra="ignore")

    recorded: bool = False
    context_item_id: str = ""


class EscalationRecordResponse(BaseModel):
    """apps/api ack for the C1-05 SLA-breach escalation record (TASK-458)."""

    model_config = ConfigDict(extra="ignore")

    recorded: bool = False


class RetractDraftResponse(BaseModel):
    """apps/api ack for the TASK-481 (E2) optimistic-delivery retraction callback."""

    model_config = ConfigDict(extra="ignore")

    retracted: bool = False
    context_item_id: str = ""


class ReportProgressResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    ok: bool = False


class AssuranceEventResponse(BaseModel):
    """apps/api ack for the Phase-D Slice-5d per-claim live feed (TASK-355)."""

    model_config = ConfigDict(extra="ignore")

    ok: bool = False


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
    # TASK-476 C1 — forward the ontology codes (omit None, mirroring offsets) so
    # persistEntities writes the NamedEntity code columns.
    for wire_key, value in (
        ("umlsCui", entity.umls_cui),
        ("snomedCode", entity.snomed_code),
        ("rxnormCode", entity.rxnorm_code),
        ("icdCode", entity.icd_code),
        ("loincCode", entity.loinc_code),
    ):
        if value is not None:
            payload[wire_key] = value
    return payload


def _entity_from_payload(item: dict[str, Any]) -> NEREntity:
    """Map an apps/api camelCase ``HarnessEntityItem`` row back onto a ``NEREntity``.

    The read inverse of :func:`_entity_payload` (TASK-480 NER priors). apps/api already
    collapses the transcript-span offsets onto ``startOffset``/``endOffset`` (mirroring
    its ``loadNerEntities``), so we take those directly; the TASK-476 ontology codes
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
    )


def _prune(body: dict[str, Any]) -> dict[str, Any]:
    """Drop ``None`` values so apps/api's strict DTO validation does not choke."""
    return {k: v for k, v in body.items() if v is not None}


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
        # C1-03 (TASK-458): a deterministic idempotency key lets apps/api dedup a
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

    async def get_policy(self, tenant_id: str) -> dict[str, Any]:
        """Read the effective harness policy for ``tenant_id`` (Phase-6 worker fetch).

        Returns the raw camelCase ``HarnessPolicyResponse`` JSON; the ``fetch_policy``
        activity maps it onto :class:`~harness.temporal.models.HarnessPolicy`. Raises
        :class:`ApiServiceError` on any transport/HTTP error so the workflow can fall
        back to the code defaults.
        """
        return await self._get("/policy", {"tenantId": tenant_id})

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

    async def load_entity_priors(
        self, consultation_id: str, *, tenant_id: str
    ) -> list[NEREntity]:
        """Read the persisted ``NamedEntity`` rows for a consultation as NER priors.

        The read counterpart of :meth:`persist_entities` (TASK-480 Half-B): the harness
        reuses these already-persisted (and, once TASK-476 lands, CODED) rows as the
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
        return AssembleResponse(
            user_prompt=data.get("userPrompt", ""),
            system_prompt=data.get("systemPrompt", ""),
            hyperparameters=data.get("hyperparameters") or {},
            response_format=data.get("responseFormat"),
            prompt_template_id=data.get("promptTemplateId"),
            prompt_version=data.get("promptVersion"),
            resolved_from=data.get("resolvedFrom", ""),
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
                # TASK-355 Phase D — the optimistic early-persist discriminator.
                "phase": phase,
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
        """Backfill the early-persisted draft with the inferential verdict (TASK-355 Phase D).

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
        """Retract an optimistically-delivered draft that later failed assurance (TASK-481 E2).

        The optimistic path calls this INSTEAD of ``finalize_assurance`` when the
        post-delivery assurance pass FLAGs: apps/api marks the delivered
        ``DRAFT_PENDING_SENSORS`` draft ``RETRACTED``, writes the WORM audit (carrying the
        FLAG verdict + the offending atomic/claim refs), and surfaces a clinician-facing
        retraction event — the safety net for the accepted TASK-453 pre-assurance sign-off
        window. Idempotent on the apps/api side (a retried retraction re-marks the same
        terminal state). Raises :class:`ApiServiceError` on transport/HTTP error (the
        workflow retries under a bounded ``RetryPolicy``).

        NOTE: the apps/api endpoint that consumes this
        (``POST /internal/harness/consultations/:id/retraction`` — mark the delivered draft
        ``RETRACTED`` + WORM audit + clinician retraction event, idempotent like
        ``finalizeAssurance``) is a coordinated follow-up, out of this harness ticket's
        primary (hermetic) gate. Until it lands, an optimistic-FLAG retraction 404s → the
        activity exhausts its bounded retries → the workflow FAILS (fail-safe: the draft
        stays ``DRAFT_PENDING_SENSORS`` — it is NEVER silently affirmed to ``PENDING_REVIEW``).
        So enable the endpoint BEFORE enabling optimistic delivery in production (the
        optimistic path is itself default-OFF, so this ordering is an explicit ops rollout).
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
        """Record a gate SLA-breach escalation to apps/api (C1-05, TASK-458).

        The ``escalate_gate`` activity calls this so an SLA breach is durably recorded
        / notifiable instead of being a local log line. ``terminal=True`` marks the
        final escalation before the gate abandons (C1-02). Raises
        :class:`ApiServiceError` on transport/HTTP error; the *activity* is the layer
        that swallows it (an escalation record must never fail the clinical loop).

        NOTE: the apps/api endpoint that consumes this is a coordinated follow-up (out
        of the harness manifest) — until it lands, the POST 404s and the activity's
        best-effort guard keeps the gate waiting.
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
        """Publish one workflow stage event to the live progress feed (TASK-345).

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
        """Publish ONE resolved claim verdict to the live assurance feed (TASK-355 Slice 5d).

        Q5 true mid-pass streaming: the ``run_inferential_sensors`` activity calls
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
