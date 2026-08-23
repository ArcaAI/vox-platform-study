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
# Must match the ``vector(N)`` dimension of ``core."UserVoiceProfile"."embedding"``
# in the Prisma migration. Changing this requires a coordinated DB migration.
EXPECTED_EMBEDDING_DIM = 256


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
        expected_embedding_dim: int | None = None,
    ) -> None:
        self._embedding_service = embedding_service
        self._vad_service = vad_service

        if min_cross_sample_similarity is None:
            from ..core.config.settings import get_settings

            min_cross_sample_similarity = get_settings().voice_profile_min_similarity
        self._min_cross_sample_similarity = min_cross_sample_similarity

        if expected_embedding_dim is None:
            # The dimension is a property of the DEPLOYED
            # `UserVoiceProfile.embedding vector(N)` column, so this module
            # constant is the single source and is gated against `user.prisma`
            # by `tests/unit/test_task799_env_surface.py`.
            #
            # It used to be a settings field too (TASK-799 lane C removed it):
            # one fact in two places, only one of which was operator-settable.
            # An ECAPA cutover (192-d) is a migration plus full re-enrolment —
            # changing this number alone does not perform it, it only makes
            # every enrollment fail dimension validation.
            expected_embedding_dim = EXPECTED_EMBEDDING_DIM
        self._expected_embedding_dim = expected_embedding_dim

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

        hf_id = getattr(self._embedding_service, "_hf_model_id", None)
        if isinstance(hf_id, str) and hf_id:
            model_id = hf_id
        else:
            from ..core.config.settings import get_settings

            model_id = get_settings().diarization_hf_model_id

        if len(centroid) != self._expected_embedding_dim:
            raise ValueError(
                f"Embedding dimension mismatch: model '{model_id}' produced "
                f"{len(centroid)}-d embedding but database expects "
                f"{self._expected_embedding_dim}-d. "
                f"Set DIARIZATION_HF_MODEL_ID to a model that outputs "
                f"{self._expected_embedding_dim}-d embeddings (e.g. "
                f"'pyannote/wespeaker-voxceleb-resnet34-LM') or run a migration "
                f"to alter the UserVoiceProfile.embedding column."
            )

        return ExtractionResult(
            embedding=centroid.tolist(),
            model_id=model_id,
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
