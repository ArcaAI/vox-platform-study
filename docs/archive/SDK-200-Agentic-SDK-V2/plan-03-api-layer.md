# Plan 03: API Layer Changes


| Field             | Value                                        |
| ----------------- | -------------------------------------------- |
| **Parent Ticket** | SDK-200                                      |
| **Phase**         | 3 - Application & API Layer                  |
| **Created Date**  | 2026-01-11                                   |
| **Last Updated**  | 2026-01-11                                   |
| **Status**        | Completed                                    |
| **Dependencies**  | Plan 01 (Prisma) ✅, Plan 02 (Domain Layer) ✅ |


---

## Important Changes from Plan 02

Based on the completed domain layer implementation, the following changes apply:


| Aspect                      | Original Plan            | Updated                                                              |
| --------------------------- | ------------------------ | -------------------------------------------------------------------- |
| **sessionId**               | Required in Consultation | **Removed** - not part of schema                                     |
| **Source values**           | Uppercase (`USER`, `AI`) | **Lowercase** (`user`, `ai`, `system`, `transcription`)              |
| **SummaryRepository**       | Separate repository      | **Not needed** - summaries stored as ContextItem with type='summary' |
| **MedicalEntityRepository** | Separate repository      | **Not needed** - entities stored in ContextItem.structuredData       |
| **Factory signatures**      | Various                  | Updated to match actual implementation                               |


---

## Overview

This plan has two parts:

1. **Remove** - Delete Session-related application services and API controllers
2. **Create** - Generate new Consultation application services and API controllers

---

## Part 1: Remove Session Application & API Components

The following files must be **deleted** as they correspond to removed Prisma/Domain models:

### API Controllers to DELETE


| Directory                           | Files                                                               |
| ----------------------------------- | ------------------------------------------------------------------- |
| `apps/api/src/controllers/session/` | `session.controller.ts`, `session.controller.module.ts`, `index.ts` |


### Application Services to DELETE


| Directory                                               | Description                     |
| ------------------------------------------------------- | ------------------------------- |
| `packages/applications/src/services/sessionManagement/` | **Entire directory** (35 files) |


#### Files in sessionManagement to delete:

```
packages/applications/src/services/sessionManagement/
├── index.ts
├── session/
│   ├── ISessionService.ts
│   ├── session.service.ts
│   ├── session.service.module.ts
│   ├── session.dto.mapper.ts
│   ├── index.ts
│   └── dto/
│       ├── index.ts
│       ├── session-create.request.ts
│       ├── session-update.request.ts
│       ├── session-sync.request.ts
│       ├── session-validate.response.ts
│       ├── session.response.ts
│       └── session-paginated.response.ts
├── sessionEvent/
│   ├── ISessionEventService.ts
│   ├── sessionevent.service.ts
│   ├── sessionevent.service.module.ts
│   ├── sessionevent.dto.mapper.ts
│   ├── index.ts
│   └── dto/
│       ├── index.ts
│       ├── sessionevent-create.request.ts
│       ├── sessionevent-update.request.ts
│       ├── sessionevent.response.ts
│       └── sessionevent-paginated.response.ts
└── sessionSyncLog/
    ├── ISessionSyncLogService.ts
    ├── sessionsynclog.service.ts
    ├── sessionsynclog.service.module.ts
    ├── sessionsynclog.dto.mapper.ts
    ├── index.ts
    └── dto/
        ├── index.ts
        ├── sessionsynclog-create.request.ts
        ├── sessionsynclog-update.request.ts
        ├── sessionsynclog.response.ts
        └── sessionsynclog-paginated.response.ts
```

### Index Files to UPDATE

After deleting Session files, remove Session exports from:

**File**: `packages/applications/src/services/index.ts`

Remove this line:

```typescript
export * from './sessionManagement';
```

**File**: `apps/api/src/app.module.ts`

Remove import:

```typescript
import { SessionControllerModule } from './controllers/session';
```

Remove from controllers array:

```typescript
SessionControllerModule,
```

### Files to KEEP (Auth-related, not Session domain)

These files are for authentication session handling, NOT the removed Session domain:

- `packages/applications/src/services/auth/session.serializer.ts` ✅ Keep
- `packages/applications/src/services/auth/dto/user.session.ts` ✅ Keep

---

## Part 2: Create Consultation Application & API Components

Create application services, DTOs, and API controllers for the Consultation domain. This phase uses the `generate-service-module` tool from `@arcaai/tools` and follows existing NestJS patterns in the API gateway.

---

## Application Layer Structure

```
packages/applications/src/services/
└── consultation/
    ├── index.ts
    ├── consultation/
    │   ├── IConsultationService.ts
    │   ├── consultation.service.ts
    │   ├── consultation.service.module.ts
    │   ├── consultation.dto.mapper.ts
    │   ├── dto/
    │   │   ├── index.ts
    │   │   ├── create-consultation.request.ts
    │   │   ├── start-revisit.request.ts
    │   │   ├── update-consultation.request.ts
    │   │   ├── consultation.response.ts
    │   │   └── paginated-consultation.response.ts
    │   └── index.ts
    ├── context/
    │   ├── IContextService.ts
    │   ├── context.service.ts
    │   ├── context.service.module.ts
    │   ├── context.dto.mapper.ts
    │   ├── dto/
    │   │   ├── index.ts
    │   │   ├── add-context.request.ts
    │   │   ├── update-context.request.ts
    │   │   ├── context-item.response.ts
    │   │   └── context-filters.dto.ts
    │   └── index.ts
    └── summary/
        ├── ISummaryService.ts
        ├── summary.service.ts
        ├── summary.service.module.ts
        ├── summary.dto.mapper.ts
        ├── dto/
        │   ├── index.ts
        │   ├── generate-summary.request.ts
        │   ├── generate-presummary.request.ts
        │   ├── update-summary.request.ts
        │   └── summary.response.ts
        └── index.ts
```

> **Note**: The `SummaryService` creates ContextItems with `type='summary'` or `type='pre_summary'`.
> Summary metadata (llmProvider, modelName, processingTimeMs, etc.) is stored in `ContextItem.structuredData`.

---

## Step 1: Generate Service Modules

Use the `generate-service-module` tool:

```bash
cd packages/tools

# Generate Consultation service
pnpm generate-service-module -n Consultation -g consultation -o packages/applications/src/services

# Generate ContextItem service
pnpm generate-service-module -n ContextItem -g consultation -o packages/applications/src/services

# Generate Summary service
pnpm generate-service-module -n Summary -g consultation -o packages/applications/src/services
```

---

## Step 2: Application Services

### ConsultationService

**File**: `packages/applications/src/services/consultation/consultation/consultation.service.ts`

```typescript
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    ConsultationRepository,
    ConsultationFactory,
    ConsultationEntity,
} from '@arcaai/domains';
import { IConsultationService } from './IConsultationService';
import {
    CreateConsultationRequest,
    UpdateConsultationRequest,
    StartRevisitRequest,
    ConsultationResponse,
} from './dto';
import { ConsultationDtoMapper } from './consultation.dto.mapper';
import { RequestUser } from '../../baseServices';

@Injectable()
export class ConsultationService implements IConsultationService {
    constructor(
        private readonly consultationRepository: ConsultationRepository,
        private readonly eventEmitter: EventEmitter2,
        private readonly requestUser: RequestUser,
    ) {}

    /**
     * Create a new-visit consultation (first of the day for patient)
     */
    async create(request: CreateConsultationRequest): Promise<ConsultationResponse> {
        const tenantId = this.requestUser.tenantId;
        const userId = this.requestUser.id;

        // Check if new-visit already exists for this patient+date
        const existingNewVisit = await this.consultationRepository.findNewVisit(
            tenantId,
            request.patientId,
            new Date(request.appointmentDate),
        );

        if (existingNewVisit) {
            throw new BadRequestException(
                `A new-visit already exists for patient ${request.patientId} on ${request.appointmentDate}. Use startRevisit instead.`
            );
        }

        const consultation = ConsultationFactory.CreateNewVisit({
            tenantId,
            patientId: request.patientId,
            appointmentDate: new Date(request.appointmentDate),
            doctorId: request.doctorId,
            doctorName: request.doctorName,
            department: request.department,
            metadata: request.metadata,
            createdBy: userId,
        });

        const saved = await this.consultationRepository.create(consultation);
        return ConsultationDtoMapper.toResponse(saved);
    }

    /**
     * Start a re-visit (links to existing new-visit)
     */
    async startRevisit(
        parentId: string,
        request: StartRevisitRequest,
    ): Promise<ConsultationResponse> {
        const tenantId = this.requestUser.tenantId;
        const userId = this.requestUser.id;

        // Find parent consultation
        const parent = await this.consultationRepository.findById(parentId);
        if (!parent) {
            throw new NotFoundException(`Consultation ${parentId} not found`);
        }

        // Ensure parent is a new-visit
        if (parent.parentConsultationId) {
            throw new BadRequestException(
                'Can only create re-visit from a new-visit consultation'
            );
        }

        const consultation = ConsultationFactory.CreateRevisit({
            tenantId,
            patientId: parent.patientId,
            appointmentDate: parent.appointmentDate,
            doctorId: request.doctorId,
            doctorName: request.doctorName,
            parentConsultationId: parentId,
            department: request.department,
            metadata: request.metadata,
            createdBy: userId,
        });

        const saved = await this.consultationRepository.create(consultation);
        return ConsultationDtoMapper.toResponse(saved);
    }

    /**
     * Update consultation
     */
    async update(
        id: string,
        request: UpdateConsultationRequest,
    ): Promise<ConsultationResponse> {
        const consultation = await this.consultationRepository.findById(id);
        if (!consultation) {
            throw new NotFoundException(`Consultation ${id} not found`);
        }

        if (request.status !== undefined) {
            consultation.status = request.status;
        }
        if (request.department !== undefined) {
            consultation.department = request.department;
        }
        if (request.metadata !== undefined) {
            consultation.metadata = request.metadata;
        }
        consultation.updatedBy = this.requestUser.id;

        const updated = await this.consultationRepository.update(id, consultation);
        return ConsultationDtoMapper.toResponse(updated);
    }

    /**
     * End consultation
     */
    async end(id: string): Promise<void> {
        const consultation = await this.consultationRepository.findById(id);
        if (!consultation) {
            throw new NotFoundException(`Consultation ${id} not found`);
        }

        consultation.end(this.requestUser.id);
        await this.consultationRepository.update(id, consultation);
    }

    /**
     * Pause consultation
     */
    async pause(id: string): Promise<void> {
        const consultation = await this.consultationRepository.findById(id);
        if (!consultation) {
            throw new NotFoundException(`Consultation ${id} not found`);
        }

        consultation.pause(this.requestUser.id);
        await this.consultationRepository.update(id, consultation);
    }

    /**
     * Resume consultation
     */
    async resume(id: string): Promise<void> {
        const consultation = await this.consultationRepository.findById(id);
        if (!consultation) {
            throw new NotFoundException(`Consultation ${id} not found`);
        }

        consultation.resume(this.requestUser.id);
        await this.consultationRepository.update(id, consultation);
    }

    /**
     * Find consultation by ID with context
     */
    async findById(id: string): Promise<ConsultationResponse | null> {
        const consultation = await this.consultationRepository.findWithContext(id);
        if (!consultation) return null;
        return ConsultationDtoMapper.toResponseWithContext(consultation);
    }

    /**
     * Find all consultations for patient on date
     */
    async findByPatientDate(
        patientId: string,
        appointmentDate: string,
    ): Promise<ConsultationResponse[]> {
        const consultations = await this.consultationRepository.findByPatientAndDate(
            this.requestUser.tenantId,
            patientId,
            new Date(appointmentDate),
        );
        return consultations.map(ConsultationDtoMapper.toResponse);
    }

    /**
     * Find consultation chain for context sharing
     */
    async findConsultationChain(id: string): Promise<ConsultationResponse[]> {
        const chain = await this.consultationRepository.findConsultationChain(id);
        return chain.map(ConsultationDtoMapper.toResponse);
    }
}
```

### ContextService

**File**: `packages/applications/src/services/consultation/context/context.service.ts`

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import {
    ContextItemRepository,
    ConsultationRepository,
    ContextItemFactory,
    ContextItemEntity,
} from '@arcaai/domains';
import { IContextService } from './IContextService';
import {
    AddContextRequest,
    UpdateContextRequest,
    ContextItemResponse,
    ContextFiltersDto,
} from './dto';
import { ContextDtoMapper } from './context.dto.mapper';
import { RequestUser } from '../../baseServices';

@Injectable()
export class ContextService implements IContextService {
    constructor(
        private readonly contextItemRepository: ContextItemRepository,
        private readonly consultationRepository: ConsultationRepository,
        private readonly requestUser: RequestUser,
    ) {}

    /**
     * Add context item to consultation
     */
    async addContext(
        consultationId: string,
        request: AddContextRequest,
    ): Promise<ContextItemResponse> {
        const tenantId = this.requestUser.tenantId;
        const userId = this.requestUser.id;

        // Verify consultation exists
        const consultation = await this.consultationRepository.findById(consultationId);
        if (!consultation) {
            throw new NotFoundException(`Consultation ${consultationId} not found`);
        }

        const contextItem = ContextItemFactory.CreateContextItem({
            tenantId,
            consultationId,
            type: request.type,
            content: request.content,
            structuredData: request.structuredData,
            source: request.source || 'user',  // lowercase: user, system, transcription, ai
            createdBy: userId,
        });

        const saved = await this.contextItemRepository.create(contextItem);
        return ContextDtoMapper.toResponse(saved);
    }

    /**
     * Add transcription context
     */
    async addTranscription(
        consultationId: string,
        content: string,
        structuredData?: Record<string, unknown>,
    ): Promise<ContextItemResponse> {
        const tenantId = this.requestUser.tenantId;
        const userId = this.requestUser.id;

        // Factory signature: (tenantId, consultationId, content, structuredData?, createdBy?)
        const contextItem = ContextItemFactory.CreateTranscription(
            tenantId,
            consultationId,
            content,
            structuredData as any,
            userId,
        );

        const saved = await this.contextItemRepository.create(contextItem);
        return ContextDtoMapper.toResponse(saved);
    }

    /**
     * Add case note context
     */
    async addCaseNote(
        consultationId: string,
        content: string,
    ): Promise<ContextItemResponse> {
        const tenantId = this.requestUser.tenantId;
        const userId = this.requestUser.id;

        // Factory signature: (tenantId, consultationId, content, createdBy)
        const contextItem = ContextItemFactory.CreateCaseNote(
            tenantId,
            consultationId,
            content,
            userId,
        );

        const saved = await this.contextItemRepository.create(contextItem);
        return ContextDtoMapper.toResponse(saved);
    }

    /**
     * Update context item
     */
    async updateContext(
        contextItemId: string,
        request: UpdateContextRequest,
    ): Promise<ContextItemResponse> {
        const contextItem = await this.contextItemRepository.findById(contextItemId);
        if (!contextItem) {
            throw new NotFoundException(`Context item ${contextItemId} not found`);
        }

        if (request.content !== undefined) {
            contextItem.content = request.content;
            contextItem.updatedBy = this.requestUser.id;
        }
        if (request.structuredData !== undefined) {
            contextItem.structuredData = request.structuredData;
        }

        const updated = await this.contextItemRepository.update(contextItemId, contextItem);
        return ContextDtoMapper.toResponse(updated);
    }

    /**
     * Get context items for consultation
     */
    async getContextItems(
        consultationId: string,
        filters?: ContextFiltersDto,
    ): Promise<ContextItemResponse[]> {
        const items = await this.contextItemRepository.findByConsultation(
            consultationId,
            filters,
        );
        return items.map(ContextDtoMapper.toResponse);
    }

    /**
     * Get shared context from linked consultations
     */
    async getSharedContext(consultationId: string): Promise<ContextItemResponse[]> {
        // Get consultation chain
        const chain = await this.consultationRepository.findConsultationChain(consultationId);
        const consultationIds = chain.map(c => c.id);

        // Get all context from the chain
        const items = await this.contextItemRepository.findSharedContext(consultationIds);
        return items.map(ContextDtoMapper.toResponse);
    }

    /**
     * Get transcriptions for consultation
     */
    async getTranscriptions(consultationId: string): Promise<ContextItemResponse[]> {
        const items = await this.contextItemRepository.findTranscriptions(consultationId);
        return items.map(ContextDtoMapper.toResponse);
    }

    /**
     * Get case notes for consultation
     */
    async getCaseNotes(consultationId: string): Promise<ContextItemResponse[]> {
        const items = await this.contextItemRepository.findCaseNotes(consultationId);
        return items.map(ContextDtoMapper.toResponse);
    }
}
```

### SummaryService

> **Note**: Summary and medical entity data are stored in `ContextItem.structuredData` rather than separate tables.
> This simplifies the schema while maintaining flexibility.

**File**: `packages/applications/src/services/consultation/summary/summary.service.ts`

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import {
    ContextItemRepository,
    ConsultationRepository,
    ContextItemFactory,
} from '@arcaai/domains';
import { ISummaryService } from './ISummaryService';
import {
    GenerateSummaryRequest,
    GeneratePreSummaryRequest,
    UpdateSummaryRequest,
    SummaryResponse,
} from './dto';
import { SummaryDtoMapper } from './summary.dto.mapper';
import { RequestUser } from '../../baseServices';

@Injectable()
export class SummaryService implements ISummaryService {
    constructor(
        private readonly contextItemRepository: ContextItemRepository,
        private readonly consultationRepository: ConsultationRepository,
        private readonly httpService: HttpService,
        private readonly requestUser: RequestUser,
    ) {}

    /**
     * Generate pre-summary from historical case notes
     */
    async generatePreSummary(
        consultationId: string,
        request: GeneratePreSummaryRequest,
    ): Promise<SummaryResponse> {
        const tenantId = this.requestUser.tenantId;
        const userId = this.requestUser.id;

        // Verify consultation exists
        const consultation = await this.consultationRepository.findById(consultationId);
        if (!consultation) {
            throw new NotFoundException(`Consultation ${consultationId} not found`);
        }

        // Get case notes for summarization
        const caseNotes = await this.contextItemRepository.findCaseNotes(consultationId);
        const content = caseNotes.map(c => c.content).join('\n\n');

        // Call SMR service
        const smrResponse = await this.callSmrService('presummary', {
            text: content,
            dnaStyleId: request.dnaStyleId,
            options: request.options,
        });

        // Create pre-summary context item with metadata in structuredData
        // Factory signature: (tenantId, consultationId, content, createdBy?)
        const contextItem = ContextItemFactory.CreatePreSummary(
            tenantId,
            consultationId,
            smrResponse.summary,
            userId,
        );

        // Add summary metadata to structuredData
        contextItem.structuredData = {
            llmProvider: smrResponse.llmProvider,
            modelName: smrResponse.modelName,
            processingTimeMs: smrResponse.processingTimeMs,
            dnaStyleId: request.dnaStyleId,
            inputTokens: smrResponse.inputTokens,
            outputTokens: smrResponse.outputTokens,
        };

        const savedContext = await this.contextItemRepository.create(contextItem);
        return SummaryDtoMapper.toResponse(savedContext);
    }

    /**
     * Generate final consultation summary
     */
    async generateSummary(
        consultationId: string,
        request: GenerateSummaryRequest,
    ): Promise<SummaryResponse> {
        const tenantId = this.requestUser.tenantId;
        const userId = this.requestUser.id;

        // Verify consultation exists
        const consultation = await this.consultationRepository.findById(consultationId);
        if (!consultation) {
            throw new NotFoundException(`Consultation ${consultationId} not found`);
        }

        // Get transcriptions if not provided
        let content = request.transcription;
        if (!content) {
            const transcriptions = await this.contextItemRepository.findTranscriptions(consultationId);
            content = transcriptions.map(c => c.content).join('\n\n');
        }

        // Call SMR service
        const smrResponse = await this.callSmrService('summary', {
            text: content,
            dnaStyleId: request.dnaStyleId,
            template: request.template,
            includeNER: request.includeNER,
            options: request.options,
        });

        // Create summary context item
        // Factory signature: (tenantId, consultationId, content, structuredData?, createdBy?)
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
                entities: request.includeNER ? smrResponse.entities : undefined,
            },
            userId,
        );

        const savedContext = await this.contextItemRepository.create(contextItem);
        return SummaryDtoMapper.toResponse(savedContext);
    }

    /**
     * Update existing summary content
     */
    async updateSummary(
        contextItemId: string,
        request: UpdateSummaryRequest,
    ): Promise<SummaryResponse> {
        const contextItem = await this.contextItemRepository.findById(contextItemId);
        if (!contextItem) {
            throw new NotFoundException(`Summary ${contextItemId} not found`);
        }

        // Verify it's a summary type
        if (!contextItem.isSummary) {
            throw new NotFoundException(`Context item ${contextItemId} is not a summary`);
        }

        if (request.content !== undefined) {
            contextItem.content = request.content;
            contextItem.updatedBy = this.requestUser.id;
        }

        const updated = await this.contextItemRepository.update(contextItemId, contextItem);
        return SummaryDtoMapper.toResponse(updated);
    }

    /**
     * Get latest summary for consultation
     */
    async getLatestSummary(consultationId: string): Promise<SummaryResponse | null> {
        const summary = await this.contextItemRepository.findLatestSummary(consultationId);
        if (!summary) return null;
        return SummaryDtoMapper.toResponse(summary);
    }

    /**
     * Get latest pre-summary for consultation
     */
    async getLatestPreSummary(consultationId: string): Promise<SummaryResponse | null> {
        const preSummary = await this.contextItemRepository.findLatestPreSummary(consultationId);
        if (!preSummary) return null;
        return SummaryDtoMapper.toResponse(preSummary);
    }

    /**
     * Get all summaries for consultation
     */
    async getSummaries(consultationId: string): Promise<SummaryResponse[]> {
        const summaries = await this.contextItemRepository.findSummaries(consultationId);
        return summaries.map(SummaryDtoMapper.toResponse);
    }

    /**
     * Extract medical entities from context and store in structuredData
     */
    async extractEntities(contextItemId: string): Promise<void> {
        const contextItem = await this.contextItemRepository.findById(contextItemId);
        if (!contextItem) {
            throw new NotFoundException(`Context item ${contextItemId} not found`);
        }

        // Call NLP service for NER
        const nerResponse = await this.callNlpService(contextItem.content);

        // Store entities in structuredData
        contextItem.structuredData = {
            ...((contextItem.structuredData as object) || {}),
            entities: nerResponse.entities,
        };

        await this.contextItemRepository.update(contextItemId, contextItem);
    }

    private async callSmrService(endpoint: string, payload: any): Promise<any> {
        const response = await this.httpService.axiosRef.post(
            `${process.env.SMR_SERVICE_URL}/api/v1/${endpoint}/sync`,
            payload,
        );
        return response.data;
    }

    private async callNlpService(text: string): Promise<any> {
        const response = await this.httpService.axiosRef.post(
            `${process.env.NLP_SERVICE_URL}/classify/tokens`,
            { text },
        );
        return response.data;
    }
}
```

---

## Step 3: DTOs

### Consultation DTOs

**File**: `packages/applications/src/services/consultation/consultation/dto/create-consultation.request.ts`

```typescript
import { IsString, IsOptional, IsDateString, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateConsultationRequest {
    @ApiProperty({ description: 'Patient identifier' })
    @IsString()
    patientId: string;

    @ApiProperty({ description: 'Appointment date (YYYY-MM-DD)' })
    @IsDateString()
    appointmentDate: string;

    @ApiProperty({ description: 'Doctor identifier' })
    @IsString()
    doctorId: string;

    @ApiPropertyOptional({ description: 'Doctor name' })
    @IsOptional()
    @IsString()
    doctorName?: string;

    @ApiPropertyOptional({ description: 'Department' })
    @IsOptional()
    @IsString()
    department?: string;

    @ApiPropertyOptional({ description: 'Additional metadata' })
    @IsOptional()
    @IsObject()
    metadata?: Record<string, unknown>;
}
```

**File**: `packages/applications/src/services/consultation/consultation/dto/start-revisit.request.ts`

```typescript
import { IsString, IsOptional, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class StartRevisitRequest {
    @ApiProperty({ description: 'Doctor identifier for this re-visit' })
    @IsString()
    doctorId: string;

    @ApiPropertyOptional({ description: 'Doctor name' })
    @IsOptional()
    @IsString()
    doctorName?: string;

    @ApiPropertyOptional({ description: 'Department' })
    @IsOptional()
    @IsString()
    department?: string;

    @ApiPropertyOptional({ description: 'Additional metadata' })
    @IsOptional()
    @IsObject()
    metadata?: Record<string, unknown>;
}
```

**File**: `packages/applications/src/services/consultation/consultation/dto/consultation.response.ts`

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContextItemResponse } from '../../context/dto';

export class ConsultationResponse {
    @ApiProperty()
    id: string;

    @ApiProperty()
    patientId: string;

    @ApiProperty({ description: 'Appointment date (YYYY-MM-DD)' })
    appointmentDate: string;

    @ApiProperty()
    doctorId: string;

    @ApiPropertyOptional()
    doctorName?: string;

    @ApiPropertyOptional({ description: 'Parent consultation ID (null for new-visit)' })
    parentConsultationId?: string;

    @ApiProperty({ description: 'Derived: true if this is a new-visit' })
    isNewVisit: boolean;

    @ApiProperty({ description: 'Derived: true if this is a re-visit' })
    isRevisit: boolean;

    @ApiProperty({ enum: ['active', 'paused', 'completed', 'cancelled'] })
    status: string;

    @ApiPropertyOptional()
    department?: string;

    @ApiProperty()
    startedAt: string;

    @ApiPropertyOptional()
    endedAt?: string;

    @ApiPropertyOptional()
    metadata?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Context items (when included)' })
    contextItems?: ContextItemResponse[];

    @ApiProperty()
    createdAt: string;

    @ApiProperty()
    updatedAt: string;
}
```

### Context DTOs

**File**: `packages/applications/src/services/consultation/context/dto/add-context.request.ts`

```typescript
import { IsString, IsOptional, IsObject, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type ContextType = 'transcription' | 'case_note' | 'summary' | 'pre_summary' | 'audio_segment';
export type ContextSource = 'user' | 'system' | 'transcription' | 'ai';

export class AddContextRequest {
    @ApiProperty({
        description: 'Context type',
        enum: ['transcription', 'case_note', 'summary', 'pre_summary', 'audio_segment']
    })
    @IsString()
    type: ContextType | string;

    @ApiProperty({ description: 'Content text' })
    @IsString()
    content: string;

    @ApiPropertyOptional({ description: 'Structured data (e.g., transcription segments)' })
    @IsOptional()
    @IsObject()
    structuredData?: Record<string, unknown>;

    @ApiPropertyOptional({
        description: 'Source of the content',
        enum: ['user', 'system', 'transcription', 'ai'],
        default: 'user'
    })
    @IsOptional()
    @IsEnum(['user', 'system', 'transcription', 'ai'])
    source?: ContextSource;
}
```

**File**: `packages/applications/src/services/consultation/context/dto/context-item.response.ts`

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ContextItemResponse {
    @ApiProperty()
    id: string;

    @ApiProperty()
    consultationId: string;

    @ApiProperty({ enum: ['transcription', 'case_note', 'summary', 'pre_summary', 'audio_segment'] })
    type: string;

    @ApiProperty()
    content: string;

    @ApiPropertyOptional()
    structuredData?: Record<string, unknown>;

    @ApiProperty({ enum: ['user', 'system', 'transcription', 'ai'] })
    source: string;

    @ApiProperty({ description: 'Derived: true if type is summary or pre_summary' })
    isSummary: boolean;

    @ApiProperty({ description: 'Derived: true if type is transcription' })
    isTranscription: boolean;

    @ApiProperty({ description: 'Derived: true if source is ai' })
    isAiGenerated: boolean;

    @ApiProperty()
    createdAt: string;

    @ApiProperty()
    updatedAt: string;
}
```

---

## Step 4: API Controllers

### API Layer Structure

```
apps/api/src/modules/
└── consultation/
    ├── consultation.module.ts
    ├── consultation.controller.ts
    ├── context.controller.ts
    ├── summary.controller.ts
    └── index.ts
```

### ConsultationController

**File**: `apps/api/src/modules/consultation/consultation.controller.ts`

```typescript
import {
    Controller,
    Get,
    Post,
    Patch,
    Param,
    Body,
    Query,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ApiKeyGuard } from '../../common/guards';
import { ConsultationService } from '@arcaai/applications';
import {
    CreateConsultationRequest,
    UpdateConsultationRequest,
    StartRevisitRequest,
    ConsultationResponse,
} from '@arcaai/applications';

@ApiTags('Consultations')
@ApiBearerAuth()
@UseGuards(ApiKeyGuard)
@Controller('consultations')
export class ConsultationController {
    constructor(private readonly consultationService: ConsultationService) {}

    @Post()
    @ApiOperation({ summary: 'Create new-visit consultation' })
    async create(
        @Body() dto: CreateConsultationRequest,
    ): Promise<ConsultationResponse> {
        return this.consultationService.create(dto);
    }

    @Post(':id/revisit')
    @ApiOperation({ summary: 'Start re-visit consultation (links to parent new-visit)' })
    async startRevisit(
        @Param('id') parentId: string,
        @Body() dto: StartRevisitRequest,
    ): Promise<ConsultationResponse> {
        return this.consultationService.startRevisit(parentId, dto);
    }

    @Get()
    @ApiOperation({ summary: 'Find consultations by patient and date' })
    @ApiQuery({ name: 'patientId', required: true })
    @ApiQuery({ name: 'date', required: true, description: 'YYYY-MM-DD' })
    async findByPatientDate(
        @Query('patientId') patientId: string,
        @Query('date') date: string,
    ): Promise<ConsultationResponse[]> {
        return this.consultationService.findByPatientDate(patientId, date);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get consultation by ID with context' })
    async findById(@Param('id') id: string): Promise<ConsultationResponse> {
        return this.consultationService.findById(id);
    }

    @Get(':id/chain')
    @ApiOperation({ summary: 'Get consultation chain (parent + children) for context sharing' })
    async findChain(@Param('id') id: string): Promise<ConsultationResponse[]> {
        return this.consultationService.findConsultationChain(id);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update consultation' })
    async update(
        @Param('id') id: string,
        @Body() dto: UpdateConsultationRequest,
    ): Promise<ConsultationResponse> {
        return this.consultationService.update(id, dto);
    }

    @Post(':id/end')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'End consultation' })
    async end(@Param('id') id: string): Promise<void> {
        return this.consultationService.end(id);
    }

    @Post(':id/pause')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Pause consultation' })
    async pause(@Param('id') id: string): Promise<void> {
        return this.consultationService.pause(id);
    }

    @Post(':id/resume')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Resume consultation' })
    async resume(@Param('id') id: string): Promise<void> {
        return this.consultationService.resume(id);
    }
}
```

### ContextController

**File**: `apps/api/src/modules/consultation/context.controller.ts`

```typescript
import {
    Controller,
    Get,
    Post,
    Patch,
    Param,
    Body,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ApiKeyGuard } from '../../common/guards';
import { ContextService } from '@arcaai/applications';
import {
    AddContextRequest,
    UpdateContextRequest,
    ContextItemResponse,
} from '@arcaai/applications';

@ApiTags('Consultation Context')
@ApiBearerAuth()
@UseGuards(ApiKeyGuard)
@Controller('consultations/:consultationId/context')
export class ContextController {
    constructor(private readonly contextService: ContextService) {}

    @Post()
    @ApiOperation({ summary: 'Add context item to consultation' })
    async addContext(
        @Param('consultationId') consultationId: string,
        @Body() dto: AddContextRequest,
    ): Promise<ContextItemResponse> {
        return this.contextService.addContext(consultationId, dto);
    }

    @Get()
    @ApiOperation({ summary: 'Get context items for consultation' })
    @ApiQuery({ name: 'type', required: false })
    @ApiQuery({ name: 'source', required: false })
    async getContext(
        @Param('consultationId') consultationId: string,
        @Query('type') type?: string,
        @Query('source') source?: string,
    ): Promise<ContextItemResponse[]> {
        return this.contextService.getContextItems(consultationId, { type, source });
    }

    @Get('shared')
    @ApiOperation({ summary: 'Get shared context from linked consultations' })
    async getSharedContext(
        @Param('consultationId') consultationId: string,
    ): Promise<ContextItemResponse[]> {
        return this.contextService.getSharedContext(consultationId);
    }

    @Patch(':itemId')
    @ApiOperation({ summary: 'Update context item' })
    async updateContext(
        @Param('itemId') itemId: string,
        @Body() dto: UpdateContextRequest,
    ): Promise<ContextItemResponse> {
        return this.contextService.updateContext(itemId, dto);
    }
}
```

### SummaryController

**File**: `apps/api/src/modules/consultation/summary.controller.ts`

```typescript
import {
    Controller,
    Get,
    Post,
    Patch,
    Param,
    Body,
    UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ApiKeyGuard } from '../../common/guards';
import { SummaryService } from '@arcaai/applications';
import {
    GenerateSummaryRequest,
    GeneratePreSummaryRequest,
    UpdateSummaryRequest,
    SummaryResponse,
} from '@arcaai/applications';

@ApiTags('Consultation Summary')
@ApiBearerAuth()
@UseGuards(ApiKeyGuard)
@Controller('consultations/:consultationId/summary')
export class SummaryController {
    constructor(
        private readonly summaryService: SummaryService,
    ) {}

    @Post('pre-summary')
    @ApiOperation({ summary: 'Generate pre-summary from case notes' })
    async generatePreSummary(
        @Param('consultationId') consultationId: string,
        @Body() dto: GeneratePreSummaryRequest,
    ): Promise<SummaryResponse> {
        return this.summaryService.generatePreSummary(consultationId, dto);
    }

    @Post()
    @ApiOperation({ summary: 'Generate final consultation summary' })
    async generateSummary(
        @Param('consultationId') consultationId: string,
        @Body() dto: GenerateSummaryRequest,
    ): Promise<SummaryResponse> {
        return this.summaryService.generateSummary(consultationId, dto);
    }

    @Get()
    @ApiOperation({ summary: 'Get all summaries for consultation' })
    async getSummaries(
        @Param('consultationId') consultationId: string,
    ): Promise<SummaryResponse[]> {
        return this.summaryService.getSummaries(consultationId);
    }

    @Get('latest')
    @ApiOperation({ summary: 'Get latest summary for consultation' })
    async getLatestSummary(
        @Param('consultationId') consultationId: string,
    ): Promise<SummaryResponse | null> {
        return this.summaryService.getLatestSummary(consultationId);
    }

    @Get('pre-summary/latest')
    @ApiOperation({ summary: 'Get latest pre-summary for consultation' })
    async getLatestPreSummary(
        @Param('consultationId') consultationId: string,
    ): Promise<SummaryResponse | null> {
        return this.summaryService.getLatestPreSummary(consultationId);
    }

    @Patch(':contextItemId')
    @ApiOperation({ summary: 'Update summary content' })
    async updateSummary(
        @Param('contextItemId') contextItemId: string,
        @Body() dto: UpdateSummaryRequest,
    ): Promise<SummaryResponse> {
        return this.summaryService.updateSummary(contextItemId, dto);
    }

    @Post(':contextItemId/extract-entities')
    @ApiOperation({ summary: 'Extract medical entities from summary using NLP' })
    async extractEntities(
        @Param('contextItemId') contextItemId: string,
    ): Promise<void> {
        return this.summaryService.extractEntities(contextItemId);
    }
}
```

### ConsultationModule

**File**: `apps/api/src/modules/consultation/consultation.module.ts`

```typescript
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { CoreDatabaseModule } from '@arcaai/domains';
import {
    ConsultationServiceModule,
    ContextServiceModule,
    SummaryServiceModule,
} from '@arcaai/applications';
import { ConsultationController } from './consultation.controller';
import { ContextController } from './context.controller';
import { SummaryController } from './summary.controller';

@Module({
    imports: [
        CoreDatabaseModule,
        ConsultationServiceModule,
        ContextServiceModule,
        SummaryServiceModule,
        HttpModule,
    ],
    controllers: [
        ConsultationController,
        ContextController,
        SummaryController,
    ],
})
export class ConsultationModule {}
```

---

## API Endpoints Summary

### Consultation Endpoints


| Method | Endpoint                          | Description                                |
| ------ | --------------------------------- | ------------------------------------------ |
| POST   | `/consultations`                  | Create new-visit consultation              |
| POST   | `/consultations/:id/revisit`      | Start re-visit (links to parent)           |
| GET    | `/consultations?patientId=&date=` | Find consultations by patient+date         |
| GET    | `/consultations/:id`              | Get consultation with context              |
| GET    | `/consultations/:id/chain`        | Get consultation chain for context sharing |
| PATCH  | `/consultations/:id`              | Update consultation                        |
| POST   | `/consultations/:id/end`          | End consultation                           |
| POST   | `/consultations/:id/pause`        | Pause consultation                         |
| POST   | `/consultations/:id/resume`       | Resume consultation                        |


### Context Endpoints


| Method | Endpoint                             | Description                                   |
| ------ | ------------------------------------ | --------------------------------------------- |
| POST   | `/consultations/:id/context`         | Add context item                              |
| GET    | `/consultations/:id/context`         | Get context items (filterable by type/source) |
| GET    | `/consultations/:id/context/shared`  | Get shared context from chain                 |
| PATCH  | `/consultations/:id/context/:itemId` | Update context item                           |


### Summary Endpoints


| Method | Endpoint                                                     | Description                          |
| ------ | ------------------------------------------------------------ | ------------------------------------ |
| POST   | `/consultations/:id/summary/pre-summary`                     | Generate pre-summary from case notes |
| POST   | `/consultations/:id/summary`                                 | Generate final summary               |
| GET    | `/consultations/:id/summary`                                 | Get all summaries                    |
| GET    | `/consultations/:id/summary/latest`                          | Get latest summary                   |
| GET    | `/consultations/:id/summary/pre-summary/latest`              | Get latest pre-summary               |
| PATCH  | `/consultations/:id/summary/:contextItemId`                  | Update summary content               |
| POST   | `/consultations/:id/summary/:contextItemId/extract-entities` | Extract NER entities                 |


---

## Validation Checklist

### Part 1: Session Removal

- Session API controller directory deleted (`apps/api/src/controllers/session/`)
- Session application services directory deleted (`packages/applications/src/services/sessionManagement/`)
- Index files updated to remove Session exports
- App module updated to remove Session imports
- Auth session files preserved (session.serializer.ts, user.session.ts)

### Part 2: Consultation Creation

- All services generated using `generate-service-module`
- Custom service methods implemented
- DTOs created with validation decorators
- DTO mappers created
- Controllers created with proper guards
- Module imports configured
- Swagger documentation added
- Service unit tests created
- Controller integration tests created

### Final Validation

- Build passes (`pnpm build` in packages/applications)
- Build passes (`pnpm build` in apps/api)
- No TypeScript errors

---

## Implementation Summary

### Implementation Date: 2026-01-11

### Part 1: Session Removal - COMPLETED ✅

**Files Deleted:**
- `apps/api/src/controllers/session/` (entire directory - 3 files)
- `packages/applications/src/services/sessionManagement/` (entire directory - 33 files)

**Files Updated:**
- `packages/applications/src/services/index.ts` - Removed sessionManagement export
- `apps/api/src/app.module.ts` - Removed SessionControllerModule import, added ConsultationModule

### Part 2: Consultation Application Services - COMPLETED ✅

**Files Created:**

Application Services (`packages/applications/src/services/consultation/`):
```
consultation/
├── index.ts
├── consultation/
│   ├── dto/
│   │   ├── index.ts
│   │   ├── create-consultation.request.ts
│   │   ├── start-revisit.request.ts
│   │   ├── update-consultation.request.ts
│   │   ├── consultation.response.ts
│   │   └── paginated-consultation.response.ts
│   ├── IConsultationService.ts
│   ├── consultation.service.ts
│   ├── consultation.service.module.ts
│   ├── consultation.dto.mapper.ts
│   └── index.ts
├── context/
│   ├── dto/
│   │   ├── index.ts
│   │   ├── add-context.request.ts
│   │   ├── update-context.request.ts
│   │   ├── context-item.response.ts
│   │   └── context-filters.dto.ts
│   ├── IContextService.ts
│   ├── context.service.ts
│   ├── context.service.module.ts
│   ├── context.dto.mapper.ts
│   └── index.ts
└── summary/
    ├── dto/
    │   ├── index.ts
    │   ├── generate-summary.request.ts
    │   ├── generate-presummary.request.ts
    │   ├── update-summary.request.ts
    │   └── summary.response.ts
    ├── ISummaryService.ts
    ├── summary.service.ts
    ├── summary.service.module.ts
    ├── summary.dto.mapper.ts
    └── index.ts
```

### Part 3: API Controllers - COMPLETED ✅

**Files Created:**

API Module (`apps/api/src/modules/consultation/`):
```
consultation/
├── index.ts
├── consultation.module.ts
├── consultation.controller.ts
├── context.controller.ts
└── summary.controller.ts
```

### Additional Updates

**Files Modified:**
- `packages/domains/src/enums/generated/ResourceType.ts` - Added `Consultation` and `ContextItem` types, removed Session types

### Implementation Notes

1. **Service Pattern**: All services extend `BaseService` for consistent event broadcasting and user context handling
2. **DTO Validation**: All request DTOs use class-validator decorators
3. **Swagger Documentation**: All endpoints have proper API documentation with `@ApiOperation`, `@ApiResponse`, etc.
4. **Error Handling**: Services throw appropriate NestJS exceptions (NotFoundException, BadRequestException)
5. **Change Tracking**: Entity updates use the domain layer's change tracking for efficient updates
6. **Event Broadcasting**: All CRUD operations broadcast SysEvents for audit logging

### Validation Checklist - COMPLETED ✅

- [x] Session API controller directory deleted
- [x] Session application services directory deleted
- [x] Index files updated to remove Session exports
- [x] App module updated with ConsultationModule
- [x] Auth session files preserved (session.serializer.ts, user.session.ts)
- [x] Custom service methods implemented
- [x] DTOs created with validation decorators
- [x] DTO mappers created
- [x] Controllers created with proper guards
- [x] Module imports configured
- [x] Swagger documentation added

---

## Next Phase

After completing this phase, proceed to **Plan 04: SDK v2 Implementation** to create the frontend SDK package with React hooks.