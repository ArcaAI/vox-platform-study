# Infrastructure

Introduced: 2026-07-04 · Last verified: 2026-07-21

Map of `infrastructure/` — everything needed to run HOPE's backing services locally (Docker Compose) plus production blueprints for Vault. Cluster (k3s + ArgoCD) deployment manifests live in [deployment/](../deployment/README.md), not here.

| Path                                                         | Purpose                                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [docker/](docker/README.md)                                  | Local-dev Docker Compose stacks (core + optional profiles), Vault dev bootstrap, Prometheus/Grafana dev configs, shared Python base image. |
| `grafana/`                                                   | Standalone Grafana dashboard JSONs + provisioning files (see below).                                                                       |
| [single-deployment/](single-deployment/README.md)            | Production deployment blueprints; currently the Vault HA stack ([single-deployment/vault/](single-deployment/vault/README.md)).            |
| [SECURITY_DEPLOYMENT_GUIDE.md](SECURITY_DEPLOYMENT_GUIDE.md) | Encryption index (at-rest, in-transit, backups, key management): what the repo configures vs. what an operator must do on real hosts.      |

## docker/ — local dev stacks

Two compose files, combined by the wrapper scripts. Both load the root `.env`.

### `docker-compose.yml` (project `hope-infra`) — core, no profiles

| Service       | Container       | Ports                   | Notes                                                                                                            |
| ------------- | --------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| PostgreSQL 18 | `hope-postgres` | 5432                    | `timescale/timescaledb-ha:pg18-all` (pgvector/vectorscale available), named volume `hope-postgres-data-pg18`     |
| MinIO         | `hope-minio`    | 9000 API / 9001 console | `minio-setup` init container creates buckets (`mlflow`, `recordings`, `generated-audio`, `documents`, `backups`) |
| Redis 8       | `hope-redis`    | 6379                    | persistence disabled by design (PHI posture)                                                                     |

### `docker-compose.dev.yml` (project `hope-infra-dev`) — extensions, mostly profile-gated

| Service                                      | Container                         | Ports                 | Profile                                  |
| -------------------------------------------- | --------------------------------- | --------------------- | ---------------------------------------- |
| Vault 1.21.4 (dev mode) + `vault-init` sidecar | `hope-vault`, `hope-vault-init`   | 8200                  | `vault`                                  |
| Qdrant v1.19.0 + `qdrant-init`               | `hope-qdrant`, `hope-qdrant-init` | 6333 HTTP / 6334 gRPC | none (starts whenever this file is used) |
| Temporal server 1.31.2 (admin-tools schema, shares hope-postgres) | `hope-temporal` (+ admin-tools / namespace jobs) | 7233 gRPC             | `temporal` — leftover 1.29 DB hop: [TASK-702](../docs/implementation/TASK-702-Dependency-Blocker-Resolutions/README.md) / `pnpm infra:dev:temporal-hop` |
| Temporal UI 2.53.1                           | `hope-temporal-ui`                | 8233                  | `temporal`                               |
| TEI reranker (`BAAI/bge-reranker-v2-m3`)     | `hope-reranker`                   | 8870                  | `rag`                                    |
| Prometheus v3                                | `hope-prometheus`                 | 9090                  | `prometheus` (alias: `observability`)    |
| Grafana 13.1.2                               | `hope-grafana`                    | 3001                  | `prometheus` (alias: `observability`)    |
| vLLM (`Qwen/Qwen3-8B` default)               | `hope-vllm`                       | 8000                  | `inference` (GPU host)                   |
| llama.cpp server (pre-staged GGUF)           | `hope-llama-cpp`                  | 8080                  | `inference`                              |
| TEI embeddings (`BAAI/bge-m3`)               | `hope-tei-embed`                  | 8871                  | `inference`                              |

The `inference` profile stages the production self-host LLM engine matrix (vLLM + llama.cpp + TEI embeddings) on a GPU dev host; LM Studio + Ollama remain the default local engines. See [docs/operations/inference/README.md](../docs/operations/inference/README.md) for staging, wiring, and smoke-testing.

The dev Prometheus scrapes host-run services via `host.docker.internal` (api 8868, stt 8861, text 8862, guardrail 8863, nlp 8864, harness 8866) per `docker/configs/prometheus/prometheus.yml`. Dev Grafana provisions its datasource + starter dashboard from `docker/configs/grafana/`.

Isolated TEST infrastructure (Postgres 5433, Redis 6380, MinIO 9002, Qdrant 6335) is a separate compose file at [tests/docker-compose.test.yml](../tests/README.md) — not part of this directory.

### Command mapping (root `package.json`)

| Command                                                                                                                           | Runs                                      | Effect                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm infra:dev:up` / `infra:dev:down` / `infra:dev:restart` / `infra:dev:status` / `infra:dev:logs` / `infra:dev:validate`       | `scripts/dev-infra.sh`                    | Both compose files with the `vault` + `temporal` + `rag` profiles — the full dev infra in one command. |
| `pnpm infra:dev:up:observability`                                                                                                 | `scripts/dev-infra.sh up --observability` | Base tier plus Prometheus + Grafana.                                                                   |
| `pnpm infra:dev:up:inference`                                                                                                     | `scripts/dev-infra.sh up --inference`     | Base tier plus vLLM / llama.cpp / TEI embed.                                                           |
| `pnpm infra:test:up` / `infra:test:down` / `infra:test:restart` / `infra:test:status` / `infra:test:logs` / `infra:test:validate` | `scripts/start-test-infra.sh`             | Isolated test infra (see [tests/README.md](../tests/README.md)).                                       |
| `pnpm setup:dev`                                                                                                                  | `scripts/dev-setup.sh`                    | Full dev bootstrap: infra up, migrate + seed, Vault AppRole + DB-engine bootstrap.                     |

> TASK-557 removed the former `scripts/start-infra.sh` (`pnpm docker:dev:*`). It started core
> services only — no Temporal, Vault or rag — which silently produced a half-working stack.
> `scripts/dev-infra.sh` is now the single dev-infra entrypoint, and its `down` still tears
> down the legacy `hope-infra` compose project so pre-existing containers do not linger.

See [scripts/README.md](../scripts/README.md) for the full script reference.

### Other assets in docker/

| Path                                                                                           | Purpose                                                                                                           |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `docker/configs/vault/`                                                                        | Dev Vault bootstrap (`dev-init.sh`, `hope-app.hcl` policy) run by the `vault-init` sidecar.                       |
| `docker/configs/temporal/`                                                                     | Temporal dynamic config + admin-tools schema/namespace scripts for the dev SQL backend.                           |
| `docker/configs/prometheus/`, `docker/configs/grafana/`                                        | Dev observability configs mounted by the `prometheus` profile services.                                           |
| `docker/python-base/`                                                                          | `hope-python-base` — shared CPU base image (Python 3.11 + uv + non-root user) for all HOPE Python service images. |
| `docker/scripts/init-qdrant-collections.py`                                                    | Qdrant collection bootstrap, reused by dev and test init containers.                                              |
| `docker/QDRANT-SETUP.md`, `docker/QDRANT-QUICK-REFERENCE.md`, `docker/README-STT-ORCHESTRA.md` | Historical per-service runbooks.                                                                                  |
| `docker/env.stt-dev.example`                                                                   | Legacy STT Orchestra env template.                                                                                |

## grafana/ — standalone dashboards

Dashboard JSONs and provisioning for a Grafana instance pointed at a Prometheus datasource (`provisioning/datasources.yml` expects `http://prometheus:9090`). Distinct from the dev-compose Grafana configs under `docker/configs/grafana/`.

| Dashboard                                                                  | Focus                                                |
| -------------------------------------------------------------------------- | ---------------------------------------------------- |
| `dashboards/text-overview.json`, `text-resilience.json`, `text-security.json` | Text service health, resilience, and security metrics (Grafana UIDs still `text-overview`, `text-resilience`, `text-security`) |
| `dashboards/pgbouncer.json`                                                | PgBouncer pool stats                                 |
| `dashboards/optimistic-locking.json`                                       | Optimistic-locking conflict metrics                  |

## single-deployment/ — production blueprints

Currently contains one stack, and it is **RETIRED**: [single-deployment/vault/](single-deployment/vault/README.md) — 3-node HA Vault with Raft storage and Transit auto-unseal, deployed on Proxmox VMs 430-432 (+434 seal) which are being destroyed under TASK-833. HOPE's Vault is now a single in-cluster instance defined in `arca/hope-v2-deployment` (`deployment/k8s/base/vault.yaml`); see that repo's `docs/vault-seal-migration.md`. The tree is kept as a design record and for the still-used bootstrap/policy assets — read the banner in [single-deployment/README.md](single-deployment/README.md) first.

Day-2 Vault operations (rotation, failover, recovery, chaos drills) are documented in [docs/operations/vault/](../docs/operations/vault/README.md); the chaos drill script itself is `scripts/chaos/vault-drill.sh`.

## Related

- Cluster deploys (k3s manifests, ArgoCD bootstrap, secrets templates): [deployment/README.md](../deployment/README.md)
- Encryption and security posture: [SECURITY_DEPLOYMENT_GUIDE.md](SECURITY_DEPLOYMENT_GUIDE.md)
- Homelab VM runbooks (Postgres HA, Redis, MinIO, GitLab, Vault VMs, ...): `docs/research/deployments/`
