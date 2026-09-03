# Deprecation register

| | |
|---|---|
| **Owner** | Platform / Architecture |
| **Introduced** | 2026-09-04 (TASK-859) |
| **Policy** | An item is *marked* deprecated in the release named in **Marked in** and *removed* in the release named in **Remove in** — "after the next two releases" (owner directive 2026-09-04). Removal releases are placeholders (`R1`, `R2`, …) until the owner names the tags (TASK-859 OD-2). A CI check (first implementing ticket) fails when a `@deprecated TASK-` marker in code has no row here, or when a row's removal release has shipped and the code still exists. |

Status values: `planned` (ticket not started) · `marked` (marker landed) · `removed`.

## Data model

| Item | Ticket | Marked in | Remove in | Replacement | Status |
|---|---|---|---|---|---|
| `AsrPipeline`, `AsrPipelineVersion` (Prisma, domain trio, `PipelineService`, `admin/audio/pipelines/**`, `audio/pipelines/**`) | TASK-861 | R2 | R4 | `Agent` (task `SPEECH_TO_TEXT`) + gateway-resolved `ResolvedAsrSpec` | planned |
| `TranscriptionJob.pipelineId` | TASK-861 | R2 | R4 | `TranscriptionJob.agentVersionId` + `resolvedSpec` | planned |
| `TenantSttConfig` (+ `admin/stt-config/**`, `/ai-configuration` Speech tab) | TASK-861 | R2 | R4 | ASR Agent `fallback` block | planned |
| `PipelinePolicy`, `PipelinePolicyChange` (+ `admin/harness/pipeline-policy`, `/harness/pipeline-policy`) | TASK-861 | R2 | R4 | node `enabled` flags on the assigned workflow (`WorkflowAssignment`) | planned |
| `Tenant.transcriptionMode`, `Tenant.captureMode` | TASK-861 (OD-13) | R2 | R4 | — (local transcription no longer exists) | planned |
| `AiTaskDefault` (table, `AiTaskDefaultService`, `admin/ai-task-defaults`, `features/ai-task-defaults`, `vox-node` admin resource) | TASK-862 | R1 | R3 | `AiRoutingPolicy` (non-agent task defaults) + `Agent.modelId` | planned |
| `AiRuntimeProfile` (all layers, `/ai-runtime-profiles`) | TASK-862 | R1 | R3 | `Agent.parameters` (hyper-parameters) + `AiProviderConnection` ceilings | planned |
| `TenantTtsConfig` (+ `admin/tts-config/**`, `/ai-configuration` Voice tab) | TASK-862 / 863 | R1 | R3 | TTS Agent + `AgentAssignment` | planned |
| `AiRoutingPolicy.candidatesJson` | TASK-862 | R1 | R3 | candidate rows | planned |
| `AiModel.downloadStatus`, `downloadedAt`, `fileSizeMb`; free-text `localPath`; `AiModelFormat` cloud pseudo-values (`CLOUD_API`, `AZURE_SPEECH`, `AZURE_FOUNDRY`, `SARVAM`, `OPENAI`); `AiModelSource.MLFLOW`, `GITHUB` | TASK-860 | R1 | R3 | `availability`, derived `localPath` from `bucketPrefix`, `deploymentKind` + `libraryName` | planned |
| Customer-tenant clones of the model catalogue (`backfillCustomerTenantAiModels`) | TASK-860 | R1 (deleted — seed data) | — | SYSTEM-only catalogue with shared read | planned |
| `ProviderReconciliationRun` + `provider-reconciler*` + `admin/usage/reconciliation` + `/ai-operations/reconciliation` | TASK-862 | R1 (**removed outright**, owner directive) | — | — | planned |

## API routes

| Item | Ticket | Marked in | Remove in | Replacement | Status |
|---|---|---|---|---|---|
| `admin/ai-providers/**` (llm-only alias) | TASK-862 | R1 | R3 | `admin/providers/:service/:provider` | planned |
| `admin/tts-config/credentials/**`, `admin/stt-config/credentials/**` | TASK-862 | R1 | R3 | `admin/providers/**` + `POST …/test` | planned |
| `POST admin/ai-models/discovery/register` | TASK-860 | R1 | R3 | registry inventory "register from bucket" | planned |
| `pipelineId` on `POST audio/transcription-jobs/stream/session`, `POST …/transcribe`, `POST api/stt/start_session` | TASK-861 | R2 | R4 | `agentSlug` | planned |
| `POST /workflows/:slug/invoke` (alias) | already deprecated in code | — | R3 | `POST /workflows/:slug/runs` | marked |

## Workflow contract

| Item | Ticket | Marked in | Remove in | Replacement | Status |
|---|---|---|---|---|---|
| `stt` palette (8 node types), `WF-STT-*` rules, `stt-pipeline.compiler.ts`, `stt-pipeline-resolver.service.ts`, `stt_placeholder.py` | TASK-861 | R2 | R4 | ASR Agent | planned |
| `summarization`, `consultation`, `agentic` palettes (50 node types) | TASK-864 | R2 | R4 | `core.*` vocabulary (+ `core.action` catalogue, seeded Agents) | planned |
| `EXPOSURE_ALLOWED_PALETTES` | TASK-864 | R2 | R4 | class-based exposure boundary | planned |
| Harness `_llm_policy.get_policy(task_key)` over `AiTaskDefault` | TASK-863 | R1 | R3 | `/internal/agents/resolve` + `AiRoutingPolicy` | planned |
| `HarnessPolicy.textProvider`, `textModel` | TASK-863 | R1 | R3 | Agent binding | planned |

## Admin console routes and features

| Item | Ticket | Marked in | Remove in | Replacement | Status |
|---|---|---|---|---|---|
| `/ai-platform` (hub) + `features/ai-platform` | TASK-862 | R1 (redirect) | R3 | `/ai-providers`, `/ai-models`, `/agents`, `/ai-services/*` | planned |
| `/ai-task-defaults` redirect stub | TASK-862 | — | R1 | — | planned |
| `/ai-runtime-profiles` | TASK-862 | R1 | R1 (no nav entry) | — | planned |
| `/ai-configuration` (Speech & Voice) | TASK-861/862 | R2 (redirect) | R4 | `/agents` | planned |
| `/ai-operations/reconciliation` | TASK-862 | R1 (redirect) | R3 | `/ai-operations/consumption` | planned |
| `/audio/pipelines`, `features/audio-pipelines` | TASK-861 | R2 (redirect) | R4 | `/agents?task=speech-to-text` | planned |
| `/harness/pipeline-policy`, `features/pipeline-policy` | TASK-861 | R2 (redirect) | R4 | workflow assignments | planned |
| `features/tenant-stt-config`, `features/tenant-tts-config` | TASK-861/862 | R1–R2 | R3–R4 | agents | planned |
| `/agents` redirect to `/prompt-templates` | TASK-863 | — | R1 (route becomes the Agents screen) | — | planned |
| `/prompt-studio`, `/pstudio` redirect stubs | pre-existing | — | R1 | — | marked |
| `/ai-model-defaults` redirect stub | pre-existing | — | R1 | — | marked |

## SDK

| Item | Ticket | Marked in | Remove in | Replacement | Status |
|---|---|---|---|---|---|
| `@arcaai/vad`, `@arcaai/noise-filter`, `@arcaai/stt` (browser Whisper), `@arcaai/med-ner`, `@arcaai/vox/plugins/med-ner` | TASK-865 | R2 | R4 | server-side VAD/denoise/ASR/NER via the ASR Agent and realtime lane | planned |
| `useLocalVoiceEmbedding` | TASK-865 (OD-11) | R2 | R4 | `useVoiceEmbedding` | planned |
| `AudioStartOptions.pipelineId`, `usePipelines`, `useArcaPipelines`, `selectedPipelineId` user setting, `useSttProviderToggle`, compat `sttPipelineId` | TASK-865 | R2 | R4 | `AudioStartOptions.agentSlug`, `useSelectableAsrAgents` | planned |
| `TranscriptionPipeline` local stages, `LOCAL_TRANSCRIPTION_ENABLED`, `DEFAULT_LOCAL_CONFIG` model pins | TASK-865 | R2 | R4 | — | planned |
| `hope.admin.audioPipeline.*` (generated) | TASK-861 | R2 | R4 | `hope.admin.agent.*` (generated) | planned |

## Seeds (deleted immediately — no production data)

| Item | Ticket |
|---|---|
| `06-stt.ts` pipelines, `14-pipeline-policy.ts`, `23a-realtime-transcription-agent{,.generated}.ts`, regen script | TASK-861 |
| `16-ai-task-default.ts`, `18-ai-runtime-profile.ts`, `19-tenant-tts-config.ts`, `llm:sarvam` connection row | TASK-862 |
| 10 catalogue rows not in the owner's list; `RETIRED_AI_MODEL_SLUGS` ledger extended | TASK-860 |
| `21`, `23`, `24` workflow seeds rewritten in `core.*` | TASK-864 |
