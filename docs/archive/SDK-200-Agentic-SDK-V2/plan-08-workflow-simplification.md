# SDK Workflow Simplification Plan

**Ticket**: SDK-200 (Enhancement)
**Created**: 2026-01-29
**Last Updated**: 2026-01-29
**Status**: In Progress

---

## Executive Summary

This document outlines a comprehensive plan to simplify the `@arcaai/vox` SDK workflow and align it with real-world medical consultation patterns. The goal is to create a more intuitive, session-focused API that naturally maps to how doctors interact with patients throughout a day.

---

## Design Decisions (Confirmed)

| Decision | Answer |
|----------|--------|
| **Access Control** | Simple: Doctor provides (patientId, doctorId, date) → full access to their consultation. No complex guards for now. |
| **View Patient History** | Any doctor can view all consultations for a patient (any doctor, any date) |
| **Edit Access** | Doctor can only edit their own consultation (doctorId must match authenticated user) |
| **Auto-Close Behavior** | No automatic closure needed - sessions can remain open indefinitely |
| **Cross-Tab Sync** | Sync only within same consultation key (patientId + doctorId + date). Multiple tabs for different patients/dates work independently |
| **Care Team Model** | Deferred - extend when requirements emerge |
| **Backward Compatibility** | NOT required - prioritize simplicity, accuracy, and quality |

---

## Current State Analysis

### What We Have Now

#### 1. Consultation Identification
- **Current**: Uses unique `consultationId` (UUID) as primary identifier
- **Constraint**: Unique on `[tenantId, patientId, appointmentDate, doctorId]`
- **Issue**: SDK must first create/load a consultation to get its ID

#### 2. Session Structure
- **Current**: New-visit → Re-visit chain model
- **Constraint**: Only one "new-visit" per patient per day
- **Issue**: Complex logic to determine if consultation exists, then decide create vs startRevisit

#### 3. Status Management
- **Current**: `active`, `paused`, `completed`, `cancelled` states
- **Issue**: Explicit state management adds complexity to SDK usage

#### 4. Access Control
- **Current**: API Key → User → Tenant isolation only
- **Issue**: No doctor-level access control for consultation data

---

## Proposed Simplified Workflow

### Core Concept: Natural Session Key

Instead of thinking in terms of "consultations" and "revisits", use the natural key that doctors think in:

```
Session Key = (patientId, doctorId, appointmentDate)
```

This key uniquely identifies a doctor's interaction with a patient on a given day.

### Simplified API Flow

```typescript
// SDK Usage - Simple and intuitive
const session = useArcaSession();

// 1. Start/resume a session - SDK handles create vs load automatically
await session.open({
  patientId: 'patient-123',
  doctorId: 'doctor-456',        // Current user
  appointmentDate: '2026-01-29', // Today
});

// 2. Add context (transcriptions, notes, etc.)
await session.addContext({ type: 'transcription', content: '...' });

// 3. View shared context from other doctors today
const sharedContext = await session.getSharedContext();

// 4. Session auto-closes on tab close or explicit close
await session.close();
```

### Context Types in a Day

Within a patient's day, there are multiple "contexts" (previously called consultations):

```
Patient Visit on 2026-01-29
├── Context 1: First visit with Dr. Smith (General Practitioner)
│   ├── Transcription
│   ├── Case notes
│   └── Pre-summary
├── Context 2: Lab visit (no doctor, system context)
│   └── Lab results
├── Context 3: Re-visit with Dr. Smith (follow-up after lab)
│   ├── Transcription
│   └── Summary
└── Context 4: Specialist visit with Dr. Jones
    ├── Transcription
    └── Case notes
```

---

## Data Model Redesign

### Option A: Simplify Within Current Model (Recommended)

Keep the current Prisma schema but change how we use it:

#### 1. Remove New-Visit / Re-Visit Distinction

**Current**:
```typescript
// Complex - must check if new-visit exists
const existing = await service.findByPatientDate(patientId, date);
if (existing.some(c => c.isNewVisit)) {
  await service.startRevisit(parentId, { doctorId });
} else {
  await service.create({ patientId, doctorId, appointmentDate });
}
```

**Proposed**:
```typescript
// Simple - always use getOrCreate
const consultation = await service.getOrCreate({
  patientId,
  doctorId,
  appointmentDate,
});
```

#### 2. Change `parentConsultationId` Semantics

**Current**: Links re-visits to new-visits (hierarchical)
**Proposed**: Links all consultations on the same day (flat, using `patientDayKey`)

```prisma
model Consultation {
  // ... existing fields ...

  // New: Group consultations by patient+day (not hierarchical)
  patientDayKey String?  // Format: "{patientId}_{appointmentDate}"

  // Keep for backward compatibility, but make optional
  parentConsultationId String?  // Deprecated: use patientDayKey
}
```

#### 3. Status Simplification

**Current**: Manual status transitions (active → paused → completed)
**Proposed**: Automatic status based on activity

| Status | Trigger |
|--------|---------|
| `active` | Session opened, receiving context |
| `idle` | No activity for 5 minutes (configurable) |
| `completed` | Session explicitly closed OR end of day |
| `cancelled` | Only via explicit admin action |

Remove `pause` and `resume` from SDK API.

### Option B: New Simplified Model (If Major Refactor Allowed)

```prisma
// PatientDay groups all consultations for a patient on a day
model PatientDay {
  id              String   @id @default(uuid(7))
  tenantId        String
  patientId       String
  appointmentDate DateTime @db.Date
  metadata        Json?    @db.JsonB

  // Resource management
  resourceStatus  ResourceStatusType @default(ENABLED)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  // Relations
  Sessions        DoctorSession[]

  @@unique([tenantId, patientId, appointmentDate])
  @@schema("core")
}

// DoctorSession is a doctor's interaction within a PatientDay
model DoctorSession {
  id            String   @id @default(uuid(7))
  patientDayId  String
  doctorId      String
  doctorName    String?
  department    String?

  // Timestamps
  startedAt     DateTime @default(now())
  endedAt       DateTime?
  lastActiveAt  DateTime @default(now())

  // Status (simplified)
  isActive      Boolean  @default(true)

  // Resource management
  resourceStatus ResourceStatusType @default(ENABLED)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  // Relations
  PatientDay    PatientDay   @relation(fields: [patientDayId], references: [id])
  ContextItems  ContextItem[]

  @@unique([patientDayId, doctorId])
  @@schema("core")
}
```

---

## Access Control Design

### Simplified Approach (Current Phase)

**Principle**: Keep it simple. Use the natural key as implicit access control.

A doctor can **view and edit** any consultation if they provide valid:
- `patientId`
- `doctorId` (must match authenticated user)
- `appointmentDate`

No complex access guard needed - the unique constraint handles it:
- `[tenantId, patientId, appointmentDate, doctorId]`

### Access Rules (Simple)

| Action | Rule |
|--------|------|
| **Open/Create consultation** | Doctor provides patientId + date → gets their own consultation |
| **Add context** | Doctor can only add to their own consultation (doctorId enforced) |
| **View own consultation** | Always allowed |
| **View shared context** | Can view all consultations for same patient + date |
| **View patient history** | Can view all consultations for a patient (any doctor, any date) |

### Implementation

No `ConsultationAccessGuard` needed for now. Access is implicitly controlled:

```typescript
// The unique constraint ensures a doctor can only have ONE consultation
// per patient per day - no guard needed, just use the natural key

@Post('open')
async open(@Body() dto: OpenConsultationRequest): Promise<ConsultationResponse> {
  // doctorId comes from authenticated user (API key)
  const doctorId = this.clsService.get('user').id;

  // Get or create - unique constraint handles collision
  return this.consultationService.getOrCreate({
    patientId: dto.patientId,
    doctorId,  // Always the authenticated doctor
    appointmentDate: dto.appointmentDate || today(),
  });
}

@Post(':id/context')
async addContext(
  @Param('id') id: string,
  @Body() dto: AddContextRequest,
): Promise<ContextItemResponse> {
  const consultation = await this.consultationService.findById(id);
  const userId = this.clsService.get('user').id;

  // Simple check: is this the doctor's consultation?
  if (consultation.doctorId !== userId) {
    throw new ForbiddenException('You can only add context to your own consultation');
  }

  return this.contextService.addContext(id, dto);
}
```

### Future Extension Point

When access control requirements evolve, add:
1. `ConsultationAccessGuard` with role-based rules
2. Care team membership checks
3. Department-based access
4. Audit logging

For now: **Keep it simple, extend when needed.**

---

## API Changes

### New V2 Endpoints

All new endpoints use `/v2/` prefix for clarity.

#### 1. Consultation Management

```http
# Open consultation (get-or-create)
POST   /v2/consultations/open
       Headers: X-API-Key (doctorId extracted from API key)
       Body: {
         patientId: string,
         appointmentDate?: string,  // Defaults to today (YYYY-MM-DD)
         department?: string,
         metadata?: object
       }
       Returns: ConsultationResponse

# Get consultation by ID
GET    /v2/consultations/:id
       Returns: ConsultationResponse (with context)

# Get patient history for the authenticated doctor
GET    /v2/consultations/patient/:patientId/history
       Query: { limit?: number, offset?: number }
       Returns: ConsultationResponse[] (all consultations doctor can access)

# Get all consultations for patient on a specific date
GET    /v2/consultations/patient/:patientId/date/:date
       Returns: ConsultationResponse[] (all doctors' consultations on that date)
```

#### 2. Context Management

```http
# Add context to consultation
POST   /v2/consultations/:id/context
       Body: {
         type: 'transcription' | 'case_note' | 'summary' | 'pre_summary',
         content: string,
         structuredData?: object,
         source?: 'user' | 'system' | 'transcription' | 'ai'
       }
       Returns: ContextItemResponse

# Get context for consultation
GET    /v2/consultations/:id/context
       Query: { type?: string, source?: string }
       Returns: ContextItemResponse[]

# Get shared context (all context for patient on the consultation date)
GET    /v2/consultations/:id/context/shared
       Returns: ContextItemResponse[] (from all doctors on that date)
```

#### 3. Summary Management

```http
# Generate summary
POST   /v2/consultations/:id/summary
       Body: { dnaStyleId?: string }
       Returns: SummaryResponse

# Generate pre-summary
POST   /v2/consultations/:id/summary/pre-summary
       Returns: SummaryResponse

# Get latest summary
GET    /v2/consultations/:id/summary/latest
       Returns: SummaryResponse | null
```

### Removed Endpoints (No Longer Needed)

```http
# REMOVED - Use /v2/consultations/open instead
POST   /consultations
POST   /consultations/:id/revisit

# REMOVED - No lifecycle management needed
POST   /consultations/:id/pause
POST   /consultations/:id/resume
POST   /consultations/:id/end

# REMOVED - Use /v2/consultations/:id/context/shared instead
GET    /consultations/:id/chain
```

---

## SDK Changes

### New Simplified API

#### Primary Hook: `useArcaSession`

```typescript
export function useArcaSession() {
  return {
    // ===== State =====
    consultation: Consultation | null,  // Current open consultation
    context: ContextItem[],              // Context items for current consultation
    isLoading: boolean,
    error: Error | null,

    // ===== Session Actions =====

    // Open a consultation (get-or-create)
    // - If consultation exists for (patientId, doctorId, date): returns existing
    // - If not: creates new consultation
    open: (input: OpenSessionInput) => Promise<Consultation>,

    // ===== Context Actions =====

    // Add context to current consultation
    addContext: (input: AddContextInput) => Promise<ContextItem>,

    // Get shared context (all context from all doctors on same date)
    getSharedContext: () => Promise<ContextItem[]>,

    // ===== History Actions =====

    // Get patient consultation history (all dates the doctor has consulted)
    getPatientHistory: (patientId: string) => Promise<Consultation[]>,

    // Load a specific consultation (for viewing history)
    loadConsultation: (consultationId: string) => Promise<Consultation>,
  };
}

// ===== Input Types =====

interface OpenSessionInput {
  patientId: string;
  appointmentDate?: string;  // Defaults to today (YYYY-MM-DD)
  department?: string;
  metadata?: Record<string, unknown>;
}

interface AddContextInput {
  type: 'transcription' | 'case_note' | 'summary' | 'pre_summary';
  content: string;
  structuredData?: Record<string, unknown>;
  source?: 'user' | 'system' | 'transcription' | 'ai';
}
```

#### Simplified Types

```typescript
// Consultation - much simpler than before
interface Consultation {
  id: string;
  patientId: string;
  doctorId: string;
  doctorName?: string;
  appointmentDate: string;  // YYYY-MM-DD
  department?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ContextItem - unchanged
interface ContextItem {
  id: string;
  consultationId: string;
  type: string;
  content: string;
  structuredData?: Record<string, unknown>;
  source: string;
  createdAt: string;
  updatedAt: string;
}
```

### What Gets Removed

| Component | Reason for Removal |
|-----------|-------------------|
| `SessionCoordinator` | Simplified to basic BroadcastChannel for same-consultation sync |
| `SessionPersistence` | No need to persist/recover sessions |
| `LifecycleManager` | No lifecycle to manage |
| `ConsultationStatus` type | No status transitions |
| `isNewVisit` / `isRevisit` | No longer relevant |
| `parentConsultationId` | Flat structure, no hierarchy |
| `pause()` / `resume()` / `end()` | No lifecycle management |
| `create()` / `startRevisit()` | Replaced by single `open()` |

### Simplified Cross-Tab Sync

```typescript
// Simple BroadcastChannel for same-consultation sync
class SimpleCrossTabSync {
  private channel: BroadcastChannel;
  private consultationKey: string;  // `${patientId}_${doctorId}_${date}`

  constructor(consultation: Consultation) {
    this.consultationKey = `${consultation.patientId}_${consultation.doctorId}_${consultation.appointmentDate}`;
    this.channel = new BroadcastChannel(`arcaai_${this.consultationKey}`);
  }

  // Broadcast context update to other tabs with same consultation
  broadcastContext(context: ContextItem) {
    this.channel.postMessage({ type: 'context_added', context });
  }

  // Listen for updates from other tabs
  onContextAdded(callback: (context: ContextItem) => void) {
    this.channel.onmessage = (event) => {
      if (event.data.type === 'context_added') {
        callback(event.data.context);
      }
    };
  }

  close() {
    this.channel.close();
  }
}
```

---

## Implementation Plan

Based on confirmed decisions, here's the simplified implementation plan.

### Phase 1: Backend API (New V2 Endpoints)

#### Task 1.1: Create V2 Consultation Controller
New file: `apps/api/src/modules/consultation/v2.consultation.controller.ts`

```typescript
@Controller('v2/consultations')
export class V2ConsultationController {
  // POST /v2/consultations/open - Get or create consultation
  // GET  /v2/consultations/:id - Get consultation with context
  // GET  /v2/consultations/patient/:patientId/history - Patient history
  // GET  /v2/consultations/patient/:patientId/date/:date - Same-day consultations
}
```

#### Task 1.2: Create V2 Context Controller
New file: `apps/api/src/modules/consultation/v2.context.controller.ts`

```typescript
@Controller('v2/consultations/:id/context')
export class V2ContextController {
  // POST /v2/consultations/:id/context - Add context (owner only)
  // GET  /v2/consultations/:id/context - Get context
  // GET  /v2/consultations/:id/context/shared - Get shared context (same date)
}
```

#### Task 1.3: Add Service Methods
Update `ConsultationService`:
- `getOrCreate(patientId, doctorId, date)` - Upsert consultation
- `getPatientHistory(patientId)` - All consultations for patient
- `getByPatientAndDate(patientId, date)` - All consultations on a date

#### Task 1.4: Create DTOs
- `OpenConsultationRequest` - { patientId, appointmentDate?, department?, metadata? }
- `V2ConsultationResponse` - Simplified response (no status, no parent)

### Phase 2: SDK Simplification

#### Task 2.1: Update SDK Constants
Update `packages/agentic-sdk-v2/src/core/constants.ts`:
```typescript
export const V2_ENDPOINTS = {
  OPEN: '/v2/consultations/open',
  GET: (id: string) => `/v2/consultations/${id}`,
  PATIENT_HISTORY: (patientId: string) => `/v2/consultations/patient/${patientId}/history`,
  CONTEXT_ADD: (id: string) => `/v2/consultations/${id}/context`,
  CONTEXT_SHARED: (id: string) => `/v2/consultations/${id}/context/shared`,
};
```

#### Task 2.2: Simplify useArcaSession Hook
Rewrite `packages/agentic-sdk-v2/src/hooks/useArcaSession.ts`:
- Remove `create()`, `startRevisit()`, `pause()`, `resume()`, `end()`
- Add `open()`, `getPatientHistory()`, `loadConsultation()`
- Simplify state management

#### Task 2.3: Simplify Types
Update `packages/agentic-sdk-v2/src/types/`:
- Remove `ConsultationStatus`, `isNewVisit`, `isRevisit`, `parentConsultationId`
- Remove `SessionLifecycleState`
- Simplify `Consultation` interface

#### Task 2.4: Replace SessionCoordinator
Replace complex `SessionCoordinator` with simple `BroadcastChannel`:
```typescript
// ~50 lines instead of ~600 lines
class SimpleCrossTabSync {
  constructor(consultationKey: string) {
    this.channel = new BroadcastChannel(`arcaai_${consultationKey}`);
  }
  broadcast(event: { type: string; data: unknown }) { ... }
  onMessage(callback: (event) => void) { ... }
  close() { ... }
}
```

#### Task 2.5: Remove Unused Code
- Remove `SessionPersistence`
- Remove `LifecycleManager`
- Remove old consultation actions from store

### Phase 3: Testing & Cleanup

#### Task 3.1: E2E Tests for V2 Endpoints
Create `apps/api/tests/e2e/v2-consultation.spec.ts`:
- Test `POST /v2/consultations/open` (create + get existing)
- Test context operations
- Test patient history

#### Task 3.2: SDK Unit Tests
Update SDK tests:
- Test simplified `useArcaSession` hook
- Test cross-tab sync
- Remove tests for deprecated features

#### Task 3.3: Update Examples
Update `packages/agentic-sdk-v2/examples/`:
- Update Vite app example
- Simplify usage patterns

### Estimated Effort

| Phase | Tasks | Complexity |
|-------|-------|------------|
| Phase 1 | 4 tasks | Medium - New API endpoints |
| Phase 2 | 5 tasks | Medium - SDK refactoring |
| Phase 3 | 3 tasks | Low - Testing & cleanup |

**Total**: ~12 tasks, incremental implementation

---

## Security Considerations

### React Security (CVE-2025-55182)

**Status**: Not directly affected
- `@arcaai/vox` is a client-side SDK
- Does NOT use React Server Components
- React 18.x/19.x peer dependency is safe for client-side use

**Recommendation**:
- Update SDK peer dependencies to specify safe versions
- Document that applications using RSC should upgrade to React 19.0.4+

### Access Control Security (Simplified)

Current phase uses minimal access control:

1. **API Key Authentication**: All requests require valid API key
2. **Tenant Isolation**: All queries filtered by `tenantId` from API key
3. **Ownership for Edits**: Adding context requires `doctorId` match
4. **Open Read Access**: Any authenticated user can view consultations within tenant

**Future Extension Points** (when requirements emerge):
- Role-based access (admin, doctor, nurse)
- Department-based restrictions
- Patient consent tracking
- Audit logging for sensitive access

---

## Appendix: Code Examples

### Example 1: Basic Consultation Flow

```typescript
// ConsultationPage.tsx - Simple consultation workflow
function ConsultationPage({ patientId }: { patientId: string }) {
  const session = useArcaSession();
  const audio = useArcaAudio();

  // Open session when page loads
  useEffect(() => {
    session.open({ patientId });
  }, [patientId]);

  if (session.isLoading) return <Loading />;
  if (session.error) return <Error error={session.error} />;
  if (!session.consultation) return null;

  return (
    <div className="consultation-page">
      {/* Patient info */}
      <PatientHeader patientId={patientId} />

      {/* Shared context from other doctors today */}
      <SharedContextPanel />

      {/* Current consultation context */}
      <ContextList items={session.context} />

      {/* Transcription controls */}
      <div className="controls">
        <button onClick={() => audio.start()}>Start Recording</button>
        <button onClick={() => audio.stop()}>Stop</button>
      </div>

      {/* Manual note input */}
      <NoteInput onSubmit={(content) => session.addContext({
        type: 'case_note',
        content,
        source: 'user',
      })} />
    </div>
  );
}
```

### Example 2: Viewing Patient History

```typescript
// PatientHistoryPage.tsx - View all consultations for a patient
function PatientHistoryPage({ patientId }: { patientId: string }) {
  const session = useArcaSession();
  const [history, setHistory] = useState<Consultation[]>([]);
  const [selectedConsultation, setSelectedConsultation] = useState<string | null>(null);

  useEffect(() => {
    // Load patient history on mount
    session.getPatientHistory(patientId).then(setHistory);
  }, [patientId]);

  const handleSelectConsultation = async (consultationId: string) => {
    setSelectedConsultation(consultationId);
    await session.loadConsultation(consultationId);
  };

  return (
    <div className="history-page">
      {/* List of all consultations */}
      <aside className="consultation-list">
        {history.map((c) => (
          <button
            key={c.id}
            onClick={() => handleSelectConsultation(c.id)}
            className={selectedConsultation === c.id ? 'active' : ''}
          >
            <span>{c.appointmentDate}</span>
            <span>{c.doctorName || c.doctorId}</span>
          </button>
        ))}
      </aside>

      {/* Selected consultation details */}
      <main>
        {session.consultation && (
          <>
            <h2>Consultation on {session.consultation.appointmentDate}</h2>
            <p>Doctor: {session.consultation.doctorName}</p>
            <ContextList items={session.context} readOnly />
          </>
        )}
      </main>
    </div>
  );
}
```

### Example 3: Multiple Tabs with Different Patients

```typescript
// Each tab operates independently
// Tab 1: Consulting with Patient A
const tab1 = useArcaSession();
await tab1.open({ patientId: 'patient-A' });  // Creates consultation key: patientA_doctor1_2026-01-29

// Tab 2: Viewing Patient B history
const tab2 = useArcaSession();
await tab2.open({ patientId: 'patient-B' });  // Creates consultation key: patientB_doctor1_2026-01-29

// Tab 3: Same patient as Tab 1 - SYNCS automatically
const tab3 = useArcaSession();
await tab3.open({ patientId: 'patient-A' });  // Same key as Tab 1 - syncs context

// When Tab 1 adds context, Tab 3 sees it automatically via BroadcastChannel
await tab1.addContext({ type: 'case_note', content: 'Patient reports...' });
// Tab 3's session.context is updated automatically
```

### Example 4: Backend Controller (Simplified)

```typescript
// v2.consultation.controller.ts
@ApiTags('V2 Consultations')
@ApiBearerAuth()
@UseGuards(ApiKeyGuard)
@Controller('v2/consultations')
export class V2ConsultationController {
  constructor(
    private readonly consultationService: ConsultationService,
    private readonly contextService: ContextService,
    private readonly clsService: ClsService,
  ) {}

  @Post('open')
  @ApiOperation({ summary: 'Open consultation (get or create)' })
  async open(@Body() dto: OpenConsultationRequest): Promise<ConsultationResponse> {
    // doctorId always comes from authenticated user
    const user = this.clsService.get('user');
    return this.consultationService.getOrCreate({
      patientId: dto.patientId,
      doctorId: user.id,
      appointmentDate: dto.appointmentDate || new Date().toISOString().split('T')[0],
      department: dto.department,
      metadata: dto.metadata,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get consultation by ID' })
  async findById(@Param('id') id: string): Promise<ConsultationResponse> {
    return this.consultationService.findById(id);
  }

  @Get('patient/:patientId/history')
  @ApiOperation({ summary: 'Get all consultations for a patient' })
  async getPatientHistory(
    @Param('patientId') patientId: string,
  ): Promise<ConsultationResponse[]> {
    return this.consultationService.getPatientHistory(patientId);
  }

  @Get('patient/:patientId/date/:date')
  @ApiOperation({ summary: 'Get all consultations for patient on a date' })
  async getByPatientAndDate(
    @Param('patientId') patientId: string,
    @Param('date') date: string,
  ): Promise<ConsultationResponse[]> {
    return this.consultationService.getByPatientAndDate(patientId, date);
  }

  @Post(':id/context')
  @ApiOperation({ summary: 'Add context to consultation' })
  async addContext(
    @Param('id') id: string,
    @Body() dto: AddContextRequest,
  ): Promise<ContextItemResponse> {
    // Simple ownership check
    const consultation = await this.consultationService.findById(id);
    const user = this.clsService.get('user');

    if (consultation.doctorId !== user.id) {
      throw new ForbiddenException('You can only add context to your own consultation');
    }

    return this.contextService.addContext(id, dto);
  }

  @Get(':id/context/shared')
  @ApiOperation({ summary: 'Get shared context from all doctors on same date' })
  async getSharedContext(@Param('id') id: string): Promise<ContextItemResponse[]> {
    return this.contextService.getSharedContext(id);
  }
}
```

---

## Next Steps

1. **Phase 1**: Implement simplified API endpoints
   - Add `POST /v2/consultations/open` (get-or-create)
   - Add `GET /v2/consultations/patient/:patientId/history`
   - Add `ConsultationAccessGuard`

2. **Phase 2**: Update SDK
   - Simplify `useArcaSession` hook
   - Remove deprecated code
   - Update types

3. **Phase 3**: Testing & Documentation
   - E2E tests for new endpoints
   - Update SDK examples
   - Update API documentation

---

*Document prepared based on codebase analysis and confirmed requirements.*
*Last updated: 2026-01-29*
