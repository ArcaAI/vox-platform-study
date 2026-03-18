# 06 — Care Journey & Consultation Chains

> **Wireframe**: Patient Care Journey Visualization  
> **Last Updated**: 2026-02-26  
> **Status**: Design Specification  
> **Related Pages**: `consultation-timeline.tsx`, `appointment-view.tsx`, `multi-doctor-workflow.tsx`

---

## 1. Overview

The Care Journey interface visualizes a patient's care path across consultations, referrals, and follow-ups. It provides two primary views: a **Chain Tree View** showing the hierarchical relationship between original visits, referrals, and follow-ups, and an **Event Timeline** showing chronological events across the chain. Doctors can load shared context from referring consultations and generate comprehensive cross-chain summaries.

### Core Business Flow

```
Doctor searches by patient ID → Chain tree loads (Original → Referrals → Follow-ups) →
Doctor selects consultation → Detail sidebar shows doctor, department, date →
Doctor loads consultation or shared context → Optional: Generate comprehensive summary
```

---

## 2. User Stories

| # | Persona | Story | Priority |
|---|---------|-------|----------|
| 10 | Doctor | Generate a comprehensive cross-chain summary spanning multiple consultations, so that referral documentation is complete. | — |
| 11 | Doctor | Search consultations by patient ID and date range, so that I can quickly find past encounters. | — |
| 12 | Doctor | View a timeline of consultation chains (original, follow-ups, referrals), so that I understand the patient's care journey. | — |
| 13 | Doctor | Load shared context from a referring doctor's consultation, so that I have the full clinical picture before seeing a referred patient. | — |

### Full Story Text

- **#10**: As a **doctor**, I want to generate a comprehensive cross-chain summary spanning multiple consultations, so that referral documentation is complete.
- **#11**: As a **doctor**, I want to search consultations by patient ID and date range, so that I can quickly find past encounters.
- **#12**: As a **doctor**, I want to view a timeline of consultation chains (original, follow-ups, referrals), so that I understand the patient's care journey.
- **#13**: As a **doctor**, I want to load shared context from a referring doctor's consultation, so that I have the full clinical picture before seeing a referred patient.

---

## 3. Wireframe Description

### 3.1 Patient Lookup

Search panel to find a patient and load their consultation chain:

| Element | Description |
|---------|-------------|
| **Patient ID input** | Text field; placeholder "Enter patient ID" |
| **Load Chain button** | Primary button; triggers `session.getPatientHistory(patientId)` |
| **Loading state** | Spinner while fetching |
| **Error display** | Error message if fetch fails |

**Behavior:**
- On success, chain tree populates with root consultations
- Empty state: "Search for a patient to visualize their consultation chain tree"

### 3.2 Chain Tree View

Recursive tree of consultations:

| Element | Description |
|---------|-------------|
| **Tree nodes** | Each node: doctor name, type badge (Original/Referral/Follow-up), department, date |
| **Color-coded badges** | Original (blue), Referral (emerald), Follow-up (amber) |
| **Expand/collapse** | Chevron for nodes with children |
| **Connecting lines** | Vertical/horizontal lines between parent and child nodes |
| **Click to select** | Clicking a node selects it; loads detail in sidebar |
| **Load Consultation** | Button in detail sidebar to `session.load(consultationId)` |
| **Active badge** | "Active" pulse badge for in-progress consultations |

**Behavior:**
- Tree built from `ConsultationChain` with `parentConsultationId` and `consultationType`
- Recursive `ChainTreeNode` component; depth-based indentation
- Expand/collapse state per node

### 3.3 Event Timeline

Chronological list of events across the chain:

| Element | Description |
|---------|-------------|
| **Type filter buttons** | All, consultation_opened, transcription_completed, summary_generated, referral_created, shared_context_loaded, comprehensive_summary |
| **Date separators** | Section header when date changes (e.g., "Monday, February 10, 2026") |
| **Event cards** | Description, timestamp, type badge, doctor, department |
| **Vertical timeline** | Left border/line with circular icons per event |

**Behavior:**
- Events sorted by `timestamp` ascending
- Filter shows count per type (e.g., "All (10)", "consultation_opened (4)")
- Icons per event type: Calendar, FileText, Share2, GitBranch

### 3.4 Chain Summary Stats

Aggregate metrics for the loaded chain:

| Element | Description |
|---------|-------------|
| **Total Consultations** | Count of all nodes in tree |
| **Referrals** | Count of referral-type nodes |
| **Follow-ups** | Count of follow-up-type nodes |
| **Unique Doctors** | Count of distinct doctor IDs |

**Behavior:**
- Stats computed from chain data
- Displayed in 2×2 grid in sidebar

### 3.5 Consultation Detail Sidebar

When a consultation is selected from the tree:

| Element | Description |
|---------|-------------|
| **Doctor** | Doctor name or ID |
| **Department** | Department name |
| **Date** | Appointment date (formatted) |
| **Status** | Badge: completed / in_progress |
| **Load Consultation** | Button to load consultation into session |

**Behavior:**
- Sidebar disabled/dimmed when no selection
- Load Consultation calls `session.load(id)` and navigates or updates context

### 3.6 Cross-Chain Summary Button

Generate comprehensive summary spanning all chain consultations:

| Element | Description |
|---------|-------------|
| **Generate Comprehensive Summary** | Button; triggers `summary.generateComprehensiveSummary({ includeNER })` |
| **Loading state** | Spinner during generation |
| **Result** | Summary displayed in card or modal |

**Behavior:**
- Available when chain has multiple consultations
- May be placed in multi-doctor workflow or consultation timeline

### 3.7 Shared Context Panel

Context items shared between doctors in the chain:

| Element | Description |
|---------|-------------|
| **Load Shared Context** | Button to `context.loadSharedContext()` |
| **Context list** | Items with type badge, content preview, timestamp |
| **Versions** | Link to view context item versions |

**Behavior:**
- Shown in appointment-view and multi-doctor-workflow
- Shared context from referring doctor's consultation

---

## 4. API Endpoints

Base URL: `/api/v1`. All endpoints require JWT or API Key.

| Method | Endpoint | Description | Request | Response |
|--------|----------|-------------|---------|----------|
| GET | `/consultations/patient/:patientId/history` | Patient consultation history | Query: `page, limit` | `Consultation[]` |
| GET | `/consultations/patient/:patientId/date/:date` | Consultations by patient and date | — | `Consultation[]` |
| GET | `/consultations/:id/chain` | Get consultation chain | — | `ConsultationChain` |
| GET | `/consultations/:id/timeline` | Timeline events | Query: `scope=single\|chain` | `TimelineEntry[]` |
| GET | `/consultations/:id/context/shared` | Shared context from referring doctor | — | `ContextItem[]` |
| POST | `/consultations/:id/summary/comprehensive` | Generate cross-chain summary | `{ includeNER? }` | Summary or jobId |
| POST | `/consultations/:parentId/revisit` | Create follow-up consultation | `{ appointmentDate?, metadata? }` | `Consultation` |

---

## 5. SDK Integration

### 5.1 Hooks

| Hook | Purpose |
|------|---------|
| `useArca()` | Main entry: `session`, `context`, `summary` |
| `useArca().session` | `getPatientHistory`, `findByPatientDate`, `getTimeline`, `load` |
| `useArca().context` | `loadSharedContext` |
| `useArca().summary` | `generateComprehensiveSummary` |

### 5.2 Key Methods

```typescript
// Get patient history to build chain
const history = await session.getPatientHistory('patient-456');

// Find consultations by patient and date
const consultations = await session.findByPatientDate(patientId, date);

// Get timeline for consultation chain
const timeline = await session.getTimeline('chain');

// Load a specific consultation
await session.load(consultationId);

// Load shared context from referring doctor
const shared = await context.loadSharedContext();

// Generate comprehensive cross-chain summary
await summary.generateComprehensiveSummary({ includeNER: true });
```

### 5.3 Types

```typescript
interface Consultation {
  id: string;
  patientId: string;
  doctorId: string;
  doctorName?: string;
  department?: string;
  appointmentDate: string;
  status?: string;
  isNew?: boolean;
  parentConsultationId?: string;
  consultationType?: 'NEW' | 'REVISIT' | 'REFERRAL';
  createdAt: string;
  updatedAt: string;
}

interface TimelineEntry {
  id: string;
  consultationId: string;
  type: string;
  timestamp: string;
  description: string;
  doctor?: string;
  department?: string;
}

interface ConsultationChain {
  consultation: Consultation;
  children: ConsultationChain[];
}
```

---

## 6. Data Models

### Consultation

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `patientId` | string | Patient MRN |
| `doctorId` | UUID | FK to User |
| `parentConsultationId` | UUID? | FK to parent (for chains) |
| `consultationType` | enum | NEW, REVISIT, REFERRAL |
| `appointmentDate` | date | Appointment date |
| `departmentId` | UUID? | FK to Department |
| `status` | enum | open, in_progress, completed |
| `createdAt` | timestamp | Created |
| `updatedAt` | timestamp | Updated |

### TimelineEntry

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Event ID |
| `consultationId` | UUID | FK |
| `type` | string | consultation_opened, transcription_completed, summary_generated, referral_created, shared_context_loaded, comprehensive_summary |
| `timestamp` | datetime | Event time |
| `description` | string | Human-readable description |
| `metadata` | json? | Additional data |

### ConsultationChain

| Field | Type | Description |
|-------|------|-------------|
| `consultation` | Consultation | Root or node consultation |
| `children` | ConsultationChain[] | Child nodes (referrals, follow-ups) |

---

## 7. Existing Implementation

### consultation-timeline.tsx

| Component | Description |
|-----------|-------------|
| **ChainTreeView** | Patient lookup, chain tree, consultation detail sidebar, chain summary stats |
| **ChainTreeNode** | Recursive tree node with expand/collapse, type badges |
| **EventTimelineView** | Type filter buttons, date separators, event cards |
| **DemoPageShell** | Tabs: Chain Tree, Event Timeline |

### appointment-view.tsx

| Component | Description |
|-----------|-------------|
| **3-column layout** | Patient/date selector; consultations list; timeline; shared context |
| **Patient History** | List of consultations by patient |
| **Find All for Date** | Consultations on specific date |
| **Shared Context** | Load and display shared context with version links |
| **Consultation Chain Timeline** | Load timeline for current consultation |

### multi-doctor-workflow.tsx

| Component | Description |
|-----------|-------------|
| **8-step guided flow** | Doctor A opens → documents → pre-summary → Doctor B opens → load shared context → find related → summary with NER → comprehensive summary |
| **Shared Context card** | Displays loaded shared context items |
| **Related Consultations** | List of consultations for patient on date |
| **Current Consultation** | Doctor, department, type, created time |

### Mock Data

- **MOCK_CHAINS**: Original (cons-001) → Referral (cons-002) → Follow-up (cons-004); Follow-up (cons-003)
- **MOCK_FLAT_TIMELINE**: 10 events across 4 consultations

---

## 8. UX Best Practices

| Practice | Implementation |
|----------|----------------|
| **Color-coded chain types** | Original (blue), Referral (emerald), Follow-up (amber) |
| **Tree structure clarity** | Connecting lines, indentation, expand/collapse |
| **Active consultation highlight** | Pulse badge for in_progress |
| **Chronological event view** | Date separators, clear timestamps |
| **One-click load** | Load Consultation loads into session for immediate use |
| **Shared context visibility** | Clear list with type, preview, versions |
| **Empty states** | Helpful message when no chain or no selection |
| **Responsive layout** | Sidebar stacks below tree on smaller screens |
