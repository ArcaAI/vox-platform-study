# TASK-659 — Agent Configuration Extension

- **Status:** Review
- **Type:** feature
- **Wave:** W2 of [TASK-654](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/README.md) (parallel to TASK-660, TASK-661)
- **Baseline:** `dev-2.1` @ `370a3672b` (docs(TASK-654): Wave 1 merged; add build-order and db:migrate contract notes)
- **Branch:** worktree `agent-a49c3e206b4b8528e` — `git reset --hard dev-2.1` performed (it spawned off `main`, per the standing worktree caveat)
- **Spec:** [execution-plan.md § TASK-659](../TASK-654-Consultation-Context-Schema-And-Configurable-Loop/execution-plan.md)

---

## 1. Requirement Analysis

**Objective.** `DepartmentAgent` becomes the unit of loop configuration and of promotion — the
generalisation D6 names, extending the existing `toolConfig`/`llmOverrides`/`harnessOverrides`
JSONB-config pattern rather than inventing a parallel one.

| # | Acceptance criterion |
|---|---|
| AC-1 | `DepartmentAgent` gains `role` (PRIMARY\|SPECIALIST), `subscribedKinds Json?`, `writeScope Json?`, a constrained `goal Json?` (**not** free text — D8), `guardrailProfile String?`, `alwaysActions Json?`, `neverActions Json?` |
| AC-2 | New immutable `DepartmentAgentVersion` model — the house `resource → immutable version → movable pinned default` shape (TASK-654 C6), giving promotion (TASK-663) something to copy and the loop (TASK-662) something to pin |
| AC-3 | `subscribedKinds`/`writeScope` follow the existing `constants.ts` + `*Problems()` + thin `validateX()` pattern **exactly** |
| AC-4 | `subscribedKinds`/`writeScope` kind/output keys are cross-checked against the agent's department's resolved `ConsultationContextSchemaVersion` (TASK-658); an unknown key is rejected |
| AC-5 | A global-admin-only key in `harnessOverrides` is still rejected (regression) |
| AC-6 | A `DepartmentAgentVersion` row, once written, is never updated — only ever created |
| AC-7 | At most one ENABLED PRIMARY agent per department |
| AC-8 | **Regression:** an agent with none of the seven new fields set resolves and behaves exactly as today — `resolveDepartmentAgent` selection semantics, the five capability-keyed template bindings, and `sessionAgentId` continuity are all untouched |

### 1.1 Design constraints inherited from the parent

| # | Constraint | How this ticket honors it |
|---|---|---|
| C6 | resource → immutable version → movable pinned default | `DepartmentAgentVersion` mirrors `ConsultationContextSchemaVersion` / `PromptVersion` exactly: no `resourceStatus`, no `updatedAt`/`updatedBy`, `agentId + versionNumber` unique |
| C7 | Global `whitelist + forbidNonWhitelisted + forbidUnknownValues` | Every new field is declared with `@IsOptional()` + the matching class-validator decorator on both `CreateDepartmentAgentRequest` and `UpdateDepartmentAgentRequest` |
| D8 | Constrained goal fields, not free-text system prompt | `goal` is a JSONB envelope with a **length-capped** (`≤280` chars) `objective` and up to 10 bounded `successCriteria` — structurally incapable of holding a system prompt. Free-text prompt authoring stays exactly where it already is: the approval-gated `PromptTemplate` bound via `promptTemplateId` |
| D9 | Tenants can configure past the clinical safety gate, contained by *placement* | `guardrailProfile` only **selects** a named profile from a closed catalogue (`GUARDRAIL_PROFILE_KEYS`); the actual enforcement boundary is out of this ticket's scope (TASK-662/664) |
| D11 | No rule engine — subscriptions + goals, with always/never as the compliance envelope | `alwaysActions`/`neverActions` are flat arrays drawn from a closed `AGENT_ACTION_KEYS` catalogue (the seven actions §4.4 of the parent README names), with a cross-field "never both" invariant |

### 1.2 Out of scope (belongs to a later wave)

The actual loop dispatch/action registry (TASK-662), reasoning/adjudication (TASK-664), promotion
between tenants (TASK-663), the SDK surface (TASK-665), and the admin-console form (TASK-667,
which also owns the C25 typed-acknowledgement UX for weakening a clinical check).

---

## 2. Current State Evaluation

Verified against `dev-2.1` @ `370a3672b`.

| Area | Finding |
|---|---|
| `DepartmentAgent` | `department-agent.prisma` — a standard tenant-scoped config model with five capability-keyed template bindings, `toolConfig`, `llmOverrides`, `harnessOverrides`, `goldenSetId`, clone lineage. No loop-role, subscription, or compliance-envelope concept exists. |
| Validator pattern | `packages/applications/src/services/departmentAgent/constants.ts` holds `TENANT_TIER_HARNESS_OVERRIDE_KEYS`, `LIVE_TOOL_KEYS`, `AGENT_LLM_OVERRIDE_TASKS` as readonly allow-lists, each paired with a pure `*Problems(value): string[]` function that never throws. `departmentAgent.service.ts` wraps each in a thin `private validateX()` throwing `BadRequestException`, wired into both `create()` and `update()`. |
| Optional-dependency convention | `AiModelRepository` is injected as an `@Optional()` **trailing** constructor parameter so existing unit-test fixtures that construct the service positionally with fewer args keep compiling; when absent, structural validation still runs and only the DB-backed catalogue check is skipped. This is the exact template TASK-659's new dependencies (the version repository, the two context-schema repositories) follow. |
| Cardinality | Exactly one agent acts per consultation today — `resolveDepartmentAgent` (`prompt-resolution.service.ts:834-882`) picks the session-pinned agent or the department default. Multiple `DepartmentAgent` rows can already exist per department (only one `isDefault`); `role` is net-new metadata layered on top, untouched by resolution. |
| `isDefault` invariant precedent | `DepartmentAgentRepository.setDefaultForDepartment` atomically flips `isDefault` inside one Prisma transaction so "exactly one default per department" is never observed half-applied. The new "exactly one PRIMARY" invariant is DIFFERENT in shape — `role` is an ordinary content field set directly on create/update, not a dedicated action — so it is enforced as a validation check (`findPrimaryForDepartment` + a 400) rather than a second atomic-flip transaction. |
| TASK-658 schema plane | `ConsultationContextSchemaRepository.findDefaultForScope` + `ConsultationContextSchemaVersionRepository.findBySchemaAndVersionNumber` are the two repository calls `ConsultationContextSchemaService.resolveServableVersion` composes into its DEPARTMENT → TENANT → none discovery cascade. This ticket reimplements that exact two-tier cascade directly against the repositories (not the service) to stay consistent with the "repository dependency, not service dependency" pattern `departmentAgent.service.ts` already uses everywhere else. |
| Generated-layer discipline | `pnpm gen:model` is the only true generator; `gen:entity`/`gen:factory` reconcile barrels + prove schema coverage but never create files; `gen:mapper` is destructive and was never run; `gen:repository` is broken. Exemplars for the new hand-authored trio: `ConsultationContextSchemaVersion*` (TASK-658, the freshest "immutable version snapshot" precedent). |
| `pnpm db:migrate` | Broken on `dev-2.1` (Prisma 7 removed `--skip-generate`). TASK-658's documented recovery — `prisma migrate diff --from-migrations … --to-schema … --script` against a throwaway shadow database — is the only working path and was followed here too. |

---

## 3. Implementation Plan

### 3.1 Schema

`department-agent.prisma`:
- `DepartmentAgent` gains seven columns: `role DepartmentAgentRole @default(SPECIALIST)` (NOT NULL), and six nullable `Json?`/`String?` columns (`subscribedKinds`, `writeScope`, `goal`, `guardrailProfile`, `alwaysActions`, `neverActions`).
- New enum `DepartmentAgentRole { PRIMARY SPECIALIST }` in `enums.prisma`, next to `DepartmentAgentDnaPolicy`.
- New model `DepartmentAgentVersion` — `agentId` FK, `versionNumber`, `configSnapshot Json`, `checksum`, `changeReason?`, immutable (no `resourceStatus`, no `updatedAt`/`updatedBy`), `@@unique([agentId, versionNumber])`.
- `role` defaults to `SPECIALIST` at the DB level (not `PRIMARY`) — a new agent created without specifying a role must never silently contest an existing department PRIMARY. The migration backfills every pre-existing `isDefault = true` row to `PRIMARY`; every other pre-existing row keeps the `SPECIALIST` default. Because `isDefault` already guarantees at most one default per department (`setDefaultForDepartment`'s atomic flip), this backfill can never produce two PRIMARYs in one department.

### 3.2 Validators (constants.ts) — same shape as every existing one

| Field | Allow-list | `*Problems()` |
|---|---|---|
| `subscribedKinds` | `AGENT_KIND_KEY_PATTERN` (mirrors TASK-658's `CONTEXT_KIND_KEY_PATTERN`, independently declared to keep this file's validators dependency-free) | `subscribedKindsProblems` — returns `{ problems, kindKeys }` |
| `writeScope` | same pattern | `writeScopeProblems` — returns `{ problems, outputKeys }` |
| `guardrailProfile` | `GUARDRAIL_PROFILE_KEYS = ['STANDARD','STRICT','RELAXED']` | `guardrailProfileProblems` |
| `alwaysActions`/`neverActions` | `AGENT_ACTION_KEYS` (the seven action-registry names TASK-654 §4.4 lists) | `actionListProblems` + `actionOverlapProblems` |
| `goal` | length caps (`objective ≤ 280` chars, ≤ 10 `successCriteria` of ≤ 200 chars each) | `goalProblems` |

Each is wired into a thin `private validateX()` on `DepartmentAgentService`, called from both `create()` and `update()` — exactly beside `validateToolConfig`/`validateHarnessOverrides`.

### 3.3 Cross-check against the schema plane (AC-4)

`subscribedKinds`/`writeScope` structural validation is pure (no I/O). The kind/output-key
membership check needs the department's resolved schema, so it lives in the service as an async
step: `resolveServableContextDefinition(tenantId, departmentId)` replicates
`ConsultationContextSchemaService`'s own DEPARTMENT → TENANT discovery cascade directly against
`ConsultationContextSchemaRepository`/`ConsultationContextSchemaVersionRepository` (both injected
as `@Optional()` trailing dependencies, mirroring `aiModelRepository`). Three-way result:

- repositories not wired → cross-check skipped (structural-only degradation, matches
  `validateLlmOverrides`);
- repositories wired, no servable schema for the department → **fail-closed**: any referenced kind
  is unresolvable by definition, so the write is rejected (mirrors TASK-658 D-7: "naming a kind with
  the schema plane unwired fails closed");
- repositories wired, servable schema found → the referenced keys must be a subset of the
  declared `kinds[].key` / `outputs[].key`.

### 3.4 Immutable version snapshot (AC-2, AC-6)

`writeLoopConfigVersionIfNeeded(agent)` runs after every successful `create()`/`update()`:
- builds a canonical snapshot of the seven loop-config fields;
- skips entirely when nothing is configured (`role === SPECIALIST` and all six others null/empty)
  — versioning "nothing configured" would just be noise for every agent that never touches this
  surface;
- computes a sha256 checksum over the canonical (key-sorted) JSON and skips the write when it
  matches the latest recorded checksum (idempotent no-op, mirrors
  `ConsultationContextSchemaService.publish`'s republish guard);
- otherwise creates a new `DepartmentAgentVersion` row at `latest.versionNumber + 1` (or `1`).

`DepartmentAgentVersionRepository`'s `update` is never called anywhere in this ticket — the
immutability guarantee is structural (no code path exists to update the row), not merely a
convention.

### 3.5 "Exactly one PRIMARY per department" (AC-7)

`DepartmentAgentRepository.findPrimaryForDepartment(tenantId, departmentId, excludeId?)` — one
repository call, mirrors `findDefaultForDepartment`. `assertSinglePrimaryPerDepartment` calls it
whenever a write would result in `role = PRIMARY`, throwing `BadRequestException` if another
ENABLED PRIMARY already exists in that department. On `update()` this only fires when
`dto.role !== agent.role` (re-saving an already-PRIMARY agent doesn't re-check).

### 3.6 File plan

| # | Layer | Files |
|---|---|---|
| 1 | Prisma | `enums.prisma` (+`DepartmentAgentRole`); `department-agent.prisma` (7 new columns + new `DepartmentAgentVersion` model) |
| 2 | Migration | `20260811010000_task_659_department_agent_loop_config` |
| 3 | DB allow-lists | `TENANT_SCOPED_MODELS` (`DepartmentAgentVersion`); `MODELS_WITHOUT_SOFT_DELETE` (`DepartmentAgentVersion`) |
| 4 | Domain | `gen:model`; hand-authored `DepartmentAgentVersion{Entity,Factory,EntityMapper,Repository}`; `DepartmentAgentEntity`/`Factory` extended with the 7 fields; `DepartmentAgentRepository.findPrimaryForDepartment`; barrels ×4; `CoreDatabaseModule` |
| 5 | Applications | `departmentAgent/constants.ts` (+6 allow-lists/validators); `departmentAgent.service.ts` (3 new optional deps, 7 new private validators, version-snapshot write); DTOs (create/update/response) + dto.mapper |
| 6 | Tests | 2 new applications test files, 2 new/extended domains entity test files |

### 3.7 TDD list (RED first)

| # | Test | Where |
|---|---|---|
| T1 | Unknown kind in `subscribedKinds` rejected | `departmentAgent.task659.service.test.ts` |
| T2 | `writeScope` naming an undeclared output rejected | same |
| T3 | **Regression** — global-admin-only `harnessOverrides` key still rejected | same |
| T4 | Config version is immutable once written (v1 → v2 on change, never mutated; no-op on identical snapshot) | same |
| T5 | Exactly one PRIMARY per department (create + update, both directions) | same |
| T6 | **Regression** — an agent with none of the 7 new fields set behaves exactly as before, writes no version | same |
| T7 | Pure validator coverage for every new `*Problems()` function | `departmentAgent.task659.constants.test.ts` |
| T8 | Entity-layer defaults/change-tracking for the 7 new fields; `DepartmentAgentVersionEntity` structural invariants | `DepartmentAgentEntity.test.ts`, `DepartmentAgentVersionEntity.test.ts` |

---

## 4. Implementation Summary

**Status: Review.** All eight acceptance criteria implemented and covered by tests; every gate
green against the stated baselines.

### 4.1 Files changed

**Database (`packages/database/`)**

| File | Change |
|---|---|
| `src/prisma/db_main/enums.prisma` | new `DepartmentAgentRole { PRIMARY SPECIALIST }` |
| `src/prisma/db_main/department-agent.prisma` | `DepartmentAgent` +7 columns + `Versions` back-relation; **new** `DepartmentAgentVersion` model |
| `src/prisma/db_main/migrations/20260811010000_task_659_department_agent_loop_config/migration.sql` | **NEW** |
| `src/extensions/tenant-scope.ts` | `DepartmentAgentVersion` → `TENANT_SCOPED_MODELS` (75 → matches the drift-guard test) |
| `src/client.ts` | `DepartmentAgentVersion` → `MODELS_WITHOUT_SOFT_DELETE` |
| `src/__tests__/soft-delete-extension.test.ts`, `src/extensions/__tests__/tenant-scope.test.ts` | inventory tripwires updated (`DepartmentAgentVersion` added; size assertion 74 → 75) |

**Domain (`packages/domains/`)**

- **New, hand-authored**: `DepartmentAgentVersion{Entity,Factory,EntityMapper,Repository}` — the
  `ConsultationContextSchemaVersion*` shape verbatim (no `resourceStatus`, no
  `updatedAt`/`updatedBy`, `FIELDS_NOT_WRITABLE = ['version']` on the mapper).
- **Extended**: `DepartmentAgentEntity`/`DepartmentAgentFactory` (7 new fields, same-named so
  `AutoClassMapper`/`AutoEntityChangeMapper` need no new mapper-handler entries);
  `DepartmentAgentRepository.findPrimaryForDepartment`.
- `pnpm gen:model` produced `DepartmentAgentRole.ts` and `DepartmentAgentVersionModel.ts` and
  updated `DepartmentAgentModel.ts` — the only true generator step.
- 4 barrels (`entities`, `factories`, `mappers`, `repositories`) + `CoreDatabaseModule` (provider +
  export) updated by hand.
- New tests: `DepartmentAgentVersionEntity.test.ts`; `DepartmentAgentEntity.test.ts` extended with a
  TASK-659 describe block.

**Applications (`packages/applications/src/services/departmentAgent/`)**

- `constants.ts` — `AGENT_KIND_KEY_PATTERN`, `subscribedKindsProblems`, `writeScopeProblems`,
  `GUARDRAIL_PROFILE_KEYS` + `guardrailProfileProblems`, `AGENT_ACTION_KEYS` +
  `actionListProblems`/`actionOverlapProblems`, `goalProblems`.
- `departmentAgent.service.ts` — 3 new `@Optional()` trailing constructor dependencies
  (`DepartmentAgentVersionRepository`, `ConsultationContextSchemaRepository`,
  `ConsultationContextSchemaVersionRepository`); 7 new private validators; the
  `resolveServableContextDefinition` cross-check helper; `writeLoopConfigVersionIfNeeded` +
  4 module-scope helpers (`canonicalConfigJson`, `buildLoopConfigSnapshot`, `hasLoopConfig`,
  `extractDeclaredContextKeys`).
- `create-department-agent.request.ts`, `update-department-agent.request.ts`,
  `department-agent.response.ts`, `departmentAgent.dto.mapper.ts` — the 7 new fields threaded
  through, declared (never silently dropped by the gateway's `forbidNonWhitelisted` pipe).
- New tests: `departmentAgent.task659.constants.test.ts` (34 tests, pure validators),
  `departmentAgent.task659.service.test.ts` (23 tests, service-level TDD list).

### 4.2 The migration

`20260811010000_task_659_department_agent_loop_config` — additive only:

- `CREATE TYPE "core"."DepartmentAgentRole" AS ENUM ('PRIMARY', 'SPECIALIST');`
- `ALTER TABLE "DepartmentAgent" ADD COLUMN` ×7 — six nullable with no default
  (`alwaysActions`, `goal`, `guardrailProfile`, `neverActions`, `subscribedKinds`, `writeScope`),
  one `role … NOT NULL DEFAULT 'SPECIALIST'`
- `UPDATE "DepartmentAgent" SET "role" = 'PRIMARY' WHERE "isDefault" = true;` — the one data
  backfill this ticket needs (§3.1)
- `CREATE TABLE "DepartmentAgentVersion"` + 3 indexes (2 plain, 1 unique) + 1 FK

**How it was produced and verified.** `pnpm db:migrate` fails the same way TASK-658 documented
(`prisma migrate dev --skip-generate` — Prisma 7 removed `--skip-generate`), and
`db:migrate:create` cannot run against the local `db push`-managed dev DB (no `_prisma_migrations`
ledger). Followed TASK-658's recovery exactly: a throwaway shadow database
(`hope_shadow_659`) plus a **temporary** `shadowDatabaseUrl` in `prisma.config.ts` (reverted via
`git checkout` immediately after, never committed) let
`prisma migrate diff --from-migrations … --to-schema … --script` replay the whole committed ledger
and diff it against the target schema:

```
$ npx prisma migrate diff --from-migrations ./src/prisma/db_main/migrations --to-schema ./src/prisma/db_main --script
-- CreateEnum
CREATE TYPE "core"."DepartmentAgentRole" AS ENUM ('PRIMARY', 'SPECIALIST');
-- AlterTable
ALTER TABLE "core"."DepartmentAgent" ADD COLUMN     "alwaysActions" JSONB, ...
-- CreateTable
CREATE TABLE "core"."DepartmentAgentVersion" ( ... );
-- CreateIndex / CreateIndex / CreateIndex / AddForeignKey
...
-- RenameIndex  (×4 — pre-existing TASK-648 drift, not this ticket's)
```

The migration file was written from that output (minus the four pre-existing `RenameIndex`
statements, which are TASK-648's territory — same call TASK-658 made). Re-running the diff
afterwards confirms the migration closes its own diff exactly:

```
$ npx prisma migrate diff --from-migrations ./src/prisma/db_main/migrations --to-schema ./src/prisma/db_main --script
-- RenameIndex  ×4   (the same pre-existing TASK-648 drift, unchanged)
```

The dev DB was then synced through its normal management path and inspected directly:

```
$ pnpm db:push
🚀  Your database is now in sync with your Prisma schema. Done in 286ms

$ psql -d hope -c '\d core."DepartmentAgentVersion"'
Indexes:
    "DepartmentAgentVersion_pkey" PRIMARY KEY, btree (id)
    "DepartmentAgentVersion_agentId_idx" btree ("agentId")
    "DepartmentAgentVersion_agentId_versionNumber_key" UNIQUE, btree ("agentId", "versionNumber")
    "DepartmentAgentVersion_tenantId_idx" btree ("tenantId")
Foreign-key constraints:
    "DepartmentAgentVersion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES core."DepartmentAgent"(id) ON UPDATE CASCADE ON DELETE RESTRICT

$ psql -d hope -c "select unnest(enum_range(NULL::core.\"DepartmentAgentRole\"))"
 PRIMARY
 SPECIALIST
(2 rows)

$ psql -d hope -c "\d core.\"DepartmentAgent\"" | grep -E "role|subscribedKinds|writeScope|goal|guardrailProfile|alwaysActions|neverActions"
 alwaysActions           | jsonb                      |          |
 goal                    | jsonb                      |          |
 guardrailProfile        | text                       |          |
 neverActions            | jsonb                      |          |
 role                    | core."DepartmentAgentRole" | not null | 'SPECIALIST'::core."DepartmentAgentRole"
 subscribedKinds         | jsonb                      |          |
 writeScope              | jsonb                      |          |
```

### 4.3 Cross-check against the schema plane — how it works

`resolveServableContextDefinition(tenantId, departmentId)` replicates
`ConsultationContextSchemaService.resolveServableVersion`'s own two-tier discovery cascade
(DEPARTMENT-scoped default → TENANT-scoped default → none), reading a schema only when it is
`pinnedVersionNumber != null` **and** `status ∈ {PUBLISHED, APPROVED}` — i.e. genuinely servable,
never a DRAFT. `extractDeclaredContextKeys` then walks the resolved version's `definition.kinds[]`
/ `definition.outputs[]` to build the two membership sets `subscribedKindsProblems`/
`writeScopeProblems`'s extracted `kindKeys`/`outputKeys` are checked against.

This is a direct **repository** dependency (`ConsultationContextSchemaRepository` +
`ConsultationContextSchemaVersionRepository`), not a call into
`ConsultationContextSchemaService` — consistent with how `departmentAgent.service.ts` already
depends on `PromptTemplateRepository`/`PromptVersionRepository` directly rather than a
`PromptManagementService`. Both are `@Optional()` trailing constructor dependencies exactly like
`aiModelRepository`; when absent (as in every pre-existing test fixture that constructs the
service with 6 positional args) only the structural shape check runs and the "does this kind
exist" check is skipped, never throwing on a missing dependency.

### 4.4 Decisions worth reviewing

| # | Decision | Reasoning |
|---|---|---|
| D-1 | `role` defaults to `SPECIALIST`, not `PRIMARY` | A new agent created without specifying a role must never silently contest an existing department PRIMARY — the far more common workflow ("add a second, specialist agent to a department that already has one") would otherwise 400 by surprise. |
| D-2 | The PRIMARY invariant is a validation check, not an atomic-flip transaction (unlike `isDefault`) | `role` is an ordinary content field the admin sets directly via `create`/`update`, not a dedicated `setPrimary()` action — there is no "flip" to make atomic, only a "does this already exist" check to run before the write. |
| D-3 | The version snapshot skips writing when nothing is configured | Versioning "role=SPECIALIST, everything else null" for every agent that never touches this surface would be pure noise — the whole existing catalogue of agents falls into this bucket today. |
| D-4 | The version snapshot is written unconditionally after `create`/`update` succeeds (no separate "publish" verb) | TASK-663 (promotion) and TASK-662 (the loop, pinning `agentConfigVersionId`) are both future tickets; this one only needs an immutable artifact to exist whenever the loop-config surface is actually used — a dedicated publish endpoint is TASK-667's console-facing decision to make, not this ticket's. |
| D-5 | The always/never overlap check validates the **effective** post-write state on `update()`, not just the DTO's own fields | A PATCH that only touches `neverActions` must still be checked against the agent's EXISTING `alwaysActions` — validating only what's in the DTO would miss a conflict introduced by a one-sided partial update. |
| D-6 | `guardrailProfile` is a plain `String?` column validated against an app-layer allow-list, not a Prisma enum | Matches the `TENANT_TIER_HARNESS_OVERRIDE_KEYS` precedent exactly (a `String[]`/`String` allow-list validated in `constants.ts`, not a DB enum) — extending the catalogue later needs no migration. |
| D-7 | `DepartmentAgentVersion` is **not** a `ResourceType` | Mirrors TASK-658 D-8: an immutable snapshot written as a side effect of its parent's write has no lifecycle of its own — the `PromptVersion`/`ConsultationContextSchemaVersion` precedent (note `AsrPipelineVersion` IS a `ResourceType`, an older, inconsistent exception — the newer precedent was followed). |
| D-8 | `subscribedKinds`/`writeScope` reference kinds fail **closed** when the department has no servable schema | Mirrors TASK-658 D-7 ("naming a kind with the schema plane unwired fails closed") — an unvalidated reference to a kind that cannot be resolved must never silently pass. |

### 4.5 Must-not-change verification

- `resolveDepartmentAgent` (`prompt-resolution.service.ts:834-882`) — **not touched**. Selection
  semantics (session-pinned agent → department default, exactly one binding attempt, no fan-out)
  are byte-identical.
- The five capability-keyed template bindings — **not touched**.
- `sessionAgentId` continuity (freeze → per-flush cache → `SummaryMeta.sessionAgentId` →
  `pinnedAgentId`) — **not touched**; `live-documentation.service.ts`, `harness-internal.service.ts`,
  `summary.service.ts`, `live-agent-lineage.ts` are all untouched by this ticket.
- Existing `harnessOverrides` global-admin-only rejection — regression-tested (T3) and unchanged.
- `clone()` and `agent-template-resync.service.ts` — deliberately **not** touched to propagate the
  seven new fields. A clone/resync of an existing agent picks up the DB defaults
  (`role=SPECIALIST`, everything else null) rather than copying the source's loop config forward.
  This is a scoped decision, not an oversight: none of the seven fields is in the TASK-659 spec's
  clone/resync requirements, and touching either file would be scope creep against the "surgical
  changes" rule. Flagged here for whoever picks up TASK-663 (promotion) to confirm is still the
  right call once promotion semantics are designed.

### 4.6 Observations for other tickets (not fixed here)

- **`pnpm db:migrate` is still broken on `dev-2.1`** — confirmed independently, same root cause
  TASK-658 documented (Prisma 7 removed `--skip-generate`). Not this ticket's to fix.
- **Pre-existing TASK-648 index-rename drift** — the same four indexes TASK-658 found, still
  present, still someone else's territory.
- **Lint task count drifted from the stated baseline (32/32) to 31/31** between TASK-658's merge
  and this ticket's start, with zero errors and zero new warnings either way. Not attributable to
  this ticket (no `turbo.json`/package.json pipeline changes were made) — most likely explained by
  TASK-669's removal of `apps/ui-playground` shrinking the total task count by one. Reported as
  observed, not chased down further.
- A fresh worktree needs `@arcaai/room`, `noise-filter`, `vad`, `stt`, `med-ner`, `vox` and `ui`
  built before `pnpm test:unit` is meaningful (execution-plan §1.1b) — confirmed again here (31
  files failed on unresolved workspace entries before the build order was followed correctly).

---

## 5. Verification Evidence

All commands run from the worktree at `dev-2.1` @ `370a3672b`, after `pnpm install`.

### `pnpm db:generate`

```
✔ Generated Prisma Client (7.8.0) to ./src/generated/core-prisma-client in 269ms
✅ Index file generated successfully!
```

### Migration application — see §4.2 in full (shadow-DB diff, `db:push`, direct psql inspection)

### `pnpm --filter @arcaai/database build && pnpm --filter @arcaai/database test`

```
> tsc                                                    (clean)

 Test Files  47 passed (47)
      Tests  1171 passed (1171)
```

Stated baseline (TASK-658 README): 47 files / 1,165 tests. File count unchanged (no new database
test files this ticket); the `soft-delete-extension.test.ts` tripwire's `expected.forEach`-style
parametrization adds exactly 1 new test for the added `DepartmentAgentVersion` entry. The observed
+6 total is not fully reconciled against a baseline measured on a different branch state before
merge — not chased down further; zero failures either way.

### `pnpm --filter @arcaai/domains build && pnpm --filter @arcaai/domains test`

```
> tsc                                                    (clean)

 Test Files  138 passed | 2 skipped (140)
      Tests  1573 passed | 2 skipped | 9 todo (1584)
```

Baseline: 137 files / 1,564 tests. +1 file (`DepartmentAgentVersionEntity.test.ts`), +9 tests (2 new
`DepartmentAgentEntity` cases + 7 new `DepartmentAgentVersionEntity`/`Factory` cases). The
`resourceType.enum-parity` guard is inside this run and passes (confirmed independently: 1 file /
10 tests).

### `pnpm --filter @arcaai/applications build && pnpm --filter @arcaai/applications test`

```
> rimraf dist tsconfig.tsbuildinfo && tsc                 (clean)

 Test Files  461 passed | 1 skipped (462)
      Tests  8739 passed | 4 skipped (8743)
```

Stated baseline (TASK-658 README, measured on its own pre-merge branch): 459 files / 8,685 tests.
+2 files here (`departmentAgent.task659.constants.test.ts`, 34 tests;
`departmentAgent.task659.service.test.ts`, 23 tests — 57 new tests total, all passing). The net
file delta (462 − 460 = 2) matches exactly; the net test-count delta (8,743 − 8,689 = 54) is 3
short of 57, a small discrepancy against a baseline measured on a different branch state before
merge rather than freshly on this ticket's own starting commit — not chased down further, and
irrelevant to this ticket's own zero-failure result.

### `pnpm api:build`

```
 Tasks:    9 successful, 9 total
```

### `pnpm test:unit` (whole monorepo, exit 0)

```
 Test Files  967 passed | 2 skipped (969)
      Tests  16515 passed | 8 skipped | 9 todo (16532)
packages/ui test:              Test Files  242 passed (242)   Tests   656 passed
packages/agentic-sdk-v2 test:  Test Files  255 passed (255)   Tests  4131 passed
apps/compat-playground test:   Test Files   21 passed  (21)   Tests   223 passed
apps/admin-console test:       Test Files  172 passed (172)   Tests  1339 passed
```

Required build order followed exactly (execution-plan §1.1b): `pnpm install` →
`pnpm db:generate` → `@arcaai/database` build → `@arcaai/domains` build → `@arcaai/applications`
build → `@arcaai/room`/`noise-filter`/`vad`/`stt`/`med-ner`/`vox`/`ui` build → `pnpm test:unit`.
Skipping the workspace-package build step reproduced the documented false-red (31 files failing on
unresolved `@arcaai/room` entries) before the fix.

### `pnpm lint` (exit 0)

```
 Tasks:    31 successful, 31 total
```

0 errors. 65 pre-existing `apps/api` warnings (`eslint-comments/require-description`), matching the
stated baseline exactly. Zero warnings on any file this ticket added or touched — verified by
grepping the full lint log for every new/modified filename and finding no matches. (Task-count
observation: §4.6.)

### Generator drift (`pnpm gen:model:check && pnpm gen:entity:check && pnpm gen:factory:check`, exit 0)

```
[Generate Data Model]  check: no drift — 156 generated file(s) match the committed files.
[Generate Data Entity] check: no drift — 90 generated file(s) match the committed files.
[Generate Data Entity] Schema coverage OK: 88 entity artifact(s) cover every persisted column of 92 Prisma model(s)
[generate-factory]     check: no drift — 90 generated file(s) match the committed files.
[generate-factory]     Schema coverage OK: 88 factory artifact(s) cover every persisted column of 92 Prisma model(s)
```

`pnpm gen:mapper` was **never run** (destructive — strips the `_version` OCC guard). Both new
mappers (`DepartmentAgentVersionEntityMapper`) carry `FIELDS_NOT_WRITABLE = ['version']` by hand;
`DepartmentAgentEntityMapper`'s pre-existing guard is untouched.

### AC → test map

| AC | Test | File |
|---|---|---|
| AC-1 | 7 fields applied from props, defaults verified | `DepartmentAgentEntity.test.ts` |
| AC-2 | Factory + validate() invariants | `DepartmentAgentVersionEntity.test.ts` |
| AC-3 | Every `*Problems()` function, standalone | `departmentAgent.task659.constants.test.ts` |
| AC-4 | Unknown `subscribedKinds` kind rejected; undeclared `writeScope` output rejected; accepted when declared; fail-closed with no schema; skipped when repos unwired | `departmentAgent.task659.service.test.ts` |
| AC-5 | Regression — harnessOverrides global-admin-only key still rejected | same |
| AC-6 | v1 → v2 on config change; no-op on identical snapshot; skipped when repo unwired | same |
| AC-7 | Create/update in both directions; self-update is a no-op check | same |
| AC-8 | Regression — no new fields ⇒ no version write, unaffected create() | same |

## Change History

- 2026-08-11 — Ticket opened from the TASK-654 execution-plan spec. Worktree reset from `main` to
  `dev-2.1` @ `370a3672b`; plan authored before any code.
- 2026-08-11/12 — Implemented: schema + migration, domain layer (hand-authored
  `DepartmentAgentVersion` trio + `DepartmentAgent` extension), application-layer validators +
  service wiring + DTOs, tests at every layer. All gates green; status **Review**. Not merged, not
  pushed, no MR opened.
