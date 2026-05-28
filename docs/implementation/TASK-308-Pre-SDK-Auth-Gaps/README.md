# TASK-308 — Pre-SDK Auth Gaps (same-tenant cross-user DoS + throttle granularity)

| Field | Value |
|---|---|
| **Ticket** | TASK-308-Pre-SDK-Auth-Gaps |
| **Created** | 2026-05-28 |
| **Updated** | 2026-05-28 |
| **Status** | `Pending` |
| **Classification** | Bugfix (authorization gap) + refactor (throttle granularity) |
| **Priority** | High — exploitable from any authenticated same-tenant user; gates clean SDK rollout for multi-user-per-tenant deployments |
| **Source** | TASK-307 §10.1 deferrals W7.A.12 + E-4 |
| **Audit refs** | C-4 (Consultation Job ownership) — same-tenant gap; E-4 (`AuthController` class-wide throttle) |
| **Base branch** | `fix/2605-review` (HEAD `2a1ee7be` — TASK-307 closed) |

---

## 1. Requirement Analysis

### 1.1 Description

TASK-307 closed cross-**tenant** ownership gaps via `@TenantOwnedResource` (W3 merge `d969b25c`). The remaining gap is intra-tenant — a same-tenant cross-user request still passes `@TenantOwnedResource`. For `ConsultationJob`, a clinician can cancel another clinician's job by guessing the `jobId`. The SDK actively exposes this surface because consultation rooms have multiple users per tenant.

Separately, `AuthController` carries a class-wide `@Throttle({ default: { limit: 10, ttl: 60000 } })`. The SDK aggressively refreshes tokens and polls `/auth/me`, so legitimate refresh attempts get throttled together with idle `/me` checks. Endpoints need per-endpoint limits (strict on `login`/`refresh`, default on `/me`/`/logout`/`/stream-ticket`).

### 1.2 Business context

The SDK (`@arcaai/vox`) drives consultation rooms where multiple authenticated users coexist within one tenant. Without intra-tenant scoping on mutating `ConsultationJob` operations, any logged-in user can stop another's consultation. This is a **real, authenticated insider exploit** — not a hypothetical cross-tenant probe.

Throttle granularity is a UX issue, not a security one — but tight SDK refresh patterns will trip the current class-wide limit and surface as "Rate limited" errors in production.

### 1.3 Acceptance criteria

- **AC-1** `@TenantOwnedResource` gains a `scope: 'creator'` option that, when set, additionally checks `entity.createdByUserId === cls.get('userId')` after the tenant check. 404 (not 403) on mismatch.
- **AC-2** `ConsultationJobController` mutating routes (`cancel`, any future `delete` / `update`) use `@TenantOwnedResource('jobId', { scope: 'creator' })`. Read routes (`getStatus`) keep tenant-only scope (different users may legitimately read jobs they didn't start, e.g., shared room).
- **AC-3** New unit tests on the interceptor: same-tenant same-user → 200; same-tenant different-user → 404; cross-tenant → 404.
- **AC-4** New E2E test: tenant-A user-1 cancels their own job → 200; tenant-A user-2 attempts cancel → 404; tenant-B user → 404.
- **AC-5** `AuthController` throttle decorator moved from class to per-endpoint:
  - `login` → `@Throttle({ default: { limit: 5, ttl: 60000 } })` (5/min, defends against credential stuffing)
  - `refresh` → `@Throttle({ default: { limit: 60, ttl: 60000 } })` (60/min, allows aggressive SDK token rotation)
  - `/me`, `/logout`, `/stream-ticket` → default app-wide throttle (no per-endpoint decorator)
  - `impersonate` → kept stricter, `@Throttle({ default: { limit: 10, ttl: 60000 } })`
- **AC-6** E2E test for AC-5: 6th `login` attempt within 1 minute → 429; 61st `refresh` within 1 minute → 429; concurrent `refresh` + `/me` polling doesn't trip either limit.

### 1.4 Out of scope

- Cross-user roles/policies (CASL) — already handled by existing `@RequiresPermissions` decorator.
- Cross-tenant ownership — already closed by TASK-307 W3.
- Per-tenant rate limiting (F-2 / D-9) — separate ticket (TASK-302 family).

---

## 2. Current State Evaluation

### 2.1 Existing code

- `apps/api/src/common/tenant-owned-resource.decorator.ts` + `tenant-owned-resource.interceptor.ts` (TASK-307 W3)
- `apps/api/src/modules/consultation/consultation-job.controller.ts` — `cancel` route uses `@TenantOwnedResource('jobId')` (tenant-only today)
- `packages/applications/src/services/consultation/jobs/dto/job.dto.ts` — `ConsultationJobStatus` already carries `userId` + `tenantId` (TASK-307 W3.3)
- `apps/api/src/modules/auth/auth.controller.ts` — class-decorated with `@Throttle(...)`
- `apps/api/src/modules/auth/__tests__/auth.controller.throttle.test.ts` (if exists; verify during planning)

### 2.2 Dependencies / impact areas

- The `scope` option on `@TenantOwnedResource` is a **non-breaking** extension; existing call-sites continue to work without changes.
- `ConsultationJobStatus.userId` is already present (TASK-307 W3.3) → AC-3/AC-4 have the data they need.
- Throttle granularity changes do not affect the throttle storage backend.

### 2.3 Risk

- Pre-W7.A.12 Redis ConsultationJobStatus rows that lack `userId` (the 24h release-window risk documented in TASK-307 §7) will 404 on `cancel` even for the legitimate owner during the JOB_TTL window. Mitigation: deploy this ticket ≥ JOB_TTL (24h) after TASK-307 W3 hits production.

---

## 3. Implementation Plan

### 3.1 Phase order

1. Extend `@TenantOwnedResource` with `scope: 'tenant' | 'creator'` option (default `'tenant'`).
2. Update `TenantOwnedResourceInterceptor` to perform the additional `userId` check when `scope === 'creator'`.
3. Unit tests for the interceptor (AC-3).
4. Apply `scope: 'creator'` to `ConsultationJobController.cancel` (and any future mutating routes).
5. E2E test for AC-4.
6. Move `AuthController` throttle from class to per-endpoint (AC-5).
7. E2E test for AC-6.

### 3.2 Testing

| Layer | Test |
|---|---|
| Unit | `tenant-owned-resource.interceptor.test.ts` — adds 3 cases for `scope: 'creator'` |
| Unit | `auth.controller.throttle.test.ts` — adds per-endpoint metadata assertions |
| E2E | `consultation-job-cross-user.spec.ts` (NEW) |
| E2E | `auth-throttle-per-endpoint.spec.ts` (NEW or extend existing) |

### 3.3 Estimated scope

- **AC-1 + AC-2 + AC-3 + AC-4**: M (4–6h)
- **AC-5 + AC-6**: S (1–2h)
- **Total**: M

---

## 4. Implementation Summary
*(to be filled in at close-out)*

---

## 5. Change History

| Date | Description | Files modified |
|---|---|---|
| 2026-05-28 | Ticket created from TASK-307 §10.1 deferrals (W7.A.12 + E-4) | — |
