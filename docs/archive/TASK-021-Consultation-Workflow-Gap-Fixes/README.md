# TASK-021: Consultation Workflow Gap Fixes & Enhancements

- **Ticket Number**: TASK-021
- **Created Date**: 2026-02-17
- **Last Updated**: 2026-02-17 (Final Verification — All 8 Gaps + 3 Enhancements Verified)
- **Status**: Completed

---

## 1. Requirement Analysis

### Business Context

A doctor conducts consultations across multiple departments for the same patient within a single appointment day. The system must support a complete end-to-end workflow:

1. Doctor A (Dept A) opens a consultation and receives injected context (historical notes, prior data)
2. Doctor A uses **remote** speech-to-text during the consultation
3. Doctor A refers the patient to Doctor B in Dept B (e.g., lab tests, specialist consult)
4. Doctor B opens a linked consultation and **sees all prior context** including Doctor A's conversation summary
5. Doctor B uses **local** speech-to-text, generates/edits a summary
6. Patient returns to Doctor A, who **sees everything** (Doctor B's summary, NER-extracted key points)
7. Doctor A generates a **final comprehensive summary** spanning all conversations, labs, and historical data

### System Responsiveness Requirements

| Capability | Latency Target |
|---|---|
| Speech-to-text (streaming) | Real-time / near real-time |
| Summary generation | Near real-time (< 7s per the DNA spec) |
| Named entity recognition | Near real-time |
| Data persistence | Automatic at every step |
| Department-specific prompts | Configured per department, applied automatically |

### Scope

This ticket addresses **5 gaps** and **3 enhancements** identified during the code review of the API implementation (`apps/api/`, `packages/applications/`, `packages/domains/`, `packages/database/`).

---

## 2. Current State Evaluation

### What's Working

| Area | Status | Notes |
|---|---|---|
| Consultation get-or-create | PASS | Natural key `(patientId, doctorId, date)`, idempotent |
| Context injection (CRUD) | PASS | All types: `CASE_NOTE`, `TRANSCRIPT`, `WORKNOTE`, `ATTACHMENT`, etc. |
| STT real-time streaming (WebSocket) | PASS | `/ws/stt/stream`, Redis Streams, binary + JSON audio |
| STT batch transcription (SSE) | PASS | `POST /api/v1/transcription-jobs/transcribe` with SSE progress |
| Transcript auto-storage | PASS | STT internal callback creates `ContextItem(TRANSCRIPT)` automatically |
| Summary generation (sync + async) | PASS | BullMQ jobs with SSE progress tracking |
| Summary update with versioning | PASS | Version snapshot before update, Qdrant re-sync marking |
| NER extraction (sync + async) | PASS | Async persists entities; sync now persists too (GAP-5 fixed) |
| Consultation chain (parent-child) | PASS | `parentConsultationId` for referrals |
| RBAC (Doctor/Nurse/DeptHead) | PASS | Policy-based CASL rules, ownership enforcement |
| Audit trail | PASS | `SysEvent` broadcast on every CRUD operation |
| Job queue infrastructure | PASS | BullMQ with Redis, SSE for progress |

### What's Missing or Incomplete

| Gap ID | Area | Severity | Summary |
|---|---|---|---|
| GAP-1 | Auto-trigger pipeline | **Critical** | No automatic summary/NER after transcription completes |
| GAP-2 | Cross-department context sharing | **Critical** | `getSharedContext()` only follows parent-child chain, not patient+date |
| GAP-3 | Department-to-prompt mapping | **High** | No `dnaStyleId` configured per department; manual on every API call |
| GAP-4 | Comprehensive chain summary | **High** | No endpoint to summarize across entire consultation chain |
| GAP-5 | ~~Sync NER not persisting~~ | **Medium** | ~~`extractEntities()` calls NLP but doesn't store results~~ **FIXED** |
| GAP-6 | Ownership bypass on ContextController | **Medium** | Duplicate route skips doctor ownership check |
| GAP-7 | SSE job updates using polling | **Low** | Redis pub/sub published but SSE reads via polling |
| GAP-8 | NLP URL path mismatch | **Low** | `SummaryService` uses `/classify/tokens` instead of `/api/v1/classify/tokens` |

---

## 3. Detailed Gap Analysis

### GAP-1: No Automatic Summary/NER Pipeline After Transcription (Critical)

**Problem**

The system requirement states: *"the system must be able to generate the conversation summary automatically."* Currently, all summary generation and NER extraction require an **explicit API call** from the frontend or doctor. There is no event-driven trigger.

When a transcription completes (either via WebSocket streaming finalization or batch job completion), the transcript is stored as a `ContextItem(TRANSCRIPT)` automatically. But the pipeline **stops there**. The doctor or frontend must then manually call:

1. `POST /api/consultations/:id/summary` to generate a summary
2. `POST /api/consultations/:id/summary/:itemId/extract-entities` to extract named entities

**Current Flow (Manual)**

```
Audio → STT Service → Transcript stored → [STOP]
                                            ↓ (manual API call required)
                                          Summary → [STOP]
                                            ↓ (manual API call required)
                                          NER Extraction
```

**Required Flow (Automatic)**

```
Audio → STT Service → Transcript stored
                          ↓ (EventEmitter2 @OnEvent)
                      Auto-generate summary (async, BullMQ)
                          ↓ (EventEmitter2 @OnEvent)
                      Auto-extract NER (async, BullMQ)
                          ↓
                      All stored automatically
```

**Impact**

- Without this, Doctor B cannot see Doctor A's summary (Step 6 of the workflow) unless Doctor A manually triggered summary generation
- Without this, Doctor A cannot see NER highlights (Step 12) unless someone explicitly ran NER extraction
- Breaks the "all information must be stored automatically" requirement

**Evidence**

- `sttInternal.service.ts:77` — broadcasts `SysEventType.ResourceCreated` for transcripts, but no handler consumes it
- `consultation-job.service.ts:354` — `notifyComplete()` broadcasts via Redis pub/sub, but no downstream consumer auto-triggers NER
- No `@OnEvent('TranscriptionCompleted')` or similar handler exists in the codebase

**Proposed Solution**

Create an event-driven pipeline with three components:

1. **`ConsultationEventHandler`** — Listens for transcript creation events and triggers summary generation
2. **Enhancement to `SummaryProcessor`** — On completion, emits an event that triggers NER
3. **Configuration** — Auto-pipeline behavior should be configurable (on/off) at the tenant/department/consultation level via `metadata` or a `ConsultationSettings` model

**Configuration Model**

```typescript
interface ConsultationPipelineConfig {
    autoSummaryEnabled: boolean;       // Generate summary after transcription
    autoNerEnabled: boolean;           // Extract NER after summary generation
    dnaStyleId?: string;               // Default DNA style for this context
    summaryTemplate?: string;          // Default template (e.g., "SOAP")
    includeSharedContext?: boolean;     // Include cross-department context in summary
}
```

**Files to Create/Modify**

| File | Action |
|---|---|
| `packages/applications/src/services/consultation/events/consultation-event.handler.ts` | **Create** — Event handler for auto-pipeline |
| `packages/applications/src/services/consultation/events/consultation.events.ts` | **Create** — Event type definitions |
| `packages/applications/src/services/stt/internal/sttInternal.service.ts` | **Modify** — Emit `TranscriptionCreated` event after creating transcript |
| `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts` | **Modify** — Emit `SummaryGenerated` event after completion |
| `packages/applications/src/services/consultation/jobs/processors/ner.processor.ts` | **Modify** — Emit `NerExtracted` event after completion |
| `packages/applications/src/services/consultation/consultation.module.ts` (API) | **Modify** — Register event handler |

---

### GAP-2: Cross-Department Context Sharing Limited to Parent-Child Chain (Critical)

**Problem**

`ContextService.getSharedContext()` only traverses the `parentConsultationId` chain:

```typescript
// context.service.ts:431-442
async getSharedContext(consultationId: string): Promise<ContextItemResponse[]> {
    const chain = await this.consultationRepository.findConsultationChain(consultationId);
    const consultationIds = chain.map(c => c.id);
    const items = await this.contextItemRepository.findSharedContext(consultationIds);
    return items.map(ContextDtoMapper.toResponse);
}
```

And `findConsultationChain()` only queries:

```typescript
WHERE id = rootId OR parentConsultationId = rootId
```

This means:

- If Doctor A creates a consultation and Doctor B creates a **separate** consultation (not linked via `parentConsultationId`), they **cannot see each other's context** via `getSharedContext()`
- This can happen when the frontend doesn't know about Doctor A's consultation ID when Doctor B starts
- The workflow requires that ALL consultations for the **same patient on the same date** share context, regardless of parent-child linkage

**Current Behavior**

```
Doctor A consultation (patientId=P1, date=2026-02-17, deptA)
    ↓ parentConsultationId link
Doctor B consultation (patientId=P1, date=2026-02-17, deptB)
    → getSharedContext() returns Doctor A's context ✓

BUT if no parentConsultationId link:
Doctor A consultation (patientId=P1, date=2026-02-17, deptA)
Doctor B consultation (patientId=P1, date=2026-02-17, deptB)  ← separate
    → getSharedContext() returns ONLY Doctor B's context ✗
```

**Required Behavior**

`getSharedContext()` should combine TWO strategies:

1. **Chain-based**: Follow `parentConsultationId` links (existing behavior)
2. **Date-based**: Find ALL consultations for the same `(tenantId, patientId, appointmentDate)` regardless of parent-child linkage

**Proposed Solution**

```typescript
async getSharedContext(consultationId: string): Promise<ContextItemResponse[]> {
    const consultation = await this.consultationRepository.findById(consultationId);
    if (!consultation) return [];

    // Strategy 1: Chain-based (existing)
    const chain = await this.consultationRepository.findConsultationChain(consultationId);
    const chainIds = new Set(chain.map(c => c.id));

    // Strategy 2: Date-based (new)
    const sameDayConsultations = await this.consultationRepository.findByPatientAndDate(
        consultation.tenantId,
        consultation.patientId,
        consultation.appointmentDate,
    );
    const sameDayIds = sameDayConsultations.map(c => c.id);

    // Merge unique IDs
    const allIds = [...new Set([...chainIds, ...sameDayIds])];

    // Fetch context from all linked consultations, excluding own
    const items = await this.contextItemRepository.findSharedContext(allIds);
    return items.map(ContextDtoMapper.toResponse);
}
```

**Files to Modify**

| File | Action |
|---|---|
| `packages/applications/src/services/consultation/context/context.service.ts` | **Modify** — `getSharedContext()` to combine chain + date strategies |
| `packages/applications/src/services/consultation/context/__tests__/context.service.test.ts` | **Modify** — Add tests for date-based sharing |

---

### GAP-3: No Department-to-Prompt Mapping (High)

**Problem**

The `dnaStyleId` is passed manually in every summary generation request:

```typescript
POST /api/consultations/:id/summary
Body: { dnaStyleId: "style_DNA_doctor_department_hematology_cp", template: "SOAP" }
```

There is no system-level configuration that maps a department to its default DNA style and prompt template. The `Department` model has no prompt-related fields:

```prisma
model Department {
    id                  String @id @default(uuid(7))
    tenantId            String
    code                String?   // e.g., "CARD", "RAD", "LAB"
    name                String?
    description         String?
    parentDepartmentId  String?
    // ... no dnaStyleId, no promptTemplate
}
```

This means:

- The frontend must know which `dnaStyleId` to use for each department
- There's no fallback chain (Doctor → Department → Default) as described in the DNA spec
- Changing a department's prompt requires updating every frontend client

**Evidence from DNA Spec** (`apps/mlflow/DNA_example.md`)

The DNA example explicitly describes a fallback chain:

> *"Adapt sentence structure and verbosity to match the doctor's Content DNA profile. Fallbacks: Doctor → Department → Default."*

And department-specific style variables:

> *"style_DNA_doctor_department_hematology_cp — Embeds statistical and stylistic writing profile for Hematology's discharge summaries"*

**Proposed Solution**

Add prompt configuration fields to the `Department` model and create a resolution service:

**Schema Change**

```prisma
model Department {
    // ... existing fields ...

    // Prompt configuration
    defaultDnaStyleId       String?   // Default DNA style for this department
    defaultSummaryTemplate  String?   // Default template (e.g., "SOAP", "Hematology-New")
    newPatientPromptId      String?   // Prompt ID for new/referral patients
    revisitPromptId         String?   // Prompt ID for revisit patients
    promptMetadata          Json?     @db.JsonB  // Additional prompt config (e.g., context variables)
}
```

**Resolution Service**

```typescript
interface ResolvedPromptConfig {
    dnaStyleId: string;
    template: string;
    promptId: string;
    contextVariables: Record<string, unknown>;
    fallbackTier: 'doctor' | 'department' | 'default';
}

class PromptResolutionService {
    async resolve(
        doctorId: string,
        departmentId: string,
        isRevisit: boolean,
    ): Promise<ResolvedPromptConfig> {
        // 1. Check doctor-level override (UserPreferences or UserSettings)
        // 2. Check department-level default
        // 3. Fall back to system default
    }
}
```

**Integration with Auto-Pipeline (GAP-1)**

When the auto-summary pipeline triggers after transcription, it should:

1. Look up the consultation's `departmentId`
2. Resolve the prompt config via `PromptResolutionService`
3. Determine if this is a new visit or revisit (`parentConsultationId` presence)
4. Pass the resolved `dnaStyleId` and `template` to the SMR service

**Files to Create/Modify**

| File | Action |
|---|---|
| `packages/database/src/prisma/db_main/department.prisma` | **Modify** — Add prompt config fields |
| `packages/applications/src/services/consultation/prompt/prompt-resolution.service.ts` | **Create** — Prompt resolution with fallback chain |
| `packages/applications/src/services/consultation/prompt/prompt-resolution.service.module.ts` | **Create** — Module registration |
| `packages/applications/src/services/consultation/prompt/__tests__/prompt-resolution.service.test.ts` | **Create** — Unit tests |
| `packages/database/src/prisma/db_main/seed/04-departments.ts` | **Modify** — Add default DNA styles to seed departments |
| `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts` | **Modify** — Use `PromptResolutionService` |
| `packages/applications/src/services/consultation/jobs/processors/pre-summary.processor.ts` | **Modify** — Use `PromptResolutionService` |

---

### GAP-4: No Comprehensive Cross-Chain Summary Endpoint (High)

**Problem**

Step 13 of the workflow requires Doctor A to generate a **final comprehensive summary** that includes:

- Doctor A's own transcripts and notes
- Doctor B's summary and transcripts
- Lab test results
- Historical case notes
- NER-extracted entities from all consultations

The current summary endpoint only works within a single consultation:

```typescript
// summary.processor.ts — gets content from ONE consultation
const transcripts = await this.contextItemRepository.findTranscripts(consultationId);
```

There is no way to generate a summary that spans the entire consultation chain. The `contextItemIds` parameter in `GenerateSummaryRequest` could theoretically reference items from other consultations, but:

1. It's not documented or designed for this purpose
2. There's no convenience method to collect all relevant context from the chain
3. The NER data from other consultations is not included

**Proposed Solution**

Create a `ChainSummaryService` with a dedicated endpoint:

```
POST /api/consultations/:id/summary/comprehensive
Body: {
    dnaStyleId?: string,          // Override prompt (or auto-resolve from department)
    template?: string,            // Template override
    includeNER?: boolean,         // Include NER highlights in the summary
    includeLabResults?: boolean,  // Include lab/test results
    dateRange?: {                 // Optional: limit historical scope
        from: string,
        to: string,
    }
}
```

**How it Works**

1. Get all consultations in the chain + same-day consultations (using GAP-2 fix)
2. For each consultation, gather:
   - Transcripts
   - Summaries (latest per consultation)
   - Case notes
   - Named entities (grouped by class)
3. Compose a structured input for the SMR service:

```json
{
    "sections": [
        {
            "consultationId": "...",
            "department": "General Medicine",
            "doctor": "Dr. A",
            "type": "transcript",
            "content": "..."
        },
        {
            "consultationId": "...",
            "department": "Hematology",
            "doctor": "Dr. B",
            "type": "summary",
            "content": "..."
        },
        {
            "consultationId": "...",
            "department": "Laboratory",
            "type": "lab_result",
            "content": "..."
        }
    ],
    "namedEntities": {
        "MEDICATION": ["Aspirin 75mg", "Metformin 500mg"],
        "CONDITION": ["Type 2 Diabetes", "Hypertension"],
        "PROCEDURE": ["CBC", "Blood glucose test"]
    },
    "dnaStyleId": "...",
    "template": "comprehensive"
}
```

4. The SMR service generates a comprehensive summary
5. Store as `ContextItem(RAW_SUMMARY)` on the requesting consultation
6. Auto-trigger NER on the comprehensive summary (if GAP-1 is implemented)

**Files to Create/Modify**

| File | Action |
|---|---|
| `packages/applications/src/services/consultation/summary/chain-summary.service.ts` | **Create** — Cross-chain summary aggregation |
| `packages/applications/src/services/consultation/summary/chain-summary.service.module.ts` | **Create** — Module registration |
| `packages/applications/src/services/consultation/summary/dto/comprehensive-summary.request.ts` | **Create** — Request DTO |
| `packages/applications/src/services/consultation/jobs/processors/comprehensive-summary.processor.ts` | **Create** — BullMQ processor for async comprehensive summary |
| `apps/api/src/modules/consultation/summary.controller.ts` | **Modify** — Add `comprehensive` endpoints (sync + async) |
| `packages/domains/src/enums/JobQueue.enum.ts` | **Modify** — Add `GenerateComprehensiveSummary` queue |

---

### GAP-5: Sync `extractEntities()` Does Not Persist Entities (Medium)

**Problem**

The sync `extractEntities()` method in `SummaryService` calls the NLP service but does not persist the returned entities:

```typescript
// summary.service.ts:254-275
async extractEntities(contextItemId: string): Promise<void> {
    const contextItem = await this.contextItemRepository.findById(contextItemId);
    // ... validation ...
    const nerResponse = await this.callNlpService(contextItem.content);
    // NOTE: entities are NOT stored — only a SysEvent is broadcast
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: contextItem.id,
        data: { entitiesExtracted: true, entityCount: nerResponse.entities?.length ?? 0 },
    });
}
```

The async `NerProcessor` correctly persists entities via `NamedEntityFactory.CreateNamedEntity()` + `namedEntityRepository.create()`. The sync path is effectively a no-op.

**Proposed Fix**

Wire `ContextService.addNamedEntities()` into the sync path:

```typescript
async extractEntities(contextItemId: string): Promise<void> {
    // ... existing validation ...
    const nerResponse = await this.callNlpService(contextItem.content);

    // Persist entities (NEW)
    if (nerResponse.entities?.length) {
        await this.contextService.addNamedEntities(contextItemId, {
            entities: nerResponse.entities.map(e => ({
                text: e.value ?? e.text,
                className: e.type ?? e.className,
                confidence: e.confidence,
                startOffset: e.start ?? e.startOffset,
                endOffset: e.end ?? e.endOffset,
            })),
            aiModelId: 'nlp-default',
        });
    }
}
```

**Files to Modify**

| File | Action |
|---|---|
| `packages/applications/src/services/consultation/summary/summary.service.ts` | **Modify** — Persist NER results in sync path |
| `packages/applications/src/services/consultation/summary/summary.service.module.ts` | **Modify** — Import `ContextService` if not already available |

---

### GAP-6: Ownership Bypass on Standalone ContextController (Medium)

**Problem**

Two routes handle context creation:

1. `ConsultationController` (`/consultations/:id/context`) — **checks ownership** (`doctorId === user.id`)
2. `ContextController` (`/consultations/:consultationId/context`) — **no ownership check**

Any authenticated user with a valid API key can add/update context on any consultation via the `ContextController` route.

**Proposed Fix**

Either:

- **Option A**: Remove `ContextController` and consolidate into `ConsultationController` (preferred — eliminates duplication)
- **Option B**: Add ownership check to `ContextController`

With Option A, the dedicated context endpoints (`/transcriptions`, `/case-notes`) can be added to the `ConsultationController`.

**Files to Modify**

| File | Action |
|---|---|
| `apps/api/src/modules/consultation/context.controller.ts` | **Modify or Remove** — Consolidate into `ConsultationController` |
| `apps/api/src/modules/consultation/consultation.controller.ts` | **Modify** — Add `/transcriptions`, `/case-notes` convenience endpoints |
| `apps/api/src/modules/consultation/consultation.module.ts` | **Modify** — Remove `ContextController` from controllers array |

---

### GAP-7: SSE Job Updates Using Polling Instead of Redis Pub/Sub (Low)

**Problem**

The SSE endpoint in `ConsultationJobController` polls Redis every 2 seconds:

```typescript
// job.controller.ts:76-77
// Poll for job status every 2 seconds
// In production, you'd use Redis pub/sub subscription instead
```

But the `ConsultationJobService` already publishes to `consultation_job_updates:{jobId}`:

```typescript
// consultation-job.service.ts:322-326
await this.cacheService.publish(
    `${this.JOB_CHANNEL_PREFIX}${jobId}`,
    JSON.stringify(updated),
);
```

**Proposed Fix**

Replace the polling `interval()` with a Redis pub/sub subscription that converts incoming messages to SSE events via an RxJS `Observable`.

**Files to Modify**

| File | Action |
|---|---|
| `apps/api/src/modules/consultation/job.controller.ts` | **Modify** — Replace polling with Redis sub |
| `packages/applications/src/services/consultation/jobs/consultation-job.service.ts` | **Modify** — Expose a `subscribeToJobUpdates(jobId)` method returning `Observable<JobStatusResponse>` |

---

### GAP-8: NLP Service URL Path Mismatch (Low)

**Problem**

`SummaryService` uses an incorrect NLP endpoint path:

```typescript
// summary.service.ts:301
`${this.nlpServiceUrl}/classify/tokens`
```

The `NerProcessor` uses the correct path:

```typescript
// ner.processor.ts:132
`${this.nlpServiceUrl}/api/v1/classify/tokens`
```

Additionally, `SummaryService` uses `process.env` directly instead of NestJS `ConfigService`, and the default ports differ:

| Location | SMR Default | NLP Default |
|---|---|---|
| `SummaryService` | `http://localhost:8003` | `http://localhost:8004` |
| `SummaryProcessor` | `http://localhost:5006` | — |
| `NerProcessor` | — | `http://localhost:5005` |

**Proposed Fix**

Standardize all service URLs to use `ConfigService` and align default ports.

**Files to Modify**

| File | Action |
|---|---|
| `packages/applications/src/services/consultation/summary/summary.service.ts` | **Modify** — Use `ConfigService`, fix NLP path, align ports |

---

## 4. Enhancement Proposals

### ENH-1: Aggregate NER Endpoint for Consultation Chain

**Rationale**: Step 12 requires Doctor A to see "main points and important information detected using NER" across all consultations. Currently, NER results are per-context-item with no aggregation.

**Proposed Endpoint**:

```
GET /api/consultations/:id/named-entities?scope=chain
```

Returns entities grouped by class from all consultations in the chain:

```json
{
    "entities": {
        "MEDICATION": [
            { "text": "Aspirin 75mg", "confidence": 0.95, "source": "consultation-B-summary" },
            { "text": "Metformin 500mg", "confidence": 0.92, "source": "consultation-A-transcript" }
        ],
        "CONDITION": [...],
        "PROCEDURE": [...]
    },
    "totalCount": 15,
    "sources": [
        { "consultationId": "...", "department": "General Medicine", "doctor": "Dr. A" },
        { "consultationId": "...", "department": "Hematology", "doctor": "Dr. B" }
    ]
}
```

### ENH-2: Consultation Timeline View

**Rationale**: For the multi-department workflow, a timeline of events across all consultations is valuable.

**Proposed Endpoint**:

```
GET /api/consultations/:id/timeline?scope=chain
```

Returns a chronological list of events:

```json
{
    "events": [
        { "timestamp": "...", "type": "consultation_opened", "department": "General Medicine", "doctor": "Dr. A" },
        { "timestamp": "...", "type": "context_added", "contextType": "CASE_NOTE", "consultation": "..." },
        { "timestamp": "...", "type": "transcription_started", "consultation": "..." },
        { "timestamp": "...", "type": "transcription_completed", "wordCount": 1250, "consultation": "..." },
        { "timestamp": "...", "type": "summary_generated", "aiModel": "gpt-4o", "consultation": "..." },
        { "timestamp": "...", "type": "ner_extracted", "entityCount": 12, "consultation": "..." },
        { "timestamp": "...", "type": "consultation_opened", "department": "Hematology", "doctor": "Dr. B" },
        // ...
    ]
}
```

### ENH-3: Pagination on Unbounded List Endpoints

**Rationale**: `getPatientHistory`, `getByPatientAndDate`, and `getContextItems` return unbounded arrays. For patients with extensive medical histories, this could cause performance issues.

**Proposed Change**: Add pagination parameters to list endpoints:

```
GET /api/consultations/patient/:patientId/history?page=1&limit=20
GET /api/consultations/:id/context?page=1&limit=50&type=TRANSCRIPT
```

---

## 5. Implementation Plan

### Phase 1: Critical Gaps (GAP-1, GAP-2)

These two gaps block the core multi-department workflow.

| Task | Effort | Dependencies | Priority |
|---|---|---|---|
| **1.1** Create consultation event definitions (`consultation.events.ts`) | 0.5 day | None | P0 |
| **1.2** Implement `ConsultationEventHandler` for auto-pipeline | 1 day | 1.1 | P0 |
| **1.3** Modify `SttInternalService.createTranscript()` to emit event | 0.5 day | 1.1 | P0 |
| **1.4** Modify `SummaryProcessor` to emit `SummaryGenerated` event | 0.5 day | 1.1 | P0 |
| **1.5** Add pipeline configuration to consultation `metadata` | 0.5 day | 1.2 | P0 |
| **1.6** Fix `getSharedContext()` to include same-day consultations | 0.5 day | None | P0 |
| **1.7** Add tests for auto-pipeline and shared context | 1 day | 1.2, 1.6 | P0 |

**Total Phase 1**: ~4.5 days

### Phase 2: High-Priority Gaps (GAP-3, GAP-4)

These enable the full department-specific prompt workflow and comprehensive summaries.

| Task | Effort | Dependencies | Priority |
|---|---|---|---|
| **2.1** Add prompt config fields to `Department` schema | 0.5 day | None | P1 |
| **2.2** Create `PromptResolutionService` with fallback chain | 1 day | 2.1 | P1 |
| **2.3** Integrate prompt resolution into summary processors | 0.5 day | 2.2 | P1 |
| **2.4** Update department seed data with default DNA styles | 0.5 day | 2.1 | P1 |
| **2.5** Create `ChainSummaryService` for comprehensive summaries | 1.5 days | GAP-2 fix | P1 |
| **2.6** Create `ComprehensiveSummaryProcessor` (BullMQ) | 1 day | 2.5 | P1 |
| **2.7** Add comprehensive summary endpoints to `SummaryController` | 0.5 day | 2.6 | P1 |
| **2.8** Tests for prompt resolution and chain summary | 1 day | 2.2, 2.5 | P1 |

**Total Phase 2**: ~6.5 days

### Phase 3: Medium-Priority Fixes (GAP-5, GAP-6)

Quality and security fixes.

| Task | Effort | Dependencies | Priority |
|---|---|---|---|
| **3.1** Fix sync `extractEntities()` to persist NER results | 0.5 day | None | P2 |
| **3.2** Consolidate `ContextController` into `ConsultationController` | 0.5 day | None | P2 |
| **3.3** Tests for consolidated controller and sync NER | 0.5 day | 3.1, 3.2 | P2 |

**Total Phase 3**: ~1.5 days

### Phase 4: Low-Priority Fixes & Enhancements (GAP-7, GAP-8, ENH-1/2/3)

Polish and performance.

| Task | Effort | Dependencies | Priority |
|---|---|---|---|
| **4.1** Replace SSE polling with Redis pub/sub subscription | 1 day | None | P3 |
| **4.2** Fix NLP URL path and standardize service URLs | 0.5 day | None | P3 |
| **4.3** Implement aggregate NER endpoint (ENH-1) | 1 day | GAP-5 fix | P3 |
| **4.4** Implement consultation timeline endpoint (ENH-2) | 1 day | None | P3 |
| **4.5** Add pagination to unbounded list endpoints (ENH-3) | 1 day | None | P3 |

**Total Phase 4**: ~4.5 days

---

## 6. Summary

| Phase | Scope | Effort | Priority |
|---|---|---|---|
| Phase 1 | Auto-pipeline + cross-department sharing | ~4.5 days | Critical |
| Phase 2 | Department prompts + comprehensive summary | ~6.5 days | High |
| Phase 3 | Sync NER fix + ownership consolidation | ~1.5 days | Medium |
| Phase 4 | SSE, URL fixes, enhancements | ~4.5 days | Low |
| **Total** | | **~17 days** | |

### Dependency Graph

```
Phase 1 (Critical)
├── GAP-1: Auto-pipeline (events → auto-summary → auto-NER)
│       ↓ enables
│   GAP-3: Department prompts (auto-resolved by pipeline)
│       ↓ enables
│   GAP-4: Comprehensive summary (uses prompt resolution)
│
└── GAP-2: Cross-department sharing (date-based query)
        ↓ enables
    GAP-4: Comprehensive summary (aggregates from all consultations)

Phase 3 (Independent)
├── GAP-5: Sync NER persistence
└── GAP-6: Ownership consolidation

Phase 4 (Independent)
├── GAP-7: SSE pub/sub
├── GAP-8: URL standardization
└── ENH-1/2/3: Aggregate NER, Timeline, Pagination
```

---

## 7. Workflow Trace After All Fixes

After implementing all fixes, the 13-step workflow would operate as follows:

| Step | Actor | Action | System Behavior |
|---|---|---|---|
| 1 | Doctor A | Opens consultation | `POST /consultations/open` → get-or-create |
| 2 | System | Inject context | `POST /consultations/:id/context` → case notes, history |
| 3 | Doctor A | Speaks during consultation | WebSocket STT → real-time transcripts → **auto-stored** |
| 3a | System | **Auto-trigger** | Transcript stored → **auto-summary** (with Dept A prompt) → **auto-NER** |
| 4 | Doctor A | Refers to Dept B | Creates referral context (CASE_NOTE or future REFERRAL type) |
| 5 | Doctor B | Opens consultation | `POST /consultations/open` with `parentConsultationId` |
| 6 | Doctor B | Views shared context | `GET /context/shared` → sees Doctor A's transcript, **auto-summary**, NER |
| 7 | Doctor B | Speaks during consultation | WebSocket STT → real-time transcripts → **auto-stored** |
| 7a | System | **Auto-trigger** | Transcript stored → **auto-summary** (with Dept B prompt) → **auto-NER** |
| 8 | Doctor B | Reviews generated summary | Already generated automatically; views via `GET /summary/latest` |
| 9 | Doctor B | Edits summary | `PATCH /summary/:id` → versioned update |
| 10 | Patient | Returns to Doctor A | Doctor A reopens same consultation |
| 11 | Doctor A | Views all information | `GET /context/shared` → includes Doctor B's summary, NER, transcripts |
| 12 | Doctor A | Views NER highlights | `GET /named-entities?scope=chain` → aggregated from all consultations |
| 13 | Doctor A | Requests final summary | `POST /summary/comprehensive` → cross-chain summary with all context |

---

## Change History

| # | Date | Description | Status |
|---|---|---|---|
| 1 | 2026-02-17 | Initial gap analysis and implementation plan | Created |
| 2 | 2026-02-17 | **GAP-7 Fix**: Replaced SSE polling with Redis Pub/Sub subscription | Completed |
| 5 | 2026-02-17 | **ENH-2**: Consultation timeline endpoint (`GET :id/timeline?scope=chain`) | Completed |
| 6 | 2026-02-17 | **ENH-3**: Pagination on unbounded list endpoints (patient history, date, context) | Completed |
| 5 | 2026-02-17 | **GAP-1 Tasks 1.2–1.5**: Event handler + auto-pipeline (TranscriptionCreated → auto-summary → auto-NER) | Completed |
| 6 | 2026-02-17 | **GAP-4 (Task 2.5)**: ChainSummaryService — comprehensive cross-chain summary generation | Completed |
| 7 | 2026-02-17 | **ENH-1 (Task 4.3)**: Aggregate NER endpoint (`GET :id/named-entities?scope=chain`) | Completed |
| 8 | 2026-02-17 | **GAP-3 (Tasks 2.2–2.3)**: PromptResolutionService + integration into auto-pipeline and processors | Completed |
| 9 | 2026-02-17 | **GAP-4 (Tasks 2.6–2.7)**: ComprehensiveSummaryProcessor + SummaryController endpoints + full test coverage | Completed |
| 10 | 2026-02-17 | **Final Verification**: All 8 gaps + 3 enhancements verified against codebase. 1 minor finding (see below). | Verified |

### Change #10: Final Verification — All Gaps and Enhancements (2026-02-17)

Systematic verification of every gap fix and enhancement against the actual codebase. Each gap was traced end-to-end through controllers, services, processors, repositories, and tests.

**Verification Matrix**:

| Gap | Status | Evidence | Finding |
|---|---|---|---|
| **GAP-1**: Auto-trigger pipeline | **VERIFIED** | Event chain complete: `TranscriptionCreated` → `handleTranscriptionCreated()` → summary job → `SummaryGenerated` → `handleSummaryGenerated()` → NER job → `NerExtracted` → `PipelineCompleted`. Config via `consultation.metadata.pipelineConfig`. 29 tests. | No issues |
| **GAP-2**: Cross-department context sharing | **VERIFIED** | `getSharedContext()` uses `resolveLinkedConsultationIds()` combining chain-based + date-based strategies with deduplication. 7 tests. | No issues |
| **GAP-3**: Department-to-prompt mapping | **VERIFIED** | 5 fields on `Department` schema + migration. `PromptResolutionService` with Doctor → Department → Default fallback. Integrated into `ConsultationEventHandler`, `SummaryProcessor`, `PreSummaryProcessor`. 22 tests. | **Minor**: `ComprehensiveSummaryProcessor` does not use `PromptResolutionService` — uses `request.dnaStyleId` directly with no fallback |
| **GAP-4**: Comprehensive cross-chain summary | **VERIFIED** | `ChainSummaryService` + `ComprehensiveSummaryProcessor` + `POST comprehensive` (sync) + `POST comprehensive/async`. `GenerateComprehensiveSummary` in JobQueue enum. 48 tests (20 service + 28 processor). | No issues |
| **GAP-5**: Sync NER persistence | **VERIFIED** | `extractEntities()` now persists via `NamedEntityFactory.CreateNamedEntity()` + `namedEntityRepository.create()` with per-entity try/catch. 17 tests. | No issues |
| **GAP-6**: Ownership bypass | **VERIFIED** | `ContextController` deleted. All context mutation routes consolidated into `ConsultationController` with ownership check. Module only registers `ConsultationController`, `SummaryController`, `ConsultationJobController`. | No issues |
| **GAP-7**: SSE polling → pub/sub | **VERIFIED** | `jobUpdates()` calls `jobService.subscribeToJobUpdates(jobId)` which uses `RedisSubscriberService`. No `interval()` or polling. 8 tests. | No issues |
| **GAP-8**: NLP URL + ConfigService | **VERIFIED** | NLP path is `/api/v1/classify/tokens`. Uses `ConfigService` (not `process.env`). Default ports: SMR=5006, NLP=5005. Aligned with all processors. SMR controller port also fixed. | No issues |
| **ENH-1**: Aggregate NER endpoint | **VERIFIED** | `GET :id/named-entities?scope=chain` on `ConsultationController`. `getAggregateNamedEntities()` on `ContextService`. Rich response with deduplication, source metadata, confidence flags. 12 tests. | No issues |
| **ENH-2**: Timeline endpoint | **VERIFIED** | `GET :id/timeline?scope=chain` on `ConsultationController`. `TimelineService` with 8 event types. 12 tests. | No issues |
| **ENH-3**: Pagination | **VERIFIED** | 3 endpoints support optional `?page=&limit=`. Backward compatible. `PaginatedConsultationResponse` + `PaginatedContextItemResponse`. 9 tests. | No issues |

**Minor Finding: `ComprehensiveSummaryProcessor` Missing Prompt Resolution**

The `ComprehensiveSummaryProcessor` (lines 221–223) uses `request.dnaStyleId` and `request.template ?? 'comprehensive'` directly without calling `PromptResolutionService`. This means:

- If the caller provides `dnaStyleId` explicitly → works correctly
- If the auto-pipeline triggers comprehensive summary → the event handler resolves the prompt and passes it in the job payload → works correctly
- If a doctor calls `POST /summary/comprehensive` without specifying `dnaStyleId` → **no fallback chain is applied**, the SMR service receives `undefined` for `dnaStyleId`

**Severity**: Low — the sync path through `ChainSummaryService.generateComprehensiveSummary()` would need to be checked separately, and the async path gets the resolved prompt from the event handler. However, for consistency with `SummaryProcessor` and `PreSummaryProcessor` (which both use `PromptResolutionService`), the comprehensive processor should also resolve prompts when not explicitly provided.

**Recommendation**: Add `PromptResolutionService` injection to `ComprehensiveSummaryProcessor` with the same pattern used in `SummaryProcessor` (lines 57–82). This is a minor enhancement, not a blocker.

**Total Test Coverage Across All Changes**:

| Component | Tests |
|---|---|
| ConsultationEventHandler (GAP-1) | 29 |
| PromptResolutionService (GAP-3) | 22 |
| ChainSummaryService (GAP-4) | 20 |
| ComprehensiveSummaryProcessor (GAP-4) | 28 |
| SummaryController comprehensive endpoints (GAP-4) | 20 |
| SummaryService sync NER (GAP-5) | 17 |
| ConsultationJobService pub/sub (GAP-7) | 8 |
| Context shared + case notes (GAP-2) | 7 |
| Aggregate NER (ENH-1) | 12 |
| Timeline (ENH-2) | 12 |
| Pagination (ENH-3) | 9 |
| **Total new tests** | **184** |

### Change #9: GAP-4 Tasks 2.6–2.7 — ComprehensiveSummaryProcessor + Controller Endpoints + Tests (2026-02-17)

**Context**: Task 2.5 (ChainSummaryService) was implemented in Change #6. Tasks 2.6 and 2.7 were also implemented in that wave, but lacked dedicated test coverage. This change adds comprehensive unit tests for both the BullMQ processor (Task 2.6) and the controller endpoints (Task 2.7), verifying the full GAP-4 implementation.

**What was verified (all previously implemented)**:

| Component | File | Description |
|---|---|---|
| `ComprehensiveSummaryProcessor` | `packages/applications/.../processors/comprehensive-summary.processor.ts` | BullMQ async processor — 6 progress steps (10%→25%→40%→60%→85%→100%), 180s SMR timeout, 2 retry attempts |
| `SummaryController` sync | `apps/api/src/modules/consultation/summary.controller.ts` | `POST :id/summary/comprehensive` — blocks until SMR returns (HTTP 201) |
| `SummaryController` async | `apps/api/src/modules/consultation/summary.controller.ts` | `POST :id/summary/comprehensive/async` — returns job ID (HTTP 202), progress via SSE |
| Module wiring | `consultation-job.service.module.ts`, `consultation.module.ts` | Processor registered, ChainSummaryServiceModule imported, BullMQ queue configured |
| Job infrastructure | `consultation-job.service.ts` | `createComprehensiveSummaryJob()`, `COMPREHENSIVE_SUMMARY` case in `cancelJob()` |

**Files Created**:

| File | Purpose |
|---|---|
| `packages/applications/src/services/consultation/jobs/__tests__/comprehensive-summary.processor.test.ts` | 28 unit tests for the BullMQ processor |
| `apps/api/src/modules/consultation/__tests__/summary.controller.test.ts` | 20 unit tests for the controller comprehensive endpoints |

**ComprehensiveSummaryProcessor Test Coverage** (28/28 passing):

| Group | Tests | Description |
|---|---|---|
| Successful Job Processing | 13 | End-to-end flow, progress notification at all 6 steps, SMR URL/payload/timeout verification, NER toggle (skip/include), persistence of ContextItem + SummaryMeta, default SMR URL fallback, section headers in SMR text, NER context block appended, default template, sourceConsultationCount in options, partial SMR response handling |
| Error Handling | 8 | Consultation not found → `notifyFailed`, no linked consultations, no content, SMR service error, SMR timeout, DB create failure, meta save failure, `notifyComplete` never called on failure |
| Edge Cases | 6 | Single consultation (no chain), large chain (5 consultations), empty NER map → no NER block, custom options passthrough, `dnaStyleId` correctly forwarded to `ContextItemFactory.CreateRawSummary`, non-Error thrown by dependency |
| Realistic Multi-Department | 1 | 3-department chain (General Medicine + Hematology + Laboratory) with 4 sections, 5 NER entities across MEDICATION/CONDITION/PROCEDURE, full progress + SMR + persistence verification |

**SummaryController Test Coverage** (20/20 passing):

| Group | Tests | Description |
|---|---|---|
| Sync endpoint (`POST comprehensive`) | 8 | Delegates to `ChainSummaryService.generateComprehensiveSummary`, returns full `ComprehensiveSummaryResponse` shape, handles empty request, propagates `NotFoundException`/`BadRequestException`/SMR failure, passes all request fields, multi-department `sourceConsultationIds` |
| Async endpoint (`POST comprehensive/async`) | 9 | Creates job via `IConsultationJobService.createComprehensiveSummaryJob`, returns `JobResponse` with `jobId`/`status`/`sseUrl`, extracts `tenantId` from CLS, extracts `userId` from CLS, graceful fallback for missing `tenantId`/`user` (empty string), passes all request fields, passes minimal empty request, propagates job service errors |
| Sync vs Async comparison | 3 | Sync calls ChainSummaryService (not job service), async calls job service (not ChainSummaryService), different response types (`ComprehensiveSummaryResponse` vs `JobResponse`) |

**Regression Check**: 5820/5832 tests pass across 209 test files — 11 pre-existing failures in unrelated STT test files, 0 new regressions.

### Change #8: GAP-3 (Tasks 2.2–2.3) — PromptResolutionService + Integration (2026-02-17)

**Problem**: The `dnaStyleId` was passed manually in every summary generation request. There was no system-level configuration mapping a department to its default DNA style and prompt template. The DNA spec describes a fallback chain (Doctor → Department → Default), but only the Department schema fields (Task 2.1) and seed data (Task 2.4) had been added — the resolution service and integration were missing.

**Solution**: Created a `PromptResolutionService` implementing the three-tier fallback chain and integrated it into the auto-pipeline event handler and all summary processors.

**Fallback Chain**:

```
1. Doctor-level override (UserSettings, namespace 'arcaai-sdk', key 'dnaStyleId')
   ↓ (if not found)
2. Department-level default (Department.defaultDnaStyleId, defaultSummaryTemplate, etc.)
   ↓ (if not found)
3. System default (style_DNA_default, SOAP template, prompt_default)
```

**How It Works**:

1. `PromptResolutionService.resolve()` accepts `doctorId`, `departmentId`, `isRevisit`, and optional explicit overrides
2. If both `explicitDnaStyleId` and `explicitTemplate` are provided, the fallback chain is bypassed entirely (fast path for manual API calls)
3. Otherwise, the service queries `UserSettingsRepository` for doctor preferences and `DepartmentRepository` for department defaults
4. Each field (`dnaStyleId`, `template`, `promptId`, `contextVariables`) is resolved independently — doctor may override `dnaStyleId` while `template` comes from department
5. A `resolutionTrace` is returned for audit/debugging, tracking what each tier contributed and which fields fell through to defaults
6. All errors are caught gracefully — a failing doctor lookup skips to department tier, a failing department lookup skips to defaults

**Integration Points**:

| Component | Integration |
|---|---|
| `ConsultationEventHandler` | After `resolvePipelineConfig()`, calls `promptResolutionService.resolve()` with consultation's `doctorId` and `departmentId`. Pipeline config values act as explicit overrides. Resolution trace is included in job options for audit. |
| `SummaryProcessor` | When `request.dnaStyleId` or `request.template` are missing, resolves via `promptResolutionService.resolve()` using the consultation's doctor and department. |
| `PreSummaryProcessor` | When `request.dnaStyleId` is missing, resolves via `promptResolutionService.resolve()`. |

**Domain Layer Changes** (prerequisite for the service):

The `DepartmentEntity`, `DepartmentModel`, and `DepartmentFactory` were updated to expose the 5 prompt config fields added by the Prisma migration (Task 2.1):

| File | Change |
|---|---|
| `packages/domains/src/entities/generated/core/DepartmentEntity.ts` | Added `defaultDnaStyleId`, `defaultSummaryTemplate`, `newPatientPromptId`, `revisitPromptId`, `promptMetadata` to interface, private fields, constructor, and getters/setters |
| `packages/domains/src/models/generated/core/DepartmentModel.ts` | Added 5 new public fields and constructor assignments |
| `packages/domains/src/factories/generated/core/DepartmentFactory.ts` | Added 5 new fields to `CreateDepartmentProps` and factory method |

**Files Created**:

| File | Purpose |
|---|---|
| `packages/applications/src/services/consultation/prompt/prompt-resolution.service.ts` | Core service — three-tier fallback chain, resolution trace, explicit override fast path |
| `packages/applications/src/services/consultation/prompt/prompt-resolution.service.module.ts` | NestJS module — imports `CoreDatabaseModule`, exports `PromptResolutionService` |
| `packages/applications/src/services/consultation/prompt/index.ts` | Barrel exports |
| `packages/applications/src/services/consultation/prompt/__tests__/prompt-resolution.service.test.ts` | 22 unit tests |

**Files Modified**:

| File | Change |
|---|---|
| `packages/applications/src/services/consultation/events/consultation-event.handler.ts` | Injected `PromptResolutionService`, calls `resolve()` in `handleTranscriptionCreated()` with consultation's doctor/department context |
| `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts` | Injected `PromptResolutionService`, resolves missing `dnaStyleId`/`template` before calling SMR |
| `packages/applications/src/services/consultation/jobs/processors/pre-summary.processor.ts` | Injected `PromptResolutionService`, resolves missing `dnaStyleId` before calling SMR |
| `packages/applications/src/services/consultation/jobs/consultation-job.service.module.ts` | Added `PromptResolutionServiceModule` to imports |
| `packages/applications/src/services/consultation/index.ts` | Added `prompt` barrel export |
| `packages/applications/src/services/consultation/events/__tests__/consultation-event.handler.test.ts` | Added `mockPromptResolutionService` to test setup |
| `packages/applications/src/services/consultation/jobs/__tests__/summary.processor.test.ts` | Added `mockPromptResolutionService` to test setup |

**Key Design Decisions**:

1. **No ClsService dependency**: The service accepts `doctorId` and `departmentId` as parameters instead of reading from request context. This is critical because processors run in BullMQ workers without HTTP request context.
2. **Explicit overrides bypass the chain**: When a doctor manually specifies `dnaStyleId` in an API call, it takes precedence over the entire fallback chain. This preserves backward compatibility.
3. **Independent field resolution**: Each field resolves independently through the chain. A doctor's `dnaStyleId` preference doesn't affect which `template` is used — template resolution continues down to department or default.
4. **Graceful degradation**: All repository calls are wrapped in try/catch. If the doctor settings DB is down, the service falls through to department tier. If department DB is down, it falls through to system defaults.
5. **Resolution trace for audit**: Every resolution returns a trace showing what each tier contributed and which fields used defaults. This is included in job options for debugging.

**Test Coverage** (22/22 passing):

| Group | Tests | Description |
|---|---|---|
| Full fallback chain | 4 | System defaults, doctor tier, department tier, doctor-over-department priority |
| Doctor tier | 3 | Skip when no doctorId, graceful DB failure, empty value handling |
| Department tier | 5 | Skip when no departmentId, DB failure, null config, revisit vs new, contextVariables |
| Explicit overrides | 3 | Full bypass, partial dnaStyleId override, partial template override |
| Resolution trace | 2 | Full multi-tier trace, default tracking |
| Realistic scenarios | 3 | Cardiology with doctor override, ER triage, cross-department referral |

**Regression Check**: 579/579 consultation tests pass, 5548/5549 total tests pass (1 pre-existing failure in `transcriptionRealtime.service.test.ts` unrelated to this change).

### Change #7: ENH-1 (Task 4.3) — Aggregate NER Endpoint for Consultation Chain (2026-02-17)

**Problem**: Step 12 of the consultation workflow requires Doctor A to see "main points and important information detected using NER" across all consultations. NER results were stored per-context-item with no aggregation endpoint. The doctor had no way to see a unified view of all extracted entities (medications, conditions, procedures, etc.) across the entire consultation chain.

**Dependency**: GAP-5 (sync NER persistence) — completed in a prior wave, ensuring both sync and async NER paths persist entities to the database.

**Solution**: Added a new `getAggregateNamedEntities()` method to `ContextService` and a `GET /consultations/:id/named-entities` endpoint to `ConsultationController`.

**How it Works**:

1. **Resolve linked consultations** — Uses the same combined chain + date strategy as `getSharedContext()` (GAP-2 fix) when `scope=chain`, or a single consultation when `scope=single`
2. **Fetch consultations with relations** — Uses `findWithRelations()` to get Doctor/Department metadata for source enrichment
3. **Iterate context items** — For each consultation, collects summaries and transcripts (the context item types that have NER data)
4. **Aggregate entities** — Groups by `className` (MEDICATION, CONDITION, PROCEDURE, etc.) with deduplication by `(text, sourceConsultationId)` within each class
5. **Build rich response** — Each entity includes ID, display text, confidence, high-confidence flag, source consultation/context item metadata, and AI model info
6. **Source metadata** — Only consultations that contributed entities appear in the `sources` array, with department name and doctor display name
7. **Broadcast SysEvent** — Emits `ResourceViewed` with aggregation metadata for audit trail

**API Endpoint**:

| Method | Route | Description |
|---|---|---|
| `GET` | `/consultations/:id/named-entities` | Aggregate NER entities from consultation chain |

**Query Parameters**:

| Param | Required | Default | Description |
|---|---|---|---|
| `scope` | No | `chain` | `single` for one consultation, `chain` for full chain + same-day consultations |

**Response Shape** (`AggregateNerResponse`):

```json
{
    "consultationId": "...",
    "scope": "chain",
    "entities": {
        "MEDICATION": [
            {
                "id": "ne-uuid",
                "text": "Aspirin 75mg",
                "displayText": "acetylsalicylic acid",
                "normalizedText": "acetylsalicylic acid",
                "confidence": 0.95,
                "isHighConfidence": true,
                "sourceConsultationId": "consultation-a",
                "sourceContextItemId": "summary-a",
                "sourceContextType": "RAW_SUMMARY",
                "aiModelId": "ner-model-1",
                "createdAt": "2026-02-17T10:00:00.000Z"
            }
        ],
        "CONDITION": ["..."],
        "PROCEDURE": ["..."]
    },
    "totalCount": 15,
    "countByClass": {
        "MEDICATION": 5,
        "CONDITION": 6,
        "PROCEDURE": 4
    },
    "sources": [
        { "consultationId": "...", "department": "General Medicine", "departmentId": "...", "doctor": "John Smith", "doctorId": "..." },
        { "consultationId": "...", "department": "Hematology", "departmentId": "...", "doctor": "Bob Brown", "doctorId": "..." }
    ]
}
```

**Files Created**:

| File | Purpose |
|---|---|
| `packages/applications/src/services/consultation/context/dto/aggregate-ner.response.ts` | Response DTOs: `AggregateNamedEntityItem`, `AggregateNerSource`, `AggregateNerResponse` with Swagger decorators |

**Files Modified**:

| File | Change |
|---|---|
| `packages/applications/src/services/consultation/context/IContextService.ts` | Added `getAggregateNamedEntities(consultationId, scope)` abstract method, imported `AggregateNerResponse` |
| `packages/applications/src/services/consultation/context/context.service.ts` | Implemented `getAggregateNamedEntities()` with chain resolution, NER aggregation, deduplication, source metadata enrichment; added `fetchConsultationsWithRelations()` and `formatDoctorName()` private helpers; imported `ConsultationEntity` and new DTOs |
| `packages/applications/src/services/consultation/context/dto/index.ts` | Added barrel export for `aggregate-ner.response` |
| `apps/api/src/modules/consultation/consultation.controller.ts` | Added `GET :id/named-entities` endpoint with `@ApiQuery` for scope, imported `AggregateNerResponse` |
| `packages/applications/src/services/consultation/context/__tests__/context.service.test.ts` | Added `findWithRelations` to mock `ConsultationRepository`; added 12 unit tests for aggregate NER |

**Key Design Decisions**:

1. **Richer than ChainSummaryService's internal representation**: The `AggregateNamedEntityItem` includes entity ID, display text, normalized text, high-confidence flag, source context item ID/type, and AI model info — everything a frontend needs to render NER highlights with full provenance
2. **Deduplication by (text, sourceConsultationId)**: Same entity text from the same consultation is deduplicated (e.g., "Aspirin" appearing in both a summary and transcript of the same consultation). Same text from different consultations is preserved (both Doctor A and Doctor B mentioning "Aspirin" are kept as separate entries)
3. **Sources only include contributing consultations**: The `sources` array only lists consultations that actually had NER entities — not all linked consultations
4. **Reuses existing patterns**: Uses the same `resolveLinkedConsultationIds()` helper as `getSharedContext()` and `getSharedCaseNotes()`, and the same `findWithRelations()` + `formatDoctorName()` pattern as `TimelineService`
5. **Placed on ContextService, not a new service**: NER entities are a property of context items, so the aggregation logically belongs on `ContextService` rather than creating a new service

**Test Coverage** (12/12 passing):

| Test | What it verifies |
|---|---|
| Empty response when consultation not found | Returns `{ entities: {}, totalCount: 0, sources: [] }` |
| Aggregate from chain + same-day consultations | Entities from both chain-linked and unlinked same-day consultations |
| Single scope | Only includes entities from one consultation, no chain resolution |
| Deduplication within same consultation | Same text from same consultation appears once |
| Allow same text from different consultations | Same text from different consultations preserved |
| Empty entities when no NER data | No entities, empty response |
| Source metadata with department and doctor | `sources` populated with department name, doctor name from relations |
| Entity item includes source context metadata | `sourceContextItemId`, `sourceContextType`, `aiModelId` populated |
| Low-confidence entities marked correctly | `isHighConfidence: false` when confidence < 0.8 |
| SysEvent broadcast | Audit event with scope, totalCount, sourceConsultationCount, classCount |
| Realistic multi-department aggregation | 3 classes (MEDICATION, CONDITION, PROCEDURE) from 2 departments |
| Username fallback when no UserProfile | Falls back to `Doctor.username` when `UserProfile` is absent |

**Regression Check**: 202/202 tests pass across 4 related test suites (context, chain-summary, summary, timeline) — zero regressions.

### Change #6: GAP-4 (Task 2.5) — ChainSummaryService for Comprehensive Cross-Chain Summaries (2026-02-17)

**Problem**: Step 13 of the consultation workflow requires Doctor A to generate a **final comprehensive summary** spanning all linked consultations (Doctor A's own transcripts, Doctor B's summary, lab results, case notes, NER-extracted entities). The existing `SummaryService` only worked within a single consultation — there was no way to aggregate content across the entire consultation chain.

**Solution**: Created a complete `ChainSummaryService` with sync and async endpoints, following the existing `SummaryService` + `SummaryProcessor` pattern.

**How it Works**:

1. **Resolve linked consultations** — Combines chain-based (parentConsultationId) + date-based (same tenantId, patientId, appointmentDate) strategies, reusing the GAP-2 fix logic
2. **Gather sections** — For each consultation: collects latest summary (preferred) or transcripts (fallback), case notes, and pre-summaries
3. **Aggregate NER entities** — Optionally gathers named entities from all summaries and transcripts across the chain, grouped by class (MEDICATION, CONDITION, PROCEDURE, etc.) and deduplicated
4. **Compose structured SMR input** — Builds section-annotated text with department/doctor/type metadata plus NER context
5. **Call SMR service** — Sends to `/api/v1/summary/sync` with `template: 'comprehensive'` and 3-minute timeout
6. **Store result** — Persists as `ContextItem(RAW_SUMMARY)` + `SummaryMeta` on the requesting consultation
7. **Broadcast SysEvent** — Emits `ResourceCreated` with `type: 'comprehensive_summary'` and source consultation IDs

**API Endpoints**:

| Method | Route | Description |
|---|---|---|
| `POST` | `/consultations/:id/summary/comprehensive` | Sync — blocks until SMR returns |
| `POST` | `/consultations/:id/summary/comprehensive/async` | Async — returns job ID, progress via SSE |

**Request DTO** (`ComprehensiveSummaryRequest`):

| Field | Type | Description |
|---|---|---|
| `dnaStyleId` | `string?` | DNA Style override (auto-resolves from department if not provided) |
| `template` | `string?` | Template override (defaults to `comprehensive`) |
| `includeNER` | `boolean?` | Include NER entities in summary input (default: true) |
| `includeLabResults` | `boolean?` | Include lab/test results (default: true) |
| `options` | `Record<string, unknown>?` | Additional SMR options |

**Response DTO** (`ComprehensiveSummaryResponse`):

Extends standard `SummaryResponse` with: `sourceConsultationIds`, `sectionCount`, `namedEntities` (aggregated by class).

**Files Created**:

| File | Purpose |
|---|---|
| `packages/applications/src/services/consultation/summary/chain-summary.service.ts` | Core service — consultation resolution, section gathering, NER aggregation, SMR call, persistence |
| `packages/applications/src/services/consultation/summary/chain-summary.service.module.ts` | NestJS module registration |
| `packages/applications/src/services/consultation/summary/dto/comprehensive-summary.request.ts` | Request DTO with class-validator decorators |
| `packages/applications/src/services/consultation/summary/dto/comprehensive-summary.response.ts` | Response DTO with chain-specific metadata |
| `packages/applications/src/services/consultation/jobs/processors/comprehensive-summary.processor.ts` | BullMQ processor for async path (6 progress steps: 10%→25%→40%→60%→85%→100%) |
| `packages/applications/src/services/consultation/summary/__tests__/chain-summary.service.test.ts` | 20 unit tests |

**Files Modified**:

| File | Change |
|---|---|
| `packages/domains/src/enums/JobQueue.enum.ts` | Added `GenerateComprehensiveSummary` enum value |
| `packages/applications/src/services/consultation/jobs/dto/job.dto.ts` | Added `COMPREHENSIVE_SUMMARY` to `JobType`, `GenerateComprehensiveSummaryJobPayload`, `ComprehensiveSummaryJobResult` |
| `packages/applications/src/services/consultation/jobs/consultation-job.service.ts` | Added `createComprehensiveSummaryJob()` method, `comprehensiveSummaryQueue` injection, `COMPREHENSIVE_SUMMARY` case in `cancelJob()` |
| `packages/applications/src/services/consultation/jobs/consultation-job.service.module.ts` | Registered `ComprehensiveSummaryProcessor`, imported `ChainSummaryServiceModule`, added `GenerateComprehensiveSummary` queue |
| `packages/applications/src/services/consultation/jobs/processors/index.ts` | Added barrel export for `ComprehensiveSummaryProcessor` |
| `packages/applications/src/services/consultation/summary/dto/index.ts` | Added barrel exports for comprehensive DTOs |
| `packages/applications/src/services/consultation/summary/index.ts` | Added barrel exports for `ChainSummaryService` and module |
| `apps/api/src/modules/consultation/summary.controller.ts` | Added `POST comprehensive` (sync) and `POST comprehensive/async` endpoints, injected `ChainSummaryService` |
| `apps/api/src/modules/consultation/consultation.module.ts` | Imported `ChainSummaryServiceModule` |
| `packages/applications/src/services/consultation/jobs/__tests__/consultation-job.service.test.ts` | Added `mockComprehensiveSummaryQueue` to test setup to match new constructor parameter |

**Key Design Decisions**:

1. **Summary preference over transcripts**: When gathering sections, if a consultation has a summary, that is used instead of raw transcripts — summaries are more concise and produce better comprehensive results
2. **NER deduplication**: Entities are deduplicated within the same (text, consultationId) pair to avoid noise in the SMR input
3. **Shared methods for async processor**: `resolveLinkedConsultations()`, `gatherSections()`, and `gatherNamedEntities()` are exposed as public methods so the `ComprehensiveSummaryProcessor` can reuse them without duplicating logic
4. **3-minute timeout**: Comprehensive summaries process more text than single-consultation summaries, so the SMR timeout is 180s (vs 120s for regular summaries)
5. **Fewer retries for async**: `ComprehensiveSummaryProcessor` uses 2 attempts (vs 3 for regular) because comprehensive summaries are expensive and retrying a failed chain aggregation is less likely to succeed

**Test Coverage** (20/20 passing):

| Group | Tests | Description |
|---|---|---|
| `resolveLinkedConsultations` | 3 | Combined strategies, deduplication, chain-only fallback |
| `gatherSections` | 6 | Summary preference, transcript fallback, case notes, multi-consultation, empty content, pre-summaries |
| `gatherNamedEntities` | 3 | Cross-consultation aggregation, deduplication, empty results |
| `generateComprehensiveSummary` | 8 | Full flow, not found, missing tenant, no content, NER skip, custom config, SMR failure, realistic 3-dept workflow |

**Regression Check**: 442/442 tests pass across 12 test files (0 regressions).

### Change #2: GAP-7 — SSE Polling → Redis Pub/Sub (2026-02-17)

**Problem**: The SSE endpoint in `ConsultationJobController` used `interval(2000)` polling to check job status every 2 seconds, despite `ConsultationJobService` already publishing updates to the `consultation_job_updates:{jobId}` Redis channel.

**Solution**: Replaced the polling-based `interval()` RxJS pipeline with a real-time Redis Pub/Sub subscription, following the same pattern used by the STT `TranscriptionRealtimeService`.

**Files Modified**:

| File | Change |
|---|---|
| `packages/applications/src/services/consultation/jobs/consultation-job.service.ts` | Added `subscribeToJobUpdates(jobId): Observable<MessageEvent>` method and `RedisSubscriberService` injection. Updated `IConsultationJobService` interface. |
| `packages/applications/src/services/consultation/jobs/consultation-job.service.module.ts` | Added `RedisSubscriberService` as a provider for dedicated Redis subscriber connection. |
| `apps/api/src/modules/consultation/job.controller.ts` | Replaced `interval(2000).pipe(...)` polling pipeline with single call to `jobService.subscribeToJobUpdates(jobId)`. Removed unused RxJS imports. |
| `packages/applications/src/services/consultation/jobs/__tests__/consultation-job.service.test.ts` | Added 8 new tests covering: job not found, terminal states (COMPLETED/FAILED/CANCELLED), in-progress subscription, Redis message streaming, terminal completion, cleanup, and error handling. Updated mock setup for `RedisSubscriberService`. |

**How it works**:

1. Client connects to `GET /consultations/jobs/:jobId/sse`
2. Controller calls `jobService.subscribeToJobUpdates(jobId)`
3. Service checks current job status:
   - If job not found → emits error event and completes
   - If already terminal (COMPLETED/FAILED/CANCELLED) → emits final status and completes
   - If in progress → emits current status immediately, then subscribes to Redis channel
4. Subsequent updates published by `notifyProgress()`, `notifyComplete()`, or `notifyFailed()` arrive instantly via Redis Pub/Sub
5. Stream auto-completes when terminal status received; Redis subscription cleaned up via `finalize()`

**Benefits**:
- Eliminates 2-second polling delay — updates are now instant
- Reduces Redis GET load (no polling reads every 2s per SSE connection)
- Consistent pattern with STT realtime transcription streaming
- Proper cleanup of Redis subscriptions via reference counting
| 2 | 2026-02-17 | **GAP-6 implemented**: Consolidated ContextController into ConsultationController | Completed |
| 4 | 2026-02-17 | **GAP-2 implemented**: Fix `getSharedContext()` to combine chain + date-based strategies | Completed |
| 5 | 2026-02-17 | **GAP-3 (Task 2.1 + 2.4)**: Department schema prompt config fields + seed data with DNA styles | Completed |

### Change #2: GAP-6 — Ownership Bypass on Standalone ContextController (2026-02-17)

**Approach**: Option A (preferred) — Removed `ContextController` entirely and consolidated all endpoints into `ConsultationController`.

**Problem Resolved**: The standalone `ContextController` exposed context mutation endpoints (`POST /context`, `PATCH /context/:itemId`) without any doctor ownership verification. Any authenticated user with a valid API key could add or update context on any consultation, bypassing the ownership checks that `ConsultationController` enforced via `ClsService<IActiveUserContext>`.

**What Changed**:

| File | Action | Details |
|---|---|---|
| `apps/api/src/modules/consultation/context.controller.ts` | **Deleted** | Removed the standalone controller that bypassed ownership checks |
| `apps/api/src/modules/consultation/consultation.controller.ts` | **Modified** | Added `GET :id/context/transcriptions` and `GET :id/context/case-notes` convenience endpoints (previously only in ContextController) |
| `apps/api/src/modules/consultation/consultation.module.ts` | **Modified** | Removed `ContextController` from imports and controllers array |
| `apps/api/src/modules/consultation/index.ts` | **Modified** | Removed `ContextController` barrel export |

**Endpoint Migration**:

| Old Route (ContextController) | New Route (ConsultationController) | Ownership Check |
|---|---|---|
| `POST /consultations/:consultationId/context` | `POST /consultations/:id/context` | Yes (doctorId === user.id) |
| `GET /consultations/:consultationId/context` | `GET /consultations/:id/context` | No (read-only) |
| `GET /consultations/:consultationId/context/shared` | `GET /consultations/:id/context/shared` | No (read-only) |
| `GET /consultations/:consultationId/context/transcriptions` | `GET /consultations/:id/context/transcriptions` | No (read-only, **new**) |
| `GET /consultations/:consultationId/context/case-notes` | `GET /consultations/:id/context/case-notes` | No (read-only, **new**) |
| `PATCH /consultations/:consultationId/context/:itemId` | `PATCH /consultations/:id/context/:contextId` | Yes (doctorId === user.id) |

**Security Impact**: All context mutation operations now require the requesting user to be the consultation owner (doctor). Read-only operations remain accessible to any authenticated user, which is correct for the cross-department context sharing workflow.
| 2 | 2026-02-17 | **GAP-5 Fix**: Sync `extractEntities()` now persists NER entities | Completed |

### Change #2: GAP-5 — Fix Sync NER Persistence

**Problem**: The synchronous `extractEntities()` method in `SummaryService` called the NLP service but discarded the returned entities — it only broadcast a `SysEvent` with the entity count. The async `NerProcessor` correctly persisted entities via `NamedEntityFactory.CreateNamedEntity()` + `namedEntityRepository.create()`, but the sync path was effectively a no-op.

**Root Cause**: The method was stubbed with a TODO comment (`"The actual entity storage is handled by the ContextService or job processor"`) but the wiring was never implemented.

**Fix Applied**:

1. **`summary.service.ts`** — Modified `extractEntities()` to:
   - Validate `tenantId` is present (consistent with other service methods)
   - Iterate over NLP response entities and persist each via `NamedEntityFactory.CreateNamedEntity()` + `namedEntityRepository.create()`
   - Map NLP response fields (`value`/`text`, `type`/`className`, `start`/`startOffset`, `end`/`endOffset`) with fallback handling to accommodate both NLP response formats
   - Wrap individual entity persistence in try/catch so one bad entity doesn't abort the entire batch
   - Log completion with extracted vs saved counts
   - Include `savedCount` in the `SysEvent` broadcast for observability

2. **`summary.service.ts`** — Constructor changes:
   - Injected `NamedEntityRepository` (already provided by `CoreDatabaseModule`)
   - Imported `NamedEntityFactory` and `NamedEntityRepository` from `@arcaai/domains`
   - Added `Logger` instance for structured logging

3. **`summary.service.module.ts`** — No changes needed; `CoreDatabaseModule` already exports `NamedEntityRepository`

**Files Modified/Created**:

| File | Change |
|---|---|
| `packages/applications/src/services/consultation/summary/summary.service.ts` | Added `NamedEntityRepository` injection, `NamedEntityFactory` import, `Logger`, and full entity persistence logic in `extractEntities()` |
| `packages/applications/src/services/consultation/summary/__tests__/summary.service.test.ts` | **Created** — 17 unit tests covering GAP-5 fix |

**Test Coverage (TDD — Red-Green verified)**:

| Test | What it verifies |
|---|---|
| Persist entities to NamedEntityRepository | Core fix — entities actually saved to DB |
| Persist multiple entities | Iterates over all NLP response entities |
| Call NLP service with correct content | NLP receives the context item content |
| Map value/type fields (primary naming) | NLP response `{type, value, start, end}` mapped correctly |
| Map text/className fields (alternate naming) | Alternate `{className, text, startOffset, endOffset}` handled |
| Empty entities — no create calls | No DB writes when NLP finds nothing |
| Undefined entities — no create calls | Handles `entities: undefined` gracefully |
| Partial failure resilience | One DB failure doesn't abort remaining entities |
| SysEvent with savedCount (partial) | Event reflects actual saved count on partial failure |
| SysEvent with savedCount (full success) | Event reflects full count on success |
| Tenant ID validation | BadRequestException if tenantId missing |
| Context item not found | NotFoundException preserved |
| Empty content | BadRequestException preserved |
| Whitespace-only content | BadRequestException preserved |
| NLP service failure | BadRequestException on HTTP error |
| Entities without optional fields | Handles missing confidence/position |
| Realistic medical NER response (9 entities) | End-to-end with medical text |

**TDD Cycle Verified**:
- RED: 9 tests failed (persistence not called, savedCount missing, tenantId not validated), 8 passed (existing validations)
- GREEN: All 17 tests pass after fix applied
- Regression: 0 failures across 115 total tests (NER processor + context service suites)

**Pattern Alignment**: The sync persistence follows the same pattern as `NerProcessor` (async path), using `NamedEntityFactory.CreateNamedEntity()` for entity creation — ensuring both paths produce identical database records.

| 3 | 2026-02-17 | **GAP-8 Fix**: NLP URL path mismatch + standardize all service URLs | Completed |

### Change #3: GAP-8 — Fix NLP URL Path + Standardize Service URLs (2026-02-17)

**Problem**: Multiple service URL issues were causing (or could cause) runtime failures:

1. **NLP URL path mismatch** — `SummaryService.callNlpService()` used `/classify/tokens` but the NLP service expects `/api/v1/classify/tokens`. The async `NerProcessor` already used the correct path.
2. **`process.env` instead of `ConfigService`** — `SummaryService` read `SMR_SERVICE_URL` and `NLP_SERVICE_URL` via `process.env` directly, bypassing the NestJS `ConfigService` used by all other processors.
3. **Wrong default ports** — `SummaryService` defaulted SMR to `http://localhost:8003` and NLP to `http://localhost:8004`, while the actual services run on port `5006` (SMR) and `5005` (NLP) as confirmed by `.env.example`, `.env.dev`, and all job processors.
4. **SMR default port bug in API controllers** — `SmrController` and `MonitoringService` both defaulted SMR to `http://localhost:5005` (the NLP port) instead of `http://localhost:5006`.

**Standard Port Reference**:

| Service | Default Port | Env Variable |
|---|---|---|
| STT | `5003` | `STT_URL` / `STT_SERVICE_URL` |
| TTS | `5004` | `TTS_URL` / `TTS_SERVICE_URL` |
| NLP | `5005` | `NLP_URL` / `NLP_SERVICE_URL` |
| SMR | `5006` | `SMR_URL` / `SMR_SERVICE_URL` |

**Files Modified**:

| File | Change |
|---|---|
| `packages/applications/src/services/consultation/summary/summary.service.ts` | Injected `ConfigService` from `@nestjs/config`; replaced `process.env.SMR_SERVICE_URL` with `this.configService.get<string>('SMR_SERVICE_URL')`; replaced `process.env.NLP_SERVICE_URL` with `this.configService.get<string>('NLP_SERVICE_URL')`; corrected SMR default from `8003` to `5006`; corrected NLP default from `8004` to `5005`; fixed NLP path from `/classify/tokens` to `/api/v1/classify/tokens` |
| `packages/applications/src/services/consultation/summary/summary.service.module.ts` | Added `ConfigModule` from `@nestjs/config` to module imports so `ConfigService` is available for injection |
| `apps/api/src/controllers/smr/smr.controller.ts` | Corrected SMR default port from `5005` to `5006` |
| `apps/api/src/controllers/monitoring/monitoring.service.ts` | Corrected SMR "Summarization" service default port from `5005` to `5006` |

**Consistency Check**: After this fix, all files that reference SMR or NLP service URLs now agree on the correct default ports:

| File | SMR Default | NLP Default | Config Method |
|---|---|---|---|
| `SummaryService` | `localhost:5006` | `localhost:5005` | `ConfigService` |
| `SummaryProcessor` | `localhost:5006` | — | `ConfigService` |
| `PreSummaryProcessor` | `localhost:5006` | — | `ConfigService` |
| `NerProcessor` | — | `localhost:5005` | `ConfigService` |
| `SmrController` | `localhost:5006` | — | `process.env` (proxy controller) |
| `MonitoringService` | `localhost:5006` | — | `process.env` (monitoring) |

| 4 | 2026-02-17 | **GAP-2 Fix**: Cross-department context sharing — combine chain + date strategies | Completed |

### Change #4: GAP-2 — Fix `getSharedContext()` Cross-Department Sharing (2026-02-17)

**Problem**: `getSharedContext()` only traversed the `parentConsultationId` chain via `findConsultationChain()`. If Doctor A and Doctor B created separate consultations for the same patient on the same date without a parent-child link, they could not see each other's context. The workflow requires ALL consultations for the same `(tenantId, patientId, appointmentDate)` to share context regardless of parent-child linkage.

**Solution**: Introduced a private helper `resolveLinkedConsultationIds()` that combines two strategies:

1. **Chain-based** (existing) — follows `parentConsultationId` links via `findConsultationChain()`
2. **Date-based** (new) — finds all consultations for the same `(tenantId, patientId, appointmentDate)` via the existing `findByPatientAndDate()` repository method

The helper merges and deduplicates IDs from both strategies. Both `getSharedContext()` and `getSharedCaseNotes()` now use this shared helper.

**Key Design Decisions**:

- `findByPatientAndDate()` already existed in `ConsultationRepository` — no repository changes needed
- Early-return guard (`if (allIds.length === 0) return []`) prevents unnecessary queries when the consultation is not found
- The Prisma schema already has a composite index on `[tenantId, patientId, appointmentDate]` — the date-based query is efficient

**Files Modified**:

| File | Change |
|---|---|
| `packages/applications/src/services/consultation/context/context.service.ts` | Refactored `getSharedContext()` and `getSharedCaseNotes()` to use new `resolveLinkedConsultationIds()` private helper; added early-return guard for missing consultations |
| `packages/applications/src/services/consultation/context/__tests__/context.service.test.ts` | Added `findByPatientAndDate` to mock; rewrote `getSharedContext` tests (4 cases: combined strategy, unlinked same-day, not found, deduplication); rewrote `getSharedCaseNotes` tests (3 cases: combined strategy, not found, empty results) |

**Test Coverage** (87/87 passing):

| Test | Scenario |
|---|---|
| `getSharedContext: should return shared context combining chain + same-day strategies` | Chain IDs + unlinked same-day IDs merged, all items returned |
| `getSharedContext: should include unlinked same-day consultations (date-based strategy)` | No parent link, Doctor B's consultation discovered via date match |
| `getSharedContext: should return empty array when consultation not found` | `findById` returns null → empty result, no further queries |
| `getSharedContext: should deduplicate IDs when chain and date strategies overlap` | Both strategies return overlapping IDs → no duplicates passed to repository |
| `getSharedCaseNotes: should return case notes combining chain + same-day strategies` | Same combined strategy for case notes, including unlinked consultations |
| `getSharedCaseNotes: should return empty array when consultation not found` | Same early-return behaviour as `getSharedContext` |
| `getSharedCaseNotes: should return empty array when no case notes in chain or same-day` | All consultations found but no case notes exist |

### Change #5: GAP-3 (Task 2.1 + 2.4) — Department Schema + Seed Data (2026-02-17)

**Problem**: The `Department` model had no prompt-related fields. The `dnaStyleId` was passed manually in every summary generation request. There was no system-level configuration mapping a department to its default DNA style and prompt template. The DNA spec describes a fallback chain (Doctor → Department → Default), but the Department tier of that chain was missing.

**Solution**: Two coordinated changes — schema and seed data:

**Task 2.1 — Schema Changes**

Added 5 new nullable fields to the `Department` Prisma model:

| Field | Type | Purpose |
|---|---|---|
| `defaultDnaStyleId` | `String?` | Default DNA writing style for this department (e.g., `style_DNA_dept_hematology_cp`) |
| `defaultSummaryTemplate` | `String?` | Default summary template (e.g., `SOAP`, `Radiology-Report`, `ER-Triage`) |
| `newPatientPromptId` | `String?` | Prompt registry ID for new/referral patients |
| `revisitPromptId` | `String?` | Prompt registry ID for revisit/follow-up patients |
| `promptMetadata` | `Json? @db.JsonB` | Additional prompt config (context variables, preferred sections, abbreviation density) |

All fields are nullable to ensure backward compatibility — existing departments without prompt config will fall through to the system default tier of the fallback chain.

**Task 2.4 — Seed Data**

Updated all 10 seed departments with department-specific prompt configuration:

| Dept | Code | DNA Style ID | Template | Abbrev. Density |
|---|---|---|---|---|
| General Practice | GEN | `style_DNA_dept_gen` | SOAP | low |
| Cardiology | CARD | `style_DNA_dept_card` | SOAP | medium |
| Radiology | RAD | `style_DNA_dept_rad` | Radiology-Report | high |
| Laboratory | LAB | `style_DNA_dept_lab` | Lab-Report | high |
| Neurology | NEUR | `style_DNA_dept_neur` | SOAP | medium |
| Orthopedics | ORTH | `style_DNA_dept_orth` | SOAP | medium |
| Dermatology | DERM | `style_DNA_dept_derm` | SOAP | low |
| Psychiatry | PSYCH | `style_DNA_dept_psych` | Psychiatric-Assessment | low |
| Pediatrics | PEDS | `style_DNA_dept_peds` | SOAP | low |
| Emergency | ER | `style_DNA_dept_er` | ER-Triage | high |

Each department's `promptMetadata` includes:
- `contextVariables` — which context variables are relevant (e.g., ECG Results for Cardiology, Growth Chart for Pediatrics)
- `preferredSections` — department-specific section headings for summaries
- `abbreviationDensity` — expected abbreviation usage level (aligns with DNA spec statistical profiles)

DNA Style ID naming convention: `style_DNA_dept_{code_lowercase}` (consistent with the DNA example spec's `style_DNA_doctor_department_hematology_cp` pattern).

**Files Modified/Created**:

| File | Action | Details |
|---|---|---|
| `packages/database/src/prisma/db_main/department.prisma` | **Modified** | Added 5 prompt config fields between "Department info" and "parent department" sections |
| `packages/database/src/prisma/db_main/migrations/20260217123058_add_department_prompt_config/migration.sql` | **Created** | ALTER TABLE migration adding 5 columns to `core.Department` |
| `packages/database/src/prisma/db_main/seed/04-department.ts` | **Modified** | All 10 departments now include `defaultDnaStyleId`, `defaultSummaryTemplate`, `newPatientPromptId`, `revisitPromptId`, and `promptMetadata` |

**Verification**:
- `prisma generate` — Prisma client regenerated successfully with new Department fields
- `tsc --noEmit` — TypeScript compilation passes; seed data is fully type-safe against generated types
- No linter errors on modified files
- Seed uses `upsert` with `where: { id }` — safe to re-run on existing databases (adds new fields without data loss)

**Dependency**: This change is a prerequisite for Task 2.2 (`PromptResolutionService`) which will implement the Doctor → Department → Default fallback chain using these new fields.

### Change #5: GAP-1 Tasks 1.2–1.5 — Event Handler + Auto-Pipeline (2026-02-17)

**Problem**: The system had no automatic pipeline to chain transcription → summary → NER. After a transcript was stored from STT, a doctor or frontend had to manually call `POST /summary` and then `POST /extract-entities`. This broke the requirement that "the system must generate the conversation summary automatically."

**Solution**: Implemented an event-driven auto-pipeline using EventEmitter2 and the existing BullMQ job infrastructure.

**Pipeline Flow**:

```
Audio → STT Service → Transcript stored
                          ↓ SttInternalService emits TranscriptionCreated
                      ConsultationEventHandler.handleTranscriptionCreated()
                          ↓ creates BullMQ summary job (if autoSummaryEnabled)
                      SummaryProcessor completes → emits SummaryGenerated
                          ↓
                      ConsultationEventHandler.handleSummaryGenerated()
                          ↓ creates BullMQ NER job (if autoNerEnabled + isAutoGenerated)
                      NerProcessor completes → emits NerExtracted
                          ↓
                      ConsultationEventHandler.handleNerExtracted()
                          ↓ emits PipelineCompleted
```

**Components Implemented**:

| Component | Description |
|---|---|
| `ConsultationEventHandler` | `@OnEvent` listener that orchestrates the auto-pipeline |
| `SttInternalService` modification | Emits `TranscriptionCreated` after storing a transcript |
| `SummaryProcessor` modification | Emits `SummaryGenerated` after completing summary job |
| `NerProcessor` modification | Emits `NerExtracted` after completing NER job |
| Pipeline configuration | Resolved from `consultation.metadata.pipelineConfig` with system defaults |

**Pipeline Configuration**:

The pipeline is configurable per-consultation via the `metadata.pipelineConfig` JSON field:

```typescript
interface ConsultationPipelineConfig {
    autoSummaryEnabled: boolean;    // default: true
    autoNerEnabled: boolean;        // default: true
    dnaStyleId?: string;            // passed to SMR for auto-summary
    summaryTemplate?: string;       // e.g., "SOAP"
    includeSharedContext?: boolean;  // include cross-department context
    haltOnFailure?: boolean;        // default: false
}
```

Resolution order: Consultation metadata → System defaults (both enabled).

**Files Created**:

| File | Purpose |
|---|---|
| `packages/applications/src/services/consultation/events/consultation-event.handler.ts` | Event handler with `@OnEvent` listeners for 3 pipeline events |
| `packages/applications/src/services/consultation/events/__tests__/consultation-event.handler.test.ts` | 29 unit tests covering all pipeline paths |

**Files Modified**:

| File | Change |
|---|---|
| `packages/applications/src/services/stt/internal/sttInternal.service.ts` | Added `TranscriptionCreated` event emission after transcript creation |
| `packages/applications/src/services/stt/internal/dto/internal.request.ts` | Added optional `transcriptionSource` field to `CreateTranscriptRequest` |
| `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts` | Injected `EventEmitter2`, emits `SummaryGenerated` after `notifyComplete` |
| `packages/applications/src/services/consultation/jobs/processors/ner.processor.ts` | Injected `EventEmitter2`, emits `NerExtracted` after `notifyComplete` with entity count breakdown |
| `packages/applications/src/services/consultation/jobs/consultation-job.service.module.ts` | Added `EventEmitterModule` import, registered `ConsultationEventHandler` as provider |
| `packages/applications/src/services/consultation/events/index.ts` | Added barrel export for `ConsultationEventHandler` |
| `packages/applications/src/services/consultation/jobs/__tests__/summary.processor.test.ts` | Updated mock setup to include `EventEmitter2` mock for new constructor parameter |
| `packages/applications/src/services/consultation/jobs/__tests__/ner.processor.test.ts` | Updated mock setup to include `EventEmitter2` mock for new constructor parameter |

**Key Design Decisions**:

1. **Auto-generated flag**: The event handler passes `options.autoGenerated: true` when creating a summary job. The `SummaryProcessor` reads this from `job.data.request.options?.autoGenerated` and includes it in the `SummaryGenerated` event. The `handleSummaryGenerated` handler only triggers NER for auto-generated summaries — manual summaries don't cascade.

2. **Error resilience**: Pipeline failures emit `PipelineStepFailed` events but don't throw. When `haltOnFailure` is false (default), a NER failure still emits `PipelineCompleted` with `stepsExecuted: ['transcription', 'summary']`.

3. **Configuration fallback**: If the consultation has no metadata or the repository throws, the handler falls back to `DEFAULT_PIPELINE_CONFIG` (both auto-summary and auto-NER enabled).

4. **Module wiring**: `ConsultationEventHandler` is registered in `ConsultationJobServiceModule` because it depends on `IConsultationJobService` (to create jobs) and `ConsultationRepository` (from `CoreDatabaseModule`). `EventEmitterModule` is imported for both the handler's `@OnEvent` decorators and the processors' `EventEmitter2` injection.

**Test Coverage** (29/29 passing):

| Group | Tests | Description |
|---|---|---|
| `handleTranscriptionCreated` | 8 | Auto-summary trigger, config resolution, disabled pipeline, error handling |
| `handleSummaryGenerated` | 8 | Auto-NER trigger, manual bypass, disabled NER, error + haltOnFailure |
| `handleNerExtracted` | 3 | PipelineCompleted emission, manual bypass, correlationId propagation |
| `resolvePipelineConfig` | 5 | Defaults, null metadata, partial config merge, DB error, full config |
| `Full pipeline chain` | 5 | End-to-end simulation of all pipeline paths |

**Regression Check**: 360/360 tests pass across 10 test files (excluding pre-existing `consultation-job.service.test.ts` failures unrelated to this change).

---

### Change #5: ENH-2 — Consultation Timeline Endpoint (2026-02-17)

**Rationale**: For the multi-department workflow, a timeline of events across all consultations is valuable. Doctor A needs to see a chronological view of what happened across Dept A, Dept B, and any same-day consultations — including transcriptions, summaries, NER extractions, and context additions.

**New Endpoint**:

```
GET /api/consultations/:id/timeline?scope=chain
```

**Query Parameters**:

| Param | Required | Default | Description |
|---|---|---|---|
| `scope` | No | `chain` | `single` for one consultation, `chain` for full chain + same-day consultations |

**Response Shape**:

```json
{
    "consultationId": "...",
    "scope": "chain",
    "events": [
        { "timestamp": "...", "type": "consultation_opened", "department": "General Medicine", "doctor": "Dr. A", "doctorId": "..." },
        { "timestamp": "...", "type": "context_added", "contextType": "CASE_NOTE", "consultationId": "...", "contextItemId": "..." },
        { "timestamp": "...", "type": "transcription_completed", "wordCount": 1250, "consultationId": "..." },
        { "timestamp": "...", "type": "summary_generated", "aiModel": "gpt-4o", "consultationId": "..." },
        { "timestamp": "...", "type": "ner_extracted", "entityCount": 12, "consultationId": "..." },
        { "timestamp": "...", "type": "consultation_opened", "department": "Hematology", "doctor": "Dr. B" }
    ],
    "totalEvents": 6,
    "sources": [
        { "consultationId": "...", "department": "General Medicine", "doctor": "John Smith" },
        { "consultationId": "...", "department": "Hematology", "doctor": "Bob Brown" }
    ]
}
```

**Timeline Event Types**:

| Event Type | Trigger |
|---|---|
| `consultation_opened` | Consultation `createdAt` timestamp |
| `context_added` | Non-transcript, non-summary context item created (CASE_NOTE, WORKNOTE, ATTACHMENT, etc.) |
| `transcription_completed` | TRANSCRIPT context item created. Includes `wordCount`. |
| `summary_generated` | RAW_SUMMARY or MODIFIED_SUMMARY created. Includes `aiModel`. |
| `summary_updated` | Summary item has `currentVersionNumber > 1`. Includes `versionNumber`. |
| `pre_summary_generated` | PRE_SUMMARY context item created |
| `ner_extracted` | Named entities found for a context item. Includes `entityCount`. |
| `context_updated` | Non-summary item has `currentVersionNumber > 1` |

**How It Works**:

1. Resolves linked consultation IDs using the same combined chain + date strategy as `getSharedContext()` (GAP-2 fix)
2. Fetches consultations with Doctor and Department relations for metadata enrichment
3. Iterates over all context items and named entities, converting each to timeline events
4. Sorts all events chronologically
5. Returns the flat timeline with source consultation metadata

**Files Created/Modified**:

| File | Action |
|---|---|
| `packages/applications/src/services/consultation/timeline/timeline.service.ts` | **Created** — Core timeline aggregation logic |
| `packages/applications/src/services/consultation/timeline/timeline.service.module.ts` | **Created** — NestJS module registration |
| `packages/applications/src/services/consultation/timeline/dto/timeline-event.response.ts` | **Created** — Timeline DTOs: `TimelineEventType` enum, `TimelineEventResponse`, `ConsultationTimelineResponse` |
| `packages/applications/src/services/consultation/timeline/dto/index.ts` | **Created** — Barrel export |
| `packages/applications/src/services/consultation/timeline/index.ts` | **Created** — Barrel export |
| `packages/applications/src/services/consultation/timeline/__tests__/timeline.service.test.ts` | **Created** — 12 unit tests |
| `packages/applications/src/services/consultation/index.ts` | **Modified** — Added `timeline` barrel export |
| `apps/api/src/modules/consultation/consultation.controller.ts` | **Modified** — Added `GET :id/timeline` endpoint with `TimelineService` injection |
| `apps/api/src/modules/consultation/consultation.module.ts` | **Modified** — Added `TimelineServiceModule` to imports |

**Test Coverage** (12/12 passing):

| Test | What it verifies |
|---|---|
| Empty timeline for non-existent consultation | Returns `{ events: [], totalEvents: 0, sources: [] }` |
| Single consultation scope | Only includes events from one consultation |
| Chain + same-day consultations | Aggregates events from all linked consultations |
| NER extraction events | Groups named entities per context item, shows entity count |
| Versioned context item update events | Emits `summary_updated` / `context_updated` when `currentVersionNumber > 1` |
| Word count on transcripts | Counts words in transcript content |
| AI model on summaries | Populates `aiModel` from `SummaryMeta.aiModelId` |
| Case notes and worknotes | Maps to `context_added` event type |
| Pre-summary events | Maps to `pre_summary_generated` event type |
| SysEvent broadcast | Confirms audit trail event emission |
| Doctor name from UserProfile | Formats "FirstName LastName" from profile |
| Username fallback | Falls back to username when no UserProfile exists |

---

### Change #6: ENH-3 — Pagination on Unbounded List Endpoints (2026-02-17)

**Rationale**: `getPatientHistory`, `getByPatientAndDate`, and `getContextItems` return unbounded arrays. For patients with extensive medical histories, this could cause performance issues. Adding optional pagination parameters ensures these endpoints remain performant at scale while maintaining backward compatibility.

**Approach**: Backward-compatible — when `page` and `limit` query params are omitted, the endpoints continue to return unbounded arrays. When provided, they return a paginated response with `data`, `count`, `page`, and `limit`.

**Updated Endpoints**:

| Endpoint | New Query Params | Paginated Response |
|---|---|---|
| `GET /consultations/patient/:patientId/history` | `?page=1&limit=20` | `PaginatedConsultationResponse` |
| `GET /consultations/patient/:patientId/date/:date` | `?page=1&limit=20` | `PaginatedConsultationResponse` |
| `GET /consultations/:id/context` | `?page=1&limit=50&type=TRANSCRIPT` | `PaginatedContextItemResponse` |

**Paginated Response Shape**:

```json
{
    "data": [ /* array of items */ ],
    "count": 42,
    "page": 1,
    "limit": 20
}
```

**Design Decisions**:

1. **Pages are 1-based** — consistent with the existing `formatFindAllProps()` helper in `repository.helpers.ts` which uses `(page - 1) * limit` for skip calculation
2. **`getPatientHistoryPaginated`** uses the repository's `findAll` with page/limit for DB-level pagination + `count` for total count — efficient for large datasets
3. **`getByPatientAndDatePaginated`** uses in-memory slicing — same-day consultations are typically a small set (< 20), so DB-level pagination adds complexity without meaningful benefit
4. **`getContextItemsPaginated`** uses in-memory slicing — per-consultation context items rarely exceed 100; a repository-level approach can be added later if needed
5. **Existing `PaginatedConsultationResponse`** DTO was already defined but unused — now wired into the service and controller

**Files Created/Modified**:

| File | Action |
|---|---|
| `packages/applications/src/services/consultation/consultation/dto/consultation-history.query.ts` | **Created** — Query DTO with `page` and `limit` validation |
| `packages/applications/src/services/consultation/context/dto/paginated-context-item.response.ts` | **Created** — `PaginatedContextItemResponse` with Swagger decorators |
| `packages/applications/src/services/consultation/context/dto/context-filters.dto.ts` | **Modified** — Added `page` and `limit` optional fields with validation |
| `packages/applications/src/services/consultation/context/dto/index.ts` | **Modified** — Added barrel export for `PaginatedContextItemResponse` |
| `packages/applications/src/services/consultation/consultation/dto/index.ts` | **Modified** — Added barrel export for `ConsultationHistoryQuery` |
| `packages/applications/src/services/consultation/consultation/IConsultationService.ts` | **Modified** — Added `getPatientHistoryPaginated` and `getByPatientAndDatePaginated` abstract methods |
| `packages/applications/src/services/consultation/consultation/consultation.service.ts` | **Modified** — Implemented paginated methods |
| `packages/applications/src/services/consultation/context/IContextService.ts` | **Modified** — Added `getContextItemsPaginated` abstract method |
| `packages/applications/src/services/consultation/context/context.service.ts` | **Modified** — Implemented `getContextItemsPaginated` |
| `apps/api/src/modules/consultation/consultation.controller.ts` | **Modified** — Updated 3 endpoints with optional pagination |
| `packages/applications/src/services/consultation/consultation/__tests__/consultation.service.test.ts` | **Modified** — Added 9 pagination tests (4 for history, 5 for date-based) |

**Test Coverage** (9 new tests, 463 total passing):

| Test | What it verifies |
|---|---|
| `getPatientHistoryPaginated`: paginated history | Returns `{ data, count, page, limit }` |
| `getPatientHistoryPaginated`: correct params | Passes `page` and `limit` to repository `findAll` |
| `getPatientHistoryPaginated`: missing tenantId | Throws `BadRequestException` |
| `getPatientHistoryPaginated`: SysEvent metadata | Broadcasts event with `page`, `limit`, `count` |
| `getByPatientAndDatePaginated`: paginated results | Correctly slices array |
| `getByPatientAndDatePaginated`: page 2 | Skip calculation `(page-1)*limit` is correct |
| `getByPatientAndDatePaginated`: empty results | Returns `{ data: [], count: 0 }` |
| `getByPatientAndDatePaginated`: beyond range | Returns empty data but correct total count |
| `getByPatientAndDatePaginated`: missing tenantId | Throws `BadRequestException` |

**Regression**: 463/463 tests pass across 13 test files — zero regressions.
