# HOPE — Development Patterns and Standards (verified against code)

Last updated: 2026-07-04

This document records the conventions the codebase ACTUALLY follows, verified by reading source files on the date above. Every file path cited exists in the repo. It is the primary input for rewriting the project's Cursor rules. Where the codebase is internally inconsistent, section 7 says so explicitly.

Monorepo shape (verified): Turborepo + pnpm workspace (`pnpm-workspace.yaml`: `apps/*`, `packages/*`, `packages/agentic-sdk-v2/examples/*`), Node >= 22, pnpm 10.31, TypeScript 5.9, Prisma 7, NestJS 11, Vitest 4, Playwright, Python 3.11 (FastAPI) services under `apps/`, one shared conda env `arcaenv` plus a uv workspace (root `pyproject.toml` + single `uv.lock`).

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

| Concern | Convention |
|---|---|
| id | `String @id @default(uuid(7))` — UUIDv7, sortable. Don't use autoincrement or cuid. |
| Meta | `metaData Json? @map("_metadata") @db.JsonB` and `version Int @default(1) @map("_version")` first. `_version` is the optimistic-concurrency counter — never written by mappers (stripped in every `*EntityMapper`). |
| Tenant | `tenantId String` (NOT NULL, no default) on tenant-scoped models. `NULL = global` semantics are banned; platform-wide rows use the SYSTEM tenant `00000000-0000-0000-0000-000000000000`. |
| Soft delete | `resourceStatus ResourceStatusType @default(ENABLED)` + `resourceStatusUpdatedAt DateTime?` + `resourceStatusUpdatedBy String?`. Statuses: `ENABLED, DISABLED, SUSPENDED, ARCHIVED, DELETED` (`enums.prisma`). Tables that deliberately omit it (version history, WORM audit tables like `HarnessAuditEvent`, and `TranscriptionJob` which has its own status enum) must be listed in `MODELS_WITHOUT_SOFT_DELETE` in `packages/database/src/client.ts`. |
| Audit fields | `createdBy String? @default("60000000-0000-0000-0000-000000000000")` (system user), `updatedBy String?`, `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt`. |
| Tags | `tags String[] @default([])` when applicable. |
| Indexes | Explicit names: `@@index([tenantId], name: "Model_tenantId_idx")`; always index `tenantId` and FKs. Composite uniques include `tenantId` (e.g. `UserDepartment_tenant_user_department_unique`). |
| Enums | PascalCase names, SCREAMING_CASE members, `@@schema("core")`, defined in `packages/database/src/prisma/db_main/enums.prisma`. |

### 1.2 Migration workflow

- Config: root `prisma.config.ts` (Prisma 7 `defineConfig`) points schema to `packages/database/src/prisma/db_main` and migrations to `.../db_main/migrations`. It loads `.env.dev`/`.env.test`/`.env.production` by `NODE_ENV`, and loads NO env file in CI/production.
- Scripts (root `package.json` delegates to `packages/database/package.json`): `pnpm db:migrate` (= `prisma migrate dev --skip-generate`), `db:migrate:create` (`--create-only`), `db:migrate:deploy`, `db:migrate:status`, `db:push` / `db:push:force`, `db:generate` (also regenerates the barrel via `@arcaai/tools generate-prisma-index`), `db:seed`, `db:studio`.
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
- Tenant scope details (`packages/database/src/extensions/tenant-scope.ts`): allow-list `TENANT_SCOPED_MODELS` mirrors schema reality; `User*` identity tables are deliberately global (membership is modeled by `UserRoleAssignment` / `UserDepartment`). `SYSTEM_SHARED_READ_MODELS` (`AsrPipeline`, `AiModel`, `HarnessPolicy`, `PipelinePolicy`, `GlobalSetting`) widen READS to `tenantId IN [caller, SYSTEM]`; writes are never widened. The tenant id comes from a host-registered provider — NestJS wires the CLS-backed one in `apps/api/src/database/tenant-context.provider.ts`; without a provider the extension is pass-through (seeds/CLI).

### 1.4 Domain layer (`packages/domains`)

Folder layout: `entities/generated/core/`, `factories/generated/core/`, `mappers/generated/core/`, `models/generated/core/`, `repositories/generated/core/` — one file per Prisma model, named `XxxEntity.ts`, `XxxFactory.ts`, `XxxEntityMapper.ts`, `XxxModel.ts`, `XxxRepository.ts`. Hand-written repository extensions live outside `generated/` (e.g. `repositories/policy/`). Scaffolding comes from `packages/tools` generators (`pnpm gen:entity`, `gen:factory`, `gen:mapper`, `gen:repository`, `gen:model`); CI drift gates re-run generators and fail on diff (`.gitlab/ci/validate.yml` jobs `generate-data-model-check`, `generate-data-entity-check`, `generate-factory-check`).

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
- Quota/entitlement prechecks are opt-in via `IEntitlementsService.assertQuantityQuota` (throws `QuotaExceededException` → HTTP 409), kill-switch-gated.

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
- Logging: `@arcaai/logger` (`packages/logger/src/index.ts`) is the shared logging service; bootstrap registers crash handlers that flush it (`apps/api/src/crash-handlers.ts`).
- Python-service proxying: proxy controllers extend `BaseProxyController` (`apps/api/src/shared/base-proxy.controller.ts`) with a `ProxyControllerConfig` (upstream URL from `IConfigService`, path rewrite, optional service-token injection via `SecretsService` in the `on.proxyReq` hook). Example: `apps/api/src/modules/streaming/smr-proxy.controller.ts`. WebSocket bridging to STT is a NestJS gateway: `@WebSocketGateway({ path: '/ws/stt-v2/stream' })` in `apps/api/src/modules/streaming/stt-ws.gateway.ts`.

### 1.7 Dependency-direction rules — exactly what the lint config encodes

ESLint runs on ESLint 9 flat config (TASK-418): every package has an `eslint.config.mjs` spreading a preset from `packages/config-eslint/flat/` (`library.js` for packages, `nestjs.js` for apps/api, `next.js` for apps/admin-console), custom plugin: `packages/eslint-plugin-arcaai-internal/` (rules registered in its `index.js`).

The four enforced architecture rules (all in `packages/config-eslint/flat/core.js`):

1. `arcaai-internal/no-controller-direct-prisma` (error) — scope `**/modules/**/*.controller.ts` (i.e. `apps/api`). Forbids any `<x>.databaseService.client` chain in controllers. Escape hatch: `/** @allowedDirectPrisma <reason> */` within 3 lines above. Rule source: `packages/eslint-plugin-arcaai-internal/rules/no-controller-direct-prisma.js`. Current allow-list usage: zero occurrences in `apps/api/src` (verified).
2. Service-layer analogue via built-in `no-restricted-syntax` — scope `**/services/**/*.service.ts`, AST selector matching `<x>.databaseService.client`; message: route through a domain-layer repository (TASK-311 AC-8). `excludedFiles` pins: `**/services/audit/**`, `**/services/tenant/**`, `**/services/user/userRoleAssignment/**`, `**/services/baseServices/**` (the last is permanent — it hosts `CoreDatabaseService`/unit-of-work plumbing).
3. `arcaai-internal/no-direct-downstream-url-env` (error) — scope `**/modules/**/*.ts`. Forbids `process.env.SMR_URL|SMR_SERVICE_URL|STT_V2_URL|NLP_URL|GUARDRAIL_URL|HARNESS_URL` (dot or bracket access). Callers must inject `IConfigService` and call `getConfigValue('SMR_URL')` (`packages/applications/src/services/baseServices/_meta/config/config.service.ts`). Rule source: `packages/eslint-plugin-arcaai-internal/rules/no-direct-downstream-url-env.js`.
4. `no-restricted-imports` (error, repo-wide) — bans importing `getPlatformAdminPrismaClient_Unscoped` from `@arcaai/database` (and deep paths). Allowed only for seeds (`packages/database/src/prisma/db_main/seed/**`), back-fill scripts (`packages/database/scripts/**`), test fixtures, and the transitional `CoreDatabaseService.baseClient`.

Additional conventions from `flat/core.js`: `@typescript-eslint/no-unused-vars` honors the `_`-prefix convention for intentionally-unused identifiers. Note: `flat/library.js` adds `eslint-plugin-only-warn`, which downgrades all violations to warnings inside packages (see 7.2).

Import-direction do/don'ts (encoded partly by lint, partly by convention, both verified):

- Controllers (apps/api) DO import DTOs/tokens from `@arcaai/applications`; DON'T touch Prisma or `process.env.<downstream URL>`.
- Application services DO import repositories/factories/enums from `@arcaai/domains`; DON'T import runtime code from `@arcaai/database` (type-only imports are the sanctioned exception — see `packages/applications/src/common/modelFilterTypes.ts`, which documents this).
- Domain entities are DB-agnostic; only mappers/repositories/database-services know about Prisma models.

---

## 2. Python service patterns (`apps/stt-v2`, `apps/smr`, `apps/guardrail`, `apps/nlp`, `apps/harness`)

### 2.1 Layout and packaging

All services are PEP-621 `pyproject.toml` + setuptools, `src/<package_name>/` layout: `stt_v2`, `smr_v2`, `guardrail`, `nlp`, `harness`. Standard internal structure (verified in smr/harness): `main.py` (FastAPI `create_app()` factory + `lifespan` context manager), `core/` (`config.py`, `logging.py`, plus service-specific), `api/endpoints/` (+ `api/middleware/` in smr), `services/`, `models/`. Tests live either in `src/<pkg>/tests/` (smr, guardrail, harness) or a top-level `tests/` (stt-v2, nlp) — see `testpaths` in each `pyproject.toml`.

### 2.2 Config / env handling

pydantic-settings `BaseSettings` classes with per-concern `env_prefix` (verified `apps/harness/src/harness/core/config.py`, `apps/smr/src/smr_v2/core/config.py`): `HARNESS_`, `TEMPORAL_`, `HARNESS_SAFETY_`, `SMR_V2_`, `SMR_V2_OLLAMA_`, `SMR_V2_AZURE_`, `SMR_V2_BEDROCK_`, etc. Singleton accessor `get_settings()`; settings are attached to `app.state.settings`. Secrets are `SecretStr` (e.g. `service_token`). Structured logging via `structlog` with event names like `"harness.temporal_connected"`.

### 2.3 Environments: conda `arcaenv` + uv workspace

- Local dev/tests run inside the single shared conda env `arcaenv` (Python 3.11) — created by `scripts/setup-python-env.sh` (`CONDA_ENV_NAME="arcaenv"`); every root `py:*` script wraps commands in `conda run -n arcaenv --no-capture-output ...`; `scripts/dev-service.sh` does the same for dev servers.
- Dependency resolution is owned by the uv WORKSPACE at the repo root: `pyproject.toml` declares `[tool.uv.workspace] members = [apps/guardrail, apps/nlp, apps/smr, apps/harness, apps/stt-v2]` with ONE `uv.lock`, so all services resolve identical versions. Docker builds use `uv sync --frozen --package <svc>`. Regenerate with `uv lock` after changing any member's dependencies. stt-v2's `ml`/`ml-gpu` vs `nemo` extras are declared as uv conflicts.

### 2.4 pytest layout and markers

Uniform `[tool.pytest.ini_options]` across services: `minversion = "9.0"`, `addopts` with `-ra --strict-config --strict-markers` (smr/guardrail add `--cov`; smr also deselects `-m "not e2e"` by default), `python_files = ["test_*.py", "*_test.py"]`, `asyncio_mode = "auto"`. Markers: smr/nlp define `e2e`; stt-v2 defines `unit` / `integration` (+ more). Tooling is ruff (lint, incl. import sorting — isort is NOT used), black (format, line length 100), mypy (strict-ish, per-service config). Run through root scripts: `pnpm py:<svc>:test|lint|format|typecheck`.

### 2.5 Gateway registration / authentication

Python services do not self-register; `apps/api` fronts them (proxy/gateway 1.6) and resolves their URLs via `IConfigService` (`STT_V2_URL` :8861, `SMR_URL` :8862, `GUARDRAIL_URL` :8863, `NLP_URL` :8864, `HARNESS_URL` :8866). Inbound auth on the Python side is a shared-secret header validated with constant-time compare; empty token = dev-mode bypass; health/docs/metrics paths exempt:

```32:47:apps/smr/src/smr_v2/api/middleware/auth.py
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

- WS: STT streaming endpoints in `apps/stt-v2/src/stt_v2/streaming/api/routes.py`; the NestJS side bridges via `apps/api/src/modules/streaming/stt-ws.gateway.ts` (path `/ws/stt-v2/stream`).
- SSE: SMR streams LLM chunks over Server-Sent Events backed by Redis Streams with resume support — `apps/smr/src/smr_v2/api/endpoints/stream.py` uses `sse_starlette.sse.EventSourceResponse` and includes the Redis message id in each event for resumption. On the gateway side, SSE routes are guarded by `TenantOwnedResourceSseGuard` (see 1.6).

### 2.7 Temporal (harness)

`apps/harness` runs the bounded "guides → generate → sensors → gate" loop as a Temporal durable workflow. Layout: `apps/harness/src/harness/temporal/` with `workflows.py` (`@workflow.defn` classes), `activities.py` (`@activity.defn` functions), `client.py` (`get_temporal_client(settings)`), `worker.py` (separate process, started via `pnpm dev:harness:worker`), `models.py` (dataclass payloads). Temporal config via `TemporalConfig(BaseSettings)` with `env_prefix="TEMPORAL_"` (address/namespace/task-queue). The FastAPI app connects best-effort in `lifespan` and must come up even when Temporal is down (`apps/harness/src/harness/main.py`); only the worker hard-requires Temporal.

---

## 3. Frontend patterns

`apps/ui-playground` is DEPRECATED (and `apps/admin` removed); cite `packages/ui` and `packages/agentic-sdk-v2` as the exemplars. `apps/example` is a standalone raw-WebSocket live-transcription demo — deliberately NOT an SDK consumer (see `apps/example/README.md`).

### 3.1 `packages/ui` component conventions

- File layout: `src/components/shadcn/` (base primitives, one file per component, kebab-case), `components/custom/`, `components/registries/` (third-party collections), `components/blocks|collection|data-grid|editor|elevenlabs|live-transcript|metrics|timeline|shared`, plus `hooks/`, `lib/`, `styles/`, `contexts/`, `types/`.
- Component pattern (verified `packages/ui/src/components/shadcn/button.tsx`): plain function components (React 19 — NO `forwardRef`), props typed as `React.ComponentProps<'button'> & VariantProps<typeof buttonVariants>`, `cva` for variants with `defaultVariants`, `asChild` polymorphism via `Slot.Root` from the consolidated `radix-ui` package, `data-slot` / `data-variant` attributes for styling hooks, and `cn()` from `packages/ui/src/lib/utils.ts` for class merging.
- Exports: subpath exports in `packages/ui/package.json` (`"."`, `"./components/shared"`, `"./components/metrics"`, `"./styles.css"`, ...) built with tsup + the Tailwind CLI.
- Do: extend shadcn primitives with new cva variants. Don't: fork primitives, hardcode colors (use the semantic CSS variables), or use any non-shadcn UI kit.

### 3.2 Tailwind v4

CSS-first configuration. The single token source is `packages/ui/src/styles/globals.css`: `@import "tailwindcss"`, `@custom-variant dark (&:is(.dark *))`, and the HOPE "Calm Clinical Teal" design tokens as CSS variables (brand ramps + semantic roles incl. `--ai/--hope/--success/--warning/--info`). `packages/config-tailwind/tailwind.config.ts` is effectively an empty shared shell (v4 no longer needs a JS config); do not add theme config there — add tokens to `globals.css`.

### 3.3 TanStack Router

File-based routing (pattern verified in the deprecated playground, still the house pattern): `src/routes/` with `__root.tsx`, layout groups `(auth)/`, `(errors)/`, and an `_authenticated/route.tsx` guard using `createFileRoute` + `beforeLoad` redirect:

```4:14:apps/ui-playground/src/routes/_authenticated/route.tsx
export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ context, location }) => {
    if (!context.isAuthenticated) {
      throw redirect({
        to: '/login',
        search: { redirect: location.href },
      });
    }
  },
  component: AuthLayout,
});
```

### 3.4 Zustand in `@arcaai/vox` (`packages/agentic-sdk-v2`)

Single internal vanilla store: `packages/agentic-sdk-v2/src/store/agenticStore.ts` uses `createStore` from `zustand/vanilla` + `useStore` with a React context — the store is NOT exported publicly; consumers use the hook layer (`packages/agentic-sdk-v2/src/hooks/` — `useArca.ts`, `useArcaAudio.ts`, `useArcaSession.ts`, `useConsultationChain.ts`, ~30 hooks). Core managers (AgenticClient, PluginManager, ConfigManager, ModelRegistry) live in `src/core/`. Do: add SDK state to the store and expose it via a hook. Don't: export the store or write to it from app code.

### 3.5 React 19 idioms in use

- No `forwardRef` — refs are ordinary props via `React.ComponentProps<...>` spreading (all of `components/shadcn/`).
- Types pinned via pnpm overrides: `@types/react ^19.2.14` (root `package.json`).
- jsdom-based Vitest environment for browser packages (root `vitest.config.ts` `environmentMatchGlobs`).

### 3.6 Admin data grids (standard, TASK-423)

Every list/table surface in `apps/admin-console` uses `VirtualizedDataGrid` (`packages/ui/src/components/data-grid`; TanStack Table v8 + Virtual + dnd-kit). The legacy `DataTable`/`TablePagination` were removed; only non-list displays (hierarchy trees, comparison/cascade matrices) use the raw shadcn `Table`, and `FilterBar` remains only as a standalone control over non-grid sources.

- **Full-page lists**: wrap with `AdminDataGrid` + `useAdminGridParams` (`apps/admin-console/src/shared/data`) — URL query-state via nuqs (`grid-url-state.ts`; typed filters serialized into a compact `f` param and emitted to the backend as the bracket grammar), envelope normalization (`envelopes.ts#normalizeList`, 6 shapes incl. cursor), and server-persisted layout.
- **Embedded / master-detail lists**: use `VirtualizedDataGrid` directly at a fixed `height` and pass `persistence={gridPersistence('<gridId>')}`.
- **Personalization is mandatory for real lists**: column order/size/visibility/pinning + density persist per-user in `UserSettings` under namespace `ui.data-grid/<gridId>` via `GET`/`PATCH user/me/settings` (`grid-persistence.ts` — a single shared `sharedGridLayoutPersistence` adapter, 16 KB-guarded, best-effort, settings GET deduped + cached 30 s so N grids on a page share one request (TASK-428); first paint gated on `isLayoutReady`). Only genuinely small fixed detail-tab/utility tables may leave the `column*` features off.
- Do: give every grid a stable `gridId` and set column `meta` (`variant`, `options`) for typed filters. Don't: reintroduce `DataTable`, or read/write `UserSettings` grid keys outside the shared adapter.

### 3.7 Admin screen template (standard, TASK-427)

Every screen in `apps/admin-console` composes ONE standardized page frame — `ScreenTemplate` (`apps/admin-console/src/shared/page/screen-template.tsx`, Figma "09 - Screen Templates") — instead of hand-rolling a flex column. It fills the shell content region as a fixed-height flex column so only the content scrolls; pinned regions are `shrink-0` flex rows (no `position: sticky`, so they never obscure focus).

- **Region contract** (top → bottom): pinned top in priority order `header` (title + actions; breadcrumbs stay in the shell topbar) → `stats` → `statusBanner` → `toolbar` → `tabs`; full-width content (main / charts / tab panels / data grid); pinned bottom `footer` — an IDE-style status bar (`StatusFooter`, `…/shared/page/status-footer.tsx`).
- **Content modes**: `contentMode="fill"` hands the height to a fill-height `AdminDataGrid` (sticky header, scrolling body, pagination pinned directly above the footer); `contentMode="scroll"` (default) scrolls content/detail/dashboard pages between the pinned top group and footer. Never nest a second scroll area inside `fill`.
- Grid pages carry their toolbar INSIDE the grid (not the `toolbar` slot). Tabs: wrap the template in `<Tabs>`, pass `<TabsList variant="line">` (underline — the standard, not the bare `<TabsList>` pill default) to `tabs` and the `<TabsContent>` panels as `children`.
- Do: wrap every screen (list, detail, dashboard) in `ScreenTemplate`. Don't: reintroduce ad-hoc `<div className="flex … flex-col gap-4">` page frames or let the header/toolbar scroll away. See `11-ux-ui-principles.mdc` §Screen Template.

### 3.8 Admin redesign foundation (TASK-437)

Shared layout/interaction infrastructure consumed by the redesigned screens (TASK-438…442). Data contracts, permission gates and OCC behaviour are unchanged.

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

`vitest.integration.config.ts`: only `**/integration/**/*.test.ts`, sequential (`pool: 'forks'`, `fileParallelism: false`, `isolate: false`), 60 s timeouts, setup `tests/setup/integration.setup.ts`, `@arcaai/database`/`@arcaai/domains` aliased to source. Real infra (Postgres 5433, Redis 6380, MinIO 9002) comes from `pnpm docker:test:up` / `tests/docker-compose.test.yml`. Example: `packages/domains/src/integration/repository-soft-delete.integration.test.ts`.

### 4.3 Playwright E2E

Root `playwright.config.ts`: `testDir: './apps/api/tests/e2e'`, pattern `**/*.spec.ts`, baseURL `http://localhost:8868/api/v1`, global setup/teardown in `tests/setup/playwright.global-setup.ts` / `.global-teardown.ts`, CI detection parses `CI=true|1` (string "false" is NOT CI). E2E specs are API-level (auth, rbac, cross-tenant, optimistic-locking — e.g. `apps/api/tests/e2e/rbac.spec.ts`, `apps/api/tests/e2e/optimistic-locking.spec.ts`). Note the naming split: e2e uses `.spec.ts`, unit tests use `.test.ts`.

### 4.4 Contract and cross-tenant tests

- Contract tests: `tests/contracts/*.contract.test.ts` validate gateway↔Python request/response shapes against shared zod schemas in `tests/contracts/schemas.ts` (e.g. `tests/contracts/stt.contract.test.ts`).
- Cross-tenant tests: `tests/cross-tenant/` (fixtures in `tests/cross-tenant/fixtures.ts`) plus a coverage meta-test `packages/applications/src/__tests__/cross-tenant-coverage.test.ts`; dedicated e2e cross-tenant specs exist per feature (`apps/api/tests/e2e/task-307-*-cross-tenant.spec.ts`).
- Shared helpers/fixtures: `tests/helpers/` (`api.helper.ts`, `auth.helper.ts`, `db.helper.ts`, `e2e.helper.ts`) and `tests/fixtures/` (`tenants.fixture.ts`, `users.fixture.ts`, `roles.fixture.ts`).

### 4.5 Python tests

See 2.4. Run per service: `pnpm py:stt-v2:test[:unit|:integration|:cov]`, `pnpm py:smr-v2:test`, `pnpm py:nlp:test`, `pnpm py:guardrail:test`, `pnpm py:harness:test` — all via conda `arcaenv`.

### 4.6 TDD expectation

Service unit tests mock repositories + `EventEmitter2` + `ClsService` and assert factory usage and `broadcastSysEvent` calls (see `packages/applications/src/services/webhook/__tests__/webhook.service.test.ts` and the `department/__tests__/` suite). The workflow expectation (docs + observed test-first tickets): failing test → minimal code → refactor; behavior-focused tests; evidence (test output) required before claiming done.

---

## 5. Tooling / process

### 5.1 Turborepo (`turbo.json`)

- `build` depends on `^build` + `^db:generate`, and `cache: false` (builds are deliberately uncached; note this when reasoning about CI time). `@arcaai/database#build` additionally depends on its own `db:generate`.
- `dev` / `dev:watch` are persistent + uncached; `test` depends on `build`; `lint` depends on `^build`. DB tasks (`db:push`, `db:migrate`, `seed`) are uncached and chained to `db:generate`.
- `globalEnv` whitelists runtime env (DATABASE_URL, downstream service URLs, Temporal, Redis, OTEL, Vault keys, ...). Add new env vars here when tasks depend on them.

### 5.2 pnpm workspace

`pnpm-workspace.yaml`: `apps/*`, `packages/*`, `packages/agentic-sdk-v2/examples/*`; `onlyBuiltDependencies` for Prisma packages. No catalog: feature is not used. Internal deps use `workspace:*`. Root `package.json` `pnpm.overrides` pin `class-validator` and React 19 types. Filters are the house style for scoping: `pnpm --filter @arcaai/database db:generate`, `turbo run build --filter=@arcaai/api...`.

### 5.3 ESLint

ESLint 9 flat config everywhere (TASK-418; admin-console runs ESLint 10 app-local against the same presets). Each package/app has an `eslint.config.mjs` spreading a surface preset from `packages/config-eslint/flat/` (`core.js` foundation + `library.js` / `nestjs.js` / `next.js` / `react-library.js`; `prettier-base.js` is the shared Prettier config, not an ESLint preset); custom rules in `packages/eslint-plugin-arcaai-internal/`. The legacy `.eslintrc.js` estate and the `ESLINT_USE_FLAT_CONFIG=false` escape are gone — do not reintroduce eslintrc-format configs. Architecture rules: see 1.7.

### 5.4 Prettier

Root `.prettierrc.js` extends `packages/config-eslint/prettier-base.js`: `singleQuote: true`, `printWidth: 150`, `tabWidth: 2`. Enforced through `eslint-plugin-prettier/recommended` in the flat core config (violations surface as lint warnings) and `pnpm format`.

### 5.5 GitLab CI (`.gitlab-ci.yml` + `.gitlab/ci/*.yml`)

Stages: `install → validate → prepare → test → build → scan → publish → deploy → notify`. Branch pipeline types: main (MR gates only), dev/staging (tests + manual builds + scan), `release-sdk`, `release-playground`, `maintenance/*`. Enforced gates:

| Job (file) | Enforces |
|---|---|
| `lint-ts` (`.gitlab/ci/validate.yml`) | `pnpm turbo lint` after `db:generate` |
| `typecheck` (validate.yml) | builds database/exceptions/logger/... packages |
| `generate-data-model-check` / `generate-data-entity-check` / `generate-factory-check` (validate.yml) | generated domain layers must not drift from `@arcaai/tools` generator output |
| `lint-python` (validate.yml) | ruff over stt-v2, smr, nlp, guardrail, harness |
| `test-api`, `test-packages`, `test-sdk`, `test-apps`, `test-ui-ct`, `test-api-e2e`, `test-pgbouncer-validation` (`.gitlab/ci/test.yml`) | Vitest/Playwright suites |
| `test-stt-v2`, `test-smr`, `test-guardrail`, `test-nlp`, `test-harness` (test.yml) | pytest suites |
| `scan-gitleaks` (`.gitlab/ci/scan.yml`) | gitleaks v8.21.2 `detect` with `.gitleaks.toml` |
| `scan-*` (scan.yml) | Trivy image scans per service |

Docker images are versioned WITHOUT `latest` (semver tags + `sha-<sha8>`); skip switches `SKIP_TESTS`, `SKIP_TESTS_TS`, `SKIP_TESTS_PY` exist for manual runs.

### 5.6 Secret scanning

Pre-commit hook via `simple-git-hooks` (root `package.json` → `"pre-commit": "./scripts/gitleaks-precommit.sh"`), which runs `gitleaks protect --staged --config .gitleaks.toml` and skips (with warning) when gitleaks isn't installed; the CI job `scan-gitleaks` is the back-stop. Config: `.gitleaks.toml` + `.gitleaksignore`.

### 5.7 Env file strategy (verified loaders)

Convention (documented in `.env.example`, implemented in `packages/database/src/env.ts` and `prisma.config.ts`):

- `.env.dev` → local development (`NODE_ENV=development`; falls back to `.env`)
- `.env.test` → local testing (loaded by dotenv-cli in the `test:*` scripts; isolated infra ports: Postgres 5433, Redis 6380, MinIO 9002)
- `.env.production` → production REFERENCE only; in CI (`CI=true|1`) and production, NO env file is loaded — host env only, host env always wins.
- Node services load env through `packages/database/src/env.ts` (imported by `client.ts`); the API additionally centralizes typed access in `IConfigService.getConfigValue(...)` (lint-enforced for downstream URLs) and secrets in `SecretsService`. Python services read env via pydantic-settings prefixes (2.2). Turbo caching declares env in `turbo.json#globalEnv`.

### 5.8 Vault

Local dev Vault runs in Docker (`hope-vault`); `scripts/refresh-vault-creds.sh` mints a RAW AppRole secret_id and rewrites `VAULT_ROLE_ID`/`VAULT_SECRET_ID` in `.env.dev` (raw = dev, reusable across watch-mode restarts; response-WRAPPED secret_id = production, single-use per pod). `SecretsService` warms its cache in `SecretsModule.forRoot` before dependent providers construct (`apps/api/src/main.ts` commentary); bootstrap refuses to start if `JWT_SECRET_KEY` is a placeholder. `SECRETS_PROVIDER` env selects env-mode vs vault-mode; the vault-backed Prisma client wiring lives in `apps/api/src/vault-prisma.module.ts`. Operations docs: `docs/operations/vault/README.md`.

---

## 6. Cross-cutting integrity standards

### 6.1 Multi-tenancy enforcement points (defence-in-depth, in order)

1. `UnifiedAuthGuard` resolves the caller and populates CLS (`tenantId`, `user`) — `packages/applications/src/authorization/unified-auth.guard.ts`, registered as global `APP_GUARD`.
2. Controllers gate with `@CanXxx`/`@Authorize`; some also require tenant context explicitly for list endpoints (see `department.controller.ts#fetchAll`).
3. Services verify ownership on every by-id mutation — tenant mismatch throws `NotFoundException` ("not found", never "forbidden") to avoid existence leaks; helpers in `packages/applications/src/common/tenant-guards.ts` (`assertParentInScope` for parent references).
4. The Prisma tenant-scope extension injects `tenantId` into reads/writes of `TENANT_SCOPED_MODELS` from the CLS provider (`packages/database/src/extensions/tenant-scope.ts`); GLOBAL_ADMIN bypasses; SYSTEM-shared catalogs widen reads only.
5. SSE-specific ownership guard `TenantOwnedResourceSseGuard` re-runs assertions before the stream opens (`apps/api/src/app.module.ts`).
6. Cross-tenant e2e suites lock the 404 contracts (`apps/api/tests/e2e/task-307-*-cross-tenant.spec.ts`).

### 6.2 Soft-delete policy

Soft delete is the default everywhere: `repository.softDelete(id)` sets `resourceStatus: DELETED` and bumps `_version`; the client extension filters `DELETED` out of every read unless the caller explicitly sets `resourceStatus` in the where clause. Exceptions are explicit and centrally listed (`MODELS_WITHOUT_SOFT_DELETE` in `packages/database/src/client.ts`): version-history tables, usage records, `TranscriptionJob` (own status enum), WORM audit tables (`HarnessAuditEvent` — migration REVOKEs UPDATE/DELETE). Don't hard-delete; don't add a model with `resourceStatus` semantics without the standard three columns.

### 6.3 Audit / sys-events

Every service mutation broadcasts a `SysEventType` event (1.5); `SysEventService` fans out to BullMQ jobs: audit-log persistence (`AuditLog` model, `packages/database/src/prisma/db_main/audit.prisma`), user-activity stamping, webhooks. Reads are only audited with `forceAuditLog: true`. Append-only/WORM history uses dedicated `*Change` / `*AuditEvent` tables (`HarnessPolicyChange`, `PipelinePolicyChange`, `HarnessAuditEvent`). AuditLog payloads are envelope-encrypted (TASK-369 migrations, `packages/domains/src/repositories/generated/core/AuditLogRepository.encryption.ts`).

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

- Offset: `PaginatedQuery` (`packages/applications/src/common/dto/paginated.query.ts`) — `page` (0-based), `limit`, `search`, `searchFields`, `filters` (bracket grammar: `field[op]:value` tokens joined by `;`; ops such as `eq`/`ne`/`gte`/`lte`/`contains`/`icontains`/`in`/`notIn`/`isNull`, with `|` separating `in`/`notIn` list members — a bare `field:value` without an operator is silently ignored; see TASK-423), `sort` (`name:asc,...`), converted via `withFormattedPaginatedProps`/`withFormattedCountProps` (`packages/applications/src/common/paginatedQueryParamConverters.ts`), returned as `PaginatedResponse` built from `FetchResponse` via the DTO mapper's `ToPaginatedResponse`.
- Cursor/keyset (opt-in, for large tables): `packages/applications/src/common/cursorPagination.ts` — opaque base64url token of `(sortKey, uuidv7 id)`, hard page cap, `hasMore` detection.

### 6.8 Optimistic concurrency (house pattern)

Every admin PATCH on versioned resources: client reads `_version` (rendered as strong `ETag` by `ETagInterceptor`) → sends `If-Match` (required by `@RequiresIfMatch()`, else 428) → `@ExpectedVersion()` extracts it (header overrides body `expectedVersion`) → service calls `repository.updateWithVersion(id, entity, expectedVersion)` → drift throws `OptimisticConcurrencyException` → 412. Soft-delete/restore also bump `_version` so stale writers cannot resurrect deleted rows. Exemplar chain: `apps/api/src/modules/department/department.controller.ts#update` → `packages/applications/src/services/department/department.service.ts#update` → `packages/domains/src/common/repository.ts#updateWithVersion`.

### 6.9 Idempotency

No generic idempotency-key middleware exists. Idempotent behavior is implemented per feature where it matters: duplicate-code checks before create (`department.service.ts`), upsert-style tag setting (`services/tenant/dto/setTenantTags.request.ts` flow), Temporal workflows give the harness loop durable execution semantics, and sys-event BullMQ jobs carry bounded retry options (`SYS_EVENT_JOB_OPTIONS`: 2 attempts, exponential backoff — `packages/applications/src/services/sysEvent/sysEvent.service.ts`). Don't claim idempotency guarantees beyond these.

### 6.10 Settings storage — Vault vs Database (TASK-504)

The normative rule for where any admin-controllable variable lives: **the database is the control plane; Vault is the crypto substrate — never the control plane.** Admin-editable non-secrets go in Postgres (it has OCC/audit/cascade/UI; Vault has none). Secrets go in Vault: shared platform secrets in kv-v2, per-tenant admin-set secrets as **Vault-Transit ciphertext inside a DB column** (never plaintext). Classify each variable into one data class and route it:

| Data class | Storage tier | Encryption | Who edits |
|---|---|---|---|
| 1. Platform infra secret (shared) | Vault kv-v2 | Vault-native | operator/IaC only (no admin UI) |
| 2. Tenant BYO secret | DB column, Vault-Transit ciphertext (`encrypted* Bytes` + `keyVersion`); reject write if no Vault | Vault Transit | tenant-admin + global-admin |
| 3. Cascading behavioural config | DB dedicated table + `ConfigResolver` cascade + OCC | none | tiered by max-scope |
| 4. Global KV / kill-switch | `GlobalSetting` + AppSettings cache (Redis for instant fan-out) | optional | global-admin |
| 5. Plan capability / quota | entitlements matrix (`PlanEntitlement`/`TenantEntitlement`) | none | global-admin |
| 6. Deploy/runtime env | env → `turbo.json#globalEnv` → `IConfigService` | none | operator only |

Anti-patterns (review-enforced): admin-editable non-secret in Vault (wrong tool); secret as DB plaintext (always Vault-Transit ciphertext; reject write when `SECRETS_PROVIDER≠vault`); a secret echoed in a read DTO (write-only DTO + masked read `hasKey`; reveal only behind step-up + audit); a config write without OCC (`If-Match`→428/412) or without a SysEvent; an enforcing kill-switch defaulting ON (default OFF — fail-safe).

Reusable primitives (TASK-504):
- `packages/applications/src/services/baseServices/_meta/secrets/secret-field.util.ts` — canonical `encryptSecretField`/`decryptSecretField`/`parseKeyVersionFromCiphertext` for every class-2 field (a behaviour-identical twin lives in the domains-layer `GlobalSettingRepository.encryption.ts` — the two must not drift; domains cannot import applications).
- `packages/applications/src/services/settings-registry/` — `HOPE_SETTINGS_REGISTRY` typed catalog (tier/scope/sensitivity/editor/category) with a uniform `assertWithinMaxScope` clamp and the `walkCascade` cascade primitive; served RBAC-filtered at `GET /api/v1/admin/settings/catalog`.
- `apps/api/src/shared/tenant-scope.ts` — `resolveScopedTenantId` / `resolveScopedTenantIdOptional` / `assertTenantInScope` — the one home for cross-tenant admin resolution (global-admin `?tenantId=`; tenant-bound pinned; 404-over-403).

Full framework + rationale: `docs/implementation/TASK-504-Capability-Settings-Control-Architecture/README.md` §3–§5.

---

## 7. Known internal inconsistencies (verified 2026-07-04)

1. ~~Service-layer direct-Prisma rule violated in consultation/platform-metrics services~~ (remediated in TASK-414): both services now go through domain repository methods (`ConsultationRepository.findCreatedInRange`, plus aggregate methods on `AudioRecordingRepository`/`SummaryMetaRepository`/`MediaRepository`/`TenantBucketRepository`); zero `databaseService` references remain in either file.
2. ...and those diagnostics don't fail CI because `packages/config-eslint/flat/library.js` loads `eslint-plugin-only-warn`, downgrading everything in `packages/*` to warnings. The architecture rules are hard errors in `apps/api` (which uses `flat/nestjs.js`) but effectively advisory in `packages/applications`.
3. Excluded-service debt is codified: the `flat/core.js` service-boundary `ignores` still exempts `services/audit/**`, `services/tenant/**`, `services/user/userRoleAssignment/**` from the repository rule; `tenant.service.ts` and `audit/authorization-audit.service.ts` still use `databaseService.client` directly.
4. Test placement and naming are split: unit tests use both colocated `__tests__/` folders AND sibling `*.test.ts` files (e.g. `packages/applications/src/common/applyChangesToEntity.test.ts` next to `packages/applications/src/common/__tests__/cursorPagination.test.ts`); Python test dirs are `src/<pkg>/tests/` for smr/guardrail/harness but top-level `tests/` for stt-v2/nlp; e2e uses `.spec.ts` while unit uses `.test.ts`.
5. ~~Harness missing from CI quality gates~~ (remediated in TASK-414): a `test-harness` job now exists in `.gitlab/ci/test.yml` (mirrors the smr/guardrail pattern; hermetic suite, installs `.[test,eval,rag]`), and `lint-python` (validate.yml) now includes `apps/harness/src/`.
6. Two `CoreUnitOfWorkService` implementations exist: `packages/domains/src/common/unitsOfWork/core/core.unitOfWork.ts` (used by repositories) and `packages/applications/src/services/baseServices/unitsOfWork/core/core.unitOfWork.ts` (application wrapper). The applications one documents that the `startTransaction/endTransaction` wrapper pattern has NO production callers — the proven pattern is `baseClient.$transaction(callback)`; docs that recommend `startTransaction()/endTransaction()` are stale.
7. ~~Legacy naming drift~~ (remediated in TASK-414): the dead `dev:admin` root script and the TTS contract test/schemas were removed; the `.gitlab-ci.yml` header now marks ui-playground as deprecated.
8. ~~ESLint version split (legacy eslintrc under `ESLINT_USE_FLAT_CONFIG=false`, config-eslint pinned to ESLint 8 + typescript-eslint 7)~~ (remediated in TASK-418): the whole estate now runs ESLint 9 flat config from the `packages/config-eslint/flat/` preset family (typescript-eslint 8; rule parity verified per package); the legacy presets and env escape were deleted.
9. Tailwind config duality: `packages/config-tailwind/tailwind.config.ts` exists but is an empty shell; the actual theme lives in `packages/ui/src/styles/globals.css` (Tailwind v4 CSS-first). Some package.json files still carry the config-tailwind dependency for legacy reasons.
10. Auth decorators live in `packages/applications` (`src/authorization/decorators.ts`) but are re-exported through `apps/api/src/decorators/index.ts`; both import paths appear in controllers. Prefer the `../../decorators` re-export inside `apps/api`.

---

## 8. Quick reference card — the 20 most important do/don'ts

1. DO follow the Prisma model section order: meta (`metaData`,`version`,`id uuid(7)`) → `tenantId` → core → resource status → audit → tags → relations → named indexes + `@@schema("core")` (`packages/database/src/prisma/db_main/user.prisma`).
2. DO edit schema under `packages/database/src/prisma/db_main/*.prisma` and create migrations with `pnpm db:migrate:create` / `db:migrate`; DON'T edit committed migration SQL.
3. DO use `getExtendedPrismaClient()` / `CoreDatabaseService.client`; DON'T import `getPlatformAdminPrismaClient_Unscoped` (lint-blocked; bypasses tenant scope AND soft delete).
4. DON'T touch `this.databaseService.client` in controllers (`arcaai-internal/no-controller-direct-prisma`) or in application services (`no-restricted-syntax`) — go through a domain repository.
5. DON'T read `process.env.SMR_URL|STT_V2_URL|NLP_URL|GUARDRAIL_URL|HARNESS_URL|SMR_SERVICE_URL` in `apps/api/src/modules/**` — inject `IConfigService.getConfigValue(...)`.
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
16. DO run Python tooling through conda `arcaenv` (`conda run -n arcaenv ...`, `pnpm py:<svc>:test|lint|format|typecheck`); dependencies change → update the member `pyproject.toml` then `uv lock` at the root.
17. DO give every FastAPI service pydantic-settings config with its `env_prefix`, structlog logging, `/api/v1/health`, and `X-Service-Token` middleware (constant-time compare; empty token = dev bypass).
18. DO put unit tests in colocated `__tests__/*.test.ts`, integration tests in `**/integration/**` (sequential runner), API e2e in `apps/api/tests/e2e/*.spec.ts`; run with `pnpm test:unit` / `test:integration` / `test:e2e` (all load `.env.test`).
19. DO keep env files by NODE_ENV (`.env.dev`/`.env.test`/`.env.production`); CI/production load NO env files (host env only); new runtime env vars must be added to `turbo.json#globalEnv`; never commit secrets (gitleaks pre-commit + CI gate).
20. DO build UI as React 19 function components (no `forwardRef`) extending shadcn primitives with `cva` variants, `data-slot` attributes, `cn()` merging, and tokens from `packages/ui/src/styles/globals.css`; keep SDK state in the internal Zustand store behind hooks (`packages/agentic-sdk-v2/src/hooks/`).
