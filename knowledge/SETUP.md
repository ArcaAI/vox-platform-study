# Local Development Setup

> Prerequisites, environment setup, and the exact commands to run every HOPE service and app locally.

This is the canonical "get it running" guide. For deeper architecture and per-service details, see the [Architecture Overview](./architecture/README.md) and the per-service folders linked from the [knowledge index](./README.md).

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | `>= 22` | API gateway + all TypeScript packages/apps |
| pnpm | `10.31.0` (see `packageManager` in root `package.json`) | Monorepo package manager |
| Conda (Miniconda/Anaconda) | any recent | Manages the shared `arcaenv` Python environment |
| Python | `3.11` (provided by `arcaenv`) | All FastAPI services |
| Docker + Docker Compose | latest | Local infrastructure (Postgres, Redis, MinIO, …) |

All Python services run inside the conda env **`arcaenv`** — this is a hard project rule. Never invoke a service Python directly outside `arcaenv`.

---

## 1. Install dependencies

### TypeScript / Node workspaces

```bash
pnpm install
```

### Python services (conda `arcaenv`)

The setup script creates `arcaenv` (Python 3.11) and editable-installs every Python service into it:

```bash
pnpm py:setup            # full setup: check prerequisites, create arcaenv, install deps
pnpm py:setup:check      # only verify prerequisites
pnpm py:setup:apple      # add Apple Silicon (MPS) ML extras
pnpm py:setup:gpu        # add NVIDIA (CUDA) ML extras
```

`py:setup` installs `stt-v2`, `smr`, `nlp`, `harness`, and `guardrail` into `arcaenv`. To (re)install a single service manually:

```bash
conda run -n arcaenv pip install -e "apps/guardrail[dev,test]"
```

---

## 2. Environment files

| File | NODE_ENV | Purpose | Git tracked |
|------|----------|---------|:-----------:|
| `.env.dev` | development | Local development defaults | Yes |
| `.env.test` | test | Isolated test infrastructure | Yes |
| `.env.example` | — | Template for new developers | Yes |
| `.env` | development | Active local config (copy from `.env.example`) | No |

**Loading order**

- **TypeScript dev** (`NODE_ENV=development`): host env → `.env.dev` → `.env` (fallback).
- **Tests**: loaded via `dotenv-cli` from `.env.test`.
- **Python services**: walk up from the service dir loading root `.env`, service `.env`, then `.env.local` (skipped entirely in production).

If you don't have a `.env`, the infra scripts create one from `.env.example` on first run.

---

## 3. Start infrastructure

Infrastructure is containerized via Docker Compose under `infrastructure/docker/`. Start it from the monorepo root so the root `.env` is loaded.

```bash
pnpm docker:dev:up         # core: PostgreSQL, Redis, MinIO
pnpm docker:dev:up:all     # core + extended (adds Vault + Qdrant)
pnpm docker:dev:down       # stop everything
pnpm docker:dev:logs       # follow logs
pnpm docker:dev:status     # container status
```

### Services

| Tier | Service | Port(s) | Started by |
|------|---------|---------|------------|
| Core | PostgreSQL (TimescaleDB pg18) | 5432 | `docker:dev:up` |
| Core | Redis 8 | 6379 | `docker:dev:up` |
| Core | MinIO (S3) | 9000 (API), 9001 (Console) | `docker:dev:up` |
| Extended | Qdrant (vector DB) | 6333 (HTTP), 6334 (gRPC) | `docker:dev:up:all` |
| Extended | Vault (secrets, dev mode) | 8200 | `docker:dev:up:all` (`vault` profile) |

### Opt-in profiles (manual)

Some stacks are gated behind Compose profiles and are **not** started by `docker:dev:up:all`. Start them explicitly when you need them:

```bash
# Temporal — required by the Clinical Documentation Harness (apps/harness)
docker compose -f infrastructure/docker/docker-compose.yml \
               -f infrastructure/docker/docker-compose.dev.yml \
               --profile temporal up -d temporal-postgresql temporal temporal-ui
#   Temporal Web UI: http://localhost:8233   ·   gRPC frontend: localhost:7233

# RAG reranker (HF Text-Embeddings-Inference) — used by the harness hybrid retriever
docker compose -f infrastructure/docker/docker-compose.yml \
               -f infrastructure/docker/docker-compose.dev.yml \
               --profile rag up -d hope-reranker
#   reranker: http://localhost:8870
```

> By default, local dev uses `EnvSecretsProvider` against `.env.dev` and does **not** require Vault. Switch to Vault only when working on secrets/rotation (set `SECRETS_PROVIDER=vault` and follow `infrastructure/docker/README.md`).

---

## 4. Database setup

```bash
pnpm db:generate     # generate the Prisma client
pnpm db:migrate      # apply migrations (dev)
pnpm db:seed         # seed baseline data
pnpm db:studio       # open Prisma Studio

pnpm db:all          # push (force) + generate + seed in one shot
```

For a fresh checkout, the one-command bootstrap below handles infra + DB for you.

---

## 5. Run services & apps

Each service/app has its own terminal. Start infrastructure (and the DB) first.

| Name | Type | Port | Dev command |
|------|------|------|-------------|
| API Gateway | NestJS | 8868 | `pnpm dev:api` |
| STT v2 | Python / FastAPI | 8861 | `pnpm dev:stt-v2` |
| SMR v2 | Python / FastAPI | 8862 | `pnpm dev:smr-v2` |
| Guardrail | Python / FastAPI | 8863 | `pnpm dev:guardrail` |
| NLP | Python / FastAPI | 8864 | `pnpm dev:nlp` |
| Harness (API) | Python / FastAPI + Temporal | 8866 | `pnpm dev:harness` |
| Harness (worker) | Temporal worker | — | `pnpm py:harness:worker` |
| UI Playground + Admin Console | React 19 / Vite / TanStack Router | 5175 | `pnpm dev:ui-playground` |
| Example (SDK demo) | React / Vite | 5173 (Vite default) | `pnpm --filter live-transcription-example dev` |

Notes:

- **Gateway-only**: all client traffic goes through the API gateway (`:8868`). The UI dev server proxies `/api` to `http://localhost:8868/api/v1`. Direct browser access to the Python services is not used in the app flow.
- **Admin console**: it is part of `apps/ui-playground` (routes under `/admin`, code under `src/features/admin/*`) — there is no separate admin app.
- **Harness**: the FastAPI app boots even when Temporal is down (it reports "not ready"). The **worker** requires a reachable Temporal server (start the `temporal` profile from step 3). Register the search attribute once per cluster: `temporal operator search-attribute create --name HarnessTenantId --type Keyword`.
- **Guardrail**: needs an LLM engine reachable (LM Studio by default — see step 6). SMR calls Guardrail per generation for medical-content validation; the client honors its configured fail-open / fail-closed behavior, so SMR still runs if Guardrail is unavailable.

### One-command bootstrap (fresh checkout)

```bash
pnpm dev:setup     # start infra (incl. Vault), wait for health, db:all, wire Vault dev creds → then `pnpm dev:api`
pnpm test:setup    # test counterpart: start test infra, generate client, push schema, seed
```

---

## 6. Optional local LLM engines

The default local LLM engine is **LM Studio** (OpenAI-compatible, `http://localhost:1234/v1`).

- **Guardrail** defaults to LM Studio serving **IBM Granite Guardian** (`granite-guardian-4.1-8b`). Load that GGUF in LM Studio and start its server, or switch engines via `GUARDRAIL_V2_PROVIDER` (`lm-studio` | `ollama` | `azure` | `bedrock`). See [`apps/guardrail/README.md`](../apps/guardrail/README.md).
- **SMR** supports Ollama, Azure OpenAI, AWS Bedrock, and OpenAI-compatible (LM Studio) providers, toggled via `SMR_V2_*_ENABLED` / provider env vars. See [SMR V2](./smr-v2/README.md).

These engines are external processes — they are not part of Docker Compose.

---

## 7. Testing

### TypeScript

```bash
pnpm test:unit              # unit tests (excludes integration/e2e)
pnpm test:unit:watch        # watch mode
pnpm test:integration       # integration tests (real DB/Redis/Qdrant)
pnpm test:e2e               # Playwright API E2E (requires the test API running)
pnpm test:coverage          # coverage report
```

### Python (conda `arcaenv`)

```bash
pnpm py:stt-v2:test         # STT v2
pnpm py:smr-v2:test         # SMR v2
pnpm py:nlp:test            # NLP
pnpm py:harness:test        # Harness
pnpm py:guardrail:test      # Guardrail
```

Each Python service also exposes `:lint` (ruff), `:format` (black), and `:typecheck` (mypy).

### Test infrastructure (isolated ports)

```bash
pnpm docker:test:up         # start test containers (Postgres:5433, Redis:6380, MinIO:9002, Qdrant:6335, …)
pnpm test:setup             # up + generate client + push schema + seed
pnpm test:api:up            # start the API against .env.test
pnpm docker:test:down       # stop and remove test containers (with volumes)
```

---

## 8. Scripts reference

All scripts are defined in the root `package.json` and run from the monorepo root.

| Group | Script | Purpose |
|-------|--------|---------|
| Setup | `pnpm dev:setup` | One-command dev bootstrap (infra + Vault + DB) |
| Setup | `pnpm py:setup` | Create `arcaenv` and install all Python services |
| Infra (dev) | `pnpm docker:dev:up` / `:up:all` / `:down` / `:logs` / `:status` | Manage dev infrastructure |
| Database | `pnpm db:generate` / `db:migrate` / `db:seed` / `db:studio` / `db:all` | Prisma client, migrations, seed, studio |
| Dev servers | `pnpm dev:api` | NestJS API gateway (8868) |
| Dev servers | `pnpm dev:stt-v2` / `dev:smr-v2` / `dev:guardrail` / `dev:nlp` / `dev:harness` | Python services |
| Dev servers | `pnpm py:harness:worker` | Harness Temporal worker |
| Dev servers | `pnpm dev:ui-playground` | UI playground + admin console (5175) |
| Code gen | `pnpm gen:prisma` / `gen:entity` / `gen:mapper` / `gen:repository` / `gen:factory` / `gen:service` / `gen:controller` | Scaffolding generators |
| Code gen | `pnpm gen:token` / `gen:api-key` | Dev auth token / API key |
| Tests (TS) | `pnpm test:unit` / `test:integration` / `test:e2e` / `test:coverage` | TypeScript test suites |
| Tests (Py) | `pnpm py:{stt-v2,smr-v2,nlp,harness,guardrail}:test` | Python test suites |
| Test infra | `pnpm docker:test:up` / `test:setup` / `test:api:up` | Isolated test environment |
| Quality | `pnpm lint` / `pnpm format` | ESLint + Prettier |

---

## Troubleshooting

- **`conda: command not found` / wrong Python**: ensure conda is installed and on `PATH`; all `py:*` scripts use `conda run -n arcaenv` so the env must exist (`pnpm py:setup`).
- **Port already in use**: another service or a previous container is bound. Check `pnpm docker:dev:status` and the per-service port in the table above.
- **Harness `/health/ready` returns 503**: Temporal isn't reachable — start the `temporal` profile (step 3) and the worker (`pnpm py:harness:worker`).
- **Guardrail errors / timeouts**: confirm an LLM engine is running at the configured `base_url` (LM Studio at `http://localhost:1234/v1` by default).
- **macOS `libomp already initialized`**: re-run `pnpm py:setup` — it de-duplicates the OpenMP runtime after installing ML wheels.

---

## Related Documentation

- [Architecture Overview](./architecture/README.md) — topology, tech stack, deployment
- [Infrastructure](./architecture/infrastructure.md) — Docker, CI/CD, environments, ports
- [API Gateway](./api/README.md) · [STT V2](./stt-v2/README.md) · [SMR V2](./smr-v2/README.md) · [NLP](./nlp/README.md) · [Harness](./harness/README.md) · [Guardrail](./guardrail/README.md)
