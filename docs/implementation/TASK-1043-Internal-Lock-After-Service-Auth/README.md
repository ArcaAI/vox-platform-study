# TASK-1043 — Internal-route restore lock runs before service authentication

| Field | Value |
|---|---|
| Status | Completed — merged into `dev-2.2` at `ff4fbf897` |
| Type | bugfix (security) |
| Branch | `task-1043/internal-lock-after-auth` (worktree `../hope-v2-task-1043`) → `dev-2.2` |
| Origin | TASK-1041 OD-4 (owner: "create the OD-4 ticket then work on it completely", 2026-10-05) |

## Requirement Analysis

The global `TenantLockGuard` (`apps/api/src/guards/tenant-lock.guard.ts`) runs as an `APP_GUARD`.
On `/api/v1/internal/*` it falls back to the `X-Tenant-Id` header and reads that tenant's restore
lock. Nest runs every global guard BEFORE controller guards, and every `@Public()` internal
controller authenticates in a controller-level guard (`InternalServiceTokenGuard`,
`HarnessServiceTokenGuard`, `ServiceReleaseTokenGuard`). So the lock read happens for a caller who
hasn't presented any credential at all:

| Caller without a token, `X-Tenant-Id: T` | Answer today |
|---|---|
| T has a CLINICAL restore running | **503 `TENANT_RESTORE_IN_PROGRESS` + the `restoreId`** |
| T is not locked / doesn't exist | 401 from the controller's token guard |

That is an unauthenticated oracle: anyone who can reach the gateway can learn whether a tenant
(by id) is being restored, and read the restore id. Each distinct tenant id also costs a DB read
(the cache is per tenant, 5 s), so random ids turn every unauthenticated request into a query.

Must hold after the fix:
1. An unauthenticated `@Public()` internal request never reads lock state. It gets the token
   guard's 401 whatever the lock state is.
2. An authenticated internal request keeps today's effective lock behaviour: `X-Tenant-Id` names
   a tenant with a CLINICAL restore → 503 `TENANT_RESTORE_IN_PROGRESS` + `Retry-After: 30`, any
   method. A mutating call naming the tenant in query/body → same, as before.
3. Internal routes authenticated by `UnifiedAuthGuard` (not `@Public()`: `SttInternalController`,
   API key scope `internal:stt:worker`) keep the global guard's header fallback. They are already
   authenticated when it runs.
4. User-plane behaviour (423) unchanged.

## Current State Evaluation

- `@Public()` internal controllers (13): agent-internal, agent-version-internal,
  composed-prompt-internal, effective-config, model-registry-internal, model-serving-internal
  (`InternalServiceTokenGuard`); harness-internal (`HarnessServiceTokenGuard` + `InternalTenantLockGuard`),
  consultation-read-internal, consent-internal, harness-tts-internal (`HarnessServiceTokenGuard`);
  service-release-internal (`ServiceReleaseTokenGuard`).
- Only `HarnessInternalController` (and the non-public `SttInternalController`) carries
  `InternalTenantLockGuard`, which checks mutating calls only (tenant from `x-internal-tenant-id`
  / `x-tenant-id` / query / body). Every other internal route was lock-checked only through the
  global guard's header fallback, i.e. before authentication.

## Implementation Plan

Decided under the owner's "work on it completely" instruction. Recommended options taken:

| # | Decision | Taken |
|---|---|---|
| D-1 | Where the internal lock check lives | **After service authentication.** The global guard stops using the header fallback on `@Public()` routes, and `InternalTenantLockGuard` sits after the token guard on every `@Public()` internal controller. Rejected: teaching the global guard to verify service tokens itself, because that duplicates three token guards' secret maps and the `?service=` selection. |
| D-2 | What `InternalTenantLockGuard` checks | Takes over the global guard's internal rule exactly: `X-Tenant-Id` header → checked for **every** method; tenant only in `x-internal-tenant-id` / query / body → mutating calls only (unchanged). Net behaviour for authenticated callers is the same as today. |
| D-3 | Non-public internal routes (STT) | Keep the global header fallback; they're authenticated before the global lock guard runs. |
| D-4 | Keeping it closed | A coverage test enumerates every controller under `internal/…`: each `@Public()` one must list `InternalTenantLockGuard` AFTER its token guard. A new internal controller without it fails the unit suite. |

### TDD test list

1. `tenant-lock.guard.test.ts`: `@Public()` internal route + `X-Tenant-Id` of a locked tenant →
   resolves, `lock.state` never called. Non-public internal route → still 503.
2. `internal-tenant-lock.guard.test.ts`: GET with `x-tenant-id` naming a CLINICAL-locked tenant →
   503 + `Retry-After`. GET with the tenant only in query → still passes without a read (unchanged).
3. `internal-tenant-lock.coverage.test.ts`: every `@Public()` `internal/*` controller lists
   `InternalTenantLockGuard`, after its token guard.

### Files

`apps/api/src/guards/tenant-lock.guard.ts`, `apps/api/src/guards/internal-tenant-lock.guard.ts`,
their tests, plus the `@UseGuards(...)` line of the 9 `@Public()` internal controllers that lack the lock guard.

### Verification

Targeted unit tests; `apps/api` build + eslint on touched files. Live on the isolated test infra
(own API port, no reset), with a throwaway tenant that has a CLINICAL restore row in a locking status:
- no token + `X-Tenant-Id` → 401 (before the fix: 503 + restoreId);
- valid harness token → 503 `TENANT_RESTORE_IN_PROGRESS`;
- unlocked tenant + token → 200.

## Implementation Summary

D-1 to D-4 as planned.

- `TenantLockGuard`: the `X-Tenant-Id` fallback now applies only to internal routes that are NOT
  `@Public()` (either marker the auth guard honours: `SKIP_AUTH_KEY` or `isPublic`). For a public
  route the guard resolves no tenant and returns before reading anything.
- `InternalTenantLockGuard`: a tenant named in `X-Tenant-Id` is checked for every method (it took
  over the global guard's rule); a tenant named only in `x-internal-tenant-id` / query / body is
  still checked for mutating methods only.
- `@UseGuards(<token guard>, InternalTenantLockGuard)` on the 10 public internal controllers that
  lacked it: agent-internal, agent-version-internal, composed-prompt-internal, effective-config,
  model-registry-internal, model-serving-internal, consent-internal, consultation-read-internal,
  harness-tts-internal, service-release-internal. `SpeechModule` and `ServiceReleaseModule` now
  import `TenantLockModule` so the guard can be injected; the other modules already did.
- Coverage test: discovers every `*.controller.ts` (`import.meta.glob`), selects the controllers whose
  path starts with `internal` and carry `@Public()`, and requires `InternalTenantLockGuard` with at
  least one guard before it. It found 11; all pass.

No route, DTO, scope or response-shape change. `route-manifest.json` regenerated from the new
build: no diff (it doesn't record controller guards). openapi untouched for the same reason.

### Files changed

| File | Change |
|---|---|
| `apps/api/src/guards/tenant-lock.guard.ts` | skip header fallback on `@Public()` routes; `isPublic()` helper; doc comment |
| `apps/api/src/guards/internal-tenant-lock.guard.ts` | `X-Tenant-Id` checked on every method; doc comment |
| `apps/api/src/guards/__tests__/tenant-lock.guard.task1043.test.ts` | new, 9 tests |
| `apps/api/src/guards/__tests__/internal-tenant-lock.coverage.test.ts` | + discovery-based order/coverage suite |
| 10 internal controllers (listed above) | `InternalTenantLockGuard` after the token guard (1 import + 1 decorator line each) |
| `apps/api/src/modules/speech/speech.module.ts`, `service-release/service-release.module.ts` | import `TenantLockModule` |

### Evidence

- **RED**: 14 failures before the fix: 10 controllers missing the guard; the global guard read
  the lock on `SKIP_AUTH_KEY` / `isPublic` routes (503 instead of resolving); GET/HEAD with
  `X-Tenant-Id` passed `InternalTenantLockGuard`.
- **GREEN**: `apps/api/src/guards/__tests__` → `Test Files 10 passed, Tests 121 passed`. Every
  test that imports a touched controller/module plus `apps/api/src/bootstrap/__tests__` (boot audits)
  → `Test Files 16 passed, Tests 367 passed`.
- `apps/api` `pnpm build` exit 0; eslint on every changed file exit 0 with no output.
- **Live, isolated test infra, no reset.** Throwaway tenant `01a109b5-00d3-7d3b-a113-24447ea61cd8`
  (created via `POST admin/tenants`), with a CLINICAL `TenantCheckpointRestore` in `LOCKING`
  inserted for it (`t1043-probe-restore`, released to `FAILED` afterwards; nothing deleted).
  Unfixed = current `dev-2.2` build on :8979, fixed = this branch on :8978:

  | Request (`X-Tenant-Id` = probe tenant) | dev-2.2 | fixed |
  |---|---|---|
  | `GET internal/agents/resolve`, no token | **503** `TENANT_RESTORE_IN_PROGRESS` | **401** |
  | same, wrong token | **503** | **401** |
  | `POST internal/consultations/x/read`, no token | **503** | **401** |
  | `GET internal/effective-config`, no token | **503** | **401** |
  | `GET internal/agents/resolve`, valid token | 503 | 503 + `Retry-After: 30` + `restoreId` |
  | same, valid token, unlocked tenant (Global) | 200 | 200 |

- Regression: `task-890-agent-resolve-fail-closed` against the fixed build (`RESET_DB=false`) →
  `2 passed, 1 skipped` (same seed-state skip as TASK-1041).

### Not verified / notes

- Repo-wide gates not run (owner rule: the orchestrator gates once after the merge).
- The probe tenant and its FAILED checkpoint/restore rows remain in the test DB; a
  `test:db:reset` clears them.

## Change History

| Date | Change |
|---|---|
| 2026-10-05 | Ticket created from TASK-1041 OD-4; plan + decisions recorded |
| 2026-10-05 | TDD RED → GREEN; fix committed; live before/after on the test infra; status Review |
| 2026-10-05 | Merged into `dev-2.2` at `ff4fbf897` (--no-ff, orchestrator review; guards 121/121 after merge); worktree and branch removed. Owner marked **Completed** |
