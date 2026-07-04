# TASK-249: Context Item Type Enhancements

| Field | Value |
|---|---|
| **Ticket** | TASK-249 |
| **Created** | 2026-03-28 |
| **Updated** | 2026-03-28 |
| **Status** | Completed |
| **Type** | Enhancement / Refactor |

---

## 1. Requirement Analysis

### Description

Audit and enhance consultation context item type handling across all layers — backend services, SDK, and UI Playground — to ensure complete and consistent support for all 9 `ContextItemType` values:

`AUDIO_RECORDING`, `WORKNOTE`, `RAW_SUMMARY`, `MODIFIED_SUMMARY`, `PRE_SUMMARY`, `NAMED_ENTITY`, `TRANSCRIPT`, `CASE_NOTE`, `ATTACHMENT`

### Business Context

The consultation workflow relies on context items as the primary data containers. While the Prisma schema and domain layer define 9 types, the application and UI layers have incomplete coverage — 3 types (`WORKNOTE`, `NAMED_ENTITY`, `ATTACHMENT`) are partially or fully missing from the SDK, API validation, and UI. Additionally, a critical field mismatch between the backend response (`isTranscript`) and SDK type (`isTranscription`) means the SDK consumers never see the derived boolean as `true`.

### Acceptance Criteria

1. **Backend Response DTO**: Add missing derived booleans (`isCaseNote`, `isWorknote`, `isNamedEntity`, `isAttachment`) to `ContextItemResponse`
2. **Backend DTO Validation**: `ContextFiltersDto.type` uses `@IsEnum()` instead of `@IsString()` for runtime validation
3. **Backend Service**: Add `addAttachment()` and `getAttachments()` convenience methods to `ContextService`
4. **SDK Types**: Fix `isTranscription` → `isTranscript` mismatch; add new derived booleans to `ContextItem` interface
5. **SDK Hook**: Add `addWorknote()`, `addAttachment()`, `fetchWorknotes()`, `fetchAttachments()` to `useArcaContext`
6. **SDK Store**: Add selectors for worknotes, attachments
7. **SDK Endpoints**: Add endpoint constants for worknotes and attachments
8. **UI Playground — Context Item List**: Add icons and labels for `WORKNOTE`, `NAMED_ENTITY`, `ATTACHMENT`
9. **UI Playground — Filter Dropdown**: Add `WORKNOTE`, `NAMED_ENTITY`, `ATTACHMENT` to filter options
10. **UI Playground — Add Context Form**: Add tabs for Work Note and Attachment (file upload)
11. **UI Playground — Version Detail Panel**: Add `worknote` and `attachment` kinds to `resolveKind()` switch
12. **UI Playground — Data Fetching**: Expand from `fetchCaseNotes()` + `fetchTranscriptions()` to a unified `getItems()` call that returns all types

---

## 2. Current State Evaluation

### 2.1 Type Coverage Matrix (Before)

| ContextItemType | Prisma/Domain | Factory | Repository | Service (add) | Service (get) | Response DTO | SDK Types | SDK Hook | UI Icon | UI Filter | UI Add Form | UI Detail |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AUDIO_RECORDING | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ (Mic) | ✅ | ✅ (Audio tab) | ✅ (AudioDetailView) |
| WORKNOTE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ❌ | ❌ | ❌ | ❌ (falls to default) |
| RAW_SUMMARY | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ (Bot) | ✅ | ✅ (Summary tab) | ✅ |
| MODIFIED_SUMMARY | ✅ | ✅ | ✅ | — (via addContext) | ✅ (in getSummaries) | ✅ | ✅ | — | ✅ (Bot) | ✅ | — (from edits) | ✅ |
| PRE_SUMMARY | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ (Bot) | ✅ | — (generated) | ✅ |
| NAMED_ENTITY | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ❌ | ❌ | ❌ | ❌ |
| TRANSCRIPT | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (FileText) | ✅ | — (auto from STT) | ✅ |
| CASE_NOTE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (ClipboardList) | ✅ | ✅ | ✅ |
| ATTACHMENT | ✅ | ✅ | ✅* | — | — | ✅ | ✅ | — | ❌ | ❌ | ❌ | ❌ (falls to default) |

*Repository has `findByType()` but no dedicated `findAttachments()`.

### 2.2 Specific Issues Found

#### Issue 1 (Critical): SDK `isTranscription` vs Backend `isTranscript`

- **Backend** `ContextItemResponse` has field `isTranscript: boolean`
- **SDK** `ContextItem` interface has field `isTranscription: boolean`
- These names don't match → SDK consumers see `isTranscription` as `undefined`

#### Issue 2 (Medium): No enum validation on `ContextFiltersDto.type`

- Uses `@IsString()` — any arbitrary string passes
- Should use `@IsEnum(ContextItemType)` or `@IsIn([...])` for runtime safety

#### Issue 3 (Medium): Missing ATTACHMENT service methods

- `ContextService` has no `addAttachment()` or `getAttachments()`
- Factory (`CreateAttachment`) and repository (`findByType`) exist but no service layer

#### Issue 4 (Medium): Missing SDK methods for WORKNOTE and ATTACHMENT

- `useArcaContext` hook has no `addWorknote()`, `addAttachment()`, `fetchWorknotes()`, `fetchAttachments()`
- No endpoints defined in `CONTEXT_ENDPOINTS` for worknotes/attachments

#### Issue 5 (Low): Response DTO missing derived booleans

- Entity has: `isCaseNote`, `isWorknote`, `isNamedEntity`, `isAttachment`
- Response DTO only has: `isSummary`, `isFinalSummary`, `isPreSummary`, `isTranscript`, `isAiGenerated`, `isMediaType`
- Missing: `isCaseNote`, `isWorknote`, `isNamedEntity`, `isAttachment`

#### Issue 6 (Low): UI Playground incomplete type coverage

- `WORKNOTE`: has label but no icon, no filter option, no add form, no detail config
- `NAMED_ENTITY`: completely absent from UI
- `ATTACHMENT`: has label but no icon, no filter option, no add form, no detail config

#### Issue 7 (Low): UI data fetching only covers 2 of 9 types

- Only calls `fetchCaseNotes()` + `fetchTranscriptions()`
- Should use a single `getItems()` call or fetch all types for completeness

#### Issue 8 (Low): Confusing dual naming aliases

- Service: `addTranscript()` / `addTranscription()` + `getTranscripts()` / `getTranscriptions()`
- Both exist as aliases — pick canonical name, deprecate other

---

## 3. Implementation Plan

### Task Overview

| Task | Layer | Description | Priority |
|---|---|---|---|
| T1 | Backend DTO | Add derived booleans to `ContextItemResponse` | Medium |
| T2 | Backend DTO | Add `@IsEnum()` to `ContextFiltersDto.type` | Medium |
| T3 | Backend Service | Add `addAttachment()` + `getAttachments()` to `ContextService` | Medium |
| T4 | Backend Repository | Add `findAttachments()` to `ContextItemRepository` | Medium |
| T5 | SDK Types | Fix `isTranscription` → `isTranscript` + add new booleans | Critical |
| T6 | SDK Endpoints | Add `WORKNOTES` + `ATTACHMENTS` endpoint constants | Low |
| T7 | SDK Hook | Add `addWorknote`, `addAttachment`, `fetchWorknotes`, `fetchAttachments` | Medium |
| T8 | SDK Store | Add selectors `selectWorknotes`, `selectAttachments` | Low |
| T9 | UI Playground | Complete type icons/labels for all 9 types | Low |
| T10 | UI Playground | Add WORKNOTE, NAMED_ENTITY, ATTACHMENT to filter dropdown | Low |
| T11 | UI Playground | Add Work Note tab to add-context form | Medium |
| T12 | UI Playground | Add Attachment tab to add-context form | Medium |
| T13 | UI Playground | Add worknote + attachment kinds to version-detail-panel | Low |
| T14 | UI Playground | Switch data fetching to unified `getItems()` or full-type fetch | Medium |

### Dependency Order

```
T4 → T3 → T1 → T2 (Backend — bottom-up)
T5 → T6 → T7 → T8 (SDK — types first, then hooks)
T9 → T10 → T11 → T12 → T13 → T14 (UI — visual first, then behavior)
```

Backend and SDK streams can execute in parallel. UI depends on SDK changes.

---

### Task T1: Add Derived Booleans to `ContextItemResponse`

**File**: `packages/applications/src/services/consultation/context/dto/context-item.response.ts`

**Changes**:
- Add `isCaseNote: boolean` — true when `type === CASE_NOTE`
- Add `isWorknote: boolean` — true when `type === WORKNOTE`
- Add `isNamedEntity: boolean` — true when `type === NAMED_ENTITY`
- Add `isAttachment: boolean` — true when `type === ATTACHMENT`
- Add `isTranscription: boolean` — alias for `isTranscript` (SDK backward compat)

**Tests**:
- Unit test: `ContextDtoMapper.toResponse()` sets new booleans correctly for each type
- Verify `isTranscription === isTranscript` always

**File**: `packages/applications/src/services/consultation/context/context.dto.mapper.ts`

**Changes**:
- Map new derived booleans from entity to response

---

### Task T2: Add Enum Validation to `ContextFiltersDto.type`

**File**: `packages/applications/src/services/consultation/context/dto/context-filters.dto.ts`

**Changes**:
- Replace `@IsString()` on `type` with `@IsEnum(ContextItemType)` or `@IsIn(Object.values(ContextItemType))`
- Import `ContextItemType` from `@arcaai/domains`

**Tests**:
- Unit test: valid enum values pass validation
- Unit test: invalid string value fails validation

---

### Task T3: Add ATTACHMENT Convenience Methods to `ContextService`

**File**: `packages/applications/src/services/consultation/context/context.service.ts`

**Changes**:
- Add `addAttachment(consultationId, content?, fileUrl?)` — creates ATTACHMENT context item
- Add `getAttachments(consultationId)` — queries ATTACHMENT type items

**Tests**:
- Unit test: `addAttachment()` creates correct ContextItem with type=ATTACHMENT, source=USER
- Unit test: `getAttachments()` filters correctly

---

### Task T4: Add `findAttachments()` to Repository

**File**: `packages/domains/src/repositories/generated/core/ContextItemRepository.ts`

**Changes**:
- Add `findAttachments(consultationId)` — mirrors `findCaseNotes()` / `findTranscripts()` pattern

**Tests**:
- Unit test: correct filter applied

---

### Task T5: Fix SDK `isTranscription` → `isTranscript` Mismatch + Add New Booleans

**File**: `packages/agentic-sdk-v2/src/types/context.ts`

**Changes**:
- Rename `isTranscription` → `isTranscript` in `ContextItem` interface
- Add `isTranscription` as `@deprecated` alias (backward compat)
- Add `isCaseNote`, `isWorknote`, `isNamedEntity`, `isAttachment`, `isFinalSummary`, `isPreSummary`, `isMediaType` to `ContextItem` interface

**File**: `packages/agentic-sdk-v2/src/store/agenticStore.ts`

**Changes**:
- Update `selectTranscriptions` selector to use `item.type === 'TRANSCRIPT'` (verify it doesn't use stale `isTranscription`)

**Tests**:
- Unit test: verify type interface compiles with new fields
- Unit test: store selectors filter correctly

---

### Task T6: Add SDK Endpoint Constants

**File**: `packages/agentic-sdk-v2/src/core/constants.ts`

**Changes**:
- Add `WORKNOTES: (consultationId) => ...` under `CONTEXT_ENDPOINTS`
- Add `ATTACHMENTS: (consultationId) => ...` under `CONTEXT_ENDPOINTS`

**Tests**:
- Unit test: endpoint path generation is correct

---

### Task T7: Add SDK Hook Methods

**File**: `packages/agentic-sdk-v2/src/hooks/useArcaContext.ts`

**Changes**:
- Add `addWorknote(content, metadata?)` — POST to add context with type=WORKNOTE
- Add `addAttachment(content?, metadata?)` — POST to add context with type=ATTACHMENT
- Add `fetchWorknotes()` — GET from worknotes endpoint
- Add `fetchAttachments()` — GET from attachments endpoint

**File**: `packages/agentic-sdk-v2/src/types/context.ts`

**Changes**:
- Add `addWorknote` and `addAttachment` to `ContextActions` interface
- Add `worknotes` and `attachments` to `ContextState` interface

**Tests**:
- Unit test: `addWorknote` calls API with correct type/source
- Unit test: `addAttachment` calls API with correct type/source
- Unit test: `fetchWorknotes` returns filtered items
- Unit test: `fetchAttachments` returns filtered items

---

### Task T8: Add SDK Store Selectors

**File**: `packages/agentic-sdk-v2/src/store/agenticStore.ts`

**Changes**:
- Add `selectWorknotes` — filters by `type === 'WORKNOTE'`
- Add `selectAttachments` — filters by `type === 'ATTACHMENT'`

**Tests**:
- Unit test: selectors filter correctly

---

### Task T9: Complete UI Type Icons and Labels

**File**: `apps/ui-playground/src/features/consultation/components/consultation-workspace.tsx`
**File**: `apps/ui-playground/src/features/consultation/components/context-item-list.tsx`

**Changes** (both files have duplicated `typeIcon` / `typeLabel` maps):
- Add to `typeIcon`: `WORKNOTE: StickyNote`, `NAMED_ENTITY: Tags`, `ATTACHMENT: Paperclip`
- Add to `typeLabel`: `NAMED_ENTITY: 'Named Entity'` (already has WORKNOTE and ATTACHMENT labels)

**Tests**:
- Unit test: all 9 ContextItemType values have an icon mapping
- Unit test: all 9 ContextItemType values have a label mapping

---

### Task T10: Add Missing Types to Filter Dropdown

**File**: `apps/ui-playground/src/features/consultation/components/consultation-workspace.tsx`

**Changes**:
- Add to `contextTypeOptions`: WORKNOTE, NAMED_ENTITY, ATTACHMENT

**Tests**:
- Unit test: `contextTypeOptions` contains all 9 types + "_all"

---

### Task T11: Add Work Note Tab to Add-Context Form

**File**: `apps/ui-playground/src/features/consultation/components/case-note-form.tsx`

**Changes**:
- Add a "Work Note" tab (4th tab) with content textarea
- On submit, call `context.addContext({ type: 'WORKNOTE', content, source: 'USER' })` or the new `context.addWorknote()`
- Update TabsList from `grid-cols-3` to `grid-cols-4`

**Tests**:
- Unit test: Work Note form renders
- Unit test: submission calls correct SDK method with type=WORKNOTE

---

### Task T12: Add Attachment Tab to Add-Context Form

**File**: `apps/ui-playground/src/features/consultation/components/case-note-form.tsx`

**Changes**:
- Add an "Attachment" tab (5th tab) with file upload
- On submit, upload file via `storage.uploadFile()`, then call `context.addContext({ type: 'ATTACHMENT', ... })` or `context.addAttachment()`
- Update TabsList from `grid-cols-4` to `grid-cols-5`

**Tests**:
- Unit test: Attachment form renders with file input
- Unit test: submission uploads file and creates correct context item

---

### Task T13: Add Missing Kinds to Version Detail Panel

**File**: `apps/ui-playground/src/features/consultation/components/version-detail-panel.tsx`

**Changes**:
- Add `worknote` kind: editable=true, no generation actions
- Add `attachment` kind: editable=false, read-only file view
- Add `named_entity` kind: editable=false, read-only entity view
- Update `resolveKind()` switch to handle `WORKNOTE`, `ATTACHMENT`, `NAMED_ENTITY`

**Tests**:
- Unit test: `resolveKind()` returns correct kind for all 9 types
- Unit test: `kindConfig` has entries for all kinds

---

### Task T14: Switch Data Fetching to Unified Approach

**File**: `apps/ui-playground/src/features/consultation/components/consultation-workspace.tsx`
**File**: `apps/ui-playground/src/features/consultation/components/context-item-list.tsx`

**Changes**:
- Replace dual `fetchCaseNotes()` + `fetchTranscriptions()` with `context.getItems()` (no filter → returns all types)
- Or use paginated endpoint: `context.getItems({ limit: 100 })`
- Ensure all 9 types are returned and displayed

**Tests**:
- Unit test: workspace loads all context item types
- Unit test: filtering works for all 9 types

---

## 4. Testing Strategy

### Test-Driven Development Order

Each task follows RED → GREEN → REFACTOR:

1. **Write failing test** for the expected behavior
2. **Implement minimum code** to pass
3. **Refactor** while tests stay green

### Test Files

| Layer | Test Location | Framework |
|---|---|---|
| Backend DTOs | `packages/applications/src/services/consultation/context/__tests__/` | Vitest |
| Backend Service | `packages/applications/src/services/consultation/context/__tests__/` | Vitest |
| Domain Repository | `packages/domains/src/repositories/__tests__/` | Vitest |
| SDK Types | `packages/agentic-sdk-v2/src/__tests__/` | Vitest |
| SDK Hook | `packages/agentic-sdk-v2/src/hooks/__tests__/` | Vitest |
| SDK Store | `packages/agentic-sdk-v2/src/store/__tests__/` | Vitest |
| UI Components | `apps/ui-playground/src/features/consultation/__tests__/` | Vitest |

---

## 5. Impact Assessment

### Packages Affected

| Package | Changes |
|---|---|
| `packages/domains` | Repository: add `findAttachments()` |
| `packages/applications` | Service: add methods; DTO: add booleans + enum validation |
| `packages/agentic-sdk-v2` | Types: fix mismatch + add fields; Hook: add methods; Store: add selectors; Constants: add endpoints |
| `apps/ui-playground` | Components: icons/labels/forms/filters/detail panel/data fetching |

### Breaking Changes

| Change | Breaking? | Migration |
|---|---|---|
| Add `isTranscript` to SDK `ContextItem` | No (additive) | — |
| Deprecate `isTranscription` on SDK | Soft break | Keep field, mark `@deprecated`, compute from `isTranscript` |
| Add new booleans to response DTO | No (additive) | — |
| Add `@IsEnum` to filter DTO | Potentially | Invalid type strings will now be rejected (was silently accepted) |
| Add new SDK hook methods | No (additive) | — |

### Risk Assessment

- **Low Risk**: Most changes are additive (new fields, new methods)
- **Medium Risk**: `@IsEnum` validation could reject previously-accepted invalid filter values
- **Medium Risk**: Deprecating `isTranscription` may require SDK consumers to update

---

## 6. Implementation Summary

### What Was Built

All 14 tasks completed (T4 was pre-existing). Changes span 3 layers:

**Backend (packages/applications)**
- Added 4 derived booleans (`isCaseNote`, `isWorknote`, `isNamedEntity`, `isAttachment`) to `ContextItemResponse` DTO and `ContextDtoMapper`
- Replaced `@IsString()` with `@IsIn(VALID_CONTEXT_TYPES)` on `ContextFiltersDto.type` for runtime validation
- Added `addAttachment()` and `getAttachments()` convenience methods to `ContextService`

**SDK (packages/agentic-sdk-v2)**
- Fixed `isTranscription` → `isTranscript` field name mismatch in `ContextItem` interface (kept deprecated alias)
- Added 7 new derived booleans to `ContextItem`: `isCaseNote`, `isWorknote`, `isNamedEntity`, `isAttachment`, `isFinalSummary`, `isPreSummary`, `isMediaType`
- Added `WORKNOTES` and `ATTACHMENTS` endpoint constants
- Added `addWorknote()`, `addAttachment()`, `fetchWorknotes()`, `fetchAttachments()` to `useArcaContext` hook
- Added `worknotes` and `attachments` to `ContextState` and `ContextActions` interfaces
- Added `selectWorknotes` and `selectAttachments` store selectors
- Fixed test mock to include new selectors

**UI Playground (apps/ui-playground)**
- All 9 context item types now have icons (added `StickyNote`, `Tags`, `Paperclip` for WORKNOTE, NAMED_ENTITY, ATTACHMENT)
- All 9 types have labels in both `typeIcon` and `typeLabel` maps
- Filter dropdown now includes all 9 types
- Add Context form has 5 tabs: Case Note, Summary, Work Note, Audio File, Attachment
- Version detail panel handles all 9 types via `resolveKind()` with appropriate configs
- Data fetching switched from dual `fetchCaseNotes()`+`fetchTranscriptions()` to unified `getItems()`

### Files Changed

| File | Purpose |
|---|---|
| `packages/applications/src/services/consultation/context/dto/context-item.response.ts` | Added isCaseNote, isWorknote, isNamedEntity, isAttachment booleans |
| `packages/applications/src/services/consultation/context/context.dto.mapper.ts` | Map new booleans from entity |
| `packages/applications/src/services/consultation/context/dto/context-filters.dto.ts` | @IsIn() validation on type field |
| `packages/applications/src/services/consultation/context/context.service.ts` | addAttachment(), getAttachments() |
| `packages/applications/src/services/consultation/context/__tests__/context.dto.mapper.test.ts` | Tests for new booleans |
| `packages/agentic-sdk-v2/src/types/context.ts` | Fixed isTranscription→isTranscript, added new booleans/state/actions |
| `packages/agentic-sdk-v2/src/core/constants.ts` | WORKNOTES, ATTACHMENTS endpoints |
| `packages/agentic-sdk-v2/src/hooks/useArcaContext.ts` | addWorknote, addAttachment, fetchWorknotes, fetchAttachments |
| `packages/agentic-sdk-v2/src/store/agenticStore.ts` | selectWorknotes, selectAttachments selectors |
| `packages/agentic-sdk-v2/src/store/index.ts` | Barrel exports for new selectors |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useArcaContext.test.ts` | Fixed mock for new selectors |
| `apps/ui-playground/src/features/consultation/components/consultation-workspace.tsx` | Icons, labels, filter options, unified data fetch |
| `apps/ui-playground/src/features/consultation/components/context-item-list.tsx` | Icons, labels, unified data fetch |
| `apps/ui-playground/src/features/consultation/components/case-note-form.tsx` | Work Note tab, Attachment tab |
| `apps/ui-playground/src/features/consultation/components/version-detail-panel.tsx` | worknote, attachment, named_entity kinds |

### Test Evidence

- Backend (packages/applications): **3585/3585 passed** (177 context-specific tests)
- SDK (packages/agentic-sdk-v2): **2627/2627 passed** (3 context hook tests)
- UI Playground: Pre-existing failures in unrelated audio/dna modules; no new failures introduced

---

## 7. Change History

| Date | Description | Files Modified |
|---|---|---|
| 2026-03-28 | Initial plan created | This document |
| 2026-03-28 | Implementation completed — all 14 tasks done | 15 files across 3 packages |
