"""External Guardrail client for SMR V2."""

from __future__ import annotations

from typing import Any

import httpx

from smr_v2.core.config import ExternalGuardrailConfig
from smr_v2.core.logging import get_logger

logger = get_logger(__name__)


class ExternalGuardrailClient:
    """Calls the Guardrail service for medical-content validation."""

    def __init__(
        self,
        *,
        settings: ExternalGuardrailConfig,
        http_client: httpx.AsyncClient,
    ) -> None:
        self.settings = settings
        self.http_client = http_client
        self.base_url = settings.base_url.rstrip("/")

    async def validate(
        self,
        prompt: str,
        system_prompt: str | None = None,
        tenant_id: str | None = None,
    ) -> dict[str, Any]:
        if not self.settings.enabled:
            return {
                "allowed": True,
                "is_medical": True,
                "confidence": 1.0,
                "reason": "external_guardrail_disabled",
            }

        text = prompt if not system_prompt else f"{system_prompt}\n\n{prompt}"
        headers: dict[str, str] = {"Content-Type": "application/json"}
        service_token = self.settings.service_token.get_secret_value()
        if service_token:
            headers["X-Service-Token"] = service_token
        # Forward the consultation tenant so guardrail can resolve per-tenant
        # provider/model from the DB (TASK-338, OQ1).
        if tenant_id:
            headers["X-Tenant-Id"] = tenant_id

        try:
            response = await self.http_client.post(
                f"{self.base_url}/api/medical/validate",
                json={
                    "text": text,
                    "include_reasoning": self.settings.include_reasoning,
                },
                headers=headers,
                timeout=self.settings.timeout_s,
            )
            response.raise_for_status()
            payload = response.json()
            is_medical = bool(payload.get("is_medical", False))
            return {
                "allowed": is_medical if self.settings.require_medical else True,
                "is_medical": is_medical,
                "confidence": float(payload.get("confidence", 0.0)),
                "reason": payload.get("reasoning") or payload.get("error") or "medical_validation_completed",
                "raw": payload,
            }
        except Exception as exc:
            logger.error("external_guardrail.request_failed", error=str(exc), base_url=self.base_url)
            if self.settings.fail_open:
                return {
                    "allowed": True,
                    "is_medical": True,
                    "confidence": 0.0,
                    "reason": "external_guardrail_failed_open",
                }
            return {
                "allowed": False,
                "is_medical": False,
                "confidence": 0.0,
                "reason": "external_guardrail_unavailable",
                "error": str(exc),
            }
