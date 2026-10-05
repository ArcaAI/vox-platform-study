# P-D plan — admin read plane, console timeline, SDK 5.x vocabulary, artifact regeneration

Planner: sonnet (read-only), 2026-10-05. Consolidated into README §6; this file is the planner's record.

## Verified facts

- TASK-1039 SDK 5 code (`RunHandle`, `useRun`, `useRunAudio`) is merged on dev-2.2; manifests still read 4.1.0 (bump/tag is the owner's local runbook).
- `@arcaai/vox` has no `useConsultation`; browser `audio.start` never calls `recording/start`; `ConsultationStatus` has 12 values in both SDKs.
- Business plane already has `:id/context/:contextId/versions[/:n]`, `:id/summary/:ctx/diff`, `:id/timeline`; missing a latest-by-default history feed, `?include=versions`, recap.
- `HistoryTimelineList` input is newest-first by contract; `order='asc'` REVERSES the input — oldest-first API data with `asc` renders newest-first. No section/band rows, no row selection.
- `/consultations` is a `(tenant)` route (nav `required [['manage','Consultation']]`); detail route resolves by longest prefix like `workflow-runs/[runId]`; `@/shared/versioning/line-diff` (`diffLines`) and `FloatingPane` exist.
- Admin controller exemplar: telemetry/prompt-inspector = `@ForbidApiKey` + `@RequiredSvcScopes('svc:admin:consultation-admin:manage')` + `@CanRead('Consultation')`; real gate `assertPromptInspectorAccess`.
- `common/cursorPagination.ts` supports asc keyset on `(sortKey, id)`.

## 1. Contracts

### Routes (new controllers; `consultation.controller.ts` untouched)

Admin — `AdminConsultationHistoryController` (`admin/consultations`), class decorators as telemetry; every handler: gate first (row-independent), then existence (foreign id 404). Gate = `assertPromptInspectorAccess` extended with optional `{code, message}` (`CONSULTATION_HISTORY_FORBIDDEN`; default unchanged). `// AUTH-NOTE:` on each handler. Reads audited (`ResourceViewed`, `forceAuditLog`).

| Route | Returns |
|---|---|
| `GET :id/activity?cursor&limit(≤100,50)&kinds=csv&encounterSeq&edited&aiRuns&grouping=runs\|none&segmentSeqFrom&segmentSeqTo&include=versions` | `ConsultationActivityPage` oldest-first |
| `GET :id/items/:itemId/versions` | `ItemVersionSummary[]` newest-first, no content |
| `GET :id/items/:itemId/versions/:n` | `ItemVersionDetail` decrypted |
| `GET :id/items/:itemId/versions/:n/diff?against=m` | `{contextItemId, from, to}` (existing `VersionDiffResponse`); console diffs lines |
| `GET :id/items/:itemId/runs?version=n` | `ActivityRunRecord[]` |

Business — `ConsultationHistoryController` (`consultations`), scopes `consultation:session:read` / `svc:consultation:session:read`, sibling ownership check:

| Route | Returns |
|---|---|
| `GET :id/history` | same page shape minus `run` / `aggregates` |
| `GET :id/encounters/:seq/recap` | `EncounterRecap {encounterSeq, contextItemId, versionNumber, text, sections?, generatedAt, ledgerContextItemId}` (display-only) |

### DTOs

- `ConsultationActivityPage {consultationId, status, processing, processingReason?, encounters: EncounterBlock[], items: ActivityEntry[], nextCursor|null, hasMore, aggregates? (admin, first page)}`
- `EncounterBlock {seq, visitType, externalRef, startedAt, endedAt|null, recordingStartMs, recordingEndMs, gapAfter?: {fromAt, toAt, durationMs}}`
- `ActivityEntry` discriminated by `entryType`:
  - `item`: `id, kind, encounterSeq, occurredAt, source, actor?, latestVersion {number, content? (decrypted), mediaId?, changeSource, changedBy, createdAt}, versionCount, edited, lastEditedAt?, versions? (include=versions), run?: RunSummary (admin), feedback? {up, down}, segment? {seq, speaker, t0Ms, t1Ms}, media? {mediaId, url?, durationMs?}`
  - `segment_run`: `runId, encounterSeq, firstSeq, lastSeq, count, t0Ms, t1Ms, speakers[], occurredAt, preview, edited` — consecutive segments of one encounter with nothing between; expand = `activity?grouping=none&kinds=TRANSCRIPT_SEGMENT&encounterSeq&segmentSeqFrom/To`
  - `feedback`: `rating, reasonCodes, comment (decrypted), target {kind, contextItemId, versionNumber, sectionKey?, entityRef?}, actor, clientApp, surface, provenance`
  - `lifecycle`: `at, type, actor?` derived from encounter/approval/closedAt
- `ActivityKind`: `TRANSCRIPT_SEGMENT|FULL_TRANSCRIPT|NOTE|PRE_SUMMARY|CASE_NOTE|ATTACHMENT|RECORDING|FACT_LEDGER|ENCOUNTER_RECAP|STRUCTURED|FEEDBACK|LIFECYCLE`
- `RunSummary {runId, workflowSlug, workflowVersion, agentSlug, agentVersion, model, provider, durationMs, tokensIn, tokensOut, contextUsed, contextWindow, costMicros, costBasis, stopReason, startedAt}`; `ActivityRunRecord` = RunSummary + `id, nodeId, nodeLabel?, activityKind, outputCap, deployment, endedAt, versionNumber`
- `Aggregates {aiRunCount, tokensIn, tokensOut, costMicros, costBasis[], editedItems, feedbackUp, feedbackDown}`

### Consumed (notes for the DB lane / other planners)

- DB: `ConsultationEncounter`, `ConsultationApproval`, `ConsultationFeedback`, `ActivityRunRecord` (tenantId, consultationId, encounterSeq, **contextItemId + versionNumber (mandatory join)**, nodeId, RunSummary columns); `ContextItem` gains `encounterSeq, segmentSeq, speaker, t0Ms, t1Ms, capturedAt`; types `TRANSCRIPT_SEGMENT, FULL_TRANSCRIPT, AUDIO_RECORDING (single), FACT_LEDGER, ENCOUNTER_RECAP`; index `(consultationId, occurredAt, id)`; `ContextItemVersion.changeSource` `segment_edit|feedback|manual|ai`.
- P-AB: commands `POST consultations/:id/{start|pause|stop|approve|close|reopen}`; `ConsultationState {id, status, processing, processingReason?, reopenCount, version, lastActivityAt, encounters[], recordable, approvedAt?, closedAt?}`; `stop` adds `finalTranscript {contextItemId, versionNumber}`; STT frames `{type:'pause'}` / `{type:'resume-capture'}` with a `status` ack.
- P-CG: attachments intent/PUT/complete (Idempotency-Key); `POST consultations/:id/feedback`; edits via existing `PATCH :id/context/:contextId` + If-Match.

### Shared types — `packages/types/src/consultation-lifecycle.ts`

`ConsultationStatus` (7), `ConsultationProcessing`, `LEGACY_STATUS_MAP` + `normalizeLegacyConsultationStatus`, `FeedbackRating`, `FeedbackTarget`, `FeedbackReasonCode`, `ActivityKind`, `ConsultationActivityPage`, `ActivityEntry`, `EncounterBlock`, `RunSummary`, `ActivityRunRecord`, `EncounterRecap`, `ItemVersionSummary`, `ItemVersionDetail`. `vox-codegen` unchanged; `vox-node-codegen` picks up new admin routes under `consultation-admin` via regeneration only.

### vox-node

`hope.consultations.open(req): Promise<ConsultationHandle>` (handle carries every `ConsultationOpenResponse` field read-only); `hope.consultations.attach(id)`. Handle verbs: `start(o?: {agentSlug?, language?}) → CaptureHandle` (stt session → `POST :id/start {sttSessionId}` → socket; on PAUSED resumes), `pause()`, `stop()` (+`finalTranscript`), `approve()`, `close(o?: {ifMatch?})`, `reopen()` → `ConsultationState`; `generateSummary(o?: {outputLanguage?, wait?})`; `sendAttachment({kind:'pdf'|'image'|'audio'|'case_note', data, mime, name?, sha256?}, {signal?, onProgress?})` (retry 5xx/429/network with backoff+jitter, honour Retry-After, never other 4xx, one Idempotency-Key per logical upload); `sendFeedback({kind:'edit'…}|{kind:'rating'…}|{kind:'comment'…})`; `history(q?)`, `historyAll(q?)`; `recap(seq)`; `on('transcript'|'status'|'capture-state'|'error')`.

### Browser

`useConsultation(opts?)` composing `useArcaSession` + `useArcaAudio` + `useArcaSummary`: `{consultation, status, processing, isCapturing, level, segments, error}` + verbs; `start()` also calls `POST :id/start {sttSessionId}`; `SttWebSocketClient.pause()/resumeCapture()`.

### Deprecations (one release; `@deprecated` + register rows)

vox-node `recording.start/stop`, per-summary `summaries.approve`, `consultations.close(id, req, {ifMatch})` signature, `waitForFinalNote`; vox `useArcaSession().close/reopen`, `useArcaAudio.start/stop`, per-summary approve; types: 12-value status + `NOTE_READY_STATUSES` (legacy map).

### Console hooks — `features/consultations/api/activity.ts`

`useConsultationActivity(id, filters)` (infinite, cursor), `useSegmentRun`, `useItemVersions`, `useItemVersion`, `useItemDiff`, `useItemRuns`, `useActivityParams()` (nuqs: kinds, edited, aiRuns, encounterSeq, item, v).

## 2. Lanes (sonnet unless noted; each runs only its own test file)

| Lane | Wave | Depends | Files | RED→GREEN test | Done |
|---|---|---|---|---|---|
| D7 types | A | — | create `packages/types/src/consultation-lifecycle.ts`; modify `packages/types/src/index.ts` | `packages/types/src/__tests__/consultation-lifecycle.task1045.test.ts` | legacy map + normaliser cases |
| D3 ui timeline | A | — | modify `packages/ui/src/components/timeline/{types.ts,use-timeline.ts,history-timeline-list.tsx,timeline-item.tsx,index.ts}`; create `timeline/timeline-band.tsx`; modify `packages/ui/src/index.ts`; story under `components/__stories__/timeline/` | `packages/ui/src/components/__tests__/timeline/history-timeline-bands.vitest.tsx` | additive `inputOrder` (default desc), `kind:'band'` rows (`role=separator`), `selectedId`, `onItemSelect`, `actions` slot; existing timeline tests unaffected |
| D1 history service (opus, medium) | B | DB lane + P-AB domain | create `packages/applications/src/services/consultation/history/{IConsultationHistoryService.ts,consultation-history.service.ts,consultation-history.service.module.ts,consultation-history.dto.mapper.ts,dto/*.ts,index.ts}`; modify `prompt-inspector-access.ts` (additive option); barrel `services/consultation/index.ts`; read-only hand-authored repo in `packages/domains/src/repositories/` (non-generated) | `.../history/__tests__/consultation-history.service.task1045.test.ts` | keyset asc, run grouping + cap, filters, gap bands, decrypted latest, per-page decrypt cap with bounded concurrency, foreign 404, gate-before-existence, audit |
| D2 API | C | D1 | create `apps/api/src/modules/consultation-history/{admin-consultation-history.controller.ts,consultation-history.controller.ts,consultation-history.module.ts}`; modify `apps/api/src/app.module.ts`; author (not run) `apps/api/tests/e2e/consultation-history-cross-tenant.spec.ts` | `apps/api/src/modules/consultation-history/__tests__/consultation-history.controllers.task1045.test.ts` | metadata, validation, delegation; no regeneration |
| D4a console api | B | D7 | create `features/consultations/api/activity.ts`; modify `api/{keys.ts,types.ts,index.ts}`; modify `components/consultation-status-badge.tsx` | `features/consultations/api/__tests__/activity-api.task1045.test.ts` | URLs, cursor paging, keys |
| D4b console screen | D | D3, D4a | create `app/(console)/(tenant)/consultations/[id]/{page,loading,error}.tsx`, `features/consultations/components/activity/*`; modify `consultations-screen.tsx`, `consultation-detail-panel.tsx` | `.../components/__tests__/consultation-activity-screen.task1045.test.tsx` (+vitest-axe) | ScreenTemplate; non-modal side panel; diff via `diffLines`; skeletons; 403 restricted card |
| D4c status sweep | D | D7 | modify `features/playground-consultation/api/types.ts`, `components/scribe/consultations-column.tsx` | one case in the D4a test file | 7 statuses + legacy normalisation |
| D5 vox-node | B | D7 | create `src/resources/consultation-handle.ts`, `src/types/consultation-lifecycle.ts`; modify `resources/consultations.ts`, `resources/index.ts`, `types/index.ts`, `src/index.ts`, `types/consultation.ts` | `src/resources/__tests__/consultation-handle.task1045.test.ts` | mocked transport: start composition, pause/resume, stop waits, retry matrix, feedback union, idempotency, history iteration |
| D6 vox browser | B | D7 | create `src/hooks/useConsultation.ts`; modify `hooks/index.ts`, `core.ts`, `index.ts`, `core/constants.ts`, `core/SttWebSocketClient.ts`, `core/StreamingSessionManager.ts`, `types/consultation.ts` | `src/hooks/__tests__/useConsultation.task1045.test.tsx` | start calls `POST :id/start`; pause frame |
| D8 docs/changeset | E | D5, D6 | `.changeset/task-1045-consultation-handle.md`; `docs/operations/deprecation-register.md`; both SDK READMEs/CHANGELOG notes; `.claude/rules/08-vox-sdk.md`, `05-nestjs-api.md` | — | all deprecations registered; minor changeset in fixed group, no manifest bump |
| R regen (own worktree, real install) | E (after every API lane) | D2, P-AB, P-CG, P-E | generated only: `apps/api/route-manifest.json`, `apps/api/openapi.json`, `apps/admin-console/src/server/api-docs/openapi.{admin,business}.json`, `packages/vox-node/src/resources/admin/**` | — | five commands + three `:check`s; diff allowlist = TASK-1045 routes |

## 3. Shared files

`apps/api/src/app.module.ts`, `services/consultation/index.ts` barrel → orchestrator integration commit (one line per lane). `packages/domains` Prisma/enums/generated repos → DB lane. Generated artifacts → R only. vox-node `index.ts`/`types/index.ts`/`consultations.ts` → D5 additive (1039 files untouched). vox `core.ts`/`hooks/index.ts`/`core/constants.ts` → D6 additive. Deprecation register + rules 05/08 → D8 (others send rows). Console `api/types.ts`, status badge, list screen → D4a then D4b. `packages/ui/src/index.ts` → D3.

## 4. Risks

1. SDK 5.0 coordination — ship in the same major as 1039; if 5.0.0 is already tagged → 5.1.0 with a backward-compatible `open()` (property-copy handle). P-F consumes a locally packed 5.x.
2. Artifact contamination — R last, rebased on tip, own worktree + install, allowlisted diff, blocked (not stubbed) if a route lane is unmerged; never `gen:admin` alone.
3. Next 16 worktrees — Turbopack refuses symlinked `node_modules`; console lanes vitest only; D4b after D3 merges; live verification at the orchestrator gate.
4. PHI decrypt volume — page-capped decrypt, run previews only, admin-read audit mandatory.
5. Run-record join needs `contextItemId + versionNumber` from P-E.
6. Console status vocabulary 12→7 touches list filters, badge, playground.
7. Mockup fidelity — labels from README text.
