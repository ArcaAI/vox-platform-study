# TASK-1041 — Tenant lock read 503s on internal calls (no CLS tenant)

| Field | Value |
|---|---|
| Status | Pending — plan awaiting owner decision |
| Type | bugfix |
| Branch | `agent/interesting-turing-c56b77` (worktree) → merge target to be confirmed (`dev-2.2` assumed) |
| Found by | TASK-1036 e2e triage; reproduced live on the test API |

## Requirement Analysis

On `/api/v1/internal/*` the global `TenantLockGuard` (`apps/api/src/guards/tenant-lock.guard.ts`)
takes the tenant from `X-Tenant-Id`, because those routes are `@Public()` and no CLS tenant exists
yet. It then reads the lock state (`TenantLockService.state` → `TenantCheckpointRestoreRepository.findActiveByTenant`).
`TenantCheckpointRestore` is in `TENANT_SCOPED_MODELS`, and the request's CLS is ACTIVE but carries
no tenant and no elevated role, so the tenant-scope extension throws
`TenantScope: tenant context required …` (`packages/database/src/extensions/tenant-scope.ts` ~L690).
`assertTenantNotLocked` turns that into 503 `TENANT_LOCK_UNAVAILABLE`.

Repro: cold lock cache → `GET /api/v1/internal/agents/resolve` with the harness service token +
`X-Tenant-Id: 50000000-…` → 503. Same tenant through an admin route → 200 (CLS tenant set by
`UnifiedAuthGuard`). Breaks `apps/api/tests/e2e/task-890-agent-resolve-fail-closed.spec.ts` and every
internal call carrying `X-Tenant-Id` (incl. TASK-1036/1038 `POST internal/consultations/:id/read`,
`GET internal/agents/:slug/versions/:n/resolved`). It only "works" when another request on the same
node warmed the 5 s cache for that tenant.

Must hold after the fix:
1. Cold cache + internal path + `X-Tenant-Id` → the lock state is read under THAT tenant; no 503 when unlocked.
2. A genuinely unreadable lock (DB/repository error) still fails closed: 503 `TENANT_LOCK_UNAVAILABLE` (+ `Retry-After` on internal).
3. The tenant set for the lock read must not leak into the request's CLS (handlers pin their own tenant via `cls.run`).
4. Locked-tenant behaviour (423 user / 503 internal, category rules) unchanged.

## Current State Evaluation

| Caller of `lock.state` | Context | Affected? |
|---|---|---|
| `TenantLockGuard` (global, HTTP) | CLS active, tenant from header on internal paths | **Yes — the reported defect** |
| `InternalTenantLockGuard` (harness + STT internal controllers, mutating calls) | CLS active, no tenant; reads `x-internal-tenant-id` / `x-tenant-id` / query / body | **Yes, latent** — masked only when the global guard has just warmed the cache for the same tenant; a body-only tenant always hits it cold |
| `stt-ws.gateway.ts:1001` (WS open) | CLS state on WS unverified | Possibly |
| BullMQ processors (`postponeIfTenantLocked`) | CLS inactive → extension treats as elevated pass-through | No |

`findActiveByTenant(tenantId)` already filters by the explicit `tenantId`, so the scoped read is
purely about satisfying the extension — no widening is needed.

## Implementation Plan

### Recommended (Option A) — the lock SERVICE scopes its own read

`TenantLockService.read(tenantId)` runs `findActiveByTenant` inside `cls.run(() => { cls.set('tenantId', tenantId); … })`.
One change covers both guards, the WS gateway and any future caller; the service already owns the
"read lock state for tenant X" contract, so it should not depend on the caller's ambient CLS.
`cls.run` (nestjs-cls 6, default `ifNested: 'inherit'`) gives a child store, so the tenant does not
leak into the request. `ClsService` is injected `@Optional()`; when absent (non-Nest callers) behaviour
is unchanged. Errors still propagate → `assertTenantNotLocked` still answers 503.

### Alternatives considered

- **B — fix in each guard** (`cls.run` around `assertTenantNotLocked` in both guards). Matches the
  brief literally but duplicates the fix in two places and leaves the WS caller exposed.
- **C — sanctioned base client** (`CoreDatabaseService.baseClient`, unscoped). Rejected: it bypasses
  BOTH the tenant scope and the soft-delete filter, the repository would need a second unscoped path,
  and the read already names its tenant — scoping is the correct, not the expensive, answer.

### TDD test list (RED first)

1. `apps/api/src/guards/__tests__/tenant-lock.guard.task1041.test.ts`
   - guard + real `TenantLockService` + real `ClsService` (active request store, no tenant) + fake repository
     that records `cls.get('tenantId')` at call time and throws the extension's error when it is absent:
     internal path + `X-Tenant-Id: T` + cold cache → resolves `true`, repository saw tenant `T`. (RED today: 503.)
   - after the guard returns, the request store's `tenantId` is still unset (no leak).
   - repository rejects with a DB error → 503 `TENANT_LOCK_UNAVAILABLE` + `Retry-After: 30` (fail-closed kept).
   - locked CLINICAL restore → 503 `TENANT_RESTORE_IN_PROGRESS` (unchanged).
2. Same shape for `InternalTenantLockGuard` (POST, tenant in body, cold cache) → passes; unreadable → 503.
3. `tenant-lock.service` unit test: `read` runs under the requested tenant; works without `ClsService`.

### Files

| File | Change |
|---|---|
| `packages/applications/src/services/tenant-checkpoint/lock/tenant-lock.service.ts` | `@Optional() ClsService`; scoped read |
| `packages/applications/src/services/tenant-checkpoint/lock/__tests__/…` | service test |
| `apps/api/src/guards/__tests__/tenant-lock.guard.task1041.test.ts` | new |
| `apps/api/src/guards/__tests__/internal-tenant-lock.guard.test.ts` | add cold-cache case |
| `apps/api/src/guards/tenant-lock.guard.ts` | doc comment only (states the read is service-scoped) |

### Verification

- `pnpm --filter @arcaai/applications build` + the new unit tests; `pnpm test:unit` filtered to the guard files.
- `pnpm api:build`; `pnpm lint` on touched packages.
- Live: `pnpm test:up:api`, then `RESET_DB=false npx dotenv -e .env.test -- npx playwright test task-890-agent-resolve-fail-closed`
  (before: fails on the 503; after: green), plus a curl of `GET /api/v1/internal/agents/resolve` on a freshly started API (cold cache) → not 503.

## Owner decisions

| # | Decision | Recommendation |
|---|---|---|
| OD-1 | Ticket number TASK-1041 | Accept |
| OD-2 | Where to fix: A (service scopes its read) / B (each guard) / C (unscoped base client) | **A** |
| OD-3 | Include the latent `InternalTenantLockGuard` cold-cache case in this ticket | Yes (covered by A at no extra code) |
| OD-4 | Observation, out of scope: the global guard reads lock state for any `X-Tenant-Id` on `/internal/*` BEFORE the controller's service-token guard runs, so an unauthenticated caller can probe "is tenant X locked" (503 vs pass-through). Pre-existing. | Spin off a separate ticket |
| OD-5 | Merge target | `dev-2.2` |

## Implementation Summary

_Pending go._

## Change History

| Date | Change |
|---|---|
| 2026-10-05 | Ticket created; plan + owner decisions drafted |
