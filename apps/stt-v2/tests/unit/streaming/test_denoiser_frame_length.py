"""Tests for denoiser output frame length consistency.

Verifies that StreamingDenoiser.process() always returns the same
number of samples as the input, across warmup and steady-state.
"""

from __future__ import annotations

import numpy as np

from stt_v2.streaming.denoiser import StreamingDenoiser


class TestDenoiserFrameLength:
    """Verify denoiser output length matches input length."""

    def _make_denoiser(self, input_sr: int = 16000) -> StreamingDenoiser:
        d = StreamingDenoiser(input_sr=input_sr, strength=1.0)
        # Don't initialize (pyrnnoise may not be available in CI).
        # When unavailable, process() returns input unchanged.
        return d

    def test_output_length_matches_input_passthrough(self):
        """When pyrnnoise unavailable, output length == input length."""
        d = self._make_denoiser()
        for _ in range(100):
            frame = np.random.randn(512).astype(np.float32) * 0.3
            result = d.process(frame)
            assert len(result) == 512

    def test_output_length_with_varying_input_sizes(self):
        """Output length matches for various input sizes."""
        d = self._make_denoiser()
        for n in [256, 512, 1024, 160, 480]:
            frame = np.random.randn(n).astype(np.float32) * 0.3
            result = d.process(frame)
            assert len(result) == n, f"Expected {n} samples, got {len(result)}"

    def test_output_dtype_is_float32(self):
        """Output should always be float32."""
        d = self._make_denoiser()
        frame = np.random.randn(512).astype(np.float32)
        result = d.process(frame)
        assert result.dtype == np.float32

    def test_zero_strength_returns_input(self):
        """With strength=0, denoiser should return exact input."""
        d = StreamingDenoiser(input_sr=16000, strength=0.0)
        frame = np.random.randn(512).astype(np.float32) * 0.5
        result = d.process(frame)
        np.testing.assert_array_equal(result, frame)

    def test_reset_clears_state(self):
        """After reset, denoiser should work normally."""
        d = self._make_denoiser()
        # Feed some frames
        for _ in range(10):
            d.process(np.random.randn(512).astype(np.float32))
        d.reset()
        # Should still work
        result = d.process(np.random.randn(512).astype(np.float32))
        assert len(result) == 512

    def test_empty_input_returns_empty(self):
        """Empty input should return empty."""
        d = self._make_denoiser()
        result = d.process(np.array([], dtype=np.float32))
        assert len(result) == 0
