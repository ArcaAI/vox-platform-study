"""Tests for TASK-258: denoiser int16 scaling, fade-in crossfade, fixed
downsample ratio, and temporal alignment for blending.

Root causes:
1. StreamingDenoiser.process() fed float32 [-1, 1] audio directly to
   pyrnnoise which expects int16-scale input (~[-32768, 32768]).
2. Fade-in ramped FROM SILENCE instead of crossfading original->denoised.
3. Variable consumption from denoised_48k buffer caused pitch wobble.
4. Blending mixed current frame (time T) with denoised previous frame
   (time T-32ms), creating a comb filter with -10dB notches at speech
   frequencies perceived as echo.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import numpy as np
import pytest

from stt_v2.streaming.denoiser import StreamingDenoiser, _RNNOISE_FRAME_SIZE


def _make_denoiser(strength: float = 1.0) -> tuple[StreamingDenoiser, MagicMock]:
    """Create a denoiser with a mock RNNoise."""
    d = StreamingDenoiser(input_sr=16000, strength=strength)
    mock_rnnoise = MagicMock()
    d._rnnoise = mock_rnnoise
    d._available = True
    return d, mock_rnnoise


def _identity_denoise_side_effect(chunk):
    """Mock denoise_chunk that returns the input as-is (identity)."""
    flat = np.asarray(chunk, dtype=np.float32).ravel()
    yield (0.95, flat[:_RNNOISE_FRAME_SIZE].reshape(1, -1))


class TestDenoiserInt16Scaling:
    """Verify input to pyrnnoise is scaled to int16 range (TASK-258 bug 1)."""

    def test_denoise_chunk_receives_int16_dtype(self):
        """denoise_chunk should receive int16 numpy array, not float32."""
        d, mock_rnnoise = _make_denoiser(strength=1.0)
        mock_rnnoise.denoise_chunk.return_value = iter([
            (0.95, np.zeros((1, _RNNOISE_FRAME_SIZE), dtype=np.float32)),
        ])

        # Skip fade-in
        d._total_input_samples = d._fade_in_samples + 1

        frame = np.ones(512, dtype=np.float32) * 0.5
        d.process(frame)

        assert mock_rnnoise.denoise_chunk.called
        call_args = mock_rnnoise.denoise_chunk.call_args[0][0]
        assert call_args.dtype == np.int16, (
            f"Expected int16 input to denoise_chunk, got {call_args.dtype}"
        )

    def test_denoise_chunk_receives_int16_scaled_values(self):
        """Input values to denoise_chunk should be in int16 range, not [-1, 1]."""
        d, mock_rnnoise = _make_denoiser(strength=1.0)
        mock_rnnoise.denoise_chunk.return_value = iter([
            (0.95, np.zeros((1, _RNNOISE_FRAME_SIZE), dtype=np.float32)),
        ])

        d._total_input_samples = d._fade_in_samples + 1

        frame = np.ones(512, dtype=np.float32) * 0.5
        d.process(frame)

        call_args = mock_rnnoise.denoise_chunk.call_args[0][0]
        max_val = float(np.abs(call_args).max())
        assert max_val > 1000, (
            f"Expected int16-scale values (>1000), got max={max_val}. "
            "Input was not scaled from [-1,1] to int16 range."
        )

    def test_output_amplitude_preserved_after_fadein(self):
        """After fade-in, output amplitude should be comparable to input."""
        d, mock_rnnoise = _make_denoiser(strength=1.0)
        mock_rnnoise.denoise_chunk.side_effect = _identity_denoise_side_effect

        # Skip past fade-in; also pre-fill buffer so first frame isn't passthrough
        d._total_input_samples = d._fade_in_samples + 1

        # Prime the denoised_48k buffer by feeding a frame first
        prime = np.ones(512, dtype=np.float32) * 0.3
        d.process(prime)

        # Now test the second frame (buffer should have enough)
        frame = np.ones(512, dtype=np.float32) * 0.3
        result = d.process(frame)

        input_rms = float(np.sqrt(np.mean(frame ** 2)))
        output_rms = float(np.sqrt(np.mean(result ** 2)))

        ratio = output_rms / max(input_rms, 1e-10)
        assert ratio > 0.01, (
            f"Output RMS ({output_rms:.6f}) is >40dB below input RMS ({input_rms:.6f}). "
            f"Ratio={ratio:.6f}. Likely missing int16 scaling."
        )


class TestDenoiserFadeInCrossfade:
    """Verify fade-in crossfades between original and denoised (TASK-258 bug 2)."""

    def test_fade_in_preserves_energy(self):
        """During fade-in with denoised=0, output should still have energy
        from the original signal (crossfade, not ramp-from-silence)."""
        d, mock_rnnoise = _make_denoiser(strength=1.0)
        mock_rnnoise.denoise_chunk.return_value = iter([
            (0.95, np.zeros((1, _RNNOISE_FRAME_SIZE), dtype=np.float32)),
        ] * 10)

        # Fill buffer so second frame gets denoised output
        d.process(np.ones(512, dtype=np.float32) * 0.4)

        # Second frame during fade-in
        frame = np.ones(512, dtype=np.float32) * 0.4
        mock_rnnoise.denoise_chunk.return_value = iter([
            (0.95, np.zeros((1, _RNNOISE_FRAME_SIZE), dtype=np.float32)),
        ] * 10)
        result = d.process(frame)

        input_rms = float(np.sqrt(np.mean(frame ** 2)))
        output_rms = float(np.sqrt(np.mean(result ** 2)))

        assert output_rms > input_rms * 0.3, (
            f"Fade-in output RMS ({output_rms:.4f}) should preserve energy "
            f"from original ({input_rms:.4f}). Got ratio={output_rms/input_rms:.4f}"
        )


class TestDenoiserFixedDownsampleRatio:
    """Verify fixed consumption prevents pitch wobble (TASK-258 bug 3).

    The old approach consumed variable amounts from the denoised_48k
    buffer (1440, 1440, 1440, 1440, 1920 in a 5-frame cycle) because
    it clamped to available samples.  This caused the downsample ratio
    to alternate between 2.8125 and 3.75 instead of the correct 3.0,
    creating periodic pitch wobble perceived as ~50ms echo.
    """

    def test_output_length_always_matches_input(self):
        """Every denoised output frame must have the same length as input."""
        d, mock_rnnoise = _make_denoiser(strength=1.0)
        mock_rnnoise.denoise_chunk.side_effect = _identity_denoise_side_effect
        d._total_input_samples = d._fade_in_samples + 1

        for i in range(20):
            frame = np.random.randn(512).astype(np.float32) * 0.3
            result = d.process(frame)
            assert len(result) == 512, (
                f"Frame {i}: output length {len(result)} != input length 512"
            )

    def test_no_pitch_wobble_over_cycle(self):
        """Output should not have periodic speed variation.

        Feed a 440Hz tone through the denoiser for 20 frames.
        Measure the period of the output signal in each frame.
        All frames should have the same period (no pitch wobble).
        """
        d, mock_rnnoise = _make_denoiser(strength=1.0)
        mock_rnnoise.denoise_chunk.side_effect = _identity_denoise_side_effect
        d._total_input_samples = d._fade_in_samples + 1

        sr = 16000
        freq = 440.0
        samples_per_period = sr / freq  # ~36.36 samples

        # Need to prime buffer first (frame 1 is passthrough)
        prime = np.sin(2 * np.pi * freq * np.arange(512) / sr).astype(np.float32)
        d.process(prime)

        periods = []
        for i in range(15):
            t_start = (i + 1) * 512  # offset by prime frame
            t = np.arange(t_start, t_start + 512) / sr
            frame = np.sin(2 * np.pi * freq * t).astype(np.float32)
            result = d.process(frame)

            # Measure zero crossings to estimate period
            crossings = np.where(np.diff(np.sign(result)))[0]
            if len(crossings) >= 2:
                avg_half_period = np.mean(np.diff(crossings))
                periods.append(avg_half_period * 2)

        assert len(periods) >= 10, f"Not enough frames with zero crossings: {len(periods)}"

        # All periods should be within 5% of each other (no wobble).
        # The old code had ~6%/+25% variation.
        mean_period = np.mean(periods)
        max_deviation = max(abs(p - mean_period) / mean_period for p in periods)
        assert max_deviation < 0.05, (
            f"Pitch wobble detected: max deviation {max_deviation:.1%} from mean period "
            f"{mean_period:.2f}. Periods: {[f'{p:.2f}' for p in periods]}"
        )

    def test_buffer_stays_bounded(self):
        """The denoised_48k buffer should not grow unboundedly."""
        d, mock_rnnoise = _make_denoiser(strength=1.0)
        mock_rnnoise.denoise_chunk.side_effect = _identity_denoise_side_effect
        d._total_input_samples = d._fade_in_samples + 1

        max_buf_size = 0
        for _ in range(100):
            frame = np.random.randn(512).astype(np.float32) * 0.3
            d.process(frame)
            buf_size = len(d._denoised_48k)
            if buf_size > max_buf_size:
                max_buf_size = buf_size

        # Buffer should never exceed 2 * n_up (3072 for 512@16kHz)
        n_up = 512 * 3  # 1536
        assert max_buf_size < 2 * n_up, (
            f"Buffer grew to {max_buf_size}, expected < {2 * n_up}. "
            "Possible unbounded growth."
        )

    def test_first_frame_passthrough_then_denoise(self):
        """First frame should passthrough (insufficient buffer), then denoise."""
        d, mock_rnnoise = _make_denoiser(strength=1.0)
        mock_rnnoise.denoise_chunk.side_effect = _identity_denoise_side_effect
        d._total_input_samples = d._fade_in_samples + 1

        # Frame 1: passthrough (only 1440 denoised samples, need 1536)
        frame1 = np.ones(512, dtype=np.float32) * 0.5
        result1 = d.process(frame1)
        # Should get back original (passthrough)
        np.testing.assert_array_equal(result1, frame1)

        # Frame 2: denoised (buffer now has 1440+1440=2880, need 1536)
        frame2 = np.ones(512, dtype=np.float32) * 0.5
        result2 = d.process(frame2)
        # Should NOT be identical to input (went through RNNoise + resample)
        # Just verify it's a valid float32 array of correct length
        assert len(result2) == 512
        assert result2.dtype == np.float32


class TestDenoiserFrequencyPreservation:
    """Verify resample round-trip preserves input frequency (FFT check)"""

    def test_440hz_survives_resample_roundtrip(self):
        """A 440Hz tone fed through the denoiser should still peak at 440Hz."""
        d, mock_rnnoise = _make_denoiser(strength=1.0)
        mock_rnnoise.denoise_chunk.side_effect = _identity_denoise_side_effect
        d._total_input_samples = d._fade_in_samples + 1

        sr = 16000
        freq = 440.0
        n_frames = 30
        frame_len = 512

        # Prime buffer (first frame is passthrough)
        prime = np.sin(2 * np.pi * freq * np.arange(frame_len) / sr).astype(np.float32)
        d.process(prime)

        # Collect denoised output
        output_samples: list[np.ndarray] = []
        for i in range(1, n_frames):
            t = np.arange(i * frame_len, (i + 1) * frame_len) / sr
            frame = np.sin(2 * np.pi * freq * t).astype(np.float32)
            result = d.process(frame)
            output_samples.append(result)

        signal = np.concatenate(output_samples)

        # FFT to find dominant frequency
        spectrum = np.abs(np.fft.rfft(signal))
        freqs = np.fft.rfftfreq(len(signal), d=1.0 / sr)
        peak_freq = freqs[np.argmax(spectrum)]

        assert abs(peak_freq - freq) < 10.0, (
            f"Peak frequency {peak_freq:.1f}Hz != expected {freq:.1f}Hz. "
            f"Resampling appears to shift pitch."
        )

    def test_1000hz_survives_resample_roundtrip(self):
        """A 1000Hz tone should also survive the resample round-trip."""
        d, mock_rnnoise = _make_denoiser(strength=1.0)
        mock_rnnoise.denoise_chunk.side_effect = _identity_denoise_side_effect
        d._total_input_samples = d._fade_in_samples + 1

        sr = 16000
        freq = 1000.0
        n_frames = 30
        frame_len = 512

        prime = np.sin(2 * np.pi * freq * np.arange(frame_len) / sr).astype(np.float32)
        d.process(prime)

        output_samples: list[np.ndarray] = []
        for i in range(1, n_frames):
            t = np.arange(i * frame_len, (i + 1) * frame_len) / sr
            frame = np.sin(2 * np.pi * freq * t).astype(np.float32)
            result = d.process(frame)
            output_samples.append(result)

        signal = np.concatenate(output_samples)

        spectrum = np.abs(np.fft.rfft(signal))
        freqs = np.fft.rfftfreq(len(signal), d=1.0 / sr)
        peak_freq = freqs[np.argmax(spectrum)]

        assert abs(peak_freq - freq) < 10.0, (
            f"Peak frequency {peak_freq:.1f}Hz != expected {freq:.1f}Hz. "
            f"Resampling appears to shift pitch."
        )

    def test_no_spurious_harmonic_above_input(self):
        """Resample round-trip should not introduce strong harmonics above input freq.

        Feed 440Hz and verify no spectral peak above 2*440=880Hz exceeds
        20% of the fundamental's magnitude.  Catches aliasing artifacts
        from the decimation step folding spectral images back into band.
        """
        d, mock_rnnoise = _make_denoiser(strength=1.0)
        mock_rnnoise.denoise_chunk.side_effect = _identity_denoise_side_effect
        d._total_input_samples = d._fade_in_samples + 1

        sr = 16000
        freq = 440.0
        n_frames = 30
        frame_len = 512

        prime = np.sin(2 * np.pi * freq * np.arange(frame_len) / sr).astype(np.float32)
        d.process(prime)

        output_samples: list[np.ndarray] = []
        for i in range(1, n_frames):
            t = np.arange(i * frame_len, (i + 1) * frame_len) / sr
            frame = np.sin(2 * np.pi * freq * t).astype(np.float32)
            result = d.process(frame)
            output_samples.append(result)

        signal = np.concatenate(output_samples)

        spectrum = np.abs(np.fft.rfft(signal))
        freqs = np.fft.rfftfreq(len(signal), d=1.0 / sr)

        fundamental_mag = spectrum[np.argmax(spectrum)]

        # Check energy above 2*freq (above first harmonic)
        high_mask = freqs > 2 * freq
        if np.any(high_mask):
            max_high_mag = float(np.max(spectrum[high_mask]))
            ratio = max_high_mag / max(float(fundamental_mag), 1e-10)
            assert ratio < 0.20, (
                f"Spurious high-frequency content: max above {2*freq:.0f}Hz is "
                f"{ratio:.1%} of fundamental. Possible aliasing from decimation."
            )


class TestDenoiserTemporalAlignment:
    """Verify blending uses temporally-aligned signals (TASK-258 bug 4).

    The denoised output is delayed by ~1 frame relative to the input.
    When strength < 1.0, blending current frame (time T) with denoised
    previous frame (time T-32ms) creates a comb filter with -10dB
    notches at 200Hz, 300Hz, etc.  The fix: delay the original frame
    to match the denoised signal's timing.
    """

    def test_no_comb_filter_at_half_strength(self):
        """At strength=0.5, blending should NOT create frequency notches.

        We feed two different constant-amplitude frames and verify the blend
        uses the PREVIOUS frame (same time as denoised), not the current one.
        """
        d, mock_rnnoise = _make_denoiser(strength=0.5)
        mock_rnnoise.denoise_chunk.side_effect = _identity_denoise_side_effect
        d._total_input_samples = d._fade_in_samples + 1

        # Frame 1: constant 0.4 (passthrough -- buffer too small)
        frame1 = np.ones(512, dtype=np.float32) * 0.4
        d.process(frame1)

        # Frame 2: constant 0.8 (denoised output = frame1's content)
        # If temporally aligned: blend = 0.5*frame1 + 0.5*denoised(frame1)
        #   both at amplitude ~0.4 -> output ~0.4
        # If NOT aligned (bug): blend = 0.5*frame2 + 0.5*denoised(frame1)
        #   = 0.5*0.8 + 0.5*~0.4 = ~0.6  (wrong!)
        frame2 = np.ones(512, dtype=np.float32) * 0.8
        result2 = d.process(frame2)

        mean_out = float(np.mean(np.abs(result2)))
        # Correct (aligned): output should be close to 0.4 (frame1's value)
        # Buggy (unaligned): output would be ~0.6 (average of 0.4 and 0.8)
        assert mean_out < 0.55, (
            f"Blend mean={mean_out:.3f}, expected ~0.4 (aligned with frame1). "
            f"Got ~0.6 means blending with current frame instead of delayed."
        )
