# TASK-687 — Stable finalize idempotency: N workflow executions must produce exactly 1 clinical note

| | |
|---|---|
| **Status** | Review |
| **Type** | bugfix (clinical correctness) |
| **Base** | `dev-2.1` @ `ca14822ed` |
| **Gates** | TASK-686 is held unmerged behind this ticket |

---

## 1. Requirement Analysis

`HarnessDocWorkflow` has **two** start sites, both targeting the deterministic workflow id
`harness-doc-{consultationId}`:

| Path | Entry point |
|---|---|
| legacy | `ConsultationEventHandler.handleTranscriptionCreated` → `HarnessGatewayService.start` → `apps/harness/src/harness/api/endpoints/internal.py:296` |
| loop | `ConsultationLoopWorkflow`'s `harness.finalize` action → `apps/harness/src/harness/temporal/workflows.py:2456` `start_child_workflow` |

**Neither sets `id_reuse_policy`** (grep-confirmed: zero occurrences in `apps/harness/`), so both
inherit Temporal's default `ALLOW_DUPLICATE`. `WorkflowAlreadyStartedError` therefore fires **only
while the first execution is still OPEN**. Once it has closed, a second start succeeds and a second
EXECUTION runs the whole workflow again.

TASK-686 measured the execution count on a real Temporal server (case A deduped; cases B and C
produced 2 executions) but explicitly declined to guess whether two executions produce two *note
rows*. **Settling that was the first deliverable of this ticket.**

### Acceptance bar (two-sided, per the owner)

1. Two executions over the same input → **exactly one** note row.
2. A genuine second finalize over *changed* input → the existing note **updates**; still exactly one
   row. It must **not** be silently ignored.

Bar 2 is the sharp one. An idempotency key that turns the second write into a blind no-op satisfies
bar 1 while destroying the late-transcript / edit-rebind cascade this programme exists to enable.

---

## 2. Current State Evaluation

### 2.1 The answer: **YES — two executions produced two note rows.**

`packages/applications/src/services/consultation/harness/harness-internal.service.ts#persistDraft`
was **unconditionally create-only**. It is not, and never was, an upsert:

```ts
const contextItem = ContextItemFactory.CreateRawSummary(tenantId, consultationId, strippedContent, …);
const savedContext = await this.contextItemRepository.create(contextItem);   // always INSERT
…
await this.summaryMetaRepository.create(summaryMeta);                        // always INSERT
```

There is no lookup of an existing RAW_SUMMARY for the current consultation anywhere in the service.
The only dedupe was `withHarnessIdempotency` — a Redis replay cache keyed on the harness
`Idempotency-Key`, which the harness minted per EXECUTION (`_idempotency_key()` =
`{workflow_run_id}:{activity_id}`). Two executions ⇒ two different keys ⇒ no cache hit ⇒ two
`create` calls ⇒ **two clinical notes for one consultation**.

Evidence, three independent ways:

**(a) Failing unit test (RED), before any change** — the pre-existing test at
`harness-internal.service.test.ts` literally encoded the defect as expected behaviour:

```
it('persistDraft: DIFFERENT key → NOT suppressed (create twice)')
  expect(contextItemRepository.create).toHaveBeenCalledTimes(2);   // ← the bug, asserted as correct
```

Rewriting it to demand one row failed exactly as predicted:

```
FAIL  … > persistDraft: DIFFERENT key → NOT suppressed, but adopts the existing draft
AssertionError: expected "vi.fn()" to be called 1 times, but got 2 times
Test Files  1 failed | 475 passed | 1 skipped (477)
     Tests  6 failed | 8941 passed | 4 skipped (8951)
```

**(b) Live, on a real Temporal server** — see §5. Two executions, two distinct `Idempotency-Key`s
on the wire, zero replay-cache hits, **2 note rows**.

**(c) A pre-existing, unimplemented contract note in the workflow itself.** `workflows.py:1085-1090`
already said this was required and it had never been built:

> `NOTE (apps/api): a re-delivery must UPSERT the existing DRAFT_PENDING_SENSORS draft (update
> content + computational scores), not create a second draft.`

So the defect was not only real across executions — the optimistic path's post-delivery **regen
re-delivery already created a second draft within a single execution.** Both are fixed here.

### 2.2 The key change alone is NOT sufficient — and that is the load-bearing finding

The owner's decision was a stable idempotency key at persist. Implementing only that would **not**
have delivered the acceptance bar, for two independent reasons:

1. **`withHarnessIdempotency` degrades to `work()`** whenever the key is absent, Redis is absent, or
   Redis throws (`harness-internal.service.ts:1210-1212`). A best-effort cache cannot be the
   guarantee for a clinical artifact.
2. **A second execution re-runs `assemble` → `generate`**, so its note content is whatever the LLM
   produces the second time. Any key that is a function of the content therefore differs, the cache
   misses, and a create-only write path duplicates the note regardless.

The row invariant has to live in the **write path**. The stable key is the cheap fast path on top of
it. Both were implemented; §5's matrix separates their contributions empirically.

---

## 3. Implementation

### 3.1 Gateway — the invariant (`harness-internal.service.ts`)

`persistDraft` now adopts the harness's **own** prior draft and updates it in place, else creates.

```ts
const existingDraft = await this.findOwnHarnessDraft(consultationId);
if (existingDraft) { …update content + SummaryMeta…; contextItemId = existingDraft.id; }
else               { …create, stamped with the ownership marker… }
```

**The ownership marker is load-bearing, not decoration.** Five other production paths create
`RAW_SUMMARY` rows for the same consultation:

| Path | File |
|---|---|
| synchronous summary | `summary.service.ts:503` |
| chain / comprehensive summary | `chain-summary.service.ts:178` |
| explicit context POST | `context.service.ts:690` |
| BullMQ summary job | `jobs/processors/summary.processor.ts:199` |
| BullMQ comprehensive job | `jobs/processors/comprehensive-summary.processor.ts:211` |

None coordinate with the harness. Adopting "the newest RAW_SUMMARY" unconditionally would let a
harness draft **overwrite a note this workflow never authored** — strictly worse than a duplicate.
So `findOwnHarnessDraft` filters on `metaData.subType === 'HARNESS_DRAFT'` (the same convention as
`LIVE_SOAP_SNAPSHOT`) and **fails safe to create**: unmarked rows, including any harness draft
written before this change, are never touched. No data migration; the worst case for legacy rows is
the pre-existing behaviour.

`SummaryMeta` is 1:1 with the ContextItem, so the adopted path re-stamps the existing meta row
(`findByContextItem` → assign → `updateWithVersion`, mirroring `applyAssuranceBackfillWithCas`)
rather than inserting a second row for the same `contextItemId`.

**Deliberately not re-run on the update branch:** `captureAiDraftSnapshot`. It always writes
`versionNumber = 1`, and `ContextItemVersion` rows are immutable history, so calling it again would
add a *second* v1 for the same note. `v1` keeps its definition — the AI draft as first delivered.

### 3.2 Harness — the fast path (`activities.py`)

`persist_draft`'s key moves off the execution and onto the write:

```python
def _draft_idempotency_key(consultation_id: str, content: str) -> str:
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return f"draft:{consultation_id}:{digest}"
```

**Deviation from the letter of the owner's spec, stated plainly.** The spec said derive from
`(consultationId, contextItemId)`. `contextItemId` is **not available** at persist time:
`PersistDraftInput` has no such field (the draft's own id does not exist yet — this call creates
it), and the only candidate — the transcript `context_item_id` on `HarnessDocWorkflowInput` — could
only be threaded in by editing `HarnessDocWorkflow`'s body, which is a hard constraint of this
ticket. `consultation_id` supplies the same stability property (it is identical across every
execution for this consultation and never shared across consultations).

**The content digest is required, not incidental.** Without it the key would be constant per
consultation, and the regen re-delivery documented at `workflows.py:1088` — `_deliver_early` called
again with a *regenerated* note — would hit the same key and be swallowed by the replay cache. That
is precisely the blind no-op the owner forbade. A changed note is a changed key, so it reaches the
gateway and updates the draft. Bar 1 is still satisfied because the row invariant comes from §3.1,
not from the key.

Every **other** callback keeps `_idempotency_key()` — their duplicate is only ever an activity
retry, for which run-scoping is correct.

### 3.3 Replay era decision: **no `workflow.patched` era is required.**

No workflow body was edited, no new activity input field was added, and no command sequence
changed. The only thing that changed is the **value of a string computed inside an activity body**
(`persist_draft`), which is never part of workflow history. This is exactly the owner's stated
criterion for "does not need an era".

Verified by name, not by count — all 26 replay tests, identical set before and after:

```
$ diff replay-baseline.txt replay-after.txt && echo "IDENTICAL BY NAME"
IDENTICAL BY NAME
26
```

---

## 4. Other idempotent callbacks — verdicts

Every durable callback that takes an `Idempotency-Key` was audited for the same per-execution flaw.

| Callback | Shares the flaw? | Verdict |
|---|---|---|
| `persistDraft` | **Yes** | **Fixed here.** The clinical artifact. |
| `persistEntities` | **Yes**, lower severity | **Out of scope, recorded.** A second execution duplicates NamedEntity rows (NER provenance, not the note). Partly mitigated already: `workflows.py:596-620` skips the persist when `extract_entities` returns `reused=True`, but that guard is inert for uncoded priors (`workflows.py:566-568`). Follow-up task registered. |
| `recordGateDecision` | No | WORM audit is append-only **by design**. Two executions really did happen; two audit rows is the truthful record, not a duplicate. |
| `recordEscalation` | No | Same WORM reasoning. |
| `finalizeAssurance` | No | Takes an explicit `contextItemId` and is a read-modify-write with compare-and-set (`applyAssuranceBackfillWithCas`). **Improved as a side effect of this fix**: both executions now share one `contextItemId`, so the second finalize re-stamps the same meta row instead of targeting an orphan. |
| `reportTrajectory` | No | Accepts the header and ignores it; the write is already idempotent telemetry. |

---

## 5. Live verification

Two real-system proofs. Everything started was torn down (`docker ps` afterwards shows only the
containers that were already running).

### 5.1 Real Temporal server — `apps/harness/scripts/task687_live_proof.py`

Isolated dev server on **:7234** (dev's 7233 untouched). Real `HarnessDocWorkflow`, real
`persist_draft` activity (only the other activities stubbed), POSTing to a recording HTTP gateway
so the captured `Idempotency-Key` is the real header off the wire.

**The premise, confirmed on a real server:** two starts on the same workflow id
`harness-doc-live-…` after the first closed produced **2 distinct executions**;
`WorkflowAlreadyStartedError` never fired.

| # | harness key | gateway write path | distinct keys | replay hits | **NOTE ROWS** |
|---|---|---|---|---|---|
| 1 | per-execution (pre-fix) | create-only (pre-fix) | 2 | 0 | **2** ← the defect, reproduced |
| 2 | per-execution (pre-fix) | adopt-or-create (fixed) | 2 | 0 | 1 |
| 3 | stable (fixed) | create-only (pre-fix) | 1 | 1 | 1 |
| 4 | stable (fixed) | adopt-or-create (fixed) | 1 | 1 | **1** ← shipped |

Row 1 is the bug. Row 2 is why the gateway change is the invariant — it holds even with the old
per-execution key. Row 3 holds only because both executions happened to generate identical content;
it is not a guarantee, which is why row 2's mechanism is the one that ships.

Verbatim, pre-fix (row 1):

```
DISTINCT WORKFLOW EXECUTIONS: 2   ['019ff58c-22e8-75a4-bf47-0221f1ae21bc', '019ff58c-25f8-747e-871a-d882faea99ba']
persist_draft POSTs         : 2
  Idempotency-Key           : 019ff58c-22e8-75a4-bf47-0221f1ae21bc:15
  Idempotency-Key           : 019ff58c-25f8-747e-871a-d882faea99ba:15
DISTINCT Idempotency-Keys   : 2
replay-cache hits           : 0
NOTE ROWS                   : 2   ['ctx-1', 'ctx-2']
RESULT: FAIL
```

Verbatim, shipped (row 4):

```
DISTINCT WORKFLOW EXECUTIONS: 2   ['019ff58c-7f81-78fd-9f50-38a0fabd1f85', '019ff58c-829e-7068-8455-7b9d0d83444e']
persist_draft POSTs         : 2
  Idempotency-Key           : draft:live-…:c25ce6d385c9c300e2d7ca5118403c71b812816edc4356408167ea29983fd90c
  Idempotency-Key           : draft:live-…:c25ce6d385c9c300e2d7ca5118403c71b812816edc4356408167ea29983fd90c
DISTINCT Idempotency-Keys   : 1
replay-cache hits           : 1
NOTE ROWS                   : 1   ['ctx-1']
RESULT: PASS — 2 executions, 1 note row
```

### 5.2 Real Postgres — `packages/applications/scripts/task687-db-proof.ts`

Against the isolated test database on **port 5433 only** (owner-authorised throwaway; schema pushed,
then `pnpm infra:test:down` removed the volumes). The dev database on 5432 was never touched.

This proves the half the Temporal rig cannot: that `findOwnHarnessDraft`'s lookup — the thing the
invariant actually rests on — resolves correctly against real rows.

```
===== TASK-687 REAL-DATABASE PROOF (postgres :5433) =====
  PASS  exec 1 finds no prior draft                  found=null
  PASS  exec 2 adopts exec 1 row                     adopted=019ff58e-e4fd-722f-961a-4af90937494c
  PASS  NOTE ROWS after 2 executions == 1            count=1
  PASS  the adopted note UPDATED (not ignored)       content=DRAFT v2
  PASS  never adopts another generator's note        found=null
  PASS  never crosses consultations                  found=null
  PASS  converges onto the newest duplicate          picked=dup2

RESULT: PASS — all invariants hold against live rows
```

The last row matters for rollout: a consultation that already accumulated duplicates from this
defect converges onto the most recent one rather than forking further.

---

## 6. Gate evidence

**Baseline measured first, in this worktree** (no `.env.dev` ⇒ 0 pre-existing Python failures, as
predicted for a worktree environment; the main tree's 4 env-dependent failures do not apply here).
A fresh worktree also needs `pnpm install` before anything builds — `db:generate` fails with
`prisma: command not found` otherwise.

| Gate | Baseline | After | Δ |
|---|---|---|---|
| `PYTHONPATH=… pnpm harness:test` | 1180 passed, 4 skipped, **0 failed** | **1183 passed**, 4 skipped, **0 failed** | +3 (new) |
| `PYTHONPATH=… pnpm harness:test -k replay` | 26 passed | **26 passed**, identical **by name** | 0 |
| `pnpm --filter @arcaai/applications test` | 8941 passed + 6 failed (RED) | **8947 passed**, 4 skipped, **0 failed** | +6 green |
| `pnpm harness:lint` | — | `All checks passed!` | — |
| `pnpm harness:typecheck` | — | `Success: no issues found in 100 source files` | — |
| `pnpm --filter @arcaai/applications build` | — | clean | — |
| `pnpm api:build` | — | `Tasks: 10 successful, 10 total` | — |
| `pnpm lint` | — | `Tasks: 34 successful, 34 total` | — |

```
$ PYTHONPATH="$PWD/apps/harness/src" pnpm harness:test
================= 1183 passed, 4 skipped, 1 warning in 33.00s ==================

$ pnpm --filter @arcaai/applications test
 Test Files  476 passed | 1 skipped (477)
      Tests  8947 passed | 4 skipped (8951)

$ pnpm harness:lint
All checks passed!

$ pnpm harness:typecheck
Success: no issues found in 100 source files

$ pnpm api:build
 Tasks:    10 successful, 10 total

$ pnpm lint
 Tasks:    34 successful, 34 total
```

Note: `db:generate` / `api:build` / `lint` require placeholder `DATABASE_URL` + `DIRECT_URL` in the
environment (no DB connection is made).

---

## 7. Files changed

| File | Change |
|---|---|
| `apps/harness/src/harness/temporal/activities.py` | `_draft_idempotency_key()`; `persist_draft` uses it instead of `_idempotency_key()` |
| `apps/harness/src/harness/tests/unit/temporal/test_activities.py` | 3 new key tests; 1 pre-existing assertion updated to the new contract |
| `packages/applications/src/services/consultation/harness/harness-internal.service.ts` | `HARNESS_DRAFT_SUBTYPE`; `findOwnHarnessDraft()`; `persistDraft` adopt-or-create for ContextItem **and** SummaryMeta |
| `packages/applications/.../__tests__/harness-internal.service.test.ts` | New `TASK-687` describe (6 tests); mock repo gains `findByType`/`update`; 2 pre-existing dedup tests updated |
| `apps/harness/scripts/task687_live_proof.py` | Live Temporal proof rig (new) |
| `packages/applications/scripts/task687-db-proof.ts` | Live Postgres proof rig (new) |

No schema change, no migration, no seed change, no env var. `HarnessDocWorkflow`'s body was not
edited; `packages/database/src/prisma/db_main/seed/**` and `packages/agentic-sdk-v2/src/compat*`
were not touched; nothing is hard-deleted.

---

## 8. Change History

| Date | Change |
|---|---|
| 2026-08-12 | Ticket opened. Confirmed on a real Temporal server that two executions produce **two note rows**; fixed at the write path (gateway adopt-or-create, ownership-marker scoped) plus a stable persist key; 26 replay tests unchanged by name; no `workflow.patched` era required. `persistEntities` recorded as a lower-severity follow-up. Status → Review. |
