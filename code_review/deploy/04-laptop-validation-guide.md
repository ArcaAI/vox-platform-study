# 04 — Laptop Validation Guide

This document explains how to run and test each HOPE service one-by-one on
a laptop using Docker, **without needing a Kubernetes cluster or ArgoCD**.

The goal is to verify that:
1. Each Docker image builds correctly
2. Each service starts without errors
3. Each service's health endpoint responds
4. Services can communicate with each other

---

## Prerequisites on Your Laptop

```bash
# Docker Desktop
docker version   # must work

# Docker Compose
docker compose version

# curl (for health checks)
curl --version
```

---

## Step 1 — Start the Backing Infrastructure

The `project-hope/` repo already includes a Docker Compose file for all
backing services. Use it first:

```bash
cd /Users/apple/repos/VOX/project-hope

# Copy the sample env file (fill in real values)
cp .env.sample .env
# Edit .env with your real credentials (see section below)

# Start PostgreSQL, Redis, MinIO (core services)
pnpm infra:dev:up

# OR if you don't have pnpm installed, run directly:
docker compose -f infrastructure/docker/docker-compose.yml up -d
```

This starts:
- PostgreSQL 18 on port `5432`
- Redis 8 on port `6379`
- MinIO on port `9000` (API) and `9001` (web console)

**Verify they are running:**
```bash
docker compose -f infrastructure/docker/docker-compose.yml ps
# Should show all containers as "Up"
```

**Access MinIO console:**
- Open http://localhost:9001
- Login with credentials from your `.env` file
- Verify these buckets exist (create them if not):
  - `hope-audio`
  - `hope-audio-chunks`
  - `hope-loki-logs`
  - `hope-tempo-traces`
  - `mlflow`, `recordings`, `generated-audio`, `documents`, `backups`

### Essential `.env` values to set

Open `.env.sample` and look for these values to fill in your `.env`:

```bash
# Database
POSTGRES_USER=hope
POSTGRES_PASSWORD=your_password
POSTGRES_DB=hopedb
DATABASE_URL=postgresql://hope:your_password@localhost:5432/hopedb

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASS=your_redis_password

# MinIO
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=your_minio_password
MINIO_ENDPOINT=localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=your_minio_password

# For API only
JWT_SECRET_KEY=any-random-long-string-for-local-testing
SESSION_SECRET_KEY=any-random-long-string
API_GATEWAY_KEY=any-random-string
```

---

## Step 2 — Run Database Migrations

Before starting any service, the database schema must be up to date:

```bash
cd /Users/apple/repos/VOX/project-hope

# Option A: Use the pnpm script (recommended)
pnpm setup:dev

# Option B: Run migrations directly
DATABASE_URL="postgresql://hope:your_password@localhost:5432/hopedb" \
  pnpm --filter @arcaai/database exec prisma migrate deploy
```

---

## Step 3 — Test Each Service One by One

Build and run each service in a separate terminal. Test in dependency order
(see `02-service-dependency-map.md`).

### Testing the API Gateway (hope-api)

```bash
# Build the image (from project-hope/ root)
docker build \
  --file apps/api/Dockerfile \
  --tag hope-v2/api:local \
  --build-arg DATABASE_URL="postgresql://hope:your_password@localhost:5432/hopedb" \
  .

# Run it (connects to local backing services)
docker run --rm \
  --name test-hope-api \
  --network host \
  -e NODE_ENV=development \
  -e PORT=8868 \
  -e DATABASE_URL="postgresql://hope:your_password@localhost:5432/hopedb" \
  -e REDIS_HOST=localhost \
  -e REDIS_PORT=6379 \
  -e REDIS_PASS="" \
  -e REDIS_URL="redis://localhost:6379/0" \
  -e JWT_SECRET_KEY=test-jwt-secret-for-local-only \
  -e SESSION_SECRET_KEY=test-session-secret \
  -e API_GATEWAY_KEY=test-gateway-key \
  -e MINIO_ENDPOINT=localhost:9000 \
  -e MINIO_ACCESS_KEY=minioadmin \
  -e MINIO_SECRET_KEY=your_minio_password \
  -e MINIO_USE_SSL=false \
  -e SECRETS_PROVIDER=env \
  -e STT_V2_URL=http://localhost:8861 \
  -e SMR_URL=http://localhost:8862 \
  -e NLP_URL=http://localhost:8864 \
  -e GUARDRAIL_URL=http://localhost:8863 \
  -e TTS_URL=http://localhost:8865 \
  -e HARNESS_URL=http://localhost:8866 \
  hope-v2/api:local

# In another terminal, check health
curl http://localhost:8868/api/v1/health/startup
# Expected: {"status":"ok"} or similar

curl http://localhost:8868/api/v1/health/ready
# May show degraded if AI services are not running — that is OK for initial check
```

> **Note**: `SECRETS_PROVIDER=env` tells the API to read secrets from environment
> variables directly instead of Vault. This is fine for local testing.

### Testing the STT Service (hope-stt-v2)

```bash
# Build
docker build \
  --file apps/stt/docker/Dockerfile \
  --tag hope-v2/stt:local \
  .

# Run
docker run --rm \
  --name test-hope-stt \
  --network host \
  -e DATABASE_URL="postgresql://hope:your_password@localhost:5432/hopedb" \
  -e REDIS_HOST=localhost \
  -e REDIS_PORT=6379 \
  -e MINIO_ENDPOINT=localhost:9000 \
  -e MINIO_ACCESS_KEY=minioadmin \
  -e MINIO_SECRET_KEY=your_minio_password \
  -e MINIO_AUDIO_BUCKET=hope-audio \
  -e MINIO_CHUNK_BUCKET=hope-audio-chunks \
  -p 8861:8861 \
  hope-v2/stt:local

# Health check
curl http://localhost:8861/health
```

> **Note**: STT needs an NVIDIA GPU in production. On a laptop without a GPU,
> it will run in CPU mode (slower). Check the service logs for GPU errors.

### Testing the SMR Service (summarization)

```bash
# Build
docker build --file apps/smr/Dockerfile --tag hope-v2/smr:local .

# Run (needs LM Studio or another OpenAI-compatible LLM running locally)
# LM Studio: download from lmstudio.ai and load a model
docker run --rm \
  --name test-hope-smr \
  --network host \
  -e REDIS_HOST=localhost \
  -e REDIS_PORT=6379 \
  -e SMR_OPENAI_COMPAT_BASE_URL=http://localhost:1234/v1 \
  -e SMR_OPENAI_COMPAT_DEFAULT_MODEL=gemma-4-e2b-it-qat \
  -e SMR_GATEWAY_URL=http://localhost:8868/api/v1 \
  -p 8862:8862 \
  hope-v2/smr:local

# Health check
curl http://localhost:8862/api/v1/health/ready
# Will show unhealthy if LM Studio is not running — expected
```

### Testing the Guardrail Service

```bash
docker build --file apps/guardrail/Dockerfile --tag hope-v2/guardrail:local .

docker run --rm \
  --name test-hope-guardrail \
  --network host \
  -p 8863:8863 \
  hope-v2/guardrail:local

curl http://localhost:8863/health
```

### Testing the NLP Service

```bash
docker build --file apps/nlp/Dockerfile --tag hope-v2/nlp:local .

docker run --rm \
  --name test-hope-nlp \
  --network host \
  -p 8864:8864 \
  hope-v2/nlp:local

curl http://localhost:8864/health
```

### Testing the TTS Service

```bash
docker build --file apps/tts/Dockerfile --tag hope-v2/tts:local .

docker run --rm \
  --name test-hope-tts \
  --network host \
  -e AZURE_SPEECH_KEY=your_azure_key \
  -e AZURE_SPEECH_REGION=eastus \
  -p 8865:8865 \
  hope-v2/tts:local

curl http://localhost:8865/health
```

### Testing the Harness Service

```bash
docker build --file apps/harness/Dockerfile --tag hope-v2/harness:local .

docker run --rm \
  --name test-hope-harness \
  --network host \
  -e TEMPORAL_ADDRESS=localhost:7233 \
  -e TEMPORAL_NAMESPACE=default \
  -e TEMPORAL_TASK_QUEUE=harness-task-queue \
  -e HARNESS_API_BASE_URL=http://localhost:8868 \
  -e HARNESS_RETRIEVAL_QDRANT_URL=http://localhost:6333 \
  -p 8866:8866 \
  hope-v2/harness:local

curl http://localhost:8866/health
```

### Testing the Admin Console (Next.js)

```bash
docker build --file apps/admin-console/Dockerfile --tag hope-v2/admin-console:local .

docker run --rm \
  --name test-hope-admin \
  --network host \
  -e NEXTAUTH_URL=http://localhost:3000 \
  -e NEXTAUTH_SECRET=test-secret \
  -e API_URL=http://localhost:8868 \
  -p 3000:3000 \
  hope-v2/admin-console:local

# Open in browser: http://localhost:3000
```

---

## Step 4 — Run All Services Together (Docker Compose)

For a full local stack, use the existing dev compose setup in `project-hope/`:

```bash
cd /Users/apple/repos/VOX/project-hope

# Full stack (infra + all services)
pnpm stack:dev

# Or individual services:
pnpm api:dev      # API gateway only
pnpm stt:dev      # STT only
pnpm smr:dev      # SMR only
```

---

## Quick Validation Checklist

After starting all services, verify each with:

```bash
# Run this script to check all services at once
for port_path in \
  "8868:/api/v1/health/startup" \
  "8861:/health" \
  "8862:/api/v1/health/ready" \
  "8863:/health" \
  "8864:/health" \
  "8865:/health" \
  "8866:/health"; do
  port="${port_path%%:*}"
  path="${port_path##*:}"
  status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${port}${path}" 2>/dev/null)
  echo "Port $port → HTTP $status"
done
```

Expected output:
```
Port 8868 → HTTP 200   (API Gateway)
Port 8861 → HTTP 200   (STT)
Port 8862 → HTTP 200   (SMR — only if LM Studio running)
Port 8863 → HTTP 200   (Guardrail)
Port 8864 → HTTP 200   (NLP)
Port 8865 → HTTP 200   (TTS — only if Azure key valid)
Port 8866 → HTTP 200   (Harness — only if Temporal running)
```

---

## What "Validation" Proves

Running services locally on Docker proves:
✅ The Dockerfile is correct and the image builds  
✅ The service starts without crash on boot  
✅ Required environment variables are wired correctly  
✅ The service can connect to its direct dependencies  

It does NOT prove:
❌ The Kubernetes manifests are correct (use `06-manifest-validation.md` for that)  
❌ The service works under production load  
❌ Vault integration works (use `SECRETS_PROVIDER=env` for local testing)  
