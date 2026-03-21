# Infrastructure & Configuration Codemap

**Last Updated:** 2026-03-09

---

## 📋 Purpose

Development and deployment infrastructure setup. Defines Docker Compose configuration for local development, environment variables, networking, secrets management, and deployment strategies.

---

## 🐳 Docker Compose (Development)

**Location:** [infrastructure/docker/docker-compose.yml](../../../../infrastructure/docker/docker-compose.yml)

### Services

#### PostgreSQL 18
```yaml
postgres:
  image: postgres:18-alpine
  ports:
    - "5432:5432"
  environment:
    - POSTGRES_USER=hope_user
    - POSTGRES_PASSWORD=hope_password
    - POSTGRES_DB=hope_db
  volumes:
    - postgres_data:/var/lib/postgresql/data
```

**Startup:**
```bash
pnpm docker:dev:up

# Or just database
docker compose -f infrastructure/docker/docker-compose.yml up postgres
```

#### Redis 8
```yaml
redis:
  image: redis:8-alpine
  ports:
    - "6379:6379"
  command: redis-server --requirepass redis_password
  volumes:
    - redis_data:/data
```

**Usage:**
- Dramatiq job queue (STT, SMR, NLP services)
- Session caching (API Gateway)
- Rate limiting data

#### MinIO (Object Storage)
```yaml
minio:
  image: minio/minio:latest
  ports:
    - "9000:9000"
    - "9001:9001"  # Console
  environment:
    - MINIO_ROOT_USER=minioadmin
    - MINIO_ROOT_PASSWORD=minioadmin
```

**Usage:**
- Audio file storage (STT service)
- Transcription results
- Medical documents

**Access Console**: http://localhost:9001

#### Qdrant (Vector Database)
```yaml
qdrant:
  image: qdrant/qdrant:latest
  ports:
    - "6333:6333"
  volumes:
    - qdrant_data:/qdrant/storage
```

**Usage:**
- Speaker embeddings (diarization)
- Medical document similarity search
- Vector search queries

**API:** http://localhost:6333/docs

#### Vault (Secrets Management)
```yaml
vault:
  image: vault:latest
  ports:
    - "8200:8200"
  command: server -dev
  environment:
    - VAULT_DEV_ROOT_TOKEN_ID=myroot
```

**Usage:**
- Store sensitive credentials
- Database passwords
- API keys
- JWT secrets

**Access**: http://localhost:8200

---

## 🔧 Environment Variables

### Database
```bash
# PostgreSQL
DATABASE_URL=postgresql://hope_user:hope_password@localhost:5432/hope_db
```

### Cache & Queue
```bash
# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASS=redis_password
```

### Object Storage
```bash
# MinIO
MINIO_URL=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
```

### Vector Database
```bash
# Qdrant
QDRANT_URL=http://localhost:6333
```

### Secrets
```bash
# Vault
VAULT_ADDR=http://localhost:8200
VAULT_TOKEN=myroot
```

### Service URLs
```bash
# STT
STT_V2_URL=http://localhost:8861

# SMR
SMR_URL=http://localhost:8862
SMR_SERVICE_URL_HTTP=http://localhost:8862

# NLP
NLP_URL=http://localhost:8864
NLP_SERVICE_URL=http://localhost:8864
NLP_SERVICE_URL_HTTP=http://localhost:8864
```

### API Gateway
```bash
# Node.js
NODE_ENV=development
PORT=3000

# JWT
JWT_SECRET=dev-secret-key-change-in-production
JWT_EXPIRES_IN=1h

# Session
SESSION_SECRET_KEY=dev-session-secret-change-in-production
```

---

## 🛠️ Setup Commands

### Start All Infrastructure
```bash
pnpm docker:dev:up

# Start with Python services (--all flag)
pnpm docker:dev:up:all
```

### Stop Infrastructure
```bash
pnpm docker:dev:down
```

### View Logs
```bash
pnpm docker:dev:logs

# Follow live logs
pnpm docker:dev:logs -- -f
```

### Check Status
```bash
pnpm docker:dev:status
```

### Full Development Setup
```bash
# 1. Start infrastructure
pnpm docker:dev:up

# 2. Setup database
pnpm db:all

# 3. Build all packages
pnpm build

# 4. Start API Gateway
pnpm dev:api

# 5. (In separate terminal) Start Python service
pnpm dev:stt-v2
```

---

## 📝 .env Configuration

### Development (.env.local)
```bash
# Database
DATABASE_URL=postgresql://hope_user:hope_password@localhost:5432/hope_db

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASS=redis_password

# MinIO
MINIO_URL=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=audio-uploads

# Qdrant
QDRANT_URL=http://localhost:6333

# Vault
VAULT_ADDR=http://localhost:8200
VAULT_TOKEN=myroot

# Services
STT_V2_URL=http://localhost:8861
SMR_URL=http://localhost:8862
NLP_URL=http://localhost:8864

# API
PORT=3000
JWT_SECRET=dev-secret-key

# Python (Conda environment)
CONDA_ENV=arcaenv
```

### Production (.env.production)
```bash
# Real PostgreSQL
DATABASE_URL=postgresql://user:pass@prod-db.example.com:5432/hope_db

# Real Redis (cloud)
REDIS_HOST=prod-redis.example.com
REDIS_PORT=6379
REDIS_PASS=${REDIS_PASSWORD}

# AWS S3 or similar (instead of MinIO)
S3_BUCKET=hope-production
AWS_REGION=us-east-1

# Real Qdrant or managed vector DB
QDRANT_URL=https://qdrant.example.com

# HashiCorp Vault (enterprise)
VAULT_ADDR=https://vault.example.com
VAULT_NAMESPACE=hope-prod

# External LLM providers
AZURE_OPENAI_KEY=${SECRET_AZURE_KEY}
OPENAI_API_KEY=${SECRET_OPENAI_KEY}

# Monitoring
SENTRY_DSN=${SECRET_SENTRY_DSN}
NEWRELIC_LICENSE_KEY=${SECRET_NR_KEY}
```

---

## 🚀 Deployment

### Single Node Deployment
**Location:** [infrastructure/single-deployment/](../../../../infrastructure/single-deployment/)

Contains Docker Compose for production single-node setup:
- Docker compose override files
- Environment configuration
- Health check scripts
- Backup/restore procedures

### Docker Build
```bash
# API Gateway
cd apps/api
docker build -t hope-api:latest .

# STT V2
cd apps/stt-v2
docker build -f Dockerfile -t hope-stt-v2:latest .

# SMR V2
cd apps/smr
docker build -f Dockerfile -t hope-smr-v2:latest .
```

### Kubernetes Readiness
Deployment ready for Kubernetes:
- Health check endpoints configured
- Liveness/readiness probes
- Resource limits defined
- Environment-based configuration

---

## 📊 Service Networking

```
┌─────────────────────────────────────────────────────────────┐
│              Docker Compose Network: hope                   │
│                  (default bridge network)                   │
└─────────────────────────────────────────────────────────────┘
         │
    ┌────┴────┬──────────┬──────────┬──────────┐
    │          │          │          │          │
    ▼          ▼          ▼          ▼          ▼
┌────────┐┌────────┐┌────────┐┌────────┐┌────────┐
│API GW  ││Postgres││Redis   ││MinIO   ││Qdrant  │
│:3000   ││:5432   ││:6379   ││:9000   ││:6333   │
└────┬───┘└────────┘└────────┘└────────┘└────────┘
     │
     └─► Python Services (external to compose)
         • STT V2 :8861
         • SMR V2 :8862
         • NLP :8864

All services communicate via hostname (service name)
```

---

## 🔐 Secrets Management

### Development (Vault)
```bash
# Login to Vault
vault login -method=userpass username=hope password=hope

# Store secret
vault kv put secret/hope/api JWT_SECRET=dev-secret

# Retrieve
vault kv get secret/hope/api
```

### Production (HashiCorp Vault + CI/CD)
```bash
# Secrets injected via CI/CD pipeline
# Never hardcode credentials in code or .env

# GitHub Actions example
- name: Deploy
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
    JWT_SECRET: ${{ secrets.JWT_SECRET }}
```

---

## 🧪 Health Checks

### API Gateway
```bash
curl http://localhost:3000/health
# {"status":"ok"}

curl http://localhost:3000/health/ready
# {"status":"ready",...}
```

### Python Services
```bash
curl http://localhost:8861/health  # STT
curl http://localhost:8862/health  # SMR
curl http://localhost:8864/health  # NLP
```

### Database
```bash
psql -h localhost -U hope_user -d hope_db -c "SELECT NOW();"
```

### Redis
```bash
redis-cli -h localhost -p 6379 PING
```

---

## 📈 Monitoring & Logging

### logs/ Directories
- `apps/api/logs/` — API Gateway logs
- `apps/stt-v2/logs/` — STT V2 logs

### Structured Logging
All services log to JSON files with context:
```json
{
  "timestamp": "2026-03-09T10:30:00Z",
  "level": "info",
  "service": "api-gateway",
  "request_id": "uuid",
  "tenant_id": "uuid",
  "user_id": "uuid",
  "message": "Consultation session created",
  "duration_ms": 123
}
```

---

## 🔗 Related Documentation

- [SETUP.md](../../../../knowledge/SETUP.md) — Complete setup guide
- [docker-compose.yml](../../../../infrastructure/docker/docker-compose.yml) — Service definitions

---

**Status**: ✅ Current | Infrastructure fully containerized
