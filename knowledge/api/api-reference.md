# API Gateway — Endpoint Reference

Base URL: `http://localhost:8868/api/v1` (development) | `https://api.hope.com/api/v1` (production)

Global prefix: `/api` (applied to all routes except `/metrics`). All endpoints require authentication unless decorated with `@Public()`. Authentication methods: `x-api-key` header, `Authorization: Bearer <jwt>`, or OIDC session cookie. See [README.md](./README.md) for guard-chain details.

---

## Health & Monitoring

Health endpoints are under the `health` controller with the global `/api` prefix. The `/metrics` endpoint is excluded from the global prefix.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/health` | None | Detailed health check (status, uptime, environment) |
| GET | `/api/v1/health/live` | None | Liveness probe — process alive |
| GET | `/api/v1/health/ready` | None | Readiness probe — returns 503 during shutdown |
| GET | `/api/v1/health/startup` | None | Startup probe — initialization complete |
| GET | `/metrics` | None | Prometheus metrics (no `/api` prefix; restrict in production) |

### GET /api/v1/health

**Response** `200`

```json
{
  "status": "healthy",
  "ready": true,
  "shuttingDown": false,
  "uptime": 86400.123,
  "environment": "development",
  "timestamp": "2025-01-15T10:30:45.123Z"
}
```

### GET /api/v1/health/ready

**Response** `200` (or `503` during shutdown/startup)

```json
{
  "status": "ok",
  "ready": true,
  "shuttingDown": false,
  "timestamp": "2025-01-15T10:30:45.123Z"
}
```

---

## Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/auth/login` | None | Authenticate with username/password, returns JWT + refresh token |
| POST | `/api/v1/auth/logout` | JWT | Invalidate session |
| GET | `/api/v1/auth/me` | JWT | Get current user info (id, username, email, roles, permissions) |

### POST /api/v1/auth/login

**Request**

```json
{
  "username": "john.doe",
  "password": "secret"
}
```

**Response** `200`

```json
{
  "user": {
    "id": "...",
    "username": "john.doe",
    "email": "john@example.com",
    "roles": ["admin"],
    "permissions": ["manage:all"]
  },
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "refresh_..."
}
```

---

## Consultation

Manages the full consultation lifecycle using a get-or-create pattern with context items, summaries, timeline, and NER.

### Core Consultation Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/consultations/open` | API Key | Open consultation (get or create by patient/doctor/date) |
| POST | `/api/v1/consultations/:parentId/revisit` | API Key | Create re-visit/follow-up consultation |
| GET | `/api/v1/consultations/:id` | API Key | Get consultation by ID |
| GET | `/api/v1/consultations/patient/:patientId/history` | API Key | Patient consultation history (paginated) |
| GET | `/api/v1/consultations/patient/:patientId/date/:date` | API Key | Consultations by patient and date |
| GET | `/api/v1/consultations/:id/chain` | API Key | Get consultation chain (parent + children) |

### Context Items

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/consultations/:id/context` | API Key | Add context item (transcription, case note, etc.) |
| PATCH | `/api/v1/consultations/:id/context/:contextId` | API Key | Update context item (creates version snapshot) |
| GET | `/api/v1/consultations/:id/context` | API Key | List context items (optional filters: type, source; paginated) |
| GET | `/api/v1/consultations/:id/context/shared` | API Key | Shared context from all doctors on same date |
| GET | `/api/v1/consultations/:id/context/transcriptions` | API Key | Get transcription context items |
| GET | `/api/v1/consultations/:id/context/case-notes` | API Key | Get case note context items |
| GET | `/api/v1/consultations/:id/context/:contextId/versions` | API Key | Context item version history |
| GET | `/api/v1/consultations/:id/context/:contextId/versions/:versionNumber` | API Key | Specific version of context item |

### Summary

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/consultations/:consultationId/summary` | API Key | Generate final summary |
| POST | `/api/v1/consultations/:consultationId/summary/pre-summary` | API Key | Generate pre-summary from case notes |
| GET | `/api/v1/consultations/:consultationId/summary` | API Key | List all summaries |
| GET | `/api/v1/consultations/:consultationId/summary/latest` | API Key | Get latest summary |
| GET | `/api/v1/consultations/:consultationId/summary/pre-summary/latest` | API Key | Get latest pre-summary |
| PATCH | `/api/v1/consultations/:consultationId/summary/:contextItemId` | API Key | Update summary content |
| POST | `/api/v1/consultations/:consultationId/summary/:contextItemId/extract-entities` | API Key | Extract NER entities from summary (sync) |
| POST | `/api/v1/consultations/:consultationId/summary/comprehensive` | API Key | Generate cross-chain comprehensive summary (sync) |
| POST | `/api/v1/consultations/:consultationId/summary/comprehensive/async` | API Key | Generate comprehensive summary (async, returns job ID) |
| POST | `/api/v1/consultations/:consultationId/summary/pre-summary/async` | API Key | Generate pre-summary (async) |
| POST | `/api/v1/consultations/:consultationId/summary/async` | API Key | Generate summary (async) |
| POST | `/api/v1/consultations/:consultationId/summary/:contextItemId/extract-entities/async` | API Key | Extract entities (async) |

### Jobs

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/consultations/jobs/:jobId` | API Key | Get background job status |
| DELETE | `/api/v1/consultations/jobs/:jobId` | API Key | Cancel background job |
| SSE | `/api/v1/consultations/jobs/:jobId/sse` | API Key | SSE stream for real-time job updates |

### Timeline & NER

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/consultations/:id/timeline` | API Key | Chronological event timeline (scope: single or chain) |
| GET | `/api/v1/consultations/:id/named-entities` | API Key | Aggregate NER entities across chain (scope: single or chain) |

---

## Department

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/departments` | JWT | List all departments |
| GET | `/api/v1/departments/roots` | JWT | List root departments (no parent) |
| GET | `/api/v1/departments/:id` | JWT | Get department by ID |
| GET | `/api/v1/departments/code/:code` | JWT | Get department by code |
| GET | `/api/v1/departments/:id/children` | JWT | Get child departments |
| POST | `/api/v1/departments` | JWT | Create department |
| PATCH | `/api/v1/departments/:id` | JWT + `manage:all` | Update department |
| PATCH | `/api/v1/departments/:id/prompt-config` | JWT + `manage:all` | Update department prompt config |
| DELETE | `/api/v1/departments/:id` | JWT + `manage:all` | Soft-delete department |

---

## DNA Writing Style

Manages AI writing-style profiles for doctors used by the summarization service.

### User Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/dna-writing-styles/generate` | JWT | Queue DNA report generation for current doctor |
| GET | `/api/v1/dna-writing-styles/me` | JWT | Get my DNA writing style |
| PATCH | `/api/v1/dna-writing-styles/:reportId` | JWT | Update DNA report (creates version) |
| GET | `/api/v1/dna-writing-styles/:reportId/versions` | JWT | Get version history for a report |

### Admin Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/admin/dna-writing-styles/generate/:doctorId` | JWT + `manage:all` | Queue DNA generation for specific doctor |
| GET | `/api/v1/admin/dna-writing-styles` | JWT + `manage:all` | List all DNA reports (filterable by doctorId) |
| PATCH | `/api/v1/admin/dna-writing-styles/:reportId` | JWT + `manage:all` | Update any DNA report (bypasses ownership) |
| GET | `/api/v1/admin/dna-writing-styles/jobs/:jobId` | JWT + `manage:all` | Get DNA generation job status |

---

## Prompt Management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/prompt-templates` | JWT + `manage:all` | Create prompt template |
| GET | `/api/v1/prompt-templates` | JWT | List prompt templates (filters: category, departmentId) |
| GET | `/api/v1/prompt-templates/:id` | JWT | Get prompt template by ID |
| PATCH | `/api/v1/prompt-templates/:id` | JWT + `manage:all` | Update prompt template (creates version) |
| DELETE | `/api/v1/prompt-templates/:id` | JWT + `manage:all` | Soft-delete prompt template |
| GET | `/api/v1/prompt-templates/:id/versions` | JWT | Get version history |
| GET | `/api/v1/prompt-templates/:id/versions/:versionNumber` | JWT | Get specific version |

---

## RBAC (Roles & Policies)

### Roles

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/rbac/roles` | JWT + `manage:Role` | List roles (paginated, searchable) |
| GET | `/api/v1/rbac/roles/:id` | JWT + `manage:Role` | Get role by ID (with policies) |
| POST | `/api/v1/rbac/roles` | JWT + `manage:Role` | Create role |
| PUT | `/api/v1/rbac/roles/:id` | JWT + `manage:Role` | Update role |
| DELETE | `/api/v1/rbac/roles/:id` | JWT + `manage:Role` | Soft-delete role (204) |
| POST | `/api/v1/rbac/roles/:roleId/policies/:policyId` | JWT + `manage:RolePolicy` | Assign policy to role |
| DELETE | `/api/v1/rbac/roles/:roleId/policies/:policyId` | JWT + `manage:RolePolicy` | Remove policy from role (204) |

### Policies

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/rbac/policies` | JWT + `manage:Policy` | List policies (paginated, searchable, filterable by scope) |
| GET | `/api/v1/rbac/policies/:id` | JWT + `manage:Policy` | Get policy by ID |
| POST | `/api/v1/rbac/policies` | JWT + `manage:Policy` | Create policy (with rule validation) |
| PUT | `/api/v1/rbac/policies/:id` | JWT + `manage:Policy` | Update policy |
| DELETE | `/api/v1/rbac/policies/:id` | JWT + `manage:Policy` | Soft-delete policy (204) |
| POST | `/api/v1/rbac/policies/validate` | JWT + `manage:Policy` | Validate policy rules |

### Permission Checks

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/rbac/check` | JWT (Authenticated) | Check single permission |
| POST | `/api/v1/rbac/check/bulk` | JWT (Authenticated) | Check multiple permissions at once |
| POST | `/api/v1/rbac/check/my-permissions` | JWT (Authenticated) | Get current user's effective permissions |

---

## User Management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/users` | JWT + `create:User` | Create user |
| GET | `/api/v1/users` | JWT + `read:User` | List users (paginated) |
| GET | `/api/v1/users/:id` | JWT + `read:User` | Get user by ID |
| GET | `/api/v1/users/external/:externalId` | JWT + `read:User` | Get user by external ID |
| PATCH | `/api/v1/users/:id` | JWT + `update:User` | Update user |
| DELETE | `/api/v1/users/:id` | JWT + `delete:User` | Delete user |

---

## User Preferences

SDK-synced preferences. Accessible via API Key authentication.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/users/me/preferences` | API Key | Get current user preferences |
| POST | `/api/v1/users/me/preferences` | API Key | Update preferences (partial) |
| POST | `/api/v1/users/me/preferences/reset` | API Key | Reset preferences to defaults (204) |

---

## User Settings

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/user-settings` | JWT + `create:UserSettings` | Create user settings |
| GET | `/api/v1/user-settings` | JWT + `read:UserSettings` | List user settings (paginated) |
| GET | `/api/v1/user-settings/:id` | JWT + `read:UserSettings` | Get user settings by ID |
| GET | `/api/v1/user-settings/tenant/:tenantId` | JWT + `read:UserSettings` | Get settings by tenant |
| GET | `/api/v1/user-settings/user/:userId` | JWT + `read:UserSettings` | Get settings by user |
| GET | `/api/v1/user-settings/config/tenant/:tenantId` | JWT + `read:UserSettings` | Get tenant config |
| PATCH | `/api/v1/user-settings/:id` | JWT + `update:UserSettings` | Update user settings |
| DELETE | `/api/v1/user-settings/:id` | JWT + `delete:UserSettings` | Delete user settings |

---

## Global Settings

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/global-setting` | JWT + `create:GlobalSetting` | Create global setting |
| GET | `/api/v1/global-setting` | JWT + `read:GlobalSetting` | List global settings (paginated) |
| GET | `/api/v1/global-setting/:id` | JWT + `read:GlobalSetting` | Get global setting by ID |
| GET | `/api/v1/global-setting/tenant/:tenantId` | JWT + `read:GlobalSetting` | Get settings by tenant |
| GET | `/api/v1/global-setting/user/:userId` | JWT + `read:GlobalSetting` | Get settings by user |
| GET | `/api/v1/global-setting/config/tenant/:tenantId` | JWT + `read:GlobalSetting` | Get tenant config |
| PATCH | `/api/v1/global-setting/:id` | JWT + `update:GlobalSetting` | Update global setting |
| DELETE | `/api/v1/global-setting/:id` | JWT + `delete:GlobalSetting` | Delete global setting |

---

## Tenant

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/tenants` | JWT | Create tenant |
| GET | `/api/v1/tenants` | JWT | List tenants (paginated) |
| GET | `/api/v1/tenants/:id` | JWT | Get tenant by ID |
| GET | `/api/v1/tenants/code-name/:code-name` | JWT | Get tenant by code name |
| GET | `/api/v1/tenants/user/:userId` | JWT | Get tenants by user |
| PATCH | `/api/v1/tenants/:id` | JWT | Update tenant |
| DELETE | `/api/v1/tenants/:id` | JWT | Delete tenant |
| GET | `/api/v1/tenants/configs/:identifier` | JWT | Get tenant configs |
| PATCH | `/api/v1/tenants/configs/:identifier` | JWT | Update tenant configs |

---

## Audit Log

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/audit-logs` | JWT + `read:AuditLog` | List audit log entries (paginated) |
| GET | `/api/v1/audit-logs/:id` | JWT + `read:AuditLog` | Get audit log entry by ID |
| GET | `/api/v1/audit-logs/resource/:resourceType/:resourceId` | JWT + `read:AuditLog` | Get logs by resource |
| GET | `/api/v1/audit-logs/user/:userId` | JWT + `read:AuditLog` | Get logs by user |
| DELETE | `/api/v1/audit-logs/:id` | JWT + `delete:AuditLog` | Soft-delete audit log entry |

---

## Feedback

Proxied to the Feedback microservice at `FEEDBACK_SERVICE_URL_HTTP` / `FEEDBACK_URL`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/feedback/summary` | API Key | Submit summary-level feedback metrics |
| POST | `/api/v1/feedback/events` | API Key | Submit batch of interaction events |
| POST | `/api/v1/feedback/labels` | API Key | Submit batch of explicit feedback labels |

---

## Monitoring

Downstream service health dashboard.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/monitoring/uptime` | JWT | Get uptime data for all services |
| GET | `/api/v1/monitoring/uptime/:service` | JWT | Get uptime for specific service (stt, smr, nlp) |
| GET | `/api/v1/monitoring/heartbeats/:service` | JWT | Get heartbeat history for a service |
| GET | `/api/v1/monitoring/sessions` | JWT | Get active session counts per service |

---

## STT V2

Advanced STT pipeline with model management, job orchestration, and real-time streaming.

### Pipelines

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/audio/pipelines` | JWT | Create ASR pipeline |
| GET | `/api/v1/audio/pipelines` | JWT | List pipelines (paginated) |
| GET | `/api/v1/audio/pipelines/:id` | JWT | Get pipeline by ID |
| GET | `/api/v1/audio/pipelines/slug/:slug` | JWT | Get pipeline by slug |
| PATCH | `/api/v1/audio/pipelines/:id` | JWT | Update pipeline |
| DELETE | `/api/v1/audio/pipelines/:id` | JWT | Delete pipeline (204) |
| POST | `/api/v1/audio/pipelines/validate` | JWT | Validate pipeline YAML |

### AI Models

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/audio/ai-models` | JWT | Create AI model |
| GET | `/api/v1/audio/ai-models` | JWT | List models (paginated) |
| GET | `/api/v1/audio/ai-models/:id` | JWT | Get model by ID |
| GET | `/api/v1/audio/ai-models/slug/:slug` | JWT | Get model by slug |
| GET | `/api/v1/audio/ai-models/task/:taskType` | JWT | Get models by task type |
| GET | `/api/v1/audio/ai-models/status/downloaded` | JWT | Get downloaded models |
| PATCH | `/api/v1/audio/ai-models/:id` | JWT | Update model |
| PATCH | `/api/v1/audio/ai-models/:id/download-status` | JWT | Update download status |
| DELETE | `/api/v1/audio/ai-models/:id` | JWT | Delete model (204) |

### Transcription Jobs

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/audio/transcription-jobs` | JWT | Create transcription job |
| POST | `/api/v1/audio/transcription-jobs/batch` | JWT | Create batch job |
| POST | `/api/v1/audio/transcription-jobs/streaming` | JWT | Create streaming job |
| POST | `/api/v1/audio/transcription-jobs/stream/session` | JWT | Create streaming session (returns sessionId for WS) |
| GET | `/api/v1/audio/transcription-jobs` | JWT | List jobs (paginated) |
| GET | `/api/v1/audio/transcription-jobs/stats` | JWT | Get job status counts |
| GET | `/api/v1/audio/transcription-jobs/:id` | JWT | Get job by ID |
| GET | `/api/v1/audio/transcription-jobs/consultation/:consultationId` | JWT | Get jobs by consultation |
| GET | `/api/v1/audio/transcription-jobs/status/:status` | JWT | Get jobs by status |
| PATCH | `/api/v1/audio/transcription-jobs/:id/cancel` | JWT | Cancel a job |
| PATCH | `/api/v1/audio/transcription-jobs/:id/retry` | JWT | Retry a failed job |

### Transcription Streaming (SSE)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/audio/transcription-jobs/transcribe` | JWT | Upload audio + SSE stream (`multipart/form-data`) |
| SSE | `/api/v1/audio/transcription-jobs/:jobId/stream` | JWT | Reconnect to job's SSE stream |

### Internal (Service-to-Service)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/internal/stt/transcripts` | API Key | Create transcript (called by STT-v2) |
| PATCH | `/internal/stt/jobs/:id/start` | API Key | Mark job as processing |
| PATCH | `/internal/stt/jobs/:id/progress` | API Key | Update job progress |
| PATCH | `/internal/stt/jobs/:id/complete` | API Key | Complete job with results |
| PATCH | `/internal/stt/jobs/:id/fail` | API Key | Mark job as failed |
| POST | `/internal/stt/audio-records` | API Key | Create audio recording record |

### STT V2 WebSocket

WebSocket gateway at `/ws/stt-v2/stream` for real-time audio streaming.

---

## SMR Proxy

Proxied to the Summarization service at `SMR_URL` (port 8862) via `BaseProxyController`. Path rewrite: `/api/v1/text` → `` (root).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/text/api/v1/health` | API Key | SMR service health |
| POST | `/api/v1/text/api/v1/summary/sync` | API Key | Synchronous summarization |
| POST | `/api/v1/text/api/v1/summary/async` | API Key | Start async summarization |
| POST | `/api/v1/text/api/v1/summary/feedback` | API Key | Submit summary feedback |
| POST | `/api/v1/text/api/v1/presummary` | API Key | Generate pre-summary |
| GET | `/api/v1/text/api/v1/jobs/:jobId` | API Key | Get job status |
| DELETE | `/api/v1/text/api/v1/jobs/:jobId` | API Key | Cancel job |
| GET | `/api/v1/text/api/v1/jobs` | API Key | List all jobs |
| GET | `/api/v1/text/api/v1/models/info` | API Key | Get LLM model info |
| GET | `/api/v1/text/api/v1/sse/health` | API Key | SSE health check |
| GET | `/api/v1/text/api/v1/sse/jobs/:jobId` | API Key | SSE job updates stream |

---

## NLP Proxy

Proxied to the NLP service at `NLP_URL` (port 8864) via `BaseProxyController`. Path rewrite: `/api/v1/nlp` → `/api/v1`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/nlp/health` | API Key | NLP service health |
| GET | `/api/v1/nlp/metrics` | API Key | NLP service metrics |
| POST | `/api/v1/nlp/classify/text` | API Key | Classify medical text |
| POST | `/api/v1/nlp/classify/tokens` | API Key | Token classification (NER) |
| GET | `/api/v1/nlp/pipeline/config` | API Key | Get pipeline configuration |
| PUT | `/api/v1/nlp/pipeline/config` | API Key | Update pipeline configuration |
| POST | `/api/v1/nlp/correct` | API Key | Correct spelling/terminology |
| POST | `/api/v1/nlp/suggest` | API Key | Get medical findings suggestions |

### NLP WebSocket

WebSocket gateway for real-time NLP processing.

---

## Prisma Studio (Admin)

Embedded database browser for admin users. Conditionally loaded based on `ENABLE_PRISMA_STUDIO` (enabled by default in non-production). The GET endpoint serves a self-contained HTML page that loads the Prisma Studio UI from CDN; the POST endpoint acts as the BFF (Backend for Frontend) query executor.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/admin/pstudio` | None (requires `?token=` query param) | Serve Prisma Studio HTML page |
| POST | `/api/v1/admin/pstudio` | JWT + `manage:all` | Execute Studio database query (BFF endpoint) |

### Access

```
http://localhost:8868/api/v1/admin/pstudio?token=<jwt-token>
```

Obtain a JWT token via `POST /api/v1/auth/login` with a `SUPER_ADMIN` user, then pass it as the `?token=` query parameter. The Studio UI embeds the token into all BFF POST requests as a Bearer header.

---

## Standard Response Formats

### Success (single resource)

```json
{
  "id": "...",
  "field": "value",
  "createdAt": "2025-01-15T10:30:45.123Z",
  "updatedAt": "2025-01-15T10:30:45.123Z"
}
```

### Success (paginated list)

```json
{
  "data": [ ... ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

### Error

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Session with ID abc123 not found",
    "details": {},
    "timestamp": "2025-01-15T10:30:45.123Z",
    "requestId": "req_abc123"
  }
}
```

### Pagination Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | 1 | Page number (1-indexed) |
| `limit` | integer | 20 | Items per page (max 100) |
| `sortBy` | string | `createdAt` | Sort field |
| `sortOrder` | string | `desc` | `asc` or `desc` |

---

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Request validation failed |
| `UNAUTHORIZED` | 401 | Missing or invalid authentication |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `RESOURCE_NOT_FOUND` | 404 | Requested resource not found |
| `CONFLICT` | 409 | Duplicate resource or state conflict |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests |
| `INTERNAL_SERVER_ERROR` | 500 | Unexpected server error |
| `SERVICE_UNAVAILABLE` | 503 | Downstream service unavailable or maintenance mode |

---

## Authentication Methods

### API Key

Supports multiple header formats:

```http
x-api-key: sk_live_abc123...
api-key: sk_live_abc123...
apikey: sk_live_abc123...
```

Also supports query parameter `?apiKey=...` (not recommended for production).

### JWT Bearer Token

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

Obtained via `POST /api/v1/auth/login`.

### OIDC

Browser-based redirect flow via OIDC identity providers.

### Authentication Priority

When multiple credentials are present, the gateway evaluates in order:
1. API Key (if `x-api-key` / `api-key` / `apikey` header present)
2. JWT Bearer Token (if `Authorization` header present)
3. OIDC session (if valid session cookie exists)

---

## Related Documentation

- [API Gateway Overview](./README.md)
- [Configuration](./configuration.md)
- [SMR Service API](../smr-v2/api-reference.md)
