# TASK-947 — Composable agent instructions: conditional prompt fragments for TEXT_GENERATION agents

**Status:** In Progress — owner's go 2026-09-10; OD-1…OD-14 taken as recommended (§3), an override is recorded in §6
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
2. `promptTemplateFindings` runs per fragment (syntax + undeclared references) and adds `PROMPT_FRAGMENT_CONDITION_ROOT` per `when`; `PROMPT_VARIABLE_CONFLICT` over the union of declarations; `collectFindings.declaredVariables` becomes the union.
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

_Pending — filled per lane as each merges._

## 6. Change History

| Date | Entry |
|---|---|
| 2026-09-10 | Ticket opened. Architecture review of "how does an agent pick up its prompt / where do departments meet it" (same session) established the one-template contract, the grammar's surface, the four renderers and the TASK-946 file overlap. Option C chosen by the owner over A/B. Plan written; OD-1…OD-14 await the owner. No code. |
| 2026-09-10 | Owner: "manage and align agents using appropriate model-effort tiers … without overlapping works" — taken as the go; OD-1…OD-14 as recommended. Schedule adjustment for parallelism: Lane D (console) is spawned BEFORE Lane 0 lands, against the §4.1 JSON contract alone — the console's `api/types.ts` is hand-written, so it needs nothing from the contract package; it must NOT import the not-yet-existing helpers. Lane A waits for Lane 0's commit as planned. |

## 7. Follow-ups (not in this ticket)

- Computed variable bindings (`{ expr: "<CEL>" }`) on `instruction.variables` — the third half of the original gap (§1).
- Authorable joiner / per-fragment separator (OD-7 alternative).
- OD-9 alternative: the tag-selected prompt tier serving the agent's compiled composition (closes the freeze bypass at `prompt-resolution.service.ts:709`).
- A demonstration composite agent in the Global playground seed (new-visit + revisit as ONE department agent) and, if adopted, collapsing the per-visit department agents in `29-arcaai-agents-and-workflows.ts`.
- `prompt.template_ref` (`template_ref.py:39`) still interpolates with its own `{{var}}` regex rather than the one grammar — a parity gap predating this ticket.
- STT call sites all pass `departmentId: null` to `AsrAgentResolverService` (noted 2026-09-10) — the DEPARTMENT tier of a SPEECH_TO_TEXT assignment is unreachable at runtime.
