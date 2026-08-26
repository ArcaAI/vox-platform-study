# TASK-816 — Legacy Config Retirement

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `refactor` |
| **Branch** | `dev-2.2` |
| **Architecture** | <https://claude.ai/code/artifact/b6b68b73-3cb9-4cec-89f3-8afd1553c13b> |
| **Master** | [TASK-806](../TASK-806-Consultation-Workflow-Substrate-Unification/README.md) |
| **Depends on** | **TASK-815 (hard) — last in the programme** |
| **Agent** | `general-purpose` · `opus` · effort `high` · **worktree** |
| **Review lens** | + `database-admin` (migration) |

> **Sequencing is not a preference.** The live loop resolves its model through `AiTaskDefault` via
> `resolveTextSelection(tenantId,'live')`. Dropping those rows before the graph carries selection
> re-breaks generation **exactly** as the 2026-08-25 outage did.

## 1. Requirement Analysis & Scope

### In scope
- Migrate `AiTaskDefault` semantics onto per-node `llmBinding` (**DD-10**).
- Migrate `HarnessPolicy` / `PipelinePolicy` semantics onto node config + policy bindings.
- Retire `/agentic-policy`, `/ai-task-defaults`, `/agents` authoring; one-release `redirect()` pages.
- Drop the tables once no reader remains.

### Out of scope — the compat fence (owner: "Do NOT touch the compat things")

Reproduced in full so this ticket is self-contained. **Do not read, edit, refactor, rename, or
"tidy" anything below.** If a change appears to require touching one of these, make it **additively**
instead and report the constraint rather than editing.

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


## 2. Preconditions
1. TASK-815 complete — `DepartmentAgent` gone.
2. Every node that needs a model carries an `llmBinding` resolving tenant → SYSTEM.
3. A migration path exists for tenants holding real `AiTaskDefault` rows.


## 2a. Findings this ticket closes

| # | Finding | Evidence |
|---|---|---|
| **D-23** | `HarnessPolicyEntityMapper` and `PipelinePolicyEntityMapper` carry **no** `FIELDS_NOT_WRITABLE = ['version']` despite both models being OCC-written — a direct violation of `03-domain-layer.md`. Not a live bug today because `Repository.updateWithVersion()` strips `version` defensively (`packages/domains/src/common/repository.ts:216-219`), but the mandated mapper layer is absent | mapper files; `harness-policy.service.ts:705`, `pipeline-policy.service.ts:206,338` |
| **D-24** | `HarnessPolicyChange` / `PipelinePolicyChange` are identity-only WORM tables (same shape as `WorkflowAssignmentChange`) but neither is listed in `MODELS_WITHOUT_SOFT_DELETE`, while `WorkflowAssignmentChange` is (`client.ts:203`) | `packages/database/src/client.ts` |
| **DD-10** | LLM binding is per node — `AiTaskDefault` semantics **relocate** onto node `llmBinding`, they are not simply deleted | design decision |

**The sequencing hazard, stated precisely:** the live loop resolves its model through
`resolveTextSelection(tenantId, 'live')` → `AiTaskDefault`. On 2026-08-25 an unrelated change
removed a credential source and produced a silent, total generation outage. Dropping `AiTaskDefault`
before node `llmBinding` carries selection reproduces that class of failure exactly.

**Target `llmBinding` shape** (per node, resolved tenant → SYSTEM, funding derived from the
supplying row — never stamped at the call site):

```
llmBinding: { provider, model, contextLength, maxTokens, temperature, promptInstruction }
```

## 3. Tasks

| # | Task | Test first |
|---|---|---|
| 1 | Node `llmBinding` resolves tenant → SYSTEM, funding derived from the supplying row | resolver tests |
| 2 | Backfill existing `AiTaskDefault` rows onto node bindings | migration test |
| 3 | Prove no reader remains (`resolveTextSelection` and friends) | grep-gate test |
| 4 | Retire `HarnessPolicy`/`PipelinePolicy` semantics onto node config | service tests |
| 5 | **D-23** — while touching them: `HarnessPolicyEntityMapper`/`PipelinePolicyEntityMapper` carry no `FIELDS_NOT_WRITABLE=['version']` despite being OCC-written. Fix or delete with the models; do not leave the violation behind | mapper test |
| 6 | **D-24** — `HarnessPolicyChange`/`PipelinePolicyChange` absent from `MODELS_WITHOUT_SOFT_DELETE` | allow-list test |
| 7 | `redirect()` pages for retired routes, with a comment naming the release that deletes them | route tests |
| 8 | Drop tables; allow-list + enum parity updates | migration + parity tests |
| 9 | Regenerate the five artifacts | `gen:admin:check` |

## 4. Verification
```bash
pnpm --filter @arcaai/database test
pnpm --filter @arcaai/domains build test
pnpm --filter @arcaai/applications build test
pnpm --filter @arcaai/admin-console build lint test
pnpm --filter @arcaai/vox-node gen:admin:check
pnpm verify
```
**Plus a live generation check** on `hope-v2-dev` after the drop — the failure mode this ticket
guards against is silent.

## 5. Definition of Done
- [ ] No reader of `AiTaskDefault` remains before the drop
- [ ] Live generation verified after the drop
- [ ] D-23 and D-24 closed
- [ ] Retired routes redirect for one release

## Best Practices — apply to every task here

- **Sequencing is the whole risk.** The live loop resolves its model through `AiTaskDefault` via
  `resolveTextSelection(tenantId,'live')`. Dropping rows before the graph carries selection
  re-breaks generation exactly as the 2026-08-25 outage did.
- **Prove no reader remains before the drop** — a grep-gate test, not a manual check.
- **Resolution is always tenant → platform default.** Widen to SYSTEM only on ABSENCE. A resolver
  that reads SYSTEM unconditionally is a bug.
- **`50000000-…` ("Global") is a CUSTOMER tenant, never a fallback tier.** A "default tenant" knob
  pointing at it serves one customer's config to everyone else.
- **Funding is derived, never stamped** — from `row.tenantId === SYSTEM_TENANT_ID`.
- **Never put a credential in a DB column in plaintext.**
- **Verify live after the drop.** This ticket's failure mode is silent.

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

**Ticket:** TASK-816 · **Branch:** `dev-2.2` · **Tree:** worktree `../hope-v2-task-816` off `dev-2.2`
**Agent:** `general-purpose` · **Model:** `opus` · **Effort:** `high`
**Review lens:** + `database-admin` (migration).

**DO NOT START** until TASK-815 has landed. This is last in the programme by design.

**Per-task tiers:** the backfill and the no-reader proof are the deciding stages (`opus`); the
`redirect()` pages and DTO cleanup are `sonnet`-grade.

**You own:** `AiTaskDefault`/`HarnessPolicy`/`PipelinePolicy` retirement, the node `llmBinding`
resolution path, and the retired authoring routes.
**You must not touch:** the compat fence.
**Return contract:** `BACKFILL` (rows migrated), `NO_READER` (grep-gate test pasted), `DEFECTS`
(D-23, D-24 closed), `MIGRATION`, `LIVE_CHECK` (generation verified on dev after the drop).

**Rules to read before starting:** `.claude/rules/` files 00, 01, 02, 03, 04, 09. A subagent inherits NONE of the orchestrator's context — read them.

## 6. Implementation Summary
_Not started._

## 7. Change History
| Date | Change |
|---|---|
| 2026-08-25 | Opened from TASK-806 §7. Carries DD-10, D-23, D-24. |
