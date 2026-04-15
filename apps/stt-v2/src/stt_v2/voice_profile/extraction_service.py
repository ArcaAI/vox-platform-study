"""Voice profile extraction service.

Accepts multiple audio samples, extracts an embedding from each,
and returns the best one (highest inter-sample consistency).
No DB writes -- purely computational. The API Gateway owns persistence.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np

logger = logging.getLogger(__name__)

MAX_SAMPLE_DURATION_SEC = 15.0
MAX_SAMPLES = 3


@dataclass
class ExtractionResult:
    embedding: list[float]
    model_id: str


class ExtractionService:
    """Extract the best speaker embedding from multiple audio samples."""

    def __init__(self, embedding_service, vad_service) -> None:
        self._embedding_service = embedding_service
        self._vad_service = vad_service

    async def extract(
        self,
        samples: list[np.ndarray],
        sample_rate: int = 16000,
    ) -> ExtractionResult:
        if not samples:
            raise ValueError("At least one audio sample is required")
        if len(samples) > MAX_SAMPLES:
            raise ValueError(f"At most {MAX_SAMPLES} samples allowed")

        for i, s in enumerate(samples):
            dur = len(s) / sample_rate
            if dur > MAX_SAMPLE_DURATION_SEC:
                raise ValueError(
                    f"Sample {i + 1} exceeds {MAX_SAMPLE_DURATION_SEC}s (got {dur:.1f}s)"
                )

        embeddings: list[np.ndarray] = []
        for sample in samples:
            emb = await self._embedding_service.extract_from_samples(
                sample, sample_rate=sample_rate
            )
            embeddings.append(np.array(emb.embedding, dtype=np.float32))

        if not embeddings:
            raise ValueError("No valid embeddings extracted from samples")

        centroid = np.mean(np.stack(embeddings), axis=0)
        norm = np.linalg.norm(centroid)
        if norm > 1e-10:
            centroid = centroid / norm

        hf_id = getattr(self._embedding_service, '_hf_model_id', None)
        if isinstance(hf_id, str) and hf_id:
            model_id = hf_id
        else:
            from ..core.config.settings import get_settings
            model_id = get_settings().diarization_hf_model_id

        return ExtractionResult(
            embedding=centroid.tolist(),
            model_id=model_id,
        )
