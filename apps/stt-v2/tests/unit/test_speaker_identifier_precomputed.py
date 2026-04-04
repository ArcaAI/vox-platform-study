"""Unit tests for SpeakerIdentifier precomputed-embedding methods (A1).

Tests:
- diarize_with_embeddings() -- accepts precomputed embeddings, does Qdrant lookup only
- identify_with_embedding() -- single-segment variant for streaming
- diarize_segments() delegation -- regression, same results via new pathway
"""

from unittest.mock import AsyncMock

import numpy as np
import pytest

from stt_v2.diarization.dto import (
    SpeakerEmbedding,
    SpeakerIdentification,
)
from stt_v2.diarization.speaker_identifier import SpeakerIdentifier
from stt_v2.pipeline.dto import DiarizationConfig


def _make_embedding(vector: list[float] | None = None) -> SpeakerEmbedding:
    """Create a SpeakerEmbedding with optional custom vector."""
    return SpeakerEmbedding(
        embedding=vector or [0.1] * 512,
        segment_start=0.0,
        segment_end=1.0,
    )


def _make_identifier(
    search_results: list[list[dict]] | None = None,
    upsert_return: str = "point-1",
) -> SpeakerIdentifier:
    """Create a SpeakerIdentifier with mocked dependencies."""
    embedding_service = AsyncMock()
    speaker_store = AsyncMock()

    # search_similar returns different results for successive calls
    if search_results is not None:
        speaker_store.search_similar = AsyncMock(side_effect=search_results)
    else:
        speaker_store.search_similar = AsyncMock(return_value=[])

    speaker_store.upsert_embedding = AsyncMock(return_value=upsert_return)

    return SpeakerIdentifier(
        embedding_service=embedding_service,
        speaker_store=speaker_store,
    )


# =============================================================================
# Tests: diarize_with_embeddings
# =============================================================================


class TestDiarizeWithEmbeddings:

    @pytest.mark.asyncio
    async def test_known_speaker(self):
        """When Qdrant returns a match, assign existing speaker_id."""
        identifier = _make_identifier(
            search_results=[[{"speaker_id": "spk-abc", "score": 0.92, "point_id": "p1"}]]
        )
        embeddings = [_make_embedding()]
        segments = [{"start": 0.0, "end": 2.0, "text": "hello"}]

        result = await identifier.diarize_with_embeddings(
            embeddings=embeddings,
            segments=segments,
            tenant_id="tenant-1",
        )

        assert result.applied is True
        assert result.segments[0].speaker_id == "spk-abc"
        assert result.segments[0].speaker_confidence == 0.92

    @pytest.mark.asyncio
    async def test_new_speaker_auto_register(self):
        """When no match and auto_register enabled, register new speaker."""
        identifier = _make_identifier(search_results=[[]])
        embeddings = [_make_embedding()]
        segments = [{"start": 0.0, "end": 2.0, "text": "hello"}]
        config = DiarizationConfig(enabled=True, auto_register_speakers=True)

        result = await identifier.diarize_with_embeddings(
            embeddings=embeddings,
            segments=segments,
            tenant_id="tenant-1",
            config=config,
        )

        assert result.applied is True
        assert result.segments[0].speaker_id is not None
        assert result.segments[0].speaker_id != "unknown"
        assert result.new_speakers_created == 1

    @pytest.mark.asyncio
    async def test_max_speakers_enforced(self):
        """When max_speakers is reached, unmatched segments get 'unknown'."""
        identifier = _make_identifier(
            search_results=[
                [{"speaker_id": "spk-1", "score": 0.95, "point_id": "p1"}],
                [],  # second segment: no match
            ]
        )
        embeddings = [_make_embedding(), _make_embedding([0.2] * 512)]
        segments = [
            {"start": 0.0, "end": 2.0, "text": "hello"},
            {"start": 2.0, "end": 4.0, "text": "world"},
        ]
        config = DiarizationConfig(
            enabled=True, auto_register_speakers=True, max_speakers=1
        )

        result = await identifier.diarize_with_embeddings(
            embeddings=embeddings,
            segments=segments,
            tenant_id="tenant-1",
            config=config,
        )

        assert result.segments[0].speaker_id == "spk-1"
        assert result.segments[1].speaker_id == "unknown"

    @pytest.mark.asyncio
    async def test_none_embedding_skipped(self):
        """When embedding is None, segment gets speaker_id=None."""
        identifier = _make_identifier()
        embeddings = [None]
        segments = [{"start": 0.0, "end": 2.0, "text": "hello"}]

        result = await identifier.diarize_with_embeddings(
            embeddings=embeddings,
            segments=segments,
            tenant_id="tenant-1",
        )

        assert result.applied is True
        assert result.segments[0].speaker_id is None


# =============================================================================
# Tests: identify_with_embedding
# =============================================================================


class TestIdentifyWithEmbedding:

    @pytest.mark.asyncio
    async def test_known_speaker(self):
        """When Qdrant returns match, return known speaker."""
        identifier = _make_identifier(
            search_results=[[{"speaker_id": "spk-xyz", "score": 0.88, "point_id": "p2"}]]
        )
        embedding = _make_embedding()

        result = await identifier.identify_with_embedding(
            embedding=embedding,
            tenant_id="tenant-1",
        )

        assert isinstance(result, SpeakerIdentification)
        assert result.speaker_id == "spk-xyz"
        assert result.confidence == 0.88
        assert result.is_new_speaker is False

    @pytest.mark.asyncio
    async def test_no_match_auto_register(self):
        """When no match and auto_register enabled, register and return new speaker."""
        identifier = _make_identifier(search_results=[[]])
        embedding = _make_embedding()
        config = DiarizationConfig(enabled=True, auto_register_speakers=True)

        result = await identifier.identify_with_embedding(
            embedding=embedding,
            tenant_id="tenant-1",
            config=config,
        )

        assert result.is_new_speaker is True
        assert result.speaker_id != "unknown"


# =============================================================================
# Tests: diarize_segments delegation (regression)
# =============================================================================


class TestDiarizeSegmentsDelegation:

    @pytest.mark.asyncio
    async def test_delegates_to_diarize_with_embeddings(self):
        """diarize_segments should produce same results as before refactor."""
        embedding_service = AsyncMock()
        embedding_service.extract_batch = AsyncMock(
            return_value=[_make_embedding()]
        )
        speaker_store = AsyncMock()
        speaker_store.search_similar = AsyncMock(
            return_value=[{"speaker_id": "spk-1", "score": 0.9, "point_id": "p1"}]
        )
        speaker_store.upsert_embedding = AsyncMock(return_value="p1")

        identifier = SpeakerIdentifier(
            embedding_service=embedding_service,
            speaker_store=speaker_store,
        )

        samples = np.random.randn(32000).astype(np.float32)  # 2 seconds
        segments = [{"start": 0.0, "end": 2.0, "text": "test"}]
        config = DiarizationConfig(enabled=True, min_segment_duration_s=0.5)

        result = await identifier.diarize_segments(
            samples=samples,
            sample_rate=16000,
            segments=segments,
            tenant_id="tenant-1",
            config=config,
        )

        assert result.applied is True
        assert result.segments[0].speaker_id == "spk-1"
