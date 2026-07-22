# TASK-541 — Auth Token Revocation & HIPAA Auth-Event Audit Closure

| | |
|---|---|
| **Status** | Review |
| **Type** | bugfix / security-compliance |
| **Created** | 2026-07-21 |
| **Origin** | TASK-536 Pre-Release Comment Cleanup, Wave 1 finding 3 (`docs/implementation/TASK-536-Pre-Release-Comment-Cleanup/README.md`) |
| **Findings register** | TASK-539 findings #1 and #2 (`docs/implementation/TASK-539-Continuous-Quality-Assessment/README.md`; to be mirrored into `SOTA-Track/findings-register.md` when it materializes at cycle-1 start) |
| **Related tickets** | TASK-295 (C-4 jti revocation), TASK-307 (W1.4 logout revocation, W1.6 jti hygiene), TASK-314/369 (audit direct-write + envelope encryption), TASK-331 (impersonation lifecycle audit), TASK-343 (UnifiedAuthGuard consolidation), TASK-387 (SUSPENDED status), TASK-430 (service accounts) |
| **Numbering note** | Originally drafted as TASK-540; renumbered to **541** because a concurrent session claimed 540 for `TASK-540-Eslint-Suppression-Debt`. All code markers, test filenames and cross-references were renumbered with it. |

## Requirement Analysis

The TASK-536 comment-debt inventory confirmed two live security/compliance TODOs in
`packages/applications/src/services/auth/auth.service.ts` (both re-verified present
before work began):

1. **`isTokenRevoked()` always returns `false`** (line ~63) — the `IAuthService`
   revocation contract is a stub, so any consumer trusting it gets no revocation
   enforcement at all.
2. **`trackAuthentication()` has no persisted HIPAA-compliance audit trail**
   (line ~108) — HIPAA §164.312(b) requires access tracking to be recorded and
   reviewable.

Required outcome:

- A Redis-backed revocation list that is **actually consulted on the enforced auth
  path** (`UnifiedAuthGuard` → `JwtAuthGuard` → `JwtStrategy`), with a single source
  of truth — no stub implementations that silently no-op.
- Persisted authentication-event audit records via the existing sys-event /
  `AuditLog` pipeline, covering the events HIPAA cares about: successful logins,
  **failed attempts**, and logout/revocation.
- Tests locking both behaviors.
- Both TODO comments **resolved in code, never deleted as narration** (TASK-536 rule).

## Current State Evaluation (verified 2026-07-21)

The picture was materially better than the TODOs suggested — most of the target
architecture already existed, but on a different code path from the stubs.

### Revocation — what already existed

- `JwtRevocationService` (`services/auth/jwt-revocation.service.ts`, TASK-295 C-4):
  Redis-backed set `jwt-revoked:<jti>` with TTL bounded by the token `exp`, behind
  the `IJwtRevocationService` symbol token.
- The **enforced** chain — global `APP_GUARD` `UnifiedAuthGuard` → injected
  `JWT_AUTH_GUARD` (`JwtAuthGuard`, passport `'jwt'`) → `JwtStrategy.validate` —
  **already called `isRevoked(payload.jti)` on every request** and 401'd revoked
  tokens.
- Revocation was already triggered by `/auth/logout` (access-token jti + refresh
  family) and `/auth/revoke-impersonation`. All issued tokens carry an
  unpredictable `randomBytes(16)` jti (TASK-307 W1.6).

### Revocation — actual gaps

- **G1 (the TODO):** `AuthService.isTokenRevoked()` hardcoded `false`. Its only
  caller was `GatewayJwtStrategy`, whose guard `GatewayAuthGuard` was registered but
  **used by zero routes** — a dead path, but a loaded footgun: wiring that guard to
  any route would yield a strategy that *looks* like it enforces revocation and does
  not.
- **G2:** `JwtStrategy` **fails open** — a Redis error was swallowed and treated as
  "not revoked", with no signal. Acceptable for availability, but an explicit owner
  decision for a PHI platform, not an accident.
- **G3:** **No revocation on user deactivation/suspension/soft-delete** — a disabled
  user's access token remained valid until its own `exp`. Per-jti revocation cannot
  cover this because issued jtis are not tracked per user.

### Auth-event audit — what already existed

`AuthService` emits `EventTypes.UserAuthenticated`;
`AuditLogService.handleUserAuthenticatedEvent` consumes it **directly** (not via the
Redis queue — deliberate, for immediate trail creation) and persists a LOGIN /
IMPERSONATION `AuditLog` row through the sanctioned unscoped write,
envelope-encrypted (TASK-369). **The `:108` TODO's premise was therefore stale for
successful logins — that trail has existed since TASK-314/369.**

### Auth-event audit — actual gaps

- **G4:** The `UserAuthenticated` bracket is **success-only**. Failed attempts (bad
  credentials, disabled account, revoked/expired token) produced structured warn logs
  only — no persisted `AuditLog` row. HIPAA access-control auditing expects failed
  access attempts to be reviewable.
- **G5:** `trackAuthentication` itself was only invoked by the dead
  `GatewayJwtStrategy`, so its TODO sat on a method that never ran in production.

## Owner Decisions

| ID | Decision | Rationale |
|---|---|---|
| **A2** | **RETIRE** `GatewayJwtStrategy` + `GatewayAuthGuard` + `gateway-decorators` | Wired to zero routes; `UnifiedAuthGuard` (TASK-343) is the single mandated enforcement point, and a second strategy would have to be kept security-equivalent by hand forever. |
| **A3** | Fail **OPEN** for ordinary tokens, fail **CLOSED** for impersonation tokens | A Redis outage must not black out every authenticated request (the token is still signature- and expiry-checked). Impersonation is the highest-privilege credential on the platform and its revoke path is the one most likely exercised under duress, so refusing it costs one break-glass session rather than platform availability. |
| **A4 TTL** | Per-user not-before TTL **24 h**; comparison `iat <= notBefore` (deny-on-tie) | Must exceed the longest access-token lifetime (`JWT_EXPIRES_IN`, default `1h`); 24× margin with a bounded keyspace. Deny-on-tie: a token minted in the same second as a deactivation must lose, else a just-disabled user keeps a full token lifetime. |

## Implementation Plan

### Phase A — Revocation convergence (single source of truth)

1. **A1** — `AuthService.isTokenRevoked` delegates to `IJwtRevocationService`
   (`@Optional()`, mirroring `JwtStrategy`). Resolves the `:63` TODO.
2. **A2** — retire the dead `gateway-jwt` path (strategy, guard, decorators, tests).
3. **A3** — surface store-unavailability instead of swallowing it: `checkRevoked()`
   returns `{ revoked, degraded }`; the strategy owns the posture.
4. **A4** — per-user not-before (`auth:user-nbf:<userId>` → epoch seconds), stamped
   on deactivate/suspend/soft-delete, consulted in `JwtStrategy`. No schema change.

### Phase B — Auth-event audit closure

5. **B1** — new `EventTypes.UserAuthenticationFailed`, emitted from the auth failure
   sites, handled by `AuditLogService` alongside the success handler with
   `success: false`. Rate-limit consideration: scope to identified-actor failures,
   not anonymous 401 noise.
6. **B2** — resolve the `:108` TODO by pointing at the persistence authority.

### Phase C — Tests & verification

7. Unit tests at each layer (RED before GREEN).
8. API e2e: logout → replay token → 401; deactivate user → token 401; failed login →
   queryable audit row.
9. Gates: build + `test:unit` + `test:e2e` + lint, evidence captured below.

### Phase D — `resourceStatus` SUSPENDED no-op (added on owner instruction)

10. `applyChangesToEntity`'s status switch had no `SUSPENDED` branch, so that status
    silently no-opped. Add `BaseEntity.suspend()` and make the switch exhaustive.

### Out of scope

- Refresh-token rotation/family revocation (already shipped, TASK-307).
- Per-request PHI access auditing (`ResourceViewed` sys-events own that).
- SSO/SAML assertion validation hardening (TASK-499 gate).

## Implementation Summary

### A — Revocation convergence

- **A1** `AuthService.isTokenRevoked` now delegates to `IJwtRevocationService`; the
  `:63` TODO is resolved and the stub is gone.
- **A2** Deleted `gateway-auth.strategy.ts`, `gateway-auth.guard.ts`, their two test
  files, and `decorators/gateway-decorators.ts`; removed the barrel exports, the
  `AuthServiceModule` provider/export, the Task-3.5 block in
  `auth-secrets-migration.test.ts`, and five stale comment references.
  `RateLimitOptions` — the one genuinely-used export of the decorators module — was
  **relocated** into `rate-limiting.service.ts` (its only consumer).
- **A3** `JwtRevocationService.checkRevoked()` returns `{ revoked, degraded }`;
  `isRevoked()` remains a thin back-compat wrapper.
  `JwtStrategy.assertNotRevoked()` applies the posture from the decision table.
- **A4** New per-user axis: `revokeAllForUser()` / `getUserNotBefore()`.
  `UserService.update()` (any transition away from `ENABLED`) and `deleteById()`
  stamp it AFTER the row commits; `JwtStrategy` refuses tokens with
  `iat <= notBefore`. Best-effort: a Redis failure never rolls back the mutation.
- **Wiring** `JwtRevocationModule` extracted so `UserServiceModule` consumes the
  authority without a circular import back through `AuthServiceModule`. Both lookups
  run under `Promise.all`, so the hot path costs one round-trip of wall-clock.

### B — Failed-authentication audit

- **B1** New `EventTypes.UserAuthenticationFailed` + typed
  `AuthenticationFailedEventPayload`.
  `AuditLogService.handleUserAuthenticationFailedEvent` writes a
  `LOGIN`/`AUTHENTICATION` row with `success: false` through the same sanctioned
  unscoped, envelope-encrypted path as the success handler, carrying a
  machine-readable `reason` slug and `attemptedUsername`. Only whitelisted fields
  reach the row, so a widened payload cannot spill a credential.
  `AuthController` emits from **one funnel** in the login `catch`
  (`missing_credentials`, `unknown_or_disabled_user`, `invalid_password`,
  `service_account_interactive_login`, `tenant_key_required`,
  `tenant_access_denied`) plus the two refresh rejection paths
  (`refresh_token_rejected`, `user_disabled_or_missing`).
  No `AuditAction`/`ResourceType` enum additions ⇒ no migration, no enum-parity work.
- **B2** The `:108` TODO is resolved; `trackAuthentication`'s docblock now names
  `AuditLogService.handleUserAuthenticatedEvent` as the persistence authority.

### D — SUSPENDED no-op

- Added `BaseEntity.suspend()` (mirrors `disable()`, reversible via `enable()`) and
  the `isSuspended` getter for symmetry.
- Extracted `applyResourceStatus()` with an **exhaustive** switch: a
  `const unhandled: never = status` assignment makes a future `ResourceStatusType`
  member a COMPILE error, and the accompanying throw is the runtime backstop so an
  unrecognised status is a loud `ArgumentInvalidException` instead of a write that
  reports success and changes nothing.
- Revocation (A4) keys off the REQUEST, not the entity, so suspends already killed
  live tokens before this fix — the gap was purely the status write.

### Defects found and fixed while implementing

1. **`Repository.findFirst` throws, never returns null** (`repository.ts:117`), so
   `login()`'s `if (!user)` branch was unreachable: an unknown username fell to the
   catch-all and answered `'Authentication failed'` while a wrong password answered
   `'Invalid credentials'` — a **username-enumeration oracle** contradicting the
   intent stated in the surrounding comment. Both branches are now indistinguishable
   to the client while still recording distinct audit reasons server-side. The same
   bug in `refresh()` surfaced a raw `DataNotFoundException` (→ 404) instead of 401
   for a disabled account.
2. **A throwing event bus turned a 401 into a 500.** `EventEmitter2.emit` is
   synchronous, so an unguarded audit emission in the catch block propagated — an
   audit outage becoming an authentication outage, and a failure-mode oracle.
   Contained unconditionally.
3. **Nest rejects re-exporting a token the module no longer provides** —
   `AuthServiceModule` must re-export `JwtRevocationModule`, not
   `IJwtRevocationService`. Caught only at container boot, not by build or unit tests.
4. **A unit-test double lied about the repository contract** (resolved `null` where
   production throws), which is why defect 1 hid from the unit layer. The double now
   mirrors the throwing contract and a regression test pins the uniform 401.

## Verification Evidence (2026-07-21)

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/{database,domains,applications,api} build` | all green |
| `pnpm test:unit` (workspace) | **16 915 passed**, 4 skipped, 9 todo, **0 failed** |
| `pnpm --filter @arcaai/domains test` | 1 373 passed |
| `pnpm --filter @arcaai/applications test` | 6 649 passed |
| Affected suites (auth + user + auditLog + rateLimiting + api auth) | 989 passed |
| SUSPENDED suites (baseEntity + applyChangesToEntity) | 116 passed |
| Lint (changed files) | 0 errors, **0 net-new warnings** |
| **E2E vs live API + real Redis + real audit table** | **90/90 passed** (`auth-revocation-audit.spec.ts` 5/5 plus auth / auth-refresh / auth-advanced / auth-guard-behavior / audit-log) |
| Full E2E suite | 490 passed / 30 non-passing, all in unrelated specs and pre-existing |

E2E spec `apps/api/tests/e2e/auth-revocation-audit.spec.ts` pins the three
invariants unit tests can only mock — A: logout → replayed access token 401;
B: disable user → live token 401; C: failed login writes a queryable `success:false`
row, never contains the attempted password, and a successful login emits no failure
row.

**Pre-existing failures observed (NOT introduced here, ticketed separately):**
`authorization.spec.ts` — 8 failures cascading from a `beforeAll` asserting
`service_account` can log in interactively, which committed TASK-430 (`c8850f4f`)
deliberately blocks.

## Files Changed

**`packages/domains`** — `common/events/eventTypes.ts`,
`common/baseEntity/base.entity.ts` (+ its test).

**`packages/applications`** — `services/auth/jwt-revocation.service.ts`,
`services/auth/jwt-revocation.module.ts` (new), `services/auth/jwt.strategy.ts`,
`services/auth/auth.service.ts`, `services/auth/auth.service.module.ts`,
`services/auth/index.ts`, `services/user/user/user.service.ts` (+ module),
`services/auditLog/auditLog.service.ts` (+ `IAuditLogService.ts`),
`common/typed-event-emitter.ts`, `common/applyChangesToEntity.ts`,
`decorators/index.ts`, `services/baseServices/rateLimiting/rate-limiting.service.ts`.
**Deleted:** `services/auth/gateway-auth.{strategy,guard}.ts` + their `__tests__`,
`decorators/gateway-decorators.ts`.

**`apps/api`** — `modules/auth/auth.controller.ts`, `main.ts` (comment).

**Tests** — `jwt-revocation.service.test.ts` (+24), `jwt.strategy.test.ts` (+11),
`auth.service.test.ts` (stub-asserting blocks rewritten as delegation),
`user.service.task541.test.ts` (new, 10), `auditLog.service.task541.test.ts`
(new, 8), `auth.controller.task541.test.ts` (new, 12),
`applyChangesToEntity.test.ts` (new, 14), `base.entity.test.ts` (+5),
`auth-revocation-audit.spec.ts` (new e2e, 5).

## Phase E — Follow-up closure (2026-07-21)

### E1 — Dead `IAuthService` surface REMOVED (was an open owner decision)

The A2 retirement left `isTokenRevoked()` and `validateUser()` with zero callers
(the `gateway-jwt` strategy was their only consumer). Both are now **removed** from
`IAuthService` and `AuthService`, along with the `UserValidationResponse` shape and
the now-orphaned `IJwtRevocationService` injection on `AuthService`.

Removal — rather than keeping them as "correct but unused" public API — because both
were actively misleading, which is the same defect class this ticket exists to close:

- `isTokenRevoked` was a **façade over the real authority**. Revocation belongs to
  `IJwtRevocationService` (Redis-backed, consulted by `JwtStrategy` under
  `UnifiedAuthGuard`), which stays exported and injectable. Keeping a second way to
  ask the same question re-creates exactly the drift A2 set out to end.
- `validateUser` returned **`isActive: !user.isDeleted`**, and `isDeleted` only means
  `resourceStatus === DELETED`. A **DISABLED or SUSPENDED user therefore reported
  `isActive: true`** — a silent lie of precisely the kind the `isTokenRevoked` stub
  told, and one that would have quietly defeated the A4 deactivation work had anyone
  wired it up. `departmentId` was also hardcoded `undefined` despite being in the
  response shape.

`IAuthService` now carries only its two live methods (`getOrCreateOidcUser`,
`trackAuthentication`). A comment at the interface records what was removed and
directs any future caller to read `resourceStatus` (plus the per-user not-before
stamp) rather than resurrecting the old shape.

### E2 — TASK-536 finding 3 CLOSED, Wave 4 unblocked

Verified: `auth.service.ts` carries no live TODO, and neither original TODO string
(`"Implement token revocation checking"`, `"For HIPAA compliance, we need to track"`)
exists anywhere in the repo. Both were resolved in code, never deleted as narration —
the rule finding 3 was written to protect. TASK-536's Change History records the
closure and warns Wave 4 that the `auth.service.ts` surface is now smaller than its
Wave 1 inventory recorded.

## Remaining / Follow-ups

- **Commit.** This ticket's work was twice disrupted by concurrent sessions in the
  same working tree (unstaged edits reverted, untracked files deleted, the ticket
  document removed). Staging is the only thing that survived both events, and it will
  not survive a `git reset --hard` or `git checkout HEAD --`.
- **Collateral damage from the 2026-07-21 cleanup is narrower than first reported**
  (assessed here, ticketed separately): TASK-533 B6's Prisma model, migration,
  `ResourceType` value, tenant-scope entry, full domain trio, `CoreDatabaseModule`
  registration, and BOTH the dev and test database tables all **survived**. Only
  `packages/applications/src/services/gate-edit-mining/` and the harness-admin
  controller endpoint are missing. No database repair is needed.

## Change History

- **2026-07-22** — TASK-536 de-ticketing (R5 reference update): `task-541-auth-revocation-audit.spec.ts` renamed to `auth-revocation-audit.spec.ts`; references above updated.
- **2026-07-21** — Phase E: closed both open follow-ups. `isTokenRevoked()` /
  `validateUser()` / `UserValidationResponse` REMOVED from `IAuthService` (dead after
  A2, and `validateUser` reported DISABLED/SUSPENDED users as active); TASK-536
  finding 3 closed and Wave 4 unblocked with verification. Re-verified after removal:
  16 906 unit tests passing, 90/90 auth+audit e2e, 0 lint errors. Collateral damage
  from the concurrent-session cleanup re-assessed against the live databases — far
  narrower than reported; only the gate-edit-mining service module is actually gone.
- **2026-07-21** — Renumbered TASK-540 → **TASK-541** after a concurrent session
  claimed 540 for the ESLint-suppression-debt ticket; ticket directory, four test
  filenames, all in-code markers and the TASK-536 cross-reference updated together.
  Ticket document recreated in full.
- **2026-07-21** — A2 retirement executed on owner instruction (gateway
  strategy/guard/decorators deleted; `RateLimitOptions` relocated). Phase D added:
  SUSPENDED no-op fixed with `BaseEntity.suspend()` + an exhaustive,
  compile-checked status switch.
- **2026-07-21** — Phases A, B, C implemented TDD (RED observed before every fix).
  Owner decisions A2/A3/A4-TTL recorded. Four defects found and fixed, two
  security-relevant (the username-enumeration oracle and the audit-emitter 401→500
  escalation). Runtime-verified end-to-end. Status → Review.
- **2026-07-21** — Ticket created from TASK-536 Wave 1 finding 3, which gated its
  Wave 4 cleanup on this ticket existing. Both TODOs re-verified present at
  `auth.service.ts:63` / `:108` before scoping.
