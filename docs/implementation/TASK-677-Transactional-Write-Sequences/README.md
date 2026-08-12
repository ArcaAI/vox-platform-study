# TASK-677 — Transactional write sequences

| Field | Value |
|---|---|
| Status | **Review** |
| Type | `refactor` (cross-cutting repository contract) + `bugfix` (TASK-663 OI-2) |
| Base commit | `dev-2.1` @ `62cb2d174` |
| Closes | TASK-663 **OI-2** |
| Migration | **None** |

## 1. Requirement Analysis

TASK-663 (agent promotion) records in its open item **OI-2** that the promotion write
sequence is **not transactional**:

> The write sequence — target agent → target version → promotion record — is **not** wrapped in a
> transaction. `Repository.update` takes no `tx` parameter (only `create` does), so a
> create-**or**-update path cannot be wrapped without a cross-cutting repository change that is out
> of this ticket's scope.

Its mitigation — order the writes so the audit row lands last, so a mid-sequence failure never
records a promotion that did not complete — is sound but is not a fix. A failure between the agent
write and the promotion write still leaves a **partially-promoted agent**: the target tenant's agent
has been advanced to the source's configuration, the deep-copied prompt templates exist, and there is
no `AgentPromotion` row saying so.

This ticket closes the gap at its root.

### Scope (deliberately narrow)

1. Add an **optional `tx` parameter to `Repository.update`**, mirroring exactly how `create` already
   accepts one. Additive and backward compatible — every existing caller keeps compiling and
   behaving identically with no change at the call site.
2. Use it in the promotion write sequence so the cloned agent, its deep-copied prompt templates, its
   version row and the `AgentPromotion` audit record commit **atomically**.
3. Audit the rest of the repository contract for the same gap and **report** it — fix nothing beyond
   `update` here.

### Out of scope

- `packages/applications/src/services/departmentAgent/**` and `harness-policy/**` — owned by
  TASK-678 in a parallel worktree.
- `apps/harness/**`, `packages/agentic-sdk-v2/**`, `apps/admin-console/**`.
- Any Prisma migration.

## 2. Current State Evaluation

`packages/domains/src/common/repository.ts` — which methods accept a transaction client today:

| Method | `tx`? | Notes |
|---|---|---|
| `create(entity, tx?)` | ✅ | The precedent. `tx ? tx[modelName] : this.db` |
| `createMany(entities, skipDuplicates?, tx?)` | ✅ | Same shape |
| `updateWithVersion(id, entity, expectedVersion, tx?)` | ✅ | **Already has it** — the CAS predicate, the disambiguating re-read and the success re-read all route through `tx` |
| `update(id, entity)` | ❌ | **The gap this ticket closes** |
| `delete(id)` | ❌ | Reported, not fixed (§6) |
| `softDelete(id, updatedBy?)` | ❌ | Reported, not fixed (§6) |
| `restore(id, updatedBy?)` | ❌ | Reported, not fixed (§6) |
| `findById` / `findFirst` / `findAll` / `count` | ❌ | Reads. `findByIdInContext` is the private tx-aware variant used by the CAS path only |

**`updateWithVersion` does NOT have the same gap** — it already takes `tx` (added for
`TenantService.updateTenantConfigs`). It is therefore **not touched by this ticket**, which is also
the safest possible answer to the hard constraint that OCC semantics must not change.

### Why the CLS propagation in `runInTransaction` is not enough on its own

`CoreUnitOfWorkService.runInTransaction` publishes the `tx` client on CLS under
`coreTransactionClient`, and `getDatabaseService()` reads it. But `Repository` resolves and
**caches** its database context in its **constructor** (`this._databaseContext =
this._unitOfWorkService.getDatabaseService()`), and repositories are NestJS singletons constructed at
boot. So an already-constructed repository never observes the CLS tx. An explicit `tx` parameter is
the only mechanism that actually works — which is exactly why `create` has one.

### The promotion write sequence today (`agentPromotion.service.ts#promote`)

```
7. copy    → materializeBindings()  → promptTemplateRepository.create   (×0–5)
                                    → promptVersionRepository.create    (×0–5)
           → agentRepository.create (new)  OR  agentRepository.update (existing)  ← no tx possible
           → agentVersionRepository.create
8. record  → promotionRepository.create
           → broadcastSysEvent(ResourceCreated)
9. eval    → evalRunService.runGoldenSet(...)          (external, long-running)
           → promotionRepository.update(id, entity)     (writes evalRunId)
```

Steps 7–8 are one logical unit and must be atomic. Step 9 must **stay outside**: it is an external
eval run, and holding a Postgres transaction open across it would be a much worse defect than the one
being fixed. TASK-663 D-7 already establishes that the eval runs after the copy and never blocks.

## 3. Implementation Plan

| # | Change | File |
|---|---|---|
| P-1 | `update(id, entity, tx?)` — `const delegate = tx ? tx[this._modelName] : this.db` | `packages/domains/src/common/repository.ts` |
| P-2 | Inject `CoreUnitOfWorkService` (the **domains** one) into `AgentPromotionService` | `packages/applications/src/services/agentPromotion/agentPromotion.service.ts` |
| P-3 | Wrap steps 7–8 in `runInTransaction`, threading `tx` into every write | same |
| P-4 | Move `broadcastSysEvent` to **after** the commit | same |
| P-5 | Leave the eval and its `promotionRepository.update` outside the transaction, `tx`-free | same |

`IRepository.update` is deliberately **left alone**: `IRepository.create` does not declare `tx`
either, and a class method may take more optional parameters than its interface declares. Mirroring
`create` exactly means not touching the interface.

### TDD list (RED first)

| T | Assertion | Suite |
|---|---|---|
| T-1 | `update(id, entity)` with no `tx` uses the cached extended client — unchanged | domains |
| T-2 | `update(id, entity, tx)` routes through `tx[modelName]` and never touches the cached client | domains |
| T-3 | `updateWithVersion` throws `OptimisticConcurrencyException` on drift **both** inside and outside a transaction | domains |
| T-4 | A mid-sequence failure in promotion rolls back everything — no orphan `AgentPromotion`, no half-cloned agent | applications |
| T-5 | A successful promotion issues **every** write of the sequence through the **same** `tx` | applications |
| T-6 | The post-eval `promotionRepository.update` is still called with **two** arguments (backward compatibility at a real call site) | applications |

## 4. Implementation Summary

Six files, three staged commits.

| File | Change |
|---|---|
| `packages/domains/src/common/repository.ts` | `update(id, entity, tx?)` — the one production change to the base class |
| `packages/domains/src/common/__tests__/update.transaction.task677.test.ts` | **new** — 10 tests |
| `packages/applications/src/services/agentPromotion/agentPromotion.service.ts` | write sequence wrapped in `runInTransaction`; `CoreUnitOfWorkService` injected |
| `packages/applications/src/services/agentPromotion/__tests__/agentPromotion.transaction.task677.test.ts` | **new** — 14 tests |
| `packages/applications/src/services/agentPromotion/__tests__/agentPromotion.service.test.ts` | fixture only: the new constructor dependency |
| `docs/implementation/TASK-677-…/README.md` | this document |

### 4.1 The signature change

```ts
public async update(id: EntityId, entity: DomainEntity, tx?: Prisma.TransactionClient | any): Promise<DomainEntity> {
  const changes = this._mapper.toPersistenceChanges(entity);
  const delegate = tx ? (tx as Record<string, any>)[this._modelName] : this.db;

  const model = await delegate.update({ where: { id }, data: changes, include: this._includes });
  return this._mapper.toDomainEntity(model);
}
```

Byte-for-byte the shape `create` has used since it gained `tx`. **Backward compatibility** is
established three ways, not asserted:

1. The parameter is optional, and when absent the delegate resolves to `this.db` — the *identical*
   expression the method used before.
2. Two dedicated regression tests assert the two-argument form still writes through the cached
   extended client, still persists only tracked changes, and never touches a transaction client.
3. Every pre-existing caller is untouched and all suites are green: **8,882** applications tests,
   **1,596** domains tests, **16,779** in `test:unit` — with the same 3 pre-existing failures as the
   baseline, in the same 2 files, neither of them mine.

A live two-argument call site is also asserted *through the service*: the post-eval
`promotionRepository.update(savedPromotion.id, savedPromotion)` is checked to receive exactly two
arguments, so the optional parameter is proven optional at a real call site, not only in a harness.

`IRepository.update` is deliberately unchanged — `IRepository.create` does not declare `tx` either,
and a class method may accept more optional parameters than its interface declares.

### 4.2 OCC is untouched

`updateWithVersion` **already** accepted `tx` before this ticket. It is **not modified** — the safest
possible answer to the constraint. Its contract is nevertheless re-asserted by the new suite in
**both** contexts: drift throws `OptimisticConcurrencyException` inside a transaction and outside
one, the CAS predicate and `version: { increment: 1 }` are byte-identical in both, and the
disambiguating re-read stays inside the transaction when one is supplied. One further test pins the
boundary from the other side: `update` must **not** acquire OCC semantics — no version predicate, no
increment, no `updateMany`.

### 4.3 Why an explicit parameter, not the CLS route

`CoreUnitOfWorkService.runInTransaction` publishes its `tx` on CLS, and `getDatabaseService()` reads
it — which reads as though repositories join a transaction automatically. **They do not.**
`Repository` resolves and caches `_databaseContext` in its **constructor**, and the getter only
re-resolves when that cache is falsy:

```ts
constructor(...) { this._databaseContext = this._unitOfWorkService.getDatabaseService(); }
protected get db() { if (!this._databaseContext) { /* re-resolve */ } … }
```

Repositories are NestJS singletons constructed at boot, when no transaction exists. So the cache is
permanently the extended client and the CLS value is **never** consulted again. This is characterised
by its own test ("a constructed repository NEVER observes a later CLS tx client"), which builds a
unit-of-work whose `getDatabaseService()` *would* return a tx client and proves the write still
escapes to the cached one.

That test is not academic — see §6.1.

### 4.4 What is inside the transaction, and what is deliberately outside

| Write | Inside? | Why |
|---|---|---|
| Deep-copied prompt templates + their v1 rows | ✅ | An orphan copied template is a visible artefact of a promotion that did not happen |
| Target agent — `create` **or** `update` | ✅ | The create-**or**-update path is precisely what OI-2 could not wrap |
| Target `DepartmentAgentVersion` | ✅ | |
| `AgentPromotion` audit record | ✅ | |
| `ResourceCreated` sys-event | ❌ *after commit* | Announcing a promotion that rolled back is the false claim the audit row exists to prevent |
| Eval re-run at the target | ❌ | External, long-running. Holding a Postgres transaction across it would be a worse defect than the one being fixed; D-7 already makes it post-copy and non-blocking |
| `evalRunId` write | ❌ | Follows the eval, by construction |

`writeTargetVersion`'s `findLatestForAgent` read stays on the ordinary client on purpose: the next
version number derives from the target's **committed** history, and nothing written inside this
transaction adds to it.

`materializeBindings` changed from `Promise.all` to sequential awaits. An interactive Prisma
transaction client is a **single connection**, so five concurrent writes through one `tx` are not
safe to issue in parallel. This is a consequence of the change, not an unrelated refactor.

`CoreUnitOfWorkService` is injected **required**, not `@Optional()`. An optional dependency that
resolves to `undefined` would silently degrade to a non-transactional sequence — reintroducing the
exact window this closes, and repeating the TASK-615 trap where an unwired unit-of-work shipped a
dead metered path while its unit tests stayed green. Injection follows the `SellRateCardService`
precedent exactly (bare parameter, `CoreDatabaseModule` already imported by
`AgentPromotionServiceModule`, which provides and exports the class).

### 4.5 Every new test verified by mutation

A green test that never fails verifies nothing. Both suites were seen RED first — domains **4
failed / 5 passed**, applications **8 failed / 6 passed** — and the load-bearing assertions were
then re-broken individually:

| Mutation | Result |
|---|---|
| `agentRepository.update(existing.id, existing, tx)` → drop `tx` | ✅ fails "advances an EXISTING target agent through the tx client" |
| `promotionRepository.create(promotion, tx)` → drop `tx` | ✅ fails "writes the AgentPromotion audit record through the same tx client" |

The rollback tests were specifically hardened against **vacuous** passing. A naive
`expect(committed).toEqual([])` would pass against a service that opens no transaction at all — the
pre-TASK-677 behaviour. Each therefore also asserts that `runInTransaction` was entered exactly once
and that the writes were genuinely attempted *through* `TX`.

## 5. Verification Evidence

Baseline measured on the untouched base commit **before any edit**, in the build order of
execution-plan §1.1b. Both columns are from this worktree, same machine, same session.

| Gate | Baseline @ `62cb2d174` | After | Δ |
|---|---|---|---|
| `@arcaai/database build` | pass | pass | — |
| `@arcaai/database test` | 1177 passed (47 files) | 1177 passed (47 files) | — |
| `@arcaai/domains build` | pass | pass | — |
| `@arcaai/domains test` | 1586 passed \| 2 skipped \| 9 todo (141 files) | **1596** passed \| 2 skipped \| 9 todo (142 files) | **+10** |
| `@arcaai/applications build` | pass | pass | — |
| `@arcaai/applications test` | **8868** passed \| 4 skipped (470 files) | **8882** passed \| 4 skipped (471 files) | **+14** |
| `pnpm api:build` | 10/10 successful | 10/10 successful | — |
| `pnpm test:unit` | 3 failed \| 16755 passed \| 4 skipped \| 9 todo | 3 failed \| **16779** passed \| 4 skipped \| 9 todo | **+24** |
| `pnpm lint` | exit 0 — 34/34 tasks | exit 0 — 34/34 tasks | — |

```
$ pnpm --filter @arcaai/database build && pnpm --filter @arcaai/database test
> tsc
 Test Files  47 passed (47)
      Tests  1177 passed (1177)

$ pnpm --filter @arcaai/domains build && pnpm --filter @arcaai/domains test
> tsc
 Test Files  140 passed | 2 skipped (142)
      Tests  1596 passed | 2 skipped | 9 todo (1607)

$ pnpm --filter @arcaai/applications build && pnpm --filter @arcaai/applications test
> rimraf dist tsconfig.tsbuildinfo && tsc
 Test Files  471 passed | 1 skipped (472)
      Tests  8882 passed | 4 skipped (8886)

$ pnpm api:build
 Tasks:    10 successful, 10 total
Cached:    0 cached, 10 total
  Time:    17.139s

$ pnpm test:unit
 Test Files  2 failed | 987 passed | 2 skipped (991)
      Tests  3 failed | 16779 passed | 4 skipped | 9 todo (16795)

$ pnpm lint
 Tasks:    34 successful, 34 total
@arcaai/api:lint:          ✖ 65 problems (0 errors, 65 warnings)
@arcaai/applications:lint: ✖ 192 problems (0 errors, 192 warnings)
@arcaai/domains:lint:      ✖ 13 problems (0 errors, 13 warnings)
@arcaai/vox:lint:          ✖ 3 problems (0 errors, 3 warnings)
```

**Lint warning counts are identical to baseline in all four packages — zero new warnings**, including
the `packages/*` `only-warn` ones that must be treated as errors.

### The 3 `test:unit` failures are pre-existing and not mine

Both files fail identically on the untouched base commit:

| File | Cause | Owner |
|---|---|---|
| `apps/api/src/modules/consultation/__tests__/harness-internal.controller.test.ts` | `liveDocumentationService` undefined | TASK-662, parallel worktree |
| `scripts/__tests__/env-sync.test.ts` | `env-surface.generated.md` drift — run `pnpm env:sync` | pre-existing |

The **initial** baseline showed 33 failing files; 31 of them were the documented §1.1b stale-dist
false red. After building `room`/`noise-filter`/`vad`/`stt`/`med-ner`/`pipeline`/`ui`/`vox` as §1.1b
instructs, the real baseline is the 2 files above — which is what both columns of the table use.

## 6. Remaining gap — other repository methods (reported, not fixed)

Audited every write method on `Repository`. Three still cannot join a caller's transaction. Per this
ticket's scope none is fixed here, and none blocks promotion.

| Method | Gap | Call sites | Why it was left |
|---|---|---|---|
| `softDelete(id, updatedBy?)` | no `tx` | ~50 | **The highest-value follow-up.** Already worked around once, expensively — see §6.2 |
| `restore(id, updatedBy?)` | no `tx` | 6 | Exact inverse of `softDelete`; should be fixed in the same change, or the pair drifts |
| `delete(id)` | no `tx` | **1** | The single caller is a retention prune loop (§6.3) where a transaction would be actively wrong |

Reads (`findById`, `findFirst`, `findAll`, `count`) also take no `tx`, so a read inside a transaction
cannot see that transaction's own in-flight writes. `findByIdInContext` is the private tx-aware read,
used only by the CAS path. This did not need solving for promotion — its one in-sequence read
(`findLatestForAgent`) deliberately wants the committed history — but a future sequence that must
read back its own uncommitted write will hit it. Note the extra consideration a fix carries:
`runInTransaction` uses `baseClient`, which is **unscoped**, so tx-routed reads bypass both the
tenant-scope and soft-delete extensions. Writes are unaffected (promotion sets `tenantId` explicitly
on every row, and runs tenant-less by design), but a tx-aware *read* would need that addressed.

### 6.1 🔴 A latent bug this audit found — `BillingService.recordPlanChange`

`packages/applications/src/services/billing/billing.service.ts:368-386` states its intent as *"Close
the current window and open the new one atomically, so a period is never left double-covered or
gapped"*, and carries this comment:

> `// Inside runInTransaction the repositories join the tx via the shared`
> `// unit-of-work context; `update(id, entity)` carries no tx param (it reads`
> `// that context), while `create` also accepts it explicitly.`

**That is not true**, for the reason established in §4.3 and pinned by a test: a singleton repository
caches its database context at construction and never re-reads CLS. So
`planHistoryRepository.update(open.id, open)` (closing the current window) executes **outside** the
transaction, while `planHistoryRepository.create(next, tx)` (opening the new one) executes inside it.
If the `create` fails, the `create` rolls back but **the close has already committed**, leaving the
tenant's plan history with exactly the gap the transaction was written to prevent.

The fix is now one token — `update(open.id, open, tx)` — and is unblocked by this ticket. It is
**deliberately not applied here**: it changes billing behaviour, deserves its own tests, and the
comment shows someone relied on a contract that never held, which warrants deliberate review rather
than a drive-by edit inside a repository-contract ticket. **Recommend a follow-up ticket**, and a
sweep for the same false belief elsewhere.

### 6.2 What the `softDelete` gap has already cost

TASK-615 needed a transactional soft-delete for invoice lines and, unable to use the base class,
hand-wrote a whole subclass: `packages/domains/src/repositories/billing/BillingInvoiceLineWriteRepository.ts`.
Its `softDeleteByInvoice(tenantId, invoiceId, updatedBy, tx)` re-implements the base method's body —
`resourceStatus: DELETED`, `resourceStatusUpdatedAt`, `version: { increment: 1 }` — against a raw tx
delegate, and its sibling `createManyInTx` re-implements `createMany`'s mapper + null-strip pipeline
with a comment noting it avoids *"the shared base mid-wave"*. That is duplicated OCC-sensitive logic
living outside the one place the rules say it belongs, and it will drift. Closing the `softDelete`
gap would let that file shrink to a single `where`-clause helper.

### 6.3 Why `delete` is genuinely fine as it is

Its only caller is `AgentTrajectoryService.pruneOlderThan` — a nightly retention job hard-deleting
soft-delete-exempt ops telemetry row by row. A transaction there would be a regression: it would make
a long prune all-or-nothing, hold one transaction across thousands of deletes, and lose the resumable
partial progress the loop currently gives. No change wanted.

## Change History

- 2026-08-12 — Ticket opened from TASK-663 OI-2. Worktree reset from `dev` @ `180d09d6a` to
  `dev-2.1` @ `62cb2d174`; baseline measured before any edit; plan authored before any code.
- 2026-08-12 — Implemented in three staged commits: the plan (`b2bed2a07`), the repository contract
  change + its 10 tests (`0002b78d3`), and the transactional promotion sequence + its 14 tests
  (`ba18a872b`). All six gates green with pasted output (§5) and zero new lint warnings; every new
  test seen RED first and the load-bearing ones additionally verified by mutation. Status
  **Review**. Not merged, not pushed, no MR opened.

## Change History

- 2026-08-12 — Ticket opened from TASK-663 OI-2. Worktree reset from `dev` @ `180d09d6a` to
  `dev-2.1` @ `62cb2d174`; baseline measured before any edit; plan authored before any code.
