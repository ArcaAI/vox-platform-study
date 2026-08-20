# TASK-766 — Day-1 Seed Completeness: ArcaAI Tenant, Admins, Service Accounts

| | | | |
|---|---|---|---|
| **Status** | Review | **Owner** | Platform / Data |
| **Date** | 2026-08-19 | **Type** | feature (day-1 readiness) |
| **Continues** | **TASK-763** (day-1 seed data — read its §5 owner decisions first; they are not re-litigated here) |
| **Related** | **TASK-762** (machine identity) · **TASK-757** (admin plane JWT-only) · **TASK-758** (business-plane auth) · **TASK-767** (`@RequiredSvcScopes` on STT + summarization — CONCURRENT) · `.claude/rules/02-database-prisma.md` §Seeds · `.claude/rules/00-project-context.md` §Configuration Principles |

> **Concurrency note.** TASK-765 and TASK-767 own `apps/api/src/**`; nothing there was
> edited. `packages/applications/src/**` was likewise read-only. This ticket's entire
> write set is `packages/database/src/prisma/db_main/seed/**` plus this document.

---

## 1. Requirement Analysis

Owner's words (2026-08-18):

> *"make sure we have seed data to create service account for ArcaAI tenant"* ·
> *"we have seed data for: arcaai tenant admin with all rights in the arcaai tenant, service
> accounts, and other things!"* · all seed data must be reasonable and useful for a **day-1
> deployment in any environment**.

Restated as testable criteria:

| # | Criterion |
|---|---|
| R1 | On a fresh deploy **in any environment** (including `RUN_SEED="safe"`), the ArcaAI tenant has an administrator who can administer it end to end. |
| R2 | That administrator holds **every tenant-scoped ability the API declares**, and **none** of the platform-plane ones. "All rights" must be a measured fact, not a claim. |
| R3 | The ArcaAI tenant has a seeded **ServiceAccount** with a justified scope set. |
| R4 | **No recoverable secret reaches a production seed path** (TASK-762 DoD), and the day-1 bootstrap problem is solved honestly rather than by omission. |
| R5 | Seeds stay idempotent, FK-ordered, `XX-name.ts`-phased, and carry no environment-specific endpoint. |
| R6 | The TASK-763 mintability sweep still reports zero contradictions. |

Classification: **feature**. TASK-763 closed the *platform* bootstrap; this closes the *tenant*
bootstrap and adds the machine identity TASK-763 §OD-2 deliberately left out.

---

## 2. Current State Evaluation

### 2.1 A `safe` deploy produces a fully configured tenant that nobody can administer (R1)

TASK-763 added `92-bootstrap-admin.ts`, so a `RUN_SEED="safe"` deployment can now mint its first
SUPER_ADMIN from two environment variables. It did **not** give any TENANT its administrator.

The only tenant-admin accounts in the chain are in `91-user.ts` — `tenant_admin` (Global) and
`arcaai_admin` (ArcaAI, `91-user.ts:489`) — and `91-user` is on
`SEED_PHASES_EXCLUDED_FROM_SAFE` because those are demo accounts (`*@example.com`) sharing one
documented password. So on a fresh non-development deploy the ArcaAI tenant came up with
everything **except** a way to run it:

| Seeded for ArcaAI in `safe` | Phase |
|---|---|
| 11 clinical departments + agent bindings | `04-department.ts` (76 ArcaAI references) |
| 23 approved clinical prompt templates + versions | `07b-arcaai-clinical-templates.ts` |
| Consultation context schema + loop defaults | `07e-consultation-loop-defaults.ts` |
| `attachments` / `recordings` buckets (physical + row) | `05a` / `05b` (iterate `ALL_TENANTS`) |
| Frontend pipeline config (BACKEND, locked, dual-capture) | `05-tenant.ts` |
| Pipeline policy cascade | `14-pipeline-policy.ts` |
| Trusted browser origins | `11b-tenant-allowed-origins.ts` |
| **An administrator** | **— nothing** |

The only remedy was for the platform super admin to create the account by hand, in the console,
before the tenant could be used at all.

### 2.2 What the ArcaAI tenant admin actually resolves to today (R2)

Rather than assume, the role was resolved the whole way down: `arcaai_admin` → `TENANT_ADMIN`
(`91-user.ts:493`) → 6 policies (`03-role.ts:38`) → CASL rules (`01-policy.ts`), following
`parentRoleId`. That yields **72 `action:subject` pairs**.

Against it, every `@Authorize` / `@Can*` decorator in `apps/api/src/modules/**` was extracted —
**87 distinct declared pairs**. Applying CASL semantics (`manage` ⊇ every action, `all` ⊇ every
subject), TENANT_ADMIN satisfies **77 of 87**. The ten it does not are, without exception,
platform-plane:

| Missing | Verdict |
|---|---|
| `manage:all` | The SUPER_ADMIN wildcard. Correct. |
| `manage:Tenant` | Platform tenant CRUD/provisioning. Correct — and note the tenant-scoped surfaces sitting under `@CanManage('Tenant')` class gates (`tenant-bucket`, `storage-access-key`, `admin-transcription-job`) all carry **handler-level** overrides (`@CanRead('Storage')`, `@CanRead('AsrPipeline')`, …) that `getAllAndOverride` honours, so a tenant admin reaches them anyway. Verified per method. |
| `manage:Role`, `manage:Policy` | **Correct, and load-bearing.** `Role` and `Policy` have **no `tenantId` column at all** (`rbac.prisma`) — they are global tables. The seeded `rbac-tenant-manage` policy writes `{ isSystemRole: false }` conditions, but CASL `conditions` are in **shadow mode** (`policy.engine.ts` — the guard performs a type-only check and merely *reports* what conditions would have decided). A tenant admin granted `manage:Role` could therefore edit or delete the SYSTEM roles every other tenant depends on. See §5 OD-1. |
| `manage:ServiceAccount` | Issuance is SUPER_ADMIN-only, enforced imperatively in `ServiceAccountService.assertMayIssue`. Correct. |
| `manage:UsageAnalytics`, `manage:PlatformMetrics` | Cross-tenant platform telemetry. Correct. |
| `manage:PrismaStudio` | Direct database access. Correct. |
| `manage:AiPriceBook` | The platform rate card. Correct. |
| `manage:ChangelogEntry` | Platform-wide release notes (the role holds `read` via TASK-763's `user-profile-own` grant). Correct. |

**Conclusion: the ability set was already right.** What was missing was (a) an account to carry it
in a `safe` deploy, and (b) anything that would *keep* it right — the three grants already patched
into `tenant-full-access` for `BillingInvoice`, `KnowledgeDocument` and `WorkflowTestFixture` are
each a past instance of "a tenant surface shipped that no policy could reach". That is now a
failing test rather than a bug report (§4.2).

### 2.3 No machine identity exists for any tenant (R3/R4)

TASK-763 §OD-2 decided not to seed a service account, because TASK-762's DoD forbids a recoverable
secret in a seed. The consequence it recorded — *"a fresh deploy has no machine path to
administration at all"* — is what the owner is now asking to close.

Two further facts shaped the answer:

1. **`SERVICE_ACCOUNT_SCOPE_REGISTRY` is DERIVED, not authored.** It renamespaces the 56 concrete
   `admin:*` strings to `svc:admin:*` at module load, plus two wildcards. There is no
   `svc:stt:*` or `svc:summarization:*` today.
2. **No route in `apps/api` declares `@RequiredSvcScopes` yet** (verified by grep). The guard is
   deny-by-default, so until TASK-767 lands, a service-account token reaches nothing. The seeded
   account's scopes are therefore provisioned *ahead of* the surfaces that will read them.

### 2.4 The ArcaAI tenant described itself as a test fixture

`05-tenant.ts:34` read *"retained as the secondary tenant backing cross-tenant isolation E2E
tests"* — describing the row by the test that reads it rather than by what it is, in the
`description` field a tenant admin sees in the console. It is the day-1 customer tenant; backing
the e2e suite is a consequence of being a real second tenant, not its purpose.

---

## 3. Implementation Plan

Executed in this order; verification for each is in §6.

1. **Reserve a service-account id block** in `00-constants.ts` (`E0000000-…`), separate from the
   `60000000-…` API-key block → the two credential classes do not share a numbering scheme.
2. **Add `93-bootstrap-tenant-admin.ts`** — env-driven, CREATE-ONLY first TENANT_ADMIN, runs in
   every seeding mode → new rule tests fail before, pass after.
3. **Add `94-service-account.ts`** — the ArcaAI machine identity, scope set DERIVED from the
   tenant admin's authority, secret gated by environment → derivation test.
4. **Wire both into `index.ts`** → `seed-pipeline-completeness.test.ts` passes.
5. **Pin the tenant-admin authority sweep** as `tenant-admin-authority.test.ts`.
6. **Correct the ArcaAI tenant description** in `05-tenant.ts`.
7. Re-run the TASK-763 mintability sweep; `build` + `typecheck` + `test`; run the seed twice
   against the test database.

---

## 4. Implementation Summary

### 4.1 Files changed

| File | Change |
|---|---|
| `.../seed/00-constants.ts` | New `E0000000-…` id block; `SEED_SERVICE_ACCOUNT_IDS`, `SEED_SERVICE_ACCOUNT_CLIENT_IDS`, `SEED_SERVICE_ACCOUNT_DEV_SECRETS` (dev/test only) |
| `.../seed/05-tenant.ts` | ArcaAI description rewritten to say what the tenant IS |
| `.../seed/93-bootstrap-tenant-admin.ts` | **New phase.** Env-driven, CREATE-ONLY first TENANT_ADMIN |
| `.../seed/94-service-account.ts` | **New phase.** The ArcaAI machine identity |
| `.../seed/index.ts` | Imports + invokes both, after `seedBootstrapAdmin` and before the API-key phase |

### 4.2 Tests added (183 cases across 3 new files)

| File | Cases | Locks |
|---|---|---|
| `__tests__/tenant-admin-authority.test.ts` | 93 | Every one of the 87 route-declared `action:subject` pairs is either held by TENANT_ADMIN or on the ten-item platform-only list — asserted as an **exact set in both directions**, so an eleventh gap (a tenant surface nobody can reach) and a disappearance (a tenant role acquiring platform authority) both fail |
| `__tests__/service-account-seed.test.ts` | 72 | The scope derivation, in both directions: each of the 37 seeded scopes implies only abilities TENANT_ADMIN holds, each of the 18 excluded ones provably exceeds it, and the seeded set equals the eligible set · `svc:` namespace, no wildcard, no `admin:*` · tenant binding is never SYSTEM or `50000000-…` · HMAC-always verifier (never the API-key plain-SHA fallback) · CREATE-ONLY · Vault-path `credentialsRef` · the inert branch generates the VERIFIER, not a secret |
| `__tests__/bootstrap-tenant-admin.test.ts` | 18 | No-op when unset (incl. when only the optional vars are set) · half-configured throws · well-known passwords refused **before** the length rule · reserved tenant keys refused · defaults to `ARCAAI` · reserved id collides with no `SEED_USER_IDS` entry and differs from TASK-763's · phase enabled in `safe` and `all`, not `none` |

### 4.3 The bootstrap tenant admin

Four variables, **seed-time only**, read once by `packages/database` and never at runtime:

```
BOOTSTRAP_TENANT_ADMIN_EMAIL       # required to provision
BOOTSTRAP_TENANT_ADMIN_PASSWORD    # required to provision; >= 12 chars
BOOTSTRAP_TENANT_ADMIN_USERNAME    # optional, defaults to `tenant-admin`
BOOTSTRAP_TENANT_ADMIN_TENANT_KEY  # optional, defaults to `ARCAAI`
```

The posture is TASK-763's, deliberately unchanged — one bootstrap contract, not two dialects:
absent = no-op; half-set = hard error; well-known passwords refused *before* the length rule (so
the message names the real problem instead of inviting a padded `password1234`); CREATE-ONLY by
reserved id `70000000-…00fe` **and** by username, so a rotation survives and a rename skips
cleanly; `passwordChangedAt` stamped so the credential ages; the password never logged.

Three things are specific to this phase:

| Property | Why |
|---|---|
| **A SEPARATE phase from `92`, not a parameter of it** | The two credentials must be independently grantable. Folding them together would make "provision the tenant admin" imply "mint a second `manage:all` account" — the exact privilege coupling the TENANT_ADMIN role exists to avoid. |
| **Targets a tenant by `Tenant.key`, not by id** | An operator reads the key off the console, and it survives a re-provisioned database where a uuid would not. |
| **`__SYSTEM__` and `__GLOBAL__` are refused as targets** | SYSTEM is a config TIER; "Global" is a platform-admin playground. Neither is a customer whose data a tenant-scoped administrator owns. |

The tenant scoping is one field: `UserRoleAssignment.tenantId`. Every rule in `tenant-full-access`
is written `{ tenantId: '${context.tenantId}' }`, and that assignment is what they resolve against
— it is the whole difference between a tenant administrator and a platform one.

### 4.4 The ArcaAI service account

**The credential problem, and how it is split.** A `ServiceAccount` row is two separable things:
an AUTHORITY declaration (client id, display name, scopes, tenant binding, TTL) and a CREDENTIAL
(the secret behind `secretVerifier`). Only the second is a secret. So the seed writes the first
everywhere and the second nowhere it must not:

| Environment | What is seeded | How the operator gets a working secret |
|---|---|---|
| **development / test** | Row **+** a deterministic fixture secret from `00-constants`, double-gated exactly like the demo API keys (`shouldSeedServiceAccountSecrets` → `NODE_ENV` development\|test) | It is `SEED_SERVICE_ACCOUNT_DEV_SECRETS.ARCAAI_ADMIN` |
| **everything else** (incl. `RUN_SEED="safe"`) | Row only. `secretVerifier` is 32 bytes of CSPRNG output **for which no preimage was ever generated** | `POST /api/v1/admin/service-accounts/:id/rotate` — returns a fresh secret exactly once |

The production row is **inert, not weak**: there is no secret to leak because none was ever
computed — the inert branch generates the *verifier* directly rather than generating a secret and
hashing it, so no plaintext credential exists in process memory or in any log line someone adds
later. What the operator is spared is the part that actually needs judgement (the scope set and
the tenant binding); rotation is a single call that asks no questions.

The alternative — a dev/test-only deterministic secret and *no row at all* in production — was
rejected because it leaves the production gap exactly where TASK-763 §OD-2 found it, which is what
this ticket was asked to close.

Two implementation details that are easy to get wrong and are pinned by tests:

- **The verifier is HMAC-ALWAYS.** `hashApiKey` in `02-apikey.ts` falls back to plain SHA-256 with
  no pepper because `ApiKeyService.hashKey` does. `ServiceAccountService.computeSecretVerifier`
  never does — it HMACs with the literal `'hope-service-account'` when `API_KEY_PEPPER` is absent.
  Copying the API-key shape would have seeded a verifier the gateway can never reproduce.
- **The pepper is resolved only on the usable-secret path.** `resolveApiKeyPepper()` *throws* when
  `SECRETS_PROVIDER=vault` and Vault is unreachable; on the inert path the pepper is irrelevant, so
  calling it would add a brand-new way for a production `safe` seed to fail on something it does
  not need.

**The scope set is DERIVED, and that is the point.** A service account's authority IS its scope
set — `serviceAccountPolicyRules` builds its CASL ability from the scopes alone, with no user, no
role and no database read behind it. A hand-picked list would be a privilege decision with nothing
checking it. The rule applied instead:

> include `svc:admin:<area>` **iff** every ability it implies is one the seeded `TENANT_ADMIN`
> role already holds.

That yields **37 scopes** and excludes **18**, and it makes the machine identity exactly as
powerful as the human tenant administrator it automates — no more. `svc:admin:*` and `svc:*` are
both unused: either would hand a tenant-bound credential the platform plane by wildcard expansion
(`hasServiceAccountScope` matches `svc:*` against *any* `svc:` requirement). The excluded set
includes `tenant:write`, `role:write`, `rbac-policy:write`, `entitlement`, `ai-model`,
`ai-service`, `ai-runtime-profile`, `rate-limit`, `queue`, `scheduler`, `usage`,
`platform-metrics`, `pstudio`, `billing`, `changelog`, `storage-key`, `tenant-storage` and
`department-agent` (the last of which implies `manage:Tenant` — `agent-promotion:manage` supplies
`manage:DepartmentAgent` without it).

`allowedIps` is deliberately left NULL: a seed cannot know the addresses a deployment will call
from, an empty list would read as "no restriction", and a guessed one would lock the account out.
`allowedTenantIds` is left NULL because it is a PLATFORM-account concept the entity rejects on a
tenant-bound row.

### 4.5 Coordination with TASK-767 (STT + summarization) — read this before assuming a gap

TASK-767 is adding `@RequiredSvcScopes` to the standalone speech-to-text and summarization
surfaces. Its ticket README does not exist yet (checked), and **no route in `apps/api` declares
`@RequiredSvcScopes` today**, so there was nothing to conform to. What this seed could and could
not do about that:

- The four scopes annotated `[TASK-767]` in `94-service-account.ts` are the **admin-plane STT and
  summarization areas that exist today** — `svc:admin:audio-pipeline:manage`,
  `svc:admin:transcription-job:read`, `svc:admin:consultation-admin:manage`,
  `svc:admin:harness:manage` (plus `svc:admin:tenant-stt-config:manage`,
  `svc:admin:agentic:manage`, `svc:admin:agent-trajectory:read`). The account holds all of them,
  so if TASK-767 gates those surfaces on the existing `svc:admin:*` vocabulary, this account is
  already provisioned.
- **A `svc:` string that is not in the registry was NOT seeded**, and that is a deliberate refusal
  rather than an omission. `hasServiceAccountScope` is pure string matching, so an unknown scope
  *would* satisfy the guard — while `serviceAccountPolicyRules` silently **skips** it, so the
  request would then be refused by CASL. A credential that passes the scope gate and fails the
  ability gate is the worst possible thing to debug.

**Action for TASK-767:** if it declares new business-plane `svc:` scopes (e.g. `svc:stt:*`,
`svc:summarization:*`), add them to `ARCAAI_TENANT_ADMIN_SVC_SCOPES` in `94-service-account.ts` and
to `SVC_SCOPE_IMPLICATIONS` in `service-account-seed.test.ts`. That is a two-line change and the
test fails until both sides agree.

---

## 5. Owner Decisions Required

TASK-763 §5 recorded eight (OD-1 … OD-8); all remain open and are **not** repeated here. These are
new, ordered by day-1 impact.

### OD-1 — A tenant admin cannot mutate its own tenant's custom roles — **RESOLVED (owner ruling, 2026-08-20)**

`RolesController` was class-gated `@CanManage('Role')`. A tenant admin holds `read`/`list:Role`
(so `GET /admin/rbac/roles` works), `create:Role` (so `POST :id/clone` works — the handler-level
override exists precisely for this) and `manage:RolePolicy` (so policy attach/detach works). It
did **not** hold `manage:Role`, so `PUT`/`PATCH`/`DELETE :id` were refused — including on a custom
role it created a moment earlier by cloning.

This could not be fixed from the seed: `Role` was a GLOBAL table with no `tenantId`, and CASL
`conditions` are in shadow mode, so `{ isSystemRole: false }` would not have constrained the grant
at request time — a tenant admin holding `manage:Role` could have deleted the SYSTEM roles every
other tenant depends on.

**Owner decision (2026-08-20): option (c) — give `Role` a `tenantId` column.** The two cheaper
options were REJECTED: a handler guard has to be re-remembered by every future route, and CASL
conditions are shadow-mode (they report, they do not enforce). A real column puts the boundary in
the tenant-scope Prisma extension, where it holds for every current and future call site.

#### What shipped

| Layer | Change |
|---|---|
| Schema | `Role.tenantId String` — NOT NULL, no default, no FK, `@@index([tenantId], name: "Role_tenantId_idx")` (`rbac.prisma`) |
| Migration | `20260820045008_task_766_add_role_tenant_id` — add NULLABLE, backfill to SYSTEM, `SET NOT NULL`, index. Authored against a throwaway shadow DB; `prisma migrate diff` then printed `-- This is an empty migration.` |
| Allow-lists | `Role` in **both** `TENANT_SCOPED_MODELS` and `SYSTEM_SHARED_READ_MODELS` (already committed with this ticket's tenant-scope tests) |
| Domain | `RoleEntity` now extends `BaseTenantEntity` (was `Omit<IBaseEntity,'tenantId'>`) and chains `super.validate()`; `RoleFactory.CreateRole` takes a REQUIRED `tenantId`; `RoleModel` regenerated onto `BaseTenantDataModel`; `RbacRoleFactory` / `RbacRoleRepository` / `RbacRoleEntityMapper` carry `tenantId` |
| Service | `RbacRoleService.assertMutable` (own tenant allowed, SYSTEM 403, foreign already 404), `resolveOwningTenantId`, and a `crossTenantLane` so a super admin with a working tenant can still edit a SYSTEM role |
| API | `PUT`/`PATCH` accept `update` OR `manage` on `Role`; `DELETE` accepts `delete` OR `manage`; `RoleResponse` exposes `tenantId`; the CASL subject resolver now returns a real `tenantId` and is pinned with `{ subject: 'Role' }` |
| Seeds | Every built-in role is stamped `SYSTEM_TENANT_ID`; the by-name lookups in `03-role.ts`, `92-bootstrap-admin.ts` and `93-bootstrap-tenant-admin.ts` pin the tenant |

#### Three questions this raised, and how they were answered

**Does `Policy` need the same? No.** A tenant admin never AUTHORS a policy — it attaches and
detaches platform-authored ones, which `manage:RolePolicy` already permits. Giving `Policy` a
tenant would mean a per-tenant CASL rule-authoring plane nobody asked for (a tenant writing its own
`rules` JSON is the most privilege-sensitive write in the schema) and would break the by-NAME
global lookups the platform depends on — `seed/03-role.ts`'s `policyMap`, and
`PROTECTED_SYSTEM_POLICY_NAMES` / `Policy.isProtected`, the anti-lockout guard that keeps super
admins in. `RolePolicy` stays global for the same reason. Both are pinned OUT of
`TENANT_SCOPED_MODELS` by `extensions/__tests__/tenant-scope.test.ts`.

**`SYSTEM_SHARED_READ_MODELS`: `Role` is IN it, and stays in.** Becoming tenant-scoped without it
would have been a catastrophe, not a tightening — every tenant would instantly stop seeing
`TENANT_ADMIN`, `DOCTOR`, `NURSE`, so the role list would empty, `:id/clone` would 404 on every
built-in, and member counts would break. Membership means READS widen to `tenantId IN [caller,
SYSTEM]` — never another customer — while WRITES stay pinned to the exact caller tenant. That
asymmetry is what makes the whole design work: a tenant SEES the built-ins and its own roles, and
can WRITE only its own.

**Should custom roles be cloned into a new tenant at provisioning? No — nothing is cloned.** In
this codebase the two mechanisms are mutually exclusive by design: a model is either cloned at
tenant creation (`AiModel`, `AsrPipeline`, the `DepartmentAgent` golden library — all deliberately
NOT SYSTEM-shared, precisely so a tenant does not see the SYSTEM originals in its own lists) or it
is SYSTEM-shared and resolved directly. `Role` is the second kind. Cloning would also freeze a
per-tenant snapshot of every built-in, so a policy change to `DOCTOR` would need a fan-out
migration across every tenant, and `SUPER_ADMIN` is cross-tenant by nature and cannot be
per-tenant at all. There is additionally nothing custom to clone: all seven seeded roles are
platform roles. `DEPARTMENT_HEAD` and `SENIOR_NURSE` carry `isSystemRole: false`, but they are
platform-provided TEMPLATES a tenant clones ON DEMAND via `:id/clone` — not tenant-owned rows.
No provisioning code was added.

#### Follow-up this deliberately did NOT do

`@@unique([name])` is still GLOBAL rather than the `[tenantId, name]` composite the standard field
template would suggest. Role names are globally unique TODAY, so keeping the constraint preserves
the status quo instead of shipping a second semantic change alongside the tenancy one, and it stops
a tenant's custom role from shadowing a built-in name that other code keys off by name (the
bootstrap seeds, and `UserRoleAssignmentService.assertAssignableRoleTier`'s `SUPER_ADMIN` check).

**The cost is real: one tenant taking the name `REVIEWER` refuses it to every other tenant** — a
cross-tenant name-squatting refusal, and a weak existence oracle. Relaxing it to
`@@unique([tenantId, name], map: "Role_tenantId_name_unique")` is the fix, and it needs a
service-layer guard that refuses a tenant-created name colliding with a SYSTEM role name. Left for
a follow-up ticket rather than smuggled in here.

### OD-2 — Every seeded tenant has `plan = NULL`, so all of them resolve "ungated-legacy" — **RESOLVED (owner ruling, 2026-08-20)**

`Tenant.plan` is nullable and no seed sets it — including for ArcaAI. `resolveEntitlements`
returns `UNGATED_ENTITLEMENTS` for a null plan: **unlimited quotas, every feature on except
`platformDefaultCredential`, which is deliberately `false`**.

Practically this is benign on day 1 (nothing is quota-blocked, and the SYSTEM-tenant *self-hosted*
provider rows are exempt from the credential gate — `isCloudByoProvider` scopes it to cloud BYO —
so local LM Studio / Ollama / vLLM summarization resolves normally). But it means a fresh ArcaAI
tenant is **commercially unmodelled**, and any *cloud* provider without a tenant-owned key returns
403 with "ask your account owner to enable the platform-default entitlement".

**Owner decision (2026-08-20): assign the ArcaAI tenant `ENTERPRISE`. Every other seeded tenant
keeps `plan = NULL`.** Implemented in `05-tenant.ts` — the ArcaAI `CUSTOMER_TENANTS` row now
carries `plan: TenantPlan.ENTERPRISE`; SYSTEM and Global are untouched (still resolve
ungated-legacy, which is correct for a config tier and a platform-admin playground respectively).
Verified both halves of the claim, not just the seed literal:

- **The seed**: `tenant-plan-seed.test.ts` (new, `packages/database`) asserts ArcaAI's row is
  `plan: 'ENTERPRISE'` and that SYSTEM/Global carry no `plan` field at all.
- **The resolution path actually resolves it**: `entitlements.service.test.ts` (new case,
  `packages/applications`) proves `EntitlementsService.resolveForTenant` given `plan: 'ENTERPRISE'`
  (the value the seed now assigns) returns `gated: true` with the real ENTERPRISE structural caps
  (`maxUsers: 100`, `maxDepartments: 40`, `maxApiKeys: 50`) — not `UNGATED_ENTITLEMENTS`. Together
  these close the gap this OD named: ArcaAI is no longer commercially unmodelled, and the fix is
  proven at both the data layer and the resolution layer, not asserted from the seed literal alone.

### OD-3 — The bootstrap credentials are still undocumented in any tracked file — **RESOLVED (owner ruling, 2026-08-20)**

TASK-763 §4.2 recorded documenting `BOOTSTRAP_SUPER_ADMIN_*` in `.env.dev`. That file is
gitignored and untracked, and the variables are not present in it now, so the documentation did
not survive. The same applies to the four `BOOTSTRAP_TENANT_ADMIN_*` variables added here.

Both sets are deliberately **not** in `turbo.json#globalEnv` and carry no `SettingDescriptor`
(registering one makes a key governed *and writable*, and a bootstrap password must never become
addressable through the settings plane) — the precedent is `RUN_SEED` itself.

**Owner decision (2026-08-20): document the variables in a tracked operator runbook — never their
values.** [`docs/operations/day-one-deployment.md`](../../operations/day-one-deployment.md) §2 is
that runbook: which variables must be set (`BOOTSTRAP_SUPER_ADMIN_*`, `BOOTSTRAP_TENANT_ADMIN_*`,
and `BOOTSTRAP_SERVICE_ACCOUNT_SECRET` for the ArcaAI machine identity), where they are set (host
env on the seed job only, never a tracked file), the first-login flow end to end, and what happens
if each is left absent (silent no-op — the deployment simply has no matching credential until a
human re-runs the seed with them set). This page is now the single tracked place that names them;
the ticket READMEs continue to record *why* they exist, not the operational how-to.

### OD-4 — `svc:admin:ai-provider:manage` and `svc:admin:settings:manage` both imply `manage:GlobalSetting`

Both are seeded, both are within the tenant admin's authority, and `manage:GlobalSetting` is
tenant-conditioned in `tenant-full-access`. But the settings-registry write path has its own
super-admin locks (`globalOnly` descriptors, `SUPER_ADMIN_ONLY_POLICY_KEYS`) enforced
imperatively, and a machine principal exercising them is a path nobody has run yet. Worth an
explicit review once TASK-767 makes any of it reachable.

---

## 6. Verification

All commands run from the repo root on branch `feat/loop`, 2026-08-19.

### 6.1 Package gates

```
$ pnpm --filter @arcaai/database build
> tsc                       # clean, no output

$ pnpm --filter @arcaai/database typecheck
> tsc --noEmit              # clean, no output

$ pnpm --filter @arcaai/database test
 Test Files  58 passed (58)
      Tests  1531 passed (1531)
   Duration  3.29s
```

Baseline before this change was 55 files / 1346 tests (TASK-763 §6.2), so this contributes
**+3 files, +185 tests**. Per file:

```
$ npx vitest run src/prisma/db_main/seed/__tests__/service-account-seed.test.ts
Tests  72 passed
$ npx vitest run src/prisma/db_main/seed/__tests__/tenant-admin-authority.test.ts
Tests  93 passed
$ npx vitest run src/prisma/db_main/seed/__tests__/bootstrap-tenant-admin.test.ts
Tests  18 passed
```

(72 + 93 + 18 = 183; the remaining 2 are the extra phase-invocation cases
`seed-pipeline-completeness.test.ts` generates for `seedBootstrapTenantAdmin` and
`seedServiceAccount`.)

`pnpm --filter @arcaai/database lint` remains **not applicable** — the package declares no `lint`
script and carries no `eslint.config.*`, so ESLint has no config to resolve there.

### 6.2 The seed, run twice against the test database

Per the brief, the database was **not** reset. `RUN_SEED` is not in `.env.test`, so it was passed
explicitly (without it the seed silently no-ops):

```
$ NODE_ENV=test RUN_SEED=all \
  BOOTSTRAP_TENANT_ADMIN_EMAIL=tenant-ops@example.test \
  BOOTSTRAP_TENANT_ADMIN_PASSWORD='task766-verification-passphrase' \
  pnpm --filter @arcaai/database seed
...
Database seeding completed successfully!
```

Second run, same command — the new phases report the CREATE-ONLY skip and change nothing:

```
Seeding bootstrap TENANT_ADMIN...
  Bootstrap tenant admin already exists (username "tenant-admin") — leaving it untouched.

Seeding service accounts (dev/test: with fixture secrets)...
  Service account "hope_svc_a4ca1a11ad3141b0c0de0001" already exists — leaving it untouched.
Seeded 0 service account(s) (1 already present)
```

### 6.3 The rows that were written

```
ServiceAccount:
  clientId=hope_svc_a4ca1a11ad3141b0c0de0001
  tenantId=50000000-0000-0000-0000-000000000001   (ArcaAI — a CUSTOMER tenant)
  superAdmin=false  ttl=900  scopes=37  allowedTenantIds=null  status=ENABLED
  credentialsRef=service-accounts/hope_svc_a4ca1a11ad3141b0c0de0001/current
  verifierLen=64

bootstrap tenant admin user:
  { id: '70000000-…-0000000000fe', username: 'tenant-admin',
    tags: ['bootstrap','tenant-admin'], hasPw: true }
role assignments:
  [{ roleId: '00000000-…-000000000002' (TENANT_ADMIN),
     tenantId: '50000000-…-000000000001' (ArcaAI) }]

ArcaAI tenant: plan=null, description='ArcaAI — the day-1 customer tenant: …'
```

### 6.4 The credential actually authenticates

Recomputing the verifier the way `ServiceAccountService.computeSecretVerifier` does, with the
pepper resolved from the same source the running API uses:

```
pepper present: true
verifier matches the dev fixture secret: true
```

### 6.5 Every seeded scope is registry-valid (the §4.5 landmine, checked)

Resolved against the LIVE `SERVICE_ACCOUNT_SCOPE_REGISTRY` in `packages/applications` — the
`packages/database` test can only mirror it, so this was run once directly:

```
svc:admin:user:read -> read:User
svc:admin:harness:manage -> manage:HarnessPolicy,manage:HarnessEval,manage:HarnessWorkflow,read:HarnessAudit
... (37 scopes)
ALL SEEDED SCOPES ARE REGISTRY-VALID
```

Every resolved implication matched the mirrored `SVC_SCOPE_IMPLICATIONS` table in
`service-account-seed.test.ts` exactly.

### 6.6 Mintability sweep re-run (R6)

The TASK-763 sweep was re-executed against the live `API_KEY_SCOPE_REGISTRY`:

```
### SUPER_ADMIN: 96/96 mintable
### TENANT_ADMIN: 75/96 mintable
### DEPARTMENT_HEAD: 32/96 mintable
### DOCTOR: 31/96 mintable
### NURSE: 18/96 mintable
   OPEN-ROUTE SCOPES NOT MINTABLE: prompt:template:read
```

Identical to TASK-763's post-fix numbers — **no regression, and no new contradiction**. The single
NURSE line is pre-existing and correct: NURSE holds no `create:ApiKey` at all, which is why
`reader-plane-mintability.test.ts` deliberately excludes it from `KEY_MINTING_ROLES`. This ticket
changed no policy, so the numbers were expected to be unchanged and are.

### 6.7 Not verified

- **`RUN_SEED="safe"` was not executed.** Doing so on the test database would write the platform
  configuration phases against an `all`-seeded database; the phase gating is covered by
  `seed-mode.test.ts` and by the new `bootstrap-tenant-admin.test.ts` mode assertions.
- **The inert (non-dev) service-account branch was not executed**, because `NODE_ENV` must be
  development or test for `RUN_SEED=all` to be permitted at all. It is covered by static
  assertions on the source (§4.2) plus the `shouldSeedServiceAccountSecrets` unit tests.
- **No e2e run.** TASK-765/767 own `apps/api` concurrently.

---

## 7. What a fresh day-1 deploy can now do that it could not before

**Can:**

- Provision the ArcaAI tenant's administrator in a `RUN_SEED="safe"` deployment from two
  environment variables — previously impossible without a super admin creating the account by
  hand in the console.
- Point that bootstrap at **any** customer tenant (`BOOTSTRAP_TENANT_ADMIN_TENANT_KEY`), not just
  ArcaAI, while being refused on the two reserved platform tenants.
- Administer the ArcaAI tenant end to end as that user: users and role assignments, departments and
  department agents, prompt templates and versions, consultations and context schemas, STT/TTS/IdP
  and frontend config, allowed origins, harness policy and evals, pipeline policy, workflow
  definitions/runs/fixtures, knowledge corpus, API keys, storage and buckets, billing reads, audit
  reads, tenant telemetry — 77 of the 87 abilities the API declares, with the other ten proven to
  be platform-plane.
- Hand automation a **machine identity for the ArcaAI tenant** whose authority is provably bounded
  by that same tenant administrator, obtained with one `rotate` call and no scope decisions.
- Re-seed safely: neither bootstrap account nor the service account is ever rewritten, so a
  rotated credential survives.
- **Manage its own tenant's custom roles** — create one, clone a built-in, then edit and delete the
  copy (OD-1, resolved 2026-08-20). SYSTEM roles stay readable and assignable but super-admin-only
  to write, and another tenant's role id returns 404.

**Cannot:**

- Use the service account against any route until **TASK-767** lands — `@RequiredSvcScopes` is
  deny-by-default and no route declares it yet (§2.3). The scopes are provisioned ahead of the
  surfaces.
- Rely on any commercial plan being modelled — every tenant resolves ungated-legacy (OD-2).
- Find the bootstrap variables documented anywhere tracked (OD-3).
- Everything TASK-763 §7 already listed as "cannot" — provider `baseUrl` correctness in a cluster,
  SYSTEM-vs-Global settings ownership, and the fact that a deployment which does not set
  `RUN_SEED="safe"` gets no configuration at all.

---

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-19 | Ticket authored and implemented. Env-driven CREATE-ONLY bootstrap TENANT_ADMIN added (`93-bootstrap-tenant-admin.ts`); ArcaAI machine identity added with a scope set derived from the tenant admin's own authority (`94-service-account.ts`, 37 scopes, secret gated by environment); both wired into `index.ts`; service-account id block reserved in `00-constants.ts`; ArcaAI tenant description corrected in `05-tenant.ts`; 183 tests added across 3 new files, including an exact-set pin on tenant-admin authority. Mintability sweep re-run — unchanged. Four owner decisions recorded in §5. Status **Review**. |
| 2026-08-20 | Two owner decisions resolved. **OD-2 (tenant plan) RESOLVED**: ArcaAI's seeded tenant row now carries `plan: TenantPlan.ENTERPRISE` (`05-tenant.ts`); every other seeded tenant (SYSTEM, Global) keeps `plan = NULL` unchanged. Proven at both layers: `tenant-plan-seed.test.ts` (new, `packages/database`) pins the seed literal; `entitlements.service.test.ts` (new case, `packages/applications`) proves `EntitlementsService.resolveForTenant` actually resolves a real, gated ENTERPRISE quota set (`maxUsers: 100`, `maxDepartments: 40`, `maxApiKeys: 50`) for that plan value rather than falling through to `UNGATED_ENTITLEMENTS`. **OD-3 (bootstrap credential docs) RESOLVED**: the variables are now documented in a tracked operator runbook, `docs/operations/day-one-deployment.md` §2 — which variables, where to set them (host env only, never a tracked file), the first-login flow, and the absent-variable behavior — linked from this README and from TASK-763's. OD-1 and OD-4 remain open, unchanged from the original audit. |
| 2026-08-20 | **OD-1 (tenant-owned roles) RESOLVED** — owner ruled for the column, not the guard: `Role` gained a NOT NULL, no-default, indexed `tenantId`, so the boundary lives in the tenant-scope Prisma extension instead of a per-route check. Migration `20260820045008_task_766_add_role_tenant_id` authored against a throwaway shadow DB (add nullable, backfill every existing row to SYSTEM, `SET NOT NULL`, index); the backfill was proven by planting a pre-existing row before applying, and `prisma migrate diff --from-config-datasource` then printed `-- This is an empty migration.` End-to-end this time: `RoleEntity` moved to `BaseTenantEntity` (chaining `super.validate()`), `RoleFactory` takes a required `tenantId`, `RoleModel` regenerated onto `BaseTenantDataModel`, and `RbacRoleFactory` / `RbacRoleRepository` / `RbacRoleEntityMapper` all carry the column — the inconsistency that forced the earlier revert is closed, with `gen:model:check` / `gen:entity:check` / `gen:factory:check` reporting no drift and factory coverage OK. `RbacRoleService` gained `assertMutable` (own tenant allowed; SYSTEM **403**, a privilege boundary because the row is legitimately visible; another tenant already **404** from the widened read, so 404-over-403 holds by construction) applied to update/patch/softDelete AND to policy attach/detach (`RolePolicy` is a global join, so attaching to a SYSTEM role would change every tenant's grants), plus a `crossTenantLane` so a super admin with a working tenant selected can still edit a SYSTEM role instead of hitting P2025. `PUT`/`PATCH` now accept `update` OR `manage`, `DELETE` accepts `delete` OR `manage` (the decomposed abilities a tenant admin actually holds); `route-manifest.json` regenerated. Seeds stamp SYSTEM and pin the tenant on every by-name lookup. `Policy` / `RolePolicy` stay GLOBAL, and `Role` stays in `SYSTEM_SHARED_READ_MODELS` (reads widen to `[caller, SYSTEM]`, writes do not) — both decisions justified in §5 OD-1, along with the ruling that built-in roles are resolved cross-tenant and **never cloned at tenant provisioning**. 27 tests added (`role.service.task766.test.ts` x20, `role-tenant-seed.test.ts` x4, `RoleEntity.test.ts` tenant-guard x3); the ownership guard was verified RED by neutering `assertMutable`. One follow-up deliberately deferred and recorded: `@@unique([name])` is still global, so role names remain squattable across tenants. |
