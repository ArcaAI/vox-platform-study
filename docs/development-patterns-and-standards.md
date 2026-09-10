# HOPE — Development Patterns and Standards (verified against code)

_Freshness: Owner Platform Engineering · Introduced 2026-07-04 · Last verified 2026-08-19._

This document records the conventions the codebase ACTUALLY follows, verified by reading source files. Every file path cited exists in the repo. It describes the code as it stands today — it deliberately cites no implementation tickets, archived or active, so nothing here depends on reading a ticket to be understood. Where the codebase is internally inconsistent, section 7 says so explicitly.

Verification dates: the tooling surface (§2.3–2.4 Python commands, §5.1–5.6 turbo/pnpm/ESLint/CI/secret-scanning, §8 quick-reference) was re-verified 2026-08-19 against the root `package.json`, `pyproject.toml` and `.gitlab/ci/*`; the config-plane / model-lifecycle material (§1.4 repository trap, §1.6 `ArgumentInvalidException` mapping, §1.8, §2.8–2.9, §6.8 create-intent OCC) and the deliberate-403 privilege walls (§6.1) on 2026-07-21; the remainder on 2026-07-04.

Command-level how-to (starting the local stack, per-suite runners, troubleshooting) lives in the companion [development-guide.md](./development-guide.md); this document is the _what the code does_ reference.

Monorepo shape (verified): Turborepo + pnpm workspace (`pnpm-workspace.yaml`: `apps/*` minus the deliberately-excluded `apps/quick-compat-app`, `packages/*`, `packages/agentic-sdk-v2/examples/*`), Node >= 22, pnpm 10.34.5, TypeScript 5.9, Prisma 7, NestJS 11, Vitest 4, Playwright, Python 3.11 (FastAPI) services under `apps/`, one shared conda env `arcaenv` plus a uv workspace (root `pyproject.toml` + single `uv.lock`).

---

## 1. Backend DDD patterns

Layering (enforced by lint, see 1.7): `packages/database` → `packages/domains` → `packages/applications` → `apps/api`.

### 1.1 Prisma schema conventions

The schema is MULTI-FILE: `packages/database/src/prisma/db_main/*.prisma` (NOT `packages/database/prisma/`). `schema.prisma` holds only datasource + generator; models live in per-domain files (`user.prisma`, `consultation.prisma`, `rbac.prisma`, `harness.prisma`, ...). Enums are centralized in `enums.prisma`.

- Datasource: PostgreSQL, two DB schemas `["public", "core"]`, `vector` extension; every model declares `@@schema("core")`.
- Generator: Prisma 7 `prisma-client` provider, output `packages/database/src/generated/core-prisma-client`, preview features `fullTextSearchPostgres`, `postgresqlExtensions`, `relationJoins`, `views`, `typedSql`.

Every model follows a strict field-section ordering (verified in `packages/database/src/prisma/db_main/user.prisma`, `department.prisma`, `tenant.prisma`):

```8:51:packages/database/src/prisma/db_main/user.prisma
model UserRoleAssignment {
  // meta fields
  metaData Json?  @map("_metadata") @db.JsonB
  version  Int    @default(1) @map("_version")
  id       String @id @default(uuid(7))

  // multi tenant fields
  tenantId String
  // ... core fields, resource status fields, audit fields, relations ...
  @@unique([userId, roleId, tenantId], name: "UserRoleAssignment_userId_roleId_tenantId_unique")
  @@index([tenantId], name: "UserRoleAssignment_tenantId_idx")
  @@schema("core")
}
```

Do / don't:

| Concern      | Convention                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id           | `String @id @default(uuid(7))` — UUIDv7, sortable. Don't use autoincrement or cuid.                                                                                                                                                                                                                                                                                                                                                                      |
| Meta         | `metaData Json? @map("_metadata") @db.JsonB` and `version Int @default(1) @map("_version")` first. `_version` is the optimistic-concurrency counter — never written by mappers (stripped in every `*EntityMapper`).                                                                                                                                                                                                                                      |
| Tenant       | `tenantId String` (NOT NULL, no default) on tenant-scoped models. `NULL = global` semantics are banned; platform-wide rows use the SYSTEM tenant `00000000-0000-0000-0000-000000000000`.                                                                                                                                                                                                                                                                 |
| Soft delete  | `resourceStatus ResourceStatusType @default(ENABLED)` + `resourceStatusUpdatedAt DateTime?` + `resourceStatusUpdatedBy String?`. Statuses: `ENABLED, DISABLED, SUSPENDED, ARCHIVED, DELETED` (`enums.prisma`). Tables that deliberately omit it (version history, WORM audit tables like `HarnessAuditEvent`, and `TranscriptionJob` which has its own status enum) must be listed in `MODELS_WITHOUT_SOFT_DELETE` in `packages/database/src/client.ts`. |
| Audit fields | `createdBy String? @default("60000000-0000-0000-0000-000000000000")` (system user), `updatedBy String?`, `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt`.                                                                                                                                                                                                                                                                          |
| Tags         | `tags String[] @default([])` when applicable.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Indexes      | Explicit names: `@@index([tenantId], name: "Model_tenantId_idx")`; always index `tenantId` and FKs. Composite uniques include `tenantId` (e.g. `UserDepartment_tenant_user_department_unique`).                                                                                                                                                                                                                                                          |
| Enums        | PascalCase names, SCREAMING_CASE members, `@@schema("core")`, defined in `packages/database/src/prisma/db_main/enums.prisma`.                                                                                                                                                                                                                                                                                                                            |

### 1.2 Migration workflow

- Config: root `prisma.config.ts` (Prisma 7 `defineConfig`) points schema to `packages/database/src/prisma/db_main` and migrations to `.../db_main/migrations`. It loads `.env.dev`/`.env.test`/`.env.production` by `NODE_ENV`, and loads NO env file in CI/production.
- Scripts (root `package.json` delegates to `packages/database/package.json`): `pnpm db:migrate` (= `prisma migrate dev` + `generate-prisma-index`; Prisma 7 removed `--skip-generate`), `db:migrate:create` (`--create-only`), `db:migrate:deploy`, `db:migrate:status`, `db:push` / `db:push:force`, `db:generate` (also regenerates the barrel via `@arcaai/tools generate-prisma-index`), `db:seed`, `db:studio`.
- Migration folders are named `<timestamp>_task_<nnn>_<snake_case_description>` — e.g. `packages/database/src/prisma/db_main/migrations/20260702000000_task_400_password_reset_tokens/`.
- Seeds live in `packages/database/src/prisma/db_main/seed/` (phased, FK-ordered, `XX-name.ts`); seed constants such as `SYSTEM_TENANT_ID` in `seed/00-constants.ts`.
- Production note (from `packages/database/src/client.ts` docstring): with PgBouncer, migrations must use `DIRECT_URL`; pool size comes from `PRISMA_PG_MAX` (default 5), not the v6 `connection_limit` URL param.

### 1.3 Prisma client access tiers (load-bearing)

`packages/database/src/client.ts` composes two `$extends` extensions and exposes two clients:

```301:312:packages/database/src/client.ts
/**
 * Get or create the extended Prisma Client singleton (default).
 *
 * Composes soft-delete filtering (`applySoftDeleteExtension`) with
 * tenant-scope injection (`applyTenantScopeExtension`). Every NestJS
 * service / repository / controller should use this client.
 */
export function getExtendedPrismaClient(): ExtendedCorePrismaClient {
  if (!extendedPrismaInstance) {
    extendedPrismaInstance = createExtendedPrismaClient();
  }
  return extendedPrismaInstance;
}
```

- DO use `getExtendedPrismaClient()` (or in NestJS, `CoreDatabaseService.client`). It auto-injects `tenantId` into reads/writes of the models in `TENANT_SCOPED_MODELS` and auto-filters `resourceStatus: { not: 'DELETED' }` on reads.
- DON'T import `getPlatformAdminPrismaClient_Unscoped` — it bypasses BOTH extensions. An ESLint `no-restricted-imports` guard blocks it everywhere except seeds, back-fill scripts, test fixtures, and `CoreDatabaseService.baseClient` (see 1.7).
- Tenant scope details (`packages/database/src/extensions/tenant-scope.ts`): allow-list `TENANT_SCOPED_MODELS` mirrors schema reality; `User*` identity tables are deliberately global (membership is modeled by `UserRoleAssignment` / `UserDepartment`). `SYSTEM_SHARED_READ_MODELS` (`AsrPipeline`, `AiModel`, `HarnessPolicy`, `GlobalSetting`, … — `PipelinePolicy` left with TASK-882 and `TenantTtsConfig` with TASK-888) widen READS to `tenantId IN [caller, SYSTEM]`; writes are never widened. The tenant id comes from a host-registered provider — NestJS wires the CLS-backed one in `apps/api/src/database/tenant-context.provider.ts`; without a provider the extension is pass-through (seeds/CLI).

### 1.4 Domain layer (`packages/domains`)

Folder layout: `entities/generated/core/`, `factories/generated/core/`, `mappers/generated/core/`, `models/generated/core/`, `repositories/generated/core/` — one file per Prisma model, named `XxxEntity.ts`, `XxxFactory.ts`, `XxxEntityMapper.ts`, `XxxModel.ts`, `XxxRepository.ts`. Hand-written repository extensions live outside `generated/` (e.g. `repositories/policy/`). **Only `pnpm gen:model` actually scaffolds** (from the Prisma DMMF). `gen:entity` and `gen:factory` are barrel RECONCILERS + schema-coverage checkers that reproduce committed files verbatim and never create new ones; `gen:mapper` is **destructive — never run it** (it strips the `_version` OCC guard from mappers before crashing); `gen:repository` is broken. Entities, factories, mappers and repositories are therefore hand-authored — see `.claude/rules/03-domain-layer.md` §Generated Code Discipline for the behaviour table and the new-model checklist. CI drift gates re-run the three working commands and fail on diff or a missing column (`.gitlab/ci/validate.yml` jobs `generate-data-model-check`, `generate-data-entity-check`, `generate-factory-check`).

Complete verified example trio — Department:

Entity (`packages/domains/src/entities/generated/core/DepartmentEntity.ts`) — interface + class extending a base, private fields, getters/setters that route through `setProperty()` (change tracking on `BaseEntity`, `packages/domains/src/common/baseEntity/base.entity.ts`), `validate()` override, and domain methods:

```27:36:packages/domains/src/entities/generated/core/DepartmentEntity.ts
export class DepartmentEntity extends BaseTenantEntity {
  private _code?: IDepartmentEntity['code'];
  private _name?: IDepartmentEntity['name'];
  private _description?: IDepartmentEntity['description'];
  private _parentDepartmentId?: IDepartmentEntity['parentDepartmentId'];
  private _defaultSummaryTemplate?: IDepartmentEntity['defaultSummaryTemplate'];
  private _preSummaryPromptId?: IDepartmentEntity['preSummaryPromptId'];
  private _newPatientPromptId?: IDepartmentEntity['newPatientPromptId'];
  private _revisitPromptId?: IDepartmentEntity['revisitPromptId'];
  private _dnaWritingStylePromptId?: IDepartmentEntity['dnaWritingStylePromptId'];
  private _promptConfig?: IDepartmentEntity['promptConfig'];
```

Base-class hierarchy (`packages/domains/src/common/baseEntity/`): `BaseEntity` → `BaseAggregate` (adds `addEvent()`/`publishEvents()` for `DomainEvent`s, `packages/domains/src/common/domainEvent.ts`) → `BaseTenantEntity` (adds `tenantId`) → `BaseTaggedEntity` (adds `tags`). Lifecycle methods (`archive()`, etc.) set `resourceStatus` + `resourceStatusUpdatedAt` through `setProperty`.

Factory (`packages/domains/src/factories/generated/core/DepartmentFactory.ts`) — static `CreateXxx(props)` methods; `generateId()` (UUIDv7, `packages/domains/src/utils/generateId.ts`); defaults applied with `??`:

```34:40:packages/domains/src/factories/generated/core/DepartmentFactory.ts
  static CreateDepartment(props: CreateDepartmentProps): DepartmentEntity {
    const id = generateId();
    const now = new Date();

    return new DepartmentEntity({
      id,
```

Mapper (`packages/domains/src/mappers/generated/core/DepartmentEntityMapper.ts`) — extends `BaseMapper<Entity, Model>`, implements `toPersistence` / `toPersistenceChanges` / `toDomainEntity` via `AutoClassMapper` / `AutoEntityChangeMapper` + `createMapperHandlers`, and strips the DB-owned `version` field from every write path (`FIELDS_NOT_WRITABLE = ['version']`).

Repository (`packages/domains/src/repositories/generated/core/DepartmentRepository.ts`) — `@Injectable()`, extends `Repository<Entity, Model>` (`packages/domains/src/common/repository.ts`), constructor wires the camelCase Prisma model name and mapper singleton:

```10:14:packages/domains/src/repositories/generated/core/DepartmentRepository.ts
@Injectable()
export class DepartmentRepository extends Repository<DepartmentEntity, Department> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'department', DepartmentEntityMapper.getInstance());
  }
```

Base `Repository` methods (verified in `packages/domains/src/common/repository.ts`): `create`, `findById`, `findFirst`, `findAll`, `count`, `update`, `updateWithVersion` (compare-and-set on `_version`, throws `OptimisticConcurrencyException`), `delete` (hard — avoid), `softDelete`, `restore`. `softDelete`/`restore` set `resourceStatus`, stamp `resourceStatusUpdatedAt/By` and `version: { increment: 1 }`, and throw for models in `MODELS_WITHOUT_SOFT_DELETE`.

⚠️ **`findById` and `findFirst` THROW `DataNotFoundException` on no match — they NEVER return `null`** (verified `repository.ts` lines 107, 118). Absence is a normal state for optional reads (a not-yet-materialized first-edit config-plane row, an existence probe), so a service that treats "not found" as ordinary must either read via `findAll(...)[0] ?? null` OR wrap the call and map `DataNotFoundException` → `null`. Exemplar: `SettingsRegistryWriteService.findBackingRow` — before the catch was added, the un-caught throw escaped as a blanket 404 on every `GET registry/:key` for a key with no stored row yet.

Validation placement: structural invariants in `entity.validate()` (called by base flows); business/cross-aggregate rules in application services with the tenant guards (1.5). DTO shape validation happens at the HTTP boundary (1.6).

Registration: every repository is provided/exported by `CoreDatabaseModule` (`packages/domains/src/common/databaseServices/core/core.database.module.ts`). Barrel `index.ts` files at each level must be updated (generators keep them in sync; CI enforces).

### 1.5 Application layer (`packages/applications`)

Service folder pattern (verified for `department`, mirrored across `services/*`):

```
packages/applications/src/services/department/
├── IDepartmentService.ts          # Symbol injection token + interface
├── department.service.ts          # @Injectable class extends BaseService
├── department.service.module.ts   # NestJS module
├── department.dto.mapper.ts       # Entity -> Response DTO (static methods)
├── dto/                           # create-*.request.ts, update-*.request.ts, *.response.ts
├── __tests__/                     # Vitest unit tests
└── index.ts                       # barrel
```

- Services extend `BaseService` (`packages/applications/src/common/base.service.ts`) which provides `broadcastSysEvent(type, data)`, `updateEntity(entity, dto)` (change-tracked updates), and CLS-backed context getters: `requestUser`, `requestUserId`, `tenantId`, plus request metadata.
- DI is interface-token based: `export const IDepartmentService = Symbol(...)` in `IDepartmentService.ts`; module provides `{ provide: IDepartmentService, useClass: DepartmentService }`; controllers inject with `@Inject(IDepartmentService)`.
- Module registration (verified `packages/applications/src/services/department/department.service.module.ts`): import `CommonServiceModule` (from `services/baseServices/common.service.module.ts` — config, secrets, redis, storage, health, observability) + `CoreDatabaseModule` (from `@arcaai/domains`), provide + export both the token and the class.
- SysEvent broadcasting after EVERY mutation (and reads, as `ResourceViewed`) — the real helper is `this.broadcastSysEvent(...)` with `SysEventType` from `packages/domains/src/enums/sysEventType.enum.ts` (`ResourceCreated/Viewed/Updated/Deleted/Archived`, `WebHookRun`, `SendContactMessage`):

```216:224:packages/applications/src/services/department/department.service.ts
    const saved = await this.departmentRepository.create(department);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { code: dto.code, name: dto.name },
    });

    return DepartmentDtoMapper.toResponse(saved);
```

Events are consumed by `SysEventService` (`packages/applications/src/services/sysEvent/sysEvent.service.ts`) via `@OnEvent(SysEventType.*)`, which enqueues BullMQ jobs for audit-log persistence, user activity, and webhooks. Reads are NOT audit-logged unless `forceAuditLog: true`.

- Request DTOs use `class-validator` + `@nestjs/swagger` (`@ApiProperty`/`@ApiPropertyOptional`) — see `packages/applications/src/services/department/dto/create-department.request.ts`. Every field must be declared or the global `forbidNonWhitelisted` pipe rejects the request. Response DTOs are plain classes with `@ApiProperty` and timestamps as ISO strings.
- Update flow (verified `department.service.ts#update`): `findById` → tenant-ownership check (mismatch throws `NotFoundException`, never `ForbiddenException`, to avoid existence leaks) → `this.updateEntity(entity, dto)` → `entity.hasChanges` guard (`ArgumentInvalidException` when empty) → `repository.updateWithVersion(id, entity, expectedVersion)` → broadcast `ResourceUpdated` with `previousVersion`/`newVersion`.
- Delete flow: `repository.softDelete(id)` → broadcast `ResourceDeleted`. Hard `delete()` is reserved for genuinely immutable cleanup paths.
- Tenant guards for cross-aggregate checks: `assertEqualTenants`, `assertParentInScope`, `assertUserBelongsToTenant`, `isSuperAdmin` in `packages/applications/src/common/tenant-guards.ts`.
- Transactions: the canonical production pattern is `this.databaseService.baseClient.$transaction(callback)` (documented in `packages/applications/src/services/baseServices/unitsOfWork/core/core.unitOfWork.ts`, which also offers `runInTransaction(work)`); repositories accept an optional `tx` client and `CoreUnitOfWorkService` (`packages/domains/src/common/unitsOfWork/core/core.unitOfWork.ts`) propagates it.
- Entitlement enforcement is fully implemented but gated behind the global kill-switch `entitlements.enabled`, which **ships OFF** and is read on every hot check (a flip is live at cache-refresh speed). Two enforcement paths (`packages/applications/src/services/entitlements/enforcement.ts`): the block-new quota precheck `IEntitlementsService.assertQuantityQuota` (`wouldExceedLimit` → `QuotaExceededException` → HTTP **409**), and the rolling-monthly METER capabilities (`monthlyConsultations`/`monthlyTranscriptionMinutes`/`monthlySummaries`, backed by `TenantUsageMeter` live Postgres aggregation → HTTP **429**). Usage is metered and surfaced (`EntitlementCapabilitiesResponse.meters`, the "M1–M3" rows) regardless of whether the kill-switch is on; only the block/429 verdict is gated. Downgrades soft-disable the newest overflow resources (never delete, `selectResourcesToDisable`) and trial expiry flips `TRIAL`→`STARTER`, both via self-scheduling lifecycle jobs.

### 1.6 API layer (`apps/api`)

- Bootstrap (`apps/api/src/main.ts`): global prefix `api/v1` (excluding `/metrics`), Swagger at `/api/v1/docs` (non-prod only), native `WsAdapter`, `enableShutdownHooks()`, and a strict global `ValidationPipe`:

```120:127:apps/api/src/main.ts
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }),
  );
```

- Global guards, in declaration order (`apps/api/src/app.module.ts`): `TieredThrottlerGuard` → `UnifiedAuthGuard` (`packages/applications/src/authorization/unified-auth.guard.ts`, default-deny; `@Public()` is the explicit opt-out) → `TenantOwnedResourceSseGuard` → `RequiresIfMatchGuard`. Global interceptors include `ETagInterceptor` (renders `_version` as a strong `ETag`) and `ImpersonationAuditInterceptor`. Global filter maps `DataNotFoundException` to a generic 404 (`apps/api/src/filters/`, e.g. `prisma.filter.ts`, `data-not-found.filter.ts`).
- Controllers live in `apps/api/src/modules/<feature>/` as `<feature>.controller.ts` + `<feature>.module.ts` (+ `__tests__/`). Verified conventions (from `apps/api/src/modules/department/department.controller.ts`):
  - Route naming: admin surfaces are `@Controller('admin/<plural>')` (e.g. `admin/departments`); user self-service under `user/me/...`; internal endpoints under `internal/` (see `apps/api/src/modules/internal/`); versioning comes only from the `api/v1` global prefix.
  - Authorization decorators (real names, defined in `packages/applications/src/authorization/decorators.ts`, re-exported via `apps/api/src/decorators/index.ts`): `@Public`, `@Authorize(['manage','Department'])`, `@AuthorizeAny`, `@CanRead/CanList/CanCreate/CanUpdate/CanDelete/CanManage('Resource')`, `@CanAny/CanAll`. Class-level `@CanManage('Department')` gates the whole admin controller.
  - The house `@ApiEndpoint({ returnedModel, method, path, by, multi })` decorator (`apps/api/src/decorators/apiEndpoint.decorator.ts`) wraps route + Swagger boilerplate; plain `@Get()` etc. plus explicit `@ApiOperation` are used when it doesn't fit.
  - Optimistic concurrency on PATCH: `@RequiresIfMatch()` + `@ExpectedVersion()` (`apps/api/src/decorators/requiresIfMatch.decorator.ts`, `expectedVersion.decorator.ts`); missing `If-Match` → 428, version drift → 412 via `OptimisticConcurrencyException` (`packages/exceptions/src/backend/persistence/optimisticConcurrency.exception.ts`).
  - Controllers hold NO business logic and NO Prisma access (lint-enforced); they inject `I*Service` tokens and `ClsService` only.
- Error handling: domain/persistence exceptions come from `@arcaai/exceptions` (`packages/exceptions/src/` — `common/` base classes, `domain/` e.g. `business.exception.ts`, `quotaExceeded.exception.ts`, `backend/application/` e.g. `argumentInvalid.exception.ts`, `backend/persistence/` e.g. `dataNotFound`, `optimisticConcurrency`). Services also use plain NestJS `BadRequestException`/`NotFoundException` for HTTP-ish checks.
  - `ArgumentInvalidException` (a `BaseException`, code `GENERIC.ARGUMENT_INVALID`) is mapped to **`400 Bad Request`** by the global `ExceptionInterceptor` (`apps/api/src/interceptors/exception.interceptor.ts`). It is the house signal for a service-level validation REFUSAL — unwritable settings tier, type mismatch, no-op update (`entity.hasChanges` empty), bad slug, secret requested through a config read, out-of-range max-scope. The explicit branch must precede the generic `BaseException` branch; before it existed, every such refusal fell through to a generic `500`.
- Logging: `@arcaai/logger` (`packages/logger/src/index.ts`) is the shared logging service; bootstrap registers crash handlers that flush it (`apps/api/src/crash-handlers.ts`).
- Python-service proxying: the live Text proxy is the standalone `TextProxyController` (`apps/api/src/modules/streaming/text-proxy.controller.ts`) — upstream URL from `IConfigService`, service-token injection from `SecretsService`. `BaseProxyController` (`apps/api/src/shared/base-proxy.controller.ts`) still exists with its `ProxyControllerConfig` shape and unit test, but as of 2026-08-19 **no controller extends it** — treat it as available scaffolding, not the current pattern. WebSocket bridging to STT is a NestJS gateway: `@WebSocketGateway({ path: '/ws/stt/stream' })` in `apps/api/src/modules/streaming/stt-ws.gateway.ts`.

### 1.7 Dependency-direction rules — exactly what the lint config encodes

ESLint runs on ESLint 9 flat config: every package has an `eslint.config.mjs` spreading a preset from `packages/config-eslint/flat/` (`library.js` for packages, `nestjs.js` for apps/api, `next.js` for apps/admin-console), custom plugin: `packages/eslint-plugin-arcaai-internal/` (rules registered in its `index.js`).

The four enforced architecture rules (all in `packages/config-eslint/flat/core.js`):

1. `arcaai-internal/no-controller-direct-prisma` (error) — scope `**/modules/**/*.controller.ts` (i.e. `apps/api`). Forbids any `<x>.databaseService.client` chain in controllers. Escape hatch: `/** @allowedDirectPrisma <reason> */` within 3 lines above. Rule source: `packages/eslint-plugin-arcaai-internal/rules/no-controller-direct-prisma.js`. Current allow-list usage: zero occurrences in `apps/api/src` (verified).
2. Service-layer analogue via built-in `no-restricted-syntax` — scope `**/services/**/*.service.ts`, AST selector matching `<x>.databaseService.client`; message: route through a domain-layer repository. `excludedFiles` pins: `**/services/audit/**`, `**/services/tenant/**`, `**/services/user/userRoleAssignment/**`, `**/services/baseServices/**` (the last is permanent — it hosts `CoreDatabaseService`/unit-of-work plumbing).
3. `arcaai-internal/no-direct-downstream-url-env` (error) — scope `**/modules/**/*.ts`. Forbids `process.env.TEXT_URL|TEXT_SERVICE_URL|STT_URL|NLP_URL|GUARDRAIL_URL|HARNESS_URL` (dot or bracket access). Callers must inject `IConfigService` and call `getConfigValue('TEXT_URL')` (`packages/applications/src/services/baseServices/_meta/config/config.service.ts`). Rule source: `packages/eslint-plugin-arcaai-internal/rules/no-direct-downstream-url-env.js`.
4. `no-restricted-imports` (error, repo-wide) — bans importing `getPlatformAdminPrismaClient_Unscoped` from `@arcaai/database` (and deep paths). Allowed only for seeds (`packages/database/src/prisma/db_main/seed/**`), back-fill scripts (`packages/database/scripts/**`), test fixtures, and the transitional `CoreDatabaseService.baseClient`.

Additional conventions from `flat/core.js`: `@typescript-eslint/no-unused-vars` honors the `_`-prefix convention for intentionally-unused identifiers. Note: `flat/library.js` adds `eslint-plugin-only-warn`, which downgrades all violations to warnings inside packages (see 7.2).

Import-direction do/don'ts (encoded partly by lint, partly by convention, both verified):

- Controllers (apps/api) DO import DTOs/tokens from `@arcaai/applications`; DON'T touch Prisma or `process.env.<downstream URL>`.
- Application services DO import repositories/factories/enums from `@arcaai/domains`; DON'T import runtime code from `@arcaai/database` (type-only imports are the sanctioned exception — see `packages/applications/src/common/modelFilterTypes.ts`, which documents this).
- Domain entities are DB-agnostic; only mappers/repositories/database-services know about Prisma models.

### 1.8 Config-plane service patterns (settings registry · effective-config · BYO credentials)

On top of the DDD services sits a control-plane layer: the DB is the control plane (§6.10) and these services turn typed descriptors into enforced reads/writes. All verified under `packages/applications/src/services/`.

**Settings registry + catalog.** `SettingsRegistry` (`settings-registry/settings-registry.ts`) is a pure, DI-free `Map<key, SettingDescriptor>` assembled once at module load as `HOPE_SETTINGS_REGISTRY` (`settings-registry/registry.ts`) from per-feature descriptor arrays (`descriptors/*.descriptors.ts`). A `SettingDescriptor` (`settings-registry/registry.types.ts`) is metadata ONLY — it does not hold the value; it declares WHERE the value lives (`tier` = the §6.10 data class), the deepest cascade scope a tenant admin may set it at (`maxScope` over `system < tenant < department < doctor`, depth in `SCOPE_DEPTH`), `sensitivity`, the CASL subject that gates edits (`editableBy`), `globalOnly`, server-side `category`, and `killSwitch`. `register` throws on a duplicate key so assembly fails loudly; the assembled catalog is served RBAC-filtered at `GET /api/v1/admin/settings/catalog`.

**Descriptor locks (the write lane).** `SettingsRegistryWriteService` (`settings-registry/settings-registry-write.service.ts`) is the single enforcement point (AD-1) for `global-kv` keys, and the FIRST production caller of `assertWithinMaxScope`. Every guard reads descriptor metadata, in order: unknown key → `ArgumentInvalidException` (400); `sensitivity: 'secret'` → refused (secrets never traverse this lane); `globalOnly && !isSuperAdmin` → **403** (a privilege boundary, not the 404-over-403 posture — the caller can already READ the key via the catalog); `assertWithinMaxScope(key, scope)` → 400 when the requested scope is deeper than `maxScope`; tier ≠ `global-kv` → 400 (dedicated services still own `db-config`/`db-secret` keys); dataType serialization; then a compare-and-set upsert of the backing `GlobalSetting` row under the reserved `registry` namespace, followed by `appSettings.refreshCache()`. The write is `If-Match`-gated: an existing row with no `expectedVersion` → 428, drift → 412.

**Kill-switch invariant.** `SettingsRegistry.killSwitches()` returns every `killSwitch: true` descriptor and THROWS at call time if any defaults truthy — encoding the governance rule that an enforcing kill-switch MUST default OFF (fail-safe rollout), matching §6.10's default-OFF anti-pattern. A governance test calls it so an accidental default-ON flip fails CI.

**Effective-config (the read side).** Two facades, each REFUSING secret keys and each throwing `ArgumentInvalidException` (400) on an unknown/unresolvable key, both delegating to existing per-tier resolvers rather than re-implementing data access:

- `EffectiveSettingsService` (`settings-registry/effective-settings.service.ts`) — registry-key-addressed "what is the effective value of K for this context, and which tier set it?": `pipeline.*` → `ConfigResolver` cascade; `models.*` → `AiTaskDefaultService` (tenant → SYSTEM); `global-kv` → the AppSettings cache (else the descriptor default). Per-tier resolvers are `@Optional()`-injected so a graph that never reads a lane still boots.
- `EffectiveConfigService` (`effective-config/effective-config.service.ts`) — resolves the per-service SERVICE-LEVEL subset the Python pull clients consume (`GET /api/v1/internal/effective-config?service=<name>`): retention + concurrency ceilings and `AiRuntimeProfile` rows, NEVER per-request model choice (Text stays a stateless gateway — §2.8). A control-plane read FAILURE is not an endpoint failure: it degrades to `env-fallback` with a null value so the client keeps its bootstrap value and behaves exactly as the pre-control-plane env-driven service; logged once per read.

**BYO provider credentials — `AiProviderConnectionService`.** Owns WHERE a serving provider lives and HOW to authenticate, replacing per-service env config. Two privilege boundaries, BOTH **403** (rules about the caller's OWN tenant, not the 404-over-403 cross-tenant posture): a SYSTEM row is writable only by a super admin (`isSuperAdmin`); a TENANT row is permitted only for a cloud BYO provider (`isCloudByoProvider` — azure/bedrock), never a self-hosted engine endpoint (platform infrastructure). Secret handling:

- The `apiKey` is **write-only**: it travels through `encryptSecretField` (Vault Transit) exclusively — there is NO plaintext-at-rest fallback, so a key write is REJECTED (`BadRequestException`) when `SecretsService` is absent (`SECRETS_PROVIDER≠vault`), and a Transit outage maps to **`503 Service Unavailable`** (retryable), never a 500. No read path — and no route — ever returns the ciphertext; the update sys-event records THAT a key rotated (`connection-key-rotated`), never the key. (The `TenantTtsConfigService.setCredential` this pattern came from is gone — TASK-879 folded the TTS credentials into this very service and TASK-888 dropped the model.)
- **OCC-before-encryption ordering.** The compare-and-set verdict is decided against the just-read row BEFORE any Vault call: a create is `expectedVersion === 0` against no row; an update fast-fails 412 when `dto.expectedVersion !== existing.version`. Encrypt ONLY after the precondition passes, and only when the caller actually supplied a key (omitting `apiKey` leaves the stored ciphertext untouched — rotate vs. edit-other-fields). Encrypting first turned a stale-`If-Match` 412 into a 500 whenever Transit was down; `updateWithVersion` remains the atomic backstop for races.

---

## 2. Python service patterns (`apps/stt`, `apps/text`, `apps/guardrail`, `apps/nlp`, `apps/harness`, `apps/tts`)

### 2.1 Layout and packaging

All services are PEP-621 `pyproject.toml` + setuptools, `src/<package_name>/` layout: `stt`, `text`, `guardrail`, `nlp`, `harness`. Standard internal structure (verified in text/harness): `main.py` (FastAPI `create_app()` factory + `lifespan` context manager), `core/` (`config.py`, `logging.py`, plus service-specific), `api/endpoints/` (+ `api/middleware/` in text), `services/`, `models/`. Tests live either in `src/<pkg>/tests/` (text, guardrail, harness) or a top-level `tests/` (stt, nlp) — see `testpaths` in each `pyproject.toml`.

### 2.2 Config / env handling

pydantic-settings `BaseSettings` classes with per-concern `env_prefix` (verified `apps/harness/src/harness/core/config.py`, `apps/text/src/text/core/config.py`): `HARNESS_`, `TEMPORAL_`, `HARNESS_SAFETY_`, `TEXT_`, `TEXT_OLLAMA_`, `TEXT_AZURE_`, `TEXT_BEDROCK_`, etc. Singleton accessor `get_settings()`; settings are attached to `app.state.settings`. Secrets are `SecretStr` (e.g. `service_token`). Structured logging via `structlog` with event names like `"harness.temporal_connected"`.

### 2.3 Environments: conda `arcaenv` + uv workspace

- Local dev/tests run inside the single shared conda env `arcaenv` (Python 3.11) — created by `scripts/setup-python-env.sh` (`CONDA_ENV_NAME="arcaenv"`); every root `<svc>:*` script wraps commands in `conda run -n arcaenv --no-capture-output ...` (the old `py:*` spelling no longer exists — the taxonomy is `<target>:<action>`, §5.9); `scripts/dev-service.sh` does the same for dev servers.
- Dependency resolution is owned by the uv WORKSPACE at the repo root: `pyproject.toml` declares `[tool.uv.workspace] members = [apps/guardrail, apps/nlp, apps/text, apps/harness, apps/stt, apps/tts, packages/py-runtime-models, packages/py-env, packages/py-otel, packages/py-async-contract]` with ONE `uv.lock`, so all services resolve identical versions. Docker builds use `uv sync --frozen --package <svc>`. Regenerate with `uv lock` after changing any member's dependencies. stt's `ml`/`ml-gpu` vs `nemo` extras are declared as uv conflicts.

### 2.4 pytest layout and markers

Uniform `[tool.pytest.ini_options]` across services: `minversion = "9.0"`, `addopts` with `-ra --strict-config --strict-markers` (text/guardrail add `--cov`; text also deselects `-m "not e2e"` by default), `python_files = ["test_*.py", "*_test.py"]`, `asyncio_mode = "auto"`. Markers: text/nlp define `e2e`; stt defines `unit` / `integration` (+ more). Tooling is ruff (lint, incl. import sorting — isort is NOT used), black (format, line length 100), mypy (strict-ish, per-service config). Run through root scripts: `pnpm <svc>:test|lint|format|typecheck` where `<svc>` ∈ `stt text nlp guardrail harness tts` (plus the shared Python packages `py-env`, `py-otel`). Aggregates: `pnpm test:py`, `lint:py`, `format:py`, `typecheck:py`.

### 2.5 Gateway registration / authentication

Python services do not self-register; `apps/api` fronts them (proxy/gateway 1.6) and resolves their URLs via `IConfigService` (`STT_URL` :8861, `TEXT_URL` :8862, `GUARDRAIL_URL` :8863, `NLP_URL` :8864, `HARNESS_URL` :8866). Inbound auth on the Python side is a shared-secret header validated with constant-time compare; empty token = dev-mode bypass; health/docs/metrics paths exempt:

```32:47:apps/text/src/text/api/middleware/auth.py
class ServiceAuthMiddleware(BaseHTTPMiddleware):
    """Require a valid X-Service-Token for non-exempt endpoints."""

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        service_token: str = request.app.state.settings.service_token.get_secret_value()

        if not service_token:
            return await call_next(request)

        if request.url.path in EXEMPT_PATHS:
            return await call_next(request)

        provided = request.headers.get("X-Service-Token", "")
        if not provided or not hmac.compare_digest(provided, service_token):
```

The gateway injects the token from `SecretsService` in `BaseProxyController` subclasses. Every service exposes `GET /api/v1/health` (+ live/ready variants) and `/metrics` (Prometheus).

### 2.6 Streaming patterns

- WS: STT streaming endpoints in `apps/stt/src/stt/streaming/api/routes.py`; the NestJS side bridges via `apps/api/src/modules/streaming/stt-ws.gateway.ts` (path `/ws/stt/stream`).
- SSE: Text streams LLM chunks over Server-Sent Events backed by Redis Streams with resume support — `apps/text/src/text/api/endpoints/stream.py` uses `sse_starlette.sse.EventSourceResponse` and includes the Redis message id in each event for resumption. On the gateway side, SSE routes are guarded by `TenantOwnedResourceSseGuard` (see 1.6).

### 2.7 Temporal (harness)

`apps/harness` runs the bounded "guides → generate → sensors → gate" loop as a Temporal durable workflow. Layout: `apps/harness/src/harness/temporal/` with `workflows.py` (`@workflow.defn` classes), `activities.py` (`@activity.defn` functions), `client.py` (`get_temporal_client(settings)`), `worker.py` (separate process, started via `pnpm worker:dev`), `models.py` (dataclass payloads). Temporal config via `TemporalConfig(BaseSettings)` with `env_prefix="TEMPORAL_"` (address/namespace/task-queue). The FastAPI app connects best-effort in `lifespan` and must come up even when Temporal is down (`apps/harness/src/harness/main.py`); only the worker hard-requires Temporal.

### 2.8 tts — stateless service, gateway-resolved per-tenant config

`apps/tts` (`tts`, port 8865) is a multi-provider text-to-speech service (Azure Speech + local Kokoro / Indic Parler, en+ml) that follows the same FastAPI + `create_app()`/`lifespan`, pydantic-settings, `X-Service-Token`, health and `/metrics` conventions as the other services (2.1–2.5). Root settings use the `TTS_` prefix; each provider sub-config carries its own (`TTS_AZURE_`, `TTS_KOKORO_`, `TTS_PARLER_`), with the Azure credential aliased (`AliasChoices`) to the shared `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION` already used by stt (same Azure Speech resource).

The service is STATELESS with respect to tenancy — it holds no per-tenant configuration. The gateway resolves a tenant's TTS spec and BYO credentials and injects them PER REQUEST: the speech request body (`apps/tts/src/tts/api/endpoints/speech.py`) carries gateway-injected `provider_overrides` (decrypted per-tenant BYO provider credentials) and `voice_bindings` (per-request voice-binding overrides, gateway-resolved from the tenant's config). The gateway side is `TtsAgentResolverService` (TASK-879: it resolves the tenant's TEXT_TO_SPEECH agent and builds a `ResolvedTtsSpec`) plus `AiProviderConnectionService`'s credential fold, consumed by the speech proxy controller and the TTS WS gateway (`apps/api/src/modules/speech/`); unlike the `TenantTtsConfig` fold it replaced, a resolution failure there FAILS the request rather than degrading onto a substituted vendor. This mirrors the Text stateless-gateway contract — the service performs the inference, the control plane lives in the DB behind the gateway.

### 2.9 Model lifecycle & retention (`hope-runtime-models` + control-plane pull)

The in-process Python services share ONE model-lifecycle contract, `packages/py-runtime-models` (`hope_runtime_models`) — a uv-workspace member depended on by stt, guardrail, nlp, harness and tts. It is a contract, not a framework: one policy engine plus the two optional hooks it needs. Two concurrency skins, one policy: `ModelCache` (asyncio) and `SyncModelCache` (threads) both derive from a private `_CacheCore`, so the eviction order (`ttl → lru → vram`, every eviction reason-labelled), pin refcounts, the all-pinned soft ceiling (the cache deliberately exceeds `max_size` rather than drop a model serving a request), `CacheStats` and metric labels are shared code and cannot drift. Service-specific concerns (the stt format→loader map, the tts pipeline handles, the harness llama handle) stay in their services and are passed in as `factory`/`unload` callables. Each contract clause (single-flight per key, eviction order, pins-never-evicted-except-`clear()`, soft ceiling, monotonic injectable clock, the hard product clamp `clamp_cache_ttl_seconds` ∈ [60, 3600]) has a conformance test parameterized over BOTH cache classes.

Retention is admin-controlled through the control plane, NOT env. Each service's `<svc>.modelCache.{ttlSeconds,maxModels,vramBudgetMb}` (stt also `maxMemoryMb`) are registry descriptors (`settings-registry/descriptors/service-runtime.descriptors.ts` — all `global-kv` + `globalOnly` + `system`-scoped, never tenant-set) served over `GET /api/v1/internal/effective-config` (§1.8, `EffectiveConfigService`). The Python pull client (`<svc>/core/effective_config.py`, duplicated per service by design — factoring it out is a deferred owner decision) is a read-triggered TTL cache (60 s, ±10 % jitter) with a NEGATIVE cache (a fetch error caches the empty result for a full window) and single-flight refresh, so an unreachable gateway costs at most one attempt per window and the service falls back to its own env/pydantic default — "gateway down" behaves exactly like the pre-control-plane env-driven service. Every descriptor `default` is transcribed verbatim from the consuming service's own fallback, so cataloging a knob changes zero behaviour. TEXT is deliberately special: it holds no weights, so `text.modelCache.ttlSeconds` is a per-request retention HINT forwarded to server-managed engines (Ollama `keep_alive`, LM Studio `ttl`), not a cache bound (`apps/text/src/text/core/retention.py`; TEXT is absent from `MODEL_CACHE_SERVICES`). Separately, the applications layer runs control-plane retention services for DATA (not models) — `AuditRetentionService` and `AgentTrajectoryRetentionService` (`packages/applications/src/services/{audit,agent-trajectory}-retention/`): self-scheduling cron jobs that read DB-backed config and default OFF because they hard-delete.

---

## 3. Frontend patterns

`apps/ui-playground` and `apps/admin` were both removed; cite `packages/ui` and `packages/agentic-sdk-v2` as the exemplars. `apps/example` is a standalone raw-WebSocket live-transcription demo — deliberately NOT an SDK consumer (see `apps/example/README.md`).

### 3.1 `packages/ui` component conventions

- File layout: `src/components/shadcn/` (base primitives, one file per component, kebab-case), `components/custom/`, `components/registries/` (third-party collections), `components/blocks|collection|data-grid|editor|elevenlabs|live-transcript|metrics|timeline|shared`, plus `hooks/`, `lib/`, `styles/`, `contexts/`, `types/`.
- Component pattern (verified `packages/ui/src/components/shadcn/button.tsx`): plain function components (React 19 — NO `forwardRef`), props typed as `React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>`, `cva` for variants with `defaultVariants`, `asChild` polymorphism via `Slot.Root` from the consolidated `radix-ui` package, `data-slot` / `data-variant` attributes for styling hooks, and `cn()` from `packages/ui/src/lib/utils.ts` for class merging.
- Exports: subpath exports in `packages/ui/package.json` (`"."`, `"./components/shared"`, `"./components/metrics"`, `"./styles.css"`, ...) built with tsup + the Tailwind CLI.
- Do: extend shadcn primitives with new cva variants. Don't: fork primitives, hardcode colors (use the semantic CSS variables), or use any non-shadcn UI kit.

### 3.2 Tailwind v4

CSS-first configuration. The single token source is `packages/ui/src/styles/globals.css`: `@import "tailwindcss"`, `@custom-variant dark (&:is(.dark *))`, and the HOPE "Calm Clinical Teal" design tokens as CSS variables (brand ramps + semantic roles incl. `--ai/--hope/--success/--warning/--info`). `packages/config-tailwind/tailwind.config.ts` is effectively an empty shared shell (v4 no longer needs a JS config); do not add theme config there — add tokens to `globals.css`.

### 3.3 Zustand in `@arcaai/vox` (`packages/agentic-sdk-v2`)

Single internal vanilla store: `packages/agentic-sdk-v2/src/store/agenticStore.ts` uses `createStore` from `zustand/vanilla` + `useStore` with a React context — the store is NOT exported publicly; consumers use the hook layer (`packages/agentic-sdk-v2/src/hooks/` — `useArca.ts`, `useArcaAudio.ts`, `useArcaSession.ts`, `useConsultationChain.ts`, ~30 hooks). Core managers (AgenticClient, PluginManager, ConfigManager, ModelRegistry) live in `src/core/`. Do: add SDK state to the store and expose it via a hook. Don't: export the store or write to it from app code.

### 3.4 React 19 idioms in use

- No `forwardRef` — refs are ordinary props via `React.ComponentProps<...>` spreading (all of `components/shadcn/`).
- Types pinned via pnpm overrides: `@types/react ^19.2.14` (root `package.json`).
- jsdom-based Vitest environment for browser packages (root `vitest.config.ts` `environmentMatchGlobs`).

### 3.5 Admin data grids (standard)

Every list/table surface in `apps/admin-console` uses `VirtualizedDataGrid` (`packages/ui/src/components/data-grid`; TanStack Table v8 + Virtual + dnd-kit). The legacy `DataTable`/`TablePagination` were removed; only non-list displays (hierarchy trees, comparison/cascade matrices) use the raw shadcn `Table`, and `FilterBar` remains only as a standalone control over non-grid sources.

- **Full-page lists**: wrap with `AdminDataGrid` + `useAdminGridParams` (`apps/admin-console/src/shared/data`) — URL query-state via nuqs (`grid-url-state.ts`; typed filters serialized into a compact `f` param and emitted to the backend as the bracket grammar), envelope normalization (`envelopes.ts#normalizeList`, 6 shapes incl. cursor), and server-persisted layout.
- **Embedded / master-detail lists**: use `VirtualizedDataGrid` directly at a fixed `height` and pass `persistence={gridPersistence('<gridId>')}`.
- **Personalization is mandatory for real lists**: column order/size/visibility/pinning + density persist per-user in `UserSettings` under namespace `ui.data-grid/<gridId>` via `GET`/`PATCH user/me/settings` (`grid-persistence.ts` — a single shared `sharedGridLayoutPersistence` adapter, 16 KB-guarded, best-effort, settings GET deduped + cached 30 s so N grids on a page share one request ; first paint gated on `isLayoutReady`). Only genuinely small fixed detail-tab/utility tables may leave the `column*` features off.
- Do: give every grid a stable `gridId` and set column `meta` (`variant`, `options`) for typed filters. Don't: reintroduce `DataTable`, or read/write `UserSettings` grid keys outside the shared adapter.

### 3.6 Admin screen template (standard)

Every screen in `apps/admin-console` composes ONE standardized page frame — `ScreenTemplate` (`apps/admin-console/src/shared/page/screen-template.tsx`, Figma "09 - Screen Templates") — instead of hand-rolling a flex column. It fills the shell content region as a fixed-height flex column so only the content scrolls; pinned regions are `shrink-0` flex rows (no `position: sticky`, so they never obscure focus).

- **Region contract** (top → bottom): pinned top in priority order `header` (title + actions; breadcrumbs stay in the shell topbar) → `stats` → `statusBanner` → `toolbar` → `tabs`; full-width content (main / charts / tab panels / data grid); pinned bottom `footer` — an IDE-style status bar (`StatusFooter`, `…/shared/page/status-footer.tsx`).
- **Content modes**: `contentMode="fill"` hands the height to a fill-height `AdminDataGrid` (sticky header, scrolling body, pagination pinned directly above the footer); `contentMode="scroll"` (default) scrolls content/detail/dashboard pages between the pinned top group and footer. Never nest a second scroll area inside `fill`.
- Grid pages carry their toolbar INSIDE the grid (not the `toolbar` slot). Tabs: wrap the template in `<Tabs>`, pass `<TabsList variant="line">` (underline — the standard, not the bare `<TabsList>` pill default) to `tabs` and the `<TabsContent>` panels as `children`.
- Do: wrap every screen (list, detail, dashboard) in `ScreenTemplate`. Don't: reintroduce ad-hoc `<div className="flex … flex-col gap-4">` page frames or let the header/toolbar scroll away. See `11-ux-ui-principles.mdc` §Screen Template.

### 3.7 Admin redesign foundation

Shared layout/interaction infrastructure consumed by the redesigned screens. Data contracts, permission gates and OCC behaviour are unchanged.

- **Detail surface** — `DetailDrawer` (`apps/admin-console/src/shared/detail/detail-drawer.tsx`, on `@arcaai/ui` `Sheet`) is the ONE console-wide record detail/edit surface: right slide-over on desktop, full-screen sheet below `md` (~768px). Header (title · badges · close) → meta line → optional tabs → scrollable body → pinned footer. Retires per-feature hand-rolled Sheets; dialogs stay for short confirmations + break-glass only. Tabs: wrap in `<Tabs>` and pass `<TabsList variant="line">` as `tabs`, `<TabsContent>` as `children`.
- **Code editor** — `CodeEditor` + helpers `formatJson`/`validateJson`/`tokenizeJson` (`@arcaai/ui`, `src/lib/json-editor.ts`). Transparent `<textarea>` over a synchronously-highlighted `<pre>` (no async highlighter) on a FIXED dark surface (`--code-editor-*` tokens) in both themes; line numbers, Format, live line/column validation, Copy. Use it wherever JSON/array values are edited instead of a bare `Textarea`.
- **Tenant-scope banner** — `TenantScopeBanner` (`apps/admin-console/src/shared/tenant-scope/tenant-scope-banner.tsx`): info-tinted "Acting on «tenant»" strip for the `ScreenTemplate` `statusBanner` slot on tenant-scoped (tier 30–49) pages; renders null with no working tenant. Passive (no action) — distinct from the global warning-tinted `WorkingTenantBanner` (frame 07) that owns the clear-tenant control.
- **Accent themes** — `data-accent="indigo" | "green" | "amber"` on `<html>` remaps accent-derived tokens from the raw ramps (teal = attribute-less default); `packages/ui/src/styles/globals.css`. No console wiring by default (tenant/brand theming is a follow-up). See `packages/ui/README.md` §Accent themes.
- **Responsive tiers** — `useViewportTier()` (`apps/admin-console/src/shared/layout/use-viewport-tier.ts`) → `'desktop' | 'tablet' | 'mobile'` at 1280/768 (`matchMedia`, SSR-safe defaulting to desktop). `SidebarTierSync` defaults the sidebar to the icon rail on the tablet tier (user toggle wins for the session).

---

## 4. Testing standards

### 4.1 Vitest unit tests

- Placement: colocated `__tests__/` folders (`packages/applications/src/services/department/__tests__/`, `packages/domains/src/entities/__tests__/`, `apps/api/src/modules/*/__tests__/`) OR sibling `*.test.ts` (e.g. `packages/applications/src/common/applyChangesToEntity.test.ts`). Naming: `*.test.ts` (unit), `.spec.ts` matched too per root config.
- Root config `vitest.config.ts`: `globals: true`, node env with jsdom via `environmentMatchGlobs` for browser packages, setup `tests/setup/vitest.setup.ts`, istanbul coverage, `@arcaai/applications` aliased to source to avoid dist races. Run: `pnpm test:unit` (wraps with `dotenv -e .env.test`).
- Special suites excluded from unit runs: `**/pgbouncer-validation/**` (own runner `pnpm pgbv:test`) and `**/*.postgres.test.ts` (live-Postgres guard).

### 4.2 Integration tests

`vitest.integration.config.ts`: only `**/integration/**/*.test.ts`, sequential (`pool: 'forks'`, `fileParallelism: false`, `isolate: false`), 60 s timeouts, setup `tests/setup/integration.setup.ts`, `@arcaai/database`/`@arcaai/domains` aliased to source. Real infra (Postgres 5433, Redis 6380, MinIO 9002) comes from `pnpm infra:test:up` / `tests/docker-compose.test.yml`. Example: `packages/domains/src/integration/repository-soft-delete.integration.test.ts`.

### 4.3 Playwright E2E

Root `playwright.config.ts`: `testDir: './apps/api/tests/e2e'`, pattern `**/*.spec.ts`, baseURL `http://localhost:8868/api/v1`, global setup/teardown in `tests/setup/playwright.global-setup.ts` / `.global-teardown.ts`, CI detection parses `CI=true|1` (string "false" is NOT CI). E2E specs are API-level (auth, rbac, cross-tenant, optimistic-locking — e.g. `apps/api/tests/e2e/rbac.spec.ts`, `apps/api/tests/e2e/optimistic-locking.spec.ts`). Note the naming split: e2e uses `.spec.ts`, unit tests use `.test.ts`.

### 4.4 Contract and cross-tenant tests

- Contract tests: `tests/contracts/*.contract.test.ts` validate gateway↔Python request/response shapes against shared zod schemas in `tests/contracts/schemas.ts` (e.g. `tests/contracts/stt.contract.test.ts`).
- Cross-tenant tests: `tests/cross-tenant/` (fixtures in `tests/cross-tenant/fixtures.ts`) plus a coverage meta-test `packages/applications/src/__tests__/cross-tenant-coverage.test.ts`; dedicated e2e cross-tenant specs exist per feature (`apps/api/tests/e2e/*cross-tenant*.spec.ts`, 21 of them — the glob names the CONVENTION because the former `task-307-*` form matched nothing once those specs were renamed).
- Shared helpers/fixtures: `tests/helpers/` (`api.helper.ts`, `auth.helper.ts`, `db.helper.ts`, `e2e.helper.ts`) and `tests/fixtures/` (`tenants.fixture.ts`, `users.fixture.ts`, `roles.fixture.ts`).

### 4.5 Python tests

See 2.4. Run per service: `pnpm stt:test[:unit|:integration|:e2e|:cov]`, `pnpm text:test[:unit|:integration|:e2e|:cov]`, `pnpm nlp:test[:cov]`, `pnpm guardrail:test[:cov]`, `pnpm harness:test[:unit|:integration|:cov]`, `pnpm tts:test[:unit|:cov]` — all via conda `arcaenv`. `pnpm test:py` runs every Python suite (including `py-env` and `py-otel`); `pnpm <svc>:test:managed` runs one suite through `scripts/test-run.sh` (infra up → suite → teardown of only what it started).

### 4.6 TDD expectation

Service unit tests mock repositories + `EventEmitter2` + `ClsService` and assert factory usage and `broadcastSysEvent` calls (see `packages/applications/src/services/webhook/__tests__/webhook.service.test.ts` and the `department/__tests__/` suite). The workflow expectation (docs + observed test-first tickets): failing test → minimal code → refactor; behavior-focused tests; evidence (test output) required before claiming done.

---

## 5. Tooling / process

### 5.1 Turborepo (`turbo.json`)

- `build` depends on `^build` + `^db:generate`, and `cache: false` (builds are deliberately uncached; note this when reasoning about CI time). `@arcaai/database#build` additionally depends on its own `db:generate`.
- `dev` / `dev:watch` are persistent + uncached; `test` depends on `build`; `lint` depends on `^build`. DB tasks (`db:push`, `db:migrate`, `seed`) are uncached and chained to `db:generate`.
- `globalEnv` whitelists runtime env (DATABASE_URL, downstream service URLs, Temporal, Redis, OTEL, Vault keys, ...). Add new env vars here when tasks depend on them.

### 5.2 pnpm workspace

`pnpm-workspace.yaml`: `apps/*` (with `!apps/quick-compat-app` deliberately excluded — that demo installs `@arcaai/vox` from the registry and must depend on NO workspace package), `packages/*`, `packages/agentic-sdk-v2/examples/*`; `onlyBuiltDependencies` for Prisma packages; `overrides` pin `class-validator`, `react`/`react-dom` and the React 19 types. No catalog: feature is not used. Internal deps use `workspace:*`. Filters are the house style for scoping: `pnpm --filter @arcaai/database db:generate`, `turbo run build --filter=@arcaai/api...`.

### 5.3 ESLint

ESLint 9 flat config everywhere (admin-console runs ESLint 10 app-local against the same presets). Each package/app has an `eslint.config.mjs` spreading a surface preset from `packages/config-eslint/flat/` (`core.js` foundation + `library.js` / `nestjs.js` / `next.js` / `react-library.js`; `prettier-base.js` is the shared Prettier config, not an ESLint preset); custom rules in `packages/eslint-plugin-arcaai-internal/`. The legacy `.eslintrc.js` estate and the `ESLINT_USE_FLAT_CONFIG=false` escape are gone — do not reintroduce eslintrc-format configs. Architecture rules: see 1.7.

### 5.4 Prettier

Root `.prettierrc.js` extends `packages/config-eslint/prettier-base.js`: `singleQuote: true`, `printWidth: 150`, `tabWidth: 2`. Enforced through `eslint-plugin-prettier/recommended` in the flat core config (violations surface as lint warnings) and `pnpm format`.

### 5.5 GitLab CI (`.gitlab-ci.yml` + `.gitlab/ci/*.yml`)

Stages: `install → validate → prepare → test → build → scan → publish → deploy → notify`. Branch pipeline types: main (MR gates only), dev/staging (tests + manual builds + scan), `release-sdk`, `maintenance/*`. Enforced gates:

| Job (file)                                                                                                                    | Enforces                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `lint-ts` (`.gitlab/ci/validate.yml`)                                                                                         | `pnpm turbo lint` after `db:generate`                                                             |
| `typecheck` (validate.yml)                                                                                                    | builds database/exceptions/logger/... packages                                                    |
| `generate-data-model-check` / `generate-data-entity-check` / `generate-factory-check` (validate.yml)                          | generated domain layers must not drift from `@arcaai/tools` generator output                      |
| `lint-python` (validate.yml)                                                                                                  | ruff over stt, text, nlp, guardrail, harness                                                      |
| `env-drift-check` (validate.yml)                                                                                              | `.env.sample` / `turbo.json#globalEnv` / per-service samples stay in sync (`pnpm env:sync:check`) |
| `validate-release-tag` (validate.yml)                                                                                         | release tags match the `<SVC>-<M>.<m>.<p>` grammar                                                |
| `test-api`, `test-packages`, `test-sdk`, `test-admin-console`, `test-ui-ct` (`.gitlab/ci/test.yml`) | Vitest/Playwright suites. `test-compat-playground` is hidden.                          |
| `test-stt`, `test-text`, `test-tts`, `test-guardrail`, `test-nlp`, `test-harness`, `harness-eval-gate` (test.yml)             | pytest suites + the harness evaluation gate                                                       |
| `scan-gitleaks` (`.gitlab/ci/scan.yml`)                                                                                       | gitleaks v8.30.1 `detect` with `.gitleaks.toml`                                                   |
| `scan-*` (scan.yml)                                                                                                           | Trivy image scans per service                                                                     |

Docker images are versioned WITHOUT `latest` (semver tags + `sha-<sha8>`); skip switches `SKIP_TESTS`, `SKIP_TESTS_TS`, `SKIP_TESTS_PY` exist for manual runs.

### 5.6 Secret scanning

**There are no git hooks in this repo** — `simple-git-hooks` and the `pre-commit` entry were removed deliberately (verified 2026-08-19: root `package.json` has neither). Do not reintroduce them. `scripts/gitleaks-precommit.sh` remains runnable by hand (`gitleaks protect --staged --config .gitleaks.toml`, skips with a warning when gitleaks isn't installed), and the CI job `scan-gitleaks` (`.gitlab/ci/scan.yml`) is the enforcing gate. Config: `.gitleaks.toml` + `.gitleaksignore`.

### 5.7 Env file strategy — one contract, both languages

The contract is DECLARED ONCE in `packages/applications/src/common/env/env-file-resolution.ts` (dependency-free, so pre-bootstrap consumers can import it):

- **Precedence: host env > env file > schema default.** The file never overwrites a variable already in `process.env`.
- **One file per `NODE_ENV`** — `.env.dev` / `.env.test` / `.env.production`; **no `.env` fallback**. The root `.env` is docker-compose interpolation input, not application config, and `scripts/dev-infra.sh` generates `infrastructure/docker/.env` for that purpose.
- **No file at all when `CI` is truthy or `NODE_ENV=production`** — host env only.
- `.env.test` is loaded by dotenv-cli in the `test:*` scripts (isolated infra ports: Postgres 5433, Redis 6380, MinIO 9002) and, like `.env.dev`, is gitignored and generated (`pnpm setup:dev`/`pnpm setup:test` rebuild it from the consolidated `.env.sample`). Production reference templates live per-service as `apps/*/.env.prod`, not at the monorepo root — none are ever loaded by the app.

Consumers of the single declaration: `loadEnv()`, `apps/api/src/main.ts`, both `prisma.config.ts` files, and `@arcaai/tools`.

**The one sanctioned duplicate:** `packages/database/src/env.ts` mirrors the policy by hand because `@arcaai/applications` depends on `@arcaai/database` — importing the canonical module would be a circular package edge. It is pinned by `packages/database/src/__tests__/env.test.ts`; a contract change must be made in BOTH files. Note it runs at MODULE SCOPE, so importing `@arcaai/database` is what populates `process.env` first in `apps/api`.

**Python** reads the same file through `packages/py-env` (`hope_env`), with the same precedence and the same CI/production suppression — so a value changed only in `.env.dev` is observed by the gateway and by all six FastAPI services. Per-concern pydantic prefixes still apply (2.2).

Typed access on top: `IConfigService.getConfigValue(...)` (lint-enforced for downstream URLs) and `SecretsService` for secrets. Turbo caching declares env in `turbo.json#globalEnv`.

**What does NOT belong in an env file:** anything that must change without a process restart, and any credential that a running system should be able to rotate. Those are DB/Vault tiers — see `.claude/rules/09-infrastructure-devops.md` §Configuration Tiers for the seven-tier taxonomy, `failMode`, and the two config-cache rules (tenant-keyed keys; invalidation over TTL).

### 5.8 Vault

Local dev Vault runs in Docker (`hope-vault`); `scripts/refresh-vault-creds.sh` mints a RAW AppRole secret_id and rewrites `VAULT_ROLE_ID`/`VAULT_SECRET_ID` in `.env.dev` (raw = dev, reusable across watch-mode restarts; response-WRAPPED secret_id = production, single-use per pod). `SecretsService` warms its cache in `SecretsModule.forRoot` before dependent providers construct (`apps/api/src/main.ts` commentary); bootstrap refuses to start if `JWT_SECRET_KEY` is a placeholder. `SECRETS_PROVIDER` env selects env-mode vs vault-mode; the vault-backed Prisma client wiring lives in `apps/api/src/vault-prisma.module.ts`. Operations docs: `docs/operations/vault/README.md`.

### 5.9 Root script taxonomy — no legacy aliases survive

Every root `package.json` script follows one of three shapes. A command that does not match one of them does not exist — check before citing it.

| Shape                     | Meaning                              | Examples                                                                             |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| `<target>:<action>`       | one app / service / worker / package | `api:dev`, `stt:test:cov`, `harness:lint`, `worker:dev`, `admin:build`               |
| `<domain>:<action>`       | cross-cutting concern                | `db:migrate`, `gen:model`, `build:apps`, `lint:all`, `clean:cache`, `env:sync`       |
| `<domain>:<env>:<action>` | concern split by environment         | `infra:dev:up`, `infra:test:validate`, `stack:dev:doctor`, `setup:dev:observability` |

Targets: `api`, `admin`, `ui`, `sdk`, `sdk-node`, `sdk-codegen`, `compat`, `stt`, `text`, `nlp`, `guardrail`, `harness`, `tts`, `worker`, `py-env`, `py-otel`. Per-workspace spellings are fixed: `typecheck` (never `type-check`/`check-types`) and `test:cov` (never `test:coverage`); a `lint` script must never carry `--fix` (that belongs in `lint:fix`). Aggregates that must stay green: `pnpm lint:all`, `typecheck:all`, `format:all`, and `pnpm verify` (= `lint:all && typecheck:all && test`). Full command reference: [development-guide.md](./development-guide.md) and [scripts/README.md](../scripts/README.md).

Two commands are deliberately hazardous and must never be run casually: `pnpm gen:mapper` (destructive — strips the `_version` OCC guard) and `pnpm gen:repository` (broken); both now route through `scripts/gen-guard.sh`, which refuses to run on a dirty tree and demands a typed confirmation. `pnpm db:all` force-resets the dev database.

---

---

## 6. Cross-cutting integrity standards

### 6.1 Multi-tenancy enforcement points (defence-in-depth, in order)

1. `UnifiedAuthGuard` resolves the caller and populates CLS (`tenantId`, `user`) — `packages/applications/src/authorization/unified-auth.guard.ts`, registered as global `APP_GUARD`.
2. Controllers gate with `@CanXxx`/`@Authorize`; some also require tenant context explicitly for list endpoints (see `department.controller.ts#fetchAll`).
3. Services verify ownership on every by-id mutation — tenant mismatch throws `NotFoundException` ("not found", never "forbidden") to avoid existence leaks; helpers in `packages/applications/src/common/tenant-guards.ts` (`assertParentInScope` for parent references).
4. The Prisma tenant-scope extension injects `tenantId` into reads/writes of `TENANT_SCOPED_MODELS` from the CLS provider (`packages/database/src/extensions/tenant-scope.ts`); SUPER_ADMIN bypasses; SYSTEM-shared catalogs widen reads only.
5. SSE-specific ownership guard `TenantOwnedResourceSseGuard` re-runs assertions before the stream opens (`apps/api/src/app.module.ts`).
6. Cross-tenant e2e suites lock the 404 contracts (`apps/api/tests/e2e/*cross-tenant*.spec.ts`).

**Deliberate 403 privilege walls — a DIFFERENT axis from the 404 posture (verified 2026-07-21).** The 404-over-403 rule above hides _whether a resource exists in another tenant_. It does NOT apply to _privilege_ — a caller who legitimately owns a resource for most operations but lacks the standing for one specific action gets a genuine **403 `ForbiddenException`**, because concealing the action would be nonsensical (the caller can already read it). These 403s are enforced IMPERATIVELY in the service, because the CASL permission decorators express only `action + subject` and cannot express "super-admins only" or "the row's owner only". On such routes the declarative decorator UNDERSTATES the real gate, so each carries a mandatory `// AUTH-NOTE:` marker at the handler (rule 05; two live markers, both in `apps/api/src/modules/prompt-management/`). Two shapes:

- **Super-admin-only action on a tenant-manageable resource.** Tenant admins hold `manage` on the resource for every _other_ operation, but one action is platform governance. Enforcement points (all raise 403 via `isSuperAdmin`, `packages/applications/src/common/tenant-guards.ts`):
  - Prompt approval — `POST admin/prompt-templates/:id/approve` inherits only the class-level `@Authorize(['manage','PromptTemplate'])` (satisfying the deny-by-default boot audit) and adds the super-admin restriction imperatively via `isSuperAdmin` (`packages/applications/src/services/prompt-management/prompt-management.service.ts:427`; AUTH-NOTE at `apps/api/src/modules/prompt-management/prompt-management.controller.ts:310`); the decorator alone would let a tenant admin approve.
  - AI task defaults — `SUPER_ADMIN_ONLY_TASK_PREFIXES = ['nlp.', 'harness.']` (`packages/applications/src/services/ai-task-default/constants.ts`); a write to any task key under these prefixes is refused for non-super-admins (`ai-task-default.service.ts`).
  - Harness policy — `SUPER_ADMIN_ONLY_POLICY_KEYS` (safety/TEXT provider+model, the loop feature toggles, `phiFailClosed`, `mcpToolsEnabled`, …) in `packages/applications/src/services/harness-policy/harness-policy.service.ts:127`; this same list also drives the SYSTEM overlay in `getEffectivePolicy`, so a pre-existing tenant row carrying one of these keys is neutralised at READ time (ignored, not deleted).
  - Pipeline policy — the `globalOnly` descriptor lock: any `pipeline.*` toggle whose `HOPE_SETTINGS_REGISTRY` descriptor is `globalOnly: true` is 403 for non-super-admins (`packages/applications/src/services/pipeline-policy/pipeline-policy.service.ts:439`) — adding `globalOnly` to a descriptor is the only edit needed to govern a toggle.
  - Global-KV settings — `SettingsRegistryWriteService` refuses `globalOnly && !isSuperAdmin` with 403 (§1.8).
  - MCP server registry — all writes stay super-admin-only in the service (`packages/applications/src/services/mcp-server/mcp-server-admin.service.ts:162`), since MCP tool calls cross the platform boundary.
  - BYO provider connections — a SYSTEM `AiProviderConnection` row is writable only by a super admin (§1.8).
- **Owner-scoped self-service write declared with `read`.** Personal (`USER_PERSONAL`) prompt-template writes are declared `@Authorize(['read','PromptTemplate'])` — `read` is the ability clinicians actually hold — with ownership enforced in the service (non-personal or non-owned → 403, cross-tenant id → 404); requiring `create`/`update` would lock authors out of their own rows (`apps/api/src/modules/prompt-management/prompt-template.controller.ts:80` AUTH-NOTE).

Never widen or "simplify" one of these routes without reading the service first: the decorator is intentionally weaker than the enforced gate. And a cross-tenant id on any of them is still **404** via the ownership check — the privilege 403 fires only for the caller's OWN in-scope resource.

### 6.2 Soft-delete policy

Soft delete is the default everywhere: `repository.softDelete(id)` sets `resourceStatus: DELETED` and bumps `_version`; the client extension filters `DELETED` out of every read unless the caller explicitly sets `resourceStatus` in the where clause. Exceptions are explicit and centrally listed (`MODELS_WITHOUT_SOFT_DELETE` in `packages/database/src/client.ts`): version-history tables, usage records, `TranscriptionJob` (own status enum), WORM audit tables (`HarnessAuditEvent` — migration REVOKEs UPDATE/DELETE). Don't hard-delete; don't add a model with `resourceStatus` semantics without the standard three columns.

### 6.3 Audit / sys-events

Every service mutation broadcasts a `SysEventType` event (1.5); `SysEventService` fans out to BullMQ jobs: audit-log persistence (`AuditLog` model, `packages/database/src/prisma/db_main/audit.prisma`), user-activity stamping, webhooks. Reads are only audited with `forceAuditLog: true`. Append-only/WORM history uses dedicated `*Change` / `*AuditEvent` tables (`HarnessPolicyChange`, `AgentAssignmentChange`, `HarnessAuditEvent`; `PipelinePolicyChange` went with `PipelinePolicy` in TASK-882). AuditLog payloads are envelope-encrypted (`packages/domains/src/repositories/generated/core/AuditLogRepository.encryption.ts`).

### 6.4 Validation at boundaries

- HTTP boundary: global `ValidationPipe` with `whitelist + forbidNonWhitelisted + forbidUnknownValues + transform` — every accepted field MUST be declared on a DTO with class-validator decorators.
- Config boundary: env is loaded+validated once at bootstrap (`IConfigService`; `APP_SETTINGS_BOOT_INVARIANT` in `turbo.json#globalEnv`); direct `process.env` reads of downstream URLs are lint-banned.
- Contract boundary: zod schemas in `tests/contracts/schemas.ts` pin the gateway↔Python shapes.
- Domain boundary: `entity.validate()` + factory defaults.

### 6.5 ID conventions

UUIDs everywhere. New rows: UUIDv7 via `generateId()` (`packages/domains/src/utils/generateId.ts`, `uuidv7` package) — time-sortable, used as the keyset-pagination tiebreaker. Prisma default `uuid(7)` covers rows created outside factories. Reserved seed UUID prefixes: `00000000-…` SYSTEM tenant, `50000000-…` default tenant, `60000000-…` system user (also the schema-level `createdBy` default), `70000000-…` API keys.

### 6.6 Date/time handling

DB: `DateTime` columns with `@default(now())` / `@updatedAt`, UTC. Domain/services: plain `Date` objects (`const now = new Date()` in factories). Response DTOs: ISO strings (`createdAt: string` in `department.response.ts`). Metrics bucketing is explicitly UTC (`startOfUtcDay`/`endOfUtcDay` helpers in `packages/applications/src/services/consultation/consultation/consultation.service.ts`). Don't introduce moment/dayjs on the backend; `date-fns` is used in the UI layer.

### 6.7 Pagination conventions

Two sanctioned shapes:

- Offset: `PaginatedQuery` (`packages/applications/src/common/dto/paginated.query.ts`) — `page` (0-based), `limit`, `search`, `searchFields`, `filters` (bracket grammar: `field[op]:value` tokens joined by `;`; ops such as `eq`/`ne`/`gte`/`lte`/`contains`/`icontains`/`in`/`notIn`/`isNull`, with `|` separating `in`/`notIn` list members — a bare `field:value` without an operator is silently ignored), `sort` (`name:asc,...`), converted via `withFormattedPaginatedProps`/`withFormattedCountProps` (`packages/applications/src/common/paginatedQueryParamConverters.ts`), returned as `PaginatedResponse` built from `FetchResponse` via the DTO mapper's `ToPaginatedResponse`.
- Cursor/keyset (opt-in, for large tables): `packages/applications/src/common/cursorPagination.ts` — opaque base64url token of `(sortKey, uuidv7 id)`, hard page cap, `hasMore` detection.

### 6.8 Optimistic concurrency (house pattern)

Every admin PATCH on versioned resources: client reads `_version` (rendered as strong `ETag` by `ETagInterceptor`) → sends `If-Match` (required by `@RequiresIfMatch()`, else 428) → `@ExpectedVersion()` extracts it (header overrides body `expectedVersion`) → service calls `repository.updateWithVersion(id, entity, expectedVersion)` → drift throws `OptimisticConcurrencyException` → 412. Soft-delete/restore also bump `_version` so stale writers cannot resurrect deleted rows. Exemplar chain: `apps/api/src/modules/department/department.controller.ts#update` → `packages/applications/src/services/department/department.service.ts#update` → `packages/domains/src/common/repository.ts#updateWithVersion`.

**`If-Match: "0"` = create-intent.** The strong-validator parser (`apps/api/src/decorators/expectedVersion.decorator.ts`, `STRONG_VALIDATOR_RE = /^"(0|[1-9][0-9]*)"$/`) accepts `"0"` as a valid precondition: a GET on a not-yet-materialized config-plane row returns a `version: 0` placeholder (the `FIRST_EDIT_ETAG` convention) and the client echoes it. The parser only carries the number — each service's CAS decides create-vs-412: `expectedVersion === 0` against no row creates it; `"0"` against a row already at version ≥ 1 is stale and MUST 412 (exemplar: `AiProviderConnectionService.upsertRow`). A `version: 0` response yields NO ETag — there is nothing to precondition a first write against. The header still overrides the body `expectedVersion`; the `undefined` fall-through (no header on a non-`@RequiresIfMatch` route) keeps the service-to-service `expectedVersion: number` body field working for non-browser callers.

### 6.9 Idempotency

No generic idempotency-key middleware exists. Idempotent behavior is implemented per feature where it matters: duplicate-code checks before create (`department.service.ts`), upsert-style tag setting (`services/tenant/dto/setTenantTags.request.ts` flow), Temporal workflows give the harness loop durable execution semantics, and sys-event BullMQ jobs carry bounded retry options (`SYS_EVENT_JOB_OPTIONS`: 2 attempts, exponential backoff — `packages/applications/src/services/sysEvent/sysEvent.service.ts`). Don't claim idempotency guarantees beyond these.

### 6.10 Settings storage — Vault vs Database

The normative rule for where any admin-controllable variable lives: **the database is the control plane; Vault is the crypto substrate — never the control plane.** Admin-editable non-secrets go in Postgres (it has OCC/audit/cascade/UI; Vault has none). Secrets go in Vault: shared platform secrets in kv-v2, per-tenant admin-set secrets as **Vault-Transit ciphertext inside a DB column** (never plaintext). Classify each variable into one data class and route it:

| Data class                        | Storage tier                                                                                      | Encryption    | Who edits                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | ------------- | ------------------------------- |
| 1. Platform infra secret (shared) | Vault kv-v2                                                                                       | Vault-native  | operator/IaC only (no admin UI) |
| 2. Tenant BYO secret              | DB column, Vault-Transit ciphertext (`encrypted* Bytes` + `keyVersion`); reject write if no Vault | Vault Transit | tenant-admin + super-admin      |
| 3. Cascading behavioural config   | DB dedicated table + `ConfigResolver` cascade + OCC                                               | none          | tiered by max-scope             |
| 4. Global KV / kill-switch        | `GlobalSetting` + AppSettings cache (Redis for instant fan-out)                                   | optional      | super-admin                     |
| 5. Plan capability / quota        | entitlements matrix (`PlanEntitlement`/`TenantEntitlement`)                                       | none          | super-admin                     |
| 6. Deploy/runtime env             | env → `turbo.json#globalEnv` → `IConfigService`                                                   | none          | operator only                   |

Anti-patterns (review-enforced): admin-editable non-secret in Vault (wrong tool); secret as DB plaintext (always Vault-Transit ciphertext; reject write when `SECRETS_PROVIDER≠vault`); a secret echoed in a read DTO (write-only DTO + masked read `hasKey`; reveal only behind step-up + audit); a config write without OCC (`If-Match`→428/412) or without a SysEvent; an enforcing kill-switch defaulting ON (default OFF — fail-safe).

Reusable primitives:

- `packages/applications/src/services/baseServices/_meta/secrets/secret-field.util.ts` — canonical `encryptSecretField`/`decryptSecretField`/`parseKeyVersionFromCiphertext` for every class-2 field (a behaviour-identical twin lives in the domains-layer `GlobalSettingRepository.encryption.ts` — the two must not drift; domains cannot import applications).
- `packages/applications/src/services/settings-registry/` — `HOPE_SETTINGS_REGISTRY` typed catalog (tier/scope/sensitivity/editor/category) with a uniform `assertWithinMaxScope` clamp and the `walkCascade` cascade primitive; served RBAC-filtered at `GET /api/v1/admin/settings/catalog`.
- `apps/api/src/shared/tenant-scope.ts` — `resolveScopedTenantId` / `resolveScopedTenantIdOptional` / `assertTenantInScope` — the one home for cross-tenant admin resolution (super-admin `?tenantId=`; tenant-bound pinned; 404-over-403).

**Global KV convergence contract (`AppSettingsService`, `packages/applications/src/services/baseServices/_meta/appSettings/appSettings.service.ts`).** Every `GlobalSetting` write broadcasts `SysEventType.ResourceUpdated` (`BaseService.broadcastSysEvent`); three layers converge readers on it, cheapest-first:

1. **Same-instance, in-process** — `@OnEvent(SysEventType.ResourceUpdated)` (filtered to `ResourceType.GlobalSetting`) calls `refreshCache()` immediately (~ms). `@nestjs/event-emitter` is in-process only, so this converges ONLY the writing instance.
2. **Cross-instance, Redis pub/sub** — after that same-instance refresh succeeds, the handler publishes an invalidation message (`{ instanceId }`) on `APP_SETTINGS_INVALIDATION_CHANNEL` (`'app-settings:invalidate'`) via `IRedisCacheService.publish` (`RedisCacheModule`, imported by `AppSettingsModule`). Every instance also subscribes to that channel on `onModuleInit` via a dedicated `RedisSubscriberService` connection and calls `refreshCache()` on receipt. A self-published message (matching in-memory `instanceId`) is a no-op — that instance already refreshed itself in step 1. This is the "Redis for instant fan-out" the data-class table below refers to.
3. **Fail-open fallback, cron** — the `updateCacheAppSettings` cron (`'45 * * * * *'`, worst case ~60s) is the backstop for both: a writer that never broadcasts the sys-event (rare — direct-Prisma writers only), and any deployment where Redis is absent/unreachable. Both the publish and subscribe sides degrade to a no-op + WARN log rather than throwing when Redis is unavailable — `AppSettingsModule` still boots without Redis, just slower to converge (cron-bound, as before this follow-up).

Full framework + rationale: [docs/architecture/configuration-storage-classification.md](./architecture/configuration-storage-classification.md) — the normative classification (data classes ↔ storage tiers, descriptor anatomy, `failMode`, the assembly-time invariants, the write-lane guard order, anti-patterns and reusable primitives).

---

## 7. Known internal inconsistencies

These are live as of 2026-08-19 — each is a real split in the current code, not a historical note. Resolved items are deleted rather than struck through, so this list is always "what is still inconsistent today".

1. **Architecture lint is advisory inside `packages/*`.** `packages/config-eslint/flat/library.js` loads `eslint-plugin-only-warn`, downgrading every violation to a warning. The same rules are hard errors in `apps/api` (`flat/nestjs.js`). Treat the warnings as errors — nothing else will.
2. **Excluded-service debt is codified.** The `flat/core.js` service-boundary `ignores` still exempts `services/audit/**`, `services/tenant/**`, `services/user/userRoleAssignment/**` from the repository rule, and `tenant.service.ts` + `audit/authorization-audit.service.ts` still use `databaseService.client` directly.
3. **Test placement and naming are split.** Unit tests use both colocated `__tests__/` folders AND sibling `*.test.ts` files (`packages/applications/src/common/applyChangesToEntity.test.ts` next to `.../common/__tests__/cursorPagination.test.ts`); Python test dirs are `src/<pkg>/tests/` for text/guardrail/harness/tts but a top-level `tests/` for stt/nlp; e2e uses `.spec.ts` while unit uses `.test.ts`.
4. **Two `CoreUnitOfWorkService` implementations exist** — `packages/domains/src/common/unitsOfWork/core/core.unitOfWork.ts` (used by repositories) and `packages/applications/src/services/baseServices/unitsOfWork/core/core.unitOfWork.ts` (application wrapper). The applications one records that its `startTransaction/endTransaction` wrapper has NO production callers; the proven pattern is `baseClient.$transaction(callback)`.
5. **Tailwind config duality.** `packages/config-tailwind/tailwind.config.ts` exists but is an empty shell; the real theme is `packages/ui/src/styles/globals.css` (v4 CSS-first). Some `package.json` files still carry the config-tailwind dependency.
6. **Auth decorators have two import paths** — defined in `packages/applications/src/authorization/decorators.ts`, re-exported through `apps/api/src/decorators/index.ts`; both appear in controllers. Prefer the `../../decorators` re-export inside `apps/api`.
7. **`BaseProxyController` is scaffolding with no users.** It still ships with its `ProxyControllerConfig` shape and a unit test, but no controller extends it — the live Text proxy is standalone (§1.6).
8. **The per-service Python effective-config client is duplicated by design.** Each service carries its own `core/effective_config.py`; factoring it into a shared package is a deferred owner decision, not drift to fix opportunistically.

---

## 8. Quick reference card — the 20 most important do/don'ts

1. DO follow the Prisma model section order: meta (`metaData`,`version`,`id uuid(7)`) → `tenantId` → core → resource status → audit → tags → relations → named indexes + `@@schema("core")` (`packages/database/src/prisma/db_main/user.prisma`).
2. DO edit schema under `packages/database/src/prisma/db_main/*.prisma` and create migrations with `pnpm db:migrate:create` / `db:migrate`; DON'T edit committed migration SQL.
3. DO use `getExtendedPrismaClient()` / `CoreDatabaseService.client`; DON'T import `getPlatformAdminPrismaClient_Unscoped` (lint-blocked; bypasses tenant scope AND soft delete).
4. DON'T touch `this.databaseService.client` in controllers (`arcaai-internal/no-controller-direct-prisma`) or in application services (`no-restricted-syntax`) — go through a domain repository.
5. DON'T read `process.env.TEXT_URL|STT_URL|NLP_URL|GUARDRAIL_URL|HARNESS_URL|TEXT_SERVICE_URL` in `apps/api/src/modules/**` — inject `IConfigService.getConfigValue(...)`.
6. DO create entities with `XxxFactory.CreateXxx(props)` + `generateId()` (UUIDv7); DON'T `new XxxEntity()` in services.
7. DO mutate entities through setters (change tracking via `setProperty`); update with `this.updateEntity(entity, dto)` then `repository.updateWithVersion(id, entity, expectedVersion)`.
8. DO `repository.softDelete(id)`; DON'T hard-delete. New soft-delete-less models must be added to `MODELS_WITHOUT_SOFT_DELETE` in `packages/database/src/client.ts` (and the tenant list in `extensions/tenant-scope.ts` if tenant-scoped).
9. DO broadcast `this.broadcastSysEvent(SysEventType.ResourceCreated|Updated|Deleted, {...})` after every successful mutation; reads use `ResourceViewed` (audited only with `forceAuditLog: true`).
10. DO expose services via Symbol tokens (`IXxxService`) and register modules as `{ imports: [CommonServiceModule, CoreDatabaseModule], providers: [{ provide: IXxxService, useClass: XxxService }] }`.
11. DO return Response DTOs from services (via static `XxxDtoMapper.toResponse`); DON'T return domain entities from public service methods.
12. DO declare every request field on a class-validator DTO — the global pipe runs `whitelist + forbidNonWhitelisted + forbidUnknownValues`.
13. DO gate controllers with `@CanManage('Resource')` / `@Authorize([...])`; `@Public()` is the only auth opt-out (default-deny `UnifiedAuthGuard`).
14. DO throw `NotFoundException` (not Forbidden) on cross-tenant access to hide resource existence; use `assertParentInScope`/`assertEqualTenants` for parent references.
15. DO require `If-Match` (`@RequiresIfMatch()` + `@ExpectedVersion()`) on versioned PATCH routes; version drift = 412, missing header = 428; never write `_version` from a mapper.
16. DO run Python tooling through conda `arcaenv` (`conda run -n arcaenv ...`, `pnpm <svc>:test|lint|format|typecheck` — NOT the retired `py:*` spelling); dependencies change → update the member `pyproject.toml` then `uv lock` at the root.
17. DO give every FastAPI service pydantic-settings config with its `env_prefix`, structlog logging, `/api/v1/health`, and `X-Service-Token` middleware (constant-time compare; empty token = dev bypass).
18. DO put unit tests in colocated `__tests__/*.test.ts`, integration tests in `**/integration/**` (sequential runner), API e2e in `apps/api/tests/e2e/*.spec.ts`; run with `pnpm test:unit` / `test:integration` / `test:e2e` (all load `.env.test`).
19. DO keep env files by NODE_ENV (`.env.dev`/`.env.test`/`.env.production`); CI/production load NO env files (host env only); new runtime env vars must be added to `turbo.json#globalEnv`; never commit secrets (gitleaks pre-commit + CI gate).
20. DO build UI as React 19 function components (no `forwardRef`) extending shadcn primitives with `cva` variants, `data-slot` attributes, `cn()` merging, and tokens from `packages/ui/src/styles/globals.css`; keep SDK state in the internal Zustand store behind hooks (`packages/agentic-sdk-v2/src/hooks/`).
