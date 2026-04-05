"""Speaker identification service.

Orchestrates pyannote embedding extraction with Qdrant speaker store
to identify known speakers or register new ones.

Flow:
1. Extract embedding from audio segment (EmbeddingService)
2. Search Qdrant for similar embeddings within tenant scope
3. If match above threshold → return known speaker ID
4. If no match and auto_register → store embedding, mint new speaker ID
5. Attach speaker_id to transcription segments
"""

import logging
import uuid
from typing import Any

import numpy as np

from ..core.exceptions import SpeakerIdentificationError
from ..core.vectorstore.speaker_store import SpeakerEmbeddingStore, get_speaker_store
from ..pipeline.dto import DiarizationConfig
from .dto import DiarizationResult, DiarizedSegment, SpeakerEmbedding, SpeakerIdentification
from .embedding_service import EmbeddingService, get_embedding_service

logger = logging.getLogger(__name__)


class SpeakerIdentifier:
    """Identify speakers by comparing embeddings against Qdrant store."""

    def __init__(
        self,
        embedding_service: EmbeddingService | None = None,
        speaker_store: SpeakerEmbeddingStore | None = None,
    ) -> None:
        self._embedding_service = embedding_service or get_embedding_service()
        self._speaker_store = speaker_store or get_speaker_store()

    # ------------------------------------------------------------------
    # Single-segment identification
    # ------------------------------------------------------------------

    async def identify_speaker(
        self,
        samples: np.ndarray,
        sample_rate: int,
        tenant_id: str,
        consultation_id: str | None = None,
        config: DiarizationConfig | None = None,
    ) -> SpeakerIdentification:
        """Identify a speaker from an audio segment.

        Args:
            samples: Float32 mono audio for one speaker segment.
            sample_rate: Sample rate.
            tenant_id: Tenant for scoped Qdrant search.
            consultation_id: Optional consultation context.
            config: Diarization configuration overrides.

        Returns:
            SpeakerIdentification with speaker_id and confidence.
        """
        config = config or DiarizationConfig()

        try:
            # Step 1: Extract embedding
            embedding = await self._embedding_service.extract_from_samples(samples, sample_rate)

            # Step 2: Search Qdrant
            matches = await self._speaker_store.search_similar(
                tenant_id=tenant_id,
                query_embedding=embedding.embedding,
                limit=5,
                score_threshold=config.similarity_threshold,
                consultation_id=consultation_id,
            )

            # Step 3: Match or register
            if matches:
                best = matches[0]
                return SpeakerIdentification(
                    speaker_id=best["speaker_id"],
                    confidence=best["score"],
                    is_new_speaker=False,
                    point_id=best["point_id"],
                )

            # No match — register new speaker if enabled
            if config.auto_register_speakers:
                new_speaker_id = f"speaker-{uuid.uuid4().hex[:8]}"
                point_id = await self._speaker_store.upsert_embedding(
                    tenant_id=tenant_id,
                    speaker_id=new_speaker_id,
                    embedding=embedding.embedding,
                    consultation_id=consultation_id,
                )
                logger.info(
                    "Registered new speaker %s for tenant %s",
                    new_speaker_id,
                    tenant_id,
                )
                return SpeakerIdentification(
                    speaker_id=new_speaker_id,
                    confidence=None,
                    is_new_speaker=True,
                    point_id=point_id,
                )

            return SpeakerIdentification(
                speaker_id="unknown",
                confidence=None,
                is_new_speaker=False,
            )

        except Exception as e:
            raise SpeakerIdentificationError(f"Speaker identification failed: {e}") from e

    # ------------------------------------------------------------------
    # Single-segment identification from precomputed embedding
    # ------------------------------------------------------------------

    async def identify_with_embedding(
        self,
        embedding: SpeakerEmbedding,
        tenant_id: str,
        consultation_id: str | None = None,
        config: DiarizationConfig | None = None,
    ) -> SpeakerIdentification:
        """Identify a speaker from a precomputed embedding.

        Same logic as :meth:`identify_speaker` but skips the extraction
        step — useful when the caller already has an embedding (e.g.
        streaming inference).

        Args:
            embedding: Precomputed speaker embedding.
            tenant_id: Tenant for scoped Qdrant search.
            consultation_id: Optional consultation context.
            config: Diarization configuration overrides.

        Returns:
            SpeakerIdentification with speaker_id and confidence.
        """
        config = config or DiarizationConfig()

        try:
            matches = await self._speaker_store.search_similar(
                tenant_id=tenant_id,
                query_embedding=embedding.embedding,
                limit=5,
                score_threshold=config.similarity_threshold,
                consultation_id=consultation_id,
            )

            if matches:
                best = matches[0]
                return SpeakerIdentification(
                    speaker_id=best["speaker_id"],
                    confidence=best["score"],
                    is_new_speaker=False,
                    point_id=best["point_id"],
                )

            if config.auto_register_speakers:
                new_speaker_id = f"speaker-{uuid.uuid4().hex[:8]}"
                point_id = await self._speaker_store.upsert_embedding(
                    tenant_id=tenant_id,
                    speaker_id=new_speaker_id,
                    embedding=embedding.embedding,
                    consultation_id=consultation_id,
                )
                logger.info(
                    "Registered new speaker %s for tenant %s",
                    new_speaker_id,
                    tenant_id,
                )
                return SpeakerIdentification(
                    speaker_id=new_speaker_id,
                    confidence=None,
                    is_new_speaker=True,
                    point_id=point_id,
                )

            return SpeakerIdentification(
                speaker_id="unknown",
                confidence=None,
                is_new_speaker=False,
            )

        except Exception as e:
            raise SpeakerIdentificationError(f"Speaker identification failed: {e}") from e

    # ------------------------------------------------------------------
    # Multi-segment diarization from precomputed embeddings
    # ------------------------------------------------------------------

    async def diarize_with_embeddings(
        self,
        embeddings: list[SpeakerEmbedding | None],
        segments: list[dict[str, Any]],
        tenant_id: str,
        consultation_id: str | None = None,
        config: DiarizationConfig | None = None,
    ) -> DiarizationResult:
        """Assign speaker IDs using precomputed embeddings.

        Same logic as :meth:`diarize_segments` phase 3, but skips audio
        slicing and embedding extraction — the caller provides embeddings
        directly (e.g. streaming pipeline where embeddings are extracted
        per-utterance).

        Args:
            embeddings: One embedding per segment (or ``None`` to skip).
            segments: Transcription segments with ``start``, ``end``, ``text``.
            tenant_id: Tenant for Qdrant scope.
            consultation_id: Optional consultation context.
            config: Diarization configuration.

        Returns:
            DiarizationResult with speaker-annotated segments.
        """
        config = config or DiarizationConfig()

        diarized_segments: list[DiarizedSegment] = []
        speakers_seen: set[str] = set()
        new_speakers = 0

        for emb, seg in zip(embeddings, segments, strict=False):
            start = seg.get("start", 0.0)
            end = seg.get("end", 0.0)
            text = seg.get("text", "")

            if emb is None:
                diarized_segments.append(DiarizedSegment(
                    text=text,
                    start_time=start,
                    end_time=end,
                    speaker_id=None,
                    word_timestamps=seg.get("word_timestamps", []),
                ))
                continue

            try:
                matches = await self._speaker_store.search_similar(
                    tenant_id=tenant_id,
                    query_embedding=emb.embedding,
                    limit=5,
                    score_threshold=config.similarity_threshold,
                    consultation_id=consultation_id,
                )

                if matches:
                    best = matches[0]
                    speaker_id = best["speaker_id"]
                    confidence = best["score"]
                    is_new = False
                elif config.auto_register_speakers:
                    if config.max_speakers > 0 and len(speakers_seen) >= config.max_speakers:
                        speaker_id = "unknown"
                        confidence = None
                        is_new = False
                    else:
                        speaker_id = f"speaker-{uuid.uuid4().hex[:8]}"
                        await self._speaker_store.upsert_embedding(
                            tenant_id=tenant_id,
                            speaker_id=speaker_id,
                            embedding=emb.embedding,
                            consultation_id=consultation_id,
                        )
                        logger.info(
                            "Registered new speaker %s for tenant %s",
                            speaker_id,
                            tenant_id,
                        )
                        confidence = None
                        is_new = True
                else:
                    speaker_id = "unknown"
                    confidence = None
                    is_new = False

                speakers_seen.add(speaker_id)
                if is_new:
                    new_speakers += 1

                diarized_segments.append(DiarizedSegment(
                    text=text,
                    start_time=start,
                    end_time=end,
                    speaker_id=speaker_id,
                    speaker_confidence=confidence,
                    word_timestamps=seg.get("word_timestamps", []),
                ))

            except Exception as e:
                logger.warning(
                    "Diarization failed for segment [%.1f–%.1f]: %s",
                    start,
                    end,
                    e,
                )
                diarized_segments.append(DiarizedSegment(
                    text=text,
                    start_time=start,
                    end_time=end,
                    speaker_id=None,
                    word_timestamps=seg.get("word_timestamps", []),
                ))

        return DiarizationResult(
            segments=diarized_segments,
            speakers_detected=len(speakers_seen),
            new_speakers_created=new_speakers,
            applied=True,
        )

    # ------------------------------------------------------------------
    # Multi-segment diarization (for batch transcription)
    # ------------------------------------------------------------------

    async def diarize_segments(
        self,
        samples: np.ndarray,
        sample_rate: int,
        segments: list[dict[str, Any]],
        tenant_id: str,
        consultation_id: str | None = None,
        config: DiarizationConfig | None = None,
    ) -> DiarizationResult:
        """Assign speaker IDs to transcription segments.

        Uses batch embedding extraction for efficiency: all eligible
        segment audio is collected, embeddings are extracted in a single
        thread dispatch, then each embedding is matched against Qdrant.

        ``max_speakers`` is enforced — once the limit is reached, no new
        speakers are registered and unmatched segments get ``"unknown"``.

        Args:
            samples: Full audio as float32 numpy array.
            sample_rate: Sample rate.
            segments: Transcription segments with ``start``, ``end``, ``text``.
            tenant_id: Tenant for Qdrant scope.
            consultation_id: Optional consultation context.
            config: Diarization configuration.

        Returns:
            DiarizationResult with speaker-annotated segments.
        """
        config = config or DiarizationConfig()

        if not config.enabled:
            return DiarizationResult(applied=False)

        # ----------------------------------------------------------
        # Phase 1: Classify segments into diarizable vs skipped
        # ----------------------------------------------------------
        diarized_segments: list[DiarizedSegment] = [None] * len(segments)  # type: ignore[list-item]
        batch_audio: list[np.ndarray] = []
        batch_times: list[tuple[float, float]] = []
        batch_indices: list[int] = []

        for i, seg in enumerate(segments):
            start = seg.get("start", 0.0)
            end = seg.get("end", 0.0)
            text = seg.get("text", "")
            duration = end - start

            # Skip segments too short for reliable diarization
            if duration < config.min_segment_duration_s:
                diarized_segments[i] = DiarizedSegment(
                    text=text,
                    start_time=start,
                    end_time=end,
                    speaker_id=None,
                    word_timestamps=seg.get("word_timestamps", []),
                )
                continue

            start_sample = int(start * sample_rate)
            end_sample = int(end * sample_rate)
            segment_samples = samples[start_sample:end_sample]

            if len(segment_samples) < sample_rate:
                # Less than 1 second — skip diarization
                diarized_segments[i] = DiarizedSegment(
                    text=text,
                    start_time=start,
                    end_time=end,
                    speaker_id=None,
                    word_timestamps=seg.get("word_timestamps", []),
                )
                continue

            batch_audio.append(segment_samples)
            batch_times.append((start, end))
            batch_indices.append(i)

        # ----------------------------------------------------------
        # Phase 2: Batch-extract all embeddings at once
        # ----------------------------------------------------------
        embeddings: list[SpeakerEmbedding | None] = []
        if batch_audio:
            try:
                embeddings = await self._embedding_service.extract_batch(
                    batch_audio,
                    sample_rate,
                    batch_times,
                )
            except Exception as e:
                logger.warning("Batch embedding extraction failed: %s", e)
                embeddings = [None] * len(batch_audio)

        # ----------------------------------------------------------
        # Phase 3: Identify speakers per embedding
        # ----------------------------------------------------------
        speakers_seen: set[str] = set()
        new_speakers = 0

        for emb, idx in zip(embeddings, batch_indices, strict=False):
            seg = segments[idx]
            start = seg.get("start", 0.0)
            end = seg.get("end", 0.0)
            text = seg.get("text", "")

            if emb is None:
                diarized_segments[idx] = DiarizedSegment(
                    text=text,
                    start_time=start,
                    end_time=end,
                    speaker_id=None,
                    word_timestamps=seg.get("word_timestamps", []),
                )
                continue

            try:
                # Search Qdrant
                matches = await self._speaker_store.search_similar(
                    tenant_id=tenant_id,
                    query_embedding=emb.embedding,
                    limit=5,
                    score_threshold=config.similarity_threshold,
                    consultation_id=consultation_id,
                )

                if matches:
                    best = matches[0]
                    speaker_id = best["speaker_id"]
                    confidence = best["score"]
                    is_new = False
                elif config.auto_register_speakers:
                    # Enforce max_speakers limit
                    if config.max_speakers > 0 and len(speakers_seen) >= config.max_speakers:
                        speaker_id = "unknown"
                        confidence = None
                        is_new = False
                    else:
                        speaker_id = f"speaker-{uuid.uuid4().hex[:8]}"
                        await self._speaker_store.upsert_embedding(
                            tenant_id=tenant_id,
                            speaker_id=speaker_id,
                            embedding=emb.embedding,
                            consultation_id=consultation_id,
                        )
                        logger.info(
                            "Registered new speaker %s for tenant %s",
                            speaker_id,
                            tenant_id,
                        )
                        confidence = None
                        is_new = True
                else:
                    speaker_id = "unknown"
                    confidence = None
                    is_new = False

                speakers_seen.add(speaker_id)
                if is_new:
                    new_speakers += 1

                diarized_segments[idx] = DiarizedSegment(
                    text=text,
                    start_time=start,
                    end_time=end,
                    speaker_id=speaker_id,
                    speaker_confidence=confidence,
                    word_timestamps=seg.get("word_timestamps", []),
                )

            except Exception as e:
                logger.warning(
                    "Diarization failed for segment [%.1f–%.1f]: %s",
                    start,
                    end,
                    e,
                )
                diarized_segments[idx] = DiarizedSegment(
                    text=text,
                    start_time=start,
                    end_time=end,
                    speaker_id=None,
                    word_timestamps=seg.get("word_timestamps", []),
                )

        return DiarizationResult(
            segments=diarized_segments,  # type: ignore[arg-type]
            speakers_detected=len(speakers_seen),
            new_speakers_created=new_speakers,
            applied=True,
        )


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_identifier: SpeakerIdentifier | None = None


def get_speaker_identifier() -> SpeakerIdentifier:
    """Get singleton speaker identifier."""
    global _identifier
    if _identifier is None:
        _identifier = SpeakerIdentifier()
    return _identifier
