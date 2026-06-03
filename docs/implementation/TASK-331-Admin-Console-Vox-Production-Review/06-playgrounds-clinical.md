# TASK-331 · Developer Playgrounds — Clinical (Overview / Impersonation / Consultation) — Production Review

| Field | Value |
|---|---|
| Parent | TASK-331 |
| Scope (code) | `apps/ui-playground/src/features/playground/overview/**`, `apps/ui-playground/src/features/introduction/components/service-status-grid.tsx`, `apps/ui-playground/src/features/consultation/**`, `apps/ui-playground/src/routes/_authenticated/{playground/overview,consultation/{index,$id}}.tsx`, `apps/ui-playground/src/hooks/use-realtime-transcription.ts`, `apps/ui-playground/src/components/layout/scope-switcher.tsx`; `@arcaai/vox` `hooks/{useAudioRecordings,useConsultationChain,useArcaAudio}.ts`, `core/DualStreamRecorder.ts`; `apps/api/src/modules/consultation/consultation.controller.ts`; `packages/applications/src/services/consultation/{prompt/prompt-resolution.service.ts,summary/summary.service.ts,context/context.service.ts,consultation/consultation.service.ts}`, `packages/applications/src/services/stt/internal/sttInternal.service.ts`; `packages/database/src/prisma/db_main/seed/09-consultation.ts` |
| Reviewed | `fix/2605-review` @ e91fc450 · 2026-06-03 |
| Verdict | **Ship-with-fixes** |

> Read-only audit. Verified against current code at file:line; TASK-329 §5.9 (P2) describes intent — drift is flagged inline.

---

## 1. Scope & Business Context

This cluster is the clinical heart of the SDK playground, exercised by an admin **impersonating a doctor**:

- **P1 Overview** (`/playground/overview`) — landing surface: SDK info card, **Service Health** grid, **User Impersonation** table, and a reactive `LiveCodePanel`. It is the documented entry point for picking who to impersonate.
- **P2 Consultation** (`/consultation`, `/consultation/$id`) — the real clinician loop: start/resume a consultation, inject context (text/file/audio), capture live audio → transcript, generate a department-prompt summary, and walk the consultation chain (re-visits/referrals).

Both run only after a tenant is active and (for global/tenant admins who aren't themselves doctors) an impersonation session is live. The business question: **does the consultation → transcription → summary loop actually work end-to-end while impersonating a doctor?** Short answer: **yes for the create→context→live-transcript→summary→chain path; no for the "inject a file/audio and get it transcribed" path, and the RAW+PROCESSED dual-capture (X8) is scaffolding-only.**

---

## 2. Metrics Scorecard

| Metric | Super/Global admin | Tenant admin | Evidence |
|---|---|---|---|
| Usability | 🟡 | 🟡 | Core loop works end-to-end; but audio/file "injection" is upload-only (no transcription) `case-note-form.tsx:236`, dual-capture badge never renders `consultation-recording-panel.tsx:173`. Global admin has extra tenant-gate friction + misdirecting guard text `user-list.tsx:300`, `consultation/index.tsx:58`. |
| Clean & friendly UX/UI | 🟢 | 🟢 | Strong rule 07/10/11 adherence: tabbed surfaces, `Skeleton` loaders, `toast` on every action, icon+title+desc empty states (`consultation-detail.tsx:133`, `summary-panel.tsx:129`, `consultation-chain-panel.tsx:77`). Minor: impersonation "Active" badge uses `outline` not `default` (rule 11 §7) `user-list.tsx:125`. |
| Production-ready + seed data | 🟡 | 🟡 | Seed is realistic for chains/revisits/cross-dept/audio `seed/09-consultation.ts:30,55-198,627`, but audio rows use placeholder mediaIds and **no** dual-capture ids `seed/09-consultation.ts:632,675`; the dual-capture production feature has no live writer `sttInternal.service.ts:223`. |
| Core-business / workflow fit | 🟡 | 🟡 | Create/resume + context + **live** transcript + 3-tier dept-prompt summary + chain all wired (`consultation.controller.ts:294,362,566`, `prompt-resolution.service.ts:50`). Undercut by upload-only file/audio injection and dead dual-capture — the "transcription" pillar of the loop is partial. |

Legend: 🟢 ready · 🟡 ship-with-fixes · 🔴 not-ready.

---

## 3. Current State (file:line evidence; per screen P1, P2)

### P1 — Overview + service status + impersonation entry

- **Service-status grid is on Overview (not only `/introduction`).** `OverviewPage` renders `<ServiceStatusGrid />` inside a "Service Health" card — `overview/index.tsx:84-95`. The grid drives `useHealthCheck()`, polls every 30 s, and renders a 5-service card grid with skeletons — `service-status-grid.tsx:27,29-33,51-78`.
- **Impersonation entry + gate.** `UserList` is the impersonation surface — `overview/index.tsx:96`. A global-scope operator with no active tenant is blocked: `impersonateBlockReason = isGlobalScope && !activeTenantId ? 'Select a tenant first' : null` — `user-list.tsx:45-48`; the Start button is disabled with that tooltip — `user-list.tsx:300-313`. TENANT_ADMIN is never gated (locked to own tenant) — confirmed by `user-list-impersonation-gate.test.tsx:121-130`. Impersonation also snapshots admin prefs and loads the impersonated user's `arcaai-sdk` settings — `user-list.tsx:214-247`.
- **Where the global admin actually picks a tenant.** The `TenantSelector` card was **removed from Overview by design** — `overview-tenant-selector-removal.test.ts:4-15`; `overview/index.tsx` imports only `ServiceStatusGrid`, `UserList`, `LiveCodePanel`. Tenant selection now lives in the **header** `ScopeSwitcher` (global picker / locked-tenant badge) — `scope-switcher.tsx:25-66`, mounted at `header.tsx:190`.
- **LiveCodePanel present + reactive.** `buildOverviewSnippet({ tenantId, isSuperAdmin })` via `useMemo` — `overview/index.tsx:15,97`. Reactive to **tenant + super-admin flag** (tenant changes on impersonation) but not to the impersonated user's pipeline/model prefs.

### P2 — Consultation

- **Routing.** List/workspace at `/consultation` → `ConsultationPage` (`consultation/index.tsx:1`, route `index.tsx:1-6`); tabbed detail at `/consultation/$id` → `ConsultationDetail` (`$id.tsx:1-6`).
- **Guards.** Workspace gates on tenant then doctor context — `consultation/index.tsx:18-20,42-88`; detail gates identically (`!tenantId` card, then `ImpersonationGuard`) and only loads when `tenantId && !requiresImpersonation` — `consultation-detail.tsx:96-131`. `requiresImpersonation = isAdmin && !isDoctor && !isImpersonating` — `use-doctor-context.ts:32`.
- **New / resume (same-day revisit).** `StartConsultationDialog` → `session.open({ patientId, appointmentDate })`, dialog copy says "start or resume" — `start-consultation-dialog.tsx:51-54,91`. Backend `POST open` → `consultationService.getOrCreate(...)` — `consultation.controller.ts:294-296`; `getOrCreate` returns the existing same-day consultation (date-part `findByUniqueKey`) or creates one — `consultation.service.ts:97-150` (same-day semantics asserted in `consultation.service.test.ts:263-267`). ✅ resume is real.
- **Tabs.** Detail = **Recording / Audio Case-Note / Summary / Chain** — `consultation-detail.tsx:239-281`.
- **Context injection (`CaseNoteForm`).** 8 inner tabs: Case Note / Transcript / Summary / Template / Custom / Work Note / **Audio File** / **Attachment** — `case-note-form.tsx:324-358`. Text paths post real context items. **Audio File** and **Attachment** are upload-only: `storage.uploadFile(...)` → `addContextItem({ type:'AUDIO_RECORDING'|'ATTACHMENT', structuredData:{ attachmentKey } })` — `case-note-form.tsx:236-262,294-320`. No `useFileTranscription`, no SSE. `addContextItem` posts against `state.consultation.id` (store), not the `consultationId` prop — `case-note-form.tsx:78-90`.
- **In-flow mic recording.** `ConsultationRecordingPanel` uses the playground-local `useRealtimeTranscription()` (full WS PCM streaming, live transcript, reconnect) — `consultation-recording-panel.tsx:38`, `use-realtime-transcription.ts:135-363`. Start passes only `{ pipelineId, consultationId }` with `pipelineId = DEFAULT_TRANSCRIPTION_PIPELINE_ID` (hardcoded `'81000000-…0002'`) — `consultation-recording-panel.tsx:37,51-57`, `audio/constants.ts:1`. Recordings are listed via `useAudioRecordings.list` only; a "Dual capture" badge renders iff `r.rawMediaId || r.processedMediaId` — `consultation-recording-panel.tsx:39,173-178`.
- **Summary.** `SummaryPanel` → `summary.generateSummary()` / `generatePreSummary()` with toasts; shows provider/model + timing — `summary-panel.tsx:47-73,144-148,167-172`. No prompt-tier indicator, no department-prompt picker. Backend `POST :id/summary` → `summaryService.generateSummary` — `consultation.controller.ts:566-568`.
- **3-tier prompt fallback (server).** `PromptResolutionTier = 'preferred' | 'department' | 'default'` — `prompt-resolution.service.ts:50`; `resolve()` resolves Tier-0 preferred → dept → default and sets `resolvedFrom` — `prompt-resolution.service.ts:113-208`. `SummaryService` feeds the **impersonated** doctor's `UserProfile.preferredPromptTemplateId` (`resolvePreferredPromptTemplateId(consultation.doctorId)`) — `summary.service.ts:98,189,512-517` — and forwards `promptResolvedFrom` to SMR — `summary.service.ts:108,201`. ✅ functional; tier not surfaced to UI.
- **Chain.** `ConsultationChainPanel` → `useConsultationChain.fetchChain(id)`, `isLinked = chain.length > 1`, per-node "Open" → `/consultation/$id` — `consultation-chain-panel.tsx:28-33,59,116-121`. Backend `GET :id/chain` → multi-hop walk — `consultation.controller.ts:362-365`. ✅ surfaced in UI.

---

## 4. Findings (severity-ranked)

| # | Sev | Area | Issue | Evidence (file:line) | Metric |
|---|---|---|---|---|---|
| F1 | **High** | P2 file/audio injection | "Inject file/audio" is **upload-only** — no batch transcription + SSE. The Audio File / Attachment tabs only `uploadFile` → create an `AUDIO_RECORDING`/`ATTACHMENT` context item with an `attachmentKey`; the audio is never transcribed. `useFileTranscription` (batch + SSE) is wired **only** into the standalone Audio playground, not the consultation form. Contradicts FOCUS + TASK-329 §1.1 ("batch transcription + SSE wired into CaseNoteForm, not upload-only"). | `case-note-form.tsx:236-262,294-320`; `useFileTranscription` used at `features/audio/batch.tsx:102` only (0 refs under `features/consultation/**`) | Usability, Core-business |
| F2 | **High** | P2 dual capture (X8) | **RAW+PROCESSED dual capture is non-functional end-to-end.** The only live `AudioRecording` writer (`createAudioRecord`) makes one `Media` and never sets `rawMediaId`/`processedMediaId`. The SDK dual-capture toolkit (`DualStreamRecorder`, `getRawInputTrack`) and the dual-id POST (`useAudioRecordings.add`) are **never used** by the playground. Result: the "Dual capture" badge can never render for real or seeded data. | `sttInternal.service.ts:207-237` (no dual ids); `DualStreamRecorder`/`getRawInputTrack` → 0 refs in `apps/ui-playground`; `useAudioRecordings.add` `useAudioRecordings.ts:41-51` uncalled by `consultation-recording-panel.tsx`; badge `consultation-recording-panel.tsx:173-178` | Production-ready, Core-business |
| F3 | **Medium** | P2 mic prefs / hook | In-flow recording does **not** use the impersonated user's **pipeline** preference; `pipelineId` is a hardcoded default and no language/microphone prefs are passed. Also the FOCUS-named SDK hook `useArcaAudio` is not used — the playground uses its local `useRealtimeTranscription`. (Server still resolves the impersonated user's config for the auth token, but pipeline *selection* is fixed.) | `consultation-recording-panel.tsx:37,51-57`; `audio/constants.ts:1`; `useArcaAudio` 0 refs in consultation | Core-business |
| F4 | **Medium** | P2 summary UX | The **3-tier prompt fallback is invisible** in the UI and there's no department-prompt picker. Server computes `resolvedFrom` (preferred/department/default) and sends it to SMR, but `SummaryPanel` shows only provider/model — the doctor/admin can't see which tier (and thus which department prompt) produced the summary. | UI `summary-panel.tsx:144-148`; server `prompt-resolution.service.ts:185-189`, `summary.service.ts:108,201` | Core-business, UX |
| F5 | **Medium** | P1 tenant gate | **Tenant-gate messaging points at a control that no longer exists on the page.** The disabled impersonation button only shows a "Select a tenant first" tooltip (no link), and the consultation guard tells users to "select a tenant from the Playground Overview" — but Overview's tenant card was removed; the real picker is the header `ScopeSwitcher`. Not a hard dead-end, but confusing for a global admin. | `user-list.tsx:300-313`; `consultation/index.tsx:56-70`; `overview-tenant-selector-removal.test.ts:4-15`; `scope-switcher.tsx:25-66` / `header.tsx:190` | Usability, UX |
| F6 | **Low** | P2 LiveCodePanel | Consultation snippet reacts only to `tenantId`, not to the impersonated user or any consultation/pipeline selection — weakly "reactive to impersonated prefs" vs the FOCUS intent. | `consultation/index.tsx:21,86` | UX |
| F7 | **Low** | P2 context target | `CaseNoteForm.addContextItem` posts to `state.consultation.id` rather than the `consultationId` prop; correct only while the active session equals the rendered consultation — a latent cross-surface mismatch (e.g., workspace "Add" dialog vs last-loaded detail). | `case-note-form.tsx:78-90` | Usability |
| F8 | **Low** | P2 diarization feedback | The consultation recording panel ignores `realtime.voiceProfileSeeded` (no `DiarizationSeedingIndicator`), unlike the Audio playground — the impersonated doctor gets no "voice profile seeded" feedback here. | `consultation-recording-panel.tsx:38` (destructures `realtime` but never reads `voiceProfileSeeded`); cf. `use-realtime-transcription.ts:60,159` | UX |
| F9 | **Low** | Docs drift | `PromptResolutionService` header still documents a "two-tier fallback chain" though the code implements three tiers (preferred/department/default). | `prompt-resolution.service.ts:4-8` vs `:50,113-208` | — |

---

## 5. Solutions & Actionable Plan (root cause → solution → TDD → layer chain → verify)

**F1 — Wire batch transcription + SSE into the Audio File tab (root cause: tab calls `uploadFile`+`addContextItem` instead of the transcription pipeline).**
- Solution: on Audio File submit, run `useFileTranscription()` (it already does upload → job → SSE streaming) and persist the resulting transcript via `context.addTranscription(...)`, attaching the audio as an `AUDIO_RECORDING` context item alongside. Surface live SSE progress + partial transcript in the tab.
- TDD: RED a `case-note-form.test.tsx` case asserting an audio submit (a) starts a transcription job, (b) streams partial→final, (c) creates a `TRANSCRIPT` context item; mock `useFileTranscription`.
- Layer chain: UI (`case-note-form.tsx`) → SDK hook (`use-file-transcription.ts`, already SSE-capable) → API (`streaming/transcription-job.controller.ts`, existing). No DB/domain change.
- Verify: `pnpm --filter @arcaai/ui-playground test` + manual smoke (upload audio → see streamed transcript → context item appears in `ContextItemList`).

**F2 — Make dual capture real or honestly hide it (root cause: no live writer sets `rawMediaId`/`processedMediaId`).**
- Option A (wire it): use `DualStreamRecorder` + `getRawInputTrack()` in `ConsultationRecordingPanel`, and on stop call `useAudioRecordings.add(consultationId, { rawMediaId, processedMediaId })` after the two media are persisted server-side. Requires a server path that returns both media ids from the streaming session.
- Option B (de-risk now): gate the "Dual capture" badge behind a real signal and add a tooltip; keep the toolkit as documented-but-not-wired. Cheaper, removes the dead-affordance smell.
- TDD: RED `consultation-recording-panel.test.tsx` — badge renders only when a recording actually carries dual ids; seed a recording with `rawMediaId` in a fixture.
- Layer chain: SDK (`DualStreamRecorder`, `useAudioRecordings`) → API (`POST :id/recordings`, exists `consultation.controller.ts:486-496`) → app (`context.service.ts:205-234`, threads ids). The gap is the **writer** in the streaming/STT path (`sttInternal.service.ts:223`).
- Verify: `pnpm --filter @arcaai/vox test` + e2e recording smoke (deferred to CI).

**F3 — Drive recording from impersonated prefs.** Read the impersonated user's preferred pipeline/language (via `useArcaConfig`/loaded `arcaai-sdk` settings) and pass them into `realtime.start({ pipelineId, language, deviceId, consultationId })`. Quick-win: default `pipelineId` from config rather than the hardcoded constant. Verify with a unit test asserting the panel forwards config-derived options.

**F4 — Surface the prompt tier (quick-win).** Return `promptResolvedFrom` on `SummaryResponse.structuredData` (the field already flows to SMR) and render a `Badge` ("Preferred prompt" / "Dept prompt" / "Default") in `SummaryPanel`. RED a mapper/UI test. Layer chain: app DTO (`summary.dto.mapper`) → SDK type (`SummaryResponse`) → UI (`summary-panel.tsx`).

**F5 — Fix gate guidance (quick-win).** Update the disabled-button tooltip and the consultation tenant-required copy to point at the header tenant switcher (or render an inline "Pick a tenant" affordance), so the instruction matches the actual control. UI-only; `user-list.tsx`, `consultation/index.tsx`.

**Quick-wins:** F4 (tier badge), F5 (gate copy), F9 (fix the stale "two-tier" comment), F8 (mount `DiarizationSeedingIndicator` in the consultation recording panel).

---

## 6. Seed Data Assessment

Seed (`packages/database/src/prisma/db_main/seed/09-consultation.ts`) is **realistic and well-structured** for this cluster:

- **Chains / revisits:** explicit chains documented (`:30-32`) and wired via `parentConsultationId` — `GEN_COMPLETED → GEN_REVISIT` (`:177`), `SURG_NEW → SURG_FOLLOWUP` (`:108`), `CARD_NEW → …REFERRAL` (`:196`). `visitType` spans `NEW_PATIENT` / `REVISIT` / `REFERRAL` (`:60,78,110,126,179,198`). ✅ exercises the Chain tab + same-day resume.
- **Cross-department:** GEN / CARD / SURG / NEUR / PEDS / ER (`:57-160`), owned by distinct seeded doctors (`DOCTOR`, `DOCTOR2`, `DOCTOR_SURGERY`, `DOCTOR_NEURO`, `DOCTOR_PEDS`, `DOCTOR_ER` — `:56-194`). ✅ but note: to see seeded data the admin must impersonate a **doctor who owns consultations** (e.g., `DOCTOR`); impersonating an arbitrary doctor yields an empty list.
- **Audio:** 4 `AudioRecording` rows + `AUDIO_RECORDING` context items (`:382,461,530,627-684`), incl. an in-progress null-duration ER recording (`:675`). ✅ realistic.
- **Gaps:** (a) audio rows use **placeholder** `mediaId` strings (`seed-media-placeholder-001…004`, `:632-674`) → not playable/resolvable; (b) **no** `rawMediaId`/`processedMediaId` on any seeded recording → the dual-capture badge stays hidden even with seed data (compounds F2). Consider one seeded recording with both ids (once a writer exists) to demo X8.

---

## 7. UX/UI Notes (rules 07/10/11)

- **Skeletons (rule 10):** consistently used — service grid (`service-status-grid.tsx:52-62`), detail (`consultation-detail.tsx:133-149`), summary (`summary-panel.tsx:86-95`), chain (`consultation-chain-panel.tsx:35-42`), recordings (`consultation-recording-panel.tsx:148-152`), scope switcher (`scope-switcher.tsx:81-86`). ✅
- **Toasts / feedback (rule 11 §5):** every mutation toasts success/error (`case-note-form.tsx`, `summary-panel.tsx:51,65,79`, `start-consultation-dialog.tsx:56,62`, impersonation `user-list.tsx:249,273`). ✅
- **Empty states (rule 11 §4):** icon + title + description throughout (`summary-panel.tsx:129-136`, `consultation-chain-panel.tsx:77-86`, recordings `:153-161`, workspace `consultation-workspace.tsx:381-383`). ✅
- **Dialog sizing (rule 11 §1):** Add-context dialog is `h-[70vh] w-[70vw]` with scrollable body and flex-grow textareas (`consultation-workspace.tsx:471-476`, `case-note-form.tsx:366-368`). ✅
- **Badge semantics (rule 11 §7):** mostly correct; **deviation** — the impersonation "Active" marker uses `variant="outline"` + amber rather than `default` ("default = active") — `user-list.tsx:120-128`. The AI badge convention (§10) is honored (`consultation-workspace.tsx:520-524`).
- **Misleading affordance:** the "Dual capture" badge (F2) is a dead affordance — it can never trigger with current writers/seed, so it reads as an unimplemented promise.

---

## 8. Open Questions / Assumptions

1. **Assumption:** an impersonation session is active (per brief). With it, the loop runs end-to-end **only** when impersonating a doctor who owns seeded consultations (e.g., `SEED_USER_IDS.DOCTOR`); otherwise lists are empty (expected).
2. **Dual capture (X8) intent:** is server-side dual `Media` creation (raw + processed) planned for the streaming/STT path, or is the X8 surface intentionally "toolkit-only" per §5.9? F2's severity assumes production expects working dual capture; if it's deliberately deferred, downgrade to "hide the badge."
3. **File/audio injection:** is the Audio File tab meant to transcribe (FOCUS) or only to attach raw audio for later processing? Current code does the latter; confirm the intended behavior before implementing F1.
4. **Prompt-tier visibility:** should the resolved tier (and chosen department prompt id) be persisted on `SummaryMeta`/a context item and shown, or is server-side logging sufficient? FOCUS says "surfaced in UI" — currently it is not.
5. **`useArcaAudio` vs `useRealtimeTranscription`:** the FOCUS names `useArcaAudio`; the implementation standardized on the playground-local `useRealtimeTranscription`. Confirm whether convergence on the SDK hook is required for parity with other playgrounds.
