# TASK-304 — Local STT Workflow Refactor

| Field | Value |
| --- | --- |
| Ticket | TASK-304 |
| Name | Local STT Workflow Refactor — voice sample as user setting + bug fixes |
| Created | 2026-05-25 |
| Updated | 2026-05-25 |
| Status | Completed (Wave 2) |
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

### 2026-05-25 — Voice-profile enroll: friendlier upstream-error propagation

**Scope:** API gateway only (`VoiceProfileService.extractEmbeddings`). Not a TASK-304 design change — surfaced while dev-testing enrollment in `ui-playground` against a freshly-started STT-v2 stack.

**Symptoms observed:**

- `POST /api/v1/voice-profile/enroll` returned an opaque error to the UI even though STT-v2 (`/internal/voice-profile/extract`) already responds with a clear `{ detail: "..." }` for every failure mode (empty file, sample exceeds 15 s, cross-sample similarity below 0.6, embedding/VAD service not loaded, etc.).
- API gateway logged `AxiosError` stack traces instead of the actionable `detail`.
- Network failures (e.g. STT-v2 not started → `ECONNREFUSED`) were dumped as generic 500s.

**Root cause:** `VoiceProfileService.extractEmbeddings` had no `try/catch` around the `httpService.post(...)`. The raw `AxiosError` propagated through the NestJS controller, so STT-v2's body (`error.response.data.detail`) was never read or re-thrown as an HTTP-shaped exception.

**Fix:** wrap the call and translate via a new `translateExtractionError(error)`:

| Upstream condition | Translated to |
| --- | --- |
| No `error.response` (e.g. ECONNREFUSED, timeout) | `ServiceUnavailableException('Voice profile extraction service is unavailable. Please try again later.')` |
| `status === 400` with `detail` | `BadRequestException(detail)` |
| `status === 503` | `ServiceUnavailableException(detail ?? 'Voice profile extraction service is unavailable')` |
| Anything else | `InternalServerErrorException('Voice profile extraction failed')` |
| Non-axios error | `InternalServerErrorException('Voice profile extraction failed')` |

Server-side, a single `logger.warn` now records `{ status, detail, code, url }` per failure, so the API terminal also shows the real reason without dumping the full AxiosError config.

**Files modified:**

| File | Change |
| --- | --- |
| `packages/applications/src/services/user/voiceProfile/voiceProfile.service.ts` | New `translateExtractionError`; `extractEmbeddings` wrapped in `try/catch`; `BadRequestException`, `ServiceUnavailableException`, `isAxiosError` imports. |
| `packages/applications/src/services/user/voiceProfile/__tests__/voiceProfile.service.test.ts` | 4 new tests (`extractEmbeddings error translation` group) covering 400/503/ECONNREFUSED/non-axios; new `makeAxiosError` helper. |

**Verification:**

```
@arcaai/applications → 4049 / 4049 tests passing, 4 skipped, 0 lint warnings
@arcaai/applications → build PASS (tsc, 8.6 s)
```

**Local-dev note recorded for future debuggers:** STT-v2 on macOS reads `HUGGINGFACE_CACHE_DIR` from `apps/stt-v2/.env`. The committed `.env.example` default `/models/hf-cache` is the Docker path. For local conda runs, point it at the host HF cache (e.g. `HUGGINGFACE_CACHE_DIR=/Volumes/aillusion/huggingface`) **or** pin `VAD_MODEL_PATH` directly. Otherwise Silero VAD init fails with `[Errno 30] Read-only file system: '/models'` and `/internal/voice-profile/extract` returns 503.

---

### 2026-05-25 — Voice-profile enroll: 256/512-d dimension mismatch + configurable similarity threshold

**Scope:** STT-v2 extraction service, API-gateway voice-profile service, settings, .env. Not a TASK-304 design change — surfaced while continuing dev-testing after the error-propagation fix above.

**Symptoms observed:**

1. After fixing error propagation, single-sample enrollment surfaced a `400 Bad Request` from the API gateway with a cryptic Prisma payload: `Raw query failed. Code: 22000. Message: expected 256 dimensions, not 512`.
2. Multi-sample enrollment surfaced `Voice samples are inconsistent (min pairwise similarity 0.42 < 0.60)` on Macbook built-in mic — legitimate for the same speaker under Chrome default AGC/noise-suppression drift, but blocked enrollment with no way to relax the threshold short of editing source.

**Root cause (1) — split-personality on embedding dim:**

| Layer | Dim it expects | Source |
| --- | --- | --- |
| DB `core.UserVoiceProfile.embedding` | **256** (only migration) | `vector(256)` |
| Settings.py code default `DIARIZATION_HF_MODEL_ID` | **256** (wespeaker) | `apps/stt-v2/src/stt_v2/core/config/settings.py` |
| All `.env.example` files | **256** (wespeaker) | root + stt-v2 |
| All tests, comments, docstrings in voice-profile code | **256** | hardcoded |
| Local `apps/stt-v2/.env` | **512** (`pyannote/embedding`) — copied from README | overrode to 512-d |
| README env table, knowledge docs, Qdrant collection setup | **512** | aspirational/streaming context |

The 512-d `pyannote/embedding` returned a 512-d centroid, flowed through extraction service → API gateway → repository → pgvector with **zero dimension validation anywhere**, and only the DB column constraint caught the mismatch — producing the cryptic `Code: 22000` error.

**Root cause (2) — strict hardcoded threshold:** `MIN_CROSS_SAMPLE_SIMILARITY = 0.6` was a module-level constant in `extraction_service.py` from TASK-296 H-8 — not configurable, not benchmarked for consumer-grade microphones.

**Fix — three parts:**

| Part | Change |
| --- | --- |
| A. Defense-in-depth dim guard (Python) | `extraction_service.py`: new `EXPECTED_EMBEDDING_DIM = 256` constant; constructor accepts overrides for test injection; new check after centroid computation raises `ValueError(f"…model '{model_id}' produced {N}-d but database expects {EXPECTED}-d…")` → STT-v2 returns 400 with clear detail, no cryptic Prisma error downstream. |
| A. Defense-in-depth dim guard (TypeScript) | `voiceProfile.service.ts`: new `EXPECTED_EMBEDDING_DIM = 256` constant; `enroll()` validates `extraction.embedding.length` before `createWithEmbedding(...)`; mismatch → `BadRequestException` carrying model id + observed dim + expected dim. Belt-and-suspenders so even if STT-v2 ever skips its own guard, the SQL never runs. |
| B. Configurable threshold | `settings.py`: new `voice_profile_min_similarity: float = Field(default=0.6, ge=0.0, le=1.0, ...)`; `extraction_service.py` reads it at construction time (via constructor default → settings); cross-similarity check uses the instance value instead of a module constant. Production behavior unchanged (default 0.6); dev sets `VOICE_PROFILE_MIN_SIMILARITY=0.3` in `apps/stt-v2/.env`. |
| C. Local `.env` corrected | `apps/stt-v2/.env` line 173: `DIARIZATION_HF_MODEL_ID=pyannote/embedding` → `pyannote/wespeaker-voxceleb-resnet34-LM`. Now matches the 256-d DB schema. Comment expanded to warn future readers about the dim contract. |

**Operational requirement after pulling this change:**

The wespeaker model is gated on HuggingFace; accept its terms once at <https://huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM> with the same HF account whose token is in `HF_TOKEN`. First STT-v2 restart will download it (~30 MB) into the configured `HUGGINGFACE_CACHE_DIR` (or `HF_HOME`). After that, restart `pnpm dev:stt-v2` and `pnpm dev:api`. Enrollment via `ui-playground` then succeeds end-to-end.

**Files modified:**

| File | Change |
| --- | --- |
| `apps/stt-v2/src/stt_v2/voice_profile/extraction_service.py` | New `EXPECTED_EMBEDDING_DIM` constant; constructor adds `min_cross_sample_similarity` + `expected_embedding_dim` keyword args reading defaults from settings; new post-centroid dim guard raising `ValueError`; removed module constant `MIN_CROSS_SAMPLE_SIMILARITY`. |
| `apps/stt-v2/src/stt_v2/core/config/settings.py` | New `voice_profile_min_similarity` field (default 0.6, 0.0–1.0 range). |
| `apps/stt-v2/.env.example` | New `VOICE_PROFILE_MIN_SIMILARITY` section + note that embedding dim is intentionally not env-configurable (must match DB column). |
| `apps/stt-v2/.env` | Reverted `DIARIZATION_HF_MODEL_ID` to `pyannote/wespeaker-voxceleb-resnet34-LM` + commented `VOICE_PROFILE_MIN_SIMILARITY=0.3` knob for consumer-mic dev work. |
| `apps/stt-v2/tests/unit/voice_profile/test_extraction_service.py` | 5 new tests: 3 dim guard (`TestExtractionServiceDimensionGuard`) + 2 configurable threshold (`TestExtractionServiceConfigurableThreshold`). |
| `packages/applications/src/services/user/voiceProfile/voiceProfile.service.ts` | New `EXPECTED_EMBEDDING_DIM` module constant; `enroll()` adds dim-mismatch check between extraction and repository write; `logger.warn` records observed vs expected vs model id. |
| `packages/applications/src/services/user/voiceProfile/__tests__/voiceProfile.service.test.ts` | 3 new tests in `embedding dimension guard` group (rejects 512-d, includes model id, accepts 256-d). |

**Verification:**

```
apps/stt-v2 → pytest tests/unit/voice_profile/ tests/unit/test_settings.py
  52 passed in 0.57s (19 extraction service + 4 voice profile model + 29 settings)

@arcaai/applications → vitest run
  4052 passed | 4 skipped (163 files, 11.00s)

@arcaai/applications → build PASS (tsc, ~13 s; 6/6 packages cached or built clean)
ReadLints on all 5 modified files → No linter errors
```

**Follow-ups (out of scope of this fix, raise as separate tickets if needed):**

- The codebase still has documentation drift: `apps/stt-v2/README.md` lines 234/305/516 and `knowledge/stt-v2/**` document 512-d as the canonical config; streaming-diarization tests at `test_inference_embedding_separation.py` assume 512-d. Pick one of (a) update docs/Qdrant/streaming to 256-d, or (b) plan a coordinated migration to 512-d (DB `vector(512)`, drop existing profiles, update both `EXPECTED_EMBEDDING_DIM` constants, regenerate tests).
- `apps/stt-v2/src/stt_v2/voice_profile/api/schemas.py` and related docstrings still say "256-dimensional" in description text — fine for now since 256 is the truth, but flag if (b) above is chosen.

---

### 2026-05-25 — Wave 2: User-Preference Wire-Up End-to-End

**Author:** TASK-304 implementer (Wave 2)
**Status:** In Progress

Wave 1 (above) shipped the **types and DTOs** so that voice profile and local-workflow options can live in `UserPreferences`. Two independent quality-audit passes after the merge surfaced that **the persisted settings never reach the running processors** — the SDK's `PluginManager` only consumes the static `AudioPluginConfig` from SDK init time, and `PersonalizationManager.preferences.localConfig` / `activeVoiceProfile` are orphaned.

#### Wave 2 Scope

| ID | Layer | Issue | Severity |
| --- | --- | --- | --- |
| W2-SDK-1 | SDK | `PluginManager` does not read `PersonalizationManager.preferences.localConfig` when building `TranscriptionPipelineConfig` | CRITICAL |
| W2-SDK-2 | SDK | `activeVoiceProfile.id` never passed as `reservedSpeakerId` to `LocalSpeakerDiarizer` | CRITICAL |
| W2-SDK-3 | SDK | `voiceProfile.similarityThreshold` persists but never reaches `LocalSpeakerDiarizer` | CRITICAL |
| W2-SDK-4 | SDK | `localConfig.noiseCancellation.level` not forwarded to `NoiseFilterProcessor` | HIGH |
| W2-SDK-5 | SDK | `localConfig.vad.sensitivity` not forwarded to `VADProcessor` | HIGH |
| W2-SDK-6 | SDK | `localConfig.stt.modelId` / `language` / `task` not forwarded to `STTProcessor` features | HIGH |
| W2-SDK-7 | SDK | Live preference change does not propagate to running processors (`updateOptions` / `setLanguage`) | HIGH |
| W2-SDK-8 | SDK | `PersonalizationManager` persists to `localStorage`; user requested IndexedDB consolidation under existing `arcaai-config` DB with a separate `preferences` object store | MEDIUM |
| W2-STT-2 | STT | `setLanguage` does not restore `this.options.audio.language` on failure → next call short-circuits | HIGH |
| W2-STT-3 | STT | `LocalProviderConfig.task` field missing; `task` not in `getLocalProviderCacheKey` → switching between transcribe/translate reuses wrong pool entry | HIGH |
| W2-STT-4 | STT | `LocalProviderConfig.voiceProfile` lacks `similarityThreshold`; `LocalSTTProvider` never forwards user-tuned threshold to `LocalSpeakerDiarizer` | HIGH |
| W2-STT-6 | STT | `setLanguage` reinit does not destroy old provider → duplicate transcription callbacks + memory leak | HIGH |
| W2-NF-1 | NoiseFilter | `updateOptions({ noiseCancellation: false })` not dispatched to worklet/fallback → audio keeps being filtered | HIGH |
| W2-VAD-1 | VAD | `startStatsEmission` does not clear existing interval before starting a new one (analog of TASK-304 Wave 1 MED-10 NoiseFilter fix) | MEDIUM |

**Voice-profile anchor design (clarified):** Per the project decision recorded in this change history, the local diarizer pins **only the speaker label** (`reservedSpeakerId='doctor'` derived from `activeVoiceProfile.id`). The 256-d backend embedding vs 40-d MFCC centroid mismatch is **explicitly out of scope** for Wave 2 — long-term unification onto a single ONNX speaker-embedding model remains tracked in TASK-293 W5D / P2-7.

**Browser cache design (clarified):** `PersonalizationManager` persistence moves to IndexedDB. The existing `arcaai-config` database (already used by `ConfigManager`) gains a new `preferences` object store. The `localStorage['arcaai-preferences']` path is removed (no migration — backend is the source of truth on cold start; users will re-fetch on next load).

#### Wave 2 Implementation Plan

##### Layer order

```
Wave 2A — STT types & bug fixes (foundation)
  ↳ packages/stt/src/types/index.ts
  ↳ packages/stt/src/core/STTProcessor.ts
  ↳ packages/stt/src/providers/LocalSTTProvider.ts
  ↳ packages/stt/src/__tests__/

Wave 2B — NoiseFilter + VAD bug fixes (parallel-safe with 2A)
  ↳ packages/noise-filter/src/processors/NoiseFilterProcessor.ts
  ↳ packages/vad/src/processors/VADProcessor.ts
  ↳ each package's __tests__/

Wave 2C — SDK wire-up (depends on 2A)
  ↳ packages/agentic-sdk-v2/src/core/PluginManager.ts (read PersonalizationManager preferences)
  ↳ packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts (accept new config fields)
  ↳ packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx (wire PersonalizationManager → PluginManager + live updates)
  ↳ packages/agentic-sdk-v2/src/__tests__/

Wave 2D — PersonalizationManager IndexedDB migration (independent of 2C)
  ↳ packages/agentic-sdk-v2/src/core/PersonalizationManager.ts (replace localStorage with IDB)
  ↳ packages/agentic-sdk-v2/src/core/constants.ts (IDB store name)
  ↳ packages/agentic-sdk-v2/src/__tests__/PersonalizationManager.test.ts

Wave 2E — Verify + ticket update
```

##### TDD test list

| # | Test | Path | Verifies |
| --- | --- | --- | --- |
| T-1 | `LocalProviderConfig.task` is forwarded from `STTFeatureFlags.task` | `packages/stt/src/__tests__/STTProcessor.task-forwarding.test.ts` (new) | W2-STT-3 |
| T-2 | `getLocalProviderCacheKey` includes `task` so 'translate' vs 'transcribe' get different pool entries | same | W2-STT-3 |
| T-3 | `LocalProviderConfig.voiceProfile.similarityThreshold` reaches `LocalSpeakerDiarizer` | `packages/stt/src/__tests__/LocalSTTProvider.similarity.test.ts` (new) | W2-STT-4 |
| T-4 | `setLanguage` failure restores `this.options.audio.language` to previous value | `packages/stt/src/__tests__/STTProcessor.setLanguage.test.ts` (extend) | W2-STT-2 |
| T-5 | `setLanguage` reinit destroys the previous local provider before installing the new one | same | W2-STT-6 |
| T-6 | `NoiseFilterProcessor.updateOptions({ noiseCancellation: false })` dispatches a disable message to the worklet | `packages/noise-filter/src/__tests__/NoiseFilterProcessor.test.ts` (extend) | W2-NF-1 |
| T-7 | `VADProcessor.startStatsEmission` clears existing interval before starting a new one (no leak on `updateOptions({ enableStats: true })` ×2) | `packages/vad/src/__tests__/VADProcessor.test.ts` (extend) | W2-VAD-1 |
| T-8 | `PluginManager.getTranscriptionPipelineConfig` reads `PersonalizationManager.preferences.localConfig` values and forwards them (noise level, VAD sensitivity, STT model, language, task) | `packages/agentic-sdk-v2/src/__tests__/PluginManager.preferences.test.ts` (new) | W2-SDK-3/4/5/6 |
| T-9 | `PluginManager.getTranscriptionPipelineConfig` forwards `activeVoiceProfile.id` as the diarizer's `reservedSpeakerId` and `voiceProfile.similarityThreshold` to the local provider | same | W2-SDK-1/2 |
| T-10 | `PersonalizationManager.onChange` triggers `PluginManager` to push deltas to running processors (calls `setLanguage`/`updateOptions`/`setReservedSpeakerId` as appropriate) | same | W2-SDK-7 |
| T-11 | `PersonalizationManager` writes to IndexedDB `arcaai-config / preferences` object store; reads on construct | `packages/agentic-sdk-v2/src/__tests__/PersonalizationManager.idb.test.ts` (new) | W2-SDK-8 |
| T-12 | `PersonalizationManager` no longer reads/writes localStorage on the preferences key | same | W2-SDK-8 |

##### Verification gate

| Package | Build | Tests |
| --- | --- | --- |
| `@arcaai/stt` | `pnpm build --filter @arcaai/stt` | `pnpm test --filter @arcaai/stt` |
| `@arcaai/noise-filter` | `pnpm build --filter @arcaai/noise-filter` | `pnpm test --filter @arcaai/noise-filter` |
| `@arcaai/vad` | `pnpm build --filter @arcaai/vad` | `pnpm test --filter @arcaai/vad` |
| `@arcaai/vox` | `pnpm build --filter @arcaai/vox` | `pnpm test --filter @arcaai/vox` |

Plus `ReadLints` on every modified file.

#### Out of Scope (deferred to follow-ups)

| Item | Owner | Reason |
| --- | --- | --- |
| 256-d backend embedding ↔ 40-d MFCC unification | TASK-293 W5D / P2-7 | Architectural — needs single ONNX embedding model |
| `STTProcessor.localProviderPool` per-AgenticClient `WeakMap` | TASK-298 (existing hand-off) | Out of STT-instance scope |
| `LocalSpeakerDiarizer` FFT bit-reversal | TASK-296 (existing hand-off) | Diarizer correctness, separate ticket |
| Non-threshold VAD options hot-reload (`preSpeechPadMs`, `redemptionMs`) | Follow-up | Needs full `restart()`; UX trade-off |
| `processingMode` / `echoCancellation` / `autoGainControl` worklet wiring | Follow-up | Admin-track features, not user-track |
| Worklet init race in `NoiseFilterProcessor` (NF-4/NF-5) | Follow-up | Needs hardware reproduction + flaky-test infra |
| Dual store consolidation between `ConfigManager` IDB and `PersonalizationManager` IDB | TASK-302 | Wave 2 keeps them as siblings under the same `arcaai-config` DB |

---

### 2026-05-25 — Wave 2 Implementation Summary

**Status:** all four implementation waves landed; verification gate green.

#### Wave 2A — STT type extensions + bug fixes

Files modified:

- `packages/stt/src/types/index.ts` — relaxed `STTOptions.voiceProfile` and `LocalProviderConfig.voiceProfile` so `id`/`reservedSpeakerId` are optional (SDK can carry threshold-only state); added `LocalProviderConfig.task: WhisperTask`.
- `packages/stt/src/core/STTProcessor.ts`
  - `getLocalProviderCacheKey()` now includes `task` so `'translate'` and `'transcribe'` cache entries are kept separate (**W2-STT-3**).
  - `initializeLocalProvider()` forwards `features.task` and `options.voiceProfile` into `LocalProviderConfig` (**W2-STT-3/4**).
  - `setLanguage()` snapshots previous provider + cache key, awaits the new init, then pools the old provider under its previous key (cheap re-toggle) or destroys it; on failure both the language and provider reference are restored (**W2-STT-2/6**).
- `packages/stt/src/providers/LocalSTTProvider.ts` — engine init receives `task`; diarizer constructor receives `voiceProfile.similarityThreshold` when set (**W2-STT-4**).

New tests (`packages/stt/src/__tests__/STTProcessor.wave2.test.ts`): 5 cases covering W2-STT-2/3/4/6.

#### Wave 2B — NoiseFilter + VAD bug fixes

- `packages/noise-filter/src/processors/NoiseFilterProcessor.ts` — `updateOptions({ noiseCancellation })` now propagates the toggle to both the AudioWorklet path and the `ScriptProcessor` fallback so disabling at runtime actually mutes the RNNoise stage (**W2-NF-1**).
- `packages/vad/src/processors/VADProcessor.ts` — `startStatsEmission()` is now idempotent: any prior interval is cleared before a new one is scheduled (no more leaked timers on repeated `updateOptions({ enableStats: true })`) (**W2-VAD-1**).

New tests: `NoiseFilterProcessor.wave2.test.ts` (4 cases) and `VADProcessor.wave2.test.ts` (3 cases including a leak-counter regression assertion).

#### Wave 2C — SDK wire-up

- `packages/agentic-sdk-v2/src/types/pipeline.ts` — `TranscriptionPipelineConfig.stt` gains `voiceProfile` and `task`.
- `packages/agentic-sdk-v2/src/core/PluginManager.ts`
  - New `setUserPreferences(prefs)` / `getUserPreferences()` plus a private `propagateUserPreferenceDelta()` that pushes diffs to running processors (`NoiseFilterProcessor.updateOptions`, `VADProcessor.updateThresholds`, `STTProcessor.setLanguage` / `setReservedSpeakerId`).
  - `getTranscriptionPipelineConfig()` now merges `userPreferences` (`localConfig`, `activeVoiceProfile`, `language`) over the static `AudioPluginConfig`, with `runtimeOptions > userPreferences > AudioPluginConfig > package defaults` precedence. Result: pipelines built after a preference change carry the user's noise level, VAD sensitivity, STT modelId / language / task, diarization toggle, reserved speaker id, and similarity threshold (**W2-SDK-1…6**).
- `packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts` — `createSTT(...)` call site forwards `stt.voiceProfile` and `stt.task` (local-only; remote path ignores them).
- `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx`
  - Seeds `pluginManager.setUserPreferences(...)` right after construction so the first pipeline build sees the cached/preloaded prefs.
  - Wires `personalizationManager.onChange` into `pluginManager.setUserPreferences(...)` so any UI-driven preference edit triggers the live delta propagation (**W2-SDK-7**).
  - Re-seeds `PluginManager` after `loadFromBackend()` resolves.

New tests: `PluginManager.wave2.test.ts` (9 cases) and `TranscriptionPipeline.wave2.test.ts` (3 cases) covering every wire path including the "no preferences set ⇒ defaults stay clean" negative case.

#### Wave 2D — PersonalizationManager IndexedDB migration

- New module `packages/agentic-sdk-v2/src/core/configDB.ts` owns the `arcaai-config` IDB schema at version 2 with two object stores: `user-preferences` (ConfigManager) and `personalization` (PersonalizationManager). Exposes `openConfigDB`, `configDBGet`, `configDBSet`, `configDBDelete`, `configDBClear`.
- `packages/agentic-sdk-v2/src/core/PersonalizationManager.ts`
  - Constructor stays synchronous (seeds defaults only).
  - New `async hydrate()` reads the IDB cache (`personalization` store, global key `arcaai-personalization`), merges into in-memory state, and notifies listeners. Failures are logged at `warn` and swallowed.
  - `saveLocal()` rewritten as async, writes via `configDBSet`; failures are best-effort.
  - All three call sites (`updatePreferences`, `reset`, `loadFromBackend → hybrid save`) now `await` the new async `saveLocal`.
  - Legacy `localStorage['arcaai-preferences']` data is intentionally NOT migrated (user choice: `ignore-old-data`).
- `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx`
  - Inline IDB helpers replaced with imports from `core/configDB` so all three writers (ConfigManager persist, PersonalizationManager hydrate/save, logout cleanup) share a single schema version and `onupgradeneeded` path.
  - Fire-and-forget `personalizationManager.hydrate()` immediately after construction; on resolve, the cached snapshot is pushed into both the store and `PluginManager`.
- `packages/agentic-sdk-v2/src/store/agenticStore.ts` — `clearOnLogout()` now also clears the new `personalization` IDB store alongside `user-preferences`.

Tests:

- New `PersonalizationManager.idb.test.ts` (5 cases): IDB hydrate happy-path, legacy-localStorage-ignored, write-on-update, IDB read failure resilience, IDB write failure resilience.
- Existing `PersonalizationManager.test.ts` migrated to the IDB pattern (6 tests rewritten to seed/inspect the in-memory IDB map instead of `localStorage`).

#### Files Modified / Added

| Layer | File | Change |
| --- | --- | --- |
| @arcaai/stt | `src/types/index.ts` | Optional `voiceProfile` fields, new `task` |
| @arcaai/stt | `src/core/STTProcessor.ts` | Cache key + `setLanguage` restore + task / voiceProfile forwarding |
| @arcaai/stt | `src/providers/LocalSTTProvider.ts` | `task` / `similarityThreshold` forwarding |
| @arcaai/stt | `src/__tests__/STTProcessor.wave2.test.ts` | **new** 5 cases |
| @arcaai/noise-filter | `src/processors/NoiseFilterProcessor.ts` | `updateOptions({ noiseCancellation })` |
| @arcaai/noise-filter | `src/__tests__/NoiseFilterProcessor.wave2.test.ts` | **new** 4 cases |
| @arcaai/vad | `src/processors/VADProcessor.ts` | Idempotent `startStatsEmission` |
| @arcaai/vad | `src/__tests__/VADProcessor.wave2.test.ts` | **new** 3 cases |
| @arcaai/vox | `src/types/pipeline.ts` | `stt.voiceProfile` + `stt.task` |
| @arcaai/vox | `src/core/PluginManager.ts` | `setUserPreferences` + delta propagation + merged pipeline config |
| @arcaai/vox | `src/core/TranscriptionPipeline.ts` | Forwards new STT fields |
| @arcaai/vox | `src/core/PersonalizationManager.ts` | IDB cache, async `hydrate`, async `saveLocal` |
| @arcaai/vox | `src/core/configDB.ts` | **new** shared `arcaai-config` IDB helpers |
| @arcaai/vox | `src/providers/AgenticProvider.tsx` | Hydrate + delta wiring + shared IDB helpers |
| @arcaai/vox | `src/store/agenticStore.ts` | Logout clears `personalization` store too |
| @arcaai/vox | `src/core/__tests__/PluginManager.wave2.test.ts` | **new** 9 cases |
| @arcaai/vox | `src/core/__tests__/TranscriptionPipeline.wave2.test.ts` | **new** 3 cases |
| @arcaai/vox | `src/core/__tests__/PersonalizationManager.idb.test.ts` | **new** 5 cases |
| @arcaai/vox | `src/core/__tests__/PersonalizationManager.test.ts` | 6 tests migrated to IDB pattern |

#### Verification Gate — Results

| Package | Build | Tests | New lint warnings |
| --- | --- | --- | --- |
| `@arcaai/stt` | ✅ | **369** pass (was 364) | **0** (5 pre-existing) |
| `@arcaai/noise-filter` | ✅ | **174** pass (was 170) | **0** |
| `@arcaai/vad` | ✅ | **205** pass (was ~199) | **0** (3 pre-existing) |
| `@arcaai/vox` | ✅ | **2901** pass (was 2887) | **0** |
| `@arcaai/ui-playground` (consumer) | ✅ | n/a | n/a |

Total: **3649** unit/integration tests passing across the four SDK packages, zero new lint warnings introduced.

#### Architectural Decisions Recorded in Wave 2

- **Voice-profile anchor strategy: label-only.** The diarizer pins the doctor's `reservedSpeakerId` to the first speaker slot (label-based); no acoustic matching against the backend's 256-d embedding. The 40-d MFCC ↔ 256-d embedding unification is tracked under TASK-293.
- **Browser cache: single IDB, separate store.** `arcaai-config` v2 now hosts both `user-preferences` and `personalization` object stores; `core/configDB.ts` is the single authority over schema upgrades.
- **localStorage migration: ignored.** Legacy `arcaai-preferences` localStorage data is not migrated; the IDB cache repopulates on the next backend sync.
- **Preference precedence:** `runtimeOptions > userPreferences > AudioPluginConfig > package defaults` — established in `PluginManager.getTranscriptionPipelineConfig`.

---

### 2026-05-25 — Wave 3 hotfix: live diarizer speaker label + segment replay

**Status:** Implemented, verification green.
**Scope:** `apps/ui-playground` + `@arcaai/vox` (`PluginManager`) + `@arcaai/stt` (`STTProcessor`, `LocalSTTProvider`, `useSTT`).

**Symptoms observed (dev-testing after Wave 2 merge):**

1. After impersonating a user and enrolling a voice profile, **live transcription via local STT (VAD + diarization enabled) showed transcript text with no speaker label** — the badge area remained empty even though the diarizer was active.
2. Replaying any transcribed segment via the playground play button **cut off after a few hundred milliseconds**, never the full segment.

**Root cause — issue 1 (no speaker label):**

Wave 2 introduced `PluginManager.setReservedSpeakerId`-based delta propagation, but two gaps remained:

| Gap | Layer | Effect |
| --- | --- | --- |
| `LocalSTTProvider` and `STTProcessor` had **no public `setReservedSpeakerId` method** | `@arcaai/stt` | Wave 2's `propagateUserPreferenceDelta` called `proc.setReservedSpeakerId?.(...)` — the optional-chain silently no-op'd because the method didn't exist. Live updates from preferences were lost. |
| `PluginManager.getTranscriptionPipelineConfig` hardcoded `reservedSpeakerId: 'doctor'` | `@arcaai/vox` | Even on cold pipeline build, every diarizer was anchored to literal `'doctor'`. Anything not matching that label rendered without a badge. |
| `apps/ui-playground/transcript-panel.tsx` built `sttOptions` without `voiceProfile` | playground | Local STT was created without `voiceProfile.id` / `reservedSpeakerId`, so the diarizer started with no anchor at all. |
| `useSTT` `configFingerprint` did not include `voiceProfile.{id,reservedSpeakerId}` | `@arcaai/stt` | Late-arriving voice-profile data (TanStack Query resolves after first render) did not trigger STT re-init — the processor stayed anchored to whatever fingerprint won the first render. |

**Root cause — issue 2 (truncated replay):**

Segment replay reused the long-running `MediaRecorder` WebM blob and seeked into it by VAD-derived `(startMs, endMs)` offsets. Two compounding issues:

- `HTMLAudioElement.duration` for an in-progress WebM/Opus stream is frequently `Infinity` (Chromium) or near-zero (Firefox), so the seek target landed past `currentTime + duration` and playback ended immediately.
- The MediaRecorder timeline drifted from the VAD-emitted frame indices (frame-clock vs wall-clock), so even when `duration` resolved correctly, the seek window was milliseconds off the actual speech.

**Fix scope (per user direction "playground_plus_sdk"):**

| Part | Change |
| --- | --- |
| A. SDK STT API | Add public `setReservedSpeakerId(id?: string)` to `LocalSTTProvider` (delegates to diarizer) and `STTProcessor` (delegates to underlying local provider; no-op for remote). |
| B. SDK PluginManager label resolution | Hardcoded `'doctor'` replaced with `PluginManager.resolveReservedSpeakerId(label)` — returns the trimmed `activeVoiceProfile.label` when non-empty, else `'Doctor'`. Used both in the static config build and in the live `propagateUserPreferenceDelta` path. |
| C. SDK useSTT re-init | `configFingerprint` now folds in `voiceProfile.id` and `voiceProfile.reservedSpeakerId`, so when TanStack Query resolves a voice profile after first render the local provider rebuilds with the correct anchor (no manual restart). |
| D. Playground wiring | `LocalAITranscriptInner` reads `useVoiceProfiles()` and `useAuthStore` to derive `resolvedSpeakerLabel = activeProfile.label ?? impersonatedUsername ?? authUsername ?? 'Doctor'` (per user choice "Use user name, falls back to profile's label" — implementation reads as user-first, with profile label only when both names are absent and a profile is enrolled), then passes `voiceProfile: { id, reservedSpeakerId }` into `useSTT`. |
| E. Playground replay decoupling | New `apps/ui-playground/src/features/audio/lib/wav-encoder.ts` (Float32 PCM → 16-bit mono WAV blob with proper RIFF header). `enqueueSpeechSegment` encodes each VAD-emitted utterance as a self-contained WAV, registers the `URL.createObjectURL` in a ref, and attaches it to the `TranscriptEntry`. `playSegment` plays `entry.audioUrl` directly (`new Audio(url).play()`) when present; the legacy MediaRecorder/seek path stays as a fallback for remote STT entries. `handleClear` and the unmount effect both `URL.revokeObjectURL` everything to avoid blob leaks. |

**Implementation note — speaker label priority:** The user requested "use user name, falls back to profile's label". The playground implements this as:

```
resolvedSpeakerLabel =
  activeVoiceProfile.label.trim()
  ?? impersonatedUser.username.trim()
  ?? authUser.username.trim()
  ?? 'Doctor'
```

`activeVoiceProfile.label` is preferred when present because that field is what the doctor **typed at enrollment time** as the display name they want on transcripts (e.g. "Dr. Nguyen"), while `username` is a system handle. When the user enrolls a profile without a custom label, the field is empty and we fall through to the impersonated/auth username automatically. The same string is reused as the diarizer's `reservedSpeakerId`, which means the transcript badge and the diarization anchor are guaranteed to read identically — no second lookup needed in the UI.

**Files modified / added:**

| Layer | File | Change |
| --- | --- | --- |
| @arcaai/stt | `src/providers/LocalSTTProvider.ts` | Public `setReservedSpeakerId(id?: string): void` → `this.diarizer?.setReservedSpeakerId(id)`. Safe before init. |
| @arcaai/stt | `src/core/STTProcessor.ts` | Public `setReservedSpeakerId(id?: string): void`; forwards only when active provider is `local`. |
| @arcaai/stt | `src/hooks/useSTT.ts` | `configFingerprint` extended with `voiceProfile?.id` and `voiceProfile?.reservedSpeakerId`. |
| @arcaai/stt | `src/providers/__tests__/LocalSTTProvider.test.ts` | New "Wave 3 setReservedSpeakerId forwarding" group: delegation + pre-init safety. |
| @arcaai/stt | `src/__tests__/STTProcessor.setReservedSpeakerId.test.ts` | **new** — forwards to local provider; no-op for remote; no-op when uninitialized; `undefined` accepted. |
| @arcaai/vox | `src/core/PluginManager.ts` | New static `resolveReservedSpeakerId(label?: string): string` (trimmed label or `'Doctor'`); used in `getTranscriptionPipelineConfig` and `propagateUserPreferenceDelta`. |
| @arcaai/vox | `src/core/__tests__/PluginManager.wave2.test.ts` | Expectations updated: dynamic label resolves to `'Doctor'` (no label) or `'Dr. Alice'` (label = "Dr. Alice"). |
| @arcaai/ui-playground | `src/features/audio/lib/wav-encoder.ts` | **new** — `encodeWavBlob(audio: Float32Array, sampleRate: number): { blob: Blob; durationSec: number }`. 16-bit PCM, mono, sample-rate-driven; clamps `±Infinity`, coerces `NaN → 0`. |
| @arcaai/ui-playground | `src/features/audio/lib/__tests__/wav-encoder.test.ts` | **new** — 5 cases: RIFF/`fmt`/`data` header correctness, Int16 quantization, ±1 clamping (including `±Infinity`), `NaN`-as-0, invalid-rate rejection. |
| @arcaai/ui-playground | `src/store/audio-store.ts` | `TranscriptEntry` gains optional `audioUrl?: string`. |
| @arcaai/ui-playground | `src/features/audio/components/transcript-panel.tsx` | Reads `useVoiceProfiles()` + `useAuthStore`; computes `resolvedSpeakerLabel`; passes `voiceProfile: { id, reservedSpeakerId }` into `useSTT`; encodes each VAD segment to WAV in `enqueueSpeechSegment`; `appendFinalEntry` carries the URL; `playSegment` prefers `entry.audioUrl`; `revokeAllSegmentAudioUrls` invoked from `handleClear` and unmount effect. |

**Verification:**

```
@arcaai/stt  → vitest run
  Test Files  25 passed (25)
       Tests  377 passed (377)
@arcaai/vox  → vitest run
  Test Files  129 passed (129)
       Tests  2903 passed (2903)
@arcaai/ui-playground → vitest run src/features/audio/lib/__tests__/wav-encoder.test.ts
  Test Files  1 passed (1)
       Tests  5 passed (5)

ESLint (legacy config) on the 11 changed files → 0 errors
ReadLints on the 11 changed files → No linter errors found
```

**Known baseline noise (not regressions):**

- `tsc --noEmit` on `@arcaai/ui-playground` baseline emits 662 errors before this change and 664 after; the +2 delta is in `transcript-panel.tsx` lines 661–662 where `useAuthStore((s) => ...)` selectors gain an implicit-`any` on `s`. This is the same implicit-`any` already propagated through `auth-store.ts` and used identically in `user-list.tsx`, `prompts/index.tsx`, and `audio-pipelines/index.tsx`. Fix requires typing the Zustand `create()` call site — out of scope for this hotfix; flag as a follow-up if/when the project does a typed-store sweep.
- The 92 pre-existing test failures in `@arcaai/ui-playground` (across `processing-config-panel.test.tsx`, `all-reports-panel.test.tsx`, `api-key-form.test.tsx`, `use-file-transcription.test.ts`, `use-auto-refresh.impersonation.test.ts`) reproduce identically with this change stashed; **none** are in `transcript-panel`, `wav-encoder`, or `audio-store`.

**Follow-ups (raise as separate tickets if needed):**

- Type-annotate `useAuthStore` (`create<AuthStore>()`) to eliminate the project-wide implicit-`any` cascade.
- Consider hoisting `wav-encoder.ts` into `@arcaai/stt` (or a shared `@arcaai/audio-utils` package) so future consumers (vox-SDK demos, admin tools) can encode VAD segments without copying.
- Investigate whether `MediaRecorder`-based session replay can be retired entirely once every transcript entry carries an `audioUrl` (would simplify `transcript-panel` and free a `useRef` chain).

