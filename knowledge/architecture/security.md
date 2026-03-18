# Security

The HOPE platform implements a multi-layered security architecture designed for healthcare compliance. This document covers authentication, authorization, tenant isolation, and audit logging.

## Authentication

The API Gateway supports three authentication strategies, validated by a unified NestJS guard:

| Strategy | Use Case | Token Location |
|----------|----------|---------------|
| **JWT** | User sessions (web/mobile) | `Authorization: Bearer <token>` |
| **OIDC** | Enterprise SSO integration | OIDC provider redirect flow |
| **API Key** | Service-to-service, SDK clients | `apikey`, `api-key`, or `x-api-key` header (also supports `?apiKey` query param) |

### Authentication Flow

```text
Client Request
      │
      ▼
┌─────────────────────────────────────────────────────┐
│  UnifiedAuthGuard (single guard, unified processing) │
│                                                      │
│  1. @Public() check → skip all auth if set           │
│                                                      │
│  2. API Key path (if header present):                │
│     └─► Hash lookup, validate status & expiration    │
│     └─► Rate limit check (Redis sliding window)      │
│     └─► IP allowlist and scope enforcement            │
│     └─► Set CLS context → Allow                      │
│                                                      │
│  3. JWT path (if Bearer token present):              │
│     └─► Passport 'jwt' strategy validation           │
│     └─► CASL permission check via PolicyEngine       │
│     └─► Set ability in request → Allow               │
│                                                      │
│  4. No credentials → 401 Unauthorized                │
│                                                      │
│  Result: UserSession { id, tenantId }                │
└─────────────────────────────────────────────────────┘
```

> **Note:** OidcAuthGuard still exists separately for OIDC SSO flows.

### JWT Configuration

| Parameter | Value |
|-----------|-------|
| Algorithm | RS256 (asymmetric) |
| Signing | Private key (server-side only) |
| Verification | Public key (distributed to services) |
| Expiration | Configurable via `JWT_SECRET` env var |

### API Key Scoping

API keys are scoped subsets of the creating user's permissions. The `PolicyEngine` computes the intersection of the user's CASL abilities and the key's declared scopes.

| Scope | Maps To |
|-------|---------|
| `consultation:read` | Read access to Consultation |
| `consultation:write` | Create + Update on Consultation |
| `context:read` | Read access to ContextItem |
| `context:write` | Create + Update on ContextItem |
| `media:read` | Read access to Media |
| `media:upload` | Create on Media |
| `user:read:self` | Read own User profile |
| `full:access` | All of the creating user's permissions |

API keys support rate limiting (`rateLimit` field) and IP restrictions (`allowedIps` field). Rate limiting uses a Redis sliding-window counter with fail-open design when Redis is unavailable.

## Role-Based Access Control (RBAC)

RBAC is implemented with [CASL](https://casl.js.org/) and a policy-based model stored in the database. Permissions are evaluated at runtime without code deployment.

### RBAC Flow

```text
1. UnifiedAuthGuard ──► Validates token/API key, extracts user
   (integrated) ──────► Reads @Authorize decorator metadata
                       ─► PolicyEngine.buildAbility()
                       ─► ability.can(action, subject)
3. Controller ─────────► @UserAbility() for fine-grained checks
4. Service ────────────► getAccessibleFilter() for Prisma queries
                       ─► assertCanAccessResource() for record checks
                       ─► filterFields() for field-level security
5. Database ───────────► Queries filtered by CASL conditions
```

### Core Concepts

**Subjects** — Resources protected by RBAC, corresponding to Prisma model names: `User`, `Consultation`, `ContextItem`, `Media`, `Tenant`, `Role`, `Policy`, `AuditLog`, `all`.

**Actions** — Operations that can be performed:

| Action | Description |
|--------|-------------|
| `manage` | Full access (matches any action) |
| `create` | Create new resources |
| `read` | View single resources |
| `list` | Query/list resources |
| `update` | Modify resources |
| `delete` | Remove resources |
| `archive` | Archive resources |
| `export` | Export data |

**Conditions** — Dynamic constraints resolved at runtime:

| Variable | Description |
|----------|-------------|
| `${user.id}` | Current user's ID |
| `${user.tenantId}` | Current user's tenant |
| `${context.tenantId}` | Request's tenant context |
| `${params.xxx}` | Route parameters |

### System Roles

| Role | Scope | Key Permissions |
|------|-------|----------------|
| `SUPER_ADMIN` | Global | `manage` on `all` |
| `TENANT_ADMIN` | Tenant | `manage` within tenant scope |
| `DOCTOR` | Tenant | Own consultations, context items, API keys |
| `NURSE` | Tenant | Read-only consultation access |
| `DEPARTMENT_HEAD` | Tenant | Doctor + department view + delegated role assignment |
| `SERVICE_ACCOUNT` | Tenant | Scoped API access via API keys |

### Policy Structure

Policies are stored as JSON arrays of CASL rules:

```json
[
    {
        "action": "manage",
        "subject": "Consultation",
        "conditions": { "tenantId": "${context.tenantId}", "doctorId": "${user.id}" }
    },
    {
        "action": "read",
        "subject": "Tenant",
        "conditions": { "id": "${context.tenantId}" }
    },
    {
        "action": "delete",
        "subject": "User",
        "inverted": true,
        "reason": "Users cannot be deleted, only archived"
    }
]
```

### Role Hierarchy

```text
GLOBAL SCOPE
├── SUPER_ADMIN ─── Full system access
│
TENANT SCOPE
├── TENANT_ADMIN ── Full tenant access, role management
├── DOCTOR ──────── Own consultations
│   └── DEPARTMENT_HEAD ── + Department view + delegated RBAC
├── NURSE ──────── Read-only consultations
│   └── SENIOR_NURSE ──── + Broader read access
└── SERVICE_ACCOUNT ── API/integration access
```

Custom tenant roles must inherit from a system role and cannot exceed the parent's permissions.

### Controller Decorators

| Decorator | Behavior |
|-----------|----------|
| `@CanRead('Subject')` | Requires `read` permission on Subject |
| `@CanList('Subject')` | Requires `list` permission on Subject |
| `@CanCreate('Subject')` | Requires `create` permission |
| `@CanUpdate('Subject')` | Requires `update` permission |
| `@CanDelete('Subject')` | Requires `delete` permission |
| `@CanManage('Subject')` | Requires `manage` permission |
| `@Authorize(['read', 'A'], ['update', 'B'])` | AND logic — all required |
| `@AuthorizeAny(['manage', 'A'], ['read', 'B'])` | OR logic — any sufficient |
| `@Public()` | No authentication required |
| `@UseGuards(JwtAuthGuard)` | Class/method-level JWT enforcement |
| `@ApiBearerAuth()` | Swagger documentation for Bearer auth |

> `@Authorize()` with no arguments provides auth-only protection (replaces the removed `@Authenticated()` decorator). The `@RequireAll(...)` and `@RequireAny(...)` aliases have also been removed.

### Proxy Controller Authentication

Proxy controllers that forward requests to Python microservices must enforce authentication at the gateway level. The services themselves do not validate tokens — they trust the internal network.

**Pattern**:
```typescript
@ApiTags('text')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('text')
export class SmrProxyController {
    // All routes require JWT — enforced at class level
}
```

**Protected proxy routes**:

| Controller | Routes | Auth Guard |
|------------|--------|-----------|
| `SmrProxyController` | `/text/*` (generate, tasks, stream, providers, health) | `JwtAuthGuard` (class-level) |
| `SttWsGateway` | `/ws/stt-v2/stream` | Post-connect auth message |
| Consultation controllers | `/api/consultations/*` | `UnifiedAuthGuard` |

> **Security rule**: Every proxy controller that forwards to a Python microservice must use `@UseGuards(JwtAuthGuard)` or `@UseGuards(UnifiedAuthGuard)` at the class level. Python services do not perform their own authentication.

### Service-Level Authorization

Services extend `AuthorizedBaseService` to get automatic query filtering:

| Method | Purpose |
|--------|---------|
| `getAccessibleFilter(action, subject)` | Prisma `where` clause from CASL |
| `assertCanAccessResource(action, subject, resource)` | Throws 403/404 if denied |
| `filterFields(data, action, subject)` | Strips unauthorized fields |
| `buildAuthorizedFilter(action, subject, filter?)` | Combines CASL + custom filters |
| `isSuperAdmin()` / `isTenantAdmin()` | Role-level checks |

### RBAC Cache

| Cache Key | TTL | Invalidation |
|-----------|-----|--------------|
| `policy:ability:{userId}:{tenantId}` | 5 min | Role, policy, or assignment change |

Invalidation methods: `invalidateUser()`, `invalidateRole()`, `invalidatePolicy()`, `invalidateUserGroup()`, `invalidateTenant()`, `invalidateAll()`.

### RBAC Management API

```text
GET/POST        /api/rbac/roles
GET/PUT/DELETE  /api/rbac/roles/:id
POST/DELETE     /api/rbac/roles/:id/policies/:policyId

GET/POST        /api/rbac/policies
GET/PUT/DELETE  /api/rbac/policies/:id
POST            /api/rbac/policies/validate

POST            /api/rbac/permissions/check
POST            /api/rbac/permissions/check-bulk
GET             /api/rbac/permissions/effective
```

## Streaming Authentication

WebSocket and SSE connections require special authentication handling because they cannot use standard HTTP headers in the same way as REST requests.

### WebSocket Authentication

WebSocket connections cannot carry HTTP headers after the initial handshake. Authentication is handled in two stages:

1. **Session creation** (HTTP): `POST /api/v1/audio/transcription-jobs/stream/session` with `Authorization: Bearer` header — validated by the gateway
2. **Post-connect auth message**: After WebSocket opens, client sends `{ type: "auth", token: "Bearer ..." }` — validated by the `SttWsGateway`

```text
Client ──POST (Bearer token)──► Gateway ──► Create session
Client ──WebSocket connect──► Gateway ──► { type: "auth", token: "Bearer ..." }
Client ──Binary PCM audio──► Gateway ──► Redis Streams ──► STT-V2
```

### SSE Authentication

The native `EventSource` API does not support custom headers. The SDK uses two approaches:

| Approach | Used By | How |
|----------|---------|-----|
| `SSEClient` (query param) | `useConsultationJob`, `FileTranscriptionService` | Appends `?token=...` to URL |
| `fetch` + `ReadableStream` | `smrClient.sse`, `smrClient.postSSE` | Sends `Authorization` header directly |

The `SSEClient` approach is simpler but exposes the token in server logs. The `fetch` approach is more secure but requires manual stream parsing.

> **Anti-pattern**: Never use raw `EventSource` without authentication. All SSE connections in the SDK must use `SSEClient` with `authToken` or `fetch` with `Authorization` header.

### Cross-Tab Authentication

When using `SharedConnectionManager` with `SharedWorker`, authentication tokens are passed during subscription and forwarded to the worker. The worker creates authenticated connections on behalf of all tabs:

```text
Tab 1 ──subscribeSSE({ authToken })──► SharedWorker ──EventSource(?token=...)──► Gateway
Tab 2 ──subscribeSSE({ authToken })──► (reuses existing connection)
```

## Multi-Tenancy & Tenant Isolation

All data queries are scoped by `tenantId`. Isolation is enforced at multiple levels:

1. **CASL Policy Conditions** — Every tenant-scoped policy rule includes `{ tenantId: "${context.tenantId}" }`
2. **AuthorizedBaseService** — `getAccessibleFilter()` injects tenant conditions into Prisma queries
3. **User Role Assignments** — Users can have different roles in different tenants
4. **API Keys** — Inherit the creating user's tenant context

Users with global assignments (`tenantId: null`) have cross-tenant access (Super Admin only).

## Audit Logging

The platform implements comprehensive event-driven audit logging through two parallel systems.

### Resource Audit Trail

All CRUD operations on business entities are automatically logged:

```text
Service.createEntity()
    │
    ├──► broadcastSysEvent(ResourceCreated, { resourceId, data, previousData })
    │
    ▼
SysEventService (EventEmitter2 listener)
    │
    ├──► Queue AuditLogJob → Redis/BullMQ
    ├──► Queue UserActivityJob → Redis/BullMQ
    └──► Queue SysEventJob → Redis/BullMQ
    │
    ▼
AuditLogService (Worker)
    └──► Persist to PostgreSQL (core.AuditLog table)
```

### AuditLog Schema

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUIDv7 | Time-sortable identifier |
| `tenantId` | String | Organization scope |
| `responsibleUserId` | String | Actor |
| `responsibleIp` | String | Request IP |
| `resourceType` | Enum | e.g., Consultation, User, Media |
| `resourceId` | String | Affected resource |
| `action` | Enum | CREATE, READ, UPDATE, DELETE, ARCHIVE, LOGIN, LOGOUT |
| `eventType` | String | AUTHORIZATION, RESOURCE, SYSTEM, AUTHENTICATION |
| `success` | Boolean | Operation outcome |
| `data` | JSONB | Current/new state |
| `previousData` | JSONB | Previous state (for updates) |
| `correlationId` | String | Distributed tracing ID |
| `causationId` | String | Triggering event ID |
| `metadata` | JSONB | Additional context |

### Authorization Audit

The `AuthorizationAuditService` separately logs every permission check (allow/deny):

- Persisted to database asynchronously (fire-and-forget)
- Published to Redis `authorization:audit` channel for real-time monitoring
- Denial records tracked separately with configurable TTL for anomaly detection

### Audit API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/audit-logs` | Paginated audit log query |
| GET | `/api/audit-logs/:id` | Single audit entry |
| GET | `/api/audit-logs/resource/:type/:id` | Logs by resource |
| GET | `/api/audit-logs/user/:userId` | Logs by actor |

## Security Best Practices

### Access Control

| Practice | Implementation |
|----------|---------------|
| Default deny | No permissions unless explicitly granted via policy |
| Tenant isolation | All queries include `tenantId` condition |
| No privilege escalation | Users cannot assign roles above their own level |
| System role protection | `isSystemRole: true` prevents modification |
| API key scoping | Intersection with user permissions, never union |
| 404 over 403 | Return NOT_FOUND for inaccessible resources to prevent enumeration |

### Data Protection

| Layer | Technology |
|-------|-----------|
| Transport | TLS/SSL (OpenSSL) |
| At-rest encryption | AES-256 |
| Password hashing | bcryptjs (salt-based) |
| Token signing | RS256 (asymmetric JWT) |
| Input validation | class-validator decorators |

### Operational Security

| Practice | Description |
|----------|-------------|
| Rate limiting | `express-rate-limit` + `@nestjs/throttler` per user/tenant |
| CORS | Configured via NestJS built-in CORS support |
| Audit logging | All operations logged to PostgreSQL |
| Sensitive data redaction | Passwords and PII sanitized before logging |
| Correlation IDs | Distributed tracing across services |
| MFA | Recommended for Super Admin accounts |

## Related Documentation

- [System Architecture](./README.md) — Overall system overview
- [Data Model](./data-model.md) — AuditLog schema and entity patterns
- [Communication Patterns](./communication.md) — Event-driven audit flow
- [Infrastructure](./infrastructure.md) — Redis and PostgreSQL configuration
