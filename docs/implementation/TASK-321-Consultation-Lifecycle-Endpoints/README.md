# TASK-321 — Consultation Lifecycle Endpoints (close / reopen / update)

| Field | Value |
|---|---|
| Ticket | TASK-321 |
| Title | Consultation Lifecycle Endpoints (close / reopen / update) |
| Type | feature (bugfix — SDK calls 404 at runtime) |
| Created | 2026-05-31 |
| Updated | 2026-05-31 |
| Status | Completed |
| Branch | `task-321-consultation-lifecycle` |

---

## 1. Requirement Analysis

### Description
The `@arcaai/vox` SDK calls three consultation endpoints that **do not exist** on the
backend API gateway, so they return **404 at runtime**:

| SDK call | Method + Path | Body | Expects |
|---|---|---|---|
| `useArcaSession.close()` | `POST /api/v1/consultations/:id/close` | `{}` | updated `Consultation` |
| `useArcaSession.reopen()` | `POST /api/v1/consultations/:id/reopen` | `{}` | updated `Consultation` |
| `CONSULTATION_ENDPOINTS.UPDATE` | `PATCH /api/v1/consultations/:id` | mutable fields | updated `Consultation` |

(Confirmed in `packages/agentic-sdk-v2/src/core/constants.ts` `CONSULTATION_ENDPOINTS` and
`packages/agentic-sdk-v2/src/hooks/useArcaSession.ts`.)

### Business context
A consultation has a lifecycle: a doctor opens a session, works in it, then **closes** it when
done. A closed consultation can be **reopened** to add late context/corrections. `PATCH` lets the
owner amend safely-mutable metadata (department, scheduling, free-form metadata, status).

### Acceptance criteria
- `POST /consultations/:id/close` transitions the consultation to **CLOSED** and returns it.
- `POST /consultations/:id/reopen` transitions it back to **OPEN** and returns it.
- `PATCH /consultations/:id` updates only safely-mutable fields and returns the consultation.
- All three are gated by **write** access (owner doctor OR admin/dept-head with CASL
  `manage Consultation`) via the existing `verifyConsultationOwnership` helper.
- Tenant isolation is preserved (service is tenant-scoped + `assertEqualTenants` defense-in-depth).
- TDD: failing test first, then implementation; affected packages build; unit tests pass.

---

## 2. Current State Evaluation

### Existing patterns reused
- **Controller** `apps/api/src/modules/consultation/consultation.controller.ts` — uses the custom
  `@ApiEndpoint({ returnedModel, method, path, by })` decorator (wraps NestJS `@Get/@Post/@Patch`).
  Helpers `verifyConsultationOwnership(id)` (write) and `verifyConsultationAccess(id)` (read) already
  exist. `open` and `getById` are the closest templates.
- **Service** `packages/applications/src/services/consultation/consultation/consultation.service.ts`
  (+ `IConsultationService.ts`) — tenant-scoped (`this.tenantId`), emits `SysEvent`s via
  `broadcastSysEvent`, maps via `ConsultationDtoMapper`, asserts tenant via `assertEqualTenants`.
- **Repository** `packages/domains/src/repositories/generated/core/ConsultationRepository.ts` —
  generated; base `Repository.update(id, entity)` persists tracked entity changes
  (`toPersistenceChanges`). `findWithRelations(id)` returns the entity with Doctor/Department/Context
  (or `null`).

### The consultation STATUS model — finding
The `Consultation` Prisma model (`packages/database/src/prisma/db_main/consultation.prisma`) has
**no dedicated open/closed status column**. It only has:
- `resourceStatus: ResourceStatusType` (`ENABLED | DISABLED | ARCHIVED | DELETED`) — the
  **soft-delete / audit lifecycle**, NOT a consultation open/closed state. Every repository read
  filters `resourceStatus: ENABLED`, so repurposing it for "closed" would make a closed consultation
  **disappear from all reads** (you could not fetch it via `getById` nor `reopen` it). Unworkable.
- `metadata: Json?` — a free-form JSON field already surfaced in `ConsultationResponse`.

The SDK's `Consultation.status` (`OPEN | RECORDING | … | CLOSED | CANCELLED`) is **optional** with an
explicit comment: *"absent when backend hasn't adopted the extended enum."* So the backend has not
adopted a status column yet, and a lightweight representation is expected.

**Decision — represent lifecycle status in `metadata.status`** (values `OPEN` / `CLOSED`); absent ⇒
treated as `OPEN`. Surface a derived top-level `status` on `ConsultationResponse` (read from
`metadata.status`, default `OPEN`) so the SDK's `consultation.status` is populated end-to-end.
- No DB migration; no edits to generated entity/factory/mapper/repository.
- Audit timestamps `closedAt` / `reopenedAt` are also written into `metadata`.

### Design decisions
- **Idempotency**: `close` on an already-CLOSED consultation (and `reopen` on an already-OPEN one) is
  **idempotent** — it returns the consultation in the target state **without** a DB write or
  `SysEvent` (no version churn, no audit noise). Rationale: the SDK fires these with an empty body
  from UI actions; double-clicks / retries must not 400.
- **PATCH allowed (safely-mutable) fields** — `UpdateConsultationRequest`:
  - `appointmentDate?` (YYYY-MM-DD) — rescheduling
  - `departmentId?` — re-assign department (tenant-checked via `assertParentInScope`, audit C-2)
  - `metadata?` — shallow-merged into existing metadata (does not clobber other keys / `status`)
  - `status?` (`OPEN` | `CLOSED`) — lifecycle status (stored in `metadata.status`)
  - **Forbidden**: `patientId`, `doctorId`, `tenantId` (identity/ownership) and `parentConsultationId`
    (structural chain link, set only at creation).
- **Events**: `close`/`reopen`/`update` emit `SysEventType.ResourceUpdated` (matches the
  mutation-broadcast convention used elsewhere in the service).

---

## 3. Implementation Plan / TDD test list

### Layer order
Application Service (DTO + interface + impl + mapper) → API Controller.

### Files to add / modify
1. `packages/applications/src/services/consultation/consultation/dto/update-consultation.request.ts` (NEW) —
   `UpdateConsultationRequest` DTO + `CONSULTATION_STATUS` const + `ConsultationLifecycleStatus` type.
2. `…/dto/index.ts` — export the new file.
3. `…/dto/consultation.response.ts` — add optional `status?: string`.
4. `…/consultation.dto.mapper.ts` — derive `status` from `metadata.status` (default `OPEN`).
5. `…/IConsultationService.ts` — add `closeConsultation`, `reopenConsultation`, `updateConsultation`.
6. `…/consultation.service.ts` — implement the three methods.
7. `apps/api/src/modules/consultation/consultation.controller.ts` — add `close`, `reopen`, `update`
   routes (`@ApiEndpoint` pattern) gated by `verifyConsultationOwnership`.

### Tests (TDD — write failing first)
**Service** (`…/consultation/__tests__/consultation.service.test.ts`):
- `closeConsultation` — sets `metadata.status = 'CLOSED'`, persists, emits `ResourceUpdated`, returns `status: 'CLOSED'`.
- `closeConsultation` — idempotent when already CLOSED (no `update`, no event).
- `closeConsultation` — `NotFoundException` when consultation missing; `BadRequestException` when no tenant; `NotFoundException` (generic) on cross-tenant row.
- `reopenConsultation` — sets `metadata.status = 'OPEN'`, persists, returns `status: 'OPEN'`; idempotent when already OPEN/absent.
- `updateConsultation` — updates departmentId/appointmentDate/metadata(merge)/status; emits `ResourceUpdated`; tenant guards; cross-tenant department → `NotFoundException`.

**Mapper** (`…/consultation.dto.mapper.test.ts`):
- derives `status` from `metadata.status`; defaults `OPEN` when metadata null / no status.

**Controller** (`apps/api/src/modules/consultation/__tests__/consultation.controller.test.ts`):
- `close` / `reopen` / `update` delegate to the service for the owner.
- `close` / `reopen` / `update` enforce `verifyConsultationOwnership` (Forbidden for non-owner; NotFound when missing).

### Verification criteria
- `pnpm build:api` succeeds.
- `pnpm build --filter @arcaai/applications` succeeds.
- Consultation service + mapper + controller unit tests pass (capture counts).

---

## 4. Implementation Summary

### Endpoints added (all gated by `verifyConsultationOwnership`)
| Method + Path | Controller method | Service method | Returns |
|---|---|---|---|
| `PATCH /consultations/:id` | `update` | `updateConsultation(id, req)` | `ConsultationResponse` |
| `POST /consultations/:id/close` | `close` | `closeConsultation(id)` | `ConsultationResponse` |
| `POST /consultations/:id/reopen` | `reopen` | `reopenConsultation(id)` | `ConsultationResponse` |

### Behaviour
- **Status model**: lifecycle stored in `metadata.status` (`OPEN`/`CLOSED`; absent ⇒ `OPEN`).
  `ConsultationResponse.status` is **derived** in the mapper. Audit timestamps `closedAt`/`reopenedAt`
  are written into `metadata`. No DB migration, no edits to generated entity/factory/mapper/repo.
- **close / reopen are idempotent**: already in the target state ⇒ returns current state with **no**
  `repository.update` and **no** `SysEvent`.
- **update**: merges (shallow) `metadata`, sets `appointmentDate` / `departmentId` / `status`;
  `departmentId` re-assignment is tenant-checked (`assertParentInScope`, audit C-2). Identity fields
  (`patientId`/`doctorId`/`tenantId`) and `parentConsultationId` are **not** mutable.
- All three mutations emit `SysEventType.ResourceUpdated` with `data.action` =
  `closeConsultation` / `reopenConsultation` / `updateConsultation`, plus tenant-scope defense
  (`assertEqualTenants`) and `updatedBy` audit stamping.

### Files changed
**`packages/applications`**
- `…/consultation/dto/update-consultation.request.ts` **(NEW)** — `UpdateConsultationRequest` DTO,
  `CONSULTATION_STATUS` const, `ConsultationLifecycleStatus` type, `CONSULTATION_STATUS_VALUES`.
- `…/consultation/dto/index.ts` — export the new DTO.
- `…/consultation/dto/consultation.response.ts` — add derived `status?: string`.
- `…/consultation/consultation.dto.mapper.ts` — derive `status` from `metadata.status` (default `OPEN`).
- `…/consultation/IConsultationService.ts` — add `closeConsultation` / `reopenConsultation` / `updateConsultation`.
- `…/consultation/consultation.service.ts` — implement the three methods (+ `readStatus` / `transitionStatus` helpers).
- `…/consultation/__tests__/consultation.service.test.ts` — +14 lifecycle tests.
- `…/consultation/__tests__/consultation.dto.mapper.test.ts` — +3 status-derivation tests.

**`apps/api`**
- `…/modules/consultation/consultation.controller.ts` — add `update` (PATCH), `close`, `reopen` (POST) routes.
- `…/modules/consultation/__tests__/consultation.controller.test.ts` — +7 tests (ownership + delegation wiring).

### Verification evidence
| Gate | Result |
|---|---|
| `pnpm build:api` | ✅ `Tasks: 8 successful, 8 total` |
| `pnpm build --filter @arcaai/applications` | ✅ `Tasks: 7 successful, 7 total` |
| Service unit tests | ✅ `83 passed` (69 pre-existing + 14 new) |
| Mapper unit tests | ✅ `24 passed` (21 pre-existing + 3 new) |
| Controller unit tests | ✅ `63 passed` (56 pre-existing + 7 new) |
| `ReadLints` (modified files) | ✅ No linter errors |

---

## 5. Change History

| Date | Description | Files |
|---|---|---|
| 2026-05-31 | Initial plan, status-model investigation, design decisions | this README |
| 2026-05-31 | Implemented close/reopen/update (service + controller + DTO + mapper) TDD; builds + tests green | see Files changed |
