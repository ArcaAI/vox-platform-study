# TASK-680 — Transactional write sweep

| Field | Value |
|---|---|
| Status | **In Progress** |
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

*(filled in as work lands)*

## Change History

- 2026-08-12 — Ticket opened from TASK-677 §6.1/§6.2. Worktree reset from `main` @ `180d09d6a` to
  `dev-2.1` @ `baeb7d49b`; baseline measured before any edit; plan authored before any code.
