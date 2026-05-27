# TASK-306 — DDD-Layers Multi-Tenancy Follow-up

| Field | Value |
|---|---|
| **Ticket** | TASK-306-DDD-Layers-Followup |
| **Created** | 2026-05-27 |
| **Updated** | 2026-05-27 |
| **Status** | `Completed` (W5.1–W5.6 merged; canonical closure record at [`docs/multi-tenancy-audit/07-ddd-layers-followup-closure.md`](../../multi-tenancy-audit/07-ddd-layers-followup-closure.md)) |
| **Classification** | Refactor + bugfix (security/compliance) |
| **Priority** | High — closes the remaining HIPAA §164.312(a)(1) gaps surfaced by `03-ddd-layers-review.md` that TASK-305 deliberately did not cover or only partially closed |
| **Prior context** | TASK-305 (Phases A, B, D, E shipped) — see [`../TASK-305-Multi-Tenancy-Hardening/README.md`](../TASK-305-Multi-Tenancy-Hardening/README.md) |
| **Audit driver** | [`docs/multi-tenancy-audit/03-ddd-layers-review.md`](../../multi-tenancy-audit/03-ddd-layers-review.md) |
| **Companion tickets** | TASK-302 (PgBouncer + Vault — owns the RLS Phase C deferred from TASK-305) |

---

## 1. Requirement Analysis

### 1.1 Description

Close the residual multi-tenancy defects that the 2026-05-25 DDD-layers audit (`03-ddd-layers-review.md`) flagged and that TASK-305 either left **PARTIAL** or **OPEN**, plus 7 issues discovered during the post-TASK-305 verification pass on 2026-05-27. The TASK-305 implementation summary (`06-implementation-summary.md`) cross-walks against the SCHEMA audit (02) only; this ticket is the DDD audit (03) cross-walk closure.

### 1.2 User-confirmed scope rules

1. **No new architectural decisions in this ticket.** Anything that needs a design decision (e.g. `User`/`UserMedia` global vs. tenant-scoped, `NotificationService` SUPER_ADMIN posture) is tracked as a **Follow-up** in §8, not included here.
2. **No schema or migration work.** Phase A of TASK-305 already covered the schema. If a finding requires a Prisma migration, it is deferred to TASK-302 or a new dedicated ticket.
3. **No RLS work.** Phase C remains TASK-302's responsibility.
4. **TDD-first.** Every fix lands in a Red-Green-Refactor cycle (`methodology/test-driven-development`). Cross-tenant negative tests come BEFORE the guards.
5. **Pattern reuse.** Each fix copies a pattern already in production (Wave-1-to-4 services). No new abstractions are introduced.
6. **Defense-in-depth.** Even where the Prisma `tenantScope` extension already filters, service-layer assertions are added to guarantee an explicit `NotFoundException` instead of a silent empty/null response (matches DEF-C3 "no existence leak" pattern).

### 1.3 Business context

TASK-305 shipped 12 audit-CLOSED findings, 4 DEFERRED-to-Phase-C, and 20 OUT-OF-SCOPE. The **15 PARTIAL/OPEN findings** verified on 2026-05-27 against `03-ddd-layers-review.md` represent the residual cross-tenant attack surface in the DDD layers. Each gap is independently exploitable:

- **Audit-write integrity gap (NEW-1 / H-8)** — `AuthorizationAuditService.logToDatabase` writes audit rows with caller-supplied `tenantId`, bypassing the `tenantScope` extension and producing audit rows that mis-attribute the originating tenant. HIPAA §164.312(b) audit-immutability concern.
- **Tenant enumeration (H-3 / NEW-6)** — any authenticated user can fetch any tenant's entity / configurations by id. Leaks tenant catalogue + locked-config metadata.
- **Defense-in-depth bypass (C-1, C-3, M-2, M-3)** — services rely on the Prisma extension alone. If a future PR ever bypasses the extension (raw query, platform-admin path, mocked CLS), several PHI surfaces will silently return foreign-tenant data.
- **Mutation escape on `BaseTenantEntity` (C-7)** — `set Tenant(...)` is still `public` and rewrites `tenantId`; the `set tenantId` hardening from TASK-305 is half-finished.
- **DTO trust pattern (NEW-2..NEW-4)** — three `create` / `fetchAllByTenantId` paths accept caller-supplied `tenantId` from the DTO without CLS comparison.

### 1.4 Acceptance criteria

| # | Criterion | Verification |
|---|---|---|
| AC-1 | `set Tenant(...)` on `BaseTenantEntity` is `protected`; external code cannot mutate the relation | TypeScript-error test pins the contract |
| AC-2 | `AuthorizationAuditService.logToDatabase` derives `tenantId` from CLS, not from `entry` | Unit test: mocked CLS tenant-A + `entry.tenantId = tenant-B` → row persisted with tenant-A |
| AC-3 | `TenantService.fetchById` and `fetchByCodeName` refuse cross-tenant reads (except SUPER_ADMIN) | Cross-tenant negative tests: 404 for non-super-admin, 200 for super-admin |
| AC-4 | `TenantService.fetchTenantConfigs` refuses cross-tenant reads (except SUPER_ADMIN) | Cross-tenant negative test passes |
| AC-5 | `WebhookService.create` pins `tenantId` to CLS; all 5 read/write methods enforce tenant assertions | Cross-tenant negative test per method (5 tests) |
| AC-6 | `ResourceSubscriptionService` enforces tenant on `fetchAll`, `fetchAllByResource`, `fetchById`, `update`, `deleteById` | Cross-tenant negative test per method (5 tests) |
| AC-7 | `NotificationService.fetchAllByTenantId`, `ApiKeyService.fetchAllByTenantId` reject DTO `tenantId` that mismatches CLS for non-super-admin | Cross-tenant negative test (2 tests) |
| AC-8 | `ConsultationService.getById`, `getByIdWithRelations`, `getConsultationChain` each have an explicit service-layer `assertEqualTenants` after the fetch (defense-in-depth even though extension also filters) | Cross-tenant negative test per method (3 tests) |
| AC-9 | `ContextService` array-input paths (`getSharedContext`, `getAggregateNamedEntities`, any `ids: string[]` callsite) filter to caller's tenant | Cross-tenant negative test (≥ 2 tests) |
| AC-10 | `BaseService.broadcastSysEvent` order is `{ ...payload, tenantId: this.tenantId }` (CLS wins) | Unit test pins merge order |
| AC-11 | `CoreUnitOfWorkService.startTransaction()` returns a working interactive `$transaction` (not a self-resolved tx); `UnitOfWork.transactionClient` callers route through the tenant-scoped extended client | Integration test: multi-write rollback works |
| AC-12 | `DataNotFoundException` thrown by `Repository` is mapped to `404 { message: "Resource not found" }` at the HTTP filter (no model name / id echo in production response body) | E2E test against `apps/api`: response body contains no `modelName` / id |
| AC-13 | `BaseEntity.equals()` returns `false` for two `BaseTenantEntity` instances with same `id` but different `tenantId` | Unit test pins the contract |
| AC-14 | All new cross-tenant tests are aggregated by `packages/applications/src/__tests__/cross-tenant-coverage.test.ts` (or its successor) | Aggregator run shows the new tests counted |
| AC-15 | `docs/multi-tenancy-audit/06-implementation-summary.md` (or a new `07-*` follow-up) is updated to mark C-1/C-3/C-7/H-1/H-3/H-8/M-2/M-3/M-5/M-6/M-8/L-3/L-4 + NEW-1..NEW-7 as CLOSED | Doc diff approved |

### 1.5 Decisions locked in

| Decision | Choice | Rationale |
|---|---|---|
| Defense-in-depth over single-layer | **Both** the Prisma extension AND service-layer asserts | Audit doc §F explicitly calls out "single point of failure" as the root cause; we add an explicit second line everywhere PHI flows |
| Cross-tenant response shape | **`NotFoundException` ("Resource not found")** — never `ForbiddenException` | Audit §C / D — no existence leak (mirrors existing `DepartmentService` pattern) |
| SUPER_ADMIN bypass | **Explicit per method** — services that handle PHI (Consultation, Context, Summary, DnaWritingStyle) refuse bypass; services that surface platform metadata (Tenant configs, AuditLog reads) allow bypass | Mirrors the W3.2 / W1.4 decision matrix already in production |
| DTO `tenantId` fields | **Drop where possible**; where kept, gate with CLS comparison + SUPER_ADMIN bypass | Reduces caller-input attack surface |
| Test placement | **Inline** in each service's existing `__tests__/<service>.service.test.ts` under `describe('TASK-306 …')` markers | Matches the W3+W4 inline convention; aggregator already supports this |
| Cursor rule updates | **Skip** — the existing `03-domain-layer.mdc` + `04-application-services.mdc` already capture the patterns; no rule change is needed for this ticket | Avoid churn |
| Codegen factory regeneration | **Skip** — TASK-305 W2.A already hardened the 16 factories | n/a |

---

## 2. Current State Evaluation

### 2.1 Cross-walk against `03-ddd-layers-review.md` (verified 2026-05-27)

| Code | Original severity | Status post-TASK-305 | Closes here? |
|---|---|---|---|
| C-1 | BLOCKER | **PARTIAL** — writes closed (W3.1), reads `getById`/`getByIdWithRelations`/`getConsultationChain` lack service-layer assert | **YES** (P2.1 / AC-8) |
| C-2 | BLOCKER | CLOSED (W2.A) | — |
| C-3 | BLOCKER | **PARTIAL** — single-id paths closed (W3.1), array surfaces `findSharedContext` / `getAggregateNamedEntities` unvalidated at service | **YES** (P2.5 / AC-9) |
| C-4 | BLOCKER | CLOSED (W3.1) | — |
| C-5 | BLOCKER | CLOSED (W1.4) | — |
| C-6 | BLOCKER | CLOSED (W1.3) | — |
| C-7 | BLOCKER | **PARTIAL** — `set tenantId` protected (W2.A), `set Tenant(...)` still public | **YES** (P1.1 / AC-1) |
| H-1 | HIGH | **OPEN** — `fetchTenantConfigs` accepts any tenantId | **YES** (P2.2 / AC-4) |
| H-2 | HIGH | CLOSED (W3.1) | — |
| H-3 | HIGH | **OPEN** — `TenantService.fetchById` open | **YES** (P1.3 / AC-3) |
| H-4 | HIGH | DEFERRED — needs `BaseGlobalEntity` design (TASK-305 §6.7 #1) | F-1 only |
| H-5/H-6 | HIGH | CLOSED (Prisma extension) | — |
| H-7 | HIGH | CLOSED (W3.3 + follow-up) | — |
| H-8 | HIGH | **PARTIAL** — reads scoped (W1.4); writes use caller-supplied tenantId | **YES** (P1.2 / AC-2) |
| H-9 | HIGH | CLOSED (W1.4) | — |
| M-1 | MED | CLOSED (W3.2) | — |
| M-2 | MED | **OPEN** — `WebhookService` has zero tenant guards | **YES** (P1.4 + P2.3 / AC-5) |
| M-3 | MED | **OPEN** — `ResourceSubscriptionService` tenant-blind | **YES** (P2.4 / AC-6) |
| M-4 | MED | CLOSED | — |
| M-5 | MED | **PARTIAL** — processors fixed (W3.3), `BaseService.broadcastSysEvent` merge order still lets caller override CLS | **YES** (P3.1 / AC-10) |
| M-6 | MED | **OPEN** — `CoreUnitOfWorkService.startTransaction()` non-functional (TASK-305 §6.7 #4) | **YES** (P3.2 / AC-11) |
| M-7 | MED | CLOSED (W3.3) | — |
| M-8 | MED | **OPEN** — `DataNotFoundException` carries model name + id | **YES** (P3.3 / AC-12) |
| L-1 / L-2 | LOW | CLOSED (W1.5) | — |
| L-3 | LOW | **OPEN** — JWT revocation Redis key not tenant-prefixed (low impact: jti is globally unique) | Backlog only |
| L-4 | LOW | **OPEN** — `BaseEntity.equals(other)` compares id only | **YES** (P3.4 / AC-13) |
| L-5 | LOW | CLOSED (Prisma extension) | — |
| L-6 | LOW | CLOSED (W4 — 139 tests) | — |
| L-7 | LOW | CLOSED (W3.3 follow-up) | — |

### 2.2 Newly discovered issues (verification pass 2026-05-27)

| Code | Severity | Title | File / line |
|---|---|---|---|
| NEW-1 | HIGH | `AuthorizationAuditService.logToDatabase` write uses caller-supplied `tenantId` | `authorization-audit.service.ts:171-191` |
| NEW-2 | MED | `WebhookService.create` accepts `request.tenantId` from DTO | `webhook.service.ts:23-42` |
| NEW-3 | MED | `NotificationService.fetchAllByTenantId` no CLS comparison | `notification.service.ts` |
| NEW-4 | MED | `ApiKeyService.fetchAllByTenantId` same | `apikey.service.ts` |
| NEW-5 | MED | `DnaWritingStyleService.listReports` global-role bypass (design decision) | `dna-writing-style.service.ts` |
| NEW-6 | HIGH | `TenantService.fetchById` enumerates any tenant (overlaps H-3) | `tenant.service.ts:308-316` |
| NEW-7 | LOW | Coverage aggregator hardcodes service list | `cross-tenant-coverage.test.ts` |

Each of NEW-1..NEW-4 + NEW-6 is closed by this ticket. NEW-5 is deferred to F-2 (product decision). NEW-7 is captured as F-4.

### 2.3 Key prior-art to reuse

| Pattern | Source | Use in TASK-306 |
|---|---|---|
| DEF-C3 "no existence leak" | `DepartmentService.update`, `PromptManagementService.assertOwnedByTenant`, `TenantBucketService` | Copy verbatim to W5.2 (Consultation reads) + W5.3 (Webhook/Tenant) + W5.4 (ContextItem arrays) |
| `assertParentInScope` + `assertEqualTenants` + `assertUserBelongsToTenant` | `packages/applications/src/common/tenant-guards.ts` (TASK-305 W1.2) | Reused unchanged |
| `buildTenantScope()` / `isSuperAdmin()` | `AuthorizationAuditService:369-386` (TASK-305 W1.4) | Reused for AC-3 / AC-4 / AC-7 |
| `resolveEffectiveTenantId(request.tenantId)` | `NotificationService` (TASK-305 W3.2) | Reused for AC-5 (`WebhookService.create`) |
| Inline cross-tenant test layout | W1-W4 inline tests under `describe('TASK-305 ...')` markers | Same convention with `describe('TASK-306 …')` markers |
| Coverage aggregator | `packages/applications/src/__tests__/cross-tenant-coverage.test.ts` (W4) | Extend allow-list with the new service file paths + per-method counts |

### 2.4 Dependencies

| Dependency | Where | Status |
|---|---|---|
| TASK-305 Wave 1-4 merged into `fix/2605-review` | All P1/P2 patterns | DONE |
| `nestjs-cls` mounted at API edge (`app.module.ts:108-116`) | P1.2 / P1.3 / P1.5 / P2.1-P2.4 | DONE |
| Prisma `tenantScope` extension (`packages/database/src/extensions/tenant-scope.ts`) | All — service-layer guards complement, do not replace | DONE |
| TASK-302 Phase 2 (PgBouncer + Vault) | NOT a dependency of this ticket | n/a |

---

## 3. Implementation Plan

> **Approval gate** — this section must be confirmed before any code is written. The phases are sequenced so each is an independently shippable PR. Estimated total effort: **~14 engineer-hours** (under 2 days) including TDD tests.

### Wave 5.1 — Surgical fixes bundle (one PR)

**Goal**: close every < 30 min fix in a single PR. These touch unrelated files, but they share a "1–3 line patch" character.

**Estimate**: 3 engineer-hours including tests.

**Branch**: `task-306/w5-surgical-finale`

| # | Task | File | Verify | Size |
|---|---|---|---|---|
| 5.1.1 | **P1.1 / AC-1** — change `set Tenant(...)` to `protected` | `packages/domains/src/common/baseEntity/base.tenantEntity.ts:53` | Unit test: compiling `entity.Tenant = otherTenant` from outside is a TS error; runtime test: existing `BaseTenantEntity` tests still green | S |
| 5.1.2 | **P1.2 / AC-2** — derive `tenantId` from CLS in `logToDatabase`; warn + skip if CLS missing | `packages/applications/src/services/audit/authorization-audit.service.ts:165-197` | Unit test: mocked CLS tenant-A + `entry.tenantId = tenant-B` → persisted row has tenant-A | S |
| 5.1.3 | **P1.3 / AC-3** — add `isSuperAdmin()` gate to `TenantService.fetchById` and `fetchByCodeName`; throw `NotFoundException` on mismatch | `packages/applications/src/services/tenant/tenant.service.ts:308-336` | Cross-tenant negative: tenant-A user → 404; SUPER_ADMIN → 200 | S |
| 5.1.4 | **P1.4 / AC-5 partial** — apply the `resolveEffectiveTenantId(request.tenantId)` pattern from `NotificationService` (W3.2): non-SUPER_ADMIN callers get pinned to CLS; SUPER_ADMIN may cross-tenant create (impersonation flows). **Keep** `request.tenantId` on the DTO. | `packages/applications/src/services/webhook/webhook.service.ts:23-42` + DTO | Cross-tenant negative: non-super-admin `create({ tenantId: 'tenant-B' })` from tenant-A → row created with tenant-A; SUPER_ADMIN cross-tenant create → row created with tenant-B | S |
| 5.1.5 | **P1.5 / AC-7** — add CLS check before `findAll` in `NotificationService.fetchAllByTenantId` + `ApiKeyService.fetchAllByTenantId` (SUPER_ADMIN bypass per W3.2 posture) | `notification.service.ts`, `apikey.service.ts` | Cross-tenant negative: tenant-A user → 404; SUPER_ADMIN → 200 | S |
| 5.1.6 | Aggregator update — register the new tests | `packages/applications/src/__tests__/cross-tenant-coverage.test.ts` | Aggregator run shows new tests counted | S |

**W5.1 gate**:
- [ ] All 5 cross-tenant negative tests green (one per AC)
- [ ] `pnpm build --filter @arcaai/domains --filter @arcaai/applications` clean
- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] Aggregator counts +5 tests minimum

---

### Wave 5.2 — Consultation read-paths defense-in-depth (one PR)

**Goal**: add explicit service-layer `assertEqualTenants` on the three PHI read paths that today rely only on the Prisma extension.

**Estimate**: 2 engineer-hours.

**Branch**: `task-306/w5-consultation-reads`

| # | Task | File | Verify | Size |
|---|---|---|---|---|
| 5.2.1 | **P2.1 / AC-8** — `ConsultationService.getById`: assert `entity.tenantId === this.tenantId` after `findWithContext` | `consultation.service.ts:183-193` | Cross-tenant test: 404 on foreign tenant | S |
| 5.2.2 | Same for `getByIdWithRelations` (uses `findWithRelations`) | `consultation.service.ts:198-208` | Cross-tenant test | S |
| 5.2.3 | Same for `getConsultationChain` — filter results to caller's tenant before mapping to DTO | `consultation.service.ts:253-261` | Cross-tenant test: chain straddling tenants returns only own-tenant rows | M |
| 5.2.4 | Aggregator update | aggregator file | green | S |

**W5.2 gate**:
- [ ] 3 new cross-tenant negative tests under `describe('TASK-306 P2.1 …')` green
- [ ] Existing `consultation.service.test.ts` suite still green
- [ ] Aggregator +3 tests

---

### Wave 5.3 — Tenant + Webhook + ResourceSubscription sweep (one PR)

**Goal**: apply the full tenant-guard sweep to three services.

**Estimate**: 4 engineer-hours.

**Branch**: `task-306/w5-tenant-sweep`

| # | Task | File | Verify | Size |
|---|---|---|---|---|
| 5.3.1 | **P2.2 / AC-4** — `TenantService.fetchTenantConfigs`: add `isSuperAdmin()` gate against `this.tenantId`; keep existing locked-row scrubbing | `tenant.service.ts:433-481` | Cross-tenant test: tenant-A → 404; SUPER_ADMIN → returns scrubbed configs | S |
| 5.3.2 | **P2.3 / AC-5** — `WebhookService.fetchAll`: inject `{ tenantId: this.tenantId }` into `findAll` + `count` (SUPER_ADMIN bypass) | `webhook.service.ts:44-62` | Cross-tenant test | S |
| 5.3.3 | `WebhookService.fetchById`: add `assertEqualTenants` after `findById` | `webhook.service.ts:124-132` | Cross-tenant test | S |
| 5.3.4 | `WebhookService.update`: assert tenant after `findById`, before `updateWithVersion` | `webhook.service.ts:144-167` | Cross-tenant test | S |
| 5.3.5 | `WebhookService.deleteById`: load entity, assert, then `softDelete` | `webhook.service.ts:169-177` | Cross-tenant test | S |
| 5.3.6 | `WebhookService.fetchAllByTenantId`: CLS check (P1.5 pattern) | `webhook.service.ts:64-92` | Cross-tenant test | S |
| 5.3.7 | **P2.4 / AC-6** — `ResourceSubscriptionService.fetchAll`: inject `{ tenantId: this.tenantId }` | `resourceSubscription.service.ts:60-77` | Cross-tenant test | S |
| 5.3.8 | `ResourceSubscriptionService.fetchAllByResource`: same | `resourceSubscription.service.ts:79-120` | Cross-tenant test | S |
| 5.3.9 | `ResourceSubscriptionService.fetchById`: assert after fetch | `resourceSubscription.service.ts:132-140` | Cross-tenant test | S |
| 5.3.10 | `ResourceSubscriptionService.update`: assert after `findById` | `resourceSubscription.service.ts:142-162` | Cross-tenant test | S |
| 5.3.11 | `ResourceSubscriptionService.deleteById`: load + assert + softDelete | `resourceSubscription.service.ts:197-205` | Cross-tenant test | S |
| 5.3.12 | Aggregator update — register `webhook.service.test.ts` + `resourceSubscription.service.test.ts` in `SERVICE_COVERAGE` | aggregator file | green | S |

**W5.3 gate**:
- [ ] 11 cross-tenant negative tests green under `describe('TASK-306 …')` markers
- [ ] `pnpm test --filter @arcaai/applications` green
- [ ] Aggregator +11 tests

---

### Wave 5.4 — ContextItem array-input validation (one PR)

**Goal**: close the last C-3 surface — array inputs that the Prisma extension cannot validate per-id.

**Estimate**: 2 engineer-hours.

**Branch**: `task-306/w5-context-arrays`

| # | Task | File | Verify | Size |
|---|---|---|---|---|
| 5.4.1 | **P2.5 / AC-9** — audit `ContextService` for `findSharedContext(ids[])`, `findCaseNotesFromChain(ids[])`, `getAggregateNamedEntities` and any other array-id consumer; document the surface in a short comment | `packages/applications/src/services/consultation/context/context.service.ts` | Audit list reviewed | S |
| 5.4.2 | For each array-id callsite: either (a) pre-filter the id array via `consultationRepository.findAll({ where: { tenantId, id: { in: ids } } })` and use only the resulting ids, or (b) add a `tenantId` argument to the repository method and update callers | same | Cross-tenant test: chain straddling tenants → only own-tenant items returned | M |
| 5.4.3 | Aggregator update | aggregator file | green | S |

**W5.4 gate**:
- [ ] ≥ 2 cross-tenant negative tests covering each array-id surface
- [ ] No new `RawQuery` introduced
- [ ] Aggregator +2 tests

---

### Wave 5.5 — Hygiene bundle (one PR)

**Goal**: close the M-5/M-6/M-8/L-4 hygiene findings + add the HTTP exception filter for `DataNotFoundException`.

**Estimate**: 3 engineer-hours.

**Branch**: `task-306/w5-hygiene`

| # | Task | File | Verify | Size |
|---|---|---|---|---|
| 5.5.1 | **P3.1 / AC-10** — swap `broadcastSysEvent` merge order so CLS wins: `{ ...payload, tenantId: this.tenantId }` | `packages/applications/src/common/base.service.ts` (or wherever `BaseService.broadcastSysEvent` lives) | Unit test: caller-supplied tenantId is ignored if CLS is present | S |
| 5.5.2 | **P3.2 / AC-11** — replace `CoreUnitOfWorkService.startTransaction()` with the canonical `$transaction(callback)` shape | `packages/applications/src/services/common/unit-of-work.service.ts` (or wherever it lives) | Integration test: mid-transaction error rolls back prior writes | M |
| 5.5.3 | Sweep `UnitOfWork.transactionClient` callers — route through `databaseService.client.$transaction(callback)` (the extended client carries the tenantScope extension into `tx`) | search `transactionClient` in `packages/applications` + `packages/domains` | grep returns no unscoped-baseClient usage | M |
| 5.5.4 | **P3.3 / AC-12** — add HTTP exception filter mapping `DataNotFoundException` → `404 { message: "Resource not found" }`; ensure no `modelName`/id is echoed in production builds | `apps/api/src/filters/data-not-found.filter.ts` (new) + `app.module.ts` registration | E2E test: response body matches generic message | S |
| 5.5.5 | **P3.4 / AC-13** — extend `BaseEntity.equals(other)` to compare `(tenantId, id)` when both are `BaseTenantEntity` subclasses | `packages/domains/src/common/baseEntity/base.entity.ts` | Unit test pins the contract | S |
| 5.5.6 | **NEW-7 / F-4 folded in** — harden the coverage aggregator to FS-introspect tenant-scoped services: glob `packages/applications/src/services/**/__tests__/*.service.test.ts`, filter to files referencing `tenantId` or `assertEqualTenants`/`assertParentInScope`/`assertUserBelongsToTenant`, then assert each is covered by `SERVICE_COVERAGE`. Failing the meta-test surfaces the gap. | `packages/applications/src/__tests__/cross-tenant-coverage.test.ts` | Meta-test added: deleting a service entry from `SERVICE_COVERAGE` while its test file still references tenantId → red | M |
| 5.5.7 | Aggregator update — register new W5.5 tests | aggregator file | green | S |

**W5.5 gate**:
- [ ] All hygiene unit tests green
- [ ] No regression in `pnpm test:e2e` for `apps/api`
- [ ] `rg 'baseClient\.\$transaction' packages/applications` returns only documented exceptions
- [ ] Aggregator + counts on hygiene tests

---

### Wave 5.6 — Documentation close-out (final PR)

**Goal**: pin the AC delta in audit + summary docs.

**Estimate**: 1 engineer-hour.

**Branch**: `task-306/w5-docs`

| # | Task | File | Verify | Size |
|---|---|---|---|---|
| 5.6.1 | **AC-15** — update `docs/multi-tenancy-audit/03-ddd-layers-review.md` status banner: "TASK-306 closed C-1 (reads), C-3 (arrays), C-7 (finale), H-1, H-3, H-8 (writes), M-2, M-3, M-5, M-6, M-8, L-4 + NEW-1..NEW-4, NEW-6" | `03-ddd-layers-review.md` header | Doc diff approved | S |
| 5.6.2 | Update `docs/multi-tenancy-audit/06-implementation-summary.md` with a new "Wave 5 / TASK-306" subsection in the wave table | `06-implementation-summary.md` | Doc diff approved | S |
| 5.6.3 | Write `docs/multi-tenancy-audit/07-ddd-layers-followup-closure.md` — canonical record of what TASK-306 actually closed vs. deferred; reference per-merge SHA log | new doc | Doc reviewed | S |
| 5.6.4 | Update `docs/technical-architecture-overview.md` § Multi-tenancy enforcement layers — note the explicit-service-assert layer on top of the extension | `technical-architecture-overview.md` | Doc diff approved | S |
| 5.6.5 | Update §5 of this README (Implementation Summary) with files changed and merge SHAs | this file | This README updated | S |

**W5.6 gate**:
- [ ] All audit docs updated and cross-linked
- [ ] §5 here matches the actual merged commits
- [ ] Status of this ticket flipped to `Completed`

---

## 4. Testing Strategy

### 4.1 TDD ordering per wave

Strict Red-Green-Refactor (`methodology/test-driven-development`):

- **W5.1**: write each cross-tenant negative test FIRST (RED) — confirm 200 today, then add the guard (GREEN)
- **W5.2**: write the 3 read-path negatives FIRST — confirm they currently rely only on Prisma extension by mocking the extension off, then add the service-layer assert
- **W5.3**: write 11 negatives FIRST; pattern-copy the test bodies from `notification.service.test.ts` Tasks-305 W3.2 layout
- **W5.4**: write 2 negatives FIRST with a chain straddling tenants
- **W5.5**: each hygiene fix gets its unit test FIRST

### 4.2 Test placement

| Phase | Location | Marker |
|---|---|---|
| Service tests | `packages/applications/src/services/**/__tests__/<service>.service.test.ts` | `describe('TASK-306 P*.* — …')` |
| Domain entity tests | `packages/domains/src/common/baseEntity/__tests__/<entity>.test.ts` | `describe('TASK-306 P*.* — …')` |
| HTTP exception filter | `apps/api/src/filters/__tests__/data-not-found.filter.test.ts` | `describe('TASK-306 AC-12 — …')` |
| Aggregator | `packages/applications/src/__tests__/cross-tenant-coverage.test.ts` | Existing pattern — extend `SERVICE_COVERAGE` table |

### 4.3 Manual verification checklist (each wave)

| # | Step |
|---|---|
| 1 | `pnpm build` (whole monorepo) — clean |
| 2 | `pnpm typecheck` — clean |
| 3 | `pnpm lint` — clean (no new disables for `no-restricted-imports`) |
| 4 | `pnpm test:unit` — green |
| 5 | `pnpm test --filter @arcaai/applications` — green; new test counts match plan |
| 6 | `pnpm test:e2e` (apps/api) — green where W5.5.4 applies |
| 7 | Aggregator (`cross-tenant-coverage.test.ts`) — green; per-service counts ≥ expected floors |

### 4.4 Anti-regression: existing TASK-305 cross-tenant tests must remain green

The TASK-305 aggregator pins 114 inline tests + 6 fixture + 19 aggregator-level tests. None of the W5 changes should reduce any of those counts. CI should fail if so.

---

## 5. Files to create / modify (consolidated)

### Create

```
packages/applications/src/__tests__/cross-tenant-coverage.test.ts  (UPDATE — add Webhook + ResourceSubscription to SERVICE_COVERAGE)
apps/api/src/filters/data-not-found.filter.ts
apps/api/src/filters/__tests__/data-not-found.filter.test.ts
docs/multi-tenancy-audit/07-ddd-layers-followup-closure.md
```

### Modify

```
packages/domains/src/common/baseEntity/base.tenantEntity.ts            (P1.1)
packages/domains/src/common/baseEntity/base.entity.ts                  (P3.4)
packages/applications/src/services/audit/authorization-audit.service.ts (P1.2)
packages/applications/src/services/tenant/tenant.service.ts            (P1.3, P2.2)
packages/applications/src/services/webhook/webhook.service.ts          (P1.4, P2.3)
packages/applications/src/services/webhook/dto/createWebhook.request.ts (P1.4 — drop request.tenantId or @ApiHideProperty)
packages/applications/src/services/notification/notification.service.ts (P1.5)
packages/applications/src/services/apikey/apikey.service.ts            (P1.5)
packages/applications/src/services/consultation/consultation/consultation.service.ts (P2.1)
packages/applications/src/services/consultation/context/context.service.ts (P2.5)
packages/applications/src/services/resourceSubscription/resourceSubscription.service.ts (P2.4)
packages/applications/src/common/base.service.ts                       (P3.1)  (path may differ — search for broadcastSysEvent)
packages/applications/src/services/common/unit-of-work.service.ts       (P3.2)  (path may differ — search for CoreUnitOfWorkService)
apps/api/src/app.module.ts                                              (register P3.3 filter)
docs/multi-tenancy-audit/03-ddd-layers-review.md                       (W5.6.1 — status banner)
docs/multi-tenancy-audit/06-implementation-summary.md                  (W5.6.2 — wave 5 subsection)
docs/technical-architecture-overview.md                                (W5.6.4)
docs/implementation/TASK-306-DDD-Layers-Followup/README.md             (W5.6.5 — §5 update)
```

### Test files modified (inline tests)

```
packages/applications/src/services/audit/__tests__/authorization-audit.service.test.ts
packages/applications/src/services/tenant/__tests__/tenant.service.test.ts
packages/applications/src/services/webhook/__tests__/webhook.service.test.ts                (may need creation if not present)
packages/applications/src/services/notification/__tests__/notification.service.test.ts
packages/applications/src/services/apikey/__tests__/apikey.service.test.ts
packages/applications/src/services/consultation/consultation/__tests__/consultation.service.test.ts
packages/applications/src/services/consultation/context/__tests__/context.service.test.ts
packages/applications/src/services/resourceSubscription/__tests__/resourceSubscription.service.test.ts (may need creation)
packages/applications/src/common/__tests__/base.service.test.ts
packages/applications/src/services/common/__tests__/unit-of-work.service.test.ts
packages/domains/src/common/baseEntity/__tests__/base.tenantEntity.test.ts
packages/domains/src/common/baseEntity/__tests__/base.entity.test.ts
```

---

## 6. Dependencies

| Dependency | Where | Status |
|---|---|---|
| TASK-305 W1-W4 merged into `fix/2605-review` | All waves | DONE |
| `nestjs-cls` mounted at API edge | W5.1, W5.2, W5.3 | DONE |
| Prisma `tenantScope` extension | W5.2 (defense-in-depth) | DONE |
| `applications/common/tenant-guards.ts` helpers | W5.2, W5.3, W5.4 | DONE |
| Cross-tenant coverage aggregator | All waves (extension) | DONE |

---

## 7. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| A service-layer assert returns 404 where today's behavior returned 200 with foreign-tenant data — i.e. a bug-fix that LOOKS like a regression to API consumers who were exploiting it | MEDIUM | Each AC ships its own cross-tenant negative test; the "exploiters" are by definition wrong. Document the behavior change in W5.6 release notes. |
| Drop of `request.tenantId` from `CreateWebhookRequest` DTO breaks an admin tool that intentionally cross-tenant creates webhooks | LOW | Keep the DTO field for SUPER_ADMIN with the same `resolveEffectiveTenantId` gate used in `NotificationService.create` (W3.2 pattern). Document in W5.1.4. |
| `CoreUnitOfWorkService.startTransaction()` fix changes the call signature (caller had to know it's broken) | LOW | Keep a deprecated signature alongside the new `startTransaction(callback)` signature for one release; ESLint rule warns at old call-sites. |
| HTTP exception filter for `DataNotFoundException` changes the production response body — admin tooling that parses error payloads may break | LOW | Gate the new generic message on `NODE_ENV === 'production'`; dev / staging retain the existing model + id payload for debuggability. |
| W5.3 Webhook sweep introduces 11 new tests; flaky test suite slows CI | LOW | All tests use existing test fixtures; no new DB/Redis setup. |
| Compile fan-out: dropping `request.tenantId` from `WebhookService.create` may break controllers / clients | MEDIUM | Phase A → typecheck the whole monorepo before merge; expect ≤ 3 fix sites in controllers. |
| `BaseEntity.equals()` extension may flip behavior of an existing collection-membership check | LOW | Audit all `entity.equals` callers (small surface today); add the test that pins the new behavior. |

---

## 8. Out of scope (and tracked elsewhere)

| Audit item / new finding | Status | Where it goes |
|---|---|---|
| H-4 — `User`/`UserMedia` blindly findById cross-tenant | Deferred — needs `BaseGlobalEntity` design (F-1) | Separate ticket — architectural decision (TASK-305 §6.7 #1) |
| NEW-5 — `DnaWritingStyleService.listReports` global-role bypass | Deferred — product decision (F-2) | Separate ticket — is `GLOBAL_ADMIN` deliberately cross-tenant? |
| NEW-7 — aggregator FS-introspection | **MOVED IN-SCOPE** — folded into W5.5.6 per user direction | n/a (was F-4) |
| NotificationService SUPER_ADMIN posture inconsistency (TASK-305 §6.7 #7) | Deferred — product decision (F-3) | Separate ticket — tighten or audit-log |
| `auditLog.processor.spec.ts` dead file (TASK-305 §6.7 #9) | Deferred — housekeeping (F-5) | Separate housekeeping ticket |
| `WorkerSession` soft typing (TASK-305 §6.7 #10) | Deferred — style (F-6) | Separate ticket |
| Drop redundant single-column `@@index([tenantId])` (TASK-305 §6.7 #3) | Deferred — perf opt (F-7) | Separate ticket — write-throughput micro-opt |
| `CoreDataModel` wildcard re-export removal (TASK-305 §6.7 #5) | Deferred — latent footgun, no consumers (F-8) | Separate ticket |
| L-3 — JWT revocation Redis key not tenant-prefixed | Deferred — low impact (jti globally unique) | Backlog only |
| RLS rollout (audit B1 / TASK-305 Phase C) | Owned by TASK-302 | TASK-302 Phase 2 |
| User model split into User + TenantUser (audit B6) | Architectural ticket | Separate |
| `User.password` / `secret1` / `secret2` (audit C4/C5) | Security review | Separate |
| `StorageAccessKey.bucketIds String[]` (audit C3) | Independent refactor | Separate |
| Pre-existing `fetchAllByTenantId` gaps audited (TASK-305 §6.7 #8) | Closed here for Notification + ApiKey (NEW-3, NEW-4); DnaWritingStyle deferred as F-2 | partial |

---

## 9. Success criteria (final gate)

- [ ] All AC-1 .. AC-15 met with evidence pasted into the PR
- [ ] All Wave 5.* gates green
- [ ] No new lint errors anywhere in the monorepo
- [ ] TASK-305 cross-tenant aggregator floor preserved (114 + 6 + 19 minimum)
- [ ] TASK-306 cross-tenant aggregator floor: ≥ 25 new inline tests (W5.1: 5, W5.2: 3, W5.3: 11, W5.4: 2, W5.5: ≥ 4)
- [ ] `docs/multi-tenancy-audit/07-ddd-layers-followup-closure.md` written and signed off
- [ ] §5 of this README updated with merged commits
- [ ] Code reviewer subagent (`code-reviewer`) signs off on each wave PR
- [ ] Compliance / product lead signs off on the AC delta (W5.6)

---

## 10. Open questions for the user

These do not block plan approval — answer them during execution. Listed here so they don't get lost.

1. **DTO `request.tenantId` on `CreateWebhookRequest`** — drop the field entirely, or keep it for SUPER_ADMIN cross-tenant writes (matching `CreateApiKeyRequest` W3.2 posture)?
Answer: we need to keep it for SUPER_ADMIN cross-tenant writes and for impersonation flows.
2. **HTTP exception filter scope** — apply the generic 404 mapping only to `DataNotFoundException`, or also to `NotFoundException` thrown by the new `assertEqualTenants` guards (today the latter already returns a generic "Resource not found")?
Answer: we should apply the generic 404 mapping only to `DataNotFoundException`.
3. **`CoreUnitOfWorkService` callers** — do we want a hard-deprecation path (rename + ESLint) or a silent in-place fix (replace the broken body, keep the signature)?
Answer: we should use the silent in-place fix.
4. **Aggregator hardening (NEW-7 / F-4)** — fold the FS-introspection improvement into this ticket (W5.5) or split out as its own ticket?
Answer: we should fold the FS-introspection improvement into this ticket (W5.5).
5. **Wave grouping** — ship W5.1-W5.5 as 5 separate PRs (clean reviewable units) or one fat PR (less ceremony)?
Answer: we should ship W5.1-W5.5 as 5 separate PRs (clean reviewable units).

---

## 5. Implementation Summary

> All 6 waves landed on `fix/2605-review` between 2026-05-27 (W5.1) and
> 2026-05-27 (W5.6 — this wave). Engineer-hours actual ≈ 13 vs. 14
> estimated. Total cross-tenant test delta: +97 inline tests across
> `packages/applications` + `packages/domains` + `apps/api`. Aggregator
> state advanced 19 (TASK-305 W4 close-out) → 30 (TASK-306 W5.5.7 close-out).
> Canonical closure record:
> [`docs/multi-tenancy-audit/07-ddd-layers-followup-closure.md`](../../multi-tenancy-audit/07-ddd-layers-followup-closure.md).

### What shipped

| Wave | Sub-tasks | Merge SHA | Highlights |
|---|---|---|---|
| W5.1 | 5.1.1–5.1.6 | `78e7b354` | 6 commits, 20 new tests, APPROVED-WITH-MINOR-NITS. Closes C-7 finale + H-3/NEW-6 + H-8/NEW-1 + NEW-2 + NEW-3 + NEW-4. 4 deferred nits captured in §6.7. |
| W5.2 | 5.2.1–5.2.4 | `66b1d579` | 4 commits, 9 new tests, APPROVED-WITH-MINOR-NITS. Closes C-1 read-paths (defense-in-depth `assertEqualTenants` on `getById`/`getByIdWithRelations`/`getConsultationChain`). 3 deferred nits captured in §6.7. |
| W5.3 | 5.3.1–5.3.12 | `60d9d798` | 13 commits (12 plan + 1 TASK-258 test alignment), 34 new tests, APPROVED-WITH-MINOR-NITS. Closes H-1 + M-2 + M-3. Tenant + Webhook (5 methods) + ResourceSubscription (5 methods) sweep with uniform SUPER_ADMIN bypass. 2 deferred nits (306-F8, 306-F9). |
| W5.4 | 5.4.1–5.4.3 | `969e49df` | 3 commits, 9 new tests, APPROVED-WITH-MINOR-NITS. Closes C-3 finale (array-input). `resolveLinkedConsultationIds` filters chain + same-day to CLS tenant; no SUPER_ADMIN bypass (clinical-PHI hot read path). 2 deferred nits (306-F10, 306-F11). |
| W5.5 | 5.5.1–5.5.7 | `ec67a0d4` | 7 commits, 25 new tests, APPROVED-WITH-MINOR-NITS. Closes M-5 + M-6 + M-8 + L-4 + NEW-7/F-4. Hygiene bundle: `broadcastSysEvent` CLS wins, `CoreUnitOfWorkService` canonical `$transaction(callback)` (silent in-place fix), `DataNotFoundException` HTTP filter (scoped), `BaseEntity.equals` tenant-aware (duck-typed), aggregator FS-introspection (immediately surfaced pre-existing gap in `prompt-management.service.test.ts`). Also folds in 306-F9 + 306-F10. 3 deferred nits (306-F12, 306-F13, 306-F14). |
| W5.6 | 5.6.1–5.6.5 | `<pending merge>` | 5 commits, 0 production-code lines, doc-only. Updates: (1) `03-ddd-layers-review.md` — TASK-306 closure banner + per-finding `[CLOSED W5.x <sha>]` markers in §A/§B inventory + §C/§D/§E finding detail blocks; (2) `06-implementation-summary.md` — new §6 Wave 5 / TASK-306 follow-up section (wave breakdown + audit findings closed + test deltas + deferred follow-ups + cross-links); (3) NEW `07-ddd-layers-followup-closure.md` — canonical "what closed vs. deferred" record with per-wave merge SHAs, lessons learned, cross-references; (4) `technical-architecture-overview.md` — Layer 3 acknowledges the TASK-306 finale + Open items #2, #5 marked CLOSED/PARTIALLY-CLOSED + helper table extended; (5) this README — Status → Completed + W5.6 row filled + §11 Change History entry. |

### Audit findings closed

| Status | Codes | Notes |
|---|---|---|
| **CLOSED (W5.1)** | C-7 finale, H-3/NEW-6, H-8/NEW-1, NEW-2, NEW-3, NEW-4 | Merge `78e7b354` |
| **CLOSED (W5.2)** | C-1 read-paths | Merge `66b1d579` |
| **CLOSED (W5.3)** | H-1, M-2, M-3 | Merge `60d9d798` |
| **CLOSED (W5.4)** | C-3 finale (array-input) | Merge `969e49df` |
| **CLOSED (W5.5)** | M-5, M-6, M-8, L-4, NEW-7/F-4 | Merge `ec67a0d4` |
| **CLOSED via W5.5.7 (deferred folds)** | 306-F9, 306-F10 | Aggregator cosmetic + marker tightening |
| **DOCUMENTED (W5.6)** | AC-15 — audit + summary + architecture docs cross-walked; canonical closure record at `07-ddd-layers-followup-closure.md` | Merge `<pending>` |
| **DEFERRED (TASK-306 plan §8)** | F-1..F-3, F-5..F-8, H-4, L-3, NEW-5/F-2 | Each tracked as a follow-up ticket — see §8 |
| **DEFERRED (review-time minor nits)** | 306-F1..306-F8, 306-F11..306-F14 | 12 minor nits captured across W5.1-W5.5 code reviews — see §6.7 below. None blocking; all minor |

### TASK-306 follow-ups (deferred minor nits)

These do NOT block waves; tracked here so they don't get lost.

| # | Source wave | Description |
|---|---|---|
| 306-F1 | W5.1 review | Replace `setTimeout(10)` with `vi.waitFor(...)` in three `TASK-306 P1.2` audit tests for CI flake-resistance |
| 306-F2 | W5.1 review | Add `logger.warn('Webhook cross-tenant attempt coerced to CLS', { ... })` inside `WebhookService.resolveEffectiveTenantId` for SOC observability on silent coercion |
| 306-F3 | W5.1 review | Drop unnecessary `as never` cast in W5.1.4 "omits request.tenantId" test |
| 306-F4 | W5.1 review | Aggregator per-method floor pinning when W5.2–W5.5 add new `describe('TASK-306 …')` blocks (W5.5.6 handles this via FS-introspection) |
| 306-F5 | W5.2 review | Hoist missing-CLS check to top of `getById` / `getByIdWithRelations` to mirror `getConsultationChain` convention (saves wasted repo round-trip on missing-CLS background calls) |
| 306-F6 | W5.2 review | Add explicit empty-chain test under `describe('TASK-306 P2.1 — getConsultationChain', ...)` so the empty-vs-all-foreign contract is self-contained under the new marker |
| 306-F7 | W5.2 review | Drop or annotate the duplicate `getById` "sanity" test as a deliberate regression-pin |
| 306-F8 | W5.3 review | Cross-tenant `fetchById` tests on Webhook + RS — add explicit `expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(SysEventType.ResourceViewed, ...)` assertion (structural guarantee already, but more self-evident with the negative-assertion) |
| 306-F9 | W5.3 review | Drop unnecessary `i` flag on `/TASK-306/i` resourceSubscription aggregator marker for cosmetic consistency with tenant + webhook entries |
| 306-F10 | W5.4 review | Aggregator: switch `consultation/context` marker from `/TASK-306/` to `/TASK-305 D\.3\|cross-aggregate tenant\|TASK-306/i` (3-token pattern matching W5.2 `consultation/consultation`) to preserve explicit floor on 8 TASK-305 D.3 anti-regression tests; W5.5.6 FS-introspection only validates file membership, not per-describe floors. Fold into W5.5 aggregator changes. |
| 306-F11 | W5.4 review | `ContextService.getAggregateNamedEntities` `scope='single'` still emits `ResourceViewed` broadcast on foreign-tenant id (response is empty via extension scoping; no data leak, but the broadcast itself is a minor signal). Out of W5.4 scope; hygiene follow-up. |
| 306-F12 | W5.5 review | `BaseEntity.equals` dropped pre-existing strict-class check alongside the tenant fix. AC-13 only required the tenant fix. New behavior: heterogeneous entity types with same id now compare equal (arguably more DDD-correct, no in-tree callers compare heterogeneous types). Document the conscious change in plan §6 or revisit. |
| 306-F13 | W5.5 review | Orphan dead-code class `UnitOfWorkService<T>` at `packages/domains/src/common/unitOfWork.service.ts` exhibits the same broken self-resolved-tx pattern as pre-W5.5.2 `CoreUnitOfWorkService`. Zero production callers verified, so M-6 risk is zero. Add a one-line note in the W5.5.3 annotation block to warn future writers, or delete the dead file in a separate housekeeping ticket. |
| 306-F14 | W5.5 review | FS-introspection detection regex drops bare `tenantId` token (only matches helper names / `TASK-30x` markers) to avoid false-positive flooding from boot/logger/JWT setup code. A file exercising cross-tenant behavior with bare `tenantId` and no helper/marker would slip through silently. Mitigated by the convention that cross-tenant tests live under `describe('TASK-30x …')`. Record the conscious deviation in plan §6. |

### Deviations from the original plan

| Wave | Deviation | Rationale |
|---|---|---|
| W5.3 | +1 commit (13 total vs. 12 planned) — TASK-258 test alignment | A pre-existing `webhook` test had drifted from the W3.2 SUPER_ADMIN-bypass posture this wave reuses; aligning it at the same time prevents an avoidable cross-PR conflict. Reviewer-approved. |
| W5.5.6 | Detection regex deliberately narrower than the user-specified set (drops bare `tenantId` token) | A bare `tenantId` matcher floods false positives (logger / JWT / AppSettings setup blocks). Narrow set anchored on the helper exports + canonical `describe('TASK-30x …')` markers; conscious deviation captured as **306-F14** for future revisit. |
| W5.5.7 | 306-F9 + 306-F10 folded into W5.5.7 aggregator step | Cheap one-character marker fix (306-F9 — drop `/i` flag on `resourceSubscription`) + a regression-preventing floor adjustment (306-F10 — broaden `consultation/context` marker so the 8 TASK-305 D.3 anti-regression tests stay pinned by an explicit floor, not only by FS-introspection). Both inside the W5.5 aggregator-update step; no scope creep. |
| W5.5.4 (`DataNotFoundException` filter) | Scoped to `DataNotFoundException` only (not all `NotFoundException`s) | Per the user decision at plan approval time (open question #2). Keeps debug-friendly payloads for the `assertEqualTenants`-raised `NotFoundException` paths in dev/staging while production cleanly hides model + id. |
| W5.5.2 (`CoreUnitOfWorkService`) | Silent in-place fix + `@deprecated` annotation, no rename / ESLint deprecation rule | Per the user decision at plan approval time (open question #3). Zero production-caller churn; legacy callers see a runtime `Logger.warn` so the migration path is discoverable without a forced refactor. |
| W5.6.2 (06 summary) | Doc gains a new §6 (TASK-306 follow-up) rather than re-titling the doc or restructuring TASK-305 sections | The existing doc is titled and structured around TASK-305; preserving its numbering + adding a clearly-demarcated §6 follow-up matches the user's "add a new ... row (or section)" instruction without churning the TASK-305 sections. |

None of these deviations changed the AC contract — every AC-1..AC-15
landed as planned.

---

## 11. Change History

| Date | Description | Files modified |
|---|---|---|
| 2026-05-27 | Initial plan drafted post-TASK-305 verification cross-walk; awaiting approval | `docs/implementation/TASK-306-DDD-Layers-Followup/README.md` |
| 2026-05-27 | Plan approved — user answers folded into body: W5.1.4 keeps `request.tenantId` with SUPER_ADMIN gate (impersonation flows); HTTP filter scoped to `DataNotFoundException` only (W5.5.4); `CoreUnitOfWorkService` silent in-place fix (W5.5.2); NEW-7 / F-4 aggregator hardening promoted in-scope (new W5.5.6); 5 separate PRs (one per wave); status flipped to `In Progress` | `docs/implementation/TASK-306-DDD-Layers-Followup/README.md` |
| 2026-05-27 | W5.1 merged at `78e7b354` (APPROVED-WITH-MINOR-NITS). 6 commits, 20 new tests, closes C-7 finale + H-3/NEW-6 + H-8/NEW-1 + NEW-2 + NEW-3 + NEW-4. 4 minor nits captured as 306-F1..306-F4. | `packages/{domains,applications}/...` (13 files), `docs/implementation/TASK-306-DDD-Layers-Followup/README.md` |
| 2026-05-27 | W5.2 merged at `66b1d579` (APPROVED-WITH-MINOR-NITS). 4 commits, 9 new tests, closes C-1 read-paths (defense-in-depth `assertEqualTenants` on Consultation read methods). 3 minor nits captured as 306-F5..306-F7. | `packages/applications/...` (3 files), `docs/implementation/TASK-306-DDD-Layers-Followup/README.md` |
| 2026-05-27 | W5.3 merged at `60d9d798` (APPROVED-WITH-MINOR-NITS). 13 commits (12 plan + 1 TASK-258 test alignment), 34 new tests, closes H-1 + M-2 + M-3 (Tenant + Webhook 5 methods + ResourceSubscription 5 methods sweep). 2 minor nits captured as 306-F8, 306-F9. | `packages/applications/...` (8 files), `docs/implementation/TASK-306-DDD-Layers-Followup/README.md` |
| 2026-05-27 | W5.4 merged at `969e49df` (APPROVED-WITH-MINOR-NITS). 3 commits, 9 new tests, closes C-3 finale (array-input). `ContextService.resolveLinkedConsultationIds` filters chain + same-day to CLS tenant. 2 minor nits captured as 306-F10, 306-F11. | `packages/applications/...` (3 files), `docs/implementation/TASK-306-DDD-Layers-Followup/README.md` |
| 2026-05-27 | W5.5 merged at `ec67a0d4` (APPROVED-WITH-MINOR-NITS). 7 commits, 25 new tests, closes M-5 + M-6 + M-8 + L-4 + NEW-7/F-4 (hygiene bundle + aggregator FS-introspection). 306-F9 + 306-F10 folded in. 3 minor nits captured as 306-F12, 306-F13, 306-F14. FS-introspection surfaced one pre-existing gap (prompt-management cross-tenant tests not aggregator-registered) and closed it inline. | `apps/api/...` (+2 new), `packages/{applications,domains}/...` (12 modified), `docs/implementation/TASK-306-DDD-Layers-Followup/README.md` |
| 2026-05-27 | W5.6 merged at `<pending>` — documentation close-out (AC-15). 5 commits, 0 production-code lines, doc-only. (1) `03-ddd-layers-review.md` — TASK-306 closure banner + per-finding `[CLOSED W5.x <sha>]` markers in §A/§B inventory + §C/§D/§E finding detail blocks; (2) `06-implementation-summary.md` — new §6 Wave 5 / TASK-306 follow-up section; (3) NEW `07-ddd-layers-followup-closure.md` — canonical closure record; (4) `technical-architecture-overview.md` — Layer 3 TASK-306 finale + Open items #2, #5 marked CLOSED / PARTIALLY-CLOSED + helper table extended; (5) this README — Status flipped to `Completed` + W5.6 row populated + §5 Audit findings closed table extended + Deviations section populated + this Change History entry. Ticket closed. | `docs/multi-tenancy-audit/03-ddd-layers-review.md`, `docs/multi-tenancy-audit/06-implementation-summary.md`, `docs/multi-tenancy-audit/07-ddd-layers-followup-closure.md` (NEW), `docs/technical-architecture-overview.md`, `docs/implementation/TASK-306-DDD-Layers-Followup/README.md` |
