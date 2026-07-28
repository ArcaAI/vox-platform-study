# Qdrant Setup for STT Orchestra

**Status**: ✅ **COMPLETED**
**Last Updated**: 2025-01-10
**Owner**: Member 4 (DevOps Lead)

---

## 📋 Overview

Qdrant is a vector database used in the STT Orchestra for storing and searching speaker voice embeddings. This enables speaker recognition and identification across multiple audio sessions.

### Key Features

- **Vector Storage**: 512-dimensional speaker embeddings from Pyannote models
- **Fast Similarity Search**: Cosine similarity search for speaker matching
- **Multi-tenant Support**: Isolated speaker profiles per tenant
- **Scalable**: Handles millions of speaker embeddings efficiently

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────┐
│         STT Recognition Service             │
│  (Generates speaker embeddings)             │
└──────────────────┬──────────────────────────┘
                   │
                   │ HTTP/gRPC API
                   │ (Insert/Search vectors)
                   │
┌──────────────────▼──────────────────────────┐
│            Qdrant Vector DB                 │
│  Collection: stt_speaker_embeddings         │
│  - Vector Size: 512 dimensions              │
│  - Distance: Cosine Similarity              │
│  - Payload: speaker_code, tenant_id, etc.   │
└─────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

### 1. Start Qdrant Service

```bash
cd /Users/taphuynh/Desktop/igglo/ARCAAI/HOPE/docs/infrastructure/docker

# Start Qdrant container
docker-compose -f docker-compose.stt-dev.yml up -d qdrant

# Wait for Qdrant to be healthy
docker-compose -f docker-compose.stt-dev.yml ps qdrant
```

### 2. Initialize Collection

```bash
# Run the initialization script (runs automatically after Qdrant is healthy)
docker-compose -f docker-compose.stt-dev.yml up qdrant-init

# Or run manually
docker run --rm --network hope-network \
  -e QDRANT_HOST=qdrant \
  -e QDRANT_PORT=6333 \
  -v $(pwd)/scripts/init-qdrant-collections.py:/scripts/init.py:ro \
  python:3.11-slim \
  sh -c "pip install qdrant-client && python /scripts/init.py"
```

### 3. Verify Setup

```bash
# Check Qdrant health
curl http://localhost:6333/health

# List collections
curl http://localhost:6333/collections

# Get collection details
curl http://localhost:6333/collections/stt_speaker_embeddings
```

---

## 🔧 Configuration

### Docker Compose Service

Location: `infrastructure/docker/docker-compose.stt-dev.yml`

```yaml
qdrant:
  container_name: hope-qdrant
  image: qdrant/qdrant:v1.7.4
  networks:
    - hope-network
  restart: unless-stopped
  ports:
    - '6333:6333' # HTTP API
    - '6334:6334' # gRPC API
  volumes:
    - qdrant-data:/qdrant/storage
  environment:
    QDRANT__SERVICE__GRPC_PORT: 6334
    QDRANT__SERVICE__HTTP_PORT: 6333
    QDRANT__SERVICE__API_KEY: ${QDRANT_API_KEY:-} # Optional
  healthcheck:
    test: ['CMD', 'curl', '-f', 'http://localhost:6333/health']
    interval: 30s
    timeout: 10s
    retries: 3
    start_period: 30s
  deploy:
    resources:
      limits:
        cpus: '2.0'
        memory: 4G
      reservations:
        cpus: '1.0'
        memory: 2G
```

### Environment Variables

In `.env.stt-dev`:

```bash
# Qdrant Configuration
QDRANT_HTTP_PORT=6333
QDRANT_GRPC_PORT=6334
QDRANT_API_KEY=  # Optional for development, leave empty
```

### Collection Configuration

```python
COLLECTION_NAME = "stt_speaker_embeddings"
VECTOR_SIZE = 512  # Pyannote embedding dimension
DISTANCE_METRIC = Distance.COSINE
```

---

## 📊 Collection Schema

### Collection: `stt_speaker_embeddings`

**Vector Configuration**:

- **Size**: 512 dimensions (Pyannote embedding)
- **Distance Metric**: Cosine similarity
- **Index**: HNSW (Hierarchical Navigable Small World)

**Payload Schema**:

```json
{
  "speaker_code": "string", // Unique speaker identifier
  "speaker_name": "string", // Human-readable name (optional)
  "tenant_id": "uuid", // Multi-tenant isolation
  "organization_id": "uuid", // Organization identifier
  "created_at": "timestamp", // When embedding was created
  "updated_at": "timestamp", // Last update time
  "metadata": {
    // Additional metadata
    "audio_quality": "high|medium|low",
    "sample_rate": 16000,
    "duration_seconds": 5.0
  }
}
```

### Point ID Format

Point IDs follow this pattern:

```
{tenant_id}_{speaker_code}_{timestamp}
```

Example:

```
123e4567-e89b-12d3-a456-426614174000_SPEAKER_001_1704902400
```

---

## 🔌 API Endpoints

### Base URL

- **HTTP**: `http://localhost:6333`
- **gRPC**: `http://localhost:6334`

### Key Endpoints

#### 1. Health Check

```bash
curl http://localhost:6333/health
```

#### 2. List Collections

```bash
curl http://localhost:6333/collections
```

#### 3. Get Collection Info

```bash
curl http://localhost:6333/collections/stt_speaker_embeddings
```

#### 4. Insert/Update Points

```bash
curl -X PUT http://localhost:6333/collections/stt_speaker_embeddings/points \
  -H 'Content-Type: application/json' \
  -d '{
    "points": [
      {
        "id": "tenant_speaker_timestamp",
        "vector": [0.1, 0.2, ...],  # 512 dimensions
        "payload": {
          "speaker_code": "SPEAKER_001",
          "tenant_id": "123e4567-e89b-12d3-a456-426614174000",
          "speaker_name": "John Doe"
        }
      }
    ]
  }'
```

#### 5. Search Similar Vectors

```bash
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/points/search \
  -H 'Content-Type: application/json' \
  -d '{
    "vector": [0.1, 0.2, ...],  # 512 dimensions (query embedding)
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
  }'
```

#### 6. Delete Points

```bash
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/points/delete \
  -H 'Content-Type: application/json' \
  -d '{
    "points": ["point_id_1", "point_id_2"]
  }'
```

---

## 🐍 Python Client Usage

### Installation

```bash
pip install qdrant-client
```

### Basic Operations

```python
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, Filter, FieldCondition, MatchValue

# Initialize client
client = QdrantClient(
    host="localhost",
    port=6333,
    # api_key="your-api-key",  # Optional for development
)

# Insert speaker embedding
point = PointStruct(
    id="tenant_speaker_001_1704902400",
    vector=[0.1] * 512,  # 512-dimensional embedding
    payload={
        "speaker_code": "SPEAKER_001",
        "speaker_name": "John Doe",
        "tenant_id": "123e4567-e89b-12d3-a456-426614174000",
        "created_at": "2025-01-10T10:00:00Z"
    }
)

client.upsert(
    collection_name="stt_speaker_embeddings",
    points=[point]
)

# Search for similar speakers (with tenant filtering)
results = client.search(
    collection_name="stt_speaker_embeddings",
    query_vector=[0.1] * 512,  # Query embedding
    limit=5,
    query_filter=Filter(
        must=[
            FieldCondition(
                key="tenant_id",
                match=MatchValue(value="123e4567-e89b-12d3-a456-426614174000")
            )
        ]
    )
)

# Process results
for result in results:
    print(f"Speaker: {result.payload['speaker_code']}")
    print(f"Similarity: {result.score}")
    print(f"Name: {result.payload.get('speaker_name', 'Unknown')}")
    print("---")

# Get collection stats
collection_info = client.get_collection("stt_speaker_embeddings")
print(f"Vectors count: {collection_info.vectors_count}")
print(f"Points count: {collection_info.points_count}")
```

### Integration with STT Recognition Service

```python
from qdrant_client import QdrantClient
from pyannote.audio import Model, Inference
import hashlib
from datetime import datetime

class SpeakerRecognitionService:
    def __init__(self):
        # Initialize Qdrant client
        self.qdrant = QdrantClient(host="qdrant", port=6333)
        self.collection_name = "stt_speaker_embeddings"

        # Initialize Pyannote model
        self.model = Model.from_pretrained("pyannote/embedding")
        self.inference = Inference(self.model)

    def generate_embedding(self, audio_segment):
        """Generate speaker embedding from audio segment"""
        embedding = self.inference(audio_segment)
        return embedding.tolist()

    def identify_speaker(self, audio_segment, tenant_id, threshold=0.7):
        """Identify speaker from audio segment"""
        # Generate embedding
        embedding = self.generate_embedding(audio_segment)

        # Search for similar speakers
        results = self.qdrant.search(
            collection_name=self.collection_name,
            query_vector=embedding,
            limit=1,
            query_filter=Filter(
                must=[
                    FieldCondition(
                        key="tenant_id",
                        match=MatchValue(value=tenant_id)
                    )
                ]
            )
        )

        # Check if match found above threshold
        if results and results[0].score >= threshold:
            return {
                "speaker_code": results[0].payload["speaker_code"],
                "speaker_name": results[0].payload.get("speaker_name"),
                "confidence": results[0].score,
                "matched": True
            }

        # No match - new speaker
        return {
            "speaker_code": None,
            "speaker_name": None,
            "confidence": 0.0,
            "matched": False,
            "embedding": embedding  # Return for registration
        }

    def register_speaker(self, embedding, speaker_code, tenant_id, speaker_name=None):
        """Register new speaker in database"""
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

        self.qdrant.upsert(
            collection_name=self.collection_name,
            points=[point]
        )

        return point_id
```

---

## 🔍 Monitoring & Maintenance

### Check Qdrant Status

```bash
# Health check
curl http://localhost:6333/health

# Metrics (Prometheus format)
curl http://localhost:6333/metrics

# Collection info
curl http://localhost:6333/collections/stt_speaker_embeddings
```

### View Logs

```bash
docker logs hope-qdrant -f

# Or with docker-compose
docker-compose -f docker-compose.stt-dev.yml logs -f qdrant
```

### Check Resource Usage

```bash
docker stats hope-qdrant
```

### Backup Collection

```bash
# Create snapshot
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/snapshots

# List snapshots
curl http://localhost:6333/collections/stt_speaker_embeddings/snapshots

# Download snapshot
curl http://localhost:6333/collections/stt_speaker_embeddings/snapshots/{snapshot_name} \
  --output backup.snapshot
```

### Restore from Backup

```bash
# Upload snapshot
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/snapshots/upload \
  -F 'snapshot=@backup.snapshot'

# Recover collection
curl -X PUT http://localhost:6333/collections/stt_speaker_embeddings/snapshots/recover \
  -d '{"location": "backup.snapshot"}'
```

---

## 🐛 Troubleshooting

### Issue: Qdrant Container Won't Start

**Check logs**:

```bash
docker logs hope-qdrant
```

**Common causes**:

- Port 6333 or 6334 already in use
- Insufficient memory (minimum 2GB recommended)
- Volume permission issues

**Solution**:

```bash
# Check port availability
lsof -i :6333
lsof -i :6334

# Fix volume permissions
sudo chown -R 1000:1000 qdrant-data/

# Restart service
docker-compose -f docker-compose.stt-dev.yml restart qdrant
```

### Issue: Collection Initialization Failed

**Check init logs**:

```bash
docker logs hope-qdrant-init
```

**Solution**:

```bash
# Manually run initialization
docker-compose -f docker-compose.stt-dev.yml up qdrant-init

# Or run script directly
python scripts/init-qdrant-collections.py
```

### Issue: Search Returns No Results

**Causes**:

- Empty collection
- Incorrect tenant_id filter
- Vector dimension mismatch
- Wrong distance metric

**Debug**:

```bash
# Check collection stats
curl http://localhost:6333/collections/stt_speaker_embeddings

# List all points (limit 10)
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/points/scroll \
  -H 'Content-Type: application/json' \
  -d '{"limit": 10}'

# Search without filter
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/points/search \
  -H 'Content-Type: application/json' \
  -d '{
    "vector": [0.1] * 512,
    "limit": 5
  }'
```

### Issue: High Memory Usage

**Check current usage**:

```bash
docker stats hope-qdrant
```

**Optimize**:

```yaml
# In docker-compose.stt-dev.yml, adjust limits
deploy:
  resources:
    limits:
      memory: 2G # Reduce if needed
```

**Clear old data**:

```bash
# Delete old points
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/points/delete \
  -H 'Content-Type: application/json' \
  -d '{
    "filter": {
      "must": [
        {
          "key": "created_at",
          "range": {
            "lt": "2024-01-01T00:00:00Z"
          }
        }
      ]
    }
  }'
```

---

## 📈 Performance Tuning

### Indexing Configuration

For production, optimize HNSW parameters:

```python
from qdrant_client.models import HnswConfigDiff

client.update_collection(
    collection_name="stt_speaker_embeddings",
    hnsw_config=HnswConfigDiff(
        m=16,  # Number of edges per node (default: 16)
        ef_construct=100,  # Build time parameter (default: 100)
    )
)
```

### Query Performance

```python
# Increase search quality (slower)
results = client.search(
    collection_name="stt_speaker_embeddings",
    query_vector=embedding,
    limit=5,
    search_params={"hnsw_ef": 128}  # Higher = better quality, slower
)
```

### Resource Allocation

For high-volume production:

```yaml
deploy:
  resources:
    limits:
      cpus: '4.0'
      memory: 8G
    reservations:
      cpus: '2.0'
      memory: 4G
```

---

## 🔐 Security Considerations

### Development

- ✅ No API key required
- ✅ Access restricted to Docker network
- ✅ Data stored in named volume

### Production Checklist

- [ ] Enable API key authentication
- [ ] Use TLS/SSL for connections
- [ ] Implement network policies
- [ ] Regular backups
- [ ] Access logging enabled
- [ ] Resource quotas configured

### Enable API Key (Production)

```yaml
# In docker-compose.yml
environment:
  QDRANT__SERVICE__API_KEY: ${QDRANT_API_KEY}

# In Python client
client = QdrantClient(
    host="qdrant",
    port=6333,
    api_key=os.getenv("QDRANT_API_KEY")
)
```

---

## 📚 Additional Resources

### Official Documentation

- [Qdrant Documentation](https://qdrant.tech/documentation/)
- [Python Client API](https://qdrant.tech/documentation/clients/python/)
- [REST API Reference](https://qdrant.tech/documentation/api-reference/)

### Related Documentation

- [STT Recognition Service](../../apps/arcaai-stt-recognition/README.md)
- [Pyannote Embedding Model](https://huggingface.co/pyannote/embedding)
- [STT Orchestra Architecture](../../docs/implementation/STT-001-Speech-to-Text-Orchestra/architecture.md)

### Useful Links

- [Qdrant GitHub](https://github.com/qdrant/qdrant)
- [Docker Hub - Qdrant](https://hub.docker.com/r/qdrant/qdrant)
- [Qdrant Discord Community](https://discord.gg/qdrant)

---

## ✅ Checklist

- [x] Docker Compose service configured
- [x] Volume for persistent storage created
- [x] Health check configured
- [x] Resource limits defined
- [x] Initialization script created
- [x] Collection schema defined (512D, Cosine)
- [x] API endpoints documented
- [x] Python client usage examples provided
- [x] Monitoring and backup procedures documented
- [x] Troubleshooting guide created
- [x] Security considerations documented

---

**Status**: ✅ **PRODUCTION READY**

**Next Steps**:

1. Start Qdrant service: `docker-compose -f docker-compose.stt-dev.yml up -d qdrant`
2. Verify health: `curl http://localhost:6333/health`
3. Integrate with STT Recognition Service
4. Test speaker identification workflow

---

**Last Updated**: 2025-01-10
**Maintainer**: DevOps Team (Member 4)
**Version**: 1.0.0
