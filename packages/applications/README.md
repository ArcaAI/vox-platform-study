# @arcaai/applications — the application service layer

NestJS application services, request/response DTOs, service modules, authorization (CASL policy
engine, guards, decorators), sys-event fan-out, and platform infrastructure services (Redis/BullMQ,
blob storage, secrets, observability) for the HOPE platform. Depends on `@arcaai/domains`
(repositories, factories, enums) and never imports Prisma runtime code directly. Sole workspace
consumer: `apps/api`, which composes its controllers exclusively from modules exported here.

```
packages/database  ->  packages/domains  ->  packages/applications  ->  apps/api
```

## Layout

| Path | What it holds |
|---|---|
| `src/common/` | `BaseService`, `applyChangesToEntity`, tenant guards, pagination, PHI field encryption/scrubbing, DTO bases, cursor pagination, env/egress helpers |
| `src/interfaces/` | `IActiveUserContext` (CLS shape), `IBaseService`, `IClsContext`, `IServiceAccountPrincipal` |
| `src/decorators/` | `@InjectActiveUser`, swagger/transform/validation helpers |
| `src/authorization/` | `PolicyEngine` (CASL), `AuthorizationGuard`, `UnifiedAuthGuard`, `@Public`/`@Authorize`/`@Can*` decorators |
| `src/services/` | One folder per service domain (84 domains as of this pass; see below) |
| `src/services/baseServices/` | `CommonServiceModule`: config, secrets, Redis/BullMQ, S3/blob storage, health checks, logging, metrics, MQTT, observability, rate limiting, units of work |

`src/services/` covers CRUD services (`department`, `tenant`, `user`, `globalSetting`, ...),
AI-platform configuration (`agent`, `ai-model`, `ai-provider-connection`, `ai-routing-policy`,
`settings-registry`, `mcp-server`, ...), workflow/agent execution (`workflow-run`,
`workflow-definition`, `agent-trajectory`, `agentPromotion`, ...), and platform operations
(`metering`, `usageLedger`, `billing`, `audit`, `sysEvent`, ...). Browse the directory for the full
list rather than trusting an enumerated one here — it grows every sprint.

## Service anatomy

Each service folder follows the same shape (reference implementation: `services/department/`):

| Path | What it holds |
|---|---|
| `department.service.ts` | `DepartmentService extends BaseService` |
| `department.service.module.ts` | `DepartmentServiceModule` (DI wiring) |
| `IDepartmentService.ts` | Interface + `Symbol` injection token |
| `department.dto.mapper.ts` | Entity to Response DTO mapping |
| `dto/` | create/update requests, response DTOs |
| `__tests__/` | Vitest unit tests |
| `index.ts` | Barrel export |

## How it works

### BaseService

All services extend `BaseService` (`src/common/base.service.ts`):

| Member | Purpose |
|---|---|
| `broadcastSysEvent(type, data)` | Emits a `SysEvent` for audit logging, user-activity tracking, and webhooks. `tenantId` is ALWAYS taken from CLS and cannot be overridden by the payload (falls back to the reserved SYSTEM tenant when CLS carries none); a service-account caller is recorded via `responsibleServiceAccountId` instead of a human `responsibleEntityId`; impersonation provenance (`impersonatedBy`) is threaded into `metaData` automatically |
| `updateEntity(entity, changes, customHandlers?)` | Applies DTO fields through entity setters (`applyChangesToEntity`, triggers change tracking) FIRST, then stamps `updatedBy` from the request context only if something was actually staged — so a semantically empty request never manufactures a change |
| `requestUser`, `requestUserId`, `requestUserName`, `requestUserEmail`, `requestServiceAccount` | Current session/machine-principal from CLS |
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

(Simplified — the real `DepartmentService` constructor carries additional optional, append-only
dependencies for later features; see Gotchas.)

Create/update/delete follow `Factory.CreateXxx()` -> `repository.create()` -> `broadcastSysEvent(ResourceCreated)`,
`repository.findById()` -> `this.updateEntity()` -> `repository.update()` -> `broadcastSysEvent(ResourceUpdated)`,
and `repository.softDelete()` -> `broadcastSysEvent(ResourceDeleted)`. Public service methods return
response DTOs, never raw entities.

### Module registration

Modules bind the interface token to the implementation and import `CommonServiceModule` +
`CoreDatabaseModule` (real file: `services/department/department.service.module.ts`):

```typescript
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, EntitlementsServiceModule],
  providers: [
    DepartmentService,
    // useExisting, not useClass — useClass would construct a second
    // DepartmentService instance instead of aliasing the one above.
    { provide: IDepartmentService, useExisting: DepartmentService },
  ],
  exports: [IDepartmentService, DepartmentService],
})
export class DepartmentServiceModule {}
```

`CommonServiceModule` (`services/baseServices/common.service.module.ts`) bundles config, the
secrets service (with JWT/S3/OIDC key warm-up), Redis/BullMQ queue registration, S3 blob storage,
health checks, and observability. See `services/baseServices/_meta/README.md` for `ConfigService`
vs `AppSettingsService` vs `SecretsService`.

### DTOs

Request DTOs use `class-validator` + Swagger decorators (see
`services/department/dto/create-department.request.ts`); response DTOs are plain shapes produced by
each service's `*.dto.mapper.ts`. Responses include `version` so callers can echo it back for
optimistic-concurrency updates (`If-Match` / `expectedVersion`).

### SysEvent fan-out

`services/sysEvent/sysEvent.service.ts` subscribes to `SysEventType.*` via `@OnEvent` and enqueues
BullMQ jobs (audit log, user activity, webhooks) with retry/backoff, so audit persistence is
asynchronous and non-blocking. Every mutating service method must call `broadcastSysEvent` after a
successful write, and the model must be registered in `ResourceType` (both
`packages/database/src/prisma/db_main/audit.prisma` and
`packages/domains/src/enums/generated/ResourceType.ts`) or the audit INSERT throws and rolls the
mutation into a 500.

### Tenant guards

Cross-aggregate isolation checks that the database tenant-scope extension cannot express live in
`src/common/tenant-guards.ts`:

- `assertEqualTenants(parent, child)` — parent/child rows must share a tenant; throws `NotFoundException` on mismatch (no existence leak).
- `assertUserBelongsToTenant(roleRepo, deptRepo, userRepo, userId, tenantId)` — verifies an enabled `UserRoleAssignment` (and, for a non-exempt user, `UserDepartment` membership) before referencing a user in tenant-scoped rows.
- `assertParentInScope(repo, parentId, callerTenantId)` — load-and-assert sugar for the common parent lookup.
- `isSuperAdmin(user)` / `ELEVATED_ROLES` — the single source of truth for the cross-tenant privileged role (`SUPER_ADMIN`).

### Authorization

`src/authorization/` provides the CASL-based `PolicyEngine`, `AuthorizationGuard`/`UnifiedAuthGuard`,
and controller decorators: `@Public()`, `@Authorize(['action', 'subject'])`, `@AuthorizeAny(...)`,
the shorthands `@CanRead`, `@CanList`, `@CanCreate`, `@CanUpdate`, `@CanDelete`, `@CanManage`,
`@CanAny`, `@CanAll`, plus `@ForbidApiKey`, `@ForbidServiceAccount`, `@RequiredScopes`,
`@RequiredSvcScopes`, and the `@UserAbility()` param decorator. Authorization is enforced at
controllers/guards — never inside service business logic.

## Commands

| Command | package.json script | From repo root |
|---|---|---|
| Build | `rimraf dist tsconfig.tsbuildinfo && tsc` | `pnpm --filter @arcaai/applications build` |
| Watch | `tsc --watch` | `pnpm --filter @arcaai/applications dev` |
| Test | `vitest run --passWithNoTests` | `pnpm --filter @arcaai/applications test` |
| Typecheck | `tsc --noEmit` | `pnpm --filter @arcaai/applications typecheck` |
| Lint | `eslint .` | `pnpm --filter @arcaai/applications lint` |

Unit tests live in `__tests__/` folders beside each service and mock repositories, `EventEmitter2`,
and `ClsService`; they verify factory usage, change tracking, and `broadcastSysEvent` calls. A
scaffold generator for a new service folder exists: root `pnpm gen:service` (`@arcaai/tools`,
`generate-service-module`).

## Gotchas

- `this.databaseService.client` is lint-banned in `services/**/*.service.ts` (`no-restricted-syntax`,
  `packages/config-eslint/flat/core.js`) — route through a domain-layer repository instead. The only
  standing exclusions are `services/audit/**`, `services/tenant/**`,
  `services/user/userRoleAssignment/**`, and `services/baseServices/**` (which legitimately hosts
  the unit-of-work plumbing). In `packages/*` this surfaces as an ESLint WARNING
  (`eslint-plugin-only-warn`) — treat it as an error anyway.
- Cross-tenant access throws `NotFoundException` (404-over-403), never `ForbiddenException` — the
  house posture hides resource existence rather than leaking it via a 403.
- New constructor dependencies are appended LAST and marked `@Optional()` (append-only DI) so
  existing positional test constructors keep compiling — see `department.service.ts` for the
  pattern repeated across several optional, later-added repositories.

## Related

- [`04-application-services.md`](../../.claude/rules/04-application-services.md) — the rule this README mirrors
- [`03-domain-layer.md`](../../.claude/rules/03-domain-layer.md) — the repository/factory/entity layer this package consumes
- [`05-nestjs-api.md`](../../.claude/rules/05-nestjs-api.md) — how `apps/api` composes these modules
- [`baseServices/_meta` README](src/services/baseServices/_meta/README.md) — `ConfigService`/`AppSettingsService`/`SecretsService`
- [Department service README](src/services/department/README.md) — the CRUD + OCC exemplar
