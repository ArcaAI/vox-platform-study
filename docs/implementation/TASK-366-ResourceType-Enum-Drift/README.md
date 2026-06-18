# TASK-366 — `ResourceType` Enum Drift Breaks Audit Logging

- **Ticket**: TASK-366
- **Type**: bugfix
- **Created**: 2026-06-18
- **Updated**: 2026-06-18
- **Status**: Completed

> Note: ticket number auto-assigned as the next free `TASK-XXX` (highest in
> `docs/implementation/` was TASK-365). Rename the folder if a tracked ticket
> already exists for this work.

---

## 1. Requirement Analysis

### Description

The `api` service logs were repeatedly emitting:

```
prisma:error
Invalid `delegate.create()` invocation in
packages/domains/src/common/repository.ts:50:34
  resourceType: "UserVoiceProfile",
                ~~~~~~~~~~~~~~~~~~
Invalid value for argument `resourceType`. Expected ResourceType.
```

on every voice-profile create / activate / deactivate / delete.

### Business Context

`AuditLog` is the compliance audit trail. The failing write is the audit
record for a mutation of **biometric PHI** (a user voice profile). The
mutation itself committed, but its audit-trail row silently failed to
persist — a SOC2 / HIPAA audit-completeness gap, not a cosmetic log line.

### Acceptance Criteria

- [x] `AuditLog` rows for `UserVoiceProfile` operations persist without error.
- [x] The same latent failure for every other drifted resource type is fixed.
- [x] The reverse drift is reconciled — every database `ResourceType` value also
      exists in the domain enum.
- [x] A regression test fails if the two enums drift in EITHER direction again.
- [x] No `DROP` / `DELETE` / `TRUNCATE`; change is purely additive.

---

## 2. Current State Evaluation

### Root Cause

Two independently-maintained `ResourceType` enums had drifted:

| Source | Location |
| --- | --- |
| Application enum (authoritative for values the code emits) | `packages/domains/src/enums/generated/ResourceType.ts` |
| Database enum (what Postgres accepts) | `core."ResourceType"` from `packages/database/src/prisma/db_main/audit.prisma` |

`BaseService` subclasses pass a `ResourceType` to `broadcastSysEvent(...)`,
which writes `AuditLog.resourceType`. The value is validated against the
**database** enum. Values present in the domain enum but missing from the DB
enum caused the `AuditLog` INSERT (and therefore the wrapping request handler
path) to throw.

Ground-truth query of both running databases confirmed the DB enum was missing
**5** values that the domain enum declares:

| Missing value | Emitted by | Table-creation migration that forgot the enum value |
| --- | --- | --- |
| `UserVoiceProfile` | `VoiceProfileService` | `20260413000000_add_user_voice_profile` |
| `Highlight` | `HighlightService` | `20260609203500_task_344_add_highlight` |
| `UserDepartment` | `UserService`, `UserDepartmentService` | (no table; emitted only) |
| `TenantFrontendConfig` | `TenantFrontendConfigService` | — |
| `AsrPipelineVersion` | declared resource type (snapshots) | — |

The recurring pattern: a feature added its table + its own enums but never ran
`ALTER TYPE "core"."ResourceType" ADD VALUE ...`. Only `TenantStorageConfig`
(`20260530160000`) had ever done so correctly.

### Impact Areas

- Audit logging for voice profiles, highlights, user-department membership,
  tenant frontend config, and ASR pipeline version snapshots.
- Local dev (`hope`) and test (`hope_test`) DBs are provisioned via
  `prisma db push` (no `_prisma_migrations` table); production uses
  `prisma migrate deploy`. The fix therefore needs **both** the schema change
  (for `db push`) and a migration (for `migrate deploy`).

---

## 3. Implementation Plan

1. Add the 5 values to `audit.prisma` `ResourceType` (appended in declaration
   order to match the append-only `ADD VALUE` migration + Postgres sort order).
2. Create an additive, idempotent migration
   (`ALTER TYPE ... ADD VALUE IF NOT EXISTS`).
3. Apply the additive values to the running dev + test DBs (no destructive
   reset, per the no-`DROP`/`DELETE`/`TRUNCATE` rule).
4. Add a parity regression test: domain `ResourceType` ⊆ database `ResourceType`.
5. Regenerate the Prisma client and rebuild `@arcaai/database`.
6. Verify: reproduce the exact failing INSERT (rolled back), build, lint, tests.

---

## 4. Implementation Summary

### Files Changed

| File | Change |
| --- | --- |
| `packages/database/src/prisma/db_main/audit.prisma` | Appended `Highlight`, `AsrPipelineVersion`, `UserVoiceProfile`, `UserDepartment`, `TenantFrontendConfig` to the `ResourceType` enum. |
| `packages/database/src/prisma/db_main/migrations/20260618000000_task_366_add_missing_resource_types/migration.sql` | New migration — 5 × `ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS '…'`. |
| `packages/domains/src/enums/generated/ResourceType.ts` | Added the 6 database-only values (`Session`, `SessionEvent`, `SessionSyncLog`, `AudioRecording`, `SummaryMeta`, `NamedEntity`) that the domain enum was missing — reconciling the reverse drift. |
| `packages/domains/src/enums/__tests__/resourceType.enum-parity.test.ts` | New regression test asserting BIDIRECTIONAL parity (domain ⇔ database). |

`packages/database/src/generated/core-prisma-client/*` was regenerated
(gitignored artifact).

### Database / Migration

- Migration `20260618000000_task_366_add_missing_resource_types` — additive and
  idempotent; safe to re-run via `migrate deploy`.
- Applied live to `hope` (dev, :5432) and `hope_test` (test, :5433).

### Verification Evidence

- **Reproduction (test DB), rolled back — nothing persisted:**
  ```
  BEGIN
  INSERT 0 5          -- AuditLog rows for all 5 previously-rejected resourceType values
  ROLLBACK
  ```
- **Regression test:** RED before the fix (forward direction listed all 5
  missing values), GREEN after. The bidirectional version then proved the
  reverse direction (6 database-only values) was also reconciled.
- **Full domains suite (after both directions reconciled):**
  ```
  Test Files  93 passed | 2 skipped (95)
        Tests  1198 passed | 2 skipped | 9 todo (1209)
  ```
- **Build:** `@arcaai/database` and `@arcaai/domains` `tsc` builds clean.
- **Lint:** no linter errors on changed files.

### Deviations

- Did not use `pnpm test:db:push` (it runs `db push --force-reset`, which is
  destructive). Applied the additive `ALTER TYPE` statements directly instead,
  consistent with the no-destructive-SQL rule and the `db push` provisioning
  model. A subsequent force-reset reproduces the identical enum from the schema.

### Not Bugs (log triage)

Other lines in the same log window are **not** defects:

- `404 Resource not found` on synthetic ids (`018f0000-…`) and cross-user
  voice-profile probes — these are the **expected** negative-path assertions of
  `task-307-voice-profile-cross-tenant.spec.ts` and sibling specs.
- `Tenant context is required` (400), admin tenants `Validation error` (400) —
  expected negative test cases.
- `HARNESS_SERVICE_TOKEN is not configured — fail-closed` and
  `SMR service call failed (404)` — environmental: those services/tokens were
  not configured/running during this test run, not a code defect.

---

## 5. Change History

| Date | Description | Files |
| --- | --- | --- |
| 2026-06-18 | Initial fix: add the 5 domain-only values to the DB `ResourceType` enum (`audit.prisma` + migration), add forward-direction parity regression test. | `audit.prisma`, migration, parity test |
| 2026-06-18 | Reverse-drift reconciliation: add the 6 database-only values (`Session`, `SessionEvent`, `SessionSyncLog`, `AudioRecording`, `SummaryMeta`, `NamedEntity`) to the domain enum; upgrade the regression test to enforce bidirectional parity. | `ResourceType.ts`, parity test |
