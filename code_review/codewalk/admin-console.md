# Admin Console - API Documentation

## Service Overview

**Path**: `apps/admin-console/`
**Type**: Next.js 16 (React 19) Admin Dashboard
**Port**: 5176 (dev), 3000 (prod)
**Framework**: Next.js 16 (App Router, React 19)

### Core Responsibilities
- **Admin Dashboard** — Web-based administration interface for the HOPE platform
- **BFF Proxy** — Backend-for-Frontend proxy to API Gateway (`/api/hope/*` → Gateway `/api/v1/*`)
- **Session Management** — Encrypted JWE session cookies (httpOnly, A256GCM)
- **Auth Flows** — Login, logout, refresh, impersonation, SSO, password reset
- **Gateway Proxy** — Authenticated proxy to API Gateway with token refresh retry
- **Observability** — Health endpoints, OpenTelemetry, structured logging

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Admin Console                             │
├─────────────────────────────────────────────────────────────────┤
│  Next.js 16 (App Router, React 19)                              │
│  ├─ /login, /register, /reset-password — Auth pages            │
│  ├─ /(console)/(global)/* — Global admin screens               │
│  │   ├─ tenants, billing, ai-services, queues                  │
│  │   ├─ entitlements, security-policy, agentic-policy          │
│  │   ├─ knowledge, db-studio, prompt-studio                    │
│  │   └─ workflow-studio, schedulers, rate-limits               │
│  ├─ /(console)/(tenant)/* — Tenant-scoped screens              │
│  │   └─ workflow-studio                                         │
│  ├─ /api/hope/[...path] — BFF Proxy to Gateway                 │
│  ├─ /api/auth/* — Login, logout, refresh, SSO, impersonation  │
│  ├─ /api/health — Health probes                                │
│  └─ /api/auth/sso/* — SSO flows                                │
├─────────────────────────────────────────────────────────────────┤
│  Server Layer (Next.js Server Components / Route Handlers)     │
│  ├─ src/server/hope-proxy.ts — BFF Proxy with auth header      │
│  ├─ src/server/session.ts — JWE session cookies (A256GCM)      │
│  ├─ src/server/refresh.ts — Token refresh with retry           │
│  ├─ src/server/safe-user.ts — Client-safe user projection      │
│  ├─ src/server/gateway.ts — Gateway URL builder                │
│  ├─ src/server/refresh.ts — Token refresh logic                │
│  └─ src/server/session.ts — JWE encryption/decryption          │
├─────────────────────────────────────────────────────────────────┤
│  Downstream: API Gateway (${API_URL}/api/v1)                   │
└─────────────────────────────────────────────────────────────────┘
```

### Key Technologies
- **Next.js 16** (App Router, Server Components, Route Handlers)
- **React 19** with Server Components
- **TanStack Query** (server state management)
- **Zustand** (client state)
- **JWE** (A256GCM) encrypted session cookies
- **TanStack Query** for server state
- **Zustand** for client state
- **OpenTelemetry** instrumentation

---

## API Endpoints Summary

### Public Endpoints (No Auth Required)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/health` | `GET()` [health/route.ts] | Detailed health check |
| GET | `/api/health/live` | `GET()` [health/live/route.ts] | K8s liveness probe |
| GET | `/api/health/ready` | `GET()` [health/ready/route.ts] | K8s readiness probe |
| GET | `/api/health/ready` | `GET()` [health/ready/route.ts] | K8s readiness probe |

### Authentication Endpoints
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/auth/login` | `POST()` [auth/login/route.ts] | Credentials → JWE session cookie |
| POST | `/api/auth/logout` | `POST()` [auth/logout/route.ts] | Clear session + gateway logout |
| POST | `/api/auth/refresh` | `POST()` [auth/refresh/route.ts] | Explicit token rotation |
| POST | `/api/auth/forgot-password` | `POST()` [auth/forgot-password/route.ts] | Initiate password reset |
| POST | `/api/auth/reset-password` | `POST()` [auth/reset-password/route.ts] | Complete password reset |
| POST | `/api/auth/register` | `POST()` [auth/register/route.ts] | Self-registration |
| POST | `/api/auth/register/verify` | `POST()` [auth/register/verify/route.ts] | Verify email |
| GET | `/api/auth/sso/start` | `GET()` [auth/sso/start/route.ts] | Initiate SSO |
| GET | `/api/auth/sso/callback` | `GET()` [auth/sso/callback/route.ts] | SSO callback |
| POST | `/api/auth/impersonate` | `POST()` [auth/impersonate/route.ts] | Start impersonation |
| POST | `/api/auth/revoke-impersonation` | `POST()` [auth/revoke-impersonation/route.ts] | End impersonation |
| GET | `/api/auth/session` | `GET()` [auth/session/route.ts] | Get current session |
| POST | `/api/auth/working-tenant` | `POST()` [auth/working-tenant/route.ts] | Set working tenant |
| POST | `/api/auth/stream-ticket` | `POST()` [auth/stream-ticket/route.ts] | WS ticket for STT/TTS |

### BFF Proxy (All Authenticated)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| * | `/api/hope/[...path]` | `handleProxy()` [server/hope-proxy.ts] | Proxy to Gateway `/api/v1/*` |

---

## Detailed API Documentation

### 1. Health Endpoints

#### GET /api/health
**File**: `src/app/api/health/route.ts:21`
**Handler**: `GET()`

**Implementation**:
```typescript
GET() [health/route.ts:21]
  → serverEnv() validation [config/env.ts]
  → getBuildVersion() [server/build-info.ts]
  → Returns: {status, service, version, uptime, timestamp, checks}
```

**Always returns 200** — informational only.

---

#### GET /api/health/live
**File**: `src/app/api/health/live/route.ts`
**Handler**: `GET()`

Returns: `{status: "healthy"}` — K8s liveness probe.

---

#### GET /api/health/ready
**File**: `src/app/api/health/ready/route.ts`
**Handler**: `GET()`

**Implementation**:
```typescript
GET() [health/ready/route.ts]
  → serverEnv() validation
  → Returns: {status, checks: {config: {status}}}
```

---

### 2. Authentication

#### POST /api/auth/login
**File**: `src/app/api/auth/login/route.ts:31`
**Handler**: `POST(request)`

**Implementation Chain**:
```
POST() [auth/login/route.ts:31]
  → Validate username + password
  → fetch(gatewayUrl('auth/login'), credentials)
    → Gateway validates credentials
    → Returns: {user, token, refreshToken, passwordExpired}
  → setSession() [server/session.ts:88]
    → sealSession() [session.ts:64] → EncryptJWT (A256GCM)
    → Set httpOnly cookie (SESSION_COOKIE_NAME)
  → Returns: toSafeSession(session) [server/safe-user.ts]
```

**Request**: `{username, password, tenantKey?}`
**Response**: `{user: {id, username, email, roles, permissions, tenantId?}, passwordExpired?}`

**Key Features**:
- Tokens **never** reach browser (sealed in httpOnly cookie)
- `toSafeSession()` strips tokens from client response
- Gateway `tenantKey` support for tenant-scoped login

---

#### POST /api/auth/logout
**File**: `src/app/api/auth/logout/route.ts:5`
**Handler**: `POST()`

**Implementation**:
```
POST() [auth/logout/route.ts:5]
  → getSession()
  → fetch(gatewayUrl('auth/logout'), Bearer token) [best effort]
  → clearSession() [session.ts:99] → delete cookie
  → Returns: {success: true}
```

---

#### POST /api/auth/refresh
**File**: `src/app/api/auth/refresh/route.ts:6`
**Handler**: `POST()`

**Implementation**:
```
POST() [auth/refresh/route.ts:6]
  → getSession()
  → refreshSession() [server/refresh.ts]
    → Gateway /auth/refresh with refreshToken
    → New {accessToken, refreshToken}
    → setSession(newSession)
  → Returns: toSafeSession(refreshedSession)
```

---

#### POST /api/auth/impersonate
**File**: `src/app/api/auth/impersonate/route.ts`
**Handler**: `POST()`

**Purpose**: Super admin impersonates tenant admin
**Implementation**: Calls Gateway `/auth/impersonate`, creates `ImpersonationState` with short-lived token, stores original tokens for recovery.

---

#### POST /api/auth/revoke-impersonation
**File**: `src/app/api/auth/revoke-impersonation/route.ts`

**Purpose**: End impersonation, restore original tokens.

---

#### GET /api/auth/session
**File**: `src/app/api/auth/session/route.ts`
**Handler**: `GET()`

**Returns**: `toSafeSession(session)` — user info without tokens.

---

#### POST /api/auth/working-tenant
**File**: `src/app/api/auth/working-tenant/route.ts`
**Handler**: `POST()`

**Purpose**: Set `workingTenantId` on session for elevated users.

---

#### POST /api/auth/stream-ticket
**File**: `src/app/api/auth/stream-ticket/route.ts`
**Handler**: `POST()`

**Purpose**: Mints single-use ticket for STT/TTS WebSocket connections.

---

### 3. SSO Endpoints

#### GET /api/auth/sso/start
**File**: `src/app/api/auth/sso/start/route.ts`

Initiates SSO flow, redirects to IdP.

---

#### GET /api/auth/sso/callback
**File**: `src/app/api/auth/sso/callback/route.ts`

Handles IdP callback, exchanges code for tokens, creates session.

---

### 4. BFF Proxy

#### * /api/hope/[...path]
**File**: `src/app/api/hope/[...path]/route.ts:10`
**Handler**: `handler(request, context) → handleProxy(request, path)`

**Implementation Chain** [server/hope-proxy.ts:92]:
```
handleProxy(request, path) [hope-proxy.ts:92]
  → getSession() → unsealSession() [session.ts:73]
    → jwtDecrypt (A256GCM) → SessionPayload
  → buildHeaders(request, session) [hope-proxy.ts:33]
    → FORWARDED_REQUEST_HEADERS: content-type, if-match, idempotency-key, user-agent
    → Authorization: Bearer <accessToken|impersonation.accessToken>
    → x-tenant-id (if elevated + workingTenantId)
  → encodeGatewayPath(path) [hope-proxy.ts:63]
    → Re-encodes path segments (preserves %2F)
  → sendToGateway() [hope-proxy.ts:67]
    → fetch(gatewayUrl(path), headers, body)
  → If 401:
    → Impersonation? → restore original tokens
    → Else: refreshSession() [server/refresh.ts] → retry once
    → If still 401 & not impersonation → return gateway error (keep session)
    → If impersonation & 401 → clearSession() → sessionLost()
  → toClientResponse() [hope-proxy.ts:77]
    → FORWARDED_RESPONSE_HEADERS: content-type, etag, cache-control
```

**Key Features**:
- **Token never exposed to browser** — sealed in JWE cookie
- **Auto-refresh on 401** — single-flight refresh + one retry
- **Impersonation recovery** — restores original tokens on 401
- **Path encoding** — preserves `%2F` in file keys
- **Header forwarding** — content-type, if-match, idempotency-key, user-agent

---

### 4. Session Management

**File**: `src/server/session.ts`

**Session Payload**:
```typescript
interface SessionPayload {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;           // {id, username, email, roles, tenantId?, permissions?}
  workingTenantId?: string;    // Elevated users only
  workingTenantName?: string;
  impersonation?: ImpersonationState; // {accessToken, originalTokens, targetUserId, ...}
}
```

**Encryption**: JWE with `dir` + `A256GCM` (32-byte key from `ADMIN_SESSION_SECRET`)

**Cookie Settings**:
- `httpOnly: true`
- `sameSite: 'lax'`
- `secure: production`
- `maxAge: 7 days`

---

## Key Implementation Files

| File | Purpose |
|------|---------|
| `src/app/api/hope/[...path]/route.ts` | BFF catch-all proxy entry |
| `src/server/hope-proxy.ts` | Core proxy logic (auth, retry, headers) |
| `src/server/session.ts` | JWE session encryption/decryption |
| `src/server/refresh.ts` | Token refresh logic |
| `src/server/safe-user.ts` | Client-safe user projection |
| `src/server/gateway.ts` | Gateway URL builder |
| `src/server/session.ts` | JWE encryption/decryption, session types |
| `src/app/api/auth/login/route.ts` | Login flow |
| `src/app/api/auth/logout/route.ts` | Logout flow |
| `src/app/api/auth/refresh/route.ts` | Explicit refresh |
| `src/app/api/auth/impersonate/route.ts` | Impersonation start |
| `src/app/api/auth/revoke-impersonation/route.ts` | Impersonation end |
| `src/app/api/auth/session/route.ts` | Session read |
| `src/app/api/auth/sso/*` | SSO flows |
| `src/app/api/health/*` | Health probes |
| `src/server/hope-proxy.ts` | Core proxy logic |
| `src/server/session.ts` | JWE session management |
| `src/server/refresh.ts` | Token refresh |
| `src/server/safe-user.ts` | Client-safe projection |
| `src/server/gateway.ts` | Gateway utilities |

---

## Configuration (Environment)

| Variable | Description |
|----------|-------------|
| `API_URL` | Gateway base URL (e.g., `http://api-gateway:8868`) |
| `ADMIN_SESSION_SECRET` | 32-byte key for JWE encryption |
| `NODE_ENV` | `production` enables secure cookies |
| `DEPLOYMENT_ENVIRONMENT` | Deployment environment name |

---

## Sequence Diagrams

See generated sequence diagrams in `review/codewalk/diagrams/` (open `.html` files in browser):
- `admin-console-login.html` — Login flow with JWE session
- `admin-console-proxy.html` — BFF proxy with auto-refresh
- `admin-console-impersonation.html` — Impersonation flow
- `admin-console-logout.html` — Logout with gateway revocation