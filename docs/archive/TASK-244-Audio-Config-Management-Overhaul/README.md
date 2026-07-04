# TASK-244: Audio Configuration Management Overhaul

- **Ticket**: TASK-244
- **Type**: bugfix + refactor + enhancement
- **Created**: 2026-03-09
- **Updated**: 2026-03-10
- **Status**: Completed

---

## 1. Requirement Analysis

### Description

The `/audio/live-transcription` page in `ui-playground` exhibits a critical bug where:

1. On initial load, **4 Whisper models** appear (tenant config: `whisper-tiny`, `whisper-base`, `whisper-small`, `whisper-medium`)
2. Selecting any model and starting capture produces **garbage/useless transcription**
3. After clicking **Reset**, re-selecting a microphone shows **3 models** (initial state: `tiny`, `base`, `small`)
4. Selecting a model and starting capture produces **perfect real-time transcription**

Root cause investigation revealed systemic issues in:
- Model ID format mismatch between store (`tiny`) and tenant config (`whisper-tiny`)
- `useSTT` hook creating `STTProcessor` once with stale options, never updating when config changes
- Race condition between initial Zustand state and async tenant config loading
- No multi-tier configuration hierarchy (developer defaults → tenant settings → user preferences)
- Duplicated utilities and lifecycle issues across audio packages

Additionally, the SDK lacks a proper configuration management pattern for:
- **User preferences** (persisted per-user, editable by end-users)
- **Tenant settings** (applied to all users in a tenant, managed by admin)
- **SDK defaults** (hardcoded by developer, immutable at runtime)

### Business Context

- Live transcription is a core feature for medical consultation workflows
- Configuration inconsistency causes first-use failures, damaging user trust
- No user preference persistence means users must reconfigure on every session
- Tenant admins cannot enforce audio settings for their organization

### Acceptance Criteria

- [ ] Model selection works correctly on first load (no reset required)
- [ ] Model IDs are normalized consistently across all layers
- [ ] Changing model/language/features in the UI takes effect immediately
- [ ] Configuration follows a 3-tier cascade: SDK defaults → tenant config → user preferences
- [ ] User preferences persist across sessions (IndexedDB + server sync)
- [ ] Tenant-admin-only settings cannot be changed by end users
- [ ] Duplicated browser support utilities are consolidated
- [ ] Audio pipeline lifecycle (AudioContext, workers) is clean with no leaks
- [ ] All changes are covered by tests

---

## 2. Current State Evaluation

### Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Database (Prisma)                                                        │
│  GlobalSetting (tenant-scoped, 15 keys × 4 tenants)                     │
│  UserSettings  (user-scoped, currently unused for audio prefs)           │
└──────────────────────────────────────────────────────────────────────────┘
         ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  API Layer                                                                │
│  GET /tenant/me/config → flat [{key, value, namespace}]                  │
│  GET /user/me/settings → [{key, value, namespace}]                       │
└──────────────────────────────────────────────────────────────────────────┘
         ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  SDK (@arcaai/vox)                                                        │
│  ModelRegistry.loadTenantConfig() → parseTenantConfig() → store          │
│  useArcaConfig() → { tenantConfig, preferences }                         │
│  PersonalizationManager → preferences (theme, density)                   │
└──────────────────────────────────────────────────────────────────────────┘
         ↓
┌──────────────────────────────────────────────────────────────────────────┐
│  UI (ui-playground)                                                       │
│  audio-store.ts → availableAsrModels, whisperModel, language, etc.       │
│  processing-config-panel.tsx → model dropdown, feature toggles           │
│  transcript-panel.tsx → useSTT, useAudioTrack, createVAD                 │
└──────────────────────────────────────────────────────────────────────────┘
```

### Bug Chain — First Load Failure

```
1. audio-store initializes: whisperModel='tiny', models=[tiny, base, small]
2. Tenant config loads async: models=[whisper-tiny, whisper-base, whisper-small, whisper-medium]
3. applyTenantDefaults() runs:
   - 'tiny' ∉ ['whisper-tiny','whisper-base','whisper-small','whisper-medium']
   - whisperModel reset to 'whisper-tiny' (first after sort)
4. UI shows 4 models. User picks 'whisper-base'.
5. useSTT created STTProcessor at mount with modelId='tiny' (initial value)
   - STTProcessor created ONCE via useEffect([], []) — never updated
6. Actual Whisper worker loads 'tiny' model, user thinks they picked 'base'
7. Mismatch → broken transcription
```

### Bug Chain — After Reset

```
1. reset() restores initialState: whisperModel='tiny', models=[tiny, base, small]
2. LocalAITranscript unmounts (processingMethod reset to 'backend_socket')
   - Old STTProcessor destroyed
3. tenantConfigSignatureRef already matches → applyTenantDefaults() skipped
4. Models stay at 3 (short IDs: tiny, base, small)
5. User picks 'base'. New useSTT creates STTProcessor with modelId='base'
6. Whisper worker loads 'base' model correctly
7. Transcription works
```

### Defects Found

| # | Defect | Location | Severity |
|---|--------|----------|----------|
| D1 | Model ID format mismatch: `'tiny'` vs `'whisper-tiny'` | `audio-store.ts` initial state vs `11-global-setting.ts` seed | Critical |
| D2 | `useSTT` creates `STTProcessor` once, ignores option changes | `packages/stt/src/hooks/useSTT.ts` line 203-241 | Critical |
| D3 | Tenant config race: async overwrite after mount | `features/audio/index.tsx` `useEffect` + `applyTenantDefaults` | High |
| D4 | No model ID normalization at store/UI boundary | `audio-store.ts` `applyTenantDefaults()` | High |
| D5 | `TranscriptionPipeline.stop()` closes shared `AudioContext` | `packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts` | Medium |
| D6 | Duplicated browser support utilities across 5 packages | `*/utils/browserSupport.ts` in room, stt, vad, noise-filter, med-ner | Low |
| D7 | Unused VAD worklet exports (dead code) | `packages/vad/src/worklets/` | Low |
| D8 | `useSTT` hook options not in dependency array (stale closure) | `packages/stt/src/hooks/useSTT.ts` | High |

### Enhancement Gaps

| # | Gap | Impact |
|---|-----|--------|
| E1 | No user preference persistence for audio settings | Users reconfigure every session |
| E2 | No 3-tier config cascade (defaults → tenant → user) | No hierarchy; store mixes all sources |
| E3 | No permission-tagged settings (admin-only vs user-editable) | End users could theoretically override admin settings |
| E4 | No config schema validation at client boundary | Invalid server data can corrupt store |
| E5 | No config-ready gate before rendering audio components | Components render before config is resolved |

---

## 3. Implementation Plan

### Phase 0 — Critical Bug Fixes (No Architectural Changes)

Quick, targeted fixes that unblock the broken transcription immediately.

#### Task 0.1: Normalize Model IDs Consistently

**Goal**: Ensure `'tiny'` and `'whisper-tiny'` are treated as equivalent everywhere.

**Files to modify**:
- `apps/ui-playground/src/store/audio-store.ts`
- `apps/ui-playground/src/features/audio/components/processing-config-panel.tsx`

**Changes**:
1. Add `normalizeModelId()` utility to `audio-store.ts`:
   ```typescript
   function normalizeAsrModelId(id: string): string {
     return id.replace(/^whisper-/, '');
   }
   ```
2. In `applyTenantDefaults()`:
   - Normalize incoming tenant model IDs before comparison
   - Normalize `whisperModel` before validity check
3. In `initialState`:
   - Change model IDs to use the prefixed format (`whisper-tiny`, `whisper-base`, `whisper-small`) to match tenant config
   - Add `whisper-medium` to initial list (align with seed data)
   - Set `whisperModel: 'whisper-tiny'`
4. In `processing-config-panel.tsx`:
   - Update `FALLBACK_ASR_MODELS` to use prefixed IDs

**Tests**: Unit test for `normalizeAsrModelId()` and `applyTenantDefaults()` with mixed ID formats.

#### Task 0.2: Make `useSTT` Reactive to Critical Option Changes

**Goal**: When `modelId`, `language`, or feature flags change, the `STTProcessor` must be recreated or reconfigured.

**Files to modify**:
- `packages/stt/src/hooks/useSTT.ts`

**Changes**:
1. Compute a **config fingerprint** from the critical options:
   ```typescript
   const configFingerprint = useMemo(() => JSON.stringify({
     modelId: sttOptions.features?.modelId,
     language: sttOptions.audio?.language,
     provider: sttOptions.features?.provider,
     diarization: sttOptions.features?.diarization,
     codeSwitching: sttOptions.features?.codeSwitching,
     vadGate: sttOptions.features?.vadGate,
   }), [sttOptions.features, sttOptions.audio?.language]);
   ```
2. Change the processor creation `useEffect` to depend on `configFingerprint`:
   ```typescript
   useEffect(() => {
     // Destroy previous processor
     if (processorRef.current) {
       processorRef.current.destroy().catch(console.error);
       processorRef.current = null;
     }
     // Create new processor with current options
     processorRef.current = new STTProcessor({ ...sttOptions, onModelProgress: ... });
     setProviderType(processorRef.current.getProviderType());
     // Re-attach if track is available
     if (trackRef.current) {
       processorRef.current /* re-attach logic */
     }
     return () => { /* cleanup */ };
   }, [configFingerprint]);
   ```
3. Preserve the `LocalSTTProvider` pool warm-cache behavior during recreation.

**Tests**: Unit test that verifies processor is recreated when `modelId` changes.

#### Task 0.3: Fix Tenant Config Race with Config-Ready Gate

**Goal**: Don't show model selector or allow capture until config is resolved.

**Files to modify**:
- `apps/ui-playground/src/store/audio-store.ts`
- `apps/ui-playground/src/features/audio/index.tsx`
- `apps/ui-playground/src/features/audio/components/processing-config-panel.tsx`

**Changes**:
1. Add `configReady: boolean` to `audio-store` state (initial: `false`).
2. `applyTenantDefaults()` sets `configReady: true` after applying.
3. If SDK is not available (no `AgenticProvider`), set `configReady: true` immediately with defaults.
4. `ProcessingConfigPanel` disables model selector and capture button while `!configReady`.
5. `AudioPage` `useEffect` sets `configReady: true` if `tenantConfig` is null after a reasonable timeout (2s) to handle SDK-less scenarios.

**Tests**: Component test verifying model selector is disabled until configReady is true.

---

### Phase 1 — Multi-Tier Configuration Architecture in `@arcaai/vox`

Introduce a proper 3-tier configuration cascade within the SDK.

#### Task 1.1: Define Configuration Schema with Permission Tiers

**Goal**: Create a typed, permission-tagged configuration schema that serves as the single source of truth.

**New file**: `packages/agentic-sdk-v2/src/core/ConfigSchema.ts`

**Design**:
```typescript
type ConfigPermission = 'system' | 'admin' | 'user';

interface ConfigFieldMeta<T> {
  defaultValue: T;
  permission: ConfigPermission;
  section: string;
  key: string;
  label: string;
  validate?: (value: T) => boolean;
}

// Permission rules:
// 'system' — SDK defaults, immutable at runtime
// 'admin'  — tenant admin only (GlobalSetting); read-only for end users
// 'user'   — end-user editable (UserSettings); persisted per user
```

**Configuration sections**:

| Section | Key | Default | Permission | Notes |
|---------|-----|---------|------------|-------|
| `audio` | `sampleRate` | `16000` | `admin` | Audio capture sample rate |
| `audio` | `noiseSuppression` | `true` | `user` | User can toggle |
| `audio` | `noiseFilterLevel` | `'medium'` | `user` | Low/medium/high |
| `audio` | `vadEnabled` | `false` | `user` | User can toggle |
| `audio` | `vadThreshold` | `0.5` | `admin` | Sensitivity tuning |
| `audio` | `diarization` | `false` | `user` | User can toggle |
| `audio` | `codeSwitching` | `false` | `admin` | Feature flag controlled |
| `stt` | `provider` | `'local'` | `admin` | Local vs backend |
| `stt` | `defaultModel` | `'whisper-tiny'` | `admin` | Default Whisper model |
| `stt` | `availableModels` | `[tiny,base,small]` | `admin` | Models shown in UI |
| `stt` | `language` | `'en'` | `user` | Preferred language |
| `ui` | `theme` | `'system'` | `user` | Light/dark/system |
| `ui` | `density` | `'normal'` | `user` | UI density |
| `smr` | `provider` | `'openai'` | `admin` | Summary provider |
| `smr` | `model` | `'gpt-4o'` | `admin` | Summary model |
| `features` | `ner` | `false` | `admin` | NER feature flag |
| `features` | `tts` | `false` | `admin` | TTS feature flag |
| `features` | `dnaStyle` | `false` | `admin` | DNA style notes |
| `features` | `crossChainSummary` | `false` | `admin` | Cross-chain summary |

#### Task 1.2: Create `ConfigManager` Core Class

**Goal**: Centralized config resolution with 3-tier deep merge.

**New file**: `packages/agentic-sdk-v2/src/core/ConfigManager.ts`

**API**:
```typescript
class ConfigManager {
  // Tier management
  setTenantConfig(config: DeepPartial<ResolvedConfig>): void;
  setUserPreferences(prefs: DeepPartial<ResolvedConfig>): void;

  // Resolution
  getResolved(): ResolvedConfig;          // full merged config
  getSection<K>(section: K): ResolvedConfig[K]; // section-level
  getValue<K, F>(section: K, field: F): ResolvedConfig[K][F]; // field-level

  // Permission enforcement
  canUserEdit(section: string, key: string): boolean;
  setUserValue(section: string, key: string, value: unknown): boolean; // returns false if not allowed

  // Persistence
  loadUserPreferences(): Promise<void>;    // from IndexedDB + server
  saveUserPreferences(): Promise<void>;    // to IndexedDB + server sync
  clearUserPreferences(): void;

  // Events
  on(event: 'configChanged', handler: (config: ResolvedConfig) => void): void;
}
```

**Merge strategy**:
```
SDK_DEFAULTS (frozen)
  ← deep-merge with tenantConfig (admin-only fields)
    ← deep-merge with userPreferences (user-editable fields only)
      = ResolvedConfig
```

**Constraint enforcement**: If tenant config sets `forceLanguage`, user `language` preference is ignored. If tenant config sets `allowedModels`, user cannot select a model outside that list.

#### Task 1.3: Add User Audio Preferences to `UserSettings` API

**Goal**: Define and seed the user-editable audio preference keys.

**Files to modify**:
- `packages/database/src/prisma/db_main/seed/` (new seed or update existing)
- `packages/applications/src/services/user/userSettings/` (add namespace support)
- `packages/agentic-sdk-v2/src/hooks/useUserSettings.ts` (add audio-specific helpers)

**User preference keys** (namespace: `audio-preferences`):

| Key | DataType | Default | Description |
|-----|----------|---------|-------------|
| `preferred-language` | `String` | `'en'` | Preferred transcription language |
| `noise-suppression` | `Boolean` | `true` | Noise cancellation preference |
| `noise-filter-level` | `String` | `'medium'` | Filter aggressiveness |
| `vad-enabled` | `Boolean` | `false` | VAD toggle |
| `diarization-enabled` | `Boolean` | `false` | Speaker diarization toggle |
| `preferred-theme` | `String` | `'system'` | UI theme |

**SDK helper** in `useUserSettings`:
```typescript
function useAudioPreferences() {
  const { getMySettings, update } = useUserSettings();
  // Filter for namespace 'audio-preferences'
  // Return typed preference object
  // Provide setPreference(key, value) that persists to server
}
```

#### Task 1.4: Integrate `ConfigManager` into `AgenticProvider`

**Goal**: Wire up the 3-tier cascade into the SDK initialization flow.

**Files to modify**:
- `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx`
- `packages/agentic-sdk-v2/src/store/agenticStore.ts`
- `packages/agentic-sdk-v2/src/hooks/useArcaConfig.ts`

**Flow**:
1. `AgenticProvider` mounts → creates `ConfigManager`
2. `ConfigManager` loads:
   a. SDK defaults (synchronous, from `ConfigSchema`)
   b. Tenant config (async, from `GET /tenant/me/config`)
   c. User preferences (async, from `GET /user/me/settings` + IndexedDB cache)
3. Store receives `resolvedConfig` and `configReady: true`
4. `useArcaConfig()` returns resolved config, section selectors, and `setUserPreference()`

**Backward compatibility**: Existing `tenantConfig` shape is preserved. New `resolvedConfig` is additive.

#### Task 1.5: Client-Side Persistence with IndexedDB

**Goal**: User preferences are instantly available on page load (no flash of defaults).

**Files to modify**:
- `packages/agentic-sdk-v2/src/core/ConfigManager.ts`
- `packages/agentic-sdk-v2/src/store/agenticStore.ts`

**Strategy**:
- Use `zustand/middleware/persist` with IndexedDB storage for user preferences slice
- On load: IndexedDB → store (instant), then server fetch → merge (background)
- On preference change: store (optimistic) → IndexedDB (sync) → server (async with retry)
- Conflict resolution: server-wins for admin fields, last-write-wins for user fields

---

### Phase 2 — Audio Pipeline Fixes & Cleanup

#### Task 2.1: Fix `TranscriptionPipeline` AudioContext Ownership

**Goal**: Pipeline should not close an AudioContext it doesn't own.

**Files to modify**:
- `packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts`

**Changes**:
1. Remove `audioContext.close()` from `stop()` — the caller owns the context
2. Add `contextOwnership: 'owned' | 'borrowed'` to pipeline config
3. Only close context if `contextOwnership === 'owned'`

#### Task 2.2: Wire Config into `ui-playground` Audio Store

**Goal**: Replace the manual `applyTenantDefaults` pattern with the SDK's resolved config.

**Files to modify**:
- `apps/ui-playground/src/store/audio-store.ts`
- `apps/ui-playground/src/features/audio/index.tsx`
- `apps/ui-playground/src/features/audio/components/processing-config-panel.tsx`

**Changes**:
1. `audio-store` reads initial values from `useArcaConfig().resolvedConfig` when available
2. Remove `applyTenantDefaults()` action entirely — replaced by `ConfigManager`
3. `ProcessingConfigPanel` reads available models from resolved config
4. Feature toggles (noise, VAD, diarization) read defaults from resolved config
5. User changes call `setUserPreference()` which persists to SDK

#### Task 2.3: Consolidate Browser Support Utilities

**Goal**: Single source of truth for browser capability detection.

**Changes**:
1. Create `packages/room/src/utils/browserSupport.ts` as the canonical implementation (it already exists and is the most complete)
2. Re-export from `@arcaai/room` public API
3. In `@arcaai/stt`, `@arcaai/vad`, `@arcaai/noise-filter`, `@arcaai/med-ner`:
   - Replace local `browserSupport.ts` with imports from `@arcaai/room`
   - Keep package-specific detection functions (e.g., `isWebGPUSupported` in stt)

#### Task 2.4: Remove Unused VAD Worklet Exports

**Goal**: Clean up dead code in `@arcaai/vad`.

**Files to modify**:
- `packages/vad/src/index.ts` — remove worklet exports if unused
- `packages/vad/src/worklets/` — mark as internal or remove

**Validation**: Search all consumers to confirm the worklet API is not used anywhere.

---

### Phase 3 — Testing & Documentation

#### Task 3.1: Unit Tests for Config Resolution

- Test 3-tier merge with overlapping keys
- Test permission enforcement (user cannot set admin fields)
- Test model ID normalization
- Test `applyTenantDefaults` → `ConfigManager` migration path
- Test IndexedDB persistence round-trip

#### Task 3.2: Integration Tests for Audio Pipeline

- Test `useSTT` processor recreation on model change
- Test config-ready gate blocks capture
- Test reset clears config and re-resolves
- Test model selection → correct Whisper model loaded

#### Task 3.3: Update Documentation

- Update this README with Implementation Summary
- Update SDK README with configuration hierarchy docs
- Update `08-vox-sdk.mdc` cursor rule with new config patterns

---

## 4. Dependency Chain

```
Phase 0 (Critical Bug Fixes) — No dependencies, can start immediately
  ├── Task 0.1: Normalize Model IDs
  ├── Task 0.2: Make useSTT Reactive
  └── Task 0.3: Config-Ready Gate

Phase 1 (Config Architecture) — After Phase 0
  ├── Task 1.1: Config Schema (no deps)
  ├── Task 1.2: ConfigManager (depends on 1.1)
  ├── Task 1.3: User Preferences API (depends on 1.1)
  ├── Task 1.4: Provider Integration (depends on 1.2, 1.3)
  └── Task 1.5: IndexedDB Persistence (depends on 1.2)

Phase 2 (Pipeline Fixes) — After Phase 0; Phase 1 not required
  ├── Task 2.1: AudioContext Ownership (no deps)
  ├── Task 2.2: Wire Config into UI (depends on Phase 1)
  ├── Task 2.3: Consolidate Browser Support (no deps)
  └── Task 2.4: Remove Dead VAD Code (no deps)

Phase 3 (Testing & Docs) — After Phase 1 and 2
  ├── Task 3.1: Unit Tests
  ├── Task 3.2: Integration Tests
  └── Task 3.3: Documentation
```

---

## 5. Risk Assessment

| Risk | Mitigation |
|------|------------|
| Breaking existing tenant config consumers | Backward-compatible: `tenantConfig` shape preserved; `resolvedConfig` is additive |
| `useSTT` processor recreation causes audio glitch | Preserve `LocalSTTProvider` pool warm-cache; only recreate on meaningful config changes |
| IndexedDB unavailable (e.g., private browsing) | Graceful fallback to `localStorage` then memory-only |
| User preferences conflict with tenant admin settings | Permission tier enforcement: admin fields in user preferences are silently ignored |
| Large bundle impact from schema validation | Use Valibot (~3KB) instead of Zod (~30KB) for SDK-side validation |

---

## 6. Files Affected (Summary)

### Modified

| File | Phase | Reason |
|------|-------|--------|
| `apps/ui-playground/src/store/audio-store.ts` | 0, 2 | Normalize IDs, config-ready gate, wire config |
| `apps/ui-playground/src/features/audio/index.tsx` | 0, 2 | Config-ready gate, remove applyTenantDefaults |
| `apps/ui-playground/src/features/audio/components/processing-config-panel.tsx` | 0, 2 | Fallback model IDs, config-ready |
| `apps/ui-playground/src/features/audio/components/transcript-panel.tsx` | 0 | Verify model ID passed to useSTT |
| `packages/stt/src/hooks/useSTT.ts` | 0 | Config fingerprint, reactive recreation |
| `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx` | 1 | Integrate ConfigManager |
| `packages/agentic-sdk-v2/src/store/agenticStore.ts` | 1 | resolvedConfig slice |
| `packages/agentic-sdk-v2/src/hooks/useArcaConfig.ts` | 1 | Expose resolved config |
| `packages/agentic-sdk-v2/src/hooks/useUserSettings.ts` | 1 | Audio preference helpers |
| `packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts` | 2 | AudioContext ownership |
| `packages/stt/src/utils/browserSupport.ts` | 2 | Import from @arcaai/room |
| `packages/vad/src/utils/browserSupport.ts` | 2 | Import from @arcaai/room |
| `packages/noise-filter/src/utils/browserSupport.ts` | 2 | Import from @arcaai/room |
| `packages/med-ner/src/utils/browserSupport.ts` | 2 | Import from @arcaai/room |
| `packages/vad/src/index.ts` | 2 | Remove unused worklet exports |

### New

| File | Phase | Purpose |
|------|-------|---------|
| `packages/agentic-sdk-v2/src/core/ConfigSchema.ts` | 1 | Permission-tagged config schema |
| `packages/agentic-sdk-v2/src/core/ConfigManager.ts` | 1 | 3-tier config resolution engine |
| `packages/agentic-sdk-v2/src/core/__tests__/ConfigManager.test.ts` | 3 | Config resolution tests |
| `packages/stt/src/hooks/__tests__/useSTT.test.ts` | 3 | Processor recreation on config change (D2 regression) |
| `apps/ui-playground/src/store/__tests__/audio-store.test.ts` | 3 | Config-ready gate, reset, model ID normalization |

---

## 7. Implementation Summary

**Status**: Completed

### What Was Built

1. **Phase 0 — Critical Bug Fixes**:
   - Task 0.1: Normalized model IDs to `whisper-` prefix format across seed, store, and UI. Removed `whisper-medium` from local ASR models (770MB impractical for browser).
   - Task 0.2: Made `useSTT` hook reactive via config fingerprint. Processor now recreates when modelId, language, provider, diarization, codeSwitching, or vadGate change.
   - Task 0.3: Added `configReady` gate to audio store and processing config panel. Fixed reset to clear `tenantConfigSignatureRef` so tenant config re-applies.
   - Task 0.4: Removed invalid `getModelsByType('noiseCancellation')` and `getModelsByType('voiceEmbedding')` calls from `useArcaConfig`.

2. **Phase 1 — Three-Tier Configuration Architecture**:
   - Task 1.1: Created `ConfigSchema.ts` with Valibot schemas, permission tiers (`system`/`admin`/`user`), and SYSTEM_DEFAULTS.
   - Task 1.2: Created `ConfigManager.ts` — three-tier resolution engine with deepmerge-ts, event emission, locked paths enforcement.
   - Task 1.3: Added user preferences API endpoints (`GET/PATCH /user/me/preferences`, `GET/PATCH /user/me/settings/:ns/:key`).
   - Task 1.4: Integrated ConfigManager into AgenticProvider with full initialization flow.
   - Task 1.5: Added IndexedDB persistence with localStorage fallback for instant preference loading.
   - Task 1.6: Added `locked` boolean to GlobalSetting schema, seeded locked-config-paths per tenant.

3. **Phase 2 — Audio Pipeline Fixes & Cleanup**:
   - Task 2.1: Fixed TranscriptionPipeline AudioContext ownership (borrowed vs owned).
   - Task 2.2: Wired ConfigManager into ui-playground with locked field indicators.
   - Task 2.3: Consolidated browser support utilities to use `@arcaai/room` as canonical source.
   - Task 2.4: Removed unused VAD worklet public exports.
   - Task 2.5: Consolidated resampling utilities across room/stt/vad.
   - Task 2.6: Consolidated worklet loader pattern via shared `createWorkletLoader` in `@arcaai/room`.

4. **Phase 3 — Testing & Documentation**:
   - Task 3.1: Unit tests for ConfigManager (3-tier merge, permissions, locked paths, events).
   - Task 3.2: Integration tests for audio pipeline — useSTT processor recreation (D2 regression), audio-store configReady gate (D3), reset behavior, model ID normalization.
   - Task 3.3: Updated this README with implementation summary.

### Files Changed Summary

| File | Type | Purpose |
|------|------|---------|
| `packages/agentic-sdk-v2/src/core/ConfigSchema.ts` | New | Valibot schemas, permission tiers, SYSTEM_DEFAULTS |
| `packages/agentic-sdk-v2/src/core/ConfigManager.ts` | New | 3-tier resolution engine, events, locked paths |
| `packages/agentic-sdk-v2/src/core/__tests__/ConfigManager.test.ts` | New | ConfigManager unit tests |
| `apps/api/src/modules/user/controllers/user-preferences.controller.ts` | New | GET/PATCH `/user/me/preferences` |
| `apps/api/src/modules/user/controllers/user-settings.controller.ts` | New | GET/PATCH `/user/me/settings/:ns/:key` |
| `packages/applications/src/services/user/userSettings/dto/updateUserSettingByKey.request.ts` | New | DTO for PATCH settings body |
| `packages/database/src/prisma/db_main/migrations/20260310000000_add_global_setting_locked/migration.sql` | New | GlobalSetting `locked` column |
| `packages/room/src/utils/workletLoader.ts` | New | Shared `createWorkletLoader` |
| `apps/ui-playground/src/store/audio-store.ts` | Modified | Model ID normalization, configReady gate, reset fix |
| `apps/ui-playground/src/features/audio/index.tsx` | Modified | Config-ready gate, ConfigManager wiring |
| `apps/ui-playground/src/features/audio/components/processing-config-panel.tsx` | Modified | Locked indicators, configReady |
| `packages/stt/src/hooks/useSTT.ts` | Modified | Config fingerprint, reactive processor recreation |
| `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx` | Modified | ConfigManager integration |
| `packages/agentic-sdk-v2/src/store/agenticStore.ts` | Modified | resolvedConfig, IndexedDB persistence |
| `packages/agentic-sdk-v2/src/hooks/useArcaConfig.ts` | Modified | Removed invalid getModelsByType calls |
| `packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts` | Modified | AudioContext ownership (borrowed vs owned) |
| `packages/agentic-sdk-v2/src/core/index.ts` | Modified | Export ConfigManager, ConfigSchema |
| `packages/database/src/prisma/db_main/globalSetting.prisma` | Modified | Added `locked` field |
| `packages/database/src/prisma/db_main/seed/11-global-setting.ts` | Modified | Seeded locked-config-paths |
| `packages/stt/src/utils/browserSupport.ts` | Modified | Import from @arcaai/room |
| `packages/vad/src/utils/browserSupport.ts` | Modified | Import from @arcaai/room |
| `packages/noise-filter/src/utils/browserSupport.ts` | Modified | Import from @arcaai/room |
| `packages/vad/src/index.ts` | Modified | Removed unused worklet exports |
| `packages/room/src/index.ts` | Modified | Export workletLoader |
| `packages/stt/src/utils/audioResampler.ts` | Modified | Consolidated resampling |
| `packages/vad/src/utils/resampler.ts` | Modified | Consolidated resampling |
| `packages/agentic-sdk-v2/package.json` | Modified | Added valibot, deepmerge-ts |
| `packages/stt/src/hooks/__tests__/useSTT.test.ts` | New | Processor recreation on model change (D2 regression) |
| `apps/ui-playground/src/store/__tests__/audio-store.test.ts` | Modified | Full rewrite: 94 tests covering TASK-244 config integration |
| `apps/ui-playground/src/features/audio/__tests__/audio-page-config.test.ts` | New | AudioPage config resolution tests (11 tests) |
| `apps/ui-playground/src/features/audio/components/__tests__/processing-config-panel.test.tsx` | New | ProcessingConfigPanel locked fields, toggles, user pref persistence (59 tests) |
| `apps/ui-playground/src/features/admin/configurations/__tests__/configurations-page.test.tsx` | New | Admin Configurations page tests (21 tests) |
| `apps/ui-playground/src/features/admin/api/__tests__/user-settings-api.test.ts` | New | User Settings/Preferences API integration tests (9 tests) |
| `packages/agentic-sdk-v2/src/core/__tests__/ConfigSchema.test.ts` | New | ConfigSchema validation, permissions, defaults (32 tests) |
| `packages/agentic-sdk-v2/src/store/__tests__/agenticStore.test.ts` | Modified | Added TASK-244 config slice tests (88 total tests) |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useArcaConfig.test.ts` | Modified | Added TASK-244 config hook tests (20 total tests) |
| `packages/stt/package.json` | Modified | Added @testing-library/react |

### New Dependencies

- `valibot` ^1.0.0
- `deepmerge-ts` ^7.1.5

---

## Change History

| Date | Description | Files |
|------|-------------|-------|
| 2026-03-09 | Initial analysis, root cause identification, implementation plan | This README |
| 2026-03-10 | Task 1.3: User Preferences API + User Settings API endpoints | user-preferences.controller, user-settings.controller, UserSettingsService |
| 2026-03-10 | Task 3.3: Implementation Summary — added Phase 0–3 summary, Files Changed table, New Dependencies | This README |
| 2026-03-10 | Task 3.2: Integration tests — useSTT processor recreation, audio-store configReady/reset/normalization | useSTT.test.ts, audio-store.test.ts |
| 2026-03-10 | Task 3.4: Comprehensive UI test suite for ui-playground & SDK (418 total tests) | See Task 3.4 summary below |

### Task 3.4 Implementation Summary (2026-03-10)

Comprehensive test coverage for all TASK-244 UI and SDK changes. **418 tests** across **10 test files** — all passing.

**SDK tests (224 tests across 5 files):**

| File | Tests | Coverage |
|------|-------|----------|
| `ConfigSchema.test.ts` | 32 | Valibot validation, SYSTEM_DEFAULTS, CONFIG_PERMISSIONS, getFieldPermission, canUserEditField, getUserEditableFields |
| `ConfigManager.test.ts` | 46 | 3-tier merge (defaults ← tenant ← user), permission enforcement, locked paths, event emission, persistence callbacks |
| `agenticStore.test.ts` | 88 | setConfigManager, setResolvedConfig, setConfigReady, selectors, reset behavior |
| `useArcaConfig.test.ts` | 20 | resolvedConfig, configReady, isLocked, setUserPreference, resetUserPreferences, removed model type fix |
| `TranscriptionPipeline.test.ts` | 38 | Existing pipeline tests (unchanged, verified still passing) |

**ui-playground tests (194 tests across 5 files):**

| File | Tests | Coverage |
|------|-------|----------|
| `audio-store.test.ts` | 94 | Full rewrite: initial state, applyTenantDefaults normalization/filtering, applyResolvedConfig priority, configReady gate, reset, all audio toggles, transcription management |
| `processing-config-panel.test.tsx` | 59 | Locked field indicators, config-ready gate (Select disabled), switch toggle with setUserPreference gating, noise level badges, VAD slider, code-switching info text, card structure |
| `configurations-page.test.tsx` | 21 | Role-based access (SUPER_ADMIN/GLOBAL_ADMIN/TENANT_ADMIN), config listing with dataType badges, type-aware editing (boolean select/JSON textarea/string input), save flow, reset, search/filter |
| `audio-page-config.test.ts` | 11 | resolvedConfig priority over tenant defaults, tenant fallback, timeout defaults, reset behavior, model ID normalization in resolved config |
| `user-settings-api.test.ts` | 9 | GET/PATCH /user/me/preferences, GET/PATCH /user/me/settings/:namespace/:key, upsert semantics, locked field mapping, error handling (401/500) |

**Key fixes during test implementation:**
1. `audio-store.test.ts` — Full rewrite from broken 95-line file to comprehensive 94-test suite. Fixed `getState is not a function` error, updated assertions for `whisper-tiny` prefix model IDs and TASK-244 configReady state.
2. `processing-config-panel.test.tsx` — Fixed `getSwitch` DOM traversal helper for the component's flex layout structure. Corrected config-ready gate test to match actual component behavior (Select controls disabled by `controlsDisabled`, switches only by `isCapturing || locked.*`). Fixed `getByText('Whisper Tiny')` ambiguity by scoping to SelectItem elements.
3. `useArcaConfig.test.ts` — Removed stale assertion for `noiseCancellation` and `voiceEmbedding` model types (removed in TASK-244 Task 0.4).

### Task 3.2 Implementation Summary (2026-03-10)

**Created:**
- `packages/stt/src/hooks/__tests__/useSTT.test.ts` — Processor recreation on model change (D2 regression test). Mocks STTProcessor, verifies `destroy()` called when `features.modelId` changes.
- `apps/ui-playground/src/store/__tests__/audio-store.test.ts` — Config-ready gate (D3), reset clears config, model ID normalization (bare `tiny` → `whisper-tiny`).

**Modified:**
- `packages/stt/package.json` — Added `@testing-library/react` devDependency.

**Test results:**
- useSTT: 1 test passes (processor recreation)
- audio-store: 5 tests pass (configReady initial false, configReady after applyTenantDefaults, reset clears config, whisperModel returns to default, model ID normalization)

### Task 1.3 Implementation Summary (2026-03-10)

**Created:**
- `apps/api/src/modules/user/controllers/user-preferences.controller.ts` — GET/PATCH `/user/me/preferences` (typed SDK preferences via UserPreferencesService)
- `apps/api/src/modules/user/controllers/user-settings.controller.ts` — GET `/user/me/settings`, PATCH `/user/me/settings/:namespace/:key` (raw key-value settings)
- `packages/applications/src/services/user/userSettings/dto/updateUserSettingByKey.request.ts` — DTO for PATCH settings body

**Modified:**
- `packages/applications/src/services/user/userSettings/IUserSettingsService.ts` — added `fetchAllByUserId`, `upsertByUserKeyNamespace`
- `packages/applications/src/services/user/userSettings/userSettings.service.ts` — implemented new methods
- `packages/applications/src/services/user/userSettings/dto/index.ts` — export UpdateUserSettingByKeyRequest
- `apps/api/src/modules/user/user.module.ts` — registered UserPreferencesController, UserSettingsController, UserPreferencesServiceModule, UserSettingsServiceModule

**Endpoints added:**
| Method | Path | Description |
|--------|------|--------------|
| GET | `/api/v1/user/me/preferences` | Returns typed user preferences (namespace: arcaai-sdk) |
| PATCH | `/api/v1/user/me/preferences` | Updates preferences (partial body) |
| GET | `/api/v1/user/me/settings` | Returns all settings for current user |
| PATCH | `/api/v1/user/me/settings/:namespace/:key` | Updates a specific setting by namespace and key |
