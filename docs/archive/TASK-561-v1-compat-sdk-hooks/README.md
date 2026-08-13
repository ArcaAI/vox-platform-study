# TASK-561 — v1-Compatible SDK Hooks in `@arcaai/vox/compat`

| | |
|---|---|
| **Status** | Review |
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

Shipped the opt-in `@arcaai/vox/compat` subpath — v1-named hooks that only *consume* the public v2 API. **No v2 core hook/store/client/provider was modified.** Every compat file carries `"use client"` and imports from internal modules (`../hooks/*`, `../store/agenticStore`, `../providers`, `../core/AgenticClient`), never the root barrel and never the store object / deprecated `useAgenticStore` singleton.

### Files created (all under `packages/agentic-sdk-v2/src/`)

| File | Contents |
|---|---|
| `compat.ts` | Build-entry barrel — re-exports hooks + adapter + provider + v1 types. |
| `compat/types.ts` | Frozen v1 type surface (TASK-560 §5): `V1SdkConfig`, `ErrorInfo`, `MedicalSession`/`SessionMetadata`/`SessionStatus`, `AudioDeviceStatus`, `SummaryResponse` + `Enhanced`/`Simplified`/`SOAP` shapes, `SMRRequest`, `PreSummaryRequest`/`PreSummaryResponse`, etc. |
| `compat/config-adapter.ts` | `mapV1ConfigToAgenticConfig()` — pure. **Throws** on missing/blank `credentials.apiKey`; never injects a default. Normalizes `apiEndpoint` up to the gateway `/api/v1` base the v2 hooks require; maps `sttPipelineId`→`audio.stt`, `noiseSuppression`→`audio.noiseFilter`. |
| `compat/ArcaCompatProvider.tsx` | `<ArcaCompatProvider options={SDK_CONFIG_OPTIONS}>` → maps config → `<AgenticProvider>`. |
| `compat/useArcaSessionManager.ts` | Over `useArcaSession`. `createSession`+`startSession` collapse onto ONE idempotent `open()`; `doctorId` kept in `metadata.legacyDoctorId` (never top-level); `endSession`→`close`, `loadSession`→`loadConsultation`, `updateSession`→`update`; `pause`/`resume` = local status only; `mapV2StatusToV1` exported. |
| `compat/useAudioCapture.ts` | Over `useArcaAudio`. `startRecording`/`stopRecording` guarded by `audio.isCapturing` (coordination §3.2a — no double-start with the STT hook); `getDeviceStatus` via `enumerateDevices`; `onAudioData` retained but never invoked. |
| `compat/useArcaSpeechToText.ts` | Over `useArcaAudio` + store selectors. Synthesizes `onTranscript(text,isFinal,meta)` by diffing `transcriptSegments` (final) and `currentTranscript` (interim); applies `transcriptTemplate`; `sendAudioData` = metadata sink (records turn metadata, **no PCM push**). |
| `compat/useSMR.ts` | POSTs **per-turn** `conversation_segments` (F2) to `/api/smr/api/v1/summary/sync` (+ `/presummary`, `/summary/async`) at the origin derived from `AgenticClient.getBaseUrl()` (shim lives outside `/api/v1`, §5.6); `x-api-key` read from the provider-configured client (D2); response passed through unchanged. |
| `compat/__tests__/*.test.ts` | 5 suites, 29 tests (all §3.4 assertions). |

### Registration edits (additive only)

- `tsup.config.ts`: added a `{ compat: 'src/compat.ts' }` entry mirroring `core` (light — plugin packages external).
- `package.json`: added `"./compat"` to `exports` (types/import/require) and `typesVersions["*"].compat`.
- `.d.ts`: chained `tsc --emitDeclarationOnly` emits `dist/compat.d.ts` (+ `dist/compat/*.d.ts`).

### Verification (actual tail output)

- **typecheck** — `tsc --noEmit`: exit 0, no errors.
- **lint** — `eslint src`: `✖ 3 problems (0 errors, 3 warnings)` — all 3 warnings pre-existing in `useArcaConfig.ts`/`AgenticProvider.tsx`; zero in compat.
- **test** — `vitest run`: `Test Files 211 passed (211) · Tests 3600 passed (3600)` (29 new compat tests included).
- **build** — `tsup && tsc`: Build success. `dist/compat.js` (409 KB), `dist/compat.mjs` (407 KB), `dist/compat.d.ts` (2.2 KB) all emitted.
- **subpath resolution** — `require.resolve('@arcaai/vox/compat')` → `dist/compat.js`; CJS and ESM both export the 7 runtime members (`ArcaCompatProvider`, `mapV1ConfigToAgenticConfig`, `mapV2StatusToV1`, `useArcaSessionManager`, `useAudioCapture`, `useArcaSpeechToText`, `useSMR`).

### Notes / deviations

- **`baseUrl` carries `/api/v1`.** TASK-560 §5.1 shows `baseUrl: v1.apiEndpoint` illustratively; the real v2 `AgenticClient` treats `baseUrl` as already carrying `/api/v1` (endpoint constants omit it; ui-playground sets `.../api/v1`). The adapter therefore normalizes the origin up to `/api/v1` so the delegated session/audio hooks work, and `useSMR` strips it back off for the origin-level SMR shim paths.
- **`useSMR` uses `fetch` (not `apiClient.post`).** The SMR shim is origin-level (`/api/smr/api/v1/...`, outside `/api/v1`), which `AgenticClient.post` — which always prepends its `/api/v1` base — cannot reach. `useSMR` reads the origin + `x-api-key` from the same client and issues the POST directly (identical auth posture to v1, which also used `fetch` + `x-api-key`).
- Runtime/browser end-to-end wiring is proven in TASK-563 (guide + example + contract/e2e), not here.

## 6. Change History
| Date | Author | Change |
|---|---|---|
| 2026-07-27 | (planning) | Ticket created from TASK-560. |
| 2026-07-27 | Claude (opus) | Implemented `@arcaai/vox/compat` (barrel + 6 modules + 5 test suites, 29 tests); registered the subpath in `tsup.config.ts` + `package.json`. Gates green: typecheck 0 errors, lint 0 errors, 3600/3600 tests, build emits `dist/compat.{js,mjs,d.ts}`; subpath resolves under `import` and `require`. Status → Review. |
