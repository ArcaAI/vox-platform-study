"""Unit tests for StreamingPreprocessor normalize + resample (S1).

Tests:
- _normalize_frame: silence, loud signal, peak decay
- _resample_frame: identity, 8k->16k
- feed(): normalize before VAD, resample before VAD, no-normalize passthrough
"""

from unittest.mock import MagicMock, patch
import numpy as np
import pytest

from stt_v2.streaming.preprocessor import StreamingPreprocessor


def _make_preprocessor(**kwargs) -> StreamingPreprocessor:
    """Create a preprocessor with a mock VAD service."""
    vad_service = MagicMock()
    defaults = dict(
        session_id="test",
        sample_rate=16000,
        vad_service=vad_service,
    )
    defaults.update(kwargs)
    return StreamingPreprocessor(**defaults)


class TestNormalizeFrame:
    """Test the causal peak-tracking normalization."""

    def test_silence_no_crash(self):
        """All-zero frame should not divide-by-zero."""
        pp = _make_preprocessor(normalize=True)
        frame = np.zeros(512, dtype=np.float32)
        result = pp._normalize_frame(frame)
        assert result.shape == (512,)
        assert np.allclose(result, 0.0)

    def test_loud_signal_normalized(self):
        """A loud frame should have its peak brought toward 1.0."""
        pp = _make_preprocessor(normalize=True)
        frame = np.full(512, 0.8, dtype=np.float32)
        result = pp._normalize_frame(frame)
        # After normalization, max should be near 1.0
        assert np.abs(result).max() > 0.9
        assert np.abs(result).max() <= 1.0 + 1e-6

    def test_peak_decay(self):
        """Peak tracker should decay when subsequent frames are quieter."""
        pp = _make_preprocessor(normalize=True)
        loud = np.full(512, 0.8, dtype=np.float32)
        pp._normalize_frame(loud)
        peak_after_loud = pp._peak_tracker

        quiet = np.full(512, 0.01, dtype=np.float32)
        pp._normalize_frame(quiet)
        peak_after_quiet = pp._peak_tracker

        assert peak_after_quiet < peak_after_loud


class TestResampleFrame:
    """Test per-frame resampling."""

    def test_identity_no_change(self):
        """When sample rates match, frame should pass through unchanged."""
        pp = _make_preprocessor(sample_rate=16000, target_sample_rate=16000)
        frame = np.random.randn(512).astype(np.float32)
        result = pp._resample_frame(frame)
        np.testing.assert_array_equal(result, frame)

    def test_8k_to_16k(self):
        """Resampling from 8kHz to 16kHz should double the sample count."""
        pp = _make_preprocessor(sample_rate=8000, target_sample_rate=16000)
        frame = np.random.randn(256).astype(np.float32)
        result = pp._resample_frame(frame)
        assert len(result) == 512


class TestFeedIntegration:
    """Test that feed() applies stages: normalize -> resample -> denoise -> VAD."""

    @pytest.mark.asyncio
    async def test_feed_applies_normalize_before_vad(self):
        """When normalize=True, frames should be normalized before VAD."""
        vad_frames = []

        def capture_vad(frame):
            vad_frames.append(frame.copy())
            return 0.1  # below threshold -> no speech

        pp = _make_preprocessor(normalize=True)
        pp._run_vad = capture_vad

        # Feed a loud frame
        loud_pcm = (np.full(512, 0.8 * 32768, dtype=np.float32)).astype(np.int16).tobytes()
        await pp.feed(loud_pcm)

        assert len(vad_frames) >= 1
        # The frame that reached VAD should be normalized (peak near 1.0)
        assert np.abs(vad_frames[0]).max() > 0.9

    @pytest.mark.asyncio
    async def test_feed_applies_resample_before_vad(self):
        """When target_sample_rate differs, frames should be resampled before VAD."""
        vad_frames = []

        def capture_vad(frame):
            vad_frames.append(frame.copy())
            return 0.1

        pp = _make_preprocessor(sample_rate=8000, target_sample_rate=16000)
        pp._run_vad = capture_vad
        # Override frame size since we're feeding 8kHz data with 256-sample frames
        pp._frame_size = 256

        # Feed 8kHz frame (256 samples = 32ms)
        tone = np.sin(np.linspace(0, 2 * np.pi, 256)).astype(np.float32)
        pcm = (tone * 32768).clip(-32768, 32767).astype(np.int16).tobytes()
        await pp.feed(pcm)

        assert len(vad_frames) >= 1
        # Resampled frame should be 512 samples (16kHz)
        assert len(vad_frames[0]) == 512

    @pytest.mark.asyncio
    async def test_feed_without_normalize_no_change(self):
        """When normalize=False (default), frames pass through raw."""
        vad_frames = []

        def capture_vad(frame):
            vad_frames.append(frame.copy())
            return 0.1

        pp = _make_preprocessor(normalize=False)
        pp._run_vad = capture_vad

        value = 0.5
        pcm = (np.full(512, value * 32768, dtype=np.float32)).astype(np.int16).tobytes()
        await pp.feed(pcm)

        assert len(vad_frames) >= 1
        # Without normalization, the value should be close to original
        np.testing.assert_allclose(vad_frames[0], value, atol=1e-3)

    @pytest.mark.asyncio
    async def test_feed_stage_order_resample_before_denoise(self):
        """Resample must happen before denoise: denoise receives resampled frames."""
        denoise_frame_sizes = []

        class RecordingDenoiser:
            def process(self, frame):
                denoise_frame_sizes.append(len(frame))
                return frame

        pp = _make_preprocessor(
            sample_rate=8000,
            target_sample_rate=16000,
            denoiser=RecordingDenoiser(),
        )
        pp._run_vad = lambda frame: 0.1
        pp._frame_size = 256  # 8kHz frame size

        tone = np.sin(np.linspace(0, 2 * np.pi, 256)).astype(np.float32)
        pcm = (tone * 32768).clip(-32768, 32767).astype(np.int16).tobytes()
        await pp.feed(pcm)

        # Denoiser should receive 512-sample frames (resampled to 16kHz), not 256
        assert len(denoise_frame_sizes) >= 1
        assert denoise_frame_sizes[0] == 512

    @pytest.mark.asyncio
    async def test_feed_stage_order_denoise_before_vad(self):
        """Denoise must happen before VAD: VAD receives denoised frames."""
        vad_frames = []

        class ScalingDenoiser:
            """Denoiser that scales by 0.5 so we can detect it reached VAD."""

            def process(self, frame):
                return frame * 0.5

        def capture_vad(frame):
            vad_frames.append(frame.copy())
            return 0.1

        pp = _make_preprocessor(denoiser=ScalingDenoiser())
        pp._run_vad = capture_vad

        pcm = (np.full(512, 0.8 * 32768, dtype=np.float32)).astype(np.int16).tobytes()
        await pp.feed(pcm)

        assert len(vad_frames) >= 1
        # VAD should see denoised (scaled by 0.5) values, not original 0.8
        np.testing.assert_allclose(vad_frames[0], 0.4, atol=0.02)
