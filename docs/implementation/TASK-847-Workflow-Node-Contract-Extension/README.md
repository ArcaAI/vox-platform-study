# TASK-847 — Workflow Node Contract Extension

| Field | Value |
|---|---|
| **Status** | `Review` — implemented 2026-09-01 on `worktree-agent-a563a474435cde4ac`, gates green, awaiting merge into `dev-2.2` |
| **Type** | `feature` |
| **Branch** | worktree branch `worktree-agent-a563a474435cde4ac` → merges into `dev-2.2` |
| **Parent** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) — Track D |
| **Tier / Effort** | `opus` / high (contract design — dual-language, parity-gated) |
| **Depends on** | TASK-843 ✅, TASK-844 ✅, TASK-845 ✅, TASK-846 ✅, TASK-852 ✅ — all landed |
| **Owns** | `packages/workflow-contract/`, `packages/py-workflow-contract/`, the studio inspector |

## 1. Requirement Analysis

Eight node types with the contracts in the owner's specification. Agent nodes bind to **exactly one** provider
configuration, carry an instruction prompt, generation hyper-parameters, optional guardrail nodes on
input/output, and optional tools. Input/Output nodes carry tenant-defined JSON schemas.

**OD-4 applies:** STT and TTS nodes stay IN the day-1 slice, against the research recommendation to defer
them. That decision moves binary audio transport into scope for TASK-849, and it is why TASK-843 (task
taxonomy) was on the critical path for this track.

## 2. Current State Evaluation

Program finding **F-12**, and **F-11** (do not rebuild the substrate).

50 node types exist, dual-language parity-gated. **Missing: Loop, Data, TTS, and any generic Agent** — Agent
exists only as ~13 fixed-purpose types; STT exists ×8 but all are registry-parity **placeholders** returning
`DEGRADED` (`interpreter/nodes/stt_placeholder.py`).

`temperature` / `maxTokens` / `topP` exist. **`frequency_penalty` / `presence_penalty` do not.**

`WorkflowNodeDescriptor` (`node-registry.ts:41-146`) has **zero tool/MCP fields** — the owner's *"tenant admin
can set some tools for agents to call"* has nowhere to live.

**Already landed and must be built on, not around:** TASK-852 items 3–4 folded `enabled` into
`NODE_RUNTIME_PROPERTIES` with a `mandatory`-class exclusion and a drift gate. TASK-846 delivered the
tenant-scoped `McpServer` registry plus its egress guard, so tool REFERENCES now have a real target.

## 3. Implementation Plan — as executed

Seven commits, one per numbered step. The plan's eight steps map onto them as noted.

### Step 1 — the port vocabulary and TIER 1 (`fc9208d3b`)

Two primitives had to exist before the generic node types could be typed at all:

- **`object`** — the unrefined STRUCTURED type. Every existing STRUCTURED port is a REFINEMENT (`entities` is
  an NER result, `edits` a correction set, `verdict` a guardrail decision, `context<schemaRef>` a bound
  context object). The generic Input/Output/Data nodes carry a TENANT-DEFINED schema, so their shape is not
  knowable at registry-authoring time and no refinement can name it honestly. All four now widen to it.
- **`audio`** — a STORED artifact, and a **sibling** of `stream<audio>`, not its supertype. Neither satisfies
  the other, so a live capture cannot be wired into a Temporal-dispatched batch transcriber and a stored file
  cannot be wired into the realtime lane. That is `06-python-services.md`'s determinism boundary expressed in
  the type lattice instead of in a comment.

`portKindOf` / `portKindsCompatible` are TIER 1 — the five-kind projection (`control | text | object | audio
| flag`) the canvas runs on every drag. **Deliberately coarser than the lattice**, and a test pins the gap
(`text -> transcript` is a kind match and a lattice error) so nobody promotes the pre-filter to the authority.

**Defect found and fixed in passing:** `portPrimitiveSatisfies`'s walk was `while (cursor !== null)`, which
terminates only for primitives listed in `WORKFLOW_PORT_SUPERTYPE`. A value outside the map reads `undefined`,
which is `!== null`, and the loop **spun forever** rather than returning `false`. Observed while adding
`object`, as a pegged test worker producing no output — a hang, not a wrong answer.

### Step 2 — the eight generic node types (`28d06f921`)

New palette `agentic`. Keys: `agentic.{input,output,agent,guardrail,data,loop,stt,tts}`. The ~13
fixed-purpose `agent.*` types stay registered and untouched (plan step 1: *"do not delete the fixed types"*).

Every binding is a ROW REFERENCE, and there is no key anywhere in the catalogue that could hold anything else:

| Config key | Resolves to |
|---|---|
| `providerConfigRef.routingPolicyId` | `AiRoutingPolicy.id` — connection + model + modelRef |
| `providerConfigRef.taskKey` | the tenant's elected default for that task, tenant → SYSTEM |
| `tools[].mcpServerId` | `McpServer.id` — `baseUrl`/`authRef`/`toolAllowlist` live there (TASK-846) |
| `guards.input[]` / `guards.output[]` | node ids in this graph |
| `pipelineRef.pipelineId` / `pipelineSlug` | `AsrPipeline` row |
| `promptTemplateId` + `promptVersionNumber` | an APPROVED, version-pinned template (DD-11) |

`agentic.agent` deliberately does NOT declare a top-level `taskKey`, so `withLlmBinding` does not fold in a
second `llmBinding` selection source — "bind to exactly one provider configuration" stays enforceable.

The parity fixture gained a **regenerator** (`scripts/regen-node-registry-snapshot.mjs`); hand-maintaining a
58-entry projection of a 58-entry table is how the two language sides drift. It regenerates the TypeScript
projection only — `registry.py` must still be edited, and the Python parity test is what proves it was.

### Step 3 — capability gating, selection source, loop bounds, the reference-only proof (`2fb964c68`)

New module `agentic-contract.ts`, holding the checks a JSON Schema cannot express. The reason each one cannot
is different, and the three reasons suggest different homes for future additions:

- **`exactly one of`** — the authorable subset requires a `discriminator.propertyName` on every `oneOf`, and
  `providerConfigRef`'s two shapes have no discriminating property (the shape IS which key is present).
- **cross-node references** — a per-node schema has no view of the graph.
- **provider capability** — the answer is DATA off a resolved row; this package has zero runtime dependencies.

### Step 4 — TIER 2 (`5a90265e0`)

`schema-compat.ts`. Warning-severity only, one level deep, composition keywords skip the pair entirely, and
the remedy (`agentic.data` on the edge) is named in the message.

### Step 5 — the Python half (`dcf7ed6ea`)

Eight `@activity.defn` callables in `interpreter/nodes/agentic.py`, registered in `registry.py` AND in
`NODE_ACTIVITIES` (two separate hand-maintained lists — registry decides what is DISPATCHED, the list what
the worker SERVES). See §6 for what each one actually does.

### Step 6 — the checksum move (`a5a1edc11`)

Both regen scripts run after rebuilding `@arcaai/workflow-contract`; both now report `DRIFT: 0`.

### Step 7 — the derived palette set (`ee5f6f311`)

`KNOWN_PALETTE_KEYS` gains `agentic` for free (it is derived from the registry). `EXPOSURE_ALLOWED_PALETTES`
is deliberately NOT widened, and the test now asserts that too.

### Step 8 — dual-language parity gate

Green in both languages: `node-registry-parity.test.ts` (TS) and `test_node_registry_parity.py` (Python) both
assert against the same regenerated `node-registry.snapshot.json`.

## 4. Verification Criteria — met

| Criterion | Result |
|---|---|
| Node-registry parity test green in BOTH languages | ✅ (evidence §6) |
| Canonical-JSON fixture test green | ✅ — part of the 1250-test suite |
| A graph using every new node type compiles to a valid IR | ✅ `reference-only.task847.test.ts` |
| A provider rejecting `presencePenalty` produces a clear validation error | ✅ `agentic-contract.task847.test.ts` |
| `pnpm --filter @arcaai/workflow-contract test` | ✅ 30 files / 1250 tests |
| `pnpm harness:test` incl. replay-compat | ✅ 1876 passed |
| `pnpm --filter @arcaai/database test` (seed moved) | ✅ 73 files / 1750 tests |
| Both regen scripts at `DRIFT: 0` | ✅ |

## 5. Risks — status

| Risk | Status |
|---|---|
| **A node schema stores a model id, endpoint or key in graph JSON** | **CLOSED, mechanically.** `forbiddenSchemaKeyProblems` + `compiledGraphLeakProblems`, both with not-vacuous tests. See §6. |
| Over-strict validation makes the editor unusable | Tier 2 warns only; `severity` typed as the literal `'WARNING'` so making it blocking is a deliberate type change |
| Fixed-purpose types and the generic node drift | Fixed types untouched and asserted present; deprecation path documented in `node-registry.ts` |
| Checksum move breaks the seed silently | Both scripts at `DRIFT: 0`, contract rebuilt first |

## 6. Implementation Summary

### Files changed

**`packages/workflow-contract/src/`**
- `port-model.ts` — `object` + `audio` primitives, `WORKFLOW_PORT_KINDS`/`portKindOf`/`portKindsCompatible`, supertype map, `portPrimitiveSatisfies` infinite-loop hardening
- `node-config-schemas.ts` — the eight `agentic.*` schemas (+466 lines)
- `node-registry.ts` — eight descriptors, `AGENTIC_PALETTE_KEY`, `AGENTIC_NODE_TYPES`
- `node-ports.ts` — ports for the eight
- `agentic-contract.ts` — **NEW.** Reference-only guard, capability gating, per-node structural checks
- `schema-compat.ts` — **NEW.** Tier 2
- `index.ts` — barrel
- `scripts/regen-node-registry-snapshot.mjs` — **NEW.** Parity-fixture regenerator
- `src/__tests__/` — 4 new spec files; `port-model`, `anti-laundering`, `node-config-schemas`, `node-eval-gate`, `node-registry-parity` pins updated; `fixtures/node-registry.snapshot.json` regenerated

**`apps/harness/src/harness/temporal/`**
- `interpreter/nodes/agentic.py` — **NEW.** Eight activities
- `interpreter/registry.py` — eight `NodeSpec` entries
- `interpreter/activities.py` — `*AGENTIC_ACTIVITIES` into `NODE_ACTIVITIES`
- `tests/unit/temporal/interpreter/test_agentic_nodes_task847.py` — **NEW.** 15 tests
- `tests/unit/temporal/interpreter/test_node_registry_parity.py` — key-list pin updated

**`packages/database/src/prisma/db_main/seed/`** — `21-workflow-definition.ts` (2 checksums by hand),
`23-arcaai-workflow-authoring.generated.ts` (regenerated)

**`packages/applications/`** — `workflow-definition.palette-key.test.ts` pin updated

### The have/missing table, closed out

| Owner's node type | F-12 state | Delivered as | Runtime |
|---|---|---|---|
| Input | palette-specific only (`input.context_binding`) | `agentic.input` | REAL |
| Output | palette-specific only (`output.deliver`) | `agentic.output` | REAL |
| Agent | **missing** (only ~13 fixed-purpose types) | `agentic.agent` | DELEGATES to `interpreter_text_generate` |
| Guardrail | palette-specific only (`guardrail.check`) | `agentic.guardrail` | DELEGATES to `interpreter_guardrail_check` |
| Data | **missing** | `agentic.data` | REAL |
| Loop | **missing** | `agentic.loop` | Observable `DEGRADED` → TASK-848 owns the body |
| STT | ×8 placeholders, all `DEGRADED` | `agentic.stt` | **REAL** — dispatches `dispatch_batch_transcription` |
| TTS | **missing** | `agentic.tts` | Observable `DEGRADED` → TASK-849 owns transport |
| `frequencyPenalty` / `presencePenalty` | **missing** | on `agentic.agent.generation` | capability-gated |
| tool / MCP fields on the descriptor | **zero** | `tools[]` = `(mcpServerId, toolName)` | reference-only |

**On the STT promotion.** The eight `stt.*` palette nodes stay placeholders, and that is correct rather than
unfinished: TASK-724 §1's central design decision is that a published `stt` `WorkflowDefinition` COMPILES
INTO an `AsrPipeline` row and is never walked node-by-node. Per-frame audio inside a Temporal workflow
violates rule 06's determinism constraint. `agentic.stt` is the other half of that design — ONE activity,
dispatching the existing TASK-724 Task 5 batch path, pipeline named by reference.

**On `implemented: true` for the two that do not run.** `compile()` REFUSES any graph containing an
`implemented: false` type, and the ticket's own criterion is that a graph using every new node type compiles.
So the choice was never "runs" vs "refused at compile" — it was an honest `DEGRADED` naming the owning ticket
versus a silent `SUCCEEDED` for work that never happened. `test_neither_ever_claims_to_have_produced_anything`
keeps it the first.

### Evidence

**Reference-only proof — direction 1 (schemas):**

```
✓ src/__tests__/reference-only.task847.test.ts (9 tests)
  ✓ declares a forbidden vocabulary covering credentials, endpoints and wire model ids
  ✓ finds no forbidden key in ANY node config schema in the registry
  ✓ would catch one if it were added — the check is not vacuous
```

**Direction 2 (the compiled artifact):**

```
  ✓ compiles a graph using every one of the eight new node types
  ✓ finds no credential and no endpoint anywhere in that compiled IR
  ✓ CATCHES a forbidden key smuggled into a node config
  ✓ CATCHES a resolved endpoint hiding under an innocent key name
  ✓ CATCHES a secret-shaped literal
  ✓ does NOT flag a uuid reference — that is the whole supported pattern
```

**`pnpm --filter @arcaai/workflow-contract test`**

```
 Test Files  30 passed (30)
      Tests  1250 passed (1250)
```

**`pnpm harness:test`**

```
================== 1876 passed, 1 warning in 93.46s (0:01:33) ==================
```

**`pnpm harness:lint` / `pnpm harness:typecheck`**

```
All checks passed!
Success: no issues found in 141 source files
```

**Python tests proven non-vacuous by mutation** — `interpreter_agentic_loop` forced to `SUCCEEDED` and the
Data node's required-mapping branch disabled:

```
FAILED .../test_agentic_nodes_task847.py::TestObservableNonExecution::test_the_loop_degrades_and_names_the_ticket_that_owns_the_body
FAILED .../test_agentic_nodes_task847.py::TestObservableNonExecution::test_neither_ever_claims_to_have_produced_anything
FAILED .../test_agentic_nodes_task847.py::TestDataNode::test_a_REQUIRED_mapping_that_does_not_resolve_DEGRADES_observably
============= 3 failed, 1873 passed, 1 warning in 90.49s (0:01:30) =============
```

Mutation reverted; suite back to 1876 passed.

**`pnpm --filter @arcaai/database test`**

```
 Test Files  73 passed (73)
      Tests  1750 passed (1750)
```

**`pnpm --filter @arcaai/applications test`**

```
 Test Files  631 passed | 1 skipped (632)
      Tests  10819 passed | 4 skipped (10823)
```

**Both regen scripts at DRIFT 0**

```
# regen-workflow-definition-seed.ts (REPORTS only; values applied by hand)
=== DRIFT: 0 ===

# regen-arcaai-consultation-workflow-seed.ts (WRITES)
=== REGISTRY_CHECKSUM ===
7469f6c609d8275141b45104ba218fec9ed6badcb26b4ece7c7087893029b292
=== GEN: validate() ok=true, 0 finding(s) · compile() 17 stage(s), 1 gate(s) ===
=== RHEUM: validate() ok=true, 0 finding(s) · compile() 18 stage(s), 1 gate(s) ===
```

Both graph checksums are UNCHANGED and `validate()` stays `ok=true` — only the registry checksum moved, which
is what an additive registry change should look like.

### Studio inspector — no code change needed, and why that is the right answer

The Studio pulls its node vocabulary from `GET /admin/workflow-nodes`
(`apps/admin-console/src/features/workflow-studio/api/client.ts:33`), a read-only projection of
`WORKFLOW_NODE_REGISTRY`, and compiles each descriptor's `configSchema` into inspector fields. `paletteKey` is
a free-text field on the create form. So the eight new node types, their config fields and the new palette all
appear with no UI edit — which is the property TASK-719's schema-driven inspector was built for. Wiring tier 2
into the validation rail and drawing the new port kinds on the canvas are UI work that belongs with the debug
canvas in TASK-849, not here.

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Plan written and aligned to TASK-837 §4 and OD-4. Awaiting approval before code. |
| 2026-09-01 | **Implemented.** Eight `agentic.*` node types across both languages; `object`/`audio` port primitives + tier-1 kind projection; `agentic-contract.ts` (reference-only guard, hyper-parameter capability gating, exactly-one selection source, three-axis loop bounds); `schema-compat.ts` (tier 2, warn-only); eight Python activities with the STT batch promotion; parity fixture regenerator; both seed checksums moved to `DRIFT: 0`. Fixed a pre-existing infinite loop in `portPrimitiveSatisfies` found while adding `object`. Status `Pending` → `Review`. |
