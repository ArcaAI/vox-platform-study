# TASK-304 — Local STT Workflow Refactor

| Field | Value |
| --- | --- |
| Ticket | TASK-304 |
| Name | Local STT Workflow Refactor — voice sample as user setting + bug fixes |
| Created | 2026-05-25 |
| Updated | 2026-05-25 |
| Status | Completed |
| Branch | `fix/2605-local-stt-refactor` (off `fix/2605-review`) |

---

## 1. Requirement Analysis

### Description

Hope has two speech-to-text workflows:

- **Local workflow** — Whisper + Silero VAD + RNNoise + local MFCC diarizer, all running in-browser.
- **Remote workflow** — backend ASR pipeline (assigned by admin via `AsrPipeline`).

Both workflows expose the same capabilities to the user:

- Voice sampling for speaker detection (diarization)
- VAD for diarization and audio segmentation
- Noise cancellation

This ticket focuses on the **local workflow**: ensure that noise suppression, VAD, diarization, and STT are properly user-configurable, that workflow settings are persisted (DB) and cached (browser), and that voice samples are treated as user settings.

### Business Context

The local workflow gives doctors choice over models that ship in the browser, runs without backend STT availability, and lets them tune for personal acoustic environment / device.

The remote workflow is admin-controlled (a single `AsrPipeline` resolved per tenant). Both need a consistent user-facing settings shape and a single source-of-truth for activated voice profile so the local diarizer can anchor speaker IDs to the doctor's enrolled embedding.

### Acceptance Criteria

- `UserPreferences.localConfig` contains a `voiceProfile` sub-config (user preferences for voice profile behaviour: `autoActivateLatest`, `similarityThreshold`).
- `UserPreferencesResponse` exposes a read-only `activeVoiceProfile` summary resolved from `UserVoiceProfile.isActive` at read time (mirrors the `remoteConfig` pattern).
- VAD `postSpeechPadMs` is forwarded to MicVAD (no longer silently dropped).
- VAD `updateThresholds()` validates positive/negative range and ordering.
- NoiseFilter `DEFAULT_NOISE_FILTER_OPTIONS` is frozen (no shared-mutation footgun).
- NoiseFilter `updateOptions({ enableStats: true })` does not leak `setInterval` when stats are already enabled.
- STT `setLanguage()` triggers a local provider reinit (no more silent warning).
- Tests cover every change.
- Affected packages build with no new lints.
- Branch merges cleanly back to `fix/2605-review`.

---

## 2. Current State Evaluation

### Architecture Snapshot

```
Mic
 │
 ▼
@arcaai/room → AudioContextManager (48 kHz)
 │
 ▼
NoiseFilterProcessor (RNNoise WASM, AudioWorklet)
 │   processedTrack
 ▼
VADProcessor (Silero VAD v5 / @ricky0123/vad-web AudioWorklet)
 │   on `vad-speech-end` → Float32Array
 ▼
STTProcessor → LocalSTTProvider → WhisperWorkerEngine (Web Worker, Transformers.js)
                                     │
                                     ▼
                                LocalSpeakerDiarizer (MFCC, main thread, ephemeral)
                                     │
                                     ▼
                            TranscriptionResult (with speakerId)
```

Settings flow today:

```
Doctor toggles in playground UI
         │
         ▼
audio-store (Zustand, in-memory only)         ← NOT WRITTEN BACK to UserPreferences
         │
         ▼
SDK PluginManager / processors apply at start

GET preferences ──► UserSettings (DB)
            ▲              │
            │              ▼ (cached)
       backend         IndexedDB (`arcaai-config`, namespaced per user+tenant)
```

### Concrete Gaps & Bugs

| # | Layer | Issue | File / Symbol |
| --- | --- | --- | --- |
| 1 | Backend DTO | `LocalWorkflowConfigDto` has no `voiceProfile` field; voice samples cannot be expressed as user preferences | `userPreferences/dto/update-user-preferences.request.ts` |
| 2 | Backend Service | `getPreferences()` never resolves user's active `UserVoiceProfile` even though it's the canonical "voice sample" | `userPreferences/userPreferences.service.ts` |
| 3 | SDK Type | `LocalWorkflowConfig` SDK type lacks the matching `voiceProfile` sub-config | `agentic-sdk-v2/src/types/config.ts` |
| 4 | VAD | `postSpeechPadMs` option is typed and merged into defaults but never forwarded to `MicVAD.new()` — silently dropped | `vad/src/processors/VADProcessor.ts` |
| 5 | VAD | `updateThresholds()` accepts any numbers — no 0–1 bound, no `pos >= neg` invariant | `vad/src/processors/VADProcessor.ts` |
| 6 | NoiseFilter | `DEFAULT_NOISE_FILTER_OPTIONS` is a plain object — shared mutation footgun (MED-9) | `noise-filter/src/types/index.ts` |
| 7 | NoiseFilter | `updateOptions({ enableStats: true })` when stats already enabled starts a 2nd `setInterval`, leaking the first (MED-10) | `noise-filter/src/processors/NoiseFilterProcessor.ts` |
| 8 | STT | `setLanguage()` does not reinitialize local provider — only logs a warning | `stt/src/core/STTProcessor.ts` |

### In Scope

- Backend voice-profile-as-preference (DTO + service resolution).
- SDK type sync.
- All 5 bug fixes listed above.
- Tests for every change.

### Out of Scope (documented as follow-ups)

- Persisting local diarizer profiles across sessions (tracked in TASK-293, requires neural embedding compatibility).
- Raw enrollment audio storage (current design stores embeddings only — sufficient for "user setting" semantics via `UserVoiceProfile`).
- Playground audio-store ↔ UserPreferences write-back loop (separate UX ticket — current UI is dev-only).
- Other VAD / NoiseFilter / STT bugs from the exploration (HIGH-3 blob leak, MED-1 sample-rate validation, MED-4 worklet startup silence, etc.).

---

## 3. Implementation Plan

### Layer Order

```
Backend DTOs            ─► Backend Service          ─► Backend Tests
                                                                 │
SDK Types               ─► SDK Tests                             │
                                                                 ▼
@arcaai/vad fix         ─► @arcaai/vad tests                Merge to fix/2605-review
@arcaai/noise-filter fix─► @arcaai/noise-filter tests
@arcaai/stt fix         ─► @arcaai/stt tests
```

### Verification Criteria

| Layer | Build | Tests |
| --- | --- | --- |
| `@arcaai/applications` | `pnpm build --filter @arcaai/applications` | `pnpm test:unit --filter @arcaai/applications` |
| `@arcaai/vox` (SDK) | `pnpm build --filter @arcaai/vox` | `pnpm test --filter @arcaai/vox` |
| `@arcaai/vad` | `pnpm build --filter @arcaai/vad` | `pnpm test --filter @arcaai/vad` |
| `@arcaai/noise-filter` | `pnpm build --filter @arcaai/noise-filter` | `pnpm test --filter @arcaai/noise-filter` |
| `@arcaai/stt` | `pnpm build --filter @arcaai/stt` | `pnpm test --filter @arcaai/stt` |

---

## 4. Implementation Summary

### Files Created

| File | Purpose |
| --- | --- |
| `docs/implementation/TASK-304-Local-STT-Workflow-Refactor/README.md` | This ticket document. |
| `packages/stt/src/__tests__/STTProcessor.setLanguage.test.ts` | New test suite for the local-provider re-init behaviour. |

### Files Modified

| File | Change |
| --- | --- |
| `packages/applications/src/services/user/userPreferences/dto/update-user-preferences.request.ts` | Added `VoiceProfileConfigDto` and wired it into `LocalWorkflowConfigDto`. |
| `packages/applications/src/services/user/userPreferences/dto/user-preferences.response.ts` | Added `voiceProfile` sub-config and a top-level `ActiveVoiceProfileDto` for the resolved active profile. |
| `packages/applications/src/services/user/userPreferences/userPreferences.service.ts` | Optional injection of `UserVoiceProfileRepository`; new `resolveActiveVoiceProfile` resolver hooked into `getPreferences()`. |
| `packages/applications/src/services/user/userPreferences/__tests__/userPreferences.service.test.ts` | 9 new tests for `activeVoiceProfile` resolution and `voiceProfile` persistence/merge. |
| `packages/agentic-sdk-v2/src/types/config.ts` | Added SDK-side `VoiceProfileLocalConfig`, `ActiveVoiceProfileSummary`; extended `LocalWorkflowConfig`, `UserPreferences`, and `DEFAULT_LOCAL_CONFIG`. |
| `packages/vad/src/processors/VADProcessor.ts` | `postSpeechPadMs` now actually pads the buffer; `updateThresholds` validates `[0,1]` + `positive >= negative`. |
| `packages/vad/src/__tests__/VADProcessor.test.ts` | 11 new tests (7 threshold-validation, 3 post-pad, 1 frozen-defaults). |
| `packages/noise-filter/src/types/index.ts` | `DEFAULT_NOISE_FILTER_OPTIONS` is now `Object.freeze()`'d (MED-9). |
| `packages/noise-filter/src/processors/NoiseFilterProcessor.ts` | `startStatsEmission` clears any pre-existing timer before starting a new one (MED-10). |
| `packages/noise-filter/src/__tests__/types.test.ts` | 2 new tests for frozen defaults. |
| `packages/noise-filter/src/__tests__/NoiseFilterProcessor.test.ts` | 2 new tests for the setInterval-leak fix. |
| `packages/stt/src/core/STTProcessor.ts` | `setLanguage()` now reinitializes the local provider with the new locale (was: silent warn-only). |

### Design Decisions Worth Noting

- **No duplication of `isActive` for voice profiles.** The canonical source remains `UserVoiceProfile.isActive` (one row per user with `isActive=true`). `UserPreferences.activeVoiceProfile` is purely a *resolved view*, computed on every `getPreferences()` call — same pattern already used for `remoteConfig`. That keeps the SDK's IndexedDB cache fresh on every preference fetch without introducing a new sync code path.
- **`voiceProfile` sub-config holds preferences, not data.** `autoActivateLatest`, `similarityThreshold`, and `useBackendAnchor` are user-tunable knobs that influence how the local diarizer behaves — they are stored in the same `localConfig` JSON blob as the other workflow stages and benefit from the existing deep-merge logic in `UserPreferencesService.updatePreferences`.
- **Optional repository injection (`@Optional() UserVoiceProfileRepository`).** Production wiring resolves it via `CoreDatabaseModule`; the existing test suite (which constructs the service manually) doesn't break because the resolver guards on its presence. A new test case covers both wired and unwired construction paths.
- **`postSpeechPadMs` semantics fixed pragmatically.** The underlying `@ricky0123/vad-web` library does not expose a post-speech pad option (only `preSpeechPadMs` and `redemptionMs`). Rather than removing the published option or silently dropping it, we now append `padMs * sampleRate` zero-valued samples to the speech buffer in `handleSpeechEnd`. This matches the documented behaviour with zero risk to existing consumers.

### API/Endpoint Changes

- `GET /api/v1/user/me/preferences` response now includes an `activeVoiceProfile` field when the user has an active voice profile.
- `localConfig` accepts a new optional `voiceProfile` object (deep-merged with existing config).

### Migrations

None. The change is additive — no Prisma schema changes, no migrations. Voice samples (raw audio) remain ephemeral; only their derived embeddings live in `UserVoiceProfile` (unchanged from TASK-296).

### Verification Evidence

Run from `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-local-stt-refactor`.

```
@arcaai/applications  →  72 / 72 tests passing (user preferences targeted)
@arcaai/vad           →  204 / 204 tests passing (full suite)
@arcaai/noise-filter  →  170 / 170 tests passing (full suite)
@arcaai/stt           →  361 / 361 tests passing (full suite)
@arcaai/vox           →  2884 / 2884 tests passing (full suite)

Builds:
@arcaai/applications  →  rimraf dist tsconfig.tsbuildinfo && tsc  →  PASS
@arcaai/vad           →  ESM 33.36 KB · DTS                       →  PASS
@arcaai/noise-filter  →  ESM/CJS · DTS 21.96 KB                   →  PASS
@arcaai/stt           →  ESM/CJS 67.42 KB + worker 1.69 MB         →  PASS
@arcaai/vox           →  ESM/CJS 4.29/4.30 MB + plugins 3.92 MB    →  PASS
```

Pre-existing test failures unrelated to this ticket (verified by stashing changes + re-running):

- `packages/applications/src/services/tenant/__tests__/tenant.service.audit-scrub-encrypted.test.ts` (2 tests) — `Cannot read properties of undefined (reading '$transaction')` in `TenantService.updateTenantConfigs`. Out of scope.

### Status

`Completed` — ready to merge to `fix/2605-review`.

---

## 5. Change History

_(to be added if subsequent fixes are needed)_
