"""Job management endpoints for async guardrail processing."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from guardrail.core.dependencies import get_job_processor, require_tenant_id
from guardrail.services.job_processor import JobProcessor

router = APIRouter()

# ---------------------------------------------------------------------------
# Every route here is TENANT-SCOPED.
#
# Job ids are caller-supplied (`request_id`), so they are guessable — reading a
# guardrail verdict must never be possible on a job id alone. `X-Tenant-Id` is required
# (428 when absent, the same precondition spelling as the submit route) and compared to
# the tenant stamped on the job at submit time. A mismatch returns 404, NOT 403: the
# platform hides cross-tenant existence (`00-project-context.md` 404-over-403). 403 here
# would confirm the job exists, which is the leak this closes.
# ---------------------------------------------------------------------------


class JobStatus(BaseModel):
    """Job status response model."""

    job_id: str = Field(..., description="Unique job identifier")
    status: str = Field(..., description="Job status: pending, processing, completed, failed")
    result: dict[str, Any] | None = Field(None, description="Analysis result if completed")
    error: str | None = Field(None, description="Error message if failed")
    created_at: str = Field(..., description="Job creation timestamp")
    updated_at: str = Field(..., description="Last update timestamp")
    processing_time_ms: float | None = Field(None, description="Processing time in milliseconds")


class JobList(BaseModel):
    """List of jobs response model."""

    jobs: list[JobStatus] = Field(..., description="List of job statuses")
    total: int = Field(..., description="Total number of jobs")
    limit: int = Field(..., description="Number of jobs returned")
    offset: int = Field(..., description="Offset for pagination")


@router.get("/jobs/status/{job_id}", response_model=JobStatus)
async def get_job_status(
    job_id: str = Path(..., description="Job ID to retrieve"),
    tenant_id: str = Depends(require_tenant_id),
    job_processor: JobProcessor = Depends(get_job_processor),
) -> JobStatus:
    """Get the status of a specific guardrail analysis job owned by the calling tenant."""
    try:
        job_status = await job_processor.get_job_status(job_id, tenant_id=tenant_id)

        if not job_status:
            raise HTTPException(
                status_code=404,
                detail=f"Job {job_id} not found",
            )

        return JobStatus(**job_status)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to retrieve job status: {str(e)}",
        ) from e


@router.get("/jobs/list", response_model=JobList)
async def list_jobs(
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
    tenant_id: str = Depends(require_tenant_id),
    job_processor: JobProcessor = Depends(get_job_processor),
) -> JobList:
    """List the calling tenant's guardrail analysis jobs, with optional filtering."""
    try:
        jobs_data = await job_processor.list_jobs(
            status=status,
            limit=limit,
            offset=offset,
            tenant_id=tenant_id,
        )

        return JobList(**jobs_data)

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to list jobs: {str(e)}",
        ) from e


@router.delete("/jobs/cancel/{job_id}", response_model=dict[str, str])
async def cancel_job(
    job_id: str = Path(..., description="Job ID to cancel"),
    tenant_id: str = Depends(require_tenant_id),
    job_processor: JobProcessor = Depends(get_job_processor),
) -> dict[str, str]:
    """Cancel a pending or processing job owned by the calling tenant."""
    try:
        success = await job_processor.cancel_job(job_id, tenant_id=tenant_id)

        if not success:
            raise HTTPException(
                status_code=404,
                detail=f"Job {job_id} not found or cannot be cancelled",
            )

        return {
            "job_id": job_id,
            "status": "cancelled",
            "message": "Job cancelled successfully",
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to cancel job: {str(e)}",
        ) from e


@router.get("/jobs/result/{job_id}", response_model=dict[str, Any])
async def get_job_result(
    job_id: str = Path(..., description="Job ID to retrieve result for"),
    tenant_id: str = Depends(require_tenant_id),
    job_processor: JobProcessor = Depends(get_job_processor),
) -> dict[str, Any]:
    """Get the result of a completed job owned by the calling tenant."""
    try:
        job_status = await job_processor.get_job_status(job_id, tenant_id=tenant_id)

        if not job_status:
            raise HTTPException(
                status_code=404,
                detail=f"Job {job_id} not found",
            )

        if job_status["status"] != "completed":
            raise HTTPException(
                status_code=400,
                detail=f"Job {job_id} is not completed. Current status: {job_status['status']}",
            )

        if not job_status.get("result"):
            raise HTTPException(
                status_code=404,
                detail=f"No result available for job {job_id}",
            )

        return cast("dict[str, Any]", job_status["result"])

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to retrieve job result: {str(e)}",
        ) from e


@router.get("/jobs/stats", response_model=dict[str, Any])
async def get_job_stats(
    tenant_id: str = Depends(require_tenant_id),
    job_processor: JobProcessor = Depends(get_job_processor),
) -> dict[str, Any]:
    """Get statistics about the calling tenant's guardrail analysis jobs."""
    try:
        stats = await job_processor.get_job_stats(tenant_id=tenant_id)

        return {
            "timestamp": datetime.now(UTC).isoformat(),
            **stats,
        }

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to retrieve job statistics: {str(e)}",
        ) from e
