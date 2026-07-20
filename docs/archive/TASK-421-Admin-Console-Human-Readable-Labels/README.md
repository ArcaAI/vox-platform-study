# TASK-421 — Admin Console Human-Readable Labels

| | |
|---|---|
| **Status** | In Progress |
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

_(updated on completion)_

## Change History

- 2026-07-05 — Ticket opened; audit findings captured; plan approved by user ("now go").
