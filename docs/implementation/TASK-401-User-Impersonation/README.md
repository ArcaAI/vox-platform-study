# TASK-401 — User Impersonation (T5): full "act-as", time-boxed, indigo banner + audit

- **Ticket**: TASK-401
- **Created**: 2026-07-02
- **Updated**: 2026-07-02
- **Status**: Completed
- **Classification**: feature (full-stack vertical: API + SDK + admin FE)

## 1. Requirement Analysis

Implement the deferred T5 impersonation treatment for the admin console
(`docs/admin-console-open-items-review.md`, TASK-371 §T5): a super-admin can
act **as** another user (writes allowed), time-boxed, with a persistent indigo
banner and a complete audit trail.

### Acceptance criteria

**Backend**
- `POST /api/v1/admin/users/:id/impersonate` — **super-admin only** (CASL
  `manage all` posture, like the TASK-396 reveal). Mints a time-boxed,
  **non-refreshable** JWT (default 30 min) whose claims carry BOTH the subject
  identity (target's id/roles/permissions/tenant) AND the true actor
  (`impersonatedBy`).
- Safeguards: no self-impersonation; no super-admin-tier targets; target must
  be ENABLED; **no nested impersonation** (an impersonated session cannot start
  another — enforced on the new AND the legacy endpoint); optional reason
  string (audited, never in the token).
- End: reuse the existing `POST /auth/revoke-impersonation` (Redis jti
  revocation — the auth module's existing "session store"); FE discards the
  token; audit END event emitted.
- Audit: SysEvents on start/end (actor, target, tenant, expiry, reason) with
  `forceAuditLog` (TASK-396 pattern). Writes performed while impersonating
  carry the impersonator in the audit row (`metadata.impersonatedBy`).

**SDK (`@arcaai/vox`)**
- `useUsers().impersonate(userId, { reason?, targetTenantId?, expiresInSeconds? })`
  → time-boxed session payload; `useUsers().endImpersonation()` helper.

**FE (`apps/admin`)**
- "Impersonate" action on user row + detail (super-admin only). Start swaps the
  auth store to the impersonated session while retaining the original for
  restore. Persistent indigo (`--ai` token) banner on all routes:
  "Viewing as {name} — ends in {countdown} · Exit". Exit/expiry restores the
  super-admin session and lands back on the user's detail page. Router
  guards re-evaluate (TASK-394 `router.invalidate()` on auth-store change).

## 2. Current State Evaluation

- **Legacy endpoint** `POST /auth/impersonate`
  (`apps/api/src/modules/auth/auth.controller.ts`): admin-tier (SUPER_ADMIN /
  GLOBAL_ADMIN / TENANT_ADMIN) impersonation minting a 15-minute token with
  `impersonatedBy` + `impersonate-<hex>` jti. Gaps vs TASK-401: allows
  tenant-admins, no self/nested guards, no reason, no expiry in the response.
  **Kept as-is for backward compatibility** (+ the two missing guards
  backported).
- **`POST /auth/revoke-impersonation`**: revokes the jti in Redis
  (`IJwtRevocationService`) and emits the STOP `UserAuthenticated` bracket +
  `ImpersonationEvents.Ended`. Reused as the "end" endpoint.
- **`JwtStrategy.validate`** threads `impersonatedBy`/`jti`/`exp` into the CLS
  `UserSession`; the global `ImpersonationAuditInterceptor` already emits a
  per-request `IMPERSONATED_ACTION` audit row during impersonation.
- **CRUD audit rows** (`BaseService.broadcastSysEvent` → `SysEventService` →
  Redis queue → `AuditLogProcessor`): `responsibleUserId` is the CLS user (= the
  target during impersonation); the impersonator is NOT recorded — the
  provenance gap this task closes via the (already existing, unused-in-this-path)
  `metadata` JSONB column on `AuditLog`.
- **TASK-396 pattern**: `@Authorize(['manage','all'])` method-level override =
  super-admin only; direct `eventEmitter.emit(SysEventType.ResourceViewed,
  { forceAuditLog: true, tenantId: cls ?? resource-tenant, ... })` for
  compliance reads.
- **FE**: admin auth store (`apps/admin/src/store/auth-store.ts`,
  sessionStorage-persisted) drives the SDK client (`sdk-provider.tsx`) and the
  router context (`main.tsx` re-invalidates on auth changes — TASK-394).
  Custom auto-refresh (`use-auto-refresh.ts` / `auth-refresh.ts`) no-ops safely
  when `refreshToken` is empty. `--ai` indigo token exists in `index.css`
  (mapped to `bg-ai` / `text-ai-foreground`).

## 3. Implementation Plan (approved via task brief)

### Backend
1. `impersonation-events.ts`: add denial codes `SELF_IMPERSONATION`,
   `NESTED_IMPERSONATION`, `CALLER_NOT_SUPER_ADMIN`, `TARGET_DISABLED`; add
   optional `expiresAt` to the payload (reason reused for the operator note on
   Started).
2. `dto/impersonate.dto.ts`: new `AdminImpersonateRequest`
   (`targetTenantId?`, `reason?` ≤500, `expiresInSeconds?` 10–1800 for tests);
   `ImpersonateResponse` gains optional `expiresAt`/`expiresInSeconds`.
3. New `admin-impersonation.controller.ts` (auth module,
   `@Controller('admin/users')`, `@Post(':id/impersonate')`,
   `@Authorize(['manage','all'])`): nested guard → DB-role super-admin check
   (defense-in-depth under the CASL gate) → self guard → target lookup (found /
   ENABLED as distinct rejections) → super-admin-tier target guard → tenant
   resolution (honours `targetTenantId`) → mint (default
   `JWT_IMPERSONATION_EXPIRES_IN` **30m**) → audit (UserAuthenticated START
   bracket + `ImpersonationEvents.Started` + forced `ResourceViewed`
   `USER_IMPERSONATION_STARTED` row) → response with expiry.
4. `auth.controller.ts` (minimal): backport nested + self guards to the legacy
   `impersonate()`; add the symmetric forced `USER_IMPERSONATION_ENDED` row to
   `revokeImpersonation()`.
5. Provenance threading (writes during impersonation):
   `BaseService.broadcastSysEvent` merges `metaData.impersonatedBy` from the
   CLS user; `SysEventService.buildAuditLogData` maps `metadata`;
   `AuditLogProcessor` passes it to `AuditLogFactory` (schema untouched — the
   `metadata` JSONB column already exists).
6. `auditLog.service.ts handleUserAuthenticatedEvent`: persist optional
   `reason` / `expiresAt` / `impersonationTenantId` on the impersonated branch.

### SDK
- `USER_ENDPOINTS.IMPERSONATE(id)`; `useUsers().impersonate(userId, opts?)` +
  `useUsers().endImpersonation()` (thin wrappers — the ADMIN APP owns the token
  swap via its auth store, unlike `useAuth().impersonate` which stashes tokens
  inside the SDK client). Rebuild dist.

### FE (apps/admin)
- `auth-store.ts`: `impersonation` slice `{ active, expiresAt, targetName,
  reason?, original: {token/refresh/tenant/user/returnTo} }` +
  `startImpersonation` / `endImpersonation` actions (swap active session;
  clear `refreshToken` while impersonating so auto-refresh no-ops; restore on
  end). Session-storage persisted.
- `features/users/impersonate-dialog.tsx`: confirm + optional reason; on
  success → store swap → navigate `/history` (doctor-visible surface).
- `components/layout/impersonation-banner.tsx`: indigo `bg-ai` banner with
  live countdown + Exit; auto-restores on expiry. Rendered in `AppShell`.
- Users grid row kebab + user detail kebab: "Impersonate" (super-admin only,
  hidden for self / disabled targets).

### Testing
- **Units (TDD)**: `admin-impersonation.controller.task401.test.ts` (guard
  matrix / claims / TTL / audit emissions), `auth.controller.task401.test.ts`
  (legacy nested+self backport, revoke END row),
  `impersonation-provenance.task401.test.ts` (metadata threading through
  BaseService → SysEventService → AuditLogProcessor), SDK
  `useUsers.task401.test.ts`.
- **API E2E** `apps/api/tests/e2e/task-401-impersonation.spec.ts` (live stack):
  start → act-as (`/auth/me`, tenant-scoped read) → impersonated PATCH
  `/user/me/preferences` write lands an audit row with
  `metadata.impersonatedBy` → end (revoked token 401) → short-TTL expiry 401 →
  full safeguard matrix + forced START/END audit rows.
- **FE E2E** `apps/admin/e2e/task-401-impersonation.spec.ts` (3 viewports):
  super-admin impersonates seeded `doctor` → indigo banner + countdown → guards
  re-scope (`/dashboard` bounces) → Exit restores + lands on user detail →
  banner gone; tenant-admin sees no Impersonate action.
- **Regressions**: re-run TASK-400 API spec (shared auth files touched) and
  TASK-394 guard spec (auth-store/router touched).

## 4. Design notes

Followed the TASK-371 §T5 sketch (`docs/admin-console-open-items-review.md`):
indigo `--ai` banner, "viewing as" + countdown + exit affordance. Where
undesigned (dialog copy, banner layout details, row-action placement), standard
patterns from the existing user actions/dialogs are used and noted in §5.

## 5. Implementation Summary

Implemented exactly as planned in §3 — no schema changes (the `AuditLog.metadata`
JSONB column already existed). All layers verified live.

### Endpoints + claim design

- **`POST /api/v1/admin/users/:id/impersonate`** (new
  `admin-impersonation.controller.ts`, auth module) — super-admin only via
  `@Authorize(['manage','all'])` + a defense-in-depth DB-role check. Body:
  `{ targetTenantId?, reason? (≤500), expiresInSeconds? (10–1800, test hook) }`.
  Mints a **non-refreshable** JWT (default `JWT_IMPERSONATION_EXPIRES_IN` =
  30 m) whose claims carry the SUBJECT (target `id`/`username`/`email`/`roles`/
  `permissions`/`tenantId`) AND the ACTOR (`impersonatedBy`), with an
  `impersonate-<hex>` jti (Redis-revocable). Response:
  `{ user, token, impersonatedBy, expiresAt, expiresInSeconds }`.
- **`POST /auth/revoke-impersonation`** (existing) reused as "end" — revokes the
  jti in Redis; now also lands the forced `USER_IMPERSONATION_ENDED` audit row.
- **Legacy `POST /auth/impersonate`** kept for tenant-admin flows, with the
  nested + self guards backported.

### Safeguards (all rejected with audited `ImpersonationEvents.Denied`)

nested impersonation (403, both endpoints) · non-super-admin caller (403) ·
self (400) · super-admin-tier target (400) · disabled target (400) ·
unknown target (404).

### Provenance threading (impersonated writes)

`BaseService.broadcastSysEvent` merges `metaData.impersonatedBy` from the CLS
user session → `SysEventService.buildAuditLogData` maps it to the audit job's
`metadata` → `AuditLogProcessor`/`AuditLogFactory` persist it on the row. Every
CRUD audit row written during an impersonated session therefore records the
true actor in `metadata.impersonatedBy` while `responsibleUserId` stays the
subject (target). Lifecycle brackets: forced `USER_IMPERSONATION_STARTED` /
`USER_IMPERSONATION_ENDED` `ResourceViewed` rows (actor, target, tenant,
expiry, reason — TASK-396 `forceAuditLog` posture) plus the existing
`UserAuthenticated` START/STOP brackets and per-request
`IMPERSONATED_ACTION` interceptor rows.

### SDK (`@arcaai/vox`)

`USER_ENDPOINTS.IMPERSONATE(id)`; `useUsers().impersonate(userId, opts?)` and
`useUsers().endImpersonation()` (thin wrappers; the admin app owns the token
swap). Types: `AdminImpersonateOptions`, extended `ImpersonateResponse`.
Dist rebuilt.

### FE (`apps/admin`)

- `auth-store.ts`: `impersonation` slice + `startImpersonation` /
  `endImpersonation` — swaps the active session, snapshots the original
  (token/refresh/tenant/user/returnTo), clears `refreshToken` during
  impersonation so the custom auto-refresh no-ops, restores verbatim on end.
  sessionStorage-persisted (survives hard reloads).
- `impersonate-dialog.tsx`: confirm + optional audited reason → mint → store
  swap → toast → land on `/history` (doctor-visible surface).
- `impersonation-banner.tsx`: persistent indigo `bg-ai`/`text-ai-foreground`
  banner above the shell — "Viewing as {name} — ends in {countdown} · Exit".
  Exit revokes server-side then restores + returns to the captured user detail
  page; countdown-zero auto-restores locally (token already dead at `exp`).
- Users grid row kebab + user detail kebab: "Impersonate" (super-admin only;
  hidden for self and disabled targets). Router guards re-evaluate via the
  existing TASK-394 `router.invalidate()` auth-store subscription — verified
  live (impersonated doctor is bounced off `/dashboard`).

### Files changed

| File | Change |
| --- | --- |
| `apps/api/src/modules/auth/admin-impersonation.controller.ts` | NEW — super-admin mint endpoint |
| `apps/api/src/modules/auth/auth.module.ts` | register controller |
| `apps/api/src/modules/auth/auth.controller.ts` | legacy guards backport + END audit row |
| `apps/api/src/modules/auth/impersonation-events.ts` | new denial codes + payload fields |
| `apps/api/src/modules/auth/dto/impersonate.dto.ts` | `AdminImpersonateRequest`, response expiry |
| `packages/applications/src/common/base.service.ts` | `metaData.impersonatedBy` merge |
| `packages/applications/src/services/sysEvent/sysEvent.service.ts` | metadata → audit job |
| `packages/applications/src/services/auditLog/auditLog.processor.ts` | metadata → row |
| `packages/applications/src/services/auditLog/auditLog.service.ts` | reason/expiry on impersonated bracket |
| `packages/applications/src/services/baseServices/_meta/appSettings/appSettings.module.ts` | **bugfix** — memoized `forRoot()` (see Change History) |
| `packages/agentic-sdk-v2/src/core/constants.ts`, `types/auth.ts`, `core.ts`, `hooks/useUsers.ts` | SDK impersonate/end hooks |
| `apps/admin/src/store/auth-store.ts` | impersonation slice |
| `apps/admin/src/features/users/impersonate-dialog.tsx` | NEW |
| `apps/admin/src/components/layout/impersonation-banner.tsx` | NEW (rendered in `app-shell.tsx`) |
| `apps/admin/src/routes/_authenticated/tenants/$tenantId/users/{index,$userId}.tsx` | Impersonate actions |
| unit/E2E specs | see §Testing evidence |

### Testing evidence (all live, 2026-07-02)

- **Units**: API `task401` controller tests **20/20**; applications
  provenance + password suites **56/56**; appSettings module **4/4**; SDK
  `useUsers.task401` **4/4**; admin `auth-store.task401` **5/5**.
- **API E2E** `task-401-impersonation.spec.ts`: **12/12** — claims (A),
  act-as + write provenance `metadata.impersonatedBy` (B), forced START/END
  rows (C), revoke + real-time expiry 401s (D), full safeguard matrix (E).
- **FE E2E** `task-401-impersonation.spec.ts`: **8/8 + 1 skipped**
  (desktop/tablet/mobile) — banner + ticking countdown, hard-reload
  persistence, guard re-scope (`/dashboard` bounce), Exit restore to user
  detail, super-admin-only affordance (grid check skipped on mobile card
  tier by design).
- **Regressions**: TASK-400 API spec **13/13** (see Change History for the D2
  root-cause fix); TASK-394 guard spec **6/6**; admin `tsc --noEmit` + `vite
  build` clean.
- **End state**: `:8868` healthy, entitlements OFF (`entitlements.enabled`
  = false), rate-limiting OFF (effective `enabled:false` via
  `/admin/rate-limit`), `:5174` up.

## 6. Change History

- 2026-07-02 — Ticket created; plan approved via task brief; implementation
  started on the uncommitted TASK-394…400 tree.
- 2026-07-02 — **Pre-existing bug found + fixed while chasing a TASK-400 D2
  regression**: `AppSettingsModule.forRoot()` returned a NEW DynamicModule per
  call and is invoked twice (root `CommonServiceModule` + nested
  `S3ServiceModule.forRoot()`), so Nest instantiated TWO `AppSettingsService`
  singletons; both registered the `updateCacheAppSettings` cron under the same
  name and the second registration deleted the first's job — the instance most
  consumers injected NEVER refreshed its settings cache after boot (patched
  GlobalSettings silently never took effect until restart). Fixed by memoizing
  the DynamicModule so every `forRoot()` returns the same object (single
  instance + single cron). Proven live: patched `security.password.minLength`
  surfaced through the password-policy path within one 45 s cron tick, and the
  TASK-400 D2 rotation test went red → green (13/13).
- 2026-07-02 — Banner expiry-latch fix: the expiry effect could observe a stale
  `remaining === 0` on the render where impersonation activates and restore the
  session instantly; it now re-checks the wall clock (`secondsLeft`) before
  treating it as a real expiry (caught by the FE E2E lifecycle test).
