"""Unit tests for voice profile extraction service.

TDD: These tests define the expected behavior of ExtractionService.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import numpy as np
import pytest

from stt_v2.voice_profile.extraction_service import ExtractionResult, ExtractionService


@pytest.fixture
def mock_embedding_service():
    """Mock EmbeddingService that returns deterministic 256d embeddings."""
    service = AsyncMock()
    service.is_loaded = True

    async def fake_extract(samples, sample_rate=16000, start_time=0.0, end_time=None):
        vec = np.random.RandomState(42).randn(256).astype(np.float32)
        vec = vec / np.linalg.norm(vec)
        from stt_v2.diarization.dto import SpeakerEmbedding
        return SpeakerEmbedding(
            embedding=vec.tolist(),
            segment_start=start_time,
            segment_end=end_time or len(samples) / sample_rate,
        )

    service.extract_from_samples = AsyncMock(side_effect=fake_extract)
    return service


@pytest.fixture
def mock_vad_service():
    """Mock VAD service that returns speech segments."""
    service = MagicMock()
    service.is_loaded = True
    return service


@pytest.fixture
def extraction_service(mock_embedding_service, mock_vad_service):
    return ExtractionService(
        embedding_service=mock_embedding_service,
        vad_service=mock_vad_service,
    )


def _make_audio_samples(duration_sec: float, sample_rate: int = 16000) -> np.ndarray:
    """Generate synthetic audio samples for testing."""
    n_samples = int(duration_sec * sample_rate)
    return np.random.RandomState(0).randn(n_samples).astype(np.float32) * 0.1


class TestExtractionServiceValidation:
    """Tests for input validation."""

    @pytest.mark.asyncio
    async def test_accepts_audio_shorter_than_10_seconds(self, extraction_service):
        audio = _make_audio_samples(5.0)
        result = await extraction_service.extract([audio], sample_rate=16000)
        assert isinstance(result, ExtractionResult)

    @pytest.mark.asyncio
    async def test_rejects_audio_longer_than_15_seconds(self, extraction_service):
        audio = _make_audio_samples(16.0)
        with pytest.raises(ValueError, match=r"exceeds 15\.0s"):
            await extraction_service.extract([audio], sample_rate=16000)

    @pytest.mark.asyncio
    async def test_accepts_audio_at_maximum_duration(self, extraction_service):
        audio = _make_audio_samples(15.0)
        result = await extraction_service.extract([audio], sample_rate=16000)
        assert isinstance(result, ExtractionResult)


class TestExtractionServiceSpeechValidation:
    """Tests for sample list validation."""

    @pytest.mark.asyncio
    async def test_rejects_empty_samples(self, extraction_service):
        with pytest.raises(ValueError, match="At least one audio sample is required"):
            await extraction_service.extract([], sample_rate=16000)

    @pytest.mark.asyncio
    async def test_rejects_more_than_three_samples(self, extraction_service):
        audio = _make_audio_samples(5.0)
        with pytest.raises(ValueError, match="At most 3 samples allowed"):
            await extraction_service.extract([audio, audio, audio, audio], sample_rate=16000)


class TestExtractionServiceOutput:
    """Tests for extraction output format."""

    @pytest.mark.asyncio
    async def test_accepts_audio_with_single_sample(self, extraction_service):
        audio = _make_audio_samples(15.0)
        result = await extraction_service.extract([audio], sample_rate=16000)
        assert result.quality_score >= 0.0

    @pytest.mark.asyncio
    async def test_returns_256d_embedding(self, extraction_service):
        audio = _make_audio_samples(15.0)
        result = await extraction_service.extract([audio], sample_rate=16000)
        assert len(result.embedding) == 256

    @pytest.mark.asyncio
    async def test_embedding_is_l2_normalized(self, extraction_service):
        audio = _make_audio_samples(15.0)
        result = await extraction_service.extract([audio], sample_rate=16000)
        norm = np.linalg.norm(result.embedding)
        assert abs(norm - 1.0) < 1e-5

    @pytest.mark.asyncio
    async def test_result_contains_quality_score(self, extraction_service):
        audio = _make_audio_samples(15.0)
        result = await extraction_service.extract([audio], sample_rate=16000)
        assert 0.0 <= result.quality_score <= 1.0

    @pytest.mark.asyncio
    async def test_result_contains_model_id(self, extraction_service):
        audio = _make_audio_samples(15.0)
        result = await extraction_service.extract([audio], sample_rate=16000)
        assert result.model_id is not None
        assert isinstance(result.model_id, str)
