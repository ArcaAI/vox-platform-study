"""Guardrail's peer-service client to `apps/text`.

Guardrail owns POLICY and delegates INFERENCE. This client is the whole of the
LLM half of that split: it posts one judgement to `text`'s isolated judge lane
(`POST /api/v1/generate/internal/judge`) and hands the raw output back to the
caller, which interprets it into a verdict.

What deliberately does NOT live here:

* **No engine.** No base_url per vendor, no `api_key`, no model default. The
  provider/model pair is resolved from `AiTaskDefault` (tenant row first,
  SYSTEM as the platform fallback) and passed in; the tenant's own credential
  arrives as an opaque `provider_overrides` blob that this client forwards
  VERBATIM and never decrypts, stores or logs.
* **No fail-open.** A judgement the lane never rendered raises
  :class:`~guardrail.core.errors.GuardrailUndeterminedError`, which the medical
  routes map to 503. `apps/text` gates every `/generate` on that verdict, so a
  permissive default here ships an unmoderated clinical prompt — the exact
  inversion the fail-closed sweep removed from the in-process engines.

Retry budget lives on THIS side by contract: the judge route runs zero retries
so a public generation never waits behind a compounding backoff.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, cast

from guardrail.core.breaker import BreakerOpenError, CircuitBreaker
from guardrail.core.config import JudgePolicy
from guardrail.core.errors import (
    REASON_ENGINE_ERROR,
    REASON_INVALID_RESPONSE,
    REASON_TIMEOUT,
    GuardrailUndeterminedError,
)
from guardrail.core.logging import get_logger
from guardrail.core.metrics import (
    observe_peer_latency,
    record_guardrail_call,
    track_model_inference,
)
from guardrail.providers.stats import GuardrailCallStats, normalize_stop_reason

logger = get_logger(__name__)

JUDGE_PATH = "/api/v1/generate/internal/judge"

# There is deliberately NO criteria constant here and NO keyword taxonomy.
#
# The criteria text DECIDES a clinical verdict, so it is configuration with a
# declared fail-CLOSED posture (`core/policy.py`, key `medicalValidationCriteria`,
# stored on the registry row's `_metadata.policy` and resolved through the same
# two-tier `request tenant → SYSTEM` cascade as the model selection). A judge with
# no criteria is not a lenient judge — it is no judge at all, so absence raises.
#
# The 40-term `_MEDICAL_KEYWORDS` fallback that used to live here is gone with it
# It scored the RAW MODEL OUTPUT, so a caller who could steer the
# judge into emitting prose containing two clinical words earned `is_medical: true`
# without any model having judged the input — a hardcoded taxonomy and a prompt-
# injection bypass in the same twelve lines.


def _stats_from_judge(payload: dict[str, Any], provider: str, model: str) -> GuardrailCallStats:
    """Map `text`'s `GenerationStats` onto guardrail's AD-1 mirror.

    Null-safe by contract (see `providers/stats.py`): a missing or malformed
    stats block costs the caller its telemetry, never its verdict.
    """
    raw_stats = payload.get("stats")
    stats: dict[str, Any] = raw_stats if isinstance(raw_stats, dict) else {}
    prompt_tokens = int(stats.get("prompt_tokens", 0) or 0)
    predicted = int(stats.get("predicted_tokens", stats.get("completion_tokens", 0)) or 0)
    total = stats.get("total_tokens")
    raw_stop = stats.get("stop_reason_raw") or payload.get("finish_reason") or ""
    return GuardrailCallStats(
        stop_reason=stats.get("stop_reason") or normalize_stop_reason(raw_stop),
        stop_reason_raw=str(raw_stop),
        total_ms=int(stats.get("total_ms", payload.get("latency_ms", 0)) or 0),
        ttft_ms=stats.get("ttft_ms"),
        tokens_per_second=stats.get("tokens_per_second"),
        prompt_tokens=prompt_tokens,
        predicted_tokens=predicted,
        total_tokens=int(total) if total is not None else prompt_tokens + predicted,
        provider=str(stats.get("provider") or provider),
        model=str(stats.get("model") or model),
        engine_native=(
            stats.get("engine_native") if isinstance(stats.get("engine_native"), dict) else None
        ),
    )


class TextJudgeClient:
    """The guardian, as a delegation rather than an engine.

    Exposes the same three methods the deleted in-process guardian did
    (`validate_medical_context` / `batch_validate` / `health_check`), so the
    medical routes were repointed without their wire contract moving — `text`'s
    gate maps 422-vs-503 off exactly that shape.
    """

    def __init__(
        self,
        *,
        base_url: str,
        http_client: Any,
        service_token: str,
        provider: str,
        model: str,
        tenant_id: str,
        criteria: str,
        policy: JudgePolicy | None = None,
        min_confidence: float | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        timeout_s: float | None = None,
        max_attempts: int | None = None,
        provider_overrides: dict[str, Any] | None = None,
        breaker: CircuitBreaker | None = None,
        enabled: bool = True,
    ) -> None:
        resolved_tenant = (tenant_id or "").strip()
        if not resolved_tenant:
            # Same rule as every other peer client in the monorepo: an absent
            # tenant is a CALLER defect, and a guardrail decision must be
            # attributable. Tenant-less internal work declares `tenantless:<reason>`.
            raise ValueError(
                "TextJudgeClient requires a tenant_id: the caller must forward "
                "X-Tenant-Id or declare 'tenantless:<reason>'."
            )
        resolved_criteria = (criteria or "").strip()
        if not resolved_criteria:
            # Same construction-time invariant as the tenant: a client that cannot
            # be built is a client that cannot render an unattributable or
            # uncriteria'd verdict.
            raise ValueError(
                "TextJudgeClient requires `criteria`: the text that decides the "
                "verdict is configuration (policy key 'medicalValidationCriteria', "
                "failMode=closed) and has no code default."
            )
        self.criteria = resolved_criteria
        self.policy = policy or JudgePolicy()
        self.min_confidence = (
            self.policy.min_confidence if min_confidence is None else min_confidence
        )
        self.base_url = base_url.rstrip("/")
        self.http_client = http_client
        self._service_token = service_token
        self.provider = provider
        self.model = model
        self.tenant_id = resolved_tenant
        self.temperature = self.policy.temperature if temperature is None else temperature
        self.max_tokens = self.policy.max_tokens if max_tokens is None else max_tokens
        self.timeout_s = self.policy.timeout_s if timeout_s is None else timeout_s
        self.max_attempts = self.policy.max_attempts if max_attempts is None else max_attempts
        self.provider_overrides = provider_overrides
        self.breaker = breaker
        self.enabled = enabled

    # -- wire ---------------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "X-Tenant-Id": self.tenant_id}
        if self._service_token:
            headers["X-Service-Token"] = self._service_token
        return headers

    async def _judge(self, prompt: str, system_prompt: str) -> dict[str, Any]:
        """One judgement, with a bounded retry budget. Raises when exhausted."""
        body: dict[str, Any] = {
            "prompt": prompt,
            "system_prompt": system_prompt,
            "provider": self.provider,
            "model": self.model,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "response_format": {"type": "json_object"},
        }
        if self.provider_overrides:
            body["provider_overrides"] = self.provider_overrides

        async def _once() -> dict[str, Any]:
            started = time.monotonic()
            try:
                with track_model_inference(self.model):
                    response = await self.http_client.post(
                        f"{self.base_url}{JUDGE_PATH}",
                        json=body,
                        headers=self._headers(),
                        timeout=self.timeout_s,
                    )
                    response.raise_for_status()
                return cast(dict[str, Any], response.json())
            finally:
                observe_peer_latency("text", "judge", time.monotonic() - started)

        attempts = max(1, self.max_attempts)
        last_error = ""
        timed_out = False
        for attempt in range(attempts):
            try:
                if self.breaker is not None:
                    return await self.breaker.call(_once)
                return await _once()
            except BreakerOpenError as exc:
                # Known-down peer: shed rather than amplify. Still fail-CLOSED below.
                last_error = str(exc)
                break
            except Exception as exc:  # noqa: BLE001 — every failure is fail-CLOSED below
                last_error = str(exc)
                timed_out = "timeout" in type(exc).__name__.lower()
                if attempt + 1 >= attempts:
                    break
                await asyncio.sleep(self.policy.retry_backoff_s * (attempt + 1))

        # FAIL-CLOSED. No verdict was rendered, so there is none to report — and
        # "we could not check" is never "it is fine".
        logger.error(
            "guardrail.judge.undetermined",
            provider=self.provider,
            model=self.model,
            attempts=attempts,
            error=last_error,
        )
        raise GuardrailUndeterminedError(
            REASON_TIMEOUT if timed_out else REASON_ENGINE_ERROR,
            f"text judge lane rendered no verdict: {last_error}",
        )

    # -- policy -------------------------------------------------------------

    async def validate_medical_context(
        self, text: str, include_reasoning: bool = False
    ) -> dict[str, Any]:
        """Delegate the medical-context judgement and interpret the result."""
        if not self.enabled:
            # DECLARED bypass, not a fail-open: an operator turned the guardian
            # off. Every FAILURE path raises instead.
            return {
                "is_medical": True,
                "confidence": 1.0,
                "context_type": "unknown",
                "reasoning": "Guardian validation disabled",
            }

        payload = await self._judge(
            prompt=f"Analyze this text for medical context:\n\n{text[: self.policy.max_input_chars]}",
            system_prompt=self.criteria,
        )
        content = str(payload.get("content") or "").strip()
        result = self._parse_verdict(content)

        stats = _stats_from_judge(payload, self.provider, self.model)
        result["stats"] = stats.to_dict()
        # `text` DERIVED this (BYOK vs platform credential); forwarding it verbatim
        # is the only route guardrail's spend has to the billing plane, and
        # re-deriving it here is exactly how a call site starts mis-billing.
        usage_detail = payload.get("usage_detail")
        if isinstance(usage_detail, dict):
            result["usage_detail"] = usage_detail
        record_guardrail_call(
            provider=stats.provider,
            model=stats.model,
            status="success",
            prompt_tokens=stats.prompt_tokens,
            completion_tokens=stats.predicted_tokens,
        )

        if result["confidence"] < self.min_confidence:
            # ENFORCED, not merely logged. A verdict the model is not
            # confident in is a verdict that was not rendered: returning it as if it
            # had cleared the floor made the floor decorative.
            logger.warning(
                "guardrail.judge.low_confidence",
                confidence=result["confidence"],
                threshold=self.min_confidence,
            )
            raise GuardrailUndeterminedError(
                REASON_INVALID_RESPONSE,
                f"judge confidence {result['confidence']:.2f} is below the configured "
                f"floor {self.min_confidence:.2f}",
            )
        # `include_reasoning` is honoured by the ROUTE (it shapes the response
        # DTO); the verdict itself always carries the model's reasoning so the
        # low-confidence log above has something to say.
        return result

    def _parse_verdict(self, content: str) -> dict[str, Any]:
        """Interpret the judge's JSON. A response we cannot read is UNDETERMINED.

        There is no synthesised fallback: the alternative computes an answer from
        text the model produced, which is attacker-influenceable and reads on the
        wire exactly like a judged verdict.
        """
        try:
            parsed = json.loads(content)
            confidence = max(0.0, min(1.0, float(parsed.get("confidence", 0.0))))
            return {
                "is_medical": bool(parsed.get("is_medical", False)),
                "confidence": confidence,
                "context_type": parsed.get("context_type", "unknown"),
                "reasoning": parsed.get("reasoning", ""),
            }
        except (json.JSONDecodeError, KeyError, ValueError, TypeError) as exc:
            logger.warning("guardrail.judge.invalid_response", error=type(exc).__name__)
            raise GuardrailUndeterminedError(
                REASON_INVALID_RESPONSE,
                "the judge lane returned a response that is not a parseable verdict",
            ) from exc

    async def batch_validate(self, texts: list[str]) -> list[dict[str, Any]]:
        """Validate many texts; per-item failures come back as exceptions.

        The batch route marks the failed ELEMENT rather than voiding the resolved
        ones — a multiplex cannot collapse onto one status code.
        """
        results = await asyncio.gather(
            *(self.validate_medical_context(t) for t in texts), return_exceptions=True
        )
        return cast(list[dict[str, Any]], results)

    async def health_check(self) -> dict[str, Any]:
        """Report the delegation target's reachability (never raises)."""
        try:
            response = await self.http_client.get(
                f"{self.base_url}/api/v1/health",
                headers=self._headers(),
                timeout=10.0,
            )
            response.raise_for_status()
            return {
                "healthy": True,
                "guardian_enabled": self.enabled,
                "delegate": "text",
                "provider": self.provider,
                "model": self.model,
                "base_url": self.base_url,
            }
        except Exception as exc:  # noqa: BLE001 — health never raises
            return {
                "healthy": False,
                "guardian_enabled": self.enabled,
                "delegate": "text",
                "provider": self.provider,
                "model": self.model,
                "error": str(exc),
                "base_url": self.base_url,
            }
