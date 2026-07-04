# TASK-245: Admin User Preferences Management & Impersonation Config Isolation

- **Type**: feature + enhancement
- **Created**: 2026-03-10
- **Updated**: 2026-03-10
- **Status**: Completed
- **Depends on**: TASK-244 (Audio Config Management Overhaul)

---

## 1. Requirement Analysis

### Description

Two related enhancements to the TASK-244 3-tier configuration system:

**Feature A — Impersonation Preference Isolation**: When an admin impersonates a user, the audio/SDK configuration panel should display a **copy** of the impersonated user's preferences. Changes made during impersonation are in-memory only and never persisted to any database or storage.

**Feature B — Admin User Preferences Management**: Admins can view and edit any user's SDK-related preferences through the User Detail management interface. TENANT_ADMIN can manage users within their own tenant. SUPER_ADMIN can manage users across all tenants.

### Business Context

- Admins need to troubleshoot user configuration issues by impersonating them with their exact settings
- Admins need to configure SDK preferences on behalf of users who cannot self-service
- TENANT_ADMIN role needs user management access scoped to their own tenant

### Acceptance Criteria

1. During impersonation, the admin sees the impersonated user's SDK preferences (not their own)
2. During impersonation, changing any preference does NOT persist to database/IndexedDB/localStorage
3. On ending impersonation, the admin's original preferences are restored
4. Admin User Detail dialog has a "Preferences" tab showing user's SDK settings
5. Admin can edit user SDK preferences and save changes via API
6. TENANT_ADMIN can access `/admin/users` scoped to their own tenant
7. SUPER_ADMIN can access `/admin/users` across all tenants
8. All new code has TDD test coverage

---

## 2. Current State Evaluation

### Impersonation (from TASK-244 audit)

| Aspect | Current State | Gap |
|--------|--------------|-----|
| Auth store | Stores `impersonatedUser`, `impersonationToken`, `isImpersonating` | No concept of impersonated user's preferences |
| ConfigManager | Always loads admin's own IndexedDB preferences | No mechanism to load another user's prefs |
| Persistence | Single key `user-preferences` in IndexedDB, not scoped per user | Admin changes during impersonation overwrite their own prefs |
| Admin client | Uses `accessToken` always, never `impersonationToken` | Correct for admin API calls |

### Admin User Management

| Aspect | Current State | Gap |
|--------|--------------|-----|
| Route guard | `/admin/users` restricted to SUPER_ADMIN only | TENANT_ADMIN cannot access |
| User detail | Tabs: Profile, Activity, Roles, API Keys | No Preferences tab |
| Backend | `GET/PATCH /user/me/settings` — current user only | No admin endpoints for other users' settings |
| Service layer | `fetchAllByUserId(userId)` exists in IUserSettingsService | Service ready, controller missing |

---

## 3. Implementation Plan

### Phase 1: Backend — Admin User Settings Endpoints

**Files:**
- Modify: `apps/api/src/modules/user/user.controller.ts`
- Modify: `apps/api/src/modules/user/user.module.ts`

**Endpoints:**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/users/:id/settings` | Get all settings for a specific user |
| PATCH | `/admin/users/:id/settings/:namespace/:key` | Upsert a specific setting for a user |

### Phase 2: SDK — ConfigManager Read-Only Mode

**Files:**
- Modify: `packages/agentic-sdk-v2/src/core/ConfigManager.ts`

**Changes:**
- Add `setReadOnly(flag: boolean)` — disables `persistUserPreferences()` calls
- Add `loadExternalPreferences(prefs)` — loads another user's prefs without triggering persistence
- Add `snapshotUserPreferences()` / `restoreUserPreferences(snapshot)` for save/restore on impersonation

### Phase 3: Frontend API — Admin User Settings Hooks

**Files:**
- Modify: `apps/ui-playground/src/features/admin/api/users.ts`

**Hooks:**
- `useAdminUserSettings(userId)` — fetches user's settings
- `useUpdateAdminUserSetting()` — upserts a setting

### Phase 4: Frontend — Impersonation Preference Isolation

**Files:**
- Modify: `apps/ui-playground/src/features/playground/overview/components/user-list.tsx`
- Modify: `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx`

**Flow:**
1. On impersonate: fetch user's settings via admin API, snapshot admin prefs, load user prefs in read-only mode
2. During impersonation: all preference changes are in-memory only
3. On end impersonation: restore admin prefs snapshot, disable read-only mode

### Phase 5: Frontend — User Preferences Tab in Admin

**Files:**
- Modify: `apps/ui-playground/src/features/admin/users/index.tsx`

**Changes:**
- Add "Preferences" tab to `UserDetailDialog`
- Reuse `ConfigValueEditor` pattern from Configurations page
- Filter settings to SDK-related namespaces only

### Phase 6: Route Guard — TENANT_ADMIN Access

**Files:**
- Modify: `apps/ui-playground/src/routes/_authenticated/admin/users.tsx`

**Changes:**
- Allow TENANT_ADMIN access (scoped to own tenant)
- SUPER_ADMIN sees all tenants/users

---

## 4. Test Plan

| Test File | Tests |
|-----------|-------|
| `ConfigManager.test.ts` | setReadOnly, loadExternalPreferences, snapshotUserPreferences, restoreUserPreferences |
| `admin-user-settings-api.test.ts` | GET/PATCH admin user settings endpoints |
| `users-api.test.ts` | useAdminUserSettings, useUpdateAdminUserSetting hooks |
| `user-detail-preferences.test.tsx` | Preferences tab rendering, editing, saving |
| `impersonation-config.test.ts` | Preference isolation flow, no persistence, restore on end |

---

## 5. Implementation Summary

### SDK Core — ConfigManager Enhancements

Added impersonation-aware lifecycle methods to `ConfigManager`:

| Method | Purpose |
|--------|---------|
| `setReadOnly(flag)` | Disables `persistUserPreferences()` — all changes stay in-memory |
| `isReadOnly()` | Returns current read-only state |
| `loadExternalPreferences(prefs)` | Replaces user preferences without persistence (for impersonation) |
| `snapshotUserPreferences()` | Deep-copies current preferences for later restoration |
| `restoreUserPreferences(snapshot)` | Restores from snapshot, respects read-only for persistence |

The existing `persistUserPreferences()` now checks `this.readOnly` before calling the callback.

### Backend — Admin User Settings Endpoints

Two new endpoints on `UserController` (`/admin/users`):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/users/:id/settings` | Fetch all settings for a specific user |
| PATCH | `/admin/users/:id/settings/:namespace/:key` | Upsert a setting for a specific user |

These reuse the existing `IUserSettingsService.fetchAllByUserId()` and `upsertByUserKeyNamespace()` methods.

### Frontend — Impersonation Preference Isolation

Modified `user-list.tsx` impersonation flow:

1. **Start impersonation**: Snapshots admin's ConfigManager preferences → enables read-only mode → fetches impersonated user's `arcaai-sdk` settings via admin API → maps them to `AppConfig` shape → loads via `loadExternalPreferences()`
2. **During impersonation**: All preference changes are in-memory only (no IndexedDB/localStorage writes)
3. **End impersonation**: Disables read-only → restores admin preferences from snapshot → persistence resumes

### Frontend — Admin User Preferences Management

Added `UserPreferencesSection` component to `UserDetailDialog`:

- Shows all `arcaai-sdk` namespace settings for the selected user
- Type-aware editing: boolean select, JSON textarea, string/number input
- Save via `PATCH /admin/users/:id/settings/:namespace/:key`
- Inline edit/save/cancel UX per setting

### Frontend — Route Guard Update

Changed `/admin/users` access from SUPER_ADMIN-only to allow SUPER_ADMIN, GLOBAL_ADMIN, and TENANT_ADMIN roles. Backend scopes data to the admin's tenant via JWT claims.

### Frontend API Hooks

Added to `features/admin/api/users.ts`:

| Hook | Purpose |
|------|---------|
| `useAdminUserSettings(userId)` | TanStack Query hook for fetching user settings |
| `useUpdateAdminUserSetting()` | Mutation hook for upserting a user setting |

---

## 6. Files Changed

| File | Status | Purpose |
|------|--------|---------|
| `packages/agentic-sdk-v2/src/core/ConfigManager.ts` | Modified | Added read-only mode, loadExternalPreferences, snapshot/restore |
| `packages/agentic-sdk-v2/src/core.ts` | Modified | Export ConfigManager, AppConfig, DeepPartial |
| `packages/agentic-sdk-v2/src/core/__tests__/ConfigManager.test.ts` | Modified | 13 new tests for TASK-245 features |
| `packages/agentic-sdk-v2/src/core/__tests__/impersonation-config.test.ts` | Created | 5 integration tests for impersonation lifecycle |
| `apps/api/src/modules/user/user.controller.ts` | Modified | Added GET/PATCH user settings endpoints |
| `apps/ui-playground/src/features/admin/api/users.ts` | Modified | Added UserSetting type, useAdminUserSettings, useUpdateAdminUserSetting |
| `apps/ui-playground/src/features/admin/api/__tests__/admin-user-settings.test.ts` | Created | 8 API integration tests |
| `apps/ui-playground/src/features/admin/users/index.tsx` | Modified | Added UserPreferencesSection, SDK_NAMESPACE, SettingValueEditor |
| `apps/ui-playground/src/features/playground/overview/components/user-list.tsx` | Modified | Impersonation preference isolation flow |
| `apps/ui-playground/src/routes/_authenticated/admin/users.tsx` | Modified | TENANT_ADMIN route access |

---

## 7. Test Evidence

### SDK ConfigManager Tests (59 tests)
```
✓ src/core/__tests__/ConfigManager.test.ts (59 tests) 19ms — 46 existing + 13 new TASK-245
```

### Impersonation Lifecycle Tests (5 tests)
```
✓ src/core/__tests__/impersonation-config.test.ts (5 tests) 3ms
```

### UI Playground Tests (195 tests)
```
✓ admin-user-settings.test.ts (8 tests) — API contract tests
✓ user-settings-api.test.ts (9 tests) — existing settings API tests
✓ audio-store.test.ts (94 tests) — store tests
✓ processing-config-panel.test.tsx (59 tests) — UI integration tests
✓ tenants.test.ts (21 tests) — tenant API tests
✓ admin-client.retry.test.ts (4 tests) — retry logic tests
```

---

## 8. Change History

| Date | Description | Files |
|------|-------------|-------|
| 2026-03-10 | Initial analysis, implementation plan | This README |
| 2026-03-10 | Full implementation: all 7 phases completed | See Files Changed section |
