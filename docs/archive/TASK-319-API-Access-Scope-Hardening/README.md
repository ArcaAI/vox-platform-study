# TASK-319 — API Access-Scope Hardening (End-User vs Admin)

| | |
|---|---|
| Ticket Number | TASK-319 |
| Parent / Origin | API Gateway review (`fix/2605-review`) |
| Created | 2026-05-31 |
| Updated | 2026-05-31 |
| Status | Completed |
| Type | Bugfix + Enhancement (access-control hardening) |
| Branch | `fix/2605-review` |
| Scope | `apps/api`, `packages/applications`, `apps/ui-playground`, `knowledge/` docs |

---

## 1. Requirement Analysis

### 1.1 Description

A review of the API gateway found that the end-user vs admin-user API split is real but
incomplete and partly undocumented. The canonical example: an end-user (doctor) can list
**their own** consultations, but a tenant admin has **no** way to list **all** consultations
in their tenant. The documented "single endpoint adapts by role" mechanism
(`AuthorizedBaseService.getAccessibleFilter`) is dead code — no service uses it — so the
docs are misleading. Several smaller scope/consistency defects exist alongside it.

### 1.2 Business context

Tenant administrators cannot supervise clinical activity in their tenant (no tenant-wide
consultation view), and the access-control documentation actively misleads contributors.
This ticket makes the admin scope a first-class, explicit surface (separate controllers),
removes the misleading dead code/docs, and tightens a few scope leaks.

### 1.3 Findings being addressed

- **F1 (High):** No tenant-wide consultation access for admins — `GET /consultations`
  hard-codes `doctorId = caller`.
- **F2 (High):** `AuthorizedBaseService` / `getAccessibleFilter` is documented as the core
  scoping mechanism but is unused dead code; docs are misleading.
- **F3 (Medium):** `GET /audio/transcription-jobs` (+ `/stats`, `/status/:status`) is
  visible tenant-wide to every authenticated user, inconsistent with consultations.
- **F4 (Medium):** `PromptManagementController` is permission-gated but lives at
  `/prompt-templates`, outside the audited `/admin` convention.
- **F5 (Low):** `TenantController.fetchById` / `fetchAll` lack the `assertTenantInScope`
  guard the write paths use (read-across-tenant risk for a tenant-scoped `manage:Tenant`).
- **F6 (Low):** Boot-time admin-route audit only checks a permission marker exists, not
  that an `/admin` route carries a non-empty permission.

### 1.4 Locked decisions

- Use **separate controllers** (Pattern A) for end-user vs admin scope.
- `/admin/consultations` gates on `@CanManage('Consultation')` (TENANT_ADMIN / SUPER_ADMIN
  only). Doctors stay on the owner-scoped `/consultations`.
- Full scope (F1–F6 + doc fix), including the two breaking changes (F3, F4) with consumer
  updates.

### 1.5 Acceptance criteria

1. A tenant admin can list/read all consultations in their own tenant via
   `/admin/consultations`; a plain doctor receives 403; cross-tenant rows never appear.
2. `AuthorizedBaseService` + its test are removed; no broken imports; docs/rule references
   corrected to describe the real model.
3. End-user transcription-job list/stats/status return only the caller's jobs; a tenant-wide
   view is available to admins under `/admin/audio/transcription-jobs`.
4. Prompt-template management is served under `/admin/prompt-templates`; the ui-playground
   consumer is updated.
5. `TenantController` read paths enforce tenant scope for non-super-admins.
6. The boot-time audit fails fast if an `/admin/*` route carries an empty `@Authorize()`.
7. All changes are TDD; affected packages build; no new lint errors.

---

## 2. Current State Evaluation

- `ConsultationService extends BaseService` (not `AuthorizedBaseService`). `listConsultations`
  already has an `else` branch that lists all-in-tenant when `doctorId` is omitted
  (`packages/applications/src/services/consultation/consultation/consultation.service.ts`).
- CASL seed (`packages/database/src/prisma/db_main/seed/01-policy.ts`): only `TENANT_ADMIN`
  holds `manage Consultation`; DOCTOR holds `list` conditioned to `doctorId=self`. So
  `@CanManage('Consultation')` is the correct doctor-excluding gate.
- `AuthorizedBaseService` referenced only by itself + its test; exported from
  `packages/applications/src/common/index.ts`. Stale doc references in
  `knowledge/04_ACCESS_CONTROL.md`, `knowledge/architecture/security.md`,
  `knowledge/architecture/data-model.md`, `knowledge/database/01_DATA_MODEL.md`, and the
  rule `.cursor/rules/04-application-services.mdc`.
- `TranscriptionJobController` (`apps/api/src/modules/streaming/transcription-job.controller.ts`)
  list/stats/status are tenant-wide via the Prisma `tenantScopeFilter` only (no per-user
  scope).
- `PromptManagementController` is `@Controller('prompt-templates')`; only consumer is
  `apps/ui-playground/src/features/admin/api/prompts.ts`.

---

## 3. Implementation Plan (TDD test list)

### Wave 1 — non-breaking
- **F1** service `listConsultationsForTenant` (tenant-wide) + `/admin/consultations` controller
  (`@CanManage('Consultation')`, list + getById) registered in `consultation.module.ts`.
  - Tests: service returns all-in-tenant + honors filters; controller class gate is
    `manage:Consultation`; tenant isolation.
- **F2** remove `AuthorizedBaseService` + test + barrel export; fix doc/rule references.
- **F5** `assertTenantInScope` on `TenantController` read paths; scope `fetchAll` for
  non-super-admins. Tests for cross-tenant denial.
- **F6** admin-route audit rejects empty `@Authorize()` on `/admin/*`; audit test extended.

### Wave 2 — breaking / consumer-affecting
- **F3** owner-scope end-user transcription-job list/stats/status (+ owner-scoped service
  method); new `/admin/audio/transcription-jobs` controller; update consumers.
- **F4** move controller to `/admin/prompt-templates`; update ui-playground consumer + tests.

---

## 4. Implementation Summary

All six findings were implemented TDD (RED → GREEN), sequenced Wave 1 (F1, F2, F5, F6) →
Wave 2 (F3, F4). Every new admin surface uses the **separate-controller** pattern and inherits
tenant isolation from the `tenantScopeFilter` Prisma extension.

### 4.1 What was built (per finding)

**F1 — tenant-wide consultation admin surface**
- `IConsultationService.listConsultationsForTenant({ page, pageSize, patientId?, doctorId?, departmentId? })`
  + implementation in `ConsultationService` (tenant-only filter via `findPaginatedWithRelations`
  + `count`; no owner/shared-patient scoping; broadcasts `ResourceViewed`).
- New `AdminConsultationController` → `@Controller('admin/consultations')`, class-gated
  `@CanManage('Consultation')` (TENANT_ADMIN / SUPER_ADMIN only). Routes: `GET /admin/consultations`
  (paginated + optional `patientId`/`doctorId`/`departmentId`) and `GET /admin/consultations/:id`.
- Registered in `consultation.module.ts`.

**F2 — removed dead `AuthorizedBaseService` + corrected docs**
- Deleted `authorized-base.service.ts` + its test; dropped the `common/index.ts` barrel export
  (grep-verified zero references; PolicyEngine never referenced it).
- Rewrote the service-layer/multi-tenancy sections of `knowledge/04_ACCESS_CONTROL.md`,
  `knowledge/architecture/security.md`, `knowledge/architecture/data-model.md`,
  `knowledge/database/01_DATA_MODEL.md`, and `.cursor/rules/04-application-services.mdc` to describe
  the real model (`BaseService` + separate controllers + `tenantScopeFilter` + `@TenantOwnedResource`).

**F3 — transcription-job scope split (owner vs tenant)**
- Owner field is `createdBy`. Added owner-scoped service methods `listForOwner`,
  `getByStatusForOwner`, `getStatusCountsForOwner` (+ interface) and an optional `ownerId` on the
  domain repo `TranscriptionJobRepository.countByStatus(tenantId, ownerId?)`.
- End-user `TranscriptionJobController` `list` / `getStats` / `getByStatus` now owner-scope to the
  caller (`getUserId()` from CLS).
- New `AdminTranscriptionJobController` → `@Controller('admin/audio/transcription-jobs')`,
  `@CanManage('Tenant')`, tenant-wide `list` / `stats` / `status/:status`. Registered in
  `streaming.module.ts`.

**F4 — moved `/prompt-templates` → `/admin/prompt-templates`**
- `PromptManagementController` now `@Controller('admin/prompt-templates')` (`@ApiTags` → `admin-prompt-templates`);
  existing `@Authorize` tuples unchanged.
- Updated consumers: ui-playground `features/admin/api/prompts.ts` (11 literals) **and** the SDK
  `PROMPT_TEMPLATE_ENDPOINTS` constants in `@arcaai/vox` (the SDK `usePrompts` hook binds to the
  path — see deviation 4.3).

**F5 — tenant read-scope on `TenantController`**
- `fetchAll` now restricts non-super-admins to their own tenant (`fetchById` + single-row
  `FetchResponse`) and throws `ForbiddenException` when a non-super-admin has no tenant context;
  super-admins keep the full list. (`fetchById`/`fetchByCodeName`/`fetchTenantConfigs` already 404
  cross-tenant via service-level checks — stronger than a 403.)

**F6 — hardened boot-time admin-route audit**
- Added `ADMIN_ROUTE_RE = /^\/(api\/v\d+\/)?admin\//`; an empty `@Authorize()` on an `/admin/*`
  route is now a boot offender. Uses `getAllAndOverride([method, class])`, so class-level gates
  (e.g. the moved prompt controller's `@Authorize(['read','PromptTemplate'])`) satisfy it.

### 4.2 Files changed

| Layer | File | Change |
|---|---|---|
| Domain | `packages/domains/src/repositories/generated/core/TranscriptionJobRepository.ts` | optional `ownerId` on `countByStatus` (F3) |
| Service | `…/services/consultation/consultation/IConsultationService.ts` + `consultation.service.ts` (+ test) | `listConsultationsForTenant` (F1) |
| Service | `…/services/stt/job/ITranscriptionJobService.ts` + `transcriptionJob.service.ts` (+ test) | owner-scoped list/stats/status (F3) |
| Service | `packages/applications/src/common/index.ts` | drop `AuthorizedBaseService` export (F2) |
| Service | `…/common/authorized-base.service.ts` (+ test) | **deleted** (F2) |
| API | `apps/api/src/modules/consultation/admin-consultation.controller.ts` (+ test) | **new** (F1) |
| API | `apps/api/src/modules/consultation/consultation.module.ts` | register admin controller (F1) |
| API | `apps/api/src/modules/streaming/admin-transcription-job.controller.ts` (+ test) | **new** (F3) |
| API | `apps/api/src/modules/streaming/transcription-job.controller.ts` (+ test) | owner-scope end-user reads (F3) |
| API | `apps/api/src/modules/streaming/streaming.module.ts` | register admin controller (F3) |
| API | `apps/api/src/modules/prompt-management/prompt-management.controller.ts` (+ test) | path → `/admin/prompt-templates` (F4) |
| API | `apps/api/src/modules/tenant/tenant.controller.ts` (+ test) | scope `fetchAll` (F5) |
| API | `apps/api/src/bootstrap/admin-route-permission-audit.ts` (+ test) | reject empty `@Authorize()` on `/admin/*` (F6) |
| SDK | `packages/agentic-sdk-v2/src/core/constants.ts` (+ 2 constant tests) | `PROMPT_TEMPLATE_ENDPOINTS` → `/admin/prompt-templates` (F4) |
| UI | `apps/ui-playground/src/features/admin/api/prompts.ts` | consumer paths → `/admin/prompt-templates` (F4) |
| Docs | `knowledge/04_ACCESS_CONTROL.md`, `…/architecture/security.md`, `…/architecture/data-model.md`, `…/database/01_DATA_MODEL.md`, `.cursor/rules/04-application-services.mdc` | correct the access-control model (F2) |

No DB migration was required (reused existing models/repos).

### 4.3 Deviations from the plan

1. **F3 `getByConsultation` kept tenant-scoped (not owner-scoped).** The plan listed it among the
   owner-scoped end-user endpoints, but jobs attached to a consultation may legitimately be created
   by different members of the care team; owner-scoping would hide a teammate's jobs for a shared
   consultation. It remains tenant-scoped (still isolated by `tenantScopeFilter`).
2. **F3 admin gate is `@CanManage('Tenant')`** (not `@CanManage('TranscriptionJob')`) because
   `TranscriptionJob` is not a CASL subject in the policy seed — the plan anticipated this fallback.
3. **F4 consumer surface was larger than the plan's "only consumer" note.** Besides the ui-playground
   admin API, the SDK `PROMPT_TEMPLATE_ENDPOINTS` (consumed by the `usePrompts` hook in `@arcaai/vox`)
   also binds to the path, so the SDK constants + their path-bound tests were updated too (covered by
   the plan's "update any tests referencing the old path").
4. **F1 admin `getById` does not use `@TenantOwnedResource`.** `Consultation` has no gateway-repo
   binding, so the `tenantScopeFilter` extension is the enforcement point (cross-tenant id → `null`
   → 404, no existence leak).

### 4.4 Verification evidence

| Gate | Command | Result |
|---|---|---|
| Build / typecheck (API + deps) | `pnpm build:api` | **8/8 successful** (clears TS server staleness; F1/F3/F4/F5/F6 controllers compile) |
| Build (SDK) | `pnpm build:sdk` | **6/6 successful** (F4 constants compile) |
| Unit — services (F1+F3) | `vitest run consultation.service + transcriptionJob.service` | **98 passed** |
| Unit — API (all 6 TASK-319 files) | `vitest run admin-consultation, transcription-job, admin-transcription-job, prompt-management, tenant, admin-route-permission-audit` | **123 passed** |
| Unit — SDK (full) | `vitest run` in `@arcaai/vox` | **2948 passed (136 files)** |
| Lint | `ReadLints` on all touched files | **clean** |

**Pre-existing baseline issues observed (NOT caused by TASK-319, untouched subsystems):**
- ui-playground `type-check`: my edited `features/admin/api/prompts.ts` is **type-clean**; the
  remaining errors are in untouched files (`routes/_authenticated/admin/*.tsx`, `store/auth-store.ts`,
  SDK `providers/AgenticProvider.tsx`) and are identical to `HEAD`.
- `apps/api` full suite: 1473 passed, 1 flaky (`throttle-guard.test.ts` `/t/skip`; **passes 8/8 in
  isolation**).
- `@arcaai/applications` full suite: 4451 passed; 7 failures in 3 authorization/user files
  (`policy.engine.no-usergroup`, `tenant-ability.regression`, `userRoleAssignment.service.task307`).
  Those files are **identical to `HEAD`** (so they fail on a clean checkout) and fail on a
  `prisma`-undefined mock — an existing branch baseline unrelated to this ticket.

---

## 5. Change History

| Date | Change | Files |
|---|---|---|
| 2026-05-31 | Ticket created; plan approved (separate controllers, full scope) | this README |
| 2026-05-31 | Wave 1 implemented (F1 admin consultations, F2 dead-code+docs, F5 tenant read-scope, F6 admin-route audit) | see §4.2 |
| 2026-05-31 | Wave 2 implemented (F3 transcription owner/tenant split, F4 prompt-templates → `/admin`); SDK constants synced; verification gates captured | see §4.2 |
