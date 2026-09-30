# TASK-1026: Logging unit suites fail under `pnpm test:unit` (ambient `.env.test` logging config)

**Status:** Review
**Type:** bugfix (tests only — no production code changed)
**Branch:** `agent/jovial-sinoussi-9321d5` (worktree `sharp-hopper-96900a`), based on `dev-2.2` @ `ad3ffdaea`; target `dev-2.2`

## Requirement Analysis

`pnpm test:unit` reported 46 failures, all in
`packages/applications/src/services/baseServices/logging/__tests__/`
(`logging.service` ×27, `logging.correlation` ×9, `loki-line-contract` ×6,
`logging.level-and-lifecycle` ×2, `redactor` ×2). The failures showed an empty transport capture
(`expected [] to have a length of 1`, `Cannot read properties of undefined (reading 'context')`).
The same files passed when run alone (`npx vitest run <logging dir>`, 405/405) and under
`pnpm --filter @arcaai/applications test`. They reproduce on `3e918afc8`, so they are older than
TASK-1024/1025. Goal: find the cause, fix it where it starts, and show the full `pnpm test:unit`
run has 0 logging failures.

## Current State Evaluation — root cause

The first guess, another test file leaking global state into these suites, was **wrong**. The
workspace project runs with `pool: 'forks'`, so every file gets a fresh process. The cause is
the **environment the runs start with**:

| Invocation | Loads `.env.test`? | Logging dir result |
|---|---|---|
| `npx vitest run <logging dir>` | no | 405/405 |
| `pnpm --filter @arcaai/applications test` | no | 405/405 |
| `npx dotenv -e .env.test -- npx vitest run <logging dir>` (the logging dir **alone**) | yes | **46 failed** |
| `LOG_LEVEL=error npx vitest run <logging dir>` | — | 45 failed |

`pnpm test:unit` is `dotenv -e .env.test -- vitest run …`. `.env.test` sets `LOG_LEVEL=error`,
`LOG_CONSOLE_JSON=false`, `LOG_CONSOLE_PRETTY=true`, `LOG_CONSOLE_COLORIZE=true` (and other
`LOG_*` / `LOKI_*` / `OTEL_LOG*` values). `LoggingService` reads these on purpose
(`logging.service.ts:85`, `:143-145`). But each failing suite built its fixture env by spreading the
ambient `process.env` (`{ ...originalEnv, … }` / `{ ...process.env }`), so:

- `LOG_LEVEL=error` filtered out every `info()`/`debug()`/`warn()` → empty capture (45 tests);
- `LOG_CONSOLE_JSON=false` / `PRETTY=true` overrode the `isTTY`-based default that
  `loki-line-contract > format selection > emits JSON in a container` checks (the 46th).

The defect is in the **tests**: they assert the service's defaults while inheriting whatever the
calling shell sets. The production code behaves correctly.

## Implementation Plan

1. RED: reproduce with `.env.test` on the logging dir alone (46 failures) — done above.
2. Add `__tests__/hermetic-logging-env.ts` — `hermeticLoggingEnv(env)` returns a copy of `env`
   with the logging-config variables removed (prefixes `LOG_`, `LOKI_`, `HIGHLIGHT_`,
   `AGENTIC_HIGHLIGHT_`; keys `OTEL_LOGS_ENABLED`, `OTEL_LOG_BRIDGE`). Service identity
   (`SERVICE_NAME`, `NODE_ENV`) is left alone; the suites that need it set it themselves.
3. Build the five suites' fixture env from it. `redactor.test.ts`'s dispatch-integration block
   touched no env before; it now gets a `beforeEach`/`afterEach` pair that sets and restores it.
4. GREEN: logging dir 405/405 under all three invocations; full `pnpm test:unit` → 0 logging failures.

## Implementation Summary

Files changed (tests only):

| File | Change |
|---|---|
| `packages/applications/src/services/baseServices/logging/__tests__/hermetic-logging-env.ts` | **new** — `hermeticLoggingEnv()` |
| `…/__tests__/logging.service.test.ts` | fixture env spreads `hermeticLoggingEnv(originalEnv)` |
| `…/__tests__/logging.correlation.test.ts` | same |
| `…/__tests__/logging.level-and-lifecycle.test.ts` | same (3 describes) |
| `…/__tests__/loki-line-contract.test.ts` | `saved = hermeticLoggingEnv()` (3 describes) |
| `…/__tests__/redactor.test.ts` | `LoggingService dispatch integration` sets a hermetic env in `beforeEach`, restores it in `afterEach` |

No migrations, API changes, or production code changes.

### Evidence

Logging dir (`packages/applications/src/services/baseServices/logging`):

```
npx dotenv -e .env.test -- npx vitest run <dir>   →  Tests  405 passed (405)   (was 46 failed)
npx vitest run <dir>                              →  Tests  405 passed (405)
(packages/applications) npx vitest run <dir>      →  Tests  405 passed (405)
```

Full `pnpm test:unit` in the worktree. This needed `pnpm db:generate` + `pnpm build:packages`
first: a fresh worktree has no `dist/`, and without it the first run reported 1,445 files failing
with `Failed to resolve entry for package "@arcaai/domains"`.

```
 Test Files  1 failed | 1946 passed | 2 skipped (1949)
      Tests  1 failed | 28594 passed | 7 skipped | 9 todo (28611)
logging failures: 0
```

The one remaining failure is **pre-existing and out of scope**:
`scripts/__tests__/env-sync.test.ts > … bootstrap floor … stays within the size target (≤ 60 lines)`,
`expected 64 to be less than or equal to 60`. `.env.sample` was last changed by TASK-1024
(`14b7eb776`), and the test fails the same way run alone. `test:unit` chains its second half with
`&&`, so that failure stopped the second half from running. It was run directly instead:

```
npx dotenv -e .env.test -- pnpm --filter @arcaai/vox --filter @arcaai/admin-console test
packages/agentic-sdk-v2 test:  Tests  3298 passed (3298)
apps/admin-console test:       Tests  3821 passed (3821)
```

Lint/format: ESLint ignores `__tests__/` in this package (0 errors). Prettier is clean on the new
helper. `loki-line-contract.test.ts` and `redactor.test.ts` already failed Prettier at HEAD and
were not reformatted, to keep the diff small.

## Change History

| Date | Change |
|---|---|
| 2026-09-30 | Root cause found (ambient `.env.test` logging config, not a cross-file leak); suites made hermetic; status Review |
