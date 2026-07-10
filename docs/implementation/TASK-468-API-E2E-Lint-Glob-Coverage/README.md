# TASK-468 — apps/api Lint Glob Missed `tests/**` (e2e specs never linted)

- **Status**: Review (lint gate green + unit suite green; e2e specs are Playwright — not run live here, but changes are formatting + lint-fixes only)
- **Type**: infrastructure (lint/test hygiene)
- **Origin**: flagged during [TASK-467](../TASK-467-STT-WS-Control-Frame-Classification/README.md), which deliberately left the pre-existing e2e prettier violations untouched (surgical scope). This ticket closes that gap.
- **Branch**: `fix/2605-review`
- **Size**: M (2 config lines + a 59-file formatting normalization)

## Requirement Analysis

`apps/api`'s lint script globbed `"{src,apps,libs,test}/**/*.ts"` — the unmodified NestJS scaffold default. `apps/` and `libs/` don't exist in `apps/api`, and `test/` holds only the vestigial NestJS Jest sample (`app.e2e-spec.ts` + `jest-e2e.json`), which the flat config already ignores (`ignores: ['test/**']`). The real Playwright/Vitest tree lives in **`tests/`** (`tests/e2e`, `tests/helpers`, `tests/integration`, `tests/setup`, `tests/unit`) — **never matched by the `test/**` segment**. So the 59 e2e `.spec.ts` files were **never linted** by `pnpm --filter @arcaai/api lint` nor by CI's `lint-ts` (`pnpm turbo lint` → the same script). The flat config does NOT ignore `.spec.ts` — it intends to lint them; they were simply never reached.

**Decision: gap, not intentional** — the glob is the scaffold default and the real test tree was added later (TASK-455 streaming suite, and the earlier TASK-3xx e2e suites) without updating it.

## Current State Evaluation

Linting `tests/**` surfaced **5846 problems**:
- **5779 `prettier/prettier`** across **59 files** — auto-fixable formatting.
- **67 hard errors** that `--fix` cannot resolve (so a naive glob change would *break* the lint gate, not fix it):
  - 38 `@typescript-eslint/no-explicit-any` — e2e specs use `as any` for mocks/fixtures.
  - 20 `turbo/no-undeclared-env-vars` — test-only env (`STREAM_E2E_*`, `RESET_DB`, `HARNESS_E2E_*`).
  - 8 `@typescript-eslint/no-unused-vars` + 1 `@typescript-eslint/no-unsafe-function-type` — genuine cleanups.

`apps/api` lints against plain `core` (no `only-warn`), so these are HARD errors.

## Implementation Plan

1. Fix the glob: `{src,apps,libs,test}` → `{src,tests}` (accurate — drops the two non-existent dirs; `test/**` stays flat-config-ignored).
2. Add a `tests/**` eslint override relaxing the two **test-inappropriate** rules (`no-explicit-any`, `turbo/no-undeclared-env-vars`). Prettier + all correctness rules (unused vars, unsafe types, the arcaai-internal architecture rules) still apply to test code.
3. Fix the 9 genuine non-prettier errors (remove dead imports; `_`-prefix unused locals per the repo's `/^_/` `varsIgnorePattern`, preserving side-effects; narrow one `Function` → `object`).
4. `eslint --fix` the 5779 prettier issues across `tests/**`.
5. Verify: lint gate green over `{src,tests}`; API unit suite unchanged.

## Implementation Summary

**Config:**
- [apps/api/package.json](../../../apps/api/package.json) — `lint` glob `{src,apps,libs,test}` → `{src,tests}`.
- [apps/api/eslint.config.mjs](../../../apps/api/eslint.config.mjs) — new `files: ['tests/**/*.ts']` override turning off `@typescript-eslint/no-explicit-any` and `turbo/no-undeclared-env-vars` (test code only).

**9 genuine fixes** (unrelated tickets' files, minimal + behavior-neutral):
| File | Fix |
|---|---|
| `tests/e2e/audit-log.spec.ts` | `doctorToken` → `_doctorToken` (decl + assignment; login side-effect preserved) |
| `tests/e2e/task-330-phase3-rag.spec.ts` | `CONTEXT_ITEM_ID` → `_CONTEXT_ITEM_ID` (matches the doc comment) |
| `tests/e2e/task-382-agent-management.spec.ts` | drop unused `type APIRequestContext` import |
| `tests/e2e/task-387-tenant-data-model.spec.ts` | unused `asArray`→`_asArray`, `getVersion`→`_getVersion` |
| `tests/e2e/task-389-agents-backend.spec.ts` | drop unused `type APIRequestContext` import |
| `tests/e2e/task-390-super-admin-backend.spec.ts` | drop unused `type APIRequestContext` import |
| `tests/integration/full-route-walk.spec.ts` | `controllerClass: Function` → `object` (accepts the class; Reflect.getMetadata takes `object`) |
| `tests/setup/integration.setup.ts` | drop unused `beforeEach` import |

**Formatting:** `eslint --fix` normalized prettier across **59 files** (`git diff --stat tests/` → 59 files, +6368/−6779). Prettier is behavior-preserving (whitespace, quote/trailing-comma normalization, collapsing multi-line expressions that fit).

### Verification evidence

- **Lint gate (CI-equivalent), full new glob:**
  ```
  $ eslint --no-fix "{src,tests}/**/*.ts"   # exit 0
  ```
  0 errors, 0 warnings — `src` **and** all 59 e2e specs now covered and clean.
- **API unit suite (no behavioral regression):**
  ```
   Test Files  122 passed (122)
        Tests  2056 passed (2056)
  ```
  (`pnpm exec dotenv -e .env.test -- vitest run apps/api`)
- **Playwright e2e specs NOT run** (no live stack in this session). Changes are formatting + dead-import removal + `_`-prefixes + one type-annotation narrowing — behavior-neutral, and eslint's TS parser accepted all 59 with zero errors. A full `pnpm test:e2e` on a live stack is the residual confirmation.

### Notes / residual observations (not fixed here — out of scope)

- The lint script keeps `--fix`. CI runs `pnpm turbo lint` → `eslint … --fix`, so **fixable** issues (prettier) are auto-corrected in the ephemeral CI run and never *fail* the pipeline — only **unfixable** rule errors fail it. Formatting enforcement therefore still relies on devs running lint locally + committing. This is the repo-wide pattern (every package's `lint` uses `--fix`); changing it is a separate, broader decision.
- The 59-file reformat is a large churn on the shared `fix/2605-review` branch; expect to rebase in-flight Wave 2 spec edits (TASK-457 rewrites some streaming spec pins). Landing it as one deliberate commit (per the chosen approach) keeps it atomic.

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | Fixed the apps/api lint glob gap discovered in TASK-467: `{src,apps,libs,test}` (NestJS scaffold default; `apps`/`libs` absent, `test/` = vestigial Jest sample) never reached the real `tests/` tree, so 59 Playwright e2e specs were unlinted. Changed glob → `{src,tests}`; added a `tests/**` eslint override relaxing `no-explicit-any` + `turbo/no-undeclared-env-vars` (test-appropriate); fixed 9 genuine unused/unsafe errors; `eslint --fix` normalized prettier across 59 files. Lint gate green over `{src,tests}` (exit 0), API unit suite unchanged (2056 pass). e2e not run live. Status → Review. |
