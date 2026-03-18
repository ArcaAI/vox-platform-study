"""Unit tests for StreamingPreprocessor."""

from __future__ import annotations

from unittest.mock import MagicMock

import numpy as np
import pytest

from stt_v2.streaming.preprocessor import (
    AudioUtterance,
    StreamingPreprocessor,
    _FRAME_SIZE_16K,
    _PRE_SPEECH_CONTEXT_MS,
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
        vad = _make_alternating_vad(
            speech_prob=0.9, silence_prob=0.1, speech_frames=speech_frames
        )

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
        pcm = _make_speech_pcm(
            duration_ms=int(total_frames * 512 / 16000 * 1000)
        )

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
        pcm = _make_speech_pcm(
            duration_ms=int(total_frames * 512 / 16000 * 1000)
        )
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
        pcm = _make_speech_pcm(
            duration_ms=int(total_frames * 512 / 16000 * 1000)
        )
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
        utts = await pp.feed(pcm)

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
        utts = await pp.feed(one_frame)

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
        pcm = _make_speech_pcm(
            duration_ms=int(total_frames * 512 / 16000 * 1000)
        )
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
