# Testing — QA/QC operations home

Authoritative operations home for all test activity in the HOPE monorepo: environment
preparation, execution runbooks, the formal quality plan, and CI gate traceability. This folder is
the operations view (how to run and govern testing). The structural reference — where each kind of
test lives and why — is [`tests/README.md`](../../../tests/README.md). The authoring rules (TDD,
test placement, layer gates) are in
[`.claude/rules/01-development-workflow.md`](../../../.claude/rules/01-development-workflow.md).
When these disagree, the code and configs win — fix the doc.

Last verified: 2026-09-15 against root `package.json`, `tests/docker-compose.test.yml`, and
`scripts/start-test-app.sh`.

## Layout

| Document | Purpose | Primary audience |
|---|---|---|
| [`environment-setup.md`](environment-setup.md) | Prepare every test environment: toolchain, `.env.test`, isolated Docker test infra, conda `arcaenv`, DB push/seed | Any engineer, CI maintainers |
| [`test-execution.md`](test-execution.md) | Runbook — exact commands to run each suite (TS unit/integration/E2E, Python, coverage), including the "managed" one-command runners | Any engineer |
| [`test-strategy.md`](test-strategy.md) | Formal QA/QC plan: scope, test levels, entry/exit criteria, coverage policy, roles, defect handling, release readiness | Leads, QA, auditors |
| [`ci-gates.md`](ci-gates.md) | CI pipeline traceability — every validate/test gate, what it runs, and what it blocks | CI maintainers, release managers |

## Commands

### The fast path (fresh checkout to green suite)

```bash
pnpm install                 # workspace deps
pnpm setup:python            # conda arcaenv (add --apple / --gpu / --cpu as needed)
pnpm setup:test              # test infra up + schema push + seed
pnpm test:unit               # TypeScript unit + contract + cross-tenant
pnpm test:integration        # TypeScript integration (needs infra)
pnpm test:up:api             # terminal 1 — test API on :8968
pnpm test:e2e                # terminal 2 — Playwright API E2E
pnpm test:py                 # all Python service suites
```

Prefer the managed runners when you don't want to manage infra by hand — they bring infra up,
push/seed the schema, start the services a suite needs, run it, print the result, and tear down
only what they started:

```bash
pnpm test:unit:managed
pnpm test:integration:managed
pnpm test:e2e:managed
pnpm test:py:managed
pnpm stack:test:doctor       # read-only health probe of the test stack
```

## How it works

- **Package manager / task runner**: pnpm 10.31 workspaces + Turborepo. Root `pnpm test` runs
  `turbo run test` across all packages except `@arcaai/compat-playground`; each package's `test`
  script is what turbo invokes.
- **TypeScript tests**: Vitest 4. Unit (colocated `*.test.ts` / `__tests__/`), integration
  (`integration/**`, live test DB), API E2E (Playwright, `apps/api/tests/e2e/*.spec.ts`).
- **Python tests**: pytest, run through the shared conda env `arcaenv` via `pnpm <svc>:test`.
- **Test isolation**: a dedicated Docker stack (`hope-test` compose project,
  `tests/docker-compose.test.yml`) on non-dev ports — Postgres `5433`, Redis `6380`, MinIO
  `9002`/`9003` (API/console), Qdrant `6335`/`6336` (gRPC/HTTP) — with tmpfs storage, so nothing
  persists.
- **Test env file**: `.env.test` at the repo root; every TS test alias loads it via
  `dotenv -e .env.test`.
- **Test application ports are DEV port + 100** (`scripts/start-test-app.sh`): the API gateway
  runs on `8968` (dev `8868`), and each Python service follows the same offset (e.g. STT `8961`,
  Text `8962`) — a dev stack can keep running alongside a test stack because the two never share a
  port.
- `start-test-app.sh api --isolated` starts a SECOND gateway on `ISOLATED_API_PORT` with
  throttling on and `TEXT_URL` pointed at the e2e stub — a boot-time-only settings pair
  (`RATE_LIMIT_ENABLED`, `TEXT_URL`) that the shared test gateway cannot flip per-spec, needed by
  exactly two e2e specs (`auth-throttle-per-endpoint`, `byo-llm-credentials`).

## Gotchas

- **The Playwright `globalSetup` does a DESTRUCTIVE DB reset.** Set `RESET_DB=false` when the test
  infra is already seeded — teardown then leaves the containers up instead of tearing them down
  too (`.claude/rules/01-development-workflow.md`).
- **`pnpm test:e2e -- <filter>` does not filter** — the `--` is swallowed. Use
  `npx dotenv -e .env.test -- npx playwright test <filter>` instead.
- **`pnpm infra:test:down` removes volumes** — the test stack is throwaway by design; do not
  expect data to survive a `down` the way it might on the dev stack.

### Definition of done for any change (quality gate)
Mirrors [`.claude/rules/01-development-workflow.md`](../../../.claude/rules/01-development-workflow.md):

- [ ] New/changed tests pass — evidence pasted (actual runner output, not a claim)
- [ ] Affected packages build
- [ ] No new lint errors (in `packages/*`, `eslint-plugin-only-warn` surfaces them as warnings — treat as errors)
- [ ] `pnpm verify` green for the touched surface (`lint:all` + `typecheck:all` + `test`)
- [ ] Ticket README updated with an Implementation Summary + evidence

## Related

- [`../../../tests/README.md`](../../../tests/README.md) — structural reference for test placement
- [`../../../.claude/rules/01-development-workflow.md`](../../../.claude/rules/01-development-workflow.md) — TDD, layer gates, the e2e gotchas above
- [`../../../.claude/rules/05-nestjs-api.md`](../../../.claude/rules/05-nestjs-api.md) — the API test standard (credential classes, route-authz matrix)
