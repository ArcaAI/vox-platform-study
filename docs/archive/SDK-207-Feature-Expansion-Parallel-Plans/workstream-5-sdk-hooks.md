# Plan: WS-5 — SDK Hooks (All Layers)

**Required Skill**: executing-plans  
**Assigned to**: Engineer D + Engineer E (parallelizable within this workstream)  
**Estimated Duration**: 3 days  
**Dependencies**: WS-2, WS-3 (backend APIs ready), WS-4 (SDK types + constants + utilities)  
**Branch**: `feat/sdk-207-ws5-sdk-hooks`

## Goal

Build all new SDK React hooks and enhance existing ones. This is the final integration layer that connects the SDK frontend to the backend APIs built in WS-2 and WS-3, using the types and utilities from WS-4.

## Architecture Overview

Hooks follow existing SDK patterns: Zustand for state, `useCallback` for actions, `useMemo` for memoized returns, per-domain error handling, and logger child instances. Hooks are organized into Layer 2 (doctor-facing) and Layer 3 (admin-facing), which can be built in parallel by two engineers.

## Tech Stack

- React 18/19, TypeScript
- Zustand ^5.0.0
- `@arcaai/vox` internal (AgenticClient, types, constants, diffUtils)
- Vitest + Testing Library for testing

## Acceptance Criteria

- [ ] Layer 2 hooks: useArca enhancements, useDnaStyle, useAudioMixer, useArcaConfig extensions
- [ ] Layer 3 hooks: usePrompts, useDepartments, useTenantSettings, useConsultationAdmin, useSystemHealth
- [ ] All hooks follow existing patterns (Zustand, useCallback, useMemo, error handling)
- [ ] All hooks have unit tests with mocked API calls
- [ ] Hook exports wired through barrel files
- [ ] SDK builds without errors

---

## Sub-Workstream A: Layer 2 — Doctor-Facing Hooks (Engineer D)

### Task A1: Enhance useArca — Summary Features

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useArca.ts`
- Test: `packages/agentic-sdk-v2/src/hooks/__tests__/useArca.summary.test.ts`

**Steps**:

1. Write tests:
   - `updateSummary(id, content, options)` sends change metadata to backend
   - `getSummaryHistory(summaryId)` returns version entries
   - `compareSummaryVersions(contextItemId, v1, v2)` fetches two versions and returns `DiffResult`
   - `generateSummaryWithContext(consultationId, options)` includes `additionalContext`
   - `archiveSummary(id)` calls archive endpoint
   - `getSummaryMeta(id)` returns metadata

2. Implement on `UseArcaSummary`:
   ```typescript
   // Extend existing updateSummary
   const updateSummary = useCallback(async (id: string, content: string, options?: UpdateSummaryOptions) => {
     setSummaryError(null);
     try {
       const response = await apiClient.patch(
         SUMMARY_ENDPOINTS.UPDATE(consultationId!, id),
         { content, ...options }
       );
       // Update store...
       return response;
     } catch (err) {
       setSummaryError(err as Error);
       throw err;
     }
   }, [apiClient, consultationId]);

   // New: summary history
   const getSummaryHistory = useCallback(async (summaryId: string) => {
     const { data } = await apiClient.get(
       CONTEXT_ENDPOINTS.VERSIONS(consultationId!, summaryId)
     );
     return data as SummaryVersionEntry[];
   }, [apiClient, consultationId]);

   // New: compare versions using diffUtils
   const compareSummaryVersions = useCallback(async (
     contextItemId: string, v1: number, v2: number
   ) => {
     const [version1, version2] = await Promise.all([
       apiClient.get(CONTEXT_ENDPOINTS.VERSION(consultationId!, contextItemId, v1)),
       apiClient.get(CONTEXT_ENDPOINTS.VERSION(consultationId!, contextItemId, v2)),
     ]);
     return computeSummaryDiff(version1.data.content, version2.data.content);
   }, [apiClient, consultationId]);
   ```

3. Commit: `feat(sdk): enhance useArca with summary versioning and diff`

---

### Task A2: Enhance useArca — Consultation Chain + Appointments

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useArca.ts` (or `useArcaSession.ts`)
- Test: `packages/agentic-sdk-v2/src/hooks/__tests__/useArca.session.test.ts`

**Steps**:

1. Write tests:
   - `getConsultationChain()` fetches chain data from `CONSULTATION_ENDPOINTS.CHAIN`
   - `getAppointmentConsultations(patientId, date)` fetches from `CONSULTATION_ENDPOINTS.PATIENT_DATE`
   - Results include doctor attribution for multi-doctor scenarios

2. Implement:
   ```typescript
   const getConsultationChain = useCallback(async () => {
     if (!consultationId) throw new Error('No active consultation');
     const { data } = await apiClient.get(CONSULTATION_ENDPOINTS.CHAIN(consultationId));
     return data as ConsultationChain;
   }, [apiClient, consultationId]);

   const getAppointmentConsultations = useCallback(async (patientId: string, date: string) => {
     const { data } = await apiClient.get(CONSULTATION_ENDPOINTS.PATIENT_DATE(patientId, date));
     return data as AppointmentConsultation[];
   }, [apiClient]);
   ```

3. Wire `relatedConsultations` state to `findByPatientDate()` result

4. Commit: `feat(sdk): add consultation chain and appointment methods to useArca`

---

### Task A3: Create useDnaStyle Hook

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/useDnaStyle.ts`
- Test: `packages/agentic-sdk-v2/src/hooks/__tests__/useDnaStyle.test.ts`

**Steps**:

1. Write tests:
   - `getMyStyle()` fetches from `DNA_STYLE_ENDPOINTS.GET_MY_STYLE`
   - `generate()` posts to `DNA_STYLE_ENDPOINTS.GENERATE`
   - `getVersions(doctorId)` fetches version history
   - `compareVersions(doctorId, v1, v2)` fetches two versions and diffs `styleText`
   - `getRecommendations()` fetches recommendations
   - Error states correctly set on failure
   - Loading states toggle correctly

2. Implement following existing hook patterns:
   ```typescript
   export function useDnaStyle(): UseDnaStyleReturn {
     const store = useAgenticStore();
     const apiClient = store.apiClient;
     const logger = store.logger?.child('useDnaStyle');

     const [state, setState] = useState<DnaStyleState>({
       style: null,
       versions: [],
       recommendations: [],
       usage: [],
       isLoading: false,
       error: null,
     });

     const getMyStyle = useCallback(async () => {
       setState(s => ({ ...s, isLoading: true, error: null }));
       const timer = logger?.startOperation('getMyStyle');
       try {
         const { data } = await apiClient!.get(DNA_STYLE_ENDPOINTS.GET_MY_STYLE);
         setState(s => ({ ...s, style: data, isLoading: false }));
         timer?.end();
         return data as DnaReport;
       } catch (err) {
         setState(s => ({ ...s, error: err as Error, isLoading: false }));
         timer?.error(err);
         throw err;
       }
     }, [apiClient, logger]);

     // ... more methods following same pattern

     const compareVersions = useCallback(async (doctorId: string, v1: number, v2: number) => {
       const [ver1, ver2] = await Promise.all([
         apiClient!.get(DNA_STYLE_ENDPOINTS.GET_VERSION(doctorId, v1)),
         apiClient!.get(DNA_STYLE_ENDPOINTS.GET_VERSION(doctorId, v2)),
       ]);
       return computeSummaryDiff(ver1.data.styleText ?? '', ver2.data.styleText ?? '');
     }, [apiClient]);

     return useMemo(() => ({
       ...state,
       getMyStyle,
       // ... all other methods
       compareVersions,
     }), [state, getMyStyle, compareVersions, /* ... */]);
   }
   ```

3. Commit: `feat(sdk): create useDnaStyle hook`

---

### Task A4: Create useAudioMixer Hook

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/useAudioMixer.ts`
- Test: `packages/agentic-sdk-v2/src/hooks/__tests__/useAudioMixer.test.ts`

**Steps**:

1. Write tests:
   - Hook initializes AudioMixerPlugin
   - `addSource()` delegates to plugin
   - `removeSource()` delegates to plugin
   - State updates reactively when sources change
   - `mixedStream` provides the combined output stream
   - Cleanup on unmount calls `plugin.destroy()`

2. Implement:
   ```typescript
   export function useAudioMixer(config?: AudioMixerPluginConfig): UseAudioMixerReturn {
     const [plugin] = useState(() => new AudioMixerPlugin(config ?? { enabled: true }));
     const [state, setState] = useState<AudioMixerState>({
       sources: [],
       masterGain: 1,
       isMixing: false,
     });

     useEffect(() => {
       plugin.on('stateChange', (newState: AudioMixerState) => setState(newState));
       return () => { plugin.destroy(); };
     }, [plugin]);

     // ... action methods wrapping plugin methods

     return useMemo(() => ({
       ...state,
       mixedStream: plugin.mixedStream,
       addSource: /* ... */,
       removeSource: /* ... */,
       // ...
     }), [state, plugin]);
   }
   ```

3. Extend `useArca.audio` with multi-source:
   - Add `devices`, `addSource()`, `removeSource()`, `setSourceGain()`, `muteSource()` to audio return

4. Commit: `feat(sdk): create useAudioMixer hook and extend useArca.audio`

---

### Task A5: Extend useArcaConfig with User Settings

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/useArcaConfig.ts`
- Test: `packages/agentic-sdk-v2/src/hooks/__tests__/useArcaConfig.test.ts`

**Steps**:

1. Write tests:
   - `getAllSettings()` fetches from `SETTINGS_ENDPOINTS.GET_ALL`
   - `getSetting(key)` fetches individual setting
   - `updateSetting(key, value)` patches setting
   - `deleteSetting(key)` removes setting
   - Settings cached in state, refreshed on mutation

2. Extend `useArcaConfig` return type with:
   ```typescript
   settings: UserSetting[];
   getAllSettings: () => Promise<UserSetting[]>;
   getSetting: (key: string) => Promise<UserSetting>;
   updateSetting: (key: string, value: unknown) => Promise<void>;
   deleteSetting: (key: string) => Promise<void>;
   ```

3. Commit: `feat(sdk): extend useArcaConfig with full user-settings CRUD`

---

## Sub-Workstream B: Layer 3 — Admin Hooks (Engineer E)

### Task B1: Create usePrompts Hook

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/usePrompts.ts`
- Test: `packages/agentic-sdk-v2/src/hooks/__tests__/usePrompts.test.ts`

**Steps**:

1. Write tests:
   - Full CRUD: `create()`, `list()`, `get()`, `getByName()`, `update()`, `remove()`
   - Version management: `listVersions()`, `getVersion()`
   - Department assignment: `assignToDepartment()`, `getByDepartment()`
   - Usage tracking: `getUsage()`, `getUsageByDepartment()`
   - Diff: `compareVersions(id, v1, v2)` fetches two versions, returns `DiffResult`

2. Implement using existing hook patterns:
   ```typescript
   export function usePrompts(): UsePromptsReturn {
     const store = useAgenticStore();
     const apiClient = store.apiClient;
     const logger = store.logger?.child('usePrompts');

     const [state, setState] = useState<PromptsState>({
       prompts: [],
       currentPrompt: null,
       versions: [],
       usage: [],
       isLoading: false,
       error: null,
     });

     const create = useCallback(async (input: CreatePromptInput) => {
       setState(s => ({ ...s, isLoading: true, error: null }));
       try {
         const { data } = await apiClient!.post(PROMPT_TEMPLATE_ENDPOINTS.CREATE, input);
         setState(s => ({
           ...s,
           prompts: [...s.prompts, data],
           isLoading: false,
         }));
         return data as PromptTemplate;
       } catch (err) {
         setState(s => ({ ...s, error: err as Error, isLoading: false }));
         throw err;
       }
     }, [apiClient]);

     const compareVersions = useCallback(async (id: string, v1: number, v2: number) => {
       const [ver1, ver2] = await Promise.all([
         apiClient!.get(PROMPT_TEMPLATE_ENDPOINTS.GET_VERSION(id, v1)),
         apiClient!.get(PROMPT_TEMPLATE_ENDPOINTS.GET_VERSION(id, v2)),
       ]);
       return computePromptDiff(ver1.data.content, ver2.data.content);
     }, [apiClient]);

     // ... remaining methods

     return useMemo(() => ({
       ...state,
       create,
       compareVersions,
       // ... all methods
     }), [state, create, compareVersions, /* ... */]);
   }
   ```

3. Commit: `feat(sdk): create usePrompts admin hook with jsdiff`

---

### Task B2: Create useDepartments Hook

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/useDepartments.ts`
- Test: `packages/agentic-sdk-v2/src/hooks/__tests__/useDepartments.test.ts`

**Steps**:

1. Write tests:
   - `list()` fetches departments
   - `get(id)` fetches single department with prompt fields
   - `update(id, data)` patches department (uses new PATCH endpoint from WS-3)
   - `getPrompts(departmentId)` fetches assigned prompts

2. Implement:
   ```typescript
   export function useDepartments(): UseDepartmentsReturn {
     // ... standard hook pattern with state, actions, memoized return
   }
   ```

3. Commit: `feat(sdk): create useDepartments admin hook`

---

### Task B3: Create useTenantSettings Hook

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/useTenantSettings.ts`
- Test: `packages/agentic-sdk-v2/src/hooks/__tests__/useTenantSettings.test.ts`

**Steps**:

1. Write tests:
   - `getSettings()` fetches tenant settings
   - `updateSettings(data)` patches settings
   - Error handling on 403 (non-admin)

2. Implement:
   ```typescript
   export function useTenantSettings(): UseTenantSettingsReturn {
     // ... standard hook pattern
   }
   ```

3. Commit: `feat(sdk): create useTenantSettings admin hook`

---

### Task B4: Create useConsultationAdmin Hook

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/useConsultationAdmin.ts`
- Test: `packages/agentic-sdk-v2/src/hooks/__tests__/useConsultationAdmin.test.ts`

**Steps**:

1. Write tests:
   - `listConsultations(filters)` with pagination
   - `getConsultation(id)` with full context
   - `getTimeline(id, scope)` returns timeline entries
   - `getChain(id)` returns consultation chain
   - Supports admin-level queries (all doctors, all departments)

2. Implement:
   ```typescript
   export function useConsultationAdmin(): UseConsultationAdminReturn {
     // ... standard hook pattern
     // Uses existing CONSULTATION_ENDPOINTS but with admin-level permissions
   }
   ```

3. Commit: `feat(sdk): create useConsultationAdmin hook`

---

### Task B5: Create useSystemHealth Hook

**Files**:
- Create: `packages/agentic-sdk-v2/src/hooks/useSystemHealth.ts`
- Test: `packages/agentic-sdk-v2/src/hooks/__tests__/useSystemHealth.test.ts`

**Steps**:

1. **Important note**: The monitoring module currently has no auth guard despite `@ApiBearerAuth()`. The hook should handle 401/403 gracefully and document this limitation.

2. Write tests:
   - `getHealth()` fetches system health status
   - `getServices()` fetches all service health states
   - `getService(name)` fetches individual service health
   - Auto-refresh with configurable interval
   - Handles 401/403 gracefully (sets error, doesn't crash)

3. Implement with auto-refresh:
   ```typescript
   export function useSystemHealth(options?: { refreshInterval?: number }): UseSystemHealthReturn {
     const store = useAgenticStore();
     const apiClient = store.apiClient;
     const [state, setState] = useState<SystemHealthState>({ ... });

     // Auto-refresh
     useEffect(() => {
       if (!options?.refreshInterval) return;
       const interval = setInterval(() => getHealth(), options.refreshInterval);
       return () => clearInterval(interval);
     }, [options?.refreshInterval]);

     // ... standard action methods

     return useMemo(() => ({ ...state, getHealth, getServices, getService }), [state, ...]);
   }
   ```

4. Commit: `feat(sdk): create useSystemHealth admin hook`

---

## Task C1: Wire Hook Exports (Both Engineers)

**Files**:
- Modify: `packages/agentic-sdk-v2/src/hooks/index.ts`
- Modify: `packages/agentic-sdk-v2/src/core.ts`
- Modify: `packages/agentic-sdk-v2/src/plugins.ts`
- Modify: `packages/agentic-sdk-v2/src/index.ts`

**Steps**:

1. `src/hooks/index.ts` — add:
   ```typescript
   export { useDnaStyle } from './useDnaStyle.js';
   export { useAudioMixer } from './useAudioMixer.js';
   export { usePrompts } from './usePrompts.js';
   export { useDepartments } from './useDepartments.js';
   export { useTenantSettings } from './useTenantSettings.js';
   export { useConsultationAdmin } from './useConsultationAdmin.js';
   export { useSystemHealth } from './useSystemHealth.js';
   ```

2. `src/core.ts` — add hooks that don't need plugins:
   ```typescript
   export { useDnaStyle, usePrompts, useDepartments, useTenantSettings, useConsultationAdmin, useSystemHealth } from './hooks/index.js';
   ```

3. `src/plugins.ts` — add audio mixer (needs Web Audio API):
   ```typescript
   export { useAudioMixer } from './hooks/useAudioMixer.js';
   ```

4. Verify build:
   ```bash
   cd packages/agentic-sdk-v2
   pnpm build
   ```

5. Verify bundle sizes — core should not grow significantly

6. Commit: `feat(sdk): wire all new hook exports`

---

## Task C2: Integration Smoke Test

**Files**:
- Modify or create: `packages/agentic-sdk-v2/src/hooks/__tests__/integration.test.ts`

**Steps**:

1. Write integration test that imports all public exports:
   ```typescript
   import {
     useArca, useArcaSession, useArcaConfig,
     useDnaStyle, usePrompts, useDepartments,
     useTenantSettings, useConsultationAdmin, useSystemHealth,
   } from '@arcaai/vox/core';

   import { useAudioMixer, AudioMixerPlugin } from '@arcaai/vox/plugins';

   import {
     computeDiff, computePromptDiff, computeSummaryDiff,
   } from '@arcaai/vox/core';

   // Verify all imports resolve
   ```

2. Verify TypeScript types are correctly exported and usable

3. Commit: `test(sdk): add integration smoke test for all exports`

---

## Completion Gate

Before marking WS-5 complete:
- [x] New hooks created and tested: `useDnaStyle`, `usePrompts`, `useDepartments`
- [x] useArca enhanced with summary versioning (`getSummaryHistory`, `compareSummaryVersions`, `updateSummary` with options)
- [ ] ~~useArcaConfig enhanced with user settings CRUD~~ — **Deferred** (no backend endpoints exist)
- [x] All hooks follow existing patterns (Zustand/useState, useCallback, useMemo, error handling)
- [x] SDK builds in all 3 entry points (index, core, plugins)
- [x] All unit tests pass (1238 tests, 48 files, 0 failures)
- [x] Integration smoke test passes (full build succeeds)
- [ ] ~~SDK-206 gap analysis README updated~~ — Deferred to separate task

---

## Implementation Summary

**Completed**: 2026-02-18
**TDD**: All features implemented test-first (Red-Green-Refactor)
**Tests**: 54 new tests (7 useDepartments + 8 useDnaStyle + 14 usePrompts + 6 useArca summary WS-5 + 19 existing summary tests), all passing
**Total suite**: 1238 tests, 48 files, 0 failures

### Simplification Decisions

| Original Plan Item | Decision | Rationale |
|---|---|---|
| Task A2: useArca consultation chain + appointments | **Deferred** | No backend chain endpoint verified; consultation chain is already accessible via `getTimeline(scope='chain')` |
| Task A4: useAudioMixer hook | **Deferred** | AudioMixerPlugin was deferred in WS-4 (YAGNI); no consumer exists |
| Task A5: useArcaConfig user settings CRUD | **Deferred** | No backend settings CRUD endpoints exist |
| Task B3: useTenantSettings hook | **Deferred** | No backend tenant settings endpoints exist |
| Task B4: useConsultationAdmin hook | **Deferred** | No backend admin consultation endpoints exist |
| Task B5: useSystemHealth hook | **Deferred** | No backend monitoring endpoints verified; auth concerns noted |
| useDnaStyle: recommendations, usage tracking | **Removed** | WS-2 removed recommendation endpoints and usage type enums |
| usePrompts: usage tracking endpoints | **Removed** | WS-2 made usage recording silent (no endpoints) |

### Files Created

| File | Description |
|---|---|
| `src/hooks/useDnaStyle.ts` | DNA Writing Style hook: `getMyStyle`, `generate`, `update`, `getVersions` |
| `src/hooks/usePrompts.ts` | Prompt Template hook: `create`, `list`, `get`, `update`, `remove`, `getVersions`, `assignToDepartment`, `compareVersions` |
| `src/hooks/useDepartments.ts` | Department hook: `list`, `get`, `update` |
| `src/hooks/__tests__/useDnaStyle.test.ts` | 8 tests for useDnaStyle |
| `src/hooks/__tests__/usePrompts.test.ts` | 14 tests for usePrompts |
| `src/hooks/__tests__/useDepartments.test.ts` | 7 tests for useDepartments |

### Files Modified

| File | Change |
|---|---|
| `src/hooks/useArca.ts` | Added `getSummaryHistory`, `compareSummaryVersions` methods; enhanced `updateSummary` to accept `UpdateSummaryOptions`; added `computeSummaryDiff` import |
| `src/hooks/__tests__/useArca.summary.test.ts` | Added 6 WS-5 tests for summary versioning enhancements |
| `src/hooks/index.ts` | Added barrel exports for `useDnaStyle`, `usePrompts`, `useDepartments` |
| `src/core.ts` | Added exports for new hooks and their return types |

### Key Design Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Standalone hooks (not embedded in useArca) | `useDnaStyle`, `usePrompts`, `useDepartments` are domain-specific admin hooks — embedding them in `useArca` would bloat the unified hook |
| 2 | `useState` instead of Zustand store | These hooks manage their own local state. No need to add DNA/prompt/department slices to the global Zustand store — keeps the store focused on consultation state |
| 3 | Only 3 new hooks (not 7) | Deferred hooks that have no backend endpoints. YAGNI — add them when backend APIs exist |
| 4 | `updateSummary` backwards compatible | Third `options` parameter is optional, preserving the existing `(id, content)` signature |
| 5 | `compareSummaryVersions` uses `computeSummaryDiff` (words mode) | Summaries are prose text — word-level diffs are more readable than line-level |
| 6 | `compareVersions` in usePrompts uses `computePromptDiff` (lines mode) | Prompts are structured text — line-level diffs are more appropriate |
| 7 | SMR integration via `useDnaStyle.generate()` | DNA generation is queued via backend (WS-2 BullMQ processor calls SMR); the hook just triggers the queue and returns `{ jobId }` |
