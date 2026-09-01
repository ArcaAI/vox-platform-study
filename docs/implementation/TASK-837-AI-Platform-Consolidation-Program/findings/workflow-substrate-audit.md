# Consultation-Workflow Substrate — Read-Only Audit (design input)

Repo: `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2` · branch `dev-2.2` · audited 2026-09-01.
Read-only: no file was modified. Every claim below cites `file:line`. `UNKNOWN` where evidence
was not found.

> **Bottom line for the orchestrator.** A generic, code-owned, graph-interpreting workflow
> substrate ALREADY EXISTS end to end: Prisma model → TS contract package (validator + compiler)
> → one Temporal `@workflow.defn` that walks the compiled graph → 50 registered node types →
> gateway REST + SSE exposure → an admin-console studio. It is a **staged DAG**, not an agentic
> loop; the loop that exists is **hand-coded and not graph-expressible**. Do not re-invent the
> registry, the compiler, the immutability model, or the port type lattice — extend them.

---

## A. EXECUTION MODEL VERDICT

**The graph is GENERICALLY INTERPRETED by ONE platform-owned Temporal workflow. It is not
hand-coded per workflow.**

`apps/harness/src/harness/temporal/interpreter/workflow.py:87-88` declares a single
`@workflow.defn(name="WorkflowInterpreter")`. Its body
(`workflow.py:119-181`) loads the published `compiledConfig` through an activity
(`load_config`, `workflow.py:123-128`), indexes every node's type
(`workflow.py:133-137`), then walks `config.stages` in order
(`workflow.py:142-155`). Each stage is an all-settled `asyncio.gather` fan-out
(`workflow.py:193-197`), and each node is dispatched by looking its type up in a
**code-owned registry** and executing the registry's activity — never a name off the wire:

```python
# workflow.py:254
spec = NODE_REGISTRY.get(node.type)
# workflow.py:283-289  — the wire's `activity` string is only a consistency check
if node.activity != spec.activity_name: ... SKIPPED "activity_mismatch"
# workflow.py:318-323
result = await workflow.execute_activity(spec.activity, activity_input, ...)
```

`NODE_REGISTRY` is `apps/harness/src/harness/temporal/interpreter/registry.py:186`.

**What the interpreter can express (v1), stated by its own docstring at `workflow.py:89`:**
*"Linear stage walk + single-level fan-out with an all-settled join. Nothing else (v1)."*
There is **no loop construct, no conditional branch, no dynamic sub-graph** in the interpreter.

The five OTHER `@workflow.defn` types in the harness are hand-coded and **outside** the graph
substrate: `HarnessPingWorkflow` (`workflows.py:273`), `HarnessDocWorkflow` (`workflows.py:291`),
`SpecialistWorkflow` (`workflows.py:1894`), `ConsultationLoopWorkflow` (`workflows.py:1968`), and
the interpreter's own child `ConsultationGateWorkflow`
(`interpreter/gate_workflow.py:101`). All six are registered on one worker,
`apps/harness/src/harness/temporal/worker.py:281-308`.

**The agentic loop already exists — as hand-written Python, not as a node.**
`ConsultationLoopWorkflow` (`workflows.py:1968`) is the long-lived per-consultation
orchestrator; `SpecialistWorkflow` (`workflows.py:1894`) is one sub-agent, started as a CHILD
workflow for its own history budget and failure domain. That is precisely the master/sub-agent
shape the target design wants from a `Loop` node — but **no graph node type maps to it**, and
the interpreter has no child-workflow dispatch except the one hard-wired HITL gate
(`workflow.py:353-401`). `registry.py`'s `NodeSpec` reserves a `kind` field for "a future
`child_workflow` dispatch" (`packages/workflow-contract/src/node-registry.ts:34-35`) — declared,
unimplemented.

**Task queue:** `harness-task-queue` (`apps/harness/src/harness/core/config.py:41`). Children are
started WITHOUT an explicit task queue so they inherit the parent's — all workflow types must
stay on this one worker (`worker.py:292-306`).

**Determinism / replay.** The interpreter module carries an explicit determinism checklist
(`interpreter/workflow.py:9-11`: no `datetime.now`, `random`, `uuid4`, `os.environ`, `httpx`, DB
or file I/O in the workflow module; every side effect through `execute_activity`). A
workflow-owned strided counter stands in for a clock/UUID (`workflow.py:56-60`, `113-117`). New
commands are gated behind `workflow.patched` — see `_GATE_PATCH = "task-731-hitl-gate"`
(`workflow.py:74`) and its guard `config.gates and workflow.patched(...)` (`workflow.py:162`),
with the rationale that the cheap operand is provably False on every pre-existing history
(`workflow.py:66-73`). **Replay-compatibility tests are a hard requirement**:
`apps/harness/src/harness/tests/unit/temporal/test_replay_compat.py`, with committed history
fixtures captured by `_capture_interpreter_replay_fixture.py` and `_capture_replay_fixture.py`
(same directory), plus `test_gating_consolidation_replay.py`.

**Retry / timeout policy is CAPPED BY CODE, not by tenant config.** Per-node values are clamped
through `caps.clamp_timeout` / `caps.clamp_attempts` (`workflow.py:296-297`,
`interpreter/caps.py`), and the compiled config carries a `CompiledCaps
{maxTotalSeconds, maxNodeSeconds, maxAttempts}` block
(`packages/workflow-contract/src/compiler.ts:77-81`). Defaults:
`DEFAULT_TIMEOUT_SECONDS = 60`, `DEFAULT_RETRY = {maximumAttempts: 1, initialIntervalSeconds: 1,
backoffCoefficient: 2}` (`compiler.ts:125-126`).

**Failure semantics.** `critical` and `externalWrite` are CODE-OWNED registry properties, never
tenant-configurable. A failing non-critical node is `DEGRADED`; a failing critical node is
`FAILED` and stops the walk after the current stage settles (`workflow.py:147-155`,
`324-346`). One thing deliberately escapes as a hard non-retryable `ApplicationError`: a graph
binding a socket the producer does not declare (`workflow.py:232-240`).

### Activity inventory (counts by file, `@activity.defn`)
| File | Count |
|---|---|
| `apps/harness/src/harness/temporal/activities.py` | 31 (legacy doc/loop/reasoning lanes) |
| `interpreter/activities.py` | 5 (incl. `load_config`) |
| `interpreter/nodes/agent_catalogue.py` | 11 |
| `interpreter/nodes/stt_placeholder.py` | 9 |
| `interpreter/nodes/consultation*.py` (6 files) | 14 |
| `interpreter/nodes/guards.py` | 3 |
| `interpreter/nodes/{context_binding,deliver,guardrail_check,template_ref,text_generate}.py` | 5 |

Registered on the worker as `DOCUMENT_ACTIVITIES`, `LOOP_ACTIVITIES`, `REASONING_ACTIVITIES`,
`INTERPRETER_ACTIVITIES` (`worker.py:310-316`).

---

## B. PERSISTENCE MODEL

### `WorkflowDefinition` — `packages/database/src/prisma/db_main/workflow-definition.prisma:53-137`

**Rows ARE versions.** Deliberately NOT the house head/version/pin triple used by
`PromptTemplate` or `ConsultationContextSchema` — recorded as a conscious divergence at
`workflow-definition.prisma:12-20`, because a published version IS the addressable product.

| Field | Line | Notes |
|---|---|---|
| `metaData` / `version` (`_version` OCC) / `id` (uuid7) | 55-57 | house meta block |
| `tenantId` | 60 | tenant-scoped, no FK |
| `slug`, `name`, `description` | 66-68 | `slug` is the LINEAGE key |
| `paletteKey` | 74 | a `String`, not an enum — palettes are code-registry data; unknown palette = 400 from the service (`:69-73`) |
| `versionNumber` | 76 | minted `max + 1` inside the publish transaction |
| `parentVersionId` | 80 | provenance edge, no `@relation`; a draft may branch from ANY published version |
| `status` | 82 | `WorkflowDefinitionStatus` — `DRAFT` default |
| **`graph` `Json @db.JsonB`** | 85 | **the canvas model, verbatim as authored — NEVER executed directly** |
| `graphChecksum` | 88 | sha256 over `canonicalJson(graph)`; drives idempotent republish |
| **`compiledConfig` `Json?`** | 93 | **the interpreter's input contract, produced SERVER-SIDE at publish; null until PUBLISHED; never accepted from a request DTO** |
| `compiledConfigChecksum` | 94 | |
| `registryChecksum` | 98 | sha256 of the node registry at publish; mismatch ⇒ `NEEDS_REVIEW` re-validation |
| `validationReport` `Json?`, `needsReview` | 101-102 | last server-side `ValidationReport` |
| `validatedAt`, `publishedAt`, `deprecatedAt` | 104-106 | |
| `isActive` | 116 | **the movable pointer** the dispatcher resolves for new runs; at most one true per `(tenantId, slug)` |
| resource status / audit / `tags` | 119-129 | house blocks |

Uniqueness `@@unique([tenantId, slug, versionNumber])` (`:132`); indexes on `tenantId`,
`(tenantId, slug, status)`, `(tenantId, slug, isActive)`, `parentVersionId` (`:133-136`).

**Node graph is a JSON BLOB, not normalized tables.** Shape is
`packages/workflow-contract/src/graph-model.ts:22-42`:

```ts
WorkflowGraphNode  { id, type, config: Record<string, unknown>, position?: {x, y} }
WorkflowGraphEdge  { id, from, fromPort, to, toPort }
WorkflowGraph      { version: 1, nodes[], edges[] }
```

Canvas coordinates are a **first-class sibling of `config`**, deliberately not smuggled inside
it (`graph-model.ts:11-15`) — a visual editor already has a sanctioned place to persist layout.
Authoring bounds: `MAX_GRAPH_NODES = 256`, `MAX_GRAPH_EDGES = 1024`, `MAX_GRAPH_DEPTH = 64`
(`graph-model.ts:48-50`); node ids must match `/^[a-z0-9_]{2,48}$/` (`graph-model.ts:45`).

**Immutability of PUBLISHED/DEPRECATED rows is enforced in FOUR layers**
(`workflow-definition.prisma:29-50`): a service guard (`assertMutable`), a DTO whitelist that
never declares the server-stamped columns, checksum drift-detection, and — uniquely in this
repo — a **DB `BEFORE UPDATE OR DELETE` trigger**
(`workflow_definition_immutability_guard`, in
`migrations/20260816090000_task_734_.../migration.sql`). This is the **first trigger in the
repo's migration history**. The `isActive` partial UNIQUE index lives only in that hand-written
SQL too. Known accepted cost: `prisma migrate diff` shows permanent drift against the schema
file (`:47-50`) — do not "fix" that.

### Publish lifecycle — `packages/applications/src/services/workflow-definition/workflow-definition.service.ts`
`create` (`:202`), `update` (`:276`, OCC via `@RequiresIfMatch()`), `validate` (`:341`),
`publish` (`:374`), `updateNodePrompt` (`:500`), private `validateGraph` (`:815`).

**There is NO `unpublish` method and no `deprecate` method** — grep found neither in the service
nor in `IWorkflowDefinitionService.ts`. Publish takes `dto.activate` (default `true`,
`:404-405`) which demotes the slug's previously ACTIVE version. So the shipped semantics are
*publish + activate / re-point*, **not publish/unpublish**. `deprecatedAt` exists as a column
with no writer found. **This is a real gap against the target requirement "publish/unpublish".**

### `WorkflowRun` — `workflow-run.prisma:63-144`
A denormalized CQRS-lite read model, one row per run: `workflowVersionId` (pins the exact
immutable definition row, `:73`), plus denormalized `workflowSlug` / `workflowVersionNumber` /
`definitionName` (`:74-76`) so the list renders after a rename. `sessionId` is the DERIVED
`"workflow-interpreter-" + runId` join key into `AgentTrajectoryStep` (`:78-81`); `runId` is the
domain run id (`:85`). `trigger` is a free `String` — *"consultation open | api invoke | webhook
| schedule"* (`:87-90`). `status` enum `RUNNING|COMPLETED|FAILED|CANCELED|TIMED_OUT`
(`:53-61`) — **no `DEGRADED` state**: degraded is a per-run FLAG `degradedNodeCount`
(`:44-50`, `:104`). `isSandbox` excludes Workbench runs (`:96`). `resultRef Json?` stores the
`output.deliver` node's output verbatim — a discriminated union of
`{resultRef: ClaimCheckRef}` or `{outputs: {...}}` (`:107-128`). No soft delete, no sys-events,
no `ResourceType` entry — deliberate (`:27-39`).

### `WorkflowAssignment` / `WorkflowAssignmentChange` — `workflow-assignment.prisma:34-107`
Says WHO uses a workflow, separate from WHAT it is. `(scope, scopeId)` over `PipelinePolicyScope`,
resolved by the same `walkCascade` first-set-wins walk as `PipelinePolicy`
(`:12-21`): department override → tenant default → SYSTEM platform default. Only DEPARTMENT and
TENANT tiers are exposed; DOCTOR is expressible but rejected by the service (`:17-19`).
`workflowDefinitionSlug` is a LINEAGE key — the ACTIVE PUBLISHED version resolves at dispatch,
so a republish moves every assignment forward (`:23-25`). `WorkflowAssignmentChange` is an
append-only WORM log with `UPDATE`/`DELETE` REVOKEd from the app role (`:27-31`).

### Other workflow tables
`workflow-invariant-rule.prisma`, `workflow-test-fixture.prisma` (both present in
`packages/database/src/prisma/db_main/`).

---

## C. NODE TYPE TABLE — implemented vs required

### The registry is DUAL-LANGUAGE and parity-gated
- TypeScript (gateway/Studio view): `packages/workflow-contract/src/node-registry.ts`,
  `WORKFLOW_NODE_REGISTRY` — **50 entries**.
- Python (runtime dispatch): `apps/harness/src/harness/temporal/interpreter/registry.py:186`,
  `NODE_REGISTRY` — same 50 keys.
- Neither imports the other; both assert against ONE committed fixture,
  `packages/workflow-contract/src/__tests__/fixtures/node-registry.snapshot.json`, via
  `node-registry-parity.test.ts` (TS) and `test_node_registry_parity.py` (Python)
  (`node-registry.ts:17-38`).
- The fixture carries only the 8 fields both runtimes share: `key`, `implemented`,
  `activityName`, `critical`, `externalWrite`, `defaultTimeoutSeconds`, `defaultMaxAttempts`,
  `entitlementKey` (`node-registry.ts:36-38`). Adding a field to one side without the other
  breaks the gate.

### `WorkflowNodeDescriptor` — the node schema (`node-registry.ts:48-120+`)
`key` · `implemented` · `activityName` · `classes[]` · `paletteKey` · `critical` ·
`externalWrite` · `defaultTimeoutSeconds` · `defaultMaxAttempts` · `entitlementKey` ·
`configSchema?` (JSON Schema) · `inputs[]` / `outputs[]` (typed ports) · `trigger`
(`on-start` | `per-turn` | `on-end`) · `lane` (`durable` | `realtime`) · `requires[]` (guard
attachment keys) · plus `schemaVersion` / `idempotent` / `evalGate`.

`lane` is **load-bearing**, not descriptive: `durable` ⇒ the Temporal interpreter dispatches it;
`realtime` ⇒ TASK-811's live executor runs it and the interpreter SKIPS it with
`reason: 'realtime_lane'` (`node-registry.ts:105-116`, enforced at
`interpreter/workflow.py:273-279`). **Exactly one runtime executes any given node.**

Ports: `packages/workflow-contract/src/node-ports.ts` (`NODE_PORTS`), typed by
`port-model.ts` (`WORKFLOW_PORT_PRIMITIVES`, `WORKFLOW_PORT_SUPERTYPE`,
`portPrimitiveSatisfies`) and checked by `port-validation.ts`. Every non-`control` OUTPUT port
declares an `outputKey` — the runtime dict key it actually carries — which is how the canvas's
socket names and the activity's output shape are reconciled (TASK-809 OD-15 option A).
`outputKey` is typed `?: never` on a `control` port, so the rule is enforced by the TYPE.
The anti-laundering property (`document → ner` is a TYPE ERROR) is a property of
`portPrimitiveSatisfies` + the port tables, asserted in `__tests__/anti-laundering.test.ts`
(`packages/workflow-contract/src/index.ts:44-47`).

### The 50 implemented node types

**Palette-agnostic (`paletteKey: null`)** — `noop` (`:160`), `passthrough` (`:177`),
`core.start` (`:206`, `boundary`, `on-start`), `core.end` (`:223`, `boundary`, `on-end`),
`guard.phi` (`:1202`), `guard.moderation` (`:1219`), `guard.groundedness` (`:1236`).

**`summarization` palette (5)** — `input.context_binding` (`:259`), `prompt.template_ref`
(`:276`), `generate.text` (`:293`, `generation`+`mandatory`), `guardrail.check` (`:310`),
`output.deliver` (`:327`, `externalWrite: true`).

**`stt` palette (8)** — `stt.audioInput` (`:353`), `stt.vad` (`:370`), `stt.noiseFilter`
(`:387`), `stt.diarization` (`:404`), `stt.languageDetection` (`:421`), `stt.asrEngine`
(`:438`), `stt.transcriptOutput` (`:455`, `externalWrite`), `stt.phiHop` (`:473`,
**`implemented: false`** — a documented placeholder; `compile()` refuses any graph containing it).

**`consultation` palette (30)** — `consultation.consentGate` (`:509`), `.captureBinding`
(`:526`, **lane realtime**), `.extractEntities` (`:545`, **realtime**), `.bindTerminology`
(`:562`), `.phiHop` (`:579`), `.retrieveEvidence` (`:596`), `.assemblePrompt` (`:613`),
`.synthesize` (`:630`), `.sensors` (`:647`), `.inferentialSensors` (`:664`), `.persistDraft`
(`:681`), `.finalizeAssurance` (`:698`), `.hitlGate` (`:721`, class `gate`), `.realtimeSummary`
(`:750`, **realtime**), `.suggestions` (`:771`), `.proposeCorrections` (`:789`);
endpoint nodes `session.timeout` (`:836`), `summary.finalize` (`:855`), `feedback.capture`
(`:873`); and the `agent.*` catalogue: `agent.transcription` (`:925`, **realtime**),
`.normalization` (`:948`), `.ner` (`:965`, **realtime**), `.grammar` (`:1006`, **realtime**),
`.important_findings` (`:1056`, **realtime**), `.presummarization` (`:1091`), `.summarization`
(`:1108`), `.discharge_summary` (`:1125`), `.retrieval` (`:1142`), `.feedback` (`:1159`),
`.dna_redaction` (`:1180`).

Guard attachment is declared per node type via `requires[]` and checked **per instance** at
publish by `workflowPublishProblems`: the three `agent.*` generation entries require
`guard.groundedness`, and `agent.transcription` requires `guard.phi` (`node-registry.ts:118-120`).

### HAVE / MISSING vs the 8 required node types

| Required | Have today | Evidence | Gap |
|---|---|---|---|
| **Agent** | **PARTIAL — many fixed-purpose agents, no generic one.** `generate.text` (`node-registry.ts:293`), `consultation.synthesize` (`:630`), and 10 `agent.*` entries (`:925-1191`) | each is a distinct registry key with its own activity + config schema | **No single generic `Agent` node.** Each "agent" is a code-owned type with a hard-wired activity. A tenant cannot add a new agent without a code change + parity fixture update + deploy. |
| **Input** | **YES** — `input.context_binding` (`:259`) | config schema `node-config-schemas.ts:51-110`: `contextSchema.kinds[]` with `key/label/primitive/phiClass/cardinality/lifecycle/producedBy` + `bindings[]` | Primitives limited to `TEXT` \| `STRUCTURED` (`:78`). **Not arbitrary tenant JSON Schema.** |
| **Output** | **YES** — `output.deliver` (`:327`, `externalWrite: true`) | config schema `node-config-schemas.ts:313-338`: `outputs[]` of `{key, label, description, primitive}` | Same 2-primitive limit (`:333`). No JSON-Schema-shaped output contract. |
| **Data** | **NO dedicated node.** Nearest: `consultation.retrieveEvidence` (`:596`) and `agent.retrieval` (`:1142`) | | **MISSING** as a first-class type. |
| **Loop** | **NO.** The interpreter is *"Linear stage walk + single-level fan-out … Nothing else (v1)"* (`interpreter/workflow.py:89`) | hand-coded `ConsultationLoopWorkflow` (`workflows.py:1968`) + `SpecialistWorkflow` (`workflows.py:1894`) exist OUTSIDE the graph | **THE BIGGEST GAP.** No loop node, no `max_iterations`/`max_time` in the graph vocabulary, no child-workflow dispatch from the interpreter except the one hard-wired HITL gate (`workflow.py:353`). `NodeSpec.kind` is reserved for a future `child_workflow` dispatch but unimplemented (`node-registry.ts:34-35`). |
| **Guardrail** | **YES, three kinds** — `guardrail.check` (`:310`, calls `apps/guardrail` directly) plus `guard.phi` / `guard.moderation` / `guard.groundedness` (`:1202-1247`) | `interpreter/nodes/guardrail_check.py`, `nodes/guards.py` | Attachment is `requires[]` at publish (per instance), NOT an input/output slot on the agent node. Target wants "optional guardrail nodes on an agent's input/output" — expressible as edges today, but there is no notion of *input-side* vs *output-side* guard. |
| **STT agent** | **PARTIAL** — 8 `stt.*` nodes forming a pipeline (`:353-484`), plus `agent.transcription` (`:925`, realtime) | | `stt.phiHop` is `implemented: false`. All 8 `stt.*` are `lane: durable` — i.e. **the STT palette does not stream** through the interpreter. |
| **TTS agent** | **NO.** grep of `node-registry.ts` finds **zero `tts.*` entries** | `apps/tts` exists as a service (port 8865) | **MISSING** entirely from the node vocabulary. |

**Hyper-parameters:** `temperature` (0-2), `maxTokens`, `topP` are declared on the generation
schemas (`node-config-schemas.ts:280-282`, `721-723`, `807-808`, `828-829`, `845-846`).
**`frequency_penalty` and `presence_penalty` do NOT exist anywhere** in the config schemas.

**Provider binding (DD-10):** a generation node does NOT bind an `AiProviderConnection` directly.
It declares `taskKey ∈ {text.finalize, text.live, text.test}` (`node-config-schemas.ts:276`) which
selects an `AiTaskDefault` routing key resolved tenant → SYSTEM (`:992`), plus an optional
per-node `modelSlug` override that **fails closed** if it does not resolve to an ENABLED model
(`:1301-1304`). So "each agent node binds exactly ONE provider configuration" is *nearly*
satisfied, but through the `taskKey`/`AiModel.slug` indirection, not a direct connection id —
which is correct per the platform's tenant→SYSTEM config rule.

---
## D. STUDIO UI STATE

**There is already a real, canvas-based, well-tested visual workflow editor. It is NOT a
form-based editor.** Do not build a new one — extend this.

### Graph library
`@xyflow/react@^12.11.3` (React Flow v12, MIT). Declared as a dependency of **`packages/ui`**
(`packages/ui/package.json:133`) — **NOT** of `apps/admin-console` (absent from its
`package.json`). It is consumed only through the subpath export
`@arcaai/ui/components/workflow-canvas`, deliberately kept off the root barrel
(`packages/ui/src/components/workflow-canvas/DEPENDENCY.md`, which records the rejected
alternatives: `reactflow` v11, hand-rolled SVG/canvas, `@dnd-kit`).

Canvas primitive: `packages/ui/src/components/workflow-canvas/{workflow-canvas.tsx,
workflow-node.tsx, workflow-edge.tsx, canvas-controls.tsx, types.ts, canvas-tokens.css}` — a
themed, props-in/callbacks-out wrapper holding no graph state of its own, bridged to the
Tailwind tokens through `--workflow-canvas-*` CSS variables (both themes).

**No `elkjs` / `dagre` / `cytoscape` / `d3` / `mermaid` anywhere in the repo** — there is no
auto-layout. `features/workflow-runs/lib/graph-layout.ts` does its own trivial layout.

### Routes
| Path | File | Renders |
|---|---|---|
| `/workflow-studio` | `apps/admin-console/src/app/(console)/(tenant)/workflow-studio/page.tsx:8` | `DefinitionsListScreen` — data grid of definitions; "New definition"; "Assignments"; "Endpoint sequence" drawer |
| `/workflow-studio/[definitionId]` | `.../[definitionId]/page.tsx:10` | `WorkflowStudioScreen` → `'new'` ⇒ `CreateDefinitionForm`, else `WorkflowStudioEditor` (the canvas) |
| `/workflow-studio/assignments` | `.../assignments/page.tsx:8` | `AssignmentMatrixScreen` — department × palette matrix with inheritance source |
| `/workflow-runs` | `.../workflow-runs/page.tsx:8` | `WorkflowRunsScreen` |
| `/workflow-runs/[runId]` | `.../[runId]/page.tsx:9` | `RunTraceScreen` |
| `/context-schemas` | `.../context-schemas/page.tsx` | `ContextSchemasScreen` |
| `/harness/workflows` | `.../harness/workflows/page.tsx` | **A DIFFERENT, older resource** (`HarnessWorkflow`, raw Temporal ops) — do not conflate |

All are tier 30-49 and wrapped in `WorkingTenantGate`.

### Editor capability table
| Capability | Exists | Evidence |
|---|---|---|
| Registry-driven node palette, grouped by `paletteKey`, searchable | YES | `features/workflow-studio/components/palette/palette-rail.tsx:49`, filter `:81-90`, grouping `:32-41` |
| Drag-to-add from palette | YES | `palette-item.tsx` → `workflow-studio-editor.tsx:365-370` |
| Drag node positions on canvas | YES | `workflow-canvas.tsx:250`; `onNodesChange` → `moveNode` at `workflow-studio-editor.tsx:407-409` |
| Drag-to-connect edges | YES | `workflow-canvas.tsx:247,251`; commit `workflow-studio-editor.tsx:395-406` |
| **Typed ports rendered as distinct handles** | **NO — PARTIAL** | `workflow-node.tsx:69-70` renders exactly ONE input handle (left) + ONE output handle (right) per node. Named ports live in the DATA model (`sourceHandle`/`targetHandle` defaulted to `'out'`/`'in'`, `workflow-studio-editor.tsx:225-227,399-401`) and are type-checked, but **multi-port nodes are visually indistinguishable** |
| Drag-time connection validation (type lattice) | YES | `workflow-canvas.tsx:204-216` (`isValidConnection`); predicate `workflow-studio-editor.tsx:221-242` → store `canConnect` → `lib/port-compatibility.ts:98` |
| Deduped toast on invalid connection | YES | `workflow-studio-editor.tsx:220,234-238` |
| Schema-driven inspector for the selected node | YES | `components/inspector/inspector-panel.tsx:128` (`toFieldDescriptors`), raw-JSON `CodeEditor` fallback when no schema `:154-160`, plus `DocumentBindingField` + `PromptTemplatePicker` |
| Per-field server findings in the inspector | YES | `inspector-panel.tsx:63-65,174-183` (matches `WorkflowFinding.path`) |
| Server-side Validate + findings rail | YES | `workflow-studio-editor.tsx:247-258`; `components/validation/validation-rail.tsx:36` |
| Click a finding → focus the node | YES | `components/validation/use-focus-node.ts`; wired `workflow-studio-editor.tsx:199,443` |
| Publish (gated on a clean report, with "make active" switch) | YES | `components/publish-dialog.tsx:19`; call `workflow-studio-editor.tsx:260-272`; gate `validation-rail.tsx:25-29` |
| **Unpublish / deprecate** | **NO** | No button in the editor; no service method (§B). Published/Deprecated rows are read-only (`workflow-studio-editor.tsx:101,332`) |
| Create-new-version from a published row | YES | `workflow-studio-editor.tsx:177-192` (clones the frozen graph into a new DRAFT) |
| **Version LIST UI** | **NO — dead API** | `api/hooks.ts:48-50` exports `useWorkflowDefinitionVersions` with **zero call sites**. `features/context-schemas/components/versions-panel.tsx` is the working reference pattern (pin/rollback + skew badges) |
| Version diff / compare | NO | none found |
| Undo / redo (bounded snapshot stack) | YES | `store/create-graph-store.ts:38-39,75-76,246-267`; toolbar `studio-toolbar.tsx:110-115`; `hooks/use-studio-shortcuts.ts` |
| Duplicate node / delete node (mandatory nodes refused) | YES | `create-graph-store.ts:55,167`; `workflow-node.tsx:75-88`; `create-graph-store.ts:49,145` |
| Debounced autosave with ETag/If-Match OCC + conflict banner | YES | `hooks/use-autosave.ts`; `workflow-studio-editor.tsx:123-142`; `OccConflictAlert` `:310` |
| Unsaved-changes navigation guard | YES | `hooks/use-unsaved-changes-guard.ts`; `workflow-studio-editor.tsx:159` |
| **Canvas / List dual view mode** | YES — **load-bearing a11y**, not legacy | `store/types.ts` `WorkflowStudioViewMode`; `components/list-editor/graph-list-editor.tsx:1-8` gives every canvas mutation a real `<button>` (WCAG 2.5.7); toggle `studio-toolbar.tsx:89-106`; URL-synced `?view=` (`workflow-studio-editor.tsx:164-172`) |
| Zoom / pan / fit-view | YES | `canvas-controls.tsx:13` wraps xyflow `<Controls>` |
| Minimap | NO | `<MiniMap>` never rendered |
| Multi-select / bulk ops / copy-paste across definitions | NO | not found |
| Auto-layout | NO | no layout library in the repo |
| **Debug / test-run panel inside the Studio** | **NO — deep-links out** | `studio-toolbar.tsx:121-134` is a plain `<a href>` to `/playground/workbench?definitionId=…`. Deliberate: rule 13's "one authoritative editor per backend resource" (`studio-toolbar.tsx:27-33`) |
| Prompt-binding drift rail | YES | `components/prompt-bindings/prompt-bindings-rail.tsx` |
| a11y: focusable nodes, `role="application"`, `aria-describedby` validation summary, reduced-motion | YES | `workflow-canvas.tsx:108-113,236-239` |

### Feature-module inventory (absolute paths)
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/admin-console/src/features/workflow-studio/` — `api/{client,hooks,keys,types,endpoint-sequence,index}.ts`; `components/{create-definition-form,definition-metadata-form,definitions-list-screen,publish-dialog,studio-toolbar,workflow-studio-editor,workflow-studio-screen}.tsx`; `components/{assignments,endpoint-sequence,inspector,list-editor,palette,prompt-bindings,validation}/`; `hooks/{use-autosave,use-studio-shortcuts,use-unsaved-changes-guard}.ts`; `lib/{assignment-cascade,document-binding,graph-serialization,port-compatibility,schema-form}.ts`; `store/{create-graph-store,graph-store-provider,selectors,types}.ts`; extensive `__tests__/`.
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/admin-console/src/features/workflow-runs/` — `api/{client,hooks,keys,polling,types}.ts`; `components/{attempt-group,failure-panel,gate-approval-panel,node-run-badge,run-node-detail-drawer,run-status-badge,run-trace-list-view,run-trace-screen,trace-pruned-state,workflow-runs-screen}.tsx`; `lib/{graph-layout,rollup-correlation}.ts`.
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/admin-console/src/features/workbench/` — sandbox test-run surface; `components/{fixture-picker,node-run-inspector,related-playgrounds,run-panel,sandbox-badge,workbench-screen}.tsx`.
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/apps/admin-console/src/features/context-schemas/` — incl. `components/{definition-editor,kind-form,output-form,payload-tester,versions-panel}.tsx`.
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/ui/src/components/workflow-canvas/` — the canvas primitive + `DEPENDENCY.md` + `__tests__/workflow-canvas.vitest.tsx`.

### Runs + observability UI
- **List** `/workflow-runs`: `VirtualizedDataGrid`, cursor pagination, filters (slug, status, trigger, date range, include-sandbox). Source: `useWorkflowRuns` → `GET /admin/workflow-runs` (`features/workflow-runs/api/hooks.ts:9-16`) — i.e. the **`WorkflowRun` Prisma read model**, not Temporal directly.
- **Detail** `/workflow-runs/[runId]`: a **read-only React Flow canvas of the run's pinned immutable graph** with per-node `NodeRunBadge` overlays (STARTED/OK/ERROR/SKIPPED/TIMEOUT, duration, attempts, degraded — icon+color, never color alone) — `run-trace-screen.tsx:201-204`, `node-run-badge.tsx:40`. Plus `RunTraceListView` (a11y peer), `RunNodeDetailDrawer`, `GateApprovalPanel` (HITL sign-off, `api/hooks.ts:57-71,77-87`), `FailurePanel`, and `TracePrunedState` (honest empty state — run rows outlive their `AgentTrajectoryStep` rows under retention, `workflow-runs-screen.tsx:45-55`).
- **LIVE VIEW: polling only, no SSE.** `features/workflow-runs/api/polling.ts:14` `RUN_POLL_INTERVAL_MS = 5000`; `:25-28` / `:31-34` poll only while `RUNNING` and foreground; wired via TanStack `refetchInterval` (`api/hooks.ts:13,23,34,62-67`, `refetchIntervalInBackground: false`). The footer says so: `run-trace-screen.tsx:163` — `"Live · polling while running"` vs `"Terminal run — not polling"`.
- **Real SSE exists, but only in Workbench (sandbox).** `features/workbench/components/run-panel.tsx:8,64-95` uses the shared `useEventStream` hook (`@/shared/streams`, ticket-authenticated direct-to-gateway) against
  `admin/workflow-definitions/:id/sandbox-runs/:runId/stream` (`run-panel.tsx:61`). Production runs never adopted it.

---

## E. STREAMING MATRIX

### Gateway streaming inventory (the reusable plumbing)
| Surface | Protocol | Path | Auth | Evidence |
|---|---|---|---|---|
| Workflow run status | SSE (**2s POLL bridge**) | `GET /workflows/:slug/runs/:runId/stream` | JWT or `?ticket=` (`workflow_run:<runId>`) | `apps/api/src/modules/workflows/workflows.controller.ts:112-125`; `workflow-stream.service.ts:9,16-43` |
| Sandbox run | SSE | `admin/workflow-definitions/:id/sandbox-runs/:runId/stream` | ticket | `apps/api/src/modules/workflow-sandbox-run/*.controller.ts:79` |
| Consultation live summary | SSE | `GET /consultations/:id/live-summary/stream` | JWT / ticket `consultation_live_summary:<id>` | `apps/api/src/modules/consultation/consultation.controller.ts:743-753` |
| Consultation live-assist | SSE | `.../live-assist/stream` | ticket `consultation_live_assist:<id>` | `consultation.controller.ts:770-791` |
| Harness draft progress | SSE | `.../harness-progress/stream` | ticket | `consultation.controller.ts:791-810` |
| Harness assurance | SSE | `.../harness-assurance/stream` | ticket | `consultation.controller.ts:810-831` |
| Agent trajectory | SSE | `.../trajectory/stream` | ticket | `consultation.controller.ts:831-857` |
| Consultation-loop events | SSE | `.../loop/stream` | ticket `consultation_loop:<id>` | `consultation.controller.ts:857-880` |
| Text generation (token-level, resumable) | SSE proxied from `apps/text` | `GET /text-generations/{generations/:id,tasks/:taskId}/stream` | JWT or ticket `text_task:<taskId>` | `apps/api/src/modules/streaming/text-proxy.controller.ts:746-753`; producer `apps/text/src/text/api/endpoints/stream.py:377-430` (`sse_starlette`, Redis message-id resume) |
| STT live transcription | WebSocket | `/ws/stt/stream` | single-use ticket consumed at handshake | `apps/api/src/modules/streaming/stt-ws.gateway.ts:208,464`; transport `apps/stt/src/stt/streaming/redis_streams.py:73-96` (`stt:audio/result/control:{sid}`) |
| TTS streaming synthesis | WebSocket | `/ws/tts/stream` | ticket + injected `X-Service-Token` | `apps/api/src/modules/speech/tts-ws.gateway.ts:106`; upstream `apps/tts/src/tts/api/endpoints/stream_ws.py:1-45`, OpenAI-compatible `apps/tts/src/tts/api/endpoints/speech.py:43,145,180` |

### How a running Temporal workflow's partial output reaches a client TODAY
**Not through Temporal.** The interpreter exposes `@workflow.query(name="state")` and
`@workflow.signal(name="cancel")` (`interpreter/workflow.py:475-485`), and the loop/gate
workflows expose their own signals/queries (`workflows.py:2061-2097`,
`gate_workflow.py:110-118`) — but all are **pull-only**, and the gateway never holds a Temporal
client on behalf of a browser.

The real mechanism is a **two-hop HTTP-POST → Redis pub/sub relay** entirely outside Temporal's
transport: an activity calls `apps/harness/src/harness/services/api_client.py:939-990`
(`publish_live_summary`, `publish_live_assist`, progress/assurance/loop variants) which POSTs to
`/internal/harness/consultations/:id/…`; the gateway relays the body verbatim onto
`consultation:{live-summary,live-assist,harness-progress,harness-assurance,loop,trajectory}:{id}`;
the gateway's own `@Sse()` routes are already subscribed and relay to the browser.

**Only nodes whose activity explicitly calls `publish_*` stream at all** — today that is
`consultation.suggestions` and `consultation.proposeCorrections`
(`interpreter/nodes/consultation_realtime.py:551-577,773-802`). A generic generation node
streams nothing.

**The `/workflows/:slug/runs/:runId/stream` SSE is honest polling, not push.**
`WorkflowStreamService` documents this at length: the harness dispatcher
(`apps/harness/src/harness/api/endpoints/interpreter.py`) exposes only `POST …:start`,
`GET …/{runId}` (plain JSON) and `POST …:cancel`, so there is nothing to byte-pipe; TASK-717
shipped the envelope + resume-token package but **deferred "Phase C" (a reference producer)**
(`workflow-stream.service.ts:17-43`). Poll interval 2000 ms (`:9`), heartbeat 15000 ms (`:14`).
No `Last-Event-ID` resume — deliberately, because minting a resume token for a non-resumable
transport is forbidden by the async-contract (`:36-42`).

### TASK-811 realtime lane — a SECOND execution engine, not a streaming mode of Temporal
`RealtimeExecutor` is a **synchronous in-process TypeScript graph executor running inside the
NestJS gateway**: `packages/applications/src/services/consultation/live-documentation/realtime/
{realtime-lane.ts, realtime-executor.ts, realtime-node-registry.ts}`, invoked from
`LiveDocumentationService.flush()`. It walks the SAME compiled graph, filtered to nodes whose
descriptor `lane === 'realtime'` (`realtime-lane.ts:1-45`; `REALTIME_NODE_TYPES` derived at
`realtime-node-registry.ts:53`). Because it runs in the same process as the SSE route it
publishes `section.patch` events directly onto `consultation:live-summary:{id}`
(`live-documentation.service.ts:318`) with no HTTP hop.

**The partition is structurally enforced in both directions**: the interpreter hard-skips any
`lane: 'realtime'` node (`interpreter/workflow.py:271-279`), and the realtime lane executes only
those. It has **no durability and no restart compensation for any node**
(`packages/workflow-contract/src/port-validation.ts:176-182`).

### Node-kind streaming matrix
| Node kind | Can stream today | Mechanism |
|---|---|---|
| **Agent (LLM), `lane: durable`** | **Only if hand-instrumented** | Activity must call `ApiClient.publish_live_summary` / `publish_live_assist` → Redis → SSE. Today only `consultation.suggestions`, `consultation.proposeCorrections`. `generate.text` / `consultation.synthesize` return whole at stage end |
| **Agent (LLM), `lane: realtime`** | **YES** | `RealtimeExecutor` in-process → `section.patch` on `consultation:live-summary:{id}` (`consultation.realtimeSummary`) |
| **Agent — token-level** | **NO through a node** | `apps/text` HAS full token SSE with Redis-message-id resume (`stream.py:377-430`, proxied by `text-proxy.controller.ts:746`) — but it is a client-facing API, never wired as a node output |
| **STT** | **NONE at node level** | All 8 `stt.*` are `lane: durable` and `interpreter/nodes/stt_placeholder.py` is a **deliberate placeholder** — an STT graph compiles to an `AsrPipeline` YAML side-channel. Real STT streaming (`/ws/stt/stream` + Redis Streams) is a standalone feature outside the node model |
| **TTS** | **NONE** | Zero `tts.*` entries in `node-registry.ts`. `apps/tts` streaming exists but is unreachable from a workflow node |
| **Output / endpoint** | **Progress only, never content** | `lane: durable`, `trigger: on-end`; the artifact is delivered whole. `harness-progress` / `harness-assurance` SSE stream metadata around them |
| **Loop** | **Metadata only, structurally** | `consultation:loop:{id}` → `GET /consultations/:id/loop/stream` (`consultation.controller.ts:857-880`). `EmitLoopEventInput` is `ConfigDict(extra="forbid")` and is documented as *"ids/keys/labels only … a live UI feed, not a PHI transport"* (`apps/harness/src/harness/temporal/models.py:1514`) — **it can never carry clinical text** |

---

## F. INVOCATION MATRIX

> **Terminology trap the orchestrator must internalise.** "Workflow" means three different
> things in this repo: (1) the **exposure-plane** `WorkflowDefinition`/`WorkflowRun` invoked at
> `/api/v1/workflows/:slug/…`; (2) **consultation-governing selection** (which definition
> governs a session, TASK-813); (3) **raw Temporal ops** at `/admin/harness/workflows/*`. The
> four required entry points concern sense (1) only.

| Entry point | Exists today | Where | Streaming |
|---|---|---|---|
| **1. Inbound webhook trigger** | **NO** | nothing — no route, no receiver, no signature-verify-then-dispatch | n/a |
| 1b. *Outbound* webhook delivery (a different feature) | YES | `apps/api/src/modules/webhook/webhook.controller.ts:1-176` (admin CRUD, `@ForbidApiKey()` at `:30`) + `WebhookDeliveryProcessor` / `WebhookDeliveryDispatchProcessor` | n/a — fire-and-forget signed POST |
| **2. REST + API key** | **YES — but OFF by default** | `apps/api/src/modules/workflows/workflows.controller.ts:37-126` | YES (SSE, poll-bridged) |
| **3. SDK Vox (browser)** | **NO for invocation** | only consultation-governance hooks (sense 2) | NO |
| **4. SDK Vox-node** | **NO for the business plane** | only generated admin resources (service-account only) | NO |

### 2 — the exposure plane, route by route
All five carry BOTH an authorization decorator and `@RequiredScopes`; none carries
`@ForbidApiKey()`. This is the ONE workflow surface an API key can reach.

| Route | Guards | API key | `route-manifest.json` |
|---|---|---|---|
| `GET /api/v1/workflows` | `@CanList('WorkflowDefinition')` + `workflow:definition:read` (`:44-51`) | YES | `:14955-14976` |
| `POST /api/v1/workflows/{slug}/invoke` | `@CanCreate('WorkflowRun')` + `workflow:run:write` + `@Throttle({heavy: 20/60s})` (`:53-85`) | YES | `:14978-14999` |
| `GET /api/v1/workflows/{slug}/runs/{runId}` | `@CanRead('WorkflowRun')` + `workflow:run:read` (`:87-97`) | YES | `:15001-15022` |
| `POST /api/v1/workflows/{slug}/runs/{runId}/cancel` | `@CanUpdate('WorkflowRun')` + `workflow:run:write` (`:99-110`) | YES | `:15024-15045` |
| `GET /api/v1/workflows/{slug}/runs/{runId}/stream` | `@CanRead('WorkflowRun')` + `workflow:run:read` + `@StreamScope({namespace:'workflow_run', param:'runId'})` (`:112-125`) | YES | `:15047-15068` |

All five: `isPublic: false`, `svcScopes: []` — **service accounts are deny-by-default on the
exposure plane**. `tenantId` never appears as a route/query/body parameter (resolved from CLS
only); cross-tenant / unpublished / unknown slug ⇒ 404, scope violation ⇒ 403.

**KILL-SWITCH:** the whole surface is gated by `WORKFLOW_EXPOSURE_ENABLED`, currently **`false`**
— `packages/applications/src/services/workflow-exposure/workflow-exposure.service.ts:229-232`;
descriptor `packages/applications/src/services/settings-registry/descriptors/
feature-flags.descriptors.ts:77`; `.env.dev:286` `false`, `.env.sample:293` `false`,
`.env.test:2498` `true`. While off, every route 404s (existence not disclosed).

### Admin-plane workflow controllers (governance/observability, NOT invocation — all `@ForbidApiKey()`)
`WorkflowDefinitionController` (`admin/workflow-definitions`, `@ForbidApiKey()` at `:34`,
`@CanManage('WorkflowDefinition')` at `:37`; routes `POST /`, `GET /`, `GET /:id`,
`GET /:id/versions`, `PATCH /:id` + `@RequiresIfMatch()`, `DELETE /:id`, `POST /:id/validate`,
`POST /:id/publish`, `GET /:id/prompt-bindings`, `PUT /:id/nodes/:nodeId/prompt`) ·
`WorkflowRunController` (`:44`, `svc:admin:workflow-run:read`; `GET /`, `GET /:runId`,
`GET /:runId/trace`, `GET /:runId/gate`, `POST /:runId/gate/approve` with an
`AUTH-NOTE` imperative override `@Authorize(['update','Consultation'])` at `:138-139`) ·
`WorkflowNodeController` (`admin/workflow-nodes`, `GET /` — the registry surface the Studio
palette consumes) · `WorkflowSandboxRunController`
(`admin/workflow-definitions/:definitionId/sandbox-runs`, incl. `GET /:runId/stream`) ·
`WorkflowAssignmentController` · `WorkflowInvariantRuleController` ·
`WorkflowTestFixtureController`.

### 3 — SDK Vox (`packages/agentic-sdk-v2`)
No hook, client method or type calls `/workflows/:slug/invoke` or its stream. What exists is the
**consultation-governance** surface only:
`useConsultationWorkflow` (`src/hooks/useConsultationWorkflow.ts:50-83`, `GET /consultations/:id/workflow`),
`useSelectableConsultationWorkflows` (`src/hooks/useSelectableConsultationWorkflows.ts:49-82`,
`GET /consultations/workflows`), and `OpenSessionInput.workflowDefinitionSlug?`
(`src/types/consultation.ts:123-144`) — invocation as an implicit side effect of `session.open()`.
`useHarnessAdmin().listWorkflows` (`src/hooks/useHarnessAdmin.ts:114-198`) is raw Temporal ops.

### 4 — SDK Vox-node (`packages/vox-node`)
Business plane exports are exactly `SummarizationResource`, `ConsultationSummariesResource`,
`JobsResource`, `ConsultationsResource`, `TenantsResource`
(`src/resources/index.ts:1-28`) — **no `WorkflowsResource`.**
Admin plane (generated, `@generated by @arcaai/vox-node-codegen — DO NOT EDIT BY HAND`):
`AdminWorkflowRunResource` (`src/resources/admin/workflow-run.ts:28-102` — `listRuns`, `getRun`,
`getRunGate`, `getRunTrace`; read-only, no streaming client) and
`AdminWorkflowDefinitionResource` (`src/resources/admin/workflow-definition.ts:42-98+`, 19
routes). Admin resources are service-account-only by construction, so they are not the
"REST + API key" entry point either.

TASK-722 explicitly deferred both SDKs for this surface
(`docs/implementation/TASK-722-Exposure-V1/README.md:57-59`).

---

## G. CONTEXT SCHEMA (tenant-defined, already exists)

Two places carry a "context schema", and they are **different things**:

**1. `ConsultationContextSchema` / `…Version`** —
`packages/database/src/prisma/db_main/consultation-context-schema.prisma:19-129`.
The house governance triple (mutable head + immutable version + movable pin, `:8-16`):
`slug` (`:32`), `scope ∈ {TENANT, DEPARTMENT}` + `departmentId` with the department row winning
discovery (`:36-40`), `status`, `pinnedVersionNumber` (`:47` — the movable pin; a schema with no
pin is never served), `isDefault` (`:53`), golden-library provenance `sourceTemplateSlug` /
`templateLocked` (`:59-60`). The version row holds `definition Json` (`:111`) and a `checksum`
(`:116`) driving idempotent republish and the discovery ETag.
**Tenant-authored, yes** — each `kinds[].primitive` is one of five platform primitives
`STREAM_AUDIO | TEXT | DOCUMENT | IMAGE | STRUCTURED`, and an unknown primitive is **rejected at
publish** (`:105-110`). Shape validated by `context-schema-definition.ts` in
`@arcaai/applications`. A consultation in flight keeps validating against the version it started
with (`:14-16`). UI: `/context-schemas` →
`apps/admin-console/src/features/context-schemas/` with `definition-editor.tsx`, `kind-form.tsx`,
`output-form.tsx`, `payload-tester.tsx`, and a real `versions-panel.tsx` (pin/rollback + skew
badges) — **the reference pattern the Studio's missing version panel should crib**.

**2. The `input.context_binding` node's own inline `contextSchema`** —
`packages/workflow-contract/src/node-config-schemas.ts:51-110`. Per-node, embedded in the graph:
`contextSchema.kinds[]` of `{key, label, primitive, phiClass, cardinality, lifecycle, producedBy,
required?, description?}` plus `bindings[]`, and an optional `outputs[]` of `{key, label,
description, primitive}`. **Here `primitive` is restricted to `TEXT | STRUCTURED` only**
(`:78`, `:97`) — a narrower vocabulary than the DB model's five.
`output.deliver` mirrors it with `outputs[]` (`:313-338`, same 2-primitive limit at `:333`).

The compiled config pins which context-schema version a run used:
`CompiledPolicyBindings.contextSchemaVersionId` (`packages/workflow-contract/src/compiler.ts:73`).

**Verdict against the target:** tenant-admin-defined context schemas with department override,
versioning, pinning and a payload tester **already exist and are shipped**. What does NOT exist
is *arbitrary tenant JSON Schema* on Input/Output nodes — the vocabulary is a closed
`kinds`/`outputs` declaration over 2 (node) or 5 (DB) primitives.

---

## H. GUARDRAIL + TOOLS

### Guardrail
Four node types: `guardrail.check` (`node-registry.ts:310`, summarization palette, `mandatory`)
and `guard.phi` / `guard.moderation` / `guard.groundedness` (`:1202`, `:1219`, `:1236`,
`paletteKey: null` — a guard is genuinely palette-agnostic).

`guardrail.check` calls `apps/guardrail` **directly** via `GuardrailClient`
(`POST /guardrail/analyze`) — `apps/harness/src/harness/temporal/interpreter/nodes/
guardrail_check.py:1-10`. It is **fail-CLOSED**: a response carrying a non-null `error`, a
transport failure, or a timeout is treated as NO VERDICT and never returns `SUCCEEDED`
(`guardrail_check.py:3-10`). `config.failOn` is pinned by JSON Schema to the single value
`'unsafe_or_unknown'` (`node-config-schemas.ts:351`) — an "unsafe-only" gate is exactly the
posture that would let a guardrail outage launder into a silent pass.

**Important constraint for the new design:** `config.onFail: 'abort'` is **rejected at authoring
time** (`guardrail_check.py:12-27`, schema pins `onFail` to `['mark']`). `critical` is a
CODE-OWNED registry property (`guardrail.check` is `critical: false`) and
`NodeActivityResult.status` has **no `FAILED` member** — only the workflow body promotes a
DEGRADED critical node to run-level FAILED. **There is no mechanism in the shipped interpreter
for a per-node CONFIG value to override a code-owned registry property.** A design that lets a
tenant mark a guardrail node "hard fail" needs that mechanism built.

**Attachment model today** is `requires[]` on the *guarded* node's descriptor, checked **per
instance** at publish by `workflowPublishProblems` (`node-registry.ts:118-120`): the three
`agent.*` generation entries require `guard.groundedness`, `agent.transcription` requires
`guard.phi`. There is **no notion of an input-side vs output-side guard slot** — the target's
"optional guardrail nodes on an agent's input/output" would need either directional port
semantics or a new attachment field.

### Tools
Machinery exists and IS reachable from the interpreter:
- Registry model `McpServer` — `packages/database/src/prisma/db_main/mcp-server.prisma:31-79`.
  SYSTEM-tenant rows only, super-admin writes, every tenant reads
  (`TENANT_SCOPED_MODELS` + `SYSTEM_SHARED_READ_MODELS`, `:10-17`). `authRef` is a **Vault path
  only**, never secret material (`:18-21`). `phiBoundary` defaults to `"external"` — an MCP
  server is cloud egress unless explicitly `"in-boundary"`, and the harness PHI egress guard
  screens outbound tool args **fail-closed** for external servers (`:22-24`). `enabled` defaults
  **false** (`:61-64`), and the whole feature is additionally gated off by
  `HarnessPolicy.mcpToolsEnabled` (`:25-26`). `toolAllowlist` is per-server; the effective
  allowlist is `HarnessPolicy.toolAllowlist ∩ server.toolAllowlist` (`:53-56`).
  **All tools are READ-ONLY** — write-capable MCP is explicitly a future ticket behind a
  human-approval-gate design (`:27-28`).
- Client: `apps/harness/src/harness/tools/mcp_client.py` (streamable-HTTP transport).
- Reached from the interpreter today by exactly ONE node:
  `consultation.bindTerminology` — `interpreter/nodes/consultation_nlp.py:27,138-140,212,225`
  binds `call_mcp_tool` to the read-only terminology server; failures degrade with
  `mcp_tool_blocked` / `mcp_tool_degraded` (`:242,253`), never fabricate.
- LLM-native function/tool calling exists in `apps/text` provider adapters
  (`apps/text/src/text/providers/{anthropic,bedrock,vertex}.py`) but **is not surfaced as a node
  config option** — no generation node's config schema declares a `tools` field.

**Verdict:** a "Tools" affordance on an Agent node would need (a) a new node-config field naming
allowed `McpServer` + tool ids, (b) plumbing from `NodeActivityInput.config` into the generation
activity's provider call, and (c) a decision on write-capable MCP, which is currently and
deliberately out of scope.

---
## I. SETTLED DECISIONS — do not re-litigate

Sourced from the ticket READMEs under `docs/implementation/`. Each is already merged unless
marked otherwise.

### Architecture (TASK-806, the MASTER — `Completed` 2026-08-30; 9 sub-tickets 808-816 closed)
- **D-3: "a constrained DAG over a typed catalog."** Owner-mandated typed ports. The graph is not
  free-form.
- **OD-1:** a developer MUST be able to select a workflow at session-open time (delivered by
  TASK-813).
- **OD-2:** *"No clinical app — clinical usage happens in the tenant-admin playground
  (impersonating a clinician)."*
- **OD-4:** retire `DepartmentAgent` completely (TASK-815).
- Target architecture the Studio authors against:
  `WorkflowDefinition { entrypoint → core [realtime lane | durable lane] → endpoint }`, typed
  ports over a closed primitive vocabulary, per-node `trigger` / `lane` / `llmBinding`.

### Execution semantics (TASK-718 — settled S-1…S-8)
- Interpreter input is only `(sessionId, workflowVersionId)`; `compiledConfig` is fetched via
  **claim-check**, never passed inline.
- **S-3: in-flight runs PIN their version; a publish affects new runs only.** *"Immutable config
  + pinned version = deterministic Temporal replay."*
- Node → activity routing goes **only** through the code-owned sanctioned registry. A signing
  node type cannot exist — proven **structurally by registry absence**, not by a runtime check.
- A failing node degrades **visibly**; independent branches continue.
- Sandbox mode refuses `external_write` activities.
- **v1 execution semantics, chosen deliberately: linear stage walk + single-level fan-out with an
  all-settled join — nothing else.** No conditional edges, no cycles, no sub-workflow nodes, no
  partial joins. Scheduled/webhook triggers were named out of scope for v1.

### Persistence & immutability (TASK-715, revisited by TASK-734)
- Registry is a **code module served via API — there is no `NodeType` table and no write path**
  (TASK-715 D; TASK-734 re-affirms). Node types are NOT tenant-editable.
- `WorkflowDefinition` rows **ARE versions** (single table), a deliberate divergence from the
  platform's head/version/pin pattern, because *"a published version IS the addressable product."*
- Lineage is BOTH `parentVersionId` (provenance — a draft may branch from ANY published version)
  AND `(slug, versionNumber)` (addressing). Not redundant.
- `paletteKey` is a `String`, not an enum, so a new palette needs no `ALTER TYPE` migration.
- Entitlement gating is **per-palette**, not per-node-type; `entitlementKey` on the descriptor is
  vestigial/unread.
- TASK-715 D-715-1 said *no DB trigger*; **TASK-734 reversed it** and added the row-scoped
  `BEFORE UPDATE OR DELETE` trigger + partial unique index as defense in depth, accepting
  permanent `prisma migrate diff` drift. TASK-810 OD-13 copies this for `DocumentTemplateVersion`.

### Compiler & validator (TASK-716)
- `compile(graph, ctx) → CompiledWorkflowConfig | { findings }` is a **total function that never
  throws**: stages from topological levels, gates lifted out, caps clamped, sha256 over canonical
  JSON.
- Validator = a **closed 11-kind predicate catalogue**; each rule is a data row.
  `WorkflowRulePredicateType` is code-owned; instances are tenant-extendable but **SYSTEM rules
  cannot be loosened or disabled.**
- `@arcaai/workflow-contract` is a **zero-runtime-dependency sibling package**, deliberately not
  folded into `@arcaai/applications`, so the DB seed AND the Studio can both compile without app-
  layer deps.
- **Caveat the package states about itself** (`packages/workflow-contract/src/index.ts:7-14`): the
  22 rule INSTANCES are a DRAFT, **not clinician-reviewed**. The ENGINE is mechanism and safe to
  build on; the specific rules must not be presented as a validated safety boundary until that
  review completes.

### Templates / shapes (TASK-810 — `Completed`)
- **DD-1:** templates are shapes in a catalog; **none is privileged**.
- **DD-2: no selector node, no runtime classification** — each generation node compiles its bound
  shape ONCE, at publish, frozen for the session. **Do not design runtime shape switching.**
- **DD-11:** editing a prompt *from inside the node* creates a new `PromptVersion` **and moves
  that node's pin**; editing from the Prompt management screen creates a version but **moves no
  node's pin**.

### Node contract (TASK-809 — `Completed` 2026-08-28)
- **OD-15 resolved, option A: named sockets win**, and the runtime key is declared **on the port
  descriptor** (`outputKey`). Option C (a whole-object `bundle` port) was **rejected** — a bundle
  cannot be typed as "contains a document", so it reopens the laundering path.
- `outputKey` is `?: never` on a `control` port — enforced by the TYPE, not by convention.
- The interpreter distinguishes three outcomes, deliberately: a `control` socket binds nothing; a
  declared key absent from this run's output contributes nothing (never a `KeyError`, never a
  fabricated value); a port the producer does not declare at all **raises**.

### Lane ownership & realtime (TASK-811, TASK-821)
- **Exactly one runtime executes any given node**, decided by `lane`. The interpreter hard-skips
  `lane: 'realtime'` (`interpreter/workflow.py:271-279`); the realtime executor runs only those.
  This closes the "two engines writing one consultation's document" hazard.
- TASK-821: **"fix the GRAPH, not the handler."** A proposed input-resolution fallback was
  rejected because it *"would delete the property the architecture exists to enforce"* — inputs
  resolve strictly by declared port, never by ambient scope.
- TASK-821: "registered/implemented" (code) and "runs" (seeded and wired into a graph) are
  independent. A node can be `implemented: true` and still silently no-op because the graph never
  wires it. Placement of a realtime node is often **derived, not freely authorable** — the
  `allPathsPassThrough` rules plus lane producer-filtering can leave exactly one legal insertion
  point.

### Exclusivity (TASK-795 — `Completed`)
- Substrate exclusivity is a durable marker in **`Consultation.metadata.governingEngine`**, not a
  `WorkflowRun` query (that table has no consultation linkage).
- It **fails safe toward Substrate A** (the hardcoded engine) on any indeterminate read —
  deliberately the opposite direction from the entitlement gate beside it.
- A published tenant-authored graph is **inert** until this marker routes the consultation to it.

### Exposure (TASK-722 — `Completed`)
- ONE generic route family `/api/v1/workflows/:slug/…` — **never per-workflow generated routes.**
- `WORKFLOW_EXPOSURE_ENABLED` kill-switch **OFF by default** (R-1).
- SSE is a disclosed poll-bridge, not a proxied stream; TASK-717 Phase C (a reference event
  producer) is **deferred**.
- TASK-720 R-4 (owner ruling 2026-08-20): **public exposure does NOT restrict cloud-provider
  choice** — the tenant carries the egress risk, consistent with the BYO-first posture.
- SDK clients for this surface are **explicitly deferred** (`README.md:57-59`).

### Studio v1 (TASK-719)
- The list/tree editor is a **PEER editor for keyboard-only authoring, not a fallback**. Dropping
  it regresses WCAG 2.5.7.
- Deliberately **not** folded into the Studio: `/agentic-policy`, `/harness/pipeline-policy`,
  department prompt-config. Rule 13's "one authoritative editor per backend resource".
- Named deferrals: multi-select + bulk delete, minimap, alignment/distribute tools, cross-document
  copy/paste, "create new version from this" branch action on a published row, `?view=list` nuqs
  sync, a dedicated metadata autosave form. (Some have since landed — see §D.)

### Seeds (TASK-798 — status `Review`)
- Both new seed phases are **excluded from `safe` mode**: attributing a published clinical
  workflow to a tenant-admin human who never authored it is *"a fabricated governance act."*
- `WorkflowAssignment` rows are gated on a **derived** flag, never hand-set
  (`CONSULTATION_ASSIGNMENT_ENABLED = detectSubstrateExclusivityGate().present`).
- Provides two **17/18-node consultation-palette reference graphs** — good round-trip fixtures for
  a new editor.

### Knowledge retrieval (TASK-834 — status `Pending`, plan deliberately NOT written)
- No decisions locked. Only requirements R1-R6 and one explicit non-goal: *"this ticket does not
  pick a default model for any tenant."*
- Two retrieval nodes are already `implemented: true` (`agent.retrieval`,
  `consultation.retrieveEvidence`) but **share one nearly-empty config schema**
  (`retrievalEnabled` + `onError`, `additionalProperties: false`). Citations, backend selection,
  prompt instructions and knowledge-source config have **no config surface yet**. Whether the two
  nodes are duplicates is an open question.

---

## J. THE 5 BIGGEST GAPS between today and the target

### 1. NO LOOP NODE — the interpreter cannot express an agentic loop at all
**Missing component: a `loop.*` node type + child-workflow dispatch in `WorkflowInterpreter`.**

The interpreter is, by its own docstring, *"Linear stage walk + single-level fan-out with an
all-settled join. Nothing else (v1)"* (`apps/harness/src/harness/temporal/interpreter/
workflow.py:89`), and TASK-718 named cycles, conditional edges and sub-workflow nodes as
explicitly out of scope for v1. There is no `max_iterations` / `max_time` anywhere in the graph
vocabulary, and the only child workflow the interpreter can start is the ONE hard-wired HITL gate
(`workflow.py:353-401`, itself behind `workflow.patched(_GATE_PATCH)`).

The **master/sub-agent shape the target wants already exists** — `ConsultationLoopWorkflow`
(`workflows.py:1968`) as orchestrator and `SpecialistWorkflow` (`workflows.py:1894`) as an
isolated sub-agent child, each with its own history budget and failure domain. It is hand-written
Python, unreachable from any graph. `NodeSpec.kind` is reserved for a future `child_workflow`
dispatch (`packages/workflow-contract/src/node-registry.ts:34-35`) and unimplemented.

Consequences the design must absorb: a loop changes the interpreter's **command sequence**, so it
needs a `workflow.patched` marker and new replay fixtures
(`apps/harness/src/harness/tests/unit/temporal/test_replay_compat.py`); and the compiler's
`topologicalLevels` staging (`compiler.ts`) plus `MAX_GRAPH_DEPTH = 64` and the `ACYCLIC`
predicate all assume a DAG — a cycle in the authored graph is currently a validation error.

### 2. NO GENERIC "AGENT" NODE — agents are code-owned types, not tenant-authorable
**Missing component: a parameterised `agent.generic` node type whose provider, instruction prompt
and tools come entirely from `config`.**

Today each "agent" is a distinct registry key bound to a distinct Temporal activity:
`generate.text` (`node-registry.ts:293`), `consultation.synthesize` (`:630`) and ten `agent.*`
entries (`:925-1191`). Adding one requires a TypeScript descriptor + a Python `NodeSpec` + a new
`@activity.defn` + a regenerated parity fixture
(`packages/workflow-contract/src/__tests__/fixtures/node-registry.snapshot.json`) + a deploy —
which is the deliberate TASK-715 decision *"code-owned / not tenant-editable… no write path
because there is no table."*

The target's "each agent node binds ONE provider config, has an instruction prompt and
hyper-parameters" is **80% there**: `temperature` / `maxTokens` / `topP` exist
(`node-config-schemas.ts:280-282`), `systemPrompt` exists (`:279`), `taskKey` + a per-node
`modelSlug` override that fails closed exist (`:276`, `:1301-1304`), and prompt binding is pinned
at publish (`CompiledPolicyBindings.promptTemplateRefs`, `compiler.ts:65`). Genuinely absent:
`frequency_penalty` and `presence_penalty` (nowhere in the repo), and any `tools` field on a
generation node's config schema.

### 3. NO STREAMING PRODUCER — every "stream" is polling or a hand-instrumented side channel
**Missing component: TASK-717 "Phase C" — a real event producer on the interpreter, and a
node-level streaming contract.**

`GET /workflows/:slug/runs/:runId/stream` is a **2-second poll** over the dispatcher's JSON status
read, disclosed in the service's own class doc (`apps/api/src/modules/workflows/
workflow-stream.service.ts:9,16-43`) because *"the interpreter dispatcher exposes no such
endpoint"* and TASK-717 explicitly deferred a reference producer. There is no `Last-Event-ID`
resume, by design.

Partial output reaches a client today only by a **two-hop HTTP-POST → Redis pub/sub relay**
(`apps/harness/src/harness/services/api_client.py:939-990`) that a node's activity must call by
hand — done by exactly two nodes. The `Loop` progress channel is structurally forbidden from
carrying clinical text (`EmitLoopEventInput` is `ConfigDict(extra="forbid")`,
`apps/harness/src/harness/temporal/models.py:1514`). The `apps/text` service HAS real token-level
SSE with Redis-message-id resume (`apps/text/src/text/api/endpoints/stream.py:377-430`) but it is
never wired as a node output. **Streaming input on an agent/STT node does not exist as a concept
at all** — `NodeActivityInput.bound_inputs` is a resolved dict handed to an activity that runs to
completion.

### 4. NO TTS NODE, AND THE ENTIRE STT PALETTE IS A PLACEHOLDER
**Missing components: a `tts.*` node family, and real STT node activities.**

`node-registry.ts` contains **zero `tts.*` entries** — `apps/tts` (port 8865, WebSocket
`/ws/tts/stream`, OpenAI-compatible SSE at `apps/tts/src/tts/api/endpoints/speech.py:43,145,180`)
is entirely unreachable from a workflow node.

All eight `stt.*` nodes are backed by
`apps/harness/src/harness/temporal/interpreter/nodes/stt_placeholder.py`, a **deliberate
registry-parity placeholder that returns `DEGRADED` without doing work**; the palette's real
artifact is an `AsrPipeline` YAML compiled at publish (`workflow-definition.service.ts:778`
`compileSttPipelineIfNeeded`). `stt.phiHop` is additionally `implemented: false`
(`node-registry.ts:474`), which makes `compile()` refuse any graph containing it. The exposure
plane refuses the `stt` palette for exactly this reason — *"invoking the graph over REST would
promise transcription and silently deliver nothing"*
(`exposure-palette-policy.ts:54-57`).

### 5. THE FOUR INVOCATION SURFACES ARE 1-OF-4, AND THE ONE THAT EXISTS REFUSES CONSULTATION WORKFLOWS
**Missing components: an inbound webhook receiver; a business-plane `WorkflowsResource` in
`@arcaai/vox-node`; workflow-invoke hooks in `@arcaai/vox`; and an exposure-plane decision on the
`consultation` palette.**

- **Webhook (inbound): does not exist.** `WorkflowRun.trigger`'s doc comment enumerates
  `"consultation open | api invoke | webhook | schedule"`
  (`workflow-run.prisma:87-90`), but only `'consultation open'`
  (`consultation-workflow-dispatch.service.ts:212`), `'api invoke'`
  (`workflow-exposure.service.ts:149`) and `'workbench sandbox'` are ever stamped. TASK-727 built
  the **opposite** direction (outbound signed delivery of *other* resources' sys-events) and
  scoped workflow-run events out of itself; no `ResourceType` for `Workflow*` exists.
- **REST + API key: exists, but disabled AND palette-restricted.**
  `WORKFLOW_EXPOSURE_ENABLED` is `false` in `.env.dev:286` and `.env.sample:293`
  (`workflow-exposure.service.ts:229-232`). More importantly —
  **`EXPOSURE_ALLOWED_PALETTES = new Set(['summarization'])`**
  (`packages/applications/src/services/workflow-exposure/exposure-palette-policy.ts:61`), and the
  gate resolves the palette of **every node type the graph actually carries**, not just the
  declared `paletteKey` (`:31-35`, `:121-133`). **The `consultation` palette is explicitly
  REFUSED** because four of its nodes are `externalWrite` and `consultation.persistDraft` reaches
  the same activity the real consultation workflow uses (`:48-52`). So a *consultation* workflow
  — precisely the target's subject — **cannot be REST-invoked today at all**, by a deliberate
  security decision (TASK-790 W1, closing TASK-789 finding C-8) that a new design must
  consciously address rather than casually widen.
- **SDK Vox: no invoke API.** Only consultation-*governance* hooks
  (`useConsultationWorkflow.ts:50-83`, `useSelectableConsultationWorkflows.ts:49-82`) and
  `OpenSessionInput.workflowDefinitionSlug` (`src/types/consultation.ts:123-144`).
- **SDK Vox-node: no business-plane resource.** `src/resources/index.ts:1-28` exports no
  `WorkflowsResource`; only generated admin resources, which are service-account-only and
  `@ForbidApiKey()`-gated. TASK-722 deferred this explicitly.

### Runners-up worth naming
- **No `unpublish` / `deprecate`.** Neither the service
  (`workflow-definition.service.ts`) nor `IWorkflowDefinitionService.ts` has one; the editor has
  no button. `deprecatedAt` is a column with no writer. Shipped semantics are *publish + activate
  / re-point* — publishing a new version demotes the previous ACTIVE one
  (`workflow-definition.service.ts:404-405`).
- **Typed ports are validated but not VISIBLE.** `workflow-node.tsx:69-70` renders exactly one
  input and one output handle per node regardless of how many ports the descriptor declares.
- **A dead version-list API.** `features/workflow-studio/api/hooks.ts:48-50` exports
  `useWorkflowDefinitionVersions` with zero call sites;
  `features/context-schemas/components/versions-panel.tsx` is the working pattern to crib.
- **A stale worktree** at `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/.claude/worktrees/
  agent-aa543e2d680c58cbf` (branch `worktree-agent-aa543e2d680c58cbf`) holds a near-duplicate of
  `packages/workflow-contract/**` and the studio tree. Per rule 14 §5 it must be merged or
  explicitly abandoned before new work touches these files — never silently pruned.
- **A correction to one ticket summary:** a claim circulated that TASK-806 Phase 4 replaced the
  single `paletteKey` with a derived capability set and widened `EXPOSURE_ALLOWED_PALETTES`.
  **Verified false against `dev-2.2` HEAD**: `WorkflowDefinition.paletteKey` is still a single
  declared column (`workflow-definition.prisma:74`) validated at create by
  `assertKnownPaletteKey` (`workflow-definition.service.ts:217`), and
  `EXPOSURE_ALLOWED_PALETTES` is still `new Set(['summarization'])`
  (`exposure-palette-policy.ts:61`). Treat multi-palette workflows as an OPEN design question.

---

## K. Quick reference — where things live

| Concern | Path |
|---|---|
| Prisma models | `packages/database/src/prisma/db_main/workflow-{definition,run,assignment,invariant-rule,test-fixture}.prisma`, `consultation-context-schema.prisma`, `mcp-server.prisma` |
| Contract package (validator, compiler, registry, ports, rules) | `packages/workflow-contract/src/` |
| Cross-language parity fixture | `packages/workflow-contract/src/__tests__/fixtures/node-registry.snapshot.json` |
| Application services | `packages/applications/src/services/workflow-{definition,assignment,exposure,invariant-rule,run,sandbox-run,test-fixture,validator}/` |
| Realtime lane (2nd engine) | `packages/applications/src/services/consultation/live-documentation/realtime/` |
| Gateway controllers | `apps/api/src/modules/{workflows,workflow-definition,workflow-node,workflow-run,workflow-sandbox-run,workflow-assignment,workflow-invariant-rule,workflow-test-fixture}/` |
| Temporal interpreter | `apps/harness/src/harness/temporal/interpreter/{workflow,registry,compiled_config,activities,gate_workflow,caps,models}.py` + `nodes/` |
| Hand-coded workflows | `apps/harness/src/harness/temporal/workflows.py` |
| Worker / task queue | `apps/harness/src/harness/temporal/worker.py`; queue name `apps/harness/src/harness/core/config.py:41` |
| Replay-compat tests | `apps/harness/src/harness/tests/unit/temporal/test_replay_compat.py` |
| Canvas primitive | `packages/ui/src/components/workflow-canvas/` (`@xyflow/react`, `packages/ui/package.json:133`) |
| Studio feature module | `apps/admin-console/src/features/workflow-studio/` |
| Runs feature module | `apps/admin-console/src/features/workflow-runs/` |
| Workbench (sandbox, real SSE) | `apps/admin-console/src/features/workbench/` |
