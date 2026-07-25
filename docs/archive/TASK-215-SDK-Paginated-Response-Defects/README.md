# TASK-215: SDK Paginated Response Handling & Codebase-Wide Defect Remediation

- **Ticket**: TASK-215
- **Created**: 2026-02-23
- **Last Updated**: 2026-02-23
- **Status**: In Progress
- **Depends On**: TASK-039 (SDK Example Apps — SPA Refactor — Completed)

---

## 1. Requirement Analysis

### Background

During the TASK-039 refactoring of 7 CRUD hooks to use the shared `useApiOperation` helper, **6 unit test failures** were discovered. Root cause analysis revealed 3 distinct defect categories that existed **before** the refactor but were masked by TypeScript generics trusting the API response shape at compile time while providing zero runtime protection.

A codebase-wide investigation using 4 parallel scout agents uncovered that the same defect class extends **far beyond** the 7 originally-fixed hooks — affecting 8 additional hooks, 3 core services, and several example app pages.

### Business Context

The `@arcaai/vox` SDK hooks are consumed by:
- The Vite example app (reference SPA implementation)
- The Next.js example app (reference SSR implementation)
- Production admin dashboard (TanStack Router + TanStack Query)

If hooks return paginated wrapper objects `{ data: [...], count, page, limit }` instead of arrays, downstream `.filter()`, `.map()`, `.length` calls crash at runtime with `TypeError: xxx.filter is not a function`.

### Acceptance Criteria

- [ ] All array-returning hook operations use `extractArray()` for response normalization
- [ ] All hooks use `useApiOperation` for consistent loading/error handling
- [ ] `extractArray()` handles all known API pagination shapes (`data`, `items`, `results`)
- [ ] `urlUtils` functions handle URL composition safely (no double `?`)
- [ ] Error handling is consistent across all operations (all set error state)
- [ ] New tests cover paginated wrapper unwrapping for every array-returning operation
- [ ] Example apps handle paginated responses correctly in direct `fetch()` calls
- [ ] Shared test factory for paginated responses
- [ ] No regressions — all existing tests pass

---

## 2. Root Cause Analysis (Original 6 Failures)

### Root Cause 1: Paginated API responses not unwrapped (4 hooks, 4 failures)

**Severity**: High — runtime crash when calling array methods on wrapper objects

**Affected hooks**: `useAiModels`, `useDepartments`, `useRoles`, `useUsers`

**Mechanism**: Hooks called `apiClient.get<T[]>(endpoint)` and trusted the TypeScript generic. But `response.json()` returns `Promise<any>` — the generic `<T[]>` is erased at runtime. When the API returns `{ data: [...], count, page, limit }`, the wrapper object was stored directly in React state.

Only `useUsers` had a partial inline fix. The other 6 hooks had zero protection.

**Fix applied in TASK-039**: Created `extractArray<T>()` utility; all array-returning operations in the 7 CRUD hooks now pipe through it.

### Root Cause 2: Inconsistent error handling in `usePrompts.getVersions` (1 failure)

**Severity**: Medium — error state not set, UI cannot display error feedback

`getVersions` was the only operation that did NOT call `setError()` on failure — it only re-threw.

**Fix applied in TASK-039**: All operations now go through `useApiOperation.execute()` which always calls `setError()`.

### Root Cause 3: `usePrompts.getVersions` response not unwrapped (1 failure)

**Severity**: High — same as Root Cause 1 but specific to prompt versions

**Fix applied in TASK-039**: `getVersions` now uses `extractArray()`.

---

## 3. Codebase-Wide Investigation Results

### 3.1 SDK Hooks Audit

#### Hooks fully protected (TASK-039 refactored — 7 hooks)

All 7 CRUD hooks have **every** array-returning operation covered with `extractArray()`:

| Hook | Array Operations | Protected |
|------|-----------------|-----------|
| `useUsers` | `list` | YES |
| `useAiModels` | `list`, `getByTaskType`, `getDownloaded` | YES |
| `useApiKeys` | `list` | YES |
| `useDepartments` | `list`, `getRoots`, `getChildren` | YES |
| `usePipelines` | `list` | YES |
| `usePrompts` | `list`, `getVersions` | YES |
| `useRoles` | `listRoles`, `getUserRoles` | YES |

#### Hooks MISSING `extractArray()` — DEFECTS (8 hooks, ~26 call sites)

| Hook | Method | Endpoint | Risk |
|------|--------|----------|------|
| **`useStorage`** | `listBuckets` | `STORAGE_ENDPOINTS.LIST_BUCKETS` | HIGH |
| **`useStorage`** | `listFiles` | `STORAGE_ENDPOINTS.LIST_FILES` | HIGH |
| **`useGlobalSettings`** | `list` | `GLOBAL_SETTINGS_ENDPOINTS.LIST` | HIGH |
| **`useGlobalSettings`** | `getByTenant` | `GLOBAL_SETTINGS_ENDPOINTS.BY_TENANT` | HIGH |
| **`useGlobalSettings`** | `getTenantConfig` | `GLOBAL_SETTINGS_ENDPOINTS.TENANT_CONFIG` | MEDIUM |
| **`useUserSettings`** | `list` | `USER_SETTINGS_ENDPOINTS.LIST` | HIGH |
| **`useUserSettings`** | `getMySettings` | `USER_SETTINGS_ENDPOINTS.MY_SETTINGS` | HIGH |
| **`useDnaStyle`** | `getVersions` | `DNA_STYLE_ENDPOINTS.VERSIONS` | MEDIUM |
| **`useMonitoring`** | `refresh` (uptime) | `MONITORING_ENDPOINTS.UPTIME` | LOW |
| **`useMonitoring`** | `getHeartbeats` | `MONITORING_ENDPOINTS.HEARTBEATS` | LOW |
| **`useArca`** | `getPatientDateConsultations` | `CONSULTATION_ENDPOINTS.PATIENT_DATE` | MEDIUM |
| **`useArca`** | `getTimeline` | `CONSULTATION_ENDPOINTS.TIMELINE` | MEDIUM |
| **`useArca`** | `getSharedContext` | `CONTEXT_ENDPOINTS.SHARED` | MEDIUM |
| **`useArca`** | `getContextVersions` | `CONTEXT_ENDPOINTS.VERSIONS` | LOW |
| **`useArca`** | `getTranscriptions` | `CONTEXT_ENDPOINTS.TRANSCRIPTIONS` | MEDIUM |
| **`useArca`** | `getCaseNotes` | `CONTEXT_ENDPOINTS.CASE_NOTES` | MEDIUM |
| **`useArca`** | `loadSummaries` | `SUMMARY_ENDPOINTS.LIST` | HIGH |
| **`useArca`** | `getSummaryVersions` | `SUMMARY_ENDPOINTS.VERSIONS` | LOW |
| **`useArcaContext`** | `loadSharedContext` | `CONTEXT_ENDPOINTS.SHARED` | MEDIUM |
| **`useArcaContext`** | `getContextVersions` | `CONTEXT_ENDPOINTS.VERSIONS` | LOW |
| **`useArcaContext`** | `getTranscriptions` | `CONTEXT_ENDPOINTS.TRANSCRIPTIONS` | MEDIUM |
| **`useArcaContext`** | `getCaseNotes` | `CONTEXT_ENDPOINTS.CASE_NOTES` | MEDIUM |
| **`useArcaSummary`** | `loadSummaries` | `SUMMARY_ENDPOINTS.LIST` | HIGH |
| **`useArcaSummary`** | `getSummaryVersions` | `SUMMARY_ENDPOINTS.VERSIONS` | LOW |
| **`useArcaSession`** | `loadSharedContext` | `CONTEXT_ENDPOINTS.SHARED` | MEDIUM |
| **`useArcaSession`** | `loadSummaries` | `SUMMARY_ENDPOINTS.LIST` | HIGH |

#### Core services MISSING normalization (3 services, 6 call sites)

| Service | Method | Risk | Notes |
|---------|--------|------|-------|
| **`TranscriptionJobService`** | `listJobs` | HIGH | Comment says "paginated" |
| **`TranscriptionJobService`** | `getJobsByConsultation` | MEDIUM | |
| **`TranscriptionJobService`** | `getJobsByStatus` | MEDIUM | |
| **`PipelineRegistry`** | `loadPipelines` | PARTIAL | Has `Array.isArray()` guard but silently drops paginated wrappers |
| **`PipelineRegistry`** | `loadBackendModels` | PARTIAL | Same — silently drops data |
| **`ModelRegistry`** | `loadCustomModelsFromBackend` | PARTIAL | Same pattern |

#### Test coverage gaps

6 of 7 refactored hooks are missing paginated wrapper tests for their **primary `list` operation** (only `useUsers` has it). Secondary operations (`getRoots`, `getByTaskType`, etc.) all have coverage.

---

### 3.2 Example Apps Audit

#### Direct `fetch()` calls bypassing hooks

| File | Endpoint | Handles Paginated? | Severity |
|------|----------|-------------------|----------|
| Vite `pages/admin/dashboard.tsx` | Health, uptime, sessions | Partially — `Array.isArray` for uptimes, raw for others | Medium |
| Both `pages/setup.tsx` | `GET /monitoring/uptime` | OK — accesses object properties with fallback | Low |
| Both `pages/summary-workflow.tsx` | `GET /v1/summary/jobs/{id}` | OK — single object | Low |
| Both `pages/transcription.tsx` | `GET stt job status` | OK — single object | Low |

#### `useEffect` dependency issues

| File | Issue | Severity |
|------|-------|----------|
| Vite `pages/consultation.tsx` L29-33 | Missing `loadPatientHistory` in deps + optional chaining anti-pattern in dep array | Medium |
| Next.js `app/admin/prompts/_content.tsx` | `list` identity changes cause unnecessary re-fetches | Low |
| Next.js `app/admin/departments/_content.tsx` | Same pattern | Low |

#### Type safety issues (`as any`, unsafe casts)

| File | Issue | Severity |
|------|-------|----------|
| Next.js `app/dna-style/_content.tsx` L184 | `as any` cast (Vite version uses proper type guard) | Medium |
| Both `pages/summarization.tsx` ~L445 | `(completedJob as any).result` | Medium |
| Both `pages/transcription.tsx` L123, L300 | `(data as any)?.status`, `(result as any).text` | Low |
| Vite `pages/setup.tsx` L300, L343, L875, L988 | Multiple `as Record<string, unknown>` casts | Low |

#### Other defects

| File | Issue | Severity |
|------|-------|----------|
| Both `departments-tab.tsx` | Dead `ConfirmDialog` import (imported but never used) | Low |
| Both `pages/setup.tsx` | `useEffect` with `fetch()` has no abort controller — state set on unmounted component | Medium |
| `window.confirm()` | None remaining — all migrated to `ConfirmDialog` | N/A |

---

### 3.3 API Gateway Pagination Patterns

The API uses **4 distinct response formats**:

#### Pattern A: Standard `Paginated<T>` (most endpoints)
```json
{ "data": [...], "count": N, "page": N, "limit": N }
```
Used by: Users, GlobalSettings, UserSettings, ApiKeys, AuditLogs, Tenants, AiModels (list), TranscriptionJobs (list)

#### Pattern B: RBAC Roles (different field names)
```json
{ "data": [...], "total": N, "page": N, "pageSize": N }
```
Uses `total` instead of `count`, `pageSize` instead of `limit`.

#### Pattern C: Raw arrays (no wrapper)
```json
[{ "id": "1", ... }, { "id": "2", ... }]
```
Used by: Departments (all endpoints), PromptTemplates (all endpoints), AiModels (by task, downloaded), TranscriptionJobs (by consultation, by status)

#### Pattern D: `@arcaai/types` PaginatedResponse (different property names)
```json
{ "items": [...], "total": N, "page": N, "pageSize": N, "hasMore": true }
```
Uses `items` instead of `data`.

**Critical inconsistency**: Same entity can return different formats depending on endpoint:
- `GET /audio/ai-models` → Pattern A (paginated wrapper)
- `GET /audio/ai-models/task/:taskType` → Pattern C (raw array)
- `GET /audio/ai-models/status/downloaded` → Pattern C (raw array)

#### Three competing pagination type definitions

| Package | Type | Items field | Total field | Limit field |
|---------|------|-------------|-------------|-------------|
| `@arcaai/applications` | `Paginated<T>` | `data` | `count` | `limit` |
| `@arcaai/vox` (SDK) | `PaginatedResponse<T>` | `data` | `total` | `limit` |
| `@arcaai/types` | `PaginatedResponse<T>` | `items` | `total` | `pageSize` |
| RBAC Roles DTO | `PaginatedRoleResponse` | `data` | `total` | `pageSize` |

---

### 3.4 Core Infrastructure Issues

#### `AgenticClient` does zero response normalization

`AgenticClient.request<T>()` returns `response.json()` cast to `T` via the generic. There is no middleware, interceptor, or response transformation. The TypeScript generic provides zero runtime safety — `response.json()` returns `Promise<any>`.

The 204 No Content case returns `undefined as T`, which is a type lie.

#### `extractArray()` only handles `data` property

Current implementation:
```typescript
export function extractArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw;
  if (raw != null && typeof raw === 'object' && 'data' in raw) {
    const { data } = raw as { data: unknown };
    if (Array.isArray(data)) return data;
  }
  return [];
}
```

Does NOT handle:
- `{ items: [...] }` — used by `@arcaai/types` `PaginatedResponse<T>`
- `{ results: [...] }` — common REST pattern
- `{ rows: [...] }` — common database pattern

#### `urlUtils` double query-string bug

Both `appendPagination()` and `appendFilters()` unconditionally prepend `?`. If composed (e.g., `appendPagination(appendFilters(url, filters), pagination)`), the result is `/api/foo?category=stt?page=1&limit=10` — invalid URL with two `?` characters.

Not currently triggered because no hook chains both functions, but it's a latent bug.

#### `useApiOperation` minor issue

`if (!apiClient) throw new Error('SDK not initialized')` throws before `setError(null)`, meaning a stale error from a previous failed call persists. Low severity — caller sees the thrown error.

---

## 4. Implementation Plan

### Phase 1: Harden `extractArray()` for all known API shapes

**Files**:
- Modify: `src/utils/responseUtils.ts`
- Modify: `src/utils/__tests__/responseUtils.test.ts`

**Changes**:
- Add support for `items` property (Pattern D / `@arcaai/types`)
- Add support for `results` property (common REST pattern)
- Add optional warning log when falling through to `return []` with non-null input
- Priority order: raw array → `data` → `items` → `results` → `[]`

### Phase 2: Fix `urlUtils` composition bug

**Files**:
- Modify: `src/utils/urlUtils.ts`
- Modify: `src/utils/__tests__/urlUtils.test.ts`

**Changes**:
- Check if URL already contains `?` and use `&` separator instead
- Add tests for composed calls

### Phase 3: Refactor remaining hooks to use `useApiOperation` + `extractArray()`

**Priority order** (by risk level):

#### Phase 3.1: HIGH risk hooks

| Hook | Array operations to fix |
|------|------------------------|
| `useGlobalSettings` | `list`, `getByTenant`, `getTenantConfig` |
| `useUserSettings` | `list`, `getMySettings` |
| `useStorage` | `listBuckets`, `listFiles` |
| `useArcaSummary` | `loadSummaries`, `getSummaryVersions` |
| `useArcaSession` | `loadSharedContext`, `loadSummaries` |

#### Phase 3.2: MEDIUM risk hooks

| Hook | Array operations to fix |
|------|------------------------|
| `useArca` | `getPatientDateConsultations`, `getTimeline`, `getSharedContext`, `getTranscriptions`, `getCaseNotes`, `loadSummaries`, `getContextVersions`, `getSummaryVersions` |
| `useArcaContext` | `loadSharedContext`, `getContextVersions`, `getTranscriptions`, `getCaseNotes` |
| `useDnaStyle` | `getVersions` |
| `useMonitoring` | `refresh`, `getHeartbeats` |

#### Phase 3.3: Core services

| Service | Methods to fix |
|---------|---------------|
| `TranscriptionJobService` | `listJobs`, `getJobsByConsultation`, `getJobsByStatus` |
| `PipelineRegistry` | `loadPipelines`, `loadBackendModels` (upgrade from `Array.isArray` guard to `extractArray`) |
| `ModelRegistry` | `loadCustomModelsFromBackend` (same) |

### Phase 4: Add missing test coverage

**For each refactored hook, add tests for**:
1. Raw array response → returns array
2. Paginated wrapper `{ data: [...] }` → extracts and returns array
3. Unexpected response shape → returns `[]`

**Create shared test factory**:
- `createPaginatedResponse(data, overrides?)` — generates realistic paginated wrapper
- Use in all hook tests for consistency

**Add missing `list` operation paginated tests** for the 6 hooks identified:
- `useAiModels.list`
- `useApiKeys.list`
- `useDepartments.list`
- `usePipelines.list`
- `usePrompts.list`
- `useRoles.listRoles`

### Phase 5: Fix example app defects

#### 5.1: Add abort controllers to `useEffect` fetch calls
- Vite `pages/setup.tsx`
- Next.js `app/setup/_content.tsx`

#### 5.2: Fix `useEffect` dependency issues
- Vite `pages/consultation.tsx` — add `loadPatientHistory` to deps or use ref pattern

#### 5.3: Remove dead imports
- Both `departments-tab.tsx` — remove unused `ConfirmDialog` import

#### 5.4: Fix type safety issues (optional, lower priority)
- Replace `as any` casts with proper type guards
- Add `CustomPreferences` interface for setup page
- Extend job types to include `result` property

### Phase 6: Final validation

- Run full SDK test suite (`pnpm test` in `packages/agentic-sdk-v2`)
- Run full monorepo test suite
- TypeScript check on all modified files
- Lint check on all modified files
- Verify Vite app build succeeds
- Verify Next.js app build succeeds

---

## 5. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Breaking existing hook public API | Low | High | `UseXxxReturn` interfaces unchanged; all existing tests must pass |
| `extractArray` false positive (unwraps non-paginated object with `data` property) | Low | Medium | Only applies to array-returning operations; single-object endpoints don't use it |
| Refactoring `useArca`/`useArcaSession` affects production workflows | Medium | High | These are complex hooks — refactor incrementally, test each operation |
| `urlUtils` fix changes query string format | Low | Low | Only affects edge case of composed calls; existing behavior preserved |

---

## 6. Estimated Effort

| Phase | Tasks | Estimated Time |
|-------|-------|---------------|
| Phase 1: Harden `extractArray` | 1 task | 15 min |
| Phase 2: Fix `urlUtils` | 1 task | 15 min |
| Phase 3.1: HIGH risk hooks | 5 hooks | 60 min |
| Phase 3.2: MEDIUM risk hooks | 4 hooks | 45 min |
| Phase 3.3: Core services | 3 services | 30 min |
| Phase 4: Test coverage | Shared factory + per-hook tests | 45 min |
| Phase 5: Example app fixes | 4 sub-tasks | 30 min |
| Phase 6: Validation | Full test suite + builds | 15 min |
| **Total** | | **~4 hours** |

---

## 7. Defect Summary Dashboard

### By Severity

| Severity | Count | Category |
|----------|-------|----------|
| **HIGH** | 10 | Hooks missing `extractArray` on paginated endpoints |
| **MEDIUM** | 12 | Hooks missing `extractArray` on possibly-paginated endpoints |
| **LOW** | 8 | Monitoring hooks, version endpoints, dead imports, minor type casts |
| **PARTIAL** | 3 | Core services with `Array.isArray` guard that silently drops paginated data |

### By Component

| Component | HIGH | MEDIUM | LOW | Total |
|-----------|------|--------|-----|-------|
| SDK Hooks (unfixed) | 7 | 8 | 6 | 21 |
| Core Services | 1 | 2 | 0 | 3 |
| Core Services (partial) | 3 | 0 | 0 | 3 |
| Example Apps | 0 | 4 | 4 | 8 |
| Utilities | 0 | 1 | 1 | 2 |
| Test Coverage | 0 | 6 | 0 | 6 |
| **Total** | **11** | **21** | **11** | **43** |

---

## 8. Implementation Summary

_To be completed after fixes are applied._

---

## Change History

| Date | Update | Status |
|------|--------|--------|
| 2026-02-23 | Root cause analysis of 6 test failures completed | Completed |
| 2026-02-23 | Codebase-wide investigation with 4 scout agents completed — found 43 total defects across SDK hooks, core services, example apps, and utilities | Completed |
| 2026-02-23 | Full implementation plan with 6 phases documented | In Progress |
