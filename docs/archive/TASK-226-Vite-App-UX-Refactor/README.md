# TASK-226 — Vite Example App UX Refactor

> **Ticket**: TASK-226
> **Created**: 2026-02-26
> **Last Updated**: 2026-02-26
> **Status**: Pending

---

## 1. Requirement Analysis

Refactor the Vite example app (`packages/agentic-sdk-v2/examples/vite-app/`) to align with the 8 UX/UI wireframe specifications in `knowledge/UXUI/`. Key changes:

- **Separate consultation and transcription pages** per audio workflow (Local / Remote) — no toggle/switcher
- **Conditional pre-summary** — only shown when additional context exists
- **Pipeline-driven output format** — no SOAP/Narrative toggle
- **Dual DNA input sources** — edited summaries OR ingested case notes
- **Strict shadcn/ui** component usage — avoid custom components where shadcn/ui built-ins or examples exist
- **SDK-first** — all backend interactions via `@arcaai/vox` hooks

---

## 2. Current State Review

### 2.1 Architecture Summary

| Aspect | Current State |
|--------|---------------|
| **Framework** | React 19 + Vite 6 + React Router 7 |
| **UI Library** | shadcn/ui (Radix) via `@arcaai/ui` + local `components/ui/` |
| **SDK** | `@arcaai/vox` (workspace package) |
| **CSS** | Tailwind CSS v4 (OKLCH tokens) |
| **Routes** | 28 lazy-loaded pages |
| **Sidebar** | 4 nav groups, shadcn `Sidebar` pattern |
| **Testing** | Vitest + Testing Library + Playwright |

### 2.2 Code Quality Review

**What's Good:**

- Clean lazy-loading with `React.lazy()` + `Suspense` + `PageSkeleton` fallback
- Proper `ErrorBoundary` wrapping
- Sidebar follows shadcn/ui dashboard pattern exactly (`variant="inset"`, collapsible, `SidebarRail`, `DropdownMenu` user footer)
- Good separation: pages in `pages/`, shared components in `components/`, UI primitives in `components/ui/`
- Auth gate (`LoginGate`) properly wraps entire app

**Issues Found:**

| # | Severity | Issue | Files |
|---|----------|-------|-------|
| 1 | **Architecture** | Single `/consultation` and `/transcription` routes — no separate Local/Remote pages | `App.tsx`, `app-sidebar.tsx` |
| 2 | **UX** | Summary generation has SOAP/Narrative format toggle — should be pipeline-driven | `summary-workflow.tsx`, `summarization.tsx` |
| 3 | **UX** | Pre-summary always shown — should be conditional on context existence | `summary-workflow.tsx` |
| 4 | **UX** | DNA style only accepts single consultation summary — needs dual input (edited summaries + case notes) | `dna-style.tsx` |
| 5 | **UX** | No WASM model management UI for local transcription | `transcription.tsx`, `basic-consultation.tsx` |
| 6 | **UX** | No completion checklist in consultation pages | `consultation.tsx`, `basic-consultation.tsx` |
| 7 | **UX** | No close/reopen consultation workflow | `consultation.tsx` |
| 8 | **UX** | No guard rails (can generate summary without transcript) | `consultation.tsx` |
| 9 | **Component** | Some custom components duplicate shadcn/ui built-ins (see Section 2.3) |
| 10 | **Consistency** | Recording controls hard-code language list — missing Hindi, Tamil per spec | `recording-controls.tsx` |

### 2.3 Component Audit — Custom vs shadcn/ui

| Current Custom Component | Should Use Instead |
|--------------------------|-------------------|
| `vertical-stepper.tsx` | **Stepperize** (`@stepperize/react`) — shadcn-compatible, type-safe, horizontal/vertical |
| `file-upload-zone.tsx` | **shadcn-dropzone** — built on `react-dropzone`, consistent styling |
| `diff-viewer.tsx` | Keep (wrapper around SDK `computeDiff`), but style with shadcn `ScrollArea` |
| `version-timeline.tsx` | Keep (custom for version history), but verify uses `Card` + `Badge` consistently |
| `consultation-progress-stepper.tsx` | Replace with **Stepperize** for consistency with vertical stepper |
| `job-progress-tracker.tsx` | Keep, uses `Card` + `Progress` + `Badge` correctly |
| `streaming-text-display.tsx` | Keep, uses `Card` + `Button` correctly |
| `recording-controls.tsx` | Keep, but needs refactoring for Local/Remote variants |

### 2.4 Missing shadcn/ui Components

Components to install:

| Component | Purpose | Install |
|-----------|---------|---------|
| `AlertDialog` | Close/reopen confirmation dialogs | `npx shadcn@latest add alert-dialog` |
| `Skeleton` | Better page loading states | `npx shadcn@latest add skeleton` |
| `Tooltip` | Guard rail explanations on disabled buttons | `npx shadcn@latest add tooltip` |
| `ScrollArea` | Transcript/summary scroll panels | `npx shadcn@latest add scroll-area` |
| `Separator` | Visual dividers in panels | `npx shadcn@latest add separator` |
| `Popover` | NER entity detail on click | `npx shadcn@latest add popover` |
| `Textarea` | Case note editor, summary editor | `npx shadcn@latest add textarea` |
| `Checkbox` | Multi-select for edited summaries | `npx shadcn@latest add checkbox` |

Third-party libraries:

| Library | Purpose | Install |
|---------|---------|---------|
| `@stepperize/react` | Consultation workflow stepper | `npm install @stepperize/react` |
| `sonner` | Toast notifications (if not already via `@arcaai/ui`) | Verify existing |

### 2.5 SDK Gaps

| Gap | Description | Impact | Workaround |
|-----|-------------|--------|------------|
| **No `session.close()`** | `useArcaSession().close()` exists but need to verify it sends reason code | Medium | Check API: `POST /consultations/:id/close` with `{ reason }` body |
| **No `session.reopen()`** | `useArcaSession().reopen()` exists but need to verify reason code support | Medium | Check API: `POST /consultations/:id/reopen` with `{ reasonCode }` body |
| **No WASM model management API** | SDK's `audio.start()` accepts `sttProvider: 'local'` but no hook to list/download/check WASM models | High | Need to check if `@arcaai/stt` exports model management utilities; may need custom hooks |
| **`summary.approveSummary()` endpoint** | `useArcaSummary().approveSummary()` exists — need to verify backend endpoint exists | Medium | Check API: `POST /consultations/:id/summaries/:contextItemId/approve` |
| **DNA `generate()` input format** | `useDnaStyle().generate(input)` — need to verify `input` can accept `textSamples[]` directly (for ingested case notes) vs only `consultationId` | High | Check `DnaGenerateInput` type; may need `textSamples` field |
| **No `summary.loadSummaries()` filter by type** | Need to filter `MODIFIED_SUMMARY` only for DNA input — SDK returns all types | Low | Client-side filter: `summaries.filter(s => s.type === 'MODIFIED_SUMMARY')` |
| **No context type filter for pre-summary check** | Need to check if case notes or historical context exist before showing pre-summary panel | Low | Use `context.caseNotes.length > 0` check |
| **No `audio.getModelStatus()`** | No SDK method to check WASM model download status | High | Need to check `@arcaai/stt` package for model management APIs |

---

## 3. Implementation Plan

### Phase 1: Structural Changes (Routes + Sidebar)

#### Task 1.1: Add New Route Imports in `App.tsx`

**Files:**
- Modify: `src/App.tsx`

**Changes:**
- Add lazy imports for 4 new pages:
  - `ConsultationLocalPage` → `@/pages/consultation-local`
  - `ConsultationRemotePage` → `@/pages/consultation-remote`
  - `TranscriptionLocalPage` → `@/pages/transcription-local`
  - `TranscriptionRemotePage` → `@/pages/transcription-remote`
- Add 4 new `<Route>` entries
- Keep existing `/consultation` and `/transcription` routes for backward compatibility (redirect or alias)

#### Task 1.2: Update Sidebar Navigation

**Files:**
- Modify: `src/components/app-sidebar.tsx`

**Changes:**
- Add `Laptop` and `Cloud` icons from `lucide-react`
- Replace single "Consultation" entry with:
  - `{ href: '/consultation-local', label: 'Consultation (Local)', icon: Laptop, isNew: true }`
  - `{ href: '/consultation-remote', label: 'Consultation (Remote)', icon: Cloud, isNew: true }`
- Replace single "Transcription" entry with:
  - `{ href: '/transcription-local', label: 'Transcription (Local)', icon: Laptop, isNew: true }`
  - `{ href: '/transcription-remote', label: 'Transcription (Remote)', icon: Cloud, isNew: true }`
- Keep "Basic Consultation" as-is (minimal demo)

#### Task 1.3: Install Missing shadcn/ui Components

**Commands:**
```bash
npx shadcn@latest add alert-dialog skeleton tooltip scroll-area separator popover textarea checkbox
npm install @stepperize/react
```

---

### Phase 2: New Pages — Consultation (Local + Remote)

#### Task 2.1: Create `consultation-local.tsx`

**File:** Create: `src/pages/consultation-local.tsx`

**SDK Hooks:** `useArcaSession`, `useDepartments`, `useArcaConfig`

**shadcn/ui Components:**
- `Card`, `CardHeader`, `CardTitle`, `CardContent`
- `Badge`
- `Button`
- `Progress`
- `Select`
- `AlertDialog` (close/reopen confirmation)
- `Tooltip` (disabled button explanations)
- `Separator`

**Key Sections (per wireframe 01):**
1. **Page header** — "Consultation — Local Processing" with Laptop icon, "Client-Side" + "Works Offline" badges
2. **WASM model status card** — Shows Whisper/VAD/RNNoise download status
3. **Status stepper** — Stepperize: OPEN → RECORDING → TRANSCRIBING → SUMMARIZING → REVIEW → CLOSED
4. **Patient & consultation info card** — MRN, doctor, department, date, duration, visit type
5. **Action buttons** — Generate Summary (guarded), Approve & Close (guarded), Add Case Note, Load Shared Context
6. **Department override** — Select with auto-selected primary department
7. **Completion checklist** — Right sidebar with step completion status
8. **Reopen card** — Reason code + reopen button (for CLOSED consultations)

**Guard Rails:**
- "Generate Summary" disabled when no transcript exists — `Tooltip` with "Requires a transcript"
- "Approve & Close" disabled when not in REVIEW status
- Close requires `AlertDialog` confirmation

#### Task 2.2: Create `consultation-remote.tsx`

**File:** Create: `src/pages/consultation-remote.tsx`

**SDK Hooks:** `useArcaSession`, `useDepartments`, `useHealthCheck`, `useMonitoring`, `usePipelines`

**Differences from Local:**
- **Page header** — "Consultation — Remote Processing" with Cloud icon, "Backend" badge
- **Backend status card** — STT service health, WebSocket status, active sessions, pipeline selector
- **Pipeline selector** — `Select` fetching from `usePipelines()`
- All shared sections identical to Local page

**Shared Components (extract):**
- `ConsultationStatusStepper` — Stepperize config shared
- `PatientInfoCard` — Reusable card component
- `ActionButtonsBar` — Guarded buttons with tooltips
- `CompletionChecklist` — Right sidebar checklist
- `ReopenCard` — Reason code + reopen
- `DepartmentOverride` — Select with auto-select

#### Task 2.3: Extract Shared Consultation Components

**Files:** Create: `src/components/consultation/`
- `consultation-stepper.tsx` — Stepperize-based stepper
- `patient-info-card.tsx`
- `action-buttons-bar.tsx`
- `completion-checklist.tsx`
- `reopen-card.tsx`
- `department-override.tsx`

---

### Phase 3: New Pages — Transcription (Local + Remote)

#### Task 3.1: Create `transcription-local.tsx`

**File:** Create: `src/pages/transcription-local.tsx`

**SDK Hooks:** `useArca` (audio, context), `useArcaConfig`

**Key Sections (per wireframe 02):**
1. **Page header** — "Transcription — Local Processing" with Laptop icon, badges
2. **WASM model management** — Model list with download status, download buttons, size info
3. **Privacy banner** — `Alert` component: "Audio never leaves this device"
4. **Recording controls** — Start/Stop, Mute/Unmute, timer
5. **Waveform visualization** — Reuse existing or canvas-based
6. **Audio settings (local)** — Language selector, noise filter level, VAD sensitivity
7. **Live transcript panel** — Speaker-diarized (Speaker 1/2 for local), timestamps, auto-scroll

**Notes:**
- No file upload on local page
- Speaker labels are generic ("Speaker 1/2") since local STT has no server-side diarization

#### Task 3.2: Create `transcription-remote.tsx`

**File:** Create: `src/pages/transcription-remote.tsx`

**SDK Hooks:** `useArca`, `useConsultationJob`, `useMonitoring`, `useHealthCheck`, `usePipelines`

**Key Sections:**
1. **Page header** — "Transcription — Remote Processing" with Cloud icon, badges
2. **Backend status card** — Service health, WebSocket status, server model info
3. **Pipeline & model selector** — `Select` with pipelines from API
4. **Tabs** — "Live Recording" / "File Upload" (shadcn `Tabs`)
5. **Recording controls** — Same as local + WebSocket status indicator
6. **Audio settings (remote)** — Language selector, diarization toggle, noise filter
7. **Live transcript panel** — Speaker-diarized (Doctor/Patient via server diarization)
8. **File upload zone** — Drag-and-drop with job tracking (Remote only)
9. **Service status bar** — Per-service health indicators

**Shared Components (extract):**
- `RecordingControls` — Refactor existing to accept `variant: 'local' | 'remote'` prop
- `TranscriptDisplay` — Already exists, reuse as-is
- `WasmModelManager` — New component for model download/status
- `BackendStatusCard` — New component for service health display

#### Task 3.3: Extract Shared Transcription Components

**Files:** Create: `src/components/transcription/`
- `wasm-model-manager.tsx` — WASM model download/status/selection
- `backend-status-card.tsx` — Service health, WebSocket, pipeline info
- `audio-settings-local.tsx` — Language, noise filter, VAD
- `audio-settings-remote.tsx` — Language, diarization, noise filter, pipeline

---

### Phase 4: Update Summary Workflow Page

#### Task 4.1: Remove Output Format Toggle

**File:** Modify: `src/pages/summary-workflow.tsx`

**Changes:**
- Remove SOAP/Narrative toggle buttons
- Add info text: "Output format is determined by the department prompt template and DNA writing style configured in the pipeline"
- Show format badge (read-only) from department prompt config

#### Task 4.2: Make Pre-Summary Conditional

**File:** Modify: `src/pages/summary-workflow.tsx`

**Changes:**
- Check `context.caseNotes.length > 0` or shared context existence before showing pre-summary panel
- When no context: show collapsed info card "No additional context available — pre-summary will be skipped"
- When context exists: show pre-summary panel with source attribution, edit capability

#### Task 4.3: Add Pipeline Visualization

**File:** Modify: `src/pages/summary-workflow.tsx`

**Changes:**
- Add visual pipeline flow: Pre-Summary → Transcript → Case Notes → Dept Prompt → DNA Style → LLM
- Each block shows status (ready/loading) with `Badge` indicators
- Conditional blocks dimmed/hidden when not applicable

---

### Phase 5: Update DNA Writing Style Page

#### Task 5.1: Add Dual Input Source Selector

**File:** Modify: `src/pages/dna-style.tsx`

**Changes:**
- Replace single consultation selector with `Tabs`:
  - **Tab 1: "Edited Summaries"** — Multi-select from consultations with `MODIFIED_SUMMARY` items only
  - **Tab 2: "Ingest Case Notes"** — Textarea for pasting + file upload for historical case notes
- Filter summaries using `summaries.filter(s => s.type === 'MODIFIED_SUMMARY')` — explicitly exclude `RAW_SUMMARY`

#### Task 5.2: Add Edited Summaries Multi-Select

**File:** Modify: `src/pages/dna-style.tsx`

**Changes:**
- Consultation list with `Checkbox` for multi-select
- Each item shows: consultation date, department, word count, "Edited" badge
- Filter controls: date range, department
- Selected count indicator + minimum threshold warning (e.g., "Select at least 3 summaries")

#### Task 5.3: Add Case Notes Ingestion

**File:** Modify: `src/pages/dna-style.tsx`

**Changes:**
- `Textarea` for pasting case note text
- "Add Sample" button to add to samples list
- File upload zone (`.txt`, `.docx`) for bulk ingestion
- Sample list with edit/remove per item
- Combined stats: total samples, total word count

#### Task 5.4: Update Stepper

**File:** Modify: `src/pages/dna-style.tsx`

**Changes:**
- Update stepper to 6 steps:
  1. Select Input Source
  2. Select/Ingest Samples
  3. Review Text Samples
  4. Select Prompt Template
  5. Generate DNA Style
  6. Review Results

---

### Phase 6: Enhance Existing Pages

#### Task 6.1: Update `summarization.tsx`

**Changes:**
- Remove format toggle (SOAP/Narrative)
- Add pipeline-driven format note
- Conditional pre-summary

#### Task 6.2: Update `recording-controls.tsx`

**Changes:**
- Add Hindi, Tamil to language options
- Accept `variant: 'local' | 'remote'` prop
- Show different status badges per variant

#### Task 6.3: Update `consultation-progress-stepper.tsx`

**Changes:**
- Replace with Stepperize-based implementation
- Support both horizontal and vertical layouts

#### Task 6.4: Update NER Entities Page

**File:** Modify: `src/pages/ner-entities.tsx`

**Changes:**
- Add entity detail `Popover` on click (replacing full card)
- Add "Flag as Incorrect" flow with `AlertDialog`
- Add confidence score visibility
- Add `ScrollArea` for annotated text

#### Task 6.5: Update Care Journey Page

**File:** Modify: `src/pages/consultation-timeline.tsx`

**Changes:**
- Add cross-chain summary button
- Add shared context panel
- Add chain statistics card

---

### Phase 7: Polish & Consistency

#### Task 7.1: Add `Tooltip` to All Guarded Buttons

All disabled action buttons must have `Tooltip` explaining why they're disabled.

#### Task 7.2: Add Toast Notifications

Use `sonner` for action feedback:
- "Summary generated successfully"
- "Consultation closed"
- "DNA style generated (v2)"
- "Recording started"
- Error toasts for failures

#### Task 7.3: Add `Skeleton` Loading States

Replace `PageSkeleton` with page-specific skeletons using shadcn `Skeleton`.

#### Task 7.4: Responsive Layout

- Two-column layout on desktop (main + sidebar checklist)
- Single column on mobile
- Sidebar collapses to icons on tablet

---

## 4. SDK Gap Detail

### Critical Gaps (Need SDK Changes)

| Gap | Hook/Method | What's Needed | Proposed Solution |
|-----|-------------|---------------|-------------------|
| WASM model management | `useArca().audio` | `getModelStatus()`, `downloadModel()`, `listModels()` | Check `@arcaai/stt` package; if available, create wrapper hook `useWasmModels()` |
| DNA generate with text samples | `useDnaStyle().generate()` | `DnaGenerateInput` needs `textSamples: string[]` field for ingested case notes | Verify `DnaGenerateInput` type; if missing, file SDK issue |
| Close with reason | `useArcaSession().close()` | `close({ reason: string })` parameter | Verify API accepts reason body |
| Reopen with reason code | `useArcaSession().reopen()` | `reopen({ reasonCode: string })` parameter | Verify API accepts reasonCode body |

### Workaround Gaps (Can Work Around in App)

| Gap | Workaround |
|-----|------------|
| Filter `MODIFIED_SUMMARY` only | Client-side: `summaries.filter(s => s.type === 'MODIFIED_SUMMARY')` |
| Check context existence for pre-summary | Check `context.caseNotes.length > 0 \|\| sharedContext.length > 0` |
| Department auto-select | Use `useDepartments()` to get doctor's primary, set as default in `Select` |
| Pipeline format info | Read department's `summaryPromptId` to show format info as read-only badge |

---

## 5. File Manifest

### New Files (11)

| Path | Purpose |
|------|---------|
| `src/pages/consultation-local.tsx` | Consultation page — Local audio processing |
| `src/pages/consultation-remote.tsx` | Consultation page — Remote audio processing |
| `src/pages/transcription-local.tsx` | Transcription page — Local audio processing |
| `src/pages/transcription-remote.tsx` | Transcription page — Remote audio processing |
| `src/components/consultation/consultation-stepper.tsx` | Stepperize-based status stepper |
| `src/components/consultation/patient-info-card.tsx` | Patient & consultation info card |
| `src/components/consultation/action-buttons-bar.tsx` | Guarded action buttons with tooltips |
| `src/components/consultation/completion-checklist.tsx` | Right sidebar completion checklist |
| `src/components/consultation/reopen-card.tsx` | Reopen consultation with reason code |
| `src/components/consultation/department-override.tsx` | Department selector with auto-select |
| `src/components/transcription/wasm-model-manager.tsx` | WASM model download/status/selection |

### Modified Files (10)

| Path | Changes |
|------|---------|
| `src/App.tsx` | Add 4 new route imports + `<Route>` entries |
| `src/components/app-sidebar.tsx` | Split Consultation + Transcription into Local/Remote entries |
| `src/pages/summary-workflow.tsx` | Remove format toggle, conditional pre-summary, pipeline viz |
| `src/pages/summarization.tsx` | Remove format toggle, conditional pre-summary |
| `src/pages/dna-style.tsx` | Dual input sources, multi-select, case notes ingestion, updated stepper |
| `src/pages/ner-entities.tsx` | Entity popover, flag flow, confidence scores |
| `src/pages/consultation-timeline.tsx` | Cross-chain summary, shared context, chain stats |
| `src/components/recording-controls.tsx` | Add Hindi/Tamil, variant prop, status badges |
| `src/components/consultation-progress-stepper.tsx` | Replace with Stepperize |
| `src/components/file-upload-zone.tsx` | Consider replacing with shadcn-dropzone |

### Unchanged Files

All admin pages, developer tools pages, and utility files remain unchanged.

---

## 6. Task Prioritization

| Priority | Tasks | Estimated Effort |
|----------|-------|-----------------|
| **P0 — Structural** | Tasks 1.1, 1.2, 1.3, 2.3 | Foundation for everything else |
| **P1 — Core Pages** | Tasks 2.1, 2.2, 3.1, 3.2, 3.3 | New consultation + transcription pages |
| **P2 — Summary + DNA** | Tasks 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4 | Summary and DNA style updates |
| **P3 — Enhancements** | Tasks 6.1–6.5 | Existing page improvements |
| **P4 — Polish** | Tasks 7.1–7.4 | Tooltips, toasts, skeletons, responsive |

---

## 7. UX Best Practices Checklist

| Practice | Implementation |
|----------|----------------|
| Separate pages per workflow | Dedicated routes + sidebar entries for Local/Remote |
| Status stepper always visible | Stepperize at top of consultation pages |
| Auto-transitions | SDK status changes drive stepper automatically |
| Guard rails with tooltips | Disabled buttons + `Tooltip` explaining why |
| Department auto-select | `useDepartments()` → primary as default |
| Completion checklist | Right sidebar with step completion status |
| Close requires confirmation | `AlertDialog` with warning message |
| Reopen requires reason | `Select` (reason code) + `AlertDialog` |
| Conditional pre-summary | Only show when case notes or shared context exist |
| Pipeline-driven format | Read-only badge, no user selection |
| Dual DNA input sources | Tabs: Edited Summaries / Ingest Case Notes |
| Edited summaries only | Filter `MODIFIED_SUMMARY`, exclude `RAW_SUMMARY` |
| WASM model management | Download status, model selector, offline indicator |
| Backend status visibility | Service health, WebSocket, pipeline info |
| Toast notifications | `sonner` for all action feedback |
| Responsive layout | Two-column desktop, single-column mobile |
