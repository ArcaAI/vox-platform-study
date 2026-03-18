# Impersonation Strategy

> **Project**: HOPE — Hybrid Agentic Medical Conversation System
> **Package**: `@arcaai/vox` (Agentic SDK V2)
> **Last Updated**: 2026-03-01

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Backend Implementation](#backend-implementation)
4. [SDK Implementation](#sdk-implementation)
5. [UI Integration](#ui-integration)
6. [Token Lifecycle](#token-lifecycle)
7. [Channel-Specific Behavior](#channel-specific-behavior)
8. [Security Model](#security-model)
9. [Known Limitations and Gaps](#known-limitations-and-gaps)
10. [Troubleshooting](#troubleshooting)

---

## Overview

Impersonation allows administrators (SUPER_ADMIN, TENANT_ADMIN) to assume the identity of another user for debugging, support, and testing purposes. The system issues a short-lived JWT that carries the target user's identity while embedding the original admin's ID for audit tracing.

### Design Principles

- **JWT-based identity switching** — no custom headers; the impersonation JWT replaces the admin JWT on the client
- **Audit-first** — every request made during impersonation is logged with both the admin and target user IDs
- **Short-lived tokens** — impersonation JWTs default to 15-minute TTL
- **Explicit lifecycle** — impersonation must be started and ended via dedicated endpoints
- **In-memory state** — impersonation state is not persisted; a page refresh ends the session

---

## Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. ADMIN ACTION                                                             │
│    UserList → handleImpersonate() → useAuth().impersonate(targetUserId)     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. API CALL                                                                 │
│    POST /auth/impersonate { targetUserId }                                  │
│    Authorization: Bearer <admin_jwt>                                        │
│    Response: { user, token, impersonatedBy }                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. SDK STATE UPDATE (agenticStore)                                          │
│    authOriginalToken ← admin_jwt                                            │
│    authOriginalUser  ← admin_user                                           │
│    authImpersonatedUser ← target_user                                       │
│    AgenticClient.accessToken ← impersonation_jwt                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. ALL SUBSEQUENT API CALLS                                                 │
│    Authorization: Bearer <impersonation_jwt>                                │
│    Backend sees: user.id = target, user.impersonatedBy = admin              │
│    ImpersonationAuditInterceptor logs every request                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. END IMPERSONATION                                                        │
│    POST /auth/revoke-impersonation                                          │
│    AgenticClient.accessToken ← admin_jwt (restored)                         │
│    authImpersonatedUser ← null                                              │
│    authOriginalToken ← null                                                 │
│    authOriginalUser ← null                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Two-Store Architecture

The UI Playground uses two independent Zustand stores for auth. Understanding their relationship is critical to avoiding token conflicts.

| Store | Package | Persisted | Purpose |
|-------|---------|-----------|---------|
| `auth-store` | `apps/ui-playground` | Yes (localStorage `arcavox.auth`) | Login credentials, API key, tenant key |
| `agenticStore` | `packages/agentic-sdk-v2` | No (in-memory) | SDK runtime state including impersonation |

**Key invariant**: `auth-store.accessToken` always holds the **original admin token**. It is never updated during impersonation. The impersonation token lives only on `AgenticClient.accessToken` (managed by `agenticStore`).

`AgenticProvider` synchronizes `auth-store` → `AgenticClient` on every render, but **skips the access token sync when impersonating** to avoid overwriting the impersonation JWT.

---

## Backend Implementation

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/impersonate` | JWT (admin) | Start impersonation session |
| POST | `/auth/revoke-impersonation` | JWT | End impersonation session |

### Controller: `apps/api/src/modules/auth/auth.controller.ts`

#### `POST /auth/impersonate`

**Request:**
```json
{ "targetUserId": "uuid-of-target-user" }
```

**Response:**
```json
{
  "user": {
    "id": "target-uuid",
    "username": "doctor.smith",
    "email": "doctor@example.com",
    "roles": ["DOCTOR"],
    "permissions": ["consultation:read", "consultation:write"]
  },
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "impersonatedBy": "admin-uuid"
}
```

**Validation rules:**
- Caller must have role: SUPER_ADMIN, TENANT_ADMIN, admin, or system-admin
- Target user must exist and be enabled
- Cannot impersonate a SUPER_ADMIN
- TENANT_ADMIN cannot impersonate other admin roles

**JWT payload:**
```json
{
  "sub": "target-user-id",
  "id": "target-user-id",
  "username": "doctor.smith",
  "roles": ["DOCTOR"],
  "impersonatedBy": "admin-user-id",
  "jti": "impersonate-{adminId}-{targetId}-{timestamp}",
  "exp": "<now + JWT_IMPERSONATION_EXPIRES_IN>"
}
```

#### `POST /auth/revoke-impersonation`

Records an auth event and returns `{ success: true }`.

### DTOs: `apps/api/src/modules/auth/dto/impersonate.dto.ts`

```typescript
// ImpersonateRequest — validated with class-validator
class ImpersonateRequest {
  @IsUUID()
  targetUserId: string;
}

// ImpersonateUserResponse — user shape in response
class ImpersonateUserResponse {
  id: string;
  username: string;
  email: string;
  roles: string[];
  permissions: string[];
}

// ImpersonateResponse — full response
class ImpersonateResponse {
  user: ImpersonateUserResponse;
  token: string;
  impersonatedBy: string;
}
```

### Audit Interceptor: `apps/api/src/interceptors/impersonation-audit.interceptor.ts`

A global NestJS interceptor that runs on every HTTP request:

1. Reads `user` from `ClsService` (request-scoped context)
2. If `user.impersonatedBy` is set, emits `EventTypes.UserAuthenticated` after the response completes
3. Audit payload includes: `adminId`, `impersonatedUserId`, endpoint, IP address, user-agent

---

## SDK Implementation

### Types: `packages/agentic-sdk-v2/src/types/auth.ts`

```typescript
interface AuthUser {
  id: string;
  username: string;
  email: string;
  roles: string[];
  permissions: string[];
}

interface ImpersonateRequest {
  targetUserId: string;
}

interface ImpersonateResponse {
  user: AuthUser;
  token: string;
  impersonatedBy: string;
}
```

### Constants: `packages/agentic-sdk-v2/src/core/constants.ts`

```typescript
export const AUTH_ENDPOINTS = {
  LOGIN: '/auth/login',
  LOGOUT: '/auth/logout',
  ME: '/auth/me',
  REFRESH: '/auth/refresh',
  IMPERSONATE: '/auth/impersonate',
  REVOKE_IMPERSONATION: '/auth/revoke-impersonation',
} as const;
```

### Store State: `packages/agentic-sdk-v2/src/store/agenticStore.ts`

```typescript
// State fields
authUser: unknown;                    // Current authenticated user
authIsAuthenticated: boolean;         // Whether user is authenticated
authImpersonatedUser: unknown;        // Target user being impersonated (null when not impersonating)
authOriginalToken: string | null;     // Admin's JWT saved before impersonation
authOriginalUser: unknown;            // Admin user object saved before impersonation

// Actions
setAuthUser: (user: unknown) => void;
setIsAuthenticated: (isAuthenticated: boolean) => void;
setImpersonatedUser: (user: unknown) => void;
setOriginalToken: (token: string | null) => void;
setOriginalUser: (user: unknown) => void;
```

### Hook: `packages/agentic-sdk-v2/src/hooks/useAuth.ts`

```typescript
interface UseAuthReturn {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: Error | null;
  impersonatedUser: AuthUser | null;    // Target user or null
  isImpersonating: boolean;             // Derived: impersonatedUser !== null
  canImpersonate: boolean;              // Derived: user has SUPER_ADMIN or TENANT_ADMIN role
  login: (username: string, password: string, tenantKey?: string) => Promise<LoginResponse>;
  logout: () => Promise<void>;
  getMe: () => Promise<AuthUser>;
  refreshToken: (refreshToken: string) => Promise<RefreshTokenResponse>;
  impersonate: (targetUserId: string) => Promise<ImpersonateResponse>;
  endImpersonation: () => Promise<void>;
}
```

#### `impersonate(targetUserId)`

1. POST to `/auth/impersonate` with `{ targetUserId }` using current admin token
2. Save current token → `store.setOriginalToken(currentToken)`
3. Save current user → `store.setOriginalUser(store.authUser)`
4. Set impersonated user → `store.setImpersonatedUser(data.user)`
5. Replace client token → `apiClient.updateAccessToken(data.token)`

#### `endImpersonation()`

1. POST to `/auth/revoke-impersonation` (best-effort; proceeds on failure)
2. Restore admin token → `apiClient.updateAccessToken(originalToken)`
3. Restore admin user → `store.setAuthUser(originalUser)`
4. Clear impersonation state → `store.setImpersonatedUser(null)`, `store.setOriginalToken(null)`, `store.setOriginalUser(null)`

### Provider Guard: `packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx`

`AgenticProvider` runs a synchronous config sync on every render. During impersonation, the access token sync is skipped to prevent overwriting the impersonation JWT:

```typescript
const isImpersonating = store.authImpersonatedUser !== null;

if (!isImpersonating) {
  // Normal sync: push config.api.accessToken → client
  if (config.api.accessToken) {
    if (client.getAccessToken() !== config.api.accessToken) {
      client.updateAccessToken(config.api.accessToken);
    }
  } else if (client.getAccessToken()) {
    client.clearAccessToken();
  }
}
// When isImpersonating === true, the client keeps the impersonation token
```

**Why this is necessary**: `SDKProvider` builds `config.api.accessToken` from `auth-store`, which always holds the admin token. Without this guard, every re-render would overwrite the impersonation JWT back to the admin token.

---

## UI Integration

### Header Badge: `apps/ui-playground/src/components/layout/header.tsx`

Displays a red "Impersonating: {username}" badge when `isImpersonating` is true:

```tsx
const { isImpersonating, impersonatedUser } = useAuth();

{isImpersonating && (
  <Badge variant="destructive" className="gap-1.5">
    <UserCheck className="size-3.5" />
    Impersonating: {impersonatedUser?.username || 'Unknown'}
  </Badge>
)}
```

### User List: `apps/ui-playground/src/features/playground/overview/components/user-list.tsx`

Provides the impersonation UI:

- Table of users with row selection (TanStack Table)
- "Start Impersonation" button (visible when `canImpersonate` and a user is selected)
- "Stop Impersonation" button (visible when `isImpersonating`)
- Active impersonated user is highlighted in the table
- Only SUPER_ADMIN and TENANT_ADMIN roles see impersonation controls

### Consultation Feature: `apps/ui-playground/src/features/consultation/index.tsx`

When no tenant is selected or user needs to impersonate, shows an "Impersonate a User" button linking to the playground overview page.

---

## Token Lifecycle

### State Transitions

```
┌──────────────┐    impersonate()    ┌──────────────────┐    endImpersonation()    ┌──────────────┐
│   NORMAL     │ ──────────────────► │  IMPERSONATING   │ ────────────────────────► │   NORMAL     │
│              │                     │                  │                           │              │
│ client token │                     │ client token     │                           │ client token │
│ = admin JWT  │                     │ = impersonation  │                           │ = admin JWT  │
│              │                     │   JWT            │                           │ (restored)   │
│ store:       │                     │                  │                           │              │
│  impUser=null│                     │ store:           │                           │ store:       │
│  origToken=  │                     │  impUser=target  │                           │  impUser=null│
│    null      │                     │  origToken=admin │                           │  origToken=  │
│  origUser=   │                     │  origUser=admin  │                           │    null      │
│    null      │                     │                  │                           │  origUser=   │
└──────────────┘                     └──────────────────┘                           │    null      │
                                                                                   └──────────────┘
```

### Token Expiry

| Token Type | TTL | Env Variable | Default |
|------------|-----|--------------|---------|
| Normal JWT | Configurable | `JWT_EXPIRES_IN` | 24h |
| Impersonation JWT | Short-lived | `JWT_IMPERSONATION_EXPIRES_IN` | 15m |

When the impersonation JWT expires, API calls will return 401. The user must either re-impersonate or end impersonation. There is no automatic refresh for impersonation tokens.

---

## Channel-Specific Behavior

### HTTP (REST API)

| Aspect | Behavior |
|--------|----------|
| Header | `Authorization: Bearer <impersonation_jwt>` |
| Impersonation support | Full |
| Audit | `ImpersonationAuditInterceptor` logs every request |

All SDK hooks (`useArca`, `useAuth`, `useUsers`, etc.) use `AgenticClient.request()` which reads `this.accessToken` for the `Authorization` header.

### SSE (Server-Sent Events)

| Aspect | Behavior |
|--------|----------|
| Auth mechanism | `?token=<value>` query parameter (EventSource limitation) |
| Impersonation support | Supported if caller passes `apiClient.getAccessToken()` |
| Implementation | `SSEClient.connect(url, { authToken })` |

`EventSource` does not support custom headers. The `SSEClient` appends the token as a query parameter.

### WebSocket (STT-V2 Streaming)

| Aspect | Behavior |
|--------|----------|
| Auth mechanism | `?token=<value>` query parameter (gateway expects this) |
| SDK behavior | `StreamingSessionManager.getWebSocketUrl()` does **not** include the token |
| Gap | See [Known Limitations](#known-limitations-and-gaps) |

---

## Security Model

### Role Requirements

| Action | Allowed Roles |
|--------|---------------|
| Start impersonation | SUPER_ADMIN, TENANT_ADMIN, admin, system-admin |
| End impersonation | Any authenticated user |
| Impersonate SUPER_ADMIN | **Forbidden** |
| TENANT_ADMIN impersonate admin roles | **Forbidden** |

### JWT Claims During Impersonation

```json
{
  "sub": "target-user-id",
  "id": "target-user-id",
  "username": "target-username",
  "roles": ["target-roles"],
  "permissions": ["target-permissions"],
  "impersonatedBy": "admin-user-id",
  "jti": "impersonate-{adminId}-{targetId}-{timestamp}",
  "iat": 1709312400,
  "exp": 1709313300
}
```

### Audit Trail

Every HTTP request during impersonation triggers an audit event via `ImpersonationAuditInterceptor`:

```typescript
{
  type: EventTypes.UserAuthenticated,
  payload: {
    userId: adminId,              // The admin performing impersonation
    impersonatedUserId: targetId, // The user being impersonated
    endpoint: 'GET /api/v1/consultations',
    ip: '192.168.1.100',
    userAgent: 'Mozilla/5.0...'
  }
}
```

### State Isolation

- Impersonation state is **in-memory only** (no `persist` middleware on `agenticStore`)
- Page refresh clears impersonation and restores normal auth via `auth-store` (persisted)
- `clearSensitiveData()` and `clearOnLogout()` both reset all impersonation fields

---

## Known Limitations and Gaps

### 1. WebSocket Token Not Sent

**Status**: Open gap

`StreamingSessionManager.getWebSocketUrl()` intentionally omits the token from the URL for security (prevents exposure in logs/history). However, the API gateway's `ws-auth.helper.ts` expects `?token=<value>` in the query string. The SDK comments suggest sending the token as the first WebSocket message, but the gateway does not support this pattern.

**Impact**: WebSocket-based STT streaming may fail authentication during impersonation (and potentially during normal auth).

**Resolution options**:
- Add `?token=<value>` to the WebSocket URL (trade-off: token in URL)
- Add first-message auth support to the gateway WebSocket handler

### 2. Consultation Job SSE Missing Auth

**Status**: Open gap

`useConsultationJob` creates a raw `EventSource` without passing an auth token:

```typescript
const eventSource = new EventSource(`${baseUrl}${sseUrl}`);
```

This bypasses `SSEClient` and its `authToken` support.

**Impact**: Consultation job SSE connections may fail authentication.

**Resolution**: Switch to `SSEClient.connect()` with `authToken: apiClient.getAccessToken()`.

### 3. No Impersonation Token Refresh

**Status**: By design

Impersonation JWTs have a short TTL (default 15m) and cannot be refreshed. When the token expires, the user must re-impersonate.

### 4. Page Refresh Ends Impersonation

**Status**: By design

`agenticStore` has no persistence middleware. A page refresh restores the admin token from `auth-store` (persisted) and clears all impersonation state. This is intentional for security.

---

## Troubleshooting

### API calls use admin token instead of impersonation token

**Root cause**: `AgenticProvider` sync block was overwriting the impersonation token with the admin token from `auth-store` on every re-render.

**Fix**: Added `isImpersonating` guard in `AgenticProvider.tsx` that skips access token sync when `store.authImpersonatedUser !== null`.

**Verification**: Check browser DevTools Network tab — `Authorization` header should contain the impersonation JWT (decode at jwt.io to verify `impersonatedBy` claim is present).

### Impersonation badge not showing

**Check**: `useAuth()` reads `impersonatedUser` from `agenticStore`. Verify that `store.authImpersonatedUser` is set after calling `impersonate()`.

### 401 errors during impersonation

**Possible causes**:
1. Impersonation JWT expired (default 15m TTL)
2. Token was overwritten by `AgenticProvider` sync (see fix above)
3. SSE/WebSocket connections not passing the impersonation token

### Impersonation state lost after navigation

**Expected behavior**: In-app navigation (React Router) preserves impersonation state. Full page reload clears it. This is by design.

---

## Test Coverage

### SDK Tests

| File | Tests | Focus |
|------|-------|-------|
| `useAuth.test.ts` | impersonate, endImpersonation | Core impersonation flow, token swap, state management |
| `useAuth.task224.test.ts` | 16 tests | endImpersonation restores admin, original user preservation, revoke endpoint |
| `useAuth.task225.test.ts` | 8 tests | `canImpersonate` role checks for SUPER_ADMIN, TENANT_ADMIN, non-admin |
| `AgenticProvider.test.ts` | 5 tests | Provider initialization and config sync |
| `agenticStore.test.ts` | 76 tests | Store actions including impersonation state |

### Backend Tests

| File | Focus |
|------|-------|
| `auth.controller.task224.test.ts` | Impersonation endpoint validation, role checks |
| `impersonation-audit.interceptor.test.ts` | Audit event emission, non-impersonated passthrough |
| `auth-advanced.spec.ts` (E2E) | End-to-end impersonation and revocation |

---

## Related Documentation

- [Access Control](../04_ACCESS_CONTROL.md) — RBAC, JWT flow, tenant isolation
- [Agentic SDK README](./README.md) — SDK overview and architecture
- [API Reference](./api-reference.md) — Full SDK hook documentation
- TASK-209: Admin Auth Impersonation (initial implementation)
- TASK-224: Auth Security Enhancement (impersonation hardening)
- TASK-225: User Management and Permissions
