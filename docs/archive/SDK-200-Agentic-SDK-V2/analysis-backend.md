# Backend API & Data Model - Detailed Analysis

## Overview

This document provides a comprehensive analysis of the backend API and data models to inform SDK v2 design and identify required backend changes.

---

## 1. Current Database Schema

### 1.1 Session Model (Primary Entity)

The `Session` model currently serves as the main entity for consultation data:

```prisma
model Session {
    id                String           @id @default(uuid(7))
    tenantId          String?
    sessionToken      String?
    sessionStatus     SessionStatus    // ACTIVE, PAUSED, EXPIRED, TERMINATED, SUSPENDED
    sessionType       SessionType      // WEB, MOBILE, API, MEDICAL_DEVICE, AGENTIC_SDK
    
    // Medical session metadata
    medicalSessionId  String?
    patientId         String?
    providerId        String?
    providerName      String?
    encryptedData     String?          // HIPAA compliance
    
    // AgenticSDK specific fields (JSONB)
    audioSessionData  Json?            // Audio capture session metadata
    transcriptData    Json?            // Transcript session data
    deviceCapabilities Json?           // Device capability information
    
    // Sync and recovery
    syncStatus        String?          @default("synced")
    offlineActions    Json?            // Queued offline actions
    recoveryData      Json?
    
    // Timestamps
    createdAt         DateTime         @default(now())
    updatedAt         DateTime         @updatedAt
    expiresAt         DateTime?
}
```

### 1.2 Supporting Models

| Model | Purpose | Notes |
|-------|---------|-------|
| `User` | User management | Multi-tenant, roles |
| `UserProfile` | User preferences | Settings, customization |
| `Tenant` | Multi-tenancy | Organization isolation |
| `ApiKey` | SDK authentication | Scoped, rate-limited |
| `AuditLog` | Audit trail | All operations logged |

---

## 2. Current API Endpoints

### 2.1 Session Controller

```
POST   /sessions                    # Create session
GET    /sessions/:id                # Get session by ID
PUT    /sessions/:id                # Update session
DELETE /sessions/:id                # Delete session
POST   /sessions/:id/validate       # Validate session state
POST   /sessions/:id/sync           # Sync session data
GET    /sessions/patient/:patientId # List by patient
GET    /sessions                    # List all (paginated)
GET    /sessions/tenants/:tenantId  # List by tenant
```

### 2.2 SMR Controller (Summarization)

```
POST   /smr/api/v1/summary/sync     # Synchronous summarization
POST   /smr/api/v1/summary/async    # Async summarization job
POST   /smr/api/v1/summary/feedback # Submit feedback
POST   /smr/api/v1/presummary       # Pre-visit summary
GET    /smr/api/v1/jobs/:jobId      # Job status
DELETE /smr/api/v1/jobs/:jobId      # Cancel job
GET    /smr/api/v1/jobs             # List jobs
GET    /smr/api/v1/models/info      # Model info
```

### 2.3 NLP Controller (NER)

```
GET    /nlp/health                  # Health check
POST   /nlp/classify/text           # Emotion classification
POST   /nlp/classify/tokens         # NER - Extract medical entities
POST   /nlp/correct                 # Spelling/terminology correction
POST   /nlp/suggest                 # Medical findings suggestions
```

### 2.4 STT Controller

```
GET    /stt/health                           # Health check
GET    /stt/sessions                         # List sessions
POST   /stt/start_session                    # Start transcription
POST   /stt/stop_session                     # Stop transcription
POST   /stt/audio/transcriptions             # Upload audio file
GET    /stt/audio/transcriptions/status/:id  # Task status
```

---

## 3. Service Layer Architecture

### 3.1 Domain-Driven Design

```
packages/domains/        → Entities, Factories, Mappers, Repositories
packages/applications/   → Services, DTOs, Service Modules
apps/api/               → Controllers, Guards, Interceptors
```

### 3.2 Session Service Pattern

```typescript
// packages/applications/src/services/sessionManagement/session/session.service.ts
async create(request: CreateSessionRequest): Promise<SessionEntity> {
    const newSession = SessionFactory.CreateSession({
        sessionToken: request.sessionToken,
        medicalSessionId: request.medicalSessionId,
        patientId: request.patientId,
        audioSessionData: request.audioSessionData,
        transcriptData: request.transcriptData,
        tenantId: this.requestUser?.tenantId || request.tenantId,
        createdBy: this.requestUser?.id,
    });
    
    const session = await this.sessionRepository.create(newSession);
    await this.broadcastSysEvent(SysEventType.ResourceCreated, {...});
    return session;
}
```

### 3.3 Key Patterns Used

| Pattern | Implementation | Notes |
|---------|----------------|-------|
| Repository | Domain repositories wrapping Prisma | Good separation |
| Factory | Entity factories for domain objects | Consistent creation |
| Mapper | DTO ↔ Entity mapping | Generated mappers |
| Events | EventEmitter2 + Kafka | Session lifecycle events |
| Change Tracking | Entity `setProperty()` | Audit trail support |

---

## 4. Authorization

### 4.1 Authentication Guards

| Guard | Purpose | Usage |
|-------|---------|-------|
| `ApiKeyGuard` | Validates X-API-Key header | SDK endpoints |
| `JwtAuthGuard` | Validates JWT bearer token | Admin/user endpoints |
| `OidcAuthGuard` | OIDC/SSO authentication | Enterprise SSO |
| `RolesGuard` | Role-based access | Combined with JWT |

### 4.2 API Key Validation

```typescript
// API key stored as hash with prefix
const apiKey = headers['x-api-key'];
const apiKeyEntity = await this.apiKeyService.getByKeyHash(providedKey);

if (apiKeyEntity.keyStatus !== ApiKeyStatus.ACTIVE) {
    throw new UnauthorizedException('API key is inactive');
}
```

### 4.3 Security Features

- API key hash storage with prefix identification
- Scopes array for permission control
- Rate limiting per API key
- IP whitelist support
- Usage tracking (`lastUsedAt`, `usageCount`)

---

## 5. Data Model Issues

### 5.1 Session Overloading

The Session model is overloaded with too many responsibilities:

| Current Field | Issue |
|---------------|-------|
| `audioSessionData: Json?` | Untyped, can't query |
| `transcriptData: Json?` | Untyped, can't query |
| `deviceCapabilities: Json?` | Untyped |
| `offlineActions: Json?` | Untyped |
| `recoveryData: Json?` | Untyped |

**JSONB sprawl** makes data hard to:
- Query efficiently
- Validate at DB level
- Migrate incrementally
- Index for search

### 5.2 Missing Entities

| Entity Needed | Current State | Impact |
|---------------|---------------|--------|
| `Consultation` | Conflated with Session | No proper consultation lifecycle |
| `Transcription` | JSONB in Session | Can't query transcript segments |
| `TranscriptionSegment` | None | No segment-level operations |
| `Summary` | Only in SMR service | Not integrated with main schema |
| `ContextItem` | Scattered JSONB | No structured context CRUD |
| `CaseNote` | None | Missing feature |
| `MedicalEntity` | Real-time only (NLP) | No persistence |

### 5.3 SMR Service Isolation

The SMR service maintains its own database with `medical_summaries` table:

```python
# SMR service (separate PostgreSQL DB)
medical_summaries:
  - id
  - session_id
  - summary_text
  - llm_provider
  - model_name
  - processing_time
  - created_at
```

**Issues:**
- Data duplication
- No foreign key relationships
- Separate migration management
- Harder to query across domains

---

## 6. Recommended Data Model

### 6.1 New Consultation Model

```prisma
model Consultation {
    id            String             @id @default(uuid(7))
    tenantId      String
    patientId     String?
    providerId    String?
    sessionId     String             @unique
    status        String             // Developer-defined, flexible
    department    String?
    visitType     String?            // new-visit, re-visit
    startedAt     DateTime
    endedAt       DateTime?
    metadata      Json?              @db.JsonB
    
    // Audit
    createdAt     DateTime           @default(now())
    updatedAt     DateTime           @updatedAt
    createdBy     String?
    updatedBy     String?
    
    // Relations
    Session       Session            @relation(fields: [sessionId], references: [id])
    Tenant        Tenant             @relation(fields: [tenantId], references: [id])
    ContextItems  ContextItem[]
    
    @@index([tenantId])
    @@index([patientId])
    @@index([providerId])
    @@index([status])
}
```

### 6.2 New ContextItem Model (Flexible)

```prisma
model ContextItem {
    id              String           @id @default(uuid(7))
    consultationId  String
    type            String           // Developer-defined: case_note, transcription, summary, etc.
    content         String           @db.Text
    structuredData  Json?            @db.JsonB
    source          String           // user, system, transcription, ai
    version         Int              @default(1)
    
    // Audit
    createdAt       DateTime         @default(now())
    updatedAt       DateTime         @updatedAt
    createdBy       String?
    
    // Relations
    Consultation    Consultation     @relation(fields: [consultationId], references: [id])
    Entities        MedicalEntity[]
    
    @@index([consultationId])
    @@index([type])
    @@index([source])
    @@index([createdAt])
}
```

### 6.3 New MedicalEntity Model

```prisma
model MedicalEntity {
    id              String           @id @default(uuid(7))
    contextItemId   String
    entityType      String           // DISEASE, SYMPTOM, MEDICATION, PROCEDURE, LAB_VALUE
    text            String           // Original text span
    normalizedText  String?          // Standardized term
    codes           Json?            @db.JsonB  // { icd10: [], snomed: [], rxnorm: [] }
    confidence      Float
    startOffset     Int
    endOffset       Int
    
    // Audit
    createdAt       DateTime         @default(now())
    
    // Relations
    ContextItem     ContextItem      @relation(fields: [contextItemId], references: [id])
    
    @@index([contextItemId])
    @@index([entityType])
}
```

---

## 7. Recommended API Endpoints

### 7.1 Consultation API

```
POST   /consultations                     # Create consultation
GET    /consultations/:id                 # Get consultation
PATCH  /consultations/:id                 # Update consultation (status, metadata)
DELETE /consultations/:id                 # End/archive consultation
GET    /consultations                     # List (with filters)
```

### 7.2 Context API

```
POST   /consultations/:id/context         # Add context item (any type)
GET    /consultations/:id/context         # List context items
       ?type=case_note,transcription      # Filter by type
       ?source=user,ai                    # Filter by source
       ?fromDate=&toDate=                 # Date range
PATCH  /consultations/:id/context/:itemId # Update context item
DELETE /consultations/:id/context/:itemId # Remove context item
```

### 7.3 Summary API

```
POST   /consultations/:id/summary         # Generate summary
       {
         transcription?: string,          # Optional override
         dnaStyleId?: string,             # DNA writing style
         template?: string,               # Summary template
         includeNER?: boolean             # Include entity extraction
       }
GET    /consultations/:id/summary/:id     # Get summary
PATCH  /consultations/:id/summary/:id     # Update summary (manual edits)
```

### 7.4 Entity API

```
GET    /consultations/:id/entities                    # All entities
GET    /consultations/:id/context/:itemId/entities    # Entities for context item
POST   /consultations/:id/entities/extract            # Re-extract entities
```

---

## 8. Migration Strategy

### 8.1 Phase 1: Add New Models

Add new models alongside existing Session model:

```sql
-- Migration: Add Consultation
CREATE TABLE "Consultation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT,
    "providerId" TEXT,
    "sessionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    ...
    CONSTRAINT "Consultation_pkey" PRIMARY KEY ("id")
);

-- Migration: Add ContextItem
CREATE TABLE "ContextItem" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    ...
    CONSTRAINT "ContextItem_pkey" PRIMARY KEY ("id")
);
```

### 8.2 Phase 2: Data Migration

Migrate existing Session JSONB data to new models:

```sql
-- Migrate transcriptData from Session to ContextItem
INSERT INTO "ContextItem" (id, consultationId, type, content, source, createdAt)
SELECT 
    gen_random_uuid(),
    c.id,
    'transcription',
    s."transcriptData"->>'fullText',
    'transcription',
    s."createdAt"
FROM "Session" s
JOIN "Consultation" c ON c."sessionId" = s.id
WHERE s."transcriptData" IS NOT NULL;
```

### 8.3 Phase 3: Integrate SMR

Add Summary to main schema, sync from SMR service:

```prisma
model Summary {
    id              String           @id @default(uuid(7))
    contextItemId   String           @unique
    llmProvider     String
    modelName       String
    processingTimeMs Int?
    
    ContextItem     ContextItem      @relation(fields: [contextItemId], references: [id])
}
```

### 8.4 Phase 4: Update SDK

Point SDK v2 to new consultation-centric APIs.

### 8.5 Phase 5: Deprecate Session JSONB

Remove JSONB fields from Session after migration verification.

---

## 9. What Works Well

| Aspect | Notes |
|--------|-------|
| **Multi-tenancy** | Well-implemented with `tenantId` on all entities |
| **Audit Trail** | Comprehensive with `createdBy`, `updatedBy`, timestamps |
| **API Key Auth** | Solid SDK authentication pattern |
| **Event Broadcasting** | Good Kafka integration for session events |
| **Domain Layer** | Clean separation with entities, factories, mappers |
| **Service Layer** | Good DI and dependency inversion |
| **WebSocket Support** | Real-time gateways for STT/TTS/NLP |

---

## 10. What Needs Improvement

| Aspect | Current | Recommendation |
|--------|---------|----------------|
| Session overloading | Medical data in JSONB | Dedicated Consultation model |
| Transcript storage | JSONB blob | Typed TranscriptionSegment model |
| Summary persistence | SMR service only | Integrate into main schema |
| Context management | None | Flexible ContextItem model |
| NER persistence | Real-time only | MedicalEntity model |
| API design | Session-centric | Consultation-centric |
| Type validation | At application layer | Add DB constraints |

---

## 11. Security Considerations

### 11.1 HIPAA Compliance

- `encryptedData` field for PHI
- Audit logging on all operations
- Multi-tenant isolation
- API key scoping

### 11.2 Data Access Control

```typescript
// Ensure tenant isolation
async findById(id: string): Promise<ConsultationEntity | null> {
    return this.repository.findFirst({
        where: {
            id,
            tenantId: this.requestUser?.tenantId, // Tenant check
            resourceStatus: { not: 'DELETED' }
        }
    });
}
```

### 11.3 Rate Limiting

```typescript
// API key usage tracking
await this.apiKeyService.incrementUsage(apiKeyId);

// Check rate limits
if (apiKey.usageCount > apiKey.rateLimit) {
    throw new TooManyRequestsException('Rate limit exceeded');
}
```
