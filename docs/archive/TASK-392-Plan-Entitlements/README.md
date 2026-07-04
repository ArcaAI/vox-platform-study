# TASK-392 — Plan Entitlements System

|             |                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------- |
| **Ticket**  | TASK-392                                                                                      |
| **Title**   | Plan-entitlements system (resolution, metering, enforcement, feature gates, SDK/FE)          |
| **Created** | 2026-07-01                                                                                    |
| **Updated** | 2026-07-02                                                                                    |
| **Status**  | Completed — **matrix RATIFIED as-is**; enforcement **ON in DEV + STAGING**, **OFF in TEST**    |
| **Source**  | `docs/implementation/TASK-387-Tenant-Data-Model-Backlog/ENTITLEMENTS-PROPOSAL.md` (APPROVED) |

> Implements the APPROVED entitlements proposal + the §6 Q1–Q10 resolved decisions.
> The proposal is READ-ONLY reference.
>
> **RATIFIED (2026-07-02):** the user ratified the §2 matrix **AS-IS** (STARTER / PRO·TRIAL /
> ENTERPRISE seats, the C7 concurrency limits, and every storage/meter value — **no number
> changes**) and directed **enabling enforcement in DEV + STAGING**. The `entitlements.enabled`
> kill-switch is now driven by a durable, per-environment **seed default** (see §6.4): DEV +
> STAGING come up **ON**; TEST/CI stay **OFF** (the shared E2E baseline assumes OFF). Live
> enforcement-ON was re-proven against the `:8868` TEST stack and then reverted to OFF (§6.4).

---

## 1. Requirement Analysis

Attach product-plan (`Tenant.plan`: ENTERPRISE / PRO / TRIAL / STARTER) semantics to the
platform: per-plan **quantity limits**, **rolling-monthly consumption meters**, **feature
toggles**, **rate-limit tiers**, and **model access** — resolved from DB defaults + per-tenant
overrides, surfaced read-only first, then enforced behind a kill-switch.

### Resolved decisions (proposal §6)

| Q       | Decision (baked in)                                                                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q1**  | **DB-backed**: `PlanEntitlement` (per-plan matrix) + `TenantEntitlement` (per-tenant override, admin-editable). NOT a static code map. Seed defaults; resolver reads DB with a seeded-constant fallback. |
| **Q2**  | Concrete matrix anchored to **~100 seats for ENTERPRISE** (see §2). Tunable (DB-backed + enforcement off). "100 concurrent doctors" is read as ~100 **total** seats (concurrency is a separate axis — flagged). |
| **Q3**  | **No backfill** (dev-only). `resolveEntitlements(null)` → **ungated-legacy**. System tenant stays ungated.                                                |
| **Q4**  | **TRIAL = 7 days**, entitlements during trial = **PRO**; on expiry **auto-downgrade to STARTER** (plan change only; `resourceStatus` untouched). Additive `Tenant.trialEndsAt DateTime?`; clock starts at create / first TRIAL assignment. Expiry job reuses `assertNotSystemTenant` + emits `SysEvent`. |
| **Q5**  | **Rolling monthly metering** (new `TenantUsageMeter` table + rollover/reconcile job) for M1 consultations / M2 transcription-minutes / M3 summaries. Postgres aggregation (Prometheus has no `tenantId`). |
| **Q6**  | **Tenant-level storage quota** + **soft-warn** on upload (never hard-block).                                                                              |
| **Q7**  | **plan → rate-limit tier** AND **per-tenant override** ("increase on demand"): `TenantEntitlement.rateLimitTier` / `rateLimitPerMinute`.                  |
| **Q8**  | **Model access = clone-subset** at tenant create via `provisionTenantModelCatalog` (plan-specific subset); per-tenant catalog stays frozen/independent; future per-tenant rollout preserved. |
| **Q9**  | Enforcement **OFF by default** behind `entitlements.enabled` GlobalSetting (mirrors `rate-limit.enabled`). Seed = off.                                     |
| **Q10** | Downgrade/over-limit = **block-new-only** (grandfather existing) AND **soft-disable redundant resources by NEWEST `createdAt` first** (`resourceStatus=DISABLED`, reversible, NEVER delete). Gated behind kill-switch + only on explicit downgrade/trial-expiry. |

---

## 2. Ratified matrix (Q2)

> **RATIFIED AS-IS (2026-07-02).** The user accepted every number in §2a/§2b **without change** —
> STARTER / PRO·TRIAL / ENTERPRISE seats (C2), the C7 concurrency limits, the C1 storage quotas,
> and the M1–M3 monthly meters. These values are the live source of truth: they match the seed
> (`seed/15-entitlements.ts`) and the in-code fallback (`entitlements.constants.ts`), and were
> re-verified live in `hope_test` (§6.4). No further tuning is pending.

> `null` (rendered `∞`) = unlimited/ungated for that dimension. **TRIAL mirrors PRO** (Q4:
> trial = 1-week PRO experience). Every number is DB-backed + tunable; enforcement is off by
> default. **Assumption (flagged):** ENTERPRISE "~100 concurrent doctors" splits into TWO axes —
> ~100 **total** provisioned seats (C2) **and** ~100 **concurrent** live sessions
> (`maxConcurrentSessions`, C7 — added this round, gated via the TASK-386 socket-registry; see
> §2a + §6.3).

### 2a. Quantity limits & rolling-monthly meters

| Capability                          | STARTER | TRIAL (=PRO) | PRO     | ENTERPRISE |
| ----------------------------------- | ------- | ------------ | ------- | ---------- |
| C2 Max users (seats)                | 5       | 25           | 25      | 100        |
| C3 Departments                      | 2       | 10           | 10      | 40         |
| C4 Prompt/agent templates           | 10      | 50           | 50      | 300        |
| C5 ASR pipelines                    | 1       | 5            | 5       | 20         |
| C6 API keys                         | 2       | 10           | 10      | 50         |
| C7 Max concurrent sessions          | 5       | 25           | 25      | 100        |
| C1 Storage quota (GB)               | 5       | 100          | 100     | 1,000      |
| M1 Consultations / month            | 500     | 5,000        | 5,000   | 50,000     |
| M2 Transcription minutes / month    | 1,000   | 12,000       | 12,000  | 120,000    |
| M3 Summaries / month                | 500     | 5,000        | 5,000   | 50,000     |

Sanity check @ ENTERPRISE 100 seats: 50k consults/mo ≈ 500/doctor/mo ≈ 25/workday;
120k transcription-min/mo ≈ 60 min/doctor/workday — reasonable for a busy clinic.

### 2b. Feature toggles, model tier & rate knobs

| Capability                        | STARTER | TRIAL   | PRO     | ENTERPRISE   |
| --------------------------------- | ------- | ------- | ------- | ------------ |
| F2 DNA writing-style + reports    | ✗       | ✓       | ✓       | ✓            |
| F3 Voice enrollment / diarization | ✗       | ✓       | ✓       | ✓            |
| F5 Monitoring / telemetry access  | ✗       | ✗       | ✗       | ✓            |
| F1 Model tier (clone subset)      | base    | full    | full    | full_custom  |
| R1 Rate-limit tier                | strict  | default | default | relaxed      |

- **`modelTier`** drives the clone-subset at tenant create (Q8): `base` = ASR+SMR base slugs only; `full` = full SYSTEM catalog; `full_custom` = full + finetuned/quantized.
- **`rateLimitTier`** maps plan → one of the existing `rate-limit` tiers (`strict|default|relaxed|heavy`); a per-tenant `TenantEntitlement.rateLimitTier` / `rateLimitPerMinute` overrides it (Q7).
- Unlimited (`∞`) is represented as `null` in a limit column. Per-tenant overrides use `null` = "inherit plan default"; set a concrete value to override. (Granting unlimited to one tenant = set ENTERPRISE plan or a very high value — acceptable given off-by-default + tunable.)

---

## 3. Data model (additive only)

New enum `UsageMeterMetric { CONSULTATIONS, TRANSCRIPTION_MINUTES, SUMMARIES }`.

| Model                | Scope                          | Purpose                                                                                          |
| -------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `PlanEntitlement`    | platform (no tenantId, `plan @unique`) | The per-plan default matrix (§2). 4 seeded rows. Admin-editable (super-admin).            |
| `TenantEntitlement`  | tenant (`tenantId @unique`)    | Per-tenant override; nullable columns = "inherit plan default". Admin-editable. Includes rate-limit override (Q7). |
| `TenantUsageMeter`   | tenant (`@@unique([tenantId, metric, periodStart])`) | Rolling-monthly windowed counters for M1–M3; rollover/reconcile job.       |
| `Tenant.trialEndsAt` | additive nullable column       | Trial clock (Q4).                                                                                |

Kill-switch: `entitlements.enabled` GlobalSetting (Boolean, platform tenant, seed=`false`).

---

## 4. Phased plan (proposal §7) — strict layer chain + TDD

1. **Phase 1 — Resolution + display (no enforcement):** schema; domain; `resolveEntitlements(plan|null)` pure fn; DB resolver service + kill-switch read; usage/capability DTO (compose `getUsageStats` + limits); entitlements CRUD; trial defaults; seed. Unit-tested.
2. **Phase 2 — Rolling monthly metering (M1–M3):** `TenantUsageMeter` + metering service (live Postgres aggregate for current window + persisted counter + rollover/reconcile job). Unit-tested.
3. **Phase 3 — Service checks:** COUNT/meter prechecks in create/submit paths (C2 users, C3 departments, C4 prompt-templates, C5 ASR pipelines, C6 api-keys, C1 storage soft-warn, M1–M3) → typed `quota_exceeded`; behind kill-switch; `SysEvent` on block. Trial-expiry + downgrade soft-disable (Q10).
4. **Phase 4 — API + feature gates:** NEW entitlements module/controller (ALL new endpoints here); error mapping (403/409/413/429); model clone-subset (Q8); rate-limit-by-plan + per-tenant override (Q7).
5. **Phase 5 — SDK + FE:** SDK entitlements/usage hook; Admin usage/quota bars, near-limit warnings, blocked-action UX, trial countdown/expiry banner.

---

## 5. Ownership & constraints

- **OWNED:** `tenant.prisma` (+ new `entitlement.prisma` models), `TenantFactory`, `tenant.service.ts` (trial-default/downgrade/expiry only), NEW entitlements module (service+resolver+controller+DTOs — all new endpoints HERE), NEW metering table+job, create/submit paths in user/department/prompt-template/asr-pipeline/api-key/media services, `RateLimitingService`/rate-limit config, `provisionTenantModelCatalog`, kill-switch GlobalSetting, SDK entitlements/usage hooks, `apps/admin/src/**` entitlements FE, the test stack + `task-392-*` e2e + this doc.
- **DO NOT TOUCH (parallel worker):** `tenant.controller.ts`, `TenantConfigResponse`, `PaginatedTenantConfigResponse`, `TenantConfigDtoMapper`/`GlobalSettingDtoMapper`, `ENTITLEMENTS-PROPOSAL.md`, `docs/qa/*`, settled TASK-386–391 files.
- Additive migrations only; NEVER destructive SQL; Q10 "disable" = reversible status flag (never delete); NEVER commit/push.

---

## 6. Implementation Summary

### Status by phase

| Phase | Scope | Status |
| ----- | ----- | ------ |
| **1 — Resolution + display** | schema, domain, resolver, kill-switch, capability DTO, CRUD, trial defaults, seed | ✅ **Done + GREEN + DB-verified** |
| **2 — Rolling-monthly metering** | `TenantUsageMeter`, live aggregate + reconcile job, wired into capabilities | ✅ **Done + GREEN** |
| **3 — Service checks + jobs** | enforcement primitive + **create-path wiring** (C1–C6, M1–M3) + **trial-expiry & downgrade jobs** | ✅ **Done + GREEN + live-E2E-verified** |
| **4 — API + feature gates** | NEW entitlements controllers, error mapping (409/429/413/403), model clone-subset (Q8), rate-limit-by-plan (Q7) | ✅ **Done + GREEN + live-E2E-verified** |
| **5 — SDK + FE** | SDK `useEntitlements` hook, admin matrix editor + override dialog + usage bars / trial banner / blocked-action UX | ✅ **Done + GREEN** |

Enforcement is **OFF by default** (`entitlements.enabled` = `false`, seeded), so everything landed is inert until an operator flips the switch per-env. The full stack (unit → `tsc` → `build:api` → SDK/admin build → restart → **live enforcement-ON E2E, 22/22**) is verified below (§6.2).

### Phase 1 — Resolution + display ✅

- **Schema (additive):** `packages/database/src/prisma/db_main/entitlement.prisma` — `PlanEntitlement` (platform, `plan @unique`), `TenantEntitlement` (`tenantId @unique`, nullable overrides), `TenantUsageMeter` (`@@unique([tenantId, metric, periodStart])`), enum `UsageMeterMetric`. `Tenant.trialEndsAt DateTime?` added to `tenant.prisma`. Pushed to the TEST DB (additive `db push`, no reset) + `db:generate` + prisma barrel regen.
- **Domain:** generated entities/factories/mappers/repositories + barrels for all three models; custom finders `PlanEntitlementRepository.findByPlan`, `TenantEntitlementRepository.findByTenant`, `TenantUsageMeterRepository.findWindow`.
- **Resolver (pure):** `services/entitlements/resolve-entitlements.ts` — `resolveEntitlements(plan, planRow?, override?)` merges seeded default ← DB plan row ← per-tenant override; `null` plan → `UNGATED_ENTITLEMENTS` (Q3). `entitlements.constants.ts` holds `PLAN_ENTITLEMENT_DEFAULTS` (the §2 matrix).
- **Service:** `EntitlementsService` — `resolveForTenant`, `getCapabilities` (limits × live usage + trial clock), kill-switch `isEnforcementEnabled`/`setEnforcementEnabled` (mirrors `RateLimitAdminService`), plan-matrix CRUD (OCC), tenant-override CRUD (reversible `clearTenantEntitlement` nulls fields — never deletes). `+ IEntitlementsService`, module, DTOs.
- **Trial defaults:** `TenantFactory` stamps `trialEndsAt = createdAt + 7d` when `plan = TRIAL` (Q4); `TenantService.create` defaults `plan → TRIAL` when omitted (proposal §5). Factory keeps `plan` neutral (`null`) otherwise — TASK-387 contract preserved.
- **Seed:** `seed/15-entitlements.ts` — 4 `PlanEntitlement` rows (§2) + `entitlements.enabled = false`; idempotent upserts. Applied to the TEST DB in isolation. **Verified in `hope_test`:** STARTER/TRIAL/PRO/ENTERPRISE = 5/25/25/100 seats; storage 5/100/100/1000 GiB (as `BigInt`); `entitlements.enabled = false`.

### Phase 2 — Rolling-monthly metering ✅

- **`services/metering/`** (NEW module): `metering-window.ts` (pure UTC calendar-month window), `MeteringService` (`IMeteringService`), module + barrel.
- **Reads** (`getCurrentUsage`) are a **live Postgres aggregate** over the current window (CONSULTATIONS = `Consultation.createdAt`; TRANSCRIPTION_MINUTES = `round(Σ AudioRecording.duration/60000)`; SUMMARIES = `SummaryMeta.generatedAt`) — authoritative + near-realtime, correct even with the job off.
- **Reconcile** (`reconcileTenant` / `reconcileAllActiveTenants`) upserts the persisted `TenantUsageMeter` snapshot via the **unscoped base client** (cross-tenant safe, no CLS needed). New months open fresh windows automatically (Q10-safe — no destructive reset).
- **Self-scheduling job** mirrors `AuditRetentionService`: `metering.reconcile.enabled` (**OFF** default), `metering.reconcile.cron` (`*/15 * * * *`), re-synced on `app-settings.cache-refreshed`.
- **Wired:** `EntitlementsService.getCapabilities` now populates the M1–M3 meters from `getCurrentUsage` (previously `null`).

### Phase 3 — Enforcement primitive (core) ✅ / wiring ⏳

- **Typed error:** `@arcaai/exceptions` → `QuotaExceededException` (code `DOMAIN.QUOTA_EXCEEDED`) with structured metadata `{ capability, limit, used, requested, tenantId }`. (`exceptions` dist rebuilt.)
- **Pure logic** (`services/entitlements/enforcement.ts`, exhaustively unit-tested — the sensitive Q10 core):
  - `wouldExceedLimit(limit, used, inc)` — block-new comparison (`null` = unlimited).
  - `selectResourcesToDisable(resources, limit)` — Q10 keep-oldest-`limit`, disable-newest-overflow, deterministic (createdAt asc, tie-break id).
  - `isTrialExpired(trialEndsAt, now)` — Q4 predicate.
- **Service primitive:** `EntitlementsService.assertQuantityQuota(tenantId, capability, currentCount, inc?)` — **no-op when kill-switch OFF (Q9) or limit null (Q3)**; else emits `entitlements.quota-blocked` + throws `QuotaExceededException` (grandfathers existing — blocks the NEW action only, Q10).

### New keys / events introduced

| Name | Kind | Default |
| ---- | ---- | ------- |
| `entitlements.enabled` | GlobalSetting (Boolean, kill-switch, Q9) | `false` (seeded) |
| `metering.reconcile.enabled` | GlobalSetting (Boolean) | `false` |
| `metering.reconcile.cron` | GlobalSetting (String) | `*/15 * * * *` |
| `entitlements.quota-blocked` | domain event (Q10 block audit) | — |
| `DOMAIN.QUOTA_EXCEEDED` | exception code | — |

### Verification evidence (this landing)

- **Unit:** `resolve-entitlements`, `entitlements.service`, `enforcement`, `metering-window`, `metering.service` → all GREEN (metering + entitlements combined run: **59 passed**). Domain `TenantFactory.trial` + `tenant.service` create-default tests GREEN.
- **Type-check (full-context, non-disruptive):** `pnpm --filter @arcaai/domains tsc --noEmit` ✅; `pnpm --filter @arcaai/applications tsc --noEmit` ✅ (after `@arcaai/exceptions` rebuild).
- **DB:** additive push to `hope_test`; `SELECT` confirms 4 plan rows + kill-switch OFF. No destructive SQL. No `db reset`.
- **`build:api` + stack restart + live E2E:** ✅ **completed this round** — the shared `:8868` stack was freed by the parallel TASK-393 worker. Full integration + enforcement-ON live E2E evidence is in §6.2.

### 6.1 Phase 3 wiring + jobs / Phase 4 / Phase 5 — COMPLETED (this round)

**Phase 3 wiring (create/submit paths → `packages/applications`, kill-switch-gated no-ops):**

- Quantity prechecks via `assertQuantityQuota(tenantId, <cap>, currentCount)` wired into create paths: **C2** `user.service` + `userRoleAssignment.service`, **C3** `department.service`, **C4** `prompt-management.service`, **C5** `pipeline.service` (ASR), **C6** `apiKey.service`.
- **C1 storage soft-warn** (`evaluateStorageSoftWarn`, never blocks — Q6) on the `media.service` upload/create path.
- **M1–M3 meter prechecks** (`assertMeterQuota`) on `consultation.service` (start), `transcriptionJob.service` (STT submit), `summary.service` (generate).
- Each service's `*.module.ts` now provides `IEntitlementsService` / `IMeteringService`. A block emits `entitlements.quota-blocked` (→ `SysEvent`/audit).

**Phase 3 jobs (`services/entitlements/entitlements-lifecycle.service.ts`, NEW):**

- **Trial-expiry sweep** (`expireTrials`, self-scheduling, OFF by default): flips expired `TRIAL → STARTER` **plan-only** (`resourceStatus` untouched), reuses the system-tenant guard, wraps each mutation in a per-tenant CLS scope so the `SysEvent`/audit attributes to the target tenant.
- **Downgrade action** (`triggerDowngrade`): plan change always applies; the Q10 newest-first **soft-disable** (`resourceStatus = DISABLED`, reversible, NEVER delete) across Department / PromptTemplate / AsrPipeline / ApiKey is **gated behind the kill-switch** (with enforcement OFF it is a pure relabel = block-new-only, grandfathering everything). New `WorkerSessionKind: entitlements-lifecycle`.

**Phase 4 — API + gates:**

- NEW module `apps/api/src/modules/entitlements/` (NOT `tenant.controller.ts`): `entitlements-admin.controller.ts` (super-admin) + `my-entitlements.controller.ts` (tenant-admin self-snapshot) + DTOs, registered via `EntitlementsApiModule` in `app.module.ts`. CASL gates: super-admin for matrix/override/downgrade/kill-switch; tenant-admin for own snapshot.
- **Error mapping** (`exception.interceptor.ts`): `QuotaExceededException` → **409** (quantity create) / **429** (monthly meter) / **413** (storage) / **403** (feature gate), keyed on capability.
- **Model access (Q8):** `provisionTenantModelCatalog` clones a plan-tier subset via pure `modelAllowedForTier`/`modelTierForPlan` (`services/entitlements/model-access.ts`).
- **Rate-limit-by-plan (Q7):** pure `resolvePlanRateLimit` (`services/entitlements/rate-limit-plan.ts`) composes plan tier + per-tenant override into `{ limit, ttl }`. Data model + resolution landed; **hot-path guard binding deferred** (documented note below).

**Phase 5 — SDK + FE:**

- **SDK (`@arcaai/vox`):** `ENTITLEMENTS_ENDPOINTS` constants + `useEntitlements` hook (plans matrix, kill-switch, per-tenant override, snapshot, downgrade, trial-run, `/entitlements/me`) with hand-written types mirroring the DTOs; barrels updated.
- **Admin FE (`apps/admin`):** `entitlements.tsx` route (adaptive super-admin editor vs. tenant self-view), `plan-edit-dialog` (matrix editor, OCC), `tenant-override-dialog` (tri-state features + OCC), `capability-snapshot` (usage bars / near-limit / trial banner), `entitlements-format` helpers (incl. `quotaErrorMessage` 409/429/413/403 → friendly text), nav item under Settings. Playwright `task-392-entitlements.spec.ts`.

**~~Deferred~~ → DONE (this round, §6.3):** the Q7 per-request rate-limit **guard binding** is now live — `TieredThrottlerGuard` extracts the tenant **pre-auth** (unverified JWT `tenantId` decode) and applies `resolvePlanRateLimit(plan)` + per-tenant override on the hot path, falling back to the existing global tiers when the kill-switch is OFF or no tenant resolves.

### 6.2 Integration build + live E2E evidence (this round)

**Unit / type (per area, TDD):** domains **1279 passed**, applications **5614 passed**, api **1871 passed**, admin FE **275 passed**, SDK `@arcaai/vox` **3452 passed**; `tsc --noEmit` clean for `@arcaai/domains` + `@arcaai/applications`; admin `type-check` clean.

**Integration pass (owned the freed `:8868` stack):** stop `dev:api:test` → `pnpm build:api` (**8/8 turbo tasks**, whole tree incl. the sibling TASK-393 tenant-config cast-fix) → SDK build ✅ → admin type-check ✅ + build ✅ → restart → `:8868/api/v1/health` **200**. **No TASK-393 build-fix was required** — the tree compiled clean, so `tenant.controller.ts` / `my-tenant.controller.ts` / `TenantConfigResponse` / `TenantConfigDtoMapper` / `GlobalSettingResponse.locked` were left untouched.

**Live enforcement-ON E2E** (`SKIP_DB_PRECHECK=true`; kill-switch flipped ON in-test, then fully restored to OFF; self-restoring, idempotent) — **22/22 assertions**:

| Area | Result |
| ---- | ------ |
| Baseline | kill-switch OFF (seed); ArcaAI ungated when plan `null` |
| Setup | plan → STARTER (OCC If-Match + `expectedVersion`); override `maxApiKeys=0` (create-or-update OCC); kill-switch ON |
| **Capped tenant** | snapshot `gated=true, enforcementEnabled=true, apiKeys.limit=0`; api-key create **BLOCKED → 409** |
| **NULL-plan tenant** | System tenant `gated=false` even with enforcement ON (ungated-legacy, Q3) |
| **Uncapped (override→100)** | api-key create **ALLOWED → 201** |
| **Downgrade soft-disable (Q10)** | report `enforcementEnabled=true, toPlan=STARTER`; soft-disabled **exactly the 2 newest overflow keys** (`resourceStatus=DISABLED`, ids matched, **no delete**) |
| **Higher plan (ENTERPRISE)** | apiKeys cap raised to **50**, `exceeded=false` (allowed) |
| **Trial sweep (Q4)** | `POST /admin/entitlements/trial-expiry/run` → valid `{examined,downgraded,tenantIds}` report |
| **TASK-393 regression** | `GET /tenant/me/config` → **200** (25 rows, version/locked mapper) **and** `GET /admin/tenants/configs/:id` → **200** — closes 393's deferred runtime check |
| **task-3xx smoke** | `GET /admin/tenants`, `/admin/settings`, `/health/services`, `/admin/api-keys` → all **200** |
| **Restore** | kill-switch → OFF; ArcaAI plan → `null`; override cleared |

**New HTTP endpoints (all under the NEW entitlements module):**

| Method | Path | Gate |
| ------ | ---- | ---- |
| GET / PUT | `/admin/entitlements/enabled` | super-admin (kill-switch, Q9) |
| GET | `/admin/entitlements/plans` · PATCH `/admin/entitlements/plans/:plan` | super-admin (matrix, OCC) |
| GET | `/admin/entitlements/tenants/:tenantId` | super-admin (capability snapshot) |
| GET / PUT / DELETE | `/admin/entitlements/tenants/:tenantId/override` | super-admin (per-tenant override, OCC) |
| POST | `/admin/entitlements/tenants/:tenantId/downgrade` | super-admin (Q10) |
| POST | `/admin/entitlements/trial-expiry/run` | super-admin (Q4 manual sweep) |
| GET | `/entitlements/me` | tenant-admin (own snapshot) |

**Migrations:** none new this round — Phase 4/5 are code-only. The Phase-1 **additive** schema (`PlanEntitlement`, `TenantEntitlement`, `TenantUsageMeter`, `Tenant.trialEndsAt`, enum `UsageMeterMetric`) stands; no destructive SQL, no `db reset`.

**Test-DB hygiene:** the enforcement probe's api-key soft-disable/create churn was fully reversed on the ephemeral `hope_test` DB — the 2 real seed keys stay ENABLED/ACTIVE; all `t392-*` probe keys soft-deleted (`resourceStatus=DELETED`, reversible). A one-off **non-destructive `UPDATE`** (re-enable `DISABLED → ENABLED`) restored keys an earlier buggy probe had flipped. No commits/pushes; no `DELETE`/`DROP`/`TRUNCATE`.

### 6.3 Follow-up enforcement round — Q7 guard binding + concurrency gating (this round)

Two additional enforcement items landed, TDD + layer-chain, still behind `entitlements.enabled` (seeded **OFF**).

**Q7 — per-request rate-limit guard binding (the documented deferral, now DONE):**

- **Pre-auth tenant extraction:** `TieredThrottlerGuard` runs *before* the JWT strategy populates CLS, so it now decodes the bearer token payload **unverified** (base64 only — no signature/expiry trust; identity is still fully re-validated downstream by the real auth guard) and reads the top-level `tenantId` claim (the same claim `jwt.strategy` trusts). Zero DB I/O on the reject path. Chosen over API-key / tenant-key / header lookups because the JWT is the app's primary hot-path identity and classifies a request with no extra round-trip.
- **Binding:** when a `tenantId` resolves **and** the kill-switch is ON, the guard calls `EntitlementsService.getTenantRateLimitPolicy(tenantId)` (short-TTL cached) → `resolvePlanRateLimit(plan, override)` → `{ limit, ttl }`, used as the effective per-request tier (still keyed by IP+route). A stricter plan tightens the limit; a per-tenant `rateLimitPerMinute` / `rateLimitTier` override wins over the plan tier.
- **Fallback (unchanged behavior):** kill-switch OFF, no token / no `tenantId`, an ungated (null-plan) tenant, or any resolver error → `null` → the guard uses the **existing global tiers**. `isEnforcementEnabled()` is checked *before* the policy cache, so flipping OFF is instant (no stale policy).
- **Files:** `apps/api/src/modules/throttle/tiered-throttler.guard.ts` (extract + bind), `app.module.ts` (wired `EntitlementsServiceModule` so `IEntitlementsService` injects into the `APP_GUARD`), `EntitlementsService.getTenantRateLimitPolicy` (+ 30s cache). Unit: `throttle-guard.test.ts` (+5 Q7 cases: stricter plan, per-tenant override, ungated, no-token, decorator precedence).

**Concurrency-based seat gating (new axis, distinct from C2 total seats):**

- **Definition chosen — active STT sessions / open sockets per tenant** (TASK-386 Redis socket-registry), NOT total seats. Rationale: the registry already aggregates *live* sockets across all API instances (multi-instance correct), so it is the strongest existing "simultaneous capacity" signal and needs no new tracking. Active-consultations was considered but is coarser (a consultation can span idle gaps); an open socket maps 1:1 to a doctor actively streaming *right now*.
- **Matrix field (additive):** `PlanEntitlement.maxConcurrentSessions Int?` + `TenantEntitlement.maxConcurrentSessions Int?` (per-tenant override; `null` = inherit). Additive `db push` to `hope_test` (no reset, no data-loss prompt); existing rows backfilled by a non-destructive `UPDATE` to the seeded matrix — **ENTERPRISE 100 / PRO 25 / TRIAL 25 / STARTER 5** (tunable, DB-backed). Seed (`15-entitlements.ts`) sets the same for fresh DBs.
- **Per-tenant registry aggregate:** `SocketRegistryService.publishLocalTenantCounts` / `getTenantAggregateCount` (new per-tenant Redis keys) + `stt-ws.gateway` publishes local per-tenant socket counts; `EntitlementsService.getActiveConcurrency(tenantId)` reads the cross-instance aggregate (**fail-open → 0** if Redis is down, so a registry outage never blocks clinical streaming).
- **Gate location + style (FLAGGED):** `TranscriptionJobController.createStreamSession` (`POST /audio/transcription-jobs/stream/session`) — `assertConcurrencyQuota` runs **first**, before any pipeline resolution / STT / storage I/O. **HARD-BLOCK** (`QuotaExceededException` → **429**) when `active >= limit`. Concurrency is a simultaneous-capacity ceiling, so hard-block is the natural style (soft-warn would let unlimited doctors stream at once, defeating the cap). No-op when kill-switch OFF or plan/limit `null` (system/ungated tenants). Emits `entitlements.quota-blocked` `SysEvent` on block. **Flag:** if product prefers a grace/soft-warn for concurrency, the only change is swapping the `assert*` for the soft-warn evaluator — resolution + registry + snapshot are style-agnostic.
- **Capability snapshot:** `getCapabilities` adds a `concurrentSessions` **quantity row** (`used` = live aggregate, `limit` = resolved), so the FE renders it automatically.
- **FE (`apps/admin`):** `concurrentSessions` label in `entitlements-format`; `maxConcurrentSessions` added to the shared `LIMIT_FIELDS` (edits in BOTH the plan-matrix editor and the per-tenant override dialog); the usage bar renders from the server-added snapshot row. SDK `@arcaai/vox` entitlement types gained `maxConcurrentSessions` across the 4 interfaces so the FE indexers type-check.

**Verification (this round):**

- **Unit/domain (fresh):** applications **110 passed** (entitlements + socket-registry + rate-limit), api **129 passed** (Q7 throttle guard + transcription-job gate + exception interceptor), admin FE **14 passed** (entitlements-format); admin `type-check` clean; `@arcaai/applications` `tsc --noEmit` clean against the rebuilt `@arcaai/domains` dist (`maxConcurrentSessions` present).
- **Integration build:** stop `dev:api:test` → `pnpm build:api` (**8/8** turbo) → SDK build ✅ → admin type-check ✅ + build ✅ → restart → `:8868/api/v1/health` **200** (against synced `hope_test`).
- **Live E2E** (`SKIP_DB_PRECHECK=true`; kill-switch flipped ON in-test then restored OFF; self-restoring, idempotent) — **27/27 assertions**:

| Phase | Result |
| ----- | ------ |
| A baseline | kill-switch OFF (seed); PRO/ENTERPRISE `maxConcurrentSessions` = 25/100; snapshot has `concurrentSessions` row; TASK-393 `tenant-frontend-config` **200** |
| B enable | kill-switch ON; snapshot `enforcementEnabled=true`; `concurrentSessions.limit` = plan default 25 |
| **C — Q7 hot path** | PRO override `rateLimitPerMinute=3` → 3 calls pass, **4th → 429** (plan tier enforced on the hot path); ungated tenant rides **global 100** (5 calls, no 429) |
| **D — Q7 disabled** | kill-switch OFF → PRO token falls back to global (5 calls, no 429) = current behavior |
| **E — concurrency** | override `maxConcurrentSessions=1`; snapshot limit=1; under-limit (0<1) gate **ALLOWS**; seed live registry count **5**; over-limit (5>1) **429 HARD-BLOCK** (body `code=DOMAIN.QUOTA_EXCEEDED`); kill-switch OFF → gate **no-op** even at 5>1 |
| restore | override cleared (nulled, reversible); kill-switch OFF; Redis seed key removed; PRO tenant `resourceStatus` restored to `DELETED` |

  Live server log confirmed the hard-block `SysEvent` path: `Concurrency limit reached for 'maxConcurrentSessions' (5/1 active sessions) … statusCode 429`.

- **Test-DB hygiene / reversibility:** the PRO E2E tenant ships **soft-deleted** (`resourceStatus=DELETED`) — the Prisma soft-delete filter hides it from `findById`, which is exactly why the pre-auth policy lookup + snapshot need a *visible* tenant. The script flips it `DELETED → ENABLED` for the run and **restores it to `DELETED`** on exit (reversible status flip — no delete). Additive schema only; no `DELETE`/`DROP`/`TRUNCATE`; no `db reset`; no commits/pushes. Seed leaves `entitlements.enabled = false`.

### 6.4 Ratification + DEV/STAGING enablement + live re-proof (2026-07-02)

Closeout of the epic after the user **ratified the §2 matrix AS-IS** (no number changes) and directed **enforcement ON in DEV + STAGING**.

- **Kill-switch mechanism (confirmed):** `entitlements.enabled` is a **GlobalSetting** (Boolean, namespace `entitlements`), read **request-time** via `EntitlementsService.isEnforcementEnabled()` (`AppSettingsService` cache) and flipped at runtime by `PUT /api/v1/admin/entitlements/enabled` (super-admin; refreshes the cache). It is **not** boot-time — no rebuild/restart is needed to toggle it.
- **Durable per-environment seed default (DEV + STAGING = ON):** `seed/15-entitlements.ts` now derives the **fresh-DB** value from `process.env.ENTITLEMENTS_ENABLED_DEFAULT` (truthy set `1/true/yes/on`) → `create.value`; `defaultValue` stays the canonical `'false'` (reset target). The upsert **`update` branch intentionally omits `value`**, so a re-seed **never clobbers a live operator toggle**.
  - **DEV:** `.env.dev` sets `ENTITLEMENTS_ENABLED_DEFAULT=true` → a freshly-seeded DEV DB comes up **ON**.
  - **STAGING:** set `ENTITLEMENTS_ENABLED_DEFAULT=true` in the staging deploy/host env (documented in `.env.production`); this environment cannot be deployed from here, so **staging activates on its next deploy + seed**.
  - **TEST/CI:** intentionally **omit** the var → the shared E2E baseline stays **OFF**. **PROD:** unset → OFF (prod enablement is a separate decision).
  - **Live DEV DB note:** the currently-running DEV `hope` DB **predates this epic** (no `core."PlanEntitlement"` table, no `entitlements.enabled` row), so forcing enforcement ON via a lone row would be unsafe (resolver reads a missing table). It was **left untouched**; the durable config brings DEV up ON on its next migrate + seed.
- **Live enforcement-ON re-proof on the `:8868` TEST stack** (super-admin JWT; **self-reverting**, request-time toggle — no restart):
  - Baseline: kill-switch **OFF**; ArcaAI (`plan=null`) snapshot `gated=false`, apiKeys **unlimited**.
  - ON + `plan→STARTER`: snapshot `gated=true, enforcementEnabled=true` with the **ratified STARTER numbers live** — `apiKeys 2`, `users 5`, `departments 2`, `promptTemplates 10`, `asrPipelines 1`, `storageBytes 5368709120` (5 GiB), `concurrentSessions 5`; meters `500 / 1000 / 500`.
  - Metered path (3rd API key, tenant at 2/2) → **`409 DOMAIN.QUOTA_EXCEEDED`** — *"Plan limit reached for 'maxApiKeys' (2/2)…"*, metadata `{capability:maxApiKeys, limit:2, used:2, requested:1}` (interceptor: quantity cap → **409**).
  - **Reverted to OFF** → the **same create succeeds (`201`)**, proving OFF = pure no-op even at 2/2; probe key **soft-deleted**; ArcaAI plan restored to `null`.
  - **Final shared-stack state:** `entitlements.enabled=false` (DB **and** live API), `/api/v1/health` **200**, ArcaAI back to **2** keys, no leftover probe rows. The shared TEST stack ends **OFF** by design.
- **Folded-in test hygiene (TASK-395 supersession):** the P1-4 sectioned settings form replaced the KV table, so the stale `task-391-settings` `#24 · settings are grouped by namespace` assertion (`getByRole('cell', …)`) was refreshed to the sectioned-form **section heading** (deep-dive coverage lives in `task-395-settings-form`). `task-391-settings` + `task-395-settings-form` run **30/30 green** across desktop/tablet/mobile (verified with entitlements OFF).

No commits/pushes; no `DELETE`/`DROP`/`TRUNCATE`; no `db reset`; no `build:api` (config/seed + doc/spec only).

## 7. Change History

- 2026-07-01 — Ticket created; matrix + decisions + plan documented (Phase 0 gate).
- 2026-07-01 — **Phase 1 landed** (schema + domain + resolver + service + kill-switch + trial defaults + seed); verified in `hope_test`. Enforcement seeded OFF.
- 2026-07-01 — **Phase 2 landed** (`TenantUsageMeter` + live-aggregate/reconcile metering service + self-scheduling job); wired live M1–M3 meters into the capability snapshot.
- 2026-07-01 — **Phase 3 core landed** (typed `QuotaExceededException`; pure `wouldExceedLimit` / `selectResourcesToDisable` / `isTrialExpired`; kill-switch-gated `assertQuantityQuota`). Create-path wiring + trial-expiry/downgrade jobs + Phases 4–5 tracked as follow-ups (§6.1).
- 2026-07-01 — **Phases 3-wiring + 3-jobs + 4 + 5 landed** (§6.1): quota/meter/storage prechecks wired into C1–C6 + M1–M3 create/submit paths; trial-expiry + newest-first downgrade soft-disable jobs; NEW entitlements admin + self controllers with 409/429/413/403 error mapping + CASL gates; model clone-subset (Q8) + `resolvePlanRateLimit` (Q7, guard binding deferred + documented); SDK `useEntitlements` hook; admin matrix editor / override dialog / usage bars / trial banner. **Full integration + live enforcement-ON E2E verified 22/22** on the freed `:8868` stack (§6.2); `build:api` compiled the whole tree clean — **no TASK-393 fix needed**. Enforcement remains OFF by default; no commits/pushes; no destructive SQL. Status → **Completed**.
- 2026-07-02 — **Epic closeout (§6.4):** matrix **RATIFIED as-is** (no number changes); made the `entitlements.enabled` seed default **env-driven** (`ENTITLEMENTS_ENABLED_DEFAULT`) so **DEV** (`.env.dev`) + **STAGING** (host env, next deploy) come up **ON** while **TEST/CI/PROD** stay OFF; **re-proved live enforcement ON** on `:8868` (`409 maxApiKeys 2/2` + STARTER snapshot) then **reverted the shared stack to OFF** (create `201`, health 200); refreshed the stale `task-391-settings` namespace assertion to the TASK-395 sectioned form (`task-391-settings` + `task-395-settings-form` **30/30 green**). Config/seed + docs/spec only; no `build:api`; no commits/pushes; no destructive SQL.
- 2026-07-01 — **Follow-up enforcement round (§6.3):** finished the **Q7 rate-limit guard binding** (pre-auth *unverified*-JWT `tenantId` extraction in `TieredThrottlerGuard` → `resolvePlanRateLimit` + per-tenant override on the hot path; global-tier fallback when OFF / unresolvable) **and** added **concurrency seat-gating (C7)** — additive `maxConcurrentSessions` on `PlanEntitlement` + `TenantEntitlement` (seed ENTERPRISE 100 / PRO·TRIAL 25 / STARTER 5), per-tenant socket-registry aggregate, **hard-block** `assertConcurrencyQuota` at `createStreamSession` (429 + `SysEvent`, fail-open on Redis outage, no-op when OFF, ungated for null-plan), `concurrentSessions` snapshot row + FE usage bar + matrix/override field + SDK types. Verified: applications 110 / api 129 / admin 14 unit, admin type-check clean, `build:api` 8/8 + SDK + admin build, health 200, **live E2E 27/27** (Q7 tier + override on the hot path; concurrency under/over/disabled hard-block; disabled = no change; TASK-393 regression 200). Additive-only; reversible status flips only; no destructive SQL; no commits/pushes; enforcement still **OFF by default**.
- 2026-07-02 — **DEV DB activation performed (ops, user-approved):** entitlements are now **live on the DEV `hope` DB** (`localhost:5432`) via **additive `prisma db push` + seed** — closing the §6.4 "Live DEV DB note". `migrate deploy` was **not usable**: the DEV DB was built with `db push` and has **no `_prisma_migrations` baseline** (all 31 migrations reported pending; deploy would fail on the baseline's first `CREATE TYPE` — enum types already exist — stranding a failed-migration state). Instead: (1) read-only `prisma migrate diff` pre-check confirmed the pending delta was **additive-only** (enums `TenantPlan` + `UsageMeterMetric`, `ResourceStatusType += SUSPENDED`, tables `PlanEntitlement`/`TenantEntitlement`/`TenantUsageMeter`, columns `Tenant.plan`/`Tenant.trialEndsAt`/`Department.dnaWritingStylePromptId`/`TenantBucket.quotaBytes` — zero drops); (2) non-force `pnpm db:push` (no `--force-reset`/`--accept-data-loss`) applied it clean; (3) `pnpm db:seed` (`.env.dev` → `ENTITLEMENTS_ENABLED_DEFAULT=true`) ran its earlier phases (policies → tenants/buckets → roles/departments → STT → prompts → users, idempotent upserts) but **aborted fail-closed at the API-key step** — the dev in-memory Vault had lost its state (`secret/hope/API_KEY_PEPPER` 404, no `transit/` mount), so the remaining **Vault-free** steps were executed directly from the same seed modules (`11-global-setting` → `12-rate-limit-settings` → `15-entitlements`). **Verified read-only:** `entitlements.enabled = true` (defaultValue stays `'false'`) + **4 `PlanEntitlement` rows** matching the ratified §2 matrix (STARTER 5/2/2/5 GiB·5, TRIAL=PRO 25/10/10/100 GiB·25, ENTERPRISE 100/40/50/1000 GiB·100). **Follow-up:** re-init dev Vault (`pnpm infra:up` / dev-init.sh) then re-run `pnpm db:seed` to finish the Vault-dependent fixtures (api-keys, DNA, consultations, audit log). TEST stack (`hope_test`@5433, `:8868`) untouched; no destructive SQL; no reset; no commits/pushes.
- 2026-07-02 — **DEV seed completed (follow-up done):** restored dev Vault state by re-running the existing `hope-vault-init` sidecar only (`docker start -a hope-vault-init` — idempotent dev-init.sh; no other container touched/restarted; pepper + `transit/` `hope-globalsetting`/`hope-phi` verified), then the full `NODE_ENV=development pnpm db:seed` completed clean — Vault-dependent fixtures now seeded (HMAC-peppered API keys, DNA reports/versions, consultations + Transit-encrypted PHI, audit log); `entitlements.enabled=true` + 4 `PlanEntitlement` rows re-verified intact; `:8868` health 200 (uptime continuous) and all container uptimes unchanged.
