# TASK-297 — SDK Personalization Cascade (4-tier, Profile Preload, Per-user Storage, Transport Hygiene)

| | |
|---|---|
| Ticket Number | TASK-297 |
| Parent | [TASK-293 Vox SDK Deep Assessment V2](../TASK-293-Vox-SDK-Deep-Assessment-V2/README.md) |
| Created | 2026-05-24 |
| Updated | 2026-05-24 |
| Status | **Completed** |
| Type | refactor + security + bugfix |
| Owner | SDK team |
| Scope | `@arcaai/vox` (`packages/agentic-sdk-v2/`) only — backend / playground / Python out of scope |

---

## 1. Requirement Analysis

This ticket implements the SDK-side personalization, transport-hygiene, and impersonation isolation defects from the TASK-293 V2 audit. It maps to the following Wave-5 actions:

| Wave-5 ID | TASK-293 ref | Brief |
|---|---|---|
| W5A-11 | [06 C-SSE-1](../TASK-293-Vox-SDK-Deep-Assessment-V2/06-transports.md) | Remove `?token=<jwt>` regression in `SharedConnectionWorker` + `SharedConnectionManager`; mint ticket at SDK boundary |
| W5A-12 | [01 DEF-M1](../TASK-293-Vox-SDK-Deep-Assessment-V2/01-personalization-settings.md) | Hash PHI in fallback `BroadcastChannel` name when `tenantId` missing |
| W5B-9  | [01 DEF-C5](../TASK-293-Vox-SDK-Deep-Assessment-V2/01-personalization-settings.md) | Extend `ConfigManager` to a 4-tier cascade (`SYSTEM ← tenant ← department ← user`) + `setDepartmentConfig` + dept `CONFIG_PERMISSIONS` tier |
| W5B-10 | [01 DEF-C6](../TASK-293-Vox-SDK-Deep-Assessment-V2/01-personalization-settings.md) | Preload `/auth/me` in `AgenticProvider` before `configReady`; add `profileReady`; gate mutations |
| W5B-11 | [01 DEF-H1](../TASK-293-Vox-SDK-Deep-Assessment-V2/01-personalization-settings.md) | Namespace IDB/localStorage by `${tenantId}::${userId}`; clear IDB in `clearOnLogout`; rehydrate on user/impersonation change |
| W5B-12 | [01 DEF-H2](../TASK-293-Vox-SDK-Deep-Assessment-V2/01-personalization-settings.md) | One-line POST → PATCH fix in `PersonalizationManager.syncToBackend` |
| W5B-13 | [05 H-4](../TASK-293-Vox-SDK-Deep-Assessment-V2/05-impersonation.md) | `PersonalizationManager.setImpersonationReadOnly()` + wire from `useAuth.impersonate` / `endImpersonation` |
| W5C-1  | [01 DEF-H3](../TASK-293-Vox-SDK-Deep-Assessment-V2/01-personalization-settings.md), [08 C-XCUT-5](../TASK-293-Vox-SDK-Deep-Assessment-V2/08-cross-cutting-quality.md) | Atomic selectors + `useShallow` for personalization hooks |
| W5C-14 | [06 H-HTTP-1](../TASK-293-Vox-SDK-Deep-Assessment-V2/06-transports.md) | Skip 401-refresh on `/auth/login`, `/auth/stream-ticket`, `/auth/impersonate`; add `postFormData` refresh; bound `requestTimestamps` |
| H-SSE-5 | [06 H-SSE-5](../TASK-293-Vox-SDK-Deep-Assessment-V2/06-transports.md) | De-dup SSE in `SharedConnectionWorker` by `(id, userId)` not `id` alone |
| DEF-H4 | [01 DEF-H4](../TASK-293-Vox-SDK-Deep-Assessment-V2/01-personalization-settings.md) | Forward `PersonalizationManager.updatePreferences` into `ConfigManager.setUserValue`; deprecate duplicated localConfig path |
| DEF-H5 | [01 DEF-H5](../TASK-293-Vox-SDK-Deep-Assessment-V2/01-personalization-settings.md) | Cache the tenant-config promise in `AgenticProvider` |
| DEF-H6 | [01 DEF-H6](../TASK-293-Vox-SDK-Deep-Assessment-V2/01-personalization-settings.md) | Reset personalization slices + managers in `clearOnLogout` |
| DEF-L1 | [01 DEF-L1](../TASK-293-Vox-SDK-Deep-Assessment-V2/01-personalization-settings.md) | Remove dead `STORAGE_KEYS.SESSION_STATE` constant |
| DEF-L3 | [01 DEF-L3](../TASK-293-Vox-SDK-Deep-Assessment-V2/01-personalization-settings.md) | Surface `ConfigManager.loadUserPreferences` errors via the SDK logger |

### Acceptance criteria

1. `ConfigManager.resolve()` produces `SYSTEM ← tenant ← department ← user` (4-tier), strips user paths in the union of `tenantLockedPaths ∪ departmentLockedPaths`, emits `departmentConfigChanged`, and `CONFIG_PERMISSIONS` recognises a `department` tier.
2. `AgenticProvider` calls `apiClient.get(AUTH_ENDPOINTS.ME)` BEFORE any user-tier hydration; if `me.departmentId` is present it fetches and applies department config; only then does it flip `configReady` true. On `/auth/me` failure `configReady` stays `false` and the error is logged.
3. `useArcaConfig.update` / `setUserPreference` / `resetUserPreferences` throw `AgenticError('CONFIG_NOT_READY', ...)` when `configReady === false`.
4. IDB and localStorage preference keys are namespaced as `user-preferences/${tenantId}::${userId}` and `arcaai-user-preferences/${tenantId}::${userId}` respectively; a `pre-login` namespace is used until `authUser.id` is known.
5. `agenticStore.clearOnLogout` clears the IDB store AND resets in-memory `preferences`, `tenantConfig`, `resolvedConfig`, `configReady`, `configManager`, `personalizationManager`.
6. `PersonalizationManager.syncToBackend` uses `apiClient.patch(...)`; the legacy `localConfig` writes are forwarded into `ConfigManager.setUserValue` and marked `@deprecated`.
7. `useArcaConfig`, `useArcaContext`, `useArca` no longer call the bare `useAgenticStore()` for personalization slices — they use atomic `selectX` subscriptions with `useShallow` where the selected value is an object.
8. `PersonalizationManager.setImpersonationReadOnly(true)` causes `updatePreferences` to mutate `this.preferences` and `notifyListeners()` only — neither `saveLocal()` nor `syncToBackend()` is called. `useAuth.impersonate` flips it `true` after `setImpersonatedUser`; `useAuth.endImpersonation` flips it `false`.
9. `AgenticClient.request` does not call the 401 refresh handler on `/auth/login`, `/auth/stream-ticket`, or `/auth/impersonate`. `postFormData` has a 401 → refresh → retry path equivalent to `request`. `requestTimestamps` is bounded (drop oldest beyond `2 × maxRequests`).
10. `SharedConnectionWorker` and `SharedConnectionManager` do not append `?token=<jwt>` to SSE URLs. Callers pass `?ticket=<…>` via `subscription.ticket` (caller mints via `apiClient.post('/auth/stream-ticket', ...)` upstream). SSE de-dup key is `(id, userId)` — two subscriptions with the same `id` but distinct `userId` are NOT shared.
11. `SimpleCrossTabSync` fallback channel name uses an SHA-256 hash (first 8 bytes hex) of the consultation key when `tenantId` is missing. Tests assert no UUID-shaped substring leaks.
12. `STORAGE_KEYS.SESSION_STATE` is removed; `ConfigManager.loadUserPreferences` failures call `logger.warn(...)`.

### Business context

Doctor users in HIPAA-regulated tenants need their personal SDK settings isolated from the tenant defaults and from other users sharing the same browser. The 3-tier cascade today (SYSTEM ← tenant ← user) cannot model departments, and the global IDB key leaks the previous doctor's prefs into the next session. The `?token=<jwt>` SSE regression re-introduces SEC-A. This ticket closes all of those without backend changes.

---

## 2. Current State Evaluation

### 2.1 SDK files in scope

| File | Current state |
|---|---|
| `packages/agentic-sdk-v2/src/core/ConfigManager.ts:14-25,202-207` | 3-tier merge only (`SYSTEM ← tenant ← user`); no `departmentOverrides` field; `loadUserPreferences` swallows errors silently. |
| `packages/agentic-sdk-v2/src/core/ConfigSchema.ts:81-115` | `ConfigPermission = 'system' \| 'admin' \| 'user'` — no `'department'` tier. |
| `packages/agentic-sdk-v2/src/core/PersonalizationManager.ts:269` | `apiClient.post(PERSONALIZATION_ENDPOINTS.UPDATE_PREFERENCES, payload)` against a `@Patch()` handler. No `impersonationReadOnly` gate. |
| `packages/agentic-sdk-v2/src/core/SimpleCrossTabSync.ts:233-238` | Channel name fallback is `agentic.${consultationKey}` (`patientId_doctorId_appointmentDate`) — raw PHI in DevTools. |
| `packages/agentic-sdk-v2/src/core/AgenticClient.ts:243,393-501,75` | 401-refresh skip-list misses `/auth/login`, `/auth/stream-ticket`, `/auth/impersonate`. `postFormData` has no refresh path. `requestTimestamps` array grows unbounded. |
| `packages/agentic-sdk-v2/src/core/SharedConnectionWorker.ts:99-102,127-141` | Appends `?token=<jwt>` to SSE URL. De-dups by `id` alone. |
| `packages/agentic-sdk-v2/src/core/SharedConnectionManager.ts:363-366` | Same `?token=<jwt>` regression in fallback `EventSource`. |
| `packages/agentic-sdk-v2/src/core/constants.ts:354,160` | `STORAGE_KEYS.SESSION_STATE` is dead. `DEPARTMENT_ENDPOINTS.PROMPT_CONFIG` already exists at line 181 — re-use, no new constant needed. |
| `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx:23-89,263-340` | Never preloads `/auth/me`. Loads tenant config twice (lines 263-277 + 300). IDB key is global (`'user-preferences'`). `setConfigReady(true)` fires on both success AND failure of ConfigManager init. |
| `packages/agentic-sdk-v2/src/store/agenticStore.ts:456-488` | `clearOnLogout` only `localStorage.removeItem`; never clears IDB; leaves `preferences`/`tenantConfig`/`resolvedConfig`/`configReady` intact. |
| `packages/agentic-sdk-v2/src/hooks/useAuth.ts:162-222` | `impersonate` / `endImpersonation` do not toggle a `PersonalizationManager` read-only flag. |
| `packages/agentic-sdk-v2/src/hooks/useArcaConfig.ts:94` | `const store = useAgenticStore();` — whole-store subscription. |
| `packages/agentic-sdk-v2/src/hooks/useArcaContext.ts:17` | Same whole-store subscription. |
| `packages/agentic-sdk-v2/src/hooks/useArca.ts:283` | Same. (Personalization-related parts only — audio/pipeline/transcription scope is TASK-298.) |

### 2.2 Out of scope / hand-off

| Concern | Owner | Reason |
|---|---|---|
| Backend `MeResponse.departmentId` exposure | TASK-295 | Required to populate department tier from `/auth/me`. **This ticket consumes `me?.departmentId` defensively; if the backend has not yet surfaced it, the 4-tier cascade gracefully degrades to 3-tier.** |
| Backend `/admin/departments/:id/prompt-config` IDOR + AuthZ tuple | parent W5A-10 / TASK-293 (separate backend ticket) | Out of SDK scope. |
| `PromptTemplate` schema `scope` / `ownerUserId` (DEF-C1) | Backend (parent W5B-7) | DB layer; cannot be done from SDK. |
| `/prompt-templates/assign-department` route (DEF-C4) | Backend (parent W5B-8) | Cannot create routes from SDK. |
| `StreamingSessionManager`, `SttV2WebSocketClient`, `PluginManager`, `useArcaAudio`, `usePipelines`, `useConsultationJob`, `useArcaSummary`, `useDnaStyle`, `useVoiceEmbedding`, `useVoiceEnrollmentStatus` | TASK-296 / 298 / 299 | Excluded per ownership matrix. |

---

## 3. Implementation Plan (TDD)

All work happens in `packages/agentic-sdk-v2/`. One RED test per defect first; minimal GREEN; refactor.

### 3.1 Test list (RED → GREEN)

| # | File | New / extended test | Verifies |
|---|---|---|---|
| 1 | `core/__tests__/ConfigManager.test.ts` | `4-tier merge` describe block | `system + tenant + department + user` precedence; `(t=X) + (d=Y) + (u=undef) → Y`; `(t=X) + (d=Y) + (u=Z) → Z`; `departmentLockedPaths ∪ tenantLockedPaths` strip from user prefs; `departmentConfigChanged` event fires. |
| 2 | `core/__tests__/ConfigSchema.test.ts` | extend with `'department' permission tier` test | `getFieldPermission` returns `'department'` for paths so marked; `canUserEditField` rejects `'department'` paths. |
| 3 | `core/__tests__/ConfigManager.test.ts` | `loadUserPreferences logs error via SDK logger` | Confirm `options.logger.warn` called when loader rejects. |
| 4 | `providers/__tests__/AgenticProvider.test.tsx` | `preloads /auth/me before configReady` | `mockFetch` for `/auth/me`; assert order: `/auth/me` resolves BEFORE `configReady === true`; on rejection `configReady === false`. |
| 5 | `providers/__tests__/AgenticProvider.test.tsx` | `tenant-config fetched once (DEF-H5)` | Mount provider; assert one fetch to tenant-config endpoint, not two. |
| 6 | `core/__tests__/PersonalizationManager.test.ts` | `syncToBackend uses PATCH verb (DEF-H2)` | Inspect `mockFetch.mock.calls[0][1].method === 'PATCH'`. |
| 7 | `core/__tests__/PersonalizationManager.test.ts` | `setImpersonationReadOnly blocks saveLocal + syncToBackend` | After flag true, `updatePreferences({lang:'th'})` must not write `localStorage[STORAGE_KEYS.PREFERENCES]` and must not call `mockFetch`. |
| 8 | `core/__tests__/PersonalizationManager.test.ts` | `updatePreferences forwards into ConfigManager.setUserValue (DEF-H4)` | Inject mock ConfigManager-like sink; assert `setUserValue('ui.language','th')` called when `language: 'th'` is in updates. |
| 9 | `hooks/__tests__/useArcaConfig.test.tsx` | `useArcaConfig uses atomic selectors` | Mock store; mutate an unrelated slice (`audioLevel`); the test renders a leaf consuming `useArcaConfig().preferences` — re-render count stays equal. (Smoke test via render-count counter.) |
| 10 | `hooks/__tests__/useArcaConfig.test.tsx` | `update throws CONFIG_NOT_READY when configReady=false` | Init store with `configReady=false`; call `update({language:'th'})`; expect `AgenticError` thrown with code `'CONFIG_NOT_READY'`. |
| 11 | `core/__tests__/SimpleCrossTabSync.test.ts` | `fallback channel name hashes consultation key` | Construct sync with no tenantId; await `flushAsync`; assert channel name matches `/^agentic\.[0-9a-f]{16}$/` and does NOT contain `patientId` or `doctorId` substring. |
| 12 | `core/__tests__/AgenticClient.refreshMutex.test.ts` | `does not refresh on /auth/login / /auth/stream-ticket / /auth/impersonate` | Set handler, hit each endpoint with 401; handler must NOT be called. |
| 13 | `core/__tests__/AgenticClient.test.ts` | `postFormData refreshes once on 401` | First call 401, second call 200; handler called once. |
| 14 | `core/__tests__/AgenticClient.test.ts` | `requestTimestamps is bounded` | Hammer 1000 requests with rateLimit of 100; assert `(client as any).requestTimestamps.length <= 200` after run. |
| 15 | `core/__tests__/SharedConnectionManager.test.ts` | `fallback SSE does NOT append ?token=` | Subscribe with `authToken`; assert `EventSource.url` lacks `token=` substring; if `ticket` is passed it appends `?ticket=`. |
| 16 | `core/__tests__/SharedConnectionManager.test.ts` | `subscribeSSE without ticket logs warning` | When neither `ticket` nor `authToken` (legacy) is provided, the SSE attempt still works (no auth) but no `token=` parameter is appended. |
| 17 | `core/__tests__/SharedConnectionWorker.ts` (worker isn't directly testable — assert via SharedConnectionManager.test or a unit testing the route helper) | de-dup by `(id, userId)` | Subscribing twice with same `id` but different `userId` opens TWO `EventSource` instances. |
| 18 | `store/__tests__/agenticStore.test.ts` | `clearOnLogout resets personalization slices + IDB` | Seed `preferences`/`tenantConfig`/`resolvedConfig`/`configReady`/`configManager`/`personalizationManager`; mock `indexedDB`; call `clearOnLogout`; assert all reset to defaults AND IDB store cleared. |
| 19 | `core/__tests__/constants.test.ts` (existing) | `STORAGE_KEYS.SESSION_STATE removed` | Assert `'SESSION_STATE' in STORAGE_KEYS === false`. |

### 3.2 File modification order

1. **Constants & schema** — `constants.ts` (remove `SESSION_STATE`), `ConfigSchema.ts` (add `'department'` permission tier, types).
2. **Add `CONFIG_NOT_READY` error code** — `types/common.ts` (one-line addition; required for AgenticError throw in useArcaConfig).
3. **Core managers** — `ConfigManager.ts` (4-tier, logger, dept), `PersonalizationManager.ts` (PATCH verb, `setImpersonationReadOnly`, forward to ConfigManager, deprecate localConfig path).
4. **Cross-tab** — `SimpleCrossTabSync.ts` (hashed fallback name).
5. **HTTP** — `AgenticClient.ts` (skip-list, postFormData refresh, bounded timestamps).
6. **Transports** — `SharedConnectionWorker.ts` and `SharedConnectionManager.ts` (drop `?token=`, switch to `?ticket=`, de-dup by `(id, userId)`).
7. **Store** — `agenticStore.ts` (`clearOnLogout` improvements + IDB clear).
8. **Provider** — `AgenticProvider.tsx` (preload `/auth/me`, profileReady, per-user namespacing, tenant-config promise cache, dept config hydration, rehydrate on user/impersonation change).
9. **Hooks** — `useArcaConfig.ts` (selectors, `CONFIG_NOT_READY` guards), `useArcaContext.ts` (selectors), `useArca.ts` (selectors for personalization references only), `useAuth.ts` (wire `setImpersonationReadOnly` to `impersonate`/`endImpersonation`).

### 3.3 Verification criteria

- `pnpm test --filter @arcaai/vox` → all tests pass.
- `pnpm build --filter @arcaai/vox` → builds clean.
- `ReadLints` on every modified file → no new lint errors.

---

## 4. Implementation Summary

### 4.1 Files modified (owned by TASK-297)

**SDK core:**
- `packages/agentic-sdk-v2/src/core/ConfigManager.ts` — 4-tier cascade (`SYSTEM ← tenant ← department ← user`); new `setDepartmentConfig(overrides, lockedPaths?)`, `clearDepartmentConfig()`, `getDepartmentLockedPaths()`; `resolve()` treats `tenantLockedPaths ∪ departmentLockedPaths` as the union for user-strip; new `ConfigEventType` value `'departmentConfigChanged'`; new `ConfigManagerLogger` (`logger` option) used by `loadUserPreferences` + `persistUserPreferences` to surface errors via `logger.warn(...)` (DEF-C5, DEF-L3).
- `packages/agentic-sdk-v2/src/core/ConfigSchema.ts` — `ConfigPermission` extended with `'department'`; `canUserEditField` / `canDepartmentEditField` updated accordingly (DEF-C5).
- `packages/agentic-sdk-v2/src/core/PersonalizationManager.ts` — `syncToBackend` switched from `apiClient.post` to `apiClient.patch` (DEF-H2); new `setImpersonationReadOnly(flag)` makes `updatePreferences` in-memory only when `true` — neither `saveLocal()` nor `syncToBackend()` is called (H-4); new `setConfigManager(cm)` + `PERSONALIZATION_FORWARDS` map forwards overlapping fields into `ConfigManager.setUserValue` (DEF-H4); legacy `localConfig` writes kept and `@deprecated`-tagged for backward compat.
- `packages/agentic-sdk-v2/src/core/SimpleCrossTabSync.ts` — Fallback `BroadcastChannel` name (when `tenantId` is missing) now uses `sha256First8Hex(consultationKey)` — channel creation is async; new `whenReady()` public API; `isAvailable()` reports capability only (DEF-M1).
- `packages/agentic-sdk-v2/src/core/AgenticClient.ts` — `REFRESH_SKIP_ENDPOINTS` const adds `/auth/login`, `/auth/stream-ticket`, `/auth/impersonate` to the 401-refresh skip-list (H-HTTP-1); `postFormData` now has the same 401 → refresh → retry path as `request()` (M-HTTP-3); `requestTimestamps` bounded by `MAX_REQUEST_TIMESTAMPS` (L-HTTP-4).
- `packages/agentic-sdk-v2/src/core/SharedConnectionWorker.ts` — SSE auth switched from `?token=<jwt>` to `?ticket=<…>`; subscriptions de-duped by `(id, userId)` not `id` alone (C-SSE-1, H-SSE-5).
- `packages/agentic-sdk-v2/src/core/SharedConnectionManager.ts` — Fallback `EventSource` path also uses `?ticket=`; `unsubscribeSSE` forwards `userId`.
- `packages/agentic-sdk-v2/src/core/constants.ts` — Removed dead `STORAGE_KEYS.SESSION_STATE` (DEF-L1); `DEPARTMENT_ENDPOINTS.PROMPT_CONFIG` already existed in HEAD (TASK-295 surfaced it) and is now referenced from `AgenticProvider`. No `STT_V2_ENDPOINTS` / `VOICE_EMBEDDING_ENDPOINTS` / `PIPELINE_ENDPOINTS` / `CONSULTATION_ENDPOINTS` / `SUMMARY_ENDPOINTS` modifications.

**Types:**
- `packages/agentic-sdk-v2/src/types/common.ts` — `AgenticErrorCode` extended with `'CONFIG_NOT_READY'`.

**Providers:**
- `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx` — Preloads `/auth/me` via `apiClient.get(AUTH_ENDPOINTS.ME)` BEFORE flipping `configReady`; new `profileReady` state; per-user-per-tenant IDB and localStorage namespacing via `makeNamespace(tenantId, userId)` with `pre-login` fallback; tenant-config promise cached in `tenantConfigPromiseRef` to avoid double-fetch (DEF-H5); department config hydrated via `configManager.setDepartmentConfig(...)` when `me.departmentId` is present; second effect re-hydrates `ConfigManager` whenever `authUser?.id` or `authImpersonatedUser` changes (DEF-C6, DEF-H1, DEF-H5).

**Store:**
- `packages/agentic-sdk-v2/src/store/agenticStore.ts` — New `profileReady: boolean` state + `setProfileReady` / `setPersonalizationManager` actions; `clearOnLogout` now (a) removes legacy `arcaai-preferences` / `arcaai-selected-models` keys, (b) sweeps all `arcaai-user-preferences/...` namespaced keys, (c) clears the `user-preferences` object store inside the `arcaai-config` IDB, (d) resets `preferences`, `tenantConfig`, `resolvedConfig`, `configReady`, `profileReady`, `configManager`, `personalizationManager`. New selectors: `selectProfileReady`, `selectPersonalizationManager`, `selectAuthUser`, `selectAuthImpersonatedUser`, `selectModelRegistry`, `selectModelRegistryVersion`, `selectSharedContext`, `selectContextLoading`, `selectContextError` (DEF-H6, DEF-H1, DEF-H3).
- `packages/agentic-sdk-v2/src/store/index.ts` — Re-exports the new selectors so hooks can import from `../store`.

**Hooks:**
- `packages/agentic-sdk-v2/src/hooks/useArcaConfig.ts` — Whole-store subscription removed; replaced with discrete `useAgenticStore(selectX)` calls; new `requireReady(operation)` helper throws `AgenticError('CONFIG_NOT_READY', ...)` from `update`, `reset`, `selectModel`, `setUserPreference`, `resetUserPreferences` when `configReady === false` (DEF-H3, DEF-C6).
- `packages/agentic-sdk-v2/src/hooks/useArcaContext.ts` — Whole-store subscription removed; uses atomic selectors for `apiClient`, `consultation`, `contextItems`, `entities`, `sharedContext`, `contextLoading`, `contextError`, `sdkLogger`, and direct Zustand action access (DEF-H3).
- `packages/agentic-sdk-v2/src/hooks/useArca.ts` — Verified: no personalization slices read from the bare store; left untouched per ownership matrix (audio / pipeline / transcription sections are TASK-298).
- `packages/agentic-sdk-v2/src/hooks/useAuth.ts` — `impersonate` flips `personalizationManager.setImpersonationReadOnly(true)` after `setImpersonatedUser`; `endImpersonation` flips it `false` after `restoreUserPreferences` (H-4).
- `packages/agentic-sdk-v2/src/hooks/useSharedConnection.ts` — `UseSharedSSEOptions` replaces `authToken` with `ticket` + `userId`; subscribe / unsubscribe forward both (C-SSE-1, H-SSE-5).

### 4.2 New / extended tests

| # | File | Scope |
|---|------|-------|
| 1 | `packages/agentic-sdk-v2/src/core/__tests__/ConfigManager.test.ts` | 4-tier merge precedence; union-of-locked-paths strip; `departmentConfigChanged` event; logger.warn on load failure. |
| 2 | `packages/agentic-sdk-v2/src/core/__tests__/ConfigSchema.test.ts` | `'department'` permission tier accepted; `canUserEditField` rejects `'department'` paths. |
| 3 | `packages/agentic-sdk-v2/src/core/__tests__/PersonalizationManager.test.ts` | `syncToBackend` uses PATCH; `setImpersonationReadOnly(true)` blocks `saveLocal()` + `syncToBackend()`; forwarding into `ConfigManager.setUserValue`. |
| 4 | `packages/agentic-sdk-v2/src/core/__tests__/SimpleCrossTabSync.test.ts` | Fallback channel name is SHA-256 hash (16-hex); raw `consultationKey` is NOT in name; stable across same input; distinct across different inputs; async readiness via `whenReady()`. |
| 5 | `packages/agentic-sdk-v2/src/core/__tests__/AgenticClient.refreshMutex.test.ts` | 401 on `/auth/login`, `/auth/stream-ticket`, `/auth/impersonate` does NOT trigger refresh. |
| 6 | `packages/agentic-sdk-v2/src/core/__tests__/AgenticClient.test.ts` | `postFormData` 401 → refresh → retry; `requestTimestamps` bounded. |
| 7 | `packages/agentic-sdk-v2/src/core/__tests__/SharedConnectionManager.test.ts` | Fallback SSE never appends `?token=`; appends `?ticket=` when provided; de-dup by `(id, userId)`. |
| 8 | `packages/agentic-sdk-v2/src/core/__tests__/constants.test.ts` | Asserts `'SESSION_STATE' in STORAGE_KEYS === false`. |
| 9 | `packages/agentic-sdk-v2/src/providers/__tests__/AgenticProvider.task297.test.ts` (NEW) | `configReady` stays false until `/auth/me` resolves; tenant config fetched once; `configReady` stays false on `/auth/me` failure; `/auth/me` not called when no credentials. |
| 10 | `packages/agentic-sdk-v2/src/hooks/__tests__/useArcaConfig.test.ts` | Selector-aware mock; `update`, `reset`, `selectModel`, `setUserPreference`, `resetUserPreferences` all throw `AgenticError('CONFIG_NOT_READY')` when `configReady === false`. |
| 11 | `packages/agentic-sdk-v2/src/hooks/__tests__/useArcaContext.test.ts` | Selector-aware mock; selectors are invoked with the state, not the whole store. |
| 12 | `packages/agentic-sdk-v2/src/store/__tests__/agenticStore.test.ts` | `clearOnLogout` resets personalization tier + namespaced localStorage keys (DEF-H6 / DEF-H1). |

### 4.3 Verification

| Gate | Command | Result |
|------|---------|--------|
| Unit tests | `pnpm vitest run` (in `packages/agentic-sdk-v2`) | **122 test files / 2856 tests passing.** One pre-existing failure remains in `core/__tests__/constants.task210.test.ts` (`STT_V2_ENDPOINTS should have exactly 15 keys` — now 16) caused by an unstaged `STT_V2_ENDPOINTS.REFRESH_TICKET` addition in the worktree that belongs to TASK-298's STT WS reconnect work; **not introduced by TASK-297** (see §4.4). |
| Build | `pnpm build` (in `packages/agentic-sdk-v2`) | ✅ ESM + CJS bundles emitted successfully (`dist/index.{mjs,js}`, `dist/plugins.{mjs,js}`, `e2e/fixtures/dist/e2e-bundle.mjs`). |
| Lint | `pnpm lint` | ✅ 0 errors. 34 pre-existing prettier warnings in files NOT owned by TASK-297 (types/dna.ts, types/index.ts, types/stt-v2.ts, utils/idempotency.ts, utils/index.ts, utils/secureStorage.ts, core.ts, FileTranscriptionService.ts, SttV2WebSocketClient.ts, useDnaStyle.ts, useVoiceEmbedding.ts, useVoiceEnrollmentStatus.ts, and one in constants.ts on the TASK-298 `REFRESH_TICKET` line). **Zero lint warnings on TASK-297-owned files.** |
| ReadLints | All 16 owned source files | ✅ No errors. |

### 4.4 Out of scope / hand-off

- **Pre-existing worktree changes in TASK-298 files.** When TASK-297 started, the worktree already contained unstaged modifications to `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts` and a new `STT_V2_ENDPOINTS.REFRESH_TICKET` entry in `packages/agentic-sdk-v2/src/core/constants.ts`. These changes belong to TASK-298 (real-time STT reconnect / ticket refresh) and TASK-297 left them untouched per the ownership matrix. The single failing test (`constants.task210.test.ts → STT_V2_ENDPOINTS should have exactly 15 keys`) is a structural-drift guard owned by TASK-210/TASK-298 that needs to be updated when TASK-298 ships `REFRESH_TICKET`. Hand off to TASK-298 to bump the expected key count from 15 → 16 and append `REFRESH_TICKET` to the `expect.arrayContaining([...])` list.
- **Backend `MeResponse.departmentId` exposure** — TASK-295. AgenticProvider consumes `me?.departmentId` defensively; if absent, the cascade gracefully degrades to 3-tier.
- **Backend `/admin/departments/:id/prompt-config` AuthZ + IDOR hardening** — parent W5A-10 backend ticket.
- **`PromptTemplate.scope` / `ownerUserId` schema (DEF-C1)** — backend (parent W5B-7).
- **`/prompt-templates/assign-department` route (DEF-C4)** — backend (parent W5B-8).
- **`StreamingSessionManager`, `SttV2WebSocketClient`, `PluginManager`, `useArcaAudio`, `usePipelines`, `useConsultationJob`, `useArcaSummary`, `useDnaStyle`, `useVoiceEmbedding`, `useVoiceEnrollmentStatus`** — TASK-296 / 298 / 299. Excluded per ownership matrix.

### 4.5 Backward compatibility

- `PersonalizationManager.updatePreferences` keeps its original signature; the new forwarding into `ConfigManager.setUserValue` is additive and the legacy `localConfig` write path is preserved + tagged `@deprecated`. Existing consumers continue to read the same fields.
- `SharedConnectionWorker` / `SharedConnectionManager` still accept the older `authToken` field on the SSE subscription shape for one release, but it is ignored — callers must mint a ticket via `apiClient.post('/auth/stream-ticket', ...)` and pass it as `ticket`. (Documented in §4.1.)
- The 4-tier cascade is a strict super-set of the 3-tier one: if `setDepartmentConfig` is never called, behaviour is identical to the prior `SYSTEM ← tenant ← user` merge.

---

## 5. Change History

| Date | Author | Notes |
|---|---|---|
| 2026-05-24 | SDK team | Created TASK-297. Plan drafted against TASK-293 W5A-11/-12, W5B-9/-10/-11/-12/-13, W5C-1/-14, and the per-defect breakdown in 01-personalization-settings.md (DEF-C5, C6, H1–H6, M1, L1, L3), 05-impersonation.md (H-4), 06-transports.md (H-HTTP-1, M-HTTP-3, L-HTTP-4, C-SSE-1, H-SSE-5). Status set to **In Progress**. |
| 2026-05-24 | SDK team | Implementation completed across all 14 owned files. Phase 3 verification: 2856 / 2857 tests pass (1 pre-existing TASK-298 structural-drift failure unrelated to TASK-297), build clean, 0 lint errors on owned files. Status moved to **Completed**. |
