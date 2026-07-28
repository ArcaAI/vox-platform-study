# HOPE — QA / QC / Test Operations

Authoritative operations home for **all test activity** in the HOPE monorepo: environment
preparation, execution runbooks, the formal quality plan, and the CI gate traceability.

Last verified: 2026-07-28 against root `package.json`, `vitest.config.ts`,
`vitest.integration.config.ts`, `playwright.config.ts`, `tests/docker-compose.test.yml`,
and `.gitlab/ci/*.yml`.

> This folder is the **operations** view (how to run and govern testing). The **structural**
> reference — where each kind of test lives and why — is [`tests/README.md`](../../../tests/README.md).
> The **authoring** rules (TDD, test placement, layer gates) are in
> [`.claude/rules/01-development-workflow.md`](../../../.claude/rules/01-development-workflow.md).
> When these disagree, the code and configs win — fix the doc.

## Documents in this set

| Document | Purpose | Primary audience |
|---|---|---|
| [`environment-setup.md`](environment-setup.md) | Prepare every test environment: toolchain, `.env.test`, isolated Docker test infra, conda `arcaenv`, DB push/seed | Any engineer, CI maintainers |
| [`test-execution.md`](test-execution.md) | Runbook — exact commands to run each suite (TS unit/integration/E2E, Python, coverage), including the "managed" one-command runners | Any engineer |
| [`test-strategy.md`](test-strategy.md) | Formal QA/QC plan: scope, test levels, entry/exit criteria, coverage policy, roles, defect handling, release readiness | Leads, QA, auditors |
| [`ci-gates.md`](ci-gates.md) | CI pipeline traceability — every validate/test gate, what it runs, and what it blocks | CI maintainers, release managers |

## 60-second orientation

- **Package manager / task runner**: pnpm 10.31 workspaces + Turborepo. Root `pnpm test`
  runs `turbo run test` across all packages; each package's `test` script is what turbo invokes.
- **TypeScript tests**: Vitest 4. Unit (colocated `*.test.ts` / `__tests__/`), integration
  (`integration/**`, live test DB), API E2E (Playwright, `apps/api/tests/e2e/*.spec.ts`).
- **Python tests**: pytest, run through the shared conda env `arcaenv` via `pnpm <svc>:test`.
- **Test isolation**: a dedicated Docker stack (`hope-test` compose project) on **non-dev ports**
  (Postgres 5433, Redis 6380, MinIO 9002/9003, Qdrant 6335/6336) with tmpfs storage — nothing persists.
- **Test env file**: `.env.test` at the repo root; every TS test alias loads it via `dotenv -e .env.test`.
- **Test API port**: the E2E gateway runs on **8968** (dev is 8868), `API_URL` default
  `http://localhost:8968/api/v1`.

## The fast path (fresh checkout → green suite)

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

Prefer the **managed** runners when you don't want to manage infra by hand — they bring infra
up, push/seed the schema, start the services a suite needs, run it, print the result, and tear
down only what they started:

```bash
pnpm test:unit:managed
pnpm test:integration:managed
pnpm test:e2e:managed
pnpm test:py:managed
pnpm stack:test:doctor       # read-only health probe of the test stack
```

## Definition of done for any change (quality gate)

Mirrors [`.claude/rules/01-development-workflow.md`](../../../.claude/rules/01-development-workflow.md):

- [ ] New/changed tests pass — evidence pasted (actual runner output, not a claim)
- [ ] Affected packages build
- [ ] No new lint errors (in `packages/*`, `eslint-plugin-only-warn` surfaces them as warnings — treat as errors)
- [ ] `pnpm verify` green for the touched surface (`lint:all` + `typecheck:all` + `test`)
- [ ] Ticket README updated with an Implementation Summary + evidence
