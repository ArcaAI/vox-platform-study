# Shared Test Tree — cross-service test assets and isolated infra for HOPE

This directory holds the monorepo-level test assets: shared helpers, fixtures, global setup,
contract schemas, the cross-tenant fixture, SDK E2E specs, and the isolated Docker test
infrastructure. Unit tests do NOT live here — they live next to the code they test (see "How it
works" below).

## Layout

| Path | Contents |
|---|---|
| `contracts/` | Zod schemas (`schemas.ts`) defining the API Gateway <-> Python service request/response contracts, plus Vitest suites validating representative payloads for STT and TEXT |
| `cross-tenant/` | `createCrossTenantFixture()` — deterministic two-tenant / three-user synthetic fixture (tenant A/B, non-elevated users, one super admin, CLS-context shaper) used by tenant-isolation tests anywhere in the monorepo, plus its pinning test |
| `e2e/sdk/` | Playwright specs for the `@arcaai/vox` SDK consultation API, with a dedicated `playwright.config.ts`. Not wired to a root pnpm alias — run manually (see Commands) |
| `fixtures/` | Database fixture builders (users, roles/policies, tenants) with deterministic test IDs, used by integration and E2E suites |
| `helpers/` | Shared helpers: `auth.helper` (JWT/test users), `db.helper` (Prisma client, reset/seed/migrate, service startup + health waits), `api.helper` (typed HTTP client + assertion helpers), `e2e.helper` (seeded users/API keys, login, test-data registry + cleanup) |
| `setup/` | Global setup files referenced by root configs: `vitest.setup.ts` (unit), `integration.setup.ts` (DB connect + per-test reset; refuses to run unless `DATABASE_URL` contains "test"), `playwright.global-setup.ts` / `playwright.global-teardown.ts` (E2E) |
| `docker-compose.test.yml` | Isolated test infrastructure (see How it works) |

## Commands

Typical full sequence from a fresh checkout:

```bash
pnpm setup:test      # infra + schema + seed
pnpm test:unit
pnpm test:integration
pnpm test:up:api     # terminal 1 -- test API on 8968
pnpm test:e2e        # terminal 2
```

| Command | What it runs |
|---|---|
| `pnpm test:unit` (watch: `test:unit:watch`, UI: `test:unit:ui`, coverage: `test:unit:cov`) | `vitest.config.ts` — all `**/*.test.ts` / `**/*.spec.ts` across packages and apps, excluding `integration/`, `e2e/`, the PgBouncer validation rig (`pnpm pgbv:test` runs it separately), `*.postgres.test.ts`, and (by owner directive) `packages/ui` — run it only via its own `pnpm --filter <pkg> test` when the change is inside it. No infra needed |
| `pnpm test:integration` | `vitest.integration.config.ts` — `**/integration/**/*.test.ts`, sequential (single fork), against the live test DB. Requires test infra up |
| `pnpm test:e2e` (UI: `test:e2e:ui`, debug: `test:e2e:debug`) | `playwright.config.ts` — `apps/api/tests/e2e/**/*.spec.ts` against a RUNNING test API (`API_URL`, default `http://localhost:8968/api/v1`). Start it first: `pnpm test:up:api`. `pnpm test:e2e:all` runs the turbo `test:e2e` task across packages instead |
| `npx playwright test -c tests/e2e/sdk/playwright.config.ts` | `tests/e2e/sdk/*.e2e.spec.ts` against a running API (`API_URL`, default `http://localhost:8968`). No root pnpm alias |
| `pnpm test:all` | unit, then integration, then E2E |
| `pnpm infra:test:up` / `infra:test:validate` / `infra:test:logs` / `infra:test:down` | start + wait + validate / re-run health validation / follow logs / stop and REMOVE volumes |
| `pnpm test:db:push` / `test:db:seed` / `test:db:reset` | force-push schema to the test DB / seed + media seed / both |

## How it works

### Test infrastructure (`docker-compose.test.yml`)

Compose project `hope-test` provides throwaway containers, isolated from dev by different ports
and tmpfs-backed storage (no volumes persist; `--stop` also removes volumes), managed by
`scripts/start-test-infra.sh`:

| Service | Container | Test port (dev port) | Notes |
|---|---|---|---|
| PostgreSQL | `hope-postgres-test` | 5433 (5432) | `timescale/timescaledb-ha:pg18-all` — same image as dev; durability off for speed; DB `hope_test`, user/password `test`/`test` |
| Redis | `hope-redis-test` | 6380 (6379) | password `test_redis_pass`, no persistence |
| MinIO | `hope-minio-test` | 9002 API / 9003 console (9000/9001) | `minio-createbuckets` init container creates the standard buckets |
| Qdrant | `hope-qdrant-test` | 6335 HTTP / 6336 gRPC (6333/6334) | `qdrant-init-test` init container creates collections via `infrastructure/docker/scripts/init-qdrant-collections.py` |
| Vault | `hope-vault-test` | 8201 (8200) | Dev-mode, in-memory, isolated from dev's `hope-vault`. `vault-init-test` init container provisions kv-v2 + transit (`hope-globalsetting`, `hope-phi`) + the `hope-app` AppRole |

The init containers (`minio-createbuckets`, `qdrant-init-test`, `vault-init-test`) exit 0 after
doing their work — compose may report them as "exited", which is expected.

### Where tests belong

| Kind | Location | Runner |
|---|---|---|
| Unit (TypeScript) | inside the package/app, `src/**/__tests__/` or `*.test.ts` next to code | Vitest, `pnpm test:unit` |
| Integration (TypeScript) | inside the package/app under an `integration/` directory | Vitest, `pnpm test:integration` |
| API E2E | `apps/api/tests/e2e/` | Playwright, `pnpm test:e2e` |
| SDK E2E | `tests/e2e/sdk/` | Playwright (manual config, see Commands) |
| Contract | `tests/contracts/` | Vitest (runs with unit) |
| Cross-tenant fixture + pinning test | `tests/cross-tenant/` | Vitest (runs with unit); import the fixture from any package via a relative path |
| Python | `apps/<service>/tests/` or `apps/<service>/src/<pkg>/tests/` | pytest via `pnpm <service>:test` |

Rule of thumb: this folder is the shared / cross-service level. If a test only exercises one
package, it lives in that package.

### Prerequisites

- `.env.test` at the repo root (all test commands load it via `dotenv -e .env.test`)
- Docker running, for anything beyond pure unit tests
- Test infrastructure up: `pnpm setup:test` (one command), or `pnpm infra:test:up` +
  `pnpm test:db:push` + `pnpm test:db:seed`

## Gotchas

- **`pnpm infra:test:down` removes volumes** — the test stack is throwaway by design; do not run
  it against data you meant to keep.
- **`pnpm test:e2e -- <filter>` does NOT filter the Playwright run** (the `--` is swallowed) — use
  `npx dotenv -e .env.test -- npx playwright test <filter>` instead.
- The Playwright `globalSetup` (`tests/setup/playwright.global-setup.ts`) performs a **destructive
  DB reset** on every run. Set `RESET_DB=false` when the infra is already up and seeded — this
  also makes the teardown leave the containers running.
- `tests/setup/integration.setup.ts` refuses to run unless `DATABASE_URL` contains `"test"` — a
  guard against accidentally resetting the dev database from the integration suite.

## Related

- [../scripts/README.md](../scripts/README.md) — the scripts behind every command above
- [../.claude/rules/01-development-workflow.md](../.claude/rules/01-development-workflow.md) — test placement rules and layer gates
- [../.claude/rules/02-database-prisma.md](../.claude/rules/02-database-prisma.md) — why DB resets must be serialized
