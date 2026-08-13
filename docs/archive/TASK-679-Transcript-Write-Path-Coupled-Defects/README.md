# TASK-679 — Transcript write path: the two coupled defects

| Field | Value |
|---|---|
| **Status** | `Review` |
| **Type** | bugfix |
| **Branch** | `dev-2.1` |
| **Predecessor** | TASK-676 §3.5 (`docs/implementation/TASK-676-STT-Cascade-Bridge-Investigation/README.md`) — identified both defects and their coupling |
| **Ticket number** | Assigned as the next free number after `TASK-678` in `docs/implementation/`. `docs/archive/` was not readable in this session; confirm before merge if archived numbering could collide. |

---

## 1. Requirement Analysis

Two defects on the transcript write path that **must** be fixed together — fixing either
alone is worse than fixing neither.

**Bug 1 — every SDK per-segment transcript POST was silently rejected.**
`useArcaAudio` posted a `ContextItem` per final segment carrying `structuredData`. That field
is not declared on `AddContextRequest`, and the global pipe runs `forbidNonWhitelisted`, so
every POST returned `400 property structuredData should not exist`. The SDK swallowed it into
`logger?.error`.

**Bug 2 — the STT finalize existence guard was too broad, and hid behind bug 1.**
`createStreamingTranscriptInner` guarded on `findTranscripts(consultationId).length > 0` — a
filter on **type alone** — and returned early *before* creating the aggregate transcript and
*before* emitting `TranscriptionCreated`.

**The coupling.** `TranscriptionCreated` is the sole trigger for `ConsultationEventHandler` →
harness note generation. Bug 1 masked bug 2 because no SDK row ever landed. Fix bug 1 alone and
the first per-segment row satisfies the guard, the aggregate is skipped, and **no clinical note
is ever generated — silently, with no error.**

---

## 2. Current State Evaluation

- `structuredData` was never wired server-side at all: `ContextService.addTranscription` takes
  it as `_structuredData` (deliberately ignored). The field the DTO *does* declare, and which
  is persisted (`ContextItem.metaData`) and read (`subType`, `extractedText`), is `metadata`.
- The same mismatch existed at **eight** SDK call sites, not one: `useArcaAudio` (1),
  `useArcaContext` (4), `useArca` (3), plus `useArcaSession.addContext` which posts an
  `AddContextInput` verbatim. Every one of them 400'd whenever a caller supplied metadata.
- The STT aggregate and the SDK per-segment rows are indistinguishable by `type` **and** by
  `source` (both `TRANSCRIPTION`), so narrowing needed a new discriminator.

---

## 3. Implementation Summary

### 3.1 Bug 1 — send what the gateway declares

Decision: **stop sending `structuredData`; send `metadata`.** Rationale — `metadata` is the
declared, persisted, consumed field; `structuredData` was ignored server-side by construction.

TASK-613's per-utterance pipeline provenance does **not** depend on this POST: `pipelineId` is
written into the store segment (`store.addTranscriptSegment`), which is a separate path. It is
now *also* carried on the persisted row (additively), so the provenance survives in both places.

| File | Change |
|---|---|
| `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts` | `structuredData:` → `metadata:`, plus `subType: TRANSCRIPT_SEGMENT_SUBTYPE` and the TASK-613 `pipelineId` |
| `packages/agentic-sdk-v2/src/hooks/useArcaContext.ts` (×4), `useArca.ts` (×3) | `structuredData: metadata` → `metadata` |
| `packages/agentic-sdk-v2/src/hooks/useArcaSession.ts` | folds a deprecated `input.structuredData` into `metadata` on the wire |
| `packages/agentic-sdk-v2/src/types/context.ts` | **additive**: `AddContextInput.metadata` added; `structuredData` kept and `@deprecated` so existing callers still compile |
| `packages/agentic-sdk-v2/src/core/constants.ts` | new `TRANSCRIPT_SEGMENT_SUBTYPE` |

No exported hook signature changed — the public `metadata` parameter was always named
`metadata`; only the wire field it mapped to was wrong. Compat surface is untouched (additive
only).

### 3.2 Bug 2 — narrow the guard to the aggregate

New module `packages/applications/src/common/transcript-provenance.ts`:

- `STT_AGGREGATE_SUBTYPE` / `TRANSCRIPT_SEGMENT_SUBTYPE` markers;
- `isSttAggregateTranscript(item)`.

Both STT write sites now stamp `metaData = { subType: 'STT_AGGREGATE' }`, and the streaming
finalize guard keys on `existing.find(isSttAggregateTranscript)` instead of `existing.length`.

The predicate is evaluated **server-side and does not trust the client**:

1. positive marker `STT_AGGREGATE` → aggregate;
2. any other `subType` (notably `TRANSCRIPT_SEGMENT`) → not the aggregate;
3. no marker at all → aggregate **iff** `createdBy` is null or the system user. Rows written
   before this ticket carry no marker, and the internal STT path has no CLS user, whereas a
   client write through `ContextService.addContext` always stamps the real requesting user id.

Clause 3 is what preserves idempotency for consultations finalized before this deploy, and it
is also why a client that omits the segment marker still cannot suppress the aggregate — its
`createdBy` gives it away.

### 3.3 Tests

| Test | Asserts |
|---|---|
| `common/__tests__/transcript-provenance.test.ts` | the predicate on all five row shapes, incl. the legacy-row clause |
| `stt/internal/__tests__/sttInternal.service.test.ts` — *"still writes the aggregate … when only per-segment SDK transcripts exist"* | **direction 1**: two segment rows present ⇒ aggregate still created, marker stamped, `TranscriptionCreated` emitted exactly once |
| same file — *"still idempotent against a previously written aggregate that sits among segment rows"* | **direction 2**: aggregate among segment rows ⇒ no create, no emit, existing id returned |
| same file — pre-existing *"is idempotent — skips create + emit…"* | unchanged and still green (legacy unmarked row) |
| `consultation/context/__tests__/add-context.request.sdk-contract.test.ts` | replays the exact SDK bodies through a `ValidationPipe` configured identically to `main.ts`: the new bodies validate; the old `structuredData` spelling still 400s |

`TranscriptionCreated` firing exactly once per consultation is covered by the emit-count
assertions in both new tests plus the pre-existing *"emits TranscriptionCreated once…"* test;
harness note generation is downstream of that single event and unchanged.

---

## 4. Verification Evidence

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/applications test` | **474 files passed, 1 skipped · 8906 tests passed, 4 skipped** |
| `pnpm --filter @arcaai/applications build` | exit 0 |
| `pnpm --filter @arcaai/vox test` | **265 files passed · 4173 tests passed** |
| `pnpm sdk:build` | 7/7 tasks successful |
| `pnpm api:build` | 10/10 tasks successful |
| `pnpm --filter @arcaai/compat-playground build` | ✓ built (additive-only SDK change verified against the compat consumer) |
| `pnpm test:unit` | **991 files passed, 1 failed, 2 skipped · 16805 passed, 1 failed** |
| `pnpm lint` | 34/34 tasks successful — **0 errors**, 65 pre-existing `eslint-comments/require-description` warnings, none in files this ticket touched |

### The one `test:unit` failure is not this ticket's

`scripts/__tests__/env-sync.test.ts` — env-surface drift: the generated doc records
`turbo.json#globalEnv` = 160, the tree has 158. This ticket adds **no** env var and does not
touch `turbo.json`, the env descriptors, or `scripts/`. The working tree carries unrelated
edits from a concurrent session (`packages/applications/src/services/billing/billing.service.ts`,
`apps/harness/.../tests/unit/temporal/*`), which is the likelier source. Fix is `pnpm env:sync`,
owned by whoever changed the env surface.

An earlier full run also showed 9 failures across 7 `packages/domains` generated-repository
tests (`Cannot read properties of undefined (reading 'prototype')` on a dynamic import). All
passed on re-run and pass in isolation — parallel-import flakes in the generated barrels, and
this ticket modifies no file under `packages/domains`.

---

## 5. Known follow-ups (out of scope, deliberately)

- **Per-segment rows now emit `ContextAdded`.** `LIVE_CONTEXT_TYPES` includes `TRANSCRIPT`
  (TASK-660), so a successful per-segment write now fans out one `ContextAdded` per utterance.
  `LiveDocumentationService` and `OcrEnrichmentProcessor` both filter it out by their own kind
  filters (TASK-676 §3.2); `LoopContextSignalService` accepts it but is gated on
  `HARNESS_LOOP_ENABLED`. Volume/routing under that flag belongs to the TASK-676 successor.
- **The 200k `LOOP_SIGNAL_CONTENT_MAX_LENGTH` truncation is still silent** (TASK-676 §3.6).
- **The batch path (`createTranscript` with a `jobId`) has no existence guard at all** — it is
  now marked for classification, but unguarded, exactly as before.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-12 | Both defects fixed together; tests added in both directions. Gates recorded in §4. |
