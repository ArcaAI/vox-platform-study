# DNA Writing Style Playground — Implementation

## Overview

The DNA Writing Style Playground allows administrators and doctors to analyze, generate, and manage personalized writing style profiles ("DNA styles"). These profiles capture a doctor's unique writing patterns — tone, formality, vocabulary, sentence structure — and are used by the summarization pipeline to produce summaries that match each doctor's natural writing style.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│              DNA Writing Style Page                        │
│  ┌──────────────────┬─────────────────────────────────┐  │
│  │    My Style      │        All Reports              │  │
│  │   (current user) │  ┌────────┬────────┬─────────┐  │  │
│  │                  │  │Reports │Versions│ Detail  │  │  │
│  │                  │  │ List   │  List  │  View   │  │  │
│  └──────────────────┘  └────────┴────────┴─────────┘  │  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │           Generate Dialog (SSE / Polling)           │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────┐
│   Admin API Client       │
│   (REST + SSE streaming) │
│   /admin/dna-writing-    │
│    styles/*              │
│   /dna-writing-styles/*  │
└──────────────────────────┘
```

---

## API Layer

**File:** `apps/ui-playground/src/features/dna-writing-style/api/dna-writing-styles.ts` (374 lines)

### Types

| Type | Purpose |
|------|---------|
| `DnaReport` | DNA style report entity |
| `DnaReportData` | Report content (style text, attributes) |
| `DnaStyleVersion` | Version history entry |
| `DnaGenerateInput` | Generation request (text samples, delivery method) |
| `DnaUpdateInput` | Update request (style text, attributes, change reason) |
| `DnaJobStatus` | Async job status |
| `DnaStreamChunk` | SSE streaming chunk |
| `DnaStreamCallbacks` | SSE event callbacks |

### Query Hooks

| Hook | Endpoint | Purpose |
|------|----------|---------|
| `useDnaReports(params)` | `GET /admin/dna-writing-styles` | List all reports (admin) |
| `useDnaReport(id)` | `GET /dna-writing-styles/:id` | Single report by ID |
| `useMyDnaStyle()` | `GET /dna-writing-styles/my-style` | Current user's style |
| `useDnaStyleByDoctor(doctorId)` | `GET /dna-writing-styles/doctor/:doctorId` | Doctor's style by ID |
| `useDnaVersions(reportId)` | `GET /dna-writing-styles/:reportId/versions` | Version history |
| `useDnaJobStatus(jobId)` | `GET /admin/dna-writing-styles/jobs/:jobId` | Job status (2s polling) |

### Mutation Hooks

| Hook | Endpoint | Purpose |
|------|----------|---------|
| `useGenerateDnaReport()` | `POST /dna-writing-styles/generate` | Generate for self |
| `useGenerateDnaReportForDoctor()` | `POST /admin/dna-writing-styles/generate/:doctorId` | Generate for specific doctor (admin) |
| `useUpdateDnaReport()` | `PATCH /dna-writing-styles/:reportId` | Update style text/attributes |

### SSE Streaming

```typescript
streamDnaGenerate(input: DnaGenerateInput, callbacks: DnaStreamCallbacks): AbortController
```

- Sends `POST` with `stream: true` to the generation endpoint.
- Parses SSE `data:` lines from the response stream.
- Callbacks: `onChunk(chunk)`, `onComplete(report)`, `onError(error)`.
- Returns `AbortController` for cancellation.

### Auth

- Uses `adminClient` for REST calls (reads `accessToken` / `apiKey` from `useAuthStore`).
- `getStreamHeaders()` reads from `useAuthStore`: `Authorization: Bearer` or `X-API-Key`, plus `X-Tenant-Id`.
- Base URL from `usePlaygroundStore.apiBaseUrl`.
- Does **not** use `impersonationToken` — admin endpoints use the admin's own token.

---

## Main Page

**File:** `apps/ui-playground/src/features/dna-writing-style/index.tsx` (815 lines)

### Tabs

| Tab | Content |
|-----|---------|
| **My Style** | Current user's DNA writing style card |
| **All Reports** | 3-column panel for browsing all reports |

### My Style Card

- Uses `useMyDnaStyle()` to fetch the current user's style.
- Displays: style text, tone, formality, vocabulary level, sentence structure.
- Shows `StyleAttributeCard` components for each attribute.

### All Reports Panel

- Uses `useDnaReports()` for the reports list.
- Uses `useDnaVersions(selectedReportId)` for version history.
- Uses `useAdminUsers()` for doctor name resolution.
- 3-column layout: Reports → Versions → Detail.

### Generate Dialog

Form for generating a new DNA style analysis:

**Inputs:**
- Text samples (textarea) — doctor's writing samples for analysis.
- Doctor selection (admin only) — dropdown to generate for a specific doctor.
- Delivery method: SSE streaming or HTTP polling.

**Generation flow (SSE):**
1. Call `streamDnaGenerate(input, callbacks)`.
2. Display `StreamingReportView` with progressive text.
3. On complete: refresh reports list.

**Generation flow (Polling):**
1. Call `useGenerateDnaReport()` or `useGenerateDnaReportForDoctor()`.
2. Display `JobPollingBanner` with status updates.
3. Poll via `useDnaJobStatus(jobId)` every 2 seconds.
4. On complete: refresh reports list.

### Edit Dialog

- Wired to `useUpdateDnaReport()`.
- Allows editing style text and attributes.
- Currently not triggered from any UI element (no button opens it).

### Sub-components

| Component | Purpose |
|-----------|---------|
| `StyleAttributeCard` | Display a single style attribute (tone, formality, etc.) |
| `JobPollingBanner` | Polling progress indicator |
| `StreamingReportView` | SSE streaming progress display |
| `GenerateDialog` | Generation form dialog |
| `EditDialog` | Edit form dialog (unused) |
| `MyStyleCard` | Current user's style display |

---

## All Reports Panel

**File:** `apps/ui-playground/src/features/dna-writing-style/components/all-reports-panel.tsx` (307 lines)

3-column layout for browsing DNA reports:

| Column | Content |
|--------|---------|
| **Reports** | List of all DNA reports with doctor name, version count, tone/formality badges |
| **Versions** | Version history for selected report |
| **Detail** | Full detail of selected version (style text, attributes, change reason) |

**Props:**
- `reports`, `versions` — data arrays
- `isLoadingReports`, `isLoadingVersions` — loading states
- `selectedReportId`, `selectedVersionId` — selection state
- `onSelectReport`, `onSelectVersion` — selection handlers
- `doctors` — for doctor name resolution

**Helpers:**
- `relativeTime(date)` — human-readable time ago
- `fmtDate(date)` — formatted date string
- `resolveDoctorName(doctorId)` — resolves doctor ID to display name using `doctors` array

---

## Integration with Summarization

DNA writing styles are consumed by the Pre-Summary and Summary pages:

### Pre-Summary Page
- `useDnaStyleByDoctor(ctx.effectiveUserId)` — loads the impersonated doctor's DNA style.
- `useDnaVersions(dnaReportId)` — loads version history.
- `useUpdateDnaReport()` — allows saving new DNA style versions inline.
- DNA style ID is passed to the generation request.

### Summary Page
- Same hooks and pattern as Pre-Summary.
- DNA style influences the generated summary's writing style.

### Data Flow

```
useDoctorContext() → effectiveUserId
    ↓
useDnaStyleByDoctor(effectiveUserId) → DnaReport
    ↓
dnaStyleId → SMR generate request → Summary matches doctor's style
```

---

## SDK Integration

The DNA Writing Style Playground does **not** use `@arcaai/vox` directly. All API calls go through `adminClient` (REST) and `streamDnaGenerate` (raw `fetch` with SSE parsing).

However, `@arcaai/vox` does define DNA-related types and constants:

| SDK Export | Purpose |
|-----------|---------|
| `DNAStyle`, `DNAStyleData` | Type definitions |
| `DnaReport`, `DnaReportData`, `DnaStyleVersion` | Entity types |
| `DNA_STYLE_ENDPOINTS` | Endpoint constants (GENERATE, MY_STYLE, BY_DOCTOR, ADMIN_LIST, etc.) |
| `agenticStore.dnaStyle` | SDK store field |
| `useDnaStyle` | SDK hook (not used by playground) |

The playground implements its own API layer rather than using SDK hooks because:
1. It needs admin-scoped endpoints (`/admin/dna-writing-styles/*`).
2. It needs SSE streaming support for generation.
3. It needs direct control over polling and cancellation.

---

## Auth Behavior

| Scenario | Token Used | Behavior |
|----------|-----------|----------|
| Doctor viewing "My Style" | `accessToken` | Fetches own style |
| Admin viewing "All Reports" | `accessToken` | Lists all reports (admin endpoint) |
| Admin generating for doctor | `accessToken` | Uses `/admin/.../generate/:doctorId` path param |
| Impersonating doctor | `accessToken` (admin's) | DNA playground does NOT use `impersonationToken` |

The DNA playground differs from Consultation and Summarization in that it does **not** use impersonation tokens. Admin operations use admin-scoped endpoints with the admin's own token, and the target doctor is specified via path parameters.

---

## Test Coverage

### `all-reports-panel.test.tsx` (357 lines)

- **Column 1 (Reports):** reports list rendering, version badges, selection highlighting, loading state, empty state
- **Column 2 (Versions):** placeholder when no report selected, versions list, selection, loading state
- **Column 3 (Detail):** placeholder when no version selected, detail view with style text and attributes
- **Doctor resolution:** username display when `doctors` array is provided

---

## Routes

| Route File | URL Path | Component |
|------------|----------|-----------|
| `routes/_authenticated/dna-writing-style/index.tsx` | `/dna-writing-style/` | `DnaWritingStylePage` |

Under `_authenticated`, requiring authentication.

---

## File Index

| File | Lines | Purpose |
|------|-------|---------|
| `features/dna-writing-style/index.tsx` | 815 | Main page, dialogs, tabs |
| `features/dna-writing-style/api/dna-writing-styles.ts` | 374 | API hooks, types, SSE streaming |
| `features/dna-writing-style/components/all-reports-panel.tsx` | 307 | 3-column reports/versions/detail panel |
| `features/dna-writing-style/__tests__/all-reports-panel.test.tsx` | 357 | AllReportsPanel unit tests |
| `routes/_authenticated/dna-writing-style/index.tsx` | 6 | Route definition |
