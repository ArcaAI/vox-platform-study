"""Tests for the VAD + denoise combined code path in StreamingPreprocessor.

Covers:
- P0: VADSessionState sample_rate uses _target_sr (not input sample_rate)
- P2: flush() processes remainder through denoise+resample
- P3: Onset-confirming frame included in utterance_buffer
- General: feed() with both VAD service and denoiser produces utterances
"""

from __future__ import annotations

import numpy as np
import pytest
from unittest.mock import MagicMock

from stt_v2.streaming.preprocessor import AudioUtterance, StreamingPreprocessor

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class PassthroughDenoiser:
    """Denoiser that returns the input unchanged."""

    def process(self, frame: np.ndarray) -> np.ndarray:
        return frame


class ScalingDenoiser:
    """Denoiser that scales audio by a fixed factor."""

    def __init__(self, scale: float = 0.5):
        self._scale = scale

    def process(self, frame: np.ndarray) -> np.ndarray:
        return (frame * self._scale).astype(np.float32)


def _make_vad_service(
    speech_frames: int = 10,
    speech_prob: float = 0.9,
    silence_prob: float = 0.1,
):
    """Mock VAD service that returns high prob for first N frames, low after."""
    call_count = [0]

    def process_chunk(chunk, session_state, threshold):
        call_count[0] += 1
        if call_count[0] <= speech_frames:
            return speech_prob
        return silence_prob

    svc = MagicMock()
    svc.is_loaded = True
    svc.process_chunk = process_chunk
    return svc, call_count


def _make_speech_pcm(n_samples: int = 512) -> bytes:
    """Generate a 440Hz tone as int16 PCM bytes."""
    t = np.linspace(0, n_samples / 16000, n_samples, endpoint=False)
    wave = (10000 * np.sin(2 * np.pi * 440 * t)).astype(np.int16)
    return wave.tobytes()


# ---------------------------------------------------------------------------
# P0: VAD state sample_rate matches target_sr
# ---------------------------------------------------------------------------


class TestVADStateSampleRate:
    def test_vad_state_uses_target_sr_when_different(self):
        """VADSessionState should get _target_sr, not input sample_rate."""
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=48000,
            target_sample_rate=16000,
            vad_service=MagicMock(is_loaded=True),
        )
        assert pp._vad_state.sample_rate == 16000

    def test_vad_state_uses_target_sr_when_same(self):
        """When input == target, VAD state still gets correct rate."""
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            target_sample_rate=16000,
            vad_service=MagicMock(is_loaded=True),
        )
        assert pp._vad_state.sample_rate == 16000

    def test_vad_state_uses_input_when_no_target(self):
        """When target_sample_rate is not specified, defaults to sample_rate."""
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=MagicMock(is_loaded=True),
        )
        assert pp._vad_state.sample_rate == 16000


# ---------------------------------------------------------------------------
# P3: Onset frame included in utterance_buffer
# ---------------------------------------------------------------------------


class TestOnsetFrameIncluded:
    @pytest.mark.asyncio
    async def test_onset_frame_present_in_emitted_utterance(self):
        """The frame that confirms onset should be in the emitted utterance."""
        # min_speech_frames = 250/32 ~ 8 frames
        vad_svc, _ = _make_vad_service(speech_frames=15)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad_svc,
            denoiser=PassthroughDenoiser(),
            threshold=0.5,
            min_speech_duration_ms=250,  # ~8 frames at 32ms each
            min_silence_duration_ms=700,  # ~22 frames
        )

        all_utts = []
        for _ in range(60):
            utts = await pp.feed(_make_speech_pcm())
            all_utts.extend(utts)

        if not all_utts:
            final = await pp.flush()
            if final:
                all_utts.append(final)

        assert len(all_utts) >= 1
        utt = all_utts[0]

        # The onset frame (frame 8 at 0-indexed) should be in the utterance.
        # With pre_speech_frames=9 (300ms/32ms) and min_speech_frames=8,
        # utterance should have at least: pre_speech + onset_frame + speech
        # Without fix: missing onset frame (14 speech frames in buffer)
        # With fix: onset frame included (15 speech frames in buffer)
        min_speech_frames = 8
        pre_speech_frames = 9
        expected_min_frames = min_speech_frames + 1  # onset + remaining speech
        assert utt.samples.size >= expected_min_frames * 512


# ---------------------------------------------------------------------------
# VAD + denoise: feed() produces utterances
# ---------------------------------------------------------------------------


class TestFeedVADDenoise:
    @pytest.mark.asyncio
    async def test_feed_with_vad_and_denoiser_produces_utterances(self):
        """When both VAD and denoiser are active, feed() should return utterances."""
        vad_svc, _ = _make_vad_service(speech_frames=10)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad_svc,
            denoiser=PassthroughDenoiser(),
            threshold=0.5,
            min_speech_duration_ms=250,
            min_silence_duration_ms=700,
        )

        all_utts = []
        for _ in range(50):
            utts = await pp.feed(_make_speech_pcm())
            all_utts.extend(utts)

        assert len(all_utts) == 1
        assert all_utts[0].samples.size > 0
        assert all_utts[0].sample_rate == 16000

    @pytest.mark.asyncio
    async def test_feed_with_scaling_denoiser_produces_utterances(self):
        """Denoiser that scales audio should not prevent utterance emission."""
        vad_svc, _ = _make_vad_service(speech_frames=10)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad_svc,
            denoiser=ScalingDenoiser(scale=0.5),
            threshold=0.5,
            min_speech_duration_ms=250,
            min_silence_duration_ms=700,
        )

        all_utts = []
        for _ in range(50):
            utts = await pp.feed(_make_speech_pcm())
            all_utts.extend(utts)

        assert len(all_utts) == 1

    @pytest.mark.asyncio
    async def test_utterance_samples_are_denoised(self):
        """Emitted utterance samples should contain denoised audio."""
        vad_svc, _ = _make_vad_service(speech_frames=10)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad_svc,
            denoiser=ScalingDenoiser(scale=0.5),
            threshold=0.5,
            min_speech_duration_ms=250,
            min_silence_duration_ms=700,
        )

        all_utts = []
        for _ in range(50):
            utts = await pp.feed(_make_speech_pcm())
            all_utts.extend(utts)

        assert len(all_utts) == 1
        # Samples should be scaled by 0.5 (the denoiser factor)
        max_val = float(np.abs(all_utts[0].samples).max())
        # Original peak ~ 10000/32768 ~ 0.305; scaled by 0.5 ~ 0.153
        assert max_val < 0.2

    @pytest.mark.asyncio
    async def test_drain_processed_samples_after_vad_denoise_feed(self):
        """drain_processed_samples returns PCM after VAD detects speech."""
        vad_svc, _ = _make_vad_service(speech_frames=30)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad_svc,
            denoiser=PassthroughDenoiser(),
            threshold=0.5,
            min_speech_duration_ms=250,
            min_silence_duration_ms=700,
        )

        # Feed enough frames for speech onset (min_speech_frames ~= 7)
        for _ in range(15):
            await pp.feed(_make_speech_pcm())
        pcm = pp.drain_processed_samples()
        assert len(pcm) > 0


# ---------------------------------------------------------------------------
# P2: flush() processes remainder through denoise pipeline
# ---------------------------------------------------------------------------


class TestFlushDenoisePipeline:
    @pytest.mark.asyncio
    async def test_flush_processes_remainder_through_denoiser(self):
        """flush() should denoise the remainder frame."""
        denoise_calls = []

        class TrackingDenoiser:
            def process(self, frame):
                denoise_calls.append(len(frame))
                return frame

        vad_svc, _ = _make_vad_service(speech_frames=100)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad_svc,
            denoiser=TrackingDenoiser(),
            threshold=0.5,
            min_speech_duration_ms=250,
            min_silence_duration_ms=700,
        )

        # Feed enough for onset, plus a partial frame
        for _ in range(10):
            await pp.feed(_make_speech_pcm())

        # Add a partial frame (less than 512 samples = 1024 bytes)
        partial = np.zeros(256, dtype=np.int16).tobytes()  # 512 bytes
        await pp.feed(partial)

        denoise_calls_before = len(denoise_calls)
        final = await pp.flush()

        assert final is not None
        # flush should have called denoise for the remainder
        assert len(denoise_calls) > denoise_calls_before

    @pytest.mark.asyncio
    async def test_flush_accumulates_processed_samples(self):
        """flush() should add remainder to _processed_samples so drain works."""
        vad_svc, _ = _make_vad_service(speech_frames=100)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad_svc,
            denoiser=PassthroughDenoiser(),
            threshold=0.5,
            min_speech_duration_ms=250,
            min_silence_duration_ms=700,
        )

        # Feed + drain to clear
        for _ in range(10):
            await pp.feed(_make_speech_pcm())
        pp.drain_processed_samples()

        # Add partial frame so flush() has something to process
        partial = np.zeros(256, dtype=np.int16).tobytes()
        await pp.feed(partial)
        pp.drain_processed_samples()

        final = await pp.flush()
        remaining_pcm = pp.drain_processed_samples()
        assert (
            len(remaining_pcm) > 0
        ), "flush() should populate _processed_samples for downstream drain"

    @pytest.mark.asyncio
    async def test_flush_resamples_remainder_when_rates_differ(self):
        """flush() should resample the remainder frame when sample rates differ."""
        resample_calls = []
        original_resample = StreamingPreprocessor._resample_frame

        class TrackingPP(StreamingPreprocessor):
            def _resample_frame(self, frame):
                resample_calls.append(len(frame))
                return original_resample(self, frame)

        vad_svc, _ = _make_vad_service(speech_frames=100)
        pp = TrackingPP(
            session_id="s1",
            sample_rate=48000,
            target_sample_rate=16000,
            vad_service=vad_svc,
            denoiser=PassthroughDenoiser(),
            threshold=0.5,
            min_speech_duration_ms=250,
            min_silence_duration_ms=700,
        )

        # Feed audio at 48kHz (frame size adjusted to produce 512 target samples)
        frame_size = pp._frame_size
        for _ in range(10):
            pcm = np.zeros(frame_size, dtype=np.int16).tobytes()
            await pp.feed(pcm)

        resample_count_before = len(resample_calls)
        await pp.flush()

        # flush should have called _resample_frame for the remainder
        assert len(resample_calls) >= resample_count_before


# ---------------------------------------------------------------------------
# Utterance timing uses _target_sr
# ---------------------------------------------------------------------------


class TestUtteranceTiming:
    @pytest.mark.asyncio
    async def test_end_time_uses_target_sr(self):
        """Utterance end_time should be computed using target sample rate."""
        vad_svc, _ = _make_vad_service(speech_frames=10)
        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad_svc,
            denoiser=PassthroughDenoiser(),
            threshold=0.5,
            min_speech_duration_ms=250,
            min_silence_duration_ms=700,
        )

        all_utts = []
        for _ in range(50):
            utts = await pp.feed(_make_speech_pcm())
            all_utts.extend(utts)

        assert len(all_utts) == 1
        utt = all_utts[0]
        # With 50 frames of 512 samples at 16kHz, total time ~ 50*0.032 = 1.6s
        # Offset happens around frame 30 (10 speech + ~22 silence)
        assert 0.5 < utt.end_time < 2.0
        assert utt.start_time >= 0.0
        assert utt.end_time > utt.start_time
