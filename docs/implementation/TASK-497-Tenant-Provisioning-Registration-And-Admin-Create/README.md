# TASK-497 — Tenant Auto-Provisioning on Registration + Global-Admin Create-Tenant with Initial Admin


|                        |                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**             | `Review` — all 6 phases (P0-P5) implemented and green, including P4/P5 UI built WITHOUT Figma approval per explicit user directive (design-gate deviation, recorded below). Outstanding: Playwright e2e passes (need live infra, not run this session) and the post-hoc Figma drift-control pass once frames exist.          |
| **Type**               | `feature` — full-stack (DB → domain → application → API gateway → admin-console BFF/UI)                                                                                                                                                                                                                                                                                                  |
| **Created**            | 2026-07-12                                                                                                                                                                                                                                                                                                                                                                               |
| **Parent / Related**   | [TASK-392 Plan-Entitlements](../../archive/TASK-392-Plan-Entitlements/README.md) · [TASK-426 Tenant-Bucket Default Buckets](../TASK-426-Tenant-Bucket-NoSuchBucket-And-Default-Buckets/README.md) · [TASK-258 Tenant-Config-Provisioning](../../archive/TASK-258-Tenant-Config-Provisioning/README.md) · [TASK-415 Admin-Console](../TASK-415-Hope-Admin-Console/capabilities-matrix.md) |
| **Branch (suggested)** | `feature/497-tenant-provisioning`                                                                                                                                                                                                                                                                                                                                                        |
| **Reported**           | 2026-07-12 by the user                                                                                                                                                                                                                                                                                                                                                                   |


---



## 1. Requirement Analysis

Two provisioning entry points must reliably stand up a **fully-usable tenant** in one atomic operation. Both share the same "spin-up" contract; they differ only in who the admin is and how the request is authenticated.

### 1a. Self-service registration → auto-create a default tenant

When a user registers, the system creates their default tenant. Mandatory inputs:

- **Tenant name** — supplied by the user. **Tenant key is generated automatically** (slug + collision suffix — no manual key today).
- **Tenant admin** — MUST be the registering user (the account being created in this same request).
- **Plan** — a new tenant **always starts on** `STARTER` (not `TRIAL`, which is today's service default).



### 1b. Global-admin → create a new tenant

A `GLOBAL_ADMIN` creates a tenant. Mandatory inputs:

- **Tenant name** — supplied. **Tenant key generated automatically.**
- **Tenant admin** — **either** an existing user **or** a newly-created local account (email + password).
- **Plan** — selected from the plan list; **defaults to** `STARTER`.



### 1c. Spin-up contract (BOTH flows MUST do this, atomically)

1. **Create default buckets with default capacity following the tenant's plan** — buckets exist today, but per-bucket `quotaBytes` is NOT wired to the plan's `storageQuotaBytes`. This ticket closes that gap.
2. **Clone settings from the** `__GLOBAL__` **reference tenant** and use those as the default settings baseline — already implemented in `provisionTenantConfigs`; this ticket keeps it and adds the plan-driven entitlement snapshot.
3. **Assign the chosen user** `TENANT_ADMIN` in the new tenant and attach them to the auto-provisioned default department — NOT done today by any create path.



### Decisions (owner: product owner, confirmed 2026-07-12)

- **D1 — Registration model: Verified self-signup.** Public `POST /auth/register`, gated behind a **feature flag** (`REGISTRATION_SELF_SIGNUP_ENABLED`, default OFF) **and email verification**. The tenant + admin are provisioned only after the email is verified (or provisioned `SUSPENDED`/pending until verified — see D6). Rationale: healthcare/PHI platform; fully-open signup is unacceptable abuse/PHI risk.
- **D2 — Default plan is** `STARTER` **for both flows.** Change `TenantService.create` to default omitted plan to `STARTER` (currently `TRIAL`, `tenant.service.ts:105`). `TRIAL` remains a selectable plan for global admins and keeps its 7-day `trialEndsAt` clock in the factory.
- **D3 — Tenant key auto-generated.** `key = slugify(name)` (lowercase, `a-z0-9-`, trimmed, ≤ 40 chars), with a numeric collision suffix (`-2`, `-3`, …) on unique-constraint clash; reserved keys (`__SYSTEM__`, `__GLOBAL__`) and empty slugs get a `t-<short-uuid>` fallback. `key` becomes **optional** in the create DTO (auto-generated when absent; still accepted + validated when a global admin supplies one explicitly).
- **D4 — Plan → bucket capacity wiring.** At provision time, write the plan's `PlanEntitlement.storageQuotaBytes` onto the tenant's primary system bucket(s) as `TenantBucket.quotaBytes`. When `storageQuotaBytes` is `null` (unlimited, e.g. PRO/ENTERPRISE tiers may be) leave `quotaBytes` null. Snapshot value comes from the resolver (`PlanEntitlement` row → fallback `PLAN_ENTITLEMENT_DEFAULTS`).
- **D5 — Initial-admin seeding is part of tenant creation.** A new orchestration composes `Tenant` creation + `User` (existing or new) + `TENANT_ADMIN` assignment + default-department membership in ONE transaction, so a tenant is never created "adminless".
- **D6 — Bootstrap principal for registration.** Registration runs with **no authenticated CLS user/tenant**, but `UserService.create` throws without a CLS tenant (`user.service.ts:149`) and role assignment/tenant create rely on `this.requestUser`/CLS. Introduce a dedicated `TenantOnboardingService` that runs under a **SYSTEM bootstrap context** (SYSTEM tenant/system-user principal via CLS `runWith`) so the whole spin-up executes without a pre-existing tenant.

**Guardrail principle:** a tenant is provisioned **all-or-nothing**. If any mandatory step (tenant row, admin user, role assignment, default department) fails, the whole registration/creation rolls back. Best-effort catalog/bucket cloning (already tolerant in `TenantService.create`) stays best-effort but is logged.

---



## 2. Current State Evaluation

**What already exists and is reused (do NOT rebuild):**

- `TenantService.create` — `packages/applications/src/services/tenant/tenant.service.ts:98`. Persists the tenant then runs five best-effort provisioning steps:
  - `tenantBucketService.provisionSystemBuckets(tenant.id)` (L122) → `TenantBucketFactory.CreateDefaultSystemBuckets` + `blobStorage.createBucket` + MinIO/S3 tenant-isolation policy (`tenant-bucket.service.ts:224`).
  - `provisionTenantConfigs(tenant.id)` (L132 / impl L385) — **clones every** `GlobalSetting` **from the** `__GLOBAL__` **tenant** (`GLOBAL_TENANT_KEY` in `tenant/constants.ts:16`), seeding `value = defaultValue ?? value`, preserving `locked`.
  - `provisionDefaultDepartment(tenant.id)` (L142 / impl L344) — creates the default **GEN** department so the login membership invariant can be satisfied.
  - `provisionTenantModelCatalog` (L153) + `provisionTenantPipelineCatalog` (L163) — clone AiModel rows (plan-tier filtered) + default ASR pipeline from the SYSTEM tenant.
- **Plan/entitlement system** — `packages/database/src/prisma/db_main/entitlement.prisma`: `PlanEntitlement` (per-plan matrix incl. `storageQuotaBytes`), `TenantEntitlement` (per-tenant override), `TenantUsageMeter`. STARTER defaults: 5 users / 2 depts / **5 GiB** / base model tier / strict rate-limit (seed `15-entitlements.ts:91`; mirror `entitlements.constants.ts` `PLAN_ENTITLEMENT_DEFAULTS`). Enforcement is behind the `entitlements.enabled` kill-switch (seeded OFF).
- **User creation w/ atomic membership** — `UserService.create` (`user.service.ts:102`): bcrypt hash (L106); when `roleId`+`departmentId` given, creates `User` + `UserRoleAssignment` + `UserDepartment` in one `$transaction` (L166-195), pinned to CLS `tenantId`. `createExternalUser` (L234) exists for federated users.
- **Role assignment** — `UserRoleAssignmentService.create` (`userRoleAssignment.service.ts:155`): tenant from CLS; cross-tenant assignment requires GLOBAL_ADMIN; seat-quota precheck (L195-201). `TENANT_ADMIN` role seeded id `00000000-0000-0000-0000-000000000002` (`03-role.ts:36`).
- **Global-admin create-tenant API + UI** — `POST /admin/tenants` (`tenant.controller.ts:103`, `@CanManage('Tenant')`); admin-console `CreateTenantDialog` (`apps/admin-console/src/features/tenants/components/create-tenant-dialog.tsx`) collects name/key/description/plan.
- **Login membership invariant** — `auth.controller.ts:211-229`: a non-elevated user needs BOTH an ENABLED role AND an ENABLED department in the tenant to log in. GEN department covers the department half automatically.
- **Reserved tenants** — SYSTEM `00000000-…` key `__SYSTEM__` (catalog owner); default/global `50000000-…` key `__GLOBAL__` (settings template). Constants in `seed/00-constants.ts`.

**Gaps this ticket fills:**


| Gap                                                                 | Where                                                   | Fix (phase) |
| ------------------------------------------------------------------- | ------------------------------------------------------- | ----------- |
| No self-service registration endpoint / DTO                         | `apps/api/src/modules/auth`, admin-console `api/auth/*` | P3          |
| No email-verification flow for signup                               | —                                                       | P3          |
| No tenant-`key` auto-generation (key is required + caller-supplied) | `createTenant.request.ts`, service                      | P1          |
| Default plan is `TRIAL`, not `STARTER`                              | `tenant.service.ts:105`                                 | P1          |
| Create paths never seed a `TENANT_ADMIN` user / membership          | all create paths                                        | P2          |
| Plan `storageQuotaBytes` not written to bucket `quotaBytes`         | `tenant-bucket.service.ts` provisioning                 | P1          |
| Global-admin "create new local user as admin" option absent         | create-tenant API + dialog                              | P2, P5      |
| No bootstrap (no-CLS-tenant) context for onboarding                 | new `TenantOnboardingService`                           | P2          |


**Precedent to mirror:** TASK-496 (per-tenant TTS config) for the DB-row + SYSTEM/GLOBAL default + resolver + clamp pattern; TASK-426 for default-bucket provisioning; TASK-392 for entitlement resolution.

---



## 3. Design



### 3.1 Tenant key generator (P1)

New pure util `packages/applications/src/services/tenant/tenantKey.ts`:

```ts
// slugify → validate → ensure-unique against TenantRepository
export function slugifyTenantName(name: string): string; // lower, [a-z0-9-], collapse -, ≤40, trim -
export async function generateUniqueTenantKey(
  name: string,
  exists: (key: string) => Promise<boolean>,   // repo.findFirst({ key }) != null
): Promise<string>;                              // base, base-2, base-3, … ; reserved/empty → t-<8hex>
```

- `createTenant.request.ts`: `key` becomes `@IsOptional()`. When present it is validated (regex, not reserved, ≤40) and used as-is (global-admin override); when absent it is generated from `name` inside `TenantService.create`.
- Reserved-key guard rejects `__SYSTEM__` / `__GLOBAL__` and anything matching `__*__`.



### 3.2 Plan default + entitlement/capacity snapshot (P1)

- `TenantService.create`: default omitted `plan` to `TenantPlan.STARTER` (D2).
- After buckets are provisioned, resolve the plan's `storageQuotaBytes` (via `IEntitlementsService` resolver → `PlanEntitlement` row, fallback `PLAN_ENTITLEMENT_DEFAULTS[plan]`) and set it on the primary system bucket(s) (D4). Implemented as a new best-effort step `applyPlanStorageQuota(tenant.id, plan)` on `TenantBucketService` (or `TenantService`), so existing tenants are unaffected and re-runs are idempotent (only writes when `quotaBytes` is currently null).
- **No** `TenantEntitlement` override row is written (new tenants inherit `PlanEntitlement` defaults — matches TASK-392). A tenant-specific override is only created when an admin later customizes limits.



### 3.3 `TenantOnboardingService` — the shared spin-up orchestration (P2)

New service `packages/applications/src/services/tenant/onboarding/tenantOnboarding.service.ts` (+ `ITenantOnboardingService` token, module, DTO mapper, `__tests__`). Single method used by BOTH flows:

```ts
provisionTenantWithAdmin(input: {
  tenantName: string;
  tenantKey?: string;                 // optional → auto-generated (§3.1)
  plan?: TenantPlan;                  // default STARTER (§3.2)
  admin:
    | { kind: 'existing'; userId: string }
    | { kind: 'new-local'; email: string; username?: string; password: string };
  actor: { userId: string; tenantId: string }; // SYSTEM bootstrap for registration; caller for admin-create
}): Promise<TenantProvisionResult>
```

Flow (single `runInTransaction` where the DB steps are concurrency-safe; catalog/bucket cloning stays outside the tx as today):

1. Resolve/validate the admin user: existing → assert active + (for admin-create) allowed; new-local → `UserService.create` under the **new tenant's context** with a bcrypt password.
2. `TenantService.create({ name, key?, plan })` → tenant + buckets + cloned `__GLOBAL__` settings + GEN dept + catalogs.
3. Assign `TENANT_ADMIN` to the admin user for the new tenant (`UserRoleAssignmentService.create` with explicit `tenantId`).
4. Attach the admin to the GEN department (`UserDepartment`) so the login invariant holds.
5. `broadcastSysEvent(SysEventType.ResourceCreated, …)` for tenant + assignment.
6. Return `{ tenant, adminUserId, tenantKey }`.

The **bootstrap context** for registration is provided by wrapping the call in `ClsService.runWith({ user: SYSTEM_USER, tenantId: SYSTEM_TENANT_ID })` inside the registration controller/service, so `UserService.create` / role assignment see a valid principal even though no user is logged in.

### 3.4 Self-service registration (P3) — verified self-signup (D1)

**Gateway** (`apps/api/src/modules/auth`):

- `POST /auth/register` (`@Public`, throttled) — body `RegisterRequest { email, password, tenantName, displayName? }`. Steps: validate password policy + email uniqueness; create the user `SUSPENDED`/unverified (no tenant yet) **or** stage the registration; mint an email-verification token (reuse the password-reset-token pattern from TASK-400) and enqueue the verification email. Returns 202 (no tokens minted yet).
- `POST /auth/register/verify` (`@Public`) — body `{ token }`. On valid token: run `TenantOnboardingService.provisionTenantWithAdmin({ tenantName, admin:{kind:'existing', userId}, plan: STARTER, actor: SYSTEM })`, activate the user, then either auto-login (mint JWT + refresh) or return "verified, please log in".
- Feature-flag gate: both routes 404/403 when `REGISTRATION_SELF_SIGNUP_ENABLED` is false (checked via `IConfigService`).

**admin-console BFF** (`apps/admin-console/src/app/api/auth/register/route.ts` + `.../register/verify/route.ts`): thin proxies that forward to the gateway and, on auto-login, seal the returned session cookie via `setSession` (reuse `server/session.ts`). New `/register` + `/verify-email` screens gated by the same flag surfaced through `NEXT_PUBLIC_`* (non-secret flag only).

### 3.5 Global-admin create-tenant with initial admin (P5)

- Extend `POST /admin/tenants` (or add `POST /admin/tenants/provision`) to accept an `admin` block: `{ mode: 'existing', userId }` | `{ mode: 'new-local', email, password, username? }`. Routes through `TenantOnboardingService.provisionTenantWithAdmin` with `actor = caller` (GLOBAL_ADMIN, real CLS). Backward-compat: `admin` optional; when omitted, behaves like today (tenant-only) but SHOULD warn (adminless tenant).
- `CreateTenantDialog`: key field becomes optional/auto-preview (show generated slug, editable); plan defaults to STARTER; add a step "Tenant admin" with a toggle **existing user (search) / new local user (email + password)**. Password entry is a create-only field (never displayed back). Follows §9 form + §5 feedback rules of `11-ux-ui-principles`.



### 3.6 Data model

No new tables required. Field/DTO changes only:

- `createTenant.request.ts`: `key` → optional; add optional `admin` block (P5).
- Reuse `TenantBucket.quotaBytes` (already exists, `tenant-bucket.prisma:31`) for capacity (D4).
- Email-verification token: reuse/extend the existing password-reset-token table (TASK-400) with a `purpose` discriminator, OR add a small `RegistrationToken` model if the reset table is not reusable — decided in P3 after reading TASK-400's schema.

---



## 4. Implementation Plan (phased, TDD)

Layer order per `01-development-workflow`. Each phase: RED test first → GREEN → refactor; `*Verify:*` line names the gate.

**P0 — Guards & flags foundation.** Add `REGISTRATION_SELF_SIGNUP_ENABLED` to `turbo.json#globalEnv`, `.env.dev`, `.env.example`; add config accessor. Seed no new plan data (STARTER already seeded).
*Verify:* `pnpm --filter @arcaai/applications build`; config read test.

**P1 — Key generator + STARTER default + plan→capacity.**

1. `tenantKey.ts` unit tests (slugify edge cases, collision suffix, reserved/empty fallback) → impl.
2. `createTenant.request.ts` key optional; `TenantService.create` generates key when absent, defaults plan STARTER — tests assert generated key uniqueness + STARTER default.
3. `applyPlanStorageQuota` writes `PlanEntitlement.storageQuotaBytes` to primary bucket(s), idempotent, null-safe — tests with STARTER (5 GiB) and an unlimited tier.

*Verify:* `pnpm --filter @arcaai/applications test` (tenant + tenant-bucket suites) green.

**P2 —** `TenantOnboardingService`**.** TDD the orchestration: existing-admin path, new-local-admin path, rollback on failure, `TENANT_ADMIN` assignment + GEN-department membership, sys-events. Mock repos + `UserService` + `UserRoleAssignmentService` + `ClsService`. Register token + module + barrels; wire into `CommonServiceModule`/tenant module.
*Verify:* `pnpm --filter @arcaai/applications test`; assert factory usage + `broadcastSysEvent` + rollback.

**P3 — Registration endpoints + email verification.** `RegisterRequest`/verify DTOs; `POST /auth/register` + `/auth/register/verify` in `apps/api`; verification-token issue/consume (reuse TASK-400 pattern); feature-flag gate; SYSTEM bootstrap context wrap. Unit tests (controller/guard, mocked services) + cross-tenant safety (registrant lands only in their own new tenant).
*Verify:* `pnpm test:unit`; then `pnpm test:api:up` + `pnpm test:e2e` for the register→verify→login happy path.

**P4 — admin-console BFF + register UI.** `/api/auth/register` + `/verify-email` route handlers; `/register` + `/verify-email` screens (Skeleton loading, Field forms, toasts). Flag-gated. Vitest colocated tests; axe scan 0 violations; both themes.
*Verify:* `pnpm --filter @arcaai/admin-console build lint test`; `next-dev-loop` runtime pass of the register flow.

**P5 — Global-admin create-tenant-with-admin.** Extend `POST /admin/tenants` (+ e2e cross-tenant coverage), `CreateTenantDialog` admin step + auto-key preview + STARTER default.
*Verify:* `pnpm test:unit` + `pnpm test:e2e` (`admin/tenants` create); `pnpm --filter @arcaai/admin-console build lint test`; dialog runtime pass.

**Global verification:** `pnpm lint` clean (treat `packages/`* only-warn as errors); affected package builds; `pnpm test:unit` + relevant `pnpm test:e2e`; register + admin-create flows exercised end-to-end in a running app; both themes + axe for new screens.

---

## 5. Implementation Summary

### P0 — Guards & flags foundation (Complete)

- `REGISTRATION_SELF_SIGNUP_ENABLED` added to `IAppConfig` (`packages/domains/src/interfaces/IAppConfig.ts`), wired in `ConfigService.loadBaseConfig()` (`packages/applications/src/services/baseServices/_meta/config/config.service.ts`), and declared in `turbo.json#globalEnv`, `.env.dev`, `.env.example`. Default OFF (D1).
- Compile-time `IAppConfig` sample literals in `packages/domains/src/interfaces/__tests__/IAppConfig.test.ts` updated (mechanical — new required field).
- Tests: `config.service.test.ts` — 2 new RED→GREEN cases (default false, boolean parse).

### P1 — Key generator + STARTER default + plan→capacity (Complete)

- `packages/applications/src/services/tenant/tenantKey.ts` — `slugifyTenantName` + `generateUniqueTenantKey` (base/base-2/base-3 collision suffix; empty or `__*__`-shaped name → `t-<8hex>` fallback). Exports `isReservedTenantKeyShape` for reuse.
- `packages/applications/src/services/tenant/validators/not-reserved-tenant-key.validator.ts` — `NotReservedTenantKeyConstraint` (class-validator), rejects an explicit `key` shaped like a reserved platform key.
- `createTenant.request.ts`: `key` is now `@IsOptional()` (was required) + `@MaxLength(40)` + `@Validate(NotReservedTenantKeyConstraint)`.
- `TenantService.create` (`tenant.service.ts`): generates a key via `generateUniqueTenantKey` when `request.key` is omitted (existence probe: `tenantKeyExists`, using `tenantRepository.findFirst`); defaults `plan` to `STARTER` (was `TRIAL` — D2). `TRIAL` remains selectable and keeps its factory trial-clock.
- `TenantBucketService.applyPlanStorageQuota(tenantId, plan)` (+ `ITenantBucketService` abstract method): writes `PLAN_ENTITLEMENT_DEFAULTS[plan].storageQuotaBytes` onto the tenant's primary (`AUDIO`-purpose) system bucket's `quotaBytes`, idempotent (no-op if already set), null-safe (`null` plan or unlimited-tier `null` storageQuotaBytes → no write). Wired into `TenantService.create` as a new best-effort step after `provisionSystemBuckets`.
- Tests (all TDD RED→GREEN, no existing test regressed): `tenantKey.test.ts` (11), `not-reserved-tenant-key.validator.test.ts` (7), `createTenant.request.test.ts` (4, DTO-level via `class-validator`), `tenant.service.test.ts` (+6 new/updated cases, 111 total), `tenant-bucket.service.test.ts` (+5 new cases, 53 total).

**Evidence:**
```
pnpm --filter @arcaai/applications build   → clean
pnpm --filter @arcaai/domains build        → clean
pnpm build:api                             → 8/8 tasks successful (confirms ITenantBucketService's
                                              new abstract method has no other unimplemented consumers)
pnpm --filter @arcaai/applications test    → 282 files, 6041 passed | 4 skipped, 0 failed
```

Design deviation from §3.2 draft: `applyPlanStorageQuota` reads `PLAN_ENTITLEMENT_DEFAULTS` directly rather than going through `IEntitlementsService.resolveForTenant` — at tenant-creation time no `TenantEntitlement` override can exist yet, so the seeded per-plan default IS the resolved value; avoids a new cross-module DI edge (`tenant-bucket` → `entitlements`) for a value the resolver would compute identically here.

### P2 — `TenantOnboardingService` (Complete)

New module `packages/applications/src/services/tenant/onboarding/`:
- `ITenantOnboardingService.ts` (token + `provisionTenantWithAdmin` contract), `tenantOnboarding.service.ts`, `tenantOnboarding.service.module.ts`, `tenantOnboarding.dto.mapper.ts`, `dto/` (`ProvisionTenantWithAdminInput` incl. `TenantAdminSpec` union + `OnboardingActor`, `TenantProvisionResponse`).
- Flow: (existing-admin only) validate the admin is `ENABLED` *before* creating anything → `clsService.run()` wraps the whole call → `ITenantService.create({name, key?, plan})` (already provisions buckets/settings/GEN dept/catalogs, P1's key-gen + STARTER default apply) → switch CLS to the new tenant → look up the GEN department (`DepartmentRepository.findByCode`, mandatory — throws if missing, unlike `TenantService`'s own best-effort clone steps) → `existing` admin: `IUserRoleAssignmentService.create` (TENANT_ADMIN) + a direct `UserDepartmentRepository.create` (with its own `ResourceCreated` broadcast, since bypassing `UserService`); `new-local` admin: a single `IUserService.create({..., roleId, departmentId, isPrimaryDepartment: true})` call, which already does role+department atomically.
- **Guardrail (never adminless)**: `TenantService.create` isn't itself transactional (independent best-effort provisioning steps, pre-existing design). Rather than thread a `tx` through every collaborator's public interface, admin-provisioning failures trigger a **compensating soft-delete** of the just-created tenant (`ITenantService.deleteById`) before re-throwing the original error — a deliberate deviation from the draft's "single `runInTransaction`" (documented in `tenantOnboarding.service.ts`'s class doc comment).
- **CLS bootstrap (D6)**: the synthetic session (`buildOnboardingSession`) carries the `GLOBAL_ADMIN` role — not the roleless/permissionless `createWorkerSession` convention used by background workers — because `UserRoleAssignmentService`'s AC-02 cross-tenant guard otherwise rejects re-assigning an EXISTING admin who already holds a role in another tenant (exactly the global-admin "pick an existing user" case). Justified because this orchestration is only reachable from already-authorized callers (SYSTEM bootstrap for registration; `@CanManage('Tenant')`-gated admin-create).
- Tests (TDD RED→GREEN, all passed on first GREEN attempt): `tenantOnboarding.service.test.ts` — 10 cases covering both admin-kind paths, the fail-fast existing-admin validation, both rollback triggers (role-assignment failure, missing GEN department), rollback-of-rollback-failure non-swallowing, and plan/key pass-through.

**Evidence:**
```
pnpm --filter @arcaai/applications build   → clean
pnpm --filter @arcaai/applications lint    → 0 errors (pre-existing prettier-only warnings elsewhere; new files clean after eslint --fix)
pnpm --filter @arcaai/applications test    → 283 files, 6051 passed | 4 skipped, 0 failed
```

### P3 — Registration endpoints + email verification (Complete)

**Design gap discovered mid-implementation** (not anticipated by §3.4/§3.6 draft): `POST /auth/register/verify`'s body is `{ token }` only, but `TenantOnboardingService.provisionTenantWithAdmin` needs `tenantName` at verify time. Resolved by wiring the **already-existing but unwired** `PasswordResetToken.metaData` JSONB column through the entity/factory (no migration): `PasswordResetTokenEntity` gained a `metaData` getter/setter (`packages/domains/src/entities/generated/core/PasswordResetTokenEntity.ts`) and `PasswordResetTokenFactory` an optional `metaData` prop — `IBaseEntity.metaData` was declared but never implemented on `BaseEntity` itself (a pre-existing gap affecting every entity, flagged but explicitly left out of scope; fixed narrowly, only on this one entity). `register()` stashes `{ pendingTenantName }` there; `verify()` reads it back.

- `packages/applications/src/services/auth/registration/`: `IRegistrationService`, `registration.service.ts`, `registration.service.module.ts`, `dto/` (`RegisterRequest`, `RegisterVerifyRequest`, `RegisterVerifyResponse`).
- `RegistrationService.register`: anti-enumeration (silent no-op if the username/email already has an account, mirroring TASK-400's forgot-password contract) → `IUserService.create` with `resourceStatus: SUSPENDED` (username defaults to the lowercased email) → mints a `PasswordResetToken` with `purpose: 'email_verification'`, 24h TTL, `metaData: { pendingTenantName }` → best-effort email via the **reused** `IPasswordResetMailer.sendResetLink` (same TASK-400 mailer interface/provider-selection factory — a second implementation/abstraction wasn't worth it for one more email type).
- `RegistrationService.verify`: validates the token (hash lookup, `purpose` + `isActive()`, generic error on any failure mode — no state leak) → **activates the user BEFORE provisioning** (`TenantOnboardingService`'s existing-admin path requires an already-`ENABLED` admin) → `provisionTenantWithAdmin({ tenantName, admin: {kind:'existing', userId}, actor: SYSTEM })` → marks the token used.
- `apps/api/src/modules/auth/register.controller.ts`: `POST /auth/register` (202, generic body, throttled 5/min) + `POST /auth/register/verify` (throttled 10/min), both `@Public()` and gated by an inline `REGISTRATION_SELF_SIGNUP_ENABLED` check (`IConfigService`, 404 when OFF) — mirrors `ConsultationController.isSharingEnabled`'s inline-check shape (no dedicated guard exists for a boolean `IConfigService` flag; this is its first consumer). Wired into `auth.module.ts`.
- **Scope reduction from the draft**: `verify()` returns `{ userId, tenantId, tenantKey }`, not an auto-login JWT pair — the draft explicitly offered "auto-login... **or** return verified/please-log-in" as an either/or; the simpler branch was taken to avoid pulling JWT/refresh-token/cookie minting (the full `AuthController.login` machinery) into this already-large ticket. Auto-login is a clean follow-up if wanted.
- Tests (TDD RED→GREEN throughout): `PasswordResetTokenFactory.test.ts` (+2 metaData cases), `registration.service.test.ts` (9 cases: create+token+mail, anti-enumeration no-op, mailer-failure tolerance, no-mailer tolerance, activate-before-provision ordering, happy path, 3 rejection modes), `register.controller.test.ts` (4 cases: flag-off 404 ×2, flag-on delegates ×2).

**Evidence:**
```
pnpm --filter @arcaai/domains build        → clean
pnpm --filter @arcaai/applications build   → clean
pnpm build:api                             → 8/8 tasks successful
pnpm --filter @arcaai/applications test    → 287 files, 6100 passed | 4 skipped, 0 failed
pnpm test:unit (whole monorepo)            → 891/894 files, 15970 passed | 4 skipped | 9 todo,
                                              5 failed — all 5 in apps/api/src/__tests__/
                                              env-port-standardization.test.ts, confirmed
                                              pre-existing (git diff shows this file untouched)
                                              and unrelated (an old port-standardization ticket's
                                              stale assertion about IAppConfig, not TASK-497)
```

**Not done in this pass (follow-up)**: the `apps/api/tests/e2e/task-497-registration.spec.ts` Playwright happy-path (register → outbox-token → verify) — the doc's own P3 verify line calls for it, but it needs live Postgres + the dev-outbox mailer running (`pnpm test:api:up` + `pnpm test:e2e`), which wasn't run in this pass given the ticket's overall scope. The unit-level coverage above exercises the same logic with mocks.

### P5 — Global-admin create-tenant-with-admin, backend half (Complete)

New dedicated route rather than extending the existing one: `POST /admin/tenants/provision` (`apps/api/src/modules/tenant/tenant-provision.controller.ts`, new `TenantProvisionController`), leaving `POST /admin/tenants` (`TenantController.create`, tenant-only) completely untouched — zero risk to its existing callers/tests, and it sidesteps the draft's "admin optional + warn" ambiguity by giving the admin-console two clear, purpose-built endpoints instead of one endpoint with conditional behavior.

- `ProvisionTenantRequest` DTO (`packages/applications/src/services/tenant/onboarding/dto/provisionTenant.request.ts`): `tenantName`, optional `tenantKey` (same reserved-key + length validation as P1's `CreateTenantRequest`) + `plan`, required nested `admin` block (`ProvisionTenantAdminBlock`: `mode: 'existing'|'new-local'` + conditionally-required fields via `@ValidateIf`).
- `TenantProvisionController.provision`: `@CanManage('Tenant')` (same GLOBAL_ADMIN-only posture as `create`), maps the HTTP `admin` block to `TenantAdminSpec`, calls `ITenantOnboardingService.provisionTenantWithAdmin` with `actor = { userId: caller.id, tenantId: caller.tenantId ?? '' }` (the REAL authenticated caller — not a SYSTEM bootstrap, per D6), maps the result via `TenantOnboardingDtoMapper`.
- Tests (TDD, RED→GREEN): `provisionTenant.request.test.ts` (6 DTO-validation cases), `tenant-provision.controller.test.ts` (4 cases: mode mapping ×2, key/plan pass-through, response mapping).

**Evidence:**
```
pnpm --filter @arcaai/applications test (tenant + auth/registration suites) → 14 files, 200 passed
apps/api: pnpm vitest run src/modules/tenant/ src/modules/auth/            → 18 files, 264 passed
```
**Caveat**: a full `pnpm --filter @arcaai/applications build` / `pnpm build:api` could not be run clean at the end of this session — a **concurrent, unrelated, uncommitted change already in this shared working tree** (`packages/applications/src/services/rbac/role/{IRoleService,role.service}.ts`, mid-edit for a different ticket, `clone` declared on the interface but not yet implemented) currently fails `tsc`. Confirmed via `npx tsc --noEmit` that this is the ONLY error in the whole package and it is not in any file this ticket touched; every TASK-497 file was also verified individually error-free. Re-run `pnpm --filter @arcaai/applications build` once that other work lands/completes.

### P4 + P5 (UI) — design-gate DEVIATION (explicit user decision, 2026-07-13) — Complete

`12-design-workflow.md` §2 gate 2 is a hard gate: no screen implementation before its Figma frames exist and are product-owner-approved. This ticket had no Figma frame inventory for `/register` / `/verify-email` (P4) or the `CreateTenantDialog` admin-step extension (P5's UI half). The user explicitly directed proceeding without waiting for Figma approval. Every OTHER standard stayed in force (not gated behind Figma specifically): `@arcaai/ui` primitives only, plain `Dialog` for CREATE (per `11-ux-ui-principles.md`, `DetailDrawer` is reserved for record detail/edit), `Skeleton` loading states, both themes verified, BFF auth (no tokens in the browser). **Follow-up**: once frames exist, run the drift-control checkpoints (§2 "Drift control") against what was actually shipped here.

**P4 — `/register` + `/verify-email`** (mirrors the existing `(auth)/login` precedent — tier-less, outside the `(console)` session gate):
- `apps/admin-console/src/proxy.ts`: `PUBLIC_PATHS` gains `/register`, `/verify-email`, `/api/auth/register`, `/api/auth/register/verify` (the gateway's own `REGISTRATION_SELF_SIGNUP_ENABLED` 404 is the real gate — this allowlist entry doesn't widen access).
- `apps/admin-console/src/app/api/auth/register/route.ts` + `.../register/verify/route.ts`: pure passthrough BFF routes (same `gatewayUrl`/`gatewayErrorMessage`/`clientUserAgentHeader` helpers as `login/route.ts`) — no session cookie is sealed by either (register creates an unverified account; verify's response carries no tokens, D1's "auto-login" branch was not taken, see P3).
- `RegisterForm` (`features/auth/components/register-form.tsx`) + `/register` page + `loading.tsx`: anti-enumeration carried through to the UI — ANY non-404 outcome (success, 500, network failure) renders the identical "check your email" confirmation; a 404 (flag off) is the one distinct, non-PII state shown.
- `VerifyEmailScreen` (`features/auth/components/verify-email-screen.tsx`) + `/verify-email` page + `loading.tsx`: reads `?token=`, auto-submits on mount (`useRef` guard against double-submit / React 19 effect double-invoke), shows verifying/success (with a "Sign in" link)/error/missing-token states.
- Deliberately not built: a `NEXT_PUBLIC_*` client-side flag check (doc's own wording). The gateway's 404 is already the authoritative, security-relevant gate; a client flag would only save rendering a form that then fails — cosmetic, not correctness — so it was skipped as a documented scope reduction (same category as P3's auto-login deferral).

**P5 UI — `CreateTenantDialog`** now a mandatory 3-step wizard (was 2): details (name; **key is now optional** with a live client-side preview — cosmetic only, `TenantOnboardingService`/`generateUniqueTenantKey` remains the authoritative generator) → plan (**defaults to STARTER**, was blank) → tenant admin (**mandatory** toggle: existing user by id / new local user by email+password) → submits via the new `useProvisionTenant()` hook to `POST /admin/tenants/provision`, replacing the old adminless `useCreateTenant()` call in this dialog specifically (`useCreateTenant`/`POST /admin/tenants` itself is untouched and still used elsewhere per P5-backend's design). `features/tenants/api/{types,client,hooks}.ts` gained `ProvisionTenantAdmin`/`ProvisionTenantRequest`/`TenantProvisionResult`, `provisionTenant()`, `useProvisionTenant()`.

**Tests (TDD RED→GREEN throughout):** `proxy.test.ts` (6), `api/auth/register/__tests__/route.test.ts` (4), `.../register/verify/__tests__/route.test.ts` (3), `register-form.test.tsx` (5), `verify-email-screen.test.tsx` (4), `tenants-hooks.test.tsx` (+1 `useProvisionTenant` case), `create-tenant-dialog.test.tsx` (7, new dedicated file — no prior dialog test existed), `tenants-list-screen.test.tsx` (its pre-existing end-to-end wizard test updated for the new 3-step flow + new endpoint, not left broken).

**Evidence:**
```
pnpm --filter @arcaai/admin-console test    → 121 files, 903 passed, 0 failed
pnpm --filter @arcaai/admin-console lint    → clean (0 warnings, --max-warnings 0)
pnpm --filter @arcaai/admin-console build   → next build succeeded; route table confirms
                                               ○ /register (static), ƒ /verify-email (dynamic,
                                               reads searchParams), both new BFF routes present
```
**Runtime-verified in a running `next dev` (Browser pane, both themes checked against `/login`'s existing baseline):** `/register` renders and submits — with no gateway running, the BFF route's fetch fails and the client correctly falls back to the SAME generic "check your email" confirmation (anti-enumeration verified live, not just in tests); `/verify-email` (no token) shows the missing-token state; `/verify-email?token=...` auto-submits on mount and shows a clean "verification failed" (server unreachable) state. Zero console errors in either flow.

### Outstanding (follow-ups, not done this session)

- `apps/api/tests/e2e/task-497-registration.spec.ts` — register → dev-outbox token → verify → provisioned-tenant Playwright happy path (needs `pnpm test:api:up` + live Postgres).
- `apps/api/tests/e2e/task-497-admin-provision.spec.ts` (or similar) — `POST /admin/tenants/provision` cross-tenant e2e coverage, mirroring the `task-307-*-cross-tenant.spec.ts` pattern per `05-nestjs-api.md`.
- Post-hoc Figma drift-control pass once frames exist for the batch (P4/P5-UI were built ahead of design per the explicit deviation above).
- Auto-login after verify (JWT + refresh mint) — deliberately deferred; see P3 summary.
- A `next-dev-loop` pass against the `CreateTenantDialog` 3-step flow live in the browser (requires an authenticated GLOBAL_ADMIN session + running gateway; covered thoroughly by the 16 automated tests instead this session).

---

