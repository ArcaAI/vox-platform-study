# Qdrant Quick Reference Guide

**Quick Commands for STT Orchestra Development**

---

## 🚀 Quick Start

```bash
# Start Qdrant
docker-compose -f docker-compose.stt-dev.yml up -d qdrant

# Initialize collection
docker-compose -f docker-compose.stt-dev.yml up qdrant-init

# Verify setup
./scripts/test-qdrant-setup.sh

# Check health
curl http://localhost:6333/health
```

---

## 📊 Collection Management

### Check Collection Status

```bash
# List all collections
curl http://localhost:6333/collections | jq

# Get specific collection
curl http://localhost:6333/collections/stt_speaker_embeddings | jq

# Get collection stats
curl http://localhost:6333/collections/stt_speaker_embeddings | \
  jq '{points: .result.points_count, vectors: .result.vectors_count}'
```

### Collection Info

```bash
# Full collection info
curl http://localhost:6333/collections/stt_speaker_embeddings | jq '.result'

# Vector configuration
curl http://localhost:6333/collections/stt_speaker_embeddings | \
  jq '.result.config.params.vectors'
```

---

## ➕ Insert/Update Operations

### Insert Single Point

```bash
curl -X PUT http://localhost:6333/collections/stt_speaker_embeddings/points \
  -H 'Content-Type: application/json' \
  -d '{
    "points": [
      {
        "id": "tenant_speaker_001_1704902400",
        "vector": ['"$(python3 -c 'print(",".join(["0.1"] * 512))')"'],
        "payload": {
          "speaker_code": "SPEAKER_001",
          "speaker_name": "John Doe",
          "tenant_id": "123e4567-e89b-12d3-a456-426614174000",
          "created_at": "2025-01-10T10:00:00Z"
        }
      }
    ]
  }' | jq
```

### Insert Multiple Points (Python)

```python
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct

client = QdrantClient(host="localhost", port=6333)

points = [
    PointStruct(
        id=f"tenant_speaker_{i}_1704902400",
        vector=[0.1] * 512,
        payload={
            "speaker_code": f"SPEAKER_{i:03d}",
            "speaker_name": f"Speaker {i}",
            "tenant_id": "123e4567-e89b-12d3-a456-426614174000"
        }
    )
    for i in range(1, 11)
]

client.upsert(collection_name="stt_speaker_embeddings", points=points)
print(f"Inserted {len(points)} points")
```

---

## 🔍 Search Operations

### Basic Search

```bash
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/points/search \
  -H 'Content-Type: application/json' \
  -d '{
    "vector": ['"$(python3 -c 'print(",".join(["0.1"] * 512))')"'],
    "limit": 5,
    "with_payload": true
  }' | jq
```

### Search with Tenant Filter

```bash
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/points/search \
  -H 'Content-Type: application/json' \
  -d '{
    "vector": ['"$(python3 -c 'print(",".join(["0.1"] * 512))')"'],
    "limit": 5,
    "with_payload": true,
    "filter": {
      "must": [
        {
          "key": "tenant_id",
          "match": {
            "value": "123e4567-e89b-12d3-a456-426614174000"
          }
        }
      ]
    }
  }' | jq
```

### Search with Multiple Filters (Python)

```python
from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchValue

client = QdrantClient(host="localhost", port=6333)

# Search with tenant and speaker code filter
results = client.search(
    collection_name="stt_speaker_embeddings",
    query_vector=[0.1] * 512,
    limit=5,
    query_filter=Filter(
        must=[
            FieldCondition(key="tenant_id", match=MatchValue(value="tenant-uuid")),
            FieldCondition(key="speaker_code", match=MatchValue(value="SPEAKER_001"))
        ]
    )
)

for result in results:
    print(f"ID: {result.id}")
    print(f"Score: {result.score}")
    print(f"Speaker: {result.payload['speaker_code']}")
    print("---")
```

### Search with Score Threshold

```python
# Only return results with similarity > 0.7
results = client.search(
    collection_name="stt_speaker_embeddings",
    query_vector=[0.1] * 512,
    limit=10,
    score_threshold=0.7  # Cosine similarity threshold
)
```

---

## 📖 Read Operations

### Get Point by ID

```bash
# Single point
curl -X GET http://localhost:6333/collections/stt_speaker_embeddings/points/tenant_speaker_001_1704902400 | jq

# Multiple points
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/points \
  -H 'Content-Type: application/json' \
  -d '{
    "ids": [
      "tenant_speaker_001_1704902400",
      "tenant_speaker_002_1704902400"
    ]
  }' | jq
```

### Scroll Through All Points

```bash
# Get first 10 points
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/points/scroll \
  -H 'Content-Type: application/json' \
  -d '{
    "limit": 10,
    "with_payload": true,
    "with_vector": false
  }' | jq

# Scroll with filter
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/points/scroll \
  -H 'Content-Type: application/json' \
  -d '{
    "limit": 10,
    "with_payload": true,
    "filter": {
      "must": [
        {"key": "tenant_id", "match": {"value": "tenant-uuid"}}
      ]
    }
  }' | jq
```

### Count Points

```bash
# Total points
curl http://localhost:6333/collections/stt_speaker_embeddings | \
  jq '.result.points_count'

# Count with filter (Python)
python3 << EOF
from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchValue

client = QdrantClient(host="localhost", port=6333)

count = client.count(
    collection_name="stt_speaker_embeddings",
    count_filter=Filter(
        must=[FieldCondition(key="tenant_id", match=MatchValue(value="tenant-uuid"))]
    )
)

print(f"Points for tenant: {count.count}")
EOF
```

---

## 🗑️ Delete Operations

### Delete by Point IDs

```bash
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/points/delete \
  -H 'Content-Type: application/json' \
  -d '{
    "points": [
      "tenant_speaker_001_1704902400",
      "tenant_speaker_002_1704902400"
    ]
  }' | jq
```

### Delete by Filter

```bash
# Delete all test points
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/points/delete \
  -H 'Content-Type: application/json' \
  -d '{
    "filter": {
      "must": [
        {
          "key": "test",
          "match": {"value": true}
        }
      ]
    }
  }' | jq
```

### Delete All Points in Tenant (Python)

```python
from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchValue

client = QdrantClient(host="localhost", port=6333)

# Delete all points for a specific tenant
client.delete(
    collection_name="stt_speaker_embeddings",
    points_selector=Filter(
        must=[
            FieldCondition(
                key="tenant_id",
                match=MatchValue(value="tenant-to-delete")
            )
        ]
    )
)
```

---

## 🔄 Update Operations

### Update Point Payload

```bash
# Set/update specific fields
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/points/payload \
  -H 'Content-Type: application/json' \
  -d '{
    "payload": {
      "speaker_name": "Updated Name",
      "updated_at": "2025-01-10T12:00:00Z"
    },
    "points": ["tenant_speaker_001_1704902400"]
  }' | jq
```

### Delete Payload Keys

```bash
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/points/payload/delete \
  -H 'Content-Type: application/json' \
  -d '{
    "keys": ["temporary_field", "old_metadata"],
    "points": ["tenant_speaker_001_1704902400"]
  }' | jq
```

---

## 📈 Monitoring & Metrics

### Health Check

```bash
curl http://localhost:6333/health
```

### Prometheus Metrics

```bash
curl http://localhost:6333/metrics
```

### Collection Metrics

```bash
curl http://localhost:6333/collections/stt_speaker_embeddings | \
  jq '{
    collection: .result.name,
    points: .result.points_count,
    vectors: .result.vectors_count,
    status: .result.status,
    optimizer_status: .result.optimizer_status
  }'
```

---

## 🔧 Maintenance Operations

### Create Snapshot

```bash
# Create collection snapshot
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/snapshots | jq

# List snapshots
curl http://localhost:6333/collections/stt_speaker_embeddings/snapshots | jq

# Download snapshot
SNAPSHOT_NAME="stt_speaker_embeddings-2025-01-10-snapshot.snapshot"
curl http://localhost:6333/collections/stt_speaker_embeddings/snapshots/$SNAPSHOT_NAME \
  --output backup.snapshot
```

### Optimize Collection

```bash
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/optimize | jq
```

### Clear Collection (Delete All Points)

```bash
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/points/delete \
  -H 'Content-Type: application/json' \
  -d '{"filter": {}}' | jq
```

### Delete and Recreate Collection

```bash
# Delete collection
curl -X DELETE http://localhost:6333/collections/stt_speaker_embeddings | jq

# Recreate (run init script)
docker-compose -f docker-compose.stt-dev.yml up qdrant-init
```

---

## 🐍 Python Integration Examples

### Basic Connection

```python
from qdrant_client import QdrantClient

# Connect
client = QdrantClient(host="localhost", port=6333)

# Test connection
collections = client.get_collections()
print(f"Available collections: {[c.name for c in collections.collections]}")
```

### Complete Speaker Recognition Example

```python
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct, Filter, FieldCondition, MatchValue
import uuid
from datetime import datetime

class SpeakerDatabase:
    def __init__(self, host="localhost", port=6333):
        self.client = QdrantClient(host=host, port=port)
        self.collection = "stt_speaker_embeddings"

    def register_speaker(self, embedding, speaker_code, tenant_id, speaker_name=None):
        """Register new speaker"""
        point_id = f"{tenant_id}_{speaker_code}_{int(datetime.now().timestamp())}"

        point = PointStruct(
            id=point_id,
            vector=embedding,
            payload={
                "speaker_code": speaker_code,
                "speaker_name": speaker_name,
                "tenant_id": tenant_id,
                "created_at": datetime.now().isoformat()
            }
        )

        self.client.upsert(collection_name=self.collection, points=[point])
        return point_id

    def identify_speaker(self, embedding, tenant_id, threshold=0.7):
        """Identify speaker from embedding"""
        results = self.client.search(
            collection_name=self.collection,
            query_vector=embedding,
            limit=1,
            score_threshold=threshold,
            query_filter=Filter(
                must=[
                    FieldCondition(key="tenant_id", match=MatchValue(value=tenant_id))
                ]
            )
        )

        if results:
            return {
                "matched": True,
                "speaker_code": results[0].payload["speaker_code"],
                "speaker_name": results[0].payload.get("speaker_name"),
                "confidence": results[0].score
            }
        return {"matched": False}

    def update_speaker_name(self, speaker_code, tenant_id, new_name):
        """Update speaker name"""
        # Find all points for this speaker
        points = self.client.scroll(
            collection_name=self.collection,
            scroll_filter=Filter(
                must=[
                    FieldCondition(key="tenant_id", match=MatchValue(value=tenant_id)),
                    FieldCondition(key="speaker_code", match=MatchValue(value=speaker_code))
                ]
            ),
            limit=100
        )[0]

        # Update payload
        point_ids = [point.id for point in points]
        self.client.set_payload(
            collection_name=self.collection,
            payload={"speaker_name": new_name, "updated_at": datetime.now().isoformat()},
            points=point_ids
        )

        return len(point_ids)

# Usage
db = SpeakerDatabase()

# Register speaker
embedding = [0.1] * 512  # From Pyannote
speaker_id = db.register_speaker(
    embedding=embedding,
    speaker_code="SPEAKER_001",
    tenant_id=str(uuid.uuid4()),
    speaker_name="John Doe"
)

# Identify speaker
result = db.identify_speaker(embedding=[0.1] * 512, tenant_id="tenant-uuid")
print(f"Matched: {result['matched']}, Speaker: {result.get('speaker_code')}")

# Update name
updated = db.update_speaker_name("SPEAKER_001", "tenant-uuid", "Jonathan Doe")
print(f"Updated {updated} points")
```

---

## 🐛 Debugging

### View Container Logs

```bash
docker logs hope-qdrant -f
```

### Check Resource Usage

```bash
docker stats hope-qdrant
```

### Test with Python

```python
# Quick connection test
from qdrant_client import QdrantClient

try:
    client = QdrantClient(host="localhost", port=6333, timeout=5)
    health = client.http.healthcheck()
    print(f"✓ Qdrant is healthy: {health}")

    collection = client.get_collection("stt_speaker_embeddings")
    print(f"✓ Collection exists: {collection.name}")
    print(f"  - Points: {collection.points_count}")
    print(f"  - Vectors: {collection.vectors_count}")
except Exception as e:
    print(f"✗ Error: {e}")
```

---

## 📚 Reference

- **Collection**: `stt_speaker_embeddings`
- **Vector Size**: 512 dimensions
- **Distance**: Cosine similarity
- **HTTP Port**: 6333
- **gRPC Port**: 6334
- **Docs**: https://qdrant.tech/documentation/

---

**Quick Links**:

- [Full Setup Guide](./QDRANT-SETUP.md)
- [Test Script](./scripts/test-qdrant-setup.sh)
- [STT Orchestra README](./README-STT-ORCHESTRA.md)
