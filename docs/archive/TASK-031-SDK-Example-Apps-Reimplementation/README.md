# SDK Example Apps Re-implementation

- **Ticket**: TASK-031
- **Created**: 2026-02-20
- **Last Updated**: 2026-02-20
- **Status**: Completed

## Requirement Analysis

The `@arcaai/vox` SDK example apps (`vite-app` and `nextjs-app`) had grown into a scattered collection of ~20 demo pages that no longer aligned with the product's feature set. They needed to be consolidated into a focused structure matching the UXUI and feature specifications:

- **UXUI-01**: Clean, modern UI with consistent design language
- **FEAT-01**: Setup & configuration (backend connection, AI models, user preferences)
- **FEAT-02**: Transcription (live microphone STT + file-upload batch processing)
- **FEAT-03**: Summarization (streaming SSE + async polling with department/prompt/DNA style selection)

### Acceptance Criteria

1. Both example apps (Vite and Next.js) must have exactly 5 routes: Home, Setup, Transcription, Summarization, Admin
2. All API interactions must go through SDK hooks (`useArca`, `useArcaConfig`, `usePrompts`, `useDepartments`, `useDnaStyle`) -- no direct fetch calls except health checks
3. Shared UI components from `@arcaai/ui` must be used (ServiceStatusBar, AudioMeter, TranscriptViewer, CodeExample, DeptPromptSelector, DnaStyleSelector, WorkflowToggle, ModelSelector)
4. Both apps must be feature-equivalent with identical UX
5. Old demo pages (20 pages) must be removed
6. READMEs must be updated to reflect the new structure

## Current State Evaluation

### Before (20-page scattered demos)

Both apps had the same set of routes:
- `/basic-consultation`, `/with-plugins`, `/summary-workflow`, `/dna-style`, `/multi-doctor-workflow`
- `/pipeline-control`, `/personalization`, `/custom-models`, `/cross-tab-session`
- `/admin/prompts`, `/admin/departments`, `/admin/dashboard` (Next.js only)
- Developer pages: `/dev/stt`, `/dev/diff-viewer`, `/dev/error-handling` (Vite only)
- `/appointment-view`, `/consultation`, `/plugin-hooks`, `/custom-pipeline` (Vite only)

Issues:
- Pages duplicated functionality (e.g. basic-consultation vs consultation vs plugin-hooks)
- No consistent navigation or feature discovery flow
- Missing streaming summarization demo despite SDK support
- No consolidated setup/configuration experience
- No live prerequisites check or service health overview

### Shared Components

The `@arcaai/ui` package already contained the required shared components (ThemeToggle, ServiceStatusBar, AudioMeter, CodeExample, TranscriptViewer, DeptPromptSelector, DnaStyleSelector, WorkflowToggle, ModelSelector, AsyncJobTracker). Phase 0 of the plan was effectively already complete.

## Implementation Plan

Strategy: **Vite-first as reference implementation, then port to Next.js.**

### Phase 1: Vite-App Pages

1. Add `doctorId` to `api-config-store` and API settings panel
2. Redesign Home page (hero, feature cards, prerequisites checklist, quick-start snippet)
3. Build Setup page (backend config, personalization, service health verification)
4. Build Transcription page (live STT tab + file-upload tab with AsyncJobTracker)
5. Build Summarization page (streaming SSE tab + polling tab)
6. Build Admin page (prompts CRUD with versioning, departments, service health)
7. Update router to 5 routes, delete 19 old page files

### Phase 2: Next.js App Port

1. Update `api-config-store` and `api-settings` with `doctorId`
2. Update navigation to match new 4-item structure
3. Port all 5 pages using `page.tsx` + `_content.tsx` dynamic import pattern
4. Delete 11 old page directories
5. Update layout with `suppressHydrationWarning` for theme toggling

### Phase 3: Cleanup and Documentation

1. Update both READMEs
2. Create this implementation documentation

## Implementation Summary

### Files Created

| File | App | Purpose |
|------|-----|---------|
| `vite-app/src/pages/setup.tsx` | Vite | Setup & Configuration page |
| `vite-app/src/pages/transcription.tsx` | Vite | Transcription Demo page |
| `vite-app/src/pages/summarization.tsx` | Vite | Summarization Demo page |
| `vite-app/src/pages/admin.tsx` | Vite | Admin Panel (consolidated) |
| `nextjs-app/src/app/setup/page.tsx` | Next.js | Setup dynamic wrapper |
| `nextjs-app/src/app/setup/_content.tsx` | Next.js | Setup page content |
| `nextjs-app/src/app/transcription/page.tsx` | Next.js | Transcription dynamic wrapper |
| `nextjs-app/src/app/transcription/_content.tsx` | Next.js | Transcription page content |
| `nextjs-app/src/app/summarization/page.tsx` | Next.js | Summarization dynamic wrapper |
| `nextjs-app/src/app/summarization/_content.tsx` | Next.js | Summarization page content |
| `nextjs-app/src/app/admin/page.tsx` | Next.js | Admin dynamic wrapper |
| `nextjs-app/src/app/admin/_content.tsx` | Next.js | Admin page content |

### Files Modified

| File | App | Changes |
|------|-----|---------|
| `vite-app/src/pages/home.tsx` | Vite | Complete redesign: hero, feature cards, prerequisites, quick start |
| `vite-app/src/App.tsx` | Vite | Router reduced from 20 routes to 5 |
| `vite-app/src/lib/api-config-store.ts` | Vite | Added `doctorId` field |
| `vite-app/src/components/api-settings.tsx` | Vite | Added Doctor / User ID input |
| `vite-app/src/components/navigation.tsx` | Vite | Simplified to 4-item nav with ThemeToggle |
| `nextjs-app/src/app/page.tsx` | Next.js | Complete redesign matching vite-app home |
| `nextjs-app/src/app/layout.tsx` | Next.js | Added `suppressHydrationWarning` |
| `nextjs-app/src/lib/api-config-store.ts` | Next.js | Added `doctorId` field |
| `nextjs-app/src/components/api-settings.tsx` | Next.js | Added Doctor / User ID input |
| `nextjs-app/src/components/navigation.tsx` | Next.js | Simplified to 4-item nav with ThemeToggle |
| `vite-app/README.md` | Vite | Updated to reflect new structure |
| `nextjs-app/README.md` | Next.js | Updated to reflect new structure |

### Files Deleted

**Vite-app** (19 old page files):
- `basic-consultation.tsx`, `consultation.tsx`, `with-plugins.tsx`, `plugin-hooks.tsx`
- `custom-pipeline.tsx`, `pipeline-control.tsx`, `cross-tab-session.tsx`
- `personalization.tsx`, `custom-models.tsx`, `multi-doctor-workflow.tsx`
- `summary-workflow.tsx`, `dna-style.tsx`, `appointment-view.tsx`
- `admin/dashboard.tsx`, `admin/departments.tsx`, `admin/prompts.tsx`
- `dev/stt.tsx`, `dev/diff-viewer.tsx`, `dev/error-handling.tsx`

**Next.js app** (11 old page directories):
- `basic-consultation/`, `with-plugins/`, `summary-workflow/`, `dna-style/`
- `multi-doctor-workflow/`, `pipeline-control/`, `personalization/`
- `custom-models/`, `cross-tab-session/`
- `admin/prompts/`, `admin/departments/`

### New Page Architecture

Each page follows the same internal structure:

1. **Service health hook** (`useServiceHealth`) -- polls health/monitoring endpoints on mount
2. **SDK readiness gate** -- shows spinner while SDK initializes, error card if it fails
3. **ServiceStatusBar** -- displays live service status at the top of the page
4. **Tabbed content** -- each page has 2-3 tabs for different interaction modes
5. **CodeExample blocks** -- collapsible code snippets showing how to integrate each feature

### Key Design Decisions

1. **4 pages instead of 20** -- maps directly to FEAT-01/02/03 + Admin
2. **All API calls through SDK hooks** -- no direct `fetch()` except health checks in settings panel
3. **SSE for streaming summarization** -- `EventSource` connected to `/consultations/jobs/:jobId/sse`
4. **Vite-first development** -- built as reference, then ported to Next.js
5. **`doctorId` in runtime config** -- bridges API-key auth and consultation workflows needing a doctor identifier
6. **Navigation per-page in Next.js** -- rendered inside each page (not in layout) for SSR compatibility since it depends on client-side hooks
7. **LazyProviders for code splitting** -- SDK bundle only loaded when pages render, not at app startup

### Next.js-Specific Adaptations

| Vite Pattern | Next.js Equivalent |
|---|---|
| `import { Link } from 'react-router-dom'` | `import Link from 'next/link'` |
| `<Link to="/path">` | `<Link href="/path">` |
| `import.meta.env.VITE_*` | `process.env.NEXT_PUBLIC_*` |
| `AgenticProvider` in `App.tsx` | `LazyProviders` wrapping `_content.tsx` |
| Single file per page | `page.tsx` (dynamic wrapper) + `_content.tsx` (content) |
| React Router `<Routes>` | File-system routing via `app/` directory |
