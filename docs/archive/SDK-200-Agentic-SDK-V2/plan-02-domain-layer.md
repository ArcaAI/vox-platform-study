# Plan 02: Domain Layer Changes


| Field             | Value                                        |
| ----------------- | -------------------------------------------- |
| **Parent Ticket** | SDK-200                                      |
| **Phase**         | 2 - Domain Layer                             |
| **Created Date**  | 2026-01-11                                   |
| **Last Updated**  | 2026-01-11                                   |
| **Status**        | ✅ Completed                                  |
| **Dependencies**  | Plan 01 (Prisma Changes) must be completed ✅ |


---

## Overview

This plan has two parts:

1. **Remove** - Delete Session-related domain layer components (17 files)
2. **Create** - Generate new Consultation domain components (2 models)

---

## Part 1: Remove Session Domain Components

The following files must be **deleted** as they correspond to removed Prisma models:

### Entities to DELETE


| File                                                                   | Model          |
| ---------------------------------------------------------------------- | -------------- |
| `packages/domains/src/entities/generated/core/SessionEntity.ts`        | Session        |
| `packages/domains/src/entities/generated/core/SessionEventEntity.ts`   | SessionEvent   |
| `packages/domains/src/entities/generated/core/SessionSyncLogEntity.ts` | SessionSyncLog |


### Models to DELETE


| File                                                                | Model          |
| ------------------------------------------------------------------- | -------------- |
| `packages/domains/src/models/generated/core/SessionModel.ts`        | Session        |
| `packages/domains/src/models/generated/core/SessionEventModel.ts`   | SessionEvent   |
| `packages/domains/src/models/generated/core/SessionSyncLogModel.ts` | SessionSyncLog |


### Factories to DELETE


| File                                                                     | Model          |
| ------------------------------------------------------------------------ | -------------- |
| `packages/domains/src/factories/generated/core/SessionFactory.ts`        | Session        |
| `packages/domains/src/factories/generated/core/SessionEventFactory.ts`   | SessionEvent   |
| `packages/domains/src/factories/generated/core/SessionSyncLogFactory.ts` | SessionSyncLog |


### Mappers to DELETE


| File                                                                        | Model          |
| --------------------------------------------------------------------------- | -------------- |
| `packages/domains/src/mappers/generated/core/SessionEntityMapper.ts`        | Session        |
| `packages/domains/src/mappers/generated/core/SessionEventEntityMapper.ts`   | SessionEvent   |
| `packages/domains/src/mappers/generated/core/SessionSyncLogEntityMapper.ts` | SessionSyncLog |


### Repositories to DELETE


| File                                                                           | Model          |
| ------------------------------------------------------------------------------ | -------------- |
| `packages/domains/src/repositories/generated/core/SessionRepository.ts`        | Session        |
| `packages/domains/src/repositories/generated/core/SessionEventRepository.ts`   | SessionEvent   |
| `packages/domains/src/repositories/generated/core/SessionSyncLogRepository.ts` | SessionSyncLog |


### Enums to DELETE


| File                                                    | Enum          |
| ------------------------------------------------------- | ------------- |
| `packages/domains/src/enums/generated/SessionType.ts`   | SessionType   |
| `packages/domains/src/enums/generated/SessionStatus.ts` | SessionStatus |


### Index Files to UPDATE

After deleting files, remove exports from:

- `packages/domains/src/entities/generated/core/index.ts`
- `packages/domains/src/models/generated/core/index.ts`
- `packages/domains/src/factories/generated/core/index.ts`
- `packages/domains/src/mappers/generated/core/index.ts`
- `packages/domains/src/repositories/generated/core/index.ts`
- `packages/domains/src/enums/generated/index.ts`

### CoreDatabaseModule to UPDATE

Remove Session repositories from:

- `packages/domains/src/common/databaseServices/coreDatabaseModule.ts`

---

## Part 2: Create Consultation Domain Components

**Models to generate**: `Consultation`, `ContextItem` (2 models only)

## Tools to Use

The `@arcaai/tools` package provides generators:


| Tool                   | Command                     | Output                              |
| ---------------------- | --------------------------- | ----------------------------------- |
| `generate-data-entity` | `pnpm generate-data-entity` | Entity classes with change tracking |
| `generate-factory`     | `pnpm generate-factory`     | Factory classes for entity creation |
| `generate-mapper`      | `pnpm generate-mapper`      | Prisma ↔ Entity mappers             |
| `generate-repository`  | `pnpm generate-repository`  | Repository classes with CRUD        |


---

## Domain Structure

```
packages/domains/src/
├── entities/
│   └── generated/
│       └── core/
│           ├── ConsultationEntity.ts      (new)
│           ├── ContextItemEntity.ts       (new)
│           └── index.ts                   (update)
├── factories/
│   ├── ConsultationFactory.ts             (new)
│   ├── ContextItemFactory.ts              (new)
│   └── index.ts                           (update)
├── mappers/
│   └── generated/
│       └── core/
│           ├── ConsultationEntityMapper.ts    (new)
│           ├── ContextItemEntityMapper.ts     (new)
│           └── index.ts                       (update)
└── repositories/
    └── generated/
        └── core/
            ├── ConsultationRepository.ts      (new)
            ├── ContextItemRepository.ts       (new)
            └── index.ts                       (update)
```

---

## Step-by-Step Implementation

### Step 1: Verify Prisma Client Generated

Ensure Plan 01 is complete and client is generated:

```bash
cd /path/to/monorepo
pnpm exec prisma generate --schema=packages/database/src/prisma/db_main
```

### Step 2: Generate Entities

Run the entity generator:

```bash
cd packages/tools
pnpm generate-data-entity
# Select: core
# Select models: Consultation, ContextItem
```

**Expected Output**: Entity classes extending `BaseTenantEntity` with:

- All Prisma fields as properties
- Getters/setters with change tracking
- `toObject()` method
- Relation accessors

### Step 3: Generate Factories

```bash
pnpm generate-factory
# Select: core
# Select models: Consultation, ContextItem
```

**Expected Output**: Factory classes with static creation methods.

### Step 4: Generate Mappers

```bash
pnpm generate-mapper
# Select: core
# Select models: Consultation, ContextItem
```

**Expected Output**: Mapper classes implementing `IMapper<Entity, Model>`.

### Step 5: Generate Repositories

```bash
pnpm generate-repository
# Select: core
# Select models: Consultation, ContextItem
```

**Expected Output**: Repository classes extending base repository.

---

## Custom Entity Methods

After generation, add custom domain methods to the entities:

### ConsultationEntity - Custom Methods

**File**: `packages/domains/src/entities/generated/core/ConsultationEntity.ts`

```typescript
// Add after generated code (or extend the generated class)

export class ConsultationEntity extends GeneratedConsultationEntity {
    /**
     * Check if this is a new-visit (first consultation of the day)
     */
    get isNewVisit(): boolean {
        return !this.parentConsultationId;
    }

    /**
     * Check if this is a re-visit (follow-up consultation)
     */
    get isRevisit(): boolean {
        return !!this.parentConsultationId;
    }

    /**
     * Check if consultation is active
     */
    get isActive(): boolean {
        return this.status === 'active' && !this.endedAt;
    }

    /**
     * Check if consultation is completed
     */
    get isCompleted(): boolean {
        return this.status === 'completed';
    }

    /**
     * End the consultation
     */
    end(userId: string): void {
        this.status = 'completed';
        this.endedAt = new Date();
        this.updatedBy = userId;
    }

    /**
     * Pause the consultation
     */
    pause(userId: string): void {
        this.status = 'paused';
        this.updatedBy = userId;
    }

    /**
     * Resume the consultation
     */
    resume(userId: string): void {
        this.status = 'active';
        this.updatedBy = userId;
    }
}
```

### ContextItemEntity - Custom Methods

**File**: `packages/domains/src/entities/generated/core/ContextItemEntity.ts`

```typescript
export class ContextItemEntity extends GeneratedContextItemEntity {
    /**
     * Check if this is a summary type
     */
    get isSummary(): boolean {
        return this.type === 'summary' || this.type === 'pre_summary';
    }

    /**
     * Check if this is a transcription
     */
    get isTranscription(): boolean {
        return this.type === 'transcription';
    }

    /**
     * Check if this is a case note
     */
    get isCaseNote(): boolean {
        return this.type === 'case_note';
    }

    /**
     * Check if source is AI-generated
     */
    get isAiGenerated(): boolean {
        return this.source === 'ai';
    }

    /**
     * Check if source is user-entered
     */
    get isUserEntered(): boolean {
        return this.source === 'user';
    }
}
```

---

## Custom Factory Methods

### ConsultationFactory - Custom Creation Methods

**File**: `packages/domains/src/factories/ConsultationFactory.ts`

```typescript
import { ConsultationEntity } from '../entities';
import { generateId } from '../utils';

export interface CreateConsultationParams {
    tenantId: string;
    patientId: string;
    appointmentDate: Date;
    doctorId: string;
    doctorName?: string;
    parentConsultationId?: string;  // null = new-visit, set = re-visit
    department?: string;
    metadata?: Record<string, unknown>;
    createdBy: string;
}

export class ConsultationFactory {
    /**
     * Create a new consultation
     * - If parentConsultationId is null/undefined: new-visit
     * - If parentConsultationId is set: re-visit
     */
    static Create(params: CreateConsultationParams): ConsultationEntity {
        const entity = new ConsultationEntity();
        entity.id = generateId();
        entity.tenantId = params.tenantId;
        entity.patientId = params.patientId;
        entity.appointmentDate = params.appointmentDate;
        entity.doctorId = params.doctorId;
        entity.doctorName = params.doctorName ?? null;
        entity.parentConsultationId = params.parentConsultationId ?? null;
        entity.status = 'active';
        entity.department = params.department ?? null;
        entity.startedAt = new Date();
        entity.endedAt = null;
        entity.metadata = params.metadata ?? null;
        entity.createdBy = params.createdBy;
        entity.createdAt = new Date();
        entity.updatedAt = new Date();
        return entity;
    }

    /**
     * Convenience: Create a new-visit consultation (first of the day)
     */
    static CreateNewVisit(params: Omit<CreateConsultationParams, 'parentConsultationId'>): ConsultationEntity {
        return this.Create({ ...params, parentConsultationId: undefined });
    }

    /**
     * Convenience: Create a re-visit consultation (follow-up)
     */
    static CreateRevisit(params: CreateConsultationParams & { parentConsultationId: string }): ConsultationEntity {
        return this.Create(params);
    }
}
```

### ContextItemFactory - Custom Creation Methods

**File**: `packages/domains/src/factories/ContextItemFactory.ts`

```typescript
import { ContextItemEntity } from '../entities';
import { generateId } from '../utils';

export type ContextSource = 'user' | 'system' | 'transcription' | 'ai';
export type ContextType = 'transcription' | 'case_note' | 'summary' | 'pre_summary' | 'audio_segment' | string;

export interface CreateContextItemParams {
    tenantId: string;
    consultationId: string;
    type: ContextType;
    content: string;
    structuredData?: Record<string, unknown>;
    source: ContextSource;
    createdBy: string;
}

export class ContextItemFactory {
    /**
     * Create a context item
     */
    static Create(params: CreateContextItemParams): ContextItemEntity {
        const entity = new ContextItemEntity();
        entity.id = generateId();
        entity.tenantId = params.tenantId;
        entity.consultationId = params.consultationId;
        entity.type = params.type;
        entity.content = params.content;
        entity.structuredData = params.structuredData ?? null;
        entity.source = params.source;
        entity.createdBy = params.createdBy;
        entity.createdAt = new Date();
        entity.updatedAt = new Date();
        return entity;
    }

    /**
     * Create a transcription context item
     */
    static CreateTranscription(
        tenantId: string,
        consultationId: string,
        content: string,
        structuredData?: { segments?: Array<{ start: number; end: number; text: string; speaker?: string }> },
        createdBy: string = 'system'
    ): ContextItemEntity {
        return this.Create({
            tenantId,
            consultationId,
            type: 'transcription',
            content,
            structuredData,
            source: 'transcription',
            createdBy,
        });
    }

    /**
     * Create a case note context item
     */
    static CreateCaseNote(
        tenantId: string,
        consultationId: string,
        content: string,
        createdBy: string
    ): ContextItemEntity {
        return this.Create({
            tenantId,
            consultationId,
            type: 'case_note',
            content,
            source: 'user',
            createdBy,
        });
    }

    /**
     * Create a summary context item
     */
    static CreateSummary(
        tenantId: string,
        consultationId: string,
        content: string,
        structuredData?: { llmProvider?: string; modelName?: string; processingTimeMs?: number },
        createdBy: string = 'system'
    ): ContextItemEntity {
        return this.Create({
            tenantId,
            consultationId,
            type: 'summary',
            content,
            structuredData,
            source: 'ai',
            createdBy,
        });
    }

    /**
     * Create a pre-summary context item
     */
    static CreatePreSummary(
        tenantId: string,
        consultationId: string,
        content: string,
        createdBy: string = 'system'
    ): ContextItemEntity {
        return this.Create({
            tenantId,
            consultationId,
            type: 'pre_summary',
            content,
            source: 'ai',
            createdBy,
        });
    }
}
```

---

## Custom Repository Methods

### ConsultationRepository - Custom Query Methods

**File**: `packages/domains/src/repositories/generated/core/ConsultationRepository.ts`

```typescript
// Add custom methods after generated code

export class ConsultationRepository extends GeneratedConsultationRepository {
    /**
     * Find all consultations for a patient on a specific date
     */
    async findByPatientAndDate(
        tenantId: string,
        patientId: string,
        appointmentDate: Date
    ): Promise<ConsultationEntity[]> {
        return this.$()
            .Where({ tenantId })
            .Where({ patientId })
            .Where({ appointmentDate })
            .Where({ resourceStatus: 'ENABLED' })
            .OrderBy(['startedAt'], 'asc')
            .ToList();
    }

    /**
     * Find the new-visit (first consultation) for patient on date
     */
    async findNewVisit(
        tenantId: string,
        patientId: string,
        appointmentDate: Date
    ): Promise<ConsultationEntity | null> {
        return this.$()
            .Where({ tenantId })
            .Where({ patientId })
            .Where({ appointmentDate })
            .Where({ parentConsultationId: null })  // new-visit has no parent
            .Where({ resourceStatus: 'ENABLED' })
            .FirstOrDefault();
    }

    /**
     * Find consultation by unique constraint
     */
    async findByUniqueKey(
        tenantId: string,
        patientId: string,
        appointmentDate: Date,
        doctorId: string
    ): Promise<ConsultationEntity | null> {
        return this.$()
            .Where({ tenantId })
            .Where({ patientId })
            .Where({ appointmentDate })
            .Where({ doctorId })
            .Where({ resourceStatus: 'ENABLED' })
            .FirstOrDefault();
    }

    /**
     * Find consultation with all context items
     */
    async findWithContext(consultationId: string): Promise<ConsultationEntity | null> {
        return this.$()
            .Where({ id: consultationId })
            .Where({ resourceStatus: 'ENABLED' })
            .Include({ ContextItems: true })
            .FirstOrDefault();
    }

    /**
     * Find active consultations for a doctor
     */
    async findActiveByDoctor(
        tenantId: string,
        doctorId: string
    ): Promise<ConsultationEntity[]> {
        return this.$()
            .Where({ tenantId })
            .Where({ doctorId })
            .Where({ status: 'active' })
            .Where({ resourceStatus: 'ENABLED' })
            .OrderBy(['startedAt'], 'desc')
            .ToList();
    }

    /**
     * Find consultation chain (parent + all children) for context sharing
     */
    async findConsultationChain(consultationId: string): Promise<ConsultationEntity[]> {
        const consultation = await this.findById(consultationId);
        if (!consultation) return [];

        // Find the root (new-visit)
        const rootId = consultation.parentConsultationId || consultation.id;

        // Get all consultations in the chain
        return this.$()
            .WhereOr([
                { id: rootId },
                { parentConsultationId: rootId }
            ])
            .Where({ resourceStatus: 'ENABLED' })
            .OrderBy(['startedAt'], 'asc')
            .ToList();
    }
}
```

### ContextItemRepository - Custom Query Methods

**File**: `packages/domains/src/repositories/generated/core/ContextItemRepository.ts`

```typescript
export class ContextItemRepository extends GeneratedContextItemRepository {
    /**
     * Find all context items for a consultation
     */
    async findByConsultation(
        consultationId: string,
        filters?: { type?: string; source?: string }
    ): Promise<ContextItemEntity[]> {
        const query = this.$()
            .Where({ consultationId })
            .Where({ resourceStatus: 'ENABLED' });

        if (filters?.type) {
            query.Where({ type: filters.type });
        }
        if (filters?.source) {
            query.Where({ source: filters.source });
        }

        return query.OrderBy(['createdAt'], 'asc').ToList();
    }

    /**
     * Find transcriptions for a consultation
     */
    async findTranscriptions(consultationId: string): Promise<ContextItemEntity[]> {
        return this.findByConsultation(consultationId, { type: 'transcription' });
    }

    /**
     * Find summaries for a consultation
     */
    async findSummaries(consultationId: string): Promise<ContextItemEntity[]> {
        return this.$()
            .Where({ consultationId })
            .WhereOr([{ type: 'summary' }, { type: 'pre_summary' }])
            .Where({ resourceStatus: 'ENABLED' })
            .OrderBy(['createdAt'], 'desc')
            .ToList();
    }

    /**
     * Find latest summary for a consultation
     */
    async findLatestSummary(consultationId: string): Promise<ContextItemEntity | null> {
        return this.$()
            .Where({ consultationId })
            .Where({ type: 'summary' })
            .Where({ resourceStatus: 'ENABLED' })
            .OrderBy(['createdAt'], 'desc')
            .FirstOrDefault();
    }

    /**
     * Find shared context from all consultations in a chain
     */
    async findSharedContext(consultationIds: string[]): Promise<ContextItemEntity[]> {
        return this.$()
            .Where({ consultationId: { in: consultationIds } })
            .Where({ resourceStatus: 'ENABLED' })
            .OrderBy(['createdAt'], 'asc')
            .ToList();
    }
}
```

---

## Update Index Exports

### Update `packages/domains/src/entities/generated/core/index.ts`

```typescript
// Add exports
export * from './ConsultationEntity';
export * from './ContextItemEntity';
```

### Update `packages/domains/src/factories/index.ts`

```typescript
export * from './ConsultationFactory';
export * from './ContextItemFactory';
```

### Update `packages/domains/src/mappers/generated/core/index.ts`

```typescript
export * from './ConsultationEntityMapper';
export * from './ContextItemEntityMapper';
```

### Update `packages/domains/src/repositories/generated/core/index.ts`

```typescript
export * from './ConsultationRepository';
export * from './ContextItemRepository';
```

---

## Database Module Registration

### Update `packages/domains/src/common/databaseServices/coreDatabaseModule.ts`

```typescript
import {
    ConsultationRepository,
    ContextItemRepository,
} from '../../repositories';

@Module({
    providers: [
        // ... existing repositories ...
        ConsultationRepository,
        ContextItemRepository,
    ],
    exports: [
        // ... existing exports ...
        ConsultationRepository,
        ContextItemRepository,
    ],
})
export class CoreDatabaseModule {}
```

---

## Validation Checklist

### Part 1: Removal

- Session-related entities deleted (3 files)
- Session-related models deleted (3 files)
- Session-related factories deleted (3 files)
- Session-related mappers deleted (3 files)
- Session-related repositories deleted (3 files)
- Session-related enums deleted (2 files)
- Index files updated (removed Session exports)
- CoreDatabaseModule updated (removed Session repositories)

### Part 2: Creation

- All entities generated successfully (Consultation, ContextItem)
- All factories generated with custom methods
- All mappers generated successfully
- All repositories generated with custom methods
- Index files updated with new exports
- CoreDatabaseModule updated with new repositories

### Final Validation

- Build passes (`pnpm build` in packages/domains)
- No TypeScript errors
- No unused imports

---

## Comparison: Plan 02 Updates


| Aspect              | Before (Original Plan)       | After (Updated)                   |
| ------------------- | ---------------------------- | --------------------------------- |
| **Models**          | 4 (+ MedicalEntity, Summary) | **2** (Consultation, ContextItem) |
| **sessionId**       | Required in Consultation     | **Removed**                       |
| **Tenant relation** | Yes                          | **Removed**                       |
| **Source type**     | Enum                         | **String**                        |


---

## Implementation Summary

### Completed on 2026-01-11

#### Part 1: Session Domain Removal (17 files deleted)

- ✅ Deleted 3 Entity files: `SessionEntity.ts`, `SessionEventEntity.ts`, `SessionSyncLogEntity.ts`
- ✅ Deleted 3 Model files: `SessionModel.ts`, `SessionEventModel.ts`, `SessionSyncLogModel.ts`
- ✅ Deleted 3 Factory files: `SessionFactory.ts`, `SessionEventFactory.ts`, `SessionSyncLogFactory.ts`
- ✅ Deleted 3 Mapper files: `SessionEntityMapper.ts`, `SessionEventEntityMapper.ts`, `SessionSyncLogEntityMapper.ts`
- ✅ Deleted 3 Repository files: `SessionRepository.ts`, `SessionEventRepository.ts`, `SessionSyncLogRepository.ts`
- ✅ Deleted 2 Enum files: `SessionType.ts`, `SessionStatus.ts`
- ✅ Updated all index files to remove Session exports
- ✅ CoreDatabaseModule already did not have Session repositories (no changes needed)

#### Part 2: Consultation Domain Creation (10 files created)

- ✅ Created `ConsultationEntity.ts` with custom domain methods (`isNewVisit`, `isRevisit`, `isActive`, `end()`, `pause()`, `resume()`, `cancel()`)
- ✅ Created `ContextItemEntity.ts` with custom domain methods (`isSummary`, `isTranscription`, `isCaseNote`, `isAiGenerated`, `isUserEntered`)
- ✅ Created `ConsultationModel.ts` (Prisma model mapping)
- ✅ Created `ContextItemModel.ts` (Prisma model mapping)
- ✅ Created `ConsultationFactory.ts` with `CreateConsultation()`, `CreateNewVisit()`, `CreateRevisit()`
- ✅ Created `ContextItemFactory.ts` with `CreateContextItem()`, `CreateTranscription()`, `CreateCaseNote()`, `CreateSummary()`, `CreatePreSummary()`, `CreateAudioSegment()`
- ✅ Created `ConsultationEntityMapper.ts`
- ✅ Created `ContextItemEntityMapper.ts`
- ✅ Created `ConsultationRepository.ts` with custom methods (`findByPatientAndDate()`, `findNewVisit()`, `findByUniqueKey()`, `findWithContext()`, `findActiveByDoctor()`, `findConsultationChain()`, `findRevisits()`, `findByStatus()`, `findByDateRange()`)
- ✅ Created `ContextItemRepository.ts` with custom methods (`findByConsultation()`, `findTranscriptions()`, `findCaseNotes()`, `findSummaries()`, `findLatestSummary()`, `findLatestPreSummary()`, `findSharedContext()`, `findAiGenerated()`, `findUserEntered()`, `findByType()`, `countByType()`)
- ✅ Updated all index files with new exports
- ✅ Updated `CoreDatabaseModule` with `ConsultationRepository` and `ContextItemRepository`

#### Validation

- ✅ Prisma client generated successfully
- ✅ `pnpm build` in `packages/domains` passes with no TypeScript errors

---

## Next Phase

After completing this phase, proceed to **Plan 03: API Layer Changes** to create the application services, DTOs, and API controllers.