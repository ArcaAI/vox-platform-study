# TASK-314 — Auth-identity reads must bypass tenant-scope (login 500/401 on clean boot)

| Field | Value |
|---|---|
| **Ticket** | TASK-314-Auth-Identity-Tenant-Scope-Bypass |
| **Created** | 2026-05-29 |
| **Updated** | 2026-05-29 |
| **Status** | `Completed` (incl. §7 sibling write-path fix) |
| **Classification** | Bugfix (authentication — login fully blocked on a clean boot) |
| **Priority** | Critical — every `POST /auth/login` throws inside the tenant-scope `$extends` and returns `401 Authentication failed`; no user can authenticate after a clean process start |
| **Source** | Surfaced while standing up the test API for the approved TASK-308/310 E2E run (`/review` of TASK-308–311 on `fix/2605-review`) |
| **Related** | TASK-305 Phase B (tenant-scope `$extends`), TASK-307 W6.1 (the three auth-identity service methods), TASK-313 (sibling tenant-scope alignment bug) |

---

## 1. Requirement Analysis

### 1.1 Description

`AuthController.login()` resolves the caller's identity **before** any tenant
context exists in CLS:

```
login → getUserRoles(user.id) → userRoleAssignmentService.findActiveRolesForUser(userId)
      → databaseService.client.userRoleAssignment.findMany(...)
```

`UserRoleAssignment` is a tenant-scoped model (TASK-305 Phase B,
`TENANT_SCOPED_MODELS`). The tenant-scope `$extends` throws when the request
has no tenant context **and** the caller is not super-admin:

```198:200:packages/database/src/extensions/tenant-scope.ts
      throw new Error(
        `TenantScope: tenant context required for model ${params.model} operation ${op}`,
      );
```

At login the global `ClsModule` middleware has already opened a CLS context,
but **no user is set yet** (the request is unauthenticated). So
`ClsTenantContextProvider` returns `getTenantId() === undefined` and
`isSuperAdmin() === false` → the role lookup throws → the generic `catch` in
`login()` maps it to `401 Authentication failed`.

Observed (temporary debug log, since reverted):

```text
[LOGIN-DEBUG] swallowed login error: Error: TenantScope: tenant context required for model UserRoleAssignment operation findMany
    at .../packages/database/src/extensions/tenant-scope.ts:198:13
POST /api/v1/auth/login → 401
```

### 1.2 Why it was not caught earlier

- **Unit tests** (`userRoleAssignment.service.task307.test.ts`) mock the Prisma
  delegate, so the `$extends` never runs — the malformed-for-runtime call shape
  passed CI.
- **E2E** auth specs were the deferred/never-run items (TASK-308 AC-4/AC-6),
  so a real clean-boot login was never exercised against the Phase B extension.
- **Manual dev testing appeared to work** because `pnpm dev` runs in
  hot-reload watch mode: `ClsTenantContextProvider.onApplicationShutdown()`
  clears the provider singleton on each reload, and
  `resolveTenantContext()` then falls back to its permissive
  `{ tenantId: undefined, isSuperAdmin: true }` pass-through (the stance seed
  scripts/CLI tools rely on). A **clean boot** (the test API, and production)
  wires the provider correctly via `onApplicationBootstrap()` and surfaces the
  defect. **This means production login is also affected.**

### 1.3 Scope of impact

The three auth-identity reads on `UserRoleAssignmentService` are all inherently
**pre-auth / cross-tenant** and all hit the scoped client:

| Method | Caller(s) | Why it must be cross-tenant |
|---|---|---|
| `findActiveRolesForUser` | login, `/me`, `/refresh`, impersonate | needs ALL roles to detect `SUPER_ADMIN` and build JWT claims |
| `findActiveAssignmentForUserInTenant` | login (non-admin tenant validation) | runs pre-auth; tenant boundary is the explicit `tenantId` filter |
| `findActiveTenantIdsForUser` | impersonation target resolution | needs EVERY tenant the user belongs to |

Authenticated requests are **not** affected: the access-token JWT already
carries `roles`/`tenantId`, so the guard hydrates CLS from the token and never
re-reads `UserRoleAssignment` per request.

### 1.4 Acceptance criteria

- **AC-1** A clean-boot `POST /auth/login` (provider wired) for `super_admin`
  (no tenant context) returns `200` with a token, not `401`.
- **AC-2** The three auth-identity reads execute against the **unscoped**
  `baseClient`; the scoped `client` is never used for them.
- **AC-3** Existing behaviour (query shape, return contracts) is preserved.
- **AC-4** Applications unit suite + build stay green.

### 1.5 Out of scope

- Re-architecting CLS so a "system context" is opened for pre-auth flows
  (heavier; the `baseClient` escape hatch already exists and is sanctioned for
  exactly this — cross-tenant identity/platform-admin paths).
- Removing the stale `tenantId: { not: null }` filter in
  `findActiveTenantIdsForUser` (post-TASK-305 `tenantId` is non-nullable, so
  it is a harmless no-op). Left untouched to keep the change surgical.

---

## 2. Current State Evaluation

- `packages/applications/src/services/user/userRoleAssignment/userRoleAssignment.service.ts` — three methods on `this.databaseService.client` (scoped).
- `packages/domains/src/common/databaseServices/core/core.database.service.ts` — `get baseClient()` is the documented tenant-scope/soft-delete bypass for "platform-admin / cross-tenant maintenance" paths.
- `apps/api/src/database/tenant-context.provider.ts` — `isSuperAdmin()`/`getTenantId()` return permissive values only when `!cls.isActive()`; during an HTTP login CLS *is* active with no user.

---

## 3. Implementation Plan (TDD)

1. **RED** — in `userRoleAssignment.service.task307.test.ts`, give the db mock a
   distinct `baseClient`, flip the existing assertions to expect `baseClient`,
   and add a "tenant-scope bypass invariant" block asserting the scoped
   `client` is never touched. Confirm it fails against the current impl.
2. **GREEN** — route the three reads through `this.databaseService.baseClient`
   with a justifying JSDoc note at each call site (per the `baseClient`
   contract in `core.database.service.ts`).
3. **Verify** — URA + authorization suites, applications build, lint.
4. **Live** — restart the test API, confirm `POST /auth/login` (super_admin)
   returns `200`.

---

## 4. Implementation Summary

### 4.1 Fix

`packages/applications/src/services/user/userRoleAssignment/userRoleAssignment.service.ts`
— `findActiveRolesForUser`, `findActiveAssignmentForUserInTenant`, and
`findActiveTenantIdsForUser` now read from `this.databaseService.baseClient`
(was `.client`). Each call site carries a `// TASK-314 — baseClient
(tenant-scope bypass) …` note explaining why the bypass is legitimate. Query
shapes are unchanged.

### 4.2 Tests

`.../__tests__/userRoleAssignment.service.task307.test.ts` — db mock split into
`client` / `baseClient`; existing assertions retargeted to `baseClient`; new
`describe('tenant-scope bypass invariant (TASK-314)')` with 3 cases pinning
that the scoped `client` is never called (AC-2).

### 4.3 Files changed

| File | Change |
|---|---|
| `packages/applications/src/services/user/userRoleAssignment/userRoleAssignment.service.ts` | 3 auth-identity reads → `baseClient` + justifying JSDoc |
| `packages/applications/src/services/user/userRoleAssignment/__tests__/userRoleAssignment.service.task307.test.ts` | `baseClient` mock + retargeted assertions + 3 bypass-invariant tests |
| `apps/api/src/modules/auth/auth.controller.ts` | reverted the temporary `[LOGIN-DEBUG]` diagnostic added during root-cause |
| `packages/applications/src/services/auditLog/auditLog.service.ts` | **§7 follow-up** — inject `CORE_DATABASE_SERVICE`; `handleUserAuthenticatedEvent` LOGIN/IMPERSONATION write → `baseClient` (tenant-scope bypass) + justifying JSDoc |
| `packages/applications/src/services/auditLog/__tests__/auditLog.service.test.ts` | **§7 follow-up** — `CoreDatabaseService` mock (`client`/`baseClient` split) + mapper mock; retargeted the 8 handler-write assertions to `baseClient`; +2 bypass-invariant tests |

---

## 5. Verification Evidence

| Check | Command | Result |
|---|---|---|
| Unit (RED) | `vitest run …task307.test.ts` (pre-fix) | ✅ 10 failed (bypass invariant + retargeted assertions) |
| Unit (GREEN) | `vitest run …task307.test.ts` | ✅ 10 passed |
| Suite | `vitest run src/services/user/userRoleAssignment src/authorization` | ✅ 169 passed (10 files) |
| Build | `pnpm build --filter @arcaai/applications` | ✅ 6 tasks successful |
| Lint | `ReadLints` on changed files | ✅ 0 errors |
| Live | test API (`.env.test`) `POST /auth/login` super_admin | ✅ HTTP 200, `roles:["SUPER_ADMIN"]` (was 401) |
| §7 Unit (RED) | `vitest run src/services/auditLog` (pre-fix, asserts on `baseClient`) | ✅ 9 failed (handler writes still on scoped repo) |
| §7 Unit (GREEN) | `vitest run src/services/auditLog` | ✅ 100 passed (3 files) |
| §7 Suite | `vitest run src/services/auditLog src/services/auth src/services/user/userRoleAssignment src/authorization` | ✅ 455 passed (24 files) |
| §7 Build | `pnpm build --filter @arcaai/applications` | ✅ 6 tasks successful |
| §7 Lint | `ReadLints` on `auditLog.service.ts` + test | ✅ 0 errors |

### 5.1 Live verification

```text
POST /api/v1/auth/login {"username":"super_admin","password":"password123"} → HTTP 200
{"user":{"id":"70000000-...-0001","roles":["SUPER_ADMIN"],...},"token":"eyJ..."}
```

Pre-fix the same request logged the tenant-scope throw and returned
`401 Authentication failed` (§1.1).

---

## 6. Change History

| Date | Description | Files modified |
|---|---|---|
| 2026-05-29 | Root-caused clean-boot login `401` to the tenant-scope `$extends` throwing on pre-auth `UserRoleAssignment` reads (scoped client, no tenant context). Routed the 3 auth-identity reads through the sanctioned `baseClient` bypass; +3 RED→GREEN invariant tests; URA+authz 169 green; applications build clean; login live-verified 200. | `userRoleAssignment.service.ts`, `userRoleAssignment.service.task307.test.ts`, `auth.controller.ts` |
| 2026-05-29 | **§7 sibling write-path fix.** `AuditLogService.handleUserAuthenticatedEvent` LOGIN/IMPERSONATION audit was silently dropped on tenant-less logins (tenant-scope `$extends` throws on the scoped `create`; caught/swallowed). Injected `CORE_DATABASE_SERVICE`; routed the audit `create` through the unscoped `baseClient` (tenantId already resolved by the factory to CLS tenant / `SYSTEM_TENANT_ID`). RED 9 failed → GREEN 100 passed (auditLog); auditLog+auth+URA+authz 455 green; applications build 6/6; lint 0. | `auditLog.service.ts`, `auditLog.service.test.ts` |

---

## 7. Sibling instance (auth-audit write path) — RESOLVED (2026-05-29)

After the §4 fix, login returns `200`, but the test-API log showed a **swallowed**
post-login error from the same defect family:

```text
ERROR [AuditLogService] Error handling user authenticated event
  eventType=user.authenticated  error=TenantScope: tenant context required for model AuditLog ...
```

### 7.1 Root cause (confirmed by reading the login flow)

`AuthService.trackAuthentication()` emits `EventTypes.UserAuthenticated`, which
`AuditLogService.handleUserAuthenticatedEvent()` handles by **creating a LOGIN /
IMPERSONATION `AuditLog`** (`AuditLog` is tenant-scoped, `TENANT_SCOPED_MODELS`).
`AuthController.login()` is a **public route** and never hydrates CLS with a
user/tenant (verified `apps/api/src/modules/auth/auth.controller.ts:99-212`), so
when the synchronous `@OnEvent` handler fires, CLS has `tenantId === undefined`
and `isSuperAdmin() === false`. The tenant-scope `$extends` `createHandler`
therefore **throws before the insert**, and the handler `catch` (line ~346)
swallows it → login stays `200`, but the **authentication audit row is silently
dropped** (HIPAA §164.312(b) gap). This affects every tenant-less login, not just
super-admin (the factory already resolves `tenantId` to `SYSTEM_TENANT_ID` when
CLS has none — TASK-305 A.8).

### 7.2 Fix

Route the audit `create` through the **unscoped `baseClient`** — the identical,
sanctioned escape hatch this ticket uses for the three identity *reads*. The
row's `tenantId` is already resolved by `AuditLogFactory` (CLS tenant, or
`SYSTEM_TENANT_ID` for tenant-less/system logins), so the tenant-scope filter
adds nothing; bypassing it is correct.

- `AuditLogService` now injects `CORE_DATABASE_SERVICE` and persists the auth
  audit via `databaseService.baseClient.auditLog.create({ data })`, building the
  payload with `AuditLogEntityMapper.getInstance().toPersistence(entity)` and a
  shallow null-strip (mirrors `Repository.create`'s `removeNullValues`, so
  Prisma's JSON columns accept the row). Authenticated emitters (e.g. the
  impersonation interceptor) are unaffected — their audit `tenantId` is already
  the caller's tenant, so the bypass is a no-op for attribution.

**Design decision (recorded):** system/super-admin (tenant-less) login audits are
stored under `SYSTEM_TENANT_ID`, consistent with TASK-305/313 and the existing
`AuditLogFactory` default. No CLS mutation was used (a transient `cls.set`
during the un-awaited handler would race the rest of `login()` — the explicit
`baseClient` write avoids that entirely).

### 7.3 Out of scope (unchanged)

- Storing a *tenant user's* login audit under **their** tenant (rather than
  `SYSTEM_TENANT_ID`) would require `login()` to hydrate CLS before emitting —
  a behaviour change beyond this fix; the factory's existing `?? SYSTEM_TENANT_ID`
  contract is preserved.

See §5 for §7 verification evidence (RED→GREEN, suite, build, lint).
