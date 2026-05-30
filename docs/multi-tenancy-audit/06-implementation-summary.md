# 06 — TASK-305 Multi-Tenancy Hardening: Implementation Summary

| Field | Value |
|---|---|
| **Status** | **Completed** (Phases A, B, D, E) — **Deferred** (Phase C / RLS) |
| **Completed** | 2026-05-27 |
| **Deferred** | Phase C → blocked on TASK-302 (PgBouncer + Vault role split) |
| **Plan** | [`docs/implementation/TASK-305-Multi-Tenancy-Hardening/README.md`](../implementation/TASK-305-Multi-Tenancy-Hardening/README.md) |
| **Audit driver** | [`02-prisma-schema-review.md`](./02-prisma-schema-review.md) |
| **Follow-up** | TASK-306 (DDD-Layers Followup) — Completed 2026-05-27; see [§6 below](#6-wave-5--task-306--ddd-layers-followup-2026-05-27) and the canonical closure record at [`07-ddd-layers-followup-closure.md`](./07-ddd-layers-followup-closure.md). Audit cross-walk against [`03-ddd-layers-review.md`](./03-ddd-layers-review.md). |

This is the canonical record of what TASK-305 actually shipped vs.
what the audit recommended. Every finding code in the audit is
accounted for below — `CLOSED`, `DEFERRED`, or `OUT-OF-SCOPE` — with
the merge SHA (or rationale) attached. The TASK-306 follow-up which
closed the residual DDD-layers gaps (audit doc 03) is summarised in
[§6 below](#6-wave-5--task-306--ddd-layers-followup-2026-05-27).

---

## 1. What shipped

| Phase | What | Where |
|---|---|---|
| **A — Schema hardening** | Drop sentinel default on 27 models; flip 11 nullable `tenantId` → NOT NULL; scoped uniques on `Webhook(tenantId, name)` and `Tag(tenantId, resourceType, resourceId, tagKey)`; 14 composite `[tenantId, X]` indexes; reserved `system` Tenant seed; idempotent back-fill migration. Domain factories drop `?? ''` fallback; `BaseTenantEntity.validate()` throws on empty `tenantId`. | `packages/database/src/prisma/db_main/*.prisma`, `packages/domains/src/**` |
| **B — Tenant-scope Prisma extension** | `applyTenantScopeExtension(prisma, options)` with 27-model allow-list, all 16 Prisma ops hooked, bidirectional mismatch detection, composed AFTER `applySoftDeleteExtension`. `getPrismaClient` → `getPlatformAdminPrismaClient_Unscoped` rename with ESLint allow-list rule. `ClsTenantContextProvider` wires `nestjs-cls` into the extension. `findUnique` soft-delete divergence fixed (W1.1). | `packages/database/src/extensions/tenant-scope.ts`, `apps/api/src/database/tenant-context.provider.ts`, `packages/config-eslint/base.js` |
| **D — Service-layer guards** | `tenant-guards.ts` helper (`assertEqualTenants` / `assertUserBelongsToTenant` / `assertParentInScope`). Cross-aggregate checks across `Consultation`/`Context`/`Summary`/`ChainSummary`/`Department`/`Notification`/`ApiKey`/`DnaWritingStyle`. User-membership assertions on every PHI-bearing create. `userRoleAssignment.create` pins `tenantId` to CLS. `auditLog.service` + `authorization-audit.service` inject CLS `tenantId` into every fetch (SUPER_ADMIN bypass for cross-tenant audit reads only). BullMQ + `@OnEvent` CLS rebind across 6 processors/handlers with fail-closed semantics. `Repository.rawQueryUnsafe` and `$bulk` removed from the public surface. | `packages/applications/src/common/tenant-guards.ts`, `packages/applications/src/services/**`, `packages/domains/src/common/repository.ts` |
| **E — Cross-tenant test suite + docs** | `tests/cross-tenant/fixtures.ts` + example shape-pinning test (6 cases). `cross-tenant-coverage.test.ts` aggregator that introspects 11 service test files + 6 processor/handler test files (17 coverage assertions + 2 meta tests, 19 total). README + technical-architecture-overview + this summary. Plan README closed out. | `tests/cross-tenant/`, `packages/applications/src/__tests__/cross-tenant-coverage.test.ts`, `packages/database/README.md`, `docs/technical-architecture-overview.md`, this file |

### Wave breakdown (merge SHAs)

| Wave | Commit / Merge | What |
|---|---|---|
| W1.1 | `df3a214` | B.12 soft-delete `findUnique` fix + A.9 cursor rule |
| W1.2 | `afacbf4` | D.1 `tenant-guards.ts` helper (26 unit tests) |
| W1.3 | `f9a4fcc` | D.7 `userRoleAssignment.create` pins CLS tenantId |
| W1.4 | `6fef53b` | D.8 `AuditLog` + `AuthorizationAudit` tenant scoping (20 cross-tenant tests) |
| W1.5 | `74eb315` | D.10 remove unsafe `rawQueryUnsafe` + `$bulk` |
| W2.D6 | `1907862` | D.6 Department parent cross-tenant check |
| W2.A | `fb05891` | Phase A schema hardening (A.1-A.9) |
| W2.B | `a839fb8` | Phase B tenant-scope extension + rename + ESLint guard |
| W2 follow-up | `2bfc125` | A.8 latent typecheck fixes (auditLog + resourceSubscription) |
| W3.1 | `9d1921d` | D.2/D.3/D.4 Consultation + Context + Summary cross-aggregate checks |
| W3.2 | `9028759` | D.5 Notification + ApiKey + DnaWritingStyle cross-tenant guards |
| W3.3 | `21115ed` | D.9 BullMQ processors CLS rebind (4 of 6) |
| W3.3 follow-up | `1839163` | D.9 AuditLogProcessor + ConsultationEventHandler CLS rebind (6 of 6) |
| W4 / E.1 | `e24ddbbb` | Phase E.1 cross-tenant fixture + example test |
| W4 / E.2-3 | `a006416e` | Phase E.2/E.3 cross-tenant coverage aggregator |
| W4 / E.5 | `2acfc2a8` | Phase E.5 packages/database/README.md tenant scoping section |
| W4 / E.6 | `c6624b47` | Phase E.6 docs/technical-architecture-overview.md multi-tenancy chapter |
| W4 / E.7-8 | (this commit) | Phase E.7 implementation summary + E.8 plan close-out |

---

## 2. Audit findings — closed / deferred / out-of-scope

Mapped against [`02-prisma-schema-review.md`](./02-prisma-schema-review.md).
The audit defines **B1-B12** (Critical/HIGH), **C1-C12** (Medium), and
**D1-D12** (Low/Hygiene) — 36 findings in total. No "M*" findings
exist in the audit; that prefix in the Phase E spec was a misnomer.

### B-series — Critical / HIGH

| Code | Severity | Title | Status | Closed by | Notes |
|---|---|---|---|---|---|
| B1 | BLOCKER | No RLS exists in any migration | **DEFERRED** | — | Plan §3.3 Phase C drafted; blocked on TASK-302 (`hope_tenant_user NOSUPERUSER NOBYPASSRLS` role split). Application-layer extension (B7) + service guards together provide isolation today. |
| B2 | BLOCKER | Zero FKs from tenant-scoped tables to `Tenant` | **OUT-OF-SCOPE** | — | User directive in plan §1.5: rejected to avoid bloating every Prisma model with a relation field. Tenant-deletion semantics will be handled by Phase C + application cascade. |
| B3 | BLOCKER | `'50000000-…'` sentinel default on 27 models | **CLOSED** | W2.A `fb05891` | All 27 defaults removed in Phase A migration; `BaseTenantEntity.validate()` now throws on empty `tenantId`. |
| B4 | HIGH | `tenantId` nullable on 13 models | **CLOSED** | W2.A `fb05891` | 11 models flipped to NOT NULL with back-fill to the reserved `system` Tenant. `User`/`UserMedia`/`UserProfile`/`UserSettings`/`UserVoiceProfile` remain non-tenant-scoped by design (B6). |
| B5 | HIGH | Global uniques that should be tenant-scoped | **PARTIALLY CLOSED** | W2.A `fb05891` | `Webhook(tenantId, name)` and `Tag(tenantId, resourceTypeName, resourceId, tagKey)` scoped. `TenantBucket.name`, `StorageAccessKey.accessKeyId`, `User.externalId`, `User.username` kept global per plan §1.5 (S3 / SSO / identity conventions). |
| B6 | HIGH | `User` model has no tenantId — users global by design | **OUT-OF-SCOPE** | — | Plan §1.5: architectural decision deferred to a separate ticket. The User-membership invariant is enforced by `assertUserBelongsToTenant` at every PHI-bearing create. Follow-up #1 tracks the `BaseGlobalEntity` extraction. |
| B7 | HIGH | No tenant-aware Prisma extension | **CLOSED** | W2.B `a839fb8` | `applyTenantScopeExtension` ships; composed on top of soft-delete; CLS-driven; bidirectional mismatch detection. |
| B8 | HIGH | Raw `getPrismaClient()` reachable from app code | **CLOSED** | W2.B `a839fb8` | Renamed to `getPlatformAdminPrismaClient_Unscoped`; ESLint `no-restricted-imports` rule with 8-site allow-list (`packages/config-eslint/base.js`). |
| B9 | HIGH | Child rows' `tenantId` never cross-checked vs. parent | **CLOSED** | W3.1 `9d1921d`, W3.2 `9028759` | `assertEqualTenants` + `assertParentInScope` invoked at every cross-aggregate write site (`Consultation`, `Context`, `Summary`, `Chain`, `Notification`, `ApiKey`, `DnaWritingStyle`). |
| B10 | HIGH | `Consultation.doctorId` FK doesn't enforce tenant membership | **CLOSED** | W3.1 `9d1921d`, W3.2 `9028759` | `assertUserBelongsToTenant` invoked at every `Consultation`/`Notification`/`ApiKey`/`DnaWritingStyle` create. |
| B11 | HIGH (latent) | PgBouncer config + transaction-mode `SET LOCAL` semantics | **OUT-OF-SCOPE** | — | TASK-302 ownership. Phase C `$transaction` wrapper drafted but parked. |
| B12 | HIGH (hygiene) | Soft-delete `findUnique` bypasses the filter | **CLOSED** | W1.1 `df3a214` | `applySoftDeleteFilter` now applied on `findUnique`; regression test pins the contract. |

### C-series — Medium

| Code | Severity | Title | Status | Closed by | Notes |
|---|---|---|---|---|---|
| C1 | MED | Single-column non-`tenantId`-leading composite indexes on `Consultation`/`ContextItem`/`NamedEntity` | **CLOSED** | W2.A `fb05891` | 14 composite `[tenantId, X]` indexes added across `Consultation`/`ContextItem`/`NamedEntity`/`SummaryMeta`/`AudioRecording`. |
| C2 | MED | `AuditLog` mutable — no append-only constraint | **DEFERRED** | (partial: W1.4 `6fef53b`) | Application-layer tenant scoping on `fetch*`/`delete*` shipped (W1.4 D.8). DB-level `REVOKE UPDATE, DELETE` and `platform_audit_admin` role planned for Phase C. |
| C3 | MED | `StorageAccessKey.bucketIds String[]` — denormalised text array | **OUT-OF-SCOPE** | — | Plan §1.5: independent refactor (not a multi-tenancy fix). |
| C4 | MED | `User.secret1`/`secret2` plaintext-ish | **OUT-OF-SCOPE** | — | Plan §1.5: separate security review. |
| C5 | MED | `User.password` naming — no `passwordHash`/`Algorithm`/`Salt` discriminator | **OUT-OF-SCOPE** | — | Plan §1.5: separate security review. |
| C6 | MED | `Department.parentDepartmentId` self-reference not tenant-checked | **CLOSED** | W2.D6 `1907862` | `assertParentInScope(parentDepartment, child)` invoked on every `create`/`update`. SUPER_ADMIN does NOT bypass (structural correctness). |
| C7 | MED | `UserVoiceProfile.embedding` `vector(256)` no pgvector index | **OUT-OF-SCOPE** | — | Performance optimization, not a multi-tenancy issue. Separate ML ticket. |
| C8 | MED | `Tag` has no unique/index | **CLOSED** | W2.A `fb05891` | `@@unique([tenantId, resourceTypeName, resourceId, tagKey])` + matching index added in Phase A. |
| C9 | MED | `TranscriptionJob.consultationId/contextItemId/mediaId` plain-string FKs | **OUT-OF-SCOPE** | — | Plan §1.5: user-directive applies (no FK transformation). Read-side cross-tenant risk covered by Phase D service guards. |
| C10 | MED | `Tenant` deactivation behaviour undefined | **DEFERRED** | — | Separate ticket — needs product decision on whether `Tenant.resourceStatus = DISABLED` blocks RLS reads or only application-level writes. |
| C11 | MED | Migration uses no `NOT VALID` constraints | **OUT-OF-SCOPE** | — | Documentation note, no schema change required. |
| C12 | MED | `prisma.config.ts` `DIRECT_URL == DATABASE_URL` in dev | **OUT-OF-SCOPE** | — | Dev-only convention. Production envs already use distinct URLs (`client.ts:50-56`). |

### D-series — Low / Hygiene

| Code | Severity | Title | Status | Closed by | Notes |
|---|---|---|---|---|---|
| D1 | LOW | `AuditAction` enum missing `EXPORT` etc. — add in single migration | **OUT-OF-SCOPE** | — | Schema-evolution hygiene; not a tenancy issue. |
| D2 | LOW | `ResourceType` enum kept in manual sync with models | **OUT-OF-SCOPE** | — | Codegen drift surface; independent ticket. |
| D3 | LOW | `metaData Json?` no schema constraint | **OUT-OF-SCOPE** | — | Application-layer validation concern. |
| D4 | LOW | `ApiKey.usageCount Int` overflow risk | **OUT-OF-SCOPE** | — | Separate data-model ticket. |
| D5 | LOW | `Notification.tags` lacks `@default([])` | **OUT-OF-SCOPE** | — | Cosmetic inconsistency. |
| D6 | LOW | `WebhookRunHistory` no indexes (PK only) | **OUT-OF-SCOPE** | — | Performance, not isolation. |
| D7 | LOW | Boilerplate duplication across models | **OUT-OF-SCOPE** | — | Codegen / Prisma 7 `type` composition (preview). |
| D8 | LOW | `media.prisma:8` nullable `tenantId` despite NOT NULL FK relations | **CLOSED** | W2.A `fb05891` | `Media.tenantId` flipped to NOT NULL with the rest of B4. |
| D9 | LOW | `vault-admin-bootstrap.sql` no explicit `NOBYPASSRLS` | **DEFERRED** | — | Phase C / TASK-302. |
| D10 | LOW | `seed/01-policy.ts` template-literal tenant scoping un-tested | **OUT-OF-SCOPE** | — | CASL policy hygiene; separate ticket. |
| D11 | LOW | `tag.prisma` `createdBy` lacks `@default("60000000-…")` placeholder | **OUT-OF-SCOPE** | — | Trivial inconsistency; not blocking. |
| D12 | LOW | `User.lastLoginAt`/`lastActiveAt` write-amplification | **OUT-OF-SCOPE** | — | Separate `UserActivity` table proposal. |

### Roll-up

| Status | Count | Notes |
|---|---|---|
| **CLOSED** | **12** | B3, B4, B5 (partial), B7, B8, B9, B10, B12, C1, C6, C8, D8. (W1.1 = B12; not counted twice.) |
| **DEFERRED** | **4** | B1 (RLS), C2 (AuditLog lockdown), C10 (Tenant deactivation), D9 (vault NOBYPASSRLS) — all converge on Phase C / TASK-302. |
| **OUT-OF-SCOPE** | **20** | User-directive items (B2), separate-review items (B6, B11), hygiene items (C3, C4, C5, C7, C9, C11, C12, D1-D7, D10-D12). |

(B5 is counted once under CLOSED because the scoped half shipped; the
kept-global half was a user decision, not a deferral.)

---

## 3. Test coverage (cross-tenant)

The aggregator at
[`packages/applications/src/__tests__/cross-tenant-coverage.test.ts`](../../packages/applications/src/__tests__/cross-tenant-coverage.test.ts)
introspects each tracked test file and counts the `it(...)` blocks
nested under the canonical `describe('TASK-305 D.x …')` /
`describe('Multi-tenant scoping …')` / `describe('CLS rebind …')`
markers. Coverage at TASK-305 close-out:

### Service-layer (E.2)

| Service | Test file | `it()` count | Audit codes closed |
|---|---|---|---|
| `auditLog` | `services/auditLog/__tests__/auditLog.service.test.ts` | 12 | D.8 (B1 partial, C2 partial) |
| `audit/authorization-audit` | `services/audit/__tests__/authorization-audit.service.test.ts` | 8 | D.8 |
| `apiKey` | `services/apiKey/__tests__/apikey.service.test.ts` | 14 | D.5 (B9, B10) |
| `consultation/consultation` | `services/consultation/consultation/__tests__/consultation.service.test.ts` | 9 | D.2 (B9, B10, C6 across aggregate) |
| `consultation/context` | `services/consultation/context/__tests__/context.service.test.ts` | 8 | D.3 (B9) |
| `consultation/summary` | `services/consultation/summary/__tests__/summary.service.test.ts` | 5 | D.4 (B9) |
| `consultation/summary/chain-summary` | `services/consultation/summary/__tests__/chain-summary.service.test.ts` | 2 | D.4 (B9, chain) |
| `department` | `services/department/__tests__/department.service.test.ts` | 6 | D.6 (C6) |
| `dna-writing-style` | `services/dna-writing-style/__tests__/dna-writing-style.service.test.ts` | 10 | D.5 (B9, B10) |
| `notification` | `services/notification/__tests__/notification.service.test.ts` | 15 | D.5 (B9, B10) |
| `user/userRoleAssignment` | `services/user/userRoleAssignment/__tests__/userRoleAssignment.service.test.ts` | 4 | D.7 (audit BLOCKER on `UserRoleAssignment`) |

**Subtotal**: 93 inline cross-tenant service tests.

### Queue + event-handler (E.3)

| Component | Test file | `it()` count | Audit codes closed |
|---|---|---|---|
| `summary.processor` | `services/consultation/jobs/__tests__/summary.processor.test.ts` | 3 | D.9 (B7 + B9 in queue context) |
| `pre-summary.processor` | `services/consultation/jobs/__tests__/pre-summary.processor.test.ts` | 3 | D.9 |
| `comprehensive-summary.processor` | `services/consultation/jobs/__tests__/comprehensive-summary.processor.test.ts` | 3 | D.9 |
| `ner.processor` | `services/consultation/jobs/__tests__/ner.processor.test.ts` | 3 | D.9 |
| `auditLog.processor` | `services/auditLog/__tests__/auditLog.processor.test.ts` | 3 | D.9 (write-only — no `assertEqualTenants`) |
| `consultation-event.handler` | `services/consultation/events/__tests__/consultation-event.handler.test.ts` | 6 | D.9 (`@OnEvent` CLS rebind + fail-closed) |

**Subtotal**: 21 inline CLS-rebind / fail-closed tests.

### Aggregator total

**93 + 21 = 114** cross-tenant tests pinned by the aggregator. Plus
**6** fixture shape-pinning tests in `tests/cross-tenant/example.test.ts`
(repo root). Plus **19** aggregator-level tests (17 coverage
assertions + 2 introspection-helper sanity tests).

The aggregator itself fails CI if any expected service / processor
file is missing, any marker `describe` block is removed, or any
inline count drops below the W3-reported floors.

---

## 4. Decision log — what was NOT done, and why

- **FK columns from `tenantId` → `Tenant`** — rejected by user (plan
  §1.5 / B2). Would create a relation field on every tenant-scoped
  Prisma model for marginal benefit. The extension + (future) RLS
  cover the same isolation invariant without the model noise.
- **`User`/`UserMedia` as global entities** — deferred. Today they
  extend `BaseTenantEntity` with `tenantId: ''` placeholder. The
  proper fix is `BaseGlobalEntity` (or `BaseAggregate` directly).
  Plan §6.7 follow-up #1.
- **RLS policies (Phase C)** — deferred. Depends on TASK-302
  (PgBouncer + Vault `hope_tenant_user` role split). Application
  layer already enforces the same invariant; RLS is defence-in-depth.
- **`CoreDataModel` wildcard re-export removal** — deferred. The
  ESLint rule's `importNames` doesn't follow wildcard re-exports,
  making `core.database.types.ts` a latent footgun (no current
  consumers). Plan §6.7 follow-up #5.
- **`NotificationService` SUPER_ADMIN posture inconsistency** — the
  service permits SUPER_ADMIN cross-tenant access while the parallel
  DNA service refuses. Reviewer-flagged (W3.2). Plan §6.7 follow-up #7.
- **`fetchAllByTenantId` pre-existing gaps** —
  `NotificationService.fetchAllByTenantId`,
  `ApiKeyService.fetchAllByTenantId`,
  `DnaWritingStyleService.listReports` accept caller-supplied
  `tenantId` with no CLS comparison. Predates TASK-305. Plan §6.7
  follow-up #8.
- **`auditLog.processor.spec.ts` dead-file cleanup** — vitest/eslint
  skip `.spec.ts` inside `__tests__/`; the file is silently dead.
  Housekeeping ticket. Plan §6.7 follow-up #9.
- **`WorkerSession` soft typing** — `as unknown as UserSession` reused
  8× in queue/event processors. Style cleanup. Plan §6.7 follow-up #10.
- **B4 nullable removal for `User*` family** — deliberately not
  changed; `User` model is global by design (B6). The
  `assertUserBelongsToTenant` guard at every PHI-bearing create is the
  invariant equivalent.

---

## 5. Cross-links

- Plan: [`docs/implementation/TASK-305-Multi-Tenancy-Hardening/README.md`](../implementation/TASK-305-Multi-Tenancy-Hardening/README.md)
- Original audit: [`02-prisma-schema-review.md`](./02-prisma-schema-review.md)
- Sibling audit docs: [`01-research-best-practices.md`](./01-research-best-practices.md), [`03-ddd-layers-review.md`](./03-ddd-layers-review.md), [`04-api-design-review.md`](./04-api-design-review.md), [`05-vox-sdk-review.md`](./05-vox-sdk-review.md)
- Tenant guards: [`packages/applications/src/common/tenant-guards.ts`](../../packages/applications/src/common/tenant-guards.ts)
- Prisma extension: [`packages/database/src/extensions/tenant-scope.ts`](../../packages/database/src/extensions/tenant-scope.ts)
- CLS provider: [`apps/api/src/database/tenant-context.provider.ts`](../../apps/api/src/database/tenant-context.provider.ts)
- Architecture overview: [`docs/technical-architecture-overview.md`](../technical-architecture-overview.md) § Multi-tenancy enforcement layers
- DB README: [`packages/database/README.md`](../../packages/database/README.md) § Tenant scoping & RLS posture
- Cross-tenant fixture: [`tests/cross-tenant/fixtures.ts`](../../tests/cross-tenant/fixtures.ts)
- Coverage aggregator: [`packages/applications/src/__tests__/cross-tenant-coverage.test.ts`](../../packages/applications/src/__tests__/cross-tenant-coverage.test.ts)

---

## 6. Wave 5 — TASK-306 — DDD-Layers Followup (2026-05-27)

TASK-305 closed the schema-audit (`02-prisma-schema-review.md`) gaps.
TASK-306 closes the DDD-layers-audit (`03-ddd-layers-review.md`)
gaps that TASK-305 deliberately left **PARTIAL** or **OPEN**, plus 7
issues surfaced by the post-TASK-305 verification pass on 2026-05-27
(NEW-1..NEW-7). The canonical closure record is
[`07-ddd-layers-followup-closure.md`](./07-ddd-layers-followup-closure.md);
this section is the wave-by-wave summary in the same style as §1.

| Field | Value |
|---|---|
| **Plan** | [`docs/implementation/TASK-306-DDD-Layers-Followup/README.md`](../implementation/TASK-306-DDD-Layers-Followup/README.md) |
| **Audit driver** | [`03-ddd-layers-review.md`](./03-ddd-layers-review.md) |
| **Status** | **Completed** (W5.1–W5.6) — engineer-hours ≈ 13 vs. 14 estimated |
| **Approach** | 5 sequential waves per `executing-plans` skill — fresh implementation subagent per wave + mandatory code-reviewer subagent between waves; all 5 reviews returned **APPROVED-WITH-MINOR-NITS** (0 critical, 0 important) |

### 6.1 Wave breakdown (merge SHAs)

| Wave | Merge SHA | What |
|---|---|---|
| W5.1 | `78e7b354` | Surgical fixes bundle — 6 commits, 20 cross-tenant tests. Closes **C-7 finale** (`set Tenant(...)` → `protected`), **H-3 / NEW-6** (`TenantService.fetchById` + `fetchByCodeName` SUPER_ADMIN gate), **H-8 / NEW-1** (`AuthorizationAuditService.logToDatabase` CLS pin + fail-closed), **NEW-2** (`WebhookService.create` `resolveEffectiveTenantId`), **NEW-3 / NEW-4** (`Notification` + `ApiKey` `fetchAllByTenantId` CLS gate). |
| W5.2 | `66b1d579` | Consultation read-paths defense-in-depth — 4 commits, 9 cross-tenant tests. Closes **C-1 reads** (`assertEqualTenants` on `getById` / `getByIdWithRelations` / `getConsultationChain`). |
| W5.3 | `60d9d798` | Tenant + Webhook + ResourceSubscription sweep — 13 commits (12 plan + 1 TASK-258 test alignment), 34 cross-tenant tests. Closes **H-1** (`fetchTenantConfigs` SUPER_ADMIN gate), **M-2 / NEW-2** (Webhook 5-method tenant-guard sweep), **M-3** (ResourceSubscription 5-method tenant-guard sweep). |
| W5.4 | `969e49df` | ContextItem array-input validation — 3 commits, 9 cross-tenant tests. Closes **C-3 finale** (`ContextService.resolveLinkedConsultationIds` filters chain + same-day to CLS tenant; no SUPER_ADMIN bypass on this clinical-PHI hot read path). |
| W5.5 | `ec67a0d4` | Hygiene bundle + aggregator FS-introspection — 7 commits, 25 cross-tenant tests. Closes **M-5** (`BaseService.broadcastSysEvent` CLS-wins merge order), **M-6** (`CoreUnitOfWorkService` canonical `runInTransaction(callback)` — silent in-place fix), **M-8** (`DataNotFoundException` HTTP filter → 404 generic in production), **L-4** (`BaseEntity.equals` tenant-aware via duck-typing), **NEW-7 / F-4** (aggregator FS-introspection — surfaced + closed one pre-existing gap in `prompt-management.service.test.ts`). |
| W5.6 | `82b3b9e4` | Documentation close-out (this section + §5 of the plan README + the canonical [`07-ddd-layers-followup-closure.md`](./07-ddd-layers-followup-closure.md) + a TASK-306 update to [`technical-architecture-overview.md`](../technical-architecture-overview.md) § Multi-tenancy enforcement layers). Doc-only — 0 production-code lines touched. |

### 6.2 Audit findings closed (from `03-ddd-layers-review.md`)

| Code | Closure path | Wave | Merge SHA |
|---|---|---|---|
| **C-1** (reads) | `assertEqualTenants` on Consultation read methods + chain filter | W5.2 | `66b1d579` |
| **C-3** (array-input) | `ContextService.resolveLinkedConsultationIds` filters to CLS tenant | W5.4 | `969e49df` |
| **C-7** (finale) | `BaseTenantEntity.set Tenant(...)` → `protected` | W5.1 | `78e7b354` |
| **H-1** | `TenantService.fetchTenantConfigs` SUPER_ADMIN gate | W5.3 | `60d9d798` |
| **H-3 / NEW-6** | `TenantService.fetchById` + `fetchByCodeName` SUPER_ADMIN gate | W5.1 | `78e7b354` |
| **H-8 / NEW-1** | `AuthorizationAuditService.logToDatabase` CLS pin + fail-closed | W5.1 | `78e7b354` |
| **M-2 / NEW-2** | `WebhookService` 5-method tenant-guard sweep + `resolveEffectiveTenantId` on `create` | W5.1 + W5.3 | `78e7b354` + `60d9d798` |
| **M-3** | `ResourceSubscriptionService` 5-method tenant-guard sweep | W5.3 | `60d9d798` |
| **M-5** | `BaseService.broadcastSysEvent` CLS wins on `tenantId` | W5.5 | `ec67a0d4` |
| **M-6** | `CoreUnitOfWorkService` canonical `runInTransaction(callback)` (silent in-place fix; legacy methods `@deprecated + Logger.warn`) | W5.5 | `ec67a0d4` |
| **M-8** | HTTP exception filter mapping `DataNotFoundException` → 404 generic in production | W5.5 | `ec67a0d4` |
| **L-4** | `BaseEntity.equals` tenant-aware via duck-typing on `BaseTenantEntity` subclasses | W5.5 | `ec67a0d4` |
| **NEW-3 / NEW-4** | `Notification` + `ApiKey` `fetchAllByTenantId` CLS gate | W5.1 | `78e7b354` |
| **NEW-7 / F-4** | Aggregator FS-introspection meta-test (surfaced 1 pre-existing gap → closed inline) | W5.5 | `ec67a0d4` |

### 6.3 Test deltas (cross-tenant)

97 new inline cross-tenant tests across `packages/applications` +
`packages/domains` + `apps/api` (W5.1: 20, W5.2: 9, W5.3: 34, W5.4: 9,
W5.5: 25).

| Aggregator state | Service entries | Processor entries | Meta tests | Total |
|---|---|---|---|---|
| **Pre-TASK-305** | 0 | 0 | 0 | 0 |
| **Post-TASK-305 (W4)** | 11 | 6 | 2 | **19** |
| **Pre-W5.5 (TASK-306 W5.1 + W5.3)** | 14 | 6 | 2 | **22** |
| **Post-TASK-306 (W5.5.7)** | 17 | 6 | 7 | **30** |

Net new TASK-306 `SERVICE_COVERAGE` entries: 6 (`tenant`, `webhook`,
`resourceSubscription`, `prompt-management`, `common/base.service`,
`baseServices/core.unitOfWork`). Of those, `prompt-management` was a
pre-existing gap surfaced by the W5.5.6 FS-introspection meta-test and
closed inline.

The TASK-305 floor (114 inline + 6 fixture + 19 aggregator-level) is
preserved — every TASK-306 wave gate verified that no TASK-305 test
count dropped.

### 6.4 Deferred (TASK-306)

Two classes of deferral. Neither is blocking; all tracked for
follow-up tickets.

#### 6.4.1 Original-plan deferrals (TASK-306 plan §8)

| Code | Topic | Why deferred |
|---|---|---|
| **F-1** | PostgreSQL RLS (audit B1 / TASK-305 Phase C) | Schema-wide change requiring DBA review + PgBouncer + Vault role split — owned by TASK-302 |
| **F-2 / NEW-5** | `DnaWritingStyleService.listReports` GLOBAL_ADMIN bypass | Product decision — is `GLOBAL_ADMIN` deliberately cross-tenant? |
| **F-3** | `NotificationService` SUPER_ADMIN posture inconsistency | Product decision — tighten or audit-log |
| **F-5** | `auditLog.processor.spec.ts` dead file (TASK-305 §6.7 #9) | Housekeeping — vitest/eslint skip `.spec.ts` in `__tests__/` |
| **F-6** | `WorkerSession` soft typing (TASK-305 §6.7 #10) | Style cleanup — `as unknown as UserSession` reused 8× |
| **F-7** | Drop redundant single-column `@@index([tenantId])` (TASK-305 §6.7 #3) | Write-throughput micro-opt — composite `[tenantId, X]` indexes cover the same workloads |
| **F-8** | `CoreDataModel` wildcard re-export removal (TASK-305 §6.7 #5) | Latent footgun, zero current consumers — ESLint `importNames` doesn't follow wildcard re-exports |
| **L-3** | JWT revocation Redis key not tenant-prefixed | Backlog only — `jti` is globally unique so no practical collision risk |
| **H-4** | `User` / `UserMedia` blindly findById cross-tenant | Architectural — needs `BaseGlobalEntity` design (also tracked as TASK-305 §6.7 #1) |

#### 6.4.2 Review-time minor nits (306-Fx)

14 nits captured across W5.1–W5.5 code reviews. **306-F9 + 306-F10**
were folded into W5.5.7 (aggregator marker cosmetics + broadening for
the `consultation/context` floor). Remaining: **306-F1..306-F8,
306-F11..306-F14** (12 nits — all minor, none blocking). Full list +
descriptions in [TASK-306 plan README §6.7](../implementation/TASK-306-DDD-Layers-Followup/README.md#task-306-follow-ups-deferred-minor-nits).

### 6.5 Cross-links (TASK-306 addendum)

- TASK-306 plan: [`docs/implementation/TASK-306-DDD-Layers-Followup/README.md`](../implementation/TASK-306-DDD-Layers-Followup/README.md)
- Canonical closure record: [`07-ddd-layers-followup-closure.md`](./07-ddd-layers-followup-closure.md)
- Audit driver: [`03-ddd-layers-review.md`](./03-ddd-layers-review.md) (TASK-306 closure banner at top; per-finding `[CLOSED W5.x <sha>]` markers in §A/§B/§C/§D/§E)
- Architecture overview: [`docs/technical-architecture-overview.md`](../technical-architecture-overview.md) § Multi-tenancy enforcement layers (TASK-306 finale noted in Layer 3)

---

## 7. TASK-317 — `@arcaai/vox` SDK Multi-Tenancy Hardening (2026-05-30)

TASK-305/306/307 hardened the **server** (schema, DDD layers, API
gateway). TASK-317 closes the **last** unaddressed audit doc in the
2026-05-25 series — the browser SDK review
([`05-vox-sdk-review.md`](./05-vox-sdk-review.md)). These are
*defense-in-depth client fixes*; the server-side tenant boundary
(TASK-305/306/307) remains authoritative. The canonical per-finding
closure record is
[`09-vox-sdk-followup-closure.md`](./09-vox-sdk-followup-closure.md);
this section is the wave-by-wave summary in the same style as §1/§6.

| Field | Value |
|---|---|
| **Plan** | [`docs/implementation/TASK-317-Vox-SDK-Multi-Tenancy-Hardening/README.md`](../implementation/TASK-317-Vox-SDK-Multi-Tenancy-Hardening/README.md) |
| **Audit driver** | [`05-vox-sdk-review.md`](./05-vox-sdk-review.md) |
| **Status** | **Completed** — W1–W5 merged into `fix/2605-review` (W5 `f19ef6fb`) |
| **Scope** | `packages/agentic-sdk-v2` (`@arcaai/vox`), `packages/room`, `packages/utils`, `apps/example` — browser-side only; no API/server/Prisma changes |
| **Approach** | 5 sequential waves per `executing-plans` skill — fresh implementation subagent per wave (strict TDD) + mandatory `code-reviewer` subagent between waves + `--no-ff` merges into `fix/2605-review`. All merged reviews returned **APPROVED** / **APPROVED-WITH-MINOR-NITS** (0 critical, 0 important at merge) |

### 7.1 Wave breakdown (merge SHAs)

| Wave | Merge SHA | What |
|---|---|---|
| W1 | `6947fd96` | **Browser-storage tenant/user namespacing.** Closes **C-2** (`clearOnLogout(ns)` scoped to the outgoing namespace only — no `*`-sweep, no wholesale IDB `.clear()`), **C-3** (`PersonalizationManager` namespace ctor + IDB key `arcaai-personalization/${ns}` + configDB v2→3 legacy-row drop), **D-1** (`SELECTED_MODELS` → `arcaai-selected-models/${ns}`), **D-2** (dead `PREFERENCES` retained only as documented legacy-cleanup), **E-2** (valibot validation on `selectedModels` read). vox suite 2928 green; typecheck-neutral. |
| W2 | `15c3072a` | **Tenant-switch session reset.** Closes **C-5** — `clearTenantSessionData()` store action clears the 10-field tenant PHI/session set synchronously on `effectiveTenantId` change before the async re-hydrate tail (auth/impersonation untouched). vox suite 2929 green. |
| W3 | `d9e961a5` | **Cross-tab / WebSocket isolation.** Closes **C-4** (`wsDedupKey(id,userId)`; user-mismatch refuses to share a socket), **D-4** (per-tenant `HKDF(secret, tenantId)` HMAC subkey; master secret never leaves the SharedWorker), **D-5** (`useArcaSession` threads `tenantId` into `createCrossTabSync`), **E-4** (opt-in `requireTenantClaim` on `SttV2WebSocketClient.connect`). vox suite 2945 green. |
| W4 | `83f1db7b` | **Store-per-provider refactor + multi-instance tests.** Closes **C-1** (`createAgenticStore()` factory + `AgenticStoreContext`; per-provider store in `useRef`; internal `useAgenticStore` → context hook; module singleton `@deprecated`-shimmed; public `useArcaStore`/`useStoreApi` accessors) and **E-5** (`multi-instance.test.ts` — two providers/two tenants isolation + switch-mid-session + impersonation start→stop). vox suite 2948 green; ui-playground `vite build` ✓. |
| W5 | `f19ef6fb` | **Cache scoping + hygiene.** Closes **D-3** (`getTransformersCacheName`/`clearTenantCustomTransformersCache` — `vox/${tenantId}/transformers`; `db46a669`; **mechanism only, live-wiring deferred**), **D-6** (`AudioContextManager` cross-tenant dev-warning; `f2fbdcaf`), **E-1** (logger console fail-safe TSDoc; `478c61b2` + nit `1c50137d`), **E-3** (`apps/example/README.md` marks the app as a raw-WS demo, not a vox consumer; `6814c6fd`). utils suite 145 green; room suite 493 green. |

### 7.2 Audit findings closed (from `05-vox-sdk-review.md`)

All 16 findings closed (2 with production-wiring deferred). Severity:
4 Critical (C-1..C-4) + 1 High (C-5) + 6 Medium (D-1..D-6) + 5 Low
(E-1..E-5).

| Code | Closure path | Wave | Marker SHA |
|---|---|---|---|
| **C-1** | store-per-provider (`createAgenticStore()` + context) | W4 | `83f1db7b` |
| **C-2** | `clearOnLogout(ns)` outgoing-namespace-only | W1 | `6947fd96` |
| **C-3** | `PersonalizationManager` namespaced IDB key + configDB v3 | W1 | `6947fd96` |
| **C-4** | `wsDedupKey(id, userId)` fail-closed | W3 | `d9e961a5` |
| **C-5** | `clearTenantSessionData()` synchronous tenant-switch reset | W2 | `15c3072a` |
| **D-1** | namespaced `arcaai-selected-models/${ns}` | W1 | `6947fd96` |
| **D-2** | dead `PREFERENCES` key documented as legacy-cleanup only | W1 | `6947fd96` |
| **D-3** | tenant-scoped custom transformers cache **(mechanism only; wiring deferred — `09` §2.1)** | W5 | `db46a669` |
| **D-4** | per-tenant `HKDF(secret, tenantId)` HMAC subkey | W3 | `d9e961a5` |
| **D-5** | `useArcaSession` threads `tenantId` into `createCrossTabSync` | W3 | `d9e961a5` |
| **D-6** | `AudioContextManager` cross-tenant dev-warning | W5 | `f2fbdcaf` |
| **E-1** | logger console fail-safe TSDoc note | W5 | `478c61b2` |
| **E-2** | valibot validation on `selectedModels` read | W1 | `6947fd96` |
| **E-3** | `apps/example` documented as raw-WS demo (rename declined) | W5 | `6814c6fd` |
| **E-4** | opt-in `requireTenantClaim` **(prod-wiring deferred — `09` §2.1)** | W3 | `d9e961a5` |
| **E-5** | `multi-instance.test.ts` concurrent-provider isolation suite | W4 | `83f1db7b` |

### 7.3 Deferred (TASK-317)

Production-wiring deferred (mechanism shipped + unit-tested):

- **D-3 / AC-14** — `getTransformersCacheName` + `clearTenantCustomTransformersCache`
  are dormant (no in-repo caller); not wired into the live tenant-switch
  and Transformers.js isn't yet configured to write the tenant-scoped
  name. Future integration ticket.
- **E-4 / AC-10** — `requireTenantClaim` is opt-in, not wired into the
  prod streaming callers (`PluginManager.buildStreamingTransport` /
  `StreamingSessionManager`), and `resolveTenantClaim` doesn't yet
  accept the prod discriminator (`ticket`/`sessionId`). Follow-up.

Plus per-wave review-time minor nits (one-frame `useEffect` paint
window; transient `*Error` slices not reset; rapid double-switch
generation guard; `@deprecated agenticStoreSingleton` shim removal;
pre-existing ui-playground `tsc` errors + 3 mock/source-drift test
failures; `AudioContextManager` phantom-holder over-warn). Full list in
[`09-vox-sdk-followup-closure.md`](./09-vox-sdk-followup-closure.md) §2.

### 7.4 Final gate status

vox **2948** / utils **145** / room **493** green; typecheck-neutral
(13 pre-existing vox `tsc` errors unchanged); lint 0 errors
(pre-existing prettier warnings only). W1–W5 merged (W5 `f19ef6fb`).

### 7.5 Cross-links (TASK-317 addendum)

- TASK-317 plan: [`docs/implementation/TASK-317-Vox-SDK-Multi-Tenancy-Hardening/README.md`](../implementation/TASK-317-Vox-SDK-Multi-Tenancy-Hardening/README.md)
- Canonical closure record: [`09-vox-sdk-followup-closure.md`](./09-vox-sdk-followup-closure.md)
- Audit driver: [`05-vox-sdk-review.md`](./05-vox-sdk-review.md) (TASK-317 closure banner at top; per-finding `[CLOSED W<n> <sha>]` markers on every §C/§D/§E heading)
- SDK rule reference: [`.cursor/rules/08-vox-sdk.mdc`](../../.cursor/rules/08-vox-sdk.mdc) § "Multi-Tenancy & Data Isolation"
- Architecture overview: [`docs/technical-architecture-overview.md`](../technical-architecture-overview.md) § Multi-tenancy enforcement layers (browser-side SDK isolation noted as client defense-in-depth)
