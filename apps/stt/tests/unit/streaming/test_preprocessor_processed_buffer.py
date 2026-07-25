"""RED tests for S4 — preprocessor processed-audio buffer and drain."""

import numpy as np

from stt.streaming.preprocessor import StreamingPreprocessor


class TestHasDenoiser:
    def test_has_denoiser_true_when_denoiser_set(self):
        pp = StreamingPreprocessor(session_id="s1", denoiser=object())
        assert pp.has_denoiser is True

    def test_has_denoiser_false_when_no_denoiser(self):
        pp = StreamingPreprocessor(session_id="s1")
        assert pp.has_denoiser is False


class TestDrainProcessedSamples:
    def test_drain_returns_empty_when_nothing_collected(self):
        pp = StreamingPreprocessor(session_id="s1")
        assert pp.drain_processed_samples() == b""

    def test_drain_returns_pcm_int16_bytes(self):
        pp = StreamingPreprocessor(session_id="s1", denoiser=object())
        # Manually inject processed samples
        samples = np.array([0.5, -0.5, 0.0], dtype=np.float32)
        pp._processed_samples.append(samples)

        pcm = pp.drain_processed_samples()
        assert isinstance(pcm, bytes)
        assert len(pcm) == 3 * 2  # 3 samples * 2 bytes each (int16)

        # Verify roundtrip
        recovered = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        np.testing.assert_allclose(recovered, samples, atol=1e-4)

    def test_drain_clears_buffer(self):
        pp = StreamingPreprocessor(session_id="s1", denoiser=object())
        pp._processed_samples.append(np.array([0.1], dtype=np.float32))

        first = pp.drain_processed_samples()
        assert len(first) > 0

        second = pp.drain_processed_samples()
        assert second == b""

    async def test_feed_collects_processed_when_denoiser_present(self):
        """When denoiser is present, feed() should accumulate processed samples
        once VAD detects speech onset."""
        from unittest.mock import MagicMock

        class PassthroughDenoiser:
            def process(self, frame):
                return frame

        # Mock VAD that always returns speech
        vad_svc = MagicMock()
        vad_svc.is_loaded = True
        vad_svc.process_chunk = MagicMock(return_value=0.9)

        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad_svc,
            denoiser=PassthroughDenoiser(),
            threshold=0.5,
            min_speech_duration_ms=32,
        )

        # Feed enough frames to trigger speech onset (min_speech_frames=1 at 32ms)
        t = np.linspace(0, 0.032, 512, endpoint=False)
        frame = (10000 * np.sin(2 * np.pi * 440 * t)).astype(np.int16)
        for _ in range(3):
            await pp.feed(frame.tobytes())

        pcm = pp.drain_processed_samples()
        assert len(pcm) > 0

    async def test_feed_collects_processed_without_denoiser(self):
        """Without denoiser, processed samples should still be collected
        when VAD detects speech."""
        from unittest.mock import MagicMock

        # Mock VAD that always returns speech
        vad_svc = MagicMock()
        vad_svc.is_loaded = True
        vad_svc.process_chunk = MagicMock(return_value=0.9)

        pp = StreamingPreprocessor(
            session_id="s1",
            sample_rate=16000,
            vad_service=vad_svc,
            threshold=0.5,
            min_speech_duration_ms=32,
        )

        t = np.linspace(0, 0.032, 512, endpoint=False)
        frame = (10000 * np.sin(2 * np.pi * 440 * t)).astype(np.int16)
        for _ in range(3):
            await pp.feed(frame.tobytes())

        pcm = pp.drain_processed_samples()
        assert len(pcm) > 0, "VAD-only preprocessor must collect processed samples during speech"
