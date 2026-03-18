# TASK-025: Department, DNA & Prompt Refinement

**Ticket**: TASK-025
**Created**: 2026-02-18
**Last Updated**: 2026-02-18
**Status**: Completed

**Required Skill**: executing-plans

## Goal

Refine the Department, DNA Writing Style, and Prompt Management implementations based on code review findings: decouple DNA from Department, add the missing `preSummaryPromptId`, rename `promptMetadata` to `promptConfig`, move `assignToDepartment` to its correct aggregate, and clean up redundant logic.

## Architecture Overview

The changes follow the existing DDD layered architecture (Database → Domain → Application → API). Each layer is updated bottom-up. DNA Writing Style becomes purely per-doctor with no Department FK. Department gains a typed `promptConfig` field and a third prompt slot (`preSummaryPromptId`). The `assignToDepartment` operation moves from `PromptManagementService` to `DepartmentService` to respect aggregate boundaries.

## Tech Stack

- Prisma 7 (PostgreSQL)
- NestJS 11 (TypeScript)
- Vitest (testing)
- class-validator / @nestjs/swagger (DTOs)

---

## Scope Summary

| # | Task | Layer | Files |
|---|------|-------|-------|
| 1 | Remove `departmentId` FK from `DnaWritingStyleReport` | Database | 2 schema files |
| 2 | Remove `defaultDnaStyleId` from `Department` | Database | 1 schema file |
| 3 | Add `preSummaryPromptId` to `Department` | Database | 1 schema file |
| 4 | Rename `promptMetadata` → `promptConfig` in `Department` | Database | 1 schema file |
| 5 | Update DNA DTO: remove `departmentId` from response/request | Application | 3 files |
| 6 | Update DNA service: remove department fallback logic | Application | 2 files |
| 7 | Update DNA processor: remove `departmentId` from report creation | Application | 1 file |
| 8 | Update Department DTOs: add `preSummaryPromptId`, rename field, remove `defaultDnaStyleId` | Application | 3 files |
| 9 | Update Department mapper & service | Application | 2 files |
| 10 | Move `assignToDepartment` from PromptManagement to Department | Application | 4 files |
| 11 | Update PromptResolutionService: remove DNA department tier, add preSummary, rename field | Application | 1 file |
| 12 | Fix `listPromptTemplates` combined filter logic | Application | 1 file |
| 13 | Update API controllers: auth guards, new endpoint, remove old endpoint | API | 3 files |
| 14 | Update seed data | Database | 2 seed files |
| 15 | Update all tests | Tests | ~8 test files |

---

## Task 1: Remove `departmentId` FK from `DnaWritingStyleReport`

DNA Writing Style is per-doctor. The `departmentId` FK and `Department` relation must be removed.

**Files**:
- Modify: `packages/database/src/prisma/db_main/dna-writing-style.prisma`
- Modify: `packages/database/src/prisma/db_main/department.prisma`

**Changes to `dna-writing-style.prisma`**:
- Remove lines 19-21 (`departmentId`, `Department` relation)
- Remove line 46 (`departmentId` index)

**Before**:
```prisma
    // Department (optional FK)
    departmentId String?
    Department   Department? @relation(fields: [departmentId], references: [id])
```

**After**: Lines removed entirely.

**Before** (index):
```prisma
    @@index([departmentId], name: "DnaWritingStyleReport_departmentId_idx")
```

**After**: Line removed entirely.

**Changes to `department.prisma`**:
- Remove line 43 (`DnaWritingStyleReports DnaWritingStyleReport[]`)

**Before**:
```prisma
    DnaWritingStyleReports DnaWritingStyleReport[]
```

**After**: Line removed entirely.

> Note: `DnaUsageRecord.departmentId` is a plain audit field (no FK) — keep it as-is.

---

## Task 2: Remove `defaultDnaStyleId` from `Department`

DNA style is per-doctor, not per-department. The department should not hold a default DNA style reference.

**Files**:
- Modify: `packages/database/src/prisma/db_main/department.prisma`

**Before**:
```prisma
    defaultDnaStyleId      String?  // Default DNA writing style for this department
```

**After**: Line removed entirely.

---

## Task 3: Add `preSummaryPromptId` to `Department`

Complete the 3-prompt fallback: pre-summary, new patient, revisit.

**Files**:
- Modify: `packages/database/src/prisma/db_main/department.prisma`

**Before**:
```prisma
    newPatientPromptId     String?  // Prompt ID for new/referral patients in this department
    revisitPromptId        String?  // Prompt ID for revisit/follow-up patients
```

**After**:
```prisma
    preSummaryPromptId     String?  // Prompt ID for pre-summary generation in this department
    newPatientPromptId     String?  // Prompt ID for new/referral patients in this department
    revisitPromptId        String?  // Prompt ID for revisit/follow-up patients
```

---

## Task 4: Rename `promptMetadata` → `promptConfig` in `Department`

Give the JSON field a clearer, more intentional name.

**Files**:
- Modify: `packages/database/src/prisma/db_main/department.prisma`

**Before**:
```prisma
    promptMetadata         Json?    @db.JsonB  // Additional prompt config (context variables, style overrides, etc.)
```

**After**:
```prisma
    promptConfig           Json?    @db.JsonB  // Department prompt configuration (contextVariables, preferredSections, abbreviationDensity)
```

### Final `department.prisma` after Tasks 1-4

```prisma
model Department {
    // Meta fields
    metaData Json?  @map("_metadata") @db.JsonB
    version  Int    @default(1) @map("_version")
    id       String @id @default(uuid(7))

    // Multi-tenant
    tenantId String @default("50000000-0000-0000-0000-000000000000")

    // Department info
    code        String?
    name        String?
    description String?

    // Prompt configuration
    defaultSummaryTemplate String?  // Default summary template (e.g., "SOAP", "Hematology-New", "ER-Triage")
    preSummaryPromptId     String?  // Prompt ID for pre-summary generation in this department
    newPatientPromptId     String?  // Prompt ID for new/referral patients in this department
    revisitPromptId        String?  // Prompt ID for revisit/follow-up patients
    promptConfig           Json?    @db.JsonB  // Department prompt configuration (contextVariables, preferredSections, abbreviationDensity)

    // Optional: parent department for hierarchy
    parentDepartmentId String?
    ParentDepartment   Department?  @relation("DepartmentHierarchy", fields: [parentDepartmentId], references: [id])
    ChildDepartments   Department[] @relation("DepartmentHierarchy")

    // Resource status + Audit
    resourceStatus          ResourceStatusType @default(ENABLED)
    resourceStatusUpdatedAt DateTime?
    resourceStatusUpdatedBy String?
    createdBy               String?  @default("60000000-0000-0000-0000-000000000000")
    updatedBy               String?
    createdAt               DateTime @default(now())
    updatedAt               DateTime @updatedAt

    // Relations
    Consultations   Consultation[]
    PromptTemplates PromptTemplate[]

    // Constraints
    @@unique([tenantId, code])

    // Indexes
    @@index([tenantId], name: "Department_tenantId_idx")
    @@index([parentDepartmentId], name: "Department_parentDepartmentId_idx")
    @@schema("core")
}
```

---

## Task 5: Update DNA DTOs — remove `departmentId`

**Files**:
- Modify: `packages/applications/src/services/dna-writing-style/dto/dna-report.response.ts`
- Modify: `packages/applications/src/services/dna-writing-style/dto/generate-dna-report.request.ts`
- Modify: `packages/applications/src/services/dna-writing-style/dna-writing-style.dto.mapper.ts`

### `dna-report.response.ts`

Remove the `departmentId` field:
```typescript
// REMOVE:
@ApiPropertyOptional({ description: 'Department ID' })
departmentId?: string;
```

### `generate-dna-report.request.ts`

Remove the `departmentId` field:
```typescript
// REMOVE:
@ApiPropertyOptional({ description: 'Department ID for prompt template lookup' })
@IsOptional()
@IsString()
departmentId?: string;
```

### `dna-writing-style.dto.mapper.ts`

Remove `departmentId` from `toReportResponse`:
```typescript
// REMOVE from return object:
departmentId: entity.departmentId ?? undefined,
```

**Test**: Write test first confirming `departmentId` is NOT present in the mapped response.

---

## Task 6: Update DNA service — remove department fallback

**Files**:
- Modify: `packages/applications/src/services/dna-writing-style/dna-writing-style.service.ts`
- Modify: `packages/applications/src/services/dna-writing-style/IDnaWritingStyleService.ts`

### `dna-writing-style.service.ts`

1. Remove `DepartmentRepository` import and constructor injection
2. Remove `getDnaReportWithFallback` method entirely (or simplify to just `getDnaReport`)
3. Remove `departmentId` from `GenerateDnaReportJobPayload`
4. Update `generateDnaReport` to not pass `departmentId`

**Before** (`getDnaReportWithFallback`):
```typescript
async getDnaReportWithFallback(doctorId: string, departmentId?: string): Promise<DnaReportResponse | null> {
    const doctorReport = await this.dnaReportRepository.findLatestForDoctor(doctorId);
    if (doctorReport) return DnaWritingStyleDtoMapper.toReportResponse(doctorReport);
    if (departmentId) {
        const department = await this.departmentRepository.findById(departmentId);
        // ... fallback logic
    }
    return null;
}
```

**After**: Remove `getDnaReportWithFallback`. The existing `getDnaReport(doctorId)` is sufficient.

### `IDnaWritingStyleService.ts`

Remove `getDnaReportWithFallback` from the interface.

### `GenerateDnaReportJobPayload`

Remove `departmentId` field.

**Test**: Write test confirming `DnaWritingStyleService` does NOT inject `DepartmentRepository` and `getDnaReport` returns null when no doctor report exists (no fallback).

---

## Task 7: Update DNA processor — remove `departmentId` from report creation

**Files**:
- Modify: `packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts`

**Changes**:
1. Remove `departmentId` from job payload destructuring
2. Remove `departmentId` from `DnaWritingStyleReportFactory.CreateDnaWritingStyleReport` call
3. Remove `departmentId` from `PromptUsageRecordFactory.CreatePromptUsageRecord` call
4. Fix `(previousLatest as any).unmarkAsLatest()` → `previousLatest.isLatest = false`

**Test**: Write test confirming processor creates report without `departmentId`.

---

## Task 8: Update Department DTOs

**Files**:
- Modify: `packages/applications/src/services/department/dto/department.response.ts`
- Modify: `packages/applications/src/services/department/dto/update-department.request.ts`
- Modify: `packages/applications/src/services/department/dto/create-department.request.ts`

### `department.response.ts`

- Remove `defaultDnaStyleId`
- Add `preSummaryPromptId`
- Rename `promptMetadata` → `promptConfig`

**After**:
```typescript
export class DepartmentResponse {
    @ApiProperty({ description: 'Department ID' })
    id: string;

    @ApiPropertyOptional({ description: 'Department code', example: 'CARD' })
    code?: string;

    @ApiPropertyOptional({ description: 'Department name', example: 'Cardiology' })
    name?: string;

    @ApiPropertyOptional({ description: 'Department description' })
    description?: string;

    @ApiPropertyOptional({ description: 'Parent department ID (for hierarchy)' })
    parentDepartmentId?: string;

    @ApiProperty({ description: 'Whether this is a root department (no parent)' })
    isRootDepartment: boolean;

    @ApiProperty({ description: 'Creation timestamp' })
    createdAt: string;

    @ApiProperty({ description: 'Last update timestamp' })
    updatedAt: string;

    @ApiPropertyOptional({ description: 'Default summary template for this department' })
    defaultSummaryTemplate?: string;

    @ApiPropertyOptional({ description: 'Prompt template ID for pre-summary generation' })
    preSummaryPromptId?: string;

    @ApiPropertyOptional({ description: 'Prompt template ID for new/referral patients' })
    newPatientPromptId?: string;

    @ApiPropertyOptional({ description: 'Prompt template ID for revisit patients' })
    revisitPromptId?: string;

    @ApiPropertyOptional({ description: 'Department prompt configuration' })
    promptConfig?: Record<string, unknown>;
}
```

### `update-department.request.ts`

- Remove `defaultDnaStyleId`
- Add `preSummaryPromptId`
- Rename `promptMetadata` → `promptConfig`

### `create-department.request.ts`

No changes needed — create only accepts `code`, `name`, `description`, `parentDepartmentId`. Prompt config is set via update.

**Test**: Write test first for the new DTO shape.

---

## Task 9: Update Department mapper & service

**Files**:
- Modify: `packages/applications/src/services/department/department.dto.mapper.ts`
- Modify: `packages/applications/src/services/department/department.service.ts`
- Modify: `packages/applications/src/services/department/IDepartmentService.ts`

### `department.dto.mapper.ts`

- Remove `defaultDnaStyleId` mapping
- Add `preSummaryPromptId` mapping
- Rename `promptMetadata` → `promptConfig`

**After**:
```typescript
export class DepartmentDtoMapper {
    static toResponse(entity: DepartmentEntity): DepartmentResponse {
        return {
            id: entity.id,
            code: entity.code ?? undefined,
            name: entity.name ?? undefined,
            description: entity.description ?? undefined,
            parentDepartmentId: entity.parentDepartmentId ?? undefined,
            isRootDepartment: entity.isRootDepartment,
            createdAt: entity.createdAt.toISOString(),
            updatedAt: entity.updatedAt.toISOString(),
            defaultSummaryTemplate: entity.defaultSummaryTemplate ?? undefined,
            preSummaryPromptId: entity.preSummaryPromptId ?? undefined,
            newPatientPromptId: entity.newPatientPromptId ?? undefined,
            revisitPromptId: entity.revisitPromptId ?? undefined,
            promptConfig: (entity.promptConfig as Record<string, unknown>) ?? undefined,
        };
    }
}
```

### `department.service.ts`

Add `updatePromptConfig` method (moved from PromptManagementService):

```typescript
async updatePromptConfig(id: string, dto: UpdateDepartmentPromptConfigRequest): Promise<DepartmentResponse> {
    const department = await this.departmentRepository.findById(id);
    if (!department) throw new NotFoundException(`Department ${id} not found`);

    if (dto.preSummaryPromptId !== undefined) department.preSummaryPromptId = dto.preSummaryPromptId;
    if (dto.newPatientPromptId !== undefined) department.newPatientPromptId = dto.newPatientPromptId;
    if (dto.revisitPromptId !== undefined) department.revisitPromptId = dto.revisitPromptId;

    if (!department.hasChanges) throw new ArgumentInvalidException('No changes to write to.');

    const updated = await this.departmentRepository.update(id, department);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: updated.id,
        data: department.changes,
    });

    return DepartmentDtoMapper.toResponse(updated);
}
```

### `IDepartmentService.ts`

Add `updatePromptConfig` to the interface.

**Test**: Write tests for the new mapper shape and the `updatePromptConfig` method.

---

## Task 10: Move `assignToDepartment` from PromptManagement to Department

**Files**:
- Modify: `packages/applications/src/services/prompt-management/prompt-management.service.ts`
- Modify: `packages/applications/src/services/prompt-management/IPromptManagementService.ts`
- Modify: `packages/applications/src/services/prompt-management/dto/assign-department-prompt.request.ts` → Move to department DTOs
- Modify: `packages/applications/src/services/prompt-management/prompt-management.service.module.ts`

### `prompt-management.service.ts`

- Remove `assignToDepartment` method
- Remove `DepartmentRepository` import and constructor injection

### `IPromptManagementService.ts`

- Remove `assignToDepartment` from interface
- Remove `AssignDepartmentPromptRequest` import

### `prompt-management.service.module.ts`

No change needed — `CoreDatabaseModule` provides all repositories, but the service no longer uses `DepartmentRepository`.

### Move `AssignDepartmentPromptRequest`

Rename to `UpdateDepartmentPromptConfigRequest` and move to `packages/applications/src/services/department/dto/`. Update to include `preSummaryPromptId`:

```typescript
import { IsString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateDepartmentPromptConfigRequest {
    @ApiPropertyOptional({ description: 'Prompt template ID for pre-summary generation' })
    @IsOptional()
    @IsString()
    preSummaryPromptId?: string;

    @ApiPropertyOptional({ description: 'Prompt template ID for new patients' })
    @IsOptional()
    @IsString()
    newPatientPromptId?: string;

    @ApiPropertyOptional({ description: 'Prompt template ID for revisits' })
    @IsOptional()
    @IsString()
    revisitPromptId?: string;
}
```

**Test**: Write tests confirming `PromptManagementService` no longer has `assignToDepartment` and `DepartmentService.updatePromptConfig` works correctly.

---

## Task 11: Update `PromptResolutionService`

**Files**:
- Modify: `packages/applications/src/services/consultation/prompt/prompt-resolution.service.ts`

**Changes**:
1. Remove `dnaStyleId` from `ResolvedPromptConfig` — DNA resolution is no longer part of prompt resolution
2. Remove `SYSTEM_DEFAULTS.dnaStyleId`
3. Remove doctor DNA style lookup (`resolveDoctorDnaStyleId`)
4. Add `preSummaryPromptId` resolution
5. Rename `promptMetadata` → `promptConfig` in `extractContextVariables`
6. Add `promptType` parameter to `resolve()` to distinguish pre-summary / new-patient / revisit

**After** (`ResolvedPromptConfig`):
```typescript
export interface ResolvedPromptConfig {
    template: string;
    promptId: string;
    contextVariables: Record<string, unknown>;
    resolvedFrom: PromptResolutionTier;
    resolutionTrace: PromptResolutionTrace;
}
```

**After** (`PromptResolutionParams`):
```typescript
export interface PromptResolutionParams {
    departmentId?: string;
    promptType?: 'pre-summary' | 'new-patient' | 'revisit';
    explicitTemplate?: string;
}
```

**After** (prompt resolution logic):
```typescript
let promptId: string | null = null;
if (department) {
    switch (params.promptType) {
        case 'pre-summary':
            promptId = department.preSummaryPromptId ?? null;
            break;
        case 'revisit':
            promptId = department.revisitPromptId ?? null;
            break;
        case 'new-patient':
        default:
            promptId = department.newPatientPromptId ?? null;
            break;
    }
}
if (!promptId) {
    promptId = SYSTEM_DEFAULTS.promptId;
    trace.usedDefaults.push('promptId');
}
```

**Test**: Write tests for the 3 prompt type resolutions and the removal of DNA from this service.

---

## Task 12: Fix `listPromptTemplates` combined filter logic

**Files**:
- Modify: `packages/applications/src/services/prompt-management/prompt-management.service.ts`

**Before**:
```typescript
if (filters?.category) {
    templates = await this.promptTemplateRepository.findByCategory(filters.category);
} else if (filters?.departmentId) {
    templates = await this.promptTemplateRepository.findByDepartment(filters.departmentId);
} else {
    templates = await this.promptTemplateRepository.findAll({});
}
```

**After**:
```typescript
const qb = this.promptTemplateRepository.$();
if (filters?.category) qb.Where({ category: filters.category });
if (filters?.departmentId) qb.Where({ departmentId: filters.departmentId });
const templates = await qb.ToList();
```

**Test**: Write test confirming both filters are applied simultaneously.

---

## Task 13: Update API controllers

**Files**:
- Modify: `apps/api/src/modules/department/department.controller.ts`
- Modify: `apps/api/src/modules/prompt-management/prompt-management.controller.ts`
- Modify: `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts`
- Modify: `apps/api/src/modules/dna-writing-style/dna-writing-style-admin.controller.ts`

### `department.controller.ts`

Add new endpoint and delete endpoint:

```typescript
@Patch(':id/prompt-config')
@CanManage('all')
@ApiOperation({ summary: 'Update department prompt configuration' })
@ApiParam({ name: 'id', description: 'Department ID' })
@ApiResponse({ status: 200, type: DepartmentResponse })
async updatePromptConfig(
    @Param('id') id: string,
    @Body() dto: UpdateDepartmentPromptConfigRequest,
): Promise<DepartmentResponse> {
    return this.departmentService.updatePromptConfig(id, dto);
}

@Delete(':id')
@CanManage('all')
@ApiOperation({ summary: 'Soft delete department' })
@ApiParam({ name: 'id', description: 'Department ID' })
@ApiResponse({ status: 200, type: DepartmentResponse })
async deleteDepartment(@Param('id') id: string): Promise<DepartmentResponse> {
    return this.departmentService.deleteById(id);
}
```

### `prompt-management.controller.ts`

1. Remove `POST /prompt-templates/assign-department` endpoint
2. Add `@UseGuards(JwtAuthGuard)` at controller level (remove per-method guards)

### `dna-writing-style.controller.ts`

1. Replace `getDnaReportWithFallback` call with `getDnaReport` in `getMyStyle`
2. Add proper user validation (replace `as any` with proper typing)

### `dna-writing-style-admin.controller.ts`

Add `@UseGuards(JwtAuthGuard)` at controller level.

**Test**: Write controller tests for new endpoints and removed endpoints.

---

## Task 14: Update seed data

**Files**:
- Modify: `packages/database/src/prisma/db_main/seed/04-department.ts`
- Modify: `packages/database/src/prisma/db_main/seed/08-dna-writing-style.ts`

### `04-department.ts`

For each department:
- Remove `defaultDnaStyleId`
- Add `preSummaryPromptId` (pointing to `TEMPLATE_IDS.PRE_SUMMARY_SYSTEM` or department-specific pre-summary)
- Rename `promptMetadata` → `promptConfig`

### `08-dna-writing-style.ts`

- Remove `departmentId` from all `DEFAULT_DNA_REPORTS` entries

**Test**: Seed data is configuration — no TDD needed (per skill exception for pure configuration changes).

---

## Task 15: Update all tests

**Files**:
- Modify: `packages/applications/src/services/department/__tests__/department.dto.mapper.test.ts`
- Modify: `packages/applications/src/services/department/__tests__/department.service.test.ts`
- Modify: `apps/api/src/modules/department/__tests__/department.controller.test.ts`
- Modify: `packages/applications/src/services/dna-writing-style/__tests__/dna-writing-style.service.test.ts`
- Modify: `packages/applications/src/services/dna-writing-style/__tests__/dna-writing-style.processor.test.ts`
- Modify: `packages/applications/src/services/dna-writing-style/__tests__/dna-writing-style.dto.mapper.test.ts`
- Modify: `packages/applications/src/services/prompt-management/__tests__/prompt-management.service.test.ts`
- Modify: `packages/applications/src/services/prompt-management/__tests__/prompt-management.controller.test.ts`

All existing tests that reference `defaultDnaStyleId`, `promptMetadata`, `departmentId` (on DNA), or `assignToDepartment` must be updated to reflect the new structure.

New tests to add:
- `DepartmentService.updatePromptConfig` — happy path, not found, no changes
- `DepartmentDtoMapper` — `preSummaryPromptId` mapping, `promptConfig` mapping, absence of `defaultDnaStyleId`
- `DepartmentController` — `PATCH /departments/:id/prompt-config`, `DELETE /departments/:id`
- `PromptResolutionService` — 3 prompt types, no DNA field, `promptConfig` extraction
- `PromptManagementService.listPromptTemplates` — combined category + departmentId filter

---

## Execution Order

Tasks must be executed in this order due to dependencies:

```
Tasks 1-4 (Database schema) — can be done together
    ↓
Task 5 (DNA DTOs)
    ↓
Tasks 6-7 (DNA service + processor)
    ↓
Task 8 (Department DTOs)
    ↓
Tasks 9-10 (Department service + move assignToDepartment)
    ↓
Task 11 (PromptResolutionService)
    ↓
Task 12 (listPromptTemplates fix)
    ↓
Task 13 (API controllers)
    ↓
Task 14 (Seed data)
    ↓
Task 15 (Test updates)
```

## Execution Pathway

Use the `executing-plans` skill for automated execution:
- Fresh agent per task
- Code review between tasks
- Quality gates at each step

---

## Requirement Analysis

| Requirement | How Addressed |
|---|---|
| DNA is per-user, NOT linked to department | Tasks 1, 5, 6, 7, 14 — remove all `departmentId` FK and fallback logic |
| 3 default prompts (pre-summary, new-patient, revisit) | Tasks 3, 8, 9, 11 — add `preSummaryPromptId` across all layers |
| Remove/rename `promptMetadata` | Tasks 4, 8, 9, 11, 14 — rename to `promptConfig` everywhere |
| Clean up redundant logic | Tasks 6, 10, 12 — remove fallback, move aggregate logic, fix filters |
| Best practices | Tasks 10, 13 — respect aggregate boundaries, consistent auth guards |
