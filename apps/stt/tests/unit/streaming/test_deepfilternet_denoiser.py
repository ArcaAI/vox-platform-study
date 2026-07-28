"""Unit tests for DeepFilterNet3StreamingDenoiser.

Tests:
- initialize() returns False gracefully when `deepfilternet` is not installed
- process() passes audio through unmodified while not available
- process() passes audio through unmodified while a block is still filling
- process() emits enhanced audio once a block completes
- strength=0 passthrough
- reset() clears buffers
"""

from unittest.mock import MagicMock, patch

import numpy as np


class TestDeepFilterNet3StreamingDenoiserInit:
    def test_initialize_returns_false_without_deepfilternet(self):
        from stt.streaming.deepfilternet_denoiser import DeepFilterNet3StreamingDenoiser

        denoiser = DeepFilterNet3StreamingDenoiser(input_sr=16000, strength=1.0)
        # `df` is not installed in this environment — initialize() must
        # degrade gracefully rather than raising.
        assert denoiser.initialize() is False
        assert denoiser.is_available is False

    def test_process_passthrough_when_unavailable(self):
        from stt.streaming.deepfilternet_denoiser import DeepFilterNet3StreamingDenoiser

        denoiser = DeepFilterNet3StreamingDenoiser(input_sr=16000, strength=1.0)
        denoiser.initialize()  # unavailable in this env

        frame = np.random.randn(320).astype(np.float32) * 0.1
        result = denoiser.process(frame)

        np.testing.assert_array_equal(result, frame)


class TestDeepFilterNet3StreamingDenoiserBlockProcessing:
    def test_passthrough_while_block_filling(self):
        """A block (1s @ 16kHz = 16000 samples) hasn't filled yet — the
        original frame should pass through unmodified."""
        from stt.streaming.deepfilternet_denoiser import DeepFilterNet3StreamingDenoiser

        denoiser = DeepFilterNet3StreamingDenoiser(input_sr=16000, strength=1.0)
        denoiser._available = True
        denoiser._model = MagicMock()
        denoiser._df_state = MagicMock()

        frame = np.random.randn(320).astype(np.float32) * 0.1
        result = denoiser.process(frame)

        np.testing.assert_array_equal(result, frame)

    def test_emits_enhanced_audio_once_block_completes(self):
        """Once enough frames accumulate to fill one block, `enhance()` runs
        and the queued enhanced audio is emitted."""
        from stt.streaming.deepfilternet_denoiser import DeepFilterNet3StreamingDenoiser

        denoiser = DeepFilterNet3StreamingDenoiser(input_sr=16000, strength=1.0)
        denoiser._available = True
        denoiser._model = MagicMock()
        denoiser._df_state = MagicMock()

        block_size = denoiser._block_samples_in
        # Force enhance() to return a distinctive constant so we can verify
        # the output differs from the (random) input.
        with patch.object(
            denoiser, "_enhance_block", return_value=np.full(block_size, 0.42, dtype=np.float32)
        ) as mock_enhance:
            frame = np.random.randn(block_size).astype(np.float32) * 0.1
            result = denoiser.process(frame)

            mock_enhance.assert_called_once()
            np.testing.assert_array_almost_equal(
                result, np.full(block_size, 0.42, dtype=np.float32)
            )

    def test_strength_zero_passthrough(self):
        from stt.streaming.deepfilternet_denoiser import DeepFilterNet3StreamingDenoiser

        denoiser = DeepFilterNet3StreamingDenoiser(input_sr=16000, strength=0.0)
        denoiser._available = True
        denoiser._model = MagicMock()
        denoiser._df_state = MagicMock()

        frame = np.random.randn(16000).astype(np.float32) * 0.1
        result = denoiser.process(frame)

        np.testing.assert_array_equal(result, frame)

    def test_enhance_failure_degrades_to_passthrough(self):
        """If enhance() raises, the block is queued unmodified rather than
        starving the output queue forever."""
        from stt.streaming.deepfilternet_denoiser import DeepFilterNet3StreamingDenoiser

        denoiser = DeepFilterNet3StreamingDenoiser(input_sr=16000, strength=1.0)
        denoiser._available = True
        denoiser._model = MagicMock()
        denoiser._df_state = MagicMock()

        block_size = denoiser._block_samples_in
        with patch.object(denoiser, "_enhance_block", return_value=None):
            frame = np.random.randn(block_size).astype(np.float32) * 0.1
            result = denoiser.process(frame)

            np.testing.assert_array_equal(result, frame)

    def test_reset_clears_buffers(self):
        from stt.streaming.deepfilternet_denoiser import DeepFilterNet3StreamingDenoiser

        denoiser = DeepFilterNet3StreamingDenoiser(input_sr=16000, strength=1.0)
        denoiser._pending_in = np.zeros(100, dtype=np.float32)
        denoiser._output_queue = np.zeros(50, dtype=np.float32)

        denoiser.reset()

        assert len(denoiser._pending_in) == 0
        assert len(denoiser._output_queue) == 0
