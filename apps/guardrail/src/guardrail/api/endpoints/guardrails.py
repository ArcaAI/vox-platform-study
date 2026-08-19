"""Guardrail analysis endpoints.

Fail posture — FAIL-CLOSED. HTTP 200 is reserved for a verdict a model actually
rendered, so ``safe: true`` on this wire always means something computed it. A verdict
that could not be computed is **503** on the single-item routes (retryable, and distinct
from a content rejection — ``apps/text``'s gate maps a not-allowed 200 to a 422) and, on
the batch route, a per-element ``safe=false, issues=["undetermined"]``, because a
multiplex cannot collapse to one status code. See ``guardrail.core.errors``.

Every route here carries tenant-scoped work, so ``X-Tenant-Id`` is mandatory (428).
"""

from __future__ import annotations

import time
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from guardrail.core.dependencies import (
    ModelUnavailableError,
    get_job_processor,
    get_safety_analyzer,
    require_tenant_id,
)
from guardrail.core.errors import ISSUE_UNDETERMINED, GuardrailUndeterminedError
from guardrail.core.logging import get_logger
from guardrail.services.job_processor import JobProcessor
from guardrail.services.safety_analyzer import SafetyAnalyzer

logger = get_logger(__name__)

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
    issues: list[str] = Field(
        default_factory=list, description="List of detected issues"
    )
    confidence: float = Field(..., description="Confidence score (0.0-1.0)")
    processing_time_ms: float = Field(
        ..., description="Processing time in milliseconds"
    )
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
    http_request: Request,
    analyzer: SafetyAnalyzer = Depends(get_safety_analyzer),
) -> GuardrailResponse:
    """Analyze content for safety issues in real-time.

    The models are DB-selected (``guardrail.safety`` + ``guardrail.pii``, tenant-first)
    and RUN IN ``apps/nlp`` (TASK-735 Phase 3); a missing selection or taxonomy fails
    closed with 503 (raised by ``get_safety_analyzer`` before this body). A delegation
    failure ALSO fails closed with 503 — this route can never answer 200/``safe`` for a
    check that did not run.
    """
    start_time = time.monotonic()

    try:
        result = await analyzer.analyze_content(
            text=request.text,
            guardrail_type=request.guardrail_type,
        )
    except GuardrailUndeterminedError as exc:
        raise HTTPException(status_code=503, detail=exc.as_detail()) from exc
    except ModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        # FAIL-CLOSED backstop. PHI-safe: log the error TYPE, never the analysed text.
        logger.error("guardrail.analyze.failed", error=type(exc).__name__)
        raise HTTPException(
            status_code=503,
            detail="guardrail analysis failed — refusing to report 'safe'",
        ) from exc

    processing_time = (time.monotonic() - start_time) * 1000

    return GuardrailResponse(
        # `False` default, not `True`: an absent key is a missing verdict, not a pass.
        safe=result.get("safe", False),
        issues=result.get("issues", []),
        confidence=result.get("confidence", 0.0),
        processing_time_ms=processing_time,
        request_id=request.request_id or f"req_{int(time.time() * 1000)}",
        timestamp=datetime.now(UTC).isoformat(),
        error=result.get("error"),
    )


@router.post("/guardrail/analyze/batch", response_model=list[GuardrailResponse])
async def analyze_batch(
    request: BatchGuardrailRequest,
    http_request: Request,
    analyzer: SafetyAnalyzer = Depends(get_safety_analyzer),
) -> list[GuardrailResponse]:
    """Analyze multiple texts for safety issues (DB-selected, delegated to `apps/nlp`).

    A batch is a multiplex: one unresolved element must neither void the resolved ones
    nor collapse the response to a single status code. So an element whose verdict could
    not be computed comes back ``safe=false, issues=["undetermined"]`` — fail-closed, and
    still distinguishable from a genuine content violation by the issue tag. A failure
    that prevents the WHOLE batch from running is a 503, as on the single-item route.
    """
    start_time = time.monotonic()

    try:
        results = await analyzer.batch_analyze(
            texts=request.texts,
            guardrail_type=request.guardrail_type,
        )
    except ModelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("guardrail.analyze_batch.failed", error=type(exc).__name__)
        raise HTTPException(
            status_code=503,
            detail="guardrail batch analysis failed — refusing to report 'safe'",
        ) from exc

    processing_time = (time.monotonic() - start_time) * 1000
    per_item_ms = (
        processing_time / len(request.texts) if request.texts else processing_time
    )

    responses = []
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            logger.error(
                "guardrail.analyze_batch.item_undetermined", error=type(result).__name__
            )
            responses.append(
                GuardrailResponse(
                    safe=False,  # FAIL-CLOSED: no verdict is not a pass
                    issues=[ISSUE_UNDETERMINED],
                    confidence=0.0,
                    processing_time_ms=per_item_ms,
                    request_id=f"{request.request_id or 'batch'}_{i}",
                    timestamp=datetime.now(UTC).isoformat(),
                    error=str(result),
                )
            )
        else:
            responses.append(
                GuardrailResponse(
                    safe=result.get("safe", False),
                    issues=result.get("issues", []),
                    confidence=result.get("confidence", 0.0),
                    processing_time_ms=per_item_ms,
                    request_id=f"{request.request_id or 'batch'}_{i}",
                    timestamp=datetime.now(UTC).isoformat(),
                    error=result.get("error"),
                )
            )

    return responses


@router.post("/guardrail/analyze/async", response_model=dict[str, str])
async def analyze_content_async(
    request: GuardrailRequest,
    http_request: Request,
    job_processor: JobProcessor = Depends(get_job_processor),
) -> dict[str, str]:
    """Submit content for asynchronous guardrail analysis.

    The submitting tenant is STAMPED ON THE JOB. Jobs used to run with
    ``tenant_id=None`` ("jobs carry no tenant"), which meant an async analysis silently
    resolved the SYSTEM floor and its decision was unattributable. A job outliving its
    request is not a reason to forget whose decision it was.
    """
    tenant_id = require_tenant_id(http_request)
    try:
        job_id = await job_processor.submit_job(
            text=request.text,
            guardrail_type=request.guardrail_type,
            request_id=request.request_id,
            priority=request.priority,
            tenant_id=tenant_id,
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
