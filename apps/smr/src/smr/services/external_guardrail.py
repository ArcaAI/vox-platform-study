"""External Guardrail client for SMR."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from smr.core.config import ExternalGuardrailConfig
from smr.core.logging import get_logger

logger = get_logger(__name__)

# Deterministic verdict reason emitted when the guardrail is unreachable after the
# bounded retry budget is exhausted. The /generate gate maps this to a retryable 503
# (distinct from a 422 content rejection). This path NEVER yields ``allowed: True``.
GUARDRAIL_UNAVAILABLE_REASON = "external_guardrail_unavailable"


class ExternalGuardrailClient:
    """Calls the Guardrail service for medical-content validation.

    Fail posture (degrade-safe → fail-CLOSED): a transient error is
    absorbed by a bounded retry (``max_retries`` / ``retry_backoff_ms``); once the
    budget is exhausted the client returns a deterministic NOT-allowed verdict — an
    errored guardrail can NEVER return ``allowed: True`` (there is no fail-open
    branch). The only allow-without-check path is the intentional ``enabled=False``
    dev/CI bypass, preserved exactly (mirrors the empty-token bypass).
    """

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
        # provider/model from the DB.
        if tenant_id:
            headers["X-Tenant-Id"] = tenant_id

        # Bounded retry: total tries = max_retries + 1. A transient blip is
        # absorbed (a clean re-check proceeds); only a sustained outage exhausts the
        # budget and fails CLOSED below.
        #
        # Latency ceiling: under a HANG-style outage (each attempt burns the full
        # timeout_s) worst-case added latency is bounded but non-trivial —
        # ~= (max_retries + 1) * timeout_s + sum(backoff) ~= 30s at the defaults
        # (3 * 10s + 0.3s) before the 503. The degrade-safe path therefore relies on
        # the CALLER's own request timeout as the outer bound; do not raise the
        # defaults without accounting for this ceiling.
        attempts = self.settings.max_retries + 1
        last_error = ""
        for attempt in range(attempts):
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
                last_error = str(exc)
                is_last = attempt + 1 >= attempts
                logger.warning(
                    "external_guardrail.attempt_failed",
                    attempt=attempt + 1,
                    attempts=attempts,
                    error=last_error,
                    base_url=self.base_url,
                    will_retry=not is_last,
                )
                if is_last:
                    break
                backoff_s = (self.settings.retry_backoff_ms / 1000.0) * (attempt + 1)
                if backoff_s > 0:
                    await asyncio.sleep(backoff_s)

        # Bounded retry exhausted → fail CLOSED with a deterministic not-allowed
        # verdict. There is deliberately no fail-open branch: an errored guardrail can
        # never ship an unmoderated PHI prompt. The gate maps this reason to a
        # retryable 503.
        logger.error(
            "external_guardrail.exhausted_fail_closed",
            attempts=attempts,
            error=last_error,
            base_url=self.base_url,
        )
        return {
            "allowed": False,
            "is_medical": False,
            "confidence": 0.0,
            "reason": GUARDRAIL_UNAVAILABLE_REASON,
            "error": last_error,
        }
