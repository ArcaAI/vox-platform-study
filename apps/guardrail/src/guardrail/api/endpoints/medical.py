"""Medical validation endpoints for Guardian service."""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from guardrail.core.config import Settings
from guardrail.core.dependencies import (
    get_guardian_provider,
    get_resolved_guardian_provider,
    get_settings,
)
from guardrail.providers.openai_compat import OpenAICompatGuardianProvider

router = APIRouter()

GuardianLike = OpenAICompatGuardianProvider


class MedicalValidationRequest(BaseModel):
    """Request model for medical context validation."""

    text: str = Field(..., description="Text to validate for medical context")
    request_id: str | None = Field(None, description="Optional request ID for tracking")
    include_reasoning: bool = Field(False, description="Include reasoning in response")


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
    # peer service — SMR posts to it directly, with no gateway in between — so
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
    """
    start_time = time.monotonic()

    try:
        result = await guardian_provider.validate_medical_context(
            text=request.text,
            include_reasoning=request.include_reasoning,
        )

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

    except Exception as e:
        processing_time = (time.monotonic() - start_time) * 1000

        return MedicalValidationResponse(
            is_medical=True,  # Fail open
            confidence=0.0,
            context_type="unknown",
            reasoning="Validation error occurred",
            matched_keywords=None,
            processing_time_ms=processing_time,
            request_id=request.request_id or f"med_val_{int(time.time() * 1000)}",
            timestamp=datetime.now(UTC).isoformat(),
            error=str(e),
            stats=None,
        )


@router.post("/medical/validate/batch", response_model=list[MedicalValidationResponse])
async def validate_batch_medical_context(
    request: BatchMedicalValidationRequest,
    settings: Settings = Depends(get_settings),
    guardian_provider: GuardianLike = Depends(get_resolved_guardian_provider),
) -> list[MedicalValidationResponse]:
    """Validate multiple texts for medical context."""
    start_time = time.monotonic()

    try:
        results = await guardian_provider.batch_validate(request.texts)

        processing_time = (time.monotonic() - start_time) * 1000

        responses = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                responses.append(
                    MedicalValidationResponse(
                        is_medical=True,  # Fail open
                        confidence=0.0,
                        context_type="unknown",
                        reasoning="Validation error",
                        matched_keywords=None,
                        processing_time_ms=processing_time / len(request.texts),
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
                        processing_time_ms=processing_time / len(request.texts),
                        request_id=f"{request.request_id or 'batch'}_{i}",
                        timestamp=datetime.now(UTC).isoformat(),
                        error=result.get("error"),
                        stats=_stats_of(result),
                    )
                )

        return responses

    except Exception as e:
        processing_time = (time.monotonic() - start_time) * 1000

        return [
            MedicalValidationResponse(
                is_medical=True,  # Fail open
                confidence=0.0,
                context_type="unknown",
                reasoning="Batch validation error",
                matched_keywords=None,
                processing_time_ms=processing_time / len(request.texts),
                request_id=f"{request.request_id or 'batch'}_{i}",
                timestamp=datetime.now(UTC).isoformat(),
                error=str(e),
                stats=None,
            )
            for i in range(len(request.texts))
        ]


@router.get("/medical/config", response_model=dict[str, Any])
async def get_medical_validation_config(
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Get current medical validation configuration."""
    engine = settings.engine
    return {
        "provider": settings.provider,
        "guardian_enabled": engine.guardian_enabled,
        "guardian_model": engine.guardian_model,
        "min_confidence": engine.guardian_min_confidence,
        "temperature": engine.guardian_temperature,
        "max_tokens": engine.guardian_max_tokens,
    }


@router.get("/medical/health", response_model=dict[str, Any])
async def medical_validation_health(
    guardian_provider: GuardianLike = Depends(get_guardian_provider),
) -> dict[str, Any]:
    """Check medical validation service health."""
    health = await guardian_provider.health_check()

    return {
        "status": "healthy" if health.get("healthy") else "unhealthy",
        "timestamp": datetime.now(UTC).isoformat(),
        **health,
    }
