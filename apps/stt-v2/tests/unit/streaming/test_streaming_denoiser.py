"""Unit tests for StreamingDenoiser (A2).

Tests:
- process() returns correct-size frame
- strength=0 passthrough
- strength=1 full denoise
- ring buffer drains across multiple calls
- graceful fallback when pyrnnoise is missing
- initialize() returns False without pyrnnoise
- reset() clears state
"""

from unittest.mock import MagicMock, patch

import numpy as np


class TestStreamingDenoiserProcess:

    def test_process_returns_correct_size_frame(self):
        """Denoised frame should have same length as input frame."""
        from stt_v2.streaming.denoiser import StreamingDenoiser

        denoiser = StreamingDenoiser(input_sr=16000, strength=1.0)
        # Mock pyrnnoise
        mock_rnnoise = MagicMock()
        mock_rnnoise.denoise_chunk.return_value = iter([
            (np.zeros((1, 1), dtype=np.float32), np.zeros((1, 480), dtype=np.float32)),
        ])
        denoiser._rnnoise = mock_rnnoise
        denoiser._available = True

        frame = np.random.randn(512).astype(np.float32) * 0.1
        result = denoiser.process(frame)

        assert result.shape == frame.shape
        assert result.dtype == np.float32

    def test_strength_zero_passthrough(self):
        """With strength=0, output should equal input."""
        from stt_v2.streaming.denoiser import StreamingDenoiser

        denoiser = StreamingDenoiser(input_sr=16000, strength=0.0)
        mock_rnnoise = MagicMock()
        mock_rnnoise.denoise_chunk.return_value = iter([
            (np.zeros((1, 1), dtype=np.float32), np.ones((1, 480), dtype=np.float32)),
        ])
        denoiser._rnnoise = mock_rnnoise
        denoiser._available = True

        frame = np.random.randn(512).astype(np.float32) * 0.1
        result = denoiser.process(frame)

        np.testing.assert_array_almost_equal(result, frame)

    def test_strength_one_full_denoise(self):
        """With strength=1, output should differ from input (denoised)."""
        from stt_v2.streaming.denoiser import StreamingDenoiser

        denoiser = StreamingDenoiser(input_sr=16000, strength=1.0)
        mock_rnnoise = MagicMock()
        # Return zeros (fully denoised)
        def _zero_denoise(chunk):
            yield (np.zeros((1, 1), dtype=np.float32), np.zeros((1, 480), dtype=np.float32))
        mock_rnnoise.denoise_chunk.side_effect = _zero_denoise
        denoiser._rnnoise = mock_rnnoise
        denoiser._available = True

        # First frame is passthrough (buffer needs priming), so feed two
        frame = np.ones(512, dtype=np.float32) * 0.5
        denoiser.process(frame)  # primes buffer
        result = denoiser.process(frame)  # second frame gets denoised

        # Result should not equal input (it's blended with denoised zeros)
        assert not np.allclose(result, frame)

    def test_ring_buffer_drains_across_multiple_calls(self):
        """Multiple process() calls should accumulate and drain ring buffer correctly."""
        from stt_v2.streaming.denoiser import StreamingDenoiser

        denoiser = StreamingDenoiser(input_sr=16000, strength=1.0)
        mock_rnnoise = MagicMock()
        mock_rnnoise.denoise_chunk.return_value = iter([
            (np.zeros((1, 1), dtype=np.float32), np.zeros((1, 480), dtype=np.float32)),
        ])
        denoiser._rnnoise = mock_rnnoise
        denoiser._available = True

        # Feed multiple frames
        for _ in range(5):
            mock_rnnoise.denoise_chunk.return_value = iter([
                (np.zeros((1, 1), dtype=np.float32), np.zeros((1, 480), dtype=np.float32)),
            ])
            frame = np.random.randn(512).astype(np.float32) * 0.1
            result = denoiser.process(frame)
            assert result.shape == (512,)

        # denoise_chunk should have been called multiple times
        assert mock_rnnoise.denoise_chunk.call_count > 0


class TestStreamingDenoiserInit:

    def test_graceful_fallback_pyrnnoise_missing(self):
        """When pyrnnoise is not importable, process() returns input unchanged."""
        from stt_v2.streaming.denoiser import StreamingDenoiser

        denoiser = StreamingDenoiser(input_sr=16000, strength=1.0)
        # Don't initialize -- pyrnnoise not available
        denoiser._available = False
        denoiser._rnnoise = None

        frame = np.random.randn(512).astype(np.float32) * 0.1
        result = denoiser.process(frame)

        np.testing.assert_array_equal(result, frame)

    def test_initialize_returns_false_without_pyrnnoise(self):
        """initialize() should return False when pyrnnoise is not installed."""
        from stt_v2.streaming.denoiser import StreamingDenoiser

        denoiser = StreamingDenoiser(input_sr=16000, strength=1.0)

        with patch.dict("sys.modules", {"pyrnnoise": None}):
            with patch("builtins.__import__", side_effect=ImportError("no pyrnnoise")):
                result = denoiser.initialize()

        assert result is False

    def test_reset_clears_state(self):
        """reset() should clear ring buffer and denoised output."""
        from stt_v2.streaming.denoiser import StreamingDenoiser

        denoiser = StreamingDenoiser(input_sr=16000, strength=1.0)
        mock_rnnoise = MagicMock()
        mock_rnnoise.denoise_chunk.return_value = iter([
            (np.zeros((1, 1), dtype=np.float32), np.zeros((1, 480), dtype=np.float32)),
        ])
        denoiser._rnnoise = mock_rnnoise
        denoiser._available = True

        # Process a frame to populate internal state
        frame = np.random.randn(512).astype(np.float32) * 0.1
        denoiser.process(frame)

        denoiser.reset()

        assert len(denoiser._ring_48k) == 0
        assert len(denoiser._denoised_48k) == 0
