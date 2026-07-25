# TASK-210: API Route Standardization

| Field | Value |
|---|---|
| **Ticket** | TASK-210 |
| **Created** | 2026-02-21 |
| **Last Updated** | 2026-02-22 |
| **Status** | Completed |

---

## 1. Requirement Analysis

### Business Context

The HOPE API Gateway (`apps/api/`) has grown organically across multiple tickets, resulting in:

- **Inconsistent route conventions** -- some endpoints use `/api/stt`, others `/api/api/v1/transcription-jobs` (double prefix bug), others `/api/smr/api/v2/generate`.
- **Deprecated modules still active** -- STT v1 proxy module is registered in `app.module.ts` alongside STT, exposing two complete transcription systems simultaneously.
- **Code duplication** -- five proxy controllers share ~85% identical boilerplate (~860 lines total).
- **No clear access control tiers** -- admin endpoints, user endpoints, and public endpoints are mixed without a consistent URL convention.
- **Inconsistent port assignments** -- environment files reference conflicting port numbers across `.env`, `.env.dev`, `.env.production`, and `apps/api/.env.example`.

### Goals

1. Establish a unified route convention: `GET /api/v1/<domain>/...`
2. Separate routes into clear tiers: **Public**, **User/SDK** (`/api/v1/<domain>`), **Admin** (`/api/v1/admin/<domain>`), **Internal** (`/internal/<domain>`)
3. Remove STT v1 module entirely
4. Consolidate proxy controller boilerplate into a shared base class
5. Standardize port assignments for all Python microservices
6. Update SDK v2 endpoint constants to match new routes
7. Remove duplicate settings endpoints

### Acceptance Criteria

- All API endpoints follow `/api/v1/<domain>` convention
- Admin endpoints are under `/api/v1/admin/<domain>`
- User self-service endpoints are under `/api/v1/user/me`
- Internal service-to-service endpoints are under `/internal/<domain>` (no `/api/v1` prefix)
- STT v1 module is completely removed
- Proxy controllers extend a shared `BaseProxyController`
- SDK v2 constants file updated with all new paths
- All environment files use standardized port assignments
- No duplicate endpoints exist

---

## 2. Current State Evaluation

### 2.1 Global Prefix

**File**: `apps/api/src/main.ts` (line 198)

```typescript
const globalPrefix = 'api';
app.setGlobalPrefix(globalPrefix, {
    exclude: ['/metrics']
});
```

The global prefix `api` is prepended to all `@Controller()` paths. A controller with `@Controller('users')` produces `/api/users`.

### 2.2 Current Route Map

All 35 controllers with their current `@Controller()` decorator path and resulting full URL:

| # | Controller File | `@Controller()` Path | Full URL | Auth |
|---|---|---|---|---|
| 1 | `api-key/api-key.controller.ts` | `api-keys` | `/api/api-keys` | JWT + RBAC |
| 2 | `audit-log/audit-log.controller.ts` | `audit-logs` | `/api/audit-logs` | JWT + RBAC |
| 3 | `auth/auth.controller.ts` | `auth` | `/api/auth` | Public (login) / JWT |
| 4 | `consultation/consultation.controller.ts` | `consultations` | `/api/consultations` | API Key |
| 5 | `consultation/job.controller.ts` | `consultations/jobs` | `/api/consultations/jobs` | API Key |
| 6 | `consultation/summary.controller.ts` | `consultations/:id/summary` | `/api/consultations/:id/summary` | API Key |
| 7 | `department/department.controller.ts` | `departments` | `/api/departments` | JWT + RBAC |
| 8 | `dna-writing-style/dna-writing-style-admin.controller.ts` | `admin/dna-writing-styles` | `/api/admin/dna-writing-styles` | JWT + RBAC |
| 9 | `dna-writing-style/dna-writing-style.controller.ts` | `dna-writing-styles` | `/api/dna-writing-styles` | JWT |
| 10 | `feedback/feedback.controller.ts` | `feedback` | `/api/feedback` | API Key |
| 11 | `fedl/fedl.controller.ts` | `fedl` | `/api/fedl` | API Key |
| 12 | `global-settings/global-settings.controller.ts` | `global-setting` | `/api/global-setting` | JWT + RBAC |
| 13 | `health/health.controller.ts` | `health` | `/api/health` | Public |
| 14 | `monitoring/monitoring.controller.ts` | `monitoring` | `/api/monitoring` | JWT |
| 15 | `nlp/nlp.controller.ts` | `nlp` | `/api/nlp` | API Key |
| 16 | `prompt-management/prompt-management.controller.ts` | `prompt-templates` | `/api/prompt-templates` | JWT + RBAC |
| 17 | `pstudio/pstudio.controller.ts` | `pstudio` | `/api/pstudio` | Public (GET) / JWT+RBAC (POST) |
| 18 | `rbac/permission-check.controller.ts` | `rbac/check` | `/api/rbac/check` | JWT + RBAC |
| 19 | `rbac/policies.controller.ts` | `rbac/policies` | `/api/rbac/policies` | JWT + RBAC |
| 20 | `rbac/roles.controller.ts` | `rbac/roles` | `/api/rbac/roles` | JWT + RBAC |
| 21 | `smr/smr.controller.ts` | `smr` | `/api/smr` | API Key |
| 22 | `storage/storage.controller.ts` | `storage` | `/api/storage` | JWT + RBAC |
| 23 | `stt/stt.controller.ts` | `stt` | `/api/stt` | API Key |
| 24 | `stt/aiModel.controller.ts` | `api/v1/ai-models` | `/api/api/v1/ai-models` | JWT |
| 25 | `stt/pipeline.controller.ts` | `api/v1/pipelines` | `/api/api/v1/pipelines` | JWT |
| 26 | `stt/sttInternal.controller.ts` | `internal/stt` | `/api/internal/stt` | API Key |
| 27 | `stt/transcriptionJob.controller.ts` | `api/v1/transcription-jobs` | `/api/api/v1/transcription-jobs` | JWT |
| 28 | `stt/transcriptionStream.controller.ts` | `api/v1/transcription-jobs` | `/api/api/v1/transcription-jobs` | JWT |
| 29 | `tenant/tenant.controller.ts` | `tenants` | `/api/tenants` | JWT |
| 30 | `tts/tts.controller.ts` | `tts` | `/api/tts` | API Key |
| 31 | `user/user-role-assignment.controller.ts` | `users` | `/api/users` | JWT + RBAC |
| 32 | `user/users.controller.ts` | `users` | `/api/users` | JWT + RBAC |
| 33 | `user/voice-embedding.controller.ts` | `users` | `/api/users` | JWT + RBAC |
| 34 | `user-preferences/user-preferences.controller.ts` | `users/me` | `/api/users/me` | API Key |
| 35 | `user-settings/user-settings.controller.ts` | `user-settings` | `/api/user-settings` | JWT + RBAC |

**Issues identified:**

- Rows 24, 25, 27, 28: STT controllers include `api/v1/` in their `@Controller()` path, producing a double prefix `/api/api/v1/...`
- Row 23: STT v1 is still active alongside STT
- Row 12: `global-setting` (singular) is inconsistent with `user-settings` (plural with hyphen)
- Row 26: Internal controller gets `/api/internal/stt` instead of `/internal/stt`
- No consistent admin vs user vs public tier separation in URL structure

### 2.3 Current Port Assignments

| Service | `.env` | `.env.dev` | `.env.production` | `apps/api/.env.example` | Proxy Default |
|---|---|---|---|---|---|
| STT v1 | -- | -- | 5003 | 5003 | `http://localhost:5003` |
| STT | -- | 8001 | -- | 8002 | -- (native NestJS) |
| TTS | 5004 | 5004 | 5004 | 5004 | `http://localhost:5004` |
| NLP | 5005 | 5005 | 5005 | -- | `http://localhost:5005` |
| SMR | 5006 | 5006 | 5006 | -- | `http://localhost:5006` |
| FedL | 5021 | 5021 | -- | -- | `http://localhost:8000` |
| LLM (legacy) | -- | -- | -- | 5005 | -- |

**Issues identified:**

- STT v1 port (5003) is still referenced in `.env.production` and `apps/api/.env.example`
- FedL has conflicting ports: env files say 5021, proxy controller defaults to 8000
- LLM_PORT=5005 in `apps/api/.env.example` conflicts with NLP on the same port
- `STT_URL` varies: 8001 in `.env.dev`, 8002 in `apps/api/.env.example`

### 2.4 Current Auth Patterns

| Guard | Used By |
|---|---|
| **No guard (Public)** | `health.controller.ts`, `auth.controller.ts` (login only), `pstudio.controller.ts` (GET) |
| **`ApiKeyGuard`** | `consultation.controller.ts`, `job.controller.ts`, `summary.controller.ts`, `stt.controller.ts`, `tts.controller.ts`, `smr.controller.ts`, `nlp.controller.ts`, `fedl.controller.ts`, `feedback.controller.ts`, `user-preferences.controller.ts`, `sttInternal.controller.ts` |
| **`JwtAuthGuard`** | `auth.controller.ts` (logout/me), `tenant.controller.ts`, `department.controller.ts`, `dna-writing-style.controller.ts`, `prompt-management.controller.ts`, `monitoring.controller.ts`, all `stt/*.controller.ts` |
| **JWT + RBAC** (`@CanRead/@CanCreate/...`) | `users.controller.ts`, `user-role-assignment.controller.ts`, `voice-embedding.controller.ts`, `user-settings.controller.ts`, `global-settings.controller.ts`, `api-key.controller.ts`, `audit-log.controller.ts`, `storage.controller.ts` |
| **JWT + `@CanManage('all')`** | `roles.controller.ts`, `policies.controller.ts`, `department.controller.ts`, `dna-writing-style-admin.controller.ts`, `prompt-management.controller.ts` |

### 2.5 WebSocket Gateways

| Gateway | Path | Auth | Architecture |
|---|---|---|---|
| STT v1 | `/stt` | API Key (query param) | Proxy to external WS at `STT_WS_URL` |
| STT | `/ws/stt/stream` | JWT or API Key (query param) | Redis Streams-based |
| NLP | `/nlp` | API Key (query param) | Proxy to NLP service WS |
| TTS | `/tts` | API Key (query param) | Proxy to TTS service WS |

### 2.6 SDK v2 Endpoint Constants

**File**: `packages/agentic-sdk-v2/src/core/constants.ts` (528 lines)

The SDK defines 20+ endpoint constant groups. Key observations:

- STT endpoints use `/api/v1/...` prefix (e.g., `/api/v1/transcription-jobs`) which matches the double-prefix bug on the backend
- NLP endpoints use `/nlp/...` (no version prefix)
- Settings endpoints use `/global-settings/...` and `/user-settings/...`
- Admin DNA endpoints use `/admin/dna-writing-styles/...`
- No STT v1 references (already cleaned)
- Deprecated `DNA_ENDPOINTS` still present (replaced by `DNA_STYLE_ENDPOINTS`)

### 2.7 Duplicate Endpoints Found

**Within GlobalSettingsController** (`/api/global-setting`):
- `GET /tenant/:tenantId` and `GET /config/tenant/:tenantId` both call `fetchAllByTenantId()` -- identical results

**Within UserSettingsController** (`/api/user-settings`):
- `GET /tenant/:tenantId` and `GET /config/tenant/:tenantId` both call `fetchAllByTenantId()` -- identical results

### 2.8 Proxy Controller Duplication

Five controllers use nearly identical `http-proxy-middleware` patterns (~85% code overlap):

| Controller | Target Env Var | Default Port | Path Rewrite | Timeout |
|---|---|---|---|---|
| `stt.controller.ts` | `STT_URL` | 5003 | `/api/stt` -> `/api` | none |
| `tts.controller.ts` | `TTS_URL` | 5004 | `/api/tts` -> `/api/tts` | 60s |
| `smr.controller.ts` | `SMR_SERVICE_URL_HTTP` / `SMR_URL` | 5006 | `/api/smr` -> `` | 120s |
| `nlp.controller.ts` | `NLP_SERVICE_URL_HTTP` / `NLP_URL` | 5005 | `/api/nlp` -> `/api/v1` | 60s |
| `fedl.controller.ts` | `FEDL_URL` | 8000 | `/api/fedl` -> `/api/v1` | 60s |

---

## 3. Target State

### 3.1 New Route Convention

```
/api/v1/<domain>/...          -- User/SDK endpoints (authenticated)
/api/v1/admin/<domain>/...    -- Admin endpoints (JWT + RBAC)
/api/v1/user/me/...           -- Current user self-service
/api/v1/auth/...              -- Authentication (login is public)
/api/v1/health/...            -- Health probes (public)
/internal/<domain>/...        -- Service-to-service (API Key, no /api/v1 prefix)
```

### 3.2 New Port Assignments

| Service | Port | Env Variable |
|---|---|---|
| API Gateway | 8868 | `PORT` |
| STT | 8861 | `STT_URL` |
| SMR | 8862 | `SMR_URL` |
| TTS | 8863 | `TTS_URL` |
| NLP | 8864 | `NLP_URL` |
| FedL | 8865 | `FEDL_URL` |

### 3.3 Complete Route Mapping (Current -> New)

| # | Controller | Current `@Controller()` | New `@Controller()` | New Full URL | Auth Tier |
|---|---|---|---|---|---|
| 1 | `api-key.controller.ts` | `api-keys` | `admin/api-keys` | `/api/v1/admin/api-keys` | Admin |
| 2 | `audit-log.controller.ts` | `audit-logs` | `admin/audit-logs` | `/api/v1/admin/audit-logs` | Admin |
| 3 | `auth.controller.ts` | `auth` | `auth` | `/api/v1/auth` | Public/User |
| 4 | `consultation.controller.ts` | `consultations` | `consultations` | `/api/v1/consultations` | SDK |
| 5 | `job.controller.ts` | `consultations/jobs` | `consultations/jobs` | `/api/v1/consultations/jobs` | SDK |
| 6 | `summary.controller.ts` | `consultations/:id/summary` | `consultations/:id/summary` | `/api/v1/consultations/:id/summary` | SDK |
| 7 | `department.controller.ts` | `departments` | `departments` | `/api/v1/departments` | Admin |
| 8 | `dna-writing-style-admin.controller.ts` | `admin/dna-writing-styles` | `admin/dna-writing-styles` | `/api/v1/admin/dna-writing-styles` | Admin |
| 9 | `dna-writing-style.controller.ts` | `dna-writing-styles` | `dna-writing-styles` | `/api/v1/dna-writing-styles` | User |
| 10 | `feedback.controller.ts` | `feedback` | `feedback` | `/api/v1/feedback` | SDK |
| 11 | `fedl.controller.ts` | `fedl` | `fedl` | `/api/v1/fedl` | SDK |
| 12 | `global-settings.controller.ts` | `global-setting` | `admin/settings` | `/api/v1/admin/settings` | Admin |
| 13 | `health.controller.ts` | `health` | `health` | `/api/v1/health` | Public |
| 14 | `monitoring.controller.ts` | `monitoring` | `monitoring` | `/api/v1/monitoring` | User |
| 15 | `nlp.controller.ts` | `nlp` | `nlp` | `/api/v1/nlp` | SDK |
| 16 | `prompt-management.controller.ts` | `prompt-templates` | `prompt-templates` | `/api/v1/prompt-templates` | Admin |
| 17 | `pstudio.controller.ts` | `pstudio` | `admin/pstudio` | `/api/v1/admin/pstudio` | Admin |
| 18 | `permission-check.controller.ts` | `rbac/check` | `rbac/check` | `/api/v1/rbac/check` | User |
| 19 | `policies.controller.ts` | `rbac/policies` | `admin/rbac/policies` | `/api/v1/admin/rbac/policies` | Admin |
| 20 | `roles.controller.ts` | `rbac/roles` | `admin/rbac/roles` | `/api/v1/admin/rbac/roles` | Admin |
| 21 | `smr.controller.ts` | `smr` | `text` | `/api/v1/text` | SDK |
| 22 | `storage.controller.ts` | `storage` | `storage` | `/api/v1/storage` | User |
| 23 | **REMOVED** `stt.controller.ts` | `stt` | -- | -- | -- |
| 24 | `aiModel.controller.ts` | `api/v1/ai-models` | `audio/ai-models` | `/api/v1/audio/ai-models` | User |
| 25 | `pipeline.controller.ts` | `api/v1/pipelines` | `audio/pipelines` | `/api/v1/audio/pipelines` | User |
| 26 | `sttInternal.controller.ts` | `internal/stt` | `internal/stt` | `/internal/stt` | Internal |
| 27 | `transcriptionJob.controller.ts` | `api/v1/transcription-jobs` | `audio/transcription-jobs` | `/api/v1/audio/transcription-jobs` | User |
| 28 | `transcriptionStream.controller.ts` | `api/v1/transcription-jobs` | `audio/transcription-jobs` | `/api/v1/audio/transcription-jobs` | User |
| 29 | `tenant.controller.ts` | `tenants` | `admin/tenants` | `/api/v1/admin/tenants` | Admin |
| 30 | `tts.controller.ts` | `tts` | `speech` | `/api/v1/speech` | SDK |
| 31 | `user-role-assignment.controller.ts` | `users` | `users` | `/api/v1/users` | Admin |
| 32 | `users.controller.ts` | `users` | `users` | `/api/v1/users` | Admin |
| 33 | `voice-embedding.controller.ts` | `users` | `users` | `/api/v1/users` | User |
| 34 | `user-preferences.controller.ts` | `users/me` | `user/me` | `/api/v1/user/me` | SDK |
| 35 | `user-settings.controller.ts` | `user-settings` | `user/me/settings` | `/api/v1/user/me/settings` | User |

### 3.4 Access Control Matrix

#### Public Endpoints (No Authentication)

| Route | Method | Purpose |
|---|---|---|
| `/api/v1/auth/login` | POST | User login |
| `/api/v1/health` | GET | Detailed health check |
| `/api/v1/health/live` | GET | Kubernetes liveness probe |
| `/api/v1/health/ready` | GET | Kubernetes readiness probe |
| `/api/v1/health/startup` | GET | Kubernetes startup probe |

#### SDK/User Endpoints (API Key or JWT)

| Route Pattern | Auth | Guard | Who |
|---|---|---|---|
| `/api/v1/auth/logout` | JWT | `JwtAuthGuard` | Authenticated users |
| `/api/v1/auth/me` | JWT | `JwtAuthGuard` | Authenticated users |
| `/api/v1/consultations/**` | API Key | `ApiKeyGuard` | SDK clients |
| `/api/v1/audio/**` | JWT | `JwtAuthGuard` | Authenticated users |
| `/api/v1/text/**` | API Key | `ApiKeyGuard` | SDK clients (SMR proxy) |
| `/api/v1/speech/**` | API Key | `ApiKeyGuard` | SDK clients (TTS proxy) |
| `/api/v1/nlp/**` | API Key | `ApiKeyGuard` | SDK clients (NLP proxy) |
| `/api/v1/fedl/**` | API Key | `ApiKeyGuard` | SDK clients (FedL proxy) |
| `/api/v1/feedback/**` | API Key | `ApiKeyGuard` | SDK clients |
| `/api/v1/dna-writing-styles/**` | JWT | `JwtAuthGuard` | Doctors |
| `/api/v1/storage/**` | JWT + RBAC | `@CanRead/Create/Delete('Storage')` | Authorized users |
| `/api/v1/user/me/preferences` | API Key | `ApiKeyGuard` | Current user (SDK) |
| `/api/v1/user/me/settings` | JWT + RBAC | `@CanRead/Update('UserSettings')` | Current user |
| `/api/v1/monitoring/**` | JWT | `JwtAuthGuard` | Authenticated users |
| `/api/v1/rbac/check` | JWT + RBAC | `@CanManage('Policy')` | Authorized users |

#### Admin Endpoints (JWT + RBAC)

| Route Pattern | Guard | Who |
|---|---|---|
| `/api/v1/admin/settings/**` | `@CanRead/Create/Update/Delete('GlobalSetting')` | SUPER_ADMIN, TENANT_ADMIN |
| `/api/v1/admin/tenants/**` | JWT | TENANT_ADMIN+ |
| `/api/v1/admin/api-keys/**` | `@CanRead/Create/Update/Delete('ApiKey')` | Admins |
| `/api/v1/admin/audit-logs/**` | `@CanRead/Delete('AuditLog')` | Admins |
| `/api/v1/admin/rbac/roles/**` | `@CanManage('Role')` | Admins |
| `/api/v1/admin/rbac/policies/**` | `@CanManage('Policy')` | Admins |
| `/api/v1/admin/dna-writing-styles/**` | `@CanManage('all')` | Admins |
| `/api/v1/admin/pstudio` | `@Authorize(['manage', 'all'])` | Admins |
| `/api/v1/users/**` (CRUD) | `@CanRead/Create/Update/Delete('User')` | Admins |
| `/api/v1/departments/**` | `@CanManage('all')` | Admins |
| `/api/v1/prompt-templates/**` | `@CanManage('all')` | Admins |

#### Internal Endpoints (Service-to-Service)

| Route Pattern | Auth | Guard | Who |
|---|---|---|---|
| `/internal/stt/**` | API Key | `ApiKeyGuard` + `@SkipThrottle` | Python STT service |

### 3.5 WebSocket Paths (After Refactoring)

| Gateway | Current Path | New Path | Change |
|---|---|---|---|
| STT v1 | `/stt` | **REMOVED** | Deleted with STT v1 module |
| STT | `/ws/stt/stream` | `/ws/stt/stream` | No change (not affected by global prefix) |
| NLP | `/nlp` | `/ws/nlp` | Updated to `/ws/` prefix convention |
| TTS | `/tts` | `/ws/tts` | Updated to `/ws/` prefix convention |

### 3.6 SDK v2 Endpoint Constants (New Values)

All paths are relative to the SDK `baseUrl` (which consumers will set to `http://host:8868/api/v1`).

| Constant Group | Key Changes |
|---|---|
| `CONSULTATION_ENDPOINTS` | No change (paths stay `/consultations/...`) |
| `CONTEXT_ENDPOINTS` | No change |
| `SUMMARY_ENDPOINTS` | No change |
| `ENTITY_ENDPOINTS` | No change |
| `PERSONALIZATION_ENDPOINTS` | `/users/me/preferences` -> `/user/me/preferences` |
| `DNA_ENDPOINTS` | Remove (deprecated) |
| `DNA_STYLE_ENDPOINTS` | No change (paths stay `/dna-writing-styles/...` and `/admin/dna-writing-styles/...`) |
| `PROMPT_TEMPLATE_ENDPOINTS` | No change |
| `DEPARTMENT_ENDPOINTS` | No change |
| `HEALTH_ENDPOINTS` | No change |
| `MONITORING_ENDPOINTS` | No change |
| `TENANT_ENDPOINTS` | `/tenants/configs/...` -> `/admin/tenants/configs/...` |
| `MODEL_ENDPOINTS` | `/api/v1/ai-models` -> `/audio/ai-models` |
| `AI_MODEL_ENDPOINTS` | `/api/v1/ai-models/...` -> `/audio/ai-models/...` |
| `STT_ENDPOINTS` | `/api/v1/transcription-jobs/...` -> `/audio/transcription-jobs/...` |
| `PIPELINE_ENDPOINTS` | `/api/v1/pipelines/...` -> `/audio/pipelines/...` |
| `NLP_ENDPOINTS` | No change (paths stay `/nlp/...`) |
| `AUTH_ENDPOINTS` | No change |
| `SERVICE_HEALTH_ENDPOINTS` | No change |
| `GLOBAL_SETTINGS_ENDPOINTS` | `/global-settings/...` -> `/admin/settings/...` |
| `USER_SETTINGS_ENDPOINTS` | `/user-settings/...` -> `/user/me/settings/...` |
| `CONSULTATION_JOB_ENDPOINTS` | No change |
| `USER_ENDPOINTS` | No change |
| `API_KEY_ENDPOINTS` | `/api-keys/...` -> `/admin/api-keys/...` |
| `STORAGE_ENDPOINTS` | No change |
| `ROLE_ENDPOINTS` | `/rbac/roles/...` -> `/admin/rbac/roles/...` |
| `VOICE_EMBEDDING_ENDPOINTS` | No change |

**SDK `baseUrl` change**: Consumers must update from `http://host:8868/api/v1/api` to `http://host:8868/api/v1`.

---

## 4. Implementation Plan

### Phase 1: Remove STT v1 Module

**Goal**: Delete the STT v1 proxy module entirely. No business logic exists in `packages/applications/` for v1.

**Files to delete:**

| File | Purpose |
|---|---|
| `apps/api/src/modules/stt/stt.controller.ts` | HTTP proxy controller (119 lines) |
| `apps/api/src/modules/stt/stt.gateway.ts` | WebSocket proxy gateway |
| `apps/api/src/modules/stt/stt.module.ts` | NestJS module definition |
| `apps/api/src/modules/stt/__tests__/stt.controller.swagger.test.ts` | Swagger test |

**Files to modify:**

| File | Change |
|---|---|
| `apps/api/src/app.module.ts` | Remove `import { SttModule }` (line 35) and `SttModule` from `featureModules` array (line 104) |
| `packages/applications/src/services/baseServices/serviceHealth/serviceHealthMonitoring.service.ts` | Remove STT v1 health check reference (`STT_URL` / port 5003) |

**Environment variable cleanup** (remove `STT_URL`, `STT_WS_URL`, `STT_PORT`):

| File | Variables to Remove |
|---|---|
| `.env.production` | `STT_PORT=5003`, `STT_URL=http://stt:5003` |
| `.env.test` | `STT_PORT=5003`, `STT_URL=http://localhost:5003` |
| `apps/api/.env.example` | `STT_PORT=5003`, `STT_URL=http://localhost:5003`, `STT_WS_URL=ws://localhost:5003/ws/stt` |
| `apps/api/.env.production` | `STT_PORT=5003`, `STT_URL=http://localhost:8002` |

### Phase 2: Change Global Prefix

**Goal**: Change the global prefix from `api` to `api/v1`, and exclude internal routes.

**File**: `apps/api/src/main.ts`

**Change** (line 198):
```typescript
// Before
const globalPrefix = 'api';
app.setGlobalPrefix(globalPrefix, {
    exclude: ['/metrics']
});

// After
const globalPrefix = 'api/v1';
app.setGlobalPrefix(globalPrefix, {
    exclude: [
        '/metrics',
        { path: 'internal/(.*)', method: RequestMethod.ALL },
    ],
});
```

**Also update** Swagger setup (line 254):
```typescript
// Before
SwaggerModule.setup('api', app, document);

// After
SwaggerModule.setup('api/v1/docs', app, document);
```

**Also update** security header CSP check (line 333):
```typescript
// Before
if (req.path === '/api' || req.path.startsWith('/api/docs')) {

// After
if (req.path === '/api/v1/docs' || req.path.startsWith('/api/v1/docs')) {
```

**Also update** startup log URLs (line 356-357):
```typescript
// Before
swaggerUrl: `http://localhost:${port}/api`,
healthUrl: `http://localhost:${port}/api/health`,

// After
swaggerUrl: `http://localhost:${port}/api/v1/docs`,
healthUrl: `http://localhost:${port}/api/v1/health`,
```

**Import needed**: Add `RequestMethod` to the `@nestjs/common` import.

### Phase 3: Rename All Controller Routes

**Goal**: Update every `@Controller()` decorator to match the new convention. Since global prefix is now `api/v1`, controllers only specify the domain name.

**Controllers that need `@Controller()` path changes:**

| File | Current | New |
|---|---|---|
| `stt/transcriptionJob.controller.ts` | `'api/v1/transcription-jobs'` | `'audio/transcription-jobs'` |
| `stt/transcriptionStream.controller.ts` | `'api/v1/transcription-jobs'` | `'audio/transcription-jobs'` |
| `stt/pipeline.controller.ts` | `'api/v1/pipelines'` | `'audio/pipelines'` |
| `stt/aiModel.controller.ts` | `'api/v1/ai-models'` | `'audio/ai-models'` |
| `smr/smr.controller.ts` | `'smr'` | `'text'` |
| `tts/tts.controller.ts` | `'tts'` | `'speech'` |
| `user-preferences/user-preferences.controller.ts` | `'users/me'` | `'user/me'` |
| `user-settings/user-settings.controller.ts` | `'user-settings'` | `'user/me/settings'` |
| `global-settings/global-settings.controller.ts` | `'global-setting'` | `'admin/settings'` |
| `tenant/tenant.controller.ts` | `'tenants'` | `'admin/tenants'` |
| `api-key/api-key.controller.ts` | `'api-keys'` | `'admin/api-keys'` |
| `audit-log/audit-log.controller.ts` | `'audit-logs'` | `'admin/audit-logs'` |
| `rbac/roles.controller.ts` | `'rbac/roles'` | `'admin/rbac/roles'` |
| `rbac/policies.controller.ts` | `'rbac/policies'` | `'admin/rbac/policies'` |
| `pstudio/pstudio.controller.ts` | `'pstudio'` | `'admin/pstudio'` |

**Controllers that stay the same** (no path change needed):

`auth`, `consultations`, `consultations/jobs`, `consultations/:id/summary`, `departments`, `admin/dna-writing-styles`, `dna-writing-styles`, `feedback`, `fedl`, `health`, `monitoring`, `nlp`, `prompt-templates`, `rbac/check`, `storage`, `users`, `user/voice-embedding`

**Note on `sttInternal.controller.ts`**: Currently `@Controller('internal/stt')`. With the global prefix exclusion for `internal/(.*)`, this will produce `/internal/stt` (correct). No change needed.

### Phase 4: Remove Duplicate Settings Endpoints

**Goal**: Clean up redundant endpoints.

**In `global-settings.controller.ts`** (now at `admin/settings`):
- Remove `fetchTenantConfig` method -- it duplicates `fetchAllByTenantId` (both call `globalSettingService.fetchAllByTenantId()`)

**In `user-settings.controller.ts`** (now at `user/me/settings`):
- Remove `fetchTenantConfig` method -- duplicates `fetchAllByTenantId`
- Consider removing `fetchAllByTenantId` and `fetchByUserId` since this controller is now scoped to the current user (`/user/me/settings`)

### Phase 5: Extract BaseProxyController

**Goal**: Consolidate the 4 remaining proxy controllers into a shared base class.

**New file**: `apps/api/src/shared/base-proxy.controller.ts`

```typescript
import { Logger, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';

export interface ProxyControllerConfig {
    serviceUrl: string;
    serviceName: string;
    pathRewriteFrom: string;
    pathRewriteTo: string;
    proxyTimeout?: number;
    timeout?: number;
}

export abstract class BaseProxyController {
    protected abstract readonly config: ProxyControllerConfig;
    protected abstract readonly logger: Logger;
    private _proxy: ReturnType<typeof createProxyMiddleware> | null = null;

    protected get proxy() {
        if (!this._proxy) {
            this._proxy = createProxyMiddleware({
                target: this.config.serviceUrl,
                changeOrigin: true,
                pathRewrite: { [this.config.pathRewriteFrom]: this.config.pathRewriteTo },
                secure: true,
                on: {
                    proxyReq: fixRequestBody,
                    proxyRes: (proxyRes, req) => { /* shared logging */ },
                    error: (err, req) => { /* shared error logging */ },
                },
                proxyTimeout: this.config.proxyTimeout ?? 60000,
                timeout: this.config.timeout ?? 60000,
            });
        }
        return this._proxy;
    }

    protected proxyRequest(@Req() req: Request, @Res() res: Response) {
        // Shared: requestId generation, timing, logging, error handling
    }
}
```

**Refactor these controllers to extend `BaseProxyController`:**

| Controller | `serviceUrl` | `pathRewriteFrom` | `pathRewriteTo` | `proxyTimeout` |
|---|---|---|---|---|
| `smr.controller.ts` (now `text`) | `SMR_URL \|\| 'http://localhost:8862'` | `'^/api/v1/text'` | `''` | 120000 |
| `tts.controller.ts` (now `speech`) | `TTS_URL \|\| 'http://localhost:8863'` | `'^/api/v1/speech'` | `'/api/tts'` | 60000 |
| `nlp.controller.ts` | `NLP_URL \|\| 'http://localhost:8864'` | `'^/api/v1/nlp'` | `'/api/v1'` | 60000 |
| `fedl.controller.ts` | `FEDL_URL \|\| 'http://localhost:8865'` | `'^/api/v1/fedl'` | `'/api/v1'` | 60000 |

### Phase 6: Update SDK v2 Constants

**Goal**: Update all endpoint paths in `packages/agentic-sdk-v2/src/core/constants.ts`.

**Key changes:**

```typescript
// STT_ENDPOINTS: '/api/v1/transcription-jobs/...' -> '/audio/transcription-jobs/...'
// AI_MODEL_ENDPOINTS: '/api/v1/ai-models/...' -> '/audio/ai-models/...'
// MODEL_ENDPOINTS: '/api/v1/ai-models/...' -> '/audio/ai-models/...'
// PIPELINE_ENDPOINTS: '/api/v1/pipelines/...' -> '/audio/pipelines/...'
// PERSONALIZATION_ENDPOINTS: '/users/me/...' -> '/user/me/...'
// GLOBAL_SETTINGS_ENDPOINTS: '/global-settings/...' -> '/admin/settings/...'
// USER_SETTINGS_ENDPOINTS: '/user-settings/...' -> '/user/me/settings/...'
// API_KEY_ENDPOINTS: '/api-keys/...' -> '/admin/api-keys/...'
// ROLE_ENDPOINTS: '/rbac/roles/...' -> '/admin/rbac/roles/...'
// TENANT_ENDPOINTS: '/tenants/configs/...' -> '/admin/tenants/configs/...'
```

**Also update:**
- All ~20 hook files in `packages/agentic-sdk-v2/src/hooks/` that reference these constants
- `AgenticClient` documentation -- consumers must change `baseUrl` from `http://host:8868/api/v1/api` to `http://host:8868/api/v1`
- Example apps in `packages/agentic-sdk-v2/examples/` -- update env vars

### Phase 7: Update Environment Files

**Goal**: Standardize all port assignments and remove deprecated variables.

**New standard values for all env files:**

```env
# API Gateway
PORT=8868

# STT (Speech-to-Text)
STT_PORT=8861
STT_URL=http://localhost:8861

# SMR (Text Generation / Summarization)
SMR_PORT=8862
SMR_URL=http://localhost:8862

# TTS (Text-to-Speech)
TTS_PORT=8863
TTS_URL=http://localhost:8863

# NLP (Natural Language Processing)
NLP_PORT=8864
NLP_URL=http://localhost:8864

# FedL (Federated Learning)
FEDL_PORT=8865
FEDL_URL=http://localhost:8865
```

**Variables to remove from all env files:**

| Variable | Reason |
|---|---|
| `STT_URL` | STT v1 removed |
| `STT_WS_URL` | STT v1 removed |
| `STT_PORT` | STT v1 removed (use `STT_PORT`) |
| `SMR_SERVICE_URL_HTTP` | Consolidated to `SMR_URL` |
| `NLP_SERVICE_URL_HTTP` | Consolidated to `NLP_URL` |
| `LLM_PORT` | Legacy reference |
| `LLM_URL` | Legacy reference |

**Files to update:**

| File | Changes |
|---|---|
| `.env` | Update TTS/SMR/NLP ports, add STT_URL, add FEDL_URL |
| `.env.dev` | Same + remove STT v1 vars |
| `.env.production` | Remove STT v1 vars, update all ports |
| `.env.test` | Remove STT v1 vars, update all ports |
| `.env.example` | Remove STT v1 vars, update all ports |
| `apps/api/.env.example` | Remove STT v1 vars, LLM vars, update all ports |
| `apps/api/.env.production` | Remove STT v1 vars, LLM vars, update all ports |

**Note**: Also update `packages/applications/src/services/baseServices/_meta/config/config.service.ts` to use new env var names.

### Phase 8: Update Documentation

**Files to update:**

| File | Changes |
|---|---|
| `apps/api/README.md` | Update all endpoint references, port assignments |
| `apps/api/docs/01-implementation-status.md` | Remove STT v1 references, update route paths |
| `apps/api/docs/03-usage-guide.md` | Update all example URLs to `/api/v1/...` |
| `apps/api/docs/04-deployment-guide.md` | Update env var references, port assignments |
| `apps/api/docs/05-api-reference.md` | Update all endpoint paths, remove STT v1 |
| `.cursor/rules/03-app-api.mdc` | Update module list, endpoint patterns |

---

## 5. Risk Assessment

### Breaking Changes

| Change | Impact | Mitigation |
|---|---|---|
| Global prefix `api` -> `api/v1` | All SDK consumers must update `baseUrl` | SDK version bump, migration guide |
| API port `3000` -> `8868` | All clients must update host:port | Update SDK examples, Docker configs |
| STT paths change | SDK consumers using STT | Updated constants in SDK |
| Admin routes move to `/admin/` | Admin UI must update API calls | Coordinate with frontend |
| Settings routes restructured | SDK consumers using settings | Updated constants in SDK |
| Port reassignments (886x range) | Docker/K8s configurations, Python services | Update infrastructure configs, conda envs |

### Rollback Strategy

1. All changes are in code (no database migrations) -- git revert is sufficient
2. Environment files can be reverted independently
3. SDK version can be pinned to pre-change version
4. Global prefix change is a single line in `main.ts`

### Testing Strategy

1. **Unit tests**: Verify each controller's route decorators
2. **Integration tests**: Hit each endpoint via HTTP to verify routing
3. **SDK tests**: Verify all SDK constants match backend routes
4. **E2E tests**: Run existing E2E test suite against new routes

---

## 6. Execution Order

| Phase | Description | Dependencies | Estimated Files |
|---|---|---|---|
| 1 | Remove STT v1 Module | None | ~4 deleted, ~8 modified |
| 2 | Change Global Prefix | None | 1 file |
| 3 | Rename All Controller Routes | Phase 2 | ~15 controllers |
| 4 | Remove Duplicate Endpoints | Phase 3 | 2 controllers |
| 5 | Extract BaseProxyController | Phase 3 | 1 new, 4 refactored |
| 6 | Update SDK v2 Constants | Phase 3 | ~25 files |
| 7 | Update Environment Files | Phase 5 | ~7 env files |
| 8 | Update Documentation | All phases | ~6 doc files |

---

## 7. Change History

| # | Date | Description | Status |
|---|---|---|---|
| 1 | 2026-02-21 | Initial documentation created | Complete |
| 2 | 2026-02-21 | Phase 2: Changed global prefix from `api` to `api/v1`, added internal route exclusion, updated Swagger path to `api/v1/docs`, updated CSP check and startup log URLs. TDD: 10 tests written and passing. | Complete |
| 3 | 2026-02-21 | Phase 1: Removed STT v1 module entirely (TDD). Deleted 4 files (controller, gateway, module, swagger test). Removed SttModule from AppModule. Removed STT v1 health check from ServiceHealthMonitoringService. Removed STT_PORT/STT_URL/LLM_PORT/LLM_URL from IAppConfig and ConfigService. Cleaned 4 env files. Updated SessionsResponse DTO. Updated existing test suites (serviceHealthMonitoring, config.service). 16 new TDD tests + 816 total passing. | Complete |
| 4 | 2026-02-21 | Phase 1 test hardening: Anti-pattern audit and edge case coverage. Added SttModule preservation tests, env file cleanup verification (4 files x 3-5 vars), health check URL correctness tests (port 5003 exclusion, TTS/SMR URL verification), LLM removal verification, Redis unavailability edge cases (3 scenarios), heartbeat data shape validation (responseTime, timestamp, non-ok status), uptime rounding (66.67%), status window boundary (2 heartbeats). Tests: 21 + 12 + 33 + 39 = 105 in Phase 1 files, 880 total passing across 30 files. | Complete |
| 5 | 2026-02-22 | Port assignment update: Revised all target port assignments to use the 886x range per latest decision. API=8868, STT=8861, SMR=8862, TTS=8863, NLP=8864, FedL=8865. Updated sections 3.2 (target ports), 3.6 (SDK baseUrl), Phase 5 (proxy targets), Phase 6 (SDK docs), Phase 7 (env values), and section 5 (risk assessment). Historical sections (2.3, 2.8) left unchanged as they document the pre-refactoring state. | Complete |
| 6 | 2026-02-22 | Phase 1 port-resilience refactor: Decoupled Phase 1 health-check tests from hardcoded port numbers (5004/5006) that will change in Phase 7 (886x migration). Tests now assert health endpoint paths (`/api/health`, `/api/v2/health`) and URL structure (`http://localhost:\d+/...`) instead of exact port values. STT v1 port 5003 exclusion test retained as it validates removal. Files: `stt-v1-health-removal.test.ts`, `serviceHealthMonitoring.service.test.ts`. 881 tests passing across 30 files. | Complete |
| 7 | 2026-02-22 | Phase 2 port alignment: Updated default port fallback in `main.ts` from `3000` to `8868` per 886x port convention. Added 2 regression guard tests (default port value, old port exclusion). 69 Phase 2 tests passing, 502 total passing across 29 files. | Complete |
| 9 | 2026-02-22 | Phase 4: Removed duplicate settings endpoints (TDD). **GlobalSettingsController**: removed `fetchTenantConfig` (duplicate of `fetchAllByTenantId`, both called `globalSettingService.fetchAllByTenantId()`). **UserSettingsController**: removed `fetchTenantConfig` (duplicate), `fetchAllByTenantId` (admin-scoped, doesn't belong on `/user/me/settings`), `fetchByUserId` (admin-scoped, doesn't belong on `/user/me/settings`). Updated `user-settings.controller.swagger.test.ts` to remove references to deleted methods. Files modified: `global-settings.controller.ts`, `user-settings.controller.ts`, `user-settings.controller.swagger.test.ts`. 2 new test files (24 TDD tests), 207 total passing across 5 Phase 3+4 test files. No regressions. | Complete |
| 8 | 2026-02-22 | Phase 3: Renamed all 15 controller routes (TDD). Changed `@Controller()` paths: 4 STT controllers (`api/v1/*` → `audio/*`), 2 proxy controllers (`smr` → `text`, `tts` → `speech`), 2 user self-service (`users/me` → `user/me`, `user-settings` → `user/me/settings`), 7 admin routes (added `admin/` prefix to settings, tenants, api-keys, audit-logs, rbac/roles, rbac/policies, pstudio). Updated `@ApiTags` on 7 controllers. Updated proxy `pathRewrite` rules on 4 controllers (smr, tts, nlp, fedl) to match new `/api/v1/<domain>` incoming paths. Updated 3 existing swagger tests. Updated e2e test URL. 72 new TDD tests, 574 total passing across 30 files (10 pre-existing failures in transcriptionStream unrelated). | Complete |
| 10 | 2026-02-22 | Phase 3 anti-pattern audit and edge case hardening. **Anti-pattern fix**: Added `Reflect.getMetadata(PATH_METADATA)` behavioral tests for all 16 controllers (15 renamed + internal) — source-level regex alone could miss commented-out decorators or overrides. **Bug fixes**: Fixed 2 hardcoded URLs in `pstudio.controller.ts` (`/api/pstudio` → `/api/v1/admin/pstudio`), fixed hardcoded SSE URL in `summary.controller.test.ts` (`/api/consultations/...` → `/api/v1/consultations/...`). **Edge cases added**: shared controller paths (2 controllers on `audio/transcription-jobs`, 3 on `users`), parameterized route composition (`:consultationId`, `:id`), proxy pathRewrite regex anchoring (5 tests), pstudio mixed auth decorators (`@Public` + `@Authorize` survive rename), stale old-path string literal sweep (8 controllers), complete 34-controller inventory with path format validation (no leading/trailing slashes, no double slashes). 161 Phase 3 tests passing, 748 total passing across 33 files. | Complete |
| 10a | 2026-02-22 | Phase 4 anti-pattern audit and edge case hardening. **Anti-pattern audit**: verified tests use real `Reflect.getMetadata` on actual classes (no mocks), no test pollution, TDD-first. **Edge cases added**: HTTP method metadata verification (GET=0, POST=1, PATCH=4, DELETE=3 for all 12 remaining endpoints across both controllers), authorization decorator preservation (7 `required_permissions` checks on GlobalSettings, 6 on UserSettings, plus empty-permissions sweep), route path metadata for all remaining endpoints, source-level regression guards (no stale `config/tenant`, `fetchTenantConfig`, `fetchAllByTenantId`, `fetchByUserId`, `tenant/:tenantId`, `user/:userId` in user-settings source), SDK endpoint mismatch documentation (3 tests proving controller no longer serves paths SDK still references — `user/:userId`, `tenant/:tenantId`, `config/tenant/:tenantId`). Tests: 76 Phase 4 tests (up from 24), 259 total passing across 5 Phase 3+4 test files. No regressions. | Complete |
| 11 | 2026-02-22 | Phase 5: Extracted BaseProxyController (TDD). Created `apps/api/src/shared/base-proxy.controller.ts` with shared proxy middleware setup, lazy proxy creation, request ID generation, structured logging, and error handling. Refactored 4 proxy controllers to extend it: `SmrController` (text), `TtsController` (speech), `NlpController`, `FedlController`. Eliminated ~85% duplicated boilerplate (860→507 lines, 41% reduction). Each controller now only defines its `config` and route handlers. New test file `base-proxy-controller.test.ts` with 66 TDD tests covering: BaseProxyController contract (existence, exports, proxyRequest behavior, error handling, headers-sent guard), inheritance verification (instanceof, prototype chain, no own proxyRequest), config value correctness (all 4 controllers), source-level duplication elimination (no createProxyMiddleware/fixRequestBody imports, no inline proxy), decorator preservation (PATH_METADATA), existing functionality preservation (all route handler methods). 751 tests passing across 33 files (10 pre-existing failures in transcriptionStream unrelated). | Complete |
| 11a | 2026-02-22 | Phase 5 anti-pattern audit and edge case hardening. **Anti-pattern audit** against 5 testing anti-patterns: (1) verified tests use real `http-proxy-middleware` and real `Reflect.getMetadata` — no mock-only verification; (2) no test pollution — no test-only methods in production code; (3) selective mocking — only `req`/`res` boundary objects mocked; (4) complete error response shape — ISO 8601 timestamp, requestId correlation, serviceName inclusion; (5) TDD-first. **Bug found and fixed**: stale `Logger` and `Delete` imports in `smr.controller.ts` (inherited from base, no longer needed). **Edge cases added** (89 new tests): lazy proxy singleton (same instance on repeated access, independent instances per controller), request ID uniqueness (5 consecutive calls produce 5 unique IDs, base-36 format), error response completeness (ISO timestamp validation, serviceName in error message, requestId matches x-request-id header), logger subclass name (4 controllers use own class name not BaseProxyController), env var fallback chain order (SMR 3-level, NLP 3-level, TTS 2-level, FedL 2-level), pathRewrite runtime regex behavior (8 input/output pairs across all 4 services + SMR empty-string edge case), guard metadata preservation (class-level ApiKeyGuard on TTS/NLP/FedL, method-level on SMR, healthCheck public), HTTP method metadata (PUT/POST/GET via `RequestMethod` enum), non-proxy controller exclusion (18 controllers verified NOT extending BaseProxyController), stale import detection (no Logger/http-proxy-middleware in child controllers), Swagger metadata (`@ApiTags` + `@ApiBearerAuth` on all 4), default timeout behavior (60000ms default, SMR 120000ms override). **Files modified**: `smr.controller.ts` (removed stale imports), `base-proxy-controller.test.ts` (66→155 tests). 892 tests passing across 33 files (10 pre-existing failures in transcriptionStream unrelated). | Complete |
| 12 | 2026-02-22 | Phase 6: Updated SDK v2 Constants (TDD). Updated all endpoint paths in `packages/agentic-sdk-v2/src/core/constants.ts` to match new route convention. **10 constant groups changed**: `PERSONALIZATION_ENDPOINTS` (`/users/me` → `/user/me`), `MODEL_ENDPOINTS` + `AI_MODEL_ENDPOINTS` (`/api/v1/ai-models` → `/audio/ai-models`), `STT_ENDPOINTS` (`/api/v1/transcription-jobs` → `/audio/transcription-jobs`), `PIPELINE_ENDPOINTS` (`/api/v1/pipelines` → `/audio/pipelines`), `GLOBAL_SETTINGS_ENDPOINTS` (`/global-settings` → `/admin/settings`), `USER_SETTINGS_ENDPOINTS` (`/user-settings` → `/user/me/settings`), `API_KEY_ENDPOINTS` (`/api-keys` → `/admin/api-keys`), `ROLE_ENDPOINTS` (`/rbac/roles` → `/admin/rbac/roles`), `TENANT_ENDPOINTS` (`/tenants/configs` → `/admin/tenants/configs`). **Removed**: deprecated `DNA_ENDPOINTS` (replaced by `DNA_STYLE_ENDPOINTS`), cleaned re-exports from `core.ts` and `core/index.ts`. **Tests**: 88 new TDD tests in `constants.task210.test.ts` (route changes + regression guards + structural invariants). Updated 6 existing test files (`constants.test.ts`, `constants.task032.test.ts`, `constants.ws4.test.ts`, `constants.sttv1.test.ts`, `SSEClient.test.ts`, `FileTranscriptionService.test.ts`). 2282 SDK tests passing across 85 files (6 pre-existing failures unrelated to Phase 6). | Complete |
| 12a | 2026-02-22 | Phase 6 anti-pattern audit and edge case hardening. **Anti-pattern audit** against 5 testing anti-patterns: (1) no mock behavior tested — all tests verify real constant values directly; (2) no test pollution — no production code modified for testing; (3) no blind mocking — zero mocks used; (4) complete verification — all dynamic endpoints tested with multiple input types; (5) TDD-first confirmed. **Edge cases added** (44 new tests): URI encoding on all 10 changed endpoint groups (special chars `id/with?special#chars&more=true` verified encoded, not passed raw; ROLE_ENDPOINTS double-param encoding verified with occurrence count), UUID-format IDs on all changed groups (6 test cases), empty string parameters (no-throw + valid path structure on 8 groups), no double slashes (23 static + 35 dynamic endpoints checked), key count completeness (10 structural drift guards — exact key counts for all changed groups with `arrayContaining` for STT and AI_MODEL), stale old-path source sweep (10 tests reading `constants.ts` source file, filtering out comments, verifying no code lines contain old paths: `/api/v1/ai-models`, `/api/v1/transcription-jobs`, `/api/v1/pipelines`, `/users/me/preferences`, `/global-settings`, `/user-settings`, bare `/api-keys`, bare `/rbac/roles`, bare `/tenants/configs`, `DNA_ENDPOINTS` export), re-export completeness (all 25 endpoint groups verified present in module, `DNA_ENDPOINTS` absence confirmed), backend route alignment (audio/admin/user-me prefix verification, WS_STREAM bypass check, USER_ROLES non-admin check). 132 Phase 6 tests (up from 88), 849 core tests passing across 24 files. | Complete |
|| 13 | 2026-02-21 | Phase 7: Standardized all environment files to 886x port range (TDD). **Port assignments**: API=8868, STT=8861, SMR=8862, TTS=8863, NLP=8864, FedL=8865. **7 env files updated**: `.env`, `.env.dev`, `.env.production`, `.env.test`, `.env.example`, `apps/api/.env.example`, `apps/api/.env.production`. **Deprecated env vars removed from proxy controllers**: `SMR_SERVICE_URL_HTTP`, `NLP_SERVICE_URL_HTTP`, `FEDL_SERVICE_URL_HTTP` consolidated to `SMR_URL`/`NLP_URL`/`FEDL_URL`. **IAppConfig expanded**: added `SMR_PORT`, `SMR_URL`, `NLP_PORT`, `NLP_URL`, `FEDL_PORT`, `FEDL_URL`. **ConfigService updated**: 6 new env vars with 886x defaults; existing defaults updated (PORT 5002->8868, STT_URL 8002->8861, TTS_PORT 5004->8863, TTS_URL 8003->8863). **4 proxy controllers**: default URLs changed to 886x, deprecated `*_SERVICE_URL_HTTP` fallbacks removed. **ServiceHealthMonitoring**: TTS 5004->8863, SMR 5006->8862. **5 stale refs fixed**: tts.gateway.ts (ws 5004->8863), nlp.gateway.ts (ws 5005->8864, removed NLP_SERVICE_URL/NLP_WS_URL), voice-embedding.controller.ts (8002->8861), 2 test mock hosts (5002->8868). **Bug fix**: nlp.controller.ts import `@/guards` -> relative path. **Tests updated**: config.service.test.ts defaults, base-proxy-controller.test.ts fallback chains. **TDD**: 228 new tests. 1482 passing across 35 files. No regressions. | Complete |
|| 13a | 2026-02-22 | Phase 7 anti-pattern audit and edge case hardening. **Anti-pattern audit** against 5 testing anti-patterns: (1) AP#1 fix — added behavioral tests that instantiate real `SmrController`, `TtsController`, `NlpController`, `FedlController` classes and verify `config.serviceUrl` at runtime (8 tests, zero mocks); (2) AP#2 — no test pollution confirmed; (3) AP#3 — zero mocks in entire file confirmed; (4) AP#4 fix — converted vacuous `if (value !== null)` guards to hard existence assertions for critical env vars (19 tests); (5) AP#5 — TDD-first confirmed. **Edge cases added** (186 new tests): port uniqueness (15 pairwise collision checks + set-size assertion), port range validation (6 ports × valid-range + 886x-range + 7 infra-collision checks = 84 tests), URL format validation (3 env files × 4-5 vars × protocol + parseable = 34 tests), gateway WebSocket defaults (tts.gateway ws://localhost:8863, nlp.gateway ws://localhost:8864, deprecated NLP_SERVICE_URL/NLP_WS_URL absence, env var derivation = 8 tests), voice-embedding STT_URL default (port 8861, no 8002, env var ref = 3 tests), cross-file consistency (ConfigService ↔ 4 proxy controllers + voice-embedding = 5 tests), SUMMARY_AGENT_PORT=SMR_PORT (3 env files × 2 assertions = 6 tests), .env.production service hostnames (api/tts/smr/nlp = 4 tests), complete 886x port inventory (count + range + uniqueness + .env.dev presence = 4 tests), deprecated env var sweep (4 source files × 5 deprecated vars = 20 tests), ConfigService type correctness (3 port defaults as quoted strings + 3 URL defaults as quoted URLs = 6 tests), IAppConfig required properties (6 new props verified non-optional = 6 tests). **Tests**: 414 Phase 7 tests (up from 228), 1664 total passing across 34 files. No regressions. | Complete |
| 14 | 2026-02-22 | Phase 8: Updated all documentation files to reflect TASK-210 changes. **6 files updated**: `apps/api/README.md` (port 5002→8868, STT v1→STT, new route convention table, architecture diagram with 886x ports, env vars updated, project structure with `shared/` and route annotations, Swagger URL to `/api/v1/docs`), `apps/api/docs/01-implementation-status.md` (version 1.0.0, added TASK-210 section, replaced STT v1 with STT/admin/user controllers, updated completion to 80.9%), `apps/api/docs/03-usage-guide.md` (version 2.0, all endpoint examples updated to `/api/v1/...`, STT v1 section replaced with STT audio endpoints, TTS→speech, SMR→text, SDK v2 baseUrl updated), `apps/api/docs/04-deployment-guide.md` (version 2.0, all port refs 5002→8868, microservice URLs updated to 886x, K8s/Docker/nginx configs updated, health probe paths to `/api/v1/health/*`, STT gateway→STT), `apps/api/docs/05-api-reference.md` (version 2.0, added BaseProxyController docs, replaced STT v1 with STT controller table, added admin/user controller tables, proxy configs updated to 886x), `.cursor/rules/03-app-api.mdc` (updated overview with port/prefix, module list without stt, added shared/ and route convention section, env vars updated to 886x). | Complete |
