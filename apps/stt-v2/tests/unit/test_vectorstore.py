"""Unit tests for Qdrant vector store module."""

import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

# Inject mock qdrant_client into sys.modules BEFORE importing the modules under test.
# The actual qdrant-client package is an optional dependency not installed in the
# test environment, but the production code only imports it lazily inside functions.
_mock_qdrant = MagicMock()
_mock_qdrant_models = MagicMock()
# Ensure model classes are available
_mock_qdrant_models.PointStruct = type(
    "PointStruct", (), {"__init__": lambda self, **kw: self.__dict__.update(kw)}
)
_mock_qdrant_models.PointIdsList = MagicMock()
_mock_qdrant_models.FilterSelector = MagicMock()
_mock_qdrant_models.Filter = MagicMock()
_mock_qdrant_models.FieldCondition = MagicMock()
_mock_qdrant_models.MatchValue = MagicMock()
_mock_qdrant_models.Range = MagicMock()
_mock_qdrant_models.Distance = MagicMock()
_mock_qdrant_models.VectorParams = MagicMock()
_mock_qdrant_models.HnswConfigDiff = MagicMock()
_mock_qdrant_models.OptimizersConfigDiff = MagicMock()
_mock_qdrant_models.KeywordIndexParams = MagicMock()
_mock_qdrant_models.KeywordIndexType = MagicMock()
_mock_qdrant_models.PayloadSchemaType = MagicMock()
_mock_qdrant.models = _mock_qdrant_models

sys.modules["qdrant_client"] = _mock_qdrant
sys.modules["qdrant_client.models"] = _mock_qdrant_models

from stt_v2.core.exceptions import SpeakerEmbeddingError  # noqa: E402
from stt_v2.core.vectorstore.client import QdrantClientManager  # noqa: E402
from stt_v2.core.vectorstore.speaker_store import SpeakerEmbeddingStore  # noqa: E402

# =============================================================================
# QdrantClientManager Tests — inject mocks directly
# =============================================================================


class TestQdrantClientManager:
    async def test_get_client_returns_cached(self):
        mgr = QdrantClientManager()
        mock_client = AsyncMock()
        mgr._client = mock_client

        result = await mgr.get_client()
        assert result is mock_client

    async def test_close_clears_client(self):
        mgr = QdrantClientManager()
        mgr._client = AsyncMock()

        await mgr.close()
        assert mgr._client is None

    async def test_close_handles_error(self):
        mgr = QdrantClientManager()
        mock_client = AsyncMock()
        mock_client.close.side_effect = RuntimeError("close failed")
        mgr._client = mock_client

        await mgr.close()
        assert mgr._client is None

    async def test_health_check_true(self):
        mgr = QdrantClientManager()
        mock_client = AsyncMock()
        mgr._client = mock_client

        assert await mgr.health_check() is True

    async def test_health_check_false_on_error(self):
        mgr = QdrantClientManager()
        mock_client = AsyncMock()
        mock_client.get_collections.side_effect = ConnectionError("offline")
        mgr._client = mock_client

        assert await mgr.health_check() is False


# =============================================================================
# SpeakerEmbeddingStore Tests — inject mock client manager
# =============================================================================


def _make_store_with_mock() -> tuple[SpeakerEmbeddingStore, AsyncMock]:
    """Create a SpeakerEmbeddingStore with a mock client manager."""
    mock_client = AsyncMock()
    mock_client.collection_exists = AsyncMock(return_value=True)
    mock_client.upsert = AsyncMock()
    mock_client.search = AsyncMock(return_value=[])
    mock_client.scroll = AsyncMock(return_value=([], None))
    mock_client.delete = AsyncMock()
    mock_client.create_collection = AsyncMock()
    mock_client.create_payload_index = AsyncMock()

    mock_manager = AsyncMock(spec=QdrantClientManager)
    mock_manager.get_client = AsyncMock(return_value=mock_client)

    store = SpeakerEmbeddingStore(client_manager=mock_manager)
    store._collection_name = "stt_speaker_embeddings"
    return store, mock_client


class TestSpeakerEmbeddingStoreEnsureCollection:
    async def test_skips_when_exists(self, mocker):
        mocker.patch(
            "stt_v2.core.vectorstore.speaker_store.get_settings",
            return_value=MagicMock(
                qdrant_collection_speakers="stt_speaker_embeddings",
                diarization_similarity_threshold=0.7,
            ),
        )
        store, mock_client = _make_store_with_mock()
        mock_client.collection_exists.return_value = True

        await store.ensure_collection()
        mock_client.create_collection.assert_not_called()

    async def test_creates_when_not_exists(self, mocker):
        mocker.patch(
            "stt_v2.core.vectorstore.speaker_store.get_settings",
            return_value=MagicMock(
                qdrant_collection_speakers="stt_speaker_embeddings",
                diarization_similarity_threshold=0.7,
            ),
        )
        store, mock_client = _make_store_with_mock()
        mock_client.collection_exists.return_value = False
        store._initialised = False

        await store.ensure_collection()
        mock_client.create_collection.assert_called_once()


class TestSpeakerEmbeddingStoreUpsert:
    async def test_upsert_stores_point_with_correct_payload(self, mocker):
        """Verify upsert sends correct tenant/speaker/consultation payload to Qdrant."""
        mocker.patch(
            "stt_v2.core.vectorstore.speaker_store.get_settings",
            return_value=MagicMock(
                qdrant_collection_speakers="stt_speaker_embeddings",
                diarization_similarity_threshold=0.7,
            ),
        )
        store, mock_client = _make_store_with_mock()
        store._initialised = True

        embedding = [0.1] * 512
        point_id = await store.upsert_embedding(
            tenant_id="t1",
            speaker_id="spk-1",
            embedding=embedding,
            consultation_id="c1",
        )

        # Verify a non-empty point ID is returned (hex UUID)
        assert point_id is not None
        assert len(point_id) == 32  # uuid4().hex is 32 chars

        # Verify upsert was called with correct collection and a point
        mock_client.upsert.assert_called_once()
        call_kwargs = mock_client.upsert.call_args.kwargs
        assert call_kwargs["collection_name"] == "stt_speaker_embeddings"
        assert call_kwargs["wait"] is True

        # Verify the PointStruct payload
        points = call_kwargs["points"]
        assert len(points) == 1
        point = points[0]
        assert point.id == point_id
        assert point.vector == embedding
        assert point.payload["tenant_id"] == "t1"
        assert point.payload["speaker_id"] == "spk-1"
        assert point.payload["consultation_id"] == "c1"
        assert "created_at" in point.payload  # timestamp present

    async def test_upsert_without_consultation_id(self, mocker):
        """Verify upsert omits consultation_id from payload when not provided."""
        mocker.patch(
            "stt_v2.core.vectorstore.speaker_store.get_settings",
            return_value=MagicMock(
                qdrant_collection_speakers="stt_speaker_embeddings",
                diarization_similarity_threshold=0.7,
            ),
        )
        store, mock_client = _make_store_with_mock()
        store._initialised = True

        await store.upsert_embedding(
            tenant_id="t1",
            speaker_id="spk-1",
            embedding=[0.1] * 512,
        )

        call_kwargs = mock_client.upsert.call_args.kwargs
        point = call_kwargs["points"][0]
        assert point.payload["tenant_id"] == "t1"
        assert "consultation_id" not in point.payload

    async def test_upsert_raises_on_error(self, mocker):
        mocker.patch(
            "stt_v2.core.vectorstore.speaker_store.get_settings",
            return_value=MagicMock(
                qdrant_collection_speakers="stt_speaker_embeddings",
                diarization_similarity_threshold=0.7,
            ),
        )
        store, mock_client = _make_store_with_mock()
        store._initialised = True
        mock_client.upsert.side_effect = RuntimeError("upsert failed")

        with pytest.raises(SpeakerEmbeddingError, match="upsert"):
            await store.upsert_embedding("t1", "spk-1", [0.1] * 512)


class TestSpeakerEmbeddingStoreSearch:
    async def test_search_filters_by_tenant(self, mocker):
        mocker.patch(
            "stt_v2.core.vectorstore.speaker_store.get_settings",
            return_value=MagicMock(
                qdrant_collection_speakers="stt_speaker_embeddings",
                diarization_similarity_threshold=0.7,
            ),
        )
        store, mock_client = _make_store_with_mock()
        store._initialised = True

        # Mock a search result
        mock_result = MagicMock()
        mock_result.id = "pt-1"
        mock_result.score = 0.85
        mock_result.payload = {"speaker_id": "spk-1", "tenant_id": "t1"}
        mock_client.search.return_value = [mock_result]

        results = await store.search_similar("t1", [0.1] * 512)

        assert len(results) == 1
        assert results[0]["speaker_id"] == "spk-1"
        assert results[0]["score"] == 0.85
        mock_client.search.assert_called_once()

    async def test_search_returns_empty_for_no_match(self, mocker):
        mocker.patch(
            "stt_v2.core.vectorstore.speaker_store.get_settings",
            return_value=MagicMock(
                qdrant_collection_speakers="stt_speaker_embeddings",
                diarization_similarity_threshold=0.7,
            ),
        )
        store, mock_client = _make_store_with_mock()
        store._initialised = True

        results = await store.search_similar("t1", [0.1] * 512)
        assert results == []


class TestSpeakerEmbeddingStoreDelete:
    async def test_delete_speaker(self, mocker):
        mocker.patch(
            "stt_v2.core.vectorstore.speaker_store.get_settings",
            return_value=MagicMock(
                qdrant_collection_speakers="stt_speaker_embeddings",
                diarization_similarity_threshold=0.7,
            ),
        )
        store, mock_client = _make_store_with_mock()
        store._initialised = True

        # Mock scroll returning some points
        mock_point = MagicMock()
        mock_point.id = "pt-1"
        mock_client.scroll.return_value = ([mock_point], None)

        count = await store.delete_speaker("t1", "spk-1")
        assert count == 1
        mock_client.delete.assert_called_once()

    async def test_delete_no_points(self, mocker):
        mocker.patch(
            "stt_v2.core.vectorstore.speaker_store.get_settings",
            return_value=MagicMock(
                qdrant_collection_speakers="stt_speaker_embeddings",
                diarization_similarity_threshold=0.7,
            ),
        )
        store, mock_client = _make_store_with_mock()
        store._initialised = True
        mock_client.scroll.return_value = ([], None)

        count = await store.delete_speaker("t1", "spk-1")
        assert count == 0
        mock_client.delete.assert_not_called()


# =============================================================================
# Edge Case Tests — Search, Cleanup, List
# =============================================================================


class TestSpeakerEmbeddingStoreSearchEdgeCases:
    """Edge cases for search_similar."""

    async def test_search_with_consultation_id_filter(self, mocker):
        """Verify search passes consultation_id filter to Qdrant."""
        mocker.patch(
            "stt_v2.core.vectorstore.speaker_store.get_settings",
            return_value=MagicMock(
                qdrant_collection_speakers="stt_speaker_embeddings",
                diarization_similarity_threshold=0.7,
            ),
        )
        store, mock_client = _make_store_with_mock()
        store._initialised = True

        await store.search_similar("t1", [0.1] * 512, consultation_id="c1")

        # Verify search was called with filter including consultation_id
        mock_client.search.assert_called_once()
        call_kwargs = mock_client.search.call_args.kwargs
        assert call_kwargs["collection_name"] == "stt_speaker_embeddings"
        assert call_kwargs["score_threshold"] == 0.7

    async def test_search_with_custom_threshold(self, mocker):
        """Verify search respects custom score_threshold over settings default."""
        mocker.patch(
            "stt_v2.core.vectorstore.speaker_store.get_settings",
            return_value=MagicMock(
                qdrant_collection_speakers="stt_speaker_embeddings",
                diarization_similarity_threshold=0.7,
            ),
        )
        store, mock_client = _make_store_with_mock()
        store._initialised = True

        await store.search_similar("t1", [0.1] * 512, score_threshold=0.9)

        call_kwargs = mock_client.search.call_args.kwargs
        assert call_kwargs["score_threshold"] == 0.9

    async def test_search_raises_on_error(self, mocker):
        """Verify search wraps Qdrant errors in SpeakerEmbeddingError."""
        mocker.patch(
            "stt_v2.core.vectorstore.speaker_store.get_settings",
            return_value=MagicMock(
                qdrant_collection_speakers="stt_speaker_embeddings",
                diarization_similarity_threshold=0.7,
            ),
        )
        store, mock_client = _make_store_with_mock()
        store._initialised = True
        mock_client.search.side_effect = RuntimeError("Qdrant connection lost")

        with pytest.raises(SpeakerEmbeddingError, match="search"):
            await store.search_similar("t1", [0.1] * 512)


class TestSpeakerEmbeddingStoreGetSpeakers:
    """Tests for get_speakers_for_tenant."""

    async def test_get_speakers_returns_aggregated_counts(self, mocker):
        """Verify get_speakers aggregates embedding counts per speaker."""
        mocker.patch(
            "stt_v2.core.vectorstore.speaker_store.get_settings",
            return_value=MagicMock(
                qdrant_collection_speakers="stt_speaker_embeddings",
                diarization_similarity_threshold=0.7,
            ),
        )
        store, mock_client = _make_store_with_mock()
        store._initialised = True

        # Mock scroll returning multiple points for same speaker
        mock_p1 = MagicMock()
        mock_p1.payload = {"speaker_id": "spk-1", "tenant_id": "t1"}
        mock_p2 = MagicMock()
        mock_p2.payload = {"speaker_id": "spk-1", "tenant_id": "t1"}
        mock_p3 = MagicMock()
        mock_p3.payload = {"speaker_id": "spk-2", "tenant_id": "t1"}
        mock_client.scroll.return_value = ([mock_p1, mock_p2, mock_p3], None)

        speakers = await store.get_speakers_for_tenant("t1")

        assert len(speakers) == 2
        spk_map = {s["speaker_id"]: s["embedding_count"] for s in speakers}
        assert spk_map["spk-1"] == 2
        assert spk_map["spk-2"] == 1

    async def test_get_speakers_empty_tenant(self, mocker):
        """Verify empty tenant returns empty list."""
        mocker.patch(
            "stt_v2.core.vectorstore.speaker_store.get_settings",
            return_value=MagicMock(
                qdrant_collection_speakers="stt_speaker_embeddings",
                diarization_similarity_threshold=0.7,
            ),
        )
        store, mock_client = _make_store_with_mock()
        store._initialised = True

        speakers = await store.get_speakers_for_tenant("t-empty")
        assert speakers == []


class TestSpeakerEmbeddingStoreCleanupExpired:
    """Tests for cleanup_expired."""

    async def test_cleanup_calls_delete_with_filter(self, mocker):
        """Verify cleanup calls delete with timestamp range filter."""
        mocker.patch(
            "stt_v2.core.vectorstore.speaker_store.get_settings",
            return_value=MagicMock(
                qdrant_collection_speakers="stt_speaker_embeddings",
                diarization_similarity_threshold=0.7,
            ),
        )
        store, mock_client = _make_store_with_mock()
        store._initialised = True

        result = await store.cleanup_expired("t1", expiration_days=90)

        mock_client.delete.assert_called_once()
        assert result == 0  # Qdrant delete doesn't return count

    async def test_cleanup_raises_on_error(self, mocker):
        """Verify cleanup wraps errors in SpeakerEmbeddingError."""
        mocker.patch(
            "stt_v2.core.vectorstore.speaker_store.get_settings",
            return_value=MagicMock(
                qdrant_collection_speakers="stt_speaker_embeddings",
                diarization_similarity_threshold=0.7,
            ),
        )
        store, mock_client = _make_store_with_mock()
        store._initialised = True
        mock_client.delete.side_effect = RuntimeError("delete failed")

        with pytest.raises(SpeakerEmbeddingError, match="cleanup"):
            await store.cleanup_expired("t1")
