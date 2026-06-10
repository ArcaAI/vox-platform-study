# TASK-350: EU-07 `pipelineId` Validation Test Drift (TASK-298 D-19)

| Field | Value |
|---|---|
| **Ticket** | TASK-350 |
| **Title** | EU-07 DTO test not updated when TASK-298 D-19 widened `pipelineId` to slug-or-UUID |
| **Created** | 2026-06-10 |
| **Updated** | 2026-06-10 |
| **Status** | Completed |
| **Type** | bugfix (test-only) |
| **Origin** | Discovered during TASK-348 Phase 5 verification (pre-existing at HEAD; §5.2 of TASK-348 README) |
| **Related tickets** | TASK-298 (D-19 widened `PIPELINE_ID_PATTERN`), EU-07 (typed create DTOs) |

---

## 1. Requirement Analysis

### 1.1 Description

`apps/api/src/modules/streaming/__tests__/transcription-job.controller.test.ts:626-632` asserts that `pipelineId: 'not-a-uuid'` fails `CreateJobRequest` validation. TASK-298 D-19 deliberately widened the DTO pattern (`apps/api/src/modules/streaming/dto/transcription-job.dto.ts:8-41`) to accept **slug-or-UUID** (`PIPELINE_ID_PATTERN`, message: "pipelineId must be a slug ([A-Za-z0-9-]) or UUID"). The probe value `'not-a-uuid'` is a valid slug under the widened pattern, so the assertion fails:

```
FAIL ... EU-07 — create endpoints use typed, validated request DTOs
  > CreateJobRequest rejects an invalid jobType and a non-UUID pipelineId
AssertionError: expected [ 'jobType' ] to include 'pipelineId'
```

The product behavior is correct (D-19 was intentional); the test was not updated when D-19 landed.

### 1.2 Acceptance Criteria

1. The EU-07 rejection test uses a probe value invalid under the slug-or-UUID pattern (e.g. contains spaces/punctuation: `'not a uuid!'`), restoring its ability to catch validation removal.
2. Test name/comment updated to reflect the D-19 contract ("rejects a non-slug, non-UUID pipelineId").
3. A companion acceptance assertion covers the slug case (valid slug passes) so the widened contract is itself pinned.
4. Suite green: `pnpm test:unit` no longer fails in this file.

## 2. Current State Evaluation

- Failing at HEAD with zero local changes under `apps/api/src/modules/streaming` (verified during TASK-348 Phase 5).
- The sibling EU-07 tests (valid-UUID accept, missing-field reject) pass — only the rejection probe drifted.

## 3. Implementation Plan

> Gate: requires user approval before code is written. Test-only change; no product code touched.

| Step | Action | Verification |
|---|---|---|
| 1 | Change the rejection probe to a value invalid under `PIPELINE_ID_PATTERN`; rename the test to match D-19 semantics | Test fails before the change (current state), passes after |
| 2 | Add a "valid slug accepted" assertion pinning the widened contract | Test green |
| 3 | Run the file's full suite | `pnpm test:unit -- transcription-job.controller` green |

## 4. Implementation Summary

Test-only change in `apps/api/src/modules/streaming/__tests__/transcription-job.controller.test.ts` (EU-07 suite). No product code touched. The governing pattern is `PIPELINE_ID_PATTERN` in `packages/applications/src/services/stt/job/dto/create-job.request.ts:12` (where `CreateJobRequest` lives — same slug-or-UUID regex as the apps/api DTO file):

```
/^[A-Za-z0-9][A-Za-z0-9-]*$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
```

### Changes

1. **Rejection probe fixed**: `pipelineId: 'not-a-uuid'` → `'not a uuid!'`. The old probe matches the slug branch (`[A-Za-z0-9][A-Za-z0-9-]*`); the new probe fails both branches (space and `!` are outside `[A-Za-z0-9-]`, and it is not UUID-shaped), restoring the test's ability to catch validation removal.
2. **Test renamed** to `CreateJobRequest rejects an invalid jobType and a non-slug, non-UUID pipelineId`; explanatory comment cites D-19.
3. **Widened contract pinned**: new test `CreateJobRequest accepts a valid slug pipelineId (TASK-298 D-19)` asserts `pipelineId: 'general-consult'` (the canonical slug example from the DTO doc comments) passes validation.
4. **Stale suite comment updated**: "non-UUID ids" → "malformed ids", with a D-19/TASK-350 note that `CreateJobRequest.pipelineId` is slug-or-UUID.

### Evidence

**RED** (before change, root `pnpm test:unit -- transcription-job.controller`):

```
FAIL  apps/api/src/modules/streaming/__tests__/transcription-job.controller.test.ts
  > EU-07 — create endpoints use typed, validated request DTOs
  > CreateJobRequest rejects an invalid jobType and a non-UUID pipelineId
AssertionError: expected [ 'jobType' ] to include 'pipelineId'
Test Files  1 failed | 685 passed | 2 skipped (688)
     Tests  1 failed | 13742 passed | 4 skipped | 9 todo (13756)
```

**GREEN** (after change, `pnpm vitest run src/modules/streaming/__tests__/transcription-job.controller.test.ts` from `apps/api`):

```
Test Files  1 passed (1)
     Tests  50 passed (50)
```

ReadLints on the modified test file: zero errors.

### Files Changed

| File | Change |
|---|---|
| `apps/api/src/modules/streaming/__tests__/transcription-job.controller.test.ts` | EU-07 suite: rejection probe + rename, new slug-accept test, suite comment |
| `docs/implementation/TASK-350-EU07-PipelineId-Test-Drift/README.md` | Status, Implementation Summary, Change History |

## 5. Change History

| Date | Description | Files |
|---|---|---|
| 2026-06-10 | Ticket opened from TASK-348 Phase 5 findings (pre-existing root-suite failure characterized; test/DTO drift). | This README |
| 2026-06-10 | Fixed EU-07 rejection probe to `'not a uuid!'` (invalid under slug-or-UUID), renamed test to D-19 semantics, added slug-accept test pinning the widened contract, refreshed stale suite comment. File green (50/50), no lint errors. | `transcription-job.controller.test.ts`, this README |
