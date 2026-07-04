# TASK-418 — Full ESLint 9 Flat-Config Migration

- **Status**: Pending
- **Type**: infrastructure — monorepo-wide lint modernization
- **Created**: 2026-07-04
- **Origin**: TASK-415 review (user decision 2026-07-04: "full migration first" — prioritized before/alongside the admin-console screen phases)

## Requirement Analysis

Migrate the entire monorepo from the legacy ESLint v8 eslintrc estate to ESLint 9 flat config, so the additive `packages/config-eslint/next-flat.js` preset (created for `apps/admin-console` in TASK-415 Phase 1) becomes the norm rather than the exception.

## Current State Evaluation

- `packages/config-eslint` ships eslintrc-style presets (`base.js`, `next.js`, `react-internal.js`, ...) consumed by 20+ packages/apps, plus the new flat `next-flat.js` (typescript-eslint 8, @next/eslint-plugin-next 16, react-hooks, prettier-compat) used only by `apps/admin-console`.
- `packages/*` lint runs with `eslint-plugin-only-warn` (architecture violations appear as warnings); `apps/api` treats them as hard errors.
- `eslint-plugin-arcaai-internal` (house architecture rules) must be verified/ported for flat-config consumption.

## Implementation Plan (high level — detail before starting)

1. Inventory every `.eslintrc*` / `eslintConfig` consumer and its effective rule set.
2. Convert `packages/config-eslint` presets to flat equivalents (shared core + per-surface presets: node lib, react lib, NestJS app, Next.js app); keep rule parity — diff lint output before/after per package.
3. Port `eslint-plugin-arcaai-internal` and the `only-warn` behavior (or replace with severity mapping) to flat config.
4. Migrate packages in dependency order; remove `ESLINT_USE_FLAT_CONFIG` escapes and legacy presets once all consumers are switched.
5. Verify: `pnpm lint` green repo-wide with zero *new* violations; CI lint job unchanged or simplified.

## Implementation Summary

*Pending.*

## Change History

| Date | Change |
|---|---|
| 2026-07-04 | Ticket created from the TASK-415 review decision. |
