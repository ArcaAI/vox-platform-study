# TASK-893 / TASK-930 / TASK-931 — Lane Ownership & Interface Contract

**This file is the coordination contract for five parallel worktree lanes.** Every lane codes
against the signatures below. A lane MUST NOT change a signature declared here — if one is wrong,
stop and report it under `### Cross-lane requests` in your final report; the orchestrator applies
it at integration. Four other agents are writing against the same text.

Lanes: **R** (TASK-893 legacy-vocabulary retirement), **N** (TASK-930 NER agent task + invocation
plane), **P** (TASK-930 promotion process), **S** (TASK-930 seeds), **K** (TASK-931 SDK 3.1.0).

---

## 1. File ownership — exclusive, no overlaps

| Lane | Owns (exclusive write access) |
|---|---|
| **R** | `packages/workflow-contract/src/**` EXCEPT `agent-schemas.ts` (N) and EXCEPT any change to the SHAPE of the eleven `core.*` config schemas / ports (frozen, §7) · `packages/workflow-contract/scripts/**` · `packages/py-workflow-contract/**` · `apps/harness/src/harness/temporal/interpreter/**` EXCEPT the body of `interpreter_core_agent` and its `_run_*` helpers in `nodes/core.py` (N) · `apps/harness/src/harness/tests/**` (interpreter / registry / parity) · `packages/applications/src/services/consultation/live-documentation/realtime/**` · `packages/applications/src/services/consultation/workflow-dispatch/**` · `packages/applications/src/services/workflow-exposure/**` · the text-compat / summarization dispatcher that consumes `platform-default-summarization` (find it; report the path) · `apps/admin-console/src/features/workflow-studio/**` · `docs/operations/deprecation-register.md` |
| **N** | `packages/database/src/prisma/db_main/enums.prisma` (§2 hunk only) + `packages/database/src/prisma/db_main/migrations/<ts>_task_930_agent_task_ner/` · `packages/domains/src/enums/**` · `packages/workflow-contract/src/agent-schemas.ts` · `packages/applications/src/services/agent/**` · `packages/applications/src/services/apiKey/**` · `packages/applications/src/authorization/**` · `packages/types/**` · `apps/api/src/modules/agent/**` · `apps/api/src/modules/workflows/**` · `apps/api/src/modules/streaming/workflow-ws.gateway.ts` · `apps/harness/src/harness/temporal/interpreter/nodes/core.py` — ONLY `interpreter_core_agent` + its `_run_*` helpers + a new `_run_ner` (+ `api_client.py` if a call is missing) · `apps/nlp/**` (only if `/classify/tokens` needs a change) · `apps/admin-console/src/features/agents/**` |
| **P** | `packages/applications/src/services/agentPromotion/**` · `packages/applications/src/services/workflow-definition/**` · `packages/applications/src/services/tenant/reference-set/**` · `apps/api/src/modules/agent-promotion/**` · `apps/api/src/modules/workflow-definition/**` · `apps/api/src/modules/tenant/tenant-reference-set.controller.ts` · their `__tests__` |
| **S** | `packages/database/src/prisma/db_main/seed/**` (everything) · `packages/database/scripts/**` · `packages/database/package.json` (script names only) · `enums.prisma` — the IDENTICAL §2 hunk N adds (identical hunks merge clean; nothing else) |
| **K** | `packages/agentic-sdk-v2/**` · `packages/vox-node/**` EXCEPT `src/resources/admin/**` (generated — orchestrator) · `packages/vox-codegen/**` · `packages/vox-node-codegen/**` · `.changeset/**` · `.gitlab/ci/publish.yml` · `docs/architecture/vox-node-gateway-gaps.md` · `.claude/rules/08-vox-sdk.md` · `apps/example/**` · `apps/compat-playground/**` · `apps/quick-compat-app/**` |
| **Orchestrator** | merges · `pnpm install` · `db:push` / `db:migrate` / `db:seed` / `test:db:reset` · the five artifacts (`pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal && pnpm --filter @arcaai/vox-node gen:admin`) · `apps/admin-console/src/shared/navigation/**` · the console "Promote to SYSTEM" button on agents · `.claude/rules/*` · the three ticket READMEs · the SDK publish + tag · ALaaS |

**Anything not listed is owned by nobody** — do not edit it; file a cross-lane request.
Files every lane must leave alone: `apps/api/route-manifest.json`, `apps/api/openapi.json`,
`docs/api-portal/**`, `pnpm-lock.yaml`, `uv.lock`, `.env*`.

---

## 2. Contract N1 — the NER agent task (N implements; S seeds; K types; R rekeys the realtime handler)

### 2.1 Enum (N owns the migration; S adds the IDENTICAL line in its worktree and runs `db:generate`, no migration)

```prisma
enum AgentTask {
  SPEECH_TO_TEXT
  TEXT_GENERATION
  TEXT_TO_SPEECH
  NAMED_ENTITY_RECOGNITION

  @@schema("core")
}
```

Migration folder `task_930_agent_task_ner`, single statement
`ALTER TYPE "core"."AgentTask" ADD VALUE 'NAMED_ENTITY_RECOGNITION';` — authored on a shadow DB per
`.claude/rules/02-database-prisma.md`. Mirror the value in `packages/domains/src/enums/**` if a TS
mirror of `AgentTask` exists there.

### 2.2 Task ↔ catalogue

AMENDED A-5: `AGENT_TASK_SERVICE.NAMED_ENTITY_RECOGNITION = null` (type widens to include `null`, as does `AgentCompiledConfig.service`) — the classification family has no connection plane. `NAMED_ENTITY_RECOGNITION` accepts `AiModel.taskType === 'TOKEN_CLASSIFICATION'` (catalogue rows
`medical-ner`, `gliner2-guardrails-pii-multi`, …). `MODEL_TASK_MISMATCH` otherwise, exactly like
the other three tasks. The provider class table (`platform-self-host | engine-served | cloud-byo |
cloud-platform`) applies unchanged.

### 2.3 IO defaults — `AGENT_IO_DEFAULTS.NAMED_ENTITY_RECOGNITION` (`agent-schemas.ts`)

```ts
input:  { type: 'object', properties: { text: { type: 'string' }, language: { type: 'string' } },
          required: ['text'], additionalProperties: false }
output: { type: 'object', properties: { entities: { type: 'array', items: { type: 'object',
          properties: { text: { type: 'string' }, label: { type: 'string' }, start: { type: 'integer' },
                        end: { type: 'integer' }, score: { type: 'number' } },
          required: ['text', 'label', 'start', 'end'], additionalProperties: false } } },
          required: ['entities'], additionalProperties: false }
```

`instruction` allowed keys: `labels?: string[]` (GLiNER-style label set; ignored by fixed-label
checkpoints). `parameters` allowed keys: `threshold?: number (0..1)`, `aggregation?: 'simple' |
'first' | 'max' | 'average'`. Everything else → `ERROR` in `agentConfigProblems`, like TTS.

### 2.4 Invocation

`POST /agents/:slug/invocations` body = the input schema (`{ text, language? }`, sent FLAT).
Gateway `AgentInvocationService` → nlp `POST /api/v1/classify/tokens` with `X-Tenant-Id`, the
model on the wire = `compiledConfig.model.wireModelId`, provider override derived from the
resolved catalogue row exactly as text-generation does. Response = the output schema. `?mode=stream`
on a NER agent → 400 `MODE_UNSUPPORTED` (one-shot task). Quota + usage recorded (OD-E: every
inference activity counts) with the usage kind the `consultation.extractEntities` lane records today.

Harness `core.agent` with `resolved.task === 'NAMED_ENTITY_RECOGNITION'` → `_run_ner` → the same
nlp route through the client function `interpreter_core_classify` already uses. Output ports: `data`
= `{ entities }` (object), `out` = the input text (pass-through). Realtime lane: `core.agent` whose
resolved task is NER → the `extractEntities` handler (R rekeys, §7.4).

### 2.5 Console (N) and SDK (K)

Wizard task option **Named entity recognition**; model picker filtered to `TOKEN_CLASSIFICATION`.
SDK `AgentTask` union gains `'NAMED_ENTITY_RECOGNITION'`; `hope.agents.list({ task })` accepts it.

---

## 3. Contract N2 — service accounts reach the invocation plane

Scope strings — AMENDED A-2: `svc:*` scopes are DERIVED from API-key scope sources in
`service-account-scopes.registry.ts` (`deriveFamilyInto`); N adds a fourth family
`AGENT_WORKFLOW_BUSINESS_PLANE_SCOPE_SOURCES` naming the five existing API-key scopes, registers it in
`service-account-surface-audit.ts` (`declaredNonAdmin`) and the registry test count:

| Scope | Routes |
|---|---|
| `svc:agent:definition:read` | `GET /agents`, `GET /agents/:slug` |
| `svc:agent:invocation:write` | `POST /agents/:slug/invocations`, `/speech`, `/transcriptions` |
| `svc:workflow:definition:read` | `GET /workflows`, `GET /workflows/:slug/schema` |
| `svc:workflow:run:read` | `GET …/runs/:runId`, `GET …/runs/:runId/stream`, `GET …/reviews/:nodeId`, `POST …/runs/:runId/stream-ticket` (§4) |
| `svc:workflow:run:write` | `POST …/runs`, `POST …/invoke`, `POST …/runs/:runId/cancel`, `POST …/reviews/:nodeId/decide` |

Declared with `@RequiredSvcScopes(...)` on each handler of `agent.controller.ts` and
`workflows.controller.ts` (the consultation-bound `/consultations/:id/workflows*` plane stays
API-key/JWT only). A service account never sends `X-Tenant-Id` — `workingTenantId` binds at
exchange. The seeded service account (`seed/94-service-account.ts`, **S applies**) gains all five.
The route manifest / openapi / portal / `gen:admin` are regenerated by the orchestrator after merge.
K removes `assertApiKeyPlane()` from `vox-node/src/resources/{agents,workflows}.ts`.

---

## 4. Contract N3 — socket for API keys and service accounts (run-scoped stream ticket)

New route on `workflows.controller.ts`:

```
POST /workflows/:slug/runs/:runId/stream-ticket      scope workflow:run:read | svc:workflow:run:read
→ 201 { ticket: string, expiresAt: number /* epoch ms */, scope: "workflow_run:<runId>", url: "/ws/workflows?slug=<slug>&runId=<runId>&ticket=<ticket>" }
   (AMENDED A-1, 2026-09-08: `expiresAt` + `scope`, the gateway's existing `IssueStreamTicketResponse` fields, never `expiresIn`)
```

Mints the same single-use ticket kind `workflow_run:<runId>` that `POST /auth/stream-ticket`
mints for a JWT; `auth.controller.ts` is NOT changed. `workflow-ws.gateway.ts` accepts it
unchanged. K: `workflows.streamRun(slug, runId, { transport: 'socket' })` and
`useWorkflowRun({ transport: 'socket' })` mint the ticket then open the WS (Node ≥ 22 global
`WebSocket`; if the global is absent, throw `SocketUnavailableError` naming the Node floor — never
add a dependency).

---

## 5. Contract N4 — `Agent.outputSchema` is enforced, not decorative (TEXT_GENERATION)

(AMENDED A-4: the package-`index.ts` export line is added by lane R, owner of `index.ts`; N exports it from `agent-schemas.ts` only.)

Exported from `agent-schemas.ts` (N), imported by the gateway invocation service (N), the harness
`_run_text_generation` (N) and the realtime `core.agent` handler (R):

```ts
/** `undefined` when the declared output is the task default or not an object schema with ≥1 property,
 *  or when `parameters.responseFormat` is set (the explicit hyper-parameter always wins). */
export function outputSchemaResponseFormat(
  slug: string, outputSchema: unknown, parameters: Record<string, unknown> | null | undefined,
): { type: 'json_schema'; json_schema: { name: string; schema: Record<string, unknown>; strict: true } } | undefined;
```

`name` = `${slug.replace(/[^a-z0-9_]/gi, '_')}_output`. Python mirror in
`nodes/core.py` (N) with the same rule; a pinned unit test on each side.

---

## 6. Contract P — the HOPE promotion process (Global → SYSTEM → tenants)

### 6.1 `POST /admin/agents/promote-to-system` (P; controller `apps/api/src/modules/agent-promotion/`)

Body `{ sourceSlug: string; versionNumber?: number; changeReason: string }` — mirror of
`PromoteWorkflowToSystemRequest`. SUPER_ADMIN + elevated tenant-less context, source tenant
hard-coded to `GLOBAL_PLAYGROUND_TENANT_ID` (`50000000-…`), target `SYSTEM_TENANT_ID`. Copies the
Agent row + `AgentModelFallback` chain into SYSTEM as `max(versionNumber)+1` under the same slug,
recompiles against the SYSTEM catalogue, publishes, activates, and writes the WORM `AgentPromotion`
record. Referenced content: `instruction.promptTemplateId` owned by Global → deep-copied into SYSTEM
(same versions, `APPROVED` where the source was, `sourceTemplateId` set) and remapped;
`contextSchemaId` → the SYSTEM schema with the same slug, copied if absent. Response
`{ agentId, slug, versionNumber, copied: { promptTemplates: number, contextSchemas: number } }`.

### 6.2 Workflow promotion checks its agents first

`POST /admin/workflow-definitions/promote-to-system` refuses with **409 `AGENTS_NOT_IN_SYSTEM`**
`{ missing: string[] }` when any `core.agent.agentRef.slug` in the graph has no PUBLISHED SYSTEM
agent — hint text names §6.1. Existing behaviour otherwise unchanged.

### 6.3 Reference set

`ReferenceSetKind` gains `workflowAssignments` (after `workflowDefinitions`): TENANT-scope rows
only (DEPARTMENT rows are tenant topology and are skipped). `TenantReferenceSetService` and the seed
copier (`26-tenant-reference-set.ts`, **S**) both clone `workflowDefinitions` + `workflowAssignments`.

### 6.4 Console

"Promote to SYSTEM" on the agent detail (Global tenant, super admin) — orchestrator, after merge.

---

## 7. Contract R — legacy vocabulary retirement (TASK-893 Phases 2 + 4)

### 7.1 Frozen for this wave

The eleven `core.*` descriptors' config-schema SHAPES and ports (`core.trigger`, `core.agent`,
`core.classify`, `core.humanReview`, `core.variable`, `core.condition`, `core.loop`, `core.note`,
`core.output`, `core.data`, `core.action`) do not change shape. S authors graphs against them as they
are on `dev-2.2 @ 4e0c9362e`.

### 7.2 The action catalogue becomes a first-class table

`packages/workflow-contract/src/action-catalogue.ts`:

```ts
export interface CoreActionDescriptor {
  key: string; label: string; summary: string; activityName: string;
  configSchema: NodeConfigSchema; ports: NodePortSet; classes: readonly string[];
  critical: boolean; externalWrite: boolean; defaultTimeoutSeconds: number; defaultMaxAttempts: number;
  lane: 'durable' | 'realtime'; entitlementKey?: string; outputKeys: readonly string[];
}
export const ACTION_CATALOGUE: Readonly<Record<string, CoreActionDescriptor>>;
export function actionDelegateOf(config): CoreActionDescriptor | undefined;   // same name, new return type
```

**Kept action keys (17)** — copied verbatim from today's descriptors, keys unchanged:
`consultation.consentGate`, `consultation.bindTerminology`, `consultation.phiHop`,
`consultation.retrieveEvidence`, `consultation.sensors`, `consultation.inferentialSensors`,
`consultation.persistDraft`, `consultation.finalizeAssurance`, `guard.phi`, `guard.moderation`,
`guard.groundedness`, `session.timeout`, `feedback.capture`, `livedoc.stop`, `harness.finalize`,
`summary.finalize`, `prompt.template_ref`.
**Dropped (17)** — agent-shaped, now `core.agent`: `consultation.captureBinding`,
`consultation.extractEntities`, `consultation.assemblePrompt`, `consultation.realtimeSummary`,
`consultation.suggestions`, `consultation.proposeCorrections`, `agent.transcription`,
`agent.normalization`, `agent.ner`, `agent.grammar`, `agent.important_findings`, `agent.retrieval`,
`agent.feedback`, `agent.dna_redaction`, `agent.dna_style`, `guardrail.check`, `agentic.guardrail`.
If R finds a kept key is a pure duplicate of another kept key, drop it and say so in the report.

Python mirror `apps/harness/src/harness/temporal/interpreter/action_catalogue.py`; new fixture
`packages/workflow-contract/src/__tests__/fixtures/action-catalogue.snapshot.json` consumed by a
TS parity test and a Python parity test, same shape as the node-registry fixture. Add pnpm scripts
`regen:registry-snapshot` and `regen:action-snapshot` to `packages/workflow-contract/package.json`.

### 7.3 After retirement

`WORKFLOW_NODE_REGISTRY` = the 11 `core.*` types, zero `deprecated: true`; `NODE_PORTS`,
`NODE_CONFIG_SCHEMAS`, `MANDATORY_NODE_TYPES` (= `{core.trigger, core.output}`), `rule-catalogue.ts`
(`WF-CONS-*`, `WF-SUMM-*` deleted; `WF-S-*`, `WF-I-*`, `WF-CORE-*` kept), `registry.py` = 11
`NodeSpec`s, the activities of the 44 deleted types removed, `node-registry.snapshot.json`
regenerated, both parity tests green. `classesOf(node)` resolves an INSTANCE: `core.action` →
delegate's classes ∪ `{'action'}`; `core.agent` → `{'agent','activity','generation'}` — so `WF-I-002`
/ `WF-I-004` keep firing on migrated nodes. `EXPOSURE_ALLOWED_PALETTES` = `CONSULTATION_BOUND_ALLOWED_PALETTES`
= `CONSULTATION_GOVERNING_PALETTES` = `{'core'}`; `consultationSelectionViolation` and both
`assignments.resolve(tenantId, 'consultation', …)` call sites resolve `CORE_PALETTE_KEY`. Studio
action dropdown reads `ACTION_CATALOGUE`; palette hides nothing (nothing is deprecated).
`docs/operations/deprecation-register.md` rows for the vocabulary and `21/23/24` seeds → `removed`
(TASK-893). Deprecation register rows for `pipeline.templateResync` etc. are NOT this ticket.

### 7.4 Realtime handlers rekeyed (`realtime-node-registry.ts`)

`core.agent` dispatches on the RESOLVED agent task: `SPEECH_TO_TEXT` → the former
`captureBinding` handler, `NAMED_ENTITY_RECOGNITION` → the former `extractEntities` handler,
`TEXT_GENERATION` → today's handler (now applying §5 `outputSchemaResponseFormat`). `core.action`
→ `ACTION_CATALOGUE[key].lane === 'realtime'` handlers only. Nothing is keyed by a legacy type
string any more.

### 7.5 `platform-default-summarization`

R finds the consumer of this slug (text-compat / summarization plane), reports whether it EXECUTES
the graph or only reads its compiled settings, and makes it accept the `core`-palette graph S
authors under the same slug (§8.3). If the consumer only needs prompt/guardrail settings, R says so
and S's graph is still seeded (it is the reference workflow for the summarization API).

---

## 8. Contract S — the seed set (S authors; everyone else reads)

### 8.1 Deleted

`21-workflow-definition.ts`, `23-arcaai-workflow-authoring{,.generated}.ts`,
`24-example-consultation-workflows{,.generated}.ts`, the three `packages/database/scripts/regen-*`
scripts, their seed tests, the Global `example-*` agents and the `example-azure-transcription` /
`example-sarvam-transcription` drafts, `07g-consultation-legacy-context-schema.ts` (its fields
move into §8.2), the four orphaned `CUSTOMER_PROMPT_TEMPLATES` in `07-prompt-template.ts`, and
every `seed-mode.ts` deny-list entry that names a deleted file (new file names take their place).

### 8.2 The trigger context schema

ONE tenant-cloned `ConsultationContextSchema` slug **`consultation_note_context`** (SYSTEM +
Global authored, cloned to ArcaAI by phase 26) declaring the fields the clinical prompts bind:
`visit_type` (enum `new-visit | revisit`), `current_department`, `language`, `safe_age`,
`safe_dob`, `safe_gender`, `formatted_previous_visits`, `formatted_vitals`, `chief_complaint`
(string, optional), plus the day-1 item kinds from `07e` (`audio_stream`, `work_note`, `case_note`,
`attachment`). Keep `07e`'s `consultation_default` only if a runtime reader still resolves
`DAY1_CONTEXT_SCHEMA_SLUG`; otherwise fold it in and delete `07e` too — say which in the report.

### 8.3 Agents — Global and SYSTEM carry the IDENTICAL set (Global authors, SYSTEM is the promoted copy; SYSTEM rows carry `sourceTenantId = Global`)

| slug | task | modelSlug (fallbacks) | notes |
|---|---|---|---|
| `realtime-transcription` | `SPEECH_TO_TEXT` | `arcaai-whisper-large-ml-en-gguf-q8_0` (`arcaai-whisper-large-ml-en-gguf`, `faster-whisper-large-v3-turbo-int8`) | today's `platform-transcription` parameters (VAD, streaming, TASK-891 A4) |
| `medical-ner` | `NAMED_ENTITY_RECOGNITION` | `medical-ner` | §2 |
| `general-medicine-summarization` | `TEXT_GENERATION` | `lms-gemma-4-e2b-it-qat` | `guards.enabled: true`; `instruction.promptTemplateId` → SYSTEM/Global template `general-medicine-consultation-summary` (derived from the ArcaAI GEN v3 content, partial/incremental summary register); `instruction.variables` POPULATED for every declared template variable (bindings to `trigger.context.*`, F6); the General Medicine `DocumentTemplate` (`consultation_note_new_visit` / `_revisit` by `visit_type`) bound through the binding kind that exists — if no document-template binding kind exists, bind the heading list as a constant and say so |
| `casenote-finalization` | `TEXT_GENERATION` | `lms-gemma-4-e2b-it-qat` | `guards.enabled: true`; `systemPrompt`: finalize the case note from the partial summaries + work notes, redact residual PII, keep the document template headings; `outputSchema` = `{ case_note: string, redactions: [{ text, label }] }` |
| `text-to-speech` | `TEXT_TO_SPEECH` | today's `platform-tts` model | kept because the speech route and the TTS assignment need one default; nothing else from the old set survives |

`AgentAssignment` (TENANT scope, Global + SYSTEM): STT → `realtime-transcription`,
TEXT_GENERATION → `general-medicine-summarization`, TTS → `text-to-speech`, NER → `medical-ner`.

### 8.4 Workflows — `core` palette, `kinds: ['consultation','api']`

**`general-medicine-consultation`** (Global + SYSTEM, PUBLISHED, active; TENANT-scope
`WorkflowAssignment` palette `core`):

```
① core.trigger   kinds [consultation, api]; contextSchema.contextSchemaId → consultation_note_context; guardrail {enabled:true}
② core.agent     realtime-transcription     execution {realtime, perTurn}   onError fail
③ core.agent     medical-ner                execution {realtime, perTurn}   in ← ②.transcript
④ core.agent     general-medicine-summarization  execution {realtime, perTurn}  guardrail {enabled:true}
                 context ← ①.context · in ← ③.out · promptVariables from trigger.context.*
⑤ core.agent     casenote-finalization      execution {durable, onEnd}      guardrail {enabled:true}   in ← ④.out
⑥ core.humanReview  clinical_finalization, assignRole DOCTOR, timeoutSeconds 3600, allowEdit  in ← ⑤.out
⑦ core.output    protocols [http, http-sse, socket]; outputSchema {case_note, entities}; onSchemaViolation fail
```

**`platform-default-summarization`** (SYSTEM + Global, same slug as today, `core` palette):
`core.trigger [api]` → `core.agent general-medicine-summarization {durable, once}` → `core.output [http, http-sse]`.

### 8.5 ArcaAI — generated from a table, not hand-written

For each of the 11 ArcaAI departments × {`new-visit`, `revisit`}: agent
`arcaai-<dept-code-lower>-summary-<visit>` (`TEXT_GENERATION`, gemma, guards on,
`promptTemplateId` → that department's v3 template, `instruction.variables` populated). For each
department: workflow `arcaai-<dept>-consultation` = the §8.4 graph with ④ replaced by
`core.condition` on `{{trigger.context.visit_type}}` → the two department agents (branches
`new-visit` / `revisit`, `else` → new-visit). DEPARTMENT-scope assignments for all 11; TENANT-scope
default → `arcaai-gen-consultation`. ArcaAI additionally receives the SYSTEM set via phase 26
(`realtime-transcription`, `medical-ner`, `casenote-finalization`, `text-to-speech`,
`general-medicine-consultation`, `platform-default-summarization`, the schema, the templates).

### 8.6 Files, regeneration, tests

`25-agents.ts` (rewritten), `28-workflow-library{,.generated}.ts`,
`29-arcaai-agents-and-workflows{,.generated}.ts`, `26-tenant-reference-set.ts` (extended per §6.3),
`07-prompt-template.ts` (+ the General Medicine template, − orphans). ONE regen script
`packages/database/scripts/regen-workflow-seeds.ts` wired as `pnpm --filter @arcaai/database
seed:regen:workflows` (compiles every authored graph with the real `@arcaai/workflow-contract`
source, writes both `.generated.ts`). Tests: compile-parity per generated file, idempotency, seed
mode, `RUN_SEED=all NODE_ENV=test` run green against the isolated test DB. **The `.generated.ts`
blobs are regenerated by the orchestrator after R merges** (the registry checksum changes); S
regenerates against its own worktree's contract and states that in its report.

---

## 9. Contract K — SDK 3.1.0

- Changesets: `minor` for `@arcaai/vox`, `@arcaai/vox-node`, `@arcaai/vox-codegen`; the stale
  `.changeset/olive-moons-shake.md` folded in. `vox-codegen` leaves `.changeset/config.json#ignore`
  and joins the `publish-sdk` build list; `vox-node-codegen` stays private.
- `SDK_VERSION` derived from `package.json` at build (tsup `define`), the red test goes green.
- Registry of record = **GitHub Packages** (every `publishConfig.registry` already says so; that is
  where every consumer pulls from). `publish-sdk` writes `.npmrc` for `npm.pkg.github.com` from a
  `GITHUB_PACKAGES_TOKEN` CI variable and fails loudly when it is unset (comment says why).
- New: `AgentTask` union + `list({ task })`; service-account plane (drop `assertApiKeyPlane`, keep
  the "no `X-Tenant-Id` with a service account" rule); `transport: 'socket'` (§4) in vox-node and
  `useWorkflowRun`; `vox-codegen --agents --workflows` emitting `Agent_<slug>_Input/Output` and
  `Workflow_<slug>_Input/Output` from `GET /agents`, `GET /agents/:slug`, `GET /workflows`,
  `GET /workflows/:slug/schema` with an API key (business plane; no admin call); example
  `05-agents-and-workflows.ts`; README/CHANGELOG/gaps-doc/rule-08 refresh (5 entry points incl.
  `/compat`; 49 admin areas; version 3.1.0); first-party demo apps move `sttPipelineId` →
  `sttAgentSlug`.
- Gates: `pnpm sdk:build sdk:test sdk:lint sdk:typecheck`, `sdk-node:*` + `check:exports`,
  `sdk-codegen:*`, `pnpm --filter @arcaai/vox-node-codegen test`.
- The publish and the `SDK-3.1.0` tag are the orchestrator's (outward action).
