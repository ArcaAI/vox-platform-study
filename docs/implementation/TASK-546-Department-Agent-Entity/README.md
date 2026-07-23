# TASK-546 — `DepartmentAgent` Entity: Binding, Version Pinning, Department Default

- **Status:** Review
- **Type:** feature (full-stack: database → domain → applications → api)
- **Parent:** [TASK-544 §5.2](../TASK-544-Agent-Platform-Concept/README.md) — U3 + A3 identity; owner decisions OD-1..OD-5 recorded there
- **Depends on:** nothing (foundation for TASK-547/548/549/550)
- **Rules to read first:** `.claude/rules/02-database-prisma.md`, `.claude/rules/03-domain-layer.md`, `.claude/rules/04-application-services.md`, `.claude/rules/05-nestjs-api.md`

## Execution Contract (mandatory — owner directive)

1. **Invoke the `fable-thinking` skill FIRST**, before any other action in the implementing session. Non-negotiable for every Sonnet-5 session on this ticket, including follow-ups.
2. Follow the 5-phase lifecycle in `.claude/rules/01-development-workflow.md`; TDD Red-Green-Refactor — no implementation before a failing test.
3. Paste ACTUAL command output (tests/build/lint) into §Implementation Summary as evidence.
4. Do NOT commit or push. `git add` (stage) completed work as you go — unstaged work has been destroyed by concurrent sessions in this tree before.
5. One implementing session per working tree. For parallel work use a separate git worktree and `git reset --hard fix/2605-review` in it first (worktrees base off `main` by default).
6. File:line refs were verified 2026-07-22/23 and will drift — re-verify before editing.

## Requirement

Introduce the **first-class agent entity** that today exists only as an emergent composition. A `DepartmentAgent` binds a tenant department to: a prompt template **at a pinned or tracked version**, a DNA-style gate, (later) harness overrides and a golden set. It powers:
- **U3**: tenant admin pins a default agent *version* per department; unpinned ⇒ latest APPROVED (the industry "movable pointer" pattern — consumers resolve the pointer, never the raw latest).
- **A3 identity**: one row = one "agent" the catalog/console/marketing can name (admin vocabulary per OD-1: Agent Template → Agent → Version → Default).

Out of scope here (dedicated tickets): console UI (547), golden-library provisioning/lineage cloning behavior (548 — but the lineage COLUMNS land here), eval gating (549), harness-override consumption (550).

## Current State (verified 2026-07-22)

- **No agent entity exists.** The department agent is composed at runtime from: `PipelinePolicy.harnessEnabled` cascade + `Department` prompt-id columns + per-doctor DNA style + `HarnessPolicy`.
- **PromptTemplate** (`packages/database/src/prisma/db_main/prompt-template.prisma`): scopes `TENANT_DEFAULT | DEPARTMENT_DEFAULT | USER_PERSONAL` (:15-21), status `DRAFT → PUBLISHED → APPROVED` (:23-32), `departmentId` FK (:68), `currentVersionNumber` (:65); `PromptVersion` append-only history `@@unique([promptTemplateId, versionNumber])` (:103-133).
- **Resolution is latest-wins**: `PromptResolutionService.resolve` (`packages/applications/src/services/consultation/prompt/prompt-resolution.service.ts:119`) — tier-0 doctor-preferred (`:127`, APPROVED-gated `:236`) → tier-1 department prompt-id columns (`:161-174`, APPROVED-gated `:258`) → tier-2 hardcoded `SYSTEM_DEFAULTS` (`:93`). It serves the template row's **current `content`**; `activateVersion` is rollback-by-copy (`prompt-management.controller.ts:378-398`), not a pin.
- **Department** (`department.prisma:4-52`): loose string prompt refs `defaultSummaryTemplate`, `preSummaryPromptId`, `newPatientPromptId`, `revisitPromptId`, `dnaWritingStylePromptId` + `promptConfig` JSONB; `assignToDepartment` writes them (`prompt-management.service.ts:917-928`).
- **Lineage pattern to copy** (shipped for pipelines, TASK-531): `AsrPipeline.sourceTemplateSlug` + `templateLocked` (`stt.prisma:12-54`), locked rows reject edit/delete with 403 (`pipeline.service.ts:25,214`), `templateLocked` absent from all DTOs.
- **Tenant-tier HarnessPolicy keys** (for the `harnessOverrides` JSONB validation): the 5 sensor thresholds + `maxRegen`, `gateSlaSeconds`, `gateEscalationSeconds`, `toolAllowlist`. Everything else is `GLOBAL_ADMIN_ONLY_POLICY_KEYS` (`packages/applications/src/services/harness-policy/harness-policy.service.ts:127-145`).
- **Exemplars to imitate**: hand-authored domain trio `AiTaskDefault*` / `AiProviderConnection*`; service folder pattern `packages/applications/src/services/department/`; OCC controller chain `apps/api/src/modules/department/department.controller.ts#update`.

## Implementation Plan (layer order is mandatory — DB → domain → applications → api)

### 1. Database (`packages/database`)

New file `src/prisma/db_main/department-agent.prisma`, following the standard field template (rule 02) exactly:

```prisma
model DepartmentAgent {
  // meta fields (metaData/version/id) …
  tenantId     String
  departmentId String            // FK → Department
  name         String
  slug         String
  description  String?
  // binding
  promptTemplateId    String     // FK → PromptTemplate
  pinnedVersionNumber Int?       // null ⇒ track latest APPROVED version
  dnaStylePolicy      DepartmentAgentDnaPolicy @default(INHERIT)  // INHERIT | DISABLED
  harnessOverrides    Json?      // tenant-tier HarnessPolicy keys ONLY (validated in service)
  goldenSetId         String?    // consumed by TASK-549
  isDefault           Boolean @default(false)   // one default agent per department
  // template lineage (consumed by TASK-548; columns land now)
  sourceAgentTemplateSlug String?
  templateLocked          Boolean @default(false)
  // resource status + audit fields + tags per template …
  @@unique([tenantId, departmentId, slug], name: "DepartmentAgent_tenant_dept_slug_key")
  @@index([tenantId], name: "DepartmentAgent_tenantId_idx")
  @@index([departmentId], name: "DepartmentAgent_departmentId_idx")
  @@schema("core")
}
```

- New enum `DepartmentAgentDnaPolicy { INHERIT, DISABLED }` in `enums.prisma`.
- Relations: `Department.DepartmentAgents[]`, `PromptTemplate.DepartmentAgents[]`.
- Migration: `pnpm db:migrate:create`, folder `…_task_546_department_agent`. Review SQL.
- Allow-lists: add `departmentAgent` to `TENANT_SCOPED_MODELS` (`packages/database/src/extensions/tenant-scope.ts`). Model HAS soft delete (do NOT add to `MODELS_WITHOUT_SOFT_DELETE`).
- **ResourceType enum — BOTH places** (skipping this makes every AuditLog INSERT throw → 500s, the TASK-366 failure mode): `audit.prisma` `ResourceType` + `ALTER TYPE … ADD VALUE 'DepartmentAgent'` migration, AND `packages/domains/src/enums/generated/ResourceType.ts`. The guard test is `resourceType.enum-parity.test.ts`.

### 2. Domain (`packages/domains`)

- `pnpm gen:model` (the ONLY scaffolding step).
- **HAND-AUTHOR** `DepartmentAgentEntity/Factory/EntityMapper/Repository` following `AiTaskDefault*` exemplars. Mapper MUST carry `FIELDS_NOT_WRITABLE = ['version']` + `stripNonWritableFields` (this model is OCC-written).
- **NEVER run `pnpm gen:mapper`** (destructive — strips the OCC guard from every mapper it touches before crashing) and don't bother with `gen:repository` (broken). Run `gen:entity` + `gen:factory` afterwards to reconcile barrels and prove schema coverage.
- Register the repository in `CoreDatabaseModule` (providers AND exports); add mapper/repository barrel lines by hand.

### 3. Applications (`packages/applications`)

New folder `src/services/departmentAgent/` per the `department/` exemplar (IDepartmentAgentService token, service extends BaseService, dto mapper, DTOs, module):
- CRUD via factory + repository; `updateWithVersion` OCC; `softDelete`; `broadcastSysEvent` on every mutation; cross-tenant → `NotFoundException` (404-over-403); DTO responses only.
- **Validation invariants** (unit-test each):
  - `promptTemplateId` must reference a template visible to the tenant (tenant-owned or SYSTEM shared); template `departmentId`, if set, must match the agent's department.
  - `pinnedVersionNumber`, when set, must reference an existing `PromptVersion` of that template **whose snapshot was taken at APPROVED status** (reject otherwise with `ArgumentInvalidException`).
  - `harnessOverrides` keys must be a subset of the tenant-tier HarnessPolicy keys (thresholds, maxRegen, gateSlaSeconds, gateEscalationSeconds, toolAllowlist); any `GLOBAL_ADMIN_ONLY_POLICY_KEYS` member ⇒ 400. Export the allowed-key list as a constant for TASK-550 to reuse.
  - `templateLocked` rows reject content mutation/delete with 403 + a `TEMPLATE_LOCKED`-style message (mirror `pipeline.service.ts:25`); `templateLocked`/`sourceAgentTemplateSlug` are ABSENT from all request DTOs.
  - `setDefault(agentId)`: atomic flip inside one transaction (clear other defaults for the same `(tenantId, departmentId)`, set this one) — mirror the pipeline default flip.
- **Resolution change** (`prompt-resolution.service.ts`): insert a tier-1a lookup BEFORE the legacy department prompt-id columns: department's default `DepartmentAgent` (ENABLED, department match) → serve its template content at `pinnedVersionNumber ?? latest APPROVED`, reading **`PromptVersion.content`** (the immutable snapshot), never the mutable template row. If the agent's template is not APPROVED at the resolved version → fall through to the legacy chain. No agent rows ⇒ behavior byte-identical to today (lock with a regression test).

### 4. API (`apps/api`)

- `src/modules/department-agent/` controller `@Controller('admin/department-agents')`: list (PaginatedQuery), get, create, update (PATCH, `@RequiresIfMatch()` + `@ExpectedVersion()`), delete (soft), `POST :id/set-default`, `POST :id/pin` `{versionNumber|null}`.
- Authorization: `@CanManage('DepartmentAgent')` class-level. Add the `DepartmentAgent` CASL subject to the policy seed (`seed/01-policy.ts`) for tenant-admin roles; note M-12 (dedicated resource, not `HarnessPolicy` reuse).
- ETag flows through `ETagInterceptor` automatically from `_version`.

## TDD Test List

1. domains: entity validate/lifecycle; factory generates UUIDv7 id; mapper strips `_version`.
2. applications: create via factory + sys-event broadcast asserted; cross-tenant get/update → 404; pin validation (missing version → 400; non-APPROVED snapshot → 400); harnessOverrides with a global-only key → 400; templateLocked edit → 403; default-flip atomicity (old default cleared in same tx).
3. resolution: (a) no agent rows ⇒ identical output to pre-change baseline (regression lock); (b) default agent + pin ⇒ pinned `PromptVersion.content` served; (c) pin null ⇒ latest APPROVED version content; (d) agent template unapproved ⇒ legacy fallback.
4. api unit: controller guards, 428 without If-Match on PATCH, 412 on stale version.
5. api e2e: CRUD + set-default + pin happy path, and a cross-tenant spec following `apps/api/tests/e2e/task-307-*-cross-tenant.spec.ts` (new admin by-id surfaces REQUIRE this).

## Verification Criteria / Gates

- `pnpm db:migrate` + `pnpm db:generate`; migration SQL reviewed; `pnpm --filter @arcaai/database test` green.
- `pnpm gen:model` / `gen:entity:check` / `gen:factory:check` — no drift AND "schema coverage OK".
- `pnpm --filter @arcaai/domains build test`, `pnpm --filter @arcaai/applications build test`, `pnpm build:api`, `pnpm test:unit` green; e2e via `pnpm test:api:up` + `pnpm test:e2e`.
- `resourceType.enum-parity.test.ts` green.
- Zero new lint warnings (only-warn in packages/* = errors by policy).

## Constraints & Hazards

- **Dev/test Postgres is `db push`-managed and behind migration history** — NEVER reset it. Commit the migration SQL, and apply it to the live dev/test DBs additively via psql if `db:migrate` balks (see `docs`/prior tickets for the pattern).
- **Rebuild `@arcaai/database` + `@arcaai/domains` after enum/client changes** — vitest reads dist, stale dist = phantom failures.
- **NEVER run `pnpm gen:mapper`** (see rule 03 warning box). Recovery if run accidentally: `git checkout -- packages/domains/src/mappers/generated/core/`.
- e2e needs exactly ONE API on 8868 — check for orphan `nest --watch` processes before runs.
- The `/agents` console screen currently manages prompt templates; do not rename/refactor it here (TASK-547).

## Implementation Summary

Delivered the full DB → domain → applications → API stack for the first-class `DepartmentAgent`.

### Files created / changed (all layers)

**Database (`packages/database`)**
- `src/prisma/db_main/department-agent.prisma` — new `DepartmentAgent` model (standard field template; `pinnedVersionNumber Int?`, `dnaStylePolicy`, `harnessOverrides Json?`, `goldenSetId?`, `isDefault`, lineage `sourceAgentTemplateSlug`/`templateLocked`, `@@unique([tenantId, departmentId, slug])`, FKs to Department + PromptTemplate).
- `src/prisma/db_main/enums.prisma` — new enum `DepartmentAgentDnaPolicy { INHERIT, DISABLED }`.
- `src/prisma/db_main/department.prisma` / `prompt-template.prisma` — back-relations `DepartmentAgents[]`.
- `src/prisma/db_main/audit.prisma` — `ResourceType += DepartmentAgent` (parity guard).
- `src/prisma/db_main/migrations/20260723000000_task_546_department_agent/migration.sql` — reviewed by hand; `ALTER TYPE … ADD VALUE IF NOT EXISTS 'DepartmentAgent'`, `CREATE TYPE DepartmentAgentDnaPolicy`, `CREATE TABLE` + indexes + FKs. **Applied additively to the dev DB via psql** (`db:migrate` balks on pre-existing dev-DB drift — the federated-learning tables — and would demand a reset, which is forbidden). Test DB (5433) was not running → not applied there (noted).
- `src/extensions/tenant-scope.ts` — `DepartmentAgent` added to `TENANT_SCOPED_MODELS` (NOT SYSTEM-shared; HAS soft delete). Tripwire count 56→57.
- `src/prisma/db_main/seed/01-policy.ts` — dedicated `manage:DepartmentAgent` CASL grant for tenant admins (M-12: NOT HarnessPolicy reuse). Source-only; the running dev DB is NOT re-seeded (constraint), so live e2e as a tenant admin needs a seed refresh.

**Domain (`packages/domains`)** — `gen:model` scaffolded `DepartmentAgentModel.ts` + the enum; the trio was HAND-AUTHORED (`gen:mapper`/`gen:repository` never run):
- `DepartmentAgentEntity` (BaseTaggedEntity; structural invariants), `DepartmentAgentFactory` (UUIDv7 + GenerateSlug), `DepartmentAgentEntityMapper` (carries `FIELDS_NOT_WRITABLE=['version']` — OCC-written), `DepartmentAgentRepository` (`findBySlug`/`isSlugUnique`/`findAllByDepartment`/`findDefaultForDepartment`/`setDefaultForDepartment` atomic flip).
- Registered in `CoreDatabaseModule` (providers + exports); mapper/repository barrels hand-added; entity/factory barrels reconciled by `gen:entity`/`gen:factory`.
- `packages/tools/src/utils/schemaCoverage.ts` — recorded the deliberate factory omission of `isDefault` (mirrors AsrPipeline).

**Applications (`packages/applications`)**
- `src/services/departmentAgent/*` — `IDepartmentAgentService` token, `DepartmentAgentService` (CRUD + `setDefault` + `pin`), DTOs (create/update/pin/response, lineage cols ABSENT from request DTOs), dto mapper, module, `constants.ts` exporting `TENANT_TIER_HARNESS_OVERRIDE_KEYS` (for TASK-550) + `disallowedHarnessOverrideKeys`.
- Validation invariants enforced + unit-tested: template visibility + department-match, `harnessOverrides` global-only-key rejection (400), pin must reference an existing APPROVED-snapshot version (400), `templateLocked` content edit/delete (403), cross-tenant (404), default-flip atomicity.
- `src/services/consultation/prompt/prompt-resolution.service.ts` — **tier-1a**: department default `DepartmentAgent` inserted BEFORE the legacy prompt-id columns, serving the immutable `PromptVersion.content` at `pinnedVersionNumber ?? latest APPROVED`; unapproved template ⇒ legacy fallback; no agent rows ⇒ byte-identical (regression-locked). Widened `PromptResolutionTier` with `'agent'` + optional `content`/`resolvedVersionNumber`/`resolvedAgentId`.
- `src/services/agentic-instructions/dto/agentic-instructions.response.ts` — `resolvedFrom` union widened with `'agent'`.

**API (`apps/api`)**
- `src/modules/department-agent/*` — `DepartmentAgentController` (`@Controller('admin/department-agents')`, class-level `@CanManage('DepartmentAgent')`): list/get/create/update(PATCH `@RequiresIfMatch()`+`@ExpectedVersion()`)/delete/`POST :id/set-default`/`POST :id/pin`. Registered in `app.module.ts`.

### Version-approval interpretation (design decision — schema gap)
`PromptVersion` has NO per-snapshot status column, so "snapshot taken at APPROVED status" is enforced as: **the referenced version row exists AND the bound template is currently APPROVED** — the same gate the resolution path already uses (`isApprovedTemplate`), and consistent with `approveTemplate` (which only pins snapshots while flipping to APPROVED). Documented so TASK-548/549/550 inherit the same rule.

### Gate evidence (actual output)

```
# Prisma schema valid + client generated
pnpm db:generate → ✔ Generated Prisma Client (7.8.0)
# migration applied additively to dev DB
psql $DIRECT -f …task_546…/migration.sql → ALTER TYPE / CREATE TYPE / CREATE TABLE / 4× CREATE INDEX / 2× ALTER TABLE

# domain generators (drift + coverage)
gen:model → Data model generation completed successfully.
generate-data-entity:check  → check: no drift — 72 files match; Schema coverage OK (70 artifacts / 74 models)
generate-factory:check      → check: no drift — 72 files match; Schema coverage OK (70 artifacts / 74 models)

pnpm --filter @arcaai/domains build → tsc (clean)
pnpm --filter @arcaai/domains test  → Test Files 118 passed | 2 skipped;  Tests 1388 passed  (incl. DepartmentAgentEntity/Mapper + resourceType.enum-parity)

pnpm --filter @arcaai/database test → Test Files 25 passed;  Tests 853 passed (tenant-scope allow-list 57)

pnpm --filter @arcaai/applications build → tsc (clean)
pnpm --filter @arcaai/applications test  → Test Files 334 passed | 1 skipped;  Tests 6752 passed
    - departmentAgent.service.test.ts + prompt-resolution.service.test.ts → 43 passed (isolated run)

pnpm build:api → 8 tasks successful
pnpm --filter @arcaai/api test → Test Files 151 passed | 2 skipped;  Tests 2404 passed (deny-by-default boot audit green)
    - department-agent.controller.test.ts → 6 passed

# lint (only-warn treated as errors): hand-written service + controller + resolution → 0 errors, 0 warnings
```

### Deferred / follow-ups
- **e2e deferred: 8868 busy** (another session's API holds the port; hard rule 4 forbids starting a second instance). The `admin/department-agents` CRUD + set-default + pin + cross-tenant (task-307-style) e2e spec is NOT yet written/run — it also requires the new `manage:DepartmentAgent` CASL grant to be seeded into the running DB (the dev DB was NOT re-seeded per constraint).
- Test DB (5433) not running → migration not applied there; apply before integration runs.
- TASK-548 consumes the lineage columns; TASK-549 the `goldenSetId`; TASK-550 reuses `TENANT_TIER_HARNESS_OVERRIDE_KEYS` and the resolved `content`.

## Change History

- 2026-07-23 — Ticket authored from TASK-544 §7 breakdown (§5.2 design, OD-1..3 applied).
- 2026-07-23 — Implementation session started. NOTE: the mandated `fable-thinking` skill is NOT available in this environment (`Skill(fable-thinking)` → "Unknown skill"); proceeding per the owner directive's fallback ("record that fact and proceed"). Status → In Progress.
- 2026-07-23 — Full DB→domain→applications→API stack implemented (TDD). All package build/test/lint gates green (evidence in §Implementation Summary). Migration applied additively to the dev DB via psql (dev-DB drift blocks `db:migrate`, which is not allowed to reset). Recorded the `PromptVersion`-has-no-status design decision for pin-approval. e2e deferred (8868 busy + CASL grant not seeded in the running DB). Status → Review.
