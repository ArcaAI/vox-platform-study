# TASK-340 — Impersonation must not block administration interfaces (admin-plane token routing)

| | |
|---|---|
| Ticket Number | TASK-340 |
| Created | 2026-06-08 |
| Updated | 2026-06-08 |
| Status | Completed |
| Type | Bug fix / Security |
| Scope | `@arcaai/vox` SDK (`AgenticClient`), `apps/ui-playground` admin HTTP client + auto-refresh |

---

## 1. Requirement Analysis

### 1.1 Description

When an administrator impersonates an end-user:

- **TENANT_ADMIN** impersonating an end-user in their own tenant, OR
- **SUPER_ADMIN / GLOBAL_ADMIN** impersonating an end-user in a selected tenant,

the admin can use the **playground** interfaces (as the end-user) but **cannot use any administration interfaces** — every `/admin/*` call returns **403 Forbidden**.

### 1.2 Business requirement

1. Playgrounds are accessible/functioning **as the end-user only** — the administrator must impersonate an end-user before using any playground feature. (Already correct.)
2. Impersonation **must not impact or prevent** administrators from accessing/using any administration interface/function/feature. (Currently broken.)

### 1.3 Acceptance criteria

1. While impersonating, a request to an **admin-plane** route (`/admin/*`) carries the **admin's own** JWT, so backend RBAC sees the admin's roles → admin interfaces work.
2. While impersonating, a request to a **user-plane** route (playground: `/consultations`, `/dna-writing-styles/*`, `/text/*`, `/user/me/*`, `/audio/pipelines` reads, …) carries the **impersonation** JWT → playground acts as the end-user (unchanged).
3. Holds for both the app admin HTTP client (`adminClient`) **and** SDK-backed admin screens (`useAuditLog`, `usePipelines`, `useGlobalSettings`, `useTenantFrontendConfig`, `useDnaDashboard`, …).
4. The admin token used for admin-plane requests stays **fresh** across token refresh during a long impersonation session.
5. When NOT impersonating, behavior is byte-for-byte unchanged.

---

## 2. Current State Evaluation (root cause)

Impersonation is a **global JWT token-swap**, applied to every outgoing request regardless of the endpoint plane:

- **Backend** `POST /auth/impersonate` mints a new JWT whose `roles`/`permissions`/`tenantId` are the **impersonated end-user's**; `impersonatedBy` is **audit-only** and never consulted by any guard. (`apps/api/src/modules/auth/auth.controller.ts`)
- **App** `adminClient.getEffectiveToken()` returns the impersonation token for **every** call, including `/admin/*`. (`apps/ui-playground/src/features/admin/api/admin-client.ts`)
- **SDK** `AgenticClient.accessToken` is replaced by the impersonation token (`updateAccessToken`), so every SDK hook sends it. (`packages/agentic-sdk-v2/src/core/AgenticClient.ts`)
- **Backend** `UnifiedAuthGuard` builds CASL ability from the **impersonated user's** roles → a doctor lacks `manage:Tenant` etc. → **403** on `/admin/*`. (`packages/applications/src/authorization/unified-auth.guard.ts`)

The backend RBAC is correct. The defect is **client-side**: the admin's own JWT is discarded for admin-plane requests during impersonation. Every 403-causing endpoint lives under `/admin/*` — the same signal the backend's `AuthorizationGuard` uses (`/^\/(api\/v\d+\/)?admin\//`). `/tenant/me/config` is `@Authorize()` (any authenticated user) so it never 403s and is intentionally left on the impersonation-aware path.

---

## 3. Implementation Plan (TDD)

| # | Unit | RED test | GREEN file(s) |
|---|---|---|---|
| 1 | `isAdminPlanePath(path)` helper (SDK) | SDK `constants` admin-plane test | `packages/agentic-sdk-v2/src/core/constants.ts` |
| 2 | SDK routes admin-plane requests to the stashed admin token | `AgenticClient` impersonation routing test | `packages/agentic-sdk-v2/src/core/AgenticClient.ts` |
| 3 | SDK keeps the stashed admin token fresh on refresh | (covered via method + app wiring) | `AgenticClient.updateImpersonationOriginalToken` |
| 4 | `adminClient` admin-plane → admin token, user-plane → impersonation token | `admin-client` admin-plane token test | `apps/ui-playground/src/features/admin/api/admin-client.ts` |
| 5 | Auto-refresh keeps SDK admin stash fresh during impersonation | (behavioral) | `apps/ui-playground/src/hooks/use-auto-refresh.ts` |

### 3.1 Design notes

- The app's vitest config **stubs** `@arcaai/vox`, so the app cannot import the helper from the SDK in tests. `isAdminPlanePath` is therefore defined **once in the SDK** and **mirrored locally** in `admin-client.ts` (tiny regex; documented on both sides).
- Tenant header is already compatible: TENANT_ADMIN impersonates only within their own tenant (`X-Tenant-Id` matches the admin JWT); SUPER_ADMIN's admin JWT carries an empty tenant so `X-Tenant-Id` hits the existing super-admin elevation path (`context.interceptor.ts`). No tenant-header change required.
- `smrClient` is unchanged — SMR is `/text/*` user-plane only and correctly acts as the impersonated user.

### 3.2 Verification commands

```
pnpm --filter @arcaai/vox test
pnpm --filter @arcaai/ui-playground test
pnpm build --filter @arcaai/vox
pnpm --filter @arcaai/ui-playground build
ReadLints on every modified file
```

---

## 4. Implementation Summary

Route-aware token selection so the active identity matches the endpoint plane during impersonation. No backend changes.

### 4.1 Files created

| Path | Purpose |
|---|---|
| `packages/agentic-sdk-v2/src/core/__tests__/AgenticClient.task340.test.ts` | SDK tests — `isAdminPlanePath` predicate + `AgenticClient` admin-plane token routing (admin token on `/admin/*`, impersonation token on user-plane, freshness via `updateImpersonationOriginalToken`, unchanged when not impersonating). |
| `apps/ui-playground/src/features/admin/api/__tests__/admin-client.task340.test.ts` | App tests — `adminClient` sends the admin token for `/admin/*` and the impersonation token for user-plane routes (incl. multipart upload) while impersonating. |
| `docs/implementation/TASK-340-Impersonation-Admin-Plane-Access/README.md` | This document. |

### 4.2 Files modified

| Path | Change |
|---|---|
| `packages/agentic-sdk-v2/src/core/constants.ts` | Added exported `isAdminPlanePath(path)` (mirrors the gateway's `/^\/(api\/v\d+\/)?admin\//`). |
| `packages/agentic-sdk-v2/src/core/AgenticClient.ts` | Added private `resolveAuthToken(endpoint)` — during impersonation, admin-plane routes use the stashed admin JWT (WeakMap), user-plane keep `accessToken`. Added public `updateImpersonationOriginalToken(token)` to refresh the stash in place (no-op when not impersonating). All four request methods (`requestWithMeta`, `getCsv`, `postFormData`, `uploadFormData`) now attach `resolveAuthToken(endpoint)`. |
| `apps/ui-playground/src/features/admin/api/admin-client.ts` | Added local `isAdminPlanePath` (the app's vitest stubs `@arcaai/vox`, so it cannot import the SDK helper under test). `getEffectiveToken(path)` returns the impersonation token only for non-admin-plane routes while impersonating; `getHeaders(path, options)` threads the path; `request`/`requestMultipart`/`stream` pass it. |
| `apps/ui-playground/src/hooks/use-auto-refresh.ts` | `syncListener` now mirrors a refreshed admin token into the SDK stash via `updateImpersonationOriginalToken` during impersonation (keeps admin-plane SDK requests on a fresh admin JWT); non-impersonating path unchanged. |
| `apps/ui-playground/src/hooks/__tests__/use-auto-refresh.impersonation.test.ts` | Mock client gains `updateImpersonationOriginalToken`; happy path asserts the refreshed admin token is mirrored into the stash. |

### 4.3 Why `smrClient` is unchanged

SMR endpoints are `/text/*` (user-plane) and summarization is a playground feature that must act as the impersonated user — its existing impersonation-token behavior is correct.

### 4.4 Tenant header compatibility (no change needed)

- TENANT_ADMIN impersonates only within their own tenant → `X-Tenant-Id` matches the admin JWT tenant.
- SUPER_ADMIN/GLOBAL_ADMIN carry an empty JWT tenant → `X-Tenant-Id` (selected tenant) hits the existing super-admin elevation path in `context.interceptor.ts`.

### 4.5 Verification (evidence)

```
# SDK — focused TASK-340 test
$ pnpm exec vitest run src/core/__tests__/AgenticClient.task340.test.ts   # cwd: packages/agentic-sdk-v2
  Test Files  1 passed (1)
       Tests  10 passed (10)

# SDK — full regression
$ pnpm test   # cwd: packages/agentic-sdk-v2
  Test Files  178 passed (178)
       Tests  3341 passed (3341)

# SDK build (publishes the new method into dist types)
$ pnpm build --filter @arcaai/vox
  Tasks: 6 successful, 6 total

# App — focused + impersonation-relevant areas
$ pnpm exec vitest run src/features/admin/api/__tests__/admin-client.task340.test.ts   # cwd: apps/ui-playground
  Test Files  1 passed (1)   Tests  4 passed (4)
$ pnpm exec vitest run src/features/admin src/features/summarization src/features/dna-writing-style \
    src/features/consultation src/hooks src/store src/lib
  Test Files  92 passed (92)
       Tests  817 passed (817)

# App production build (type-checks against new SDK dist types)
$ pnpm build   # cwd: apps/ui-playground
  ✓ built in 26.14s

# Lints — every modified file
ReadLints: No linter errors found.
```

---

## 5. Change History

| Date | Notes |
|---|---|
| 2026-06-08 | Created plan. Root cause confirmed across SDK, admin console, and backend. Approach approved: route-aware token selection in `adminClient` + SDK `AgenticClient`. |
| 2026-06-08 | Implemented under TDD (RED→GREEN). SDK `resolveAuthToken`/`updateImpersonationOriginalToken`, app `adminClient` path-aware token, auto-refresh stash freshness. All tests/builds/lints green (see §4.5). Status → Completed. |
