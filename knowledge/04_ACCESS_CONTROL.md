# Access Control Implementation

> **Project**: HOPE — Hybrid Agentic Medical Conversation System
> **Last Updated**: 2026-02-27

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Role-Based Access Control (RBAC)](#role-based-access-control-rbac)
4. [API Key Management](#api-key-management)
5. [Multi-Tenancy and Tenant Isolation](#multi-tenancy-and-tenant-isolation)
6. [Authorization at the Service Layer](#authorization-at-the-service-layer)
7. [Controller Decorators](#controller-decorators)
8. [RBAC Management API](#rbac-management-api)
9. [Caching and Invalidation](#caching-and-invalidation)
10. [Audit Logging](#audit-logging)
11. [Security Hardening](#security-hardening)
12. [Data Protection](#data-protection)
13. [Security Best Practices](#security-best-practices)

---

## Overview

The HOPE platform implements a multi-layered security architecture designed for healthcare compliance. Security is enforced at every layer:

```text
Client Request
    │
    ▼
UnifiedAuthGuard (Public → API Key → JWT → CASL)
    │
    ▼
Controller (@Authorize decorators)
    │
    ▼
Service Layer (getAccessibleFilter, assertCanAccessResource, filterFields)
    │
    ▼
Database (Prisma queries filtered by CASL conditions + tenantId)
```

---

## Authentication

The API Gateway supports three authentication strategies, validated by NestJS guards:

| Strategy | Use Case | Token Location |
|----------|----------|---------------|
| **JWT** | User sessions (web/mobile) | `Authorization: Bearer <token>` |
| **OIDC** | Enterprise SSO integration | OIDC provider redirect flow |
| **API Key** | Service-to-service, SDK clients | `apikey`, `api-key`, or `x-api-key` header (also `?apiKey` query param) |

### Authentication Flow

```text
Client Request
      │
      ▼
┌─────────────────────────────────────────────────────────┐
│  UnifiedAuthGuard (single guard, unified processing)     │
│                                                          │
│  Step 1: @Public() check                                 │
│     └─► If route is public, skip all auth → Allow        │
│                                                          │
│  Step 2: API Key check                                   │
│     └─► Extract key from headers (apikey/api-key/x-api-key)│
│     └─► Hash lookup, validate status & expiration        │
│     └─► Enforce rate limit (Redis sliding window)        │
│     └─► Enforce IP allowlist and scope restrictions      │
│     └─► Set user context in CLS → Allow                  │
│                                                          │
│  Step 3: JWT check                                       │
│     └─► Delegate to Passport 'jwt' strategy              │
│     └─► Check impersonation context                      │
│     └─► Evaluate CASL permissions via PolicyEngine        │
│     └─► Set ability in request context → Allow           │
│                                                          │
│  Step 4: No credentials → 401 Unauthorized               │
│                                                          │
│  Result: UserSession { id, tenantId } + optional ability  │
└─────────────────────────────────────────────────────────┘
```

> **Note**: OidcAuthGuard still exists separately for OIDC SSO flows but is not part of the unified guard.

### JWT Configuration

| Parameter | Value |
|-----------|-------|
| Algorithm | RS256 (asymmetric) |
| Signing | Private key (server-side only) |
| Verification | Public key (distributed to services) |
| Expiration | Configurable via environment variables |

---

## Role-Based Access Control (RBAC)

RBAC is implemented with [CASL](https://casl.js.org/) and a policy-based model stored in the database. Permissions are evaluated at runtime without requiring code deployment.

### RBAC Flow

```text
1. UnifiedAuthGuard ──► Validates token/API key, extracts user
   (integrated) ──────► Reads @Authorize decorator metadata
                        ─► PolicyEngine.buildAbility()
                        ─► ability.can(action, subject)
3. Controller ──────────► @UserAbility() for fine-grained checks
4. Service ─────────────► getAccessibleFilter() for Prisma queries
                        ─► assertCanAccessResource() for record checks
                        ─► filterFields() for field-level security
5. Database ────────────► Queries filtered by CASL conditions
```

### Core Concepts

**Subjects** — Resources protected by RBAC (Prisma model names): `User`, `Consultation`, `ContextItem`, `Media`, `Tenant`, `Role`, `Policy`, `AuditLog`, `all`.

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

| Variable | Resolves To |
|----------|------------|
| `${user.id}` | Current user's ID |
| `${user.tenantId}` | Current user's tenant |
| `${context.tenantId}` | Request's tenant context |
| `${params.xxx}` | Route parameters |

### System Roles

| Role | Scope | Key Permissions |
|------|-------|----------------|
| `SUPER_ADMIN` | Global | `manage` on `all` — full system access |
| `TENANT_ADMIN` | Tenant | `manage` within tenant scope |
| `DOCTOR` | Tenant | Own consultations, context items, API keys |
| `NURSE` | Tenant | Read-only consultation access |
| `DEPARTMENT_HEAD` | Tenant | Doctor + department view + delegated role assignment |
| `SENIOR_NURSE` | Tenant | Nurse + broader read access |
| `SERVICE_ACCOUNT` | Tenant | Scoped API access via API keys |

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

### Policy Structure

Policies are stored as JSON arrays of CASL rules:

```json
[
    {
        "action": "manage",
        "subject": "Consultation",
        "conditions": {
            "tenantId": "${context.tenantId}",
            "doctorId": "${user.id}"
        }
    },
    {
        "action": "read",
        "subject": "Tenant",
        "conditions": {
            "id": "${context.tenantId}"
        }
    },
    {
        "action": "delete",
        "subject": "User",
        "inverted": true,
        "reason": "Users cannot be deleted, only archived"
    }
]
```

Policy rules support:
- **Positive rules**: Grant access when conditions match
- **Inverted rules**: Deny access with an optional `reason`
- **Field restrictions**: Limit which fields are accessible via the `fields` property
- **Condition variables**: Dynamic resolution at runtime

---

## API Key Management

### Key Generation

API keys are generated with a secure process:
- Cryptographically random key generation
- SHA-256 hash stored in database (plain key shown once on creation)
- HMAC-SHA256 with application pepper (when `API_KEY_PEPPER` env var is set)
- Atomic usage tracking (prevents race conditions)
- Checksum validation for key integrity

### Key Features

| Feature | Description |
|---------|-------------|
| **Scoping** | Intersection of creating user's permissions and declared scopes |
| **IP Allowlist** | Exact match, wildcard patterns, CIDR notation |
| **Rate Limiting** | Per-key rate limit via Redis sliding-window counter (fail-open when Redis unavailable) |
| **Expiration** | Optional expiration date |
| **Status** | Active/disabled/expired lifecycle |

### API Key Scopes

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

The `PolicyEngine` computes the intersection of the user's CASL abilities and the key's declared scopes — never a union. This means an API key can never exceed its creator's permissions.

### IP Allowlist Enforcement

| Pattern Type | Example | Behavior |
|-------------|---------|----------|
| Exact | `192.168.1.100` | Matches single IP |
| Wildcard | `192.168.1.*` | Matches IP range |
| CIDR | `10.0.0.0/24` | Matches subnet |

---

## Multi-Tenancy and Tenant Isolation

All data queries are scoped by `tenantId`. Isolation is enforced at multiple levels:

1. **CASL Policy Conditions** — Every tenant-scoped policy rule includes `{ tenantId: "${context.tenantId}" }`
2. **AuthorizedBaseService** — `getAccessibleFilter()` automatically injects tenant conditions into Prisma queries
3. **User Role Assignments** — Users can have different roles in different tenants
4. **API Keys** — Inherit the creating user's tenant context

Users with global assignments (`tenantId: null`) have cross-tenant access — limited to Super Admin role only.

### Tenant Data Flow

```text
Request with JWT/API Key
    │
    ├──► Extract tenantId from token/key
    │
    ├──► CASL builds ability with tenantId conditions
    │
    ├──► Service calls getAccessibleFilter()
    │       └──► Returns Prisma WHERE clause: { tenantId: "..." }
    │
    └──► Database query executes with tenant filter
```

---

## Authorization at the Service Layer

Services extend `AuthorizedBaseService` to get automatic RBAC-filtered queries:

| Method | Purpose |
|--------|---------|
| `getAccessibleFilter(action, subject)` | Returns a Prisma `where` clause derived from CASL abilities |
| `assertCanAccessResource(action, subject, resource)` | Throws 403 (or 404 to prevent enumeration) if denied |
| `filterFields(data, action, subject)` | Strips fields the user is not authorized to see |
| `buildAuthorizedFilter(action, subject, filter?)` | Combines CASL conditions with custom business filters |
| `isSuperAdmin()` | Returns true if current user has global manage access |
| `isTenantAdmin()` | Returns true if current user has tenant-level manage access |

### Example: Filtering Consultations

```typescript
async findAll(paginationDto: PaginationDto) {
    const accessFilter = await this.getAccessibleFilter('list', 'Consultation');

    return this.prisma.consultation.findMany({
        where: {
            ...accessFilter,
            resourceStatus: { not: 'DELETED' },
        },
        ...paginationDto,
    });
}
```

This ensures a DOCTOR only sees their own consultations, while a TENANT_ADMIN sees all consultations within their tenant.

---

## Controller Decorators

### Permission Decorators

| Decorator | Behavior |
|-----------|----------|
| `@CanRead('Subject')` | Requires `read` permission on Subject |
| `@CanList('Subject')` | Requires `list` permission on Subject |
| `@CanCreate('Subject')` | Requires `create` permission |
| `@CanUpdate('Subject')` | Requires `update` permission |
| `@CanDelete('Subject')` | Requires `delete` permission |
| `@CanManage('Subject')` | Requires `manage` permission |

### Composite Decorators

| Decorator | Logic |
|-----------|-------|
| `@Authorize(['read', 'A'], ['update', 'B'])` | AND — all permissions required |
| `@AuthorizeAny(['manage', 'A'], ['read', 'B'])` | OR — any one sufficient |

### Access Control Decorators

| Decorator | Behavior |
|-----------|----------|
| `@Public()` | No authentication required (skips UnifiedAuthGuard entirely) |

> **Note**: All auth decorators are now defined in `@arcaai/applications` and re-exported
> from `apps/api/src/decorators/`. The `@Authorize()` decorator uses `UnifiedAuthGuard`
> which handles both JWT and API key authentication automatically. Using `@Authorize()`
> with no arguments provides authentication-only protection (equivalent to the removed
> `@Authenticated()` decorator).

### Usage Example

```typescript
@Controller('consultations')
export class ConsultationController {
    @Get()
    @CanList('Consultation')
    async findAll() { /* ... */ }

    @Post()
    @CanCreate('Consultation')
    async create(@Body() dto: CreateConsultationDto) { /* ... */ }

    @Get(':id')
    @CanRead('Consultation')
    async findOne(@Param('id') id: string) { /* ... */ }

    @Patch(':id')
    @CanUpdate('Consultation')
    async update(@Param('id') id: string, @Body() dto: UpdateDto) { /* ... */ }
}
```

---

## RBAC Management API

### Role Management

```text
GET    /api/rbac/roles              # List all roles
POST   /api/rbac/roles              # Create a new role
GET    /api/rbac/roles/:id          # Get role details
PUT    /api/rbac/roles/:id          # Update a role
DELETE /api/rbac/roles/:id          # Delete a role
POST   /api/rbac/roles/:id/policies/:policyId   # Attach policy to role
DELETE /api/rbac/roles/:id/policies/:policyId   # Detach policy from role
```

### Policy Management

```text
GET    /api/rbac/policies           # List all policies
POST   /api/rbac/policies           # Create a new policy
GET    /api/rbac/policies/:id       # Get policy details
PUT    /api/rbac/policies/:id       # Update a policy
DELETE /api/rbac/policies/:id       # Delete a policy
POST   /api/rbac/policies/validate  # Validate policy rules (dry run)
```

### Permission Checks

```text
POST   /api/rbac/permissions/check        # Check single permission
POST   /api/rbac/permissions/check-bulk   # Check multiple permissions
GET    /api/rbac/permissions/effective     # Get effective permissions for current user
```

---

## Caching and Invalidation

### RBAC Cache

| Cache Key Pattern | TTL | Content |
|------------------|-----|---------|
| `policy:ability:{userId}:{tenantId}` | 5 minutes | Compiled CASL ability object |

### Invalidation Methods

| Method | Trigger |
|--------|---------|
| `invalidateUser(userId)` | User role or assignment changes |
| `invalidateRole(roleId)` | Role definition or policy attachment changes |
| `invalidatePolicy(policyId)` | Policy rule changes |
| `invalidateUserGroup(userIds)` | Bulk user changes |
| `invalidateTenant(tenantId)` | Tenant-wide changes |
| `invalidateAll()` | System-wide policy changes |

Cache invalidation is event-driven: when a role, policy, or assignment changes, the system events trigger cache cleanup for affected users.

---

## Audit Logging

### Architecture

All CRUD operations are automatically logged through an event-driven pipeline:

```text
Service.createEntity()
    │
    ├──► broadcastSysEvent(ResourceCreated, {
    │        resourceId, data, previousData
    │    })
    │
    ▼
SysEventService (EventEmitter2 listener)
    │
    ├──► Queue AuditLogJob → Redis/BullMQ → AuditLog table
    ├──► Queue UserActivityJob → Redis/BullMQ → Activity tracking
    └──► Queue SysEventJob → Redis/BullMQ → Event processing
```

### AuditLog Schema

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUIDv7 | Time-sortable identifier |
| `tenantId` | String | Organization scope |
| `responsibleUserId` | String | Actor who performed the action |
| `responsibleIp` | String | Request IP address |
| `resourceType` | Enum | Consultation, User, Media, etc. |
| `resourceId` | String | Affected resource ID |
| `action` | Enum | CREATE, READ, UPDATE, DELETE, ARCHIVE, LOGIN, LOGOUT |
| `eventType` | String | AUTHORIZATION, RESOURCE, SYSTEM, AUTHENTICATION |
| `success` | Boolean | Operation outcome |
| `data` | JSONB | Current/new state |
| `previousData` | JSONB | Previous state (for updates, enables diff) |
| `correlationId` | String | Distributed tracing ID |
| `causationId` | String | Triggering event ID |
| `metadata` | JSONB | Additional context |

### Authorization Audit

The `AuthorizationAuditService` separately logs every permission check:

- **Persistence**: Stored asynchronously (fire-and-forget) in the database
- **Real-time**: Published to Redis `authorization:audit` channel for monitoring
- **Denial tracking**: Denial records tracked with configurable TTL for anomaly detection

### Audit API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/audit-logs` | Paginated audit log query |
| GET | `/api/audit-logs/:id` | Single audit entry |
| GET | `/api/audit-logs/resource/:type/:id` | Logs by resource |
| GET | `/api/audit-logs/user/:userId` | Logs by actor |

---

## Security Hardening

### Implemented Measures

| Category | Implementation |
|----------|---------------|
| **Secure token generation** | Cryptographically random token generation for refresh tokens and API keys |
| **Token revocation** | Redis blacklist for revoked JWT tokens |
| **Rate limiting** | `express-rate-limit` + `@nestjs/throttler` per user/tenant/endpoint |
| **Security headers** | Helmet middleware for HTTP security headers |
| **Input validation** | `class-validator` decorators on all DTOs |
| **SQL injection prevention** | Prisma parameterized queries (no raw SQL) |
| **Sensitive data redaction** | Passwords and PII sanitized before logging |
| **CORS configuration** | NestJS built-in CORS with configurable origins |

### Resolved Vulnerabilities

| Issue | Resolution |
|-------|-----------|
| SQL injection risk | Migrated to Prisma parameterized queries |
| Sensitive data in logs | Implemented structured logging with PII redaction |
| Weak refresh tokens | Switched to cryptographically secure random generation |
| Missing token revocation | Added Redis-backed token blacklist |
| Unpinned dependencies | Locked all dependency versions |
| Missing security headers | Enabled Helmet middleware |
| No rate limiting | Implemented per-endpoint rate limits |

---

## Data Protection

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Transport | TLS/SSL (OpenSSL) | Encryption in transit |
| At-rest | AES-256 | Database encryption |
| Password | bcryptjs (salt-based) | Secure password hashing |
| Token signing | RS256 (asymmetric JWT) | Stateless, verifiable authentication |
| Input validation | class-validator | Request data integrity |

---

## Security Best Practices

### Access Control Principles

| Practice | Implementation |
|----------|---------------|
| Default deny | No permissions unless explicitly granted via policy |
| Tenant isolation | All queries include `tenantId` condition |
| No privilege escalation | Users cannot assign roles above their own level |
| System role protection | `isSystemRole: true` prevents modification of built-in roles |
| API key scoping | Intersection with user permissions, never union |
| 404 over 403 | Return NOT_FOUND for inaccessible resources to prevent enumeration |

### Operational Security

| Practice | Description |
|----------|-------------|
| Correlation IDs | Distributed tracing across all services |
| Comprehensive audit | All operations logged to PostgreSQL |
| MFA recommendation | Recommended for Super Admin accounts |
| Secret management | HashiCorp Vault for sensitive configuration |
| Dependency scanning | Regular vulnerability scanning of dependencies |

---

## Related Documentation

- [Project Brief & Requirements](./01_PROJECT_BRIEF_AND_REQUIREMENTS.md) — Security requirements and compliance scope
- [Technical Architecture](./02_TECHNICAL_ARCHITECTURE.md) — System architecture and communication patterns
- [Quality Control](./03_QUALITY_CONTROL.md) — Security testing and CI/CD pipeline
