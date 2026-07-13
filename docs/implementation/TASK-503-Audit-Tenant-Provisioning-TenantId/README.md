# TASK-503 — AuditLogProcessor rejects tenant-provisioning jobs (tenantId null)

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | bugfix |
| **Area** | `@arcaai/applications` — `services/tenant`, `services/auditLog`, `services/sysEvent`, `common/base.service` |
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

## Enhancement / Improvement

- **Audit the other cross-tenant provisioning paths** that broadcast under an empty CLS tenant — the
  Tenant-created event itself, plus `tenant.service.ts` clone flows (AI models, ASR pipelines, global
  settings, tenant config). The single `clsService.set` in `create()` fixes all provisioning broadcasts
  in that call, but confirm no other global-admin cross-tenant mutation enqueues audit jobs with a null
  tenant (grep `broadcastSysEvent` reachable without an active CLS tenant).
- **Fix the misleading test mock convention**: several service tests hardcode `clsService.get → 'tenant-1'`,
  which masks null-CLS scenarios. Consider a shared helper that lets tests model the empty-CLS global-admin
  case explicitly.

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
