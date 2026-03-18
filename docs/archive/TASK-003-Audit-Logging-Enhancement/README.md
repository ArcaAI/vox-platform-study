# Event-Driven Audit Logging Enhancement

- **Ticket**: TASK-003
- **Created**: 2026-02-06
- **Last Updated**: 2026-02-06
- **Status**: Completed

---

## Change History

### Update #1 — 2026-02-06: Service-Wide `previousData` Audit & Fix

**Issue**: Comprehensive audit of all 30+ services in `packages/applications` revealed that 17 services had an incorrect `previousData` capture in their `update()` methods. The `previousData` field was being set to `updatedEntity.toObject()` — the **post-update** state — instead of the **pre-update** state. This means audit logs were recording the same data for both `data` and `previousData`, making it impossible to determine what actually changed.

**Root Cause**: After `this.updateEntity(entity, dto)` modifies the entity in-place, calling `.toObject()` on it (or the repository return value) reflects the new state. The state must be captured **before** `updateEntity()` is called.

**Affected Services (17)**:
- `user.service.ts`, `userGroup.service.ts`, `userGroupAssignment.service.ts`, `userProfile.service.ts`, `userRoleAssignment.service.ts`, `userSettings.service.ts`
- `permission.service.ts`, `role.service.ts`, `rolePermission.service.ts`
- `notification.service.ts`, `webhook.service.ts`, `tag.service.ts`
- `globalSetting.service.ts`, `tenant.service.ts`
- `media.service.ts`, `userMedia.service.ts`
- `resourceSubscription.service.ts`

**Fix**: Added `const previousData = entity.toObject();` before `this.updateEntity()` call, and changed the event payload to use the captured snapshot.

**Already Correct**: `department.service.ts`, `summary.service.ts` (had proper pattern)

**Verification**: All 5092 unit tests pass with 0 failures.

---

## Requirement Analysis

Review and enhance the event-driven audit logging system across `packages/applications` to fix architectural issues, improve type safety, add resilience, and improve observability.

### Business Context

The audit logging system is critical for HIPAA compliance, security monitoring, and operational visibility. Issues found during review could lead to missing audit trails, duplicated logs, or data inconsistencies.

### Acceptance Criteria

- [x] Resolve dual event listener ambiguity between `SysEventType` and `EventTypes`
- [x] Fix `AuditAction.LOGIN` usage for authentication events
- [x] Standardize `resourceId` on all view events across all services
- [x] Add missing audit events in `DepartmentService` and `ApiKeyService`
- [x] Create strongly typed event map for compile-time validation
- [x] Add BullMQ retry/backoff configuration for audit log jobs
- [x] Propagate `correlationId` through the full audit pipeline
- [x] Add structured metrics logging for observability

---

## Current State Evaluation (Pre-Implementation)

### Critical Finding: Dead Event Handlers

The `AuditLogService` had `@OnEvent(EventTypes.ResourceCreated)` handlers listening on `'resource.created'`, but `broadcastSysEvent()` emits on `SysEventType.ResourceCreated` = `'SysEvent.ResourceCreated'`. These are **different strings**, so the CRUD event handlers in `AuditLogService` were **never triggered** (dead code).

The actual audit log creation path:
1. Services call `broadcastSysEvent(SysEventType.*)` 
2. `SysEventService` handles `@OnEvent(SysEventType.*)` → queues jobs to Redis
3. Background worker processes the Redis jobs → creates audit logs

Only the `UserAuthenticated` handler worked correctly because `AuthService` emits `EventTypes.UserAuthenticated`.

### Other Issues Found

| Issue | Severity | Impact |
|-------|----------|--------|
| Dead CRUD event handlers in AuditLogService | Critical | Dead code giving false sense of coverage |
| `AuditAction.READ` used for LOGIN events | Medium | Incorrect audit action classification |
| Missing `resourceId` on 16 view events | Medium | Reduced audit trail specificity |
| Missing audit events in DepartmentService, ApiKeyService | Medium | Audit gaps for department/API key operations |
| No type safety for event emissions | Medium | Runtime errors possible from mismatched payloads |
| No BullMQ retry/DLQ for audit log jobs | Medium | Transient failures cause permanent audit data loss |
| `correlationId` not propagated to Redis jobs | Medium | Broken distributed tracing for audit logs |
| `EventThrottleService` unused | Low | Unnecessary code in module |

---

## Implementation Plan

### Phase 1: Fix Current Issues (Low Risk)
1. Remove dead CRUD event handlers from `AuditLogService`
2. Fix `AuditAction.LOGIN` usage in `handleUserAuthenticatedEvent`
3. Standardize `resourceId` on all view events
4. Add missing audit events

### Phase 2: Type Safety (Medium Risk)
1. Create `TypedEventEmitter` wrapper with `HopeEventMap`

### Phase 3: Resilience (Medium Risk)
1. Deprecate unused `EventThrottleService`
2. Add BullMQ retry/backoff for audit log jobs
3. Propagate `correlationId` and `tenantId` through pipeline

### Phase 4: Observability (Low Risk)
1. Add structured metrics logging to `SysEventService`

---

## Implementation Summary

### Phase 1.1: Removed Dead CRUD Event Handlers

**Files Modified:**
- `packages/applications/src/services/auditLog/auditLog.service.ts`
- `packages/applications/src/services/auditLog/IAuditLogService.ts`
- `packages/applications/src/services/auditLog/__tests__/auditLog.service.test.ts`

**Changes:**
- Removed 4 dead `@OnEvent(EventTypes.Resource*)` handlers that were never triggered
- Removed `ResourceEvent` import (no longer needed)
- Updated interface to remove dead handler method signatures
- Added comprehensive JSDoc documenting the dual-path audit architecture
- Updated tests: removed tests for dead handlers, added architecture boundary tests
- Added tests for `handleUserAuthenticatedEvent` with LOGIN action

### Phase 1.2: Fixed AuditAction.LOGIN

**Files Modified:**
- `packages/applications/src/services/auditLog/auditLog.service.ts`

**Changes:**
- Changed `AuditAction.READ` to `AuditAction.LOGIN` in `handleUserAuthenticatedEvent`
- Removed TODO comment about migration (LOGIN action already exists in Prisma schema)

### Phase 1.3: Standardized resourceId on View Events

**Files Modified (16 services):**
- `packages/applications/src/services/user/user/user.service.ts`
- `packages/applications/src/services/tenant/tenant.service.ts`
- `packages/applications/src/services/security/role/role.service.ts`
- `packages/applications/src/services/media/media/media.service.ts`
- `packages/applications/src/services/user/userSettings/userSettings.service.ts`
- `packages/applications/src/services/security/permission/permission.service.ts`
- `packages/applications/src/services/globalSetting/globalSetting.service.ts`
- `packages/applications/src/services/tag/tag.service.ts`
- `packages/applications/src/services/security/rolePermission/rolePermission.service.ts`
- `packages/applications/src/services/user/userRoleAssignment/userRoleAssignment.service.ts`
- `packages/applications/src/services/user/userGroup/userGroup.service.ts`
- `packages/applications/src/services/user/userProfile/userProfile.service.ts`
- `packages/applications/src/services/media/userMedia/userMedia.service.ts`
- `packages/applications/src/services/user/userGroupAssignment/userGroupAssignment.service.ts`
- `packages/applications/src/services/webhook/webhook.service.ts`
- `packages/applications/src/services/notification/notification.service.ts`

**Changes:**
- Replaced redundant `responsibleEntityId: this.clsService.get('user')?.id` with `resourceId: <entity>.id`
- `responsibleEntityId` is already auto-set by `broadcastSysEvent()` from CLS context

### Phase 1.4: Added Missing Audit Events

**Files Modified:**
- `packages/applications/src/services/department/department.service.ts`
- `packages/applications/src/services/apiKey/apikey.service.ts`

**Changes:**
- Added `SysEventType.ResourceViewed` to `getRootDepartments()` and `getChildren()`
- Added `SysEventType.ResourceUpdated` to `updateUsage()` with `disableAuditLog: true` (high-frequency operation)

### Phase 2.1: Created Strongly Typed Event Map

**Files Created:**
- `packages/applications/src/common/typed-event-emitter.ts`

**Files Modified:**
- `packages/applications/src/common/index.ts` (added export)

**Changes:**
- Created `HopeEventMap` interface mapping event names to payload types
- Created `TypedEventEmitter` wrapper class with compile-time validation
- Created `SysEventPayload` and `AuthenticationEventPayload` types
- Exported from `packages/applications/src/common`

### Phase 3.1: Deprecated EventThrottleService

**Files Modified:**
- `packages/applications/src/services/sysEvent/event-throttle.service.ts`

**Changes:**
- Added `@deprecated` JSDoc tag with rationale
- Documented `forceAuditLog` flag as the preferred alternative
- Kept service available for potential single-instance deployments

### Phase 3.2: Added BullMQ Retry/Backoff

**Files Modified:**
- `packages/applications/src/services/sysEvent/sysEvent.service.ts`

**Changes:**
- Added `AUDIT_LOG_JOB_OPTIONS` constant: 3 attempts, exponential backoff (1s → 2s → 4s), keep failed jobs
- Added `SYS_EVENT_JOB_OPTIONS` constant: 2 attempts, exponential backoff (500ms → 1s), keep failed jobs
- Applied options to all `addJob<AuditLogJob>` and `addJob<SysEventJob>` calls (6 handlers)
- `removeOnFail: false` ensures failed jobs remain for DLQ inspection

### Phase 4.1: Propagated correlationId Through Pipeline

**Files Modified:**
- `packages/domains/src/common/events/arcaai.event.ts` (SysEvent, SysEventProps)
- `packages/domains/src/interfaces/jobTypes.ts` (AuditLogJob)
- `packages/applications/src/services/sysEvent/sysEvent.service.ts`

**Changes:**
- Added `correlationId` to `SysEventProps` interface and `SysEvent` class
- Added `correlationId` and `tenantId` to `AuditLogJob` interface
- Forwarded both fields from SysEvent to AuditLogJob data in all 6 handlers

### Phase 4.2: Added Structured Metrics Logging

**Files Modified:**
- `packages/applications/src/services/sysEvent/sysEvent.service.ts`

**Changes:**
- Enhanced `logJobQueueFailures` to track success/failure counts
- Added `metric` field for Prometheus log-based extraction
- Added `successRate` calculation for failure warnings
- Metrics: `audit_event_queued_total`, `audit_event_queue_failed_total`, `audit_event_queue_failure_rate`

---

## Architecture After Changes

```
┌─────────────────────────────────────────────────────┐
│                   Request Flow                       │
└─────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────┐     ┌───────────────────────┐
│   Domain Services    │     │    AuthService         │
│  (User, Tenant, etc) │     │  (Authentication)      │
└──────────┬───────────┘     └──────────┬────────────┘
           │                            │
           │ broadcastSysEvent()        │ emit(EventTypes.
           │ SysEventType.*             │   UserAuthenticated)
           ▼                            ▼
┌──────────────────────┐     ┌───────────────────────┐
│   SysEventService    │     │   AuditLogService      │
│  @OnEvent(SysEvent*) │     │  @OnEvent(EventTypes.  │
│                      │     │   UserAuthenticated)    │
│  ┌────────────────┐  │     └──────────┬────────────┘
│  │ AuditLogJob    │  │                │
│  │ + correlationId│  │                │ Direct DB write
│  │ + tenantId     │  │                │ (AuditAction.LOGIN)
│  │ + retry x3     │  │                ▼
│  └──────┬─────────┘  │     ┌───────────────────────┐
│         │             │     │  AuditLogRepository    │
│  ┌──────┴─────────┐  │     └───────────────────────┘
│  │ SysEventJob    │  │
│  │ + retry x2     │  │
│  └──────┬─────────┘  │
│         │             │
│  ┌──────┴─────────┐  │
│  │UserActivityJob │  │
│  └────────────────┘  │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│   Redis (BullMQ)     │
│  ┌──────────────┐    │
│  │ AuditLog Q   │    │
│  │ (3 retries)  │    │
│  │ (keep failed)│    │
│  └──────────────┘    │
│  ┌──────────────┐    │
│  │ SysEvent Q   │    │
│  │ (2 retries)  │    │
│  └──────────────┘    │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  Background Workers  │
│  (Process audit logs)│
└──────────────────────┘
```

---

## Build Requirements

After these changes, rebuild `packages/domains` before `packages/applications`:

```bash
pnpm --filter @arcaai/domains build
pnpm --filter @arcaai/applications build
```

The TypeScript errors in `sysEvent.service.ts` regarding `correlationId` on `AuditLogJob` and `SysEvent` types will resolve after rebuilding `@arcaai/domains`.

---

## Change History

| # | Date | Description |
|---|------|-------------|
| 1 | 2026-02-06 | Initial implementation of all phases |
| 2 | 2026-02-06 | Critical fix: ensure all audit events capture the responsible user (author) |

---

### Change #2: Responsible User (Author) Propagation Audit

**Problem**: The `responsibleUserId` (the author/user who performed an action) was not reliably captured across all audit event paths.

**Root Cause Analysis**:

1. **Spread operator ordering bug in `broadcastSysEvent()`**: The CLS context values were applied AFTER the caller's data spread (`{...data, responsibleEntityId: this.requestUser?.id}`), meaning explicit overrides from callers were silently discarded.

2. **Background/internal services missing user context**: `SttInternalService`, `SummaryService`, and `ContextService` are called from contexts where CLS might not have a user (e.g., Python STT service callbacks, background jobs). They had local `userId` variables but didn't pass them to `broadcastSysEvent`.

3. **AuthService payload inconsistency**: `getOrCreateOidcUser()` emitted the full user entity, but `handleUserAuthenticatedEvent()` expected `{userId}`, relying on a fragile fallback to `event.id`.

**Fixes Applied**:

| Fix | File | Change |
|-----|------|--------|
| Spread order | `base.service.ts` | Reversed spread: CLS defaults first, then `...data` last so explicit values win |
| STT internal | `sttInternal.service.ts` | All 5 methods now pass `responsibleEntityId: job.createdBy` |
| Summary | `summary.service.ts` | `generatePreSummary/generateSummary` now pass `responsibleEntityId: userId` |
| Context | `context.service.ts` | `addContext`, `updateContext`, `addRawSummary` now pass `responsibleEntityId` |
| Auth | `auth.service.ts` | Now emits `{userId: user.id, method: 'oidc'}` instead of full entity |
| Auth tests | `auth.service.test.ts` | Updated 4 test expectations to match new payload shape |
| Detection | `sysEvent.service.ts` | Added `warnIfMissingResponsibleEntity()` to all 6 handlers — logs warning with metric `audit_event_missing_author` when an auditable event has no author |

**`responsibleUserId` Propagation Flow (After Fix)**:

```
Service Method
    │
    ├─ CLS Context Available? ──Yes──► broadcastSysEvent() picks up this.requestUser?.id
    │                                  as DEFAULT responsibleEntityId
    │
    └─ No CLS? (background job) ──► Caller explicitly passes responsibleEntityId
                                    in data, which overrides the null CLS default
                                    thanks to reversed spread order
    │
    ▼
SysEventService
    │
    ├─ event.responsibleEntityId present? → Maps to AuditLogJob.responsibleUserId ✓
    │
    └─ Missing? → Logs WARN with metric 'audit_event_missing_author'
                  AuditLogJob.responsibleUserId = null (detectable in DB)
```
