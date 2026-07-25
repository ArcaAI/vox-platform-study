# TASK-356 — Phase 1 (Catalog plane) — TDD Implementation Plan

| Field | Value |
|---|---|
| **Ticket** | TASK-356 — Admin-Managed Models & Workflows |
| **Phase** | Phase 1 — Catalog plane (fast win) |
| **Status** | **Plan — awaiting approval** |
| **Date** | 2026-06-14 |
| **Author** | Planner (subagent) |
| **Scope of this doc** | Plan only. No code written. Gate artifact per `.cursor/rules/01-development-workflow.mdc` Phase 3. |

---

## 1. Purpose

Make the **AI model catalog admin-manageable** end-to-end, mirroring the existing
`admin/audio/pipelines` registry 1:1. Concretely:

1. Extend `AiModelFormat` (additive) `+= CTRANSLATE2, FASTER_WHISPER, MLX, GGUF`; evaluate `ModelTaskType += GUARDRAIL`.
2. Fix the medgemma seed row `format → MLX`; register `granite-guardian-4.1-8b`.
3. Add a new CASL subject `AiModel` (tenant grant) and a new `admin/ai-models` controller that exposes the **already-existing** `AiModelService` CRUD with OCC (`If-Match`), `broadcastSysEvent`, and tenant scoping.
4. Add OCC to `AiModelService.update` (it currently has none) so the controller can mirror the pipeline OCC contract.
5. Clone-per-tenant (D-5): clone the SYSTEM `AiModel` catalog into each new tenant inside `tenant.service.ts` `create()`, plus an idempotent backfill for existing tenants.
6. Add a `features/admin/ai-models` UI mirroring `features/admin/audio-pipelines`.

---

## 2. Scope & decisions applied

### In scope
- DB: additive enum migration + medgemma `format` fix + granite registration.
- Domain: regenerate `AiModelFormat` enum (generated artifact).
- Applications: add OCC to `AiModelService.update` + DTO/response/mapper; tenant model-catalog clone in `TenantService`.
- API: new `admin/ai-models` controller + module + app-module registration.
- UI: new `features/admin/ai-models` page, API hooks, route, nav entry.
- Seed: policy subject `AiModel`, granite row, medgemma fix, existing-tenant backfill.

### Decisions applied
- **D-4 (self-convert / model-repo).** Justifies the new formats: `CTRANSLATE2`/`FASTER_WHISPER` (faster-whisper engines), `MLX` (Apple-silicon LM Studio), `GGUF` (llama.cpp / quantized). The catalog must be able to *describe* self-converted artifacts.
- **D-5 (clone-per-tenant).** Each tenant owns an editable clone of the SYSTEM catalog; the SYSTEM rows remain the master template. Cloning composes with the existing `GlobalSetting` clone-from-`__GLOBAL__` block.

### Gaps closed
- **G-1** — catalog not admin-manageable (no controller/UI). Closed by §4.4 (API) + §4.5 (UI).
- **G-2** — enum cannot express real model formats used by SMR/STT (MLX/GGUF/CT2/faster-whisper). Closed by §4.1 + §5.
- **G-5** — seed data wrong/incomplete (medgemma `format`, granite missing). Closed by §4.6.

---

## 3. Current state (grounded)

Every claim below is cited as `path:line`.

### 3.1 Database / Prisma
- `AiModelFormat` enum — `packages/database/src/prisma/db_main/enums.prisma:272-279`. Values today: `SAFETENSOR`, `ONNX`, `NEMO`, `PYTORCH` (lines 273-276). `@@schema("core")` (line 278).
- `ModelTaskType` enum — `packages/database/src/prisma/db_main/enums.prisma:80-139`. **No `GUARDRAIL`.** Closest existing values: `TEXT_GENERATION` (line 117), `TEXT_CLASSIFICATION` (line 109), `SUMMARIZATION` (line 115).
- `AiModelDownloadStatus` enum — `enums.prisma:281-288` (unchanged by this plan).
- `AiModel` model — `packages/database/src/prisma/db_main/stt.prisma` (model block; `format AiModelFormat`, `tenantId`, `@@unique([tenantId, slug])`, `_version` column inherited via the base pattern). Tenant-scoped registry.
- **Shared-read tenant scope** — `packages/database/src/extensions/tenant-scope.ts:135` defines `SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000'`; lines 430-438 auto-broaden tenant-scoped reads to `tenantId IN [ctxTenant, SYSTEM_TENANT_ID]`. **Implication:** a tenant's catalog read already returns SYSTEM rows. (See Risk R-1 / Question Q-3.)
- Migration workflow — `packages/database/package.json:22-24`: `db:generate` = `prisma generate && pnpm --filter @arcaai/tools generate-prisma-index`; `db:migrate` = `prisma migrate dev --skip-generate`; `db:migrate:create` = `prisma migrate dev --create-only` (used to author custom additive SQL).

### 3.2 Domain (generated)
- `packages/domains/src/enums/generated/AiModelFormat.ts:5-10` — generated enum with the same 4 values; header carries codegen `eslint-disable` banners (lines 1-3).
- `packages/domains/src/enums/generated/index.ts:22` — `export * from './AiModelFormat'`.
- `packages/domains/src/enums/generated/ResourceType.ts:32` — `AiModel = 'AiModel'` **already exists** (SysEvent resource type ready).
- `packages/domains/src/factories/generated/core/AiModelFactory.ts:36-68` — `CreateAiModel(props)` accepts `tenantId`, `createdBy`, all catalog fields; defaults `downloadStatus = NOT_DOWNLOADED` (line 60); does not require `id`/`version` (factory assigns).
- `packages/domains/src/common/repository.ts` — base `Repository` exposes `updateWithVersion(...)` (OCC), inherited by `AiModelRepository`.
- `packages/domains/src/common/databaseServices/core/core.database.module.ts:6,110` — `AiModelRepository` is imported and registered (provider) — **already wired**.

### 3.3 Applications (the service already exists)
- `packages/applications/src/services/stt/model/aiModel.service.ts`:
  - `create` (lines 24-65): uses `this.tenantId` (CLS), `isSlugUnique` (line 33), `AiModelFactory.CreateAiModel` (line 38), `broadcastSysEvent(ResourceCreated)` (line 58), maps via `AiModelDtoMapper.toResponse` (line 64).
  - `update` (lines 70-115): **NO OCC.** Fetches `findById` (line 78), mutates the entity in place, calls `this.aiModelRepository.update(id, existing)` (line 107) — no `expectedVersion`, no `updateWithVersion`.
  - Constructor injects `AiModelRepository` (line 14); `super(..., ResourceType.AiModel)` (line 18).
  - Also has `getById`, `getBySlug`, `getAll`, `list`, `getByTaskType`, `getDownloadedModels`, `updateDownloadStatus`, `delete` (lines 117+).
- `packages/applications/src/services/stt/model/dto/update-model.request.ts:5-114` — **no `expectedVersion` field** (ends at `tags` line 113).
- `packages/applications/src/services/stt/model/dto/model.response.ts:4-79` — **no top-level `version` field.** Without it the global `ETagInterceptor` cannot stamp an `ETag`, so `If-Match` OCC is impossible (see §3.4).
- `packages/applications/src/services/stt/model/IAiModelService.ts`, `aiModel.dto.mapper.ts`, `aiModel.service.module.ts`, `dto/index.ts`, `index.ts` — service interface, mapper, NestJS module (provides/exports `AiModelService`), DTO barrel.
- **Barrel reachability:** `packages/applications/src/services/stt/index.ts:1-2` re-exports `./pipeline` and `./model`, so `AiModelService`, `AiModelServiceModule`, and the DTOs are importable from `@arcaai/applications` (same path the pipeline controller uses).
- Existing tests: `packages/applications/src/services/stt/model/__tests__/aiModel.service.test.ts` (has local enum mirrors that may need the new format value when used).

### 3.4 API (the mirror)
- `apps/api/src/modules/pipeline/audio-pipeline.controller.ts`:
  - `@Controller('admin/audio/pipelines')` (line 25), class-level `@Authorize(['manage', 'AsrPipeline'])` (line 26), injects `PipelineService` (line 28).
  - `create` POST (line 35), `fetchAll`→`getAllForAdmin` (line 47), `list` paginated (line 56), `fetchById` (line 67), `fetchBySlug` (line 78).
  - `update` PATCH `:id` with `@RequiresIfMatch()` (line 88) + `@ExpectedVersion()` param (line 113); folds the header over the body `expectedVersion` (line 118).
  - `delete` DELETE `:id` (line 130).
  - Decorators imported from `../../decorators` (line 13): `ApiEndpoint, Authorize, ExpectedVersion, RequiresIfMatch`.
- `apps/api/src/interceptors/etag.interceptor.ts:34-57` — global `ETagInterceptor` stamps `ETag: "<version>"` **iff** the response body has a top-level integer `version >= 1`; collection wrappers (`{ data: [...] }`) are skipped (line 53).
- `apps/api/src/app.module.ts:49,249` — `PipelineModule` import + registration (the slot the new module mirrors).
- `apps/api/src/bootstrap/admin-route-permission-audit.ts` — boot-time audit: every `/admin/*` route MUST declare a concrete permission (an empty `@Authorize()` fails the audit). The class-level `@Authorize(['manage','AiModel'])` satisfies it.
- Tenant-scoping precedent for admin controllers: `apps/api/src/modules/harness-admin/harness-admin.controller.ts` (per-method `@Authorize`, `isSuperAdmin()` from `@arcaai/applications`, tenant-pinning helpers).

### 3.5 CASL authorization
- `packages/applications/src/authorization/policy.engine.ts` — abilities built with `createPrismaAbility`; **subjects are plain string literals** (no subject enum). `AiModel` is therefore just a new string.
- `packages/database/src/prisma/db_main/seed/01-policy.ts`:
  - `system-full-access` (GLOBAL) → `{ action: 'manage', subject: 'all' }` (line 52) — **already covers `AiModel` for SUPER_ADMIN**.
  - `tenant-full-access` (TENANT) rules (lines 76-119); `AsrPipeline` grant at line 98 — the insertion point for the new `AiModel` tenant grant.
- `packages/database/src/prisma/db_main/seed/03-role.ts` — `TENANT_ADMIN` already binds `tenant-full-access`, so **no role-seed change** is needed; DOCTOR/NURSE get no `AiModel` grant (→ 403).

### 3.6 tenant.service.ts (clone host)
- `packages/applications/src/services/tenant/tenant.service.ts`:
  - `create()` (lines 61-110): creates tenant → `broadcastSysEvent` (73) → `provisionSystemBuckets` (80) → `provisionTenantConfigs` (90) → `provisionDefaultDepartment` (100), each in its own try/catch.
  - `provisionTenantConfigs(newTenantId)` (lines 165-232): looks up the `__GLOBAL__` tenant by `GLOBAL_TENANT_KEY` (169), reads `globalSettingRepository.findAll({ where: { tenantId: globalTenant.id } })` (190), clones each via factory (198), `create` (211), per-row try/catch (213), warns on zero clones (225).
  - **Source-tenant difference:** GlobalSetting clones from `__GLOBAL__` (a *customer* tenant); the `AiModel` catalog lives under **`SYSTEM_TENANT_ID`** — a different source.
- **SYSTEM_TENANT_ID in the applications layer:** there is precedent for a *local* constant rather than a cross-package import — `packages/applications/src/services/user/userPreferences/userPreferences.service.ts:32-36` declares `const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000'` ("Mirrors `SYSTEM_TENANT_ID`"). The new clone method will follow this precedent.

### 3.7 Seed (AiModel rows)
- `packages/database/src/prisma/db_main/seed/06-stt.ts`:
  - `DEFAULT_TENANT_ID = SYSTEM_TENANT_ID` (line 25) — all catalog rows are platform-wide.
  - Local enum mirrors: `AiModelFormat` (lines 39-44 — `SAFETENSOR/ONNX/NEMO/PYTORCH`); `ModelTaskType` (lines 51-57 — no `GUARDRAIL`); `ModelCategory` (lines 46-49 — `AUDIO`, `NLP`).
  - **medgemma row** `lms-medgemma-1.5-4b-mlx`, id `80000000-0000-0000-0005-000000000050`, `format: AiModelFormat.SAFETENSOR` at **line 859** (despite the MLX slug/tag, lines 851/862). This is the row to fix → `MLX`.
  - **granite-guardian** is **absent** (no `granite` slug in the catalog).
  - `seedAiModels(...)` performs an idempotent upsert keyed by `id`.
- `packages/database/src/prisma/db_main/seed/00-constants.ts:22-27` — AiModel id-prefix convention; `80000000-0005` = "LLM/Summarization (SMR)" (line 26). No dedicated guardrail prefix → granite reuses the `0005` LLM block.
- Seed assertions to update: `packages/database/src/__tests__/seed.test.ts:892` asserts every `DEFAULT_AI_MODELS` row has `tenantId === SYSTEM_TENANT_ID` (granite-under-SYSTEM stays consistent); `:1268` asserts pipelines are NOT SYSTEM.

### 3.8 UI (the mirror)
- `apps/ui-playground/src/features/admin/api/admin-client.ts` — `adminClient` with JWT/`X-API-Key` + `X-Tenant-Id` (line 100-103) + `If-Match` (line 105-107); `AdminApiError`; `get/post/patch/delete` (lines 238-253).
- `apps/ui-playground/src/features/admin/api/audio-pipelines.ts` — React Query hooks template: `useAudioPipelines` (line 89), `useCreate/Update/Delete` (lines 114/124/144); `useUpdate` forwards `ifMatch` + body `expectedVersion` (lines 124-142).
- `apps/ui-playground/src/features/admin/audio-pipelines/index.tsx` + `backend-pipelines-tab.tsx` — the page + CRUD tab (list, create/edit dialogs, OCC via `expectedVersion`/`ifMatch`, scope via `useAuthStore`).
- `apps/ui-playground/src/features/admin/components/admin-data-table.tsx` (+ `components/index.ts`) — `AdminDataTable` reusable table.
- `apps/ui-playground/src/components/admin-route-guard.tsx` — `RequireAdmin` / `RequireGlobalScope`.
- `apps/ui-playground/src/routes/_authenticated/admin/audio-pipelines.tsx` — route wraps the page in `<RequireAdmin>`.
- `apps/ui-playground/src/components/layout/admin-nav-items.tsx` — `items.push(... audio-pipelines @ line 78 ...)`; tenant-gated set `TENANT_SCOPED_ADMIN_IDS` (line 46-58, `audio-pipelines` @ line 50).
- `apps/ui-playground/src/features/admin/hooks/use-admin-preferences.ts` — `DEFAULT_ADMIN_MENU_ORDER` (referenced by the nav + its test).
- Nav test that pins the menu set: `apps/ui-playground/src/components/layout/__tests__/admin-nav-items.test.ts:20-44`.
- `routeTree.gen.ts` — auto-generated by the TanStack Router Vite plugin (do not hand-edit; regenerated on dev/build).

---

## 4. File-by-file change plan (strict layer order)

> Order follows `.cursor/rules/01-development-workflow.mdc`: **DB → Domain → Applications → API → UI → Seed**. Each row lists path, new/modified, the change, and the covering test.

### 4.1 DB layer

| # | File | N/M | Change | Covering test |
|---|---|---|---|---|
| D1 | `packages/database/src/prisma/db_main/enums.prisma` | **M** | In `AiModelFormat` (272-279) add `CTRANSLATE2`, `FASTER_WHISPER`, `MLX`, `GGUF` (additive, appended after `PYTORCH`). **Conditional (Q-1):** in `ModelTaskType` (80-139) add `GUARDRAIL` under the NLP block. | Migration SQL review (§5) + `seed.test.ts` (§4.6) |
| D2 | `packages/database/src/prisma/db_main/migrations/<ts>_aimodel_format_additive/migration.sql` | **N** | Generated via `db:migrate:create`, then hand-edited to additive `ADD VALUE IF NOT EXISTS` (see §5). | `pnpm db:migrate` applies clean; `db:migrate:status` clean |

> No change to the `AiModel` model in `stt.prisma` (the registry already has every field + `@@unique([tenantId, slug])` + `_version`).

### 4.2 Domain layer

| # | File | N/M | Change | Covering test |
|---|---|---|---|---|
| Dm1 | `packages/domains/src/enums/generated/AiModelFormat.ts` | **M (regenerated)** | After D1, run `pnpm --filter @arcaai/database db:generate` (which runs `@arcaai/tools generate-prisma-index`) to regenerate the 4 new members. If the generator does not emit them, hand-edit additively to match the Prisma enum (preserve codegen banner lines 1-3). | `aiModelFormat.enum.test.ts` (§8) |
| Dm2 | `packages/domains/src/enums/generated/index.ts` | — | No change (already exports `AiModelFormat`, line 22). | — |

> `AiModelEntity`/`AiModelFactory`/`AiModelEntityMapper`/`AiModelModel`/`AiModelRepository` need **no change** — they reference the enum by type; new members flow through automatically. `ResourceType.AiModel` already exists.

### 4.3 Applications layer (add OCC + clone)

| # | File | N/M | Change | Covering test |
|---|---|---|---|---|
| A1 | `.../stt/model/dto/update-model.request.ts` | **M** | Add required `expectedVersion: number` (`@ApiProperty`, `@IsInt()`, `@Min(1)`), mirroring `update-pipeline.request.ts`. | `aiModel.service.test.ts` OCC tests |
| A2 | `.../stt/model/dto/model.response.ts` | **M** | Add top-level `version: number` (`@ApiProperty`) so `ETagInterceptor` can stamp `ETag`. | controller test asserts `ETag` |
| A3 | `.../stt/model/aiModel.dto.mapper.ts` | **M** | Map `version: entity.version` in `toResponse`. | `aiModel.service.test.ts` |
| A4 | `.../stt/model/aiModel.service.ts` | **M** | In `update` (70-115): strip `expectedVersion` from the applied fields; replace `this.aiModelRepository.update(id, existing)` (line 107) with `this.aiModelRepository.updateWithVersion(id, existing, dto.expectedVersion)` (mirrors `TenantService.update`). Keep slug-uniqueness + `broadcastSysEvent`. | `aiModel.service.test.ts` OCC drift test |
| A5 | `.../stt/model/IAiModelService.ts` | — | Signature unchanged (`expectedVersion` rides inside the DTO). Verify only. | — |
| A6 | `.../tenant/tenant.service.ts` | **M** | (a) Inject `AiModelRepository` in the constructor; import `AiModelFactory` from `@arcaai/domains`; declare local `SYSTEM_TENANT_ID` const (per `userPreferences.service.ts:32-36`). (b) Add `provisionTenantModelCatalog(newTenantId)` private method (mirror `provisionTenantConfigs`, see §6). (c) Call it from `create()` in a 4th try/catch after line 107. | `tenant.service.test.ts` clone test |

### 4.4 API layer (new controller)

| # | File | N/M | Change | Covering test |
|---|---|---|---|---|
| Ap1 | `apps/api/src/modules/ai-model/ai-model-admin.controller.ts` | **N** | `@Controller('admin/ai-models')`, `@ApiTags('admin-ai-models')`, `@ApiBearerAuth()`, class-level `@Authorize(['manage','AiModel'])`. Inject `AiModelService`. Methods mirror the pipeline controller: `create` (POST), `fetchAll`→`getAll` (GET), `fetchById` (GET `:id`), `fetchBySlug` (GET `slug/:slug`), `update` (PATCH `:id`, `@RequiresIfMatch()` + `@ExpectedVersion()` folded over body), `delete` (DELETE `:id`). | `ai-model-admin.controller.test.ts` |
| Ap2 | `apps/api/src/modules/ai-model/ai-model.module.ts` | **N** | NestJS module importing `AiModelServiceModule` (from `@arcaai/applications`), declaring `AiModelAdminController`. | (covered by app build) |
| Ap3 | `apps/api/src/app.module.ts` | **M** | Import + register `AiModelModule` in the modules array (mirror lines 49/249). | app boot + `admin-route-permission-audit` passes |

> The controller imports DTOs/service from `@arcaai/applications` (no local DTOs needed), exactly like `audio-pipeline.controller.ts:1-10`.

### 4.5 UI layer (new feature)

| # | File | N/M | Change | Covering test |
|---|---|---|---|---|
| U1 | `apps/ui-playground/src/features/admin/api/ai-models.ts` | **N** | React Query hooks (`useAiModels`, `useAiModel`, `useCreateAiModel`, `useUpdateAiModel` w/ `ifMatch`+`expectedVersion`, `useDeleteAiModel`) hitting `/admin/ai-models`; types `AiModel`, `Create/UpdateAiModelInput`. Mirror `audio-pipelines.ts`. | `ai-models.test.ts` |
| U2 | `apps/ui-playground/src/features/admin/api/index.ts` | **M** | Re-export the new hooks. | — |
| U3 | `apps/ui-playground/src/features/admin/ai-models/index.tsx` | **N** | Page: `AdminDataTable` listing + react-hook-form/zod create/edit dialogs; scope via `useAuthStore` (`isGlobalScope`, `tenantId`); "select a tenant" prompt for global scope w/o tenant. Mirror `audio-pipelines/index.tsx` + `backend-pipelines-tab.tsx`. | `ai-models-page.test.tsx` |
| U4 | `apps/ui-playground/src/features/admin/ai-models/components/*` | **N** | (Optional) extract the create/edit dialog + columns if the page grows; otherwise inline. | `ai-models-page.test.tsx` |
| U5 | `apps/ui-playground/src/routes/_authenticated/admin/ai-models.tsx` | **N** | Route wrapping the page in `<RequireAdmin>` (mirror `audio-pipelines.tsx`). Triggers `routeTree.gen.ts` regeneration. | route renders under guard |
| U6 | `apps/ui-playground/src/components/layout/admin-nav-items.tsx` | **M** | Add `{ id: 'ai-models', title: 'AI Models', url: '/admin/ai-models', icon: <Cpu/Boxes>, badge: 'NEW' }` to the `isAdmin` push (near line 78) and add `'ai-models'` to `TENANT_SCOPED_ADMIN_IDS` (line 46-58). | `admin-nav-items.test.ts` |
| U7 | `apps/ui-playground/src/features/admin/hooks/use-admin-preferences.ts` | **M** | Add `'ai-models'` to `DEFAULT_ADMIN_MENU_ORDER`. | `admin-nav-items.test.ts` |

### 4.6 Seed layer

| # | File | N/M | Change | Covering test |
|---|---|---|---|---|
| S1 | `packages/database/src/prisma/db_main/seed/01-policy.ts` | **M** | In `tenant-full-access.rules` add `{ action: 'manage', subject: 'AiModel', conditions: { tenantId: '${context.tenantId}' } }` (next to `AsrPipeline`, line 98). SUPER already covered by `manage:all` (line 52). | `seed.test.ts` policy assertion |
| S2 | `packages/database/src/prisma/db_main/seed/06-stt.ts` | **M** | (a) Add new format(s) to the local `AiModelFormat` mirror (39-44) **only if used by a seed row** (`MLX`, `GGUF`; add `CTRANSLATE2`/`FASTER_WHISPER` only if a seed row uses them). (b) Fix medgemma `format: SAFETENSOR` → `MLX` (line 859). (c) Add `granite-guardian-4.1-8b` row (new id `80000000-0000-0000-0005-0000000000XX`, `category: NLP`, `taskType: GUARDRAIL` if added else `TEXT_GENERATION`, `format: GGUF` or `SAFETENSOR` per Q-2, `source: LOCAL`, tags incl. `guardrail`). Add `ModelTaskType.GUARDRAIL` to the local mirror (51-57) only if chosen. | `seed.test.ts` granite + medgemma assertions |
| S3 | existing-tenant **backfill** | **M/N** | Idempotent backfill that clones missing SYSTEM `AiModel` rows into every customer tenant (see §6.2). Preferred location: extend the tenant seed step (mirror per-tenant pipeline seeding) — to be confirmed at implementation. | `seed.test.ts` backfill assertion |
| S4 | `packages/database/src/__tests__/seed.test.ts` | **M** | Add assertions: granite present under SYSTEM; medgemma-mlx `format === MLX`; (if S3 in seed) per-tenant clones exist. | self |

---

## 5. Additive enum migration plan

Per the Prisma migration best-practices rule (`migration-best-practices.mdc`) and the project workflow:

1. **Edit the schema** (D1): append the 4 new `AiModelFormat` values (and conditionally `ModelTaskType.GUARDRAIL`).
2. **Author the migration without applying:**

```bash
pnpm --filter @arcaai/database db:migrate:create --name aimodel_format_additive
```

3. **Hand-edit the generated `migration.sql` to be idempotent/additive.** Target SQL shape (Postgres, `core` schema):

```sql
ALTER TYPE "core"."AiModelFormat" ADD VALUE IF NOT EXISTS 'CTRANSLATE2';
ALTER TYPE "core"."AiModelFormat" ADD VALUE IF NOT EXISTS 'FASTER_WHISPER';
ALTER TYPE "core"."AiModelFormat" ADD VALUE IF NOT EXISTS 'MLX';
ALTER TYPE "core"."AiModelFormat" ADD VALUE IF NOT EXISTS 'GGUF';
-- Conditional (Q-1):
ALTER TYPE "core"."ModelTaskType" ADD VALUE IF NOT EXISTS 'GUARDRAIL';
```

   - `ADD VALUE IF NOT EXISTS` makes the migration safe to re-run and never destructive (no `DROP`/`ALTER ... RENAME`).
   - **Postgres caveat:** `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in the same statement that *uses* the new value. Keep these `ALTER TYPE` statements **in their own migration** (no data writes that consume the new values in the same file). The medgemma `format` fix + granite insert happen via **seed**, not in this migration — so this constraint is satisfied.
4. **Apply + regenerate:**

```bash
pnpm --filter @arcaai/database db:migrate     # prisma migrate dev --skip-generate
pnpm --filter @arcaai/database db:generate     # prisma generate + @arcaai/tools generate-prisma-index
```

5. **Domain enum regeneration (Dm1):** confirm `packages/domains/src/enums/generated/AiModelFormat.ts` now lists all 8 members. If the generator does not own this file, hand-edit additively to match. Re-run `pnpm build --filter @arcaai/domains`.

---

## 6. Clone-per-tenant + backfill design (idempotent)

### 6.1 On tenant create (runtime — `TenantService`)
New private method, mirroring `provisionTenantConfigs` but sourcing from `SYSTEM_TENANT_ID`:

```ts
// pseudocode — final code lands in tenant.service.ts during Phase 4
private async provisionTenantModelCatalog(newTenantId: string): Promise<void> {
  const sourceModels = await this.aiModelRepository.findAll({
    where: { tenantId: SYSTEM_TENANT_ID },
  });
  let cloned = 0;
  for (const src of sourceModels) {
    try {
      // idempotency: skip if the new tenant already has this slug
      const unique = await this.aiModelRepository.isSlugUnique(newTenantId, src.slug);
      if (!unique) continue;
      const clone = AiModelFactory.CreateAiModel({
        tenantId: newTenantId,
        name: src.name, slug: src.slug, description: src.description ?? undefined,
        category: src.category, taskType: src.taskType, modelType: src.modelType,
        source: src.source, sourceUri: src.sourceUri, sourceRevision: src.sourceRevision ?? undefined,
        format: src.format, memorySizeMb: src.memorySizeMb ?? undefined,
        computeType: src.computeType ?? undefined, tags: src.tags,
        createdBy: this.requestUser?.id,
      });
      await this.aiModelRepository.create(clone);
      cloned += 1;
    } catch (e) { this.logger.warn({ message: 'AiModel clone failed - continuing', newTenantId, sourceSlug: src.slug, error: String(e) }); }
  }
  if (cloned === 0) this.logger.warn({ message: 'No AiModels cloned for new tenant', newTenantId });
}
```

- Called from `create()` after `provisionDefaultDepartment` (line 107) in its **own try/catch**, so a clone failure never aborts tenant creation (matches existing provisioning blocks).
- **Composition:** runs alongside the `GlobalSetting` clone — both are independent provisioning steps; no ordering dependency.
- **Download fields:** clones reset to `NOT_DOWNLOADED` (factory default), not copied — a tenant's artifact state is its own.

### 6.2 Existing-tenant backfill (idempotent)
- A backfill that, for each customer tenant, clones missing SYSTEM rows (same per-slug `isSlugUnique` guard). Idempotent: re-running clones only the gaps.
- **Preferred:** a seed step (mirrors how per-tenant ASR pipelines are seeded), so `pnpm db:seed` makes existing tenants whole. **Alternative:** a one-shot admin maintenance route. Defaulting to the seed approach (non-blocking; confirm at implementation).

> **Caveat (Risk R-1):** because the tenant-scope extension shared-reads SYSTEM rows (`tenant-scope.ts:438`), a tenant's list will contain both the SYSTEM original and the clone (same slug, different `tenantId`). The admin list query must therefore either filter to exact `tenantId === ctx.tenantId`, or de-dupe by slug preferring the tenant-owned row (the pattern in `userPreferences.service.ts:278`). See Q-3.

---

## 7. CASL `AiModel` subject + authorization matrix

- **Subject registration:** add the string subject `AiModel` to `tenant-full-access` (S1). No subject-enum change (subjects are strings, §3.5). SUPER inherits via `manage:all`.

| Role | Scope / policy | `AiModel` grant | Effect on `/admin/ai-models` |
|---|---|---|---|
| SUPER_ADMIN | GLOBAL — `system-full-access` `manage:all` (01-policy.ts:52) | implicit | Manage the **global catalog** (set `X-Tenant-Id = SYSTEM`) and any tenant clone (`X-Tenant-Id = <tenant>`). |
| TENANT_ADMIN | TENANT — `tenant-full-access` (01-policy.ts:76-119) | `manage AiModel where tenantId == ctx.tenantId` (NEW) | Manage **own tenant clone**; SYSTEM rows visible read-only via shared-read. |
| DOCTOR / NURSE / others | TENANT clinical policies | none | **403** (controller is `manage:AiModel`). |

- Matches the audio-pipeline model: SUPER/GLOBAL administer the master; TENANT_ADMIN self-serves their tenant; clinicians have no admin access.

---

## 8. TDD test list (RED-first), per layer

> Write each test first, watch it fail for the right reason, then implement (Red→Green→Refactor).

### Domain — `pnpm test:unit --filter @arcaai/domains`
- `packages/domains/src/enums/__tests__/aiModelFormat.enum.test.ts` (**N**)
  - `it('exposes CTRANSLATE2, FASTER_WHISPER, MLX, GGUF')` — RED until Dm1.

### Applications — `pnpm test:unit --filter @arcaai/applications`
- `.../stt/model/__tests__/aiModel.service.test.ts` (**M**)
  - `it('update() passes expectedVersion to updateWithVersion')`
  - `it('update() throws on version drift (OCC conflict)')`
  - `it('update() maps version into ModelResponse')`
  - `it('create() accepts new format MLX/GGUF')`
- `.../tenant/__tests__/tenant.service.test.ts` (**M**)
  - `it('create() clones SYSTEM AiModel catalog into the new tenant')`
  - `it('clone is idempotent — skips slugs already present in the tenant')`
  - `it('clone failure does not abort tenant creation')`

### API — `pnpm build:api` + `pnpm test:e2e` (+ controller unit test)
- `apps/api/src/modules/ai-model/__tests__/ai-model-admin.controller.test.ts` (**N**) — mirror `audio-pipeline.controller.test.ts`:
  - `it('is decorated @Authorize(["manage","AiModel"]) at class level')`
  - `it('create/fetchAll/fetchById/fetchBySlug/delete delegate to AiModelService')`
  - `it('update folds If-Match header over body expectedVersion')`
  - `it('update is @RequiresIfMatch (428 without header)')`
- Boot: `admin-route-permission-audit` passes (no empty `@Authorize`).

### UI — `pnpm --filter @arcaai/ui-playground test`
- `apps/ui-playground/src/features/admin/api/__tests__/ai-models.test.ts` (**N**)
  - `it('useAiModels GETs /admin/ai-models with X-Tenant-Id')`
  - `it('useUpdateAiModel sends If-Match + expectedVersion')`
- `apps/ui-playground/src/features/admin/ai-models/__tests__/ai-models-page.test.tsx` (**N**)
  - `it('renders the catalog table')`
  - `it('opens create/edit dialog and validates with zod')`
  - `it('global-scope admin without a tenant sees the select-a-tenant prompt')`
- `apps/ui-playground/src/components/layout/__tests__/admin-nav-items.test.ts` (**M**)
  - extend the TENANT_ADMIN set assertion to include `'ai-models'`.

### Seed — (runs under `@arcaai/database` test suite)
- `packages/database/src/__tests__/seed.test.ts` (**M**)
  - `it('registers granite-guardian-4.1-8b under SYSTEM tenant')`
  - `it('medgemma lms-medgemma-1.5-4b-mlx has format MLX')`
  - `it('tenant-full-access grants manage AiModel')`
  - (if S3 in seed) `it('every customer tenant has the SYSTEM catalog cloned')`

---

## 9. Verification criteria (layer gates)

Per `.cursor/rules/01-development-workflow.mdc` layer-gates table:

| Layer | Build gate | Test gate |
|---|---|---|
| Database | `pnpm --filter @arcaai/database db:migrate` + `db:generate`; `db:migrate:status` clean | migration SQL reviewed (additive `ADD VALUE IF NOT EXISTS`) |
| Domain | `pnpm build --filter @arcaai/domains` | `pnpm test:unit --filter @arcaai/domains` |
| Applications | `pnpm build --filter @arcaai/applications` | `pnpm test:unit --filter @arcaai/applications` |
| API | `pnpm build:api` | controller unit test + `pnpm test:e2e` |
| UI | `pnpm --filter @arcaai/ui-playground build` (typecheck) | `pnpm --filter @arcaai/ui-playground test` |
| Seed | `pnpm --filter @arcaai/database db:seed` (idempotent re-run) | `seed.test.ts` green |

Completion also requires (workflow checklist): barrel exports updated (U2), module registration complete (Ap3), `ReadLints` clean on touched files, and the ticket README updated with an Implementation Summary + Change History entry (post-approval).

---

## 10. Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-1 | **Shared-read duplicates.** `tenant-scope.ts:438` returns SYSTEM rows alongside tenant rows; after cloning, tenant list shows the SYSTEM original + the clone (same slug). | Admin list filters to exact `tenantId === ctx.tenantId`, or de-dupes by slug preferring the tenant row (precedent: `userPreferences.service.ts:278`). Decide via Q-3. |
| R-2 | **OCC retrofit.** `AiModelService.update` has no OCC today; adding `expectedVersion`/`version`/`updateWithVersion` changes the update contract for any *existing* internal caller of `AiModelService.update`. | Grep for callers before edit; only the new admin controller is expected to call it. Required `expectedVersion` is validated at the DTO; internal callers (if any) must supply it. |
| R-3 | **Generator coverage.** Unknown whether `@arcaai/tools generate-prisma-index` regenerates the domain `AiModelFormat.ts`. | After `db:generate`, assert the 4 members exist (Dm1 test). Fallback: additive hand-edit. |
| R-4 | **Enum value used cross-service.** `GUARDRAIL` / new formats may be consumed by Python services (smr/guardrail) reading the DB. | Additive only; no Python change in this plan. Python alignment is out of scope (a follow-up). |
| R-5 | **`routeTree.gen.ts` drift.** New route requires regen. | Let the Vite plugin regenerate during dev/build; never hand-edit. |
| R-6 | **Backfill location.** Seed-based backfill runs only on `db:seed`; environments that don't re-seed won't backfill. | Document the backfill command; optionally provide an admin maintenance route (deferred). |

---

## 11. Overlap boundaries (CRITICAL)

This plan **touches NONE** of the following — they belong to TASK-355/357/358/359:
- `apps/harness/**` (harness service, sensors — incl. `entailment_batch.py`, inferential sensors).
- `apps/smr/**` (summarization service).
- `packages/applications/**/consultation/summary/summary.service.ts`.
- `packages/applications/**/consultation/harness/harness-internal.service.ts`.
- Any harness gating/PHI-egress sensor code.

**Only shared file:** `packages/database/src/prisma/db_main/enums.prisma`. TASK-355 edits a *different* enum block there (`ConsultationStatus` / harness enums, e.g. `enums.prisma:224-234`). This plan's edits are a **separate, additive** block (`AiModelFormat` @ 272-279; optional `ModelTaskType` @ 80-139). Low-risk-but-shared: coordinate merge order; both are additive `ADD VALUE` migrations and do not conflict semantically. No other file is shared.

---

## 12. Questions for the user (blocking decisions)

1. **`ModelTaskType.GUARDRAIL` — add now, or reuse an existing taskType?**
   Adding it is additive and lets granite be typed precisely; the trade-off is a new cross-service enum value (Python services may read it). If you prefer to avoid the cross-service surface for now, granite uses the closest existing value (`TEXT_GENERATION` or `TEXT_CLASSIFICATION`). **Recommendation:** add `GUARDRAIL` (additive, low risk; matches the model's role).
2. **granite-guardian-4.1-8b `format` — `GGUF` or `SAFETENSOR`?**
   GGUF if it's served via llama.cpp / a quantized local artifact; SAFETENSOR if it's the HF Transformers checkpoint. **Recommendation:** `GGUF` (consistent with D-4 self-convert/local-serving), but confirm the actual artifact you intend to register.
3. **Shared-read vs clone visibility (R-1).** After clone-per-tenant, should a tenant's `/admin/ai-models` list show **only the tenant's own rows** (filter to exact `tenantId`), or **merge** (clone overrides the SYSTEM original by slug)? **Recommendation:** exact-`tenantId` filter for the admin list (cleanest; matches "manage your clone"), keeping SYSTEM as the master template invisible in the tenant admin grid.

> If you have no preference, I will proceed with the three recommendations above when implementation is approved.
