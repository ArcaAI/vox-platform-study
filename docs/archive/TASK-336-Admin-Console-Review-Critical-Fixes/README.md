# TASK-336 — Admin Console Review + Critical Remediation

| | |
|---|---|
| Ticket Number | TASK-336 |
| Short name | Admin-Console-Review-Critical-Fixes |
| Created | 2026-06-06 |
| Updated | 2026-06-06 |
| Status | `Review` — **49 findings delivered**; **all actioned**: 5 Criticals + High/Medium/Low remediated under TDD across 10 parallel lanes (a handful explicitly **deferred** with rationale, §8). Dev DB **reset + reseeded** (realistic 4-tenant data). Full unit suite **green (13,274 passed, 0 failed)**; changed-package lint clean. **Not committed.** |
| Type | review / audit + critical remediation (access-control, multi-tenancy, business-logic, data-model, seed) |
| Reviewed | `fix/2605-review` @ `15ee6fcb` |
| Scope | `apps/ui-playground` (admin console + playgrounds), `apps/api`, `packages/{database,domains,applications}`, `@arcaai/vox` (`packages/agentic-sdk-v2`) |
| Builds on | TASK-331 (prior admin-console review on this branch), TASK-335 (unified tenant scope), TASK-325→329 (admin-console waves), TASK-245/295 (impersonation), TASK-305 (multi-tenancy) |

> **Method.** Six parallel agents audited the *currently shipped* code: **1 live browser walkthrough** of the admin console (real login as `super_admin`, screen-by-screen, plus an end-to-end impersonation test) and **5 code-review agents** with non-overlapping ownership, each combining static `file:line` analysis with **live `curl` probes** against the running API using seeded credentials. Findings graded **Critical / High / Medium / Low**. The two headline security Criticals (AC-01, AC-02) and IC-01 were **live-verified**; remaining `file:line` citations are agent-produced and should be re-confirmed before fixing. The 5 Criticals have since been **remediated under TDD** (see §7).

> **Companion artifact.** An interactive, filterable register of all 49 findings is maintained as a Cursor canvas: `canvases/admin-console-review.canvas.tsx` (filter by severity/domain, full evidence + fix per finding).

---

## 1. Requirement Analysis

**Original request.** Review the `admin-console` — every screen, interface, and component — to confirm it works as expected (using a live browser where useful). Where behaviour is wrong or missing, compare against the exposed **admin APIs** and **end-user-facing APIs** to confirm the backend is implemented properly across:

- **Access control** — administration functions **and** impersonation.
- **Business logic** — the implemented workflows behave correctly.
- **Data model** — entities/relationships support the workflows.
- **Seed data** — realistic, sufficient for demo/impersonation across tenants.

Constraint: **services were already running and must not be stopped/started**. Deliverable: a detailed list of all issues, defects, and missing things.

**Business context.** HOPE is a multi-tenant clinical-AI platform. The admin console (`apps/ui-playground`) is the operator surface for super/global admins and tenant admins, and the launchpad for impersonating clinicians to exercise the playgrounds. Correctness here is a **security boundary** (tenant isolation, privilege tiers) and a **demo/operability** surface.

**Acceptance criteria.**
1. Every admin screen functions without errors/defects/confusion (live-checked).
2. Admin + end-user APIs enforce access control (tenant isolation, role tiers, impersonation boundaries).
3. Business logic, data model, and seed data support the intended workflows.
4. A complete, evidence-backed list of issues/defects/missing items is produced.

---

## 2. Review coverage (6 non-overlapping agents)

| Agent | Lane | Outcome |
|---|---|---|
| Browser walkthrough | All 11 admin screens + impersonation E2E (live, as `super_admin`) | 9/11 healthy; impersonation E2E verified working; Studio empty (BR-02); impersonation discoverability (IMP-05) |
| A — Access Control & Identity | Users/RBAC/Tenants/impersonation, auth guards, by-id routes | 2 Criticals **live-verified** (AC-01 IDOR, AC-02 priv-esc); impersonation boundary solid |
| B — Clinical Content | Prompt templates, DNA dashboards, departments | 1 Critical (CC-01 non-transactional OCC, **live**); publication-status, dept-create, DNA scope gaps |
| C — Infra / Config | Audio pipelines, storage keys, configs, rate-limit | 2 Criticals (IC-01 validate 404, IC-02 disabled vanish — **live**); GLOBAL pipeline seed gap |
| D — Observability | Audit, monitoring/health, admin job views, TASK-250 queues | Audit stack solid; 3 orphaned backends (monitoring, admin jobs, queue-admin); audit hygiene |
| E — End-user API plane | Consultation/transcription/voice/settings + SDK wiring | Access control sound; pagination contract break, 2 intra-tenant job-ownership gaps, seed gaps |

---

## 3. Severity scorecard

| Severity | Count | Definition |
|---|---|---|
| **Critical** | 5 | Security hole / data-integrity / blocked core workflow |
| **High** | 6 | Significant defect or missing core capability |
| **Medium** | 19 | UX/robustness/seed gaps; intra-tenant authz nuances |
| **Low / Nit** | 19 | Minor correctness, docs, dead code, hardening |
| **Total** | **49** | |

By domain (Critical · High · Medium · Low):

| Domain | C | H | M | L | Total |
|---|---|---|---|---|---|
| Access Control & Identity (A) | 2 | 2 | 2 | 5 | 11 |
| Clinical Content (B) | 1 | 0 | 4 | 3 | 8 |
| Infra / Config (C) | 2 | 1 | 2 | 3 | 8 |
| Observability (D) | 0 | 3 | 5 | 5 | 13 |
| End-user APIs (E) | 0 | 0 | 5 | 2 | 7 |
| UI / Browser | 0 | 0 | 1 | 1 | 2 |
| **Total** | **5** | **6** | **19** | **19** | **49** |

**Verdict:** **not production-ready** as-found — 2 critical security holes (cross-tenant IDOR, role-tier privilege escalation) and 3 critical broken/un-recoverable workflows (pipeline validation 404, disabled-pipeline loss, non-transactional OCC). The access-control **foundation** and **impersonation** are otherwise strong (see §9). **All 49 findings are now actioned** — 5 Criticals (§7) plus the 44 High/Medium/Low across 10 TDD lanes, with a small set of conscious deferrals (§8).

---

## 4. Cross-cutting themes

The findings converge on six roots:

- **TH1 — Tenant isolation enforced unevenly.** Scoping is applied on *list* routes but not consistently on *by-id* reads/writes, role assignment, DNA admin fan-out, or transcription-job mutations (AC-01, AC-02, CC-02, EU-01, EU-02).
- **TH2 — Core admin write paths broken.** Pipeline create/edit 404s (IC-01), disabled pipelines vanish with no re-enable (IC-02), and OCC version writes aren't transactional (CC-01).
- **TH3 — Backends with no UI (orphaned).** Monitoring/health, admin job views, the TASK-250 queue/job/scheduler layer, rate-limit config, and DNA generation exist server-side but are unreachable from the console (OB-01/02/03, IC-05, CC-05).
- **TH4 — Seed still concentrated on GLOBAL.** Customer tenants lack pipelines, transcription jobs, and per-doctor voice/SDK prefs, so impersonation demos are empty for the tenants an admin would showcase (IC-03, EU-04, EU-05).
- **TH5 — API pagination contract drift.** Admin uses `count`/`limit`; RBAC/SDK/transcription use `total`/`pageSize` — the Roles count breaks and the consultation list cannot page past page 1 (AC-04, EU-03, OB-06).
- **TH6 — Audit / compliance hygiene.** Reads self-inflate the trail, there is no retention policy, CSV export drops tenant attribution, pagination commits draft filters, and rows are soft-deletable (OB-04/05/07/08/10).

---

## 5. Findings register

Status legend: **Fixed** (remediated this ticket — Criticals §7, High/Medium/Low §8) · **Deferred** (consciously not done this pass; rationale in §8.4). Evidence marked *(live)* was reproduced against the running API/UI; others are static `file:line` (re-confirmed during remediation). **All 49 findings are now actioned** (Fixed or Deferred).

### 5.1 Critical (5) — all Fixed

#### AC-01 — Cross-tenant User IDOR on by-id routes · *Access Control* · **Fixed**
- **Evidence (live):** `arcaai_admin` (TENANT_ADMIN) → `GET /api/v1/admin/users/<mumbai-tenant doctor id>` → **200**. By-id handlers in `apps/api/src/modules/user/user.controller.ts` (`fetchById`, `update`, `updateStatus`, `delete`, `bulkDelete`, `fetchUserSettings`) skipped scope checks; `User` is intentionally not tenant-scoped at the Prisma layer.
- **Problem:** A tenant admin can read/mutate/soft-delete users in other tenants by UUID. The list route (`fetchByTenant`) was hardened previously; the by-id routes were not.
- **Expected vs actual:** Expected 404/403 outside the caller's tenant (SUPER_ADMIN exempt); actual 200.
- **Fix:** added private `assertUserInScope(id)` resolving the target's active tenants via `UserRoleAssignment.findActiveTenantIdsForUser`, throwing 404 outside scope; applied to all by-id/profile/settings/sub-resource routes; `bulkDelete` validates every id. Relates to TASK-331 **C2** (partial fix → now closed).

#### AC-02 — Privilege escalation via role assignment · *Access Control* · **Fixed**
- **Evidence (live):** `arcaai_admin` → `POST /api/v1/admin/users/:id/roles` returned **400 validation** (i.e. it *passed* authorization, not 403). No role-tier check; login resolves roles cross-tenant.
- **Problem:** A TENANT_ADMIN could assign the **SUPER_ADMIN** role (and potentially assign roles to users in other tenants).
- **Expected vs actual:** Expected non-super-admins blocked from granting elevated/foreign roles; actual allowed.
- **Fix:** `assignRole` now carries `@CanManage('UserRoleAssignment')` (overrides inherited `manage:User`); `userRoleAssignment.service.create` enforces a tier guard — a non-SUPER_ADMIN caller cannot grant SUPER_ADMIN nor assign roles to a user outside their tenant (new-user onboarding preserved).

#### IC-01 — Pipeline YAML validation 404 blocks create + edit · *Infra/Config* · **Fixed**
- **Evidence (live):** FE posts `/admin/audio/pipelines/validate-yaml` → **404**; real route is `/admin/audio/pipelines/validate` → 201/401. Both create and edit `await` validation first.
- **Problem:** Every pipeline create/edit attempt fails at the validation step.
- **Fix:** corrected the path in `apps/ui-playground/src/features/admin/api/audio-pipelines.ts` to `/validate` (route name confirmed by controller metadata + a route-lock test + live curl).

#### IC-02 — Disabled pipelines vanish, cannot be re-enabled · *Infra/Config* · **Fixed**
- **Evidence:** admin list shared the ENABLED-only `getAll()` → `findEnabledPipelines` (`pipeline.service.ts`); the UI disable toggle then refetches, dropping the row.
- **Problem:** Disabling a pipeline is effectively one-way through the UI.
- **Fix:** added `getAllForAdmin()` (→ repo `findAllForAdmin`, ENABLED+DISABLED, excludes soft-deleted); pointed only the **admin** controller list route at it. Public/end-user listing stays enabled-only; FE response shape unchanged.

#### CC-01 — Non-transactional OCC writes (orphan rows; prompts can brick) · *Business-Logic/Data-Model* · **Fixed**
- **Evidence (live):** a DNA update with stale `If-Match` returned **412** yet a `versionNumber 2` history row persisted (orphan). Prompt next-version was `current+1` with no `max()` guard.
- **Problem:** rejected OCC writes still commit a version row; prompt version collisions can hit the unique constraint and permanently block further edits.
- **Fix:** wrapped the version-row insert + compare-and-set in one `prisma.$transaction` for both prompt and DNA paths (conflict throws inside the tx → full rollback, no orphan); prompt next-version is now `max(existing)+1` via a tx-aware `PromptVersionRepository.findMaxVersionNumber`. HTTP semantics (412) unchanged. Relates to TASK-331 **C3** (the If-Match guard existed; transactionality did not).

### 5.2 High (6) — all Fixed (1 partial/deferred: OB-03 cross-tenant transfer) · see §8

| ID | Domain | Issue | Evidence | Suggested fix |
|---|---|---|---|---|
| **AC-03** | Access Control | RBAC admin screens **403 for TENANT_ADMIN** (decorator↔policy drift) | *(live)* `arcaai_admin` → `/admin/rbac/roles` 403, `/policies` 403; policy seed grants decomposed create/read/update/delete, not the `manage` alias the controllers require | Reconcile: use `@CanAny` over decomposed actions, or grant `manage:Role`/`manage:Policy` in the seed |
| **AC-04** | Access Control / API | Roles pagination envelope mismatch | `features/admin/api/roles.ts` types `{count,limit}` but RBAC returns `{total,pageSize}` → count undefined, page size stuck | Give RBAC a typed envelope, or normalize to admin `count/limit` |
| **IC-03** | Infra / Seed | GLOBAL tenant has **no ASR pipelines**; SYSTEM not shared-read | *(live)* GLOBAL count 0, ARCAAI 2, SYSTEM 10; public list for GLOBAL doctor `[]`; `seed/06-stt.ts` seeds customer tenants only | Seed a GLOBAL default pipeline, or decide SYSTEM shared-read (TASK-331 T3/H6 residue) |
| **OB-01** | Observability | Monitoring + deep-health endpoints not surfaced | *(live)* `/monitoring/uptime|sessions`, `/health/services` return data; no console screen/nav/hook | Add a read-only System Health screen (global scope) |
| **OB-02** | Observability | Admin job-observability controllers orphaned | *(live)* `/admin/consultations`, `/admin/audio/transcription-jobs(+/stats)` return paginated data; no FE usage | Surface tenant-wide lists; feed `transcription-jobs/stats` into Overview KPIs |
| **OB-03** | Observability / API | TASK-250 queue/job/scheduler layer has no controller or UI | `queue-admin/*` referenced only in `packages/applications` + tests; TASK-250 still Pending | Wire guarded `/admin/queues|jobs|schedulers` controllers + UI, or formally defer TASK-250 |

### 5.3 Medium (19) — Fixed / Deferred · see §8

| ID | Domain | Issue | Evidence | Suggested fix |
|---|---|---|---|---|
| **AC-05** | Access Control | `secret1`/`secret2` returned in `UserResponse` + mass-assignable | `applications/.../user/user.response.ts:21-31`; seed leaves them null | Drop/mask in response DTO; remove from create/update inputs |
| **AC-06** | Access Control | `isSuperAdmin` ignores `GLOBAL_ADMIN`; role unseeded | `apps/api/.../tenant-guards.ts` | One source of truth for the elevated set; seed `GLOBAL_ADMIN` or remove (TASK-331 T2) |
| **CC-02** | Clinical / API | DNA admin list ignores `X-Tenant-Id` for SUPER_ADMIN | *(live)* super-admin + header ARCAAI, no `?tenantId` → count 11 (all tenants) | Honor active tenant header, or require explicit `tenantId` |
| **CC-03** | Clinical | Publication status DRAFT/PUBLISHED not enforced on clinician path | `prompt-management.service.ts:426`; all seeds DRAFT | Filter clinician resolution to PUBLISHED (safe fallback); seed a PUBLISHED baseline |
| **CC-04** | Clinical / UI | Department create drops `defaultSummaryTemplate` | `ui-playground/.../departments/index.tsx:803` | Include the field in the create modal + payload |
| **CC-05** | Clinical / UI | DNA admin has no Generate affordance; backend generate unreachable | DNA admin screen vs generate endpoint | Add a Generate action (or defer if out of scope) |
| **IC-04** | Infra / API | Pipeline `assign-tenant` endpoint is a no-op stub | `audio-pipeline.controller.ts:155` returns success without persisting | Implement, or remove until real |
| **IC-05** | Infra / UI | Rate-limit admin API exists but has no console surface | `rate-limit-admin.controller.ts`; no FE consumer | Add a Rate Limits panel (global scope) or document API-only |
| **OB-04** | Observability | Admin reads inflate the audit trail (self-audit) | *(live)* count 129→196 over a GET-only session; `auditLog.service.ts:147,177` emit `ResourceViewed` | Exclude READ by default; don't audit reads of the audit log |
| **OB-05** | Data-Model | No retention/partitioning on `AuditLog` | `packages/database/.../audit` | Add partitioning + retention/archival (with OB-04, growth is unbounded) |
| **OB-06** | API | Pagination envelope inconsistency across admin observability | mixed `count/limit` vs `total/pageSize` | Standardize one envelope; centralize the normalizer |
| **OB-07** | Observability | Audit CSV export omits Tenant column in cross-tenant view | `auditLog.dto.mapper.ts:10-23` | Add a Tenant column when export is global |
| **OB-08** | Observability / UI | Audit filter draft leaks into pagination requests | `audit-logs/index.tsx:136-150` | Build request params from committed filter only |
| **EU-01** | End-user / Access | Transcription-job `cancel`/`retry` lack `scope:'creator'` | `transcription-job.controller.ts:461-475`; service tenant-scoped only | Add `scope:'creator'` (mirror consultation-job cancel) |
| **EU-02** | End-user / Access | `GET transcription-jobs/consultation/:id` no resource/access check | `transcription-job.controller.ts:293-298`; service filters by tenant only | Restrict to `createdBy`, or verify consultation access |
| **EU-03** | End-user / API | Consultation list `count` vs `total` breaks pagination past page 1 | *(live)* API returns `{count}`; SDK `useArca.ts:59-63,443` expects `total` | Normalize in `listConsultations` (map `count`→`total`) |
| **EU-04** | Seed | No transcription-job seed — Audio/Transcription playground empty | *(live)* `/audio/transcription-jobs` empty; no seed rows | Seed jobs per status for GLOBAL + a customer tenant |
| **EU-05** | Seed | Voice profiles + SDK prefs seeded only for GLOBAL doctors | `seed/91-user.ts:727-755,1006-1166`; customer consultations owned by ARCAAI/4BITS/MUMBAI doctors | Extend voice + `arcaai-sdk` prefs to customer-tenant doctors (TASK-331 H5/H6 residue) |
| **BR-02** | UI / Observability | Prisma Studio screen shows "No tables found" | *(live)* `/admin/studio` loads, schema `public`, empty table list | Investigate studio-core introspection + the loader (see OB-11) |

### 5.4 Low / Nit (19) — Fixed / Deferred · see §8

| ID | Domain | Issue | Evidence / Fix |
|---|---|---|---|
| **AC-07** | Access Control | Super-admin `/admin/users` ignores `X-Tenant-Id` (returns all) | *(live)* count 32 regardless of header → honor header or document |
| **AC-08** | Access / Docs | Swagger says admins can't be impersonated, but SUPER_ADMIN can impersonate TENANT_ADMIN | Fix the doc or enforce the restriction |
| **AC-09** | Impersonation / UX | FE silently ends impersonation on 401 and retries as admin | `admin-client.ts:98-106` → surface an explicit notice |
| **AC-10** | Access Control | Tenant config read/update lack explicit scope guard + input whitelist | `tenant.controller.ts` → add guard + updatable-key allow-list |
| **AC-11** | Impersonation / Audit | Impersonation reuses `UserAuthenticated`, success-only | Use a dedicated `ImpersonationStarted/Ended` event; record denials |
| **CC-06** | API | Prompt vs DNA OCC DTO asymmetry (`expectedVersion` required vs optional) | Align the OCC contract |
| **CC-07** | UI / Data-Model | Dead `PRE_SUMMARY` prompt category in FE | Remove (or implement) |
| **CC-08** | UI / API | `useAssignDepartmentPrompt` dead code with incompatible payload | Remove or fix + wire |
| **IC-06** | UI | Access-keys panel labels the masked `accessKeyId` as "secret" | Relabel "Access Key ID (masked)"; secret stays write-only |
| **IC-07** | UI | Configurations screen lacks add/remove + platform/global settings | Add create/remove + a platform-settings section |
| **OB-09** | Maintainability | Dead code + dual audit APIs in `audit-logs.ts` | Collapse to one client |
| **OB-10** | Security / Business | Audit logs are soft-deletable (immutability concern) | Remove delete route or restrict to an audited retention process |
| **OB-11** | Security / Maintainability | Prisma Studio backend loads core from CDN with JWT inlined | `pstudio.html.ts` → self-host; don't inline JWT (contributes to BR-02) |
| **OB-12** | Access Control | Monitoring + `/health/services` are any-authenticated | *(live)* plain doctor can read → admin-gate |
| **OB-13** | API | Monitoring sessions only cover tts/smr | Extend to stt/nlp |
| **EU-06** | End-user / Access | `POST /consultations/open` has no role gate — a read-only NURSE can create | `consultation.controller.ts:117,288-296` bare `@Authorize()` → add `@Authorize(['create','Consultation'])` |
| **EU-07** | End-user / Business | Transcription-job create endpoints accept `@Body() dto: any` | `transcription-job.controller.ts:125-147` → typed DTOs; assert consultation/media ownership |
| **IMP-05** | UI / Impersonation | Impersonation not discoverable from the Admin Overview | Entry point lives on Playground Overview; add a CTA/link from Admin Overview |
| **IC-08** *(suggestion)* | Infra / API | FE ignores the paginated pipelines endpoint | Adopt pagination with page controls (scale) |

---

## 6. Relationship to the prior TASK-331 review

| TASK-331 item | Status now |
|---|---|
| **C1** super-admin act-as-tenant (`x-tenant-id` elevation) | **Fixed** — super-admin tenant scoping works live (`resolve-active-tenant` interceptor verified). |
| **C2** user IDOR (`fetchByTenant`) | **Was partial → now closed** — list route was guarded; the by-id routes still leaked (**AC-01**) and are fixed in this ticket. |
| **C3** DNA admin edit 428 (`If-Match`) | **Fixed earlier, hardened here** — the OCC guard existed; it was not transactional (**CC-01**, fixed). |
| **C4** frontend-pipeline broken for global scope | **Fixed** — the Frontend Pipeline tab renders for Global. |
| **T2** `GLOBAL_ADMIN` half-wired | **Still latent** (**AC-06**) — role unseeded; server `isSuperAdmin` ignores it. |
| **T3** seed concentrated on GLOBAL | **Improved, gaps remain** (**IC-03**, **EU-04**, **EU-05**). |
| **Focus B** impersonate → playgrounds | **Works end-to-end** (live browser verified); only a discoverability gap (**IMP-05**). |

## 7. Critical remediation — implementation summary

All 5 Criticals were fixed by 3 parallel agents under **strict TDD** (failing test first → minimal fix → green), with non-overlapping file ownership and the running services untouched. **Nothing was committed or pushed**; the working tree is left changed for review.

### 7.1 Files changed

| Fix | Files (production) | Tests |
|---|---|---|
| AC-01, AC-02 | `apps/api/src/modules/user/user.controller.ts`; `packages/applications/src/services/user/userRoleAssignment/userRoleAssignment.service.ts` | `user.controller.test.ts` (+9), `userRoleAssignment.service.test.ts` (+5) |
| CC-01 | `packages/applications/src/services/prompt-management/prompt-management.service.ts`; `packages/applications/src/services/dna-writing-style/dna-writing-style.service.ts`; `packages/domains/src/repositories/generated/core/PromptVersionRepository.ts` | prompt + DNA service tests (+4), `PromptVersionRepository.test.ts` (+1) |
| IC-01, IC-02 | `apps/ui-playground/src/features/admin/api/audio-pipelines.ts`; `packages/applications/src/services/stt/pipeline/{IPipelineService,pipeline.service}.ts`; `apps/api/src/modules/pipeline/audio-pipeline.controller.ts` | `audio-pipelines.test.ts` (+4), `pipeline.service.test.ts`, `audio-pipeline.controller.test.ts` |

### 7.2 Enforcement logic (summary)

- **AC-01** `assertUserInScope(id)`: SUPER_ADMIN → pass; no caller tenant → 404; else resolve target's ENABLED tenants and 404 if the caller's tenant isn't among them. Per-id in `bulkDelete`.
- **AC-02** controller `@CanManage('UserRoleAssignment')` (overrides class-level `manage:User`); service rejects a non-SUPER_ADMIN granting SUPER_ADMIN or assigning to a foreign-tenant user (new-user onboarding still allowed).
- **CC-01** version insert + compare-and-set run inside one `$transaction`; a 0-row CAS throws `OptimisticConcurrencyException` inside the callback → rollback (no orphan). Prompt next-version = `max(existing)+1`.
- **IC-01** path → `/validate`. **IC-02** admin list → `getAllForAdmin()` (all statuses); public stays enabled-only.

### 7.3 Verification (evidence)

- **Full monorepo unit suite** (`pnpm test:unit`, `.env.test`): **642 test files passed | 2 skipped**, **13,166 tests passed | 4 skipped | 9 todo** (~28s). The 4 skips are Vault integration tests.
- Per-agent red→green: AC controller 60/60, AC service 39/39 (+137/137 user-module regression); CC 178 applications + 3 domains; FE 4/4, pipeline service 31/31, audio-pipeline controller 22/22.
- **Lint:** zero errors on all changed production files (`ReadLints`).

### 7.4 Deviations / caveats

- **Not yet "live."** `dev:api` watches only `apps/api`, so the **service-layer** changes (AC-02 guard, CC-01) are code-complete and unit-verified but won't be active in the running server until `@arcaai/domains` + `@arcaai/applications` are rebuilt and the API reloads. Not triggered, per the no-stop/start constraint.
- **Stale-`dist` `tsc` note:** a `@arcaai/applications` typecheck reports `findMaxVersionNumber` missing — a stale built `.d.ts` artifact (`@arcaai/domains` source typechecks clean). A normal `@arcaai/domains` build clears it; deliberately not rebuilt to avoid disturbing the running server.
- **IC-02 approach:** chose a backend `getAllForAdmin()` over repointing the FE at the paginated `/admin/audio/pipelines/list` (different envelope, truncation risk) — same admin behaviour, zero FE pagination/shape risk.

---

## 8. Full remediation — High / Medium / Low + data reset

After the 5 Criticals (§7), the **remaining 44 findings** were remediated in a second pass by **10 parallel lanes** (A–I + a dedicated Seed lane) with **non-overlapping file ownership**, each under **strict TDD** (RED → GREEN → refactor), services left running, **nothing committed**. Shared surfaces (seed files, `admin-nav-items`, `app.module`) had a single declared owner to avoid collisions.

### 8.1 Per-lane outcomes

| Lane | Findings | Status | Key production changes | Scoped tests |
|---|---|---|---|---|
| **A — Access Control & Identity** | AC-03, AC-04, AC-05, AC-06, AC-07, AC-08, AC-09, AC-10, AC-11 | **Fixed** | RBAC list/read via `@CanAny(['read',X],['manage',X])`; super-admin `fetchAll` honors `X-Tenant-Id`; tenant-config scope guard + updatable-key allow-list; dedicated `Impersonation Started/Ended/Denied` events; `secret1/2` dropped from user DTOs; `ELEVATED_ROLES=[SUPER_ADMIN,GLOBAL_ADMIN]` single source (Prisma + guard layers); FE RBAC pagination normalized; impersonation auto-end toast | api 143 · apps 91 · ui 8 |
| **B — Clinical Content** | CC-02, CC-03, CC-04, CC-05, CC-06, CC-07, CC-08 | **Fixed** | DNA admin list honors `X-Tenant-Id`; clinician prompt resolution filtered to `PUBLISHED`; department-create threads `defaultSummaryTemplate`; DNA "Generate" affordance; OCC DTO symmetry (`expectedVersion` optional); removed dead `PRE_SUMMARY` category + `useAssignDepartmentPrompt` | 225 backend · 261/104 FE |
| **C — Infra / Config** | IC-04 (same-tenant), IC-06 | **Fixed** (IC-07/IC-08/IC-04-transfer deferred) | Pipeline `assign-tenant` persists for same-tenant; access-keys field relabeled "Access Key ID (masked)"; SUPER_ADMIN-only platform-defaults scope toggle | 35 · 21 · 58 |
| **D — Observability / Audit** | OB-04, OB-06, OB-07, OB-08, OB-09, OB-10 | **Fixed** | Audit reads no longer self-broadcast `ResourceViewed`; CSV export adds a Tenant column in global view; pagination uses a committed-filter snapshot; collapsed dual audit clients; removed soft-delete route + `deleteById` | 115 · 23 · 16 |
| **E — End-user APIs** | EU-01, EU-02, EU-03, EU-06, EU-07 | **Fixed** (EU-07 row-ownership deferred) | Owner-scoped transcription `cancel/retry/by-consultation`; SDK pagination `count`→`total`; `@Authorize(['create','Consultation'])` on `open`; typed create DTOs (no more `@Body() any`) | 6 · 36 · 117 |
| **F — FE ops screens + nav** | OB-01, OB-02, IC-05, IMP-05 | **Fixed** | New **System Health**, **Jobs**, **Rate Limits** screens (global scope) + nav entries; Admin-Overview **Impersonate** CTA | 29/29 |
| **F — OB-03 UI** | OB-03 (UI half) | **Fixed** | **Queues & Jobs** admin screen (queues + schedulers tabs) over Lane H endpoints; 1 global-only nav entry | 28/28 |
| **G — Ops backend + Studio** | OB-11, OB-12, OB-13, BR-02 | **Fixed** (self-host CDN asset deferred) | `manage:all` gate on monitoring + `/health/services`; monitoring sessions extended to **stt/nlp**; Studio `defaultSchema=core` (fixes "No tables found"); JWT read from URL fragment then scrubbed, `Cache-Control: no-store` (no inlined token) | 51 · 52 · 70 |
| **H — OB-03 queue/scheduler backend** | OB-03 (backend half) | **Fixed** | New `queue-admin` module: **16 SUPER_ADMIN-gated routes** (queue stats/pause/resume/clean, job list/inspect/manage, scheduler list/pause/resume/cron/toggle) + `QueueNamePipe`; additive `app.module` registration | 20/20 |
| **I — OB-05 audit retention** | OB-05 | **Fixed** (retention; partitioning deferred) | New `AuditRetentionService` (scheduled purge, **dormant by default**); `(tenantId, createdAt)` + `createdAt` indexes already existed → no migration | 20/20 |
| **Seed** | IC-03, EU-04, EU-05, AC-06 (role/user seed) | **Fixed** | `GLOBAL_ADMIN` role (SYSTEM tenant) + `global_admin` user; **PUBLISHED** clinician prompt baseline; **GLOBAL default ASR pipeline**; transcription jobs across statuses (GLOBAL + ARCAAI); customer-tenant doctor voice profiles + `arcaai-sdk` prefs | reset + reseed verified |

### 8.2 Gated architectural builds (user approved "build both")

- **OB-03 — TASK-250 queue/job/scheduler admin.** Built end-to-end: backend controllers (Lane H, 16 routes, SUPER_ADMIN-gated) + a Queues & Jobs console screen (Lane F). TASK-250 is no longer Pending for the admin surface.
- **OB-05 — AuditLog retention.** Implemented as a **retention-only** scheduled service (dormant until configured). Native table partitioning was **deferred** — the required `(tenantId, createdAt)`/`createdAt` indexes already exist, and partitioning is a larger DBA migration better tracked separately.

### 8.3 Data reset & reseed (DONE)

The orphan DNA version row from the live OCC probe (report `REPORT_RHEUM`, `DnaWritingStyleVersion versionNumber 2`) and the GLOBAL-concentrated seed both warranted a clean rebuild. With user consent for a **full destructive reset**, the dev DB (`hope @ localhost:5432`, `.env.dev`) was **`prisma migrate reset` + reseeded**. The orphan is gone; CC-01 prevents recurrence. Two **pre-existing** blockers surfaced during replay and were fixed:

1. **Migration `20260527000000` — missing `updatedAt`.** Its `INSERT` of the `__SYSTEM__` tenant omitted `updatedAt` (NOT NULL, no default), so a clean replay failed. Fixed by adding `updatedAt = CURRENT_TIMESTAMP` to the historical migration's INSERT.
2. **Schema ↔ migration drift.** `schema.prisma` / generated client expected `TenantBucket.purpose` (and related indexes) that no migration created, so `seed` failed. Reconciled on the freshly-reset (empty) DB via `prisma db push --accept-data-loss`. Seed then completed green.

### 8.4 Deferrals (conscious, with rationale)

| ID | Deferred part | Why |
|---|---|---|
| **IC-04** | Cross-tenant pipeline **transfer** | Needs the multi-tenant-core extension to re-key ownership safely; same-tenant assign is implemented and tested. |
| **IC-07** | Platform/global settings **create/remove** | No backend endpoint exists yet; only the SUPER_ADMIN scope toggle was added. Backend work is a separate ticket. |
| **IC-08** | Adopt the **paginated** pipelines endpoint | Would re-introduce the IC-02 truncation/shape risk; left as a tracked TODO. |
| **EU-07** | Row-level consultation/media **ownership** assertion | Typed DTOs landed; deep ownership verification needs a shared resource-access helper (follow-up). |
| **OB-05** | Native **partitioning** | Larger DBA migration; retention + indexes cover the immediate growth concern. |
| **OB-11** | **Self-host** the Studio core asset (CDN) | JWT is no longer inlined (the security issue); vendoring the asset is hardening, not correctness. |

### 8.5 Convergence — regressions caught & fixed

Reconciling all lanes surfaced two real regressions, both fixed and re-verified:

1. **Impersonation throttle/authz detached.** Lane A's new `recordImpersonationDenied` helper was inserted **between** the route decorators (`@Post`/`@Throttle`/`@HttpCode`/`@Authorize`) and the `impersonate` handler, detaching that metadata at runtime (caught by `throttle-decorators.test.ts`). The helper was relocated above `@Post('impersonate')`, reattaching all decorators.
2. **Audit cross-tenant coverage dipped 10→9.** Lane D's removal of `deleteById` (OB-10) dropped `auditLog` below the `minTests:10` cross-tenant gate. Restored with **two new meaningful `exportFiltered` isolation tests** (tenant-scoped export + SUPER_ADMIN cross-tenant export), bringing it to 11.

Also during convergence: stale `dist` artifacts caused module-resolution failures in several suites; resolved by rebuilding `@arcaai/{database,domains,applications,room}` in dependency order.

### 8.6 Verification (final, post-convergence)

- **Full monorepo unit suite** (`pnpm test:unit`, `.env.test`, `vitest --pool=forks`): **649 files passed**, **13,274 tests passed | 0 failed** (exit 0). `--pool=forks` was used to avoid a WASM segfault in `threads` mode from native packages (e.g. `noise-filter`).
- **Lint:** zero errors on all changed packages (`turbo run lint` + `ReadLints`).
- **Build:** affected packages rebuilt clean (`@arcaai/{database,domains,applications,room}`).
- **DB:** reset + seed completed green against `.env.dev`; 4-tenant realistic data (GLOBAL + ARCAAI + 4BITS + MUMBAI) with `GLOBAL_ADMIN`, PUBLISHED prompts, GLOBAL ASR pipeline, transcription jobs, and customer voice/SDK prefs.

> **Live caveat (unchanged):** service-layer (`@arcaai/applications`/`@arcaai/domains`) and the new API modules are code-complete and unit/lint-verified but won't be active in the **running** server until it is rebuilt and reloaded — deliberately not triggered, per the no-stop/start constraint.

---

## 9. Verified healthy (no action)

Confirmed working during the review (many live):

- **Impersonation** — boundary matrix + token revocation verified end-to-end (live browser): admin token vs impersonation token selection, target-tenant swap and restore, owner-derived endpoints resolve the impersonated doctor, non-clinical admins gated.
- **Access-control foundation (live)** — no-token → 401; cross-tenant consultation fetch → 404; nurse write on a doctor's consultation → 403; cross-user voice-profile → 404; random transcription job → 404; plain doctor → 403 across admin endpoints.
- **SMR-proxy** — thorough cross-tenant / cross-doctor / prompt-owner guards; `__GLOBAL__` restricted to SUPER_ADMIN; debug-mode admin-only.
- **Voice profile** — double-enforced ownership + active-uniqueness.
- **OCC guards** — `If-Match` precondition returns 412/428 (the gap was transactionality, not the guard — CC-01).
- **Console shell** — 9/11 screens render with no console/network errors; scope gating + System-tenant exclusion from the picker.
- **No storage access-key secret leakage** — the real secret is never returned (only a masked id; see IC-06 for a label nit).

---

## 10. Change History

| Date | Change | Files / scope |
|---|---|---|
| 2026-06-06 | Initial review delivered — 6 parallel agents (1 browser + 5 code, live probes); 49 findings (5C/6H/19M/19L) graded and registered (also in `canvases/admin-console-review.canvas.tsx`). | review only |
| 2026-06-06 | **5 Criticals remediated under TDD** (AC-01, AC-02, CC-01, IC-01, IC-02). Full unit suite green (13,166 passed); lint clean. Not committed; service-layer not live pending rebuild/reload. | see §7.1 |
| 2026-06-06 | Documented orphan DNA version row + chosen full reset/reseed; **blocked** on Prisma 7 AI-agent consent. | data only |
| 2026-06-06 | **Remaining 44 findings remediated** across 10 parallel TDD lanes (A–I + Seed); a few parts consciously **deferred** (§8.4). Includes the gated **build-both** for OB-03 (TASK-250 queue/scheduler admin — backend + UI) and OB-05 (audit retention). | see §8.1–8.2 |
| 2026-06-06 | **Dev DB reset + reseeded** (user-consented destructive reset). Fixed **2 pre-existing blockers**: migration `20260527000000` missing `updatedAt`; schema↔migration drift (`TenantBucket.purpose`) reconciled via `db push`. Orphan DNA row cleared. | §8.3; migration `20260527000000` |
| 2026-06-06 | **Convergence:** fixed 2 regressions (impersonation throttle/authz decorator detach; audit cross-tenant coverage 10→9) and rebuilt stale `dist`. Final full suite **green: 13,274 passed, 0 failed** (forks pool); changed-package lint clean. Status → `Review`. | §8.5–8.6 |

