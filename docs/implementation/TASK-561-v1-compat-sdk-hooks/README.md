# TASK-561 — v1-Compatible SDK Hooks in `@arcaai/vox/compat`

| | |
|---|---|
| **Status** | Pending |
| **Type** | feature |
| **Parent** | [TASK-560](../TASK-560-v1-v2-consultation-migration/README.md) |
| **Package** | `packages/agentic-sdk-v2` (`@arcaai/vox`) |
| **Suggested tier** | claude-opus-4-8-medium |
| **Depends on** | TASK-560 §5 (frozen contracts); TASK-562 **contract only** (§5.4 URL/shape) for `useSMR` |
| **Rules to read first** | `08-vox-sdk.md`, `07-react-ui.md` |

> **Goal:** Ship a v1-named hook surface from a new opt-in subpath `@arcaai/vox/compat` that delegates to v2 hooks, so a v1 app changes only its imports + adds one `<AgenticProvider>` wrapper. **No changes to v2 core hooks, store, or clients** — compat files only *consume* the public v2 API.

---

## 1. Requirement Analysis

Reproduce these v1 hooks (signatures frozen in [TASK-560 §5.2/§5.3/§5.1](../TASK-560-v1-v2-consultation-migration/README.md#5-canonical-v1-contracts-single-source-of-truth--frozen)) as thin adapters over v2:

- `useArcaSessionManager` → over `useArcaSession`
- `useAudioCapture` + `useArcaSpeechToText` → coordinated over `useArcaAudio` + store selectors
- `useSMR` → thin `fetch`/`AgenticClient` to the TASK-562 shim endpoint
- `mapV1ConfigToAgenticConfig(SDK_CONFIG_OPTIONS)` adapter + optional `<ArcaCompatProvider>` convenience wrapper

**Non-goals:** TTS/DNA/VAD/diarization compat (out of the target workflow); reproducing v1's raw-PCM `onAudioData` push path (v2 owns transport — `sendAudioData` becomes a metadata sink).

## 2. Current State Evaluation

- v2 public hooks verified present: `useArcaSession` (`src/hooks/useArcaSession.ts:34`), `useArcaAudio` (`src/hooks/useArcaAudio.ts:65`), `useArcaSummary` (`src/hooks/useArcaSummary.ts:60`), store accessors `useArcaStore`/`useStoreApi`. Provider: `src/providers/AgenticProvider.tsx:244`.
- Build system: `tsup.config.ts` has 4 entries; `package.json#exports` maps `.`/`core`/`plugins`/`plugins/med-ner`; `.d.ts` emitted by chained `tsc` (`build: "tsup && pnpm build:dts"`, `tsup` `dts:false`). Adding a subpath requires editing **both** files (see §3.3).
- Constraint from `08-vox-sdk.md`: read state only via `useArcaStore(selector)`/`useStoreApi()`; never export/import the store object; every entry carries `"use client"`.

## 3. Implementation Plan

### 3.1 New files (all under `packages/agentic-sdk-v2/src/compat/`)

| File | Contents |
|---|---|
| `src/compat.ts` | Barrel entry (the `@arcaai/vox/compat` build entry). Re-exports the hooks + adapter + provider + v1 types. Carries `"use client"`. |
| `src/compat/config-adapter.ts` | `mapV1ConfigToAgenticConfig(v1: V1SdkConfig): AgenticConfig` (TASK-560 §5.1). Throws on missing `credentials.apiKey`. |
| `src/compat/ArcaCompatProvider.tsx` | Convenience wrapper: `<ArcaCompatProvider options={SDK_CONFIG_OPTIONS}>` → `<AgenticProvider config={mapV1ConfigToAgenticConfig(options)}>`. |
| `src/compat/useArcaSessionManager.ts` | v1 session hook over `useArcaSession`. Status mapping v2→v1. |
| `src/compat/useAudioCapture.ts` | v1 capture hook over `useArcaAudio` (start/stop, deviceStatus shim). |
| `src/compat/useArcaSpeechToText.ts` | v1 STT hook: coordinates `audio.start(pipelineId)`, synthesizes `onTranscript` from store selectors, `sendAudioData` = metadata sink. |
| `src/compat/useSMR.ts` | v1 summary hook: `summarize`/`summarizeSync`/`preSummarize`/`summarizeAsync` → the shim endpoints via `AgenticClient` (x-api-key already attached by the provider). |
| `src/compat/types.ts` | v1 types (`MedicalSession`, `SessionMetadata`, `SummaryResponse`, `SMRRequest`, `Enhanced/SimplifiedMedicalSummary`, `ErrorInfo`, status enums). Copy from TASK-560 §5. |
| `src/compat/__tests__/*.test.ts` | Vitest unit tests (see §3.4). |

### 3.2 Coordination detail — shared "recording session" between `useAudioCapture` and `useArcaSpeechToText`

v1 apps instantiate both hooks and wire `useAudioCapture.onAudioData → stt.sendAudioData`. In v2 there is ONE audio pipeline. Two options — **use (a)**:

- **(a) Recommended — internal coordinator via store/context.** Both compat hooks call the same v2 `useArcaAudio()` instance (the hook is store-backed per provider, so both see the same capture state). `startRecording()` and `startTranscription()` each call `audio.start(opts)` guarded by `audio.isCapturing` (idempotent — second call is a no-op). `stopRecording()`/`stopTranscription()` call `audio.stop()` guarded likewise. `onAudioData` is retained in the type for source-compat but documented as **not invoked** (v2 owns PCM); if a consumer strictly needs raw frames, expose `createProcessedAudioTap` as an escape hatch in docs (TASK-563), not by default.
- (b) Rejected: hand-rolling a second capture path — would duplicate/΄fight v2's pipeline and risk double-mic.

`pipelineId` for backend streaming comes from `options` (add `sttPipelineId?` to the v1 config adapter, defaulting from `AgenticConfig.audio`/plugin config) — document that live backend transcription requires a `pipelineId`, matching v2 semantics.

### 3.3 Registration edits (additive)

1. `tsup.config.ts`: add a build entry `{ compat: 'src/compat.ts' }` (mirror the `core` entry: `format:['cjs','esm']`, `outDir:'dist'`, `external: [...externalDependencies, ...pluginPackages]` — compat is light, no plugin bundling). 
2. `package.json#exports`: add `"./compat": { "types":"./dist/compat.d.ts", "import":"./dist/compat.mjs", "require":"./dist/compat.js" }`; add the same to `typesVersions["*"].compat`.
3. Ensure `tsc -p tsconfig.json --emitDeclarationOnly` includes `src/compat.ts` (it will, as it's under `src/`). Verify `dist/compat.d.ts` is emitted.

### 3.4 TDD test list (write red first)

- `config-adapter.test.ts`: maps apiEndpoint/websocketUrl/apiKey correctly; **throws** on missing apiKey; never injects a default key.
- `useArcaSessionManager.test.ts` (mock `useArcaSession`): `createSession`+`startSession` → one `open({patientId, metadata})`; `doctorId` not sent as a top-level field; v2 status → v1 status mapping; `endSession` → `close`.
- `useArcaSpeechToText.test.ts` (mock `useArcaAudio` + store): final segment → `onTranscript(text,true,meta)`; interim → `onTranscript(text,false,meta)`; `transcriptTemplate` applied; `sendAudioData` records metadata without throwing and does not push PCM.
- `useAudioCapture.test.ts`: `startRecording` → `audio.start`; idempotent with STT hook (no double-start); `stopRecording` → `audio.stop`.
- `useSMR.test.ts` (mock `AgenticClient`): `summarize` POSTs to `/api/smr/api/v1/summary/sync` with per-turn `conversation_segments` (NOT one collapsed segment — TASK-560 F2); `preSummarize` → `/presummary`; response passed through unchanged (shim already returns v1 shape).
- Build/exports smoke: importing from `@arcaai/vox/compat` resolves types (add to the package's existing resolution test if present).

### 3.5 Verification

- `pnpm --filter @arcaai/vox build lint test typecheck` green.
- `dist/compat.{js,mjs,d.ts}` emitted; `@arcaai/vox/compat` resolves under both `import` and `require`.
- Manual/e2e wiring proven in TASK-563.

## 4. Best Practices

- Every compat file: `"use client"`; plain function components/hooks (no `forwardRef`); read v2 state only via public hooks or `useArcaStore` selectors.
- Keep the mapper pure and unit-tested; do not leak v2 types into the v1 surface (the point is a stable v1 shape).
- Do not import from `@arcaai/vox` root barrel inside compat — import from `./core.js`/`./hooks/*` to avoid pulling plugin bundles into the light compat build.

## 5. Implementation Summary
_(pending)_

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-27 | (planning) | Ticket created from TASK-560. |
