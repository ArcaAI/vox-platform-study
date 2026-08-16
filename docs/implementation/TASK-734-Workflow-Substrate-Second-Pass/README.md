# TASK-734 — Workflow Substrate Second Pass (unblocks Wave 2)

| | |
|---|---|
| **Status** | Pending — awaiting plan approval |
| **Wave** | 1.5 (barrier before Wave 2 re-run) · **Size** | L |
| **Epic slug** | `workflow-substrate-second-pass` |
| **Depends on** | TASK-715 (Phase A, committed), TASK-716 (engine, committed), TASK-718 (interpreter, committed) |
| **Unblocks** | TASK-719, 720, 721, 722 → and therefore 724, 727, 728, 731 |
| **Type** | feature (completion of an under-scoped foundation) |

## 1. Requirement Analysis

Wave 2 stalled. TASK-715 delivered "Phase A only" and TASK-716's validator engine was never wired
into the application layer, so 719/720/721/722 had nothing to build against. 719's agent stopped
rather than invent a gateway API contract — correct, and the reason this ticket exists.

This ticket closes exactly the gap between what Wave 1 shipped and what Wave 2 assumed. Nothing
more: it is a completion ticket, not a redesign.

## 2. Current State Evaluation

Verified against the live tree at commit `24d0b7f71` on 2026-08-16.

### 2.1 What exists

| Layer | Present |
|---|---|
| Prisma | `WorkflowDefinition`, `WorkflowRun`, `WorkflowTestFixture` (`packages/database/src/prisma/db_main/`) |
| Domain | `WorkflowRunEntity` + `WorkflowRunRepository`, `WorkflowTestFixtureEntity` + `WorkflowTestFixtureRepository` |
| Applications | `services/workflow-run/`, `services/workflow-test-fixture/` |
| API | `modules/workflow-run/`, `modules/workflow-test-fixture/` |
| Contract pkg | `packages/workflow-contract/src/` — `compiler.ts`, `validate.ts`, `graph-model.ts`, `graph-algorithms.ts`, `rule-catalogue.ts`, `canonical-json.ts`, `report.ts`, `predicates/` |
| Harness | `apps/harness/src/harness/temporal/interpreter/registry.py` — `NodeSpec` + `NODE_REGISTRY` (Python side, from TASK-718) |

### 2.2 The four concrete gaps

1. **`WorkflowDefinition` has NO domain quartet.** The Prisma model exists, but there is no
   `WorkflowDefinitionEntity`, `WorkflowDefinitionFactory`, `WorkflowDefinitionEntityMapper`, or
   `WorkflowDefinitionRepository` — confirmed by listing
   `packages/domains/src/{entities,repositories}/generated/core/`, which contains only the Run and
   TestFixture artifacts. Nothing above the database can read or write a definition.

2. **No `workflow-definition` application service** and therefore no DTOs, no tenant guards, no
   sys-events for the resource.

3. **No `admin/workflow-definitions` controller and no `admin/workflow-nodes` controller.** These
   are the two endpoints TASK-719's Studio feature module was written against. There is also **no
   node-registry Prisma model** — `grep '^model .*Node.*'` over the schema returns nothing.

4. **`@arcaai/workflow-contract` has zero consumers.** Grepping the whole repo for
   `@arcaai/workflow-contract` outside its own package returns nothing. The compiler and validator
   TASK-716 built are dead code today — they are never invoked on a save, a publish, or anything
   else.

### 2.3 The cross-language constraint that must not be broken

TASK-718 built a **Python** `NODE_REGISTRY` and a Python canonical-JSON checksum
(`interpreter/compiled_config.py`) that mirrors `packages/workflow-contract/src/canonical-json.ts`.
718 explicitly flagged that **byte-for-byte parity between the two was never verified** against a
live Node run. Whatever this ticket does with a TS-side node registry MUST agree with the Python
one, or a definition that validates in the gateway will fail admission in the interpreter.

## 3. Knowledge & Best Practices

- `.claude/rules/03-domain-layer.md` §Generated Code Discipline — `gen:model` is the ONLY
  scaffolder; entity/factory/mapper/repository are **hand-authored**; **never run `gen:mapper`**
  (destructive, strips the `_version` OCC guard); `gen:repository` is broken. Exemplars for
  hand-authoring: `AiTaskDefault*`, `AiProviderConnection*`.
- The mapper MUST carry `FIELDS_NOT_WRITABLE = ['version']` + `stripNonWritableFields` if the model
  is OCC-written — `WorkflowDefinition` will be (see Task 5's PATCH route).
- `.claude/rules/04-application-services.md` — symbol-token DI (`IWorkflowDefinitionService`),
  `BaseService`, `broadcastSysEvent` on every mutation, 404-over-403 on cross-tenant, DTO mapper.
- `.claude/rules/05-nestjs-api.md` — `@CanManage('WorkflowDefinition')` class gate,
  `@RequiresIfMatch()` + `@ExpectedVersion()` on the versioned PATCH, `ETagInterceptor`.
- `.claude/rules/02-database-prisma.md` — if a new model is added it follows the field template
  exactly, and any `ResourceType` addition needs the enum in **both** `audit.prisma` (+ an
  `ALTER TYPE ... ADD VALUE` migration) **and** `packages/domains/src/enums/generated/ResourceType.ts`
  (the TASK-366 failure mode; `resourceType.enum-parity.test.ts` is the guard).
- **Migration proof is the user's to run** (their decision, 2026-08-16): author the SQL, do not run
  `db:migrate*`/`db push`/`migrate diff`.

## 4. Implementation Plan

### Task 1 — RED: contract tests for the missing surface
- **Agent:** T2 · sonnet-5 · medium
- **Files:** new `packages/domains/src/repositories/__tests__/WorkflowDefinitionRepository.test.ts`,
  new `packages/applications/src/services/workflow-definition/__tests__/workflow-definition.service.test.ts`
- **Approach:** Tests that cannot pass until Tasks 2–4 land: repository CRUD + `updateWithVersion`
  drift; service create → `broadcastSysEvent(ResourceCreated)`; cross-tenant read → 404 not 403.
- **Verify:** both suites RED for the right reason (missing module, not a typo). Paste the output.

### Task 2 — `WorkflowDefinition` domain quartet (hand-authored)
- **Agent:** T3 · sonnet-5 · high
- **Files:** `packages/domains/src/{entities,factories,mappers,models,repositories}/generated/core/WorkflowDefinition*.ts`, barrels, `common/databaseServices/core/core.database.module.ts`
- **Approach:** `pnpm gen:model` for the model layer only. Hand-author entity/factory/mapper/
  repository following `AiTaskDefault*`. Mapper carries the `_version` strip. Register the
  repository in `CoreDatabaseModule` (providers AND exports). Add the mapper + repository barrel
  lines by hand. Then `pnpm gen:entity` + `pnpm gen:factory` to reconcile barrels and prove schema
  coverage.
- **Verify:** `pnpm --filter @arcaai/domains build test`; `gen:model/gen:entity/gen:factory` `:check`
  variants report no drift AND schema coverage OK.

### Task 3 — Node registry: one source of truth, two languages
- **Agent:** T4 · opus · high (design call, then build)
- **Files:** `packages/workflow-contract/src/node-registry.ts` (new), a generated/checked mirror for
  `apps/harness/src/harness/temporal/interpreter/registry.py`, plus a parity test
- **Approach:** **Decide first, in writing:** static TS registry vs a Prisma `WorkflowNode` model.
  Recommendation to evaluate, not assume: **static registry in `@arcaai/workflow-contract`**, because
  node specs are code contracts (they gate what the interpreter can execute), a DB row would let a
  tenant introduce a node the interpreter has no handler for, and TASK-718 already made the Python
  side a module constant. If chosen, `admin/workflow-nodes` becomes a read-only projection with no
  new table and no migration.
  Then: a **parity test that fails if the TS and Python registries disagree** on node ids,
  required inputs, or capability flags. This is the guard for §2.3.
- **Verify:** `pnpm --filter @arcaai/workflow-contract test`; the parity test genuinely fails when
  one side is edited alone (prove it, then revert).

### Task 4 — Close the canonical-JSON parity gap TASK-718 flagged
- **Agent:** T2 · sonnet-5 · medium
- **Files:** parity fixture shared by `packages/workflow-contract/src/__tests__/` and
  `apps/harness/src/harness/tests/unit/temporal/interpreter/test_compiled_config.py`
- **Approach:** A committed fixture set of definitions with their expected checksums, asserted from
  BOTH languages. This is the thing 718 could not verify; it is cheap here and prevents a class of
  "validates in the gateway, rejected by the interpreter" bug.
- **Verify:** TS test green; `CI=true python -m pytest …test_compiled_config.py` green on the same
  fixtures. Paste both.

### Task 5 — `workflow-definition` application service + DTOs
- **Agent:** T3 · sonnet-5 · high
- **Files:** `packages/applications/src/services/workflow-definition/**` (full folder pattern:
  `IWorkflowDefinitionService.ts`, service, module, dto mapper, `dto/`, `__tests__/`, `index.ts`)
- **Approach:** Canonical CRUD per rule 04. **This is where the validator gets wired**: `create`
  and `update` call `@arcaai/workflow-contract`'s compile + validate and reject an invalid graph;
  `publish` requires a clean validation report. Surface the report, don't swallow it.
  The rule set stays **DRAFT/non-enforcing per decision #3** — wire the *engine*, and gate the
  clinical rule subset behind the existing draft flag rather than making it blocking.
- **Verify:** `pnpm --filter @arcaai/applications build test`; Task 1's service tests GREEN.

### Task 6 — `admin/workflow-definitions` + `admin/workflow-nodes` controllers
- **Agent:** T3 · sonnet-5 · high
- **Files:** `apps/api/src/modules/workflow-definition/**`, `apps/api/src/modules/workflow-node/**`
- **Approach:** `@Controller('admin/workflow-definitions')`, class-level
  `@CanManage('WorkflowDefinition')`. Routes: list, get, create, PATCH (versioned —
  `@RequiresIfMatch()` + `@ExpectedVersion()`), delete (soft), `POST :id/validate`,
  `POST :id/publish`. `admin/workflow-nodes` is read-only list/get over Task 3's registry.
  Every route carries a permission decorator (the boot audit enforces it).
- **Verify:** `pnpm api:build`, `pnpm test:unit`. Author a cross-tenant e2e spec per rule 05; it
  **cannot be run** (infra down) — say so.

### Task 7 — Prove the unblock is real
- **Agent:** T2 · sonnet-5 · medium
- **Files:** none (verification)
- **Approach:** Re-read TASK-719's and TASK-722's "blocked" notes and confirm each named missing
  endpoint/contract now exists with the shape they expected. This is the ticket's actual acceptance
  criterion — if 719 would still be blocked, this ticket is not done.
- **Verify:** a written mapping "719 needed X → now provided by Y" for every blocker they listed.

## 5. Acceptance Criteria

- [ ] Task 1's tests were RED before Tasks 2–6 (paste the RED output)
- [ ] `WorkflowDefinition` has a full hand-authored domain quartet; repository registered in `CoreDatabaseModule`
- [ ] `@arcaai/workflow-contract` has real consumers — validation runs on create/update/publish
- [ ] TS and Python node registries agree, enforced by a parity test that genuinely fails on drift
- [ ] Canonical-JSON checksum parity proven from both languages on shared fixtures
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm api:build` all green
- [ ] Task 7's mapping shows every 719/720/721/722 blocker resolved
- [ ] Any migration is **authored only**; the shadow-DB proof is the user's to run

## 6. Risks & Open Questions

- **Task 3 is the real design decision.** Static registry vs DB model changes whether this ticket
  needs a migration at all. Recommendation is static; the executing T4 agent should confirm against
  the harness registry before building.
- **Decision #3 still applies** — the clinical rule subset stays DRAFT and non-enforcing. Wiring the
  engine is not the same as enforcing unreviewed clinical rules, and this ticket must not blur that.
- If Task 3 chooses a DB model, `ResourceType` must be added in BOTH places (§3) or every AuditLog
  INSERT throws and rolls the mutation into a 500.
- Scope discipline: this ticket does **not** build the Studio UI, the palette, or exposure. It builds
  the contract those three consume.

## 7. Implementation Summary

(Empty at authoring.)

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored after the Waves 0–3 review; scope derived from the verified 715/716 gap | Claude (Opus 5, orchestrator) |
