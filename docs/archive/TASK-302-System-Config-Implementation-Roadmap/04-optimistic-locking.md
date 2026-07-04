# Plan: TASK-302 Stream D — Optimistic Locking on Config Writes

**Required Skill**: `executing-plans`

| Field | Value |
|---|---|
| **Parent ticket** | TASK-302 (System Configuration Implementation Roadmap) |
| **Parent assessment** | TASK-301 §P2 "missing optimistic locking on config writes" |
| **Stream** | D — Optimistic Locking |
| **Source research** | [`research/architecture/system-config-multi-tenancy/04-optimistic-locking.md`](../../../research/architecture/system-config-multi-tenancy/04-optimistic-locking.md) |
| **Status** | Ready for execution |
| **Created** | 2026-05-24 |
| **Estimated effort** | ~13.5 engineer-days (≈ 2–3 calendar weeks with 2 engineers in parallel) |
| **Target Prisma version** | 7.x on PostgreSQL ≥ 17 |

> **TL;DR.** Every Prisma model in `packages/database/src/prisma/db_main/` already carries `version Int @default(1) @map("_version")`, but the runtime never reads or increments it. Two SUPER_ADMINs editing `smr-provider-models` at the same time silently overwrite each other — the textbook "lost update" anomaly (Berenson et al., 1995). This plan wires the existing column to a Compare-And-Set (CAS) `updateMany` write path, surfaces conflicts via RFC 7232 `ETag` / `If-Match` on the public API, and rolls out opt-in to every admin-edited entity. Five reversible phases; no DB migration required.

---

## Goal

Make every admin-edited Prisma write reject silently-overwriting concurrent edits by wiring the existing `_version` column into a CAS `updateMany` path, an RFC 7232 `ETag` / `If-Match` HTTP contract, and an `OptimisticConcurrencyException` → HTTP 412 response — starting with `TenantService.updateTenantConfigs` (highest contention surface) and rolling out to five additional models.

## Architecture Overview

Three layers, each additive on top of the previous:

1. **Repository CAS** — a new `Repository<T>.updateWithVersion(id, changes, expectedVersion)` issues `prisma.<model>.updateMany({ where: { id, version: expectedVersion }, data: { ...changes, version: { increment: 1 } } })`; `count === 0` triggers a freshly-fetched existence check that disambiguates `DataNotFoundException` from `OptimisticConcurrencyException`.
2. **HTTP wire format** — `ETagInterceptor` decorates every response whose body carries `.version` with `ETag: "<n>"`; `@RequiresIfMatch()` on a route plus `@ExpectedVersion()` on a handler parameter parse the inbound `If-Match` header (or return `428 Precondition Required` when missing). On version drift the exception filter renders `412 Precondition Failed` with `{ currentVersion, yourVersion }`.
3. **SDK + UI** — `@arcaai/vox` captures `ETag` on `GET` and replays as `If-Match` on `PATCH`; surfaces the 412 as a typed `ConfigConflictError` so the admin UI can render a conflict modal instead of silently re-submitting.

## Tech Stack

- **NestJS 11**, TypeScript 5 (`apps/api`)
- **Prisma 7** on PostgreSQL ≥ 17 (`packages/database`, `packages/domains`)
- **Vitest** (unit), **Playwright** (E2E)
- **@arcaai/vox** SDK (`packages/agentic-sdk-v2`)
- **Turborepo + pnpm**

## Decision Log

| # | Decision | Rationale | Source |
|---|---|---|---|
| 1 | Optimistic (CAS) over pessimistic (`SELECT … FOR UPDATE`) | HOPE pods talk to PostgreSQL through a transaction-mode pooler; row locks would hold across hundreds-of-ms admin-UI round-trips, starving the pool. Optimistic is read-lock-free. | Research §2 |
| 2 | `updateMany` over `update` | `update` throws `P2025` on missing rows and cannot distinguish "row gone" from "version drifted". `updateMany` returns `{ count }` — exactly the CAS primitive we need. | Research §3 |
| 3 | PostgreSQL only, with a permanent regression test | Prisma issues [#10207](https://github.com/prisma/prisma/issues/10207) and [#28840](https://github.com/prisma/prisma/issues/28840) document that on **MySQL** Prisma rewrites `updateMany` as `SELECT pk … ; UPDATE … WHERE pk IN (…)`, dropping non-pk predicates and defeating OCC. PostgreSQL emits predicates verbatim. We pin a Postgres-only Vitest regression test so a future DB migration cannot silently break the pattern. | Research §3 |
| 4 | `version` is database-owned (no public setter; `applyChangesToEntity` filters it; mapper round-trips on read only) | Removes the entire class of "looks like OCC, actually broken" failures by making `updateWithVersion` the sole legitimate writer of the column. | Research §5 |
| 5 | Bulk writes (`updateTenantConfigs`) are all-or-nothing inside a `$transaction` | Partial success on a multi-row PATCH leaves a tenant in a half-applied state — a SOC2 finding waiting to happen. Either the whole batch lands at `version + 1` or nothing changes. | Research §7 |
| 6 | Soft-delete must bump `_version` | `softDelete` mutates `resourceStatus` — a real state change. Without bumping, an admin who read at v7 can `updateWithVersion(…, 7)` after another admin soft-deleted, succeed, and resurrect a deleted row. | Research §7 |
| 7 | Human writes never auto-retry; machine writes may retry with `pRetry({ retries: 3 })` after re-fetch + re-apply | A 412 is meaningful information for a user — they want to see the diff before re-submitting. Auto-retry on human edits is a footgun. | Research §3 |
| 8 | Strong ETag (`"<integer>"`, no `W/` prefix); do not hash the body | RFC 7232 §2.3.2 requires strong comparison for `If-Match`; the monotonic integer is the simplest strong validator and lets byte-identical re-saves fail correctly when the version drifted. | Research §4 |
| 9 | Missing `If-Match` on a `@RequiresIfMatch()` route returns `428 Precondition Required` (RFC 6585), not `400 Bad Request` | The semantic that Google Cloud Healthcare API and Ed-Fi adopt; lets clients distinguish "you forgot the header" from "you sent a bad value". | Research §4 |
| 10 | `SysEvent.ResourceUpdated` payload includes `previousVersion` and `newVersion` for audit-log correlation | Investigators can `SELECT … WHERE metadata->>'newVersion' = ?` to reconstruct history without re-deriving from timestamps. Closes the audit-log gaslighting risk (Research §1 scenario 3). | Research §7 |
| 11 | No data migration | Every existing row has `version = 1` from the Prisma default. The column was added at schema-creation time. Zero back-fill, zero migration SQL. | Research §7 |

## Risks & Mitigations

| Risk | Probability | Blast radius | Mitigation |
|---|---|---|---|
| Prisma rewrites `updateMany` to drop the `version` predicate on a future DB driver migration | Low (Postgres-only today) | All OCC silently breaks, lost-write reappears | **Task B.4** — permanent Vitest regression test running real Postgres + counting executed SQL to assert the predicate is preserved. CI fails fast. |
| `version` gets written by accident through change tracking (e.g. someone calls `entity['version'] = 5`) | Medium until rollout finishes | Tenant could pin its own version arbitrarily, bypassing CAS | Defense in depth: (a) no public setter on `BaseEntity` (B.5), (b) `applyChangesToEntity` skips the key (B.7), (c) mapper `$toPersistence` excludes it (B.6), (d) entity unit test asserts `version` is read-only (B.5). |
| Bulk PATCH with one stale row partially applies the others (Research §7) | Medium | Tenant left in half-applied state; SOC2 / HIPAA integrity finding | `$transaction` wrapper in `updateTenantConfigs` (C.4). All CAS writes happen inside one transaction; any `count === 0` rolls the whole batch back. |
| Soft-delete races a concurrent update and resurrects a deleted row | Low–Medium | Compliance: deleted PHI re-appears | Soft-delete bumps `version` (B.8). Subsequent CAS with the pre-deletion version fails. |
| 412 noise drowns out real conflicts (chatty UI, bug in SDK ETag capture) | Medium during D rollout | Operators stop trusting 412 as signal | `optimistic_lock_conflict_total{model, route}` Prometheus counter with a Grafana panel; alert threshold > 0.5 % of PATCHes (Research §6 Phase E). |
| SDK ships before the API supports `If-Match` (or vice versa) — UI breaks | High during D rollout | Admin UI 4xx on every save | **Sequencing rule** (see Cross-stream Dependencies): API ships Phase D first; SDK ships next; UI consumes only after both are live. The decorator default tolerates missing `If-Match` until the route is annotated `@RequiresIfMatch()`. |
| Replica lag → admin reads stale `version`, every save is 412 | Low (we don't route admin reads to replicas today) | Admin UX broken at the worst possible time | Pin admin reads to primary. Documented in §B.1 Concurrency Model README (Phase E.7). |
| `_version` overflow at Int32 max | Negligible (~2.1B updates per row) | None for centuries | None. Noted for completeness. |

## Team Allocation

| Phase | Lead | Reviewer | Parallelisable with |
|---|---|---|---|
| A — Audit | `tester` | `code-reviewer` | Anything; touches no production code |
| B — Infrastructure | `database-admin` | `code-reviewer` + `debugger` | Independent of Streams B (Vault) / C (PgBouncer) |
| C — Opt-in services | `database-admin` + `tester` | `code-reviewer` | After B; coordinates with Stream B Phase 4 (see Cross-stream) |
| D.1–D.3 (API) | `api-designer` | `code-reviewer` | After B (the exception type) |
| D.4 (SDK) | `api-designer` | `code-reviewer` | After D.1–D.3 (the HTTP contract) |
| D.5 (UI stub) | `ui-ux-designer` (informational only; main UI work belongs to a future ticket) | `code-reviewer` | After D.4 |
| E — Roll out | 1 engineer per model (parallelisable) | `code-reviewer` | After D for any model whose UI needs the ETag contract; B–C suffices for service-to-service-only models |
| Final sign-off | `code-reviewer` + `tester` | — | — |
| Branch coordination | `git-manager` | — | All phases |

## Effort Estimate

| Phase | Engineer-days | Calendar weeks (1 eng) | Calendar weeks (2 eng parallel) |
|---|---|---|---|
| A — Audit / evidence test | 0.5 | < 1 | < 1 |
| B — `OptimisticConcurrencyException` + `updateWithVersion` + entity getter + mapper + softDelete bump | 2 | < 1 | < 1 |
| C — `TenantService` + `GlobalSettingService` migration + e2e | 3 | 1 | 0.5 |
| D — `ETagInterceptor` + decorators + SDK + UI stub | 3 | 1 | 0.5–1 |
| E — Roll out to 5 more services + docs + observability | 5 | 1–2 | 0.5–1 |
| **Total** | **~13.5 days** | **3–4 weeks elapsed** | **2–3 weeks elapsed** |

> **MVP cut.** A + B + C is a usable 5.5 days of work that closes the lost-write hole on tenant config without touching the wire format. D and E may land later; the only contract the SDK sees in this slice is a new body field, not a new header.

## Cross-stream Dependencies

| Stream / Phase | Relationship | Sequencing rule |
|---|---|---|
| **TASK-302 Phase 0, Item 1** (strict `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`) | **Hard dependency** for Phase C | Phase C's `UpdateTenantConfigRequest` adds `expectedVersion: number`. Without the strict pipe, attackers can still mass-assign other fields; the OCC adds no value when integrity is already breached. Do not start C.1 until Phase 0 item 1 is in main. |
| **TASK-302 Phase 0, Item 2** (allowlist in `updateTenantConfigs`) | **Hard dependency** for Phase C | C.3 extends the allowlist with `expectedVersion`. The allowlist must already exist; otherwise Phase C re-introduces the mass-assignment exposure that Phase 0 closed. |
| **Stream B — Vault Migration** (`02-vault-migration.md`) | **Independent**, but **coordinated** at the schema window | Stream B Phase 4 adds `encryptedValue`, `keyVersion` columns to `GlobalSetting`. This stream touches the same row's `version` column. Recommend ordering: **Stream B Phase 4 schema migration lands first** (it's purely additive); **Stream D Phase C then references the new column shape** only in its mapper. If both migrations land in the same release window, the one-PR-per-schema-migration rule from `02-database-prisma.mdc` still holds — coordinate via `git-manager`. |
| **Stream C — PgBouncer Rollout** (`03-pgbouncer-prisma.md`) | **Independent** | OCC works under transaction-mode pooling (the current default) and under session-mode (the rollout target). No coordination needed. |
| **Stream D Phase D ↔ SDK release ↔ UI release** | **Strict sequencing** | The new HTTP contract (`ETag` / `If-Match` / `412` / `428`) **must** ship in this order: (1) API Phase D in production, with `@RequiresIfMatch()` off by default and on for `PATCH /tenants/me/config` + `PATCH /global-settings/:id`; (2) SDK release containing the `If-Match` capture/replay; (3) UI release wiring the conflict modal. If the UI ships before the SDK, every PATCH becomes a 428. **Call this out in the release notes for every Phase D PR.** |
| **TASK-301 §B.7 — `GlobalSettingHistory` table** | **Future / optional** | The conflict modal "user X changed value from Y to Z" is the long-term UX. The history table is **out of scope** for this stream. Phase D.5 ships a stub modal that says "Refresh to see the latest value" if no history is available — gracefully degrades when TASK-3XX-Global-Setting-History eventually lands. |

---

## Phase A — Evidence test (~0.5 day)

**Goal.** Document today's lost-write behavior with a regression test that's intentionally skipped (so CI stays green) but acts as canonical proof that the bug exists. No production code changes.

### Task A.1 — Reproduce silent overwrite against the `__GLOBAL__` tenant

**Agent**: `tester`

**Files**:
- Create: `packages/applications/src/services/tenant/__tests__/optimisticLockingEvidence.test.ts`

**Steps**:

1. Write a Vitest integration test that wires the real `TenantService` against the test database (Vitest spins up a transactional helper that wraps each test in `BEGIN … ROLLBACK`). The test reads a `GlobalSetting` row twice (two "tabs"), each modifies the value, each calls `updateTenantConfigs` sequentially; the assertion is that the **second write wins and the first writer's value is silently gone** with no exception thrown and no audit-log entry distinguishing the two.

   ```typescript
   // packages/applications/src/services/tenant/__tests__/optimisticLockingEvidence.test.ts
   import { describe, it, expect, beforeEach } from 'vitest';
   import { TenantService } from '../tenant.service';
   import {
     buildTenantServiceTestHarness,
     seedGlobalSetting,
     type TenantServiceTestHarness,
   } from './_harness';

   describe('Evidence — lost write on GlobalSetting (TASK-301 §P2 / TASK-302 Stream D)', () => {
     let harness: TenantServiceTestHarness;

     beforeEach(async () => {
       harness = await buildTenantServiceTestHarness();
     });

     // SKIPPED ON PURPOSE — documents today's broken behaviour. Phase C will
     // delete this `.skip` and assert the inverse (one write wins, the other
     // throws `OptimisticConcurrencyException`).
     it.skip('two concurrent updateTenantConfigs calls silently overwrite each other', async () => {
       const tenantId = harness.tenantId;
       const setting = await seedGlobalSetting(harness, {
         tenantId,
         key: 'smr-provider-models',
         value: 'v0',
       });

       // Two "tabs" read the same row.
       const tabA = await harness.tenantService.fetchTenantConfigs({
         tenantId, limit: 200, page: 1,
       });
       const tabB = await harness.tenantService.fetchTenantConfigs({
         tenantId, limit: 200, page: 1,
       });

       const fromA = tabA.data.find((c) => c.id === setting.id)!;
       const fromB = tabB.data.find((c) => c.id === setting.id)!;
       expect(fromA.value).toBe('v0');
       expect(fromB.value).toBe('v0');

       // Tab A saves first.
       await harness.tenantService.updateTenantConfigs(tenantId, [
         { id: fromA.id, value: 'A-wrote-this' } as any,
       ]);

       // Tab B saves second, carrying A's stale value in the rest of the row.
       await harness.tenantService.updateTenantConfigs(tenantId, [
         { id: fromB.id, value: 'B-wrote-this' } as any,
       ]);

       const finalRow = await harness.globalSettingRepository.findById(setting.id);
       // EXPECTED (broken today): B wins, A's write is silently lost.
       expect(finalRow.value).toBe('B-wrote-this');

       // EXPECTED (broken today): no exception thrown anywhere above.
       // After Phase C this same harness must throw on the second call.
     });
   });
   ```

2. Verify the test would fail today if un-skipped (run manually once during authoring):

   ```bash
   pnpm test:unit --filter @arcaai/applications -- optimisticLockingEvidence
   # Expected output (with .skip removed locally for verification):
   #   ✓ two concurrent updateTenantConfigs calls silently overwrite each other (12ms)
   # Re-add `.skip` before committing.
   ```

3. Confirm CI is green with the `.skip` in place:

   ```bash
   pnpm test:unit --filter @arcaai/applications -- optimisticLockingEvidence
   # Expected output:
   #   ↓ two concurrent updateTenantConfigs calls silently overwrite each other (skipped)
   #   Test Files  1 skipped (1)
   #   Tests       1 skipped (1)
   ```

### Task A.2 — Commit the evidence test as canonical documentation

**Agent**: `git-manager`

**Files**: None beyond A.1.

**Steps**:

1. Stage A.1's file.

   ```bash
   git add packages/applications/src/services/tenant/__tests__/optimisticLockingEvidence.test.ts
   ```

2. Commit with a message that ties to both the audit and the upcoming work:

   ```bash
   git commit -m "$(cat <<'EOF'
   test(applications): document lost-write on GlobalSetting (TASK-302 Stream D Phase A)

   Adds a skipped Vitest regression that, when un-skipped, demonstrates the
   silent overwrite documented in TASK-301 §P2. Phase C of TASK-302 Stream D
   will delete the `.skip` and assert the inverse (412 on version drift).
   EOF
   )"
   ```

### Code Review Gate A

**Agent**: `code-reviewer`

- Verify the test is genuinely demonstrative (would fail without OCC) by un-skipping locally and running once.
- Verify it's re-skipped in the committed version.
- Verify the harness uses real Postgres (not a mocked Prisma client) so it would catch the Prisma #10207-class regressions.
- Confirm no production source file was modified in Phase A.

---

## Phase B — Infrastructure (additive only) (~2 days)

**Goal.** Add the exception, the repository method, the entity getter, the mapper round-trip, the change-tracking filter, and the soft-delete `version` bump. **No service or controller changes.** Every existing test must stay green.

### Task B.1 — Add `OptimisticConcurrencyException` to `@arcaai/exceptions`

**Agent**: `database-admin`

**Files**:
- Create: `packages/exceptions/src/backend/persistence/optimisticConcurrency.exception.ts`
- Modify: `packages/exceptions/src/common/exception.codes.ts`
- Modify: `packages/exceptions/src/backend/persistence/index.ts`
- Create: `packages/exceptions/src/backend/persistence/__tests__/optimisticConcurrency.exception.test.ts`

**Steps**:

1. Write the failing test.

   ```typescript
   // packages/exceptions/src/backend/persistence/__tests__/optimisticConcurrency.exception.test.ts
   import { describe, it, expect } from 'vitest';
   import { OptimisticConcurrencyException } from '../optimisticConcurrency.exception';

   describe('OptimisticConcurrencyException', () => {
     it('carries entity name, id, expected and current version', () => {
       const exc = new OptimisticConcurrencyException('GlobalSetting', 'gs-1', {
         expectedVersion: 7,
         currentVersion: 8,
       });

       expect(exc.code).toBe('PERSISTENCE.CONCURRENCY_CONFLICT');
       expect(exc.message).toContain('GlobalSetting');
       expect(exc.message).toContain('gs-1');
       expect(exc.metadata).toEqual({ expectedVersion: 7, currentVersion: 8 });
     });

     it('serialises to JSON with the version metadata preserved', () => {
       const exc = new OptimisticConcurrencyException('Tenant', 't-1', {
         expectedVersion: 1,
         currentVersion: 2,
       });
       const json = exc.toJSON();
       expect(json.code).toBe('PERSISTENCE.CONCURRENCY_CONFLICT');
       expect(json.metadata).toEqual({ expectedVersion: 1, currentVersion: 2 });
     });
   });
   ```

2. Verify the test fails.

   ```bash
   pnpm test:unit --filter @arcaai/exceptions -- optimisticConcurrency
   # Expected output:
   #   Error: Cannot find module '../optimisticConcurrency.exception'
   #   Test Files  1 failed (1)
   ```

3. Implement.

   ```typescript
   // packages/exceptions/src/common/exception.codes.ts (append)
   export const CONCURRENCY_CONFLICT = 'PERSISTENCE.CONCURRENCY_CONFLICT';
   ```

   ```typescript
   // packages/exceptions/src/backend/persistence/optimisticConcurrency.exception.ts
   import { CONCURRENCY_CONFLICT, BasePersistenceException } from '../../common';

   export interface OptimisticConcurrencyMetadata {
     expectedVersion: number;
     currentVersion: number;
   }

   /**
    * Thrown when a Compare-And-Set (CAS) write fails because the entity's
    * `_version` column advanced between the caller's read and the caller's
    * write. The HTTP layer maps this to `412 Precondition Failed`.
    *
    * @class OptimisticConcurrencyException
    * @extends {BasePersistenceException}
    */
   export class OptimisticConcurrencyException extends BasePersistenceException {
     static readonly code = CONCURRENCY_CONFLICT;

     constructor(
       entity: string,
       entityId: string,
       metadata: OptimisticConcurrencyMetadata,
       cause?: Error,
     ) {
       super(
         `[DB] ${entity} with ID ${entityId} was modified concurrently ` +
           `(expectedVersion=${metadata.expectedVersion}, currentVersion=${metadata.currentVersion}).`,
         OptimisticConcurrencyException.code,
         cause,
         metadata,
       );
     }
   }
   ```

   ```typescript
   // packages/exceptions/src/backend/persistence/index.ts (append)
   export * from './optimisticConcurrency.exception';
   ```

4. Verify the test passes.

   ```bash
   pnpm test:unit --filter @arcaai/exceptions -- optimisticConcurrency
   # Expected output:
   #   ✓ carries entity name, id, expected and current version
   #   ✓ serialises to JSON with the version metadata preserved
   #   Test Files  1 passed (1)
   ```

5. Commit.

   ```bash
   git add packages/exceptions/src
   git commit -m "feat(exceptions): add OptimisticConcurrencyException (TASK-302 Stream D Phase B)"
   ```

### Task B.2 — Failing repository test for `updateWithVersion`

**Agent**: `tester`

**Files**:
- Create: `packages/domains/src/common/__tests__/updateWithVersion.test.ts`

**Steps**:

1. Write a failing test that exercises three scenarios on a fake-Prisma harness (we test the algorithm here; the real-Postgres test lands in B.4):

   ```typescript
   // packages/domains/src/common/__tests__/updateWithVersion.test.ts
   import { describe, it, expect, beforeEach, vi } from 'vitest';
   import { Repository } from '../repository';
   import { BaseEntity } from '../baseEntity/base.entity';
   import { OptimisticConcurrencyException, DataNotFoundException } from '@arcaai/exceptions';

   const buildHarness = () => {
     const db = {
       updateMany: vi.fn(),
       findUnique: vi.fn(),
     };
     const uow = { getDatabaseService: () => ({ TestModel: db }) };
     const mapper = {
       toPersistence: vi.fn(),
       toPersistenceChanges: vi.fn((e: any) => e.changes),
       toDomainEntity: vi.fn((m: any) => ({ id: m.id, version: m.version })),
     };
     class TestEntity extends BaseEntity { validate(): void {} }
     class TestRepository extends Repository<TestEntity, any> {
       constructor() { super(uow as any, 'TestModel', mapper as any); }
     }
     return { repo: new TestRepository(), db, mapper };
   };

   describe('Repository.updateWithVersion', () => {
     let harness: ReturnType<typeof buildHarness>;
     beforeEach(() => { harness = buildHarness(); });

     it('issues updateMany with the version predicate, then re-reads', async () => {
       harness.db.updateMany.mockResolvedValueOnce({ count: 1 });
       harness.db.findUnique.mockResolvedValueOnce({ id: 'e-1', version: 8 });

       await harness.repo.updateWithVersion('e-1', { value: 'new' } as any, 7);

       expect(harness.db.updateMany).toHaveBeenCalledWith({
         where: { id: 'e-1', version: 7 },
         data: { value: 'new', version: { increment: 1 } },
       });
     });

     it('throws OptimisticConcurrencyException when count === 0 and row exists', async () => {
       harness.db.updateMany.mockResolvedValueOnce({ count: 0 });
       harness.db.findUnique.mockResolvedValueOnce({ id: 'e-1', version: 9 });

       await expect(
         harness.repo.updateWithVersion('e-1', { value: 'new' } as any, 7),
       ).rejects.toBeInstanceOf(OptimisticConcurrencyException);
     });

     it('throws DataNotFoundException when count === 0 and row is gone', async () => {
       harness.db.updateMany.mockResolvedValueOnce({ count: 0 });
       harness.db.findUnique.mockResolvedValueOnce(null);

       await expect(
         harness.repo.updateWithVersion('e-1', { value: 'new' } as any, 7),
       ).rejects.toBeInstanceOf(DataNotFoundException);
     });
   });
   ```

2. Verify the test fails (the method doesn't exist yet).

   ```bash
   pnpm test:unit --filter @arcaai/domains -- updateWithVersion
   # Expected output:
   #   TypeError: harness.repo.updateWithVersion is not a function
   #   Test Files  1 failed (1)
   ```

3. (Implementation in B.3 — keep the failing test in place; do not commit yet.)

### Task B.3 — Implement `updateWithVersion` on `Repository<T>`

**Agent**: `database-admin`

**Files**:
- Modify: `packages/domains/src/common/repository.ts`

**Steps**:

1. Add the method (inserted directly below the existing `update` method at line 129 in `repository.ts`):

   ```typescript
   // packages/domains/src/common/repository.ts
   import {
     DataCreationException,
     DataNotFoundException,
     OptimisticConcurrencyException,
   } from '@arcaai/exceptions';

   // ... (existing class body unchanged) ...

   /**
    * Compare-and-set update against the `_version` column.
    *
    * Issues `prisma.<model>.updateMany({ where: { id, version: expectedVersion },
    * data: { ...changes, version: { increment: 1 } } })`. PostgreSQL emits the
    * predicate verbatim; if no row matches we disambiguate "row gone" vs
    * "version drifted" by re-reading and throwing the correct exception.
    *
    * Safe under transaction-mode pooling — no row lock is taken.
    *
    * @throws OptimisticConcurrencyException when the row exists but its
    *   version is no longer `expectedVersion`
    * @throws DataNotFoundException when the row no longer exists
    *
    * @see TASK-302 Stream D Phase B
    * @see https://github.com/prisma/prisma/issues/10207 (MySQL-only caveat)
    */
   public async updateWithVersion(
     id: EntityId,
     entity: DomainEntity,
     expectedVersion: number,
   ): Promise<DomainEntity> {
     const changes = this._mapper.toPersistenceChanges(entity);

     // `version` is database-owned. Even if a buggy caller put it in the
     // change set, we strip it here as defense in depth.
     // eslint-disable-next-line @typescript-eslint/no-unused-vars
     const { version: _v, ...safeChanges } = changes as Record<string, unknown>;

     const result = await this.db.updateMany({
       where: { id, version: expectedVersion },
       data: { ...safeChanges, version: { increment: 1 } },
     });

     if (result.count === 0) {
       const current = await this.db.findUnique({
         where: { id },
         select: { version: true },
       });
       if (!current) {
         throw new DataNotFoundException(this.db.name || Repository.name, id);
       }
       throw new OptimisticConcurrencyException(
         this._modelName,
         id,
         { expectedVersion, currentVersion: current.version },
       );
     }

     return this.findById(id);
   }
   ```

2. Verify the unit test from B.2 now passes.

   ```bash
   pnpm test:unit --filter @arcaai/domains -- updateWithVersion
   # Expected output:
   #   ✓ issues updateMany with the version predicate, then re-reads
   #   ✓ throws OptimisticConcurrencyException when count === 0 and row exists
   #   ✓ throws DataNotFoundException when count === 0 and row is gone
   #   Test Files  1 passed (1)
   #   Tests       3 passed (3)
   ```

3. Verify the rest of the domains package still builds and tests pass.

   ```bash
   pnpm build --filter @arcaai/domains
   pnpm test:unit --filter @arcaai/domains
   # Expected: 0 failures, all existing tests green.
   ```

4. Commit.

   ```bash
   git add packages/domains/src/common/repository.ts packages/domains/src/common/__tests__/updateWithVersion.test.ts
   git commit -m "feat(domains): add Repository.updateWithVersion CAS path (TASK-302 Stream D Phase B)"
   ```

### Task B.4 — Real-Postgres regression test for Prisma `updateMany` predicate preservation

**Agent**: `debugger`

**Files**:
- Create: `packages/domains/src/common/__tests__/updateWithVersion.postgres.test.ts`

**Steps**:

1. Write a Vitest test that runs against the real PostgreSQL test database (the same harness `packages/database` already uses for migrations). The test creates two transactions, both reading `version = N`, both running `updateMany` with the predicate; asserts exactly one returns `count === 1` and the other `count === 0`. This is the permanent guard against Prisma #10207 / #28840.

   ```typescript
   // packages/domains/src/common/__tests__/updateWithVersion.postgres.test.ts
   import { describe, it, expect, beforeAll, afterAll } from 'vitest';
   import { getPrismaClient } from '@arcaai/database';

   const SKIP_REASON = 'Requires DATABASE_URL pointing at a real Postgres';
   const enabled = !!process.env.DATABASE_URL;

   describe.skipIf(!enabled)('updateMany CAS — Postgres regression guard (Prisma #10207)', () => {
     const prisma = getPrismaClient();

     it('emits the version predicate verbatim and only one of two racing writers wins', async () => {
       // Seed a row at version=1
       const row = await prisma.globalSetting.create({
         data: {
           name: 'Test setting',
           key: `task-302-cas-test-${Date.now()}`,
           value: 'v0',
           tenantId: '50000000-0000-0000-0000-000000000000',
         },
       });

       try {
         const [a, b] = await Promise.all([
           prisma.globalSetting.updateMany({
             where: { id: row.id, version: 1 },
             data: { value: 'A', version: { increment: 1 } },
           }),
           prisma.globalSetting.updateMany({
             where: { id: row.id, version: 1 },
             data: { value: 'B', version: { increment: 1 } },
           }),
         ]);

         // Exactly one writer should have matched; the other got 0.
         expect(a.count + b.count).toBe(1);
         expect(Math.min(a.count, b.count)).toBe(0);
         expect(Math.max(a.count, b.count)).toBe(1);

         const finalRow = await prisma.globalSetting.findUnique({ where: { id: row.id } });
         expect(finalRow!.version).toBe(2);
       } finally {
         await prisma.globalSetting.delete({ where: { id: row.id } });
       }
     });

     it('captures the executed SQL and asserts the predicate contains "_version"', async () => {
       // Use Prisma $on('query') so we observe the generated SQL.
       const captured: string[] = [];
       prisma.$on('query', (e) => captured.push(e.query));

       const row = await prisma.globalSetting.create({
         data: {
           name: 'Test setting 2',
           key: `task-302-cas-sql-${Date.now()}`,
           value: 'v0',
           tenantId: '50000000-0000-0000-0000-000000000000',
         },
       });

       try {
         await prisma.globalSetting.updateMany({
           where: { id: row.id, version: 1 },
           data: { value: 'X', version: { increment: 1 } },
         });

         const updateSql = captured.find((q) => q.toLowerCase().startsWith('update'));
         expect(updateSql, 'no UPDATE statement captured').toBeTruthy();
         // The predicate name in Postgres is `_version` (Prisma's `@map`). If
         // Prisma ever rewrites this away (Postgres #10207-equivalent) this
         // assertion fails immediately.
         expect(updateSql).toMatch(/"_version"\s*=/i);
       } finally {
         await prisma.globalSetting.delete({ where: { id: row.id } });
       }
     });
   });
   ```

2. Run against the test DB; verify both tests pass.

   ```bash
   DATABASE_URL=$TEST_DATABASE_URL pnpm test:unit --filter @arcaai/domains -- updateWithVersion.postgres
   # Expected output:
   #   ✓ emits the version predicate verbatim and only one of two racing writers wins
   #   ✓ captures the executed SQL and asserts the predicate contains "_version"
   #   Test Files  1 passed (1)
   #   Tests       2 passed (2)
   ```

3. Run *without* `DATABASE_URL` to confirm the suite skips gracefully (so unit CI without a DB doesn't fail).

   ```bash
   unset DATABASE_URL
   pnpm test:unit --filter @arcaai/domains -- updateWithVersion.postgres
   # Expected:
   #   Test Files  1 skipped (1)
   ```

4. Commit.

   ```bash
   git add packages/domains/src/common/__tests__/updateWithVersion.postgres.test.ts
   git commit -m "test(domains): Postgres regression guard for updateMany CAS (TASK-302 Stream D Phase B)"
   ```

### Task B.5 — Expose `version` getter on `BaseEntity` (read-only)

**Agent**: `database-admin`

**Files**:
- Modify: `packages/domains/src/common/baseEntity/base.entity.ts`
- Modify: `packages/domains/src/common/baseEntity/__tests__/base.entity.test.ts`

**Steps**:

1. Write the failing test.

   ```typescript
   // packages/domains/src/common/baseEntity/__tests__/base.entity.test.ts (append)
   describe('version (TASK-302 Stream D Phase B)', () => {
     class V extends BaseEntity { validate(): void {} }

     it('defaults to 1 when not provided in init', () => {
       const e = new V({
         id: 'x', createdBy: null, updatedBy: null,
         createdAt: new Date(), updatedAt: new Date(),
       });
       expect(e.version).toBe(1);
     });

     it('reads the version supplied in init', () => {
       const e = new V({
         id: 'x', createdBy: null, updatedBy: null,
         createdAt: new Date(), updatedAt: new Date(),
         version: 7,
       });
       expect(e.version).toBe(7);
     });

     it('does not expose a public setter (DB-owned)', () => {
       const e = new V({
         id: 'x', createdBy: null, updatedBy: null,
         createdAt: new Date(), updatedAt: new Date(),
       });
       const descriptor = Object.getOwnPropertyDescriptor(
         Object.getPrototypeOf(e),
         'version',
       );
       expect(descriptor?.set).toBeUndefined();
     });

     it('version is not tracked in entity.changes', () => {
       const e = new V({
         id: 'x', createdBy: null, updatedBy: null,
         createdAt: new Date(), updatedAt: new Date(),
       });
       // even if a buggy caller force-pokes the internal:
       (e as any)._version = 99;
       expect(e.hasChanges).toBe(false);
     });
   });
   ```

2. Verify it fails.

   ```bash
   pnpm test:unit --filter @arcaai/domains -- base.entity
   # Expected: 4 failing (version getter missing)
   ```

3. Implement — modify `packages/domains/src/common/baseEntity/base.entity.ts`:

   ```typescript
   // packages/domains/src/common/baseEntity/base.entity.ts (additions only)

   // 1. Add the private field beside the others (around line 41):
   private _version: number;

   // 2. Read it in the constructor (after _resourceStatusUpdatedBy assignment, around line 51):
   this._version = init.version ?? 1;

   // 3. Add the getter (after the `updatedAt` getter, ~line 77). NOTE: NO SETTER.
   /**
    * Monotonic version for optimistic concurrency control. Mapped to the
    * `_version` column on every Prisma model. Database-owned — the only
    * legitimate writer is `Repository<T>.updateWithVersion`. Exposed read-only
    * so services / mappers can round-trip it.
    *
    * @see TASK-302 Stream D Phase B
    */
   get version(): number {
     return this._version;
   }
   ```

4. Verify the new tests pass and existing tests don't regress.

   ```bash
   pnpm test:unit --filter @arcaai/domains -- base.entity
   # Expected: 4 new tests passing; all pre-existing tests still passing.
   pnpm build --filter @arcaai/domains
   # Expected: 0 type errors. The IBaseEntity interface already declares `version?: number`.
   ```

5. Commit.

   ```bash
   git add packages/domains/src/common/baseEntity
   git commit -m "feat(domains): expose read-only version getter on BaseEntity (TASK-302 Stream D Phase B)"
   ```

### Task B.6 — Auto-mapper round-trips `version` on read; never on write

**Agent**: `database-admin`

**Files**:
- Modify: `packages/domains/src/mappers/generated/core/GlobalSettingEntityMapper.ts`
- Create: `packages/domains/src/mappers/generated/core/__tests__/GlobalSettingEntityMapper.test.ts`

**Steps**:

1. Write the failing test that asserts the `$toDomain` direction includes `version` and the `$toPersistence` direction excludes it. This is the centralised proof that the auto-mapper round-trips on read only.

   ```typescript
   // packages/domains/src/mappers/generated/core/__tests__/GlobalSettingEntityMapper.test.ts
   import { describe, it, expect } from 'vitest';
   import { GlobalSettingEntityMapper } from '../GlobalSettingEntityMapper';
   import { GlobalSetting as GlobalSettingModel } from '../../../models/generated/core/GlobalSettingModel';
   import { ValueType } from '../../../enums';

   describe('GlobalSettingEntityMapper — version round-trip (TASK-302 Stream D Phase B)', () => {
     const mapper = new GlobalSettingEntityMapper();

     const sampleRow = (overrides: Partial<GlobalSettingModel> = {}): GlobalSettingModel =>
       ({
         id: 'gs-1',
         tenantId: 't-1',
         name: 'n',
         key: 'k',
         value: 'v',
         defaultValue: null,
         description: null,
         namespace: null,
         dataType: ValueType.String,
         locked: false,
         resourceStatus: 'ENABLED' as any,
         resourceStatusUpdatedAt: null,
         resourceStatusUpdatedBy: null,
         createdBy: null,
         updatedBy: null,
         createdAt: new Date(),
         updatedAt: new Date(),
         tags: [],
         version: 7,
         metaData: null,
         ...overrides,
       }) as GlobalSettingModel;

     it('toDomainEntity carries `version` from the database row', () => {
       const entity = mapper.toDomainEntity(sampleRow());
       expect(entity.version).toBe(7);
     });

     it('toPersistenceChanges never contains `version`, even if the change set has it', () => {
       const entity = mapper.toDomainEntity(sampleRow());
       // simulate a buggy caller poking the internal change set
       (entity as any)._changes = { value: 'v2', version: 99 };
       const persisted = mapper.toPersistenceChanges(entity);
       expect(persisted).toEqual({ value: 'v2' });
       expect(persisted).not.toHaveProperty('version');
     });

     it('toPersistence (full insert path) does not write `version`', () => {
       const entity = mapper.toDomainEntity(sampleRow({ version: 1 }));
       const persisted = mapper.toPersistence(entity);
       // Prisma applies @default(1); we never echo it back.
       expect(persisted).not.toHaveProperty('version');
     });
   });
   ```

2. Verify the test fails (today's auto-mapper has no handlers excluding `version`).

   ```bash
   pnpm test:unit --filter @arcaai/domains -- GlobalSettingEntityMapper
   # Expected: 3 failing
   ```

3. Implement — update the mapper's `createMapperHandlers` block:

   ```typescript
   // packages/domains/src/mappers/generated/core/GlobalSettingEntityMapper.ts
   import { AutoClassMapper, AutoEntityChangeMapper, BaseMapper, createMapperHandlers } from '../../../common';
   import * as Entities from '../../../entities';
   import * as Models from '../../../models';

   export class GlobalSettingEntityMapper extends BaseMapper<Entities.GlobalSettingEntity, Models.GlobalSetting> {
     constructor() {
       super();
     }

     public toPersistence(entity: Entities.GlobalSettingEntity): Models.GlobalSetting {
       return AutoClassMapper(entity, Models.GlobalSetting, GlobalSettingEntityMapperHandlers.$toPersistence);
     }

     public toPersistenceChanges(entity: Entities.GlobalSettingEntity): Partial<Models.GlobalSetting> {
       return AutoEntityChangeMapper(entity, Models.GlobalSetting, GlobalSettingEntityMapperHandlers.$toPersistence);
     }

     public toDomainEntity(dataModel: Models.GlobalSetting): Entities.GlobalSettingEntity {
       return AutoClassMapper(dataModel, Entities.GlobalSettingEntity, GlobalSettingEntityMapperHandlers.$toDomain);
     }
   }

   /**
    * `version` is database-owned (TASK-302 Stream D).
    *  - `$toDomain.version` — explicit pass-through so the entity getter sees the
    *    DB row's current value (the AutoEntityMapper would do this anyway, but
    *    making it explicit is a documentation handle).
    *  - `$toPersistence.version` — returns `undefined`, which causes the auto-
    *    mappers to omit it from both full inserts and change-tracked updates.
    *    The only legitimate writer of `_version` is `Repository.updateWithVersion`.
    */
   export const GlobalSettingEntityMapperHandlers = createMapperHandlers<
     Entities.GlobalSettingEntity,
     Models.GlobalSetting
   >({
     $toPersistence: {
       version: () => undefined,
     },
     $toDomain: {
       version: (row) => row.version,
     },
   });
   ```

4. Verify all three tests pass.

   ```bash
   pnpm test:unit --filter @arcaai/domains -- GlobalSettingEntityMapper
   # Expected:
   #   ✓ toDomainEntity carries `version` from the database row
   #   ✓ toPersistenceChanges never contains `version`, even if the change set has it
   #   ✓ toPersistence (full insert path) does not write `version`
   ```

5. Commit.

   ```bash
   git add packages/domains/src/mappers
   git commit -m "feat(domains): GlobalSettingEntityMapper round-trips version on read only (TASK-302 Stream D Phase B)"
   ```

### Task B.7 — `applyChangesToEntity` filters `version`

**Agent**: `database-admin`

**Files**:
- Modify: `packages/applications/src/common/applyChangesToEntity.ts`
- Modify: `packages/applications/src/common/__tests__/applyChangesToEntity.test.ts` (create if absent)

**Steps**:

1. Add the failing test.

   ```typescript
   // packages/applications/src/common/__tests__/applyChangesToEntity.test.ts (new file or append)
   import { describe, it, expect } from 'vitest';
   import { applyChangesToEntity } from '../applyChangesToEntity';
   import { BaseEntity } from '@arcaai/domains';

   class StubEntity extends BaseEntity {
     constructor() {
       super({
         id: 'e-1',
         createdBy: null,
         updatedBy: null,
         createdAt: new Date(),
         updatedAt: new Date(),
       });
     }
     validate(): void {}
   }

   describe('applyChangesToEntity — version is database-owned (TASK-302 Stream D Phase B)', () => {
     it('ignores `version` in the changes payload', async () => {
       const e = new StubEntity();
       await applyChangesToEntity(e, { version: 99, updatedBy: 'u-1' } as any);
       expect(e.version).toBe(1); // unchanged
       expect(e.updatedBy).toBe('u-1'); // other fields still applied
     });
   });
   ```

2. Verify the test fails (today's `applyChangesToEntity` happily writes `version`).

   ```bash
   pnpm test:unit --filter @arcaai/applications -- applyChangesToEntity
   # Expected: 1 failing — e.version === 99
   ```

3. Implement. Add a single guard at the top of the for-loop in `packages/applications/src/common/applyChangesToEntity.ts` (around line 64):

   ```typescript
   // packages/applications/src/common/applyChangesToEntity.ts (inside the for loop)
   for (const key of Object.keys(changes) as Array<keyof K>) {
     // TASK-302 Stream D Phase B — `version` is database-owned. The only
     // legitimate writer is Repository.updateWithVersion. Filtering here is
     // defense in depth on top of the entity having no public setter and the
     // mapper $toPersistence excluding it.
     if (key === ('version' as keyof K)) {
       continue;
     }

     const value = changes[key];
     // ... rest of the loop body unchanged ...
   }
   ```

4. Verify the test passes, and all existing applications tests still pass.

   ```bash
   pnpm test:unit --filter @arcaai/applications -- applyChangesToEntity
   # Expected: 1 passing (plus any existing tests for the file).
   pnpm test:unit --filter @arcaai/applications
   # Expected: 0 regressions.
   ```

5. Commit.

   ```bash
   git add packages/applications/src/common
   git commit -m "feat(applications): applyChangesToEntity skips DB-owned version (TASK-302 Stream D Phase B)"
   ```

### Task B.8 — Soft-delete and restore bump `_version`

**Agent**: `database-admin`

**Files**:
- Modify: `packages/domains/src/common/repository.ts`
- Create: `packages/domains/src/common/__tests__/softDelete.bumpsVersion.test.ts`

**Steps**:

1. Write the failing test. Current `softDelete` calls `db.update` (not `db.updateMany`) and never includes `version: { increment: 1 }`; this test forces the bump.

   ```typescript
   // packages/domains/src/common/__tests__/softDelete.bumpsVersion.test.ts
   import { describe, it, expect, vi, beforeEach } from 'vitest';
   import { Repository } from '../repository';
   import { BaseEntity } from '../baseEntity/base.entity';
   import { ResourceStatusType } from '../../enums/generated/ResourceStatusType';

   const buildHarness = () => {
     const db = {
       update: vi.fn(),
       updateMany: vi.fn(),
       findUnique: vi.fn(),
     };
     const uow = { getDatabaseService: () => ({ TestModel: db }) };
     const mapper = {
       toPersistence: vi.fn(),
       toPersistenceChanges: vi.fn(),
       toDomainEntity: vi.fn((m: any) => m),
     };
     class TestEntity extends BaseEntity { validate(): void {} }
     class TestRepository extends Repository<TestEntity, any> {
       constructor() { super(uow as any, 'TestModel', mapper as any); }
     }
     // Force the model to support soft-delete for the test.
     return { repo: new TestRepository(), db, mapper };
   };

   // Stub `modelHasSoftDelete` to return true for our fake model.
   vi.mock('@arcaai/database', async () => ({
     ...((await vi.importActual('@arcaai/database')) as object),
     modelHasSoftDelete: () => true,
   }));

   describe('Repository.softDelete bumps _version (TASK-302 Stream D Phase B)', () => {
     let harness: ReturnType<typeof buildHarness>;
     beforeEach(() => { harness = buildHarness(); });

     it('soft-delete includes version: { increment: 1 } in the data payload', async () => {
       harness.db.update.mockResolvedValueOnce({ id: 'e-1', version: 2 });
       await harness.repo.softDelete('e-1', 'u-1');
       expect(harness.db.update).toHaveBeenCalledWith({
         where: { id: 'e-1' },
         data: expect.objectContaining({
           resourceStatus: ResourceStatusType.DELETED,
           resourceStatusUpdatedBy: 'u-1',
           version: { increment: 1 },
         }),
         include: undefined,
       });
     });

     it('restore includes version: { increment: 1 } in the data payload', async () => {
       harness.db.update.mockResolvedValueOnce({ id: 'e-1', version: 3 });
       await harness.repo.restore('e-1', 'u-1');
       expect(harness.db.update).toHaveBeenCalledWith({
         where: { id: 'e-1' },
         data: expect.objectContaining({
           resourceStatus: ResourceStatusType.ENABLED,
           version: { increment: 1 },
         }),
         include: undefined,
       });
     });
   });
   ```

2. Verify the test fails.

   ```bash
   pnpm test:unit --filter @arcaai/domains -- softDelete.bumpsVersion
   # Expected: 2 failing — version increment missing
   ```

3. Implement. Update both `softDelete` and `restore` in `repository.ts` to include `version: { increment: 1 }`:

   ```typescript
   // packages/domains/src/common/repository.ts (excerpt; only the two methods change)

   public async softDelete(id: EntityId, updatedBy?: EntityId): Promise<DomainEntity> {
     if (!this.supportsSoftDelete) {
       throw new Error(`softDelete is not supported on model "${this._modelName}" because it has no resourceStatus column`);
     }
     const model = await this.db.update({
       where: { id },
       data: {
         resourceStatus: ResourceStatusType.DELETED,
         resourceStatusUpdatedAt: new Date(),
         ...(updatedBy && { resourceStatusUpdatedBy: updatedBy }),
         // TASK-302 Stream D Phase B — soft-delete is a real state change.
         // Bumping prevents resurrection races (research §7 edge case).
         version: { increment: 1 },
       },
       include: this._includes,
     });
     return this._mapper.toDomainEntity(model);
   }

   public async restore(id: EntityId, updatedBy?: EntityId): Promise<DomainEntity> {
     if (!this.supportsSoftDelete) {
       throw new Error(`restore is not supported on model "${this._modelName}" because it has no resourceStatus column`);
     }
     const model = await this.db.update({
       where: { id },
       data: {
         resourceStatus: ResourceStatusType.ENABLED,
         resourceStatusUpdatedAt: new Date(),
         ...(updatedBy && { resourceStatusUpdatedBy: updatedBy }),
         version: { increment: 1 },
       },
       include: this._includes,
     });
     return this._mapper.toDomainEntity(model);
   }
   ```

4. Verify the two tests pass, and the whole `@arcaai/domains` test suite stays green.

   ```bash
   pnpm test:unit --filter @arcaai/domains -- softDelete.bumpsVersion
   # Expected: 2 passing
   pnpm test:unit --filter @arcaai/domains
   # Expected: 0 regressions
   ```

5. Commit.

   ```bash
   git add packages/domains/src/common
   git commit -m "feat(domains): softDelete/restore bump _version (TASK-302 Stream D Phase B)"
   ```

### Code Review Gate B

**Agent**: `code-reviewer`

- Confirm B.1–B.8 each shipped as separate commits with failing-then-passing test evidence.
- Confirm **no service or controller** changed in this phase — `git diff main…HEAD packages/applications/src/services/` and `apps/api/src/modules/` should be empty.
- Confirm the Postgres regression test (B.4) actually runs in the integration-test CI step (look at the `pnpm test:integration` target or whichever Turborepo task runs it). If the CI step doesn't exist yet, file a follow-up; **block** the gate.
- Spot-check that the existing `update` method on `Repository<T>` is untouched (seed code and non-concurrent callers must keep working).
- Verify `version` is genuinely read-only on `BaseEntity` — `Object.getOwnPropertyDescriptor(Object.getPrototypeOf(entity), 'version').set` must be `undefined`.

---

## Phase C — Opt-in services (~3 days)

**Goal.** Migrate `TenantService.updateTenantConfigs` and `GlobalSettingService.update` to `updateWithVersion`. Wrap the bulk path in `$transaction`. Add the DTO field. Add a Vitest concurrent-write proof. Add a Playwright e2e against the live API. Audit-log gets `previousVersion` + `newVersion`.

### Task C.1 — Add `expectedVersion` to `UpdateTenantConfigRequest` DTO

**Agent**: `api-designer`

**Files**:
- Modify: `packages/applications/src/services/tenant/dto/updateTenantConfigRequest.ts`
- Modify: `apps/api/tests/e2e/tenants.spec.ts` (later in C.5)

**Steps**:

1. Write the failing DTO validation test.

   ```typescript
   // packages/applications/src/services/tenant/dto/__tests__/updateTenantConfigRequest.test.ts
   import { describe, it, expect } from 'vitest';
   import { plainToInstance } from 'class-transformer';
   import { validate } from 'class-validator';
   import { UpdateTenantConfigRequest } from '../updateTenantConfigRequest';

   describe('UpdateTenantConfigRequest — expectedVersion (TASK-302 Stream D Phase C)', () => {
     it('rejects payloads missing expectedVersion', async () => {
       const dto = plainToInstance(UpdateTenantConfigRequest, {
         id: '00000000-0000-7000-8000-000000000001',
         value: 'v1',
       });
       const errors = await validate(dto);
       expect(errors.some((e) => e.property === 'expectedVersion')).toBe(true);
     });

     it('accepts a positive integer expectedVersion', async () => {
       const dto = plainToInstance(UpdateTenantConfigRequest, {
         id: '00000000-0000-7000-8000-000000000001',
         value: 'v1',
         expectedVersion: 3,
       });
       const errors = await validate(dto);
       expect(errors).toHaveLength(0);
     });

     it('rejects non-integer expectedVersion', async () => {
       const dto = plainToInstance(UpdateTenantConfigRequest, {
         id: '00000000-0000-7000-8000-000000000001',
         value: 'v1',
         expectedVersion: 3.5,
       });
       const errors = await validate(dto);
       expect(errors.some((e) => e.property === 'expectedVersion')).toBe(true);
     });

     it('rejects negative expectedVersion', async () => {
       const dto = plainToInstance(UpdateTenantConfigRequest, {
         id: '00000000-0000-7000-8000-000000000001',
         value: 'v1',
         expectedVersion: -1,
       });
       const errors = await validate(dto);
       expect(errors.some((e) => e.property === 'expectedVersion')).toBe(true);
     });
   });
   ```

2. Verify the tests fail.

   ```bash
   pnpm test:unit --filter @arcaai/applications -- updateTenantConfigRequest
   # Expected: 4 failing
   ```

3. Update the DTO.

   ```typescript
   // packages/applications/src/services/tenant/dto/updateTenantConfigRequest.ts
   import { ApiProperty } from '@nestjs/swagger';
   import { IsString, IsOptional, IsInt, Min } from 'class-validator';
   import { BaseRequest } from '../../../common';
   import { EntityId } from '@arcaai/domains';
   import { EntityIdProperty } from '../../../decorators';

   export class UpdateTenantConfigRequest extends BaseRequest {
     @ApiProperty({ description: 'ID of the configuration' })
     @EntityIdProperty()
     id!: EntityId;

     @ApiProperty({ description: 'Description of the configuration', required: false })
     @IsString()
     @IsOptional()
     description?: string;

     @ApiProperty({ description: 'Value for the configuration' })
     @IsString()
     value!: string;

     /**
      * Optimistic-concurrency token. Required since TASK-302 Stream D Phase C.
      * Must equal the row's current `_version`; the bulk update inside a single
      * `$transaction` is all-or-nothing on conflict.
      *
      * @see TASK-302 Stream D `04-optimistic-locking.md`
      */
     @ApiProperty({
       description: 'Current version of the row (from the prior GET). The PATCH fails with 412 if any row\'s version drifted.',
       example: 7,
     })
     @IsInt()
     @Min(1)
     expectedVersion!: number;
   }
   ```

4. Verify the tests pass.

   ```bash
   pnpm test:unit --filter @arcaai/applications -- updateTenantConfigRequest
   # Expected: 4 passing
   ```

5. Commit.

   ```bash
   git add packages/applications/src/services/tenant/dto
   git commit -m "feat(applications): UpdateTenantConfigRequest carries expectedVersion (TASK-302 Stream D Phase C)"
   ```

### Task C.2 — Failing Vitest test for concurrent writes against `TenantService.updateTenantConfigs`

**Agent**: `tester`

**Files**:
- Modify: `packages/applications/src/services/tenant/__tests__/tenant.service.test.ts`

**Steps**:

1. Append a new `describe` block that asserts the *post-Phase-C* contract: the second writer must throw `OptimisticConcurrencyException`.

   ```typescript
   // packages/applications/src/services/tenant/__tests__/tenant.service.test.ts (append)
   import { OptimisticConcurrencyException } from '@arcaai/exceptions';

   describe('updateTenantConfigs — optimistic concurrency (TASK-302 Stream D Phase C)', () => {
     it('throws OptimisticConcurrencyException when expectedVersion drifted', async () => {
       const setting = createMockGlobalSettingEntity({
         id: 'gs-1', tenantId: 'tenant-1', locked: false,
       });
       (setting as any).version = 5;

       mockTenantRepository.findFirst.mockResolvedValueOnce(
         createMockTenantEntity({ id: 'tenant-1', key: 'TENANT_1' }),
       );
       mockGlobalSettingRepository.findById.mockResolvedValueOnce(setting);
       mockGlobalSettingRepository.updateWithVersion = vi.fn().mockRejectedValueOnce(
         new OptimisticConcurrencyException('GlobalSetting', 'gs-1', {
           expectedVersion: 5, currentVersion: 6,
         }),
       );

       await expect(
         service.updateTenantConfigs('tenant-1', [
           { id: 'gs-1', value: 'new', expectedVersion: 5 } as any,
         ]),
       ).rejects.toBeInstanceOf(OptimisticConcurrencyException);
     });

     it('calls updateWithVersion (not update) when expectedVersion is supplied', async () => {
       const setting = createMockGlobalSettingEntity({
         id: 'gs-1', tenantId: 'tenant-1', locked: false, hasChanges: true,
       });
       (setting as any).version = 5;

       mockTenantRepository.findFirst.mockResolvedValueOnce(
         createMockTenantEntity({ id: 'tenant-1', key: 'TENANT_1' }),
       );
       mockGlobalSettingRepository.findById.mockResolvedValueOnce(setting);
       const updateWithVersion = vi.fn().mockResolvedValueOnce(setting);
       mockGlobalSettingRepository.updateWithVersion = updateWithVersion;

       await service.updateTenantConfigs('tenant-1', [
         { id: 'gs-1', value: 'new', expectedVersion: 5 } as any,
       ]);

       expect(updateWithVersion).toHaveBeenCalledWith('gs-1', setting, 5);
       expect(mockGlobalSettingRepository.update).not.toHaveBeenCalled();
     });
   });
   ```

2. Verify the tests fail.

   ```bash
   pnpm test:unit --filter @arcaai/applications -- tenant.service
   # Expected: 2 failing
   ```

3. (Implementation lands in C.3 / C.4.)

### Task C.3 — Migrate `TenantService.updateTenantConfigs` to `updateWithVersion`

**Agent**: `database-admin`

**Files**:
- Modify: `packages/applications/src/services/tenant/tenant.service.ts`

**Steps**:

1. Replace the loop body to call `updateWithVersion` instead of `update`. Maintain the existing allowlist + locked + super-admin checks from Phase 0 Item 2.

   ```typescript
   // packages/applications/src/services/tenant/tenant.service.ts — updateTenantConfigs (excerpt)
   // BEFORE (line ~511):
   //   const updatedConfig = await this.globalSettingRepository.update(existingConfig.id, existingConfig);
   //
   // AFTER:
   const updatedConfig = await this.globalSettingRepository.updateWithVersion(
     existingConfig.id,
     existingConfig,
     config.expectedVersion,
   );
   ```

   The full method, with the previously-extracted allowlist and the new CAS write, looks like:

   ```typescript
   async updateTenantConfigs(
     identifier: EntityId | string,
     request: UpdateTenantConfigRequest[],
   ): Promise<FetchResponse<GlobalSettingEntity>> {
     const tenant = await this.resolveTenantByIdentifier(identifier);
     const isSuperAdmin = this.isSuperAdmin();
     if (tenant.key === GLOBAL_TENANT_KEY && !isSuperAdmin) {
       throw new ForbiddenException(
         `Tenant '${GLOBAL_TENANT_KEY}' holds system defaults and can only be modified by ${SUPER_ADMIN_ROLE} users.`,
       );
     }

     // C.4 — wrap the whole batch in a single Prisma $transaction
     // (the $transaction setup lands in the next task). Until then this
     // method runs the loop sequentially; the assertion in C.2's first test
     // does not depend on the transaction.

     const updatedConfigs: GlobalSettingEntity[] = [];
     const previousVersions: number[] = [];

     for (const config of request) {
       const existingConfig = await this.globalSettingRepository.findById(config.id);
       if (!existingConfig) {
         throw new ArgumentInvalidException(`Config with id ${config.id} not found`);
       }
       if (existingConfig.tenantId !== tenant.id) {
         throw new ArgumentInvalidException(`Config ${config.id} does not belong to tenant ${tenant.id}`);
       }
       if (existingConfig.locked === true && !isSuperAdmin) {
         throw new ForbiddenException(
           `Setting '${existingConfig.key}' is locked and can only be modified by ${SUPER_ADMIN_ROLE} users.`,
         );
       }
       if (config.value !== undefined) {
         await this.validateSmrConfigValue(existingConfig.key, config.value, tenant.id);
       }

       // Strict allowlist (TASK-302 Phase 0 Item 2). Note: `expectedVersion`
       // is consumed by updateWithVersion and never written into the entity.
       const changes = { value: config.value, description: config.description };
       await this.updateEntity(existingConfig, changes);

       const previousVersion = existingConfig.version;

       if (!existingConfig.hasChanges) {
         updatedConfigs.push(existingConfig);
         previousVersions.push(previousVersion);
         continue;
       }

       const updatedConfig = await this.globalSettingRepository.updateWithVersion(
         existingConfig.id,
         existingConfig,
         config.expectedVersion,
       );
       updatedConfigs.push(updatedConfig);
       previousVersions.push(previousVersion);
     }

     this.broadcastSysEvent(SysEventType.ResourceUpdated, {
       resourceIds: updatedConfigs.map((c) => c.id),
       data: updatedConfigs.map((c, i) => ({
         ...c.toObject(),
         previousVersion: previousVersions[i],
         newVersion: c.version,
       })),
     });

     return new FetchResponse<GlobalSettingEntity>({
       data: updatedConfigs,
       count: updatedConfigs.length,
       limit: 0,
       page: 0,
     });
   }
   ```

2. Verify C.2's Vitest tests now pass.

   ```bash
   pnpm test:unit --filter @arcaai/applications -- tenant.service
   # Expected: 2 new tests passing; existing tenant.service tests still green.
   ```

3. Commit.

   ```bash
   git add packages/applications/src/services/tenant/tenant.service.ts \
           packages/applications/src/services/tenant/__tests__/tenant.service.test.ts
   git commit -m "feat(applications): TenantService.updateTenantConfigs uses CAS write (TASK-302 Stream D Phase C)"
   ```

### Task C.4 — Wrap bulk update in a single `$transaction` (all-or-nothing)

**Agent**: `database-admin`

**Files**:
- Modify: `packages/applications/src/services/tenant/tenant.service.ts`
- Modify: `packages/applications/src/services/tenant/tenant.service.module.ts` (inject `CoreUnitOfWorkService` if not already present)

**Steps**:

1. Write the failing test that asserts a mid-batch conflict rolls the whole batch back.

   ```typescript
   // packages/applications/src/services/tenant/__tests__/tenant.service.test.ts (append)
   it('rolls the whole batch back if any row\'s version drifted', async () => {
     mockTenantRepository.findFirst.mockResolvedValueOnce(
       createMockTenantEntity({ id: 'tenant-1', key: 'TENANT_1' }),
     );

     const row1 = createMockGlobalSettingEntity({ id: 'gs-1', tenantId: 'tenant-1', hasChanges: true });
     const row2 = createMockGlobalSettingEntity({ id: 'gs-2', tenantId: 'tenant-1', hasChanges: true });
     (row1 as any).version = 5;
     (row2 as any).version = 9;

     mockGlobalSettingRepository.findById
       .mockResolvedValueOnce(row1)
       .mockResolvedValueOnce(row2);

     mockGlobalSettingRepository.updateWithVersion = vi.fn()
       .mockResolvedValueOnce(row1) // row 1 ok
       .mockRejectedValueOnce(       // row 2 conflict
         new OptimisticConcurrencyException('GlobalSetting', 'gs-2', {
           expectedVersion: 9, currentVersion: 10,
         }),
       );

     mockUnitOfWorkService.endTransaction = vi.fn();

     await expect(
       service.updateTenantConfigs('tenant-1', [
         { id: 'gs-1', value: 'a', expectedVersion: 5 } as any,
         { id: 'gs-2', value: 'b', expectedVersion: 9 } as any,
       ]),
     ).rejects.toBeInstanceOf(OptimisticConcurrencyException);

     // Whole batch must end the transaction (so the rollback happens) even
     // though row 1 already wrote. The Prisma $transaction takes care of the
     // actual SQL rollback; we just need to confirm we tear down the CLS.
     expect(mockUnitOfWorkService.endTransaction).toHaveBeenCalled();
   });
   ```

2. Verify failure.

   ```bash
   pnpm test:unit --filter @arcaai/applications -- tenant.service
   # Expected: 1 failing — endTransaction never called because $transaction not wired
   ```

3. Implement. Inject `CoreUnitOfWorkService` into `TenantService` and wrap the loop:

   ```typescript
   // packages/applications/src/services/tenant/tenant.service.ts (excerpt; constructor + method)

   constructor(
     private readonly tenantRepository: TenantRepository,
     private readonly globalSettingRepository: GlobalSettingRepository,
     private readonly departmentRepository: DepartmentRepository,
     private readonly promptTemplateRepository: PromptTemplateRepository,
     private readonly asrPipelineRepository: AsrPipelineRepository,
     @Inject('CORE_DATABASE_SERVICE')
     private readonly databaseService: CoreDatabaseService,
     @Inject(ITenantBucketService)
     private readonly tenantBucketService: ITenantBucketService,
     // TASK-302 Stream D Phase C — single $transaction wrapping the CAS loop
     private readonly unitOfWork: CoreUnitOfWorkService,
     protected override readonly eventEmitter: EventEmitter2,
     protected override readonly clsService: ClsService<IActiveUserContext>,
   ) {
     super(eventEmitter, clsService, ResourceType.Tenant);
   }

   async updateTenantConfigs(/* … */): Promise<FetchResponse<GlobalSettingEntity>> {
     // ... (pre-validation lines unchanged) ...

     await this.unitOfWork.startTransaction();
     try {
       const updatedConfigs: GlobalSettingEntity[] = [];
       const previousVersions: number[] = [];
       for (const config of request) {
         // ... (existing loop body — findById, allowlist, updateEntity, updateWithVersion) ...
       }

       // Broadcast on success only.
       this.broadcastSysEvent(SysEventType.ResourceUpdated, {
         resourceIds: updatedConfigs.map((c) => c.id),
         data: updatedConfigs.map((c, i) => ({
           ...c.toObject(),
           previousVersion: previousVersions[i],
           newVersion: c.version,
         })),
       });

       return new FetchResponse<GlobalSettingEntity>({
         data: updatedConfigs,
         count: updatedConfigs.length,
         limit: 0,
         page: 0,
       });
     } finally {
       this.unitOfWork.endTransaction();
     }
   }
   ```

   Register `CoreUnitOfWorkService` in `tenant.service.module.ts` if it isn't already (most application modules import `CoreDatabaseModule` which provides it; double-check the import).

4. Verify all tenant.service tests pass.

   ```bash
   pnpm test:unit --filter @arcaai/applications -- tenant.service
   # Expected: 0 failures (including the new "rolls the whole batch back" test).
   ```

5. Commit.

   ```bash
   git add packages/applications/src/services/tenant
   git commit -m "feat(applications): updateTenantConfigs is all-or-nothing via \$transaction (TASK-302 Stream D Phase C)"
   ```

### Task C.5 — Playwright e2e for concurrent PATCH

**Agent**: `tester`

**Files**:
- Create: `apps/api/tests/e2e/optimistic-locking.spec.ts`

**Steps**:

1. Write the failing e2e. It logs in as a SUPER_ADMIN, GETs a tenant config row, makes two concurrent PATCHes carrying the same `expectedVersion`, and asserts (a) exactly one returns 200, (b) the other returns 412 with `currentVersion`, (c) the final stored value is the one written by the 200 PATCH.

   ```typescript
   // apps/api/tests/e2e/optimistic-locking.spec.ts
   import { test, expect } from '@playwright/test';
   import {
     loginSeededUsers,
     createTestDataRegistry,
     cleanupTestData,
     type TestDataRegistry,
   } from '../../../tests/helpers';

   test.describe('Optimistic locking — PATCH /tenants/me/config (TASK-302 Stream D Phase C)', () => {
     let adminToken: string;
     const registry: TestDataRegistry = createTestDataRegistry();

     test.beforeAll(async ({ request }) => {
       const { adminToken: token } = await loginSeededUsers(request);
       adminToken = token;
     });

     test.afterAll(async ({ request }) => {
       if (adminToken) await cleanupTestData(request, adminToken, registry);
     });

     test('two concurrent PATCHes with the same expectedVersion: one 200, one 412', async ({ request }) => {
       // 1. Read the current config.
       const getRes = await request.get('/api/v1/tenant/me/config', {
         headers: { Authorization: `Bearer ${adminToken}` },
       });
       expect(getRes.status()).toBe(200);
       const body = await getRes.json();
       const target = body.data.find(
         (c: { key: string }) => c.key === 'default-language' || c.key === 'enable-real-time-transcription',
       );
       expect(target, 'no editable tenant setting available').toBeTruthy();
       const expectedVersion = target.version;

       // 2. Two PATCHes in parallel against the same expectedVersion.
       const [resA, resB] = await Promise.all([
         request.patch('/api/v1/tenant/me/config', {
           headers: { Authorization: `Bearer ${adminToken}` },
           data: [{ id: target.id, value: 'A', expectedVersion }],
         }),
         request.patch('/api/v1/tenant/me/config', {
           headers: { Authorization: `Bearer ${adminToken}` },
           data: [{ id: target.id, value: 'B', expectedVersion }],
         }),
       ]);

       const statuses = [resA.status(), resB.status()].sort();
       expect(statuses).toEqual([200, 412]);

       // 3. The 412 carries currentVersion.
       const failed = resA.status() === 412 ? resA : resB;
       const failedBody = await failed.json();
       expect(failedBody).toMatchObject({
         code: 'PERSISTENCE.CONCURRENCY_CONFLICT',
         metadata: {
           expectedVersion,
           currentVersion: expectedVersion + 1,
         },
       });

       // 4. The winning PATCH's value is what's stored.
       const winner = resA.status() === 200 ? 'A' : 'B';
       const verify = await request.get('/api/v1/tenant/me/config', {
         headers: { Authorization: `Bearer ${adminToken}` },
       });
       const after = (await verify.json()).data.find((c: { id: string }) => c.id === target.id);
       expect(after.value).toBe(winner);
       expect(after.version).toBe(expectedVersion + 1);
     });
   });
   ```

2. Verify it fails (the exception filter doesn't render 412 yet — Phase C only added the exception type, not the HTTP mapping; the next task adds that).

   ```bash
   pnpm test:e2e -- optimistic-locking
   # Expected: failing — likely 500 Internal Server Error from one writer.
   ```

3. Add the exception-to-HTTP mapping in the existing `ExceptionInterceptor`. Insert this branch before the generic `BaseException` handler at `apps/api/src/interceptors/exception.interceptor.ts:110`:

   ```typescript
   // apps/api/src/interceptors/exception.interceptor.ts (insertion)
   import { OptimisticConcurrencyException } from '@arcaai/exceptions';

   // ... (other branches) ...

   if (err instanceof OptimisticConcurrencyException) {
     this.logger.debug({
       message: 'Optimistic concurrency conflict',
       ...baseContext,
       expectedVersion: (err.metadata as any)?.expectedVersion,
       currentVersion: (err.metadata as any)?.currentVersion,
     });
     return throwError(
       () => new HttpException(err.toJSON(), HttpStatus.PRECONDITION_FAILED),
     );
   }
   ```

### Task C.6 — Verify the e2e and confirm 412 semantics

**Agent**: `tester`

**Files**: same as C.5.

**Steps**:

1. Run the e2e.

   ```bash
   pnpm test:e2e -- optimistic-locking
   # Expected output:
   #   Running 1 test using 1 worker
   #   ✓ two concurrent PATCHes with the same expectedVersion: one 200, one 412
   #   1 passed
   ```

2. Run the full e2e suite to confirm no regression.

   ```bash
   pnpm test:e2e
   # Expected: 0 regressions.
   ```

3. Commit.

   ```bash
   git add apps/api/src/interceptors/exception.interceptor.ts apps/api/tests/e2e/optimistic-locking.spec.ts
   git commit -m "feat(api): map OptimisticConcurrencyException to 412 + e2e proof (TASK-302 Stream D Phase C)"
   ```

### Task C.7 — Migrate `GlobalSettingService.update` to `updateWithVersion`

**Agent**: `database-admin`

**Files**:
- Modify: `packages/applications/src/services/globalSetting/globalSetting.service.ts`
- Modify: `packages/applications/src/services/globalSetting/dto/updateGlobalSetting.request.ts`

**Steps**:

1. Add `expectedVersion: number` to the DTO (same shape as C.1).

2. Write the failing service test in `packages/applications/src/services/globalSetting/__tests__/globalSetting.service.test.ts` (create if absent) asserting `update` calls `updateWithVersion`.

3. Update `update`:

   ```typescript
   // packages/applications/src/services/globalSetting/globalSetting.service.ts
   async update(id: EntityId, request: UpdateGlobalSettingRequest): Promise<GlobalSettingEntity> {
     const globalSetting = await this.globalSettingRepository.findById(id);

     const previousData = globalSetting.toObject();
     const previousVersion = globalSetting.version;
     await this.updateEntity(globalSetting, request);

     if (!globalSetting.hasChanges) {
       throw new ArgumentInvalidException('No changes to write to.');
     }

     const updatedGlobalSetting = await this.globalSettingRepository.updateWithVersion(
       id,
       globalSetting,
       request.expectedVersion,
     );

     this.broadcastSysEvent(SysEventType.ResourceUpdated, {
       resourceId: updatedGlobalSetting.id,
       data: { ...globalSetting.changes, previousVersion, newVersion: updatedGlobalSetting.version },
       previousData,
     });
     return updatedGlobalSetting;
   }
   ```

4. Verify all tests pass; commit.

   ```bash
   pnpm test:unit --filter @arcaai/applications -- globalSetting
   git add packages/applications/src/services/globalSetting
   git commit -m "feat(applications): GlobalSettingService.update uses CAS write (TASK-302 Stream D Phase C)"
   ```

### Task C.8 — Audit-log correlation: `SysEvent.ResourceUpdated` carries `previousVersion` + `newVersion`

**Agent**: `database-admin`

**Files**:
- Modify: `packages/applications/src/services/tenant/tenant.service.ts` (already changed in C.3 — verify)
- Modify: `packages/applications/src/services/globalSetting/globalSetting.service.ts` (already changed in C.7 — verify)
- Create: `packages/applications/src/services/__tests__/audit-correlation.test.ts`

**Steps**:

1. Write a test that asserts the emitted `SysEvent.ResourceUpdated` for both services contains the two version fields.

   ```typescript
   // packages/applications/src/services/__tests__/audit-correlation.test.ts
   import { describe, it, expect, vi, beforeEach } from 'vitest';
   import { SysEventType } from '@arcaai/domains';
   // ... setup TenantService with mocks identical to tenant.service.test.ts ...

   describe('Audit-log correlation (TASK-302 Stream D Phase C)', () => {
     it('TenantService.updateTenantConfigs emits previousVersion and newVersion', async () => {
       // ... arrange the same setting at version 5; updateWithVersion returns version 6 ...
       await service.updateTenantConfigs('tenant-1', [
         { id: 'gs-1', value: 'new', expectedVersion: 5 } as any,
       ]);

       expect(mockEventEmitter.emit).toHaveBeenCalledWith(
         SysEventType.ResourceUpdated,
         expect.objectContaining({
           data: expect.arrayContaining([
             expect.objectContaining({ previousVersion: 5, newVersion: 6 }),
           ]),
         }),
       );
     });
   });
   ```

2. Verify the test passes (the broadcastSysEvent call in C.3 / C.7 should already satisfy this; if not, fix the service and re-run).

3. Commit.

   ```bash
   git add packages/applications/src/services/__tests__
   git commit -m "test(applications): assert SysEvent carries previous/newVersion (TASK-302 Stream D Phase C)"
   ```

### Code Review Gate C

**Agent**: `code-reviewer`

- Confirm the strict `ValidationPipe` + allowlist (Phase 0) is unchanged.
- Confirm `expectedVersion` is the **only** new field on `UpdateTenantConfigRequest` and `UpdateGlobalSettingRequest`.
- Confirm the `$transaction` wrapper in `updateTenantConfigs` and that `endTransaction` runs in `finally`.
- Confirm `previousVersion` + `newVersion` make it into the audit log SysEvent for both services.
- Spot-check that the e2e from C.5/C.6 actually exercises two distinct sockets / Playwright contexts, not the same connection serially.
- Verify the existing tenant-config-locked-runtime e2e still passes (no regression on the locked-row guard).

---

## Phase D — HTTP + SDK (~3 days)

**Goal.** Introduce the `ETag` / `If-Match` wire format on top of the body-field `expectedVersion`. Two equivalent inbound shapes are accepted (header preferred; body field is the fallback for service-to-service callers). SDK captures and replays `ETag` automatically; UI gets a conflict modal stub.

> **Rollout reminder.** API ships first, SDK second, UI third. See Cross-stream Dependencies. The `@RequiresIfMatch()` decorator is opt-in per route, so existing routes that don't use it keep working unchanged.

### Section D.1 — `ETagInterceptor`

#### Task D.1.1 — Failing test: response with `version` gets an `ETag` header

**Agent**: `tester`

**Files**:
- Create: `apps/api/src/interceptors/__tests__/etag.interceptor.test.ts`

**Steps**:

1. Write the test.

   ```typescript
   // apps/api/src/interceptors/__tests__/etag.interceptor.test.ts
   import { describe, it, expect, vi } from 'vitest';
   import { ETagInterceptor } from '../etag.interceptor';
   import { of, lastValueFrom } from 'rxjs';
   import { CallHandler, ExecutionContext } from '@nestjs/common';

   const makeContext = (response: { setHeader: ReturnType<typeof vi.fn> }): ExecutionContext =>
     ({
       switchToHttp: () => ({
         getResponse: () => response,
         getRequest: () => ({}),
       }),
     }) as unknown as ExecutionContext;

   describe('ETagInterceptor', () => {
     it('sets ETag from body.version', async () => {
       const res = { setHeader: vi.fn() };
       const next: CallHandler = { handle: () => of({ id: 'x', version: 7 }) };
       const interceptor = new ETagInterceptor();
       const result = await lastValueFrom(interceptor.intercept(makeContext(res), next));
       expect(res.setHeader).toHaveBeenCalledWith('ETag', '"7"');
       expect(result).toEqual({ id: 'x', version: 7 });
     });

     it('does not set ETag when body has no version', async () => {
       const res = { setHeader: vi.fn() };
       const next: CallHandler = { handle: () => of({ id: 'x' }) };
       const interceptor = new ETagInterceptor();
       await lastValueFrom(interceptor.intercept(makeContext(res), next));
       expect(res.setHeader).not.toHaveBeenCalled();
     });

     it('uses the first row\'s version when body is a FetchResponse wrapper', async () => {
       const res = { setHeader: vi.fn() };
       const next: CallHandler = {
         handle: () => of({ data: [{ id: 'x', version: 4 }] }),
       };
       const interceptor = new ETagInterceptor();
       await lastValueFrom(interceptor.intercept(makeContext(res), next));
       // Collections don't carry a single ETag — interceptor should not set one.
       expect(res.setHeader).not.toHaveBeenCalled();
     });
   });
   ```

2. Verify failure.

   ```bash
   pnpm test:unit --filter @arcaai/api -- etag.interceptor
   # Expected: 3 failing (interceptor doesn't exist)
   ```

#### Task D.1.2 — Implement `ETagInterceptor`

**Agent**: `api-designer`

**Files**:
- Create: `apps/api/src/interceptors/etag.interceptor.ts`
- Modify: `apps/api/src/interceptors/index.ts`

**Steps**:

1. Implement.

   ```typescript
   // apps/api/src/interceptors/etag.interceptor.ts
   import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
   import { Observable } from 'rxjs';
   import { map } from 'rxjs/operators';

   /**
    * Sets a strong-comparison `ETag` header on responses whose body carries a
    * `version` field at the top level. RFC 7232 §2.3.2 requires strong
    * comparison for `If-Match`; the simplest strong validator is the monotonic
    * integer rendered as `"<n>"` (double-quoted, no `W/` prefix).
    *
    * Body shapes ignored: collections (`{ data: [...] }`), responses without
    * `.version`, primitives.
    *
    * @see TASK-302 Stream D Phase D
    * @see https://www.rfc-editor.org/rfc/rfc7232.html#section-2.3.2
    */
   @Injectable()
   export class ETagInterceptor implements NestInterceptor {
     intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
       const res = context.switchToHttp().getResponse<{ setHeader: (k: string, v: string) => void }>();
       return next.handle().pipe(
         map((body) => {
           const version = this.extractVersion(body);
           if (version !== undefined) {
             res.setHeader('ETag', `"${version}"`);
           }
           return body;
         }),
       );
     }

     private extractVersion(body: unknown): number | undefined {
       if (!body || typeof body !== 'object') return undefined;
       const v = (body as { version?: unknown }).version;
       return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined;
     }
   }
   ```

   ```typescript
   // apps/api/src/interceptors/index.ts (append)
   export * from './etag.interceptor';
   ```

2. Verify all three tests pass.

   ```bash
   pnpm test:unit --filter @arcaai/api -- etag.interceptor
   # Expected: 3 passing
   ```

3. Commit.

   ```bash
   git add apps/api/src/interceptors
   git commit -m "feat(api): ETagInterceptor sets strong validator from body.version (TASK-302 Stream D Phase D)"
   ```

#### Task D.1.3 — Register `ETagInterceptor` globally

**Agent**: `api-designer`

**Files**:
- Modify: `apps/api/src/main.ts`

**Steps**:

1. After the existing `app.useGlobalPipes(new ValidationPipe(...))` call (~line 221), add:

   ```typescript
   import { ETagInterceptor } from './interceptors';
   // ...
   app.useGlobalInterceptors(new ETagInterceptor());
   ```

   If global interceptors are already registered, append `new ETagInterceptor()` to the existing array.

2. Smoke-test via curl against a dev server: `curl -i $API_URL/api/v1/tenant/me | grep ETag` should print `ETag: "1"` (or whatever the tenant's current version is).

3. Commit.

   ```bash
   git add apps/api/src/main.ts
   git commit -m "feat(api): register ETagInterceptor globally (TASK-302 Stream D Phase D)"
   ```

### Section D.2 — `@RequiresIfMatch()` decorator + `@ExpectedVersion()` param decorator

#### Task D.2.1 — Failing test for the parameter decorator

**Agent**: `tester`

**Files**:
- Create: `apps/api/src/decorators/__tests__/expectedVersion.decorator.test.ts`

**Steps**:

1. Test the param extractor directly. The decorator parses `If-Match`, strips quotes, validates positive integer, and returns the number; missing or malformed headers throw `BadRequestException`; missing header on a `@RequiresIfMatch()`-annotated route throws `HttpException(428)`.

   ```typescript
   // apps/api/src/decorators/__tests__/expectedVersion.decorator.test.ts
   import { describe, it, expect } from 'vitest';
   import { extractExpectedVersion } from '../expectedVersion.decorator';
   import { HttpException, HttpStatus } from '@nestjs/common';

   const ctx = (headers: Record<string, string | undefined>, requiresIfMatch = false) =>
     ({
       getHandler: () => ({}),
       getClass: () => ({}),
       switchToHttp: () => ({
         getRequest: () => ({ headers, _requiresIfMatch: requiresIfMatch }),
       }),
     }) as unknown as Parameters<typeof extractExpectedVersion>[1];

   describe('extractExpectedVersion (TASK-302 Stream D Phase D)', () => {
     it('parses If-Match: "7" to 7', () => {
       expect(extractExpectedVersion(undefined, ctx({ 'if-match': '"7"' }))).toBe(7);
     });

     it('returns undefined when header absent and route not @RequiresIfMatch', () => {
       expect(extractExpectedVersion(undefined, ctx({}))).toBeUndefined();
     });

     it('throws 428 when header absent and route is @RequiresIfMatch', () => {
       expect(() => extractExpectedVersion(undefined, ctx({}, true))).toThrow(HttpException);
       try { extractExpectedVersion(undefined, ctx({}, true)); }
       catch (e: any) { expect(e.getStatus()).toBe(HttpStatus.PRECONDITION_REQUIRED); }
     });

     it('rejects malformed If-Match (no quotes)', () => {
       expect(() => extractExpectedVersion(undefined, ctx({ 'if-match': '7' }))).toThrow();
     });

     it('rejects malformed If-Match (negative)', () => {
       expect(() => extractExpectedVersion(undefined, ctx({ 'if-match': '"-1"' }))).toThrow();
     });

     it('rejects weak validator (W/"7")', () => {
       expect(() => extractExpectedVersion(undefined, ctx({ 'if-match': 'W/"7"' }))).toThrow();
     });
   });
   ```

2. Verify failure.

   ```bash
   pnpm test:unit --filter @arcaai/api -- expectedVersion.decorator
   # Expected: 6 failing
   ```

#### Task D.2.2 — Implement `@ExpectedVersion()` + `extractExpectedVersion`

**Agent**: `api-designer`

**Files**:
- Create: `apps/api/src/decorators/expectedVersion.decorator.ts`

**Steps**:

1. Implement.

   ```typescript
   // apps/api/src/decorators/expectedVersion.decorator.ts
   import {
     BadRequestException,
     createParamDecorator,
     ExecutionContext,
     HttpException,
     HttpStatus,
   } from '@nestjs/common';

   const STRONG_VALIDATOR = /^"(\d+)"$/;

   /**
    * Parse the inbound `If-Match` header into a positive integer. The hook
    * lives outside `createParamDecorator` so we can unit-test it directly.
    *
    * Behavior:
    *  - Header `If-Match: "7"` → 7
    *  - Header missing on a route without `@RequiresIfMatch()` → `undefined`
    *    (allows hybrid body-field fallback for service-to-service callers)
    *  - Header missing on a route with `@RequiresIfMatch()` → throws 428
    *    Precondition Required (RFC 6585)
    *  - Weak validator (`W/"7"`) or malformed → throws 400 Bad Request
    *
    * @see TASK-302 Stream D Phase D
    * @see https://www.rfc-editor.org/rfc/rfc7232.html#section-3.1
    * @see https://www.rfc-editor.org/rfc/rfc6585.html
    */
   export function extractExpectedVersion(_data: unknown, ctx: ExecutionContext): number | undefined {
     const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; _requiresIfMatch?: boolean }>();
     const raw = req.headers['if-match'];

     if (raw === undefined || raw === '') {
       if (req._requiresIfMatch) {
         throw new HttpException(
           {
             statusCode: HttpStatus.PRECONDITION_REQUIRED,
             code: 'HTTP.PRECONDITION_REQUIRED',
             message: 'If-Match header is required for this operation.',
           },
           HttpStatus.PRECONDITION_REQUIRED,
         );
       }
       return undefined;
     }

     const match = STRONG_VALIDATOR.exec(raw);
     if (!match) {
       throw new BadRequestException(
         `Invalid If-Match header: ${raw}. Expected a strong validator of the form "<integer>".`,
       );
     }
     const parsed = Number.parseInt(match[1], 10);
     if (!Number.isInteger(parsed) || parsed < 1) {
       throw new BadRequestException(
         `Invalid If-Match header: ${raw}. Version must be a positive integer.`,
       );
     }
     return parsed;
   }

   export const ExpectedVersion = createParamDecorator(extractExpectedVersion);
   ```

2. Verify the unit tests pass.

   ```bash
   pnpm test:unit --filter @arcaai/api -- expectedVersion.decorator
   # Expected: 6 passing
   ```

#### Task D.2.3 — Failing test for `@RequiresIfMatch()` route guard

**Agent**: `tester`

**Files**:
- Create: `apps/api/src/decorators/__tests__/requiresIfMatch.decorator.test.ts`

**Steps**:

1. The decorator marks the route with metadata that a global guard reads and toggles `req._requiresIfMatch = true`. Test the metadata key and the guard logic.

   ```typescript
   // apps/api/src/decorators/__tests__/requiresIfMatch.decorator.test.ts
   import { describe, it, expect } from 'vitest';
   import { Reflector } from '@nestjs/core';
   import { RequiresIfMatch, REQUIRES_IF_MATCH_KEY } from '../requiresIfMatch.decorator';
   import { RequiresIfMatchGuard } from '../requiresIfMatch.guard';

   describe('RequiresIfMatch', () => {
     class Controller {
       @RequiresIfMatch()
       update() {}
     }

     it('marks the handler with metadata', () => {
       const reflector = new Reflector();
       const flag = reflector.get(REQUIRES_IF_MATCH_KEY, Controller.prototype.update);
       expect(flag).toBe(true);
     });

     it('guard toggles req._requiresIfMatch when annotated', () => {
       const reflector = new Reflector();
       const guard = new RequiresIfMatchGuard(reflector);
       const req: any = { headers: {} };
       const ctx: any = {
         getHandler: () => Controller.prototype.update,
         getClass: () => Controller,
         switchToHttp: () => ({ getRequest: () => req }),
       };
       expect(guard.canActivate(ctx)).toBe(true);
       expect(req._requiresIfMatch).toBe(true);
     });
   });
   ```

2. Verify failure.

   ```bash
   pnpm test:unit --filter @arcaai/api -- requiresIfMatch
   # Expected: 2 failing
   ```

#### Task D.2.4 — Implement `@RequiresIfMatch()` + companion guard

**Agent**: `api-designer`

**Files**:
- Create: `apps/api/src/decorators/requiresIfMatch.decorator.ts`
- Create: `apps/api/src/decorators/requiresIfMatch.guard.ts`
- Modify: `apps/api/src/decorators/index.ts`
- Modify: `apps/api/src/app.module.ts` (register the guard globally)

**Steps**:

1. Implement decorator + guard.

   ```typescript
   // apps/api/src/decorators/requiresIfMatch.decorator.ts
   import { SetMetadata } from '@nestjs/common';

   export const REQUIRES_IF_MATCH_KEY = 'requiresIfMatch';

   /**
    * Marks the handler as requiring the `If-Match` header. When the header is
    * missing the response is `428 Precondition Required` (RFC 6585), not 400.
    *
    * Pair with `@ExpectedVersion()` on a handler parameter to receive the parsed
    * value. Service-to-service callers may pass `expectedVersion` in the body
    * as a fallback (handled at the service layer).
    *
    * @see TASK-302 Stream D Phase D
    */
   export const RequiresIfMatch = (): MethodDecorator => SetMetadata(REQUIRES_IF_MATCH_KEY, true);
   ```

   ```typescript
   // apps/api/src/decorators/requiresIfMatch.guard.ts
   import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
   import { Reflector } from '@nestjs/core';
   import { REQUIRES_IF_MATCH_KEY } from './requiresIfMatch.decorator';

   @Injectable()
   export class RequiresIfMatchGuard implements CanActivate {
     constructor(private readonly reflector: Reflector) {}

     canActivate(context: ExecutionContext): boolean {
       const annotated = this.reflector.getAllAndOverride<boolean>(REQUIRES_IF_MATCH_KEY, [
         context.getHandler(),
         context.getClass(),
       ]);
       if (annotated) {
         const req: any = context.switchToHttp().getRequest();
         req._requiresIfMatch = true;
       }
       return true; // always proceed; the param decorator does the throwing
     }
   }
   ```

   ```typescript
   // apps/api/src/decorators/index.ts (append)
   export * from './expectedVersion.decorator';
   export * from './requiresIfMatch.decorator';
   export * from './requiresIfMatch.guard';
   ```

2. Register the guard globally in `app.module.ts`:

   ```typescript
   // apps/api/src/app.module.ts (providers array, append)
   { provide: APP_GUARD, useClass: RequiresIfMatchGuard },
   ```

3. Verify the two unit tests pass.

   ```bash
   pnpm test:unit --filter @arcaai/api -- requiresIfMatch
   # Expected: 2 passing
   ```

4. Commit.

   ```bash
   git add apps/api/src/decorators apps/api/src/app.module.ts
   git commit -m "feat(api): @RequiresIfMatch decorator + @ExpectedVersion param (TASK-302 Stream D Phase D)"
   ```

### Section D.3 — Apply to `PATCH /tenants/me/config` and `PATCH /global-settings/:id`

#### Task D.3.1 — Failing e2e: PATCH without `If-Match` returns 428

**Agent**: `tester`

**Files**:
- Modify: `apps/api/tests/e2e/optimistic-locking.spec.ts` (append a new test)

**Steps**:

1. Add the test.

   ```typescript
   test('PATCH /tenants/me/config without If-Match returns 428', async ({ request }) => {
     const res = await request.patch('/api/v1/tenant/me/config', {
       headers: { Authorization: `Bearer ${adminToken}` },
       data: [{ id: 'whatever', value: 'x', expectedVersion: 1 }],
     });
     expect(res.status()).toBe(428);
   });
   ```

2. Verify it fails (today the route accepts the body-field expectedVersion silently).

#### Task D.3.2 — Apply `@RequiresIfMatch()` and accept header fallback in the controller

**Agent**: `api-designer`

**Files**:
- Modify: `apps/api/src/modules/tenant/my-tenant.controller.ts`

**Steps**:

1. Update the controller. The header takes precedence; if absent and `@RequiresIfMatch()` is set, the 428 fires from `@ExpectedVersion()`. The decorator value is folded into each row's `expectedVersion` (so the body-field path keeps working for service-to-service callers, and a header-equipped browser caller doesn't need to send it in every row).

   ```typescript
   // apps/api/src/modules/tenant/my-tenant.controller.ts (excerpt)
   import { ExpectedVersion, RequiresIfMatch } from '../../decorators';

   @Patch('me/config')
   @RequiresIfMatch()
   @ApiOperation({ summary: 'Update current tenant configuration' })
   @ApiResponse({ status: 200, description: 'Updated', type: PaginatedTenantConfigResponse })
   @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again.' })
   @ApiResponse({ status: 428, description: 'If-Match header is required.' })
   async updateMyConfig(
     @Body() configs: UpdateTenantConfigRequest[],
     @ExpectedVersion() expectedFromHeader: number | undefined,
   ): Promise<PaginatedTenantConfigResponse> {
     const tenantId = this.resolveTenantId();
     const effectiveConfigs = expectedFromHeader !== undefined
       ? configs.map((c) => ({ ...c, expectedVersion: expectedFromHeader }))
       : configs;
     const result = await this.tenantService.updateTenantConfigs(tenantId, effectiveConfigs);
     return GlobalSettingDtoMapper.ToPaginatedResponse(result) as PaginatedTenantConfigResponse;
   }
   ```

   > **Note.** When `PATCH /tenants/me/config` is a bulk update, the SDK should send `If-Match: "<min(versions)>"` (most conservative) and include per-row `expectedVersion` in the body so the server can do per-row CAS. If the client only sends the header, the server applies the same `expectedVersion` to every row — fine for single-row updates.

2. Run the e2e from D.3.1.

   ```bash
   pnpm test:e2e -- optimistic-locking
   # Expected: PATCH without If-Match returns 428.
   ```

#### Task D.3.3 — Apply to `PATCH /global-settings/:id`

**Agent**: `api-designer`

**Files**: same pattern; controller at `apps/api/src/modules/globalSetting/globalSetting.controller.ts` (create if absent — the service is dormant per TASK-301 §P1-1; if it's still dormant, skip until TASK-302 Phase 1 Item 9 decides "complete or delete").

**Steps**:

1. If the controller exists, mirror D.3.2 on the `PATCH /:id` handler.
2. If the controller does not exist, document in the plan README that this task is **deferred** until Phase 1 Item 9 lands. Do not block the rest of Phase D.

3. Commit.

   ```bash
   git add apps/api/src/modules/tenant/my-tenant.controller.ts apps/api/tests/e2e/optimistic-locking.spec.ts
   git commit -m "feat(api): @RequiresIfMatch on PATCH /tenants/me/config (TASK-302 Stream D Phase D)"
   ```

### Section D.4 — SDK `ConfigManager` captures `ETag`, replays `If-Match`

#### Task D.4.1 — Failing SDK test: GET captures `ETag`

**Agent**: `tester`

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/__tests__/useTenantConfig.etag.test.ts`

**Steps**:

1. Mock the underlying `AgenticClient.get` to return a `Headers`-bearing response stub; assert the hook stashes the version.

   ```typescript
   // packages/agentic-sdk-v2/src/hooks/__tests__/useTenantConfig.etag.test.ts
   import { describe, it, expect, vi } from 'vitest';
   import { renderHook, act } from '@testing-library/react';
   import { useTenantConfigVersion } from '../useTenantConfigVersion';

   describe('useTenantConfigVersion (TASK-302 Stream D Phase D)', () => {
     it('captures the version from a GET response with ETag: "7"', async () => {
       // ... wrap renderHook in a test AgenticProvider with a mock client
       //     whose .get() returns { id: 'gs-1', version: 7 } and exposes
       //     response.headers.get('ETag') === '"7"' ...
       const { result } = renderHook(() => useTenantConfigVersion('gs-1'));
       await act(async () => {
         await result.current.refresh();
       });
       expect(result.current.version).toBe(7);
     });
   });
   ```

2. Verify failure.

#### Task D.4.2 — Add an `ETag`-aware `get` helper to `AgenticClient`

**Agent**: `api-designer`

**Files**:
- Modify: `packages/agentic-sdk-v2/src/core/AgenticClient.ts`

**Steps**:

1. Add a sibling method `getWithEtag<T>` that returns `{ body: T; etag: string | undefined }`. The existing `get<T>` stays untouched (backwards compatible).

   ```typescript
   // packages/agentic-sdk-v2/src/core/AgenticClient.ts (excerpt — append next to the existing `get`)
   async getWithEtag<T>(
     endpoint: string,
     options?: { signal?: AbortSignal },
   ): Promise<{ body: T; etag: string | undefined }> {
     const { body, headers } = await this.requestRaw<T>('GET', endpoint, undefined, undefined, options?.signal);
     return { body, etag: headers.get('etag') ?? undefined };
   }
   ```

   `requestRaw` is a thin variant of the private `request` method that returns the `Headers` object alongside the parsed body — extract it from the existing `request` implementation; do not duplicate the auth / retry / rate-limit logic.

2. Add a sibling `patchWithIfMatch<T>(endpoint, body, ifMatch)` that sets the `If-Match` header.

   ```typescript
   async patchWithIfMatch<T>(
     endpoint: string,
     body: unknown,
     ifMatch: string,
     options?: { signal?: AbortSignal },
   ): Promise<T> {
     return this.request<T>('PATCH', endpoint, body, { 'If-Match': ifMatch }, options?.signal);
   }
   ```

   (Today `request` takes a `headers?: Record<string, string>` slot as a 4th parameter; if it doesn't, add it — it's a minimal additive change.)

#### Task D.4.3 — Update `useGlobalSettings.update` to capture+replay ETag

**Agent**: `api-designer`

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useGlobalSettings.ts`
- Modify: `packages/agentic-sdk-v2/src/types/settings.ts` (add `ConfigConflictError` type)

**Steps**:

1. Add the error class.

   ```typescript
   // packages/agentic-sdk-v2/src/types/settings.ts (append)
   export class ConfigConflictError extends Error {
     readonly code = 'CONFIG_CONFLICT';
     constructor(
       public readonly settingId: string,
       public readonly expectedVersion: number,
       public readonly currentVersion: number,
     ) {
       super(
         `Setting ${settingId} was changed by someone else ` +
           `(yourVersion=${expectedVersion}, currentVersion=${currentVersion}). ` +
           `Refresh and try again.`,
       );
     }
   }
   ```

2. Wire the hook to a small per-setting version cache (TanStack-Query-flavoured `onMutate`):

   ```typescript
   // packages/agentic-sdk-v2/src/hooks/useGlobalSettings.ts (excerpt)
   import { ConfigConflictError } from '../types/settings';

   // Module-level cache: settingId -> ETag string ("<n>"). Refreshed on every
   // get; consumed on every update. Keeps the hook stateless across renders
   // so an update following a get always has the latest token.
   const etagCache = new Map<string, string>();

   // ... inside the hook body, replace get():
   const get = useCallback(
     (id: string) =>
       execute<GlobalSetting>('get', async (client) => {
         const { body, etag } = await client.getWithEtag<GlobalSetting>(
           GLOBAL_SETTINGS_ENDPOINTS.ITEM(id),
         );
         if (etag) etagCache.set(id, etag);
         return body;
       }),
     [execute],
   );

   // ... and update():
   const update = useCallback(
     (id: string, input: UpdateGlobalSettingInput) =>
       execute<GlobalSetting>('update', async (client) => {
         const etag = etagCache.get(id);
         if (!etag) {
           throw new Error(`No ETag cached for setting ${id}. Call get() first.`);
         }
         try {
           const result = await client.patchWithIfMatch<GlobalSetting>(
             GLOBAL_SETTINGS_ENDPOINTS.ITEM(id),
             input,
             etag,
           );
           // Refresh cached version from the response.
           if (typeof result.version === 'number') {
             etagCache.set(id, `"${result.version}"`);
           }
           return result;
         } catch (err: any) {
           if (err?.code === 'PERSISTENCE.CONCURRENCY_CONFLICT' || err?.status === 412) {
             const expectedVersion = Number.parseInt(etag.replace(/"/g, ''), 10);
             const currentVersion = err?.metadata?.currentVersion ?? expectedVersion + 1;
             throw new ConfigConflictError(id, expectedVersion, currentVersion);
           }
           throw err;
         }
       }, false /* no auto-retry on 412 */),
     [execute],
   );
   ```

#### Task D.4.4 — Verify SDK unit + e2e tests

**Agent**: `tester`

**Steps**:

1. Run unit:

   ```bash
   pnpm test --filter @arcaai/vox
   # Expected: 0 regressions; new useTenantConfigVersion / useGlobalSettings tests passing.
   ```

2. Run the playground sandbox manually with two browser tabs editing the same setting and confirm the second tab gets `ConfigConflictError` (not a silent overwrite).

#### Task D.4.5 — Commit + release-note draft

**Agent**: `git-manager`

**Steps**:

1. Commit.

   ```bash
   git add packages/agentic-sdk-v2/src
   git commit -m "feat(vox): ETag capture + If-Match replay on global settings (TASK-302 Stream D Phase D)"
   ```

2. Draft a CHANGELOG entry. **Mandatory bullet**: "Requires API ≥ commit X (TASK-302 Stream D Phase D); UI consumers must update SDK before deploying the conflict modal."

### Section D.5 — UI conflict modal stub

#### Task D.5.1 — Failing UI test: `ConfigConflictError` triggers a modal

**Agent**: `tester`

**Files**:
- Create: `apps/ui-playground/src/features/admin/configurations/__tests__/conflict-modal.test.tsx`

**Steps**:

1. Mount the configurations page, mock `useGlobalSettings.update` to throw `ConfigConflictError`, assert the modal renders with the expected copy.

   ```tsx
   // apps/ui-playground/src/features/admin/configurations/__tests__/conflict-modal.test.tsx
   import { describe, it, expect, vi } from 'vitest';
   import { render, screen, fireEvent } from '@testing-library/react';
   import { ConfigConflictModal } from '../conflict-modal';
   import { ConfigConflictError } from '@arcaai/vox';

   describe('ConfigConflictModal (TASK-302 Stream D Phase D)', () => {
     it('shows the conflict copy with the latest version', () => {
       const err = new ConfigConflictError('gs-1', 7, 8);
       render(<ConfigConflictModal error={err} onRefresh={() => {}} onDismiss={() => {}} />);
       expect(screen.getByText(/changed by someone else/i)).toBeTruthy();
       expect(screen.getByText(/refresh/i)).toBeTruthy();
     });

     it('calls onRefresh when "Refresh and try again" is clicked', () => {
       const err = new ConfigConflictError('gs-1', 7, 8);
       const onRefresh = vi.fn();
       render(<ConfigConflictModal error={err} onRefresh={onRefresh} onDismiss={() => {}} />);
       fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
       expect(onRefresh).toHaveBeenCalled();
     });
   });
   ```

#### Task D.5.2 — Implement `ConfigConflictModal` stub

**Agent**: `ui-ux-designer`

**Files**:
- Create: `apps/ui-playground/src/features/admin/configurations/conflict-modal.tsx`

**Steps**:

1. Implement using the project's existing `Dialog` primitive from `@arcaai/ui`. The stub renders a refresh CTA and a dismiss. Diff-from-history is **out of scope** here (lands when TASK-3XX-Global-Setting-History adds the table).

   ```tsx
   // apps/ui-playground/src/features/admin/configurations/conflict-modal.tsx
   import { Dialog, DialogTitle, DialogDescription, DialogActions, Button } from '@arcaai/ui';
   import type { ConfigConflictError } from '@arcaai/vox';

   export interface ConfigConflictModalProps {
     error: ConfigConflictError;
     onRefresh: () => void;
     onDismiss: () => void;
   }

   /**
    * TASK-302 Stream D Phase D — stub conflict modal.
    *
    * Long-term UX (future TASK-3XX-Global-Setting-History): show a 3-way diff
    * of "Your value | Current value | Their change at t=...". Until that table
    * lands the user can only Refresh-to-see-latest or Dismiss.
    */
   export function ConfigConflictModal({ error, onRefresh, onDismiss }: ConfigConflictModalProps) {
     return (
       <Dialog open onOpenChange={onDismiss}>
         <DialogTitle>This setting was changed by someone else</DialogTitle>
         <DialogDescription>
           You were editing version {error.expectedVersion}, but the current version is {error.currentVersion}.
           Refresh to see the latest value before re-applying your change.
         </DialogDescription>
         <DialogActions>
           <Button variant="ghost" onClick={onDismiss}>Cancel</Button>
           <Button variant="default" onClick={onRefresh}>Refresh and try again</Button>
         </DialogActions>
       </Dialog>
     );
   }
   ```

#### Task D.5.3 — Wire the modal into the configurations page

**Agent**: `ui-ux-designer`

**Files**:
- Modify: `apps/ui-playground/src/features/admin/configurations/configurations-page.tsx` (or the canonical settings editor file)

**Steps**:

1. Wrap the save handler:

   ```tsx
   // apps/ui-playground/src/features/admin/configurations/configurations-page.tsx (excerpt)
   const [conflictErr, setConflictErr] = useState<ConfigConflictError | null>(null);

   const handleSave = async (id: string, input: UpdateGlobalSettingInput) => {
     try {
       await update(id, input);
     } catch (err) {
       if (err instanceof ConfigConflictError) {
         setConflictErr(err);
         return;
       }
       throw err;
     }
   };

   // ...

   {conflictErr && (
     <ConfigConflictModal
       error={conflictErr}
       onRefresh={async () => { await get(conflictErr.settingId); setConflictErr(null); }}
       onDismiss={() => setConflictErr(null)}
     />
   )}
   ```

2. Verify tests + manual sanity in `ui-playground`.

3. Commit.

   ```bash
   git add apps/ui-playground/src/features/admin/configurations
   git commit -m "feat(ui-playground): conflict modal stub on config save (TASK-302 Stream D Phase D)"
   ```

### Code Review Gate D

**Agent**: `code-reviewer`

- Verify the strong-validator regex on `If-Match` rejects `W/"..."`.
- Verify `@RequiresIfMatch()` is only on **mutating** routes (`PATCH` / `PUT` / `DELETE`), never on `GET`.
- Verify the SDK CHANGELOG flags the API-version dependency.
- Spot-check Swagger: every `@RequiresIfMatch()`-annotated route documents 412 + 428 responses.
- Confirm the conflict modal is **dismissable** so an admin can still navigate away (vs blocking modal that hostages the page).

---

## Phase E — Roll out to remaining admin-edited entities (~1 week)

**Goal.** Apply the OCC pattern to `Tenant`, `Department`, `PromptTemplate`, `AsrPipeline`, `Webhook`. Skip append-only (`AuditLog`, `Notification`, `*UsageRecord`, `WebhookRunHistory`). Add a Concurrency Model README section to each service. Wire the `optimistic_lock_conflict_total` Prometheus counter.

Each per-model section follows the same 3-task shape:

1. **Mapper** — round-trip `version` on read only (mirrors B.6).
2. **DTO + Service** — add `expectedVersion: number`; switch service `update` to `updateWithVersion`; emit `previousVersion`/`newVersion` in `SysEvent`.
3. **Tests** — Vitest concurrent-write proof + Playwright (or HTTP) regression.

### Section E.1 — Tenant (3 tasks)

**Agent (lead)**: `database-admin`; **Tests**: `tester`; **Review**: `code-reviewer`

| # | File | Change |
|---|---|---|
| E.1.1 | `packages/domains/src/mappers/generated/core/TenantEntityMapper.ts` | Add `$toPersistence.version: () => undefined` + `$toDomain.version: (r) => r.version` |
| E.1.2 | `packages/applications/src/services/tenant/dto/updateTenant.request.ts` | Add `@IsInt() @Min(1) expectedVersion!: number` |
| E.1.2 | `packages/applications/src/services/tenant/tenant.service.ts` | `update()` switches `tenantRepository.update(id, tenant)` → `tenantRepository.updateWithVersion(id, tenant, request.expectedVersion)`; SysEvent gains `previousVersion`/`newVersion` |
| E.1.3 | `packages/applications/src/services/tenant/__tests__/tenant.service.test.ts` | Add the 412-path concurrent test (mirror C.2) |
| E.1.3 | `apps/api/tests/e2e/tenants.spec.ts` | Add an `@If-Match`-equipped PATCH test |

**Commit**: `feat(applications): OCC on TenantService.update (TASK-302 Stream D Phase E.1)`

### Section E.2 — Department (3 tasks)

**Agent (lead)**: `database-admin`

| File | Change |
|---|---|
| `packages/domains/src/mappers/generated/core/DepartmentEntityMapper.ts` | Mapper handler |
| `packages/applications/src/services/department/dto/updateDepartment.request.ts` | DTO field |
| `packages/applications/src/services/department/department.service.ts` | `updateWithVersion` swap + SysEvent |
| `packages/applications/src/services/department/__tests__/department.service.test.ts` | Concurrent test |

**Commit**: `feat(applications): OCC on DepartmentService.update (TASK-302 Stream D Phase E.2)`

### Section E.3 — PromptTemplate (3 tasks)

**Agent (lead)**: `database-admin`

> **Note.** `PromptTemplate` has its own version-history sibling table (`PromptVersion`). The `_version` column on `PromptTemplate` row is the OCC token; `PromptVersion` is the human-meaningful version history (separate concept). Do not conflate.

Same shape as E.1 / E.2. Commit: `feat(applications): OCC on PromptTemplateService.update (TASK-302 Stream D Phase E.3)`

### Section E.4 — AsrPipeline (3 tasks)

**Agent (lead)**: `database-admin`

Same shape. Commit: `feat(applications): OCC on AsrPipelineService.update (TASK-302 Stream D Phase E.4)`

### Section E.5 — Webhook (3 tasks)

**Agent (lead)**: `database-admin`

> **Note.** `Webhook` is admin-edited; `WebhookRunHistory` is append-only and stays untouched.

Same shape. Commit: `feat(applications): OCC on WebhookService.update (TASK-302 Stream D Phase E.5)`

### Section E.6 — Observability: `optimistic_lock_conflict_total` metric

**Agent**: `api-designer`

**Files**:
- Modify: `apps/api/src/interceptors/exception.interceptor.ts` (emit the counter when mapping 412)
- Modify: `apps/api/src/observability/metrics.ts` (or wherever Prometheus metrics live)
- Create: `infrastructure/grafana/dashboards/optimistic-locking.json` (panel showing rate of 412 per model per route)

**Steps**:

1. Define the counter (Prometheus `Counter` from `prom-client`):

   ```typescript
   // apps/api/src/observability/metrics.ts (excerpt — append)
   import { Counter } from 'prom-client';

   export const optimisticLockConflictTotal = new Counter({
     name: 'optimistic_lock_conflict_total',
     help: 'Number of 412 responses caused by optimistic concurrency conflicts.',
     labelNames: ['model', 'route'] as const,
   });
   ```

2. Emit it from `ExceptionInterceptor` inside the `OptimisticConcurrencyException` branch (immediately before the `throwError(... 412 ...)`):

   ```typescript
   import { optimisticLockConflictTotal } from '../observability/metrics';
   // ...
   optimisticLockConflictTotal.labels(
     /* model */ (err.metadata as any)?.model ?? 'unknown',
     /* route */ `${request.method} ${request.route?.path ?? request.url}`,
   ).inc();
   ```

   > The exception already carries the model name (first constructor arg). Surface it through `metadata.model` when constructing the exception in `Repository.updateWithVersion` (add a one-line tweak: pass `this._modelName` into the metadata, so the metric can label by model).

3. Drop a Grafana panel: rate of `optimistic_lock_conflict_total` per model per route. Set an alert at `> 0.5 % of PATCHes` (per Research §6 Phase E).

4. Verify locally by hitting a 412 and `curl localhost:8868/metrics | grep optimistic_lock_conflict`.

5. Commit.

   ```bash
   git add apps/api/src/observability apps/api/src/interceptors infrastructure/grafana/dashboards
   git commit -m "feat(observability): optimistic_lock_conflict_total metric + Grafana panel (TASK-302 Stream D Phase E.6)"
   ```

### Section E.7 — Per-service "Concurrency Model" README section

**Agent**: `docs-manager`

**Files**:
- Modify: each touched service's `README.md` (`packages/applications/src/services/{tenant,globalSetting,department,promptTemplate,asrPipeline,webhook}/README.md` — create if absent).

**Steps**:

1. Append a section to each README using this template:

   ```markdown
   ## Concurrency Model

   This service uses **optimistic concurrency control** (TASK-302 Stream D). Every
   write to a row's mutable fields goes through `updateWithVersion(id, entity,
   expectedVersion)` on the repository, which issues a Postgres CAS via
   `prisma.<model>.updateMany({ where: { id, version: expectedVersion }, data:
   { ..., version: { increment: 1 } } })`.

   ### Inbound contract

   - **HTTP**: clients must send `If-Match: "<n>"` (RFC 7232) on PATCH. The
     response carries `ETag: "<n+1>"`. Missing `If-Match` → 428; drifted version
     → 412 with `{ currentVersion }`.
   - **Service-to-service / Bull jobs**: pass `expectedVersion` in the request
     body (DTO field). Wrap in `pRetry({ retries: 3, factor: 2 })` with a
     re-fetch between attempts. **Never auto-retry human writes.**

   ### Bulk writes

   The whole batch is atomic. Any single 412 rolls every row back; the caller
   re-fetches all rows before re-submitting.

   ### Out of scope

   - Append-only siblings (`*UsageRecord`, `*RunHistory`, `AuditLog`, `Notification`)
     are not version-guarded — they are write-once.
   - Soft-delete bumps `_version` automatically; calls that race a soft-delete
     get a 412 (correct — resurrection is prevented).

   ### Observability

   `optimistic_lock_conflict_total{model="<ModelName>", route="<method path>"}`
   on the `/metrics` endpoint. Alert threshold: > 0.5 % of PATCHes.

   ### References

   - [TASK-302 Stream D plan](../../../../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/04-optimistic-locking.md)
   - [Research doc](../../../../../research/architecture/system-config-multi-tenancy/04-optimistic-locking.md)
   ```

2. Commit per service.

### Final Code Review Gate

**Agent**: `code-reviewer` (sign-off) + `tester` (sign-off)

**Checklist**:

- [ ] All five admin-edited models migrated (E.1–E.5).
- [ ] All five services have the Concurrency Model README section (E.7).
- [ ] Grafana panel showing `optimistic_lock_conflict_total` is live in staging.
- [ ] No new mutation of `_version` exists outside `Repository.updateWithVersion` and the soft-delete bump (`grep -r "version:" packages/domains/src/common/repository.ts` shows only the two known sites; `grep -r "_version" packages/database/seed` shows only `@default(1)`).
- [ ] Phase A's `optimisticLockingEvidence.test.ts` is deleted **or** rewritten to assert the post-fix behaviour (one wins, one 412s) — keep one of the two, not both.
- [ ] The Postgres regression test (B.4) runs in the integration-test CI job; CI passes.
- [ ] SDK CHANGELOG and the API release note both document the wire-format change.
- [ ] Cross-stream coordination with Stream B Phase 4 schema migration is confirmed (see Cross-stream Dependencies).
- [ ] All affected packages build cleanly:

  ```bash
  pnpm build --filter @arcaai/exceptions --filter @arcaai/domains \
             --filter @arcaai/applications --filter @arcaai/api \
             --filter @arcaai/vox
  # Expected: 5 packages built, 0 errors
  ```

- [ ] Lint and unit suites pass:

  ```bash
  pnpm lint
  pnpm test:unit
  # Expected: 0 errors, 0 failures
  ```

---

## Appendix A — Why optimistic (vs pessimistic / triggers / CRDT)

| Approach | Why rejected | Reference |
|---|---|---|
| **Pessimistic (`SELECT … FOR UPDATE`)** | Holds a row lock across the admin-UI round-trip (hundreds of ms to seconds). HOPE pods talk to Postgres through a transaction-mode pooler — `FOR UPDATE` is incompatible without switching to session-mode pooling (Decision #5 in TASK-301 — deferred). Sweet spot is short, provably-contended hot paths (none today). | Research §2 |
| **Postgres advisory locks (`pg_advisory_xact_lock`)** | Same round-trip-holding / session-mode-pooling problem as `FOR UPDATE`. | Research §8 |
| **DB triggers enforcing `version = OLD.version + 1`** | Hides the check from application logs; breaks Prisma's return-value expectations; debugging a 412 becomes "SSH into the primary". The migration plan in this document is the alternative. | Research §8 |
| **JSON Patch with `test` op (RFC 6902)** | Elegant for fine-grained edits; free per-field OCC. Rejected because (a) our PATCH bodies are partial objects, (b) the SDK is Zustand-flat, (c) rolling out a new wire format is far more disruptive than adding `If-Match`. Revisit only if a collaborative editor ships. | Research §8 |
| **CRDT / conflict-free merge** | Wrong tool — we *want* conflicts visible and human-resolved, not silently merged. Research §1 scenarios 1–3 are exactly the cases where silent merge would be a HIPAA / SOC2 finding. | Research §8 |
| **Last-write-wins + audit log (today's state)** | Cheap, shipped, acceptable for low-stakes settings. Unacceptable for `smr-provider-models`, JWT rotation, or any flag gating PHI processing. This plan replaces it. | Research §8 |

The conclusion in Research §9: "Optimistic is the default. Pessimistic earns its place only in short, provably-contended hot paths (none today)."

---

## Appendix B — Edge cases

| Edge case | Handling | Where in this plan |
|---|---|---|
| Bulk `updateTenantConfigs` partial success | `$transaction` makes the whole batch atomic; any 412 rolls every row back; the caller re-fetches all rows before re-submitting. | C.4 |
| Soft-delete race | `softDelete` bumps `_version`; a `updateWithVersion(7)` after another admin soft-deleted at v7 → finds v8, returns 412, correctly prevents resurrection. | B.8 |
| Audit-log correlation | `SysEvent.ResourceUpdated` payload carries `previousVersion` + `newVersion`. Investigators reconstruct history via `metadata->>'newVersion'`. | C.8 |
| `updatedAt` collisions under load | We do not use `updatedAt` for OCC. Postgres microsecond timestamps collide under burst writes; the monotonic integer `_version` is robust. | Decision Log #2 |
| Existing data needs back-fill | No — every row has `version = 1` from `@default(1)`. Zero migration SQL. | Decision Log #11 |
| Lagging read replica → every save 412 | Pin admin reads to the primary. Documented in the per-service Concurrency Model README. | E.7 |
| Service-to-service caller can't carry `If-Match` (no HTTP layer) | The body-field `expectedVersion` is the canonical fallback. `updateWithVersion` is layer-agnostic. | C.1, D.4 |
| Machine writes (Bull jobs) racing admin edits | `pRetry({ retries: 3, factor: 2 })` with re-fetch + re-apply between attempts. Human writes never auto-retry. | Decision Log #7 |
| Caller's `_version` overflows Int32 | Not a concern at human-write rates (would take ~2 billion edits per row). Noted for completeness. | Risk table |

---

## Appendix C — Future: `GlobalSettingHistory` table integration

When `TASK-3XX-Global-Setting-History` lands (TASK-301 §B.7), the conflict modal can upgrade from "Refresh to see latest" (Phase D.5 stub) to a 3-way diff: "your draft | current | the change that won at t=…". The contract is:

- `GlobalSettingHistory` table: `(id, globalSettingId, version, value, changedBy, changedAt)`. Append-only.
- Populated by a Prisma extension that fires on every `updateWithVersion` and `softDelete` (so the history reflects state changes, not just value edits).
- The 412 response body grows a `historyUrl` field pointing at `/api/v1/global-settings/:id/history?since=<expectedVersion>`. The modal fetches that and renders the diff.

No schema or contract change is required from Phase D — the modal opportunistically renders a diff if `historyUrl` is present, falling back to the Refresh CTA otherwise.

---

## References

- **RFC 7232** — *HTTP/1.1 Conditional Requests* (§3.1 `If-Match`, §4.2 `412`, §2.3.2 strong comparison). <https://www.rfc-editor.org/rfc/rfc7232.html>
- **RFC 6585** — *Additional HTTP Status Codes* (`428 Precondition Required`). <https://www.rfc-editor.org/rfc/rfc6585.html>
- **RFC 6902** — *JavaScript Object Notation (JSON) Patch* (`test` op alternative). <https://www.rfc-editor.org/rfc/rfc6902.html>
- **Prisma — Transactions guide, "Optimistic concurrency control"** (2025 revision). <https://www.prisma.io/docs/orm/prisma-client/queries/transactions>
- **Prisma #10207** — *MySQL: OCC doesn't work with UpdateMany*. <https://github.com/prisma/prisma/issues/10207>
- **Prisma #28840** — *updateMany on MySQL drops predicates* (2025). <https://github.com/prisma/prisma/issues/28840>
- **Martin Fowler — *Optimistic Offline Lock*** (PoEAA, 2003).
- **Hibernate ORM 6 — Versioning and optimistic locking**. <https://docs.jboss.org/hibernate/orm/6.6/userguide/html_single/Hibernate_User_Guide.html#locking>
- **SQLAlchemy 2.0 — Versioning Objects**. <https://docs.sqlalchemy.org/en/20/orm/versioning.html>
- **Ed-Fi Alliance — Handling Optimistic Concurrency with ETags** (2024). <https://docs.ed-fi.org/reference/data-exchange/api-guidelines/design-and-implementation-guidelines/api-implementation-guidelines/handling-optimistic-concurrency-with-etags/>
- **Google Cloud Healthcare API — FHIR resource versioning and `If-Match`**. <https://cloud.google.com/healthcare-api/docs/concepts/fhir>
- **NestJS interceptors**. <https://docs.nestjs.com/interceptors>
- **OneUptime — Implement Optimistic Locking with Prisma in Node.js** (2026-01-25). <https://oneuptime.com/blog/post/2026-01-25-optimistic-locking-prisma-nodejs/view>
- **OneUptime — Implement API ETag Headers** (2026-01-30). <https://oneuptime.com/blog/post/2026-01-30-api-etag-headers/view>
- **TASK-301 §P2 finding "missing optimistic locking"** — [`docs/implementation/TASK-301-System-Config-Multi-Tenancy-Assessment/README.md`](../TASK-301-System-Config-Multi-Tenancy-Assessment/README.md)
- **Source research** — [`research/architecture/system-config-multi-tenancy/04-optimistic-locking.md`](../../../research/architecture/system-config-multi-tenancy/04-optimistic-locking.md)

---

## Execution handoff

This plan is ready to execute via the `executing-plans` skill: fresh subagent per task, mandatory code-review gate between phases, per-task TDD steps (failing test → verify failure → implement → verify pass → commit).

**Recommended sequencing for two engineers in parallel:**

- Eng 1: Phase A → Phase B → Phase D.1–D.3 (HTTP) → Phase E.6 (metric) → Final gate
- Eng 2: starts when Phase B Code Review Gate closes → Phase C → Phase D.4–D.5 (SDK + UI) → Phase E.1–E.5 (per-model rollout, one-at-a-time) → Phase E.7 (READMEs)

Both engineers converge at the Final Code Review Gate. Total elapsed: ~2–3 calendar weeks.

> **Reminder on Cross-stream sequencing.** The API portion of Phase D (D.1–D.3) must reach production **before** any UI release wires the conflict modal, and **before** any SDK consumer adds `If-Match` capture. Stream B Phase 4 schema migration (additive `encryptedValue` / `keyVersion` columns on `GlobalSetting`) lands independently — coordinate the same-PR-window only if both happen to ship in the same week.
