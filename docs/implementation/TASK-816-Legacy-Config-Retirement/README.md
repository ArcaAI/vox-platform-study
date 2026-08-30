# TASK-816 — Legacy Config Retirement

| Field | Value |
|---|---|
| **Status** | **Phases 1–3 `Completed`** 2026-08-30. Phase 3 retired NOTHING — all three screens are already-retired or sole editors of surviving tiers (§8). Only Phase 4 remains, and §7 shrinks it to TWO COLUMNS. |
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

---

## 8. Phase 2 — `HarnessPolicy` / `PipelinePolicy` (lane `lane-816p2-policies`, 2026-08-30)

**Nothing was removed and no table was dropped.** One live clinical defect was closed, D-23 and
D-24 were closed, and the per-capability reader table below is Phase 4's input.

**The registry checksum did NOT move**: `21901af1becbe9a9be072bab9eac6a5fe97f13c1de1f370b591c2f8da549b2d4`,
unchanged. No node type and no node instance was added, so the five-place parity move did not
apply — the "type vs instance" check TASK-821 established. Both seeds still agree; proved by
running the scripts (seed 23 regenerated byte-identically, seed 21 prints `=== DRIFT: 0 ===`).

### 8a. The brief's premise was half wrong — most of this does not belong on node config

The brief said "migrate the semantics onto node config and policy bindings". Audited field by
field, that holds for **one** field group out of twenty-nine, and for the rest the value already
has a governed home or the graph substrate structurally cannot hold it. Same result Phase 1 got
for five of six `llmBinding` fields, and for the same reason.

**`PipelinePolicy` is not legacy config — it IS the `db-config` tier.** Its five toggles carry
registry descriptors (`pipeline.*`) declaring `tier: 'db-config'`, `maxScope`, `failMode`,
`globalOnly`, and `editableBy: 'PipelinePolicy'` — the registry *points at the model as its
editor*. Resolution is DOCTOR → DEPARTMENT → TENANT → SYSTEM → code default, which is exactly
what `09-infrastructure-devops.md` prescribes for non-secret per-tenant config with a scope
cascade. **Four of the five cannot move onto a node at all**, and the precedent says so in its own
words: `dnaRedactionEnabled`'s tenant gate was ALREADY migrated onto `agent.dna_redaction` by
TASK-806 lane A, and `ConfigResolver.resolveEffectiveDnaRedactionEnabled` records why the doctor
half stayed behind — *"it is a clinician's own preference about their own writing style, not
something a tenant admin authors into a graph."* `WorkflowAssignment` cascades department →
tenant → null and has **no doctor tier**, so moving a DOCTOR-scope toggle onto node config would
delete the per-doctor axis outright. **`PipelinePolicy` must not be dropped in Phase 4.**

### 8b. The live defect — four clinical gates silently discarded in graph mode

`HarnessPolicy`'s five threshold columns are the tenant tier of a gate whose platform tier is the
settings registry (`harness.sensor.*`). The LEGACY durable loop threads them onto every
`RunSensorsInput` (`workflows.py:512`). The GRAPH interpreter's `consultation.sensors` node built
its input with **no `thresholds` at all**, so `_platform_thresholds(None)` fell through to the
PLATFORM value and the tenant's four computational gates were discarded.

Only `groundednessThreshold` survived — the INFERENTIAL node reads it
(`consultation_verify.py:154`) — which is what made the loss invisible: one of five worked, so
the feature looked wired. The direction matters clinically: a tenant that TIGHTENED a
fabrication (`entityFaithfulness`) or `numericDose` gate had it LOOSENED back to the platform
default, on the substrate every graph-mode consultation runs on.

Fixed by reading the tier that already exists rather than inventing a third one. A node-authored
threshold would be a THIRD source for one value — the "two rows that can disagree" defect Phase 1
rejected five times and TASK-815 §15e rejected a second settings key for. An unreachable policy
passes `None`, which is precisely the "no tenant opinion" signal `_platform_thresholds` already
understands, so a degraded control plane leaves the clinical gate where it was (CR-14).

### 8c. Field-by-field audit — `HarnessPolicy` (24 columns)

`getEffectivePolicy` overlays `SUPER_ADMIN_ONLY_POLICY_KEYS` from the SYSTEM row **even on a
tenant-owned row**, so 15 of the 24 are SYSTEM-tier in effect: a tenant's stored value is ignored
at read time. Only the 9 marked *tenant* are genuinely tenant-overridable.

| Column(s) | Verdict | Reason |
|---|---|---|
| `entityFaithfulness/coverage/citationPresence/numericDose Threshold` | **MIGRATED (threaded), tenant** | the §8b defect. Now reach the graph sensors node. Platform tier remains `harness.sensor.*` |
| `groundednessThreshold` | keep, tenant | already read by the inferential node; unchanged |
| `safetyProvider`, `safetyModel` | **NO READER — Phase 4 drop candidates** | §8d |
| `textProvider`, `textModel` | keep | superseded by Phase 1's `llmBinding`/`taskKey` overlay, which OVERWRITES them; still the fallback when a node names neither |
| `safetyEnabled`, `phiEnabled`, `phiFailClosed` | **reject** | SYSTEM-only safety switches. Moving them to node config would hand a tenant graph author a super-admin gate — a privilege regression, not a migration |
| `maxRegen`, `gateSlaSeconds`, `gateEscalationSeconds` | **reject**, tenant | LOOP and human-gate budget, not per-node. `gate_workflow.py:202` reads the last two; `consultation.hitlGate` already owns its own `timeoutSeconds` |
| `toolAllowlist` | **reject**, tenant | intersected with `McpServer.tool_allowlist` at the call (`activities.py:1114`) — an egress boundary, not a node knob |
| 7 agentic knobs + `mcpToolsEnabled` | **reject** | SYSTEM-only, loop-level. `warmStartEnabled` is parsed by Python for replay compat and **read only on the TS side** — its own comment forbids a second switch |

### 8d. `safetyProvider` / `safetyModel` — the `configJson` of this model

Persisted, threaded faithfully through entity → factory → mapper → DTO → pydantic, rendered in the
admin console, and read by **nothing that selects a backend**. The safety screen is built from
`settings.guardrail_base_url` alone and `GuardrailClient.analyze` POSTs only
`{text, guardrail_type, request_id}`; `apps/guardrail` resolves its own provider/model tenant-first,
which is the correct home since TASK-735/736 and is exactly why these two have nothing left to do.

They are also the clearest surviving instance of the hardcoded-configuration rule in this schema:
the column defaults are the literal engine `lm-studio` and the literal model id
`granite-guardian-4.1-8b`, mirrored again as pydantic defaults.

Proven, not asserted: `test_policy_dead_fields_task816.py` greps every non-test harness module for
a policy-object read of either field. **Mutation-verified** — adding `policy.safety_provider` to
`consultation_verify.py` turns it red with the offending file:line.

### 8e. Per-capability reader table — **Phase 4's input**

| Capability | Reader remains? | Consequence for Phase 4 |
|---|---|---|
| `PipelinePolicy` — all five toggles | **YES, all five** | **DO NOT DROP.** It is the `db-config` tier itself; `harnessEnabled` routes generation, `dnaStyleEnabled` gates DNA at three boundaries, `autoSummaryEnabled` gates the pipeline |
| `PipelinePolicy.autoNerEnabled` — the BRANCH | reader exists, **branch degenerate** | both arms now call the same `emitPipelineCompleted`; only the log text differs since TASK-732 deleted the legacy NER generator. Near-dead *code*, not a dead column — own ticket |
| `PipelinePolicy.dnaRedactionEnabled` — the WRITE path | **no writer anywhere** | column is the unwired-degrade fallback; the live tenant gate is the `agent.dna_redaction` node. Absent from both response DTOs |
| `HarnessPolicy` — 22 of 24 columns | **YES** | **DO NOT DROP the table.** Thresholds, gate timing, tool allowlist, agentic knobs and the safety/PHI switches all have concrete branches |
| `HarnessPolicy.safetyProvider` / `.safetyModel` | **NO** (grep-gated, mutation-proven) | the only two columns Phase 4 can justify dropping — and they also retire two hardcoded literals |
| `{Harness,Pipeline}PolicyChange` | `.create()` only; `listForTenant` has no caller | WORM logs, now soft-delete-exempt (D-24). Not drop candidates — they are the audit trail |

### 8f. D-23 and D-24 — both closed

- **D-23.** Neither `HarnessPolicyEntityMapper` nor `PipelinePolicyEntityMapper` carried
  `FIELDS_NOT_WRITABLE = ['version']`, though both models are OCC-written. Not exploitable today
  because `Repository.updateWithVersion` strips `version` itself — while its own comment calls that
  *"defense in depth on top of the mapper `$toPersistence` handler"*, i.e. a second layer
  describing itself as second while the first was missing. Added to both, pinned at the mapper
  layer so the guarantee survives a repository change.
- **D-24.** `HarnessPolicyChange` / `PipelinePolicyChange` are the same identity-only WORM shape as
  `WorkflowAssignmentChange` (no `resourceStatus`; UPDATE/DELETE REVOKEd) but were absent from
  `MODELS_WITHOUT_SOFT_DELETE`, so any `findMany`/`count`/`groupBy` would have had
  `resourceStatus: { not: 'DELETED' }` injected and been rejected by Prisma — the
  `AsrPipelineVersion` failure, armed. Dormant only because `listForTenant` has no caller yet.

### 8g. Incidental fix — the `globalOnly` lock had no `AUTH-NOTE:` marker

`05-nestjs-api.md` names *"the `globalOnly` descriptor lock (PipelinePolicy)"* as a canonical
example of the imperative-privilege pattern and requires a standardized `// AUTH-NOTE:` marker at
the route. `PUT admin/harness/pipeline-policy/row` carried none, so the only in-code signpost to a
403 that `@Authorize(['manage','PipelinePolicy'])` understates lived in a different package. Added
at the route, naming `assertGlobalOnlyToggles`, and asserted by a test so deleting the comment
breaks a build rather than silently erasing the signpost. The lock itself is untouched and stays
descriptor-driven (no key list in the service).

### 8h. Reported, not closed

- **`consultation.sensors`'s schema comment is now stale** and contradicts Phase 1's. It says
  *"Neither activity reads `payload.config` beyond the palette-wide error policy"* (still true) but
  frames selection as `AiTaskDefault`'s, while `withLlmBinding`'s comment says the sensor nodes
  *"take their model from the `HarnessPolicy` columns"*. Neither is quite right after §8d: the
  computational pass uses no model at all, and the inferential pass takes its judge from the
  SYSTEM-only `harness.judge` overlay. Left alone under the surgical-change rule.
- **The control-plane platform tier for thresholds is unreachable in practice**, on BOTH lanes.
  `getEffectivePolicy` returns the SYSTEM row or code defaults when a tenant has no row, so
  "policy is set" is always true and `resolve_sensor_thresholds` is only reached on a policy-fetch
  failure. Making it reachable means teaching the effective-policy response to distinguish "the
  tenant has an opinion" from "a row exists" (the `source` field already does, TS-side) — a
  contract change on the internal route, not this phase's edit. The graph lane now matches the
  legacy lane exactly, which is the property this phase owed.
- `HarnessPolicyChangeRepository.listForTenant` / `PipelinePolicyChangeRepository.listForTenant`
  have **no callers anywhere**, so two WORM audit trails are written and never surfaced.

## 9. Change History (continued)
| Date | Change |
|---|---|
| 2026-08-30 | **Phase 2** (`lane-816p2-policies`): closed a live clinical defect — four `HarnessPolicy` thresholds were silently discarded in graph mode. D-23 + D-24 closed; missing `AUTH-NOTE:` added to the `globalOnly` route. Audit rejects node-config migration for 28 of 29 columns with reasons (§8a, §8c); `PipelinePolicy` established as the `db-config` tier itself and NOT a Phase 4 drop candidate. Per-capability reader table at §8e. Registry checksum unchanged; no parity move required. |

## 7. Phase 2 — the audit, and a live clinical defect (merged 2026-08-30)

### 7a. A LIVE DEFECT the ticket was not looking for
`HarnessPolicy`'s five threshold columns are threaded onto every `RunSensorsInput` by the **legacy**
loop (`workflows.py:512`). The **graph** interpreter's `consultation.sensors` node built its input
with **no `thresholds` at all** — orchestrator-verified: zero occurrences at the base commit — so
`_platform_thresholds(None)` fell through to the platform value and **four clinical gates were
discarded**.

**A tenant that TIGHTENED a fabrication or numeric-dose gate had it LOOSENED back to the default**,
on the substrate every graph-mode consultation runs on.

What hid it: **one of the five worked.** `groundednessThreshold` survived because the inferential node
reads it separately, so the feature looked wired. A partial success disguises far better than a total
failure. Fixed by reading the tier that already exists — a node-authored threshold would have been a
THIRD source for one value, the "two rows that can disagree" defect Phase 1 rejected five times.

### 7b. The brief's premise was wrong — `PipelinePolicy` IS the `db-config` tier
"Migrate both models onto node config" holds for **one field group out of twenty-nine**.

`PipelinePolicy`'s five toggles already carry registry descriptors (`pipeline.*`) declaring
`tier: 'db-config'`, `maxScope`, `failMode`, `globalOnly` and `editableBy: 'PipelinePolicy'` — **the
registry points at the model as its editor.** Four of the five **structurally cannot move**:
`WorkflowAssignment` cascades department → tenant → null and has **no doctor tier**, so relocating a
DOCTOR-scope toggle onto a node deletes the per-doctor axis. The precedent proves it —
`dnaRedactionEnabled`'s tenant gate already moved onto `agent.dna_redaction` and the doctor half
stayed behind for exactly this reason.

### 7c. Reader table — Phase 4's input, and it is nearly empty

| Capability | Reader? | Phase 4 |
|---|---|---|
| `PipelinePolicy` — all 5 toggles | **YES** | **do not drop** |
| `HarnessPolicy` — 22 of 24 columns | **YES** | **do not drop** |
| `HarnessPolicy.safetyProvider` / `.safetyModel` | **NO** | the only justified drop — also retires two hardcoded literals (`lm-studio`, `granite-guardian-4.1-8b`) |

The no-reader finding is **mutation-proven**: adding `policy.safety_provider` to a module turns the
grep gate red with the offending file:line.

**Combined with §0, the ticket's "drop the tables" goal is now almost entirely withdrawn.** Phase 1
removed `AiTaskDefault`; Phase 2 removes `PipelinePolicy` and 22 of 24 `HarnessPolicy` columns.
Phase 4 is two columns.

### 7d. Two latent defects closed in passing
- **D-23** — both policy mappers lacked `FIELDS_NOT_WRITABLE = ['version']` despite being OCC-written.
  `updateWithVersion`'s own comment calls its strip *"defense in depth on top of the mapper handler"* —
  a second layer describing itself as second while the first was missing. Orchestrator-verified present
  on both now.
- **D-24** — both WORM change logs were absent from `MODELS_WITHOUT_SOFT_DELETE`; any
  `findMany`/`count` would have been rejected by Prisma. Dormant only because `listForTenant` has no
  caller.
- Incidental: the `globalOnly` lock had no `AUTH-NOTE:` marker despite `05-nestjs-api.md` naming it a
  canonical example requiring one.

**Checksum unchanged** (`21901af1…`) — no node type OR instance moved, so the five-place parity move
did not apply. Proved by script anyway: seed 23 regenerated byte-identically, seed 21 printed
`=== DRIFT: 0 ===`.

Gates: workflow-contract 1037 · database 1730 · domains 1863 · applications 10543 · api 4048 ·
harness 1715 · gen:check no-drift ×3 · lint 40/40.

### 7e. Reported, not closed
The control-plane platform tier for thresholds is unreachable on **both** lanes, because
`getEffectivePolicy` conflates "the tenant has an opinion" with "a row exists". Making it reachable is
a contract change on the internal route, not a Phase 2 edit. Also, both WORM audit trails are written
and never surfaced — `listForTenant` has no callers anywhere.

---

## 8. Phase 3 — the screens: **nothing left to retire** (lane `lane-816p3-screens`, 2026-08-30)

**Verdict: zero of the three screens can be retired.** One was already retired before this lane
opened; the other two are each the ONLY editor for a tier Phases 1 and 2 proved survives. No screen
was deleted, no route was redirected, and no nav entry was removed.

This is the third consecutive phase whose brief was wrong in the same direction. Phase 1 rejected
five of six proposed `llmBinding` fields; Phase 2 rejected node-config migration for 28 of 29 policy
columns; Phase 3 rejects all three retirements. The pattern is consistent and worth naming: **"retire
the legacy authoring screen" kept being read as a consequence of the migration, when the migration
never covered what those screens actually author.**

### 8a. Screen-by-screen

| Screen | What it still authors | Verdict |
|---|---|---|
| `/agents` (tier 30-49) | **nothing — subject deleted.** `DepartmentAgent` was retired by TASK-815 | **already retired**, correctly. No work available |
| `/agentic-policy` (tier 10-19) | 7 agentic loop knobs + `mcpToolsEnabled`, `maxEditReruns`, `maxRegen`, the three safety/PHI kill-switches, the live-doc engine kill-switch, and the `agentic.*` registry keys | **CANNOT be retired** — sole editor of surviving columns |
| `/ai-task-defaults` (tier 10-19) | SYSTEM-tenant rows for `guardrail.validate`, `nlp.ner`, `nlp.classification` | **CANNOT be retired** — sole editor of three of §0's fourteen surviving keys |

**`/agentic-policy`.** Every field in `KNOB_GROUPS` (`components/agentic-knobs.ts`) maps to a column
§8c explicitly marked **reject** — the 7 agentic knobs and `mcpToolsEnabled` ("SYSTEM-only,
loop-level"), `maxRegen` ("LOOP budget, not per-node"), and `safetyEnabled`/`phiEnabled`/
`phiFailClosed` ("moving them to node config would hand a tenant graph author a super-admin gate — a
privilege regression, not a migration"). It authors **none** of the two dead columns
(`safetyProvider`/`safetyModel` live on `/harness/policy`, not here), so there is not even a partial
trim available.

It is also load-bearing for a screen that already deferred to it. `/harness/policy` demoted BOTH its
global-default form and its live-config editor to read-only summaries with `Edit in Agentic policy`
deep links, on the one-authoritative-editor-per-resource rule in `13-nextjs-apps.md`. Retiring
`/agentic-policy` would delete the only editor for 22 surviving `HarnessPolicy` columns **and** strand
two deep links.

**`/ai-task-defaults`.** It edits exactly three task keys, and all three are in §0's fourteen that
have no node to relocate onto. It edits **zero** of the three node-reachable keys
(`text.live`/`text.finalize`/`text.test`) — those are the tenant `/ai-configuration` screen's, which
was never in this phase's scope. So the screen Phase 1 made partially redundant is not one of the
three this phase was pointed at.

### 8b. The brief's `/prompt-studio` chain warning was already stale

The brief flagged that `/prompt-studio` → `/agents?tab=governance` would become a redirect-to-a-
redirect once `/agents` retired. It was fixed when `PromptTemplate` got its own route: the live
target is `/prompt-templates?tab=governance`. Verified across all four `redirect()` pages — every
target resolves to a real screen, and no `NAV_ENTRIES` route is a redirect.

### 8c. What this lane did ship

Nothing that retires anything. Two verification gaps and one stale comment, all inside the three
screens' own surface:

- **The `/agents` redirect target was unpinned.** `retired-route-redirects.test.tsx` exists precisely
  so a typo'd or dropped redirect cannot silently 404 a saved bookmark — and it covered
  `/prompt-studio` and `/pstudio` but not `/agents`, because that page sits in the `(tenant)` group
  while the spec sits in `(global)`. TASK-815 shipped the redirect and pinned nothing. Now pinned.
- **Two structural guards** for the defect class the retirement policy names but nothing enforced:
  a retired route that forwards to another retired route, and a `NAV_ENTRIES` entry pointing at a
  redirect. Both hold today by inspection only — which is exactly the state the `/prompt-studio`
  chain was in before it broke. They matter most in Phase 4, when more routes retire.
- **A stale `nav-config.ts` comment** still named `/agents` as the home of prompt governance, after
  `/agents` itself retired — the authoritative route inventory pointing a reader at a redirect. It
  also carried a mangled `redirect page.:` sentence splice.

All three guards are **mutation-verified**: breaking the `/agents` target, re-creating the
`/prompt-studio` → `/agents` chain, and re-adding `/agents` to `NAV_ENTRIES` each turn exactly one
assertion red with the offending route named.

Gates: admin-console test 2147 (249 files) · typecheck clean · build 88/88 pages · `pnpm lint` 40/40,
and admin-console re-run through `eslint` directly because `turbo run lint` replays cache across
sibling worktrees.

### 8d. Reported, not closed

- **The console's task-key mirror has drifted a THIRD time.**
  `features/ai-task-defaults/api/types.ts` carries 15 of the backend's 17 `AI_TASK_KEYS` — missing
  `guardrail.pii` and `guardrail.pii.spans` (added by TASK-799 R6). `READ_ONLY_TASK_KEYS` is derived
  from that list and drives the tenant "Effective models" table, which iterates the console list and
  `byKey.get()`s the response — so the gateway returns 12 platform-managed rows and the table renders
  **10**, silently dropping both, under a heading that counts 10. The platform's PII model selection
  is invisible in every console surface. The file's own doc comment declares the invariant it is
  violating (*"Keep the two lists in lockstep"*) and records the two prior drifts (3-vs-9, then
  TASK-740 D-2's four keys). Nothing enforces it, which is why it keeps recurring.
  **Not fixed here**: the render surface is `/ai-configuration` (tier 30-49), outside this phase's
  three screens, and whether `guardrail.pii` deserves an *editor* rather than a read-only row is an
  owner call — the backend marks both keys SUPER_ADMIN-only.
- **The `/ai-task-defaults` platform screen has no axe assertion**, while `/agentic-policy` and the
  tenant AI-configuration surfaces do. Not introduced here and not touched here.
- **Phase 3 of this ticket should be closed as "no action possible"** rather than carried. Its two
  live screens are load-bearing editors; the retirement premise did not survive Phases 1 and 2.

### 8e. What was NOT verified

`pnpm --filter @arcaai/admin-console build` proves these screens compile and prerender; it does not
prove they render correctly in a browser. **No runtime pass was done** — a worktree cannot start the
full stack, and the gateway routes these screens depend on were never called. The axe evidence above
is the existing jsdom suite, which is structurally blind to colour-contrast and scroll-focus rules,
so **both themes are unverified at runtime**. Nothing in this lane changes a rendered surface (one
test file, one comment), so that gap is inherited, not introduced.

## 10. Change History (continued)
| Date | Change |
|---|---|
| 2026-08-30 | **Phase 3** (`lane-816p3-screens`): **no screen retired.** `/agents` was already retired by TASK-815; `/agentic-policy` and `/ai-task-defaults` are each the sole editor for tiers §0 and §7c proved survive, so both are hard stops (§8a). Pinned the previously-unpinned `/agents` redirect target and added two mutation-verified structural guards (no redirect chain, no nav entry on a redirect); corrected a stale `nav-config.ts` comment naming the retired `/agents`. Third console task-key drift reported at §8d, not closed. |
