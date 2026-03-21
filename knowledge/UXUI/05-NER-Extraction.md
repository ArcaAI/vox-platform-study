# 05 — Medical NER Extraction

> **Wireframe**: Entity Extraction & Annotation Panel  
> **Last Updated**: 2026-02-26  
> **Status**: Design Specification  
> **Related Pages**: `ner-entities.tsx`

---

## 1. Overview

The Medical NER (Named Entity Recognition) Extraction panel enables automatic extraction of medical named entities from consultation transcripts and summaries. The system identifies medications, conditions, procedures, anatomy, dosage, frequency, lab tests, and symptoms with confidence scores and optional ICD-10/SNOMED CT coding. Extracted entities are displayed in multiple views: annotated transcript, entity list, and statistics dashboard.

### Core Business Flow

```
Transcript/Summary available → Trigger NER extraction (sync or async) →
Entities extracted with confidence & codes → Doctor reviews/edits →
Optional: Flag incorrect entities for model improvement
```

### Entity Types Supported

| Type | Description | Example |
|------|-------------|---------|
| MEDICATION | Drug names | Metformin, Lisinopril, Ibuprofen |
| CONDITION | Diagnoses, diseases | Type 2 Diabetes, Osteoarthritis |
| PROCEDURE | Medical procedures | ECG, corticosteroid injection |
| ANATOMY | Body parts | left knee |
| DOSAGE | Medication dosage | 500mg, 10mg |
| FREQUENCY | Dosing frequency | twice daily, once daily |
| LAB_TEST | Laboratory tests | HbA1c, lipid panel |
| SYMPTOM | Patient-reported symptoms | nausea, chest tightness |

---

## 2. User Stories

| # | Persona | Story | Priority |
|---|---------|-------|----------|
| 14 | Doctor | The system to extract medical named entities (medications, conditions, procedures) from transcripts automatically, so that clinical data is structured. | — |
| 149 | Doctor | The NER extraction to run automatically after I approve a summary, so that the structured medical entities (medications, conditions, procedures) are extracted from my finalized content. | **Medium** |
| 150 | Doctor | To flag specific named entities as incorrect and provide the correct entity, so that the NER model's training data is improved over time. | **Low** |

### Full Story Text

- **#14**: As a **doctor**, I want the system to extract medical named entities (medications, conditions, procedures) from transcripts automatically, so that clinical data is structured.
- **#149**: As a **doctor**, I want the NER extraction to run automatically after I approve a summary, so that the structured medical entities (medications, conditions, procedures) are extracted from my finalized content.
- **#150**: As a **doctor**, I want to flag specific named entities as incorrect and provide the correct entity, so that the NER model's training data is improved over time.

---

## 3. Wireframe Description

### 3.1 Filter Sidebar

A collapsible sidebar on the left for filtering entities by type:

| Element | Description |
|---------|-------------|
| **All Types** | Button to show all entities (no filter); displays total count |
| **Entity type toggles** | One button per entity type (MEDICATION, CONDITION, PROCEDURE, etc.) with icon and count |
| **Active state** | Selected type uses background color matching entity type; others dimmed |
| **Collapse toggle** | Chevron to expand/collapse the filter panel |
| **New Extraction** | Button to reset and run a new extraction |

**Behavior:**
- Clicking a type filters the Annotated view (highlights only that type) and Entity List view (shows only that type)
- Statistics view is not filtered by type
- Counts update dynamically when entity type filter changes

### 3.2 Annotated Transcript View

Full transcript with inline color-coded entity highlights:

| Element | Description |
|---------|-------------|
| **Transcript text** | Full source text with whitespace preserved |
| **Entity spans** | Inline spans with type-specific background colors (e.g., blue for MEDICATION, red for CONDITION) |
| **Filtered state** | When a type is selected, non-matching entities use `opacity-30` |
| **Hover tooltip** | On hover: type label, confidence badge (e.g., 98%), normalized text, ICD-10, SNOMED codes |
| **Ring highlight** | Hovered entity shows `ring-2 ring-primary` for focus |

**Behavior:**
- Segments built from sorted entities by `startOffset`; non-entity text between spans
- Tooltip positioned above span to avoid overflow
- Click on entity opens Entity Detail Card (optional enhancement)

### 3.3 Entity List View

Grouped list of entities by type:

| Element | Description |
|---------|-------------|
| **Group cards** | One card per entity type (MEDICATION, CONDITION, etc.) with icon and count badge |
| **Entity row** | Each entity: text, confidence badge, normalized text, ICD-10, SNOMED, copy button |
| **Copy button** | Copies entity text + codes to clipboard; shows check icon briefly on success |
| **Filtered view** | When type filter active, only that type's card is shown |

**Behavior:**
- Entities grouped by type; types sorted by count (descending)
- Each row uses type-specific background color for quick scanning
- Copy formats: `Entity | Normalized | ICD-10: X | SNOMED: Y`

### 3.4 Statistics Dashboard

Aggregate metrics and visualizations:

| Element | Description |
|---------|-------------|
| **Total Entities** | Large number; total count of extracted entities |
| **Entity Types** | Count of distinct entity types present |
| **Avg Confidence** | Mean confidence as percentage (e.g., 85%) |
| **With Medical Codes** | Count of entities with ICD-10 or SNOMED CT codes |
| **Distribution bar chart** | Horizontal bars per type with percentage; type-specific colors |
| **Medical codes table** | Table: Entity, Type, Normalized, ICD-10, SNOMED CT for entities with codes |

**Behavior:**
- Stats computed from current entity set
- Distribution sorted by count descending
- Table only shows entities with at least one code

### 3.5 Entity Detail Card

On hover or click of an entity:

| Element | Description |
|---------|-------------|
| **Type** | Entity type label with icon |
| **Confidence** | Badge (e.g., 98%) |
| **Normalized text** | Standardized form if available |
| **ICD-10** | Code if mapped |
| **SNOMED** | Code if mapped |
| **Flag as Incorrect** | Button to open correction flow |

**Behavior:**
- Card appears as tooltip on hover or in sidebar on click
- Flag as Incorrect triggers correction form modal

### 3.6 Flag Incorrect Flow

Correction form for improving NER model:

| Element | Description |
|---------|-------------|
| **Original entity** | Read-only display of entity text, type, confidence |
| **Correct entity** | Text input for the correct entity text |
| **Reason** | Optional dropdown or text: "Wrong type", "Wrong medication", "Spelling error", "Other" |
| **Submit** | Sends feedback to `POST /feedback/labels` or `POST /fedl/updates/submit` |
| **Cancel** | Closes modal without submitting |

**Behavior:**
- Submits feedback label for model training
- Success toast; entity optionally marked as "flagged" in UI (strikethrough or badge)

---

## 4. API Endpoints

Base URL: `/api/v1`. All endpoints require JWT or API Key.

| Method | Endpoint | Description | Request | Response |
|--------|----------|-------------|---------|----------|
| POST | `/consultations/:id/summary/:contextItemId/extract-entities` | Extract entities (sync) | — | 204 No Content |
| POST | `/consultations/:id/summary/:contextItemId/extract-entities/async` | Extract entities (async) | — | `{ jobId }` |
| GET | `/consultations/:id/named-entities` | Get aggregate named entities | Query: `scope=single\|chain` | `NamedEntity[]` |
| GET | `/consultations/:id/context/:itemId/named-entities` | Get entities for context item | — | `NamedEntity[]` |
| POST | `/nlp/classify/tokens` | Token-level NER (NLP proxy) | `{ tokens, ... }` | NER result |
| POST | `/nlp/classify/text` | Text-level NER (NLP proxy) | `{ text, ... }` | NER result |
| POST | `/feedback/labels` | Submit feedback labels | `{ labels: FeedbackLabel[] }` | 201 |
| POST | `/fedl/updates/submit` | Submit FedL weight updates | FedL payload | 202 |

---

## 5. SDK Integration

### 5.1 Hooks

| Hook | Purpose |
|------|---------|
| `useArca()` | Main entry: `summary`, `context`, `summary.generateSummary`, `context.extractEntities` |
| `useArca().summary` | `generateSummary({ includeNER: true })`, `context.triggerEntityExtraction()` |
| `useArca().context` | `extractEntities()`, `getNamedEntities()` |

### 5.2 Key Methods

```typescript
// Generate summary with NER extraction enabled
const result = await summary.generateSummary({
  includeNER: true,
  promptTemplateId: 'clinical-note-v2',
});
const entities = result.nerEntities;

// Trigger entity extraction on context item
await context.extractEntities(contextItemId);

// Get named entities
const entities = await context.getNamedEntities({ scope: 'chain' });
```

### 5.3 Types

```typescript
interface NEREntity {
  id: string;
  text: string;
  type: 'MEDICATION' | 'CONDITION' | 'PROCEDURE' | 'ANATOMY' | 'DOSAGE' | 'FREQUENCY' | 'LAB_TEST' | 'SYMPTOM';
  confidence: number;
  startOffset: number;
  endOffset: number;
  normalizedText?: string;
  icdCode?: string;
  snomedCode?: string;
}

interface MedicalEntity {
  text: string;
  type: string;
  confidence: number;
  normalizedText?: string;
  icdCode?: string;
  snomedCode?: string;
}

interface MedicalCodes {
  icd10?: string;
  snomed?: string;
}
```

---

## 6. Data Models

### NamedEntity

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `consultationId` | UUID | FK to Consultation |
| `contextItemId` | UUID | FK to ContextItem (source) |
| `text` | string | Raw entity text |
| `type` | enum | MEDICATION, CONDITION, PROCEDURE, etc. |
| `confidence` | float | 0–1 |
| `startOffset` | int | Start character offset in source |
| `endOffset` | int | End character offset |
| `normalizedText` | string? | Standardized form |
| `icdCode` | string? | ICD-10 code |
| `snomedCode` | string? | SNOMED CT code |
| `createdAt` | timestamp | Created timestamp |

### ContextItem

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `consultationId` | UUID | FK |
| `type` | enum | TRANSCRIPT, SUMMARY, CASE_NOTE |
| `content` | text | Source text |
| `source` | enum | USER, STT, SMR, NLP |

### FeedbackLabel

| Field | Type | Description |
|-------|------|-------------|
| `entityId` | string | Reference to flagged entity |
| `originalText` | string | Original entity text |
| `correctText` | string | User-provided correction |
| `reason` | string? | Correction reason |
| `userId` | UUID | Submitting user |

---

## 7. Existing Implementation

### Current Page: `ner-entities.tsx`

| Component | Description |
|-----------|-------------|
| **DemoPageShell** | Wrapper with title, description, tabs, code example |
| **AnnotatedTranscriptView** | Inline segments with hover tooltips; filter by type |
| **EntityListView** | Grouped by type; confidence badge, copy button |
| **StatisticsView** | 4 stat cards, distribution bar chart, medical codes table |
| **Filter Sidebar** | Collapsible; All Types + per-type toggles with counts |

### Entity Types (8)

MEDICATION, CONDITION, PROCEDURE, ANATOMY, DOSAGE, FREQUENCY, LAB_TEST, SYMPTOM — each with icon, color, label.

### Mock Data

- 23 entities in sample transcript (Metformin, HbA1c, Type 2 Diabetes, Osteoarthritis, etc.)
- Mock transcript: ~70 lines of doctor-patient dialogue

### Gaps vs. User Stories

| Gap | Stories | Description |
|-----|---------|-------------|
| No flag-as-incorrect UI | #150 | No "Flag as Incorrect" button or correction form |
| No auto-trigger after approval | #149 | NER must be manually triggered; no hook from summary approval |
| No real-time NER during transcription | — | NER runs on summary/transcript; not streamed during live transcription |
| Mock data only | — | Uses `MOCK_NER_RESULT`; no real API integration in demo |

---

## 8. UX Best Practices

| Practice | Implementation |
|----------|----------------|
| **Color-coded entity types** | Consistent, accessible colors per type (blue=medication, red=condition, etc.) |
| **Confidence visibility** | Badge on every entity; green ≥95%, yellow 85–95%, red &lt;85% |
| **Hover tooltips** | Show confidence, normalized text, codes on hover; avoid clutter |
| **Copy to clipboard** | One-click copy of entity + codes for EHR paste |
| **Filter by type** | Quick focus on medications or conditions |
| **Statistics at a glance** | Total, avg confidence, coded count visible without scrolling |
| **Flag incorrect flow** | Clear form; original + correction + reason; success feedback |
| **Responsive layout** | Sidebar collapses on mobile; tabs stack vertically |
