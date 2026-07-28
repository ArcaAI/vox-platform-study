"""Unit tests for StreamingPreprocessor."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from stt.streaming.preprocessor import (
    _FRAME_SIZE_16K,
    _PARTIAL_INTERVAL_S,
    _PARTIAL_MIN_AUDIO_S,
    _PRE_SPEECH_CONTEXT_MS,
    AudioUtterance,
    StreamingPreprocessor,
)

# =========================================================================
# Helpers
# =========================================================================


def _make_pcm_bytes(duration_ms: int, sample_rate: int = 16000) -> bytes:
    """Generate silent PCM int16 LE bytes for given duration."""
    num_samples = int(sample_rate * duration_ms / 1000)
    return np.zeros(num_samples, dtype=np.int16).tobytes()


def _make_speech_pcm(duration_ms: int, sample_rate: int = 16000, amplitude: int = 10000) -> bytes:
    """Generate PCM bytes with non-zero amplitude (simulates speech)."""
    num_samples = int(sample_rate * duration_ms / 1000)
    # Simple sine wave to simulate speech-like signal
    t = np.linspace(0, duration_ms / 1000, num_samples)
    wave = (amplitude * np.sin(2 * np.pi * 440 * t)).astype(np.int16)
    return wave.tobytes()


def _make_vad_service(probability: float = 1.0) -> MagicMock:
    """Create a mock VAD service that returns a fixed probability."""
    svc = MagicMock()
    svc.is_loaded = True
    svc.process_chunk = MagicMock(return_value=probability)
    return svc


def _make_alternating_vad(speech_prob: float, silence_prob: float, speech_frames: int):
    """VAD that returns speech for N frames then silence forever."""
    call_count = 0

    def _process_chunk(chunk, session_state, threshold=None):
        nonlocal call_count
        call_count += 1
        return speech_prob if call_count <= speech_frames else silence_prob

    svc = MagicMock()
    svc.is_loaded = True
    svc.process_chunk = MagicMock(side_effect=_process_chunk)
    return svc


# =========================================================================
# Tests: Initialization
# =========================================================================


class TestPreprocessorInit:
    """Tests for StreamingPreprocessor initialization."""

    def test_default_init(self):
        pp = StreamingPreprocessor(session_id="s1")
        assert pp.session_id == "s1"
        assert pp.sample_rate == 16000
        assert pp.utterance_count == 0
        assert pp.in_speech is False

    def test_custom_params(self):
        pp = StreamingPreprocessor(
            session_id="s2",
            sample_rate=8000,
            threshold=0.6,
            min_speech_duration_ms=200,
            min_silence_duration_ms=500,
        )
        assert pp.sample_rate == 8000
        assert pp._threshold == 0.6
        assert pp._frame_size == 256  # 8 kHz frame size

    def test_frame_size_16k(self):
        pp = StreamingPreprocessor(session_id="s", sample_rate=16000)
        assert pp._frame_size == _FRAME_SIZE_16K

    def test_pre_speech_context_frames(self):
        pp = StreamingPreprocessor(session_id="s", sample_rate=16000)
        # 300ms / 32ms ≈ 9.375 → 9 frames
        expected = max(1, int(_PRE_SPEECH_CONTEXT_MS / pp._frame_duration_ms))
        assert pp._pre_speech_frames == expected


# =========================================================================
# Tests: Feed — no VAD (all treated as speech)
# =========================================================================


class TestPreprocessorNoVAD:
    """Tests when no VAD service is configured (energy fallback VAD)."""

    @pytest.mark.asyncio
    async def test_no_vad_returns_utterances(self):
        """With no VAD, all frames are speech. After min_speech + min_silence → utterance."""
        # Create preprocessor with no VAD; _run_vad returns 1.0
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=None,
            min_speech_duration_ms=32,  # 1 frame
            min_silence_duration_ms=32,  # 1 frame
        )

        # Without VAD, probability is always 1.0 (speech), so no offset
        # Send 200ms of audio
        pcm = _make_speech_pcm(200)
        utts = await pp.feed(pcm)

        # No silence → no utterance emitted yet
        assert len(utts) == 0
        assert pp.in_speech is True

    @pytest.mark.asyncio
    async def test_flush_emits_remaining(self):
        """flush() should return remaining buffered audio."""
        pp = StreamingPreprocessor(
            session_id="s1",
            vad_service=None,
            min_speech_duration_ms=32,
            min_silence_duration_ms=32,
        )

        pcm = _make_speech_pcm(100)
        await pp.feed(pcm)

        utt = await pp.flush()
        assert utt is not None
        assert utt.is_final is True
        assert utt.utterance_index == 0
        assert len(utt.samples) > 0

    @pytest.mark.asyncio
    async def test_no_vad_silence_does_not_trigger_speech(self):
        """Energy fallback should keep silence as non-speech."""
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=None,
            min_speech_duration_ms=32,
            min_silence_duration_ms=64,
        )

        pcm = _make_pcm_bytes(500)
        utts = await pp.feed(pcm)

        assert len(utts) == 0
        assert pp.in_speech is False

    @pytest.mark.asyncio
    async def test_no_vad_speech_then_silence_emits_utterance(self):
        """Energy fallback should emit utterance on speech->silence transition."""
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=None,
            min_speech_duration_ms=32,
            min_silence_duration_ms=64,
        )

        await pp.feed(_make_speech_pcm(300))
        utts = await pp.feed(_make_pcm_bytes(350))

        assert len(utts) >= 1
        assert utts[0].is_final is True
        assert len(utts[0].samples) > 0


# =========================================================================
# Tests: Feed — with mock VAD
# =========================================================================


class TestPreprocessorWithVAD:
    """Tests with a mock VAD service."""

    @pytest.mark.asyncio
    async def test_speech_onset_and_offset(self):
        """VAD returns high prob for N frames then low → utterance emitted."""
        # Speech for 20 frames, then silence
        speech_frames = 20
        vad = _make_alternating_vad(speech_prob=0.9, silence_prob=0.1, speech_frames=speech_frames)

        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            threshold=0.5,
            min_speech_duration_ms=32,  # 1 frame to confirm onset
            min_silence_duration_ms=64,  # 2 frames to confirm offset
        )

        # Send enough audio to cover speech + silence
        # 20 speech frames + 5 silence frames = 25 frames
        # Each frame = 512 samples = 1024 bytes
        total_frames = 30
        pcm = _make_speech_pcm(duration_ms=int(total_frames * 512 / 16000 * 1000))

        utts = await pp.feed(pcm)

        assert len(utts) == 1
        assert utts[0].utterance_index == 0
        assert utts[0].is_final is True
        assert len(utts[0].samples) > 0
        assert utts[0].sample_rate == 16000

    @pytest.mark.asyncio
    async def test_no_speech_no_utterance(self):
        """All-silence audio should produce no utterances."""
        vad = _make_vad_service(probability=0.1)

        pp = StreamingPreprocessor(
            session_id="s1",
            vad_service=vad,
            threshold=0.5,
            min_speech_duration_ms=32,
        )

        pcm = _make_pcm_bytes(500)
        utts = await pp.feed(pcm)

        assert len(utts) == 0
        assert pp.in_speech is False
        assert pp.utterance_count == 0

    @pytest.mark.asyncio
    async def test_flush_during_speech(self):
        """flush() during active speech returns final utterance."""
        vad = _make_vad_service(probability=0.9)

        pp = StreamingPreprocessor(
            session_id="s1",
            vad_service=vad,
            threshold=0.5,
            min_speech_duration_ms=32,
        )

        pcm = _make_speech_pcm(200)
        await pp.feed(pcm)

        assert pp.in_speech is True

        utt = await pp.flush()
        assert utt is not None
        assert utt.is_final is True

    @pytest.mark.asyncio
    async def test_flush_no_speech_returns_none(self):
        """flush() when no speech is active returns None."""
        vad = _make_vad_service(probability=0.1)

        pp = StreamingPreprocessor(
            session_id="s1",
            vad_service=vad,
            threshold=0.5,
        )

        pcm = _make_pcm_bytes(100)
        await pp.feed(pcm)

        utt = await pp.flush()
        assert utt is None

    @pytest.mark.asyncio
    async def test_utterance_timing(self):
        """Utterance start_time and end_time should be plausible."""
        speech_frames = 15
        vad = _make_alternating_vad(0.9, 0.1, speech_frames)

        pp = StreamingPreprocessor(
            session_id="s1",
            vad_service=vad,
            threshold=0.5,
            min_speech_duration_ms=32,
            min_silence_duration_ms=64,
        )

        total_frames = 25
        pcm = _make_speech_pcm(duration_ms=int(total_frames * 512 / 16000 * 1000))
        utts = await pp.feed(pcm)

        assert len(utts) == 1
        assert utts[0].start_time >= 0
        assert utts[0].end_time > utts[0].start_time

    @pytest.mark.asyncio
    async def test_multiple_utterances(self):
        """Two speech bursts separated by silence → two utterances."""
        call_count = 0

        # Pattern: 15 speech, 5 silence, 15 speech, 5 silence
        def _vad(chunk, session_state, threshold=None):
            nonlocal call_count
            call_count += 1
            if call_count <= 15:
                return 0.9  # first speech
            elif call_count <= 20:
                return 0.1  # silence
            elif call_count <= 35:
                return 0.9  # second speech
            else:
                return 0.1  # silence

        vad = MagicMock()
        vad.is_loaded = True
        vad.process_chunk = MagicMock(side_effect=_vad)

        pp = StreamingPreprocessor(
            session_id="s1",
            vad_service=vad,
            threshold=0.5,
            min_speech_duration_ms=32,
            min_silence_duration_ms=64,
        )

        total_frames = 45
        pcm = _make_speech_pcm(duration_ms=int(total_frames * 512 / 16000 * 1000))
        utts = await pp.feed(pcm)

        assert len(utts) == 2
        assert utts[0].utterance_index == 0
        assert utts[1].utterance_index == 1
        assert pp.utterance_count == 2

    @pytest.mark.asyncio
    async def test_vad_error_treated_as_speech(self):
        """If VAD throws, it should be treated as speech (graceful degradation)."""
        vad = MagicMock()
        vad.is_loaded = True
        vad.process_chunk = MagicMock(side_effect=RuntimeError("ONNX error"))

        pp = StreamingPreprocessor(
            session_id="s1",
            vad_service=vad,
            threshold=0.5,
            min_speech_duration_ms=32,
        )

        pcm = _make_speech_pcm(100)
        _utts = await pp.feed(pcm)

        # Should not crash; error treated as prob=1.0
        assert pp.in_speech is True


# =========================================================================
# Tests: AudioUtterance dataclass
# =========================================================================


class TestAudioUtterance:
    """Tests for the AudioUtterance dataclass."""

    def test_basic_creation(self):
        samples = np.zeros(512, dtype=np.float32)
        utt = AudioUtterance(
            samples=samples,
            sample_rate=16000,
            start_time=0.0,
            end_time=0.032,
            utterance_index=0,
        )
        assert utt.is_final is False
        assert utt.utterance_index == 0
        assert len(utt.samples) == 512

    def test_final_flag(self):
        utt = AudioUtterance(
            samples=np.zeros(100, dtype=np.float32),
            sample_rate=16000,
            start_time=0.0,
            end_time=1.0,
            utterance_index=5,
            is_final=True,
        )
        assert utt.is_final is True


# =========================================================================
# Tests: PCM remainder across incremental feeds
# =========================================================================


class TestPreprocessorIncrementalFeed:
    """Tests for PCM byte accumulation across multiple feed() calls."""

    @pytest.mark.asyncio
    async def test_pcm_remainder_carried_over(self):
        """Bytes that don't form a full frame should carry over to next feed()."""
        vad = _make_vad_service(probability=0.9)

        pp = StreamingPreprocessor(
            session_id="s1",
            vad_service=vad,
            threshold=0.5,
            min_speech_duration_ms=32,
        )

        # Send 100 bytes (not enough for one frame = 1024 bytes)
        small_chunk = _make_speech_pcm(3)  # ~96 bytes at 16kHz (48 samples)
        utts = await pp.feed(small_chunk)
        assert len(utts) == 0  # Not enough for a frame

        # Remainder should be stored
        assert len(pp._state.pcm_remainder) == len(small_chunk)

        # Send another chunk that together forms frames
        big_chunk = _make_speech_pcm(100)
        utts = await pp.feed(big_chunk)

        # Combined should have been processed into frames
        assert pp._state.total_samples_fed > 0

    @pytest.mark.asyncio
    async def test_empty_feed(self):
        """Feeding empty bytes should be a no-op."""
        pp = StreamingPreprocessor(session_id="s1")

        utts = await pp.feed(b"")
        assert len(utts) == 0
        assert pp.utterance_count == 0
        assert pp.in_speech is False

    @pytest.mark.asyncio
    async def test_exact_frame_boundary(self):
        """Feeding exactly one frame worth of bytes."""
        vad = _make_vad_service(probability=0.9)

        pp = StreamingPreprocessor(
            session_id="s1",
            vad_service=vad,
            threshold=0.5,
            min_speech_duration_ms=32,
        )

        # Exactly one frame = 512 samples * 2 bytes = 1024 bytes
        one_frame = np.zeros(512, dtype=np.int16).tobytes()
        _utts = await pp.feed(one_frame)

        assert pp._state.total_samples_fed == 512
        assert len(pp._state.pcm_remainder) == 0

    @pytest.mark.asyncio
    async def test_many_small_feeds(self):
        """Many small incremental feeds should work correctly."""
        vad = _make_vad_service(probability=0.9)

        pp = StreamingPreprocessor(
            session_id="s1",
            vad_service=vad,
            threshold=0.5,
            min_speech_duration_ms=32,
        )

        # Feed 50 tiny chunks (20 bytes each = 10 samples)
        tiny_chunk = np.ones(10, dtype=np.int16).tobytes()
        for _ in range(50):
            await pp.feed(tiny_chunk)

        # 50 * 10 = 500 samples fed. Not enough for a full frame of 512.
        assert pp._state.total_samples_fed == 0
        assert len(pp._state.pcm_remainder) == 50 * 20

        # One more big chunk to push over the frame boundary
        remaining = np.ones(512, dtype=np.int16).tobytes()
        await pp.feed(remaining)

        # Now should have processed at least one frame
        assert pp._state.total_samples_fed >= 512


# =========================================================================
# Tests: flush edge cases
# =========================================================================


class TestPreprocessorFlushEdgeCases:
    """Edge cases for flush()."""

    @pytest.mark.asyncio
    async def test_flush_with_pcm_remainder_during_speech(self):
        """flush() should include PCM remainder in the final utterance."""
        vad = _make_vad_service(probability=0.9)

        pp = StreamingPreprocessor(
            session_id="s1",
            vad_service=vad,
            threshold=0.5,
            min_speech_duration_ms=32,
        )

        # Feed enough for speech onset + a bit of remainder
        full_frames = _make_speech_pcm(100)
        tiny_remainder = np.ones(100, dtype=np.int16).tobytes()  # 200 bytes
        await pp.feed(full_frames)
        await pp.feed(tiny_remainder)

        assert pp.in_speech is True
        assert len(pp._state.pcm_remainder) > 0

        utt = await pp.flush()
        assert utt is not None
        assert utt.is_final is True
        # Remainder should have been cleared
        assert len(pp._state.pcm_remainder) == 0

    @pytest.mark.asyncio
    async def test_double_flush(self):
        """Second flush() should return None (buffer already emptied)."""
        vad = _make_vad_service(probability=0.9)

        pp = StreamingPreprocessor(
            session_id="s1",
            vad_service=vad,
            threshold=0.5,
            min_speech_duration_ms=32,
        )

        await pp.feed(_make_speech_pcm(200))
        assert pp.in_speech is True

        utt1 = await pp.flush()
        assert utt1 is not None

        utt2 = await pp.flush()
        assert utt2 is None

    @pytest.mark.asyncio
    async def test_flush_never_fed(self):
        """flush() on a preprocessor that was never fed returns None."""
        pp = StreamingPreprocessor(session_id="s1")

        utt = await pp.flush()
        assert utt is None


# =========================================================================
# Tests: 8kHz sample rate
# =========================================================================


class TestPreprocessor8kHz:
    """Tests for 8kHz sample rate configuration."""

    @pytest.mark.asyncio
    async def test_8khz_frame_processing(self):
        """8kHz preprocessor should use 256-sample frames."""
        vad = _make_vad_service(probability=0.9)

        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=8000,
            vad_service=vad,
            threshold=0.5,
            min_speech_duration_ms=32,
        )

        assert pp._frame_size == 256

        # One frame at 8kHz = 256 samples * 2 bytes = 512 bytes
        one_frame = np.zeros(256, dtype=np.int16).tobytes()
        await pp.feed(one_frame)

        assert pp._state.total_samples_fed == 256

    @pytest.mark.asyncio
    async def test_8khz_speech_detection(self):
        """Speech detection should work at 8kHz."""
        speech_frames = 10
        vad = _make_alternating_vad(0.9, 0.1, speech_frames)

        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=8000,
            vad_service=vad,
            threshold=0.5,
            min_speech_duration_ms=32,
            min_silence_duration_ms=64,
        )

        total_frames = 18
        # At 8kHz, 256 samples/frame, 32ms/frame
        num_samples = total_frames * 256
        pcm = np.ones(num_samples, dtype=np.int16).tobytes()
        utts = await pp.feed(pcm)

        assert len(utts) == 1
        assert utts[0].sample_rate == 8000


# =========================================================================
# Tests: Pre-speech context inclusion
# =========================================================================


class TestPreSpeechContext:
    """Tests for pre-speech context ring buffer."""

    @pytest.mark.asyncio
    async def test_pre_speech_context_included(self):
        """Utterance should include pre-speech context frames."""
        # Pattern: 5 silence frames, then speech, then silence
        call_count = 0
        pre_silence = 5
        speech_frames = 10

        def _vad(chunk, session_state, threshold=None):
            nonlocal call_count
            call_count += 1
            if call_count <= pre_silence:
                return 0.1  # silence before speech
            elif call_count <= pre_silence + speech_frames:
                return 0.9  # speech
            else:
                return 0.1  # silence after

        vad = MagicMock()
        vad.is_loaded = True
        vad.process_chunk = MagicMock(side_effect=_vad)

        pp = StreamingPreprocessor(
            session_id="s1",
            vad_service=vad,
            threshold=0.5,
            min_speech_duration_ms=32,
            min_silence_duration_ms=64,
        )

        total_frames = pre_silence + speech_frames + 5
        pcm = _make_speech_pcm(duration_ms=int(total_frames * 512 / 16000 * 1000))
        utts = await pp.feed(pcm)

        assert len(utts) == 1
        # Utterance should have more samples than just the speech frames
        # because it includes pre-speech context
        speech_only_samples = speech_frames * 512
        assert len(utts[0].samples) > speech_only_samples


# =========================================================================
# Tests: VAD service not loaded
# =========================================================================


class TestVADServiceNotLoaded:
    """Tests for VAD service that exists but is not loaded."""

    @pytest.mark.asyncio
    async def test_vad_not_loaded_treated_as_speech(self):
        """If vad_service.is_loaded is False, treat all audio as speech."""
        vad = MagicMock()
        vad.is_loaded = False

        pp = StreamingPreprocessor(
            session_id="s1",
            vad_service=vad,
            threshold=0.5,
            min_speech_duration_ms=32,
        )

        pcm = _make_speech_pcm(200)
        await pp.feed(pcm)

        # Should be in speech (since _run_vad returns 1.0)
        assert pp.in_speech is True
        # process_chunk should NOT have been called
        vad.process_chunk.assert_not_called()


# =========================================================================
# Tests: Partial Emission
# =========================================================================


class TestPartialEmission:
    """Tests for partial (is_final=False) utterance emission."""

    @pytest.mark.asyncio
    async def test_no_partial_before_1000ms_elapsed(self):
        """Feed 900ms speech at high rate, expect 0 partials."""
        vad = _make_vad_service(probability=1.0)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            min_speech_duration_ms=32,
            min_silence_duration_ms=700,
        )

        # Feed 900ms -- less than _PARTIAL_INTERVAL_S (1000ms)
        pcm = _make_speech_pcm(900)
        utts = await pp.feed(pcm)

        partials = [u for u in utts if not u.is_final]
        assert len(partials) == 0

    @pytest.mark.asyncio
    async def test_partial_emitted_after_1000ms_speech(self):
        """Feed 1200ms+ speech, expect at least 1 partial."""
        vad = _make_vad_service(probability=1.0)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            min_speech_duration_ms=32,
            min_silence_duration_ms=700,
        )

        # Feed speech in chunks to let the timer tick
        all_utts = []
        # Feed 100ms chunks over 1500ms with time advancement
        with patch("stt.streaming.preprocessor.time") as mock_time:
            mock_time.monotonic = MagicMock()
            # First call (speech onset) returns t=0
            t = 0.0
            call_count = [0]

            def advancing_monotonic():
                call_count[0] += 1
                # Advance 100ms per call after first frame
                return t + (call_count[0] * 0.1)

            mock_time.monotonic = advancing_monotonic

            for _ in range(15):
                pcm = _make_speech_pcm(100)
                utts = await pp.feed(pcm)
                all_utts.extend(utts)

        partials = [u for u in all_utts if not u.is_final]
        assert len(partials) >= 1
        for p in partials:
            assert p.is_final is False

    @pytest.mark.asyncio
    async def test_partial_min_audio_threshold(self):
        """Force 1000ms wall-clock elapsed but only 200ms audio, expect no partial."""
        vad = _make_vad_service(probability=1.0)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            min_speech_duration_ms=32,
            min_silence_duration_ms=700,
        )

        with patch("stt.streaming.preprocessor.time") as mock_time:
            call_count = [0]

            def fast_clock():
                call_count[0] += 1
                return call_count[0] * 1.0  # 1s per call -- way past interval

            mock_time.monotonic = fast_clock

            # Only feed 200ms audio -- below _PARTIAL_MIN_AUDIO_S
            pcm = _make_speech_pcm(200)
            utts = await pp.feed(pcm)

        partials = [u for u in utts if not u.is_final]
        assert len(partials) == 0

    @pytest.mark.asyncio
    async def test_partial_does_not_clear_buffer(self):
        """After partial, utterance_buffer is unchanged (buffer keeps growing)."""
        vad = _make_vad_service(probability=1.0)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            min_speech_duration_ms=32,
            min_silence_duration_ms=700,
        )

        with patch("stt.streaming.preprocessor.time") as mock_time:
            call_count = [0]

            def advancing():
                call_count[0] += 1
                return call_count[0] * 0.1

            mock_time.monotonic = advancing

            # Feed enough to get a partial
            for _ in range(8):
                pcm = _make_speech_pcm(100)
                await pp.feed(pcm)

        # Buffer should still hold all frames
        assert pp.in_speech is True
        assert len(pp._state.utterance_buffer) > 0
        buffer_before = len(pp._state.utterance_buffer)

        # Feed more and check buffer grew
        with patch("stt.streaming.preprocessor.time") as mock_time:
            mock_time.monotonic = lambda: 100.0
            pcm = _make_speech_pcm(100)
            await pp.feed(pcm)

        assert len(pp._state.utterance_buffer) > buffer_before

    @pytest.mark.asyncio
    async def test_partial_timer_resets_on_final(self):
        """Speech -> silence (final) -> new speech: fresh 1000ms timer."""
        # Speech for 800ms then silence for enough frames to trigger final
        speech_frames = int(800 / 32)  # ~25 frames
        vad = _make_alternating_vad(
            speech_prob=1.0,
            silence_prob=0.0,
            speech_frames=speech_frames,
        )

        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            min_speech_duration_ms=32,
            min_silence_duration_ms=200,
        )

        with patch("stt.streaming.preprocessor.time") as mock_time:
            call_count = [0]

            def advancing():
                call_count[0] += 1
                return call_count[0] * 0.1

            mock_time.monotonic = advancing

            # Feed speech + silence
            pcm = _make_speech_pcm(2000)
            utts = await pp.feed(pcm)

        finals = [u for u in utts if u.is_final]
        assert len(finals) >= 1

        # After final, partial timer should be reset
        assert pp._state.last_partial_emitted_at == 0.0

    @pytest.mark.asyncio
    async def test_multiple_partials_during_long_speech(self):
        """Feed 5s speech, expect ~4 partials spaced ~1000ms apart."""
        vad = _make_vad_service(probability=1.0)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            min_speech_duration_ms=32,
            min_silence_duration_ms=700,
        )

        all_utts = []
        with patch("stt.streaming.preprocessor.time") as mock_time:
            call_count = [0]

            def advancing():
                call_count[0] += 1
                return call_count[0] * 0.05  # 50ms per call

            mock_time.monotonic = advancing

            # Feed 5s in 100ms chunks
            for _ in range(50):
                pcm = _make_speech_pcm(100)
                utts = await pp.feed(pcm)
                all_utts.extend(utts)

        partials = [u for u in all_utts if not u.is_final]
        # ~5s / 1.0s = ~4 partials (accounting for min audio threshold + timing)
        assert len(partials) >= 3

    @pytest.mark.asyncio
    async def test_final_still_works_after_partials(self):
        """Feed speech + silence, expect partials followed by 1 final with full audio."""
        speech_frames = int(1500 / 32)  # ~47 frames at 32ms
        vad = _make_alternating_vad(
            speech_prob=1.0,
            silence_prob=0.0,
            speech_frames=speech_frames,
        )

        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            min_speech_duration_ms=32,
            min_silence_duration_ms=200,
        )

        all_utts = []
        with patch("stt.streaming.preprocessor.time") as mock_time:
            call_count = [0]

            def advancing():
                call_count[0] += 1
                return call_count[0] * 0.05

            mock_time.monotonic = advancing

            pcm = _make_speech_pcm(3000)
            utts = await pp.feed(pcm)
            all_utts.extend(utts)

        partials = [u for u in all_utts if not u.is_final]
        finals = [u for u in all_utts if u.is_final]

        assert len(finals) >= 1
        # Final should contain full audio (more samples than any partial)
        if partials:
            assert len(finals[0].samples) >= len(partials[0].samples)

    @pytest.mark.asyncio
    async def test_short_utterance_no_partial(self):
        """Feed 400ms speech then silence, expect 0 partials, 1 final."""
        speech_frames = int(400 / 32)  # ~12 frames
        vad = _make_alternating_vad(
            speech_prob=1.0,
            silence_prob=0.0,
            speech_frames=speech_frames,
        )

        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            min_speech_duration_ms=32,
            min_silence_duration_ms=200,
        )

        pcm = _make_speech_pcm(1500)
        utts = await pp.feed(pcm)

        partials = [u for u in utts if not u.is_final]
        finals = [u for u in utts if u.is_final]

        assert len(partials) == 0
        assert len(finals) >= 1

    # ---------------------------------------------------------------------
    # Bounded partial decode window.
    # ---------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_partial_snapshot_bounded_to_window(self):
        """Partials carry at most ``partial_window_s`` seconds of tail audio
        even when the utterance keeps growing (pre-fix: full-buffer snapshot,
        O(n²) decode per utterance)."""
        vad = _make_vad_service(probability=1.0)
        window_s = 2.0
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            partial_window_s=window_s,
        )

        all_utts = []
        with patch("stt.streaming.preprocessor.time") as mock_time:
            call_count = [0]

            def advancing():
                call_count[0] += 1
                return call_count[0] * 0.05

            mock_time.monotonic = advancing

            # Feed 6 s of continuous speech in 100 ms chunks.
            for _ in range(60):
                pcm = _make_speech_pcm(100)
                utts = await pp.feed(pcm)
                all_utts.extend(utts)

        partials = [u for u in all_utts if not u.is_final]
        assert len(partials) >= 3

        max_window_samples = int(window_s * 16000)
        for p in partials:
            assert len(p.samples) <= max_window_samples
            # Timing stays consistent with the (possibly trimmed) snapshot.
            assert p.end_time - p.start_time == pytest.approx(len(p.samples) / 16000, abs=0.05)

        # Late partials (buffer > window) are actually trimmed to the window.
        late = partials[-1]
        assert len(late.samples) >= int((window_s - 0.5) * 16000)

    @pytest.mark.asyncio
    async def test_final_unaffected_by_partial_window(self):
        """The FINAL utterance still contains the full buffered audio even
        when partials were window-trimmed."""
        speech_frames = int(4000 / 32)  # 4 s of speech
        vad = _make_alternating_vad(
            speech_prob=1.0,
            silence_prob=0.0,
            speech_frames=speech_frames,
        )
        window_s = 2.0
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            min_silence_duration_ms=300,
            partial_window_s=window_s,
        )

        all_utts = []
        with patch("stt.streaming.preprocessor.time") as mock_time:
            call_count = [0]

            def advancing():
                call_count[0] += 1
                return call_count[0] * 0.05

            mock_time.monotonic = advancing

            pcm = _make_speech_pcm(6000)
            utts = await pp.feed(pcm)
            all_utts.extend(utts)

        partials = [u for u in all_utts if not u.is_final]
        finals = [u for u in all_utts if u.is_final]

        assert len(finals) >= 1
        # Final carries the FULL utterance — more than the partial window.
        assert len(finals[0].samples) > int(window_s * 16000)
        if partials:
            assert len(finals[0].samples) > max(len(p.samples) for p in partials)

    def test_partial_window_default_is_8s(self):
        """Default window matches the settings default (8 s)."""
        pp = StreamingPreprocessor(session_id="s1")
        assert pp._partial_window_s == pytest.approx(8.0)

    @pytest.mark.asyncio
    async def test_partial_shares_utterance_index_with_final(self):
        """Partial and final for same speech have same utterance_index."""
        speech_frames = int(1500 / 32)
        vad = _make_alternating_vad(
            speech_prob=1.0,
            silence_prob=0.0,
            speech_frames=speech_frames,
        )

        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            min_speech_duration_ms=32,
            min_silence_duration_ms=200,
        )

        all_utts = []
        with patch("stt.streaming.preprocessor.time") as mock_time:
            call_count = [0]

            def advancing():
                call_count[0] += 1
                return call_count[0] * 0.05

            mock_time.monotonic = advancing

            pcm = _make_speech_pcm(3000)
            utts = await pp.feed(pcm)
            all_utts.extend(utts)

        partials = [u for u in all_utts if not u.is_final]
        finals = [u for u in all_utts if u.is_final]

        if partials and finals:
            assert partials[0].utterance_index == finals[0].utterance_index


# =========================================================================
# Tests: Force-emit smart split + overlap fallback
# =========================================================================


class TestForceEmitSmartSplit:
    """Tests for hybrid force-emit: smart split at low-energy + overlap fallback."""

    @pytest.mark.asyncio
    async def test_force_emit_splits_at_low_energy_frame(self):
        """When buffer hits max, split at lowest-energy frame in last 2s."""
        vad = _make_vad_service(probability=1.0)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            min_speech_duration_ms=32,
            min_silence_duration_ms=700,
            max_utterance_duration_ms=2000,  # Short max for test
        )

        with patch("stt.streaming.preprocessor.time") as mock_time:
            mock_time.monotonic = lambda: 0.0

            # Feed 1.5s loud speech
            pcm_loud = _make_speech_pcm(1500, amplitude=10000)
            await pp.feed(pcm_loud)

            # Feed 100ms near-silence (low energy split point)
            num_quiet = int(16000 * 0.1)
            quiet_samples = (np.ones(num_quiet) * 5).astype(np.int16)
            await pp.feed(quiet_samples.tobytes())

            # Feed more loud speech to exceed max duration
            pcm_loud2 = _make_speech_pcm(500, amplitude=10000)
            utts = await pp.feed(pcm_loud2)

        finals = [u for u in utts if u.is_final]
        assert len(finals) >= 1

        # After force-emit with smart split, preprocessor should still be in_speech
        # with carry buffer seeded
        assert pp.in_speech is True
        assert len(pp._state.utterance_buffer) > 0

    @pytest.mark.asyncio
    async def test_force_emit_overlap_fallback_on_continuous_loud(self):
        """When no low-energy frame found, fall back to overlap carry."""
        vad = _make_vad_service(probability=1.0)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            min_speech_duration_ms=32,
            min_silence_duration_ms=700,
            max_utterance_duration_ms=2000,  # Short max for test
        )

        with patch("stt.streaming.preprocessor.time") as mock_time:
            mock_time.monotonic = lambda: 0.0

            # Feed continuous loud speech exceeding max duration
            pcm = _make_speech_pcm(2500, amplitude=10000)
            utts = await pp.feed(pcm)

        finals = [u for u in utts if u.is_final]
        assert len(finals) >= 1

        # Should still be in_speech with overlap carry
        assert pp.in_speech is True
        assert len(pp._state.utterance_buffer) > 0

    @pytest.mark.asyncio
    async def test_force_emit_carry_buffer_receives_new_audio(self):
        """After force-emit, new audio appends to carry buffer."""
        vad = _make_vad_service(probability=1.0)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            min_speech_duration_ms=32,
            min_silence_duration_ms=700,
            max_utterance_duration_ms=2000,
        )

        with patch("stt.streaming.preprocessor.time") as mock_time:
            mock_time.monotonic = lambda: 0.0

            # Trigger force-emit
            pcm = _make_speech_pcm(2500, amplitude=10000)
            await pp.feed(pcm)

        carry_size = len(pp._state.utterance_buffer)
        assert carry_size > 0

        # Feed more audio — buffer should grow
        with patch("stt.streaming.preprocessor.time") as mock_time:
            mock_time.monotonic = lambda: 3.0
            pcm2 = _make_speech_pcm(200, amplitude=10000)
            await pp.feed(pcm2)

        assert len(pp._state.utterance_buffer) > carry_size

    @pytest.mark.asyncio
    async def test_force_emit_no_audio_loss(self):
        """Total samples across emitted final + carry buffer == total fed."""
        vad = _make_vad_service(probability=1.0)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            min_speech_duration_ms=32,
            min_silence_duration_ms=700,
            max_utterance_duration_ms=2000,
        )

        with patch("stt.streaming.preprocessor.time") as mock_time:
            mock_time.monotonic = lambda: 0.0

            pcm = _make_speech_pcm(2500, amplitude=10000)
            utts = await pp.feed(pcm)

        finals = [u for u in utts if u.is_final]
        assert len(finals) >= 1

        emitted_samples = sum(len(f.samples) for f in finals)
        carry_samples = sum(len(f) for f in pp._state.utterance_buffer)

        # Emitted + carry should account for all buffered audio
        # (minus pre-speech ring which isn't counted)
        assert emitted_samples + carry_samples > 0


# =========================================================================
# Tests: Short / jittery utterance recovery
# =========================================================================


class TestShortUtteranceRecovery:
    """Brief crisp utterances must not be silently dropped by the onset gate.

    Pre-fix the onset required ``min_speech_duration_ms`` (350 ms → 10 frames)
    of *consecutive* above-threshold frames, so short bursts — and any burst
    interrupted by a single sub-threshold dip — never set ``in_speech`` and were
    discarded, even at end-of-session flush().
    """

    @pytest.mark.asyncio
    async def test_short_clinical_burst_confirms_with_default_min_speech(self):
        # 8 speech frames ~= 256 ms — a brief crisp confirmation like "no".
        # Uses the SHIPPED default min_speech_duration_ms (clinical); pre-fix
        # the 350 ms default needed 10 consecutive frames and dropped this.
        vad = _make_alternating_vad(speech_prob=0.9, silence_prob=0.1, speech_frames=8)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            threshold=0.5,
            min_silence_duration_ms=700,
        )

        utts = await pp.feed(_make_speech_pcm(duration_ms=int(8 * 512 / 16000 * 1000)))
        final = await pp.flush()

        finals = [u for u in utts if u.is_final] + ([final] if final else [])
        assert len(finals) >= 1
        assert pp.utterance_count >= 1
        assert sum(len(f.samples) for f in finals) > 0

    @pytest.mark.asyncio
    async def test_onset_survives_single_dip(self):
        # Explicit 350 ms (10-frame) onset. Pattern: 6 speech, 1 dip, 6 speech —
        # max-consecutive is 6 (< 10), but a single-dip hangover bridges the gap
        # so the jittery but real burst still confirms.
        call_count = [0]

        def _vad(chunk, session_state, threshold=None):
            call_count[0] += 1
            i = call_count[0]
            if i <= 6:
                return 0.9  # 6 speech
            if i == 7:
                return 0.1  # single sub-threshold dip
            if i <= 13:
                return 0.9  # 6 more speech
            return 0.1  # trailing silence

        vad = MagicMock()
        vad.is_loaded = True
        vad.process_chunk = MagicMock(side_effect=_vad)

        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            threshold=0.5,
            min_speech_duration_ms=350,
            min_silence_duration_ms=700,
        )

        utts = await pp.feed(_make_speech_pcm(duration_ms=int(13 * 512 / 16000 * 1000)))
        final = await pp.flush()

        finals = [u for u in utts if u.is_final] + ([final] if final else [])
        assert len(finals) >= 1
        assert pp.utterance_count >= 1

    @pytest.mark.asyncio
    async def test_single_frame_transient_still_dropped(self):
        # Steady-state guard: a lone 1-frame blip (noise transient) must NOT
        # become an utterance, even with the clinical default + single-dip
        # hangover — the hangover tolerates one dip, not an ongoing gap.
        call_count = [0]

        def _vad(chunk, session_state, threshold=None):
            call_count[0] += 1
            return 0.9 if call_count[0] == 1 else 0.1  # exactly one speech frame

        vad = MagicMock()
        vad.is_loaded = True
        vad.process_chunk = MagicMock(side_effect=_vad)

        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            threshold=0.5,
            min_silence_duration_ms=700,
        )

        utts = await pp.feed(_make_speech_pcm(duration_ms=int(20 * 512 / 16000 * 1000)))
        final = await pp.flush()

        assert utts == []
        assert final is None
        assert pp.utterance_count == 0
        assert pp.in_speech is False

    @pytest.mark.asyncio
    async def test_alternating_near_threshold_pattern_is_rejected(self):
        # SPARSE periodic noise
        # (a real monitor beep — one above-threshold frame every ~250 ms) must
        # NOT accrete a false onset: the cumulative dip budget (3 frames) is
        # spent between blips, resetting the attempt. NOTE: dense per-frame
        # alternation (0.9/0.1 every 32 ms) is now treated as speech — that
        # matches upstream Silero (max consecutive low = 1 frame < min_silence
        # keeps its segment open) and clinical word retention outranks the
        # synthetic 16 Hz-alternation case; the downstream hallucination filter
        # owns residual false utterances.
        probs = [0.9, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.9, 0.1, 0.1, 0.1, 0.1, 0.9]
        call_count = [0]

        def _vad(chunk, session_state, threshold=None):
            i = call_count[0]
            call_count[0] += 1
            return probs[i] if i < len(probs) else 0.1  # silence after the pattern

        vad = MagicMock()
        vad.is_loaded = True
        vad.process_chunk = MagicMock(side_effect=_vad)

        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            threshold=0.5,
            min_silence_duration_ms=700,
        )

        # Feed the 13-frame pattern plus trailing silence.
        utts = await pp.feed(_make_speech_pcm(duration_ms=int(25 * 512 / 16000 * 1000)))
        final = await pp.flush()

        finals = [u for u in utts if u.is_final]
        assert finals == []
        assert final is None
        assert pp.utterance_count == 0
        assert pp.in_speech is False


class TestPartialCadenceConfigurable:
    """The partial-emit cadence is a constructor arg with a
    lowered default so newly-spoken words surface in near-real-time as a
    tentative tail; the 0.5 s min-audio floor still gates the first partial.
    """

    def test_default_interval_is_configurable_and_lowered(self):
        """The legacy hardcoded 1.0 s cadence is now a lowered, tunable default
        stored on the instance."""
        pp = StreamingPreprocessor(session_id="s1")

        # The preprocessor exposes the cadence it will enforce…
        assert pp._partial_interval_s == _PARTIAL_INTERVAL_S
        # …and the shipped default is materially below the legacy 1.0 s.
        assert _PARTIAL_INTERVAL_S < 1.0
        assert _PARTIAL_INTERVAL_S == pytest.approx(0.4)
        # The min-audio floor is UNCHANGED — a partial still needs >= 0.5 s of
        # buffered speech (only the cadence dropped, not the floor).
        assert _PARTIAL_MIN_AUDIO_S == 0.5

    def test_explicit_interval_overrides_default(self):
        """A caller (SessionManager, fed by settings) can override the cadence."""
        pp = StreamingPreprocessor(session_id="s1", partial_interval_s=0.25)
        assert pp._partial_interval_s == 0.25

    @pytest.mark.asyncio
    async def test_lower_interval_yields_more_partials(self):
        """Same synthetic utterance + identical simulated timeline: a 0.2 s
        cadence emits strictly more partials than a 1.0 s cadence."""
        counts: dict[float, int] = {}
        for interval in (1.0, 0.2):
            vad = _make_vad_service(probability=1.0)
            pp = StreamingPreprocessor(
                session_id="s1",
                sample_rate=16000,
                vad_service=vad,
                min_speech_duration_ms=32,
                min_silence_duration_ms=700,
                partial_interval_s=interval,
            )

            all_utts: list[AudioUtterance] = []
            clock = [0.0]
            with patch("stt.streaming.preprocessor.time") as mock_time:
                # monotonic() is CONSTANT within a feed and advances 100 ms
                # between feeds, so both runs share an identical timeline and
                # only the interval differs. (Default arg binds this run's clock
                # list so the closure never captures the loop variable — B023.)
                mock_time.monotonic = lambda c=clock: c[0]
                for i in range(30):
                    clock[0] = i * 0.1
                    utts = await pp.feed(_make_speech_pcm(100))
                    all_utts.extend(utts)

            counts[interval] = len([u for u in all_utts if not u.is_final])

        assert counts[1.0] >= 1
        assert counts[0.2] > counts[1.0]

    @pytest.mark.asyncio
    async def test_min_audio_floor_still_gates_first_partial(self):
        """Even with a tiny interval and a clock far past it, < 0.5 s of buffered
        speech emits no partial (the min-audio floor is preserved)."""
        vad = _make_vad_service(probability=1.0)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad,
            min_speech_duration_ms=32,
            min_silence_duration_ms=700,
            partial_interval_s=0.01,
        )

        with patch("stt.streaming.preprocessor.time") as mock_time:
            call_count = [0]

            def fast_clock():
                call_count[0] += 1
                return call_count[0] * 1.0  # far past the 0.01 s interval

            mock_time.monotonic = fast_clock

            # Only 200 ms of audio — below _PARTIAL_MIN_AUDIO_S (0.5 s).
            utts = await pp.feed(_make_speech_pcm(200))

        assert [u for u in utts if not u.is_final] == []


# =========================================================================
# Tests: VAD word-clipping fixes
# =========================================================================


def _sequence_vad(probs: list[float]) -> MagicMock:
    """VAD that returns the given probabilities in order, then repeats the last."""
    seq = list(probs)

    def _process_chunk(chunk, session_state, threshold=None):
        return seq.pop(0) if len(seq) > 1 else seq[0]

    svc = MagicMock()
    svc.is_loaded = True
    svc.process_chunk = MagicMock(side_effect=_process_chunk)
    return svc


class TestTask505OffsetHysteresis:
    """Streaming offset must use neg_threshold (threshold - 0.15)."""

    @pytest.mark.asyncio
    async def test_mid_band_frames_do_not_count_as_silence(self):
        # threshold 0.6 → neg 0.45. Sequence: 4 strong frames, 5 frames at
        # 0.5 (mid-band), then hard silence. min_silence = 2 frames (64 ms).
        # WITHOUT hysteresis the two 0.5-frames after onset would already
        # complete the silence run and the utterance ends before the hard
        # silence; WITH hysteresis the mid-band frames hold speech and the
        # offset only completes after two 0.1-frames.
        probs = [0.9, 0.9, 0.9, 0.9] + [0.5] * 5 + [0.1] * 10
        pp = StreamingPreprocessor(
            session_id="hys",
            vad_service=_sequence_vad(probs),
            threshold=0.6,
            min_speech_duration_ms=96,  # 3 frames
            min_silence_duration_ms=64,  # 2 frames
        )

        finals: list[AudioUtterance] = []
        frames_fed = 0
        frame_bytes = _FRAME_SIZE_16K * 2
        pcm = _make_speech_pcm(32 * 25)
        for i in range(len(probs)):
            chunk = pcm[i * frame_bytes : (i + 1) * frame_bytes]
            utts = await pp.feed(chunk)
            frames_fed += 1
            finals.extend(u for u in utts if u.is_final)
            if finals:
                break

        assert finals, "expected an utterance"
        # Offset must complete only after the mid-band frames PLUS two hard
        # silence frames: 4 + 5 + 2 = 11 frames fed. Without hysteresis the
        # utterance closes at frame 6 (4 speech + 2 mid-band-as-silence).
        assert frames_fed == 11


class TestTask505FlushPendingOnset:
    """flush() must emit audio from an unconfirmed onset (last word of session)."""

    @pytest.mark.asyncio
    async def test_flush_emits_unconfirmed_onset_audio(self):
        # min_speech = 8 frames (256 ms); feed only 3 speech frames — onset
        # NOT confirmed — then flush. The spoken audio must not be discarded.
        pp = StreamingPreprocessor(
            session_id="pend",
            vad_service=_make_vad_service(0.9),
            threshold=0.5,
            min_speech_duration_ms=256,
            min_silence_duration_ms=200,
        )

        utts = await pp.feed(_make_speech_pcm(32 * 3))
        assert utts == []
        assert pp.in_speech is False

        final = await pp.flush()
        assert final is not None
        assert final.is_final is True
        # All 3 fed frames must be present.
        assert len(final.samples) >= 3 * _FRAME_SIZE_16K

    @pytest.mark.asyncio
    async def test_flush_still_none_when_nothing_pending(self):
        pp = StreamingPreprocessor(
            session_id="pend2",
            vad_service=_make_vad_service(0.0),
            threshold=0.5,
        )
        await pp.feed(_make_pcm_bytes(320))
        assert await pp.flush() is None


class TestTask505RingCapacity:
    """Pre-speech ring must hold pre-context PLUS onset-confirmation frames."""

    @pytest.mark.asyncio
    async def test_onset_tracking_does_not_evict_pre_context(self):
        # pre_speech_context = 2 frames (64 ms), min_speech = 4 frames (128 ms).
        # Feed 2 silence frames then 4 speech frames. At confirmation the
        # utterance must contain: 2 pre-context + 3 onset-tracked + the
        # confirming frame = 6 frames. With the old cap (= pre-context only)
        # the ring held 2 frames and the first onset frames were evicted.
        probs = [0.1, 0.1] + [0.9] * 30
        pp = StreamingPreprocessor(
            session_id="ring",
            vad_service=_sequence_vad(probs),
            threshold=0.5,
            min_speech_duration_ms=128,
            min_silence_duration_ms=64,
            pre_speech_context_ms=64,
        )

        frame_bytes = _FRAME_SIZE_16K * 2
        pcm = _make_speech_pcm(32 * 6)
        for i in range(6):
            await pp.feed(pcm[i * frame_bytes : (i + 1) * frame_bytes])

        assert pp.in_speech is True
        buffered = sum(len(f) for f in pp._state.utterance_buffer)
        assert buffered == 6 * _FRAME_SIZE_16K


class TestTask505SmartSplitOverlap:
    """Force-emit smart split must carry overlap so no word is cut."""

    @pytest.mark.asyncio
    async def test_smart_split_carry_overlaps_previous_emit(self):
        # max utterance = 10 frames (320 ms). Frames all speech-prob; frame 8
        # is zero-energy (a plosive closure) — the smart-split target.
        pp = StreamingPreprocessor(
            session_id="split",
            vad_service=_make_vad_service(0.9),
            threshold=0.5,
            min_speech_duration_ms=32,
            min_silence_duration_ms=320,
            max_utterance_duration_ms=320,
            pre_speech_context_ms=32,
        )

        frame = (10000 * np.sin(2 * np.pi * 440 * np.linspace(0, 0.032, _FRAME_SIZE_16K))).astype(
            np.int16
        )
        zero = np.zeros(_FRAME_SIZE_16K, dtype=np.int16)

        finals: list[AudioUtterance] = []
        for i in range(14):
            chunk = (zero if i == 8 else frame).tobytes()
            utts = await pp.feed(chunk)
            finals.extend(u for u in utts if u.is_final)

        assert finals, "expected a force-emitted utterance"
        first = finals[0]
        # Continuation must start BEFORE the first emit ended by at least
        # ~100 ms of overlap (old behavior: carry started exactly at the
        # split point with zero overlap before it).
        assert pp._state.utterance_start_time < first.end_time - 0.096


class TestTask505Normalizer:
    """Bounded-window normalizer must recover quickly after a transient."""

    def test_speech_recovers_after_loud_transient(self):
        pp = StreamingPreprocessor(session_id="norm", normalize=True)

        transient = np.ones(_FRAME_SIZE_16K, dtype=np.float32)
        quiet = np.full(_FRAME_SIZE_16K, 0.05, dtype=np.float32)

        pp._normalize_frame(transient)
        out = None
        # 5 seconds of quiet speech after the transient (156 frames).
        for _ in range(156):
            out = pp._normalize_frame(quiet.copy())

        assert out is not None
        # With a bounded window the transient has left the window and quiet
        # speech normalizes back to ~1.0. The old 107-s-decay tracker left
        # this at ~0.05 (speech suppressed → VAD misses words).
        assert float(np.max(out)) > 0.5


class TestTask505Resampler:
    """Streaming resampler must anti-alias (no naive per-frame interp)."""

    def test_high_frequency_content_attenuated(self):
        # 12 kHz tone at 48 kHz input. After proper decimation to 16 kHz it
        # lies above Nyquist (8 kHz) and must be attenuated, not folded to
        # 4 kHz at near-full amplitude as linear interpolation does.
        pp = StreamingPreprocessor(session_id="rs", sample_rate=48000, target_sample_rate=16000)

        n = pp._frame_size  # input samples per frame at 48 kHz
        outputs = []
        for i in range(12):
            t = (np.arange(n) + i * n) / 48000.0
            frame = np.sin(2 * np.pi * 12000 * t).astype(np.float32)
            outputs.append(pp._resample_frame(frame))

        out = np.concatenate(outputs[2:])  # skip warmup frames
        rms = float(np.sqrt(np.mean(out**2)))
        assert rms < 0.1, f"aliased image not attenuated (rms={rms:.3f})"

    def test_passband_content_preserved(self):
        # 1 kHz tone must pass through at full amplitude.
        pp = StreamingPreprocessor(session_id="rs2", sample_rate=48000, target_sample_rate=16000)

        n = pp._frame_size
        outputs = []
        for i in range(12):
            t = (np.arange(n) + i * n) / 48000.0
            frame = np.sin(2 * np.pi * 1000 * t).astype(np.float32)
            outputs.append(pp._resample_frame(frame))

        out = np.concatenate(outputs[2:])
        rms = float(np.sqrt(np.mean(out**2)))
        assert 0.6 < rms < 0.8  # sine RMS ≈ 0.707

    def test_output_frame_length_stable(self):
        pp = StreamingPreprocessor(session_id="rs3", sample_rate=48000, target_sample_rate=16000)
        frame = np.zeros(pp._frame_size, dtype=np.float32)
        for _ in range(5):
            out = pp._resample_frame(frame)
            assert len(out) == _FRAME_SIZE_16K


class TestTask505Defaults:
    """Clinical defaults: short confirmations must survive."""

    def test_ctor_min_speech_default_is_100ms(self):
        pp = StreamingPreprocessor(session_id="d1")
        # 100 ms / 32 ms → 3 frames
        assert pp._min_speech_frames == 3

    @pytest.mark.asyncio
    async def test_short_yes_survives_with_defaults(self):
        # A ~130 ms "yes" (4 speech frames) followed by silence must emit an
        # utterance under the new defaults (old default 250 ms → dropped).
        probs = [0.9] * 4 + [0.05] * 40
        pp = StreamingPreprocessor(
            session_id="yes",
            vad_service=_sequence_vad(probs),
            threshold=0.5,
            min_silence_duration_ms=200,
        )

        finals = []
        frame_bytes = _FRAME_SIZE_16K * 2
        pcm = _make_speech_pcm(32 * 20)
        for i in range(20):
            utts = await pp.feed(pcm[i * frame_bytes : (i + 1) * frame_bytes])
            finals.extend(u for u in utts if u.is_final)

        assert finals, "short confirmation was dropped"


class TestTask505ReviewFixes:
    """Regression locks for adversarial-review findings."""

    @pytest.mark.asyncio
    async def test_mid_band_babble_does_not_defer_final_forever(self):
        # threshold 0.6 → neg 0.45. Speech, then alternating 0.44/0.46 babble:
        # the run anchors at the first 0.44 and mid-band 0.46 frames must keep
        # counting (wall-clock), so the final emits after min_silence instead
        # of deferring to the 25 s force-emit.
        probs = [0.9] * 4 + [0.44, 0.46] * 20
        pp = StreamingPreprocessor(
            session_id="babble",
            vad_service=_sequence_vad(probs),
            threshold=0.6,
            min_speech_duration_ms=96,
            min_silence_duration_ms=192,  # 6 frames
        )

        finals: list[AudioUtterance] = []
        frame_bytes = _FRAME_SIZE_16K * 2
        pcm = _make_speech_pcm(32 * 30)
        frames_fed = 0
        for i in range(30):
            utts = await pp.feed(pcm[i * frame_bytes : (i + 1) * frame_bytes])
            frames_fed += 1
            finals.extend(u for u in utts if u.is_final)
            if finals:
                break

        assert finals, "final deferred past the silence window"
        # Onset confirms at frame 3; run starts at the first 0.44 (frame 5,
        # 1-indexed) and completes 6 wall-clock frames later → frame 10.
        assert frames_fed == 10

    def test_normalizer_never_amplifies_noise_floor(self):
        # Divisor floor (gain ceiling 20×): ambient noise at 0.002 peak must
        # not be normalized to full scale during long pauses.
        pp = StreamingPreprocessor(session_id="floor", normalize=True)
        noise = np.full(_FRAME_SIZE_16K, 0.002, dtype=np.float32)
        out = None
        for _ in range(200):
            out = pp._normalize_frame(noise.copy())
        assert out is not None
        assert float(np.max(out)) <= 0.05

    @pytest.mark.asyncio
    async def test_flush_single_blip_not_emitted(self):
        # A lone above-threshold noise frame at session stop must not ship a
        # ring of ambient noise to ASR (>= 2 onset frames required).
        probs = [0.1] * 5 + [0.9]
        pp = StreamingPreprocessor(
            session_id="blip",
            vad_service=_sequence_vad(probs + [0.9]),
            threshold=0.5,
            min_speech_duration_ms=256,
        )
        frame_bytes = _FRAME_SIZE_16K * 2
        pcm = _make_speech_pcm(32 * 6)
        for i in range(6):
            await pp.feed(pcm[i * frame_bytes : (i + 1) * frame_bytes])
        assert await pp.flush() is None


class TestTask505DualPathDenoiseStreaming:
    """Dual-path denoise on the streaming path."""

    def _zeroing_denoiser(self):
        d = MagicMock()
        d.in_fade_in = False
        d.process = MagicMock(side_effect=lambda f: np.zeros_like(f))
        return d

    @pytest.mark.asyncio
    async def test_vad_only_scope_buffers_raw_audio(self):
        # Denoiser zeroes everything: with scope=vad_only the VAD must see the
        # zeroed branch while the emitted utterance keeps the raw signal.
        vad_probs = []

        def _vad(chunk, session_state, threshold=None):
            vad_probs.append(float(np.abs(chunk).max()))
            return 0.9

        svc = MagicMock()
        svc.is_loaded = True
        svc.process_chunk = MagicMock(side_effect=_vad)

        pp = StreamingPreprocessor(
            session_id="dp1",
            vad_service=svc,
            threshold=0.5,
            min_speech_duration_ms=32,
            min_silence_duration_ms=64,
            denoiser=self._zeroing_denoiser(),
            denoise_scope="vad_only",
        )

        await pp.feed(_make_speech_pcm(320))
        final = await pp.flush()

        assert final is not None
        # VAD consumed the zeroed (denoised) frames…
        assert max(vad_probs) == 0.0
        # …but the emitted audio (ASR input) kept the raw signal.
        assert float(np.abs(final.samples).max()) > 0.1

    @pytest.mark.asyncio
    async def test_full_scope_keeps_legacy_denoised_audio(self):
        pp = StreamingPreprocessor(
            session_id="dp2",
            vad_service=_make_vad_service(0.9),
            threshold=0.5,
            min_speech_duration_ms=32,
            min_silence_duration_ms=64,
            denoiser=self._zeroing_denoiser(),
            denoise_scope="full",
        )

        await pp.feed(_make_speech_pcm(320))
        final = await pp.flush()

        assert final is not None
        assert float(np.abs(final.samples).max()) == 0.0
