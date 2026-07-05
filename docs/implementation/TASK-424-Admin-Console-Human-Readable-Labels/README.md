# TASK-424 — Admin Console Human-Readable Labels

> Renumbered from TASK-421 mid-flight: three concurrent sessions had already claimed TASK-421/422/423 in `docs/implementation/`.

| | |
|---|---|
| **Status** | Completed |
| **Type** | bugfix / feature |
| **Packages** | `packages/domains`, `packages/applications`, `apps/admin-console` |
| **Author** | AI-assisted (user-approved scope) |
| **Date** | 2026-07-05 |

## Requirement Analysis

The admin console displays raw UUIDs where human-readable names belong (reported via screenshot of the user-detail Roles tab: the "Role" column showed `00000000-0000-0000-0000-000000000010` and "Scope" showed `50000000-0000-0000-0000-000000000000`). Best practice: display human-readable information as the primary label; show the id only as secondary metadata.

## Current State Evaluation (verified)

Root cause of the screenshot symptom:

1. `GET /admin/users/:id/roles` → `UserRoleAssignmentService.fetchAllByUserId()` → `UserRoleAssignmentRepository.findAll()`. The repository passes **no includes** (`packages/domains/src/repositories/generated/core/UserRoleAssignmentRepository.ts`), so `entity.Roles` is empty and `UserRoleAssignmentDtoMapper.ToResponse` cannot populate the declared-but-optional `roleName`. The frontend (`user-roles-tab.tsx`) is already name-first (`roleName ?? roleId`) and falls back to the UUID. Contrast: `UserRepository` passes `USER_INCLUDES` (`UserRoleAssignments → include: { Role: true }`), which is why the users **list** shows names but the detail tab does not.
2. `UserRoleAssignmentResponse` carries no tenant name → Scope column renders the raw `tenantId`.
3. `UserDepartmentResponse` carries only `departmentId` → the Departments tab's identity column is a raw UUID (also used in confirm-dialog titles and aria-labels).
4. `DnaReportResponse` carries only `doctorId` → DNA Writing Styles "Doctor" column and doctor detail panel show raw UUIDs.
5. `AuditLog` response carries only `tenantId` (actor is already enriched via `responsibleUser`) → audit "Tenant" column shows raw UUIDs.
6. Assign-role / assign-department dialogs require admins to paste raw UUIDs into free-text inputs.

Full audit (all 26 feature folders swept): tenants, RBAC, API keys, AI models, consultations, platform dashboard, queues, harness-ops are clean (name-first or deliberately opaque operational ids).

## Implementation Plan

### Backend

| Item | Change | Files |
|---|---|---|
| B1 | `UserRoleAssignmentRepository`: add `{ Role: true }` includes (repositories have no CI drift gate — model/entity/factory do; `UserRepository` is the precedent) | `packages/domains/src/repositories/generated/core/UserRoleAssignmentRepository.ts` |
| B2 | `UserDepartmentResponse` + `departmentName?`/`departmentCode?`; `UserDepartmentService.getByUser` batch-resolves departments (repo already injected); mapper accepts optional department | `packages/applications/src/services/user/userDepartment/**` |
| B3 | `DnaReportResponse` + `doctorUsername?`; `listReportsPaginated` batch-resolves doctors via `userRepository` (audit `resolveResponsibleUsers` pattern); `getDnaReport` single-resolve | `packages/applications/src/services/dna-writing-style/**` |

Tenant names are deliberately NOT backend-enriched: the console resolves them client-side (small list, one shared cached query, in-repo precedent `agents-screen.tsx` department labels). No `apps/api` source changes are required (controllers map DTOs already).

### Frontend (apps/admin-console)

| Item | Change | Files |
|---|---|---|
| F0 | Shared groundwork: `src/shared/catalog/` (`useTenantNames`, `useRoleOptions`, `useDepartmentOptions`, `SYSTEM_TENANT_ID`) + `src/shared/data/name-with-id.tsx` (name primary, muted mono id secondary) | `src/shared/**` |
| F1 | Roles tab: Role column name-first w/ secondary id, drop the redundant "Role ID" column, Scope column shows tenant name (Global badge for null/SYSTEM tenant), assign dialog uses role/tenant selects (fallback to text input when catalog unavailable) | `features/users/components/user-roles-tab.tsx` |
| F2 | Departments tab: department name primary w/ secondary id, confirm dialog + aria labels use names, assign dialog uses department select | `features/users/components/user-departments-tab.tsx`, `features/users/api/types.ts` |
| F3 | DNA: Doctor column + detail panel show `doctorUsername` w/ id secondary | `features/dna-writing-styles/**` |
| F4 | Audit logs: Tenant column shows tenant name (fallback id) | `features/audit-logs/components/audit-logs-screen.tsx` |

### Verification criteria

- `pnpm --filter @arcaai/domains build`, `pnpm --filter @arcaai/applications build test` green
- `pnpm --filter @arcaai/admin-console lint test` green (+ app build)
- `apps/api` unit tests still green (no source change expected)
- Updated component tests assert names render and UUIDs are demoted

## Implementation Summary

Implemented in parallel by four agents (backend users, backend DNA, frontend users, frontend DNA+audit) plus coordinator-owned shared groundwork. No DB migration, no `apps/api` source changes (DTO enrichment flows through existing controllers), no breaking API changes (all new DTO fields optional).

### Backend

- `packages/domains/src/repositories/generated/core/UserRoleAssignmentRepository.ts` — passes `{ Role: true }` includes (4th `Repository` ctor arg, `UserRepository` precedent). This alone fixes `roleName` on `GET /admin/users/:id/roles` — the entity mapper already projected `Role → Roles[]` and the DTO mapper already read it.
- `packages/applications/src/services/user/userDepartment/` — `UserDepartmentResponse` gains optional `departmentName`/`departmentCode`; `toResponse` takes an optional department-label arg; `getByUser` batch-resolves distinct departments in ONE `findAll({ id: { in } })`; `assign()` reuses the department already loaded by `assertParentInScope` (zero extra queries).
- `packages/applications/src/services/dna-writing-style/` — `DnaReportResponse` gains optional `doctorUsername`; `listReportsPaginated` batch-resolves the page's doctors (one deduped query, skipped when empty); `getDnaReport` single-resolves with `DataNotFoundException` guard. Mutation/version-history read paths intentionally unenriched (console refetches after mutations).

### Frontend (apps/admin-console)

- NEW `src/shared/catalog/` — cached id→name catalogs (`useTenantNames`, `useRoleOptions`, `useDepartmentOptions`, `useTenantCatalog`, `SYSTEM_TENANT_ID`); degrade to empty on error so callers fall back to raw ids.
- NEW `src/shared/data/name-with-id.tsx` — `NameWithId`: name primary, id demoted to muted mono metadata; bare mono id when no name.
- Users → Roles tab: Role column name-first (redundant "Role ID" column removed); Scope shows tenant name (Global badge for SYSTEM tenant); assign dialog now selects role/tenant by name from catalogs, with free-text fallback when a catalog is unavailable (tenant admins).
- Users → Departments tab: "Department" column shows `Name (CODE)` with id beneath; confirm dialogs + aria-labels use names; assign dialog selects department by name (same fallback).
- DNA Writing Styles: Doctor column + doctor detail panel show `doctorUsername` with id beneath (id-only fallback preserved).
- Audit logs: Tenant column resolves names client-side via `useTenantNames` (actor column was already enriched server-side).

### Evidence (actual output)

- `pnpm --filter @arcaai/domains build` → exit 0; `pnpm --filter @arcaai/applications build` → exit 0
- `pnpm build:api` (turbo) → 8/8 tasks successful
- `pnpm --filter @arcaai/applications test` (full, agent run) → 5811 passed | 4 skipped; targeted re-run of the 4 touched suites → 128 passed (includes `audit-correlation.test.ts`, which flaked once on a loaded full run — passes in isolation, pre-existing)
- `pnpm --filter @arcaai/admin-console test` → 75 files, 507 tests passed
- `pnpm --filter @arcaai/admin-console build` (next build) → success (a transient failure came from another session's in-flight `nav-config.ts` edit, resolved upstream)
- `pnpm --filter @arcaai/api exec vitest run src/modules/user src/modules/dna-writing-style` → 173 passed
- ESLint: 0 new warnings/errors in all touched packages

### Out of scope / follow-ups

- DNA doctor-id filter input and users bulk actions still accept ids (data entry, not display).
- `setDepartments` write-path response unenriched (UI refetches the list).
- Catalog selects use plain shadcn `Select`; if tenant/role lists grow large, upgrade to a searchable combobox.

## Change History

- 2026-07-05 — Ticket opened; audit findings captured; plan approved by user ("now go").
- 2026-07-05 — Renumbered TASK-421 → TASK-424 (three concurrent sessions had claimed 421–423).
- 2026-07-05 — Implementation completed and verified; status → Completed.
