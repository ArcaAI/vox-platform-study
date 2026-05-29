# TASK-313 — PolicyEngine tenant-scope fix (stale `null = global` → SYSTEM_TENANT_ID)

| Field | Value |
|---|---|
| **Ticket** | TASK-313-Policy-Engine-Tenant-Scope-Fix |
| **Created** | 2026-05-29 |
| **Updated** | 2026-05-29 |
| **Status** | `Completed` |
| **Classification** | Bugfix (authorization — runtime crash + latent authz failure) |
| **Priority** | Critical — every tenant-less request (super_admin → `/admin/*`) 500s at the auth guard; admin console fully blocked |
| **Source** | Surfaced during the `/review` of TASK-308–311 on `fix/2605-review` (dev API log, terminal 13) |
| **Base branch** | `fix/2605-review` (HEAD `83936837`) |

---

## 1. Requirement Analysis

### 1.1 Description

`PolicyEngine.loadUserPolicies()` (`packages/applications/src/authorization/policy.engine.ts`) builds the CASL ability for every request through `UnifiedAuthGuard` / `AuthorizationGuard`. Its role-assignment lookup still used the **pre-TASK-305** tenant semantics:

```ts
OR: [
  { tenantId: null },              // "global" assignments
  { tenantId: context.tenantId },  // tenant-specific
]
```

TASK-305 Phase A (migration `20260527000000_task_305_phase_a_drop_sentinel_default_and_scope_uniques`) changed `UserRoleAssignment.tenantId` to a **required, non-nullable** column and back-filled every `NULL` to `SYSTEM_TENANT_ID` (`00000000-0000-0000-0000-000000000000`). The guard passes `tenantId: user.tenantId || undefined`, so for a platform user (super_admin, whose `user.tenantId` is null) `context.tenantId` is `undefined`.

Two defects result:

1. **Runtime crash (observed).** `{ tenantId: undefined }` inside the `OR` makes Prisma 7 throw `Invalid prisma.userRoleAssignment.findMany() … Argument 'tenantId' is missing.` → `UnifiedAuthGuard` logs `Ability build failed` → request fails. Reproduced on `GET /api/v1/admin/tenants` and `GET /api/v1/admin/users` as `super_admin`.
2. **Latent authorization failure.** Even without the crash, `{ tenantId: null }` now matches **zero** rows (no assignment has a null tenantId post-migration), so super_admin's `SYSTEM_TENANT_ID` assignment would never load → empty ability → 403 on everything.

### 1.2 Business context

This blocks the entire admin surface for platform users and would silently break authorization for any platform-wide (system-tenant) role assignment. It is independent of TASK-308–311 (it predates them — `git blame` → initial commit) but was exposed while verifying that merged branch.

### 1.3 Acceptance criteria

- **AC-1** A tenant-less context (`context.tenantId === undefined`) never produces a Prisma filter containing `undefined` or `null` for `tenantId`.
- **AC-2** Platform-wide role assignments stored under `SYSTEM_TENANT_ID` are loaded for the user regardless of request tenant context.
- **AC-3** A tenant-scoped request loads both the user's system-tenant (global) assignments and their request-tenant assignments.
- **AC-4** No duplicate scope entry when `context.tenantId === SYSTEM_TENANT_ID`.
- **AC-5** Existing authorization test suite stays green (no behaviour change for tenant users with valid assignments).

### 1.4 Out of scope

- Refactoring the CASL engine, caching, or the guard's `user.tenantId || undefined` derivation.
- Extracting a shared runtime `SYSTEM_TENANT_ID` constant across packages (the seed defines it in `00-constants.ts`; `auditLog.service.ts` already uses the literal). Tracked as a follow-up.

---

## 2. Current State Evaluation

- `packages/applications/src/authorization/policy.engine.ts:loadUserPolicies` — the stale `OR` query.
- `packages/database/src/prisma/db_main/user.prisma` — `UserRoleAssignment.tenantId String` (NOT NULL).
- `packages/database/src/prisma/db_main/seed/91-user.ts:91` — `super_admin` seeded with `tenantId: SYSTEM_TENANT_ID`.
- Existing unit tests (`policy.engine.test.ts`, `tenant-ability.regression.test.ts`) mock `userRoleAssignment.findMany` and never assert the `where` clause, so the malformed query slipped through CI while breaking at runtime.

---

## 3. Implementation Plan

1. RED: add tests pinning the exact `where` shape for (a) no tenant context, (b) tenant context, (c) tenant === system tenant.
2. GREEN: build the tenant scope as an `in` list (`[SYSTEM_TENANT_ID]`, plus the request tenant when present and distinct). Replace the `OR`.
3. Verify: full `src/authorization` suite + applications build.
4. Live: restart `dev:api`, confirm `/api/v1/admin/*` returns 200 for super_admin.

---

## 4. Implementation Summary

### 4.1 Fix

`packages/applications/src/authorization/policy.engine.ts`:

- Added module constant `SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000'` (matches the migration + `auditLog.service.ts` literal).
- Rewrote the `loadUserPolicies` lookup:

```ts
const tenantScopes = [SYSTEM_TENANT_ID];
if (context.tenantId && context.tenantId !== SYSTEM_TENANT_ID) {
  tenantScopes.push(context.tenantId);
}

const directAssignments = await prisma.userRoleAssignment.findMany({
  where: {
    userId: context.userId,
    resourceStatus: ResourceStatusType.ENABLED,
    tenantId: { in: tenantScopes },
  },
});
```

The `in` list is built without `undefined`, so the Prisma-7 crash is structurally impossible (defense-in-depth), and global assignments resolve via `SYSTEM_TENANT_ID` per the new schema.

### 4.2 Tests

`packages/applications/src/authorization/__tests__/policy.engine.test.ts` — new `describe('loadUserPolicies — tenant scoping (TASK-305 schema alignment)')` with 3 cases pinning the `where` shape and asserting no `null` / no `OR` leaks (AC-1..AC-4).

### 4.3 Files changed

| File | Change |
|---|---|
| `packages/applications/src/authorization/policy.engine.ts` | `SYSTEM_TENANT_ID` constant + `in`-list tenant scoping in `loadUserPolicies` |
| `packages/applications/src/authorization/__tests__/policy.engine.test.ts` | +3 tenant-scoping tests (RED→GREEN) |

---

## 5. Verification Evidence

| Check | Command | Result |
|---|---|---|
| Unit (RED→GREEN) | `vitest run src/authorization` | ✅ 111 passed (7 files), incl. 3 new |
| Build | `pnpm build --filter @arcaai/applications` | ✅ 6 tasks successful |
| Lint | `ReadLints` on both files | ✅ 0 errors |
| Live | `dev:api` + `GET /api/v1/admin/{tenants,users}` as super_admin | ✅ HTTP 200, no `Ability build failed` (§5.1) |

### 5.1 Live verification

Fresh `pnpm dev:api` on the dev stack (postgres 5432, redis 6379, vault). Logged in as `super_admin` (`tenantId: ""` → `context.tenantId` resolves to `undefined`, the crash path), then probed the two previously-failing endpoints:

```text
POST /api/v1/auth/login (super_admin)              → token issued
GET  /api/v1/admin/tenants?page=1&limit=1          → HTTP 200 (count 5)
GET  /api/v1/admin/users?page=1&limit=1            → HTTP 200 (count 26)
```

Dev log confirms clean completion, no `Ability build failed`:

```text
21:06:09 INFO [ContextInterceptor] Request completed … path=/api/v1/admin/tenants … statusCode=200
21:06:09 INFO [ContextInterceptor] Request completed … path=/api/v1/admin/users   … statusCode=200
```

Pre-fix the same requests logged `ERROR [UnifiedAuthGuard] Ability build failed … Argument 'tenantId' is missing` (terminal 13). Confirmed resolved.

---

## 6. Change History

| Date | Description | Files modified |
|---|---|---|
| 2026-05-29 | Root-caused the `Ability build failed` runtime crash to stale `null = global` tenant semantics in `PolicyEngine.loadUserPolicies` (pre-TASK-305 schema). Fixed via `SYSTEM_TENANT_ID` + `in`-list scoping; +3 RED→GREEN tests; authz suite 111 green; applications build clean. | `packages/applications/src/authorization/policy.engine.ts`, `packages/applications/src/authorization/__tests__/policy.engine.test.ts` |
