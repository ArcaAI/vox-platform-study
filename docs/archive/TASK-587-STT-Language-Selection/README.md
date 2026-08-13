# TASK-587 — End-User STT Language Selection (VOX SDK v2), Provider-Aware

- **Status:** Review
- **Type:** feature
- **Branch:** dev-2.1
- **Date:** 2026-07-31

## Requirement Analysis

Let the end user pick a language for the STT pipeline in VOX SDK v2 (`@arcaai/vox`) —
e.g. English, Malayalam, "Malayalam + English" (code-switch), Auto-detect — and **guarantee
the selection fits every provider**, so a language a configured engine cannot serve never
silently mis-transcribes.

Confirmed design decisions (with the requester):
1. **Catalog-wide capability matrix** is the source of truth (describes every engine).
2. **Backend-authoritative** — matrix lives in the STT service, exposed via an endpoint,
   enforced at session-create; the SDK fetches it and never hardcodes provider knowledge.
3. **Single + bilingual modes** — the picker offers single languages, bilingual code-switch
   modes, and auto-detect.
4. **Selection constrains providers** — choosing a mode narrows the eligible engine set for
   the session (primary + fallback). An engine that cannot serve the mode is excluded from
   the chain; if none qualifies, session-create returns **422**.

## Current State Evaluation (pre-change)

`language` was a single free-form `string`, plumbed SDK → REST `POST /stream/session` →
gateway DTO (`@IsString()` only) → applications service → Python, baked into
`inference.language` at session-create, immutable mid-session. **No enum, no per-provider
capability list, no cross-provider validation anywhere.** Engines diverge sharply: NEMO
(Parakeet-v3) has no Malayalam and ignores code-switch; OpenAI is single-language; Sarvam
code-switches natively; Azure via an auto-detect flag; Whisper via a separate translate
gloss. So "malayalam-english" did not fit every provider and nothing caught it.

## Implementation Plan → as executed

Backend-first (STT → gateway → applications → SDK → compat → UI), TDD.

## Implementation Summary

### Phase A — STT service (backend-authoritative matrix + enforcement)
- **New** `apps/stt/src/stt/pipeline/language_modes.py` — closed `LANGUAGE_MODE_CATALOG`
  (`en, ml, ml-en, vi, vi-en, auto`), the per-engine capability matrix
  (`engine_supports_mode`, `engines_supporting_mode`, `modes_supported_by_engine`) built on
  the existing `is_valid_language_for_engine` / `VALID_WHISPER_LANGUAGES` /
  `VALID_PARAKEET_V3_LANGUAGES` + per-engine code-switch facts, `resolve_mode_for_engine`
  (→ `language`/`code_switching`/`streaming_english_gloss`), and `LanguageModeUnsupportedError`.
- `streaming/api/schemas.py` — `CreateStreamingSessionRequest.language_mode`.
- `streaming/session_manager.py` — stash the mode per session (`_session_language_modes`,
  with cleanup); resolve it against `asr_model.format` in `_load_asr_pipeline`. Raising there
  flows through the existing create-time try/except fallback — the "selection constrains
  providers" behaviour (incompatible primary → compatible fallback; none → propagates).
- `streaming/api/routes.py` — forward `language_mode`; map `LanguageModeUnsupportedError` →
  **422** (with `supportedModes`); **new** `GET /internal/streaming/language-modes`.
- Tests: `tests/unit/streaming/test_language_modes.py`,
  `tests/unit/streaming/test_language_modes_api.py`.

### Phase B — Gateway (apps/api)
- `dto/transcription-job.dto.ts` — whitelisted `CreateStreamSessionRequest.languageMode`.
- `transcription-job.controller.ts` — thread `languageMode` into the session payload; **new**
  proxied `GET audio/transcription-jobs/language-modes` (class-level `@Authorize()`).
- Test: `__tests__/transcription-job.stt-fallback.controller.test.ts`.

### Phase C — Applications (packages/applications)
- `services/stt/streaming/dto/streaming-session.dto.ts` — `languageMode` + `SttLanguageMode`/
  `SttLanguageModeCatalog`.
- `streamingSession.service.ts` — forward `language_mode`; **new** `getLanguageModes()`
  (safe empty fallback). `IStreamingSessionService` updated. Tests extended.

### Phase D — SDK (`@arcaai/stt` + `@arcaai/vox`)
- `@arcaai/stt`: `AudioSourceConfig.languageMode` + `ProviderConfig.languageMode`;
  `STTProcessor` threads it into the provider; `StreamingBackendSTTProvider` forwards it to
  `createSession`. Test added.
- `@arcaai/vox`: `AudioStartOptions.languageMode`, `CreateStreamingSessionRequest.languageMode`,
  new `LanguageMode`/`LanguageModeCatalog` types; store `sttLanguageMode` + setter;
  `useArcaAudio.startAudio` sets the store + forwards the mode; `PluginManager` runtime option
  + config resolution; `TranscriptionPipeline` passes it into `createSTT`; `LANGUAGE_MODES`
  endpoint constant; **new hook `useArcaSttLanguageModes`**. Barrels updated.

### Phase E — compat (`@arcaai/vox/compat`)
- `useArcaSpeechToText` — accepts `languageMode` via the frozen v1 `options` bag (same
  additive pattern as `pipelineId`), forwarded to `audio.start`. Signature unchanged.

### Phase F — Picker UI + playground wiring
- **New** `packages/ui/src/components/custom/stt-language-mode-picker.tsx`
  (`SttLanguageModePicker`) — presentational, decoupled from the SDK; barrel + CT test +
  fixtures.
- Wired into the Consultation Scribe playground (`ScribeFooter` +
  `consultation-demo-screen.tsx`): fetches modes via `useArcaSttLanguageModes()`, renders the
  picker in the footer, threads the chosen mode into `audio.start`.

## Verification (evidence)

- STT unit: `test_language_modes.py` + `test_language_modes_api.py` → **12 passed**; full
  `tests/unit/streaming/` → **345 passed**; ruff clean.
- Applications: `pnpm --filter @arcaai/applications test` → **7151 passed** (incl. new
  `language_mode` forwarding + `getLanguageModes`).
- Gateway: streaming controller suite → **8 passed**; `apps/api` typecheck clean for changed
  files (one unrelated pre-existing `stt-compat` test error).
- SDK: `@arcaai/stt` + `@arcaai/vox` build clean; `StreamingBackendSTTProvider` → **420
  passed**; touched vox suites (PluginManager / TranscriptionPipeline / useArcaAudio / compat)
  → **152 passed**. `@arcaai/vox` lint clean on new files.
- UI: `@arcaai/ui` typecheck clean; admin-console typecheck clean.

## Owner tails / follow-ups

1. **Live-switch pre-filtering** — a manual/auto engine switch to a fallback that cannot serve
   the selected mode raises `LanguageModeUnsupportedError` at switch time (fail-loud, never
   mis-serve) rather than pre-excluding it from the switch menu. Create-time chain selection
   already excludes incompatible engines.
2. **Primary-pipeline compatibility** — a chosen pipeline whose primary engine cannot serve
   the mode falls back if a compatible fallback exists, else 422 (planned default).
3. **Mid-session immutability** — mode is baked at session-create (matches today's STT).
4. **E2E on a live stack** — pick "Malayalam + English" in the playground; confirm the
   session-create payload carries `languageMode: "ml-en"`, the STT log shows Sarvam/Azure
   resolution (or Whisper gloss), and a mode no engine can serve surfaces a clean 422.
5. Commit (staged, not committed).

## Known cross-entry pitfall (fixed)

`useArcaSttLanguageModes` uses the store React context (`useStoreApi`). The SDK's
entry points are **separate tsup bundles** (`splitting: false`), so each entry
(`.`, `/core`, `/compat`) inlines its own copy of the store context. **The hook and
the mounted provider must come from the same entry.** The compat playground uses
`<ArcaCompatProvider>` (`@arcaai/vox/compat`), so the hook is re-exported from the
compat entry and MUST be imported from `@arcaai/vox/compat` — importing it from
`@arcaai/vox/core` throws *"useStoreApi() … must be used within an <AgenticProvider>"*
because the core-bundle context was never provided. Fix: `useArcaSttLanguageModes`
(+ `LanguageMode`/`LanguageModeCatalog` types) re-exported from `src/compat.ts`
(mirrors `useArcaSttProvider`).

## Known compat start-coordination pitfall (fixed)

In the compat surface, `useAudioCapture` and `useArcaSpeechToText` drive the **same**
`useArcaAudio()` and both call `audio.start(...)` guarded by `if (audio.isCapturing) return`
— whichever runs first wins. `useAudioCapture.startRecording()` starts with only
`{ pipelineId }` (it has no language), so if it runs before `startTranscription()` (as the
standalone playground's `start()` does — `capture.startRecording()` then
`stt.startTranscription()`), the language-bearing start is skipped and the picker selection is
lost → the pipeline's default language (e.g. Malayalam) is used regardless of the choice.
This pre-dated TASK-587 (the v1 `language` prop was dropped the same way); the `languageMode`
selection inherited it.

**Fix (order-independent):** `useArcaSpeechToText` now publishes its `language`/`languageMode`
into the store via a reactive effect, and `useArcaAudio.startAudio` reads
`languageMode ?? store.sttLanguageMode` — so whichever hook wins the `audio.start` race, the
selection (resolved to a language by the backend) still reaches session-create. The `language`
string is intentionally NOT store-backed (its `'en'` default would override a consumer's
`preferences.language`); the backend resolves `languageMode` to the language, so the mode path
alone is sufficient.

## Change History

- **2026-07-31** — Initial implementation, Phases A–F, all gates green. Status: Review.
- **2026-07-31** — Fixed the compat start-coordination bug that dropped the language
  selection (English selected → Malayalam transcribed): `useArcaSpeechToText` publishes the
  selection into the store; `startAudio` reads it as a fallback so a capture-first start still
  honors the choice. See "Known compat start-coordination pitfall". Tests: 33 pass.
- **2026-07-31** — Fixed a cross-entry React-context crash in the compat playground:
  re-exported `useArcaSttLanguageModes` from `src/compat.ts` and switched the playground
  import from `@arcaai/vox/core` to `@arcaai/vox/compat` (see "Known cross-entry pitfall").
- **2026-07-31** — Catalog set to `en, ml, ml-en, vi, vi-en, auto` (Hindi modes replaced by
  Vietnamese, both code-switch modes CS-enabled). Added a **precise Sarvam language set**
  (`_SARVAM_LANGUAGES`, Indic + en) so the matrix correctly excludes Vietnamese from Sarvam
  instead of the permissive Whisper-set proxy; added the Azure `vi → vi-VN` alias so Azure
  resolution of Vietnamese yields a valid locale. Tests updated + Vietnamese/Sarvam-precision
  cases added (14 passed).
