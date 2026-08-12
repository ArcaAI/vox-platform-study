# TASK-680 — Transactional write sweep

| Field | Value |
|---|---|
| Status | **Review** |
| Type | `bugfix` (billing plan-history gap) + `refactor` (repository contract: `softDelete`/`restore`) |
| Base commit | `dev-2.1` @ `baeb7d49b` |
| Closes | TASK-677 **§6.1** (billing) and **§6.2** (`softDelete`/`restore` gap) |
| Migration | **None** |

## 1. Requirement Analysis

TASK-677 added an optional `tx` parameter to `Repository.update` and, in its §6 audit, reported
two things it deliberately did **not** fix. This ticket closes both.

### Item 1 — the billing bug (TASK-677 §6.1)

`BillingService.recordPlanChange` wraps its two writes — CLOSE the current plan window, OPEN the
successor — in `runInTransaction`, and carried this comment:

> *"Inside runInTransaction the repositories join the tx via the shared unit-of-work context"*

That was never true. A `Repository` resolves and **caches** `_databaseContext` in its
**constructor**, and repositories are NestJS singletons built at boot when no transaction exists, so
an already-constructed repository never observes the CLS client `runInTransaction` publishes. The
close therefore committed **outside** the transaction while the open ran **inside** it: a failing
open rolled back only itself, leaving the previous window closed with nothing replacing it — a
**gap in billing plan history**, exactly what the transaction exists to prevent.

### Item 2 — `softDelete` / `restore` (TASK-677 §6.2)

Neither accepts a `tx`, so neither can join a caller's transaction. The gap has already been worked
around expensively: TASK-615 hand-wrote `BillingInvoiceLineWriteRepository` rather than patch the
shared base mid-wave. `restore` is the exact inverse of `softDelete` and must be fixed in the same
change or the pair drifts.

### Scope (deliberately narrow)

1. Item 1 — the one-token fix plus its own tests, and delete/correct the false comment.
2. Item 2 — optional trailing `tx` on `softDelete` and `restore`, mirroring `update` exactly.
3. Report the verdict on `BillingInvoiceLineWriteRepository`.

### Out of scope

- **`delete(id)` — deliberately untouched.** Its single caller is
  `AgentTrajectoryService.pruneOlderThan`, a nightly retention job hard-deleting soft-delete-exempt
  ops telemetry row by row. Wrapping it in a transaction would be a *regression*: it would make a
  long prune all-or-nothing, hold one transaction across thousands of deletes, and destroy the
  resumable partial progress the loop currently relies on. No change wanted — this is a decision,
  not an oversight.
- **`updateWithVersion` — untouched.** It already accepts `tx`. TASK-677 added a test pinning that
  `update` must not acquire OCC semantics; this ticket preserves that property and extends the same
  pinning to `softDelete`/`restore`.
- Settings-registry descriptors and OCR/loop flag call sites (TASK-679); consultation lifecycle
  (TASK-683); `apps/harness/**`; `packages/agentic-sdk-v2/src/compat.ts` and `src/compat/**`.

## 2. Current State Evaluation

### Item 1 was ALREADY APPLIED before this ticket started

Measured on the base commit, not assumed. `packages/applications/src/services/billing/billing.service.ts`
at `dev-2.1` @ `baeb7d49b` already reads `update(open.id, open, tx)`, the false comment is already
replaced, and `__tests__/billing.planChange.transaction.test.ts` (207 lines, 7 tests) already exists.

```
$ git log -1 --format='%H %s' -S'await this.planHistoryRepository.update(open.id, open, tx)' \
    -- packages/applications/src/services/billing/billing.service.ts
baeb7d49be070505036d286d5a8ac49a884eecb4 Implement robust temporal synchronization helpers for workflow tests
```

The fix rode in on a commit whose message describes **only** unrelated Temporal test helpers — the
billing change is invisible from the log. It was found by reading the file, not the history. This
ticket therefore **verifies** Item 1 rather than re-implementing it (§4.1), and the verification is
a mutation test, not an inspection.

### Item 2 — the repository contract today

| Method | `tx`? | Notes |
|---|---|---|
| `create(entity, tx?)` | ✅ | The precedent |
| `createMany(entities, skipDuplicates?, tx?)` | ✅ | |
| `update(id, entity, tx?)` | ✅ | Added by TASK-677 |
| `updateWithVersion(id, entity, expectedVersion, tx?)` | ✅ | Not touched by this ticket |
| `softDelete(id, updatedBy?)` | ❌ | **Closed here** |
| `restore(id, updatedBy?)` | ❌ | **Closed here** |
| `delete(id)` | ❌ | Deliberately left — see Out of scope |

Call sites, counted on the base commit: **37 non-test `softDelete`** call sites (88 lines including
tests) and **6 non-test `restore`** call sites. The two classes that declare their own
`softDelete(id, updatedBy?)` — `RbacRoleRepository` and `PolicyRepository` — do **not** extend
`Repository` (both are standalone facades, verified at their `export class` lines), so there is no
override-signature interaction.

## 3. Implementation Plan

| # | Change | File |
|---|---|---|
| P-1 | `softDelete(id, updatedBy?, tx?)` — `const delegate = tx ? tx[this._modelName] : this.db` | `packages/domains/src/common/repository.ts` |
| P-2 | `restore(id, updatedBy?, tx?)` — identical shape | same |
| P-3 | New domains suite pinning both, incl. a rollback harness | `packages/domains/src/common/__tests__/softDelete.restore.transaction.task680.test.ts` |

`IRepository` is deliberately left alone: `IRepository.create` does not declare `tx` either, and a
class method may accept more optional parameters than its interface declares. Mirroring `create`
exactly means not touching the interface. **No call site changes** — the parameter is optional and
trailing, so all 43 existing call sites keep compiling and behaving identically.

### TDD list (RED first)

| T | Assertion | Suite |
|---|---|---|
| T-1 | `softDelete(id)` — no `tx` — writes through the cached extended client, unchanged data shape | domains |
| T-2 | `softDelete(id, updatedBy, tx)` routes through `tx[modelName]` and NEVER the cached client | domains |
| T-3 | `softDelete(id, undefined, tx)` omits `resourceStatusUpdatedBy` — the optional-stamp branch survives | domains |
| T-4 | `restore(id)` — no `tx` — unchanged (`ENABLED`) | domains |
| T-5 | `restore(id, updatedBy, tx)` routes through `tx[modelName]` | domains |
| T-6 | The `supportsSoftDelete` guard still throws BEFORE any write, with and without `tx` | domains |
| T-7 | Neither acquires OCC semantics — `where` is `{ id }` only, never `updateMany` | domains |
| T-8 | A `softDelete`/`restore` issued with `tx` does NOT survive a rollback; one issued without `tx` DOES (the defect, modelled) | domains |

## 4. Implementation Summary

Two files changed, plus this document.

| File | Change |
|---|---|
| `packages/domains/src/common/repository.ts` | `softDelete(id, updatedBy?, tx?)` and `restore(id, updatedBy?, tx?)` — the only production change |
| `packages/domains/src/common/__tests__/softDelete.restore.transaction.task680.test.ts` | **new** — 16 tests |
| `packages/applications/src/services/billing/billing.service.ts` | **unchanged** — Item 1 already landed (§4.1) |

### 4.1 Item 1 — already fixed; verified rather than re-implemented

The fix was already present on the base commit (§2). Re-applying it would have been a no-op edit,
and *reading* the fix is not evidence that its test works. So Item 1 was verified the only way that
proves anything: **by mutation**. Reverting the one token —

```ts
await this.planHistoryRepository.update(open.id, open, tx);   // shipped
await this.planHistoryRepository.update(open.id, open);       // mutated back to the bug
```

— and re-running `billing.planChange.transaction.test.ts`:

```
× CLOSES the current window through the tx client — the write the false comment left outside
× rolls the CLOSE back when the successor insert fails, so the tenant keeps a window in force
× closes the last window through the tx client when the tenant drops to no plan
 Tests  3 failed | 4 passed (7)
```

The **rollback** test is among the three that die, which is the assertion that matters: it is not
passing vacuously. Inspecting the suite confirms why — it does not merely assert
`expect(committed).toEqual([])` (which would pass against a service with no transaction at all); it
also asserts the close was genuinely attempted and that the successor insert was issued *through*
`TX`. The mutation was then reverted and `git diff --stat` confirmed empty before any further work.

The false comment is likewise already replaced with an accurate one naming the caching-singleton
reason and pointing at the domains test that pins it.

**How it was found, and the process risk worth recording:** the fix rode in on commit `baeb7d49b`,
whose message describes *only* unrelated Temporal test-sync helpers. Nothing in the log mentions
billing. A ticket that trusted `git log` here would have re-implemented a landed fix and reported a
phantom bug as fixed. The base state must be read from the *files*, not the history.

### 4.2 Item 2 — the signature change

```ts
public async softDelete(id: EntityId, updatedBy?: EntityId, tx?: Prisma.TransactionClient | any): Promise<DomainEntity> {
  if (!this.supportsSoftDelete) { throw new Error(/* … */); }
  const delegate = tx ? (tx as Record<string, any>)[this._modelName] : this.db;
  const model = await delegate.update({ where: { id }, data: { /* unchanged */ }, include: this._includes });
  return this._mapper.toDomainEntity(model);
}
```

`restore` is identical but for `ResourceStatusType.ENABLED`. Byte-for-byte the shape `create`,
`createMany` and (since TASK-677) `update` use.

**Backward compatibility is by construction, not by assertion.** The parameter is optional and
trailing, and when absent the delegate resolves to `this.db` — the *identical* expression the method
used before, so the no-tx path is unchanged code, not merely unchanged behaviour. Three independent
confirmations:

1. **Call sites needing a change: zero, of 43.** 37 non-test `softDelete` + 6 non-test `restore`, all
   untouched. That is the point of the change, not a happy accident.
2. `@arcaai/applications` tests are **identical to baseline** (8906 passed) — every one of those call
   sites still behaves the same.
3. Dedicated regression tests assert the one- and two-argument forms still write through the cached
   extended client with the same data shape, and never touch a transaction client.

Two classes declare their own `softDelete(id, updatedBy?)` — `RbacRoleRepository` and
`PolicyRepository` — but **neither extends `Repository`** (both are standalone facades; verified at
their `export class` lines). There is no override-signature interaction.

`IRepository` is deliberately unchanged, mirroring TASK-677's reasoning: `IRepository.create` does
not declare `tx` either, and a class method may accept more optional parameters than its interface
declares.

### 4.3 OCC is untouched

`updateWithVersion` is **not modified** and remains the only compare-and-set path. The
`version: { increment: 1 }` that `softDelete`/`restore` already wrote is a **state stamp, not a
predicate** — it exists so a stale reader at v(n) cannot `updateWithVersion(…, n)` a row another
admin just soft-deleted and resurrect deleted PHI. TASK-677 added a test pinning that `update` must
not acquire OCC semantics; this ticket extends the same pinning to both methods (T-7: `where` is
`{ id }` only, never `updateMany`).

### 4.4 `delete` deliberately left alone

Its single caller is `AgentTrajectoryService.pruneOlderThan`, a nightly retention job hard-deleting
soft-delete-exempt ops telemetry row by row. A transaction there would be a **regression** — it would
make a long prune all-or-nothing, hold one transaction across thousands of deletes, and destroy the
resumable partial progress the loop depends on. Skipped by decision, stated here rather than
silently.

### 4.5 Verdict — `BillingInvoiceLineWriteRepository` **cannot** be deleted

TASK-677 §6.2 hoped closing this gap would let that file "shrink to a single `where`-clause helper".
**Verified against the code: it will not, and the reason corrects the §6.2 expectation.**

| Method | Redundant now? | Why |
|---|---|---|
| `softDeleteByInvoice(tenantId, invoiceId, updatedBy, tx)` | **No** | It is a **bulk predicate** soft-delete — `updateMany` over `{ tenantId, invoiceId, resourceStatus: { not: DELETED } }`, i.e. every live line of one invoice in **one statement**. The base `softDelete(id, …)` targets **one row by primary key**. Adding `tx` does not close that gap: expressing this through the base class would mean reading every live line and issuing N single-row updates per recompute. |
| `createManyInTx(entities, tx)` | **Yes — but not because of this ticket** | It is equivalent to the base `createMany(entities, false, tx)`, which has accepted `tx` since **before** TASK-677. Its redundancy predates both tickets. |

So the duplication that made TASK-615 hand-write this class is a **bulk-vs-single-row mismatch**, not
a transaction mismatch. The genuinely duplicated OCC-sensitive body (`resourceStatus`,
`resourceStatusUpdatedAt`, `version: { increment: 1 }`) still lives outside the base class and can
still drift — but the fix for that is a **bulk** `softDeleteWhere(where, updatedBy?, tx?)` on the
base, which is a new capability and a different ticket. Removing `createManyInTx` in favour of
`createMany(…, false, tx)` is a safe, small follow-up; it is deliberately **not** done here because
it is unrelated to this ticket's gap and would put an untested change on the invoice-recompute path.

### 4.6 Every new test verified by mutation

Both suites were seen **RED** first — the new domains suite **7 failed / 9 passed** (the 9 that
passed are the backward-compat, guard and OCC-pinning tests, which correctly hold *before* the
change; one of them, "WITHOUT `tx` the write escapes the rollback", exists precisely to document the
defect and so must pass in both states). Each load-bearing assertion was then re-broken
individually:

| Mutation | Result |
|---|---|
| `softDelete`: `const delegate = tx ? tx[modelName] : this.db` → `this.db` | ✅ **5 fail**, incl. *"rolls the soft-delete back when a later write in the same transaction fails"* |
| `restore`: same mutation | ✅ **3 fail**, incl. *"rolls the restore back when a later write in the same transaction fails"* |
| `softDelete`: remove the `supportsSoftDelete` guard | ✅ **1 fail** — *"throws for a model without a resourceStatus column — with `tx` supplied"* |
| `softDelete`: `...(updatedBy && { resourceStatusUpdatedBy })` → unconditional | ✅ **2 fail** — the one-argument form, and the `undefined`-with-`tx` form |
| **Item 1** — `billing.service.ts`: drop `tx` from the close | ✅ **3 fail**, incl. the plan-history rollback test |

The rollback tests were specifically hardened against **vacuous** passing. `expect(committed).toEqual([])`
alone would pass against a repository that issues no write at all, so each also asserts the
transaction was entered exactly once and that the write was genuinely attempted **through** the tx
delegate. A companion test (`a successful transaction DOES commit the soft-delete`) closes the other
side, proving the rollback case is not passing by writing nothing.

## 5. Verification Evidence

Baseline measured on the untouched base commit **before any edit**, in the build order of
execution-plan §1.1b. Both columns from this worktree, same machine, same session.

| Gate | Baseline @ `baeb7d49b` | After | Δ |
|---|---|---|---|
| `@arcaai/database build` | pass | pass | — |
| `@arcaai/database test` | 1177 passed (47 files) | 1177 passed (47 files) | — |
| `@arcaai/domains build` | pass | pass | — |
| `@arcaai/domains test` | 1596 passed \| 2 skipped \| 9 todo (142 files) | **1612** passed \| 2 skipped \| 9 todo (143 files) | **+16** |
| `@arcaai/applications build` | pass | pass | — |
| `@arcaai/applications test` | 8906 passed \| 4 skipped (475 files) | 8906 passed \| 4 skipped (475 files) | **—** (the point) |
| `pnpm api:build` | 10/10 successful | 10/10 successful | — |
| `pnpm test:unit` | 1 failed \| 16805 passed \| 4 skipped \| 9 todo | 1 failed \| **16821** passed \| 4 skipped \| 9 todo | **+16** |
| `pnpm lint` | exit 0 — 34/34 tasks | exit 0 — 34/34 tasks | — |

```
$ pnpm --filter @arcaai/database build && pnpm --filter @arcaai/database test
> tsc
 Test Files  47 passed (47)
      Tests  1177 passed (1177)

$ pnpm --filter @arcaai/domains build && pnpm --filter @arcaai/domains test
> tsc
 Test Files  141 passed | 2 skipped (143)
      Tests  1612 passed | 2 skipped | 9 todo (1623)

$ pnpm --filter @arcaai/applications build && pnpm --filter @arcaai/applications test
> rimraf dist tsconfig.tsbuildinfo && tsc
 Test Files  474 passed | 1 skipped (475)
      Tests  8906 passed | 4 skipped (8910)

$ pnpm api:build
 Tasks:    10 successful, 10 total
  Time:    47.825s

$ pnpm test:unit
 Test Files  1 failed | 992 passed | 2 skipped (995)
      Tests  1 failed | 16821 passed | 4 skipped | 9 todo (16835)

$ pnpm lint
 Tasks:    34 successful, 34 total
@arcaai/api:lint:          ✖ 65 problems (0 errors, 65 warnings)
@arcaai/applications:lint: ✖ 194 problems (0 errors, 194 warnings)
@arcaai/domains:lint:      ✖ 13 problems (0 errors, 13 warnings)
@arcaai/vox:lint:          ✖ 3 problems (0 errors, 3 warnings)
```

**Lint warning counts are identical to baseline in all four packages — zero new warnings**,
including the `packages/*` `only-warn` ones that must be treated as errors.

### The 1 `test:unit` failure is pre-existing and not mine

| File | Cause | Owner |
|---|---|---|
| `scripts/__tests__/env-sync.test.ts` | `env-surface.generated.md` drift — run `pnpm env:sync` | pre-existing |

It fails identically on the untouched base commit. TASK-677 recorded **2** failing files here; the
other one (`harness-internal.controller.test.ts`, TASK-662) has since been fixed on `dev-2.1`.

### Measuring the baseline honestly

A fresh worktree has no built dists, and the first run of every gate lied in a *different* way than
TASK-677's stale-dist trap:

- `pnpm db:generate` failed outright — `.env.dev` is gitignored and absent from a new worktree
  (copied from the main checkout; both env files stay untracked).
- `@arcaai/domains build` failed with ~140 `TS2307: Cannot find module '@arcaai/exceptions'` — a
  missing prerequisite dist, not broken code. Building `exceptions`/`logger`/`types`/`utils` cleared
  it.
- `@arcaai/applications` then reported **211 failed files / 1 failed test** — the classic stale-dist
  signature (mass module-load failure, almost no assertion failures). The real cause was one missing
  dist, `@arcaai/json-schema-subset`. After building it: **474 passed**.

Taking any of those numbers as the baseline would have manufactured a false "improvement" of
hundreds of tests. The figures in the table above are all post-build.

## 6. Remaining gaps (reported, not fixed)

| Gap | Status |
|---|---|
| Bulk predicate soft-delete on the base (`softDeleteWhere`) | Would let `BillingInvoiceLineWriteRepository.softDeleteByInvoice` fold into the base class — a **new capability**, out of scope here (§4.5) |
| `createManyInTx` is redundant with `createMany(…, false, tx)` | Predates both tickets; safe small follow-up, deliberately not bundled onto the invoice-recompute path (§4.5) |
| Reads (`findById`/`findFirst`/`findAll`/`count`) take no `tx` | Unchanged from TASK-677 §6. A read inside a transaction cannot see that transaction's own in-flight writes. Note `runInTransaction` uses the **unscoped** `baseClient`, so a tx-routed read would bypass the tenant-scope and soft-delete extensions — that must be addressed before any tx-aware read lands |
| `delete(id)` takes no `tx` | Correct as-is (§4.4) |

## Change History

- 2026-08-12 — Ticket opened from TASK-677 §6.1/§6.2. Worktree reset from `main` @ `180d09d6a` to
  `dev-2.1` @ `baeb7d49b`; baseline measured before any edit; plan authored before any code
  (`70cc8bf55`).
- 2026-08-12 — Item 1 found **already landed** on the base commit inside an unrelated-looking commit
  (`baeb7d49b`); verified by mutation instead of re-implemented, mutation reverted, tree confirmed
  clean. Item 2 implemented in one staged commit (`28c49b6fd`): optional `tx` on `softDelete` and
  `restore` plus 16 tests seen RED first and mutation-verified. Zero of 43 call sites changed. All
  six gates green with pasted output (§5), zero new lint warnings. `BillingInvoiceLineWriteRepository`
  verdict: **cannot be deleted** (§4.5). Status **Review**. Not merged, not pushed, no MR opened.
