# 07 — DNA Writing Style

> **Wireframe**: DNA Style Generation & Management  
> **Last Updated**: 2026-02-26  
> **Status**: Design Specification  
> **Related Pages**: `dna-style.tsx`

---

## 1. Overview

The DNA Writing Style feature generates and manages personalized writing style profiles from a doctor's writing samples. The system analyzes the doctor's **own edited summaries** (not raw AI-generated summaries) or **ingested historical medical case notes** to produce a "DNA" report describing the doctor's documentation style (tone, structure, abbreviations, phrasing). This profile is automatically applied during summary generation so AI outputs match the doctor's preferences.

### Two Input Sources for DNA Generation

| Input Source | Description | When to Use |
|-------------|-------------|-------------|
| **Historical Edited Summaries** | Doctor selects from their past consultations where they have **manually edited** the AI-generated summary. Only `MODIFIED_SUMMARY` context items qualify — raw AI summaries are excluded. | When the doctor has existing consultation history with edited summaries in the system |
| **Ingested Case Notes** | Doctor uploads or pastes historical medical case notes (from external systems, prior EHR exports, or manually written notes) as text samples. | When the doctor is new to the system or wants to incorporate writing samples from outside the platform |

### Core Business Flow

```
OPTION A — From Edited Summaries:
  Doctor selects consultations with edited summaries →
  Reviews/confirms selected text samples →
  Combines with DNA generation prompt →
  Generates new DNA report version

OPTION B — From Ingested Case Notes:
  Doctor uploads/pastes historical case notes →
  Reviews/confirms text samples →
  Combines with DNA generation prompt →
  Generates new DNA report version

Both options → Views existing DNA report (if any) →
Selects DNA generation prompt template → Generates →
New DNA report version created; auto-applied to future summary generation
```

---

## 2. User Stories

| # | Persona | Story | Priority |
|---|---------|-------|----------|
| 15 | Doctor | Submit my writing samples to generate a DNA writing style profile, so that AI summaries match my personal documentation style. | — |
| 135 | Doctor | My DNA writing style to be automatically applied when generating summaries, so that clinical notes match my personal documentation style without manual configuration. | **Critical** |

### Full Story Text

- **#15**: As a **doctor**, I want to submit my writing samples to generate a DNA writing style profile, so that AI summaries match my personal documentation style.
- **#135**: As a **doctor**, I want my DNA writing style to be automatically applied when generating summaries, so that clinical notes match my personal documentation style without manual configuration.

---

## 3. Wireframe Description

### 3.1 Input Source Selector

A tabbed panel allowing the doctor to choose between two input sources for DNA generation:

| Element | Description |
|---------|-------------|
| **Tab: Edited Summaries** | Select from historical consultations where the doctor has manually edited summaries |
| **Tab: Ingest Case Notes** | Upload or paste historical medical case notes from external sources |
| **Active tab indicator** | Underline + accent color on selected tab |

**Behavior:**
- Default tab: "Edited Summaries" if the doctor has edited summaries in the system; otherwise "Ingest Case Notes"
- Tab selection determines the subsequent workflow steps

### 3.2 Edited Summaries Selector (Tab 1)

Panel to search and select consultations with **doctor-edited summaries only**:

| Element | Description |
|---------|-------------|
| **Search input** | Placeholder "Search consultations with edited summaries..."; filters by patientId, department, date |
| **Consultation list** | Scrollable list showing only consultations where `MODIFIED_SUMMARY` context items exist |
| **Summary preview** | On hover/select: shows the edited summary text (not the raw AI summary) |
| **Multi-select** | Checkboxes to select multiple consultations; each selected adds its edited summary to the text samples |
| **Selected count** | Badge: "3 summaries selected" with total word count |
| **Selection state** | Selected rows: border-primary, bg-primary/5, check icon |
| **Empty state** | "No edited summaries found. Edit an AI-generated summary first, or use the 'Ingest Case Notes' tab." |

**Behavior:**
- Fetches via `session.listConsultations({ hasSummary: true })`, then filters to only show consultations with `MODIFIED_SUMMARY` context items
- Raw AI summaries (`RAW_SUMMARY`) are **excluded** — only doctor-edited versions qualify
- Multiple consultations can be selected to provide more writing samples
- Selected edited summaries are collected as `textSamples[]` for DNA generation

### 3.3 Case Notes Ingestion (Tab 2)

Panel for uploading or pasting historical medical case notes:

| Element | Description |
|---------|-------------|
| **Text input area** | Large multi-line textarea; placeholder "Paste your historical medical case notes here..." |
| **Add more** | Button to add additional text input areas (up to 10 samples) |
| **File upload** | Drag-and-drop zone for `.txt`, `.docx`, `.pdf` files containing case notes |
| **Sample list** | Cards showing each ingested sample with preview, word count, and remove button |
| **Total samples** | Badge: "5 samples ingested" with total word count |
| **Minimum requirement** | Info text: "Provide at least 3 writing samples (minimum 500 words total) for accurate DNA analysis" |

**Behavior:**
- Text pasted directly or extracted from uploaded files
- Each sample stored as a separate entry in `textSamples[]`
- Minimum validation: at least 3 samples, at least 500 words total
- Samples are NOT persisted as context items — they are used only for DNA generation

### 3.4 Text Samples Review

Unified review step for both input sources:

| Element | Description |
|---------|-------------|
| **Sample cards** | Each selected/ingested sample shown as a card with source badge ("Edited Summary" or "Ingested Note"), word count, and expandable full text |
| **Edit capability** | Each sample can be edited inline before generation |
| **Remove button** | Remove individual samples from the generation input |
| **Total statistics** | Total samples, total word count, estimated analysis quality (Low/Medium/High based on volume) |
| **Next button** | Advances to Existing Report step; disabled if below minimum threshold |

**Behavior:**
- Combines samples from either tab into a unified review
- Doctor can edit, remove, or reorder samples
- Quality indicator encourages providing more samples for better results

### 3.5 Existing DNA Report Display

Shows current DNA report for the doctor (if any):

| Element | Description |
|---------|-------------|
| **Version** | e.g., "v3" |
| **Updated** | Last updated date |
| **Current Style** | Read-only block of style text |
| **Next button** | Advances to Generate step |
| **No report state** | "No existing DNA style report found for this doctor" |

**Behavior:**
- Fetched via `dna.getByDoctor(consultation.doctorId)`
- If no report, skip display and advance

### 3.6 Prompt Template Selector

Choose a DNA analysis prompt template (optional):

| Element | Description |
|---------|-------------|
| **Template list** | Cards with name, optional description |
| **Selection state** | Selected: border-primary, bg-primary/5, check icon |
| **Default** | "No DNA analysis prompt templates available. The default template will be used." |

**Behavior:**
- Fetched via `prompts.list({ category: 'DNA_ANALYSIS' })`
- Optional; if none selected, backend uses default

### 3.7 Generation with Job Tracking

| Element | Description |
|---------|-------------|
| **Summary Input preview** | Line-clamped preview of edited summary |
| **Generate DNA Writing Style** | Primary button; disabled if no summary or generating |
| **JobProgressTracker** | Status, progress bar, current step, started/completed time, cancel button |
| **Cancel** | Cancels in-progress job via `cancelJob(jobId)` |

**Behavior:**
- `dna.generate({ textSamples: [editedSummary], promptTemplateId })` returns `{ jobId }`
- `dna.pollJobStatus(jobId)` until complete
- On success, advances to Results step

### 3.8 Results Panel

| Element | Description |
|---------|-------------|
| **Version badge** | e.g., "v4" |
| **Generated in Xs** | Elapsed time |
| **Generated DNA Style** | Full style text block |
| **Changes from Previous Version** | DiffViewer: removed (red), added (green) |
| **Version History** | VersionTimeline: version, date, change reason, change source |

**Behavior:**
- Diff computed client-side: `computeSimpleDiff(existingReport.styleText, generatedReport.styleText)`
- Versions from `dna.getVersions(report.id)`

### 3.9 Vertical Stepper

6 steps with labels and descriptions:

| Step | Label | Description |
|------|-------|-------------|
| 0 | Select Input Source | Choose between "Edited Summaries" or "Ingest Case Notes" and select/provide writing samples |
| 1 | Review Samples | Review, edit, and confirm the selected text samples |
| 2 | Existing DNA Report | View the current DNA writing style report (if any) |
| 3 | Select Prompt | Choose a DNA generation prompt template |
| 4 | Generate | Submit for generation with job tracking |
| 5 | Results | View the generated DNA writing style report, diff, and version history |

**Behavior:**
- `VerticalStepper` component with `currentStep`; content rendered per step
- Steps advance on user action (select, next, generate complete)
- Step 0 content changes based on selected tab (Edited Summaries vs Ingest Case Notes)

### 3.10 Status Bar

| Element | Description |
|---------|-------------|
| **Service Status** | Badge: healthy / degraded |
| **Active sessions** | Count from monitoring |
| **Running Jobs** | Count of processing jobs |
| **Total Reports** | Count of DNA reports (1 if current user has one) |

**Behavior:**
- Uses `useMonitoring()`, `useHealthCheck()`, `useDnaStyle()`

---

## 4. API Endpoints

Base URL: `/api/v1`. All endpoints require JWT.

| Method | Endpoint | Description | Request | Response |
|--------|----------|-------------|---------|----------|
| POST | `/dna-writing-styles/generate` | Queue DNA generation | `{ textSamples, promptTemplateId? }` | `{ jobId }` |
| GET | `/dna-writing-styles/my-style` | Get current user's DNA style | — | `DnaReport` |
| GET | `/dna-writing-styles/doctor/:doctorId` | Get DNA style by doctor | — | `DnaReport` |
| PATCH | `/dna-writing-styles/:reportId` | Update DNA report | `{ styleText?, changeReason? }` | `DnaReport` |
| GET | `/dna-writing-styles/:reportId/versions` | Version history | — | `DnaStyleVersion[]` |
| POST | `/admin/dna-writing-styles/generate/:doctorId` | Admin: generate for doctor | `{ textSamples?, promptTemplateId? }` | `{ jobId }` |
| GET | `/admin/dna-writing-styles/jobs/:jobId` | Admin: job status | — | Job status |
| GET | `/prompt-templates` | List templates | Query: `category=DNA_ANALYSIS` | `PromptTemplate[]` |
| GET | `/consultations/jobs/:jobId` | Job status (consultation jobs) | — | Job status |

---

## 5. SDK Integration

### 5.1 Hooks

| Hook | Purpose |
|------|---------|
| `useDnaStyle()` | `generate`, `getMyStyle`, `getByDoctor`, `pollJobStatus`, `update`, `getVersions` |
| `usePrompts()` | `list({ category: 'DNA_ANALYSIS' })` |
| `useConsultationJob()` | `cancelJob` |
| `useArca()` | `session`, `summary` for loading consultation and summaries |
| `useMonitoring()` | Active sessions, processing jobs |
| `useHealthCheck()` | Service health status |

### 5.2 Key Methods

```typescript
// OPTION A: Load edited summaries from consultations
await session.load(consultationId);
const summaries = await summary.loadSummaries();
// Filter to only MODIFIED_SUMMARY items (doctor-edited, not raw AI)
const editedSummaries = summaries.filter(s => s.type === 'MODIFIED_SUMMARY');

// OPTION B: Ingested case notes are provided directly as text strings
const ingestedNotes = ['Case note 1 text...', 'Case note 2 text...'];

// Combine selected samples (from either option)
const textSamples = [...editedSummaryTexts, ...ingestedNotes];

// Get existing DNA report
const existing = await dna.getMyStyle();
const byDoctor = await dna.getByDoctor(doctorId);

// List DNA prompt templates
const prompts = await prompts.list({ category: 'DNA_ANALYSIS' });

// Generate new DNA report with combined samples + selected prompt
const { jobId } = await dna.generate({
  textSamples,
  promptTemplateId: selectedPromptId,
});

// Poll until complete
const report = await dna.pollJobStatus(jobId);

// Cancel job
cancelJob(jobId);

// Update report
await dna.update(reportId, { styleText, changeReason });

// Get version history
const versions = await dna.getVersions(reportId);
```

### 5.3 Types

```typescript
interface DnaReport {
  id: string;
  doctorId: string;
  styleText: string;
  reportData?: object;
  currentVersionNumber: number;
  createdAt: string;
  updatedAt: string;
}

interface DnaStyleVersion {
  versionNumber: number;
  createdAt: string;
  changeReason?: string;
  changedBy?: string;
}

interface DnaGenerateInput {
  textSamples: string[];
  promptTemplateId?: string;
}

interface DnaUpdateInput {
  styleText?: string;
  changeReason?: string;
}
```

---

## 6. Data Models

### DnaWritingStyle (DnaReport)

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `doctorId` | UUID | FK to User |
| `tenantId` | UUID | FK to Tenant |
| `styleText` | text | Generated style description |
| `reportData` | json? | Additional analysis data |
| `currentVersionNumber` | int | Current version |
| `createdAt` | timestamp | Created |
| `updatedAt` | timestamp | Updated |

### DnaStyleVersion

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `dnaReportId` | UUID | FK to DnaWritingStyle |
| `versionNumber` | int | Version number |
| `styleText` | text | Snapshot of style at version |
| `changeReason` | string? | Reason for change |
| `changedBy` | string? | User or system |
| `createdAt` | timestamp | Created |

---

## 7. Existing Implementation

### dna-style.tsx

| Component | Description |
|-----------|-------------|
| **DemoPageShell** | Title, description, tabs, statusBar, code example |
| **VerticalStepper** | 5 steps; renders step content based on `activeStep` |
| **StatusBar** | Service health, running jobs, total reports |
| **ConsultationSelector** | Search, list, selection; `listConsultations({ hasSummary: true })` |
| **JobProgressTracker** | Job ID, status, progress, cancel |
| **VersionTimeline** | Version history with select |
| **DiffViewer** | Line-by-line diff (added/removed) |

### Workflow Steps (Current — needs update)

1. **Select Consultation** — ConsultationSelector; on select loads consultation, summaries, existing report; advances to step 1
2. **Review Summary** — Original summary + editable textarea; Next to step 2
3. **Existing Report** — Version, updated date, style text; Next to step 3
4. **Generate** — Prompt selector, summary preview, Generate button, JobProgressTracker
5. **Results** — Generated style, diff from previous, version history

### Gaps vs. User Stories

| Gap | Stories | Description |
|-----|---------|-------------|
| No dual input source | #15 | Current UI only supports selecting a consultation summary; no option to ingest external case notes |
| Uses raw summaries | #15 | Current selector shows all summaries including raw AI-generated; should filter to MODIFIED_SUMMARY only |
| No multi-select | #15 | Can only select one consultation's summary; should allow multiple for richer DNA analysis |
| No case notes ingestion | #15 | No text input or file upload for historical case notes from external systems |
| No auto-apply indicator in summary UI | #135 | Summary generation UI does not show that DNA style is being applied |
| No "my style" quick view | — | No shortcut to view current user's DNA report without full workflow |
| No admin generate-for-doctor UI | — | Admin endpoints exist but no admin UI to generate for another doctor |

---

## 8. UX Best Practices

| Practice | Implementation |
|----------|----------------|
| **Dual input sources** | Clearly separate "Edited Summaries" and "Ingest Case Notes" tabs so doctors understand both options |
| **Edited summaries only** | Exclude raw AI-generated summaries from selection — only doctor-edited versions reflect the doctor's actual writing style |
| **Multi-select for richer analysis** | Allow selecting multiple consultations' edited summaries for more comprehensive DNA profiling |
| **Case notes ingestion** | Support both paste and file upload for historical notes from external systems |
| **Minimum sample threshold** | Show quality indicator (Low/Medium/High) based on sample volume; encourage 3+ samples with 500+ words |
| **Step-by-step guidance** | Vertical stepper with clear labels and descriptions; 6 steps for the updated workflow |
| **Editable samples** | Allow doctor to refine text samples before generation |
| **Existing report context** | Show current version so doctor knows what will change |
| **Prompt template choice** | Optional; default used if none selected |
| **Job progress visibility** | Progress bar, status, cancel for long-running jobs |
| **Diff view** | Clear visualization of changes from previous version |
| **Version history** | Audit trail of all DNA report versions |
| **Status bar** | Service health and job counts for awareness |
