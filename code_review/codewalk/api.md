# API Gateway - API Documentation

## Service Overview

**Path**: `apps/api/src/`
**Entry Point**: `apps/api/src/main.ts` → `bootstrap()` → `NestFactory.create(AppModule)`
**Port**: 8868 (default)
**Framework**: NestJS (Node.js/TypeScript)

### Core Responsibilities
- **Authentication & Authorization**: JWT, API keys, service accounts, OIDC
- **Rate Limiting**: Tiered throttling (default/strict/heavy/relaxed)
- **Request Routing**: Proxies to downstream services (STT, TTS, NLP, Text, Guardrail)
- **Agent Resolution**: Resolves AI agents (routing policies) for downstream services
- **Tenant Management**: Multi-tenant isolation, consent/ABAC, origin binding
- **Usage Metering**: Character/audio-second/token billing via ledger
- **WebSocket Gateways**: STT streaming, TTS streaming, Workflow sockets
- **Service Registration**: Self-registration + downstream service registration
- **Health/Observability**: Health probes, Prometheus metrics, OpenTelemetry

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        API Gateway (NestJS)                     │
├─────────────────────────────────────────────────────────────────┤
│  Guards (execution order):                                      │
│  1. TieredThrottlerGuard  → Rate limiting                      │
│  2. ClsGuard               → CLS context                       │
│  3. UnifiedAuthGuard       → JWT / API Key / Service Account   │
│  4. PatientConsentGuard    → Consent/ABAC                      │
│  5. TenantOwnedResourceSseGuard → SSE tenant isolation         │
│  6. OriginTenantBindingGuard → Browser origin → tenant         │
│  7. RequiresIfMatchGuard   → Optimistic concurrency            │
├─────────────────────────────────────────────────────────────────┤
│  Feature Modules (60+):                                         │
│  • ai-inference        → /admin/ai-services (read-only proxy)  │
│  • ai-provider-connection → /admin/providers (BYO credentials) │
│  • ai-routing-policy   → /admin/routing-policies               │
│  • agent / agent-admin → /agents + /admin/agents               │
│  • billing             → /admin/billing + /billing/me          │
│  • consent             → /admin/consent-grants                 │
│  • guardrail-availability → /admin/guardrail/availability     │
│  • health              → /health, /health/live/ready/startup   │
│  • internal            → /internal/* (service-token gated)     │
│  • monitoring          → /admin/monitoring                     │
│  • nlp-task-instructions → /admin/nlp-task-instructions       │
│  • pipeline            → /admin/pipelines                      │
│  • prompt-management   → /admin/prompt-templates               │
│  • rbac                → /admin/rbac                           │
│  • service-account     → /admin/service-accounts + /auth/service-token │
│  • speech              → /speech/synthesize + /speech/voices   │
│  • streaming           → /streaming + STT WebSocket            │
│  • stt-compat          → v1 STT compat shims                   │
│  • text-compat         → v1 Text summary compat                │
│  • tenant              → /tenant/me                            │
│  • workflow            → /workflows + /admin/workflow-*        │
│  • voice-profile       → /voice-profile                        │
│  ... and 40+ more                                               │
├─────────────────────────────────────────────────────────────────┤
│  Downstream Services (proxied):                                 │
│  • STT (8861)       → Streaming + Batch transcription          │
│  • TTS (8862)       → Speech synthesis + WS duplex             │
│  • NLP (8863)       → Classification, extraction, guardrail    │
│  • Text (8864)      → LLM generation, summarization            │
│  • Guardrail        → Policy (delegates inference to NLP)      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Implementation Files

| File | Purpose |
|------|---------|
| `main.ts` | Bootstrap, audits, middleware, CORS, session, guards, interceptors |
| `app.module.ts` | Root module: 60+ feature modules, global guards/interceptors/filters |
| `config/env.schema.ts` | Zod-validated environment schema |
| `cors.config.ts` | CORS with `TenantAllowedOrigin` registry |
| `guards/unified-auth.guard.ts` | JWT + API Key + Service Account authentication |
| `guards/patient-consent.guard.ts` | Consent/ABAC enforcement |
| `guards/origin-tenant-binding.guard.ts` | Browser origin → tenant mapping |
| `interceptors/exception.interceptor.ts` | Global error envelope |
| `interceptors/context.interceptor.ts` | Request context (tenant, user, request_id) |
| `interceptors/metrics.interceptor.ts` | Prometheus metrics |
| `filters/downstream-error.ts` | Downstream error classification |
| `modules/health/health.controller.ts` | Health probes (live/ready/startup) |
| `modules/internal/*.controller.ts` | Service-token gated internal APIs |
| `modules/streaming/streaming.module.ts` | STT streaming + transcription jobs |
| `modules/speech/speech.module.ts` | TTS synthesis + WS duplex |
| `modules/speech/speech-proxy.controller.ts` | TTS proxy with agent resolution |
| `modules/streaming/text-proxy.controller.ts` | Text LLM generation proxy |
| `modules/streaming/stt-ws.gateway.ts` | STT WebSocket gateway |
| `modules/speech/tts-ws.gateway.ts` | TTS WebSocket gateway |
| `modules/ai-routing-policy/...` | Agent routing policies |
| `modules/ai-provider-connection/...` | BYO credentials |
| `modules/agent/agent.controller.ts` | Business plane agent invocation |

---

## Public API Endpoints (Sample - 200+ routes)

### Authentication
| Method | Path | Handler | Auth |
|--------|------|---------|------|
| POST | `/api/v1/auth/login` | `AuthController.login()` | Public |
| POST | `/api/v1/auth/refresh` | `AuthController.refresh()` | Public |
| POST | `/api/v1/auth/logout` | `AuthController.logout()` | JWT |
| POST | `/api/v1/auth/service-token` | `ServiceAccountTokenController.issue()` | Public |

### Health (Public, Skip Throttle)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/v1/health/live` | `ApiHealthController.liveness()` | K8s liveness |
| GET | `/api/v1/health/ready` | `ApiHealthController.readiness()` | K8s readiness |
| GET | `/api/v1/health/startup` | `ApiHealthController.startup()` | K8s startup |
| GET | `/api/v1/health` | `ApiHealthController.check()` | Detailed health |

### Speech/TTS (Requires `tts:speech:write`)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/v1/speech/synthesize` | `SpeechProxyController.synthesize()` | Batch/SSE/raw audio |
| GET | `/api/v1/speech/voices` | `SpeechProxyController.voices()` | Voice catalog |
| WS | `/api/v1/speech/stream` | `TtsWsGateway` | Duplex streaming |

### STT/Transcription (Requires `stt:transcribe:write`)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/v1/streaming/transcriptions` | `TranscriptionJobController.create()` | Create batch job |
| GET | `/api/v1/streaming/transcriptions/:id` | `TranscriptionJobController.get()` | Job status |
| WS | `/api/v1/streaming/ws` | `SttWsGateway` | Real-time streaming |

### Agents (Business Plane)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/v1/agents` | `AgentController.list()` | List agents |
| POST | `/api/v1/agents/:slug/invoke` | `AgentController.invoke()` | Invoke agent |
| POST | `/api/v1/agents/:slug/speech` | `AgentController.speech()` | Agent TTS |
| POST | `/api/v1/agents/:slug/transcriptions` | `AgentController.transcribe()` | Agent STT |

### Admin APIs (Super-admin / Admin scopes)
| Method | Path | Module | Description |
|--------|------|--------|-------------|
| GET/POST | `/api/v1/admin/ai-services` | `AiServiceAdminModule` | Read-only AI service proxy |
| CRUD | `/api/v1/admin/providers` | `AiProviderConnectionModule` | BYO credentials |
| CRUD | `/api/v1/admin/routing-policies` | `AiRoutingPolicyModule` | Agent routing |
| CRUD | `/api/v1/admin/agents` | `AgentAdminModule` | Agent authoring |
| CRUD | `/api/v1/admin/workflow-definitions` | `WorkflowDefinitionModule` | Workflow CRUD |
| GET | `/api/v1/admin/health/services` | `AdminHealthServicesController` | Downstream health |
| CRUD | `/api/v1/admin/service-accounts` | `ServiceAccountModule` | Machine credentials |

### Internal APIs (Service Token: `X-Service-Token`)

#### STT Internal (`internal:stt:worker` scope)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/api/v1/internal/stt/transcripts` | `SttInternalController.createTranscript()` | Create transcript |
| PATCH | `/api/v1/internal/stt/jobs/:id/start` | `SttInternalController.startJob()` | Claim job |
| PATCH | `/api/v1/internal/stt/jobs/:id/complete` | `SttInternalController.completeJob()` | Complete job |
| PATCH | `/api/v1/internal/stt/jobs/:id/fail` | `SttInternalController.failJob()` | Fail job |
| GET | `/api/v1/internal/stt/provider-overrides` | `SttInternalController.getProviderOverrides()` | BYO creds pull |
| GET | `/api/v1/internal/stt/model-registry-credential` | `SttInternalController.getModelRegistryCredential()` | HF/S3 creds |

#### Agent Internal (Service Token Guard)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/v1/internal/agents/resolve` | `AgentInternalController.resolve()` | Resolve agent for harness |

#### Effective Config (Service Token)
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/api/v1/internal/models/resolvable` | `EffectiveConfigController` | Model resolvability |

---

## Detailed API Documentation

### 1. Speech Synthesis Proxy - POST /api/v1/speech/synthesize

**File**: `modules/speech/speech-proxy.controller.ts:264`
**Handler**: `SpeechProxyController.synthesize(body, res)`

**Implementation Chain**:
```
synthesize() [speech-proxy.controller.ts:264]
  → applyAgentSpec() [speech-proxy.controller.ts:127]
    → resolveTtsRequestConfig() [tts-tenant-config.ts]
      → ttsAgentResolver.resolve() [TtsAgentResolverService]
        → AgentAssignment cascade (tenant → department → SYSTEM)
        → ResolvedTtsSpec (engine chain, models, voices, connections)
    → Build provider_overrides from AiProviderConnection rows
      → Decrypt credentials via SecretsService/Vault
  → Pre-flight entitlements check: monthlyTtsCharacters [IEntitlementsService]
  → withRetry() [connect-phase only, max 2 retries]
  → HTTP POST to TTS_URL/api/v1/audio/speech [HttpService]
    → Headers: X-Service-Token (INTERNAL_ACCESS_TOKEN)
    → Stream response (responseType: 'stream')
  → Stream proxy: pipe upstream → response
    → Accumulate proxiedBytes, firstByteAtMs (TTFA)
  → On teardown: emitUsage()
    → resolveAudioSeconds() [headers + proxiedBytes]
    → classifyTtsProvider() [provider + connectionId → deployment/costBasis]
    → appendComputeAndByteUnits() [engineMs, totalMs, device, byteSource]
    → usageLedger.recordUsage() [IUsageLedgerService]
```

**Data Integration**:
- **PostgreSQL**: AgentAssignment, AiProviderConnection, Entitlements
- **Vault/SecretsService**: Decrypt BYO credentials
- **TTS Service (8862)**: HTTP proxy with streaming
- **Usage Ledger**: BullMQ queue → rollup → billing
- **CLS**: Tenant context for scoped queries

**Response Modes** (via `stream_format`):
- **Batch** (default): Full audio response, headers include `X-Tts-Audio-Seconds`, `X-Tts-Synthesis-Ms`
- **SSE** (`stream_format=sse`): `speech.audio.delta` (base64) + `speech.audio.done` + `speech.usage`
- **Raw Audio** (`stream_format=audio`): Chunked PCM/WAV/MP3 bytes

---

### 2. TTS Voice Catalog - GET /api/v1/speech/voices

**File**: `modules/speech/speech-proxy.controller.ts:461`
**Handler**: `SpeechProxyController.voices()`

**Implementation Chain**:
```
voices() [speech-proxy.controller.ts:461]
  → withRetry() [GET TTS_URL/api/v1/voices]
  → Return TTS voice catalog
```

---

### 3. STT Transcription Job - POST /api/v1/streaming/transcriptions

**File**: `modules/streaming/transcription-job.controller.ts` (not read but inferred)
**Handler**: `TranscriptionJobController.create()`

**Implementation Chain**:
```
create() [transcription-job.controller.ts]
  → Validate tenant entitlements (monthlySttMinutes) [IEntitlementsService]
  → TranscriptionJobService.create() [applications]
    → Create TranscriptionJob row (QUEUED)
    → Enqueue Dramatiq message (batch worker)
  → Return job ID
```

---

### 4. STT WebSocket Gateway - WS /api/v1/streaming/ws

**File**: `modules/streaming/stt-ws.gateway.ts`
**Handler**: `SttWsGateway` (WebSocket gateway)

**Protocol**:
```
Client → WS handshake (Origin checked via OriginRegistry)
       → STT worker creates session via /internal/stt/sessions
       → Client ↔ Gateway: audio frames (binary) / control (JSON)
       → Gateway → STT: XADD Redis streams (audio/control)
       → STT → Gateway: results via Redis streams
       → Gateway → Client: transcripts (JSON)
```

**Implementation Chain**:
```
SttWsGateway.handleConnection() [stt-ws.gateway.ts]
  → isOriginAllowed() [OriginRegistryService]
  → Validate stream ticket (single-use, signed)
  → Call STT /internal/streaming/sessions [HttpService]
  → Establish Redis Streams consumers/producers
  → Handle audio frames ↔ Redis Streams
  → Handle control messages ↔ Redis Streams
```

---

### 5. Agent Resolution for Harness - GET /api/v1/internal/agents/resolve

**File**: `modules/internal/agent-internal.controller.ts:49`
**Handler**: `AgentInternalController.resolve()`

**Implementation Chain**:
```
resolve() [agent-internal.controller.ts:49]
  → Validate X-Tenant-Id (header or query) [required]
  → Validate task or agentSlug [required]
  → Cls.run(pinned tenant) [ClsService]
  → AgentResolverService.resolve() [applications]
    → AgentAssignment cascade (tenant → department → SYSTEM)
    → ResolvedAgent (primary + fallback chain)
  → If TEXT_GENERATION:
    → Entitlements check: monthlyLlmTokens [IEntitlementsService]
    → TextAgentResolverService.resolveFromAgent() [text agent spec]
    → Return { ...resolved, textPrimary, textFallback }
```

---

### 6. STT Internal - Job Lifecycle

**File**: `modules/internal/stt-internal.controller.ts`

**Endpoints**:
| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| POST | `/internal/stt/transcripts` | `createTranscript()` | Create transcript context |
| PATCH | `/internal/stt/jobs/:id/start` | `startJob()` | Claim job (idempotent) |
| PATCH | `/internal/stt/jobs/:id/progress` | `updateProgress()` | Update progress |
| PATCH | `/internal/stt/jobs/:id/complete` | `completeJob()` | Mark completed |
| PATCH | `/internal/stt/jobs/:id/fail` | `failJob()` | Mark failed |
| GET | `/internal/stt/jobs/:id/status` | `getJobStatus()` | Lightweight poll |

**Implementation Chain** (startJob example):
```
startJob() [stt-internal.controller.ts:239]
  → ensureInternalApiKey() [validates API key auth]
  → runTenantPinned() [CLS pin to X-Internal-Tenant-Id]
    → assertPlatformInternalCredential() [X-Internal-Service-Key constant-time]
  → SttInternalService.startJob() [applications]
    → Claim job (QUEUED→PROCESSING, reclaim logic)
```

---

### 7. Health Probes

**File**: `modules/health/health.controller.ts`

| Endpoint | Handler | Logic |
|----------|---------|-------|
| `/health/live` | `liveness()` | Always 200 healthy |
| `/health/startup` | `startup()` | Checks `shutdownService.isReady` |
| `/health/ready` | `readiness()` | Checks `shutdownService.isReady` |
| `/health` | `check()` | Detailed: status, version, uptime, checks{} |

**Readiness Logic**:
- `shutdownService.isReady` = true after bootstrap completes
- `shutdownService.isShuttingDown` = true during drain
- Probes skip throttling (`@SkipThrottle()`) to prevent 429 on kubelet

---

### 8. Agent Routing Policy Resolution

**Module**: `modules/ai-routing-policy/`
**Service**: `AiRoutingPolicyService` (from `@arcaai/applications`)

**Resolution Flow**:
```
1. Tenant → AgentAssignment (task → agentSlug)
2. Agent → WorkflowDefinition (published version)
3. WorkflowDefinition → AiRoutingPolicy (ordered candidate chain)
4. Each candidate: engine, model, connection, funding, fallback governance
5. Provider credentials resolved via AiProviderConnectionService
6. Result: ResolvedAsrSpec / ResolvedTtsSpec / ResolvedTextGenerationAgent
```

---

## Guard/Interceptor Chain

```
Request → TieredThrottlerGuard (rate limit)
       → ClsGuard (CLS context)
       → UnifiedAuthGuard (JWT/API Key/Service Account)
       → PatientConsentGuard (consent/ABAC)
       → TenantOwnedResourceSseGuard (SSE isolation)
       → OriginTenantBindingGuard (origin → tenant)
       → RequiresIfMatchGuard (optimistic concurrency)
       → Controller handler
       → Interceptors:
         - MetricsInterceptor (Prometheus)
         - RateLimitHeadersInterceptor (rate limit headers)
         - ContextInterceptor (request context)
         - ExceptionInterceptor (error envelope)
         - MaintenanceInterceptor (maintenance mode)
         - ImpersonationAuditInterceptor (audit)
```

---

## Key Services (from `@arcaai/applications`)

| Service | Purpose |
|---------|---------|
| `AgentResolverService` | Resolve agent for task (assignment cascade) |
| `AsrAgentResolverService` | Resolve STT agent + spec + credentials |
| `TtsAgentResolverService` | Resolve TTS agent + spec + credentials |
| `TextAgentResolverService` | Resolve Text agent + spec + credentials |
| `AiProviderConnectionService` | BYO credentials (decrypt from Vault) |
| `EntitlementsService` | Quota checks (monthlyTtsCharacters, etc.) |
| `UsageLedgerService` | Usage emission (BullMQ → rollup) |
| `StreamingSessionService` | STT session lifecycle + usage |
| `TranscriptionJobService` | Batch job CRUD + state machine |
| `EffectiveConfigService` | Control plane config pull |
| `SecretsService` | Vault secret access (warmed cache) |
| `OriginRegistryService` | Browser origin → tenant mapping |

---

## Configuration (Control Plane)

| Key | Description |
|-----|-------------|
| `origin.enforcementEnabled` | Enable origin→tenant binding |
| `TTS_URL` | TTS service URL |
| `STT_URL` | STT service URL |
| `NLP_URL` | NLP service URL |
| `TEXT_URL` | Text service URL |
| `INTERNAL_ACCESS_TOKEN` | Shared service token |
| `SESSION_SECRET_KEY` | Session encryption |
| `JWT_SECRET_KEY` | JWT signing |
| `WORKFLOW_EXPOSURE_ENABLED` | Enable public workflow plane |
| `ENABLE_PRISMA_STUDIO` | Enable Prisma Studio |

---

## Sequence Diagrams

See generated sequence diagrams in `review/codewalk/diagrams/` (open `.html` files in browser):
- `api-speech-synthesize.html` — TTS synthesis proxy with agent resolution
- `api-stt-streaming.html` — STT WebSocket streaming flow
- `api-agent-resolve.html` — Internal agent resolution for harness
- `api-health-probes.html` — Health/readiness/startup probes
- `api-tts-job-lifecycle.html` — STT batch job lifecycle (internal)
- `api-text-proxy.html` — Text LLM generation proxy