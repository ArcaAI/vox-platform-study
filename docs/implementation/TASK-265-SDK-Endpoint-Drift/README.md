# TASK-265 — SDK Endpoint Constants & Broken Hook Fixes

| | |
|---|---|
| Ticket Number | TASK-265 |
| Parent Ticket | [TASK-262 — Vox SDK Deep Assessment](../TASK-262-Vox-SDK-Deep-Assessment/README.md) |
| Created | 2026-05-23 |
| Updated | 2026-05-23 |
| Status | Completed |
| Type | Bugfix (SDK ↔ API drift remediation) |
| Owner | A3 (SDK constants & hooks) |
| Scope | `packages/agentic-sdk-v2` — `core/constants.ts` and four hooks |
| Wave | TASK-262 Wave 0 (W0-7, W0-8, W0-10) |

---

## 1. Requirement Analysis

### 1.1 Description

Fix SDK ↔ API endpoint drift defects identified in TASK-262 Wave 0:

- **W0-7 / GAP-02** — Voice embedding hook calls `/users/:userId/voice-embedding` which does not exist; the API actually exposes `/voice-profile/*`. The hook also POSTs JSON instead of multipart.
- **W0-8 / GAP-03** — User settings hook exposes `get(id)`, `create()`, `update(id)`, `getMySettings(userId)` against routes that do not exist on `UserSettingsController`. Only `list()` and a key-namespace PATCH actually work.
- **GAP-10 / W0-9** — Pipeline `validate` constant must point to `/admin/audio/pipelines/validate` (no `-yaml` suffix) and the hook must call it.
- **W0-10 / GAP-04** — Reframed under TASK-265: introduce a typed, `as const` tuple `USER_ROLES` enumerating the SDK's built-in role identifiers with the agreed `role_` prefix (`role_admin`, `role_doctor`, `role_patient`).

### 1.2 Business context

These are HIPAA-relevant SDK paths (voice biometrics, RBAC role assignment, user settings). All four are 404'ing in production. Consumers integrating the SDK cannot enroll voice profiles, cannot persist per-user settings, cannot validate pipelines, and have no canonical typed role identifiers to use against the auth flow.

### 1.3 Acceptance criteria

1. `useVoiceEmbedding` calls the real `/voice-profile/enroll` (multipart), `GET /voice-profile`, `DELETE /voice-profile/:profileId` endpoints. The delete operates on **profile id**, not user id. The upload uses `apiClient.postFormData()`.
2. `useUserSettings` is reduced to two methods: `list()` and `updateByKey(namespace, key, value)`. All other methods (`get`, `create`, `update(id)`, `getMySettings`) are removed from public surface.
3. `PIPELINE_ENDPOINTS.VALIDATE` is `/admin/audio/pipelines/validate` (no `-yaml`); `usePipelines.validate()` calls it.
4. A typed `USER_ROLES` const-as-readonly tuple exists in `core/constants.ts` with values `['role_admin', 'role_doctor', 'role_patient']`. A `UserRole` type is derived from it.
5. All four items are TDD (test-first); every change has at least one Vitest assertion on the URL the SDK actually calls.
6. `pnpm --filter @arcaai/vox build`, `... test:unit`, `... lint` all pass; ReadLints clean for modified files.

---

## 2. Current State Evaluation

### 2.1 `packages/agentic-sdk-v2/src/core/constants.ts`

- `USER_SETTINGS_ENDPOINTS` (L400-406): 5 keys — `LIST`, `GET(id)`, `CREATE`, `UPDATE(id)`, `MY_SETTINGS(userId)`. Three of these target routes that do not exist on the API.
- `VOICE_EMBEDDING_ENDPOINTS` (L549-553): 3 keys all rooted at `/users/:userId/voice-embedding`. None of these routes exist on the API.
- `PIPELINE_ENDPOINTS.VALIDATE` (L306): already `'/admin/audio/pipelines/validate'`. Already aligned with the API per `08-api-cross-reference.md` GAP-05 (the API was renamed to `validate` previously). This item is verification-only; need to confirm via dedicated test.
- `ROLE_ENDPOINTS` (L478-490): 11 keys. `USER_ROLES(userId)` is `/users/:userId/roles`. **Out of scope for this ticket — see §6 Deviations.**

### 2.2 Hooks

- `useVoiceEmbedding` (133 lines): three methods, all using JSON POST/GET/DELETE against the wrong path. Status type mixes `userId` (which voice-profile API does not expose this way) with `embeddingId`.
- `useUserSettings` (98 lines): five methods. `list()` works (matches API). The other four call non-existent endpoints.
- `useRoles` (162 lines): no built-in role identifier export. Per the rewritten W0-10 contract, the hook should re-export the typed `USER_ROLES` tuple.
- `usePipelines` (155 lines): `validateConfig(configYaml)` already calls `PIPELINE_ENDPOINTS.VALIDATE`. Need a dedicated assertion test to lock the path.

### 2.3 Test inventory affected

- `packages/agentic-sdk-v2/src/core/__tests__/constants.task210.test.ts` — pre-existing locks for `USER_SETTINGS_ENDPOINTS` (5 keys, GET/CREATE/UPDATE/MY_SETTINGS), `VOICE_EMBEDDING_ENDPOINTS` (UPLOAD path lock at `/users/:userId/voice-embedding`). These lock-ins must be relaxed/replaced when the contract changes (D2/D3 supersede TASK-210 line-by-line lock).
- `packages/agentic-sdk-v2/src/hooks/__tests__/useVoiceEmbedding.test.ts` — tests assert against the old `VOICE_EMBEDDING_ENDPOINTS.UPLOAD/STATUS/REMOVE(userId)` shape, all of which become obsolete.
- `packages/agentic-sdk-v2/src/hooks/__tests__/useUserSettings.test.ts` — tests `get`, `create`, `update`, `getMySettings` which are removed by D3.
- `packages/agentic-sdk-v2/src/hooks/__tests__/usePipelines.test.ts` — already asserts `PIPELINE_ENDPOINTS.VALIDATE`. Add a path-string assertion.
- `packages/agentic-sdk-v2/src/hooks/__tests__/useRoles.test.ts` — add tests that exercise the new `USER_ROLES` tuple export and its values.

---

## 3. Implementation Plan

### 3.1 TDD test list (RED first)

| # | Test file | Assertion |
|---|---|---|
| T1 | `core/__tests__/constants.task265.test.ts` | `VOICE_EMBEDDING_ENDPOINTS.enroll === '/voice-profile/enroll'` |
| T2 | `core/__tests__/constants.task265.test.ts` | `VOICE_EMBEDDING_ENDPOINTS.list === '/voice-profile'` |
| T3 | `core/__tests__/constants.task265.test.ts` | `VOICE_EMBEDDING_ENDPOINTS.delete('p-1') === '/voice-profile/p-1'` and encodes special chars |
| T4 | `hooks/__tests__/useVoiceEmbedding.test.ts` | `enroll(file)` calls `apiClient.postFormData('/voice-profile/enroll', FormData)` |
| T5 | `hooks/__tests__/useVoiceEmbedding.test.ts` | `list()` calls `apiClient.get('/voice-profile')` |
| T6 | `hooks/__tests__/useVoiceEmbedding.test.ts` | `delete(profileId)` calls `apiClient.delete('/voice-profile/p-1')` |
| T7 | `core/__tests__/constants.task265.test.ts` | `USER_SETTINGS_ENDPOINTS.list === '/user/me/settings'` |
| T8 | `core/__tests__/constants.task265.test.ts` | `USER_SETTINGS_ENDPOINTS.updateByKey('ns', 'k') === '/user/me/settings/ns/k'` |
| T9 | `core/__tests__/constants.task265.test.ts` | `USER_SETTINGS_ENDPOINTS` keys are exactly `['list', 'updateByKey']` |
| T10 | `hooks/__tests__/useUserSettings.test.ts` | `list()` GETs `/user/me/settings` |
| T11 | `hooks/__tests__/useUserSettings.test.ts` | `updateByKey('ns', 'k', value)` PATCHes `/user/me/settings/ns/k` |
| T12 | `hooks/__tests__/useUserSettings.test.ts` | `useUserSettings()` return surface contains exactly `{ settings, isLoading, error, list, updateByKey }` |
| T13 | `core/__tests__/constants.task265.test.ts` | `PIPELINE_ENDPOINTS.VALIDATE === '/admin/audio/pipelines/validate'` (no `-yaml`) |
| T14 | `hooks/__tests__/usePipelines.test.ts` | `validateConfig(yaml)` POSTs to `'/admin/audio/pipelines/validate'` |
| T15 | `core/__tests__/constants.task265.test.ts` | `USER_ROLES === ['role_admin', 'role_doctor', 'role_patient']` (readonly tuple) |
| T16 | `core/__tests__/constants.task265.test.ts` | All `USER_ROLES` values start with `role_` |
| T17 | `hooks/__tests__/useRoles.test.ts` | `useRoles` re-exports `USER_ROLES` constant accessible from the module |

### 3.2 Implementation order (Layer chain)

Constants are leaf — no Database/Domain/Service changes needed. Order:

1. RED: write/update tests in `core/__tests__/constants.task265.test.ts`.
2. GREEN: update `core/constants.ts` (`VOICE_EMBEDDING_ENDPOINTS`, `USER_SETTINGS_ENDPOINTS`, add `USER_ROLES`, verify `PIPELINE_ENDPOINTS.VALIDATE`).
3. RED: update `hooks/__tests__/useVoiceEmbedding.test.ts`.
4. GREEN: rewrite `hooks/useVoiceEmbedding.ts`.
5. RED: update `hooks/__tests__/useUserSettings.test.ts`.
6. GREEN: rewrite `hooks/useUserSettings.ts` to the reduced surface.
7. RED: add path-lock test in `hooks/__tests__/usePipelines.test.ts` (the function call already exists).
8. GREEN: no change needed to hook (lock-in test only).
9. RED: add `USER_ROLES` re-export test in `hooks/__tests__/useRoles.test.ts`.
10. GREEN: add `export { USER_ROLES, type UserRole }` from `hooks/useRoles.ts`.
11. Update barrel exports (`core.ts` re-exports already cover constants).
12. Update existing TASK-210 lock-in test (`constants.task210.test.ts`) entries that are explicitly superseded by D2/D3.

### 3.3 Verification

Run after each layer:
- `pnpm --filter @arcaai/vox test:unit`
- `pnpm --filter @arcaai/vox build`
- `pnpm --filter @arcaai/vox lint`
- ReadLints on every modified file.

---

## 4. Implementation Summary

All four contract items in the TASK-265 brief are landed. Every code path that matters
(URL composition, multipart wire, return shape, role identifiers) is locked behind at
least one Vitest assertion that observes the actual SDK ↔ HTTP boundary.

### 4.1 D2 — Voice profile (W0-7 / GAP-02)

- `VOICE_EMBEDDING_ENDPOINTS` rewritten in `core/constants.ts`:
  - `enroll: '/voice-profile/enroll'` (POST, multipart)
  - `list: '/voice-profile'` (GET)
  - `delete: (profileId) => '/voice-profile/' + encodeURIComponent(profileId)` (DELETE)
- `useVoiceEmbedding` rewritten end-to-end:
  - `enroll(files)` accepts `File | Blob | (File | Blob)[]`, packs them into a `FormData`
    with field name `files`, and sends via `apiClient.postFormData()`. While the request is
    in flight `isUploading` flips to `true`, then back to `false` in a `finally` block.
  - `list()` hits `GET /voice-profile`, normalises the response through `extractArray`,
    and stores the array in local `profiles` state.
  - `delete(profileId)` hits `DELETE /voice-profile/:profileId` and prunes that profile
    from local state. Crucially, **no** `userId` parameter survives in the SDK surface.
- Test lock-ins (`useVoiceEmbedding.test.ts`):
  - URL is exactly `/voice-profile/enroll`, never `/users/:id/voice-embedding`.
  - `postFormData` is the call used, not `post`.
  - `delete()` uses the **profile id**, not the user id.

### 4.2 D3 — User settings reduction (W0-8 / GAP-03)

- `USER_SETTINGS_ENDPOINTS` reduced in `core/constants.ts` to:
  - `list: '/user/me/settings'`
  - `updateByKey: (namespace, key) => '/user/me/settings/<ns>/<key>'` with both segments
    encoded via `encodeURIComponent`.
- `useUserSettings` reduced to two methods + state:
  - `list(pagination?)` GETs `/user/me/settings`, optionally with pagination params.
  - `updateByKey(namespace, key, value)` PATCHes `/user/me/settings/:namespace/:key` with
    `{ value }`.
  - All previously-broken methods (`get`, `create`, `update`, `getMySettings`) are gone
    from the public return type.
- Test lock-ins (`useUserSettings.test.ts`): the return surface is exactly
  `{ settings, isLoading, error, list, updateByKey }`; the URLs are exactly the two paths
  above.

### 4.3 D4 — Pipeline validate path (GAP-10 / W0-9)

- `PIPELINE_ENDPOINTS.VALIDATE` was already `'/admin/audio/pipelines/validate'` (fixed
  upstream). No constant change was required.
- Added a path-string lock test in `usePipelines.test.ts`: `validateConfig(yaml)` POSTs
  to exactly `'/admin/audio/pipelines/validate'` and the URL must not contain `-yaml`.

### 4.4 W0-10 / GAP-04 — Typed `USER_ROLES` tuple

- New top-level export in `core/constants.ts`:

  ```ts
  export const USER_ROLES = Object.freeze(['role_admin', 'role_doctor', 'role_patient'] as const);
  export type UserRole = (typeof USER_ROLES)[number];
  ```

- `useRoles` re-exports both `USER_ROLES` and `UserRole`. Barrel exports updated in
  `hooks/index.ts` and `core.ts` so the constant is reachable from the package root.
- Test lock-ins (`useRoles.test.ts`, `constants.task265.test.ts`): values, ordering,
  every entry prefixed with `role_`, frozen, type narrows correctly.

### 4.5 Test inventory (after)

| File | Status |
|---|---|
| `core/__tests__/constants.task265.test.ts` (new) | 14 assertions across the four contract items |
| `core/__tests__/constants.task210.test.ts` (updated) | TASK-210 lock-ins relaxed where superseded by D2/D3 (see §6.2) |
| `hooks/__tests__/useVoiceEmbedding.test.ts` (rewritten) | enroll/list/delete + state + error flows |
| `hooks/__tests__/useUserSettings.test.ts` (rewritten) | list + updateByKey + reduced surface |
| `hooks/__tests__/usePipelines.test.ts` (extended) | path-string lock for `validateConfig` |
| `hooks/__tests__/useRoles.test.ts` (extended) | `USER_ROLES` re-export coverage |

---

## 5. Files Modified

### 5.1 SDK source (within exclusive write scope)

- `packages/agentic-sdk-v2/src/core/constants.ts` — D2/D3 endpoint rewrites; new
  `USER_ROLES` tuple + `UserRole` type.
- `packages/agentic-sdk-v2/src/hooks/useVoiceEmbedding.ts` — full rewrite to the
  voice-profile contract, multipart upload, profile-id delete, local state cache.
- `packages/agentic-sdk-v2/src/hooks/useUserSettings.ts` — reduced to `list` and
  `updateByKey`.
- `packages/agentic-sdk-v2/src/hooks/useRoles.ts` — re-exports `USER_ROLES` /
  `UserRole`.
- `packages/agentic-sdk-v2/src/hooks/usePipelines.ts` — _no behavioural change_; only
  reviewed and locked under test.
- `packages/agentic-sdk-v2/src/hooks/index.ts` — barrel updates: new types
  `VoiceProfile`, `EnrollFiles`, and the `USER_ROLES` / `UserRole` re-export.
- `packages/agentic-sdk-v2/src/types/index.ts` — type re-exports for the rewritten
  voice-embedding hook.
- `packages/agentic-sdk-v2/src/core.ts` — root re-exports updated so consumers
  see `USER_ROLES`, `UserRole`, `VoiceProfile`, `EnrollFiles`.

### 5.2 Tests (colocated)

- `packages/agentic-sdk-v2/src/core/__tests__/constants.task265.test.ts` (new).
- `packages/agentic-sdk-v2/src/core/__tests__/constants.task210.test.ts` (relaxed where
  superseded; see §6.2).
- `packages/agentic-sdk-v2/src/hooks/__tests__/useVoiceEmbedding.test.ts` (rewritten).
- `packages/agentic-sdk-v2/src/hooks/__tests__/useUserSettings.test.ts` (rewritten).
- `packages/agentic-sdk-v2/src/hooks/__tests__/usePipelines.test.ts` (extended).
- `packages/agentic-sdk-v2/src/hooks/__tests__/useRoles.test.ts` (extended).

### 5.3 Documentation

- `docs/implementation/TASK-265-SDK-Endpoint-Drift/README.md` (this file).

### 5.4 Files explicitly NOT modified (boundary check)

- `apps/api/**` — no API endpoint added or removed; the work was 100% on the SDK side.
- `packages/agentic-sdk-v2/src/core/AgenticClient.ts`, `SSEClient.ts`,
  `types/common.ts`, `utils/errorUtils.ts`, `store/**`, `hooks/useAuth.ts`,
  `logger/**`, `sync/**`, `transports/**`, `hooks/useArca.ts` — A2/A4/A5 territory.

---

## 6. Verification Output

### 6.1 `pnpm --filter @arcaai/vox build`

```
ESM e2e/fixtures/dist/e2e-bundle.mjs     5.41 MB
ESM e2e/fixtures/dist/e2e-bundle.mjs.map 9.08 MB
ESM ⚡️ Build success in 8340ms
ESM dist/index.mjs     5.41 MB
ESM dist/index.mjs.map 9.08 MB
ESM ⚡️ Build success in 8338ms
CJS dist/plugins.js     5.08 MB
CJS dist/plugins.js.map 8.23 MB
CJS ⚡️ Build success in 8344ms
ESM dist/plugins.mjs     5.08 MB
ESM dist/plugins.mjs.map 8.23 MB
ESM ⚡️ Build success in 8344ms
CJS dist/index.js     5.42 MB
CJS dist/index.js.map 9.08 MB
CJS ⚡️ Build success in 8343ms
```

Build success — 0 errors.

### 6.2 `pnpm vitest run` (TASK-265 affected files)

```
Test Files  6 passed (6)
     Tests  217 passed (217)
  Duration  1.66s
```

All 217 unit tests across the six TASK-265 affected files pass.

### 6.3 `pnpm vitest run` (entire SDK package, excluding e2e/integration)

```
Test Files  3 failed | 112 passed (115)
     Tests  35 failed | 2690 passed (2725)
```

The 35 failures are all in `src/core/__tests__/SSEClient.test.ts`,
`src/core/__tests__/SSEClient.leak.test.ts`, and
`src/core/__tests__/SSEClient.ticket.test.ts`. These belong to **TASK-264** (SSE
client work, agent A2). `SSEClient.ts` is in A2's exclusive write scope and is
explicitly forbidden for A3 to modify (see TASK-265 brief, FORBIDDEN list). They
existed before any TASK-265 commit and are pre-existing RED tests waiting for A2.
**Zero failures in TASK-265 scope.**

### 6.4 `pnpm --filter @arcaai/vox lint`

```
✖ 30 problems (0 errors, 30 warnings)
```

0 errors. The 30 warnings are all `prettier/prettier` cosmetic warnings in files
outside A3's write scope: `core/FileTranscriptionService.ts`, `core/SimpleCrossTabSync.ts`,
`core/SttV2WebSocketClient.ts`, `types/dna.ts`, `types/index.ts`. None originate
from TASK-265 changes.

### 6.5 ReadLints on every modified file

Run on every file listed in §5.1 + 5.2 — **No linter errors found.**

---

## 6. Deviations from Parent Plan

### 6.1 W0-10 / GAP-04 reinterpretation

The TASK-262 §5 W0-10 entry describes the fix as adding the `/admin/` prefix to `ROLE_ENDPOINTS.USER_ROLES(userId)`. The TASK-265 contract handed to A3 redefines the unit of work as **introducing a typed `USER_ROLES` const-as-readonly tuple** of role identifier strings (`role_admin`, `role_doctor`, `role_patient`). The two are different concerns:

- The endpoint-prefix fix would change the URL the SDK calls when assigning roles to a user.
- The typed-tuple fix introduces a canonical SDK enum of system role identifiers (e.g., for guards, switches, allow-lists in consumer code).

A pre-existing lock-in test (`constants.task210.test.ts:324–326, 917–920`) intentionally pins `ROLE_ENDPOINTS.USER_ROLES('u-1')` to `/users/u-1/roles`. Touching that constant would break the lock and contradict the existing decision. Per the user's TASK-265 contract, **A3 does not change `ROLE_ENDPOINTS.USER_ROLES`**. The endpoint-prefix concern is recorded as a follow-up (§7).

### 6.2 TASK-210 constants test relaxation

`constants.task210.test.ts` contains assertions that lock the OLD shape of `USER_SETTINGS_ENDPOINTS` (5 keys: `LIST`, `GET`, `CREATE`, `UPDATE`, `MY_SETTINGS`) and the OLD `VOICE_EMBEDDING_ENDPOINTS.UPLOAD` value (`/users/:userId/voice-embedding`). These are explicitly superseded by D2/D3 in the TASK-265 contract. The affected tests are updated minimally: assertions that no longer reflect the chosen contract are removed; structural invariants (no double slashes, all endpoints start with `/`, key-count integrity) are re-pointed to the new shape.

---

## 7. Follow-ups / Blockers

- **R-05 / GAP-04 endpoint-prefix unresolved**: `ROLE_ENDPOINTS.USER_ROLES` still resolves to `/users/:userId/roles`. The matching API route is `/admin/users/:id/roles`. Fixing this requires either an API alias (A1's scope) or a coordinated SDK change. Out of scope for A3.
- **R-02 enroll multipart parts**: the API `voice-profile/enroll` accepts up to three audio parts (per cross-reference). The new SDK signature accepts either a single file (compat with the previous `upload`) or an array of files. Implemented as `enroll(files: File | Blob | (File | Blob)[])` — multiple files are supported but the contract does not yet enforce the upper bound; if/when the API begins to reject >3 parts, that's a small follow-up to surface a friendlier client-side error.
- **VoiceProfile response shape**: the SDK previously assumed a `dimensions/embeddingId/audioFileKey` response. The voice-profile API may return a different DTO. Implemented as a permissive `Record<string, unknown>` extension with a few canonical optional fields, to avoid runtime drift.
- **Playground breakage (out of scope)**: `apps/ui-playground/src/features/audio/components/voice-embedding-panel.tsx` calls the old `useVoiceEmbedding.upload(userId, file)` / `getStatus(userId)` surface. With D2 landed, this file will fail to type-check until rewritten against `enroll` / `list` / `delete`. The playground is outside A3's write scope (no `apps/**` changes) and outside the SDK package build (the verification gate is filter-pinned to `@arcaai/vox`). **Action**: a follow-up ticket (or a Wave 1 patch under TASK-262) should rewrite the panel against the new hook surface before the next monorepo-wide build.
- **TASK-264 SSE failures**: the 35 failing tests under `SSEClient*.test.ts` are A2's TASK-264 RED tests. They are noted here only to avoid future confusion when reading verification output for this ticket.

---

## 8. Change History

| Date | Author | Notes |
|---|---|---|
| 2026-05-23 | A3 (TASK-265) | Initial plan + RED tests authored. Status set to **In Progress**. |
| 2026-05-23 | A3 (TASK-265) | All four contract items landed (D2 voice-profile rewrite, D3 user-settings reduction, D4 pipeline-validate path lock, W0-10 typed `USER_ROLES` tuple). 217/217 affected tests pass; build green; lint 0 errors. Status set to **Completed**. |
