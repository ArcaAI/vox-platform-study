# TASK-326 — Phase 0: Security & Tenancy Hardening

| | |
|---|---|
| Ticket Number | TASK-326 |
| Short name | Admin-Console-Security-Tenancy-Hardening |
| Parent | **TASK-325** (Admin Console Transformation — umbrella) |
| Created | 2026-06-02 |
| Updated | 2026-06-02 |
| Status | `Pending` — **do first**; gates Phases 1–3. |
| Type | bugfix (security / multi-tenancy) |
| Scope | `apps/api/`, `packages/database/`, `packages/domains/`, `packages/applications/` |
| Depends on | — (run before TASK-327/328/329) · cross-ref TASK-305 (Multi-Tenancy-Hardening), TASK-313/314/317 |

> Closes the cross-cutting defects **X1, X2, X5, X6, X7, X9** + soft-delete verification from TASK-325 §2.6. Per decision **Q2**, the tenant-scoping fixes are done **completely in this ticket** (not deferred to TASK-305). Per **Q4**, Prisma Studio stays super-admin-only.

---

## 1. Requirement Analysis

### 1.1 Description
Eliminate cross-tenant data exposure and unaudited privileged access before the console is opened to tenant admins (TASK-327). Enforce tenant scope at the controller layer **and** the data layer, audit Prisma Studio, split the DNA admin authz, and verify soft-delete + `SysEvent` everywhere.

### 1.2 Acceptance criteria
- [ ] **X2** — `GET /admin/users` returns only the caller's tenant for non-super-admins; an e2e test with a `TENANT_ADMIN` token returns **0** cross-tenant rows (`apps/api/src/modules/user/user.controller.ts:61-66` today has no scope).
- [ ] **X5** — `GET /admin/departments` and `GET /admin/audit-logs` (`fetchAll`) enforce the same scope; e2e proves isolation (audit `fetchByUser` already guards — mirror it on `fetchAll`).
- [ ] **X6** — `User`, `UserProfile`, `UserSettings`, `UserVoiceProfile` carry `tenantId`, are added to the tenant-scope Prisma extension's scoped-model set, and gain tenant-leading composite indexes. Existing rows backfilled from `UserRoleAssignment.tenantId`.
- [ ] **X1 / Q4** — every Prisma Studio `query`/`sequence` writes an `AuditLog` (`resourceType: 'PrismaStudio'`, `action: READ|UPDATE`); Studio remains `@CanManage('all')` (super-admin only). (`apps/api/src/modules/pstudio/pstudio.controller.ts:56-69`.)
- [ ] **X7** — DNA admin endpoints split: a global controller (`@Authorize(['manage','all'])`) + a tenant-admin controller scoped to the caller's tenant; admin DNA PATCH enforces OCC (`@RequiresIfMatch`).
- [ ] **X9** — `broadcastSysEvent` emitted after tenant-config, department prompt-config, DNA, pipeline, and storage mutations.
- [ ] **Soft-delete** — every `delete` path (tenant, department, pipeline, user) uses `repository.softDelete()` (`resourceStatus: DELETED`); confirmed no hard deletes.
- [ ] Gates green (§4).

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
> Not started.

---

## 6. Change History
| Date | Change | Files |
|---|---|---|
| 2026-06-02 | Sub-ticket created from TASK-325 §3.7 (Phase 0). Scope = X1/X2/X5/X6/X7/X9 + soft-delete; Q2 (fix in-ticket) + Q4 (Studio super-admin-only). Status `Pending`. | this README |
