# TASK-857 — Realtime Core Readiness: transcription agent, three consultation workflows, local k8s, SDK integration

| Field | Value |
|---|---|
| **Status** | `In Progress` |
| **Type** | `feature` + `infrastructure` + `docs` (spans `hope-v2` and `hope-v2-deployment`) |
| **Branch** | `dev-2.2` |
| **Opened** | 2026-09-03 |
| **Out of scope (owner)** | Harness policy and guardrail. Both stay exactly as they are; the three example workflows deliberately carry no `guard.*`/`guardrail.*` node and no `agent.presummarization` (which `requires: ['guard.groundedness']`). |
| **Evidence base** | 5 read-only explorer agents (backend substrate, console inventory, Python services, deployment repo, SDK) + direct DB/cluster probes, 2026-09-03. Condensed in §2. |

## 1. Requirement Analysis

Owner brief (2026-09-03), restated as verifiable outcomes:

| # | Outcome | Proof |
|---|---|---|
| R1 | A **realtime transcription agent** — a single-task agent bound to ONE provider (whisper.cpp here) — transcribes live audio with `taphuynh/whisper-large-en-medical-2607.26-merged-gguf` **q8_0** | Live Transcription playground + `@arcaai/vox` `audio.start({ pipelineId })` produce transcript segments from that GGUF |
| R2 | **Three example realtime-consultation workflows** for the ArcaAI tenant, with SYSTEM-tenant twins exposed as clone-able templates: (a) grammar fix, (b) medical NER, (c) NER + grammar fix — each with realtime transcription, partial summarization and finalization | Seeded, PUBLISHED, validation `ok: true` from the REAL engine; a clinician can select each at session-open and the realtime lane executes it |
| R3 | Text generation for pre/partial/final summary and grammar fix routes to LM Studio `gemma-4-e4b-it-qat` (= `google/gemma-4-E4B-it-qat-q4_0-gguf`, LM Studio wire id `gemma-4-e4b-it-qat`); NER routes to `blaze999/Medical-NER` | `AiTaskDefault` SYSTEM rows + a live generate call through the gateway |
| R4 | k8s templates complete and **deployed on a local OrbStack cluster** (Apple Silicon, no GPU, LM Studio on the host with the Metal llama.cpp runtime); models downloaded into MinIO `hope-models` and mounted into the serving pods; every workload healthy | `kubectl get pods` all Ready, smoke job green, model files visible under `/mnt/models-bucket` inside `hope-stt`/`hope-nlp` |
| R5 | `@arcaai/vox` and `@arcaai/vox-node` let a developer build the clinician UI for R1 + R2 and consume workflow endpoints/webhooks | Documented recipes + a webhook signature helper + typed hooks; README drift closed |
| R6 | Console surfaces are consolidated: no duplicate/confusing screens for the same function; platform admin manages providers + model catalog; tenant admin manages prompts (versioned), agents, workflows and tests them in playgrounds; visual builder for build/test/publish | Screen inventory in §2.4 with the changes in §3 Lane D |

## 2. Current State Evaluation (2026-09-03)

### 2.1 Substrate — the realtime engine exists, is ON, and is graph-driven
- `LiveDocumentationService.start()` runs the **realtime lane** derived from the tenant's published `consultation` graph (`realtime/realtime-executor.ts`, `realtime-lane.ts`), resolved through the `WorkflowAssignment` cascade (department → tenant), falling back to `PLATFORM_REALTIME_LANE`. The kill-switch `consultation.realtime.graphExecutor.enabled` is seeded `true` (`seed/11c-consultation-gate-settings.ts`, TASK-852).
- Realtime-lane node types: `consultation.captureBinding` (the only realtime `transcript` producer), `consultation.extractEntities` (NER via `apps/nlp`, `nlp.ner`), `consultation.realtimeSummary` (partial summary via `apps/text`, `text.live`), `agent.grammar` (prompt-bound, `text.live`), `agent.important_findings`, `agent.ner`.
- Mandatory consultation subgraph (`rule-catalogue.ts` WF-CONS-005…012): `consentGate → captureBinding → … → phiHop → … → synthesize → sensors → persistDraft → finalizeAssurance → hitlGate`, and every `captureBinding → synthesize` route passes through `extractEntities`. Per-node `enabled: false` (TASK-852) is honoured by BOTH engines for non-mandatory nodes — this is how workflow (a) keeps NER structurally present but switched off.
- Seeded today: SYSTEM `platform-default-summarization` (summarization palette); ArcaAI `arcaai-consultation-soap` (tenant assignment) and `arcaai-rheum-consultation-soap` (department assignment) — 23/24-node SOAP graphs that include guardrail + evidence + DNA nodes.
- **Gap G1 — selection does not reach the realtime lane.** TASK-813 lets a caller pick `workflowDefinitionSlug` at session-open, authorized by `assertSelectableForConsultation`, and the durable dispatcher honours it (marker `Consultation.metadata.governingEngine.workflowDefinitionSlug`). `resolveTenantLane()` (`live-documentation.service.ts:1105`) ignores the marker and consults only the cascade, so a clinician who selects workflow (b) still gets the tenant default's realtime nodes.
- A "single-task transcription agent" is an `stt`-palette `WorkflowDefinition`; publishing compiles it into `AsrPipeline` + `AsrPipelineVersion` (`compilers/stt-pipeline.compiler.ts`, slug `wf-stt-<definition-slug>`, tag `workflow-definition:<id>`). Realtime sessions bind `pipelineId` directly. **Gap G2 — no stt-palette definition is seeded**; only raw `AsrPipeline` rows are.

### 2.2 Models
- `apps/stt` has a whisper.cpp loader (`models/whisper_cpp_loader.py`, pywhispercpp ≥ 1.5). The medical model is seeded ONLY as `computeType: 'f16'` (`seed/ai-models/audio.ts:326`, slug `whisper-large-en-medical-260726-merged-gguf`); its pipeline (`06-stt.ts:1331`) is `isDefault: false`. **Gap G3 — no q8_0 row/pipeline**, and `_select_gguf_file` silently falls back to the first file when no filename matches the quant (`whisper_cpp_loader.py:157-163`).
- `apps/text` LM Studio adapter is per-request configured from `AiProviderConnection` (SYSTEM row `http://hope-lmstudio:1234/v1`). `lms-gemma-4-e4b-it-qat` is catalogued (`ai-models/llm.ts:151`) but **Gap G4 — nothing selects it**: `text.live`/`text.finalize`/`text.test` → `lms-gemma-4-e2b-it-qat`; `harness.judge` → `lms-gemma-4-e4b`.
- `apps/nlp`: `nlp.ner` → `medical-ner` (`blaze999/Medical-NER`) — correct, no change.
- Weights: MinIO layout `s3://hope-models/<slug>/<version>/` (flat), s3fs sidecars mount `/mnt/models-bucket` in stt/stt-worker/nlp/tts/lmstudio; `AiModel.localPath` is the highest-precedence loader input in all four services (TASK-855 Mode M). The private medical GGUF needs an HF token to publish; the q8_0 file is not in any bucket today (the OrbStack lab bucket holds Q5_0 only).
- Local host: LM Studio 0.4.x with `llama.cpp-mac-arm64-apple-metal-advsimd@2.32.0` selected; `gemma-4-e4b-it-qat` present (6.15 GB). Verified reachable from OrbStack pods at `http://host.docker.internal:1234` (HTTP 200) even though it binds 127.0.0.1.

### 2.3 Deployment
- `hope-v2-deployment` base is portable; identity lives in overlays. `hope-stt`, `hope-stt-worker`, `hope-lmstudio`, `hope-vllm` hardcode `runtimeClassName: nvidia` + `nvidia.com/gpu`. Ingress hardcodes `traefik`. Six hand-created Secrets; MinIO needs a TLS Secret. Images are amd64 only (buildx on the amd64 runner) — OrbStack runs them under Rosetta. Registry pull verified with the owner's GitLab token (user `tap`). Pipeline #1100 (HEAD `38f97cb43`) is building the images.
- OrbStack cluster: k8s v1.35, default StorageClass `local-path`, no ingress controller, `host.docker.internal` resolves from pods.

### 2.4 Console
- Providers/models are already consolidated (TASK-845): `/ai-platform` (unified: providers, tasks, catalogue, store, engines) + `/ai-models` (catalogue editor) + read-only engine mirrors. Prompts (versioned) are authored in ONE place, `/prompt-templates`. Workflows: `/workflow-studio` (React Flow canvas + list editor, validate, publish, clone from SYSTEM templates), `/workflow-studio/assignments`, `/workflow-runs`. Test surfaces: prompt Test Run panel, `/playground/workbench` (whole-definition sandbox run), `/playground/consultation` (Consultation Scribe, real SDK), `/playground/live-transcription`.
- **Gap G5** — `/playground/llm` is labelled "Agent Playground" but is a raw LLM console (text-gen/guardrail/NER tabs); nothing agent- or workflow-shaped runs there. **Gap G6** — the Consultation Scribe opens sessions with `departmentId` only; it never offers the workflow selection TASK-813 shipped (`useSelectableConsultationWorkflows` has zero call sites). **Gap G7** — the nav-config header comment says AI models is hidden; it is not.

### 2.5 SDK
- Browser: `useArcaSession().open({ workflowDefinitionSlug })`, `useSelectableConsultationWorkflows()`, `useConsultationWorkflow()`, `useArcaAudio().start({ pipelineId })`, `useArcaLiveSummary()` (partial summary + entity spans), `useConsultationEvents()`, `useWorkflowRun()`. Node: `hope.workflows.*`, `hope.consultations.workflows.*`, `hope.admin.*` (52 areas incl. `webhookEvent`).
- **Gap G8** — no webhook signature-verification helper (server signs `X-Hope-Webhook-Signature: sha256=<hex>`); **G9** — no sys-event fires on `WorkflowRun` start/terminal (no `ResourceType`), so run lifecycle cannot be subscribed via webhooks; **G10** — READMEs omit `hope.workflows`, `useWorkflowRun`, `useArcaLiveSummary`, `useConsultationEvents`; no end-to-end developer recipe exists.

## 3. Implementation Plan — lanes (one worktree per writer; orchestrator owns merges, DB resets, deployment repo)

| Lane | Tier / effort | Owns (exclusive) | Delivers |
|---|---|---|---|
| **A** Realtime lane honours the selected workflow | `opus` / high | `packages/applications/src/services/consultation/live-documentation/**`, `apps/api/src/modules/harness-admin/**` | `resolveTenantLane` reads the consultation's `governingEngine` marker first (published, same tenant, `consultation` palette) and falls back to the cascade; `GET admin/harness/live/capabilities?consultationId=` reports the same resolution. TDD. |
| **B** Seeds: models, task defaults, transcription agent, 3+3 workflows | `opus` / high | `packages/database/src/prisma/db_main/seed/**`, `packages/database/scripts/regen-*.ts`, one data migration | q8_0 `AiModel` + pipeline; `text.*`/`harness.judge` → `lms-gemma-4-e4b-it-qat`; stt-palette transcription-agent definition (SYSTEM template + ArcaAI, compiled pipeline `wf-stt-…`, ArcaAI default); 3 SYSTEM templates + 3 ArcaAI consultation workflows authored as graphs and compiled by the real engine via a regen script; seed tests (engine re-run, realtime-lane admission per workflow, `safe`-mode deny-list). |
| **C** whisper.cpp quant selection fails closed | `sonnet` / medium | `apps/stt/src/stt/models/whisper_cpp_loader.py` + its tests | `_select_gguf_file` raises `ModelLoadError` when `computeType` is set and no candidate matches (never loads f16 for a q8_0 row). |
| **D** Console consolidation | `opus` / high | `apps/admin-console/**` | Consultation Scribe: workflow selector (TASK-813 hooks) + governing-workflow badge; `/playground/llm` renamed "LLM Playground"; stale nav comment fixed; templates library verified to list the SYSTEM examples. Vitest + axe. |
| **E** SDK + developer surface | `opus` / medium | `packages/vox-node/**` (not `src/resources/admin/**` except via `gen:admin`), `packages/agentic-sdk-v2/README.md`, `docs/architecture/clinician-integration-guide.md`, and — only if a clean seam exists — `WorkflowRun` sys-events (`audit.prisma` + migration + domain enum + `workflow-run`/`workflow-exposure` services) | `verifyWebhookSignature()`; README drift closed; the integration guide (transcription agent, consultation workflow selection with live summary/NER/grammar, server-side runs + webhooks). |
| **F** OrbStack deployment (orchestrator) | — | `hope-v2-deployment/deployment/k8s/overlays/orbstack/**`, secrets (local only), model publishing | New overlay: no GPU, `hope-lmstudio` → host, no ingress/cloudflared (LoadBalancer Services), pinned `dev-38f97cb4` digests, seeded DB, models in the bucket and mounted. |

Sequencing: A–E in parallel from `dev-2.2@38f97cb43`; F in parallel on the deployment repo; merge A→B→C→D→E into `dev-2.2` re-running each lane's gates after merge; then reseed local dev DB, run the live E2E (TASK-852 item 8) locally, then push and deploy to OrbStack from the CI-built images of the merged HEAD.

### Assumptions (stated, not asked)
1. The ArcaAI tenant assignment stays `arcaai-consultation-soap`; the three examples are **selectable** at session-open (this is what "use any of those 3" requires) rather than replacing the default.
2. "Medical NER agent" = `consultation.extractEntities` (blaze999/Medical-NER through `nlp.ner`); `agent.important_findings` (LLM) stays in the SOAP workflows only.
3. "Summarization agent (partial + finalization)" = `consultation.realtimeSummary` (realtime, `text.live`) + `consultation.synthesize` (durable, `text.finalize`). `agent.presummarization` is excluded because it requires the groundedness guard.
4. The LM Studio wire id is `gemma-4-e4b-it-qat`; the GGUF published to the bucket is Google's `google/gemma-4-E4B-it-qat-q4_0-gguf` (same Q4_0 QAT weights).
5. The private whisper repo needs the owner's HF token to publish q8_0; until supplied, the OrbStack bucket carries the Q5_0 file from the TASK-855 lab as a stand-in and the q8_0 row fails closed (Lane C) rather than silently serving another quant.

## 4. Implementation Summary
_(filled per lane as they merge)_

## 5. Change History

| Date | Change |
|---|---|
| 2026-09-03 | Ticket opened. Evidence gathered by 5 explorers + DB/cluster probes; plan v1 with lanes A–F. |
