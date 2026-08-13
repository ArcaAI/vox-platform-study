# TASK-688 — `persistEntities` idempotency: N workflow executions must produce one entity set

| | |
|---|---|
| **Status** | Review |
| **Type** | bugfix (PHI duplication) |
| **Base** | `dev-2.1` @ `ed05ccbe8` (tree-identical to the `4490bb35b` named in the brief) |
| **Follows** | TASK-687, which recorded this rather than half-doing it |

---

## 1. Requirement Analysis

TASK-687 fixed the clinical note. It recorded `persistEntities` as sharing the same root
cause at lower severity, and registered this follow-up.

`HarnessDocWorkflow` has **two** start sites on the deterministic id
`harness-doc-{consultationId}` — the legacy `ConsultationEventHandler` path and the loop's
`harness.finalize` child — and **neither sets `id_reuse_policy`**. Temporal's default
`ALLOW_DUPLICATE` therefore rejects a second start only while the first execution is still
OPEN, so a second EXECUTION is routine (a legacy run that already completed, or a late
transcript after the loop finalized).

Two things then compound:

| Layer | Defect |
|---|---|
| `apps/harness/.../activities.py` | `persist_entities` minted its key from `_idempotency_key()` = `{workflow_run_id}:{activity_id}` — **different per execution**, so the gateway's replay cache never matched |
| `packages/applications/.../harness-internal.service.ts` | `persistEntities` unconditionally `createMany`'d — **no adopt-or-replace step** |

Result: a second execution over the same transcript inserted every `NamedEntity` row a
second time. Those rows carry `encryptedText` — **duplicated PHI** — and they feed the
NER-priors reuse guard, so accumulation could skew prior reuse itself.

### Acceptance bar (two-sided, per the owner)

1. Two executions over the same transcript → exactly **one set** of `NamedEntity` rows.
2. A genuine re-extraction over **changed** input → entities update/replace, still one set.
   **Not silently ignored.**
3. **No other producer's rows are ever deleted.**

---

## 2. Current State Evaluation

### 2.1 The producer list — verified, not assumed

The brief named five paths. Verified on `dev-2.1` by grepping `NamedEntityFactory`
call sites: there are **five files**, but only **four distinct producers plus one shared
mapper**:

| Producer | File | How it builds the row |
|---|---|---|
| explicit context POST | `consultation/context/context.service.ts:1017` | `namedEntityPropsFromNlp` |
| synchronous summary | `consultation/summary/summary.service.ts:1185` | `namedEntityPropsFromNlp` |
| BullMQ NER job | `consultation/jobs/processors/ner.processor.ts:115` | `namedEntityPropsFromNlp` |
| **harness** | `consultation/harness/harness-internal.service.ts` | its own inline mapping |
| *(shared mapper)* | `consultation/shared/namedEntityFromNlp.ts` | not a producer — the single NLP→NamedEntity contract the other three share |

**This is what decides the implementation.** The harness passes `inp.context_item_id` —
the **transcript** ContextItem — as `PersistEntitiesInput.context_item_id`
(`workflows.py:612`). `ner.processor` runs NER over that *same* transcript ContextItem.
So `contextItemId` is emphatically **not** a discriminator: a blind "replace everything for
this contextItem" would destroy rows another producer wrote, the exact trap TASK-687 caught
with RAW_SUMMARY.

### 2.2 What distinguishes harness-written entities: **nothing did — a marker was required**

Every candidate was checked before inventing one:

| Candidate | Verdict |
|---|---|
| `contextItemId` | **No** — shared with `ner.processor` over the same transcript (§2.1) |
| `metaData` / `metadata` | **No.** Unlike `ContextItem`, `NamedEntity` has no plaintext metadata column — it was DROPPED; the value lives in `encryptedMetadata` (Vault-Transit `Bytes`). Not SQL-queryable, and encryption is a soft no-op outside `SECRETS_PROVIDER=vault`, so outside prod the field is not even persisted |
| `transcriptContextItemId` | **No.** `NEREntity` (`sensors/base.py:55`) carries no such field, so the harness always sends null — and no other producer sets it either |
| ontology codes / `assertion` | **No** — the NLP token classifier emits no codes today (the `consultation.prisma` comment says so, and `_load_coded_priors` is built around it) |
| `aiModelId` | **Yes** — plaintext, nullable, indexed-adjacent, and set by **none** of the four producers (all three non-harness ones route through `namedEntityPropsFromNlp`, which never sets it) |

So the ownership marker is **`aiModelId = 'HARNESS_NER'`**.

This is not a hijack of the column: `aiModelId` documents *which recognizer produced this
span*, and these rows are the harness NER pass's output. Seeds do write real model names
there (`biomedical-ner-v1`), which is the point — a distinct sentinel value cannot collide
with them, and the column keeps its meaning.

**A migration was considered and rejected.** A dedicated `source` column would be tidier,
but it would mean a schema change on a PHI table plus the hand-authored
entity/factory/mapper/repository cascade, for a marker an existing plaintext column already
carries unambiguously. Per the brief, a migration needed proof of necessity; there is none.

### 2.3 The removal constraint — `NamedEntity` has no soft delete

The brief instructed: never hard delete; use `softDelete`, which now takes an optional `tx`.
**That is not available here.** `NamedEntity` is listed in `MODELS_WITHOUT_SOFT_DELETE`
(`packages/database/src/client.ts:109`) — it has no `resourceStatus` column, so
`Repository.softDelete()` **throws** for it. `NamedEntityRepository.deleteByContextItem`
exists but is a hard `deleteMany`, which is off the table for PHI.

**Nothing in this change removes a row.** The consequence is stated honestly in §4.

---

## 3. Implementation

### 3.1 Gateway — the invariant (`harness-internal.service.ts`)

`persistEntities` now adopts the rows **this path** wrote for the ContextItem and rewrites
them in place, creating only the surplus:

```ts
const owned = await this.findOwnHarnessEntities(dto.contextItemId);   // aiModelId marker
const adopted = Math.min(owned.length, namedEntities.length);
for (let index = 0; index < adopted; index++) { rewrite in place → update }
const created = namedEntities.slice(adopted);                          // surplus only
```

- **Pairing is by position.** `findByContextItem` returns rows ordered by `startOffset`, and
  the incoming list arrives in NLP order (also start-offset ascending), so pair *i* is the
  same span of the transcript.
- **Adopted rows are REWRITTEN, not skipped.** That is what makes bar 2 real: a changed
  re-extraction replaces the entity set instead of being swallowed. `rewriteHarnessEntity`
  assigns through `BaseEntity.setProperty`, so `repository.update` persists only the fields
  that moved; `contextItemId`, `tenantId` and the marker are deliberately untouched — they
  are what identified the row as ours.
- **Every created row is stamped** `aiModelId: 'HARNESS_NER'` so the *next* execution can
  recognise it.
- **The lookup fails safe to CREATE.** A read error logs and returns `[]`, so the entities
  are still persisted (an extra set — the pre-existing behaviour) rather than lost. Letting
  it propagate would turn a read blip into a dropped NER layer for the consultation.

#### Why another producer's rows cannot be touched

`findOwnHarnessEntities` filters on the marker *before* returning, and it is the **only**
source of rows this path mutates. A row without `aiModelId === 'HARNESS_NER'` is never in
the returned list, so it is never passed to `update`, and no code path here deletes
anything at all (§2.3). Legacy harness rows written before this change carry a null
`aiModelId`, so they degrade to exactly the prior behaviour — never destroyed. This is the
same fail-safe shape as TASK-687's `HARNESS_DRAFT` marker, with no data migration.

### 3.2 Harness — the fast path (`activities.py`)

```python
def _entities_idempotency_key(consultation_id: str, entities: Sequence[Any]) -> str:
    payload = json.dumps([...], sort_keys=True, separators=(",", ":"), default=str)
    return f"entities:{consultation_id}:{hashlib.sha256(payload.encode()).hexdigest()}"
```

The digest is required, not incidental: a key constant per consultation would let the replay
cache swallow a legitimate re-extraction — the blind no-op the owner forbade. Every **other**
callback keeps `_idempotency_key()`; their duplicate is only ever an activity retry, for
which run-scoping is correct.

### 3.3 Which contribution is load-bearing: **the write path**

Separated empirically, as TASK-687 did.

Every TASK-688 gateway test runs against a service built **without** a Redis cache — i.e. the
degraded `withHarnessIdempotency` → `work()` path — and bar 1 still holds. One test makes it
explicit by injecting a cache whose `get` **throws** while passing the *same* stable key
twice:

```
✓ holds with the replay cache DOWN and a stable key — the write path, not the key, is the guarantee
```

| | key alone | write path alone | shipped |
|---|---|---|---|
| Redis healthy, same input | 1 set | 1 set | 1 set |
| **Redis down/absent, same input** | **2 sets** | 1 set | **1 set** |
| Changed input | reaches gateway, then **2 sets** | 1 set, replaced | 1 set, replaced |

The key is a round-trip saver. The row invariant is the gateway's.

### 3.4 Replay era: **none required**

No workflow body was edited. The only change on the Python side is the **value of a string
computed inside an activity body**, which is never part of workflow history — the owner's
stated criterion for "does not need an era". Verified by name, not count (§5).

---

## 4. The `priors_reused` guard — verified, and the verdict

`workflows.py:596-620` skips the persist when `extract_entities` returns `reused=True`.
Confirmed against the code rather than taken on trust:

- `extract_entities` returns `reused=True` only when `_load_coded_priors` yields a non-empty
  list (`activities.py:745-756`).
- `_load_coded_priors` ends `return priors if any(_has_ontology_code(e) for e in priors) else []`
  — **reuse requires at least one prior carrying an ontology code.**
- No writer populates those codes today: the NLP token classifier emits none (stated in
  `consultation.prisma`, and the workflow comment at `:565-568` says the guard is *"inert
  until coded entities are actually persisted"*).

**So the guard is inert in practice, and the brief's premise is correct** — uncoded priors
were entirely unprotected, which is precisely the window in which the duplication happened.

**Is it now redundant?** For *correctness*, yes: a redundant re-persist is now a set of
in-place updates rather than a second set of rows, so the guard is no longer what stands
between the consultation and duplicated PHI. It is **retained** as an optimization — when it
does eventually fire it saves a pointless HTTP round trip — and removing it would edit the
workflow body and require a `workflow.patched` era for no benefit.

### Known residue (stated, not hidden)

Because `NamedEntity` cannot be soft-deleted and hard deletion of PHI is forbidden (§2.3),
one case is not fully reconciled: a re-extraction yielding **fewer** entities than the
previous one leaves the trailing rows this path owns in place. The common cases —
identical re-run (bar 1) and a changed or **longer** transcript, i.e. the late-transcript
cascade this programme exists to enable — converge to exactly one set. Closing the shrink
case requires giving `NamedEntity` a soft-delete lifecycle (a migration + allow-list
change); that is a deliberate follow-up, not an oversight.

---

## 5. Gate evidence

**Baseline measured first, in this worktree.** No `.env.dev` present ⇒ **0** pre-existing
Python failures (the main tree's 4 env-dependent failures do not apply here). A fresh
worktree needs `pnpm install`, then `db:generate`, then
`pnpm turbo build --filter=@arcaai/applications` — without the build, 370 applications test
FILES fail to import.

| Gate | My measured baseline | After | Δ |
|---|---|---|---|
| `PYTHONPATH=… pnpm harness:test` | 1183 passed, 4 skipped, **0 failed** | **1186 passed**, 4 skipped, **0 failed** | +3 (new) |
| `PYTHONPATH=… pnpm harness:test -k replay` | 26 passed | **26 passed**, identical **by name** | 0 |
| `pnpm --filter @arcaai/applications test` | 8968 passed, 4 skipped, **0 failed** | **8976 passed**, 4 skipped, **0 failed** | +8 (new) |
| `pnpm harness:lint` | — | `All checks passed!` | — |
| `pnpm harness:typecheck` | — | `Success: no issues found in 100 source files` | — |
| `pnpm --filter @arcaai/applications build` | — | clean | — |
| `pnpm api:build` | — | `Tasks: 10 successful, 10 total` | — |
| `pnpm lint` | — | `Tasks: 34 successful, 34 total` | — |

### The RED, captured before the fix

```
× bar 1: a SECOND execution over the same transcript produces exactly ONE set of rows
AssertionError: expected [ { id: 'ne-Metformin', …(17) }, …(1) ] to have a length of 1 but got 2

× bar 2: a re-extraction over CHANGED input replaces the row (not silently ignored), still ONE set
AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times

× every created row carries the ownership marker, so the NEXT execution can recognise it
× scopes adoption to THIS ContextItem — a different consultation never collides
× a LATER execution with MORE entities keeps one set: prior rows adopted, the surplus created

 Test Files  1 failed | 476 passed | 1 skipped (478)
      Tests  5 failed | 8970 passed | 4 skipped (8979)
```

`length of 1 but got 2` is the defect reproduced: two executions, two sets.

The bar-3 test (another producer's row survives) and the fail-safe test **passed before the
change too** — vacuously, since nothing adopted anything then. They are regression locks on
the property the fix must not break, and they still pass after it.

### Verbatim, after

```
$ PYTHONPATH="$PWD/apps/harness/src" pnpm harness:test
================= 1186 passed, 4 skipped, 1 warning in 34.19s ==================

$ diff replay-baseline.txt replay-after.txt && echo "IDENTICAL BY NAME"
IDENTICAL BY NAME
=============== 26 passed, 1164 deselected, 3 warnings in 4.78s ================

$ pnpm --filter @arcaai/applications test
 Test Files  477 passed | 1 skipped (478)
      Tests  8976 passed | 4 skipped (8980)

$ pnpm harness:lint
All checks passed!

$ pnpm harness:typecheck
Success: no issues found in 100 source files

$ pnpm api:build
 Tasks:    10 successful, 10 total

$ pnpm lint
 Tasks:    34 successful, 34 total
```

`db:generate` / `api:build` / `lint` require placeholder `DATABASE_URL` + `DIRECT_URL` in the
environment (no DB connection is made).

---

## 6. Files changed

| File | Change |
|---|---|
| `packages/applications/src/services/consultation/harness/harness-internal.service.ts` | `HARNESS_NER_MODEL_ID`; `findOwnHarnessEntities()`; `rewriteHarnessEntity()`; `persistEntities` adopt-or-create |
| `packages/applications/.../__tests__/harness-internal.service.test.ts` | New `TASK-688` describe (8 tests); mock repo gains `findByContextItem`/`update` |
| `apps/harness/src/harness/temporal/activities.py` | `_entities_idempotency_key()`; `persist_entities` uses it instead of `_idempotency_key()` |
| `apps/harness/src/harness/tests/unit/temporal/test_activities.py` | 3 new key tests; 1 pre-existing assertion updated to the new contract |

No schema change, no migration, no seed change, no env var (the plane stays `global-kv` per
TASK-679). `HarnessDocWorkflow`'s body was not edited;
`packages/agentic-sdk-v2/src/compat*` was not touched; nothing is hard-deleted.

---

## 7. Change History

| Date | Change |
|---|---|
| 2026-08-12 | Ticket opened from TASK-687's registered follow-up. Reproduced the duplication (RED: 2 rows where 1 was required), fixed at the gateway write path (adopt-or-create scoped by an `aiModelId = 'HARNESS_NER'` ownership marker) plus a stable persist key; proved the write path — not the key — is load-bearing by holding the invariant with the replay cache down. Found that `NamedEntity` is in `MODELS_WITHOUT_SOFT_DELETE`, so no row can be removed; the shrink-case residue is documented. `priors_reused` guard confirmed inert and no longer load-bearing, retained as an optimization. 26 replay tests unchanged by name; no `workflow.patched` era. Status → Review. |
