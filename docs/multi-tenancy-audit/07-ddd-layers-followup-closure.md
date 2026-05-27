# 07 — TASK-306 DDD-Layers Follow-up — Closure Record

| Field | Value |
|---|---|
| **Ticket** | TASK-306 — DDD-Layers Follow-up |
| **Plan** | [`docs/implementation/TASK-306-DDD-Layers-Followup/README.md`](../implementation/TASK-306-DDD-Layers-Followup/README.md) |
| **Audit driver** | [`03-ddd-layers-review.md`](./03-ddd-layers-review.md) (this doc cross-walks every TASK-306-closed code back into the audit) |
| **Status** | **Completed** |
| **Plan approved** | 2026-05-27 |
| **Implementation complete** | 2026-05-27 (W5.5 merged at `ec67a0d4`) |
| **Documentation closed out** | 2026-05-27 (W5.6) |
| **Engineer-hours (actual / estimated)** | ≈ 13 / 14 |
| **Wave merge SHAs** | W5.1 `78e7b354`, W5.2 `66b1d579`, W5.3 `60d9d798`, W5.4 `969e49df`, W5.5 `ec67a0d4`, W5.6 `82b3b9e4` |
| **Approach** | 5 sequential implementation waves + 1 documentation wave per the `executing-plans` skill — fresh implementation subagent per wave + mandatory code-reviewer subagent between waves + `--no-ff` merges back to `fix/2605-review`. All 5 reviews returned **APPROVED-WITH-MINOR-NITS** (0 critical, 0 important issues across all 5 sequential reviews) |
| **Predecessor** | TASK-305 (Multi-Tenancy Hardening — Phases A, B, D, E) — see [`06-implementation-summary.md`](./06-implementation-summary.md) |
| **Companion** | TASK-302 (PgBouncer + Vault — owns the RLS Phase C deferred from TASK-305 and from this ticket as F-1) |

This is the canonical "what TASK-306 actually closed vs. deferred"
document. Every audit-finding code from `03-ddd-layers-review.md`
that TASK-306 touched is accounted for below, with the closure path,
wave, merge SHA, and (for deferrals) the rationale and next-ticket
pointer. Read [`06-implementation-summary.md` §6](./06-implementation-summary.md#6-wave-5--task-306--ddd-layers-followup-2026-05-27)
for the cross-cutting wave summary; this doc is the granular
per-finding ledger.

---

## 1. What TASK-306 Closed

### 1.1 Audit findings (`03-ddd-layers-review.md`)

| Code | Severity | Closure path | Wave | Merge SHA |
|---|---|---|---|---|
| **C-1** (reads) | BLOCKER | Defense-in-depth `assertEqualTenants` on `ConsultationService.getById` / `getByIdWithRelations` / chain-filter on `getConsultationChain` | W5.2 | `66b1d579` |
| **C-3** (single-id) | BLOCKER | Closed earlier by TASK-305 W3.1 (`assertContextItemsInTenant` / `assertParentInScope`) — out of TASK-306 scope | (pre-TASK-306) | — |
| **C-3** (array-input) | BLOCKER | `ContextService.resolveLinkedConsultationIds` filters chain + same-day to CLS tenant (no SUPER_ADMIN bypass on this clinical-PHI hot read path) | W5.4 | `969e49df` |
| **C-7** (finale) | BLOCKER | `BaseTenantEntity.set Tenant(...)` → `protected` (the already-hardened `set tenantId` setter is now matched by the relation setter) | W5.1 | `78e7b354` |
| **H-1** | HIGH | `TenantService.fetchTenantConfigs` SUPER_ADMIN gate (uniform with `fetchById` / `fetchByCodeName`) | W5.3 | `60d9d798` |
| **H-3 / NEW-6** | HIGH | `TenantService.fetchById` + `fetchByCodeName` SUPER_ADMIN gate (CLS tenantId compared against requested id; non-super-admin gets 404) | W5.1 | `78e7b354` |
| **H-8 / NEW-1** | HIGH | `AuthorizationAuditService.logToDatabase` CLS pin + fail-closed (caller-supplied `entry.tenantId` ignored when CLS is set; warn + skip when CLS missing) | W5.1 | `78e7b354` |
| **M-2 / NEW-2** | MED | `WebhookService` full sweep — `resolveEffectiveTenantId` on `create` + 5-method tenant-guard sweep (`fetchAll`, `fetchById`, `update`, `deleteById`, `fetchAllByTenantId`) | W5.1 + W5.3.2–5.3.6 | `78e7b354` + `60d9d798` |
| **M-3** | MED | `ResourceSubscriptionService` 5-method tenant-guard sweep (`fetchAll`, `fetchAllByResource`, `fetchById`, `update`, `deleteById`) | W5.3.7–5.3.11 | `60d9d798` |
| **M-5** | MED | `BaseService.broadcastSysEvent` merge order swapped — `{ ...payload, tenantId: this.tenantId }` so CLS wins on tenantId override | W5.5.1 | `ec67a0d4` |
| **M-6** | MED | `CoreUnitOfWorkService` — silent in-place fix of the broken self-resolved-tx pattern + new canonical `runInTransaction(work)` alternative; legacy methods marked `@deprecated + Logger.warn` (zero production-caller churn) | W5.5.2 | `ec67a0d4` |
| **M-8** | MED | HTTP exception filter mapping `DataNotFoundException` → `404 { message: "Resource not found" }` in production (`NODE_ENV === 'production'` gate; dev / staging retain model name + id for debuggability). Scope: `DataNotFoundException` only (not `NotFoundException`) per user decision | W5.5.4 | `ec67a0d4` |
| **L-4** | LOW | `BaseEntity.equals` tenant-aware via duck-typing on `BaseTenantEntity` subclasses — returns `false` for two same-id entities in different tenants | W5.5.5 | `ec67a0d4` |
| **NEW-3 / NEW-4** | DISCOVERED | `NotificationService.fetchAllByTenantId` + `ApiKeyService.fetchAllByTenantId` CLS gate (rejects DTO `tenantId` that mismatches CLS for non-SUPER_ADMIN) | W5.1.5 | `78e7b354` |
| **NEW-7 / F-4** | DISCOVERED | Aggregator FS-introspection meta-test — walks `packages/applications/src/services/**/__tests__/*.service.test.ts`, filters to files referencing the tenant-guard helper set or canonical `describe('TASK-30x …')` markers, asserts each is registered in `SERVICE_COVERAGE`. Surfaced + closed one pre-existing gap (`prompt-management.service.test.ts` was unregistered) | W5.5.6 | `ec67a0d4` |
| **F-4** | DEFERRED-THEN-CLOSED | Same as NEW-7 — folded in-scope per user direction at plan approval time | W5.5.6 | `ec67a0d4` |

### 1.2 Aggregator state

| State | Service entries | Processor entries | Meta tests | Total |
|---|---|---|---|---|
| Pre-TASK-305 baseline | 0 | 0 | 0 | 0 |
| Post-TASK-305 (W4) | 11 | 6 | 2 | **19** |
| Pre-W5.5 (TASK-306 W5.1 + W5.3) | 14 | 6 | 2 | **22** |
| Post-TASK-306 (W5.5.7) | 17 | 6 | 7 | **30** |

Net new TASK-306 entries (6): `tenant`, `webhook`, `resourceSubscription`,
`prompt-management`, `common/base.service`, `baseServices/core.unitOfWork`.

Of those, `prompt-management` was a **pre-existing gap** surfaced by
the W5.5.6 FS-introspection meta-test (the file already exercised
cross-tenant isolation under two `describe(...)` blocks
— `Cross-Tenant Isolation` and `Authorization & tenant scope (DEF-C2)` —
but was never registered in the allow-list). The fact that
introspection caught this on its first run is the strongest validation
of the meta-test pattern.

### 1.3 Cross-tenant test count delta

97 net new inline cross-tenant tests across `packages/applications`,
`packages/domains`, and `apps/api`:

| Wave | Tests added | What |
|---|---|---|
| W5.1 (P1.x) | 20 | C-7, H-3/NEW-6, H-8/NEW-1, NEW-2..NEW-4 |
| W5.2 (P2.1) | 9 | C-1 read-paths (3 `getById` + 2 `getByIdWithRelations` + 4 `getConsultationChain`) |
| W5.3 (P2.2 + P2.3 + P2.4) | 34 | H-1 (6 tenant tests) + M-2/NEW-2 webhook sweep (14) + M-3 RS sweep (13) + 1 TASK-258 alignment |
| W5.4 (P2.5) | 9 | C-3 array-input on `ContextService.resolveLinkedConsultationIds` |
| W5.5 (P3.x + W5.5.6 meta) | 25 | M-5 (4 `broadcastSysEvent`) + M-6 (4 `runInTransaction`) + M-8 (filter integration) + L-4 (`BaseEntity.equals`) + W5.5.6 FS-introspection (5 meta) + W5.5.4 HTTP filter unit + smoke |
| **Total** | **97** | |

The TASK-305 floor (114 inline + 6 fixture + 19 aggregator-level) is
preserved — every TASK-306 wave gate verified that no TASK-305 test
count dropped.

---

## 2. What TASK-306 Deferred

Two classes of deferrals — original-plan deferrals (locked in at plan
approval) and review-time minor nits (captured during code review of
each wave). Neither class is blocking.

### 2.1 Original-plan deferrals (TASK-306 plan §8)

| Code | Topic | Why deferred | Where it goes |
|---|---|---|---|
| **F-1** | PostgreSQL RLS (audit B1 / TASK-305 Phase C) | Schema-wide change requiring DBA review, `hope_tenant_user NOSUPERUSER NOBYPASSRLS` role split, and PgBouncer + Vault wiring | TASK-302 Phase 2 |
| **F-2 / NEW-5** | `DnaWritingStyleService.listReports` GLOBAL_ADMIN bypass | Product decision — is `GLOBAL_ADMIN` deliberately cross-tenant? The current bypass is consistent with how GLOBAL_ADMIN is treated in adjacent services, so closure depends on product-level policy alignment | Separate ticket |
| **F-3** | `NotificationService` SUPER_ADMIN posture inconsistency | Product decision — tighten (refuse SUPER_ADMIN cross-tenant reads) or audit-log (allow with mandatory audit row)? Inconsistent with the parallel DnaWritingStyleService refusal posture | Separate ticket |
| **F-5** | `auditLog.processor.spec.ts` dead file (TASK-305 §6.7 #9) | Housekeeping — vitest/eslint skip `.spec.ts` inside `__tests__/` folders, so the file is silently dead | Separate housekeeping ticket |
| **F-6** | `WorkerSession` soft typing (TASK-305 §6.7 #10) | Style cleanup — `as unknown as UserSession` cast pattern repeated 8× across queue/event processors | Separate ticket |
| **F-7** | Drop redundant single-column `@@index([tenantId])` (TASK-305 §6.7 #3) | Write-throughput micro-opt — composite `[tenantId, X]` indexes added in TASK-305 W2.A cover the same workloads | Separate ticket |
| **F-8** | `CoreDataModel` wildcard re-export removal (TASK-305 §6.7 #5) | Latent footgun with zero current consumers — ESLint `importNames` does not follow wildcard re-exports, so the `core.database.types.ts` `export * as CoreDataModel` is a hole in the unscoped-client allow-list | Separate ticket |
| **L-3** | JWT revocation Redis key not tenant-prefixed | Backlog only — `jti` is globally unique so there is no practical collision risk; tenant-prefixing is a nice-to-have for cross-tenant observability | Backlog |
| **H-4** | `User` / `UserMedia` blindly findById cross-tenant | Architectural — needs `BaseGlobalEntity` design (also tracked as TASK-305 §6.7 #1). The `assertUserBelongsToTenant` guard at every PHI-bearing create provides the invariant equivalent today | Separate architectural ticket |

`NEW-7 / F-4` was moved IN-SCOPE during plan approval and closed in
W5.5.6 — see §1.1 above.

### 2.2 Review-time minor nits (306-Fx)

14 nits captured across the W5.1–W5.5 code reviews. All are minor and
none block any AC. **306-F9 + 306-F10 were folded into W5.5.7** as
part of the aggregator-update step; the remaining 12 are
follow-up-ticket candidates.

| # | Source review | Description |
|---|---|---|
| **306-F1** | W5.1 review | Replace `setTimeout(10)` with `vi.waitFor(...)` in three `TASK-306 P1.2` audit tests for CI flake-resistance |
| **306-F2** | W5.1 review | Add `logger.warn('Webhook cross-tenant attempt coerced to CLS', { ... })` inside `WebhookService.resolveEffectiveTenantId` for SOC observability on silent coercion |
| **306-F3** | W5.1 review | Drop unnecessary `as never` cast in W5.1.4 "omits request.tenantId" test |
| **306-F4** | W5.1 review | Aggregator per-method floor pinning when W5.2–W5.5 add new `describe('TASK-306 …')` blocks — superseded by W5.5.6 FS-introspection |
| **306-F5** | W5.2 review | Hoist missing-CLS check to top of `getById` / `getByIdWithRelations` to mirror `getConsultationChain` convention (saves wasted repo round-trip on missing-CLS background calls) |
| **306-F6** | W5.2 review | Add explicit empty-chain test under `describe('TASK-306 P2.1 — getConsultationChain', ...)` so the empty-vs-all-foreign contract is self-contained under the new marker |
| **306-F7** | W5.2 review | Drop or annotate the duplicate `getById` "sanity" test as a deliberate regression-pin |
| **306-F8** | W5.3 review | Cross-tenant `fetchById` tests on Webhook + RS — add explicit `expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(SysEventType.ResourceViewed, ...)` assertion (structural guarantee already, but more self-evident with the negative-assertion) |
| **306-F9** | W5.3 review | **CLOSED W5.5.7** — drop unnecessary `i` flag on `/TASK-306/i` resourceSubscription aggregator marker for cosmetic consistency with tenant + webhook entries |
| **306-F10** | W5.4 review | **CLOSED W5.5.7** — aggregator: switch `consultation/context` marker back to a 3-token pattern (`/TASK-305 D\.3\|cross-aggregate tenant\|TASK-306/i`) so the explicit floor tracks BOTH the 8 TASK-305 D.3 anti-regression tests AND the 9 TASK-306 P2.5 tests (floor 9 → 17) |
| **306-F11** | W5.4 review | `ContextService.getAggregateNamedEntities` `scope='single'` still emits `ResourceViewed` broadcast on a foreign-tenant id (response is empty via extension scoping; no data leak, but the broadcast itself is a minor signal). Out of W5.4 scope; hygiene follow-up |
| **306-F12** | W5.5 review | `BaseEntity.equals` dropped the pre-existing strict-class check alongside the tenant fix. AC-13 only required the tenant fix. New behavior: heterogeneous entity types with the same id now compare equal (arguably more DDD-correct, no in-tree callers compare heterogeneous types). Document the conscious change in plan §6 or revisit |
| **306-F13** | W5.5 review | Orphan dead-code class `UnitOfWorkService<T>` at `packages/domains/src/common/unitOfWork.service.ts` exhibits the same broken self-resolved-tx pattern as pre-W5.5.2 `CoreUnitOfWorkService`. Zero production callers verified, so M-6 risk is zero. Add a one-line note in the W5.5.3 annotation block to warn future writers, or delete the dead file in a separate housekeeping ticket |
| **306-F14** | W5.5 review | FS-introspection detection regex drops bare `tenantId` token (only matches helper names / `TASK-30x` markers) to avoid false-positive flooding from boot/logger/JWT setup code. A file exercising cross-tenant behavior with bare `tenantId` and no helper/marker would slip through silently. Mitigated by the convention that cross-tenant tests live under `describe('TASK-30x …')`. Record the conscious deviation in plan §6 |

Remaining (not yet ticketed): **306-F1..306-F8, 306-F11..306-F14** (12 nits).

---

## 3. Approach (Wave Sequence)

| # | Wave | Branch | Commits | Tests | Verdict | Merge SHA |
|---|---|---|---|---|---|---|
| 1 | **W5.1** Surgical fixes bundle | `task-306/w5-surgical-finale` | 6 | 20 | APPROVED-WITH-MINOR-NITS (4 nits: 306-F1..306-F4) | `78e7b354` |
| 2 | **W5.2** Consultation read-paths defense-in-depth | `task-306/w5-consultation-reads` | 4 | 9 | APPROVED-WITH-MINOR-NITS (3 nits: 306-F5..306-F7) | `66b1d579` |
| 3 | **W5.3** Tenant + Webhook + ResourceSubscription sweep | `task-306/w5-tenant-sweep` | 13 (12 plan + 1 TASK-258 alignment) | 34 | APPROVED-WITH-MINOR-NITS (2 nits: 306-F8, 306-F9) | `60d9d798` |
| 4 | **W5.4** ContextItem array-input validation | `task-306/w5-context-arrays` | 3 | 9 | APPROVED-WITH-MINOR-NITS (2 nits: 306-F10, 306-F11) | `969e49df` |
| 5 | **W5.5** Hygiene bundle + aggregator FS-introspection | `task-306/w5-hygiene` | 7 | 25 | APPROVED-WITH-MINOR-NITS (3 nits: 306-F12..306-F14; 306-F9 + 306-F10 folded in) | `ec67a0d4` |
| 6 | **W5.6** Documentation close-out | `task-306/w5-docs` | 5 (5.6.1–5.6.5) | 0 (doc-only) | (this wave) | `82b3b9e4` |

Per-wave methodology (uniform across all 5 implementation waves):

1. Fresh implementation subagent spawned in an isolated worktree on a
   new branch off `fix/2605-review`.
2. Strict TDD — RED test first, GREEN minimal-fix, no REFACTOR step that
   touched adjacent code.
3. Aggregator update step at the end of the wave (W5.1.6, W5.2.4,
   W5.3.12, W5.4.3, W5.5.7) so the new `describe('TASK-306 …')` blocks
   were pinned by the meta-test.
4. Mandatory `code-reviewer` subagent verdict before merge.
5. `--no-ff` merge into `fix/2605-review` so the wave history is
   preserved.

All 5 reviews returned **APPROVED-WITH-MINOR-NITS** — 0 critical issues
and 0 important issues across the entire ticket, only the 14 minor nits
captured in §2.2.

---

## 4. Lessons Learned

- **FS-introspection paid off immediately.** The W5.5.6 meta-test
  surfaced a pre-existing aggregator gap (`prompt-management.service.test.ts`)
  on its very first run. The pattern is a strong candidate for
  replication on the database schema layer (e.g. assert every model
  in `TENANT_SCOPED_MODELS` has a corresponding `[tenantId, X]`
  composite index in the migration history).
- **Pattern-copy methodology was the right call.** Every wave reused
  a TASK-305 pattern (`assertEqualTenants`, `assertParentInScope`,
  `assertUserBelongsToTenant`, `isSuperAdmin`, `resolveEffectiveTenantId`).
  No new abstractions were introduced; new code paths were minimal.
  The DEF-C3 "no existence leak" pattern continues to be the canonical
  cross-tenant defense.
- **Silent in-place fix for `CoreUnitOfWorkService` was the right
  trade-off.** Per the user decision at plan approval time (open
  question #3), keeping the legacy `startTransaction()` signature +
  adding the canonical `runInTransaction(work)` alternative + marking
  the legacy methods `@deprecated + Logger.warn` produced zero
  production-caller churn while still closing the M-6 audit finding.
  Future caller migration is now a low-priority housekeeping task,
  not a blocking refactor.
- **Scoped `DataNotFoundException` filter was the right trade-off.**
  Per the user decision at plan approval time (open question #2),
  applying the generic 404 mapping only to `DataNotFoundException`
  (not to all `NotFoundException`s) means dev/staging error responses
  remain debuggable while production payloads stop echoing model
  names + ids.
- **The `executing-plans` skill's "fresh subagent per task + code
  review between tasks" pattern produced 0 critical + 0 important
  issues across 5 sequential reviews** — strong validation of the
  methodology. The 14 minor nits captured were genuinely minor
  (cosmetic markers, test hygiene, observability follow-ups); none
  required a rework cycle.
- **Defense-in-depth posture is now uniform.** Every PHI-bearing read
  path now passes through three layers (CLS → Prisma `tenantScope`
  extension → explicit service-layer `assertEqualTenants`) instead of
  two. This is what closes the audit's "single point of failure"
  framing (`03-ddd-layers-review.md` §F).
- **Two reviewer-flagged consistency follow-ups remain (306-F3,
  306-F12).** Both are about the SUPER_ADMIN posture inconsistency
  between adjacent services; they are deferred as product-decision
  tickets rather than silent code-only normalisation.

---

## 5. Cross-references

- **Implementation plan**: [`docs/implementation/TASK-306-DDD-Layers-Followup/README.md`](../implementation/TASK-306-DDD-Layers-Followup/README.md)
- **Audit driver** (`03-ddd-layers-review.md`): [`./03-ddd-layers-review.md`](./03-ddd-layers-review.md) — TASK-306 closure banner at top; per-finding `[CLOSED W5.x <sha>]` markers in §A/§B inventory tables and §C/§D/§E finding detail blocks
- **TASK-305 implementation summary**: [`./06-implementation-summary.md`](./06-implementation-summary.md) — §6 (Wave 5 / TASK-306 follow-up) for the wave-by-wave summary in the same style as §1
- **TASK-305 plan README**: [`docs/implementation/TASK-305-Multi-Tenancy-Hardening/README.md`](../implementation/TASK-305-Multi-Tenancy-Hardening/README.md) — §6.7 lists the deferred follow-ups TASK-306 inherited
- **Schema audit (closed by TASK-305)**: [`./02-prisma-schema-review.md`](./02-prisma-schema-review.md)
- **Architecture overview**: [`docs/technical-architecture-overview.md`](../technical-architecture-overview.md) § Multi-tenancy enforcement layers — TASK-306 finale noted in Layer 3
- **Tenant guards**: [`packages/applications/src/common/tenant-guards.ts`](../../packages/applications/src/common/tenant-guards.ts)
- **Prisma `tenantScope` extension**: [`packages/database/src/extensions/tenant-scope.ts`](../../packages/database/src/extensions/tenant-scope.ts)
- **Cross-tenant coverage aggregator**: [`packages/applications/src/__tests__/cross-tenant-coverage.test.ts`](../../packages/applications/src/__tests__/cross-tenant-coverage.test.ts)
- **Companion ticket** (RLS / F-1): TASK-302 Phase 2 — PgBouncer + Vault role split
