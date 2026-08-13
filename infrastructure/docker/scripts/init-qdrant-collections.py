#!/usr/bin/env python3
"""
HOPE - Qdrant Collection Initialization Script
Creates collections for speaker embeddings and institutional-knowledge chunks
"""

import os
import sys
import time
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    VectorParams,
    PointStruct,
    PayloadSchemaType,
    SparseVectorParams,
    Modifier,
)

# Configuration
QDRANT_HOST = os.getenv("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.getenv("QDRANT_PORT", "6333"))
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY", None)

# STT Speaker Embeddings Collection

# Knowledge Chunks Collection (institutional RAG / hybrid retrieval).
# Tenant + document + approval-scoped chunks of the institutional knowledge corpus,
# stored with a NAMED dense vector ("dense") + a NAMED sparse BM25 vector ("bm25")
# so the harness retriever can run the Qdrant Query API hybrid (prefetch dense +
# prefetch sparse -> RRF fusion). Dim must match the loaded dense embedding model
# AND apps/harness HARNESS_RETRIEVAL_EMBEDDINGS_DIM (default 1024 for BAAI/bge-m3).
KNOWLEDGE_CHUNKS_COLLECTION = os.getenv("QDRANT_KNOWLEDGE_COLLECTION", "knowledge_chunks")
KNOWLEDGE_CHUNKS_VECTOR_SIZE = int(os.getenv("QDRANT_KNOWLEDGE_DIM", "1024"))
KNOWLEDGE_DENSE_VECTOR_NAME = "dense"
KNOWLEDGE_SPARSE_VECTOR_NAME = "bm25"

DISTANCE_METRIC = Distance.COSINE


def create_knowledge_chunks_collection(client: QdrantClient):
    """Create the institutional-knowledge collection.

    Additive + idempotent: if the collection already exists it is left untouched
    (no DROP/recreate), so re-running the init script is safe. Named dense +
    sparse vectors enable the harness hybrid retriever; payload indexes back the
    tenant + APPROVED retrieval filter and Lane B's per-document chunk management.
    """
    print()
    print("=" * 60)
    print("Creating Knowledge Chunks Collection (institutional RAG)")
    print("=" * 60)

    try:
        collections = client.get_collections().collections
        collection_names = [col.name for col in collections]

        if KNOWLEDGE_CHUNKS_COLLECTION in collection_names:
            print(f"✓ Collection '{KNOWLEDGE_CHUNKS_COLLECTION}' already exists (left untouched)")
            collection_info = client.get_collection(KNOWLEDGE_CHUNKS_COLLECTION)
            print(f"  - Points count: {collection_info.points_count}")
            return

        # Named dense vector ("dense", COSINE) + named sparse vector ("bm25", IDF
        # modifier so Qdrant applies BM25 IDF scoring server-side).
        client.create_collection(
            collection_name=KNOWLEDGE_CHUNKS_COLLECTION,
            vectors_config={
                KNOWLEDGE_DENSE_VECTOR_NAME: VectorParams(
                    size=KNOWLEDGE_CHUNKS_VECTOR_SIZE,
                    distance=DISTANCE_METRIC,
                )
            },
            sparse_vectors_config={
                KNOWLEDGE_SPARSE_VECTOR_NAME: SparseVectorParams(modifier=Modifier.IDF)
            },
        )
        print(
            f"✓ Collection '{KNOWLEDGE_CHUNKS_COLLECTION}' created "
            f"(dense dim={KNOWLEDGE_CHUNKS_VECTOR_SIZE} COSINE + sparse '{KNOWLEDGE_SPARSE_VECTOR_NAME}' IDF)"
        )

        # Keyword payload indexes for the retrieval filter (tenant_id + status) and
        # Lane B's per-document chunk management (knowledge_document_id, chunk_id).
        for field in ("tenant_id", "knowledge_document_id", "status", "chunk_id"):
            client.create_payload_index(
                collection_name=KNOWLEDGE_CHUNKS_COLLECTION,
                field_name=field,
                field_schema=PayloadSchemaType.KEYWORD,
            )
        print(
            "✓ Payload indexes created for knowledge_chunks "
            "(tenant_id, knowledge_document_id, status, chunk_id)"
        )

    except Exception as e:
        print(f"✗ Failed to create knowledge_chunks collection: {e}")
        raise



def main():
    print("=" * 60)
    print("Qdrant Collection Initialization for STT Orchestra")
    print("=" * 60)
    print()

    # Wait for Qdrant to be ready and initialize client
    print(f"Waiting for Qdrant at {QDRANT_HOST}:{QDRANT_PORT}...")
    client = None
    max_retries = 30

    for attempt in range(1, max_retries + 1):
        try:
            client = QdrantClient(
                host=QDRANT_HOST,
                port=QDRANT_PORT,
                api_key=QDRANT_API_KEY,
                timeout=5
            )
            # Test connection
            client.get_collections()
            print(f"✓ Connected to Qdrant (attempt {attempt})")
            break
        except Exception as e:
            if attempt == max_retries:
                print(f"✗ Failed to connect after {max_retries} attempts: {e}")
                sys.exit(1)
            print(f"  Waiting for Qdrant... (attempt {attempt}/{max_retries})")
            time.sleep(2)

    print()

    # The stt_speaker_embeddings collection is NOT created.
    #
    # STT diarization is in-memory and session-scoped; cross-session speaker
    # identity comes from the PostgreSQL UserVoiceProfile row via
    # diarization.preseed.preseed_speaker(), not from Qdrant. The collection has
    # not been read or written by STT for some time (apps/stt/README.md:563), so
    # provisioning it created an empty collection nobody used — and, worse,
    # implied a speaker-embedding store that does not exist.

    create_knowledge_chunks_collection(client)

    print()
    print("=" * 60)
    print("✓ Qdrant initialization completed successfully!")
    print("=" * 60)
    print()
    print("Collections Created:")
    print(
        f"  2. {KNOWLEDGE_CHUNKS_COLLECTION} "
        f"(dense: {KNOWLEDGE_CHUNKS_VECTOR_SIZE} + sparse bm25)"
    )
    print(f"  - Distance Metric: {DISTANCE_METRIC}")
    print(f"  - Qdrant Host: {QDRANT_HOST}:{QDRANT_PORT}")
    print()

if __name__ == "__main__":
    main()

