# STT Orchestra - Docker Setup

This directory contains the Docker Compose configuration for the STT Orchestra development environment.

---

## 📋 Prerequisites

1. **Docker and Docker Compose** installed and running
2. **Existing infrastructure** running from `docker-compose.dev.yml`:
   - PostgreSQL
   - Redis
   - Kafka
   - MinIO
   - Prometheus
   - Grafana
   - MLflow
3. **Conda environment** `arcaai` activated
4. **Environment variables** configured

---

## 🚀 Quick Start

### Step 1: Copy Environment Variables

```bash
cp env.stt-dev.example .env.stt-dev
```

Edit `.env.stt-dev` and update:

- `AZURE_SPEECH_KEY` - Your Azure Speech Service key
- `HUGGINGFACE_TOKEN` - Your HuggingFace token
- Other credentials as needed

### Step 2: Start Base Infrastructure (if not already running)

```bash
# Start core infrastructure
docker-compose -f docker-compose.dev.yml up -d

# Verify services are running
docker-compose -f docker-compose.dev.yml ps
```

### Step 3: Create Kafka Topics

```bash
# Make script executable (if not already)
chmod +x scripts/create-stt-kafka-topics.sh

# Create all STT Kafka topics
./scripts/create-stt-kafka-topics.sh

# Verify topics were created
docker exec hope-kafka kafka-topics --bootstrap-server kafka:29092 --list | grep stt
```

### Step 4: Start STT Orchestra Services

```bash
# Start all STT services
docker-compose -f docker-compose.stt-dev.yml up -d

# View logs
docker-compose -f docker-compose.stt-dev.yml logs -f

# Check service status
docker-compose -f docker-compose.stt-dev.yml ps
```

### Step 5: Verify Services

```bash
# Check Vault
curl http://localhost:8200/v1/sys/health

# Check Qdrant
curl http://localhost:6333/health

# Check STT Orchestrator
curl http://localhost:5100/health

# Check STT VAD
curl http://localhost:5101/health

# Check STT Transcription
curl http://localhost:5102/health

# Check STT Recognition
curl http://localhost:5103/health
```

---

## 📦 Services Overview

| Service               | Container Name               | Port       | Description                            |
| --------------------- | ---------------------------- | ---------- | -------------------------------------- |
| **Vault**             | hope-vault                   | 8200       | Secret management                      |
| **Qdrant**            | hope-qdrant                  | 6333, 6334 | Vector database (speaker embeddings)   |
| **STT Orchestrator**  | arcaai-stt-orchestrator      | 5100       | Workflow coordination & job management |
| **STT VAD**           | arcaai-stt-vad               | 5101       | Voice Activity Detection (Silero)      |
| **STT Transcription** | arcaai-stt-transcription     | 5102       | Speech-to-Text (Whisper, NeMo, Azure)  |
| **STT Recognition**   | arcaai-stt-recognition       | 5103       | Speaker Recognition (Pyannote)         |
| **Realtime Workers**  | arcaai-stt-realtime-worker-* | N/A        | High-priority Celery workers           |
| **Batch Workers**     | arcaai-stt-batch-worker-*    | N/A        | Low-priority Celery workers            |

---

## 🔍 Monitoring & Debugging

### View Service Logs

```bash
# All services
docker-compose -f docker-compose.stt-dev.yml logs -f

# Specific service
docker-compose -f docker-compose.stt-dev.yml logs -f stt-orchestrator

# Follow last 100 lines
docker-compose -f docker-compose.stt-dev.yml logs -f --tail=100 stt-transcription
```

### Check Service Status

```bash
# All services
docker-compose -f docker-compose.stt-dev.yml ps

# Specific service health
docker inspect arcaai-stt-orchestrator --format='{{.State.Health.Status}}'
```

### Access Dashboards

- **Vault UI**: http://localhost:8200 (token: `root` in dev mode)
- **Grafana**: http://localhost:3001 (admin/admin)
- **Prometheus**: http://localhost:9090
- **MLflow**: http://localhost:5000
- **MinIO Console**: http://localhost:9001

### Check Celery Workers

```bash
# Check realtime workers
docker exec arcaai-stt-realtime-worker-1 celery -A stt_orchestrator.celery_app inspect active

# Check batch workers
docker exec arcaai-stt-batch-worker-1 celery -A stt_orchestrator.celery_app inspect active

# Check registered tasks
docker exec arcaai-stt-realtime-worker-1 celery -A stt_orchestrator.celery_app inspect registered

# Check worker stats
docker exec arcaai-stt-realtime-worker-1 celery -A stt_orchestrator.celery_app inspect stats
```

### Check Qdrant Collections

```bash
# Run comprehensive test suite
./scripts/test-qdrant-setup.sh

# Or manual checks:

# List collections
curl http://localhost:6333/collections

# Get collection info
curl http://localhost:6333/collections/stt_speaker_embeddings

# Check collection points
curl http://localhost:6333/collections/stt_speaker_embeddings/points

# Test search operation (requires Python 3)
python3 -c "
import json
import requests

vector = [0.1] * 512  # Test vector
response = requests.post(
    'http://localhost:6333/collections/stt_speaker_embeddings/points/search',
    json={'vector': vector, 'limit': 5}
)
print(json.dumps(response.json(), indent=2))
"
```

**Comprehensive Verification**:

```bash
# Run the automated verification script
cd infrastructure/docker
./scripts/test-qdrant-setup.sh
```

This script tests:

- ✅ Health check
- ✅ Collection existence and configuration
- ✅ Write operations
- ✅ Search operations
- ✅ Delete operations
- ✅ Metrics endpoint

### Check Vault Secrets

```bash
# Login to Vault
export VAULT_ADDR='http://localhost:8200'
export VAULT_TOKEN='root'

# List secret paths
vault kv list stt/

# Read a secret
vault kv get stt/azure/speech

# Check policies
vault policy list | grep stt
```

---

## 🛠️ Common Operations

### Restart a Service

```bash
docker-compose -f docker-compose.stt-dev.yml restart stt-orchestrator
```

### Rebuild and Restart

```bash
docker-compose -f docker-compose.stt-dev.yml up -d --build stt-transcription
```

### Stop All STT Services

```bash
docker-compose -f docker-compose.stt-dev.yml down
```

### Stop and Remove Volumes

```bash
docker-compose -f docker-compose.stt-dev.yml down -v
```

### Scale Workers

```bash
# Scale realtime workers to 3
docker-compose -f docker-compose.stt-dev.yml up -d --scale stt-realtime-worker=3

# Scale batch workers to 2
docker-compose -f docker-compose.stt-dev.yml up -d --scale stt-batch-worker=2
```

### Execute Commands in Container

```bash
# Open shell in orchestrator
docker-compose -f docker-compose.stt-dev.yml exec stt-orchestrator /bin/bash

# Run Python command
docker-compose -f docker-compose.stt-dev.yml exec stt-orchestrator python -c "import sys; print(sys.version)"
```

---

## 🐛 Troubleshooting

### Service Won't Start

1. Check logs: `docker-compose -f docker-compose.stt-dev.yml logs {service}`
2. Check dependencies are running
3. Verify environment variables in `.env.stt-dev`
4. Check port conflicts: `lsof -i :5100`

### Vault Issues

```bash
# Check Vault status
docker exec hope-vault vault status

# Re-initialize Vault
docker-compose -f docker-compose.stt-dev.yml restart vault-init
```

### Qdrant Issues

```bash
# Check Qdrant health
curl http://localhost:6333/health

# Re-initialize collection
docker-compose -f docker-compose.stt-dev.yml restart qdrant-init

# View Qdrant logs
docker-compose -f docker-compose.stt-dev.yml logs qdrant
```

### Kafka Issues

```bash
# List topics
docker exec hope-kafka kafka-topics --bootstrap-server kafka:29092 --list

# Re-create topics
./scripts/create-stt-kafka-topics.sh

# Test consumer
docker exec -it hope-kafka kafka-console-consumer \
  --bootstrap-server kafka:29092 \
  --topic stt.job.created \
  --from-beginning
```

### Worker Issues

```bash
# Check worker processes
docker-compose -f docker-compose.stt-dev.yml ps | grep worker

# Restart workers
docker-compose -f docker-compose.stt-dev.yml restart stt-realtime-worker
docker-compose -f docker-compose.stt-dev.yml restart stt-batch-worker

# Check Celery logs
docker-compose -f docker-compose.stt-dev.yml logs -f stt-realtime-worker
```

### Database Migration Issues

```bash
# Navigate to database package
cd ../../packages/database

# Check migration status
npx prisma migrate status

# Run pending migrations
npx prisma migrate dev

# Generate Prisma client
npx prisma generate
```

---

## 🧪 Testing the Setup

### Test Vault

```bash
export VAULT_ADDR='http://localhost:8200'
export VAULT_TOKEN='root'

# Read Azure Speech credentials
vault kv get stt/azure/speech

# Read HuggingFace token
vault kv get stt/huggingface/token
```

### Test Qdrant

```bash
# Create test vector
curl -X PUT http://localhost:6333/collections/stt_speaker_embeddings/points \
  -H 'Content-Type: application/json' \
  -d '{
    "points": [
      {
        "id": "test-1",
        "vector": [0.1, 0.2, ...],  # 512 dimensions
        "payload": {"speaker": "test"}
      }
    ]
  }'

# Search vectors
curl -X POST http://localhost:6333/collections/stt_speaker_embeddings/points/search \
  -H 'Content-Type: application/json' \
  -d '{
    "vector": [0.1, 0.2, ...],  # 512 dimensions
    "limit": 5
  }'
```

### Test Kafka Topics

```bash
# Produce test message
echo '{"job_id":"test-123","audio_path":"s3://test.wav"}' | \
  docker exec -i hope-kafka kafka-console-producer \
    --bootstrap-server kafka:29092 \
    --topic stt.audio.upload

# Consume messages
docker exec -it hope-kafka kafka-console-consumer \
  --bootstrap-server kafka:29092 \
  --topic stt.audio.upload \
  --from-beginning
```

---

## 📚 Additional Resources

- [Main Implementation Plan](../../docs/implementation/STT-001-Speech-to-Text-Orchestra/README.md)
- [Development Environment Setup](../../docs/implementation/STT-001-Speech-to-Text-Orchestra/development-environment.md)
- [Sprint Progress](../../docs/implementation/STT-001-Speech-to-Text-Orchestra/SPRINT-PROGRESS.md)
- [Quick Start Guide](../../docs/implementation/STT-001-Speech-to-Text-Orchestra/QUICK-START-GUIDE.md)

---

## 🔐 Security Notes

### Development Environment

- Uses root token for Vault (dev mode only)
- No TLS/SSL encryption
- Default passwords
- Exposed ports on localhost

### Production Environment

- Use Vault AppRole authentication
- Enable TLS/SSL for all services
- Use strong, unique passwords
- Restrict network access
- Enable authentication for Qdrant, Redis, Kafka
- Use Kubernetes Secrets or external secret management

---

## 📝 Next Steps

1. **Run database migrations**: `cd packages/database && npx prisma migrate dev`
2. **Generate Prisma client**: `npx prisma generate`
3. **Create service scaffolds**: Implement FastAPI applications
4. **Download AI models**: Silero, Whisper, NeMo, Pyannote
5. **Implement services**: VAD, Transcription, Recognition
6. **Test end-to-end workflow**: Upload → VAD → Transcription → Recognition

---

**Questions?** Check the troubleshooting section or post in `#stt-orchestra-dev` Slack channel.
