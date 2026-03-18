# API Gateway Codemap

**Last Updated:** 2026-03-14  
**Language:** TypeScript + NestJS 11  
**Port:** 3000 (development)  
**Entry Point:** [src/main.ts](../../../apps/api/src/main.ts)

---

## 📋 Purpose

Central gateway for the HOPE platform. Orchestrates authentication, tenant isolation, microservice routing, WebSocket communication, real-time events, and enterprise observability. Acts as the single entry point for all client applications.

---

## 🗂️ Directory Structure

```
apps/api/src/
├── app.module.ts              # Root module, bootstraps all features
├── main.ts                    # Application entry point, Bootstrap
├── __tests__/                 # Unit and integration tests
│
├── modules/                   # Feature modules (one per domain)
│   ├── auth/                  # Authentication • JWT • API keys • OAuth
│   ├── rbac/                  # Role-based access control (CASL)
│   ├── tenant/                # Multi-tenancy • isolation • context
│   ├── user/                  # User management • profiles • sessions
│   ├── consultation/          # Consultation sessions • state management
│   ├── stt-v2/                # Speech-to-text integration • proxy
│   ├── api-key/               # API key management • rotation
│   ├── audit-log/             # Audit trail • compliance logging
│   ├── monitoring/            # Health checks • system status
│   ├── health/                # Liveness/Readiness probes
│   ├── storage/               # File storage • MinIO integration
│   ├── prompt-management/     # LLM prompt templates
│   └── streaming/             # Real-time data streaming
│
├── guards/                    # Authentication/Authorization guards
│   ├── unified-auth.guard.ts  # Main auth guard (API key → JWT → CASL)
│   ├── jwt.guard.ts           # JWT token validation
│   ├── api-key.guard.ts       # API key authentication
│   └── rbac.guard.ts          # Role-based access control
│
├── interceptors/              # Request/Response processing
│   ├── context.interceptor.ts # Injects tenant/user context
│   ├── exception.interceptor.ts # Global exception handling
│   └── maintenance.interceptor.ts # Maintenance mode redirect
│
├── filters/                   # Exception filters
│   ├── http-exception.filter.ts
│   ├── validation.filter.ts
│   └── ws-exception.filter.ts # WebSocket error handling
│
├── middlewares/               # Express middlewares
│   ├── cors.middleware.ts     # CORS configuration
│   ├── compression.middleware.ts
│   └── security.middleware.ts # Security headers
│
├── decorators/                # Custom decorators
│   ├── tenant.decorator.ts    # @Tenant() extractor
│   ├── current-user.decorator.ts # @CurrentUser() extractor
│   └── public.decorator.ts    # @Public() to skip auth
│
├── services/                  # Cross-cutting services
│   ├── microservice.service.ts # Service discovery • HTTP calls
│   ├── websocket.service.ts   # WebSocket event management
│   └── cache.service.ts       # Redis caching
│
├── shared/                    # Shared utilities
│   ├── constants/             # Application constants
│   ├── config/                # Configuration loaders
│   ├── types/                 # TypeScript interfaces
│   └── utils/                 # Helper functions
│
├── assets/                    # Static assets
└── decorators/                # Custom NestJS decorators
```

---

## 🔌 Key Modules

| Module | Purpose | Key Files |
|--------|---------|-----------|
| **auth** | JWT • API keys • OAuth • local strategy | controller, service, strategies |
| **rbac** | CASL-based access control • policies | casl-factory, middleware |
| **tenant** | Multi-tenancy • context injection • isolation | service, guard, decorator |
| **user** | User CRUD • session mgmt • profile | controller, service |
| **consultation** | Consultation sessions • real-time state | controller, service, gateway |
| **stt-v2** | STT service proxy • audio chunking | controller, service |
| **api-key** | API credential generation • rotation | service, entity |
| **monitoring** | Health checks • dependency status | controller, health indicators |
| **storage** | MinIO integration • file upload/download | service, controller |

---

## 🔄 Request Flow

```
┌──────────────────────────────────────────────────────────┐
│              Incoming Request                             │
└────────────────┬─────────────────────────────────────────┘
                 ▼
     ┌───────────────────────────────┐
     │  Middleware Pipeline          │
     │  • CORS                        │
     │  • compression                 │
     │  • security headers            │
     │  • rate limiting               │
     └───────────────┬─────────────────┘
                     ▼
     ┌───────────────────────────────┐
     │  UnifiedAuthGuard              │
     │  1. Try API Key                │
     │  2. Try JWT Token              │
     │  3. Apply CASL policy          │
     │  → inject req.user, req.tenant │
     └───────────────┬─────────────────┘
                     │ ❌ Fail? → 401/403
                     ▼
     ┌───────────────────────────────┐
     │  ContextInterceptor            │
     │  Injects TenantContext,        │
     │  CurrentUserContext            │
     └───────────────┬─────────────────┘
                     ▼
     ┌───────────────────────────────┐
     │  Controller Handler            │
     │  (auth/user/consultation/...)  │
     └───────────────┬─────────────────┘
                     ▼
     ┌───────────────────────────────┐
     │  Service Layer                 │
     │  • Business logic              │
     │  • Database calls (Prisma)     │
     │  • External service calls      │
     └───────────────┬─────────────────┘
                     ▼
     ┌───────────────────────────────┐
     │  Response                      │
     │  (JSON + headers)              │
     └──────────────────────────────────┘
```

---

## 🌐 API Endpoints (by Module)

### Authentication
- `POST /auth/login` — Local login
- `POST /auth/refresh` — Refresh JWT
- `GET /auth/me` — Current user context
- `POST /auth/oauth/:provider` — OAuth flow

### User Management
- `GET /users/:id` — Get user
- `PUT /users/:id` — Update profile
- `GET /users/:id/sessions` — Active sessions

### RBAC
- `GET /rbac/permissions` — User permissions
- `GET /rbac/roles` — Available roles

### Consultation
- `POST /consultations` — Create session
- `GET /consultations/:id` — Get session
- `POST /consultations/:id/messages` — Add message
- `WS /consultations/:id` — WebSocket stream

### STT Integration
- `POST /stt-v2/transcribe` — Start transcription
- `GET /stt-v2/status/:jobId` — Job status

### Monitoring
- `GET /health` — Liveness probe
- `GET /health/ready` — Readiness probe
- `GET /metrics` — Prometheus metrics

---

## 🔗 External Dependencies

### NestJS Ecosystem
- `@nestjs/core` — Framework core
- `@nestjs/jwt` — JWT authentication
- `@nestjs/passport` — Passport.js integration
- `@nestjs/websockets` — WebSocket server
- `@nestjs/bull` — Job queue integration
- `@nestjs/config` — Configuration management
- `@nestjs/swagger` — API documentation

### Third-Party Libraries
- `passport` — Authentication strategies
- `bullmq` — Job queue
- `axios` — HTTP client
- `ioredis` — Redis client
- `jsonwebtoken` — JWT encoding/decoding
- `bcrypt` — Password hashing
- `helmet` — Security headers
- `express-rate-limit` — Rate limiting
- `@casl/ability` — Authorization

### Internal Packages
- `@arcaai/database` — Prisma ORM
- `@arcaai/domains` — DDD entities
- `@arcaai/applications` — Shared business logic
- `@arcaai/logger` — Structured logging
- `@arcaai/exceptions` — Custom exceptions

---

## 🔐 Security Architecture

```
Request → UnifiedAuthGuard
         ├─ API Key? → Extract key → Lookup tenant/user
         ├─ JWT? → Verify signature → Extract claims
         └─ Neither? → 401 Unauthorized
              ↓
         Verify tenant context (isolation)
              ↓
         Apply CASL policy
         (Can user perform action on resource?)
              ↓
         200 OK → Execute handler
```

---

## 💾 Database Integration

- **ORM**: Prisma 7
- **Database**: PostgreSQL 18
- **Connection Pool**: Via Prisma (configurable)
- **Access Pattern**: All DB access via `@arcaai/database`

### Key Entities (schema)
- `User` — User profiles, auth
- `Tenant` — Tenants, isolation boundary
- `ConsultationSession` — Conversation metadata
- `Message` — Chat messages
- `AuditLog` — Compliance/debug trail
- `ApiKey` — API credentials

---

## ⚙️ Configuration

**Environment Variables** (see [knowledge/SETUP.md](../../../knowledge/SETUP.md)):

```bash
# Server
NODE_ENV=development
PORT=3000

# Database
DATABASE_URL=postgresql://...

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# JWT
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=1h

# Microservices
STT_V2_URL=http://localhost:8861
SMR_URL=http://localhost:8862
NLP_URL=http://localhost:8864

# External Services
SENTRY_DSN=https://...
```

---

## 📊 Observability

### Logging
- Entry point: `@arcaai/logger` (Winston)
- All requests logged with tenant/user context
- Structured JSON logs with timestamps

### Monitoring
- Prometheus metrics endpoint: `/metrics`
- Health probes: `/health` (liveness), `/health/ready` (readiness)

### Tracing
- Sentry integration for error tracking
- Request IDs propagated through service calls

---

## 🧪 Testing

**Unit Tests**: `pnpm test`  
**Test Coverage**: `pnpm test:cov`  
**E2E Tests**: `pnpm test:e2e`

Location: [src/__tests__/](../../../apps/api/src/__tests__/)

---

## 🔗 Related Codemaps

- [STT V2](./stt-v2.md) — Speech-to-text service
- [SMR V2](./smr-v2.md) — Medical summarization
- [NLP](./nlp.md) — NLP classification/NER
- [Database Package](../packages/database.md) — Prisma schema
- [Applications Package](../packages/applications.md) — Shared business logic
- [Domains Package](../packages/domains.md) — DDD entities

---

**Status**: ✅ Current | API Gateway active in development
