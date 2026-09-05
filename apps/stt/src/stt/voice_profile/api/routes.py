"""Voice profile extraction endpoint.

Internal endpoint called by the API Gateway. Accepts multiple audio samples and returns one
speaker embedding. No database writes.

TASK-887 — the gateway NAMES the model. Diarization is a declared ASR-agent option, so the
agent the user is enrolling for decides which `SPEAKER_EMBEDDING` row embeds their voice, and
the profile is stored in that model's space. There is no platform embedding model here to
fall back on: a request that names none is refused rather than served from a space no agent
would ever match against.
"""

from __future__ import annotations

import logging

import numpy as np
from fastapi import APIRouter, Form, HTTPException, UploadFile

from stt.core.exceptions import AudioProcessingError
from stt.transcription.audio_decode import decode_audio
from stt.voice_profile.api.schemas import ExtractionResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal/voice-profile")


@router.post(
    "/extract",
    response_model=ExtractionResponse,
    status_code=200,
    responses={
        200: {"description": "Embedding extracted successfully"},
        400: {"description": "Invalid audio samples, or no embedding model named"},
        503: {"description": "Embedding or VAD service not available"},
    },
)
async def extract_voice_embedding(
    files: list[UploadFile],
    model_slug: str = Form(
        ...,
        description=(
            "The `AiModel` SLUG of the agent's speaker-embedding model. Stored verbatim as "
            "`UserVoiceProfile.modelId`, and echoed back so the gateway persists the identity "
            "it resolved."
        ),
    ),
    model_source_uri: str = Form(
        ..., description="That model's loader id (`sourceUri`) — what the embedding backend loads."
    ),
    min_similarity: float | None = Form(
        default=None,
        description=(
            "The agent's `audioFrontEnd.diarization.matchThreshold`: the minimum pairwise "
            "cosine similarity the samples must reach. Absent ⇒ the engine default."
        ),
    ),
) -> ExtractionResponse:
    """Extract a speaker embedding from multiple uploaded audio samples."""
    from stt.diarization.embedding_service import create_embedding_service
    from stt.vad.silero_service import get_vad_service
    from stt.voice_profile.extraction_service import ExtractionService

    # One service per request, for the model the gateway named. Enrollment is rare and the
    # model is per-agent, so a cache here would key on the same thing the session manager
    # already caches and would outlive the agent revision that chose it.
    embedding_service = create_embedding_service(hf_model_id=model_source_uri)
    try:
        await embedding_service.initialize()
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Embedding model '{model_slug}' is not available",
        ) from exc

    vad_service = get_vad_service()
    try:
        await vad_service.initialize()
    except Exception as exc:
        raise HTTPException(status_code=503, detail="VAD service not available") from exc

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
            # Same tolerant decode as batch: libsndfile, then ffmpeg,
            # so phone recordings with vendor trailers are accepted here too.
            samples, sr = decode_audio(audio_bytes)
        except AudioProcessingError as exc:
            raise HTTPException(
                status_code=400, detail=f"Cannot decode file {i + 1}: {exc.message}"
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
        min_cross_sample_similarity=min_similarity,
    )

    try:
        result = await extraction_service.extract(audio_samples, sample_rate=sample_rate)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return ExtractionResponse(
        embedding=result.embedding,
        model_id=result.model_id,
        model_slug=model_slug,
    )
