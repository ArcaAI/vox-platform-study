# TASK-349: `Highlight` Model Missing from Tenant-Scope Allow-List

| Field | Value |
|---|---|
| **Ticket** | TASK-349 |
| **Title** | `Highlight` model missing from `TENANT_SCOPED_MODELS` (drift-guard failure) |
| **Created** | 2026-06-10 |
| **Updated** | 2026-06-10 |
| **Status** | Pending |
| **Type** | bugfix (multi-tenancy hardening) |
| **Origin** | Discovered during TASK-348 Phase 5 verification (pre-existing at HEAD; §5.2 of TASK-348 README) |
| **Related tickets** | TASK-344 (introduced the `Highlight` model), TASK-305 (tenant-scope extension + drift guard) |

---

## 1. Requirement Analysis

### 1.1 Description

The `Highlight` model (added by TASK-344, Manual Doctor Highlighting; schema applied via `db push` 2026-06-09) declares a `tenantId String` scalar in `packages/database/src/prisma/db_main/consultation.prisma:413` but was never added to the `TENANT_SCOPED_MODELS` allow-list in `packages/database/src/extensions/tenant-scope.ts`. The TASK-305 drift-guard test fails exactly as designed:

```
FAIL packages/database/src/extensions/__tests__/tenant-scope.test.ts
  > lists every schema tenantId model in TENANT_SCOPED_MODELS (drift = [])
AssertionError: expected [ 'Highlight' ] to deeply equal []
```

### 1.2 Business Context

The tenant-scope Prisma extension is the second line of the defence-in-depth multi-tenancy posture (behind RLS). While `Highlight` is excluded, its reads/writes do **not** get automatic `tenantId` injection — any repository/service query that forgets a manual tenant filter becomes a cross-tenant exposure on clinician-authored highlight data. This is a security-relevant gap, not a test nuisance.

### 1.3 Acceptance Criteria

1. `Highlight` queries receive automatic tenant injection (or are consciously registered in `INTENTIONALLY_UNSCOPED` with a reviewed justification — not expected).
2. The drift-guard test passes: `missing` diff is `[]`.
3. Existing Highlight repository/service tests still pass (injection must not break current call sites that already pass `tenantId` explicitly).
4. RLS coverage for the `Highlight` table confirmed or tracked (TASK-305 Phase C pattern).

## 2. Current State Evaluation

- `consultation.prisma:413` — `model Highlight` with `tenantId String` (standard field template).
- `tenant-scope.ts:53` — `TENANT_SCOPED_MODELS` lists 6 consultation.prisma models; `Highlight` absent.
- `tenant-scope.test.ts:165` — `INTENTIONALLY_UNSCOPED` is empty ("Add a name here ONLY for a conscious, reviewed exception").
- The drift guard fails at HEAD (verified during TASK-348 Phase 5 with zero local changes under `packages/database`), i.e. this predates the TASK-345/346/347/348 work.

## 3. Implementation Plan

> Gate: requires user approval before code is written.

| Step | Action | Verification |
|---|---|---|
| 1 | RED is already on disk: the drift-guard test fails at HEAD | Captured in TASK-348 §5.2 |
| 2 | Add `'Highlight'` to `TENANT_SCOPED_MODELS` under the consultation.prisma section (update the section count comment) | Drift test green |
| 3 | Audit Highlight repository/service call sites for assumptions broken by injection (e.g. queries that intentionally omit `tenantId`) | `pnpm test:unit --filter @arcaai/database --filter @arcaai/domains --filter @arcaai/applications` green |
| 4 | Confirm RLS policy exists for the `highlight` table per TASK-305 Phase C; if absent, record follow-up | Migration/policy SQL reviewed |

Estimated scope: ~1-line product change + verification; the value is in step 3/4 review.

## 4. Implementation Summary

_Not started._

## 5. Change History

| Date | Description | Files |
|---|---|---|
| 2026-06-10 | Ticket opened from TASK-348 Phase 5 findings (pre-existing root-suite failure characterized; security-relevant). | This README |
