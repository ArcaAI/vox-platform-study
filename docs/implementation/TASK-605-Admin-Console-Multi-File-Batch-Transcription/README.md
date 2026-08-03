# TASK-605 — Admin console: multi-file batch transcription with per-file result viewing

| Field | Value |
|---|---|
| **Status** | `Review` |
| **Type** | `feature` |
| **Branch** | `dev-2.1` |
| **Affected apps/packages** | `apps/admin-console` only (`src/features/playground-live-transcription/**`) |
| **Surface** | `/playground/live-transcription?tab=batch` (frame 51, capabilities-matrix row 35) |
| **Related tickets** | TASK-603 (compat batch upload — the `useArcaBatchTranscription` queue this mirrors), TASK-604 (native SDK batch queue), BUG-014 (stalled-query terminal states, still honoured), BUG-015 (worker stall found *while* testing multi-file upload) |
| **Governing rules** | `13-nextjs-apps.md` (BFF plane, TanStack Query, ticketed SSE), `07-react-ui.md`, `10-skeleton-loading.md`, `11-ux-ui-principles.md` |

---

## Requirement Analysis

The batch tab accepted exactly **one** file at a time and offered no way to read any
transcript — not a finished queue item's, not a past job's. Required:

1. Multi-file selection: `multiple` input **plus** multi-file drag & drop, keeping the
   single-pointer alternative the label-for-input pattern provides (WCAG 2.5.7).
2. A client-side queue with per-item state and **bounded concurrency**: dropping 20 files
   must not open 20 SSE connections. Default 2, matching the SDK hook.
3. Per-item cancel / retry / remove, plus clear-queue.
4. Master–detail results: a queue list whose rows select, and a detail panel showing
   streaming segments while a job runs and the authoritative `resultText` once it
   completes. Auto-select the first file of a drop; empty state when nothing is selected.
5. The recent-jobs table becomes useful: selecting a row opens that job's transcript in
   the same detail panel.
6. House UI rules: `<Skeleton />` (never spinners) for loading, `<Spinner />` only inside
   in-flight controls, a toast on every action, disabled controls state their reason,
   semantic tokens only.

### Backend contract (unchanged, verified working)

| Call | Shape |
|---|---|
| `POST /audio/transcription-jobs/transcribe` | multipart, **one file per request** (`file`, `pipelineId`, optional `language`, `consultationId`) → `{ id, status, sseUrl, audioUri }` |
| `GET /audio/transcription-jobs/{id}/stream?ticket=…` | SSE; the gateway ends the stream on a terminal status |
| `GET /audio/transcription-jobs/{id}` | the job incl. its transcript |

N files = N independent jobs. There is no batch endpoint and nothing is multiplexed, so
the fan-out is entirely a client concern.

---

## Current State Evaluation

`batch-tab.tsx` (~425 lines) was three cards:

* `UploadCard` — `acceptFile(event.target.files?.[0] ?? null)`, no `multiple`, one staged
  `File` in state.
* `ActiveJobCard` — ONE `useEventStream` for the single "active" job id, hoisted into
  `live-transcription-screen.tsx` as `activeJobId` state. Progress only; no transcript.
* `MyJobsStrip` — owner-scoped rows with cancel/retry only; a row was not clickable.

**Why the SDK's `useArcaBatchTranscription` could not be reused as-is.** It is built on
the vox `AgenticClient` (api-key auth), `FileTranscriptionService` and `SSEClient`. The
admin console is a BFF app: REST goes through the catch-all proxy
`src/app/api/hope/[...path]/route.ts`, server state is TanStack Query v5, and SSE
connects to the gateway with a single-use ticket minted at `POST /api/auth/stream-ticket`.
So the *design* (queue item shape, slot held for the whole lifecycle, authoritative
result-text swap) was mirrored; the transport was rebuilt on the console's own plane.

---

## Implementation Plan

1. `lib/batch-queue.ts` — a `useBatchQueue` hook owning rows, the scheduler and uploads.
2. The SSE leg stays **outside** the hook: `useEventStream` is a hook and cannot be called
   per row from inside another hook. One headless `<JobStreamBinder />` per row in
   `processing` feeds frames back via `applyStreamEvent` / `applyJob`.
3. `batch-tab.tsx` — `UploadCard` (multi) → `QueueCard` + `ResultPanel` (master/detail) →
   `MyJobsStrip` (rows now select into the same panel).
4. `BatchTab` props reduce to `{ pipelineId }`; the screen's now-redundant `activeJobId`
   state is removed.
5. TDD throughout: failing test first for each behaviour.

---

## Implementation Summary

| File | Change |
|---|---|
| `apps/admin-console/src/features/playground-live-transcription/lib/batch-queue.ts` | **New.** `useBatchQueue({ pipelineId, concurrency = 2, onItemCompleted, onItemFailed })`: `BatchQueueItem` state (id, fileName, size, status, uploadProgress, jobId, jobProgress, segments, text, error), a scheduler that starts `pending` rows only while a slot is free, per-row upload with an `AbortController`, `enqueue`/`cancel`/`retry`/`remove`/`clear`, and `applyStreamEvent`/`applyJob` for the SSE leg. The slot is held for the WHOLE lifecycle (upload **and** stream). Terminal transitions re-read the job and swap in `resultText`. `pipelineId` is snapshot per row at enqueue time. |
| `…/components/batch-tab.tsx` | **Rewritten.** `UploadCard` stages many files (`multiple` + multi-file drop, per-file remove, per-file rejection messages); `JobStreamBinder` is a headless per-row SSE binder (ticket scope `transcription_job:<jobId>`, closes on terminal, polls the job **only** while the stream is in `error`); `QueueRow`/`QueueCard` render the queue with select/cancel/retry/remove + clear-queue; `ResultPanel` renders either a queue row (skeleton → live segments → result text) or a past job; `MyJobsStrip` rows became `Open transcript for job <id>` buttons feeding the same panel. Props are now `{ pipelineId }`. |
| `…/api/client.ts` | `uploadBatchAudio` accepts an optional `signal`, so a queued upload can be aborted on cancel. |
| `…/components/live-transcription-screen.tsx` | Dropped the `activeJobId` state and the two removed `BatchTab` props. |
| `…/components/__tests__/batch-tab.test.tsx` | **Extended** (3 → 17 tests). The BUG-014 disabled-reason trio is kept verbatim; added multi-file staging/drop/rejection, one-row-per-file, the concurrency cap (2 uploads, 2 EventSources, third waiting), slot release on completion, cancel→retry, remove + clear, empty selection state, auto-select + row switching, the streamed-segment → authoritative-text swap, per-job ticket scope, opening a past job, and an axe scan. |
| `…/components/__tests__/live-transcription-screen.test.tsx` | Batch assertions retargeted: `Audio files` label, `Remove file visit.wav`, and the `active batch job` region replaced by the `batch queue` region (job id + live 62% progress assertions preserved). |

### Decisions worth knowing

1. **`uploadProgress` is 0/100, not a live percentage.** The console uploads through the
   shared fetch core (`@/shared/api`), and `fetch` reports no request-body progress. A real
   percentage needs XHR, i.e. a second HTTP core in this app. The row therefore shows an
   indeterminate "Uploading…" state with a `<Spinner />` rather than a fabricated number;
   the determinate bar shows **backend** progress from the job's `progress` SSE events.
2. **Poll only when the stream is down.** The old `ActiveJobCard` always fetched the job
   once; the binder fetches only while `stream.status === 'error'`, so a healthy row costs
   exactly one connection and zero polling.
3. **The manual "Reconnect" button is gone.** `useEventStream` already retries with a
   fresh ticket, and the row surfaces the stream state (`SSE live` / `Offline`) with the
   documented 5s polling fallback behind it.
4. **Concurrency is fixed at 2** (`DEFAULT_BATCH_CONCURRENCY`), not user-configurable —
   same default as the SDK hook. Exposing it is a one-line change if wanted.

---

## Verification

TDD: the 14 new tests were written and run RED first
(`Tests 13 failed | 3 passed (16)` — the 3 passing were the pre-existing BUG-014 trio),
then the hook and component were implemented.

```
$ pnpm --filter @arcaai/admin-console test
 Test Files  1 failed | 159 passed (160)
      Tests  4 failed | 1248 passed (1252)

 FAIL  src/features/playground-llm/components/__tests__/playground-llm-screen.test.tsx
   > runs a sync generation and renders content, usage, latency and finish reason
   > renders the cascade fallback (no picker) for an empty tenant catalog …
   > offers a model omit option that drops the model from the body (HarnessPolicy cascade)
   > shows the request-summary strip with the effective settings and the live task id
```

**Those 4 failures pre-date this ticket and are unrelated.** They live in
`src/features/playground-llm/**`; this change touches only
`src/features/playground-live-transcription/**` (`git status` confirms the diff scope).
They were left alone rather than "fixed" as drive-by work.

The feature's own suites are green:

```
$ pnpm --filter @arcaai/admin-console vitest run src/features/playground-live-transcription/
 Test Files  5 passed (5)
      Tests  53 passed (53)
```

```
$ pnpm --filter @arcaai/admin-console lint
> eslint src --max-warnings 0
(no output — clean)

$ pnpm --filter @arcaai/admin-console typecheck
> tsc --noEmit
(no output — clean)
```

Accessibility: `axe(container)` with a populated queue + a recent-jobs row reports **0
violations**. Every icon-only control carries an `aria-label`; queue and job rows use
real `<button>`s with `aria-pressed`; the disabled `Upload & transcribe` and
`Clear queue` controls are wired to visible reasons via `aria-describedby`.

**Not verified:** this was NOT exercised in a running browser. There is no manual pass
against a live gateway + STT worker, and therefore no light/dark screenshot evidence —
both themes are covered only by construction (semantic tokens throughout, no hardcoded
colours). A runtime pass on `/playground/live-transcription?tab=batch` remains an open
item before this is called done.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-03 | Ticket created and implemented. Batch tab moved from single-file upload + a progress-only job card to a bounded multi-file queue (one gateway job per file, 2 in flight, slot held across upload **and** stream) with a master/detail transcript panel that also opens past jobs from the owner-scoped strip. TDD RED captured first; feature suite 53/53, lint and typecheck clean; axe clean. Browser verification not performed. |
