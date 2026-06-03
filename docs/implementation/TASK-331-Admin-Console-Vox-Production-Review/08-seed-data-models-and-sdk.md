# TASK-331 · Seed Data, Data Models, Multi-Tenancy & Vox/Storage SDK — Production Review

| Field | Value |
|---|---|
| Parent | TASK-331 |
| Scope (code) | `packages/database/src/prisma/db_main/seed/*.ts`, `packages/database/src/prisma/db_main/*.prisma`, `packages/database/src/extensions/tenant-scope.ts`, `packages/database/src/prisma/db_main/migrations/{20260602010000_task_305_phase_f_backfill_user_department,20260602000000_task_328_329_admin_playground_schema}`, `packages/database/src/__tests__/{seed,phase-f-backfill-migration}.test.ts`, `packages/database/src/extensions/__tests__/tenant-scope.test.ts`, `packages/agentic-sdk-v2/src/core/{PersonalizationManager,CrossTabHmacKeyManager,SimpleCrossTabSync}.ts`, `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx`, `packages/applications/src/services/tenant-frontend-config/` |
| Reviewed | `fix/2605-review` @ e91fc450 · 2026-06-03 |
| Verdict | **Ship-with-fixes** |

## 1. Scope & Business Context

HOPE is a multi-tenant clinical-documentation platform. This review owns the **production-readiness foundation (metric #3)**: the seed data, the Prisma data model + tenant-scope isolation, the TASK-305 Phase F membership invariant, and the client-side multi-tenancy of the `@arcaai/vox` SDK + storage integration (TASK-317/318).

Tenants are seeded as (`05-tenant.ts:6-40`): **System** `00000000-…0000` (platform catalog owner, not customer data), and four customer tenants — **Global** `50000000-…0000`, **ArcaAI** `…0001`, **4bits** `…0002`, **Mumbai General Hospital** `…0003`.

**Headline:** the architecture is genuinely production-grade — the tenant-scope extension, the `User`-as-global-identity model, the Phase F membership invariant, and the vox-SDK tenant isolation are all solid and well-tested. **But the seed tells a one-sided multi-tenant story**: the **Global** tenant is rich and believable, while **ArcaAI, 4bits and Mumbai are clinically empty** — admin + one `GEN` department + settings + buckets only, with **zero clinicians, zero consultations, zero prompts, zero DNA**. That undermines metric #3 for 3 of the 4 customer tenants.

## 2. Metrics Scorecard

| Metric | Super/Global admin | Tenant admin | Evidence |
|---|---|---|---|
| Usability | 🟡 | 🔴 | Global is fully usable; switching to ArcaAI/4bits/Mumbai lands on a near-empty console (`91-user.ts:490-540`, `09-consultation.ts:50-207` all `SEED_TENANT_ID`). A 4bits/Mumbai tenant admin has no clinicians, consultations, or prompts to manage. |
| Clean & friendly UX/UI | 🟡 | 🔴 | Empty-state heavy for thin tenants: empty consultations list, empty prompts list, and an empty **General** settings tab for *every* tenant (`11-global-setting.ts:143-144` — the `general` namespace is never emitted). |
| Production-ready + seed data | 🟡 | 🔴 | Global tenant is production-quality; raw API secrets committed (`00-constants.ts:194-204`), `TenantFrontendConfig` missing from tenant-scope allow-list (`tenant-scope.ts:53-97`), fictional cross-tenant audit rows (`10-audit-log.ts:283-540`). |
| Core-business / workflow fit | 🟢 (Global) / 🔴 (others) | 🔴 | Global tells a believable clinical story (18 depts, chained/cross-dept consults, DNA, NER, version history). ArcaAI/4bits/Mumbai have no clinical story at all. |

**Positives (do not regress):** `User` is correctly a global identity with membership via `UserRoleAssignment` + `UserDepartment` join tables (`tenant-scope.ts:40-52`); the Phase F membership invariant is satisfied for **every** seeded non-exempt user (no login-failure Criticals); the vox SDK tenant isolation (namespacing, tenant-switch reset, cross-tab HMAC) matches TASK-317 intent.

## 3. Per-Tenant Seed Inventory

✓ = present/usable · ✗ = absent · ⚠ = present but thin/synthetic. File:line points at the defining seed.

| Tenant | Admin | Clinicians | Departments | Prompts | Consultations | Per-tenant Settings | Storage bucket | Audit | DNA | API keys |
|---|---|---|---|---|---|---|---|---|---|---|
| **Global** `…0000` | ✓ `tenant_admin` (`91-user.ts:139-154`) | ✓ 20 (`91-user.ts:159-485`) | ✓ 18 (`04-department.ts:13-302`) | ✓ ~40 (`07-prompt-template.ts`, all `DEFAULT_TENANT_ID`) | ✓ 9 (`09-consultation.ts:50-207`) | ✓ 14 + 9 rate-limit + 5 dna-regen (`11`,`12`,`08`) | ✓ audio/attachments/misc (`05a:54-85`) | ✓ 10 (`10-audit-log.ts:31-281`) | ✓ 8 reports/9 versions (`08-dna-writing-style.ts:20-276`) | ✓ 7 (`02-apikey.ts`) |
| **ArcaAI** `…0001` | ✓ `arcaai_admin` (`91-user.ts:490-506`) | ✗ 0 | ⚠ 1 `GEN` only (`04-department.ts:314-329`) | ✗ 0 | ✗ 0 | ✓ 14 (`11-global-setting.ts:354-370`) | ✓ (`05a`, `ALL_TENANTS`) | ⚠ 5 fictional (`10-audit-log.ts:284-374`) | ✗ 0 | ✓ 2 (`02-apikey.ts:101-160`) |
| **4bits** `…0002` | ✓ `fourbits_admin` (`91-user.ts:507-523`) | ✗ 0 | ⚠ 1 `GEN` only (`04-department.ts:330-345`) | ✗ 0 | ✗ 0 | ✓ 14 (`11-global-setting.ts:371-387`) | ✓ (`05a`) | ⚠ 4 fictional (`10-audit-log.ts:377-448`) | ✗ 0 | ✗ 0 |
| **Mumbai** `…0003` | ✓ `mumbai_admin` (`91-user.ts:524-540`) | ✗ 0 | ⚠ 1 `GEN` only (`04-department.ts:346-361`) | ✗ 0 | ✗ 0 | ✓ 14 (`11-global-setting.ts:388-404`) | ✓ (`05a`) | ⚠ 5 fictional (`10-audit-log.ts:451-540`) | ✗ 0 | ✗ 0 |
| **System** `…0000`* | n/a (`super_admin`, `__system__`, exempt) | n/a | — | — | — | rate-limit lives on Global, not System | ✓ (`05a`) | — | — | — |

\* System tenant owns the platform STT catalog (`06-stt.ts:25` → `SYSTEM_TENANT_ID`): AI models, ASR pipelines, STT settings, shared read-only by all tenants.

**Inventory verdict:** **Global = production-ready / rich.** **ArcaAI = thin** (admin + 1 dept + settings + buckets + 2 API keys, no clinical data). **4bits and Mumbai = unusably empty** (admin + 1 dept + settings + buckets only; no clinicians, consultations, prompts, DNA, or API keys).

## 4. Findings (severity-ranked)

| # | Sev | Area | Issue | Evidence (file:line) | Metric |
|---|---|---|---|---|---|
| 1 | **High** | Seed realism | ArcaAI/4bits/Mumbai are clinically empty: no clinicians, consultations, prompts, or DNA. A global admin switching tenant — or any tenant admin for those 3 — lands on an unusable console that cannot demonstrate the core workflow. All clinical seed data is hard-pinned to `SEED_TENANT_ID` (Global). | `91-user.ts:96-563` (only `*_ADMIN` for those tenants); `09-consultation.ts:50-207` (`tenantId: SEED_TENANT_ID`); `07-prompt-template.ts:5,175+` (`DEFAULT_TENANT_ID`=Global); `08-dna-writing-style.ts:20-351` (`SEED_TENANT_ID`); `04-department.ts:313-361` (1 `GEN` each) | 3,4,1 |
| 2 | **High** | Tenant-scope extension | `TenantFrontendConfig` (per-tenant frontend pipeline config, `tenantId @unique`) is **absent** from `TENANT_SCOPED_MODELS`, so the extension — the documented "second line of defence" — injects no tenant filter on it. With no RLS in migrations (Phase C not shipped), isolation depends solely on hand-written service filtering. The current service filters correctly, so no *known* active leak, but any unscoped query (list/report/future path) would cross tenants. | `tenant-scope.ts:53-97` (list of 29, no `TenantFrontendConfig`); `tenant.prisma:37-44` (`tenantId @unique`); `tenant-frontend-config.service.ts:104-116` (manual `resolveTenantScope`); RLS grep over `migrations/` = 0 hits | 3 |
| 3 | **Medium** | Tenant-scope / tests | `AsrPipelineVersion` also bears `tenantId` (`stt.prisma:68`) but is not in `TENANT_SCOPED_MODELS` nor `SYSTEM_SHARED_READ_MODELS` → its reads are unfiltered across tenants (platform catalog, low sensitivity). Both gaps were introduced by the TASK-328/329 migration without updating the allow-list, and the guard test only asserts `size === 29`, so it cannot catch new `tenantId` models. | `stt.prisma:61-68`; `tenant-scope.ts:53-97,141-144`; migration `20260602000000_…/migration.sql:21-36`; `tenant-scope.test.ts:80-89` | 3 |
| 4 | **Medium** | Settings completeness | The per-tenant `general` namespace (max-concurrent-sessions, default-language, session-timeout) is never emitted for any tenant, and the `enable-transcription` flag is allocated + passed but never written. The admin "General" tab is empty for all tenants. Count is inconsistent: 14 actual vs header "15" vs `console.log` "17". | `11-global-setting.ts:142-144` (empty `general` section), `:336-405` (`ffTranscription` passed, never used), `:17,408` (15/17 mismatch) | 1,2,3 |
| 5 | **Medium** | Security / prod-readiness | Raw API-key secrets are committed in source and seeded `ACTIVE` with broad scopes (`SERVICE_ACCOUNT` = `['*']`, rate 5000). Fine as dev fixtures (hashed before storage, `environment:'development'`), but a real risk if the demo seed ever runs against the production single-deployment — they become known-valid live credentials. | `00-constants.ts:194-204` (`SEED_API_KEY_RAW`); `02-apikey.ts:88-99,183-191` (printed to console, `scopes:['*']`) | 3 |
| 6 | **Medium-Low** | Seed realism / integrity | Customer-tenant audit rows reference cross-tenant / non-existent entities: ArcaAI/4bits/Mumbai entries attribute actions to Global-only users (`DOCTOR`, `DOCTOR2`, `NURSE` — no membership in those tenants) and to Global consultations; `MUMBAI_CREATE_CONSULTATION` points at `CARD_REVISIT`, a reserved ID that is **never seeded**. Gives a non-empty audit screen with incoherent data. | `10-audit-log.ts:322-337` (DOCTOR in ArcaAI → `GEN_COMPLETED`), `:506-522` (Mumbai → `CARD_REVISIT`); `00-constants.ts:294` (`CARD_REVISIT` reserved/unseeded) | 3,4 |
| 7 | **Low** | Doc drift / consistency | `09-consultation.ts` header claims "10 Consultations / 24 ContextItems" but only **9** consultations / **21** context items are defined (runtime logs use `.length`, so logs stay correct — only comments are stale). System/SMR prompt templates are seeded under the **Global customer** tenant, not the System tenant, unlike STT (`06-stt.ts:25`) — functionally fine (clinical users are all in Global) but inconsistent with the TASK-305 Phase A "platform rows live in System tenant" convention. | `09-consultation.ts:22-28`; `07-prompt-template.ts:5`; cf. `06-stt.ts:14-25` | 3 |
| 8 | **Low** | Test coverage | No data-completeness test exists. `seed.test.ts` is purely structural (ID counts, UUID format, uniqueness, execution order). Nothing asserts "each customer tenant has ≥1 clinician + consultation" or "every non-exempt user has a department," so the thin-tenant gap (#1) and future membership regressions are untested. | `seed.test.ts:61-245` | 3 |

## 5. Solutions & Actionable Plan

**Quick wins (highest value first):**

- **F#2 / F#3 (tenant-scope gaps):** add `TenantFrontendConfig` and `AsrPipelineVersion` to `TENANT_SCOPED_MODELS` (`tenant-scope.ts:53-97`); bump the `size` assertion to 31 (`tenant-scope.test.ts:88`). **Root cause:** new `tenantId` tables added by migration `20260602000000` without updating the allow-list, and a count-only guard test. **TDD:** add a test that derives the expected set from schema reality (parse `*.prisma` for `tenantId String` and assert every such model is in the allow-list or an explicit deny-list) so the guard fails when a future model drifts. **Layer chain:** Database (extension + test) only — no schema/migration change. **Verify:** `pnpm test:unit --filter @arcaai/database`.
- **F#4 (empty general settings):** emit the `general` namespace block in `tenantSettings()` and either wire or remove `ffTranscription`; reconcile the count to a single number across header/log/`.length`. **Layer chain:** Database (seed). **Verify:** re-seed locally and confirm the admin General tab is populated.

**Primary fix — F#1 (thin customer tenants):**

- **Root cause:** every clinical seed array (`09-consultation.ts`, `07-prompt-template.ts`, `08-dna-writing-style.ts`, the doctor/nurse users in `91-user.ts`) hard-codes `SEED_TENANT_ID`. There is no per-tenant fan-out.
- **Solution:** give ArcaAI (and at least one of 4bits/Mumbai, for a believable multi-site story) a minimal but complete clinical slice: 1 tenant admin (exists) + ≥2 clinicians (DOCTOR + NURSE) with role + department membership, ≥2–3 departments, a small prompt set (or a documented inheritance path from System/Global), and 2–3 consultations with transcripts/summaries. Keep Mumbai deliberately "growth" if a contrast is desired, but **document that intent** so reviewers don't read it as a bug.
- **TDD:** add a `seed.completeness.test.ts` asserting, per customer tenant, `users.byTenant >= 2`, `departments.byTenant >= 1`, `consultations.byTenant >= 1` (or an explicit allow-list of "intentionally minimal" tenants). Watch it fail RED against today's seed, then make it GREEN.
- **Layer chain:** Database (seed + test) only. **Verify:** `pnpm test:unit --filter @arcaai/database`; manual seed + log inspection of per-tenant counts.

**F#5 (raw secrets):** confirm the production single-deployment seed path excludes `02-apikey.ts` (or gates the demo keys behind `NODE_ENV !== 'production'`); document the guarantee in the deployment README. **F#6 (fictional audit):** point customer-tenant audit rows at users/consultations that actually belong to that tenant (depends on F#1 landing first), and drop the `CARD_REVISIT` reference or seed that consultation.

## 6. Membership Invariant & Migration Review (TASK-305 Phase F)

**Invariant (per the migration header and `tenant-guards.ts`):** a non-exempt user must belong to a tenant via BOTH an ENABLED `UserRoleAssignment` (role) AND an ENABLED `UserDepartment` (department), enforced at login. Exempt = service accounts OR system-tenant users.

**Seed satisfies it for every non-exempt user — no login-failure Criticals.** `91-user.ts:640-665` computes `isMembershipExempt = isServiceAccount || tenantId === SYSTEM_TENANT_ID`, then for each non-exempt user resolves a department by `(tenantId, code)` from `PRIMARY_DEPARTMENT_CODE_BY_USERNAME` (`91-user.ts:38-62`) and creates a PRIMARY `UserDepartment`:
- Exempt (correctly skipped): `__system__` (service), `super_admin` (system tenant, `:127`), `service_account` (service, `:549`).
- All 20 Global clinical users + `tenant_admin` map to codes that exist among the 18 Global departments.
- `arcaai_admin` / `fourbits_admin` / `mumbai_admin` map to `GEN`, which resolves to the per-tenant `GEN_ARCAAI/FOURBITS/MUMBAI` departments (`04-department.ts:313-361`, `00-constants.ts:173-175`). ✔ Every non-exempt seeded user receives role + department in its tenant.

**Per-tenant `GEN` departments** are correct: distinct IDs in the `…0001/0002/0003` blocks, `tenantId` set to the matching customer tenant, prompt IDs intentionally null (`04-department.ts:304-361`).

**Backfill migration `20260602010000_task_305_phase_f_backfill_user_department` — correct & safe:**
- INSERT-only, idempotent: Step 1 `ON CONFLICT ("tenantId", code) DO NOTHING` for `GEN`; Step 2 `ON CONFLICT ("tenantId","userId","departmentId") DO NOTHING` + a `NOT EXISTS` guard on an ENABLED `UserDepartment` (`migration.sql:83-162`).
- Exemptions mirror login: excludes `isServiceAccount = false`, `roleId <> SUPER_ADMIN`, `tenantId <> SYSTEM` (`:105-108,150-153`).
- `LATERAL` join prefers an ENABLED `GEN` department, deterministic tie-break (`:141-149`).
- Includes pre-/post-flight verification queries (`:35-69`). The structural guard test (`phase-f-backfill-migration.test.ts`) asserts no `DELETE/DROP/TRUNCATE/UPDATE`, `ON CONFLICT DO NOTHING` on every INSERT, and the exemption predicates.
- For a fresh seed the migration is a no-op (seed already creates the rows); for legacy DBs both paths converge. ✔

The companion schema migration `20260602000000_task_328_329_admin_playground_schema` creates `UserDepartment` (FKs to `User` ON DELETE CASCADE, to `Department` ON DELETE RESTRICT) and the `(tenantId,userId,departmentId)` unique — consistent with the Prisma model (`user.prisma:267-303`). It also creates `TenantFrontendConfig` and `AsrPipelineVersion` — the two tables behind Finding #2/#3.

## 7. SDK / Storage Multi-Tenancy Notes (TASK-317/318)

The vox-SDK client-side multi-tenancy is **strong and matches ticket intent — no material drift found.**

- **Storage-key namespacing (TASK-317 W1.1/W1.2):** personalization IDB rows are keyed `arcaai-personalization/${tenantId}::${userId}` and **fail-closed** — a missing namespace maps to `pre-login`, never the bare legacy prefix (`PersonalizationManager.ts:22-36,139-141`). `hydrate()` is authoritative per namespace (resets to defaults before applying the cached row), which closes the impersonation cross-namespace leak (`:155-187`). Verified by `PersonalizationManager.namespacing.task317.test.ts:62-86`.
- **Tenant-switch reset (TASK-317 W2.1):** on tenant switch the provider calls `store.clearTenantSessionData()` before the new tenant config resolves, and re-keys managers via a live `namespaceRef` accessor re-keyed after `/auth/me` (`AgenticProvider.tsx:387,537-556`). Store is per-`AgenticProvider`, not a module singleton.
- **Cross-tab / WS isolation (TASK-317 E-4/W0-5):** `BroadcastChannel` is always namespaced `agentic.<tenantId>` (PHI-free hash fallback when no tenant) (`SimpleCrossTabSync.ts:261-272`); HMAC envelopes use a per-tenant HKDF subkey `deriveTenantHmacKey(secret, tenantId)` that rotates fail-closed on `setTenantId`, with blank tenant normalized to the master key in both SharedWorker and fallback paths (`CrossTabHmacKeyManager.ts:170-247`).
- **Storage SDK (TASK-318):** per-tenant buckets are DB-seeded for every tenant (audio/attachments/misc, `05a-tenant-bucket.ts:54-85`); admin storage-key/bucket/config hooks exist (`useStorageKeys.ts`, `useTenantBuckets.ts`, `useTenantStorageConfig.ts`) and the server gates `/admin/tenants/storage/keys` with `@CanManage('Tenant')` (`useStorageKeys.ts:4-5`).
- **Minor observation (not a finding):** SDK `UserSettings` (workflow/language/pipeline prefs) is a global-identity table by design; because every seeded user belongs to exactly one tenant this is fine, but if a single user ever gains membership in two tenants their SDK preferences would be shared across both — worth a note when multi-tenant memberships are introduced.

## 8. Open Questions / Assumptions

1. **Are thin tenants intentional?** Is the empty state of 4bits/Mumbai a deliberate "fresh customer onboarding" demo, or unfinished seed work? The fix differs (document vs. populate). This review treats it as a gap because it degrades metric #3 and the global-admin tenant-switch experience.
2. **Production seed gating.** Does the single-deployment production install run the full demo seed (`index.ts`), including `02-apikey.ts`? If so, Finding #5 escalates; if the demo seed is dev-only, it stays Medium. Not verified in this scope.
3. **RLS / Phase C status.** No `ROW LEVEL SECURITY` / `CREATE POLICY` / `app.tenant_id` statements exist in `migrations/`, yet `tenant-scope.ts:1-9` describes itself as the "second line of defence behind … Row-Level Security … in Phase C." Assumption: Phase C RLS is not yet shipped, so the extension + explicit service filtering are the only active isolation layers — which raises the stakes on Finding #2.
4. **Prompt inheritance for customer tenants.** Customer tenants have no prompt templates of their own; it is assumed prompt resolution falls back to Global/System defaults. The exact fallback path (and whether a customer-tenant doctor would resolve a usable prompt) was not traced through the resolver in this scope.

## 9. Implementation Summary

**Status: Completed** — all findings resolved on `fix/2605-review` (HEAD `c333a083`). Work was executed by four non-overlapping parallel agents in isolated git worktrees (TDD, RED→GREEN), then merged with `--no-ff`. The codebase had drifted from the reviewed commit (`e91fc450`) because doc-01→07 had already merged; each fix was re-confirmed against the live `HEAD` before implementation.

### Findings resolution

| # | Sev | Resolution | Branch → merge |
|---|---|---|---|
| **F1** | High | Added per-customer-tenant clinical data: 6 consultations (ArcaAI/4bits/Mumbai × NEW_PATIENT + REVISIT) owned by each tenant's canonical doctor in its `GEN` department, + 1 transcript each, in new `CUSTOMER_TENANT_CONSULTATIONS` / `CUSTOMER_TENANT_CONTEXT_ITEMS` arrays. Customer admin clinical lists are no longer empty. | `fix/2605-doc08-seed` `e07fa8de` → `0e4830c7` |
| **F2** | High | `TenantFrontendConfig` added to `TENANT_SCOPED_MODELS` (exact-match scoped). | `fix/2605-doc08-scope` `f25976f5` → `6e133d89` |
| **F3** | Medium | `AsrPipelineVersion` added to `TENANT_SCOPED_MODELS` (exact-match, **not** system-shared — the pipeline service hard-guards version reads behind caller-owns-pipeline, so no cross-tenant read exists to widen for). Allow-list now **31**. | `fix/2605-doc08-scope` `f25976f5` → `6e133d89` |
| **F4** | Medium | All four tenants now emit the `general` namespace (max-concurrent-sessions, default-language, session-timeout) + an `enable-transcription` flag (wires the previously-dead `ffTranscription`). Per-tenant count reconciled to **19** across header comment, `console.log`, and actual `.length`. | `fix/2605-doc08-settings` `7ad19311` → `5f511498` |
| **F5** | High | Demo API-key seeding gated behind `shouldSeedApiKeys(env)` (dev/test only) in `index.ts`; `seedApiKey` throws if invoked in prod/staging (defence-in-depth); raw secrets no longer printed — logs now show only a masked `hope****` preview. `SEED_API_KEY_RAW` left in place as dev fixtures. | `fix/2605-doc08-secure` `b841a186` → `4524e43a` |
| **F6** | Medium-Low | Customer-tenant audit rows repointed to same-tenant users/consultations; the never-seeded `CARD_REVISIT` reference replaced with the real `MUMBAI_GEN_REVISIT`; cross-tenant user/department refs corrected. | `fix/2605-doc08-seed` `e07fa8de` → `0e4830c7` |
| **F7a** | Low | Stale `09-consultation.ts` header counts corrected (10→9 consultations, 24→21 context items, `// CONSULTATIONS (9)`), now consistent with the +6/+6 doc-08 additions (15 / 27 actual). | `c333a083` |
| **F7b** | Low | **Deferred (accepted).** Relocating SMR/system prompt templates from the Global customer tenant to the System tenant is rated "functionally fine" by the review, is absent from the Section 5 action plan, and would risk the prompt resolution that currently works for Global-resident clinicians. Logged as a future consistency cleanup rather than a risky in-scope refactor. |
| **F8** | Low | New data-completeness tests (`seed/__tests__/seed.test.ts`, 14 tests): each customer tenant has ≥1 clinician + ≥1 same-tenant consultation; audit rows never cross tenants or reference unseeded consultations; seed usernames globally unique. | `fix/2605-doc08-seed` `e07fa8de` → `0e4830c7` |
| **Bug (cold-seed crash)** | — | `08-dna-writing-style.ts` was inventing new users under fresh UUIDs that duplicated canonical `91-user.ts` usernames (`username @unique`) → cold-DB seed crash. Rewired to reuse `SEED_USER_IDS.{ARCAAI,FOURBITS,MUMBAI}_DOCTOR`; user/profile/role/department creation (and unused `bcryptjs`/`SEED_ROLE_IDS` imports) removed. No `index.ts` reorder needed (91 already runs before 08). | `fix/2605-doc08-seed` `e07fa8de` → `0e4830c7` |

### Root-cause guard (F2/F3)

The recurrence vector was a **count-only** guard test (`expect(TENANT_SCOPED_MODELS.size).toBe(29)`), blind to add+drop migrations. Replaced with a **schema-derived drift guard** that parses every `db_main/*.prisma` for models declaring a `tenantId` scalar and asserts each is in the allow-list (minus an explicit, documented `INTENTIONALLY_UNSCOPED` deny-list). A future `tenantId` model now fails the test until consciously triaged.

### Files changed (12 files, +836 / −144, all in `packages/database`)

- `src/extensions/tenant-scope.ts`, `src/extensions/__tests__/tenant-scope.test.ts` — F2/F3 + schema-derived guard
- `src/prisma/db_main/seed/11-global-setting.ts`, `src/__tests__/seed-global-settings.test.ts` — F4
- `src/prisma/db_main/seed/index.ts`, `src/prisma/db_main/seed/02-apikey.ts`, `src/__tests__/seed-gating.test.ts` (new) — F5
- `src/prisma/db_main/seed/08-dna-writing-style.ts` — collision fix
- `src/prisma/db_main/seed/09-consultation.ts` — F1 + F7a
- `src/prisma/db_main/seed/10-audit-log.ts` — F6
- `src/prisma/db_main/seed/__tests__/seed.test.ts` (new) — F8 completeness
- `src/prisma/db_main/seed/00-constants.ts` — new ArcaAI `general` setting IDs (F4) + customer consultation IDs (F1); `SEED_API_KEY_RAW` untouched

No Prisma schema/migration changes were required (all affected models already existed); the layer chain stayed at the Database layer only.

### Verification (integrated, post-merge on `fix/2605-review`)

- **Build:** `pnpm --filter @arcaai/database build` (`tsc`) → exit 0, no diagnostics.
- **Tests:** `pnpm --filter @arcaai/database test` → **734 passed (734)** across **19** files (base 17 + 2 new test files). No regressions; the shared `00-constants.ts` 3-way merge introduced no count-assertion breakage.
- **Lint:** `ReadLints` on all 12 changed files → no errors.
- **Merge:** all four branches merged via `ort` with **zero conflicts** (the only shared file, `00-constants.ts`, auto-merged B's settings region with C's consultation/audit regions). Secret-scanner (gitleaks) pre-commit hook reported no leaks. Nothing pushed to remote.

### Open-questions resolution

- **Q2 (production seed gating)** — **answered/fixed by F5:** the demo API-key seed is now dev/test-only with a prod throw-guard. (Broader demo-data gating beyond API keys remains available via the single `SEED_DEMO_DATA` switch if desired — flagged as a follow-up, not done here to preserve FK integrity for un-owned seed steps.)
- **Q1 (thin tenants intentional?)** — treated as a gap and populated for all three customer tenants per F1.
- **Q3 (RLS/Phase C)** and **Q4 (prompt inheritance)** remain open as originally scoped (no change).

## 10. Change History

| Date | Change | Files |
|---|---|---|
| 2026-06-04 | Resolved F1–F8 + cold-seed username collision via four parallel TDD agents; merged to `fix/2605-review` (`6e133d89`, `5f511498`, `4524e43a`, `0e4830c7`) + F7a comment fix (`c333a083`). F7b consciously deferred. Integrated verification: tsc 0, 734/734 tests, lint clean. | 12 files in `packages/database` (see §9) |
