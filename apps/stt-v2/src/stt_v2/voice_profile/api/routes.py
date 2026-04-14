"""Voice profile extraction endpoint.

Internal endpoint called by the API Gateway. Accepts multiple audio samples,
returns a 256d speaker embedding from the best one. No database writes.
"""

from __future__ import annotations

import io
import logging

import numpy as np
import soundfile as sf
from fastapi import APIRouter, HTTPException, UploadFile

from stt_v2.voice_profile.api.schemas import ExtractionResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal/voice-profile")


@router.post(
    "/extract",
    response_model=ExtractionResponse,
    status_code=200,
    responses={
        200: {"description": "Embedding extracted successfully"},
        400: {"description": "Invalid audio samples"},
        503: {"description": "Embedding or VAD service not available"},
    },
)
async def extract_voice_embedding(files: list[UploadFile]) -> ExtractionResponse:
    """Extract a speaker embedding from multiple uploaded audio samples."""
    from stt_v2.diarization.embedding_service import get_embedding_service
    from stt_v2.vad.silero_service import get_vad_service
    from stt_v2.voice_profile.extraction_service import ExtractionService

    embedding_service = get_embedding_service()
    if not embedding_service.is_loaded:
        raise HTTPException(status_code=503, detail="Embedding service not available")

    vad_service = get_vad_service()
    if not vad_service.is_loaded:
        raise HTTPException(status_code=503, detail="VAD service not available")

    if not files:
        raise HTTPException(status_code=400, detail="At least one audio file is required")
    if len(files) > 3:
        raise HTTPException(status_code=400, detail="At most 3 audio files allowed")

    audio_samples: list[np.ndarray] = []
    sample_rate: int = 16000

    for i, file in enumerate(files):
        audio_bytes = await file.read()
        if not audio_bytes:
            raise HTTPException(status_code=400, detail=f"File {i + 1} is empty")

        try:
            samples, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32")
        except Exception as exc:
            raise HTTPException(
                status_code=400, detail=f"Cannot decode file {i + 1}: {exc}"
            ) from exc

        if samples.ndim > 1:
            samples = samples.mean(axis=1)

        if i == 0:
            sample_rate = sr
        elif sr != sample_rate:
            import librosa
            samples = librosa.resample(samples, orig_sr=sr, target_sr=sample_rate)

        audio_samples.append(samples)

    extraction_service = ExtractionService(
        embedding_service=embedding_service,
        vad_service=vad_service,
    )

    try:
        result = await extraction_service.extract(audio_samples, sample_rate=sample_rate)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return ExtractionResponse(
        embedding=result.embedding,
        quality_score=result.quality_score,
        model_id=result.model_id,
    )
