# Realtime Clinical Consultation — Fast-Win Proposal (WORKING DRAFT)

Status: COMPLETE
Repo: /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2  branch dev-2.2
Date: 2026-09-01

## A. WHAT HAPPENS TODAY (end-to-end trace)

### A.0 Headline

**A realtime clinical consultation with live transcription, live NER and incremental
("running") summarization ALREADY RUNS TODAY, end to end, and it is already driven by a
DATA-DEFINED graph rather than a hardcoded script.** It is not the Temporal interpreter that
runs it — it is a second, in-gateway executor (`runRealtimeLane`) shipped by TASK-811, and the
Temporal interpreter deliberately SKIPS every `lane: 'realtime'` node
(`apps/harness/src/harness/temporal/interpreter/workflow.py:278`, `reason="realtime_lane"`).

### A.1 Session open + recording start

1. `POST /api/v1/consultations/:id/recording/start`
   — `apps/api/src/modules/consultation/consultation.controller.ts:686-706`.
   Guarded by `@RequiresConsent(ConsentPurpose.AI_DOCUMENTATION)` (`:687`) and
   `verifyConsultationOwnership(id)` (`:689`).
   It flips `Consultation.status → RECORDING` and calls
   `liveDocumentationService.start({ consultationId, tenantId, userId, sessionId })` (`:691-696`).
   **It returns `sseUrl: '/consultations/:id/live-summary/stream'` (`:702`)** — i.e. the server
   already hands the client its stream URL at session start.
2. `LiveDocumentationService.start(...)`
   — `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts:745`.

### A.2 Audio in → transcript

- Browser mic → `@arcaai/vox` pipeline → `SttWebSocketClient` → gateway
  `SttWsGateway` at `/ws/stt/stream` (`apps/api/src/modules/streaming/stt-ws.gateway.ts`).
- `apps/stt` (8861) streams results back over **Redis Streams**.
- The gateway's live-doc session subscribes to those results:
  `LiveDocumentationService.attachSttStream(...)` →
  `this.audioBridge.subscribeToResults(sessionId)` and, for every `msg.type === 'transcript'`
  **with `msg.isFinal`**, calls `ingestSegment(...)`
  — `live-documentation.service.ts:2355-2378`.
- `ingestSegment` — `live-documentation.service.ts:1252`.

### A.3 Flush cadence (the "partial / incremental" tick)

- `scheduleFlush(session)` — `live-documentation.service.ts:2389-2394`: a debounce timer of
  `this.lastAgenticContext.idleMs`, i.e. flush after the room goes quiet.
- `scheduleThrottledFlush(session)` — `:2401-2408`: coalesces a burst into one flush when the
  `minIntervalMs` window reopens.
- Both call `flush(consultationId)` — `:1360`.

### A.4 The flush executes a GRAPH, not a script (TASK-811)

`flush()` builds a `RealtimeCapabilities` bundle and calls
`runRealtimeLane({ lane, consultationId, tenantId, capabilities, isStale, signal })`
— `live-documentation.service.ts:1969-1976`.

- Executor: `.../live-documentation/realtime/realtime-executor.ts:208` (`runRealtimeLane`).
  Header (`:1-21`) states its four guarantees: inputs resolve by DECLARED PORT; **NER can never
  receive generated text** (port-type check, `document` vs `transcript`); budget/retry/staleness
  are PER NODE; **degrade is never silent** (every skip/degrade/timeout emits a typed event).
- Lane source: `.../realtime/realtime-lane.ts`.
  - `PLATFORM_REALTIME_LANE` (`realtime-lane.ts:115-162`) = today's behaviour as a graph:
    **stage 0** `capture` (`consultation.captureBinding`) → **stage 1** `extract`
    (`consultation.extractEntities`, `onError: 'degrade'`) **and** `summarize`
    (`consultation.realtimeSummary`, `onError: 'degrade'`) running CONCURRENTLY.
  - `buildRealtimeLane(compiled)` (`realtime-lane.ts:186-238`) derives the lane from **the
    tenant's published `consultation`-palette graph's `compiledConfig`**, filtered to
    `REALTIME_NODE_TYPES`, renumbering stages densely. Returns `null` → caller serves the
    platform lane, "because a consultation with no documentation is a worse clinical outcome
    than one documented by the default lane" (`:183-185`).
  - **`enabled: node.config?.enabled !== false` (`realtime-lane.ts:213`)** — a node authored OFF
    is skipped by the executor. *This is already an admin-authored per-capability toggle.*
- `REALTIME_NODE_TYPES` is DERIVED from `WORKFLOW_NODE_REGISTRY` by `descriptor.lane === 'realtime'`
  — `.../realtime/realtime-node-registry.ts:53-56`.
- `REALTIME_NODE_HANDLERS` — `realtime-node-registry.ts:426-438` — seven handlers:
  `consultation.captureBinding`, `consultation.extractEntities`,
  `consultation.realtimeSummary`, `agent.transcription` (alias→captureBinding),
  `agent.ner` (alias→extractEntities), `agent.grammar`, `agent.important_findings`.
- Per-flush capability closures (`live-documentation.service.ts:~1900-1965`):
  `generateDocument` → `apps/text`; `extractEntities` → `this.toolRegistry.extraction().execute(...)`
  → `apps/nlp` (**one HTTP call**, `vitals` a projection of the same `nlp.classify-tokens`
  response, `:1958-1964`); `proposeCorrections` (grammar, `:1949`); `extractFindings` (`:1955`).
  **`ner` and `vitals` are gated per-flush by `this.toolRegistry.isEnabled(ctx.agent.toolPlan, …)`
  (`:1960-1962`)** — a SECOND, agent-snapshot-level capability toggle.

### A.5 Out to the browser — SSE over Redis pub/sub, ticket-authenticated

All already exist on `ConsultationController`, each with `@TenantOwnedResource` (pre-stream
404-over-403) + its own `@StreamScope` namespace (single-use ticket from
`POST /auth/stream-ticket`, never a JWT in the URL):

| Route | line | Redis channel | Carries |
|---|---|---|---|
| `GET :id/live-summary/stream` | `consultation.controller.ts:743-753` | `consultation:live-summary:{id}` | `LiveSummaryEventDto` — running note + entities + vitals; terminal `closed: true` |
| `GET :id/live-assist/stream` | `:770-784` | `consultation:live-assist:{id}` | `LiveAssistEventDto` — suggestions + PROPOSED corrections (declared PHI-carrying) |
| `GET :id/harness-progress/stream` | `:791-801` | `consultation:harness-progress:{id}` | stage checklist, no PHI |
| `GET :id/harness-assurance/stream` | `:810-820` | `consultation:harness-assurance:{id}` | per-claim verdicts |
| `GET :id/trajectory/stream` | `:831-841` | `consultation:trajectory:{id}` | ordered agentic steps |
| `GET :id/loop/stream` | `:857-867` | `consultation:loop:{id}` | `LoopEventDto` |

Plus a DURABLE read-back for sections: the controller notes "the `section.patch` SSE lane only
emits while a flush is running, so a client that reloads …" (`consultation.controller.ts:1080`),
served by `GET :id/sections` and written per-section by `DocumentSectionStore`
(`.../realtime/section-store.ts`).

`subscribeToLiveSummary` — `live-documentation.service.ts:2317`; channel name
`consultation:live-summary:{id}` — `:3204`. Generic relay helper `sseFromRedisChannel`
(`@arcaai/applications`, used at `consultation.controller.ts:841, 867`).

### A.6 Recording stop → durable/Temporal leg

`POST :id/recording/stop` — `consultation.controller.ts:709-739`: tears down the live session
(`liveDocumentationService.stop(...)`, `:716`), reverts status, then
`loopContextSignalService.signalConsultationEnding(id, { reason: 'recording_stopped', …,
acceptedProposals })` (`:724-734`) — which is what hands the session to the durable
(Temporal) side for the endpoint stage (`summary.finalize`, `feedback.capture`,
`session.timeout`).

### A.7 Where Temporal actually sits

The durable interpreter (`apps/harness/.../interpreter/workflow.py:87` `WorkflowInterpreter`)
runs the **durable** consultation nodes only. `_dispatch_node` SKIPS any `lane: 'realtime'`
node with `reason="realtime_lane"` (`workflow.py:278`), so the two runtimes never both write one
consultation's document — that hazard is closed STRUCTURALLY, not by convention
(`realtime-lane.ts:29-42`, `registry.py:154, 645, 660`).

**Answer to "does partial summarization already exist?" — YES.**
**Answer to "does live NER already exist?" — YES.**
Both are stage-1 nodes of `PLATFORM_REALTIME_LANE`, running concurrently on every flush, with
results published on `consultation:live-summary:{id}` and streamed by SSE.


## B. TICKET LEDGER

All paths under `docs/implementation/`. Status read from each README header line 5.

| Ticket | Status (README:5) | Delivered | Planned / NOT shipped |
|---|---|---|---|
| **TASK-811-Multi-Document-Realtime-Runtime** | **Completed 2026-08-28** (follow-on §8/§9 dated 2026-08-29) | THE realtime graph executor. Replaced `flush()`'s hardcoded 11-step sequence with a walk over a compiled realtime lane; per-section `DocumentSection` model + state machine; per-node budget/timeout/staleness; guard memoization; offset re-anchoring; substrate gate on `startRecording`; **`section.patch` SSE payload** (`documentKey`/`sectionKey`/`revision`/`state`/`annotations`/`provenance`); REST `GET/PATCH …/documents/:documentKey/sections[/:sectionKey]` with `_version`/`If-Match` OCC | `sttPipelineId` not threaded into `recording/start` (capture node reports `pipelineId: null`); a Vault-encryption failure in `DocumentSectionStore.encrypt()` silently loses clinician-edited section content; a persisted clinician edit publishes NO `section.patch`, so a 2nd live viewer sees stale content |
| **TASK-829-Realtime-Consultation-Guardrail** | **In Progress — "Phase 1 decision plane merged; wiring outstanding"** (last CH 2026-08-31) | `apps/guardrail` only, self-contained: 3-axis realtime verdict, deterministic T0 (Aho-Corasick), session-level T1 statistical aggregation, 4 routes under `/api/v1/guardrail/realtime/*`, `RealtimePolicy.stamp` cache invalidation, output-side checks. ~93 new tests | **NOTHING CALLS IT.** `TranscriptSegment.validationRef` column does not exist in Prisma; no `apps/stt` segment-finalization hook (zero refs to `read_segment_verdict` in `apps/stt/src`); no durable audit record; `apps/harness` still calls `GuardrailClient.analyze()` directly; no admin-console alert surface; **no seed row for the 9 tuning keys**; T2 LLM judge not built; T0+T1 p95 ≤ 120ms budget UNVERIFIED |
| **TASK-834-Knowledge-Retrieval-Agent-Node** | **Pending** (opened 2026-08-31, plan deliberately unwritten) | Nothing (§4: "_Not started._") | Survey found `agent.retrieval` + `consultation.retrieveEvidence` already `implemented: true`, but their whole tenant-facing config is `retrievalEnabled` (bool) + `onError`, locked by `additionalProperties: false` on `CONSULTATION_RETRIEVE_EVIDENCE_SCHEMA` (`packages/workflow-contract/src/node-config-schemas.ts:670,1150,1179`). Missing: citations/attribution, pluggable embedding backend, prompt-instructions + knowledge-source fields |
| **TASK-806-Consultation-Workflow-Substrate-Unification** | **Completed 2026-08-30** ("all nine sub-tickets closed", TASK-808…816) | Master ticket. `startRecording` gates on `Consultation.metadata.governingEngine`; realtime lane is graph-driven **behind a per-tenant flag** with trajectory parity vs legacy. Eval/golden-set gate with a tenant-admin enable/disable toggle (OD-11). §2 line 319 records the deliberate split: **"Realtime lane → in-process"**, NOT Temporal | §8 closing: **"no 'important information highlighted' layer exists anywhere"** and **"the finalization chain is not seeded"** — both recorded as owner expectations NOT met. TASK-808's 3 remaining DoD items are deploy-gated |
| **TASK-814-Playground-Clinical-Surface** | **Completed 2026-08-29** | Tenant-admin→clinician impersonation; "add detail during consultation"; live-summary SSE status/error surfacing; **`useDocumentSectionsStream` hook consuming `section.patch`** with `empty`/`provisional`/`confirmed`/`locked` badges; wired the previously-dead `feedback.capture` promotion chain end-to-end; axe scans | Per-section clinician editing on the LIVE document view deliberately not wired. **Entities render from a local `useNamedEntities` NLP query, NOT from the realtime graph stream** (§2:91) — the console's live-NER display bypasses the live-document plane. N>1 documents unproven ("every `section.patch` carried the same `documentKey`") |
| **TASK-798-Demo-Workflow-Seed** | **Review** (no completion date; only CH entry 2026-08-23) | Seeds TWO `PUBLISHED` tenant-authored consultation-palette `WorkflowDefinition`s — `arcaai-consultation-soap`, `arcaai-rheum-consultation-soap` — whose chain is exactly `captureBinding → extractEntities → realtimeSummary → bindTerminology → phiHop → retrieveEvidence → assemblePrompt → synthesize → suggestions → proposeCorrections → sensors → persistDraft → finalizeAssurance → hitlGate`. Two dept-scoped `ConsultationContextSchema` rows. Vault-Transit-encrypted `WorkflowTestFixture` rows | **W2 — the `WorkflowAssignment` rows that would actually turn the graph on are authored but DELIBERATELY NOT ENABLED.** `CONSULTATION_ASSIGNMENT_ENABLED` evaluates `false`, blocked on TASK-795 Substrate-A exclusivity. Both new seed phases are excluded from `safe` (day-1) mode |
| **TASK-821-Seed-Grammar-And-Findings-Nodes** | **Completed 2026-08-30** | Config-only fixes, no runtime code: (1) seeded `n_grammar` instances (the type existed, **"the live grammar pass ran for no tenant today"**) bound to a new SYSTEM-tenant platform-default `PromptTemplate` `71000000-…-043`; (2) **rewired `n_capture.out → n_realtime.in`** — `consultation.realtimeSummary.in` was UNWIRED in graph mode so the running note was generated from `''` | §9 is explicit its proof is STRUCTURAL only: it does not establish "that a live model call returns useful corrections, that latency fits the flush budget, or that the console panel renders them". Named follow-up: **one live session against the ArcaAI tenant**. §13: `_CORRECTION_SYSTEM_PROMPT` is a hardcoded literal at `apps/harness/.../nodes/consultation_realtime.py:561` |

### B.1 The one sentence that decides the fast-win

Across TASK-798 / TASK-811 / TASK-821 the same seam appears: **the realtime consultation graph
is built, seeded and structurally proven — and it is turned on for nobody.** Two independent
switches are both OFF:

1. `consultation.realtime.graphExecutor.enabled` — code default **`false`**
   (`packages/applications/src/services/consultation/consultation-gates.constants.ts:145`,
   `CONSULTATION_GATE_DEFAULTS`), consulted at
   `live-documentation.service.ts:1055-1073`. Absence → the LEGACY hardcoded flush.
2. TASK-798's `WorkflowAssignment` seed rows — authored, `CONSULTATION_ASSIGNMENT_ENABLED`
   evaluates `false`, blocked on TASK-795 Substrate-A exclusivity.


## C. CONSULTATION PALETTE (node registry enumeration)

Source: `packages/workflow-contract/src/node-registry.ts` (1313 lines). Field extraction by
script over the `Object.freeze({...})` descriptors. **All entries below carry
`paletteKey: 'consultation'`.** NOTE: the brief said "13 nodes" — that is TASK-731's original
consultation subgraph (`node-registry.ts:508-742`). The palette has since grown to **31**
`paletteKey: 'consultation'` descriptors as TASK-791 (R3 capabilities), TASK-812 (endpoint
stage), TASK-821/834 (agent nodes) landed. All are `implemented: true`.

### C.1 TASK-731 core subgraph — 13 nodes (`node-registry.ts:508-742`)

| key | line | implemented | externalWrite | lane | trigger | activity |
|---|---|---|---|---|---|---|
| consultation.consentGate | 508 | true | false | durable | on-start | interpreter.consultation_consent_gate |
| consultation.captureBinding | 525 | true | false | **realtime** | on-start | interpreter.consultation_capture_binding |
| consultation.extractEntities | 544 | true | **true** | **realtime** | per-turn | interpreter.consultation_extract_entities |
| consultation.bindTerminology | 561 | true | false | durable | per-turn | interpreter.consultation_bind_terminology |
| consultation.phiHop | 578 | true | false | durable | per-turn | interpreter.consultation_phi_hop |
| consultation.retrieveEvidence | 595 | true | false | durable | per-turn | interpreter.consultation_retrieve_evidence |
| consultation.assemblePrompt | 612 | true | false | durable | on-end | interpreter.consultation_assemble_prompt |
| consultation.synthesize | 629 | true | false | durable | on-end | interpreter.consultation_synthesize |
| consultation.sensors | 646 | true | false | durable | on-end | interpreter.consultation_sensors |
| consultation.inferentialSensors | 663 | true | false | durable | on-end | interpreter.consultation_inferential_sensors |
| consultation.persistDraft | 680 | true | **true** | durable | on-end | interpreter.consultation_persist_draft |
| consultation.finalizeAssurance | 697 | true | **true** | durable | on-end | interpreter.consultation_finalize_assurance |
| consultation.hitlGate | 720 | true | **true** | durable | on-end | interpreter.consultation_hitl_gate (runs as CHILD `ConsultationGateWorkflow`, `classes: ['gate','mandatory']`) |

Four `externalWrite: true` = exactly the four C-8 cited. Confirmed.

### C.2 TASK-791 R3 additions — realtime summary / suggestions / corrections (`node-registry.ts:749-806`)

| key | line | externalWrite | lane | trigger |
|---|---|---|---|---|
| consultation.realtimeSummary | 749 | **true** (publishes each interim summary to the live consultation feed) | **realtime** | per-turn |
| consultation.suggestions | 770 | false (proposal surface) | durable | per-turn |
| consultation.proposeCorrections | 788 | false (SAFETY: never applies a correction) | durable | per-turn |

Implementation: `apps/harness/src/harness/temporal/interpreter/nodes/consultation_realtime.py`.
Its module docstring (lines 1-58) states the batching is **activity-side**: "the workflow
dispatches this node once, and the activity windows the bound transcript and emits one
announcement per window as each summary resolves" — and **"The announcement carries no text.
… ids, keys and labels only. So each event carries an ordinal, a total and a character count;
the summary text itself travels as node OUTPUT … Rendering it live needs a read-back surface
the console owns — recorded as a requested contract in the TASK-791 README rather than
invented here."** *(This is the single most load-bearing gap sentence in the whole codebase for
this ask — see §E.)*

### C.3 TASK-812 endpoint stage (`node-registry.ts:835-889`)

| key | line | externalWrite | lane | trigger |
|---|---|---|---|---|
| session.timeout | 835 | true | durable | on-end |
| summary.finalize | 854 | true | durable | on-end |
| feedback.capture | 872 | true | durable | on-end |

### C.4 Agent nodes (`node-registry.ts:924-1195`)

| key | line | externalWrite | lane | trigger |
|---|---|---|---|---|
| agent.transcription | 924 | false | **realtime** | per-turn |
| agent.normalization | 947 | false | durable | per-turn |
| agent.ner | 964 | **true** | **realtime** | per-turn |
| agent.grammar | 1005 | false | **realtime** | per-turn |
| agent.important_findings | 1055 | **true** | **realtime** | per-turn |
| agent.presummarization | 1090 | false | durable | on-start |
| agent.summarization | 1107 | false | durable | on-end |
| agent.discharge_summary | 1124 | false | durable | on-end |
| agent.retrieval | 1141 | false | durable | per-turn |
| agent.feedback | 1158 | **true** | durable | on-end |
| agent.dna_redaction | 1179 | false | durable | on-end |

### C.5 Palette-agnostic guards (`paletteKey: null`)

`guard.phi` (1201), `guard.moderation` (1218), `guard.groundedness` (1235) — all implemented,
all `externalWrite: false`.

### C.6 The `stt` palette is placeholders (for contrast)

`stt.audioInput` … `stt.phiHop` (`node-registry.ts:352-489`) — 8 nodes; `stt.phiHop` is the only
`implemented: false`. All are registry-parity PLACEHOLDERS on the Python side
(`apps/harness/src/harness/temporal/interpreter/nodes/stt_placeholder.py`).

**Total externalWrite:true in the consultation palette: 8** —
`extractEntities`, `persistDraft`, `finalizeAssurance`, `hitlGate`, `realtimeSummary`,
`session.timeout`, `summary.finalize`, `feedback.capture`, `agent.ner`,
`agent.important_findings`, `agent.feedback` (11 counting the agent + endpoint additions).
C-8's "four of thirteen" is correct for the TASK-731 subgraph and is now an UNDERCOUNT for the
palette as a whole — which strengthens, not weakens, the constraint against lifting
`EXPOSURE_ALLOWED_PALETTES`.


## D. EXISTING ADMIN CONFIG MECHANISM

There are **four** admin-config planes touching consultation capabilities. The decisive fact —
and the reason the owner's ask feels unmet even though everything is built — is that **only one
of them governs the REALTIME lane, and it is the one with no UI switch.**

### D.1 Plane 1 — the tenant's published `consultation` graph (THE realtime plane)

| Mechanism | Where | Governs |
|---|---|---|
| `WorkflowAssignment` cascade (`TENANT` / `DEPARTMENT`, unique on `(tenantId, scope, scopeId, paletteKey)`) | `packages/database/src/prisma/db_main/workflow-assignment.prisma:34-77`; audited append-only by `WorkflowAssignmentChange` (`:79-105`) | which published definition governs a scope |
| Resolution at session start | `live-documentation.service.ts:1087-1104` (`resolveTenantLane`) → `findPublishedBySlug` → `buildRealtimeLane(compiledConfig)` | the realtime lane |
| **Node PRESENCE = capability on/off** | Studio `PaletteRail` / `addNode` — `apps/admin-console/src/features/workflow-studio/components/workflow-studio-editor.tsx:364-388` | add/remove `consultation.extractEntities`, `consultation.realtimeSummary`, `agent.grammar`, `agent.important_findings`, … |
| **Node `config.enabled` = capability off WITHOUT removing it** | READ at `realtime-lane.ts:213` | **NOT AUTHORABLE — see §E-3** |
| Screens | `/workflow-studio`, `/workflow-studio/[definitionId]`, `/workflow-studio/assignments` (`apps/admin-console/src/app/(console)/(tenant)/workflow-studio/…`) | — |
| Node inspector | `apps/admin-console/src/features/workflow-studio/components/inspector/inspector-panel.tsx:163` — `toFieldDescriptors(configSchema)`; its own test says *"the inspector builds its form from `Object.entries(schema.properties)` alone"* (`inspector/__tests__/document-pin-round-trip.test.tsx:11`); booleans render as a shadcn `<Switch>` (`inspector/field-renderers.tsx:130-141`) | **⇒ any property added to a node config schema becomes an admin switch for free** |

**Published definitions are hard-immutable** (DB trigger + service convention:
`workflow-definition.prisma:29,40,45`; `workflow-definition.service.ts:469,491`), so a toggle is
a clone-to-draft → flip → publish-new-version act, and the assignment resolves the ACTIVE
PUBLISHED version at dispatch (`workflow-assignment.prisma:54-56`). That is an audit trail, not
an obstacle.

### D.2 Plane 2 — `AsrPipeline`, compiled at publish (the AUDIO/STT capabilities)

- Model `packages/database/src/prisma/db_main/stt.prisma:12-66` + immutable `AsrPipelineVersion`
  `:74-105`. Stages live inside `configYaml`, not columns.
- **Compiled at publish**: an `stt`-palette `WorkflowDefinition` is compiled to `configYaml` by
  `compileSttGraphToYaml()`
  (`packages/applications/src/services/workflow-definition/compilers/stt-pipeline.compiler.ts:79`)
  during `WorkflowDefinitionService.publish()`
  (`workflow-definition.service.ts:374-425`, compile at `:393`), written through
  `PipelineService` by `compileAndPublish()` (`stt-pipeline.compiler.ts:148`), slug
  `wf-stt-<slug>` (`:132-136`), provenance tag `workflow-definition:<id>` (`:39-42`).
  **`diarization: enabled: true` / `vad:` / `denoise:` lines are emitted only if the node is
  present** — that conditional emission IS the stage toggle.
- Read at runtime by `apps/stt/src/stt/pipeline/{yaml_parser,dto}.py`, keyed by `pipelineId`.
  The SDK passes it: `audio.start({ pipelineId, languageMode })`
  (`apps/admin-console/src/features/playground-consultation/components/consultation-demo-screen.tsx:419`).
- Admin surface: `@Controller('admin/audio/pipelines')`
  (`apps/api/src/modules/pipeline/audio-pipeline.controller.ts:26`) — `PATCH :id`,
  `POST :id/clone` (`:160`), `POST :id/set-default` (`:222`), `PATCH :id/toggle` (`:236`),
  `POST validate`. Screen `apps/admin-console/src/features/audio-pipelines/components/audio-pipelines-screen.tsx`.
- A grep-gate proves the compiler adds no new execution surface:
  `packages/applications/src/services/workflow-definition/__tests__/task-724-stt-realtime-untouched.grep-gate.test.ts`.

**An admin can already toggle: VAD, noise filter, diarization (+segmentation/embedding models),
language detection / code-switching, ASR engine + model — per tenant, per pipeline.**

### D.3 Plane 3 — `PipelinePolicy` — a real cascade with a real UI that DOES NOT reach the realtime lane

- Model `packages/database/src/prisma/db_main/pipeline-policy.prisma:28-64`; nullable toggles
  `autoSummaryEnabled`, `autoNerEnabled`, `harnessEnabled`, `dnaStyleEnabled`,
  `dnaRedactionEnabled` (`:40-46`); WORM audit `PipelinePolicyChange` (`:68-105`).
- Cascade **doctor → department → tenant → SYSTEM → code default**:
  `ConfigResolver.resolvePipelineToggles()`
  (`packages/applications/src/services/config-resolver/config-resolver.service.ts:122-160`),
  per-key max scope at `:79-87`.
- `globalOnly` (SUPER_ADMIN-only) is enforced through the settings registry, not a hand-rolled
  list: `pipeline-policy.service.ts:466` checks
  `HOPE_SETTINGS_REGISTRY.getOrThrow('pipeline.<key>').globalOnly`. **`autoNerEnabled` and
  `harnessEnabled` are `globalOnly: true`** (`descriptors/pipeline.descriptors.ts:33-47`) — a
  tenant admin cannot flip NER here.
- UI: cascade matrix with exactly three columns — Auto-summary, Auto-NER, Harness routing —
  `apps/admin-console/src/features/pipeline-policy/components/cascade.ts:26-29`;
  `GLOBAL_ONLY_TOGGLE_KEYS = ['harnessEnabled','autoNerEnabled']` locked with the hint
  "Super Admins only" (`cascade.ts:41,44`). Screen at
  `/harness/pipeline-policy`. API `@Controller('admin/harness/pipeline-policy')`
  (`apps/api/src/modules/pipeline-policy-admin/pipeline-policy-admin.controller.ts:42`).

> **⚠ THE MISLEADING PART.** `autoSummaryEnabled` / `autoNerEnabled` are consumed ONLY by the
> post-consultation note-generation pipeline —
> `packages/applications/src/services/consultation/events/consultation-event.handler.ts:124`
> ("Auto-summary disabled — skipping pipeline") and `:291` ("Auto-NER disabled — pipeline
> stopping after summary"), via `NoteGenerationService.resolveConfig`
> (`note-generation.service.ts:159-170`). **`LiveDocumentationService` contains ZERO references
> to `configResolver` / `resolvePipelineToggles` / `autoNerEnabled` / `autoSummaryEnabled`**
> (verified by grep over the 3567-line file). An admin who turns "Auto-NER" off in the console
> today will still see live entities streaming during the consultation.

### D.4 Plane 4 — `HarnessPolicy` (post-recording durable knobs)

`packages/database/src/prisma/db_main/harness.prisma:333-408` — sensor thresholds
(`entityFaithfulness`, `coverage`, `citationPresence`, `numericDose`, `groundedness`),
`safetyEnabled`, `phiEnabled`, `phiFailClosed`, `textProvider`/`textModel`, `maxRegen`, gate
SLAs, `toolAllowlist`, and the agentic-loop knobs (`optimisticDeliveryEnabled`,
`atomicFactEnabled`, `retrievalEnabled`, `warmStartEnabled`, `nerPriorsEnabled`,
`maxEditReruns`, `regenFeedbackEnabled`, `mcpToolsEnabled`).
`SUPER_ADMIN_ONLY_POLICY_KEYS` — a hand-rolled const list at
`packages/applications/src/services/harness-policy/harness-policy.service.ts:169-184`, enforced at
`:435` and `:658`. API `@Controller('admin/harness')`
(`apps/api/src/modules/harness-admin/harness-admin.controller.ts:73`, `:96`, `:105`, `:131`,
`:141`). Screens: `/harness`, plus `/agentic-policy`.

### D.5 Plane 5 (advisory only) — the SDK-facing feature flags, which gate NOTHING

- `GlobalSetting` namespace `feature-flags`, tenant-scoped rows
  `enable-real-time-transcription`, `enable-ner-extraction`, `enable-code-switching`,
  `enable-dna-style`, `enable-cross-chain-summary`, `enable-local-raw-capture` — seeded at
  `packages/database/src/prisma/db_main/seed/11-global-setting.ts:197-261,476-478`.
- Served by `GET /tenants/me/config`, parsed into `TenantAudioConfig.features`
  (`packages/agentic-sdk-v2/src/types/config.ts:848-856, 912-930, 984-994`) by
  `ModelRegistry.loadTenantConfig()` (`packages/agentic-sdk-v2/src/core/ModelRegistry.ts:306`),
  exposed via `useArcaConfig().tenantConfig`
  (`packages/agentic-sdk-v2/src/hooks/useArcaConfig.ts:56`).
- **No SDK code path gates on `features.realTimeTranscription` or `features.nerExtraction`**, and
  the admin-console playground never reads `useArcaConfig`/`tenantConfig` at all. They are also
  NOT registered as `SettingDescriptor`s, so they are reachable only through the generic
  `GlobalSetting` grid (`apps/admin-console/src/features/settings/components/settings-screen.tsx`).
- The SDK's `KnowledgePipeline` per-stage `location`/`triggerMode` is **hardcoded in the
  browser, not fetched**: `DEFAULT_KNOWLEDGE_PIPELINE_CONFIG`
  (`packages/agentic-sdk-v2/src/types/pipeline.ts:265-282` — `ner: browser/auto`, `spellCheck:
  disabled`, `summarization: backend/manual`), assembled by
  `PluginManager.buildKnowledgePipelineConfig()`
  (`packages/agentic-sdk-v2/src/core/PluginManager.ts:885-897`) from what the HOST APP passes as
  `cfg.plugins.ner` (`AgenticProvider.tsx:386-388`). The admin console passes no `plugins.ner`
  (`consultation-demo-screen.tsx:178-195`), so `KnowledgePipeline` is never initialised there.

### D.6 There is NO per-tenant "consultation capability" model

`grep -rn "^model .*Capability" packages/database/src/prisma/db_main/*.prisma` → nothing. The
only `Capability` construct is the `AiCapability` enum (`enums.prisma:490`), used for
billing/usage metering only.


## E. THE GAP

Four things stand between "the code is there" and "a clinician gets live transcription +
partial summarization + live NER with an admin switching capabilities on and off". None of them
is a new subsystem. Two are switches that are OFF; one is a **five-line schema omission**; one
is a Python skip that was never written.

### E-1 (BLOCKER) The realtime graph executor is OFF by default and nobody has turned it on

`consultation.realtime.graphExecutor.enabled` — descriptor at
`packages/applications/src/services/settings-registry/descriptors/consultation-gates.descriptors.ts:41-57`
(`tier: 'global-kv'`, `maxScope: 'tenant'`, `killSwitch: true`, `failMode: 'open-to-default'`,
`editableBy: 'GlobalSetting'`), code default `false`
(`consultation-gates.constants.ts:150`), read at `live-documentation.service.ts:1055-1073`.

**With it OFF the live flush runs the LEGACY hardcoded sequence, and the tenant's authored
graph is not consulted at all** (`ensureLaneResolved` returns `null` at `:1070-1073`). No
`GlobalSetting` row for this key is seeded anywhere (grep: the key appears only in the
descriptor, the constants file and the consumer).

### E-2 (BLOCKER) No tenant has a `WorkflowAssignment`, so no tenant has a graph — **but the
gate that blocked it is now satisfied**

TASK-798 seeds two PUBLISHED consultation-palette definitions but writes the assignment rows
only when `CONSULTATION_ASSIGNMENT_ENABLED` is true
(`packages/database/src/prisma/db_main/seed/23-arcaai-workflow-authoring.ts:729,737`), which is
`detectSubstrateExclusivityGate().present`
(`packages/database/src/prisma/db_main/seed/substrate-exclusivity-guard.ts:86-105` — strips
comments from `loop-context-signal.service.ts` and looks for a `/workflow/i` reference in what
remains).

**VERIFIED THIS RUN: the probe now passes.** Stripping comments from
`packages/applications/src/services/consultation/loop/loop-context-signal.service.ts` yields 11
executable `workflow` references, including
`import { tenantWorkflowGoverns } from '../governing-engine';` (`:9`),
`private async standDownForTenantWorkflow(...)` (`:47`),
`governs = tenantWorkflowGoverns(consultation?.metadata);` (`:56`) and
`return !(await this.standDownForTenantWorkflow(consultationId));` (`:112`).
TASK-795's exclusivity marker is implemented
(`packages/applications/src/services/consultation/governing-engine.ts:58,62`,
`TENANT_WORKFLOW_GOVERNS_MARKER`). So `CONSULTATION_ASSIGNMENT_ENABLED` evaluates **`true`
today** — TASK-798's README statement that it is `false` is STALE (it predates TASK-795).
The seed phase is still excluded from `safe`/day-1 mode.

### E-3 (THE ACTUAL "CONFIGURED BY ADMIN" GAP) `config.enabled` is READ by the executor and is NOT AUTHORABLE

- The realtime executor honours a per-node kill: `enabled: node.config?.enabled !== false`
  — `packages/applications/src/services/consultation/live-documentation/realtime/realtime-lane.ts:213`;
  the executor then skips a disabled node.
- **But `enabled` is not a declared property of ANY consultation node config schema.** Every
  schema in `packages/workflow-contract/src/node-config-schemas.ts` is
  `additionalProperties: false` (e.g. `CONSULTATION_CAPTURE_BINDING_SCHEMA:593`,
  `CONSULTATION_EXTRACT_ENTITIES_SCHEMA:605`, `CONSULTATION_REALTIME_SUMMARY_SCHEMA:799`), and
  the only palette-agnostic runtime keys folded onto every node are
  `NODE_RUNTIME_PROPERTIES = { timeoutSeconds, retry }` (`node-config-schemas.ts:1233-1240`,
  applied by `withRuntimeProperties` at `:1325-1331`).
- The file states the consequence itself, in a different context: *"every schema here is
  `additionalProperties: false` and the Studio inspector renders a field per DECLARED property,
  so an undeclared key is stripped twice over and a node round-tripped through the authoring UI
  would come back with its gate silently removed"* (`node-config-schemas.ts:183-187`).
- The word `enabled` appears as a config property in exactly two places, neither of them a node
  kill: `EVAL_GATE_PROPERTY.enabled` (`:199`) and `GROUNDING_POLICIES_PROPERTY.items.enabled`
  (`:1074`).

**So today the only way an admin can turn a realtime capability off is to author a graph
WITHOUT that node and publish it.** The toggle the runtime already implements is unreachable
through the supported authoring path. That is the whole distance between the platform and the
owner's ask.

### E-4 The durable interpreter has no `enabled` skip at all

`_dispatch_node` (`apps/harness/src/harness/temporal/interpreter/workflow.py:255-300`) skips on
`unsupported_node_type`, `realtime_lane` (`:274-280`), `activity_mismatch`, and `sandbox`
(`:290-293`). It never reads `node.config`. `CompiledNode.config` is a free
`dict[str, Any]` on the Python side (`apps/harness/.../interpreter/compiled_config.py:123`), so
carrying an `enabled` key needs NO model change — only a skip branch. Without it, an `enabled:
false` on `consultation.suggestions` / `proposeCorrections` / `retrieveEvidence` (all `durable`)
would be silently ignored: a toggle that visibly works for three capabilities and silently
doesn't for the rest is worse than no toggle.

### E-5 (secondary, not on the critical path)

- **Realtime guardrail is a decision plane nothing calls.** TASK-829 Phase 1 merged in
  `apps/guardrail` only; `TranscriptSegment.validationRef` does not exist in Prisma, `apps/stt`
  has zero references to `read_segment_verdict`, and the 9 tuning keys have no seed row.
- **`_CORRECTION_SYSTEM_PROMPT` is a hardcoded literal** at
  `apps/harness/src/harness/temporal/interpreter/nodes/consultation_realtime.py:561` (TASK-821
  §13, "it should be a ticket") — a rule-1 configuration violation on the durable correction node.
- **TASK-806 §8 records two owner expectations as NOT met**: "no 'important information
  highlighted' layer exists anywhere" and "the finalization chain is not seeded". The FIRST is
  now partly false — `agent.important_findings` is `implemented: true`
  (`node-registry.ts:1055`) with a realtime handler
  (`realtime-node-registry.ts:437`) and a `findings?` field on the live payload
  (`live-summary.dto.ts:277-285`) — but it is seeded into no tenant graph.
- **`sttPipelineId` is not threaded into `POST :id/recording/start`** (TASK-811), so the capture
  node reports `pipelineId: null`. Observability only — the SDK does pass `pipelineId` to
  `audio.start(...)` (`apps/admin-console/src/features/playground-consultation/components/consultation-demo-screen.tsx:419`).


## F. THE FAST-WIN

### F.0 The thesis

**Do not build a realtime consultation runtime. One exists, it is complete, and it is switched
off.** The fast-win is: turn on two switches that need no code, make the per-node `enabled`
field the runtime already reads actually authorable (which buys the entire admin UI for free
because the Studio inspector renders a Switch per declared boolean property), teach the durable
interpreter the same skip, and seed the one capability the owner named that is implemented but
in nobody's graph.

Everything below is inside the SESSION-BOUND path of §G. `EXPOSURE_ALLOWED_PALETTES` is not
touched.

### F.1 Ordered changes

| # | Change | Kind | Files | Days |
|---|---|---|---|---|
| **1** | **Turn the realtime graph executor ON for the pilot tenant.** `PUT /api/v1/admin/settings/registry/consultation.realtime.graphExecutor.enabled` with `{ value: true, scope: { tenantId } }`. Descriptor is `tier: 'global-kv'`, `maxScope: 'tenant'`, not `globalOnly`, not secret — every enforcement check in `settings-registry-write.controller.ts:112-118` passes. Reachable from the existing `(shared)/settings-registry` screen. **Behaviourally safe on its own**: a tenant with no graph still gets `PLATFORM_REALTIME_LANE`, which the descriptor says "encodes the legacy sequence as a graph" | **[exists]** — runtime admin action, ZERO code | `apps/api/src/modules/settings-catalog/settings-registry-write.controller.ts:106` (already there); optional seed row in `packages/database/src/prisma/db_main/seed/11-global-setting.ts` | **0.25** |
| **2** | **Land the `WorkflowAssignment` rows.** The gate that blocked them now passes (§E-2, verified). Either re-run `seedArcaaiWorkflowAuthoring` (`packages/database/src/prisma/db_main/seed/23-arcaai-workflow-authoring.ts:729,737`) or create the assignment through the existing `/workflow-studio/assignments` screen. Then confirm the audit row in `WorkflowAssignmentChange`. Also decide whether to lift the `safe`/day-1 exclusion | **[wire-up]** | `packages/database/src/prisma/db_main/seed/23-arcaai-workflow-authoring.ts` (flag/`safe`-mode only); `apps/admin-console/src/features/workflow-studio/components/assignments/*` (already there) | **0.5** |
| **3** | **Make `enabled` authorable — the whole admin-toggle feature, in one property.** Add `enabled: { type: 'boolean', default: true, description: … }` to `NODE_RUNTIME_PROPERTIES` (`packages/workflow-contract/src/node-config-schemas.ts:1233-1240`). `withRuntimeProperties` (`:1325-1331`) folds it onto every node type except `consultation.hitlGate`. Consequences, all free: the realtime executor already honours it (`realtime-lane.ts:213`); the Studio inspector already renders a boolean as a `<Switch>` (`inspector/field-renderers.tsx:130-141`) built from `Object.entries(schema.properties)` (`inspector-panel.tsx:163`); `GET /admin/workflow-nodes` already serves `configSchema`. **Exclude `mandatory`-classed nodes** (`consultation.consentGate`, `captureBinding`, `phiHop`, `persistDraft`, `finalizeAssurance`, `hitlGate`) by extending `RUNTIME_PROPERTY_EXCLUSIONS` or adding a validator rule — a consent gate an admin can switch off is a compliance defect, not a feature | **[build]** | `packages/workflow-contract/src/node-config-schemas.ts` (+ `__tests__/node-contract.test.ts`) | **0.75** |
| **4** | **Honour `enabled` in the durable interpreter.** Add a skip branch to `_dispatch_node` beside the existing `realtime_lane` / `sandbox` skips: `if node.config.get("enabled") is False: return NodeResult(..., status="SKIPPED", reason="disabled_by_config")`. `CompiledNode.config` is already a free `dict[str, Any]` (`compiled_config.py:123`), so no model change. Without this, a toggle works for `extractEntities`/`realtimeSummary`/`grammar`/`findings` and silently does nothing for `suggestions`/`proposeCorrections`/`retrieveEvidence`/`sensors` | **[build]** | `apps/harness/src/harness/temporal/interpreter/workflow.py:255-300` + a test beside the existing lane-skip tests | **0.5** |
| **5** | **Seed `agent.important_findings` into the two ArcaAI graphs.** It is `implemented: true` (`node-registry.ts:1055`), has a realtime handler (`realtime-node-registry.ts:437`) and a live payload field (`live-summary.dto.ts:277-285`) — and is in no tenant's graph, which is why TASK-806 §8 still records "no 'important information highlighted' layer exists anywhere". Bind its instruction to a SYSTEM-tenant `PromptTemplate` exactly as TASK-821 did for `agent.grammar` (`71000000-…-043`). Budget the `allPathsPassThrough` (WF-CONS-012) + realtime-producer placement constraints TASK-821 documented | **[build]** | `packages/database/src/prisma/db_main/seed/23-arcaai-workflow-authoring.ts`; `packages/database/src/prisma/db_main/seed/` prompt-template phase | **1.0** |
| **6** | **A "Realtime capabilities" read-out.** One tab on the consultation/workflow surface listing, for the working tenant: lane source (`platform-default` \| `tenant-graph`), the definition slug + version, and each realtime node with its `enabled` state, deep-linking to the Studio node. Data already exists — `RealtimeLane.source/definitionSlug/definitionVersionNumber` (`realtime-lane.ts:74-82`) is logged at freeze time (`live-documentation.service.ts:1077-1083`) but is served by no read API; add one thin `GET` off the existing live-doc admin surface (`live-documentation/dto/live-doc-admin.dto.ts`, `getActiveSessions`/`getSessionStats` at `:3446,:3468` are the precedent) | **[build]** | `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts`; `apps/api/src/modules/consultation/admin-consultation.controller.ts`; new tab under `apps/admin-console/src/features/workflow-studio/` | **1.5** |
| **7** | **Stop the console lying about capabilities.** Two honest fixes, pick one: (a) label the `feature-flags` `GlobalSetting` rows (`enable-real-time-transcription`, `enable-ner-extraction`, …) as ADVISORY in the settings grid, since nothing gates on them (§D.5); and (b) relabel the Pipeline Policy matrix columns to say they govern the POST-consultation pipeline, not the live session (`apps/admin-console/src/features/pipeline-policy/components/cascade.ts:26-29`) — because today "Auto-NER: off" does not stop live entities (§D.3) | **[build]** | `apps/admin-console/src/features/pipeline-policy/components/cascade.ts`; `apps/admin-console/src/features/settings/components/settings-screen.tsx` | **0.5** |
| **8** | **One live end-to-end session** — the follow-up TASK-821 §9 explicitly named and never ran: record against the ArcaAI tenant with the flag on and the assignment live; watch the running note become non-empty in graph mode, entities and findings appear on `live-summary`, the `correction-proposals-panel` populate off `live-assist`, and `section.patch` land. Then flip one node's `enabled` off, re-record, and confirm the capability disappears | **[wire-up]** verification | — (runbook; evidence into the ticket README) | **1.0** |

**Core (items 1–4): 2.0 engineer-days.** This alone delivers realtime transcription + partial
summarization + live NER, running from a tenant-authored graph, with a per-capability admin
switch in the Workflow Studio.

**Total (items 1–8): 6.0 engineer-days.**

### F.2 Why this ordering

- 1 and 2 are switches, so they go first and fail cheaply. 1 is reversible in one API call.
- 3 is the leverage point: it converts a runtime capability the platform already has into an
  admin feature, and it costs one schema property because the Studio inspector is
  schema-driven. Doing it before 5/6 means the seeded findings node ships with a switch.
- 4 must land WITH 3, in the same release. A toggle that is honoured by one runtime and
  ignored by the other is worse than no toggle.
- 5–8 are the completion set; the demo works without them.

### F.3 Constraints honoured

| Constraint | How |
|---|---|
| Never lift `EXPOSURE_ALLOWED_PALETTES` | Not touched. Entry point is §G's session-bound `recording/start` |
| Prefer wiring existing services | Items 1, 2, 8 are zero-code; 3, 4, 7 are single-file edits; nothing new is stood up. `apps/text`, `apps/nlp`, `apps/stt` are reached through the existing `RealtimeCapabilities` closures |
| Redis Streams for deltas, SSE + single-use tickets to the browser, no JWT in a URL | Already the shipped design: STT over Redis Streams; `consultation:*:{id}` Redis pub/sub relayed by `sseFromRedisChannel`; per-plane `@StreamScope` tickets from `POST /auth/stream-ticket` |
| Temporal determinism; I/O in activities; `max_time` is a workflow timer | Item 4 is a pure in-workflow config read on an already-deserialised `CompiledNode` — no I/O, no clock, deterministic. Nothing else touches Temporal |
| Config DB-tier, tenant → SYSTEM, no hardcoding, no new env var | Item 1 is `global-kv` `maxScope: 'tenant'`. Item 3 puts the capability switch in the tenant's own published graph, resolved by the `WorkflowAssignment` cascade with `PLATFORM_REALTIME_LANE` as the platform fallback — literally tenant → platform-default. **No new env var, no new settings key, no new table, no migration** |


## G. SAFE INVOCATION ANSWER

**The fast-win needs NO new entry point and MUST NOT touch `EXPOSURE_ALLOWED_PALETTES`.**
The session-bound entry point the brief asks for already exists and already has the property
that makes it safe.

### G.1 How a realtime consultation starts and streams, today

```
POST /api/v1/consultations                       → open (or get) the consultation
POST /api/v1/consultations/:id/recording/start   → status RECORDING; LiveDocumentationService.start()
                                                   returns sseUrl
POST /api/v1/auth/stream-ticket                  → single-use ticket, scope consultation_live_summary:<id>
GET  /api/v1/consultations/:id/live-summary/stream?ticket=…   ← SSE: running note + entities + vitals + findings
GET  /api/v1/consultations/:id/live-assist/stream?ticket=…    ← SSE: suggestions + PROPOSED corrections
WS   /ws/stt/stream                              ← browser mic frames (SDK `audio.start({ pipelineId })`)
POST /api/v1/consultations/:id/recording/stop    → tears the session down, signals the durable endpoint stage
```

Controller: `apps/api/src/modules/consultation/consultation.controller.ts:686` (start), `:743`
(live-summary SSE), `:770` (live-assist SSE), `:709` (stop).
Ticket mint: `POST /auth/stream-ticket`, consumed by
`apps/admin-console/src/app/api/auth/stream-ticket/route.ts:33`.

### G.2 Why this is safe where the exposure plane is not — the four differences, precisely

C-8 is a chain of four links (`exposure-palette-policy.ts:6-19`). The recording path breaks
**every** one of them:

| C-8 link on `POST /workflows/:slug/invoke` | The recording path |
|---|---|
| `consultationId` / `externalPatientId` arrive in **caller-controlled `dto.input`**, forwarded verbatim into `InterpreterInput.payload` | `consultationId` is a **PATH parameter**, resolved server-side by `verifyConsultationOwnership(id)` (`consultation.controller.ts:689`) and the `@TenantOwnedResource` 404-over-403 posture. The live session's identity is frozen at `start()` into `session.consultationId` / `session.tenantId` (`live-documentation.service.ts:745`), and every realtime node receives it from `RealtimeRunInput` (`realtime-executor.ts:85-87`) — **there is no request field through which a caller can name a different consultation** |
| `sandbox: false`, so `if inp.sandbox and spec.external_write:` never fires | The realtime executor is **not the Temporal interpreter and dispatches no Temporal activity at all**. It calls in-process `RealtimeCapabilities` closures (`realtime-node-registry.ts:189-…`) built inside `flush()` from the frozen session (`live-documentation.service.ts:~1900-1965`). `sandbox` is not a concept on this path because there is no payload to be trusted |
| `consultation.persistDraft` reaches the same `persist_draft` activity `HarnessDocWorkflow` uses | **`persistDraft` is `lane: 'durable'` (`node-registry.ts:680,686`) and is therefore NOT in `REALTIME_NODE_HANDLERS`** (`realtime-node-registry.ts:426-438` — 7 entries, none of them a persist node). `buildRealtimeLane` filters every non-`REALTIME_NODE_TYPES` node out (`realtime-lane.ts:191-196`). The realtime lane structurally cannot reach it |
| The route is API-key-reachable by design and `paletteKey` is free-text in the Studio | `recording/start` is a tenant-scoped clinical route behind the standard `UnifiedAuthGuard` + ability decorators + **`@RequiresConsent(ConsentPurpose.AI_DOCUMENTATION)`** (`consultation.controller.ts:687`). And the graph it runs is not named by the caller at all — it is resolved from the tenant's `WorkflowAssignment` cascade server-side (`ConsultationWorkflowDispatchService` / `resolveTenantLane`) |

Two further containments worth naming:

- **Two engines can never both write one document.** Substrate exclusivity is a persisted marker
  (`governing-engine.ts:58-62`) that `LoopContextSignalService.standDownForTenantWorkflow`
  consults (`loop-context-signal.service.ts:47-70,112`); and lane ownership is enforced in the
  durable interpreter itself, which SKIPS every `realtime` node with `reason="realtime_lane"`
  (`apps/harness/.../interpreter/workflow.py:274-280`).
- **Every read plane is separately ticketed.** `live-summary`, `live-assist`,
  `harness-progress`, `harness-assurance`, `trajectory` and `loop` each carry their OWN
  `@StreamScope` namespace, so a summary ticket cannot be replayed to read PHI-carrying
  correction proposals (`consultation.controller.ts:745-746, 772-773, 793-794, 812-813, 833-834,
  859-860`). No JWT ever appears in a URL.

### G.3 If a machine-to-machine entry point is later wanted

Do **not** widen `EXPOSURE_ALLOWED_PALETTES`. Add a *session-bound* route instead —
`POST /api/v1/consultations/:id/recording/start` already IS that shape, and a service-account
caller reaches it through the same path with `workingTenantId` bound at token exchange. The
invariant to preserve is the one in the table above: **the consultation identity must come from
the URL and be re-resolved against the caller's tenant, never from a payload the caller
composed.**


## H. DEFERRED

What a full workflow-studio-authored realtime consultation would need that this fast-win does
NOT do:

1. **A one-click capability toggle without republishing.** PUBLISHED `WorkflowDefinition`s are
   hard-immutable (`workflow-definition.prisma:29,40,45`; `workflow-definition.service.ts:469,491`),
   so item F.3 means clone-to-draft → flip → publish v(n+1) → the assignment picks up the new
   ACTIVE version. That is auditable and correct, but it is not a switch a clinic manager flips
   mid-morning. A runtime per-tenant node-override overlay (a `WorkflowAssignmentOverride`-style
   row, or a `PipelinePolicy`-shaped realtime column set) is the deferred design — and it is a
   SECOND enforcement path for one policy, which this repo repeatedly warns is "how the two
   drift apart". It needs an owner decision, not a default.

2. **Realtime guardrail actually in the loop.** TASK-829 Phase 1 built a decision plane nothing
   calls: `TranscriptSegment.validationRef` does not exist in Prisma, `apps/stt` has no
   segment-finalization hook (zero refs to `read_segment_verdict`), the 9 tuning keys have no
   seed row, there is no durable audit record (EU AI Act Art. 12), `apps/harness` still calls
   `GuardrailClient.analyze()` directly, T2 (LLM judge) is unbuilt, and the T0+T1 p95 ≤ 120 ms
   budget is unverified. That is its own ticket-sized body of work.

3. **A streaming producer for WORKFLOW RUNS.** `/workflows/:slug/runs/:runId/stream` is still a
   2-second poll bridge (`workflow-stream.service.ts:16-43`) and run detail polls at 5 s. The
   consultation planes have real Redis-backed SSE; the generic run plane does not. Unifying them
   is out of scope here.

4. **Streaming the durable node's realtime summaries.** `consultation_realtime.py`'s docstring
   is explicit that its announcements carry "ids, keys and labels only", with the summary text
   travelling as node OUTPUT, and that "rendering it live needs a read-back surface the console
   owns — recorded as a requested contract in the TASK-791 README rather than invented here".
   The fast-win sidesteps this entirely by running summaries in the REALTIME lane (where the
   text does reach `live-summary`), so the durable read-back surface stays deferred.

5. **N > 1 documents.** TASK-814 §10 could not prove it: "every `section.patch` in the capture
   carried the same `documentKey` … the platform lane binds one document". Needs a tenant graph
   with two generation nodes bound to two published `DocumentTemplate`s.

6. **Per-section clinician editing on the LIVE view.** TASK-814 left it read-only deliberately;
   TASK-811 §8c records two open defects on the persisted edit path — a Vault-encryption failure
   in `DocumentSectionStore.encrypt()` silently loses clinician-edited content, and a persisted
   edit publishes no `section.patch`, so a second live viewer sees stale content. Both should be
   fixed before live editing is opened.

7. **Knowledge retrieval as an authorable capability.** TASK-834 is `Pending` with no plan.
   `agent.retrieval` / `consultation.retrieveEvidence` are implemented but their entire
   tenant-facing config is `retrievalEnabled` + `onError`, sealed by `additionalProperties: false`
   (`node-config-schemas.ts:670`). Citations/attribution, embedding-backend selection and
   knowledge-source binding are all missing.

8. **The `stt` palette as a live product.** Every `stt` interpreter node is a registry-parity
   placeholder returning DEGRADED (`interpreter/nodes/stt_placeholder.py`); the real artifact is
   the `AsrPipeline` compiled at publish. Unifying the two is a separate programme — and until
   it happens the `stt` palette must stay out of `EXPOSURE_ALLOWED_PALETTES` for the reason the
   policy already gives: "invoking the graph over REST would promise transcription and silently
   deliver nothing."

9. **Config-plane hygiene items surfaced on the way.**
   `_CORRECTION_SYSTEM_PROMPT` is a hardcoded literal at
   `apps/harness/src/harness/temporal/interpreter/nodes/consultation_realtime.py:561` (TASK-821
   §13 — "it should be a ticket"); the SDK's `KnowledgePipeline` stage config is hardcoded in
   the browser (`packages/agentic-sdk-v2/src/types/pipeline.ts:265-282`) rather than resolved
   from tenant config; `sttPipelineId` is still not threaded into `POST :id/recording/start`, so
   the capture node reports `pipelineId: null`; and `packages/database` has no `lint` script, so
   seed files sit outside the repo's lint gate.
