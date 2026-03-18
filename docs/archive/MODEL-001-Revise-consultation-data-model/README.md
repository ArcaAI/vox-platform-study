# Design: Consultation Data Model

**Ticket**: MODEL-001-Revise-consultation-data-model
**Date**: 2026-01-31
**Last Updated**: 2026-01-31
**Status**: Implemented

## Summary

A refined data model for medical consultations supporting multiple doctors per patient visit, re-visits, referrals, AI-powered content processing, and efficient search (full-text + semantic). Uses a flexible single-table approach for content with separate version history for audit compliance.

## Architecture

### Core Entities

| Model | Purpose |
|-------|---------|
| `Consultation` | Doctor-patient interaction record |
| `Department` | Lookup table for departments/specialties |
| `ContextItem` | Flexible content storage (audio, transcript, summary, worknote, attachment) |
| `ContextItemVersion` | Immutable version history |

### Key Design Decisions

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| Appointment vs Consultation | Each doctor interaction = own consultation | Simpler model, linked by `patientId + appointmentDate` |
| Referrals/Requests | Parent-child via `parentConsultationId` | Reuses existing self-relation |
| Re-visits same doctor/day | Allow multiple records | Removed unique constraint, link via parent |
| Consultation type | Derive from data | No explicit field - infer from `parentConsultationId` |
| Department/Specialty | Reference table | Data consistency, better reporting |
| Doctor reference | FK to `User` table | Single source of truth, removed `doctorName` |
| Patient reference | String (no FK) | External system, can't enforce FK |
| Content storage | Single `ContextItem` table | Flexible `type` + `structuredData` JSON |
| Versioning | Separate history table | Clean search, audit trail preserved |
| Embeddings | pgvector + Qdrant | Primary local search + advanced vector search |
| Full-text search | PostgreSQL `tsvector` | Keyword search alongside semantic |
| Named entities | Inline JSON | Stored in parent content's `structuredData` |

## Components

### 1. Consultation Model

```prisma
model Consultation {
    // Meta fields (BaseEntity pattern)
    metaData Json?  @map("_metadata") @db.JsonB
    version  Int    @default(1) @map("_version")
    id       String @id @default(uuid(7))

    // Multi-tenant
    tenantId String @default("50000000-0000-0000-0000-000000000000")

    // Patient (external system - no FK)
    patientId       String
    appointmentDate DateTime @db.Date

    // Doctor (FK to User)
    doctorId String
    Doctor   User   @relation("DoctorConsultations", fields: [doctorId], references: [id])

    // Department (FK to lookup table)
    departmentId String?
    Department   Department? @relation(fields: [departmentId], references: [id])

    // Visit linking: NULL = initial visit, NOT NULL = follow-up/referral
    parentConsultationId String?
    ParentConsultation   Consultation?  @relation("ConsultationChain", fields: [parentConsultationId], references: [id])
    ChildConsultations   Consultation[] @relation("ConsultationChain")

    // Status
    status    String    @default("active")  // active, paused, completed, cancelled
    startedAt DateTime  @default(now())
    endedAt   DateTime?

    // Flexible metadata (scheduling info, external refs, etc.)
    metadata Json? @db.JsonB

    // Resource status + Audit (standard fields)
    resourceStatus          ResourceStatusType @default(ENABLED)
    resourceStatusUpdatedAt DateTime?
    resourceStatusUpdatedBy String?
    createdBy               String?  @default("60000000-0000-0000-0000-000000000000")
    updatedBy               String?
    createdAt               DateTime @default(now())
    updatedAt               DateTime @updatedAt

    // Relations
    ContextItems ContextItem[]

    // Indexes (no unique constraint - allows multiple visits same doctor/day)
    @@index([tenantId])
    @@index([patientId])
    @@index([appointmentDate])
    @@index([doctorId])
    @@index([departmentId])
    @@index([parentConsultationId])
    @@index([status])
    // Composite for common query pattern
    @@index([tenantId, patientId, appointmentDate])
    @@schema("core")
}
```

### 2. Department Model

```prisma
model Department {
    // Meta fields
    metaData Json?  @map("_metadata") @db.JsonB
    version  Int    @default(1) @map("_version")
    id       String @id @default(uuid(7))

    // Multi-tenant
    tenantId String @default("50000000-0000-0000-0000-000000000000")

    // Department info
    code        String  // e.g., "CARD", "RAD", "LAB"
    name        String  // e.g., "Cardiology", "Radiology", "Laboratory"
    description String?

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
    Consultations Consultation[]

    // Constraints
    @@unique([tenantId, code])

    // Indexes
    @@index([tenantId])
    @@index([parentDepartmentId])
    @@schema("core")
}
```

### 3. ContextItem Model

```prisma
model ContextItem {
    // Meta fields
    metaData Json?  @map("_metadata") @db.JsonB
    version  Int    @default(1) @map("_version")
    id       String @id @default(uuid(7))

    // Multi-tenant
    tenantId String @default("50000000-0000-0000-0000-000000000000")

    // Parent consultation
    consultationId String
    Consultation   Consultation @relation(fields: [consultationId], references: [id])

    // Content type: audio, transcript, summary, worknote, attachment
    type String

    // Main content (text for transcript/summary/worknote, null for binary assets)
    content String? @db.Text

    // Media URI (for audio, images, attachments)
    mediaUri String?

    // Type-specific metadata stored as JSON
    // Examples:
    //   audio: { duration, format, sampleRate, channels, bitrate }
    //   transcript: { timestamps: [...], language, aiModel }
    //   summary: { aiModel, promptVersion, sections: [...] }
    //   worknote: { author, noteType }
    //   attachment: { mimeType, fileSize, originalFilename }
    //   entities (inline): { entities: [{ text, type, confidence, start, end }] }
    structuredData Json? @db.JsonB

    // Source: user, system, ai, transcription
    source String @default("user")

    // Full-text search vector (auto-populated via trigger or application)
    searchVector Unsupported("tsvector")?

    // Vector embedding for semantic search (pgvector)
    embedding Unsupported("vector(1536)")?

    // Qdrant sync status
    qdrantSynced   Boolean   @default(false)
    qdrantSyncedAt DateTime?

    // Resource status + Audit
    resourceStatus          ResourceStatusType @default(ENABLED)
    resourceStatusUpdatedAt DateTime?
    resourceStatusUpdatedBy String?
    createdBy               String?  @default("60000000-0000-0000-0000-000000000000")
    updatedBy               String?
    createdAt               DateTime @default(now())
    updatedAt               DateTime @updatedAt

    // Version history relation
    Versions ContextItemVersion[]

    // Indexes
    @@index([tenantId])
    @@index([consultationId])
    @@index([type])
    @@index([source])
    @@index([createdAt])
    @@index([qdrantSynced])
    // Composite for common queries
    @@index([consultationId, type])
    @@index([tenantId, type, createdAt])
    @@schema("core")
}
```

### 4. ContextItemVersion Model

```prisma
model ContextItemVersion {
    // Meta fields
    metaData Json?  @map("_metadata") @db.JsonB
    id       String @id @default(uuid(7))

    // Multi-tenant
    tenantId String @default("50000000-0000-0000-0000-000000000000")

    // Parent context item
    contextItemId String
    ContextItem   ContextItem @relation(fields: [contextItemId], references: [id])

    // Version number (1, 2, 3...)
    versionNumber Int

    // Snapshot of content at this version
    content        String? @db.Text
    structuredData Json?   @db.JsonB
    mediaUri       String?

    // What changed
    changeReason  String? // e.g., "user_edit", "ai_regeneration", "correction"
    changeSummary String? // Brief description of what changed

    // Who/what made the change
    changedBy    String? // User ID or "system"
    changeSource String? // e.g., "manual", "ai_model_v2", "bulk_update"

    // Timestamp of when this version was created
    createdAt DateTime @default(now())

    // Indexes
    @@index([tenantId])
    @@index([contextItemId])
    @@index([versionNumber])
    @@index([createdAt])
    // Composite for fetching version history
    @@index([contextItemId, versionNumber])
    // Unique: one version number per context item
    @@unique([contextItemId, versionNumber])
    @@schema("core")
}
```

## Data Flow

### Consultation Creation Flow

```
1. Patient arrives → Create Consultation (status: active)
2. Doctor starts session → startedAt timestamp set
3. Audio recording begins → Create ContextItem (type: audio, mediaUri: s3://...)
4. Transcription completes → Create ContextItem (type: transcript, content: "...", structuredData: {timestamps, entities})
5. AI generates summary → Create ContextItem (type: summary, content: "...", structuredData: {aiModel, sections})
6. Doctor adds notes → Create ContextItem (type: worknote, content: "...")
7. Session ends → Update Consultation (status: completed, endedAt)
```

### Referral Flow

```
1. Doctor A creates Consultation for patient
2. Doctor A requests lab work → Create child Consultation (parentConsultationId = Doctor A's consultation, doctorId = Lab Doctor)
3. Lab completes work → Child consultation completed with results in ContextItems
4. Doctor A reviews → Can query all child consultations via parentConsultationId
```

### Re-visit Flow (Same Doctor, Same Day)

```
1. Morning visit → Consultation #1 (parentConsultationId: null)
2. Patient returns afternoon → Consultation #2 (parentConsultationId: Consultation #1)
3. Query all visits: WHERE patientId = X AND appointmentDate = Y
```

### Content Versioning Flow

```
1. Create ContextItem (version: 1)
2. User edits content:
   a. Copy current state to ContextItemVersion (versionNumber: 1)
   b. Update ContextItem (version: 2, new content)
   c. Regenerate embedding, set qdrantSynced: false
3. Background job syncs to Qdrant, sets qdrantSynced: true
```

## Search Strategy

### Full-Text Search (PostgreSQL tsvector)

```sql
-- Create GIN index (in migration)
CREATE INDEX context_item_search_idx ON "ContextItem" USING GIN (search_vector);

-- Update trigger to populate search_vector
CREATE TRIGGER context_item_search_update
BEFORE INSERT OR UPDATE ON "ContextItem"
FOR EACH ROW EXECUTE FUNCTION
tsvector_update_trigger(search_vector, 'pg_catalog.english', content);

-- Query
SELECT * FROM "ContextItem"
WHERE search_vector @@ plainto_tsquery('english', 'chest pain medication');
```

### Semantic Search (pgvector + Qdrant)

```typescript
// Local pgvector search (fallback)
const results = await prisma.$queryRaw`
  SELECT id, content, 1 - (embedding <=> ${queryEmbedding}::vector) as similarity
  FROM "ContextItem"
  WHERE tenant_id = ${tenantId}
  ORDER BY embedding <=> ${queryEmbedding}::vector
  LIMIT 10
`;

// Qdrant search (primary)
const qdrantResults = await qdrantClient.search('context_items', {
  vector: queryEmbedding,
  filter: { must: [{ key: 'tenant_id', match: { value: tenantId } }] },
  limit: 10
});
```

## Error Handling

| Scenario | Handling |
|----------|----------|
| Qdrant sync fails | Retry with exponential backoff, `qdrantSynced` stays false |
| Embedding generation fails | Store content without embedding, flag for retry |
| Version conflict | Use optimistic locking via `version` field |
| Parent consultation deleted | Soft-delete cascades to children via application logic |
| Invalid department reference | FK constraint prevents invalid references |

## Testing Strategy

### Unit Tests

- Model validation (required fields, constraints)
- Version increment logic
- Parent-child relationship integrity

### Integration Tests

- Consultation CRUD with all relations
- ContextItem versioning workflow
- Search vector population
- Qdrant sync status tracking

### Performance Tests

- Query performance with 100k+ consultations
- Full-text search response time
- Vector search latency (pgvector vs Qdrant)

## Migration Notes

### Required PostgreSQL Extensions

```sql
-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Enable full-text search (built-in, but configure)
-- No extension needed, but may need custom dictionaries
```

### Raw SQL Required

The `Unsupported()` types in Prisma require manual SQL in migrations:

```sql
-- Add vector column
ALTER TABLE "ContextItem" ADD COLUMN embedding vector(1536);

-- Add tsvector column
ALTER TABLE "ContextItem" ADD COLUMN search_vector tsvector;

-- Create indexes
CREATE INDEX context_item_embedding_idx ON "ContextItem"
USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX context_item_search_idx ON "ContextItem"
USING GIN (search_vector);
```

## Implementation Summary

### Completed Changes

#### Plan 1: Schema Model Changes
- Created `Department` lookup model (`packages/database/src/prisma/db_main/department.prisma`)
- Updated `Consultation` model - removed `doctorName`, added `departmentId` FK, removed unique constraint
- Updated `ContextItem` model - added `mediaUri`, `qdrantSynced`, `qdrantSyncedAt`
- Created `ContextItemVersion` model for version history
- Updated `User` model relation to `DoctorConsultations`
- Created department seed data (10 medical departments)

#### Plan 2: Infrastructure Updates
- Updated test Docker Compose to use `pgvector/pgvector:pg16` image
- Added Qdrant to test infrastructure (ports 6335/6336)
- Updated Qdrant init script to create `context_items` collection

#### Plan 3: Domain Layer Updates
- Created `DepartmentEntity` and `ContextItemVersionEntity`
- Updated `ConsultationEntity` - removed `doctorName`, added `departmentId`, `Doctor`, `Department`
- Updated `ContextItemEntity` - added `mediaUri`, `qdrantSynced`, versioning support
- Created factories for new entities
- Created mappers and repositories
- Added Qdrant sync methods to `ContextItemRepository`

#### Plan 4: Application Layer Updates
- Created `DepartmentService` with CRUD operations
- Updated `ConsultationService` - uses `departmentId`, added `createRevisit`, `getConsultationChain`
- Updated `ContextService` - added versioning, media support, Qdrant sync tracking
- Updated DTOs for new fields

#### Plan 5: API Layer Updates
- Created `DepartmentController` with endpoints for department management
- Updated `ConsultationController` - added re-visit, chain, version history endpoints
- Registered `DepartmentModule` in `AppModule`
- Updated E2E tests

### Files Modified/Created

**Database Package:**
- `packages/database/src/prisma/db_main/department.prisma` (new)
- `packages/database/src/prisma/db_main/consultation.prisma` (modified)
- `packages/database/src/prisma/db_main/user.prisma` (modified)
- `packages/database/src/prisma/db_main/seed/04-department.ts` (new)
- `packages/database/src/prisma/db_main/seed/index.ts` (modified)

**Infrastructure:**
- `tests/docker-compose.test.yml` (modified)
- `infrastructure/docker/scripts/init-qdrant-collections.py` (modified)

**Domains Package:**
- `packages/domains/src/entities/generated/core/DepartmentEntity.ts` (new)
- `packages/domains/src/entities/generated/core/ContextItemVersionEntity.ts` (new)
- `packages/domains/src/entities/generated/core/ConsultationEntity.ts` (modified)
- `packages/domains/src/entities/generated/core/ContextItemEntity.ts` (modified)
- `packages/domains/src/factories/generated/core/DepartmentFactory.ts` (new)
- `packages/domains/src/factories/generated/core/ContextItemVersionFactory.ts` (new)
- `packages/domains/src/factories/generated/core/ConsultationFactory.ts` (modified)
- `packages/domains/src/factories/generated/core/ContextItemFactory.ts` (modified)
- `packages/domains/src/models/generated/core/DepartmentModel.ts` (new)
- `packages/domains/src/models/generated/core/ContextItemVersionModel.ts` (new)
- `packages/domains/src/mappers/generated/core/DepartmentEntityMapper.ts` (new)
- `packages/domains/src/mappers/generated/core/ContextItemVersionEntityMapper.ts` (new)
- `packages/domains/src/repositories/generated/core/DepartmentRepository.ts` (new)
- `packages/domains/src/repositories/generated/core/ContextItemVersionRepository.ts` (new)
- `packages/domains/src/repositories/generated/core/ConsultationRepository.ts` (modified)
- `packages/domains/src/repositories/generated/core/ContextItemRepository.ts` (modified)

**Applications Package:**
- `packages/applications/src/services/department/` (new directory)
- `packages/applications/src/services/consultation/consultation/` (modified)
- `packages/applications/src/services/consultation/context/` (modified)

**API App:**
- `apps/api/src/controllers/department/` (new directory)
- `apps/api/src/modules/consultation/consultation.controller.ts` (modified)
- `apps/api/src/app.module.ts` (modified)
- `apps/api/tests/e2e/consultation.spec.ts` (modified)

## Open Questions

1. **Embedding dimension**: Currently set to 1536 (OpenAI ada-002). Confirm if using different model.
2. **Search vector language**: Currently English - need multi-language support?
3. **Retention policy**: How long to keep version history?

## Next Steps

1. Run `npx prisma migrate dev` to generate and apply migrations
2. Run `npx prisma db seed` to seed department data
3. Run tests to verify implementation
4. Deploy infrastructure changes (pgvector, Qdrant collection)

## Related Documentation

- Database Package: `docs/data-model/database-package.md`
- Prisma Conventions: `.cursor/rules/02-database.mdc`
- Implementation Plan: `docs/implementation/MODEL-001-Revise-consultation-data-model/planning.md`
