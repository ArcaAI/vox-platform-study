# TASK-305 — Multi-Tenancy Hardening

| Field | Value |
|---|---|
| **Ticket** | TASK-305-Multi-Tenancy-Hardening |
| **Created** | 2026-05-26 |
| **Updated** | 2026-05-27 |
| **Status** | `In Progress` — Wave 1 + Wave 2 (Phase A + B + D.6) merged |
| **Classification** | Refactor + bugfix (security/compliance) |
| **Priority** | High — HIPAA §164.312(a)(1), GDPR Art.32, SOC2 CC6.1 gap |
| **Prior context** | `docs/multi-tenancy-audit/01..05` (5 review docs, 2026-05-25) |
| **Companion ticket** | TASK-302 (PgBouncer + Vault role split — owns the RLS rollout for the remaining 24 tenant-scoped tables) |

---

## 1. Requirement Analysis

### 1.1 Description

Close the data-layer multi-tenancy gaps identified in the 2026-05-25 audit, scoped to what Prisma 7 can express natively. Where Prisma cannot model a constraint cleanly (cross-aggregate equality, User-tenant membership), enforce in NestJS service layer.

### 1.2 User-confirmed scope rules

1. **NO foreign-key transformation** on `tenantId` (no `@relation` back to `Tenant`). Skip B2 entirely — the audit's recommended `FOREIGN KEY (tenantId) REFERENCES core.Tenant(id)` is rejected because it bloats every Prisma model with a relation field for marginal benefit (Prisma 7's `$extends` + RLS gives stronger guarantees without the model noise).
2. **DROP the sentinel default fully**. The `'50000000-0000-0000-0000-000000000000'` default on `tenantId` is removed everywhere — not just PHI tables (audit's "bare-minimum" path was 6 tables; we go to all 30 tenant-scoped models).
3. **Prisma-native first; NestJS for the rest.** Anything Prisma 7 can express (column nullability, defaults, scoped unique constraints, composite indexes, client extensions, raw SQL migrations including RLS) goes in the schema layer. Cross-aggregate tenant equality and User-tenant membership checks live in NestJS service-layer.

### 1.3 Business context

The 5-doc audit verdict: **tenant isolation at the data layer is NOT reliable**. 0 RLS, 0 FKs back to `Tenant`, sentinel default on 27 models, 13 nullable `tenantId` fields, no tenant-aware Prisma extension. Any forgotten `where: { tenantId }` clause = cross-tenant PHI leak. HIPAA / SOC2 auditors treat this as a control-failure baseline.

### 1.4 Acceptance criteria

| # | Criterion | Verification |
|---|----|----|
| AC-1 | Zero tenant-scoped models have `@default(...)` on `tenantId` | `rg '@default\("[0-9a-f-]{8,}"\)' packages/database/src/prisma/db_main/*.prisma \| rg -v 'tenant.prisma\|seed' \| rg 'tenantId'` returns no matches |
| AC-2 | Zero tenant-scoped models have `tenantId String?` (nullable) | `rg 'tenantId\s+String\?' packages/database/src/prisma/db_main/*.prisma` returns no matches |
| AC-3 | A reserved `system` Tenant row (UUID `00000000-0000-0000-0000-000000000000`) exists and absorbs former nullable/sentinel rows | Seed test passes; migration back-fill verifies row exists |
| AC-4 | Tenant-scoped `@unique` columns are tenant-scoped (`@@unique([tenantId, X])`) where the resource is owned per tenant | Schema diff approved |
| AC-5 | Composite indexes lead with `tenantId` on hot query paths | `Consultation/ContextItem/NamedEntity` schema diff approved |
| AC-6 | A `tenantScope` Prisma `$extends` extension exists, composes with `softDeleteExtension`, and is the **default** export of `@arcaai/database` | `getExtendedPrismaClient()` returns the composed client |
| AC-7 | `getPrismaClient` (unscoped) is renamed `getPlatformAdminPrismaClient_Unscoped` and lint-guarded to allow-list directories | ESLint rule + dependency-cruiser config present |
| AC-8 | `findUnique` divergence in `softDeleteFilter` is fixed | Regression test passes |
| AC-9 | PostgreSQL RLS enabled + FORCE-ed on the 7 PHI tables with full SELECT/INSERT/UPDATE/DELETE policies | RLS migrations applied; existing `tests/pgbouncer-validation/02-rls-guc-leak.test.ts` extended and green |
| AC-10 | NestJS services assert parent-child tenant equality and User-tenant membership for all PHI-bearing creates | Cross-tenant negative tests pass for `consultation`, `context`, `notification`, `apikey`, `dna-writing-style` services |
| AC-11 | Cursor rule `02-database-prisma.mdc` no longer mandates the sentinel default | Rule diff approved |

### 1.5 Decisions locked in (audit choices)

| Decision | Choice | Rationale |
|---|----|---|
| `null tenantId` semantics | **Reserve a `system` Tenant row** (UUID `00000000-…`) and back-fill nullable rows to it | Audit § B4 recommended; single concept; works cleanly with RLS (`current_setting('app.tenant_id') = '00000000…'` for platform-admin contexts) |
| Tenant FK | **Skip** | User directive |
| RLS scope in this ticket | **7 PHI tables** (Consultation, ContextItem, AudioRecording, SummaryMeta, NamedEntity, ContextItemVersion, AuditLog) | High-value bare-minimum; TASK-302 Phase 2 owns the remaining 24 |
| `User.username`, `User.externalId` global uniques | **Keep global** | User identity is global by design (B6); cross-tenant identity is a feature |
| `StorageAccessKey.accessKeyId @unique` | **Keep global** | Used as S3-SDK identifier; naturally global |
| `StorageAccessKey.bucketIds String[]` (C3) | **Out of scope** | Independent refactor; not a multi-tenancy fix |
| `User.password / secret1 / secret2` naming (C4/C5) | **Out of scope** | Separate security review |
| `User` model split into `User` + `TenantUser` (B6) | **Out of scope** | Architectural decision; tracked separately |
| Drop `MODELS_WITHOUT_SOFT_DELETE` extras / soft-delete contract changes | **Out of scope** | Independent contract |

---

## 2. Current State Evaluation

### 2.1 Affected files / inventory

| Layer | Count | Notes |
|---|--|----|
| Prisma model files | 19 in `packages/database/src/prisma/db_main/*.prisma` | 30 tenant-scoped models; 27 with sentinel default; 13 nullable |
| Prisma client / extension | 1 (`packages/database/src/client.ts`) | Soft-delete extension lives here; tenant extension goes alongside |
| Prisma migrations | New: 4-5 migration folders | Drop defaults; NOT NULL + back-fill; scoped uniques + composite indexes; RLS enable + policies |
| Domain factories | 16 in `packages/domains/src/factories/generated/core/` | All fall back to `tenantId: props.tenantId ?? ''` — codegen template change |
| Domain base entity | 1 (`packages/domains/src/common/baseEntity/base.tenantEntity.ts`) | Public setter + no-op validate — both must change |
| NestJS service files | ~12 services | Cross-aggregate / User membership checks |
| Cursor rules | 1 (`02-database-prisma.mdc`) | Drop sentinel default guidance |
| ESLint / dep-cruiser | 1 each | Allow-list for unscoped client import |
| Seed | 1 new + 1 modified | New `system` Tenant row; existing `01-policy.ts` already references `${context.tenantId}` |
| Tests | ~20 new (cross-tenant negatives) + extension unit tests | One per service × one per blocking method |

### 2.2 Key prior-art to reuse

| Pattern | Source | Use |
|----|-----|---|
| "No existence leak" cross-tenant assert | `DepartmentService.getById:175`, `PromptManagementService:220,326`, `Stt.PipelineService:148`, `TenantBucketService:64,110,252`, `StorageAccessKeyService:50` | Copy this exact 3-line pattern to ConsultationService, ContextService, NotificationService, etc. |
| Soft-delete `$extends` shape | `packages/database/src/client.ts:180-221` | Mirror for tenantScope extension |
| PgBouncer + RLS leak test | `packages/database/tests/pgbouncer-validation/__tests__/02-rls-guc-leak.test.ts`, `07-concurrent-rls.test.ts` | Extend with policies for the 7 PHI tables |
| Encrypted audit-scrub test | `packages/applications/src/services/tenant/__tests__/tenant.service.audit-scrub-encrypted.test.ts` | Template for cross-tenant negative tests |
| `$transaction(callback)` correct usage | `TenantService.updateTenantConfigs:503-521` | Pattern for `SET LOCAL app.tenant_id` wrapping |

### 2.3 Dependencies on TASK-302

| Phase here | Depends on TASK-302 milestone | Status |
|----|-----|---|
| Phase C (RLS rollout) | DB role split (`hope_tenant_user` NOSUPERUSER NOBYPASSRLS / `hope_platform_admin` BYPASSRLS) | Tracked in TASK-302; partial |
| Phase C (RLS rollout) | PgBouncer `transaction` pool mode decision + `set_config(..., true)` rule | Tracked in TASK-302 Phase 2 |
| Phase B (extension) | `nestjs-cls` `tenantId` storage | In place via `app.module.ts:108-116` |

If TASK-302 milestones slip, Phase C lands as a follow-up; Phases A/B/D are independent.

---

## 3. Implementation Plan

> **Approval gate** — this section must be confirmed before any code is written. The phases are sequenced so each is independently shippable (one PR per phase). Estimated total effort: **~9-12 engineer-days** including tests and cross-tenant test suite.

### Phase A — Schema hardening (Prisma-native)

**Goal**: drop sentinel defaults; make `tenantId` `NOT NULL` everywhere; scope unique constraints; add composite indexes; reserve the `system` Tenant row. No domain/service code yet — just the schema substrate + the codegen contract.

**Estimate**: 1.5–2 engineer-days.

| # | Task | Verify | Size |
|---|------|----|----|
| A.1 | Add `system` Tenant seed: `Tenant { id: '00000000-0000-0000-0000-000000000000', name: 'system', key: 'system' }` in `packages/database/src/prisma/db_main/seed/05-tenant.ts` (or wherever Tenant seeds live) | `pnpm db:seed` populates the row; migration test inserts it idempotently | S |
| A.2 | Write back-fill SQL: `UPDATE core."X" SET "tenantId" = '00000000-…' WHERE "tenantId" IS NULL OR "tenantId" = '50000000-…'` for each tenant-scoped table (audit + count rows per table first) | Pre-migration row-count vs. post; CI flag if mismatch | M |
| A.3 | For 27 models: remove `@default("50000000-…")` on `tenantId` | Schema diff; affected files | M |
| A.4 | For 13 nullable models: change `tenantId String?` → `tenantId String` | Schema diff; affected files | S |
| A.5 | Composite uniques: `Webhook.name @unique` → `@@unique([tenantId, name])` (rename constraint to `Webhook_tenantId_name_unique`) | Schema diff; `Webhook` migration SQL | S |
| A.6 | Composite uniques: `Tag` — add `@@unique([tenantId, resourceTypeName, resourceId, tagKey])` and `@@index([tenantId, resourceTypeName, resourceId])` (no prior unique) | Schema diff | S |
| A.7 | Replace single-column tenant-leading indexes with composites where audit § C1 calls them out: `Consultation`: `@@index([doctorId])` → `@@index([tenantId, doctorId])`; `@@index([departmentId])` → `@@index([tenantId, departmentId])`; same for `ContextItem`, `NamedEntity`, `SummaryMeta`, `AudioRecording` | Schema diff; review with planner output | M |
| A.8 | Generate migration `20260527000000_multi_tenancy_phase_a` containing back-fill + ALTER COLUMN SET NOT NULL + DROP DEFAULT + scoped uniques + composite indexes (single migration; transactional) | `prisma migrate dev` succeeds locally; SQL reviewed | M |
| A.9 | Update cursor rule `.cursor/rules/02-database-prisma.mdc` § "Standard Model Field Ordering": change step 2 from `tenantId with default "50000000-…"` → `tenantId String (NOT NULL, no default) — provided by the factory or repository scope` | Rule diff | S |
| A.10 | Codegen template change: in domain factories codegen, drop `?? ''` fallback on `tenantId`; make signature require `tenantId: string` (non-optional, non-null) | 16 factories regenerated; signature changed | M |
| A.11 | Regenerate domain layer (`packages/domains/src/factories/generated/core/*.ts`, `entities/generated/core/*.ts`, `mappers/generated/core/*.ts`, `models/generated/core/*.ts`, `repositories/generated/core/*.ts`) | `pnpm build --filter @arcaai/domains` succeeds | M |
| A.12 | Fix every call-site that omits or passes `undefined` for `tenantId` (likely BullMQ processors, tests, seeds) | `pnpm build` succeeds across the monorepo; `pnpm typecheck` clean | M |
| A.13 | `BaseTenantEntity` hardening: make `set tenantId` `protected`; remove `set Tenant` (or make `protected`); `validate()` throws if `tenantId` is empty | Unit test pins behavior | S |

**Phase-A gate**:
- [ ] All migrations apply cleanly to a fresh DB and to the staging DB
- [ ] `pnpm build`, `pnpm typecheck`, `pnpm lint` pass for the whole monorepo
- [ ] Zero `??\s*''` occurrences for `tenantId` across `packages/domains` and `packages/applications`
- [ ] Cursor rule diff merged
- [ ] PR description includes back-fill row counts (pre vs post)

---

### Phase B — Tenant-aware Prisma `$extends` (Prisma-native)

**Goal**: ship a Prisma 7 client extension that injects `tenantId` from `nestjs-cls` AsyncLocalStorage on every read and asserts equality on every write. Make it the default. Restrict the unscoped client.

**Estimate**: 2–3 engineer-days.

| # | Task | Verify | Size |
|---|------|----|----|
| B.1 | New file `packages/database/src/extensions/tenant-scope.ts` exporting `applyTenantScopeExtension(prisma)` (mirroring `applySoftDeleteExtension`) | Module compiles; exported from `client.ts` | M |
| B.2 | Inside the extension, define an allow-list of tenant-scoped Prisma model names (Pascal + camel) — initially the 30 models from the audit | Unit test enumerates the list | S |
| B.3 | For `findFirst / findMany / findUnique / count / aggregate / groupBy` on allow-listed models: merge `where: { tenantId: ctxTenantId }` (preserving caller's other filters). Reject if `ctxTenantId` is null/undefined and not in `BYPASS` context | Unit test: missing CLS → throws; mismatched CLS → returns zero | M |
| B.4 | For `create / createMany / upsert`: ensure `data.tenantId === ctxTenantId`; auto-inject when missing | Unit test: cross-tenant `create` → throws `ForbiddenError` | M |
| B.5 | For `update / updateMany / delete / deleteMany`: merge `where` with `tenantId: ctxTenantId`; reject `data.tenantId` mutations | Unit test: cross-tenant `update` → 0 rows; explicit `data.tenantId` mutation → throws | M |
| B.6 | Wrap `$transaction` (callback form): call `SELECT set_config('app.tenant_id', $1, true)` (`true` = LOCAL) as the first statement of every transaction | Integration test: `set_config` row present in `pg_stat_statements`; existing PgBouncer leak test extended | M |
| B.7 | Provide a `BYPASS` mechanism: `withTenantBypass(() => …)` that uses `cls.runWith({ tenantBypass: true })`. Allowed in migrations and platform-admin routes only | Unit test: bypass path returns all-tenant rows | S |
| B.8 | Compose: `createExtendedPrismaClient()` returns `prisma.$extends(softDelete).$extends(tenantScope)` (order matters — tenant first means soft-delete sees a tenant-filtered table) | Integration test pins the chain | S |
| B.9 | Rename in `client.ts`: `getPrismaClient` → `getPlatformAdminPrismaClient_Unscoped`; add JSDoc warning; keep an alias re-export with `@deprecated` for one release window | Symbol diff | S |
| B.10 | Update `index.ts` exports; update every importer in the monorepo (migrations, seed, admin routes — small allow-list) | `pnpm build` clean | M |
| B.11 | Add ESLint custom rule (or `dependency-cruiser` config) banning `getPlatformAdminPrismaClient_Unscoped` import outside an allow-list: `packages/database/src/prisma/db_main/seed/**`, `apps/api/src/modules/admin/**` (specific platform-admin endpoints), `packages/database/src/migrations-runner.ts` | Lint fails on test fixture importing from a non-allowed path | M |
| B.12 | **Fix `findUnique` divergence** in `softDeleteExtension` (`client.ts:197-199`): call `applySoftDeleteFilter(args)` if `modelHasSoftDelete(model)`. Add regression test (`__tests__/client.softDelete.findUnique.test.ts`) | Regression test confirms `findUnique({ where: { id, resourceStatus: 'DELETED' } })` no longer leaks | S |

**Phase-B gate**:
- [ ] `tenantScope` extension test suite green (≥ 10 cases)
- [ ] All existing repository tests still pass with the extension wired in
- [ ] Lint rule for unscoped client import passes locally and in CI
- [ ] `findUnique` regression test added and green
- [ ] No new `.eslintrc-disable` for the new rule outside the documented allow-list

---

### Phase C — PostgreSQL RLS on PHI tables (Prisma raw migrations)

**Goal**: enable `ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` with full per-operation policies on the 7 PHI tables. Hand off the remaining 24 tables to TASK-302 Phase 2.

**Estimate**: 2–3 engineer-days (depends on TASK-302 role-split being green).

| # | Task | Verify | Size |
|---|------|----|----|
| C.1 | Verify TASK-302 milestone: `hope_tenant_user` role exists with `NOSUPERUSER, NOBYPASSRLS`; `hope_platform_admin` exists with `BYPASSRLS`; Vault dynamic creds inherit `hope_tenant_user`. If not present, block Phase C; otherwise continue | Manual psql verification + TASK-302 cross-reference | — |
| C.2 | New migration `20260601000000_enable_rls_phi_tables/migration.sql`. For each of the 7 PHI tables (`Consultation`, `ContextItem`, `AudioRecording`, `SummaryMeta`, `NamedEntity`, `ContextItemVersion`, `AuditLog`): `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` | Migration SQL reviewed; runs against staging DB | M |
| C.3 | Same migration: per table, four policies — `tenant_select`, `tenant_insert WITH CHECK`, `tenant_update USING + WITH CHECK`, `tenant_delete USING`. Predicate: `"tenantId" = current_setting('app.tenant_id', true)::text` (use text, not uuid cast — sentinel removed but Prisma generates text for `String`) | Policy bodies reviewed | M |
| C.4 | Same migration: lock down `AuditLog` per audit § C2 — `REVOKE UPDATE, DELETE ON core."AuditLog" FROM hope_tenant_user`; document a `platform_audit_admin` role used by compliance officers (created here, granted SELECT only) | SQL reviewed; runbook updated | S |
| C.5 | Extend `packages/database/tests/pgbouncer-validation/__tests__/02-rls-guc-leak.test.ts` to cover the 7 PHI tables (4 ops × 7 tables = 28 new assertions) | `pnpm test --filter pgbouncer-validation` green | M |
| C.6 | Add `pgbouncer-validation/__tests__/08-rls-phi-tables.test.ts` covering each PHI table's policies directly (independent of the GUC-leak test which is leak-focused) | Test green | M |
| C.7 | Update `vault-admin-bootstrap.sql` (or add a manual SQL companion) to grant `SELECT, INSERT, UPDATE, DELETE` on the 7 tables to `hope_tenant_user`; document the `hope_platform_admin` BYPASSRLS contract | Bootstrap SQL diff reviewed | S |
| C.8 | Update `docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md` with a back-reference to TASK-305 RLS scope (7 tables) and the handoff for the remaining 24 | Cross-doc link present | S |

**Phase-C gate**:
- [ ] All RLS policies present and `FORCE`-d (`SELECT * FROM pg_policies WHERE schemaname = 'core'`)
- [ ] PgBouncer leak suite green
- [ ] Smoke test: `psql` as `hope_tenant_user` without `SET LOCAL app.tenant_id` returns **zero rows** on each PHI table (silent isolation)
- [ ] Smoke test: `psql` as `hope_tenant_user` with `SET LOCAL app.tenant_id = '<tenant-A>'` returns only tenant-A rows
- [ ] Smoke test: `UPDATE … SET tenantId = '<other>'` on a tenant-A row throws via `WITH CHECK` (cross-tenant transfer blocked)

---

### Phase D — NestJS service-layer guards (where Prisma can't enforce)

**Goal**: enforce the constraints Prisma cannot model cleanly — cross-aggregate tenant equality (parent.tenantId vs child.tenantId) and User-tenant membership (consultation.doctorId must have UserRoleAssignment in consultation.tenantId).

**Estimate**: 2–3 engineer-days.

| # | Task | Verify | Size |
|---|------|----|----|
| D.1 | Create shared helper `packages/applications/src/services/common/tenant-guards.ts` exporting `assertEqualTenants(parent, child)`, `assertUserBelongsToTenant(userRoleAssignmentRepo, userId, tenantId)`, `assertParentInScope(repo, parentId, callerTenantId)` | Helper unit tests | S |
| D.2 | `consultation.service.ts`: in `createConsultation` and `createRevisit`, call `assertUserBelongsToTenant(doctorId, this.tenantId)` and (for revisit) `assertEqualTenants(parent, request)` | Service unit tests: cross-tenant doctor → NotFound; cross-tenant parent → NotFound | M |
| D.3 | `consultation.service.ts`: in `getById`, `getByIdWithRelations`, `getConsultationChain`, mirror the `DepartmentService` pattern — `if (entity.tenantId !== this.tenantId) throw NotFoundException` | Unit tests | M |
| D.4 | `context.service.ts`: in every method that loads `ContextItem` or `Consultation` by id, add the same equality check. For `findSharedContext(consultationIds)`, ensure every id resolves within `this.tenantId` (or strip from result) | Unit tests | M |
| D.5 | `notification.service.ts`, `apikey.service.ts`, `dna-writing-style.service.ts`: at create / fetch time, call `assertUserBelongsToTenant` for any User reference | Unit tests | M |
| D.6 | `department.service.ts`: in `create/update`, when `parentDepartmentId` set, call `assertEqualTenants(parent, child)` | Unit test | S |
| D.7 | `userRoleAssignment.service.ts`: in `create`, force `request.tenantId = this.tenantId` (or throw `ForbiddenException` if mismatch) — closes audit § C6 | Unit test: cross-tenant POST → 403 | S |
| D.8 | `auditLog.service.ts` + `authorization-audit.service.ts`: inject `this.tenantId` into the default `where` of `fetchAll / fetchAllByResource / fetchAllCreatedByUser / fetchById / deleteById / getAuthorizationHistory / getRecentDenials`. Skip injection only when the caller has `SUPER_ADMIN` role (CLS) | Unit test: non-super-admin fetch returns only own-tenant rows | M |
| D.9 | BullMQ + `OnEvent` rebinding: `SummaryProcessor`, `NerProcessor`, `PreSummaryProcessor`, `ComprehensiveSummaryProcessor`, `ConsultationEventHandler`, `AuditLogProcessor` — wrap the handler body in `cls.run({ tenantId: job.data.tenantId, … }, () => handle())` so `BaseService.tenantId` is populated and the Phase-B extension's CLS lookup sees the right context. Also assert `entity.tenantId === job.data.tenantId` after `findById` to catch poisoned jobs | Unit + integration tests | M |
| D.10 | Repository hardening: remove `Repository.rawQueryUnsafe` and `Repository.$bulk` from public surface (rename to `_internalRawUnsafe` and move behind a `PlatformAdminRepository` base class used only by allow-listed services) | Build clean; lint rule added | M |

**Phase-D gate**:
- [ ] All cross-aggregate / User-membership tests green
- [ ] `tenant-guards.ts` helper has ≥ 95% line coverage
- [ ] BullMQ processors test fixture: poisoned job (tenantId mismatch) → dead-letter, not silent write
- [ ] Audit-log fetch suite: non-super-admin → tenant-scoped result; super-admin → all-tenant result
- [ ] `rg 'rawQueryUnsafe\|\\$bulk' packages/applications/` returns no matches

---

### Phase E — Cross-tenant negative test suite + documentation

**Goal**: pin the desired behavior so future regressions surface in CI.

**Estimate**: 1.5–2 engineer-days.

| # | Task | Verify | Size |
|---|------|----|----|
| E.1 | Test scaffold `tests/cross-tenant/fixtures.ts` creating tenant-A and tenant-B sessions + seed data | Fixture compiles; used by all new tests | S |
| E.2 | One negative test per tenant-scoped service (≈ 15 tests): "tenant A token reading tenant B id returns NotFoundException; mutating tenant B id is no-op or throws" | Vitest run green | M |
| E.3 | One negative test per BullMQ processor (≈ 6 tests): "job with tenantId mismatch hits the assert and goes to DLQ; does not write the wrong tenant" | Vitest run green | M |
| E.4 | Extend `tests/pgbouncer-validation` per Phase C.5/C.6 (covered above; this row is the documentation cross-link) | — | — |
| E.5 | Update `packages/database/README.md`: section "Tenant scoping & RLS posture" (what the extension does, when to use the unscoped client, RLS rollout status, sample `SET LOCAL`) | README diff | S |
| E.6 | Update `docs/technical-architecture-overview.md`: add chapter "Multi-tenancy enforcement layers" with the 3-layer model (schema NOT NULL + scoped uniques → Prisma extension → RLS) and the user-decision log from § 1.5 | Doc diff | S |
| E.7 | Create `docs/multi-tenancy-audit/06-implementation-summary.md` capturing which audit findings shipped here vs. which were deferred / out-of-scope (FK transformation, User split, secrets refactor, bucketIds refactor) | Doc present; links from each audit doc | S |
| E.8 | Update this `README.md` § 5 Implementation Summary with files changed, migrations, deviations | This README updated | S |

**Phase-E gate**:
- [ ] All new tests green in CI
- [ ] Docs reviewed by compliance officer (or product lead) and signed off
- [ ] Audit § 6 summary doc is the canonical record of what was done

---

## 4. Testing strategy

### 4.1 Test types and ownership

| Test type | Where | Phase |
|----|-----|---|
| Schema migration tests | `packages/database/tests/` | A |
| Extension unit tests | `packages/database/src/extensions/__tests__/` | B |
| Soft-delete `findUnique` regression | `packages/database/src/__tests__/client.softDelete.findUnique.test.ts` | B |
| RLS policy SQL tests | `packages/database/tests/pgbouncer-validation/__tests__/` | C |
| Service-layer cross-tenant negatives | `packages/applications/src/services/**/__tests__/cross-tenant.*.test.ts` | D + E |
| BullMQ processor cross-tenant negatives | `packages/applications/src/services/**/__tests__/processor-cross-tenant.test.ts` | D + E |
| Integration test for `$transaction` `SET LOCAL` | `packages/database/tests/pgbouncer-validation/__tests__/09-set-local-tx.test.ts` | B + C |

### 4.2 TDD ordering per phase

Strict Red-Green-Refactor:
- Phase A: write the migration-back-fill verification test first (RED), then the schema change (GREEN)
- Phase B: write the cross-tenant create-throws test first (RED), then the extension code (GREEN)
- Phase C: write the `psql` policy assertion test first (RED), then the RLS migration (GREEN)
- Phase D: write the cross-tenant negative service test first (RED), then add the guard (GREEN)
- Phase E: tests ARE the deliverable

### 4.3 Manual verification checklist (each phase)

| # | Step |
|---|---|
| 1 | `pnpm build` (whole monorepo) — clean |
| 2 | `pnpm typecheck` — clean |
| 3 | `pnpm lint` — clean |
| 4 | `pnpm test:unit` — green |
| 5 | `pnpm test:integration` (where present) — green |
| 6 | `pnpm test:e2e` (apps/api) — green |
| 7 | `pnpm db:migrate` on a fresh DB — applies cleanly |
| 8 | Capture row-count diff for back-fill migrations and paste into the PR |

---

## 5. Files to create / modify (consolidated)

### Create

```
packages/database/src/extensions/tenant-scope.ts
packages/database/src/extensions/__tests__/tenant-scope.test.ts
packages/database/src/__tests__/client.softDelete.findUnique.test.ts
packages/database/src/prisma/db_main/migrations/20260527000000_multi_tenancy_phase_a/migration.sql
packages/database/src/prisma/db_main/migrations/20260601000000_enable_rls_phi_tables/migration.sql
packages/database/src/prisma/db_main/migrations/20260605000000_lockdown_auditlog/migration.sql
packages/database/src/prisma/db_main/seed/05-system-tenant.ts        (or equivalent)
packages/database/tests/pgbouncer-validation/__tests__/08-rls-phi-tables.test.ts
packages/database/tests/pgbouncer-validation/__tests__/09-set-local-tx.test.ts
packages/applications/src/services/common/tenant-guards.ts
packages/applications/src/services/common/__tests__/tenant-guards.test.ts
docs/multi-tenancy-audit/06-implementation-summary.md
tests/cross-tenant/fixtures.ts
tests/cross-tenant/<one per service>.test.ts                          (~15 files)
```

### Modify

```
packages/database/src/prisma/db_main/*.prisma                         (19 files)
packages/database/src/client.ts
packages/database/src/index.ts
packages/database/src/prisma/db_main/manual/vault-admin-bootstrap.sql
packages/domains/src/factories/generated/core/*.ts                    (16 factories — via codegen)
packages/domains/src/common/baseEntity/base.tenantEntity.ts
packages/applications/src/services/consultation/consultation/consultation.service.ts
packages/applications/src/services/consultation/context/context.service.ts
packages/applications/src/services/auditLog/auditLog.service.ts
packages/applications/src/services/audit/authorization-audit.service.ts
packages/applications/src/services/user/userRoleAssignment/userRoleAssignment.service.ts
packages/applications/src/services/notification/notification.service.ts
packages/applications/src/services/apikey/apikey.service.ts
packages/applications/src/services/dna-writing-style/dna-writing-style.service.ts
packages/applications/src/services/department/department.service.ts
packages/applications/src/services/consultation/jobs/processors/*.processor.ts  (6 files)
packages/domains/src/common/repository.ts                             (rawQueryUnsafe move)
.cursor/rules/02-database-prisma.mdc
eslint.config.mjs                                                     (+ dep-cruiser if used)
docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md
docs/technical-architecture-overview.md
packages/database/README.md
```

---

## 6. Dependencies

| Dependency | Where | Status |
|---|---|---|
| TASK-302 Phase 2: `hope_tenant_user` role (`NOSUPERUSER NOBYPASSRLS`) + `hope_platform_admin` (`BYPASSRLS`) | Phase C of this ticket | Tracked, partial |
| TASK-302 Phase 2: PgBouncer `transaction` mode with `server_reset_query = DISCARD ALL` (or session mode with documented connection cap) | Phase C | Tracked |
| `nestjs-cls` mounted at API edge (`app.module.ts:108-116`) | Phase B (extension reads from CLS) | In place |
| Existing PgBouncer leak harness (`packages/database/tests/pgbouncer-validation/`) | Phase C | In place |
| Existing soft-delete extension shape (`packages/database/src/client.ts:180-221`) | Phase B template | In place |

---

## 7. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| `SET` (session-scope) used somewhere instead of `SET LOCAL` (txn-scope) under PgBouncer transaction mode → cross-request tenant leak | HIGH | Phase B.6 wraps `$transaction` only; Phase C.5/C.6 leak-tests gate the PR; `pgbouncer.org/config.html` rule documented in `02-database-prisma.mdc` |
| Back-fill mis-attributes orphan rows to `system` Tenant (loss of provenance) | MEDIUM | Phase A.2 dumps a CSV of every back-filled row before migration; CI requires the CSV to be reviewed; rollback playbook in `_section-d-backfill-proposal.md` style |
| Compile fan-out: tightening factories breaks ~30 call sites; we miss one | MEDIUM | Phase A.10–A.12 strict TypeScript checks; `pnpm typecheck` in CI; Vitest replays for each affected service |
| RLS performance regression on PHI tables (Consultation has 8 indexes already; adding policies adds a planner filter) | MEDIUM | Phase A.7 pre-emptively adds `[tenantId, X]` composites; pgvector/STT vector indexes unchanged; benchmark before/after on staging |
| `getPlatformAdminPrismaClient_Unscoped` rename breaks a downstream we missed | LOW | Phase B.9 keeps `@deprecated` alias for one release; lint warns at import site |
| `User` model has no tenantId — User-membership check via `UserRoleAssignment` is O(1) but allocates a query per write | LOW | Cache assignment lookups in CLS for the request lifetime; reduces to 1 lookup per consultation create |
| `system` Tenant row's RLS policy semantics — does a SUPER_ADMIN context see system rows + their own tenant rows? | LOW | Phase C policy bodies handle by allowing `current_setting('app.tenant_id')` to be `'00000000-…'` OR by using the `BYPASS` mechanism for super-admin routes |

---

## 8. Out of scope (and tracked elsewhere)

| Audit item | Status | Where it goes |
|---|----|---|
| B2 — FK from tenant-scoped tables → `Tenant` (`@relation`) | **Excluded per user directive** | n/a — not pursued |
| B6 — User model split (`User` + `TenantUser`) | Deferred | Separate architectural ticket |
| C3 — `StorageAccessKey.bucketIds String[]` array → m:n join | Deferred | Independent refactor ticket |
| C4 / C5 — `User.password`, `User.secret1`, `User.secret2` naming + encryption | Deferred | Security review ticket |
| C9 — `TranscriptionJob.consultationId/contextItemId/mediaId` plain-string FKs | Deferred (user directive applies — no FK transformation) | Service-level cross-tenant assert in Phase D covers the read-side risk |
| RLS rollout to the remaining 24 tenant-scoped tables | Handed off | TASK-302 Phase 2 / Phase 3 |
| SDK side (audit doc 05) — module-level Zustand singleton, IDB key scoping, WS dedup | **Out of scope** of TASK-305 | Separate SDK ticket (TASK-306 candidate) |
| API side (audit doc 04) — refresh-token forgery, opt-in auth guard, placeholder JWT secret | **Out of scope** of TASK-305 | Separate API security ticket (TASK-307 candidate) |

---

## 9. Success criteria (final gate)

- [ ] All AC-1 .. AC-11 met with evidence pasted into the PR
- [ ] All Phase gates green
- [ ] No new lint errors anywhere in the monorepo
- [ ] All migrations applied cleanly to staging
- [ ] PgBouncer RLS leak suite green
- [ ] Cross-tenant negative test suite green (≥ 20 tests)
- [ ] `docs/multi-tenancy-audit/06-implementation-summary.md` written and links from each audit doc
- [ ] `TASK-302` cross-ref updated with the 7-table RLS handoff
- [ ] Code reviewer subagent (`code-reviewer`) signs off on the final diff
- [ ] Compliance / product lead signs off on the AC delta

---

## 10. Open questions for the user

These do not block plan approval — they can be answered during execution. Listed here so they don't get lost.

1. **`system` Tenant row's RLS behavior** — should a request running under the platform-admin role see (a) only system-tenant rows when `app.tenant_id = '00000000-…'`, or (b) all rows via the `BYPASS` mechanism? The plan codes path (b) by default (platform admin uses `BYPASS`, regular `system` tenant context sees system rows only); confirm before Phase C.
2. **`pnpm typecheck` script name** — the plan assumes this exists at the monorepo root. If the actual script is different (`turbo run typecheck`?), the Phase-A.12 verification line needs updating.
3. **`MaintenanceMode` interceptor and tenant context** — should maintenance mode be per-tenant (single tenant in maintenance) or global? Out of scope of this ticket, but adjacent. Flag for follow-up.

---

## 5. Implementation Summary *(filled in at completion)*

*Pending plan approval.*

## 6. Implementation Summary (rolling)

### Wave 1 — quick fixes + service-layer guards (all 5 merged into `fix/2605-review`)

| Sub-task | Branch | Merge | Verdict | Highlights |
|---|---|---|---|---|
| W1.1 — B.12 soft-delete `findUnique` fix + A.9 cursor rule | `task-305/w1-quickwins` | `df3a214` | APPROVED | `findUnique` now applies `applySoftDeleteFilter`; cursor rule drops sentinel default guidance |
| W1.2 — D.1 `tenant-guards` helper | `task-305/w1-tenant-guards` | `afacbf4` | APPROVED | `assertEqualTenants` / `assertUserBelongsToTenant` / `assertParentInScope` in `packages/applications/src/common/tenant-guards.ts`; 26 unit tests |
| W1.3 — D.7 `userRoleAssignment.create` pins `tenantId` to CLS | `task-305/w1-userrole-fix` | `f9a4fcc` | APPROVED | Closes audit C-6 BLOCKER (cross-tenant role assignment); SUPER_ADMIN bypass preserved |
| W1.4 — D.8 `AuditLog` + `AuthorizationAudit` tenant scoping | `task-305/w1-auditlog-scoping` | `6fef53b` | APPROVED | All `fetch*` / `delete*` inject CLS `tenantId`; closes HIPAA §164.312(b) gap; 20 new cross-tenant negative tests |
| W1.5 — D.10 remove unsafe `rawQueryUnsafe` + `$bulk` from `Repository` | `task-305/w1-repo-cleanup` | `74eb315` | APPROVED | Zero external consumers (grep-verified); shrinks `IRepository` public surface |

### Wave 2 — schema + tenant-scope extension + cross-aggregate guard (3 in parallel, all merged)

| Sub-task | Branch | Merge | Verdict | Highlights |
|---|---|---|---|---|
| W2.D6 — Department parent cross-tenant check | `task-305/w2-d6-department` | `1907862` | APPROVED-WITH-MINOR-NITS | `create`/`update` route `parentDepartmentId` through `assertParentInScope`; SUPER_ADMIN does NOT bypass (structural correctness); +6 tests |
| W2.A — Phase A schema hardening (A.1-A.9) | `task-305/w2-phase-a` | `fb05891` | APPROVED-WITH-FOLLOWUP | 13 `.prisma` files: drop sentinel `@default`, 11 nullable→NOT NULL, scoped uniques on `Tag`/`Webhook`, 14 composite `[tenantId, X]` indexes; new `SYSTEM_TENANT_ID` seed; idempotent back-fill migration; 24 factories drop `?? ''` fallback; `BaseTenantEntity` setter `protected`, `validate()` throws on empty; `super.validate()` chained in 21 subclasses; +12 domain tests |
| W2.B — Tenant-scope `$extends` + rename + lint guard | `task-305/w2-phase-b` | `a839fb8` | APPROVED-WITH-FOLLOWUP | New `packages/database/src/extensions/tenant-scope.ts` (27-model allow-list, all 16 Prisma ops hooked, bidirectional mismatch detection); composed on top of soft-delete; `getPrismaClient` → `getPlatformAdminPrismaClient_Unscoped` with 8-site ESLint allow-list; `ClsTenantContextProvider` wires `nestjs-cls`; +48 unit tests, +6 provider tests |
| W2 follow-up — A.8 latent typecheck fixes | (direct on `fix/2605-review`) | `2bfc125` | self-applied | W2.A reviewer + agent both ran typecheck against stale `@arcaai/domains` dist; 2 call sites missed `tenantId`. Surfaced by W3.2 agent's clean-dist typecheck. Fixed: `auditLog.service.ts` LOGIN audit uses SYSTEM_TENANT_ID fallback (platform-level event); `resourceSubscription.service.ts` adds fail-closed `BadRequestException` guard + `this.tenantId`. |

### Wave 3 — service-layer cross-aggregate guards + queue/event CLS rebind

| Sub-task | Branch | Merge | Verdict | Highlights |
|---|---|---|---|---|
| W3.1 — D.2/D.3/D.4 Consultation + Context + Summary cross-aggregate checks | `task-305/w3-consultation-context-summary` | `9d1921d` | APPROVED | `ConsultationService` `getOrCreate`/`createRevisit` assert `parentConsultationId`/`departmentId`/`doctorId` in same tenant; `ContextService` 5 mutation paths assert parent + array fields (`caseNoteIds`, `preSummaryIds`, etc.) in tenant; `SummaryService` 5 mutations + `ChainSummaryService.generateComprehensiveSummary` assert chain. No SUPER_ADMIN bypass on PHI services. +24 cross-tenant tests. Closes audit C-1/C-2/C-3/C-4 + M-7. |
| W3.2 — D.5 Notification + ApiKey + DnaWritingStyle | `task-305/w3-notification-apikey-dna` | `9028759` | APPROVED-WITH-FOLLOWUP | `NotificationService` recipient + resource same-tenant check; `ApiKeyService` user-belongs-to-tenant + DTO `tenantId` pinning (SUPER_ADMIN bypass allowed for cross-tenant issuance); `DnaWritingStyleService` doctor + report assertion (STRICT no-SUPER_ADMIN-bypass — PHI). +36 cross-tenant tests. Closes audit C-5/C-8/C-9 + B10 (partial) + M-1 (partial). Reviewer flagged 2 follow-ups (see §6.7). |
| W3.3 — D.9 BullMQ processors CLS rebind (4 of 6) | `task-305/w3-bullmq-cls-rebind` | `21115ed` | APPROVED-WITH-FOLLOWUP | `Summary`/`PreSummary`/`ComprehensiveSummary`/`Ner` processors wrap `process()` in `cls.run` with `tenantId` + `user` (`roles: []`, never SUPER_ADMIN); fail-closed throw if `job.data.tenantId` missing (BullMQ DLQ semantics); `assertEqualTenants` on loaded entity vs. job payload. +12 cross-tenant tests. Reviewer flagged 2 remaining handlers as follow-up. |
| W3.3 follow-up — D.9 AuditLog + ConsultationEventHandler (6 of 6) | `task-305/w3-cls-rebind-followup` | `1839163` | APPROVED | `AuditLogProcessor`: same CLS rebind pattern, fail-closed throw, no `assertEqualTenants` (write-only). `ConsultationEventHandler`: 3 `@OnEvent({ async: true })` handlers wrap body in `cls.run` from `payload.tenantId`; fail-closed log + early `return` (not throw, because `@OnEvent` swallows). Prettier nit on `summary.processor.ts:198`. +9 tests. Closes the Phase B "no CLS = super-admin pass-through" gap for queue workers + event handlers. |

**Phase C (RLS) — DEFERRED to Wave 4 or later.** Depends on TASK-302 (PgBouncer/Vault streams) which is still Pending. The Phase B `tenantScope` extension + Phase D guards together provide application-layer isolation today; RLS would add a defense-in-depth DB-layer policy.

### Cumulative test deltas (vs Wave-0 baseline)

| Package | Before | After Wave 3 (all merged) |
|---|---|---|
| `@arcaai/domains` | 1019 / 2 skipped / 9 todo | **1031 / 2 skipped / 9 todo** (unchanged from W2) |
| `@arcaai/applications` | 4082 / 4 skipped | **4190 / 4 skipped** (+108 from W1 + W2 + all of W3) |
| `@arcaai/database` (unit) | 525 / 10 files | **573 / 12 files** (unchanged from W2) |
| `apps/api` | 1157 / 59 files | **1163 / 60 files** (unchanged from W2) |

### Tracked follow-ups (NOT blocking Wave 3 merge, scheduled separately)

1. **Architectural** — `User` / `UserMedia` should not extend `BaseTenantEntity` (current `tenantId: ''` placeholder is documented but re-introduces a sentinel-by-empty-string pattern). Recommend introducing `BaseGlobalEntity` or extending `BaseAggregate` directly.
2. **Operational** — Before applying the Phase A migration to staging/prod, run pre-flight duplicate checks on `Tag (tenantId, resourceTypeName, resourceId, tagKey)` and `Webhook (tenantId, name)` — back-fill may consolidate previously-NULL rows into the system tenant and trip the new uniques.
3. **Index hygiene** — Drop redundant single-column `@@index([tenantId])` declarations where superseded by composites leading with `tenantId`. ~13 indexes affected; pure write-throughput optimization.
4. **`.baseClient` audit** — `UnitOfWork.transactionClient` (2 sites in `packages/domains` and `packages/applications`) + `tenant.service.ts:534` still go through the unscoped `baseClient`. UnitOfWork should switch to `databaseService.client.$transaction(callback)` — Prisma 7 carries `$extends` into the `tx` parameter.
5. **`CoreDataModel` wildcard re-export removal** — `core.database.types.ts` re-exports `getPlatformAdminPrismaClient_Unscoped` via `export * as CoreDataModel from '@arcaai/database'`. No consumers today; the ESLint rule's `importNames` doesn't follow wildcard re-exports, so it's a latent footgun. Remove in a follow-up commit.
6. **~~Phase D.9 BullMQ wrapper~~ — CLOSED (W3.3 + D.9 follow-up).** All 6 queue/event handlers now rebind CLS context.
7. **NotificationService SUPER_ADMIN posture inconsistency (NEW from W3.2 review)** — `NotificationService.buildTenantWhere`/`assertTenantOwnership`/`resolveEffectiveTenantId` allow SUPER_ADMIN cross-tenant access while the parallel DNA service (also PHI-derived) explicitly refuses. Decide: (a) tighten Notification to match DNA's no-bypass posture, or (b) keep current behavior and add structured audit-log emission whenever SUPER_ADMIN crosses tenant for notifications.
8. **Pre-existing `fetchAllByTenantId` gaps (NEW from W3.2 review)** — `NotificationService.fetchAllByTenantId` and `ApiKeyService.fetchAllByTenantId` accept arbitrary DTO `tenantId` with no CLS comparison. `DnaWritingStyleService.listReports` lets global-role callers with no CLS `tenantId` read all DNA reports across all tenants. Separate ticket — predates W3.2 work.
9. **Housekeeping (NEW from D.9 follow-up review)** — `packages/applications/src/services/auditLog/__tests__/auditLog.processor.spec.ts` is silently dead (vitest/typecheck/eslint all skip `.spec.ts` in `__tests__/`). Should be deleted or renamed to `.test.ts` and merged with the new `auditLog.processor.test.ts`.
10. **Soft typing (NEW from W3.3 + D.9 reviews)** — `as unknown as UserSession` cast pattern reused 8× in queue/event processors. `UserSession` requires `email: string` (non-optional) which queue workers don't have. Introduce a `WorkerSession` subtype or `Partial<UserSession>` to clean up.
11. **Documentation** — Mark `docs/multi-tenancy-audit/02-prisma-schema-review.md` B3 / B4 / B5 entries as "Closed (TASK-305 W2.A)" and C-7 / C-4 entries as "Closed (TASK-305 W2.D6 / D.7 / D.8)" in a doc-only commit. (Some of this is covered in Phase E.7.)

---

## 7. Change History

| Date | Description | Files modified |
|---|----|----|
| 2026-05-26 | Initial plan drafted; awaiting approval | `docs/implementation/TASK-305-Multi-Tenancy-Hardening/README.md` |
| 2026-05-27 | Wave 1 merged — 5 sub-tasks (W1.1 quickwins, W1.2 tenant-guards, W1.3 userRole pin, W1.4 audit-log scoping, W1.5 repo cleanup) | `packages/database/`, `packages/applications/`, `packages/domains/`, `.cursor/rules/02-database-prisma.mdc` |
| 2026-05-27 | Wave 2 merged — Phase A (schema hardening) + Phase B (tenant-scope extension) + D.6 (department parent check). Implementation Summary added (§6). | See per-task table in §6 |
| 2026-05-27 | Plan README committed to `fix/2605-review` (had been untracked since planning) + W1.1 follow-up: integration test assertions updated to match new `findUnique` soft-delete behavior | `docs/implementation/TASK-305-Multi-Tenancy-Hardening/README.md`, `packages/database/src/integration/soft-delete.integration.test.ts` |
| 2026-05-27 | Wave 3 partial — W3.1 (D.2/D.3/D.4 consultation+context+summary), W3.3 (D.9 4 of 6 processors), D.9 follow-up (AuditLogProcessor + ConsultationEventHandler) merged. W3.2 (D.5 notification/apikey/dna) implemented + reviewer in flight. Phase A follow-up (2 latent typecheck fixes) merged. | `packages/applications/src/services/consultation/`, `packages/applications/src/services/auditLog/auditLog.processor.ts`, `packages/applications/src/services/resourceSubscription/resourceSubscription.service.ts`, see §6 W3 table |
| 2026-05-27 | Wave 3 complete — W3.2 (D.5) merged. All §D.* service-layer cross-tenant guards in place; §D.9 6/6 queue/event handlers rebound. Phase C (RLS) deferred — depends on TASK-302 (PgBouncer/Vault). Plan ready for Wave 4 (Phase E: test suite + final docs). | `packages/applications/src/services/{notification,apiKey,dna-writing-style}/`, `docs/implementation/TASK-305-Multi-Tenancy-Hardening/README.md` |
