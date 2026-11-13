# Running `project-hope/apps/api` tests (terminal guide)

This guide covers how to run tests for the API Gateway package (`@arcaai/api`, `apps/api`) in `project-hope`, and how to interpret the output.

## Prerequisites

- Monorepo: `/Users/apple/repos/VOX/project-hope`
- Install dependencies (if needed):

```bash
cd /Users/apple/repos/VOX/project-hope
pnpm install
```

- `apps/api` uses **Vitest** (`apps/api/vitest.config.ts`).
- If workspace packages are not built and you hit module/build issues, build first:

```bash
cd /Users/apple/repos/VOX/project-hope
pnpm api:build
# or
pnpm --filter @arcaai/api... build
```

- Many API tests mock dependencies and do not require external services. Some local env/config may still be needed (e.g. `.env.dev` for Prisma/build/tooling flows).

## Commands

### Run all API tests (once)

**From monorepo root (recommended):**
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm api:test
```

**From `apps/api`:**
```bash
cd /Users/apple/repos/VOX/project-hope/apps/api
pnpm test
# equivalent
pnpm vitest run
```

**From root, targeting the package directly:**
```bash
cd /Users/apple/repos/VOX/project-hope
pnpm --filter @arcaai/api test
```

### Watch mode (rerun on file changes)

```bash
# root
cd /Users/apple/repos/VOX/project-hope
pnpm api:test:watch

# apps/api
cd /Users/apple/repos/VOX/project-hope/apps/api
pnpm test:watch
# equivalent
pnpm vitest
```

### Coverage

```bash
# root
cd /Users/apple/repos/VOX/project-hope
pnpm api:test:cov

# apps/api
cd /Users/apple/repos/VOX/project-hope/apps/api
pnpm test:cov
# equivalent
pnpm vitest run --coverage
```

### Run a specific file or subset

From `apps/api` (usually easiest for path matching):

```bash
cd /Users/apple/repos/VOX/project-hope/apps/api

# specific test file
pnpm vitest run src/modules/consultation/__tests__/consultation.controller.test.ts

# by folder or pattern
pnpm vitest run src/modules/consultation
pnpm vitest run "consultation.controller"
```

From monorepo root with filter:

```bash
cd /Users/apple/repos/VOX/project-hope
pnpm --filter @arcaai/api test -- src/modules/consultation/__tests__/consultation.controller.test.ts
```

> If argument forwarding behaves differently in your shell/workspace setup, prefer running from `apps/api`.

### Run a specific test case by name

Use `-t` / `--testNamePattern`:

```bash
cd /Users/apple/repos/VOX/project-hope/apps/api

pnpm vitest run -t "starts consultation"
pnpm vitest run src/modules/consultation/__tests__/consultation.controller.test.ts -t "start"
```

### Useful debugging flags

```bash
cd /Users/apple/repos/VOX/project-hope/apps/api

# verbose per-test output
pnpm vitest run --reporter=verbose

# stop on first failure
pnpm vitest run --bail 1

# in watch mode, focus on changed files
pnpm vitest --changed
```

### E2E tests (separate from Vitest)

`apps/api` also defines:

```bash
cd /Users/apple/repos/VOX/project-hope/apps/api
pnpm test:e2e
```

This uses Playwright (root config) and is a different test flow from Vitest unit/integration tests.

## How to interpret Vitest output

### Per-file / per-test status

- `✓` — test passed
- `×` / `✗` — test failed
- `↓` or `skipped` — test skipped (`it.skip`, `describe.skip`, etc.)
- `todo` — placeholder test (`it.todo`)

Vitest prints file-level results and, depending on reporter/mode, individual test names.

### Failure details (most important)

For each failure, read in this order:

1. **File path and line number** — where the assertion/error occurred
2. **Test name** — `describe` / `it` path describing expected behavior
3. **Assertion diff** — `Expected` vs `Received` (for matcher failures)
4. **Error message and stack trace** — points to failing test code and/or implementation

Tips:
- If failures originate in hooks (`beforeAll`, `beforeEach`, `afterEach`), fix setup/mocking/env issues first.
- A single root-cause issue (mock/config change) can cascade into many failures.

### Final summary

At the end of a run, Vitest prints totals similar to:

```text
Test Files  2 failed | 48 passed (50)
Tests       5 failed | 420 passed | 3 skipped (428)
Duration    85.12s
```

- **Test Files** — number of test files that passed/failed
- **Tests** — individual test cases across all files
- **Duration** — total runtime

A run is successful when failed counts are `0`.

### Exit code

- **`0`** — tests completed successfully (no failures)
- **non-zero** — failures, config/runtime errors, or interrupted run

This is what CI and shell chaining (`&&`) rely on.

### Coverage report (when enabled)

`--coverage` / `pnpm test:cov` / `pnpm api:test:cov` prints a coverage table (and may generate report artifacts depending on config), typically including:

- **% Stmts / % Branch / % Funcs / % Lines** (overall and per file)
- uncovered line/branch locations (depending on reporter)

Interpretation:
- Prioritize coverage of changed and critical logic paths.
- Branch coverage is often the best signal for missing conditional-path tests.

### Logs and warnings during tests

Vitest/Nest test runs may emit `LOG`, `WARN`, `ERROR`, or stack-like messages as part of tests that intentionally exercise error/failure paths (especially with mocked dependencies or unavailable external services).

- Do **not** treat log lines alone as test failures.
- Use the **final Vitest summary** (`Test Files` / `Tests`) and explicit `×` failure blocks to determine pass/fail.

## Notes

- Root scripts like `pnpm api:test` use Turbo and may follow monorepo task behavior; package-local `pnpm test` in `apps/api` runs Vitest directly.
- If you see script-name errors such as `None of the selected packages has a "api:..." script` when using `--filter @arcaai/api`, check whether you meant the **package** script name (`test`, `route-manifest`, `openapi`) or the **root** convenience script (`api:test`, `api:route-manifest`, `api:openapi`).
