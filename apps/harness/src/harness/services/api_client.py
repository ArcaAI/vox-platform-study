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
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field

from harness.sensors.base import NEREntity, normalize_text


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
    return payload


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
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._prefix = "/" + internal_prefix.strip("/")
        self._service_token = service_token
        self._timeout = timeout
        self._transport = transport

    def _url(self, path: str) -> str:
        return f"{self._base_url}{self._prefix}{path}"

    def _headers(self) -> dict[str, str]:
        return {"Content-Type": "application/json", "X-Service-Token": self._service_token}

    async def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
            try:
                resp = await client.post(self._url(path), json=body, headers=self._headers())
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                raise ApiServiceError(f"apps/api {path} failed: {exc}") from exc
            return resp.json()

    async def persist_entities(
        self,
        consultation_id: str,
        *,
        tenant_id: str,
        context_item_id: str | None,
        entities: Sequence[NEREntity],
        user_id: str | None = None,
    ) -> PersistEntitiesResponse:
        body = _prune(
            {
                "tenantId": tenant_id,
                "userId": user_id,
                "contextItemId": context_item_id,
                "entities": [_entity_payload(e, context_item_id) for e in entities],
            }
        )
        data = await self._post(f"/consultations/{consultation_id}/entities", body)
        return PersistEntitiesResponse(
            saved_count=int(data.get("savedCount", 0)),
            entity_ids=list(data.get("entityIds", [])),
        )

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
            }
        )
        data = await self._post(f"/consultations/{consultation_id}/draft", body)
        return DraftResponse(context_item_id=data.get("contextItemId", ""))

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
        data = await self._post(f"/consultations/{consultation_id}/gate-decision", body)
        return RecordGateResponse(recorded=bool(data.get("recorded", False)))
