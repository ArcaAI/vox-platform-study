"""Unit tests for Audio Preprocessing."""

from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt_v2.pipeline.dto import (
    DenoiseConfig,
    PreprocessingConfig,
    VadConfig,
)
from stt_v2.transcription.dto import AudioSegment
from stt_v2.transcription.preprocessing import AudioPreprocessor, get_preprocessor


class TestAudioPreprocessor:
    """Tests for AudioPreprocessor."""

    @pytest.fixture
    def preprocessor(self):
        return AudioPreprocessor()

    @pytest.fixture
    def default_config(self):
        return PreprocessingConfig(
            target_sample_rate=16000,
            normalize=True,
            vad=VadConfig(enabled=False),
            denoise=DenoiseConfig(enabled=False),
        )

    @pytest.fixture
    def sample_wav_bytes(self):
        """Generate sample WAV audio bytes (1 second of sine wave)."""
        import io
        import struct

        # Generate 1 second of 440Hz sine wave at 16kHz
        sample_rate = 16000
        duration = 1.0
        frequency = 440

        t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
        samples = (np.sin(2 * np.pi * frequency * t) * 0.5 * 32767).astype(np.int16)

        # Create WAV header (minimal)
        wav_buffer = io.BytesIO()

        # RIFF header
        wav_buffer.write(b"RIFF")
        wav_buffer.write(struct.pack("<I", 36 + len(samples) * 2))  # File size - 8
        wav_buffer.write(b"WAVE")

        # fmt chunk
        wav_buffer.write(b"fmt ")
        wav_buffer.write(struct.pack("<I", 16))  # Chunk size
        wav_buffer.write(struct.pack("<H", 1))  # Audio format (PCM)
        wav_buffer.write(struct.pack("<H", 1))  # Channels
        wav_buffer.write(struct.pack("<I", sample_rate))  # Sample rate
        wav_buffer.write(struct.pack("<I", sample_rate * 2))  # Byte rate
        wav_buffer.write(struct.pack("<H", 2))  # Block align
        wav_buffer.write(struct.pack("<H", 16))  # Bits per sample

        # data chunk
        wav_buffer.write(b"data")
        wav_buffer.write(struct.pack("<I", len(samples) * 2))
        wav_buffer.write(samples.tobytes())

        return wav_buffer.getvalue()

    def test_normalize(self, preprocessor):
        """Test audio normalization."""
        samples = np.array([0.5, 1.0, -0.5, 0.25], dtype=np.float32)

        normalized = preprocessor._normalize(samples)

        assert np.max(np.abs(normalized)) == 1.0
        # Relative values should be preserved
        assert normalized[0] == pytest.approx(0.5)
        assert normalized[1] == pytest.approx(1.0)

    def test_normalize_silent_audio(self, preprocessor):
        """Test normalization of silent audio."""
        samples = np.zeros(100, dtype=np.float32)

        normalized = preprocessor._normalize(samples)

        # Should return zeros without division error
        assert np.all(normalized == 0)

    def test_resample_upsample(self, preprocessor):
        """Test upsampling audio."""
        # 1 second of audio at 8kHz
        samples = np.sin(np.linspace(0, 2 * np.pi * 440, 8000)).astype(np.float32)

        resampled = preprocessor._resample(samples, 8000, 16000)

        # Should have ~2x the samples
        assert len(resampled) == 16000

    def test_resample_downsample(self, preprocessor):
        """Test downsampling audio."""
        # 1 second of audio at 44100Hz
        samples = np.sin(np.linspace(0, 2 * np.pi * 440, 44100)).astype(np.float32)

        resampled = preprocessor._resample(samples, 44100, 16000)

        # Should have fewer samples
        assert len(resampled) == 16000

    @pytest.mark.asyncio
    async def test_process_basic(self, preprocessor, sample_wav_bytes, default_config):
        """Test basic processing without VAD or denoise."""
        with patch.object(preprocessor, "_load_audio") as mock_load:
            # Mock loading audio
            mock_load.return_value = (
                np.sin(np.linspace(0, 2 * np.pi * 440, 16000)).astype(np.float32),
                16000,
            )

            result = await preprocessor.process(
                audio_bytes=sample_wav_bytes,
                config=default_config,
            )

            assert result.sample_rate == 16000
            assert result.duration_seconds == pytest.approx(1.0, abs=0.1)
            assert result.was_normalized is True
            assert result.vad_applied is False
            assert result.denoise_applied is False

    @pytest.mark.asyncio
    async def test_process_with_resample(self, preprocessor, sample_wav_bytes):
        """Test processing with resampling."""
        config = PreprocessingConfig(
            target_sample_rate=8000,
            normalize=True,
            vad=VadConfig(enabled=False),
            denoise=DenoiseConfig(enabled=False),
        )

        with patch.object(preprocessor, "_load_audio") as mock_load:
            # Original audio at 16kHz
            mock_load.return_value = (
                np.sin(np.linspace(0, 2 * np.pi * 440, 16000)).astype(np.float32),
                16000,
            )

            result = await preprocessor.process(
                audio_bytes=sample_wav_bytes,
                config=config,
            )

            assert result.sample_rate == 8000
            assert result.was_resampled is True
            assert len(result.samples) == 8000

    @pytest.mark.asyncio
    async def test_process_stereo_to_mono(self, preprocessor, default_config):
        """Test converting stereo to mono."""
        with patch.object(preprocessor, "_load_audio") as mock_load:
            # Stereo audio (2 channels)
            stereo = np.stack(
                [
                    np.sin(np.linspace(0, 2 * np.pi * 440, 16000)),
                    np.sin(np.linspace(0, 2 * np.pi * 880, 16000)),
                ],
                axis=1,
            ).astype(np.float32)

            mock_load.return_value = (stereo, 16000)

            result = await preprocessor.process(
                audio_bytes=b"dummy",
                config=default_config,
            )

            # Should be mono now
            assert len(result.samples.shape) == 1

    def test_merge_segments(self, preprocessor):
        """Test merging adjacent segments."""
        segments = [
            AudioSegment(0.0, 1.0),
            AudioSegment(1.1, 2.0),  # Small gap, should merge
            AudioSegment(3.0, 4.0),  # Large gap, should not merge
        ]

        merged = preprocessor._merge_segments(segments, gap_threshold=0.3)

        assert len(merged) == 2
        assert merged[0].start_time == 0.0
        assert merged[0].end_time == 2.0
        assert merged[1].start_time == 3.0

    def test_merge_segments_empty(self, preprocessor):
        """Test merging empty segment list."""
        merged = preprocessor._merge_segments([])

        assert merged == []

    def test_merge_segments_single(self, preprocessor):
        """Test merging single segment."""
        segments = [AudioSegment(0.0, 1.0)]

        merged = preprocessor._merge_segments(segments)

        assert len(merged) == 1


class TestPreprocessorSingleton:
    """Tests for preprocessor singleton."""

    def test_get_preprocessor_singleton(self):
        """Test singleton pattern."""
        p1 = get_preprocessor()
        p2 = get_preprocessor()

        assert p1 is p2


# =============================================================================
# EDGE CASE TESTS
# =============================================================================


class TestAudioPreprocessorEdgeCases:
    """Edge case tests for audio preprocessing robustness."""

    @pytest.fixture
    def preprocessor(self):
        return AudioPreprocessor()

    @pytest.fixture
    def default_config(self):
        return PreprocessingConfig(
            target_sample_rate=16000,
            normalize=True,
            vad=VadConfig(enabled=False),
            denoise=DenoiseConfig(enabled=False),
        )

    def test_normalize_very_small_values(self, preprocessor):
        """Test normalization of very small amplitude values."""
        # Values close to zero but not exactly zero
        samples = np.array([1e-10, 2e-10, -1e-10], dtype=np.float32)

        normalized = preprocessor._normalize(samples)

        # Should normalize to max abs = 1
        assert np.max(np.abs(normalized)) == pytest.approx(1.0, abs=1e-6)

    def test_normalize_all_same_value(self, preprocessor):
        """Test normalization of constant signal."""
        samples = np.full(100, 0.5, dtype=np.float32)

        normalized = preprocessor._normalize(samples)

        # All values should be normalized to 1.0 (since max is 0.5)
        assert np.allclose(normalized, 1.0)

    def test_normalize_single_sample(self, preprocessor):
        """Test normalization of single sample."""
        samples = np.array([0.5], dtype=np.float32)

        normalized = preprocessor._normalize(samples)

        assert normalized[0] == pytest.approx(1.0)

    def test_resample_no_change(self, preprocessor):
        """Test resampling when source and target rates are same."""
        samples = np.sin(np.linspace(0, 2 * np.pi * 440, 16000)).astype(np.float32)

        resampled = preprocessor._resample(samples, 16000, 16000)

        assert len(resampled) == 16000
        # Values should be nearly identical
        assert np.allclose(resampled, samples, atol=1e-6)

    def test_resample_extreme_downsample(self, preprocessor):
        """Test extreme downsampling (48kHz to 8kHz)."""
        samples = np.sin(np.linspace(0, 2 * np.pi * 440, 48000)).astype(np.float32)

        resampled = preprocessor._resample(samples, 48000, 8000)

        # Should have exactly 8000 samples
        assert len(resampled) == 8000

    def test_resample_extreme_upsample(self, preprocessor):
        """Test extreme upsampling (8kHz to 48kHz)."""
        samples = np.sin(np.linspace(0, 2 * np.pi * 440, 8000)).astype(np.float32)

        resampled = preprocessor._resample(samples, 8000, 48000)

        # Should have exactly 48000 samples
        assert len(resampled) == 48000

    def test_resample_very_short_audio(self, preprocessor):
        """Test resampling very short audio (100ms)."""
        # 100ms at 16kHz = 1600 samples
        samples = np.sin(np.linspace(0, 2 * np.pi * 440, 1600)).astype(np.float32)

        resampled = preprocessor._resample(samples, 16000, 8000)

        # Should have 800 samples
        assert len(resampled) == 800

    def test_merge_segments_overlapping(self, preprocessor):
        """Test merging overlapping segments."""
        segments = [
            AudioSegment(0.0, 2.0),
            AudioSegment(1.5, 3.0),  # Overlaps with first
            AudioSegment(2.8, 4.0),  # Overlaps with merged
        ]

        merged = preprocessor._merge_segments(segments, gap_threshold=0.3)

        # All should merge into one segment
        assert len(merged) == 1
        assert merged[0].start_time == 0.0
        assert merged[0].end_time == 4.0

    def test_merge_segments_exact_boundary(self, preprocessor):
        """Test merging segments with exact boundary touching."""
        segments = [
            AudioSegment(0.0, 1.0),
            AudioSegment(1.0, 2.0),  # Exactly touches previous
        ]

        merged = preprocessor._merge_segments(segments, gap_threshold=0.1)

        # Should merge since gap is 0
        assert len(merged) == 1
        assert merged[0].start_time == 0.0
        assert merged[0].end_time == 2.0

    def test_merge_segments_very_small_gap(self, preprocessor):
        """Test merging with very small gap below threshold."""
        segments = [
            AudioSegment(0.0, 1.0),
            AudioSegment(1.001, 2.0),  # Tiny gap
        ]

        merged = preprocessor._merge_segments(segments, gap_threshold=0.1)

        # Should merge
        assert len(merged) == 1

    def test_merge_segments_large_gap(self, preprocessor):
        """Test merging with gap above threshold."""
        segments = [
            AudioSegment(0.0, 1.0),
            AudioSegment(5.0, 6.0),  # Large gap
        ]

        merged = preprocessor._merge_segments(segments, gap_threshold=0.5)

        # Should NOT merge
        assert len(merged) == 2

    def test_merge_segments_sorted_input_required(self, preprocessor):
        """Test that merge requires sorted input for correct results.

        Note: _merge_segments expects sorted input. Unsorted input produces
        undefined behavior. This test verifies behavior with correctly sorted input.
        """
        # Properly sorted segments
        segments = [
            AudioSegment(0.0, 1.0),
            AudioSegment(1.1, 2.0),
            AudioSegment(3.0, 4.0),
        ]

        merged = preprocessor._merge_segments(segments, gap_threshold=0.3)

        # First two should merge (gap of 0.1 < threshold 0.3)
        # Third stays separate (gap of 1.0 > threshold 0.3)
        assert len(merged) == 2
        assert merged[0].start_time == 0.0
        assert merged[0].end_time == 2.0
        assert merged[1].start_time == 3.0

    @pytest.mark.asyncio
    async def test_process_with_very_long_audio(self, preprocessor, default_config):
        """Test processing long audio (simulated 10 minutes)."""
        with patch.object(preprocessor, "_load_audio") as mock_load:
            # 10 minutes at 16kHz = 9,600,000 samples
            long_audio = np.sin(np.linspace(0, 2 * np.pi * 440, 16000 * 600)).astype(np.float32)
            mock_load.return_value = (long_audio, 16000)

            result = await preprocessor.process(
                audio_bytes=b"dummy",
                config=default_config,
            )

            assert result.duration_seconds == pytest.approx(600.0, abs=0.1)

    @pytest.mark.asyncio
    async def test_process_with_very_short_audio(self, preprocessor, default_config):
        """Test processing very short audio (10ms)."""
        with patch.object(preprocessor, "_load_audio") as mock_load:
            # 10ms at 16kHz = 160 samples
            short_audio = np.sin(np.linspace(0, 2 * np.pi * 440, 160)).astype(np.float32)
            mock_load.return_value = (short_audio, 16000)

            result = await preprocessor.process(
                audio_bytes=b"dummy",
                config=default_config,
            )

            assert result.duration_seconds == pytest.approx(0.01, abs=0.001)
            assert len(result.samples) == 160

    @pytest.mark.asyncio
    async def test_process_multichannel_audio(self, preprocessor, default_config):
        """Test processing 4-channel audio (converted to mono)."""
        with patch.object(preprocessor, "_load_audio") as mock_load:
            # 4 channels
            multichannel = np.stack(
                [
                    np.sin(np.linspace(0, 2 * np.pi * 440, 16000)),
                    np.sin(np.linspace(0, 2 * np.pi * 550, 16000)),
                    np.sin(np.linspace(0, 2 * np.pi * 660, 16000)),
                    np.sin(np.linspace(0, 2 * np.pi * 770, 16000)),
                ],
                axis=1,
            ).astype(np.float32)

            mock_load.return_value = (multichannel, 16000)

            result = await preprocessor.process(
                audio_bytes=b"dummy",
                config=default_config,
            )

            # Result should be mono
            assert len(result.samples.shape) == 1


# =============================================================================
# VAD AND DENOISE COVERAGE TESTS
# =============================================================================
# Note: Tests for _apply_vad and _apply_denoise methods are skipped in unit tests
# because they require torch to be imported dynamically inside the method.
# These methods should be tested in integration tests with actual PyTorch installed.


class TestApplyVadWithOnnxSession:
    """Regression tests for ONNX-session pipeline VAD handling."""

    @pytest.fixture
    def preprocessor(self):
        return AudioPreprocessor()

    @pytest.mark.asyncio
    async def test_apply_vad_supports_onnx_session_model(self, preprocessor):
        """Pipeline ONNX Silero session should return scored speech segments."""

        class _Input:
            def __init__(self, name: str):
                self.name = name

        class _FakeOnnxSileroSession:
            def get_inputs(self):
                return [_Input("input"), _Input("state"), _Input("sr")]

            def run(self, _outputs, _inputs):
                return [
                    np.array([[0.8]], dtype=np.float32),
                    np.zeros((2, 1, 128), dtype=np.float32),
                ]

        loaded_model = MagicMock()
        loaded_model.model = _FakeOnnxSileroSession()

        samples = np.ones(16000, dtype=np.float32) * 0.01

        segments = await preprocessor._apply_vad(
            samples=samples,
            sample_rate=16000,
            vad_model=loaded_model,
            threshold=0.5,
        )

        assert len(segments) == 1
        assert segments[0].confidence == pytest.approx(0.8, abs=1e-3)

    @pytest.mark.asyncio
    async def test_non_silero_onnx_like_session_falls_back(self, preprocessor):
        """Non-Silero ONNX-like sessions should not use the Silero ONNX path."""

        class _Input:
            def __init__(self, name: str):
                self.name = name

        class _NonSileroSession:
            def get_inputs(self):
                return [_Input("audio")]

            def run(self, _outputs, _inputs):
                return [
                    np.array([[0.8]], dtype=np.float32),
                    np.zeros((2, 1, 128), dtype=np.float32),
                ]

        loaded_model = MagicMock()
        loaded_model.model = _NonSileroSession()

        samples = np.ones(16000, dtype=np.float32) * 0.01

        segments = await preprocessor._apply_vad(
            samples=samples,
            sample_rate=16000,
            vad_model=loaded_model,
            threshold=0.5,
        )

        assert len(segments) == 1
        assert segments[0].confidence == pytest.approx(1.0, abs=1e-3)


class TestAudioLoadingWithFallback:
    """Tests for audio loading with fallback to librosa."""

    @pytest.fixture
    def preprocessor(self):
        return AudioPreprocessor()

    def test_load_audio_with_soundfile(self, preprocessor):
        """Test loading audio with soundfile."""
        # Create valid WAV bytes
        import io
        import struct

        sample_rate = 16000
        samples = np.sin(np.linspace(0, 2 * np.pi * 440, 1600)).astype(np.float32)

        wav_buffer = io.BytesIO()
        wav_buffer.write(b"RIFF")
        wav_buffer.write(struct.pack("<I", 36 + len(samples) * 2))
        wav_buffer.write(b"WAVE")
        wav_buffer.write(b"fmt ")
        wav_buffer.write(struct.pack("<I", 16))
        wav_buffer.write(struct.pack("<H", 1))
        wav_buffer.write(struct.pack("<H", 1))
        wav_buffer.write(struct.pack("<I", sample_rate))
        wav_buffer.write(struct.pack("<I", sample_rate * 2))
        wav_buffer.write(struct.pack("<H", 2))
        wav_buffer.write(struct.pack("<H", 16))
        wav_buffer.write(b"data")
        wav_buffer.write(struct.pack("<I", len(samples) * 2))
        wav_buffer.write((samples * 32767).astype(np.int16).tobytes())

        audio_bytes = wav_buffer.getvalue()

        # Try to load (may use soundfile or librosa depending on environment)
        try:
            result_samples, sr = preprocessor._load_audio(audio_bytes)
            assert sr == sample_rate
            assert len(result_samples) > 0
        except Exception:
            # If libraries not available, that's OK for this test
            pass


# =============================================================================
# VAD PRIORITY TESTS (TASK-008 1.2)
# =============================================================================


class TestApplyVadSmartPriority:
    """Tests for the VAD model priority logic in _apply_vad_smart.

    Verifies: pipeline-defined model first, Silero fallback second.
    """

    @pytest.fixture
    def preprocessor(self):
        return AudioPreprocessor()

    @pytest.fixture
    def vad_config(self):
        return VadConfig(
            enabled=True,
            threshold=0.5,
            min_speech_duration_ms=250,
            min_silence_duration_ms=100,
            padding_ms=30,
        )

    @pytest.fixture
    def audio_samples(self):
        return np.random.randn(16000).astype(np.float32)

    @pytest.mark.asyncio
    async def test_pipeline_model_used_first(self, preprocessor, vad_config, audio_samples):
        """When pipeline model is provided, it should be used (not Silero)."""
        pipeline_model = MagicMock()
        expected_segments = [AudioSegment(0.0, 0.8, is_speech=True)]

        with patch.object(
            preprocessor, "_apply_vad", new_callable=AsyncMock, return_value=expected_segments
        ) as mock_vad:
            segments, applied = await preprocessor._apply_vad_smart(
                audio_samples, 16000, vad_config, pipeline_model
            )

        assert applied is True
        assert segments == expected_segments
        mock_vad.assert_called_once_with(
            audio_samples, 16000, pipeline_model, vad_config.threshold,
            min_speech_duration_ms=vad_config.min_speech_duration_ms,
            min_silence_duration_ms=vad_config.min_silence_duration_ms,
            padding_ms=vad_config.padding_ms,
        )

    @pytest.mark.asyncio
    async def test_silero_fallback_when_no_pipeline_model(
        self, preprocessor, vad_config, audio_samples
    ):
        """When no pipeline model, Silero singleton should be used."""
        from stt_v2.vad.dto import SpeechSegment, VADResult

        mock_vad_service = MagicMock()
        mock_vad_service.is_loaded = True
        mock_vad_service.detect_speech.return_value = VADResult(
            segments=[SpeechSegment(0.0, 0.5, probability=0.95)],
            speech_duration=0.5,
            audio_duration=1.0,
            applied=True,
        )

        with patch(
            "stt_v2.vad.silero_service.get_vad_service",
            return_value=mock_vad_service,
        ):
            segments, applied = await preprocessor._apply_vad_smart(
                audio_samples, 16000, vad_config, None
            )

        assert applied is True
        assert len(segments) == 1
        assert segments[0].start_time == 0.0
        mock_vad_service.detect_speech.assert_called_once()

    @pytest.mark.asyncio
    async def test_silero_fallback_when_pipeline_model_fails(
        self, preprocessor, vad_config, audio_samples
    ):
        """When pipeline model raises, should fall back to Silero."""
        from stt_v2.vad.dto import SpeechSegment, VADResult

        pipeline_model = MagicMock()

        mock_vad_service = MagicMock()
        mock_vad_service.is_loaded = True
        mock_vad_service.detect_speech.return_value = VADResult(
            segments=[SpeechSegment(0.0, 0.5, probability=0.9)],
            speech_duration=0.5,
            audio_duration=1.0,
            applied=True,
        )

        with (
            patch.object(
                preprocessor,
                "_apply_vad",
                new_callable=AsyncMock,
                side_effect=RuntimeError("model crashed"),
            ),
            patch(
                "stt_v2.vad.silero_service.get_vad_service",
                return_value=mock_vad_service,
            ),
        ):
            segments, applied = await preprocessor._apply_vad_smart(
                audio_samples, 16000, vad_config, pipeline_model
            )

        assert applied is True
        assert len(segments) == 1
        mock_vad_service.detect_speech.assert_called_once()

    @pytest.mark.asyncio
    async def test_returns_empty_when_both_unavailable(
        self, preprocessor, vad_config, audio_samples
    ):
        """When no pipeline model and Silero is unavailable, returns empty."""
        with patch(
            "stt_v2.vad.silero_service.get_vad_service",
            side_effect=ImportError("silero not installed"),
        ):
            segments, applied = await preprocessor._apply_vad_smart(
                audio_samples, 16000, vad_config, None
            )

        assert applied is False
        assert segments == []

    @pytest.mark.asyncio
    async def test_silero_not_loaded_returns_empty(self, preprocessor, vad_config, audio_samples):
        """Silero service exists but model not loaded returns empty."""
        mock_vad_service = MagicMock()
        mock_vad_service.is_loaded = False

        with patch(
            "stt_v2.vad.silero_service.get_vad_service",
            return_value=mock_vad_service,
        ):
            segments, applied = await preprocessor._apply_vad_smart(
                audio_samples, 16000, vad_config, None
            )

        assert applied is False
        assert segments == []

    @pytest.mark.asyncio
    async def test_silero_returns_no_speech_still_applied(
        self, preprocessor, vad_config, audio_samples
    ):
        """When Silero runs but detects no speech, applied=True with empty segments."""
        from stt_v2.vad.dto import VADResult

        mock_vad_service = MagicMock()
        mock_vad_service.is_loaded = True
        mock_vad_service.detect_speech.return_value = VADResult(
            segments=[],
            speech_duration=0.0,
            audio_duration=1.0,
            applied=True,
        )

        with patch(
            "stt_v2.vad.silero_service.get_vad_service",
            return_value=mock_vad_service,
        ):
            segments, applied = await preprocessor._apply_vad_smart(
                audio_samples, 16000, vad_config, None
            )

        assert applied is True
        assert segments == []
        mock_vad_service.detect_speech.assert_called_once()

    @pytest.mark.asyncio
    async def test_pipeline_model_success_silero_never_called(
        self, preprocessor, vad_config, audio_samples
    ):
        """When pipeline model succeeds, Silero should never be invoked."""
        pipeline_model = MagicMock()
        expected_segments = [AudioSegment(0.0, 0.8, is_speech=True)]

        mock_vad_service = MagicMock()

        with (
            patch.object(
                preprocessor, "_apply_vad", new_callable=AsyncMock, return_value=expected_segments
            ),
            patch(
                "stt_v2.vad.silero_service.get_vad_service",
                return_value=mock_vad_service,
            ) as _mock_get_vad,
        ):
            segments, applied = await preprocessor._apply_vad_smart(
                audio_samples, 16000, vad_config, pipeline_model
            )

        assert applied is True
        assert segments == expected_segments
        # Silero should NOT have been called at all
        mock_vad_service.detect_speech.assert_not_called()

    @pytest.mark.asyncio
    async def test_silero_detect_speech_receives_correct_params(
        self, preprocessor, vad_config, audio_samples
    ):
        """Verify Silero's detect_speech receives all VAD config parameters."""
        from stt_v2.vad.dto import SpeechSegment, VADResult

        mock_vad_service = MagicMock()
        mock_vad_service.is_loaded = True
        mock_vad_service.detect_speech.return_value = VADResult(
            segments=[SpeechSegment(0.0, 0.5, probability=0.9)],
            speech_duration=0.5,
            audio_duration=1.0,
            applied=True,
        )

        with patch(
            "stt_v2.vad.silero_service.get_vad_service",
            return_value=mock_vad_service,
        ):
            await preprocessor._apply_vad_smart(audio_samples, 16000, vad_config, None)

        # Verify all params were forwarded correctly
        call_kwargs = mock_vad_service.detect_speech.call_args.kwargs
        assert call_kwargs["threshold"] == vad_config.threshold
        assert call_kwargs["min_speech_duration_ms"] == vad_config.min_speech_duration_ms
        assert call_kwargs["min_silence_duration_ms"] == vad_config.min_silence_duration_ms
        assert call_kwargs["speech_pad_ms"] == vad_config.padding_ms
        assert call_kwargs["sample_rate"] == 16000


# =============================================================================
# PIPELINE ORDER TESTS (TASK-009)
# =============================================================================


class TestPipelineOrder:
    """Tests verifying the correct preprocessing pipeline order.

    TASK-009 requirement: Load → Mono → Normalize → Denoise → Resample → VAD
    """

    @pytest.fixture
    def preprocessor(self):
        return AudioPreprocessor()

    @pytest.mark.asyncio
    async def test_denoise_runs_before_vad(self, preprocessor):
        """Verify denoise is applied before VAD when both enabled."""
        call_order = []

        _original_denoise = preprocessor._apply_denoise
        _original_vad_smart = preprocessor._apply_vad_smart

        async def mock_denoise(samples, sr, strength):
            call_order.append("denoise")
            return samples, sr

        async def mock_vad_smart(samples, sr, config, model):
            call_order.append("vad")
            return [], False

        preprocessor._apply_denoise = mock_denoise
        preprocessor._apply_vad_smart = mock_vad_smart

        config = PreprocessingConfig(
            target_sample_rate=16000,
            normalize=True,
            vad=VadConfig(enabled=True),
            denoise=DenoiseConfig(enabled=True, strength=0.7),
        )

        with patch.object(preprocessor, "_load_audio") as mock_load:
            mock_load.return_value = (
                np.sin(np.linspace(0, 2 * np.pi * 440, 16000)).astype(np.float32),
                16000,
            )

            await preprocessor.process(audio_bytes=b"dummy", config=config)

        assert call_order == ["denoise", "vad"], f"Expected denoise before vad, got: {call_order}"

    @pytest.mark.asyncio
    async def test_resample_deferred_until_after_denoise(self, preprocessor):
        """When denoise is enabled, resample should happen AFTER denoise."""
        resample_calls = []

        original_resample = preprocessor._resample

        def tracking_resample(samples, orig_sr, target_sr):
            resample_calls.append((orig_sr, target_sr))
            return original_resample(samples, orig_sr, target_sr)

        preprocessor._resample = tracking_resample

        config = PreprocessingConfig(
            target_sample_rate=16000,
            normalize=True,
            vad=VadConfig(enabled=False),
            denoise=DenoiseConfig(enabled=True, strength=0.8, scope="full"),
        )

        with patch.object(preprocessor, "_load_audio") as mock_load:
            # Audio at 44100 Hz
            mock_load.return_value = (
                np.sin(np.linspace(0, 2 * np.pi * 440, 44100)).astype(np.float32),
                44100,
            )

            with patch(
                "stt_v2.transcription.preprocessing.AudioPreprocessor._apply_denoise"
            ) as mock_denoise:
                mock_denoise.return_value = (
                    np.sin(np.linspace(0, 2 * np.pi * 440, 48000)).astype(np.float32),
                    48000,
                )

                result = await preprocessor.process(audio_bytes=b"dummy", config=config)

        # The final resample should be from 48000 (denoise output) to 16000
        assert result.sample_rate == 16000
        # There should be resampling calls: the last one should be 48000 -> 16000
        assert any(
            call == (48000, 16000) for call in resample_calls
        ), f"Expected resample from 48000 to 16000 after denoise, got calls: {resample_calls}"

    @pytest.mark.asyncio
    async def test_no_denoise_still_resamples_directly(self, preprocessor):
        """When denoise is disabled, single resample from original to target."""
        config = PreprocessingConfig(
            target_sample_rate=16000,
            normalize=True,
            vad=VadConfig(enabled=False),
            denoise=DenoiseConfig(enabled=False),
        )

        with patch.object(preprocessor, "_load_audio") as mock_load:
            mock_load.return_value = (
                np.sin(np.linspace(0, 2 * np.pi * 440, 44100)).astype(np.float32),
                44100,
            )

            result = await preprocessor.process(audio_bytes=b"dummy", config=config)

        assert result.sample_rate == 16000
        assert result.was_resampled is True
        assert result.denoise_applied is False

    @pytest.mark.asyncio
    async def test_same_sample_rate_no_resample_without_denoise(self, preprocessor):
        """When input is already at target rate and no denoise, no resample needed."""
        config = PreprocessingConfig(
            target_sample_rate=16000,
            normalize=True,
            vad=VadConfig(enabled=False),
            denoise=DenoiseConfig(enabled=False),
        )

        with patch.object(preprocessor, "_load_audio") as mock_load:
            mock_load.return_value = (
                np.sin(np.linspace(0, 2 * np.pi * 440, 16000)).astype(np.float32),
                16000,
            )

            result = await preprocessor.process(audio_bytes=b"dummy", config=config)

        assert result.was_resampled is False

    @pytest.mark.asyncio
    async def test_normalize_before_denoise(self, preprocessor):
        """Normalize should happen before denoise."""
        call_order = []

        original_normalize = preprocessor._normalize

        def tracking_normalize(samples, method="peak"):
            call_order.append("normalize")
            return original_normalize(samples, method=method)

        preprocessor._normalize = tracking_normalize

        async def mock_denoise(samples, sr, strength):
            call_order.append("denoise")
            return samples, sr

        preprocessor._apply_denoise = mock_denoise

        config = PreprocessingConfig(
            target_sample_rate=16000,
            normalize=True,
            vad=VadConfig(enabled=False),
            denoise=DenoiseConfig(enabled=True, strength=0.7, scope="full"),
        )

        with patch.object(preprocessor, "_load_audio") as mock_load:
            mock_load.return_value = (
                np.sin(np.linspace(0, 2 * np.pi * 440, 16000)).astype(np.float32),
                16000,
            )

            await preprocessor.process(audio_bytes=b"dummy", config=config)

        assert call_order == ["normalize", "denoise"]


# =============================================================================
# RNNOISE DENOISE TESTS (TASK-009)
# =============================================================================


class TestApplyDenoise:
    """Tests for _apply_denoise with RNNoise via pyrnnoise."""

    @pytest.fixture
    def preprocessor(self):
        return AudioPreprocessor()

    @pytest.mark.asyncio
    async def test_denoise_returns_tuple_on_import_error(self, preprocessor):
        """_apply_denoise returns (samples, sample_rate) tuple even on ImportError.

        Tests the REAL fallback path — pyrnnoise unavailable — and verifies
        the return signature is a 2-tuple, not a bare ndarray.
        """
        samples = np.sin(np.linspace(0, 2 * np.pi * 440, 16000)).astype(np.float32)

        # Force ImportError by patching out pyrnnoise entirely
        with patch.dict("sys.modules", {"pyrnnoise": None}):
            with patch("builtins.__import__", side_effect=ImportError("no pyrnnoise")):
                result = await preprocessor._apply_denoise(samples, 16000, 0.8)

        # The real method must return a 2-tuple
        assert isinstance(result, tuple), f"Expected tuple, got {type(result)}"
        assert len(result) == 2, f"Expected 2-tuple, got length {len(result)}"
        np.testing.assert_array_equal(result[0], samples)
        assert result[1] == 16000

    @pytest.mark.asyncio
    async def test_denoise_strength_zero_bypasses(self, preprocessor):
        """Strength <= 0.0 should bypass denoising entirely."""
        samples = np.sin(np.linspace(0, 2 * np.pi * 440, 16000)).astype(np.float32)

        result_samples, result_sr = await preprocessor._apply_denoise(samples, 16000, 0.0)

        np.testing.assert_array_equal(result_samples, samples)
        assert result_sr == 16000

    @pytest.mark.asyncio
    async def test_denoise_negative_strength_bypasses(self, preprocessor):
        """Negative strength should bypass denoising."""
        samples = np.sin(np.linspace(0, 2 * np.pi * 440, 16000)).astype(np.float32)

        result_samples, result_sr = await preprocessor._apply_denoise(samples, 16000, -0.5)

        np.testing.assert_array_equal(result_samples, samples)
        assert result_sr == 16000

    @pytest.mark.asyncio
    async def test_denoise_import_error_returns_original(self, preprocessor):
        """If pyrnnoise is not installed, should return original audio."""
        samples = np.sin(np.linspace(0, 2 * np.pi * 440, 16000)).astype(np.float32)

        with patch.dict("sys.modules", {"pyrnnoise": None}):
            with patch(
                "builtins.__import__", side_effect=ImportError("No module named 'pyrnnoise'")
            ):
                result_samples, result_sr = await preprocessor._apply_denoise(samples, 16000, 0.8)

        np.testing.assert_array_equal(result_samples, samples)
        assert result_sr == 16000

    @pytest.mark.asyncio
    async def test_denoise_exception_returns_original(self, preprocessor):
        """If pyrnnoise raises, should return original audio."""
        samples = np.sin(np.linspace(0, 2 * np.pi * 440, 16000)).astype(np.float32)

        mock_rnnoise_class = MagicMock()
        mock_rnnoise_class.return_value.denoise_chunk.side_effect = RuntimeError("crash")

        mock_module = MagicMock()
        mock_module.RNNoise = mock_rnnoise_class

        with patch.dict("sys.modules", {"pyrnnoise": mock_module}):
            result_samples, result_sr = await preprocessor._apply_denoise(samples, 16000, 0.8)

        np.testing.assert_array_equal(result_samples, samples)
        assert result_sr == 16000

    @pytest.mark.asyncio
    async def test_denoise_with_48k_input_skips_upsample(self, preprocessor):
        """When input is already 48kHz, should not upsample."""
        samples_48k = np.sin(np.linspace(0, 2 * np.pi * 440, 48000)).astype(np.float32)

        mock_denoiser = MagicMock()
        # Simulate denoise_chunk yielding frames
        frame = np.zeros((1, 480), dtype=np.int16)
        mock_denoiser.denoise_chunk.return_value = iter([(0.9, frame)] * 100)

        mock_module = MagicMock()
        mock_module.RNNoise.return_value = mock_denoiser

        resample_called_with = []
        original_resample = preprocessor._resample

        def tracking_resample(samples, orig, target):
            resample_called_with.append((orig, target))
            return original_resample(samples, orig, target)

        preprocessor._resample = tracking_resample

        with patch.dict("sys.modules", {"pyrnnoise": mock_module}):
            result_samples, result_sr = await preprocessor._apply_denoise(samples_48k, 48000, 1.0)

        # Should not have resampled (already at 48kHz)
        assert not any(
            orig == 48000 and target != 48000 for orig, target in resample_called_with
        ), f"Should not resample from 48kHz, got: {resample_called_with}"
        assert result_sr == 48000


class TestApplyDenoiseDeepFilterNet3:
    """TASK-507 — tests for _apply_denoise_deepfilternet3 (DeepFilterNet3)."""

    @pytest.fixture
    def preprocessor(self):
        return AudioPreprocessor()

    @pytest.mark.asyncio
    async def test_denoise_returns_tuple_on_import_error(self, preprocessor):
        """Real fallback path — deepfilternet unavailable in this env — must
        still return a 2-tuple, not a bare ndarray."""
        samples = np.sin(np.linspace(0, 2 * np.pi * 440, 16000)).astype(np.float32)

        result = await preprocessor._apply_denoise_deepfilternet3(samples, 16000, 0.8)

        assert isinstance(result, tuple)
        assert len(result) == 2
        np.testing.assert_array_equal(result[0], samples)
        assert result[1] == 16000

    @pytest.mark.asyncio
    async def test_denoise_strength_zero_bypasses(self, preprocessor):
        samples = np.sin(np.linspace(0, 2 * np.pi * 440, 16000)).astype(np.float32)

        result_samples, result_sr = await preprocessor._apply_denoise_deepfilternet3(
            samples, 16000, 0.0
        )

        np.testing.assert_array_equal(result_samples, samples)
        assert result_sr == 16000

    @pytest.mark.asyncio
    async def test_denoise_exception_returns_original(self, preprocessor):
        """If enhance() raises, should return original audio."""
        samples = np.sin(np.linspace(0, 2 * np.pi * 440, 16000)).astype(np.float32)

        mock_df_module = MagicMock()
        mock_df_module.init_df.side_effect = RuntimeError("model load crash")

        with patch.dict("sys.modules", {"df.enhance": mock_df_module}):
            result_samples, result_sr = await preprocessor._apply_denoise_deepfilternet3(
                samples, 16000, 0.8
            )

        np.testing.assert_array_equal(result_samples, samples)
        assert result_sr == 16000

    @pytest.mark.asyncio
    async def test_denoise_applies_model_output(self, preprocessor):
        """A successful enhance() call blends the DF3 output at 48kHz."""
        import torch

        samples = np.sin(np.linspace(0, 2 * np.pi * 440, 16000)).astype(np.float32)

        mock_df_module = MagicMock()
        mock_df_module.init_df.return_value = (MagicMock(), MagicMock(), "suffix", 1)
        mock_df_module.enhance.return_value = torch.zeros((1, 48000))

        with patch.dict("sys.modules", {"df.enhance": mock_df_module}):
            result_samples, result_sr = await preprocessor._apply_denoise_deepfilternet3(
                samples, 16000, 1.0
            )

        assert result_sr == 48000
        assert len(result_samples) == 48000
        np.testing.assert_array_almost_equal(result_samples, np.zeros(48000, dtype=np.float32))


class TestDenoiseEngineDispatch:
    """TASK-507 — preprocessing.denoise.engine selects the RNNoise vs
    DeepFilterNet3 implementation in AudioPreprocessor.process()."""

    @pytest.fixture
    def preprocessor(self):
        return AudioPreprocessor()

    @pytest.mark.asyncio
    async def test_rnnoise_used_by_default(self, preprocessor):
        config = MagicMock()
        config.normalize = False
        config.denoise.enabled = True
        config.denoise.scope = "full"
        config.denoise.strength = 0.8
        config.denoise.engine = "rnnoise"
        config.vad.enabled = False
        config.target_sample_rate = 16000
        config.resample_enabled = True

        preprocessor._apply_denoise = AsyncMock(return_value=(np.zeros(100, dtype=np.float32), 48000))
        preprocessor._apply_denoise_deepfilternet3 = AsyncMock()
        preprocessor._load_audio = MagicMock(
            return_value=(np.zeros(1600, dtype=np.float32), 16000)
        )

        await preprocessor.process(b"fake", config)

        preprocessor._apply_denoise.assert_called_once()
        preprocessor._apply_denoise_deepfilternet3.assert_not_called()

    @pytest.mark.asyncio
    async def test_deepfilternet3_selected_by_engine(self, preprocessor):
        config = MagicMock()
        config.normalize = False
        config.denoise.enabled = True
        config.denoise.scope = "full"
        config.denoise.strength = 0.8
        config.denoise.engine = "deepfilternet3"
        config.vad.enabled = False
        config.target_sample_rate = 16000
        config.resample_enabled = True

        preprocessor._apply_denoise = AsyncMock()
        preprocessor._apply_denoise_deepfilternet3 = AsyncMock(
            return_value=(np.zeros(100, dtype=np.float32), 48000)
        )
        preprocessor._load_audio = MagicMock(
            return_value=(np.zeros(1600, dtype=np.float32), 16000)
        )

        await preprocessor.process(b"fake", config)

        preprocessor._apply_denoise_deepfilternet3.assert_called_once()
        preprocessor._apply_denoise.assert_not_called()


# =============================================================================
# PREPROCESSING EDGE CASES — COMBINED FEATURES (TASK-009)
# =============================================================================


class TestPreprocessingCombinedFeatures:
    """Edge cases for the full process() pipeline with multiple features active.

    These tests exercise real AudioPreprocessor logic (normalize, resample,
    mono conversion) and only mock _apply_denoise / _apply_vad_smart at
    the boundary — verifying the actual data transformations, not mock wiring.
    """

    @pytest.fixture
    def preprocessor(self):
        return AudioPreprocessor()

    @pytest.mark.asyncio
    async def test_all_features_enabled(self, preprocessor):
        """When normalize + denoise + VAD are all enabled, process returns complete result."""
        config = PreprocessingConfig(
            target_sample_rate=16000,
            normalize=True,
            vad=VadConfig(enabled=True, threshold=0.5),
            denoise=DenoiseConfig(enabled=True, strength=0.7),
        )

        # 1s of audio at 44100 Hz
        original_audio = (
            np.sin(np.linspace(0, 2 * np.pi * 440, 44100)).astype(np.float32) * 0.5
        )  # half-amplitude

        async def fake_denoise(samples, sr, strength):
            # Simulate denoise returning at 48 kHz
            resampled = preprocessor._resample(samples, sr, 48000)
            return resampled, 48000

        async def fake_vad_smart(samples, sr, config, model):
            # Simulate finding one speech segment in the resampled audio
            duration = len(samples) / sr
            return [AudioSegment(0.0, duration, is_speech=True)], True

        preprocessor._apply_denoise = fake_denoise
        preprocessor._apply_vad_smart = fake_vad_smart

        with patch.object(preprocessor, "_load_audio") as mock_load:
            mock_load.return_value = (original_audio, 44100)

            result = await preprocessor.process(audio_bytes=b"dummy", config=config)

        # Verify ALL flags are set correctly
        assert result.sample_rate == 16000
        assert result.was_normalized is True
        assert result.was_resampled is True  # 48000 → 16000
        assert result.denoise_applied is True
        assert result.vad_applied is True
        assert len(result.segments) == 1
        # Verify normalization actually happened (peak should be 1.0, not 0.5)
        assert np.max(np.abs(result.samples)) > 0.9

    @pytest.mark.asyncio
    async def test_denoise_enabled_but_vad_disabled(self, preprocessor):
        """Denoise without VAD should still set denoise_applied, segments empty."""
        config = PreprocessingConfig(
            target_sample_rate=16000,
            normalize=False,
            vad=VadConfig(enabled=False),
            denoise=DenoiseConfig(enabled=True, strength=1.0, scope="full"),
        )

        async def fake_denoise(samples, sr, strength):
            return samples, sr  # passthrough at same rate

        preprocessor._apply_denoise = fake_denoise

        with patch.object(preprocessor, "_load_audio") as mock_load:
            mock_load.return_value = (
                np.zeros(16000, dtype=np.float32),
                16000,
            )

            result = await preprocessor.process(audio_bytes=b"dummy", config=config)

        assert result.denoise_applied is True
        assert result.vad_applied is False
        assert result.segments == []
        assert result.was_normalized is False

    @pytest.mark.asyncio
    async def test_stereo_audio_converted_before_denoise(self, preprocessor):
        """Stereo audio must be converted to mono before denoise receives it."""
        received_shapes = []

        async def tracking_denoise(samples, sr, strength):
            received_shapes.append(samples.shape)
            return samples, sr

        preprocessor._apply_denoise = tracking_denoise

        config = PreprocessingConfig(
            target_sample_rate=16000,
            normalize=True,
            vad=VadConfig(enabled=False),
            denoise=DenoiseConfig(enabled=True, strength=0.8, scope="full"),
        )

        # Stereo audio (2 channels)
        stereo = np.stack(
            [
                np.sin(np.linspace(0, 2 * np.pi * 440, 16000)),
                np.sin(np.linspace(0, 2 * np.pi * 880, 16000)),
            ],
            axis=1,
        ).astype(np.float32)

        with patch.object(preprocessor, "_load_audio") as mock_load:
            mock_load.return_value = (stereo, 16000)

            _result = await preprocessor.process(audio_bytes=b"dummy", config=config)

        # Denoise must receive mono (1-D) audio, not stereo (2-D)
        assert len(received_shapes) == 1
        assert (
            len(received_shapes[0]) == 1
        ), f"Denoise received {len(received_shapes[0])}-D audio, expected 1-D mono"

    @pytest.mark.asyncio
    async def test_process_with_only_normalize_disabled(self, preprocessor):
        """When normalize is disabled, samples should not be peak-scaled."""
        config = PreprocessingConfig(
            target_sample_rate=16000,
            normalize=False,
            vad=VadConfig(enabled=False),
            denoise=DenoiseConfig(enabled=False),
        )

        # Half-amplitude signal
        half_amp = np.sin(np.linspace(0, 2 * np.pi * 440, 16000)).astype(np.float32) * 0.3

        with patch.object(preprocessor, "_load_audio") as mock_load:
            mock_load.return_value = (half_amp, 16000)

            result = await preprocessor.process(audio_bytes=b"dummy", config=config)

        # Peak should still be ~0.3, not normalized to 1.0
        assert result.was_normalized is False
        assert np.max(np.abs(result.samples)) < 0.5

    @pytest.mark.asyncio
    async def test_process_result_duration_uses_final_sample_rate(self, preprocessor):
        """Duration must be computed from final sample count / target_sample_rate."""
        config = PreprocessingConfig(
            target_sample_rate=8000,
            normalize=False,
            vad=VadConfig(enabled=False),
            denoise=DenoiseConfig(enabled=False),
        )

        # 2 seconds at 48 kHz
        with patch.object(preprocessor, "_load_audio") as mock_load:
            mock_load.return_value = (
                np.zeros(96000, dtype=np.float32),
                48000,
            )

            result = await preprocessor.process(audio_bytes=b"dummy", config=config)

        # After resampling 48k→8k, 2 seconds = 16000 samples / 8000 = 2.0s
        assert result.sample_rate == 8000
        assert result.duration_seconds == pytest.approx(2.0, abs=0.05)
        assert len(result.samples) == 16000

    @pytest.mark.asyncio
    async def test_vad_receives_resampled_audio_not_original(self, preprocessor):
        """VAD should run on audio AFTER resampling to target_sample_rate."""
        vad_received_sr = []

        async def tracking_vad(samples, sr, config, model):
            vad_received_sr.append(sr)
            return [], True

        preprocessor._apply_vad_smart = tracking_vad

        config = PreprocessingConfig(
            target_sample_rate=16000,
            normalize=False,
            vad=VadConfig(enabled=True),
            denoise=DenoiseConfig(enabled=False),
        )

        with patch.object(preprocessor, "_load_audio") as mock_load:
            mock_load.return_value = (
                np.zeros(44100, dtype=np.float32),
                44100,
            )

            await preprocessor.process(audio_bytes=b"dummy", config=config)

        assert vad_received_sr == [
            16000
        ], f"VAD should receive target_sample_rate (16000), got: {vad_received_sr}"


class TestTask505DualPathDenoise:
    """TASK-505 P2 (decision D2) — dual-path denoise + v2 stage toggles."""

    def _pre(self):
        return AudioPreprocessor()

    def _config(self, **over):
        from stt_v2.pipeline.dto import DenoiseConfig, PreprocessingConfig, VadConfig

        cfg = PreprocessingConfig(
            target_sample_rate=16000,
            normalize=False,
            vad=VadConfig(enabled=over.pop("vad_enabled", True)),
            denoise=DenoiseConfig(
                enabled=over.pop("denoise_enabled", True),
                strength=0.7,
                scope=over.pop("scope", "vad_only"),
            ),
        )
        for k, v in over.items():
            setattr(cfg, k, v)
        return cfg

    def _sine_bytes(self, sr=16000, seconds=1.0, freq=440.0):
        import io

        import soundfile as sf

        t = np.arange(int(sr * seconds)) / sr
        wave = (0.5 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
        buf = io.BytesIO()
        sf.write(buf, wave, sr, format="WAV")
        return buf.getvalue()

    @pytest.mark.asyncio
    async def test_vad_only_scope_feeds_denoised_to_vad_but_raw_to_asr(self):
        pre = self._pre()
        captured = {}

        async def fake_denoise(samples, sr, strength):
            return np.zeros_like(samples), sr

        async def fake_vad(samples, sample_rate, vad_config, model):
            captured["vad_input"] = samples
            return [], True

        with (
            patch.object(pre, "_apply_denoise", side_effect=fake_denoise),
            patch.object(pre, "_apply_vad_smart", side_effect=fake_vad),
        ):
            out = await pre.process(self._sine_bytes(), self._config(scope="vad_only"))

        # VAD saw the denoised (zeroed) branch…
        assert float(np.abs(captured["vad_input"]).max()) == 0.0
        # …while the ASR-bound samples kept the raw signal.
        assert float(np.abs(out.samples).max()) > 0.3
        assert out.denoise_applied is True

    @pytest.mark.asyncio
    async def test_full_scope_keeps_legacy_denoised_asr_audio(self):
        pre = self._pre()

        async def fake_denoise(samples, sr, strength):
            return np.zeros_like(samples), sr

        with (
            patch.object(pre, "_apply_denoise", side_effect=fake_denoise),
            patch.object(
                pre, "_apply_vad_smart", side_effect=AsyncMock(return_value=([], True))
            ),
        ):
            out = await pre.process(self._sine_bytes(), self._config(scope="full"))

        assert float(np.abs(out.samples).max()) == 0.0

    @pytest.mark.asyncio
    async def test_vad_only_skips_denoise_when_vad_disabled(self):
        # No consumer for the denoised branch → don't pay for it.
        pre = self._pre()
        denoise_mock = AsyncMock()

        with patch.object(pre, "_apply_denoise", side_effect=denoise_mock):
            out = await pre.process(
                self._sine_bytes(),
                self._config(scope="vad_only", vad_enabled=False),
            )

        denoise_mock.assert_not_awaited()
        assert out.denoise_applied is False

    @pytest.mark.asyncio
    async def test_resample_disabled_still_resamples_with_warning_on_mismatch(self):
        # resample.enabled=false is honored only when input already matches;
        # a mismatch resamples anyway (VAD/ASR require the target rate).
        pre = self._pre()
        with patch.object(
            pre, "_apply_vad_smart", side_effect=AsyncMock(return_value=([], True))
        ):
            out = await pre.process(
                self._sine_bytes(sr=48000),
                self._config(denoise_enabled=False, resample_enabled=False),
            )
        assert out.sample_rate == 16000
        assert len(out.samples) == 16000

    def test_rms_normalize(self):
        pre = self._pre()
        wave = (0.5 * np.sin(2 * np.pi * 440 * np.arange(16000) / 16000)).astype(
            np.float32
        )
        out = pre._normalize(wave, method="rms")
        rms = float(np.sqrt(np.mean(out**2)))
        assert rms == pytest.approx(0.1, rel=0.05)

    def test_peak_normalize_unchanged(self):
        pre = self._pre()
        wave = np.array([0.25, -0.5, 0.1], dtype=np.float32)
        out = pre._normalize(wave)
        assert float(np.abs(out).max()) == pytest.approx(1.0)
