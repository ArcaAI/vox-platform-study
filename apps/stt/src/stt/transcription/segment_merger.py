"""Merge adjacent VAD speech segments to reduce Whisper inference calls.

The Whisper encoder processes a fixed 30-second mel spectrogram regardless
of input audio length, creating ~6s overhead per ``generate()`` call on CPU.
Merging short adjacent segments into larger chunks dramatically reduces
the total number of inference calls.

This follows the same approach used by WhisperX (``merge_chunks``) and
faster-whisper (``collect_chunks``).
"""

from __future__ import annotations

import logging

from .dto import AudioSegment

logger = logging.getLogger(__name__)


def merge_vad_segments(
    segments: list[AudioSegment],
    max_duration_s: float = 15.0,
    gap_threshold_s: float = 2.0,
) -> list[AudioSegment]:
    """Merge adjacent VAD speech segments into larger inference chunks.

    Adjacent speech segments separated by a gap smaller than
    *gap_threshold_s* are merged into a single segment, provided the
    resulting segment does not exceed *max_duration_s*.

    The merged segment spans from the earliest ``start_time`` to the
    latest ``end_time`` of its constituents.  Silence between segments
    is included in the merged audio — Whisper handles mixed
    speech/silence well and this preserves timestamp accuracy.

    Args:
        segments: VAD segments (may include non-speech markers).
        max_duration_s: Maximum duration of a merged segment.  Should
            match ``InferenceConfig.chunk_length_sec`` (default 15s; the agent's
            ``decoding.chunkLengthSec`` when it sets one).
        gap_threshold_s: Maximum gap (seconds) between segments that
            allows merging.  Set to 0 to disable merging.

    Returns:
        New list of merged ``AudioSegment`` objects (speech only).
    """
    if gap_threshold_s <= 0:
        # Merging disabled — return speech segments as-is
        return [s for s in segments if s.is_speech]

    # Filter to speech-only segments, sorted by start time
    speech = sorted(
        [s for s in segments if s.is_speech],
        key=lambda s: s.start_time,
    )

    if not speech:
        return []

    merged: list[AudioSegment] = []

    # Start with a copy of the first segment
    cur_start = speech[0].start_time
    cur_end = speech[0].end_time
    cur_confidence = speech[0].confidence

    for seg in speech[1:]:
        gap = seg.start_time - cur_end
        merged_duration = seg.end_time - cur_start

        if gap <= gap_threshold_s and merged_duration <= max_duration_s:
            # Extend current group
            cur_end = seg.end_time
            cur_confidence = min(cur_confidence, seg.confidence)
        else:
            # Emit current group and start a new one
            merged.append(
                AudioSegment(
                    start_time=cur_start,
                    end_time=cur_end,
                    is_speech=True,
                    confidence=cur_confidence,
                )
            )
            cur_start = seg.start_time
            cur_end = seg.end_time
            cur_confidence = seg.confidence

    # Emit the last group
    merged.append(
        AudioSegment(
            start_time=cur_start,
            end_time=cur_end,
            is_speech=True,
            confidence=cur_confidence,
        )
    )

    if len(merged) < len(speech):
        logger.info(
            "Merged %d VAD segments into %d chunks " "(max_duration=%.1fs, gap_threshold=%.1fs)",
            len(speech),
            len(merged),
            max_duration_s,
            gap_threshold_s,
        )

    return merged
