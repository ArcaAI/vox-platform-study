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
- [ ] Eval gate still fires from node config; `GoldenSet`/`GoldenCase`/`EvalRun` untouched; enable/disable works
- [ ] `PromptResolutionService.resolve()` contract unchanged; compat untouched
- [ ] `AgentPromotion` rewritten; new CASL subject; scopes repointed
- [ ] Eval gate retired deliberately and tested
- [ ] No survivor from §5 deleted
- [ ] Enum parity green; allow-list sizes updated

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

## 10. Implementation Summary
_Not started._

## 11. Change History
| Date | Change |
|---|---|
| 2026-08-25 | Opened from TASK-806 §7. Carries OD-10, OD-11, OD-12. |
| 2026-08-25 | **OD-11 revised — unblocked.** Eval gate survives; `goldenSetId` binds to the node; tenant-admin enable/disable added. Full DELETE/EDIT/COUPLING inventory inlined (§5a) so the ticket is self-contained. |

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

| 2026-08-29 | Merged and closed. Gates on merged `dev-2.2`: database 1641, domains 1848, applications 10303, api 4019, admin-console 2130 (two consecutive clean runs after a load flake in the first sweep), harness 1668, gen:check no drift x3 + schema coverage OK, gen:admin/portal/openapi no drift (52 areas, 404 routes, 371 schemas; admin 608 ops), lint 40/40. Orchestrator independently verified both hard invariants and rebuilt domains+applications before trusting any artifact (stale-dist trap). |
