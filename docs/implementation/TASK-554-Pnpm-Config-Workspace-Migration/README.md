# TASK-554 — pnpm Config Workspace Migration

| | |
|---|---|
| **Status** | Completed |
| **Type** | infrastructure |
| **Created** | 2026-07-25 |
| **Depends on** | — |

## Requirement Analysis

pnpm v11 no longer reads settings from `package.json#pnpm` (overrides are silently ignored). This repo pins pnpm 10.31.x, where that field still works, but config is already split: `onlyBuiltDependencies` lives in `pnpm-workspace.yaml` while `overrides` remain under `package.json#pnpm`.

Move `overrides` into `pnpm-workspace.yaml` and remove `package.json#pnpm` so configuration is forward-compatible and matches pnpm 10.x best practice, without upgrading to pnpm 11.

## Current State Evaluation

- `packageManager`: `pnpm@10.31.0` (Corepack); CI uses vendored `.gitlab/corepack/pnpm-10.31.0.tgz`
- [`pnpm-workspace.yaml`](../../../pnpm-workspace.yaml): `packages` + `onlyBuiltDependencies` (Prisma)
- Root [`package.json`](../../../package.json): `pnpm.overrides` for `class-validator`, `@types/react`, `@types/react-dom` (removed by this ticket)
- Lockfile already records the same overrides; they apply under pnpm 10.31

## Implementation Plan

1. Add `overrides` to root `pnpm-workspace.yaml`
2. Remove the `pnpm` key from root `package.json` (keep `packageManager` on 10.31.0)
3. Verify with `pnpm install` and `pnpm why class-validator`
4. Update docs that reference `package.json` `pnpm.overrides`

Out of scope: pnpm 11 upgrade (`allowBuilds`, Corepack tarball refresh, `pnpm clean` script shadowing). Follow-up when upgrading: `pnpx codemod run pnpm-v10-to-v11`, convert `onlyBuiltDependencies` → `allowBuilds`, refresh `.gitlab/corepack/pnpm-*.tgz` + CI `corepack install` lines, note that root script `clean` shadows `pnpm clean` under v11.

## Implementation Summary

Moved dependency overrides from `package.json#pnpm` into `pnpm-workspace.yaml`. Stayed on pnpm 10.31.0.

### Files changed

| File | Change |
|---|---|
| `pnpm-workspace.yaml` | Added `overrides` (`class-validator`, `@types/react`, `@types/react-dom`) |
| `package.json` | Removed `pnpm` block; `packageManager` unchanged |
| `docs/development-patterns-and-standards.md` | Document overrides location in workspace yaml |
| `docs/implementation/TASK-554-…/README.md` | This ticket |

### Verification evidence

- `pnpm --version` → `10.31.0`
- Root `package.json` has no `pnpm` key
- `pnpm install` → lockfile up to date, Done in 2s using pnpm v10.31.0
- Lockfile still has:
  ```
  overrides:
    class-validator: 0.15.1
    '@types/react': ^19.2.14
    '@types/react-dom': ^19.2.3
  ```
- `pnpm why class-validator` → single version `class-validator@0.15.1`
- `pnpm why @types/react` → `@types/react@19.2.17` (satisfies `^19.2.14`)

## Change History

| Date | Change |
|---|---|
| 2026-07-25 | Ticket opened; plan approved (stay on 10.31, relocate overrides only) |
| 2026-07-25 | Overrides moved to `pnpm-workspace.yaml`; `package.json#pnpm` removed; docs updated; verified |
