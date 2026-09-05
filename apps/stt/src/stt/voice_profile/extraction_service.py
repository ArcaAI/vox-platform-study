"""Voice profile extraction service.

Accepts multiple audio samples, extracts an embedding from each,
and returns the best one (highest inter-sample consistency).
No DB writes -- purely computational. The API Gateway owns persistence.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

MAX_SAMPLE_DURATION_SEC = 15.0
MAX_SAMPLES = 3
# TASK-887 — there is deliberately no EXPECTED_EMBEDDING_DIM any more.
# `core."UserVoiceProfile"."embedding"` is a dimension-agnostic pgvector `vector`, and a row
# records the model that produced it (`modelId`), so width is a property of the model the
# agent named — not a platform constant this service could meaningfully police. Matching only
# ever compares profiles from the SAME model, so a wrong-width comparison cannot arise.
# The default the retired platform key `stt.voiceProfile.minSimilarity` carried, used when the
# caller pushes no agent threshold (`audioFrontEnd.diarization.matchThreshold`).
DEFAULT_MIN_CROSS_SAMPLE_SIMILARITY = 0.6


@dataclass
class ExtractionResult:
    embedding: list[float]
    model_id: str


class ExtractionService:
    """Extract the best speaker embedding from multiple audio samples."""

    def __init__(
        self,
        embedding_service: Any,
        vad_service: Any,
        *,
        min_cross_sample_similarity: float | None = None,
    ) -> None:
        self._embedding_service = embedding_service
        self._vad_service = vad_service
        # TASK-887 — the floor is the AGENT's `audioFrontEnd.diarization.matchThreshold`,
        # pushed by the gateway with the request. `None` means the caller expressed no
        # opinion, so the engine default stands; there is no settings field behind it.
        self._min_cross_sample_similarity = (
            DEFAULT_MIN_CROSS_SAMPLE_SIMILARITY
            if min_cross_sample_similarity is None
            else min_cross_sample_similarity
        )

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

        if len(embeddings) > 1:
            min_sim = _min_pairwise_cosine(embeddings)
            if min_sim < self._min_cross_sample_similarity:
                raise ValueError(
                    "Voice samples are inconsistent "
                    f"(min pairwise similarity {min_sim:.2f} < "
                    f"{self._min_cross_sample_similarity:.2f}). "
                    "Please re-record all samples from the same speaker."
                )

        centroid = np.mean(np.stack(embeddings), axis=0)
        norm = np.linalg.norm(centroid)
        if norm > 1e-10:
            centroid = centroid / norm

        # The model that actually embedded these samples — the one the gateway handed this
        # service, which is the agent's `models.embedding`. The caller stores it alongside
        # the vector so a later session only compares profiles from the same space.
        hf_id = getattr(self._embedding_service, "_hf_model_id", None)
        if not (isinstance(hf_id, str) and hf_id):
            raise ValueError(
                "The embedding service did not report the model it loaded, so the profile "
                "could not be attributed to a vector space."
            )

        return ExtractionResult(
            embedding=centroid.tolist(),
            model_id=hf_id,
        )


def _min_pairwise_cosine(embeddings: list[np.ndarray]) -> float:
    """Return the minimum pairwise cosine similarity across ``embeddings``.

    Embeddings are L2-normalized before the dot product so the value is in
    ``[-1, 1]``. ``min(...)`` is taken across the upper-triangular pairs.
    """
    normed: list[np.ndarray] = []
    for vec in embeddings:
        norm = float(np.linalg.norm(vec))
        normed.append(vec / norm if norm > 1e-10 else vec)

    min_sim = 1.0
    for i in range(len(normed)):
        for j in range(i + 1, len(normed)):
            sim = float(np.dot(normed[i], normed[j]))
            if sim < min_sim:
                min_sim = sim
    return min_sim
