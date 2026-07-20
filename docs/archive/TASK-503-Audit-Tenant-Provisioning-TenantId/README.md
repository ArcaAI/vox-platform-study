# TASK-503 — AuditLogProcessor rejects tenant-provisioning jobs (tenantId null)

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | bugfix |
| **Area** | `@arcaai/applications` — `services/tenant`, `services/auditLog`, `services/sysEvent`, `common/base.service`; `apps/api` — `modules/auth/admin-impersonation.controller` |
| **Reported by** | Manual test — admin app, `super_admin`, issue #4 (queue failures) |
| **Related** | TASK-305 (audit-log fail-closed guard), TASK-306 P3.1/AC-10 (CLS-only tenant attribution), TASK-331 r2605 (default department provisioning) |

## Requirement Analysis

BullMQ `AuditLogProcessor` jobs fail with:
```
Error: AuditLogProcessor: job.data.tenantId is required
    at AuditLogProcessor.process (.../auditLog/auditLog.processor.ts:33)
```
for a Department `CREATE` whose payload has a real `data.tenantId` but a **null top-level `tenantId`**:
```json
{ "action": "CREATE", "resourceType": "Department",
  "data": { "tenantId": "019f5695-...-363f", "code": "GEN", "name": "General Practice" },
  "tenantId": null }
```

Requirement: audit-log jobs produced during tenant provisioning must carry the correct top-level
`tenantId` so they process successfully — **without weakening** the anti-spoofing invariant that top-level
tenant attribution comes only from trusted request context.

## Current State Evaluation

**Chain:**

- **Processor guard** — `services/auditLog/auditLog.processor.ts:29-34`: `tenantId` is destructured from
  `job.data` and fail-closed rejected if falsy. It never looks at `job.data.data.tenantId`. Deliberate
  (TASK-305 D.9.3) — do not loosen it.
- **Producer** — `services/sysEvent/sysEvent.service.ts` `buildAuditLogData()` forwards `event.tenantId`
  verbatim. The value is set one layer up.
- **Broadcast** — `common/base.service.ts` `broadcastSysEvent()`:
  ```ts
  this.eventEmitter.emit(type, { ...data, tenantId: this.tenantId, ... });
  ```
  `tenantId: this.tenantId` is placed **after** `...data`, so any `data.tenantId` is intentionally
  discarded (TASK-306 AC-10 anti-spoofing). `this.tenantId` = `clsService.get('tenantId') || null` — **CLS only**.
- **Why CLS is null here** — `services/tenant/tenant.service.ts` `create()` → `provisionDefaultDepartment(newTenantId)`
  builds the department bound to `newTenantId` (correct on the entity) and broadcasts `ResourceCreated`
  with `data: { tenantId: newTenantId, ... }`. But **tenant creation is a cross-tenant, global-admin
  operation performed before the new tenant is "active"** — CLS `tenantId` is empty for the whole call
  (`resolve-active-tenant.ts`: a global admin authenticates with an EMPTY CLS `tenantId`). `create()`
  never calls `clsService.set('tenantId', ...)`, so every `broadcastSysEvent` in it — the initial
  Tenant-created event **and** the default-department event — is stamped `tenantId: null`.

**Root cause (one sentence):** `TenantService.provisionDefaultDepartment()` (and the Tenant-created
event) broadcast for resources belonging to the newly-created tenant, but `broadcastSysEvent()`
overwrites the event's top-level `tenantId` with the CLS request-context tenant (deliberate
anti-spoofing) — and because tenant creation runs with no active CLS tenant, the job is enqueued with
`tenantId: null` and the fail-closed guard rejects it. Tenant provisioning is the one legitimate case
where CLS-tenant ≠ resource-tenant, and it was never given an escape hatch.

**Why tests missed it:** `services/tenant/__tests__/tenant.service.test.ts` mocks
`clsService.get('tenantId')` to always return `'tenant-1'`, so the emitted event is never null in tests.
There is no `describe('provisionDefaultDepartment')` block.

## Implementation Plan

Chosen fix: **(b) rebind CLS `tenantId` at the `TenantService.create()` call site.** It touches the one
place that actually knows the legitimate tenant, changes nothing in the security-sensitive
`broadcastSysEvent` invariant, and matches the existing convention every processor/guard already uses
for "operate on behalf of a tenant CLS doesn't know."

Rejected alternatives:
- (a) processor falls back to `data.tenantId` — reintroduces the exact spoofing risk TASK-306 AC-10
  removed; `data` is an untyped caller-populated blob.
- (c) processor derives tenantId per `resourceType` — doesn't generalize (Tenant, cloned AI models,
  ASR pipelines, tenant configs all share the gap) and spreads tenant resolution into the queue worker.

Steps:

1. **Failing test (RED)** — `services/tenant/__tests__/tenant.service.test.ts`: add a
   `describe('provisionDefaultDepartment / tenant-created audit attribution')` that mocks
   `clsService.get('tenantId')` to return **null** (the real global-admin-creating-a-tenant case) and
   asserts the emitted `ResourceCreated` events (Tenant + Department) carry
   `tenantId === <new tenant id>`, not null. Also assert `clsService.set` is called with the new tenant id.

2. **Fix** — `services/tenant/tenant.service.ts` `create()`: immediately after the new tenant id is
   known (before the first `broadcastSysEvent`, ≈ line 115), call
   `this.clsService.set('tenantId', tenant.id)`. Every subsequent provisioning broadcast in the call
   then resolves `this.tenantId` to the new tenant. Scope the set to the create flow; do not leak it
   beyond the request (CLS is request-scoped, so this is safe).

3. **Regression coverage** — optional: a producer-chain test in
   `services/sysEvent/__tests__/sysEvent.service.test.ts` (or an integration test) asserting the enqueued
   `AuditLogJob.tenantId` is non-null for a provisioning-originated event, so the gap can't reopen.

### File change order
1. `services/tenant/__tests__/tenant.service.test.ts` (RED — model null CLS)
2. `services/tenant/tenant.service.ts` (`clsService.set` in `create()`)

## Enhancement / Improvement (folded into scope — see Round 2 below)

- ~~Audit the other cross-tenant provisioning paths that broadcast under an empty CLS tenant~~ — done via
  the `BaseService.broadcastSysEvent()` SYSTEM-tenant fallback (Round 2), which covers every service, not
  just `tenant.service.ts`'s clone flows.
- **Fix the misleading test mock convention**: several service tests hardcode `clsService.get → 'tenant-1'`
  (or, in the impersonation controllers, `?? null` as the "no tenant" sentinel instead of the real
  empty-string JWT shape), which masks null/empty-CLS scenarios. Still open — no shared helper introduced
  yet; each Round 2 test fixed its scenario locally instead.

## Round 2 — broader null/empty-CLS-tenant gap (found in manual testing after Round 1 shipped)

Manual testing surfaced two MORE code paths producing the same `AuditLogProcessor: job.data.tenantId is
required` failure, neither touched by the Round 1 fix (which only rebinds CLS inside
`TenantService.create()`):

1. **`UserSettingsService.upsertByUserKeyNamespace()`** (self-service `ui.data-grid` layout save) — a
   GLOBAL_ADMIN browsing the cross-tenant Audit Logs grid with **no working tenant selected** has an empty
   CLS `tenantId` (their JWT carries `tenantId: ''`, per `resolve-active-tenant.ts` — never `null`).
   `UserSettings` genuinely has no `tenantId` column (`packages/database/.../user.prisma:118-148`) — it's a
   per-user, not tenant-scoped, resource. `BaseService.broadcastSysEvent()` stamped `tenantId: this.tenantId`
   → `null`, and the processor rejected it.

   **Fix:** `common/base.service.ts` `broadcastSysEvent()` now falls back to the reserved SYSTEM tenant
   (`00000000-0000-0000-0000-000000000000`) when CLS has no tenant: `tenantId: this.tenantId ?? SYSTEM_TENANT_ID`.
   This is the exact convention already used by `AuditLogService` for pre-CLS LOGIN/IMPERSONATION events
   (TASK-305 A.8, `auditLog.service.ts:552,628`) — generalized to every `BaseService` subclass. The
   anti-spoofing invariant (TASK-306 AC-10) is unchanged: `payload.tenantId` is still never read; only the
   fallback destination changed (`null` → SYSTEM), and the fallback is a fixed system constant, never
   caller-supplied.

2. **`AdminImpersonationController.impersonate()`** (`apps/api/src/modules/auth/admin-impersonation.controller.ts:267`)
   — the forced `USER_IMPERSONATION_STARTED` audit row used `this.clsService.get('tenantId') ?? resolvedTenantId`.
   The comment correctly identified the problem ("a global-admin's CLS tenant is usually null... row is
   attributed to the RESOLVED impersonation tenant") but used `??` (nullish coalescing), which only falls
   back on `null`/`undefined` — not on the real value, an **empty string**. `'' ?? resolvedTenantId`
   evaluates to `''`, not `resolvedTenantId`. Existing tests never caught it because the test harness
   modeled "no tenant" as `null` (`opts.user?.tenantId ?? null`), not the real `''` JWT shape — the same
   "tests missed it" pattern as Round 1.

   **Fix:** `??` → `||` on that one line, so any falsy CLS value (not just null/undefined) triggers the
   fallback.

   `AuthController.revokeImpersonation()` has the identical `??` pattern (`auth.controller.ts:972,978`) but
   was left untouched — its comment states the impersonation JWT always carries a real resolved tenant for
   that call path (verified: the impersonation token is always minted with a concrete `resolvedTenantId`,
   never empty), so there's no reproducible failing scenario there and no test to drive a TDD change.

### Files changed (Round 2)
- `packages/applications/src/common/base.service.ts` — SYSTEM-tenant fallback in `broadcastSysEvent()`.
- `packages/applications/src/common/__tests__/base.service.test.ts` — updated the existing
  `emits tenantId=null when CLS is absent` test to assert the SYSTEM-tenant fallback instead.
- `apps/api/src/modules/auth/admin-impersonation.controller.ts` — `??` → `||` for the forced audit row's
  `tenantId`.
- `apps/api/src/modules/auth/__tests__/admin-impersonation.controller.task401.test.ts` — new test:
  `falls back to the resolved tenant when CLS tenantId is empty string (real global-admin JWT shape)`.

### Round 2 verification
- Both new/changed tests watched RED (asserted `null`/`''` before the fix) → GREEN after.
- `pnpm --filter @arcaai/applications build test`: 6237 passed, 4 skipped, 0 failed. `tsc` clean.
- `pnpm --filter @arcaai/api build test`: target files green; one pre-existing, unrelated failure
  (`src/__tests__/env-port-standardization.test.ts`) reproduced identically on a stashed baseline
  (confirmed NOT caused by this change) — out of scope for TASK-503.
- Lint clean on both packages.
- Manual live-stack re-verification of the original two failure payloads (UserSettings grid save,
  impersonation-start audit row) — not run; deferred to manual QA alongside the Round 1 item below.

## Verification Criteria

- [x] New test fails before the fix (events stamped null), passes after (stamped new tenant id) — watched RED→GREEN.
- [x] `pnpm --filter @arcaai/applications build test` green.
- [ ] Manual: create a tenant as global admin → the default-department + tenant-created audit jobs complete (no "tenantId is required" in the queue), and the audit rows carry the new tenant id. (not run — needs a live stack; deferred to manual QA)

## Implementation Summary

Added `this.clsService.set('tenantId', tenant.id)` in `TenantService.create()` (`packages/applications/src/services/tenant/tenant.service.ts`), immediately after the new tenant row is persisted and before the first `broadcastSysEvent`. CLS is request-scoped, so the rebind is safe and every provisioning broadcast for the rest of the call (Tenant-created, default-department-created, and any future provisioning event) now resolves `this.tenantId` to the new tenant instead of the empty global-admin CLS context. `broadcastSysEvent()`'s CLS-only anti-spoofing invariant (TASK-306 AC-10) is untouched.

New RED test: `provisionDefaultDepartment / tenant-created audit attribution (TASK-503)` in `services/tenant/__tests__/tenant.service.test.ts` — models the real global-admin-creating-a-tenant case with a stateful CLS mock (`get('tenantId')` starts `null`, reflects `set` calls), asserts `clsService.set('tenantId', <new tenant id>)` is called and that both the Tenant-created and Department-created `ResourceCreated` broadcasts carry the new tenant id, not `null`. Watched fail (0 calls to `clsService.set`) before the fix, pass after.

Files changed:
- `packages/applications/src/services/tenant/tenant.service.ts` — fix.
- `packages/applications/src/services/tenant/__tests__/tenant.service.test.ts` — new test.

Full `@arcaai/applications` suite: 6107 passed, 4 skipped, 0 failed (no regressions). Build: `tsc` clean.

## Change History

| Date | Change |
|---|---|
| 2026-07-12 | Ticket created from manual-test issue #4. Root cause: tenant provisioning broadcasts with empty CLS tenant while `broadcastSysEvent` forces CLS-only attribution. Fix (b) chosen: `clsService.set('tenantId', tenant.id)` in `TenantService.create()`. |
| 2026-07-12 | Implemented fix (b) via TDD: RED test added, `clsService.set` rebind added to `create()`, GREEN confirmed, full suite + build green. Status → Review. Manual live-stack verification and the "audit other cross-tenant provisioning paths" enhancement item are outstanding. |
| 2026-07-13 | Round 2: manual live-stack testing surfaced two more null/empty-CLS-tenant failures outside Round 1's scope (`UserSettingsService` self-service save by an unscoped global admin; `AdminImpersonationController`'s forced audit row). User chose to expand TASK-503 rather than open a new ticket. Fixed via (1) `BaseService.broadcastSysEvent()` SYSTEM-tenant fallback (generalizes the existing `AuditLogService` TASK-305 A.8 convention to every service) and (2) a `??`→`\|\|` correctness fix in `admin-impersonation.controller.ts` (empty-string CLS values were slipping past nullish coalescing). Both via TDD, RED→GREEN watched. One pre-existing, unrelated `apps/api` test failure identified and confirmed not caused by this change. |
