# TASK-036: Frontend Demo Validation & Fixes

- **Ticket**: TASK-036
- **Created**: 2026-02-21
- **Last Updated**: 2026-02-21
- **Status**: Completed
- **Depends On**: TASK-034 (Frontend Demo Gap Remediation)

---

## Requirement Analysis

Manual validation of frontend demo apps (vite-app and nextjs-app) against the FEAT-01 through FEAT-05 specifications and admin panel requirements. Identify and fix issues found during systematic testing.

### Scope

- Setup & Configuration (1.1–1.7)
- Admin Panel (users, prompts, models, departments, storage)
- FEAT-02 Transcription Demo
- FEAT-03 Summarization Demo
- FEAT-04 Admin Demo
- FEAT-05 DNA Writing Style Demo

---

## Issues Found & Remediation

### P0 — Critical (Blocks Basic Functionality)

| # | Issue | Files Affected | Fix Applied |
|---|-------|---------------|-------------|
| P0-1 | `.env` missing `VITE_DOCTOR_ID` and `VITE_WS_URL` — SDK config incomplete | `vite-app/.env` | Added both env vars with seed data values (doctor: `70000000-...0010`, ws: `ws://localhost:8868/api/v1`) |
| P0-2 | `config.ts` doesn't pass `doctorId` to SDK config — SDK doesn't know current doctor | `vite-app/src/lib/config.ts` | Added `doctorId: runtime.doctorId \|\| undefined` to api config |
| P0-3 | **Wrong languages**: Thai/Chinese/Japanese listed instead of English/Malayalam/Vietnamese | `setup.tsx` (both apps), `recording-controls.tsx` (both apps) | Replaced with `en`, `ml` (Malayalam), `vi` (Vietnamese) |
| P0-4 | **Departments tab crashes on mount**: component calls 5 SDK methods that don't exist (`create`, `remove`, `getRoots`, `getChildren`, `updatePromptConfig`) | `departments-tab.tsx` (both apps), SDK `useDepartments.ts` | Rewrote tab to use only `list`/`get`/`update` from SDK; create via direct fetch; parent-child tree via client-side filtering |
| P0-5 | `AsyncJobTracker` infinite re-polling: `onComplete`/`onError` callbacks in useEffect deps recreate interval every render | `async-job-tracker.tsx` (both apps) | Used refs for callbacks, removed from deps array, added cancellation flag |

### P1 — High (Missing Requirements)

| # | Issue | Files Affected | Fix Applied |
|---|-------|---------------|-------------|
| P1-1 | Active sessions & processing jobs not displayed in remote status panel | `setup.tsx` / `_content.tsx` (both apps) | Added fetch to `/monitoring/uptime` endpoint, display session/job counts in grid cards |
| P1-2 | Models tab fully implemented but requirement says "Under Construction" | `models-tab.tsx` (both apps) | Replaced 488-line CRUD with placeholder showing "Under Construction" badge and planned model types |
| P1-3 | Status & Verification missing workflow mode, transcription options | `setup.tsx` / `_content.tsx` (both apps) | Added 5 new preference cards: Workflow Mode, Word Timestamps, Noise Cancellation, VAD Enabled, Local Diarization |
| P1-4 | Health check URL strips `/api` prefix via `deriveHostOrigin()` — hits wrong endpoints | `setup.tsx` / `_content.tsx` (both apps) | Replaced `deriveHostOrigin()` with `deriveApiBase()` that preserves the full base URL path |
| P1-5 | Workflow mode resets to 'remote' on every page visit | `setup.tsx` / `_content.tsx` (both apps) | Read saved preference from `preferences.custom.workflowMode` on initialization |

### P2 — Medium (Error Handling & UX)

| # | Issue | Files Affected | Fix Applied |
|---|-------|---------------|-------------|
| P2-1 | No try/catch on any async handler in admin tabs — unhandled promise rejections | `users-tab.tsx`, `prompts-tab.tsx`, `storage-tab.tsx` (both apps) | Wrapped all async handlers in try/catch with error toast notifications |

---

## Enhancement Pass (Phase 2)

Fixes applied to all previously deferred issues:

### Transcription Demo (FEAT-02) — FIXED
- **Dual job trackers removed**: Removed redundant `AsyncJobTracker`, kept `JobProgressTracker` only. Result extraction merged into existing `consultationJob.status` effect.
- **Context items displayed**: After live transcription completes, a green confirmation card shows the count of context items linked to the consultation.
- **File validation feedback**: `FileUploadZone` now shows descriptive error messages for unsupported file types and oversized files instead of silently ignoring them.
- **Dead LANGUAGES constant removed**: Cleaned up unused imports in transcription page.

### Summarization Demo (FEAT-03) — FIXED
- **`onDnaGenerate` fixed**: Removed the broken pass-through to `generate()` — set to `undefined` since DNA generation belongs on its own page.
- **DNA style label improved**: Changed from "My Style" to "Current Style" with longer preview text.

### DNA Writing Style Demo (FEAT-05) — FIXED
- **`reports` destructuring fixed**: Removed non-existent `reports` property from `useDnaStyle()`, simplified `totalReports` calculation.
- **Diff viewer improved**: Replaced naive full-block diff with line-by-line comparison that marks individual changed lines.
- **Version timeline wired**: Added `selectedVersion` state and passed `onSelect` to `VersionTimeline`.
- **data-testid fixed**: Corrected inconsistent test IDs (step-0, step-4).

### Cross-Cutting — FIXED
- **Save feedback for transcription options**: Added toast notifications (success/error) when saving transcription settings via `useToast`.

## Phase 3 — Final TDD Pass (All Remaining Items Resolved)

All previously deferred low-priority items resolved using strict TDD (Red-Green-Refactor):

### Upload Progress Tracking — FIXED
- Created `src/lib/upload-with-progress.ts` utility using `XMLHttpRequest` for real progress events
- Supports progress callbacks, abort, headers, JSON response parsing
- 10 unit tests (all passing)
- Integrated into `UploadTranscriptionTab` in both apps, replacing `fetch()`

### WebSocket/SSE Connection Status — FIXED
- Added connection status indicator in `LiveTranscriptionTab` showing WebSocket connected/disconnected state
- Displays STT processing badge when active
- Uses `audio.plugins.stt.isActive` and `isProcessing` from SDK

### Resource Monitoring Display — FIXED
- Added Active Sessions and Processing Jobs counters below `ServiceStatusBar`
- Uses existing `useServiceStatus()` hook data

### Model Selections Persisted to Backend — FIXED
- Created `src/lib/settings-sync.ts` with serialization/deserialization utilities
- 14 unit tests (all passing)
- Model selections saved to backend via `useUserSettings.create()` with key `'model-selections'`
- Integrated into setup page's `PersonalizationCard`

### Settings Loaded from Backend Synced to SDK — FIXED
- On page load, model selections restored from backend and applied to SDK via `selectModel()`
- Transcription options restored and applied to SDK preferences via `update()`
- Bidirectional sync: user changes -> backend, page load -> backend -> SDK

### Test Fixes
- Fixed pre-existing `React is not defined` in `transcription.test.tsx` and `file-upload-zone.test.tsx`
- Updated language test from Thai to Malayalam (matching TASK-036 language change)
- Updated session/jobs tests to use `data-testid` selectors (avoiding duplicate text matches)
- Added 3 new validation error tests for `FileUploadZone`
- **68 tests passing** across all modified test files

---

## Implementation Summary

### Files Modified

**vite-app (Phase 1 — Validation Fixes):**
- `.env` — Added `VITE_DOCTOR_ID`, `VITE_WS_URL`
- `src/lib/config.ts` — Added `doctorId` to SDK config
- `src/pages/setup.tsx` — Fixed languages, workflow persistence, health URL, remote panel, status verification
- `src/components/recording-controls.tsx` — Fixed language list
- `src/components/async-job-tracker.tsx` — Fixed callback ref pattern
- `src/components/admin/departments-tab.tsx` — Full rewrite for SDK compatibility
- `src/components/admin/models-tab.tsx` — Replaced with Under Construction
- `src/components/admin/users-tab.tsx` — Added error handling
- `src/components/admin/prompts-tab.tsx` — Added error handling
- `src/components/admin/storage-tab.tsx` — Added error handling

**vite-app (Phase 2 — Enhancements):**
- `src/pages/transcription.tsx` — Removed dual job tracker, added context items display, cleaned dead imports
- `src/pages/summarization.tsx` — Fixed onDnaGenerate, improved DNA style label
- `src/pages/dna-style.tsx` — Fixed StatusBar reports, improved diff viewer, wired version timeline, fixed testids
- `src/pages/setup.tsx` — Added toast feedback for transcription options save
- `src/components/file-upload-zone.tsx` — Added file validation error messages

**nextjs-app (Phase 1 — Validation Fixes):**
- `src/app/setup/_content.tsx` — Same fixes as vite-app setup
- `src/components/recording-controls.tsx` — Fixed language list
- `src/components/async-job-tracker.tsx` — Fixed callback ref pattern
- `src/components/admin/departments-tab.tsx` — Full rewrite for SDK compatibility
- `src/components/admin/models-tab.tsx` — Replaced with Under Construction
- `src/components/admin/users-tab.tsx` — Added error handling
- `src/components/admin/prompts-tab.tsx` — Added error handling
- `src/components/admin/storage-tab.tsx` — Added error handling

**nextjs-app (Phase 2 — Enhancements):**
- `src/app/transcription/_content.tsx` — Same fixes as vite-app transcription
- `src/app/summarization/_content.tsx` — Same fixes as vite-app summarization
- `src/app/dna-style/_content.tsx` — Same fixes as vite-app dna-style
- `src/app/setup/_content.tsx` — Added toast feedback for transcription options save
- `src/components/file-upload-zone.tsx` — Added file validation error messages

**vite-app (Phase 3 — TDD Final Pass):**
- `src/lib/upload-with-progress.ts` — NEW: XHR upload utility with progress events
- `src/lib/settings-sync.ts` — NEW: Model/settings serialization utilities
- `src/pages/transcription.tsx` — Integrated XHR upload, added WS status, resource monitoring
- `src/pages/setup.tsx` — Model persistence to backend, settings sync from backend
- `src/lib/__tests__/upload-with-progress.test.ts` — NEW: 10 tests
- `src/lib/__tests__/settings-sync.test.ts` — NEW: 14 tests
- `src/pages/__tests__/transcription.test.tsx` — Fixed React import, updated language/selector tests
- `src/components/__tests__/file-upload-zone.test.tsx` — Fixed React import, added 3 validation tests

**nextjs-app (Phase 3 — TDD Final Pass):**
- `src/lib/upload-with-progress.ts` — NEW: Copied from vite-app
- `src/lib/settings-sync.ts` — NEW: Copied from vite-app
- `src/app/transcription/_content.tsx` — Same XHR upload, WS status, resource monitoring
- `src/app/setup/_content.tsx` — Same model persistence and settings sync
