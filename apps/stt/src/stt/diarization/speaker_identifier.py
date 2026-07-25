"""Session-scoped speaker identification.

Replaces the Qdrant-based SpeakerIdentifier with in-memory
session-scoped N-speaker tracking.
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np

from ..pipeline.dto import DiarizationConfig
from .dto import DiarizedSegment, SpeakerEmbedding, SpeakerIdentification
from .speaker_tracker import SpeakerTracker

logger = logging.getLogger(__name__)


class SpeakerIdentifier:
    """Session-scoped speaker identification. No external I/O."""

    def __init__(
        self,
        tracker: SpeakerTracker,
        embedding_service: Any | None = None,
        segmentation_service: Any | None = None,
        config: DiarizationConfig | None = None,
    ) -> None:
        self._tracker = tracker
        self._embedding_service = embedding_service
        self._segmentation_service = segmentation_service
        self._config = config or DiarizationConfig()

    async def identify(
        self,
        embedding: SpeakerEmbedding,
        samples: np.ndarray | None = None,
        sample_rate: int = 16000,
        config: DiarizationConfig | None = None,
        _depth: int = 0,
    ) -> SpeakerIdentification | list[DiarizedSegment]:
        """Single-segment identification.

        _depth: recursion guard. 0 = top-level (may trigger segmentation),
                1 = sub-segment (never triggers segmentation).
        """
        cfg = config or self._config
        embed = np.asarray(embedding.embedding, dtype=np.float32)

        best_id, confidence = self._tracker.compare(embed)

        # Case 1: No speakers registered -> register first speaker
        if best_id is None:
            new_id = self._tracker.register(embed)
            if new_id is None:
                return SpeakerIdentification(
                    speaker_id="unknown", confidence=None, is_new_speaker=False,
                )
            return SpeakerIdentification(
                speaker_id=new_id, confidence=None, is_new_speaker=True,
            )

        # Case 2: Confident match
        if confidence >= cfg.high_threshold:
            if confidence >= cfg.min_update_confidence:
                self._tracker.update_reference(best_id, embed)
            return SpeakerIdentification(
                speaker_id=best_id, confidence=confidence, is_new_speaker=False,
            )

        # Case 3: Confident new speaker
        if confidence < cfg.low_threshold:
            new_id = self._tracker.register(embed)
            if new_id is None:
                # At capacity -- fallback to best match
                return SpeakerIdentification(
                    speaker_id=best_id, confidence=confidence, is_new_speaker=False,
                )
            return SpeakerIdentification(
                speaker_id=new_id, confidence=None, is_new_speaker=True,
            )

        # Case 4: Ambiguous zone
        if (
            _depth == 0
            and cfg.enable_segmentation_refinement
            and self._segmentation_service is not None
            and samples is not None
            and self._embedding_service is not None
        ):
            try:
                sub_segments = await self._segmentation_service.detect_speaker_turns(
                    samples, sample_rate, min_segment_s=0.5,
                )
                if len(sub_segments) > 1:
                    results: list[DiarizedSegment] = []
                    for sub_start, sub_end in sub_segments:
                        start_idx = int(sub_start * sample_rate)
                        end_idx = int(sub_end * sample_rate)
                        sub_audio = samples[start_idx:end_idx]
                        if len(sub_audio) == 0:
                            continue

                        sub_emb = await self._embedding_service.extract_from_samples(
                            sub_audio, sample_rate,
                        )
                        sub_result = await self.identify(
                            sub_emb, _depth=1,
                        )
                        if isinstance(sub_result, SpeakerIdentification):
                            results.append(DiarizedSegment(
                                text="",
                                start_time=sub_start,
                                end_time=sub_end,
                                speaker_id=sub_result.speaker_id,
                                speaker_confidence=sub_result.confidence,
                            ))
                    if results:
                        return results
            except Exception:
                logger.warning(
                    "Segmentation refinement failed, falling back to best match",
                    exc_info=True,
                )

        # Fallback: assign to best match
        return SpeakerIdentification(
            speaker_id=best_id, confidence=confidence, is_new_speaker=False,
        )
