# TASK-677 — Transactional write sequences

| Field | Value |
|---|---|
| Status | **In Progress** |
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

_(filled in below once the gates are green)_

## 5. Verification Evidence

_(pasted gate output)_

## 6. Remaining gap — other repository methods

_(filled in below)_

## Change History

- 2026-08-12 — Ticket opened from TASK-663 OI-2. Worktree reset from `dev` @ `180d09d6a` to
  `dev-2.1` @ `62cb2d174`; baseline measured before any edit; plan authored before any code.
