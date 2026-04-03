"""Tests for VAD segment merging before Whisper inference.

TASK-017: Per-Segment Inference Optimization
"""

from stt_v2.transcription.dto import AudioSegment
from stt_v2.transcription.segment_merger import merge_vad_segments


class TestMergeVadSegments:
    """Test merge_vad_segments() utility."""

    # ------------------------------------------------------------------
    # Edge cases
    # ------------------------------------------------------------------

    def test_empty_segments_returns_empty(self):
        assert merge_vad_segments([], max_duration_s=15.0) == []

    def test_single_segment_unchanged(self):
        segs = [AudioSegment(start_time=1.0, end_time=2.0)]
        result = merge_vad_segments(segs, max_duration_s=15.0)
        assert len(result) == 1
        assert result[0].start_time == 1.0
        assert result[0].end_time == 2.0

    def test_non_speech_segments_excluded(self):
        segs = [
            AudioSegment(start_time=0.0, end_time=1.0, is_speech=False),
            AudioSegment(start_time=1.0, end_time=2.0, is_speech=False),
        ]
        result = merge_vad_segments(segs, max_duration_s=15.0)
        assert result == []

    # ------------------------------------------------------------------
    # Merging behaviour
    # ------------------------------------------------------------------

    def test_adjacent_segments_within_gap_are_merged(self):
        """Segments with gap <= threshold should merge into one."""
        segs = [
            AudioSegment(start_time=1.0, end_time=2.0),
            AudioSegment(start_time=2.5, end_time=3.5),
            AudioSegment(start_time=4.0, end_time=5.0),
        ]
        result = merge_vad_segments(
            segs,
            max_duration_s=15.0,
            gap_threshold_s=1.0,
        )
        assert len(result) == 1
        assert result[0].start_time == 1.0
        assert result[0].end_time == 5.0

    def test_large_gap_prevents_merge(self):
        """Segments separated by more than gap_threshold should stay split."""
        segs = [
            AudioSegment(start_time=1.0, end_time=2.0),
            AudioSegment(start_time=10.0, end_time=11.0),
        ]
        result = merge_vad_segments(
            segs,
            max_duration_s=15.0,
            gap_threshold_s=2.0,
        )
        assert len(result) == 2
        assert result[0].start_time == 1.0
        assert result[1].start_time == 10.0

    def test_respects_max_duration(self):
        """Should not merge if result would exceed max_duration_s."""
        segs = [
            AudioSegment(start_time=0.0, end_time=8.0),
            AudioSegment(start_time=8.5, end_time=16.0),
        ]
        result = merge_vad_segments(
            segs,
            max_duration_s=10.0,
            gap_threshold_s=1.0,
        )
        assert len(result) == 2

    def test_max_duration_boundary_exact(self):
        """Merged duration exactly at max_duration_s should be allowed."""
        segs = [
            AudioSegment(start_time=0.0, end_time=5.0),
            AudioSegment(start_time=6.0, end_time=10.0),  # total span = 10s
        ]
        result = merge_vad_segments(
            segs,
            max_duration_s=10.0,
            gap_threshold_s=2.0,
        )
        assert len(result) == 1
        assert result[0].end_time == 10.0

    # ------------------------------------------------------------------
    # Confidence tracking
    # ------------------------------------------------------------------

    def test_confidence_is_minimum_of_merged(self):
        segs = [
            AudioSegment(start_time=1.0, end_time=2.0, confidence=0.95),
            AudioSegment(start_time=2.5, end_time=3.5, confidence=0.80),
            AudioSegment(start_time=4.0, end_time=5.0, confidence=0.90),
        ]
        result = merge_vad_segments(
            segs,
            max_duration_s=15.0,
            gap_threshold_s=2.0,
        )
        assert len(result) == 1
        assert result[0].confidence == 0.80

    # ------------------------------------------------------------------
    # Mixed speech / non-speech
    # ------------------------------------------------------------------

    def test_non_speech_between_speech_is_ignored_for_filtering(self):
        """Non-speech segments are excluded; gap measured between speech."""
        segs = [
            AudioSegment(start_time=1.0, end_time=2.0, is_speech=True),
            AudioSegment(start_time=2.5, end_time=3.5, is_speech=False),
            AudioSegment(start_time=4.0, end_time=5.0, is_speech=True),
        ]
        result = merge_vad_segments(
            segs,
            max_duration_s=15.0,
            gap_threshold_s=3.0,
        )
        # Gap between speech segments is 4.0 - 2.0 = 2.0, within threshold
        assert len(result) == 1
        assert result[0].start_time == 1.0
        assert result[0].end_time == 5.0
        assert result[0].is_speech is True

    # ------------------------------------------------------------------
    # Ordering
    # ------------------------------------------------------------------

    def test_unsorted_segments_are_handled(self):
        """Segments given out of order should still merge correctly."""
        segs = [
            AudioSegment(start_time=4.0, end_time=5.0),
            AudioSegment(start_time=1.0, end_time=2.0),
            AudioSegment(start_time=2.5, end_time=3.5),
        ]
        result = merge_vad_segments(
            segs,
            max_duration_s=15.0,
            gap_threshold_s=2.0,
        )
        assert len(result) == 1
        assert result[0].start_time == 1.0
        assert result[0].end_time == 5.0

    # ------------------------------------------------------------------
    # Disable merging
    # ------------------------------------------------------------------

    def test_gap_threshold_zero_disables_merging(self):
        """gap_threshold_s=0 should return speech segments unmerged."""
        segs = [
            AudioSegment(start_time=1.0, end_time=2.0),
            AudioSegment(start_time=2.5, end_time=3.5),
        ]
        result = merge_vad_segments(
            segs,
            max_duration_s=15.0,
            gap_threshold_s=0,
        )
        assert len(result) == 2

    # ------------------------------------------------------------------
    # Real-world scenario: test_04 data (28 segments over 60s)
    # ------------------------------------------------------------------

    def test_real_world_28_segments(self):
        """Simulate test_04: 28 short segments over 60s audio.

        With max_duration_s=15 and gap_threshold_s=2.0, these 28 segments
        should merge into far fewer chunks.
        """
        segs = [
            AudioSegment(start_time=3.362, end_time=4.382),
            AudioSegment(start_time=7.426, end_time=7.774),
            AudioSegment(start_time=8.066, end_time=8.638),
            AudioSegment(start_time=9.570, end_time=10.206),
            AudioSegment(start_time=10.530, end_time=10.974),
            AudioSegment(start_time=11.170, end_time=13.022),
            AudioSegment(start_time=14.690, end_time=15.326),
            AudioSegment(start_time=15.490, end_time=16.062),
            AudioSegment(start_time=16.226, end_time=17.246),
            AudioSegment(start_time=17.730, end_time=19.038),
            AudioSegment(start_time=21.090, end_time=23.166),
            AudioSegment(start_time=24.002, end_time=24.318),
            AudioSegment(start_time=24.482, end_time=25.854),
            AudioSegment(start_time=26.434, end_time=27.102),
            AudioSegment(start_time=28.034, end_time=28.734),
            AudioSegment(start_time=29.698, end_time=30.014),
            AudioSegment(start_time=30.530, end_time=32.446),
            AudioSegment(start_time=32.578, end_time=33.150),
            AudioSegment(start_time=34.242, end_time=34.974),
            AudioSegment(start_time=35.394, end_time=36.926),
            AudioSegment(start_time=38.370, end_time=39.902),
            AudioSegment(start_time=41.314, end_time=42.014),
            AudioSegment(start_time=42.530, end_time=45.246),
            AudioSegment(start_time=46.210, end_time=48.702),
            AudioSegment(start_time=50.210, end_time=51.710),
            AudioSegment(start_time=53.506, end_time=53.982),
            AudioSegment(start_time=54.178, end_time=58.270),
            AudioSegment(start_time=58.914, end_time=60.000),
        ]

        result = merge_vad_segments(
            segs,
            max_duration_s=15.0,
            gap_threshold_s=2.0,
        )

        # Should be dramatically fewer than 28
        assert len(result) < 10, f"Expected < 10 merged chunks, got {len(result)}"
        assert len(result) >= 2, f"Expected >= 2 chunks, got {len(result)}"

        # Boundaries must be preserved
        assert result[0].start_time == 3.362
        assert result[-1].end_time == 60.000

        # Every merged segment must be speech
        assert all(s.is_speech for s in result)

        # No merged segment exceeds max_duration_s
        for s in result:
            assert s.duration <= 15.0 + 0.001, (
                f"Segment {s.start_time}–{s.end_time} " f"duration {s.duration:.3f}s exceeds 15s"
            )

    def test_real_world_segments_with_tighter_gap(self):
        """With gap_threshold=1.0, fewer merges should happen."""
        segs = [
            AudioSegment(start_time=3.362, end_time=4.382),
            AudioSegment(start_time=7.426, end_time=7.774),  # gap 3.04s - too big
            AudioSegment(start_time=8.066, end_time=8.638),
            AudioSegment(start_time=9.570, end_time=10.206),
        ]
        result = merge_vad_segments(
            segs,
            max_duration_s=15.0,
            gap_threshold_s=1.0,
        )
        # First segment stands alone (gap to second is 3.04s > 1.0)
        assert result[0].start_time == 3.362
        assert result[0].end_time == 4.382
        # Remaining three should merge (gaps are 0.29s and 0.93s)
        assert len(result) == 2
        assert result[1].start_time == 7.426
        assert result[1].end_time == 10.206
