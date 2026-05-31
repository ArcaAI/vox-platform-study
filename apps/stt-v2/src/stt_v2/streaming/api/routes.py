"""Internal streaming session management endpoints.

These endpoints are called by the API Gateway (NestJS) to manage
streaming session lifecycle. They are NOT exposed to end-users.

All endpoints require the streaming module to be initialized
(``get_session_manager()`` returns non-None).
"""

from __future__ import annotations

from typing import Any

import structlog
from fastapi import APIRouter, HTTPException

from stt_v2.streaming._runtime import get_session_manager
from stt_v2.streaming.api.schemas import (
    CreateStreamingSessionRequest,
    StreamingAvailabilityResponse,
    StreamingSessionResponse,
)

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/internal/streaming")


def _require_session_manager():
    """Return the SessionManager or raise 503 if streaming is not initialized."""
    mgr = get_session_manager()
    if mgr is None:
        raise HTTPException(
            status_code=503,
            detail="Streaming module not initialized",
        )
    return mgr


# -------------------------------------------------------------------------
# POST /internal/streaming/sessions — Create a streaming session
# -------------------------------------------------------------------------


@router.post(
    "/sessions",
    response_model=StreamingSessionResponse,
    status_code=201,
    responses={
        201: {"description": "Session created successfully"},
        503: {"description": "Streaming not initialized or at capacity"},
    },
)
async def create_streaming_session(
    request: CreateStreamingSessionRequest,
) -> StreamingSessionResponse:
    """Create a new streaming session.

    The API Gateway calls this before accepting a WebSocket connection.
    If the service is at capacity, returns 503 with ``Retry-After`` header.
    """
    mgr = _require_session_manager()

    logger.info(
        "Creating streaming session",
        session_id=request.session_id,
        tenant_id=request.tenant_id,
        pipeline_id=request.pipeline_id,
        sample_rate=request.sample_rate,
    )

    try:
        session = await mgr.create_session(
            session_id=request.session_id,
            tenant_id=request.tenant_id,
            pipeline_id=request.pipeline_id,
            consultation_id=request.consultation_id,
            sample_rate=request.sample_rate,
            audio_bucket_name=request.audio_bucket_name or "hope-audio",
            user_id=request.user_id,
            language=request.language,
            storage=request.storage,
        )
    except Exception as exc:
        logger.error(
            "Failed to create streaming session",
            session_id=request.session_id,
            pipeline_id=request.pipeline_id,
            error=str(exc),
        )
        raise HTTPException(
            status_code=500,
            detail=f"Failed to create streaming session: {exc}",
        ) from exc

    guard = mgr.capacity_guard

    if session is None:
        # At capacity — return 503 with retry hint
        raise HTTPException(
            status_code=503,
            detail="At capacity",
            headers={"Retry-After": "5"},
        )

    return StreamingSessionResponse(
        session_id=session.session_id,
        status="active",
        max_concurrent=guard.max_streams,
        current_active=guard.active_count,
    )


# -------------------------------------------------------------------------
# GET /internal/streaming/sessions/active — List all active sessions
# -------------------------------------------------------------------------


@router.get(
    "/sessions/active",
    status_code=200,
    responses={
        200: {"description": "Active sessions listed successfully"},
        503: {"description": "Streaming not initialized"},
    },
)
async def list_active_streaming_sessions() -> dict[str, Any]:
    """List all active streaming sessions on this worker instance."""
    mgr = _require_session_manager()
    sessions = mgr.list_sessions()

    return {
        "status": "ok",
        "active_count": len(sessions),
        "sessions": sessions,
    }


# -------------------------------------------------------------------------
# GET /internal/streaming/sessions/{session_id} — Get session status
# -------------------------------------------------------------------------


@router.get(
    "/sessions/{session_id}",
    response_model=StreamingSessionResponse,
    responses={
        200: {"description": "Session found"},
        404: {"description": "Session not found"},
        503: {"description": "Streaming not initialized"},
    },
)
async def get_streaming_session(session_id: str) -> StreamingSessionResponse:
    """Get the status of an existing streaming session."""
    mgr = _require_session_manager()

    session = mgr.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    guard = mgr.capacity_guard

    return StreamingSessionResponse(
        session_id=session.session_id,
        status=session.status.value,
        max_concurrent=guard.max_streams,
        current_active=guard.active_count,
    )


# -------------------------------------------------------------------------
# DELETE /internal/streaming/sessions/{session_id} — Remove/finalize session
# -------------------------------------------------------------------------


@router.delete(
    "/sessions/{session_id}",
    status_code=204,
    responses={
        204: {"description": "Session removed (or already gone)"},
        503: {"description": "Streaming not initialized"},
    },
)
async def delete_streaming_session(session_id: str) -> None:
    """Remove a streaming session. Idempotent: returns 204 even if already removed."""
    mgr = _require_session_manager()

    session = mgr.get_session(session_id)
    if session is None:
        logger.debug("Session already removed, returning 204", session_id=session_id)
        return

    logger.info("Removing streaming session via API", session_id=session_id)
    await mgr.end_session(session_id)


# -------------------------------------------------------------------------
# POST /internal/streaming/sessions/{session_id}/end — End active session
# -------------------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/end",
    status_code=200,
    responses={
        200: {"description": "Session ended successfully"},
        404: {"description": "Session not found"},
        503: {"description": "Streaming not initialized"},
    },
)
async def end_active_streaming_session(session_id: str) -> dict[str, Any]:
    """End a specific active streaming session by session ID."""
    mgr = _require_session_manager()

    session = mgr.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    logger.info("Ending active streaming session via API", session_id=session_id)
    await mgr.end_session(session_id)

    return {
        "status": "ok",
        "session_id": session_id,
    }


# -------------------------------------------------------------------------
# GET /internal/streaming/availability — Check capacity
# -------------------------------------------------------------------------


@router.get(
    "/availability",
    response_model=StreamingAvailabilityResponse,
)
async def get_streaming_availability() -> StreamingAvailabilityResponse:
    """Check whether the streaming module is available and has capacity.

    This is a lightweight endpoint the API Gateway can call before
    creating a session to quickly determine if streaming is possible.
    """
    mgr = get_session_manager()

    if mgr is None:
        return StreamingAvailabilityResponse(
            available=False,
            status="not_initialized",
            max_concurrent=0,
            current_active=0,
            available_slots=0,
        )

    guard = mgr.capacity_guard
    available_slots = guard.available_slots
    at_capacity = available_slots <= 0

    return StreamingAvailabilityResponse(
        available=not at_capacity,
        status="at_capacity" if at_capacity else "ready",
        max_concurrent=guard.max_streams,
        current_active=guard.active_count,
        available_slots=max(0, available_slots),
    )
