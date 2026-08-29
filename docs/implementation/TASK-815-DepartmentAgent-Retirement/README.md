# TASK-815 — `DepartmentAgent` Retirement

| Field | Value |
|---|---|
| **Status** | **`Completed`** 2026-08-29 — merged to `dev-2.2`. 205 files, 21,092 deletions. Migration applied by the owner and verified against both DBs (§10a). |
| **Type** | `refactor` (deletion) |
| **Branch** | `dev-2.2` |
| **Architecture** | <https://claude.ai/code/artifact/b6b68b73-3cb9-4cec-89f3-8afd1553c13b> |
| **Master** | [TASK-806](../TASK-806-Consultation-Workflow-Substrate-Unification/README.md) |
| **Depends on** | **TASK-809 + TASK-811 (hard)** |
| **Agent** | `general-purpose` · `opus` · effort **`max`** · **worktree** |
| **Review lens** | + `security-auditor` (CASL subject removal, scope registry) + `database-admin` (migration) |

> **Deletions are unrecoverable.** Nothing here is mechanical. Two *surviving* features depend on
> the thing being deleted, and one frozen compat route reaches it transitively.

## 1. Hard preconditions

**Do not start until 809 and 811 have landed.** Everything `DepartmentAgent` carries must be
absorbed by node config **first**: `FrozenLiveAgentSnapshot`, `llmOverrides`/`liveLlm`,
`neverActions`/`alwaysActions`, `LIVE_TOOL_KEYS`. Deleting earlier removes live capability with no
successor.

**`DepartmentAgent` cannot be deleted while Substrate A still runs for any tenant** — the hardcoded
loop is gated only after TASK-811 lands its substrate gate.

## 2. The compat contract that must not move

`TextCompatController` → `TextCompatTemplateService.resolveGovernedInstruction()`
(`text-compat-template.service.ts:86-130,97,173,200`) → `PromptResolutionService.resolve()` →
**`DepartmentAgentRepository`** (`prompt-resolution.service.ts:67,327,455,551,834`).

> **ACCEPTANCE CRITERION.** `PromptResolutionService.resolve()` MUST keep its public signature and
> the `ResolvedPromptConfig` field set (`resolvedFrom`, `resolvedAgentId`, `content`,
> `resolvedVersionNumber`) while its internal Tier-1a source moves onto node config. Hold that and
> the compat file needs **zero** edits. Break it and a frozen wire route breaks.

## 2c. The enum value SURVIVES the model (orchestrator finding, 2026-08-29 — verified, not inferred)

**`ResourceType.DepartmentAgent` must NOT be deleted.** It is declared in two places —
`packages/database/src/prisma/db_main/audit.prisma:201` and
`packages/domains/src/enums/generated/ResourceType.ts:58` — and both must keep it.

Three independent reasons, each sufficient on its own:

1. **PostgreSQL cannot drop an enum value.** There is no `ALTER TYPE … DROP VALUE`. Removing one
   means creating a replacement type, rewriting every column that uses it, and dropping the old
   type — a rewrite of `AuditLog` for zero benefit. Verified: **no migration in this repo has ever
   dropped an enum value** (`grep -rl "DROP VALUE" packages/database/src/prisma/migrations` → 0).
2. **Audit history is immutable, and this is a PHI platform.** Historical `AuditLog` rows record
   `resourceType = 'DepartmentAgent'` for every mutation the service ever broadcast. Those rows
   describe events that really happened. Deleting the type value destroys the readability of the
   compliance record. (Local dev currently shows 0 such rows only because the DB was reset on
   2026-08-28 — do not mistake an empty dev table for "unused".)
3. **The parity guard is bidirectional.** `resourceType.enum-parity.test.ts` asserts *both*
   "every domain value exists in the database enum" *and* "every database value exists in the
   domain enum". Keeping the value in both files keeps it green; removing it from one turns the
   guard red immediately.

**What to do instead:** leave both declarations in place and replace the comment above the Prisma
member (`audit.prisma:200`, which today reads that it is written by
`DepartmentAgentService.broadcastSysEvent`) with one stating the service is retired and the value
is retained solely so historical audit rows remain interpretable. That comment is the deliverable —
a future reader must not "clean up" what looks like a dangling enum member.

This is the one place in this ticket where the correct action is **to not delete something**.
Everything else in the DELETE inventory goes.

## 2a. Requirement Analysis & Scope

### In scope
Everything in the master's `DepartmentAgent` DELETE/EDIT inventory (TASK-806 §2.8) — Prisma model
pair + enums, the domain trio, the `services/departmentAgent/**` folder, the API module, the
console `/agents` screen, seeds, and the generated vox-node resource (which deletes itself on
regeneration). Plus the four absorptions: `PromptResolutionService` Tier-1a repoint, `AgentPromotion`
rewrite (OD-10), eval-gate retirement (OD-11), per-agent harness overrides (OD-12).

### Out of scope — the compat fence (owner: "Do NOT touch the compat things")

Reproduced in full so this ticket is self-contained. **Do not read, edit, refactor, rename, or
"tidy" anything below.** This ticket has a *transitive* reach into the first entry (see §2) — that
reach is resolved by preserving a contract, never by editing a compat file.

```
apps/compat-playground/**                        apps/quick-compat-app/**
apps/api/src/modules/text-compat/**              apps/api/src/modules/stt-compat/**          (OD-8)
apps/api/src/global-prefix.config.ts             apps/api/src/main.ts:109-111
packages/vox-node/src/resources/summarization.ts packages/vox-node/src/types/summarization.ts
packages/vox-node/src/core/url.ts                (PREFIX_EXEMPT_PATHS)
packages/agentic-sdk-v2/src/compat.ts            packages/agentic-sdk-v2/src/compat/**
packages/agentic-sdk-v2/src/types/consultation.ts:117-122   (the @deprecated `department` field ONLY)
packages/agentic-sdk-v2/src/types/context.ts:172-179        (AddContextInput.structuredData ONLY)
```

Also out of scope: everything in §5 (Must NOT be deleted), and the realtime executor (TASK-811).

## 3. OD-11 — RESOLVED: the eval gate survives, its binding moves

**Owner, 2026-08-25 (second answer supersedes the first):** *"Bind `goldenSetId` directly to the node
that references it before deletion. Tenant admin will enable or disable if needed."*

The earlier reading — "remove the gate along with goldenSet" — is **withdrawn**. It was flagged
because `GoldenSet` owns `GoldenCase[]` and `EvalRun[]` (`harness.prisma:54,93`) and has consumers
far outside the gate: `eval.service.ts` (32 refs), `eval-run.service.ts` (17),
`golden-case-promotion.service.ts` (7), `harness-gateway.service.ts`,
`harness-observability.service.ts`.

**What this ticket must do instead:**

| Element | Action |
|---|---|
| `GoldenSet` / `GoldenCase` / `EvalRun` | **Untouched.** Whole subsystem survives. |
| `EvalPromotionGateService` | **Kept.** Only its *discovery* changes. |
| `EvalPromotionGateService.evaluatePromotion` discovery | Repoint from `DepartmentAgentRepository.findByBoundTemplate` (`eval-promotion-gate.service.ts:2,55,93-94`) onto the **workflow node** carrying `evalGate: { goldenSetId, enabled }` (field defined by TASK-809 §2b) |
| `PromptManagementService.approveTemplate()` | **Unchanged behaviour** — keeps calling the gate (`prompt-management.service.ts:506-519`). Its 409 `EVAL_GATE_FAILED` contract stands. |
| `DepartmentAgent.goldenSetId` | Migrated onto node config, **then** dropped with the model. Migration before deletion — not after. |
| Tenant-admin control | New **enable/disable** toggle on the node's eval gate. Disabled ⇒ approve proceeds with a recorded warning, matching today's "no golden set" path. |

> **D-27 is therefore closed by repointing, not by deletion.** The gate must still fire after this
> ticket; prove it with a test that a bound-and-enabled node still blocks a failing approval.

## 4. Surviving features that depend on the deleted thing

| # | Finding | Resolution |
|---|---|---|
| **D-27** | `PromptManagementService.approveTemplate()` — a **surviving** flow — calls `promotionGate.evaluatePromotion()` (`prompt-management.service.ts:506-519`); the gate discovers golden sets **only** via `DepartmentAgentRepository.findByBoundTemplate` (`eval-promotion-gate.service.ts:2,55,93-94`). | **OD-11**: retire the gate. Removing it must be explicit and tested — a safety control must not vanish silently. |
| **D-28** | `AgentPromotion`'s subject is a `DepartmentAgentVersion.configSnapshot`; authorization keys on `@CanManage('DepartmentAgent')` (`agent-promotion.controller.ts:27`) and `ability.can('manage','DepartmentAgent')` (`agentPromotion.service.ts:344`); `apikey-scopes.registry.ts:341` makes `admin:agent-promotion:manage` **imply** `manage:DepartmentAgent`. | **OD-10**: rewrite around a successor promotable — **agent nodes / workflow definitions**. New CASL subject; scope implication repointed. |
| **D-26** | `/agents` nav gate requires `manage:PromptTemplate` (`nav-config.ts:546-553`) but the screen CRUDs **`DepartmentAgent`** (`agents-screen.tsx:15,50`) — already decoupled before any change here. | Removing the `/agents` route removes the mismatch. Leave a one-release `redirect()` per `13-nextjs-apps.md`. |
| **OD-12** | Per-agent `HarnessPolicy` overrides run on **every** `getEffectivePolicy` return path (`applyAgentOverrides`). | **Retire outright** — `applyAgentOverrides`, `TENANT_TIER_HARNESS_OVERRIDE_KEYS`, and the `overridesSource` provenance fields are deleted, not repointed. |

## 5. Must NOT be deleted (naming traps)

`AgentPromotion` (rewritten, not deleted) · `AgentTrajectoryStep` / `agent-trajectory.*` ·
`agentic.ts` / `AgenticInstructionsResponse` / `/agentic-policy` · `PromptTemplate` / `PromptVersion`
· `ConsultationContextSchema` / `Version` · **`/prompt-templates` and its whole component tree** —
including `agent-detail.tsx`, which is 100% PromptTemplate despite the name ·
`ILoopConfigService` / `LoopConfigResponse` (contract survives; only the implementation is rebuilt) ·
`packages/agentic-sdk-v2` entirely — `OpenSessionInput.departmentId` names **`Department`**, a
different model.


## 5a. Deletion inventory — inlined so this ticket is self-contained

Every path below was independently read during the 2026-08-25 sweep. **Read §5 (Must NOT be
deleted) before executing any of it.**

### DELETE — whole files

| Area | Paths |
|---|---|
| **Prisma** | `department-agent.prisma:22-198` (`model DepartmentAgent` + `model DepartmentAgentVersion`). **Lines 200-282 (`model AgentPromotion`) STAY** |
| **Domain** | `entities/generated/core/DepartmentAgent{,Version}Entity.ts` (+ their `__tests__`), `factories/generated/core/DepartmentAgent{,Version}Factory.ts`, `mappers/generated/core/DepartmentAgent{,Version}EntityMapper.ts` (+ test), `models/generated/core/DepartmentAgent{,Version}Model.ts`, `repositories/generated/core/DepartmentAgent{,Version}Repository.ts` (+ `findByBoundTemplate` test), `enums/generated/DepartmentAgentDnaPolicy.ts`, `enums/generated/DepartmentAgentRole.ts` |
| **Applications** | the whole `services/departmentAgent/**` folder (service, module, DTO mapper, `constants.ts`, `agent-template-resync.service.ts`, `agent-template-resync.cron.service.ts`, `dto/**`, `__tests__/**`); `services/consultation/prompt/agent-finalize-llm.ts` (+ its test) |
| **API** | `src/modules/department-agent/**` (module, controller, resync controller, tests); `tests/e2e/department-agent-resync.spec.ts` |
| **SDK** | `packages/vox-node/src/resources/admin/department-agent.ts` — **generated; deletes itself on regeneration. NEVER hand-delete** |
| **Console** | `app/(console)/(tenant)/agents/{page,loading}.tsx`; `features/agents/components/{agents-screen,agents-tab,agent-detail-drawer,agent-loop-config-tab,agent-loop-config-fields,agent-lineage-tab,agent-version-lineage}.*` (+ their `__tests__`); `tests/e2e/agents.spec.ts` |

### EDIT — references to remove

| Path:line | Change |
|---|---|
| `department.prisma:45`, `prompt-template.prisma:96` | remove the `DepartmentAgents DepartmentAgent[]` back-relations (schema-only, no SQL) |
| `enums.prisma:452-472` | remove `DepartmentAgentDnaPolicy`, `DepartmentAgentRole` |
| `audit.prisma:201` + `packages/domains/src/enums/generated/ResourceType.ts:58` | remove `DepartmentAgent` **in lockstep** (`resourceType.enum-parity.test.ts` guards it) |
| `extensions/tenant-scope.ts:208,212` | remove both from `TENANT_SCOPED_MODELS` — **`tenant-scope.test.ts:141` asserts an exact size (86 → 84)**. Update the number, do not delete the assertion |
| `client.ts:188` | remove `DepartmentAgentVersion` from `MODELS_WITHOUT_SOFT_DELETE` |
| `core.database.module.ts:40-41,192-195` | remove both repository providers/exports (`AgentPromotionRepository` at `:197` STAYS) |
| `common/phi-read-decrypt.ts:162,167,168,183` | remove the relation-map entries and back-relation keys |
| `DepartmentModel.ts:36,60`, `PromptTemplateModel.ts:42,68` | remove the virtual `DepartmentAgents` field + ctor assignment |
| barrels: `entities/…/index.ts:74-75`, `factories/…:74-75`, `mappers/…:25-26`, `models/…:27-28`, `repositories/…:37-38`, `enums/…:30-31`, `services/index.ts:24` | remove export lines |
| `live-agent.port.ts:25,49,73-96,108-119,129-134` | `FrozenLiveAgentSnapshot`, `PersistedLiveAgentLineage`, `ResolvedToolPlan` typed against the deleted `constants.ts` |
| `live-tool-registry.ts:40,123,426,451` | executor registry keyed 1:1 to `LIVE_TOOL_KEYS` |
| `live-agent-resolution.service.ts` (whole file, 269 lines) | the `ILiveAgentResolver` implementation — rebuild against node config |
| `prompt-resolution.service.ts:67-68,327,834-913` | Tier-1a agent resolution — **repoint, preserving the §2 contract** |
| `prompt-assembly.service.ts:485,491` | consumes `resolved.content`/`resolvedFrom` |
| `summary.service.ts:32,244,630,642-645,687-688` | writes `SummaryMeta.sessionAgentId`/`sessionAgentPromptVersion`; feeds `pinnedAgentId` |
| `consultation-event.handler.ts:26,80,461-464` | DNA-redaction gate reads `defaultAgent.dnaStylePolicy` |
| `config-resolver.service.ts:30-36,257,260` | `departmentAgentDnaDisabled` field + its gate |
| `loop-config.service.ts` (whole file, 331 lines) | **rebuild**; `ILoopConfigService`/`LoopConfigResponse` survive |
| `harness-policy.service.ts:8,20,291,378,457-521` + `harness-policy.response.ts:16,21,157` | **OD-12: retire `applyAgentOverrides` outright** |
| `eval-promotion-gate.service.ts:2,55,93-94` | **OD-11: repoint discovery, keep the service** |
| `agentPromotion.service.ts:17-23,36-42,58-116,203-761`, esp. `:344` | **OD-10: rewrite around workflow/node promotables** |
| `agent-promotion.controller.ts:27` | class-level `@CanManage('DepartmentAgent')` — new CASL subject required |
| `apikey-scopes.registry.ts:337-342,413-421` | `admin:agent-promotion:manage` **implies** `manage:DepartmentAgent` at `:341` — repoint; remove `admin:department-agent:manage` |
| `platform-ops.descriptors.ts:184-201` | remove the two `departmentAgent.templateResync.*` descriptors |
| `tenant.service.ts:22-23,96-99,213,457-607` | `provisionTenantAgentCatalog()` — likely a no-op/delete; the call site needs an explicit edit |
| `app.module.ts:82,464-468`; `admin-scope-audit.ts:73-74,174-175`; `task-773-admin-scope-map.ts:166-175`; `openapi/tags.ts:245-250` | module + audit + scope-map + tag removal |
| `tools/src/utils/schemaCoverage.ts:124-127` | remove the `FACTORY_OMITTED_SCALARS_BY_MODEL` entry |
| seeds | `01-policy.ts:181`; `11-global-setting.ts:536-559` + `00-constants.ts:760-761`; `07a-agent-golden-library.ts` (**surgical** — keep Department/PromptTemplate/PromptVersion golden seeding, drop only the agent upsert loop); `07e-consultation-loop-defaults.ts` (**surgical** — keep the context-schema half); `seed/index.ts:17,179,203,205,209` |
| e2e | `task-635-live-agent-lineage.spec.ts:283,323,336,372` and `task-663-agent-promotion-cross-tenant.spec.ts:72` — **rewrite, do not delete** (surviving features on agent-shaped fixtures) |

### COUPLING — capability → what must absorb it

| Capability | Current owner | Absorbed by |
|---|---|---|
| Live-loop identity, prompt bytes, tool plan, per-task LLM override (`FrozenLiveAgentSnapshot`) | `live-agent-resolution.service.ts`, frozen at `start()` | Node config resolved atomically at session start; **must never throw** (fail-open to code default is a clinical-safety requirement); must support the 3-tier crash-recovery re-pin |
| `llmOverrides`/`liveLlm` — fail-**open** for live, fail-**closed** for finalize | `resolveLiveLlm` + `agent-finalize-llm.ts` | Node `llmBinding` (TASK-816). **The fail-open/fail-closed split by task is a deliberate invariant — re-encode it, do not lose it** |
| `neverActions`/`alwaysActions` (compliance envelope) | `loop-config.service.ts` | Endpoint sequence config (TASK-812). `AGENT_ACTION_KEYS` + validators travel with it |
| `LIVE_TOOL_KEYS` | `constants.ts:61` | Node dispatch (TASK-811). `live-tool-registry.ts` is **not** agent-specific — re-key it, don't delete it |
| Python Temporal payloads `agent_id`/`agent_config_version_id`/`role` | `apps/harness/src/harness/temporal/models.py:1241-1311` | **Replay-sensitive.** Feed the same field names from a new source, or do a coordinated replay-compatible rename |
| Per-agent `HarnessPolicy` overrides | `applyAgentOverrides` | **OD-12: retired outright** |
| Eval gate discovery | `findByBoundTemplate` | **OD-11: node `evalGate.goldenSetId`** |
| `AgentPromotion` promotable | `DepartmentAgentVersion.configSnapshot` | **OD-10: workflow/node versions** |
| Golden Department/PromptTemplate catalog | `07a-agent-golden-library.ts` | Survives under a name that drops "agent" |

## 6. Implementation Plan (ordered — do not reorder)

| # | Task |
|---|---|
| 1 | Confirm TASK-809 + TASK-811 have landed (hard precondition §1). |
| 2 | Repoint `PromptResolutionService`'s Tier-1a onto node config, preserving the §2 contract | 
| 3 | **OD-11**: migrate `goldenSetId` onto node `evalGate`, repoint `EvalPromotionGateService` discovery, add the tenant-admin enable/disable. Prove a bound+enabled node still BLOCKS a failing approval |
| 4 | Rewrite `AgentPromotion` around workflow/node promotables (OD-10); new CASL subject; repoint `apikey-scopes.registry.ts:341` |
| 5 | Retire per-agent harness overrides (OD-12) |
| 6 | Rebuild `LoopConfigService` against graph config; keep `ILoopConfigService`/`LoopConfigResponse` |
| 7 | Python: `LoopAgentSpec`/`ConsultationLoopConfig` carry `agent_id`/`agent_config_version_id`/`role` and are **replay-sensitive** — replace the identifier source feeding the same field names, or do a coordinated replay-compatible rename |
| 8 | Delete the domain trio, service folder, API module, console `/agents` screen (+ one-release `redirect()`), seeds |
| 9 | Prisma migration: drop `DepartmentAgentVersion` then `DepartmentAgent` (FK order); drop both enums; handle `ResourceType` per §7 |
| 10 | Allow-lists: `TENANT_SCOPED_MODELS` (**`tenant-scope.test.ts` asserts an exact size — update the number**), `MODELS_WITHOUT_SOFT_DELETE` |
| 11 | Regenerate the five artifacts; `packages/vox-node/.../department-agent.ts` disappears by regeneration — **never hand-delete** |
| 12 | Rewrite (not delete) the surviving e2e specs built on DepartmentAgent fixtures |

## 7. Migration notes
Drop order respects `ON DELETE RESTRICT`. `ResourceType` enum value removal in Postgres is not
cheap — either recreate the type (feasible pre-production) or leave a documented `HARMLESS-UNUSED`
value, following the existing precedent. Either way `audit.prisma` and
`packages/domains/src/enums/generated/ResourceType.ts` move in lockstep (`resourceType.enum-parity.test.ts`).

## 8. Verification
```bash
pnpm --filter @arcaai/database test
pnpm --filter @arcaai/domains build test
pnpm --filter @arcaai/applications build test
pnpm harness:test
pnpm --filter @arcaai/admin-console build lint test
pnpm --filter @arcaai/vox-node gen:admin:check
pnpm test:up:api && pnpm test:e2e
```

## 9. Definition of Done
- [x] Eval gate still fires from node config; `GoldenSet`/`GoldenCase`/`EvalRun` untouched; enable/disable works — `eval-promotion-gate.service.test.ts:78` "BLOCKS in block-mode when the eval fails — the safety control still fires after the repoint"; `GoldenSet`/`GoldenCase`/`EvalRun` untouched per §3 (repointed discovery only, subsystem not modified)
- [x] `PromptResolutionService.resolve()` contract unchanged; compat untouched — `prompt-resolution.service.ts:110,127,139,485` still declares `resolvedFrom`/`resolvedVersionNumber`/`resolvedAgentId` and `async resolve(params): Promise<ResolvedPromptConfig>` verbatim; `DepartmentAgent` appears only in historical comments, no live reference
- [x] `AgentPromotion` rewritten; new CASL subject; scopes repointed — `agentPromotion.service.ts:46` `PROMOTION_SUBJECT = 'WorkflowDefinition'`; `agent-promotion.controller.ts:32` `@CanManage('WorkflowDefinition')` (was `DepartmentAgent`, D-28)
- [x] Eval gate retired deliberately and tested — `eval-promotion-gate.service.test.ts:120` "OD-11 — a DISABLED gate proceeds with a recorded warning rather than blocking" (the tenant-admin disable toggle from §3, tested as its own scenario distinct from the still-fires case above)
- [x] No survivor from §5 deleted — spot-verified: `packages/domains/src/entities/generated/core/` has no `DepartmentAgent*` (deleted); `AgenticInstructionsResponse`, `agent-trajectory-retention` and `AgentPromotion` all still exist (survived, per §5)
- [x] Enum parity green; allow-list sizes updated — `tenant-scope.test.ts:149` `TENANT_SCOPED_MODELS.size).toBe(87)`, comment recording the -2 for `DepartmentAgent`+`DepartmentAgentVersion` (TASK-815); `ResourceType.DepartmentAgent` confirmed still present in `pg_enum` after the owner-applied migration (§10a)

## Best Practices — apply to every task here

- **Deletions are unrecoverable — over-scoping is the failure mode.** When in doubt, stop and ask.
- **Preserve the `PromptResolutionService.resolve()` contract** (§2). It is reached by a frozen
  compat route; its signature and `ResolvedPromptConfig` field set must not move.
- **Naming traps (§5):** `agent-detail.tsx` is 100% PromptTemplate. `AgentTrajectoryStep`,
  `agentic.ts`, `/agentic-policy` and `AgentPromotion` are all different things.
  `OpenSessionInput.departmentId` names `Department`, not `DepartmentAgent`.
- **A safety control must never vanish silently.** The eval gate is being REPOINTED, not removed —
  prove it still fires after the migration, and that disabling it is an explicit tenant-admin act.
- **Generated files delete themselves.** `packages/vox-node/.../department-agent.ts` disappears when
  the routes leave the manifest and you regenerate. **Never hand-delete it.**
- **Enum parity moves in lockstep:** `audit.prisma` and `packages/domains/src/enums/generated/ResourceType.ts`.
  `resourceType.enum-parity.test.ts` guards it. Skipping this makes every AuditLog INSERT throw and
  turns the originating mutation into a 500.
- **Allow-list tests assert exact sizes** — `tenant-scope.test.ts` checks a literal count. Update
  the number, do not delete the assertion.
- **Python Temporal payloads are replay-sensitive.** `agent_id` / `agent_config_version_id` / `role`
  thread through workflow history; replace the identifier source feeding the same field names, or
  do a coordinated replay-compatible rename.
- **Retired routes keep a `redirect()` for one release**, with a comment naming the release that
  deletes them.

## Standing instructions (every task in this ticket)

- **Evidence, not assertion.** "Tests pass" with nothing pasted is not a result. Paste actual
  command output (`01-development-workflow.md` §Phase 5).
- **TDD:** failing test first, and you must *see it fail*. A test that never failed verifies nothing.
- **Branch is `dev-2.2`**, never `dev`.
- **Never `git stash` in a worktree** — the stash stack is shared repo-wide. Commit, then
  `git checkout HEAD~1 -- <path>` for a baseline.
- **Orchestrator owns shared surfaces:** merges, `pnpm install`, `db:push`/`db:migrate`/
  `test:db:reset`, Docker/infra, and every `gen:*` invocation. Do not run them.
- **Lint warnings in `packages/*` are errors.** `eslint-plugin-only-warn` downgrades them; treat
  them as hard failures anyway.
- **Do not run** the test suites of `apps/compat-playground`, `apps/quick-compat-app`, or
  `packages/ui` unless your change lands inside that package (owner directive).

### Destructive-tooling warnings (this ticket touches Prisma)

- **NEVER run `pnpm gen:mapper`.** It rewrites mappers as it goes and **drops the
  `FIELDS_NOT_WRITABLE = ['version']` OCC guard** before crashing. One run clobbered 24 mappers and
  stripped the guard from 18. Recovery is `git checkout -- packages/domains/src/mappers/generated/core/`.
- `gen:entity` / `gen:factory` **reconcile barrels and check coverage — they never create files.**
  Entity, factory, mapper and repository are **hand-authored**.
- `gen:repository` is broken (bad argument); harmless but useless.
- Migrations are authored against a **throwaway shadow DB**, never the dev DB — recipe in
  `02-database-prisma.md`. The dev DB is `db push`-managed and has no migrations ledger.
- On `@@unique`, `name:` is the **client-facing** compound key; the DB index name comes from `map:`.

### The five-artifact rule (this ticket changes an admin route)

`.claude/rules/05-nestjs-api.md:155` still says **four** artifacts and omits the fifth. That
omission turned TASK-805's pipeline #990 red. The real rule:

```bash
pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal \
  && pnpm --filter @arcaai/vox-node gen:admin
```
Verify with `pnpm api:openapi:check`, `pnpm api:portal:check`, `pnpm --filter @arcaai/vox-node gen:admin:check`.
**`packages/vox-node/src/resources/admin/**` is GENERATED — never hand-edit.** Only
`admin-resource.ts` is hand-authored.

### Finishing protocol — land it on `dev-2.2`, leave no worktree behind (owner directive, 2026-08-25)

**No work is "done" while it sits in a worktree.** When your gates are green, you MUST complete
this sequence. It is not optional and its order is not negotiable.

1. **Bring the target in first.** `git merge dev-2.2` INTO your branch and resolve any conflicts
   **in your own worktree**, never in the primary checkout.
2. **Re-run every gate AFTER that merge.** A clean merge is not a passing build. Paste the output.
3. **Merge your branch into `dev-2.2`** — the target is always `dev-2.2`, never `dev`.
4. **Only once step 3 is committed:** remove your worktree (`git worktree remove <path>`) and delete
   your branch.

**Before step 4, prove there is nothing left to lose:**
```bash
git log <your-branch> --not dev-2.2 --oneline   # MUST be empty
```
If it is not empty, stop — you have unmerged commits. Never use `git worktree remove --force`,
never `git worktree prune` "to tidy up", and never delete the directory by hand. An abandoned
worktree is recoverable; a removed one is not.

**If you cannot complete the merge** — conflicts you cannot resolve, a failing gate, an ambiguous
call — **LEAVE THE WORKTREE IN PLACE** and report it at the TOP of your final message with its path
and branch. Never bury an un-merged worktree in the body of a report.

**Concurrency note:** when several lanes run at once, the orchestrator may tell you to stop after
step 2 and hand off, so the final merges are serialized and lanes do not race each other into
`dev-2.2`. Follow that instruction if you receive it; otherwise complete all four steps yourself.

## Close-out protocol — MANDATORY (owner directive 2026-08-26, amended by measurement)

**Which path applies depends on where you work. Read the right one.**

### If you work in a WORKTREE

You **cannot** merge into `dev-2.2` yourself, and you must not try. `dev-2.2` is checked out in the
primary checkout, so git refuses every route into it — `git push . HEAD:dev-2.2` returns
*"refusing to update checked out branch"*, and it is right to: the primary's index and work tree
would desync from HEAD. This was measured, not assumed.

1. **Verify your base FIRST — before any other work.** Worktrees have been created off **`dev`**,
   where `packages/workflow-contract` does not exist at all; two of two agents hit this.
   Run `git merge-base --is-ancestor $(git rev-parse dev-2.2) HEAD`. Non-zero ⇒ confirm your tree
   is clean, then `git reset --hard dev-2.2`. Report which you found.
2. Gates green on your branch, with output pasted.
3. Commit everything. Leave the worktree and branch **intact**.
4. Report your branch name, commit SHA, and that the merge is pending. The orchestrator merges from
   the primary checkout, re-runs the gates there, and only then destroys the worktree and branch.

### If you work in the MAIN CHECKOUT

1. Gates green on your branch, output pasted.
2. **Merge into `dev-2.2`.** Never `dev`.
3. **Re-run the affected gates AFTER the merge** — a clean merge is not a passing build; a sibling
   lane may have moved the base underneath you.
4. **Delete your branch**, only after confirming the merge is on `dev-2.2`
   (`git log dev-2.2 --oneline | grep <your-sha>`).

### Stop conditions — never force past these

- A merge that conflicts in a way you cannot resolve with confidence ⇒ **STOP and report**, leaving
  the branch intact. An abandoned branch is recoverable; a bad merge or a deleted branch is not.
- Gates failing after a merge ⇒ **STOP and report**. Delete nothing.
- Never `git worktree remove --force`, never `git worktree prune`, never delete a branch holding
  commits absent from `dev-2.2`.
- Never `git stash` — the stash stack is shared repo-wide across every worktree.

## Agent Brief (self-contained — copy verbatim when dispatching)

**Ticket:** TASK-815 · **Branch:** `dev-2.2` · **Tree:** worktree `../hope-v2-task-815` off `dev-2.2`
**Agent:** `general-purpose` · **Model:** `opus` · **Effort:** `max`
**Review lens:** + `security-auditor` (CASL subject removal, scope registry) + `database-admin` (migration).

**DO NOT START** until TASK-809 and TASK-811 have landed — a hard gate. OD-11 is resolved (§3): the
eval gate SURVIVES with its binding moved onto node config.

**Per-task tiers:** the inventory is already done (master §2.8) — do not redo it at `opus`. The
deciding stages are: the `PromptResolutionService` repoint, the `AgentPromotion` rewrite, and the
migration. Keep those at `opus`/`max`. Mechanical file deletion is `sonnet`-grade but must be
reviewed against §5 before executing.

**You own:** everything in the master's DELETE/EDIT inventory for `DepartmentAgent`.
**You must not touch:** the compat fence; anything in §5 (Must NOT be deleted).
**Return contract:** `PRECONDITIONS` (proof 809/811 landed), `CONTRACT_HELD`
(proof `resolve()` signature unchanged), `DELETED` (files), `REWRITTEN` (AgentPromotion + LoopConfig),
`MIGRATION` (SQL + drift proof), `PARITY` (enum + allow-list assertions updated), `SURVIVORS`
(confirmation nothing in §5 was removed).

**Rules to read before starting:** `.claude/rules/` files 00, 01, 02, 03, 04, 05, 06, 13. A subagent inherits NONE of the orchestrator's context — read them.

## 9a. Implementation Summary

> Renumbered from `§10` (2026-08-29 docs pass) — `§10` below ("Two things awaiting the owner") is
> a distinct, later addendum with its own established `§10a`–`§10d` subsections and an existing
> cross-reference from the header; giving this required section the same number was the collision.
> This section and `§9b` (Change History, renumbered from `§11` for the same reason) sit here,
> between the Definition of Done and the addenda chain, rather than colliding with it.

`DepartmentAgent` and its whole capability surface were deleted from a live-running platform in one
merge: 205 files changed, 21,092 deletions. The deletion inventory (§5a) and the four capability
deltas it necessarily produces (§10b) were known and accepted *before* the deletion landed — this
was not a mechanical `rm` run against a schema nobody had read.

What survived, deliberately: `AgentPromotion` (rewritten onto a new CASL subject, §4), the eval
gate (OD-11 — binding moved to the node, golden sets untouched), the compat contract
(`TextCompatController` → `PromptResolutionService.resolve()`, §2, verified unmoved), and the
`ResourceType.DepartmentAgent` enum value (kept for historical `AuditLog` rows, §2c).

What was found and fixed in passing, not part of the original scope: tenant provisioning was
iterating golden **agents** instead of golden **departments** (§10c) — left alone, every newly
provisioned tenant would have been silently reduced to a bare `GEN` department.

Work continued after the initial merge, each recorded in its own numbered section below rather
than folded back into this summary: the migration's application to shared databases (§10a,
resolved by the owner), the four capability-delta rulings (§11), the P-4 client-side fix for the
impersonated clinician's silently-403ing catalogs (§12), the target node catalogue landing in Lane
A — registry 36→48 (§13), and the realtime consultation-loop work in Lane R — registry 48→49
(§14). Full evidence (gate output, file lists, test names) lives in those sections; this summary
is a map to them, not a second copy.

## 9b. Change History
| Date | Change |
|---|---|
| 2026-08-25 | Opened from TASK-806 §7. Carries OD-10, OD-11, OD-12. |
| 2026-08-25 | **OD-11 revised — unblocked.** Eval gate survives; `goldenSetId` binds to the node; tenant-admin enable/disable added. Full DELETE/EDIT/COUPLING inventory inlined (§5a) so the ticket is self-contained. |
| 2026-08-29 | **Deletion merged to `dev-2.2`.** 205 files, 21,092 deletions. Gates: database 1641, domains 1848, applications 10303, api 4019, admin-console 2130 (two consecutive clean runs after a load flake in the first sweep), harness 1668, `gen:check` no-drift ×3 + schema coverage OK, `gen:admin`/`portal`/`openapi` no drift (52 areas, 404 routes, 371 schemas; admin 608 ops), lint 40/40. Orchestrator independently verified both hard invariants and rebuilt domains+applications before trusting any artifact (stale-dist trap). Migration authored against a throwaway shadow DB, drift-free, deliberately **not yet applied** to shared dev/test (§10a). Tenant-provisioning golden-agents-vs-departments bug found and fixed in passing (§10c). |
| 2026-08-29 | **Migration applied by the owner** (§10a resolved) — verified against both dev and test DBs: `DepartmentAgent`/`DepartmentAgentVersion` gone, `AgentPromotion` survives, `ResourceType.DepartmentAgent` still present in `pg_enum`. Test DB reseeded (32 users, 3 workflow definitions). Owner rulings recorded on all four §10b capability deltas (§11) — all binding. |
| 2026-08-29 | **P-4 CLOSED** (§12) — the impersonated clinician's silently-403ing catalogs were a client-side defect, not a missing endpoint; the non-admin routes the original ruling asked to build already existed (`dna-writing-styles/mine`, `users/me/departments`). Zero routes added. |
| 2026-08-29 | **Lane A landed** (§13) — the target node catalogue: registry 36 → 48 (nine `agent.*`, three `guard.*`). Two owner rulings still needed (§13a); one contract rule deleted on evidence (§13b — "realtime-lane node MUST NOT be `externalWrite`" replaced by "every node must be idempotent, in either lane"). |
| 2026-08-29 | **Lane R landed** (§14) — the realtime consultation loop against the owner's four-item acceptance bar: partial transcript + advisory corrections and partial summary + template autofill both work; "important information highlighted" does not exist anywhere in the platform and needs an owner design decision (§14a). A silent live defect (flush projecting by raw node type instead of canonically) found and fixed (§14d). |
| 2026-08-29 | Docs reconciliation pass (Lane G, TASK-806 programme): this section and `§9b` renumbered from colliding `§10`/`§11` headings (the required Implementation Summary/Change History vs. the later addenda that had reused the same numbers); `§9a` given real content in place of "_Not started._"; the two hardcoded/stale registry-checksum literals in §13 corrected to point at the generated constant. No code changed. |

## 10. Two things awaiting the owner

### 10a. ~~The migration is NOT applied~~ — **RESOLVED 2026-08-29, owner applied it**

> Verified by the orchestrator against both databases: `DepartmentAgent` and `DepartmentAgentVersion`
> are gone from dev and test; `AgentPromotion` SURVIVES (correct — it was deliberately not dropped);
> and `ResourceType.DepartmentAgent` is still present in `pg_enum` (correct — §2c). Test DB is
> reseeded: 32 users, 3 workflow definitions. Original note below for the record.

### 10a (original). The migration is NOT applied to the shared dev/test databases

`20260828195605_task_815_retire_department_agent` was authored against a throwaway shadow DB
(`hope_shadow_815`) with the full ledger replayed, and proven drift-free
(`prisma migrate diff` → `-- This is an empty migration.`). It was deliberately **not** run against
local dev or test.

Reason: it DROPs two tables and two enums. `02-database-prisma.md` requires explicit owner approval
for `DROP`/`DELETE`/`TRUNCATE`, and that approval covers the act of destroying data, not merely the
ticket that made the tables unnecessary. Local dev is `db push`-managed, so the sync is
`pnpm db:push` — which will report data loss on those tables and needs the owner to accept it.

Nothing is broken in the meantime: no code references the tables, so their continued presence in a
local DB is inert drift, not a fault.

### 10b. Four capability deltas — each documented at the code, none silent

| Delta | Direction |
|---|---|
| Visit-type axis leaves tier-1a for the department tier (DD-2) | Narrower resolution axis |
| Pre-summary loses tier-1a until an `agent.presummarization` node exists | Falls back to the tenant tier |
| **DNA-redaction agent veto removed** | **More redaction, not less.** The dropped gate could ONLY force redaction OFF, so a consultation the tenant AND the doctor both enabled is now actually redacted. Honouring two explicit opt-ins over a third party's override reads as closing a latent bug, not a regression — but it IS a behaviour change a tenant could notice |
| PRIMARY/SPECIALIST deliberative lane retires with `DepartmentAgentRole` | Capability removed with no successor — deliberate |

### 10c. Also found and fixed in passing

Tenant provisioning iterated golden **agents**, not golden departments. Left alone, every newly
provisioned tenant would have been quietly reduced to a bare `GEN` department. A mechanical deletion
would have shipped that.

### 10d. Pre-existing, out of scope

`apps/api/src/modules/consultation/__tests__/harness-internal.controller.test.ts` fails `tsc --noEmit`
(12 constructor args, 13-15 expected). Identical at base `55555d988`, untouched by this ticket, and
Vitest passes — only a standalone typecheck sees it.

## 11. Owner rulings on the four deltas (2026-08-29) — BINDING

All four §10b deltas were put to the owner. Verdicts, verbatim intent:

| Delta | Ruling | What it obliges |
|---|---|---|
| **PRIMARY/SPECIALIST deliberative lane retired** | **Approved.** | Nothing further. The capability is gone with no successor, by decision. |
| **Pre-summary loses tier-1a** | **Not accepted as a silent fallback.** It **must be tenant tier**, and a tenant **must configure an active pre-summarization agent node**. | Pre-summary resolution is tenant-tier; absence of a configured, ACTIVE pre-summarization node is a configuration error to surface, not a silent drop to a platform default. |
| **Visit-type axis** | **Tenant-admin defined and controlled.** Two defaults ship: **New patient** (new visit, new referral) and **Revisit** (follow-up same-day, review same-day, revisit same-day). | Visit type becomes tenant-configurable data with those two seeded defaults — NOT a hardcoded enum, NOT a platform constant. Subject to `00-project-context.md` §Configuration Principles: tenant → SYSTEM, never a literal in code. |
| **DNA-redaction agent veto removed** | **Approved**, with a rider: **DNA-Redaction must be configured as an agent node.** | The veto stays gone. DNA-redaction itself becomes a NODE in the workflow graph like every other capability, rather than a resolver-side flag triple. |

Two of these (pre-summary, DNA-redaction) say the same structural thing: **a capability that used to
live in resolver logic becomes a NODE a tenant admin places in a graph.** That is the substrate
direction TASK-806 set out, applied to the two capabilities this deletion exposed.

## 12. P-4 — **CLOSED 2026-08-29.** The endpoints already existed; the defect was client-side

> **The orchestrator's brief for this lane was wrong, and the lane said so.** It was told to BUILD
> non-admin clinician endpoints. Both already existed on the base commit and were verified there
> before merge:
> `GET dna-writing-styles/mine` (`dna-writing-style.controller.ts:196`, `doctorId` = CLS user) and
> `GET users/me/departments` (`user-departments-me.controller.ts:28`, `userId` = CLS user).
> **Zero routes were added** — the manifest and `openapi.json` are untouched in the lane's diff, and
> no admin guard was relaxed. The playground was simply calling `admin/*` when owner-scoped
> equivalents were already serving the same data.
>
> `users/me/departments` is also the better surface than the tenant-wide catalog the brief would
> have produced: a clinician scopes a note to a department they actually belong to.
>
> **Ownership is structural, not branch-guarded.** Neither route accepts an id — the subject is the
> CLS principal, so cross-clinician substitution cannot be expressed. Proven by mutation: making the
> resolver return `impersonatedBy ?? user.id` turned both ownership tests RED (impersonation must
> read the CLINICIAN's rows, not the admin's); reverting restored 42/42.
>
> Two further silent-failure defects fixed in passing: the DNA picker rendered N identical options
> (labelling one doctor's own styles by doctor name), and the department picker collapsed loading,
> empty and failed into one vanished control — now a `<Skeleton />` and a `role="status"` notice
> naming the consequence, following the existing `ImpersonationGatePanel` idiom.
>
> **Not verified:** no real browser in both themes. The lane was barred from starting a stack, and
> TASK-814 §9 established that jsdom axe is structurally blind to contrast and scroll-focus rules —
> so a jsdom "both themes pass" would have been false confidence. Folded into the Lane E runtime pass.

### 12a. Original ruling (for the record) — clinicians get non-admin endpoints for their OWN DNA writing style

TASK-814 §9 P-4 reported that an impersonated clinician silently 403s on `admin/dna-writing-styles`,
`admin/departments` and `admin/consent-grants`, leaving selectors blank with no explanation, on the
only clinical persona OD-2 defines. It was referred out as a product/API decision.

**Owner ruling:** build **non-admin endpoints so a clinician can manage the DNA writing style data
they OWN.** Not a widened admin gate, not a UI-only empty state — a clinician-plane surface scoped
to the caller's own rows.

Design constraints this inherits automatically:
- Ownership is enforced server-side, never by the caller passing an id. Precedent: personal
  (`USER_PERSONAL`) prompt templates, declared `@Authorize(['read','PromptTemplate'])` with
  ownership checked imperatively in the service (`05-nestjs-api.md` §Imperative Privilege Checks) —
  `read` is the ability clinicians hold; demanding `create`/`update` would lock them out of their
  own rows. Carry an `AUTH-NOTE:` marker.
- Cross-tenant is **404**, privilege failure inside the tenant is **403**.
- The `admin/*` routes stay exactly as they are; this is an ADDITIVE clinician plane.


### 12b. Incidental finding — two clinician roles that do not exist

`SPECIALIST` and `CONSULTANT` appear in `DNA_DOCTOR_ROLES` and `CLINICIAN_ROLES`, but **no such
`Role` row exists in the seed and no policy grants them anything.** Those two string comparisons can
only ever match a hand-made tenant role holding zero abilities — so any behaviour gated on them is
unreachable in a seeded stack. Needs its own ticket: either seed the roles with real abilities, or
delete the dead constants.

## 13. Lane A landed — the node catalogue (merged 2026-08-29)

Registry **36 → 48**: nine `agent.*` (transcription, normalization, ner, presummarization,
summarization, discharge_summary, retrieval, feedback, **dna_redaction**) and three `guard.*`
(phi, moderation, groundedness). The checksum was verified by the orchestrator against the value
computed from the built contract — not a literal anyone typed, and not pinned here either, since
it moves again with Lane R's `agent.grammar` addition below (§14) and every later ticket that
touches a node descriptor (TASK-809 §2y2). Read the live value from `REGISTRY_CHECKSUM` in
`packages/database/src/prisma/db_main/seed/23-arcaai-workflow-authoring.generated.ts`. Two seeds
now agree; seed 21 had been carrying a checksum stale since TASK-812.

Gates: workflow-contract 972 · database 1641 · applications 10344 · api 4029 · harness 1670 ·
`gen:check` no-drift ×3 · lint 40/40.

### 13a. TWO OWNER RULINGS STILL NEEDED

**(1) Should a missing pre-summarization node be FATAL?** §11 said absence must not be a silent
drop. Lane A made it loud (`trace.configurationErrors` + error log) but **not fatal**, because the
SYSTEM tier behind it is reached by the frozen v1-compat route and **no tenant has such a node
today** — failing closed now would take out every pre-summary on the platform, compat plane
included. Proposed safe ordering: seed an `agent.presummarization` node into the platform-default
graph FIRST, then make absence fatal. **Owner decision required.**

**(2) Confirm the durable-lane skip.** `lane` is now a real registry field and the durable
interpreter SKIPS realtime nodes with `reason="realtime_lane"`. In the seeded ARCAAI graphs that
means `consultation.captureBinding`, `consultation.extractEntities` and `consultation.realtimeSummary`
are skipped on the durable path. Argued lossless — in the durable lane `captureBinding` emits no
transcript, so both downstream nodes already degraded on `no_bound_text` every run — so this turns a
silent degrade into a visible skip. It is nonetheless a live behaviour change in seeded graphs.

### 13b. A contract rule was DELETED on evidence

TASK-809 declared *"a realtime-lane node MUST NOT be `externalWrite`"*. The runtime TASK-811 shipped
falsifies it: two of the three realtime node types write, and publishing the running note to the
live feed IS the realtime lane's product. Replaced by **"every node must be idempotent, in either
lane"**. The hazard the old rule reached for — two engines writing one consultation's document — is
a lane-membership hazard, now closed structurally rather than by a port-level prohibition.

### 13c. `purposeScope` taxonomy — proposed, awaiting confirmation

Reuses the existing `ConsentPurpose` enum rather than inventing one, restricted to members that can
justify an outbound tool call: `EXTERNAL_TOOL_LOOKUP` (the purpose `call_mcp_tool` already hardcodes),
`HISTORY_RETRIEVAL`, `AI_DOCUMENTATION`, `QUALITY_REVIEW`. `STYLE_LEARNING` deliberately excluded —
it authorizes a DNA writing-style opt-in, not egress, so a node declaring it could never be granted.
Stopped at four rather than padding to five. Exported as `TERMINOLOGY_PURPOSE_SCOPES`.

### 13d. Reported, not closed

`config.onError` is read by `compileNode` on every node but declared only on the consultation
schemas, and `compileNode` treats every value that is not `'degrade'` as `'fail'` — so the
consultation enum's `'retry'` is an authoring-time value with no compiled meaning. Guessing an enum
for the summarization/STT schemas would have been invention.

## 14. Lane R — the realtime consultation loop (merged 2026-08-29)

Owner's acceptance bar: during a live session a clinician sees (1) partial transcription updated by
grammar/spelling agents, (2) partial summarization with template autofill, (3) important information
popped up and highlighted. Registry **48 → 49** (`agent.grammar`). Gates: workflow-contract 1003 ·
database 1647 · applications 10375 · api 4029 · harness 1670 · gen:check no-drift ×3 · lint 40/40.

### 14a. Per-item verdict against the owner's bar

| Item | Verdict |
|---|---|
| Partial transcript | **Works** (WS `/ws/stt/stream`, partial + final frames) |
| …plus advisory corrections | **Made to work.** Channel and console panel already existed; the realtime lane now produces corrections per flush over the RAW transcript. Offsets are into the flush slice, pinned by `textSha256` — not session-global |
| Partial summary + template autofill | **Works** — `DocumentTemplate` → compiled `responseFormat` schema → parsed into the template's checklist. **Caveat: tenant-default template only**; `realtimeSummary`'s own `documentTemplateId` is declared but inert in the realtime path |
| **Important information highlighted** | **DOES NOT EXIST.** Entities reach the client re-anchored into the note so the UI *can* highlight them, but there is no red-flag / critical-value / allergy-alert / severity layer anywhere. `groundedness.flaggedSpans` flags UNGROUNDED MODEL TEXT — a different thing. **Owner design decision needed: what makes information "important"?** |

### 14b. The finalization chain is NOT seeded — owner design call

`agent.dna_redaction` is **absent from both** seeded graphs, as are `summary.finalize` /
`feedback.capture` / `session.timeout` (the endpoint stage is driven by the
`consultation.endpoint.actions` global-kv sequence, not the graph). What IS present:
`n_synth → n_sensors → n_persist`, so groundedness does run on the written note before persist.
But `n_phi` (`mode: 'pseudonymize'`) runs BEFORE synthesis — on the input, not on a written note.
Produce-then-lock is still enforced on the write path by `endpointOrderProblem` (TASK-812).

### 14c. Three corrections to the orchestrator's brief

1. **R1's premise was half wrong.** The live delivery channel already existed end to end
   (`publish_live_assist(kind="corrections")` → Redis → SSE → `correction-proposals-panel.tsx`).
   Broken was CADENCE and INPUT: `descriptor.trigger` is read by **no runtime** (0 hits in
   `apps/harness/**`), the graph walk is dispatched once at consultation OPEN, and both seeded
   graphs fed the corrector from `n_synth` — the finished note, not the partial transcript.
2. **R2 was structurally impossible.** There is no SYSTEM-tenant consultation graph and cannot
   usefully be one: `WorkflowDefinition`/`WorkflowAssignment` are deliberately excluded from
   `SYSTEM_SHARED_READ_MODELS`, and assignment resolution cascades department → tenant → `null`,
   never widening to SYSTEM. Seeded into ArcaAI's two graphs; gap reported rather than widening the
   tenancy posture.
3. **`agent.grammar` is a realtime SIBLING, not a lane flip.** The durable interpreter skips
   realtime nodes so exactly one runtime owns a node — flipping `consultation.proposeCorrections`
   would have deleted the note-level pass from both graphs. The input TYPE is the safety property:
   `proposeCorrections.in` is `text` (may review a generated note); `agent.grammar.in` is
   `transcript`, making "the live pass corrects what was SAID, not what the model WROTE" structural.
   Widening it to `text` turns the anti-laundering test RED.

### 14d. A silent live defect, found and fixed

`runGraphLane` projected the flush by raw node type (`o.type === 'consultation.extractEntities'`).
A tenant graph authored against the target catalogue runs `agent.ner` — the node succeeded, the
model was paid for, and the flush published `entities: []` with `nlpRan: false`. Now canonicalised
(`canonicalRealtimeNodeType`), with a test.

### 14e. Reported, not closed

- `workflowPublishProblems` — the ONLY enforcer of `requires[]` — has **no production caller**. A
  tenant publishing through the API is unchecked.
- `agent.presummarization` is seeded **unwired**: the consultation palette has no on-start `context`
  producer, and the registry's only one (`input.context_binding`) is summarization-palette and
  `critical: true`. Documented in the seed rather than papered over with `retrieveEvidence`.
- `port-validation.ts:222` still claims every descriptor declares `requires: []` — stale since Lane A.

## 15. Lane B — visit type is now tenant-configured data (merged 2026-08-29)

§11 row 3 closed. Key `consultation.visitTypes`, a **`global-kv` settings descriptor**
(`maxScope: 'tenant'`, `failMode: 'open-to-default'`, `validate: visitTypeCatalogueProblem`).
Resolution is tenant → SYSTEM via `TenantSettingsService.resolve`, which already implements that
cascade with the max-scope clamp honoured on READ as well as write and the customer tenant
`50000000-…` structurally unable to enter it.

### 15a. Shape question resolved — reading (a), FLAGGED FOR OWNER CONFIRMATION

**Two visit types; the parenthesised terms are ALIASES.** Chosen from consumers, not wording:
`text-proxy.controller.ts` already carried `type VisitType = 'new_visit' | 'referral'` — both of the
owner's "New patient" terms as ONE axis value; `Department` has exactly two visit-type prompt
columns; and **(a) subsumes (b)** — a tenant wanting six types defines six entries, whereas (b)
cannot represent (a) without collapsing the aliases.

**Behaviour delta the owner should confirm:** the old proxy rendered TWO different prompt sentences
(`"This is a new patient visit."` vs `"This is a referral visit."`). Both now render
`"This is a New patient visit."` A test proves a tenant restores the distinction by CONFIGURING a
split catalogue with no code change — the property that made (a) safe. **If (b) was meant, the fix
is a data edit to the shipped default, not a rewrite.**

### 15b. What the orchestrator's scan missed — the load-bearing one

`apps/api/src/modules/streaming/text-proxy.controller.ts:880` (NOT in the compat fence) threw
**400** for anything outside `['new_visit','referral']`. That one line made "tenant-admin defined and
controlled" false **at the front door** — no downstream configurability could have helped. Verified
present at the base commit before the fix.

Also a **third vocabulary**: `summary.service.ts:408` and `pre-summary.processor.ts:190` spelled the
concept `'new-visit'`, not `'new-patient'`. Nine derived sites, three disagreeing spellings.

### 15c. Tier trade-offs, recorded in the descriptor header
No per-entry `_version`/ETag (two admins editing different visit types contend at list level) · no
per-type `AuditLog` row (the audit is the `GlobalSetting` write) · no FK integrity · no
department/doctor scope yet. If any becomes a requirement the key keeps its name and moves to
`db-config` — that is what `targetTier` is for.

**Defaults deliberately NOT seeded.** They ARE `descriptor.default`; a `GlobalSetting` row carrying
the same values would be a second source of one truth, written once at bootstrap and never
re-asserted — the defect TASK-705 removed from `harness.loop.enabled`. A guard test asserts no seed
phase writes the key.

`'pre-summary'` was kept OUT of the taxonomy — it is a prompt PHASE, not a visit type, and the
resolver already derived `resolvedCapability` from the same parameter. The frozen v1-compat route
needed **zero edits**: `text-compat-template.service.ts` declares its own local literal union with no
type import from the resolver, so TASK-815 §2's acceptance criterion holds.

### 15d. Still hardcoded, flagged not fixed
`apps/admin-console/src/features/consultations/api/types.ts:145-156` holds a **fourth** vocabulary
(`VISIT_TYPES = ['new','revisit']` + `visitTypeOf()`) driving a client-side grid filter. The
consultations list API exposes no visit type on the row at all, so making it tenant-aware is a UI
feature with its own design and test surface, not a literal retirement.

## 15e. Lane V — visit type is the PROMPT-COMPOSITION IDENTIFIER (2026-08-29)

Second owner directive, going further than §15 shipped:

> "Visit type is an identifier where the hope platform configure and compose the instructions and
> consultation context as prompt for agent to work on: pre-summarization OR summarization OR any
> text generation task."

### What was actually missing

Lane B made the visit type tenant-configured DATA. It was still a **two-column pointer**:
`promptSlot` answers one question (which of `Department`'s two prompt columns) for one task
(finalize). Consequences, both real:

- a tenant that defined a THIRD visit type had to borrow one of the two slots — it could never
  compose its own prompt;
- the **pre-summary chain had no visit-type axis at all**. `promptType` carries both axes (frozen
  contract §2), so a pre-summary request says `'pre-summary'` and the visit type becomes invisible
  to the resolver. It reached assembly only as the `{visit_type}` VARIABLE — data, never a selector.
  The chain the owner names FIRST was the one that could not use the identifier.

### Where the `(task, visitType)` key went, and why there

**On the catalogue entry** — `VisitTypeDefinition.prompts?: Record<task, { promptTemplateId,
promptVersionNumber?, contextVariables? }>`, resolved by the cascade `consultation.visitTypes`
already has. Rejected alternatives, each for a stated reason:

| Candidate | Why not |
|---|---|
| Workflow node config (`node-*.ts`) | DD-2 gives a generation node NO visit-type axis by design — it binds its prompt statically. A substrate that cannot express the distinction cannot host the key. (Also a sibling lane's file this sprint.) |
| More `Department` columns | Combinatorial in (task × visitType), and a schema fact a tenant cannot extend — the exact limit being removed. |
| `PromptTemplate` tags | The pre-summary tier already resolves by tag convention and its own header calls that a tradeoff with a migration path. Extending the smell, not the machinery. |
| A second settings key | Two rows that can disagree: a binding outliving the visit type it names. On the entry, a binding cannot exist without its visit type. |

The owner's sentence makes the visit type the IDENTIFIER, so the composition hangs off it. One key,
one write lane, one `validate`, one audited value, no migration, no second resolver.

### The tier, in all three chains

`preferred (T0) → (task, visitType) binding → node (T1a) → department column (T1b) → SYSTEM`.

- **Above the node tier** because the node has no visit-type axis (DD-2): a tier that cannot express
  the distinction must not pre-empt the tier that can.
- **Below tier-0** because an individual clinician's explicit template choice outranks a tenant-wide
  default (DR-2).
- Same placement on pre-summary (before the presummarization-node tier, so its fail-closed rule is
  untouched — a miss still reaches it) and on live (fail-open preserved: a miss, an unapproved
  template or a missing snapshot all fall through).

**`resolvedFrom` gains NO new member.** `ResolvedPromptConfig` is reached by a frozen v1-compat wire
route, so its value set is a published contract, and adding one would also drift `openapi.json`, the
portal and the generated `vox-node` admin schema. The tier reports `'tenant'`, which already means
"a tenant-configured template, not the department column and not the SYSTEM default". The pairing is
recorded in `resolutionTrace` (`visitTypeKey` / `visitTypeTask` / `visitTypePromptId`), which is
additive and internal.

### The axis is now stateable

`PromptResolutionParams.visitTypeKey` (and `PromptAssemblyParams.visitTypeKey`) — additive, optional,
a key or any alias. Absent ⇒ derived from `promptType` exactly as before. `PromptAssemblyParams`
keeps `visitType` (the LABEL, filling `{visit_type}`) as a separate field on purpose: collapsing them
would make a tenant's display wording change which prompt is served.

Threaded at the call sites that had no way to state it: both pre-summary sites
(`summary.service.ts`, `pre-summary.processor.ts`), `live-agent-resolution.service.ts` (one
consultation read now yields both axes), and `agentic-instructions.service.ts`. The four summary
sites needed no change — they already put the visit-type key in `promptType`.

### Safety property, tested first

**A tenant that configured no binding resolves byte-identically on all three chains.** The shipped
default carries no `prompts`, so zero tenants change behaviour on merge. That is the first `describe`
block of `prompt-resolution.visit-type-binding.test.ts`, and it passed before the tier existed.

### Labels vs aliases — one fixed, one flagged

The owner named the defaults "New visit/Referral OR Follow-up/Re-visit". Read as alias sets (the
brief's own reading), three of the four already resolved. **`Re-visit` did not** — the key folds to
`revisit` and nothing folded to `re-visit`, so a term the owner used to NAME this default fell
through to the parent-link heuristic. Added as an alias.

**The LABELS were deliberately NOT changed, and this needs an owner answer.** They are "New patient"
/ "Revisit" from §11 row 3, quoted verbatim in the descriptor. Three reasons to leave them: the two
owner statements disagree and the older one states labels explicitly while the newer one lists
slash-separated pairs (alias sets); the label is LLM-visible — it fills `{visit_type}`, and "This is
a New visit visit." is worse copy than the current rendering; and it is a one-line data edit a tenant
admin makes in the console, which is the whole point of the catalogue. **If the owner meant the
labels, it is a data edit to the shipped default, not a code change.**

### Still not fixed — the fourth vocabulary

`apps/admin-console/.../consultations/api/types.ts` (`VISIT_TYPES = ['new','revisit']` +
`visitTypeOf()`) is unchanged, and this lane does not make it expressible. The blocker is not the
catalogue: the consultations LIST DTO exposes no visit type on the row, and
`ConsultationAggregate.totals` hardcodes the same two-valued split SERVER-side (`newVisits` /
`revisits`). Making it tenant-aware means changing both DTOs plus the aggregate query — a route/DTO
change with its own five-artifact regeneration and a UI design surface. Unchanged from §15d.

## 16. Lane V — visit type is now the (task, visitType) prompt identifier (merged 2026-08-29)

Owner directive: *"Visit type is an identifier where the hope platform configure and compose the
instructions and consultation context as prompt for agent to work on: pre-summarization OR
summarization OR any text generation task."*

The key lives **on the catalogue entry**: `VisitTypeDefinition.prompts?: Record<task,
{promptTemplateId, promptVersionNumber?, contextVariables?}>`, resolved by the tenant → SYSTEM
cascade `consultation.visitTypes` already owns. **No new resolver, no new settings key, no
migration.** Alternatives rejected with reasons: workflow node config (DD-2 gives a generation node
no visit-type axis by design — a substrate that cannot express the distinction cannot host the key),
more `Department` columns (combinatorial in task × visitType, and a schema fact a tenant cannot
extend — the exact limit being removed), `PromptTemplate` tags (extends a smell its own header calls
a tradeoff), a second settings key (two rows that can disagree).

### 16a. The load-bearing finding — the first-named chain was the one that could not work
**`promptType` conflated the phase and visit-type axes**, so a pre-summary request said
`'pre-summary'` and the visit type reached assembly only as the `{visit_type}` VARIABLE — data,
never a selector. **Pre-summarization, the first task the owner named, could never see a visit type
at all.** Fixed additively with `PromptResolutionParams.visitTypeKey`; absent, it derives from
`promptType` exactly as before.

`PromptAssemblyParams` deliberately keeps `visitType` (the LABEL, filling `{visit_type}`) separate
from `visitTypeKey` (the SELECTOR). Collapsing them would let a tenant editing display wording
silently change which prompt is served.

Tier placement: `preferred (T0) → (task, visitType) → node (T1a) → department column (T1b) → SYSTEM`,
on all three chains. Above the node because the node has no visit-type axis; below T0 because a
clinician's explicit choice outranks a tenant-wide default. `resolvedFrom` gains **no** new member —
the pairing rides the additive `resolutionTrace`, which also avoids drifting `openapi.json`, the
portal and the generated vox-node schema.

### 16b. The owner's own spelling did not resolve — fixed
`re-visit` (written verbatim in the 2026-08-29 directive) folded to nothing: the key folds to
`revisit` and nothing folded to `re-visit`, so a term naming the default fell through to the
parent-link heuristic. Added as an alias. "New visit", "Referral" and "Follow-up" already resolved.

### 16c. OPEN — labels, owner decision
Labels remain **"New patient" / "Revisit"**, not "New visit" / "Follow-up". Three reasons: the two
owner statements disagree (§11 row 3 names labels explicitly; the 2026-08-29 directive lists
slash-separated pairs that read as ALIAS SETS); the label is **LLM-visible** — it fills
`{visit_type}`, and *"This is a New visit visit."* is worse copy; and it is a **one-line data edit in
the console**, which is the point of the catalogue. **If the owner meant the labels, it is a data
edit to the shipped default, not a code change.**

### 16d. An incidental catch worth more than it sounds
`LiveAgentResolutionServiceModule` never imported `VisitTypeServiceModule` (importing
`PromptResolutionServiceModule` does not re-export the provider), so the `@Optional()` injection
would have silently resolved `undefined` — **every live session reading platform visit types instead
of the tenant's, with no boot error.** That is the failure mode where `@Optional()` converts a
missing import into wrong behaviour rather than a crash. Now guarded by a DI-wiring test.

### 16e. Fourth vocabulary still not expressible, and the reason is sharper
`apps/admin-console/.../consultations/api/types.ts` is unchanged. The blocker is not the catalogue:
the consultations list DTO exposes no visit type on the row AND `ConsultationAggregate.totals`
hardcodes the same two-valued split **server-side** (`newVisits`/`revisits`). Fixing it changes both
DTOs plus the aggregate query — a route/DTO change with its own five-artifact regeneration and a UI
design surface.

## 17. Lane N — important findings and grounding, both as tenant configuration (merged 2026-08-29)

Closes §14a ("important information highlighted — **DOES NOT EXIST**") and §14b (the finalization
chain is not seeded). Registry **49 → 50** (`agent.important_findings`). New checksum
`eb2e97fb7d20a69e958d5f36d9d6ddc957aa7ed97f0682d2007eba3b6ee0baf3`, produced by
`scripts/regen-arcaai-consultation-workflow-seed.ts` and confirmed by
`scripts/regen-workflow-definition-seed.ts` printing `=== DRIFT: 0 ===`. Gates: workflow-contract
1028 · database 1671 · domains 1848 · applications 10457 · api 4046 · harness 1689 · `gen:check`
no-drift ×3 · harness lint + mypy clean · lint 40/40 · openapi/portal/route-manifest/vox-node-admin
all regenerated and drift-free.

### 17a. Neither capability is a heuristic, and the tests say so

The owner's two sentences are configuration statements, so the deliverable is a configuration
contract, not an algorithm. **There is no severity ladder, no red-flag term list, no
critical-value table, no allergy-alert class and no grounding rubric anywhere in the code**, and
that absence is asserted rather than assumed: `important-findings-and-grounding.task815.test.ts`
greps the shipped config schemas for each of those words, and the seed suite greps the two
platform-default prompt bodies for them too. Both capabilities take their instructions from a
BOUND, APPROVED `PromptTemplate`; an unbound one **degrades with a named code and never reaches a
model** (proved by mutation — adding a default fallback turns
`test_an_unbound_instruction_DEGRADES_and_never_falls_back_to_a_default` red).

The two platform defaults are **SYSTEM-tenant** `PromptTemplate` rows (`07-prompt-template.ts`,
`…041`/`…042`). That is the sanctioned tier, not a workaround: `PromptTemplate`/`PromptVersion` are
`SYSTEM_SHARED_READ_MODELS`, so every tenant can resolve them, and a tenant with an opinion binds
its own id on the node instead. Seeding them under the Global CUSTOMER tenant (`50000000-…`) would
have been the cross-tenant leak `00-project-context.md` names; a seed test asserts `tenantId ===
SYSTEM_TENANT_ID` for both.

### 17b. N1 — `agent.important_findings` is REALTIME, and the durable side loses nothing

The owner's bar is findings "popped up and highlighted" *during* the session; an `on-end` durable
node cannot pop anything up while a clinician is still speaking. Realtime is also where the
highlight path already exists — TASK-811's `groundEntitiesToNote` re-anchors transcript-sourced
spans into the rendered note — so findings ride that path rather than growing a second one. The
durable interpreter SKIPS it (`reason: 'realtime_lane'`), so exactly one runtime owns it.

Two shape decisions worth recording:

- **Output primitive `entities`, output KEY `findings`.** The primitive is what buys the existing
  re-anchoring for free; the distinct key is what keeps "the tenant said this matters" apart from
  "the detector saw a drug name". They travel to the client as a separate `findings` array and a
  fourth `SectionAnnotationDto` kind, so a console can render them differently — which is what
  "highlighted" means. `agent.important_findings` is its OWN canonical type (no pipeline
  counterpart), so §14d's alias bug cannot recur here.
- **`requires: []`, deliberately.** The owner says grounding evaluates highlighted findings, but
  `guard.groundedness` is `durable` — a `requires` edge from a realtime node would name a guard
  that cannot run in the lane producing the findings. That is exactly the publish-time-vs-runtime
  drift §13b removed a rule for. The relationship is expressed where it is real: as the guard's
  optional `findings` input port.

Its placement in the seeded graphs was **forced by the rule set, not chosen**: WF-CONS-012 is an
`allPathsPassThrough` check, so a findings branch off capture that rejoined anywhere downstream of
`extractEntities` opens a route around it, and rejoining after synthesis skips the PHI hop
(WF-CONS-009) and synthesis (WF-CONS-010). `capture → findings → entities` is the one shape that
satisfies all three. The cost is that its optional `entities` hint port stays unwired in the seed
(the hints now come from a node that runs after it); the port stays declared for tenant graphs that
order the two differently. Verified end to end: the compiled seed graph yields a realtime lane
`capture → findings(in←capture.out) → entities → realtimeSummary`.

### 17c. N2 — `guard.groundedness` was EXTENDED, not complemented

Three reasons, in order of weight. (1) It already IS the grounding node, and three `agent.*`
generation entries declare `requires: ['guard.groundedness']` — a second grounding node would give
the platform two ways to satisfy one policy, which is the drift `requires`' own docstring warns
about. (2) The owner's sentence changes what grounding is HANDED (three inputs, not one) and where
its rubric comes from; neither is a new capability. (3) A sibling key would sit beside it with no
way for an author to know which one the platform enforces.

The two new inputs (`transcript`, `findings`) are OPTIONAL, so no saved graph is invalidated and
the node keeps `schemaVersion: 1` — the `@N` suffix rule is for ports that MOVE, not ports that
appear. The output side is untouched, so the cross-language `outputKeys` projection did not move
and the parity fixture carries no change for this node. `policies[]` is an array of
`{key, appliesTo, promptTemplateId, promptVersionNumber?, enabled?}`; `appliesTo` draws from
`GROUNDING_POLICY_TARGETS` (`transcript | summary | findings`), which IS the node's own evaluation
inputs rather than an invented clinical vocabulary — a fourth target needs a fourth port first.
**Absent `policies` is a supported state**: the guard then runs its pre-existing pass unchanged,
which is what makes the addition safe for every already-published graph. A policy that could not
run reports `UNEVALUATED` with a reason; it never reads as satisfied.

### 17d. Redaction runs BEFORE grounding — confirming the correction

The owner says grounding evaluates the *redacted* transcript and the *redacted* summary. **Earlier
programme notes had this as "grounding → redaction"; that ordering was wrong and is now inverted
everywhere.** The seeded chain is `n_synth → n_dna (agent.dna_redaction) → n_sensors`, with the
policy-driven `n_ground_note` branching off `n_dna` and rejoining at the verifier (WF-CONS-011
requires every consent→gate route to cross `consultation.sensors`). So every verifier now scores
the REDACTED note. The ordering is also structural in the port lattice: the redactor emits a
`document` the guard consumes, while the guard emits a `verdict` the redactor cannot — proved by
mutation, restoring `n_synth → n_sensors` turns both the Lane N ordering test and TASK-798's
provenance tests red.

`n_ground_note`'s `transcript` and `findings` ports are declared but UNWIRED in the seed, honestly
rather than as an oversight: the palette has no `transcript`-typed producer downstream of the PHI
hop (the engine resolves the transcript server-side from `run_payload`, as `consultation.sensors`
already does), and `agent.important_findings` is realtime, so a durable edge would name a producer
that lane never runs. Same declared-but-unwired state `n_realtime` and `n_presum` have carried
since OD-15.

### 17e. Reported, not closed

- **`consultation.realtimeSummary` receives an EMPTY transcript in graph mode.** Its `in:
  transcript` is unwired in both seeded graphs — deliberately, because `captureBinding →
  realtimeSummary` jumps `extractEntities` and WF-CONS-012 refuses it — and the seed comment says
  the activity "resolves what it needs server-side". The REALTIME handler does not: it passes
  `boundText(ctx, 'in')`, i.e. `''`. Confirmed by inspecting the lane built from the committed
  compiled config (stage 3, `n_realtime <- [n_entities.out->entities]` only). Pre-existing, from
  OD-15/Lane R; fixing it needs either a rule change or a handler fallback, both of which are
  decisions rather than edits.
- **`agent.grammar` is registered but never seeded.** Lane R added the node type, the realtime
  handler and the Python activity, but neither ArcaAI graph contains one, so the live grammar pass
  runs for no tenant today. Not in this lane's scope; noted because §14a records that item as
  "Made to work".
- `port-validation.ts:222` still claims every descriptor declares `requires: []` — stale since
  Lane A, unchanged here.
