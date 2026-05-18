#!/usr/bin/env python3
"""
HOPE - Qdrant Collection Initialization Script
Creates collections for speaker embeddings and context item embeddings
"""

import os
import sys
import time
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, PayloadSchemaType

# Configuration
QDRANT_HOST = os.getenv("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.getenv("QDRANT_PORT", "6333"))
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY", None)

# STT Speaker Embeddings Collection
STT_COLLECTION_NAME = "stt_speaker_embeddings"
STT_VECTOR_SIZE = 512  # Pyannote embedding dimension

# Context Items Collection (for semantic search)
CONTEXT_ITEMS_COLLECTION = "context_items"
CONTEXT_ITEMS_VECTOR_SIZE = 1536  # OpenAI embedding dimension

DISTANCE_METRIC = Distance.COSINE


def create_context_items_collection(client: QdrantClient):
    """Create collection for context item embeddings"""
    print()
    print("=" * 60)
    print("Creating Context Items Collection")
    print("=" * 60)

    try:
        collections = client.get_collections().collections
        collection_names = [col.name for col in collections]

        if CONTEXT_ITEMS_COLLECTION in collection_names:
            print(f"✓ Collection '{CONTEXT_ITEMS_COLLECTION}' already exists")
            collection_info = client.get_collection(CONTEXT_ITEMS_COLLECTION)
            print(f"  - Vectors count: {collection_info.vectors_count}")
            print(f"  - Points count: {collection_info.points_count}")
            return

        # Create collection
        client.create_collection(
            collection_name=CONTEXT_ITEMS_COLLECTION,
            vectors_config=VectorParams(
                size=CONTEXT_ITEMS_VECTOR_SIZE,
                distance=DISTANCE_METRIC
            )
        )
        print(f"✓ Collection '{CONTEXT_ITEMS_COLLECTION}' created")

        # Create payload indexes for filtering
        client.create_payload_index(
            collection_name=CONTEXT_ITEMS_COLLECTION,
            field_name="tenant_id",
            field_schema=PayloadSchemaType.KEYWORD
        )
        client.create_payload_index(
            collection_name=CONTEXT_ITEMS_COLLECTION,
            field_name="consultation_id",
            field_schema=PayloadSchemaType.KEYWORD
        )
        client.create_payload_index(
            collection_name=CONTEXT_ITEMS_COLLECTION,
            field_name="type",
            field_schema=PayloadSchemaType.KEYWORD
        )
        client.create_payload_index(
            collection_name=CONTEXT_ITEMS_COLLECTION,
            field_name="context_item_id",
            field_schema=PayloadSchemaType.KEYWORD
        )
        print("✓ Payload indexes created for context_items")

    except Exception as e:
        print(f"✗ Failed to create context_items collection: {e}")
        raise


# Legacy alias for backwards compatibility
COLLECTION_NAME = STT_COLLECTION_NAME
VECTOR_SIZE = STT_VECTOR_SIZE

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

    # Check if collection already exists
    print(f"Checking if collection '{COLLECTION_NAME}' exists...")
    try:
        collections = client.get_collections().collections
        collection_names = [col.name for col in collections]

        if COLLECTION_NAME in collection_names:
            print(f"✓ Collection '{COLLECTION_NAME}' already exists")

            # Get collection info
            collection_info = client.get_collection(COLLECTION_NAME)
            print(f"  - Vectors count: {collection_info.vectors_count}")
            print(f"  - Points count: {collection_info.points_count}")
            print(f"  - Vector size: {collection_info.config.params.vectors.size}")
            print(f"  - Distance metric: {collection_info.config.params.vectors.distance}")
            print()
            print("Collection is ready to use!")
            return

    except Exception as e:
        print(f"⚠ Could not check existing collections: {e}")

    # Create collection
    print(f"Creating collection '{COLLECTION_NAME}'...")
    try:
        client.create_collection(
            collection_name=COLLECTION_NAME,
            vectors_config=VectorParams(
                size=VECTOR_SIZE,
                distance=DISTANCE_METRIC
            )
        )
        print(f"✓ Collection '{COLLECTION_NAME}' created successfully")

        # Create payload indexes for multi-tenant filtering
        # These match the filters used by stt_v2.core.vectorstore.speaker_store
        for field in ("tenant_id", "speaker_id", "consultation_id"):
            client.create_payload_index(
                collection_name=COLLECTION_NAME,
                field_name=field,
                field_schema=PayloadSchemaType.KEYWORD,
            )
        print("✓ Payload indexes created for stt_speaker_embeddings (tenant_id, speaker_id, consultation_id)")

    except Exception as e:
        print(f"✗ Failed to create collection: {e}")
        sys.exit(1)

    print()

    # Verify collection
    print("Verifying collection configuration...")
    try:
        collection_info = client.get_collection(COLLECTION_NAME)
        print(f"✓ Collection verified:")
        print(f"  - Name: {COLLECTION_NAME}")
        print(f"  - Vector size: {collection_info.config.params.vectors.size}")
        print(f"  - Distance metric: {collection_info.config.params.vectors.distance}")
        print(f"  - Status: {collection_info.status}")
    except Exception as e:
        print(f"✗ Failed to verify collection: {e}")
        sys.exit(1)

    print()

    # Create test point to verify write operations
    print("Testing write operations...")
    try:
        test_point = PointStruct(
            id="test-point-init",
            vector=[0.0] * VECTOR_SIZE,
            payload={
                "speaker_code": "TEST_INIT",
                "speaker_name": "Test Initialization",
                "tenant_id": "00000000-0000-0000-0000-000000000000",
                "test": True
            }
        )

        client.upsert(
            collection_name=COLLECTION_NAME,
            points=[test_point]
        )
        print("✓ Write operation successful")

        # Delete test point
        client.delete(
            collection_name=COLLECTION_NAME,
            points_selector=["test-point-init"]
        )
        print("✓ Delete operation successful")

    except Exception as e:
        print(f"⚠ Write/delete test failed: {e}")

    print()

    # Test search operation
    print("Testing search operations...")
    try:
        search_results = client.search(
            collection_name=COLLECTION_NAME,
            query_vector=[0.1] * VECTOR_SIZE,
            limit=1
        )
        print(f"✓ Search operation successful (returned {len(search_results)} results)")
    except Exception as e:
        print(f"⚠ Search test failed: {e}")

    # Create context items collection
    create_context_items_collection(client)

    print()
    print("=" * 60)
    print("✓ Qdrant initialization completed successfully!")
    print("=" * 60)
    print()
    print("Collections Created:")
    print(f"  1. {STT_COLLECTION_NAME} (Vector: {STT_VECTOR_SIZE})")
    print(f"  2. {CONTEXT_ITEMS_COLLECTION} (Vector: {CONTEXT_ITEMS_VECTOR_SIZE})")
    print(f"  - Distance Metric: {DISTANCE_METRIC}")
    print(f"  - Qdrant Host: {QDRANT_HOST}:{QDRANT_PORT}")
    print()

if __name__ == "__main__":
    main()

