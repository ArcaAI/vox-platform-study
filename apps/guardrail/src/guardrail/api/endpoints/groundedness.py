"""Live output-moderation + groundedness endpoint.

``POST /guardrail/ground`` verifies a generated summary against its source transcript with
the self-hosted NLI verifier and returns per-segment verdicts + flagged spans so ungrounded
text is MARKED before a clinician reads it. Sits behind the ``X-Service-Token`` middleware
exactly like ``/guardrail/analyze`` and ``/medical/validate`` (nothing here is exempt).

Fail posture — FAIL-CLOSED, the deliberate inverse of the legacy fail-open ``analyze`` /
``validate`` error branches: any error, un-staged model, or disabled gate degrades every
segment to ``unverified``. No path may ever answer ``grounded`` for text the model did not
actually entail. PHI hygiene: summary/transcript text is never logged.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from guardrail.core.dependencies import (
    ModelUnavailableError,
    acquire_groundedness_verifier,
)
from guardrail.core.logging import get_logger
from guardrail.services.groundedness_nli import (
    GROUNDED,
    REASON_ERROR,
    UNVERIFIED,
    GroundednessResult,
    SegmentVerdict,
    split_segments,
)

logger = get_logger(__name__)

router = APIRouter()


class GroundednessSegmentModel(BaseModel):
    """Verdict for one summary segment; offsets index the submitted ``summary``."""

    text: str = Field(..., description="The segment text (a stripped substring of `summary`)")
    verdict: str = Field(..., description="grounded | ungrounded | unverified")
    grounded: bool = Field(
        ...,
        description="STRICT: true only for a verified-grounded verdict — never on a degrade path",
    )
    score: float | None = Field(None, description="Entailment score (0.0-1.0) when the model ran")
    start: int = Field(..., description="Character offset start within `summary`")
    end: int = Field(..., description="Character offset end within `summary`")


class FlaggedSpanModel(BaseModel):
    """Offsets (into `summary`) of an ungrounded span."""

    start: int = Field(..., description="Character offset start within `summary`")
    end: int = Field(..., description="Character offset end within `summary`")


class GroundRequest(BaseModel):
    """Request model for output-side groundedness verification."""

    summary: str = Field(..., description="Generated summary/note text to verify")
    transcript: str = Field(..., description="Source transcript the summary must be grounded in")
    request_id: str | None = Field(None, description="Optional request ID for tracking")


class GroundResponse(BaseModel):
    """Response model for output-side groundedness verification."""

    segments: list[GroundednessSegmentModel] = Field(..., description="Per-segment verdicts")
    flagged_spans: list[FlaggedSpanModel] = Field(
        default_factory=list,
        description="Offsets of the ungrounded segments within `summary`",
    )
    checked: bool = Field(..., description="Whether the NLI model actually ran")
    reason: str = Field(
        ...,
        description="checked | groundedness_disabled | nli_model_unavailable | nli_error",
    )
    model_id: str = Field(..., description="The self-hosted NLI model this gate is configured for")
    throughput_docs_per_min: float | None = Field(
        None,
        description="Measured segments/min for this batched run (None on degrade paths)",
    )
    processing_time_ms: float = Field(..., description="Processing time in milliseconds")
    request_id: str = Field(..., description="Request ID for tracking")
    timestamp: str = Field(..., description="Verification timestamp")


@router.post("/guardrail/ground", response_model=GroundResponse)
async def ground_summary(
    request: GroundRequest,
    http_request: Request,
) -> GroundResponse:
    """Verify a generated summary against its source transcript (output-side gate).

    Call this between building and publishing a live note so ungrounded segments carry
    their mark before the clinician reads them. Degrades fail-closed: an unavailable or
    erroring verifier yields ``unverified`` segments — never silently ``grounded``.

    The NLI model is DB-selected (``guardrail.groundedness``, tenant-first) and RUNS
    IN ``apps/nlp``; a MISSING DB selection fails closed with HTTP 503, while an
    unreachable or unstaged model degrades to ``unverified`` — never ``grounded``.
    """
    start_time = time.monotonic()

    try:
        async with acquire_groundedness_verifier(http_request) as verifier:
            try:
                # TASK-735 Phase 6 — the scorer is a NETWORK call to `apps/nlp` now,
                # not in-process CPU work, so it is awaited directly rather than
                # offloaded to a thread. `_maybe_await` keeps a synchronous verifier
                # (the in-process test seam) working through the same call site.
                result = await _maybe_await(verifier.verify(request.summary, request.transcript))
            except Exception as exc:
                # FAIL-CLOSED backstop for an unexpected verifier crash: every segment
                # is `unverified` — the deliberate inverse of the legacy fail-open
                # branches. PHI-safe: never log the summary/transcript text.
                logger.warning(
                    "guardrail.groundedness.verify_crashed",
                    error=type(exc).__name__,
                )
                spans = split_segments(request.summary)
                result = GroundednessResult(
                    segments=[
                        SegmentVerdict(text, UNVERIFIED, start, end) for text, start, end in spans
                    ],
                    checked=False,
                    reason=REASON_ERROR,
                    model_id=getattr(verifier, "model_id", ""),
                    elapsed_ms=(time.monotonic() - start_time) * 1000,
                    throughput_docs_per_min=None,
                )
    except ModelUnavailableError as exc:
        # Fail-closed: the groundedness capability has no DB selection at all.
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    processing_time = (time.monotonic() - start_time) * 1000

    return GroundResponse(
        segments=[
            GroundednessSegmentModel(
                text=segment.text,
                verdict=segment.verdict,
                grounded=segment.verdict == GROUNDED,
                score=segment.score,
                start=segment.start,
                end=segment.end,
            )
            for segment in result.segments
        ],
        flagged_spans=[
            FlaggedSpanModel(start=start, end=end) for start, end in result.flagged_spans
        ],
        checked=result.checked,
        reason=result.reason,
        model_id=result.model_id,
        throughput_docs_per_min=result.throughput_docs_per_min,
        processing_time_ms=processing_time,
        request_id=request.request_id or f"ground_{int(time.time() * 1000)}",
        timestamp=datetime.now(UTC).isoformat(),
    )


async def _maybe_await(value: Any) -> Any:
    """Accept both a sync verifier (test seam) and the async production one."""
    if hasattr(value, "__await__"):
        return await value
    return value
