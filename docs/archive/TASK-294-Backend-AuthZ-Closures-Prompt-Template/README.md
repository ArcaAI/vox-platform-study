# TASK-294 — Backend AuthZ Closures + Personal Prompt-Template Scope

| | |
|---|---|
| Ticket Number | TASK-294 |
| Type | bugfix / security |
| Parent | [TASK-293 Vox SDK Deep Assessment V2](../TASK-293-Vox-SDK-Deep-Assessment-V2/README.md) |
| Source | [`01-personalization-settings.md` DEF-C1..C4](../TASK-293-Vox-SDK-Deep-Assessment-V2/01-personalization-settings.md), Wave 5A items W5A-10, Wave 5B items W5B-7 + W5B-8 |
| Created | 2026-05-24 |
| Updated | 2026-05-24 |
| Status | **Completed** |
| Owner | implementer subagent |

---

## 1. Requirement Analysis

### Description

Close four cross-tenant IDOR / authorization defects in the prompt-template + department-prompt-config surface, and add the schema-level affordance for personal (USER_PERSONAL) overlays so the doctor's personal prompt template can be stored and protected without touching the tenant or department defaults.

Concretely, four defects must be remediated:

- **DEF-C1 (Critical)** — `PromptTemplate` schema cannot model personal overlays. No `ownerUserId`, no `scope` discriminator → BR-1 ("personal prompt template MUST NOT impact tenant/department defaults") is structurally unimplementable.
- **DEF-C2 (Critical)** — `PromptManagementController` is decorated `@Authorize()` (no permissions); `PromptManagementService.{updatePromptTemplate, getPromptTemplate, softDeletePromptTemplate}` never verify `tenantId` ownership nor caller's role. Any authenticated user can mutate any tenant's templates.
- **DEF-C3 (Critical)** — `DepartmentController.updatePromptConfig` `@Authorize()` is empty; `DepartmentService.updatePromptConfig` never checks `department.tenantId === this.tenantId`. Cross-tenant department-defaults takeover.
- **DEF-C4 (Critical)** — SDK calls `POST /prompt-templates/assign-department` but the backend route does not exist. The DTO `AssignDepartmentPromptRequest` is already defined in `@arcaai/applications` but unused.

### Business Context

From TASK-293 Top-10 risks #5 and #6 and Wave 5A item **W5A-10** + Wave 5B items **W5B-7** and **W5B-8**:

> "Cross-tenant IDOR on prompt-templates and department prompt-config." — Direct violation of BR #1 (personal changes MUST NOT impact tenant defaults). Any authenticated user can mutate any tenant's prompt templates and any department's default prompts.
>
> "`PromptTemplate` schema cannot model personal overlays."

These are the highest-severity findings in the Personalization detail file. They block multi-tenant production use until closed.

### Acceptance Criteria

1. `PromptTemplate` row carries a `scope: 'TENANT_DEFAULT' | 'DEPARTMENT_DEFAULT' | 'USER_PERSONAL'` discriminator and an optional `ownerUserId` FK to `User`.
2. Indexes `[tenantId, scope]`, `[ownerUserId]`, and unique `[tenantId, departmentId, ownerUserId, name]` are present.
3. Migration is **additive** (no `DELETE`/`DROP`/`TRUNCATE`); every existing row is backfilled to `scope = TENANT_DEFAULT` (NULL `ownerUserId`) via `UPDATE`.
4. `PromptManagementController`:
    - class-level `@Authorize(['read', 'PromptTemplate'])`
    - `@Patch` ⇒ `@Authorize(['update', 'PromptTemplate'])`
    - `@Delete` ⇒ `@Authorize(['delete', 'PromptTemplate'])`
    - `@Post` (create) ⇒ `@Authorize(['create', 'PromptTemplate'])`
    - new `@Post('assign-department')` ⇒ `@Authorize(['manage', 'Department'])`
5. `PromptManagementService` mutations (`updatePromptTemplate`, `softDeletePromptTemplate`, `getPromptTemplate`):
    - assert `template.tenantId === this.tenantId` → `NotFoundException` if mismatch (do not leak existence).
    - if `template.scope === USER_PERSONAL` and `template.ownerUserId !== this.requestUserId` → `ForbiddenException`.
    - if `template.scope !== USER_PERSONAL` and caller lacks `manage PromptTemplate` ability → `ForbiddenException`.
6. New service methods:
    - `listDefaultsForDepartment(departmentId)` — returns `TENANT_DEFAULT` + `DEPARTMENT_DEFAULT` templates scoped to caller's tenant + department.
    - `listMyPersonalForDepartment(departmentId)` — returns `USER_PERSONAL` templates where `ownerUserId === this.requestUserId`.
    - `createPersonal(input)` — forces `scope = USER_PERSONAL`, stamps `ownerUserId = this.requestUserId`.
    - Existing `createPromptTemplate(...)` defaults to `scope = TENANT_DEFAULT` and requires `manage PromptTemplate` ability.
7. `DepartmentController.updatePromptConfig` is gated on `@Authorize(['manage', 'Department'])`.
8. `DepartmentService.updatePromptConfig` validates `department.tenantId === this.tenantId` at the top and throws `NotFoundException` on mismatch.
9. `POST /prompt-templates/assign-department` is implemented; delegates to `DepartmentService.updatePromptConfig` after tenant scope enforcement.
10. All Wave-5A and Wave-5B unit tests for these defects are RED on `main` and GREEN on this branch.
11. `pnpm test:unit --filter @arcaai/{domains,applications,api}` and `pnpm build --filter @arcaai/{domains,applications,api}` PASS.

---

## 2. Current State Evaluation

### Schema (`packages/database/src/prisma/db_main/prompt-template.prisma`)

```
model PromptTemplate {
    id, tenantId, name, description, content, category,
    variables, currentVersionNumber, departmentId,
    resourceStatus, createdBy, updatedBy, createdAt, updatedAt, tags
}
@@unique([tenantId, name])
@@index([tenantId, departmentId, category])
```

No `scope`, no `ownerUserId` — DEF-C1.

### Domain layer

- Entity `PromptTemplateEntity` carries name/description/content/category/variables/currentVersionNumber/departmentId/tags.
- Factory `PromptTemplateFactory.CreatePromptTemplate` accepts the same.
- Mapper `PromptTemplateEntityMapper` uses `AutoClassMapper` (automatically picks up new fields once entity + model define them).
- Repository `PromptTemplateRepository` has `findByName`, `findByDepartment`, `findByCategory`.

### Service (`packages/applications/src/services/prompt-management/prompt-management.service.ts`)

- `createPromptTemplate(dto)` — no scope/owner stamping. No role check.
- `updatePromptTemplate(id, dto)` — `findById` then write; **no tenant check, no scope/owner check** (DEF-C2 root cause).
- `getPromptTemplate(id)` — no tenant check.
- `softDeletePromptTemplate(id)` — no tenant check.
- `listPromptTemplates({category, departmentId, search, includeDisabled})` — already tenant-scoped via `qb.Where({ tenantId })`.

### Controllers

- `apps/api/src/modules/prompt-management/prompt-management.controller.ts:14-17` — `@Controller('prompt-templates') @Authorize()` (no permissions). DEF-C2.
- `apps/api/src/modules/department/department.controller.ts:13-16,97-108` — `@Controller('admin/departments') @Authorize()` + `updatePromptConfig` has no method-level guard. DEF-C3.

### Department service (`packages/applications/src/services/department/department.service.ts:216-238`)

`updatePromptConfig(id, dto)`:

```
const department = await this.departmentRepository.findById(id);
if (!department) throw NotFoundException(...);
// NO tenant check; compare with update() at line 169-171 which DOES check.
```

DEF-C3 root cause.

### Missing route

`POST /prompt-templates/assign-department` — SDK calls; no controller handler exists. DEF-C4. DTO `AssignDepartmentPromptRequest` already exists in `packages/applications/src/services/prompt-management/dto/assign-department-prompt.request.ts`.

### Existing seed policy (informational)

`packages/database/src/prisma/db_main/seed/01-policy.ts:276` already grants:

- `{ action: 'manage', subject: 'PromptTemplate', conditions: { tenantId: '${context.tenantId}' } }` (via `prompt-template-manage` policy)
- Tenant admins also have `{ action: 'manage', subject: 'Department', conditions: { tenantId: '${context.tenantId}' } }` via the standard tenant-admin policy.

So gating on `['manage', 'PromptTemplate']` / `['manage', 'Department']` at the controller works without seed changes. The CASL ability is available on the CLS context as `this.clsService.get('userAbility')`.

### Test files in scope (existing or to extend)

| File | Action |
|---|---|
| `packages/domains/src/entities/generated/core/__tests__/PromptTemplateEntity.test.ts` | EXTEND — add scope + ownerUserId field/setter coverage |
| `packages/domains/src/factories/generated/core/__tests__/PromptTemplateFactory.test.ts` | EXTEND — default scope = TENANT_DEFAULT, no owner |
| `packages/applications/src/services/prompt-management/__tests__/prompt-management.service.test.ts` | EXTEND — tenant/owner/manage assertions; new methods |
| `apps/api/src/modules/prompt-management/__tests__/prompt-management.controller.test.ts` | EXTEND — assign-department route |
| `packages/applications/src/services/department/__tests__/department-prompt-config.service.test.ts` | NEW |
| `apps/api/src/modules/department/__tests__/department-prompt-config.controller.test.ts` | NEW |

---

## 3. Implementation Plan (TDD order)

### Layer order

```
Prisma schema   →  domain layer (entity / factory / mapper / model / repo)
                →  application service (PromptManagementService, DepartmentService)
                →  API controller + DTOs
```

### 3.1 DEF-C1 — Schema + domain layer

1. **RED**: extend `PromptTemplateEntity.test.ts` and `PromptTemplateFactory.test.ts` to assert:
    - new getters `scope` (string), `ownerUserId` (string|null).
    - setter on `scope` and `ownerUserId` triggers change tracking.
    - factory default: `scope === 'TENANT_DEFAULT'`, `ownerUserId === null`.
    - factory overrides honored when caller passes `scope`, `ownerUserId`.
2. Tests fail because fields/getters do not exist on entity/factory yet.
3. **GREEN**:
    - Add `PromptTemplateScope` enum + `scope`, `ownerUserId` to `prompt-template.prisma` with the indexes/unique constraint per spec.
    - Hand-author the additive migration SQL under `packages/database/src/prisma/db_main/migrations/20260524000000_add_prompt_template_scope/migration.sql`.
    - Update `PromptTemplateModel`, `PromptTemplateEntity`, `PromptTemplateFactory`, mapper (handlers stay no-op since `AutoClassMapper` covers it).
    - Add the `OwnedPromptTemplates` relation back-reference on `User` model.
    - Re-run tests → GREEN.
4. **REFACTOR**: deduplicate.

### 3.2 DEF-C2 — Service authz + scope-aware methods

1. **RED** in `prompt-management.service.test.ts`:
    - `updatePromptTemplate` throws `NotFoundException` when `template.tenantId !== ctx.tenantId`.
    - `getPromptTemplate` returns `null` (or throws NotFound — leak-free) on cross-tenant.
    - `softDeletePromptTemplate` throws `NotFoundException` cross-tenant.
    - `updatePromptTemplate` on a `USER_PERSONAL` template owned by a *different* user throws `ForbiddenException`.
    - `updatePromptTemplate` on a `TENANT_DEFAULT` template by a caller without `manage PromptTemplate` ability throws `ForbiddenException`.
    - `createPersonal(dto)` stamps `scope = USER_PERSONAL` and `ownerUserId = ctx.requestUserId`.
    - `createPromptTemplate(dto)` (default) requires `manage` ability and stamps `scope = TENANT_DEFAULT`.
    - `listDefaultsForDepartment(deptId)` returns templates matching `tenantId == ctx.tenantId AND (scope IN (TENANT_DEFAULT, DEPARTMENT_DEFAULT))` and `departmentId == deptId` for the department-scoped subset.
    - `listMyPersonalForDepartment(deptId)` filters by `scope = USER_PERSONAL AND ownerUserId = ctx.requestUserId AND departmentId = deptId`.
2. **GREEN** — extend `PromptManagementService` with private `assertCanMutate(template)` helper; wire scope into create + new list methods. Service reads CASL ability via `this.clsService.get('userAbility')`.
3. **REFACTOR** — extract a single `loadOwnedTemplate(id)` helper for the three read/mutate paths.

### 3.3 DEF-C2 — Controller permission tuples

1. **RED** in `prompt-management.controller.test.ts`:
    - Verify the controller's decorator metadata contains the expected permission tuples (`Reflect.getMetadata('required_permissions', …)`).
2. **GREEN** — replace `@Authorize()` with the per-action tuples in spec §1 acceptance.
3. **REFACTOR** — none.

### 3.4 DEF-C3 — Department tenant guard

1. **RED** in new file `packages/applications/src/services/department/__tests__/department-prompt-config.service.test.ts`:
    - `updatePromptConfig` throws `NotFoundException` when `department.tenantId !== ctx.tenantId`.
    - `updatePromptConfig` throws `BadRequestException` when `ctx.tenantId` is null.
    - Existing behavior (404 on missing, change-tracking, event broadcast) preserved.
2. **GREEN** — mirror the same `tenantId` precondition + comparison pattern already used at `DepartmentService.update()` lines 158-171.
3. **REFACTOR** — none.

### 3.5 DEF-C3 — Department controller `@Authorize`

1. **RED** in new `department-prompt-config.controller.test.ts`:
    - Verify decorator metadata on `updatePromptConfig` includes `['manage', 'Department']`.
2. **GREEN** — add `@Authorize(['manage', 'Department'])` directly on `updatePromptConfig` (do NOT touch other handlers; do NOT change the class-level `@Authorize()`).
3. **REFACTOR** — none.

### 3.6 DEF-C4 — POST /prompt-templates/assign-department

1. **RED** in `prompt-management.controller.test.ts`:
    - Add a controller method `assignToDepartment(dto)`.
    - The decorator includes `['manage', 'Department']`.
    - The controller forwards to a new service method `assignToDepartment(dto)`.
2. **RED** in `prompt-management.service.test.ts`:
    - `assignToDepartment(dto)` must verify the target department belongs to caller's tenant (via injected `DepartmentRepository` or by delegating to `DepartmentService.updatePromptConfig`, which now enforces it).
    - Sets the department's `newPatientPromptId` / `revisitPromptId` as per DTO.
3. **GREEN** — add the controller method + service method.
    - Service receives `DepartmentService` via constructor (cross-module DI in the same `PromptManagementServiceModule` imports). If circular, the service can use `DepartmentRepository` directly + the same tenant-check, mirroring `DepartmentService.updatePromptConfig`.
    - I will **delegate via the constructor-injected `IDepartmentService`** if no circular import; if circular, will document and fall back to inline tenant check using `DepartmentRepository`.
4. **REFACTOR** — minimize duplication.

### 3.7 Verification

Per `01-development-workflow.mdc` quality gates:

1. `pnpm db:generate` — verify the new Prisma client compiles.
2. `pnpm test:unit --filter @arcaai/domains`
3. `pnpm test:unit --filter @arcaai/applications`
4. `pnpm test:unit --filter @arcaai/api` (also tried via `pnpm --filter @arcaai/api test:unit`)
5. `pnpm build --filter @arcaai/domains @arcaai/applications @arcaai/api`
6. `ReadLints` on every modified TS file.
7. Capture all actual outputs into the **Verification Evidence** section below.

### 3.8 Constraints honored

- Migration is additive: only `ALTER TABLE ... ADD COLUMN`, `CREATE TYPE`, `CREATE INDEX`, and a one-time backfill `UPDATE`. No `DELETE`/`DROP`/`TRUNCATE`.
- Migration is NOT applied at runtime by this task — the developer applies it manually via `pnpm db:migrate:deploy`.
- No npm/pnpm dependency added.
- Other agents' files (auth/voice-profile/streaming/etc.) untouched.
- Only `updatePromptConfig` is modified inside `DepartmentController` and `DepartmentService`.

---

## 4. Implementation Summary

### DEF-C1 — Schema + domain (TENANT_DEFAULT / DEPARTMENT_DEFAULT / USER_PERSONAL)

- `packages/database/src/prisma/db_main/prompt-template.prisma` — added `enum PromptTemplateScope { TENANT_DEFAULT | DEPARTMENT_DEFAULT | USER_PERSONAL }`, `scope` (NOT NULL DEFAULT TENANT_DEFAULT), `ownerUserId` (nullable FK → `User.id`), composite unique `[tenantId, departmentId, ownerUserId, name]` and indexes `[tenantId, scope]` + `[ownerUserId]`.
- `packages/database/src/prisma/db_main/user.prisma` — added reverse relation `OwnedPromptTemplates  PromptTemplate[] @relation("_User_OwnedPromptTemplates")`.
- **Migration** (additive, NO `DELETE`/`DROP`/`TRUNCATE`): `packages/database/src/prisma/db_main/migrations/20260524000000_add_prompt_template_scope/migration.sql`. Backfills existing rows to `TENANT_DEFAULT` via `UPDATE`. **User must apply this migration manually.**
- `packages/domains/src/entities/generated/core/PromptTemplateEntity.ts` — added `scope` + `ownerUserId` private fields, getters/setters wired through `setProperty()` so `hasChanges` tracks them. New TypeScript type `export type PromptTemplateScope = 'TENANT_DEFAULT' | 'DEPARTMENT_DEFAULT' | 'USER_PERSONAL'`. New `Owner` relation getter/setter.
- `packages/domains/src/factories/generated/core/PromptTemplateFactory.ts` — exposes `scope?` + `ownerUserId?` in `CreatePromptTemplateProps`, defaulting to `'TENANT_DEFAULT'` / `null`.
- `packages/domains/src/models/generated/core/PromptTemplateModel.ts` — added `scope: string | null` + `ownerUserId: string | null` so `AutoClassMapper` round-trips both columns.
- `packages/domains/src/repositories/generated/core/PromptTemplateRepository.ts` — added `findMyPersonalForDepartment(tenantId, ownerUserId, departmentId)` for the W5B-7 backend list endpoint.
- Tests extended: `PromptTemplateEntity.test.ts` (+5 scope/ownerUserId cases) and `PromptTemplateFactory.test.ts` (+3 scope/ownerUserId cases).

### DEF-C2 — Tenant + owner + manage-ability guards in service + CASL tuples in controller

- `packages/applications/src/services/prompt-management/IPromptManagementService.ts` — added abstract methods `createPersonal`, `listDefaultsForDepartment`, `listMyPersonalForDepartment`, and `assignToDepartment`.
- `packages/applications/src/services/prompt-management/prompt-management.service.module.ts` — imports `DepartmentServiceModule` to resolve `IDepartmentService` for the new `assignToDepartment` delegation.
- `packages/applications/src/services/prompt-management/prompt-management.service.ts`:
  - **Constructor** — injects `@Inject(IDepartmentService) departmentService: IDepartmentService` (6th positional arg).
  - **`createPromptTemplate`** — now requires `manage PromptTemplate` ability, stamps `scope=TENANT_DEFAULT`, `ownerUserId=null`.
  - **`createPersonal`** — forces `scope=USER_PERSONAL`, stamps `ownerUserId=requestUserId`, does NOT require manage ability.
  - **`updatePromptTemplate` + `softDeletePromptTemplate`** — call `assertOwnedByTenant` (404 on cross-tenant) and `assertCanMutate` (USER_PERSONAL owner check or manage ability for defaults).
  - **`getPromptTemplate`** — returns `null` (no existence leak) on cross-tenant lookup or when caller is not the owner of a USER_PERSONAL template.
  - **`listDefaultsForDepartment`** — query `(scope=TENANT_DEFAULT) OR (scope=DEPARTMENT_DEFAULT AND departmentId=:dept)` via `qb.Where + qb.WhereOr`.
  - **`listMyPersonalForDepartment`** — delegates to `repository.findMyPersonalForDepartment(tenant, user, dept)`.
  - **`assignToDepartment`** — delegates to `IDepartmentService.updatePromptConfig` (DEF-C4); tenant guard is enforced inside DepartmentService (DEF-C3).
- `apps/api/src/modules/prompt-management/prompt-management.controller.ts`:
  - Class-level `@Authorize(['read', 'PromptTemplate'])`.
  - `create` → `@Authorize(['create', 'PromptTemplate'])`.
  - `update` (PATCH) → `@Authorize(['update', 'PromptTemplate'])`.
  - `remove` (DELETE) → `@Authorize(['delete', 'PromptTemplate'])`.
  - `activateVersion` (POST) → `@Authorize(['update', 'PromptTemplate'])`.
  - `assignDepartment` (POST `/assign-department`, DEF-C4) → `@Authorize(['manage', 'Department'])`.
- Tests extended: `prompt-management.service.test.ts` (+19 new authz/scope/list/createPersonal/assign tests) and `prompt-management.controller.test.ts` (+9 new metadata + DEF-C4 route tests).

### DEF-C3 — Department tenant guard

- `packages/applications/src/services/department/department.service.ts` — `updatePromptConfig` now mirrors the pattern in `update`/`deleteById`: pulls `this.tenantId`, throws `BadRequestException('Tenant ID is required')` when missing, throws `NotFoundException` when `department.tenantId !== tenantId` (no existence leak). **Only `updatePromptConfig` was touched** per spec.
- `apps/api/src/modules/department/department.controller.ts` — `updatePromptConfig` handler gated on `@Authorize(['manage', 'Department'])`. **Only this single handler was touched** per spec.
- New test files: `packages/applications/src/services/department/__tests__/department-prompt-config.service.test.ts` (4 tests) and `apps/api/src/modules/department/__tests__/department-prompt-config.controller.test.ts` (1 test).

### DEF-C4 — POST /prompt-templates/assign-department

- New route exposed in `PromptManagementController.assignDepartment` (`POST /prompt-templates/assign-department`, HTTP 200). Body validates against the existing `AssignDepartmentPromptRequest` DTO. Method delegates to `IPromptManagementService.assignToDepartment → IDepartmentService.updatePromptConfig`. Tenant ownership is enforced by `DepartmentService.updatePromptConfig` (DEF-C3).

### Endpoints added / changed

| Method | Path | Authz | Notes |
|---|---|---|---|
| `POST` | `/prompt-templates/assign-department` | `manage Department` | **New (DEF-C4)** — assigns prompt templates to a department |
| (class) | `/prompt-templates/*` | `read PromptTemplate` | Was `@Authorize()` (no tuple); now class-level `read` |
| `POST` | `/prompt-templates` | `create PromptTemplate` | Service now also requires `manage PromptTemplate` ability |
| `PATCH` | `/prompt-templates/:id` | `update PromptTemplate` | + service tenant/owner/manage guard |
| `DELETE` | `/prompt-templates/:id` | `delete PromptTemplate` | + service tenant/owner/manage guard |
| `POST` | `/prompt-templates/:id/versions/:n/activate` | `update PromptTemplate` | Same tuple as PATCH |
| `PATCH` | `/admin/departments/:id/prompt-config` | `manage Department` | Service now enforces tenant ownership (DEF-C3) |

### New service methods (no controller surface yet)

- `IPromptManagementService.createPersonal(dto)`
- `IPromptManagementService.listDefaultsForDepartment(departmentId)`
- `IPromptManagementService.listMyPersonalForDepartment(departmentId)`

These are wired and unit-tested but not exposed via the controller in this PR (the spec only required them in the service split). Routes can be added in a follow-up ticket when the SDK consumer arrives.

### Migration

- Filename: `20260524000000_add_prompt_template_scope/migration.sql`
- Operations: `CREATE TYPE` (enum), `ALTER TABLE ADD COLUMN` (scope, ownerUserId), `UPDATE` (backfill TENANT_DEFAULT), `CREATE INDEX` (×2), `CREATE UNIQUE INDEX` (×1), `ALTER TABLE ADD CONSTRAINT` (FK on `ownerUserId → User.id` `ON DELETE SET NULL ON UPDATE CASCADE`).
- Zero `DROP`/`DELETE`/`TRUNCATE`. Backward compatible.
- **Action required from user**: run `prisma migrate deploy` (or apply this SQL manually) against the target databases.

### Deviations

- The spec mentioned `AuthorizationGuard`'s short-circuit on empty `required` is intentional and must not be changed — confirmed and left alone.
- The new `createPersonal` / `listDefaultsForDepartment` / `listMyPersonalForDepartment` methods are added at the service layer only (no controller routes) because the spec explicitly requested a "service split" and did not request controller routes.
- `requestUserId` typing in `BaseService` returns `string | null` but the implementation returns `clsService.get('user')?.id` which can be `undefined`; matched existing project behavior.

## 5. Verification Evidence

### 5.1 `pnpm db:generate`

```
> @arcaai/database@0.1.0 db:generate
> prisma generate && pnpm --filter @arcaai/tools generate-prisma-index

Prisma schema loaded from src/prisma/db_main.
✔ Generated Prisma Client (7.5.0) to ./src/generated/core-prisma-client in 152ms

> @arcaai/tools@0.1.0 generate-prisma-index
> ts-node src/generate-prisma-index.ts
✅ Index file generated successfully!
```

### 5.2 Unit tests

`pnpm test:unit packages/domains`:

```
Test Files  61 passed | 1 skipped (62)
     Tests  974 passed | 9 todo (983)
  Duration  2.23s
```

`pnpm test:unit packages/applications`:

```
Test Files  138 passed (138)
     Tests  3803 passed (3803)
  Duration  5.33s
```

`pnpm --filter @arcaai/api test` (API workspace):

```
Test Files  47 passed (47)
     Tests  1125 passed (1125)
  Duration  10.65s
```

### 5.3 TASK-294 specific assertions

```
✓ PromptTemplateEntity > should default scope to TENANT_DEFAULT when omitted
✓ PromptTemplateEntity > should accept USER_PERSONAL scope with ownerUserId in constructor
✓ PromptTemplateEntity > should accept DEPARTMENT_DEFAULT scope in constructor
✓ PromptTemplateEntity > should track scope change via setter
✓ PromptTemplateEntity > should track ownerUserId change via setter
✓ PromptTemplateFactory > should default scope to TENANT_DEFAULT and ownerUserId to null
✓ PromptTemplateFactory > should honor explicit USER_PERSONAL scope with ownerUserId
✓ PromptTemplateFactory > should honor explicit DEPARTMENT_DEFAULT scope

✓ PromptManagementService > Authorization & tenant scope (DEF-C2)
  > updatePromptTemplate > throws NotFoundException when template tenant does not match caller tenant
  > updatePromptTemplate > throws ForbiddenException on USER_PERSONAL owned by a different user
  > updatePromptTemplate > throws ForbiddenException on TENANT_DEFAULT when caller lacks manage ability
  > updatePromptTemplate > allows caller to update own USER_PERSONAL template
  > getPromptTemplate > returns null on cross-tenant lookup (no existence leak)
  > getPromptTemplate > returns the template when tenant matches
  > getPromptTemplate > returns null when caller is not the owner of a USER_PERSONAL template
  > softDeletePromptTemplate > throws NotFoundException on cross-tenant delete attempt
  > softDeletePromptTemplate > throws ForbiddenException when caller does not own a USER_PERSONAL template
  > softDeletePromptTemplate > throws ForbiddenException when caller lacks manage on a TENANT_DEFAULT
✓ PromptManagementService > createPromptTemplate scope defaults (DEF-C2)
  > defaults newly created template to scope=TENANT_DEFAULT
  > throws ForbiddenException when caller lacks manage ability for default creation
✓ PromptManagementService > createPersonal (DEF-C2 W5B-7)
  > stamps scope=USER_PERSONAL and ownerUserId=requestUserId
  > throws BadRequestException when tenantId is missing
  > does NOT require manage ability
✓ PromptManagementService > listDefaultsForDepartment (DEF-C2 W5B-7)
  > returns templates with scope=TENANT_DEFAULT or DEPARTMENT_DEFAULT scoped to the department
  > throws BadRequestException when tenantId is missing
✓ PromptManagementService > listMyPersonalForDepartment (DEF-C2 W5B-7)
  > delegates to findMyPersonalForDepartment with caller tenant + user
  > throws BadRequestException when tenantId is missing
  > throws BadRequestException when caller user id is missing
✓ PromptManagementService > assignToDepartment (DEF-C4 W5B-8)
  > delegates to DepartmentService.updatePromptConfig with the right fields
  > propagates ForbiddenException / NotFoundException from DepartmentService (tenant guard)

✓ DepartmentService.updatePromptConfig (TASK-294 DEF-C3)
  > throws BadRequestException when caller has no tenantId
  > throws NotFoundException when department does not exist
  > throws NotFoundException when department.tenantId !== caller tenantId (DEF-C3 — no existence leak)
  > succeeds when department.tenantId matches caller tenantId

✓ PromptManagementController > Authorization decorators (DEF-C2)
  > should require ["read","PromptTemplate"] at class level
  > should require ["create","PromptTemplate"] on create (POST /prompt-templates)
  > should require ["update","PromptTemplate"] on update (PATCH /prompt-templates/:id)
  > should require ["delete","PromptTemplate"] on remove (DELETE /prompt-templates/:id)
  > should require ["update","PromptTemplate"] on activateVersion (POST /prompt-templates/:id/versions/:n/activate)
  > should require ["manage","Department"] on assignDepartment (POST /prompt-templates/assign-department)
✓ PromptManagementController > POST /prompt-templates/assign-department (DEF-C4)
  > should delegate to service.assignToDepartment with the request body
  > should return the value produced by the service (no transformation)
  > should propagate errors from the service (e.g., tenant guard NotFoundException)

✓ DepartmentController.updatePromptConfig — DEF-C3 authorization metadata
  > updatePromptConfig should require ["manage","Department"] permissions
```

### 5.4 Build

`packages/domains` (`tsc`): **PASS** (0 errors).
`packages/applications` (`tsc`): **PASS** (0 errors).
`@arcaai/api` (`nest build`): pre-existing TS2352 error in `apps/api/src/modules/streaming/stt-ws.gateway.ts:140` (outside this ticket's scope — see hand-off below). All files I own type-check cleanly via `tsc --noEmit -p apps/api/tsconfig.build.json` (only the streaming error remains).

### 5.5 Lint

`pnpm lint --filter @arcaai/applications --filter @arcaai/domains --filter @arcaai/api`:

```
Tasks:    9 successful, 9 total
0 errors, 0 warnings on any file owned by TASK-294
```

`ReadLints` on every modified/new file: **No linter errors found.**

## 6. Out of Scope / Hand-off

### Pre-existing build failure (NOT introduced by TASK-294)

- `apps/api/src/modules/streaming/stt-ws.gateway.ts:140` — `TS2352: Conversion of type 'StreamingTranscriptMessage' to type '{ [key: string]: unknown; type: string; }' may be a mistake...`. The `apps/api/src/modules/streaming/**` directory is explicitly **forbidden** from this ticket; this error is owned by whoever is implementing the SSE streaming work. The api unit tests still pass because Vitest runs against TS source via tsx, not the build artifact.

### Migration application

- The migration `20260524000000_add_prompt_template_scope/migration.sql` was hand-authored (NOT generated by `prisma migrate dev`) per the constraint "Do NOT run `pnpm db:migrate dev` against a live database." It is additive and idempotent. **User must run it manually** (`prisma migrate deploy` / `psql -f migration.sql`).

### Future work (deferred)

- **Controller routes for `createPersonal` / `listDefaultsForDepartment` / `listMyPersonalForDepartment`** — the spec only required adding them to the service surface; routes can be wired in a follow-up when the doctor-personal-prompt UI lands.
- **Seed updates** — `packages/database/src/prisma/seed.ts` currently inserts prompt templates without `scope`; existing rows will use the DB default `TENANT_DEFAULT` so no immediate action is required, but the seed could be tightened to make the value explicit in a future cleanup.

## 7. Change History

| Date | Author | Notes |
|---|---|---|
| 2026-05-24 | implementer subagent | Created TASK-294. Authored plan for DEF-C1..C4 closures: PromptTemplate scope schema + backend authorization gating. |
| 2026-05-24 | implementer subagent | Implemented all four defects via TDD. Domain layer + service layer + controller decorators + DEF-C4 route. Migration `20260524000000_add_prompt_template_scope` ready for manual apply. All domain (974), applications (3803), and api (1125) tests green; lint clean on every modified file. Status → Completed. |
