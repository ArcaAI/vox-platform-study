# Shared Test Tree

Introduced: 2026-07-04 · Last verified: 2026-07-21

This directory holds the monorepo-level test assets: shared helpers, fixtures, global setup, contract schemas, the cross-tenant fixture, SDK E2E specs, and the isolated Docker test infrastructure. Unit tests do NOT live here — they live next to the code they test (see "Where tests belong" below).

## Prerequisites

- `.env.test` at the repo root (all test commands load it via `dotenv -e .env.test`)
- Docker running, for anything beyond pure unit tests
- Test infrastructure up: `pnpm setup:test` (one command) or `pnpm infra:test:up` + `pnpm test:db:push` + `pnpm test:db:seed`

## Directory map

| Path                      | Contents                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contracts/`              | Zod schemas (`schemas.ts`) defining the API Gateway <-> Python service request/response contracts, plus Vitest suites validating representative payloads for STT and SMR. Also exports the schemas for reuse. (The former `tts.contract.test.ts` and its schemas were removed in TASK-414 along with the retired TTS service.) |
| `cross-tenant/`           | `createCrossTenantFixture()` — deterministic two-tenant / three-user synthetic fixture (tenant A/B, non-elevated users, one global admin, CLS-context shaper) used by tenant-isolation tests anywhere in the monorepo, plus its pinning test.                                                                                  |
| `e2e/sdk/`                | Playwright specs for the `@arcaai/vox` SDK consultation API, with a dedicated `playwright.config.ts`. Not wired to a root pnpm alias — run manually (see below).                                                                                                                                                               |
| `fixtures/`               | Database fixture builders (users, roles/policies, tenants) with deterministic test IDs, used by integration and E2E suites.                                                                                                                                                                                                    |
| `helpers/`                | Shared helpers: `auth.helper` (JWT/test users), `db.helper` (Prisma client, reset/seed/migrate, service startup + health waits), `api.helper` (typed HTTP client + assertion helpers), `e2e.helper` (seeded users/API keys, login, test-data registry + cleanup).                                                              |
| `setup/`                  | Global setup files referenced by root configs: `vitest.setup.ts` (unit), `integration.setup.ts` (DB connect + per-test reset; refuses to run unless `DATABASE_URL` contains "test"), `playwright.global-setup.ts` / `playwright.global-teardown.ts` (E2E).                                                                     |
| `docker-compose.test.yml` | Isolated test infrastructure (see next section).                                                                                                                                                                                                                                                                               |

## Test infrastructure (`docker-compose.test.yml`)

Compose project `hope-test` provides throwaway containers, isolated from dev by different ports and tmpfs-backed storage (no volumes persist; `--stop` also removes volumes):

| Service    | Container            | Test port (dev port)                | Notes                                                                                                                                                                   |
| ---------- | -------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | `hope-postgres-test` | 5433 (5432)                         | `timescale/timescaledb-ha:pg18-all` — same image as dev so pgvector/vectorscale extensions exist; durability off for speed; DB `hope_test`, user/password `test`/`test` |
| Redis      | `hope-redis-test`    | 6380 (6379)                         | password `test_redis_pass`, no persistence                                                                                                                              |
| MinIO      | `hope-minio-test`    | 9002 API / 9003 console (9000/9001) | `minio-createbuckets` init container creates the standard buckets                                                                                                       |
| Qdrant     | `hope-qdrant-test`   | 6335 HTTP / 6336 gRPC (6333/6334)   | `qdrant-init-test` init container creates collections via `infrastructure/docker/scripts/init-qdrant-collections.py`                                                    |

Managed by `scripts/start-test-infra.sh`:

```bash
pnpm infra:test:up        # start + wait + validate
pnpm infra:test:validate  # re-run health validation
pnpm infra:test:logs      # follow logs
pnpm infra:test:down      # stop and REMOVE volumes
```

The init containers (`minio-createbuckets`, `qdrant-init-test`) exit 0 after doing their work — compose may report them as "exited", which is expected.

## How each suite runs

All root aliases load `.env.test` via dotenv-cli. Verified against root `package.json`, `vitest.config.ts`, `vitest.integration.config.ts`, and `playwright.config.ts`.

| Suite        | Command                                                                                    | Config                               | What it picks up                                                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit         | `pnpm test:unit` (watch: `test:unit:watch`, UI: `test:unit:ui`, coverage: `test:coverage`) | `vitest.config.ts`                   | All `**/*.test.ts` / `**/*.spec.ts` across packages and apps, excluding `integration/`, `e2e/`, `apps/ui-playground/`, the PgBouncer rig, and `*.postgres.test.ts`. Browser-focused packages run under jsdom. No infra needed. Setup: `tests/setup/vitest.setup.ts`.         |
| Integration  | `pnpm test:integration`                                                                    | `vitest.integration.config.ts`       | `**/integration/**/*.test.ts`, sequential (single fork), against the live test DB. Requires test infra up. Setup: `tests/setup/integration.setup.ts` (resets DB before each test).                                                                                           |
| API E2E      | `pnpm test:e2e` (UI: `test:e2e:ui`, debug: `test:e2e:debug`)                               | `playwright.config.ts`               | `apps/api/tests/e2e/**/*.spec.ts` against a RUNNING test API (`API_URL`, default `http://localhost:8968/api/v1`). Start it first: `pnpm test:up:api`. Global setup/teardown from `tests/setup/`. `pnpm test:e2e:all` runs the turbo `test:e2e` task across packages instead. |
| Contract     | part of `pnpm test:unit`                                                                   | `vitest.config.ts`                   | `tests/contracts/*.contract.test.ts` — pure schema validation, no services needed.                                                                                                                                                                                           |
| Cross-tenant | part of `pnpm test:unit`                                                                   | `vitest.config.ts`                   | `tests/cross-tenant/example.test.ts` pins the fixture shape; downstream tenant-isolation tests import `tests/cross-tenant/fixtures.ts` from their own packages.                                                                                                              |
| SDK E2E      | `npx playwright test -c tests/e2e/sdk/playwright.config.ts`                                | `tests/e2e/sdk/playwright.config.ts` | `tests/e2e/sdk/*.e2e.spec.ts` against a running API (`API_URL`, default `http://localhost:8968`). No root pnpm alias.                                                                                                                                                        |
| All          | `pnpm test:all` / `pnpm test:all`                                                          | —                                    | unit, then integration, then E2E.                                                                                                                                                                                                                                            |

Database helpers for the test DB: `pnpm test:db:push` (force-push schema), `pnpm test:db:seed` (seed + media seed), `pnpm test:db:reset` (both).

Typical full sequence from a fresh checkout:

```bash
pnpm setup:test      # infra + schema + seed
pnpm test:unit
pnpm test:integration
pnpm test:up:api     # terminal 1 — test API on 8968
pnpm test:e2e        # terminal 2
```

## Where tests belong

| Kind                                | Location                                                                | Runner                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Unit (TypeScript)                   | inside the package/app, `src/**/__tests__/` or `*.test.ts` next to code | Vitest, `pnpm test:unit`                                                         |
| Integration (TypeScript)            | inside the package/app under an `integration/` directory                | Vitest, `pnpm test:integration`                                                  |
| API E2E                             | `apps/api/tests/e2e/`                                                   | Playwright, `pnpm test:e2e`                                                      |
| SDK E2E                             | `tests/e2e/sdk/`                                                        | Playwright (manual config, see above)                                            |
| Contract                            | `tests/contracts/`                                                      | Vitest (runs with unit)                                                          |
| Cross-tenant fixture + pinning test | `tests/cross-tenant/`                                                   | Vitest (runs with unit); import the fixture from any package via a relative path |
| Python                              | `apps/<service>/tests/` or `apps/<service>/src/<pkg>/tests/`            | pytest via `pnpm py:<service>:test`                                              |

Rule of thumb: this folder is the shared / cross-service level. If a test only exercises one package, it lives in that package.
