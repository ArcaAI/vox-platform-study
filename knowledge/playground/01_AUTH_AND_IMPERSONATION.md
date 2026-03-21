# Auth & Impersonation — Playground Implementation

## Overview

The ui-playground supports two authentication methods and a user-impersonation system that allows administrators to test SDK features as any doctor within their tenant. Authentication state is managed by a Zustand store, persisted to `localStorage`, and fed into the `@arcaai/vox` SDK via `AgenticProvider`.

---

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Login Forms │────▶│  Auth Store   │────▶│   SDKProvider   │
│  (API Key /  │     │  (Zustand +   │     │  (AgenticConfig) │
│  Credentials)│     │   persist)    │     └────────┬────────┘
└──────────────┘     └──────┬───────┘              │
                            │                      ▼
                     ┌──────┴───────┐     ┌─────────────────┐
                     │  Route Guard │     │ AgenticProvider  │
                     │ (_authenticated)│  │  (@arcaai/vox)   │
                     └──────────────┘     └─────────────────┘
```

---

## Auth Store

**File:** `apps/ui-playground/src/store/auth-store.ts` (131 lines)
**Persistence key:** `arcavox.auth`

### State

| Field | Type | Purpose |
|-------|------|---------|
| `authMethod` | `'apiKey' \| 'credentials' \| null` | Active auth method |
| `apiKey` | `string` | API key (apiKey auth) |
| `tenantId` | `string` | Tenant UUID |
| `tenantKey` | `string` | Tenant key (legacy compat) |
| `tenantName` | `string` | Tenant display name |
| `accessToken` | `string` | JWT (credentials auth) |
| `user` | `AuthUser \| null` | Logged-in user |
| `isAuthenticated` | `boolean` | Auth status flag |
| `impersonatedUser` | `AuthUser \| null` | Currently impersonated user |
| `impersonationToken` | `string` | JWT scoped to impersonated user |
| `isImpersonating` | `boolean` | Impersonation active flag |

### Actions

| Action | Behavior |
|--------|----------|
| `setApiKeyAuth(apiKey, tenantId)` | Sets apiKey auth; clears credentials fields |
| `setCredentialsAuth(token, user, tenantId, tenantKey?)` | Sets credentials auth; clears apiKey fields |
| `updateToken(token)` | Refreshes the access token |
| `setTenant(tenantId, tenantName?)` | Updates tenant context |
| `startImpersonation(user, token)` | Stores impersonated user and token |
| `endImpersonation()` | Clears impersonation state |
| `logout()` | Resets entire store to initial state |
| `isSuperAdmin()` | Returns `true` if user has `SUPER_ADMIN` role |

All fields listed above are persisted via Zustand `partialize`, so auth and impersonation state survive page refreshes.

---

## Login Flow

### API Key Auth

**File:** `apps/ui-playground/src/features/auth/login/components/api-key-form.tsx` (82 lines)

1. User enters **API Key** and **Tenant ID** (UUID).
2. Zod validates the form (`apiKey` required, `tenantId` UUID format).
3. On submit: `setApiKeyAuth(data.apiKey, data.tenantId)`.
4. No backend call — the key is stored and used directly in SDK config.
5. Navigate to `search.redirect` or `/`.

### Credentials Auth

**File:** `apps/ui-playground/src/features/auth/login/components/credentials-form.tsx` (119 lines)

1. User enters **Username**, **Password**, and optional **Tenant Key**.
2. On submit: calls `useAuth().login(username, password)` from `@arcaai/vox`.
3. SDK sends `POST /auth/login` to the API gateway.
4. On success: `setCredentialsAuth(response.token, user, tenantId, tenantKey)`.
5. Navigate to `search.redirect` or `/`.

### Login Page

**File:** `apps/ui-playground/src/features/auth/login/components/login-form.tsx` (41 lines)

Tabbed UI with "API Key" and "Credentials" tabs, rendering the respective forms.

---

## SDK Provider

**File:** `apps/ui-playground/src/providers/sdk-provider.tsx` (38 lines)

Wraps the entire app with `AgenticProvider` from `@arcaai/vox`. Builds `AgenticConfig` reactively:

```typescript
const api: AgenticConfig['api'] = {
    baseUrl: apiBaseUrl,       // from playground store
    tenantId: tenantId,        // from auth store
};

if (authMethod === 'apiKey') {
    api.apiKey = apiKey;
}

if (authMethod === 'credentials') {
    api.accessToken = isImpersonating && impersonationToken
        ? impersonationToken   // use impersonated user's token
        : accessToken;         // use logged-in user's token
}
```

When impersonating, the SDK automatically uses the `impersonationToken` for all API calls, so the backend sees the impersonated user's identity via the JWT.

---

## Impersonation Flow

### Starting Impersonation

**Trigger:** `apps/ui-playground/src/features/playground/overview/components/user-list.tsx` (337 lines)

1. Admin selects a user from the user list and clicks **"Start Impersonation"**.
2. Calls `useAuth().impersonate(selectedUserId)` from `@arcaai/vox`.
3. SDK sends `POST /auth/impersonate` with `{ targetUserId }`.
4. On success, SDK returns `{ user, token }`.
5. Playground calls `useAuthStore.getState().startImpersonation(result.user, result.token)`.
6. SDK also updates its internal store (impersonated user, token).

### Ending Impersonation

1. User clicks **"Stop Impersonation"** in the header banner.
2. Calls `useAuth().endImpersonation()` from `@arcaai/vox`.
3. SDK sends `POST /auth/revoke-impersonation`.
4. SDK restores original token/user in its internal store.
5. Playground calls `useAuthStore.getState().endImpersonation()`.

### Persistence

Impersonation state is persisted in `localStorage` under `arcavox.auth`:
- `impersonatedUser`, `impersonationToken`, `isImpersonating`
- Survives page refresh and store rehydration.

### Effect on API Calls

- `SDKProvider` passes `impersonationToken` as `accessToken` when `isImpersonating` is true.
- All SDK API calls (consultations, summaries, context, etc.) use this token.
- The backend resolves the impersonated user from the JWT claims.

---

## Dual Auth Sources

The playground maintains two auth sources that are kept in sync:

| Source | Location | Purpose |
|--------|----------|---------|
| **Auth Store** | `useAuthStore` (Zustand + persist) | Route guards, SDK config, UI state |
| **SDK Store** | `useAgenticStore` (internal to `@arcaai/vox`) | SDK hooks (`useAuth`, `useArca`, etc.) |

Synchronization points:
- `startImpersonation` → updates both stores.
- `endImpersonation` → clears both stores.
- `useDoctorContext()` merges both: `sdkAuth?.isImpersonating || persistedImpersonating`.

---

## Doctor Context Hook

**File:** `apps/ui-playground/src/features/summarization/hooks/use-doctor-context.ts` (62 lines)

Provides impersonation-aware context for features that require a doctor identity:

| Field | Logic |
|-------|-------|
| `effectiveUserId` | Impersonated user ID when impersonating, else logged-in user ID |
| `requiresImpersonation` | `true` when user is admin, not a doctor, and not impersonating |
| `isImpersonated` | Whether impersonation is currently active |
| `isAdmin` | User has an admin role |
| `isDoctor` | User has DOCTOR, SPECIALIST, or CONSULTANT role |
| `primaryDepartmentId` | Department from effective user |
| `roles` | Effective user's roles |

Used by: Consultation, Summarization (Pre-Summary, Summary), DNA Writing Style (via summarization).

---

## Impersonation Guard

**File:** `apps/ui-playground/src/features/summarization/components/impersonation-guard.tsx` (47 lines)

A card shown when `requiresImpersonation` is `true`. Explains that admin users must impersonate a doctor to access doctor-scoped features (templates, DNA styles, consultations). Links to the Playground Overview page where impersonation can be started.

---

## Route Guards

### Authenticated Routes

**File:** `apps/ui-playground/src/routes/_authenticated/route.tsx` (15 lines)

- `beforeLoad`: if `!context.isAuthenticated`, redirects to `/login?redirect=<current_url>`.
- All routes under `/_authenticated/*` are protected.

### Login Route

**File:** `apps/ui-playground/src/routes/(auth)/login.tsx` (18 lines)

- `beforeLoad`: if `context.isAuthenticated`, redirects to `/`.
- Prevents authenticated users from seeing the login page.

### Router Context

**File:** `apps/ui-playground/src/main.tsx` (77 lines)

- `InnerApp` subscribes to `useAuthStore((s) => s.isAuthenticated)`.
- Passes `context={{ queryClient, isAuthenticated }}` to `RouterProvider`.
- Changes to `isAuthenticated` trigger router re-evaluation.

---

## Test Coverage

### `auth-store.test.ts` (155 lines)
- Initial state verification (unauthenticated, null user, empty fields)
- `setApiKeyAuth` sets correct fields, clears credentials
- `setCredentialsAuth` sets correct fields, clears apiKey
- `updateToken` updates access token
- `setTenant` updates tenant
- `logout` resets all state
- Auth method switching clears the other method's fields

### `auth-store.impersonation.test.ts` (95 lines)
- Initial impersonation state (not impersonating)
- `startImpersonation` stores user, token, sets flag
- `endImpersonation` clears impersonation state
- Logout clears impersonation
- Impersonation persisted in localStorage

### `auth-store.impersonation-persistence.test.ts` (117 lines)
- Rehydration via `useAuthStore.persist.rehydrate()`
- Impersonation survives rehydration
- Doctor context correct after rehydration
- Effective token resolves correctly (impersonation vs admin)
- Logout + rehydration clears impersonation

### `api-key-form.test.tsx`
- Form validation (required fields, UUID format)
- Successful submission updates auth store

---

## File Index

| File | Lines | Purpose |
|------|-------|---------|
| `store/auth-store.ts` | 131 | Auth + impersonation state management |
| `providers/sdk-provider.tsx` | 38 | SDK initialization with auth config |
| `features/auth/login/components/api-key-form.tsx` | 82 | API key login form |
| `features/auth/login/components/credentials-form.tsx` | 119 | Credentials login form |
| `features/auth/login/components/login-form.tsx` | 41 | Tabbed login container |
| `features/auth/login/index.tsx` | 13 | Login page layout |
| `features/playground/overview/components/user-list.tsx` | 337 | User list with impersonation controls |
| `features/summarization/hooks/use-doctor-context.ts` | 62 | Impersonation-aware doctor context |
| `features/summarization/components/impersonation-guard.tsx` | 47 | Admin impersonation prompt |
| `components/layout/header.tsx` | 141 | Header with impersonation banner |
| `routes/_authenticated/route.tsx` | 15 | Auth route guard |
| `routes/(auth)/login.tsx` | 18 | Login route guard |
| `main.tsx` | 77 | Router context with auth state |
| `store/__tests__/auth-store.test.ts` | 155 | Auth store unit tests |
| `store/__tests__/auth-store.impersonation.test.ts` | 95 | Impersonation unit tests |
| `store/__tests__/auth-store.impersonation-persistence.test.ts` | 117 | Impersonation persistence tests |
