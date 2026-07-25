# TASK-221: Dashboard Refactor & Core Business User Stories

> **Ticket**: TASK-221
> **Created**: 2026-02-24
> **Last Updated**: 2026-02-24
> **Status**: Completed

---

## Table of Contents

1. [Requirement Analysis](#requirement-analysis)
2. [Implementation Summary — Dashboard Refactor](#implementation-summary--dashboard-refactor)
3. [Entity Deep Analysis](#entity-deep-analysis)
4. [Core Business Flow Analysis](#core-business-flow-analysis)
5. [Gap Analysis](#gap-analysis)
6. [User Stories — Initial 100](#user-stories--initial-100)
7. [User Stories — Core Business Deep-Dive (Next 50)](#user-stories--core-business-deep-dive-next-50)
8. [Change History](#change-history)

---

## Requirement Analysis

### Part 1: Dashboard Refactor

Refactor the SDK example Vite app (`packages/agentic-sdk-v2/examples/vite-app`) from a top navigation bar layout to a **shadcn/ui dashboard-01 sidebar pattern**, leveraging the shared `@arcaai/ui` Sidebar component.

### Part 2: User Story Generation

Produce a comprehensive inventory of user stories covering:
- All 100 stories across the full platform surface area
- 50 additional stories focused on the **core business entities**: Doctor, Department, Prompt, Summary/Pre-Summary, and the medical consultation workflow

### Business Context

HOPE is a healthcare AI platform for medical conversation capture, transcription, and summarization. The core business flow is:

```
Doctor opens consultation → Records audio → STT transcribes →
Case notes added → Pre-summary generated (from history) →
Full summary generated (from transcript + department prompt + DNA style) →
Doctor reviews/edits → NER extraction → Consultation finalized
```

---

## Implementation Summary — Dashboard Refactor

### Files Created

| File | Purpose |
|------|---------|
| `src/components/app-sidebar.tsx` | Sidebar with 4 nav groups (Getting Started, Doctor Workflows, Admin, Dev Tools), collapsible Admin sub-menu, NavUser dropdown with auth status and impersonation support |
| `src/components/site-header.tsx` | Header with SidebarTrigger, dynamic breadcrumbs, theme toggle, connection badge, API settings, impersonation banner |

### Files Modified

| File | Change |
|------|--------|
| `src/App.tsx` | Replaced `<Navigation>` top-bar with `<SidebarProvider>` + `<AppSidebar>` + `<SidebarInset>` layout; flattened admin routes from nested to flat |
| 24 page files | Replaced `container mx-auto px-4` with `px-4 lg:px-6` (content width now handled by SidebarInset) |
| `src/components/page-skeleton.tsx` | Same container class update |
| `src/__tests__/plan-a-validation.test.ts` | Updated navigation tests to reference new sidebar/header components; updated route count from 25→24 (flat admin routes) |

### Architecture Decision

Used the `@arcaai/ui` shared package's `Sidebar*` components (`SidebarProvider`, `SidebarInset`, `SidebarMenu`, `SidebarMenuButton`, `Collapsible`, `DropdownMenu`) rather than building custom sidebar components — follows shadcn/ui dashboard-01 best practices.

### Verification

- TypeScript: 0 errors
- Vite build: Success
- Validation tests: 212/212 pass
- Pre-existing failures: 347 tests with `React is not defined` (not introduced by this change)

---

## Entity Deep Analysis

### 1. Doctor (User Entity)

**Schema**: `packages/database/src/prisma/db_main/user.prisma`

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID v7 | Primary key |
| `username` | String (unique) | Login identity |
| `password` | String | Hashed password |
| `isServiceAccount` | Boolean | Differentiates human vs machine users |
| `externalId` | String (unique) | OAuth/SSO identifier |
| `lastLoginAt` | DateTime | Last login timestamp |
| `lastActiveAt` | DateTime | Last activity timestamp |
| `tenantId` | UUID | Multi-tenant scope |

**Related Entities**:
- `UserProfile` (1:1) — firstName, lastName, email, phone, avatar
- `UserSettings` (1:N) — Key-value preferences (namespace-scoped)
- `UserRoleAssignment` (N:M) — Links to RBAC roles, optionally tenant-scoped
- `DnaWritingStyleReport` (1:N) — Personalized writing style per doctor
- `Consultation` (1:N) — As doctorId

**Identified Gaps**:
1. No `departmentId` on User — doctor-department association only exists through Consultation, not directly on User entity
2. `fetchAllByTenantId()` is **not implemented** (throws `NotImplementedException`)
3. No UserProfile service — profile CRUD not exposed through a dedicated service
4. No specialization/qualification fields — no way to model doctor specialties, medical license numbers, or qualifications

### 2. Department

**Schema**: `packages/database/src/prisma/db_main/department.prisma`

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID v7 | Primary key |
| `code` | String | Short identifier (e.g., "SURG", "NEUR") |
| `name` | String | Display name |
| `description` | String | Description |
| `parentDepartmentId` | UUID (nullable) | Hierarchy support |
| `defaultSummaryTemplate` | String | Template name (e.g., "SOAP") |
| `preSummaryPromptId` | String | Pre-summary prompt reference |
| `newPatientPromptId` | String | New/referral patient prompt reference |
| `revisitPromptId` | String | Follow-up patient prompt reference |
| `promptConfig` | JSON | Context variables, preferred sections, abbreviation density |
| `tenantId` | UUID | Multi-tenant scope |

**Prompt Configuration Chain**:
```
Department.newPatientPromptId → PromptTemplate → LLM prompt content
Department.revisitPromptId    → PromptTemplate → LLM prompt content
Department.preSummaryPromptId → PromptTemplate → LLM prompt content
Department.promptConfig       → { contextVariables, preferredSections, abbreviationDensity }
```

**Identified Gaps**:
1. Prompt ID fields are plain strings with **no FK constraint** — invalid IDs can be stored
2. No validation that referenced prompt IDs exist in the PromptTemplate table
3. `defaultSummaryTemplate` has no enforcement of valid template names
4. No concept of department operating hours, contact info, or capacity

### 3. Prompt Template

**Schema**: `packages/database/src/prisma/db_main/prompt-template.prisma`

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID v7 | Primary key |
| `name` | String | Template name (unique per tenant) |
| `description` | String | Template description |
| `content` | Text | Full prompt text |
| `category` | Enum | SYSTEM, SUMMARY, DNA_ANALYSIS, CUSTOM |
| `variables` | JSON | Declared variables (e.g., `conversation_language`, `pre_summary_text`) |
| `departmentId` | UUID (nullable) | Associated department |
| `tags` | String[] | Filtering tags |
| `currentVersionNumber` | Int | Current version counter |
| `tenantId` | UUID | Multi-tenant scope |

**Seed Data (42 templates)**:
- 8 system templates (base, specialty overlays, JSON enforcement, retry)
- 14 department-specific summary templates (7 departments × 2: new referral + revisit)
- 15 pre-summary templates (department-specific)
- 5 DNA analysis and other templates

**Categories**:
| Category | Purpose | Count |
|----------|---------|-------|
| SYSTEM | Internal LLM instructions (base behavior, JSON constraints) | 8 |
| SUMMARY | Department-specific clinical note templates | 14 |
| DNA_ANALYSIS | Doctor writing style analysis prompts | 1+ |
| CUSTOM | User-defined templates | Variable |

**Identified Gaps**:
1. No concept of a "default" or "active" version — system picks `templates[0]` when multiple exist for a category
2. No rollback mechanism to activate a previous version as current
3. `variables` JSON has no schema validation — no enforcement of required variables or types
4. Variable substitution logic (`conversation_language`, `pre_summary_text`) is **not implemented** — templates declare variables but no service performs the substitution
5. Redundant department relationship: Department stores prompt IDs as strings, while PromptTemplate has `departmentId` FK back

### 4. Consultation & Context Items

**Schema**: `packages/database/src/prisma/db_main/consultation.prisma`

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID v7 | Primary key |
| `patientId` | String | External patient identifier (no FK) |
| `appointmentDate` | DateTime | Consultation date |
| `doctorId` | UUID (FK) | Doctor performing consultation |
| `departmentId` | UUID (nullable, FK) | Department |
| `parentConsultationId` | UUID (nullable) | Visit chain linkage |
| `metadata` | JSON | Additional structured data |
| `tenantId` | UUID | Multi-tenant scope |

**Context Item Types**:
| Type | Description | When Created |
|------|-------------|-------------|
| `AUDIO_RECORDING` | Audio recording reference | During recording |
| `TRANSCRIPT` | STT transcription output | After transcription |
| `WORKNOTE` | Doctor's private inline notes | During consultation |
| `CASE_NOTE` | Clinical notes (shared across chain) | During consultation |
| `PRE_SUMMARY` | AI pre-summary from historical case notes | Before final summary |
| `RAW_SUMMARY` | AI-generated clinical summary | After summary generation |
| `MODIFIED_SUMMARY` | Doctor-edited summary | After doctor review |
| `NAMED_ENTITY` | NER entity container | After entity extraction |
| `ATTACHMENT` | Other attachments | Anytime |

**Summary Metadata** (SummaryMeta — 1:1 with ContextItem):
- `aiModelId`, `aiModelVersion` — Which LLM was used
- `promptTemplateId`, `promptVersionNumber` — Which prompt template
- `tokensUsed`, `processingTimeMs` — Performance metrics
- `caseNoteIds[]`, `preSummaryIds[]`, `previousSummaryIds[]` — Source context references

**Identified Gaps**:
1. **No consultation status/lifecycle field** — No `status` enum (OPEN, RECORDING, TRANSCRIBING, SUMMARIZED, CLOSED, FINALIZED)
2. `patientId` is external with **no FK** — no Patient table exists; cannot validate patient existence
3. No mechanism to "close" or "finalize" a consultation to prevent further modifications
4. `dnaWritingStyleId` on ContextItem has **no FK** to DnaWritingStyleReport
5. In-memory pagination for `getByPatientAndDatePaginated` (acknowledged but not optimized)

### 5. DNA Writing Style

**Schema**: `packages/database/src/prisma/db_main/dna-writing-style.prisma`

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID v7 | Primary key |
| `doctorId` | UUID (FK) | Associated doctor |
| `reportData` | JSON | Structured analysis (formality, sentenceLength, medicalTermUsage, abbreviationStyle) |
| `styleText` | Text | Generated style description |
| `isLatest` | Boolean | Latest version flag |
| `currentVersionNumber` | Int | Version counter |
| `tenantId` | UUID | Multi-tenant scope |

**Generation Flow**:
1. Gather text samples (max 50 samples, 100K chars) from doctor's context items
2. Load `DNA_ANALYSIS` prompt template
3. Call SMR `/api/v2/generate` with samples + prompt
4. Parse response → create DnaWritingStyleReport + DnaWritingStyleVersion
5. Mark previous report `isLatest: false`

**Identified Gaps**:
1. `isLatest` flag is manually managed — race conditions possible if two generations run simultaneously
2. No mechanism to delete or archive DNA reports
3. If the doctor has no existing context items and provides no text samples, the job fails

---

## Core Business Flow Analysis

### Summary Generation Pipeline

```
┌──────────────────────────────────────────────────────────────────┐
│ CONSULTATION LIFECYCLE                                            │
│                                                                    │
│  1. Doctor opens consultation (getOrCreate)                       │
│     └─ Input: patientId, appointmentDate, doctorId, departmentId │
│                                                                    │
│  2. Audio recording                                               │
│     └─ ContextItem(AUDIO_RECORDING) + AudioRecording metadata    │
│                                                                    │
│  3. Transcription (STT Service)                                   │
│     └─ ContextItem(TRANSCRIPT) with segments, timestamps         │
│                                                                    │
│  4. Case notes / Work notes                                       │
│     ├─ ContextItem(CASE_NOTE) — shared across consultation chain │
│     └─ ContextItem(WORKNOTE) — private to this consultation      │
│                                                                    │
│  5. Pre-summary generation                                        │
│     ├─ Input: historical case notes from consultation chain       │
│     ├─ Prompt: Department.preSummaryPromptId → PromptTemplate    │
│     ├─ Call: SMR /api/v1/presummary/sync                         │
│     └─ Output: ContextItem(PRE_SUMMARY) + SummaryMeta            │
│                                                                    │
│  6. Full summary generation                                       │
│     ├─ Input: transcripts + pre-summary context                   │
│     ├─ Prompt: Department.newPatientPromptId or revisitPromptId  │
│     ├─ DNA: DnaWritingStyleReport.styleText (if available)       │
│     ├─ Call: SMR /api/v1/summary/sync                            │
│     └─ Output: ContextItem(RAW_SUMMARY) + SummaryMeta            │
│                                                                    │
│  7. Doctor review & edit                                          │
│     ├─ Input: RAW_SUMMARY content + doctor edits                 │
│     ├─ Creates: ContextItemVersion (version snapshot)            │
│     └─ Updates: ContextItem content + version number              │
│                                                                    │
│  8. NER extraction                                                │
│     ├─ Input: summary or transcript content                       │
│     ├─ Call: NLP /api/v1/classify/tokens                         │
│     └─ Output: NamedEntity records (medications, conditions, etc)│
│                                                                    │
│  9. Comprehensive summary (cross-chain, optional)                 │
│     ├─ Input: all context from linked consultations              │
│     ├─ Aggregates: summaries, transcripts, case notes, NER       │
│     └─ Output: ContextItem(RAW_SUMMARY) on requesting consult    │
│                                                                    │
│  10. ??? — NO EXPLICIT CLOSE/FINALIZE MECHANISM                   │
└──────────────────────────────────────────────────────────────────┘
```

### Prompt Resolution Chain

```
PromptResolutionService.resolve({ promptType, departmentId })
  │
  ├─ Tier 1: Department lookup
  │   ├─ promptType='pre-summary' → Department.preSummaryPromptId
  │   ├─ promptType='new-patient' → Department.newPatientPromptId
  │   └─ promptType='revisit'     → Department.revisitPromptId
  │
  └─ Tier 2: System default fallback
      └─ SYSTEM_DEFAULTS = { template: 'SOAP', promptId: 'prompt_default' }
```

### Department-Specific Prompt Structure (from seed data)

Each department prompt template follows this pattern:
```
[NOTE TO LLM]: Role definition, SAIL compliance, data restrictions
  ↓
Section headings (department-specific):
  - Surgery: Biodata → Presenting Complaints → Systemic Exam → Plan of Care → Fitness for Surgery
  - Hematology: Primary Diagnoses → Treatment History → Investigations → Clinical Summary
  - Neurology: Neurological Examination → Cognitive Assessment → Imaging Results
  ↓
Variables: {conversation_language}, {pre_summary_text}
  ↓
Output format: Structured JSON or narrative per department default
```

---

## Gap Analysis

### Critical Gaps (Blocking Core Business)

| # | Gap | Entity | Impact |
|---|-----|--------|--------|
| G1 | SMR v1 ↔ v2 endpoint mismatch | SMR Service | NestJS calls `/api/v1/summary/sync` but v2 only has `/api/v2/generate`. Summary generation may fail. |
| G2 | No medical-domain logic in SMR | SMR Service | V2 is a generic text generation wrapper; all medical summarization logic must exist elsewhere. |
| G3 | Prompt variable substitution not implemented | PromptTemplate | Templates declare `{conversation_language}`, `{pre_summary_text}` but no service performs substitution. |
| G4 | No consultation lifecycle status | Consultation | Cannot track if a consultation is open, recording, summarized, or closed. |

### High-Priority Gaps

| # | Gap | Entity | Impact |
|---|-----|--------|--------|
| G5 | DNA style not applied in SMR | DNA/SMR | `dnaStyleId` is passed but never injected into the prompt chain. |
| G6 | No FK constraints on Department prompt IDs | Department | Invalid prompt references can be stored; no referential integrity. |
| G7 | Pre-summary content not injected into final summary | Consultation | Pre-summaries are generated but the injection mechanism into the final summary prompt is missing. |
| G8 | No doctor-department direct association | User/Department | Doctor's department is only inferred from Consultation.departmentId, not from User entity. |
| G9 | JSON enforcement not integrated | SMR | `JSON_ENFORCEMENT` and `CORRECTIVE_RETRY` templates exist but aren't used in v2 service. |

### Medium-Priority Gaps

| # | Gap | Entity | Impact |
|---|-----|--------|--------|
| G10 | No Patient entity | Consultation | `patientId` is external string with no validation or FK. |
| G11 | No prompt rollback mechanism | PromptTemplate | Cannot activate a previous version as the current content. |
| G12 | In-memory pagination | Consultation | `getByPatientAndDatePaginated` fetches all then slices. |
| G13 | N+1 query in NER aggregation | Consultation | `getAggregateNamedEntities` loops over consultations × context items. |
| G14 | Missing department summary prompts | Department | Some departments (e.g., Cardiology) lack final-summary templates in seed data. |
| G15 | DNA `isLatest` race condition | DNA | Concurrent generation could leave multiple `isLatest: true` records. |
