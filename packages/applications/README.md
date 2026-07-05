# @arcaai/applications

Application service layer of the HOPE platform: NestJS services, request/response DTOs, service modules, authorization (policy engine, guards, decorators), system-event fan-out, and platform infrastructure services (Redis/BullMQ, blob storage, secrets, observability). The API gateway (`apps/api`) composes its controllers exclusively from modules exported here.

Last updated: 2026-07-04

## Position in the stack

```
packages/database  →  packages/domains  →  packages/applications  →  apps/api
```

Depends on `@arcaai/domains` (repositories, factories, enums), `@arcaai/exceptions`, `@arcaai/logger`, `@arcaai/types`, and — as peer dependencies — the NestJS 11 family, `bullmq`, `class-validator`/`class-transformer`, `nestjs-cls`, and `ioredis`. Sole workspace consumer: `@arcaai/api`.

Rule of thumb enforced across the layer: services use domain repositories and factories, never Prisma directly; controllers hold no business logic.

## Directory structure

```
src/
├── common/            # BaseService, applyChangesToEntity, tenant guards, pagination,
│                      # PHI field encryption, DTO bases, env helpers
├── interfaces/        # IActiveUserContext (CLS shape), IBaseService, IClsContext, IOidcUserProfile
├── decorators/        # Gateway decorators, @InjectActiveUser, swagger/transform/validation helpers
├── authorization/     # PolicyEngine (CASL), AuthorizationGuard, UnifiedAuthGuard,
│                      # @Public/@Authorize/@Can* decorators
└── services/          # One folder per service domain (see table below)
    └── baseServices/  # CommonServiceModule: config, secrets, Redis/BullMQ, S3/blob storage,
                       # health checks, logging (pino-based transports), metrics, MQTT,
                       # observability (OpenTelemetry), rate limiting, units of work
```

Service domains under `src/services/`: apiKey, audit, audit-retention, auditLog, auth (JWT/OIDC), config-resolver, consultation, crypto, department, dna-writing-style, entitlements, eval, globalSetting, harness-audit, harness-observability, harness-policy, knowledge, media, metering, notification, pipeline-policy, platform-metrics, prompt-management, pstudio, queue-admin, rate-limit, rbac, resourceSubscription, security, smr, storage-access-key, stt, sysEvent, tag, tenant, tenant-bucket, tenant-frontend-config, tenant-storage-config, user, webhook.

## Service anatomy

Each service folder follows the same shape (using `services/department/` as the reference implementation):

```
department/
├── department.service.ts          # DepartmentService extends BaseService
├── department.service.module.ts   # DepartmentServiceModule (DI wiring)
├── IDepartmentService.ts          # Interface + Symbol injection token
├── department.dto.mapper.ts       # Entity → Response DTO mapping
├── dto/                           # create/update requests, response DTOs
├── __tests__/                     # Vitest unit tests
└── index.ts                       # Barrel export
```

### BaseService

All services extend `BaseService` (`src/common/base.service.ts`), which provides:

| Member | Purpose |
|---|---|
| `broadcastSysEvent(type, data)` | Emits a `SysEvent` for audit logging, user-activity tracking, and webhooks. `tenantId` is always taken from CLS and cannot be overridden by the payload; impersonation provenance (`impersonatedBy`) is threaded into `metaData` automatically |
| `updateEntity(entity, changes, customHandlers?)` | Sets `updatedBy` from the request context and applies DTO fields through entity setters via `applyChangesToEntity` (triggers change tracking; supports custom field handlers, e.g. password hashing) |
| `requestUser`, `requestUserId`, `requestUserName`, `requestUserEmail` | Current session from CLS |
| `tenantId`, `tenantCode`, `correlationId`, `requestIp` | Request context from CLS |

### CRUD flow with events (real pattern from `DepartmentService`)

```typescript
@Injectable()
export class DepartmentService extends BaseService implements IDepartmentService {
  constructor(
    private readonly departmentRepository: DepartmentRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.Department);
  }

  async getAll(): Promise<DepartmentResponse[]> {
    const departments = await this.departmentRepository.findAllByTenant(this.tenantId);
    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { count: departments.length } });
    return departments.map(DepartmentDtoMapper.toResponse);
  }
}
```

Create/update/delete follow `Factory.CreateXxx()` → `repository.create()` → `broadcastSysEvent(ResourceCreated)`, `repository.findById()` → `this.updateEntity()` → `repository.update()` → `broadcastSysEvent(ResourceUpdated)`, and `repository.softDelete()` → `broadcastSysEvent(ResourceDeleted)`. Public service methods return response DTOs, never raw entities.

### Module registration

Modules bind the interface token to the implementation and import `CommonServiceModule` + `CoreDatabaseModule` (real file: `services/department/department.service.module.ts`):

```typescript
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, EntitlementsServiceModule],
  providers: [{ provide: IDepartmentService, useClass: DepartmentService }, DepartmentService],
  exports: [IDepartmentService, DepartmentService],
})
export class DepartmentServiceModule {}
```

`CommonServiceModule` (`services/baseServices/common.service.module.ts`) bundles config, the secrets service (with JWT/S3/OIDC key warm-up), Redis/BullMQ queue registration, S3 blob storage, health checks, and observability.

### DTOs

Request DTOs use `class-validator` + Swagger decorators (see `services/department/dto/create-department.request.ts`); response DTOs are plain shapes produced by each service's `*.dto.mapper.ts`. Responses include `version` so SDK clients can echo it back for optimistic-concurrency updates (`If-Match` / `expectedVersion`).

### SysEvent fan-out

`services/sysEvent/sysEvent.service.ts` subscribes to `SysEventType.*` via `@OnEvent` and enqueues BullMQ jobs (audit log, user activity, webhooks) with retry/backoff, so audit persistence is asynchronous and non-blocking. Every mutating service method must call `broadcastSysEvent` after a successful write — the audit trail depends on it.

### Tenant guards

Cross-aggregate isolation checks that the database tenant-scope extension cannot express live in `src/common/tenant-guards.ts`:

- `assertEqualTenants(parent, child)` — parent/child rows must share a tenant; throws `NotFoundException` on mismatch (no existence leak).
- `assertUserBelongsToTenant(roleRepo, deptRepo, userRepo, userId, tenantId)` — verifies enabled `UserRoleAssignment` + `UserDepartment` membership before referencing a user in tenant-scoped rows.
- `assertParentInScope(repo, parentId, callerTenantId)` — load-and-assert sugar for the common parent lookup.
- `isSuperAdmin(user)` / `ELEVATED_ROLES` — the single source of truth for the cross-tenant privileged role (`GLOBAL_ADMIN`; the legacy `SUPER_ADMIN` was consolidated into it by TASK-417).

### Authorization

`src/authorization/` provides the CASL-based `PolicyEngine`, `AuthorizationGuard`/`UnifiedAuthGuard`, and controller decorators: `@Public()`, `@Authorize(['action', 'subject'])`, `@AuthorizeAny(...)`, and the shorthands `@CanRead`, `@CanList`, `@CanCreate`, `@CanUpdate`, `@CanDelete`, `@CanManage`, `@CanAny`, `@CanAll`, plus the `@UserAbility()` param decorator. Authorization is enforced at controllers/guards — never inside service business logic.

## Commands

| Command | package.json script | From repo root |
|---|---|---|
| Build | `rimraf dist tsconfig.tsbuildinfo && tsc` | `pnpm --filter @arcaai/applications build` (or `pnpm build:modules`) |
| Watch | `tsc --watch` | `pnpm --filter @arcaai/applications dev` |
| Test | `vitest run --passWithNoTests` | `pnpm --filter @arcaai/applications test` |
| Typecheck | `tsc --noEmit` | `pnpm --filter @arcaai/applications typecheck` |
| Lint | `eslint .` | `pnpm --filter @arcaai/applications lint` |

Unit tests live in `__tests__/` folders beside each service and mock repositories, `EventEmitter2`, and `ClsService`; they verify factory usage, change tracking, and `broadcastSysEvent` calls. `scripts/` holds operational one-offs (media seed/backfill used by root `pnpm test:db:seed`).

## Adding a new service — checklist

1. Request/response DTOs in `dto/` (`class-validator` + `@nestjs/swagger`).
2. `IXxxService.ts` interface with a `Symbol` token.
3. `xxx.service.ts` extending `BaseService`; inject repositories from `@arcaai/domains`.
4. `xxx.dto.mapper.ts` for entity-to-response mapping.
5. `xxx.service.module.ts` importing `CommonServiceModule` + `CoreDatabaseModule`, providing the token.
6. Barrel exports in `index.ts`; unit tests in `__tests__/`.

A scaffold generator exists: root `pnpm gen:service` (see `@arcaai/tools`).
