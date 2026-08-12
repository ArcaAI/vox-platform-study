# TASK-670 — Loop Signal Payload Completeness

**Status:** Completed

**Type:** feature (payload completeness / wiring). **Base commit:** `d5c43c033` on
`dev-2.1` (`merge(TASK-666): admin console context schema editor`). This worktree
spawned off `dev` (`180d09d6a`) — the known repo default — and was
`git reset --hard dev-2.1` before any work, per rule 09's worktree-agent guidance.

## 1. Requirement Analysis

TASK-660 built the gateway→harness loop signal path; TASK-662 built the workflow
that consumes it. Both shipped honest "Incomplete" sections naming the exact
gaps this ticket closes:

1. **`ContextAddedSignal.text` is effectively empty for anything beyond a short
   preview.** `HarnessGatewayService.signalContextAdded` only ever sent
   `contentPreview` (a 2,000-char snippet built for `LiveDocumentationService`,
   not for a specialist). `vision.extract_text` / `nlp.extract_entities`
   (TASK-664, not merged here) need real text to act on.
2. **`HarnessGatewayService` sent no `kindKey`, `occurredAt`, or `depth`.** The
   harness-side receiver (`LoopContextAddedRequest` in
   `apps/harness/.../internal.py`) already tolerated their absence via a
   fallback chain, but a gateway that never sends them means TASK-664's
   depth-cap budget is nominal, not real.
3. **No caller for `consultation-ending` / `loop-cancel`.** Both harness-side
   receivers exist and are tested (TASK-662); nothing in `apps/api` called
   them.
4. **The loop must stay off by default.** `HARNESS_LOOP_ENABLED` (default OFF)
   must still gate everything.

**Constraint:** TASK-664 (the reasoning primary + specialists) is committed but
**not merged** into `dev-2.1` — it is blocked on an unrelated in-flight
refactor. This ticket builds the **producer side** only, against the `dev-2.1`
state TASK-662 actually shipped (verified below), and does not depend on
TASK-664's branch.

## 2. Current State Evaluation (verified against `d5c43c033`)

- TASK-662's gateway-side artifacts (`LoopConfigService`,
  `ConsultationLoopEventService`, `LoopContextSignalService`,
  `HarnessInternalController`'s loop routes) are **already merged** — TASK-662
  landed both the harness workflow AND its gateway-side config resolver in
  this base commit, contrary to the parent ticket's framing of TASK-662 as
  harness-only. `HarnessGatewayService.signalContextAdded` and
  `LoopContextSignalService.handleContextAdded` already existed; they just
  sent an incomplete body.
- Harness-side, `apps/harness/src/harness/api/endpoints/internal.py` already
  had all three signal routes (`signal/context-added`,
  `signal/consultation-ending`, `signal/loop-cancel`) built, tested, and
  documenting the exact gap this ticket closes (`LoopContextAddedRequest`'s
  docstring named `kindKey`/`occurredAt`/`depth` as "the loop's richer
  vocabulary" not yet sent).
- `ContextAddedPayload` (`packages/applications/.../events/consultation.events.ts`)
  carried `contentPreview` (a 2,000-char cap, `preview.slice(0, 2000)`, shared
  by `LiveDocumentationService`'s live-fold prompt) but no `kindKey`, `depth`,
  or fuller body.
- No entity/DTO anywhere carried a cascade-depth concept. `ContextItemEntity`
  has no `depth`/`parentContextItemId` column (and this ticket carries no
  migration), so "derived context increments depth" needed a mechanism, not
  just a field to forward.
- `ConsultationController.stopRecording` (`POST :id/recording/stop`) already
  called `liveDocumentationService.stop()` then `consultationService.stopRecording()`
  — exactly the site the ticket names — but nothing signaled the loop.
- No "consultation-cancel" lifecycle action exists anywhere in the merged
  codebase (see §5 Incomplete).

## 3. Implementation Plan

### 3.1 Body: inline vs. claim-check — the decision, stated

**Decision: inline, not `ClaimCheckRef`.** A new `content` field rides the
existing `ContextAdded` → `signalContextAdded` → `LoopContextAddedRequest`
wire, capped at `LOOP_SIGNAL_CONTENT_MAX_LENGTH` (= `CONTEXT_CONTENT_MAX_LENGTH`,
200,000 characters — the SAME hard ceiling `AddContextRequest.content` already
enforces at the API boundary).

**Reasoning:**
- **Size headroom is real.** 200,000 UTF-8 characters is at most ~800 KB even
  in a worst-case 4-bytes/char encoding (clinical text in practice runs much
  closer to 1 byte/char) — comfortably under Temporal's per-payload gRPC
  ceiling (the `ClaimCheckRef` machinery in `apps/harness/.../claim_check.py`
  exists for payloads at or above the *history* budget, ~50 MB, with a
  per-payload ceiling on top of that; existing offload thresholds in this
  codebase — `HARNESS_CLAIM_CHECK_MIN_BYTES` default 64 KiB,
  `mcp.max_result_bytes` default 64 KiB — are themselves an order of magnitude
  BELOW 200,000 chars, so re-using the API's own content cap does not pretend
  claim-check payloads don't exist; it just means a NORMAL context write never
  needs one).
- **A claim-check integration is structurally blocked at the signal-handler
  layer, not just unbuilt.** TASK-662's own §"Signal safety" invariant is
  "never call an activity from a handler." `contextAdded` is a Temporal
  **signal handler** (via signal-with-start). Resolving a `ClaimCheckRef`
  requires an out-of-band store round-trip, which is exactly an activity call
  — so the loop CANNOT resolve a ref inline in the signal path without
  breaking its own documented determinism/safety rule. A correct claim-check
  path would have the CONSUMING SPECIALIST (a child workflow / activity,
  TASK-664) resolve the ref itself, not the signal handler — this is
  precisely why `document.extract_text` is unaffected: it already sidesteps
  the whole question by fetching from the gateway directly inside its own
  activity, rather than relying on anything inline in the signal.
- **No TS-side blob-store client exists**, and the harness receiver
  (`LoopContextAddedRequest`) had no `textRef`/`contentRef` field wired to the
  wire at all (`ContextAddedSignal.text_ref` exists on the INTERNAL Temporal
  model but was never populated from the HTTP body) — building one from
  scratch, end-to-end, for a case that cannot occur today (every write that
  reaches `ContextAdded` is already ≤ 200,000 chars) would be inventing
  machinery ahead of the concrete need, not delivering payload completeness.

**What this means concretely:** `ContextAddedPayload.content` (TS) →
`HarnessContextAddedSignal.content` (wire, JSON key `content`) →
`LoopContextAddedRequest.content` (harness receiver, optional, additive) →
`ContextAddedSignal.text` via `resolved_text()` (prefers `content`, falls back
to the older `contentPreview` for an un-upgraded caller). `contentPreview`
itself is UNCHANGED — still 2,000 chars, still LiveDoc's exclusive input — so
this ticket never touches LiveDoc's live-fold behavior.

### 3.2 Depth: derivation + proof it increments

There is no `depth`/`parentContextItemId` column on `ContextItem` (and this
ticket carries no migration), so the mechanism is: an OPTIONAL
`derivedFromContextItemId` field on `AddContextRequest` — a caller (a future
TASK-664 specialist, or any programmatic caller) names the context item this
NEW one was derived from. `ContextService.addContext`:

1. Resolves `depth` via a new private `resolveCascadeDepth(derivedFromContextItemId, tenantId)`:
   absent lineage ⇒ `0` (the overwhelming majority of writes never touch this
   path); present ⇒ load the parent (`contextItemRepository.findById`), verify
   same-tenant, read `parent.metaData.loopDepth` (default `0`), return `+ 1`.
   Best-effort: a missing/cross-tenant/malformed reference degrades to `0`
   rather than failing the write (lineage bookkeeping must never block
   clinical content).
2. Persists `metaData.loopDepth = depth` on the NEW item — but **only** when
   `derivedFromContextItemId` was named. A normal write's `metaData` shape is
   completely unchanged (verified: the pre-existing
   `emits ContextAdded with the lab subType for an ATTACHMENT and persists
   metadata` test, which asserts `capturedCreateEntity.metaData` with a strict
   `toEqual`, was NOT touched and still passes).
3. Emits `depth` on `ContextAddedPayload`.

**Proof it increments — `context.service.context-added.test.ts`, new case
`derivedFromContextItemId resolves depth = parent.depth + 1 and persists
metaData.loopDepth`:** a parent item stubbed with `metaData: { loopDepth: 2 }`,
a child write naming it via `derivedFromContextItemId`, asserts the emitted
`ContextAdded` payload carries `depth: 3` AND the persisted entity's
`metaData.loopDepth === 3`. A companion case
(`depth 0 when no lineage is declared (regression)`) proves the untouched path
never sets `loopDepth` at all.

`OcrEnrichmentProcessor`'s re-emit (same `contextItemId`, not a new derived
item) forwards the item's OWN recorded `metaData.loopDepth` (default `0`)
unchanged — it is a re-emission of an existing item's content, not a new
generation.

### 3.3 `kindKey` / `occurredAt`

- `kindKey`: `saved.kindKey` (the tenant-declared kind, TASK-658) threaded onto
  `ContextAddedPayload` and forwarded verbatim. Absent when the write named no
  kind — the harness receiver's existing fallback (`kindKey → subType →
  contextType`) already covers that case.
- `occurredAt`: the SAME value already on `ContextAddedPayload.timestamp` (ISO
  string, the gateway's emission time) — no new field needed on the payload,
  just forwarded as `occurredAt` in the outbound signal body, matching the
  receiver's de-duplication identity (`{contextItemId}:{occurredAt}`).

### 3.4 Ending / cancel callers

- **`consultation-ending`** — wired. `HarnessGatewayService` gained
  `signalConsultationEnding` (mirrors `signalEdit`'s shape exactly:
  `POST /workflows/:id/signal/consultation-ending`). `LoopContextSignalService`
  gained a same-named wrapper (same `HARNESS_LOOP_ENABLED` gate,
  try/catch-and-log best-effort posture as `handleContextAdded`) and is now
  EXPORTED from `LiveDocumentationServiceModule` (previously internal-only) so
  `ConsultationController` can inject it. `stopRecording` calls it right after
  the two pre-existing calls (`liveDocumentationService.stop`,
  `consultationService.stopRecording`) — the exact site the ticket names.
- **`loop-cancel`** — the CALLER MACHINERY is built (`HarnessGatewayService
  .signalLoopCancel`, `LoopContextSignalService.signalLoopCancel`, same gate +
  best-effort posture, fully tested) but **not wired to a caller**. See §5.

### 3.5 Off-by-default proof

`LoopContextSignalService`'s `loopEnabled` getter (unchanged) gates
`handleContextAdded` AND the two new methods identically:
`String(configService.get('HARNESS_LOOP_ENABLED') ?? '').trim().toLowerCase()`
must be `'true'` or `'1'`. Every new method (`signalConsultationEnding`,
`signalLoopCancel`) starts with the same `if (!this.loopEnabled) return;` — a
consultation recorded and stopped with the flag unset/false makes ZERO calls
to `HarnessGatewayService`, proven by
`loop-context-signal.service.test.ts`'s `is a no-op when the loop is not
configured` cases for both new methods (mirroring the pre-existing
`handleContextAdded` no-op cases) and by
`consultation.controller.recording-stop.test.ts` calling through the REAL
`LoopContextSignalService` gate (not a stub) implicitly via
`signalConsultationEnding`'s own tested no-op behavior.

## 4. Implementation Summary

### 4.1 Files changed

**TypeScript — payload + signal plumbing**
- `packages/applications/src/services/consultation/events/consultation.events.ts`
  — `ContextAddedPayload` gains `kindKey?`, `depth?`, `content?`.
- `packages/applications/src/services/consultation/context/dto/add-context.request.ts`
  — new optional `derivedFromContextItemId` field.
- `packages/applications/src/services/consultation/context/context.service.ts`
  — `LOOP_SIGNAL_CONTENT_MAX_LENGTH` constant (exported), `resolveCascadeDepth`
    private method, `addContext` resolves + persists + emits depth/kindKey/content.
- `packages/applications/src/services/consultation/ocr/ocr-enrichment.processor.ts`
  — re-emit carries kindKey/depth/content (capped, since NLP `/extract` output
    has no length ceiling of its own).
- `packages/applications/src/services/consultation/harness/harness-gateway.service.ts`
  — `HarnessContextAddedSignal` gains `kindKey`/`occurredAt`/`depth`/`content`;
    new `HarnessConsultationEndingSignal` + `signalConsultationEnding`; new
    `HarnessLoopCancelSignal` + `signalLoopCancel`.
- `packages/applications/src/services/consultation/loop/loop-context-signal.service.ts`
  — `handleContextAdded` forwards the four new fields; new
    `signalConsultationEnding`/`signalLoopCancel` methods (same gate/posture).
- `packages/applications/src/services/consultation/loop/index.ts` —
  `LoopContextSignalService` now exported (was internal-only).
- `packages/applications/src/services/consultation/live-documentation/live-documentation.service.module.ts`
  — `LoopContextSignalService` added to `exports`.

**TypeScript — caller wiring**
- `apps/api/src/modules/consultation/consultation.controller.ts` — new
  `loopContextSignalService` constructor param (trailing, append-only);
  `stopRecording` calls `signalConsultationEnding`.

**TypeScript — tests**
- `packages/applications/src/services/consultation/context/__tests__/context.service.context-added.test.ts` — 6 new cases: 5 cascade-depth cases (no lineage ⇒ 0, resolves parent+1, parent with no recorded depth ⇒ 1, degrades to 0 on cross-tenant parent, degrades to 0 on missing parent) + 1 content-forwarding case.
- `packages/applications/src/services/consultation/loop/__tests__/loop-context-signal.service.test.ts` — updated the pre-existing body-shape assertion; 8 new cases (kindKey/occurredAt/depth/content forwarding, depth default, and 6 for the two new lifecycle methods).
- `packages/applications/src/services/consultation/harness/__tests__/harness-gateway.service.test.ts` — 7 new cases: `signalContextAdded`'s new fields (1), `signalConsultationEnding` (2), `signalLoopCancel` (2), PHI-safe-logging (2).
- `apps/api/src/modules/consultation/__tests__/consultation.controller.recording-stop.test.ts` (new) — 3 cases.
- `apps/api/src/modules/consultation/__tests__/consultation.controller.test.ts`, `consultation.controller.highlights.test.ts` — trailing constructor arg added (append-only, no behavior change).

**Python — harness receiver**
- `apps/harness/src/harness/api/endpoints/internal.py` — `LoopContextAddedRequest`
  gains an optional `content` field + `resolved_text()` (prefers `content`,
  falls back to `content_preview`); `signal_context_added` uses it.
- `apps/harness/src/harness/tests/unit/api/test_loop_signal_endpoints.py` — 2
  new cases (`content` wins over `contentPreview`; falls back when absent).

### 4.2 What I did NOT touch

- `apps/harness/.../workflows.py` — `HarnessDocWorkflow`'s body: untouched
  (hard constraint).
- `packages/agentic-sdk-v2/**`, `apps/admin-console/**`: untouched.
- `packages/applications/src/services/consultation-context-schema/**`,
  `packages/json-schema-subset/**`: untouched (refactor in flight).
- No Prisma migration; `metaData.loopDepth` is additive JSON, same pattern as
  the pre-existing `metaData.extractedText`/`metaData.subType`.
- `LiveDocumentationService`'s internals (flush, `buildSmrUserPrompt`,
  `groundEntitiesToNote`, the generation-counter/`AbortController` machinery,
  the throttle) and `contentPreview`'s value/cap: untouched.

## 5. Incomplete / Deferred

- **No caller for `loop-cancel`.** The machinery
  (`HarnessGatewayService.signalLoopCancel`,
  `LoopContextSignalService.signalLoopCancel`) is built, tested, and ready to
  call — but there is genuinely **no "consultation-cancel" / "abandon
  consultation" lifecycle action anywhere in the merged `dev-2.1` codebase**
  today. `ConsultationStatus` has no `CANCELLED`/`ABANDONED` value;
  `UpdateConsultationRequest`'s lifecycle enum is `OPEN`/`CLOSED` only; the
  only existing "cancel" verb in this domain
  (`PATCH /consultations/jobs/:jobId/cancel`) cancels ONE async summary job by
  `jobId`, not a consultation by `consultationId` — wiring `loop-cancel` there
  would misrepresent "one job cancelled" as "the whole consultation
  abandoned." Inventing a new consultation-lifecycle status/endpoint to give
  `loop-cancel` a home is a real feature, not a wiring task, and was judged
  out of this ticket's scope (Karpathy §2/§3 — no unrequested features, no
  scope creep past what a "signal payload completeness" ticket asks for).
  Whoever builds "abandon this consultation" should call
  `LoopContextSignalService.signalLoopCancel(consultationId, { reason })` from
  that new site — the plumbing is ready.
- **Real STT transcripts still never reach `ContextAdded`.** `sttInternal
  .service.ts` writes `TRANSCRIPT` context items directly via
  `ContextItemFactory.CreateContextItem` and emits only `TranscriptionCreated`
  — a DIFFERENT event `LoopContextSignalService` does not listen to (this was
  true before this ticket and TASK-660 explicitly recorded it as unchanged by
  the gate-widening). This means, in production, `nlp.extract_entities`
  (TASK-664, presumably transcript-driven) will see NO live-transcript signal
  until `sttInternal.service.ts` is wired into the loop plane — a decision
  deliberately left alone here: it touches the STT auto-pipeline
  (`ConsultationEventHandler`'s summary-generation trigger) which is outside
  "signal payload completeness" and risks a change with much broader blast
  radius than this ticket's stated scope.
- **`pnpm test:e2e` not run** — not one of this ticket's gates, and no live
  Postgres/Redis/Temporal stack was available in this worktree (same posture
  as TASK-660/662).
- **TASK-664 is not merged**, so the three unbacked action-registry keys
  (`vision.extract_text`, `document.extract_text`, `nlp.extract_entities`)
  still dispatch as `action.skipped`/`unsupported_action` in the harness. This
  ticket makes their EVENTUAL implementation possible (real text, real
  kindKey, real depth) but does not implement them.

## 6. Gate Evidence (actual output, this worktree, `d5c43c033` base)

Build order per rule 01 / execution-plan §1.1b:
`pnpm install` → placeholder `DATABASE_URL`/`DIRECT_URL` (no live Postgres) →
`pnpm db:generate` → `@arcaai/database` → `@arcaai/domains` → `@arcaai/applications`
→ tests → `apps/api` build → `pnpm test:unit` (needs `room`, `noise-filter`,
`vad`, `stt`, `med-ner`, `vox`, `ui` built first) → `pnpm lint`.

### Own measured baseline (via `git stash`, this worktree, `d5c43c033`, before any edit)

```
$ pnpm --filter @arcaai/applications test
 Test Files  469 passed | 1 skipped (470)
      Tests  8842 passed | 4 skipped (8846)

$ pnpm harness:test   (PYTHONPATH=$PWD/apps/harness/src)
================= 1081 passed, 4 skipped, 1 warning in 29.42s ==================
```

The ticket-stated baselines (applications ~8,857 · api:build 9/9 · lint 31/31
with 65 pre-existing `apps/api` warnings) were themselves approximate — my own
measured 469 files / 8,842 tests is what every number below is compared
against, per the ticket's explicit instruction.

### `pnpm --filter @arcaai/applications build`

```
> @arcaai/applications@0.0.1 build
> rimraf dist tsconfig.tsbuildinfo && tsc
EXIT:0
```

### `pnpm --filter @arcaai/applications test`

```
 Test Files  469 passed | 1 skipped (470)
      Tests  8863 passed | 4 skipped (8867)
```

Net **+21 tests, 0 new files** (all new cases added to existing test files: 6
in `context.service.context-added.test.ts` — 5 cascade-depth cases + 1
content-forwarding case, TDD item 3 proof — 8 in
`loop-context-signal.service.test.ts` (2 new kindKey/depth/content-forwarding
cases + 6 for the two new lifecycle methods), 7 in
`harness-gateway.service.test.ts` incl. the 2 PHI-safe-logging cases). Zero
failures.

### `pnpm api:build`

```
 Tasks:    9 successful, 9 total
Cached:    0 cached, 9 total
```

Matches the stated 9/9 baseline exactly.

### `pnpm test:unit`

```
 Test Files  979 passed | 2 skipped (981)
      Tests  16683 passed | 10 skipped | 9 todo (16702)
```

Includes the new `apps/api/.../consultation.controller.recording-stop.test.ts`
(3 cases). Workspace-scoped suites turbo also runs, all green:

```
packages/ui test:              Test Files  242 passed (242)   / Tests  656 passed (656)
packages/agentic-sdk-v2 test:  Test Files  263 passed (263)   / Tests 4173 passed (4173)
apps/compat-playground test:   Test Files   21 passed (21)    / Tests  223 passed (223)
apps/admin-console test:       Test Files  178 passed (178)   / Tests 1423 passed (1423)
```

Zero failures across every workspace.

### `pnpm lint`

```
@arcaai/applications:lint: ✖ 191 problems (0 errors, 191 warnings)
@arcaai/api:lint: ✖ 65 problems (0 errors, 65 warnings)
 Tasks:    31 successful, 31 total
```

`apps/api` matches the stated 65-warning baseline exactly. `@arcaai/applications`
reads 191 — verified by grepping the full lint output for every file this
ticket touched or added: `context.service.ts` carries exactly the same 8
pre-existing `eslint-comments/require-description` warnings (pinned to its 8
pre-existing `eslint-disable-next-line` comments, confirmed by line number);
every other touched/added file (harness-gateway.service.ts,
loop-context-signal.service.ts, ocr-enrichment.processor.ts,
add-context.request.ts, consultation.events.ts,
live-documentation.service.module.ts, loop/index.ts, all `__tests__/*` files,
`consultation.controller.recording-stop.test.ts`) contributes **zero**
warnings. `consultation.controller.ts` in `apps/api`'s lint output carries the
SAME 4 pre-existing directive-comment warnings TASK-660 already noted (line
numbers shifted by my insertions, rule/count unchanged).

### Harness gates (all via `PYTHONPATH="$PWD/apps/harness/src"`, per the
worktree/`arcaenv` editable-install pitfall)

```
$ pnpm harness:test
================= 1083 passed, 4 skipped, 1 warning in 29.46s ==================
```

Own baseline (measured via `git stash`, above): **1081 passed**. Net **+2**
(the two new `content`-precedence cases in `test_loop_signal_endpoints.py`).

```
$ pnpm harness:test -k replay
=============== 21 passed, 1066 deselected, 3 warnings in 4.92s ================
```

Unchanged from TASK-662's post-merge count (12 frozen `HarnessDocWorkflow`
fixtures + 8 `test_gating_consolidation_replay.py` + 1 loop fixture) —
expected, since this ticket never touches `workflows.py`.

```
$ pnpm harness:lint
All checks passed!

$ pnpm harness:typecheck
Success: no issues found in 96 source files
```

### PHI handling (TDD item 6)

Manually audited every `logger.log`/`.warn`/`.error`/`.debug` call in every
file this ticket touched (`harness-gateway.service.ts`,
`loop-context-signal.service.ts`, `context.service.ts`,
`ocr-enrichment.processor.ts`) — every logged object carries only ids, error
messages, booleans, or counts; none references `content`/`contentPreview`/
`text`/`preview`. Backed by two new tests in `harness-gateway.service.test.ts`
(`describe('PHI-safe logging')`) that spy on `Logger.prototype.log`, send a
recognizable clinical string through `signalContextAdded`/
`signalConsultationEnding`, and assert the logged payload never contains it.
Harness-side, `signal_context_added`'s `logger.info` call (unchanged by this
ticket) logs only `consultation_id`/`workflow_id`/`context_item_id`/
`kind_key`/`depth` — never `text`/`content`.

## 7. Commits

Staged in dependency order (payload shape → gateway/signal plumbing → caller
wiring → harness receiver), each carrying
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. SHAs recorded after
commit (final report).

## Change History

- 2026-08-12 — Initial implementation (this document).
- 2026-08-12: Status corrected to Completed — verified via git log (commit `48134cc2a`); implementation confirmed merged. Doc header was stale.
