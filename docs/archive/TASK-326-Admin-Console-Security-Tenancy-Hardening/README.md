# TASK-326 — Phase 0: Security & Tenancy Hardening

| | |
|---|---|
| Ticket Number | TASK-326 |
| Short name | Admin-Console-Security-Tenancy-Hardening |
| Parent | **TASK-325** (Admin Console Transformation — umbrella) |
| Created | 2026-06-02 |
| Updated | 2026-06-02 |
| Status | `Completed` (2026-06-02) — local build+unit+lint green; e2e committed for CI. Gates Phases 1–3. |
| Type | bugfix (security / multi-tenancy) |
| Scope | `apps/api/`, `packages/database/`, `packages/domains/`, `packages/applications/` |
| Depends on | — (run before TASK-327/328/329) · cross-ref TASK-305 (Multi-Tenancy-Hardening), TASK-313/314/317 |

> Closes the cross-cutting defects **X1, X2, X5, X7, X9** + soft-delete verification from TASK-325 §2.6. Per decision **Q2**, the controller/service tenant-scoping fixes are done **completely in this ticket**; **X6** (`User*` DB-level `tenantId`) is **deferred to TASK-305 Phase A** (decision 2026-06-02 — it overlaps the existing A.10/A.11 User-schema-hardening design and `User` is intentionally multi-tenant). Per **Q4**, Prisma Studio stays super-admin-only.

---

## 1. Requirement Analysis

### 1.1 Description
Eliminate cross-tenant data exposure and unaudited privileged access before the console is opened to tenant admins (TASK-327). Enforce tenant scope at the controller layer **and** the data layer, audit Prisma Studio, split the DNA admin authz, and verify soft-delete + `SysEvent` everywhere.

### 1.2 Acceptance criteria
- [x] **X2** — `GET /admin/users` returns only the caller's tenant for non-super-admins (`UserController.fetchAll` → `fetchAllByTenantId`; `403` when a non-super-admin has no tenant context); `SUPER_ADMIN` keeps the cross-tenant view. Unit-covered + e2e spec authored.
- [x] **X5** — `GET /admin/departments` and `GET /admin/audit-logs` (`fetchAll`) carry a controller-layer tenant-context guard mirroring `AuditLogController.fetchByUser`; audit rows remain service-scoped via `buildTenantWhere`.
- [~] **X6** — **Deferred to TASK-305 Phase A** (decision 2026-06-02). Overlaps the existing A.10/A.11 `User*` schema-hardening design; `User` is intentionally multi-tenant with global unique constraints, so DB-level `tenantId` is handled there, not here. **No schema change in this ticket.**
- [x] **X1 / Q4** — every Prisma Studio `query`/`sequence` writes an `AuditLog` via `recordSystemAction` (`eventType: 'PRISMA_STUDIO'`, `action: READ|UPDATE`, `resourceType: AuditLog`); Studio remains `@CanManage('all')` (super-admin only). Reused existing enum → **no migration**.
- [x] **X7** — DNA admin authz narrowed `manage:all` → `manage:DnaWritingStyleReport` on `DnaWritingStyleAdminController` + matching tenant-scoped seed policy rule; service PHI/tenant guard still applies. **OCC (`@RequiresIfMatch`) — closed via D-2 (2026-06-02):** the admin PATCH now requires `If-Match` and runs a Compare-And-Set through `dnaReportRepository.updateWithVersion` (`412` on drift, `428` when the header is missing). See §5.1.
- [~] **X9** — DNA generation **request** now emits `SysEventType.ResourceCreated` (report is produced async by the BullMQ worker); pipeline delete already emits `ResourceDeleted`. Broader tenant-config/storage sweep tracked with their surfaces in TASK-327/329.
- [x] **Soft-delete** — `PipelineService.delete` normalized to `pipelineRepository.softDelete()` (OCC-consistent); no hard deletes introduced.
- [x] Gates green (§4) — build + unit + lint local; e2e in CI.

### 1.3 Non-goals
- No UI nav/scope-switcher changes (that is TASK-327). API + DB only here, plus the minimal DTO/service work to enforce scope.

---

## 2. Current State Evaluation
Evidence lives in the umbrella (TASK-325 §2.2–§2.6). Verified anchors: `user.controller.ts:61-66` (no scope), `pstudio.controller.ts:56-69` (raw exec, no audit). `User` has no `tenantId` and is **excluded** from the tenant-scope Prisma extension (TASK-305 known gap), so today there is no DB-level isolation for user-related models.

---

## 3. Implementation Plan (TDD, bottom-up the layer chain)

> **DB safety:** the X6 migration **adds** columns/indexes and **backfills** — no `DROP`/`DELETE`/`TRUNCATE`. Schema change + backfill SQL to be reviewed before `pnpm db:migrate`.

1. **RED (API e2e):** `apps/api/tests/e2e` — a `TENANT_ADMIN` token hitting `GET /admin/users|departments|audit-logs` must not return other tenants' rows. Write failing tests first.
2. **Database (X6):** add `tenantId` + composite indexes (`@@index([tenantId, ...])`) to `User*` models; migration + backfill from `UserRoleAssignment.tenantId`; `pnpm db:generate`.
3. **Domain/App:** add `User*` to the tenant-scope extension scoped-model set; ensure repositories use the **extended** Prisma client; add `fetchAllByTenantId` paths where missing.
4. **API (X2/X5):** add inline scope (non-super → `*ByTenantId(cls.tenantId)`) to the three `fetchAll` handlers → GREEN the RED tests.
5. **pstudio (X1):** wrap `studioService.executeQuery/executeSequence` to write an `AuditLog` per call; keep `@CanManage('all')`.
6. **DNA (X7):** extract `DnaWritingStyleTenantAdminController` (`manage:DnaWritingStyleReport`, tenant-scoped) from the global one; add `@RequiresIfMatch` to admin PATCH.
7. **Sweep (X9 + soft-delete):** add `broadcastSysEvent` after the listed mutations; audit all `deleteById` call chains for `softDelete()`.

---

## 4. Verification Gates
```
pnpm db:migrate && pnpm db:generate
pnpm test:unit --filter @arcaai/domains
pnpm test:unit --filter @arcaai/applications
pnpm build:api && pnpm test:e2e        # cross-tenant isolation (RED→GREEN)
# ReadLints on every edited file → clean
```
Capture actual output as evidence (rule `verification-before-completion`).

---

## 5. Implementation Summary

**Completed 2026-06-02.** Local gates green (build + unit + lint); the cross-tenant e2e spec is authored and committed to run in CI. (Local API boot is blocked by an intentional guard — it *refuses to boot when `JWT_SECRET_KEY` is the literal placeholder*, requiring real secrets warmed via Vault/SecretsService, which CI provisions via `setup-test-env`. That guard's async-fallback fix lives in `fix/2605-review` @ `f5000f86`, downstream of this worktree's base.)

### What shipped (vs plan)
| Defect | Outcome |
|---|---|
| **X2** — `/admin/users` cross-tenant | **Fixed.** `UserController.fetchAll` routes non-super-admins through `userService.fetchAllByTenantId(cls.tenantId)` and returns `403` when a non-super-admin lacks tenant context; `SUPER_ADMIN` retains the cross-tenant operator view. |
| **X5** — `/admin/departments`, `/admin/audit-logs` | **Fixed.** Controller-layer tenant-context guard on both `fetchAll` handlers (mirrors `AuditLogController.fetchByUser`); audit rows stay service-scoped via `buildTenantWhere`. |
| **X1 / Q4** — Prisma Studio audit | **Fixed.** New `IAuditLogService.recordSystemAction()` — a direct, best-effort write (never throws; falls back to `SYSTEM_TENANT_ID`) — invoked by `PrismaStudioController` before each `query` (READ) / `sequence` (UPDATE), tagged `eventType: 'PRISMA_STUDIO'`. Studio stays `@CanManage('all')`. Reused `ResourceType.AuditLog` → no migration. |
| **X7** — DNA admin authz | **Fixed (variant).** `DnaWritingStyleAdminController` `@Authorize` narrowed `manage:all` → `manage:DnaWritingStyleReport`; matching tenant-scoped rule added to the `tenant-full-access` seed policy. Service PHI/tenant guard unchanged. **OCC closed (D-2, 2026-06-02) — see §5.1.** |
| **X9** — SysEvent coverage | **Partial.** DNA generation request emits `ResourceCreated`; pipeline delete already emits `ResourceDeleted`. Remaining surfaces tracked in TASK-327/329. |
| **Soft-delete** | **Normalized.** `PipelineService.delete` → `pipelineRepository.softDelete()` (OCC-consistent). |
| **X6** — `User*` DB tenant-scoping | **Deferred to TASK-305 Phase A** (overlaps A.10/A.11; `User` is multi-tenant by design). |

### Files changed
- **API** (`apps/api/src/modules/`): `user/user.controller.ts`, `department/department.controller.ts`, `audit-log/audit-log.controller.ts`, `pstudio/pstudio.controller.ts`, `pstudio/pstudio.module.ts`, `dna-writing-style/dna-writing-style-admin.controller.ts` — plus unit tests under each module's `__tests__/` (user, department, audit-log, pstudio).
- **Applications** (`packages/applications/src/services/`): `auditLog/IAuditLogService.ts`, `auditLog/auditLog.service.ts`, `dna-writing-style/dna-writing-style.service.ts`, `stt/pipeline/pipeline.service.ts` — plus `__tests__/` for auditLog, dna-writing-style, pipeline.
- **DB seed**: `packages/database/src/prisma/db_main/seed/01-policy.ts` (`tenant-full-access` += `manage:DnaWritingStyleReport`). **No schema/migration.**
- **e2e** (new): `apps/api/tests/e2e/task-326-admin-fetchall-cross-tenant.spec.ts`.

### Gate evidence (local)
- `pnpm build:api` → **8/8 tasks** (full type-check domains→applications→api). Caught + fixed a `JsonValue` type error in `recordSystemAction`.
- `pnpm --filter @arcaai/applications test:unit` → **4507 passed, 4 skipped**.
- `pnpm --filter @arcaai/api test` → **1447 passed, 4 skipped** (best-effort audit "never throws" tests log expected `ERROR` lines).
- Lint → clean on all edited files.
- e2e → committed; executes in CI.

### 5.1 D-2 follow-up — DNA admin OCC (closed 2026-06-02)
Closes the X7 OCC deferral above. The admin DNA-report PATCH now enforces optimistic concurrency, mirroring `PromptManagementController` / `UserDepartmentsController`:

- **DTO** (`update-dna-report.request.ts`) — added an optional `expectedVersion?: number` (`@IsInt` / `@Min(1)`). Optional because the same DTO is shared by the non-OCC doctor route (`DnaWritingStyleController`).
- **Controller** (`dna-writing-style-admin.controller.ts`) — `@RequiresIfMatch()` + `@ExpectedVersion()` on `update`; the `If-Match` header value is folded onto `expectedVersion` (header wins over body) and `bypassOwnershipCheck: true` is preserved. Swagger documents the required `If-Match` header + `412`/`428` responses.
- **Service** (`dna-writing-style.service.ts`) — final write switched from `repo.update(...)` to `repo.updateWithVersion(reportId, report, dto.expectedVersion)`; ownership/tenant guard, `DnaVersion` snapshot, and `SysEvent` broadcast all unchanged.
- **Mapper** (`DnaWritingStyleReportEntityMapper.ts`) — defense-in-depth: `FIELDS_NOT_WRITABLE = ['version']` stripped in `toPersistence` / `toPersistenceChanges` (the `_version` OCC column is DB-owned), matching the `Department` / `PromptTemplate` mappers.

> **Correction to the Wave-1 deferral rationale:** the row `_version` column already exists (via `BaseEntity`) and `Repository.updateWithVersion` was already available — so **no migration** and no new repo primitive were needed. The OCC `_version` token is DISTINCT from `currentVersionNumber` / the `DnaVersion` history counter; do not conflate them.

**D-2 gate evidence** (worktree branch `task-326/x7-dna-occ`, base `4c231595`):
- Build — `turbo run build --filter=@arcaai/api` → **8/8 successful** (full type-check domains→applications→api).
- Unit (targeted, TDD) — domains DNA **23/23**; applications `src/services/dna-writing-style` **153/153** (incl. 2 new OCC cases: `updateWithVersion` called with the expected version, and `OptimisticConcurrencyException` propagation); api `src/modules/dna-writing-style` **46/46** (admin 28 + doctor 18).
- Lint — all changed lines clean. One **pre-existing** prettier error remains at `dna-writing-style-admin.controller.ts:52` (TASK-328 A5 `getDashboard` `@ApiQuery`, byte-identical in base) — left untouched to keep the diff surgical.

### Deviations from plan
- **X6 deferred** to TASK-305 Phase A (no DB migration here).
- **X7** delivered via authz-narrowing + seed policy rather than a second controller; **OCC (`@RequiresIfMatch`) initially deferred, now closed by D-2 (§5.1)** — the "no native repo support" premise was inaccurate: `Repository.updateWithVersion` and the row `_version` column (via `BaseEntity`) already existed, so no migration/new primitive was needed.
- Prisma Studio audit reuses `ResourceType.AuditLog` (no `PrismaStudio` enum value → avoids a Wave-1 migration).

---

## 6. Change History
| Date | Change | Files |
|---|---|---|
| 2026-06-02 | Sub-ticket created from TASK-325 §3.7 (Phase 0). Scope = X1/X2/X5/X6/X7/X9 + soft-delete; Q2 (fix in-ticket) + Q4 (Studio super-admin-only). Status `Pending`. | this README |
| 2026-06-02 | **Implemented & shipped to `fix/2605-review`.** X2/X5 (controller scope+guard), X1 (Prisma Studio audit via `recordSystemAction`), X7 (DNA authz narrow + policy), X9 (DNA generate event), soft-delete (pipeline). **X6 deferred to TASK-305 Phase A**; X7 OCC deferred. Gates: build 8/8, unit 4507+1447, lint clean; e2e committed for CI. Status → `Completed`. | `user/department/audit-log/pstudio/dna-writing-style-admin` controllers (+tests), `auditLog`/`dna-writing-style`/`pipeline` services (+tests), `01-policy.ts`, new e2e spec |
| 2026-06-02 | **D-2 closed — DNA admin OCC** (§5.1). Admin DNA PATCH now requires `If-Match` (`@RequiresIfMatch` + `@ExpectedVersion`, header overrides body); service writes via `dnaReportRepository.updateWithVersion` → `412` on drift / `428` on missing header; DTO gains optional `expectedVersion?`; mapper strips DB-owned `version`. **No migration** (column already on `BaseEntity`; `updateWithVersion` already existed — Wave-1 deferral premise was inaccurate). TDD; targeted gates green (build 8/8; domains 23; applications-DNA 153 incl. 2 new OCC cases; api-DNA 46). Delivered on isolated branch `task-326/x7-dna-occ` (not merged/pushed — parent handles the sequential merge). | `dna-writing-style-admin.controller.ts` (+test), `dna-writing-style.service.ts` (+test), `dto/update-dna-report.request.ts`, `DnaWritingStyleReportEntityMapper.ts` |
