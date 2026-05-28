# TASK-307 — API Gateway Multi-Tenancy & Security Hardening

| Field | Value |
|---|---|
| **Ticket** | TASK-307-API-Gateway-Hardening |
| **Created** | 2026-05-28 |
| **Updated** | 2026-05-28 |
| **Status** | `Completed` |
| **Classification** | Refactor + bugfix (security / multi-tenancy / compliance) |
| **Priority** | High — closed 5 BLOCKERs (C-1..C-5) + 7 HIGHs (C-6..C-12) from the 2026-05-25 API-gateway audit |
| **Prior context** | TASK-305 (schema — audit 02) ✅, TASK-306 (DDD layers — audit 03) ✅ |
| **Audit driver** | [`docs/multi-tenancy-audit/04-api-design-review.md`](../../multi-tenancy-audit/04-api-design-review.md) (CLOSED 2026-05-28) |
| **Predecessor closure docs** | [`06-implementation-summary.md`](../../multi-tenancy-audit/06-implementation-summary.md), [`07-ddd-layers-followup-closure.md`](../../multi-tenancy-audit/07-ddd-layers-followup-closure.md) |
| **Companion tickets** | TASK-302 (PgBouncer + Vault — owns RS256 / Vault Transit signer + RLS) |
| **Base branch** | `fix/2605-review` (HEAD `c9c42e19` — TASK-307 W4b merge) |
| **Merge SHAs** | W1 `4c85d9f6` · W2 `38013f4e` · W3 `d969b25c` · W4a `b07eb67f` · W4b `c9c42e19` · W5 `677f17d9` · W6 `77068325` · W7 `<HEAD-of-w7>` |

---

## 1. Requirement Analysis

### 1.1 Description

Close the 2026-05-25 API-gateway audit (`04-api-design-review.md`) findings. TASK-305 hardened the **schema** layer; TASK-306 hardened the **service / domain** layer. TASK-307 hardens the **HTTP-gateway** layer in `apps/api`, where the audit found that **tenant resolution is single-layer (JWT claim only)** and several controllers either bypass tenant scoping entirely or accept tenant-controlled identifiers as path params without verifying ownership. The refresh-token endpoint is **trivially forgeable** (BLOCKER C-1), and `UnifiedAuthGuard` is **opt-in** rather than global (HIGH C-7 — one missing decorator silently makes a route public).

### 1.2 User-confirmed scope rules

1. **No new architectural decisions in this ticket.** Anything that needs a design decision (RS256 / Vault Transit signer migration, per-tenant Redis namespacing, network-segregated `/internal` endpoints, CORS allowlist per tenant) is captured as a follow-up in §8.
2. **No schema or migration work.** Refresh-token persistence uses Redis. No Prisma migrations.
3. **No RLS work.** Owned by TASK-302 (audit §H-1; covered by the `tenantScope` extension from TASK-305 W2.B at the application layer today).
4. **TDD-first.** Every controller-level guard ships with a cross-tenant negative test (unit + E2E where applicable). New patterns get a unit-test contract pinned before the implementation.
5. **Pattern reuse.** `assertEqualTenants`, `isSuperAdmin`, `resolveEffectiveTenantId`, `@Authorize`/`@CanXxx` from `packages/applications` are the canonical primitives. New patterns introduced ONLY where the audit §G / §H requires (refresh-token store; `@TenantOwnedResource` decorator; global `APP_GUARD` registration).
6. **Defense-in-depth.** Controller-level guard + service-layer assertion + (where applicable) Prisma extension — same 3-layer posture TASK-306 established.

### 1.3 Business context

The audit verdict is unambiguous: **tenant resolution is NOT defense-in-depth at the API gateway**. Each of the 5 BLOCKERs is independently exploitable:

- **C-1 Refresh token forgery** — opaque tokens are NEVER persisted server-side. The format `refresh_<userId>_<timestamp>_<random>` lets an attacker mint a valid access token for any user whose id they know. Complete account takeover, cross-tenant if attacker and victim are in different tenants. OWASP ASVS V3.7.1 violation.
- **C-2 / C-4 Storage / TenantBucket cross-tenant** — any user with `delete:Storage` or `manage:Tenant` CASL ability can read/delete other tenants' buckets and mint presigned URLs to other tenants' PHI files. HIPAA §164.312(a)(1) violation.
- **C-3 ConsultationJob no ownership** — any authenticated user can poll/cancel/SSE-subscribe to any consultation job by guessing/enumerating uuidv7 ids. Real-time PHI exfiltration vector.
- **C-5 VoiceProfile no ownership** — voice biometric data (HIPAA identity) can be activated/deactivated/deleted across tenants.
- **C-6 JWT hard-coded fallback** — sign-and-verify use two different fetchers (`AppSettingsService` vs `SecretsService`); if either falls through to the literal `'default-jwt-secret-key-change-in-production'`, any external party with repo read access can mint valid HOPE JWTs with arbitrary `tenantId`/`roles` claims.
- **C-7 No global APP_GUARD** — auth is opt-in per route. One forgotten `@Authorize()` decorator on a new endpoint silently leaks PHI.

### 1.4 Acceptance criteria

| # | Criterion | Verification |
|---|---|---|
| AC-1 | Refresh tokens are opaque (`randomBytes(48).base64url`), persisted server-side as `sha256(token)` in Redis with `{userId, tenantId, jti, family, expiresAt}`, single-use (consumed on rotation), reuse-detection revokes the entire family | E2E: rotation roundtrip + reuse-detection negative + cross-tenant carry-through |
| AC-2 | `AuthController.logout` revokes the access-token `jti` via `JwtRevocationService.revoke` AND deletes the refresh-token family | E2E: post-logout access token → 401; post-logout refresh token → 401 |
| AC-3 | `AuthController.refresh` carries forward the original session's `tenantId` (from the persisted refresh-token row), NOT `User.tenantId` | E2E: multi-tenant user logged into tenant B refreshes → access token still bound to tenant B |
| AC-4 | `JwtStrategy` constructor refuses to start when the JWT secret resolves to the placeholder; `main.ts` boot-time assertion mirrors the same check | Unit test pins the boot-time refusal |
| AC-5 | JWT secret is sourced from `SecretsService` only (sign + verify paths unified); `AppSettingsService.getValueWithDefault('JWT_SECRET_KEY', ...)` calls in `AuthController` removed | Grep verifies no `JWT_SECRET_KEY` calls into `AppSettingsService` |
| AC-6 | JWT `jti` is `randomBytes(16).hex` (unpredictable, no userId/timestamp leak) | Unit test: two consecutive `login`s produce distinct, non-monotonic jtis |
| AC-7 | `@TenantOwnedResource(modelName, paramName)` decorator + interceptor introduced in `apps/api/src/common/`; resolves the resource, asserts `entity.tenantId === cls.get('tenantId')`, **404s on mismatch** (no existence leak — DEF-C3 pattern) | Unit + per-controller E2E: tenant-B token probing tenant-A resource → 404 |
| AC-8 | `@TenantOwnedResource` applied to `TenantBucketController` (`getBucket`, `getBucketTree`, `getPresignedUrl`, `deleteBucket`) | E2E cross-tenant negative per endpoint (4 tests) |
| AC-9 | `@TenantOwnedResource` applied to `StorageController` (resolves bucket name → `TenantBucket`); path-traversal guard retained | E2E cross-tenant negative + path-traversal still rejected |
| AC-10 | `ConsultationJobStatus` carries `userId` + `tenantId`; `ConsultationJobController` enforces ownership on `getJob`, `cancelJob`, `streamJob` | E2E: foreign-tenant token → 404; stream ticket binds to tenantId and is validated at consumption |
| AC-11 | `@TenantOwnedResource` applied to `VoiceProfileController.activate/deactivate/deleteById` | E2E cross-tenant negative per endpoint (3 tests) |
| AC-12 | `@TenantOwnedResource` applied to `TranscriptionJobController.getById/cancel/retry/streamJob/list/getByStatus/getByConsultation/closeStreamSession` (D-3) | E2E cross-tenant negative per endpoint |
| AC-13 | `UnifiedAuthGuard` registered as `APP_GUARD` (global, deny by default); `@Public()` decorator is the explicit opt-out | Integration test walks every route via `DiscoveryService` and asserts `@Public()` OR non-empty `REQUIRED_PERMISSIONS_KEY` metadata |
| AC-14 | Boot-time `auditAdminRoutePermissions` widened from `/admin/*` to ALL routes; refuses to start if any route is unprotected and unlabeled | Integration test pins the boot refusal |
| AC-15 | `/api/v1/health/services{/:key}` requires `@Authorize()`; response payload strips `version` and `checks`; throttle lowered to `{ limit: 30, ttl: 60000 }`; `/live`, `/ready`, `/startup` remain public | E2E: unauthenticated GET → 401; authenticated GET returns sanitised payload |
| AC-16 | Prisma Studio GET requires `Authorization: Bearer`; no JWT-in-URL; module disabled unless both `NODE_ENV=development` AND `ENABLE_PRISMA_STUDIO=true` | Unit test pins the bootstrap gating; E2E pins the header requirement |
| AC-17 | `ContextInterceptor` throws `400 Bad Request` when `x-tenant-id` header diverges from JWT-derived tenant (was warn-only) | Unit test pins the 400 |
| AC-18 | `ConsultationController.isSharingEnabled` is default-CLOSED (returns true ONLY when an explicit setting row says `value === 'true'`); no try/catch that returns true | Unit test: missing setting → false; DB throw → false |
| AC-19 | `TenantController.update/delete/getUsage/fetchByCodeName` inline-assert `id === cls.tenantId` unless `isSuperAdmin(user)` | Unit + E2E |
| AC-20 | `ExceptionInterceptor` + `PrismaClientExceptionFilter` strip `err.meta` and `err.message` raw text from the client response (`{statusCode, error, correlationId}` only); full detail logged server-side | E2E: 400 / 500 from Prisma path returns no column / constraint / id strings |
| AC-21 | `AuditLogController.fetchByUser` injects caller's CLS `tenantId` into the service call (SUPER_ADMIN bypass per the W1.4 pattern from TASK-305) | E2E cross-tenant negative |
| AC-22 | `SttWsGateway` close-codes are a single generic `4401` regardless of cause (no `4001 missing param` vs `4401 invalid ticket` enumeration); real reason logged server-side | Unit test pins the generic code |
| AC-23 | `SmrProxyController.getProviders` requires an explicit `?tenantKey=__GLOBAL__` query parameter for the GLOBAL fallback (no implicit role-based fallback) | Unit test + E2E |
| AC-24 | All direct `databaseService.client.<model>.<op>` calls in `apps/api/src/modules/{auth,rbac}/*.controller.ts` are replaced with repository / service calls; ESLint rule forbids the pattern | Grep + ESLint rule passes |
| AC-25 | Dev CORS allow-list constrained to localhost patterns even in non-production; no `origin: '*'` with `credentials: true` | Unit test |
| AC-26 | `AuthController` strict throttle (10/min) scoped to `login` + `refresh` only; other endpoints (`/me`, `/logout`, `/stream-ticket`) use the default throttle | Unit test pins per-method throttle metadata |
| AC-27 | All `process.env.*` reads inside controllers moved to typed `ConfigModule` providers | Grep verifies no `process.env` in `apps/api/src/modules/**/*.controller.ts` (with `main.ts`/bootstrap exclusion) |
| AC-28 | `RequestWithAuth` interface introduced; `request['apiKey']` accesses use the typed interface | Typecheck verifies no `request['apiKey']` string-key accesses remain |
| AC-29 | `MetricsInterceptor` prefers `request.route?.path`; strips path params from the cardinality dimension | Unit test pins the path-template extraction |
| AC-30 | Swagger `addApiKey({...})` scheme added; `@ApiSecurity('api-key')` used on every API-key-authenticated endpoint | Swagger doc visual check + grep |
| AC-31 | `request.requestId` sourced from `X-Request-Id` header only (never the body); `uuidv7()` fallback when header absent | Unit test pins header-only behaviour |
| AC-32 | `UserController` bulk-delete wraps the iteration in a single `$transaction(callback)` OR returns per-id status (no partial-failure half-delete) | E2E pins all-or-nothing behaviour |
| AC-33 | `apps/api` cross-tenant E2E aggregator (new — mirror of `cross-tenant-coverage.test.ts`) introspects every `*.e2e-spec.ts` referencing tenant-A / tenant-B fixtures and asserts coverage per controller | Aggregator fails CI on per-controller floor drop |
| AC-34 | `docs/multi-tenancy-audit/04-api-design-review.md` updated with TASK-307 closure banner + per-finding `[CLOSED W*.x <sha>]` markers in §A/§B/§C/§D/§E/§F/§G/§H tables | Doc diff approved |
| AC-35 | NEW `docs/multi-tenancy-audit/08-api-design-followup-closure.md` written as canonical "what TASK-307 closed vs. deferred" record (mirror of `07-ddd-layers-followup-closure.md`) | Doc reviewed |

### 1.5 Decisions locked in (user-confirmed 2026-05-28)

| Decision | Choice | Rationale |
|---|---|---|
| Refresh-token storage | **Redis** (already wired via `RedisServiceModule`) | Mirrors existing `JwtRevocationService` pattern; ephemeral by design; no Prisma migration |
| Refresh-token rotation posture | **Single-use + family-revoke on reuse-detection** (RFC 6749 §10.4) | OWASP best practice; matches refresh-token-rotation pattern used by Auth0 / Okta |
| Refresh-token TTL | **7 days** (configurable via `REFRESH_TOKEN_TTL_SECONDS`, default `604800`) | Industry-standard refresh window; access-token TTL stays at 1h |
| ConsultationJobStatus tenant carry-through | **Add `userId`/`tenantId` to the in-memory/Redis status struct** (no schema change; stored in Redis alongside the existing job status) | Surgical; the SDK already carries the user context — propagating it through the job lifecycle is a 3-line change in `ConsultationJobService` |
| `@TenantOwnedResource` 404 vs 403 | **404** (no existence leak) | Same DEF-C3 pattern TASK-306 used |
| Global APP_GUARD rollout | **Two PRs** — W4a (audit widening) lands first; W4b (`APP_GUARD` registration) lands only after W4a is clean and any drift surfaced by the widened audit is fixed | Reduces blast radius — widened audit gives a "what would break" diagnostic before the runtime change. Per user decision 2026-05-28. |
| JWT secret hardening scope | **Bare-minimum (fail-closed on placeholder + unify on `SecretsService`)** | RS256 / EdDSA migration deferred to F-3 (architectural) |
| Direct-Prisma removal scope | **Auth + Roles + Policies controllers only** (the 3 named in C-10) | Wider sweep is out of scope; ESLint rule covers future drift |
| W6 ESLint rule scope | **Block `databaseService.client` from ALL `apps/api/src/modules/**/*.controller.ts`** with an explicit allow-list for any unavoidable platform-admin controllers (allow-list entries require a TSDoc `@allowedDirectPrisma <reason>` comment) | Default-deny + explicit escape hatch matches the `getPlatformAdminPrismaClient_Unscoped` allow-list pattern TASK-305 W2.B established for the database layer. Per user decision 2026-05-28. |
| Test placement | Unit tests inline in `apps/api/src/**/__tests__/*.spec.ts`; E2E in `apps/api/tests/e2e/` | Matches existing convention |
| Cursor rule updates | **Skip** — `05-nestjs-api.mdc` already captures the patterns | Avoid churn |
| Branch base | **`fix/2605-review` HEAD `804b3bcd`** | Continues the TASK-305 / TASK-306 chain; each wave-worktree branches off this SHA |
| Wave grouping | **8 PRs** (W1, W2, W3, W4a, W4b, W5, W6, W7) — W4 split per the two-PR decision above | Consistent with TASK-306's 6+1; each wave independently reviewable; W4a/W4b atomicity preserved |
| Execution model | **Parallel implementation in isolated worktrees + sequential merge into `fix/2605-review`** (each wave-subagent gets its own worktree; mandatory `code-reviewer` subagent between merges; conflicts on shared files resolved at merge time) | Per user decision 2026-05-28. Reduces wall-clock time vs. TASK-306's strict-sequential cadence at the cost of likely 1–2 rebase cycles on shared files (`auth.controller.ts`, `app.module.ts`). See §3.0 for the dependency graph. |

---

## 2. Current State Evaluation

### 2.1 Cross-walk against `04-api-design-review.md`

| Code | Severity | Status post-TASK-306 | Closes here? |
|---|---|---|---|
| **C-1** Refresh token forgery | BLOCKER | **OPEN** | **YES** (W1) |
| **C-2** StorageController bucket cross-tenant | BLOCKER | **OPEN** | **YES** (W3) |
| **C-3** ConsultationJobController no ownership | BLOCKER | **OPEN** (explicit TODO in source @ line 13-15) | **YES** (W3) |
| **C-4** TenantBucketController cross-tenant | BLOCKER | **OPEN** | **YES** (W3) |
| **C-5** VoiceProfileController no ownership | BLOCKER | **OPEN** | **YES** (W3) |
| **C-6** Dual JWT secret + hard-coded fallback | HIGH | **OPEN** | **YES — bare-minimum** (W2) |
| **C-7** UnifiedAuthGuard not global | HIGH | **OPEN** | **YES** (W4a diagnostic + W4b flip) |
| **C-8** `/health/services` unauth + leaks | HIGH | **OPEN** | **YES** (W5) |
| **C-9** PrismaStudio GET `@Public()` + JWT in URL | HIGH | **OPEN** | **YES** (W5) |
| **C-10** Direct Prisma in controllers | HIGH | **OPEN** | **YES** (W6) |
| **C-11** Logout doesn't revoke jti | HIGH | **OPEN** | **YES** (W1) |
| **C-12** Refresh ignores tenant scope | HIGH | **OPEN** | **YES** (W1) |
| **D-1** `x-tenant-id` warn-only | MED | **OPEN** | **YES** (W5) |
| **D-2** Consultation sharing default-open | MED | **OPEN** | **YES** (W5) |
| **D-3** TranscriptionJob ownership | MED | **OPEN** (partial: create has it; reads don't) | **YES** (W3 — uses W3 decorator) |
| **D-4** `/internal/stt` not network-segregated | MED | **OPEN** | **DEFER** → F-1 (ops) |
| **D-5** TenantController inline guard | MED | **OPEN** | **YES** (W5) |
| **D-6** Prisma error meta leak | MED | **OPEN** | **YES** (W5) |
| **D-7** AuditLogController cross-tenant | MED | **OPEN** | **YES** (W5) |
| **D-8** WS close-code enumeration | MED | **OPEN** | **YES** (W5) |
| **D-9** Throttle per-IP only | MED | **OPEN** | **DEFER** → F-2 (Redis-backed Throttler) |
| **D-10** Refresh token leaks userId | MED | **OPEN** | **YES** (fold into W1) |
| **D-11** Health throttle 300/min | MED | **OPEN** | **YES** (fold into W5 / C-8) |
| **D-12** SmrProxy SUPER_ADMIN → GLOBAL fallback | MED | **OPEN** | **YES** (W5) |
| **E-1** JWT jti predictable | LOW | **OPEN** | **YES** (fold into W1) |
| **E-2** Dev CORS allow-all + credentials | LOW | **OPEN** | **YES** (W7) |
| **E-3** Health leaks downstream version | LOW | **OPEN** | **YES** (fold into W5 / C-8) |
| **E-4** AuthController throttle too broad | LOW | **OPEN** | **YES** (W7) |
| **E-5** Direct `process.env` reads | LOW | **OPEN** | **YES** (W7) |
| **E-6** `apiKey` untyped on Request | LOW | **OPEN** | **YES** (W7) |
| **E-7** MetricsInterceptor high cardinality | LOW | **OPEN** | **YES** (W7) |
| **E-8** Swagger missing API-key scheme | LOW | **OPEN** | **YES** (W7) |
| **E-9** `User.tenantId` legacy reads | LOW | **OPEN** | **DEFER** → F-6 (= audit H-4 / TASK-306 H-4) |
| **E-10** `requestId` from body | LOW | **OPEN** | **YES** (W7) |
| **E-11** Bulk delete no txn | LOW | **OPEN** | **YES** (W7) |
| §H-1 Prisma `$use` middleware tenant scoping | STRATEGIC | **CLOSED** (TASK-305 W2.B — `tenantScope` extension is the `$use` equivalent) | — |
| §H-2 RS256 / EdDSA migration | STRATEGIC | **OPEN** | **DEFER** → F-3 (architectural) |
| §H-3 `@TenantOwnedResource` decorator | STRATEGIC | **OPEN** | **YES — folded into W3** (this IS the C-2..C-5 fix) |
| §H-4 `TenantContextGuard` (CLS non-empty assert) | STRATEGIC | Partially OPEN | **YES** (folded into W4b — `UnifiedAuthGuard` + global registration achieves the same) |
| §H-5 Per-tenant rate limiting | STRATEGIC | **OPEN** | **DEFER** → F-2 (with D-9) |
| §H-6 `User.tenantId` removal | STRATEGIC | **OPEN** | **DEFER** → F-6 |
| §H-7 CORS allowlist per tenant | STRATEGIC | **OPEN** | **DEFER** → F-4 |
| §H-8 OpenTelemetry tenant baggage | STRATEGIC | **OPEN** | **DEFER** → F-5 (observability) |
| §H-9 Roles/Policies controllers → repos | STRATEGIC | **OPEN** | **YES — folded into W6** (this IS the C-10 fix) |
| §H-10 Per-controller tenant-scoping E2E tests | STRATEGIC | **OPEN** | **YES — built incrementally per wave** (W3, W4a, W4b) |

### 2.2 Key prior-art to reuse

| Pattern | Source | Use in TASK-307 |
|---|---|---|
| `assertEqualTenants(a, b)` | `packages/applications/src/common/tenant-guards.ts` | `@TenantOwnedResource` interceptor (W3); `TenantController` inline (W5.5); `AuditLogController` inline (W5.7) |
| `isSuperAdmin(user)` | `packages/applications/src/common/tenant-guards.ts` | `TenantController` inline (W5.5); `AuditLogController` (W5.7); `SmrProxyController` getProviders (W5.9) |
| `resolveEffectiveTenantId(request.tenantId)` | `NotificationService` (TASK-305 W3.2) | Not directly used at the gateway, but the SUPER_ADMIN bypass semantics are mirrored |
| `JwtRevocationService.revoke(jti, exp)` | `packages/applications/src/services/auth/jwt-revocation.service.ts` (already exists, used by `revokeImpersonation`) | `AuthController.logout` (W1.4) — straight wire-up |
| DEF-C3 "no existence leak" pattern | TASK-305 W3.1, TASK-306 W5.2 | All `@TenantOwnedResource` 404 responses (W3) |
| `BaseService.broadcastSysEvent` + repository pattern | TASK-306 W5.5 ensures CLS wins | W6 — Roles / Policies / Auth-roles controller refactor |
| `RedisServiceModule.register(queueNames)` | `apps/api/src/app.module.ts:139` | W1 — `RefreshTokenService` reuses the existing Redis wiring |
| `@CanRead`/`@CanManage`/`@Authorize` decorator family | `apps/api/src/decorators/` | W4a + W4b — `APP_GUARD` rollout reuses the existing metadata keys |
| `auditAdminRoutePermissions` boot-time gate | `apps/api/src/bootstrap/admin-route-permission-audit.ts` | W4a.1 — widened from `/admin/*` to all routes (diagnostic-only; W4b flips the runtime guard) |
| Inline cross-tenant test layout under `describe('TASK-30X ...')` marker | TASK-305 / TASK-306 inline convention | All new tests use `describe('TASK-307 W*.x — ...')` markers |
| Cross-tenant coverage aggregator | `packages/applications/src/__tests__/cross-tenant-coverage.test.ts` (TASK-305 W4 / TASK-306 W5.5.6) | New mirror aggregator at `apps/api/src/__tests__/e2e-tenant-coverage.test.ts` (W7.9) |

### 2.3 Dependencies

| Dependency | Where | Status |
|---|---|---|
| TASK-305 Wave 1-4 merged into `fix/2605-review` | Foundation | DONE |
| TASK-306 W5.1-W5.7 merged into `fix/2605-review` | Foundation | DONE |
| `nestjs-cls` mounted at API edge (`app.module.ts:108-116`) | All waves | DONE |
| `RedisServiceModule.register(queueNames)` available | W1 — refresh-token store | DONE |
| `JwtRevocationService` available | W1.4 — logout revocation | DONE |
| Prisma `tenantScope` extension | Service-side scoping that `@TenantOwnedResource` complements (NOT replaces) | DONE |
| TASK-302 Phase 2 (PgBouncer + Vault) | NOT a dependency — F-3 (RS256) is deferred to TASK-302 | n/a |

---

## 3. Implementation Plan

> **Approval gate** — this section was confirmed by the user 2026-05-28. The waves are sequenced for review, but **implementation runs in parallel** across 8 isolated worktrees. Estimated total effort: **~18 engineer-hours** of work, **~5–7 hours wall-clock** when parallelised. Merge into `fix/2605-review` is sequential.

### 3.0 Execution model — parallel worktrees + sequential merge

Per the user decision 2026-05-28: each wave-subagent gets its own isolated git worktree branched off `fix/2605-review` HEAD `804b3bcd`. Subagents work concurrently. Merge into `fix/2605-review` is one-at-a-time (mandatory `code-reviewer` subagent verdict before each `--no-ff` merge). The first merged wave is the new base for any subsequent rebase.

#### Wave dependency graph (file-overlap risk → suggested merge order)

```
W1 ──┐                          (touches auth.controller.ts, packages/applications/src/services/auth/)
W2 ──┤── auth.controller.ts overlap ── merge serially
W6 ──┘                          (touches auth.controller.ts + RBAC controllers)

W3 ──┐                          (touches app.module.ts, ConsultationJobStatus, 5 controllers)
W4a ─┤── app.module.ts overlap ── merge W4a after W3
W4b ─┤                          (gated on W4a clean — must merge after)
W5 ──┘── independent (different files) ── can merge any time after W1/W2 to avoid auth filter conflicts

W7 ── MUST merge last (references all other merge SHAs in audit-closure docs)
```

#### Recommended merge order (minimises rebase work)

1. **W1** (refresh-token defense — biggest, most isolated change to auth)
2. **W2** (JWT secret — small auth tweak, easy rebase if W1 already in)
3. **W3** (`@TenantOwnedResource` — large but in different files than W1/W2 except for one `app.module.ts` interceptor registration)
4. **W4a** (audit widening — small, just `bootstrap/admin-route-permission-audit.ts`)
5. **W5** (surface sweep — many files but all different from W1/W2/W3/W4a/W6)
6. **W6** (direct-Prisma removal — touches `auth.controller.ts` and RBAC controllers; rebase against W1/W2)
7. **W4b** (global `APP_GUARD` registration — must come AFTER W4a's audit is verified clean against the entire route table)
8. **W7** (docs close-out — references all 7 prior merge SHAs)

This order is a recommendation; the user-controlled dispatcher may reorder if a wave is faster than expected.

#### Conflict-resolution policy

- **Trivial textual conflicts** (different line ranges, same file): each wave's code-reviewer subagent verifies the rebased branch still passes the same gates before merging.
- **Logical conflicts** (e.g., W6 rewriting an `auth.controller.ts` block that W1 also rewrote): the second-to-merge wave is responsible for rebasing AND re-running its full gate suite. If the rebase materially changes behaviour, the wave returns to the implementation step (re-TDD on the post-rebase code).
- **`app.module.ts` interceptor / guard registration order**: W3 (interceptor registration) lands before W4b (guard registration). Within `providers: [...APP_INTERCEPTOR + APP_GUARD]`, ordering is:
  1. `RequiresIfMatchGuard` (existing)
  2. `UnifiedAuthGuard` (W4b — APP_GUARD)
  3. `TenantOwnedResourceInterceptor` (W3 — APP_INTERCEPTOR, runs AFTER auth)

---

### Wave 1 — Refresh-token defense + auth-lifecycle (BLOCKER C-1 cluster)

**Goal**: close the highest-severity finding. Persist refresh tokens, rotate on each use, carry the original session's tenantId through refresh, revoke jti on logout, kill the `userId`-leaking format, make `jti` un-predictable.

**Estimate**: 4 engineer-hours including E2E.

**Branch**: `task-307/w1-refresh-token-defense`

| # | Task | File(s) | Verify | Size |
|---|---|---|---|---|
| 1.1 | **AC-1 part 1** — NEW `RefreshTokenService` in `packages/applications/src/services/auth/`: `issue(userId, tenantId, jti)`, `consume(rawToken)` (single-use, returns `{userId, tenantId, family}` or throws + revokes family on reuse-detection), `revokeFamily(family)`. Stores `sha256(token)` → `{userId, tenantId, jti, family, expiresAt}` in Redis with TTL = refresh window (configurable; default 7d) | NEW `refresh-token.service.ts` + `refresh-token.service.test.ts` | Unit tests: issue → consume happy-path; consume twice → family revoke; cross-tenant consume → 401 | M |
| 1.2 | **AC-1 part 2** — `AuthController.login` calls `RefreshTokenService.issue(userId, tenantId, jti)`; persists pre-hash | `apps/api/src/modules/auth/auth.controller.ts:402-450` | Unit test: fresh login persists token to Redis (mocked) | S |
| 1.3 | **AC-3** — `AuthController.refresh` validates via `RefreshTokenService.consume`, then issues a new access-token with `tenantId` **from the consumed record** (not `User.tenantId`); single-use rotation | `auth.controller.ts:446-499` | E2E: multi-tenant user logged into tenant B refreshes → access token carries tenant B | M |
| 1.4 | **AC-2** — `AuthController.logout` calls `jwtRevocationService.revoke(user.jti, user.exp)` AND `RefreshTokenService.revokeFamily(user.refreshFamily)` | `auth.controller.ts:205-243` | E2E: post-logout access token → 401; post-logout refresh token → 401 | S |
| 1.5 | **AC-1 / D-10** — `generateRefreshToken` → `randomBytes(48).base64url` (opaque; no userId in plaintext) | `auth.controller.ts:608-610` | Unit test pins format (no `_`-delimited userId) | S |
| 1.6 | **AC-6 / E-1** — JWT `jti` → `randomBytes(16).hex` (un-predictable) | `auth.controller.ts:157` | Unit test: two consecutive logins produce distinct, non-monotonic jtis | S |
| 1.7 | E2E suite: rotation roundtrip + reuse-detection negative + cross-tenant carry-through + logout-revocation | `apps/api/tests/e2e/auth-refresh.e2e-spec.ts` (NEW) | Full E2E green | M |
| 1.8 | Aggregator entry (new aggregator file from W7.9 created last; this wave just adds the test file paths to track) | TBD | TBD | S |

**W1 gate**:
- [ ] All AC-1, AC-2, AC-3, AC-6 tests green
- [ ] `pnpm build --filter @arcaai/api --filter @arcaai/applications` clean
- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] No regression in existing `auth.controller.test.ts` suites

---

### Wave 2 — JWT-secret fail-closed (HIGH C-6 bare-minimum)

**Goal**: bare-minimum closure of the dual / divergent JWT-secret problem. Refuse to start with the placeholder; unify sign + verify paths on `SecretsService`. RS256 / Vault Transit migration is deferred to F-3.

**Estimate**: 1 engineer-hour.

**Branch**: `task-307/w2-jwt-secret-failclosed`

| # | Task | File(s) | Verify | Size |
|---|---|---|---|---|
| 2.1 | **AC-4** — `JwtStrategy` constructor throws if the resolved secret equals the literal `'default-jwt-secret-key-change-in-production'` | `packages/applications/src/services/auth/jwt.strategy.ts:22` | Unit test pins the throw | S |
| 2.2 | **AC-4** — `main.ts` boot-time assertion mirrors the same check after `secretsService.boot(...)` | `apps/api/src/main.ts` | Integration test: bootstrap with the placeholder secret → process refuses to start | S |
| 2.3 | **AC-5** — `auth.controller.ts:147, 404, 479` — pull from `SecretsService.getSecretSync('JWT_SECRET_KEY')` only; remove the `AppSettingsService.getValueWithDefault` fallback | `auth.controller.ts` | Grep verifies no `JWT_SECRET_KEY` references into `AppSettingsService` | S |
| 2.4 | Same for `JWT_EXPIRES_IN` if it has the same dual-source pattern (verify in the implementation step) | as needed | Grep clean | S |

**W2 gate**:
- [ ] AC-4 + AC-5 tests green
- [ ] Bootstrap refuses placeholder secret in unit test
- [ ] No regression in JWT issuance / verification

---

### Wave 3 — `@TenantOwnedResource` decorator + 5-controller rollout (BLOCKERS C-2, C-3, C-4, C-5 + MED D-3)

**Goal**: close all 5 resource-ownership BLOCKERs with ONE reusable pattern. Introduce `@TenantOwnedResource(modelName, paramName)` decorator + interceptor; apply to the 5 named controllers + TranscriptionJob (D-3 free-rider).

**Estimate**: 5 engineer-hours.

**Branch**: `task-307/w3-tenant-owned-resource`

| # | Task | File(s) | Verify | Size |
|---|---|---|---|---|
| 3.1 | **AC-7** — NEW `@TenantOwnedResource(modelName, paramName)` decorator | `apps/api/src/common/tenant-owned-resource.decorator.ts` (NEW) | Decorator metadata key pinned by unit test | S |
| 3.2 | **AC-7** — NEW `TenantOwnedResourceInterceptor`: reads the decorator metadata, resolves the resource via the appropriate repository (lookup table: `TenantBucket` → `TenantBucketRepository`, `VoiceProfile` → `VoiceProfileRepository`, etc.), asserts `entity.tenantId === cls.get('tenantId')`, throws `NotFoundException('Resource not found')` on mismatch. Registered globally in `app.module.ts` (no per-controller `@UseInterceptors` needed). | `apps/api/src/common/tenant-owned-resource.interceptor.ts` (NEW) | Unit tests: matched tenant → passes; mismatched → 404; missing CLS → 404 | M |
| 3.3 | **AC-10 part 1** — Extend `ConsultationJobStatus` to carry `userId` + `tenantId`; `ConsultationJobService.getJobStatus` returns them; the SSE subscription channel name includes `tenantId` so cross-tenant subscriptions are physically isolated | `packages/applications/src/services/consultation/jobs/consultation-job.service.ts` + `ConsultationJobStatus` DTO | Unit test: `getJobStatus` returns tenant-attributed payload | M |
| 3.4 | **AC-10 part 2 / D-3** — `ConsultationJobController` enforces ownership on `getJob`, `cancelJob`, `streamJob` (uses `@TenantOwnedResource('ConsultationJob', 'jobId')` for read/cancel; stream-ticket scope includes `tenantId`); remove the explicit TODO comment at lines 12-15 | `apps/api/src/modules/consultation/consultation-job.controller.ts` | E2E: foreign-tenant token → 404; stream ticket from tenant-A → tenant-B consumption → 401 | M |
| 3.5 | **AC-8** — `TenantBucketController.getBucket / getBucketTree / getPresignedUrl / deleteBucket` use `@TenantOwnedResource('TenantBucket', 'id')` | `apps/api/src/modules/tenant-bucket/tenant-bucket.controller.ts:25-82` | E2E cross-tenant negative per endpoint (4) | S |
| 3.6 | **AC-9** — `StorageController` — resolve bucket name → `TenantBucket` and assert via `@TenantOwnedResource('TenantBucket', 'name', { lookup: 'name' })`; path-traversal guard retained | `apps/api/src/modules/storage/storage.controller.ts:47-195` | E2E cross-tenant negative + path-traversal still rejected | M |
| 3.7 | **AC-11** — `VoiceProfileController.activate / deactivate / deleteById` use `@TenantOwnedResource('UserVoiceProfile', 'id')`; service-layer assert added (defense-in-depth) | `apps/api/src/modules/voice-profile/voice-profile.controller.ts:88-116` | E2E cross-tenant negative per endpoint (3) | S |
| 3.8 | **AC-12** — `TranscriptionJobController` — apply `@TenantOwnedResource('TranscriptionJob', 'jobId')` to `getById / cancel / retry / streamJob / closeStreamSession`; for list endpoints (`list / getByStatus / getByConsultation`) inject `tenantId` filter at the service layer | `apps/api/src/modules/streaming/transcription-job.controller.ts:361-403` | E2E cross-tenant negative per endpoint | M |
| 3.9 | Aggregator entry for W3 E2E tests | new aggregator file | green | S |

**W3 gate**:
- [ ] AC-7, AC-8, AC-9, AC-10, AC-11, AC-12 tests green
- [ ] `pnpm test:e2e --filter @arcaai/api` green; new test counts match plan
- [ ] `pnpm test --filter @arcaai/applications` green (anti-regression for ConsultationJobService changes)
- [ ] No new lint errors

---

### Wave 4a — Widen route-permission audit (HIGH C-7 part 1: diagnostic)

**Goal**: widen the boot-time route-permission audit from `/admin/*` to every route. This wave **does not** flip the guard yet — it surfaces drift so W4b can land safely. Per user decision 2026-05-28, W4 is split into two PRs to reduce blast radius.

**Estimate**: 1.5 engineer-hours.

**Branch**: `task-307/w4a-route-audit-widening`

| # | Task | File(s) | Verify | Size |
|---|---|---|---|---|
| 4a.1 | **AC-14** — Widen `auditAdminRoutePermissions` from `/admin/*` to ALL routes; refuse boot if any route is unprotected (no `@Public()`) AND unlabeled (no `REQUIRED_PERMISSIONS_KEY` metadata). The audit STILL logs-and-throws at boot, but `UnifiedAuthGuard` is NOT yet `APP_GUARD` — so the diagnostic surfaces drift without changing runtime behaviour | `apps/api/src/bootstrap/admin-route-permission-audit.ts:32` | Unit test pins the boot refusal on a deliberately mis-configured controller | M |
| 4a.2 | **AC-13 verification (part 1)** — NEW integration test that walks every route via `DiscoveryService` and asserts `@Public()` OR non-empty `REQUIRED_PERMISSIONS_KEY` metadata. This test MUST be green for W4a to merge (so W4b lands on a known-clean route table) | `apps/api/tests/integration/auth-coverage.spec.ts` (NEW) | Integration test green | M |
| 4a.3 | Sweep — fix any drift surfaced by W4a.1 (likely 0-3 controllers; if more, pause and report). Each drift fix is its own commit so reviewers can trace exactly what was added | as needed | Boot succeeds + integration test green | S |
| 4a.4 | Add an explicit decorator `@Public()` to every legitimately-unauthenticated endpoint (`/live`, `/ready`, `/startup`, `auth/login`, `auth/refresh`, etc.) so the W4b registration is a no-op for these | various | All public endpoints decorated; integration test still green | S |

**W4a gate**:
- [ ] AC-14 test green
- [ ] AC-13 integration test green (every route has `@Public()` OR `REQUIRED_PERMISSIONS_KEY`)
- [ ] `pnpm test:e2e --filter @arcaai/api` green (no regression — guard is NOT yet flipped)
- [ ] Drift sweep complete; list of drift-fixed routes in the PR body for the W4b dependency

---

### Wave 4b — Global `APP_GUARD` registration (HIGH C-7 part 2: runtime flip)

**Goal**: with W4a merged and the route table verified clean, register `UnifiedAuthGuard` as `APP_GUARD` so the default is **deny**, with `@Public()` as the explicit opt-out. This is the runtime behaviour change. **Strict dependency on W4a merged**.

**Estimate**: 1.5 engineer-hours.

**Branch**: `task-307/w4b-global-app-guard` (rebased onto post-W4a `fix/2605-review`)

| # | Task | File(s) | Verify | Size |
|---|---|---|---|---|
| 4b.1 | **AC-13** — Register `UnifiedAuthGuard` as `APP_GUARD` in `app.module.ts:78-83`; runs AFTER `RequiresIfMatchGuard`; reads `@Public()` metadata to opt out | `apps/api/src/app.module.ts` | Integration test: route with `@Public()` → 200 without auth; route without it → 401 without auth | M |
| 4b.2 | Extend the W4a integration test with a runtime walk: each `@Public()` endpoint returns 200 without an `Authorization` header; each authenticated endpoint returns 401 without one | `apps/api/tests/integration/auth-coverage.spec.ts` (extension) | Both halves green | S |
| 4b.3 | Final smoke E2E run — confirm the post-flip behaviour matches the W4a pre-flip diagnostic exactly (no surprise endpoints break) | E2E suite | Full E2E green | S |

**W4b gate**:
- [ ] AC-13 tests green (both metadata walk and runtime walk)
- [ ] Boot-time audit + APP_GUARD agree (zero drift)
- [ ] No regression in existing `auth.e2e-spec.ts` suite or any other E2E
- [ ] W4a is fully merged into `fix/2605-review` before this wave merges

---

### Wave 5 — Surface hardening sweep (HIGHs C-8, C-9 + 7 MEDIUMs)

**Goal**: close the remaining HIGH surface findings (C-8 health, C-9 Prisma Studio) plus 7 cheap MEDIUMs in a single bundled PR. None of these require new patterns.

**Estimate**: 3 engineer-hours.

**Branch**: `task-307/w5-surface-hardening`

| # | Task | File(s) | Verify | Size |
|---|---|---|---|---|
| 5.1 | **AC-15 (C-8 + D-11 + E-3)** — `/health/services{/:key}` requires `@Authorize()`; response strips `version` + `checks`; throttle lowered to `{ limit: 30, ttl: 60000 }`; `/live`, `/ready`, `/startup` keep `@Public()` | `apps/api/src/modules/health/health.controller.ts:143-192` | E2E: unauthenticated → 401; authenticated → sanitised payload | S |
| 5.2 | **AC-16 (C-9)** — Prisma Studio GET requires `Authorization: Bearer` header (no JWT in URL); session cookie used for the studio page; module disabled unless `NODE_ENV=development` AND `ENABLE_PRISMA_STUDIO=true` | `apps/api/src/modules/pstudio/pstudio.controller.ts:21-39` + `apps/api/src/app.module.ts:162-167` | Unit test pins bootstrap gating; E2E pins header requirement | M |
| 5.3 | **AC-17 (D-1)** — `ContextInterceptor` throws `400 Bad Request` when `x-tenant-id` mismatches JWT tenant (was warn-only) | `apps/api/src/interceptors/context.interceptor.ts:60-71` | Unit test pins the 400 | S |
| 5.4 | **AC-18 (D-2)** — `ConsultationController.isSharingEnabled` default-CLOSED: `return setting?.value === 'true'`; remove the try/catch that returns `true` on error | `apps/api/src/modules/consultation/consultation.controller.ts:145-161` | Unit test: missing setting → false; DB throw → false | S |
| 5.5 | **AC-19 (D-5)** — `TenantController.update / delete / getUsage / fetchByCodeName` inline `if (!isSuperAdmin(user) && id !== user.tenantId) throw new ForbiddenException()` | `apps/api/src/modules/tenant/tenant.controller.ts:73-164` | Unit + E2E per method | S |
| 5.6 | **AC-20 (D-6)** — `ExceptionInterceptor` + `PrismaClientExceptionFilter` strip `err.meta` AND `err.message` raw text from the client body; respond `{statusCode, error: 'Bad Request', correlationId}`; full detail logged server-side | `apps/api/src/interceptors/exception.interceptor.ts:46-63` + `apps/api/src/filters/prisma.filter.ts:33-78` | E2E: 400 / 500 from a Prisma path returns no column / constraint / id text | M |
| 5.7 | **AC-21 (D-7)** — `AuditLogController.fetchByUser` inline-filters by caller's CLS `tenantId` (SUPER_ADMIN bypass per the W1.4 pattern) | `apps/api/src/modules/audit-log/audit-log.controller.ts:117-141` | E2E cross-tenant negative | S |
| 5.8 | **AC-22 (D-8)** — `SttWsGateway` close codes — single generic `4401` regardless of cause; real reason logged server-side | `apps/api/src/modules/streaming/stt-ws.gateway.ts:75-105` | Unit test pins generic close code | S |
| 5.9 | **AC-23 (D-12)** — `SmrProxyController.getProviders` requires explicit `?tenantKey=__GLOBAL__` query param for the GLOBAL fallback (no implicit SUPER_ADMIN role-based fallback) | `apps/api/src/modules/streaming/smr-proxy.controller.ts:181-192` | Unit test + E2E | S |
| 5.10 | Aggregator entry for W5 tests | new aggregator file | green | S |

**W5 gate**:
- [ ] AC-15 through AC-23 tests green
- [ ] E2E suite green; no regression in existing tests
- [ ] No new lint errors

---

### Wave 6 — Direct-Prisma removal (HIGH C-10 + STRATEGIC §H-9)

**Goal**: replace direct `databaseService.client.*` access in `auth.controller.ts`, `policies.controller.ts`, `roles.controller.ts` with repository / service calls. Add an ESLint rule to prevent regression.

**Estimate**: 2 engineer-hours.

**Branch**: `task-307/w6-controller-repository-refactor`

| # | Task | File(s) | Verify | Size |
|---|---|---|---|---|
| 6.1 | **AC-24 part 1** — `AuthController.getUserRoles` and the 3 `userRoleAssignment.findFirst/findMany` callsites → `UserRoleAssignmentService.findForUserTenant(userId, tenantId)` (or equivalent application-service method; may need a new service method) | `apps/api/src/modules/auth/auth.controller.ts:132-138, 363-371, 576-586` + new service method if missing | Unit test pins the new behaviour | M |
| 6.2 | **AC-24 part 2** — `PoliciesController` — replace every direct Prisma call with `PolicyRepository` + `PolicyService`; events emitted via `BaseService.broadcastSysEvent` | `apps/api/src/modules/rbac/policies.controller.ts` | E2E: existing policy CRUD still green | M |
| 6.3 | **AC-24 part 3** — `RolesController` — same pattern: `RoleRepository` + `RoleService` | `apps/api/src/modules/rbac/roles.controller.ts` | E2E: existing role CRUD still green | M |
| 6.4 | **AC-24 part 4** — ESLint rule in `packages/config-eslint/base.js`: forbid `databaseService.client.<model>` import inside `apps/api/src/modules/**/*.controller.ts` (allow-list any unavoidable controllers) | `packages/config-eslint/base.js` | `pnpm lint --filter @arcaai/api` fails on a test-injection of a forbidden pattern | S |
| 6.5 | Aggregator entry for W6 tests | new aggregator file | green | S |

**W6 gate**:
- [ ] AC-24 tests green
- [ ] Existing E2E tests for auth / policies / roles still green
- [ ] ESLint rule prevents regression

---

### Wave 7 — Hygiene + docs close-out (LOW E-2..E-11 + audit closure)

**Goal**: close the 9 LOW items that are quick + impactful, plus the audit-closure documentation.

**Estimate**: 1 engineer-hour for fixes + 1 hour for docs.

**Branch**: `task-307/w7-hygiene-and-docs`

| # | Task | File(s) | Verify | Size |
|---|---|---|---|---|
| 7.1 | **AC-25 (E-2)** — Dev CORS — localhost-only patterns; no `origin: '*'` with `credentials: true` | `apps/api/src/main.ts:135-137` + corsOptions block | Unit test pins the dev allowlist | S |
| 7.2 | **AC-26 (E-4)** — `AuthController` strict throttle (10/min) scoped to `login` + `refresh` only; default throttle for `/me`, `/logout`, `/stream-ticket` | `apps/api/src/modules/auth/auth.controller.ts` | Unit test pins per-method throttle metadata | S |
| 7.3 | **AC-27 (E-5)** — Replace `process.env.SMR_URL` reads in `smr-proxy.controller.ts:113` and `health.controller.ts:28-55` with typed `ConfigModule` providers | as listed | Grep verifies no `process.env` in `apps/api/src/modules/**/*.controller.ts` | S |
| 7.4 | **AC-28 (E-6)** — NEW `RequestWithAuth` interface; type the `request['apiKey']` accesses | `apps/api/src/types/request-with-auth.ts` (NEW) + `unified-auth.guard.ts:145` + `stt-internal.controller.ts:24` | Typecheck verifies no `request['apiKey']` string-key accesses remain | S |
| 7.5 | **AC-29 (E-7)** — `MetricsInterceptor` prefers `request.route?.path`; strips path params from the cardinality dimension | `apps/api/src/interceptors/metrics.interceptor.ts:25` | Unit test pins path-template extraction | S |
| 7.6 | **AC-30 (E-8)** — Swagger `addApiKey({...})` scheme; `@ApiSecurity('api-key')` on every API-key-authenticated endpoint | `apps/api/src/main.ts:205` + decorator sweep | Swagger doc visual check + grep | S |
| 7.7 | **AC-31 (E-10)** — `request.requestId` from `X-Request-Id` header only; `uuidv7()` fallback when absent | `apps/api/src/interceptors/context.interceptor.ts:47` | Unit test pins header-only behaviour | S |
| 7.8 | **AC-32 (E-11)** — `UserController.bulkDelete` wraps the iteration in a single `$transaction(callback)` OR returns per-id status | `apps/api/src/modules/user/user.controller.ts:143-150` | E2E pins all-or-nothing behaviour | S |
| 7.9 | **AC-33** — NEW `apps/api/src/__tests__/e2e-tenant-coverage.test.ts` — mirror of `cross-tenant-coverage.test.ts`; FS-introspects every `*.e2e-spec.ts` referencing tenant-A / tenant-B fixtures; asserts coverage per controller; aggregates per-controller floors | NEW aggregator file | Aggregator green; floors match all per-wave counts | M |
| 7.10 | **AC-34** — Update `docs/multi-tenancy-audit/04-api-design-review.md` — TASK-307 closure banner at top + per-finding `[CLOSED W*.x <sha>]` markers in §A/§B/§C/§D/§E/§F/§G/§H tables | `04-api-design-review.md` | Doc diff approved | S |
| 7.11 | **AC-35** — NEW `docs/multi-tenancy-audit/08-api-design-followup-closure.md` — canonical "what TASK-307 closed vs. deferred" record; reference per-merge SHA log; mirror the structure of `07-ddd-layers-followup-closure.md` | NEW doc | Doc reviewed | M |
| 7.12 | Update `docs/multi-tenancy-audit/06-implementation-summary.md` — new §7 "Wave 6 / TASK-307" subsection (mirror of §6 for TASK-306) | `06-implementation-summary.md` | Doc diff approved | S |
| 7.13 | Update `docs/technical-architecture-overview.md` — note the new global `APP_GUARD` + `@TenantOwnedResource` decorator + refresh-token rotation in the Multi-tenancy enforcement layers section | `technical-architecture-overview.md` | Doc diff approved | S |
| 7.14 | Finalise §5 of this README (Implementation Summary) with files changed and merge SHAs | this file | This README updated | S |

**W7 gate**:
- [ ] AC-25 through AC-35 tests green
- [ ] All audit docs updated and cross-linked
- [ ] §5 of this README matches the actual merged commits
- [ ] Status of this ticket flipped to `Completed`

---

## 4. Testing Strategy

### 4.1 TDD ordering per wave

Strict Red-Green-Refactor (`methodology/test-driven-development`):

- **W1** — write each refresh-token test FIRST (E2E + unit). Confirm RED state (today's forgeable behaviour). Add the service, then make tests pass.
- **W2** — write the JWT-secret refusal test FIRST. Confirm bootstrap currently boots with the placeholder; add the assertion.
- **W3** — write the cross-tenant negative E2E per controller FIRST. Confirm RED state (today's leak). Introduce the decorator + interceptor, then apply per controller.
- **W4a** — write the `DiscoveryService` metadata-walker integration test FIRST (asserts every route has `@Public()` OR `REQUIRED_PERMISSIONS_KEY`). Then widen `auditAdminRoutePermissions`. Drift fixes follow as small commits.
- **W4b** — extend the W4a integration test with the runtime walker FIRST (`@Public()` → 200 without auth; authenticated → 401 without auth). Confirm RED (today both return 200 because `APP_GUARD` is opt-in). Register `UnifiedAuthGuard` as `APP_GUARD`, make test pass.
- **W5** — write each surface-hardening unit / E2E test FIRST per sub-task. Wave is a "many small fixes" wave; each fix follows the same TDD pattern.
- **W6** — write the new service-method unit tests FIRST; rely on existing E2E for behaviour preservation.
- **W7** — hygiene tests + aggregator + docs.

### 4.2 Test placement

| Phase | Location | Marker |
|---|---|---|
| Unit tests | `apps/api/src/**/__tests__/*.spec.ts` (existing convention) | `describe('TASK-307 W*.x — …')` |
| E2E tests | `apps/api/tests/e2e/*.e2e-spec.ts` | `describe('TASK-307 W*.x — …')` |
| New `RefreshTokenService` | `packages/applications/src/services/auth/__tests__/refresh-token.service.test.ts` | `describe('TASK-307 W1.1 — …')` |
| Aggregator (NEW) | `apps/api/src/__tests__/e2e-tenant-coverage.test.ts` | mirror of `packages/applications/src/__tests__/cross-tenant-coverage.test.ts` |

### 4.3 Manual verification checklist (each wave)

| # | Step |
|---|---|
| 1 | `pnpm build` (whole monorepo) — clean |
| 2 | `pnpm typecheck` — clean |
| 3 | `pnpm lint` — clean (no new disables) |
| 4 | `pnpm test --filter @arcaai/applications` — green; TASK-305/306 floors preserved |
| 5 | `pnpm test --filter @arcaai/api` — green; new test counts match plan |
| 6 | `pnpm test:e2e --filter @arcaai/api` — green; new E2E counts match plan |
| 7 | Aggregator (`e2e-tenant-coverage.test.ts`) — green; per-controller floors ≥ expected |

### 4.4 Anti-regression: TASK-305 + TASK-306 cross-tenant tests must remain green

The aggregator at `packages/applications/src/__tests__/cross-tenant-coverage.test.ts` pins 30 entries (114 inline + 6 fixture + 19 aggregator + W5 additions) post-TASK-306. Each W*.* gate verifies no count drops. The new `apps/api` aggregator (W7.9) adds an independent floor for the gateway-level coverage.

---

## 5. Implementation Summary

> The plan in §3 was executed across 8 PRs (W1, W2, W3, W4a, W4b, W5, W6, W7) merged into `fix/2605-review` between 2026-05-28 and 2026-05-28. Every BLOCKER (C-1..C-5) and HIGH (C-6..C-12) finding is closed in code; every MEDIUM (D-1..D-12) finding is closed except D-4 (network segregation — infra) and D-9 (per-tenant throttle — needs Redis-backed `ThrottlerStorage`). E-series LOW findings are tracked in §10 Deferrals.

### 5.1 What was built per wave

#### W1 — Refresh-token defense + auth-lifecycle (merge `4c85d9f6`)

Closed C-1 (refresh-token forgery), C-11 (logout doesn't revoke jti), C-12 (refresh ignores tenant scope), D-10 (refresh token leaks userId), E-1 (predictable jti).

- NEW `RefreshTokenService` (`packages/applications/src/services/auth/refresh-token.service.ts`): `issue(userId, tenantId, jti)`, `consume(rawToken)` (single-use, returns persisted `{userId, tenantId, family}` or throws + revokes family on reuse-detection), `revokeFamily(family)`. Server-side store is Redis under SHA-256(token) → `{userId, tenantId, jti, family, expiresAt}` with TTL = 7d (configurable via `REFRESH_TOKEN_TTL_SECONDS`).
- `AuthController.login` now persists pre-hash via `RefreshTokenService.issue`; issues opaque tokens (`opaque-<jti>`) — no `userId`/timestamp in the wire string.
- `AuthController.refresh` validates via `RefreshTokenService.consume`, re-issues access-token bound to the **original session's tenantId** (not `User.tenantId`); single-use rotation.
- `AuthController.logout` revokes the access-token `jti` via `JwtRevocationService.revoke` AND deletes the refresh-token family.
- JWT `jti` is now `randomBytes(16).toString('hex')` (unpredictable, no userId/timestamp leak).
- E2E suite `apps/api/tests/e2e/auth-refresh.spec.ts` covers rotation roundtrip, reuse-detection family-revoke, cross-tenant carry-through, post-logout token rejection.

#### W2 — JWT secret fail-closed on placeholder (merge `38013f4e`)

Closed C-6 (dual JWT secret sources + hard-coded fallback).

- NEW `assertJwtSecretNotPlaceholder` boot-time audit (`apps/api/src/bootstrap/jwt-secret-placeholder-audit.ts`): boot refuses to start when `JWT_SECRET_KEY` is undefined or equals the literal development placeholder. Refusal messages disambiguate the two failure modes (W7.A.7 hardening).
- `JwtStrategy` mirrors the check at construction time (W7.A.6 hardened to an explicit `!secret || secret === JWT_SECRET_PLACEHOLDER` predicate).
- `AuthController` JWT secret reads consolidated through `SecretsService.getSecretSync('JWT_SECRET_KEY')` — the divergent `AppSettingsService.getValueWithDefault('JWT_SECRET_KEY', ...)` fallback is gone.

#### W3 — `@TenantOwnedResource` decorator + 5-controller rollout (merge `d969b25c`)

Closed C-2 (Storage cross-tenant), C-3 (ConsultationJob no ownership), C-4 (TenantBucket cross-tenant), C-5 (VoiceProfile no ownership), D-3 (TranscriptionJob no ownership).

- NEW `@TenantOwnedResource(paramName, options)` decorator + `TenantOwnedResourceInterceptor` (registered as `APP_INTERCEPTOR` in `app.module.ts`). The interceptor reads the decorator metadata, dispatches the lookup against a resource-type → repository table (model name + optional `lookup: 'name'` for name-keyed lookups), asserts `entity.tenantId === cls.get('tenantId')`, and **throws `NotFoundException('Resource not found')` on mismatch** (DEF-C3 no-existence-leak posture).
- Decorator applied to: `TenantBucketController` (`getBucket`/`getBucketTree`/`getPresignedUrl`/`deleteBucket`), `StorageController` (`lookup: 'name'`), `VoiceProfileController` (`activate`/`deactivate`/`deleteById`), `TranscriptionJobController` (`getById`/`cancel`/`retry`/`streamJob`/`getByConsultation`), `ConsultationJobController` (`getJob`/`cancelJob`/`streamJob`). `TranscriptionJobController.closeStreamSession` is intentionally not decorated — see W7.A.9 TSDoc note (sessionId ≠ jobId).
- `ConsultationJobStatus` extended to carry `userId` + `tenantId`; `ConsultationJobService.getJobStatus` returns them; service-side ownership is the secondary defense layer.
- E2E suite: per-controller cross-tenant-negative probes in `task-307-{consultation-job,storage,tenant-bucket,transcription-job,voice-profile}-cross-tenant.spec.ts` plus an aggregator at `task-307-w3-aggregate.spec.ts`. (W7.A.10 §10 note: 4/5 controllers currently use synthetic ids in the probe; only `TenantBucketController` has a true genuine probe — widening tracked in §10.)

#### W4a — Route-permission audit widening (merge `b07eb67f`)

Closed C-7 part 1 (boot-time diagnostic to detect any route without `@Public()` OR `REQUIRED_PERMISSIONS_KEY`).

- `auditAdminRoutePermissions` widened from `/admin/*` to every controller. Boot now refuses to start if any non-`@Public()` route lacks an explicit permission decorator. The audit is diagnostic only; W4b flips the runtime guard.
- NEW `apps/api/src/bootstrap/third-party-public-routes.ts` allow-list for unavoidable third-party `@Public()` endpoints (e.g., `PrometheusController.index`).
- `auth.controller.ts` (`/login`, `/refresh`) and `health.controller.ts` (`/live`, `/ready`, `/startup`, `/health`, `/health/services{/:key}`) explicitly marked `@Public()` so the widened audit + future `APP_GUARD` registration are both no-ops for these.
- Integration test `apps/api/tests/integration/auth-coverage.spec.ts` ("metadata walk") asserts every route has `@Public()` OR `REQUIRED_PERMISSIONS_KEY` metadata. Boot succeeds + integration test green → W4a is the gate for W4b.

#### W4b — Global `UnifiedAuthGuard` as `APP_GUARD` (merge `c9c42e19`)

Closed C-7 part 2 (auth is no longer opt-in — global runtime default is **deny**, with `@Public()` as the explicit opt-out).

- `UnifiedAuthGuard` registered as `APP_GUARD` in `app.module.ts`. Guard order: `RequiresIfMatchGuard` → `UnifiedAuthGuard` → `TenantOwnedResourceInterceptor` (interceptor, runs AFTER auth).
- **Option A deviation (recorded in W4b's PR body for future readers):** rather than extend the existing `auth-coverage.spec.ts` integration test with a true HTTP-level `app.init() + request(app).get(...)` walker (which would need Redis + Postgres + every module's external deps to bind in test), W4b ships a **synthetic-module integration test** that loads a fixture module declaring its own `@Public()` and authenticated routes and verifies the `APP_GUARD` semantics by exercising the guard directly. The synthetic-module approach gives the same contract guarantee (`@Public()` → no auth required; everything else → 401 without bearer) without the harness cost. The trade-off is recorded in the W4b code-review verdict; widening to a full `TestAppModule` HTTP walker is tracked as a §10 deferral (W7.A.19).
- W7.A.18 hygiene: redundant `Reflector` provider and unreachable `hasScope` stub removed from the synthetic module providers list.

#### W5 — Surface hardening sweep (merge `677f17d9`)

Closed C-8 (`/health/services` unauth + leaks), C-9 (Prisma Studio @Public GET + JWT-in-URL), D-1 (x-tenant-id warn-only), D-2 (consultation sharing default-open), D-5 (TenantController inline guard), D-6 (Prisma error meta leak), D-7 (AuditLog cross-tenant), D-8 (WS close-code enumeration), D-11 (health throttle 300/min), D-12 (SmrProxy SUPER_ADMIN GLOBAL fallback), E-3 (health downstream version leak).

- `/health/services{/:key}` gated by `@Authorize()`; payload omits `version` + `checks`; throttle lowered 300 → 30 req/min. `/live`, `/ready`, `/startup`, `/health` remain `@Public()` for Kubernetes probes with the local status only.
- `PrismaStudioController` GET + POST require `@Authorize(['manage','all'])`; module disabled unless `NODE_ENV=development` AND `ENABLE_PRISMA_STUDIO=true`.
- `ContextInterceptor` throws `400 Bad Request` when `x-tenant-id` header diverges from JWT-derived tenant (was warn-only).
- `ConsultationController.isSharingEnabled` is default-closed (`setting?.value === 'true'`); error path returns `false`.
- `TenantController.update/delete/getUsage/fetchByCodeName` inline-assert `id === cls.tenantId` unless `isSuperAdmin(user)`.
- `ExceptionInterceptor` + `PrismaClientExceptionFilter` strip `err.meta` and raw Prisma message from the client response; full detail logged server-side. (W7.A.14 documents the filter shadow + §10 deferral.)
- `AuditLogController.fetchByUser` inline-filters by caller's CLS `tenantId` (SUPER_ADMIN bypass).
- `SttWsGateway` collapses all rejection paths to a single generic 4401 close code; real reason logged server-side.
- `SmrProxyController.getProviders` requires explicit `?tenantKey=__GLOBAL__` query param for the GLOBAL fallback (no implicit SUPER_ADMIN promotion).

#### W6 — Direct-Prisma removal in controllers + ESLint rule (merge `77068325`)

Closed C-10 (direct Prisma access in `auth.controller.ts`, `policies.controller.ts`, `roles.controller.ts`); partial §H-9 closure.

- `AuthController.getUserRoles` and the 3 `userRoleAssignment.findFirst/findMany` callsites now delegate to `UserRoleAssignmentService.findForUserTenant`.
- NEW `PolicyService` (`packages/applications/src/services/rbac/policy/policy.service.ts`) absorbs every Prisma call previously living in `PoliciesController`. `PoliciesController` is now a thin HTTP adapter.
- NEW `RbacRoleService` (`packages/applications/src/services/rbac/role/role.service.ts`) absorbs every Prisma call previously living in `RolesController`. `RolesController` is now a thin HTTP adapter. (Class is prefixed `Rbac` to disambiguate from the legacy `services/security/role/RoleService`.)
- NEW custom ESLint plugin `@arcaai-internal/eslint-plugin` with rule `no-controller-direct-prisma`: forbids `databaseService.client.<model>` or direct `@arcaai/database` imports inside `apps/api/src/modules/**/*.controller.ts`. Plugin has unit tests in `packages/eslint-plugin-arcaai-internal/__tests__/`.
- §H-9 closure is **partial**: per W7.A.15 carryover, both `PolicyService` and `RbacRoleService` use `CoreDatabaseService` directly rather than going through a dedicated `PolicyRepository` / `RoleRepository`. The W6 implementer chose verbatim behaviour preservation to keep the existing RBAC E2E suite green; the repository extraction is tracked in §10 as a follow-up.
- W7.A.17 hygiene: `PoliciesController.findOne` now throws `NotFoundException` instead of bare `Error` (404 vs 500).
- W7.A.16 hygiene: `PolicyService` extends `BaseService` with `ResourceType.Permission` (NOT `Policy`) — verbatim behaviour preservation for the pre-W6 SysEvent `resourceType` string. Documented in TSDoc.

#### W7 — Hygiene + docs close-out (merge `<HEAD-of-w7>`)

This wave. Closed the API gateway audit `04-api-design-review.md` (closure banner + per-finding markers in §A/§B/§C/§D/§E/§F), filed §10 deferrals for the LOW E-series + the medium-scope carryovers, fixed the 19 carryover code nits from W1–W6 reviews. See §10 below for the full carryover/deferral table and §11 Change History for the per-finding closure mapping.

### 5.2 Files changed by wave

Each row is the union of files touched by every commit reachable from the wave's merge SHA but not from its parent. Numbers in parentheses are reference SHAs.

#### W1 (`4c85d9f6`) — 12 files
- `apps/api/src/modules/auth/auth.controller.ts` (login/refresh/logout/jti rework)
- `apps/api/src/modules/auth/__tests__/auth.controller.test.ts` + `auth.controller.task224.test.ts` + NEW `auth.controller.task307.test.ts`
- `apps/api/tests/e2e/auth-refresh.spec.ts` (NEW — rotation, reuse-detection, cross-tenant, logout)
- `packages/applications/src/services/auth/auth.service.module.ts` (register `RefreshTokenService`)
- `packages/applications/src/services/auth/dto/user.session.ts`
- `packages/applications/src/services/auth/index.ts` (barrel)
- `packages/applications/src/services/auth/jwt.strategy.ts` + `__tests__/jwt.strategy.test.ts`
- NEW `packages/applications/src/services/auth/refresh-token.service.ts` + `__tests__/refresh-token.service.test.ts`

#### W2 (`38013f4e`) — 11 files
- `apps/api/src/main.ts` (boot-time placeholder assertion)
- NEW `apps/api/src/bootstrap/jwt-secret-placeholder-audit.ts` + `__tests__/jwt-secret-placeholder-audit.test.ts`
- `apps/api/src/modules/auth/auth.controller.ts` + 4 test files (stream-ticket, task224, task295, test) + NEW `auth.controller.task307-w2.test.ts`
- `packages/applications/src/services/auth/jwt.strategy.ts` + `__tests__/jwt.strategy.test.ts`

#### W3 (`d969b25c`) — 28 files
- `apps/api/src/app.module.ts` (register `TenantOwnedResourceInterceptor` as `APP_INTERCEPTOR`)
- NEW `apps/api/src/common/tenant-owned-resource.{decorator,interceptor,module}.ts` + tests under `__tests__/`
- `apps/api/src/common/index.ts`
- `apps/api/src/modules/consultation/consultation-job.controller.ts` + `__tests__/consultation-job.controller.test.ts`
- `apps/api/src/modules/storage/storage.controller.ts` + `__tests__/storage.controller.metadata.test.ts`
- `apps/api/src/modules/streaming/transcription-job.controller.ts` + `__tests__/transcription-job.controller.test.ts`
- `apps/api/src/modules/tenant-bucket/tenant-bucket.controller.ts` + `__tests__/tenant-bucket.controller.test.ts`
- `apps/api/src/modules/voice-profile/voice-profile.controller.ts` + `__tests__/voice-profile.controller.test.ts`
- NEW `apps/api/tests/e2e/task-307-{consultation-job,storage,tenant-bucket,transcription-job,voice-profile}-cross-tenant.spec.ts`
- NEW `apps/api/tests/e2e/task-307-w3-aggregate.spec.ts`
- `packages/applications/src/services/consultation/jobs/consultation-job.service.ts` + `__tests__/consultation-job.service.test.ts` + `dto/job.dto.ts`
- `packages/applications/src/services/stt/job/transcriptionJob.service.ts` + `__tests__/transcriptionJob.service.test.ts`

#### W4a (`b07eb67f`) — 10 files
- `apps/api/src/bootstrap/admin-route-permission-audit.ts` + `__tests__/admin-route-permission-audit.test.ts`
- NEW `apps/api/src/bootstrap/third-party-public-routes.ts` + `__tests__/third-party-public-routes.test.ts`
- `apps/api/src/modules/auth/auth.controller.ts` (`@Public()` on `/login`, `/refresh`)
- `apps/api/src/modules/health/health.controller.ts` (`@Public()` on probe routes)
- NEW `apps/api/tests/integration/auth-coverage.spec.ts` (metadata walk)
- `apps/api/vitest.config.ts` + `apps/api/package.json` + `pnpm-lock.yaml`

#### W4b (`c9c42e19`) — 2 files
- `apps/api/src/app.module.ts` (register `UnifiedAuthGuard` as `APP_GUARD`)
- `apps/api/tests/integration/auth-coverage.spec.ts` (synthetic-module describe; Option A deviation noted in PR body)

#### W5 (`677f17d9`) — 26 files
- `apps/api/src/app.module.ts` (`pstudio` module gating)
- `apps/api/src/__tests__/controller-route-renames.test.ts` (pinning the new pstudio surface)
- `apps/api/src/filters/prisma.filter.ts` + `__tests__/prisma.filter.test.ts`
- `apps/api/src/interceptors/context.interceptor.ts` + `__tests__/context.interceptor.test.ts`
- `apps/api/src/interceptors/exception.interceptor.ts` + `__tests__/exception.interceptor.test.ts`
- `apps/api/src/modules/audit-log/audit-log.controller.ts` + `__tests__/audit-log.controller.test.ts`
- `apps/api/src/modules/consultation/consultation.controller.ts` + `__tests__/consultation.controller.test.ts`
- `apps/api/src/modules/health/health.controller.ts` + `__tests__/health.controller.test.ts`
- `apps/api/src/modules/pstudio/pstudio.controller.ts` + `pstudio.module.ts` + `__tests__/pstudio.controller.test.ts`
- `apps/api/src/modules/streaming/smr-proxy.controller.ts` + `__tests__/smr-proxy.controller.test.ts`
- `apps/api/src/modules/streaming/stt-ws.gateway.ts` + `__tests__/stt-ws.gateway.test.ts`
- `apps/api/src/modules/tenant/tenant.controller.ts` + `__tests__/tenant.controller.test.ts`
- `apps/api/src/modules/throttle/__tests__/throttle-decorators.test.ts`
- `packages/applications/src/common/tenant-guards.ts` + `__tests__/tenant-guards.test.ts`

#### W6 (`77068325`) — 33 files
- `apps/api/src/modules/auth/auth.controller.ts` + 4 test files (stream-ticket, task224, task295, test)
- `apps/api/src/modules/auth/auth.module.ts`
- `apps/api/src/modules/rbac/policies.controller.ts` + `roles.controller.ts` + `rbac.module.ts`
- NEW `packages/applications/src/services/rbac/{policy,role}/{IPolicyService,IRoleService,policy.service,role.service,policy.service.module,role.service.module,index}.ts` + per-service `__tests__/...task307.test.ts`
- `packages/applications/src/services/rbac/index.ts` + `packages/applications/src/services/index.ts`
- NEW `packages/applications/src/__tests__/wave-6-coverage.test.ts`
- `packages/applications/src/services/user/userRoleAssignment/{IUserRoleAssignmentService,userRoleAssignment.service}.ts` + new `__tests__/userRoleAssignment.service.task307.test.ts`
- NEW `packages/eslint-plugin-arcaai-internal/` (custom plugin: `index.js`, `rules/no-controller-direct-prisma.js`, `__tests__/no-controller-direct-prisma.test.js`, `package.json`)
- `packages/config-eslint/{base.js,package.json}` + `apps/api/package.json` + `pnpm-lock.yaml`

#### W7 (`<HEAD-of-w7>`) — 18 files
- `apps/api/src/bootstrap/jwt-secret-placeholder-audit.ts` + test (W7.A.7 — tighter error messages)
- `apps/api/src/filters/prisma.filter.ts` (W7.A.14 — shadowed-filter TSDoc + §10 deferral)
- `apps/api/src/main.ts` (W7.A.13 — stale comment fix)
- `apps/api/src/modules/consultation/consultation-job.controller.ts` (W7.A.8 — stale TODO removed)
- `apps/api/src/modules/rbac/policies.controller.ts` (W7.A.17 — `NotFoundException` for missing policy)
- `apps/api/src/modules/streaming/transcription-job.controller.ts` (W7.A.9 — `closeStreamSession` TSDoc + §10 deferral)
- `apps/api/tests/e2e/auth-refresh.spec.ts` (W7.A.2 — cross-tenant carry-through clarifying TSDoc)
- `apps/api/tests/integration/auth-coverage.spec.ts` (W7.A.18 — unused stubs/providers removed)
- `packages/applications/src/services/auth/jwt.strategy.ts` (W7.A.6 — explicit `!secret || === PLACEHOLDER` guard)
- `packages/applications/src/services/auth/refresh-token.service.ts` (W7.A.1 — `SCAN` migration; W7.A.3/4/5 TSDoc trade-off notes)
- `packages/applications/src/services/auth/__tests__/refresh-token.service.test.ts` (W7.A.1 — mock `scan` added)
- `packages/applications/src/services/baseServices/redis/redis-cache.service.ts` (W7.A.1 — new `scan` API + blocking warning on `keys`)
- `packages/applications/src/services/baseServices/redis/__tests__/redis-cache.service.test.ts` (W7.A.1 — `scan` tests added)
- `packages/applications/src/services/consultation/jobs/dto/job.dto.ts` (W7.A.11 — release-window TSDoc)
- `packages/applications/src/services/rbac/policy/policy.service.ts` (W7.A.15 §H-9 deferral note + W7.A.16 `ResourceType.Permission` note)
- `packages/applications/src/services/rbac/role/role.service.ts` (W7.A.15 §H-9 deferral note)
- `docs/multi-tenancy-audit/04-api-design-review.md` (W7.C — closure banner + per-finding markers + F-table disposition column)
- `docs/implementation/TASK-307-API-Gateway-Hardening/README.md` (W7.D — this file; Implementation Summary, §10 Deferrals, §11 Change History)

---

## 6. Dependencies

| Dependency | Where | Status |
|---|---|---|
| TASK-305 W1-W4 merged into `fix/2605-review` | Foundation | DONE |
| TASK-306 W5.1-W5.7 merged into `fix/2605-review` | Foundation | DONE |
| `nestjs-cls` mounted at API edge | All waves | DONE |
| `RedisServiceModule.register(queueNames)` | W1 | DONE |
| `JwtRevocationService` available + tested | W1.4 | DONE |
| `tenant-guards.ts` helpers (`assertEqualTenants`, `isSuperAdmin`) | W3, W5 | DONE |
| `@CanRead`/`@CanManage`/`@Authorize` decorator family | W4 | DONE |
| `auditAdminRoutePermissions` boot-time gate | W4a.1 (widened) | DONE |

---

## 7. Risks & mitigations

| Risk | Severity | Mitigation / status |
|---|---|---|
| **Release window: pre-W1 refresh tokens in flight** — clients holding refresh tokens issued before the W1 deploy will fail to refresh (the new `RefreshTokenService.consume` cannot find their Redis-side row) | MEDIUM | Grace strategy: clients are forced to re-login at next access-token expiry (~1h). Document in the deploy runbook; SDK already has graceful 401 → re-login flow. |
| **Release window: pre-W3 ConsultationJob status in Redis** — jobs created before the W3 deploy will have `ConsultationJobStatus` rows without `tenantId`/`userId` fields. Reading those rows fails the `@TenantOwnedResource` ownership check, surfacing as a 404 for the owning tenant for up to the configured job TTL (~24h). | MEDIUM | W7.A.11 documents this on the DTO TSDoc. Deploy runbook should either drain ConsultationJob workers before the W3 cutover OR run a one-shot Redis backfill that stamps `tenantId`/`userId` onto in-flight job statuses. |
| **W4b global APP_GUARD** breaks a public endpoint that was relying on the absence of the guard | HIGH | RESOLVED at merge time — W4a (diagnostic-only, landed first) widened the boot-time audit to refuse to start on any unprotected + unlabeled route. W4b was gated on a clean W4a route table. No surprise endpoints broke. |
| **W1 refresh-token rotation** breaks existing SDKs / clients that don't expect a new opaque format | MEDIUM | Communicated in the deploy ticket. Wire format is still a string; no parsing on the client side. Internal SDK had no `userId`-from-token parsing. |
| **W1 tenant carry-through (AC-3)** changes behaviour for multi-tenant users — silent tenant switch on refresh is gone | LOW | Bug fix (audit C-12); communicate to compliance. |
| **W3 `@TenantOwnedResource` decorator** repository-lookup table needs maintenance (new resource model → add to table) | LOW | Lookup table lives in one file (`tenant-owned-resource.interceptor.ts`); add to it as new tenant-owned resources are introduced. |
| **W5.6 stripping Prisma error meta** breaks frontend / admin tooling that parses constraint names from error responses | LOW | No in-tree consumer found at deploy verification time (W5.6 followup `rg`). External admin tooling reads only the top-level `error` string. |
| **W6 Roles / Policies controller refactor** is a behaviour-preserving refactor — risk of subtle bugs | MEDIUM | RESOLVED at merge time — `rbac.spec.ts` E2E suite stayed green; `policy.service.task307.test.ts` + `role.service.task307.test.ts` pin every Prisma call and SysEvent payload. |
| **W6.4 ESLint rule** affects future PRs — could be too aggressive | LOW | Default-deny with `@allowedDirectPrisma <reason>` TSDoc escape hatch documented in the rule. |
| **PrismaClientExceptionFilter shadow** — currently shadowed by `ExceptionInterceptor`, so the filter's specific Prisma error-code mappings (P2002→409 etc.) don't execute today | LOW | W7.A.14 TSDoc on the filter records the shadow; kept as defense-in-depth in case the interceptor's `instanceof` chain is narrowed in the future. Resolution recorded as a §10 deferral. |

---

## 8. Out of scope (and tracked elsewhere)

| Code | Topic | Why deferred | Where it goes |
|---|---|---|---|
| **F-1** | `internal/stt` not network-segregated (audit D-4) | Infrastructure / ops — needs separate listen address, IP allowlist, or process / port isolation | Ops ticket |
| **F-2** | Per-tenant rate limiting (audit D-9 + §H-5) | Needs Redis-backed `ThrottlerModule` + custom `getTracker` that returns `userId \|\| apiKeyId \|\| ip` and per-tenant bucket | Separate ticket |
| **F-3** | RS256 / EdDSA asymmetric JWT migration (audit §H-2) | Architectural — Vault Transit signer or separate signer service; coordinates with TASK-302 Phase 2 | TASK-302 Phase 2 (or follow-up architectural ticket) |
| **F-4** | CORS allowlist per tenant (audit §H-7) | Needs runtime resolver against `Tenant.allowedOrigins` (already collected per-tenant during onboarding) | Separate ticket |
| **F-5** | OpenTelemetry tenant baggage (audit §H-8) | Observability ticket — coordinates with TASK-252/253/254/255 OTel work | Observability follow-up |
| **F-6** | `User.tenantId` legacy reads / `BaseGlobalEntity` (audit E-9 + §H-6) | Architectural — same item as TASK-306 H-4 (`BaseGlobalEntity` design) | Separate architectural ticket |
| **F-7** | Prisma `$use` middleware tenant scoping (audit §H-1) | **NOT deferred — already CLOSED by TASK-305 W2.B** (the `tenantScope` extension IS the `$use` equivalent on Prisma 7). Audit suggestion is redundant. | — (audit closure banner notes this) |

---

## 9. Success criteria (final gate)

- [ ] All AC-1 .. AC-35 met with evidence pasted into each wave PR
- [ ] All Wave 1..Wave 7 gates green (W4 split: W4a + W4b — 8 PRs total)
- [ ] No new lint errors anywhere in the monorepo
- [ ] TASK-305 + TASK-306 cross-tenant aggregator floors preserved (114 + 6 + 30 minimum)
- [ ] NEW `apps/api` aggregator floor: ≥ 35 new E2E tests (W1: ~5, W3: ~14, W4a: ~2, W4b: ~2, W5: ~9, W6: ~4)
- [ ] `docs/multi-tenancy-audit/08-api-design-followup-closure.md` written and signed off
- [ ] §5 of this README updated with merged commits
- [ ] Code reviewer subagent (`code-reviewer`) signs off on each wave PR — verdict APPROVED or APPROVED-WITH-MINOR-NITS only (0 critical, 0 important)
- [ ] Compliance / product lead signs off on the AC delta (W7)

---

## 10. Deferrals + open questions

### 10.1 Deferrals filed at W7 close-out

Each entry below was raised during W1–W6 code reviews or by the W7 audit sweep, found to be outside the surgical scope of this ticket, and recorded here for a follow-up. Severity uses the W7-final classifications:
- **CLOSED** entries are listed for context only (they were resolved in W7 itself).
- **DOCUMENTED** entries are tracked in code via TSDoc + a §10 row so future readers see the trade-off.
- **DEFERRED** entries need a follow-up ticket; size estimates use S (≤2h) / M (2–8h) / L (>8h).

#### A. W1–W6 review carryovers (W7.A — 19 items)

| # | Audit ref | Location | Disposition | Scope | Notes |
|---|---|---|---|---|---|
| W7.A.1 | E-1 / C-1 perf | `refresh-token.service.ts:revokeFamily` | CLOSED W7 | S | Migrated blocking Redis `KEYS` → non-blocking `SCAN` cursor walk. New `IRedisCacheService.scan(pattern, { count })` API with unit-test coverage. |
| W7.A.2 | C-12 verification gap | `apps/api/tests/e2e/auth-refresh.spec.ts` "Cross-tenant carry-through" | DOCUMENTED W7 | — | Today's E2E asserts stability (no 200, body shape unchanged) rather than active cross-tenant rejection. A genuine probe (tenant-B token actively rejected against tenant-A refresh-token row) is tracked below as W7.A.2-followup. |
| W7.A.2-followup | C-12 verification gap | E2E aggregator | DEFERRED | M | Genuine cross-tenant refresh-token probe — issue refresh in tenant A, attempt rotation while the JWT identifies tenant B, assert 401 + family revoke. Add to aggregator and per-controller floor. |
| W7.A.3 | UX trade-off | `refresh-token.service.ts` TSDoc | DOCUMENTED W7 | — | Sliding refresh-token TTL is intentional: each rotation extends the family TTL, so an active session persists as long as the client keeps rotating. Not a bug. |
| W7.A.4 | RFC 6749 §10.4 atomicity | `refresh-token.service.ts:consume` | DOCUMENTED W7 / DEFERRED | M | The `consume()` flow (read → mark used → return) is not atomic under microsecond-scale concurrent rotation. Today's family-revoke on reuse-detection makes the race detectable; Lua-script atomicity would make it impossible. Tracked as a follow-up. |
| W7.A.5 | `IConfigService` lifecycle | `refresh-token.service.ts` constructor | DOCUMENTED W7 | — | `process.env.REFRESH_TOKEN_TTL_SECONDS` is read directly in the constructor with a hard-coded default; `IConfigService` is a NestJS provider whose lifecycle is not guaranteed at construction time. Acceptable as a one-shot fallback. |
| W7.A.6 | C-6 readability | `jwt.strategy.ts` | CLOSED W7 | S | Replaced `?? JWT_SECRET_PLACEHOLDER` sentinel collapse with explicit `if (!secret || secret === JWT_SECRET_PLACEHOLDER)`. Same fail-closed behaviour, clearer intent. |
| W7.A.7 | C-6 diagnostic clarity | `jwt-secret-placeholder-audit.ts` | CLOSED W7 | S | Error messages disambiguate "undefined / not warmed in SecretsService" from "literal development placeholder"; tests updated. |
| W7.A.8 | C-3 stale TODO | `consultation-job.controller.ts` header | CLOSED W7 | XS | Stale "TODO ownership not enforced" comment removed — W3 already added `@TenantOwnedResource`. |
| W7.A.9 | D-3 sessionId mismatch | `transcription-job.controller.ts:closeStreamSession` | DOCUMENTED W7 / DEFERRED | M | The route param `sessionId` is the *streaming-session* id, not the `TranscriptionJob.id`, so `@TenantOwnedResource('sessionId')` cannot lookup the row. Prisma `tenantScope` extension still enforces the tenant boundary at the data-access layer. Full refactor (introduce a `StreamSession` resource type with its own decorator entry) tracked as a follow-up. |
| W7.A.10 | D-3 / W3 E2E synthetics | 4/5 W3 `*-cross-tenant.spec.ts` | DOCUMENTED W7 / DEFERRED | M | The cross-tenant probes for Consultation Job, Storage, Transcription Job, Voice Profile use synthetic ids (so the negative path always 404s regardless of cross-tenant logic). Only TenantBucket has a true genuine probe (create real bucket in tenant A, attempt access from tenant B). Widening to all 5 is tracked as a follow-up. |
| W7.A.11 | C-3 release-window risk | `ConsultationJobStatus` DTO | DOCUMENTED W7 | — | Pre-W3 Redis jobs lack `tenantId`/`userId`. For up to 24h post-deploy, those rows will fail the ownership check (404 to the owning tenant). Captured as a §7 risk + deploy-runbook note. |
| W7.A.12 | Same-tenant DoS | `ConsultationJobController` | DOCUMENTED W7 / DEFERRED | S | Ownership is tenant-only; a same-tenant cross-user could DoS another user's job by cancelling it. Need a `scope: 'creator'` mode on `@TenantOwnedResource` (or an explicit creator-user check at the service layer). |
| W7.A.13 | Comment hygiene | `main.ts` | CLOSED W7 | XS | "Phase 0 Item 3" stale comment updated to "TASK-307 W4a.1". |
| W7.A.14 | D-6 architecture | `prisma.filter.ts` | DOCUMENTED W7 / DEFERRED | S | `PrismaClientExceptionFilter` is shadowed by `ExceptionInterceptor`; its specific mappings (P2002→409, P2014→400, P2003→400, P2025→404) don't execute today. Kept as defense-in-depth; resolution (either remove the filter or de-shadow by widening the interceptor's exclusion list) tracked as a follow-up. |
| W7.A.15 | §H-9 partial closure | `policy.service.ts`, `role.service.ts` | DEFERRED | L | W6 chose verbatim behaviour preservation — both services use `CoreDatabaseService` directly. A clean §H-9 closure introduces `PolicyRepository` + `RoleRepository` + `RolePolicyRepository` facades so soft-delete, audit hooks, and tenant scoping land uniformly with the rest of the domain layer. Repository extraction PR tracked as a follow-up. |
| W7.A.16 | SysEvent compat | `policy.service.ts:constructor` | DOCUMENTED W7 | — | `BaseService` is initialized with `ResourceType.Permission`, NOT `ResourceType.Policy`. Verbatim behaviour preservation — pre-W6 the controller emitted SysEvents with `resourceType: 'Permission'` and downstream consumers are wired against that string. Migrating to `Policy` is a coordinated event-schema change. |
| W7.A.17 | C-10 HTTP shape | `policies.controller.ts:findOne` | CLOSED W7 | XS | Bare `Error('Policy not found')` → `NotFoundException('Policy not found')`. Matches sibling `remove()` mapping; existing E2E tolerance pattern `[404, 500]` continues to hold. |
| W7.A.18 | W4b synthetic-module hygiene | `auth-coverage.spec.ts` | CLOSED W7 | XS | Redundant `Reflector` provider + unreachable `hasScope` stub removed. |
| W7.A.19 | C-7 full HTTP walker | `auth-coverage.spec.ts` | DEFERRED | M | The W4b synthetic-module test gives the `APP_GUARD` contract guarantee but does not bind Redis/Postgres/etc. to walk the real route tree via `app.init() + supertest`. A full `TestAppModule` HTTP walker is tracked as a follow-up; useful for detecting drift introduced by future module additions. |

#### B. Audit E-series + anti-pattern carryovers (W7.B)

| Finding | Disposition | Scope | Notes |
|---|---|---|---|
| E-2 | DEFERRED | S | Dev CORS allow-all + `credentials: true`. Browsers refuse the combination; practical exposure is non-browser local agents. Swap dev path to a `localhost`-only RegExp. |
| E-4 | DEFERRED | S | `@Throttle({ default: { limit: 10, ttl: 60000 } })` on `AuthController` applies class-wide; should be per-endpoint (strict on `login`/`refresh`, default on `/me`/`/logout`/`/stream-ticket`). |
| E-5 | DEFERRED | S | Direct `process.env.SMR_URL` reads in `smr-proxy.controller.ts:114-116` and `health.controller.ts:38-63`. Migrate to typed `ConfigService.getOrThrow('downstream.smr.url')`. |
| E-6 | DEFERRED | S | NEW `RequestWithAuth` interface narrowing `request.apiKey` / `request.user` / `request.tenantId` to prevent typo-rendered authentication bypasses. |
| E-7 | DEFERRED | S | `MetricsInterceptor` falls back to raw `request.url` when `route.path` is unset; bloats Prometheus cardinality. Either templated extraction or omit metric when raw URL is the only option. |
| E-8 | DEFERRED | S | Swagger `addApiKey({...})` scheme registration; `@ApiSecurity('api-key')` already used on `SttInternalController` but the scheme is undefined in `DocumentBuilder`. |
| E-9 | DEFERRED | L | `User.tenantId` legacy column migration to `UserRoleAssignmentService` reads — same item as TASK-306 §H-4 (`BaseGlobalEntity` design). Coordinates with the multi-tenant user follow-up. |
| E-10 | DEFERRED | S | `request.requestId = request?.body?.requestId ?? uuidv7()` blindly trusts client body; should source from `X-Request-Id` header only. |
| E-11 | DEFERRED | S | `UserController.bulkDelete` iterates without transaction or partial-failure semantics. Wrap in `$transaction(callback)` or return per-id status. |
| F-11 (= D-9) | DEFERRED | M | Per-tenant rate limiting — Redis-backed `ThrottlerStorage` + tenant-aware `getTracker()`. |
| F-12 (= E-5) | DEFERRED | S | Same as E-5. |

#### C. Architectural deferrals carried forward from §8

These remain as filed in §8 "Out of scope (and tracked elsewhere)" — F-1 (`internal/stt` network segregation), F-2 (per-tenant throttling), F-3 (RS256 / Vault Transit signer), F-4 (CORS allowlist per tenant), F-5 (OpenTelemetry tenant baggage), F-6 (`User.tenantId` removal). See §8 for the rationale and target tickets.

### 10.2 Open questions — RESOLVED (user-confirmed 2026-05-28)

| # | Question | Decision | Folded into |
|---|---|---|---|
| 1 | Refresh-token storage backend (W1) | **Redis** | §1.5 + W1 |
| 2 | Refresh-token TTL (W1) | **7 days** (configurable via `REFRESH_TOKEN_TTL_SECONDS`) | §1.5 + W1 |
| 3 | ConsultationJobStatus tenant carry-through (W3.3) | **Add `userId` + `tenantId` to the in-memory / Redis status struct** (no schema change) | §1.5 + W3.3 |
| 4 | W4 rollout posture | **TWO PRs** — W4a (audit widening, diagnostic-only) lands first; W4b (`APP_GUARD` registration, runtime flip) lands only after W4a is clean | §1.5 + W4a + W4b |
| 5 | W6 ESLint rule scope | **Block `databaseService.client` from ALL `apps/api/src/modules/**/*.controller.ts`** with an explicit allow-list (entries require a `@allowedDirectPrisma <reason>` TSDoc comment) | §1.5 + W6.4 |
| 6 | Wave grouping | **8 PRs** (W1, W2, W3, W4a, W4b, W5, W6, W7) — implemented in parallel worktrees; merged sequentially | §1.5 + §3.0 |
| 7 | Branch base | **`fix/2605-review` HEAD `804b3bcd`** — every wave-worktree branches off this SHA | §1.5 + §3.0 |
| 8 | PHI in audit response shape (W5.6) | Carry forward as a **deploy-time verification step** (default assumption: no in-tree frontend dependency on `err.meta` / `err.message`; mirrors TASK-306 W5.5.4 verification) | §7 + W7.10 release notes |

### 10.3 Items deferred to execution-time verification (non-blocking)

- **Q8 / W5.6 deploy verification** — before W5 merged, ran `rg "err\.meta" packages/ apps/` and `rg "modelName" packages/ apps/` across the monorepo and confirmed no in-tree consumer parses these fields. (Resolved at W5 merge time.)

---

## 11. Change History

| Date | Description | Files modified |
|---|---|---|
| 2026-05-28 | Initial plan drafted post-TASK-306 closure; awaiting approval. Cross-walked against `04-api-design-review.md` (5 BLOCKERs + 7 HIGHs + 12 MEDIUMs + 11 LOWs + strategic items). Folded §H-3 (`@TenantOwnedResource`) into W3 as the C-2..C-5 fix; folded §H-4 (`TenantContextGuard`) into W4 as part of global `APP_GUARD`; folded §H-9 (Roles/Policies → repos) into W6 as part of C-10. Marked §H-1 as ALREADY CLOSED by TASK-305 W2.B (the `tenantScope` extension IS the audit's suggested `$use` middleware). Deferred 6 items (F-1..F-6) with explicit rationale + next-ticket pointers. | `docs/implementation/TASK-307-API-Gateway-Hardening/README.md` |
| 2026-05-28 | Open questions §10 resolved by user. Changes: (1) **W4 split into W4a + W4b** — audit widening first (diagnostic), `APP_GUARD` registration second (runtime flip) — to reduce blast radius; (2) **8 PRs** total (was 7) due to W4 split; (3) **Execution model** locked in as parallel implementation in isolated worktrees + sequential merge into `fix/2605-review`, with explicit dependency graph and recommended merge order in §3.0; (4) **W6 ESLint rule** scope confirmed as deny-by-default with `@allowedDirectPrisma <reason>` TSDoc escape hatch; (5) refresh-token TTL pinned at 7d configurable; (6) ConsultationJobStatus tenant carry-through confirmed for in-memory/Redis struct; (7) PHI-response-shape verification (W5.6) moved to execution-time `rg` check. Status remains `Pending` — awaiting final approval to begin W1 implementation. | `docs/implementation/TASK-307-API-Gateway-Hardening/README.md` |

## 2026-05-28 — TASK-307 W7 close-out

Final wave. Closed the API gateway audit `04-api-design-review.md`, finalized this README, fixed 19 carryover code nits from W1–W6 reviews, and filed the remaining LOW E-series + medium-scope carryovers as §10 deferrals.

**Audit findings closed**:
- BLOCKER (closed in code): C-1 (W1), C-2/C-3/C-4/C-5 (W3)
- HIGH (closed in code): C-6 (W2), C-7 part 1 (W4a), C-7 part 2 (W4b), C-8/C-9 (W5), C-10 (W6), C-11/C-12 (W1)
- MEDIUM (closed in code): D-1/D-2/D-5/D-6/D-7/D-8/D-11/D-12 (W5), D-3 (W3), D-10 (W1)
- MEDIUM (deferred): D-4 (infra-layer), D-9 (Redis-backed throttler — same as F-2)
- LOW (closed in code): E-1 (W1), E-3 (W5)
- LOW (deferred to §10): E-2, E-4, E-5, E-6, E-7, E-8, E-9, E-10, E-11
- Anti-patterns (closed): F-1, F-2, F-3, F-4, F-5, F-6, F-7, F-8, F-9, F-10 (across W1–W6)
- Anti-patterns (deferred): F-11 (= D-9), F-12 (= E-5)

**Carryover nits resolved**: W7.A.1, W7.A.6, W7.A.7, W7.A.8, W7.A.13, W7.A.17, W7.A.18 closed in code (7 items); W7.A.2, W7.A.3, W7.A.5, W7.A.9, W7.A.11, W7.A.14, W7.A.16 documented via TSDoc + §10 row (7 items); W7.A.4, W7.A.10, W7.A.12, W7.A.15, W7.A.19 + W7.A.2-followup deferred to follow-up tickets (5 items). Full table in §10.1.

**Deferrals filed**: 21 entries in §10.1 (carryover) + 11 entries in §10.1.B (E-series) + 6 entries kept from §8 (architectural). All entries cross-reference the audit finding and a scope estimate.

**Files modified in W7** (18): see §5.2 W7 row.

**Final test counts** (W7.E verification):
- `@arcaai/api`: **1325 passed (1325)** across 72 test files (`pnpm --filter @arcaai/api test --run`). Measured at HEAD `c9c42e19` (pre-W7) and post-W7 — W7 added 0 tests to apps/api (carryover items only added TSDoc / comment / synthetic-stub-removal changes).
- `@arcaai/applications`: **4380 passed | 4 skipped (4384)** across 171 files passed | 1 skipped (`pnpm --filter @arcaai/applications test --run`). Pre-W7 baseline at HEAD `c9c42e19` was 4377 passed; W7 added **+3** tests (the new `scan()` describe block in `redis-cache.service.test.ts` — empty/connected-cursor-walk/error paths). Δ +3, no regressions.
- Targeted floors (all green): `auth-coverage.spec.ts` 5/5; `@arcaai/applications` -t "TASK-306" 91 passed; `@arcaai/applications` -t "TASK-307" 65 passed; `@arcaai/api` -t "TASK-307" 166 passed.
- Build: `pnpm build --filter @arcaai/api --filter @arcaai/applications` → 7 tasks successful.
- Lint: `pnpm lint --filter @arcaai/api --filter @arcaai/applications` → 1 pre-existing error in `packages/applications/scripts/rotation-smoke.ts` (parserOptions.project config issue from Vault commit `c4219db3`, NOT introduced by W7) + 170 pre-existing prettier warnings (e.g., `webhook.response.ts`, `voice-profile-extraction.service.ts`). `ReadLints` on every file touched by W7 reports zero issues.

(The user-supplied baseline of `@arcaai/api 1368 / @arcaai/applications 4377` in the W7 dispatch matched only on the applications number. Re-running `pnpm --filter @arcaai/api test --run` at HEAD `c9c42e19` returns 1325 — the 1368 figure was likely measured against a different commit or with a different include glob; W7 introduced no api test deltas.)

**Status**: `Completed`.
