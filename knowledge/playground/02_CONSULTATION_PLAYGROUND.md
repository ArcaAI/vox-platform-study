# Consultation Playground — Implementation

## Overview

The Consultation Playground provides a full CRUD interface for managing consultation sessions via the `@arcaai/vox` SDK. It supports creating consultations, adding context items (case notes, summaries, audio recordings), viewing transcriptions, and generating summaries — all scoped to the authenticated (or impersonated) doctor.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Consultation Page                    │
│  ┌──────────────┐  ┌─────────────────────────────┐  │
│  │ Consultation  │  │    Consultation Detail       │  │
│  │    List       │  │  ┌─────────┬──────┬───────┐ │  │
│  │  (paginated,  │  │  │ Context │ Add  │Summary│ │  │
│  │   searchable) │──▶  │  Items  │Context│ Panel│ │  │
│  └──────────────┘  │  └─────────┴──────┴───────┘ │  │
│                     └─────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │   @arcaai/vox SDK     │
              │  useArca().session    │
              │  useArca().context    │
              │  useArca().summary    │
              │  useStorage()         │
              └───────────────────────┘
```

---

## Access Control

The consultation page enforces two prerequisites before granting access:

1. **Tenant required** — A tenant must be selected (via auth store `tenantId`).
2. **Doctor identity required** — Admin users who are not doctors must impersonate a doctor first.

```
canAccess = hasTenant && !requiresImpersonation
```

When access is denied:
- **No tenant:** Shows `NoTenantWarning` prompting the admin to select a tenant or impersonate.
- **Impersonation required:** Shows `ImpersonationRequired` prompting the admin to impersonate a doctor.

### Access Control Logic

| User Role | Has Tenant | Impersonating | Access |
|-----------|-----------|---------------|--------|
| DOCTOR | Yes | N/A | Allowed |
| SPECIALIST | Yes | N/A | Allowed |
| SUPER_ADMIN | Yes | No | Blocked (impersonation required) |
| SUPER_ADMIN | Yes | Yes (as doctor) | Allowed |
| TENANT_ADMIN | No | N/A | Blocked (no tenant) |

---

## Pages & Components

### Consultation Index Page

**File:** `apps/ui-playground/src/features/consultation/index.tsx` (108 lines)

- Uses `PlaygroundLayout` with title "Consultations".
- Reads `tenantId` from `useAuthStore` and `requiresImpersonation` from `useDoctorContext()`.
- Header action: `StartConsultationDialog` (only when `canAccess`).
- Shows impersonation badge when impersonating.

### Start Consultation Dialog

**File:** `apps/ui-playground/src/features/consultation/components/start-consultation-dialog.tsx` (150 lines)

- Form fields: **Patient ID** (required, max 100 chars) and **Appointment Date** (defaults to today).
- On submit:
  1. Calls `session.open({ patientId, appointmentDate })` via `useArca().session`.
  2. Stores consultation ID in playground store via `setLastConsultation`.
  3. Navigates to `/consultation/$id`.
- Resets form on dialog close.

### Consultation List

**File:** `apps/ui-playground/src/features/consultation/components/consultation-list.tsx` (293 lines)

- Calls `session.listConsultations({ page, limit, patientId })` with `DEFAULT_PAGE_SIZE` (10).
- Search by patient ID with 400ms debounce.
- Pagination with prev/next controls.
- Each card displays: patient ID, status badge, relative time, doctor name, department name.
- Click navigates to `/consultation/$id`.

### Consultation Detail

**File:** `apps/ui-playground/src/features/consultation/components/consultation-detail.tsx` (264 lines)

- Loads consultation via `session.load(id)` on mount.
- Shows loading skeleton, error state with retry, or main content.
- Header: back button, patient ID, status badge, NEW badge, appointment date, doctor, department, refresh.
- Three tabs:
  1. **Context Items** → `ContextItemList`
  2. **Add Context** → `CaseNoteForm`
  3. **Summaries** → `SummaryPanel`

### Case Note Form

**File:** `apps/ui-playground/src/features/consultation/components/case-note-form.tsx` (367 lines)

Three sub-tabs for adding different context types:

| Tab | SDK Method | Metadata |
|-----|-----------|----------|
| **Case Note** | `context.addCaseNote(content, { consultationId, attachmentUrl })` | Default type |
| **Summary** | `context.addCaseNote(content, { consultationId, type: 'RAW_SUMMARY', attachmentUrl })` | Raw summary type |
| **Audio File** | `context.addCaseNote(desc, { consultationId, type: 'AUDIO_RECORDING', attachmentUrl })` | Audio recording type |

For audio uploads:
1. File selected via file input.
2. Uploaded via `storage.uploadFile('attachments', file)` from `useStorage()`.
3. The returned URL is attached as `attachmentUrl`.

### Context Item List

**File:** `apps/ui-playground/src/features/consultation/components/context-item-list.tsx` (234 lines)

- Fetches case notes via `context.fetchCaseNotes()` and transcriptions via `context.fetchTranscriptions()`.
- Merges and sorts by `createdAt` descending.
- Each card shows: type icon, label, AI badge (for system-generated items), relative time.
- Long content is truncated with "Show more/less" toggle.
- History button opens `ContextVersionList`.

### Context Version List

**File:** `apps/ui-playground/src/features/consultation/components/context-version-list.tsx` (71 lines)

- Fetches versions via `context.getContextVersions(contextItemId)`.
- Renders version number, timestamp, change description, content preview.

### Summary Panel

**File:** `apps/ui-playground/src/features/consultation/components/summary-panel.tsx` (212 lines)

- Fetches summaries via `summary.loadSummaries()`.
- Generation buttons: **Generate Summary**, **Pre-Summary**, **Refresh**.
- Each summary card shows: type, provider/model badge, relative time, copy button, processing time.

---

## Data Display Helpers

**Tested in:** `apps/ui-playground/src/features/consultation/__tests__/consultation-data-mapping.test.ts` (130 lines)

The API may return consultation data in flat or nested formats. Helper functions normalize both:

| Helper | Flat Format | Nested Format | Fallback |
|--------|------------|---------------|----------|
| `getDoctorDisplayName` | `doctorName` | `doctor.firstName + doctor.lastName` | `username` |
| `getDepartmentDisplayName` | `departmentName` (string) | `department.name` or `department.code` | — |
| `getConsultationStatus` | `status` | `metadata.status` | — |

---

## SDK Integration

### Hooks Used

| Component | SDK Hook | Methods |
|-----------|----------|---------|
| `StartConsultationDialog` | `useArca().session` | `session.open({ patientId, appointmentDate })` |
| `ConsultationList` | `useArca().session` | `session.listConsultations({ page, limit, patientId })` |
| `ConsultationDetail` | `useArca().session` | `session.load(id)` |
| `ContextItemList` | `useArca().context` | `context.fetchCaseNotes()`, `context.fetchTranscriptions()` |
| `ContextVersionList` | `useArca().context` | `context.getContextVersions(contextItemId)` |
| `CaseNoteForm` | `useArca().context`, `useStorage()` | `context.addCaseNote(content, metadata)`, `storage.uploadFile(bucket, file)` |
| `SummaryPanel` | `useArca().summary` | `summary.loadSummaries()`, `summary.generateSummary()`, `summary.generatePreSummary()` |

### Types from @arcaai/vox

- `Consultation` — consultation entity
- `ContextItem` — case note / transcription entity
- `ContextVersionEntry` — version history entry
- `SummaryResponse` — generated summary
- `DEFAULT_PAGE_SIZE` — pagination constant (10)

### Data Flow

1. **Create:** `session.open()` → API creates consultation → navigate to detail.
2. **List:** `session.listConsultations()` → paginated results.
3. **Load:** `session.load(id)` → sets `store.consultation` in SDK → context/summary use this consultation.
4. **Context:** `context.fetchCaseNotes()` / `fetchTranscriptions()` use `store.consultation.id`.
5. **Add context:** `context.addCaseNote()` uses `store.consultation`; `consultationId` in metadata is supplementary.
6. **Summaries:** `summary.loadSummaries()`, `generateSummary()`, `generatePreSummary()` use `store.consultation.id`.

---

## Routes

| Route File | URL Path | Component |
|------------|----------|-----------|
| `routes/_authenticated/consultation/index.tsx` | `/consultation/` | `ConsultationPage` |
| `routes/_authenticated/consultation/$id.tsx` | `/consultation/$id` | `ConsultationDetail` |

Both are under `_authenticated`, requiring authentication.

---

## Test Coverage

### `consultation-access.test.ts` (96 lines)
- `requiresImpersonation`: true for admin roles when not impersonating; false for doctor roles or when impersonating
- `canAccessConsultations`: requires tenant; blocks admin without impersonation; allows doctor with tenant

### `consultation-data-mapping.test.ts` (130 lines)
- `getDoctorDisplayName`: flat, nested, and fallback formats
- `getDepartmentDisplayName`: flat string, nested object
- `getConsultationStatus`: direct status, metadata fallback

---

## File Index

| File | Lines | Purpose |
|------|-------|---------|
| `features/consultation/index.tsx` | 108 | Main page with access control |
| `features/consultation/components/start-consultation-dialog.tsx` | 150 | Create consultation dialog |
| `features/consultation/components/consultation-detail.tsx` | 264 | Consultation detail with tabs |
| `features/consultation/components/consultation-list.tsx` | 293 | Paginated consultation list |
| `features/consultation/components/case-note-form.tsx` | 367 | Add context (case note, summary, audio) |
| `features/consultation/components/context-item-list.tsx` | 234 | Context items display |
| `features/consultation/components/context-version-list.tsx` | 71 | Version history |
| `features/consultation/components/summary-panel.tsx` | 212 | Summary generation and display |
| `features/consultation/__tests__/consultation-access.test.ts` | 96 | Access control tests |
| `features/consultation/__tests__/consultation-data-mapping.test.ts` | 130 | Data mapping tests |
| `routes/_authenticated/consultation/index.tsx` | 6 | List route |
| `routes/_authenticated/consultation/$id.tsx` | 6 | Detail route |
