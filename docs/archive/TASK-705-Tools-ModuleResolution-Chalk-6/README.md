# TASK-705 — Tools moduleResolution + chalk 6

| Field | Value |
|---|---|
| **Status** | `Completed` |
| **Type** | `infrastructure` |
| **Ticket number** | TASK-705 |
| **Classification** | Switch `@arcaai/tools` TypeScript resolution to an existing monorepo style, then bump chalk 5 → 6 |

---

## Requirement Analysis

TASK-699 reverted chalk 6.0.0 because `@arcaai/tools` uses `module: commonjs` with classic (unspecified) `moduleResolution`. chalk 6 publishes types only via `package.json` `exports`, which classic resolution cannot see (`TS2307`).

This ticket:

1. Set `moduleResolution` to `bundler` (existing preset: `packages/config-ts/nextjs.json`) so TypeScript honors `exports`
2. Keep `module: commonjs` so `ts-node` CLI scripts keep running without rewriting relative imports to `.js` (Node16/NodeNext would require that — a third, larger change)
3. Bump `chalk` `^5.6.2` → `^6`
4. Revert chalk 6 if ESM exports still fail typecheck

Do not invent a third tsconfig style. Do not touch Python, compose images, or other UI majors. Same `pnpm-lock.yaml` as TASK-703.

---

## Current State Evaluation

- `packages/tools/tsconfig.json` now uses the nextjs pairing: `module: esnext` + `moduleResolution: bundler`
- `module: commonjs` + `moduleResolution: bundler` is invalid (`TS5095`); ts-node stays on CommonJS via a `ts-node.compilerOptions.module` override
- NodeNext was not used (would force `.js` extensions on relative imports)
- chalk is `^6` (lockfile `6.0.0`)
- No tools unit-test script; verification is `pnpm --filter @arcaai/tools typecheck`

---

## Implementation Plan

1. Add `"moduleResolution": "bundler"` to `packages/tools/tsconfig.json`.
2. Bump `chalk` to `^6` and refresh `pnpm-lock.yaml`.
3. Run `pnpm --filter @arcaai/tools typecheck`. Revert chalk 6 if `TS2307` (or ESM export errors) remain.

---

## Implementation Summary

**Result: chalk 6 landed.** Typecheck green; no `TS2307`. Re-verified 2026-08-16 against current tree.

`bundler` cannot pair with `module: commonjs` (`TS5095`). Matched the existing nextjs preset instead (`module: esnext` + `moduleResolution: bundler`) and kept generator CLI emit on CommonJS via:

```json
"ts-node": { "compilerOptions": { "module": "commonjs" } }
```

`@arcaai/tools` is the only workspace package with a direct `chalk` dependency. chalk 6.0.0 is ESM-only (`type: module`, types via `exports`); default `import chalk from 'chalk'` typechecks and runs under the ts-node CommonJS override. No tools unit-test script exists; verification remains typecheck plus that interop smoke.

### Files changed

- `packages/tools/tsconfig.json` — `module: esnext`, `moduleResolution: bundler`, ts-node CommonJS override
- `packages/tools/package.json` — `chalk` `^5.6.2` → `^6`
- `pnpm-lock.yaml` — `packages/tools` importer `chalk` specifier `^6` → `6.0.0`

### Verification

```
pnpm --filter @arcaai/tools typecheck
# tsc --noEmit -p tsconfig.json  (exit 0)

# ts-node default-import smoke (packages/tools):
# import chalk from 'chalk' → typeof chalk === 'function', chalk.blue works
```

No Python, compose, or other UI major bumps.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-15 | Ticket created. Queued after TASK-703 so both share one lockfile. |
| 2026-08-15 | Landed chalk 6 after switching tools to nextjs-style bundler resolution. Typecheck green. Status → Review. |
| 2026-08-16 | Verified completion against current implementation: tools `module`/`moduleResolution` pairing, chalk `^6` / lockfile `6.0.0`, typecheck exit 0, ts-node default-import interop. No scoped leftovers. Status → Completed. |
