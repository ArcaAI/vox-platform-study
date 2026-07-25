# TASK-433 — Playground: Live Transcription (frame 51)

- **Status**: Review
- **Type**: feature — screen `/playground/live-transcription` in `apps/admin-console`
- **Created**: 2026-07-06
- **Parent**: TASK-420 row 35 (matrix + approved frame `51 - Live Transcription`); foundation TASK-431

## Requirement Analysis

WS streaming + batch upload demo, owner-scoped, working tenant required (`<WorkingTenantGate>`):

- **Streaming tab**: pipeline picker (`GET /audio/pipelines`), mic permission prompt, session create `POST /audio/transcription-jobs/stream/session` (201 → `{ sessionId, wsUrl, ticket, ticketExpiresAt, maxConcurrent, currentActive, voiceProfileSeeded? }`; 429 = tenant concurrency quota — designed error panel), WS `wss(publicEnv.apiHost)/ws/stt/stream?sessionId&ticket&tenantId`, status chip (connecting/live/reconnecting/closed-4401 generic copy), partial vs final transcript stream with latency meta, ticket-refresh indicator (`POST …/refresh-ticket`), stop (`{type:'stop'}`) + `DELETE …/session/:sessionId`, `voiceProfileSeeded` badge.
- **Batch tab**: drag-drop upload `POST /audio/transcription-jobs/transcribe` (multipart `file` + `pipelineId`, ≤100 MB, audio mimes) → job card with SSE progress (`useEventStream`, scope `transcription_job:<id>`, events `status/progress/chunk/transcript/error`), my-jobs strip (`GET /audio/transcription-jobs`, owner-scoped) with cancel/retry.
- Audio capture: `@arcaai/vox` `SttWebSocketClient` + `@arcaai/stt` `createAudioCapture`/`float32ToInt16` → binary Int16 LE PCM frames (reference: deprecated `apps/ui-playground/src/hooks/use-realtime-transcription.ts` — API wiring only, not styling/auth).
- Session create + REST via BFF (`@/shared/api`); WS direct to gateway. State variants: loading/empty/error/NoTenant; light + dark.

## Current State Evaluation

- Foundation TASK-431 (COMPLETED) provides the `(console)/(playground)` route-group guard, sidebar entries, the `@arcaai/vox`/`@arcaai/stt`/`@arcaai/room` console deps, `SafeSession.user.tenantId`, and the SDK fix letting `ApiConfig.wsUrl` override the WS origin.
- The tenant-wide admin grid at `/audio/transcription-jobs` (row 28) already exists — this screen is the owner-scoped END-USER plane and must not duplicate it. Its `src/features/transcription-jobs/api/*` layering and `job-stream-panel.tsx` SSE pattern are the canonical references (endpoints here WITHOUT the `admin/` prefix).
- Shared infra already in place: `@/shared/api` request core (BFF proxy, `GatewayError`, FormData support), `useEventStream` (`@/shared/streams`, ticket-authenticated direct-gateway SSE), `WorkingTenantGate`, `ScreenTemplate`/`PageHeader`/`StatusFooter`, `EmptyState`/`ErrorState`.
- Gateway surface (verified against `apps/api`): `TranscriptionJobController` (stream session create/refresh/delete, transcribe multipart, owner list/detail/cancel/retry, `:id/stream` SSE with `@StreamScope transcription_job`) and `AudioPipelinePublicController` (`GET /audio/pipelines`).
- Nothing existed yet under `src/features/playground-live-transcription/` or the route folder; this ticket creates both.

## Implementation Plan

Feature `src/features/playground-live-transcription/` mirroring the `transcription-jobs`/`consultations` anatomy; routes under `(console)/(playground)/playground/live-transcription/` (`page.tsx` thin server component + `loading.tsx`).

1. **Failing tests first (RED)** — colocated Vitest suites with `renderWithProviders`, fetch stubbed by pathname, `FakeEventSource` for SSE, `vi.mock('@arcaai/vox/core')`/`vi.mock('@arcaai/stt')` with a fake WS client + fake capture:
   - `api/__tests__/live-transcription-api.test.ts` — BFF paths (session create/refresh/DELETE on `audio/transcription-jobs/stream/session*`, owner list, cancel/retry, `audio/pipelines`), multipart upload via FormData, `buildStreamWsUrl` (ws/wss origin from `publicEnv.apiHost`, `sessionId`/`ticket`/`tenantId` params).
   - `api/__tests__/use-live-stt-session.test.tsx` — hook: mic → session create (`{pipelineId, sampleRate:16000}`) → WS connect URL incl. tenantId; 429 → quota state; transcript partial/final reduction; stop → `{type:'stop'}` + disconnect + DELETE session; reconnect wiring refreshes ticket via BFF.
   - `components/__tests__/live-transcription-screen.test.tsx` — NoTenant gate (no data queries fired), tabs render, 429 quota panel, partial/final transcript rows (caret on partial), batch upload multipart call + job SSE panel (scoped ticket, direct-gateway EventSource), cancel/retry POSTs, jobs-strip empty state.
2. **api layer** — `types.ts` (session/batch/job/pipeline DTOs mirrored from the gateway controller + local WS wire types — `@arcaai/vox` ships `dts:false`, so type-only imports don't resolve), `client.ts` (BFF via `@/shared/api`; FormData upload through the exported `request`), `keys.ts`, `hooks.ts` (pipelines/jobs/detail queries + upload/cancel/retry mutations), `use-live-stt-session.ts` (session+WS+capture state machine; `SttWebSocketClient` from `@arcaai/vox/core`, `createAudioCapture`/`float32ToInt16` from `@arcaai/stt`; reconnect `refreshTicket` → BFF refresh route).
3. **components** — `live-transcription-screen.tsx` (`<WorkingTenantGate>` → `<Tabs>` + `ScreenTemplate` with `TabsList variant="line"` in the `tabs` slot, pipeline picker in `toolbar`, `StatusFooter`), `streaming-tab.tsx` (controls card: mic/pipeline/level/stop, ticket countdown, WS status chip, `voiceProfileSeeded` badge, session `currentActive/maxConcurrent`; transcript pane partial-vs-final + latency/seq meta; 429 quota + generic-4401 panels; empty state), `batch-tab.tsx` (drag-drop ≤100 MB audio upload with file row + remove, active job card with SSE progress + poll fallback, my-jobs strip with cancel/retry + empty state).
4. **Verify** — `pnpm --filter @arcaai/admin-console test -- src/features/playground-live-transcription` green; scoped `npx eslint` on owned files `--max-warnings 0`; `check-types` clean for owned files; ticket README updated.

## Implementation Summary

TDD (RED commits first, then GREEN): 22 tests across 3 suites, all green.

### Files created

Feature `apps/admin-console/src/features/playground-live-transcription/`:

| File | Purpose |
|---|---|
| `api/types.ts` | Gateway DTO mirrors (job/session/batch/pipeline), `MAX_UPLOAD_BYTES`/`ACCEPTED_AUDIO_MIME_TYPES`, WS wire types (`WsTranscriptPayload`/`WsErrorPayload`), `SttStreamClient` structural interface, SSE `JobStreamEnvelope` |
| `api/client.ts` | BFF calls (session create/refresh/DELETE, owner jobs list/detail/cancel/retry, pipelines), multipart upload via shared `request` + FormData, `buildStreamWsUrl` (http→ws / https→wss + `sessionId`/`ticket`/`tenantId` params) |
| `api/keys.ts` / `api/hooks.ts` | Query keys; pipelines/jobs/detail queries (detail polls 5 s as SSE fallback), upload/cancel/retry mutations with root invalidation |
| `api/use-live-stt-session.ts` | Streaming state machine: mic → `POST …/stream/session` → `SttWebSocketClient.connect` → capture worklet → Int16 frames; 429 → `quotaExceeded`; 4401/handshake → generic "expired or unauthorized" copy; reconnect wired to `refreshTicket` → BFF refresh route; stop → `{type:'stop'}` + disconnect + DELETE + track/AudioContext teardown |
| `components/live-transcription-screen.tsx` | `<WorkingTenantGate>` → `<Tabs>` around `ScreenTemplate` (`TabsList variant="line"` in `tabs` slot, picker in `toolbar`, `StatusFooter`); pipeline default derived from `isDefault`; tenant claim = `workingTenantId ?? user.tenantId`; `?tab=` deep link (nuqs) |
| `components/streaming-tab.tsx` | Session controls card (mic label, capture facts, audio level meter, ≥44 px stop, ticket-expiry countdown, `voiceProfileSeeded` badge, `currentActive/maxConcurrent`, reconnect attempt), transcript pane (`role="log"`, partial row with caret + `partial` chip, finals with seq/latency meta), 429 quota panel, generic session-closed panel, empty state |
| `components/batch-tab.tsx` | Drag-drop upload zone (label-for-input so click/keyboard work; ≤100 MB + mime validation with `role="alert"`; file row with name/size/remove), active job card (`useEventStream` scope `transcription_job:<id>`, status/progress/chunk/transcript/error events, terminal status closes the stream + invalidates, poll fallback + Reconnect on stream error), my-jobs strip (owner-scoped list, cancel/retry with aria-labels, skeleton/error/empty states) |
| `api/__tests__/live-transcription-api.test.ts` (9) · `api/__tests__/use-live-stt-session.test.tsx` (6) · `components/__tests__/live-transcription-screen.test.tsx` (7) | fetch stubbed by pathname; fake `SttWebSocketClient` + fake `@arcaai/stt` capture; `FakeEventSource` |

Route `apps/admin-console/src/app/(console)/(playground)/playground/live-transcription/`: `page.tsx` (thin server component + metadata), `loading.tsx` (header/toolbar/tabs/two-pane skeletons).

### Chosen WS approach — (b), REST via `@/shared/api` + direct `SttWebSocketClient`

Option (a) (`AgenticClient` + `StreamingSessionManager`) would route session REST through the SDK's own fetch layer, bypassing the console's `GatewayError` normalization (needed for the designed 429 quota panel), its BFF envelope handling, and TanStack Query invalidation; the SDK also ships `dts:false`, so the console cannot type the manager surface. Option (b) keeps every REST call on the shared, already-tested `@/shared/api` core (uniform error taxonomy, FormData support) and uses only the one SDK piece that earns its keep — `SttWebSocketClient` (binary frames, reconnect + `refreshTicket` callback) — with the WS URL hand-built from `publicEnv.apiHost` by `buildStreamWsUrl`.

### Verification evidence (2026-07-06)

```
$ pnpm --filter @arcaai/admin-console exec vitest run src/features/playground-live-transcription
 Test Files  3 passed (3)
      Tests  22 passed (22)

$ pnpm --filter @arcaai/admin-console test -- src/features/playground-live-transcription
 Test Files  95 passed (95)
      Tests  727 passed (727)

$ pnpm --filter @arcaai/admin-console lint
> eslint src --max-warnings 0
(clean — exit 0)

$ pnpm --filter @arcaai/admin-console check-types
> tsc --noEmit
(clean — exit 0)
```

Note: the ticket's literal command `pnpm … test -- src/…` expands to `vitest run -- src/…`, which drops the path filter and runs the whole app suite (95 files) — also green. The `exec vitest run <path>` form is the correctly scoped equivalent. Playwright E2E + axe + design QA on the running app are deferred to the integration pass.

### Needs / deviations

- **`@arcaai/vox` ships no `.d.ts`** (`tsup dts:false`): WS payload/client types are mirrored locally in `api/types.ts` and the runtime class is cast to a structural `SttStreamClient`. Needs: enable `dts` in `packages/agentic-sdk-v2` so consumers can import types (out of bounds here).
- **nuqs testing adapter is memoryless**: a clicked tab reverts when the URL-update queue flushes, so batch-tab tests deep-link `searchParams: '?tab=batch'` (harness-policy pattern); under the real Next adapter the URL write persists. Tab semantics unchanged.
- Job list/detail DTOs typed directly against `TranscriptionJobResponse` + `Paginated` from the gateway controller (plain end-user paths — no envelope normalization needed).

## Change History

| Date | Change |
|---|---|
| 2026-07-06 | Ticket created from TASK-420 (frames approved 2026-07-06). |
| 2026-07-06 | Implemented feature (api + hook + 3 components + route), TDD 22 tests green, scoped lint + check-types clean. Status → Review. |
| 2026-07-06 | Final verification pass: feature suite 22/22 green, full app suite 727/727 green, full `pnpm lint` 0 errors/warnings, `check-types` clean. README: added Current State Evaluation + WS approach (b) justification, corrected per-suite test counts. |
| 2026-07-08 | Design-alignment pass against the approved template (`templates/pg-live-transcription/PgLiveTranscription.dc.html`): added the shared `PlaygroundBanner` to the `statusBanner` slot, aligned the header subtitle to "Streaming session · runs under your own account", and added VAD to the capture facts line ("16 kHz mono · VAD auto-pause on · echo cancel on · noise suppression on"). StatusFooter already matched the convention (left status text, right mono endpoint hints) — untouched. Feature suite 22/22 green, scoped lint clean. Follow-ups deliberately NOT done in this pass: mic device picker (template shows a device select; needs capture-hook `deviceId` plumbing), functional VAD toggle, cancel/retry on the active batch job card, batch stats/by-status strip. |
