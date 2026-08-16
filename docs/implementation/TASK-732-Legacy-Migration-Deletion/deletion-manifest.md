# TASK-732 Phase 3 Task 7 — Deletion Manifest (re-derived against the real tree)

**Document only. No file listed below was deleted, edited, or moved by this pass** — per the
executing instructions, this pass is Phase 1 (+ this manifest as a planning artifact for the
still-blocked Phase 3). §2 of the ticket README is explicitly the pre-TASK-704/pre-TASK-714 tree;
this document re-derives every path, line number, and architectural claim against the tree as it
exists on `feat/loop` at 2026-08-16 (commit `e2e54c1f2` and after). **Two findings below are new —
not anticipated by the ticket's own §2 — and change what Task 8/9/11 must do.** They are called out
first because they are the highest-consequence corrections in this document.

---

## 0. New findings this re-derivation surfaced (read before the table)

### 0.1 A fourth permanently-legacy entry point the ticket's §2.6 did not know about

§2.6 of the ticket names exactly three entry points with "no harness equivalent" (pre-summary,
comprehensive-summary, and their async siblings) and frames the decision as options (a)/(b)/(c).
**TASK-704 landed a fourth, different case since §2.6 was written**, and it is not a "no harness
workflow exists" case — `SUMMARY_REGENERATE` (entry points #2 sync `generateSummary` / #4 async
`generateSummaryAsync`) **does** have a harness-capable trigger. TASK-704 explicitly decided,
permanently, that the SYNC route (entry #2) never uses it:

```
// summary.service.ts:453-500 (verbatim comment, TASK-704's own decision record)
// TASK-704 — DECIDED (see ticket README §6/§7): this sync route does NOT
// call `noteGenerationService.generate` and does not start a harness
// workflow, permanently, not just pending sign-off.
//
// Two independent reasons ... 1. Duplicate generation ... 2. Response-
// contract mismatch [synchronous HTTP response vs. the harness workflow's
// asynchronous produce-via-callback shape] ...
```

`SummaryService.generateSummary` (sync) still runs its own independent prompt-assembly + SMR call
(the "third generator," ticket §2.2) and — unlike the OLD `summary.processor.ts` before TASK-714 —
**already writes a `SummaryMeta` row** (`summary.service.ts:637-654`,
`SummaryMetaFactory.CreateSummaryMeta`), just never with `assuranceCompletedAt`/`gateDecision` set
(both stay `null`, so `signedBeforeAssurance` at `:867/959` reads `true` unconditionally for every
sync-generated note — a pre-existing, always-true annotation, not a bug this ticket introduces or
is asked to fix; flagging it as a finding for whoever owns TASK-714/732's assurance surface next,
not acting on it here).

**Consequence for Task 8/11:** the pre-summary/comprehensive-summary decision table (§2.6) needs a
**fourth row** — `SummaryService.generateSummary` (sync `SUMMARY_REGENERATE`) — with its own
distinct reasoning (architectural HTTP-contract mismatch, not "no workflow exists") and its own
answer. Unlike pre-summary/comprehensive-summary, this entry point is *capability-equivalent* to
one that DOES route to harness (the async sibling, entry #4) — a user with a harness-enabled tenant
who calls the sync endpoint gets the OLD legacy generator every time, forever, by design. Whether
that's acceptable long-term UX (silently different behavior between the sync and async routes for
the same trigger) is a product question Task 8 must now also answer, not one this document decides.

### 0.2 Deleting `summary.processor.ts` breaks `generateSummaryAsync` unless the controller is rewritten too — a file the original ticket's Task 9 never listed

Entry point #4 (`POST :id/summary/async`) **is** routed through the seam — but the routing decision
lives inside `SummaryProcessor.process()` (`summary.processor.ts:252-271`), which the controller
never sees. The controller's `generateSummaryAsync` handler
(`apps/api/src/modules/consultation/consultation.controller.ts:1204-1228`) unconditionally calls
`ConsultationJobService.createSummaryJob`, which unconditionally enqueues onto the `GenerateSummary`
BullMQ queue with **no branch on `harnessEnabled` at the enqueue site at all** — the branch only
happens later, when a worker dequeues the job and `SummaryProcessor.process()` runs.

**This means Task 9's original file list (§4 Task 9 of the ticket) is incomplete.** Deleting
`summary.processor.ts` (the only place the seam decision for this trigger is evaluated) and
`createSummaryJob` (the enqueue call) without also rewriting
`ConsultationController.generateSummaryAsync` to call `noteGenerationService.generate(...)`
directly leaves entry point #4 with no implementation at all — not a graceful fallback, a hard
break (the route would still be decorated and reachable, calling a method that no longer exists).
**`apps/api/src/modules/consultation/consultation.controller.ts` must be added to Task 9's edit
list**, rewriting `generateSummaryAsync` to call the seam directly and return the
already-established "started" response shape for a harness decision (the pattern entry point #1
already uses, and the pattern TASK-704 §6/§7's own comment names as the correct shape for a
synchronous-HTTP/asynchronous-harness contract mismatch). By the time Phase 3 runs, `harnessEnabled`
is `true` for 100% of tenants (Phase 2's SYSTEM-default flip is a Phase-2 exit criterion), so the
seam's decision for this trigger is structurally always `'harness'` at that point — but the code
must not assume that; it should still read the seam's actual decision, not hardcode it.

---

## 1. The manifest table

`path → action → reason → tests that must still pass after`. Line numbers are as of this pass
(2026-08-16, `e2e54c1f2` and after) — **re-verify immediately before Task 9 executes**, since this
tree has been observed changing under active parallel sessions during this very pass (see
`readiness-checklist.md`'s tree-stability note).

| Path | Action | Reason | Tests that must still pass after |
|---|---|---|---|
| `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts` (599 LOC — grew from the ticket's cited 389 via TASK-714's `applyLegacySafetyFloor()`) | **DELETE** | Legacy `SUMMARY_REGENERATE` async generator, incl. TASK-714's floor (§0.1/§0.2 above name the two things that must move BEFORE this deletion is safe: the sync route was never routed here anyway, so it is unaffected; the async route's seam-decision logic dies with this file and must be relocated to the controller first) | `consultation-job.service.test.ts`, `job-queue.integration.test.ts`, `harness/` suite (unaffected — confirms nothing leaked) |
| `packages/applications/src/services/consultation/jobs/processors/__tests__/summary.processor.summary-meta-floor.test.ts` (TASK-714, new) | **DELETE** | Tests the deleted file's floor method | — |
| `packages/applications/src/services/consultation/jobs/__tests__/summary.processor.test.ts`, `summary.processor.tenant-explicit.task635.test.ts`, `summary.processor.lineage.task635.test.ts` | **DELETE** | Tests the deleted file | — |
| `packages/applications/src/services/consultation/jobs/processors/legacy-dosage-check.util.ts` (129 LOC, TASK-714) | **DELETE** | TASK-714's floor utility — throwaway by its own ticket's design (§1: *"deleted by the same epic that retires legacy"*) | `pnpm --filter @arcaai/applications build` (confirms nothing else imports it — this pass confirmed via `grep -rl legacy-dosage-check packages/applications/src` returning only the processor and this util's own test) |
| `packages/applications/src/services/consultation/jobs/processors/__tests__/legacy-dosage-check.util.test.ts` | **DELETE** | Tests the deleted util | — |
| `packages/applications/src/services/consultation/jobs/processors/ner.processor.ts` (253 LOC — the ticket cited 237; drift is cosmetic, not structural) | **DELETE** | Legacy NER extraction generator | `ner.processor.encryption.test.ts` target deleted too (see next row); `consultation-event.handler.test.ts` |
| `packages/applications/src/services/consultation/jobs/__tests__/ner.processor.test.ts`, `.../processors/__tests__/ner.processor.encryption.test.ts` | **DELETE** | Tests the deleted file | — |
| `packages/applications/src/services/consultation/jobs/processors/index.ts` | **EDIT** — remove `export * from './summary.processor'` and `export * from './ner.processor'` (currently lines 1 and 3 of 4; `pre-summary.processor`/`comprehensive-summary.processor` exports survive pending Task 8) | Public-API barrel leak (ticket §2.1 hazard, still accurate) | `pnpm --filter @arcaai/applications build` (a stray import of `SummaryProcessor`/`NerProcessor` anywhere fails the build immediately) |
| `packages/applications/src/services/consultation/jobs/consultation-job.service.module.ts` | **EDIT** — remove: import lines for `SummaryProcessor` (currently `:10`) and `NerProcessor` (`:12`); providers `SummaryProcessor` (`:58`) and `NerProcessor` (`:60`); `BullModule.registerQueue(...)` entries for `JobQueue.GenerateSummary` (`:46`) and `JobQueue.ExtractNamedEntities` (`:48`, inside the same call at `:44-49` — edit the array, don't remove the whole call, `GeneratePreSummary`/`GenerateComprehensiveSummary` survive pending Task 8). **Re-verify whether `HarnessAuditServiceModule` (`:24` import, `:41` in the `imports` array) is still needed** — it was added by TASK-714 specifically for the floor's WORM event inside `summary.processor.ts`; confirm no OTHER provider in this module (`PreSummaryProcessor`, `ComprehensiveSummaryProcessor`, `ConsultationEventHandler`) also depends on it before removing — **this pass did not exhaustively check that; Task 9 must, with a grep, before deleting the import.** | Real drift from the ticket's cited `:10,12` / `:54,56` / `:35,37` — line numbers shifted because TASK-704 and TASK-714 both added imports/providers to this module ahead of the summary/ner entries. The ticket's own §2.1 numbers are stale; use the ones in this row. | `pnpm --filter @arcaai/applications build` after each edit (leaf → barrel → module, per the ticket's own Task 9 approach) |
| `packages/applications/src/services/consultation/jobs/consultation-job.service.ts` | **EDIT** — remove `createSummaryJob` (interface `:31`, impl `:161-217`, `summaryQueue` injection `:85`) and `createNerJob` (interface `:51`, impl `:287-...`, `nerQueue` injection `:87`) **and the generic job-status/cancel dispatcher's `switch (status.type)` at `:378-393`**, which has a `case 'SUMMARY': queue = this.summaryQueue;` (`:383-384`) and `case 'NER': queue = this.nerQueue;` (`:389-390`) arm each — verified present this pass, NOT named anywhere in the ticket's original §2.2/§4 Task 9. Both `case` arms must be removed from the switch (leaving `PRE_SUMMARY`/`COMPREHENSIVE_SUMMARY` pending Task 8); the `default: return false` fallthrough already handles an unrecognized type safely, so no new default-branch behavior is needed. `createPreSummaryJob`/`createComprehensiveSummaryJob` survive pending Task 8. | Real drift from the ticket's cited `:31,161` (still accurate for the interface/impl start, but the ticket did not know about the `:378-393` generic dispatcher, which is a NEW finding this pass — the ticket's own file list under-scopes this file) | `consultation-job.service.test.ts` |
| `apps/api/src/modules/consultation/consultation.controller.ts` — `generateSummaryAsync` (`:1204-1228`) | **EDIT** (NOT in the ticket's original Task 9 file list — added by §0.2 above) — rewrite to call `noteGenerationService.generate(GenerationTrigger.SUMMARY_REGENERATE, {...})` directly (mirroring the pattern the auto-pipeline handler already uses) instead of `consultationJobService.createSummaryJob`; return the harness "started" response shape. **Do not touch `generatePreSummaryAsync` (`:1241-...`) or `generateComprehensiveSummaryAsync` (`:1308-...`)** — those stay on `createPreSummaryJob`/`createComprehensiveSummaryJob`, which survive pending Task 8. | §0.2 — the seam-decision site (`summary.processor.ts`) is being deleted; the controller is the only remaining caller who can make this decision after that | New/updated test for `generateSummaryAsync` in `consultation.controller` unit tests (find the existing suite first); `apps/api:build`; the existing `api-key-scope-audit.test.ts` (asserts the METHOD NAME `generateSummaryAsync` still exists on `ConsultationController` — do not rename it, per ticket pitfall 7, confirmed still binding) |
| `packages/applications/src/__tests__/cross-tenant-coverage.test.ts` — `PROCESSOR_COVERAGE` (currently `:264-294`; `name:` lines at `:266,272,278,284` — **unchanged from the ticket's citation**, no drift here) | **EDIT** — remove the `summary.processor` (`:265-270`) and `ner.processor` (`:283-288`) entries in the SAME commit as their test-file deletions | Ticket pitfall 2, re-confirmed still accurate and un-drifted | `cross-tenant-coverage.test.ts` itself |
| `apps/api/src/bootstrap/api-key-scope-audit.ts` (`:48` `generateSummaryAsync`, `:49` `generatePreSummaryAsync` — **the ticket's §2.7 only names `:45` for `generateSummaryAsync`; `generatePreSummaryAsync` is ALSO registered here and the ticket's re-derivation missed it**) | **KEEP, unchanged** | Both route method names survive (neither is renamed by this manifest's plan) | `api-key-scope-audit.test.ts` |
| `packages/domains/src/enums/JobQueue.enum.ts` — `GeneratePreSummary` (`:16`), `GenerateSummary` (`:17`), `GenerateComprehensiveSummary` (`:18`), `ExtractNamedEntities` (`:19`) | **`GenerateSummary`/`ExtractNamedEntities`: DELETE, ONLY AFTER the BullMQ drain step in §2 below is confirmed complete.** `GeneratePreSummary`/`GenerateComprehensiveSummary`: **KEEP pending Task 8.** (Ticket's cited line numbers `:17,19` — unchanged, no drift.) | Ticket pitfall 5 / R-5 — an enum member removed while jobs sit in Redis orphans them silently; this ticket (this pass) does NOT touch this file | Whichever suites reference `JobQueue.GenerateSummary`/`JobQueue.ExtractNamedEntities` directly — grep before deleting, per the grep-gate pattern (Task 13) |
| `packages/applications/src/services/consultation/events/consultation-event.handler.ts` — fork 1 FALSE branch (currently `:201-244`, unchanged shape from the ticket's `:146`-area citation; exact line numbers shifted slightly, e.g. the seam call is now at `:181` not `:172` — re-grep at Task 9 time) | **EDIT** — delete the FALSE-branch body (prompt resolution + `createSummaryJob` call, `:202-244`) once `createSummaryJob` no longer exists | Dead code once the legacy branch is unreachable (harnessEnabled is 100% true post-Phase-2) | `consultation-event.handler.test.ts` |
| `packages/applications/src/services/consultation/events/consultation-event.handler.ts` — fork 2 (currently `:341-361`, the `if (config.harnessEnabled) {...skip...} else {createNerJob...}` block — the SAME site the TASK-704 grep-gate test allow-lists by name) | **EDIT** — once `createNerJob`/`ExtractNamedEntities` are gone, the `else` branch has nothing left to call; collapse to the unconditional skip-and-emit-completed body. **This ALSO means the grep-gate's allow-list entry (`harness-enabled-single-reader.grep-gate.test.ts`, `ALLOWED_SITE`) becomes stale and must be removed in the same commit** — a second `harnessEnabled` reader that no longer exists should not stay allow-listed; Phase 4 Task 13 (grep-gate hardening) is the natural place to catch this, but Task 9 should not leave a passing-but-meaningless allow-list entry behind. | This is the ticket's own §3.1 "expand/contract on the flag" principle applied to the SECOND reader, not just the seam's own — a finding this re-derivation adds, not present in the ticket's original Task 9 scope | `consultation-event.handler.test.ts`; `harness-enabled-single-reader.grep-gate.test.ts` (re-run after edit — must still pass with an EMPTY or removed allow-list, not a stale one) |

---

## 2. R-5 — the BullMQ drain step (must precede the `JobQueue` enum edit above)

This ticket's own §4 Task 4 places the drain procedure in the (Phase 2, out-of-this-pass) migration
runbook. R-5's specific ask this pass — "document the BullMQ drain step that must precede any
queue-enum change" — is satisfied here, ahead of Phase 2's full runbook, so Task 9 has a concrete
procedure to point at when it reaches the enum edit:

1. **Freeze new enqueues onto `GenerateSummary`/`ExtractNamedEntities` first.** By the time Phase 3
   runs, the SYSTEM default is `true` (Phase 2 exit criterion) and §0.2's controller rewrite means
   nothing in the codebase enqueues onto these two queues anymore — but a Redis queue can still hold
   jobs enqueued by an OLDER, not-yet-redeployed instance of the API/worker mid-rollout. Do not treat
   "the code no longer enqueues" as equivalent to "the queue is empty."
2. **Confirm zero waiting/active/delayed jobs before touching the enum.** BullMQ exposes queue
   counts directly (`Queue.getJobCounts()` / `getWaitingCount()` / `getActiveCount()` /
   `getDelayedCount()` — the same primitives `RedisCacheModule`/`BullModule.registerQueue` already
   wire up for every queue in this codebase, no new dependency needed). A one-off check script
   (mirroring this ticket's own `scripts/harness-migration-readiness-report.ts` and TASK-730's
   `scripts/harness-availability-report.py` — a read-only report against live infra, not a new
   durable service) is the right shape: connect to Redis, instantiate a `Queue('GenerateSummary')`
   and `Queue('ExtractNamedEntities')`, print all four count buckets, and refuse (exit non-zero) if
   any is non-zero. **Not built this pass** — Task 4 (Phase 2 runbook, out of scope here) is where
   it belongs, listed here so Task 9 does not skip straight to the enum edit without it existing.
3. **If jobs remain, let them drain naturally (workers stay up, no new enqueues) rather than force-
   removing them.** A force-removed `GenerateSummary` job is a consultation that silently never gets
   its note — exactly the missing-note failure mode Phase 1 Task 2 measures. Drain time is
   bounded by BullMQ's existing `attempts: 3` / exponential backoff on these jobs (visible in
   `consultation-job.service.ts`'s `createSummaryJob` — `attempts: 3, backoff: { type:
   'exponential', delay: 1000 }`), so the worst case is a few minutes per stuck job, not indefinite.
4. **Re-run the zero-count check after the drain window, then and only then edit the enum.** The
   enum edit is a single-line-per-member removal — the drain confirmation is the actual safety work,
   and it must complete (with evidence pasted into whatever Task 9 execution log exists) before that
   line is touched, per the ticket's own pitfall 5 and the DO-NOT list this pass was given
   ("touch no JobQueue enum member").

---

## 3. R-3 — `PreSummaryProcessor` restated explicitly (not deleted by anything in this manifest)

Per the ticket's own §2.3/§3.3 pitfall 1 and this pass's DO-NOT list, **`PreSummaryProcessor`
(`jobs/processors/pre-summary.processor.ts`, 317 LOC) is named here to guarantee it is NOT
mistaken for a summary/ner sibling and pattern-matched into the DELETE column above.** It is not in
`design.md` §Deprecations, its fate is explicitly Task 8's call (§2.6/§0.1 above), and this
manifest's DELETE rows are limited to `summary.processor.ts`/`ner.processor.ts` and TASK-714's
floor utility only. Re-stated in the manifest table itself (not just this section) is deliberate:
`jobs/processors/index.ts`'s edit row above explicitly says `pre-summary.processor` /
`comprehensive-summary.processor` exports survive, and `consultation-job.service.module.ts`'s edit
row explicitly keeps their providers and `registerQueue` entries.

---

## 4. What this manifest does NOT decide

Per the ticket's own Task 8 (HUMAN-GATED) and this pass's scope: whether `PreSummaryProcessor`,
`ComprehensiveSummaryProcessor`, and (per §0.1's new finding) `SummaryService.generateSummary`'s
sync legacy body are kept-as-non-signable-helpers, deleted as a product-capability retirement, or
(for the sync case, uniquely) reconciled with their async siblings some other way, is **not decided
here**. §0.1 adds a fourth entry point to that decision's scope; it does not pre-empt the decision
itself.
