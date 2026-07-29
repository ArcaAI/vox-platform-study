# API Gateway Reference

**Version**: 2.0
**Last Updated**: 2026-02-22
**API Version**: v1 (global prefix: `/api/v1`)

## Table of Contents

- [Overview](#overview)
- [Base Configuration](#base-configuration)
- [Guards & Decorators](#guards--decorators)
- [Interceptors](#interceptors)
- [Controllers](#controllers)
- [Services](#services)
- [Data Models](#data-models)
- [WebSocket Gateways](#websocket-gateways)

---

## Overview

This document provides a technical reference for the HOPE API Gateway internal architecture, including guards, decorators, interceptors, controllers, and services.

---

## Base Configuration

### main.ts

The application entry point configures:

- **Global Prefix**: `api/v1` — all public endpoints are prefixed with `/api/v1/`
- **Internal Route Exclusion**: Routes matching `internal/(.*)` are excluded from the global prefix
- **Default Port**: `8868`
- **CORS**: Environment-specific origin validation
- **Validation**: Global validation pipes for DTOs
- **Session**: Express session management
- **Security Headers**: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection
- **Swagger**: API documentation at `/api/v1/docs` (non-production only)
- **Sentry**: Error tracking (production only)
- **Highlight**: Observability and session replay

**Key Functions:**

#### `isOriginAllowed(origin: string, nodeEnv: string): boolean`

Validates request origins based on environment.

**Development**: All origins allowed
**Staging**: Localhost + staging domains + dev tools
**Production**: Configured origins + HTTPS origins (SDK-friendly)

#### `getCorsOrigins(nodeEnv: string)`

Returns CORS configuration for environment.

---

## Guards & Decorators

### Authentication Guards

#### ApiKeyGuard

**Location**: `src/guards/apikey.guard.ts`

Validates API key authentication using `X-API-Key` header.

```typescript
import { ApiKeyGuard } from '@/guards';

@UseGuards(ApiKeyGuard)
@Controller('protected')
export class ProtectedController {}
```

**Features:**

- Header-based API key validation
- Integration with ApiKeyValidationService
- Scope-based permission checking
- Rate limiting per API key

---

#### JwtAuthGuard

**Location**: `src/guards/jwtauth.guard.ts`

Validates JWT bearer tokens for user authentication.

```typescript
import { JwtAuthGuard } from '@/guards';

@UseGuards(JwtAuthGuard)
@Controller('user-protected')
export class UserProtectedController {}
```

**Features:**

- Bearer token validation
- User extraction and context injection
- Token expiration handling
- Refresh token support

---

#### OidcAuthGuard

**Location**: `src/guards/oidcauth.guard.ts`

Handles OpenID Connect authentication for enterprise SSO.

```typescript
import { OidcAuthGuard } from '@/guards';

@UseGuards(OidcAuthGuard)
@Controller('sso-protected')
export class SsoProtectedController {}
```

**Features:**

- OIDC provider integration
- Multiple identity provider support
- Automatic user provisioning
- Role mapping from OIDC claims

---

### Authorization Guards

#### RolesGuard

**Location**: `src/guards/roles.guard.ts`

Enforces role-based access control.

```typescript
import { JwtAuthGuard, RolesGuard } from '@/guards';
import { UseRoles } from '@/decorators';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin')
export class AdminController {
  @Post()
  @UseRoles('admin', 'manager')
  async adminEndpoint() {}
}
```

**Features:**

- Multiple role support
- Hierarchical role checking
- Tenant-aware authorization

---

#### GroupsGuard

**Location**: `src/guards/groups.guard.ts`

Enforces group-based access control.

```typescript
import { JwtAuthGuard, GroupsGuard } from '@/guards';
import { UseGroups } from '@/decorators';

@UseGuards(JwtAuthGuard, GroupsGuard)
@Controller('team')
export class TeamController {
  @Get()
  @UseGroups('doctors', 'nurses')
  async teamEndpoint() {}
}
```

---

### Custom Decorators

#### @Public()

**Location**: `src/decorators/public.decorator.ts`

Marks endpoints as public (bypasses authentication).

```typescript
import { Public } from '@/decorators';

@Controller('public')
export class PublicController {
  @Get()
  @Public()
  async publicEndpoint() {
    // No authentication required
  }
}
```

---

#### @ApiKeyProtected()

**Location**: `src/decorators/api-key-protected.decorator.ts`

Marks endpoints as requiring API key authentication.

```typescript
import { ApiKeyProtected } from '@/decorators';

@Controller('service')
@ApiKeyProtected()
export class ServiceController {}
```

---

#### @UseRoles(...roles: string[])

**Location**: `src/decorators/useRoles.decorator.ts`

Specifies required roles for endpoint access.

```typescript
import { UseRoles } from '@/decorators';

@Post()
@UseRoles('admin', 'manager')
async restrictedEndpoint() {}
```

---

#### @UseGroups(...groups: string[])

**Location**: `src/decorators/useGroups.decorator.ts`

Specifies required groups for endpoint access.

```typescript
import { UseGroups } from '@/decorators';

@Get()
@UseGroups('medical-staff')
async groupRestrictedEndpoint() {}
```

---

#### @AuthUser()

**Location**: `src/decorators/authUser.decorator.ts`

Extracts authenticated user from request.

```typescript
import { AuthUser } from '@/decorators';

@Get()
async getUserProfile(@AuthUser() user: any) {
  return {
    id: user.id,
    email: user.email,
    tenantId: user.tenantId
  };
}
```

**User Object Structure:**

```typescript
{
  id: string;
  email: string;
  tenantId: string;
  roles: string[];
  groups: string[];
  metadata: Record<string, any>;
}
```

---

#### @ApiEndpoint()

**Location**: `src/decorators/apiEndpoint.decorator.ts`

Combines multiple decorators for standardized API endpoints.

```typescript
import { ApiEndpoint } from '@/decorators';
import { HttpMethod } from '@arcaai/applications';

@ApiEndpoint({
  returnedModel: UserResponseDto,
  method: HttpMethod.GET,
  path: ':id',
  by: ['id'],
  multi: false
})
async getUserById(@Param('id') id: string) {}
```

**Options:**

- `returnedModel`: Response DTO class
- `method`: HTTP method (GET, POST, PUT, DELETE, PATCH)
- `path`: Route path
- `by`: Path parameters
- `multi`: Array response flag

---

## Interceptors

### ContextInterceptor

**Location**: `src/interceptors/context.interceptor.ts`

Manages request context with correlation IDs.

**Features:**

- Request ID generation (X-Request-Id header or UUID v7)
- Context propagation across async operations
- Request/response logging
- Timing metrics

**Context Structure:**

```typescript
{
  requestId: string;
  userId?: string;
  tenantId?: string;
  timestamp: Date;
  method: string;
  path: string;
}
```

---

### ExceptionInterceptor

**Location**: `src/interceptors/exception.interceptor.ts`

Handles exception transformation and logging.

**Features:**

- Standardized error responses
- Error classification (client vs server)
- Sentry error reporting
- PII redaction from error logs

**Error Response Format:**

```typescript
{
  error: {
    code: string;
    message: string;
    details?: any;
    timestamp: string;
    requestId: string;
  }
}
```

---

### MaintenanceInterceptor

**Location**: `src/interceptors/maintenance.interceptor.ts`

Handles maintenance mode enforcement.

**Features:**

- Global maintenance mode flag
- Whitelisted endpoints during maintenance
- Custom maintenance messages
- Graceful degradation

---

## Controllers

### SessionController

**Location**: `src/controllers/session/session.controller.ts`

Manages medical session lifecycle.

**Dependencies:**

- `ISessionService`: Session business logic
- `IKafkaService`: Event publishing

#### Endpoints

##### POST /api/v1/sessions

Creates a new medical session.

**Request:** `CreateSessionRequest`

```typescript
{
  patientId: string;
  sessionType: SessionType;
  metadata?: Record<string, any>;
}
```

**Response:** `SessionResponse`

**Events Published:** `session.created`

---

##### GET /api/sessions/:id

Retrieves session by ID.

**Response:** `SessionResponse`

---

##### PUT /api/sessions/:id

Updates session.

**Request:** `UpdateSessionRequest`
**Response:** `SessionResponse`
**Events Published:** `session.updated`

---

##### DELETE /api/sessions/:id

Deletes session.

**Response:** `SessionResponse`
**Events Published:** `session.deleted`

---

##### POST /api/v1/sessions/:id/validate

Validates session state.

**Response:** `SessionValidateResponse`

```typescript
{
  isValid: boolean;
  session?: SessionResponse;
  reason?: string;
}
```

---

##### POST /api/v1/sessions/:id/sync

Syncs session data across devices.

**Request:** `SessionSyncRequest`

```typescript
{
  syncData: {
    transcriptUpdates?: any[];
    audioChunks?: any[];
    lastSyncedAt: Date;
  }
}
```

**Response:** `SessionResponse`
**Events Published:** `session.synced`

---

##### GET /api/v1/sessions/patient/:patientId

Lists sessions for a patient.

**Query Parameters:** `PaginatedQuery`
**Response:** `PaginatedSessionResponse`

---

### BaseProxyController (Abstract)

**Location**: `src/shared/base-proxy.controller.ts`

Shared abstract base class for all proxy controllers. Provides lazy proxy creation, request ID generation, structured logging, and error handling via `http-proxy-middleware`.

**Configuration Interface:**

```typescript
interface ProxyControllerConfig {
  serviceUrl: string;
  serviceName: string;
  pathRewriteFrom: string;
  pathRewriteTo: string;
  proxyTimeout?: number; // default: 60000
  timeout?: number; // default: 60000
}
```

---

### STT Controllers (Audio)

> STT v1 (`SttController`, `SttGateway`) has been removed. All transcription is handled via STT.

**Location**: `src/modules/stt/`

| Controller                      | Route                      | Purpose                     |
| ------------------------------- | -------------------------- | --------------------------- |
| `TranscriptionJobController`    | `audio/transcription-jobs` | Job CRUD                    |
| `TranscriptionStreamController` | `audio/transcription-jobs` | Streaming endpoints         |
| `PipelineController`            | `audio/pipelines`          | Pipeline management         |
| `AiModelController`             | `audio/ai-models`          | AI model listing            |
| `SttInternalController`         | `internal/stt`             | Internal service-to-service |

---

### SmrProxyController (Text Proxy)

**Location**: `src/modules/streaming/smr-proxy.controller.ts`
**Route**: `text` → `/api/v1/text/**`

**Proxy Configuration:**

- **Target**: `SMR_URL || 'http://localhost:8862'`
- **Path Rewrite**: `^/api/v1/text` → (empty)
- **Timeout**: 120000ms

---

> **NLP** has no gateway proxy controller — it is a downstream Python service (`:8864`) the gateway only health-monitors via `/api/v1/health/services`.

---

### Admin Controllers

| Controller                 | Route                 | Purpose                |
| -------------------------- | --------------------- | ---------------------- |
| `GlobalSettingsController` | `admin/settings`      | Global settings CRUD   |
| `TenantController`         | `admin/tenants`       | Tenant management      |
| `ApiKeyController`         | `admin/api-keys`      | API key management     |
| `AuditLogController`       | `admin/audit-logs`    | Audit log access       |
| `RolesController`          | `admin/rbac/roles`    | RBAC role management   |
| `PoliciesController`       | `admin/rbac/policies` | RBAC policy management |
| `PstudioController`        | `admin/pstudio`       | Prisma Studio          |

---

### User Self-Service Controllers

| Controller                  | Route              | Purpose          |
| --------------------------- | ------------------ | ---------------- |
| `UserPreferencesController` | `user/me`          | User preferences |
| `UserSettingsController`    | `user/me/settings` | User settings    |

---

### HealthModule

**Location**: `src/modules/health/health.module.ts`

Provides health check endpoints.

**Imports:** `HealthCheckServiceModule` from `@arcaai/applications`

**Endpoints:**

- `GET /api/v1/health` - Basic health check
- `GET /api/v1/health/ready` - Readiness probe (checks dependencies)
- `GET /api/v1/health/live` - Liveness probe

---

## Services

### ApiKeyValidationService

**Location**: `src/services/api-key-validation.service.ts`

Validates and manages API keys.

**Methods:**

#### `validateApiKey(apiKey: string): Promise<ApiKeyValidation>`

Validates an API key.

**Returns:**

```typescript
{
  valid: boolean;
  tenantId?: string;
  scopes?: string[];
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
  };
}
```

---

### Session Service (from @arcaai/applications)

**Interface:** `ISessionService`

Handles session business logic.

**Methods:**

#### `create(request: CreateSessionRequest): Promise<Session>`

Creates a new session.

#### `fetchById(id: string): Promise<Session>`

Retrieves session by ID.

#### `update(id: string, request: UpdateSessionRequest): Promise<Session>`

Updates session.

#### `deleteById(id: string): Promise<Session>`

Deletes session.

#### `validateSession(id: string): Promise<ValidationResult>`

Validates session state.

#### `syncSession(id: string, syncData: any): Promise<Session>`

Syncs session data.

#### `fetchAll(query: PaginatedQuery): Promise<PaginatedResult<Session>>`

Lists all sessions with pagination.

#### `fetchAllByPatientId(query: PatientQuery): Promise<PaginatedResult<Session>>`

Lists sessions for a specific patient.

#### `fetchAllByTenantId(query: TenantQuery): Promise<PaginatedResult<Session>>`

Lists sessions for a specific tenant.

---

### Kafka Service (from @arcaai/applications)

**Interface:** `IKafkaService`

Handles event streaming with Kafka.

**Methods:**

#### `publishSessionEvent(eventType: string, session: Session): Promise<void>`

Publishes session lifecycle events.

**Event Types:**

- `session.created`
- `session.updated`
- `session.deleted`
- `session.synced`

---

## Data Models

### Session

**Source**: `@arcaai/domains`

```typescript
interface Session {
  id: string;
  patientId: string;
  tenantId: string;
  sessionType: SessionType;
  status: SessionStatus;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
  updatedBy?: string;
}

enum SessionType {
  CONSULTATION = 'CONSULTATION',
  FOLLOW_UP = 'FOLLOW_UP',
  EMERGENCY = 'EMERGENCY',
  TELEHEALTH = 'TELEHEALTH',
}

enum SessionStatus {
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}
```

---

### Paginated Result

```typescript
interface PaginatedResult<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

---

### Paginated Query

```typescript
interface PaginatedQuery {
  page?: number; // Default: 1
  limit?: number; // Default: 20, Max: 100
  sortBy?: string; // Default: 'createdAt'
  sortOrder?: 'asc' | 'desc'; // Default: 'desc'
}
```

---

## WebSocket Gateways

> **Note**: The STT v1 gateway (`SttGateway` at `/stt`) has been removed. Use STT gateway instead.

### SttGateway

**Location**: `src/modules/stt/sttV2.gateway.ts`

Provides real-time STT streaming.

**Namespace**: `/stt`

---

## Error Codes

### Standard Error Codes

| Code                    | HTTP Status | Description                         |
| ----------------------- | ----------- | ----------------------------------- |
| `VALIDATION_ERROR`      | 400         | Request validation failed           |
| `UNAUTHORIZED`          | 401         | Missing or invalid authentication   |
| `FORBIDDEN`             | 403         | Insufficient permissions            |
| `RESOURCE_NOT_FOUND`    | 404         | Requested resource not found        |
| `CONFLICT`              | 409         | Resource conflict (duplicate, etc.) |
| `RATE_LIMIT_EXCEEDED`   | 429         | Too many requests                   |
| `INTERNAL_SERVER_ERROR` | 500         | Unexpected server error             |
| `SERVICE_UNAVAILABLE`   | 503         | Service temporarily unavailable     |

---

## Environment-Specific Behavior

### Development

- All origins allowed (CORS)
- Swagger UI enabled
- Debug logging enabled
- No Sentry reporting

### Staging

- Localhost + staging domains allowed (CORS)
- Swagger UI enabled (with auth)
- Info-level logging
- Sentry reporting to staging project

### Production

- Configured origins + HTTPS allowed (CORS)
- Swagger UI disabled
- Warn/Error logging only
- Sentry reporting to production project
- HSTS headers enabled

---

## Performance Considerations

### Request Timeouts

- **Default**: 30 seconds
- **Long-running operations**: 5 minutes
- **WebSocket idle**: 24 hours

### Rate Limiting

- **Default**: 100 requests/15 minutes per IP
- **Authenticated**: 1000 requests/hour per user
- **API Key**: Configurable per key

### Caching

- Session data: 5 minutes (Redis)
- Static responses: 1 hour (Redis)
- API key validation: 10 minutes (in-memory)

---

## Security Notes

### Authentication Priority

1. API Key (if X-API-Key header present)
2. JWT Bearer Token (if Authorization header present)
3. OIDC Session (if valid session cookie)

### CORS Policy

- **Development**: Allow all
- **Staging**: Whitelist + localhost
- **Production**: Whitelist + all HTTPS (SDK-friendly)

### Rate Limiting

Applied per:

- IP address (global)
- User ID (authenticated)
- API key (service)
- Tenant ID (multi-tenant)

---

## Additional Resources

- [Implementation Status](./01-implementation-status.md)
- [Development Guide](./02-development-guide.md)
- [Usage Guide](./03-usage-guide.md)
- [Deployment Guide](./04-deployment-guide.md)

---

**Document Version**: 1.0
**Last Updated**: 2025-01-10
