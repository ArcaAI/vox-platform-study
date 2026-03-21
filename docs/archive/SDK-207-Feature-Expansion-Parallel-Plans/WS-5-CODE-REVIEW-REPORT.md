# WS-5 (SDK Hooks) Code Review Report

**Reviewed**: 2026-02-18  
**Scope**: `packages/agentic-sdk-v2/`  
**Reference**: workstream-5-sdk-hooks.md

---

## Code Review Summary

**Files Reviewed**: 15+  
**Overall Assessment**: **CONDITIONAL PASS** — One critical bug (usePrompts.compareVersions), several deferred items per implementation decisions

---

## 1. Enhanced useArca — Summary Features

**File**: `src/hooks/useArca.ts`

| Method | Status | Notes |
|--------|--------|-------|
| `updateSummary(id, content, options?: UpdateSummaryOptions)` | ✅ | Uses `SUMMARY_ENDPOINTS.UPDATE`, spreads `...options` into PATCH body |
| `getSummaryHistory(summaryId)` | ✅ | Uses `SUMMARY_ENDPOINTS.VERSIONS(consultation.id, summaryId)` |
| `compareSummaryVersions(contextItemId, v1, v2)` | ✅ | Fetches via `CONTEXT_ENDPOINTS.VERSION`, uses `computeSummaryDiff` |
| `generateSummaryWithContext` | ❌ | **Not implemented** (deferred per workstream doc) |
| `archiveSummary` | ❌ | **Not implemented** (deferred) |
| `getSummaryMeta` | ❌ | **Not implemented** (deferred) |

**computeSummaryDiff**: ✅ Imported from `../utils/diffUtils` and used in `compareSummaryVersions` (line 1071).

**Error handling**: ✅ Per-domain errors via `store.setSummaryError`, `store.setContextError`, `store.setSessionError`, `store.setAudioError`. Consistent try/catch with `timer?.error()`.

**UpdateSummaryOptions**: ✅ Type imported from `../types`, passed through to API.

---

## 2. Enhanced useArca — Consultation Chain

**File**: `src/hooks/useArca.ts` and `src/hooks/useArcaSession.ts`

| Method | Status | Notes |
|--------|--------|-------|
| `getConsultationChain()` | ❌ | **Not implemented** — Deferred (workstream: "consultation chain accessible via getTimeline(scope='chain')") |
| `getAppointmentConsultations(patientId, date)` | ⚠️ | Exists as `findByPatientDate(patientId, date)` in useArca — uses `CONSULTATION_ENDPOINTS.PATIENT_DATE` |

**CONSULTATION_ENDPOINTS.CHAIN**: ✅ Defined in constants (`/consultations/:id/chain`) but not used by any hook. Chain data is available via `getTimeline(scope='chain')`.

---

## 3. useDnaStyle Hook

**File**: `src/hooks/useDnaStyle.ts`

| Method | Status | Notes |
|--------|--------|-------|
| `getMyStyle` | ✅ | Uses `DNA_STYLE_ENDPOINTS.MY_STYLE` |
| `getStyle` | ❌ | Not in interface — `getMyStyle` covers this |
| `generate` | ✅ | Uses `DNA_STYLE_ENDPOINTS.GENERATE` |
| `getVersions` | ✅ | Uses `DNA_STYLE_ENDPOINTS.VERSIONS(reportId)` |
| `getVersion` | ❌ | Not implemented (single version fetch) |
| `getRecommendations` | ❌ | Removed (WS-2 removed recommendation endpoints) |
| `getMyUsage` | ❌ | Removed (WS-2 removed usage type enums) |
| `generateForDoctor` | ❌ | Not implemented (admin-only, different endpoint) |
| `compareVersions` | ❌ | Not implemented (removed per simplification) |

**DNA_STYLE_ENDPOINTS**: ✅ All used endpoints present.

**State management**: ✅ `useState` for `style`, `versions`, `isLoading`, `error`. `useCallback` for actions, `useMemo` for return object.

**Logger**: ✅ `store.logger?.child('useDnaStyle')`, `timer?.startOperation`, `timer?.end`, `timer?.error`.

---

## 4. useAudioMixer Hook

**Status**: ❌ **Not implemented** — Deferred (AudioMixerPlugin deferred in WS-4, YAGNI).

---

## 5. useArcaConfig Extension

**File**: `src/hooks/useArcaConfig.ts`

| Method | Status | Notes |
|--------|--------|-------|
| `getAllSettings` | ❌ | Not implemented — useArcaConfig manages preferences/models, not settings |
| `getSetting` | ❌ | Not implemented |
| `updateSetting` | ❌ | Not implemented |
| `deleteSetting` | ❌ | Not implemented |

**SETTINGS_ENDPOINTS**: ❌ Not defined in constants. No backend settings CRUD endpoints exist (deferred per workstream).

**Current useArcaConfig**: Manages `preferences`, `models`, `update`, `selectModel`, `get`, `reset` via `PERSONALIZATION_ENDPOINTS` / `PersonalizationManager`.

---

## 6. usePrompts Hook

**File**: `src/hooks/usePrompts.ts`

| Method | Status | Notes |
|--------|--------|-------|
| `create` | ✅ | Uses `PROMPT_TEMPLATE_ENDPOINTS.CREATE` |
| `list` | ✅ | Uses `PROMPT_TEMPLATE_ENDPOINTS.LIST` with filters |
| `get` | ✅ | Uses `PROMPT_TEMPLATE_ENDPOINTS.GET(id)` |
| `getByName` | ❌ | Not implemented |
| `update` | ✅ | Uses `PROMPT_TEMPLATE_ENDPOINTS.UPDATE(id)` |
| `remove` | ✅ | Uses `PROMPT_TEMPLATE_ENDPOINTS.DELETE(id)` |
| `listVersions` | ✅ | Exposed as `getVersions` |
| `getVersion` | ❌ | Not implemented (single version) |
| `assignToDepartment` | ✅ | Uses `PROMPT_TEMPLATE_ENDPOINTS.ASSIGN_DEPARTMENT` |
| `getByDepartment` | ⚠️ | Via `list({ departmentId })` filter |
| `getUsage` | ❌ | Removed (WS-2 made usage recording silent) |
| `getUsageByDepartment` | ❌ | Removed |
| `compareVersions` | ⚠️ | **BUG** — see Critical Issues |

**PROMPT_TEMPLATE_ENDPOINTS**: ✅ Used correctly for all implemented methods.

**computePromptDiff**: ✅ Imported and used in `compareVersions`.

---

## 7. useDepartments Hook

**File**: `src/hooks/useDepartments.ts`

| Method | Status | Notes |
|--------|--------|-------|
| `list` | ✅ | Uses `DEPARTMENT_ENDPOINTS.LIST` |
| `get` | ✅ | Uses `DEPARTMENT_ENDPOINTS.GET(id)` |
| `update` | ✅ | Uses `DEPARTMENT_ENDPOINTS.UPDATE(id)` |
| `getPrompts` | ❌ | Not implemented (no `DEPARTMENT_ENDPOINTS.GET_PROMPTS`) |

**DEPARTMENT_ENDPOINTS**: ✅ Used for list, get, update.

---

## 8. useTenantSettings Hook

**Status**: ❌ **Not implemented** — Deferred (no backend tenant settings endpoints).

---

## 9. useConsultationAdmin Hook

**Status**: ❌ **Not implemented** — Deferred (no backend admin consultation endpoints).

---

## 10. useSystemHealth Hook

**Status**: ❌ **Not implemented** — Deferred (no backend monitoring endpoints verified; auth concerns noted).

---

## 11. Hook Exports

**File**: `src/hooks/index.ts`

| Hook | Exported |
|------|----------|
| useArcaSession | ✅ |
| useArca | ✅ |
| useArcaConfig | ✅ |
| useDnaStyle | ✅ |
| usePrompts | ✅ |
| useDepartments | ✅ |
| useAudioMixer | ❌ (hook doesn't exist) |
| useTenantSettings | ❌ (hook doesn't exist) |
| useConsultationAdmin | ❌ (hook doesn't exist) |
| useSystemHealth | ❌ (hook doesn't exist) |

**core.ts**: ✅ Exports `useArca`, `useArcaSession`, `useArcaConfig`, `useDnaStyle`, `usePrompts`, `useDepartments`.

**plugins.ts**: ❌ Does not export `useAudioMixer` (hook deferred).

---

## 12. Tests

| Hook/Feature | Test File | Tests | Status |
|--------------|-----------|-------|--------|
| useArca (summary) | `useArca.summary.test.ts` | 25+ | ✅ Pass |
| useArcaSession | `useArca.session.test.ts` | — | ✅ |
| useDnaStyle | `useDnaStyle.test.ts` | 8 | ✅ Pass |
| usePrompts | `usePrompts.test.ts` | 33 | ✅ Pass |
| useDepartments | `useDepartments.test.ts` | 7 | ✅ Pass |
| useArcaConfig | — | — | ⚠️ No dedicated test file |
| useAudioMixer | — | — | N/A (deferred) |

**Total suite**: 1290 tests, 48 files, 0 failures.

---

## 13. Integration

**core.ts**: ✅ All implemented hooks exported. Types exported.

**plugins.ts**: ✅ No useAudioMixer (correct, deferred). Other plugin hooks (useVAD, useSTT, etc.) present.

---

## Critical Issues

### 1. usePrompts.compareVersions — Invalid API Endpoint (CRITICAL)

**File**: `src/hooks/usePrompts.ts:184-186`

**Issue**: `compareVersions` constructs URLs:
- `PROMPT_TEMPLATE_ENDPOINTS.VERSIONS(id) + \`/${v1}\`` → `/prompt-templates/${id}/versions/1`
- `PROMPT_TEMPLATE_ENDPOINTS.VERSIONS(id) + \`/${v2}\`` → `/prompt-templates/${id}/versions/2`

The backend **only** has `GET /prompt-templates/:id/versions` (returns a list). There is **no** `GET /prompt-templates/:id/versions/:versionNumber` route. These URLs will **404** in production.

**Fix**: Fetch the full version list and filter client-side:

```typescript
const compareVersions = useCallback(async (id: string, v1: number, v2: number): Promise<DiffResult> => {
  if (!apiClient) throw new Error('SDK not initialized');
  const timer = logger?.startOperation('compareVersions');
  try {
    const versions = await apiClient.get<PromptVersion[]>(PROMPT_TEMPLATE_ENDPOINTS.VERSIONS(id));
    const ver1 = versions.find(v => v.versionNumber === v1);
    const ver2 = versions.find(v => v.versionNumber === v2);
    if (!ver1 || !ver2) {
      throw new Error(`Version ${ver1 ? v2 : v1} not found`);
    }
    const result = computePromptDiff(ver1.content, ver2.content);
    timer?.end(true);
    return result;
  } catch (err) {
    timer?.error(err as Error);
    throw err;
  }
}, [apiClient, logger]);
```

---

## Recommendations

1. **Fix usePrompts.compareVersions** — Implement client-side filtering as above, or add backend `GET /:id/versions/:versionNumber` and add constant.
2. **Add useArcaConfig tests** — Dedicated test file for preferences, models, update, reset.
3. **Document deferred hooks** — In SDK README or migration guide, list deferred hooks and conditions for future implementation.

---

## Suggestions

- Consider adding `getVersion(id, versionNumber)` to usePrompts if backend adds single-version endpoint.
- Consider `getPrompts(departmentId)` for useDepartments when department-prompt association API exists.
- useDnaStyle: `generateForDoctor` could be added for admin flows using `DNA_STYLE_ENDPOINTS.GENERATE_FOR_DOCTOR(doctorId)`.

---

## What's Good

- **Pattern compliance**: useCallback, useMemo, logger child instances, per-domain errors.
- **useArca summary**: updateSummary with options, getSummaryHistory, compareSummaryVersions (using diffUtils) correctly implemented.
- **useDnaStyle, usePrompts, useDepartments**: Clean implementations with state, loading, error handling.
- **Test coverage**: 1290 tests pass; new hooks have solid unit tests.
- **Export wiring**: core.ts and hooks/index.ts correctly export all implemented hooks.
- **diffUtils**: computeSummaryDiff (words) and computePromptDiff (lines) used appropriately.

---

## Summary

The WS-5 implementation is largely complete and follows project patterns. **One critical bug** must be fixed: `usePrompts.compareVersions` uses non-existent API endpoints and will 404 in production. After fixing that, the implementation qualifies as **PASS**. Deferred items (useAudioMixer, useArcaConfig settings, useTenantSettings, useConsultationAdmin, useSystemHealth) are documented and acceptable per workstream decisions.
