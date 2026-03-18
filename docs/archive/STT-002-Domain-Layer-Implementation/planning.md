# STT-002: Detailed Implementation Planning

| Field | Value |
|-------|-------|
| **Ticket** | STT-002 |
| **Created** | 2026-02-02 |
| **Last Updated** | 2026-02-02 |
| **Status** | Completed |
| **Parent Ticket** | STT-001 |

## Alignment with STT-001 Architecture

This implementation strictly follows the STT-001 architecture specification. Below is the verification matrix:

| Component | STT-001 Specification | STT-002 Implementation | Status |
|-----------|----------------------|------------------------|--------|
| **Database Schema** | | | |
| AsrPipeline model | ✅ Defined (README.md lines 193-228) | ✅ `stt.prisma` | ✓ Aligned |
| AiModel model | ✅ Defined (README.md lines 234-279) | ✅ `stt.prisma` | ✓ Aligned |
| TranscriptionJob model | ✅ Defined (README.md lines 286-328) | ✅ `stt.prisma` | ✓ Aligned |
| **Enums** | | | |
| AiModelSource | ✅ HUGGINGFACE, GITHUB, MLFLOW, LOCAL | ✅ Implemented | ✓ Aligned |
| AiModelFormat | ✅ SAFETENSOR, ONNX, NEMO, PYTORCH | ✅ Implemented | ✓ Aligned |
| AiModelDownloadStatus | ✅ NOT_DOWNLOADED, DOWNLOADING, DOWNLOADED, DOWNLOAD_FAILED | ✅ Implemented | ✓ Aligned |
| TranscriptionJobType | ✅ BATCH, STREAMING | ✅ Implemented | ✓ Aligned |
| TranscriptionJobStatus | ✅ QUEUED, PROCESSING, COMPLETED, FAILED, CANCELLED, DEAD | ✅ Implemented | ✓ Aligned |
| **Responsibility Matrix** | | | |
| AsrPipeline CRUD | API Gateway owns | ✅ PipelineController | ✓ Aligned |
| AiModel CRUD | API Gateway owns | ✅ AiModelController | ✓ Aligned |
| TranscriptionJob create | API Gateway owns | ✅ TranscriptionJobController | ✓ Aligned |
| TranscriptionJob status update | API Gateway (via internal API) | ✅ SttInternalController | ✓ Aligned |
| ContextItem writes | API Gateway owns | ✅ SttInternalService.createTranscript | ✓ Aligned |
| AudioRecording writes | API Gateway owns | ✅ SttInternalService.createAudioRecord | ✓ Aligned |
| **Internal APIs (STT-001 section 4.3)** | | | |
| POST /internal/stt/transcripts | ✅ Required | ✅ Implemented | ✓ Aligned |
| POST /internal/stt/audio-records | ✅ Required | ✅ Implemented | ✓ Aligned |
| PATCH /internal/stt/jobs/:id/start | ✅ Required | ✅ Implemented | ✓ Aligned |
| PATCH /internal/stt/jobs/:id/progress | ✅ Required | ✅ Implemented | ✓ Aligned |
| PATCH /internal/stt/jobs/:id/complete | ✅ Required | ✅ Implemented | ✓ Aligned |
| PATCH /internal/stt/jobs/:id/fail | ✅ Required | ✅ Implemented | ✓ Aligned |

### Enhancements Beyond STT-001

STT-002 includes the following enhancements that improve upon the base architecture:

1. **Additional API Endpoints**:
   - `GET /api/v1/ai-models/asr` - Filter ASR models directly
   - `GET /api/v1/ai-models/vad` - Filter VAD models directly
   - `GET /api/v1/ai-models/downloaded` - List downloaded models
   - `GET /api/v1/transcription-jobs/pending` - List pending jobs
   - `POST /api/v1/transcription-jobs/:id/retry` - Retry failed jobs

2. **Rich Domain Entity Methods**:
   - `TranscriptionJobEntity`: `isBatch`, `isStreaming`, `isQueued`, `isProcessing`, `isCompleted`, `isFailed`, `canRetry`, `durationMs`, `waitTimeMs`, `startProcessing()`, `complete()`, `fail()`, `incrementRetry()`, `cancel()`, `markAsDead()`
   - `AiModelEntity`: `isDownloaded`, `isDownloading`, `isASR`, `isVAD`, `isHuggingFace`, `markAsDownloading()`, `markAsDownloaded()`, `markAsDownloadFailed()`
   - `AsrPipelineEntity`: `isActive`, `jobCount`, `getModelSlugs()`, `getAsrModelSlug()`, `getVadModelSlug()`, `getDenoiseModelSlug()`

3. **Comprehensive Audio Record DTO**:
   - Includes all audio metadata: duration, sampleRate, channels, bitrate, hash, language, sequenceNumber

## Implementation Phases

### Pre-requisite: Database Migration

Before implementing domain layer, ensure Prisma migration is applied.

- [ ] Review `stt.prisma` schema (completed in STT-001)
- [ ] Review `enums.prisma` additions (completed in STT-001)
- [ ] Run `npx prisma migrate dev --name add_stt_models`
- [ ] Verify migration successful
- [ ] Run `npx prisma generate` to regenerate client

---

### Phase 1: Domain Enums

**Location**: `packages/domains/src/enums/generated/`

#### Task 1.1: Create AiModelSource Enum
**File**: `AiModelSource.ts`
```typescript
export enum AiModelSource {
    HUGGINGFACE = 'HUGGINGFACE',
    GITHUB = 'GITHUB',
    MLFLOW = 'MLFLOW',
    LOCAL = 'LOCAL',
}
```

#### Task 1.2: Create AiModelFormat Enum
**File**: `AiModelFormat.ts`
```typescript
export enum AiModelFormat {
    SAFETENSOR = 'SAFETENSOR',
    ONNX = 'ONNX',
    NEMO = 'NEMO',
    PYTORCH = 'PYTORCH',
}
```

#### Task 1.3: Create AiModelDownloadStatus Enum
**File**: `AiModelDownloadStatus.ts`
```typescript
export enum AiModelDownloadStatus {
    NOT_DOWNLOADED = 'NOT_DOWNLOADED',
    DOWNLOADING = 'DOWNLOADING',
    DOWNLOADED = 'DOWNLOADED',
    DOWNLOAD_FAILED = 'DOWNLOAD_FAILED',
}
```

#### Task 1.4: Create TranscriptionJobType Enum
**File**: `TranscriptionJobType.ts`
```typescript
export enum TranscriptionJobType {
    BATCH = 'BATCH',
    STREAMING = 'STREAMING',
}
```

#### Task 1.5: Create TranscriptionJobStatus Enum
**File**: `TranscriptionJobStatus.ts`
```typescript
export enum TranscriptionJobStatus {
    QUEUED = 'QUEUED',
    PROCESSING = 'PROCESSING',
    COMPLETED = 'COMPLETED',
    FAILED = 'FAILED',
    CANCELLED = 'CANCELLED',
    DEAD = 'DEAD',
}
```

#### Task 1.6: Update Index Export
**File**: `enums/generated/index.ts`
- Add exports for all new enums

---

### Phase 2: Domain Models

**Location**: `packages/domains/src/models/generated/core/`

#### Task 2.1: Create AsrPipelineModel
**File**: `AsrPipelineModel.ts`

```typescript
export class AsrPipeline {
    metaData: JsonValue | null;
    version: number;
    id: string;
    tenantId: string | null;
    name: string;
    slug: string;
    description: string | null;
    configYaml: string;
    resourceStatus: ResourceStatusType;
    resourceStatusUpdatedAt: Date | null;
    resourceStatusUpdatedBy: string | null;
    createdBy: string | null;
    updatedBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    tags: string[];
    // Relations
    TranscriptionJobs?: TranscriptionJob[];
}
```

#### Task 2.2: Create AiModelModel
**File**: `AiModelModel.ts`

```typescript
export class AiModel {
    metaData: JsonValue | null;
    version: number;
    id: string;
    tenantId: string | null;
    name: string;
    slug: string;
    description: string | null;
    category: ModelCategory;
    taskType: ModelTaskType;
    modelType: ModelType;
    source: AiModelSource;
    sourceUri: string;
    sourceRevision: string | null;
    format: AiModelFormat;
    memorySizeMb: number | null;
    computeType: string | null;
    downloadStatus: AiModelDownloadStatus;
    localPath: string | null;
    downloadedAt: Date | null;
    fileSizeMb: number | null;
    checksum: string | null;
    resourceStatus: ResourceStatusType;
    resourceStatusUpdatedAt: Date | null;
    resourceStatusUpdatedBy: string | null;
    createdBy: string | null;
    updatedBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    tags: string[];
}
```

#### Task 2.3: Create TranscriptionJobModel
**File**: `TranscriptionJobModel.ts`

```typescript
export class TranscriptionJob {
    metaData: JsonValue | null;
    id: string;
    tenantId: string;
    jobType: TranscriptionJobType;
    consultationId: string | null;
    contextItemId: string | null;
    mediaId: string | null;
    pipelineId: string;
    status: TranscriptionJobStatus;
    progress: number;
    queuedAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    resultText: string | null;
    resultMetadata: JsonValue | null;
    errorMessage: string | null;
    errorCode: string | null;
    retryCount: number;
    maxRetries: number;
    workerId: string | null;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    // Relations
    Pipeline?: AsrPipeline;
}
```

#### Task 2.4: Update Index Export
**File**: `models/generated/core/index.ts`

---

### Phase 3: Domain Entities

**Location**: `packages/domains/src/entities/generated/core/`

#### Task 3.1: Create AsrPipelineEntity
**File**: `AsrPipelineEntity.ts`

**Interface**: `IAsrPipelineEntity`
- All model fields
- `TranscriptionJobs` relation (optional)

**Entity Class**: `AsrPipelineEntity extends BaseTaggedEntity`
- Private fields with getters/setters
- **Custom Domain Methods**:
  - `get isActive(): boolean` - Check if pipeline is enabled
  - `validateConfigYaml(): boolean` - Validate YAML structure
  - `getModelSlugs(): string[]` - Extract model slugs from YAML

#### Task 3.2: Create AiModelEntity
**File**: `AiModelEntity.ts`

**Interface**: `IAiModelEntity`
- All model fields

**Entity Class**: `AiModelEntity extends BaseTaggedEntity`
- Private fields with getters/setters
- **Custom Domain Methods**:
  - `get isDownloaded(): boolean` - Check if downloaded
  - `get isDownloading(): boolean` - Check if currently downloading
  - `get isASR(): boolean` - Check if ASR model
  - `get isVAD(): boolean` - Check if VAD model
  - `markAsDownloading(userId?: string): void`
  - `markAsDownloaded(localPath: string, fileSizeMb: number, checksum?: string, userId?: string): void`
  - `markAsDownloadFailed(userId?: string): void`

#### Task 3.3: Create TranscriptionJobEntity
**File**: `TranscriptionJobEntity.ts`

**Interface**: `ITranscriptionJobEntity`
- All model fields
- `Pipeline` relation (optional)

**Entity Class**: `TranscriptionJobEntity extends BaseTenantEntity`
- Private fields with getters/setters
- **Custom Domain Methods**:
  - `get isBatch(): boolean`
  - `get isStreaming(): boolean`
  - `get isQueued(): boolean`
  - `get isProcessing(): boolean`
  - `get isCompleted(): boolean`
  - `get isFailed(): boolean`
  - `get canRetry(): boolean` - retryCount < maxRetries
  - `startProcessing(workerId: string): void` - Set status to PROCESSING
  - `complete(resultText: string, resultMetadata?: JsonValue): void`
  - `fail(errorMessage: string, errorCode?: string): void`
  - `incrementRetry(): boolean` - Returns false if max retries reached
  - `cancel(): void`
  - `updateProgress(progress: number): void`

#### Task 3.4: Update Index Export
**File**: `entities/generated/core/index.ts`

---

### Phase 4: Domain Factories

**Location**: `packages/domains/src/factories/generated/core/`

#### Task 4.1: Create AsrPipelineFactory
**File**: `AsrPipelineFactory.ts`

```typescript
export interface CreateAsrPipelineProps extends BaseEntityFactoryCreateProps {
    name: string;
    slug: string;
    description?: string | null;
    configYaml: string;
    tenantId?: string | null;
    tags?: string[];
    createdBy?: string | null;
}

export class AsrPipelineFactory {
    static CreateAsrPipeline(props: CreateAsrPipelineProps): AsrPipelineEntity;
}
```

#### Task 4.2: Create AiModelFactory
**File**: `AiModelFactory.ts`

```typescript
export interface CreateAiModelProps extends BaseEntityFactoryCreateProps {
    name: string;
    slug: string;
    description?: string | null;
    category: ModelCategory;
    taskType: ModelTaskType;
    modelType?: ModelType;
    source: AiModelSource;
    sourceUri: string;
    sourceRevision?: string | null;
    format: AiModelFormat;
    memorySizeMb?: number | null;
    computeType?: string | null;
    tenantId?: string | null;
    tags?: string[];
    createdBy?: string | null;
}

export class AiModelFactory {
    static CreateAiModel(props: CreateAiModelProps): AiModelEntity;
    static CreateASRModel(props: Omit<CreateAiModelProps, 'category' | 'taskType'>): AiModelEntity;
    static CreateVADModel(props: Omit<CreateAiModelProps, 'category' | 'taskType'>): AiModelEntity;
}
```

#### Task 4.3: Create TranscriptionJobFactory
**File**: `TranscriptionJobFactory.ts`

```typescript
export interface CreateTranscriptionJobProps {
    tenantId: string;
    pipelineId: string;
    jobType: TranscriptionJobType;
    consultationId?: string | null;
    mediaId?: string | null;
    maxRetries?: number;
    createdBy?: string | null;
}

export class TranscriptionJobFactory {
    static CreateTranscriptionJob(props: CreateTranscriptionJobProps): TranscriptionJobEntity;
    static CreateBatchJob(props: Omit<CreateTranscriptionJobProps, 'jobType'> & { mediaId: string }): TranscriptionJobEntity;
    static CreateStreamingJob(props: Omit<CreateTranscriptionJobProps, 'jobType'>): TranscriptionJobEntity;
}
```

#### Task 4.4: Update Index Export
**File**: `factories/generated/core/index.ts`

---

### Phase 5: Domain Mappers

**Location**: `packages/domains/src/mappers/generated/core/`

#### Task 5.1: Create AsrPipelineEntityMapper
**File**: `AsrPipelineEntityMapper.ts`

- `toPersistence(entity)` - Entity → Model
- `toPersistenceChanges(entity)` - Changes only
- `toDomainEntity(dataModel)` - Model → Entity

#### Task 5.2: Create AiModelEntityMapper
**File**: `AiModelEntityMapper.ts`

Same pattern as above.

#### Task 5.3: Create TranscriptionJobEntityMapper
**File**: `TranscriptionJobEntityMapper.ts`

Same pattern as above, with relation handling for `Pipeline`.

#### Task 5.4: Update Index Export
**File**: `mappers/generated/core/index.ts`

---

### Phase 6: Domain Repositories

**Location**: `packages/domains/src/repositories/generated/core/`

#### Task 6.1: Create AsrPipelineRepository
**File**: `AsrPipelineRepository.ts`

```typescript
@Injectable()
export class AsrPipelineRepository extends Repository<AsrPipelineEntity, AsrPipeline> {
    // Custom Methods
    async findBySlug(tenantId: string, slug: string): Promise<AsrPipelineEntity | null>;
    async findEnabledPipelines(tenantId: string): Promise<AsrPipelineEntity[]>;
    async findWithJobs(pipelineId: string): Promise<AsrPipelineEntity | null>;
}
```

#### Task 6.2: Create AiModelRepository
**File**: `AiModelRepository.ts`

```typescript
@Injectable()
export class AiModelRepository extends Repository<AiModelEntity, AiModel> {
    // Custom Methods
    async findBySlug(tenantId: string, slug: string): Promise<AiModelEntity | null>;
    async findBySlugs(tenantId: string, slugs: string[]): Promise<AiModelEntity[]>;
    async findByTaskType(tenantId: string, taskType: ModelTaskType): Promise<AiModelEntity[]>;
    async findDownloadedModels(tenantId: string): Promise<AiModelEntity[]>;
    async findASRModels(tenantId: string): Promise<AiModelEntity[]>;
    async findVADModels(tenantId: string): Promise<AiModelEntity[]>;
}
```

#### Task 6.3: Create TranscriptionJobRepository
**File**: `TranscriptionJobRepository.ts`

```typescript
@Injectable()
export class TranscriptionJobRepository extends Repository<TranscriptionJobEntity, TranscriptionJob> {
    // Custom Methods
    async findByConsultation(consultationId: string): Promise<TranscriptionJobEntity[]>;
    async findPendingJobs(tenantId: string, limit?: number): Promise<TranscriptionJobEntity[]>;
    async findJobsByStatus(tenantId: string, status: TranscriptionJobStatus): Promise<TranscriptionJobEntity[]>;
    async findWithPipeline(jobId: string): Promise<TranscriptionJobEntity | null>;
    async findRecentJobs(tenantId: string, limit?: number): Promise<TranscriptionJobEntity[]>;
}
```

#### Task 6.4: Update CoreDatabaseModule
**File**: `packages/domains/src/common/databaseServices/core/core.database.module.ts`

Add new repositories to providers and exports.

#### Task 6.5: Update Index Export
**File**: `repositories/generated/core/index.ts`

---

### Phase 7: Application Service DTOs

**Location**: `packages/applications/src/services/stt/`

#### Task 7.1: Create Pipeline DTOs
**Directory**: `pipeline/dto/`

- `create-pipeline.request.ts`
- `update-pipeline.request.ts`
- `pipeline.response.ts`
- `paginated-pipeline.response.ts`
- `index.ts`

#### Task 7.2: Create AI Model DTOs
**Directory**: `model/dto/`

- `create-model.request.ts`
- `update-model.request.ts`
- `update-download-status.request.ts`
- `model.response.ts`
- `paginated-model.response.ts`
- `index.ts`

#### Task 7.3: Create Transcription Job DTOs
**Directory**: `job/dto/`

- `create-job.request.ts`
- `update-job-status.request.ts`
- `update-job-progress.request.ts`
- `job.response.ts`
- `paginated-job.response.ts`
- `index.ts`

#### Task 7.4: Create Internal DTOs
**Directory**: `internal/dto/`

- `create-transcript.request.ts` - For STT-v2 to create transcript
- `index.ts`

---

### Phase 8: Application Services

**Location**: `packages/applications/src/services/stt/`

#### Task 8.1: Create PipelineService
**Directory**: `pipeline/`

- `IPipelineService.ts` - Interface
- `pipeline.service.ts` - Implementation
- `pipeline.dto.mapper.ts` - DTO mapper
- `pipeline.service.module.ts` - NestJS module
- `index.ts`

**Methods**:
- `create(request, userId)`
- `update(id, request, userId)`
- `delete(id, userId)`
- `getById(id)`
- `getBySlug(slug)`
- `list(filters)`
- `validateYaml(yaml)` - Validate pipeline YAML config

#### Task 8.2: Create AiModelService
**Directory**: `model/`

- `IAiModelService.ts` - Interface
- `aiModel.service.ts` - Implementation
- `aiModel.dto.mapper.ts` - DTO mapper
- `aiModel.service.module.ts` - NestJS module
- `index.ts`

**Methods**:
- `create(request, userId)`
- `update(id, request, userId)`
- `delete(id, userId)`
- `getById(id)`
- `getBySlug(slug)`
- `list(filters)`
- `updateDownloadStatus(id, status, localPath?, fileSizeMb?, checksum?)`

#### Task 8.3: Create TranscriptionJobService
**Directory**: `job/`

- `ITranscriptionJobService.ts` - Interface
- `transcriptionJob.service.ts` - Implementation
- `transcriptionJob.dto.mapper.ts` - DTO mapper
- `transcriptionJob.service.module.ts` - NestJS module
- `index.ts`

**Methods**:
- `createBatchJob(request, userId)`
- `createStreamingJob(request, userId)`
- `getById(id)`
- `getJobsByConsultation(consultationId)`
- `list(filters)`
- `updateStatus(id, status, errorMessage?, errorCode?)`
- `updateProgress(id, progress)`
- `completeJob(id, resultText, resultMetadata?)`

#### Task 8.4: Create SttInternalService
**Directory**: `internal/`

- `ISttInternalService.ts` - Interface
- `sttInternal.service.ts` - Implementation
- `sttInternal.service.module.ts` - NestJS module
- `index.ts`

**Methods**:
- `createTranscriptContextItem(jobId, transcriptText, metadata?)` - Create transcript context item
- `updateJobProgress(jobId, progress)` - Update job progress
- `completeJob(jobId, resultText, resultMetadata?)` - Mark job as completed
- `failJob(jobId, errorMessage, errorCode?)` - Mark job as failed

---

### Phase 9: API Controllers

**Location**: `apps/api/src/controllers/stt/`

#### Task 9.1: Create PipelineController
**File**: `pipeline.controller.ts`

```typescript
@Controller('api/v1/pipelines')
@ApiTags('ASR Pipelines')
export class PipelineController {
    @Post()
    @ApiOperation({ summary: 'Create ASR pipeline' })
    create(@Body() request: CreatePipelineRequest): Promise<PipelineResponse>;

    @Get()
    @ApiOperation({ summary: 'List ASR pipelines' })
    list(@Query() query: PaginatedQueryDto): Promise<PaginatedPipelineResponse>;

    @Get(':id')
    @ApiOperation({ summary: 'Get pipeline by ID' })
    getById(@Param('id') id: string): Promise<PipelineResponse>;

    @Patch(':id')
    @ApiOperation({ summary: 'Update pipeline' })
    update(@Param('id') id: string, @Body() request: UpdatePipelineRequest): Promise<PipelineResponse>;

    @Delete(':id')
    @ApiOperation({ summary: 'Delete pipeline' })
    delete(@Param('id') id: string): Promise<void>;
}
```

#### Task 9.2: Create AiModelController
**File**: `aiModel.controller.ts`

Same pattern for AI model CRUD.

#### Task 9.3: Create TranscriptionJobController
**File**: `transcriptionJob.controller.ts`

```typescript
@Controller('api/v1/transcription-jobs')
@ApiTags('Transcription Jobs')
export class TranscriptionJobController {
    @Post()
    @ApiOperation({ summary: 'Create transcription job' })
    create(@Body() request: CreateJobRequest): Promise<JobResponse>;

    @Get()
    @ApiOperation({ summary: 'List transcription jobs' })
    list(@Query() query: PaginatedQueryDto): Promise<PaginatedJobResponse>;

    @Get(':id')
    @ApiOperation({ summary: 'Get job by ID' })
    getById(@Param('id') id: string): Promise<JobResponse>;

    @Get('consultation/:consultationId')
    @ApiOperation({ summary: 'Get jobs by consultation' })
    getByConsultation(@Param('consultationId') consultationId: string): Promise<JobResponse[]>;
}
```

#### Task 9.4: Create SttInternalController
**File**: `sttInternal.controller.ts`

```typescript
@Controller('internal/stt')
@ApiTags('STT Internal')
@UseGuards(ApiKeyGuard)  // Internal API key authentication
export class SttInternalController {
    @Post('transcripts')
    @ApiOperation({ summary: 'Create transcript (from STT-v2)' })
    createTranscript(@Body() request: CreateTranscriptRequest): Promise<void>;

    @Patch('jobs/:id/status')
    @ApiOperation({ summary: 'Update job status (from STT-v2)' })
    updateJobStatus(@Param('id') id: string, @Body() request: UpdateJobStatusRequest): Promise<void>;

    @Patch('jobs/:id/progress')
    @ApiOperation({ summary: 'Update job progress (from STT-v2)' })
    updateJobProgress(@Param('id') id: string, @Body() request: UpdateJobProgressRequest): Promise<void>;
}
```

---

### Phase 10: Module Registration

#### Task 10.1: Create SttModule
**File**: `apps/api/src/modules/stt/stt.module.ts`

```typescript
@Module({
    imports: [
        CoreDatabaseModule,
        PipelineServiceModule,
        AiModelServiceModule,
        TranscriptionJobServiceModule,
        SttInternalServiceModule,
    ],
    controllers: [
        PipelineController,
        AiModelController,
        TranscriptionJobController,
        SttInternalController,
    ],
    exports: [
        PipelineServiceModule,
        AiModelServiceModule,
        TranscriptionJobServiceModule,
        SttInternalServiceModule,
    ],
})
export class SttModule {}
```

#### Task 10.2: Update AppModule
**File**: `apps/api/src/app.module.ts`

Import `SttModule`.

---

### Phase 11: Unit Tests

#### Task 11.1: Entity Tests
**Location**: `packages/domains/src/entities/generated/core/__tests__/`

- `AsrPipelineEntity.test.ts`
- `AiModelEntity.test.ts`
- `TranscriptionJobEntity.test.ts`

#### Task 11.2: Factory Tests
**Location**: `packages/domains/src/factories/generated/core/__tests__/`

- `AsrPipelineFactory.test.ts`
- `AiModelFactory.test.ts`
- `TranscriptionJobFactory.test.ts`

#### Task 11.3: Service Tests
**Location**: `packages/applications/src/services/stt/*/____tests__/`

- `pipeline.service.test.ts`
- `aiModel.service.test.ts`
- `transcriptionJob.service.test.ts`
- `sttInternal.service.test.ts`

---

## Estimated Effort

| Phase | Tasks | Size | Est. Time |
|-------|-------|------|-----------|
| Phase 1 | Domain Enums | S | 1 hour |
| Phase 2 | Domain Models | S | 1 hour |
| Phase 3 | Domain Entities | M | 3-4 hours |
| Phase 4 | Domain Factories | M | 2 hours |
| Phase 5 | Domain Mappers | M | 2 hours |
| Phase 6 | Domain Repositories | L | 4-5 hours |
| Phase 7 | Application DTOs | M | 2-3 hours |
| Phase 8 | Application Services | L | 5-6 hours |
| Phase 9 | API Controllers | M | 3-4 hours |
| Phase 10 | Module Registration | S | 1 hour |
| Phase 11 | Unit Tests | L | 5-6 hours |
| **Total** | | | **30-35 hours** |

---

## Checklist Summary

### Domain Layer (`packages/domains/`)
- [ ] Enums (5 files)
- [ ] Models (3 files)
- [ ] Entities (3 files)
- [ ] Factories (3 files)
- [ ] Mappers (3 files)
- [ ] Repositories (3 files)
- [ ] Update index files (6 files)
- [ ] Update CoreDatabaseModule

### Application Layer (`packages/applications/`)
- [ ] Pipeline service (5 files)
- [ ] AI Model service (5 files)
- [ ] Transcription Job service (5 files)
- [ ] STT Internal service (4 files)
- [ ] DTOs (12+ files)

### API Layer (`apps/api/`)
- [ ] Pipeline controller
- [ ] AI Model controller
- [ ] Transcription Job controller
- [ ] STT Internal controller
- [ ] STT module
- [ ] Update AppModule

### Tests
- [ ] Entity tests (3 files)
- [ ] Factory tests (3 files)
- [ ] Service tests (4 files)
