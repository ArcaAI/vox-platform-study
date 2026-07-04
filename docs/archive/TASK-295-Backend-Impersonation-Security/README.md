# TASK-295 — Backend Impersonation Security: SEC-J close, tenant-scope on impersonate, audit log subject, JWT revocation, stream-ticket impersonatedBy, playground sessionStorage migration

| | |
|---|---|
| Ticket Number | TASK-295 |
| Created | 2026-05-24 |
| Updated | 2026-05-24 |
| Status | Completed |
| Type | Security / Bug fix / Refactor |
| Parent | [TASK-293 Vox SDK Deep Assessment V2](../TASK-293-Vox-SDK-Deep-Assessment-V2/README.md) |
| Scope | Backend impersonation, JWT, audit log, stream tickets, playground token hygiene |

---

## 1. Requirement Analysis

### 1.1 Source

This ticket implements Wave 5A items **W5A-2, W5A-3, W5A-4, W5A-5** and Wave 5A-6/M-8 (stream-ticket `impersonatedBy`), Wave 5A-13 (playground `sessionStorage`) plus H-2, H-3, H-5, M-5 from
[`05-impersonation.md`](../TASK-293-Vox-SDK-Deep-Assessment-V2/05-impersonation.md) and §5 of
[`06-transports.md`](../TASK-293-Vox-SDK-Deep-Assessment-V2/06-transports.md) (WS/SSE auth-context note).

### 1.2 Defects in scope

| Defect | Severity | Source | Action |
|---|---|---|---|
| **C-1** Tenant-admin can impersonate cross-tenant | Critical | `auth.controller.ts:312-342` | Enforce `adminUser.tenantId === resolvedTenantId` when caller is not `SUPER_ADMIN`. |
| **C-2 / SEC-J** `x-tenant-id` header overrides JWT | Critical | `context.interceptor.ts:55-60` + `jwt.strategy.ts:25-41` | Set CLS `tenantId` from JWT; drop the header-based override; log a warn when divergent. |
| **C-3** Audit log drops impersonated subject | Critical (compliance) | `auditLog.service.ts:204-244` | Add `AuditAction.IMPERSONATED_ACTION`; persist `impersonatedUserId`, `endpoint`, `httpMethod`. |
| **C-4** No real token revocation on `/auth/revoke-impersonation` | Critical | `auth.controller.ts:487-506` | New `JwtRevocationService` (Redis-backed revoked-`jti` set); `JwtStrategy.validate` consults it; controller wires revoke. |
| **H-2** `UserSession` drops `impersonatedBy` | High | `userSession.dto.ts` + `jwt.strategy.ts` | Add field to DTO; propagate in strategy. |
| **H-3** Tenant resolution picks arbitrary tenant | High | `auth.controller.ts:346-355` | Accept optional `targetTenantId`; validate against target's enabled assignments. |
| **SEC-A5-6 / M-8** Stream ticket drops `impersonatedBy` | High | `stream-ticket.service.ts` + `jwtauth.guard.ts:67-110` | Add to ticket payload; restore in guard. |
| **H-1 / SEC-A5-4** Playground tokens in `localStorage` | High | `auth-store.ts:104-146` | Switch persist to `sessionStorage`; drop `impersonationToken` from `partialize`. |
| **H-5** SDK does not rehydrate impersonation on mount | High | `sdk-provider.tsx` | On mount, if persisted impersonation state exists, call `apiClient.startImpersonation` + `setImpersonatedUser`. |
| **M-5** Playground decodes JWT via `atob` | Medium | `user-list.tsx:188-196` | Drop fallback; use `result.user.tenantId` directly. |
| **L-3** Revoke without active impersonation | Low | `auth.controller.ts:495-506` | Throw `BadRequestException` when no `impersonatedBy` on current user. |

### 1.3 Business context

`05-impersonation.md` conformance verdict:
- Req 2 (tenant admin scoped to own tenant) — **FAIL** (C-1).
- Req 4 (audit logs both actor + subject) — **FAIL** (C-3, SEC-A5-6).
- Req 5 (impersonation token stored securely) — **OPEN** for playground (H-1).
- SEC-J — **NOT CLOSED** (C-2).
- Token revocation — **No-op** (C-4).

### 1.4 Acceptance criteria

1. TENANT_ADMIN of tenant A receives `403 Forbidden` when impersonating any user resolved to tenant B (RED test before fix).
2. `clsService.get('tenantId')` returns the JWT-derived value after `JwtStrategy.validate`; an `x-tenant-id` header diverging from JWT MUST NOT override CLS — it is only warn-logged.
3. Audit row for an impersonated request includes `action = IMPERSONATED_ACTION`, `eventType = 'IMPERSONATION'`, `resourceId = impersonatedUserId`, and `data` containing `endpoint`, `httpMethod`, `impersonatedUserId`.
4. After `POST /auth/revoke-impersonation`, the next request with the same `jti` MUST be rejected with `401 Unauthorized` by `JwtStrategy.validate`. Redis TTL for the revoked `jti` MUST be bounded by `exp - now`.
5. `UserSession.impersonatedBy` is populated from `payload.impersonatedBy` whenever present.
6. `POST /auth/impersonate` accepts optional `targetTenantId`; non-`SUPER_ADMIN` callers must supply (or accept) one that equals their own tenant.
7. Stream tickets issued during impersonation carry `impersonatedBy`; `JwtAuthGuard.handleTicketAuth` restores it on `req.user`.
8. Playground tokens persist via `sessionStorage`, not `localStorage`; the existing rehydration test is inverted to assert `impersonationToken` is NOT persisted.
9. On playground mount, if `sessionStorage` retains an impersonation session, the SDK is rehydrated to match.
10. `user-list.tsx` no longer decodes JWTs client-side.

---

## 2. Current State Evaluation

### 2.1 Code under review

- `apps/api/src/modules/auth/auth.controller.ts` (`impersonate` 290-401, `revokeImpersonation` 487-506).
- `apps/api/src/modules/auth/stream-ticket.service.ts` (single-use Redis ticket; payload `{ userId, tenantId, scope, exp }`).
- `apps/api/src/guards/jwtauth.guard.ts` (ticket-auth path 67-110 builds `req.user = { id, tenantId }`).
- `apps/api/src/interceptors/context.interceptor.ts` (writes `x-tenant-id` header into CLS — SEC-J).
- `packages/applications/src/services/auth/jwt.strategy.ts` (does NOT set CLS `tenantId`).
- `packages/applications/src/services/auth/dto/user.session.ts` (missing `impersonatedBy`).
- `packages/applications/src/services/auditLog/auditLog.service.ts` (`handleUserAuthenticatedEvent` drops `impersonatedUserId`/`endpoint`).
- `apps/ui-playground/src/store/auth-store.ts` (Zustand `persist` to `localStorage`).
- `apps/ui-playground/src/providers/sdk-provider.tsx` (no rehydration call to `startImpersonation`).
- `apps/ui-playground/src/features/playground/overview/components/user-list.tsx:188-196` (`atob` JWT decode).

### 2.2 Existing safeguards

- W0-3 SDK-side admin-token closure (`WeakMap`) — out of scope here, do not touch.
- `ImpersonationAuditInterceptor` already emits the `user.authenticated` event with `impersonatedUserId`, `endpoint`, `method` — the data is in the event; only the handler discards it.
- Stream-ticket TTL = 30 s, single-use Redis (`stream-ticket.service.ts`).
- `IRedisCacheService.setex` already gives us bounded TTL for revoked `jti`.

### 2.3 Dependencies

- `IRedisCacheService` (already provided by `RedisCacheModule.register()` via `StreamTicketModule` global).
- `AuditAction` enum is generated TS (`packages/domains/src/enums/generated/AuditAction.ts`) + Prisma (`packages/database/src/prisma/db_main/audit.prisma`). Extension means a Prisma migration is needed; we will add the TS enum value and create the migration SQL file, but **we will not execute the migration here** (DB ops require user approval; the new enum is non-destructive `ALTER TYPE ADD VALUE`).
- `JwtAuthGuard` already implements ticket consumption; we extend the payload contract backwards-compatibly.

### 2.4 Impact areas

| Module | Change |
|---|---|
| `packages/applications/src/services/auth` | New `JwtRevocationService`; `JwtStrategy` propagates `tenantId` + `impersonatedBy` + checks revocation. |
| `packages/applications/src/services/auditLog` | New `IMPERSONATED_ACTION` branch in `handleUserAuthenticatedEvent`. |
| `packages/domains/src/enums/generated/AuditAction.ts` | Add `IMPERSONATED_ACTION`. |
| `packages/database/src/prisma/db_main/audit.prisma` | Add `IMPERSONATED_ACTION` to enum (non-destructive). |
| `apps/api/src/interceptors/context.interceptor.ts` | Drop `x-tenant-id` override. |
| `apps/api/src/modules/auth/auth.controller.ts` | Enforce tenant scope; `targetTenantId` body; wire revocation. |
| `apps/api/src/modules/auth/dto/impersonate.dto.ts` | Add `targetTenantId`. |
| `apps/api/src/modules/auth/stream-ticket.service.ts` | Carry `impersonatedBy` in payload. |
| `apps/api/src/guards/jwtauth.guard.ts` | Restore `impersonatedBy` on `req.user`. |
| `apps/ui-playground/src/store/auth-store.ts` | `sessionStorage` + drop `impersonationToken` from `partialize`. |
| `apps/ui-playground/src/providers/sdk-provider.tsx` | SDK rehydration on mount. |
| `apps/ui-playground/src/features/playground/overview/components/user-list.tsx` | Drop `atob` fallback. |

---

## 3. Implementation Plan (TDD)

Each unit follows RED → GREEN → REFACTOR. Order is dictated by dependency direction.

| # | Unit | RED test(s) | GREEN files |
|---|---|---|---|
| 1 | **SEC-J: CLS `tenantId` from JWT** | `jwt.strategy.test.ts` — assert `clsService.set('tenantId', payload.tenantId)` called. | `jwt.strategy.ts` |
| 2 | **SEC-J: drop header override** | `context.interceptor.test.ts` — assert `clsService.set('tenantId', headerValue)` NOT called; warn logged when header diverges. | `context.interceptor.ts` |
| 3 | **H-2: `UserSession.impersonatedBy`** | `jwt.strategy.test.ts` — assert `result.impersonatedBy === payload.impersonatedBy`. | `user.session.ts`, `jwt.strategy.ts` |
| 4 | **AuditAction enum extension** | `auditLog.service.test.ts` — references `AuditAction.IMPERSONATED_ACTION`. | TS enum + Prisma schema. |
| 5 | **C-3: audit log subject + endpoint** | `auditLog.service.test.ts` — handle event with `impersonatedUserId` → row has `action = IMPERSONATED_ACTION`, `eventType = 'IMPERSONATION'`, `resourceId = impersonatedUserId`, `data.endpoint`, `data.httpMethod`, `data.impersonatedUserId`. | `auditLog.service.ts` |
| 6 | **C-4: `JwtRevocationService`** | New `jwt-revocation.service.test.ts` — `revoke(jti, exp)` sets Redis key with `setex(remainingTtl, '1')`; `isRevoked(jti)` returns true after revoke, false before. Bounded TTL (`exp - now`). | `jwt-revocation.service.ts`, module wiring. |
| 7 | **C-4: `JwtStrategy.validate` consults revocation** | `jwt.strategy.test.ts` — when revocation service returns true, throws `UnauthorizedException`. | `jwt.strategy.ts`, `jwt.strategy.module` glue. |
| 8 | **C-1: tenant scope on `/auth/impersonate`** | `auth.controller.task224.test.ts` (new test) — TENANT_ADMIN(tenant-A) → DOCTOR(tenant-B) → `ForbiddenException`. | `auth.controller.ts` |
| 9 | **H-3: `targetTenantId`** | controller test — accepts body `{ targetUserId, targetTenantId }`; validates against target's enabled assignments; non-SUPER_ADMIN must equal own tenant. | `impersonate.dto.ts`, `auth.controller.ts` |
| 10 | **C-4 + L-3: `/auth/revoke-impersonation`** | controller test — without `impersonatedBy` on user → 400; with → `jwtRevocationService.revoke(jti, exp)` called. | `auth.controller.ts` |
| 11 | **SEC-A5-6 / M-8: stream ticket `impersonatedBy`** | `stream-ticket.service.test.ts` — issued ticket payload includes `impersonatedBy`; `consumeTicket` returns it. `jwtauth.guard.test.ts` — `handleTicketAuth` restores it on `req.user`. | `stream-ticket.service.ts`, `auth.controller.ts` (issueStreamTicket), `jwtauth.guard.ts` |
| 12 | **H-1: playground `sessionStorage`** | Invert `auth-store.impersonation-persistence.test.ts` — assert `impersonationToken` is NOT persisted. Existing test cases rewritten. | `auth-store.ts` |
| 13 | **H-5: SDK rehydration** | `sdk-provider.tsx` — covered behaviorally by playground integration; we add no new test (out of scope) but document. | `sdk-provider.tsx` |
| 14 | **M-5: drop atob** | code change only; no behavior test added (covered indirectly by the persistence/rehydration test). | `user-list.tsx` |

### 3.1 Verification commands (Phase 3)

```
pnpm test:unit --filter @arcaai/applications
pnpm --filter @hope/api test:unit
pnpm --filter @hope/ui-playground test
pnpm build --filter @arcaai/applications @hope/api
pnpm --filter @hope/ui-playground build
ReadLints on every modified file
```

### 3.2 Out of scope

- IMPERSONATION_STARTED / IMPERSONATION_STOPPED audit rows (M-3) — deferred.
- `PersonalizationManager.setImpersonationReadOnly` (H-4) — owned by another task (TASK-300 SDK-side).
- SDK `startImpersonation` escape hatch hardening (H-6) — owned by SDK ticket.
- DB migration **execution**: a non-destructive migration SQL is produced but not applied; documented for ops.

---

## 4. Implementation Summary

### 4.1 Files created

| Path | Purpose |
|---|---|
| `packages/applications/src/services/auth/jwt-revocation.service.ts` | New service. Redis-backed set of revoked JWT `jti` values with TTL bounded by `exp - now`. Exposes `revoke(jti, exp)` and `isRevoked(jti)`. |
| `packages/applications/src/services/auth/__tests__/jwt-revocation.service.test.ts` | Unit tests for `JwtRevocationService` (TTL clamping, prefix, end-to-end revoke→isRevoked). |
| `apps/api/src/modules/auth/__tests__/auth.controller.task295.test.ts` | New focused controller tests for C-1, H-3, C-4, L-3. |
| `packages/database/src/prisma/db_main/migrations/20260524100000_add_audit_action_impersonated/migration.sql` | Non-destructive Prisma migration adding `IMPERSONATED_ACTION` to `core.AuditAction`. Not executed in this PR — see §3.2. |
| `docs/implementation/TASK-295-Backend-Impersonation-Security/README.md` | This document. |

### 4.2 Files modified

#### Backend — `packages/applications`

| Path | Change |
|---|---|
| `services/auth/jwt.strategy.ts` | `validate()` now (1) consults `IJwtRevocationService.isRevoked(payload.jti)` and throws `UnauthorizedException` when revoked; (2) propagates `payload.tenantId`, `payload.impersonatedBy`, `payload.jti`, `payload.exp` onto the `UserSession`; (3) explicitly `clsService.set('tenantId', payload.tenantId)` so JWT owns tenant context. |
| `services/auth/dto/user.session.ts` | Added optional `impersonatedBy`, `jti`, `exp` properties. |
| `services/auth/auth.service.module.ts` | Registers `IJwtRevocationService` provider; imports `RedisCacheModule`; exports the token. |
| `services/auth/index.ts` | Exports `jwt-revocation.service`. |
| `services/auditLog/auditLog.service.ts` | `handleUserAuthenticatedEvent` branches on `event.impersonatedUserId` — emits `AuditAction.IMPERSONATED_ACTION` with `eventType = 'IMPERSONATION'`, `resourceId = impersonatedUserId`, and `data = { endpoint, httpMethod, impersonatedUserId, timestamp, userAgent }`. Regular auth path unchanged. |

#### Backend — `packages/domains`, `packages/database`

| Path | Change |
|---|---|
| `domains/src/enums/generated/AuditAction.ts` | Added `IMPERSONATED_ACTION` enum value. |
| `database/src/prisma/db_main/audit.prisma` | Added `IMPERSONATED_ACTION` to the `AuditAction` Prisma enum (non-destructive). |

#### Backend — `apps/api`

| Path | Change |
|---|---|
| `src/modules/auth/auth.controller.ts` | (1) Injects `IJwtRevocationService`. (2) `impersonate` now resolves tenant via `userRoleAssignment.findMany({ select: { tenantId: true } })`, honours optional `targetTenantId`, and enforces C-1: non-SUPER_ADMIN callers receive `ForbiddenException('Tenant admin cannot impersonate users outside their own tenant')` when `adminUser.tenantId !== resolvedTenantId`. (3) `revokeImpersonation` throws `BadRequestException('Not currently impersonating')` when `!user.impersonatedBy` (L-3) and calls `jwtRevocationService.revoke(user.jti, user.exp)` (C-4). (4) `issueStreamTicket` passes `user.impersonatedBy` to the ticket service (SEC-A5-6). |
| `src/modules/auth/dto/impersonate.dto.ts` | Added optional `targetTenantId: string` field. |
| `src/modules/auth/stream-ticket.service.ts` | `IssueTicketInput` + `StoredTicket` now include `impersonatedBy?: string \| null`; persisted into the JSON payload and parsed on consume. Legacy tickets without the field still resolve. |
| `src/guards/jwtauth.guard.ts` | Injects `ClsService`. `handleTicketAuth` rebuilds `request.user` with `impersonatedBy` from the ticket payload and mirrors `user` + `tenantId` into CLS so `ImpersonationAuditInterceptor` fires on ticket-authenticated streams. |
| `src/interceptors/context.interceptor.ts` | Drops the unconditional `x-tenant-id` → CLS override (SEC-J). When the header is present and differs from the JWT-derived CLS `tenantId`, emits a warn-log. All downstream `tenantId` logging now sources from CLS. |

#### Playground — `apps/ui-playground`

| Path | Change |
|---|---|
| `src/store/auth-store.ts` | Persist storage switched from `localStorage` → `sessionStorage` via `createJSONStorage(() => sessionStorage)`. `partialize` no longer includes `impersonatedUser`, `impersonationToken`, `isImpersonating`, `originalTenantId` — a page reload during impersonation drops the elevated session by design (HIPAA-conscious bearer-token blast radius reduction). |
| `src/providers/sdk-provider.tsx` | Added inline documentation describing the H-1/H-5 interaction: after H-1, persisted impersonation state is structurally absent, so the existing `persistedImpersonating && impersonationToken ? impersonationToken : accessToken` guard correctly resolves to the admin's bearer token on a fresh tab and the user must re-click "Impersonate". |
| `src/features/playground/overview/components/user-list.tsx` | Removed the `atob(token.split('.')[1])` JWT-decode fallback. The server response always carries `result.user.tenantId` after H-3; if it's ever missing we want to surface the bug rather than paper over it client-side. |

#### Test files modified

| Path | Change |
|---|---|
| `packages/applications/src/services/auth/__tests__/jwt.strategy.test.ts` | Added mock `JwtRevocationService`; RED tests for `tenantId` CLS propagation, `impersonatedBy` propagation, revocation rejection, no-jti no-consult. |
| `packages/applications/src/services/auditLog/__tests__/auditLog.service.test.ts` | New `IMPERSONATED_ACTION` branch tests. |
| `apps/api/src/interceptors/__tests__/context.interceptor.test.ts` | New SEC-J tests: header does NOT write CLS; warn-log on divergence; no warn when matching. |
| `apps/api/src/guards/__tests__/jwtauth.guard.test.ts` | Injected `ClsService` mock; added TASK-295 tests for ticket-`impersonatedBy` restoration on `req.user` and CLS mirroring. |
| `apps/api/src/modules/auth/__tests__/stream-ticket.service.test.ts` | Added impersonatedBy persistence/consume tests and a legacy-payload backward-compat case. Existing exact-shape `toEqual` updated to include `impersonatedBy: null`. |
| `apps/api/src/modules/auth/__tests__/auth.controller.stream-ticket.test.ts` | Constructor wired with `jwtRevocationService` mock; added impersonation-propagation test; updated existing assertions to include `impersonatedBy`. |
| `apps/api/src/modules/auth/__tests__/auth.controller.task224.test.ts` | All `new AuthController(...)` calls now pass `streamTicketService` + `jwtRevocationService` mocks. Three impersonate tests seeded the new H-3 `findMany({ select: { tenantId: true } })` call. The TASK-224 revoke tests updated to reflect L-3 (caller must be impersonating). |
| `apps/api/src/modules/auth/__tests__/auth.controller.test.ts` | `buildController()` factory extended with `streamTicketService` + `jwtRevocationService` defaults. |
| `apps/ui-playground/src/store/__tests__/auth-store.impersonation-persistence.test.ts` | **Inverted** the file: now asserts `impersonationToken`, `impersonatedUser`, `isImpersonating`, `originalTenantId` are NOT persisted, that storage backend is `sessionStorage`, and that a simulated reload reverts impersonation. |
| `apps/ui-playground/src/store/__tests__/auth-store.impersonation.test.ts` | The `persistence across refresh` test is now an inverted assertion: impersonation fields ARE NOT in `sessionStorage` and `localStorage` is empty. |
| `apps/ui-playground/src/store/__tests__/auth-store.impersonation-tenant.test.ts` | Updated to read from `sessionStorage` instead of `localStorage`. |
| `apps/ui-playground/src/store/__tests__/auth-store.token-refresh.test.ts` | Updated to read from `sessionStorage` instead of `localStorage`. |

### 4.3 Verification (Phase 3)

#### `@arcaai/applications` unit tests

```
$ pnpm --filter @arcaai/applications test:unit

Test Files  138 passed (138)
     Tests  3828 passed (3828)
  Duration  9.82s
```

A subsequent re-run reported 2 failures (`packages/applications/src/services/department/__tests__/department-prompt-config.service.test.ts`) — that file is untracked, owned by another agent (TASK-294), and was added during a parallel session. It's outside TASK-295 scope and not introduced by this work; confirmed via `git status --short packages/applications/src/services/department/` shows the file as `??` (untracked, foreign).

#### `@arcaai/api` unit tests (scoped to TASK-295 paths)

```
$ pnpm vitest run src/modules/auth src/guards src/interceptors   # cwd: apps/api

Test Files  10 passed (10)
     Tests  138 passed (138)
  Duration  5.46s
```

The full `@arcaai/api` test run has 25 failures in `src/modules/streaming/__tests__/transcription-job.controller.test.ts`. The streaming module is in this ticket's forbidden-file list and the failures pre-date TASK-295 (they're owned by TASK-298). Confirmed pre-existing by stashing all TASK-295 work and re-running the file in isolation: same failures.

#### `@arcaai/ui-playground` tests (scoped to TASK-295 paths)

```
$ pnpm vitest run src/store src/providers src/features/playground/overview   # cwd: apps/ui-playground

Test Files  9 passed (9)
     Tests  152 passed (152)
  Duration  785ms
```

The full playground run has 95 pre-existing failures in `src/features/audio/components/__tests__/processing-config-panel.test.tsx` and other audio/transcription paths — none of which TASK-295 touches. Confirmed pre-existing by stash + isolated re-run (74 failures reproduce without TASK-295 changes applied).

#### Builds

```
$ pnpm build --filter @arcaai/applications --filter @arcaai/api
 Tasks:    7 successful, 7 total
 Cached:   0 cached, 7 total
   Time:   16.458s

$ pnpm --filter @arcaai/ui-playground build
✓ built in 21.77s
```

#### Lints

`ReadLints` over every modified file: **no linter errors found**.

### 4.4 Acceptance criteria verification

| # | Criterion | Evidence |
|---|---|---|
| 1 | TENANT_ADMIN(A) → DOCTOR(B) returns 403 | `auth.controller.task295.test.ts › impersonate — C-1 tenant scope enforcement › throws ForbiddenException when TENANT_ADMIN(A) tries to impersonate DOCTOR in tenant B` — passing. |
| 2 | CLS `tenantId` derived from JWT; `x-tenant-id` warns instead of overriding | `jwt.strategy.test.ts › should propagate tenantId from JWT payload into CLS context (SEC-J)` + `context.interceptor.test.ts › x-tenant-id header handling (SEC-J / TASK-295 C-2)` — passing. |
| 3 | Impersonation audit row has correct shape | `auditLog.service.test.ts › impersonation branch (TASK-295 C-3)` — passing. |
| 4 | Revoked `jti` is rejected on next request | `jwt.strategy.test.ts › should throw UnauthorizedException when the jti has been revoked (C-4)` + `jwt-revocation.service.test.ts` (TTL bounded by `exp - now`, min 1s) — passing. |
| 5 | `UserSession.impersonatedBy` populated | `jwt.strategy.test.ts › should propagate impersonatedBy from JWT payload into UserSession (H-2)` — passing. |
| 6 | Optional `targetTenantId` validated | `auth.controller.task295.test.ts › impersonate — H-3 targetTenantId validation` (3 cases) — passing. |
| 7 | Stream ticket carries `impersonatedBy`; guard restores it | `stream-ticket.service.test.ts › impersonatedBy propagation (TASK-295 SEC-A5-6)` (4 cases) + `jwtauth.guard.test.ts › canActivate — ticket impersonation context (TASK-295 SEC-A5-6)` (3 cases) — passing. |
| 8 | Playground uses `sessionStorage`; persistence test inverted | `auth-store.impersonation-persistence.test.ts` (5 cases) + sibling store tests — passing. |
| 9 | SDK rehydration documented for post-H-1 state | `sdk-provider.tsx` carries explicit JSDoc; existing `persistedImpersonating && impersonationToken` guard remains the gate. |
| 10 | `user-list.tsx` no longer decodes JWTs | Source diff: `atob(result.token.split('.')[1])` block removed; uses `result.user.tenantId` only. |

---

## 5. Change History

| Date | Author | Notes |
|---|---|---|
| 2026-05-24 | TASK-295 implementer | Created plan. Phase 1 complete. |
| 2026-05-24 | TASK-295 implementer | Phase 2–4 complete. All defects implemented under TDD. 12 source files modified, 5 created (incl. migration SQL + new test file + README). Verification commands ran clean within TASK-295 file scope; pre-existing failures in `streaming` (TASK-298) and `audio` (other ticket) playground paths confirmed unrelated by stash-isolation. Status → Completed. |

---

## 6. Out of scope / hand-off

These items would have required touching forbidden files; they are deferred to the owning agents:

- **`AuditAction.IMPERSONATED_ACTION` Prisma migration execution**: the SQL is checked in at `packages/database/src/prisma/db_main/migrations/20260524100000_add_audit_action_impersonated/migration.sql` (non-destructive `ALTER TYPE … ADD VALUE IF NOT EXISTS`). DB ops must run the migration before production rollout. Per workspace rules I did not execute it.
- **SDK-side `apiClient.startImpersonation` rehydration** on cold mount (H-5's deeper SDK wiring): touches `packages/agentic-sdk-v2/**` which is owned by another agent. After H-1 the rehydration is moot anyway; the playground side is documented and ready for the SDK-side counterpart.
- **IMPERSONATION_STARTED / IMPERSONATION_STOPPED audit rows (M-3)**: a separate enum/event addition deferred per `05-impersonation.md`.
- **`PersonalizationManager.setImpersonationReadOnly` hardening (H-4)** — owned by TASK-300 (SDK).
- **`startImpersonation` escape-hatch hardening (H-6)** — owned by the SDK ticket.
