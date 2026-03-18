# Plan: WS-4 — SDK Types, Plugins, and Utilities

**Required Skill**: executing-plans  
**Assigned to**: Engineer D  
**Estimated Duration**: 2 days  
**Dependencies**: NONE — can start immediately in parallel with WS-1  
**Branch**: `feat/sdk-207-ws4-sdk-foundation`

## Goal

Build the SDK foundation layer: all new TypeScript types, endpoint constants, AudioMixerPlugin, and jsdiff utilities. These have zero backend dependency and provide the building blocks that WS-5 (SDK hooks) will consume.

## Architecture Overview

The SDK (`@arcaai/vox`) follows a layered architecture: types → constants → utilities/plugins → hooks. This workstream builds everything except the hooks. All new code follows existing patterns: PascalCase interfaces, `*_ENDPOINTS` with `as const`, `useCallback`/`useMemo` in hooks, and Zustand for state.

## Tech Stack

- TypeScript, React 18/19
- Zustand ^5.0.0
- Web Audio API (for AudioMixerPlugin)
- `diff` npm package (for jsdiff utilities)
- Vitest for testing

## Acceptance Criteria

- [ ] 5 new type files: `admin.ts`, `dna.ts`, `prompt.ts`, `settings.ts`, `diff.ts`
- [ ] Existing type files extended: `audio.ts`, `summary.ts`, `consultation.ts`, `config.ts`
- [ ] New endpoint constants: `DNA_STYLE_ENDPOINTS`, `PROMPT_TEMPLATE_ENDPOINTS`, `ADMIN_ENDPOINTS`, `SETTINGS_ENDPOINTS`
- [ ] Deprecated `DNA_ENDPOINTS` replaced by `DNA_STYLE_ENDPOINTS`
- [ ] `AudioMixerPlugin` with Web Audio API mixing logic
- [ ] `diffUtils.ts` with `computeDiff`, `computePromptDiff`, `computeSummaryDiff`
- [ ] `diff` package added to `package.json`
- [ ] All exports wired through barrel files
- [ ] All new code has unit tests

---

## Task 1: Create New Type Files — `dna.ts`

**Files**:
- Create: `packages/agentic-sdk-v2/src/types/dna.ts`
- Test: `packages/agentic-sdk-v2/src/types/__tests__/dna.test.ts`

**Steps**:

1. **Important**: Existing types `DNAStyle` and `DNAStyleData` exist in `summary.ts`. The new `dna.ts` should reference/extend these, not duplicate them.

2. Create types:
   ```typescript
   import type { DNAStyle, DNAStyleData } from './summary.js';

   // Extends existing DNAStyle with full report metadata
   export interface DnaReport {
     id: string;
     doctorId: string;
     departmentId?: string;
     reportData: DnaReportData;
     styleText?: string;
     promptId?: string;
     sourceType: DnaSourceType;
     sampleCount: number;
     currentVersionNumber: number;
     isLatest: boolean;
     createdAt: string;
     updatedAt: string;
   }

   export interface DnaReportData extends DNAStyleData {
     // Extended fields from the full report
     patterns?: string[];
     preferences?: Record<string, unknown>;
     metrics?: Record<string, number>;
   }

   export type DnaSourceType = 'DOCTOR' | 'DEPARTMENT';

   export interface DnaStyleVersion {
     id: string;
     reportId: string;
     versionNumber: number;
     reportData: DnaReportData;
     styleText?: string;
     sampleCount: number;
     changeReason?: string;
     changeSummary?: string;
     changedBy?: string;
     createdAt: string;
   }

   export interface DnaUsageRecord {
     id: string;
     reportId: string;
     doctorId: string;
     consultationId?: string;
     contextItemId?: string;
     usageType: DnaUsageType;
     dnaVersion?: number;
     usedAt: string;
   }

   export type DnaUsageType = 'SUMMARY_GENERATION' | 'PRE_SUMMARY' | 'COMPREHENSIVE';

   export interface DnaRecommendation {
     type: 'regeneration' | 'update' | 'review';
     reason: string;
     severity: 'low' | 'medium' | 'high';
     editedSummaryCount: number;
     styleDriftScore?: number;
   }

   // Input types
   export interface DnaGenerateInput {
     textSamples?: string[];
     departmentId?: string;
   }

   export interface DnaUpdateInput {
     reportData?: Partial<DnaReportData>;
     styleText?: string;
     changeReason?: string;
   }

   // State and actions for useDnaStyle hook
   export interface DnaStyleState {
     style: DnaReport | null;
     versions: DnaStyleVersion[];
     recommendations: DnaRecommendation[];
     usage: DnaUsageRecord[];
     isLoading: boolean;
     error: Error | null;
   }

   export interface DnaStyleActions {
     getMyStyle: () => Promise<DnaReport>;
     getStyle: (doctorId: string) => Promise<DnaReport>;
     generate: (input?: DnaGenerateInput) => Promise<DnaReport>;
     getVersions: (doctorId: string) => Promise<DnaStyleVersion[]>;
     getVersion: (doctorId: string, version: number) => Promise<DnaStyleVersion>;
     getRecommendations: () => Promise<DnaRecommendation[]>;
     getMyUsage: () => Promise<DnaUsageRecord[]>;
     generateForDoctor: (doctorId: string) => Promise<DnaReport>;
   }
   ```

3. Write type tests (compile-time checks):
   - Verify interface compatibility with existing `DNAStyle`
   - Verify all fields have correct types

4. Commit: `feat(sdk): add DNA writing style types`

---

## Task 2: Create New Type Files — `prompt.ts`

**Files**:
- Create: `packages/agentic-sdk-v2/src/types/prompt.ts`
- Test: `packages/agentic-sdk-v2/src/types/__tests__/prompt.test.ts`

**Steps**:

1. Create types matching backend DTOs:
   ```typescript
   export interface PromptTemplate {
     id: string;
     name: string;
     displayName?: string;
     description?: string;
     category: PromptTemplateCategory;
     departmentId?: string;
     content: string;
     variables?: PromptVariable[];
     isDefault: boolean;
     isActive: boolean;
     currentVersionNumber: number;
     createdAt: string;
     updatedAt: string;
   }

   export type PromptTemplateCategory =
     | 'NEW_VISIT' | 'REVISIT' | 'PRE_SUMMARY'
     | 'DNA_ANALYSIS' | 'COMPREHENSIVE' | 'CUSTOM';

   export interface PromptVariable {
     name: string;
     type: 'string' | 'number' | 'boolean' | 'json';
     required: boolean;
     default?: unknown;
     description?: string;
   }

   export interface PromptVersion {
     id: string;
     promptTemplateId: string;
     versionNumber: number;
     content: string;
     variables?: PromptVariable[];
     changeReason?: string;
     changeSummary?: string;
     changedBy?: string;
     createdAt: string;
   }

   export interface PromptUsageRecord {
     id: string;
     promptTemplateId: string;
     promptVersionNumber?: number;
     departmentId?: string;
     doctorId?: string;
     consultationId?: string;
     usageType: PromptUsageType;
     usedAt: string;
   }

   export type PromptUsageType =
     | 'NEW_VISIT' | 'REVISIT' | 'PRE_SUMMARY' | 'DNA_ANALYSIS' | 'COMPREHENSIVE';

   // Input types
   export interface CreatePromptInput {
     name: string;
     displayName?: string;
     description?: string;
     category: PromptTemplateCategory;
     departmentId?: string;
     content: string;
     variables?: PromptVariable[];
     isDefault?: boolean;
   }

   export interface UpdatePromptInput {
     displayName?: string;
     description?: string;
     content?: string;
     variables?: PromptVariable[];
     isDefault?: boolean;
     isActive?: boolean;
     changeReason?: string;
     changeSummary?: string;
   }

   export interface AssignDepartmentPromptInput {
     departmentId: string;
     promptTemplateId: string;
     category: PromptTemplateCategory;
   }

   export interface PromptListFilters {
     category?: PromptTemplateCategory;
     departmentId?: string;
     isActive?: boolean;
     search?: string;
     page?: number;
     limit?: number;
   }
   ```

2. Commit: `feat(sdk): add Prompt Template types`

---

## Task 3: Create New Type Files — `admin.ts`, `settings.ts`, `diff.ts`

**Files**:
- Create: `packages/agentic-sdk-v2/src/types/admin.ts`
- Create: `packages/agentic-sdk-v2/src/types/settings.ts`
- Create: `packages/agentic-sdk-v2/src/types/diff.ts`

**Steps**:

1. `admin.ts` — types for admin hooks (tenant, monitoring, consultation admin):
   ```typescript
   export interface TenantSettings { ... }
   export interface SystemHealthStatus { ... }
   export interface ServiceHealth { name: string; status: 'up' | 'down' | 'degraded'; latencyMs?: number; }
   export interface ConsultationAdminFilters { ... }
   ```

2. `settings.ts` — types for full user-settings CRUD:
   ```typescript
   export interface UserSetting { key: string; value: unknown; namespace: string; }
   export interface UpdateSettingInput { key: string; value: unknown; }
   export interface SettingsState { ... }
   export interface SettingsActions { ... }
   ```

3. `diff.ts` — types for jsdiff results:
   ```typescript
   export interface DiffChange {
     value: string;
     added?: boolean;
     removed?: boolean;
     count?: number;
   }

   export interface DiffResult {
     changes: DiffChange[];
     patch: string;
     stats: DiffStats;
   }

   export interface DiffStats {
     additions: number;
     deletions: number;
     unchanged: number;
   }

   export type DiffMode = 'lines' | 'words' | 'chars';
   ```

4. Commit: `feat(sdk): add admin, settings, and diff types`

---

## Task 4: Extend Existing Type Files

**Files**:
- Modify: `packages/agentic-sdk-v2/src/types/audio.ts`
- Modify: `packages/agentic-sdk-v2/src/types/summary.ts`
- Modify: `packages/agentic-sdk-v2/src/types/consultation.ts`
- Modify: `packages/agentic-sdk-v2/src/types/config.ts`

**Steps**:

1. `audio.ts` — add multi-source types:
   ```typescript
   export interface AudioSource {
     id: string;
     label: string;
     stream: MediaStream;
     gain: number;
     muted: boolean;
   }

   export interface AudioMixerState {
     sources: AudioSource[];
     masterGain: number;
     isMixing: boolean;
   }

   export interface AudioMixerActions {
     addSource: (source: Omit<AudioSource, 'gain' | 'muted'>) => void;
     removeSource: (sourceId: string) => void;
     setSourceGain: (sourceId: string, gain: number) => void;
     muteSource: (sourceId: string) => void;
     unmuteSource: (sourceId: string) => void;
     setMasterGain: (gain: number) => void;
   }
   ```

2. `summary.ts` — add versioning types:
   ```typescript
   export interface UpdateSummaryOptions {
     changeReason?: string;
     changeSummary?: string;
     changeSource?: 'doctor_edit' | 'ai_regeneration' | 'system';
   }

   export interface SummaryVersionEntry {
     id: string;
     contextItemId: string;
     versionNumber: number;
     content: string;
     changeReason?: string;
     changeSource?: string;
     changedBy?: string;
     createdAt: string;
   }

   export interface SummaryMeta {
     id: string;
     type: string;
     versionNumber: number;
     status: string;
     createdAt: string;
     updatedAt: string;
   }
   ```

3. `consultation.ts` — add chain and appointment types:
   ```typescript
   export interface ConsultationChain {
     rootConsultationId: string;
     consultations: Consultation[];
     totalCount: number;
   }

   export interface AppointmentConsultation extends Consultation {
     doctorId: string;
     doctorName?: string;
     departmentName?: string;
   }
   ```

4. `config.ts` — add AudioMixerPluginConfig:
   ```typescript
   export interface AudioMixerPluginConfig {
     enabled: boolean;
     maxSources?: number;
     defaultGain?: number;
   }
   ```

5. Commit: `feat(sdk): extend existing types with versioning, chain, and audio mixer`

---

## Task 5: Add New Endpoint Constants

**Files**:
- Modify: `packages/agentic-sdk-v2/src/core/constants.ts`

**Steps**:

1. Add `DNA_STYLE_ENDPOINTS` (replaces deprecated `DNA_ENDPOINTS`):
   ```typescript
   export const DNA_STYLE_ENDPOINTS = {
     GENERATE: '/dna-styles/generate',
     GENERATE_FOR_DOCTOR: (doctorId: string) => `/dna-styles/generate/${doctorId}`,
     GET_MY_STYLE: '/dna-styles/me',
     GET_STYLE: (doctorId: string) => `/dna-styles/${doctorId}`,
     GET_VERSIONS: (doctorId: string) => `/dna-styles/${doctorId}/versions`,
     GET_VERSION: (doctorId: string, version: number) => `/dna-styles/${doctorId}/versions/${version}`,
     UPDATE: (reportId: string) => `/dna-styles/${reportId}`,
     RECOMMENDATIONS: (doctorId: string) => `/dna-styles/${doctorId}/recommendations`,
     USAGE: '/dna-styles/usage',
     MY_USAGE: '/dna-styles/usage/me',
   } as const;
   ```

2. Add `PROMPT_TEMPLATE_ENDPOINTS`:
   ```typescript
   export const PROMPT_TEMPLATE_ENDPOINTS = {
     CREATE: '/prompt-templates',
     LIST: '/prompt-templates',
     GET: (id: string) => `/prompt-templates/${id}`,
     GET_BY_NAME: (name: string) => `/prompt-templates/name/${name}`,
     UPDATE: (id: string) => `/prompt-templates/${id}`,
     DELETE: (id: string) => `/prompt-templates/${id}`,
     LIST_VERSIONS: (id: string) => `/prompt-templates/${id}/versions`,
     GET_VERSION: (id: string, version: number) => `/prompt-templates/${id}/versions/${version}`,
     ASSIGN_DEPARTMENT: '/prompt-templates/assign-department',
     BY_DEPARTMENT: (deptId: string) => `/prompt-templates/by-department/${deptId}`,
     USAGE: '/prompt-templates/usage',
     USAGE_BY_DEPARTMENT: (deptId: string) => `/prompt-templates/usage/by-department/${deptId}`,
   } as const;
   ```

3. Add `CONSULTATION_ENDPOINTS.CHAIN`:
   ```typescript
   CHAIN: (consultationId: string) => `/consultations/${consultationId}/chain`,
   ```

4. Add `DEPARTMENT_ENDPOINTS`:
   ```typescript
   export const DEPARTMENT_ENDPOINTS = {
     LIST: '/departments',
     GET: (id: string) => `/departments/${id}`,
     UPDATE: (id: string) => `/departments/${id}`,
     GET_PROMPTS: (id: string) => `/departments/${id}/prompts`,
   } as const;
   ```

5. Add `SETTINGS_ENDPOINTS`:
   ```typescript
   export const SETTINGS_ENDPOINTS = {
     GET_ALL: '/users/me/settings',
     GET: (key: string) => `/users/me/settings/${key}`,
     UPDATE: (key: string) => `/users/me/settings/${key}`,
     DELETE: (key: string) => `/users/me/settings/${key}`,
   } as const;
   ```

6. Add `MONITORING_ENDPOINTS`:
   ```typescript
   export const MONITORING_ENDPOINTS = {
     HEALTH: '/monitoring/health',
     SERVICES: '/monitoring/services',
     SERVICE: (name: string) => `/monitoring/services/${name}`,
   } as const;
   ```

7. Add `TENANT_ENDPOINTS`:
   ```typescript
   export const TENANT_ENDPOINTS = {
     GET_SETTINGS: '/tenant/settings',
     UPDATE_SETTINGS: '/tenant/settings',
   } as const;
   ```

8. Commit: `feat(sdk): add new endpoint constants for all feature modules`

---

## Task 6: Add `diff` Dependency and Create `diffUtils.ts`

**Files**:
- Modify: `packages/agentic-sdk-v2/package.json` (add `diff` dependency)
- Create: `packages/agentic-sdk-v2/src/utils/diffUtils.ts`
- Test: `packages/agentic-sdk-v2/src/utils/__tests__/diffUtils.test.ts`

**Steps**:

1. Add dependency:
   ```bash
   cd packages/agentic-sdk-v2
   pnpm add diff
   pnpm add -D @types/diff
   ```

2. Write tests first:
   - `computeDiff('hello', 'hello world', 'words')` returns correct changes with 1 addition
   - `computeDiff('line1\nline2', 'line1\nline3', 'lines')` returns 1 deletion + 1 addition
   - `computePromptDiff(old, new)` uses lines mode by default
   - `computeSummaryDiff(old, new)` uses words mode by default
   - `createUnifiedPatch(...)` returns valid unified diff string
   - Stats correctly count additions, deletions, unchanged

3. Implement `diffUtils.ts`:
   ```typescript
   import { diffLines, diffWords, diffChars, createPatch } from 'diff';
   import type { DiffChange, DiffResult, DiffStats, DiffMode } from '../types/diff.js';

   export function computeDiff(oldText: string, newText: string, mode: DiffMode = 'lines'): DiffResult {
     const diffFn = mode === 'lines' ? diffLines : mode === 'words' ? diffWords : diffChars;
     const changes: DiffChange[] = diffFn(oldText, newText);
     const stats = computeStats(changes);
     const patch = createPatch('content', oldText, newText, '', '');
     return { changes, patch, stats };
   }

   export function computePromptDiff(oldContent: string, newContent: string): DiffResult {
     return computeDiff(oldContent, newContent, 'lines');
   }

   export function computeSummaryDiff(oldContent: string, newContent: string): DiffResult {
     return computeDiff(oldContent, newContent, 'words');
   }

   export function createUnifiedPatch(filename: string, oldStr: string, newStr: string): string {
     return createPatch(filename, oldStr, newStr, 'previous', 'current');
   }

   function computeStats(changes: DiffChange[]): DiffStats {
     let additions = 0, deletions = 0, unchanged = 0;
     for (const change of changes) {
       const count = change.count ?? 1;
       if (change.added) additions += count;
       else if (change.removed) deletions += count;
       else unchanged += count;
     }
     return { additions, deletions, unchanged };
   }
   ```

4. Commit: `feat(sdk): add jsdiff utilities for version comparison`

---

## Task 7: Create AudioMixerPlugin

**Files**:
- Create: `packages/agentic-sdk-v2/src/core/AudioMixerPlugin.ts`
- Test: `packages/agentic-sdk-v2/src/core/__tests__/AudioMixerPlugin.test.ts`

**Steps**:

1. Write tests (mock Web Audio API):
   - `initialize()` creates AudioContext and master gain node
   - `addSource()` creates MediaStreamSource, connects through gain node
   - `removeSource()` disconnects and removes
   - `setSourceGain()` adjusts individual gain
   - `muteSource()` / `unmuteSource()` toggle gain to 0/previous
   - `setMasterGain()` adjusts master output
   - `destroy()` disconnects all and closes context
   - `getState()` returns current AudioMixerState

2. Implement following existing plugin patterns:
   - Constructor takes `AudioMixerPluginConfig`
   - Lifecycle: `initialize(audioContext?) → addSource() → ... → destroy()`
   - State is reactive (emits events for state changes)
   - Uses EventEmitter3 for events (matching existing pattern)

3. Key implementation:
   ```typescript
   export class AudioMixerPlugin {
     private context: AudioContext | null = null;
     private masterGain: GainNode | null = null;
     private sources: Map<string, { node: MediaStreamAudioSourceNode; gain: GainNode; config: AudioSource }>;
     private destination: MediaStreamAudioDestinationNode | null = null;

     get mixedStream(): MediaStream | null {
       return this.destination?.stream ?? null;
     }
     // ... methods
   }
   ```

4. Commit: `feat(sdk): add AudioMixerPlugin with Web Audio API`

---

## Task 8: Wire All Exports

**Files**:
- Modify: `packages/agentic-sdk-v2/src/types/index.ts`
- Modify: `packages/agentic-sdk-v2/src/utils/index.ts`
- Modify: `packages/agentic-sdk-v2/src/core.ts`
- Modify: `packages/agentic-sdk-v2/src/plugins.ts`
- Modify: `packages/agentic-sdk-v2/src/index.ts`

**Steps**:

1. `src/types/index.ts` — add:
   ```typescript
   export * from './dna.js';
   export * from './prompt.js';
   export * from './admin.js';
   export * from './settings.js';
   export * from './diff.js';
   ```

2. `src/utils/index.ts` — add:
   ```typescript
   export * from './diffUtils.js';
   ```

3. `src/core.ts` — add new types and utils exports

4. `src/plugins.ts` — add AudioMixerPlugin export:
   ```typescript
   export { AudioMixerPlugin } from './core/AudioMixerPlugin.js';
   ```

5. Verify build:
   ```bash
   cd packages/agentic-sdk-v2
   pnpm build
   ```

6. Verify bundle sizes are reasonable (core should remain ~200KB without plugins)

7. Commit: `feat(sdk): wire all new exports through barrel files`

---

## Completion Gate

Before marking WS-4 complete:
- [x] New type files created and exported: `dna.ts`, `prompt.ts`, `diff.ts`
- [x] Existing type file extended: `summary.ts` (versioning types)
- [x] All new endpoint constants added to `constants.ts`: `DNA_STYLE_ENDPOINTS`, `PROMPT_TEMPLATE_ENDPOINTS`, `DEPARTMENT_ENDPOINTS`, `SUMMARY_ENDPOINTS.VERSIONS`
- [x] `diffUtils.ts` tests pass with `diff` package (15 tests)
- [ ] ~~`AudioMixerPlugin` tests pass with mocked Web Audio API~~ — **Deferred** (YAGNI: no immediate use case)
- [x] `pnpm build` produces correct bundle (core: 224KB, plugins, full)
- [x] No TypeScript compilation errors in new/modified files
- [x] All unit tests pass (1159 tests, 45 files, 0 failures)
- [x] Signal WS-5 (SDK hooks) that foundation is ready

---

## Implementation Summary

**Completed**: 2026-02-18
**TDD**: All features implemented test-first (Red-Green-Refactor)
**Tests**: 81 new tests (30 type + 18 constants + 6 summary versioning + 15 diffUtils + 12 existing regression), all passing
**Total suite**: 1159 tests, 45 files, 0 failures

### Simplification Decisions

| Original Plan Item | Decision | Rationale |
|---|---|---|
| `admin.ts` types | **Deferred** | No backend admin endpoints exist yet (monitoring, tenant, settings) |
| `settings.ts` types | **Deferred** | No backend settings CRUD endpoints exist yet |
| AudioMixerPlugin | **Deferred** | Complex Web Audio API plugin with no immediate consumer; YAGNI |
| Extend `audio.ts` (AudioSource, AudioMixerState) | **Deferred** | Tied to AudioMixerPlugin |
| Extend `consultation.ts` (ConsultationChain, AppointmentConsultation) | **Deferred** | No backend chain endpoint implemented yet |
| Extend `config.ts` (AudioMixerPluginConfig) | **Deferred** | Tied to AudioMixerPlugin |
| `DnaUsageRecord`, `DnaRecommendation` types | **Removed** | WS-1/WS-2 brainstorming removed usage type enums and recommendation endpoints |
| `PromptUsageRecord`, `PromptUsageType` types | **Removed** | WS-1 brainstorming removed usage type enums; usage is silent/internal |
| `SETTINGS_ENDPOINTS`, `MONITORING_ENDPOINTS`, `TENANT_ENDPOINTS` | **Deferred** | No backend endpoints exist yet |

### Files Created

| File | Description |
|---|---|
| `src/types/dna.ts` | DNA Writing Style types: `DnaReport`, `DnaReportData`, `DnaStyleVersion`, `DnaGenerateInput`, `DnaUpdateInput`, `DnaReportWithFallback` |
| `src/types/prompt.ts` | Prompt Template types: `PromptTemplate`, `PromptTemplateCategory`, `PromptVariable`, `PromptVersion`, `CreatePromptInput`, `UpdatePromptInput`, `PromptListFilters`, `AssignDepartmentPromptInput` |
| `src/types/diff.ts` | Diff types: `DiffChange`, `DiffResult`, `DiffStats`, `DiffMode` |
| `src/utils/diffUtils.ts` | Diff utilities: `computeDiff`, `computePromptDiff`, `computeSummaryDiff`, `createUnifiedPatch` |
| `src/types/__tests__/dna.types.test.ts` | 12 tests for DNA types |
| `src/types/__tests__/prompt.types.test.ts` | 12 tests for Prompt types |
| `src/types/__tests__/diff.types.test.ts` | 6 tests for Diff types |
| `src/types/__tests__/summary-versioning.types.test.ts` | 6 tests for Summary versioning types |
| `src/core/__tests__/constants.ws4.test.ts` | 18 tests for new endpoint constants |
| `src/utils/__tests__/diffUtils.test.ts` | 15 tests for diff utilities |

### Files Modified

| File | Change |
|---|---|
| `src/types/summary.ts` | Added `UpdateSummaryOptions`, `SummaryVersionEntry`, `SummaryMeta` interfaces |
| `src/core/constants.ts` | Added `DNA_STYLE_ENDPOINTS`, `PROMPT_TEMPLATE_ENDPOINTS`, `DEPARTMENT_ENDPOINTS`; added `VERSIONS` to `SUMMARY_ENDPOINTS`; updated `DNA_ENDPOINTS` deprecation notice |
| `src/types/index.ts` | Added barrel exports for `dna`, `prompt`, `diff`, and summary versioning types |
| `src/utils/index.ts` | Added barrel exports for `diffUtils` |
| `src/core.ts` | Added exports for new types, constants, and diff utilities |
| `package.json` | Added `diff` ^8.0.2 dependency |

### Key Design Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Simplified to 3 new type files (not 5) | `admin.ts` and `settings.ts` have no backend backing; YAGNI |
| 2 | Deferred AudioMixerPlugin entirely | Complex Web Audio API code with no consumer in WS-5; can be added when needed |
| 3 | `DnaReportData` extends `DNAStyleData` | Maintains backwards compatibility with existing `DNAStyle` type in `summary.ts` |
| 4 | `PromptTemplateCategory` matches DB enum exactly | `'SYSTEM' \| 'SUMMARY' \| 'DNA_ANALYSIS' \| 'CUSTOM'` — same as WS-1 Prisma schema |
| 5 | `AssignDepartmentPromptInput.field` uses union type | `'newPatientPromptId' \| 'revisitPromptId'` — matches WS-2 backend DTO |
| 6 | Endpoint constants match actual WS-2/WS-3 controller routes | DNA uses `/dna-writing-styles/` and `/admin/dna-writing-styles/` paths |
| 7 | `diff` v8 with built-in types (no `@types/diff`) | `diff` v8 ships its own TypeScript declarations |
| 8 | `computeSummaryDiff` uses words mode, `computePromptDiff` uses lines mode | Summaries are prose (word-level diffs are more readable); prompts are structured text (line-level is better) |
