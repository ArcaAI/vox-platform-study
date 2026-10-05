# P-F plan — ALaaS realignment (audio-stream-svc + web_ui)

Planner: opus (read-only), 2026-10-05. Repo `ALaaSv3.0`, branch `refactor-hope-integaration`. `S/` = `apps/audio-stream-svc/`, `W/` = `apps/web_ui/`. Consolidated into README §6; this file is the planner's record. Orchestrator corrections are marked **[orch]**.

## Findings

- Wire protocol is already **v3** (TASK-1004), so the new contract is **v4**.
- Inventory rebuilt from code: **70** live-screen (L01–L70), **22** workspace-only (W01–W22), **72** other pages (O01–O72) = **164**; ids supersede the artifact's L/W/P numbering.
- Known defects confirmed: Report Issue success toast on every path (`W/services/audioService.js:332-356`); `W/hooks/usePreSummaries.js:55` polls unserved `department-pre-summary-job-status/:jobId` (served: `job-status/:jobId`); `ConsultationWorkspace.jsx:382-391` uses `generations`, `pendingPatchByTarget`, `revertToAi`, `regenerateDisabledReason` without destructuring (hook never returns `regenerateDisabledReason`); workspace `buildStart` (`useConsultationWorkspace.js:423`) omits `departmentCode`, `priorCaseNotes`, `priorVisits`, `vitals`, `investigations`; workspace Copy to EMR clipboard-only (`:576`).
- New defects: `RichTextEditor.jsx:1021` "Saved!" toast after a failed save; `NotificationsBell.jsx` opens non-existent `/App.html`; `DownloadRecordingsModal` mounted but nothing opens it; `POST summary/check_record_ready` has no handler.

## 1. Protocol v4

`CONSULTATION_PROTOCOL_VERSION = 4`; v3 accepted one release (v3 `start` with identity = `open` + `start`; v3 `generation.regenerate|cancel` aliases).

Up (browser → svc):

| type | fields |
|---|---|
| `open` (at launch) | v3 `start` identity (`sessionId, eventId, clinician, departmentId, departmentCode?, visitType, patient, languageMode?, priorCaseNotes?, priorVisits?, vitals?, investigations?`) + `startNew?: boolean` (only after `launchState: auto_closed`) |
| `reopen` | `{}` → `c.reopen()` |
| `start` | `{}` → `c.start()` |
| `capture.pause` / `capture.resume` | `{}` (not to clash with socket `resume`) |
| `stop` | `{persistSnapshot?}` |
| `generate` | `{mode:'generate'\|'regenerate', target?:{kind:'SECTION', sectionKey}}` |
| `generation.cancel` | `{generationId}` |
| `note` | `{text}` → case-note attachment |
| `feedback` | `{idempotencyKey, target:{kind, contextItemId, versionNumber, sectionKey?, entityRef?, segmentId?, recapLineId?}, rating:'up'\|'down'\|'cleared', reasonCodes?, comment?}` |
| `correction` | `{idempotencyKey, target:{kind:SEGMENT\|NOTE\|SECTION\|TRANSCRIPT, contextItemId, versionNumber (If-Match), sectionKey?, segmentId?}, text}` |
| `mic.hint`, `resume{sessionId,eventId,lastSeq}` | unchanged |

Down (svc → browser; every frame has `seq`):

| event | fields |
|---|---|
| `consultation.state` | `{consultationId, status (7 values), processing, processingReason?, launchState:'new_visit'\|'revisit'\|'auto_closed'\|'signed', encounter:{seq, visitType, externalRef}, encounterCount, readOnly, closedReason?:'auto'\|'manual'\|'approved', reopenAllowed, lastActivityAt, recordingStartedAt?, pausedAt?, serverNow}` — on open and every lifecycle change |
| `encounter.recap` | `{encounterSeq, contextItemId, versionNumber, lines:[{lineId, text, segmentIds[]}]}` |
| `encounter.transcript` | `{encounterSeq, readOnly:true, segments[]}` |
| `transcript.segment` | v3 + `segmentId?, contextItemId?, versionNumber?, encounterSeq?` |
| `transcript.final` | `{encounterSeq, segmentCount, lastSegmentSeq, fullTranscript:{contextItemId, versionNumber}}` |
| `note.requested` | `{reason:'after_stop'\|'generate'\|'regenerate', requestedAt}` |
| `note.progress` | `{processing, step, reason?, gaps?:string[]}` |
| `note.final` | v3 + `contextItemId, versionNumber`, per-section ids |
| `entities` | findings[] + `entityRef` |
| `feedback.ack` / `correction.ack` | `{idempotencyKey, ok, feedbackId?\|contextItemId?, versionNumber?, code?}` |
| `notification` | `{id, type, message, sessionId, eventId, createdAt}` |

Kept: `status` (+`paused`), `keepalive`, `summary.snapshot`, `section.patch`, `presummary`, `replay.truncated`, `error`. One release: `visit.prequel` (→ `encounter.recap`), `review.decided` (4.x shim only). New error codes: `CONSULTATION_APPROVED, CONSULTATION_CLOSED, REOPEN_NOT_ALLOWED, NOT_RECORDING, NOT_PAUSED, NOTE_NOT_READY, FEEDBACK_INVALID, VERSION_CONFLICT, LAUNCH_CHOICE_REQUIRED`.

**Ordering after `stop` (spec-pinned):** all final `transcript.segment` → `transcript.final` → `note.requested` → `note.progress(summarizing)` → `note.final`, through one emit queue. `ALAAS_STOP_FIRST_SECTION_GRACE_MS` survives only on the 4.x shim path.

Mirror generation: `S/scripts/gen-web-protocol.mjs [--check]` imports `protocol.ts` via Node type stripping (as `W/tests/serviceProtocolFixtures.mjs`) → `W/src/consultationProtocol.generated.js` (frozen `UP_TYPES, DOWN_EVENTS, ERROR_CODES, LIFECYCLE_STATUSES, PROCESSING, LAUNCH_STATES, FEEDBACK_KINDS`, limits, version, schema); `W/src/consultationProtocol.js` keeps builders/decoders and imports the constants; scripts `protocol:web` / `protocol:web:check`; a browser test pins byte-identity.

## 2. Lanes

| Lane | Tier | Wave | Depends | SDK 5? | Files (C=create, M=modify) | RED→GREEN test | Done |
|---|---|---|---|---|---|---|---|
| F0 protocol v4 | opus | 1 | — | no | M `S/src/consultation/protocol.ts`, `S/package.json` (scripts), `W/src/consultationProtocol.js`, `W/tests/serviceProtocolFixtures.mjs`; C `S/scripts/gen-web-protocol.mjs`, `W/src/consultationProtocol.generated.js` | `S/src/consultation/protocol.v4.spec.ts`, `W/tests/consultationProtocol.v4.test.mjs` | v3 still validates; ordering in schema; `--check` clean |
| F1 HOPE port + fake | opus | 1 | P-D verbs (interface) | no | C `S/src/consultation/hope-consultation.port.ts` (handle: open, start, pause, stop, generateSummary, sendAttachment, sendFeedback, approve, close, reopen, history, recap; + `lookup()`, `onLifecycle()`, `feedbackReasons()`), `S/src/consultation/hope-consultation.fake.adapter.ts` | `S/src/consultation/hope-consultation.fake.adapter.spec.ts` | fake models 7 statuses + processing, stop-after-final, approve lock 409, auto-close, reopen policy |
| F9 codegen check | sonnet | 1 | — | no | M `S/scripts/hope-codegen.mjs`, `S/scripts/hope-codegen-lib.js`, `docs/hope-integration/01-vox-codegen.md` §6.1, `S/HOPE_CODEGEN_EXAMPLE.md` | `S/src/hope/hope-codegen-lib.spec.ts` (new cases) | `--check` exits 1 on missing creds / 403 naming the vars; plain `hope:codegen` still skips |
| F5 Redis store | sonnet | 1 | — | no | C `S/src/consultation/redis-consultation-session.store.ts`; M `consultation-session.store.ts` (+`recordFrame`), `S/.env.example` (`ALAAS_SESSION_STORE=memory\|redis`, reuse `REDIS_HOST/PORT`) | `S/src/consultation/redis-consultation-session.store.spec.ts` (fake client; `ioredis` already a dep) | state + 30-frame ring, TTL 4 h, `SET NX PX` lease |
| U6 defects | sonnet | 1 | — | no | M `W/services/audioService.js` (Report Issue follows `response.ok`, modal stays open on failure), `W/hooks/usePreSummaries.js:55` (→ `job-status/:jobId`), `W/components/RichTextEditor.jsx` (toast only on success); C `W/src/reportIssueOutcome.js`, `W/src/preSummaryEndpoints.js` | `W/tests/u6Defects.test.mjs` | three defects fixed |
| F2 broker lifecycle v4 | opus | 2 | F0, F1 | no (fake) | M `S/src/consultation/consultation-broker.service.ts`, `consultation.gateway.ts`, `consultation.module.ts` (**sole owner**; binds port, store selector, feedback/notifier tokens with no-op defaults), `stt-lane.ts` (paused: drop frames, no finalize); C `consultation-lifecycle.events.ts`, `hope-consultation.vox-node4.shim.ts` (new port over the 4.1.0 port) | `consultation-broker.lifecycle.v4.spec.ts` | launch-state matrix, pause/resume, stop ordering, generate/regenerate, reopen/start-new, v3 compat, refuse recording into signed |
| F3 feedback relay | sonnet | 2 | F0, F1 | no | C `S/src/consultation/consultation-feedback.service.ts`; M `consultation.controller.ts` (`GET api/v1/consultation/feedback-reasons`, fallback D-18 list) | `consultation-feedback.service.spec.ts` | idempotency passthrough; 409 → `VERSION_CONFLICT`/`CONSULTATION_APPROVED` ack; never throws into the socket |
| F4 notifier | sonnet | 2 | F1, F2 events file | no | C `S/src/consultation/consultation-notifier.service.ts`; M `S/src/notifications/notifications.service.ts` (dedupe userId+session+event+type) | `consultation-notifier.service.spec.ts` | note-ready / failed / awaiting-review / auto-closed / approved+closed → one row to the consultant + `notification` frame |
| U1 root session controller | opus | 2 | F0 | no | C `W/hooks/useConsultationSession.js`, `W/components/session/SessionProvider.jsx`, `W/src/reducer/lifecycle.js`, `W/src/wallClock.js`, `W/src/tabTitle.js`; M `W/src/consultationReducer.js`, `W/hooks/useConsultationStream.js` (new verbs, `open` at mount, reconnect on `visibilitychange`/`online`), `W/pages/ClinicalPage.jsx` (provider; `isRecordingActive` kept) | `W/tests/sessionLifecycle.test.mjs` | elapsed from server timestamps + `Date.now()` at render; tab title status only, no PHI |
| U4 feedback UI | sonnet | 2 | F0, U1 | no | C `W/components/feedback/{ThumbsControl,ReasonPicker}.jsx`, `feedback.css`, `W/src/feedbackModel.js`, `W/src/reducer/feedback.js`; M `CaseNoteDocument.jsx`, `ConversationPanel.jsx`, `KeyFindingsPanel.jsx`, `agentic/TranscriptTurn.jsx`, `agentic/GeneratedSection.jsx`, `RichTextEditor.jsx` (Save also sends a NOTE `correction`; Copy to EMR path untouched) | `W/tests/feedbackModel.test.mjs` | reveal on `:hover`/`:focus-within`; always visible under `@media (hover:none),(pointer:coarse)`; reasons optional |
| U7 workspace repair | sonnet | 2 | F0, U1 (`wallClock.js`) | no | M `W/pages/ConsultationWorkspace.jsx`, `W/hooks/useConsultationWorkspace.js` (return `regenerateDisabledReason`; `buildStart` via `consultationStartContext`; Copy to EMR via `utils/emrSignOff` copyNoteToEmr post→mark, clipboard stays "Copy note"; elapsed from `wallClock.js`) | `W/tests/workspaceRepair.test.mjs` | crash + omissions + clipboard-only fixed |
| U2 launch states + recap | sonnet | 3 | U1, U4 | no | C `W/src/launchStateModel.js`, `W/components/session/LaunchStateBanner.jsx` (Continue / Start new; signed read-only), `W/components/session/EncounterRecapPanel.jsx` (recap lines + thumbs; E1 transcript read-only); M `agentic/ReturnVisitPanel.jsx`, `agentic/returnVisitModel.js` | `W/tests/launchStateModel.test.mjs` | four launch states |
| U3 live-screen realignment | opus | 3 | U1, U2, U4 | no | M `W/ClinicalUIPopUp.jsx`, `W/hooks/useClinicalLogic.js` (**sole owner**), `W/ClinicalUIPopUp.css`; C `W/components/session/{NoteProgressStepper,GenerateNoteButton}.jsx`, `W/src/noteProgressModel.js` | `W/tests/noteProgressModel.test.mjs` | panels stay mounted (`hidden`); pause → svc + local mmr_agent; admin gating and EMR postMessage unchanged |
| F6 HOPE truth, DB cache | opus | 3 | F1, F2 | no | M `S/src/medical_summary/updated-summary.service.ts`, `medical-summaries.service.ts` (reads HOPE `history()` first, cache fallback `source:'cache'`), `S/src/consultation/hope-consultation-finish.service.ts` (`mark_copied_to_emr` → `approve()` + `close()`), `consultation-link.service.ts`, entities `consultation_link`/`updated_summary`/`generated_summary` (+`hope_context_item_id, hope_version_number, synced_at, pending_sync, encounter_seq`); C `S/src/migrations/add-hope-cache-columns.sql`, `S/src/medical_summary/hope-summary-cache.service.ts` | `hope-summary-cache.service.spec.ts` | REST shapes unchanged; Save never approves |
| F7 legacy passthroughs via SDK | sonnet | 3 | F1, F3 | no | M `medical-summary.controller.ts` (**sole owner**; restore `POST summary/feedback` requiring sessionId/eventId → `sendFeedback`; `upload_audio` → `sendAttachment({kind:'audio'})` when linked, else batch as today), `dna-writing-style.service.ts`, `W/utils/feedbackHelper.js` (`handleSummaryFeedback` restored) + callers `AIDataModal.jsx`, `AIGeneratedSummaryPage.jsx`; C `S/src/medical_summary/hope-attachment.service.ts` | `legacy-passthrough.sdk.spec.ts` | functions kept, routed through the SDK |
| F8 vox-node 5.x adapter | opus | 4 | HOPE SDK 5.x, F1 | **yes** | M `S/package.json` + root `pnpm-lock.yaml` (vox-node/vox-codegen 5.x), `hope-realtime.vox-node.adapter.ts`, `S/src/hope/hope.service.ts`, `S/src/hope/generated/*` (regenerated with creds), `consultation.module.ts` (adapter selection; shim kept one release); C `S/src/consultation/hope-consultation.vox-node.adapter.ts` | `hope-consultation.vox-node.adapter.spec.ts` | real adapter passes the fake's contract |
| U8 fold-in + bell + function map | opus | 4 | U3, U7, F4 | no | M `W/ClinicalUIPopUp.jsx` (workspace-only functions + bell), `W/App.jsx` (`openTab=consultation` → same live screen), `W/components/NotificationsBell.jsx` (open `/?openTab=summary&sessionId&eventId`; refetch on visibility + `notification` frame, no 5 s interval); C `W/src/notificationsModel.js`, `W/src/functionMap.js` | `W/tests/functionMap.test.mjs` (the gate's acceptance check) | every L/W/O row asserted |
| D1 docs | sonnet | 4 | all | no | C `docs/ALAAS_WORKSPACE_REALIGNMENT_PLAN.md`; M `docs/apps/{web_ui,audio-stream-svc}.md`, `docs/hope-integration/00,02,03,05` | — | docs current |

## 3. Function-map acceptance table

Admin rows visible only with `role=admin`; every non-admin row renders exactly as today. "fake" = `HOPE_REALTIME_ADAPTER=fake`.

**Live screen L01–L70.** L01 launch params → `open` at mount, nothing before sync · L02 sync + store LOADING→SUCCESS · L03 sync retry · L04 name/gender/age · L05 read-only Is New Visit · L06 admin Session/Event Id · L07 language modes from svc catalog · L08 language retry · L09 language receipt chip · L10 Start disabled (no mic / lastSavedAudio / upload mode), sends `start` · L11 Pause → `capture.pause` + mmr_agent pause, status PAUSED · L12 Resume mirrors · L13 Stop → stepper "Finalizing transcript" · L14 RECORDING/PAUSED badge · L15 volume meter · L16 `EMRRecordStatusUpdate` 1 on start, 0 on stop/rollback, never on `open` · L17 start-failure rollback + persistent toast + pre-start note restored · L18 beforeunload · L19 close confirm → stop → close/`closeModal` · L20 Report Issue form · L21 admin mic sidebar open/collapse/backdrop · L22 admin mic refresh · L23 admin roles · L24 admin toggle/expand · L25 admin DSP apply/reset · L26 admin Upload Audio · L27 upload modal files/language/keyboard · L28 upload confirm · L29 upload cancel confirm · L30 upload processing + EMR postMessage · L31 admin live monitor + mute · L32 admin Download All Chunks · L33 chunk forwarding + reconnect replay · L34 `mic.hint` · L35 player controls · L36 admin download file/ZIP · L37 WAV saved on Stop · L38 DownloadRecordingsModal mounted · L39 download transcript · L40 partial/final rendering + mic labels · L41 auto-scroll · L42 dismiss notice · L43 transcript jump · L44 snapshot 1 year · L45 snapshot today + fetch · L46 department expand · L47 pre-summary job at launch · L48 job polling on a served path · L49 non-admin job auto-detect · L50 earlier case notes / priorVisits / vitals sent automatically · L51 warm-start status · L52 live sections + patches · L53 findings jump/show-in-note · L54 return-visit panel → E1 recap + read-only transcript · L55 final note + template + duplicate flags · L56 Copy note · L57 narrative toggle · L58 Edit · L59 Save: Yes = sign + copy, No = DB only, Cancel = revert; Save alone never approves · L60 Copy to EMR: EMR post → `mark_copied_to_emr` → approve + close; mark-only retry; code-path byte-diff empty · L61 "Copied to EMR" disables · L62 sign-off badge + Retry · L63 prolonged-processing message · L64 socket never opened → backend fallback · L65 summary from last saved audio · L66 get_summary_by_session · L67 batch language · L68 browser-created notifications deduped with the svc's · L69 toaster · L70 `isRecordingActive`.

**Workspace-only W01–W22 (onto the routed screen).** W01 phase-driven primary action · W02 elapsed clock correct after 10 min hidden · W03 case-note composer → `note` · W04 speaker turns · W05 gap markers · W06 follow pill · W07 announce-finals toggle · W08 jump to evidence · W09 thinking skeletons · W10 generation strip · W11 cancel generation · W12 regenerate section → `generate` · W13 edit section → `correction` · W14 revert to AI · W15 apply pending patch · W16 provenance popover · W17 AI-baseline diff · W18 duplicate flag · W19 degrade notice · W20 session error chip/document/dialog + retry/dismiss · W21 status footer + Go to note · W22 `summaryLanguage` rendered, inert (TASK-1004).

**Other pages O01–O72.** O01 view header · O02 view close/unload · O03 AI-summaries tab · O04 DepartmentPreSummariesPage branch unchanged · O05 list + pagination (cache, HOPE truth) · O06 search · O07 department filter · O08 consultant filter · O09 date range · O10 read filter · O11 sort · O12 clear filters · O13 page change · O14 view summary · O15 pre-summary toggle · O16 Report Issue · O17 versions from HOPE · O18 start edit · O19 save confirm · O20 save + sign + copy · O21 save DB only · O22 cancel save · O23 copy version text · O24 version → EMR post → mark · O25 cancel EMR copy · O26 per-version copied state · O27 summary page fetch · O28 `fromNotification` listener · O29 mark read on open · O30 edit + save via update_summary_by_session · O31 Report Issue · O32 embedded versions as O18–O26 · O33 dept pre-summaries fetch · O34 create/refresh job · O35 job poll · O36 cancel job · O37 recent-job detect · O38 expand dept · O39 back · O40 bell unread count without a fixed interval · O41 sorted list · O42 mark read → `/?openTab=summary…` + postMessage · O43 delete · O44 clear all · O45 clear read · O46 sort toggle · O47 EntryPoint mic tab/focus · O48 EntryPoint View AI Data · O49 popup-blocked alert · O50 closed-tab detection · O51 no `openTab` → redirect · O52 summary route without ids → message · O53 ErrorBoundary · O54–O62 EMR service functions (provider type, status, test connection, encounter, demographics, vitals, case notes, post case note, unified fetch) still answer via `/api/v1/emr` · O63 DNA style trigger via SDK · O64 DNA job poll · O65 save_pre_summary · O66 trigger_background_summary · O67 generatePreviousCaseNotesSummary · O68 check_record_ready gets a handler · O69 queue health · O70 rate-limit status · O71 AI data service · O72 summary feedback restored via `sendFeedback`.

## 4. Collisions

| File | Lanes | Owner |
|---|---|---|
| `S/.../consultation.module.ts` | F2, F3, F4, F5, F8 | F2 pre-binds tokens; others hand a binding line; F8 edits in wave 4 |
| `consultation.gateway.ts`, `consultation-broker.service.ts` | F2, F3, F4 | F2; F3/F4 via tokens + events file |
| `protocol.ts`, `W/src/consultationProtocol*.js`, `serviceProtocolFixtures.mjs` | F0 + others | F0; changes return to F0 as amendments |
| `medical-summaries.service.ts` | F6, F7 | F6 (F7 works in `hope-attachment.service.ts`) |
| `medical-summary.controller.ts` | F6, F7 | F7 |
| `S/package.json` | F0 (w1), F8 (w4) | sequential |
| `ClinicalUIPopUp.jsx`, `useClinicalLogic.js` | U2, U3, U8 | U3 (w3) then U8 (w4) |
| `RichTextEditor.jsx` | U6 (w1), U4 (w2) | sequential; U4 owns |
| `ConversationPanel.jsx` | U4 | U4 |
| `consultationReducer.js` | U1, U4 | U1 composes U4's slice |
| `useConsultationWorkspace.js` | U7 (+ U1 `wallClock.js`) | U7 |

## 5. Risks

1. Embedded in the EMR: `document.title` has no visible effect inside an iframe; clipboard needs `allow="clipboard-write"` in an iframe; bell `window.open` can be popup-blocked; IndexedDB partitioned. **[orch]** EntryPoint opens ALaaS with `window.open` in its own top-level tab (verified by the non-consultation inventory, EntryPoint rows), so the tab title is visible; no new parent postMessage is added.
2. postMessage contract unchanged (`EMRRecordStatusUpdate` 0/1, `recordingstatus`, `closeModal`, `fromNotification`, target `"*"`); `open` at launch sends no 1; pause sends nothing; spec-pinned.
3. Background throttling: uplink event-driven (mmr_agent socket), elapsed + stepper from server timestamps, 5 s polls refetch on `visibilitychange`, generation runs server-side.
4. DB → cache: legacy rows `source:'cache'` (D-12); Save while HOPE down → `pending_sync` + Bull retry (default); several ALaaS events → one consultation (`encounter_seq`). **[orch] correction:** the planner wrote "Copy to EMR after encounter 1 closes the consultation, so encounter 2 opens a new chained one". Per owner directive 2, Copy to EMR happens only at the end; encounter 2 is appended to the open consultation. A new chained consultation happens only after a close (manual, Copy to EMR at the end, or the 12 h auto-close) — D-7.
5. Release coupling: F2 shim ships on 4.1.0; F8 inside SDK 5's deprecation window; v3 accepted one release; F9 turns CI red until CI has credentials.
6. Open at launch creates consultations that are never recorded → auto-close INCOMPLETE after 12 h (reporting noise).
7. Redis holds state only; sockets/STT/HOPE handles are per process → sticky routing or the lease; restart recovers via idempotent `open` + new STT handshake.
8. No PHI in the tab title.

## Questions raised → orchestrator answers

- Q1 section-scoped regenerate → `generateSummary({sectionKey?})` contract asked of P-E; if unsupported, W12 regenerates the whole note (recorded as D-22 once P-E answers).
- Q2 `closedReason` for the auto-closed launch state → P-AB `ConsultationState` gains `closedReason: 'auto'|'manual'|'approved'` (D-21).
- Q3 lifecycle event stream for the notifier → resolved with P-AB (D-21).
- Q4 reason codes → `GET consultations/feedback/reason-codes` (P-CG §1.3).
- Q5 tab title: top-level tab, see risk 1; Save while HOPE down → `pending_sync` default accepted.
