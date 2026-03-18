# Plan: WS-2 — Prompt Template + DNA Writing Style Backend Modules (Simplified)

**Required Skill**: executing-plans
**Assigned to**: Engineer B
**Estimated Duration**: 2 days
**Dependencies**: WS-1 (database + domain layer) must complete first; TASK-023 (SMR V2) must be available for DNA generation
**Branch**: `feat/sdk-207-ws2-prompt-dna`

## Goal

Build two new NestJS backend modules: **Prompt Template management** (CRUD + versioning + department assignment) and **DNA Writing Style management** (async generation via SMR V2 + versioning + department fallback). DNA generation uses a BullMQ processor that calls SMR V2's `POST /api/v2/generate` endpoint synchronously (`stream: false`) — following the exact same pattern as existing summary processors.

## Architecture Overview

```
┌──────────────┐     ┌──────────────────────┐     ┌──────────────┐
│  SDK / Client │────▶│  NestJS API Gateway   │────▶│  PostgreSQL  │
│              │     │                      │     │  (Prisma)    │
│              │     │  ┌─────────────────┐ │     └──────────────┘
│              │     │  │ PromptMgmt      │ │
│              │     │  │ Controller (7)  │ │
│              │     │  └─────────────────┘ │
│              │     │  ┌─────────────────┐ │     ┌──────────────┐
│              │     │  │ DnaWritingStyle │ │────▶│  BullMQ      │
│              │     │  │ Controller (4)  │ │     │  (Redis)     │
│              │     │  │ Admin Ctrl (3)  │ │     └──────┬───────┘
│              │     │  └─────────────────┘ │            │
│              │     └──────────────────────┘            │
│              │                                         ▼
│              │                                  ┌──────────────┐
│              │                                  │ DnaProcessor │
│              │                                  │ (BullMQ)     │
│              │                                  └──────┬───────┘
│              │                                         │
│              │                                         │ POST /api/v2/generate
│              │                                         │ { stream: false }
│              │                                         ▼
│              │                                  ┌──────────────┐
│              │                                  │  SMR V2      │
│              │                                  │  (Python)    │
│              │                                  └──────────────┘
```

Both modules are PostgreSQL-only (no MLflow). DNA generation calls SMR V2 (`POST /api/v2/generate`) with the DNA_ANALYSIS prompt as `system_prompt` and the doctor's text samples as `prompt`. The Prompt Template module provides the DNA_ANALYSIS prompt category that the DNA module consumes.

## Tech Stack

- NestJS 11.x, TypeScript
- `@arcaai/domains` (entities, repositories, factories)
- `@arcaai/applications` (service layer)
- SMR V2 Python service (`POST /api/v2/generate`) — TASK-023
- BullMQ for async DNA generation jobs
- Vitest for testing

## Design Decisions (from Brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | No SmrAdapterService | Follow existing processor pattern. DNA processor calls SMR V2 directly via `HttpService`, same as summary processors call V1 |
| D2 | Synchronous SMR V2 call (`stream: false`) | DNA generation is a background job; no need for streaming complexity. Simple request/response |
| D3 | Same `SMR_SERVICE_URL` env var | V1 and V2 on same host. DNA processor uses `/api/v2/generate` path |
| D4 | Silent usage recording | Insert `PromptUsageRecord`/`DnaUsageRecord` as side effects — no endpoints, no separate service classes. Just `repository.create()` calls |
| D5 | Full DDD service layer pattern | Consistency with existing codebase: Interface + Service + DTOs + Mapper + Module per module |
| D6 | 14 endpoints total (7 prompt + 7 DNA) | Down from 22 in original plan. Covers all core operations without bloat |
| D7 | PromptResolutionService unchanged | Content lookup happens at PromptManagementService/DnaWritingStyleService layer, not in PromptResolutionService |
| D8 | ComprehensiveSummaryProcessor fix skipped | Already wired with PromptResolutionService in previous task (TASK-021) |
| D9 | List endpoint handles filtering | No need for separate get-by-name, get-by-department endpoints — list with query params covers both |

## Endpoint Specification

### Prompt Template Controller (`@Controller('prompt-templates')`)

| # | Method | Path | Guard | Description |
|---|--------|------|-------|-------------|
| 1 | `POST` | `/` | `@CanManage('all')` | Create template + initial PromptVersion snapshot |
| 2 | `GET` | `/` | `@JwtAuthGuard` | List templates (`?category=&departmentId=&tags=`) |
| 3 | `GET` | `/:id` | `@JwtAuthGuard` | Get template by ID |
| 4 | `PATCH` | `/:id` | `@CanManage('all')` | Update template (auto-creates new PromptVersion) |
| 5 | `DELETE` | `/:id` | `@CanManage('all')` | Soft delete (resourceStatus) |
| 6 | `GET` | `/:id/versions` | `@JwtAuthGuard` | Get version history for a template |
| 7 | `POST` | `/assign-department` | `@CanManage('all')` | Update Department's `newPatientPromptId` / `revisitPromptId` |

### DNA Writing Style Doctor Controller (`@Controller('dna-writing-styles')`, `@UseGuards(JwtAuthGuard)`)

| # | Method | Path | Description |
|---|--------|------|-------------|
| 1 | `POST` | `/generate` | Queue DNA generation for current doctor (BullMQ job) |
| 2 | `GET` | `/my-style` | Get current doctor's latest DNA report (with dept fallback) |
| 3 | `PATCH` | `/:reportId` | Update DNA report (auto-creates new DnaWritingStyleVersion) |
| 4 | `GET` | `/:reportId/versions` | Get version history for a report |

### DNA Writing Style Admin Controller (`@Controller('admin/dna-writing-styles')`, `@CanManage('all')`)

| # | Method | Path | Description |
|---|--------|------|-------------|
| 5 | `POST` | `/generate/:doctorId` | Queue DNA generation for a specific doctor |
| 6 | `GET` | `/` | List all DNA reports (paginated, filterable by doctorId) |
| 7 | `GET` | `/jobs/:jobId` | Get job status for a DNA generation job |

## Error Handling

| Scenario | Handling |
|----------|---------|
| Prompt template not found | 404 `NotFoundException` |
| Duplicate template name (unique constraint) | 409 `ConflictException` |
| SMR V2 timeout (120s) | Processor marks job FAILED, logs error |
| SMR V2 returns invalid response | Processor marks job FAILED, stores raw response in error field |
| No text samples for doctor | Processor marks job FAILED: "No text samples found for doctor" |
| DNA_ANALYSIS prompt template missing | Processor marks job FAILED: "No DNA_ANALYSIS prompt template configured" |
| Department not found (assign-department) | 404 `NotFoundException` |
| Report not found (update DNA) | 404 `NotFoundException` |
| Unauthorized | Auth guards handle — 401/403 automatically |

## Acceptance Criteria

- [ ] Prompt Template module: 7 endpoints (CRUD + versioning + assign-department)
- [ ] DNA Writing Style module: 7 endpoints (generate, get, update, versions, admin generate, admin list, job status)
- [ ] DnaWritingStyleProcessor: BullMQ processor calling SMR V2 `POST /api/v2/generate` with `stream: false`
- [ ] All endpoints have Swagger documentation (`@ApiOperation`, `@ApiResponse`)
- [ ] Auth guards: `CanManage` for admin endpoints, `JwtAuthGuard` for doctor endpoints
- [ ] Unit tests for all services, controller tests with mocked services
- [ ] Silent usage recording: `PromptUsageRecord` and `DnaUsageRecord` written as side effects (no endpoints)
- [ ] PromptResolutionService NOT modified
- [ ] New `GenerateDnaReport` job queue added to `JobQueue` enum

## Explicit Deferrals (YAGNI)

| Feature | Reason |
|---------|--------|
| Usage tracking endpoints | No business need yet — audit logs exist silently |
| DNA recommendations endpoint | Complex feature, no immediate use case |
| Get prompt by name endpoint | List with filter covers this |
| Get prompts by department endpoint | List with `departmentId` filter covers this |
| Streaming DNA generation | Background job doesn't need streaming |
| PromptResolutionService modifications | Content lookup at service layer is sufficient |
| ComprehensiveSummaryProcessor fix | Already wired in TASK-021 |
| PromptUsageService (separate class) | Inline `repository.create()` call is sufficient |
| DnaUsageService (separate class) | Inline `repository.create()` call is sufficient |

---

## Task 1: Create Prompt Management Service Layer

**Files**:
- Create: `packages/applications/src/services/prompt-management/prompt-management.service.ts`
- Create: `packages/applications/src/services/prompt-management/prompt-management.service.module.ts`
- Create: `packages/applications/src/services/prompt-management/IPromptManagementService.ts`
- Create: `packages/applications/src/services/prompt-management/dto/create-prompt-template.request.ts`
- Create: `packages/applications/src/services/prompt-management/dto/update-prompt-template.request.ts`
- Create: `packages/applications/src/services/prompt-management/dto/prompt-template.response.ts`
- Create: `packages/applications/src/services/prompt-management/dto/prompt-version.response.ts`
- Create: `packages/applications/src/services/prompt-management/dto/assign-department-prompt.request.ts`
- Create: `packages/applications/src/services/prompt-management/dto/index.ts`
- Create: `packages/applications/src/services/prompt-management/prompt-management.dto.mapper.ts`
- Create: `packages/applications/src/services/prompt-management/index.ts`
- Test: `packages/applications/src/services/prompt-management/__tests__/prompt-management.service.test.ts`

**Steps**:

1. Write failing tests for `PromptManagementService`:
   - `createPromptTemplate()` — creates template + initial `PromptVersion` snapshot
   - `updatePromptTemplate()` — creates new `PromptVersion` snapshot, increments `currentVersionNumber`
   - `getPromptTemplate()` — lookup by ID
   - `listPromptTemplates()` — paginated with filters (category, departmentId, tags)
   - `getVersions()` — version history for a template
   - `assignToDepartment()` — updates Department's `newPatientPromptId` / `revisitPromptId` fields
   - `softDeletePromptTemplate()` — uses `resourceStatus`
   - Verify silent `PromptUsageRecord` creation when template content is consumed

2. Implement `IPromptManagementService` interface (abstract class):
   ```typescript
   export abstract class IPromptManagementService {
       abstract createPromptTemplate(dto: CreatePromptTemplateRequest): Promise<PromptTemplateResponse>;
       abstract updatePromptTemplate(id: string, dto: UpdatePromptTemplateRequest): Promise<PromptTemplateResponse>;
       abstract getPromptTemplate(id: string): Promise<PromptTemplateResponse | null>;
       abstract listPromptTemplates(filters?: { category?: string; departmentId?: string; tags?: string[] }): Promise<PromptTemplateResponse[]>;
       abstract getVersions(templateId: string): Promise<PromptVersionResponse[]>;
       abstract assignToDepartment(dto: AssignDepartmentPromptRequest): Promise<void>;
       abstract softDeletePromptTemplate(id: string): Promise<PromptTemplateResponse>;
   }
   ```

3. Implement `PromptManagementService` following `DepartmentService` patterns:
   - Use `BaseService` for event broadcasting
   - Use `ClsService` for `tenantId` and `requestUserId`
   - Use `PromptTemplateRepository`, `PromptVersionRepository`, `DepartmentRepository`
   - Use `PromptTemplateFactory`, `PromptVersionFactory`
   - Use `PromptUsageRecordRepository` for silent usage recording

4. Key behavior: Every `update()` MUST:
   - Snapshot current content as a new `PromptVersion`
   - Increment `currentVersionNumber`
   - Store `changeReason` from request

5. Silent usage recording: When another service calls `getPromptTemplate()` with a `consultationId` context, insert a `PromptUsageRecord` via `PromptUsageRecordRepository.create()`. This is a one-line side effect, not a separate service.

6. DTOs follow existing patterns:
   - Request DTOs use `class-validator` decorators
   - Response DTOs are plain classes with `@ApiProperty`
   - Mapper converts Entity → Response (in `prompt-management.dto.mapper.ts`)

7. Module follows `DepartmentServiceModule` pattern:
   ```typescript
   @Module({
       imports: [CommonServiceModule, CoreDatabaseModule],
       providers: [
           { provide: IPromptManagementService, useClass: PromptManagementService },
           PromptManagementService,
       ],
       exports: [IPromptManagementService, PromptManagementService],
   })
   export class PromptManagementServiceModule {}
   ```

8. Commit: `feat(applications): add Prompt Template management service`

---

## Task 2: Create Prompt Management NestJS Module + Controller

**Files**:
- Create: `apps/api/src/modules/prompt-management/prompt-management.module.ts`
- Create: `apps/api/src/modules/prompt-management/prompt-management.controller.ts`
- Create: `apps/api/src/modules/prompt-management/index.ts`
- Modify: `apps/api/src/app.module.ts` (add `PromptManagementModule` to `featureModules`)
- Test: `apps/api/src/modules/prompt-management/__tests__/prompt-management.controller.test.ts`

**Steps**:

1. Write controller tests (mock service) for all 7 endpoints:

   | Method | Path | Guard | Description |
   |--------|------|-------|-------------|
   | `POST` | `/` | `@CanManage('all')` | Create prompt template |
   | `GET` | `/` | `@JwtAuthGuard` | List prompt templates (with query filters) |
   | `GET` | `/:id` | `@JwtAuthGuard` | Get prompt template by ID |
   | `PATCH` | `/:id` | `@CanManage('all')` | Update prompt template (auto-versions) |
   | `DELETE` | `/:id` | `@CanManage('all')` | Soft delete prompt template |
   | `GET` | `/:id/versions` | `@JwtAuthGuard` | Get version history |
   | `POST` | `/assign-department` | `@CanManage('all')` | Assign template to department |

2. Implement controller with Swagger decorators:
   - `@ApiTags('PromptTemplates')`
   - `@ApiBearerAuth()`
   - `@ApiOperation`, `@ApiResponse`, `@ApiParam`, `@ApiQuery` on all endpoints

3. Module follows `DepartmentModule` pattern:
   ```typescript
   @Module({
       imports: [PromptManagementServiceModule],
       controllers: [PromptManagementController],
   })
   export class PromptManagementModule {}
   ```

4. Register in `app.module.ts` by adding `PromptManagementModule` to `featureModules` array

5. Commit: `feat(api): add Prompt Template management module`

---

## Task 3: Create DNA Writing Style Service Layer + Processor

**Files**:
- Create: `packages/applications/src/services/dna-writing-style/dna-writing-style.service.ts`
- Create: `packages/applications/src/services/dna-writing-style/dna-writing-style.service.module.ts`
- Create: `packages/applications/src/services/dna-writing-style/IDnaWritingStyleService.ts`
- Create: `packages/applications/src/services/dna-writing-style/dna-writing-style.processor.ts`
- Create: `packages/applications/src/services/dna-writing-style/dto/generate-dna-report.request.ts`
- Create: `packages/applications/src/services/dna-writing-style/dto/update-dna-report.request.ts`
- Create: `packages/applications/src/services/dna-writing-style/dto/dna-report.response.ts`
- Create: `packages/applications/src/services/dna-writing-style/dto/dna-version.response.ts`
- Create: `packages/applications/src/services/dna-writing-style/dto/index.ts`
- Create: `packages/applications/src/services/dna-writing-style/dna-writing-style.dto.mapper.ts`
- Create: `packages/applications/src/services/dna-writing-style/index.ts`
- Modify: `packages/domains/src/enums/JobQueue.enum.ts` (add `GenerateDnaReport`)
- Test: `packages/applications/src/services/dna-writing-style/__tests__/dna-writing-style.service.test.ts`
- Test: `packages/applications/src/services/dna-writing-style/__tests__/dna-writing-style.processor.test.ts`

**Steps**:

### 3a. Add `GenerateDnaReport` to JobQueue enum

Add to `packages/domains/src/enums/JobQueue.enum.ts`:
```typescript
GenerateDnaReport = 'GenerateDnaReport',
```

### 3b. Write failing tests for `DnaWritingStyleService`

Test the following methods:
- `generateDnaReport()` — queues a BullMQ job, returns job status
- `getDnaReport()` — returns latest report for doctor
- `getDnaReportWithFallback()` — doctor → department fallback
- `updateDnaReport()` — manual edit, creates new version snapshot
- `getVersions()` — version history
- `listReports()` — admin: paginated listing with optional doctorId filter
- Verify silent `DnaUsageRecord` creation when report is consumed

### 3c. Write failing tests for `DnaWritingStyleProcessor`

Follow the exact test pattern from `summary.processor.test.ts`:
- Processor gathers text samples from ContextItems
- Processor fetches DNA_ANALYSIS prompt template via `PromptManagementService`
- Processor calls `POST /api/v2/generate` on SMR V2 with `stream: false`
- Processor stores `DnaWritingStyleReport` + `DnaWritingStyleVersion`
- Processor records `DnaUsageRecord` and `PromptUsageRecord` (silent)
- Error handling: SMR timeout, invalid response, no text samples, no DNA_ANALYSIS template

### 3d. Implement `IDnaWritingStyleService` interface

```typescript
export abstract class IDnaWritingStyleService {
    abstract generateDnaReport(dto: GenerateDnaReportRequest): Promise<{ jobId: string }>;
    abstract getDnaReport(doctorId: string): Promise<DnaReportResponse | null>;
    abstract getDnaReportWithFallback(doctorId: string, departmentId?: string): Promise<DnaReportResponse | null>;
    abstract updateDnaReport(reportId: string, dto: UpdateDnaReportRequest): Promise<DnaReportResponse>;
    abstract getVersions(reportId: string): Promise<DnaVersionResponse[]>;
    abstract listReports(filters?: { doctorId?: string }): Promise<DnaReportResponse[]>;
}
```

### 3e. Implement `DnaWritingStyleService`

- Use `ClsService` for `tenantId` and `requestUserId`
- Use `DnaWritingStyleReportRepository`, `DnaWritingStyleVersionRepository`, `DnaUsageRecordRepository`
- Use BullMQ `@InjectQueue(JobQueue.GenerateDnaReport)` to queue generation jobs

Key behaviors:
- `generateDnaReport()`: validates request, queues BullMQ job, returns `{ jobId }`
- `getDnaReportWithFallback()`:
  1. Find latest report where `doctorId` matches AND `isLatest = true`
  2. If not found AND `departmentId` provided, look up `Department.defaultDnaStyleId`
  3. If that ID exists, find the report by ID
  4. If neither, return null
- `updateDnaReport()`: snapshot current data as new version, increment `currentVersionNumber`

### 3f. Implement `DnaWritingStyleProcessor`

Follow `SummaryProcessor` pattern exactly:

```typescript
@Processor(JobQueue.GenerateDnaReport)
export class DnaWritingStyleProcessor extends WorkerHost {
    private readonly logger = new Logger(DnaWritingStyleProcessor.name);
    private readonly smrServiceUrl: string;

    constructor(
        @Inject(IConsultationJobService) private readonly jobService: IConsultationJobService,
        private readonly contextItemRepository: ContextItemRepository,
        private readonly dnaReportRepository: DnaWritingStyleReportRepository,
        private readonly dnaVersionRepository: DnaWritingStyleVersionRepository,
        private readonly dnaUsageRecordRepository: DnaUsageRecordRepository,
        private readonly promptUsageRecordRepository: PromptUsageRecordRepository,
        private readonly promptManagementService: PromptManagementService,
        private readonly httpService: HttpService,
        private readonly configService: ConfigService,
    ) {
        super();
        this.smrServiceUrl = this.configService.get<string>('SMR_SERVICE_URL') ?? 'http://localhost:5006';
    }

    async process(job: Job<GenerateDnaReportJobPayload>): Promise<DnaReportJobResult> {
        // Step 1: Gather text samples (10%)
        //   - If job.data.textSamples provided, use those
        //   - Otherwise, fetch doctor's edited summaries from ContextItems

        // Step 2: Get DNA_ANALYSIS prompt template (20%)
        //   - Call promptManagementService.listPromptTemplates({ category: 'DNA_ANALYSIS' })
        //   - Use first template's content as system_prompt
        //   - Record PromptUsageRecord (silent)

        // Step 3: Call SMR V2 synchronously (40%)
        //   - POST /api/v2/generate with:
        //     { prompt: textSamples, system_prompt: templateContent, stream: false }
        //   - Get back: { content, usage, latency_ms }

        // Step 4: Store results (80%)
        //   - Set previous latest report's isLatest = false
        //   - Create DnaWritingStyleReport entity via factory (isLatest: true)
        //   - Create DnaWritingStyleVersion (v1)
        //   - Record DnaUsageRecord (silent)

        // Step 5: Complete (100%)
    }

    private async callSmrV2(textSamples: string, systemPrompt: string): Promise<{
        content: string;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        latency_ms?: number;
    }> {
        const response = await this.httpService.axiosRef.post(
            `${this.smrServiceUrl}/api/v2/generate`,
            {
                prompt: textSamples,
                system_prompt: systemPrompt,
                stream: false,
            },
            { timeout: 120000 },
        );
        return response.data;
    }
}
```

### 3g. Job payload types

```typescript
export interface GenerateDnaReportJobPayload {
    jobId: string;
    doctorId: string;
    tenantId: string;
    userId: string;
    departmentId?: string;
    textSamples?: string[];
}

export interface DnaReportJobResult {
    reportId: string;
    reportData: Record<string, unknown>;
    styleText: string;
}
```

### 3h. Module setup

```typescript
@Module({
    imports: [
        CommonServiceModule,
        CoreDatabaseModule,
        HttpModule,
        ConfigModule,
        PromptManagementServiceModule,
        BullModule.registerQueue({ name: JobQueue.GenerateDnaReport }),
    ],
    providers: [
        { provide: IDnaWritingStyleService, useClass: DnaWritingStyleService },
        DnaWritingStyleService,
        DnaWritingStyleProcessor,
    ],
    exports: [IDnaWritingStyleService, DnaWritingStyleService],
})
export class DnaWritingStyleServiceModule {}
```

9. Commit: `feat(applications): add DNA Writing Style service and processor`

---

## Task 4: Create DNA Writing Style NestJS Module + Controllers

**Files**:
- Create: `apps/api/src/modules/dna-writing-style/dna-writing-style.module.ts`
- Create: `apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts`
- Create: `apps/api/src/modules/dna-writing-style/dna-writing-style-admin.controller.ts`
- Create: `apps/api/src/modules/dna-writing-style/index.ts`
- Modify: `apps/api/src/app.module.ts` (add `DnaWritingStyleModule` to `featureModules`)
- Test: `apps/api/src/modules/dna-writing-style/__tests__/dna-writing-style.controller.test.ts`

**Steps**:

1. Write controller tests (mock service) for all 7 endpoints:

   **DnaWritingStyleController** (`@Controller('dna-writing-styles')`, `@UseGuards(JwtAuthGuard)`):
   | Method | Path | Description |
   |--------|------|-------------|
   | `POST` | `/generate` | Queue DNA report generation for current doctor |
   | `GET` | `/my-style` | Get current doctor's latest DNA report (with fallback) |
   | `PATCH` | `/:reportId` | Update DNA report (auto-versions) |
   | `GET` | `/:reportId/versions` | Get version history |

   **DnaWritingStyleAdminController** (`@Controller('admin/dna-writing-styles')`, `@CanManage('all')`):
   | Method | Path | Description |
   |--------|------|-------------|
   | `POST` | `/generate/:doctorId` | Queue DNA generation for a specific doctor |
   | `GET` | `/` | List all DNA reports (paginated, filterable by doctorId) |
   | `GET` | `/jobs/:jobId` | Get job status |

2. Implement controllers with Swagger decorators:
   - `@ApiTags('DnaWritingStyles')`, `@ApiBearerAuth()`
   - `@ApiOperation`, `@ApiResponse`, `@ApiParam` on all endpoints

3. Module:
   ```typescript
   @Module({
       imports: [DnaWritingStyleServiceModule],
       controllers: [DnaWritingStyleController, DnaWritingStyleAdminController],
   })
   export class DnaWritingStyleModule {}
   ```

4. Register in `app.module.ts` by adding `DnaWritingStyleModule` to `featureModules` array

5. Commit: `feat(api): add DNA Writing Style management module`

---

## Completion Gate

Before marking WS-2 complete:
- [ ] All 7 Prompt Template endpoints functional (manual test with Swagger/curl)
- [ ] All 7 DNA Writing Style endpoints functional (4 doctor + 3 admin)
- [ ] DnaWritingStyleProcessor correctly calls SMR V2 `POST /api/v2/generate` with `stream: false`
- [ ] PromptResolutionService NOT modified (verified no changes to file)
- [ ] `GenerateDnaReport` queue registered and working
- [ ] Silent usage recording: `PromptUsageRecord` and `DnaUsageRecord` inserted as side effects
- [ ] All unit tests pass
- [ ] Signal WS-5 (SDK hooks) that backend APIs are ready
