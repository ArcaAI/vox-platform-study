# 01 — Consultation Lifecycle & Status

> **Wireframe**: Consultation Workspace  
> **Last Updated**: 2026-02-26  
> **Status**: Design Specification  
> **Related Pages**: `basic-consultation.tsx`, `consultation.tsx`

---

## 1. Overview

The Consultation Lifecycle workspace is the core interface where doctors open, document, and finalize patient consultations. It manages the full lifecycle from OPEN through CLOSED, with automatic status transitions, guard rails, and audit-compliant close/reopen workflows.

### Core Business Flow

```
Doctor navigates to Consultation (Local) or Consultation (Remote) page →
Doctor opens consultation → Status: OPEN →
Audio starts → Status: RECORDING →
Audio stops → Status: TRANSCRIBING →
Summary generated → Status: SUMMARIZING →
Doctor reviews → Status: REVIEW →
Doctor approves → Status: CLOSED
```

### Two Separate Consultation Interfaces

The SPA provides **two separate page interfaces** for consultations — one for each audio processing workflow. Each is a distinct route and sidebar entry, giving the user a dedicated experience tailored to the workflow's capabilities:

| Interface | Route | Description |
|-----------|-------|-------------|
| **Consultation (Local)** | `/consultation-local` | Audio processed entirely in the browser using WebAssembly AI models (Whisper ONNX, Silero VAD, RNNoise). Audio never leaves the device. Includes WASM model management, download status, and offline-capable recording. |
| **Consultation (Remote)** | `/consultation-remote` | Audio streamed to the STT-V2 backend service via WebSocket for GPU-accelerated processing. Includes pipeline selector, backend health status, and speaker diarization. |

Both interfaces share the same lifecycle stepper (OPEN → CLOSED), the same consultation APIs, and the same summary generation pipeline. The difference is in the audio recording and transcription layer only.

---

## 2. User Stories

| # | Persona | Story | Priority |
|---|---------|-------|----------|
| 1 | Doctor | Open a new consultation by entering a patient ID and appointment date, so that I can begin documenting the encounter. | — |
| 101 | Doctor | Each consultation to have an explicit status (OPEN, RECORDING, TRANSCRIBING, SUMMARIZING, REVIEW, CLOSED), so that I know the current stage of my documentation workflow. | **Critical** |
| 102 | Doctor | "Close" a consultation to mark it as finalized, so that no further edits are possible without explicit reopening — ensuring clinical documentation integrity. | **Critical** |
| 103 | Admin | See a dashboard of consultation statuses across all doctors (how many open, how many closed today), so that I can monitor documentation completion rates. | High |
| 104 | Doctor | The system to prevent generating a summary if no transcript exists yet, so that summaries are always based on actual conversation content. | High |
| 105 | Doctor | Reopen a closed consultation with a reason code (e.g., "correction", "addendum"), so that I can make justified amendments while maintaining audit history. | High |
| 106 | Doctor | Automatic status transitions (OPEN → RECORDING when audio starts, RECORDING → TRANSCRIBING when audio stops), so that I don't need to manually update the workflow stage. | Medium |
| 107 | Compliance Officer | All consultation status changes to be logged in the audit trail with timestamp, user, and reason, so that the lifecycle is fully traceable for regulatory review. | High |
| 108 | Doctor | See a progress indicator on my consultation showing which steps are complete (audio, transcript, case notes, summary, NER), so that I know what remains. | Medium |
| 109 | Department Head | A report showing average time-to-close for consultations in my department, so that I can identify bottlenecks in the documentation workflow. | Medium |
| 110 | System | Auto-flag consultations that have been open for more than 48 hours, so that incomplete documentation doesn't go unnoticed. | Low |
| 111 | Admin | Assign a doctor to a primary department, so that the system can auto-select the correct department prompt templates when the doctor opens a consultation. | High |
| 112 | Doctor | The system to default to my primary department when opening a new consultation, while allowing me to override to a different department for cross-specialty consults. | High |
| 113 | Admin | Assign a doctor to multiple departments (primary + secondary), so that specialists who work across departments are properly represented. | Medium |
| 114 | Department Head | See all doctors assigned to my department with their consultation counts, so that I can manage workload distribution. | Medium |
| 115 | Doctor | The system to remember which department I last used per patient context, so that follow-up consultations automatically inherit the same department assignment. | Low |
| 116 | Admin | See a doctor's cross-department consultation history, so that I understand multi-specialty involvement patterns. | Low |

---

## 3. Wireframe Description

### 3.1 Separate Interfaces per Audio Workflow

Instead of a toggle or switcher, the SPA provides **two dedicated page interfaces** accessible from the sidebar:

**Sidebar Navigation:**
```
Doctor Workflows
  ├── Consultation (Local)    ← /consultation-local
  ├── Consultation (Remote)   ← /consultation-remote
  ├── Transcription (Local)   ← /transcription-local
  ├── Transcription (Remote)  ← /transcription-remote
  └── ...
```

**Consultation (Local) Interface** — `/consultation-local`:

| Element | Description |
|---------|-------------|
| **Page header** | "Consultation — Local Processing" with laptop icon and "Client-Side" badge |
| **WASM model status** | Card showing downloaded models (Whisper, Silero VAD, RNNoise) with status badges and download buttons for missing models |
| **Privacy notice** | Info banner: "All audio processing happens in your browser. Audio never leaves this device." |
| **Recording controls** | Standard start/stop/mute with local-specific settings (WASM model selector, noise filter level) |
| **Offline indicator** | Badge showing offline capability: "Works offline" (green) |

**Consultation (Remote) Interface** — `/consultation-remote`:

| Element | Description |
|---------|-------------|
| **Page header** | "Consultation — Remote Processing" with cloud icon and "Backend" badge |
| **Backend status** | Card showing STT service health, WebSocket connectivity, active sessions |
| **Pipeline selector** | Dropdown to choose ASR pipeline (Default STT, Medical Transcription, Multilingual) |
| **Recording controls** | Standard start/stop/mute with remote-specific settings (pipeline, server model info) |
| **Connection indicator** | Live WebSocket status badge: "Connected" (green) / "Disconnected" (red) |

**Shared between both interfaces:**
- Status stepper (OPEN → CLOSED)
- Patient & consultation info card
- Action buttons (Generate Summary, Approve & Close, Add Case Note, Load Shared Context)
- Department override panel
- Completion checklist
- Reopen consultation card

### 3.2 Status Stepper (Top Bar)

A horizontal stepper always visible at the top of the consultation workspace:

```
[✓ OPEN] ——→ [✓ RECORDING] ——→ [✓ TRANSCRIBING] ——→ [● SUMMARIZING] ——→ [ REVIEW] ——→ [ CLOSED]
```

**Behavior:**
- Completed steps show green checkmark
- Active step pulses with accent color animation
- Future steps are dimmed
- Auto-transitions: OPEN→RECORDING (audio.start), RECORDING→TRANSCRIBING (audio.stop), etc.
- Admin can manually override status via click (with confirmation dialog)

### 3.3 Patient & Consultation Info Card

Displays:
- Patient ID (MRN)
- Doctor name (from authenticated session)
- Department with "Primary" badge + override dropdown
- Appointment date
- Duration timer (live)
- New Visit / Re-visit badge

### 3.4 Action Buttons Bar

| Button | Condition | Action |
|--------|-----------|--------|
| ⚡ Generate Summary | Enabled only when transcript exists (#104) | Triggers summary generation |
| ✓ Approve & Close | Enabled only in REVIEW status | Closes consultation, locks edits |
| 📄 Add Case Note | Always enabled when OPEN-REVIEW | Opens case note editor |
| 🔗 Load Shared Context | Always enabled | Loads referring doctor's context |

### 3.5 Department Override Panel

- Auto-selects doctor's primary department (#112)
- Dropdown with all available departments
- "Override" button to change department for this consultation
- Remembers last department per patient (#115)

### 3.6 Completion Checklist (Right Sidebar)

| Step | Status | Detail |
|------|--------|--------|
| Audio recorded | ✓ / ○ | Duration badge |
| Transcript generated | ✓ / ○ | Word count badge |
| Case notes added | ✓ / ○ | Note count badge |
| Summary generated | ● / ○ | Progress bar |
| NER extraction | ○ | Pending |
| Doctor review | ○ | Pending |

### 3.7 Reopen Consultation Card

Only visible for CLOSED consultations:
- Reason code dropdown: Correction, Addendum, Additional findings
- "Reopen with Reason" button (destructive style)
- Creates audit log entry (#107)

---

## 4. API Endpoints

### 4.1 Consultation CRUD

| Method | Endpoint | Description | Request Body | Response |
|--------|----------|-------------|--------------|----------|
| POST | `/api/v1/consultations/open` | Open/create consultation | `{ patientId, appointmentDate?, department? }` | `Consultation` |
| GET | `/api/v1/consultations/:id` | Get consultation by ID | — | `Consultation` |
| GET | `/api/v1/consultations` | List consultations (paginated) | Query: `page, limit, status, doctorId` | `PaginatedResponse<Consultation>` |
| POST | `/api/v1/consultations/:parentId/revisit` | Create follow-up | `{ appointmentDate?, metadata? }` | `Consultation` |

### 4.2 Patient History

| Method | Endpoint | Description | Request Body | Response |
|--------|----------|-------------|--------------|----------|
| GET | `/api/v1/consultations/patient/:patientId/history` | Patient consultation history | Query: `page, limit` | `Consultation[]` |
| GET | `/api/v1/consultations/patient/:patientId/date/:date` | By patient & date | — | `Consultation[]` |
| GET | `/api/v1/consultations/:id/chain` | Get consultation chain | — | `ConsultationChain` |
| GET | `/api/v1/consultations/:id/timeline` | Timeline events | Query: `scope=single|chain` | `TimelineEntry[]` |

### 4.3 Context Management

| Method | Endpoint | Description | Request Body | Response |
|--------|----------|-------------|--------------|----------|
| POST | `/api/v1/consultations/:id/context` | Add context item | `{ type, content, source? }` | `ContextItem` |
| PATCH | `/api/v1/consultations/:id/context/:contextId` | Update context (versioned) | `{ content, changeDescription? }` | `ContextItem` |
| GET | `/api/v1/consultations/:id/context` | Get context items | Query: `type, source, limit` | `ContextItem[]` |
| GET | `/api/v1/consultations/:id/context/shared` | Shared context (cross-doctor) | — | `ContextItem[]` |
| GET | `/api/v1/consultations/:id/context/:contextId/versions` | Version history | — | `ContextVersionEntry[]` |

### 4.4 Department & Assignment

| Method | Endpoint | Description | Request Body | Response |
|--------|----------|-------------|--------------|----------|
| GET | `/api/v1/departments` | List all departments | — | `Department[]` |
| GET | `/api/v1/departments/:id` | Get department by ID | — | `Department` |
| PATCH | `/api/v1/departments/:id` | Update department | `{ name?, code?, ... }` | `Department` |
| PATCH | `/api/v1/departments/:id/prompt-config` | Update prompt config | `{ newPatientPromptId?, revisitPromptId?, ... }` | `Department` |

### 4.5 Audit & Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/admin/audit-logs` | List audit logs |
| GET | `/api/v1/admin/audit-logs/resource/:type/:id` | By resource |
| GET | `/api/v1/health` | Health check |

---

## 5. SDK Integration

### 5.1 Hooks Used

| Hook | Purpose |
|------|---------|
| `useArca()` | Main SDK hook — `session`, `audio`, `context`, `summary` |
| `useArcaSession()` | Simplified session hook with `open`, `close`, `reopen`, `addContext` |
| `useDepartments()` | Department listing and selection |

### 5.2 Key Methods

```typescript
// Open consultation (get-or-create)
const consultation = await session.open({
  patientId: 'MRN-2026-0456',
  appointmentDate: '2026-02-26',
  department: 'General Medicine',
});

// Add case note
await session.addContext({
  type: 'CASE_NOTE',
  content: 'Patient presents with chest pain...',
  source: 'USER',
});

// Close consultation
await session.close();

// Reopen with reason
await session.reopen();

// Load shared context from referring doctor
const shared = await context.loadSharedContext();

// Get patient history
const history = await session.getPatientHistory('MRN-2026-0456');
```

### 5.3 Types

```typescript
interface Consultation {
  id: string;
  patientId: string;
  doctorId: string;
  doctorName?: string;
  appointmentDate: string;
  department?: string;
  status?: ConsultationStatus;
  isNew?: boolean;
  createdAt: string;
  updatedAt: string;
}

type ConsultationStatus =
  | 'OPEN' | 'RECORDING' | 'TRANSCRIBING'
  | 'SUMMARIZING' | 'REVIEW' | 'CLOSED' | 'CANCELLED';

interface ContextItem {
  id: string;
  consultationId: string;
  type: ContextItemType;
  content: string;
  source: ContextSource;
  createdAt: string;
  updatedAt: string;
}
```

---

## 6. Data Models

### Consultation
| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `patientId` | string | Patient medical record number |
| `doctorId` | UUID | FK to User |
| `departmentId` | UUID | FK to Department |
| `tenantId` | UUID | FK to Tenant (multi-tenant isolation) |
| `status` | enum | OPEN / RECORDING / TRANSCRIBING / SUMMARIZING / REVIEW / CLOSED / CANCELLED |
| `parentConsultationId` | UUID? | FK to parent (for chains) |
| `consultationType` | enum | NEW / REVISIT / REFERRAL |
| `appointmentDate` | date | Appointment date |
| `createdAt` | timestamp | Created timestamp |
| `updatedAt` | timestamp | Last updated |

### Department
| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `name` | string | Department name |
| `code` | string | Short code (e.g., CARD, ORTH) |
| `parentId` | UUID? | Parent department (hierarchy) |
| `newPatientPromptId` | UUID? | FK to PromptTemplate |
| `revisitPromptId` | UUID? | FK to PromptTemplate |
| `summaryPromptId` | UUID? | FK to PromptTemplate |
| `preSummaryPromptId` | UUID? | FK to PromptTemplate |

---

## 7. Existing Implementation

### Current Pages
- **`basic-consultation.tsx`**: Minimal demo — open session, start/stop audio, mute/unmute. Uses `useArca()`.
- **`consultation.tsx`**: Full demo — get-or-create, add case notes, patient history, context items. Uses `useArcaSession()`.

### Current Components
- **`ConsultationProgressStepper`**: Horizontal stepper showing OPEN → REVIEW status progression
- **`ErrorDisplay`**: Standard error display with retry

### Gaps vs. User Stories
| Gap | Stories | Description |
|-----|---------|-------------|
| No separate workflow pages | #24 | No dedicated page interfaces for Local (client-side) and Remote (backend) consultation workflows — currently a single page |
| No close/reopen UI | #102, #105 | No button to close or reopen a consultation |
| No department auto-select | #111, #112 | Department must be manually entered |
| No completion checklist | #108 | No visual indicator of what's done vs. pending |
| No guard rails | #104 | Summary can be generated without transcript |
| No audit trail UI | #107 | Status changes not visually logged |
| No 48h auto-flag | #110 | Stale consultations not highlighted |

---

## 8. UX Best Practices

1. **Separate interfaces per workflow** — Dedicated pages for Local and Remote consultation workflows; user navigates to the appropriate page from the sidebar rather than toggling within a single page
2. **Status stepper always visible** — Doctors should always know where they are in the workflow
3. **Auto-transitions** — Reduce manual steps; status changes automatically on events
4. **Guard rails with tooltips** — Disabled buttons show tooltip explaining why (e.g., "Generate Summary requires a transcript")
5. **Department auto-select with override** — Pre-fill from doctor's primary department, allow one-click override
6. **Completion checklist** — Persistent sidebar showing progress; creates sense of accomplishment
7. **Close requires confirmation** — Modal dialog: "Are you sure? This will lock the consultation."
8. **Reopen requires reason** — Dropdown + text field; creates audit entry
9. **Responsive layout** — Two-column on desktop (main + sidebar), single column on mobile
