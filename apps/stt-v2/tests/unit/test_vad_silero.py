"""Unit tests for Silero VAD v5 module."""

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import numpy as np
import pytest

from stt_v2.vad.dto import SpeechSegment, VADResult, VADSessionState
from stt_v2.vad.session_manager import VADSessionManager
from stt_v2.vad.silero_service import SileroVADService

# =============================================================================
# DTO Tests
# =============================================================================


class TestSpeechSegmentDTO:
    def test_duration_property(self):
        seg = SpeechSegment(start_time=0.0, end_time=1.5, probability=0.9)
        assert seg.duration == 1.5

    def test_default_probability(self):
        seg = SpeechSegment(start_time=0.0, end_time=1.0)
        assert seg.probability == 1.0


class TestVADResultDTO:
    def test_speech_ratio(self):
        result = VADResult(speech_duration=2.0, audio_duration=4.0, applied=True)
        assert result.speech_ratio == 0.5

    def test_speech_ratio_zero_audio(self):
        result = VADResult(speech_duration=0.0, audio_duration=0.0)
        assert result.speech_ratio == 0.0

    def test_has_speech_true(self):
        result = VADResult(segments=[SpeechSegment(0.0, 1.0)])
        assert result.has_speech is True

    def test_has_speech_false(self):
        result = VADResult(segments=[])
        assert result.has_speech is False

    def test_defaults(self):
        result = VADResult()
        assert result.segments == []
        assert result.applied is False


class TestVADSessionStateDTO:
    def test_reset_clears_state(self):
        state = VADSessionState(session_id="test")
        state.samples_processed = 5000
        state.is_speech_active = True
        state.speech_start_sample = 100
        state.pending_segments = [SpeechSegment(0.0, 1.0)]

        state.reset()

        assert state.samples_processed == 0
        assert state.is_speech_active is False
        assert state.speech_start_sample == 0
        assert state.pending_segments == []
        assert state.h_state is not None
        assert state.h_state.shape == (2, 1, 128)


# =============================================================================
# SileroVADService Tests — mock the ONNX session directly
# =============================================================================


def _make_loaded_service() -> tuple[SileroVADService, MagicMock]:
    """Create a SileroVADService with a mocked ONNX session."""
    service = SileroVADService()

    mock_session = MagicMock()
    # Default: return speech probability 0.9 and fresh state
    mock_session.run.return_value = [
        np.array([[0.9]], dtype=np.float32),
        np.zeros((2, 1, 128), dtype=np.float32),
    ]

    service._session = mock_session
    service._loaded = True
    return service, mock_session


class TestSileroVADServiceBatch:
    """Batch (detect_speech) tests."""

    def test_detect_speech_all_speech(self, mocker):
        mocker.patch(
            "stt_v2.vad.silero_service.get_settings",
            return_value=MagicMock(
                vad_threshold=0.5,
                vad_min_speech_duration_ms=250,
                vad_min_silence_duration_ms=500,
                vad_speech_pad_ms=30,
            ),
        )
        service, mock_session = _make_loaded_service()

        # 1 second of audio at 16 kHz → ~31 frames of 512 samples
        samples = np.random.randn(16000).astype(np.float32)
        result = service.detect_speech(samples, sample_rate=16000)

        assert result.applied is True
        assert len(result.segments) > 0
        assert result.audio_duration == pytest.approx(1.0, rel=0.01)

    def test_detect_speech_all_silence(self, mocker):
        mocker.patch(
            "stt_v2.vad.silero_service.get_settings",
            return_value=MagicMock(
                vad_threshold=0.5,
                vad_min_speech_duration_ms=250,
                vad_min_silence_duration_ms=500,
                vad_speech_pad_ms=30,
            ),
        )
        service, mock_session = _make_loaded_service()
        # All probabilities below threshold
        mock_session.run.return_value = [
            np.array([[0.1]], dtype=np.float32),
            np.zeros((2, 1, 128), dtype=np.float32),
        ]

        samples = np.random.randn(16000).astype(np.float32)
        result = service.detect_speech(samples, sample_rate=16000)

        assert result.applied is True
        assert len(result.segments) == 0
        assert result.speech_duration == 0.0

    def test_detect_speech_not_loaded_raises(self):
        service = SileroVADService()
        with pytest.raises(RuntimeError, match="not initialised"):
            service.detect_speech(np.zeros(16000, dtype=np.float32))

    def test_detect_speech_8khz_sample_rate(self, mocker):
        """VAD should work with 8kHz audio (common for telephony)."""
        mocker.patch(
            "stt_v2.vad.silero_service.get_settings",
            return_value=MagicMock(
                vad_threshold=0.5,
                vad_min_speech_duration_ms=250,
                vad_min_silence_duration_ms=500,
                vad_speech_pad_ms=30,
            ),
        )
        service, mock_session = _make_loaded_service()

        # 1 second of audio at 8 kHz
        samples = np.random.randn(8000).astype(np.float32)
        result = service.detect_speech(samples, sample_rate=8000)

        assert result.applied is True
        assert result.audio_duration == pytest.approx(1.0, rel=0.01)

    def test_detect_speech_very_short_audio(self, mocker):
        """Audio shorter than one frame (512 samples) should not crash."""
        mocker.patch(
            "stt_v2.vad.silero_service.get_settings",
            return_value=MagicMock(
                vad_threshold=0.5,
                vad_min_speech_duration_ms=250,
                vad_min_silence_duration_ms=500,
                vad_speech_pad_ms=30,
            ),
        )
        service, mock_session = _make_loaded_service()

        # Only 100 samples — less than one 512-sample frame
        samples = np.random.randn(100).astype(np.float32)
        result = service.detect_speech(samples, sample_rate=16000)

        assert result.applied is True
        # Should handle gracefully — either 0 segments or 1 padded frame
        assert isinstance(result.segments, list)

    def test_detect_speech_zero_length_audio(self, mocker):
        """Empty audio array should not crash."""
        mocker.patch(
            "stt_v2.vad.silero_service.get_settings",
            return_value=MagicMock(
                vad_threshold=0.5,
                vad_min_speech_duration_ms=250,
                vad_min_silence_duration_ms=500,
                vad_speech_pad_ms=30,
            ),
        )
        service, mock_session = _make_loaded_service()

        samples = np.array([], dtype=np.float32)
        result = service.detect_speech(samples, sample_rate=16000)

        assert result.applied is True
        assert len(result.segments) == 0
        assert result.speech_duration == 0.0


class TestProbs2SegmentsEndPadding:
    """Test that _probs_to_segments applies padding to BOTH start and end (TASK-008 2.1)."""

    def test_segment_end_includes_padding(self):
        """Segment end time should include pad_samples beyond last speech frame."""
        # Create 20 frames: frames 5-14 are speech (above threshold)
        probs = [0.1] * 5 + [0.9] * 10 + [0.1] * 5
        frame_size = 512
        sample_rate = 16000
        total_samples = len(probs) * frame_size
        pad_ms = 50  # 50ms padding = 800 samples at 16kHz
        pad_samples = int(pad_ms * sample_rate / 1000)

        segments = SileroVADService._probs_to_segments(
            probs=probs,
            frame_size=frame_size,
            sample_rate=sample_rate,
            threshold=0.5,
            min_speech_ms=0,  # Accept any speech length
            min_silence_ms=100,
            pad_ms=pad_ms,
            total_samples=total_samples,
        )

        assert len(segments) >= 1
        seg = segments[0]

        # Start should have padding subtracted (frame 5 * 512 - 800 = 1760)
        expected_start = max(0, 5 * frame_size - pad_samples) / sample_rate
        assert seg.start_time == pytest.approx(expected_start, abs=0.01)

        # End should have padding added beyond the last speech frame
        # Last speech frame is 14, silence starts at 15, so end frame = 15
        # end_sample = min(total, 15 * 512 + 800)
        raw_end = 15 * frame_size + pad_samples
        expected_end = min(total_samples, raw_end) / sample_rate
        assert seg.end_time == pytest.approx(expected_end, abs=0.01)

    def test_segment_end_clamped_to_total_samples(self):
        """End padding should not exceed total_samples."""
        # Speech at the very end of the audio
        probs = [0.1] * 5 + [0.9] * 5  # Speech in last 5 frames
        frame_size = 512
        sample_rate = 16000
        total_samples = len(probs) * frame_size
        pad_ms = 500  # Very large padding

        segments = SileroVADService._probs_to_segments(
            probs=probs,
            frame_size=frame_size,
            sample_rate=sample_rate,
            threshold=0.5,
            min_speech_ms=0,
            min_silence_ms=100,
            pad_ms=pad_ms,
            total_samples=total_samples,
        )

        # Trailing speech: end should be clamped to total_samples
        assert len(segments) >= 1
        for seg in segments:
            assert seg.end_time <= total_samples / sample_rate

    def test_zero_padding_produces_exact_boundaries(self):
        """With pad_ms=0, segment boundaries should match exact speech frames."""
        probs = [0.1] * 3 + [0.9] * 5 + [0.1] * 3
        frame_size = 512
        sample_rate = 16000
        total_samples = len(probs) * frame_size

        segments = SileroVADService._probs_to_segments(
            probs=probs,
            frame_size=frame_size,
            sample_rate=sample_rate,
            threshold=0.5,
            min_speech_ms=0,
            min_silence_ms=100,
            pad_ms=0,
            total_samples=total_samples,
        )

        assert len(segments) >= 1
        seg = segments[0]
        # Start should be exactly at frame 3 (no padding subtracted)
        assert seg.start_time == pytest.approx(3 * frame_size / sample_rate, abs=0.001)

    def test_all_silence_produces_no_segments(self):
        """When all frames are below threshold, no segments should be returned."""
        probs = [0.1] * 20  # All silence
        frame_size = 512
        sample_rate = 16000
        total_samples = len(probs) * frame_size

        segments = SileroVADService._probs_to_segments(
            probs=probs,
            frame_size=frame_size,
            sample_rate=sample_rate,
            threshold=0.5,
            min_speech_ms=0,
            min_silence_ms=100,
            pad_ms=30,
            total_samples=total_samples,
        )

        assert segments == []

    def test_speech_shorter_than_min_speech_ms_discarded(self):
        """Speech segments shorter than min_speech_ms should be filtered out."""
        # 1 frame of speech at 16kHz = 512/16000 = 32ms
        probs = [0.1] * 3 + [0.9] * 1 + [0.1] * 10
        frame_size = 512
        sample_rate = 16000
        total_samples = len(probs) * frame_size

        segments = SileroVADService._probs_to_segments(
            probs=probs,
            frame_size=frame_size,
            sample_rate=sample_rate,
            threshold=0.5,
            min_speech_ms=250,  # Require at least 250ms (~8 frames)
            min_silence_ms=100,
            pad_ms=0,
            total_samples=total_samples,
        )

        # Single frame (32ms) should be discarded because min_speech_ms=250
        assert segments == []

    def test_single_frame_speech_at_boundary(self):
        """Speech in the very first frame should be handled correctly."""
        probs = [0.9] * 10 + [0.1] * 5
        frame_size = 512
        sample_rate = 16000
        total_samples = len(probs) * frame_size
        pad_ms = 30

        segments = SileroVADService._probs_to_segments(
            probs=probs,
            frame_size=frame_size,
            sample_rate=sample_rate,
            threshold=0.5,
            min_speech_ms=0,
            min_silence_ms=100,
            pad_ms=pad_ms,
            total_samples=total_samples,
        )

        assert len(segments) >= 1
        # Start should be clamped to 0 (pad goes negative but max(0, ...) applies)
        assert segments[0].start_time >= 0.0

    def test_empty_probs_list(self):
        """Empty probability list should return no segments."""
        segments = SileroVADService._probs_to_segments(
            probs=[],
            frame_size=512,
            sample_rate=16000,
            threshold=0.5,
            min_speech_ms=0,
            min_silence_ms=100,
            pad_ms=30,
            total_samples=0,
        )
        assert segments == []


class TestSileroVADServiceStreaming:
    """Streaming (process_chunk) tests."""

    def test_process_chunk_returns_probability(self):
        service, mock_session = _make_loaded_service()
        state = VADSessionState(session_id="s1")
        state.h_state = np.zeros((2, 1, 128), dtype=np.float32)

        prob = service.process_chunk(np.zeros(512, dtype=np.float32), state)

        assert prob == pytest.approx(0.9)
        assert state.samples_processed == 512

    def test_process_chunk_pads_short(self):
        service, mock_session = _make_loaded_service()
        state = service.create_session_state("s2")

        prob = service.process_chunk(np.zeros(100, dtype=np.float32), state)
        assert isinstance(prob, float)

        # The input to onnx session.run should still be (1, 512)
        call_args = mock_session.run.call_args
        input_data = (
            call_args[1]["input"] if "input" in (call_args[1] or {}) else call_args[0][1]["input"]
        )
        assert input_data.shape == (1, 512)

    def test_process_chunk_not_loaded_raises(self):
        service = SileroVADService()
        state = VADSessionState(session_id="s3")
        with pytest.raises(RuntimeError, match="not initialised"):
            service.process_chunk(np.zeros(512, dtype=np.float32), state)

    def test_create_session_state(self):
        service, _ = _make_loaded_service()
        state = service.create_session_state("test-session", sample_rate=8000)

        assert state.session_id == "test-session"
        assert state.sample_rate == 8000
        assert state.h_state.shape == (2, 1, 128)
        assert state.samples_processed == 0


# =============================================================================
# VADSessionManager Tests
# =============================================================================


class TestVADSessionStateDatetimeAware:
    """Verify VADSessionState uses timezone-aware datetimes (TASK-008 4.1)."""

    def test_created_at_is_timezone_aware(self):
        """created_at default should have timezone info (not naive)."""
        state = VADSessionState(session_id="tz-test")
        assert state.created_at.tzinfo is not None
        assert state.created_at.tzinfo == UTC

    def test_last_activity_is_timezone_aware(self):
        """last_activity default should have timezone info (not naive)."""
        state = VADSessionState(session_id="tz-test-2")
        assert state.last_activity.tzinfo is not None
        assert state.last_activity.tzinfo == UTC

    def test_reset_updates_last_activity_with_timezone(self):
        """After reset, last_activity should still be timezone-aware."""
        state = VADSessionState(session_id="tz-reset")
        import numpy as _np

        state.h_state = _np.zeros((2, 1, 128), dtype=_np.float32)

        old_activity = state.last_activity
        state.reset()

        assert state.last_activity.tzinfo is not None
        assert state.last_activity >= old_activity


class TestVADSessionManager:
    @pytest.fixture
    def mock_vad_service(self):
        service = MagicMock(spec=SileroVADService)
        service.create_session_state.side_effect = lambda session_id, sample_rate=16000: (
            VADSessionState(
                session_id=session_id,
                sample_rate=sample_rate,
                h_state=np.zeros((2, 1, 128), dtype=np.float32),
            )
        )
        return service

    async def test_get_or_create_new(self, mock_vad_service):
        mgr = VADSessionManager(vad_service=mock_vad_service)
        state = await mgr.get_or_create("session-1")

        assert state.session_id == "session-1"
        assert mgr.active_session_count == 1

    async def test_get_or_create_existing(self, mock_vad_service):
        mgr = VADSessionManager(vad_service=mock_vad_service)
        s1 = await mgr.get_or_create("session-1")
        s2 = await mgr.get_or_create("session-1")

        assert s1 is s2
        assert mgr.active_session_count == 1

    async def test_get_unknown(self, mock_vad_service):
        mgr = VADSessionManager(vad_service=mock_vad_service)
        assert await mgr.get("nonexistent") is None

    async def test_remove(self, mock_vad_service):
        mgr = VADSessionManager(vad_service=mock_vad_service)
        await mgr.get_or_create("session-1")
        await mgr.remove("session-1")
        assert mgr.active_session_count == 0

    async def test_reset_session(self, mock_vad_service):
        mgr = VADSessionManager(vad_service=mock_vad_service)
        state = await mgr.get_or_create("session-1")
        state.samples_processed = 999

        await mgr.reset("session-1")

        refreshed = await mgr.get("session-1")
        assert refreshed.samples_processed == 0

    async def test_cleanup_expired(self, mock_vad_service):
        mgr = VADSessionManager(vad_service=mock_vad_service, max_idle_seconds=60)
        _s1 = await mgr.get_or_create("recent")
        s2 = await mgr.get_or_create("old")

        # Make s2 appear expired
        s2.last_activity = datetime.now(UTC) - timedelta(seconds=120)

        cleaned = await mgr.cleanup_expired()
        assert cleaned == 1
        assert mgr.active_session_count == 1
        assert await mgr.get("recent") is not None
        assert await mgr.get("old") is None

    async def test_remove_nonexistent_is_noop(self, mock_vad_service):
        """Removing a session that doesn't exist should not raise."""
        mgr = VADSessionManager(vad_service=mock_vad_service)
        await mgr.remove("nonexistent")
        assert mgr.active_session_count == 0

    async def test_reset_nonexistent_is_noop(self, mock_vad_service):
        """Resetting a session that doesn't exist should not raise."""
        mgr = VADSessionManager(vad_service=mock_vad_service)
        await mgr.reset("nonexistent")  # Should not raise
        assert mgr.active_session_count == 0

    async def test_cleanup_all_expired(self, mock_vad_service):
        """When all sessions are expired, cleanup should remove all."""
        mgr = VADSessionManager(vad_service=mock_vad_service, max_idle_seconds=60)
        s1 = await mgr.get_or_create("a")
        s2 = await mgr.get_or_create("b")
        s1.last_activity = datetime.now(UTC) - timedelta(seconds=120)
        s2.last_activity = datetime.now(UTC) - timedelta(seconds=120)

        cleaned = await mgr.cleanup_expired()
        assert cleaned == 2
        assert mgr.active_session_count == 0

    async def test_cleanup_none_expired(self, mock_vad_service):
        """When no sessions are expired, cleanup should remove none."""
        mgr = VADSessionManager(vad_service=mock_vad_service, max_idle_seconds=60)
        await mgr.get_or_create("fresh")

        cleaned = await mgr.cleanup_expired()
        assert cleaned == 0
        assert mgr.active_session_count == 1

    async def test_multiple_sessions_tracked(self, mock_vad_service):
        """Manager should correctly track multiple independent sessions."""
        mgr = VADSessionManager(vad_service=mock_vad_service)
        for i in range(10):
            await mgr.get_or_create(f"session-{i}")

        assert mgr.active_session_count == 10

        for i in range(5):
            await mgr.remove(f"session-{i}")

        assert mgr.active_session_count == 5
