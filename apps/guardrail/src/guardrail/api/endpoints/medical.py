"""Medical validation endpoints for Guardian service.

Fail posture — FAIL-CLOSED. A validation that never reached a verdict is **503** on
``/medical/validate`` and a per-element ``is_medical=false`` on the batch route; it is
never ``is_medical=true``. This matters concretely: ``apps/text`` gates every
``/generate`` on this endpoint with ``require_medical``, so the old
``is_medical=True  # Fail open on timeout`` shipped an unmoderated PHI prompt whenever
the guardian was slow. 503 rather than a 200 carrying ``is_medical=false`` because
``text`` maps a not-allowed 200 to a **422 content rejection** and a transport failure to
a retryable **503** — a timeout is the latter, and telling a clinician their note was
rejected on its content would be a lie.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from guardrail.core.config import Settings
from guardrail.core.dependencies import (
    get_resolved_guardian_provider,
    get_settings,
)
from guardrail.core.errors import GuardrailUndeterminedError
from guardrail.core.logging import get_logger
from guardrail.services.external_text_client import TextJudgeClient

logger = get_logger(__name__)

router = APIRouter()

# The "guardian" is a DELEGATION, not an engine: guardrail owns the criteria, the
# confidence floor and the verdict shape; `apps/text` runs the model.
GuardianLike = TextJudgeClient


#: The connection blob a caller forwards for the DELEGATED judge (TASK-890).
#:
#: Guardrail hosts no engine: `/medical/validate` is answered by a judgement it
#: delegates to `apps/text`, and `apps/text` holds no endpoint or credential of
#: its own — every connection reaches it as `provider_overrides` the gateway
#: resolved. Guardrail is a PEER service with no gateway in front of it, so the
#: only path that blob has into the judge call is the caller's own request body.
#: Before this field existed the judge always posted without one and `text`
#: answered 503 `PROVIDER_CREDENTIALS_MISSING` on every guardrail-enabled
#: generation.
#:
#: OPAQUE in both directions: guardrail never decrypts it, never stores it and
#: never logs it — `core/dependencies._provider_overrides` lifts it off the parsed
#: body and the judge client forwards it VERBATIM. ABSENT is meaningful and must
#: stay absent: it is what makes the resolver fall back to the engine connection
#: it can read for itself (`core/tenant_config._judge_connection`).
_PROVIDER_OVERRIDES_FIELD = Field(
    None,
    description=(
        "Connection(s) the caller resolved for the delegated judge, forwarded "
        "verbatim to apps/text. Never inspected, stored or logged here."
    ),
)


class MedicalValidationRequest(BaseModel):
    """Request model for medical context validation."""

    text: str = Field(..., description="Text to validate for medical context")
    request_id: str | None = Field(None, description="Optional request ID for tracking")
    include_reasoning: bool = Field(False, description="Include reasoning in response")
    provider_overrides: dict[str, Any] | None = _PROVIDER_OVERRIDES_FIELD


class MedicalValidationResponse(BaseModel):
    """Response model for medical context validation."""

    is_medical: bool = Field(..., description="Whether the content is medical-related")
    confidence: float = Field(..., description="Confidence score (0.0-1.0)")
    context_type: str = Field(..., description="Type of context: clinical/administrative/general")
    reasoning: str | None = Field(None, description="Explanation of the validation result")
    matched_keywords: list[str] | None = Field(
        None, description="Medical keywords found (if using fallback)"
    )
    processing_time_ms: float = Field(..., description="Processing time in milliseconds")
    request_id: str = Field(..., description="Request ID for tracking")
    timestamp: str = Field(..., description="Validation timestamp")
    error: str | None = Field(None, description="Error message if validation failed")
    # Guardrail's OWN per-call LLM usage (``GuardrailCallStats``). Guardrail is a
    # peer service — TEXT posts to it directly, with no gateway in between — so
    # riding back on this response is the only path its token spend has to the
    # billing plane. ``None`` when no model was reached (disabled, error,
    # keyword fallback): a zero-token block would be indistinguishable from a
    # free call. Metered for COGS; never quota-blocked, never invoiced (D16).
    stats: dict[str, Any] | None = Field(
        None, description="Per-call LLM usage stats for this validation, when a model was invoked"
    )


class BatchMedicalValidationRequest(BaseModel):
    """Request model for batch medical validation."""

    texts: list[str] = Field(..., description="List of texts to validate")
    request_id: str | None = Field(None, description="Optional request ID for tracking")
    provider_overrides: dict[str, Any] | None = _PROVIDER_OVERRIDES_FIELD


def _stats_of(result: dict[str, Any]) -> dict[str, Any] | None:
    """Lift a provider's per-call usage stats off a validation result.

    Every guardian provider attaches ``stats`` when it actually invoked a model.
    A result without it (validation disabled, keyword fallback, an error path)
    yields ``None`` — reporting zeros there would tell the billing plane the call
    was free rather than that it never happened.
    """
    stats = result.get("stats") if isinstance(result, dict) else None
    return stats if isinstance(stats, dict) else None


@router.post("/medical/validate", response_model=MedicalValidationResponse)
async def validate_medical_context(
    request: MedicalValidationRequest,
    settings: Settings = Depends(get_settings),
    guardian_provider: GuardianLike = Depends(get_resolved_guardian_provider),
) -> MedicalValidationResponse:
    """
    Validate if text contains medical context using the Guardian model.

    This is the primary endpoint for medical context validation.
    Use this before sending content to medical documentation services.

    Fails closed with 503 when no verdict could be computed (see the module docstring).

    ``provider_overrides`` does not appear in this signature and is not read here:
    the guardian is built by the dependency ABOVE the handler, so the connection
    has to reach it earlier than the parsed model does. It travels through
    `core/dependencies._provider_overrides`, which reads `request.state` first and
    the already-parsed body second (TASK-890). Declaring the field on the request
    model is still what makes it part of this route's CONTRACT rather than an
    undocumented key a caller has to know about.
    """
    start_time = time.monotonic()

    try:
        result = await guardian_provider.validate_medical_context(
            text=request.text,
            include_reasoning=request.include_reasoning,
        )
    except GuardrailUndeterminedError as exc:
        raise HTTPException(status_code=503, detail=exc.as_detail()) from exc
    except Exception as exc:
        # FAIL-CLOSED backstop. PHI-safe: the error TYPE only, never the validated text.
        logger.error("guardrail.medical_validate.failed", error=type(exc).__name__)
        raise HTTPException(
            status_code=503,
            detail="medical validation failed — refusing to report 'is_medical'",
        ) from exc

    processing_time = (time.monotonic() - start_time) * 1000

    return MedicalValidationResponse(
        is_medical=result.get("is_medical", False),
        confidence=result.get("confidence", 0.0),
        context_type=result.get("context_type", "unknown"),
        reasoning=result.get("reasoning") if request.include_reasoning else None,
        matched_keywords=result.get("matched_keywords"),
        processing_time_ms=processing_time,
        request_id=request.request_id or f"med_val_{int(time.time() * 1000)}",
        timestamp=datetime.now(UTC).isoformat(),
        error=result.get("error"),
        stats=_stats_of(result),
    )


@router.post("/medical/validate/batch", response_model=list[MedicalValidationResponse])
async def validate_batch_medical_context(
    request: BatchMedicalValidationRequest,
    settings: Settings = Depends(get_settings),
    guardian_provider: GuardianLike = Depends(get_resolved_guardian_provider),
) -> list[MedicalValidationResponse]:
    """Validate multiple texts for medical context.

    Per-element fail-closed, for the same reason as ``/guardrail/analyze/batch``: a
    multiplex cannot collapse to one status code, so an unresolved element is
    ``is_medical=false`` rather than voiding the resolved ones.

    Same body-carried connection, same dependency, as the single route above — a
    batch judged on a different connection from a single call would be the kind of
    split the one delegation path exists to prevent.
    """
    start_time = time.monotonic()

    try:
        results = await guardian_provider.batch_validate(request.texts)
    except Exception as exc:
        logger.error("guardrail.medical_validate_batch.failed", error=type(exc).__name__)
        raise HTTPException(
            status_code=503,
            detail="medical batch validation failed — refusing to report 'is_medical'",
        ) from exc

    processing_time = (time.monotonic() - start_time) * 1000
    per_item_ms = processing_time / len(request.texts) if request.texts else processing_time

    responses = []
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            logger.error(
                "guardrail.medical_validate_batch.item_undetermined",
                error=type(result).__name__,
            )
            responses.append(
                MedicalValidationResponse(
                    is_medical=False,  # FAIL-CLOSED: no verdict is not "medical"
                    confidence=0.0,
                    context_type="unknown",
                    reasoning="Validation undetermined",
                    matched_keywords=None,
                    processing_time_ms=per_item_ms,
                    request_id=f"{request.request_id or 'batch'}_{i}",
                    timestamp=datetime.now(UTC).isoformat(),
                    error=str(result),
                    stats=None,
                )
            )
        else:
            responses.append(
                MedicalValidationResponse(
                    is_medical=result.get("is_medical", False),
                    confidence=result.get("confidence", 0.0),
                    context_type=result.get("context_type", "unknown"),
                    reasoning=result.get("reasoning"),
                    matched_keywords=result.get("matched_keywords"),
                    processing_time_ms=per_item_ms,
                    request_id=f"{request.request_id or 'batch'}_{i}",
                    timestamp=datetime.now(UTC).isoformat(),
                    error=result.get("error"),
                    stats=_stats_of(result),
                )
            )

    return responses


@router.get("/medical/config", response_model=dict[str, Any])
async def get_medical_validation_config(
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Report the medical-validation POLICY.

    Provider and model are deliberately absent: they are resolved per TENANT at
    request time from ``AiTaskDefault``, so there is no one answer to report from
    a process-wide config route.

    ``temperature`` and ``max_tokens`` left for the SAME reason in TASK-878 — they
    are now fail-CLOSED keys on the selected model row's ``_metadata.policy``, so
    they too have no process-wide answer. ``timeout_s`` left because it is served
    per process by the control plane (``guardrail.judge.timeoutSeconds``), and a
    snapshot read is an async call this synchronous report has no business making.
    Each is reported here as WHERE it resolves, which is what an operator asking
    this route actually needs.
    """
    judge = settings.judge
    return {
        "delegate": "text",
        "min_confidence": judge.min_confidence,
        "max_attempts": judge.max_attempts,
        "resolved_per_request": {
            "provider": "AiTaskDefault (tenant → SYSTEM)",
            "model": "AiTaskDefault (tenant → SYSTEM)",
            "temperature": "AiModel._metadata.policy.judgeTemperature (failMode: closed)",
            "max_tokens": "AiModel._metadata.policy.judgeMaxTokens (failMode: closed)",
            "timeout_s": "guardrail.judge.timeoutSeconds (global-kv, effective-config)",
        },
    }


@router.get("/medical/health", response_model=dict[str, Any])
async def medical_validation_health(
    guardian_provider: GuardianLike = Depends(get_resolved_guardian_provider),
) -> dict[str, Any]:
    """Check medical validation health — i.e. the delegation to ``apps/text``.

    Uses the RESOLVED guardian (so it reports the tenant's own selection and
    honours the same 428 / veto / fail-closed rules as the validate route)
    instead of a process-wide env-configured engine, which no longer exists.
    """
    health = await guardian_provider.health_check()

    return {
        "status": "healthy" if health.get("healthy") else "unhealthy",
        "timestamp": datetime.now(UTC).isoformat(),
        **health,
    }
