# Plan: WS-3 — Backend Enhancements + MLflow Removal

**Required Skill**: executing-plans  
**Assigned to**: Engineer C  
**Estimated Duration**: 2 days  
**Dependencies**: WS-1 (database + domain layer) must complete first  
**Branch**: `feat/sdk-207-ws3-backend-enhancements`

## Goal

Enhance existing backend modules (summary versioning, department PATCH endpoint, DTO exposure) and remove the MLflow proxy module. These are all changes to existing code rather than new modules.

## Architecture Overview

This workstream focuses on fixing gaps in existing services: SummaryService should create ContextItemVersions on update, DepartmentController needs a PATCH endpoint, and the MLflow proxy module should be removed since prompt/DNA management is now PostgreSQL-native (WS-2).

## Tech Stack

- NestJS 11.x, TypeScript
- `@arcaai/domains` (ContextItemVersionFactory, DepartmentRepository)
- `@arcaai/applications` (SummaryService, DepartmentService)
- Vitest for testing

## Acceptance Criteria

- [x] `SummaryService.updateSummary()` creates `ContextItemVersion` before updating
- [x] `UpdateSummaryRequest` supports `changeReason`, `changeSummary`, `changeSource`
- [ ] ~~`GenerateSummaryRequest` supports `additionalContext`~~ — **Deferred**: relevant when summary generation migrates to SMR v2
- [x] `DepartmentController` has `PATCH /departments/:id` endpoint
- [x] `DepartmentResponse` DTO exposes prompt fields
- [x] MLflow module removed from `app.module.ts` and filesystem
- [x] All existing tests still pass after changes
- [x] No breaking changes to existing API contracts

---

## Task 1: Enhance UpdateSummaryRequest DTO

**Files**:
- Modify: `packages/applications/src/services/consultation/summary/dto/update-summary.request.ts`
- Test: Validate DTO decorators work correctly

**Steps**:

1. Read current file (only has `content?: string`)

2. Add fields:
   ```typescript
   @IsOptional()
   @IsString()
   changeReason?: string;

   @IsOptional()
   @IsString()
   changeSummary?: string;

   @IsOptional()
   @IsString()
   @IsIn(['doctor_edit', 'ai_regeneration', 'system'])
   changeSource?: string;
   ```

3. Write test: validate DTO accepts all new fields and rejects invalid `changeSource`

4. Commit: `feat(applications): add change metadata to UpdateSummaryRequest`

---

## Task 2: Add Version Creation to SummaryService.updateSummary

**Files**:
- Modify: `packages/applications/src/services/consultation/summary/summary.service.ts`
- Test: `packages/applications/src/services/consultation/summary/__tests__/summary.service.test.ts`

**Steps**:

1. Write failing test:
   - Call `updateSummary(contextItemId, { content: 'new content', changeReason: 'doctor edit' })`
   - Verify a `ContextItemVersion` was created with:
     - `contextItemId` matching
     - `versionNumber` incremented
     - `content` = previous content (snapshot before update)
     - `changeReason` from request
     - `changeSource` from request
     - `changedBy` = requestUserId

2. Implement version creation in `updateSummary()`:
   ```typescript
   async updateSummary(contextItemId: string, request: UpdateSummaryRequest): Promise<SummaryResponse> {
     const contextItem = await this.contextItemRepository.findById(contextItemId);
     // ... existing validation ...

     const previousData = contextItem.toObject();

     // Create version snapshot BEFORE updating
     const nextVersion = (contextItem.versionNumber ?? 0) + 1;
     const version = ContextItemVersionFactory.CreateUserEditVersion({
       contextItemId: contextItem.id,
       versionNumber: nextVersion,
       content: contextItem.content,  // snapshot of CURRENT content
       changeReason: request.changeReason ?? 'Manual edit',
       changeSummary: request.changeSummary,
       changeSource: request.changeSource ?? 'doctor_edit',
       changedBy: this.requestUserId,
     });
     await this.contextItemVersionRepository.create(version);

     // Now update the actual content
     if (request.content !== undefined) {
       contextItem.content = request.content;
     }
     contextItem.versionNumber = nextVersion;
     // ... rest of existing logic ...
   }
   ```

3. Verify `ContextItemVersionFactory.CreateUserEditVersion` exists. If not, check what factory methods are available and adapt.

4. Commit: `feat(applications): add ContextItemVersion creation to summary update`

---

## Task 3: Enhance GenerateSummaryRequest DTO

**Files**:
- Modify: `packages/applications/src/services/consultation/summary/dto/generate-summary.request.ts`
- Test: Validate DTO accepts `additionalContext`

**Steps**:

1. Add field:
   ```typescript
   @IsOptional()
   @IsString()
   additionalContext?: string;
   ```

2. Verify the `SummaryService.generateSummary()` method passes this field through to the SMR request body

3. If the SMR request doesn't support `additionalContext`, add it to the request payload (may need coordination with WS-2's SmrAdapterService)

4. Commit: `feat(applications): add additionalContext to GenerateSummaryRequest`

---

## Task 4: Add PATCH Endpoint to DepartmentController

**Files**:
- Modify: `apps/api/src/modules/department/department.controller.ts`
- Create or Modify: `packages/applications/src/services/department/dto/update-department.request.ts`
- Test: `apps/api/src/modules/department/__tests__/department.controller.test.ts`

**Steps**:

1. Write controller test:
   - `PATCH /departments/:id` with `@UseGuards(JwtAuthGuard)` + `@CanManage('all')`
   - Accepts partial update fields
   - Returns updated `DepartmentResponse`

2. Check if `DepartmentService.update()` already exists (evidence says it does). If so, this is controller-only work.

3. Create `UpdateDepartmentRequest` DTO if it doesn't exist:
   ```typescript
   export class UpdateDepartmentRequest {
     @IsOptional() @IsString() name?: string;
     @IsOptional() @IsString() description?: string;
     @IsOptional() @IsString() defaultDnaStyleId?: string;
     @IsOptional() @IsString() defaultSummaryTemplate?: string;
     @IsOptional() @IsString() newPatientPromptId?: string;
     @IsOptional() @IsString() revisitPromptId?: string;
     @IsOptional() promptMetadata?: Record<string, unknown>;
   }
   ```

4. Add controller endpoint:
   ```typescript
   @Patch(':id')
   @UseGuards(JwtAuthGuard)
   @CanManage('all')
   @ApiOperation({ summary: 'Update department' })
   @ApiParam({ name: 'id', description: 'Department ID' })
   @ApiResponse({ status: 200, type: DepartmentResponse })
   async updateDepartment(
     @Param('id') id: string,
     @Body() request: UpdateDepartmentRequest,
   ): Promise<DepartmentResponse> { ... }
   ```

5. Commit: `feat(api): add PATCH endpoint to DepartmentController`

---

## Task 5: Expose Prompt Fields in DepartmentResponse DTO

**Files**:
- Modify: `packages/applications/src/services/department/dto/department.response.ts`
- Modify: `packages/applications/src/services/department/dto/dto.mapper.ts` (if exists)
- Test: Verify response includes new fields

**Steps**:

1. Add fields to `DepartmentResponse`:
   ```typescript
   @ApiProperty({ required: false }) defaultDnaStyleId?: string;
   @ApiProperty({ required: false }) defaultSummaryTemplate?: string;
   @ApiProperty({ required: false }) newPatientPromptId?: string;
   @ApiProperty({ required: false }) revisitPromptId?: string;
   @ApiProperty({ required: false }) promptMetadata?: Record<string, unknown>;
   ```

2. Update the mapper to include these fields from the Department entity

3. Verify existing GET endpoints now return these fields

4. Commit: `feat(applications): expose prompt fields in DepartmentResponse DTO`

---

## Task 6: Remove MLflow Proxy Module

**Files**:
- Remove: `apps/api/src/modules/mlflow/` (entire directory)
- Modify: `apps/api/src/app.module.ts` (remove MlflowModule import)
- Test: Verify app starts without errors

**Steps**:

1. Before removal, verify:
   - No other modules import from `apps/api/src/modules/mlflow/`
   - No services depend on MLflow routes
   - PromptResolutionService does NOT use MLflow (confirmed — it uses Department fields)

2. Search for any references:
   ```bash
   rg "mlflow" apps/api/src/ --type ts
   rg "MlflowModule" apps/api/src/
   rg "MlflowController" apps/api/src/
   ```

3. Remove the directory:
   ```bash
   rm -rf apps/api/src/modules/mlflow/
   ```

4. Remove from `app.module.ts` imports array

5. Remove any `MLFLOW_URL` references in the API app (leave infrastructure config alone — that's a separate concern)

6. Verify app compiles and starts:
   ```bash
   cd apps/api
   pnpm build
   ```

7. **Note**: Do NOT remove `apps/mlflow/` Python service directory — that is an infrastructure concern and may be needed for migration period

8. Commit: `refactor(api): remove MLflow proxy module — replaced by PostgreSQL-native prompt and DNA modules`

---

## Task 7: Verify Summary and Chain Summary Paths

**Files**:
- Modify (if needed): `packages/applications/src/services/consultation/summary/summary.service.ts`
- Modify (if needed): `packages/applications/src/services/consultation/summary/chain-summary.service.ts`
- Test: Verify prompt resolution is used in generate paths

**Steps**:

1. Audit `SummaryService.generateSummary()` and `ChainSummaryService`:
   - Do they call `PromptResolutionService.resolve()` or `resolveWithContent()`?
   - If not, they should use it to determine `dnaStyleId`, `template`, and `promptId`

2. If changes needed, add `PromptResolutionService` to constructor and use in generate flow

3. This should be a low-risk change since `PromptResolutionService.resolve()` is backwards compatible (from TASK-021)

4. Commit: `fix(applications): ensure summary generation paths use PromptResolutionService`

---

## Completion Gate

Before marking WS-3 complete:
- [x] `updateSummary()` creates ContextItemVersion (verify with test) — 8 tests added
- [x] `PATCH /departments/:id` works — 3 controller tests pass
- [x] DepartmentResponse includes all prompt fields — mapper updated
- [x] MLflow module removed, no references remain in `apps/api/src/`
- [x] All existing tests still pass (39 total: 36 summary + 3 department)
- [x] No breaking changes to existing API contracts
- [ ] Signal WS-5 (SDK hooks) that backend enhancements are ready

---

## Implementation Summary

**Completed**: 2026-02-18
**TDD**: All features implemented test-first (Red-Green-Refactor)
**Tests**: 39 tests total (36 summary service + 3 department controller), all passing

### Files Modified

| File | Change |
|------|--------|
| `packages/applications/src/services/consultation/summary/dto/update-summary.request.ts` | Added `changeReason`, `changeSummary`, `changeSource` fields |
| `packages/applications/src/services/consultation/summary/summary.service.ts` | Added `ContextItemVersionRepository` injection; `updateSummary()` now creates version snapshot before update |
| `packages/applications/src/services/consultation/summary/__tests__/summary.service.test.ts` | Added 8 `updateSummary` tests for version creation |
| `packages/applications/src/services/department/dto/update-department.request.ts` | Added 5 prompt fields (`defaultDnaStyleId`, `defaultSummaryTemplate`, `newPatientPromptId`, `revisitPromptId`, `promptMetadata`) |
| `packages/applications/src/services/department/dto/department.response.ts` | Added 5 prompt fields to response DTO |
| `packages/applications/src/services/department/department.dto.mapper.ts` | Maps prompt fields from entity to response |
| `apps/api/src/modules/department/department.controller.ts` | Added `PATCH /departments/:id` endpoint with `@CanManage('all')` |
| `apps/api/src/modules/department/__tests__/department.controller.test.ts` | Created: 3 tests for PATCH endpoint |
| `apps/api/src/app.module.ts` | Removed `MlflowModule` import and registration |

### Files Deleted

| File | Reason |
|------|--------|
| `apps/api/src/modules/mlflow/mlflow.controller.ts` | MLflow proxy replaced by PostgreSQL-native prompt/DNA modules (WS-2) |
| `apps/api/src/modules/mlflow/mlflow.module.ts` | Same |
| `apps/api/src/modules/mlflow/index.ts` | Same |

### Deferred Tasks

| Task | Reason | When |
|------|--------|------|
| Task 3: `additionalContext` on `GenerateSummaryRequest` | Summary generation still uses SMR v1; this field is for SMR v2 | When summary generation migrates to SMR v2 |
| Task 7: Wire `PromptResolutionService` into summary paths | Same — relevant when summary generation moves to SMR v2 | When summary generation migrates to SMR v2 |

### Key Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Used `ContextItemVersionFactory.CreateFromContextItem()` (not `CreateUserEditVersion`) | `CreateFromContextItem` accepts custom `changeReason` and `changeSource` from the request, while `CreateUserEditVersion` hardcodes them |
| 2 | Added `ContextItemVersionRepository` as last constructor parameter | Avoids breaking existing constructor call order in tests and DI |
| 3 | Version snapshot created BEFORE content update | Ensures the version captures the previous state, not the new state |
| 4 | Deferred Tasks 3 and 7 | Both relate to SMR v2 integration which hasn't happened yet for summary generation; implementing now would be premature (YAGNI) |
