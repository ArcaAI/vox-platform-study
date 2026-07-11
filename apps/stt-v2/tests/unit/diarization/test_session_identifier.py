"""Unit tests for SpeakerIdentifier.

Tests the three-zone identification logic:
- High confidence match (>= high_threshold)
- Low confidence / new speaker (< low_threshold)
- Ambiguous zone (between thresholds) -> segmentation refinement
"""

from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest

from stt_v2.diarization.dto import SpeakerEmbedding, SpeakerIdentification
from stt_v2.diarization.speaker_identifier import SpeakerIdentifier
from stt_v2.diarization.speaker_tracker import SpeakerTracker
from stt_v2.pipeline.dto import DiarizationConfig


@pytest.fixture(autouse=True)
def _seed_numpy() -> None:
    """Deterministic random embeddings per test.

    Several tests build embeddings with ``np.random.randn`` and assert on similarity
    thresholds; unseeded, certain values land across the ambiguous-zone boundary, so the
    suite was order-dependent (flaky) under ``pytest-randomly``. Seeding per test makes it
    order-independent. (Pre-existing defect surfaced by TASK-475's test reshuffle.)
    """
    np.random.seed(20260712)


def _make_embedding(values: list[float] | None = None) -> SpeakerEmbedding:
    if values is None:
        vec = np.random.randn(256).astype(np.float32)
        vec = vec / np.linalg.norm(vec)
        values = vec.tolist()
    return SpeakerEmbedding(embedding=values, segment_start=0.0, segment_end=2.0)


def _make_config(**overrides) -> DiarizationConfig:
    defaults = {
        "enabled": True,
        "high_threshold": 0.7,
        "low_threshold": 0.4,
        "max_speakers": 5,
        "min_segment_duration_s": 1.0,
        "min_update_confidence": 0.8,
        "enable_segmentation_refinement": True,
    }
    defaults.update(overrides)
    return DiarizationConfig(**defaults)


class TestHighConfidenceMatch:
    """Tests for confident match (>= high_threshold)."""

    @pytest.mark.asyncio
    async def test_high_confidence_returns_existing_speaker(self):
        """Score >= high_threshold should return the matched speaker."""
        tracker = SpeakerTracker(max_speakers=5)
        base_emb = np.random.randn(256).astype(np.float32)
        base_emb = base_emb / np.linalg.norm(base_emb)
        tracker.register(base_emb)

        config = _make_config()
        identifier = SpeakerIdentifier(tracker=tracker, config=config)

        # Query with a very similar embedding (cosine ~ 1.0)
        query = _make_embedding(base_emb.tolist())
        result = await identifier.identify(query)

        assert isinstance(result, SpeakerIdentification)
        assert result.speaker_id == "Speaker 1"
        assert result.is_new_speaker is False
        assert result.confidence is not None
        assert result.confidence >= 0.7

    @pytest.mark.asyncio
    async def test_high_confidence_triggers_update_when_above_min(self):
        """Score >= min_update_confidence should trigger embedding window update."""
        tracker = SpeakerTracker(max_speakers=5)
        base_emb = np.random.randn(256).astype(np.float32)
        base_emb = base_emb / np.linalg.norm(base_emb)
        tracker.register(base_emb)
        assert len(tracker._embedding_windows["Speaker 1"]) == 1

        config = _make_config(min_update_confidence=0.8)
        identifier = SpeakerIdentifier(tracker=tracker, config=config)

        # Use same embedding -> confidence ~1.0 which is >= 0.8
        query = _make_embedding(base_emb.tolist())
        await identifier.identify(query)

        # Window should have grown (embedding appended)
        assert len(tracker._embedding_windows["Speaker 1"]) == 2

    @pytest.mark.asyncio
    async def test_high_confidence_below_ema_min_no_update(self):
        """Score >= high_threshold but < min_update_confidence should NOT trigger update."""
        tracker = SpeakerTracker(max_speakers=5)
        base_emb = np.random.randn(256).astype(np.float32)
        base_emb = base_emb / np.linalg.norm(base_emb)
        tracker.register(base_emb)
        initial_window_size = len(tracker._embedding_windows["Speaker 1"])

        # Set min_update_confidence very high so it won't trigger
        config = _make_config(high_threshold=0.3, min_update_confidence=0.99)
        identifier = SpeakerIdentifier(tracker=tracker, config=config)

        # Create a query with moderate similarity (between 0.3 and 0.99)
        noise = np.random.randn(256).astype(np.float32) * 0.5
        noisy = base_emb + noise
        noisy = noisy / np.linalg.norm(noisy)
        query = _make_embedding(noisy.tolist())

        result = await identifier.identify(query)

        # Should match but NOT trigger update (confidence < 0.99)
        if result.confidence is not None and result.confidence < 0.99:
            # Window size should be unchanged
            assert len(tracker._embedding_windows["Speaker 1"]) == initial_window_size


class TestLowConfidenceNewSpeaker:
    """Tests for confident new speaker (< low_threshold)."""

    @pytest.mark.asyncio
    async def test_low_confidence_registers_new_speaker(self):
        """Score < low_threshold should register a new speaker."""
        tracker = SpeakerTracker(max_speakers=5)
        # Register speaker 1 with a known direction
        e1 = np.zeros(256, dtype=np.float32)
        e1[0] = 1.0
        tracker.register(e1)

        config = _make_config(low_threshold=0.4)
        identifier = SpeakerIdentifier(tracker=tracker, config=config)

        # Query with orthogonal embedding -> cosine ~0
        e2 = np.zeros(256, dtype=np.float32)
        e2[1] = 1.0
        query = _make_embedding(e2.tolist())
        result = await identifier.identify(query)

        assert isinstance(result, SpeakerIdentification)
        assert result.speaker_id == "Speaker 2"
        assert result.is_new_speaker is True

    @pytest.mark.asyncio
    async def test_at_capacity_falls_back_to_best_match(self):
        """At max_speakers capacity, low-confidence should fallback to best match."""
        tracker = SpeakerTracker(max_speakers=1)
        e1 = np.zeros(256, dtype=np.float32)
        e1[0] = 1.0
        tracker.register(e1)

        config = _make_config(max_speakers=1, low_threshold=0.4)
        identifier = SpeakerIdentifier(tracker=tracker, config=config)

        # Orthogonal query but at capacity
        e2 = np.zeros(256, dtype=np.float32)
        e2[1] = 1.0
        query = _make_embedding(e2.tolist())
        result = await identifier.identify(query)

        assert isinstance(result, SpeakerIdentification)
        assert result.speaker_id == "Speaker 1"
        assert result.is_new_speaker is False

    @pytest.mark.asyncio
    async def test_no_speakers_registered_first_long_segment(self):
        """First long segment should register as Speaker 1."""
        tracker = SpeakerTracker(max_speakers=5)
        config = _make_config()
        identifier = SpeakerIdentifier(tracker=tracker, config=config)

        query = _make_embedding()
        result = await identifier.identify(query)

        assert isinstance(result, SpeakerIdentification)
        assert result.speaker_id == "Speaker 1"
        assert result.is_new_speaker is True


class TestAmbiguousZone:
    """Tests for ambiguous zone (low_threshold <= score < high_threshold)."""

    @pytest.mark.asyncio
    async def test_ambiguous_with_segmentation_splits(self):
        """Ambiguous zone with segmentation should re-split and re-identify."""
        tracker = SpeakerTracker(max_speakers=5)
        # Register a speaker so compare returns non-None
        base = np.random.randn(256).astype(np.float32)
        base = base / np.linalg.norm(base)
        tracker.register(base)

        mock_emb_service = MagicMock()
        mock_seg_service = MagicMock()
        mock_seg_service.detect_speaker_turns = AsyncMock(
            return_value=[(0.0, 1.0), (1.0, 2.0)]  # Two sub-segments
        )

        # Make embedding service return distinct embeddings for sub-segments
        sub_emb1 = SpeakerEmbedding(embedding=base.tolist(), segment_start=0.0, segment_end=1.0)
        sub_emb2_vec = np.random.randn(256).astype(np.float32)
        sub_emb2_vec = sub_emb2_vec / np.linalg.norm(sub_emb2_vec)
        sub_emb2 = SpeakerEmbedding(embedding=sub_emb2_vec.tolist(), segment_start=1.0, segment_end=2.0)
        mock_emb_service.extract_from_samples = AsyncMock(side_effect=[sub_emb1, sub_emb2])

        config = _make_config(high_threshold=0.99, low_threshold=0.01)  # Force ambiguous zone
        identifier = SpeakerIdentifier(
            tracker=tracker,
            embedding_service=mock_emb_service,
            segmentation_service=mock_seg_service,
            config=config,
        )

        # Create a query that falls in ambiguous zone
        noisy = base + np.random.randn(256).astype(np.float32) * 0.3
        noisy = noisy / np.linalg.norm(noisy)
        query = _make_embedding(noisy.tolist())

        samples = np.random.randn(32000).astype(np.float32)
        result = await identifier.identify(
            query, samples=samples, sample_rate=16000,
        )

        # Should have triggered segmentation
        mock_seg_service.detect_speaker_turns.assert_called_once()
        # Should return a list of results (multiple sub-segments)
        assert isinstance(result, list)
        assert len(result) >= 1

    @pytest.mark.asyncio
    async def test_ambiguous_depth_1_no_segmentation(self):
        """At _depth=1, ambiguous zone should NOT trigger segmentation."""
        tracker = SpeakerTracker(max_speakers=5)
        base = np.random.randn(256).astype(np.float32)
        base = base / np.linalg.norm(base)
        tracker.register(base)

        mock_seg_service = MagicMock()
        config = _make_config(high_threshold=0.99, low_threshold=0.01)
        identifier = SpeakerIdentifier(
            tracker=tracker,
            segmentation_service=mock_seg_service,
            config=config,
        )

        noisy = base + np.random.randn(256).astype(np.float32) * 0.3
        noisy = noisy / np.linalg.norm(noisy)
        query = _make_embedding(noisy.tolist())

        result = await identifier.identify(
            query, samples=np.zeros(16000, dtype=np.float32), sample_rate=16000,
            _depth=1,
        )

        # Should NOT call segmentation at depth > 0
        mock_seg_service.detect_speaker_turns.assert_not_called()
        assert isinstance(result, SpeakerIdentification)

    @pytest.mark.asyncio
    async def test_ambiguous_without_segmentation_service_fallback(self):
        """Without segmentation service, ambiguous zone should fallback to best match."""
        tracker = SpeakerTracker(max_speakers=5)
        base = np.random.randn(256).astype(np.float32)
        base = base / np.linalg.norm(base)
        tracker.register(base)

        config = _make_config(high_threshold=0.99, low_threshold=0.01)
        identifier = SpeakerIdentifier(
            tracker=tracker,
            segmentation_service=None,
            config=config,
        )

        noisy = base + np.random.randn(256).astype(np.float32) * 0.3
        noisy = noisy / np.linalg.norm(noisy)
        query = _make_embedding(noisy.tolist())

        result = await identifier.identify(query)

        assert isinstance(result, SpeakerIdentification)
        assert result.speaker_id == "Speaker 1"
