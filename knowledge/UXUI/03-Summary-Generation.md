# 03 — Summary Generation Pipeline

> **Wireframe**: Summary Generation Pipeline  
> **Last Updated**: 2026-02-26  
> **Status**: Design Specification  
> **Related Pages**: `summary-workflow.tsx`, `summarization.tsx`

---

## 1. Overview

The Summary Generation Pipeline is the core AI-powered workflow that produces clinical documentation from consultation content. It orchestrates pre-summary injection, department prompt auto-selection, DNA style application, format selection (SOAP/Narrative), and streaming token-by-token output.

### Pipeline Flow

```
┌───────────────────────────────────────────────────────────────────────┐
│  CONTEXT CHECK — Does additional context exist?                        │
│  • Case notes added by doctor?                                        │
│  • Historical medical information from prior consultations?            │
│  • Shared context from referring doctors?                              │
│                                                                       │
│  YES → Generate Pre-Summary (editable) → inject into final prompt     │
│  NO  → Skip pre-summary, proceed directly to summary generation       │
└───────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│  INPUT ASSEMBLY                                                        │
│  • Pre-summary context (if generated; editable before use)             │
│  • Current transcript                                                 │
│  • Department prompt (auto-selected: new vs follow-up)                 │
│  • DNA writing style (auto-applied from doctor profile)                │
└───────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│  LLM GENERATION                                                       │
│  • Output format: determined by prompt template + DNA style config     │
│  • Language: matches consultation or target language                  │
│  • Include NER: optional structured entity extraction                 │
└───────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│  OUTPUT                                                               │
│  • Streaming token-by-token rendering (async jobs via SSE)             │
│  • Sync: full response when complete                                  │
│  • Async: job ID → poll or SSE for progress                           │
└───────────────────────────────────────────────────────────────────────┘
```

### Key Concepts

- **Pre-summary generation**: A pre-summary is generated **only when additional context exists** — such as case notes added by the doctor, historical medical information from prior consultations, or shared context from referring doctors. If no additional context is available beyond the current transcript, the pre-summary step is skipped entirely.
- **Department prompt auto-selection**: The system selects the correct prompt template based on the doctor's department and whether the consultation is a new patient vs follow-up.
- **DNA style application**: The doctor's personal writing style profile is automatically applied so clinical notes match their documentation preferences.
- **Output format determined by pipeline**: The summary output format (SOAP, narrative, department-specific sections, abbreviation density) is **configured in the summarization prompt template and DNA writing style** — not selected by the user at generation time. The pipeline determines the output structure.
- **Streaming output**: Async generation streams tokens in real time via SSE for immediate feedback.

---

## 2. User Stories

| # | Persona | Story | Priority |
|---|---------|-------|----------|
| 5 | Doctor | Generate a pre-summary from the consultation transcript, so that I can review an AI-drafted clinical note before finalization. | — |
| 6 | Doctor | Generate a full summary using my department's prompt template and my personal DNA writing style, so that the output matches my documentation preferences. | — |
| 127 | Doctor | A pre-summary to be automatically generated from historical case notes when I open a follow-up consultation, so that I have a concise overview of the patient's prior visits without manually reviewing each one. | **Critical** |
| 128 | Doctor | The pre-summary to be injected as context into the final summary prompt, so that the AI-generated summary incorporates historical findings and ongoing treatment plans. | **Critical** |
| 129 | Doctor | Review and edit the pre-summary before it's used as context for final summary generation, so that inaccurate historical data doesn't propagate into the current note. | High |
| 130 | Doctor | The pre-summary to indicate which past consultations contributed to it (with dates and departments), so that I can verify the source material. | High |
| 131 | Doctor | Pre-summaries to be weighted by recency and relevance (recent visits > old visits, same department > different department), so that the most pertinent history is emphasized. | Medium |
| 132 | Doctor | Regenerate a pre-summary with different weighting (e.g., include only the last 3 visits, or only visits from my department), so that I can control what historical context feeds into my summary. | Medium |
| 133 | Doctor | Pre-summaries for new/referral patients to include shared case notes from the referring doctor's consultation chain, so that the referral context is captured. | High |
| 134 | Doctor | The system to automatically select the correct prompt template based on my department and whether this is a new patient vs follow-up, so that I don't need to manually choose a template each time. | **Critical** |
| 135 | Doctor | My DNA writing style to be automatically applied when generating summaries, so that clinical notes match my personal documentation style without manual configuration. | **Critical** |
| 136 | Doctor | Choose between SOAP format and narrative format for my summary output, with the department default pre-selected, so that I can use the format I prefer. | High — **Note**: Format is configured in the pipeline (prompt template + DNA style), not selected per-generation by the user. |
| 137 | Doctor | The summary to include department-specific section headings (e.g., "Fitness for Surgery" for Surgery, "Bone Marrow Aspiration & Biopsy" for Hematology), so that the output follows my specialty's documentation standards. | High |
| 138 | Doctor | The system to retry summary generation with a corrective prompt if the initial output contains placeholders or invalid JSON, so that I receive a usable summary on the first attempt. | High |
| 139 | Doctor | Generate a summary in the same language as the consultation conversation (or a specific target language), so that documentation matches the clinical context. | High |
| 140 | Doctor | The summary to contain source attribution (which transcript segments, case notes, and pre-summaries contributed to each section), so that I can verify claims against the original content. | Medium |
| 141 | Doctor | See real-time streaming of the summary as it's generated token-by-token, so that I get immediate feedback instead of waiting for the full generation. | Medium |
| 142 | Department Head | Set a default summary format (SOAP vs narrative) and abbreviation density (high/medium/low) for my department, so that all doctors start with the department standard. | Medium |
| 143 | Doctor | Regenerate a summary with different parameters (different prompt, different DNA style, include/exclude NER) without losing the previous version, so that I can compare outputs. | Medium |

---

## 3. Wireframe Description

### 3.1 Generation Pipeline Visualization

A visual flow diagram showing how inputs combine before reaching the LLM:

```
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│  Pre-Summary     │   │  Transcript     │   │  Case Notes     │
│  (if available)  │   │  (current)      │   │  (if added)     │
└────────┬────────┘   └────────┬────────┘   └────────┬────────┘
         │                     │                     │
         └─────────────────────┼─────────────────────┘
                               │
                               ▼
         ┌─────────────────────────────────────────────┐
         │  Department Prompt (auto-selected)           │
         │  Defines: format, sections, structure        │
         └─────────────────────┬───────────────────────┘
                               │
         ┌─────────────────────┴───────────────────────┐
         │  DNA Style (auto-applied from doctor)        │
         │  Defines: tone, vocabulary, abbreviations    │
         └─────────────────────┬───────────────────────┘
                               │
                               ▼
                    ┌──────────────────┐
                    │       LLM        │
                    │  (SMR service)   │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  Summary Output  │
                    │  (format from    │
                    │   prompt + DNA)  │
                    └──────────────────┘
```

**UI placement**: Top of the Summary Generation section, collapsible card with "Pipeline" label.

### 3.2 Pre-Summary Context Panel

**This panel is conditionally shown** — it only appears when additional context exists that warrants a pre-summary.

**Trigger conditions** (any one is sufficient):
- Doctor has added case notes to the consultation
- Historical medical information exists from prior consultations (follow-up or referral)
- Shared context is available from a referring doctor's consultation chain

**When no additional context exists**: The pre-summary panel is hidden entirely. A subtle info badge reads: "No additional context available — summary will be generated from transcript only."

**When additional context exists**:
- **Context source indicators**: Badges showing what triggered the pre-summary:
  - "Case Notes" badge (with count)
  - "Prior Consultations" badge (with count and date range)
  - "Shared Context" badge (from referring doctor)
- **Editable pre-summary**: Rich text area showing the generated pre-summary. Doctor can edit before triggering full summary generation.
- **Source consultations**: Expandable list of past consultations that contributed, each with:
  - Consultation date
  - Department
  - Brief excerpt or link to full content
- **Weighting controls**: Sliders or toggles for:
  - Recency weight (recent visits emphasized)
  - Department filter (same department only, or all)
  - Max number of consultations to include (e.g., last 3, last 5)
- **Regenerate pre-summary**: Button to regenerate with current weighting.

### 3.3 Generation Options

| Control | Type | Description |
|---------|------|-------------|
| Include NER | Switch | Include named entity extraction in output. |
| Language | Select | Match consultation language or override (e.g., English, Hindi, Tamil, Malayalam). |
| DNA style | Badge | "Auto-applied" badge when doctor has a DNA profile; shows profile name and version. |
| Prompt template | Info display | Auto-selected from department config; shows template name + version. Read-only — format and structure are determined by the prompt template and DNA style. |

**Note**: There is **no output format selector** (SOAP vs Narrative). The output format, section headings, abbreviation density, and documentation structure are all determined by the **summarization prompt template** configured for the department and the **DNA writing style** of the doctor. This ensures consistency across the department and reduces decision fatigue for the doctor.

### 3.4 Streaming Output Panel

- **Token-by-token rendering**: Text appears incrementally as the LLM generates. Blinking cursor at end of stream.
- **Copy button**: Copy full summary to clipboard.
- **Regenerate button**: Regenerate with same or different options (preserves previous version).
- **Token count**: Live count of generated tokens.
- **Metadata footer**: Prompt template used, DNA style ID, processing time, model name.

### 3.5 Prompt & Department Auto-Selection

- **Auto-select logic**: Based on `departmentId` + `consultationType` (NEW / REVISIT / REFERRAL).
- **Display**: "Selected template: [Template Name] v[version]" with optional override dropdown.
- **Department override**: If doctor overrides department for this consultation, prompt selection updates accordingly.

---

## 4. API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/consultations/:id/summary/pre-summary` | Generate pre-summary from case notes (sync) |
| POST | `/consultations/:id/summary` | Generate final summary (sync) |
| POST | `/consultations/:id/summary/async` | Generate summary asynchronously (returns job ID) |
| POST | `/consultations/:id/summary/pre-summary/async` | Generate pre-summary asynchronously |
| POST | `/consultations/:id/summary/comprehensive` | Generate comprehensive cross-chain summary (sync) |
| POST | `/consultations/:id/summary/comprehensive/async` | Comprehensive summary (async) |
| GET | `/consultations/:id/summary` | List all summaries for consultation |
| GET | `/consultations/:id/summary/latest` | Get latest summary |
| GET | `/consultations/:id/summary/pre-summary/latest` | Get latest pre-summary |
| PATCH | `/consultations/:id/summary/:contextItemId` | Update summary content (creates version) |
| GET | `/consultations/jobs/:jobId` | Get job status (polling) |
| DELETE | `/consultations/jobs/:jobId` | Cancel job |
| SSE | `/consultations/jobs/:jobId/sse` | SSE stream for job updates (real-time) |
| GET | `/prompt-templates` | List prompt templates |
| GET | `/prompt-templates/:id` | Get prompt template by ID |
| GET | `/dna-writing-styles/me` | Get current user's DNA writing style |
| GET | `/consultations/:id/context/shared` | Get shared context from chain |
| GET | `/consultations/:id/context/case-notes` | Get case notes for consultation |
| POST | `/text/api/v2/generate` | SMR proxy — direct LLM generate (low-level) |
| GET | `/text/api/v2/tasks/:taskId/stream` | SMR SSE stream for task chunks |

**Note**: All endpoints use `/api/v1` prefix in production (e.g., `/api/v1/consultations/:id/summary`).

---

## 5. SDK Integration

### 5.1 Hooks

| Hook | Purpose |
|------|---------|
| `useArca()` | Main SDK hook — exposes `summary` object with all summary methods |
| `useArcaSummary()` | Focused summary hook (generate, update, history, approve) |
| `usePrompts()` | List and get prompt templates |
| `useDepartments()` | List departments, get department config |
| `useDnaStyle()` | Get current user's DNA writing style |
| `useConsultationJob()` | Poll/stream async job status |

### 5.2 Methods

```typescript
// Pre-summary
summary.generatePreSummary(options?)
summary.generatePreSummaryAsync(options?)
summary.getLatestPreSummary()

// Full summary
summary.generateSummary({ dnaStyleId, includeNER, promptTemplateId })
summary.generateSummaryAsync(options?)
summary.loadSummaries(pagination?)

// Comprehensive (cross-chain)
summary.generateComprehensiveSummary(options?)

// Job tracking (useConsultationJob)
getJob(jobId)
cancelJob(jobId)
streamJob(jobId, { onResult, onStatus, onError })
pollJob(jobId, options?)
```

### 5.3 Types

| Type | Description |
|------|-------------|
| `SummaryResponse` | `{ id, contextItemId, content, type, llmProvider, modelName, processingTimeMs, dnaStyleId, entities?, createdAt }` |
| `SummaryGenerationOptions` | `{ dnaStyleId?, includeNER?, transcript?, promptTemplateId?, departmentId? }` |
| `AsyncJobResponse` | `{ jobId, status, consultationId, createdAt, progress?, result?, errorMessage? }` |
| `ComprehensiveSummaryResponse` | `{ id, content, consultationIds, createdAt, modelName?, processingTimeMs?, dnaStyleId? }` |

---

## 6. Data Models

### ContextItem (Summary Types)

| Type | Description |
|------|-------------|
| `PRE_SUMMARY` | Pre-summary from case notes / prior consultations |
| `RAW_SUMMARY` | AI-generated summary (unmodified) |
| `MODIFIED_SUMMARY` | Doctor-edited summary |

### PromptTemplate

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `name` | string | Template name |
| `content` | string | Prompt text with variables |
| `category` | enum | SYSTEM, SUMMARY, DNA_ANALYSIS, CUSTOM |
| `departmentId` | UUID? | Optional department association |

### Department Prompt Config

| Field | Type | Description |
|-------|------|-------------|
| `newPatientPromptId` | UUID? | Prompt for new patient consultations |
| `revisitPromptId` | UUID? | Prompt for follow-up consultations |
| `summaryPromptId` | UUID? | General summary prompt |
| `preSummaryPromptId` | UUID? | Pre-summary generation prompt |

### DnaWritingStyle

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Report ID |
| `name` | string | Style name |
| `styleData` | object | Analysis results (avgSentenceLength, vocabularyComplexity, commonPhrases, etc.) |
| `userId` | UUID | Owner |

---

## 7. Existing Implementation & Gaps

### Current Implementation

- **`summary-workflow.tsx`**: Pre-summary, full summary, comprehensive summary, async generation, version history, diff comparison. Uses `useArca`, `usePrompts`, `useDepartments`.
- **`summarization.tsx`**: Streaming (SSE) and polling tabs for async summary generation. Uses `useArca`, `useConsultationJob`, `useDnaStyle`, `useDepartments`, `usePrompts`.
- **Components**: `PromptDepartmentSelector`, `AsyncJobTracker`, `StreamingTextDisplay`, `JobProgressTracker`, `DiffViewer`, `VersionTimeline`.

### Gaps vs. User Stories

| Gap | Stories | Description |
|-----|--------|-------------|
| Pre-summary not injected | #127, #128 | Backend may not inject pre-summary into final prompt (G7) |
| Pre-summary trigger logic missing | #127 | No conditional logic to generate pre-summary only when additional context (case notes, history, shared context) exists |
| DNA style not applied | #135 | SMR v2 may not apply DNA style (G5) |
| No pre-summary source attribution | #130 | Pre-summary doesn't show which consultations contributed |
| No weighting controls | #131, #132 | No UI for recency/department weighting |
| No pipeline visualization | — | No visual flow diagram in UI |
| No streaming in sync flow | #141 | Sync endpoint returns full response; streaming only via async |
| Department prompt auto-select partial | #134 | Department config exists; auto-select may not be fully wired |
| JSON/placeholder retry | #138 | Corrective retry for invalid output not implemented (G9) |

---

## 8. UX Best Practices

1. **Conditional pre-summary** — Only show the pre-summary panel when additional context exists (case notes, history, shared context). Don't clutter the UI with an empty pre-summary section.
2. **Pre-summary editable before full summary** — Doctor must be able to correct historical context before it propagates.
3. **Source attribution** — Show which consultations/case notes contributed to pre-summary with badges and expandable details.
4. **No output format selection** — Format is determined by the prompt template and DNA style, not by the user. This reduces decision fatigue and ensures department consistency.
5. **Auto-selection with override** — Department prompt and DNA style auto-applied; prompt template shown as read-only info.
6. **Streaming for long generations** — Use async + SSE for token-by-token feedback; avoid long blank waits.
7. **Regenerate preserves history** — Regenerating creates new version; previous versions remain in history.
8. **Guard rails** — Disable "Generate Summary" when no transcript exists; show tooltip explaining why.
9. **DNA badge** — "DNA style auto-applied" badge when doctor has profile; "No DNA style" when missing.
10. **Token count** — Display approximate token count during/after generation for transparency.
11. **Error recovery** — Clear error messages; retry button with same options; link to support if persistent.
