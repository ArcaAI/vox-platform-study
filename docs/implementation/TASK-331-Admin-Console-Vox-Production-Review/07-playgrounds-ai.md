# TASK-331 · Developer Playgrounds — AI (Audio/Transcription / Voice / DNA / Summarization + LiveCodePanel) — Production Review

| Field | Value |
|---|---|
| Parent | TASK-331 |
| Scope (code) | `apps/ui-playground/src/features/{audio,voice-profile,dna-writing-style,summarization}/**`, `apps/ui-playground/src/components/{live-code-panel,impersonation-guard}.tsx`, `apps/ui-playground/src/lib/playground-snippets.ts`, `apps/ui-playground/src/store/audio-store.ts`, `apps/api/src/modules/{voice-profile,dna-writing-style,streaming}/**`, `packages/agentic-sdk-v2/src/{providers/AgenticProvider,core/ConfigManager,hooks/useArcaConfig}.*`, `packages/database/src/prisma/db_main/seed/{08-dna-writing-style,09-consultation,91-user}.ts` |
| Reviewed | `fix/2605-review` @ e91fc450 · 2026-06-03 |
| Verdict | **Ship-with-fixes** |

---

## 1. Scope & Business Context

This cluster is the **clinical-AI half of the `@arcaai/vox` SDK reference playground**. All five screens run *under impersonation*: an admin (SUPER_ADMIN / GLOBAL_ADMIN ≡ super, or TENANT_ADMIN) picks a tenant and impersonates a doctor, then exercises the SDK exactly as a doctor-facing app would. The screens are the canonical "copy-paste this into your app" demonstration of:

- **P3 Audio & Transcription** — in-browser (local Whisper, multi-model, transcribe/translate task, VAD/noise-filter/diarization) **and** remote tenant pipeline (batch + streaming jobs). `apps/ui-playground/src/features/audio/index.tsx`, `.../components/processing-config-panel.tsx`, `.../components/transcript-panel.tsx`, route `routes/_authenticated/audio/{live-transcription,job-transcription}.tsx`.
- **P4 Voice Profile** — local in-browser enrollment (WavLM/Transformers.js) + backend enrollment, embeddings, a quick mic/upload match test, the `voiceProfileSeeded` diarization indicator, and an `isActive` badge. `apps/ui-playground/src/features/voice-profile/{index,local-voice}.tsx`.
- **P5 DNA Writing Style** — view/generate the per-doctor writing-style profile, generate-from-history (version picker), set-default, two-version diff, all gated to the impersonated doctor. `apps/ui-playground/src/features/dna-writing-style/index.tsx`.
- **P6 Summarization** — pre-summary + full summary generation, backend saved-summary list/version browser, `cacheHit`/`qualityScore`, version diff, tagging, edit→new version, namespaced local history. `apps/ui-playground/src/features/summarization/{summary,pre-summary,history}/index.tsx`, `.../components/saved-summaries-panel.tsx`.
- **LiveCodePanel** — a shared reactive Shiki snippet that mirrors the current store + impersonated prefs on every screen. `apps/ui-playground/src/components/live-code-panel.tsx`, `apps/ui-playground/src/lib/playground-snippets.ts`.

**Business stakes:** because this is the SDK *reference*, correctness and per-doctor data isolation matter twice — once for the demo to work, once because integrators will copy the patterns. Behaviour is effectively identical for a global vs. tenant admin (the impersonation gate treats SUPER_ADMIN/GLOBAL_ADMIN/TENANT_ADMIN the same — `apps/ui-playground/src/features/summarization/hooks/use-doctor-context.ts`), with one material difference: **seed data is concentrated in a single tenant**, so a tenant admin impersonating a doctor in a tenant *without* seed rows (e.g. 4bits/Mumbai) sees empty playgrounds (§6).

---

## 2. Metrics Scorecard

| Metric | Super/Global admin | Tenant admin | Evidence |
|---|---|---|---|
| Usability | 🟡 | 🟡 | DNA "Generate Style" is clickable while the per-doctor body is gated → admin can generate a style for *themselves* (`dna-writing-style/index.tsx:643-646,707` outside guard `:650-704`; backend has no doctor-role gate `dna-writing-style.controller.ts:60-61`). Voice Profile is empty out-of-the-box (no seed §6). Everything else works. |
| Clean & friendly UX/UI | 🟡 | 🟡 | Polished overall (skeletons, toasts, badges, empty-states — e.g. `voice-profile/index.tsx`, `saved-summaries-panel.tsx`). Knocks: gated body vs. ungated header button on DNA; `SavedSummariesPanel` binds to an *implicit* "last-loaded" consultation (`saved-summaries-panel.tsx:49-50,183`; `summarization/summary/index.tsx` suggestion loader); raw `profileId` UUID shown in quick-test result. |
| Production-ready + seed data | 🟡 | 🟡 | DNA seed is rich + demonstrable (2 versions for `DOCTOR` → diff/set-default/history all work, `08-dna-writing-style.ts:20-65,148-164,460-461`). But **no `UserVoiceProfile` seed rows** and **`SummaryMeta` seed sets neither `cacheHit` nor `qualityScore`** → those features render empty in demo. Prefs persist only to browser storage, never the server. |
| Core-business / workflow fit | 🟡 | 🟡 | Clinical-AI surface is broad and correct (local+remote STT, dual voice enrollment, DNA generate/version/diff/set-default, summary list/version/diff/tag/edit). But the **default** summary flow re-introduces the raw-DNA-text pattern X3 set out to remove (`summarization/summary/index.tsx` non-debug → `/text/generate`), so the headline reference path teaches the wrong contract. |

**Verdict — Ship-with-fixes.** Features are largely delivered and the UI is polished, but one High isolation defect (DNA generate guard), one architectural drift on the primary summary path (X3), and two seed gaps (voice profiles, summary quality fields) should land before this is a clean production SDK reference.

---

## 3. Current State (file:line evidence)

### P3 — Audio & Transcription
- **Local + remote both present.** Live page renders `AudioWorkspace` (source → config → mixer → transcript) and gates behind impersonation: `apps/ui-playground/src/features/audio/index.tsx` mounts `ProcessingConfigPanel`, `TranscriptPanel`, `LiveCodePanel`. Remote/batch is backed by a full job API — `apps/api/src/modules/streaming/transcription-job.controller.ts:53` (`@Controller('audio/transcription-jobs')`) with `POST /` `:125`, `/batch` `:133`, `/streaming` `:141`, `/transcribe` `:165`, `GET /stats` `:149`, streaming session `POST /stream/session` `:300` + SSE `GET /:id/stream` `:449`, `cancel`/`retry` `:461,469`, all tenant-owned (`@TenantOwnedResource` `:438,461,469`).
- **Multi-model + transcribe/translate task.** `processing-config-panel.tsx` exposes a model select and a Whisper task select; selecting a model calls `selectModel(...)` and task calls `selectSttTask(...)` (`processing-config-panel.tsx` model/task handlers ~`:168-175`), which route through the SDK `ModelRegistry` (`useArcaConfig.ts` `selectModel`/`selectSttTask`).
- **Model-field source.** Store layers browser-viable local models over tenant `localAsrModels` and resolved `availableModels` (`apps/ui-playground/src/store/audio-store.ts` — `BROWSER_VIABLE_MODELS`, `applyTenantDefaults` reads `localAsrModels`, `applyResolvedConfig` reads `stt.availableModels`); a `FALLBACK_ASR_MODELS` list guards an empty registry (`processing-config-panel.tsx:17-21`). No crash on mismatch — handled.
- **Preference persistence is client-only.** Non-model settings (language, noise filter, VAD, diarization, code-switching) call `setUserPreference(...)` → `useArcaConfig.ts` → `ConfigManager.setUserValue()` → `persistUserPreferences()` (`packages/agentic-sdk-v2/src/core/ConfigManager.ts`), whose callback writes a **namespaced IndexedDB/localStorage** blob `arcaai-config::{tenantId}::{userId}` (`packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx`, `makePersistUserPreferencesToStorage`). **There is no `PATCH /user/me/settings`** anywhere in the audio feature — prefs never reach the server. See Finding #5.

### P4 — Voice Profile
- **Backend + local enrollment both present.** `apps/ui-playground/src/features/voice-profile/index.tsx` renders `EnrollCard` (backend) + `ProfileTable`, and `local-voice.tsx` renders `LocalEnrollCard` + `QuickTestCard` (in-browser WavLM via `useLocalVoiceEmbedding`). Backend API: `apps/api/src/modules/voice-profile/voice-profile.controller.ts` — `POST /enroll` `:46`, `GET /` `:79`, `PATCH /:id/activate` `:89`, `PATCH /:id/deactivate` `:100`, `DELETE /:id` `:111`.
- **`isActive` badge is correct (live path).** `ProfileTable` renders Active/Inactive from `profile.isActive`, not a constant (`voice-profile/index.tsx` profile row). 
- **Quick test is client-side only.** `QuickTestCard` computes cosine similarity in-browser against the cached embedding; there is **no `POST /voice-profile/test`** and **no `enroll-embedding`** route on the controller (`voice-profile.controller.ts:46-111` lists only enroll/list/activate/deactivate/delete). Documented deviation; result surfaces a raw `profileId` UUID. See Finding #9.
- **Diarization-seeding indicator wired.** `apps/ui-playground/src/features/audio/components/diarization-seeding-indicator.tsx` renders the `voiceProfileSeeded` state; the transcript pipeline pins the active profile for diarization (`audio/components/transcript-panel.tsx`).

### P5 — DNA Writing Style
- **Generate-from-history, set-default, diff all present** and inside the guard: `dna-writing-style/index.tsx` renders `GenerateFromHistoryPanel` `:667`, `ReportsListPanel` (set-default) `:673`, `VersionDiffSection` `:684`, `VersionsPanel` `:690`, `LiveCodePanel` `:702`, all within `<ImpersonationGuard featureName="DNA writing style">` `:650-704`.
- **"Generate from history" = version picker, not clinical context-item picker.** `GenerateFromHistoryPanel` selects prior DNA **style versions** (`components/generate-from-history-panel.tsx`, filters versions with non-empty `styleText`); the page maps the chosen versions' `styleText`→`textSamples` (+ `sourceIds`) for the generate call (`index.tsx` `handleGenerateFromHistory`). This matches TASK-329 §1.1 ("version picker") but is narrower than the brief's "context-item picker". See Finding #7.
- **Set-default verb/path.** UI `useSetDefaultDnaReport` → `PATCH /dna-writing-styles/:reportId/default` (`features/dna-writing-style/api/dna-writing-styles.ts`), backed by `dna-writing-style.controller.ts:124-125` (`PATCH :reportId/default`). Brief sketched `POST /:reportId/set-default`; implemented as PATCH `…/default`. Documented deviation (Finding #10).
- **❗ Guard gap.** The header **"Generate Style" button (`index.tsx:643-646`) and `GenerateDialog` (`:707`) are rendered OUTSIDE** the `ImpersonationGuard` (`:650-704`). Backend `POST /dna-writing-styles/generate` runs `generateDnaReport(this.getDoctorId(), dto)` with class-level `@Authorize()` only — no doctor-role gate (`dna-writing-style.controller.ts:36,60-61`). See Finding #1 (High).

### P6 — Summarization
- **Backend saved-summary list/version/diff/tag/edit all implemented** in `apps/ui-playground/src/features/summarization/components/saved-summaries-panel.tsx`: backend list via `useArcaSummary().loadSummaries()`, a `QualityBadge` rendering `cacheHit` + `qualityScore`, version history via `getSummaryHistory(...)`, diff via `diffSummaryVersions(...)`→`VersionDiffPanel`, tag add/remove via `tagSummary`/`deleteSummaryTag`, and edit→new version via `updateSummary({ changeSource: 'doctor_edit' })`.
- **Panel binds to an implicit consultation.** `SavedSummariesPanel` requires `session.consultation?.id`, showing "Open a consultation…" otherwise (`saved-summaries-panel.tsx:49-50,183`). On the summary page that id is a side-effect of the suggestion loader (it `session.load()`s consultations in a loop), so the panel can show a *different* consultation's summaries than the items selected for generation. See Finding #6.
- **X10 history namespacing — correct.** `apps/ui-playground/src/features/summarization/history/index.tsx` keys local history as `arcaai-summarization-history::{tenantId}::{effectiveUserId}` (impersonated user when impersonating), reloading on identity change.
- **X3 — split behaviour.** *Pre-summary* uses the ID-based route in both branches: `pre-summary/index.tsx:544,613` → `POST /text/generate/assembled`. The *summary* page uses assembled **only in debug mode**; its **default (non-debug)** path inlines raw `dnaStyleText` + raw template + concatenated context content and posts `/text/generate` (`features/summarization/api/summarization.ts` `useGenerateSummary`/`useStreamSummary`; `summary/index.tsx` non-debug generate/stream handlers). The backend ownership guard exists and is correct on the assembled route — per-context-item cross-tenant check (`apps/api/src/modules/streaming/smr-proxy.controller.ts:603-626`) and cross-doctor DNA-owner check (`:668-690`) — but the default summary path never exercises it. See Finding #2.

### LiveCodePanel
- **Reactive Shiki, bound to store + impersonated prefs — works.** `apps/ui-playground/src/components/live-code-panel.tsx:15` renders via prompt-kit `CodeBlock`/`CodeBlockCode` (Shiki), with copy-to-clipboard `:41-46`. Each page builds `code` from its store/prefs (e.g. DNA `index.tsx:702` passes `dnaCode`; audio/summary similarly), and the snippet header embeds the impersonated user (`lib/playground-snippets.ts:22-26` `contextHeader` → `acting as @{userLabel}`).
- **Snippet fidelity drift.** Builders reference symbols that don't match the real SDK surface: `buildAudioSnippet` imports `useRealtimeTranscription` from `@arcaai/vox` with a `{ model, task, language }` shape (`playground-snippets.ts:100-108`), but that hook is a playground hook (`apps/ui-playground/src/hooks/use-realtime-transcription.ts`) with a different (`pipelineId`/`sampleRate`/…) option shape; `buildDnaSnippet` imports an app-internal path `@/features/dna-writing-style/api/dna-writing-styles` (`:157`); `buildSummarizationSnippet` emits camelCase `promptTemplateId`/`dnaStyleId` (`:197-198`) vs the API's snake_case `prompt_template_id`/`dna_writing_style_id` and omits `context_item_ids`. Samples won't compile/run verbatim. See Finding #8.

---

## 4. Findings (severity-ranked)

| # | Sev | Area | Issue | Evidence (file:line) | Metric |
|---|---|---|---|---|---|
| 1 | **High** | P5 DNA | "Generate Style" button + `GenerateDialog` are **outside** `ImpersonationGuard`; an admin who has *not* impersonated can open the dialog and submit. Backend `generate` derives the owner from the caller (`getDoctorId()`) with no doctor-role gate → the admin gets a DNA style created under their **own** account (per-doctor isolation break; brief pre-labels this Critical). | `apps/ui-playground/src/features/dna-writing-style/index.tsx:643-646` (button), `:707` (dialog), guard `:650-704`; `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts:36` (`@Authorize()`), `:60-61` (`generateDnaReport(this.getDoctorId(), dto)`) | Usability, Core-fit |
| 2 | **Medium** | P6 X3 | Default (non-debug) summary generation posts raw DNA text + raw template + inlined context to `/text/generate`, bypassing the assembled/ID route the ownership guard protects. Inconsistent with pre-summary (which uses assembled) and re-introduces the raw-DNA pattern X3 removed. No cross-doctor *leak* in practice (data is the impersonated doctor's own), but the headline reference path teaches the wrong contract and sends full PHI + DNA text in-prompt. | `apps/ui-playground/src/features/summarization/api/summarization.ts` (`useGenerateSummary`/`useStreamSummary` → `/text/generate`); `apps/ui-playground/src/features/summarization/summary/index.tsx` (non-debug generate/stream); contrast `apps/ui-playground/src/features/summarization/pre-summary/index.tsx:544,613` (assembled); guard exists `apps/api/src/modules/streaming/smr-proxy.controller.ts:603-626,668-690` | Core-fit |
| 3 | **Medium** | P4 Seed | **No `UserVoiceProfile` seed rows** anywhere (only schema/migration/policy reference the model). Voice Profile playground, the active-profile diarization seeding, and the `voiceProfileSeeded` indicator are all empty for a freshly seeded doctor → not demonstrable out-of-the-box. | No match for `VoiceProfile` rows in `packages/database/src/prisma/db_main/seed/**`; only `user.prisma`, `seed/01-policy.ts`, `migrations/.../add_user_voice_profile/migration.sql` | Production/seed |
| 4 | **Medium** | P6 Seed | `SummaryMeta` seed (4 rows) populates neither `cacheHit` nor `qualityScore`, so the `QualityBadge` in `SavedSummariesPanel` never renders for demo data despite being modeled + surfaced. | `packages/database/src/prisma/db_main/seed/09-consultation.ts:25,1066-1070` (DEFAULT_SUMMARY_METAS upsert); no `cacheHit`/`qualityScore` anywhere under `seed/`; badge at `apps/ui-playground/src/features/summarization/components/saved-summaries-panel.tsx` (`QualityBadge`) | Production/seed |
| 5 | **Medium** | P3 SDK | Audio prefs persist **only to browser** (namespaced IndexedDB/localStorage), never `PATCH /user/me/settings`; and the production `AgenticProvider` never calls `configManager.setReadOnly(true)` during impersonation (TASK-245 intent, asserted in `impersonation-config.test.ts`). So admin edits while impersonating write into the impersonated doctor's *local* namespace and never sync to the doctor's real/server profile or other devices. | `packages/agentic-sdk-v2/src/core/ConfigManager.ts` (`setUserValue`→`persistUserPreferences`); `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx` (`makePersistUserPreferencesToStorage`, no `setReadOnly`); `packages/agentic-sdk-v2/src/core/__tests__/impersonation-config.test.ts` | Production, Core-fit |
| 6 | **Medium** | P6 UX | `SavedSummariesPanel` binds to `session.consultation` set as a side effect of the suggestion loader (last consultation `session.load()`-ed wins) — no explicit consultation picker — so it may list a different consultation's summaries than the items being summarized. | `apps/ui-playground/src/features/summarization/components/saved-summaries-panel.tsx:49-50,183`; `apps/ui-playground/src/features/summarization/summary/index.tsx` (suggestion loader `session.load(...)` loop) | Usability, UX |
| 7 | **Low–Med** | P5 Fit | "Generate from history" is a **DNA version** picker (re-uses prior `styleText` as `textSamples`), not the clinical **context-item** picker the brief's parenthetical implies. Matches TASK-329 §1.1 scope but narrows clinical relevance of first-time generation. | `apps/ui-playground/src/features/dna-writing-style/components/generate-from-history-panel.tsx`; `apps/ui-playground/src/features/dna-writing-style/index.tsx` (`handleGenerateFromHistory`, `versions`→`textSamples`) | Core-fit |
| 8 | **Low** | LiveCode | Snippet fidelity: `useRealtimeTranscription` imported from `@arcaai/vox` with wrong option shape (real hook is `@/hooks/use-realtime-transcription`); DNA snippet imports an app-internal path; summarization snippet uses camelCase IDs vs API snake_case and omits `context_item_ids`. Copy-paste samples won't compile/run as-is. | `apps/ui-playground/src/lib/playground-snippets.ts:100-108,157,197-198`; real hook `apps/ui-playground/src/hooks/use-realtime-transcription.ts` | UX, Core-fit |
| 9 | **Low** | P4 | Quick-test is client-side cosine only; no `POST /voice-profile/test` / `enroll-embedding` endpoints (documented deviation). Result surfaces a raw `profileId` UUID rather than a friendly label. | `apps/ui-playground/src/features/voice-profile/local-voice.tsx` (`QuickTestCard`); `apps/api/src/modules/voice-profile/voice-profile.controller.ts:46-111` (no test/enroll-embedding) | UX |
| 10 | **Low** | P5 | `set-default` is `PATCH /:reportId/default` (reuses `isLatest`), not the brief's `POST /:reportId/set-default`. Functionally correct, naming drift. | `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts:124-125`; `apps/ui-playground/src/features/dna-writing-style/api/dna-writing-styles.ts` (`useSetDefaultDnaReport`) | — |
| 11 | **Low** | P4 / hygiene | Orphaned `VoiceEmbeddingPanel` — the §5.13 always-"Active"→`isActive` badge fix was applied to a component that is **never mounted** (audio workspace renders config/transcript panels; voice page uses `ProfileTable`). Dead code; live path already correct. | `apps/ui-playground/src/features/audio/components/voice-embedding-panel.tsx`; not imported by `apps/ui-playground/src/features/audio/components/audio-workspace.tsx` | Hygiene |

---

## 5. Solutions & Actionable Plan

**Quick-wins (low risk, high signal):**
- **F3 (voice seed):** add a handful of `UserVoiceProfile` rows in `91-user.ts` for `DOCTOR`/`DOCTOR2` (one `isActive: true`, one inactive) with deterministic placeholder embeddings → ProfileTable, `isActive` badge, and `voiceProfileSeeded` all become demonstrable.
- **F4 (summary quality seed):** set `cacheHit` (mix true/false) and `qualityScore` (e.g. 0.78–0.95) on the 4 `DEFAULT_SUMMARY_METAS` in `09-consultation.ts` → `QualityBadge` renders in demos.
- **F10 / F11:** rename the set-default route to match the brief (or just record the deviation in TASK-329), and delete the orphaned `voice-embedding-panel.tsx` (or mount it where intended).

**F1 — DNA generate guard (do first):**
- *Root cause:* the trigger (`Generate Style` button + `GenerateDialog`) lives outside `ImpersonationGuard`, and the API generate route has no doctor-scope gate, so a non-impersonating admin can self-generate.
- *Solution:* move the button + dialog **inside** `<ImpersonationGuard>` (or disable the button when `requiresImpersonation`), and add a defense-in-depth server check (reject `generate` when the caller is not acting as a doctor / is an admin without impersonation).
- *TDD:* (RED) component test asserting the Generate button/dialog is not rendered when `requiresImpersonation` is true (extend `features/dna-writing-style/__tests__/dna-impersonation-guard.test.ts`); API test asserting `POST /dna-writing-styles/generate` is rejected for an admin caller without doctor scope. (GREEN) move markup + add guard. (REFACTOR) consolidate on one `ImpersonationGuard`.
- *Layer chain:* UI (`dna-writing-style/index.tsx`) → API (`dna-writing-style.controller.ts`) → Service (`generateDnaReport`).
- *Verify:* `pnpm --filter @arcaai/ui-playground test -- dna-impersonation` and the API e2e for the dna controller (read-only here — not run).

**F2 — X3 default summary path:**
- *Root cause:* the summary page's non-debug generate/stream call `/text/generate` with raw DNA/template/context text instead of the ID-based assembled route used by pre-summary.
- *Solution:* route the default summary flow through `/text/generate/assembled` with `prompt_template_id` + `dna_writing_style_id` + `context_item_ids` (mirror `pre-summary/index.tsx:544,613`); keep raw text only behind an explicit "debug/raw" toggle.
- *TDD:* (RED) test that the default generate handler posts to `/text/generate/assembled` with IDs (not raw `styleText`). (GREEN) swap the mutation. *Layer chain:* UI summary handlers → `smr-proxy.controller.ts` (guard already present `:603-690`).
- *Verify:* `pnpm --filter @arcaai/ui-playground test -- summarization` (read-only here).

**F5 — prefs persistence + impersonation read-only:**
- *Root cause:* `AgenticProvider` wires only local-storage persistence and never flips `ConfigManager` read-only during impersonation.
- *Solution:* either (a) add a debounced `PATCH /user/me/settings` sync when *not* impersonating, and (b) call `configManager.setReadOnly(true)` while impersonating (matching `impersonation-config.test.ts`) so admin edits don't mutate the impersonated doctor's local namespace.
- *TDD:* extend `impersonation-config.test.ts` to cover the provider wiring path. *Layer chain:* SDK provider/core only.

**F6 — saved-summaries consultation binding:** add an explicit consultation selector to `SavedSummariesPanel` (or bind it to the consultation that owns the selected context items) instead of "last loaded wins".

**F7/F8/F9:** low priority — broaden generate-from-history to also accept clinical context items; fix snippet imports/field-casing to the real SDK surface; show a friendly profile label (and optional server `/voice-profile/test`) in quick-test.

---

## 6. Seed Data Assessment

| Domain | Seeded? | Demonstrable? | Evidence |
|---|---|---|---|
| **DNA writing style** | ✅ Rich | ✅ Yes | `packages/database/src/prisma/db_main/seed/08-dna-writing-style.ts:20-65` — 6 reports across `DOCTOR`/`DOCTOR2`/`DEPT_HEAD`/… with realistic clinical `styleText` + `reportData` (formality/sentenceLength/medicalTermUsage/abbreviationStyle). `DOCTOR` has an old v1 + current v2 (`:33-34,48-49`) and `dnaWritingStyleVersion` snapshots are seeded (`:148,164,460-461`) → **diff, set-default, version browser, and generate-from-history all have data**. |
| **Summaries (SummaryMeta)** | ⚠️ Partial | ⚠️ Partial | `09-consultation.ts:25,1066-1070` seeds 4 `SummaryMeta` rows + summary context items, so the saved-summary **list/version/diff/tag** can be exercised — but `cacheHit`/`qualityScore` are **not** set, so the `QualityBadge` never renders (Finding #4). |
| **Voice profiles** | ❌ None | ❌ No | No `UserVoiceProfile` rows in `seed/**` (only `user.prisma`, `seed/01-policy.ts` policy ref, and the migration). Voice Profile playground, diarization seeding, and `voiceProfileSeeded` are empty out-of-the-box (Finding #3). |

**Tenant concentration:** seed rows hang off `SEED_TENANT_ID`/`SEED_USER_IDS` (`08-dna-writing-style.ts:3-9,22-24`), so a **tenant admin** impersonating a doctor in a tenant without seed data sees empty DNA/summary playgrounds too — worth seeding at least one demo doctor per demonstrable tenant, or documenting which tenant to demo in.

---

## 7. UX/UI Notes (rules 07/10/11)

- **Strengths:** consistent card/section composition, lucide icons, skeletons + empty-states, toast feedback, and copy-to-clipboard affordances align with rules 07/10/11 (e.g. `voice-profile/index.tsx`, `saved-summaries-panel.tsx`, `live-code-panel.tsx:61-69` copy button with `Copied` state). The `LiveCodePanel` description explicitly tells the user the sample reflects the current selection + impersonated user (`live-code-panel.tsx:36`).
- **Gate consistency (rule 11 — predictable state):** DNA shows a gated body but an enabled header action (`dna-writing-style/index.tsx:643-646` vs `:650-704`) — a confusing/unsafe mixed state. Standardize: when a screen is gated, its primary actions should be gated/disabled too.
- **Two `ImpersonationGuard`s:** a props-based variant (`features/summarization/components/impersonation-guard.tsx`, used by audio/summary/pre-summary in a ternary) and a children-wrapping variant (`apps/ui-playground/src/components/impersonation-guard.tsx`, used by voice/DNA). Both work, but the divergence is what enabled Finding #1. Consolidate on one.
- **Readable identifiers (rule 07):** quick-test surfaces a raw `profileId` UUID (`local-voice.tsx` `QuickTestCard`); prefer the profile label.
- **Implicit context (rule 11):** `SavedSummariesPanel`'s "active consultation" is a hidden side effect (Finding #6) — make it explicit.

---

## 8. Open Questions / Assumptions

1. **Is the default summary flow's raw-text path intentional** (debug-only fidelity) or a regression? Pre-summary uses assembled+IDs; summary's *debug* path does too — only summary's default path doesn't (Finding #2). Confirm whether assembled should be the default.
2. **Per-doctor `generate` authorization at the API:** the controller is `@Authorize()` (authenticated) and trusts `getDoctorId()` = caller. Is a doctor-role/impersonation gate intended server-side, or is the UI guard the sole control? (Drives whether Finding #1 needs a backend fix too.)
3. **Voice profile seeding:** is the absence intentional (enrollment is meant to be done live during a demo) or an omission? If live-only, the playground should say so; otherwise seed it (Finding #3).
4. **Preferences sync:** is client-only persistence the accepted design (TASK-329 documents it), or is server sync (`PATCH /user/me/settings`) still expected for production parity (Finding #5)?
5. **TASK-245 read-only-during-impersonation:** the unit test asserts it but the provider doesn't wire it — is the test aspirational, or is the provider missing the call?

*All claims in §1–§8 above were verified by reading source at the cited `file:line` on `fix/2605-review` @ e91fc450 during the audit; no files other than this document were created or modified at audit time.*

---

## 9. Implementation Summary

**Status:** Completed · **Merged to** `fix/2605-review` @ `a32811b8` · 2026-06-04

Work was executed by **four non-overlapping agents in isolated git worktrees** (branched from `fix/2605-review` @ `27759b42`, after doc-05 + doc-06 had merged). Each agent's scope was a **strictly file-disjoint** set; each gated green independently (TDD RED→GREEN), then all four merged clean into `fix/2605-review` (`ort` strategy, **0 conflicts** — confirmed disjoint). The §8 open questions were resolved per the audit's own recommendations and shaped the scope below.

### Resolved open questions (decisions)
- **Q1/F2 — default summary raw-text path:** treated as a regression → **route the default flow through `/text/generate/assembled`** (IDs), keep raw text only behind the existing debug toggle.
- **Q2/F1 — server-side `generate` authorization:** **yes, defense-in-depth** → added a controller doctor-scope gate in addition to the UI guard.
- **Q3/F3 — voice-profile seeding:** **seed it** (additive demonstrability; live enrollment still works) → `UserVoiceProfile` rows added.
- **Q4/F5 — preferences sync:** **add server sync for production parity** → debounced `PATCH /user/me/settings` when not impersonating.
- **Q5/F5b — TASK-245 read-only-during-impersonation:** **already wired by doc-05** (the production `user-list.tsx` calls `setReadOnly(true)` on impersonation start, `false` on end; `ConfigManager.persistUserPreferences()` short-circuits on `readOnly`). Verified — no longer aspirational. F5a (server sync) is gated by this same flag.

### What was built (by finding)

| # | Sev | Resolution | Key files |
|---|---|---|---|
| **F1** | High | UI: "Generate Style" button + `GenerateDialog` now render only `{!requiresImpersonation && …}` (inside the gate). Backend (defense-in-depth): `assertActingAsDoctor()` in the controller reads CLS user roles + `impersonatedBy` and throws `ForbiddenException` for an admin without doctor scope/active impersonation. | `dna-writing-style/index.tsx`, `dna-writing-style.controller.ts` (+ controller test, +`dna-impersonation-guard.test.tsx`) |
| **F2** | Med | New `useGenerateSummaryAssembled()` → `/text/generate/assembled`; the summary page's **default** generate + stream now post `prompt_template_id`/`dna_writing_style_id`/`context_item_ids` (raw `buildPromptAndSystem` inlining removed); raw `/text/generate` no longer reachable from the summary page. | `summarization/api/summarization.ts`, `api/index.ts`, `summary/index.tsx` (+`summary-assembled-route.test.tsx`) |
| **F3** | Med | `UserVoiceProfile` seed rows for `DOCTOR`/`DOCTOR2` (one active + one inactive each; respects the partial-unique active index), `vector(256)` deterministic unit-normalized embeddings written via `$executeRawUnsafe` (mirrors `UserVoiceProfileRepository.createWithEmbedding`); ids in `00-constants.ts`. No `tenantId` (model is `userId`-scoped). | `seed/91-user.ts`, `seed/00-constants.ts` (+`seed.test.ts`) |
| **F4** | Med | `cacheHit` (mixed true/false) + `qualityScore` (0.84–0.91) set on the existing `SummaryMeta` seed rows so `QualityBadge` demos both states. | `seed/09-consultation.ts` (+`seed.test.ts`) |
| **F5a** | Med | `ConfigManager` gains a second persist callback (`onPersistUserPreferencesToServer`), invoked behind the existing `readOnly` short-circuit; `AgenticProvider` adds a **debounced (500 ms)** `makePersistUserPreferencesToServer` that flattens the user-pref tier to dot-paths and PATCHes each leaf to `/user/me/settings/arcaai-sdk/{key}` with PascalCase `dataType`, with a flush-time read-only re-check. Local-storage persistence unchanged; failed PATCHes never break it. | `agentic-sdk-v2/core/ConfigManager.ts`, `providers/AgenticProvider.tsx` (+`impersonation-config.test.ts`, +`AgenticProvider.serverPrefSync.task331.test.ts`) |
| **F5b** | Med | **Done upstream by doc-05** — verified, not re-implemented. | `user-list.tsx`, `use-end-impersonation.ts` (doc-05) |
| **F6** | Med | Explicit consultation `<Select>` in `SavedSummariesPanel` (`selectedConsultationId ?? session.consultation?.id`); `reloadSummaries` `await session.load(consultationId)` before `loadSummaries()`, decoupling from the implicit "last-loaded" side effect. | `summarization/components/saved-summaries-panel.tsx` (+test) |
| **F8** | Low | `buildAudioSnippet` → real `useArcaAudio` (`startFromPreferences()`); `buildDnaSnippet` → `useDnaStyle` from `@arcaai/vox`; `buildSummarizationSnippet` → snake_case `prompt_template_id`/`dna_writing_style_id` + `context_item_ids`; top JSDoc corrected. | `lib/playground-snippets.ts` (+test) |
| **F9** | Low | `QuickTestCard` resolves a friendly `matchedLabel` from the enrolled profile (fallback to a shortened id) instead of the raw `profileId` UUID. | `voice-profile/local-voice.tsx` (+test) |
| **F11** | Low | Deleted the orphaned `voice-embedding-panel.tsx` + its test (zero references confirmed). | (removed) |
| **F7** | Low-Med | **Accepted deviation — documented, no code.** "Generate from history" remains a DNA **version** picker (matches TASK-329 §1.1); a clinical context-item picker is a scope expansion, deferred. | — |
| **F10** | Low | **Accepted deviation — documented, no code.** `set-default` stays `PATCH /:reportId/default` (functionally correct; renaming the route is API-compat risk for no functional gain). | — |

### Verification (consolidated post-merge gate @ `a32811b8`)
- **Dep-graph build:** `turbo run build` for ui-playground + api closures (incl. merged `@arcaai/vox`, `@arcaai/ui` DTS) → **14/14 tasks**, clean.
- **Typecheck:** `@arcaai/ui-playground` `tsc --noEmit` → **0 errors** (the 555 errors seen mid-flight were purely unbuilt `@arcaai/ui` subpath types — resolved by building deps first); `@arcaai/vox` + `@arcaai/database` clean.
- **Tests:** ui-playground **908**, `@arcaai/vox` **3280**, `@arcaai/database` **696** (incl. seed), apps/api **1569 passed / 4 skipped** → **all passing, 0 failing**.
- **Lint:** IDE diagnostics on all 13 merged source files → **0 errors**.
- **Pre-existing (not introduced by doc-07):** apps/api whole-repo `tsc` reports type errors in untouched test files (`auth/__tests__/*`, `consultation.controller.test.ts`, `dna-writing-style-admin.controller.test.ts`); these exist on the baseline and the vitest runtime suite is green.

### Deferrals / follow-ups (tracked, not blocking)
1. **F7** — broaden DNA "generate from history" to also accept clinical **context items** (scope expansion beyond TASK-329 §1.1).
2. **F10** — optional `POST /:reportId/set-default` route rename for brief parity.
3. **F2 dead hooks** — `useGenerateSummary` / `useStreamSummary` are now orphaned in `summarization/api/summarization.ts` (the summary page no longer calls them). Recommend deleting in a follow-up (left in place here to avoid public-API churn outside the F2 ask).
4. **F4 row count** — the seed file currently holds **2** `SummaryMeta` rows (the `// SUMMARY METAS (4)` comment is a pre-existing inaccuracy); `cacheHit`/`qualityScore` were applied to the rows that exist and the test written generically (`≥2 rows`).
5. **F3 UI copy** — an optional "enroll live during the demo" note on `voice-profile/index.tsx` was not added (outside the seed agent's file scope); seeding already makes the page demonstrable.

---

## 10. Change History

| Date | Change | Files / Commits |
|---|---|---|
| 2026-06-04 | **F3/F4 SEED** — `UserVoiceProfile` rows for DOCTOR/DOCTOR2 (`vector(256)` deterministic embeddings) + `cacheHit`/`qualityScore` on `SummaryMeta` | `a4549afd` → merge `5e4dec60` |
| 2026-06-04 | **F5a SDK** — debounced server-sync of user prefs via `PATCH /user/me/settings/arcaai-sdk/{key}` when not impersonating (read-only-gated + flush-time re-check) | `3871d771` → merge `5c48675c` |
| 2026-06-04 | **F2/F6 SMR** — default summary generate+stream via `/text/generate/assembled` (raw inlining removed); explicit consultation selector in `SavedSummariesPanel` | `a8e05efd` → merge `1d58f4a2` |
| 2026-06-04 | **F1/F8/F9/F11 UI** — DNA generate gated inside `ImpersonationGuard` + backend `assertActingAsDoctor()`; snippet fidelity (`useArcaAudio`/`useDnaStyle`/snake_case ids); friendly quick-test label; deleted orphaned `VoiceEmbeddingPanel` | `d7501d1a` → merge `a32811b8` |
