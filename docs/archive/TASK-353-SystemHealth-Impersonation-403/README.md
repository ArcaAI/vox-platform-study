# TASK-353 — 403 on /admin/system-health while impersonating (non-/admin admin-only token routing)

| | |
|---|---|
| Ticket Number | TASK-353 |
| Created | 2026-06-11 |
| Updated | 2026-06-11 |
| Status | Completed |
| Type | Bug fix |
| Scope | `@arcaai/vox` SDK (`constants.isAdminPlanePath`), `apps/ui-playground` admin HTTP client |

---

## 1. Requirement Analysis

### 1.1 Description

After impersonating a doctor user, navigating back to `/admin/system-health` shows 403 errors. The page itself renders (the client-side `RequireGlobalScope` guard checks the admin's own roles), but every data call fails with **403 Forbidden**.

### 1.2 Acceptance criteria

1. While impersonating, the System Health page (`/monitoring/uptime`, `/monitoring/sessions`, `/health/services`) carries the **admin's own** JWT and works.
2. Unrestricted health probes (`/health`, `/health/live`, `/health/ready`) and all user-plane routes keep the impersonation JWT (unchanged).
3. When NOT impersonating, behavior is byte-for-byte unchanged.

---

## 2. Current State Evaluation (root cause)

TASK-340 introduced route-aware token selection during impersonation: paths matching `isAdminPlanePath` (`/^\/?(?:api\/v\d+\/)?admin\//`) carry the admin's own JWT; everything else carries the impersonation JWT. The predicate exists in two mirrored places:

- `apps/ui-playground/src/features/admin/api/admin-client.ts` (local copy — the app's vitest config stubs `@arcaai/vox`)
- `packages/agentic-sdk-v2/src/core/constants.ts` (used by `AgenticClient.resolveAuthToken`)

However, TASK-336 OB-12 gated three surfaces behind `@Authorize(['manage', 'all'])` that do **not** live under the `/admin/` prefix:

| Endpoint | Controller | Predicate match (before) |
|---|---|---|
| `GET /monitoring/uptime`, `/monitoring/sessions`, `/monitoring/uptime/:service`, `/monitoring/heartbeats/:service` | `@Controller('monitoring')` — class-level `manage:all` | No |
| `GET /health/services`, `/health/services/:serviceKey` | `@Controller('health')` — method-level `manage:all` | No |

The System Health page calls exactly these endpoints via `adminClient`. While `isImpersonating` is true, the doctor's JWT was sent; the doctor lacks `manage:all`, so the CASL `AuthorizationGuard` returned 403. The 401 auto-recovery path (`endImpersonationWithNotice`) never fires for a 403.

A scan of all `@Authorize(['manage', 'all'])` controllers confirmed `/monitoring/*` and `/health/services[/:serviceKey]` are the only admin-only surfaces outside the `/admin/` prefix (rate-limit, queues, schedulers, pstudio are all `/admin/*`).

Backend RBAC is correct — no backend changes.

---

## 3. Implementation Plan (TDD)

| # | Unit | RED test | GREEN file(s) |
|---|---|---|---|
| 1 | SDK predicate + `AgenticClient` routing for `/monitoring/*`, `/health/services` | `AgenticClient.task353.test.ts` | `packages/agentic-sdk-v2/src/core/constants.ts` |
| 2 | `adminClient` routing for the same paths | `admin-client.task353.test.ts` | `apps/ui-playground/src/features/admin/api/admin-client.ts` |

New predicate (both copies):

```
/^\/?(?:api\/v\d+\/)?(?:admin\/|monitoring\/|health\/services(?:[/?]|$))/
```

`health\/services(?:[/?]|$)` matches `/health/services`, `/health/services/smr` and `/health/services?x=1` but NOT `/health/live`, `/health/ready` or look-alikes like `/health/servicesque`.

---

## 4. Implementation Summary

### 4.1 Files created

| Path | Purpose |
|---|---|
| `packages/agentic-sdk-v2/src/core/__tests__/AgenticClient.task353.test.ts` | SDK tests — predicate coverage for `/monitoring/*` + `/health/services[...]` (incl. negatives for `/health/live` etc.) and `AgenticClient` token routing during impersonation. |
| `apps/ui-playground/src/features/admin/api/__tests__/admin-client.task353.test.ts` | App tests — `adminClient` sends the admin token for the three system-health endpoints while impersonating; user-plane and non-impersonating behavior unchanged. |
| `docs/implementation/TASK-353-SystemHealth-Impersonation-403/README.md` | This document. |

### 4.2 Files modified

| Path | Change |
|---|---|
| `packages/agentic-sdk-v2/src/core/constants.ts` | `isAdminPlanePath` regex extended with `monitoring\/` and `health\/services(?:[/?]|$)` alternatives; doc comment updated. |
| `apps/ui-playground/src/features/admin/api/admin-client.ts` | Same regex extension in the mirrored local predicate; doc comment updated. |

### 4.3 Verification (evidence)

```
# SDK — focused TASK-353 + TASK-340 tests
$ pnpm exec vitest run src/core/__tests__/AgenticClient.task353.test.ts src/core/__tests__/AgenticClient.task340.test.ts
  Test Files  2 passed (2)    Tests  17 passed (17)

# SDK — full regression
$ pnpm test   # cwd: packages/agentic-sdk-v2
  Test Files  179 passed (179)    Tests  3356 passed (3356)

# App — full regression
$ pnpm test   # cwd: apps/ui-playground
  Test Files  153 passed (153)    Tests  1301 passed (1301)

# Builds
$ pnpm build --filter @arcaai/vox     → Tasks: 6 successful, 6 total
$ pnpm build   # cwd: apps/ui-playground → ✓ built in 35.37s

# Lints — every created/modified file
ReadLints: No linter errors found.
```

RED was observed before GREEN: 4 SDK + 3 app assertions failed with `expected 'Bearer impersonation-…' to be 'Bearer admin-…'`.

---

## 5. Change History

| Date | Notes |
|---|---|
| 2026-06-11 | Root cause identified (TASK-340 predicate misses non-/admin `manage:all` surfaces). Fix approved as TASK-353. Implemented under TDD (RED→GREEN); all tests/builds/lints green. Status → Completed. |
