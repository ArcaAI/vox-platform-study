"""Multi-tenant speaker embedding store backed by Qdrant.

Design decisions:
- Single collection with payload-based tenant filtering (Qdrant recommended)
- ``is_tenant=True`` on ``tenant_id`` index for co-located storage
- HNSW: global index disabled (m=0), per-tenant payload index (payload_m=16)
- 512-dimensional cosine similarity (pyannote/embedding output)
- ``created_at`` integer timestamp for manual TTL/cleanup
- All queries enforce ``tenant_id`` filter — no cross-tenant leakage
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from ...core.config.settings import get_settings
from ...core.exceptions import SpeakerEmbeddingError, VectorStoreConnectionError
from .client import QdrantClientManager, get_qdrant_client

logger = logging.getLogger(__name__)

# pyannote/embedding output dimension
_EMBEDDING_DIM = 512


class SpeakerEmbeddingStore:
    """CRUD operations for speaker embeddings with multi-tenant isolation."""

    def __init__(self, client_manager: QdrantClientManager | None = None) -> None:
        self._client_manager = client_manager or get_qdrant_client()
        self._collection_name: str | None = None
        self._initialised = False

    @property
    def collection_name(self) -> str:
        if self._collection_name is None:
            self._collection_name = get_settings().qdrant_collection_speakers
        return self._collection_name

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def ensure_collection(self) -> None:
        """Create the speaker embeddings collection if it does not exist.

        Idempotent — safe to call on every startup.
        """
        if self._initialised:
            return

        try:
            from qdrant_client import models

            client = await self._client_manager.get_client()

            if await client.collection_exists(self.collection_name):
                self._initialised = True
                logger.info("Qdrant collection '%s' already exists", self.collection_name)
                return

            # Create collection optimised for multi-tenant 512-dim cosine
            await client.create_collection(
                collection_name=self.collection_name,
                vectors_config=models.VectorParams(
                    size=_EMBEDDING_DIM,
                    distance=models.Distance.COSINE,
                ),
                hnsw_config=models.HnswConfigDiff(
                    m=0,  # Disable global HNSW index
                    payload_m=16,  # Per-tenant payload-based index
                    ef_construct=200,  # Balanced quality / speed
                ),
                optimizers_config=models.OptimizersConfigDiff(
                    indexing_threshold=20000,  # Begin indexing after 20 k points
                ),
            )
            logger.info("Created Qdrant collection '%s'", self.collection_name)

            # Tenant index with is_tenant=True
            try:
                await client.create_payload_index(
                    collection_name=self.collection_name,
                    field_name="tenant_id",
                    field_schema=models.KeywordIndexParams(
                        type=models.KeywordIndexType.KEYWORD,
                        is_tenant=True,
                    ),
                )
            except Exception:
                # Fallback for older Qdrant versions without is_tenant
                await client.create_payload_index(
                    collection_name=self.collection_name,
                    field_name="tenant_id",
                    field_schema=models.PayloadSchemaType.KEYWORD,
                )
            logger.info("Created tenant_id index on '%s'", self.collection_name)

            # Additional indexes for filtering
            for field_name in ("speaker_id", "consultation_id"):
                await client.create_payload_index(
                    collection_name=self.collection_name,
                    field_name=field_name,
                    field_schema=models.PayloadSchemaType.KEYWORD,
                )

            # Timestamp index for TTL cleanup
            await client.create_payload_index(
                collection_name=self.collection_name,
                field_name="created_at",
                field_schema=models.PayloadSchemaType.INTEGER,
            )

            self._initialised = True

        except Exception as e:
            raise VectorStoreConnectionError(
                f"Failed to ensure Qdrant collection: {e}"
            ) from e

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------

    async def upsert_embedding(
        self,
        tenant_id: str,
        speaker_id: str,
        embedding: list[float],
        consultation_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """Store a speaker embedding vector.

        Args:
            tenant_id: Tenant identifier (required for isolation).
            speaker_id: Unique speaker identifier.
            embedding: 512-dimensional float vector.
            consultation_id: Optional consultation context.
            metadata: Additional payload fields.

        Returns:
            Point ID as string.
        """
        from qdrant_client import models

        await self.ensure_collection()
        client = await self._client_manager.get_client()

        point_id = uuid.uuid4().hex
        timestamp = int(datetime.now(UTC).timestamp())

        payload: dict[str, Any] = {
            "tenant_id": tenant_id,
            "speaker_id": speaker_id,
            "created_at": timestamp,
        }
        if consultation_id:
            payload["consultation_id"] = consultation_id
        if metadata:
            payload.update(metadata)

        try:
            await client.upsert(
                collection_name=self.collection_name,
                points=[
                    models.PointStruct(
                        id=point_id,
                        vector=embedding,
                        payload=payload,
                    )
                ],
                wait=True,
            )
            logger.debug(
                "Upserted speaker embedding: tenant=%s speaker=%s", tenant_id, speaker_id
            )
            return point_id

        except Exception as e:
            raise SpeakerEmbeddingError(f"Failed to upsert embedding: {e}") from e

    async def search_similar(
        self,
        tenant_id: str,
        query_embedding: list[float],
        limit: int = 5,
        score_threshold: float | None = None,
        consultation_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Search for similar speaker embeddings within a tenant.

        Args:
            tenant_id: Tenant to search within.
            query_embedding: 512-dim query vector.
            limit: Max results.
            score_threshold: Minimum cosine similarity (0–1).
            consultation_id: Optional extra filter.

        Returns:
            List of dicts with ``speaker_id``, ``score``, ``payload``.
        """
        from qdrant_client import models

        await self.ensure_collection()
        client = await self._client_manager.get_client()

        settings = get_settings()
        threshold = score_threshold or settings.diarization_similarity_threshold

        filter_conditions: list[Any] = [
            models.FieldCondition(
                key="tenant_id",
                match=models.MatchValue(value=tenant_id),
            )
        ]
        if consultation_id:
            filter_conditions.append(
                models.FieldCondition(
                    key="consultation_id",
                    match=models.MatchValue(value=consultation_id),
                )
            )

        try:
            results = await client.search(
                collection_name=self.collection_name,
                query_vector=query_embedding,
                query_filter=models.Filter(must=filter_conditions),
                limit=limit,
                score_threshold=threshold,
            )

            return [
                {
                    "point_id": str(r.id),
                    "speaker_id": r.payload.get("speaker_id", ""),
                    "score": r.score,
                    "payload": r.payload,
                }
                for r in results
            ]

        except Exception as e:
            raise SpeakerEmbeddingError(f"Failed to search embeddings: {e}") from e

    async def get_speakers_for_tenant(
        self,
        tenant_id: str,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        """List all distinct speakers for a tenant.

        Returns list of dicts with ``speaker_id`` and ``embedding_count``.
        """
        from qdrant_client import models

        await self.ensure_collection()
        client = await self._client_manager.get_client()

        try:
            results, _ = await client.scroll(
                collection_name=self.collection_name,
                scroll_filter=models.Filter(
                    must=[
                        models.FieldCondition(
                            key="tenant_id",
                            match=models.MatchValue(value=tenant_id),
                        )
                    ]
                ),
                limit=limit,
                with_payload=True,
                with_vectors=False,
            )

            speakers: dict[str, int] = {}
            for point in results:
                sid = point.payload.get("speaker_id", "unknown")
                speakers[sid] = speakers.get(sid, 0) + 1

            return [
                {"speaker_id": sid, "embedding_count": count}
                for sid, count in speakers.items()
            ]

        except Exception as e:
            raise SpeakerEmbeddingError(f"Failed to list speakers: {e}") from e

    async def delete_speaker(
        self,
        tenant_id: str,
        speaker_id: str,
    ) -> int:
        """Delete all embeddings for a specific speaker.

        Returns:
            Number of points deleted.
        """
        from qdrant_client import models

        await self.ensure_collection()
        client = await self._client_manager.get_client()

        try:
            # Scroll to find point IDs
            results, _ = await client.scroll(
                collection_name=self.collection_name,
                scroll_filter=models.Filter(
                    must=[
                        models.FieldCondition(
                            key="tenant_id",
                            match=models.MatchValue(value=tenant_id),
                        ),
                        models.FieldCondition(
                            key="speaker_id",
                            match=models.MatchValue(value=speaker_id),
                        ),
                    ]
                ),
                limit=10000,
                with_payload=False,
                with_vectors=False,
            )

            if not results:
                return 0

            point_ids = [str(p.id) for p in results]
            await client.delete(
                collection_name=self.collection_name,
                points_selector=models.PointIdsList(points=point_ids),
                wait=True,
            )
            logger.info(
                "Deleted %d embeddings for speaker %s (tenant=%s)",
                len(point_ids),
                speaker_id,
                tenant_id,
            )
            return len(point_ids)

        except Exception as e:
            raise SpeakerEmbeddingError(f"Failed to delete speaker: {e}") from e

    async def cleanup_expired(
        self,
        tenant_id: str,
        expiration_days: int = 90,
    ) -> int:
        """Delete embeddings older than *expiration_days* for a tenant.

        Returns:
            Number of points deleted.
        """
        from qdrant_client import models

        await self.ensure_collection()
        client = await self._client_manager.get_client()

        cutoff = int((datetime.now(UTC) - timedelta(days=expiration_days)).timestamp())

        try:
            # Use filter-based delete
            _result = await client.delete(
                collection_name=self.collection_name,
                points_selector=models.FilterSelector(
                    filter=models.Filter(
                        must=[
                            models.FieldCondition(
                                key="tenant_id",
                                match=models.MatchValue(value=tenant_id),
                            ),
                            models.FieldCondition(
                                key="created_at",
                                range=models.Range(lt=cutoff),
                            ),
                        ]
                    )
                ),
                wait=True,
            )
            logger.info(
                "Cleaned up expired embeddings for tenant %s (cutoff=%d days)",
                tenant_id,
                expiration_days,
            )
            return 0  # Qdrant delete doesn't return count; log instead

        except Exception as e:
            raise SpeakerEmbeddingError(f"Failed to cleanup expired embeddings: {e}") from e


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_store: SpeakerEmbeddingStore | None = None


def get_speaker_store() -> SpeakerEmbeddingStore:
    """Get singleton speaker embedding store."""
    global _store
    if _store is None:
        _store = SpeakerEmbeddingStore()
    return _store
