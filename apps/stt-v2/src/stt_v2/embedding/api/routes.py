"""Internal embedding API routes (TASK-033).

Endpoints:
- POST /internal/embeddings/upsert — extract and store a speaker embedding
- GET  /internal/embeddings/{speaker_id} — check embedding status
- DELETE /internal/embeddings/{speaker_id} — remove a speaker embedding
"""

from __future__ import annotations

import io
import json
import logging
import wave
from datetime import UTC, datetime
from typing import Any

import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile

from ...core.vectorstore.speaker_store import SpeakerEmbeddingStore, get_speaker_store
from ...diarization.embedding_service import EmbeddingService, get_embedding_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal/embeddings", tags=["Embedding"])

MINIMUM_AUDIO_DURATION_S = 5.0
EMBEDDING_DIM = 512


def _wav_duration_seconds(data: bytes) -> float:
    """Read WAV duration from raw bytes without external libs."""
    buf = io.BytesIO(data)
    try:
        with wave.open(buf, "rb") as wf:
            return wf.getnframes() / wf.getframerate()
    except Exception:
        return -1.0


def _wav_to_numpy(data: bytes) -> tuple[np.ndarray, int]:
    """Convert WAV bytes to float32 mono numpy array + sample rate."""
    buf = io.BytesIO(data)
    with wave.open(buf, "rb") as wf:
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if wf.getnchannels() > 1:
            samples = samples.reshape(-1, wf.getnchannels()).mean(axis=1)
    return samples, sample_rate


def _parse_metadata(raw: str | None) -> dict[str, Any] | None:
    """Parse optional JSON metadata string, returning None on invalid input."""
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except (json.JSONDecodeError, TypeError):
        pass
    return None


# ---------------------------------------------------------------------------
# POST /internal/embeddings/upsert
# ---------------------------------------------------------------------------


@router.post("/upsert", status_code=201)
async def upsert_embedding(
    file: UploadFile = File(...),
    tenant_id: str = Form(...),
    speaker_id: str = Form(...),
    metadata: str | None = Form(None),
    embedding_service: EmbeddingService = Depends(get_embedding_service),
    speaker_store: SpeakerEmbeddingStore = Depends(get_speaker_store),
) -> dict[str, Any]:
    if not embedding_service.is_loaded:
        raise HTTPException(
            status_code=503,
            detail="Embedding service not initialized. Model still loading.",
        )

    audio_bytes = await file.read()

    duration = _wav_duration_seconds(audio_bytes)
    if duration < MINIMUM_AUDIO_DURATION_S:
        raise HTTPException(
            status_code=400,
            detail=f"Audio duration ({duration:.1f}s) below minimum ({MINIMUM_AUDIO_DURATION_S}s).",
        )

    try:
        samples, sample_rate = _wav_to_numpy(audio_bytes)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid audio file: {e}") from e

    try:
        speaker_embedding = await embedding_service.extract_from_samples(samples, sample_rate)
    except Exception as e:
        logger.exception("Embedding extraction failed for speaker %s", speaker_id)
        raise HTTPException(
            status_code=500,
            detail=f"Embedding extraction failed: {e}",
        ) from e

    parsed_metadata = _parse_metadata(metadata)

    try:
        embedding_id = await speaker_store.upsert_embedding(
            tenant_id=tenant_id,
            speaker_id=speaker_id,
            embedding=speaker_embedding.embedding,
            metadata=parsed_metadata,
        )
    except Exception as e:
        logger.exception("Qdrant upsert failed for speaker %s", speaker_id)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to store embedding: {e}",
        ) from e

    return {
        "speaker_id": speaker_id,
        "embedding_id": embedding_id,
        "dimensions": speaker_embedding.dimension,
        "created_at": datetime.now(UTC).isoformat(),
    }


# ---------------------------------------------------------------------------
# GET /internal/embeddings/{speaker_id}
# ---------------------------------------------------------------------------


@router.get("/{speaker_id}")
async def get_embedding_status(
    speaker_id: str,
    tenant_id: str = Query(...),
    speaker_store: SpeakerEmbeddingStore = Depends(get_speaker_store),
) -> dict[str, Any]:
    speakers = await speaker_store.get_speakers_for_tenant(tenant_id)
    match = next((s for s in speakers if s["speaker_id"] == speaker_id), None)

    if match:
        created_at = match.get("created_at")
        if isinstance(created_at, (int, float)):
            created_at = datetime.fromtimestamp(created_at, tz=UTC).isoformat()

        return {
            "speaker_id": speaker_id,
            "exists": True,
            "dimensions": EMBEDDING_DIM,
            "created_at": created_at,
        }

    return {
        "speaker_id": speaker_id,
        "exists": False,
    }


# ---------------------------------------------------------------------------
# DELETE /internal/embeddings/{speaker_id}
# ---------------------------------------------------------------------------


@router.delete("/{speaker_id}")
async def delete_embedding(
    speaker_id: str,
    tenant_id: str = Query(...),
    speaker_store: SpeakerEmbeddingStore = Depends(get_speaker_store),
) -> dict[str, Any]:
    try:
        await speaker_store.delete_speaker(tenant_id, speaker_id)
    except Exception as e:
        logger.exception("Qdrant delete failed for speaker %s", speaker_id)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to delete embedding: {e}",
        ) from e

    return {
        "deleted": True,
        "speaker_id": speaker_id,
    }
