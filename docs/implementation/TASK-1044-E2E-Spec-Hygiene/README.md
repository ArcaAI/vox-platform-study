# TASK-1044 — E2E spec hygiene after the TASK-1036 gate (S1–S8)

| Field | Value |
|---|---|
| Status | Review — committed in the worktree, awaiting merge into the active branch |
| Type | bugfix (tests and test config only — no product code changes) |
| Branch | `agent/infallible-hodgkin-426e4d` (worktree) → `dev-2.2` (to be confirmed) |
| Raised by | TASK-1036 §6.15 e2e triage (46 failures, 0 programme regressions) |

> Ticket number: TASK-1041 (tenant-lock fix), TASK-1042 (live audio) and TASK-1043 (internal-lock
> ordering) were all claimed by parallel sessions during this one.

## 1. Requirement Analysis

The TASK-1036 gate ran `RESET_DB=false pnpm test:e2e` on a freshly reset, `RUN_SEED=all` test DB:
**1,323 passed, 46 failed**. The triage proved none were programme regressions. They were specs that
predate owner decisions (S1–S4), shared-state hazards between specs (S5–S8), the TenantLockGuard
defect (fixed separately by TASK-1041), and services that are not running.

Goal: fix the specs, never the product. Rule 05's pinned defects F-01..F-06 stay as they are. Prove the
result with a clean run.

## 2. Current State Evaluation

| Group | Root cause |
|---|---|
| S1 (12 tests, 7 specs) | `POST /admin/users` inside a tenant needs `roleId` + `departmentId` (TASK-983 R6 / OD-4, 400 `USER_ROLE_REQUIRED` / `USER_DEPARTMENT_REQUIRED`). The membership check runs before the password policy. |
| S2 (9) | `UpdateTenantRequest.expectedVersion` is required in the body (`@IsInt() @Min(1)`), and the `If-Match` header alone is a 400. |
| S3 (4) | Model-registry routes refuse a super admin who is acting inside a working tenant (TASK-1019). |
| S4 (13) | Single-spec drifts; see §4. |
| S5 | Since TASK-986 the Global tenant row is write-locked, so the metering spec could not stamp a plan there. |
| S6 | The "foreign" tenant was the first listed tenant that wasn't the caller's. On a shared DB that is a throwaway tenant whose plan caps `maxWorkflowDefinitions` at 1, which gives 409 `QUOTA_EXCEEDED`. |
| S7 | task-658 made a probe schema ARCAAI's default and soft-deleted it afterwards, leaving ARCAAI with **no** default. task-950/951 then failed with `CONTEXT_SCHEMA_VIOLATION … no published context schema`. |
| S8 | task-723 assumed an empty run table, and task-959 assumed the newest run had reached a worker. |

## 3. Implementation Plan

Fix spec by spec, then re-run the failing specs, then do a full run on a reset DB. When an earlier
failure had been hiding another one, fix it the same way: change the spec, not the product.

## 4. Implementation Summary

### Helper

`tests/helpers/e2e.helper.ts` gains `createTenantUser(request, token, data)`. It posts to
`/admin/users` with the seeded Global DOCTOR role and OPD department by default, plus
`SEEDED_GLOBAL_DOCTOR_ROLE_ID` / `SEEDED_GLOBAL_OPD_DEPARTMENT_ID`. Both are exported from
`tests/helpers/index.ts`.

### Per spec

| Spec | Change |
|---|---|
| password-hash-settings, password-security-hardening, users-backend-backlog, users-bulk-role-export, user-impersonation, auth-advanced | User creation goes through `createTenantUser`. The separate role and department POSTs after the create are removed: they now 409 as duplicates. Helpers that became unused are removed. |
| task-986-users-bulk-and-export | R5 probe: an empty `ids` list is now refused by `@ArrayMinSize(1)` (400), so the probe uses an unknown id. That still reaches `bulkDelete` and returns the envelope with `failed: [id]`. |
| task-986-tenant-plan-and-reserved | Every PATCH carries `expectedVersion`. The plan describe is now **serial**, because its cases raced on the same ARCAAI row. |
| ai-model-discovery, task-934-asr-profile | The super admin logs in with no tenant (TASK-1019). |
| api-key-auth | Scope families are read from `body.categories`. |
| consultation-state-machine | Case 1: closing an OPEN consultation now gives 200 with status `CLOSED_INCOMPLETE` (TASK-972 OD-7 edge). |
| task-776-credential-classes | A doctor JWT for `context/shared`. The service account reads `CONSULTATION_ARCAAI`, its own tenant. The scope refusal uses `workflow:run:read`, which SDK_DOCTOR lacks; it now holds `workflow:definition:read` via the `types-codegen` preset. |
| task-776-request-validation | A duplicate GlobalSetting now gets the TASK-932 S2-1 precheck **400**, before any P2002. The P2002→409 mapping stays pinned by the interceptor unit tests. The sanitisation assertion is kept. |
| task-890-agent-draft-test | Uses the declared platform variable `{{context.current_department}}`. The assembled prompt now starts with the platform rules block, so the test asserts the rendered tail. |
| task-890-platform-settings-gate | The DELETE probe targets the surviving SYSTEM row `…0002-000000000005`. `…0002` is no longer seeded. |
| task-890-publish-gate | Drops the `compiledConfig.guardrail` assertion: the opt-out was retired in TASK-1035 (`43302e307`). |
| task-932-consultation-open-language | `en-IN` normalises to `en` (TASK-1004). The revisit is opened for the **same** patient (`PARENT_PATIENT_MISMATCH` otherwise). |
| task-890-metering | The zero-allowance case runs on ARCAAI as `arcaai_doctor`. Setup is inside the `try`. ARCAAI is seeded ENTERPRISE, so no plan is stamped and the spec stays off the field task-986 asserts. |
| task-965-lineage-activate, task-779-workflow-lifecycle | The foreign tenant is pinned to ARCAAI. task-779 had the same latent defect; it surfaced once spec runs had created more throwaway tenants. |
| task-658-context-schema-plane | Remembers ARCAAI's tenant default and re-promotes it in `afterAll` before deleting the probe. |
| task-723-workflow-runs-cross-tenant | Envelope invariants (`hasMore` ⇔ `nextCursor`, page ≤ `limit`) replace "the table is empty". |
| task-959-usage-surface | `cpuSeconds` is read from the newest **COMPLETED** run, and the test skips when there is none. |
| task-951-open-mappings | `externalRef` is the encounter **key** (TASK-1020 D-1): the same id re-opens the visit and a new id opens a new one. Ids are unique per run, because an id belongs to one patient (409 `EXTERNAL_REF_CONFLICT`). |
| `playwright.config.ts` | New project `api-arcaai-schema-tests` (task-658, task-950, task-951) with `workers: 1` and no `dependencies`. All three write ARCAAI's default context schema, and in parallel they raced, e.g. `CLINICIAN_REQUIRED` in task-950 while task-951 had its version pinned. |

Nothing in rule 05's pinned-defect list (F-01..F-06) was touched.

## 5. Verification

Environment: test infrastructure owned by this session. `hope_test` was reset with the owner's consent
in chat (Prisma AI guard) and seeded with `RUN_SEED=all`. The test API ran on 8968 from the primary
checkout.

**The test API must not run in watch mode while other sessions merge into the primary.** In one full
run `pnpm test:up:api` (`nest start --watch`) recompiled 5 times. That made 470 tests fail with
`ECONNREFUSED` and left an export stuck in PENDING. The final run used
`node --import ./dist/instrumentation.js dist/main.js` with `.env.test`, and the API PID was the same
before and after the run.

| Run | Result |
|---|---|
| Baseline (TASK-1036 §6.15) | 1,323 passed · 46 failed · 69 skipped · 70 did not run |
| After S1–S8, on the fresh reset | 1,415 passed · 3 failed · 71 skipped · 19 did not run |
| **Final** (branch merged with dev-2.2 `ee31a7e67`, API not in watch mode) | **1,426 passed · 2 failed · 74 skipped · 10 did not run** (3.8 min) |
| tenant-checkpoints alone, after cancelling the PENDING export orphaned by the watch restart | 36 passed · 2 skipped |
| `api-arcaai-schema-tests` project alone | 36 passed |

Remaining failures. Both are **environmental**: no spec defect and no product regression.

| Spec | Cause |
|---|---|
| `task-933-service-account-consultation.spec.ts:188` | `recording/start must record the governing run`. The harness and Temporal worker do not run on the test stack, so no governing run is started. |
| `tenant-checkpoints.spec.ts:164` (beforeAll timeout) | A Global export stuck in PENDING, orphaned when the watch-mode API restarted in the previous run. After it was cancelled, the spec is green (above). |

Skips that need running services: `task-1038-run-principal-binding` :150 and :184 ("a run start was refused before the 202 (503)", no harness). `streaming-backpressure-recovery` (2) did not run: it belongs to `api-exclusive-tests`, which depends on a green `api-tests`.

Static checks on every changed file:
- `prettier --check`: clean.
- `eslint` (apps/api config): rc 0.
- `tsc` on the changed specs: the only errors are 4 in `password-security-hardening.spec.ts` (the `db` handle typing). They are identical on `HEAD`, so they predate this ticket; e2e specs are not type-gated.

## 6. Change History

| Date | Change |
|---|---|
| 2026-10-05 | Ticket created and work done in one session. The number moved 1041 → 1043 → 1044 because of parallel claims. |
