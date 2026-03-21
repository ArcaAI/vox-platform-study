# @arcaai/applications

Shared NestJS business logic layer for the HOPE monorepo. This package contains all application-level services, authorization, decorators, and common utilities that the API gateway (`apps/api`) imports to serve HTTP endpoints.

## Architecture

```
┌──────────────────────────────────────────────┐
│              API Gateway (apps/api)           │
│         Controllers · Middleware · Guards     │
├──────────────────────────────────────────────┤
│           @arcaai/applications               │
│   Services · Authorization · Decorators      │
├──────────────────────────────────────────────┤
│             @arcaai/domains                  │
│   Entities · Repositories · Factories        │
├──────────────────────────────────────────────┤
│            @arcaai/database                  │
│        Prisma Client · PostgreSQL            │
└──────────────────────────────────────────────┘
```

Services in this package orchestrate business operations by composing repositories from [`@arcaai/domains`](../domains/README.md) and the Prisma client from [`@arcaai/database`](../database/README.md). They are framework-independent NestJS modules that the API gateway imports at bootstrap.

## Package Info

| Field | Value |
|-------|-------|
| **Package** | `@arcaai/applications` |
| **Version** | `0.0.1` |
| **Runtime** | NestJS 11, TypeScript 5.8 |
| **Key Dependencies** | `@arcaai/domains`, `@arcaai/database`, `@arcaai/exceptions`, `@arcaai/logger`, `@casl/ability`, `@langchain/core`, BullMQ, Passport JWT |

## Directory Structure

```
packages/applications/src/
├── authorization/          # CASL policy engine, guards, decorators
├── common/                 # Shared utilities and helpers
├── decorators/             # Custom NestJS decorators
├── interfaces/             # Service interfaces and contracts
└── services/               # All business service modules
    ├── apiKey/             # API key management
    ├── audit/              # Authorization audit service
    ├── auditLog/           # Audit log CRUD
    ├── auth/               # Authentication (JWT, OIDC)
    ├── baseServices/       # Infrastructure services
    │   ├── _meta/          # Config, app settings
    │   ├── health/         # Health checks
    │   ├── integrations/   # External integrations
    │   ├── logging/        # Logging module
    │   ├── metrics/        # Prometheus metrics
    │   ├── monitoring/     # Service monitoring
    │   ├── mqtt/           # MQTT messaging
    │   ├── observability/  # OpenTelemetry tracing
    │   ├── rateLimiting/   # Rate limiting
    │   ├── redis/          # Redis cache & queue
    │   ├── serviceHealth/  # Service health monitoring
    │   ├── storage/        # S3/MinIO file storage
    │   └── unitsOfWork/    # Unit of work services
    ├── consultation/       # Consultation workflow
    ├── crypto/             # Cryptographic utilities
    ├── department/         # Department management
    ├── dna-writing-style/  # DNA writing style analysis
    ├── globalSetting/      # Global system settings
    ├── media/              # Media file management
    │   ├── media/          # Media CRUD
    │   └── userMedia/      # User-media associations
    ├── notification/       # User notifications
    ├── prompt-management/  # Prompt template management
    ├── resourceSubscription/ # Resource subscription tracking
    ├── security/           # RBAC (roles, permissions, role-permissions)
    │   ├── permission/     # Permission management
    │   ├── role/           # Role management
    │   └── rolePermission/ # Role-permission assignment
    ├── stt/                # Speech-to-Text orchestration
    │   ├── internal/       # Internal STT service
    │   ├── job/            # Transcription jobs
    │   ├── model/          # AI model management
    │   ├── pipeline/       # ASR pipeline config
    │   ├── realtime/       # Realtime transcription
    │   └── streaming/      # Streaming sessions
    ├── sysEvent/           # System event publishing
    ├── tag/                # Tagging system
    ├── tenant/             # Multi-tenant management
    ├── user/               # User, profile, groups, settings
    │   ├── user/           # User CRUD
    │   ├── userGroup/      # Group management
    │   ├── userGroupAssignment/ # User-group membership
    │   ├── userPreferences/# User preferences
    │   ├── userProfile/    # User profiles
    │   ├── userRoleAssignment/ # User-role assignment
    │   └── userSettings/   # User settings
    └── webhook/            # Webhook dispatch
```

## Service Catalog

### Domain Services

| Service | Module | Description |
|---------|--------|-------------|
| **Auth** | `auth.service.module` | JWT authentication, OIDC integration, token generation and validation |
| **User** | `user.service.module` | User CRUD, account management, service accounts |
| **UserProfile** | `userProfile.service.module` | User profile data (name, email, phone, avatar) |
| **UserSettings** | `userSettings.service.module` | Per-user key-value settings store |
| **UserPreferences** | `userPreferences.service.module` | User preference management |
| **UserGroup** | `userGroup.service.module` | Team/group management with hierarchy |
| **UserGroupAssignment** | `userGroupAssignment.service.module` | User-to-group membership |
| **UserRoleAssignment** | `userRoleAssignment.service.module` | User-to-role assignment (tenant-scoped) |
| **Tenant** | `tenant.service.module` | Multi-tenant organization management |
| **Department** | `department.service.module` | Department lookup table management |
| **Consultation** | `consultation.service.module` | Consultation CRUD, patient visit workflow |
| **Timeline** | `timeline.service.module` | Consultation timeline view |
| **Context** | `context.service.module` | Consultation context items (audio, notes, summaries) |
| **Summary** | `summary.service.module` | AI-generated summary management |
| **ChainSummary** | `chain-summary.service.module` | Multi-step summarization chains |
| **PromptResolution** | `prompt-resolution.service.module` | Runtime prompt template resolution |
| **ConsultationJob** | `consultation-job.service.module` | Background consultation processing jobs |
| **PromptManagement** | `prompt-management.service.module` | Prompt template CRUD and versioning |
| **DNA Writing Style** | `dna-writing-style.service.module` | Doctor writing style analysis and reports |
| **Media** | `media.service.module` | File metadata and lifecycle management |
| **UserMedia** | `userMedia.service.module` | User-to-media associations |
| **Tag** | `tag.service.module` | Resource tagging system |
| **Notification** | `notification.service.module` | In-app notification delivery |
| **Webhook** | `webhook.service.module` | External webhook dispatch and tracking |
| **ResourceSubscription** | `resourceSubscription.service.module` | Resource change subscriptions |
| **GlobalSetting** | `globalSetting.service.module` | System-wide configuration values |
| **Audit** | `audit/` | Authorization audit service |
| **AuditLog** | `auditLog.service.module` | Audit trail recording |
| **SysEvent** | `sysEvent.service.module` | System event publishing |
| **ApiKey** | `apikey.service.module` | API key generation and validation |

### Security Services

| Service | Module | Description |
|---------|--------|-------------|
| **Role** | `role.service.module` | Role definition and hierarchy |
| **Permission** | `permission.service.module` | Permission management |
| **RolePermission** | `rolePermission.service.module` | Role-to-permission assignment |

### STT (Speech-to-Text) Services

| Service | Module | Description |
|---------|--------|-------------|
| **STT Internal** | `sttInternal.service.module` | Internal STT service orchestration |
| **TranscriptionJob** | `transcriptionJob.service.module` | Batch transcription job management |
| **TranscriptionRealtime** | `transcriptionRealtime.service.module` | Live streaming transcription |
| **StreamingSession** | `streamingSession.service.module` | WebSocket streaming session lifecycle |
| **Pipeline** | `pipeline.service.module` | ASR pipeline configuration management |
| **AiModel** | `aiModel.service.module` | AI model registry operations |

### Infrastructure Services

| Service | Module | Description |
|---------|--------|-------------|
| **Config** | `config.module` | Environment configuration (NestJS ConfigModule) |
| **AppSettings** | `appSettings.module` | Runtime application settings |
| **HealthCheck** | `health-check.service.module` | Terminus health check endpoints |
| **ServiceHealthMonitoring** | `serviceHealthMonitoring.service.module` | Cross-service health tracking |
| **Redis** | `redis.service.module` | Redis connection and queue management |
| **RedisCache** | `redis-cache.module` | Redis caching layer |
| **S3 Storage** | `s3.service.module` | S3/MinIO object storage operations |
| **Metrics** | `metrics.service.module` | Prometheus metrics collection |
| **Monitoring** | `monitoring.service.module` | Application monitoring |
| **Observability** | `observability.module` | OpenTelemetry tracing and instrumentation |
| **Logging** | `logging.module` | Structured logging integration |
| **MQTT** | `mqtt.service.module` | MQTT message broker client |
| **Integrations** | `integrations.module` | External service integrations (Microsoft Graph, etc.) |
| **Crypto** | `crypto.service.module` | Encryption and hashing utilities |
| **Common** | `common.service.module` | Shared service utilities |

## Authorization

The authorization system uses [CASL](https://casl.js.org/) for attribute-based access control:

```
packages/applications/src/authorization/
├── authorization.module.ts    # @Global() module registration
├── unified-auth.guard.ts      # Single guard: Public → API Key → JWT → CASL
├── authorization.guard.ts     # Legacy CASL-only guard (deprecated)
├── policy.engine.ts           # Builds CASL abilities from user roles and policies
└── decorators.ts              # @Authorize(), @Public(), @CanRead(), etc.
```

**Flow:**
1. `UnifiedAuthGuard` checks if route is `@Public()` — if so, skips auth
2. If API key header present: validates via `IApiKeyService`, checks rate limit, IP, scopes
3. If JWT Bearer present: validates via Passport, then evaluates CASL permissions
4. `PolicyEngine` loads user's roles → builds CASL `Ability` from aggregated rules
5. Guard checks `ability.can(action, subject)` before route execution

### Decorators

```typescript
import { Authorize, Public, CanRead, UserAbility } from '@arcaai/applications';

@Controller('users')
export class UserController {
  @Get()
  @CanRead('User')
  findAll(@UserAbility() ability: AppAbility) {
    // ability is the authenticated user's CASL ability
  }

  @Get('public-endpoint')
  @Public()
  healthCheck() {
    // bypasses UnifiedAuthGuard entirely
  }
}
```

## Key Patterns

### Service Structure

Each service module follows a consistent pattern:

```typescript
@Module({
  imports: [CoreDatabaseModule],
  providers: [UserService],
  exports: [UserService],
})
export class UserServiceModule {}
```

### Repository Dependency

Services inject repositories from `@arcaai/domains` for data access:

```typescript
@Injectable()
export class UserService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly userProfileRepository: UserProfileRepository,
  ) {}

  async createUser(dto: CreateUserDto, userId: string): Promise<UserEntity> {
    const user = UserFactory.CreateUser({
      username: dto.username,
      password: await hash(dto.password),
      createdBy: userId,
    });
    return this.userRepository.create(user);
  }
}
```

### Event-Driven Communication

Services publish domain events after successful persistence:

```typescript
const savedUser = await this.userRepository.create(user);
await savedUser.publishEvents(this.eventEmitter);
```

### Background Jobs (BullMQ)

Long-running tasks use BullMQ queues backed by Redis:

```typescript
@Injectable()
export class ConsultationJobService {
  constructor(@InjectQueue('consultation') private queue: Queue) {}

  async queueSummarization(consultationId: string) {
    await this.queue.add('summarize', { consultationId });
  }
}
```

## Installation and Usage

The API gateway imports service modules directly:

```typescript
// apps/api/src/app.module.ts
import {
  AuthServiceModule,
  UserServiceModule,
  TenantServiceModule,
  AuthorizationModule,
} from '@arcaai/applications';

@Module({
  imports: [
    AuthServiceModule,
    UserServiceModule,
    TenantServiceModule,
    AuthorizationModule,
    // ... other service modules
  ],
})
export class AppModule {}
```

## Build and Development

```bash
# Build the package
pnpm build

# Watch mode for development
pnpm dev

# Lint
pnpm lint

# Type check without emitting
pnpm typecheck
```

## Testing Strategy

- **Unit tests**: Service logic with mocked repositories (Vitest)
- **Integration tests**: Service + repository with test database
- **E2E tests**: Full request cycle through API gateway

## Related Packages

- [`@arcaai/domains`](../domains/README.md) — Entity definitions, repositories, factories, mappers
- [`@arcaai/database`](../database/README.md) — Prisma client and schema management
- [`@arcaai/exceptions`](../exceptions/README.md) — Custom exception classes
- [`@arcaai/logger`](../logger/README.md) — Structured logging
- [`@arcaai/tools`](../tools/README.md) — Code generators for scaffolding new services
