"""Unit tests for speaker diarization module."""

import sys
import threading
import warnings
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from stt_v2.core.exceptions import EmbeddingExtractionError, SpeakerIdentificationError
from stt_v2.diarization.dto import (
    DiarizationResult,
    DiarizedSegment,
    SpeakerEmbedding,
    SpeakerIdentification,
)
from stt_v2.diarization.embedding_service import EmbeddingService
from stt_v2.diarization.speaker_identifier import SpeakerIdentifier
from stt_v2.pipeline.dto import DiarizationConfig

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
        emb = SpeakerEmbedding(embedding=[0.1] * 512)
        assert emb.dimension == 512

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
        """Verify extraction returns a 512-dim embedding."""
        service = EmbeddingService()
        mock_inference = MagicMock()
        mock_inference.return_value = np.array([[0.1] * 512], dtype=np.float32)

        service._inference = mock_inference
        service._loaded = True
        service._lock = threading.Lock()

        samples = np.random.randn(16000).astype(np.float32)
        with patch.dict(sys.modules, {"torch": _make_mock_torch()}):
            embedding = await service.extract_from_samples(samples, sample_rate=16000)

        assert embedding.dimension == 512
        assert embedding.segment_start == 0.0
        assert embedding.segment_end == pytest.approx(1.0, rel=0.01)

    async def test_extract_not_loaded_raises(self):
        service = EmbeddingService()
        with pytest.raises(Exception, match="not initialised"):
            await service.extract_from_samples(np.zeros(16000, dtype=np.float32))

    async def test_extract_from_segments_skips_short(self):
        """Segments shorter than 1 second should be skipped."""
        service = EmbeddingService()
        mock_inference = MagicMock()
        mock_inference.return_value = np.array([[0.1] * 512], dtype=np.float32)

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
        service = EmbeddingService()
        service._loaded = True
        service._model = MagicMock()
        service._inference = MagicMock()

        await service.shutdown()

        assert service._loaded is False
        assert service._model is None
        assert service._inference is None


# =============================================================================
# EmbeddingService — hf_model_id override & batch extraction
# =============================================================================


class TestEmbeddingServicePipelineOverride:
    """Tests for the hf_model_id pipeline override feature (TASK-008 1.3)."""

    def test_default_hf_model_id_is_none(self):
        """Default constructor should have no pipeline override."""
        svc = EmbeddingService()
        assert svc._hf_model_id is None

    def test_custom_hf_model_id_stored(self):
        """Constructor with hf_model_id should store the override."""
        svc = EmbeddingService(hf_model_id="custom/embedding-v2")
        assert svc._hf_model_id == "custom/embedding-v2"


@requires_pyannote
class TestEmbeddingServicePyannoteWarnings:
    """Tests for pyannote import warning handling."""

    def test_import_pyannote_audio_suppresses_torchcodec_warning(self):
        with warnings.catch_warnings(record=True) as seen:
            warnings.simplefilter("always")
            EmbeddingService._import_pyannote_audio()

        messages = [str(w.message) for w in seen]
        torchcodec_warnings = [
            msg
            for msg in messages
            if "torchcodec is not installed correctly so built-in audio decoding will fail"
            in msg
        ]
        assert torchcodec_warnings == []


@patch.dict(sys.modules, {"torch": _make_mock_torch()})
class TestEmbeddingServiceBatch:
    """Tests for extract_batch method (TASK-008 3.2)."""

    async def test_extract_batch_returns_embeddings(self):
        """Batch extraction should return one embedding per segment."""
        svc = EmbeddingService()
        mock_inference = MagicMock()
        mock_inference.return_value = np.array([[0.5] * 512], dtype=np.float32)
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
        assert results[0].dimension == 512
        assert results[0].segment_start == 0.0
        assert results[0].segment_end == 1.0
        assert results[1].segment_start == 1.0
        assert results[1].segment_end == 2.5

    async def test_extract_batch_not_loaded_raises(self):
        """Batch extraction on uninitialized service should raise."""
        svc = EmbeddingService()
        with pytest.raises(EmbeddingExtractionError, match="not initialised"):
            await svc.extract_batch(
                [np.zeros(16000, dtype=np.float32)], 16000, [(0.0, 1.0)]
            )

    async def test_extract_batch_partial_failure_returns_none(self):
        """If inference fails for one segment, that entry should be None."""
        svc = EmbeddingService()
        call_count = 0

        def side_effect_fn(input_dict):
            nonlocal call_count
            call_count += 1
            if call_count == 2:
                raise RuntimeError("inference failed")
            return np.array([[0.1] * 512], dtype=np.float32)

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
        svc = EmbeddingService()
        svc._loaded = True
        svc._inference = MagicMock()
        svc._lock = threading.Lock()

        results = await svc.extract_batch([], 16000, [])
        assert results == []

    async def test_extract_batch_verifies_tensor_shape(self):
        """Inference should receive waveform tensor of shape (1, num_samples)."""
        svc = EmbeddingService()

        captured_inputs: list[dict] = []

        def capture_inference(input_dict):
            captured_inputs.append(input_dict)
            return np.array([[0.1] * 512], dtype=np.float32)

        svc._inference = MagicMock(side_effect=capture_inference)
        svc._loaded = True
        svc._lock = threading.Lock()

        samples_16k = np.random.randn(16000).astype(np.float32)
        samples_24k = np.random.randn(24000).astype(np.float32)
        await svc.extract_batch(
            [samples_16k, samples_24k], 16000, [(0.0, 1.0), (1.0, 2.5)]
        )

        assert len(captured_inputs) == 2
        # Check waveform shape: (1, num_samples)
        assert captured_inputs[0]["waveform"].shape == (1, 16000)
        assert captured_inputs[1]["waveform"].shape == (1, 24000)
        # Check sample_rate is passed through
        assert captured_inputs[0]["sample_rate"] == 16000
        assert captured_inputs[1]["sample_rate"] == 16000


# =============================================================================
# SpeakerIdentifier Tests — mock both sub-services
# =============================================================================


def _make_mock_services():
    """Create mocked embedding service and speaker store."""
    mock_emb = AsyncMock(spec=EmbeddingService)
    mock_emb.is_loaded = True
    mock_emb.extract_from_samples = AsyncMock(
        return_value=SpeakerEmbedding(embedding=[0.1] * 512, segment_start=0.0, segment_end=1.0)
    )
    # Batch extraction — returns one SpeakerEmbedding per segment by default
    mock_emb.extract_batch = AsyncMock(
        side_effect=lambda segs, sr, times: [
            SpeakerEmbedding(embedding=[0.1] * 512, segment_start=t[0], segment_end=t[1])
            for t in times
        ]
    )

    mock_store = AsyncMock()
    mock_store.search_similar = AsyncMock(return_value=[])
    mock_store.upsert_embedding = AsyncMock(return_value="point-123")
    mock_store.ensure_collection = AsyncMock()

    return mock_emb, mock_store


class TestSpeakerIdentifier:
    async def test_identify_known_speaker(self):
        mock_emb, mock_store = _make_mock_services()
        mock_store.search_similar.return_value = [
            {"speaker_id": "spk-1", "score": 0.85, "point_id": "pt-1", "payload": {}}
        ]

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        result = await identifier.identify_speaker(
            samples=np.zeros(16000, dtype=np.float32),
            sample_rate=16000,
            tenant_id="t1",
        )

        assert result.speaker_id == "spk-1"
        assert result.confidence == 0.85
        assert result.is_new_speaker is False

    async def test_identify_new_speaker_auto_register(self):
        mock_emb, mock_store = _make_mock_services()

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(enabled=True, auto_register_speakers=True)
        result = await identifier.identify_speaker(
            samples=np.zeros(16000, dtype=np.float32),
            sample_rate=16000,
            tenant_id="t1",
            consultation_id="c1",
            config=config,
        )

        assert result.is_new_speaker is True
        assert result.speaker_id.startswith("speaker-")
        assert result.point_id == "point-123"

        # Verify upsert was called with correct tenant, speaker, embedding, and consultation_id
        mock_store.upsert_embedding.assert_called_once()
        call_kwargs = mock_store.upsert_embedding.call_args.kwargs
        assert call_kwargs["tenant_id"] == "t1"
        assert call_kwargs["speaker_id"] == result.speaker_id
        assert call_kwargs["consultation_id"] == "c1"
        assert len(call_kwargs["embedding"]) == 512

    async def test_identify_no_register_returns_unknown(self):
        mock_emb, mock_store = _make_mock_services()

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(enabled=True, auto_register_speakers=False)
        result = await identifier.identify_speaker(
            samples=np.zeros(16000, dtype=np.float32),
            sample_rate=16000,
            tenant_id="t1",
            config=config,
        )

        assert result.speaker_id == "unknown"
        assert result.is_new_speaker is False
        # Verify upsert was NOT called when auto_register is off
        mock_store.upsert_embedding.assert_not_called()

    async def test_identify_speaker_wraps_extraction_failure(self):
        """Embedding extraction failure should be wrapped in SpeakerIdentificationError."""
        mock_emb, mock_store = _make_mock_services()
        mock_emb.extract_from_samples.side_effect = RuntimeError("Model crashed")

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        with pytest.raises(SpeakerIdentificationError, match="Speaker identification failed"):
            await identifier.identify_speaker(
                samples=np.zeros(16000, dtype=np.float32),
                sample_rate=16000,
                tenant_id="t1",
            )

    async def test_identify_speaker_wraps_store_search_failure(self):
        """Qdrant search failure should be wrapped in SpeakerIdentificationError."""
        mock_emb, mock_store = _make_mock_services()
        mock_store.search_similar.side_effect = ConnectionError("Qdrant down")

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        with pytest.raises(SpeakerIdentificationError, match="Speaker identification failed"):
            await identifier.identify_speaker(
                samples=np.zeros(16000, dtype=np.float32),
                sample_rate=16000,
                tenant_id="t1",
            )

    async def test_identify_speaker_verifies_search_args(self):
        """Verify search_similar is called with correct tenant_id, threshold, consultation_id."""
        mock_emb, mock_store = _make_mock_services()
        mock_store.search_similar.return_value = [
            {"speaker_id": "spk-1", "score": 0.85, "point_id": "pt-1", "payload": {}}
        ]

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(enabled=True, similarity_threshold=0.82)
        await identifier.identify_speaker(
            samples=np.zeros(16000, dtype=np.float32),
            sample_rate=16000,
            tenant_id="t1",
            consultation_id="c42",
            config=config,
        )

        call_kwargs = mock_store.search_similar.call_args.kwargs
        assert call_kwargs["tenant_id"] == "t1"
        assert call_kwargs["score_threshold"] == 0.82
        assert call_kwargs["consultation_id"] == "c42"
        assert len(call_kwargs["query_embedding"]) == 512

    async def test_diarize_disabled_returns_not_applied(self):
        mock_emb, mock_store = _make_mock_services()
        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(enabled=False)

        result = await identifier.diarize_segments(
            samples=np.zeros(48000, dtype=np.float32),
            sample_rate=16000,
            segments=[{"text": "hello", "start": 0.0, "end": 3.0}],
            tenant_id="t1",
            config=config,
        )

        assert result.applied is False

    async def test_diarize_segments_assigns_speakers(self):
        mock_emb, mock_store = _make_mock_services()
        mock_store.search_similar.return_value = [
            {"speaker_id": "spk-1", "score": 0.9, "point_id": "pt-1", "payload": {}}
        ]

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(enabled=True, min_segment_duration_s=0.5)

        # 3 seconds of audio
        result = await identifier.diarize_segments(
            samples=np.zeros(48000, dtype=np.float32),
            sample_rate=16000,
            segments=[
                {"text": "hello", "start": 0.0, "end": 1.5},
                {"text": "world", "start": 1.5, "end": 3.0},
            ],
            tenant_id="t1",
            config=config,
        )

        assert result.applied is True
        assert result.speakers_detected == 1
        assert all(s.speaker_id == "spk-1" for s in result.segments)

    async def test_diarize_skips_short_segments(self):
        mock_emb, mock_store = _make_mock_services()
        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(enabled=True, min_segment_duration_s=2.0)

        result = await identifier.diarize_segments(
            samples=np.zeros(48000, dtype=np.float32),
            sample_rate=16000,
            segments=[
                {"text": "short", "start": 0.0, "end": 0.5},  # too short
                {"text": "long", "start": 0.5, "end": 3.0},  # ok
            ],
            tenant_id="t1",
            config=config,
        )

        assert result.applied is True
        # First segment skipped (speaker_id = None)
        assert result.segments[0].speaker_id is None

    async def test_diarize_handles_errors_gracefully(self):
        """Batch extraction returning None for a segment should not crash entire job."""
        mock_emb, mock_store = _make_mock_services()
        # Batch returns first embedding OK, second as None (failed)
        mock_emb.extract_batch = AsyncMock(
            return_value=[
                SpeakerEmbedding(embedding=[0.1] * 512, segment_start=0.0, segment_end=1.5),
                None,  # Extraction failed for second segment
            ]
        )

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(enabled=True, min_segment_duration_s=0.5)

        result = await identifier.diarize_segments(
            samples=np.zeros(48000, dtype=np.float32),
            sample_rate=16000,
            segments=[
                {"text": "hello", "start": 0.0, "end": 1.5},
                {"text": "world", "start": 1.5, "end": 3.0},
            ],
            tenant_id="t1",
            config=config,
        )

        # Should not crash — first segment OK, second failed gracefully
        assert result.applied is True
        assert len(result.segments) == 2
        assert result.segments[1].speaker_id is None  # Failed one has no speaker

    async def test_diarize_max_speakers_enforced(self):
        """When max_speakers is reached, no new speakers should be registered."""
        mock_emb, mock_store = _make_mock_services()
        # All Qdrant searches return empty — would register new speakers
        mock_store.search_similar = AsyncMock(return_value=[])

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        # Limit to 1 speaker
        config = DiarizationConfig(
            enabled=True,
            auto_register_speakers=True,
            max_speakers=1,
            min_segment_duration_s=0.5,
        )

        result = await identifier.diarize_segments(
            samples=np.zeros(48000, dtype=np.float32),
            sample_rate=16000,
            segments=[
                {"text": "hello", "start": 0.0, "end": 1.5},
                {"text": "world", "start": 1.5, "end": 3.0},
            ],
            tenant_id="t1",
            config=config,
        )

        assert result.applied is True
        assert len(result.segments) == 2
        # First segment gets registered
        assert result.segments[0].speaker_id is not None
        assert result.segments[0].speaker_id.startswith("speaker-")
        # Second segment hits max_speakers — gets "unknown"
        assert result.segments[1].speaker_id == "unknown"
        # Only 1 upsert call (not 2)
        assert mock_store.upsert_embedding.call_count == 1

    async def test_diarize_uses_batch_extraction_with_correct_slices(self):
        """Verify diarize_segments passes correctly sliced audio to extract_batch."""
        mock_emb, mock_store = _make_mock_services()

        # Track the actual audio arrays passed to extract_batch
        captured_audio: list[np.ndarray] = []
        captured_times: list[tuple[float, float]] = []

        async def capture_extract_batch(segs, sr, times):
            captured_audio.extend(segs)
            captured_times.extend(times)
            return [
                SpeakerEmbedding(embedding=[0.1] * 512, segment_start=t[0], segment_end=t[1])
                for t in times
            ]

        mock_emb.extract_batch = AsyncMock(side_effect=capture_extract_batch)

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(enabled=True, min_segment_duration_s=0.5)

        # Use distinguishable audio so we can verify correct slicing
        full_audio = np.arange(48000, dtype=np.float32)  # 3 seconds at 16kHz
        await identifier.diarize_segments(
            samples=full_audio,
            sample_rate=16000,
            segments=[
                {"text": "a", "start": 0.0, "end": 1.5},
                {"text": "b", "start": 1.5, "end": 3.0},
            ],
            tenant_id="t1",
            config=config,
        )

        # Verify the ACTUAL audio slices (not just that mock was called)
        assert len(captured_audio) == 2
        assert len(captured_audio[0]) == 24000  # 1.5s * 16000
        assert len(captured_audio[1]) == 24000
        # First slice should be samples 0..24000, second 24000..48000
        assert captured_audio[0][0] == 0.0
        assert captured_audio[1][0] == 24000.0
        assert captured_times == [(0.0, 1.5), (1.5, 3.0)]
        # extract_from_samples should NOT be called by diarize_segments
        mock_emb.extract_from_samples.assert_not_called()

    async def test_diarize_qdrant_failure_per_segment_graceful(self):
        """Qdrant search failure on one segment should not crash the batch."""
        mock_emb, mock_store = _make_mock_services()
        call_count = 0

        async def search_side_effect(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 2:
                raise ConnectionError("Qdrant timeout")
            return [{"speaker_id": "spk-1", "score": 0.9, "point_id": "pt-1", "payload": {}}]

        mock_store.search_similar = AsyncMock(side_effect=search_side_effect)

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(enabled=True, min_segment_duration_s=0.5)

        result = await identifier.diarize_segments(
            samples=np.zeros(48000, dtype=np.float32),
            sample_rate=16000,
            segments=[
                {"text": "hello", "start": 0.0, "end": 1.5},
                {"text": "world", "start": 1.5, "end": 3.0},  # Qdrant fails here
            ],
            tenant_id="t1",
            config=config,
        )

        assert result.applied is True
        assert len(result.segments) == 2
        assert result.segments[0].speaker_id == "spk-1"
        assert result.segments[1].speaker_id is None  # Qdrant failure → None

    async def test_diarize_empty_segments_list(self):
        """Empty segment list should return applied=True with empty results."""
        mock_emb, mock_store = _make_mock_services()
        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(enabled=True)

        result = await identifier.diarize_segments(
            samples=np.zeros(16000, dtype=np.float32),
            sample_rate=16000,
            segments=[],
            tenant_id="t1",
            config=config,
        )

        assert result.applied is True
        assert result.segments == []
        assert result.speakers_detected == 0
        mock_emb.extract_batch.assert_not_called()

    async def test_diarize_all_segments_too_short_skips_batch(self):
        """When all segments are too short, extract_batch should not be called."""
        mock_emb, mock_store = _make_mock_services()
        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(enabled=True, min_segment_duration_s=5.0)

        result = await identifier.diarize_segments(
            samples=np.zeros(48000, dtype=np.float32),
            sample_rate=16000,
            segments=[
                {"text": "a", "start": 0.0, "end": 0.5},  # Too short
                {"text": "b", "start": 0.5, "end": 1.0},  # Too short
            ],
            tenant_id="t1",
            config=config,
        )

        assert result.applied is True
        assert all(s.speaker_id is None for s in result.segments)
        mock_emb.extract_batch.assert_not_called()

    async def test_diarize_max_speakers_zero_means_unlimited(self):
        """max_speakers=0 means no limit — all speakers should register."""
        mock_emb, mock_store = _make_mock_services()
        mock_store.search_similar = AsyncMock(return_value=[])

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(
            enabled=True,
            auto_register_speakers=True,
            max_speakers=0,  # No limit
            min_segment_duration_s=0.5,
        )

        result = await identifier.diarize_segments(
            samples=np.zeros(80000, dtype=np.float32),
            sample_rate=16000,
            segments=[
                {"text": "a", "start": 0.0, "end": 1.5},
                {"text": "b", "start": 1.5, "end": 3.0},
                {"text": "c", "start": 3.0, "end": 5.0},
            ],
            tenant_id="t1",
            config=config,
        )

        assert result.applied is True
        # All 3 should register new speakers (none get "unknown")
        assert mock_store.upsert_embedding.call_count == 3
        assert all(s.speaker_id.startswith("speaker-") for s in result.segments)

    async def test_diarize_batch_extraction_total_failure_graceful(self):
        """Total extract_batch failure should result in all segments having no speaker."""
        mock_emb, mock_store = _make_mock_services()
        mock_emb.extract_batch = AsyncMock(side_effect=RuntimeError("GPU OOM"))

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(enabled=True, min_segment_duration_s=0.5)

        result = await identifier.diarize_segments(
            samples=np.zeros(48000, dtype=np.float32),
            sample_rate=16000,
            segments=[
                {"text": "a", "start": 0.0, "end": 1.5},
                {"text": "b", "start": 1.5, "end": 3.0},
            ],
            tenant_id="t1",
            config=config,
        )

        assert result.applied is True
        assert len(result.segments) == 2
        # All None because batch extraction failed entirely
        assert all(s.speaker_id is None for s in result.segments)

    # -----------------------------------------------------------------
    # Anti-pattern #4: verify word_timestamps propagation (complete mock)
    # -----------------------------------------------------------------

    async def test_diarize_word_timestamps_propagated(self):
        """word_timestamps in input segments must appear in DiarizedSegment output."""
        mock_emb, mock_store = _make_mock_services()
        mock_store.search_similar.return_value = [
            {"speaker_id": "spk-1", "score": 0.9, "point_id": "pt-1", "payload": {}}
        ]

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(enabled=True, min_segment_duration_s=0.5)

        wt = [{"word": "hello", "start": 0.0, "end": 0.5}, {"word": "world", "start": 0.5, "end": 1.0}]
        result = await identifier.diarize_segments(
            samples=np.zeros(48000, dtype=np.float32),
            sample_rate=16000,
            segments=[
                {"text": "hello world", "start": 0.0, "end": 1.5, "word_timestamps": wt},
            ],
            tenant_id="t1",
            config=config,
        )

        assert result.segments[0].word_timestamps == wt

    async def test_diarize_word_timestamps_default_empty_when_missing(self):
        """Segments without word_timestamps key should default to empty list."""
        mock_emb, mock_store = _make_mock_services()
        mock_store.search_similar.return_value = [
            {"speaker_id": "spk-1", "score": 0.9, "point_id": "pt-1", "payload": {}}
        ]

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(enabled=True, min_segment_duration_s=0.5)

        result = await identifier.diarize_segments(
            samples=np.zeros(48000, dtype=np.float32),
            sample_rate=16000,
            segments=[{"text": "test", "start": 0.0, "end": 1.5}],
            tenant_id="t1",
            config=config,
        )

        assert result.segments[0].word_timestamps == []

    # -----------------------------------------------------------------
    # Edge case: segment passes duration check but sample count < sample_rate
    # -----------------------------------------------------------------

    async def test_diarize_segment_duration_ok_but_samples_too_short(self):
        """Segment with duration >= min_segment_duration_s but sample count < 1s
        should be skipped (the second guard in production code)."""
        mock_emb, mock_store = _make_mock_services()
        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(enabled=True, min_segment_duration_s=0.5)

        # Audio is only 0.5 seconds long but segment claims 2s
        # start_sample=0, end_sample=int(2.0 * 16000) = 32000 → samples[0:32000]
        # but audio is only 8000 samples (0.5s), so slice = 8000 < 16000
        short_audio = np.zeros(8000, dtype=np.float32)

        result = await identifier.diarize_segments(
            samples=short_audio,
            sample_rate=16000,
            segments=[{"text": "clipped", "start": 0.0, "end": 2.0}],
            tenant_id="t1",
            config=config,
        )

        assert result.applied is True
        assert result.segments[0].speaker_id is None  # Skipped
        mock_emb.extract_batch.assert_not_called()

    # -----------------------------------------------------------------
    # Edge case: mixed known + new speakers in same batch
    # -----------------------------------------------------------------

    async def test_diarize_mixed_known_and_new_speakers(self):
        """Batch with some known and some new speakers should handle both correctly."""
        mock_emb, mock_store = _make_mock_services()
        call_count = 0

        async def search_side_effect(**kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return [{"speaker_id": "spk-existing", "score": 0.92, "point_id": "pt-1", "payload": {}}]
            return []  # No match — triggers new registration

        mock_store.search_similar = AsyncMock(side_effect=search_side_effect)

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(
            enabled=True,
            auto_register_speakers=True,
            min_segment_duration_s=0.5,
        )

        result = await identifier.diarize_segments(
            samples=np.zeros(48000, dtype=np.float32),
            sample_rate=16000,
            segments=[
                {"text": "known", "start": 0.0, "end": 1.5},
                {"text": "new", "start": 1.5, "end": 3.0},
            ],
            tenant_id="t1",
            config=config,
        )

        assert result.applied is True
        assert result.segments[0].speaker_id == "spk-existing"
        assert result.segments[0].speaker_confidence == 0.92
        assert result.segments[1].speaker_id.startswith("speaker-")
        assert result.segments[1].speaker_confidence is None
        assert result.speakers_detected == 2
        assert result.new_speakers_created == 1
        # Known speaker should NOT trigger upsert, only the new one
        assert mock_store.upsert_embedding.call_count == 1

    # -----------------------------------------------------------------
    # Edge case: max_speakers = 2 with 3 segments, 2 get registered, 3rd "unknown"
    # -----------------------------------------------------------------

    async def test_diarize_max_speakers_exact_boundary(self):
        """max_speakers=2 should allow exactly 2 registrations, then cap."""
        mock_emb, mock_store = _make_mock_services()
        mock_store.search_similar = AsyncMock(return_value=[])

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(
            enabled=True,
            auto_register_speakers=True,
            max_speakers=2,
            min_segment_duration_s=0.5,
        )

        result = await identifier.diarize_segments(
            samples=np.zeros(80000, dtype=np.float32),
            sample_rate=16000,
            segments=[
                {"text": "a", "start": 0.0, "end": 1.5},
                {"text": "b", "start": 1.5, "end": 3.0},
                {"text": "c", "start": 3.0, "end": 5.0},
            ],
            tenant_id="t1",
            config=config,
        )

        assert result.applied is True
        # First 2 get unique speaker IDs
        assert result.segments[0].speaker_id.startswith("speaker-")
        assert result.segments[1].speaker_id.startswith("speaker-")
        # Third hits the cap
        assert result.segments[2].speaker_id == "unknown"
        assert mock_store.upsert_embedding.call_count == 2

    # -----------------------------------------------------------------
    # Edge case: segment dict missing optional keys (defensive defaults)
    # -----------------------------------------------------------------

    async def test_diarize_segment_missing_text_key(self):
        """Segment dict missing 'text' should default to empty string."""
        mock_emb, mock_store = _make_mock_services()
        mock_store.search_similar.return_value = [
            {"speaker_id": "spk-1", "score": 0.9, "point_id": "pt-1", "payload": {}}
        ]

        identifier = SpeakerIdentifier(
            embedding_service=mock_emb, speaker_store=mock_store
        )
        config = DiarizationConfig(enabled=True, min_segment_duration_s=0.5)

        result = await identifier.diarize_segments(
            samples=np.zeros(48000, dtype=np.float32),
            sample_rate=16000,
            segments=[{"start": 0.0, "end": 1.5}],  # No "text" key
            tenant_id="t1",
            config=config,
        )

        assert result.segments[0].text == ""
        assert result.segments[0].speaker_id == "spk-1"
