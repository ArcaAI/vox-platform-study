"""Unit tests for speaker diarization module."""

import sys
import threading
import warnings
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt_v2.diarization.dto import (
    DiarizationResult,
    DiarizedSegment,
    SpeakerEmbedding,
    SpeakerIdentification,
)
from stt_v2.diarization.pyannote_embedding import PyannoteEmbeddingService

try:
    import pyannote.audio  # noqa: F401

    HAS_PYANNOTE = True
except ImportError:
    HAS_PYANNOTE = False

requires_pyannote = pytest.mark.skipif(not HAS_PYANNOTE, reason="pyannote not installed")


def _make_mock_torch():
    """Create a mock torch module for tests that don't need real torch.

    ``from_numpy(arr).float().unsqueeze(0)`` returns a MagicMock whose
    ``.shape`` equals ``(1, len(arr))`` so that tensor-shape assertions work.
    """
    mock = MagicMock()

    def _from_numpy(arr):
        tensor = MagicMock(name="waveform_tensor")
        tensor.shape = (1, len(arr))
        tensor.float.return_value = tensor
        tensor.unsqueeze.return_value = tensor
        return tensor

    mock.from_numpy = MagicMock(side_effect=_from_numpy)
    return mock


# =============================================================================
# DTO Tests
# =============================================================================


class TestSpeakerEmbeddingDTO:
    def test_dimension(self):
        emb = SpeakerEmbedding(embedding=[0.1] * 256)
        assert emb.dimension == 256

    def test_segment_times(self):
        emb = SpeakerEmbedding(embedding=[0.0], segment_start=1.5, segment_end=3.0)
        assert emb.segment_start == 1.5
        assert emb.segment_end == 3.0


class TestSpeakerIdentificationDTO:
    def test_is_known_true(self):
        ident = SpeakerIdentification(speaker_id="spk-1", is_new_speaker=False)
        assert ident.is_known is True

    def test_is_known_false_for_new(self):
        ident = SpeakerIdentification(speaker_id="spk-1", is_new_speaker=True)
        assert ident.is_known is False


class TestDiarizedSegmentDTO:
    def test_duration(self):
        seg = DiarizedSegment(text="hi", start_time=1.0, end_time=3.5)
        assert seg.duration == 2.5


class TestDiarizationResultDTO:
    def test_get_speaker_ids(self):
        result = DiarizationResult(
            segments=[
                DiarizedSegment(text="a", start_time=0, end_time=1, speaker_id="spk-1"),
                DiarizedSegment(text="b", start_time=1, end_time=2, speaker_id="spk-2"),
                DiarizedSegment(text="c", start_time=2, end_time=3, speaker_id="spk-1"),
            ],
            applied=True,
        )
        ids = result.get_speaker_ids()
        assert set(ids) == {"spk-1", "spk-2"}

    def test_get_speaker_ids_excludes_none(self):
        result = DiarizationResult(
            segments=[
                DiarizedSegment(text="a", start_time=0, end_time=1, speaker_id="spk-1"),
                DiarizedSegment(text="b", start_time=1, end_time=2, speaker_id=None),
            ],
        )
        assert result.get_speaker_ids() == ["spk-1"]


# =============================================================================
# EmbeddingService Tests — direct state injection
# =============================================================================


class TestEmbeddingService:
    async def test_extract_from_samples(self):
        """Verify extraction returns a 256-dim embedding."""
        service = PyannoteEmbeddingService()
        mock_inference = MagicMock()
        mock_inference.return_value = np.array([[0.1] * 256], dtype=np.float32)

        service._inference = mock_inference
        service._loaded = True
        service._lock = threading.Lock()

        samples = np.random.randn(16000).astype(np.float32)
        with patch.dict(sys.modules, {"torch": _make_mock_torch()}):
            embedding = await service.extract_from_samples(samples, sample_rate=16000)

        assert embedding.dimension == 256
        assert embedding.segment_start == 0.0
        assert embedding.segment_end == pytest.approx(1.0, rel=0.01)

    async def test_extract_lazily_initializes_on_first_use(self, mocker):
        """Extraction lazily loads the model on first use instead of
        raising when not yet initialized."""
        service = PyannoteEmbeddingService()
        init_spy = mocker.patch.object(service, "initialize", new_callable=AsyncMock)
        mocker.patch.object(service, "_extract_sync", return_value=[0.0] * 8)

        await service.extract_from_samples(np.zeros(16000, dtype=np.float32))

        init_spy.assert_awaited_once()

    async def test_extract_from_segments_skips_short(self):
        """Segments shorter than 1 second should be skipped."""
        service = PyannoteEmbeddingService()
        mock_inference = MagicMock()
        mock_inference.return_value = np.array([[0.1] * 256], dtype=np.float32)

        service._inference = mock_inference
        service._loaded = True
        service._lock = threading.Lock()

        samples = np.random.randn(80000).astype(np.float32)
        segments = [
            (0.0, 0.5),  # 0.5s — should be skipped
            (1.0, 3.0),  # 2s — should be processed
        ]
        with patch.dict(sys.modules, {"torch": _make_mock_torch()}):
            embeddings = await service.extract_from_segments(samples, 16000, segments)
        assert len(embeddings) == 1

    async def test_shutdown(self):
        service = PyannoteEmbeddingService()
        service._loaded = True
        service._inference = MagicMock()

        await service.shutdown()

        assert service._loaded is False
        assert service._inference is None


# =============================================================================
# EmbeddingService — hf_model_id override & batch extraction
# =============================================================================


class TestEmbeddingServicePipelineOverride:
    """Tests for the hf_model_id pipeline override feature."""

    def test_default_hf_model_id_is_none(self):
        """Default constructor should have no pipeline override."""
        svc = PyannoteEmbeddingService()
        assert svc._hf_model_id is None

    def test_custom_hf_model_id_stored(self):
        """Constructor with hf_model_id should store the override."""
        svc = PyannoteEmbeddingService(hf_model_id="custom/embedding-v2")
        assert svc._hf_model_id == "custom/embedding-v2"


@requires_pyannote
class TestEmbeddingServicePyannoteWarnings:
    """Tests for pyannote import warning handling."""

    def test_pyannote_import_suppresses_torchcodec_warning(self):
        with warnings.catch_warnings(record=True) as seen:
            warnings.simplefilter("always")
            with warnings.catch_warnings():
                warnings.filterwarnings(
                    "ignore",
                    message=r"(?s).*torchcodec is not installed correctly.*",
                    category=UserWarning,
                )
                import pyannote.audio  # noqa: F401

        messages = [str(w.message) for w in seen]
        torchcodec_warnings = [
            msg
            for msg in messages
            if "torchcodec is not installed correctly so built-in audio decoding will fail" in msg
        ]
        assert torchcodec_warnings == []


@patch.dict(sys.modules, {"torch": _make_mock_torch()})
class TestEmbeddingServiceBatch:
    """Tests for extract_batch method."""

    async def test_extract_batch_returns_embeddings(self):
        """Batch extraction should return one embedding per segment."""
        svc = PyannoteEmbeddingService()
        mock_inference = MagicMock()
        mock_inference.return_value = np.array([[0.5] * 256], dtype=np.float32)
        svc._inference = mock_inference
        svc._loaded = True
        svc._lock = threading.Lock()

        segment_samples = [
            np.random.randn(16000).astype(np.float32),
            np.random.randn(24000).astype(np.float32),
        ]
        times = [(0.0, 1.0), (1.0, 2.5)]

        results = await svc.extract_batch(segment_samples, 16000, times)

        assert len(results) == 2
        assert results[0] is not None
        assert results[0].dimension == 256
        assert results[0].segment_start == 0.0
        assert results[0].segment_end == 1.0
        assert results[1].segment_start == 1.0
        assert results[1].segment_end == 2.5

    async def test_extract_batch_lazily_initializes_on_first_use(self, mocker):
        """Batch extraction lazily loads the model on first use
        instead of raising when not yet initialized."""
        svc = PyannoteEmbeddingService()
        init_spy = mocker.patch.object(svc, "initialize", new_callable=AsyncMock)
        mocker.patch.object(svc, "_extract_batch_sync", return_value=[[0.0] * 8])

        await svc.extract_batch([np.zeros(16000, dtype=np.float32)], 16000, [(0.0, 1.0)])

        init_spy.assert_awaited_once()

    async def test_extract_batch_partial_failure_returns_none(self):
        """If inference fails for one segment, that entry should be None."""
        svc = PyannoteEmbeddingService()
        call_count = 0

        def side_effect_fn(input_dict):
            nonlocal call_count
            call_count += 1
            if call_count == 2:
                raise RuntimeError("inference failed")
            return np.array([[0.1] * 256], dtype=np.float32)

        mock_inference = MagicMock(side_effect=side_effect_fn)
        svc._inference = mock_inference
        svc._loaded = True
        svc._lock = threading.Lock()

        segment_samples = [
            np.random.randn(16000).astype(np.float32),
            np.random.randn(16000).astype(np.float32),  # This one will fail
            np.random.randn(16000).astype(np.float32),
        ]
        times = [(0.0, 1.0), (1.0, 2.0), (2.0, 3.0)]

        results = await svc.extract_batch(segment_samples, 16000, times)

        assert len(results) == 3
        assert results[0] is not None
        assert results[1] is None  # Failed
        assert results[2] is not None

    async def test_extract_batch_empty_input(self):
        """Empty segment list should return empty result."""
        svc = PyannoteEmbeddingService()
        svc._loaded = True
        svc._inference = MagicMock()
        svc._lock = threading.Lock()

        results = await svc.extract_batch([], 16000, [])
        assert results == []

    async def test_extract_batch_verifies_tensor_shape(self):
        """Inference should receive waveform tensor of shape (1, num_samples)."""
        svc = PyannoteEmbeddingService()

        captured_inputs: list[dict] = []

        def capture_inference(input_dict):
            captured_inputs.append(input_dict)
            return np.array([[0.1] * 256], dtype=np.float32)

        svc._inference = MagicMock(side_effect=capture_inference)
        svc._loaded = True
        svc._lock = threading.Lock()

        samples_16k = np.random.randn(16000).astype(np.float32)
        samples_24k = np.random.randn(24000).astype(np.float32)
        await svc.extract_batch([samples_16k, samples_24k], 16000, [(0.0, 1.0), (1.0, 2.5)])

        assert len(captured_inputs) == 2
        # Check waveform shape: (1, num_samples)
        assert captured_inputs[0]["waveform"].shape == (1, 16000)
        assert captured_inputs[1]["waveform"].shape == (1, 24000)
        # Check sample_rate is passed through
        assert captured_inputs[0]["sample_rate"] == 16000
        assert captured_inputs[1]["sample_rate"] == 16000
