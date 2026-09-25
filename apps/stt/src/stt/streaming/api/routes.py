"""Internal streaming session management endpoints.

These endpoints are called by the API Gateway (NestJS) to manage
streaming session lifecycle. They are NOT exposed to end-users.

All endpoints require the streaming module to be initialized
(``get_session_manager()`` returns non-None).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import structlog
from fastapi import APIRouter, HTTPException, Query, Response

from stt.core.exceptions import SessionManagerDrainingError
from stt.pipeline.dto import AiModelFormat
from stt.pipeline.language_modes import (
    LanguageModeUnsupportedError,
    language_mode_catalog_payload,
)
from stt.streaming._runtime import get_session_manager
from stt.streaming.api.schemas import (
    CreateStreamingSessionRequest,
    LanguageResolution,
    StreamingAvailabilityResponse,
    StreamingSessionResponse,
    StreamingSessionTeardownResponse,
    SwitchProviderRequest,
    SwitchProviderResponse,
)

if TYPE_CHECKING:
    from stt.streaming.session_manager import SessionManager

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/internal/streaming")


def _require_session_manager() -> SessionManager:
    """Return the SessionManager or raise 503 if streaming is not initialized."""
    mgr = get_session_manager()
    if mgr is None:
        raise HTTPException(
            status_code=503,
            detail="Streaming module not initialized",
        )
    return mgr


def _active_engine(mgr: SessionManager, session: Any) -> str:
    """The engine live for a session: ``'primary'`` or ``'fallback'``.

    Reads the per-session ``EngineSwitchController`` the manager installs for
    every session via its public ``get_switch_controller`` accessor, so the value
    is truthful for the start_on=fallback and create-time-load-failure cases,
    where the controller's ``active_engine`` is flipped to ``'fallback'`` at
    create. It is the same object the swap seam updates, so the response cannot
    drift from the engine that is actually live. ``'primary'`` when no
    controller is registered.
    """
    controller = mgr.get_switch_controller(session.session_id)
    return "primary" if controller is None else controller.active_engine


def _language_resolution_of(mgr: SessionManager, session_id: str) -> LanguageResolution | None:
    """TASK-1004 — the session's receipt as the response model (``None`` when absent)."""
    wire = mgr.get_language_resolution(session_id)
    return LanguageResolution.model_validate(wire) if wire is not None else None


# -------------------------------------------------------------------------
# GET /internal/streaming/language-modes — STT language-mode catalog
# -------------------------------------------------------------------------


@router.get(
    "/language-modes",
    responses={
        200: {"description": "Language-mode catalog + per-mode supported engines"},
        422: {"description": "`engines` names a format this service does not know"},
    },
)
async def get_language_modes(
    engines: str | None = Query(
        default=None,
        description=(
            "TASK-1004 — a chain's ASR engine formats, primary first, comma-separated "
            "(e.g. `WHISPER_CPP,SARVAM`). When present each mode also carries `levels` "
            "({engine: native|degraded|unsupported}) and `effective`, the level that "
            "chain delivers. Omitted ⇒ the catalog-wide payload, unchanged."
        ),
    ),
) -> dict[str, Any]:
    """Return the closed language-mode catalog and, per mode, the catalog-wide
    set of engines that can serve it.

    Backend-authoritative source of truth for the SDK picker — no session
    manager required (the catalog is static).
    """
    return {"modes": language_mode_catalog_payload(_parse_engine_chain(engines))}


def _parse_engine_chain(raw: str | None) -> list[AiModelFormat] | None:
    """``engines`` → ordered formats; ``None`` when no engine is named.

    An unknown format is a 422 naming it — never silently dropped, since a
    dropped primary would report the fallback's level as the chain's.
    """
    names = [part.strip() for part in (raw or "").split(",") if part.strip()]
    if not names:
        return None
    unknown = [name for name in names if name not in AiModelFormat.__members__]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail={
                "message": f"Unknown engine format(s): {', '.join(unknown)}",
                "unknownEngines": unknown,
                "knownEngines": [e.value for e in AiModelFormat],
            },
        )
    return [AiModelFormat(name) for name in names]


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
        sample_rate=request.sample_rate,
    )

    try:
        session = await mgr.create_session(
            session_id=request.session_id,
            tenant_id=request.tenant_id,
            consultation_id=request.consultation_id,
            sample_rate=request.sample_rate,
            audio_bucket_name=request.audio_bucket_name or "hope-audio",
            user_id=request.user_id,
            language=request.language,
            storage=request.storage,
            provider_overrides=request.provider_overrides,
            language_mode=request.language_mode,
            start_on=request.start_on or "primary",
            auto_switch_enabled=request.auto_switch_enabled,
            consecutive_failure_threshold=request.consecutive_failure_threshold,
            channel_count=request.channel_count,
            resolved_spec=request.resolved_spec,
            voice_profiles=request.voice_profiles,
            language_mode_source=request.language_mode_source,
        )
    except SessionManagerDrainingError as exc:
        # PLANNED scale-down — distinct from
        # the ordinary at-capacity 503 below so an operator reading logs
        # (or a smarter future caller) can tell them apart, even though a
        # dumb caller just sees "503, retry" either way, which is the safe
        # default. The primary "stop routing here" mechanism is k8s readiness
        # (/health/ready) removing this pod from the Service; this is the
        # defense-in-depth layer for the race window before that takes effect.
        logger.info(
            "Streaming session rejected — worker draining",
            session_id=request.session_id,
            worker_id=mgr.worker_id,
        )
        raise HTTPException(
            status_code=503,
            detail="Draining",
            headers={"Retry-After": "30"},
        ) from exc
    except LanguageModeUnsupportedError as exc:
        # The selected mode fits none of the session's engines
        # (primary + configured fallback). Surface a 422 that names the modes
        # the engine CAN serve, so the client can re-select.
        logger.warning(
            "Language mode unsupported by session engine(s)",
            session_id=request.session_id,
            language_mode=exc.mode_id,
            engine=exc.engine.value,
        )
        raise HTTPException(
            status_code=422,
            detail={
                "message": str(exc),
                "languageMode": exc.mode_id,
                "engine": exc.engine.value,
                "supportedModes": exc.supported_mode_ids,
            },
        ) from exc
    except Exception as exc:
        logger.error(
            "Failed to create streaming session",
            session_id=request.session_id,
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
        active_engine=_active_engine(mgr, session),
        voice_profile_seeded=mgr.get_voice_profile_seeded(session.session_id),
        language_resolution=_language_resolution_of(mgr, session.session_id),
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
        active_engine=_active_engine(mgr, session),
        voice_profile_seeded=mgr.get_voice_profile_seeded(session.session_id),
        language_resolution=_language_resolution_of(mgr, session.session_id),
    )


# -------------------------------------------------------------------------
# DELETE /internal/streaming/sessions/{session_id} — Remove/finalize session
# -------------------------------------------------------------------------


@router.delete(
    "/sessions/{session_id}",
    response_model=StreamingSessionTeardownResponse | None,
    status_code=200,
    responses={
        200: {"description": "Session removed; usage-attribution summary returned"},
        204: {
            "description": "Session already gone, or a summary could not be built (idempotent no-op either way)"
        },
        503: {"description": "Streaming not initialized"},
    },
)
async def delete_streaming_session(
    session_id: str, response: Response
) -> StreamingSessionTeardownResponse | None:
    """Remove a streaming session. Idempotent: returns 204 even if already removed.

    A REAL teardown returns 200 with the usage-attribution
    summary (``StreamingSessionTeardownResponse``) the API Gateway needs to
    emit the ``transcribe.stream`` ledger row — 204/no-body when the session
    was already gone AND no summary was stashed for it, OR when ``end_session``
    could not build one (best-effort; logged server-side, never blocks
    teardown).

    TASK-985 M-23 — "already gone" is the COMMON case on a clean stop, not an
    edge case: the client's `stop` writes a control FINALIZE, that finalizer
    closes the session and has nobody to return its summary to, and this DELETE
    then arrives to find nothing. Answering 204 there produced NO
    `transcribe.stream` row at all for a consultation that was fully served.
    The finalizer now stashes; this route claims the stash and answers 200, so
    the GATEWAY still emits the row and still owns the `interrupted` verdict
    (STT has no notion of it — see `_build_teardown_summary`).
    """
    mgr = _require_session_manager()

    session = mgr.get_session(session_id)
    if session is None:
        stashed = mgr.claim_teardown_summary(session_id)
        if stashed is not None:
            logger.info(
                "stt.stream.teardown_stash_claimed",
                session_id=session_id,
            )
            return StreamingSessionTeardownResponse(**stashed)
        logger.debug("Session already removed, returning 204", session_id=session_id)
        response.status_code = 204
        return None

    logger.info("Removing streaming session via API", session_id=session_id)
    summary = await mgr.end_session(session_id)
    if summary is None:
        # Another finalizer (control FINALIZE, the in-band final frame) was
        # already tearing the session down; `end_session` waited for it, and its
        # summary — stashed after the recording upload — is claimable now.
        summary = mgr.claim_teardown_summary(session_id)
        if summary is not None:
            logger.info(
                "stt.stream.teardown_stash_claimed",
                session_id=session_id,
                after_wait=True,
            )
    if summary is None:
        response.status_code = 204
        return None
    return StreamingSessionTeardownResponse(**summary)


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
# POST /internal/streaming/sessions/{session_id}/switch — Manual fallback switch
# -------------------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/switch",
    response_model=SwitchProviderResponse,
    status_code=200,
    responses={
        200: {"description": "Switch requested"},
        404: {"description": "Session not found"},
        409: {
            "description": "Target unavailable (no fallback, primary never loaded, or already active)"
        },
        503: {"description": "Streaming not initialized"},
    },
)
async def switch_streaming_session(
    session_id: str,
    request: SwitchProviderRequest | None = None,
) -> SwitchProviderResponse:
    """Request a mid-session engine switch.

    Body ``{"target": "primary" | "fallback"}``; absent ⇒ ``"fallback"``
    (back-compat). Called by the API Gateway's switch endpoint. XADDs a
    ``SWITCH_TO_FALLBACK`` control message (carrying the target) onto the
    session's control stream; the in-session ``EngineSwitchController`` performs
    the seamless engine swap at the next utterance boundary and emits the
    authoritative ``provider_switched`` result frame.

    Returns ``{switched, active}``. ``409`` when the target is unavailable
    (fallback not configured, primary never loaded, or already on that engine);
    ``404`` for an unknown session.
    """
    mgr = _require_session_manager()
    target = request.target if request is not None else "fallback"

    try:
        await mgr.request_switch(session_id, target)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Session not found") from exc
    except ValueError as exc:
        # no_fallback_configured / primary_unavailable / already_on_* / invalid_target
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    logger.info("Engine switch requested via API", session_id=session_id, target=target)
    return SwitchProviderResponse(switched=True, active=target)


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


# -------------------------------------------------------------------------
# POST /internal/streaming/drain — Begin PLANNED scale-down draining
# -------------------------------------------------------------------------


@router.post(
    "/drain",
    responses={
        200: {"description": "Worker marked draining"},
        503: {"description": "Streaming not initialized"},
    },
)
async def begin_streaming_drain() -> dict[str, Any]:
    """Mark this worker draining — a `preStop` hook (deployment repo) target.

    Idempotent. Rejects NEW sessions (see `SessionManagerDrainingError`
    above) while every session already in `self._sessions` keeps being
    served exactly as before; `/health/ready` starts returning 503 on the
    same flag, which is the ACTUAL "stop routing here" mechanism (k8s
    removes this pod from the Service Endpoints). See
    """
    mgr = _require_session_manager()
    mgr.begin_drain()

    logger.info(
        "Streaming drain requested via API",
        worker_id=mgr.worker_id,
        active_sessions=mgr.active_session_count,
    )

    return {
        "status": "draining",
        "worker_id": mgr.worker_id,
        "active_sessions": mgr.active_session_count,
    }
