# TASK-417 — Consolidate SUPER_ADMIN into GLOBAL_ADMIN

- **Status**: Pending
- **Type**: refactor — role model cleanup across database seeds, authorization, apps and documentation
- **Created**: 2026-07-04
- **Origin**: TASK-415 capabilities-matrix review (user decision 2026-07-04)

## Requirement Analysis

`SUPER_ADMIN` and `GLOBAL_ADMIN` are treated identically everywhere (`ELEVATED_ROLES` in `packages/applications/src/common/tenant-guards.ts`). Consolidate the two into a single canonical role: **`GLOBAL_ADMIN`**. `SUPER_ADMIN` must not be used anywhere afterward — in implementation or documentation.

## Current State Evaluation

- `ELEVATED_ROLES = ['SUPER_ADMIN', 'GLOBAL_ADMIN']` in `packages/applications/src/common/tenant-guards.ts`; mirrored in `apps/admin-console/src/shared/auth/ability.ts` and `src/server/session.ts` (kept dual-accepting transitionally per TASK-415 Decision 5).
- Role seeds in `packages/database/src/prisma/db_main/seed/03-role.ts`; policies in `01-policy.ts`.
- Existing `SUPER_ADMIN` role assignments live in tenant databases and must be migrated (reassign users to `GLOBAL_ADMIN`, then retire the row).
- "super-admin" terminology appears across docs (`docs/architecture/*`, `docs/development-patterns-and-standards.md`, `docs/traceability-matrix.md`), rules (`05-nestjs-api.mdc`, `12-design-workflow.mdc`, `13-nextjs-apps.mdc`), and code comments/tests.

## Implementation Plan (high level — detail before starting)

1. Database: migration/seed update — ensure `GLOBAL_ADMIN` carries every policy `SUPER_ADMIN` had (`system-full-access`, `rbac-system-manage`, `global-settings-manage`); reassign existing `SUPER_ADMIN` user-role assignments to `GLOBAL_ADMIN`; retire the `SUPER_ADMIN` role row (soft, per soft-delete policy).
2. Backend: collapse `ELEVATED_ROLES` to `['GLOBAL_ADMIN']`; sweep guards/services/tests for `SUPER_ADMIN` string usage.
3. Frontend/console: collapse the transitional dual-accept in `apps/admin-console` (`ability.ts`, `session.ts`, tests).
4. Documentation & rules: replace `SUPER_ADMIN` / "super-admin" with `GLOBAL_ADMIN` / "global admin" across `docs/` and `.cursor/rules/`.
5. Verify: domain/application/api test suites + admin-console tests green; seeded login as `GLOBAL_ADMIN` exercises the full elevated surface.

## Implementation Summary

*Pending.*

## Change History

| Date | Change |
|---|---|
| 2026-07-04 | Ticket created from the TASK-415 review decision. |
