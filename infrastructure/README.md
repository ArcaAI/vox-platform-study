# Infrastructure — local-dev Docker Compose and retired Vault HA design record

Everything needed to run HOPE's backing services locally with Docker Compose, plus a retired
production Vault HA blueprint kept as a design record. This directory is **local-dev and design
records only** — there is no cluster manifest in this repository. Every k3s / Argo CD manifest
lives in the separate `arca/hope-v2-deployment` repository.

## Layout

| Path | Purpose |
|---|---|
| [docker/](docker/README.md) | Local-dev Docker Compose stacks (core + profile-gated extensions), Vault dev bootstrap, Prometheus/Grafana dev configs, shared Python base image |
| [docker/lmstudio/](docker/lmstudio/README.md) | The `hope-lmstudio` headless GPU serving image (LM Studio CLI wrapped for CI-only builds) |
| [docker/minio/](docker/minio/README.md) | MinIO bucket layout, IAM policies, and the `hope-models` weight-publishing convention |
| `grafana/` | Standalone Grafana dashboard JSONs + provisioning files (see below) |
| [single-deployment/](single-deployment/README.md) | Production deployment blueprints — currently one RETIRED stack (Vault HA) |
| [SECURITY_DEPLOYMENT_GUIDE.md](SECURITY_DEPLOYMENT_GUIDE.md) | Encryption index (at-rest, in-transit, backups, key management): what the repo configures vs. what an operator must do on real hosts |

## Commands

| Command | Runs | Effect |
|---|---|---|
| `pnpm infra:dev:up` / `infra:dev:down` / `infra:dev:restart` / `infra:dev:status` / `infra:dev:logs` / `infra:dev:validate` | `scripts/dev-infra.sh` | Both compose files with the `vault` + `temporal` + `rag` profiles — the full dev infra in one command |
| `pnpm infra:dev:up:observability` | `scripts/dev-infra.sh up --observability` | Base tier plus Prometheus + Grafana |
| `pnpm infra:dev:up:inference` | `scripts/dev-infra.sh up --inference` | Base tier plus vLLM / llama.cpp / TEI embed |
| `pnpm infra:test:up` / `infra:test:down` / `infra:test:restart` / `infra:test:status` / `infra:test:logs` / `infra:test:validate` | `scripts/start-test-infra.sh` | Isolated test infra (see [tests/README.md](../tests/README.md)) |
| `pnpm setup:dev` | `scripts/dev-setup.sh` | Full dev bootstrap: infra up, migrate + seed, Vault AppRole + DB-engine bootstrap |

See [scripts/README.md](../scripts/README.md) for the full script reference.

## How it works

### `docker-compose.yml` (project `hope-infra`) — core, no profiles

| Service | Container | Ports | Notes |
|---|---|---|---|
| PostgreSQL 18 | `hope-postgres` | 5432 | `timescale/timescaledb-ha:pg18-all` (pgvector/vectorscale available), named volume `hope-postgres-data-pg18` |
| MinIO | `hope-minio` | 9000 API / 9001 console | `minio-setup` init container creates buckets (`mlflow`, `hope-models`, `recordings`, `generated-audio`, `documents`, `backups`, `harness-claim-check`) and the `hope-models-reader`/`hope-models-publisher` service-account identities |
| Redis 8 | `hope-redis` | 6379 | persistence disabled by design (PHI posture) |

### `docker-compose.dev.yml` (project `hope-infra-dev`) — extensions, mostly profile-gated

| Service | Container | Ports | Profile |
|---|---|---|---|
| Vault 1.21.4 (dev mode) + `vault-init` sidecar | `hope-vault`, `hope-vault-init` | 8200 | `vault` |
| Qdrant v1.19.0 + `qdrant-init` | `hope-qdrant`, `hope-qdrant-init` | 6333 HTTP / 6334 gRPC | none (starts whenever this file is used) |
| Temporal server (admin-tools schema, shares hope-postgres) | `hope-temporal` (+ admin-tools / namespace jobs) | 7233 gRPC | `temporal` |
| Temporal UI | `hope-temporal-ui` | 8233 | `temporal` |
| TEI reranker (`BAAI/bge-reranker-v2-m3`) | `hope-reranker` | 8870 | `rag` |
| Prometheus | `hope-prometheus` | 9090 | `observability` (alias: `prometheus`) |
| Grafana | `hope-grafana` | 3001 | `observability` (alias: `prometheus`) |
| vLLM (`Qwen/Qwen3-8B` default) | `hope-vllm` | 127.0.0.1:8000 | `inference` (GPU host) |
| llama.cpp server (pre-staged GGUF) | `hope-llama-cpp` | 8080 | `inference` |
| TEI embeddings (`BAAI/bge-m3`) | `hope-tei-embed` | 8871 | `inference` |
| MLflow (+ `mlflow-migrate` init) | `hope-mlflow`, `hope-mlflow-migrate` | 5000 | `mlflow` |
| llama.cpp GGUF server / embed server | `hope-gguf-server`, `hope-gguf-embed` | 8872, 8873 | `gguf` |

The `inference` profile stages the production self-host LLM engine matrix (vLLM + llama.cpp + TEI
embeddings) on a GPU dev host; LM Studio + Ollama remain the default local engines. See
[docs/operations/inference/README.md](../docs/operations/inference/README.md) for staging,
wiring, and smoke-testing.

The dev Prometheus scrapes host-run services via `host.docker.internal` (api 8868, stt 8861, text
8862, guardrail 8863, nlp 8864, harness 8866) per `docker/configs/prometheus/prometheus.yml`. Dev
Grafana provisions its Prometheus + Postgres datasources and starter dashboards from
`docker/configs/grafana/`.

Isolated TEST infrastructure (Postgres 5433, Redis 6380, MinIO 9002, Qdrant 6335, Vault 8201) is a
separate compose file at [tests/docker-compose.test.yml](../tests/README.md) — not part of this
directory.

### Other assets in `docker/`

| Path | Purpose |
|---|---|
| `docker/configs/vault/` | Dev Vault bootstrap (`dev-init.sh`, `test-init.sh`, `policies/*.hcl`) run by the `vault-init`/`vault-init-test` sidecars |
| `docker/configs/temporal/` | Temporal dynamic config for the dev SQL backend |
| `docker/configs/prometheus/`, `docker/configs/grafana/` | Dev observability configs mounted by the `observability` profile services |
| `docker/python-base/` | `hope-python-base` — shared CPU base image (Python 3.11 + uv + non-root user) for all HOPE Python service images |
| `docker/qdrant-init/`, `docker/vllm/` | Dockerfiles for the Qdrant collection-init and vLLM build-verify sidecars |
| `docker/scripts/init-qdrant-collections.py` | Qdrant collection bootstrap, reused by dev and test init containers |
| `docker/QDRANT-SETUP.md`, `docker/QDRANT-QUICK-REFERENCE.md`, `docker/README-STT-ORCHESTRA.md` | Historical per-service runbooks |
| `docker/env.stt-dev.example` | Legacy STT Orchestra env template |

### `grafana/` — standalone dashboards

Dashboard JSONs and provisioning for a Grafana instance pointed at Prometheus and Postgres
datasources (`provisioning/datasources.yml`). Distinct from the dev-compose Grafana configs under
`docker/configs/grafana/`. Eleven dashboards are checked in, covering Text service health /
resilience / security / cache-friendliness, PgBouncer pool stats, optimistic-locking conflicts,
harness/Temporal, agentic trajectory, consumption/cost, model retention, and an overall platform
metrics view.

### `single-deployment/` — production blueprints

Currently contains one stack, and it is **RETIRED**: [single-deployment/vault/](single-deployment/vault/README.md)
— 3-node HA Vault with Raft storage and Transit auto-unseal, deployed on Proxmox VMs that are
being destroyed. HOPE's Vault is now a single in-cluster instance defined in
`arca/hope-v2-deployment` (`deployment/k8s/base/vault.yaml`). The tree is kept as a design record
and for the still-used bootstrap/policy assets — read the banner in
[single-deployment/README.md](single-deployment/README.md) first.

Day-2 Vault operations (rotation, failover, recovery, chaos drills) are documented in
[docs/operations/vault/](../docs/operations/vault/README.md); the chaos drill script itself is
`scripts/chaos/vault-drill.sh`.

## Gotchas

- **There is no `deployment/` directory in this repository.** Every k3s manifest and the Argo CD
  config live in the separate `arca/hope-v2-deployment` repository — a reference to
  `deployment/README.md` from inside this repo is stale.
- **`infrastructure/docker/.env` is GENERATED** by `scripts/dev-infra.sh` from `.env.dev` on every
  `pnpm infra:dev:up` — never hand-edit it; it is Compose interpolation input, not application
  config.
- **`docker-compose.dev.yml` also defines `mlflow` and `gguf` profiles** in addition to `vault`,
  `temporal`, `rag`, `observability`/`prometheus`, and `inference` — none of the root `pnpm
  infra:dev:*` aliases enable them by default; start them by name with `docker compose -f
  infrastructure/docker/docker-compose.dev.yml --profile <name> up -d`.
- Qdrant has no profile — it starts whenever `docker-compose.dev.yml` is used at all, unlike
  Vault/Temporal/rag/observability/inference which are opt-in.

## Related

- Cluster deploys (k3s manifests, Argo CD bootstrap, secrets templates) live in the separate
  `arca/hope-v2-deployment` repository, not in this one
- [SECURITY_DEPLOYMENT_GUIDE.md](SECURITY_DEPLOYMENT_GUIDE.md) — encryption and security posture
- [../docs/research/deployments/](../docs/research/deployments/) — homelab VM runbooks (Postgres HA, Redis, MinIO, GitLab, Vault VMs, ...)
- [../.claude/rules/09-infrastructure-devops.md](../.claude/rules/09-infrastructure-devops.md) — configuration tiers, cluster topology, CI gates
