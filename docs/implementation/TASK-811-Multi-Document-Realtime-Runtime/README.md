# TASK-811 — Multi-Document Realtime Runtime

| Field | Value |
|---|---|
| **Status** | **`Completed`** 2026-08-28 — all 15 tasks merged to `dev-2.2` (`0977256f0`), verified by the orchestrator. Three follow-ons in §7 "Known follow-ups"; none blocks. (This section is `§7`, not `§9a` — the document has no §9; a prior header revision and TASK-806's own change history both point at a section number that was never created here.) |
| **Type** | `refactor` + `feature` |
| **Branch** | `dev-2.2` |
| **Architecture** | <https://claude.ai/code/artifact/b6b68b73-3cb9-4cec-89f3-8afd1553c13b> |
| **Master** | [TASK-806](../TASK-806-Consultation-Workflow-Substrate-Unification/README.md) |
| **Depends on** | TASK-809, TASK-810 |
| **Blocks** | 812, 814, 815 |
| **Agent** | `general-purpose` · `opus` · effort **`max`** · **worktree** |

> **Highest-risk ticket in the programme.** It rewrites the highest-volume internal hop in the
> platform, re-anchors every annotation offset, and introduces per-section concurrency.
> Land behind a per-tenant flag; keep the legacy path executable until trajectory parity is proven.

## 1. Requirement Analysis & Scope

### In scope
- Replace `LiveDocumentationService.flush()`'s hardcoded 11-step sequence with a **graph executor**
  walking the compiled realtime lane.
- `DocumentSection` child table (**OD-7**) with per-section state + provenance.
- `ContextItem.documentKey` discriminator (**OD-6**).
- Per-section streaming; offset re-anchoring.
- Concurrent per-node generation with per-node budget/timeout/staleness (**DD-4**).
- Guard memoization (**DD-7**).
- Gate `liveDocumentationService.start()` on the governing substrate.

### Out of scope — the compat fence (owner: "Do NOT touch the compat things")

Reproduced in full so this ticket is self-contained. **Do not read, edit, refactor, rename, or
"tidy" anything below.** If a change appears to require touching one of these, make it **additively**
instead and report the constraint rather than editing.

```
apps/compat-playground/**                        apps/quick-compat-app/**
apps/api/src/modules/text-compat/**              apps/api/src/modules/stt-compat/**          (OD-8)
apps/api/src/global-prefix.config.ts             apps/api/src/main.ts:109-111
packages/vox-node/src/resources/summarization.ts packages/vox-node/src/types/summarization.ts
packages/vox-node/src/core/url.ts                (PREFIX_EXEMPT_PATHS)
packages/agentic-sdk-v2/src/compat.ts            packages/agentic-sdk-v2/src/compat/**
packages/agentic-sdk-v2/src/types/consultation.ts:117-122   (the @deprecated `department` field ONLY)
packages/agentic-sdk-v2/src/types/context.ts:172-179        (AddContextInput.structuredData ONLY)
```


## 2. Current State Evaluation

`startRecording` calls `liveDocumentationService.start()` after only ownership + status checks —
**no substrate gate** (`consultation.controller.ts:594-599`). The hardcoded loop runs for every
recording session regardless of what the tenant authored. That is the root cause in TASK-806 §2.1.


## 2a. Findings this ticket closes

| # | Finding | Evidence |
|---|---|---|
| **D-1** | `paletteKey` is create-only and single-palette — `UpdateWorkflowDefinitionRequest` carries none | `workflow-definition.service.ts:432-443` |
| **D-3** | All eight `stt.*` interpreter nodes are *"DELIBERATE PLACEHOLDERS, not the real execution path"*; an STT graph compiles to an `AsrPipeline` YAML side-channel | `stt_placeholder.py:1-6` |
| **D-13** | Live capability surface is 3 booleans: `LIVE_TOOL_KEYS = ['ner','vitals','groundedness']` | `departmentAgent/constants.ts:61` |
| **D-14** | NER input hardcoded to `delta \|\| transcript`; its input type carries `sourceText` and nothing else **by design** | `live-documentation.service.ts:1176`, `live-tool-registry.ts:71-82` |
| **D-22** | `ContextItemType.PRE_SUMMARY` is overloaded — the context-derived pre-summary (`context.service.ts:1458`) **and** the running-note snapshot at recording stop (`recording.dto.ts:26`, `persistSnapshot`) | resolved by OD-6 `documentKey` |
| Root cause | `startRecording` calls `liveDocumentationService.start()` after only ownership + status checks — **no substrate gate** | `consultation.controller.ts:594-599` |

## 2b. The offset problem — the hidden cost of per-section streaming

Today **every annotation is globally offset-addressed** into one concatenated `runningSummary`:
`LiveSummaryEntityDto.start/end`, `LiveSummaryFlaggedSpanDto.start/end`,
`LiveSummaryGroundednessSegmentDto.start/end`, and `LiveSummarySectionDto.content` is documented as
*"a contiguous substring of `runningSummary`"* (`live-summary.dto.ts:32-36,72-77,86-90,110-113`).

Stream sections independently and every offset after a growing section is wrong.

```
// BEFORE — one document, global offsets, order-dependent
{ runningSummary: "...", entities: [{ start: 412, end: 421 }] }

// AFTER — addressed by document, offsets local to the section
{ event: "section.patch",
  documentKey: "soap",              // "soap" | "discharge" | "pre-summary"
  sectionKey:  "assessment",
  revision: 7,
  state: "provisional",             // empty | provisional | confirmed | locked
  content: "...",
  annotations: [ { kind: "entity", start: 12, end: 21, type: "MEDICATION" },
                 { kind: "groundedness", start: 0, end: 44, verdict: "grounded" } ],
  provenance: [ { transcriptSpanId: "t_0912" } ] }
```

## 2c. Persistence shape (OD-6 + OD-7)

- **`ContextItem.documentKey String?`** — nullable soft discriminator above `type`, **exact `kindKey`
  precedent** (`consultation.prisma:42-49`), zero backfill. Index mirrors
  `ContextItem_consultation_kindKey_idx` (`:99`).
- **`DocumentSection` child table (OD-7)** — mirrors `TranscriptSegment` (`consultation.prisma:628+`),
  which already carries `idx`, `t0Ms`/`t1Ms`, `speaker`, `charStart`/`charEnd` — the exact span
  anchors provenance needs. Section content is PHI: follow `ContextItem.encryptedContent Bytes?`.
- **Why a child table and not JSON in `metaData`:** per-section OCC. `ContextItem.encryptedContent`
  is a single opaque blob with one `_version`; on that shape every flush contends with every
  clinician edit, and two concurrently generating documents contend with each other.

## 2d. Section state machine

| State | Meaning |
|---|---|
| `empty` | nothing extracted yet — renders as a skeleton, **not** an error |
| `provisional` | model-written, freely replaceable on the next flush |
| `confirmed` | clinician-touched — flushes may append but **never overwrite** |
| `locked` | finalized at endpoint; writes rejected |

Deletion needs a reason: a later flush removing content must point at a transcript contradiction,
otherwise the patch is refused.

## 3. Design constraints — read before writing code

**Offsets.** Today entities, flagged spans and groundedness segments all carry `start`/`end` into
one concatenated `runningSummary`, and a section's content is "a contiguous substring" of it. With
multiple documents streaming per section, every one of those offsets is invalidated the moment any
earlier section grows. Re-anchor to `{documentKey, sectionKey, local offsets}`.

**OD-7 — why a child table, not JSON.** Per-section OCC is what makes "a confirmed section is never
overwritten by a flush" actually hold. With one blob and one `_version`, every flush contends with
every clinician edit, and two concurrently generating documents contend with each other.
Mirror `TranscriptSegment` (`consultation.prisma:628+`), whose `idx`/`t0Ms`/`t1Ms`/`charStart`/
`charEnd` are the exact span anchors provenance needs.

**`documentKey` precedent.** `kindKey` (`consultation.prisma:42-49`) is the exact shape: nullable
soft discriminator above `type`, zero backfill. Index mirrors `ContextItem_consultation_kindKey_idx`.

**DD-4 — two calls, concurrent.** They fan out from the same upstream with no mutual dependency, so
wall-clock is the slowest call, not the sum. Failure isolates: a discharge timeout must leave the
SOAP note untouched.

**The invariant that must not be lost.** NER must never see generated text. TASK-809 encodes it as
a port type; this ticket must not reintroduce a path around it.

## 4. Implementation Plan (TDD)

| # | Task | Test first |
|---|---|---|
| 1 | `DocumentSection` model + trio + enum `EMPTY\|PROVISIONAL\|CONFIRMED\|LOCKED` | schema + entity tests |
| 2 | `ContextItem.documentKey` nullable + index | migration + mapper test |
| 3 | Executor walks the compiled realtime lane in declared order | fixture-graph ordering test |
| 4 | Disabled node skipped; per-node failure degrades as today | degrade tests |
| 5 | Step inputs resolve by declared port over the context object (retire `delta \|\| transcript`) | binding test |
| 6 | **NER cannot receive generated text** | regression test |
| 7 | Convert `LIVE_TOOL_KEYS` from a 3-boolean allow-list into node dispatch | registry test |
| 8 | Per-document, per-section state; clinician edit → `CONFIRMED`, never overwritten | concurrency test |
| 9 | Deletion requires a transcript contradiction, else refused | test |
| 10 | Concurrent generation, **per-node** timeout/budget/staleness | test: slow discharge does not stall SOAP; late response does not overwrite fresher content |
| 11 | Guard memoization on `(guard, config, inputHash)`; **config in the key** | test: two thresholds → two verdicts |
| 12 | SSE payload `section.patch` with `documentKey`/`sectionKey`/`revision`/`state`/`annotations`/`provenance` | contract test |
| 13 | Gate `start()` on the governing substrate | controller test |
| 14 | Transcription becomes a real node binding the `AsrPipeline` (D-3) | node test |
| 15 | Trajectory records from the realtime executor — the parity evidence for cutover | trajectory test |

## 5. Verification
```bash
pnpm --filter @arcaai/database test
pnpm --filter @arcaai/domains build test
pnpm --filter @arcaai/applications build test
pnpm test:unit
pnpm test:up:api   # terminal 1
pnpm test:e2e
```
**Cutover evidence:** diff trajectory records between legacy and graph executors on the same
transcript and show equivalence before flipping any tenant.

## 6. Definition of Done
- [x] Executor walks the compiled lane; legacy path still executable behind the flag — `realtime-executor.test.ts` "task 3 — the executor walks the lane in declared order"; `ensureSubstrateResolved` substrate gate (task 13) plus the `maxScope: 'tenant'` rollout flag keep the legacy path live until a tenant is flipped
- [x] Offsets section-local; multi-document streaming proven — `reanchor-annotations.test.ts:21` "growing an earlier section does not move a later section's offsets"; `realtime-executor.test.ts:461` "produces a transcript, entities, a document and correction proposals in one run"
- [x] Per-section OCC proven under concurrent flush + clinician edit — `section-store.test.ts:88` "CONCURRENT flush + clinician edit: the compare-and-set makes the flush lose, and it does NOT retry"
- [x] Anti-laundering regression green — `realtime-executor.test.ts:308-325` "task 6 — anti-laundering: NER cannot receive generated text"
- [x] Trajectory parity demonstrated — `live-documentation.substrate-gate.test.ts` (task 15)

## Best Practices — apply to every task here

- **Per-section OCC is the point of the child table.** "A confirmed section is never overwritten"
  cannot hold on a single blob with a single `_version` — every flush would contend with every
  clinician edit, and two concurrent documents with each other.
- **The anti-hallucination invariant is load-bearing.** NER runs over the RAW transcript and is
  grounded back to the note; it must NEVER see generated text. TASK-809 encodes this as a port
  type — do not add a path around it. A regression test is mandatory, not optional.
- **Degrade must never be silent.** Every degrade emits a typed event to the clinician UI. Silent
  degradation to an empty note is exactly why the 2026-08-25 outage went unnoticed.
- **Budget and staleness are per node, not per flush.** One slow model must not stall the other;
  a late response must not overwrite fresher content.
- **Memoize guards on `(guard, config, inputHash)` — config in the key.** Two thresholds are two
  verdicts; keying on input alone would serve one node the other's answer.
- **Prefix caching:** corrective retries are **appended**, never prepended, so the cache-stable
  lead-in stays byte-identical.
- **Roll out behind a per-tenant flag** and keep the legacy path executable until trajectory parity
  is demonstrated on the same transcript.
- **One scroll container per panel**; the note panel must not nest a second scroll area.

## Standing instructions (every task in this ticket)

- **Evidence, not assertion.** "Tests pass" with nothing pasted is not a result. Paste actual
  command output (`01-development-workflow.md` §Phase 5).
- **TDD:** failing test first, and you must *see it fail*. A test that never failed verifies nothing.
- **Branch is `dev-2.2`**, never `dev`.
- **Never `git stash` in a worktree** — the stash stack is shared repo-wide. Commit, then
  `git checkout HEAD~1 -- <path>` for a baseline.
- **Orchestrator owns shared surfaces:** merges, `pnpm install`, `db:push`/`db:migrate`/
  `test:db:reset`, Docker/infra, and every `gen:*` invocation. Do not run them.
- **Lint warnings in `packages/*` are errors.** `eslint-plugin-only-warn` downgrades them; treat
  them as hard failures anyway.
- **Do not run** the test suites of `apps/compat-playground`, `apps/quick-compat-app`, or
  `packages/ui` unless your change lands inside that package (owner directive).

### Destructive-tooling warnings (this ticket touches Prisma)

- **NEVER run `pnpm gen:mapper`.** It rewrites mappers as it goes and **drops the
  `FIELDS_NOT_WRITABLE = ['version']` OCC guard** before crashing. One run clobbered 24 mappers and
  stripped the guard from 18. Recovery is `git checkout -- packages/domains/src/mappers/generated/core/`.
- `gen:entity` / `gen:factory` **reconcile barrels and check coverage — they never create files.**
  Entity, factory, mapper and repository are **hand-authored**.
- `gen:repository` is broken (bad argument); harmless but useless.
- Migrations are authored against a **throwaway shadow DB**, never the dev DB — recipe in
  `02-database-prisma.md`. The dev DB is `db push`-managed and has no migrations ledger.
- On `@@unique`, `name:` is the **client-facing** compound key; the DB index name comes from `map:`.

### Finishing protocol — land it on `dev-2.2`, leave no worktree behind (owner directive, 2026-08-25)

**No work is "done" while it sits in a worktree.** When your gates are green, you MUST complete
this sequence. It is not optional and its order is not negotiable.

1. **Bring the target in first.** `git merge dev-2.2` INTO your branch and resolve any conflicts
   **in your own worktree**, never in the primary checkout.
2. **Re-run every gate AFTER that merge.** A clean merge is not a passing build. Paste the output.
3. **Merge your branch into `dev-2.2`** — the target is always `dev-2.2`, never `dev`.
4. **Only once step 3 is committed:** remove your worktree (`git worktree remove <path>`) and delete
   your branch.

**Before step 4, prove there is nothing left to lose:**
```bash
git log <your-branch> --not dev-2.2 --oneline   # MUST be empty
```
If it is not empty, stop — you have unmerged commits. Never use `git worktree remove --force`,
never `git worktree prune` "to tidy up", and never delete the directory by hand. An abandoned
worktree is recoverable; a removed one is not.

**If you cannot complete the merge** — conflicts you cannot resolve, a failing gate, an ambiguous
call — **LEAVE THE WORKTREE IN PLACE** and report it at the TOP of your final message with its path
and branch. Never bury an un-merged worktree in the body of a report.

**Concurrency note:** when several lanes run at once, the orchestrator may tell you to stop after
step 2 and hand off, so the final merges are serialized and lanes do not race each other into
`dev-2.2`. Follow that instruction if you receive it; otherwise complete all four steps yourself.

## Close-out protocol — MANDATORY (owner directive 2026-08-26, amended by measurement)

**Which path applies depends on where you work. Read the right one.**

### If you work in a WORKTREE

You **cannot** merge into `dev-2.2` yourself, and you must not try. `dev-2.2` is checked out in the
primary checkout, so git refuses every route into it — `git push . HEAD:dev-2.2` returns
*"refusing to update checked out branch"*, and it is right to: the primary's index and work tree
would desync from HEAD. This was measured, not assumed.

1. **Verify your base FIRST — before any other work.** Worktrees have been created off **`dev`**,
   where `packages/workflow-contract` does not exist at all; two of two agents hit this.
   Run `git merge-base --is-ancestor $(git rev-parse dev-2.2) HEAD`. Non-zero ⇒ confirm your tree
   is clean, then `git reset --hard dev-2.2`. Report which you found.
2. Gates green on your branch, with output pasted.
3. Commit everything. Leave the worktree and branch **intact**.
4. Report your branch name, commit SHA, and that the merge is pending. The orchestrator merges from
   the primary checkout, re-runs the gates there, and only then destroys the worktree and branch.

### If you work in the MAIN CHECKOUT

1. Gates green on your branch, output pasted.
2. **Merge into `dev-2.2`.** Never `dev`.
3. **Re-run the affected gates AFTER the merge** — a clean merge is not a passing build; a sibling
   lane may have moved the base underneath you.
4. **Delete your branch**, only after confirming the merge is on `dev-2.2`
   (`git log dev-2.2 --oneline | grep <your-sha>`).

### Stop conditions — never force past these

- A merge that conflicts in a way you cannot resolve with confidence ⇒ **STOP and report**, leaving
  the branch intact. An abandoned branch is recoverable; a bad merge or a deleted branch is not.
- Gates failing after a merge ⇒ **STOP and report**. Delete nothing.
- Never `git worktree remove --force`, never `git worktree prune`, never delete a branch holding
  commits absent from `dev-2.2`.
- Never `git stash` — the stash stack is shared repo-wide across every worktree.

## Agent Brief (self-contained — copy verbatim when dispatching)

**Ticket:** TASK-811 · **Branch:** `dev-2.2` · **Tree:** worktree `../hope-v2-task-811` off `dev-2.2`
**Agent:** `general-purpose` · **Model:** `opus` · **Effort:** `max`
**Review lens:** + `tester` (concurrency + staleness) + `code-reviewer`.

**Per-task tiers:** every stage here is a deciding stage — executor semantics, offset re-anchoring,
per-section concurrency. Do **not** downshift any of them. The `DocumentSection` trio scaffolding
is the only `sonnet`-grade sub-step.

**You own:** `LiveDocumentationService` and its executor, `DocumentSection`,
`ContextItem.documentKey`, the SSE payload, the substrate gate on `startRecording`.
**You must not touch:** the compat fence — **including `stt-compat` (OD-8)**; endpoint actions
(TASK-812); the template compiler (TASK-810).
**This is the highest-risk ticket in the programme.** If a decision looks like it needs an owner
call, stop and report rather than choosing.
**Return contract:** `EXECUTOR` (steps + ordering proof), `PERSISTENCE` (model + migration),
`PAYLOAD` (section.patch contract), `CONCURRENCY` (per-node budget/staleness tests pasted),
`INVARIANT` (anti-laundering regression pasted), `PARITY` (trajectory diff legacy vs graph).

**Rules to read before starting:** `.claude/rules/` files 00, 01, 02, 03, 04, 05. A subagent inherits NONE of the orchestrator's context — read them.

## 7. Implementation Summary

### What landed

| # | Task | Where |
|---|---|---|
| 1 | `DocumentSection` + `DocumentSectionState` enum + hand-authored trio | `packages/database/src/prisma/db_main/{consultation,enums}.prisma`, `packages/domains/src/{entities,factories,mappers,repositories}/generated/core/DocumentSection*` |
| 2 | `ContextItem.documentKey` + index, stamped on the durable snapshot (closes D-22) | same schema file; writer in `persistDurableSnapshot` |
| 3 | Executor walks the lane in declared order; stage members run concurrently | `realtime/realtime-lane.ts`, `realtime/realtime-executor.ts` |
| 4 | Disabled node skipped; per-node degrade with a TYPED event | `realtime-executor.ts` |
| 5 | Inputs resolve by declared port (`outputKey`), retiring `delta \|\| transcript` | `resolveBoundInputs` |
| 6 | **Anti-laundering** enforced by a port-type check on every edge | `resolveBoundInputs` + `__tests__/realtime-executor.test.ts` |
| 7 | `LIVE_TOOL_KEYS` → node dispatch (`vitals` stays a projection) | `realtime/realtime-node-registry.ts` |
| 8 | Per-section state + per-section OCC | `realtime/section-store.ts` |
| 9 | Deletion requires a transcript contradiction | `section-store.ts` |
| 10 | Per-node budget / retry / staleness | `realtime-executor.ts` |
| 11 | Guard memo on `(guard, config, inputHash)` | `realtime/guard-memo.ts` |
| 12 | `section.patch` payload + offset re-anchoring | `realtime/dto/section-patch.dto.ts`, `realtime/reanchor-annotations.ts` |
| 13 | **Substrate gate on `start()`** — the root cause | `ensureSubstrateResolved` in `live-documentation.service.ts` |
| 14 | `consultation.captureBinding` becomes a real producer of `transcript` | `CaptureBindingHandler` |
| 15 | Trajectory parity legacy ↔ graph | `__tests__/live-documentation.substrate-gate.test.ts` |

### Decisions taken, with their reasons

- **Lane membership is `REALTIME_NODE_TYPES`, NOT `WorkflowNodeDescriptor.lane`.** Flipping
  `lane: 'realtime'` on the three consultation nodes is *refused by the contract package's own
  rule*: `nodeDescriptorContractProblems` declares a realtime node MUST NOT be
  `externalWrite: true`, and both `consultation.realtimeSummary` and
  `consultation.extractEntities` are. Independently, nothing reads `lane` yet — the durable
  interpreter that would have to SKIP a realtime node is `apps/harness/**`, out of this lane's
  boundary. Flipping the flag without that half would declare a split no runtime enforces, and for
  `realtimeSummary` (`externalWrite: true`) that means two engines writing one document.
  **Consequence: `registryChecksum()` did NOT move and no seed was regenerated.**
  Reconciling `descriptor.lane` with reality is a coordinated `workflow-contract` + `apps/harness`
  change and needs an owner decision.
- **No sys-events on section writes, so no `ResourceType` addition.** The entire live plane
  already persists through repositories without broadcasting (`persistDurableSnapshot` writes
  `ContextItem` directly). Per-section-per-flush audit rows on the highest-volume hop in the
  platform would flood the audit log. Recorded as a deliberate call, not an oversight.
- **`DocumentSection` is soft-delete EXEMT**, mirroring `TranscriptSegment`: sections live and die
  with their consultation's document, and emptying one is a content update under the state machine
  (which additionally requires a transcript contradiction), never a row delete.
- **The per-tenant flag is `maxScope: 'tenant'`, not `globalOnly`.** The two existing consultation
  kill-switches are platform emergency stops; this is a ROLLOUT gate, and a rollout that can only
  be all-or-nothing is not one.
- **A flush that loses the compare-and-set LOSES.** It does not re-read and rewrite — that would
  defeat the check it just lost, which is how an OCC guard becomes decorative.

### Known follow-ups (not defects introduced here)

1. `descriptor.lane` reconciliation + the harness-side skip (owner call — see above).
2. `sttPipelineId` is resolved upstream by `ConsultationWorkflowDispatchService` but not threaded
   into `POST :id/recording/start`; the capture node therefore reports `pipelineId: null`. That is
   observability only — the transcript it publishes is the pipeline's output either way. Threading
   it is a request-DTO change (and the five regenerated artifacts).
3. `DocumentSection` has no REST surface. Clinician edits go through
   `DocumentSectionStore.applyClinicianEdit`, unit-tested; the editing route belongs with the
   endpoint-actions ticket (TASK-812) or the console lane.

### Evidence

```
packages/database   68 files / 1675 tests passed
packages/domains   156 files / 1873 passed (build: tsc clean)
packages/applications 597 files / 10397 passed (build: tsc clean)
apps/api           261 files / 4031 passed (pnpm api:build: 12/12 tasks)
pnpm lint          40/40 tasks successful
gen:model/entity/factory :check — no drift, schema coverage OK
```

## 8. Change History
| Date | Change |
|---|---|
| 2026-08-25 | Opened from TASK-806 §7. Carries OD-6, OD-7, DD-3, DD-4, DD-7. |
| 2026-08-28 | Implemented on `lane-811-runtime`. All 15 tasks landed; substrate gate closes the root cause; trajectory parity demonstrated. Two owner-call items recorded rather than worked around (registry `lane`, section REST surface). Dev-DB sync PENDING — orchestrator-owned. |

## 8. DocumentSection editing surface — §7 follow-up #3 CLOSED (2026-08-29)

The handoff that fell between three tickets: §7 #3 delegated the editing route to "TASK-812 or the
console lane"; 812 recorded nothing, 814 explicitly declined it. Until now `applyClinicianEdit` had
**only test call sites** and a clinician could not persist a per-section edit at all.

Three routes shipped — `GET/PATCH .../documents/:documentKey/sections[/:sectionKey]`. The two GETs
are load-bearing, not scope creep: `_version` is the CAS token and is **not** the `revision` the SSE
`section.patch` carries, and the stream never publishes it, so without a read that emits the ETag
the PATCH would be unusable.

### 8a. `If-Match` would have been decorative — found and fixed

`applyClinicianEdit` computed `expectedVersion = section.version` from the row it had **just
re-read**. That is a read-modify-write, not a precondition: the check can only ever pass. Sound for
the in-process flush writer, useless as an HTTP gate — a clinician submitting from a stale render
would have silently overwritten a flush they never saw, while 428/412 looked correct and enforced
nothing. Proven RED first, then fixed additively: `SectionWriteInput.expectedVersion` is consulted
only when supplied, so the flush writer's self-read path is byte-identical.

### 8b. Status semantics

| Case | Answer | Why |
|---|---|---|
| absent / cross-tenant | 404 | tenant-filtered read makes foreign and missing indistinguishable |
| LOCKED (post-finalize) | **409, not 412** | DD-3 locks EVERY document and no version is writable — "re-read and retry" would loop forever |
| stale `If-Match` | 412 | raised pre-write so `currentVersion` is accurate for a conflict modal |
| missing `If-Match` | 428 | `@RequiresIfMatch()` |
| persistence down | 503 | the store never pretends a write happened |

`deletion-without-contradiction` is deliberately NOT evaluated on the clinician lane: it guards the
MACHINE writer from silently emptying prose it wrote earlier. A clinician emptying their own section
is authorized by definition and owes the transcript no reason. Pinned by a test.

### 8c. Three things reported, not fixed

1. **Pre-existing data-loss path (most serious).** `DocumentSectionStore.encrypt()` catches
   encryption failure, warns, and continues. `content` is transient with no column, so a Vault
   outage persists the CONFIRMED state and bumped revision while `encryptedContent` keeps its OLD
   value — the clinician gets a 200 and their text is gone. Affects the flush writer identically;
   fixing it changes both lanes and needs its own change.
2. **A persisted edit publishes no `section.patch`.** The section is CONFIRMED, so the next flush
   refuses with `confirmed-no-overwrite` and publishes nothing — a second viewer keeps stale
   provisional text with no path to converge. Not fixed because duplicating the channel prefix is
   the "second transport for one payload" failure the codebase warns against; the honest fix is a
   publish method on `LiveDocumentationService`.
3. **The two GETs inherit `consultation:session:write`.** `:read` is semantically right, but that
   would WIDEN PHI reach for API keys — a security decision not taken unilaterally inside a
   persistence lane.

`ResourceType` has no `DocumentSection` member, so the sys-event reports `ResourceType.Consultation`
with the transition in `data` — the precedent `finalizeDocuments` set for the lock half.

### 8d. Remaining: console wiring
`case-note-column.tsx` must read via `GET .../sections` on mount (SSE only emits during an active
flush, so a reload currently shows nothing), hold each section's `version`, send it as `If-Match`,
and handle 409 (finalized ⇒ read-only) distinctly from 412 (re-read and re-apply). Deliberately not
started — another session owns that file.

## 9. Runtime verification — PERFORMED 2026-08-29 (Lane E)

Everything below was run against a LIVE stack: the gateway on `:8868` (prebuilt `dist`, not
`--watch`), `apps/text` on `:8862` generating through LM Studio on `:1234`, `apps/nlp` on `:8864`,
and the admin console's `next dev` on `:5176`.

> **Environment note, because it changes how to read this section.** The TEST infrastructure the
> lane brief assumed (postgres 5433 / redis 6380 / minio 9002 / qdrant 6335) **did not exist** — no
> such containers were present, only the eight `hope-*` dev ones. Rather than start it (an
> orchestrator-owned surface) or mutate the dev database, the dev DB was CLONED with
> `pg_dump | psql` into a throwaway `hope_lane_e` on the same container and every service pointed
> at it by host-env override. The dev database `hope` was never written to; it held only its idle
> Vault connection throughout.
>
> Incidentally this retires §7a of TASK-810: `prisma migrate diff --from-config-datasource
> --to-schema` against the dev DB reports **"This is an empty migration."** — the dev database is
> fully in sync with the schema, so the "99 statements behind / awaiting an owner decision on
> wiping" note there is stale.

### §7 item 15 — trajectory parity is now FIELD-proven, and it HOLDS

The claim was test-proven only, because the flag (`consultation.realtime.graphExecutor.enabled`)
defaults OFF and had never been on for any tenant. It was flipped for **one** tenant (Global,
`50000000-…-0000`) through `PUT /admin/settings/registry/:key` with `scope: tenant`; the other
tenant kept resolving `code-default: false`, so the per-tenant rollout gate works as designed.

The same transcript was then driven through both engines and their `AgentTrajectoryStep` rows
diffed. **The repeating per-flush unit is identical:**

```
LEGACY (flag OFF, consultation …0005)   GRAPH (flag ON, consultation …0006)
LLM_CALL/flush/OK                       LLM_CALL/flush/OK
TOOL_CALL/nlp.classify-tokens/OK        TOOL_CALL/nlp.classify-tokens/OK
PHASE/publish/OK                        PHASE/publish/OK
                                        (diff of the first 6 steps: IDENTICAL)
```

The only observable difference is the intended one: graph mode materialises `DocumentSection`
rows (4) where legacy writes none.

**One real behavioural difference the parity test cannot see.** In a session with context notes
but NO transcript, the legacy engine emits **no** `nlp.classify-tokens` step at all (its NER input
was `delta || transcript`, D-14) while the graph engine emits one with zero entities — task 5's
declared-port resolution, working as specified. The parity test always supplies a transcript, so
this asymmetry is invisible to it. It is a change in what gets CALLED, not in what gets written.

### §8 — the three section routes, conflict semantics proven against the live gateway

Unit-proven before; these are real HTTP responses.

| Case | Expected | Observed |
|---|---|---|
| `GET .../sections` (none yet) | 200 `[]` | **200 `[]`** |
| `GET .../sections/:key` (absent) | 404 | **404** |
| `PATCH` with no `If-Match` | 428 | **428** `HTTP.PRECONDITION_REQUIRED` |
| `PATCH` stale `If-Match: "1"` (current 3) | 412 | **412**, `metadata: {expectedVersion:1,currentVersion:3}` |
| `PATCH` LOCKED section, FRESH `If-Match` | 409 | **409** |
| `PATCH` LOCKED section, STALE `If-Match` | 409 (state beats precondition) | **409** — the §8b ordering holds |
| `PATCH`/`GET` cross-tenant id | 404 | **404** |
| `PATCH` correct `If-Match: "3"` | 200 | **200**, `ETag: "4"`, state `provisional → confirmed`, revision 4 → 5 |
| `PATCH` by a non-owner clinician | 403 | **403** "Only the assigned doctor can modify this consultation" |

The `GET` emits `ETag: "<version>"` and the SSE `section.patch` carries `revision` but **not**
`version` — confirmed on the wire, which is exactly why §8's two GETs are load-bearing.

The 412 body carries a sanitised `stack` (relative filenames, no `cwd`) outside production and
omits it in production — F-030 behaving as designed, not a leak.

### DD-3 — `section.patch` is emitted live

Seven `section.patch` events observed on `GET :id/live-summary/stream` during a graph-mode session,
one per section per flush, e.g.

```json
{"event":"section.patch","documentKey":"soap_note","sectionKey":"subjective","idx":0,
 "revision":1,"state":"provisional","content":"…","annotations":[],"updatedAt":"…"}
```

**The "N documents" half is still NOT proven, and it is not provable from any graph that exists.**
Every event carried the same `documentKey` (`soap_note`) — the platform lane binds one document.
Checked against the database rather than assumed:

- the only published `consultation`-palette definitions are `arcaai-consultation-soap` and
  `arcaai-rheum-consultation-soap`, and their node list contains exactly ONE generation node
  (`consultation.realtimeSummary`);
- `select count(*) from "WorkflowDefinition" where graph::text like '%documentTemplateId%'` returns
  **0** — no graph anywhere carries a document binding, which is expected: `documentTemplateId` was
  only added to the generation-node schemas by TASK-810 §7b item 2, after these graphs were authored.

So closing DD-3's N-half needs a graph AUTHORED with two generation nodes bound to two published
`DocumentTemplate`s, then published and assigned. That is workflow authoring plus a product decision
about what the second document should be — not a runtime gap. A second template
(`discharge_summary`, 5 sections, published v1/v2) was created during this pass, so the template
half of the prerequisite already exists.

### DEFECT FOUND AND FIXED — a second recording session published nothing

**The most serious thing this pass found.** With the graph executor on, the *second* recording
session on any consultation wrote no section and published no `section.patch` — the clinician was
left on the "Waiting for the first live summary" skeleton indefinitely:

```
Section patch refused {"documentKey":"soap_note","sectionKey":"subjective","reason":"stale-generation"}
… objective / assessment / plan, all refused …
Live summary flush {"generation":1,"flushCount":1,…}      ← a BRAND-NEW session
```

Root cause: `DocumentSectionStore.lastGeneration` is the flush staleness watermark, keyed by
section address alone, and `LiveDocumentationService` memoizes ONE store for the life of the
process (`this.sectionStore ??= new DocumentSectionStore(...)`). `generation` restarts at 0 for
every new session, so once session 1 reached generation N every write of session 2 satisfied
`input.generation < seen`. `DocumentSectionStore.forget()` was written for precisely this — "Drop a
finished session's staleness bookkeeping" — and had **zero production callers**.

Fixed in `LiveDocumentationService.start()`, after the re-bind early-return so re-attaching an STT
stream to a live session still keeps its state:

```ts
this.sections().forget(params.consultationId);
```

Reset on START, not on stop(): a session that crashed, lost its owner lock, or was stood down by
the substrate gate never reaches `stop()`, and those are exactly the ones whose stale watermark
would poison the next session.

Proven RED first (`live-documentation.session-generation.test.ts` — the second session's write list
was empty), then green; plus two store-level tests for `forget()` itself. Field-verified afterwards
on one consultation across two consecutive sessions in ONE process:

```
BEFORE:           subjective rev3  objective rev3  assessment rev3  plan rev3
AFTER SESSION A:  subjective rev5  objective rev5  assessment rev5  plan rev5
AFTER SESSION B:  subjective rev8  objective rev7  assessment rev8  plan rev8
stale-generation refusals in the whole process: 0
```

### Still not verified, and what would close it

| Item | Why not | What closes it |
|---|---|---|
| N > 1 documents from `section.patch` | the platform lane binds ONE document; no tenant graph in this DB has two generation nodes | author a consultation graph with two generation nodes bound to two published `DocumentTemplate`s, then record |
| §7 follow-up 2 (`sttPipelineId` threading) | untouched this pass | a request-DTO change plus the five regenerated artifacts |
| §8c item 1 (encrypt-failure data loss) | needs a Vault outage injected mid-write | a fault-injection test around `DocumentSectionStore.encrypt()` |
| §8d console wiring of the section GET/PATCH | `case-note-column.tsx` is owned by another session | that session |
