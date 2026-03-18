# SDK-205: Consultation API Architecture & Kafka Removal

> **Ticket Number:** SDK-205
> **Created Date:** 2026-02-01
> **Last Updated:** 2026-02-02
> **Status:** Completed

---

## Table of Contents

1. [Requirement Analysis](#requirement-analysis)
2. [Current State Evaluation](#current-state-evaluation)
3. [Implementation Plan](#implementation-plan)
4. [Phase 1: Remove Kafka Infrastructure](#phase-1-remove-kafka-infrastructure)
5. [Phase 2: Create Audit Event System](#phase-2-create-audit-event-system)
6. [Phase 3: Implement Async Job Queue](#phase-3-implement-async-job-queue)
7. [Phase 4: Update Consultation APIs](#phase-4-update-consultation-apis)
8. [Phase 5: Update Documentation](#phase-5-update-documentation)
9. [Implementation Summary](#implementation-summary)

---

## Requirement Analysis

### Business Requirements

The SDK v2 consultation module requires:

1. **Initial Consultation Creation** - API for creating new consultations
2. **Context Management** - Add/update context items (case notes, work notes, transcripts, summaries)
3. **Follow-up Consultations** - Link consultations in a chain
4. **AI Processing (Async)** - Generate pre-summary, summary, and extract named entities
5. **Real-time Updates** - SSE/WebSocket for job progress
6. **Audit Trail** - Track all operations for compliance

### Technical Requirements

1. **Scalability** - Handle 1000+ concurrent users
2. **Maintainability** - Simple architecture, fewer moving parts
3. **Monitoring** - Comprehensive metrics and tracing
4. **Best Practices** - Follow established patterns

### Architecture Decision: Remove Kafka

After analysis, Kafka is **not necessary** for the current use cases:

| Current Kafka Usage | Alternative | Rationale |
|---------------------|-------------|-----------|
| Audit events | PostgreSQL audit table | Durable, queryable, already have infrastructure |
| Real-time notifications | Redis Pub/Sub | Low latency, ephemeral, already in use |
| Cross-service events | Redis Pub/Sub + DB | Sufficient for current scale |
| Job queuing | BullMQ/Celery | Purpose-built, already in use |

**Benefits of Removal:**
- Reduced operational complexity
- Fewer infrastructure components to maintain
- Lower cost
- Simpler deployment
- Team can focus on Redis/PostgreSQL expertise

---

## Current State Evaluation

### Kafka Components to Remove

#### 1. NestJS Kafka Service (`packages/applications/src/services/kafka/`)
- `kafka.service.ts` - Main Kafka producer/consumer
- `kafka.service.module.ts` - NestJS module
- `IKafkaService.ts` - Interface
- `index.ts` - Exports
- `__tests__/kafka.service.test.ts` - Tests

#### 2. Python Kafka Client (`apps/stt/src/stt/services/`)
- `kafka_client.py` - STT Kafka client

#### 3. Infrastructure (`infrastructure/docker/`)
- `docker-compose.dev.yml` - Kafka service definition
- `scripts/init-kafka-topics.sh` - Topic initialization
- `scripts/create-stt-kafka-topics.sh` - STT topics

#### 4. API Gateway (`apps/api/src/`)
- `app.module.ts` - KafkaServiceModule import

#### 5. Documentation & Configuration
- `.env` files - Kafka environment variables
- Documentation references

### Existing Infrastructure to Leverage

| Component | Location | Purpose |
|-----------|----------|---------|
| Redis | `packages/applications/src/services/baseServices/redis/` | Caching, BullMQ, Pub/Sub |
| BullMQ | `packages/applications/src/services/baseServices/redis/` | Job queuing (NestJS) |
| Celery | `apps/smr/`, `apps/stt/` | Job queuing (Python) |
| PostgreSQL | `packages/database/` | Data persistence |
| ContextItemActivity | `packages/database/src/prisma/db_main/consultation.prisma` | Activity logging |

---

## Implementation Plan

### Overview

```
Phase 1: Remove Kafka Infrastructure (Day 1)
    ├── Remove Kafka from docker-compose
    ├── Remove Kafka service from NestJS
    ├── Remove Kafka client from Python services
    └── Update environment variables

Phase 2: Verify Existing Audit System (Day 2)
    ├── Verify ResourceType enum includes consultation types ✅
    ├── Verify AuditLogService is imported
    └── Test existing audit logging works

Phase 3: Implement Async Job Queue (Day 3-4)
    ├── Add consultation job queues to JobQueue enum
    ├── Create job DTOs and processors
    ├── Implement SSE/WebSocket for job updates
    └── Update SummaryService with async methods

Phase 4: Update Consultation APIs (Day 5)
    ├── Add async endpoints to controllers
    ├── Add job management endpoints
    └── Verify audit logging via existing SysEvent

Phase 5: Update Documentation (Day 6)
    ├── Update CONSULTATION_WORKFLOW.md
    ├── Update COMMUNICATION_AND_DATA_TRANSFER.md
    ├── Update technical-architecture-overview.md
    └── Update environment variable docs
```

> **KEY INSIGHT:** The existing `AuditLogService` already provides comprehensive audit functionality
> via event-driven architecture. Services broadcast `SysEventType.ResourceCreated/Updated/Deleted`
> and `AuditLogService` automatically captures these to the `AuditLog` table.

---

## Phase 1: Remove Kafka Infrastructure

### 1.1 Remove Kafka from Docker Compose

**File:** `infrastructure/docker/docker-compose.dev.yml`

**Action:** Remove the following services:
- `kafka` service (lines 118-154)
- `kafka-init` service (lines 156-172)

**Before:**
```yaml
# Kafka - Message Broker (KRaft mode - no Zookeeper required)
kafka:
  container_name: hope-kafka
  image: apache/kafka:4.0.0
  # ... configuration

kafka-init:
  container_name: hope-kafka-init
  # ... configuration
```

**After:** Remove entire `kafka` and `kafka-init` service blocks.

### 1.2 Remove Kafka Scripts

**Files to DELETE:**
- `infrastructure/docker/scripts/init-kafka-topics.sh`
- `infrastructure/docker/scripts/create-stt-kafka-topics.sh`

### 1.3 Update Vault Init Script

**File:** `infrastructure/docker/scripts/vault-init-stt.sh`

**Action:** Remove Kafka-related environment variables and secrets.

### 1.4 Remove NestJS Kafka Service

**Files to DELETE (entire directory):**
```
packages/applications/src/services/kafka/
├── kafka.service.ts
├── kafka.service.module.ts
├── IKafkaService.ts
├── index.ts
└── __tests__/
    └── kafka.service.test.ts
```

### 1.5 Update Services Index Export

**File:** `packages/applications/src/services/index.ts`

**Action:** Remove Kafka export.

**Before:**
```typescript
export * from './kafka';
```

**After:** Remove this line.

### 1.6 Update API Gateway App Module

**File:** `apps/api/src/app.module.ts`

**Action:** Remove KafkaServiceModule import and usage.

**Before:**
```typescript
import {
    ApiKeyServiceModule,
    AuthorizationModule,
    CommonServiceModule,
    ConfigModule,
    KafkaServiceModule,  // Remove this
    // ...
} from '@arcaai/applications';

const common = [
    // ...
    KafkaServiceModule,  // Remove this
    // ...
];
```

**After:**
```typescript
import {
    ApiKeyServiceModule,
    AuthorizationModule,
    CommonServiceModule,
    ConfigModule,
    // KafkaServiceModule removed
    // ...
} from '@arcaai/applications';

const common = [
    // ...
    // KafkaServiceModule removed
    // ...
];
```

### 1.7 Remove Python Kafka Client

**File to DELETE:** `apps/stt/src/stt/services/kafka_client.py`

**Update:** `apps/stt/src/stt/services/__init__.py` - Remove kafka_client import if present.

### 1.8 Update Environment Variables

**Files to update:**
- `.env.example`
- `.env.dev`
- `.env.production`
- `.env.test`
- `infrastructure/docker/env.stt-dev.example`

**Action:** Remove all Kafka-related variables:
```bash
# Remove these variables:
KAFKA_ENABLED=...
KAFKA_BROKERS=...
KAFKA_SSL=...
KAFKA_USERNAME=...
KAFKA_PASSWORD=...
KAFKA_SASL_MECHANISM=...
KAFKA_CLIENT_ID=...
KAFKA_GROUP_ID=...
KAFKA_PORT=...
```

### 1.9 Update Package Dependencies

**File:** `packages/applications/package.json`

**Action:** Remove kafkajs dependency if present.

```bash
pnpm remove kafkajs --filter @arcaai/applications
```

**File:** `apps/stt/pyproject.toml`

**Action:** Remove aiokafka dependency if present.

---

## Phase 2: Reuse Existing Audit Log System

> **IMPORTANT:** The existing `AuditLogService` already provides comprehensive audit functionality.
> No new audit system needs to be created - we will reuse the existing one.

### Existing Audit System Overview

The project already has a fully functional audit logging system:

**Location:** `packages/applications/src/services/auditLog/`

**Database Model:** `packages/database/src/prisma/db_main/audit.prisma`

```prisma
model AuditLog {
    id                String   @id @default(uuid(7))
    responsibleUserId String?
    responsibleIp     String?
    resourceType      ResourceType  // Includes Consultation, ContextItem, etc.
    resourceId        String?
    action            AuditAction   // CREATE, READ, UPDATE, DELETE, ARCHIVE
    data              Json     @db.JsonB
    previousData      Json     @db.JsonB
    metadata          Json?    @db.JsonB
    tenantId          String?
    // ... timestamps
    @@schema("core")
}
```

**Key Features:**
- Event-driven via `@OnEvent` decorators
- Automatic logging for CREATE, READ, UPDATE, DELETE actions
- Already includes `ResourceType.Consultation`, `ResourceType.ContextItem`, etc.
- Tracks `responsibleUserId`, `responsibleIp`, `data`, `previousData`
- Query capabilities: `fetchAll`, `fetchAllByResource`, `fetchAllCreatedByUser`

### 2.1 Verify ResourceType Enum Includes Consultation Types

**File:** `packages/database/src/prisma/db_main/audit.prisma`

The `ResourceType` enum already includes:
```prisma
enum ResourceType {
    // ... other types ...

    // CONSULTATION (already present)
    Consultation
    ContextItem
    ContextItemVersion
    ContextItemActivity
    AudioRecording
    SummaryMeta
    NamedEntity

    @@schema("core")
}
```

**Status:** ✅ No changes needed

### 2.2 How Audit Logging Works

The existing services already broadcast events that `AuditLogService` listens to:

```typescript
// In any service extending BaseService:
this.broadcastSysEvent(SysEventType.ResourceCreated, {
    resourceId: entity.id,
    data: entity.toObject()
});

// AuditLogService automatically captures this:
@OnEvent(EventTypes.ResourceCreated)
handleResourceCreatedEvent(event: ResourceEvent): void {
    const auditLog = AuditLogFactory.CreateAuditLog({
        action: AuditAction.CREATE,
        resourceType: event.resourceType,
        resourceId: event.entityId,
        data: event.data,
        // ...
    });
    this.auditLogRepository.create(auditLog);
}
```

### 2.3 Ensure Consultation Services Use BaseService

**Verify these services extend `BaseService` and call `broadcastSysEvent`:**

1. `ConsultationService` - broadcasts on create/update
2. `ContextService` - broadcasts on add/update context
3. `SummaryService` - broadcasts on summary generation

**No new code needed** - the existing pattern handles audit logging automatically.

---

## Phase 3: Implement Async Job Queue

### 3.1 Add Consultation Job Queues

**File:** `packages/domains/src/enums/JobQueue.enum.ts`

**Update:**
```typescript
export enum JobQueue {
    // Existing queues
    AuditLog = 'AuditLog',
    UserActivity = 'UserActivity',
    SendEmail = 'SendEmail',
    SendSms = 'SendSms',
    ReceiveEmail = 'ReceiveEmail',
    ReceiveSms = 'ReceiveSms',
    SysEvent = 'SysEvent',
    WebCrawler = 'WebCrawler',
    SpeechToText = 'SpeechToText',

    // NEW: Consultation AI Processing
    GeneratePreSummary = 'GeneratePreSummary',
    GenerateSummary = 'GenerateSummary',
    ExtractNamedEntities = 'ExtractNamedEntities',
}
```

### 3.2 Create Job DTOs

**File:** `packages/applications/src/services/consultation/jobs/dto/job.dto.ts` (NEW)

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Job payload interfaces
export interface GeneratePreSummaryJobPayload {
    jobId: string;
    consultationId: string;
    tenantId: string;
    userId: string;
    request: {
        dnaStyleId?: string;
        caseNoteIds?: string[];
        options?: Record<string, unknown>;
    };
    callbackUrl?: string;
}

export interface GenerateSummaryJobPayload {
    jobId: string;
    consultationId: string;
    tenantId: string;
    userId: string;
    request: {
        dnaStyleId?: string;
        template?: string;
        includeNER?: boolean;
        contextItemIds?: string[];
        options?: Record<string, unknown>;
    };
    callbackUrl?: string;
}

export interface ExtractNerJobPayload {
    jobId: string;
    contextItemId: string;
    tenantId: string;
    userId: string;
    callbackUrl?: string;
}

// Job status
export type JobStatusType = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type JobType = 'PRE_SUMMARY' | 'SUMMARY' | 'NER';

export interface ConsultationJobStatus {
    jobId: string;
    type: JobType;
    status: JobStatusType;
    consultationId?: string;
    contextItemId?: string;
    progress: number;
    currentStep?: string;
    result?: unknown;
    error?: string;
    createdAt: Date;
    startedAt?: Date;
    completedAt?: Date;
}

// API Response DTOs
export class JobResponse {
    @ApiProperty({ description: 'Unique job identifier' })
    jobId: string;

    @ApiProperty({ description: 'Current job status', enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] })
    status: JobStatusType;

    @ApiProperty({ description: 'SSE endpoint for real-time updates' })
    sseUrl: string;

    @ApiPropertyOptional({ description: 'Estimated completion time' })
    estimatedCompletionTime?: Date;
}

export class JobStatusResponse {
    @ApiProperty()
    jobId: string;

    @ApiProperty({ enum: ['PRE_SUMMARY', 'SUMMARY', 'NER'] })
    type: JobType;

    @ApiProperty({ enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] })
    status: JobStatusType;

    @ApiPropertyOptional()
    consultationId?: string;

    @ApiPropertyOptional()
    contextItemId?: string;

    @ApiProperty({ description: 'Progress percentage 0-100' })
    progress: number;

    @ApiPropertyOptional()
    currentStep?: string;

    @ApiPropertyOptional({ description: 'Result when completed' })
    result?: unknown;

    @ApiPropertyOptional({ description: 'Error message if failed' })
    error?: string;

    @ApiProperty()
    createdAt: Date;

    @ApiPropertyOptional()
    startedAt?: Date;

    @ApiPropertyOptional()
    completedAt?: Date;
}
```

### 3.3 Create Job Service

**File:** `packages/applications/src/services/consultation/jobs/consultation-job.service.ts` (NEW)

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { uuidv7 } from 'uuidv7';
import { JobQueue } from '@arcaai/domains';
import { RedisCacheService } from '../../baseServices/redis';
import {
    GeneratePreSummaryJobPayload,
    GenerateSummaryJobPayload,
    ExtractNerJobPayload,
    ConsultationJobStatus,
    JobResponse,
    JobStatusResponse,
} from './dto/job.dto';

@Injectable()
export class ConsultationJobService {
    private readonly logger = new Logger(ConsultationJobService.name);
    private readonly JOB_TTL = 86400; // 24 hours

    constructor(
        @InjectQueue(JobQueue.GeneratePreSummary) private preSummaryQueue: Queue,
        @InjectQueue(JobQueue.GenerateSummary) private summaryQueue: Queue,
        @InjectQueue(JobQueue.ExtractNamedEntities) private nerQueue: Queue,
        private readonly redisService: RedisCacheService,
    ) {}

    /**
     * Create a pre-summary generation job
     */
    async createPreSummaryJob(
        consultationId: string,
        tenantId: string,
        userId: string,
        request: GeneratePreSummaryJobPayload['request'],
        callbackUrl?: string,
    ): Promise<JobResponse> {
        const jobId = uuidv7();

        const payload: GeneratePreSummaryJobPayload = {
            jobId,
            consultationId,
            tenantId,
            userId,
            request,
            callbackUrl,
        };

        await this.preSummaryQueue.add('generate', payload, {
            jobId,
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
        });

        await this.storeJobStatus(jobId, {
            jobId,
            type: 'PRE_SUMMARY',
            status: 'PENDING',
            consultationId,
            progress: 0,
            createdAt: new Date(),
        });

        this.logger.log(`Created pre-summary job ${jobId} for consultation ${consultationId}`);

        return {
            jobId,
            status: 'PENDING',
            sseUrl: `/api/consultations/jobs/${jobId}/sse`,
        };
    }

    /**
     * Create a summary generation job
     */
    async createSummaryJob(
        consultationId: string,
        tenantId: string,
        userId: string,
        request: GenerateSummaryJobPayload['request'],
        callbackUrl?: string,
    ): Promise<JobResponse> {
        const jobId = uuidv7();

        const payload: GenerateSummaryJobPayload = {
            jobId,
            consultationId,
            tenantId,
            userId,
            request,
            callbackUrl,
        };

        await this.summaryQueue.add('generate', payload, {
            jobId,
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
        });

        await this.storeJobStatus(jobId, {
            jobId,
            type: 'SUMMARY',
            status: 'PENDING',
            consultationId,
            progress: 0,
            createdAt: new Date(),
        });

        this.logger.log(`Created summary job ${jobId} for consultation ${consultationId}`);

        return {
            jobId,
            status: 'PENDING',
            sseUrl: `/api/consultations/jobs/${jobId}/sse`,
        };
    }

    /**
     * Create a NER extraction job
     */
    async createNerJob(
        contextItemId: string,
        tenantId: string,
        userId: string,
        callbackUrl?: string,
    ): Promise<JobResponse> {
        const jobId = uuidv7();

        const payload: ExtractNerJobPayload = {
            jobId,
            contextItemId,
            tenantId,
            userId,
            callbackUrl,
        };

        await this.nerQueue.add('extract', payload, {
            jobId,
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
        });

        await this.storeJobStatus(jobId, {
            jobId,
            type: 'NER',
            status: 'PENDING',
            contextItemId,
            progress: 0,
            createdAt: new Date(),
        });

        this.logger.log(`Created NER job ${jobId} for context item ${contextItemId}`);

        return {
            jobId,
            status: 'PENDING',
            sseUrl: `/api/consultations/jobs/${jobId}/sse`,
        };
    }

    /**
     * Get job status
     */
    async getJobStatus(jobId: string): Promise<JobStatusResponse | null> {
        const data = await this.redisService.get(`consultation_job:${jobId}`);
        if (!data) return null;
        return JSON.parse(data) as JobStatusResponse;
    }

    /**
     * Cancel a job
     */
    async cancelJob(jobId: string): Promise<boolean> {
        const status = await this.getJobStatus(jobId);
        if (!status) return false;

        if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(status.status)) {
            return false;
        }

        // Remove from queue
        let queue: Queue;
        switch (status.type) {
            case 'PRE_SUMMARY':
                queue = this.preSummaryQueue;
                break;
            case 'SUMMARY':
                queue = this.summaryQueue;
                break;
            case 'NER':
                queue = this.nerQueue;
                break;
            default:
                return false;
        }

        const job = await queue.getJob(jobId);
        if (job) {
            await job.remove();
        }

        await this.updateJobStatus(jobId, {
            status: 'CANCELLED',
            completedAt: new Date(),
        });

        return true;
    }

    /**
     * Store job status in Redis
     */
    async storeJobStatus(jobId: string, status: ConsultationJobStatus): Promise<void> {
        await this.redisService.setex(
            `consultation_job:${jobId}`,
            this.JOB_TTL,
            JSON.stringify(status),
        );
    }

    /**
     * Update job status
     */
    async updateJobStatus(jobId: string, update: Partial<ConsultationJobStatus>): Promise<void> {
        const current = await this.getJobStatus(jobId);
        if (!current) return;

        const updated = { ...current, ...update };
        await this.storeJobStatus(jobId, updated);

        // Publish update via Redis pub/sub for SSE
        await this.redisService.publish(
            `consultation_job_updates:${jobId}`,
            JSON.stringify(updated),
        );
    }

    /**
     * Notify job progress (called by processors)
     */
    async notifyProgress(jobId: string, progress: number, currentStep: string): Promise<void> {
        await this.updateJobStatus(jobId, {
            status: 'RUNNING',
            progress,
            currentStep,
            startedAt: new Date(),
        });
    }

    /**
     * Notify job completion (called by processors)
     */
    async notifyComplete(jobId: string, result: unknown): Promise<void> {
        await this.updateJobStatus(jobId, {
            status: 'COMPLETED',
            progress: 100,
            currentStep: 'Completed',
            result,
            completedAt: new Date(),
        });
    }

    /**
     * Notify job failure (called by processors)
     */
    async notifyFailed(jobId: string, error: string): Promise<void> {
        await this.updateJobStatus(jobId, {
            status: 'FAILED',
            error,
            completedAt: new Date(),
        });
    }
}
```

### 3.4 Create Job Processors

**File:** `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts` (NEW)

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { HttpService } from '@nestjs/axios';
import { JobQueue, ContextItemRepository, ConsultationRepository, ContextItemFactory, ResourceType, SysEventType } from '@arcaai/domains';
import { ConsultationJobService } from '../consultation-job.service';
import { ISysEventService } from '../../../sysEvent';
import { GenerateSummaryJobPayload } from '../dto/job.dto';

@Processor(JobQueue.GenerateSummary)
export class SummaryProcessor extends WorkerHost {
    private readonly logger = new Logger(SummaryProcessor.name);
    private readonly smrServiceUrl: string;

    constructor(
        private readonly jobService: ConsultationJobService,
        private readonly contextItemRepository: ContextItemRepository,
        private readonly consultationRepository: ConsultationRepository,
        private readonly sysEventService: ISysEventService,
        private readonly httpService: HttpService,
    ) {
        super();
        this.smrServiceUrl = process.env.SMR_SERVICE_URL ?? 'http://localhost:8003';
    }

    async process(job: Job<GenerateSummaryJobPayload>): Promise<any> {
        const { jobId, consultationId, tenantId, userId, request } = job.data;

        this.logger.log(`Processing summary job ${jobId} for consultation ${consultationId}`);

        try {
            // Step 1: Gathering context
            await this.jobService.notifyProgress(jobId, 10, 'Gathering context');

            const consultation = await this.consultationRepository.findById(consultationId);
            if (!consultation) {
                throw new Error(`Consultation ${consultationId} not found`);
            }

            // Get content from selected context items or all transcriptions
            let content = '';
            if (request.contextItemIds?.length) {
                const contextItems = await Promise.all(
                    request.contextItemIds.map(id => this.contextItemRepository.findById(id)),
                );
                content = contextItems.filter(Boolean).map(c => c!.content).join('\n\n');
            } else {
                const transcriptions = await this.contextItemRepository.findTranscriptions(consultationId);
                content = transcriptions.map(c => c.content).join('\n\n');
            }

            if (!content.trim()) {
                throw new Error('No content available for summary generation');
            }

            // Step 2: Calling AI service
            await this.jobService.notifyProgress(jobId, 30, 'Calling AI service');

            const smrResponse = await this.callSmrService(content, request);

            // Step 3: Saving results
            await this.jobService.notifyProgress(jobId, 70, 'Saving results');

            const contextItem = ContextItemFactory.CreateSummary(
                tenantId,
                consultationId,
                smrResponse.summary,
                {
                    llmProvider: smrResponse.llmProvider,
                    modelName: smrResponse.modelName,
                    processingTimeMs: smrResponse.processingTimeMs,
                    dnaStyleId: request.dnaStyleId,
                    inputTokens: smrResponse.inputTokens,
                    outputTokens: smrResponse.outputTokens,
                },
                userId,
            );

            const savedContext = await this.contextItemRepository.create(contextItem);

            // Broadcast event for audit logging (AuditLogService listens automatically)
            this.sysEventService.broadcastResourceEvent(SysEventType.ResourceCreated, {
                resourceType: ResourceType.ContextItem,
                entityId: savedContext.id,
                data: {
                    consultationId,
                    type: 'SUMMARY',
                    processingTimeMs: smrResponse.processingTimeMs,
                    aiModel: smrResponse.modelName,
                },
            });

            // Step 4: Complete
            const result = {
                contextItemId: savedContext.id,
                content: savedContext.content,
                summaryMeta: {
                    aiModelId: smrResponse.modelName,
                    processingTimeMs: smrResponse.processingTimeMs,
                    inputTokens: smrResponse.inputTokens,
                    outputTokens: smrResponse.outputTokens,
                },
            };

            await this.jobService.notifyComplete(jobId, result);

            this.logger.log(`Completed summary job ${jobId}`);

            return result;

        } catch (error) {
            this.logger.error(`Failed summary job ${jobId}: ${error.message}`);
            await this.jobService.notifyFailed(jobId, error.message);
            throw error;
        }
    }

    private async callSmrService(content: string, request: any): Promise<any> {
        const response = await this.httpService.axiosRef.post(
            `${this.smrServiceUrl}/api/v1/summary/sync`,
            {
                text: content,
                dnaStyleId: request.dnaStyleId,
                template: request.template,
                includeNER: request.includeNER,
                options: request.options,
            },
        );
        return response.data;
    }
}
```

### 3.5 Create SSE Controller

**File:** `apps/api/src/modules/consultation/job.controller.ts` (NEW)

```typescript
import { Controller, Get, Delete, Param, Sse, NotFoundException, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { ApiKeyGuard } from '../../guards';
import { ConsultationJobService, JobStatusResponse } from '@arcaai/applications';
import { RedisCacheService } from '@arcaai/applications';

@Controller('consultations/jobs')
@ApiTags('Consultation Jobs')
@ApiBearerAuth()
@UseGuards(ApiKeyGuard)
export class ConsultationJobController {
    constructor(
        private readonly jobService: ConsultationJobService,
        private readonly redisService: RedisCacheService,
    ) {}

    @Get(':jobId')
    @ApiOperation({ summary: 'Get job status' })
    @ApiResponse({ status: 200, type: JobStatusResponse })
    async getJobStatus(@Param('jobId') jobId: string): Promise<JobStatusResponse> {
        const status = await this.jobService.getJobStatus(jobId);
        if (!status) {
            throw new NotFoundException(`Job ${jobId} not found`);
        }
        return status;
    }

    @Delete(':jobId')
    @ApiOperation({ summary: 'Cancel a job' })
    async cancelJob(@Param('jobId') jobId: string): Promise<{ message: string }> {
        const success = await this.jobService.cancelJob(jobId);
        if (!success) {
            throw new NotFoundException(`Job ${jobId} not found or cannot be cancelled`);
        }
        return { message: `Job ${jobId} cancelled successfully` };
    }

    @Sse(':jobId/sse')
    @ApiOperation({ summary: 'SSE stream for job updates' })
    jobUpdates(@Param('jobId') jobId: string): Observable<MessageEvent> {
        return new Observable(subscriber => {
            const channel = `consultation_job_updates:${jobId}`;

            // Send initial status
            this.jobService.getJobStatus(jobId).then(status => {
                if (status) {
                    subscriber.next({ data: JSON.stringify(status) } as MessageEvent);
                } else {
                    subscriber.next({ data: JSON.stringify({ error: 'Job not found' }) } as MessageEvent);
                    subscriber.complete();
                    return;
                }
            });

            // Subscribe to Redis pub/sub
            const redisSubscriber = this.redisService.duplicate();

            redisSubscriber.subscribe(channel, (message: string) => {
                const update = JSON.parse(message);
                subscriber.next({ data: message } as MessageEvent);

                // Complete stream when job finishes
                if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(update.status)) {
                    setTimeout(() => subscriber.complete(), 100);
                }
            });

            // Heartbeat every 30 seconds
            const heartbeat = setInterval(() => {
                subscriber.next({ data: JSON.stringify({ type: 'heartbeat', timestamp: new Date() }) } as MessageEvent);
            }, 30000);

            // Cleanup on unsubscribe
            return () => {
                clearInterval(heartbeat);
                redisSubscriber.unsubscribe(channel);
            };
        });
    }
}
```

---

## Phase 4: Update Consultation APIs

### 4.1 Update Summary Controller with Async Endpoints

**File:** `apps/api/src/modules/consultation/summary.controller.ts`

**Add new endpoints:**

```typescript
// Add to existing SummaryController

@Post('async')
@ApiOperation({ summary: 'Generate summary asynchronously' })
@ApiResponse({ status: 202, description: 'Job created', type: JobResponse })
async generateSummaryAsync(
    @Param('consultationId') consultationId: string,
    @Body() request: GenerateSummaryAsyncRequest,
): Promise<JobResponse> {
    const tenantId = this.clsService.get('tenantId');
    const userId = this.clsService.get('userId');

    return this.jobService.createSummaryJob(
        consultationId,
        tenantId,
        userId,
        request,
        request.callbackUrl,
    );
}

@Post('pre-summary/async')
@ApiOperation({ summary: 'Generate pre-summary asynchronously' })
@ApiResponse({ status: 202, description: 'Job created', type: JobResponse })
async generatePreSummaryAsync(
    @Param('consultationId') consultationId: string,
    @Body() request: GeneratePreSummaryAsyncRequest,
): Promise<JobResponse> {
    const tenantId = this.clsService.get('tenantId');
    const userId = this.clsService.get('userId');

    return this.jobService.createPreSummaryJob(
        consultationId,
        tenantId,
        userId,
        request,
        request.callbackUrl,
    );
}

@Post(':contextItemId/extract-entities/async')
@ApiOperation({ summary: 'Extract named entities asynchronously' })
@ApiResponse({ status: 202, description: 'Job created', type: JobResponse })
async extractEntitiesAsync(
    @Param('contextItemId') contextItemId: string,
): Promise<JobResponse> {
    const tenantId = this.clsService.get('tenantId');
    const userId = this.clsService.get('userId');

    return this.jobService.createNerJob(contextItemId, tenantId, userId);
}
```

### 4.2 Update Consultation Module

**File:** `apps/api/src/modules/consultation/consultation.module.ts`

**Add job controller and service:**

```typescript
import { ConsultationJobController } from './job.controller';
import { ConsultationJobService } from '@arcaai/applications';
import { BullModule } from '@nestjs/bullmq';
import { JobQueue } from '@arcaai/domains';

@Module({
    imports: [
        // ... existing imports
        // NOTE: AuditLogServiceModule is already imported globally or in common modules
        BullModule.registerQueue(
            { name: JobQueue.GeneratePreSummary },
            { name: JobQueue.GenerateSummary },
            { name: JobQueue.ExtractNamedEntities },
        ),
    ],
    controllers: [
        // ... existing controllers
        ConsultationJobController,
    ],
    providers: [
        // ... existing providers
        ConsultationJobService,
        SummaryProcessor,
        PreSummaryProcessor,
        NerProcessor,
    ],
})
export class ConsultationModule {}
```

> **NOTE:** The existing `AuditLogService` automatically captures events via `@OnEvent` decorators.
> Services just need to call `broadcastSysEvent()` and audit logging happens automatically.

---

## Phase 5: Update Documentation

### 5.1 Update COMMUNICATION_AND_DATA_TRANSFER.md

**Action:** Remove Kafka sections, update architecture diagram.

### 5.2 Update technical-architecture-overview.md

**Action:** Remove Kafka from architecture diagrams and technology stack.

### 5.3 Update CONSULTATION_WORKFLOW.md

**Action:** Add async job processing documentation.

### 5.4 Update Environment Variable Documentation

**Action:** Remove Kafka variables from all documentation.

---

## Implementation Summary

### Files to DELETE

```
packages/applications/src/services/kafka/
├── kafka.service.ts
├── kafka.service.module.ts
├── IKafkaService.ts
├── index.ts
└── __tests__/kafka.service.test.ts

apps/stt/src/stt/services/kafka_client.py

infrastructure/docker/scripts/init-kafka-topics.sh
infrastructure/docker/scripts/create-stt-kafka-topics.sh
```

### Files to CREATE

> **NOTE:** No new audit system needed - reusing existing `AuditLogService`

```
packages/applications/src/services/consultation/jobs/dto/job.dto.ts
packages/applications/src/services/consultation/jobs/consultation-job.service.ts
packages/applications/src/services/consultation/jobs/consultation-job.service.module.ts
packages/applications/src/services/consultation/jobs/processors/summary.processor.ts
packages/applications/src/services/consultation/jobs/processors/pre-summary.processor.ts
packages/applications/src/services/consultation/jobs/processors/ner.processor.ts
packages/applications/src/services/consultation/jobs/index.ts
apps/api/src/modules/consultation/job.controller.ts
```

### Files to MODIFY

```
infrastructure/docker/docker-compose.dev.yml (remove kafka services)
infrastructure/docker/scripts/vault-init-stt.sh (remove kafka vars)
packages/applications/src/services/index.ts (remove kafka export)
apps/api/src/app.module.ts (remove KafkaServiceModule)
apps/stt/src/stt/services/__init__.py (remove kafka import)
packages/domains/src/enums/JobQueue.enum.ts (add new queues)
apps/api/src/modules/consultation/summary.controller.ts (add async endpoints)
apps/api/src/modules/consultation/consultation.module.ts (add job components)
.env.example, .env.dev, .env.production, .env.test (remove kafka vars)
docs/COMMUNICATION_AND_DATA_TRANSFER.md
docs/technical-architecture-overview.md
docs/CONSULTATION_WORKFLOW.md
```

### Existing Components to REUSE

```
packages/applications/src/services/auditLog/          # Existing audit logging
├── auditLog.service.ts                               # Event-driven audit capture
├── auditLog.service.module.ts                        # NestJS module
├── IAuditLogService.ts                               # Interface
└── dto/                                              # Response DTOs

packages/database/src/prisma/db_main/audit.prisma     # AuditLog model with ResourceType enum
```

---

## API Endpoint Summary

### Synchronous Endpoints (Existing)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/consultations/open` | Get or create consultation |
| POST | `/api/consultations/:parentId/revisit` | Create follow-up |
| POST | `/api/consultations/:id/context` | Add context item |
| PATCH | `/api/consultations/:id/context/:contextId` | Update context item |
| POST | `/api/consultations/:id/summary` | Generate summary (sync) |
| POST | `/api/consultations/:id/summary/pre-summary` | Generate pre-summary (sync) |

### Asynchronous Endpoints (New)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/consultations/:id/summary/async` | Generate summary (async) |
| POST | `/api/consultations/:id/summary/pre-summary/async` | Generate pre-summary (async) |
| POST | `/api/consultations/:id/summary/:contextId/extract-entities/async` | Extract NER (async) |
| GET | `/api/consultations/jobs/:jobId` | Get job status |
| DELETE | `/api/consultations/jobs/:jobId` | Cancel job |
| GET | `/api/consultations/jobs/:jobId/sse` | SSE stream for updates |

---

## Change History

| Date | Change | Author |
|------|--------|--------|
| 2026-02-01 | Initial planning document | - |
