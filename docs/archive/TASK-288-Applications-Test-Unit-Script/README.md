# TASK-288: Add `test:unit` Script to `@arcaai/applications`

| Field | Value |
|---|---|
| **Ticket** | TASK-288 |
| **Type** | Infrastructure |
| **Status** | Completed |
| **Created** | 2026-05-24 |
| **Updated** | 2026-05-24 |
| **Parent** | [TASK-262 – Vox SDK Deep Assessment](../TASK-262-Vox-SDK-Deep-Assessment/README.md) |
| **Sibling** | [TASK-282 – UserRoles Backend Routes](../TASK-282-UserRoles-Backend-Routes/README.md) |

---

## Requirement Analysis

### Description

The `01-development-workflow.mdc` Layer Gates table mandates that the `Services` layer (`@arcaai/applications`) must be verifiable via:

```
pnpm test:unit --filter @arcaai/applications
```

However, `packages/applications/package.json` had no `test`, `test:unit`, or `vitest` entries, making this workflow gate structurally unsatisfiable — 133 existing test files were never being run via the package's own script.

### Business Context

This blocks CI/CD enforcement of the layer-gate rule and means any developer following the documented workflow rule cannot verify the application services layer independently without knowing the workaround.

### Acceptance Criteria

- `pnpm --filter @arcaai/applications test:unit` exits 0 from repo root.
- Script uses `vitest run` (not watch mode) so it is CI-safe.
- Script uses `--passWithNoTests` so an empty test suite does not break the gate.
- No new test files are added; no source files are modified.
- Build and lint remain green.

---

## Current State Evaluation

### Existing Test Files

133+ test files existed under `packages/applications/src/**/__tests__/` before this ticket — they were simply never wired to a runnable script. Discovered via glob:

```
packages/applications/src/services/tenant/__tests__/tenant.service.test.ts
packages/applications/src/services/auth/__tests__/jwt.strategy.test.ts
packages/applications/src/common/__tests__/base.service.test.ts
... (133 total files, 3766 tests)
```

### Existing Vitest Infrastructure

- **Root `vitest.workspace.ts`**: already contained a `packages-applications` project entry covering `src/**/*.test.ts`. This entry was unreachable without the per-package script.
- **Root `vitest.config.ts`**: shared base config (`globals: true`, `node` environment, 30s timeout).
- **No `vitest.config.ts`** existed in `packages/applications/`.
- **`vitest` not in `devDependencies`** for this package, though it was present in the lockfile transitively.

### Workaround Previously Documented

TASK-282 (C2) documented a temporary workaround: `pnpm exec vitest run` run from within the package directory. This ticket makes that workaround unnecessary.

---

## Implementation Plan

1. Create `packages/applications/vitest.config.ts` (node environment, covers `src/**/__tests__/**/*.test.ts`).
2. Add `"test": "pnpm test:unit"` and `"test:unit": "vitest run --passWithNoTests"` to `package.json` scripts.
3. Add `"vitest": "^4.1.1"` to `devDependencies` (matching the version in `packages/domains/package.json`).
4. Add `"vitest.config.ts"` to `ignorePatterns` in `.eslintrc.js` (TypeScript-typed lint cannot parse files outside `tsconfig.json` include paths; same gap exists in `packages/agentic-sdk-v2` but is out of scope here).
5. Run `pnpm install` to register the dependency.
6. Verify: `test:unit`, `build`, `lint`.

---

## Implementation Summary

### Files Modified

| File | Change |
|---|---|
| `packages/applications/package.json` | Added `test` and `test:unit` scripts; added `vitest ^4.1.1` devDependency |
| `packages/applications/vitest.config.ts` | **New file** — minimal Vitest config (node environment) |
| `packages/applications/.eslintrc.js` | Added `vitest.config.ts` to `ignorePatterns` |
| `pnpm-lock.yaml` | 3-line addition registering `vitest` for `@arcaai/applications` |

### Exact Script Lines Added (`package.json`)

```json
"test": "pnpm test:unit",
"test:unit": "vitest run --passWithNoTests"
```

### Vitest Config Added

`packages/applications/vitest.config.ts` was created to match project conventions (mirrors `packages/agentic-sdk-v2/vitest.config.ts` style but with `node` environment and no `setupFiles`):

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
```

A per-package config was created (rather than relying solely on the root workspace config) so that `vitest run` launched from within the package directory discovers tests without requiring the caller to know the workspace project name.

### `vitest` devDependency

Added `"vitest": "^4.1.1"` to `devDependencies`. Version `^4.1.1` was chosen to match the exact version declared in `packages/domains/package.json` (the nearest sibling with an identical NestJS testing profile). The package was already in the lockfile transitively, so the lockfile diff is minimal (3 lines).

### Existing Test Files Discovered

**136 test files** discovered (133 from `__tests__/` glob + 3 additional patterns matched by `src/**/*.test.ts`). All were already written and passing — none were newly created.

### ESLint Fix

The `parserOptions: { project: true }` setting in `.eslintrc.js` causes TypeScript ESLint to reject files not included in `tsconfig.json`. Since `vitest.config.ts` is a build tooling file (not application source), it was added to `ignorePatterns` alongside `dist/`, `.turbo/`, and `**/__tests__/`. This is the same fix that `packages/agentic-sdk-v2` would require if its lint were run similarly.

---

## Verification Evidence

### `pnpm --filter @arcaai/applications test:unit`

```
 Test Files  136 passed (136)
      Tests  3766 passed (3766)
   Start at  08:07:35
   Duration  9.69s (transform 8.88s, setup 0ms, import 108.60s, tests 4.68s, environment 9ms)
```

Exit code: **0**

### `pnpm --filter @arcaai/applications build`

```
> @arcaai/applications@0.0.1 build
> rimraf dist tsconfig.tsbuildinfo && tsc
```

Exit code: **0**

### `pnpm --filter @arcaai/applications lint`

```
✖ 79 problems (0 errors, 79 warnings)
```

Exit code: **0** (79 pre-existing prettier warnings; 0 errors; 0 new issues introduced)

### Note on `pnpm test:unit --filter` Syntax

The workflow rule documentation references `pnpm test:unit --filter @arcaai/applications`. In practice, pnpm forwards arguments after the script name to the script process, not to pnpm's filter engine. The equivalent canonical pnpm command is `pnpm --filter @arcaai/applications test:unit`. Both the workflow rule documentation and this README document the canonical form.

---

## Change History

| Date | Description | Files |
|---|---|---|
| 2026-05-24 | Initial implementation — scripts, vitest config, eslint fix | `package.json`, `vitest.config.ts`, `.eslintrc.js`, `pnpm-lock.yaml` |
