"""Transcription API router.

Exposes ``BatchTranscriptionService.transcribe()`` over HTTP so that
audio files can be processed directly without going through Dramatiq.

Endpoint
--------
``POST /api/v1/transcribe``

    multipart/form-data with:
        file            – audio file (required)
        pipeline_id     – pipeline UUID or slug (required)
        tenant_id       – tenant identifier (required)
        consultation_id – optional consultation context
"""

from __future__ import annotations

import uuid

import structlog
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from ...core.exceptions import (
    NotFoundError,
    STTServiceError,
    TranscriptionError,
    ValidationError,
)
from ...pipeline.config_reader import get_pipeline_reader
from ..batch_service import get_batch_service
from ..dto import TimingMetrics
from .schemas import (
    ErrorResponse,
    SegmentResponse,
    SentenceTimestampResponse,
    TimingMetricsResponse,
    TranscriptionResponse,
    WordTimestampResponse,
)

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1", tags=["Transcription"])

# Maximum upload size — 100 MB
_MAX_UPLOAD_BYTES = 100 * 1024 * 1024


@router.post(
    "/transcribe",
    response_model=TranscriptionResponse,
    responses={
        400: {"model": ErrorResponse, "description": "Invalid request"},
        404: {"model": ErrorResponse, "description": "Pipeline not found"},
        413: {"model": ErrorResponse, "description": "File too large"},
        500: {"model": ErrorResponse, "description": "Transcription failed"},
    },
    summary="Transcribe an audio file",
    description=(
        "Upload an audio file and receive a full transcription result including "
        "text, word/sentence timestamps, timing metrics, and optional speaker labels."
    ),
)
async def transcribe_audio(
    file: UploadFile = File(..., description="Audio file to transcribe"),
    pipeline_id: str = Form(..., description="Pipeline UUID or slug"),
    tenant_id: str = Form(..., description="Tenant identifier"),
    consultation_id: str | None = Form(None, description="Optional consultation ID"),
) -> TranscriptionResponse:
    """Transcribe an uploaded audio file through the batch pipeline."""
    job_id = str(uuid.uuid4())
    log = logger.bind(job_id=job_id, pipeline_id=pipeline_id, tenant_id=tenant_id)
    log.info("Transcription request received", filename=file.filename)

    # ------------------------------------------------------------------
    # 1. Read and validate the uploaded file
    # ------------------------------------------------------------------
    audio_bytes = await file.read()

    if not audio_bytes:
        raise HTTPException(
            status_code=400,
            detail={"error_code": "EMPTY_FILE", "message": "Uploaded file is empty"},
        )

    if len(audio_bytes) > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail={
                "error_code": "FILE_TOO_LARGE",
                "message": (
                    f"File size {len(audio_bytes) / (1024 * 1024):.1f} MB "
                    f"exceeds limit of {_MAX_UPLOAD_BYTES / (1024 * 1024):.0f} MB"
                ),
            },
        )

    # ------------------------------------------------------------------
    # 2. Resolve pipeline configuration
    # ------------------------------------------------------------------
    try:
        pipeline_reader = get_pipeline_reader()

        # Try UUID lookup first; fall back to slug lookup
        try:
            uuid.UUID(pipeline_id)
            pipeline_config = await pipeline_reader.get_pipeline(pipeline_id)
        except ValueError:
            # Not a valid UUID — treat as slug
            pipeline_config = await pipeline_reader.get_pipeline_by_slug(
                pipeline_id, tenant_id=tenant_id
            )

    except NotFoundError:
        raise HTTPException(
            status_code=404,
            detail={
                "error_code": "PIPELINE_NOT_FOUND",
                "message": f"Pipeline '{pipeline_id}' not found or not enabled",
            },
        ) from None

    # ------------------------------------------------------------------
    # 3. Run transcription via BatchTranscriptionService
    # ------------------------------------------------------------------
    try:
        batch_service = get_batch_service()

        result = await batch_service.transcribe(
            job_id=job_id,
            audio_bytes=audio_bytes,
            pipeline_config=pipeline_config,
            tenant_id=tenant_id,
            consultation_id=consultation_id,
        )

    except TranscriptionError as exc:
        log.error("Transcription failed", error=str(exc))
        raise HTTPException(
            status_code=500,
            detail={
                "error_code": exc.error_code,
                "message": str(exc),
            },
        ) from exc
    except ValidationError as exc:
        log.warning("Validation error", error=str(exc))
        raise HTTPException(
            status_code=400,
            detail={
                "error_code": exc.error_code,
                "message": str(exc),
            },
        ) from exc
    except STTServiceError as exc:
        log.error("STT service error", error=str(exc), error_code=exc.error_code)
        raise HTTPException(
            status_code=500,
            detail={
                "error_code": exc.error_code,
                "message": str(exc),
            },
        ) from exc

    # ------------------------------------------------------------------
    # 4. Build response from TranscriptionResult
    # ------------------------------------------------------------------
    log.info(
        "Transcription complete",
        text_length=len(result.text),
        processing_time=result.processing_time_seconds,
    )

    return _build_response(result)


def _build_response(result) -> TranscriptionResponse:
    """Convert a ``TranscriptionResult`` dataclass to the API response model."""
    from ..dto import TimingMetrics as TimingMetricsDC

    # Extract timing metrics from metadata
    timing_response: TimingMetricsResponse | None = None
    raw_timing = result.metadata.get("timing")
    if raw_timing is not None:
        if isinstance(raw_timing, TimingMetricsDC):
            td = raw_timing.to_dict()
        elif isinstance(raw_timing, dict):
            td = raw_timing
        else:
            td = {}

        timing_response = TimingMetricsResponse(
            ttfw_seconds=td.get("ttfw_seconds", 0.0),
            model_loading_seconds=td.get("model_loading_seconds", 0.0),
            preprocessing_seconds=td.get("preprocessing_seconds", 0.0),
            inference_seconds=td.get("inference_seconds", 0.0),
            diarization_seconds=td.get("diarization_seconds", 0.0),
            postprocessing_seconds=td.get("postprocessing_seconds", 0.0),
            total_seconds=td.get("total_seconds", 0.0),
        )

    # Serialise metadata — drop "timing" key since it is now top-level
    metadata_clean: dict = {}
    for k, v in result.metadata.items():
        if k == "timing":
            continue
        if isinstance(v, TimingMetrics):
            metadata_clean[k] = v.to_dict()
        else:
            metadata_clean[k] = v

    return TranscriptionResponse(
        text=result.text,
        language=result.language,
        language_probability=result.language_probability,
        duration_seconds=result.duration_seconds,
        processing_time_seconds=result.processing_time_seconds,
        word_timestamps=[
            WordTimestampResponse(
                word=w.word,
                start_time=w.start_time,
                end_time=w.end_time,
                confidence=w.confidence,
            )
            for w in result.word_timestamps
        ],
        sentence_timestamps=[
            SentenceTimestampResponse(
                text=s.text,
                start_time=s.start_time,
                end_time=s.end_time,
            )
            for s in result.sentence_timestamps
        ],
        segments=[
            SegmentResponse(
                start_time=seg.start_time,
                end_time=seg.end_time,
                duration=seg.duration,
                is_speech=seg.is_speech,
                confidence=seg.confidence,
            )
            for seg in result.segments
        ],
        timing=timing_response,
        metadata=metadata_clean,
        raw_audio_uri=result.raw_audio_uri,
        processed_audio_uri=result.processed_audio_uri,
        transcript_uri=result.transcript_uri,
    )
