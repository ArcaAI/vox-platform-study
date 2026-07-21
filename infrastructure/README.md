# Infrastructure

Introduced: 2026-07-04 · Last verified: 2026-07-21

Map of `infrastructure/` — everything needed to run HOPE's backing services locally (Docker Compose) plus production blueprints for Vault. Cluster (k3s + ArgoCD) deployment manifests live in [deployment/](../deployment/README.md), not here.

| Path | Purpose |
|---|---|
| [docker/](docker/README.md) | Local-dev Docker Compose stacks (core + optional profiles), Vault dev bootstrap, Prometheus/Grafana dev configs, shared Python base image. |
| `grafana/` | Standalone Grafana dashboard JSONs + provisioning files (see below). |
| [single-deployment/](single-deployment/README.md) | Production deployment blueprints; currently the Vault HA stack ([single-deployment/vault/](single-deployment/vault/README.md)). |
| [SECURITY_DEPLOYMENT_GUIDE.md](SECURITY_DEPLOYMENT_GUIDE.md) | Encryption index (at-rest, in-transit, backups, key management): what the repo configures vs. what an operator must do on real hosts. |

## docker/ — local dev stacks

Two compose files, combined by the wrapper scripts. Both load the root `.env`.

### `docker-compose.yml` (project `hope-infra`) — core, no profiles

| Service | Container | Ports | Notes |
|---|---|---|---|
| PostgreSQL 18 | `hope-postgres` | 5432 | `timescale/timescaledb-ha:pg18-all` (pgvector/vectorscale available), named volume `hope-postgres-data-pg18` |
| MinIO | `hope-minio` | 9000 API / 9001 console | `minio-setup` init container creates buckets (`mlflow`, `recordings`, `generated-audio`, `documents`, `backups`) |
| Redis 8 | `hope-redis` | 6379 | persistence disabled by design (PHI posture) |

### `docker-compose.dev.yml` (project `hope-infra-dev`) — extensions, mostly profile-gated

| Service | Container | Ports | Profile |
|---|---|---|---|
| Vault 1.18 (dev mode) + `vault-init` sidecar | `hope-vault`, `hope-vault-init` | 8200 | `vault` |
| Qdrant v1.16 + `qdrant-init` | `hope-qdrant`, `hope-qdrant-init` | 6333 HTTP / 6334 gRPC | none (starts whenever this file is used) |
| Temporal (auto-setup, shares hope-postgres) | `hope-temporal` | 7233 gRPC | `temporal` |
| Temporal UI | `hope-temporal-ui` | 8233 | `temporal` |
| TEI reranker (`BAAI/bge-reranker-v2-m3`) | `hope-reranker` | 8870 | `rag` |
| Prometheus v3 | `hope-prometheus` | 9090 | `prometheus` (alias: `observability`) |
| Grafana 12 | `hope-grafana` | 3001 | `prometheus` (alias: `observability`) |
| vLLM (`Qwen/Qwen3-8B` default) | `hope-vllm` | 8000 | `inference` (GPU host) |
| llama.cpp server (pre-staged GGUF) | `hope-llama-cpp` | 8080 | `inference` |
| TEI embeddings (`BAAI/bge-m3`) | `hope-tei-embed` | 8871 | `inference` |

The `inference` profile stages the production self-host LLM engine matrix (vLLM + llama.cpp + TEI embeddings) on a GPU dev host; LM Studio + Ollama remain the default local engines. See [docs/operations/inference/README.md](../docs/operations/inference/README.md) for staging, wiring, and smoke-testing.

The dev Prometheus scrapes host-run services via `host.docker.internal` (api 8868, stt 8861, smr 8862, guardrail 8863, nlp 8864, harness 8866) per `docker/configs/prometheus/prometheus.yml`. Dev Grafana provisions its datasource + starter dashboard from `docker/configs/grafana/`.

Isolated TEST infrastructure (Postgres 5433, Redis 6380, MinIO 9002, Qdrant 6335) is a separate compose file at [tests/docker-compose.test.yml](../tests/README.md) — not part of this directory.

### Command mapping (root `package.json`)

| Command | Runs | Effect |
|---|---|---|
| `pnpm infra:up` / `infra:down` / `infra:status` / `infra:logs` | `scripts/dev-infra.sh` | Both compose files with `vault` + `temporal` profiles — the full dev infra in one command. `pnpm infra:up -- --rag` adds the reranker. |
| `pnpm infra:observability:up` / `infra:observability:down` | docker compose directly | Prometheus + Grafana only (`prometheus` profile). |
| `pnpm docker:dev:up` | `scripts/start-infra.sh` | Core only (Postgres, Redis, MinIO). |
| `pnpm docker:dev:up:all` | `scripts/start-infra.sh --all` | Core + `vault` profile (Vault, Qdrant). No Temporal — prefer `pnpm infra:up`. |
| `pnpm docker:dev:down` / `docker:dev:logs` / `docker:dev:status` | `scripts/start-infra.sh` | Stop / logs / status for the above. |
| `pnpm docker:test:up` / `docker:test:down` / `docker:test:logs` / `docker:test:status` / `docker:test:validate` | `scripts/start-test-infra.sh` | Isolated test infra (see [tests/README.md](../tests/README.md)). |
| `pnpm dev:setup` | `scripts/dev-setup.sh` | Full dev bootstrap: infra up, migrate + seed, Vault AppRole + DB-engine bootstrap. |

See [scripts/README.md](../scripts/README.md) for the full script reference.

### Other assets in docker/

| Path | Purpose |
|---|---|
| `docker/configs/vault/` | Dev Vault bootstrap (`dev-init.sh`, `hope-app.hcl` policy) run by the `vault-init` sidecar. |
| `docker/configs/temporal/` | Temporal dynamic config for the dev SQL backend. |
| `docker/configs/prometheus/`, `docker/configs/grafana/` | Dev observability configs mounted by the `prometheus` profile services. |
| `docker/python-base/` | `hope-python-base` — shared CPU base image (Python 3.11 + uv + non-root user) for all HOPE Python service images. |
| `docker/scripts/init-qdrant-collections.py` | Qdrant collection bootstrap, reused by dev and test init containers. |
| `docker/QDRANT-SETUP.md`, `docker/QDRANT-QUICK-REFERENCE.md`, `docker/README-STT-ORCHESTRA.md` | Historical per-service runbooks. |
| `docker/env.stt-dev.example` | Legacy STT Orchestra env template. |

## grafana/ — standalone dashboards

Dashboard JSONs and provisioning for a Grafana instance pointed at a Prometheus datasource (`provisioning/datasources.yml` expects `http://prometheus:9090`). Distinct from the dev-compose Grafana configs under `docker/configs/grafana/`.

| Dashboard | Focus |
|---|---|
| `dashboards/smr-v2-overview.json`, `smr-v2-resilience.json`, `smr-v2-security.json` | SMR v2 service health, resilience, and security metrics |
| `dashboards/pgbouncer.json` | PgBouncer pool stats |
| `dashboards/optimistic-locking.json` | Optimistic-locking conflict metrics |

## single-deployment/ — production blueprints

Currently contains one stack: [single-deployment/vault/](single-deployment/vault/README.md) — 3-node HA Vault with Raft storage and Transit auto-unseal on the self-hosted k3s cluster (Helm values, bootstrap scripts, network policies, monitoring rules, kind-based E2E test). See [single-deployment/README.md](single-deployment/README.md).

Day-2 Vault operations (rotation, failover, recovery, chaos drills) are documented in [docs/operations/vault/](../docs/operations/vault/README.md); the chaos drill script itself is `scripts/chaos/vault-drill.sh`.

## Related

- Cluster deploys (k3s manifests, ArgoCD bootstrap, secrets templates): [deployment/README.md](../deployment/README.md)
- Encryption and security posture: [SECURITY_DEPLOYMENT_GUIDE.md](SECURITY_DEPLOYMENT_GUIDE.md)
- Homelab VM runbooks (Postgres HA, Redis, MinIO, GitLab, Vault VMs, ...): `docs/research/deployments/`
