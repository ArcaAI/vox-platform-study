"""Guardrail analysis endpoints."""

from __future__ import annotations

import time
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from guardrail.core.config import Settings
from guardrail.core.dependencies import get_gliner_provider, get_job_processor, get_settings

router = APIRouter()


class GuardrailRequest(BaseModel):
    """Request model for guardrail analysis."""

    text: str = Field(..., description="Text to analyze for content safety")
    guardrail_type: str = Field(
        default="comprehensive",
        description="Type of guardrail check: content_safety, pii_detection, prompt_injection, comprehensive",
    )
    request_id: str | None = Field(None, description="Optional request ID for tracking")
    priority: str = Field(
        default="normal",
        description="Priority level: low, normal, high",
    )


class GuardrailResponse(BaseModel):
    """Response model for guardrail analysis."""

    safe: bool = Field(..., description="Whether the content is safe")
    issues: list[str] = Field(default_factory=list, description="List of detected issues")
    confidence: float = Field(..., description="Confidence score (0.0-1.0)")
    processing_time_ms: float = Field(..., description="Processing time in milliseconds")
    request_id: str = Field(..., description="Request ID for tracking")
    timestamp: str = Field(..., description="Analysis timestamp")
    error: str | None = Field(None, description="Error message if analysis failed")


class BatchGuardrailRequest(BaseModel):
    """Request model for batch guardrail analysis."""

    texts: list[str] = Field(..., description="List of texts to analyze")
    guardrail_type: str = Field(
        default="comprehensive",
        description="Type of guardrail check",
    )
    request_id: str | None = Field(None, description="Optional request ID for tracking")


@router.post("/guardrail/analyze", response_model=GuardrailResponse)
async def analyze_content(
    request: GuardrailRequest,
    settings: Settings = Depends(get_settings),
    gliner_provider=Depends(get_gliner_provider),
) -> GuardrailResponse:
    """Analyze content for safety issues in real-time."""
    start_time = time.monotonic()

    try:
        result = await gliner_provider.analyze_content(
            text=request.text,
            guardrail_type=request.guardrail_type,
        )

        processing_time = (time.monotonic() - start_time) * 1000

        return GuardrailResponse(
            safe=result.get("safe", True),
            issues=result.get("issues", []),
            confidence=result.get("confidence", 0.0),
            processing_time_ms=processing_time,
            request_id=request.request_id or f"req_{int(time.time() * 1000)}",
            timestamp=datetime.now(UTC).isoformat(),
            error=result.get("error"),
        )

    except Exception as e:
        processing_time = (time.monotonic() - start_time) * 1000

        return GuardrailResponse(
            safe=True,  # Fail open
            issues=["processing_error"],
            confidence=0.0,
            processing_time_ms=processing_time,
            request_id=request.request_id or f"req_{int(time.time() * 1000)}",
            timestamp=datetime.now(UTC).isoformat(),
            error=str(e),
        )


@router.post("/guardrail/analyze/batch", response_model=list[GuardrailResponse])
async def analyze_batch(
    request: BatchGuardrailRequest,
    settings: Settings = Depends(get_settings),
    gliner_provider=Depends(get_gliner_provider),
) -> list[GuardrailResponse]:
    """Analyze multiple texts for safety issues."""
    start_time = time.monotonic()

    try:
        results = await gliner_provider.batch_analyze(
            texts=request.texts,
            guardrail_type=request.guardrail_type,
        )

        processing_time = (time.monotonic() - start_time) * 1000

        responses = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                responses.append(
                    GuardrailResponse(
                        safe=True,  # Fail open
                        issues=["processing_error"],
                        confidence=0.0,
                        processing_time_ms=processing_time / len(request.texts),
                        request_id=f"{request.request_id or 'batch'}_{i}",
                        timestamp=datetime.now(UTC).isoformat(),
                        error=str(result),
                    )
                )
            else:
                responses.append(
                    GuardrailResponse(
                        safe=result.get("safe", True),
                        issues=result.get("issues", []),
                        confidence=result.get("confidence", 0.0),
                        processing_time_ms=processing_time / len(request.texts),
                        request_id=f"{request.request_id or 'batch'}_{i}",
                        timestamp=datetime.now(UTC).isoformat(),
                        error=result.get("error"),
                    )
                )

        return responses

    except Exception as e:
        processing_time = (time.monotonic() - start_time) * 1000

        return [
            GuardrailResponse(
                safe=True,  # Fail open
                issues=["processing_error"],
                confidence=0.0,
                processing_time_ms=processing_time / len(request.texts),
                request_id=f"{request.request_id or 'batch'}_{i}",
                timestamp=datetime.now(UTC).isoformat(),
                error=str(e),
            )
            for i in range(len(request.texts))
        ]


@router.post("/guardrail/analyze/async", response_model=dict[str, str])
async def analyze_content_async(
    request: GuardrailRequest,
    job_processor=Depends(get_job_processor),
) -> dict[str, str]:
    """Submit content for asynchronous guardrail analysis."""
    try:
        job_id = await job_processor.submit_job(
            text=request.text,
            guardrail_type=request.guardrail_type,
            request_id=request.request_id,
            priority=request.priority,
        )

        return {
            "job_id": job_id,
            "status": "submitted",
            "message": "Guardrail analysis job submitted successfully",
        }

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to submit guardrail analysis job: {str(e)}",
        ) from e


@router.get("/guardrail/types", response_model=dict[str, str])
async def get_guardrail_types() -> dict[str, str]:
    """Get available guardrail analysis types."""
    return {
        "comprehensive": "Full content safety analysis (harmful content, PII, prompt injection, inappropriate language)",
        "content_safety": "Harmful and dangerous content detection",
        "pii_detection": "Personally identifiable information detection",
        "prompt_injection": "Prompt injection and manipulation attempts",
    }
