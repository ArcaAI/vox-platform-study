# TASK-864 — Workflow Studio v2: one node vocabulary (Trigger · Agent · Classify · Human review · Variable · If/Else · Loop · Note · Output), Temporal interpreter, published protocols

| | |
|---|---|
| **Status** | Review |
| **Type** | feature + refactor |
| **Program** | [TASK-859 — AI Platform Consolidation](../TASK-859-Ai-Platform-Consolidation-Program/README.md) |
| **Packages** | `packages/workflow-contract`, `packages/applications` (`workflow-*`, `consultation/workflow-dispatch`, `consultation/live-documentation/realtime`), `apps/api` (`workflows`, `workflow-*`, `webhook`), `apps/harness` (`temporal/interpreter/**`), `packages/ui/src/components/workflow-canvas`, `apps/admin-console/src/features/workflow-studio`, `packages/vox-node`, `packages/database` (seeds 21/23/24, `WorkflowRun`) |
| **Depends on** | TASK-863 (Agent entity referenced by the Agent node), TASK-860 (Classify node picks registry models by task) |
| **Rules** | `04`, `05`, `06` §Temporal, `07`, `11`, `13` |
| **Created** | 2026-09-04 |

## 1. Requirement Analysis

Owner directive (2026-09-04), restated as the target vocabulary and semantics:

| Element | Owner's definition | Verifiable contract |
|---|---|---|
| **Trigger** | entry point of an agent/workflow; a session is a *consultation*; declares the consultation context object schema available to the whole session; only a **source** handle | one per graph; `contextSchema` (inline authorable JSON Schema or a `ConsultationContextSchemaVersion` reference); `kinds[]` of accepted triggers (`consultation`, `api`, `webhook`, later `schedule`); the run payload is validated against the schema before any node runs |
| **Agent** | one task; input/output text, object or both depending on the model; LLM/ASR/TTS only | `agentRef { slug, versionNumber? }` → a published Agent (TASK-863); ports derived from the agent's task and its declared `inputSchema`/`outputSchema`; per-node overrides limited to prompt variables and hyper-parameters within the agent's declared ranges |
| **Classify** | route input into a category using a declared token- or text-classification model | `modelSlug` (registry row, `taskType ∈ {TEXT_CLASSIFICATION, TOKEN_CLASSIFICATION}`), `classes[]`, `mode single|multi`, `threshold`; **one output handle per class** + `otherwise`; also emits `{ category, scores, spans? }` on `out` |
| **Human review** | hold-out step waiting for a human; the run pauses until intervention | durable Temporal wait; decision `approved | rejected` (+ optional edited payload); `timeoutSeconds` + escalation; **a timeout never approves**; handles `approved`, `rejected`, `timedOut` |
| **Variable** | declares workflow context variables with defaults, available to all steps | `variables[{ key, schema, default }]`; readable as `{{vars.key}}` everywhere; assignable by mapping any node output into `vars.key` |
| **If/Else** | conditional routing | `branches[{ key, when: <CEL expression> }]` + `else`; expressions read node outputs and `vars`; type-checked at publish against declared upstream schemas |
| **Loop** | repeat a sub-flow until a condition or a max-iteration bound | `mode foreach|while`, `over` (array path) or `until` (CEL), `bounds { maxIterations, maxDurationSeconds, maxTotalTokens, noProgressIterations }`; the body is a **sub-graph** (child nodes with `parentId`), executed as a Temporal child workflow per iteration |
| **Note** | a canvas comment | `text`, `color`; no ports; never compiled |
| **Output** | end point; declares the returned object schema and the protocols (http, http-sse, socket) under which the published agent/workflow is reachable | `outputSchema`; `protocols[]`; only a **target** handle; drives the generated OpenAPI/AsyncAPI for the published slug |

Plus the owner's framing: **a workflow is Temporal-backed; admins build it visually; a published workflow is callable via webhook / API / socket**, and "make sure you review this carefully from the SDK Vox, Vox-node to API/Socket, logic, services communication, data models".

## 2. Current State Evaluation

Verified 2026-09-04. The substrate is real and largely sound; the vocabulary is fragmented.

### 2.1 What exists (keep)

| Capability | Where | Evidence |
|---|---|---|
| Graph model: `{ version: 1, nodes[{id,type,config,position?}], edges[{id,from,fromPort,to,toPort}] }`, id grammar, bounds (256 nodes / 1024 edges / depth 64), total non-throwing validator | `packages/workflow-contract/src/graph-model.ts:24-183` | |
| Code-owned node registry (58 types), per-type JSON-Schema config, typed ports with a subtype lattice (`transcript ⊑ text`, `document ⊑ text`; NER may never receive generated text), cross-language parity snapshot (TS ↔ Python) | `node-registry.ts`, `node-config-schemas.ts`, `node-ports.ts`, `port-model.ts`, `__tests__/fixtures/node-registry.snapshot.json`; `apps/harness/.../interpreter/registry.py` | |
| Publish pipeline: validate (46 draft rules, `WorkflowInvariantRule` rows merge one-way-strict) → compile → stamp `compiledConfig` + checksums → `isActive` election; PUBLISHED rows immutable (service + DTO whitelist + DB trigger) | `packages/applications/src/services/workflow-definition/workflow-definition.service.ts:512-586`, `workflow-validator/**`, `workflow-definition.prisma` header | |
| Reference-only bindings (`FORBIDDEN_CONFIG_KEYS`), capability-gated hyper-parameters, prompt/document version pins, `evalGate` | `agentic-contract.ts:60-119`, `node-config-schemas.ts:208-268,1150-1290` | |
| Temporal interpreter: generic `WorkflowInterpreter` walks `stages[]` (all-settled join per stage), per-node activity dispatch with timeouts/retries from compiled caps, observable skips, run-event stream to Redis → SSE | `apps/harness/src/harness/temporal/interpreter/workflow.py:155-592`, `run_events.py`, `apps/api/src/modules/workflows/workflow-stream.service.ts` | |
| Human wait: `ConsultationGateWorkflow` child — `wait_condition` + SLA escalation ladder, `APPROVED` only on a real signal, `ABANDONED` otherwise | `interpreter/gate_workflow.py:100-224`; signal via `POST /internal/workflow-runs/{id}:approve` | |
| Loop: `AgenticLoopWorkflow` — one iteration per generation + `continue_as_new`, sub-agents as child workflows, three bounds in the child and `maxDurationSeconds` as a parent timer | `interpreter/loop_workflow.py:1-90`, `workflow.py:92-101,533-534` | |
| Realtime lane: per-turn nodes executed in the gateway (stage-parallel, per-node budget, typed degrade events); the durable interpreter skips `lane: realtime` nodes | `packages/applications/src/services/consultation/live-documentation/realtime/{realtime-executor,realtime-node-registry}.ts` | |
| Exposure plane: `POST /workflows/:slug/runs?mode=async|blocking|stream`, `Idempotency-Key` → deterministic run id (join, not duplicate), status, cancel, SSE with `Last-Event-ID`; consultation-bound route family `POST /consultations/:id/workflows/:slug/runs`; node-class-based palette boundary | `apps/api/src/modules/workflows/**`, `workflow-exposure/**`, `exposure-palette-policy.ts` | |
| Assignments: `(scope, scopeId, paletteKey) → slug`, `department → tenant → SYSTEM`, WORM change log | `workflow-assignment.prisma`, `workflow-assignment/**` | |
| Studio: registry-driven palette (zero hardcoded node types), schema-driven inspector (`toFieldDescriptors` over the JSON-Schema subset), server-round-trip validation rail, autosave with OCC pause-on-412, publish dialog, versions/clone, keyboard-first list editor (WCAG 2.5.7 peer of the canvas), bounded undo/redo | `apps/admin-console/src/features/workflow-studio/**`, `packages/ui/src/components/workflow-canvas/**` (`@xyflow/react ^12.11.3`) | |
| vox-node: `hope.workflows.{list,run,runAndWait,runAndStream,getRun,cancelRun,streamRun,waitForRun}`, `hope.consultations.workflows.*` | `packages/vox-node/src/resources/workflows.ts` | |

### 2.2 Gap table vs the target vocabulary

| Target | Today | Verdict | Evidence |
|---|---|---|---|
| Trigger | `agentic.input` (`ioSchema`, `sourceKey`; `trigger: 'on-start'`) for the agentic palette; `input.context_binding` (summarization); consultation palette binds the context schema at the **service** level (`compiledConfig.policyBindings.contextSchemaVersionId`) — three shapes, no trigger kinds, source+target handles on every node | **Partial** | `node-config-schemas.ts:1293-1308`, `workflow-definition.service.ts:1088-1092` |
| Agent | `agentic.agent` (full config surface, inline, no reuse) + eleven fixed-purpose `agent.*` types + `agentic.stt` (batch, `pipelineRef` → `AsrPipeline`) + `agentic.tts` | **Exists, fragmented** | `node-registry.ts:926-1193,1311-1450` |
| Classify | none; `agent.ner` is fixed NER; `agentic.guardrail` is a policy-key verdict | **Missing** | registry grep |
| Human review | `consultation.hitlGate` only (consultation palette) | **Exists, palette-scoped** | `node-config-schemas.ts:570-590`, `gate_workflow.py` |
| Variable | `agentic.data` (edge-to-edge reshape, `mappings`, `constants`); `_node_outputs` in-run cache | **Partial** | `node-config-schemas.ts:1390-1423`, `workflow.py` |
| If/Else | none; no expression language anywhere; the only conditional is `agentic.loop.terminationKey` truthiness | **Missing** | registry + `agentic-contract.ts` grep |
| Loop | `agentic.loop` (orchestrator + sub-agents; `terminationKey`); no `foreach`/`while` over a sub-graph; TS docstring stale ("DEGRADED placeholder") | **Exists, narrow** | `node-registry.ts:1287-1296` vs `loop_workflow.py` |
| Note | none (only `position`) | **Missing** | `graph-model.ts:24-31` |
| Output | `agentic.output` (`ioSchema`, `onSchemaViolation`) and `output.deliver` (`outputs[]`, claim-check); **no protocol declaration**; transport is the caller's `?mode=` | **Partial** | `node-config-schemas.ts:1310-1327`, `workflows.controller.ts` |
| Publish via API | yes, summarization palette only (`EXPOSURE_ALLOWED_PALETTES = {summarization}`) — agentic/consultation graphs are not REST-invokable | **Partial** | `exposure-palette-policy.ts:75-80` |
| Publish via webhook | outbound resource webhooks only; `WorkflowRun.trigger = 'webhook'` is reserved vocabulary with no producer; **no run-completed webhook** because terminal status is written only on a lazy read (finding G9) | **Missing** | `docs/architecture/clinician-integration-guide.md` §Webhooks |
| Publish via socket | only the STT WebSocket (a separate transport) | **Missing** | `apps/api/src/modules/streaming/stt-ws.gateway.ts` |
| Temporal-backed | yes | **Exists** | — |

### 2.3 Structural problems the vocabulary fragmentation causes

1. **Four palettes (`summarization`, `stt`, `consultation`, `agentic`) express the same primitives four ways** — an input node exists three times, an output node twice, an LLM call five times (`generate.text`, `consultation.synthesize`, `agent.summarization/presummarization/discharge_summary`, `agentic.agent`). Each new purpose is a registry change that bumps `registryChecksum` and flags every published definition `NEEDS_REVIEW`.
2. **Palette membership is a free-text `paletteKey` that nothing enforces** at validate/compile time (`exposure-palette-policy.ts` header) — the exposure boundary had to be re-derived from node classes.
3. **Execution lane and trigger cadence are per-TYPE** (`lane: durable|realtime`, `trigger: on-start|per-turn|on-end` on the descriptor), so a summarizer that should run live *and* at finalization needs two node types.
4. **The STT palette is a compiler into a table being retired** (TASK-861).
5. **Studio**: one xyflow node type with two static handles — no per-port handles, so Classify/If-Else fan-out cannot be drawn; no minimap, no auto-layout, no import/export, no node-type-specific renderers (`nodeTypes` map exists but is unused).

### 2.4 Prior art (TASK-859 research, cited there)

Dify (Start with typed inputs → LLM/Question Classifier/IF-ELSE/Loop/Human Input/Variable Assigner → Output; workflow-as-API with SSE default), n8n (Wait node resume modes; Loop Over Items; Text Classifier), LangGraph (typed state + `interrupt()`), Temporal's own guidance (generic interpreter workflow, activities per node type, `wait_condition` for HITL, child workflows + continue-as-new for loops, patching for interpreter code changes, search attributes for run listing). Recommendation adopted: Dify's variable-pool typing model (`{{node.field}}` + `vars.*`), React Flow parent/group nodes for loop bodies, CEL for conditions, SSE as the default publish protocol.

## 3. Target Design

### 3.1 One palette: `core` (nine primitives + two platform-action nodes)

| Key | Replaces | Ports (in → out) | Config (authorable JSON-Schema subset) | Executor |
|---|---|---|---|---|
| `core.trigger` | `agentic.input`, `input.context_binding`, `core.start`, the consultation `policyBindings.contextSchemaVersionId` | — → `out: context` | `kinds: ['consultation'|'api'|'webhook'|'schedule'][]`, `contextSchema: { inline } | { contextSchemaId, versionNumber }`, `sampleInput` | `interpreter.trigger` (validates payload, publishes `context`; consultation kind also binds the live capture) |
| `core.agent` | `agentic.agent`, `agentic.stt`, `agentic.tts`, `generate.text`, `consultation.synthesize`, `agent.{summarization,presummarization,discharge_summary,grammar,important_findings,transcription}` | derived from the agent's task: LLM `in: text|object` → `out: text|object`; ASR `in: audio|stream<audio>` → `out: transcript`; TTS `in: text` → `out: audio` | `agentRef{slug, versionNumber?}`, `overrides{ promptVariables, generation? }` (validated ⊆ the agent's declared ranges), `execution{ lane: durable|realtime, cadence: once|perTurn|onEnd }`, `documentBinding?`, `onError` | `interpreter.agent` (durable) / realtime handler (gateway) — both resolve via `/internal/agents/resolve` (TASK-863) |
| `core.classify` | `agent.ner` (as a router), `agentic.guardrail`/`guard.moderation`/`guard.phi` **when used for routing** | `in: text` → one handle per `classes[].key` + `otherwise`, plus `out: object` | `modelSlug` (registry, task ∈ text/token-classification), `classes[{key,label,description?,labels?[]}]`, `mode`, `threshold`, `spans: boolean` | `interpreter.classify` → `apps/nlp` `/classify/{text,tokens}` |
| `core.humanReview` | `consultation.hitlGate` | `in: any` → `approved`, `rejected`, `timedOut` (+ `out: object` = decision payload) | `reviewType`, `instructions`, `assignRole`, `timeoutSeconds`, `escalation{ afterSeconds, maxEscalations }`, `allowEdit` | `ReviewGateWorkflow` (renamed `ConsultationGateWorkflow`, generic input) |
| `core.variable` | new (absorbs `agentic.data.constants`) | `set: any` (optional) → `out: object` | `variables[{ key, schema, default }]` | `interpreter.variables` (declares; `set` merges) |
| `core.condition` | new | `in: any` → one handle per `branches[].key` + `else` | `branches[{ key, label, when: CEL }]` | `interpreter.evaluate` (pure CEL, `celpy`) |
| `core.loop` | `agentic.loop` | `in: any` → `each` (body entry), `done: object` | `mode: foreach|while`, `over: <path>`, `until: CEL?`, `bounds{…}`, `collect: <path>?` | `LoopWorkflow` child per iteration (continue-as-new preserved); body = nodes with `parentId = loopNodeId` |
| `core.note` | new | none | `text`, `color` | none — stripped by `compile()` |
| `core.output` | `agentic.output`, `output.deliver`, `core.end` | `in: any` → — | `outputSchema`, `protocols: ['http'|'http-sse'|'socket'][]`, `onSchemaViolation`, `claimCheck: auto|always|never`, `notify{ webhook: boolean }` | `interpreter.output` (validates, claim-checks, records `WorkflowRun.resultRef`, emits `workflow.run.completed`) |
| `core.data` | `agentic.data` (mappings) | `in: any` → `out: object` | `mappings[{from,to,required}]`, `outputSchema` | unchanged |
| `core.action` | every remaining fixed-purpose node: `consultation.{consentGate, captureBinding, extractEntities, bindTerminology, phiHop, retrieveEvidence, assemblePrompt, sensors, inferentialSensors, persistDraft, finalizeAssurance, realtimeSummary, suggestions, proposeCorrections}`, `agent.{normalization, retrieval, feedback, dna_redaction, ner}`, `guard.groundedness`, `guardrail.check`, `session.timeout`, `summary.finalize`, `feedback.capture`, `prompt.template_ref` | per action (declared in the action catalogue) | `actionKey` + the action's own config schema (today's per-type schemas move under the action key unchanged) | existing activities, re-registered under `interpreter.action.<key>` |

Why `core.action` rather than 30 more node types: the owner's list is the *control vocabulary*; the clinical steps are *capabilities* whose behaviour is configuration. Keeping them as one node type with an `actionKey` keeps the palette small, keeps every existing activity (no rewrite), and lets a new action ship without a registry-checksum bump for graphs that do not use it (the checksum becomes per-action).

Guardrails: a moderation/PII/groundedness check is a `core.classify` when it routes (safe → continue, unsafe → reject branch) and a `core.action(guard.*)` when it must transform (PHI redaction) or needs two inputs (groundedness: claim + evidence). Agent-level `guards{input,output}` (TASK-863) compile into the same nodes.

### 3.2 Typed context and expressions

- **Run context** = `{ trigger: <context>, vars: {…}, nodes: { <nodeId>: <output> } }`. Node inputs still bind by declared port (the anti-laundering lattice stays); templates and CEL read the context by path (`{{nodes.summary.text}}`, `vars.patientAge`, `trigger.department`).
- **Expression language: CEL** (Common Expression Language). Deterministic, non-Turing-complete, typed, sandboxed; `cel-js` (TS: publish-time type-check against declared schemas, Studio autocomplete) and `celpy` (Python: runtime evaluation inside a pure, idempotent activity `interpreter.evaluate`). A cross-language fixture test asserts identical results for the same expression + input. Alternatives considered: JSONata (weaker typing, no first-class Python), JS subsets (sandboxing burden), Power-Automate-style function lists (custom, no ecosystem).
- **Three validation tiers stay**: tier 1 port-kind check on connect, tier 2 schema-compat warning (`schema-compat.ts`), tier 3 runtime `ioSchema` enforcement (`jsonschema` in the activity).

### 3.3 Execution

- **Compiler** (`compiler.ts`): emits `stages[]` for the durable lane, `realtime` lane entries for `execution.lane = realtime`, `gates[]` for `core.humanReview`, nested `loops[{ id, body: CompiledGraph }]`, `branches` for `core.condition`/`core.classify` (edges carry the handle → the interpreter enables downstream nodes only on the taken handle), and strips `core.note`. Registry `lane`/`trigger` become **node config**, not type properties.
- **Interpreter** (`workflow.py`): stage walk unchanged; adds branch gating (a node whose incoming edge comes from an untaken handle is `SKIPPED(branch_not_taken)`), `core.loop` → `LoopWorkflow` child (generalised from `AgenticLoopWorkflow`: `foreach` iterates `over`, `while` re-evaluates `until` via `interpreter.evaluate` at each generation; bounds unchanged), `core.humanReview` → `ReviewGateWorkflow` (generic payload; decision via `POST /workflows/:slug/runs/:runId/reviews/:nodeId`, signal `review`), CEL evaluation as an activity. All new behaviour behind `workflow.patched('task-864-core-vocabulary')`; replay fixtures re-captured.
- **Realtime lane** (gateway) unchanged in shape; handlers keyed by `core.agent`/`core.action` + `execution.cadence` instead of node type.
- **Terminal status** (fixes G9): a background consumer of `wf:run:<runId>:events` (BullMQ processor in the gateway, not tied to an HTTP connection) calls `recordRunFinished`, writes `CANCELED` on cancel, and emits a `WorkflowRun` sys-event (`ResourceType.WorkflowRun` added, reversing the recorded exemption **by owner decision in this ticket**) → outbound webhook fan-out with a PHI-free payload (`slug, runId, status, terminalReason, timestamps, consultationId?`).
- **Search attributes** on the Temporal execution: `tenantId`, `workflowSlug`, `workflowVersionId`, `status`, `trigger` — so `/workflow-runs` filters without a second index.

### 3.4 Publishing, triggers and protocols

| Trigger kind | Entry | Notes |
|---|---|---|
| `consultation` | `POST /consultations/open { workflowDefinitionSlug? }` → dispatch (unchanged) | clinical plane; `externalWrite` actions allowed only here |
| `api` | `POST /api/v1/workflows/{slug}/runs?mode=blocking|stream|async` | the Output node's `protocols` bound which `mode`s are accepted: `http` → `blocking`, `http-sse` → `stream`; `async` always allowed (poll `GET …/runs/{runId}`) |
| `webhook` | `POST /api/v1/hooks/workflows/{slug}` with a per-definition HMAC secret (`Webhook`-style rotation), body = trigger payload, responds `202` + `runId`; `WorkflowRun.trigger = 'webhook'` finally produced | inbound; replaces the reserved-but-unwired vocabulary |
| `socket` | `WS /ws/workflows/{slug}/runs/{runId}?ticket=` — the same frames as the SSE stream over a WebSocket, single-use stream ticket (`workflow_run:<runId>`) | for hosts that cannot hold SSE (mobile webviews); no JWT in URL |
| `schedule` | reserved; `CronJob`-driven `api` trigger in a later ticket | — |

Generated documentation: publishing stamps `openapi.components.schemas.Workflow_<slug>_Input/Output` from the Trigger/Output schemas and an AsyncAPI fragment for the stream/socket frames; `pnpm api:openapi` regenerates; `/developer` lists published workflows and agents per tenant.

Exposure boundary: `EXPOSURE_ALLOWED_PALETTES` → replaced by a **class-based** rule (already how the gate really works): a graph containing an `externalWrite` clinical action is invokable only through the consultation-bound route; everything else is invokable through `api`/`webhook`/`socket`. Sandbox suppression unchanged.

### 3.5 Studio v2

- Per-port handles (`Handle id=<port>` per declared input/output; fan-out handles for Classify/Condition branches); `isValidConnection` = tier 1 + tier 2 from the contract package; node-type renderers via the existing `nodeTypes` map (Agent shows task + agent name, Classify shows classes as handle labels, Note renders markdown, Loop is a resizable group node with `parentId` children and `extent: 'parent'`).
- `<MiniMap>`, elkjs auto-layout (subflow-aware), JSON import/export (graph only; bindings re-validated on import), CEL editor with autocomplete over `nodes.*`/`vars.*`/`trigger.*` and inline type errors from `cel-js`.
- Inspector: Agent picker (published agents by task, "create agent" deep link), model picker for Classify (registry rows by task with availability badge), Variable table editor, Trigger context-schema editor (reuse the Context Schemas builder), Output schema + protocols.
- List editor stays the keyboard-first peer (adds branch handles as labelled rows). Undo/redo, autosave/OCC, publish dialog, versions, clone, assignments unchanged.

### 3.6 Migration and deprecation (mark now, remove in release +2)

| Item | Action |
|---|---|
| Palettes `summarization`, `stt`, `consultation`, `agentic` and their 58 node types | registry entries get `deprecated: true` (new descriptor flag) + `replacedBy`; `compile()` still accepts them for the window; Studio hides them from the palette rail but renders existing graphs; `WF-*` rules retargeted to `core.*` |
| Seeds `21`, `23`, `23a`, `24` + regen scripts + seed tests | rewritten in `core.*` vocabulary via the regen scripts (engine-generated `.generated.ts` discipline kept); `23a` deleted (TASK-861) |
| `agent.*` node types | become seeded Agents (TASK-863 §3.7) referenced by `core.agent` |
| `agentic.stt` / `agentic.tts` | `core.agent` with an ASR/TTS agent |
| `EXPOSURE_ALLOWED_PALETTES` | replaced by the class-based rule |
| `WorkflowAssignment.paletteKey` | keeps working (`'core'`); assignment matrix groups by trigger kind |
| `ConsultationLoopWorkflow` / `HarnessDocWorkflow` (Substrate A) | **not in this ticket** — stays the zero-configuration default; owner question §6 |

## 4. Implementation Plan

Phase A adds the vocabulary alongside the old palettes (non-breaking); Phase B migrates seeds and the Studio; Phase C marks the old palettes deprecated.

| # | Step | RED test | Files |
|---|---|---|---|
| A1 | Contract: `core.*` descriptors (ports, config schemas, `deprecated`/`replacedBy`/`actionKey` fields), `NODE_PORTS`, snapshot fixture regenerated; `paletteKey: 'core'` | `node-contract.test.ts`, `node-registry-parity.test.ts`, golden pass/fail fixtures per new type | `packages/workflow-contract/src/{node-registry,node-config-schemas,node-ports}.ts` |
| A2 | CEL: `cel-js` type-check helper (`conditionProblems(graph)`), `celpy` activity, cross-language fixture | `cel-parity.contract.test.ts`, `test_cel_parity.py` | `packages/workflow-contract/src/expressions.ts`, `apps/harness/.../interpreter/activities.py` |
| A3 | Compiler: branches, loops (nested compiled body), note stripping, lane/cadence from node config, gates from `core.humanReview` | `compiler.test.ts` (+ replay fixture recapture) | `compiler.ts`, `apps/harness/.../interpreter/compiled_config.py` |
| A4 | Interpreter: branch gating, `LoopWorkflow` (foreach/while), `ReviewGateWorkflow` generic, `interpreter.trigger/output/variables/classify/evaluate/agent` activities, `workflow.patched('task-864-core-vocabulary')` | `test_interpreter_semantics.py` (branches, loops, review), replay-compat suite | `apps/harness/src/harness/temporal/interpreter/{workflow,loop_workflow,gate_workflow}.py`, `nodes/core_*.py`, `registry.py` |
| A5 | Realtime lane handlers keyed by `core.agent`/`core.action` + cadence | `realtime-node-registry.test.ts` | `packages/applications/src/services/consultation/live-documentation/realtime/**` |
| A6 | Exposure: class-based boundary; `?mode` bounded by Output `protocols`; inbound webhook trigger route + secret; socket stream gateway; run-completed webhook (G9 fix: background consumer, `CANCELED` write, `ResourceType.WorkflowRun` + migration) | e2e `task-864-{invoke-protocols,webhook-trigger,socket-stream,run-completed-webhook}.spec.ts` | `apps/api/src/modules/{workflows,webhook,streaming}/**`, `packages/applications/src/services/{workflow-exposure,workflow-run,webhook}/**`, `audit.prisma` + migration |
| A7 | OpenAPI/AsyncAPI generation from Trigger/Output schemas; `/developer` listing | `api:openapi:check` | `apps/api/src/openapi/**`, `apps/admin-console/src/features/developer-docs` |
| B1 | Studio v2: per-port handles, node renderers, group nodes for loops, minimap, elkjs layout, import/export, CEL editor, new inspectors | feature tests + axe 0 violations, both themes; `next-dev-loop` runtime pass | `packages/ui/src/components/workflow-canvas/**`, `apps/admin-console/src/features/workflow-studio/**` |
| B2 | Seeds `21/23/24` rewritten in `core.*`; regen scripts; seed tests | seed drift tests | `packages/database/src/prisma/db_main/seed/**`, `packages/database/scripts/regen-*.ts` |
| B3 | vox-node: `hope.workflows.hooks.*` (webhook secret mgmt via admin), `streamRunSocket()`; vox: `useWorkflowRun` socket option | SDK tests | `packages/vox-node/src/resources/workflows.ts`, `packages/agentic-sdk-v2/src/hooks/useWorkflowRun.ts` |
| C1 | Old palettes `deprecated: true`; Studio hides them; rule catalogue retargeted; deprecation register rows; docs (`docs/architecture/**` workflow sections, integration guide §2–3) | `node-registry.test.ts` asserts every non-core entry is deprecated with `replacedBy` | — |

### Verification criteria

- Contract, applications, api unit + e2e, harness (incl. replay-compat), console gates green.
- Live proof: author in the Studio `Trigger(api) → Classify(gliguard, classes safe/unsafe) → [safe] Agent(platform-summarization) → Human review → Output(http-sse)`; publish; `POST /workflows/{slug}/runs?mode=stream` streams node events, pauses at review, resumes on `POST …/reviews/{nodeId}` `{decision:'approved'}`, completes; the unsafe branch ends at Output with a rejection object; `mode=blocking` is refused (`http` not declared).
- Loop proof: `foreach` over 3 items completes in 3 child generations (history bounded); `while` with `maxIterations: 2` stops with `iterations` reason.
- Run-completed webhook delivered for a fire-and-forget `mode=async` run with no reader attached.

## 5. Decisions taken (owner may override)

| # | Decision | Alternative rejected |
|---|---|---|
| D-1 | One `core` palette; clinical steps as `core.action(actionKey)`. | 40+ node types — palette sprawl, checksum churn. |
| D-2 | CEL for conditions/loop-until. | JSONata / JS subset — see §3.2. |
| D-3 | Loop bodies as `parentId` sub-graphs executed as child workflows. | Inline "back edges" (cycles) — the validator's `ACYCLIC` rule and Temporal history bounds both favour explicit bodies. |
| D-4 | Protocols declared on Output, bounded at invocation. | Caller-chosen only — the owner wants the schema and protocols visible to integrators before they call. |
| D-5 | `WorkflowRun` gets a sys-event (reverses the recorded exemption) to make the run-completed webhook real. | Keep the exemption — leaves fire-and-forget runs `RUNNING` forever. |
| D-6 | Substrate A stays the default engine this ticket; retirement is a separate decision. | — |

## 6. Open questions for the owner

- **Q-B2 — rewriting seeds 21/23/24 in `core.*`.** The consultation rule set (`CR-*`, `DRAFT_CONSULTATION_RULE_SET`) keys its mandatory-presence and ordering guarantees on the `consultation.*` TYPES; a seed rewritten as `core.action` wrappers would pass the core rule set and silently lose those guarantees unless the rules are first retargeted to see through `actionKey`. That retargeting changes what "consent before generation" means for every tenant graph and needs an owner decision; the derived blobs are regenerated and green meanwhile.
- **Q-harness — `workflows.py:748 workflow.patched()` without an id** (Substrate A, base branch). A one-token fix, but the patch id is a replay-compat decision for `HarnessDocWorkflow`'s fixtures; not touched here.
- **Q-CEL libs** — `cel-js`/`celpy` deliberately not declared (native evaluators); add on request.

1. Retire Substrate A (`ConsultationLoopWorkflow`/`HarnessDocWorkflow`) once every tenant is provisioned with a SYSTEM-cloned `core` consultation workflow? (Recommended as a follow-on ticket after two releases of parity.)
2. Should Human review be assignable to a **role** only, or also to a named user/department queue? (Today the gate escalates by SLA; there is no assignee.)
3. `schedule` trigger: in scope for this program or later?

## 7. Implementation Summary

Branch `task-864-workflow-studio-v2` (worktree `../hope-v2-task-864`, base `dev-2.2` @ `1896ebc03`).
Status per plan step — **done** unless marked.

| Step | Outcome | Evidence (real command output, worktree) |
|---|---|---|
| A1 contract | `core` palette (11 types) + `core.action` catalogue (31 keys), `any` consumer wildcard, class selectors (`entry`/`terminal`/`annotation`), per-instance ports (`branchHandlesOf`/`effectivePorts`), Trigger/Output declarations, `DRAFT_CORE_RULE_SET`, parity snapshot (69 entries) | `pnpm --filter @arcaai/workflow-contract test` → 33 files / 1478 tests |
| A2 CEL | native TS + Python evaluators over ONE fixture (`expressions.fixture.json`; whole doubles are ints on both sides; errors are values) | contract suite above; `py-workflow-contract` 69 passed; harness `test_expressions_parity.py` |
| A3 compiler | `branchGuards` + `loops[]` (`parentId` sub-graphs), byte-identical artifacts for legacy graphs (both omitted when empty); Python `CompiledLoop`/`CompiledBranchGuard` | golden fixtures WF-CORE-001..003; parity test |
| A4 interpreter | `workflow.patched('task-864-core-vocabulary')` cheap-operand-first; branch gating (`branch_not_taken`), run context `{trigger, vars, nodes}` for core nodes only; `LoopWorkflow` ('CoreLoop', one iteration per generation + `continue_as_new`, foreach/while/until, nested, parent-owned `maxDurationSeconds`); `ReviewGateWorkflow` ('ReviewGate', signal/query, timeout → `timedOut`); `POST/GET /workflow-runs/{run}/reviews/{node}`; fixture `interpreter_core_v1_history.json` (125 events) via `_capture_core_replay_fixture.py`, `TestCoreVocabularyReplayCompatibility` | `pytest src/harness/tests/ -q --no-cov -p no:cacheprovider --deselect …TestReplayCompatibility -k 'not (<16 optimistic-gate tests>)'` → **2054 passed, 29 deselected, 2 failed** — every excluded/failed test is Substrate A (`HarnessDocWorkflow`) and fails on the BASE branch: `workflows.py:748` calls `workflow.patched()` with no id (`TypeError` inside workflow code → endless task retry → a hang in the time-skipping env). `workflows.py` is untouched here. `ruff check src` → All checks passed |
| A5 realtime lane | admission per instance (`execution.lane`), `core.action` delegates to its action's realtime handler, `canonicalRealtimeNodeType(type, config)` | `realtime-core.task864.test.ts` green with the existing lane suites |
| A6 exposure | class-based boundary (`clinicalWriteViolation`), `?mode` bounded by Output protocols (400) + trigger kinds (404), inbound webhook `POST /hooks/workflows/{hookId}` (`sha256=HMAC(secret, "<ts>.<rawBody>")`, ±300 s, single 404), `WorkflowWebhookSecret` (NEW `workflow-webhook.prisma`, migration `20260904120000_task_864_workflow_v2` — `ADD VALUE 'WorkflowRun'` + table; authored via shadow diff, header-clean, NEVER applied), AES-256-GCM secret via `WebhookService.encryptSecret`, `POST /admin/workflow-definitions/slug/{slug}/webhook-secret`, `/ws/workflows` gateway (stream ticket `workflow_run:<runId>`), `WorkflowRunCompletionService` (terminal write incl. `CANCELED` + `terminalReason`, `workflow-run-completion` worker session), ONE `ResourceUpdated` sys-event on `ResourceType.WorkflowRun` | applications: `npx vitest run …/workflow-exposure …/workflow-run` → 9 files / 95 tests; api: `npx dotenv -e .env.test -- npx vitest run apps/api/src/modules/{workflows,workflow-definition,webhook,streaming}` → 24 files / 456 tests; `pnpm --filter @arcaai/api build` clean; `pnpm --filter @arcaai/database test` → 79 files / 1862 tests; `gen:model:check` no drift |
| A7 docs generation | `describeWorkflow()` in `@arcaai/applications` (the gateway has no `workflow-contract` dependency): `Workflow_<slug>_Input/_Output` components, admitted modes, AsyncAPI fragment; `GET /workflows/{slug}/schema` per tenant. NO committed artifact regenerated (orchestrator step) | `workflow-schema-description.task864.test.ts` (in the 95 above) |
| B2 seeds | **PARTIAL.** Derived blobs of 21/23/23a/24 regenerated for the core registry (three regen cycles as the registry moved: core entries → deprecation flags → `format: 'cel'`); 21's print-only script had exactly two literals swapped from its own drift report (`DRIFT: 0`). The authoring sources were NOT rewritten in `core.*` — see §6 Q-B2 | database gate above (every seeded graph validates with ZERO findings) |
| B1 Studio v2 | per-port handles (`ports` → one handle per port, kind + primitive exposed), `core.loop` as a derived-size group with `parentId` children (React Flow `extent: 'parent'`), minimap, `layoutWorkflowGraph` (pure layered engine; injectable ELK engine; `elkjs` declared as an `optionalDependency` of `packages/ui`, NOT installed/imported), JSON export/import (shape-checked, undoable `replaceGraph`), CEL editor (`format: 'cel'` strings; balance fast-fail + reference chips), `core.agent` picker against TASK-863 §3.5 (`GET /admin/agents?task=`, slug-box fallback on 404), `core.action` inspector (registry-driven action select = deprecated types with `replacedBy: 'core.action'`, delegate schema under `action.`), core node renderers, palette hides deprecated types and lists `core` first, `any` + per-instance ports mirrored with drift tests | `packages/ui`: `npx vitest run src/components/workflow-canvas` → 3 files / 26 tests; console: `npx vitest run src/features/workflow-studio` → 38 files / 324 tests; `npx eslint src/features/workflow-studio` clean; `tsc` clean for `workflow-studio`/`workflow-canvas` (the 6 remaining console errors are base-branch/unbuilt-sibling-dist files: `playground-*` on `@arcaai/vox`/`@arcaai/stt`, `ai-platform/huggingface-fetch-drawer.tsx`) |
| C1 deprecation | all 58 non-core descriptors `deprecated: true` + `replacedBy` (pinned by `deprecation.task864.test.ts`); DTO + Studio mirror carry the flags; register rows flipped to `marked`; integration guide §3.2a/§3.5a/§Webhooks amendment; this README | contract + database gates above |

### Dependencies declared, not installed (per brief)

- `elkjs@^0.11.1` → `packages/ui#optionalDependencies`. Not imported anywhere: `layout.ts` takes an injected ELK-shaped engine and ships a pure layered fallback (a static import of an uninstalled module is a build error, not a fallback).
- `cel-js` / `celpy` — **NOT added.** Both evaluators are native and held to one fixture; adding manifest entries for libraries the code never calls would be a lie to the lockfile. Report as a deviation; trivial to add if the owner wants the option.

### Cross-ticket seams coded against

- TASK-863: `GET /internal/agents/resolve` — reconciled against the MERGED route on 2026-09-04 (orchestrator): the slug travels as `agentSlug` (the route reads `task` / `agentSlug` / `departmentId`, never `slug`), and the answer is `ResolvedAgent` from `packages/types/src/agent.ts` — selection under `compiledConfig`, registry facts under `models[]` by role. `interpreter/models.py::ResolvedAgent` lifts both into the flat `model` / `fallbacks` / `instruction` / `resolvedPrompt` fields the activities read (`test_core_agent_resolution.py`). The route serves the ACTIVE version and takes no pin, so `agentRef.versionNumber` is enforced by the activity after resolution: a drift DEGRADES with `agent_version_drift` (fails closed — a pin that ran whatever is active would be no pin). Follow-up F-863-1: teach `AgentResolverService.resolve` an optional `versionNumber` so a pinned graph keeps running after a republish. `GET /admin/agents?task=&status=PUBLISHED&limit=200` (Studio picker; tolerates a bare array or `{ data }`); `/agents?create=1` deep link.
- TASK-862/860: none (model selection stays behind the agent reference).
- TASK-865: SDK additions wanted — `hope.workflows.schema(slug)`, a `/ws/workflows` client, inbound-webhook signing helper (`signWebhookTrigger` is exported from `@arcaai/applications` for parity), `WorkflowRun` webhook payload type.
- `nav-config.ts` (TASK-862): no new route — the Studio v2 lives at the existing `/workflow-studio/*`.

## 8. Change History

| Date | Change |
|---|---|
| 2026-09-04 | Ticket created from the TASK-859 review. |
| 2026-09-04 | A1–A3 landed (`7dc6fd254`): core contract, CEL evaluators, branch/loop compiler, Python parity. |
| 2026-09-04 | A5 (`a3fcf4ec8`), A6+A7 (`5a8a0575a`), seed regen (`2d7245b15`), A4 (`452dcee12`), C1 part 1 (`9562f70ff`); then B1 Studio v2 + C1 docs/register/seeds. Harness gate excludes the base-branch `HarnessDocWorkflow` `patched()` defect (§7). |
| 2026-09-04 | Orchestrator verification on the merged tree (dev-2.2 = base repairs + 862 + 863 + 860): `WorkflowNodeResponse.deprecated` is `boolean \| null` (`?? null`, per the totality rule) and `palette-key.test.ts` records the `core` palette as authorable AND exposure-allowed (A6) — `b51896a5a`. Harness `core.agent` reconciled with the merged 863 resolve contract (`agentSlug`, `compiledConfig` + `models[]` lifting, post-resolution version-pin check) — see §Cross-ticket seams. Full gates re-run: console lint + 263 files / 2315 tests, console build, applications + api unit (api: 7 pre-existing `ai-inference.controller.test.ts` failures reproduce on dev-2.2 — a TASK-862 constructor-slot drift, fixed there), harness `tests/unit/temporal/interpreter` + `tests/unit/services` (587 passed); `pnpm harness:typecheck` brought to the single pre-existing base error (`e73574703` — the branch had added 11). Merged into dev-2.2 at `ac5d4068a`; on the merged primary: shadow-DB proof drift-free (ledger replayed, `-- This is an empty migration.`), harness ruff clean / mypy at the single base defect / 587 tests. |
