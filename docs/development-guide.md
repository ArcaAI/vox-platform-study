# HOPE Development Guide

Owner: Platform Engineering · Introduced: 2026-07-04 · Last verified: 2026-08-19

The single onboarding and daily-reference document for engineers working in this monorepo. Every command below is verified against the root `package.json` and the scripts it delegates to — if a command is not in this guide or in [scripts/README.md](../scripts/README.md), it probably does not exist — the script taxonomy carries no legacy aliases. Companion documents: [docs index](./README.md), [architecture overview](./architecture/overview.md), [patterns and standards](./development-patterns-and-standards.md).

**In a hurry?** Fresh clone to a running stack is four commands — §3.1.

---

## 1. What is HOPE

HOPE is a multi-tenant healthcare AI platform for clinical consultations. It transcribes doctor-patient conversations in real time (speech-to-text with VAD, noise filtering, and speaker diarization), extracts medical entities and ontology codes, generates LLM-based clinical summaries and SOAP notes, screens output through a guardrail safety engine, and runs a clinical documentation harness — a bounded `guides → generate → sensors → gate` loop on Temporal durable workflows that produces grounded, cited drafts and gates them through clinician attestation into immutable signed notes.

Technically, it is a Turborepo + pnpm monorepo: a NestJS 11 API gateway (`apps/api`) is the system of record and the primary client-facing surface; six Python/FastAPI services (`stt`, `text`, `guardrail`, `nlp`, `harness`, `tts`) do the AI work behind it; a Next.js 16 admin console (`apps/admin-console`) is the operator UI, BFF-proxied through the gateway; browser SDK packages (`@arcaai/vox` and friends) run the audio pipeline in the host application, and `@arcaai/vox-node` is the dependency-free server-side sibling. Full topology, ports, and data flows: [architecture/overview.md](./architecture/overview.md).

## 2. Prerequisites

| Tool                    | Version                                            | Verified in                                                                                                                            |
| ----------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                 | >= 22                                              | root `package.json` `engines.node`                                                                                                     |
| pnpm                    | 10.34.5                                            | root `package.json` `packageManager`                                                                                                   |
| Docker + Docker Compose | recent                                             | required by all `infra:*` scripts                                                                                                      |
| conda                   | any recent (Miniconda/Miniforge)                   | `scripts/setup-python-env.sh` creates the shared env `arcaenv` (Python 3.11)                                                           |
| uv                      | latest                                             | Python dependency resolution — single `uv.lock` at the repo root (`pyproject.toml` uv workspace); checked by `pnpm setup:python:check` |
| LM Studio (or Ollama)   | serving an OpenAI-compatible API on :1234 (:11434) | default local LLM engine for Text/Guardrail/Harness; `pnpm stack:dev:doctor` treats LM Studio as a required check                      |

There is no `.nvmrc`; use any Node >= 22. TypeScript 5.9, Prisma 7, Vitest 4, and Playwright are installed by `pnpm install`.

**There are no git hooks.** `simple-git-hooks` was removed deliberately — nothing runs on commit. Secret scanning is enforced by the CI job `scan-gitleaks`; run `./scripts/gitleaks-precommit.sh` by hand if you want the same check locally.

## 3. First-time setup — the local development environment

### 3.1 The short path (recommended)

From a completely fresh clone, four commands get you a working stack. Each is idempotent and safe to re-run.

```bash
pnpm install          # workspace dependencies
pnpm setup:python     # shared conda env `arcaenv` (Python 3.11) — add :apple / :gpu for ML extras
pnpm setup:dev        # .env.dev + Docker infra + database + Vault, in one command
pnpm stack:dev        # start every application service in the foreground
```

Then, in a second terminal, prove it: `pnpm stack:dev:doctor` should print `All required checks passed`.

`pnpm setup:dev` is the whole environment bootstrap (`scripts/dev-setup.sh`), and it leaves a working stack with no follow-up scripts required. Its seven steps:

| Step | Does                                                                                                                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Builds `.env.dev` from the tracked `.env.sample`                                                                                              |
| 1    | Starts Docker infra — core + `vault` + `temporal` + `rag` profiles (`-o` adds observability, `-e` adds inference engines)                     |
| 2    | Waits for Postgres and Vault (including the `vault-init` AppRole bootstrap) to be ready                                                       |
| 3    | Applies the schema and seeds the database (`pnpm db:all` — this **force-resets** the dev DB)                                                  |
| 4    | Mints fresh Vault AppRole credentials into `.env.dev` (`scripts/refresh-vault-creds.sh`)                                                      |
| 5    | Wires Vault's database engine for dynamic Postgres credentials (`scripts/setup-dev-vault-db.sh`)                                              |
| 6    | Reconciles Vault kv-v2 secrets with `.env.dev` (`scripts/vault-seed-secrets.sh`) so a service reading Vault sees the same values the file has |

Variants: `pnpm setup:dev:observability` (adds Prometheus + Grafana), `pnpm setup:dev:inference` (adds vLLM / llama.cpp / TEI embed).

### 3.2 What each step does, if you want to run them separately

1. **Install.**

   ```bash
   pnpm install          # alias: pnpm setup:node
   ```

   `pnpm setup:node:rebuild` is the recovery form: drops `node_modules` + reinstalls + regenerates the Prisma client.

2. **Environment files.** `NODE_ENV` selects exactly one file — `.env.dev` (development), `.env.test` (testing), `.env.production` (a name in the loader's map only; **no file is ever read in production** — host env only). The repo tracks `.env.sample` (a consolidated, placeholder-only template covering every service) plus per-service ops references (`apps/{api,guardrail,harness,nlp,text,stt,tts}/.env.prod`). **`.env.dev` and `.env.test` are gitignored and generated** — never commit them.

   ```bash
   ./scripts/generate-env-file.sh .env.dev dev      # or .env.test test
   ```

   Read this carefully, because the behaviour is not "create if missing": `ensure_env_file` **rebuilds the target from `.env.sample` on every run**, so newly added keys always propagate and a stale file can never silently miss one. The rebuild is non-destructive to secrets — it snapshots the existing file first and carries forward every secret/credential value (generated ones _and_ provider keys you pasted in), so re-running never rotates a secret or loses a filled-in key. Only non-secret config resets to the sample. `FRESH_SECRETS=1` forces true rotation.

   Three rules hold in **both** TypeScript and Python, declared once in `packages/applications/src/common/env/env-file-resolution.ts` (Python: `packages/py-env`):

   - **host env > env file > default** — an exported variable always wins over the file;
   - **one file, no `.env` fallback** — editing `.env.dev` is observed by the gateway AND every FastAPI service;
   - **no file is read when `CI` is truthy or `NODE_ENV=production`** — host env only.

   You do NOT create a root `.env`. Compose interpolation has its own generated file (`infrastructure/docker/.env`), written by `scripts/dev-infra.sh` on every `infra:dev:up` — never hand-edit it, never read it from application code. Full variable reference: [architecture/environment-configuration-reference.md](./architecture/environment-configuration-reference.md). Adding a new runtime variable? **Do not hand-edit `.env.sample` or `turbo.json#globalEnv` — both are generated.** Declare the variable at its source (a `SettingDescriptor` of tier `env`/`vault-kv` in `packages/applications/src/services/settings-registry/descriptors/`, or the gateway's / console's own env descriptors under `apps/api/src/config/` and `apps/admin-console/src/config/`), then run `pnpm env:sync` to regenerate `.env.sample`, the per-app samples and `turbo.json#globalEnv`. `pnpm env:sync:check` is the CI drift gate (`env-drift-check`). The Python services' own `apps/<svc>/.env.sample` files are the declared exception — hand-maintained, and read verbatim into the consolidated root sample. And before adding an env var at all, check it belongs there: env is the bootstrap floor (what is needed to reach the DB or authenticate to Vault). Model ids, endpoints, thresholds, prompts and credentials are control-plane config, not env — see `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers.

3. **Python environment.** One shared conda env `arcaenv` (Python 3.11) serves all six services:

   ```bash
   pnpm setup:python              # CPU default
   pnpm setup:python:apple        # MPS extras       (also :cpu, :gpu for CUDA)
   pnpm setup:python:check        # verify prerequisites only, install nothing
   pnpm setup:python:rebuild      # recreate the env from scratch
   pnpm stt:setup                 # one service's deps only (each service has :setup[:cpu|:apple|:gpu])
   ```

   Expected: `conda env list` shows `arcaenv`. The script also checks node, pnpm, conda, uv and docker.

4. **Infrastructure.**

   ```bash
   pnpm infra:dev:up                    # base tier: core + vault + temporal + rag
   pnpm infra:dev:up:observability      # + Prometheus (9090) / Grafana (3001)
   pnpm infra:dev:up:inference          # + vLLM, llama.cpp, TEI embed
   pnpm infra:dev:status                # compose ps across all profiles
   pnpm infra:dev:validate              # container + health probe
   pnpm infra:dev:logs                  # follow infra logs
   pnpm infra:dev:restart               # down then up, keeping volumes
   pnpm infra:dev:down                  # tear down ALL known profiles
   ```

   `scripts/dev-infra.sh` is the ONLY dev-infra entrypoint; the former core-only starter was removed because it silently produced a half-working stack (no Temporal, no Vault, no reranker). Flags also work inline: `pnpm infra:dev:up -- -o -e`. Base tier brings up Postgres 5432, Redis 6379, MinIO 9000/9001, Qdrant 6333, Vault 8200, Temporal 7233 (UI 8233), TEI reranker 8870. Init containers such as `minio-setup` exit 0 by design. Local Grafana keeps dev-convenience auth (`admin`/`admin`, anonymous Viewer); production observability lives in cluster/ops.

5. **Database schema, client, and seed.**

   ```bash
   pnpm db:generate     # prisma generate + regenerate the client barrel
   pnpm db:push         # push schema to the dev DB (non-destructive)
   pnpm db:seed         # phased, FK-ordered seed
   ```

   `pnpm db:all` does force-push + generate + seed in one shot — it **drops and recreates the schema**, so only use it on a DB you are happy to lose (`setup:dev` calls it). Its tail then runs `scripts/temporal-terminate-orphans.sh`: Temporal's history lives in its own `temporal` / `temporal_visibility` databases inside `hope-postgres`, which the reset does not touch, so any workflow still open would keep retrying against rows that were just deleted.

6. **Vault.** `.env.dev` ships `SECRETS_PROVIDER=vault` + `PG_DYNAMIC_CREDS=true`, so the API will not boot until Vault AppRole credentials exist. `pnpm setup:dev` handles this; standalone repair is `./scripts/refresh-vault-creds.sh` (mint creds) and `./scripts/setup-dev-vault-db.sh` (wire the dynamic-DB engine). To opt out entirely, set `SECRETS_PROVIDER=env` and `PG_DYNAMIC_CREDS=false` in `.env.dev`.

7. **Build.**

   ```bash
   pnpm build                # everything (turbo; builds are deliberately uncached)
   pnpm build:apps           # apps/* only
   pnpm build:packages       # packages/* only
   pnpm build:core           # logger, exceptions, database, domains, applications
   ```

8. **Smoke check.**

   ```bash
   pnpm stack:dev            # terminal 1
   pnpm stack:dev:doctor     # terminal 2
   ```

   The doctor probes Docker containers, infra endpoints, LM Studio, every service health URL, Text provider registration, the harness Temporal worker process, and the STT API-key preflight. Required checks are the clinical-workspace path (Postgres, Redis, Temporal, the services); Vault/Qdrant/MinIO/reranker/Temporal-UI are reported as optional. Any FAIL line names what to start or fix — see §12.

## 4. Daily development

`pnpm stack:dev` (`scripts/dev-stack.sh`) is the aggregate supervisor. It ensures Docker infra is up (base tier), then starts **api** (8868), **stt** (8861), **stt-worker** (Dramatiq batch consumer, no port), **text** (8862), **guardrail** (8863), **nlp** (8864), **harness** (8866), the harness Temporal **worker**, and the **admin** console (5176); tails all logs in the foreground; and stops every spawned process tree on Ctrl-C. Docker infra is left running (`pnpm infra:dev:down` tears it down). `tts` is not in the default set — start it explicitly.

It **refuses** to start over a bound port (protecting an already-running stack) and refuses to start a second harness Temporal worker (two consumers on one task queue). There is deliberately no such guard for `stt-worker`: multiple Dramatiq consumers on `dramatiq:stt_batch` are legitimate.

```bash
pnpm stack:dev                      # base infra + full app stack
pnpm stack:dev:observability        # base + Prometheus/Grafana, then apps
pnpm stack:dev:inference            # base + inference engines, then apps
pnpm stack:dev -- text worker       # subset — any of: api, stt, stt-worker, text, guardrail, nlp, harness, worker, admin, tts
pnpm stack:dev -- -o text           # observability tier + subset
pnpm stack:dev:down                 # stop orphans left by a killed supervisor (pidfile-based)
DRY_RUN=1 pnpm stack:dev            # print the launch plan, start nothing
```

Per-service dev commands (Python services run inside conda `arcaenv` via `scripts/dev-service.sh` and bind `127.0.0.1` by default — export `HOST=0.0.0.0` to expose one deliberately):

| Command                             | Starts                                | Notes                                                          |
| ----------------------------------- | ------------------------------------- | -------------------------------------------------------------- |
| `pnpm api:dev`                      | API gateway :8868                     | `NODE_ENV=development`, turbo `dev` task                       |
| `pnpm api:dev:watch`                | API + applications in watch mode      | rebuilds across both packages                                  |
| `pnpm stt:dev`                      | STT :8861                             | no reload by default (protects the ~4 GB model warm-up)        |
| `pnpm stt:worker:dev`               | STT Dramatiq batch worker             | no HTTP port; several consumers are legitimate                 |
| `pnpm text:dev`                     | Text :8862                            | registers the LM Studio provider on boot                       |
| `pnpm text:worker:dev`              | Text async worker-pool consumer       | no HTTP port                                                   |
| `pnpm nlp:dev`                      | NLP :8864                             |                                                                |
| `pnpm guardrail:dev`                | Guardrail :8863                       | health at `/api/health`                                        |
| `pnpm harness:dev`                  | Harness API :8866                     | boots even when Temporal is down                               |
| `pnpm worker:dev`                   | Harness Temporal worker               | no HTTP port; hard-requires Temporal                           |
| `pnpm tts:dev`                      | TTS :8865                             | Azure + local Kokoro/Indic Parler                              |
| `pnpm admin:dev`                    | Admin console :5176                   | Next.js 16 App Router; BFF-proxies the gateway                 |
| `pnpm ui:dev` / `pnpm ui:storybook` | `@arcaai/ui` build watch / Storybook  | component work                                                 |
| `pnpm sdk:dev`, `pnpm sdk-node:dev` | browser SDK / server SDK watch builds |                                                                |
| `pnpm compat:dev`                   | v1→v2 compat playground :5177         |                                                                |
| `pnpm <svc>:dev:watch`              | scoped-reload variant                 | `<svc>` ∈ stt, text, guardrail, nlp, harness, tts (not worker) |

Support commands:

- `pnpm stack:dev:doctor` — read-only health probe of the whole local stack; exit 1 if any required check fails.
- `pnpm infra:dev:logs` — follow Docker infra logs. `stack:dev` tails service logs in the foreground and also writes one file per service under `~/.local/state/hope-dev/logs` (override with `HOPE_DEV_LOG_DIR`).
- `./scripts/dev-service.sh <svc> --print` — show the exact resolved env + command a Python dev server would run, without starting it.
- `pnpm gen:token` — dev JWT for API calls; `pnpm gen:api-key` — an API key.
- `pnpm db:studio` — Prisma Studio against the dev DB.
- `pnpm clean` (build outputs) · `clean:build` · `clean:cache` · `clean:deps` · `clean:all` (lockfile + all node_modules; last resort, follow with `pnpm install`).

## 5. Ports and services reference

| Service                                      | Port(s)                 | Kind                                                                        |
| -------------------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| API gateway (`apps/api`)                     | 8868                    | NestJS 11 — REST `/api/v1`, WS `/ws/stt/stream`, SSE                        |
| STT (`apps/stt`)                             | 8861                    | FastAPI + Dramatiq batch worker (no port)                                   |
| Text (`apps/text`)                           | 8862                    | FastAPI, SSE streaming (+ async worker pool, no port)                       |
| Guardrail (`apps/guardrail`)                 | 8863                    | FastAPI (health at `/api/health`, not `/api/v1`)                            |
| NLP (`apps/nlp`)                             | 8864                    | FastAPI + WS classify endpoints                                             |
| TTS (`apps/tts`)                             | 8865                    | FastAPI — multi-provider text-to-speech, en+ml                              |
| Harness (`apps/harness`)                     | 8866                    | FastAPI + separate Temporal worker process                                  |
| Admin console (`apps/admin-console`)         | 5176 (dev)              | Next.js 16 App Router — operator UI                                         |
| example (`apps/example`)                     | 5173 (dev)              | minimal raw-WebSocket live-transcription demo                               |
| compat-playground (`apps/compat-playground`) | 5177 (dev)              | v1→v2 SDK migration playground                                              |
| quick-compat-app (`apps/quick-compat-app`)   | 5180 (dev)              | registry-installed SDK smoke app (outside the pnpm workspace)               |
| PostgreSQL 18                                | 5432                    | `hope-postgres` (TimescaleDB image, pgvector available)                     |
| Redis 8                                      | 6379                    | BullMQ DB 0, cache DB 1, STT streams DB 2, Text streams DB 3, Dramatiq DB 5 |
| MinIO                                        | 9000 API / 9001 console | buckets: `recordings`, `generated-audio`, `documents`, `backups`            |
| Qdrant                                       | 6333 HTTP / 6334 gRPC   | speaker embeddings, RAG knowledge chunks                                    |
| Vault                                        | 8200                    | dev-mode, `vault` profile                                                   |
| Temporal                                     | 7233 gRPC / 8233 UI     | `temporal` profile; shares hope-postgres                                    |
| Reranker (TEI)                               | 8870                    | base tier (`rag` profile)                                                   |
| Prometheus / Grafana                         | 9090 / 3001             | `prometheus` (alias `observability`) profile                                |
| LM Studio / Ollama                           | 1234 / 11434            | host-run LLM engines (not in compose)                                       |

Test infrastructure is isolated on different ports: Postgres 5433, Redis 6380, MinIO 9002, Qdrant 6335, Vault 8201 (§8).

## 6. Project layout — where code lives

DDD layering, enforced by lint: `packages/database` → `packages/domains` → `packages/applications` → `apps/api`.

| Concern                                                          | Layer       | Package                 |
| ---------------------------------------------------------------- | ----------- | ----------------------- |
| Table schema, migrations, Prisma client + extensions             | Database    | `packages/database`     |
| Business entities, validation, factories                         | Domain      | `packages/domains`      |
| DB-entity mapping (mappers), data access (repositories)          | Domain      | `packages/domains`      |
| CRUD orchestration, sys-events, DTOs, service modules            | Application | `packages/applications` |
| HTTP routing, guards, gateways, interceptors — no business logic | API         | `apps/api`              |

Rules of thumb: controllers never touch Prisma; services import repositories from `@arcaai/domains`, never `@arcaai/database` at runtime; entities are created via `XxxFactory.CreateXxx()`; every mutation broadcasts a sys-event and deletes are soft.

**Code generation — read this before running a `gen:*` command.** Only `pnpm gen:model` truly scaffolds (from the Prisma DMMF). `gen:entity` / `gen:factory` reconcile barrels and check schema coverage but never create files. `pnpm gen:mapper` is **destructive — never run it** (it rewrites mappers and strips the `_version` OCC guard before crashing) and `pnpm gen:repository` is broken; both now route through `scripts/gen-guard.sh`, which refuses to run on a dirty tree and demands a typed confirmation. So entities, factories, mappers and repositories are **hand-authored**. `gen:service` / `gen:controller` also exist. `pnpm gen:check` runs the three drift checks CI runs (`gen:model:check`, `gen:entity:check`, `gen:factory:check`). Details: `.claude/rules/03-domain-layer.md` §Generated Code Discipline.

Python services (`apps/stt`, `text`, `guardrail`, `nlp`, `harness`, `tts`) are PEP-621 `src/<package>/` layouts: `main.py` (FastAPI `create_app()` + lifespan), `core/` (pydantic-settings config with a per-service `env_prefix`, logging), `api/endpoints/`, `services/`, `models/`. Tests live in `src/<pkg>/tests/` (text, guardrail, harness, tts) or a top-level `tests/` (stt, nlp). Dependencies are declared per service but locked once at the repo root — run `uv lock` at the root after changing any member's dependencies. Shared Python packages are uv-workspace members too: `py-env` (the one env loader), `py-otel` (trace propagation), `py-runtime-models` (model-cache contract), `py-async-contract`.

Frontend apps and packages: `apps/admin-console` (Next.js 16 operator UI, BFF auth + catch-all gateway proxy; governed by `.claude/rules/13-nextjs-apps.md`), `packages/ui` (`@arcaai/ui` — shadcn/Radix/cva components, Tailwind v4 tokens in `src/styles/globals.css`), `packages/agentic-sdk-v2` (`@arcaai/vox` — browser consultation SDK) composing `room`, `noise-filter`, `vad`, `stt`, `med-ner`, `pipeline`, plus `packages/vox-node` (`@arcaai/vox-node` — zero-dependency server SDK) and `packages/vox-codegen`. Shared backend packages: `logger`, `exceptions`, `types`, `utils`, `tools`, `async-contract`, `workflow-contract`, `json-schema-subset`, `config-*`.

Deep conventions with exemplar file paths: [development-patterns-and-standards.md](./development-patterns-and-standards.md). Capability-to-code mapping: [traceability/index.md](./traceability/index.md).

## 7. Database workflows

The Prisma 7 schema is multi-file: `packages/database/src/prisma/db_main/*.prisma` — `schema.prisma` holds only datasource/generator, models live in per-domain files, enums centralized in `enums.prisma`. Root `prisma.config.ts` points the CLI at that directory and loads `.env.dev`/`.env.test` by `NODE_ENV` (no env file in CI/production).

| Command                                         | Does                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm db:generate`                              | regenerate the Prisma client + index barrel                                     |
| `pnpm db:push` / `db:push:force`                | push schema without a migration (`:force` = `--force-reset --accept-data-loss`) |
| `pnpm db:seed`                                  | phased, FK-ordered seed (`src/prisma/db_main/seed/`)                            |
| `pnpm db:migrate`                               | `prisma migrate dev` + barrel regeneration — see the shadow-DB caveat below     |
| `pnpm db:migrate:create`                        | create the migration only (`--create-only`), for SQL review before applying     |
| `pnpm db:migrate:deploy` / `:status` / `:reset` | deploy / status / reset                                                         |
| `pnpm db:migrate:compat`                        | check a migration for backward compatibility with the running release           |
| `pnpm db:studio`                                | Prisma Studio                                                                   |
| `pnpm db:all`                                   | force push + generate + seed — **resets the database**, then terminates the Temporal workflows that reset orphaned |

**Authoring a migration.** The local dev DB is `db push`-managed and has NO `_prisma_migrations` ledger — and `pnpm db:all` recreates it with `--force-reset`, which would wipe any ledger baselined onto it. That is deliberate and permanent: **migrations are authored against a throwaway shadow database, never against the dev DB.** The exact recipe (create `hope_shadow`, replay the ledger onto it, `db:migrate:create`, prove no drift with `prisma migrate diff`, then re-sync the dev DB and drop the shadow) is in `.claude/rules/02-database-prisma.md` §Migration Workflow. Two traps worth repeating: `-n <name>` must go to the package-level script (`pnpm --filter @arcaai/database db:migrate:create -n task_<nnn>_<desc>`) or it is swallowed and Prisma hangs on a prompt; and `prisma migrate dev` stopping at "Enter a name for the new migration" means real ledger drift, not a hung command.

Migration review expectations: folders are named `<timestamp>_task_<nnn>_<snake_case_description>`; always inspect the generated SQL before committing; never edit a committed migration — roll forward. In prod/staging, migrations run against `DIRECT_URL` (un-pooled) while runtime traffic goes through PgBouncer (`DATABASE_URL`, port 6432, transaction mode).

**Multi-tenancy ground rules.** Every business row carries `tenantId` (no FK; the reserved SYSTEM tenant `00000000-…` owns platform-wide rows). The tenant-scope Prisma extension injects tenant predicates from CLS context, services re-assert ownership per request, and cross-tenant access answers **404, never 403**. New tenant-scoped models must be added to `TENANT_SCOPED_MODELS` in `packages/database/src/extensions/tenant-scope.ts`.

**Soft-delete ground rules.** There are no hard deletes: `repository.softDelete(id)` sets `resourceStatus: DELETED` and the extended client filters deleted rows out of every read. Models that legitimately omit soft delete (version history, WORM audit tables) must be listed in `MODELS_WITHOUT_SOFT_DELETE` in `packages/database/src/client.ts`.

Full model reference, PHI encryption, and audit mechanics: [architecture/data-and-domain-model.md](./architecture/data-and-domain-model.md).

## 8. Testing

All TypeScript suites load `.env.test` via dotenv-cli — the test stack is fully isolated from dev (Postgres 5433, Redis 6380, MinIO 9002, Qdrant 6335, its own Vault on 8201). `.env.test` is gitignored and generated the same way `.env.dev` is.

### 8.1 Bootstrapping the test environment

```bash
pnpm setup:test                    # .env.test + isolated infra + Vault creds + schema + seed
# or stepwise (requires .env.test to exist):
pnpm infra:test:up && pnpm test:db:push && pnpm test:db:seed
pnpm infra:test:down               # stops containers AND removes volumes
```

Other test-infra commands: `infra:test:status`, `infra:test:logs`, `infra:test:validate`, `infra:test:restart`. Test DB helpers: `test:db:push` (force-push schema), `test:db:seed` (seed + media seed), `test:db:reset` (both).

### 8.2 Running suites

| Suite                    | Command                                                                                                                        | Needs                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| TS unit                  | `pnpm test:unit` (watch `:watch`, UI `:ui`, coverage `test:unit:cov`)                                                          | nothing — all `*.test.ts`/`*.spec.ts` excluding integration/e2e                           |
| TS integration           | `pnpm test:integration`                                                                                                        | test infra up; `**/integration/**/*.test.ts`, sequential, live test DB                    |
| API E2E                  | `pnpm test:e2e` (`:ui`, `:debug`)                                                                                              | a running test API — `pnpm test:up:api` first; specs in `apps/api/tests/e2e/**/*.spec.ts` |
| Turbo E2E fan-out        | `pnpm test:e2e:all`                                                                                                            | runs the turbo `test:e2e` task across packages                                            |
| Contracts / cross-tenant | included in `pnpm test:unit`                                                                                                   | zod contract schemas in `tests/contracts/`; fixtures in `tests/cross-tenant/`             |
| Python (all)             | `pnpm test:py` (coverage `test:py:cov`)                                                                                        | conda `arcaenv`                                                                           |
| Python (one)             | `pnpm <svc>:test` — `stt`, `text`, `nlp`, `guardrail`, `harness`, `tts` (+ `:unit`/`:integration`/`:e2e`/`:cov` where defined) | conda `arcaenv`                                                                           |
| Shared Python packages   | `pnpm py-env:test`, `pnpm py-otel:test`                                                                                        | conda `arcaenv`                                                                           |
| Admin console            | `pnpm admin:test` (E2E `admin:test:e2e`)                                                                                       | Vitest unit specs colocated in `__tests__/`; Playwright E2E                               |
| UI component tests       | `pnpm ui:test`, `pnpm ui:test:ct` (Playwright CT)                                                                              | only when your change is inside `packages/ui` — see the scope note below                  |
| Everything               | `pnpm test:all`                                                                                                                | unit → integration → e2e → Python, in sequence                                            |

**Managed runs** bring infra and services up, run the suite, print the result, then tear down only what they started — the least-surprise way to run a suite you don't have an environment for:

```bash
pnpm test:unit:managed
pnpm test:integration:managed
pnpm test:e2e:managed
pnpm test:py:managed
pnpm <svc>:test:managed            # one Python service
./scripts/test-run.sh e2e --keep   # leave everything running afterwards
```

To hold a long-lived test environment instead, `pnpm stack:test` starts the app stack against `.env.test` (`stack:test:down`, `stack:test:doctor`), and `pnpm test:up:<target>` starts exactly one (`api`, `admin`, `stt`, `text`, `nlp`, `guardrail`, `harness`, `tts`, `worker`).

Typical full sequence from a fresh checkout:

```bash
pnpm setup:test
pnpm test:unit
pnpm test:integration
pnpm test:up:api     # terminal 1 — test API on 8868 against .env.test
pnpm test:e2e        # terminal 2
pnpm infra:test:down
```

**Test scope exclusion (standing owner directive).** Do not run the unit suites of `apps/compat-playground`, `apps/quick-compat-app`, or `packages/ui` as part of a normal change, and do not treat their failures as a gate. Run them only when your change is inside one of those directories, and then run just that package's suite. When a repo-wide aggregate surfaces failures from those three and your change is elsewhere, report them as out of scope.

**TDD expectation.** Test-first is the house workflow: write a failing test, confirm it fails for the right reason, write minimal code to pass, refactor. Unit tests live next to the code (`src/**/__tests__/` or a sibling `*.test.ts`); e2e uses `.spec.ts`. Behavior over implementation; paste actual test output before claiming done.

## 9. Code quality

```bash
pnpm lint            # turbo — every TS package (ESLint 9 flat config)
pnpm lint:fix
pnpm lint:py         # ruff over every Python service + shared package
pnpm lint:all        # lint + lint:py

pnpm typecheck       # turbo tsc --noEmit
pnpm typecheck:py    # mypy
pnpm typecheck:all

pnpm format          # Prettier over **/*.{ts,tsx,md} (singleQuote, printWidth 150)
pnpm format:py       # black, line length 100
pnpm format:all
pnpm format:check    # non-mutating

pnpm verify          # lint:all && typecheck:all && test — the pre-push gate
```

Per-target variants exist for every workspace (`api:lint`, `admin:typecheck`, `ui:format:check`, `harness:lint:fix`, …). Spellings are fixed: `typecheck` (never `type-check`/`check-types`), `test:cov` (never `test:coverage`), and a `lint` script never carries `--fix`.

Architecture lint rules you will actually hit (in `packages/config-eslint/flat/core.js` + `packages/eslint-plugin-arcaai-internal/`):

- `arcaai-internal/no-controller-direct-prisma` — controllers must not touch `databaseService.client`; go through a service + repository.
- Service-layer `no-restricted-syntax` — application services must not use `databaseService.client` either.
- `arcaai-internal/no-direct-downstream-url-env` — never read `process.env.TEXT_URL|STT_URL|NLP_URL|GUARDRAIL_URL|HARNESS_URL` in gateway modules; inject `IConfigService.getConfigValue(...)`.
- `no-restricted-imports` — the unscoped Prisma client (`getPlatformAdminPrismaClient_Unscoped`) is banned everywhere except seeds, back-fill scripts, and test fixtures.

Caveat: inside `packages/*` these are downgraded to warnings (`eslint-plugin-only-warn`); in `apps/api` they are hard errors. Treat the warnings as errors anyway.

## 10. Releasing

npm packages (the `@arcaai/vox` SDK family) are released with **Changesets**, not by hand:

```bash
pnpm changeset            # describe your change; commit the generated file with the PR
pnpm changeset:status      # what would be released, vs origin/dev
```

CI runs `changeset:version` + `changeset:publish`; the SDK family is a `fixed` group so its versions move in lockstep. `scripts/publish-sdk.sh` (`pnpm sdk:publish`) is **superseded — break-glass only**, for pushing one package by hand after a part-way publish failure; run it with `--dry-run` first.

Service images are versioned by git tag, never by `package.json`: `<SVC>-<M>.<m>.<p>` builds one image, `ALL-<M>.<m>.<p>` builds the platform train, and a separate `vX.Y.Z` tag triggers digest-only promotion to prod (no rebuild). Full detail: [operations/release-runbook.md](./operations/release-runbook.md) and [operations/versioning.md](./operations/versioning.md).

## 11. Ticket and documentation workflow

- **Numbering:** tickets are `TASK-XXX`. To assign a new number, take the highest existing ticket across `docs/implementation/` and `docs/archive/` and increment by 1; confirm with the requester before starting.
- **Structure:** one folder per ticket — `docs/implementation/[TICKET]-[Short-Name]/README.md` — updated throughout the lifecycle. One main document per ticket; fixes append to its Change History instead of creating new files.
- **Required sections:** header (ticket, dates, status), requirement analysis, current-state evaluation, implementation plan (user-approved before coding), implementation summary, change history.
- **Status values:** `Pending | In Progress | Completed | Blocked | Review`.
- **Archive policy:** completed tickets move to `docs/archive/` — an immutable record. Do not edit archived documents; references inside them may describe removed components and are intentionally left as-is.

The 5-phase lifecycle (Receive & Confirm → Explore & Research → Plan → Implement → Verify & Document), including which gate needs user approval, is in `.claude/rules/01-development-workflow.md`.

## 12. Deployment overview

Local development runs infrastructure in Docker Compose and application services on the host — nothing application-level is containerized locally. Compose files: `infrastructure/docker/docker-compose.yml` (Postgres, Redis, MinIO, Qdrant) + `docker-compose.dev.yml` (profile tiers `vault`, `temporal`, `rag`, `prometheus`, `inference`), driven by `scripts/dev-infra.sh`.

The cluster target is k3s + Argo CD GitOps, and **those manifests are not in this repo** — they live in the separate GitLab project `arca/hope-v2-deployment` (Kustomize base + `overlays/{dev,staging,prod}`). Only the `hope-v2-dev` namespace exists today; Argo CD auto-syncs `main` with `prune`/`selfHeal` still off. Promotion is digest-pinned and performed by CI (`promote-dev` / `promote-staging` / `promote-prod`) — never by editing the live cluster and never by moving a tag. Postgres and MinIO are external (HA Patroni/HAProxy/PgBouncer).

`infrastructure/single-deployment/` holds one production blueprint: the HA Vault stack (3-node Raft + Transit auto-unseal). Day-2 Vault operations: [operations/vault/README.md](./operations/vault/README.md). Full reference: [deployment/README.md](../deployment/README.md), [infrastructure/README.md](../infrastructure/README.md); security posture: [infrastructure/SECURITY_DEPLOYMENT_GUIDE.md](../infrastructure/SECURITY_DEPLOYMENT_GUIDE.md).

## 13. Troubleshooting

Run `pnpm stack:dev:doctor` first — it pinpoints most of these.

| Symptom                                                                                    | Cause and fix                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stack:dev` refuses to start: "port already bound", or API boot fails to bind 8868/9229    | A stale watcher or another stack holds the port. `pnpm stack:dev:down` stops recorded orphans; otherwise `lsof -nP -iTCP:8868 -sTCP:LISTEN` and kill the pid.                                                                                        |
| `Error: conda environment 'arcaenv' not found`                                             | The shared env was never created — `pnpm setup:python` (`:apple`/`:gpu` for ML extras).                                                                                                                                                              |
| Doctor FAILs `docker:hope-temporal`; harness worker exits on start                         | Infra is not on the base tier. `pnpm infra:dev:up` starts core + vault + temporal + rag — use it rather than starting compose by hand.                                                                                                               |
| API boot: `VAULT_ROLE_ID … is required when SECRETS_PROVIDER=vault`                        | Fresh clone, or the dev Vault container was recreated (dev Vault state is in-memory — `docker compose down -v` wipes it). Run `./scripts/refresh-vault-creds.sh`, or just `pnpm setup:dev`.                                                          |
| API boot: `failed to find entry for connection with name: "hope-main"`                     | Vault's database engine is not wired to the dev DB — `./scripts/setup-dev-vault-db.sh` (needs the schema applied first).                                                                                                                             |
| API boot: `wrapping token is not valid` on the second start                                | `VAULT_WRAPPED_SECRET_ID` (single-use, prod shape) is set in dev. Blank it and use the raw reusable `VAULT_SECRET_ID` — re-run `./scripts/refresh-vault-creds.sh`.                                                                                   |
| TypeScript cannot resolve the Prisma client / types drift after pulling schema changes     | The generated client is stale — `pnpm db:generate`, then rebuild.                                                                                                                                                                                    |
| Text is up but every generate 404s; live summary never appears                             | Text has zero LLM providers registered. Start it via `pnpm text:dev` and ensure LM Studio is serving on :1234 with a model loaded.                                                                                                                   |
| STT internal calls all return 401                                                          | `API_GATEWAY_KEY` is missing or a placeholder. Diagnose with `./scripts/dev-service.sh --check-stt-key`; set a real key or generate one with `pnpm gen:api-key`.                                                                                     |
| STT first start takes forever                                                              | Model downloads + ~4 GB warm-up on first boot (set `HUGGINGFACE_TOKEN` if rate-limited). This is why `stt:dev` runs without reload.                                                                                                                  |
| Ran `pnpm db:all` and lost local data                                                      | Expected — it force-resets the schema. Non-destructive path: `pnpm db:push && pnpm db:seed`.                                                                                                                                                         |
| A `gen:*` command asks for a typed confirmation, or refuses on a dirty tree                | That is `scripts/gen-guard.sh` protecting you from `gen:mapper` (destructive) / `gen:repository` (broken). Do not force past it — those two layers are hand-authored.                                                                                |
| A new env var works locally but fails in another service or CI                             | Its declaration never reached the generated artifacts. Declare it at its source, then run `pnpm env:sync` (never hand-edit `.env.sample` / `turbo.json#globalEnv`); `pnpm env:sync:check` is the CI gate.                                            |
| `pnpm test:e2e` sporadically fails auth / returns 429 on login, worse on back-to-back runs | `/auth/login` is throttled to 5/min per source IP; every Playwright worker shares that counter, and the e2e API runs the throttler in-memory so the window persists across rapid re-runs. Restart the API (`pnpm test:up:api`) between fast re-runs. |

## 14. Documentation map

| Document                                                                                                                        | Contents                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [docs/README.md](./README.md)                                                                                                   | Documentation index — start here                                                                                                                         |
| [docs/architecture/overview.md](./architecture/overview.md)                                                                     | System context, service topology + ports, data flows, deployment topologies                                                                              |
| [docs/architecture/data-and-domain-model.md](./architecture/data-and-domain-model.md)                                           | Prisma domain model, tenancy, soft delete, audit, PHI encryption                                                                                         |
| [docs/architecture/environment-configuration-reference.md](./architecture/environment-configuration-reference.md)               | Full env-var reference and per-service variable tables                                                                                                   |
| [docs/architecture/configuration-storage-classification.md](./architecture/configuration-storage-classification.md)             | Where an admin-controllable variable lives: data classes ↔ storage tiers (Vault vs DB vs env), descriptors, `failMode`, write-lane guards, anti-patterns |
| [docs/architecture/model-and-config-plane.md](./architecture/model-and-config-plane.md)                                         | Model selection, provider location + BYO credentials, runtime profiles, model retention                                                                  |
| [docs/development-patterns-and-standards.md](./development-patterns-and-standards.md)                                           | Layer-by-layer coding patterns with exemplar file paths; the 20 most important do/don'ts                                                                 |
| [docs/traceability/index.md](./traceability/index.md)                                                                           | Capability → service → models → routes → tests mapping (per domain)                                                                                      |
| [docs/operations/release-runbook.md](./operations/release-runbook.md) · [versioning.md](./operations/versioning.md)             | Releasing npm packages and service images                                                                                                                |
| [scripts/README.md](../scripts/README.md)                                                                                       | Every operational script: dev, test, Vault, CI, diagnostics                                                                                              |
| [tests/README.md](../tests/README.md)                                                                                           | Shared test tree, isolated test infra, how each suite runs                                                                                               |
| [infrastructure/README.md](../infrastructure/README.md) · [infrastructure/docker/README.md](../infrastructure/docker/README.md) | Infrastructure map; local Docker guide                                                                                                                   |
| [deployment/README.md](../deployment/README.md)                                                                                 | k3s + ArgoCD GitOps deployment, environments, CI/CD                                                                                                      |
| [docs/operations/vault/README.md](./operations/vault/README.md)                                                                 | HA Vault operator runbook                                                                                                                                |
| `.claude/rules/*.md`                                                                                                            | Per-surface engineering rules (workflow, database, domain, services, API, Python, UI, infra)                                                             |
| `apps/*/README.md`, `packages/*/README.md`                                                                                      | Per-app / per-package documentation                                                                                                                      |
