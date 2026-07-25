# HOPE Development Guide

Owner: Platform Engineering · Introduced: 2026-07-04 · Last verified: 2026-07-21

The single onboarding and daily-reference document for engineers working in this monorepo. Every command below is verified against the root `package.json` and the referenced config files. Companion documents: [docs index](./README.md), [architecture overview](./architecture/overview.md), [patterns and standards](./development-patterns-and-standards.md).

---

## 1. What is HOPE

HOPE is a multi-tenant healthcare AI platform for clinical consultations. It transcribes doctor-patient conversations in real time (speech-to-text with VAD, noise filtering, and speaker diarization), extracts medical entities and ontology codes, generates LLM-based clinical summaries and SOAP notes, screens output through a guardrail safety engine, and runs a clinical documentation harness — a bounded `guides → generate → sensors → gate` loop on Temporal durable workflows that produces grounded, cited drafts and gates them through clinician attestation into immutable signed notes.

Technically, it is a Turborepo + pnpm monorepo: a NestJS 11 API gateway (`apps/api`) is the system of record and the primary client-facing surface; six Python/FastAPI services (`stt-v2`, `smr`, `guardrail`, `nlp`, `harness`, `tts-v2`) do the AI work behind it; a Next.js 16 admin console (`apps/admin-console`) is the operator UI, BFF-proxied through the gateway; browser SDK packages (`@arcaai/vox` and friends) run the audio pipeline in the host application. Full topology, ports, and data flows: [architecture/overview.md](./architecture/overview.md).

## 2. Prerequisites

| Tool | Version | Verified in |
|---|---|---|
| Node.js | >= 22 | root `package.json` `engines.node` |
| pnpm | 10.31.x | root `package.json` `packageManager` (`pnpm@10.31.0`) |
| Docker + Docker Compose | recent | required by all `infra:*` / `docker:*` scripts |
| conda | any recent (Miniconda/Miniforge) | `scripts/setup-python-env.sh` creates the shared env `arcaenv` (Python 3.11) |
| uv | latest | Python dependency resolution — single `uv.lock` at the repo root (`pyproject.toml` uv workspace); checked by `pnpm py:setup:check` |
| LM Studio (or Ollama) | serving OpenAI-compatible API on :1234 (:11434) | default local LLM engine for SMR/Guardrail/Harness; `pnpm dev:doctor` treats LM Studio as a required check |

There is no `.nvmrc`; use any Node >= 22. TypeScript 5.9, Prisma 7, Vitest 4, and Playwright are installed by `pnpm install`.

## 3. First-time setup

1. **Clone and install.**

   ```bash
   git clone <repo-url> hope-v2 && cd hope-v2
   pnpm install
   ```

   Expected: workspace dependencies installed; the gitleaks pre-commit hook is registered via `simple-git-hooks` (skips with a warning if gitleaks is not installed).

2. **Environment files.** The repo tracks `.env.dev` (development), `.env.test` (testing), and `.env.production` (reference); `NODE_ENV` selects which one is loaded, and host environment variables always win. Docker Compose reads an untracked root `.env` — create it if missing:

   ```bash
   cp .env.example .env
   ```

   Expected: `.env` exists; the defaults (Postgres `postgres/postgres`, MinIO `minio_admin`) match what the compose files assume. See `.env.example` header for the full convention.

3. **Python environment.** Creates/updates the shared conda env `arcaenv` (Python 3.11) with dependencies for all six services:

   ```bash
   pnpm py:setup            # add --apple (MPS) or --gpu (CUDA) via py:setup:apple / py:setup:gpu
   pnpm py:setup:check      # verify prerequisites only
   ```

   Expected: `conda env list` shows `arcaenv`; the script also checks node, pnpm, conda, uv, docker, and make.

4. **Start infrastructure.**

   ```bash
   pnpm infra:up
   ```

   This runs both compose files (`infrastructure/docker/docker-compose.yml` + `docker-compose.dev.yml`) with the base tier — `vault` + `temporal` + `rag` — Postgres 5432, Redis 6379, MinIO 9000/9001, Qdrant 6333, Vault 8200, Temporal 7233 (UI 8233), TEI reranker 8870. Tier flags: `pnpm infra:up -- -o` (or `pnpm infra:observability:up` / `pnpm dev:setup-o`) adds Prometheus (9090) + Grafana (3001); `pnpm infra:up -- -e` (or `pnpm dev:setup-e`) adds the inference profile (vLLM, llama.cpp, TEI embed). Local Grafana keeps dev-convenience auth (`admin`/`admin`, anonymous Viewer); production observability lives in cluster/ops, not this Compose file. The older `pnpm docker:dev:up` starts core only (no Vault/Temporal/rag) — prefer `infra:up`. Expected: `pnpm infra:status` shows all containers healthy (init containers like `minio-setup` exit 0 by design).

5. **Database schema, client, and seed.**

   ```bash
   pnpm db:generate         # prisma generate + regenerate the client barrel
   pnpm db:push             # push schema to the dev DB (non-destructive)
   pnpm db:seed             # phased, FK-ordered seed
   ```

   Expected: generated client in `packages/database/src/generated/core-prisma-client`; `core` schema created in the `hope` DB; seed prints created tenants/users/roles. `pnpm db:all` does push + generate + seed in one shot but uses `--force-reset` — it **drops and recreates the schema**; only use it on a DB you are happy to lose.

6. **Vault bootstrap.** `.env.dev` ships `SECRETS_PROVIDER=vault` + `PG_DYNAMIC_CREDS=true`, so the API will not boot until Vault AppRole credentials exist. The one-command, idempotent bootstrap (it also covers steps 4-5, so you can run it instead of them):

   ```bash
   pnpm dev:setup
   ```

   Expected: infra up, DB migrated + seeded, fresh `VAULT_ROLE_ID`/`VAULT_SECRET_ID` written into `.env.dev`, Vault's database engine wired for dynamic PG credentials. To opt out of Vault entirely, set `SECRETS_PROVIDER=env` and `PG_DYNAMIC_CREDS=false` in `.env.dev`.

7. **Build.**

   ```bash
   pnpm build
   ```

   Expected: turbo builds all packages and apps (builds are deliberately uncached); no TypeScript errors.

8. **Smoke check.** Start the stack, then verify:

   ```bash
   pnpm dev:stack           # terminal 1 — full clinical-workspace stack
   pnpm dev:doctor          # terminal 2
   ```

   Expected: `All required checks passed`. The doctor probes Docker containers, infra endpoints, LM Studio, every service health URL, SMR provider registration, the harness Temporal worker process, and the STT API-key preflight — any FAIL line tells you exactly what to start or fix (see section 12).

## 4. Daily development

The aggregate supervisor is `pnpm dev:stack` (`scripts/dev-stack.sh`): it first ensures Docker infra is up (base: core + vault + temporal + rag), then starts api (8868), stt (8861), smr (8862), guardrail (8863), nlp (8864), harness (8866), the harness Temporal worker, and the admin console (5176), tails all logs in the foreground, and stops app processes on Ctrl-C (Docker infra stays up — use `pnpm infra:down` to tear it down). tts-v2 (8865) and the deprecated ui-playground are not in the default set — start them explicitly. It refuses to start over busy ports or a second Temporal worker.

```bash
pnpm dev:stack                      # ensure base Docker infra, then full app stack
pnpm dev:stack-o                    # base + Prometheus/Grafana, then apps
pnpm dev:stack-e                    # base + inference engines, then apps
pnpm dev:stack -- smr worker        # subset (any of: api, stt, smr, guardrail, nlp, harness, worker, ui, tts)
pnpm dev:stack -- -o smr            # observability tier + subset
pnpm dev:stack down                 # stop orphans left by a killed supervisor (pidfile-based; no-op if none)
DRY_RUN=1 pnpm dev:stack            # print the launch plan, start nothing
```

Per-service dev commands (Python services run inside conda `arcaenv` via `scripts/dev-service.sh`, bind `127.0.0.1` by default — export `HOST=0.0.0.0` to expose one deliberately):

| Command | Starts | Notes |
|---|---|---|
| `pnpm dev:api` | API gateway :8868 | `NODE_ENV=development`, turbo `dev` task |
| `pnpm dev:api:watch` | API + applications in watch mode | rebuild on change across both packages |
| `pnpm dev:stt-v2` | STT-v2 :8861 | no reload by default (protects the ~4 GB model warm-up) |
| `pnpm dev:smr-v2` | SMR :8862 | registers the LM Studio provider (`LM_STUDIO_MODEL`, default `gemma-4-e4b-it-qat`) |
| `pnpm dev:nlp` | NLP :8864 | |
| `pnpm dev:guardrail` | Guardrail :8863 | |
| `pnpm dev:harness` | Harness API :8866 | boots even when Temporal is down |
| `pnpm dev:harness:worker` | Harness Temporal worker | no HTTP port; hard-requires Temporal (`pnpm infra:up`) |
| `pnpm dev:tts-v2` | TTS-v2 :8865 | multi-provider text-to-speech (Azure + local Kokoro/Indic Parler) |
| `pnpm dev:admin` | Admin console :5176 | Next.js 16 App Router (`next dev`); BFF-proxies the gateway |
| `pnpm dev:<service>:watch` | scoped-reload variant | for stt-v2, smr-v2, guardrail, nlp, harness, tts-v2 (not worker) |

Support commands:

- `pnpm dev:doctor` — read-only health probe of the whole local stack; exit 1 if any required check fails.
- `pnpm infra:logs` — follow Docker infra logs; `pnpm dev:stack` tails service logs directly, and writes one file per service under `~/.local/state/hope-dev/logs` (override with `HOPE_DEV_LOG_DIR`).
- `pnpm gen:token` — generate a dev JWT for API calls; `pnpm gen:api-key` — generate an API key.
- `pnpm ok` — full reset: `db:all` (destructive push + seed) then build everything.
- `pnpm clean` — remove build outputs; `pnpm nuke` — drop the lockfile + all node_modules and reinstall (last resort).
- `./scripts/dev-service.sh <svc> --print` — show the exact resolved env + command a Python dev server would run, without starting it.

## 5. Ports and services reference

| Service | Port(s) | Kind |
|---|---|---|
| API gateway (`apps/api`) | 8868 | NestJS 11 — REST `/api/v1`, WS `/ws/stt-v2/stream`, SSE |
| STT-v2 (`apps/stt-v2`) | 8861 | FastAPI + Dramatiq batch worker (no port) |
| SMR (`apps/smr`) | 8862 | FastAPI, SSE streaming |
| Guardrail (`apps/guardrail`) | 8863 | FastAPI (health at `/api/health`, not `/api/v1`) |
| NLP (`apps/nlp`) | 8864 | FastAPI + WS classify endpoints |
| Harness (`apps/harness`) | 8866 | FastAPI + separate Temporal worker process |
| TTS-v2 (`apps/tts-v2`) | 8865 | FastAPI — multi-provider text-to-speech (Azure + local Kokoro/Indic Parler), en+ml |
| Admin console (`apps/admin-console`) | 5176 (dev) | Next.js 16 App Router — operator UI, BFF-proxies the gateway |
| ui-playground (`apps/ui-playground`) | 5175 (dev) | React/Vite — **deprecated**, no development plan |
| example (`apps/example`) | 5173 (dev) | minimal live-transcription demo |
| PostgreSQL 18 | 5432 | `hope-postgres` (TimescaleDB image, pgvector available) |
| Redis 8 | 6379 | BullMQ DB 0, cache DB 1, STT streams DB 2, SMR streams DB 3, Dramatiq DB 5 |
| MinIO | 9000 API / 9001 console | buckets: `recordings`, `generated-audio`, `documents`, `backups` |
| Qdrant | 6333 HTTP / 6334 gRPC | speaker embeddings, RAG knowledge chunks |
| Vault | 8200 | dev-mode, `vault` profile |
| Temporal | 7233 gRPC / 8233 UI | `temporal` profile; shares hope-postgres |
| Reranker (TEI) | 8870 | base tier (`rag` profile; started by `infra:up` / `dev:setup` / `dev:stack`) |
| Prometheus / Grafana | 9090 / 3001 | `prometheus` (alias `observability`) profile |
| LM Studio / Ollama | 1234 / 11434 | host-run LLM engines (not in compose) |

Test infrastructure is isolated on different ports: Postgres 5433, Redis 6380, MinIO 9002, Qdrant 6335 (see section 8).

## 6. Project layout — where code lives

DDD layering, enforced by lint: `packages/database` → `packages/domains` → `packages/applications` → `apps/api`.

| Concern | Layer | Package |
|---|---|---|
| Table schema, migrations, Prisma client + extensions | Database | `packages/database` |
| Business entities, validation, factories | Domain | `packages/domains` |
| DB-entity mapping (mappers), data access (repositories) | Domain | `packages/domains` |
| CRUD orchestration, sys-events, DTOs, service modules | Application | `packages/applications` |
| HTTP routing, guards, gateways, interceptors — no business logic | API | `apps/api` |

Rules of thumb: controllers never touch Prisma; services import repositories from `@arcaai/domains`, never `@arcaai/database` at runtime; entities are created via `XxxFactory.CreateXxx()`; every mutation broadcasts a sys-event and deletes are soft. Generator caveat: only `pnpm gen:model` truly scaffolds a domain layer. `gen:entity`/`gen:factory` reconcile barrels and check schema coverage but never create files; `gen:mapper` is destructive (never run it — it strips the `_version` OCC guard) and `gen:repository` is broken, so entities/factories/mappers/repositories are hand-authored. `gen:service | gen:controller` also exist. CI fails if the generated model layer drifts or an entity/factory misses a persisted column. Details: `.claude/rules/03-domain-layer.md` §Generated Code Discipline.

Python services (`apps/stt-v2`, `smr`, `guardrail`, `nlp`, `harness`, `tts-v2`) are PEP-621 `src/<package>/` layouts: `main.py` (FastAPI `create_app()` + lifespan), `core/` (pydantic-settings config with per-service `env_prefix`, logging), `api/endpoints/`, `services/`, `models/`. Tests live in `src/<pkg>/tests/` (smr, guardrail, harness, tts-v2) or top-level `tests/` (stt-v2, nlp). Dependencies are declared per service but locked once at the repo root (`uv.lock`); run `uv lock` after changing any member's dependencies.

Frontend apps and packages: `apps/admin-console` (@arcaai/admin-console — Next.js 16 App Router operator UI, BFF auth + catch-all gateway proxy, consumes `@arcaai/ui`; governed by `.claude/rules/13-nextjs-apps.md`), `packages/ui` (@arcaai/ui — shadcn/Radix/cva component library, Tailwind v4 tokens in `src/styles/globals.css`), `packages/agentic-sdk-v2` (@arcaai/vox — consultation SDK, internal Zustand store behind hooks) composing `room`, `noise-filter`, `vad`, `stt`, `med-ner`, `pipeline`. Shared backend packages: `logger`, `exceptions`, `types`, `utils`, `tools`, `config-*`.

Deep conventions with exemplar file paths: [development-patterns-and-standards.md](./development-patterns-and-standards.md). Capability-to-code mapping: [traceability-matrix.md](./traceability-matrix.md).

## 7. Database workflows

The Prisma 7 schema is multi-file: `packages/database/src/prisma/db_main/*.prisma` — `schema.prisma` holds only datasource/generator, models live in per-domain files (`user.prisma`, `consultation.prisma`, `harness.prisma`, ...), enums centralized in `enums.prisma`. Root `prisma.config.ts` points the CLI at this directory and loads `.env.dev`/`.env.test` by `NODE_ENV` (no env file in CI/production).

| Command | Does |
|---|---|
| `pnpm db:migrate` | `prisma migrate dev --skip-generate` — create + apply a migration |
| `pnpm db:migrate:create` | create the migration only (`--create-only`), for SQL review before applying |
| `pnpm db:migrate:deploy` / `db:migrate:status` / `db:migrate:reset` | deploy / status / reset |
| `pnpm db:generate` | regenerate the Prisma client + index barrel |
| `pnpm db:push` / `db:push:force` | push schema without a migration (`:force` = `--force-reset --accept-data-loss`) |
| `pnpm db:seed` | phased, FK-ordered seed (`src/prisma/db_main/seed/`) |
| `pnpm db:studio` | Prisma Studio |
| `pnpm db:all` | force push + generate + seed — **resets the database** |

Migration review expectations: folders are named `<timestamp>_task_<nnn>_<snake_case_description>`; always inspect the generated SQL before committing; never edit a committed migration — roll forward instead. In prod/staging, migrations run against `DIRECT_URL` (un-pooled) while runtime traffic goes through PgBouncer (`DATABASE_URL`, port 6432, transaction mode).

**Multi-tenancy ground rules.** Every business row carries `tenantId` (no FK; the reserved system tenant `00000000-...` owns platform-wide rows). The `tenantScopeFilter` Prisma extension injects tenant predicates into every query from CLS context, services re-assert ownership per-request, and cross-tenant access answers 404 — never 403 — to avoid existence leaks. New tenant-scoped models must be added to `TENANT_SCOPED_MODELS` in `packages/database/src/extensions/tenant-scope.ts`.

**Soft-delete ground rules.** There are no hard deletes: `repository.softDelete(id)` sets `resourceStatus: DELETED`, and the extended Prisma client filters deleted rows out of every read by default. Models that legitimately omit soft-delete (version history, WORM audit tables) must be listed in `MODELS_WITHOUT_SOFT_DELETE` in `packages/database/src/client.ts`.

Full model reference, PHI encryption, and audit mechanics: [architecture/data-and-domain-model.md](./architecture/data-and-domain-model.md).

## 8. Testing

All TypeScript suites load `.env.test` via dotenv-cli — the test stack is fully isolated from dev (Postgres 5433, Redis 6380, MinIO 9002, Qdrant 6335, static credentials, no Vault). Bootstrap it with `pnpm test:setup` (infra + schema push + seed in one command), or stepwise `pnpm docker:test:up && pnpm test:db:push && pnpm test:db:seed`. `pnpm docker:test:down` stops the containers and removes volumes.

| Suite | Command | Config | Needs |
|---|---|---|---|
| TS unit | `pnpm test:unit` (watch `test:unit:watch`, UI `test:unit:ui`, coverage `test:coverage`) | `vitest.config.ts` | nothing — all `*.test.ts`/`*.spec.ts` excluding integration/e2e/ui-playground/PgBouncer rig |
| TS integration | `pnpm test:integration` | `vitest.integration.config.ts` | test infra up; runs `**/integration/**/*.test.ts` sequentially against the live test DB |
| API E2E | `pnpm test:e2e` (UI `test:e2e:ui`, debug `test:e2e:debug`) | `playwright.config.ts` | a running test API: `pnpm test:api:up` first (8868, `.env.test`); specs in `apps/api/tests/e2e/**/*.spec.ts` |
| Turbo E2E fan-out | `pnpm test:e2e:all` | per-package | runs the turbo `test:e2e` task across packages |
| SDK E2E | `npx playwright test -c tests/e2e/sdk/playwright.config.ts` | `tests/e2e/sdk/playwright.config.ts` | running API; no root pnpm alias |
| Contracts | included in `pnpm test:unit` | `vitest.config.ts` | nothing — zod schema validation in `tests/contracts/` (STT and SMR contracts) |
| Cross-tenant | included in `pnpm test:unit` + `task-307-*` e2e specs | — | fixture in `tests/cross-tenant/fixtures.ts` |
| Python: STT-v2 | `pnpm py:stt-v2:test` (`:unit`, `:integration`, `:cov`) | `apps/stt-v2/pyproject.toml` | conda `arcaenv` |
| Python: SMR | `pnpm py:smr-v2:test` (`:unit`, `:cov`) | `apps/smr/pyproject.toml` | conda `arcaenv` |
| Python: NLP | `pnpm py:nlp:test` | `apps/nlp/pyproject.toml` | conda `arcaenv` |
| Python: Guardrail | `pnpm py:guardrail:test` (`:cov`) | `apps/guardrail/pyproject.toml` | conda `arcaenv` |
| Python: Harness | `pnpm py:harness:test` (`:unit`, `:cov`) | `apps/harness/pyproject.toml` | conda `arcaenv`; runs in CI as `test-harness` (hermetic — no DB/Redis) |
| Python: TTS-v2 | `pnpm py:tts-v2:test` (`:unit`, `:cov`) | `apps/tts-v2/pyproject.toml` | conda `arcaenv` |
| Admin console | `pnpm --filter @arcaai/admin-console test` (E2E `test:e2e`) | `apps/admin-console` Vitest / Playwright | Vitest unit specs colocated in `__tests__/`; Playwright E2E |
| Everything | `pnpm test:all` / `pnpm test:ci` | — | unit → integration → e2e in sequence |

Test DB helpers: `pnpm test:db:push` (force-push schema), `pnpm test:db:seed` (seed + media seed), `pnpm test:db:reset` (both).

Typical full sequence from a fresh checkout:

```bash
pnpm test:setup      # test infra + schema + seed
pnpm test:unit
pnpm test:integration
pnpm test:api:up     # terminal 1 — test API on 8868
pnpm test:e2e        # terminal 2
pnpm docker:test:down
```

**TDD expectation.** Test-first is the house workflow: write a failing test, confirm it fails for the right reason, write minimal code to pass, refactor. Unit tests live next to the code (`src/**/__tests__/` or sibling `*.test.ts`); e2e uses `.spec.ts`. Behavior over implementation; evidence (actual test output) before claiming done.

## 9. Code quality

- `pnpm lint` — turbo runs each package's ESLint (ESLint 9 flat config: per-package `eslint.config.mjs` spreading the `packages/config-eslint/flat/` presets; do not reintroduce eslintrc-format configs).
- `pnpm format` — Prettier over `**/*.{ts,tsx,md}` (`singleQuote`, `printWidth: 150`).
- `pnpm build` / `pnpm build:api` / `build:packages` / `build:modules` / `build:sdk` — scoped turbo builds.
- Python per service: `pnpm py:<svc>:lint` (ruff), `py:<svc>:format` (black, line length 100), `py:<svc>:typecheck` (mypy), where `<svc>` is `stt-v2`, `smr-v2`, `nlp`, `guardrail`, `harness`, `tts-v2`. Admin console: `pnpm --filter @arcaai/admin-console lint` (ESLint 10 flat, `--max-warnings 0`) and `check-types` (`tsc --noEmit`).

Architecture lint rules you will actually hit (defined in `packages/config-eslint/flat/core.js` + `packages/eslint-plugin-arcaai-internal/`):

- `arcaai-internal/no-controller-direct-prisma` — controllers must not touch `databaseService.client`; go through a service + repository.
- Service-layer `no-restricted-syntax` — application services must not use `databaseService.client` either; route through a domain repository.
- `arcaai-internal/no-direct-downstream-url-env` — never read `process.env.SMR_URL|STT_V2_URL|NLP_URL|GUARDRAIL_URL|HARNESS_URL` in gateway modules; inject `IConfigService.getConfigValue(...)`.
- `no-restricted-imports` — the unscoped Prisma client (`getPlatformAdminPrismaClient_Unscoped`) is banned everywhere except seeds, back-fill scripts, and test fixtures — it bypasses both tenant scoping and soft-delete filtering.

Caveat: inside `packages/*` these rules are downgraded to warnings (`eslint-plugin-only-warn` in `flat/library.js`); in `apps/api` (`flat/nestjs.js`) they are hard errors. Treat warnings in packages as errors anyway — CI lint gates run over both.

## 10. Ticket and documentation workflow

- **Numbering:** tickets are `TASK-XXX`. To assign a new number, take the highest existing ticket across `docs/implementation/` and `docs/archive/` and increment by 1.
- **Structure:** one folder per ticket — `docs/implementation/[TICKET]-[Short-Name]/README.md` — updated throughout the lifecycle. One main document per ticket; fixes append to its Change History instead of creating new files.
- **Required sections:** header (ticket, created/updated dates, status), requirement analysis, current-state evaluation, implementation plan (user-approved before coding), implementation summary, change history.
- **Status values:** `Pending | In Progress | Completed | Blocked | Review`.
- **Archive policy:** completed/historical tickets move to `docs/archive/` — an immutable record. Do not edit archived documents; references inside them may describe removed components (e.g. `knowledge/`, `apps/admin`) and are intentionally left as-is.

## 11. Deployment overview

Local development runs infrastructure in Docker Compose and application services on the host: `infrastructure/docker/docker-compose.yml` (Postgres, Redis, MinIO) plus `docker-compose.dev.yml` with profile tiers — base `vault`+`temporal`+`rag` via `pnpm infra:up` / `dev:setup` / `dev:stack`; `-o` adds `prometheus`; `-e` adds `inference` — driven by `scripts/dev-infra.sh`. Node services run via pnpm/turbo, Python services via conda `arcaenv` — nothing application-level is containerized locally.

The primary deployment target is the self-hosted k3s cluster with ArgoCD GitOps: Kustomize base + overlays under `deployment/k3s/`, ArgoCD ApplicationSet bootstrap templates under `deployment/argocd/`, namespaces `hope-v2-dev` (auto-sync from `main`) and `hope-v2-prod` (manual sync from `prod`). GitLab CI builds per-service images on change; a `db-migrate` Job runs Prisma migrations as an ArgoCD PreSync hook. PostgreSQL and MinIO are provisioned outside the cluster (external HA Postgres with Patroni/HAProxy/PgBouncer); harness + Temporal are not yet in the k3s base.

The "single-server" tree (`infrastructure/single-deployment/`) currently contains one production blueprint: the HA Vault stack — a 3-node Raft cluster with Transit auto-unseal (Helm values, bootstrap scripts, network policies, monitoring). Day-2 Vault operations are documented in [operations/vault/README.md](./operations/vault/README.md). Full deployment reference: [deployment/README.md](../deployment/README.md) and [infrastructure/README.md](../infrastructure/README.md); security posture: [infrastructure/SECURITY_DEPLOYMENT_GUIDE.md](../infrastructure/SECURITY_DEPLOYMENT_GUIDE.md).

## 12. Troubleshooting

Run `pnpm dev:doctor` first — it pinpoints most of these. Issues below are grounded in the scripts (`dev-doctor.sh`, `dev-stack.sh`, `dev-service.sh`) and `infrastructure/docker/README.md`.

| Symptom | Cause and fix |
|---|---|
| `dev:stack` refuses to start: "port already bound", or API boot fails to bind 8868/9229 | A stale `nest start --watch` (or another stack) is holding the port. `pnpm dev:stack down` stops recorded orphans; otherwise `lsof -nP -iTCP:8868 -sTCP:LISTEN` and kill the pid. |
| `Error: conda environment 'arcaenv' not found` when starting a Python service | The shared env was never created — `pnpm py:setup` (add `--apple`/`--gpu` for ML extras). |
| Doctor FAILs `docker:hope-temporal`; harness worker exits on start | Infra was started with `pnpm docker:dev:up` (core only, no Temporal/Vault profiles). Use `pnpm infra:up`, which enables both. |
| API boot: `VAULT_ROLE_ID (or VAULT_ROLE_ID_FILE) is required when SECRETS_PROVIDER=vault` | Fresh clone, or the dev Vault container was recreated (dev Vault state is in-memory — `docker compose down -v` wipes it). Run `./scripts/refresh-vault-creds.sh`, or just `pnpm dev:setup`. |
| API boot: `failed to find entry for connection with name: "hope-main"` | Vault's database engine is not wired to the dev DB — `./scripts/setup-dev-vault-db.sh` (requires migrations applied first). |
| API boot: `wrapping token is not valid` on the second start (first watch reload) | `VAULT_WRAPPED_SECRET_ID` (single-use, prod shape) is set in dev. Blank it and use the raw reusable `VAULT_SECRET_ID` — re-run `./scripts/refresh-vault-creds.sh`. |
| TypeScript cannot resolve the Prisma client / types drift after pulling schema changes | The generated client is stale — `pnpm db:generate`, then rebuild. |
| SMR is up but every generate 404s; live summary never appears | SMR has zero LLM providers registered (the doctor's "smr providers registered" check). Start it via `pnpm dev:smr-v2` (registers the LM Studio provider) and ensure LM Studio is serving on :1234 with a model loaded (`LM_STUDIO_MODEL`, default `gemma-4-e4b-it-qat`). |
| STT internal calls all return 401 | `API_GATEWAY_KEY` is missing or a placeholder. Diagnose with `./scripts/dev-service.sh --check-stt-key`; set a real key in `apps/stt-v2/.env` (the dev-seed service-account key is in `packages/database/src/prisma/db_main/seed/00-constants.ts`) or generate one with `pnpm gen:api-key`. |
| STT-v2 first start takes forever / restarts keep interrupting it | Model downloads + ~4 GB warm-up on first boot (HuggingFace; set `HUGGINGFACE_TOKEN` if rate-limited). This is why `pnpm dev:stt-v2` runs without reload — use `dev:stt-v2:watch` only when you need it (reload is scoped to the service's own src dir). |
| Ran `pnpm db:all` and lost local data | Expected — it force-resets the schema. Non-destructive path: `pnpm gen:prisma push --all && pnpm db:seed` (or `pnpm db:push` + `pnpm db:seed`). |
| `pnpm test:e2e` sporadically fails auth / returns 429 on login, worse on back-to-back runs | `/auth/login` is throttled to **5/min per source IP** (`@Throttle`, `apps/api/src/modules/auth/auth.controller.ts:138`; `/refresh` is 60/min, `/me` rides the 100/min app default). Every Playwright worker hits the one test API from the same IP and shares that counter, and the e2e test API runs the throttler with the **in-memory store** (no test Redis URL, so `throttle.module.ts` falls back), which persists across rapid successive runs against the same process. Restart the API (`pnpm test:api:up`) between fast re-runs so the window resets; run the throttle-contract spec (`apps/api/tests/e2e/auth-throttle-per-endpoint.spec.ts`) against a freshly-started API in isolation. |

## 13. Documentation map

| Document | Contents |
|---|---|
| [docs/README.md](./README.md) | Documentation index — start here |
| [docs/architecture/overview.md](./architecture/overview.md) | System context, service topology + ports, data flows, deployment topologies |
| [docs/architecture/data-and-domain-model.md](./architecture/data-and-domain-model.md) | Prisma domain model, tenancy, soft-delete, audit, PHI encryption, what lives where |
| [docs/development-patterns-and-standards.md](./development-patterns-and-standards.md) | Layer-by-layer coding patterns with exemplar file paths; the 20 most important do/don'ts |
| [docs/traceability-matrix.md](./traceability-matrix.md) | Capability → service → models → routes → tests mapping |
| [scripts/README.md](../scripts/README.md) | Every operational script: dev, test, Vault, CI, diagnostics |
| [tests/README.md](../tests/README.md) | Shared test tree, isolated test infra, how each suite runs, where tests belong |
| [infrastructure/README.md](../infrastructure/README.md) | Infrastructure map: compose stacks, Grafana dashboards, production blueprints |
| [infrastructure/docker/README.md](../infrastructure/docker/README.md) | Local Docker guide: Vault dev bootstrap, observability opt-in, boot troubleshooting |
| [deployment/README.md](../deployment/README.md) | k3s + ArgoCD GitOps deployment, environments, CI/CD, cluster operations |
| [docs/operations/vault/README.md](./operations/vault/README.md) | HA Vault operator runbook (rotation, failover, recovery) |
| [docs/research/README.md](./research/README.md) | Research index: homelab infra, deployments, security audits, prior art |
| [infrastructure/SECURITY_DEPLOYMENT_GUIDE.md](../infrastructure/SECURITY_DEPLOYMENT_GUIDE.md) | Encryption index: at-rest, in-transit, backups, key management |
| `apps/*/README.md`, `packages/*/README.md` | Per-app / per-package documentation |
