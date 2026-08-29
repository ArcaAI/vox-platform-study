# TASK-816 — Legacy Config Retirement

| Field | Value |
|---|---|
| **Status** | **Phase 1 `Completed`** 2026-08-29. **Phases 2–4 BLOCKED on an owner decision — see §0.** |
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

## 0. BLOCKING FINDING — `AiTaskDefault` cannot be dropped

Phase 1 measured the premise behind tasks 3 and 8 ("prove no reader remains", "drop the tables").
**It does not hold.**

Of **17** `AI_TASK_KEYS`, only **3** are reachable from a workflow node's `taskKey`:
`text.live`, `text.finalize`, `text.test`. Verified independently by the orchestrator against the
node config schemas.

The other **14** serve capabilities that are **not workflow nodes at all**:

| Keys | Resolved where |
|---|---|
| `guardrail.groundedness`, `.pii`, `.pii.spans`, `.safety`, `.validate` | inside `apps/guardrail`'s own SQL resolver |
| `nlp.classification`, `.diagnosis`, `.ner`, `.sentiment`, `.toxicity` | inside `apps/nlp` |
| `harness.judge` | an independent SYSTEM-only overlay |
| `vlm.extract` | no node exists |
| `text.live.fallback`, `text.finalize.fallback` | a separate FAIL-OPEN tier a node binding deliberately has no field for |

> **OWNER DECISION, 2026-08-29: option 1.** Recorded from the owner's "Lets go" immediately
> following the orchestrator's recommendation of option 1. `AiTaskDefault` SURVIVES as the selection
> tier for non-node capabilities; only the three node-reachable keys (`text.live`, `text.finalize`,
> `text.test`) are retired onto `llmBinding`. **The ticket's "drop the tables" goal (task 8) is
> therefore WITHDRAWN** for `AiTaskDefault`; it still applies to `HarnessPolicy`/`PipelinePolicy` to
> the extent Phase 2 proves no reader remains. If this reading is wrong, say so — it is one line to
> reverse and nothing has been deleted.

**Owner decision required before Phases 2–4.** Options, none of which this lane took:
1. Keep `AiTaskDefault` as the selection tier for non-node capabilities; retire only the three node-reachable keys. The table survives, narrower.
2. Give the Python services node-carried selection too — a much larger programme than this ticket.
3. Split: `AiTaskDefault` becomes the peer-service tier explicitly, and the ticket's "drop the tables" goal is withdrawn.

Proceeding on the ticket as written would drop rows that `apps/guardrail` and `apps/nlp` still read —
the failure mode the 2026-08-25 outage already demonstrated once.

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

### Phase 1 — `llmBinding` on node config, and AiTaskDefault selection relocated onto it (2026-08-29)

**Status: landed on `lane-816-llmbinding`, pending merge. Nothing was removed.** Every existing
resolution path resolves byte-identically; the successor tier was ADDED above it. That is the whole
discipline of doing this before any drop — see §2a's statement of the hazard.

Registry checksum `eb2e97fb…0baf3` → `21901af1becbe9a9be072bab9eac6a5fe97f13c1de1f370b591c2f8da549b2d4`
(produced by `regen-arcaai-consultation-workflow-seed.ts`; `regen-workflow-definition-seed.ts`
reports `=== DRIFT: 0 ===`). Gates: workflow-contract 1037 · database 1671 · domains 1848 ·
applications 10532 · api 4046 · harness 1708 · harness lint + mypy clean · `gen:check` no-drift ×3 ·
lint 40/40 · openapi/portal/vox-node-admin drift-free.

#### 6a. The ticket's proposed shape was wrong on five of its six fields

§2a sketched `llmBinding: { provider, model, contextLength, maxTokens, temperature,
promptInstruction }`. Read against what `AiTaskDefault` ACTUALLY expresses — exactly
`(taskKey, modelSlug, configJson)` — only one field survives.

| Sketched field | Verdict | Where it already lives |
|---|---|---|
| `provider` | **rejected** | derived from `AiModel.provider` for the bound slug. Authoring it puts an engine name in tenant graph data and bypasses the ENABLED check, the `taskType` match and the `azure → azure-openai` alias, all of which live in one place today |
| `model` | **replaced by `modelSlug`** | a raw model id is a hardcoded literal (`00-project-context.md` §Configuration Principles rule 1). The governed form is a REFERENCE into `AiModel`, resolved `[tenant, SYSTEM]` — which is precisely what an `AiTaskDefault` row's `modelSlug` is |
| `contextLength` | **rejected** | `AiRuntimeProfile.contextLength`, keyed by the very `(tenantId, provider, modelSlug)` this binding selects |
| `maxTokens` / `temperature` | **rejected** | already top-level config keys on every generation schema (`generate.text`, `consultation.synthesize`, the three live-assist nodes) |
| `promptInstruction` | **rejected** | `promptTemplateId` + `promptVersionNumber` (DD-11) — an APPROVED, version-pinned template, not free text on a node |

Four of the five would each create a SECOND source for a value the platform already models — the
"two rows that can disagree" defect TASK-815 §15e rejected a second settings key for. The shipped
shape is a one-field closed object: `llmBinding: { modelSlug }`. It is an OBJECT rather than a bare
key because the binding is the unit that resolves or does not — present means "this node selects
for itself, fail closed"; absent means "resolve the tenant `taskKey` default exactly as today" —
and a bare optional key cannot express that against a config object already carrying a dozen
unrelated optional keys.

**`configJson` has no reader.** `AiTaskDefault.configJson` is echoed into
`EffectiveAiTaskDefaultResponse` and read by nothing in either runtime (verified across TS and all
six Python services). It transfers nothing.

#### 6b. The set is DERIVED, not listed

Membership is "the node's config schema declares `taskKey`" — which IS the marker for "this node's
model is selected per node through the `AiTaskDefault` cascade". Folded in by `withLlmBinding`
beside `withRuntimeProperties`, so the next generation node registered cannot be forgotten. Eleven
node-type keys carry it; the sensor nodes correctly do not (they call `get_policy(tenant_id)` with
NO task key and take their model from the `HarnessPolicy` columns — Phase 2's subject).

**Incidental fix required by that derivation:** `guard.groundedness` reads
`payload.config.get("taskKey")` at `nodes/guards.py:203` but its schema never declared it, and every
schema is `additionalProperties: false` — so the runtime honoured a routing key an admin could not
author. Same two-halves-disagree defect Lane A closed for `timeoutSeconds`/`retry`, in the same
file. Now declared with `_llm_policy.ALLOWED_TASK_KEYS` as its enum and the activity's own
`text.finalize` as its default, so an unauthored node is byte-identical.

#### 6c. One resolver, fail-CLOSED, funding untouched

`IAiTaskDefaultService.resolveModelBySlug` exposes the SAME private `[tenant, SYSTEM]` ENABLED
lookup `getEffective` uses, so there is one model resolution rather than two.
`HarnessPolicyService.resolveBoundNodeSelection` sits above the task tier and **throws** when a
bound slug resolves to nothing or the lookup faults — selection is `failMode: closed`, and falling
through would keep an explicitly-bound node generating on a different model in silence. An ABSENT
binding is a different statement and keeps the existing fall-through.

It deliberately performs no `taskType` compatibility check: that belongs to a WRITE (`upsertRow`),
where a mismatch can be refused with the offending value in hand. A runtime READ that dropped a
bound model for a task-type mismatch would be a fail-OPEN substitution.

**Funding is not stamped and cannot be.** The binding names a MODEL; funding stays derived from
whose `AiProviderConnection` row supplies the CREDENTIAL (`fundingOf`), downstream and unchanged. A
test asserts the resolver returns `{provider, model}` and no third key.

#### 6d. Both runtimes carry it

| Runtime | How |
|---|---|
| Durable interpreter (Python) | `nodes/_shared.py`'s `read_model_slug` (the mirror of TS `readLlmBindingFromConfig`) → `get_policy(..., model_slug=)` → the gateway's `?modelSlug=`. Threaded, never resolved worker-side, so one model resolution serves both runtimes. Wired at all four model-resolving modules: `text_generate`, `consultation_realtime`, `guards`, `agent_catalogue` |
| Realtime lane (TS) | the three generation handlers hand their node `config` to the capability that calls `apps/text`. `proposeCorrections` and `extractFindings` already did; **`generateDocument` did not** — so a binding authored on `consultation.realtimeSummary` had no route to the call at all. `GenerateDocumentInput.config` closes it |

#### 6e. Requirement 3 — per-capability coverage. **`AiTaskDefault` CANNOT be dropped.**

The successor covers the predecessor *for the selections a workflow node makes*, and only those.
Of the 17 `AI_TASK_KEYS`, **three** are reachable from a node's `taskKey`; the other fourteen select
for capabilities that are not workflow nodes, so there is nothing to relocate them onto.

| Capability (`AI_TASK_KEYS`) | Covered by a node `llmBinding`? | Why |
|---|---|---|
| `text.live`, `text.finalize`, `text.test` | **YES** | the only values a generation node's `taskKey` enum admits; per-node selection now expressible |
| `text.live.fallback`, `text.finalize.fallback` | **NO — named gap** | the fallback tier is a SEPARATE `AiTaskDefault` row read fail-OPEN by `resolveTextFallbackSelection` (live at `summary.service.ts:1629`). A node binding has no fallback field, deliberately: adding one would declare a knob no runtime reads. A node that binds its primary still falls back to the TENANT's configured fallback |
| `guardrail.validate/.safety/.groundedness/.pii/.pii.spans` | **NO** | resolved inside `apps/guardrail` by its own SQL resolver (`core/tenant_config.py`), a peer service with no graph. `guardrail.check` the NODE declares `guardrailType`, not a task key |
| `nlp.ner/.classification/.diagnosis/.sentiment/.toxicity` | **NO** | resolved inside `apps/nlp`; SUPER_ADMIN-only, no tenant BYO by owner decision D-4 |
| `harness.judge` | **NO** | SYSTEM-only, resolved by the independent `resolveJudgeSelection` overlay, not by any node |
| `vlm.extract` | **NO** | TEXT's vision capability; no node type exposes it |

**Consequence for Task 3 and Task 8 of this ticket:** "prove no reader remains" and "drop the
tables" cannot be satisfied by relocating onto node bindings alone. Either those fourteen keys keep
`AiTaskDefault`, or each needs its own successor decided separately. That is an owner call, not
something a later phase can quietly assume.

#### 6f. Reported, not closed

- **The two TS LEGACY seams TASK-815 left null are still null.** `FrozenLiveAgentSnapshot.liveLlm`
  (`live-agent-resolution.service.ts:100,171`) and `SummaryJobPayload.agentLlm`
  (`summary.service.ts:679`) both carry comments naming `llmBinding` as their successor. They are
  the NON-graph flush/finalize paths, so this phase left them alone rather than widening scope: the
  wiring needed is `PromptResolutionService` surfacing the resolved node's binding (it already
  selects the node and returns its id as `resolvedAgentId`), plus a `HarnessPolicyService` edge on
  `LiveAgentResolutionService`, which has none today.
- `agent.important_findings` declares `taskKey` with **no enum and no default**, while its activity
  defaults to `text.live` and `resolve_text_selection` rejects anything outside
  `ALLOWED_TASK_KEYS`. Pre-existing looseness; left alone (surgical-change rule), unlike
  `guard.groundedness` whose declaration this phase's derivation actually required.
- An `@ApiQuery` on an INTERNAL route moves none of the five artifacts —
  `/internal/consultation/policy` is outside the documented surface, so `openapi.json`, the portal
  and the generated vox-node admin schema are byte-identical. All three checks were still run.

## 7. Change History
| Date | Change |
|---|---|
| 2026-08-25 | Opened from TASK-806 §7. Carries DD-10, D-23, D-24. |
| 2026-08-29 | **Phase 1 landed** (`lane-816-llmbinding`): `llmBinding` declared as a derivation over the eleven node types that select a model; one fail-closed resolver shared by both runtimes; seeds regenerated by script. §2a's proposed binding shape corrected to a single `modelSlug` (§6a). §6e records that fourteen of seventeen `AI_TASK_KEYS` have no node to relocate onto, so Tasks 3 and 8 need an owner decision before any drop. |

## 6. Phase 1 Implementation Summary (merged 2026-08-29)

**Shipped shape: `llmBinding: { modelSlug }`** — an object, not a bare key, because presence/absence
IS the fail-closed-vs-tenant-default distinction. Five of the six fields §2a sketched were rejected,
each because the value already has a governed home:

| Sketched | Verdict |
|---|---|
| `provider` | **rejected** — derived from `AiModel.provider`; authoring it puts an engine name in tenant data and bypasses the ENABLED check, the `taskType` match and the `azure → azure-openai` alias |
| `model` | → **`modelSlug`** — a raw model id is a hardcoded literal; the governed form is the same `[tenant, SYSTEM]` reference an `AiTaskDefault` row carries |
| `contextLength` | **rejected** — already `AiRuntimeProfile.contextLength`, keyed by the `(provider, modelSlug)` the binding selects |
| `maxTokens` / `temperature` | **rejected** — already top-level on every generation schema |
| `promptInstruction` | **rejected** — already DD-11's approved, version-pinned `PromptTemplate` |

`AiTaskDefault.configJson` was confirmed to have **no reader anywhere** in TS or the six Python services.

**Membership is derived, not listed** — "the schema declares `taskKey`", folded in by `withLlmBinding`
beside Lane A's `withRuntimeProperties`. 11 node types. That surfaced an incidental bug:
`guard.groundedness` reads `config.taskKey` at `guards.py:203` but never declared it, so with
`additionalProperties: false` the runtime honoured a key no admin could author.

**Nothing was removed.** Six "NO binding" tests passed before the feature existed and still pass —
`text.live` still resolves via `AiTaskDefault`, the legacy `HarnessPolicy` cascade still catches a
miss, an unresolvable pair still throws. Both legacy-flush assertions were STRENGTHENED to
`('tenant', 'live', undefined)`, pinning that the flush invents no binding.

Checksum `21901af1becbe9a9be072bab9eac6a5fe97f13c1de1f370b591c2f8da549b2d4`, script-produced;
`regen-workflow-definition-seed.ts` prints `=== DRIFT: 0 ===`.

Gates: workflow-contract 1037 · database 1671 · domains 1848 · applications 10532 · api 4046 ·
harness 1708 · gen:check no-drift ×3 · lint 40/40 · openapi/portal/vox-node-admin drift-free.

### 6f. Reported, not closed
The two TS legacy seams TASK-815 left null (`liveLlm`, `agentLlm`) are still null — the non-graph
flush/finalize paths. Wiring them needs `PromptResolutionService` to surface the node's binding plus
a DI edge `LiveAgentResolutionService` does not have.
