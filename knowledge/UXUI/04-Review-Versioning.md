# 04 — Doctor Review, Editing & Versioning

> **Wireframe**: Summary Review & Versioning Panel  
> **Last Updated**: 2026-02-26  
> **Status**: Design Specification  
> **Related Pages**: `summary-workflow.tsx` (Edit/History/Diff tabs)

---

## 1. Overview

The Summary Review & Versioning panel enables doctors to edit AI-generated summaries with change reasons, view version history, compare versions side-by-side with a diff view, and approve/lock summaries. AI-generated vs doctor-edited content is highlighted via left-border color coding for audit and learning.

### Core Workflow

```
Summary generated (AI)
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│  EDIT                                                                 │
│  • Rich text editor with AI/doctor highlighting                       │
│  • Change reason required before save                                 │
│  • Save as new version → audit trail updated                          │
└───────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│  VERSION HISTORY                                                      │
│  • Chronological list: source (AI/Doctor), timestamp, reason         │
│  • Click to load any version                                          │
│  • Revert to previous version                                         │
└───────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│  DIFF COMPARISON                                                      │
│  • Select two versions from dropdowns                                 │
│  • Side-by-side diff with added/removed highlighting                 │
└───────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│  APPROVE & LOCK                                                       │
│  • Approve button → status: APPROVED → LOCKED                        │
│  • Triggers NER extraction on finalized content                       │
│  • No further edits without reopening                                │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 2. User Stories

| # | Persona | Story | Priority |
|---|---------|-------|----------|
| 7 | Doctor | Edit an AI-generated summary with a change reason, so that I can correct inaccuracies while maintaining an audit trail. | — |
| 8 | Doctor | View the version history of a summary, so that I can track how the document evolved over time. | — |
| 9 | Doctor | Compare two versions of a summary side-by-side with a diff view, so that I can see exactly what changed between revisions. | — |
| 144 | Doctor | All my edits to a summary to be tracked as a new version with a diff view, so that I can see exactly what I changed and the audit trail is complete. | High |
| 145 | Doctor | Annotate specific summary sections with correction reasons (e.g., "medication dosage incorrect", "diagnosis updated"), so that the AI can learn from my corrections over time. | Medium |
| 146 | Doctor | Revert a summary to any previous version, so that I can undo unintended changes. | Medium |
| 147 | Doctor | See which parts of a summary were AI-generated vs doctor-edited, so that I can assess AI accuracy for my workflow. | Medium |
| 148 | Doctor | An "approve" action that marks the summary as doctor-reviewed and locks it from further AI modification, so that my final clinical judgment is preserved. | High |
| 149 | Doctor | The NER extraction to run automatically after I approve a summary, so that the structured medical entities (medications, conditions, procedures) are extracted from my finalized content. | Medium |
| 150 | Doctor | Flag specific named entities as incorrect and provide the correct entity, so that the NER model's training data is improved over time. | Low |

---

## 3. Wireframe Description

### 3.1 Summary Editor

- **Rich text area**: Full summary content editable. Supports paragraphs, line breaks, basic formatting.
- **AI vs doctor highlighting**: Left-border color coding per paragraph or segment:
  - **Blue border**: AI-generated (unchanged)
  - **Green border**: Doctor-edited
  - Hover tooltip: "Edited by [Doctor Name] on [Date] — [Change reason]"
- **Read-only when locked**: When summary status is APPROVED or LOCKED, editor is disabled with message "Summary locked. Reopen consultation to edit."

### 3.2 Change Reason Input

- **Required before save**: Modal or inline field that must be filled before "Save as new version".
- **Placeholder**: "e.g., Corrected medication dosage, Updated diagnosis"
- **Feeds audit trail**: Stored with `changeSource: 'doctor_edit'` and `changeReason` in version metadata.
- **Validation**: Min length (e.g., 10 chars), max length (e.g., 500 chars).

### 3.3 Action Buttons

| Button | Condition | Action |
|--------|-----------|--------|
| **Save as new version** | Content changed, change reason provided | PATCH summary, creates new version |
| **Revert to previous** | Version history exists | Load previous version content, prompt for confirmation + reason |
| **Approve & Lock** | Summary in DRAFT, doctor has reviewed | POST approve → LOCKED, triggers NER extraction |

### 3.4 Version Timeline

- **Chronological list**: Newest first (or configurable).
- **Each entry shows**:
  - Version number
  - Source badge: "AI" or "Doctor"
  - Timestamp (relative: "2 hours ago" + absolute on hover)
  - Change reason (if provided)
  - "Load" button to display that version in editor
- **Click to load**: Selecting a version loads its content into the editor (read-only preview or editable revert).

### 3.5 Diff Comparison

- **Version selector dropdowns**: "Compare version [v1 ▼] with [v2 ▼]"
- **Side-by-side layout**: Left = older version, Right = newer version.
- **Highlighting**:
  - **Green background**: Added text
  - **Red background**: Removed text
  - **Neutral**: Unchanged
- **Word-level diff**: For prose; line-level for structured sections.
- **Stats**: "X additions, Y deletions" summary.

### 3.6 Approval Workflow

- **Approve button**: Visible when summary status is DRAFT.
- **Confirmation**: "Approve and lock this summary? NER extraction will run automatically. You will need to reopen the consultation to make further edits."
- **On success**: Status badge changes to "Approved" → "Locked".
- **NER extraction**: Triggered automatically via `POST /consultations/:id/summary/:contextItemId/extract-entities` (or async variant).
- **Locked state**: Editor disabled; "Reopen consultation" required for edits.

---

## 4. API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| PATCH | `/consultations/:id/summary/:contextItemId` | Update summary content (creates new version). Body: `{ content, changeReason?, changeSource? }` |
| GET | `/consultations/:id/context/:contextId/versions` | Get version history for context item (includes summaries) |
| GET | `/consultations/:id/summary/:contextItemId/versions` | Get summary version history (SDK path; may alias to context) |
| GET | `/consultations/:id/context/:contextId/versions/:versionNumber` | Get specific version content |
| GET | `/consultations/:id/summary` | List all summaries for consultation |
| POST | `/consultations/:id/summary/:contextItemId/extract-entities` | Trigger NER extraction (sync) |
| POST | `/consultations/:id/summary/:contextItemId/extract-entities/async` | NER extraction (async) |
| POST | `/consultations/:id/summary/:contextItemId/approve` | Approve and lock summary (SDK constant; backend may be pending) |
| GET | `/consultations/:id/named-entities` | Get aggregate named entities for consultation |
| GET | `/admin/audit-logs/resource/:type/:id` | Get audit trail for resource |
| POST | `/feedback/summary` | Submit summary feedback |
| POST | `/feedback/labels` | Submit feedback labels batch |

**Note**: The approve endpoint (`POST .../approve`) is defined in the SDK but may not yet exist in the API. Version history is served by `GET /consultations/:id/context/:contextId/versions` for all context items including summaries.

---

## 5. SDK Integration

### 5.1 Hooks

| Hook | Purpose |
|------|---------|
| `useArcaSummary()` | Update, history, compare, approve |
| `useArca()` | Exposes `summary` with same methods |

### 5.2 Methods

```typescript
// Update summary (creates version)
summary.updateSummary(id, content, { changeReason, changeSource: 'doctor_edit' })

// Version history
summary.getSummaryHistory(summaryId)  // → SummaryVersionEntry[]

// Compare versions (fetches both, computes diff client-side)
summary.compareSummaryVersions(contextItemId, v1, v2)  // → DiffResult

// Approve and lock
summary.approveSummary(contextItemId)  // → SummaryApprovalResponse
```

### 5.3 Types

| Type | Description |
|------|-------------|
| `UpdateSummaryOptions` | `{ changeReason?, changeSummary?, changeSource?: 'doctor_edit' \| 'ai_regeneration' \| 'system' }` |
| `SummaryVersionEntry` | `{ id, contextItemId, versionNumber, content, changeReason?, changeSource?, changedBy?, createdAt }` |
| `SummaryApprovalResponse` | `{ contextItemId, approvalStatus, approvedBy, approvedAt }` |
| `DiffResult` | `{ changes: DiffChange[], patch: string, stats: DiffStats }` |

### 5.4 Utilities

| Utility | Description |
|---------|-------------|
| `computeDiff(oldText, newText, mode)` | Generic diff (lines/words/chars) |
| `computeSummaryDiff(oldContent, newContent)` | Word-level diff for prose |
| `createUnifiedPatch(filename, oldStr, newStr)` | Unified patch string |

---

## 6. Data Models

### ContextItem Versioning

Each update to a summary creates a `ContextItemVersion` record:

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Version record ID |
| `contextItemId` | UUID | FK to ContextItem |
| `versionNumber` | int | 1-based, incrementing |
| `content` | text | Snapshot of content at this version |
| `changeReason` | string? | Doctor-provided reason |
| `changeSource` | enum? | doctor_edit, ai_regeneration, system |
| `changedBy` | UUID? | User ID |
| `createdAt` | timestamp | When version was created |

### SummaryApprovalStatus

| Status | Description |
|--------|-------------|
| `DRAFT` | Editable; not yet approved |
| `APPROVED` | Doctor approved; transitioning to locked |
| `LOCKED` | Final; no edits without reopening |

### AuditLog

| Field | Type | Description |
|-------|------|-------------|
| `resourceType` | string | e.g., "ContextItem", "Consultation" |
| `resourceId` | UUID | ID of affected resource |
| `action` | string | e.g., "UPDATE", "APPROVE" |
| `userId` | UUID | Who performed the action |
| `metadata` | jsonb | changeReason, changeSource, etc. |
| `createdAt` | timestamp | When action occurred |

---

## 7. Existing Implementation & Gaps

### Current Implementation

- **`summary-workflow.tsx`**: Edit tab with `editContent`, `changeReason`, `editingId`. Save calls `summary.updateSummary()`. History tab uses `VersionTimeline`, Diff tab uses `DiffViewer` with `compareSummaryVersions()`.
- **`VersionTimeline`**: Renders version list with version number, timestamp, change reason, load action.
- **`DiffViewer`**: Accepts `changes` array (`{ value, added?, removed? }[]`), renders side-by-side or unified diff.
- **`useArcaSummary`**: `updateSummary`, `getSummaryHistory`, `compareSummaryVersions`, `approveSummary` implemented.

### Gaps vs. User Stories

| Gap | Stories | Description |
|-----|---------|-------------|
| Approve endpoint may not exist | #148 | SDK has `approveSummary` and APPROVE constant; API may not have route |
| No AI vs doctor highlighting | #147 | Editor does not show left-border color coding for AI vs edited segments |
| Section-level correction reasons | #145 | Change reason is global per version; no per-section annotation |
| Revert UX | #146 | Can load previous version; "Revert" as explicit action with confirmation may be incomplete |
| NER auto-trigger on approve | #149 | Approve flow should trigger NER; integration may be manual |
| Entity flagging | #150 | No UI to flag incorrect NER entities with correction |
| Change reason validation | #7 | May not enforce required change reason before save |
| Locked state handling | #148 | Read-only when LOCKED; reopen flow may be incomplete |

---

## 8. UX Best Practices

1. **Change reason required** — Never allow save without a reason; use inline validation and disable button until valid.
2. **AI vs doctor highlighting** — Left-border color coding (blue/green) for quick visual scan of what was edited.
3. **Version timeline clarity** — Show source (AI/Doctor), timestamp, reason. "Load" is explicit; avoid accidental overwrite.
4. **Diff word-level for prose** — Use word-level diff for summaries; line-level for structured content.
5. **Approve confirmation** — Modal explaining lock + NER; require explicit confirmation.
6. **Revert confirmation** — "Revert to v3? This will create a new version. Reason: [required]."
7. **Locked state messaging** — "Summary locked. Reopen consultation to edit." with clear CTA.
8. **Audit trail access** — Link to audit logs for compliance officers; show recent changes in timeline.
9. **Keyboard shortcuts** — Cmd/Ctrl+S to save (with reason prompt if empty).
10. **Responsive diff** — On narrow screens, stack diff vertically or use unified view instead of side-by-side.
