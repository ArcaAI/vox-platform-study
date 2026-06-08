# Infrastructure

This document covers the development infrastructure, CI/CD pipelines, environment management, and deployment practices for the HOPE platform.

## Docker Compose Development Environment

The local development environment is fully containerized via Docker Compose. Services are organized in tiers:

### Core Services (`docker-compose.yml`)

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| PostgreSQL | `timescale/timescaledb-ha:pg18-all` | 5432 | Primary relational database (PostgreSQL 18 + TimescaleDB/pgvector) |
| Redis | `redis:8-alpine` | 6379 | Cache, job queues, pub/sub |
| MinIO | `minio/minio` | 9000 (API), 9001 (Console) | S3-compatible object storage |
| MinIO Setup | `minio/mc` | — | One-shot bucket creation |

### Extended Services (`docker-compose.dev.yml`)

| Service | Image | Port | Profile | Purpose |
|---------|-------|------|---------|---------|
| Qdrant | `qdrant/qdrant:v1.16` | 6333 (HTTP), 6334 (gRPC) | (default) | Vector database for semantic search |
| Qdrant Init | `python:3.11-slim` | — | (default) | One-shot collection setup |
| Vault | `hashicorp/vault:1.18` | 8200 | `vault` | Secret management (dev mode) |
| Vault Init | `hashicorp/vault:1.18` | — | `vault` | One-shot secret provisioning |
| Temporal | `temporalio/auto-setup` | 7233 | `temporal` | Durable-workflow server for the Harness |
| Temporal PostgreSQL | `postgres:16` | — (internal) | `temporal` | Temporal persistence (isolated from the app DB) |
| Temporal UI | `temporalio/ui` | 8233 | `temporal` | Temporal Web UI |
| Reranker | HF `text-embeddings-inference` | 8870 | `rag` | Cross-encoder reranker for the Harness RAG retriever |

**Profiles:** Qdrant starts with `docker:dev:up:all`; Vault is gated behind the `vault` profile (also activated by `docker:dev:up:all`). The Temporal stack (`temporal` profile) and the RAG reranker (`rag` profile) are opt-in and must be started explicitly.

**Note:** Kafka, Zookeeper, and Schema Registry have been removed. All event processing uses Redis (BullMQ) and PostgreSQL for audit logs.

**PgBouncer:** not part of the dev/test infrastructure — it exists only as a standalone validation harness under `packages/database/tests/pgbouncer-validation/` (run via the `pnpm pgbv:*` scripts).

### Quick Start

```bash
cp .env.example .env          # Create environment config from root
nano .env                     # Set passwords

# From monorepo root (recommended)
pnpm docker:dev:up            # Start core services (postgres, redis, minio)
pnpm docker:dev:up:all        # Start all services (core + vault + qdrant)
```

### Management Commands (from monorepo root)

| Command | Description |
|---------|-------------|
| `pnpm docker:dev:up` | Start core services via `./scripts/start-infra.sh` |
| `pnpm docker:dev:up:all` | Start all services (core + extended) |
| `pnpm docker:dev:down` | Stop services |
| `pnpm docker:dev:logs` | Follow service logs |
| `pnpm docker:dev:status` | Check container status |

Direct Docker Compose commands also work:

```bash
# Core services only
docker compose -f infrastructure/docker/docker-compose.yml up -d

# Core + extended services
docker compose -f infrastructure/docker/docker-compose.yml \
               -f infrastructure/docker/docker-compose.dev.yml up -d
```

### PostgreSQL Configuration

The default PostgreSQL instance is configured with:
- Image: `timescale/timescaledb-ha:pg18-all` (PostgreSQL 18 + TimescaleDB/pgvector)
- Default database: `${POSTGRES_DB:-postgres}`
- Default user: `${POSTGRES_USER:-postgres}`
- Memory limit: 512 MB, shared_buffers: 64 MB
- Max connections: 50 (tuned for local development)
- WAL level: minimal (no replication in dev)

The application uses PostgreSQL schemas (`public`, `core`) within a single database rather than multiple databases.

### MinIO Buckets

Created automatically by the `minio-setup` service:

| Bucket | Policy | Purpose |
|--------|--------|---------|
| `mlflow` | private | Model artifacts and experiment data |
| `recordings` | public | Raw audio recordings |
| `generated-audio` | public | Generated speech files (TTS output) |
| `documents` | private | Medical reports |
| `backups` | private | System backups |

### Observability

Observability tooling (Prometheus, Grafana, Loki, Promtail, cAdvisor, Node Exporter) is not included in the current Docker Compose setup. These may be configured separately for production deployments.

## CI/CD Pipelines

The platform uses **GitHub Actions** for a focused release gate and **GitLab CI** for the full lint/test/build/scan/deploy pipeline.

### GitHub Actions

`.github/workflows/` currently contains a single workflow:

| File | Purpose | Trigger |
|------|---------|---------|
| `harness-eval.yml` | Release-blocking evaluation gate for the Clinical Documentation Harness — DeepEval (PDSQI-9 / faithfulness + judge-calibration ICC gate) and a promptfoo output-contract gate, run offline against a pinned golden set | Push/PR touching `apps/harness/**` |

The broader lint / unit / integration / E2E checks now run through GitLab CI (below).

### GitLab CI — Full Pipeline

`.gitlab-ci.yml` orchestrates the pipeline via per-stage includes under `.gitlab/ci/*.yml`:

| Stage | Purpose |
|-------|---------|
| `install` | Install workspace dependencies |
| `validate` | Lint / format / type checks |
| `prepare` | Pre-build setup (e.g. Prisma generation) |
| `test` | Unit / integration / E2E suites |
| `build` | Per-service Docker image builds |
| `scan` | Image / dependency security scanning |
| `publish` | Push images to the registry |
| `deploy` | Environment deployment |
| `notify` | Pipeline notifications |

The **build** stage (`.gitlab/ci/build.yml`) builds per-service images on a shared `warm-up-base-images` step: `build-api`, `build-ui-playground`, `build-example-ui`, `build-nlp`, `build-guardrail`, `build-smr`, `build-stt-v2`, `build-stt-v2-worker`, `build-database`.

Each build job triggers on changes to the service's source on `main`, supports `FORCE_REBUILD=true`, tags images with `{service}-{commit-sha}` and `{service}-latest` on the default branch, pushes to the internal GitLab registry, and retries once on infrastructure failures.

## Environment Management

### Environment Files

| File | NODE_ENV | Purpose | Git Tracked |
|------|----------|---------|:-----------:|
| `.env.dev` | development | Local development defaults | Yes |
| `.env.test` | test | Isolated test infrastructure | Yes |
| `.env.production` | production | Production configuration | Yes |
| `.env.example` | — | Template for new developers | Yes |
| `.env` | development | Active local config (copy from .env.example) | No |

### Loading Priority

```text
Local Development:     Host env → .env.dev → .env (fallback)
Testing:               Host env → .env.test (loaded via dotenv-cli)
CI/CD:                 Workflow env → GitHub Secrets → setup-test-env action
Production (K8s):      Container env → ConfigMap → Secret
```

### Key Variables

#### Shared

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `DATABASE_URL` | PostgreSQL connection string | — |
| `REDIS_HOST` | Redis hostname | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `LOG_LEVEL` | Logging verbosity | `info` |

#### API Gateway

| Variable | Description |
|----------|-------------|
| `PORT` / `API_PORT` | Server port (default: 8868) |
| `JWT_SECRET` | JWT signing key |
| `SESSION_SECRET_KEY` | Session encryption key |

#### Python Services

Ports have two contexts: the `.env.dev` root defaults and the dev scripts in `package.json` (which override via CLI flags).

| Variable | Port | Description |
|----------|------|-------------|
| `STT_V2_PORT` | 8861 | STT v2 server port |
| `SMR_PORT` | 8862 | SMR server port |
| `GUARDRAIL_V2_PORT` | 8863 | Guardrail server port |
| `NLP_PORT` | 8864 | NLP server port |
| `HARNESS_PORT` | 8866 | Harness server port |

| Variable | Service | Description |
|----------|---------|-------------|
| `AZURE_SPEECH_KEY` | STT | Azure Speech API key |
| `AZURE_OPENAI_API_KEY` | SMR | Azure OpenAI key |
| `AZURE_OPENAI_ENDPOINT` | SMR | Azure OpenAI endpoint |

#### Docker Infrastructure

| Variable | Service | Default |
|----------|---------|---------|
| `POSTGRES_PASSWORD` | PostgreSQL | `postgres` |
| `POSTGRES_USER` | PostgreSQL | `postgres` |
| `POSTGRES_DB` | PostgreSQL | `postgres` |
| `REDIS_PASSWORD` | Redis | `redis_password` |
| `MINIO_ROOT_USER` | MinIO | `minio_admin` |
| `MINIO_ROOT_PASSWORD` | MinIO | `minio_admin` |
| `VAULT_DEV_ROOT_TOKEN` | Vault (extended) | `root` |

### Python Service Environment Loading

Python services use hierarchical environment loading:

1. Root `.env` (monorepo root, found by locating `pnpm-workspace.yaml`)
2. Service `.env` (service directory)
3. `.env.local` (personal overrides)

Loading is skipped entirely in production — all config comes from the container orchestrator.

## Testing Infrastructure

### Port Isolation

Tests use separate ports from development to prevent data pollution:

| Service | Dev Port | Test Port |
|---------|----------|-----------|
| PostgreSQL | 5432 | 5433 |
| Redis | 6379 | 6380 |
| Kafka | — (not in dev compose) | 9093 |
| MinIO | 9000 | 9002 |
| Qdrant HTTP | 6333 | 6335 |
| Qdrant gRPC | 6334 | 6336 |
| API Server | 8868 (.env.dev) | 3000 (code default) |

**Note:** Kafka runs in KRaft mode (`apache/kafka:4.0.0`) in the test environment only, not in the development Docker Compose setup.

### Test Infrastructure Commands

```bash
pnpm docker:test:up         # Start test containers (postgres, redis, kafka, minio, qdrant)
pnpm docker:test:down       # Stop and remove (with volumes)
pnpm docker:test:logs       # Follow test container logs
pnpm docker:test:status     # Check test container status
pnpm test:setup             # up + db:push + db:seed
pnpm test:db:push           # Push schema to test database
pnpm test:db:seed           # Seed test database
pnpm test:db:reset          # db:push + db:seed (re-creates schema and data)
```

### Test Pyramid

| Layer | Framework | Description | Coverage Target |
|-------|-----------|-------------|:--------------:|
| Unit | Vitest (TS), pytest (Python) | Isolated, mocked | 90% |
| Integration | Vitest + Prisma | Real DB, Redis, Qdrant | 80% |
| E2E | Playwright | Full API stack | Feature coverage |
| Contract | Vitest | Service API contracts | — |

### Test Commands

```bash
# TypeScript
pnpm test:unit              # Unit tests (Kafka auto-disabled)
pnpm test:unit:watch        # Watch mode
pnpm test:unit:ui           # Vitest UI
pnpm test:integration       # Integration tests
pnpm test:e2e               # E2E tests (requires running API)
pnpm test:coverage          # Coverage report

# Python
pnpm py:stt-v2:test         # STT unit tests
pnpm py:smr-v2:test         # SMR unit tests
pnpm py:nlp:test            # NLP unit tests
pnpm py:stt-v2:lint         # STT linting
pnpm py:smr-v2:lint         # SMR linting
```

## Code Quality

| Tool | Version | Purpose |
|------|---------|---------|
| ESLint | 9.x | TypeScript linting |
| Prettier | 3.5+ | Code formatting |
| TypeScript | 5.8+ | Static type checking |
| Ruff | Latest | Python linting |
| Black | Latest | Python formatting |
| Husky | Latest | Git pre-commit hooks |

Quality checks run on every PR via the `lint-format.yml` workflow and are prerequisites for integration tests.

## Deployment Topology

### Development

All infrastructure in Docker Compose. Application services run locally with hot reload.

### Staging / Production

| Layer | Technology |
|-------|-----------|
| Container Orchestration | Kubernetes (Rancher) |
| Container Registry | GitLab Registry |
| Database | PostgreSQL 18 (managed or self-hosted) |
| Cache | Redis 8 (cluster mode) |
| Storage | S3-compatible (MinIO or cloud provider) |
| Load Balancer | NGINX / cloud ALB |
| Secrets | K8s Secrets / ConfigMaps |
| Monitoring | Prometheus + Grafana (configured separately) |

Configuration in production comes exclusively from the container orchestrator — no `.env` files are loaded.

### System Requirements

| Environment | RAM | Storage | Notes |
|------------|-----|---------|-------|
| Development | 8 GB min, 16 GB recommended | 50 GB | Full Docker Compose stack |
| CI Runner | 8 GB | 20 GB | Ephemeral containers |
| Production | Per-service scaling | As needed | Kubernetes HPA |

## Related Documentation

- [System Architecture](./README.md) — Overall system overview
- [Communication Patterns](./communication.md) — Redis and service integration
- [Security](./security.md) — Authentication and secrets management
- [Data Model](./data-model.md) — Database schema and migrations
