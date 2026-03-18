# Plan: MODEL-001 - Revise Consultation Data Model

**Required Skill**: executing-plans

## Goal

Implement the revised consultation data model with Department lookup table, enhanced ContextItem with versioning, search vectors, and Qdrant sync support.

## Architecture Overview

The implementation follows a bottom-up approach: Database schema → Domain layer → Application layer → API layer. Each layer builds on the previous, ensuring type safety and proper abstractions throughout.

## Tech Stack

- **Database**: TimescaleDB 16+ with pgvector extension
- **ORM**: Prisma 7
- **Domain Layer**: TypeScript entities, factories, mappers, repositories
- **Application Layer**: NestJS services
- **API Layer**: NestJS controllers
- **Vector DB**: Qdrant (external sync)
- **Testing**: Vitest (unit), Playwright (e2e)

---

# PLAN 1: Schema Model Changes and Seeding

## Overview

Update Prisma schema files, create migrations, and add seed data for the new Department table.

---

## Task 1.1: Add Department Model to Schema

**Files**:
- Create: `packages/database/src/prisma/db_main/department.prisma`

**Steps**:

1. Create the Department model file

```prisma
// Department Lookup Table
// Provides consistent department/specialty references for consultations

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

2. Verify file created
```bash
ls -la packages/database/src/prisma/db_main/department.prisma
# Expected: file exists
```

3. Commit
```bash
git add packages/database/src/prisma/db_main/department.prisma
git commit -m "$(cat <<'EOF'
feat(database): add Department lookup model

Add Department model for consistent department/specialty references
with support for hierarchical structure (parent-child departments).
EOF
)"
```

---

## Task 1.2: Update Consultation Model

**Files**:
- Modify: `packages/database/src/prisma/db_main/consultation.prisma`

**Steps**:

1. Update Consultation model with new fields and relations

Replace the entire file content with:

```prisma
// Consultation Domain Models
// Consultation is the top-level entity for SDK v2

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
    @@index([tenantId], name: "Consultation_tenantId_idx")
    @@index([patientId], name: "Consultation_patientId_idx")
    @@index([appointmentDate], name: "Consultation_appointmentDate_idx")
    @@index([doctorId], name: "Consultation_doctorId_idx")
    @@index([departmentId], name: "Consultation_departmentId_idx")
    @@index([parentConsultationId], name: "Consultation_parentId_idx")
    @@index([status], name: "Consultation_status_idx")
    // Composite for common query pattern
    @@index([tenantId, patientId, appointmentDate], name: "Consultation_tenant_patient_date_idx")
    @@schema("core")
}

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
    // Note: Requires raw SQL migration to create column and index
    // searchVector Unsupported("tsvector")?

    // Vector embedding for semantic search (pgvector)
    // Note: Requires raw SQL migration to create column and index
    // embedding Unsupported("vector(1536)")?

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
    @@index([tenantId], name: "ContextItem_tenantId_idx")
    @@index([consultationId], name: "ContextItem_consultationId_idx")
    @@index([type], name: "ContextItem_type_idx")
    @@index([source], name: "ContextItem_source_idx")
    @@index([createdAt], name: "ContextItem_createdAt_idx")
    @@index([qdrantSynced], name: "ContextItem_qdrantSynced_idx")
    // Composite for common queries
    @@index([consultationId, type], name: "ContextItem_consultation_type_idx")
    @@index([tenantId, type, createdAt], name: "ContextItem_tenant_type_created_idx")
    @@schema("core")
}

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
    @@index([tenantId], name: "ContextItemVersion_tenantId_idx")
    @@index([contextItemId], name: "ContextItemVersion_contextItemId_idx")
    @@index([versionNumber], name: "ContextItemVersion_versionNumber_idx")
    @@index([createdAt], name: "ContextItemVersion_createdAt_idx")
    // Composite for fetching version history
    @@index([contextItemId, versionNumber], name: "ContextItemVersion_item_version_idx")
    // Unique: one version number per context item
    @@unique([contextItemId, versionNumber])
    @@schema("core")
}
```

2. Verify schema syntax
```bash
cd packages/database && npx prisma validate
# Expected: Prisma schema is valid
```

3. Commit
```bash
git add packages/database/src/prisma/db_main/consultation.prisma
git commit -m "$(cat <<'EOF'
feat(database): revise Consultation and ContextItem models

- Remove doctorName (use User relation instead)
- Add Doctor FK relation to User
- Add Department FK relation
- Remove unique constraint (allow re-visits)
- Add ContextItem.mediaUri for file references
- Add ContextItem.qdrantSynced for vector sync tracking
- Add ContextItemVersion for version history
- Add composite indexes for common queries
EOF
)"
```

---

## Task 1.3: Update User Model with Doctor Relation

**Files**:
- Modify: `packages/database/src/prisma/db_main/user.prisma`

**Steps**:

1. Update User model to add DoctorConsultations relation

Find the existing `Consultations` relation and rename it:

```prisma
// Change this line:
Consultations         Consultation[]         @relation("_User_Consultations")

// To this:
DoctorConsultations   Consultation[]         @relation("DoctorConsultations")
```

2. Verify schema syntax
```bash
cd packages/database && npx prisma validate
# Expected: Prisma schema is valid
```

3. Commit
```bash
git add packages/database/src/prisma/db_main/user.prisma
git commit -m "$(cat <<'EOF'
feat(database): rename User-Consultation relation to DoctorConsultations

Clarifies the relationship - User acts as Doctor in consultations.
EOF
)"
```

---

## Task 1.4: Generate Prisma Migration

**Files**:
- Create: `packages/database/src/prisma/db_main/migrations/[timestamp]_revise_consultation_model/migration.sql`

**Steps**:

1. Generate migration
```bash
cd packages/database && npx prisma migrate dev --name revise_consultation_model
# Expected: Migration created successfully
```

2. Review generated SQL (check the migration file)
```bash
ls -la packages/database/src/prisma/db_main/migrations/
# Expected: New migration folder exists
```

3. Commit migration
```bash
git add packages/database/src/prisma/db_main/migrations/
git commit -m "$(cat <<'EOF'
feat(database): add migration for consultation model revision

Includes:
- Department table creation
- Consultation schema updates (FK relations, remove unique constraint)
- ContextItem new fields (mediaUri, qdrantSynced)
- ContextItemVersion table creation
EOF
)"
```

---

## Task 1.5: Add Raw SQL for pgvector and tsvector

**Files**:
- Create: `packages/database/src/prisma/db_main/migrations/[timestamp]_add_search_vectors/migration.sql`

**Steps**:

1. Create manual migration for vector columns
```bash
mkdir -p packages/database/src/prisma/db_main/migrations/$(date +%Y%m%d%H%M%S)_add_search_vectors
```

2. Create migration SQL file with content:

```sql
-- Enable pgvector extension (if not already enabled)
CREATE EXTENSION IF NOT EXISTS vector;

-- Add tsvector column for full-text search
ALTER TABLE "core"."ContextItem" ADD COLUMN IF NOT EXISTS "searchVector" tsvector;

-- Add vector column for semantic search (1536 dimensions for OpenAI embeddings)
ALTER TABLE "core"."ContextItem" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);

-- Create GIN index for full-text search
CREATE INDEX IF NOT EXISTS "ContextItem_searchVector_idx"
ON "core"."ContextItem" USING GIN ("searchVector");

-- Create IVFFlat index for vector similarity search
-- Note: IVFFlat requires data to exist for optimal list count
-- Using HNSW for better performance with small datasets
CREATE INDEX IF NOT EXISTS "ContextItem_embedding_idx"
ON "core"."ContextItem" USING hnsw ("embedding" vector_cosine_ops);

-- Create trigger to auto-update search vector on insert/update
CREATE OR REPLACE FUNCTION "core".context_item_search_vector_update()
RETURNS trigger AS $$
BEGIN
    NEW."searchVector" := to_tsvector('english', COALESCE(NEW."content", ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "context_item_search_vector_trigger" ON "core"."ContextItem";

CREATE TRIGGER "context_item_search_vector_trigger"
BEFORE INSERT OR UPDATE OF "content" ON "core"."ContextItem"
FOR EACH ROW
EXECUTE FUNCTION "core".context_item_search_vector_update();
```

3. Mark migration as applied
```bash
cd packages/database && npx prisma migrate resolve --applied $(ls -1 src/prisma/db_main/migrations/ | grep add_search_vectors | head -1)
```

4. Commit
```bash
git add packages/database/src/prisma/db_main/migrations/
git commit -m "$(cat <<'EOF'
feat(database): add pgvector and tsvector columns for search

- Add searchVector (tsvector) for PostgreSQL full-text search
- Add embedding (vector) for pgvector semantic search
- Create GIN index for full-text search
- Create HNSW index for vector similarity
- Add trigger to auto-update search vector on content change
EOF
)"
```

---

## Task 1.6: Create Department Seed Data

**Files**:
- Create: `packages/database/src/prisma/db_main/seed/04-department.ts`
- Modify: `packages/database/src/prisma/db_main/seed/index.ts`

**Steps**:

1. Create department seed file

```typescript
import type { CorePrismaClient } from '../../../client';

export const seedDepartment = async (client: CorePrismaClient) => {
    console.log('Seeding departments...');

    try {
        // Common medical departments
        const departments = [
            {
                id: '70000000-0000-0000-0000-000000000001',
                tenantId: '50000000-0000-0000-0000-000000000000',
                code: 'GEN',
                name: 'General Practice',
                description: 'General medical consultations and primary care',
            },
            {
                id: '70000000-0000-0000-0000-000000000002',
                tenantId: '50000000-0000-0000-0000-000000000000',
                code: 'CARD',
                name: 'Cardiology',
                description: 'Heart and cardiovascular system specialists',
            },
            {
                id: '70000000-0000-0000-0000-000000000003',
                tenantId: '50000000-0000-0000-0000-000000000000',
                code: 'RAD',
                name: 'Radiology',
                description: 'Medical imaging and diagnostic radiology',
            },
            {
                id: '70000000-0000-0000-0000-000000000004',
                tenantId: '50000000-0000-0000-0000-000000000000',
                code: 'LAB',
                name: 'Laboratory',
                description: 'Clinical laboratory and pathology services',
            },
            {
                id: '70000000-0000-0000-0000-000000000005',
                tenantId: '50000000-0000-0000-0000-000000000000',
                code: 'NEUR',
                name: 'Neurology',
                description: 'Brain and nervous system specialists',
            },
            {
                id: '70000000-0000-0000-0000-000000000006',
                tenantId: '50000000-0000-0000-0000-000000000000',
                code: 'ORTH',
                name: 'Orthopedics',
                description: 'Musculoskeletal system and bone specialists',
            },
            {
                id: '70000000-0000-0000-0000-000000000007',
                tenantId: '50000000-0000-0000-0000-000000000000',
                code: 'DERM',
                name: 'Dermatology',
                description: 'Skin, hair, and nail specialists',
            },
            {
                id: '70000000-0000-0000-0000-000000000008',
                tenantId: '50000000-0000-0000-0000-000000000000',
                code: 'PSYCH',
                name: 'Psychiatry',
                description: 'Mental health and psychiatric care',
            },
            {
                id: '70000000-0000-0000-0000-000000000009',
                tenantId: '50000000-0000-0000-0000-000000000000',
                code: 'PEDS',
                name: 'Pediatrics',
                description: 'Child and adolescent healthcare',
            },
            {
                id: '70000000-0000-0000-0000-000000000010',
                tenantId: '50000000-0000-0000-0000-000000000000',
                code: 'ER',
                name: 'Emergency',
                description: 'Emergency and urgent care services',
            },
        ];

        for (const dept of departments) {
            await client.department.upsert({
                where: {
                    tenantId_code: {
                        tenantId: dept.tenantId,
                        code: dept.code,
                    },
                },
                update: dept,
                create: dept,
            });
        }

        console.log(`Seeded ${departments.length} departments`);
    } catch (error) {
        console.error('Error seeding departments:', error);
        throw error;
    }
};
```

2. Update seed index to include departments

Add import and call:
```typescript
import { seedDepartment } from './04-department';

// In seed() function, after seedRole:
await seedDepartment(client);
console.log('');
```

3. Test seed execution
```bash
cd packages/database && npx prisma db seed
# Expected: Seeded 10 departments
```

4. Commit
```bash
git add packages/database/src/prisma/db_main/seed/
git commit -m "$(cat <<'EOF'
feat(database): add Department seed data

Add 10 common medical departments for consultation references:
GEN, CARD, RAD, LAB, NEUR, ORTH, DERM, PSYCH, PEDS, ER
EOF
)"
```

---

## Task 1.7: Regenerate Prisma Client

**Files**:
- Modify: `packages/database/src/generated/` (auto-generated)

**Steps**:

1. Regenerate Prisma client
```bash
cd packages/database && npx prisma generate
# Expected: Prisma client generated successfully
```

2. Verify types are generated
```bash
ls packages/database/src/generated/
# Expected: Generated client files exist
```

3. Commit generated files (if tracked)
```bash
git add packages/database/src/generated/
git commit -m "chore(database): regenerate Prisma client with new models"
```

---

# PLAN 2: Infrastructure Updates

## Overview

Update development and test Docker infrastructure to support pgvector extension and Qdrant collection for context items.

---

## Task 2.1: Update Development Docker Compose for pgvector

**Files**:
- Modify: `infrastructure/docker/docker-compose.yml` (if exists) or create postgres config

**Steps**:

1. Check if postgres service exists in main docker-compose
```bash
ls infrastructure/docker/docker-compose*.yml
```

2. If using external postgres, create initialization script:

Create `infrastructure/docker/scripts/init-pgvector.sql`:
```sql
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Verify extension is installed
SELECT * FROM pg_extension WHERE extname = 'vector';
```

3. Update postgres service to use pgvector image (if managing postgres):

The postgres service should use `pgvector/pgvector:pg16` image instead of `postgres:16-alpine`.

4. Commit
```bash
git add infrastructure/docker/
git commit -m "$(cat <<'EOF'
feat(infra): add pgvector support to development postgres

- Add init script to enable vector extension
- Document pgvector requirements
EOF
)"
```

---

## Task 2.2: Update Test Docker Compose for pgvector

**Files**:
- Modify: `tests/docker-compose.test.yml`

**Steps**:

1. Update postgres-test service to use pgvector image

Change:
```yaml
postgres-test:
  image: postgres:16-alpine
```

To:
```yaml
postgres-test:
  image: pgvector/pgvector:pg16
```

2. Add volume mount for init script:
```yaml
volumes:
  - ./scripts/init-pgvector.sql:/docker-entrypoint-initdb.d/init-pgvector.sql:ro
```

3. Create test init script at `tests/scripts/init-pgvector.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

4. Verify docker-compose syntax
```bash
docker compose -f tests/docker-compose.test.yml config
# Expected: Valid YAML output
```

5. Commit
```bash
git add tests/
git commit -m "$(cat <<'EOF'
feat(test-infra): add pgvector support to test postgres

Use pgvector/pgvector:pg16 image and enable vector extension
for testing semantic search functionality.
EOF
)"
```

---

## Task 2.3: Add Qdrant Collection for Context Items

**Files**:
- Modify: `infrastructure/docker/scripts/init-qdrant-collections.py`

**Steps**:

1. Add context_items collection configuration

Add after the existing collection setup:

```python
# Context Items Collection Configuration
CONTEXT_ITEMS_COLLECTION = "context_items"
CONTEXT_ITEMS_VECTOR_SIZE = 1536  # OpenAI embedding dimension

def create_context_items_collection(client):
    """Create collection for context item embeddings"""
    print(f"Creating collection '{CONTEXT_ITEMS_COLLECTION}'...")

    try:
        collections = client.get_collections().collections
        collection_names = [col.name for col in collections]

        if CONTEXT_ITEMS_COLLECTION in collection_names:
            print(f"✓ Collection '{CONTEXT_ITEMS_COLLECTION}' already exists")
            return

        client.create_collection(
            collection_name=CONTEXT_ITEMS_COLLECTION,
            vectors_config=VectorParams(
                size=CONTEXT_ITEMS_VECTOR_SIZE,
                distance=Distance.COSINE
            )
        )
        print(f"✓ Collection '{CONTEXT_ITEMS_COLLECTION}' created")

        # Create payload indexes for filtering
        client.create_payload_index(
            collection_name=CONTEXT_ITEMS_COLLECTION,
            field_name="tenant_id",
            field_schema="keyword"
        )
        client.create_payload_index(
            collection_name=CONTEXT_ITEMS_COLLECTION,
            field_name="consultation_id",
            field_schema="keyword"
        )
        client.create_payload_index(
            collection_name=CONTEXT_ITEMS_COLLECTION,
            field_name="type",
            field_schema="keyword"
        )
        print("✓ Payload indexes created")

    except Exception as e:
        print(f"✗ Failed to create collection: {e}")
        raise
```

2. Call the new function in main():
```python
# In main() after existing collection setup:
create_context_items_collection(client)
```

3. Commit
```bash
git add infrastructure/docker/scripts/init-qdrant-collections.py
git commit -m "$(cat <<'EOF'
feat(infra): add Qdrant collection for context item embeddings

- Create context_items collection with 1536 dimensions (OpenAI)
- Add payload indexes for tenant_id, consultation_id, type filtering
EOF
)"
```

---

## Task 2.4: Add Qdrant to Test Infrastructure

**Files**:
- Modify: `tests/docker-compose.test.yml`

**Steps**:

1. Add qdrant-test service

```yaml
# ==========================================================================
# Qdrant Test Vector Database
# ==========================================================================
qdrant-test:
  image: qdrant/qdrant:v1.7.4
  container_name: hope-qdrant-test
  ports:
    - '6335:6333'  # Different port from dev (6333)
    - '6336:6334'  # gRPC port
  tmpfs:
    - /qdrant/storage
  networks:
    - hope-test-network
```

2. Verify docker-compose syntax
```bash
docker compose -f tests/docker-compose.test.yml config
# Expected: Valid YAML output
```

3. Commit
```bash
git add tests/docker-compose.test.yml
git commit -m "$(cat <<'EOF'
feat(test-infra): add Qdrant to test infrastructure

Add qdrant-test service on ports 6335/6336 (isolated from dev)
for testing vector search functionality.
EOF
)"
```

---

# PLAN 3: Domain Layer Updates

## Overview

Update domain entities, factories, mappers, and repositories to reflect the new schema. The domain layer is auto-generated from Prisma schema, but custom domain methods need manual updates.

---

## Task 3.1: Regenerate Domain Layer

**Files**:
- Modify: `packages/domains/src/entities/generated/core/` (auto-generated)
- Modify: `packages/domains/src/factories/generated/core/` (auto-generated)
- Modify: `packages/domains/src/mappers/generated/core/` (auto-generated)
- Modify: `packages/domains/src/repositories/generated/core/` (auto-generated)

**Steps**:

1. Run domain generation script (if exists)
```bash
cd packages/domains && pnpm generate
# Or the specific generation command for your project
```

2. If no generation script, manually verify the generated files need updates based on Prisma schema changes.

3. Commit generated files
```bash
git add packages/domains/src/
git commit -m "chore(domains): regenerate domain layer from updated schema"
```

---

## Task 3.2: Update ConsultationEntity Custom Methods

**Files**:
- Modify: `packages/domains/src/entities/generated/core/ConsultationEntity.ts`

**Steps**:

1. Update interface to reflect schema changes

Remove `doctorName` from interface:
```typescript
export interface IConsultationEntity extends IBaseTenantEntity {
    patientId: string;
    appointmentDate: Date;
    doctorId: string;
    // Remove: doctorName?: string | null;
    departmentId?: string | null;  // Add this
    parentConsultationId?: string | null;
    status: string;
    // Remove: department?: string | null;
    startedAt: Date;
    endedAt?: Date | null;
    metadata?: JsonValue | null;
    ParentConsultation?: Entities.ConsultationEntity | null;
    ChildConsultations?: Entities.ConsultationEntity[] | null;
    ContextItems?: Entities.ContextItemEntity[] | null;
    Doctor?: Entities.UserEntity | null;  // Add this
    Department?: Entities.DepartmentEntity | null;  // Add this
}
```

2. Update class properties and constructor accordingly

3. Update validate() method:
```typescript
public override validate(): void {
    if (!this._patientId) {
        throw new BusinessException('Patient ID is required');
    }
    if (!this._doctorId) {
        throw new BusinessException('Doctor ID is required');
    }
    if (!this._appointmentDate) {
        throw new BusinessException('Appointment date is required');
    }
}
```

4. Commit
```bash
git add packages/domains/src/entities/generated/core/ConsultationEntity.ts
git commit -m "$(cat <<'EOF'
feat(domains): update ConsultationEntity for new schema

- Remove doctorName property
- Add departmentId and Department relation
- Add Doctor relation to User
EOF
)"
```

---

## Task 3.3: Update ContextItemEntity with New Fields

**Files**:
- Modify: `packages/domains/src/entities/generated/core/ContextItemEntity.ts`

**Steps**:

1. Update interface with new fields:
```typescript
export interface IContextItemEntity extends IBaseTenantEntity {
    consultationId: string;
    type: string;
    content?: string | null;  // Now nullable
    mediaUri?: string | null;  // Add
    structuredData?: JsonValue | null;
    source: string;
    qdrantSynced: boolean;  // Add
    qdrantSyncedAt?: Date | null;  // Add
    Consultation?: Entities.ConsultationEntity | null;
    Versions?: Entities.ContextItemVersionEntity[] | null;  // Add
}
```

2. Add new properties and getters/setters

3. Update validate() to allow null content for media types:
```typescript
public override validate(): void {
    if (!this._consultationId) {
        throw new BusinessException('Consultation ID is required');
    }
    if (!this._type) {
        throw new BusinessException('Type is required');
    }
    // Content is optional for media types (audio, attachment)
    const mediaTypes = ['audio', 'attachment', 'image'];
    if (!this._content && !mediaTypes.includes(this._type)) {
        throw new BusinessException('Content is required for non-media types');
    }
    if (!this._source) {
        throw new BusinessException('Source is required');
    }
}
```

4. Add helper methods:
```typescript
/**
 * Check if this item has been synced to Qdrant
 */
get isSyncedToQdrant(): boolean {
    return this._qdrantSynced;
}

/**
 * Check if this is a media type (has mediaUri instead of content)
 */
get isMediaType(): boolean {
    return ['audio', 'attachment', 'image'].includes(this._type);
}

/**
 * Mark as synced to Qdrant
 */
markQdrantSynced(): void {
    this.qdrantSynced = true;
    this.qdrantSyncedAt = new Date();
}
```

5. Commit
```bash
git add packages/domains/src/entities/generated/core/ContextItemEntity.ts
git commit -m "$(cat <<'EOF'
feat(domains): update ContextItemEntity with new fields

- Add mediaUri for file references
- Add qdrantSynced/qdrantSyncedAt for sync tracking
- Add Versions relation
- Update validation for nullable content
- Add helper methods for media types and sync status
EOF
)"
```

---

## Task 3.4: Create DepartmentEntity

**Files**:
- Create: `packages/domains/src/entities/generated/core/DepartmentEntity.ts`

**Steps**:

1. Create DepartmentEntity following the BaseEntity pattern:

```typescript
/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Entities from '../../../entities';

export interface IDepartmentEntity extends IBaseTenantEntity {
    code: string;
    name: string;
    description?: string | null;
    parentDepartmentId?: string | null;
    ParentDepartment?: Entities.DepartmentEntity | null;
    ChildDepartments?: Entities.DepartmentEntity[] | null;
    Consultations?: Entities.ConsultationEntity[] | null;
}

export class DepartmentEntity extends BaseTenantEntity {
    private _code: IDepartmentEntity['code'];
    private _name: IDepartmentEntity['name'];
    private _description?: IDepartmentEntity['description'];
    private _parentDepartmentId?: IDepartmentEntity['parentDepartmentId'];
    private _ParentDepartment?: IDepartmentEntity['ParentDepartment'];
    private _ChildDepartments?: IDepartmentEntity['ChildDepartments'];
    private _Consultations?: IDepartmentEntity['Consultations'];

    constructor(init: IDepartmentEntity) {
        super(init);
        this._code = init.code;
        this._name = init.name;
        this._description = init.description;
        this._parentDepartmentId = init.parentDepartmentId;
        this._ParentDepartment = init.ParentDepartment;
        this._ChildDepartments = init.ChildDepartments;
        this._Consultations = init.Consultations;
    }

    get code(): IDepartmentEntity['code'] {
        return this._code;
    }

    set code(value: IDepartmentEntity['code']) {
        this.setProperty('code', value);
    }

    get name(): IDepartmentEntity['name'] {
        return this._name;
    }

    set name(value: IDepartmentEntity['name']) {
        this.setProperty('name', value);
    }

    get description(): IDepartmentEntity['description'] {
        return this._description;
    }

    set description(value: IDepartmentEntity['description']) {
        this.setProperty('description', value);
    }

    get parentDepartmentId(): IDepartmentEntity['parentDepartmentId'] {
        return this._parentDepartmentId;
    }

    set parentDepartmentId(value: IDepartmentEntity['parentDepartmentId']) {
        this.setProperty('parentDepartmentId', value);
    }

    get ParentDepartment(): IDepartmentEntity['ParentDepartment'] {
        return this._ParentDepartment;
    }

    set ParentDepartment(value: IDepartmentEntity['ParentDepartment']) {
        this.setProperty('ParentDepartment', value);
    }

    get ChildDepartments(): IDepartmentEntity['ChildDepartments'] {
        return this._ChildDepartments;
    }

    set ChildDepartments(value: IDepartmentEntity['ChildDepartments']) {
        this.setProperty('ChildDepartments', value);
    }

    get Consultations(): IDepartmentEntity['Consultations'] {
        return this._Consultations;
    }

    set Consultations(value: IDepartmentEntity['Consultations']) {
        this.setProperty('Consultations', value);
    }

    // ============================================
    // Custom Domain Methods
    // ============================================

    /**
     * Check if this is a root department (no parent)
     */
    get isRootDepartment(): boolean {
        return !this._parentDepartmentId;
    }

    /**
     * Check if this department has children
     */
    get hasChildren(): boolean {
        return !!this._ChildDepartments && this._ChildDepartments.length > 0;
    }

    public override validate(): void {
        if (!this._code) {
            throw new BusinessException('Department code is required');
        }
        if (!this._name) {
            throw new BusinessException('Department name is required');
        }
    }
}
```

2. Export from index
```typescript
// In packages/domains/src/entities/generated/core/index.ts
export * from './DepartmentEntity';
```

3. Commit
```bash
git add packages/domains/src/entities/generated/core/
git commit -m "feat(domains): add DepartmentEntity"
```

---

## Task 3.5: Create ContextItemVersionEntity

**Files**:
- Create: `packages/domains/src/entities/generated/core/ContextItemVersionEntity.ts`

**Steps**:

1. Create ContextItemVersionEntity:

```typescript
/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Entities from '../../../entities';

export interface IContextItemVersionEntity extends IBaseTenantEntity {
    contextItemId: string;
    versionNumber: number;
    content?: string | null;
    structuredData?: JsonValue | null;
    mediaUri?: string | null;
    changeReason?: string | null;
    changeSummary?: string | null;
    changedBy?: string | null;
    changeSource?: string | null;
    ContextItem?: Entities.ContextItemEntity | null;
}

export class ContextItemVersionEntity extends BaseTenantEntity {
    private _contextItemId: IContextItemVersionEntity['contextItemId'];
    private _versionNumber: IContextItemVersionEntity['versionNumber'];
    private _content?: IContextItemVersionEntity['content'];
    private _structuredData?: IContextItemVersionEntity['structuredData'];
    private _mediaUri?: IContextItemVersionEntity['mediaUri'];
    private _changeReason?: IContextItemVersionEntity['changeReason'];
    private _changeSummary?: IContextItemVersionEntity['changeSummary'];
    private _changedBy?: IContextItemVersionEntity['changedBy'];
    private _changeSource?: IContextItemVersionEntity['changeSource'];
    private _ContextItem?: IContextItemVersionEntity['ContextItem'];

    constructor(init: IContextItemVersionEntity) {
        super(init);
        this._contextItemId = init.contextItemId;
        this._versionNumber = init.versionNumber;
        this._content = init.content;
        this._structuredData = init.structuredData;
        this._mediaUri = init.mediaUri;
        this._changeReason = init.changeReason;
        this._changeSummary = init.changeSummary;
        this._changedBy = init.changedBy;
        this._changeSource = init.changeSource;
        this._ContextItem = init.ContextItem;
    }

    // Getters and setters for all properties...
    get contextItemId(): IContextItemVersionEntity['contextItemId'] {
        return this._contextItemId;
    }

    get versionNumber(): IContextItemVersionEntity['versionNumber'] {
        return this._versionNumber;
    }

    get content(): IContextItemVersionEntity['content'] {
        return this._content;
    }

    get structuredData(): IContextItemVersionEntity['structuredData'] {
        return this._structuredData;
    }

    get mediaUri(): IContextItemVersionEntity['mediaUri'] {
        return this._mediaUri;
    }

    get changeReason(): IContextItemVersionEntity['changeReason'] {
        return this._changeReason;
    }

    get changeSummary(): IContextItemVersionEntity['changeSummary'] {
        return this._changeSummary;
    }

    get changedBy(): IContextItemVersionEntity['changedBy'] {
        return this._changedBy;
    }

    get changeSource(): IContextItemVersionEntity['changeSource'] {
        return this._changeSource;
    }

    get ContextItem(): IContextItemVersionEntity['ContextItem'] {
        return this._ContextItem;
    }

    public override validate(): void {
        if (!this._contextItemId) {
            throw new BusinessException('Context item ID is required');
        }
        if (this._versionNumber === undefined || this._versionNumber < 1) {
            throw new BusinessException('Version number must be >= 1');
        }
    }
}
```

2. Export from index
```typescript
// In packages/domains/src/entities/generated/core/index.ts
export * from './ContextItemVersionEntity';
```

3. Commit
```bash
git add packages/domains/src/entities/generated/core/
git commit -m "feat(domains): add ContextItemVersionEntity"
```

---

## Task 3.6: Create DepartmentFactory

**Files**:
- Create: `packages/domains/src/factories/generated/core/DepartmentFactory.ts`

**Steps**:

1. Create factory following existing patterns:

```typescript
import { v7 as uuidv7 } from 'uuid';
import { DepartmentEntity, IDepartmentEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';

type CreateDepartmentInput = Omit<
    IDepartmentEntity,
    'id' | 'version' | 'resourceStatus' | 'createdAt' | 'updatedAt'
> & {
    id?: string;
};

export class DepartmentFactory {
    static CreateDepartment(input: CreateDepartmentInput): DepartmentEntity {
        return new DepartmentEntity({
            id: input.id ?? uuidv7(),
            version: 1,
            tenantId: input.tenantId,
            code: input.code,
            name: input.name,
            description: input.description,
            parentDepartmentId: input.parentDepartmentId,
            resourceStatus: ResourceStatusType.ENABLED,
            createdBy: input.createdBy,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    }
}
```

2. Export from index
```typescript
// In packages/domains/src/factories/generated/core/index.ts
export * from './DepartmentFactory';
```

3. Commit
```bash
git add packages/domains/src/factories/generated/core/
git commit -m "feat(domains): add DepartmentFactory"
```

---

## Task 3.7: Create ContextItemVersionFactory

**Files**:
- Create: `packages/domains/src/factories/generated/core/ContextItemVersionFactory.ts`

**Steps**:

1. Create factory:

```typescript
import { v7 as uuidv7 } from 'uuid';
import { ContextItemVersionEntity, IContextItemVersionEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';

type CreateVersionInput = Omit<
    IContextItemVersionEntity,
    'id' | 'resourceStatus' | 'createdAt' | 'updatedAt'
> & {
    id?: string;
};

export class ContextItemVersionFactory {
    /**
     * Create a version snapshot from a ContextItem before update
     */
    static CreateFromContextItem(
        contextItemId: string,
        versionNumber: number,
        content: string | null | undefined,
        structuredData: unknown,
        mediaUri: string | null | undefined,
        changeReason: string,
        changedBy: string,
        changeSource: string = 'manual',
        tenantId: string,
    ): ContextItemVersionEntity {
        return new ContextItemVersionEntity({
            id: uuidv7(),
            tenantId,
            contextItemId,
            versionNumber,
            content,
            structuredData,
            mediaUri,
            changeReason,
            changeSummary: null,
            changedBy,
            changeSource,
            resourceStatus: ResourceStatusType.ENABLED,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
    }
}
```

2. Export from index
```typescript
// In packages/domains/src/factories/generated/core/index.ts
export * from './ContextItemVersionFactory';
```

3. Commit
```bash
git add packages/domains/src/factories/generated/core/
git commit -m "feat(domains): add ContextItemVersionFactory"
```

---

## Task 3.8: Update ConsultationFactory

**Files**:
- Modify: `packages/domains/src/factories/generated/core/ConsultationFactory.ts`

**Steps**:

1. Update CreateNewVisit to use departmentId instead of department string:

```typescript
type CreateNewVisitInput = {
    tenantId: string;
    patientId: string;
    appointmentDate: Date;
    doctorId: string;
    departmentId?: string;  // Changed from department: string
    metadata?: JsonValue;
    createdBy?: string;
};

static CreateNewVisit(input: CreateNewVisitInput): ConsultationEntity {
    return new ConsultationEntity({
        id: uuidv7(),
        version: 1,
        tenantId: input.tenantId,
        patientId: input.patientId,
        appointmentDate: input.appointmentDate,
        doctorId: input.doctorId,
        departmentId: input.departmentId,  // Changed
        parentConsultationId: null,
        status: 'active',
        startedAt: new Date(),
        endedAt: null,
        metadata: input.metadata,
        resourceStatus: ResourceStatusType.ENABLED,
        createdBy: input.createdBy,
        createdAt: new Date(),
        updatedAt: new Date(),
    });
}
```

2. Commit
```bash
git add packages/domains/src/factories/generated/core/ConsultationFactory.ts
git commit -m "$(cat <<'EOF'
feat(domains): update ConsultationFactory for departmentId

Change department string to departmentId FK reference.
EOF
)"
```

---

## Task 3.9: Create DepartmentRepository

**Files**:
- Create: `packages/domains/src/repositories/generated/core/DepartmentRepository.ts`

**Steps**:

1. Create repository following existing patterns:

```typescript
import { Injectable } from '@nestjs/common';
import { DepartmentEntity } from '../../../entities';
import { DepartmentEntityMapper } from '../../../mappers';
import { BaseRepository } from '../../../common';
import { getExtendedPrismaClient } from '@arcaai/database';

@Injectable()
export class DepartmentRepository extends BaseRepository<DepartmentEntity> {
    constructor() {
        const client = getExtendedPrismaClient();
        super(client, 'department', new DepartmentEntityMapper());
    }

    /**
     * Find department by code within a tenant
     */
    async findByCode(tenantId: string, code: string): Promise<DepartmentEntity | null> {
        const result = await this.client.department.findUnique({
            where: {
                tenantId_code: { tenantId, code },
            },
        });
        return result ? this.mapper.toDomainEntity(result) : null;
    }

    /**
     * Find all root departments (no parent)
     */
    async findRootDepartments(tenantId: string): Promise<DepartmentEntity[]> {
        const results = await this.client.department.findMany({
            where: {
                tenantId,
                parentDepartmentId: null,
                resourceStatus: 'ENABLED',
            },
            orderBy: { name: 'asc' },
        });
        return results.map(r => this.mapper.toDomainEntity(r));
    }

    /**
     * Find children of a department
     */
    async findChildren(departmentId: string): Promise<DepartmentEntity[]> {
        const results = await this.client.department.findMany({
            where: {
                parentDepartmentId: departmentId,
                resourceStatus: 'ENABLED',
            },
            orderBy: { name: 'asc' },
        });
        return results.map(r => this.mapper.toDomainEntity(r));
    }
}
```

2. Export from index
```typescript
// In packages/domains/src/repositories/generated/core/index.ts
export * from './DepartmentRepository';
```

3. Commit
```bash
git add packages/domains/src/repositories/generated/core/
git commit -m "feat(domains): add DepartmentRepository"
```

---

## Task 3.10: Create ContextItemVersionRepository

**Files**:
- Create: `packages/domains/src/repositories/generated/core/ContextItemVersionRepository.ts`

**Steps**:

1. Create repository:

```typescript
import { Injectable } from '@nestjs/common';
import { ContextItemVersionEntity } from '../../../entities';
import { ContextItemVersionEntityMapper } from '../../../mappers';
import { BaseRepository } from '../../../common';
import { getExtendedPrismaClient } from '@arcaai/database';

@Injectable()
export class ContextItemVersionRepository extends BaseRepository<ContextItemVersionEntity> {
    constructor() {
        const client = getExtendedPrismaClient();
        super(client, 'contextItemVersion', new ContextItemVersionEntityMapper());
    }

    /**
     * Get version history for a context item
     */
    async getVersionHistory(contextItemId: string): Promise<ContextItemVersionEntity[]> {
        const results = await this.client.contextItemVersion.findMany({
            where: { contextItemId },
            orderBy: { versionNumber: 'desc' },
        });
        return results.map(r => this.mapper.toDomainEntity(r));
    }

    /**
     * Get specific version
     */
    async getVersion(contextItemId: string, versionNumber: number): Promise<ContextItemVersionEntity | null> {
        const result = await this.client.contextItemVersion.findUnique({
            where: {
                contextItemId_versionNumber: { contextItemId, versionNumber },
            },
        });
        return result ? this.mapper.toDomainEntity(result) : null;
    }

    /**
     * Get latest version number for a context item
     */
    async getLatestVersionNumber(contextItemId: string): Promise<number> {
        const result = await this.client.contextItemVersion.findFirst({
            where: { contextItemId },
            orderBy: { versionNumber: 'desc' },
            select: { versionNumber: true },
        });
        return result?.versionNumber ?? 0;
    }
}
```

2. Export from index

3. Commit
```bash
git add packages/domains/src/repositories/generated/core/
git commit -m "feat(domains): add ContextItemVersionRepository"
```

---

## Task 3.11: Update ConsultationRepository

**Files**:
- Modify: `packages/domains/src/repositories/generated/core/ConsultationRepository.ts`

**Steps**:

1. Update findByUniqueKey to handle multiple results (no unique constraint):

```typescript
/**
 * Find consultation by natural key
 * Note: May return multiple results if re-visits exist
 */
async findByNaturalKey(
    tenantId: string,
    patientId: string,
    appointmentDate: Date,
    doctorId: string,
): Promise<ConsultationEntity[]> {
    const results = await this.client.consultation.findMany({
        where: {
            tenantId,
            patientId,
            appointmentDate,
            doctorId,
            resourceStatus: 'ENABLED',
        },
        orderBy: { startedAt: 'desc' },
    });
    return results.map(r => this.mapper.toDomainEntity(r));
}

/**
 * Find the first/latest consultation by natural key
 */
async findFirstByNaturalKey(
    tenantId: string,
    patientId: string,
    appointmentDate: Date,
    doctorId: string,
): Promise<ConsultationEntity | null> {
    const results = await this.findByNaturalKey(tenantId, patientId, appointmentDate, doctorId);
    return results[0] ?? null;
}
```

2. Add method to include Doctor relation:

```typescript
/**
 * Find consultation with Doctor included
 */
async findWithDoctor(id: string): Promise<ConsultationEntity | null> {
    const result = await this.client.consultation.findUnique({
        where: { id },
        include: {
            Doctor: {
                include: { UserProfile: true },
            },
            Department: true,
        },
    });
    return result ? this.mapper.toDomainEntity(result) : null;
}
```

3. Commit
```bash
git add packages/domains/src/repositories/generated/core/ConsultationRepository.ts
git commit -m "$(cat <<'EOF'
feat(domains): update ConsultationRepository for new schema

- Update findByNaturalKey to return array (no unique constraint)
- Add findFirstByNaturalKey for single result
- Add findWithDoctor to include Doctor relation
EOF
)"
```

---

## Task 3.12: Create Domain Layer Mappers

**Files**:
- Create: `packages/domains/src/mappers/generated/core/DepartmentEntityMapper.ts`
- Create: `packages/domains/src/mappers/generated/core/ContextItemVersionEntityMapper.ts`

**Steps**:

1. Create DepartmentEntityMapper following existing patterns

2. Create ContextItemVersionEntityMapper

3. Update existing mappers for schema changes

4. Commit
```bash
git add packages/domains/src/mappers/generated/core/
git commit -m "feat(domains): add mappers for Department and ContextItemVersion"
```

---

## Task 3.13: Update Domain Layer Exports

**Files**:
- Modify: `packages/domains/src/index.ts`
- Modify: `packages/domains/src/entities/index.ts`
- Modify: `packages/domains/src/factories/index.ts`
- Modify: `packages/domains/src/repositories/index.ts`
- Modify: `packages/domains/src/mappers/index.ts`

**Steps**:

1. Ensure all new entities, factories, repositories, and mappers are exported

2. Commit
```bash
git add packages/domains/src/
git commit -m "chore(domains): update exports for new models"
```

---

## Task 3.14: Add Domain Layer Unit Tests

**Files**:
- Create: `packages/domains/src/entities/generated/core/__tests__/DepartmentEntity.test.ts`
- Create: `packages/domains/src/entities/generated/core/__tests__/ContextItemVersionEntity.test.ts`

**Steps**:

1. Create unit tests for DepartmentEntity:

```typescript
import { describe, it, expect } from 'vitest';
import { DepartmentEntity } from '../DepartmentEntity';
import { DepartmentFactory } from '../../../../factories';

describe('DepartmentEntity', () => {
    const createTestDepartment = () => DepartmentFactory.CreateDepartment({
        tenantId: '50000000-0000-0000-0000-000000000000',
        code: 'TEST',
        name: 'Test Department',
        description: 'Test description',
        createdBy: 'test-user',
    });

    it('should create a valid department', () => {
        const dept = createTestDepartment();
        expect(dept.code).toBe('TEST');
        expect(dept.name).toBe('Test Department');
        expect(dept.isRootDepartment).toBe(true);
    });

    it('should validate required fields', () => {
        const dept = createTestDepartment();
        dept.code = '';
        expect(() => dept.validate()).toThrow('Department code is required');
    });

    it('should track changes', () => {
        const dept = createTestDepartment();
        dept.name = 'Updated Name';
        expect(dept.hasChanges).toBe(true);
        expect(dept.changes.name).toBe('Updated Name');
    });
});
```

2. Create unit tests for ContextItemVersionEntity

3. Run tests
```bash
cd packages/domains && pnpm test
# Expected: All tests pass
```

4. Commit
```bash
git add packages/domains/src/
git commit -m "test(domains): add unit tests for new entities"
```

---

# PLAN 4: Application Layer Updates

## Overview

Update application services to use the new domain models and add new functionality for versioning and search.

---

## Task 4.1: Create DepartmentService

**Files**:
- Create: `packages/applications/src/services/department/department.service.ts`
- Create: `packages/applications/src/services/department/department.service.module.ts`
- Create: `packages/applications/src/services/department/dto/`
- Create: `packages/applications/src/services/department/index.ts`

**Steps**:

1. Create department service:

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    DepartmentRepository,
    DepartmentFactory,
    ResourceType,
} from '@arcaai/domains';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { DepartmentResponse, CreateDepartmentRequest } from './dto';

@Injectable()
export class DepartmentService extends BaseService {
    constructor(
        private readonly departmentRepository: DepartmentRepository,
        protected override readonly eventEmitter: EventEmitter2,
        protected override readonly clsService: ClsService<IActiveUserContext>,
    ) {
        super(eventEmitter, clsService, ResourceType.Department);
    }

    async getAll(): Promise<DepartmentResponse[]> {
        const tenantId = this.tenantId;
        const departments = await this.departmentRepository.$()
            .Where({ tenantId, resourceStatus: 'ENABLED' })
            .OrderBy(['name'], 'asc')
            .ToList();
        return departments.map(d => DepartmentResponse.fromEntity(d));
    }

    async getById(id: string): Promise<DepartmentResponse | null> {
        const department = await this.departmentRepository.findById(id);
        return department ? DepartmentResponse.fromEntity(department) : null;
    }

    async getByCode(code: string): Promise<DepartmentResponse | null> {
        const tenantId = this.tenantId;
        if (!tenantId) return null;
        const department = await this.departmentRepository.findByCode(tenantId, code);
        return department ? DepartmentResponse.fromEntity(department) : null;
    }

    async create(dto: CreateDepartmentRequest): Promise<DepartmentResponse> {
        const tenantId = this.tenantId;
        const userId = this.requestUserId;

        const department = DepartmentFactory.CreateDepartment({
            tenantId: tenantId!,
            code: dto.code,
            name: dto.name,
            description: dto.description,
            parentDepartmentId: dto.parentDepartmentId,
            createdBy: userId ?? undefined,
        });

        const saved = await this.departmentRepository.create(department);
        return DepartmentResponse.fromEntity(saved);
    }
}
```

2. Create DTOs and module

3. Export from index

4. Commit
```bash
git add packages/applications/src/services/department/
git commit -m "feat(applications): add DepartmentService"
```

---

## Task 4.2: Update ConsultationService

**Files**:
- Modify: `packages/applications/src/services/consultation/consultation/consultation.service.ts`
- Modify: `packages/applications/src/services/consultation/consultation/dto/`

**Steps**:

1. Update getOrCreate to use departmentId:

```typescript
async getOrCreate(
    request: OpenConsultationRequest,
    doctorId: string,
): Promise<ConsultationResponse> {
    // ... existing code ...

    // Create new consultation
    const consultation = ConsultationFactory.CreateNewVisit({
        tenantId,
        patientId: request.patientId,
        appointmentDate,
        doctorId,
        departmentId: request.departmentId,  // Changed from department
        metadata: request.metadata,
        createdBy: userId ?? undefined,
    });

    // ... rest of method
}
```

2. Update OpenConsultationRequest DTO:

```typescript
export class OpenConsultationRequest {
    @ApiProperty({ description: 'Patient identifier' })
    @IsString()
    @IsNotEmpty()
    patientId: string;

    @ApiPropertyOptional({ description: 'Appointment date (YYYY-MM-DD)' })
    @IsOptional()
    @IsDateString()
    appointmentDate?: string;

    @ApiPropertyOptional({ description: 'Department ID' })
    @IsOptional()
    @IsString()
    departmentId?: string;  // Changed from department

    @ApiPropertyOptional({ description: 'Additional metadata' })
    @IsOptional()
    metadata?: Record<string, unknown>;
}
```

3. Update ConsultationResponse to include Doctor info:

```typescript
export class ConsultationResponse {
    // ... existing fields ...

    @ApiPropertyOptional({ description: 'Doctor information' })
    doctor?: {
        id: string;
        username: string;
        firstName?: string;
        lastName?: string;
    };

    @ApiPropertyOptional({ description: 'Department information' })
    department?: {
        id: string;
        code: string;
        name: string;
    };
}
```

4. Commit
```bash
git add packages/applications/src/services/consultation/
git commit -m "$(cat <<'EOF'
feat(applications): update ConsultationService for new schema

- Use departmentId instead of department string
- Include Doctor and Department info in response
EOF
)"
```

---

## Task 4.3: Update ContextService with Versioning

**Files**:
- Modify: `packages/applications/src/services/consultation/context/context.service.ts`

**Steps**:

1. Add versioning support to updateContext:

```typescript
async updateContext(
    contextItemId: string,
    dto: UpdateContextRequest,
): Promise<ContextItemResponse> {
    const existing = await this.contextItemRepository.findById(contextItemId);
    if (!existing) {
        throw new NotFoundException(`Context item ${contextItemId} not found`);
    }

    // Create version snapshot before update
    const latestVersion = await this.contextItemVersionRepository.getLatestVersionNumber(contextItemId);
    const version = ContextItemVersionFactory.CreateFromContextItem(
        contextItemId,
        latestVersion + 1,
        existing.content,
        existing.structuredData,
        existing.mediaUri,
        dto.changeReason ?? 'user_edit',
        this.requestUserId ?? 'system',
        'manual',
        existing.tenantId,
    );
    await this.contextItemVersionRepository.create(version);

    // Update the context item
    if (dto.content !== undefined) existing.content = dto.content;
    if (dto.structuredData !== undefined) existing.structuredData = dto.structuredData;
    existing.version += 1;
    existing.qdrantSynced = false;  // Mark for re-sync

    const updated = await this.contextItemRepository.update(contextItemId, existing);
    return ContextItemDtoMapper.toResponse(updated);
}
```

2. Add getVersionHistory method:

```typescript
async getVersionHistory(contextItemId: string): Promise<ContextItemVersionResponse[]> {
    const versions = await this.contextItemVersionRepository.getVersionHistory(contextItemId);
    return versions.map(v => ContextItemVersionResponse.fromEntity(v));
}
```

3. Commit
```bash
git add packages/applications/src/services/consultation/context/
git commit -m "$(cat <<'EOF'
feat(applications): add versioning support to ContextService

- Create version snapshot before updates
- Add getVersionHistory method
- Mark items for Qdrant re-sync on update
EOF
)"
```

---

## Task 4.4: Add ContextService Media Support

**Files**:
- Modify: `packages/applications/src/services/consultation/context/context.service.ts`
- Modify: `packages/applications/src/services/consultation/context/dto/add-context.request.ts`

**Steps**:

1. Update AddContextRequest to support media:

```typescript
export class AddContextRequest {
    @ApiProperty({ description: 'Content type', enum: ['audio', 'transcript', 'summary', 'worknote', 'attachment'] })
    @IsString()
    @IsNotEmpty()
    type: string;

    @ApiPropertyOptional({ description: 'Text content (required for non-media types)' })
    @IsOptional()
    @IsString()
    content?: string;

    @ApiPropertyOptional({ description: 'Media URI (for audio, attachments)' })
    @IsOptional()
    @IsString()
    mediaUri?: string;

    @ApiPropertyOptional({ description: 'Structured metadata' })
    @IsOptional()
    structuredData?: Record<string, unknown>;

    @ApiProperty({ description: 'Content source', default: 'user' })
    @IsString()
    @IsOptional()
    source?: string = 'user';
}
```

2. Update addContext to handle media:

```typescript
async addContext(
    consultationId: string,
    dto: AddContextRequest,
): Promise<ContextItemResponse> {
    const consultation = await this.consultationRepository.findById(consultationId);
    if (!consultation) {
        throw new NotFoundException(`Consultation ${consultationId} not found`);
    }

    const mediaTypes = ['audio', 'attachment', 'image'];
    const isMediaType = mediaTypes.includes(dto.type);

    // Validate content or mediaUri based on type
    if (!isMediaType && !dto.content) {
        throw new BadRequestException('Content is required for non-media types');
    }
    if (isMediaType && !dto.mediaUri) {
        throw new BadRequestException('Media URI is required for media types');
    }

    const contextItem = ContextItemFactory.CreateContextItem({
        tenantId: consultation.tenantId,
        consultationId,
        type: dto.type,
        content: dto.content ?? null,
        mediaUri: dto.mediaUri ?? null,
        structuredData: dto.structuredData,
        source: dto.source ?? 'user',
        createdBy: this.requestUserId ?? undefined,
    });

    const saved = await this.contextItemRepository.create(contextItem);
    return ContextItemDtoMapper.toResponse(saved);
}
```

3. Commit
```bash
git add packages/applications/src/services/consultation/context/
git commit -m "$(cat <<'EOF'
feat(applications): add media support to ContextService

- Support mediaUri for audio/attachment types
- Validate content vs mediaUri based on type
EOF
)"
```

---

## Task 4.5: Add Application Layer Unit Tests

**Files**:
- Create: `packages/applications/src/services/department/__tests__/department.service.test.ts`
- Modify: `packages/applications/src/services/consultation/context/__tests__/context.service.test.ts`

**Steps**:

1. Create DepartmentService unit tests

2. Update ContextService tests for versioning and media

3. Run tests
```bash
cd packages/applications && pnpm test
# Expected: All tests pass
```

4. Commit
```bash
git add packages/applications/src/
git commit -m "test(applications): add/update unit tests for services"
```

---

## Task 4.6: Update Application Layer Exports

**Files**:
- Modify: `packages/applications/src/index.ts`

**Steps**:

1. Export new services and DTOs

2. Commit
```bash
git add packages/applications/src/index.ts
git commit -m "chore(applications): update exports"
```

---

# PLAN 5: API Layer Updates

## Overview

Update NestJS controllers and modules to expose new functionality.

---

## Task 5.1: Create DepartmentController

**Files**:
- Create: `apps/api/src/controllers/department/department.controller.ts`
- Create: `apps/api/src/controllers/department/department.module.ts`

**Steps**:

1. Create department controller:

```typescript
import {
    Controller,
    Get,
    Post,
    Param,
    Body,
    UseGuards,
    NotFoundException,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiBearerAuth,
    ApiResponse,
    ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../guards';
import {
    DepartmentService,
    DepartmentResponse,
    CreateDepartmentRequest,
} from '@arcaai/applications';

@ApiTags('Departments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('departments')
export class DepartmentController {
    constructor(private readonly departmentService: DepartmentService) {}

    @Get()
    @ApiOperation({ summary: 'Get all departments' })
    @ApiResponse({ status: 200, type: [DepartmentResponse] })
    async getAll(): Promise<DepartmentResponse[]> {
        return this.departmentService.getAll();
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get department by ID' })
    @ApiParam({ name: 'id', description: 'Department ID' })
    @ApiResponse({ status: 200, type: DepartmentResponse })
    @ApiResponse({ status: 404, description: 'Department not found' })
    async getById(@Param('id') id: string): Promise<DepartmentResponse> {
        const department = await this.departmentService.getById(id);
        if (!department) {
            throw new NotFoundException(`Department ${id} not found`);
        }
        return department;
    }

    @Get('code/:code')
    @ApiOperation({ summary: 'Get department by code' })
    @ApiParam({ name: 'code', description: 'Department code' })
    @ApiResponse({ status: 200, type: DepartmentResponse })
    async getByCode(@Param('code') code: string): Promise<DepartmentResponse> {
        const department = await this.departmentService.getByCode(code);
        if (!department) {
            throw new NotFoundException(`Department with code ${code} not found`);
        }
        return department;
    }

    @Post()
    @ApiOperation({ summary: 'Create department' })
    @ApiResponse({ status: 201, type: DepartmentResponse })
    async create(@Body() dto: CreateDepartmentRequest): Promise<DepartmentResponse> {
        return this.departmentService.create(dto);
    }
}
```

2. Create module:

```typescript
import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { DepartmentServiceModule } from '@arcaai/applications';
import { DepartmentController } from './department.controller';

@Module({
    imports: [CoreDatabaseModule, DepartmentServiceModule],
    controllers: [DepartmentController],
})
export class DepartmentModule {}
```

3. Commit
```bash
git add apps/api/src/controllers/department/
git commit -m "feat(api): add DepartmentController"
```

---

## Task 5.2: Update ConsultationController

**Files**:
- Modify: `apps/api/src/modules/consultation/consultation.controller.ts`

**Steps**:

1. Update open endpoint to use departmentId

2. Add endpoint for context version history:

```typescript
@Get(':id/context/:contextId/versions')
@ApiOperation({
    summary: 'Get context item version history',
    description: 'Returns all versions of a context item',
})
@ApiParam({ name: 'id', description: 'Consultation ID' })
@ApiParam({ name: 'contextId', description: 'Context item ID' })
@ApiResponse({
    status: 200,
    description: 'Version history',
    type: [ContextItemVersionResponse],
})
async getContextVersionHistory(
    @Param('id') id: string,
    @Param('contextId') contextId: string,
): Promise<ContextItemVersionResponse[]> {
    return this.contextService.getVersionHistory(contextId);
}
```

3. Commit
```bash
git add apps/api/src/modules/consultation/
git commit -m "$(cat <<'EOF'
feat(api): update ConsultationController

- Use departmentId instead of department string
- Add endpoint for context version history
EOF
)"
```

---

## Task 5.3: Update App Module

**Files**:
- Modify: `apps/api/src/app.module.ts`

**Steps**:

1. Import DepartmentModule

2. Commit
```bash
git add apps/api/src/app.module.ts
git commit -m "feat(api): register DepartmentModule"
```

---

## Task 5.4: Update E2E Tests

**Files**:
- Modify: `apps/api/tests/e2e/consultation.spec.ts`
- Create: `apps/api/tests/e2e/department.spec.ts`

**Steps**:

1. Update consultation tests for departmentId:

```typescript
test('should create consultation with departmentId', async ({ request }) => {
    const patientId = generatePatientId();
    const departmentId = '70000000-0000-0000-0000-000000000001'; // Seeded GEN department

    const response = await request.post('/api/consultations/open', {
        headers: apiKeyHeaders(),
        data: {
            patientId,
            departmentId,
        },
    });

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.departmentId).toBe(departmentId);
});
```

2. Add tests for context versioning:

```typescript
test('should create version on context update', async ({ request }) => {
    // Create consultation and context
    const patientId = generatePatientId();
    const createResponse = await request.post('/api/consultations/open', {
        headers: apiKeyHeaders(),
        data: { patientId },
    });
    const consultation = await createResponse.json();

    const contextResponse = await request.post(`/api/consultations/${consultation.id}/context`, {
        headers: apiKeyHeaders(),
        data: { type: 'worknote', content: 'Initial note' },
    });
    const context = await contextResponse.json();

    // Update context
    await request.patch(`/api/consultations/${consultation.id}/context/${context.id}`, {
        headers: apiKeyHeaders(),
        data: { content: 'Updated note', changeReason: 'correction' },
    });

    // Get version history
    const versionsResponse = await request.get(
        `/api/consultations/${consultation.id}/context/${context.id}/versions`,
        { headers: apiKeyHeaders() }
    );

    expect(versionsResponse.status()).toBe(200);
    const versions = await versionsResponse.json();
    expect(versions.length).toBeGreaterThanOrEqual(1);
});
```

3. Create department E2E tests

4. Run E2E tests
```bash
cd apps/api && pnpm test:e2e
# Expected: All tests pass
```

5. Commit
```bash
git add apps/api/tests/
git commit -m "test(api): update E2E tests for new features"
```

---

## Task 5.5: Update API Documentation

**Files**:
- Modify: `apps/api/docs/05-api-reference.md`

**Steps**:

1. Document new endpoints:
   - GET /departments
   - GET /departments/:id
   - GET /departments/code/:code
   - POST /departments
   - GET /consultations/:id/context/:contextId/versions

2. Update existing endpoint documentation for schema changes

3. Commit
```bash
git add apps/api/docs/
git commit -m "docs(api): update API reference for new endpoints"
```

---

## Execution Handoff

After all plans are complete, the implementation can be executed using:

### Option 1: Subagent-Driven (Current Session)
Use the `executing-plans` skill for automated execution with:
- Fresh agent per task
- Code review between tasks
- Quality gates

### Option 2: Manual Execution
Developer executes in separate environment:
- Read plan file
- Follow tasks sequentially
- Commit after each task
- Run tests between major sections

### Recommended Execution Order

1. **Plan 1** (Schema) - Must complete first
2. **Plan 2** (Infrastructure) - Can run in parallel with Plan 1 after Task 1.4
3. **Plan 3** (Domain) - After Plan 1 completes
4. **Plan 4** (Application) - After Plan 3 completes
5. **Plan 5** (API) - After Plan 4 completes

### Quality Gates

Between each plan:
1. Run `pnpm lint` to check for linting errors
2. Run `pnpm test` to verify unit tests pass
3. Run `pnpm build` to verify compilation
4. After Plan 5: Run `pnpm test:e2e` for integration tests
