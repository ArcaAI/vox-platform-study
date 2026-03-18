# TASK-035: E2E Testing & Browser Validation

- **Ticket**: TASK-035
- **Created**: 2026-02-20
- **Last Updated**: 2026-02-20
- **Status**: Completed

## Requirement Analysis

Run all Playwright E2E tests across both frontend example apps (Next.js and Vite), perform manual browser testing to verify component rendering, page functionality, and API call behavior.

## Current State Evaluation (Pre-Fix)

### Vite App (`@arcaai/vox-example-vite`)
- **138 tests**: 38 passed, ~100 failed
- Root causes identified:
  1. **Missing routes in App.tsx** — Only 6 routes were defined, but 19+ page components existed
  2. **Navigation label mismatch** — Tests expected "Doctor", "Admin", "Developer" buttons but actual nav uses "Getting Started", "Demos", "Admin"
  3. **API settings input ID prefix** — Tests looked for `input#api-base-url` but actual IDs use `sheet-` prefix (`input#sheet-api-base-url`)
  4. **DNA Style page crash** — `sessionRef.current.listConsultations is not a function` (SDK method not yet implemented)

### Next.js App (`@arcaai/vox-example-nextjs`)
- **167 tests**: 83 passed, 16 failed, 68 skipped
- Root causes identified:
  1. **Navigation label mismatch** — Same as Vite: tests expected "Doctor"/"Developer" buttons
  2. **API settings input ID prefix** — Same `sheet-` prefix issue
  3. **Nav bar not found on sub-pages** — Pages use `dynamic(() => import('./_content'), { ssr: false })` which delays nav rendering beyond the 15s timeout
  4. **DNA Style page crash** — Same `listConsultations` SDK gap

## Implementation Summary

### Fixes Applied

#### 1. Vite App — Missing Routes (Critical Fix)
**File**: `packages/agentic-sdk-v2/examples/vite-app/src/App.tsx`

Added all 19+ missing routes to the React Router configuration:
- `/basic-consultation`, `/consultation`, `/summary-workflow`
- `/multi-doctor-workflow`, `/appointment-view`, `/with-plugins`
- `/plugin-hooks`, `/pipeline-control`, `/custom-pipeline`
- `/personalization`, `/custom-models`, `/cross-tab-session`
- `/admin/prompts`, `/admin/departments`, `/admin/dashboard`
- `/dev/stt-v2`, `/dev/diff-viewer`, `/dev/error-handling`

#### 2. Navigation Test Fixes (Both Apps)
**Files**:
- `packages/agentic-sdk-v2/examples/nextjs-app/e2e/navigation.spec.ts`
- `packages/agentic-sdk-v2/examples/vite-app/e2e/app-shell.spec.ts`

Updated dropdown button selectors from `"Doctor"`, `"Developer"` to `"Getting Started"`, `"Demos"` to match actual nav section labels. Updated dropdown link names from `"Consultation"`, `"Prompts"`, `"Pipelines"` to `"Transcription"`, `"Setup & Config"`, `"Admin Panel"`.

#### 3. API Settings Input ID Prefix Fix (Both Apps)
**Files**:
- `packages/agentic-sdk-v2/examples/nextjs-app/e2e/navigation.spec.ts`
- `packages/agentic-sdk-v2/examples/vite-app/e2e/app-shell.spec.ts`

Updated input selectors from `input#api-base-url` to `input#sheet-api-base-url` (and similar for `api-key`, `tenant-id`, `ws-url`).

#### 4. DNA Style Page Crash Fix (Both Apps)
**Files**:
- `packages/agentic-sdk-v2/examples/vite-app/src/pages/dna-style.tsx`
- `packages/agentic-sdk-v2/examples/nextjs-app/src/app/dna-style/_content.tsx`

Added defensive check: `typeof session.listConsultations !== 'function'` before calling the unimplemented SDK method. Prevents ErrorBoundary crash.

#### 5. DNA Style Test Updates (Vite)
**Files**:
- `packages/agentic-sdk-v2/examples/vite-app/e2e/doctor-pages.spec.ts`
- `packages/agentic-sdk-v2/examples/vite-app/e2e/edge-cases.spec.ts`

Updated test expectations to match actual DNA Style page UI (which uses a consultation-based workflow with vertical stepper, not "Load My Style" button pattern).

#### 6. Next.js Smoke Test Timeout
**File**: `packages/agentic-sdk-v2/examples/nextjs-app/e2e/smoke.spec.ts`

Increased nav bar visibility timeout from 15s to 30s and added `waitForLoadState('networkidle')` to handle `ssr: false` dynamic imports.

### Post-Fix Results

#### Vite App: 138/138 passed (100%)
All 138 tests pass including:
- Page rendering smoke tests (19 routes)
- Navigation dropdown and mobile menu
- API settings panel
- Admin pages (prompts, departments, dashboard)
- Developer pages (STT-V2, Diff Viewer, Error Handling)
- Doctor workflow pages
- Edge cases (SPA navigation, form validation, responsive)
- 404 handling

#### Next.js App: Remaining Failures
- Navigation and most feature tests pass
- **Persistent issue**: `navigation bar is present` test still fails on sub-pages that use `ssr: false` dynamic imports. The nav renders client-side inside each `_content.tsx`, not in layout. The JS bundle compilation during dev mode takes longer than the 30s timeout.
- **Recommended future fix**: Move `<Navigation />` to `layout.tsx` and remove from individual `_content.tsx` files (requires coordinated refactor of all 16 page files).

### Browser Testing Summary

Manual browser verification confirmed:
- **Home page**: Renders correctly with all 3 sections, 20 example cards, Quick Start code block
- **Navigation**: Dropdowns work, brand link navigates, API settings button visible
- **API Settings Panel**: Opens as sheet, shows all config fields with env values, Test Connection works (fails gracefully without backend), Save & Reload present
- **Basic Consultation**: Form renders with Patient ID, Doctor ID, Doctor Name fields and Start button
- **Admin Prompts**: H1, Templates panel, New button, Category/Department filters, empty state
- **Admin Dashboard**: Health monitoring cards, Tenant Configuration, refresh buttons
- **STT-V2 Streaming**: 4 tabs, Create Session/Connect/Disconnect, WebSocket status
- **Diff Viewer**: Old/New text inputs, 4 diff algorithm tabs, Compute Diff function works client-side
- **DNA Writing Style**: Renders without crash after fix, shows consultation selector and workflow stepper

### Known Issues (Not Fixed)

1. **Next.js nav rendering architecture**: Navigation is per-page (`_content.tsx`) not in layout, causing test timeouts on SSR-disabled pages
2. **`session.listConsultations` SDK gap**: Method not implemented — pages handle gracefully but functionality is unavailable
3. **Sharp module warnings**: `@img/sharp-libvips-dev` and `@img/sharp-wasm32` warnings in Next.js dev server (cosmetic, doesn't affect functionality)

## Files Modified

| File | Change |
|------|--------|
| `packages/agentic-sdk-v2/examples/vite-app/src/App.tsx` | Added 18 missing route definitions |
| `packages/agentic-sdk-v2/examples/vite-app/src/pages/dna-style.tsx` | Defensive check for `listConsultations` |
| `packages/agentic-sdk-v2/examples/vite-app/e2e/app-shell.spec.ts` | Fixed nav labels and API settings IDs |
| `packages/agentic-sdk-v2/examples/vite-app/e2e/doctor-pages.spec.ts` | Updated DNA Style test expectations |
| `packages/agentic-sdk-v2/examples/vite-app/e2e/edge-cases.spec.ts` | Updated DNA Style empty state check |
| `packages/agentic-sdk-v2/examples/nextjs-app/src/app/dna-style/_content.tsx` | Defensive check for `listConsultations` |
| `packages/agentic-sdk-v2/examples/nextjs-app/e2e/navigation.spec.ts` | Fixed nav labels and API settings IDs |
| `packages/agentic-sdk-v2/examples/nextjs-app/e2e/smoke.spec.ts` | Increased nav timeout, added networkidle wait |
