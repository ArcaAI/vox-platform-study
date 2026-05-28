# 04 — API Gateway Multi-Tenancy Review (`apps/api`)

> **STATUS: CLOSED by TASK-307 (2026-05-28)**
>
> All BLOCKER (C-1..C-12) and HIGH (D-1..D-12) findings have been addressed. E-series (LOW) findings either closed in W1/W5 or deferred to follow-up tickets (see TASK-307 README §10 Deferrals).
>
> Merge SHAs (`fix/2605-review`):
> · W1 `4c85d9f6` — Refresh-token defense + auth-lifecycle (C-1, C-11, C-12, D-10, E-1)
> · W2 `38013f4e` — JWT secret fail-closed (C-6)
> · W3 `d969b25c` — `@TenantOwnedResource` decorator + 5-controller rollout (C-2, C-3, C-4, C-5, D-3)
> · W4a `b07eb67f` — Route-permission audit widening (C-7 part 1)
> · W4b `c9c42e19` — Global `UnifiedAuthGuard` as `APP_GUARD` (C-7 part 2)
> · W5 `677f17d9` — Surface hardening sweep (C-8, C-9, D-1, D-2, D-5, D-6, D-7, D-8, D-11, D-12, E-3)
> · W6 `77068325` — Direct-Prisma removal in RBAC controllers (C-10, §H-9 partial)
> · W7 `<HEAD>` — Hygiene + docs close-out (this audit close-out + carryover nits from W1–W6 reviews)
>
> See `docs/implementation/TASK-307-API-Gateway-Hardening/README.md` for the full Implementation Summary, per-wave file lists, and §10 Deferrals.

> **Status update (2026-05-27)**: see [06-implementation-summary.md](./06-implementation-summary.md) for what was closed by TASK-305.

**Reviewer:** code-reviewer subagent
**Date:** 2026-05-25
**Scope:** `apps/api/src/**` — controllers, modules, guards, interceptors, filters, decorators, gateways, OpenAPI config, and the cross-cutting auth/authorization wiring in `packages/applications/src/{auth,authorization}/**`.
**Method:** Read-only static review using glob/grep + targeted file reads.
**Verdict (preview):** Tenant resolution is **PARTIAL / NOT defense-in-depth**. A single layer (the JWT payload + `JwtStrategy.validate`) is the only enforcement point for the tenant id. Multiple controllers either bypass tenant scoping outright (Storage, Voice-Profile, Consultation Jobs, Tenant Buckets get/tree) or accept tenant-controlled identifiers as path params without verifying ownership. The refresh-token endpoint is **trivially forgeable** (BLOCKER).

---

## A. Tenant resolution & propagation summary

### Identifier source

Tenant is identified **exclusively from the JWT `tenantId` claim** (or, for API-key auth, from `ApiKey.tenantId`). There is **no** subdomain, URL-path, or session-based tenant resolution. The `x-tenant-id` header is accepted on the wire but is informational only — `ContextInterceptor` warn-logs divergence and never overrides the JWT (`apps/api/src/interceptors/context.interceptor.ts:55-71`).

### Propagation chain

```
HTTP Request
  │
  ▼
[Express middleware]  session, body-parser, helmet-style headers (main.ts:238-340)
  │
  ▼
[ClsModule middleware]  generates correlationId, mounts CLS storage (app.module.ts:108-116)
  │
  ▼
[Global pipes]  ValidationPipe (whitelist + forbidNonWhitelisted)  (main.ts:256-263)
  │
  ▼
[Global interceptors, in order]                              (app.module.ts:49-70)
    1. MetricsInterceptor          — records duration / status
    2. ContextInterceptor          — sets cls.correlationId / requestIp / traceId
                                     warn-logs x-tenant-id divergence (no enforce)
    3. ExceptionInterceptor        — Prisma + BaseException → HTTP
    4. MaintenanceInterceptor      — 503 during maintenance
    5. ImpersonationAuditInterceptor — emits audit event when user.impersonatedBy is set
  │
  ▼
[Global guard]  RequiresIfMatchGuard — propagates @RequiresIfMatch marker (app.module.ts:78-83)
                ⚠ NO global UnifiedAuthGuard — auth is opt-in per controller
  │
  ▼
[Per-route guard chain, via @Authorize/@CanXxx/@UseGuards]
    UnifiedAuthGuard (per-controller, applied by @Authorize decorator)
      ├─ API key path  → ApiKeyService.authenticateByRawKey → cls.set('user'+'tenantId')
      └─ JWT path     → AuthGuard('jwt') → JwtStrategy.validate
                         └─ cls.set('user', userSession)
                            cls.set('tenantId', payload.tenantId)   ← single source of truth
                         then CASL PolicyEngine.buildAbility({userId, tenantId})
  │
  ▼
[Controller method]   reads cls.get('tenantId') and cls.get('user')
                       OR @UserAbility() injects the prebuilt AppAbility
  │
  ▼
[Application service]  BaseService.tenantId → cls.get('tenantId')
                       Repository.findById / findAll → Prisma where tenantId
```

### Critical observation on layering

- **Single point of failure:** Tenant scoping is enforced essentially in three places: (a) `JwtStrategy.validate` planting the claim, (b) the CASL `PolicyEngine` evaluating per-row conditions when controllers actually pass them, and (c) repositories filtering by `tenantId` IF they remember to. There is **no global tenant-context guard**, no AsyncLocalStorage-derived tenant binding on the Prisma client (no RLS, no `$use` middleware verifying `tenantId`), and the controllers themselves vary wildly in how strictly they enforce ownership.
- **Async boundaries:** `nestjs-cls` middleware mounts CLS before the request handler. CLS survives `async`/`await` correctly inside a request. **However**, fire-and-forget paths (event emitters, BullMQ workers, audit interceptor) re-emit without rebinding tenant context unless the payload itself carries `tenantId`. The `ImpersonationAuditInterceptor` reads CLS in `tap()` which is still inside the same async chain — OK.

---

## B. Endpoint inventory (controller → tenant scope source → issues)

| Controller | Base path | Tenant scope source | Auth | Notable issues |
|---|---|---|---|---|
| `AuthController` | `auth` | JWT-issuance only | `@Authorize()` on most, `login`/`refresh` public | **BLOCKER:** unsigned refresh tokens; **HIGH:** dual JWT-secret sources; direct Prisma access |
| `MyTenantController` | `tenant` | CLS `tenantId` (required) | `@Authorize()` | Clean — fails closed when CLS empty |
| `TenantController` | `admin/tenants` | path param `:id` | `@CanManage('Tenant')` | No inline `:id == cls.tenantId` guard; trusts CASL conditions |
| `TenantBucketController` | `admin/tenants/storage/buckets` | path `:id` (NO check) | `@CanManage('Tenant')` | **BLOCKER:** `getBucket`, `getBucketTree`, `getPresignedUrl`, `deleteBucket` accept any bucket id |
| `StorageController` | `storage` | path `:name` (NO check) | `@CanRead/Create/Update/Delete('Storage')` | **BLOCKER:** cross-tenant bucket access |
| `StorageAccessKeyController` | `admin/tenants/storage/keys` | service-side | `@CanManage('Tenant')` | OK if service scopes by tenant |
| `UserController` | `admin/users` | path `:id` / `:tenantId` | `@CanManage('User')` | Trusts CASL; bulk-delete iterates blindly |
| `UserRolesController` | `users/:id/roles` | self-only check at controller | `@Authorize()` | Clean — explicit `currentUser.id !== id` 403 |
| `UserSettingsController` | `user/me/settings` | CLS user.id | `@Authorize()` | Validates `selectedPipelineId` is tenant-owned — good |
| `UserPreferencesController` | `user/me/preferences` | CLS user.id (in service) | `@Authorize()` | OK — relies on service |
| `ApiKeyController` | `admin/api-keys` | CLS `tenantId` filter | `@CanManage('ApiKey')` | OK — `fetchAll` filters by tenant when present |
| `ConsultationController` | `consultations` | doctor ownership + CASL ability + shared-patient flag | `@Authorize()` | Two-layer access check; sharing flag defaults open |
| `ConsultationJobController` | `consultations/jobs` | **NONE** | `@Authorize()` | **BLOCKER:** every authenticated user can read/cancel/stream any job |
| `TranscriptionJobController` | `audio/transcription-jobs` | CLS `tenantId` (req-scoped) + pipeline ownership for create | `@Authorize()` | `getById`, `cancel`, `retry`, `list`, `getByStatus`, `streamJob` lack ownership checks |
| `AudioPipelineController` | `admin/audio/pipelines` | service-side `getById` is tenant-scoped (D-9) | `@Authorize(['manage','AsrPipeline'])` | OK — `assertPipelineOwnership` helper used; assign-tenant doesn't validate target tenant exists |
| `AudioPipelinePublicController` | `audio/pipelines` | service-side | `@Authorize()` | OK — 404 for cross-tenant |
| `SttWsGateway` | `/ws/stt-v2/stream` | ticket scope `stt_session:<sessionId>` | ticket only | Ticket validates user+scope; session<->tenant binding not re-verified at runtime |
| `SmrProxyController` | `text` | CLS user / SUPER_ADMIN fallback | `@UseGuards(JwtAuthGuard)` + per-method `@Authorize()` | DNA-style ownership enforced; `getProviders` falls back to GLOBAL on SUPER_ADMIN — risky default if role drifted |
| `SttInternalController` | `internal/stt` | API-key tenantId | `@Authorize()` + API-key | OK if `internal/` is network-isolated; but it's mounted at `/api/v1/internal/...` (NOT excluded) — see Med findings |
| `DepartmentController` | `admin/departments` | service-side | `@CanManage('Department')` | OK (CASL trust) |
| `DnaWritingStyleController` | `dna-writing-styles` | self-only `getByDoctor` check | `@Authorize()` | Clean for `getByDoctor`; `update(:reportId)` lacks ownership check pre-call |
| `DnaWritingStyleAdminController` | `admin/dna-writing-styles` | (not reviewed) | `@CanManage(...)` | — |
| `AuditLogController` | `admin/audit-logs` | none — full-text by id | `@CanRead('AuditLog')` | Trusts CASL; `fetchByUser` doesn't scope to caller's tenant |
| `MonitoringController` | `monitoring` | none — global | `@Authorize()` | Service-level uptime; not tenant-sensitive |
| `ApiHealthController` | `health` | none — **PUBLIC** | none | Leaks downstream URLs, versions, check details |
| `PrismaStudioController` | `admin/pstudio` | none | `@Public()` on GET, `@Authorize(['manage','all'])` on POST | Token in URL query string; HTML GET is public |
| `PoliciesController` | `admin/rbac/policies` | global RBAC | `@CanManage('Policy')` | Direct Prisma — anti-pattern |
| `RolesController` | `admin/rbac/roles` | global RBAC | `@CanManage('Role')` | Direct Prisma — anti-pattern |
| `PermissionCheckController` | `rbac/check` | self vs admin (manage:User) | `@Authorize()` | OK; allows `dto.tenantId` override only if admin |
| `VoiceProfileController` | `voice-profile` | none on mutations | `@Authorize(['*','UserVoiceProfile'])` | **BLOCKER:** `activate/deactivate/delete(:id)` lack ownership checks |
| `PromptManagementController` | `prompt-templates` | service-side | `@Authorize(['read','PromptTemplate'])` + per-method | (not fully read) — assumed tenant-scoped by service |

---

## C. Critical findings (BLOCKER / HIGH)

### C-1 BLOCKER — Refresh tokens are forgeable

> ✅ **RESOLVED in TASK-307 W1** (merge `4c85d9f6`) — refresh tokens are now opaque (`opaque-<jti>`) and persisted as SHA-256 hashes in Redis with single-use rotation, family-revoke on replay, and per-rotation tenant carry-forward. See `packages/applications/src/services/auth/refresh-token.service.ts` and `apps/api/tests/e2e/auth-refresh.spec.ts`.

- **File:** `apps/api/src/modules/auth/auth.controller.ts:446-499`
- **Evidence:**
  ```605:609:apps/api/src/modules/auth/auth.controller.ts
    private generateRefreshToken(userId: string): string {
      return `refresh_${userId}_${Date.now()}_${randomBytes(32).toString('hex')}`;
    }
  ```
  ```456:472:apps/api/src/modules/auth/auth.controller.ts
      const parts = body.refreshToken.split('_');
      if (parts.length < 3 || parts[0] !== 'refresh') {
        throw new UnauthorizedException('Invalid refresh token format');
      }
      const userId = parts[1];
      const user = await this.userRepository.findFirst({
        filters: {
          id: userId,
          resourceStatus: { equals: ResourceStatusType.ENABLED },
        },
        relations: { UserProfile: true },
      } as any);
      if (!user) {
        throw new UnauthorizedException('User not found or disabled');
      }
  ```
  The 32-byte `randomBytes` value is **never persisted**. The endpoint trusts whatever `userId` an attacker puts between the first two underscores.
- **Attack scenario:** Attacker learns any user id (e.g., from a public profile route, OpenAPI sample, JWT inspector, or audit log leak). They POST `{"refreshToken":"refresh_<victim-userId>_0_zzz"}` to `/api/v1/auth/refresh` and receive a fully-valid access token impersonating that user, including `tenantId` set from `User.tenantId`. **Complete account takeover, cross-tenant if victim and attacker live in different tenants.**
- **Fix — bare minimum:** Store a hashed `refresh_<rand>` token in Redis with `{ userId, tenantId, jti }` and TTL = refresh window; refresh handler must SHA-256 the incoming token, GETDEL the row, validate, then issue.
- **Fix — full:** Rotate refresh tokens on each refresh (one-time use), bind to device fingerprint, enforce reuse detection (revoke entire family on reuse), and include the original session's `tenantId` rather than `User.tenantId` so multi-tenant users don't get switched.
- **Reference:** OWASP ASVS V3.7.1 — refresh tokens MUST be cryptographically random AND verified server-side. RFC 6749 §1.5.

### C-2 BLOCKER — `StorageController` accepts arbitrary bucket names

> ✅ **RESOLVED in TASK-307 W3** (merge `d969b25c`) — `@TenantOwnedResource('name', { lookup: 'name' })` applied to `StorageController`; the new `TenantOwnedResourceInterceptor` resolves the bucket by name, asserts `entity.tenantId === cls.tenantId`, and 404s on cross-tenant probes. Cross-tenant E2E probe in `apps/api/tests/e2e/storage.controller.spec.ts`.

- **File:** `apps/api/src/modules/storage/storage.controller.ts:47-195`
- **Evidence:**
  ```70:82:apps/api/src/modules/storage/storage.controller.ts
    @Delete('buckets/:name')
    @ApiOperation({ summary: 'Delete a storage bucket' })
    @ApiParam({ name: 'name', description: 'Bucket name', type: String })
    @ApiResponse({ status: 200, description: 'Bucket deleted', type: DeleteBucketResponse })
    @CanDelete('Storage')
    async deleteBucket(@Param('name') name: string): Promise<DeleteBucketResponse> {
      if (/[.]{2}|[/\\]/.test(name)) {
        throw new BadRequestException('Invalid bucket name');
      }
      await this.s3Service.deleteBucket(name);
      return { name, deleted: true };
    }
  ```
  Only a path-traversal regex is applied. `s3Service.deleteBucket(name)` is invoked unconditionally — there is no check that the named bucket belongs to the caller's tenant. The same pattern applies to `getBucket`, `listFiles`, `uploadFile`, `getFileInfo`, `deleteFile`.
- **Attack scenario:** Tenant A user with the `delete:Storage` CASL permission iterates known/guessable tenant bucket names (often `<tenantKey>-audio`, `<tenantKey>-public`, etc., or read from `/admin/tenants/storage/buckets` if they have list access) and deletes tenant B's buckets, or downloads any file via `getFileInfo` which mints a presigned URL.
- **Fix — bare minimum:** Resolve the requested bucket via `tenantBucketService.getBucketByName(name)` and verify `bucket.tenantId === cls.get('tenantId')`. Return 404 (not 403) when mismatch.
- **Fix — full:** Drop free-form bucket names entirely; address buckets by tenant-scoped slug (`audio`, `public`, …) and resolve to the physical bucket inside the service layer. Add a `BucketTenancyGuard` and `@TenantOwnedBucket()` decorator.
- **Reference:** OWASP A01:2021 Broken Access Control.

### C-3 BLOCKER — `ConsultationJobController` has no per-job ownership check

> ✅ **RESOLVED in TASK-307 W3** (merge `d969b25c`) — `@TenantOwnedResource('jobId', { source: 'redis', model: 'ConsultationJob' })` applied to all per-job routes. The interceptor reads the cached job, asserts `tenantId` match, and 404s on cross-tenant. Persistence-side `tenantId`/`userId` capture also added to `ConsultationJobStatus` (see W7.A.11 release-window note).

- **File:** `apps/api/src/modules/consultation/consultation-job.controller.ts:11-71`
- **Evidence:**
  ```12:16:apps/api/src/modules/consultation/consultation-job.controller.ts
   * Authorisation: any authenticated user (existing pattern for the async
   * summary endpoints in `ConsultationController`). Per-job ownership checks
   * are tracked as a follow-up (TASK-263 §6) once `ConsultationJobStatus`
   * carries `userId`/`tenantId` fields.
  ```
  ```34:71:apps/api/src/modules/consultation/consultation-job.controller.ts
    @Get(':jobId')
    async getJob(@Param('jobId') jobId: string): Promise<JobStatusResponse> {
      const status = await this.jobService.getJobStatus(jobId);
      if (!status) { throw new NotFoundException(`Job ${jobId} not found`); }
      return status;
    }
    @Patch(':jobId/cancel')
    async cancelJob(@Param('jobId') jobId: string): Promise<{ ok: true }> { ... }
    @Get(':jobId/stream')
    @Sse()
    @StreamScope({ namespace: 'consultation_job', param: 'jobId' })
    streamJob(@Param('jobId') jobId: string): Observable<MessageEvent> { ... }
  ```
- **Attack scenario:** Any authenticated user — including one from tenant B — can:
  1. Poll `GET /consultations/jobs/<uuidv7>` to enumerate job ids (uuidv7 is sortable / partially predictable from time).
  2. Read PHI-bearing summary/pre-summary/comprehensive payloads via `JobStatusResponse.result`.
  3. Cancel another doctor's running job (DoS).
  4. Subscribe to SSE updates and exfiltrate clinical text in real time.
  The `@StreamScope` decorator on `streamJob` only ties the ticket to `jobId`; the issuer's tenant is never compared to the job's tenant.
- **Fix — bare minimum:** Read `cls.get('tenantId')` and `cls.get('user').id` in each handler. Have `ConsultationJobService.getJobStatus` accept `requesterUserId` + `requesterTenantId` and 404 on mismatch.
- **Fix — full:** Make `ConsultationJobStatus` carry both fields and enforce at the service boundary (defense-in-depth: controller + service + cache key prefix). Mint stream tickets with `tenantId` and verify on consumption that `consultation.tenantId === ticket.tenantId`.
- **Reference:** HIPAA §164.312(a)(1) — access control; OWASP A01:2021.

### C-4 BLOCKER — `TenantBucketController` cross-tenant bucket reads

> ✅ **RESOLVED in TASK-307 W3** (merge `d969b25c`) — `@TenantOwnedResource('id', { lookup: 'name' })` applied to `getBucket`/`getBucketTree`/`getPresignedUrl`/`deleteBucket`; bucket name lookup is tenant-scoped via the interceptor and 404s on cross-tenant. Genuine cross-tenant E2E probe in `apps/api/tests/e2e/tenant-bucket.controller.spec.ts`.

- **File:** `apps/api/src/modules/tenant-bucket/tenant-bucket.controller.ts:25-82`
- **Evidence:**
  ```25:46:apps/api/src/modules/tenant-bucket/tenant-bucket.controller.ts
    @Get(':id')
    async getBucket(@Param('id') id: string): Promise<TenantBucketResponse | null> {
      return this.tenantBucketService.getBucketById(id);
    }
    @Get(':id/tree')
    async getBucketTree(@Param('id') id: string, @Query('prefix') prefix?: string)
  ```
  `getBucketById`, `getBucketTree`, `getPresignedUrl`, `deleteBucket` only require `@CanRead('Storage')` / `@CanDelete('Storage')`. Tenant id of the bucket is not compared with `cls.tenantId` in the controller — depends entirely on whether the service layer filters. (Service code not in scope of this review, but pattern is unsafe.)
- **Attack scenario:** Tenant admin in tenant A reads tenant B's bucket tree via `GET /admin/tenants/storage/buckets/<id-of-B>/tree` and mints presigned download URLs for tenant B's PHI files via `GET .../presigned-url?key=...`.
- **Fix — bare minimum:** Add controller-level guard:
  ```ts
  const bucket = await this.tenantBucketService.getBucketById(id);
  if (!bucket || bucket.tenantId !== this.cls.get('tenantId')) throw new NotFoundException();
  ```
- **Fix — full:** Lift to a `@TenantOwnedResource('bucket', 'id')` decorator + interceptor that resolves the resource and 404s before the handler runs.

### C-5 BLOCKER — `VoiceProfileController` mutations lack ownership check

> ✅ **RESOLVED in TASK-307 W3** (merge `d969b25c`) — `@TenantOwnedResource('id')` applied to `activate`/`deactivate`/`delete(:id)`; the interceptor enforces tenant ownership on every mutation. E2E tolerance pattern documented in W3 review (synthetic ids; widening tracked in W7.A.10 §10 deferral).

- **File:** `apps/api/src/modules/voice-profile/voice-profile.controller.ts:88-116`
- **Evidence:**
  ```88:106:apps/api/src/modules/voice-profile/voice-profile.controller.ts
    @Patch(':id/activate')
    @Authorize(['update', 'UserVoiceProfile'])
    async activate(@Param('id') id: string): Promise<{ success: boolean }> {
      await this.voiceProfileService.activate(id);
      return { success: true };
    }
    @Patch(':id/deactivate')
    @Authorize(['update', 'UserVoiceProfile'])
    async deactivate(@Param('id') id: string): Promise<{ success: boolean }> { ... }
    @Delete(':id')
    @Authorize(['delete', 'UserVoiceProfile'])
    async deleteById(@Param('id') id: string): Promise<VoiceProfileResponse> { ... }
  ```
  Any doctor with the `update:UserVoiceProfile` ability can activate/deactivate/delete *any* voice profile by id. Voice biometric data is HIPAA-sensitive (identity).
- **Attack scenario:** Doctor in tenant A guesses (or reads from logs / audit data they have access to) a profile id from tenant B and disables tenant B's voice authentication, allowing a separate attack vector.
- **Fix — bare minimum:** `const vp = await this.voiceProfileService.getById(id); if (vp.userId !== this.getUserId() && !ability.can('manage','UserVoiceProfile', vp)) throw NotFoundException`.
- **Fix — full:** Make `voiceProfileService.activate/deactivate/deleteById` require `requesterUserId` and assert ownership at the service layer too (defense-in-depth).

### C-6 HIGH — Dual / divergent JWT secret sources with hard-coded fallback

> ✅ **RESOLVED in TASK-307 W2** (merge `38013f4e`) — `assertJwtSecretNotPlaceholder` boot-time audit refuses to boot when `JWT_SECRET_KEY` is undefined or the literal development placeholder; `JwtStrategy` mirrors the check at construction time (W7.A.6 tightened to an explicit `!secret || secret === JWT_SECRET_PLACEHOLDER` predicate). Single source of truth is now `SecretsService.getSecretSync('JWT_SECRET_KEY')`.

- **Files:**
  - `apps/api/src/modules/auth/auth.controller.ts:147,404,479`
  - `packages/applications/src/services/auth/jwt.strategy.ts:22`
- **Evidence:**
  ```146:148:apps/api/src/modules/auth/auth.controller.ts
        const jwtSecretKey = this.appSettingsService.getValueWithDefault('JWT_SECRET_KEY', 'default-jwt-secret-key-change-in-production');
        const jwtExpiresIn = this.appSettingsService.getValueWithDefault('JWT_EXPIRES_IN', '1h') as string;
  ```
  ```22:22:packages/applications/src/services/auth/jwt.strategy.ts
      const jwtSecret = secretsService.getSecretSync('JWT_SECRET_KEY') ?? 'default-jwt-secret-key-change-in-production';
  ```
- **Attack scenario:** Sign-and-verify use **two different fetchers** (`AppSettingsService` vs `SecretsService` aka Vault). In any environment where Vault is unreachable but app-settings has the key (or vice versa), they will diverge: the issuer signs with secret X, the verifier validates against secret Y → all logins break silently; if both fall through to the literal `'default-jwt-secret-key-change-in-production'`, **any external party who has read the repo can mint valid HOPE JWTs**. Additionally, JWT alg is the passport-jwt default (HS256 unless overridden) — attacker can craft tokens with arbitrary `tenantId`/`roles` claims.
- **Fix — bare minimum:** Refuse to start (`throw new Error()` in `JwtStrategy` constructor) when the JWT secret resolves to the placeholder; pull both sign and verify from `SecretsService` only.
- **Fix — full:** Move to asymmetric keys (RS256 / EdDSA) with a public-key-only verifier in the gateway and a private signer in an isolated service.

### C-7 HIGH — UnifiedAuthGuard is NOT global; auth is opt-in

> ✅ **RESOLVED in TASK-307 W4a + W4b** (merges `b07eb67f`, `c9c42e19`) — W4a widened `auditAdminRoutePermissions` from `/admin/*` to every controller so boot refuses to start when any non-`@Public()` route lacks an explicit permission decorator. W4b registered `UnifiedAuthGuard` as `APP_GUARD` so authentication runs by default for every route, and routes must opt-out via `@Public()` instead of opting in. Synthetic-module test in `apps/api/tests/integration/auth-coverage.spec.ts` proves both walkthroughs.

- **File:** `apps/api/src/app.module.ts:78-83`, `packages/applications/src/authorization/authorization.module.ts:20-26`
- **Evidence:**
  ```78:83:apps/api/src/app.module.ts
  const guards = [
    {
      provide: APP_GUARD,
      useClass: RequiresIfMatchGuard,
    },
  ];
  ```
  `UnifiedAuthGuard` exists as a Global injectable but is **never registered as `APP_GUARD`**. It's applied only when a controller / handler is decorated with `@Authorize()` (which `UseGuards(UnifiedAuthGuard)`).
- **Attack scenario:** Any controller method or new module that forgets the `@Authorize()` / `@CanXxx()` decorator is **fully public, regardless of the URL path**. The boot-time `auditAdminRoutePermissions` (`apps/api/src/bootstrap/admin-route-permission-audit.ts:32`) catches `/admin/*` only — non-admin paths (`text/*`, `audio/*`, `consultations/*`, `voice-profile/*`, `storage/*`, `dna-writing-styles/*`, `tenant/*`) would silently leak if a decorator were ever omitted. There is no second line of defense.
- **Fix — bare minimum:** Register `UnifiedAuthGuard` as a global `APP_GUARD` so the default is **deny**, and require an explicit `@Public()` to opt out. The audit script in `bootstrap/admin-route-permission-audit.ts` can then be widened to *every* route.
- **Fix — full:** As above + add an integration test that walks the router and asserts every endpoint has either `@Public()` OR a non-empty `REQUIRED_PERMISSIONS_KEY` metadata.

### C-8 HIGH — `/api/v1/health/services{/:key}` is unauthenticated and leaks internals

> ✅ **RESOLVED in TASK-307 W5** (merge `677f17d9`) — `/health/services{/:key}` now requires `@Authorize()` (any authenticated caller), and the public payload omits the upstream `version` and `checks` fields. Full detail is logged server-side at debug level only. `/health/live`, `/health/ready`, `/health/startup`, `/health` remain `@Public()` for Kubernetes probes but expose only the local status.

- **File:** `apps/api/src/modules/health/health.controller.ts:143-192`
- **Evidence:** Controller is mounted with no `@Authorize()` / `@Public()` — relies on the absence of `UnifiedAuthGuard` being global. `checkServices` returns:
  ```197:212:apps/api/src/modules/health/health.controller.ts
        const response = await this.httpService.axiosRef.get(`${svc.url}${svc.healthEndpoint}`, { timeout: 5000 });
        const data = response.data;
        return {
          status: data.status || 'healthy',
          service: data.service || svc.name,
          version: data.version,
          uptime_seconds: data.uptime_seconds,
          duration_ms: Date.now() - start,
          checks: data.checks,
        };
  ```
  …including downstream URLs implicitly (via 404 latency), version strings, and the entire `checks` payload from each Python service (which often includes DB connectivity / model load state / queue depth).
- **Attack scenario:** Unauthenticated reconnaissance: an attacker probes `/api/v1/health/services` to map the entire microservice topology, identify vulnerable versions, and gauge load. Even worse: passing arbitrary `serviceKey` triggers an outbound HTTP request from the API container to the configured `*_URL` (SSRF surface if the URLs were ever mis-resolved or env-poisoned, though the current allowlist of 4 keys mitigates this).
- **Fix — bare minimum:** Keep `/live`, `/ready`, `/startup` public; require `@Authorize()` (any authenticated user, or `manage:Tenant`) for `/services` and `/services/:key`. Strip `version` and `checks` from the public response, or limit to platform admins.

### C-9 HIGH — `PrismaStudioController` GET handler is `@Public()` and accepts the JWT via URL query string

> ✅ **RESOLVED in TASK-307 W5** (merge `677f17d9`) — `PrismaStudioController` GET and POST now require `@Authorize(['manage', 'all'])` (no `@Public()`). The legacy query-string JWT path is gone; the controller is also gated by `ENABLE_PRISMA_STUDIO=true` + `NODE_ENV=development` so it cannot ship to production by accident.

- **File:** `apps/api/src/modules/pstudio/pstudio.controller.ts:21-39`
- **Evidence:**
  ```21:39:apps/api/src/modules/pstudio/pstudio.controller.ts
    @Get()
    @Public()
    @ApiExcludeEndpoint()
    serveStudio(@Req() req: Request, @Res() res: Response, @Query('token') token?: string) {
      if (!token) {
        res
          .status(401)
          .type('text/plain')
          .send('Access denied. Provide a valid JWT token as ?token= query parameter.\n\n' + 'Usage: /api/v1/admin/pstudio?token=<your-jwt-token>');
        return;
      }
  ```
  The GET endpoint is fully `@Public()`, performs **no** validation of the token, and embeds it directly into the HTML returned to the browser. The actual data-access POST is auth-gated. The Studio is enabled in dev/non-prod by default (`app.module.ts:162-167`).
- **Attack scenario:** Long-lived JWTs land in CDN logs, browser history, server access logs, and proxy logs because they're in the query string. Any operator with log access can replay them. The class-level `@CanManage('all')` is bypassed for the GET because `@Public()` overrides.
- **Fix — bare minimum:** Require `Authorization: Bearer` on GET too (use cookie + session for the studio page) and never accept the JWT via query string. Disable Prisma Studio in any non-local-dev environment.

### C-10 HIGH — Direct Prisma access in controllers bypasses the domain/repository tenant guard

> ✅ **RESOLVED in TASK-307 W6** (merge `77068325`) — `PoliciesController` and `RolesController` now delegate all data access to `PolicyService` / `RbacRoleService` in `packages/applications`. A new ESLint rule in `apps/api/src/modules/**` bans direct `@arcaai/database` / `CoreDatabaseService` imports from controllers. Partial §H-9 closure noted: the new services use `CoreDatabaseService` directly (verbatim behaviour preservation) rather than dedicated `PolicyRepository`/`RoleRepository` facades — see W7.A.15 §10 deferral.

- **Files:**
  - `apps/api/src/modules/auth/auth.controller.ts:132-138, 363-371, 576-586` (`this.databaseService.client.userRoleAssignment.findFirst/findMany`)
  - `apps/api/src/modules/rbac/policies.controller.ts:67-104, 116-191, 213-322` (every CRUD)
  - `apps/api/src/modules/rbac/roles.controller.ts:60-582` (every CRUD)
- **Evidence:**
  ```132:138:apps/api/src/modules/auth/auth.controller.ts
        const tenantRoleAssignment = await this.databaseService.client.userRoleAssignment.findFirst({
          where: {
            userId: user.id,
            tenantId: resolvedTenantId,
            resourceStatus: ResourceStatusType.ENABLED,
          },
        });
  ```
- **Attack scenario:** Policy/Role admin endpoints never go through a repository, so the tenant filter, soft-delete masking, and audit-trail hooks (events emitted by `BaseService.broadcastSysEvent`) are bypassed or hand-rolled. Easy to forget the `tenantId` filter on a new endpoint added by a junior developer.
- **Fix — bare minimum:** Replace direct Prisma calls with the appropriate repository methods (`UserRoleAssignmentRepository`, `RoleRepository`, `PolicyRepository`). For the auth controller specifically, surface `userRoleAssignmentService.findForUserTenant(userId, tenantId)` in the application services package.
- **Reference:** Project rule `01-development-workflow.mdc` — "Controller calls Prisma directly" is listed as an anti-pattern.

### C-11 HIGH — Logout does not revoke the JWT `jti`

> ✅ **RESOLVED in TASK-307 W1** (merge `4c85d9f6`) — `/auth/logout` now revokes the access-token `jti` via `JwtRevocationService` and revokes the refresh-token family via `RefreshTokenService.revokeFamily()`. The `UnifiedAuthGuard` consults the revocation cache on every request. E2E coverage in `apps/api/tests/e2e/auth-refresh.spec.ts` proves a revoked access token returns 401.

- **File:** `apps/api/src/modules/auth/auth.controller.ts:205-243`
- **Evidence:** `logout()` only emits `trackAuthentication` and returns success. It never invokes `jwtRevocationService.revoke(user.jti, user.exp)` even though that service is injected and is used correctly by `revokeImpersonation`. Tokens with the default 1h TTL remain valid after logout.
- **Attack scenario:** Stolen-laptop / shared-machine logout does not actually end the session. Combined with C-1 (forgeable refresh tokens) an attacker can keep refreshing the access token after the user thinks they logged out.
- **Fix:** Add `if (user.jti) await this.jwtRevocationService.revoke(user.jti, user.exp);` to `logout()`. Also delete/expire the refresh-token record (after C-1 fix).

### C-12 HIGH — `auth/refresh` ignores the original session's tenant scope

> ✅ **RESOLVED in TASK-307 W1** (merge `4c85d9f6`) — `RefreshTokenService.consume()` returns the persisted `{userId, tenantId, jti, familyId}` and `AuthController.refresh` re-issues the access token with the original session's `tenantId`. Cross-tenant carry-through is exercised by `apps/api/tests/e2e/auth-refresh.spec.ts` (note W7.A.2: the current probe asserts stability rather than active rejection; a stronger probe is tracked as a §10 deferral).

- **File:** `apps/api/src/modules/auth/auth.controller.ts:475-498`
- **Evidence:** The refresh handler reads `user.tenantId` from the `User` table:
  ```486:494:apps/api/src/modules/auth/auth.controller.ts
        const tokenPayload = {
          id: user.id,
          username: user.username,
          email: user.UserProfile?.email || '',
          roles,
          permissions,
          tenantId: user.tenantId || '',
  ```
  …rather than carrying forward the `tenantId` that was selected at `login` (where a user with multiple tenant assignments can choose). After refresh, the user is bounced to whatever default tenant lives on the User row, ignoring the active session's context.
- **Attack scenario:** User logged into tenant B (where they have a role) refreshes; they're silently switched to tenant A (their User.tenantId). Subsequent reads/writes hit tenant A's data with tenant A's permissions, surprising the user and potentially writing tenant-B-flavored data into tenant A.
- **Fix:** After C-1 is fixed, store the original `tenantId` in the refresh-token row and put it back into the new JWT.

---

## D. Medium findings

### D-1 — `x-tenant-id` divergence is only warn-logged

> ✅ **RESOLVED in TASK-307 W5** (merge `677f17d9`) — `ContextInterceptor` now hard-rejects divergent `x-tenant-id` with 400, rather than warn-logging and silently dropping the header. CLS `tenantId` remains JWT-sourced; the header is only accepted when it exactly matches.

- **File:** `apps/api/src/interceptors/context.interceptor.ts:60-71`
- **Why it matters:** SEC-J in the comment claims the JWT-derived tenant cannot be overridden — true, but a forged header on a high-privilege super-admin request reaches the controller. Anything downstream that reads the header (e.g., logging, audit metadata, side-channel) would record the wrong tenant.
- **Fix:** Throw `400 Bad Request` on divergence; the SDK should never set the header when a JWT is present.

### D-2 — `ConsultationController.isSharingEnabled` defaults open on error and missing setting

> ✅ **RESOLVED in TASK-307 W5** (merge `677f17d9`) — `isSharingEnabled` now default-closes (`return setting?.value === 'true'`). On error it returns `false` and logs the failure rather than allowing PHI sharing.

- **File:** `apps/api/src/modules/consultation/consultation.controller.ts:145-161`
- **Evidence:**
  ```155:161:apps/api/src/modules/consultation/consultation.controller.ts
        const setting = settings[0];
        if (!setting) return true;
        return setting.value !== 'false';
      } catch {
        return true;
      }
  ```
- **Why it matters:** When the global-setting row is missing, or the lookup throws (network / DB blip), the controller assumes **sharing IS enabled** — granting cross-doctor PHI access to any colleague who has overlapping patient history. HIPAA "minimum necessary" principle wants the opposite default.
- **Fix:** Default-closed; require an explicit row with `value === 'true'` to enable sharing.

### D-3 — `TranscriptionJobController` job mutation/read endpoints lack ownership check

> ✅ **RESOLVED in TASK-307 W3** (merge `d969b25c`) — `@TenantOwnedResource('id')` applied to `getById`/`cancel`/`retry`/`streamJob`. `closeStreamSession(:sessionId)` is intentionally not decorated because the route parameter is the streaming-session id, not the job id — Prisma `tenantScope` extension enforces the boundary at the data-access layer (see W7.A.9 TSDoc + §10 deferral for the full refactor).

- **File:** `apps/api/src/modules/streaming/transcription-job.controller.ts:361-403`
- **Evidence:** `getById`, `cancel`, `retry`, `streamJob`, `list`, `getByStatus`, `getByConsultation`, `closeStreamSession` all dispatch to `this.jobService.*` with no tenant assertion. The create path (`transcribeFile`, `createStreamSession`) does call `assertPipelineOwnership`, but reads of an existing job by id are unprotected.
- **Why it matters:** Mirrors C-3 for STT. The fact that `getTenantId()` is invoked only in the create path is suspicious.
- **Fix:** Add `assertJobOwnership(jobId)` analogous to `assertPipelineOwnership`.

### D-4 — `internal/stt` is exposed at `/api/v1/internal/stt/*`, not network-segregated

> 📝 **DEFERRED — see TASK-307 README §10**: network segregation is an infrastructure-layer concern (ingress / service-mesh / NetworkPolicy rules) outside this code repo's scope. The API-key auth on `SttInternalController` remains the application-layer defense; segregation should be added at the cluster ingress.

- **File:** `apps/api/src/main.ts:200-202`, `apps/api/src/modules/internal/stt-internal.controller.ts:19`
- **Evidence:**
  ```200:202:apps/api/src/main.ts
    app.setGlobalPrefix(globalPrefix, {
      exclude: ['/metrics'],
    });
  ```
  The "internal" controller is mounted under the public global prefix `/api/v1/internal/stt/...`. Its only protection is API-key auth + the `@Authorize()` decorator. There is no IP-allowlist filter and no separate process / port.
- **Why it matters:** If an API key with the right scopes leaks (or a tenant admin generates one and exfiltrates it), they can call worker-only endpoints that update job state, create transcripts, etc. — bypassing the tenant boundaries that would apply to a regular user.
- **Fix:** Mount on a separate listen address, or add an IP allowlist guard that verifies the source IP belongs to the worker subnet.

### D-5 — `TenantController.update(:id)` / `delete(:id)` / `getUsage(:id)` / `fetchByCodeName` lack `:id == cls.tenantId` inline guard

> ✅ **RESOLVED in TASK-307 W5** (merge `677f17d9`) — `TenantController` now asserts `:id === cls.get('tenantId')` inline on `update`/`delete`/`getUsage` (platform-admin paths excepted via explicit `@PlatformAdmin()` opt-in). `fetchByCodeName` is similarly tenant-bound. The inline guard backstops CASL conditions in case a policy is misconfigured.

- **File:** `apps/api/src/modules/tenant/tenant.controller.ts:73-164`
- **Why it matters:** Trusts CASL conditions to scope `manage:Tenant` (presumably restricted to SUPER_ADMIN). One policy change that grants tenant admins `manage:Tenant` without a condition would silently let them touch sibling tenants.
- **Fix:** Inline `if (!isSuperAdmin(user) && id !== user.tenantId) throw new ForbiddenException()` even when CASL is supposed to do it (defense-in-depth).

### D-6 — Prisma error responses leak schema metadata

> ✅ **RESOLVED in TASK-307 W5** (merge `677f17d9`) — `ExceptionInterceptor` and `PrismaClientExceptionFilter` strip `err.meta` and the raw Prisma message from client responses. Full detail is logged server-side at error level only. (See W7.A.14 TSDoc note: the filter is currently shadowed by the interceptor and kept as defense-in-depth; resolving the shadow is tracked in §10.)

- **Files:** `apps/api/src/interceptors/exception.interceptor.ts:46-63`, `apps/api/src/filters/prisma.filter.ts:33-78`
- **Evidence:**
  ```55:62:apps/api/src/interceptors/exception.interceptor.ts
            const errorResponse = {
              status: HttpStatus.BAD_REQUEST,
              error: 'Prisma Error',
              message: err.message,
              meta: err.meta,
              correlationId: requestId,
            };
  ```
- **Why it matters:** `err.message` and `err.meta` carry column names, constraint names, and frequently the offending row id. Helpful for the attacker mapping the schema and probing for cross-tenant collisions.
- **Fix:** Return a generic `{statusCode, error, correlationId}` to the client; keep full detail in server logs only.

### D-7 — `AuditLogController.fetchByUser` doesn't scope to caller's tenant

> ✅ **RESOLVED in TASK-307 W5** (merge `677f17d9`) — `AuditLogController.fetchByUser` and the underlying repository query now filter by `cls.get('tenantId')`. A caller from tenant B can no longer enumerate audit logs by guessing user ids from tenant A.

- **File:** `apps/api/src/modules/audit-log/audit-log.controller.ts:117-141`
- **Why it matters:** A tenant admin with `read:AuditLog` could potentially read audit rows for users in other tenants if CASL policy isn't perfectly conditioned. Audit log content frequently contains PHI in its `data`/`metadata` blobs.
- **Fix:** Inline-filter: `const tenantId = cls.get('tenantId'); pass into auditLogService.fetchAllCreatedByUser(...)`.

### D-8 — WebSocket close codes differentiate "missing param" from "auth failure"

> ✅ **RESOLVED in TASK-307 W5** (merge `677f17d9`) — `SttWsGateway` collapses all rejection paths (missing param, invalid ticket, wrong scope, expired ticket, revoked jti) to a single close code + opaque reason. Distinguishing detail is logged server-side only, eliminating the status-code enumeration oracle.

- **File:** `apps/api/src/modules/streaming/stt-ws.gateway.ts:75-105`
- **Why it matters:** A probing client can tell `4001 missing sessionId` apart from `4401 invalid ticket / wrong scope`, enabling sessionId enumeration: it can keep guessing sessionIds and only the ticket-scope check rejects valid-but-cross-tenant sessions. Combine with a leaked ticket and you've exfiltrated PHI.
- **Fix:** Return a single generic 4401 with a constant reason; log the real reason server-side.

### D-9 — Throttle is per-IP only

> 📝 **DEFERRED — see TASK-307 README §10**: per-tenant / per-user throttle buckets require switching `ThrottlerModule` to Redis-backed storage and extending `ThrottlerGuard.getTracker()` to read `cls.get('tenantId')`. The redis infra is already in place; this is recorded as a follow-up ticket (medium scope).

- **File:** `apps/api/src/modules/throttle/throttle.module.ts` + `rate-limit-config.service.ts`
- **Why it matters:** `ThrottlerGuard` default tracker is IP. In a SaaS where many tenants share egress NAT (corporate gateways, mobile carriers), one tenant's traffic burst starves others. Conversely, distributed scrapers from many IPs aren't rate-limited per tenant.
- **Fix:** Implement a custom `getTracker` that returns `userId || apiKeyId || ip` and a separate per-tenant bucket.

### D-10 — Refresh token format leaks `userId`

> ✅ **RESOLVED in TASK-307 W1** (merge `4c85d9f6`) — the refresh-token wire format is now `opaque-<jti>` (jti is `randomBytes(16).hex`). The `userId`, `tenantId`, and family pointer live server-side in Redis under a SHA-256 hash of the opaque token. Tests in `auth-refresh.spec.ts` assert no PII leaks into the bearer string.

- **File:** `apps/api/src/modules/auth/auth.controller.ts:608-610`
- **Why it matters:** Even ignoring C-1, the format `refresh_<userId>_<ts>_<rand>` exposes the user id to any party who sees the token (CDN logs, error reports). User ids are sensitive in healthcare.
- **Fix:** Opaque `randomBytes(48).toString('base64url')` only; store the mapping in Redis.

### D-11 — Health controller throttle is generous (300/min)

> ✅ **RESOLVED in TASK-307 W5** (merge `677f17d9`) — `ApiHealthController` throttle lowered to 30 req/min. Kubernetes probe schedules sit well below the new cap; unauthenticated reconnaissance against `/live`, `/ready`, `/startup`, `/health` is now meaningfully rate-limited.

- **File:** `apps/api/src/modules/health/health.controller.ts:69`
- **Why it matters:** With `/services` public, an unauthenticated attacker can fire 300 service probes per minute per IP, fanning out 4 outbound HTTP calls each = 1200 outbound RPS per IP. SSRF-DDoS amplifier.
- **Fix:** Lower to `{ limit: 30, ttl: 60000 }` for the public probes; gate `/services{/:key}` behind auth.

### D-12 — `SmrProxyController.getProviders` silently falls back to the GLOBAL tenant for SUPER_ADMIN

> ✅ **RESOLVED in TASK-307 W5** (merge `677f17d9`) — `SmrProxyController.getProviders` no longer silently widens to the GLOBAL tenant for SUPER_ADMIN. The fallback is removed; callers must either be tenant-scoped or pass an explicit `?tenantId=` with platform-admin authorization.

- **File:** `apps/api/src/modules/streaming/smr-proxy.controller.ts:181-192`
- **Why it matters:** If a SUPER_ADMIN role token is somehow planted on a regular request path (impersonation, JWT forgery via C-6, etc.), this controller substitutes the global tenant config. A tenant admin whose role was mis-seeded with `SUPER_ADMIN` would see global LLM provider config.
- **Fix:** Require an explicit `?tenantKey=__GLOBAL__` query parameter to opt into the global fallback rather than implicit role-based fallback.

---

## E. Low / hygiene findings

### E-1 — JWT `jti` is predictable

> ✅ **RESOLVED in TASK-307 W1** (merge `4c85d9f6`) — `jti` is now `randomBytes(16).toString('hex')` (32 hex chars). No user id, no timestamp; the revocation cache key carries no information density an attacker could pre-compute. Asserted by `auth.controller.task307.test.ts` ("W1.6 — JWT jti is randomBytes(16).hex ...").

- `auth.controller.ts:157` — `jti: \`auth-${user.id}-${Date.now()}\``. Combined with the revocation cache being a SETEX, an attacker who knows a user id and approximate clock can pre-compute likely jtis. Use `randomBytes(16).toString('hex')`.

### E-2 — CORS in development allows all origins with `credentials: true`

> 📝 **DEFERRED — see TASK-307 README §10**: dev-only path; production CORS is gated by `CORS_ALLOWED_ORIGINS`. Modern browsers refuse the wildcard + credentials combination, so the practical exposure is non-browser local agents (axios/curl). Tracked as a follow-up to swap dev to a `localhost`-only RegExp.

- `main.ts:135-137` + `corsOptions.credentials = true` (`main.ts:294`). Modern browsers refuse this combination, but axios/fetch from other domains can still hit the API; a malicious local page can issue authenticated requests during development. Use `localhost`-only patterns even in dev.

### E-3 — `ApiHealthController` does not strip `data.service` and `data.version` from downstream responses

> ✅ **RESOLVED in TASK-307 W5** (merge `677f17d9`) — `probeService()` now returns the sanitised `ServiceProbeResult` shape (status / service / uptime_seconds / duration_ms / error). The upstream `version` and `checks` are logged server-side at debug level only.

- Leaks Python service versions to whatever consumes the public health endpoint.

### E-4 — `Throttle({ default: { limit: 10, ttl: 60000 } })` on `AuthController` applies to ALL endpoints in the class

> 📝 **DEFERRED — see TASK-307 README §10**: per-endpoint `@Throttle()` decoration (strict on `login`/`refresh`, lenient on `/me`/`/logout`/`/stream-ticket`) is a small but contract-changing edit. Tracked as a small follow-up.

- Including `/auth/me`, `/auth/logout`, `/auth/stream-ticket`, etc. — legitimate clients fetching `/me` repeatedly during page navigation will hit the strict limit unnecessarily. Move the strict limit to `login` + `refresh` only.

### E-5 — Direct `process.env.SMR_URL` reads in controllers

> 📝 **DEFERRED — see TASK-307 README §10**: `smr-proxy.controller.ts:114-116` and `health.controller.ts:38-63` still read `process.env.SMR_URL` / `TTS_URL` / `STT_V2_URL` / `NLP_URL` directly. Migration to `ConfigService.getOrThrow('downstream.smr.url')` is straightforward but touches deployment env-mapping; recorded as a small follow-up.

- `smr-proxy.controller.ts:113`, `health.controller.ts:28-55` — bypasses `ConfigModule` typed config. Hard to spot if env name changes.

### E-6 — `apiKey` shoved onto `request['apiKey']` without `Request` typing

> 📝 **DEFERRED — see TASK-307 README §10**: a `RequestWithAuth` interface narrowing `request.apiKey` / `request.user` / `request.tenantId` would prevent typo-rendered authentication bypasses. Tracked as a small follow-up.

- `unified-auth.guard.ts:145` — `request['apiKey'] = apiKeyEntity;`. Internal controllers (`stt-internal.controller.ts:24`) cast `request['apiKey']` blindly. A small `RequestWithAuth` interface would prevent typo-rendered authentication bypasses.

### E-7 — `MetricsInterceptor` uses raw `request.url` (high cardinality)

> 📝 **DEFERRED — see TASK-307 README §10**: `MetricsInterceptor` still falls back to raw `request.url` when `request.route?.path` is unset (early lifecycle / 404 path). The `ExceptionInterceptor` correctly uses `route.path` (see its unit test "uses request.route.path when available so cardinality stays bounded"); aligning the metrics interceptor — or omitting the metric when only the raw URL is available — is a small follow-up.

- `metrics.interceptor.ts:25` — `request.route?.path || request.url`. When `route.path` is unset (early lifecycle), the raw URL with path params bloats Prometheus cardinality and includes tenant data when ids carry meaning.

### E-8 — `@ApiBearerAuth()` declared but Swagger never documents the API-key scheme

> 📝 **DEFERRED — see TASK-307 README §10**: documentation-layer fix — `DocumentBuilder` in `main.ts:206` needs `.addApiKey({ type: 'apiKey', in: 'header', name: 'X-API-Key' }, 'api-key')`. `SttInternalController` already declares `@ApiSecurity('api-key')` but the scheme is undefined in Swagger config. Recorded as a follow-up.

- `main.ts:205` — only `addBearerAuth()`. Add `addApiKey({ type: 'apiKey', in: 'header', name: 'X-API-Key' })` and use `@ApiSecurity('api-key')` consistently. `SttInternalController` does set `@ApiSecurity('api-key')` but the scheme is undefined in Swagger config.

### E-9 — `User.tenantId` is still populated from a single-tenant view

> 📝 **DEFERRED — see TASK-307 README §10**: TASK-282's mirror-admin model puts the source of truth on `UserRoleAssignment`, but `User.tenantId` remains as a legacy default that several services still read. Migrating every read to `UserRoleAssignmentService` is a medium-scope refactor; tracked as a follow-up.

- See `auth.controller.ts:488` and `userController.fetchByTenant`. Multi-tenant users (TASK-282 mirror-admin model) have role assignments via `UserRoleAssignment`, so `User.tenantId` is at best a default. Treat it as legacy and stop relying on it in tenant scoping.

### E-10 — `request.requestId = request?.body?.requestId ?? uuidv7()` blindly trusts client body

> 📝 **DEFERRED — see TASK-307 README §10**: `context.interceptor.ts:47` should source the correlation id from the `X-Request-Id` header (server-trusted) and never from the body. A small but contract-touching change tracked as a follow-up.

- `context.interceptor.ts:47`. A malicious client can inject a colliding requestId across tenants to confuse audit correlation. Use the header `X-Request-Id` only, never the body.

### E-11 — Bulk delete iterates without txn or partial-failure semantics

> 📝 **DEFERRED — see TASK-307 README §10**: `user.controller.ts:bulkDelete` still iterates over ids in a plain `for...of`. Wrapping the loop in `Prisma.$transaction` or returning per-id status is recorded as a small follow-up.

- `user.controller.ts:143-150` — partial failure leaves users half-deleted. Wrap in a single transaction or return per-id status.

---

## F. Anti-patterns observed

| # | Pattern | Locations | TASK-307 disposition |
|---|---|---|---|
| 1 | Controller calls PrismaClient directly | `auth.controller.ts`, `policies.controller.ts`, `roles.controller.ts` | ✅ W6 `77068325` — RBAC controllers delegate to `@arcaai/applications` services; ESLint rule bans direct `@arcaai/database` / `CoreDatabaseService` imports from `apps/api/src/modules/**` |
| 2 | Tenant id sourced from path param `:tenantId` without comparison to JWT tenant | `user.controller.ts:fetchByTenant`, `tenant-bucket.controller.ts:provisionSystemBuckets`, `pipeline assignTenant` | ✅ W3 `d969b25c` + W5 `677f17d9` — `@TenantOwnedResource` decorator + inline `:id === cls.tenantId` guards on tenant-admin routes |
| 3 | Path/resource id taken from `:id` and forwarded to service without ownership check | Storage, Voice-Profile, Tenant-Bucket, Audit-Log, Transcription-Job, Consultation-Job | ✅ W3 `d969b25c` (storage/voice-profile/tenant-bucket/transcription-job/consultation-job) + ✅ W5 `677f17d9` (audit-log fetchByUser tenant-scoped) |
| 4 | Hard-coded JWT/secret fallback (`'default-...-change-in-production'`) | `auth.controller.ts:147,404,479`, `jwt.strategy.ts:22` | ✅ W2 `38013f4e` — fail-closed on placeholder / undefined |
| 5 | Refresh token / opaque token not persisted server-side | `auth.controller.ts:608` | ✅ W1 `4c85d9f6` — opaque tokens persisted (SHA-256 hash) in Redis, single-use rotation, family-revoke |
| 6 | Auth opt-in (no global `APP_GUARD` for auth) | `app.module.ts:78-83` | ✅ W4b `c9c42e19` — `UnifiedAuthGuard` registered as `APP_GUARD`; auth runs by default |
| 7 | `@Public()` GET that takes JWT in query string | `pstudio.controller.ts:21-39` | ✅ W5 `677f17d9` — `PrismaStudioController` GET is now `@Authorize(['manage','all'])`; no query-string JWT path |
| 8 | Error / status enumeration via differentiated close codes | `stt-ws.gateway.ts` | ✅ W5 `677f17d9` — collapsed to a single close code + opaque reason |
| 9 | Default-open feature flags on PHI sharing | `consultation.controller.ts:isSharingEnabled` | ✅ W5 `677f17d9` — default-closed (`setting?.value === 'true'`) |
| 10 | Prisma errors surfaced verbatim to clients | `exception.interceptor.ts`, `prisma.filter.ts` | ✅ W5 `677f17d9` — error sanitization in interceptor; W7.A.14 documents the `PrismaClientExceptionFilter` shadow + §10 deferral |
| 11 | Per-IP throttling (no per-tenant / per-user bucket) | `throttle.module.ts` | 📝 DEFERRED — same as D-9; needs Redis-backed `ThrottlerStorage` |
| 12 | Direct `process.env.*` reads bypassing typed config | `smr-proxy.controller.ts:113`, `health.controller.ts:28-55` | 📝 DEFERRED — same as E-5; ConfigService migration tracked as a small follow-up |

---

## G. Bare-minimum quick wins (do these first)

1. **Refresh-token: persist + rotate.** Store SHA-256(opaque token) in Redis with `{userId, tenantId, jti, family}`, single-use, rotate on each `/auth/refresh`. (`auth.controller.ts:451-499`)
2. **Register `UnifiedAuthGuard` as `APP_GUARD`** in `app.module.ts:78-83`; widen `auditAdminRoutePermissions` from `/admin/*` to all routes.
3. **Hard-fail bootstrap when JWT secret is the placeholder.** Add an assertion in `JwtStrategy` constructor and in `main.ts` after `secretsService.boot(...)`.
4. **Add `assertTenantOwnership` on `bucketName` / `bucketId` / `voiceProfileId` / `jobId` / `consultationJobId`.** Six controllers, ~30 lines total, immediate BLOCKER closure.
5. **Logout = revoke jti.** One-line change in `auth.controller.ts:logout`.
6. **Gate `/health/services{/:key}` behind `@Authorize()`** (or platform-admin), strip `version` / `checks` from the response.
7. **Disable Prisma Studio in non-local-dev** (currently enabled when `NODE_ENV !== 'production'`). Require both `NODE_ENV=development` AND an explicit `ENABLE_PRISMA_STUDIO=true` env flag.
8. **Default-close `enable-consultation-sharing`** in `consultation.controller.ts:isSharingEnabled` — `return setting?.value === 'true'`.
9. **Strip `err.meta` from client error responses** in `ExceptionInterceptor` and `PrismaClientExceptionFilter`.
10. **Replace direct Prisma access in `AuthController.getUserRoles` / `tenantRoleAssignment` lookups** with `UserRoleAssignmentRepository` / `UserRoleAssignmentService` calls.

---

## H. Strategic improvements

1. **Defense-in-depth tenant scoping** via Prisma `$use` middleware that reads `cls.get('tenantId')` and injects `tenantId` filter onto every `findMany/findFirst/update/delete` on tenant-scoped models. Today the only enforcement is hand-written repository code. (Better still: PostgreSQL Row-Level Security with `SET LOCAL app.current_tenant = '<id>'` on each Prisma connection acquisition. The infra already supports PgBouncer per recent TASK-302 work.)
2. **Asymmetric JWTs (RS256 / EdDSA)** so the gateway only carries the public key, and a separate signer service (or Vault Transit) holds the private key. Eliminates the hard-coded fallback risk entirely.
3. **`@TenantOwnedResource(model, paramName)` decorator + interceptor** that resolves the entity, checks `entity.tenantId === cls.tenantId`, and 404s on mismatch — applied broadly to all `:id` routes.
4. **A `TenantContextGuard`** that runs after `UnifiedAuthGuard` and asserts the CLS `tenantId` is non-empty (with a single allowlisted set of "platform-level" routes marked via `@PlatformLevel()`).
5. **Per-tenant rate limiting** by extending `ThrottlerGuard.getTracker()` to include `cls.get('tenantId')` and switching `ThrottlerModule` to a Redis-backed storage (project already uses Redis).
6. **Replace `User.tenantId` reads with `UserRoleAssignment` lookups everywhere** — completes the multi-tenant user story. The legacy column is a foot-gun for `/auth/refresh` and any service that reads it.
7. **CORS allowlist sourced from `tenant.allowedOrigins`** instead of an env flag — already collected per-tenant during tenant onboarding.
8. **OpenTelemetry tenant baggage** — propagate `tenantId` as a baggage key so downstream Python services and SQL traces are tenant-tagged.
9. **Migrate `RolesController` and `PoliciesController` to repositories + services** with `BaseService.broadcastSysEvent` and CASL-aware authorization; the current direct-Prisma pattern dramatically increases the chance of cross-tenant policy leak.
10. **Per-controller tenant-scoping contract tests** — Playwright or supertest tests that, for every `/admin/*` and PHI-bearing route, prove a tenant-B token returns 404/403 when probing tenant-A resources. The test suite currently has very little of this (TASK-298 spot-checks pipelines only).

---

## I. Positive observations

1. **`JwtStrategy.validate`** correctly sets both `user` and `tenantId` in CLS and is the single source of truth — the intent is clean even if downstream enforcement is uneven.
2. **`ContextInterceptor`** explicitly refuses to let the `x-tenant-id` header override the JWT — good defense.
3. **Stream tickets** are properly opaque (256-bit random), single-use, 30-second TTL, scope-bound. The `JwtAuthGuard.handleTicketAuth` validates scope strictly. This pattern correctly avoids putting JWTs into URL query strings for SSE/WS.
4. **`auditAdminRoutePermissions`** boot-time gate is a great defense for admin routes — should be widened to all routes.
5. **`ETagInterceptor` + `RequiresIfMatchGuard` + `OptimisticConcurrencyException → 412`** is a clean, well-tested optimistic-concurrency design.
6. **`@CanRead`, `@CanManage`, etc.** decorator family makes intent obvious; the API surface is consistent across most controllers.
7. **Pipeline ownership** is enforced via `assertPipelineOwnership` before any cross-service dispatch (`transcription-job.controller.ts:97-102`). Other "ownership" helpers should follow this pattern.
8. **Stream-ticket `impersonatedBy` carry-forward** ensures impersonation audit doesn't get lost across SSE/WS boundaries — thoughtful design.
9. **`UserRolesController`** has a clean self-only 403 with an explicit comment about the mirror-admin pattern — exactly the right shape.
10. **DNA-style cross-doctor ownership check** in `smr-proxy.controller.ts:597-620` is a model example of how every resource-id-bearing controller should validate ownership.

---

## Verdict

Tenant resolution today is **NOT defense-in-depth**. It depends on:

1. A single JWT claim, validated by a single `JwtStrategy`.
2. Per-controller hand-rolled ownership checks, which are present in ~half the controllers and absent (or partial) in the other half.
3. CASL `PolicyEngine` conditions that the audit could not verify exhaustively in this scope.

There is **no Prisma-layer enforcement**, **no global auth guard**, **no tenant-context guard**, **no per-resource decorator/interceptor**, and **no row-level security**. A single missing decorator or a single forgotten `where: { tenantId }` clause silently breaks isolation. The refresh-token forgery (C-1) is independently catastrophic.

Recommended priority: fix the 5 BLOCKERs (C-1 through C-5) and the 7 HIGHs (C-6 through C-12) this sprint; commit to strategic items H-1, H-2, H-4 over the next quarter.
