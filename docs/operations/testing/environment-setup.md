# Test Environment Preparation

How to bring up every environment test activity depends on. Do this once per machine (toolchain),
then per session as needed (infra + schema). Verified 2026-07-28.

## 1. Toolchain prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 22 | `.nvmrc` / repo standard |
| pnpm | 10.31 | via corepack; workspace + turbo |
| Docker | current | required for anything beyond pure TS unit tests |
| conda | current | provides the shared Python env `arcaenv` (Python 3.11) |
| Playwright browsers | — | `pnpm exec playwright install chromium` before first E2E run |

```bash
pnpm install                 # install all workspace dependencies
pnpm exec playwright install chromium   # once, for E2E
```

## 2. The test env file — `.env.test`

- Location: repo root. Selected by `NODE_ENV`; **every** TypeScript test alias loads it explicitly
  via `dotenv -e .env.test` (see the `test:*` scripts in root `package.json`).
- Contract (TASK-558): precedence is **host env > env file > schema default**; in CI (`CI=true`)
  no file is read — host env only. Python reads the same file through `packages/py-env` (`hope_env`).
- It points at the **isolated test infra** (Postgres 5433, Redis 6380, etc.), not dev.
- The integration setup (`tests/setup/integration.setup.ts`) **refuses to run unless `DATABASE_URL`
  contains "test"** — a guardrail against wiping a real database.

> `.env.test` is committed with placeholders only where secrets would appear; real local values are
> gitignored. If a test alias errors on a missing var, add it to `.env.test` and to
> `turbo.json#globalEnv` (new runtime vars must be declared there).

## 3. Isolated Docker test infrastructure

Compose project **`hope-test`** (`tests/docker-compose.test.yml`) — throwaway containers on
non-dev ports with tmpfs-backed storage. Nothing persists; `--stop`/`down` also removes volumes.

| Service | Container | Test port (dev port) | Notes |
|---|---|---|---|
| PostgreSQL | `hope-postgres-test` | **5433** (5432) | `timescale/timescaledb-ha:pg18-all` (pgvector/vectorscale present); durability off for speed; DB `hope_test`, user/pass `test`/`test` |
| Redis | `hope-redis-test` | **6380** (6379) | password `test_redis_pass`, no persistence |
| MinIO | `hope-minio-test` | **9002** API / **9003** console (9000/9001) | `minio-createbuckets` init container creates standard buckets |
| Qdrant | `hope-qdrant-test` | **6335** HTTP / **6336** gRPC (6333/6334) | `qdrant-init-test` init container creates collections |

The two init containers (`minio-createbuckets`, `qdrant-init-test`) **exit 0 after doing their
work** — compose reporting them as "exited" is expected, not a failure.

Managed by `scripts/start-test-infra.sh`:

```bash
pnpm infra:test:up         # start + wait + validate
pnpm infra:test:validate   # re-run health validation only
pnpm infra:test:status     # container status
pnpm infra:test:logs       # follow logs
pnpm infra:test:restart    # restart
pnpm infra:test:down       # stop AND remove volumes (throwaway)
```

## 4. Schema + seed for the test database

The test DB is **schema-pushed**, not migrated (fast, throwaway). After infra is up:

```bash
pnpm test:db:push          # dotenv -e .env.test -- db push --force
pnpm test:db:seed          # seed data + media seed
pnpm test:db:reset         # push + seed in one step
```

- `test:db:seed` runs the database seed **and** `packages/applications/scripts/media-seed.ts`
  (MinIO media fixtures).
- Reserved seed UUID prefixes: `00000000-…` SYSTEM tenant, `50000000-…` default tenant,
  `60000000-…` system user, `70000000-…` API keys.

## 5. One-command bootstrap

```bash
pnpm setup:test            # scripts/test-setup.sh: infra up + schema push + seed, idempotent
```

Equivalent to `infra:test:up` + `test:db:push` + `test:db:seed`.

## 6. Python environment (`arcaenv`)

Local Python tests run in the single shared conda env `arcaenv` (Python 3.11). Every `pnpm <svc>:test`
alias wraps `conda run -n arcaenv --no-capture-output pytest …`.

```bash
pnpm setup:python          # create/update arcaenv (setuptools + uv-resolved deps)
pnpm setup:python:apple    # + Apple-silicon ML extras
pnpm setup:python:gpu      # + CUDA/GPU extras
pnpm setup:python:cpu      # CPU-only extras
pnpm setup:python:check    # verify the env is correctly provisioned
pnpm setup:python:rebuild  # recreate from scratch
```

Dependency **resolution** is owned by the root `uv` workspace (one `uv.lock`). If you change a
service's `pyproject.toml`, run `uv lock` at the repo root, then `pnpm setup:python`.

Python services do **not** need the Docker test infra for their unit suites (they stub external
deps); integration/e2e Python suites that need infra are gated behind the `integration/` and `e2e/`
subdirectories (see [`test-execution.md`](test-execution.md)).

## 7. Environment matrix (which env each suite needs)

| Suite | `.env.test` | Docker test infra | Test DB seeded | Running app service | conda `arcaenv` |
|---|:--:|:--:|:--:|:--:|:--:|
| TS unit / contract / cross-tenant | ✅ | — | — | — | — |
| TS integration | ✅ | ✅ | ✅ | — | — |
| API E2E (Playwright) | ✅ | ✅ | ✅ | ✅ `test:up:api` (:8968) | — |
| SDK E2E (Playwright) | ✅ | ✅ | ✅ | ✅ running API | — |
| Python unit (`<svc>:test`) | ✅ | — | — | — | ✅ |
| Python integration/e2e | ✅ | ✅ | ✅ (if DB-touching) | depends on suite | ✅ |
| UI component tests (Playwright CT) | — | — | — | — | — |

## 8. Teardown

```bash
pnpm infra:test:down       # remove test containers + volumes
pnpm stack:test:down       # tear down the managed test stack (scripts/test-stack.sh)
```

The **managed** runners (`*:managed`) tear down automatically, leaving pre-existing infra untouched.
