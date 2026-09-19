# TASK-863 — Agent: a first-class, task-typed, publishable entity (ASR · text-generation · TTS)

| | |
|---|---|
| **Status** | Review |
| **Type** | feature |
| **Program** | [TASK-859 — AI Platform Consolidation](../TASK-859-Ai-Platform-Consolidation-Program/README.md) |
| **Packages** | `packages/database`, `packages/domains`, `packages/applications` (`agent/*`, `agent-assignment/*`, `agent-invocation/*`), `apps/api` (`agent`, `agent-admin`, `internal/agents`), `apps/harness` (agent activity), `apps/admin-console` (`features/agents` rewrite), `packages/vox-node`, `packages/agentic-sdk-v2` |
| **Depends on** | TASK-860 (registry: task taxonomy + availability), TASK-862 (provider cascade by `(service, provider)`) |
| **Blocks** | TASK-861 (ASR Agent replaces `AsrPipeline`), TASK-864 (`core.agent` node references an Agent), TASK-865 (SDK agent selection) |
| **Rules** | `02`, `03`, `04`, `05`, `06`, `13` |
| **Created** | 2026-09-04 |

## 1. Requirement Analysis

Owner directive (2026-09-04):

> Agent is for handling a single task, such as: ASR, Text generation, Token classification. An agent must be backed by an AI model for specific task. Depends on the task admin can select and set an instruction prompt. […] Agent is only based on LLM/ASR/TTS models. Two interfaces where admin can manage and publish: Agent and Workflow.

Restated as the product contract:

| # | Requirement |
|---|---|
| R-1 | An **Agent** is a tenant-managed, versioned, publishable resource that performs exactly one task: `SPEECH_TO_TEXT`, `TEXT_GENERATION` or `TEXT_TO_SPEECH`. Classification is **not** an agent (it is the Classify workflow node, TASK-864). |
| R-2 | An agent is backed by **one registered model** whose `taskType` matches the agent task, plus optional fallback models of the same task. The model row decides engine, format, weights location and provider; the agent never names an engine, endpoint or credential. |
| R-3 | Depending on the task the admin sets an **instruction** (text-generation: system prompt / prompt template + variables; ASR: initial prompt / hotwords; TTS: none) and **hyper-parameters** with a task-specific schema. |
| R-4 | An agent declares its **input and output schema** (JSON Schema, authorable subset), so a workflow node, an API caller and the generated OpenAPI all agree on what goes in and comes out. |
| R-5 | An agent can be **published** and invoked on its own — HTTP (blocking), HTTP-SSE (streaming), and for ASR also the realtime socket — and is the unit a workflow's Agent node references. |
| R-6 | Provider credentials resolve **tenant → SYSTEM** from the model's provider through `AiProviderConnection` (TASK-862); a tenant that brought its own Azure/OpenAI/Sarvam key uses it automatically, funding derived from the tier that supplied the row. |
| R-7 | Governance: rows are versions; published versions are immutable; instruction templates used for clinical generation must be `APPROVED`; publish fails closed when the model is unavailable (weights not in the bucket, or no enabled connection for a cloud provider). |

## 2. Current State Evaluation

Verified 2026-09-04.

### 2.1 "Agent" today is three different things

| Where | What it is | Evidence |
|---|---|---|
| Admin console `/agents` | a `redirect()` to `/prompt-templates`; the surviving `features/agents/**` components manage `PromptTemplate` rows (content, versions, approval, test-run) with **no model, provider, task or parameter fields** | `apps/admin-console/src/app/(console)/(tenant)/agents/page.tsx`, `features/agents/api/types.ts:28-55` |
| Workflow registry | eleven fixed-purpose node types `agent.{transcription, normalization, ner, grammar, important_findings, presummarization, summarization, discharge_summary, retrieval, feedback, dna_redaction}` — thin delegations to pipeline engines, config borrowed from the engine they delegate to | `packages/workflow-contract/src/node-registry.ts:926-1193`, `node-config-schemas.ts:1610-1627`, `apps/harness/.../nodes/agent_catalogue.py` |
| Workflow registry | one generic `agentic.agent` node: `providerConfigRef` (`routingPolicyId` xor `taskKey`), prompt binding (`promptTemplateId`, `promptVersionNumber`, `evalGate`), document binding, `systemPrompt`, `generation{temperature,maxTokens,topP,frequencyPenalty,presencePenalty,stopSequences,seed}`, `guards{input,output}`, `tools[{mcpServerId,toolName}]`, `responseFormat: text|json|json_schema`, `responseSchema`, `onError` | `node-config-schemas.ts:1329-1358`, `:1150-1290` |
| Realtime transcription | an `stt`-palette workflow that compiles into an `AsrPipeline` row (TASK-861 §2.2) | `seed/23a-realtime-transcription-agent.ts` |
| Schema | `DepartmentAgent`/`DepartmentAgentVersion` were removed; `AgentPromotion` (cross-tenant promotion record of a workflow version) remains and is generic enough to cover agents | `packages/database/src/prisma/db_main/department-agent.prisma:32-93` |

Consequences: an agent cannot be reused across two workflows without copying its config into each node; it cannot be invoked on its own; there is no place to publish "the tenant's summarizer" and no screen to manage it.

### 2.2 What is right and must be kept

- **Reference-only bindings.** `FORBIDDEN_CONFIG_KEYS` (`packages/workflow-contract/src/agentic-contract.ts:60-119`) refuses `apikey`, `endpoint`, `provider`, `model`, `deploymentName`… in graph data because a literal would bypass the tenant → SYSTEM cascade and mis-bill silently. The Agent entity inherits the rule.
- **Hyper-parameter capability gating** (`hyperparameterCapabilityProblems`) — a parameter the bound provider cannot honour is refused at publish, never dropped.
- **Prompt binding to an approved, version-pinned template** with an optional golden-set `evalGate`.
- **Fail-closed selection** — an unresolvable model degrades/blocks; nothing substitutes an env default (rule 00).
- **`AiRoutingPolicy`** as the provider-configuration table with a DB-enforced default election per `(tenant, taskKey)` (`ai-routing-policy.prisma`), and `AiProviderConnection` as the one credential store keyed `(tenant, service, provider)`.

### 2.3 What is missing

| Gap | Impact |
|---|---|
| No `Agent` table, no lifecycle, no assignment cascade | cannot publish or reuse |
| No standalone invocation routes | an integrator must wrap a one-node workflow to call a summarizer |
| ASR has no agent shape at all (pipeline YAML instead) | TASK-861 blocked |
| Harness nodes resolve models through the **retired** `AiTaskDefault` overlay (`get_policy(task_key)`, `interpreter/nodes/_llm_policy.py`, `text_generate.py:99-152`) | must move to the agent's compiled binding / `AiRoutingPolicy` |
| `agent.*` node types hard-wire eleven purposes into the registry | every new purpose is a code change + registry checksum bump that flags every published definition `NEEDS_REVIEW` |

### 2.4 Prior art (from the TASK-859 research)

Dify (LLM node + published "Agent app" sharing one runtime), n8n (AI Agent node: model sub-node + tools + max iterations), Vellum (prompt deployments with release tags referenced from workflows), Bedrock/Azure Foundry agents (instructions + model + tools as the agent's whole config). Convergent config surface for text generation: model, system prompt, temperature/top_p, max_tokens, `response_format`/JSON-schema structured output (strict), tools, memory toggle. ASR: language, diarization, word timestamps, prompt/hotwords, VAD mode, streaming vs batch. TTS: voice, speed, format, sample rate, SSML.

## 3. Target Design

### 3.1 Data model

```prisma
enum AgentTask { SPEECH_TO_TEXT  TEXT_GENERATION  TEXT_TO_SPEECH }   // enums.prisma

model Agent {                                   // agent.prisma — rows ARE versions (WorkflowDefinition precedent)
  metaData Json? @map("_metadata") @db.JsonB
  version  Int   @default(1) @map("_version")
  id       String @id @default(uuid(7))
  tenantId String
  slug          String            // lineage key, WORKFLOW_DEFINITION_SLUG_PATTERN
  name          String
  description   String?
  task          AgentTask
  versionNumber Int
  parentVersionId String?
  status        WorkflowDefinitionStatus @default(DRAFT)   // DRAFT | VALIDATED | PUBLISHED | DEPRECATED — reuse
  isActive      Boolean @default(false)                    // at most one per (tenantId, slug) — partial unique index
  modelId       String            // FK AiModel, onDelete: Restrict; taskType must match `task` (service + publish check)
  instruction   Json?  @db.JsonB  // { promptTemplateId, promptVersionNumber, variables } | { systemPrompt } | { initialPrompt, hotwords[] }
  parameters    Json?  @db.JsonB  // task-specific, validated against AGENT_PARAMETER_SCHEMAS[task] (see 3.2)
  inputSchema   Json?  @db.JsonB  // authorable JSON-Schema subset; defaults per task
  outputSchema  Json?  @db.JsonB
  tools         Json?  @db.JsonB  // [{ mcpServerId, toolName }] — TEXT_GENERATION only
  compiledConfig Json? @db.JsonB  // server-stamped at publish; never from a DTO
  compiledConfigChecksum String?
  validationReport Json? @db.JsonB
  publishedAt DateTime?  deprecatedAt DateTime?
  resourceStatus… createdBy… tags String[]
  model     AiModel @relation(fields:[modelId], references:[id], onDelete: Restrict)
  fallbacks AgentModelFallback[]
  @@unique([tenantId, slug, versionNumber], map: "Agent_tenant_slug_version_unique")
  @@index([tenantId, task]) @@index([tenantId, slug, isActive]) @@index([modelId])
}

model AgentModelFallback {                      // ordered fallback chain, real FKs (the AiRoutingPolicy lesson: no JSON chains)
  id String @id @default(uuid(7))
  tenantId String
  agentId  String   // the Agent VERSION row
  priority Int
  modelId  String
  enabled  Boolean @default(true)
  @@unique([agentId, priority]) @@index([modelId])
}

model AgentAssignment {                          // mirrors WorkflowAssignment: (scope, scopeId, task) → agent slug
  … scope PipelinePolicyScope, scopeId String?, task AgentTask, agentSlug String …
  @@unique([tenantId, scope, scopeId, task])
}
model AgentAssignmentChange { … append-only WORM, mirrors WorkflowAssignmentChange … }
```

Why no `providerConnectionId` on the agent: the model row carries `provider`; the credential is the tenant's (or SYSTEM's) `AiProviderConnection(service ← task, provider)` row, which is unique per `(tenant, service, provider)` and already holds Azure `deploymentName` / `apiVersion`. The binding is derivable; storing it would create a second place for the cascade to diverge. `AiRoutingPolicy` stays for **non-agent tasks** (guardrail, NER/classification defaults, harness judge, embeddings) and as the source of the SYSTEM default agents' model choice at seed time.

Tenant scoping: `Agent`, `AgentModelFallback`, `AgentAssignment*` join `TENANT_SCOPED_MODELS`; `Agent` and `AgentAssignment` also join `SYSTEM_SHARED_READ_MODELS` (a tenant reads SYSTEM's published agents as templates / platform defaults, never another tenant's). `ResourceType.{Agent, AgentAssignment}` added in both enum homes (rule 03 step 4).

### 3.2 Task-specific parameter schemas (`packages/workflow-contract/src/agent-schemas.ts`, shared with the Studio inspector)

| Task | `parameters` | `instruction` | default `inputSchema` → `outputSchema` |
|---|---|---|---|
| `TEXT_GENERATION` | `generation{temperature, topP, maxTokens, frequencyPenalty†, presencePenalty†, stopSequences, seed}`, `responseFormat: text|json|json_schema`, `responseSchema`, `memory: none|conversation`, `guards{input,output}` (guardrail *policy keys*, TASK-864 executes them as nodes) | `{ promptTemplateId, promptVersionNumber, variables }` **or** `{ systemPrompt ≤ 50 000 chars }`; `evalGate{goldenSetId, enabled}` | `{ text | object }` → `{ text }` or `responseSchema` |
| `SPEECH_TO_TEXT` | the ASR spec of TASK-861 §3.2: `audioFrontEnd{vad, denoise, diarization}`, `decoding{languageMode, codeSwitching, wordTimestamps, beamSize, temperature}`, `postProcessing{punctuation, disfluency, stabilizer}`, `streaming{partialIntervalMs, endpointing}`, `fallback{autoSwitch, switchAfterConsecutiveFailures}`; every model reference is a registry slug filtered by `taskType` (`VOICE_ACTIVITY_DETECTION`, `AUDIO_TO_AUDIO`, `SPEAKER_EMBEDDING`, `TOKEN_CLASSIFICATION` for punctuation) | `{ initialPrompt ≤ 224 tokens, hotwords[] }` | `{ audio: stream|artifact, language? }` → `{ transcript: segments[{text,start,end,speaker?,words?,isFinal}], language }` |
| `TEXT_TO_SPEECH` | `voice` (identifier within the model's voice catalogue — `AiModel.metaData.voices`), `language`, `speed 0.25–4`, `format wav|mp3|ogg|pcm`, `sampleRate`, `ssml: boolean` (Azure only, capability-gated) | none | `{ text | ssml }` → `{ audio: artifact, durationMs }` |

† capability-gated against the bound model/provider at publish (existing `hyperparameterCapabilityProblems`).

### 3.3 Lifecycle

`create (DRAFT)` → `validate` (schema + model/task match + availability + template approval + capability gates → `VALIDATED` or findings) → `publish` (stamps `compiledConfig` = fully resolved *references*: model row identity, fallback chain, template version, parameter defaults; `isActive` election; PUBLISHED rows immutable via the same three-layer guard + DB trigger pattern as `WorkflowDefinition`) → `newVersion` (branch from any published version) → `deprecate`. Promotion across tenants reuses `AgentPromotion` (rename columns to `sourceDefinitionId`… deferred; the row shape already fits).

**Availability check at publish** (fails closed): self-hosted model → TASK-860 `AiModel.availability = AVAILABLE` (weights present in the bucket); cloud model → an `enabled` `AiProviderConnection(service, provider)` exists at tenant or SYSTEM tier and the tenant's entitlement permits it (`featurePlatformDefaultCredential`).

### 3.4 Resolution (one service, two callers)

`AgentResolverService.resolve({ tenantId, task, agentSlug?, departmentId? })`:

1. explicit slug → `findPublishedActiveBySlug` widened `[tenant, SYSTEM]`; foreign/unknown/unpublished → 404 (one answer);
2. else `AgentAssignment` cascade `department → tenant → SYSTEM`;
3. materialise `ResolvedAgent`: `compiledConfig` + per-model `AiModelConfig` (slug, format, computeType, `localPath`, sourceUri, checksum — TASK-860) + `providerOverride` for a cloud provider (TASK-862 credential resolver; funding tier derived from the connection row's `tenantId`).

Callers: the gateway (standalone invocation, STT session/batch — TASK-861) and the harness's `core.agent` activity via `GET /internal/agents/resolve` (TASK-864), so **one** resolution lives in `packages/applications`.

### 3.5 Invocation surface (business plane; API key or JWT; `svcScopes: []`)

| Route | Task | Behaviour |
|---|---|---|
| `GET /api/v1/agents` | all | published, active agents visible to the tenant (same predicate as resolution) |
| `GET /api/v1/agents/{slug}` | all | summary + `inputSchema`/`outputSchema` + protocols |
| `POST /api/v1/agents/{slug}/invocations?mode=blocking|stream` | `TEXT_GENERATION` | body validated against `inputSchema`; executes through `apps/text` (`/generate`), SSE frames for `stream`; `Idempotency-Key` supported |
| `POST /api/v1/agents/{slug}/speech` | `TEXT_TO_SPEECH` | body `{ text | ssml }`; chunked audio or SSE (existing speech proxy) |
| `POST /api/v1/agents/{slug}/transcriptions` | `SPEECH_TO_TEXT` batch | multipart or `mediaId`; returns a `TranscriptionJob` (TASK-861 payload) |
| `POST /api/v1/audio/transcription-jobs/stream/session { agentSlug? }` + `WS /ws/stt/stream` | `SPEECH_TO_TEXT` realtime | unchanged transport; agent-resolved spec (TASK-861) |

Each published agent contributes a component schema pair to `openapi.json` (request from `inputSchema`, response from `outputSchema`), regenerated by `pnpm api:openapi`, so `/developer` documents them.

Admin plane (`/admin/agents/**`, `@CanManage('Agent')`, `@ForbidApiKey`): CRUD, versions, validate, publish, clone/new-version, assignments (`/admin/agent-assignments`), test-run (a sandboxed invocation with `externalWrite` suppressed — reuse the Workbench sandbox contract).

### 3.6 Console

- `/agents` (tier 30-49, `manage:Agent`) replaces the redirect: `ScreenTemplate` fill-mode grid grouped/filtered by task; row → `DetailDrawer` with tabs *Overview · Configuration · Versions · Test run · Usage*; create wizard **Task → Model (registry rows of that task, availability badge) → Instruction (template picker or inline) → Parameters (schema-driven form from `AGENT_PARAMETER_SCHEMAS[task]`, the same `toFieldDescriptors` renderer the Studio inspector uses) → Schemas → Review & publish**.
- `/workflow-studio/assignments` becomes **Assignments** for both workflows (per palette) and agents (per task) — one matrix, one cascade.
- `/prompt-templates` stays as the instruction library; its "Agent" wording is removed.
- The Studio's `core.agent` inspector (TASK-864) shows an agent picker (published agents of the port-compatible task) with a "Create agent" deep link.

### 3.7 Seeds (replace the `agent.*` node catalogue with rows)

SYSTEM tenant (platform defaults, `isActive: true`): `platform-transcription` (ASR: `arcaai-whisper-large-ml-en-gguf` + `silero-vad`; fallback `faster-whisper-large-v3-turbo-int8`), `platform-summarization`, `platform-presummarization`, `platform-discharge-summary`, `platform-grammar-correction`, `platform-important-findings` (TEXT_GENERATION on the elected `text.*` routing-policy model, bound to the existing APPROVED SYSTEM prompt templates), `platform-tts` (TTS: `kokoro`). Global tenant (`50000000-…`): the same set as *published* examples plus one Azure-backed and one Sarvam-backed ASR agent in DRAFT (no key seeded). ArcaAI tenant: nothing — provisioning clones SYSTEM (owner ruling 2026-08-20).

### 3.8 Deprecations (mark now, remove in release +2)

`agent.*` node types (11) and `agentic.stt` / `agentic.tts` (their function moves to `core.agent` + Agent rows, TASK-864); `features/agents` prompt-template components move under `features/prompt-templates` (rename, no redirect needed — the route already is `/prompt-templates`); harness `_llm_policy.get_policy(task_key)` on the retired `AiTaskDefault` overlay; `HarnessPolicy.textProvider/textModel` (superseded by the agent binding).

## 4. Implementation Plan

| # | Step | RED test | Files |
|---|---|---|---|
| 1 | Prisma: `AgentTask`, `Agent`, `AgentModelFallback`, `AgentAssignment(+Change)`, `ResourceType` additions, partial unique index + immutability trigger (hand-written SQL, `WorkflowDefinition` precedent), allow-lists; shadow-DB migration proof | migration diff empty; `resourceType.enum-parity.test.ts` | `packages/database/src/prisma/db_main/{agent,enums,audit}.prisma`, `extensions/tenant-scope.ts`, `client.ts` |
| 2 | `gen:model`; hand-author entity/factory/mapper (`FIELDS_NOT_WRITABLE`)/repository for the four models; `CoreDatabaseModule` registration; `gen:entity`/`gen:factory` coverage green | domain tests per trio | `packages/domains/src/**/generated/core/Agent*` |
| 3 | `AGENT_PARAMETER_SCHEMAS`, `AGENT_IO_DEFAULTS`, `agentConfigProblems()` (task/model match, forbidden keys, capability gates) — pure | `agent-schemas.test.ts` with golden pass/fail fixtures per task | `packages/workflow-contract/src/agent-schemas.ts` |
| 4 | `AgentService` (CRUD, validate, publish, newVersion, deprecate, `demoteExistingActive`), `AgentAssignmentService` (cascade via `walkCascade`), DTOs, sys-events, 404-over-403 | service tests: publish fails closed on unavailable model / unapproved template / task mismatch | `packages/applications/src/services/agent/**`, `agent-assignment/**` |
| 5 | `AgentResolverService` (§3.4) + `GET /internal/agents/resolve` | resolver tests: explicit, cascade, foreign 404, cloud override derived, funding tier | `services/agent/agent-resolver.service.ts`, `apps/api/src/modules/internal/agent-internal.controller.ts` |
| 6 | Business routes (§3.5) + admin routes; `@ApiTags` from the taxonomy; OpenAPI component generation from `inputSchema`/`outputSchema` | controller unit tests; e2e `task-863-agent-invoke.spec.ts` (4 credential classes, cross-tenant 404, quota) | `apps/api/src/modules/{agent,agent-admin}/**`, `apps/api/src/openapi/*` |
| 7 | Harness: `core.agent` activity resolves via `/internal/agents/resolve` and calls text/tts/stt; `_llm_policy` deprecated | `test_agent_activity_resolves_via_gateway.py` | `apps/harness/src/harness/temporal/interpreter/nodes/agent.py` |
| 8 | Console `/agents` + assignments matrix + Studio agent picker | screen tests, axe 0 violations, both themes | `apps/admin-console/src/features/agents/**` (rewrite), `workflow-studio/components/inspector/agent-picker.tsx` |
| 9 | Seeds (§3.7) + seed tests (SYSTEM defaults resolve; Global examples publish; ArcaAI empty) | `seed/__tests__/task-863-agents.test.ts` | `seed/25-agents.ts` |
| 10 | SDK: `hope.agents.*` (vox-node), `useSelectableAsrAgents` (vox) — TASK-865 | — | — |
| 11 | Artifacts: build, route-manifest, openapi, portal, `gen:admin`; deprecation register rows | check scripts green | — |

### Verification criteria

- Layer gates green: domains, applications, `pnpm test:unit`, `pnpm test:e2e` (agent specs), `pnpm harness:test`, console build/lint/test.
- Live proof: create an LLM agent in the Global tenant bound to `lms-gemma-4-e2b-it-qat` with the approved SOAP template → publish → `POST /agents/{slug}/invocations?mode=stream` returns SSE text; the same slug placed in a workflow `core.agent` node produces the same output through Temporal.
- Publish of an agent bound to `nemotron-3.5-asr-streaming-0.6b` **fails** with `MODEL_UNAVAILABLE` until TASK-860 delivers the parakeet.cpp runtime (fail-closed proof).

## 5. Decisions taken (owner may override)

| # | Decision | Alternative rejected |
|---|---|---|
| D-1 | Agent is its **own table**, referenced by workflows; not "a one-node workflow". | Single-node `WorkflowDefinition` — no task typing, no standalone invocation shape, and every agent edit bumps the workflow registry checksum. |
| D-2 | Provider connection is **derived** from the model's provider; no `providerConnectionId` on the agent. | Explicit connection pin — duplicates the `(tenant, service, provider)` uniqueness and reintroduces the string-join drift the routing-policy work removed. |
| D-3 | Fallback chain as a child table with FKs. | JSON array — cannot be FK-checked or indexed (recorded reason on `AiRoutingPolicy.candidatesJson`). |
| D-4 | Classification is a workflow node, not an agent (owner's rule); NER/PII/safety models are chosen on the node from the registry by task. | — |
| D-5 | Standalone invocation runs in the gateway (no Temporal) for LLM/TTS; batch ASR is a job; only workflows use Temporal. | Temporal for every call — adds latency and history for a single request. |

## 6. Open questions for the owner

1. Should a tenant be able to bind an agent to a **SYSTEM model that is cloud-backed** when the tenant has no key, i.e. spend the platform's key (`featurePlatformDefaultCredential`)? Current entitlement semantics say yes when entitled; confirm for day-1.
2. Entitlement key: `maxAgents` per tenant (recommended) or per task?
3. Memory for text-generation agents (`memory: conversation`) — in scope for day-1 or deferred? Recommendation: deferred; consultations carry context explicitly through the workflow.

## 7. Implementation Summary

Implemented on branch `task-863-agent-entity` (worktree `hope-v2-task-863`, base `dev-2.2 @ 1896ebc03`), steps 1–6, 8, 9 and 11 of the plan. Steps 7 (harness `core.agent` activity) and 10 (SDK) belong to TASK-864 / TASK-865 and code against the contracts published here.

### 7.1 Data model (step 1) — `packages/database`

- `src/prisma/db_main/agent.prisma`: `Agent` (rows are versions; `modelId` FK → `AiModel`, `onDelete: Restrict`), `AgentModelFallback` (ordered chain, FKs both ends), `AgentAssignment` (`(scope, scopeId, task)` over `PipelinePolicyScope`), `AgentAssignmentChange` (identity-only WORM).
- `enums.prisma`: `AgentTask { SPEECH_TO_TEXT TEXT_GENERATION TEXT_TO_SPEECH }` appended; `audit.prisma`: `ResourceType += Agent, AgentAssignment` (parity test green); `stt.prisma`: two back-relation lines on `AiModel` (`agents`, `agentFallbacks`) — required by Prisma for the FKs.
- Migration `migrations/20260904120000_task_863_agent/`: the `prisma migrate diff` output + hand-written SQL — partial unique index `Agent_tenant_slug_active_unique` (`WHERE "isActive" = true AND "resourceStatus" != 'DELETED'`), `agent_immutability_guard` (PUBLISHED/DEPRECATED bytes + lineage immutable, hard DELETE refused), `agent_model_fallback_immutability_guard`, and `agent_assignment_change_worm_guard` (a role-independent BEFORE UPDATE OR DELETE trigger instead of a `REVOKE` against a role name the repo never fixed).
- Allow-lists: `TENANT_SCOPED_MODELS` += the four; `SYSTEM_SHARED_READ_MODELS` += `Agent`, `AgentAssignment`; `MODELS_WITHOUT_SOFT_DELETE` += `AgentAssignmentChange`.

### 7.2 Domain (step 2) — `packages/domains`

Hand-authored trios for the four models (`AgentEntity` invariants: slug grammar, PUBLISHED ⇒ `compiledConfig`, `isActive` only when PUBLISHED, tools TEXT_GENERATION-only), OCC mappers (`FIELDS_NOT_WRITABLE = ['version']`), a strip mapper for the WORM log, `AgentRepository` with the published-and-active predicate written once (`findPublishedActiveBySlug`, `findPublishedActiveVisible`, `findByIdVisible`, `findOwnActiveBySlug`, `findAllVersionsBySlug`, `findMaxVersionNumber(tx)`), `CoreDatabaseModule` registrations. `gen:entity:check` / `gen:factory:check`: no drift, schema coverage OK. `packages/types/src/agent.ts` publishes `ResolvedAgent` / `AgentCompiledConfig`.

### 7.3 Contract (step 3) — `packages/workflow-contract/src/agent-schemas.ts`

`AGENT_TASKS`, `AGENT_TASK_SERVICE`, `AGENT_TASK_MODEL_TASK_TYPE`, `AGENT_PROTOCOLS`, `AGENT_PARAMETER_SCHEMAS` (§3.2 per task; the ASR spec of TASK-861 §3.2 — every auxiliary model a registry SLUG), `AGENT_INSTRUCTION_SCHEMAS`, `AGENT_IO_DEFAULTS`, `agentConfigProblems()` (task ↔ model match, reference-only rule over the agent's JSON columns, per-task instruction shape, tools TEXT_GENERATION-only, `json_schema ⇒ responseSchema`, generation + SSML capability gates). Reference-only proof: `forbiddenSchemaKeyProblems(AGENT_PARAMETER_SCHEMAS) === []`.

### 7.4 Services (steps 4–5) — `packages/applications`

- `services/agent/`: `AgentService` (list/getById/listVersions/create/update/deleteById/validate/publish/newVersion/deprecate + business `listPublished`/`getPublishedBySlug`). ONE findings pipeline (`collectFindings`) backs both `validate()` and `publish()`: structural (`agentConfigProblems` + `jsonSchemaValueProblems` + `authorableJsonSchemaProblems`), availability fail-closed (cloud ⇒ enabled `AiProviderConnection` at tenant or SYSTEM; engine-served `lm-studio|ollama|vllm|llama-cpp` ⇒ ENABLED; otherwise `localPath` or DOWNLOADED), APPROVED template + pinned version, capability gates from `AiModel.metaData`. `publish()` stamps `compiledConfig` (`AgentCompiledConfig`) + `sha256:` over `canonicalJson`, elects `isActive` and demotes the previous active row. Findings carry codes: `MODEL_UNAVAILABLE`, `MODEL_TASK_MISMATCH`, `MODEL_NOT_FOUND`, `MODEL_DISABLED`, `TEMPLATE_NOT_APPROVED`, `TEMPLATE_NOT_FOUND`, `TEMPLATE_VERSION_NOT_FOUND`, `CAPABILITY`, `SCHEMA`, `CONFIG`.
- `AgentResolverService.resolve({ tenantId, task?, agentSlug?, departmentId? })` → `ResolvedAgent` (explicit slug widened [tenant, SYSTEM] → one 404; else the assignment cascade; primary + fallbacks + ASR auxiliaries materialised; cloud `providerOverride` + `fundingTier` from `resolveTenantCloudOverrides(service, tenantId)`).
- `AgentInvocationService`: `invokeText` (blocking / stream through the sanctioned `apps/text` `/api/v1/generate` path: `applyTextRuntimeProfile` → `applyTenantProviderOverrides`, `internalServiceHeaders`), `inputProblems` (TIER 3 against `inputSchema`), `buildSpeechRequest`, `resolveAsrPipelineId` (`TODO(TASK-861)`).
- `services/agent-assignment/`: `AgentAssignmentService` — `resolve` walks department → tenant → SYSTEM and skips a tier whose slug no longer resolves; OCC `upsert`/`remove` with a WORM change row in one transaction.
- API-key scopes: `admin:agent:manage` (reserved → `svc:admin:agent:manage`), `agent:definition:read`, `agent:invocation:write`.

### 7.5 Routes (step 6) — `apps/api`

| Route | Guards | Notes |
|---|---|---|
| `GET /api/v1/agents?task=` · `GET /api/v1/agents/{slug}` | `@Authorize()` + `@RequiredScopes('agent:definition:read')` | `{ data: AgentSummaryResponse[] }` / `AgentSummaryResponse` |
| `POST /api/v1/agents/{slug}/invocations?mode=blocking\|stream` | `@Authorize()` + `@RequiredScopes('agent:invocation:write')`, heavy throttle | body validated against `inputSchema`; blocking JSON or SSE relay |
| `POST /api/v1/agents/{slug}/speech` | same | agent voice/format/speed/model over the tenant TTS config + BYO overrides; streamed; metered |
| `POST /api/v1/agents/{slug}/transcriptions` | same | `{ mediaId, consultationId?, language? }` → batch `TranscriptionJob` on the agent-resolved pipeline (201) |
| `/api/v1/admin/agents/**` | `@CanManage('Agent')`, `@ForbidApiKey`, `svc:admin:agent:manage` | list (`?task&includeTemplates`), get, versions, create, PATCH (If-Match), delete, validate, publish, versions (branch), deprecate |
| `/api/v1/admin/agent-assignments/**` | same subject/scope | list (`?task`), get, create, PATCH (If-Match), DELETE (If-Match) |
| `GET /api/v1/internal/agents/resolve?service=harness&tenantId&task&agentSlug&departmentId` | `@Public()` + `InternalServiceTokenGuard`; `X-Tenant-Id` (or `tenantId`) mandatory | `ResolvedAgent`; CLS pinned to the caller tenant |

Tags `agents`, `admin-agents`, `admin-agent-assignments`, `internal-agents`; tenant-admin CASL grants for `Agent` / `AgentAssignment` (`seed/01-policy.ts`). Artifacts (`route-manifest`, `openapi.json`, portal, `vox-node gen:admin`) are NOT regenerated on this branch — orchestrator step.

### 7.6 Console (step 8) — `apps/admin-console`

`features/agents` (the prompt-template components moved verbatim to `features/prompt-templates`, keys re-rooted): `AgentsScreen` (fill-height grid, task/status/owner facets, `WorkingTenantGate`), `CreateAgentWizard` (Task → Model with availability hints → Instruction → Parameters, schema-driven over `AGENT_PARAMETER_SCHEMAS` → Schemas → Review; create draft / create & publish), `AgentDetailDrawer` (Overview · Configuration · Versions · Test run · Usage; validate/publish/deprecate/new version/branch template/delete/set as tenant default). `/agents` is a real route again; nav-config gained the `/agents` entry (`knowledge-agents`, 30-49, `manage:Agent`). axe: 0 violations on the grid and the open drawer (vitest-axe). Both themes use semantic tokens only; runtime visual verification is left to the orchestrator (no `next dev`/browser in this lane).

### 7.7 Seeds (step 9) — `seed/25-agents.ts`

SYSTEM: `platform-transcription` (whisper.cpp ML/EN + CT2 turbo fallback, silero-vad, cadence punctuation), `platform-summarization` (live SOAP template), `platform-presummarization`, `platform-discharge-summary` (inline prompt — no APPROVED SYSTEM discharge template exists on this base), `platform-grammar-correction`, `platform-important-findings` (JSON), `platform-tts` (kokoro/af_heart) — all PUBLISHED + active, plus SYSTEM TENANT-scope assignments for the three tasks. Global tenant: the same seven as `example-*` published rows plus `example-azure-transcription` and `example-sarvam-transcription` in DRAFT. ArcaAI: nothing. Models resolved by slug at seed time; unresolvable specs are skipped (fail closed).

### 7.8 Gates (package-scoped, this branch)

`@arcaai/workflow-contract` 20/20 new tests · `@arcaai/database` 79 files / 1868 (+ seed test) · `@arcaai/domains` build + 160 files (1900) · `gen:entity:check`/`gen:factory:check` no drift, coverage OK · `@arcaai/applications` build + 651 files (incl. `text-generate-caller-coverage`, scope registries) · `pnpm api:build` + 50 controller/tag tests · `@arcaai/admin-console` build (`/agents`, `/prompt-templates` emitted), lint (`--max-warnings 0`), 266 files / 2359 tests.

### 7.9 Cross-ticket markers

`TODO(TASK-860)` availability predicate (`agent.service.ts`) · `TODO(TASK-861)` `resolveAsrPipelineId` (`agent-invocation.service.ts`, `agent.controller.ts`) · `TODO(TASK-862)` credential resolver (`agent.service.ts`, `agent-resolver.service.ts`, `capabilitiesOf`).

### 7.10 Deviations

- `AiModel` gained two back-relation lines in `stt.prisma` (Prisma requires both sides of a relation).
- `AgentAssignmentChange` WORM is a trigger, not a `REVOKE` (no app role name exists in the repo; the trigger holds under any deployment).
- `built-in` is NOT engine-served: bucket-loaded rows need `localPath`/DOWNLOADED, so publishing `platform-tts` (kokoro, weights owned by the pip package) through the UI fails closed until TASK-860's `availability` lands; the seed writes the row directly.
- `mode=stream` relays the TEXT service SSE frames directly (no task-id handshake).
- No `maxAgents` entitlement precheck (open question 2).
- `hope-v2` `dev-2.2` moved to `9a933b360` after this branch was cut; the console build on the base commit fails type-check on the pre-existing `ai-platform/huggingface-fetch-drawer.tsx` `raw.trim` bug that `9a933b360` fixes — it passes with that fix (verified by applying it locally, then restoring the base file).

## 8. Change History

| Date | Change |
|---|---|
| 2026-09-04 | Ticket created from the TASK-859 review. |
| 2026-09-04 | Steps 1–6, 8, 9, 11 implemented on `task-863-agent-entity` (schema + migration, domain trios, contract schemas, services + resolver + invocation, routes, console Agents screen, seeds, register). Status → Review. Steps 7 (harness) / 10 (SDK) → TASK-864 / TASK-865. |
| 2026-09-09 | **Merged into `dev-2.2` — recorded at close-out (TASK-932 branch review).** `task-863-agent-entity` (tip `5e1b1c31d`) has its exact tip tree in `dev-2.2` (`61eec2193` post-rewrite), no unmerged patch per `git cherry`; on the remote since `04708b489`. Local branch deleted after verification. |
