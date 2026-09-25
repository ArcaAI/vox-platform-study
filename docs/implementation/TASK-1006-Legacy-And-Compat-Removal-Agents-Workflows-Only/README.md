# TASK-1006 — Remove every compat and pre-agent legacy path: agents and workflows only

| Field | Value |
|---|---|
| Status | **In Progress** — owner **go** 2026-09-25; wave 1 running (6 lanes, + the 2 TASK-1005 §13 residency lanes) |
| Type | refactor (removal) + feature (ALaaS migration) |
| Branch | `dev-2.2` (hope-v2) · `main` (hope-v2-deployment) · `refactor-hope-integaration` (ALaaSv3.0) |
| Opened | 2026-09-25 |
| Rules read | `00`, `01`, `02`, `03`, `04`, `05`, `06`, `08`, `09`, `13`, `14`, `_karpathy` |

## 1. Requirement (owner, 2026-09-25)

> "We need to remove the compat implementation everywhere and make sure we have all updated to agents/workflows
> endpoints and architecture."
> "Do NOT release SDK via pipeline, we have run book to follow locally!"

TASK-1004 (2026-09-24) deleted the v1 compat HTTP routes, `@arcaai/vox/compat` and `hope.summarization.*`. This
ticket removes what is left: every path that serves or selects AI work outside the agent/workflow plane.

## 2. Inventory (read-only discovery, 2026-09-25; `sonnet` explore agent, spot-checked)

### 2.1 HOPE — runtime code with live callers

| # | What | Where | Replacement |
|---|---|---|---|
| H-1 | **Synchronous legacy summary** `POST consultations/:id/summary` and `…/summary/pre-summary` (+ `SummaryService.generateSummary`, self-described as "the 'summary' half of the v1-compat surface", bypasses the harness/workflow) | `packages/applications/.../consultation/summary/summary.service.ts:636-711`, `apps/api/.../consultation.controller.ts:1662`; vox-node `consultations.summaries.generate` / `generatePreSummary` (`packages/vox-node/src/resources/consultation-summaries.ts:89-120`) | The async/workflow plane: `…/summary/async`, `…/pre-summary/async`, workflow runs (`hope.consultations.workflows`, `hope.workflows.*`) |
| H-2 | **Pre-agent ASR pipelines**: `admin/audio/pipelines/**`, pipeline catalogue, tenant pipeline resync + cron, `pipelineId` on native routes (`markPipelineIdDeprecated`), STT `pipeline_id` readers (`PipelineConfigReader`, optional STT DB layer) | `apps/api/src/modules/pipeline/**`, `apps/api/src/modules/tenant/tenant-pipeline-resync.controller.ts` + cron, `apps/api/src/common/pipeline-id-deprecation.ts`, `transcription-job.controller.ts:612,766,1084`, `apps/stt/**` | `agentSlug` → `AsrAgentResolverService` → `ResolvedAsrSpec` (TASK-861) |
| H-3 | Workflow-definition STT pipeline compiler / resolver (`PipelineConfigReader`) | `packages/applications/.../workflow-definition/compilers/stt-pipeline.compiler.ts`, `stt-pipeline-resolver.service.ts` | the ASR agent node (agent reference only) |
| H-4 | **`TenantSttConfig`** (`admin/stt-config/**`, the console `/ai-configuration` Speech tab, the batch worker's credential pull `resolveProviderOverrides`) | `packages/applications/.../tenant-stt-config/**`, `internal/stt/*` | `AiProviderConnection` (BYOK) + the ASR agent |
| H-5 | Browser SDK legacy: `usePipelines`, `useArcaPipelines`, `useSttProviderToggle`, `useLocalVoiceEmbedding`, the `selectedPipelineId` setting, `audio.start({ pipelineId })`, `audio.clientInference`, the `./plugins` re-exports of `useVAD`/`useSTT`/`useNoiseFilter`, the `./plugins/med-ner` entry; the client-AI packages `@arcaai/vad`, `@arcaai/noise-filter`, `@arcaai/med-ner` | `packages/agentic-sdk-v2/src/**`, `packages/{vad,noise-filter,med-ner}` | `useSelectableAsrAgents` + `agentSlug`; server-side VAD / denoise / NER via the agent |
| H-6 | Console legacy: `features/audio-pipelines` (still feeds the two playgrounds), the `/audio/pipelines` redirect page | `apps/admin-console/src/features/audio-pipelines/**` | playgrounds select an ASR agent |

### 2.2 HOPE — data

| # | What | Action |
|---|---|---|
| D-1 | `AsrPipeline`, `AsrPipelineVersion`, `TenantSttConfig` tables; `TranscriptionJob.pipelineId` column | dropped by a migration after a cluster backup (OD answer) |
| D-2 | Seeds: AsrPipeline rows, the `SDK_COMPAT_ARCAAI` API key, the "v1-compat body" pre-summary prompt rows that only feed H-1 | removed; prompt rows the workflow still uses are kept (the lane proves which) |
| D-3 | `ResourceType` enum members for dropped models | kept as tombstones (historical `AuditLog` rows), exactly like `AiTaskDefault` |

### 2.3 ALaaS — paths that bypass HOPE agents/workflows

| # | What | Where | Replacement |
|---|---|---|---|
| A-1 | DNA-style generate / job status passthroughs → `HopeService.compatRequest` → `api/smr/dna/style/*`, which HOPE v2 has **never** served (always 404) | `apps/audio-stream-svc/src/medical_summary/medical-summary.controller.ts:137-158`, `apps/web_ui/services/summaryService.js:147,190` | vox-node DNA writing style (`hope.admin.dnaWritingStyle.generateForDoctor` / `getJobStatus`, or `hope.dnaWritingStyle.ingest`) with the consultant-id → HOPE-user bridge (`IdentityMappingService.resolveClinicianUserId`, exported from `ConsultationModule`) |
| A-2 | ALaaS's own OpenAI medical-summary generation (`generateMedicalSummaryMapReduce`, in-process or the `openai-service` microservice) | `apps/audio-stream-svc/src/queue/medical-summary.processor.ts:964+` | a HOPE workflow run for the consultation (the tenant's governing workflow) |
| A-3 | `@arcaai/vox-node` pinned at 3.6.0, `@arcaai/vox-codegen` at 3.3.0 | `apps/audio-stream-svc/package.json` | 4.0.0 after the local release |

`HopeService.compatRequest` itself stays only if something other than A-1 still needs a raw request (it also backs a
workflow-definitions fallback); the lane decides and renames it if so.

### 2.4 Docs / comments only (C)

`apps/api/README.md:55-58`, `apps/text/README.md:134,146`, `prompt-resolution.service.ts` docstrings naming deleted
classes, architecture snapshots (`api-controller-inventory.md`, `api-controller-groupings.md`), the deprecation
register rows not yet `removed`, rules `05`/`06`/`08`/`09`; deployment repo `docs/exposure-and-access.md:35`,
`docs/aws-eks/**` (compat playground), `eks/load-test/README.md:33` (`pipelineId`).

## 3. Best practices applied

- **Remove, don't shim.** Every removed route answers 404; nothing is kept "for one release" (pre-production precedent, TASK-1004 D-8).
- **One breaking release for the SDKs.** All SDK removals ship in the same **4.0.0** major (not yet published), released **locally per `docs/operations/vox-sdk-release/README.md`**, never by the CI `publish-sdk` job.
- **Data last.** Code stops reading/writing the tables first; the drop migration is authored on a shadow DB and applied only after a cluster DB backup.
- **Queue-safe.** The STT Dramatiq actor keeps its positional arity (already-queued messages stay valid); only the meaning of removed arguments changes.
- **Callers first.** Each removal lane proves "no remaining caller" with a grep + a test before deleting.

## 4. Plan — waves and lanes (rule 14; file-disjoint)

| Wave | Lane | Repo | Owns | Tier |
|---|---|---|---|---|
| 1 | L-SUM | hope-v2 | H-1: sync summary routes, `SummaryService.generateSummary`, v1-compat seeded prompt rows (keep what workflows use), console callers moved to async/workflow | `opus` |
| 1 | L-ASR-GW | hope-v2 | H-2/H-3/H-4 gateway + applications: pipeline modules, resync + cron, `pipelineId` params, pipeline compiler/resolver, `TenantSttConfig` service/routes, `resolveProviderOverrides` → `AiProviderConnection`; scopes; route removals | `opus` |
| 1 | L-ASR-STT | hope-v2 | H-2 in `apps/stt`: `pipeline_id` readers, the optional DB layer, `fallback_pipeline_id`; actor arity preserved | `opus` |
| 1 | L-SDK | hope-v2 | H-5 in `@arcaai/vox` + vox-node sync summary methods; retire `vad`/`noise-filter`/`med-ner` from the fixed group and the build; changeset (4.0.0 major, amends the TASK-1004 one) | `sonnet` |
| 1 | L-CONSOLE | hope-v2 | H-6 + the `/ai-configuration` Speech tab; playgrounds select an ASR agent | `sonnet` |
| 1 | L-ALS | ALaaS | A-1 (bridge + DNA via vox-node), A-2 (summary via a HOPE workflow run), remove the local OpenAI summary path and its dead config | `opus` |
| 2 | L-DB | hope-v2 | D-1/D-2: drop migration (orchestrator authors on a shadow DB), domain trios, seeds, allow-lists — after wave 1 has removed every reader | `sonnet` |
| 2 | L-DOCS | hope-v2 + deployment | §2.4 docs, rules, deprecation register rows → `removed`, deployment-repo docs | `sonnet` |
| 3 | orchestrator | all | merge, regenerate the five API artifacts, ONE gate pass, cluster DB backup, deploy, then the **local SDK 4.0.0 release** per the runbook, then ALaaS on 4.0.0 (A-3) | — |

## 5. Verification

- Every removed route answers 404 on `api-dev.taphuynh.dev`; route manifest / openapi / portal / vox-node admin carry none of them.
- Live: a consultation recorded through ALaaS produces its note through the governing workflow; DNA generation for a mapped clinician reaches HOPE and a job completes; nothing in ALaaS calls OpenAI directly for summaries.
- `AsrPipeline*` / `TenantSttConfig` tables gone after the migration; STT sessions and batch jobs still resolve via agents.
- SDK: published from the operator's machine per the runbook; `npm view @arcaai/vox-node@4.0.0` resolves; ALaaS builds and tests on 4.0.0.

## 6. Owner decisions (2026-09-25)

| # | Question | Answer |
|---|---|---|
| OD-1 | SDK release timing | **One major:** hold 4.0.0 until this ticket's SDK removals land, then publish locally per the runbook. ALaaS stays on 3.6.0 until then. |
| OD-2 | HOPE scope | **Remove both** the sync summary routes and the whole pre-agent ASR pipeline stack; **drop the tables** after a cluster backup. |
| OD-3 | ALaaS paths bypassing HOPE | **Migrate both** to HOPE: DNA via vox-node with the consultant-id bridge; the medical summary via a HOPE workflow run; local OpenAI summary path removed. |
| OD-4 | SDK release mechanism | **Local runbook only**, never CI (restated 2026-09-25). |

## 7. Implementation summary

_Pending go._

## 8. Change history

| Date | Change |
|---|---|
| 2026-09-25 | Owner **go** (all of it; push bundled with this release). Wave 1 spawned: L-SUM, L-ASR-GW, L-ASR-STT (opus); L-SDK, L-CONSOLE (sonnet); L-ALS (opus). |
| 2026-09-25 | Ticket opened from the owner's directive; inventory by a read-only explore agent; OD-1…OD-4 answered as recommended; plan written; awaiting go. |
