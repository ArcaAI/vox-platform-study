# Plan: WS-1 — Database & Domain Layer

**Required Skill**: executing-plans
**Assigned to**: Engineer A
**Estimated Duration**: 2 days
**Dependencies**: None (this is the foundation for WS-2 and WS-3)
**Branch**: `feat/sdk-207-ws1-database`

## Goal

Create 6 new Prisma models (PromptTemplate, PromptVersion, DnaWritingStyleReport, DnaWritingStyleVersion, DnaUsageRecord, PromptUsageRecord), run the migration, and generate all domain layer artifacts (entities, factories, repositories, mappers).

## Architecture Overview

All models follow existing HOPE conventions: UUID7 IDs, multi-tenant with `tenantId`, soft delete via `resourceStatus`, audit fields (`createdBy`, `updatedBy`, `createdAt`, `updatedAt`), and `@@schema("core")`. Domain layer follows DDD patterns established in `packages/domains/`.

## Tech Stack

- Prisma 6.x (PostgreSQL)
- TypeScript
- `@arcaai/domains` patterns (BaseTenantEntity, Repository, AutoClassMapper)

## Design Decisions (from Brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Keep all 6 models | Usage records are accountability tracking — who used which version in which consultation |
| 2 | Remove `DnaSourceType` enum | DNA reports are always per-doctor. Department fallback uses existing `Department.defaultDnaStyleId` field |
| 3 | No FK relations between ContextItem and usage records | Plain `String` ID fields, join when needed. Keeps schema decoupled |
| 4 | 2 separate version models (PromptVersion + DnaWritingStyleVersion) | Explicit per-domain, easy to reason about — not merged into a generic table |
| 5 | No usage type enums (`DnaUsageType`, `PromptUsageType` removed) | Usage records are pure facts: who, what version, when, which consultation |
| 6 | Full DDD for all 6 models | Consistency across domain layer — every model gets Entity + Factory + Repository + Mapper |
| 7 | Keep `tags` on PromptTemplate, drop `isDefault` | Tags are cheap and consistent with codebase. `isDefault` is redundant — Department already has `newPatientPromptId`, `revisitPromptId`, `defaultDnaStyleId` |
| 8 | Follow planned indexes as-is | Cheap to have, expensive to add later in production |

## Acceptance Criteria

- [ ] All 6 models created in 2 `.prisma` files following naming conventions
- [ ] Only 1 enum created: `PromptTemplateCategory` (no `DnaSourceType`, `DnaUsageType`, `PromptUsageType`)
- [ ] Usage records use plain `String` ID fields — NO FK relations to `ContextItem`
- [ ] Migration runs cleanly on a fresh database AND on the existing schema
- [ ] Migration rollback SQL documented and tested
- [ ] Domain entities extend `BaseTenantEntity` with proper change tracking
- [ ] Factories use `generateId()` for UUID7
- [ ] Repositories extend `Repository<Entity, Model>` with custom query methods
- [ ] Mappers use `AutoClassMapper` and `createMapperHandlers`
- [ ] All domain artifacts have unit tests
- [ ] Department model updated with new relations
- [ ] Seed data created: 4 prompt templates + 4 versions, 2 DNA reports + 2 versions, 2+2 usage records
- [ ] Seed script runs cleanly via `seed/index.ts` (idempotent with `upsert`)
- [ ] Seed tests pass in `seed.test.ts` (structure, integrity, cross-references)
- [ ] Department seed updated: GEN and CARD departments wired with prompt template IDs

---

## Task 1: Create PromptTemplate + PromptVersion Prisma Schema

**Files**:
- Create: `packages/database/src/prisma/db_main/prompt-template.prisma`
- Test: Verify with `npx prisma validate`

**Steps**:

1. Create the Prisma schema file with models: `PromptTemplate`, `PromptVersion`, `PromptTemplateCategory` enum

2. Follow existing conventions from `department.prisma`:
   - `metaData Json? @map("_metadata") @db.JsonB`
   - `version Int @default(1) @map("_version")`
   - `id String @id @default(uuid(7))`
   - `tenantId String @default("50000000-0000-0000-0000-000000000000")`
   - Full audit fields and `resourceStatus`
   - `@@schema("core")` on all models and enums

3. `PromptTemplate` fields:
   - `name String` — template name
   - `description String?` — optional description
   - `content String @db.Text` — the actual prompt text
   - `category PromptTemplateCategory` — enum: `SYSTEM`, `SUMMARY`, `DNA_ANALYSIS`, `CUSTOM`
   - `variables Json? @db.JsonB` — template variable definitions
   - `currentVersionNumber Int @default(1)` — tracks latest version
   - `departmentId String?` — FK to Department (optional)
   - `Department Department? @relation(fields: [departmentId], references: [id])`
   - `tags String[] @default([])` — for search/filtering
   - **NO `isDefault` field** — Department pointer fields handle defaults

4. `PromptVersion` fields:
   - `promptTemplateId String` — FK to PromptTemplate
   - `PromptTemplate PromptTemplate @relation(fields: [promptTemplateId], references: [id])`
   - `versionNumber Int`
   - `content String @db.Text` — snapshot of prompt text at this version
   - `variables Json? @db.JsonB` — snapshot of variables at this version
   - `changeReason String?` — why the change was made
   - `changedBy String?` — who made the change

5. Constraints and indexes:
   - `@@unique([tenantId, name])` on PromptTemplate
   - `@@unique([promptTemplateId, versionNumber])` on PromptVersion
   - `@@index([tenantId])` on PromptTemplate
   - `@@index([departmentId])` on PromptTemplate
   - `@@index([category])` on PromptTemplate
   - `@@index([promptTemplateId])` on PromptVersion

6. Validate: `npx prisma validate`

7. Commit: `feat(database): add PromptTemplate and PromptVersion models`

---

## Task 2: Create DnaWritingStyle + Usage Record Prisma Schemas

**Files**:
- Create: `packages/database/src/prisma/db_main/dna-writing-style.prisma`
- Test: Verify with `npx prisma validate`

**Steps**:

1. Create schema with 4 models: `DnaWritingStyleReport`, `DnaWritingStyleVersion`, `DnaUsageRecord`, `PromptUsageRecord`

2. **NO enums** — `DnaSourceType`, `DnaUsageType`, `PromptUsageType` are all removed

3. `DnaWritingStyleReport` fields:
   - Standard meta/audit/resourceStatus fields
   - `doctorId String` — FK to User (relation name: `"DoctorDnaReports"`)
   - `Doctor User @relation("DoctorDnaReports", fields: [doctorId], references: [id])`
   - `departmentId String?` — FK to Department
   - `Department Department? @relation(fields: [departmentId], references: [id])`
   - `reportData Json? @db.JsonB` — the DNA analysis result data
   - `styleText String? @db.Text` — the extracted writing style text
   - `isLatest Boolean @default(true)` — marks the current active report
   - `currentVersionNumber Int @default(1)` — tracks latest version
   - **NO `sourceType`** — reports are always per-doctor
   - **NO `sourceDoctorId`** — redundant with `doctorId`

4. `DnaWritingStyleVersion` fields:
   - Standard meta fields (id, tenantId, createdAt)
   - `dnaReportId String` — FK to DnaWritingStyleReport
   - `DnaWritingStyleReport DnaWritingStyleReport @relation(fields: [dnaReportId], references: [id])`
   - `versionNumber Int`
   - `reportData Json? @db.JsonB` — snapshot of analysis data at this version
   - `styleText String? @db.Text` — snapshot of style text at this version
   - `changeReason String?`
   - `changedBy String?`

5. `DnaUsageRecord` fields (lightweight audit log):
   - Standard meta fields (id, tenantId, createdAt)
   - `doctorId String` — plain ID, NO FK
   - `dnaReportId String` — plain ID, NO FK
   - `dnaVersionNumber Int?` — which version was used
   - `consultationId String?` — plain ID, NO FK to ContextItem
   - `departmentId String?` — plain ID, NO FK
   - **NO `usageType`** — just record the facts

6. `PromptUsageRecord` fields (lightweight audit log):
   - Standard meta fields (id, tenantId, createdAt)
   - `promptTemplateId String` — plain ID, NO FK
   - `promptVersionNumber Int?` — which version was used
   - `consultationId String?` — plain ID, NO FK to ContextItem
   - `doctorId String?` — plain ID, NO FK
   - `departmentId String?` — plain ID, NO FK
   - **NO `usageType`** — just record the facts

7. Indexes:
   - `DnaWritingStyleReport`: `@@index([tenantId])`, `@@index([doctorId])`, `@@index([departmentId])`, `@@index([doctorId, isLatest])`
   - `DnaWritingStyleVersion`: `@@index([dnaReportId])`, `@@unique([dnaReportId, versionNumber])`
   - `DnaUsageRecord`: `@@index([tenantId])`, `@@index([doctorId])`, `@@index([dnaReportId])`, `@@index([consultationId])`
   - `PromptUsageRecord`: `@@index([tenantId])`, `@@index([promptTemplateId])`, `@@index([consultationId])`

8. Validate: `npx prisma validate`

9. Commit: `feat(database): add DnaWritingStyle and usage tracking models`

---

## Task 3: Update Department Model Relations

**Files**:
- Modify: `packages/database/src/prisma/db_main/department.prisma`
- Test: Verify with `npx prisma validate`

**Steps**:

1. Add reverse relations to Department model:
   ```prisma
   PromptTemplates        PromptTemplate[]
   DnaWritingStyleReports DnaWritingStyleReport[]
   ```

2. Verify that `Department` already has these fields (from TASK-021):
   - `defaultDnaStyleId String?` — used for department-level DNA fallback (plain string, NOT an FK)
   - `defaultSummaryTemplate String?`
   - `newPatientPromptId String?` — determines the "default" prompt for new patients (replaces `isDefault` on PromptTemplate)
   - `revisitPromptId String?` — determines the "default" prompt for revisits
   - `promptMetadata Json? @db.JsonB`

3. Keep `defaultDnaStyleId`, `newPatientPromptId`, `revisitPromptId` as plain string references — do NOT add FK relations to `PromptTemplate` for these. This maintains flexibility and avoids circular dependency concerns.

4. Validate: `npx prisma validate`

5. Commit: `feat(database): add Department relations to PromptTemplate and DnaWritingStyleReport`

---

## Task 4: Run Prisma Migration (optional so SKIP THIS TASK)

---

## Task 5: Generate Prisma Client

**Files**:
- Auto-generated: `packages/database/src/prisma/generated/`

**Steps**:

1. Generate client:
   ```bash
   cd packages/database
   npx prisma generate
   ```

2. Verify new types are available:
   - `PromptTemplate`, `PromptVersion`, `PromptTemplateCategory`
   - `DnaWritingStyleReport`, `DnaWritingStyleVersion`
   - `DnaUsageRecord`
   - `PromptUsageRecord`

3. Commit: `chore(database): regenerate Prisma client with new models`

---

## Task 6: Create Domain Entities

**Files**:
- Create: `packages/domains/src/entities/generated/core/PromptTemplateEntity.ts`
- Create: `packages/domains/src/entities/generated/core/PromptVersionEntity.ts`
- Create: `packages/domains/src/entities/generated/core/DnaWritingStyleReportEntity.ts`
- Create: `packages/domains/src/entities/generated/core/DnaWritingStyleVersionEntity.ts`
- Create: `packages/domains/src/entities/generated/core/DnaUsageRecordEntity.ts`
- Create: `packages/domains/src/entities/generated/core/PromptUsageRecordEntity.ts`
- Test: `packages/domains/src/entities/generated/core/__tests__/PromptTemplateEntity.test.ts` (etc.)

**Steps**:

1. Follow existing patterns from `DepartmentEntity.ts` and `ConsultationEntity.ts`:
   - Extend `BaseTenantEntity`
   - Private fields with getters/setters using `setProperty()` for change tracking
   - Domain methods for core models:
     - `PromptTemplateEntity`: `isActive()`, `incrementVersion()`
     - `DnaWritingStyleReportEntity`: `isLatest`, `markAsLatest()`, `incrementVersion()`
   - Usage record entities: minimal — just fields, no domain methods needed (they are insert-only audit logs)

2. Write tests for domain methods:
   - Entity creation with required fields
   - Change tracking (modify field → `entity.hasChanges` is true)
   - Domain-specific methods (core models only)

3. Commit: `feat(domains): add domain entities for prompt and DNA models`

---

## Task 7: Create Domain Factories

**Files**:
- Create: `packages/domains/src/factories/generated/core/PromptTemplateFactory.ts`
- Create: (5 more factory files)
- Test: `packages/domains/src/factories/generated/core/__tests__/PromptTemplateFactory.test.ts`

**Steps**:

1. Follow existing pattern from `DepartmentFactory.ts`:
   - Static `CreateEntity(props)` method
   - Use `generateId()` for UUID7
   - Set sensible defaults for optional fields
   - Initialize timestamps

2. Write tests:
   - Factory creates entity with correct ID format
   - Factory applies default values
   - Factory doesn't overwrite provided values

3. Commit: `feat(domains): add factories for prompt and DNA models`

---

## Task 8: Create Domain Repositories

**Files**:
- Create: `packages/domains/src/repositories/generated/core/PromptTemplateRepository.ts`
- Create: (5 more repository files)
- Test: `packages/domains/src/repositories/generated/core/__tests__/PromptTemplateRepository.test.ts`

**Steps**:

1. Extend `Repository<Entity, Model>`:
   - Base methods: `findById`, `findAll`, `create`, `update`, `softDelete`
   - Custom methods per repository:
     - `PromptTemplateRepository`: `findByName(tenantId, name)`, `findByDepartment(departmentId)`, `findByCategory(category)`
     - `PromptVersionRepository`: `findByTemplate(templateId)`, `findLatestVersion(templateId)`
     - `DnaWritingStyleReportRepository`: `findLatestForDoctor(doctorId)`, `findByDepartment(departmentId)`, `findAllForDoctor(doctorId)`
     - `DnaWritingStyleVersionRepository`: `findByReport(reportId)`, `findLatestVersion(reportId)`
     - `DnaUsageRecordRepository`: `findByDoctor(doctorId)`, `findByReport(reportId)`, `findByConsultation(consultationId)`
     - `PromptUsageRecordRepository`: `findByTemplate(templateId)`, `findByDepartment(departmentId)`
   - **Note**: `findDefaults(departmentId)` removed from PromptTemplateRepository — defaults come from Department fields

2. Write integration tests (or unit tests with mocked Prisma client)

3. Commit: `feat(domains): add repositories for prompt and DNA models`

---

## Task 9: Create Domain Mappers

**Files**:
- Create: `packages/domains/src/mappers/generated/core/PromptTemplateEntityMapper.ts`
- Create: (5 more mapper files)

**Steps**:

1. Follow existing pattern from `DepartmentEntityMapper.ts`:
   - `toPersistence(entity)` — Entity → Prisma Model
   - `toPersistenceChanges(entity)` — Partial Model (only changed fields)
   - `toDomainEntity(model)` — Prisma Model → Entity
   - Use `AutoClassMapper` and `createMapperHandlers`

2. Handle JSON fields correctly:
   - `PromptTemplate.variables` (Json) ↔ typed object
   - `DnaWritingStyleReport.reportData` (Json) ↔ typed object
   - `DnaWritingStyleVersion.reportData` (Json) ↔ typed object

3. Usage record mappers: straightforward field mapping, no JSON handling needed

4. Commit: `feat(domains): add mappers for prompt and DNA models`

---

## Task 10: Wire Domain Exports

**Files**:
- Modify: `packages/domains/src/entities/generated/core/index.ts`
- Modify: `packages/domains/src/factories/generated/core/index.ts`
- Modify: `packages/domains/src/repositories/generated/core/index.ts`
- Modify: `packages/domains/src/mappers/generated/core/index.ts`
- Modify: `packages/domains/src/models/generated/core/index.ts`

**Steps**:

1. Add barrel exports for all 6 new entities, factories, repositories, mappers

2. Verify `@arcaai/domains` package builds:
   ```bash
   cd packages/domains
   pnpm build
   ```

3. Verify no circular dependency issues

4. Commit: `feat(domains): wire exports for prompt and DNA domain artifacts`

---

## Task 11: Create Seed Data for Prompt Templates, DNA Reports, and Usage Records

**Files**:
- Create: `packages/database/src/prisma/db_main/seed/07-prompt-template.ts`
- Create: `packages/database/src/prisma/db_main/seed/08-dna-writing-style.ts`
- Modify: `packages/database/src/prisma/db_main/seed/index.ts` (add new seed functions)
- Modify: `packages/database/src/__tests__/seed.test.ts` (add tests for new seed data)

**Steps**:

1. **Create `07-prompt-template.ts`** following the pattern in `04-department.ts`:

   Seed data should include:
   - **4 PromptTemplate records** (one per `PromptTemplateCategory`):
     - `SYSTEM` category: "System Default Prompt" — a general-purpose system prompt
     - `SUMMARY` category: "SOAP Summary Prompt" — a SOAP-formatted clinical summary prompt
     - `DNA_ANALYSIS` category: "DNA Writing Style Analysis Prompt" — the prompt used by SmrAdapterService for DNA generation
     - `CUSTOM` category: "Custom Department Prompt" — an example custom prompt assigned to a specific department (e.g. Cardiology)
   - All templates should:
     - Use deterministic UUIDs (pattern: `71000000-0000-0000-0000-00000000000X`)
     - Use `DEFAULT_TENANT_ID` (`50000000-0000-0000-0000-000000000000`)
     - Have realistic `content` (actual prompt text, not placeholder)
     - Have `variables` JSON with example variable definitions (e.g. `{ "patient_name": { "type": "string", "required": true } }`)
     - Have `currentVersionNumber: 1`
     - The CUSTOM template should set `departmentId` to the Cardiology department ID (`70000000-0000-0000-0000-000000000002`)
   - **4 PromptVersion records** (one initial v1 per template):
     - Use deterministic UUIDs (pattern: `72000000-0000-0000-0000-00000000000X`)
     - `versionNumber: 1`
     - `content` matches the parent template's content
     - `variables` matches the parent template's variables
     - `changeReason: "Initial version"`
     - `changedBy: "60000000-0000-0000-0000-000000000000"` (system user)

   Export: `DEFAULT_PROMPT_TEMPLATES`, `DEFAULT_PROMPT_VERSIONS`, `seedPromptTemplate`

   Seeding function:
   ```typescript
   export const seedPromptTemplate = async (client: CorePrismaClient) => {
       console.log('Seeding prompt templates...');
       for (const template of DEFAULT_PROMPT_TEMPLATES) {
           await client.promptTemplate.upsert({
               where: { id: template.id },
               update: template,
               create: template,
           });
       }
       for (const version of DEFAULT_PROMPT_VERSIONS) {
           await client.promptVersion.upsert({
               where: { id: version.id },
               update: version,
               create: version,
           });
       }
       console.log(`Seeded ${DEFAULT_PROMPT_TEMPLATES.length} prompt templates with ${DEFAULT_PROMPT_VERSIONS.length} versions`);
   };
   ```

2. **Create `08-dna-writing-style.ts`** following the same pattern:

   Seed data should include:
   - **2 DnaWritingStyleReport records** (for 2 different seed doctors):
     - Doctor 1 (from `91-user.ts` seed): latest report, assigned to General Practice department
     - Doctor 2 (from `91-user.ts` seed): latest report, assigned to Cardiology department
   - All reports should:
     - Use deterministic UUIDs (pattern: `73000000-0000-0000-0000-00000000000X`)
     - Use `DEFAULT_TENANT_ID`
     - Have realistic `reportData` JSON (e.g. `{ "formality": "high", "sentenceLength": "medium", "medicalTermUsage": "frequent", "abbreviationStyle": "standard" }`)
     - Have realistic `styleText` (a paragraph describing the doctor's writing style)
     - Have `isLatest: true`, `currentVersionNumber: 1`
   - **2 DnaWritingStyleVersion records** (one initial v1 per report):
     - Use deterministic UUIDs (pattern: `74000000-0000-0000-0000-00000000000X`)
     - `versionNumber: 1`, matching parent report's data
     - `changeReason: "Initial analysis"`
   - **2 DnaUsageRecord records** (sample usage entries):
     - Use deterministic UUIDs (pattern: `75000000-0000-0000-0000-00000000000X`)
     - Reference the seed doctor IDs and report IDs (plain strings, no FK)
     - `consultationId` can be `null` (no seed consultations required)
   - **2 PromptUsageRecord records** (sample usage entries):
     - Use deterministic UUIDs (pattern: `76000000-0000-0000-0000-00000000000X`)
     - Reference the seed prompt template IDs (plain strings, no FK)
     - `consultationId` can be `null`

   Export: `DEFAULT_DNA_REPORTS`, `DEFAULT_DNA_VERSIONS`, `DEFAULT_DNA_USAGE_RECORDS`, `DEFAULT_PROMPT_USAGE_RECORDS`, `seedDnaWritingStyle`

3. **Update `seed/index.ts`**:
   - Import `seedPromptTemplate` from `./07-prompt-template`
   - Import `seedDnaWritingStyle` from `./08-dna-writing-style`
   - Add calls after `seedStt` and before `seedUser`:
     ```typescript
     // Seed prompt templates (after departments, before users)
     await seedPromptTemplate(client);
     console.log('');

     // Seed DNA writing style reports (after prompt templates, before users)
     await seedDnaWritingStyle(client);
     console.log('');
     ```

4. **Update Department seed to wire `newPatientPromptId` and `revisitPromptId`**:
   - After prompt templates are seeded, update the General Practice department's `newPatientPromptId` to point to the SYSTEM template ID
   - This validates the Department → PromptTemplate string reference flow
   - **Note**: This can be done in `07-prompt-template.ts` as a post-seed step, or as a separate update call

5. **Update `seed.test.ts`** — add test sections for:
   - Prompt Template seed data structure validation
   - Prompt Version seed data integrity (version numbers, content matching parent)
   - DNA Writing Style seed data structure validation
   - DNA Version seed data integrity
   - Usage record seed data structure (plain IDs, no FK validation needed)
   - Dependency chain: templates exist before versions, reports exist before versions
   - Cross-reference: usage record IDs match existing seed template/report IDs

6. Commit: `feat(database): add seed data for prompt templates, DNA reports, and usage records`

---

## Task 12: Update Department Seed with Prompt Template References

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/04-department.ts`
- Modify: `packages/database/src/__tests__/seed.test.ts`

**Steps**:

1. Now that prompt templates have deterministic seed IDs, update the 10 department seed records to wire `newPatientPromptId` and `revisitPromptId` where appropriate:
   - General Practice (`GEN`): `newPatientPromptId` → SYSTEM template ID, `revisitPromptId` → SYSTEM template ID
   - Cardiology (`CARD`): `newPatientPromptId` → CUSTOM template ID (the Cardiology-specific one), `revisitPromptId` → SUMMARY template ID
   - All other departments: keep `null` (they fall back to system defaults via `PromptResolutionService`)

2. Update the existing seed tests:
   - Change the test "should have null newPatientPromptId for all departments" to validate the new non-null values for GEN and CARD
   - Change the test "should have null revisitPromptId for all departments" similarly
   - Add a test verifying referenced prompt template IDs match known seed IDs

3. **Important**: This change must happen AFTER Task 11 (seed order: departments first, then prompt templates, but department update happens after prompt templates are seeded). Handle this by either:
   - Running the department prompt-wiring as a post-seed step in `07-prompt-template.ts`
   - Or updating the department seed data directly with the deterministic prompt template IDs (since IDs are known at compile time)

4. Commit: `feat(database): wire department seed data with prompt template references`

---

## Completion Gate

Before marking WS-1 complete:
- [ ] `db:all` passes (including `npx prisma validate` and `npx prisma migrate dev`)
- [ ] Rollback SQL tested (only `PromptTemplateCategory` enum to drop — no `DnaSourceType`, `DnaUsageType`, `PromptUsageType`)
- [ ] `packages/domains` builds without errors
- [ ] All domain artifact tests pass
- [ ] Seed data runs cleanly: `07-prompt-template.ts` and `08-dna-writing-style.ts` seed without errors
- [ ] Seed tests pass: new sections in `seed.test.ts` validate structure, integrity, and cross-references
- [ ] Department seed updated with prompt template references (GEN and CARD departments)
- [ ] No circular dependency warnings
- [ ] Signal WS-2, WS-3 engineers to proceed
