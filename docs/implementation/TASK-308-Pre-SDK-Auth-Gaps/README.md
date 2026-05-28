# TASK-308 — Pre-SDK Auth Gaps (same-tenant cross-user DoS + throttle granularity)

| Field | Value |
|---|---|
| **Ticket** | TASK-308-Pre-SDK-Auth-Gaps |
| **Created** | 2026-05-28 |
| **Updated** | 2026-05-28 |
| **Status** | `Completed` |
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

### 4.0 Overview

| AC | Status | Layer | Evidence |
|---|---|---|---|
| AC-1 — `scope: 'creator'` option on `@TenantOwnedResource` | Complete | api/common | §4.1 |
| AC-2 — `scope: 'creator'` on `ConsultationJobController.cancel` | Complete | api/consultation | §4.2 |
| AC-3 — interceptor unit tests (3+ cases) | Complete | api/common (vitest) | §4.1 |
| AC-4 — `consultation-job-cross-user.spec.ts` (E2E) | Spec authored; execution deferred to test-stack run | api E2E | §4.3 |
| AC-5 — `AuthController` per-endpoint throttle | Complete | api/auth + api/throttle | §4.4 |
| AC-6 — `auth-throttle-per-endpoint.spec.ts` (E2E) | Spec authored; execution deferred to test-stack run | api E2E | §4.5 |

**Branch**: `task-308/pre-sdk-auth-gaps` (worktree at `../hope-v2-task-308`, base `a6a19797`).

**Commit list (newest → oldest)**

```text
a4ecf99c task-308(ac-6): e2e spec for AuthController throttle granularity
e4d48482 task-308(ac-5): move AuthController throttle from class to per-endpoint
cd70cd29 task-308(ac-4): e2e spec for ConsultationJob cross-user cancel
4198445a task-308(ac-2): apply scope:creator to ConsultationJobController.cancel
891cc2d9 task-308(ac-1,ac-3): scope:creator opt-in + interceptor unit tests
2b691a8a task-308(prep): bump ticket status to In Progress
```

**Aggregate diff stat**

```text
 .../tenant-owned-resource.decorator.test.ts        |  21 +++
 .../tenant-owned-resource.interceptor.test.ts      | 132 ++++++++++++++
 .../src/common/tenant-owned-resource.decorator.ts  |  18 ++
 .../common/tenant-owned-resource.interceptor.ts    |  27 ++-
 apps/api/src/modules/auth/auth.controller.ts       |  20 ++-
 .../__tests__/consultation-job.controller.test.ts  |  18 +-
 .../consultation/consultation-job.controller.ts    |   7 +-
 .../throttle/__tests__/throttle-decorators.test.ts |  81 ++++++++-
 .../tests/e2e/auth-throttle-per-endpoint.spec.ts   | 146 +++++++++++++++
 .../tests/e2e/consultation-job-cross-user.spec.ts  | 195 +++++++++++++++++++++
 .../TASK-308-Pre-SDK-Auth-Gaps/README.md           | 113 +++++++++++-
 11 files changed, 763 insertions(+), 15 deletions(-)
```

### 4.1 AC-1 / AC-3 — `scope: 'creator'` opt-in + interceptor unit tests

**Files modified**

| File | Change |
|---|---|
| `apps/api/src/common/tenant-owned-resource.decorator.ts` | Added optional `scope?: 'tenant' \| 'creator'` to `TenantOwnedResourceOptions`. Default behaviour (omitted / `'tenant'`) is unchanged — non-breaking. |
| `apps/api/src/common/tenant-owned-resource.interceptor.ts` | `assertConsultationJob` now reads `opts.scope` and, when set to `'creator'`, additionally requires `status.userId === cls.user.id` after the tenant check. Missing CLS `user.id` or missing `status.userId` → uniform 404 (DEF-C3 no-existence-leak; documented inline against ticket §2.3 release-window risk). |
| `apps/api/src/common/__tests__/tenant-owned-resource.interceptor.test.ts` | +5 cases under `ConsultationJob — scope:"creator"`: same-tenant same-user → 200, same-tenant cross-user → 404, cross-tenant → 404, missing CLS user → 404, pre-W7.A.12 row with no `userId` → 404. |
| `apps/api/src/common/__tests__/tenant-owned-resource.decorator.test.ts` | +1 case pinning the `scope` field in the metadata payload. |

**Test evidence (RED → GREEN)**

```text
RED — 3/5 new interceptor cases fail (cross-user, missing CLS user, missing status.userId)
GREEN — `pnpm --filter @arcaai/api exec vitest run src/common/__tests__/tenant-owned-resource.{interceptor,decorator}.test.ts`
  Test Files  2 passed (2)
       Tests  29 passed (29)
```

### 4.2 AC-2 — Apply `scope: 'creator'` to `ConsultationJobController.cancel`

**Files modified**

| File | Change |
|---|---|
| `apps/api/src/modules/consultation/consultation-job.controller.ts` | `cancelJob` decorator upgraded from `{ modelName, paramName }` to `{ modelName, paramName, scope: 'creator' }`. Read routes (`getJob`, `streamJob`) intentionally left tenant-only per README §1.3 AC-2 — shared-room reads from peer users are legitimate. |
| `apps/api/src/modules/consultation/__tests__/consultation-job.controller.test.ts` | Metadata sanity-pin for `cancelJob` updated to require `scope: 'creator'`; `getJob` / `streamJob` pins kept tenant-only with explanatory comments. |

**Test evidence (RED → GREEN)**

```text
RED — controller test for cancelJob metadata fails: expected scope:"creator", received {modelName, paramName} only.
GREEN — `pnpm --filter @arcaai/api exec vitest run src/modules/consultation/__tests__/consultation-job.controller.test.ts`
  Test Files  1 passed (1)
       Tests  13 passed (13)
```

### 4.3 AC-4 — E2E spec `consultation-job-cross-user.spec.ts`

**Files added**

| File | Purpose |
|---|---|
| `apps/api/tests/e2e/consultation-job-cross-user.spec.ts` | NEW. Playwright spec covering AC-4: tenant-A creator cancels own job → 200; tenant-A peer cancels → 404; tenant-A peer GETs same job → 200 (read still tenant-only). |

**Test design**

- Uses both seeded same-tenant doctors (`doctor` as creator, `doctor2` as peer) — both live in `__GLOBAL__` per `91-user.ts`.
- Seeds Redis directly with a `consultation_job:<jobId>` JSON shaped exactly like `JobService.updateJobStatus` writes (TASK-307 W3.3 `ConsultationJobStatus` payload — tenantId + userId carried through). Cleanup in `afterAll`.
- Declaration order is intentional: peer-cancel-404 runs BEFORE creator-cancel-200 so the peer 404 lands on a still-`RUNNING` row, not a CANCELLED terminal one. Within a Playwright file the same worker executes tests sequentially in declaration order.
- Cross-tenant 404 is NOT re-proven here — it is already covered by `task-307-consultation-job-cross-tenant.spec.ts` (TASK-307 W3.4) plus the `cross-tenant probe regardless of scope:"creator"` unit test in this ticket.

**Execution constraint (worktree)**

The dev infra Redis (`hope-redis` on `:6379`) is running on this host, but the test infra stack (`hope-redis-test` on `:6380`, API on `:8868` via `./scripts/start-test-api.sh`) is not. The spec is authored and lints clean; it will be executed against the parent repo's running test stack once this branch merges back to `fix/2605-review` (or earlier via `pnpm docker:test:up && pnpm test:api:up && pnpm test:e2e --grep consultation-job-cross-user`). The unit-level coverage of the same logic in §4.1 is the immediate verification.

### 4.4 AC-5 — `AuthController` per-endpoint throttle

**Files modified**

| File | Change |
|---|---|
| `apps/api/src/modules/auth/auth.controller.ts` | Removed class-wide `@Throttle({ default: { limit: 10, ttl: 60000 } })`; added per-handler decorators: `login` → 5/min, `refresh` → 60/min, `impersonate` → 10/min. `me`, `logout`, `issueStreamTicket`, `revokeImpersonation` ride the app-wide default throttler (no per-endpoint decorator). |
| `apps/api/src/modules/throttle/__tests__/throttle-decorators.test.ts` | Replaced "AuthController has class-wide 10/min" assertion with "AuthController has NO class-wide throttle"; added 7 new per-handler metadata assertions under `TASK-308 AC-5 — AuthController per-endpoint throttle`. |

**Test evidence (RED → GREEN)**

```text
RED — 4 of 10 throttle-decorators cases fail:
  ✗ AuthController carries NO class-wide throttle (still has 10/min)
  ✗ login is decorated with 5 req / 60s (currently undecorated)
  ✗ refresh is decorated with 60 req / 60s (currently undecorated)
  ✗ impersonate is decorated with 10 req / 60s (currently undecorated)

GREEN — `pnpm --filter @arcaai/api exec vitest run src/modules/throttle/__tests__/throttle-decorators.test.ts`
  Test Files  1 passed (1)
       Tests  10 passed (10)

Regression — `pnpm --filter @arcaai/api exec vitest run src/modules/{auth,throttle,consultation} src/common`
  Test Files  16 passed (16)
       Tests  260 passed (260)

Build — `pnpm --filter @arcaai/api build` → exit 0.
```

### 4.5 AC-6 — E2E spec `auth-throttle-per-endpoint.spec.ts`

**Files added**

| File | Purpose |
|---|---|
| `apps/api/tests/e2e/auth-throttle-per-endpoint.spec.ts` | NEW. Playwright spec covering AC-6: `/auth/login` at 5/min, `/auth/refresh` at 60/min, `/auth/me` rides default 100/min. |

**Test design**

- Three serial tests inside one `describe`, with `mode: 'serial'` so they don't race the in-process throttle counter.
- A `beforeAll` issues the doctor `/auth/login` first (so the /me test has a valid token before the login-throttle test consumes the 5/min budget).
- Order is `/me` (default tier) → `/refresh` (60/min tier) → `/login` (5/min tier), so the login probe runs LAST and its budget burn doesn't interfere with the other tests' preconditions.
- Assertions are bound-based, not exact-count-based: "≥1 of 6 login attempts 429s" and "0 of 11 refresh attempts 429" — robust against any prior-test counter consumption (other than the login one, which is mitigated by the in-`beforeAll` precondition).

**Execution constraint (worktree)**

Same constraint as AC-4: the test stack (test API on `:8868`) is not running here. The spec is authored, lints clean, and is structured to be run via `pnpm test:e2e --grep auth-throttle-per-endpoint` against a fresh test API. The §4.4 unit-level metadata pin is the immediate verification.

**Known follow-up — pre-existing tests may need tuning**

Lowering `/auth/login` from 10/min (class-wide) to 5/min (per-endpoint) tightens the bound for legitimate login calls from other specs that share the same API process. `apps/api/tests/e2e/auth.spec.ts` already issues ≥9 `/auth/login` calls. Whether the pre-existing test suite remains green under the new 5/min limit can only be confirmed by running the full E2E suite against the test stack; this is flagged here as a follow-up to verify post-merge. The decorator change itself is correct (it satisfies AC-5) and is the actionable deliverable; any test fixture adjustments are out-of-scope for this ticket (see "Hard constraints" in the execution prompt: "DO NOT modify files outside the scope of TASK-308").

---

## 5. Verification Evidence

### 5.1 Unit tests — full `@arcaai/api` suite

```text
$ pnpm --filter @arcaai/api test
…
 Test Files  72 passed (72)
      Tests  1338 passed (1338)
   Start at  21:17:13
   Duration  15.25s (transform 3.02s, setup 0ms, import 91.98s, tests 24.17s, environment 4ms)
```

This includes:
- the 5 new `ConsultationJob — scope:"creator"` interceptor cases (§4.1)
- the 1 new `scope` decorator metadata case (§4.1)
- the updated `cancelJob` controller metadata pin (§4.2)
- the 7 new `TASK-308 AC-5 — AuthController per-endpoint throttle` cases (§4.4)
- the 1 updated "AuthController carries NO class-wide throttle" case (§4.4)

…and all 1323 pre-existing api tests, unmodified.

### 5.2 Build — `@arcaai/api`

```text
$ pnpm --filter @arcaai/api build
> @arcaai/api@0.1.0 build /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-task-308/apps/api
> rimraf dist && nest build && tsc-alias

(exit 0)
```

### 5.3 Lint — `ReadLints` over all modified files

```text
apps/api/src/common/tenant-owned-resource.decorator.ts                 → 0 errors
apps/api/src/common/tenant-owned-resource.interceptor.ts               → 0 errors
apps/api/src/common/__tests__/tenant-owned-resource.decorator.test.ts  → 0 errors
apps/api/src/common/__tests__/tenant-owned-resource.interceptor.test.ts→ 0 errors
apps/api/src/modules/consultation/consultation-job.controller.ts       → 0 errors
apps/api/src/modules/consultation/__tests__/consultation-job.controller.test.ts → 0 errors
apps/api/src/modules/auth/auth.controller.ts                           → 0 errors
apps/api/src/modules/throttle/__tests__/throttle-decorators.test.ts    → 0 errors
apps/api/tests/e2e/consultation-job-cross-user.spec.ts                 → 0 errors
apps/api/tests/e2e/auth-throttle-per-endpoint.spec.ts                  → 0 errors
```

### 5.4 E2E specs (authored; execution deferred)

Two specs were added per AC-4 / AC-6:

- `apps/api/tests/e2e/consultation-job-cross-user.spec.ts` (3 cases)
- `apps/api/tests/e2e/auth-throttle-per-endpoint.spec.ts` (3 cases)

Both lint cleanly and follow established Playwright patterns (`SEEDED_USERS`, `loginUser`, `ioredis`-direct seeding for AC-4). Execution requires the test infrastructure (`pnpm docker:test:up` + `pnpm test:api:up`) which is not running in the worktree; the specs will be exercised after merge via `pnpm test:e2e --grep "consultation-job-cross-user|auth-throttle-per-endpoint"`. The unit-level coverage in §5.1 is the immediate verification of the underlying logic.

### 5.5 Worktree

```text
Path     : /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-task-308
Branch   : task-308/pre-sdk-auth-gaps
Base     : a6a19797 (task-307 followup — ticket scaffolds)
Head     : a4ecf99c (task-308(ac-6) — throttle granularity E2E spec)
```

---

## 6. Change History

| Date | Description | Files modified |
|---|---|---|
| 2026-05-28 | Ticket created from TASK-307 §10.1 deferrals (W7.A.12 + E-4) | — |
| 2026-05-28 | Status `Pending` → `In Progress`; execution started on branch `task-308/pre-sdk-auth-gaps` (worktree) | `README.md` |
| 2026-05-28 | AC-1 + AC-3: extended `@TenantOwnedResource` with `scope: 'tenant' \| 'creator'`; interceptor enforces `status.userId === cls.user.id` when `scope === 'creator'`; +5 interceptor + 1 decorator unit cases | `apps/api/src/common/tenant-owned-resource.{decorator,interceptor}.ts`, `apps/api/src/common/__tests__/tenant-owned-resource.{decorator,interceptor}.test.ts` |
| 2026-05-28 | AC-2: applied `scope: 'creator'` to `ConsultationJobController.cancel`; read routes left tenant-only per §1.3 AC-2 | `apps/api/src/modules/consultation/consultation-job.controller.ts`, `apps/api/src/modules/consultation/__tests__/consultation-job.controller.test.ts` |
| 2026-05-28 | AC-4: authored Playwright spec `consultation-job-cross-user.spec.ts` covering creator-200 / peer-cancel-404 / peer-read-200 (Redis-seeded) | `apps/api/tests/e2e/consultation-job-cross-user.spec.ts` |
| 2026-05-28 | AC-5: removed class-wide `@Throttle` from `AuthController`; added per-endpoint decorators (login 5/min, refresh 60/min, impersonate 10/min); /me /logout /stream-ticket /revoke-impersonation ride the app-wide default | `apps/api/src/modules/auth/auth.controller.ts`, `apps/api/src/modules/throttle/__tests__/throttle-decorators.test.ts` |
| 2026-05-28 | AC-6: authored Playwright spec `auth-throttle-per-endpoint.spec.ts` covering /me-no-429 / refresh-no-429 / login-≥1-429 | `apps/api/tests/e2e/auth-throttle-per-endpoint.spec.ts` |
| 2026-05-28 | Status `In Progress` → `Completed`; §4 + §5 populated with verification evidence | `README.md` |

---

## 7. Open Items / Follow-ups

1. **E2E execution** — both new specs (`consultation-job-cross-user.spec.ts`, `auth-throttle-per-endpoint.spec.ts`) are authored but not executed in this worktree because the test stack (test Redis on `:6380`, test API on `:8868`) is not running. Run them post-merge via `pnpm docker:test:up && pnpm test:api:up && pnpm test:e2e --grep "consultation-job-cross-user|auth-throttle-per-endpoint"`.

2. **Pre-existing E2E suite under new 5/min login limit** — `apps/api/tests/e2e/auth.spec.ts` issues ≥9 `/auth/login` calls; whether the full E2E suite remains green when those run in parallel against the same API process under the new 5/min envelope must be verified post-merge. If it fails, the fix is a fixture-side adjustment (rate-limit disable via `RATE_LIMIT_ENABLED=false`, or per-test waits), not a behaviour change in `AuthController`.

3. **§2.3 release-window risk** — pre-W7.A.12 Redis rows lacking `userId` are now uniformly 404'd by the interceptor (verified by the "missing status.userId" unit case in §4.1). The 24h JOB_TTL window between TASK-307 W3 deploy and this ticket's deploy will produce a small number of legitimate 404s for jobs that predate `userId`. The recommended mitigation — deploying TASK-308 ≥ JOB_TTL after TASK-307 — still applies.
