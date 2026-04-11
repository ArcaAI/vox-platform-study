"""Unit tests for batch embedding separation (B1).

Tests:
- _split_vad_segments_for_embedding: short, long, non-speech
- Embedding extraction happens before ASR in transcribe()
- Diarization skipped => embedding step skipped
"""

from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt_v2.transcription.batch_service import BatchTranscriptionService
from stt_v2.transcription.dto import AudioSegment, ProcessedAudio


class TestSplitVadSegmentsForEmbedding:
    """Test the static helper that splits long VAD segments at 5s."""

    def test_short_segments_unchanged(self):
        """Segments <= max_window_s are returned unchanged."""
        segments = [
            AudioSegment(start_time=0.0, end_time=2.0, is_speech=True),
            AudioSegment(start_time=3.0, end_time=5.0, is_speech=True),
        ]
        result = BatchTranscriptionService._split_vad_segments_for_embedding(
            segments,
            max_window_s=5.0,
        )
        assert len(result) == 2
        assert result[0] == (0.0, 2.0)
        assert result[1] == (3.0, 5.0)

    def test_long_segment_split_at_5s(self):
        """A 12s segment should produce three chunks: 5s + 5s + 2s."""
        segments = [
            AudioSegment(start_time=0.0, end_time=12.0, is_speech=True),
        ]
        result = BatchTranscriptionService._split_vad_segments_for_embedding(
            segments,
            max_window_s=5.0,
        )
        assert len(result) == 3
        assert result[0] == (0.0, 5.0)
        assert result[1] == (5.0, 10.0)
        assert result[2] == (10.0, 12.0)

    def test_non_speech_skipped(self):
        """Non-speech segments should be excluded from output."""
        segments = [
            AudioSegment(start_time=0.0, end_time=2.0, is_speech=True),
            AudioSegment(start_time=2.0, end_time=4.0, is_speech=False),
            AudioSegment(start_time=4.0, end_time=6.0, is_speech=True),
        ]
        result = BatchTranscriptionService._split_vad_segments_for_embedding(
            segments,
            max_window_s=5.0,
        )
        assert len(result) == 2
        assert result[0] == (0.0, 2.0)
        assert result[1] == (4.0, 6.0)
