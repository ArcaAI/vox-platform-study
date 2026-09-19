# TASK-947 — Composable agent instructions: conditional prompt fragments for TEXT_GENERATION agents

**Status:** Completed — owner confirmed 2026-09-10. Every lane, fix and artifact merged into `dev-2.2` (`8818de526` is the last code merge), gates green (§5.3), reviewers R1/R2 acted on. Not proven live: the realtime and durable lanes (unit + parity evidence only)
**Type:** feature
**Opened:** 2026-09-10
**Requested by:** owner, 2026-09-10 — "tenant admin … build the text-generation/summarization agents with conditional logic for selecting and combining prompt/instruction templates and context variables to have the final instruction prompt with context details at runtime"; option C chosen over A (graph-only) and B (grammar conditionals)
**Branch:** target `dev-2.2`; one worktree per lane, branched from `dev-2.2` at the commit that carries the contract (Lane 0)
**Related:** TASK-863 (Agent), TASK-884 (tag-selected assignment, portability bundle), TASK-890 (one grammar, `compiledConfig` freeze, render scope), TASK-930 (invocation plane), TASK-943 (`trigger` root), TASK-946 (in flight — owns files this ticket must also change; see §2.4)
**Rules:** `00`, `01`, `03`, `04`, `05`, `06`, `07`, `10`, `11`, `13`, `14`

## 1. Requirement Analysis

The owner's four-part capability statement, checked against the code on 2026-09-10:

| # | Capability | State |
|---|---|---|
| 1 | Tenant admin declares the consultation context schema | Shipped — `ConsultationContextSchema` + versions + pin; `GET /tenants/me/context-schema` |
| 2 | Tenant developers generate types from it | Shipped — `@arcaai/vox-codegen --tenant` (JWT or service account), `--api-key --agents --workflows` for the published surface |
| 3 | Tenant admin authors prompt templates with context-variable templating | Shipped — `PromptTemplate`/`PromptVersion`, typed variable declarations, the one grammar `{{ path \| default("…") }}`, publish-time cross-check against the bound context schema |
| 4 | An agent applies **conditional logic to select and combine** templates + variables into the final prompt at runtime | **Missing.** An agent binds exactly ONE template (or one inline prompt). The grammar has no branch. Conditional logic exists only at the workflow graph (`core.condition`, `core.classify`) and as a per-request agent SWITCH (tag-qualified `AgentAssignment`) |

### 1.1 What this ticket delivers

A TEXT_GENERATION agent's `instruction` may carry an **ordered list of prompt fragments**, each a
template reference or an inline body, each with an optional CEL `when` condition evaluated over the
SAME scope the prompt renders against (`context.*` / `trigger.*` / `input.*` / `vars.*` /
`nodes.*` / bound variable names). At publish every fragment's content is frozen into
`compiledConfig` exactly as the single template is today. At run time the renderer selects the
fragments whose condition holds, renders each through the one grammar, and joins them. The four
renderers (invocation route, draft bench, realtime `core.agent` lane, durable Temporal lane)
produce byte-identical prompts, proven by a committed cross-language fixture.

### 1.2 Out of scope (recorded so it is not re-litigated mid-lane)

- Conditional blocks INSIDE the template grammar (`{{#if}}`) — option B; a fragment IS the block.
- Computed variable bindings (`instruction.variables.x = { expr: "…" }`) — a follow-up (§7).
- An authorable joiner between fragments — fixed `"\n\n"` in this release (OD-6).
- Changing the tag-selected prompt tier from "pointer to a template" into "the agent's compiled prompt" — an owner decision on a clinical path (OD-9 records the minimal choice).
- A Prisma migration — `instruction` and `compiledConfig` are JSONB; no schema change.
- Demonstration composite agents in the seeds — follow-up (§7).

## 2. Current State Evaluation

### 2.1 The single-template contract, as it stands

| Fact | Where |
|---|---|
| `instruction` is `oneOf(promptTemplateId, systemPrompt)`, enforced by `textGenerationInstructionProblems` | `packages/workflow-contract/src/agent-schemas.ts:644-655`, `:1005` |
| `instruction.variables[name]` is `{ value }` or `{ path }` — no expression | `agent-schemas.ts:609-641`; resolver `packages/applications/src/services/agent/agent-prompt-scope.ts:96` |
| Publish resolves the ONE template (APPROVED; pin `?? approvedVersionNumber ?? currentVersionNumber`) and freezes its bytes as `compiledConfig.resolvedPrompt: { source: 'template' \| 'inline', content, … }` | `agent.service.ts:1951` (`resolvePrompt`), `:2060` (`compile`); type `packages/types/src/agent.ts:127` |
| Publish cross-checks `{{…}}` references against `context`/`trigger` (bound schema), `input` (own `inputSchema`) and bare bound names | `agent.service.ts:1667` (`promptTemplateFindings`) |
| The grammar: `placeholder := "{{" path ("\|" default("…"))? "}}"`, one pass, single brace literal | `packages/workflow-contract/src/template.ts` + `apps/harness/…/templating.py`, fixture `tests/contracts/prompt-template.fixture.json` |
| The CEL evaluator is TOTAL (`{ value } \| { error }`), has `has(a.b)` as the missing-key guard, `in` over maps, ternary | `packages/workflow-contract/src/expressions.ts:645-663`, mirror `expressions.py:629-643`, fixture `packages/workflow-contract/src/__tests__/fixtures/expressions.fixture.json` |

### 2.2 Every reader of the instruction / resolved-prompt shape (the change surface)

**TypeScript — renders the prompt**

| Reader | Line | Lane |
|---|---|---|
| `AgentInvocationService.invokeText` — `compiled.resolvedPrompt.content` over `buildAgentPromptScope` | `agent-invocation.service.ts:160` | A |
| `AgentService.testDraft` — the bench, same render, `assembledSystemPrompt` | `agent.service.ts:572` | A |
| `LiveDocumentationService.callTextCandidate` → `renderLivePrompt` — `candidate.resolvedPrompt?.content ?? instruction.systemPrompt` | `live-documentation.service.ts:5087`, `:289` | B |
| `ResolvedTextCandidate.resolvedPrompt` — passes the compiled value through | `text-generation-spec.ts:38,160` | A (type only) |

**TypeScript — reads `instruction.promptTemplateId` as a REFERENCE**

| Reader | Line | Lane |
|---|---|---|
| `AgentService.resolvePrompt` / `promptTemplateFindings` / `collectFindings` (`declaredVariables`) | `agent.service.ts:1951`, `:1667`, `:1641` | A |
| `referenceInstruction` (clone re-points at the tenant's clone), `loadBoundTemplate`, `assertPortableAcrossTenants`, `newVersion` cross-tenant pin drop | `agent.service.ts:940`, `:1204`, `:1274`, `:1376` | A |
| `agent-bundle.ts` — export rewrites id → `promptTemplateRef`, import resolves back | `agent-bundle.ts:97`, `:137` | A |
| `AgentPromoteToSystemService` — Global-owned template deep-copied into SYSTEM and re-bound | `agent-promote-to-system.service.ts:384-459` | A |
| `PromptResolutionService.resolveTagSelectedPrompt` — the agent as a POINTER to a template (re-reads the template, bypasses the freeze) | `prompt-resolution.service.ts:709` | B |
| Seed `26-tenant-reference-set.ts` — re-points the SYSTEM agent's template at the tenant clone | `26-tenant-reference-set.ts:225-237` | orchestrator |
| `agentPromotion.service.ts:478` | graph NODE config, not an agent instruction — untouched | — |
| `eval-promotion-gate.service.ts:31`, `text_generate.py:83`, `agent_catalogue.py:309`, `consultation_realtime.py:462` | graph NODE config — untouched | — |

**Python — durable lane**

| Reader | Line | Lane |
|---|---|---|
| `ResolvedPrompt` pydantic mirror: `source: Literal["template","inline"]`, `content: str` (required) | `interpreter/models.py:484` | C |
| `ResolvedAgent._lift_compiled_config` lifts `resolvedPrompt` | `models.py:556` | C |
| `_system_prompt` — first non-empty of `resolved_prompt.content`, `instruction.systemPrompt`, … then `render_template` over `_prompt_scope` | `nodes/core.py:708-752` | C |
| `_text_fallback.py` candidate carries `resolvedPrompt` by alias | `_text_fallback.py:76,159` | C |

**Console**

| Reader | Lane |
|---|---|
| `instruction-binding-form.tsx` (template + pin + bindings + context schema), `create-agent-wizard.tsx` (`instructionMode: 'template' \| 'inline'`), `agent-detail.tsx:117` (`instructionToBinding`), `draft-test-panel.tsx:131` (renders `assembledSystemPrompt`), `api/types.ts:58` (`TemplateInstruction`) | D |

**Generated / documented**

`packages/vox-node/src/resources/admin/schemas.ts:1221` carries the DTO description string verbatim
(`instruction?: Record<string, unknown>`); `create-agent.request.ts:63` is its source. The type does
not change; the description does, so the five API artifacts are regenerated (orchestrator, last).

### 2.3 What already exists that this design reuses rather than re-invents

- `buildAgentPromptScope` / `_prompt_scope` — the ONE scope; a `when` evaluates against exactly this object.
- `evaluateCondition` / `evaluate_condition` — total, boolean-only, fixture-pinned.
- `expressionProblems` + `expressionRootIdentifiers` — the publish-time syntax and root checks `core.condition` already gets.
- `KEY_PATTERN` (`^[a-z0-9_]{2,48}$`) — the branch-handle grammar, reused for fragment keys.
- The additive-optional `compiledConfig` discipline (`guardrail`, `contextSchema`, `wireModelId`) — a new key is read when present and every artifact published before this ticket keeps working.

### 2.4 TASK-946 is in flight on the same files

`git worktree list` (2026-09-10): six `task-946/*` worktrees at `eec2daa1f`, three with
uncommitted edits in files this ticket must change —

| TASK-946 lane | Uncommitted in | Overlaps this ticket's |
|---|---|---|
| T (`task-946/live`) | `live-documentation.service.ts`, `realtime/realtime-executor.ts`, `realtime/realtime-lane.ts`; owns `prompt-resolution.service.ts` (OD-5 rewires tier 1a to read `instruction.promptTemplateId` off the per-turn `core.agent` node's agent) | Lane B |
| H (`task-946/harness`) | `interpreter/workflow.py` + tests; owns `apps/harness/**` | Lane C |
| K (`task-946/sdk`) | `route-manifest.json`, `consultation.controller.ts`, `packages/vox-node/README.md`; owns the five artifacts | final regeneration |

Rule 14 §3: two tasks touching one file are one task, run sequentially. Lanes B and C therefore
branch from `dev-2.2` **after** TASK-946 T and H have merged into it, and the artifact regeneration
runs after K. Lanes 0, A and D have no overlap and start now.

## 3. Decisions for the owner (recommended value first; alternatives named)

| OD | Question | Recommended | Alternatives | Why |
|---|---|---|---|---|
| **OD-1** | Ticket number | `TASK-947` (highest on disk: 946) | — | Rule 00 §Ticket Workflow |
| **OD-2** | Instruction shape | A third, mutually exclusive form: `{ fragments: Fragment[], variables?, evalGate? }` where `Fragment = { key, promptTemplateId \| systemPrompt (exactly one), promptVersionNumber?, when? }`; 1–16 fragments; `key` matches `KEY_PATTERN`, unique in the list; `when` is a CEL string ≤ 2,000 chars, absent ⇒ always included. Forms 1 and 2 stay valid and are NOT rewritten | (a) allow `promptTemplateId` AND `fragments` together as "base + additions" | Three disjoint forms keep `oneOf` reasoning simple for every reader; a base fragment with no `when` expresses (a) without a second shape |
| **OD-3** | Compiled shape | `compiledConfig.resolvedPrompt = { source: 'composite', content: <static projection>, join: "\n\n", fragments: [{ key, source: 'template' \| 'inline', promptTemplateId?, promptVersionNumber?, content, when: string \| null }] }`. `content` is the unconditional fragments joined — a reader that predates this ticket renders the base prompt; the Python `Literal` is widened in the same release train | (a) `resolvedPrompt: null` + new `composition` key; (b) refuse to publish a composite agent until every worker is upgraded | Every existing reader does `resolvedPrompt.content`; (a) makes an old worker silently run the agent with NO system prompt, which is worse than the base prompt. An old Python worker fails the `Literal` loudly (DEGRADED, named) — the house posture over a silent substitution. Images promote together by digest, so the mixed window is nil in the GitOps flow |
| **OD-4** | Selection scope for `when` | The render scope itself (`buildAgentPromptScope` / `_prompt_scope`): roots `context`, `trigger`, `input`, `vars`, `nodes`, `variables`, plus the bare bound names. Declared for the publish-time root check as `AGENT_CONDITION_ROOTS` | (a) `EXPRESSION_CONTEXT_ROOTS` only (`trigger`/`vars`/`nodes`) | An agent must be able to branch on `context.*` and `input.*` — the two roots a standalone invocation actually has. One object for both the condition and the render is what keeps "what the condition saw" and "what the prompt saw" the same |
| **OD-5** | Condition that cannot evaluate at run time (missing key, type mismatch) | The fragment is **excluded**, named in the result (`excluded: [{ key, reason: 'condition_error', detail }]`), never fatal — the `core.condition` posture (`{ taken: false, error }`). Authors guard with `has(context.visit_type) && …`. Publish WARNS when a `when` references a root/name outside the declared set (the `PROMPT_VARIABLE_UNDECLARED` severity) | (a) fatal: 400 on invocation, DEGRADED on the durable lane, `LivePromptUnresolvedError` on the live lane — the unresolved-variable posture | A missing branch input is "this encounter has no opinion", not a broken prompt; making it fatal turns every new-visit consultation into a failure the moment an author writes a revisit condition without `has()`. The exclusion is visible in the bench, the invocation response and the trajectory |
| **OD-6** | Empty composition | Publish **ERROR** `PROMPT_COMPOSITION_NO_BASE` unless at least one fragment has no `when`. Run time still defends: zero selected ⇒ `PROMPT_COMPOSITION_EMPTY` (400 / DEGRADED / live error), unreachable when publish enforced the base | (a) allow all-conditional lists; fail closed at run time only | A required base makes the runtime outcome deterministic and the failure authoring-time. The static projection (OD-3) is then never empty either |
| **OD-7** | Joiner | Fixed `"\n\n"`, stamped as `join` in the compiled shape so a later release can make it authorable without a compiled-shape change | (a) per-fragment `separator` | One canonical value is what the fixture can pin; a per-fragment separator is an authoring surface with no demand yet |
| **OD-8** | Variables across fragments | `instruction.variables` stays ONE agent-level map. Publish computes the union of the template fragments' declarations; a required, undefaulted, unbound variable is the existing finding; the same name declared with different `type` in two fragments is **ERROR** `PROMPT_VARIABLE_CONFLICT`. `declaredVariables` (fed to the graph publish check) becomes that union | (a) per-fragment bindings | The scope is one object; two binding maps for one render would let `{{age}}` mean two things in one prompt |
| **OD-9** | The tag-selected prompt tier (`resolveTagSelectedPrompt`) and TASK-946 OD-5's tier 1a, both of which read `instruction.promptTemplateId` | Both read `primaryTemplateId(instruction)` from the shared helper: form 1 ⇒ the bound id; form 3 ⇒ the FIRST unconditional TEMPLATE fragment's id; none ⇒ the tier falls through. Pointer semantics preserved; the frozen v1-compat `resolvedFrom` contract untouched | (a) serve the agent's compiled composition rendered against the consultation scope (also closes the freeze bypass noted 2026-09-10) | (a) changes what a clinical path serves and deserves its own decision with a live proof; this ticket keeps the tier's meaning and only teaches it the new shape |
| **OD-10** | Portability, clone, promotion, reference-set re-pointing | One pure helper in `@arcaai/workflow-contract` (`agent-instruction.ts`: `boundTemplateRefs`, `primaryTemplateId`, `mapBoundTemplateRefs`, `isCompositeInstruction`) and every site in §2.2 uses it. Bundle export rewrites EVERY template fragment to a `promptTemplateRef`; import resolves each; cross-tenant pin drop and the `evalGate` strip unchanged; `assertPortableAcrossTenants` requires every template fragment SYSTEM-owned; promotion deep-copies each Global-owned fragment template | (a) each of the seven sites re-implements the traversal | Seven hand-rolled traversals is how one of them forgets a fragment |
| **OD-11** | Evidence of what was selected | `AgentTestAckResponse.composition?: { selected: string[], excluded: [{ key, reason, detail? }] }`; the invocation result and the live stats carry `promptFragments: { selected: string[] }`; the durable trajectory record carries the same. **Keys only — never a condition string or a fragment body** | — | The bench must show an author which branch ran; telemetry must not carry PHI-bearing strings (R2 checks this) |
| **OD-12** | Console authoring | `instructionMode` gains `fragments`: an ordered list (add / remove / move up / move down — single-pointer, WCAG 2.5.7), each row = key, template-or-inline, version pin, `when` with the root list and a `has()` example as help text; ONE "Variable bindings" fieldset over the union of declarations; the draft panel shows selected / excluded fragments | (a) JSON-only editing via `CodeEditor` | Option (a) is the fallback if Lane D's budget runs out; the row editor is the deliverable |
| **OD-13** | Sequencing against TASK-946 | Two waves (§2.4): Lane 0 + A + D now; B + C after TASK-946 T/H merge; artifacts after K | (a) fork TASK-946's worktrees | Rule 14 §3 — one writer per file. (a) is the same thing with a merge conflict attached |
| **OD-14** | Model / effort tiers (rule 14 §1) | Lane 0 opus (orchestrator, inline); A opus high; B opus high; C opus high; D sonnet high, escalate on evidence; seed re-pointing inline; reviewers R1/R3 opus high, R2 opus xhigh | — | Every lane whose verdict the plan acts on (contract, the three renderers, parity) is opus; the console is standard multi-file React with an exact JSON contract, which is sonnet's row of the table |

## 4. Implementation Plan

### 4.1 The contract (normative — every lane implements exactly this)

**Instruction (authored):**

```jsonc
{
  "fragments": [
    { "key": "base",    "promptTemplateId": "<id>", "promptVersionNumber": 3 },
    { "key": "revisit", "promptTemplateId": "<id>", "when": "has(context.visit_type) && context.visit_type == 'revisit'" },
    { "key": "peds",    "systemPrompt": "The patient is a minor …", "when": "has(context.patient_age) && context.patient_age < 18" }
  ],
  "variables": { "language": { "path": "context.language" } },
  "evalGate": { "goldenSetId": "…", "enabled": true }
}
```

**Compiled (`compiledConfig.resolvedPrompt`, stamped at publish, never from a DTO):**

```jsonc
{ "source": "composite", "join": "\n\n",
  "content": "<base content>",                                   // static projection: unconditional fragments joined
  "fragments": [
    { "key": "base",    "source": "template", "promptTemplateId": "<id>", "promptVersionNumber": 3, "content": "…", "when": null },
    { "key": "revisit", "source": "template", "promptTemplateId": "<id>", "promptVersionNumber": 5, "content": "…", "when": "has(context.visit_type) && …" },
    { "key": "peds",    "source": "inline",   "content": "…", "when": "has(context.patient_age) && …" }
  ] }
```

**Selection + render (`composePrompt` in TS, `compose_prompt` in Python — pure, fixture-pinned):**

```
scope := buildAgentPromptScope(...)                  // the ONE scope; built BEFORE any condition
if resolvedPrompt.source != 'composite': return { prompt: renderTemplate(content, scope), selected: [], excluded: [] }
for f in fragments (authored order):
  if f.when == null                      → include
  else r := evaluateCondition(f.when, scope)
       r.error   → excluded += { key, reason: 'condition_error', detail: r.error }
       !r.taken  → excluded += { key, reason: 'condition_false' }
       r.taken   → include
if selected is empty → raise PromptCompositionEmpty (defensive; publish enforced a base)
parts := selected.map(f → renderTemplate(f.content, scope, { templateRef: `agent:<slug>#<key>` }))   // one pass PER fragment
return { prompt: parts.join(join), selected: keys, excluded }
```

**Publish findings (codes added to `agent-findings.ts` by Lane 0; emitted by Lane A):**
`PROMPT_FRAGMENT_SHAPE` (ERROR — not exactly one of template/inline, bad/duplicate key, >16),
`PROMPT_FRAGMENT_CONDITION_SYNTAX` (ERROR — `expressionProblems`), `PROMPT_FRAGMENT_CONDITION_ROOT`
(WARNING — `expressionRootIdentifiers` ⊄ `AGENT_CONDITION_ROOTS` ∪ bound names),
`PROMPT_COMPOSITION_NO_BASE` (ERROR), `PROMPT_VARIABLE_CONFLICT` (ERROR); the existing
`TEMPLATE_NOT_FOUND` / `TEMPLATE_NOT_APPROVED` / `TEMPLATE_VERSION_NOT_FOUND` /
`PROMPT_TEMPLATE_SYNTAX` / `PROMPT_VARIABLE_UNDECLARED` are emitted per fragment with path
`instruction.fragments[i].…`.

**Fixture:** `tests/contracts/prompt-composition.fixture.json` — `{ cases: [{ name, resolvedPrompt, scope, expected: { prompt, selected, excluded } }] }`, minimum named cases: `single-template-unchanged`, `base-only`, `condition-true`, `condition-false`, `condition-error-excluded`, `has-guard`, `order-preserved`, `per-fragment-render-no-cross-boundary`, `inline-and-template-mixed`, `empty-raises`. Both loaders assert non-vacuity and the required names.

### 4.2 Lanes

Partition is by file ownership; no two lanes write the same file. The orchestrator owns the merges, this README, `pnpm install`, the DB and the running stack.

| Lane | Wave | Tier / effort | Worktree / branch | Owns | Depends on |
|---|---|---|---|---|---|
| **0** — contract | 1 | opus, inline (orchestrator) | `dev-2.2` directly, committed BEFORE any spawn | `packages/workflow-contract/src/{agent-schemas.ts, agent-instruction.ts (new), prompt-composition.ts (new), index.ts}`, `packages/types/src/agent.ts`, `packages/applications/src/services/agent/agent-findings.ts` (codes only), `tests/contracts/prompt-composition.fixture.json` + `prompt-composition-parity.contract.test.ts`, `packages/workflow-contract/src/__tests__/*` | — |
| **A** — agent service | 1 | opus, high | `../hope-v2-task-947-agent` / `task-947/agent` | `packages/applications/src/services/agent/**` (except `agent-findings.ts`), `packages/applications/src/services/agentPromotion/**` | 0 |
| **D** — console | 1 | sonnet, high (escalate to opus on a hedged or failing first report) | `../hope-v2-task-947-console` / `task-947/console` | `apps/admin-console/src/features/agents/**` | 0 |
| **B** — live lane + resolver | 2 | opus, high | `../hope-v2-task-947-live` / `task-947/live` | `packages/applications/src/services/consultation/live-documentation/**`, `.../consultation/prompt/prompt-resolution.service.ts` (+ its tests) | 0, A merged, **TASK-946 T merged** |
| **C** — harness mirror | 2 | opus, high | `../hope-v2-task-947-harness` / `task-947/harness` | `apps/harness/**` | 0, **TASK-946 H merged** |
| inline — seed re-pointing | 1 | orchestrator | `dev-2.2` | `packages/database/src/prisma/db_main/seed/26-tenant-reference-set.ts` + its test | 0 |
| inline — artifacts | 2 | orchestrator | `dev-2.2` | `pnpm api:build && api:route-manifest && api:openapi && api:portal && --filter @arcaai/vox-node gen:admin` | A, B, C merged, **TASK-946 K merged** |
| **R1** — parity reviewer | 3 | opus, high, read-only, no worktree | `dev-2.2` | Lens: TS `composePrompt` vs Python `compose_prompt` on the fixture AND on a generated adversarial set (nested `has`, ternary, `in` over maps, unicode, escapes); the four renderers byte-identical | all merges |
| **R2** — security reviewer | 3 | opus, xhigh, read-only | `dev-2.2` | Lens: can a `when` read anything the template cannot; per-fragment one-pass (no `{{` smuggling across a join); OD-11 telemetry carries keys only; portability/promotion never carries a tenant template body or an eval gate; 404-over-403 unchanged on every touched route | all merges |
| **R3** — reproduction reviewer | 3 | opus, high, has the stack | `dev-2.2` | Lens: publish a composite agent through the console; bench, `POST /agents/:slug/invocations`, a workflow with a `core.agent` node on BOTH lanes; the four system prompts compared byte-for-byte; the excluded-fragment path exercised | all merges + running stack |

Why these tiers (rule 14 §1): Lane 0 is the API every other lane codes against and the one place a wrong shape costs every lane — orchestrator, inline, so no re-briefing loss. A, B, C are multi-file changes whose verdicts the plan acts on — opus. D is a bounded React feature against an exact JSON contract and an existing form to extend — sonnet, escalated on evidence. R2 gets xhigh because its finding, if any, is the one that cannot ship.

### 4.3 Lane 0 — TDD list (orchestrator, inline)

1. `agent-schemas.ts`: `TEXT_GENERATION_INSTRUCTION` admits `fragments[]`; `textGenerationInstructionProblems` enforces exactly one of {`promptTemplateId`, `systemPrompt`, `fragments`}, 1–16 items, `KEY_PATTERN` keys unique, per-fragment exactly-one-of, `when` string ≤ 2,000 + `expressionProblems`, at least one fragment without `when` — tests in `agent-schemas.test.ts` (RED first for each rule).
2. `agent-instruction.ts` (new, pure): `isCompositeInstruction`, `boundTemplateRefs(instruction) → [{ path, templateId, versionNumber }]` (form 1 ⇒ one entry at `instruction`, form 3 ⇒ one per template fragment at `instruction.fragments[i]`), `primaryTemplateId`, `mapBoundTemplateRefs(instruction, fn)` (returns a NEW object, never mutates); tests.
3. `prompt-composition.ts` (new, pure): `AGENT_CONDITION_ROOTS`, `composePrompt(resolvedPrompt, scope, { slug })`, `PromptCompositionEmptyError`, `conditionRootProblems(when, declaredRoots, boundNames)`; the fixture loader test passes every case.
4. `packages/types/src/agent.ts`: the `resolvedPrompt` union gains the `composite` member (OD-3); `pnpm --filter @arcaai/types build`.
5. `agent-findings.ts`: the five new codes in the union; nothing else.
6. Fixture + TS parity loader committed; `pnpm --filter @arcaai/workflow-contract test build`, `pnpm test:unit` filtered to `tests/contracts` green. Commit; this is the base every worktree branches from.

### 4.4 Lane A — TDD list

1. `resolvePrompt` → `resolveInstructionPrompt`: form 3 resolves EVERY template fragment (APPROVED, pin rule, per-fragment findings with the `instruction.fragments[i]` path), inline fragments verbatim; returns the composite shape with the static projection; forms 1/2 byte-identical to today (existing tests stay green untouched).
2. `promptTemplateFindings` runs per fragment (syntax + undeclared references) and adds `PROMPT_FRAGMENT_CONDITION_ROOT` per `when`; `PROMPT_VARIABLE_CONFLICT` over the union of declarations. `collectFindings.declaredVariables` STAYS the agent's bound names (Lane A, reconciled 2026-09-10: it feeds the graph publish check, which validates a `core.agent` node's `overrides.promptVariables` against what the agent BINDS; the union of template declarations would widen what a node may override — OD-8 governs the binding map, not this list).
3. `compile` stamps the composite `resolvedPrompt`; `compiledConfigChecksum` covers it.
4. `AgentInvocationService.invokeText` renders through `composePrompt`; `AgentTextInvocationResult` gains `promptFragments: { selected }`; a condition error is an exclusion, an empty composition is a 400 `PROMPT_COMPOSITION_EMPTY`.
5. `testDraft` renders through `composePrompt`; `AgentTestAckResponse.composition` (OD-11); `assembledSystemPrompt` is the composed prompt.
6. Portability: `instructionForExport` / `instructionForImport` / `readPromptTemplateRef` iterate `boundTemplateRefs`; `referenceInstruction`, `loadBoundTemplate`, `assertPortableAcrossTenants`, `newVersion` and `AgentPromoteToSystemService` go through `mapBoundTemplateRefs`; `agent.portability.task884.test.ts` gains composite cases (export → import round-trip; a tenant-owned fragment refuses cross-tenant clone with the existing code).
7. `text-generation-spec.ts` compiles against the widened type; candidate passes the composite through unchanged.
8. DTO description on `create-agent.request.ts:63` names the third form.

### 4.5 Lane D — TDD list

1. `api/types.ts`: `CompositeInstruction`, `PromptFragment`, `AgentTestAck.composition`.
2. `InstructionBindingValue` gains `mode: 'template' \| 'inline' \| 'fragments'` and `fragments: FragmentRow[]`; `instructionToBinding` / the wizard's serializer round-trip all three forms (test: JSON → state → JSON is identity for each).
3. `fragment-list-editor.tsx` (new, inside the feature): rows with key / source toggle / `PromptTemplatePicker` or inline `Textarea` / version pin / `when` `Input` + help text (roots, `has()` example); add, remove, move up, move down; `aria-label`s; the union "Variable bindings" fieldset; an inline validation message for a duplicate key and for no base fragment (mirrors the server's finding so the author sees it before publish).
4. `draft-test-panel.tsx` renders `composition` (selected / excluded with reason) beside the assembled prompt.
5. `agent-detail.tsx` shows a composite agent's fragments read-only when published, editable when draft.
6. Both themes, axe 0 violations on the agents screen and the wizard step (rule 12 DoD).

### 4.6 Lane B — TDD list (starts after TASK-946 T merges)

1. `callTextCandidate` renders through `composePrompt` over `buildAgentPromptScope({ variables, trigger })`; `LiveSummaryStatsDto` gains `prompt_fragments: string[]` (selected keys); an exclusion is logged at debug with the key only; an empty composition raises `LivePromptUnresolvedError` (degrade path unchanged).
2. `resolveTagSelectedPrompt` reads `primaryTemplateId(instruction)`; TASK-946 OD-5's tier 1a (merged by then) adopts the same helper — a composite department agent resolves its first unconditional template.
3. Existing live-lane tests green; new tests for a composite candidate on the realtime lane.

### 4.7 Lane C — TDD list (starts after TASK-946 H merges)

1. `models.py`: `ResolvedPrompt.source` widened to `Literal["template","inline","composite"]`, optional `join`, `fragments: list[ResolvedPromptFragment]`; `_text_fallback.py` dumps it by alias unchanged.
2. `prompt_composition.py` (new): `compose_prompt(resolved_prompt, scope, slug)` — the mirror of §4.1; `test_prompt_composition_parity.py` loads `tests/contracts/prompt-composition.fixture.json` with the required-names guard.
3. `core.py::_system_prompt` composes when `source == "composite"`; the trajectory record carries `prompt_fragments` (keys only); a condition error is an exclusion; an empty composition is DEGRADED `prompt_composition_empty`.
4. `test_core_agent_templating_task890.py` gains the composite cases; `test_replay_compat` green (no workflow-body change expected — this is activity code).
5. `pnpm harness:test`, `harness:lint`, `harness:typecheck`, `harness:format:check`.

### 4.8 Orchestrator sequence

1. OD round → "go". Confirm `TASK-947`.
2. Lane 0 inline on `dev-2.2`; gates; commit (`feat(TASK-947): contract …`).
3. Spawn A and D from that commit (worktrees, self-contained briefs per rule 14 §2: ticket, branch, owned paths, rules to read — A: `03`, `04`; D: `07`, `10`, `11`, `13` — the §4.1 contract verbatim, the exact gate commands, the return contract: branch, commits, pasted gate output, files touched, anything left undone).
4. Inline: seed 26 re-pointing over fragments + test; commit.
5. Merge A, then D, into `dev-2.2`; re-run each lane's gates after the merge; remove the worktrees only then (rule 14 §5).
6. Wait for TASK-946 T and H to merge (their orchestrator's job). Spawn B and C from the post-merge `dev-2.2`.
7. Merge B, then C; gates after each merge.
8. After TASK-946 K merges: regenerate the five artifacts inline; `api:openapi:check`, `api:portal:check`, `gen:admin:check`; commit.
9. Spawn R1, R2, R3 (read-only; R3 gets the running stack). Act on findings inline or as a named follow-up lane; nothing is "done" on an unverified reviewer claim (rule 14 §2).
10. §5 filled per lane with pasted evidence; status → Completed.

### 4.9 Gates (per lane, pasted in the lane report)

- 0: `pnpm --filter @arcaai/workflow-contract test build lint`, `pnpm --filter @arcaai/types build`, `pnpm test:unit` filtered to `tests/contracts`.
- A: `pnpm --filter @arcaai/applications build test lint` (only-warn warnings treated as errors), `pnpm api:build`.
- D: `pnpm --filter @arcaai/admin-console build lint test`; a headed pass on the agents screen (`next-dev-loop` where its floor is met), both themes, axe 0.
- B: `pnpm --filter @arcaai/applications build test lint`.
- C: `pnpm harness:test`, `harness:lint`, `harness:typecheck`, `harness:format:check`.
- Post-merge (orchestrator): `pnpm verify` scoped to the touched packages, `pnpm api:build && pnpm test:unit`, the five-artifact check trio, `pnpm sdk-node:test`.
- R3 is the live proof: four byte-identical system prompts for one composite agent across bench / invocation / realtime / durable, plus one exclusion case, pasted.

## 5. Implementation Summary

_R1 (parity) and R2 (security) reported and were acted on (§6, `8818de526`); R3 (live) stalled and the orchestrator completed the invocation- and bench-lane proofs and the cleanup itself. The realtime and durable lanes are covered by unit and parity evidence only._

### 5.1 What a tenant admin can do now

A TEXT_GENERATION agent's `instruction` has a third form: an ordered `fragments[]`, each fragment a
template reference (`promptTemplateId` + optional `promptVersionNumber`) or an inline `systemPrompt`,
each with an optional CEL `when` over the ONE render scope (`context.*`, `trigger.*`, `input.*`,
`vars.*`, `nodes.*`, bound names; `has(x.y)` guards a possibly-missing field). At least one
fragment is unconditional. Publish resolves every template fragment (APPROVED, pinned), cross-checks
each body's references and each condition's roots, and freezes the lot into
`compiledConfig.resolvedPrompt = { source: 'composite', content: <static projection>, join, fragments }`.
At run time every renderer selects the fragments whose condition holds, renders each through the
one grammar, and joins them; a condition that cannot evaluate excludes its fragment and says so; an
empty composition is refused by name. The console authors, edits and benches all three forms; the
bench, the invocation response, the live stats and the durable trajectory row report which fragment
KEYS ran — never a body or a condition.

### 5.2 Commits on `dev-2.2`, in order

| Commit | What |
|---|---|
| `db85eff19` | ticket opened (plan, OD-1…OD-14) |
| `aafde0b3d` | **Lane 0** — contract: `agent-instruction.ts`, `prompt-composition.ts`, fragment schema + `fragmentProblems` (problems carry a named `code`), widened `resolvedPrompt` type, five finding codes, fixture (15 cases) + TS loader |
| `57ca5a2ad` | seed 26 re-points every template fragment of a composite at the tenant's clone |
| `173f9ede8` | **Lane D** merge — console: fragment-list editor, one mode-driven `InstructionBindingForm`, three-form round-trip, bench composition panel |
| `5df88d28e` | **Lane C** merge — harness: `compose_prompt` mirror (parity 15/15), widened `ResolvedPrompt`, `core.agent` composes on the durable lane |
| `c3aeb87b8` | a composite with no `fragments` list refuses by name on both mirrors (fixture case 16) |
| `6ebe64c2b` | the selected fragments land on the NODE trajectory row (`_shared.py` `stats` / `node_stats`, `core.py`) |
| `5117cd868` | **Lane A** merge — publish/compile/bench/invocation compose; bundle, clone, promotion read every bound template |
| `08288cb1a` | `promptFragments` on the invocation HTTP response |
| `08c85cbaa` | `primaryTemplateId` treats a compiled fragment list (`when: null`) like an authored one |
| `5975ffa4d` | **Lane B** merge — realtime `core.agent` lane composes; both prompt-resolution pointer tiers read `primaryTemplateId` |
| `fe3ba9547` | the five API artifacts regenerated (`e49f6554f`) |
| `8818de526` | **reviewer fixes** (`176fb5b2a`) — one `context` view on every lane, `primaryTemplateRef`, authored fragment index, refuse-by-name parity, nesting cap + Python parse guard, `__proto__` map key, invocation-lane exclusion log, bench detail redaction |

### 5.3 Gates (after the last merge, `8818de526`, run on that exact tree in the fixes worktree — the primary's dist is held by the other session's running gateway)

| Surface | Result |
|---|---|
| `@arcaai/workflow-contract` | 50 files / 931 passed, tsc 0, lint 0 errors, build OK |
| `@arcaai/types` | build OK |
| `tests/contracts` loaders | prompt-composition 21/21 (19 cases + guards), prompt-template 31/31 — Python mirrors 105/105 over both extended fixtures |
| `@arcaai/database` (seed) | reference-set suites 20/20, typecheck 0 |
| `@arcaai/applications` | 777 files / 12866 passed; ONE file red in every run — `membership-bounded-sync.integration.test.ts` (live-DB suite, port 5433 down on this box; environmental, red on the baseline); build 0; lint 0 errors / 182 warnings (the count the ticket started with) |
| `apps/api` | `api:build` 12/12; agent module unit 6 files / 65 passed (controller 26/26 incl. `promptFragments`) |
| `apps/admin-console` | 310 files / 2837 passed; `eslint --max-warnings 0`; `next build` OK (94/94 pages; five Edge-runtime warnings on `instrumentation.ts` pre-date this ticket) — unchanged by the fixes |
| `apps/harness` | full suite 2388 passed at `5df88d28e`; after the fixes the interpreter subset 690 passed (parity 20/20, recursion 4/4, trajectory 6/6, templating 39/39, replay-compat 23/23); ruff "All checks passed"; mypy 151 files clean; `black --check` red on 22 files that pre-date the ticket (black 26.5.1 vs tree), the ticket's own files clean |
| `@arcaai/vox-node` | 33 files / 486 passed on the regenerated schemas; `gen:admin:check`, `api:openapi:check`, `api:portal:check` all "no drift" |
| Live (shared dev stack, pre-fix build) | invocation lane: 200 + `promptFragments.selected` on two contexts, the correct 400 on an unresolved variable; bench lane: three contexts render and report `composition` exactly per §4.1 (§6, 2026-09-10 R3 entry) |

### 5.4 Files changed (by lane; the §6 record has the per-lane stats)

Contract: `packages/workflow-contract/src/{agent-instruction,prompt-composition,agent-schemas,index}.ts` + three `__tests__/*.task947.test.ts`; `packages/types/src/agent.ts`; `tests/contracts/prompt-composition.fixture.json` + loader. Applications: `services/agent/{agent.service,agent-invocation.service,agent-bundle,agent-findings}.ts`, `dto/{agent-test-ack.response,create-agent.request,update-agent.request}.ts`, `services/agentPromotion/agent-promote-to-system.service.ts`, `services/consultation/live-documentation/{live-documentation.service.ts,dto/live-summary.dto.ts}`, `services/consultation/prompt/prompt-resolution.service.ts`, + eight `*.task947.test.ts`. API: `apps/api/src/modules/agent/agent.controller.ts` (+ test), `openapi.json`. Console: `apps/admin-console/src/features/agents/**` (16 files) + the two portal documents. Harness: `temporal/interpreter/{models.py,prompt_composition.py,nodes/core.py,nodes/_shared.py}` + two tests. Database: `seed/26-tenant-reference-set.ts` + test. SDK: `packages/vox-node/src/resources/admin/schemas.ts` (generated).

### 5.5 No migration, no env var, no new dependency

`instruction` and `compiledConfig` are JSONB; nothing in `turbo.json#globalEnv` moved; `@arcaai/database` keeps its no-contract-dependency posture (the seed carries a tested twin of the traversal).

### 5.6 Design properties (R1/R2 — documented, not bugs)

1. **A conditional fragment is caller-influenceable by construction, by TYPE as well as by value.** Whoever supplies the run scope — an API-key integration on `POST /agents/:slug/invocations`, a consultation payload, a prior LLM node's output under `nodes.*` on a workflow lane — can drop a fragment, and making an operand the wrong type is cheaper than satisfying the author's logic. Anything that must ALWAYS be sent belongs in an unconditional fragment; a guardrail or safety instruction is exactly that. The invocation lane now logs every exclusion (WARN on `condition_error`) so a dropped fragment is reconstructible; the console should say the first sentence in its help text.
2. **`has()` changes the failure mode, not the reachability.** `has(context.x) && context.x < 18` turns the omission case into `condition_false`, indistinguishable in telemetry from an honest false — the recommended guard also removes the only signal that something was withheld.
3. **The static projection is what a reader from before this ticket runs** (OD-3): a worker one release behind serves the base fragments and silently omits every conditional one. Bounded to the digest-pinned deploy window; the Python `Literal` widening makes the durable half fail loudly rather than silently.
4. **A composite never falls back to the platform prompt on the live lane** (`liveCandidatePromptSource`): an empty composition degrades the node. The opposite of the single-body forms, on purpose.
5. **The scope roots differ by lane, by design, and `has()` is what makes a condition portable:** `input.*` exists only on the invocation route and the bench; `vars.*` / `nodes.*` only on the workflow lanes (present as `{}` on the durable lane, absent on the realtime one). An unguarded read of a root a lane does not publish is a `condition_error` there.
6. **A fragment KEY is tenant-authored content.** It reaches the clinician's live feed (`prompt_fragments`) and the trajectory row; `hiv_disclosure_addendum` is a key that says something. Help text.

## 6. Change History

| Date | Entry |
|---|---|
| 2026-09-10 | Ticket opened. Architecture review of "how does an agent pick up its prompt / where do departments meet it" (same session) established the one-template contract, the grammar's surface, the four renderers and the TASK-946 file overlap. Option C chosen by the owner over A/B. Plan written; OD-1…OD-14 await the owner. No code. |
| 2026-09-10 | Owner: "manage and align agents using appropriate model-effort tiers … without overlapping works" — taken as the go; OD-1…OD-14 as recommended. Schedule adjustment for parallelism: Lane D (console) is spawned BEFORE Lane 0 lands, against the §4.1 JSON contract alone — the console's `api/types.ts` is hand-written, so it needs nothing from the contract package; it must NOT import the not-yet-existing helpers. Lane A waits for Lane 0's commit as planned. |
| 2026-09-10 | Lane D spawned (sonnet) on `task-947/console` from `db85eff19` (README commit). **Lane 0 landed, `aafde0b3d`** (orchestrator, inline, TDD — RED 15/17 before source): `agent-instruction.ts`, `prompt-composition.ts`, the fragment schema + `fragmentProblems` in `agent-schemas.ts` (problems now carry an optional named `code`), the widened `resolvedPrompt` union in `@arcaai/types`, five finding codes + `codeForConfigProblem` honouring the contract's code (`AgentFinding` now `extends Omit<AgentConfigProblem, 'code'>`), fixture (15 cases) + TS loader. Gates: workflow-contract 914/914 · tsc 0 · lint 0 errors (3 pre-existing prettier warnings on untouched lines) · build OK; types build OK; applications typecheck 0; root loaders 48/48. One design fact the fixture pins that the plan did not state: a bare bound name is a STRING in a `when` (`{ path }` bindings resolve through the grammar), so `age > 65` is a `condition_error` and the numeric branch must read the root (`context.patient_age > 65`) — Lane D's help text says so. |
| 2026-09-10 | Lane A spawned (opus) on `task-947/agent` from `aafde0b3d`; its worktree bootstrapped by the orchestrator (`pnpm install` → `pnpm db:generate` → `pnpm build:packages`, 22/22 — a fresh worktree has neither the gitignored Prisma client nor any `dist/`). Inline (orchestrator): seed 26 re-points every template FRAGMENT of a composite agent at the tenant's clone — `boundTemplateIdsOf` + `repointInstructionTemplates`, exported and unit-tested (`task-947-reference-set-agent-fragments.test.ts`, 3 suites 20/20 with the two existing reference-set suites; database typecheck 0; package lint clean). Honest note: that helper and its test were written in one pass, so the RED was not observed — the import would have failed, but that is inference, not evidence. The seed's traversal is the ONE deliberate twin of `boundTemplateRefs`: `@arcaai/database` carries no contract dependency (its own header explains why), and adding the edge is a §7 follow-up, not a side effect of this lane. Prettier reformatted five untouched hunks of the seed file; they were restored from HEAD — only the four hunks of the change are in the commit. |
| 2026-09-10 | **OD-13 applied on evidence, not on the package boundary.** TASK-946 lanes S, X, K merged (`df3573171`, `e8671f070`, `72494cdd9` + `0233b6517` — the artifact-regeneration gate is clear); `task-946/harness` (`3cd21fb72`) and `task-946/live` (`5e3218634`) are committed, unmerged. Their committed diffs: harness = `interpreter/workflow.py` + `test_seeded_consultation_graph_task930.py`, `test_task932_h1_review_timeout.py`, `test_task932_live_handoff.py`, `test_task946_trigger_context.py` — NONE of Lane C's files (`models.py`, `nodes/core.py`, `nodes/_text_fallback.py`, new `prompt_composition.py`, new parity test, `test_core_agent_templating_task890.py`); live = `live-documentation.service.ts` (+172) and `prompt-resolution.service.ts` (+152) among 19 files — BOTH of Lane B's files. So **Lane C starts now** (worktree `../hope-v2-task-947-harness`, `task-947/harness` from `57ca5a2ad`; one writer per FILE holds, the merge cannot conflict at file level; Lane C must not touch the four test files above) and **Lane B waits** for the `task-946/live` merge. |
| 2026-09-10 | `task-946/live` merged (`efecad192`, lane T). **Lane B spawned** (opus) on `task-947/live` from `35f1bd87c` (post-merge `dev-2.2`), worktree bootstrapped like A's. Post-merge the resolver has TWO hand-rolled `instruction.promptTemplateId` reads that Lane B routes through `primaryTemplateId` / `boundTemplateRefs`: the tag-selected tier (`prompt-resolution.service.ts:732`) and TASK-946 OD-5's per-turn `core.agent` tier (`:1389`, with the agent's pin at `:1407`). The live lane renders at `callTextCandidate` (`live-documentation.service.ts:5170`, via `renderLivePrompt` `:294`). |
| 2026-09-10 | **Lane D merged** — `173f9ede8` (no-ff, 6 commits, 16 files, +1507/−224, all under `features/agents/**`; boundary verified by the orchestrator). Lane gates in its worktree: console test 310 files / 2837 passed, `eslint --max-warnings 0` clean, `next build` compiled + 94/94 pages; post-merge re-run by the orchestrator in the primary on `173f9ede8`: test 310 files / 2837 passed, lint exit 0, `next build` "Compiled successfully in 38.7s" + 94/94 pages, exit 0 — the five "Ecmascript file had an error" lines in that build are Edge-runtime WARNINGS on `apps/admin-console/instrumentation.ts` (`process.once`, `process.pid`, `node:fs/promises`, `node:os` — TASK-944's service-release registration), present before this lane and outside its files. Worktree `../hope-v2-task-947-console` removed and `task-947/console` deleted after the merge (rule 14 §5 order kept). What landed: `fragment-list-editor.tsx` (+ `variable-bindings-fieldset.tsx`, `version-pin-control.tsx` shared sub-controls), `InstructionBindingValue` absorbed the wizard's/detail's separate `instructionMode` + `systemPrompt` state into ONE mode-driven editor with a single `instructionToBinding` / `instructionFromBinding` pair (round-trip test over all three forms, byte-identical), wizard and detail author/edit/display composites, the bench panel shows selected/excluded fragments. Two things the lane resolved on its own, accepted: (1) the context-schema picker now renders in ALL three modes, not template only — correct, because publish checks `{{context.*}}` references on an inline body too (`promptTemplateFindings` runs over `resolvedPrompt.content` whatever its source); (2) "neither/both of template/inline" is unreachable through a source TOGGLE, so the reachable failure "chosen source has no content" is what the row validates. No headed `next dev` pass (R3 covers the runtime). One pre-existing defect it surfaced, NOT fixed here → §7: the console drops `instruction.evalGate` on every save (the editor never carried it, before or after this lane). |
| 2026-09-10 | **Lane C merged** — `5df88d28e` (no-ff, 2 commits, 5 files, +896/−23, boundary verified; `task-946/harness` had merged just before, no overlap). Lane gates in its worktree: `pnpm harness:test` 2364 passed (parity 19/19, templating 39/39 incl. 15 new, `test_replay_compat` 23/23), ruff clean, mypy 151 files clean; `black --check` fails on 22 files that are byte-identical to the base and outside the lane (black 26.5.1 in `arcaenv` vs the tree — pre-existing, left alone). Source-tree proof pasted (every guarded package resolved inside the worktree). Parity 15/15 on the first implementation; `bound-name-is-string` produced `detail: "no such overload: string > int"` on the Python side — the reason `detail` is deliberately not pinned. Wire round-trip of a composite through `_text_fallback` is lossless without touching that file. The lane found ONE divergence — a composite with no `fragments` list: Python raised `PromptCompositionEmpty`, TS a bare `TypeError` — closed by the orchestrator in `c3aeb87b8`: TS treats a missing list as empty, fixture case `fragments-missing-raises` added (TS loader 18/18, Python 20/20). The lane also ran `git stash` once in its worktree (rule 14 §3) and popped it immediately — no sibling affected, recorded here because the rule says never. **Open from this lane (OD-11 on the durable lane):** `prompt_fragments` sits on `NodeActivityResult` (additive-optional); landing it on the NODE trajectory row needs `_shared.py::record_and_flush` to accept it and `workflow.py` to thread `result.prompt_fragments` — both outside the lane's set and, until minutes ago, owned by TASK-946 H. Orchestrator does it inline after the post-merge harness gates finish (no harness file is edited while pytest runs over the tree). |
| 2026-09-10 | **Lane C post-merge gates** (orchestrator, primary, on `5df88d28e`): `pnpm harness:test` 2388 passed (7 min 54 s), ruff "All checks passed!", mypy "no issues found in 151 source files"; worktree `../hope-v2-task-947-harness` removed and `task-947/harness` deleted after the merge. **OD-11 durable-lane follow-up done inline** (test-first: RED 3/6 on the missing keyword, then GREEN 73/73 across the new `test_task947_prompt_fragments_trajectory.py`, the metering, templating and parity suites): `_shared.py::record_and_flush` takes an optional `stats`, `record_generation_and_flush` an optional `node_stats`, both landing on the NODE step only (the LLM_CALL step keeps the billable block verbatim — the gateway bills LLM_CALL steps only, `harness-usage.mapper.ts:159`, and its ingest DTO already accepts `stats` on any step); `core.py` passes `node_stats={"prompt_fragments": [keys]}` on the generation record only when there is something to say, so a single-body agent's record is byte-identical to before (the pre-existing metering stub with a strict signature stays green untouched). |
| 2026-09-10 | **Lane A merged** — `5117cd868` (no-ff, 4 commits, 13 files, +2062/−170, boundary verified, `agent-findings.ts` untouched). Lane gates in its worktree: owned suites 29 files / 456 passed; the package's full `test` shows ONE red FILE with ZERO failed tests — `agentPromotion/__tests__/integration/membership-bounded-sync.integration.test.ts` fails in `beforeAll` for want of the test Postgres (5433 is down on this box, so it fails identically on the baseline; not this lane); `build` exit 0; `lint` 0 errors / 182 warnings, none in the lane's paths (186 → 182, three of its own nits fixed); `pnpm api:build` 12/12. Contract conformance pasted in the lane report: a composite with a template base (pinned v1), a template `revisit` and an inline `peds` compiles to the §4.1 shape byte-for-byte; the bench with `{ clinic, visit_type: 'revisit' }` and no `patient_age` renders `"You are a scribe for Ward B.\n\nThis is a follow-up visit."` with `composition.excluded = [{ key: 'peds', reason: 'condition_false' }]` — `condition_false`, not `condition_error`, because the `has()` guard makes the condition evaluable (the shape authors are told to write). Every hand-rolled `instruction.promptTemplateId` read in `services/agent/**` and `agentPromotion/**` now goes through `boundTemplateRefs` / `mapBoundTemplateRefs` (table in the lane report); `agentBundlePayloadProblems` additionally REFUSES a bundle carrying a raw `promptTemplateId` (a hand-edited composite cannot smuggle a foreign row id onto a fragment). Two reconciliations: `declaredVariables` stays the bound names (§4.4 item 2 corrected — it feeds the graph's `overrides.promptVariables` check); `promptFragments` was on `AgentTextInvocationResult` but not on the HTTP response — wired by the orchestrator in `agent.controller.ts` (`promptFragments: { selected } \| null` on `AgentTextInvocationResponse`, `08288cb1a`, controller unit test 26/26). |
| 2026-09-10 | **Lane A post-merge gates** (orchestrator, primary, on `5117cd868` + the controller wiring): applications test 773 files / 12827 passed with the same single DB-less integration file red (`membership-bounded-sync.integration.test.ts`, `beforeAll`, port 5433 down), build exit 0, lint 0 errors / 182 warnings, `pnpm api:build` 12/12. Worktree `../hope-v2-task-947-agent` removed, `task-947/agent` deleted. **Lane B's finding on the contract fixed** — `primaryTemplateId` read "unconditional" as `when === undefined` only, so a COMPILED fragment list (`when: null`) lost its base; now `undefined \|\| null` (test-first, RED on the compiled shape, GREEN 916/916, dist rebuilt). Lane B's tiers read the AUTHORED instruction and were correct either way; the fix is for any future caller handed `resolvedPrompt.fragments`. |
| 2026-09-10 | **Lane B merged** — `5975ffa4d` (no-ff, 3 commits, 5 files, +735/−17, boundary verified). Lane gates in its worktree: `services/consultation` 201 files / 2669 passed, package test 12781 passed with the same DB-less integration file red, build exit 0, lint 0 errors (its one orphaned import removed, count back to the base's 182). Evidence pasted: byte identity for inline / template / no-`resolvedPrompt` fallback / no-instruction agents (five tests written RED-first against the old code and green before and after); composite `system_prompt` `"BASE for new-visit.\n\nREVISIT ADDENDUM."` with `prompt_fragments ["base","revisit"]`, `condition_error` exclusion non-fatal, an empty composition makes ZERO TEXT calls, `JSON.stringify(stats)` carries no condition string or body; both pointer tiers resolve a composite's first unconditional template WITH the fragment's own pin (`pin: 7` where the template's approved is 3) and fall through for an all-conditional or inline-only composite. `LiveSummaryStatsDto.prompt_fragments` is stamped `null` explicitly on every agent-lane flush (like `task_key` / `agent_slug` / `funding_tier`), so `null` ("nothing to report") stays distinct from `[]`. `LiveSummaryStatsDto` has no OpenAPI schema entry, so the artifacts do not move on B's account. Reviewers R1 (parity) and R2 (security) spawned read-only on this HEAD; R3 (live reproduction) waits for the artifact regeneration and a free dev stack. |
| 2026-09-10 | **Lane B post-merge gates** (orchestrator, primary, on `5975ffa4d`): applications test 775 files / 12852 passed with the same DB-less integration file red (`pipefail` stopped the chain there; build and lint re-run separately: build exit 0, lint 0 errors / 182 warnings). **The five API artifacts are regenerated in Lane B's still-bootstrapped worktree on a new branch `task-947/artifacts` from `dev-2.2`, not in the primary:** the other session had just started `pnpm stack:dev` there, and `pnpm api:build` begins with `rimraf dist` under a gateway that has loaded that dist. Rule 14 §3 (one writer per tree) applied to the dist as much as to the source. **R3 spawned** against that shared stack, read-mostly: everything it creates is prefixed `task947-r3-` in the Global playground tenant and deprecated at the end; it never starts, stops or rebuilds a service. |
| 2026-09-10 | **Artifacts regenerated and merged** — `e49f6554f` on `task-947/artifacts` (from `e3a4d675c`), merged as `fe3ba9547`. `pnpm build:packages` 22/22 → `pnpm api:build` 12/12 → route-manifest (744 routes, UNCHANGED — no route was added) → openapi (516 paths) → portal (662 admin / 200 business ops) → `gen:admin` (49 areas / 422 routes / 428 schemas); `api:openapi:check` "every served route is either documented or deliberately excluded", portal "no drift", `gen:admin:check` "no drift". Four files moved, +199/−9: the `instruction` descriptions on the create/update DTOs name the three forms, and the bench ack gains `AgentTestCompositionResponse` / `AgentTestCompositionExclusionResponse` (`selected[]`, `excluded[].{key, reason ∈ condition_false \| condition_error, detail?}`). Post-merge in the primary: `pnpm sdk-node:test` 33 files / 486 passed against the regenerated schemas (the drift trio was run in the worktree on the same tree state, because a check re-runs `api:build` and the other session's gateway holds the primary's dist). The last worktree (`../hope-v2-task-947-live`) and both branches (`task-947/live`, `task-947/artifacts`) retired after the merge. |
| 2026-09-10 | **R1 (parity) reported** — 282 generated artifacts × scopes through both composers, 23 divergences in 6 classes; everything the brief named (nested `has()`, short-circuit with a missing RHS, ternary, `in`, `size()`, string↔number, unicode, escapes across a join, `default()`, whitespace, `null`/array values, 10 join variants, 1/16/17 fragments, all 22 template-fixture bodies as fragments) matched. Verdicts, after the orchestrator read each site: (1) **HIGH, real** — the realtime lane is the ONE renderer that never applies the J3-5 `context` unwrap (`renderLivePrompt` passes the raw trigger; invocation, bench and durable unwrap), so `context.visit_type == 'revisit'` — §4.1's own example — selects on three lanes and is a silent `condition_error` exclusion on the live lane (R1's four-lane table pasted in its report). Pre-existing scope asymmetry (TASK-890/943) that this ticket turns from "a variable renders differently" into "a different branch runs". Fixed in `task-947/fixes`. (2) **MEDIUM, real** — `parse_expression` is outside the `RecursionError` guard in `expressions.py::evaluate_expression`, so a 244-char `when` of 120 nested parens (under the 2000 cap) raises through `compose_prompt` and the node (OD-5 violated); TS parses it fine, so publish accepts what the worker cannot evaluate. Fixed: Python guard (→ `condition_error`) AND a publish-time nesting cap in `fragmentProblems`. (3) **MEDIUM, real** — the per-turn pointer tier's pin lookup `boundTemplateRefs(...).find(ref => ref.templateId === templateId)` returns the FIRST fragment with that id, which need not be the unconditional one `primaryTemplateId` chose (ids may repeat; only keys are unique). Fixed with `primaryTemplateRef` (the contract returns the ref, the resolver reads its pin). (4) **MEDIUM** — `c3aeb87b8` closed one malformed shape; six siblings remained where TS throws a bare `TypeError` and Python composes (`null` list entry, missing/`null` fragment `content`, missing/`null` single-body `content`). Fixed by coercion in TS, pinned by three new fixture cases both loaders run. (5) **LOW** — a non-string fragment key reaches telemetry raw in TS (`String()` now). (6) **LOW** — two index spaces in finding paths (`readPromptFragments` compacts non-object entries; `fragmentProblems` indexes the raw list): fixed by carrying the RAW index on `AgentPromptFragment`. NOT this ticket's: JS `canonicalJson` vs Python `json.dumps` render `37.0` as `"37"` / `"37.0"` (and `1e22`, `-0.0`, big ints, astral-plane key order) — a TASK-890 grammar divergence unpinned by either fixture → §7. |
| 2026-09-10 | **R2 (security) reported** — no Critical, no High. Verified safe with evidence: a `when` reads exactly the render scope (no payload, header, tenant config, credential on any lane); no prototype reach (`constructor` / `__proto__` / `toString` all `no such key`), no pollution, no scope mutation; the 2 000-char cap enforced twice; no smuggling across a fragment boundary (render-then-join on both mirrors, incl. a forged `join: ""`); `PromptTemplate` is NOT SYSTEM-shared-read, so a fragment naming another tenant's template is `TEMPLATE_NOT_FOUND` with the same message as a nonexistent id (no oracle, no content); bundle export carries no body / id / `goldenSetId`, import refuses a smuggled raw id at the fragment site, cross-tenant clone refuses a non-SYSTEM fragment template by key, promotion deep-copies per distinct id under the Global context and strips `evalGate` first, the seed re-point predicates on the target tenant; telemetry carries keys only on every surface; the authorization surface did not move (manifest untouched, controller +6 lines, request DTOs description-only, `forbiddenKeyProblems` reaches `instruction.fragments[i].apiKey`). Findings: **M-1** the invocation lane recorded NOTHING on an exclusion (a safety fragment dropped by a wrong-typed caller input was unreconstructible; the other three lanes log) — fixed; **L-2** a map literal whose KEY is `__proto__` was a prototype swap in TS and an ordinary key in Python, a caller-controlled divergence in the selection function — fixed (own property; two expressions-fixture cases); **L-3** = R1 #3 — fixed; **L-4** no evaluator step/size budget (a 2 000-char `when` can materialise ~200 copies of the largest scope value) — pre-existing through `core.condition`, tenant-admin-authored, → §7; **L-5** the bench's `excluded[].detail` can echo a scope VALUE (`no such key: '<dynamic index>'`, `int() cannot parse "…"`) — not a leak today (own tenant, own context, console never renders it) — redacted to the SHAPE of the problem. Informational: promotion can leave a Global-owned id on a SYSTEM DRAFT when a fragment's template is unreadable (the copy commits before `publish` runs; publish then refuses) → §7; §2.2's "`newVersion` cross-tenant pin drop" names a mechanism that does not exist (`newVersion` copies `instruction` verbatim and relies on publish to refuse foreign ids) — corrected; fragment KEYS are tenant-authored content that reaches the live feed — help text. Design properties to document (§5.6). |
| 2026-09-10 | **Reviewer fixes landed** — `176fb5b2a` on `task-947/fixes` (worktree from `3adab2f9f`, bootstrapped like the lanes'), merged as `8818de526` (28 files, +719/−32). Test-first throughout (contract RED 13/13 → GREEN 931/931; applications RED 5 + 6 → GREEN 1330 over the agent/prompt/live dirs; Python RED 4 → GREEN). What changed: `buildAgentPromptScope` takes an explicit `context` view; `ResolvedTextCandidate.contextSchema` carries the agent's frozen schema; `renderLivePrompt` unwraps the trigger through it (R1 #1); `primaryTemplateRef` + both pointer tiers read id and pin from one fragment (R1 #3 / R2 L-3); `readPromptFragments` carries the authored `index` and the two finding-path builders use it (R1 #6); the TS composer skips non-object entries, treats missing content as `""` and stringifies keys — three fixture cases (R1 #4/#5); `AGENT_PROMPT_CONDITION_MAX_DEPTH = 64` enforced by `fragmentProblems` and a `RecursionError` guard around the Python parse (R1 #2); a map literal's `__proto__` key is an own property (R2 L-2); the invocation lane logs exclusions, WARN on `condition_error` (R2 M-1); the bench detail is redacted (R2 L-5). Prettier reformatted pre-existing lines of three lane test files and of the expressions fixture; all restored from HEAD, only the appended blocks kept. |
| 2026-09-10 | **R3 (live) stalled** after "Console lane confirmed" (the agent's stream watchdog gave up at 600 s; TEXT/LM Studio was down for its invocation step and this session has no channel to resume it). It had authored `task947-r3-base` / `-revisit` / `-revisit2` (APPROVED) and published `task947-r3-composite` (two versions, the second deliberately referencing `{{context.no_such_field}}`) and `task947-r3-inline` in the Global tenant. **The orchestrator finished the live proof against the shared stack (the other session's gateway, `0.0.0-dev-2-2.eb5571f2`, a build that predates the reviewer fixes) and cleaned up.** Invocation lane, `POST /api/v1/agents/task947-r3-composite/invocations` with TEXT back up: `context {language, visit_type: 'revisit'}` → **400** naming `context.no_such_field` (the correct unresolved-VARIABLE refusal — R3's own trap, not a composition defect); `{language}` → **200**, `promptFragments.selected ["base"]`, generated text; `{language, visit_type: 5}` → **200**, `["base"]` (a type mismatch is an exclusion, never fatal). Bench lane, a throwaway DRAFT `task947-orch-bench` (three inline fragments, the §4.1 conditions): `{language: 'en', visit_type: 'revisit'}` → `"You are a scribe. Language: en.\n\nCompare with the prior note."`, `selected ["base","revisit"]`, `excluded [{peds, condition_false}]`; `{language: 'en'}` → base only, both conditionals `condition_false` (the `has()` guard); `{visit_type: 5, patient_age: 'seven'}` → base only, `revisit` `condition_false`, `peds` `condition_error` `"no such overload: string < int"`. Cleanup: the bench draft deleted (200), R3's three agents deprecated + deleted (200 each), its three templates deleted (200); a final listing shows no `task947` object left. NOT proven live: the realtime and durable lanes (unit + parity evidence only — `live-documentation.composite-prompt.task947.test.ts`, `test_core_agent_templating_task890.py`, the 19-case fixture) and the console beyond R3's "confirmed" line. |
| 2026-09-10 | **Owner confirmed completion; status → Completed.** Final state: last code merge `8818de526`, artifacts `fe3ba9547`, no `task-947/*` worktree or branch left, the shared Global tenant clean of `task947-*` objects. Open items live in §7 only. |

## 7. Follow-ups (not in this ticket)

- **Number rendering diverges between the two template renderers** (R1, pre-existing TASK-890): JS `canonicalJson` writes `37.0` as `"37"`, `1e22`, `"0"` for `-0.0`, `"1e-7"`; Python `json.dumps` writes `"37.0"`, the full integer, `"-0.0"`, `"1e-07"`; big integers past 2^53 differ; astral-plane key order differs (UTF-16 units vs code points). Unpinned by either fixture. Pin the JS behaviour in `prompt-template.fixture.json` and align the Python mirror, or the reverse — an owner decision for TASK-890's grammar.
- **The CEL evaluator has no step or result-size budget** (R2 L-4): a 2 000-char `when` can materialise ~200 copies of the largest scope value through string `+` / `size()`; the same primitive is already reachable through `core.condition`. A node-count budget in `evalNode` and a result-size cap, mirrored in `expressions.py`.
- **Promotion can leave a Global-owned template id on a SYSTEM DRAFT** (R2 informational): when a fragment's template is unreadable, `materializeTemplate` answers null, the ref travels untouched and the SYSTEM row commits before `publish` refuses it. Fail-closed, but the draft should not be written with a foreign id — resolve every fragment before the copy.
- **Durable-lane FALLBACK candidates carry no `contextSchema`** (`_text_fallback.candidate_as_resolved_agent` builds a `compiledConfig` without it), so the J3-5 unwrap applies to the primary and not to a fallback on that lane. The TS candidate now carries it (`ResolvedTextCandidate.contextSchema`); the Python `TextFallbackCandidate` should read it too.
- **Scope-root parity beyond `context`**: `vars` / `nodes` exist as `{}` on the durable lane and are absent on the realtime one, so `size(vars) == 0` is taken there and a `condition_error` here (R1). Publish either roots or absents on both, or document it as §5.6 item 5 does and leave it.
- **§2.2 correction**: "`newVersion` cross-tenant pin drop" (`agent.service.ts:1376`) names a mechanism that does not exist — `newVersion` copies `instruction` verbatim and drops only the context-schema pin; branching a SYSTEM agent lands SYSTEM template ids in a tenant draft and relies on `publish` to refuse them. Fail-closed; the table row is wrong, the behaviour is not.

- The `when` help text in the console names `context.<field>` as the root (OD-4). On the consultation lanes the run payload is `{ trigger: { context } }` (TASK-943/946 canonical namespace), so `context.<field>` resolves only when the agent binds a single-kind context schema keyed `context` (the J3-5 unwrap); otherwise a clinical field sits at `trigger.context.<field>`, and a literal `context.visit_type` is a silent `condition_error` exclusion. Pre-existing scope semantics (the seeded agents bind `{ path: 'trigger.context.*' }`), surfaced by Lane B; the help text should name both spellings and the bench should show the scope roots it rendered against.
- The console's agent editor never carried `instruction.evalGate`, so any save from the wizard/detail form drops an eval gate the API had accepted (pre-existing, surfaced by Lane D). Either the editor learns the field or the PATCH sends only the instruction keys it edits.

- Computed variable bindings (`{ expr: "<CEL>" }`) on `instruction.variables` — the third half of the original gap (§1).
- Authorable joiner / per-fragment separator (OD-7 alternative).
- OD-9 alternative: the tag-selected prompt tier serving the agent's compiled composition (closes the freeze bypass at `prompt-resolution.service.ts:709`).
- A demonstration composite agent in the Global playground seed (new-visit + revisit as ONE department agent) and, if adopted, collapsing the per-visit department agents in `29-arcaai-agents-and-workflows.ts`.
- `prompt.template_ref` (`template_ref.py:39`) still interpolates with its own `{{var}}` regex rather than the one grammar — a parity gap predating this ticket.
- STT call sites all pass `departmentId: null` to `AsrAgentResolverService` (noted 2026-09-10) — the DEPARTMENT tier of a SPEECH_TO_TEXT assignment is unreachable at runtime.
