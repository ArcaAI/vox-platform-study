# TASK-603 — Compat batch upload (SDK + playground tab)

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | feature |
| **Branch** | `dev-2.1` |
| **Packages** | `@arcaai/vox` (compat entry), `@arcaai/compat-playground` |
| **Depends on** | TASK-560/561 (compat hooks), TASK-597 (playground tabs), TASK-587 (language modes) |

## Requirement Analysis

Add batch (pre-recorded file) upload to the compat playground as a new tab, returning
the transcription job, with the same compat integration the live-transcription path has.

The request set the rule explicitly: **if v1 had upload, migrate it to compat keeping
every interface/hook — additions allowed, removals not.** If v1 had no batch upload,
build the tab on the latest Vox SDK instead.

## Current State Evaluation

**v1 DID have file upload.** `useArcaSpeechToText` — the frozen v1 hook — declares four
upload members, and all four were dead in compat:

| v1 member | Before this ticket |
|---|---|
| `uploadAudioFile(file, language, provider?) => Promise<string>` | threw `"not supported"` |
| `getTranscriptionStatus(taskId) => Promise<unknown>` | threw `"not supported"` |
| `isUploading` | hardcoded `false` |
| `uploadProgress` | hardcoded `0` |

**v2 already had the whole batch path**, unwired from compat:
`FileTranscriptionService` (multipart upload with XHR progress, job fetch, cancel,
stream-URL construction) + `SSEClient`, against existing gateway routes
`POST /api/v1/audio/transcription-jobs/transcribe`, `GET :id/stream`, `GET :id`,
`POST :id/cancel`. **No gateway change was needed.**

Two traps found while reading the existing code:

1. **Entry-bundle isolation.** `@arcaai/vox/compat` is its own tsup entry built with
   `splitting: false`, so the Zustand React context does not cross entry bundles. A hook
   imported from `@arcaai/vox` inside a `<ArcaCompatProvider>` tree reads a different
   context instance and throws. The new hook therefore lives in, and is exported from,
   the compat entry (precedent: `useArcaSttLanguageModes`).
2. **The pre-existing reference implementation is broken.**
   `apps/ui-playground/src/hooks/use-file-transcription.ts:101` constructs
   `new SSEClient(childLogger)` — the legacy 1-argument form that `openWithTicket`
   explicitly blocks — so that batch stream never connects. Additionally the ticket
   scope must be **per job** (`transcription_job:<jobId>`), because the route declares
   `@StreamScope({ namespace: 'transcription_job', param: 'id' })` and the guard
   compares the ticket's scope to exactly that; a generic scope string is a 401. Both
   are now locked by unit tests.

## Implementation Plan

Decisions confirmed with the owner before implementation:

- v1's `provider` argument → **pipeline override** for that upload (falls back to
  `options.pipelineId`; a named error when neither is set).
- The tab is a **multi-file queue**, not single-file.
- Compat integration beyond upload: **hand off a completed transcript to the
  Summarization tab**. Scorecard reuse and job history/resume were explicitly excluded.

## Implementation Summary

### SDK — `packages/agentic-sdk-v2`

| File | Change |
|---|---|
| `src/compat/useArcaBatchTranscription.ts` | **NEW.** Compat-native multi-file queue: per-item upload with progress, SSE result stream, cancel/retry/remove/clear, lifecycle-wide concurrency cap (default 2). |
| `src/compat/useArcaSpeechToText.ts` | The four v1 upload members are now real. **No signature changed** — props and every return key are identical; only the bodies and the two hardcoded values. |
| `src/core/constants.ts` | **NEW** `transcriptionJobScopeFor(jobId)` → `transcription_job:<jobId>` (mirrors `liveSummaryScopeFor`). |
| `src/compat.ts` | Exports the hook + `BatchQueueItem` / `BatchItemStatus` / `BatchTranscriptSegment` / `BatchTranscriptionOptions` / props / return types. |
| `src/compat/__tests__/useArcaBatchTranscription.test.ts` | **NEW**, 14 tests. |
| `src/compat/__tests__/useArcaSpeechToText.test.ts` | +7 tests for the v1 upload members. |

Behavioural notes worth keeping:

- A concurrency slot is held for the **whole** lifecycle (upload **and** stream), not
  just the upload — the cap exists to bound open sockets and backend load.
- On terminal completion the job is re-read once and `item.text` becomes its
  `resultText`; streamed chunks can be partial, so the read-back is authoritative.
- Named SSE events (`chunk`/`status`/`complete`/`error`) and the generic `onMessage`
  envelope are both handled. `EventSource` routes named events exclusively to their own
  listeners, so this cannot double-count.

### Playground — `apps/compat-playground`

| File | Change |
|---|---|
| `src/context/playground-session.tsx` | **NEW `batch` slice** (a new top-level group, per that file's own rule) owning `useArcaBatchTranscription()`, the per-tab pipeline/concurrency, the selected row, and the token-keyed summarization hand-off. Mounted above the tabs so an upload and its stream survive tab switches. |
| `src/components/BatchUploadTab.tsx` | **NEW** tab shell. |
| `src/components/batch/BatchUploadPanel.tsx` | **NEW** file input + drop zone, pipeline picker, language mode, concurrency. |
| `src/components/batch/BatchJobQueue.tsx` | **NEW** one row per file: progress, job id, status (text, never colour alone), cancel/retry/remove. |
| `src/components/batch/BatchJobResult.tsx` | **NEW** streamed segments + the authoritative result text + hand-off. |
| `src/App.tsx` | Fourth tab, same gate + `forceMount` invariant. |
| `src/components/SummaryCard.tsx` | Applies `batch.handoff` once per token → `pasted` transcript source. |
| `src/components/TabExampleCode.tsx` | New glob paths + `BATCH_UPLOAD_EXAMPLE_FILES`. |
| `src/components/__tests__/BatchUploadTab.test.tsx` | **NEW**, 5 tests incl. the cross-tab hand-off. |
| `src/components/__tests__/App.tabs.test.tsx` + 4 other suites | Updated for the fourth tab / the new provider hook. |

### Docs

`packages/agentic-sdk-v2/docs/Compat-API-Reference.md` (§3.1 + new §7, sections
renumbered), `docs/implementation/TASK-560-…/MIGRATION_GUIDE.md` (the "present but
throws" row), `apps/compat-playground/README.md` (four tabs + Tab 3).

## Verification

```
pnpm --filter @arcaai/vox test        → 228 files, 3844 tests passed
pnpm --filter @arcaai/vox typecheck   → clean
pnpm --filter @arcaai/vox lint        → 0 errors (4 pre-existing warnings elsewhere)
pnpm --filter @arcaai/vox build       → ok

pnpm --filter @arcaai/compat-playground test      → 20 files, 210 tests passed
pnpm --filter @arcaai/compat-playground typecheck → clean
pnpm --filter @arcaai/compat-playground lint      → clean (--max-warnings 0)
pnpm --filter @arcaai/compat-playground build     → ok
```

### Runtime pass in the browser (no gateway running)

`pnpm compat:dev` on `:5177`, connected with the stored dev credentials. Verified:

- The fourth tab renders, is gated before connecting ("Three tabs are locked", reason on
  screen), and enables with the rest on connect.
- Choosing two files enqueues two rows; `Queue (2)`; each row shows its size, `job: —`,
  status text, and actions.
- **Network tab: exactly TWO `POST http://localhost:8868/api/v1/audio/transcription-jobs/transcribe`**
  — the correct endpoint, and exactly the concurrency cap (2). Both
  `ERR_CONNECTION_REFUSED` (no gateway), which surfaces as `Failed` + the error text on
  each row + one toast.
- **Retry** issues a third POST to the same endpoint; selecting a row shows it in the
  result panel (`no job yet`, `Status: failed`).
- Light and dark themes both render correctly.

### Live pass against the running stack (gateway + STT + Dramatiq worker)

Stack: docker infra already up; `pnpm stack:dev -- api stt` plus the STT batch worker
(`python -m stt.worker`). Gateway access log for one file uploaded from the Batch-upload tab:

```
POST /api/v1/audio/transcription-jobs/transcribe                       → 201
POST /api/v1/auth/stream-ticket                                        → 200
GET  /api/v1/audio/transcription-jobs/019fc710-…/stream?ticket=…       → 200
```

That is the complete client contract, verified against the real guards:

- Upload returns a job id (`019fc710-eb03-712c-9373-6f0ee629a0b9`), rendered on the row,
  and the file lands at `s3://hope-recordings-global/2026/08/jobs/<jobId>/raw/<name>`.
- **The per-job ticket scope is correct.** `transcription_job:<jobId>` was accepted by
  `@StreamScope`; a generic scope string would have 401'd here — this is precisely the
  bug the deprecated `ui-playground` hook has, and it is now proven fixed.
- The SSE stream opened (200) and a server-emitted `error` event was received, parsed
  and surfaced on the queue row.
- The Dramatiq worker dequeued the job (`Starting batch transcription`).

**The transcription itself does not finish, for a pre-existing environment reason
unrelated to this ticket** — see below. Everything TASK-603 owns is verified.

### Blocked: local dev credential drift (pre-existing, not TASK-603)

Two independent defects in the local dev secret state:

1. **Vault KV has drifted from `.env.dev`.** `.env.dev` was regenerated (new random
   secrets); Vault still holds the previous `API_KEY_PEPPER` and `API_GATEWAY_KEY`. The
   DB's `ApiKey.keyHash` rows were seeded under the CURRENT `.env.dev` pepper (verified:
   the stored hash equals `HMAC(env pepper, seeded raw key)`), but the API runs
   `SECRETS_PROVIDER=vault` and validates with the stale Vault pepper — so **every API
   key 401s**, including the one saved in the playground. Workaround used for this pass:
   start the gateway with `SECRETS_PROVIDER=env`. Proper fix: re-seed Vault from
   `.env.dev` (`scripts/vault-seed-secrets.sh`).
2. **`API_GATEWAY_KEY` has no `ApiKey` row.** `/api/v1/internal/stt/*` is `@Authorize()`d
   and `extractApiKeyFromRequest` treats `X-Internal-Service-Key` as an ordinary API key,
   so the STT worker's callback needs a real key row. No row matches that value under
   either pepper, so `PATCH /internal/stt/jobs/:id/start` 401s and the job fails and
   retries. (`./scripts/dev-service.sh --check-stt-key` passes — it only checks the value
   is non-placeholder, not that it resolves to a key row.)

### Still outstanding: the live end-to-end pass

Upload → 201 job id → SSE transcript → completion → hand-off. It needs the gateway on
`:8868` plus STT, and no stack was running in this session. To run it:

```bash
pnpm setup:dev && pnpm stack:dev -- api stt smr
```

then `pnpm compat:dev`, connect on `:5177`, and drop 2–3 clips from
`apps/compat-playground/public/mltest/`. Expected: `POST /api/v1/audio/transcription-jobs/transcribe`
→ 201 with a job id, `GET /api/v1/audio/transcription-jobs/:id/stream?ticket=…` → 200,
per-file progress → segments → `Completed`, then **Send to Summarization** lands the
text in the Summarization tab's `Pasted` source.

## Out of Scope

- `apps/ui-playground` (deprecated, no development plan) keeps its broken legacy
  `SSEClient` construction. Flagged, not fixed here.
- No gateway/API changes — every endpoint already existed.
- No job history or cross-reload resume.

## Change History

| Date | Change |
|---|---|
| 2026-08-03 | Ticket created; SDK hook + v1 upload members + playground tab + docs implemented; all package gates green; browser runtime pass done (queue, endpoint, concurrency, retry, both themes); live end-to-end pass against a running gateway outstanding. |
