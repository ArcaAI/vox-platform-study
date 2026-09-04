# TASK-859 — AI Platform Consolidation program: Model Registry · Audio-pipeline retirement · AI Providers · Agents · Workflows · SDK

| | |
|---|---|
| **Status** | Review (planning complete; awaiting owner decisions before implementation starts) |
| **Type** | program (feature + refactor + removals) |
| **Branch** | `dev-2.2` |
| **Created** | 2026-09-04 |
| **Numbering note** | The owner asked for tickets starting at 856. `TASK-856`, `857` and `858` already exist in `docs/archive/` (Workflow Cloning, Bootstrap Tenant Admin Login, Realtime Core Readiness), so this program uses **859–865** to avoid a collision. Renumbering is a directory rename plus find/replace if the owner prefers. |

## 0. Ticket index

| Ticket | Title | Depends on | Layer focus |
|---|---|---|---|
| **TASK-859** (this) | Program umbrella: findings, target architecture, decisions, sequencing, deprecation policy | — | docs |
| [TASK-860](../TASK-860-Model-Registry-Platform-Catalogue/README.md) | Model Registry: platform-admin-only catalogue of the shared bucket, HF taxonomy, 35-row seed, loader coverage | — | DB → domain → services → API → Python → console |
| [TASK-861](../TASK-861-Audio-Pipeline-Retirement/README.md) | Audio-pipeline retirement: `AsrPipeline`/`TenantSttConfig`/`PipelinePolicy`/STT palette → ASR Agent with gateway-resolved specs; `apps/stt` DB-free | 860, 863 | all layers + Python |
| [TASK-862](../TASK-862-Ai-Provider-Consolidation/README.md) | AI Provider consolidation: one `/ai-providers` screen, cascade wired to agents/workflows, `AiTaskDefault`/`AiRuntimeProfile`/`/ai-platform` retired, **Provider Reconciliation removed** | 860 | DB → services → API → console |
| [TASK-863](../TASK-863-Agent-First-Class-Entity/README.md) | Agent: first-class, task-typed (ASR · text-generation · TTS), publishable, invokable, referenced by workflows | 860, 862 | all layers |
| [TASK-864](../TASK-864-Workflow-Studio-V2-Node-Vocabulary/README.md) | Workflow Studio v2: one node vocabulary, CEL conditions, sub-graph loops, generic human review, Output-declared protocols (http / http-sse / socket), inbound webhook trigger, run-completed webhook | 863, 860 | contract → harness → API → console → SDK |
| [TASK-865](../TASK-865-Sdk-Client-Ai-Off-And-Agent-Selection/README.md) | SDK Vox / Vox-node: no client-side AI by default, agent/workflow selection instead of pipeline ids, client AI packages deprecated | 861, 863 | SDK + console consumers |

Deprecation register (the "remove after two releases" ledger): [`docs/operations/deprecation-register.md`](../../operations/deprecation-register.md).

## 1. Requirement Analysis

The owner's brief (2026-09-04) covers five areas; each is restated in its ticket. The cross-cutting requirements are:

1. **Old or unused code is marked deprecated, then removed after the next two releases** — never deleted in the same change unless it is seed data (there is no production data) or the owner named it for complete removal (Provider Reconciliation).
2. **Platform admin owns the model catalogue; tenant admins own providers (BYO keys), agents and workflows.**
3. **An Agent handles one task on one model; a Workflow is a Temporal-backed graph** authored visually from a fixed vocabulary (Trigger, Agent, Classify, Human review, Variable, If/Else, Loop, Note, Output).
4. **The browser runs no models.**
5. Research external practice (React Flow, Flowise, Langflow, n8n, Dify, LangGraph, Temporal, Hugging Face, MLflow, the ambient-documentation vendors) and align the plan with it — without anchoring on old tickets.

## 2. Current State — what the review found

Eight read-only exploration passes (six over the codebase, two external) were run on 2026-09-04; every ticket cites file:line evidence. The findings that decide the architecture:

### 2.1 Core business, as the code and the product docs define it

HOPE is a multi-tenant clinical-consultation platform: a clinician records an ambient consultation; live transcription, NER and a running note appear during the visit; a durable harness produces a grounded, cited draft; the clinician reviews, edits and **explicitly** approves before anything becomes a record; a timeout never approves; everything is audited. (`docs/architecture/consultation-session-workflow/user-stories-and-use-cases.md` §5 "core consensus"; UC-01.) Tenants configure vendors, models, prompts, templates and workflows; the platform (SYSTEM tenant) supplies defaults every tenant inherits until it expresses an opinion; the runtime cascade is always `tenant → SYSTEM`, two tiers. Integrators embed `@arcaai/vox` in the browser and `@arcaai/vox-node` server-side; a consultation is opened, governed by a workflow chosen by assignment or by the caller, streamed over SSE/WS with single-use tickets, and closed with optimistic concurrency.

### 2.2 Findings by area

| Area | Finding | Consequence |
|---|---|---|
| Model registry | Schema already mirrors the HF task list and carries `localPath`/`checksum`; writes are super-admin at the controller **but** the service writes to the caller's tenant and the seed clones the catalogue into two customer tenants; two independent bucket publishers (in-product job, out-of-band k8s job); no measured availability; 45 seeded rows vs 35 in the catalogue; several catalogue identities do not exist on the Hub (`snakers4/silero-vad`, `nickolay/rnnoise`), one runtime is missing (parakeet.cpp), one dependency is deliberately excluded and degrades silently (DeepFilterNet3), one package is not in any image (Indic Parler) | TASK-860 |
| Audio pipelines | `AsrPipeline` is the **runtime** artifact: `apps/stt` selects it and `AiModel` rows from Postgres on every session; the "transcription agent" workflow compiles back into the same table; its Temporal nodes are placeholders; the resolver that could bypass it is unwired and guarded by a grep-gate test | TASK-861 |
| AI providers | `AiProviderConnection` is already the one credential store with correct three-state cascade and derived funding; the duplication is above it: a five-tab `/ai-platform` hub, a legacy `admin/ai-providers` alias, two backend credential facades, a retired-but-alive `AiTaskDefault`, an empty-seeded `AiRuntimeProfile` with no nav entry, and the Provider Reconciliation feature (vendor-billing audit, manual trigger only, 35-file footprint, nothing depends on it) | TASK-862 |
| Agents | "Agent" is simultaneously a prompt-template screen, eleven fixed node types, one generic node and an STT workflow; nothing is reusable, publishable or invokable on its own | TASK-863 |
| Workflows | The substrate is strong (registry-driven contract, publish immutability, Temporal interpreter, human gate, bounded loop, realtime lane, exposure plane with idempotency); the vocabulary is fragmented across four palettes; **missing**: If/Else, Classify, Note, Trigger/Output as nodes with protocols, inbound webhook trigger, socket stream, run-completed webhook (terminal status is written only when someone reads) | TASK-864 |
| SDK | Plugins are already default-off and local Whisper is disabled by a constant; the flagship playground hard-enables both client models; transcription selection still keys on a pipeline id; `vox-node` has workflow but no agent invocation | TASK-865 |

### 2.3 External practice adopted (evidence in the tickets)

- **Canvas**: `@xyflow/react` v12 (already in use) with per-port handles, parent/group nodes for loop bodies, elkjs layout, Zustand history.
- **Typed I/O**: Dify's variable-pool model (`{{nodes.id.field}}`, `vars.*`) plus JSON-Schema-declared node outputs and connect-time validation (Langflow's typed ports generalised); LangGraph's shared-state idea as the run context.
- **Conditions**: CEL — deterministic, typed, sandboxed, with TS and Python implementations.
- **Durable execution**: Temporal's own guidance — one generic interpreter workflow, one activity per node type, `wait_condition` for human review, child workflows + continue-as-new for loops, patching for interpreter changes, search attributes for run listing.
- **Publishing**: Dify's typed Start/Output → generated API contract; SSE as the default streaming protocol; Vellum-style release tags deferred.
- **Registry**: Hugging Face `pipeline_tag` → `library_name` → model as the organising facets with model-card metadata; MLflow-style "platform default per task" alias.
- **Clinical UX**: Abridge's evidence linking and Nabla/Suki template configurability as the review-screen direction (already partly present in HOPE's provenance model).

## 3. Target architecture

```
                 ┌──────────────── super admin ────────────────┐
                 │  /ai-models   Model Registry (SYSTEM only)  │  ← Hugging Face task → library → model
                 │  availability measured against s3://hope-models (/mnt/models-bucket)
                 │  "platform default for task" → AiRoutingPolicy SYSTEM election
                 └──────────────────────┬──────────────────────┘
                                        │ read (shared)
 ┌──────── tenant admin ────────────────┼──────────────────────────────────────────────┐
 │  /ai-providers   BYO keys per (service, provider) — tenant → SYSTEM, veto, funding   │
 │  /agents         Agent = task + model (+ fallbacks) + instruction + parameters + I/O │
 │  /workflow-studio  core.* graph: Trigger · Agent · Classify · Human review · Variable│
 │                    · If/Else · Loop · Note · Output (+ Data, Action)                 │
 │  /assignments    department → tenant → SYSTEM for agents (per task) and workflows   │
 └──────────────────────────────────────┬──────────────────────────────────────────────┘
                                        │ publish
 ┌──────────────── invocation ──────────┴──────────────────────────────────────────────┐
 │ agents:    POST /agents/{slug}/invocations (http | http-sse), /speech, /transcriptions│
 │ workflows: POST /workflows/{slug}/runs?mode  · POST /hooks/workflows/{slug} (webhook) │
 │            WS /ws/workflows/{slug}/runs/{id} (socket) · consultation open (clinical)  │
 │ realtime ASR: stream session (agent-resolved spec) → WS /ws/stt/stream               │
 └──────────────────────────────────────┬──────────────────────────────────────────────┘
                                        │
 gateway resolves everything (agent, model paths, provider credential) and injects it:
   apps/text · apps/stt (+worker) · apps/tts · apps/nlp · LM Studio  ←  read the bucket, hold no config
   Temporal (apps/harness): WorkflowInterpreter · LoopWorkflow · ReviewGateWorkflow
```

Invariants carried through every ticket:

1. **Configuration is never hardcoded and never an env var** beyond the bootstrap floor; graphs and agents carry references, never engines, endpoints or keys.
2. **Resolution is tenant → SYSTEM, two tiers**; the Global tenant is a customer playground, never a fallback.
3. **Fail closed** on an unresolvable model, credential or availability; degrade observably, never silently.
4. **The gateway resolves; services execute.** No Python service reads selection from Postgres (`guardrail`'s SQL read is repointed to `AiRoutingPolicy` and stays the documented exception).
5. **A timeout never approves; the system never signs.**
6. **The browser captures and renders; it never runs a model.**

## 4. Decisions taken by this review (owner may override)

| # | Decision | Where argued |
|---|---|---|
| P-1 | Numbering 859–865 (collision with archived 856–858). | header |
| P-2 | `AsrPipeline` and its neighbours retire; `apps/stt` becomes DB-free for selection; `PipelinePolicy` retires with them (its toggles become workflow-node `enabled` flags). | TASK-861 D-1/D-2 |
| P-3 | Agent is its own table (rows-are-versions), provider connection derived from the model's provider, fallbacks as FK child rows, Classify is a node not an agent. | TASK-863 D-1..D-4 |
| P-4 | One `core` palette; clinical steps become `core.action(actionKey)`; CEL for conditions; loop bodies as sub-graphs run as child workflows; Output declares protocols; `WorkflowRun` gains a sys-event so run-completed webhooks exist. | TASK-864 D-1..D-5 |
| P-5 | Cloud vendor calls stay in the Python services with gateway-resolved credentials (the "api gateway as proxy" column in the catalogue is read as *governance*, not as moving HTTP calls into NestJS). | TASK-862 OD-1, TASK-860 D-6 |
| P-6 | `/ai-platform` hub dissolves into `/ai-models` (registry), `/ai-providers` (BYO), `/agents`, `/workflow-studio`; `AiTaskDefault` strangler is finished; `AiRuntimeProfile`, `TenantSttConfig`, `TenantTtsConfig` retire. | TASK-862 |
| P-7 | The in-product download job is the one bucket publisher; the deployment repo's out-of-band Job becomes a bootstrap wrapper (cross-repo change). | TASK-860 D-1 |
| P-8 | Catalogue corrections: Silero via the `onnx-community` mirror, RNNoise has no weights, Nemotron via transformers RNNT first, Cadence served by `stt`, Granite Guardian GGUF from the community quant, `Gemma-4-Medical-ICD10` disabled pending evaluation, OpenAI STT wire id to be confirmed. | TASK-860 §2.4/§3.6 |
| P-9 | Client AI packages (`@arcaai/vad`, `noise-filter`, `stt`, `med-ner`) deprecated; `pipelineId` replaced by `agentSlug`. | TASK-865 |

## 5. Owner decisions required before implementation (consolidated)

| # | Question | Ticket |
|---|---|---|
| OD-1 | Confirm P-5: vendor HTTP calls stay in Python with gateway-resolved credentials. | 862 |
| OD-2 | Removal window: which two release tags bound "after the next two releases" (the register needs concrete `<SVC>-x.y.z` values). | 859/register |
| OD-3 | Nemotron runtime: transformers `AutoModelForRNNT` (recommended) vs `NeMo-Speech.cpp` vs `mudler/parakeet.cpp`. | 860 |
| OD-4 | vLLM: retire the provider/screen/`hope-vllm` (no catalogue row) or keep dormant. | 860 |
| OD-5 | OpenAI STT wire id: `gpt-4o-transcribe` (retiring) vs `gpt-transcribe` / `gpt-4o-transcribe-diarize`. | 860 |
| OD-6 | Embeddings / reranker: register as `feature-extraction` / `text-ranking` rows or keep as infrastructure connections. | 860 |
| OD-7 | Gated/private repos: fill the SYSTEM `model-registry:huggingface` token and accept the three licences. | 860 |
| OD-8 | Substrate A (`ConsultationLoopWorkflow`/`HarnessDocWorkflow`): keep as the zero-config default (recommended for this program) or schedule its retirement. | 864 |
| OD-9 | Human review assignee model: role only, or also user/department queues. | 864 |
| OD-10 | `schedule` trigger in scope? | 864 |
| OD-11 | Keep any client-side inference (`useLocalVoiceEmbedding`)? Delete or archive the client AI packages at removal time? | 865 |
| OD-12 | Entitlement keys: `maxAgents` (per tenant) replaces `maxAsrPipelines`; per task? | 861/863 |
| OD-13 | `Tenant.transcriptionMode`/`captureMode` retire with TASK-861? | 861 |
| OD-14 | Tenant BYO-less use of a SYSTEM cloud key (`featurePlatformDefaultCredential`) for agents — confirm day-1 posture. | 863 |
| OD-15 | `model-registry` connections (`huggingface`, `s3`) stay on `/ai-providers` as SYSTEM-only rows, or the S3 credential moves to deployment secrets. | 862 |

## 6. Deprecation policy (program-wide)

- **Marker**: Prisma `/// @deprecated TASK-nnn — removed in <release>` doc comments; `@deprecated` JSDoc on TS symbols; `DeprecationWarning` in Python; `@ApiDeprecated()` + `Deprecation`/`Sunset` headers on routes; `redirect()` stubs for console routes with the standard one-release comment; `package.json#deprecated` for packages.
- **Behaviour**: deprecated code keeps working for reads; write paths refuse (`410 Gone`) once the replacement screen ships; no new rows are created.
- **Register**: every item has one row in `docs/operations/deprecation-register.md` with `marked in`, `remove in`, `replacement`, `owner ticket`; a CI check (added by the first implementing ticket) fails if a `@deprecated TASK-` marker exists without a register row or after its removal release.
- **Exceptions**: seed data (deleted immediately — no production data), Provider Reconciliation (owner: remove completely).

## 7. Sequencing

```
860 Model Registry ──┬─► 862 AI Providers ──┬─► 863 Agent ──┬─► 861 Audio-pipeline retirement ─► 865 SDK
                     │                       │              └─► 864 Workflow Studio v2 ───────────┘
                     └───────────────────────┘ (860/862 can run in parallel worktrees: disjoint packages except seeds)
```

Two releases: **R1** ships 860 → 862 → 863 with everything old marked deprecated; **R2** ships 861 → 864 → 865; **R3** removes the register's R1 entries; **R4** removes the R2 entries. Each ticket follows the five-phase lifecycle in `01-development-workflow.md` and lands its own README updates; this umbrella tracks status only.

## 8. Cross-repository work (`arca/hope-v2-deployment`)

- `out-of-band/hope-models-publish.yaml` → bootstrap wrapper over the monorepo publisher (TASK-860).
- `HF_HUB_DISABLE_SYMLINKS=1` in the publisher; confirm `HF_HOME`/`HF_HUB_OFFLINE` on stt/stt-worker/nlp/tts stay (TASK-860).
- `hope-stt` no longer needs `DATABASE_URL` once TASK-861 lands (removal from `hope-stt-config` after the window).
- `hope-vllm` fate per OD-4; `hope-lmstudio` `link-models` unchanged.
- Documentation: `docs/model-bucket-and-serving.md` §3 (publisher), §2b (localPath now derived).

## 9. Implementation Summary

Execution ran as one orchestrator plus one Fable worker per ticket, each in its own git worktree
off the owner's dev-2.2 (`1896ebc03`), merged back in dependency order with every gate re-run on
the merged primary (`14-multi-agent-worktrees.md` §5). Status on 2026-09-04:

| Ticket | State | Merge commit on dev-2.2 | Notes |
|---|---|---|---|
| TASK-862 AI Providers | **merged** | first merge after the base repairs `9a933b360` | reconciliation removed outright; one `/ai-services` screen; `AiRuntimeProfile` removed (deviation 2) |
| TASK-863 Agent entity | **merged** | `36b9d9dd1` | integration fixes `5e1b1c31d`, migration banner strip `d10ed047c` |
| TASK-860 Model Registry | **merged** | `e8e24f9f2` | `uv.lock` re-resolved; `parler-tts` installs `--no-deps` in the `indic-parler` image variant |
| TASK-864 Workflow Studio v2 | **merged** | `ac5d4068a` | harness `core.agent` reconciled with the merged 863 resolve contract; `harness:typecheck` clean apart from the base defect; step B2 seeds partial (Q-B2) |
| TASK-861 Audio-pipeline retirement | **merged** | `74f7d975a` | steps 10 (palette descriptors already marked by 864; `implemented: false` / `WF-STT-*` / `stt_placeholder.py` residue) and 13 (artifacts) orchestrator-owned; step 7 covered by 860's fail-closed loaders; the pipeline half of `06-stt.ts` + `seedTenantSttConfig` still seeded (follow-up) |
| TASK-865 SDK | **merged** | `f09d17113` | client AI off by default, `agentSlug` selection, `hope.agents.*` in vox-node; one pre-existing prettier warning in `useRoles.ts` left as found |

Gateway boot defect found by the artifact emit and fixed on dev-2.2 (`b4eef13b2`): `AgentAdminModule`
did not import `AgentAssignmentServiceModule` (TASK-863), so Nest could not resolve
`IAgentAssignmentService` — `api:build` and the unit suites cannot see DI failures; the offline
`route-manifest` emit is the local gate that does. All five artifacts regenerated from the fixed
build: route-manifest 722 routes, openapi 497 paths, portal 642 admin / 195 business operations,
vox-node admin 52 areas / 413 routes / 386 schemas; `openapi:check`, `portal:check`, `gen:admin:check`,
`gen:model/entity/factory:check` all clean.

Base regressions fixed on dev-2.2 along the way: three call-parenthesis typos from the cleanup
commit (`9a933b360`); two TASK-862 constructor-slot drifts in tests (`f0e9031f7`, `86ff18952`).
Wave 3 — MERGED (`b17bd9c1f` seeds, `7a918ea38` gateway follow-ups, `75916afb8` stt palette residue); three Fable workers in worktrees off dev-2.2: the `06-stt.ts` pipeline-seed
half + `seedTenantSttConfig` deletion (861 step 11), the `stt` palette residue — `implemented: false`,
`WF-STT-*` retirement, `stt_placeholder.py` removal with parity kept (861 step 10 / 864 C1) — and the
gateway items (`start_session` Deprecation headers, `internal/stt` credentials via
`ProviderCredentialResolver`). e2e baseline on the isolated test stack runs on the merged tree in parallel.

e2e on the isolated test stack (1199 specs) surfaced defects no unit suite or build could see, all fixed
on dev-2.2: `@ApiDeprecated` (and the manual stream-route header) wrote an em-dash into
`X-Deprecation-Notice`, which Node refuses (`ERR_INVALID_CHAR`) — every one of the 23 deprecated routes
answered 500 (`0436ebee0`, sanitiser + pinned test); `WorkflowWsGateway` was untriaged in the WS
owner-binding boot audit (`f9be91ff0`); `AiRoutingPolicyRepository.findCandidates` pins
`tenantId: { in: [tenant, SYSTEM] }` and the tenant-scope shared-read rule accepted only a plain string,
so `admin/ai-task-defaults/*`, the prompt test bench and every usage/billing spec that discovers a
task default 500'd for a super admin with a working tenant (extension now admits `in`-subsets of the
pair, with tests); `POST audio/transcription-jobs` (JSON create) never resolved the ASR agent cascade
its multipart sibling had (`agentSlug` on the DTO, resolution in the controller, tests). Specs updated
for merged semantics: discovery register is 410 Gone (860), ten SYSTEM llm connections (862), 33
service-token-gated internal routes (863/860), stt-fallback credential cases removed with their routes
(862). Pre-existing on the owner's base, NOT program-caused: `mcp-admin.spec.ts` (the TASK-846 egress
allow-list `mcp.egress.allowedHosts` is never seeded for e2e) and `task-660-loop-stream.spec.ts` (label
whitespace on a path no program commit touched).

Orchestrator-owned steps still owed after 865: artifact regeneration (`api:route-manifest`,
`api:openapi`, `api:portal`, `vox-node gen:admin`), the e2e run on the isolated test stack, the
`06-stt.ts` seed split, the `AiTaskDefault` reader repoint (R3), and the owner decisions OD-1..OD-15
plus `workflows.py:748` (`workflow.patched()` without an id, a base defect).

## 10. Change History

| Date | Change |
|---|---|
| 2026-09-04 | Program created from the owner's review brief; eight exploration/research passes; six tickets planned; decisions and owner questions consolidated. |
| 2026-09-04 | Fan-out executed: 862, 863, 860, 864 merged into dev-2.2 with gates re-run on the merged tree (see §9); 861 in progress, 865 queued last. |
